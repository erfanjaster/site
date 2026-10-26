<?php
/**
 * FORGE INFINITE — Game logic (SERVER AUTHORITATIVE)
 *
 * Rules enforced here and nowhere else:
 *  • the server clock is the only clock
 *  • currency can never go negative (atomic UPDATE ... WHERE balance >= price)
 *  • every currency delta writes a ledger row
 */
declare(strict_types=1);

final class Game
{
    public const MAX_LEVEL = 200;

    /* ---------------------------------------------------------------- *
     *  Load / save
     * ---------------------------------------------------------------- */
    public static function loadState(int $uid): array
    {
        $st = db()->prepare('SELECT * FROM player_state WHERE user_id = ?');
        $st->execute([$uid]);
        $s = $st->fetch();
        if (!$s) {
            db()->prepare('INSERT INTO player_state(user_id,gems) VALUES(?,?)')
                ->execute([$uid, FI_STARTING_GEMS]);
            return self::loadState($uid);
        }
        return $s;
    }

    public static function genLevels(int $uid): array
    {
        $st = db()->prepare('SELECT gen_id, level FROM player_gens WHERE user_id = ?');
        $st->execute([$uid]);
        $out = [];
        foreach ($st as $r) {
            $out[$r['gen_id']] = (int)$r['level'];
        }
        foreach (Balance::generators() as $g) {
            $out[$g['id']] ??= 0;
        }
        return $out;
    }

    public static function skillLevels(int $uid): array
    {
        $st = db()->prepare('SELECT skill_id, level FROM player_skills WHERE user_id = ?');
        $st->execute([$uid]);
        return Balance::skillLevels($st->fetchAll());
    }

    public static function ownedItems(int $uid): array
    {
        $st = db()->prepare('SELECT item_id, qty, source, acquired_at FROM player_items WHERE user_id = ?');
        $st->execute([$uid]);
        return $st->fetchAll();
    }

    public static function ownedIds(int $uid): array
    {
        $st = db()->prepare('SELECT item_id FROM player_items WHERE user_id = ?');
        $st->execute([$uid]);
        return array_column($st->fetchAll(), 'item_id');
    }

    /* ---------------------------------------------------------------- *
     *  Derived stats
     * ---------------------------------------------------------------- */
    public static function derived(array $state, array $levels, array $sl): array
    {
        $raw  = Balance::gpsRaw($levels);
        $mult = Balance::prestigeMult($state) * Balance::gpsMult($sl);
        $gps  = $raw * $mult;
        return [
            'gps_raw'        => $raw,
            'gps'            => $gps,
            'prestige_mult'  => Balance::prestigeMult($state),
            'skill_mult'     => Balance::gpsMult($sl),
            'click_value'    => Balance::clickValue($state, $sl, $raw),
            'offline_eff'    => Balance::offlineEfficiency($sl),
            'offline_cap'    => Balance::offlineCap($sl),
            'xp_to_next'     => Balance::xpToNext((int)$state['level']),
        ];
    }

    /* ---------------------------------------------------------------- *
     *  Currency — the only sanctioned way to move money
     * ---------------------------------------------------------------- */
    private const CUR_COL = ['gold' => 'gold', 'gems' => 'gems', 'tokens' => 'tokens'];

    public static function balanceOf(PDO $pdo, int $uid, string $cur): float
    {
        $col = self::CUR_COL[$cur] ?? null;
        if (!$col) {
            throw new RuntimeException('bad_currency');
        }
        $st = $pdo->prepare("SELECT $col AS b FROM player_state WHERE user_id = ?");
        $st->execute([$uid]);
        $r = $st->fetch();
        return $r ? (float)$r['b'] : 0.0;
    }

    /**
     * Atomically add (or subtract) currency. Returns the new balance.
     * Subtraction fails (returns null) instead of ever going negative.
     */
    public static function addCurrency(PDO $pdo, int $uid, string $cur, float $delta, string $reason, ?string $ref = null): ?float
    {
        $col = self::CUR_COL[$cur] ?? null;
        if (!$col) {
            throw new RuntimeException('bad_currency');
        }
        $now = time();

        if ($delta < 0) {
            $need = -$delta;
            $st = $pdo->prepare("UPDATE player_state SET $col = $col - :d, updated_at = :n
                                 WHERE user_id = :u AND $col >= :d");
            $st->execute([':d' => $need, ':n' => $now, ':u' => $uid]);
            if ($st->rowCount() === 0) {
                // Either insufficient funds or nothing changed — verify.
                $bal = self::balanceOf($pdo, $uid, $cur);
                if ($bal + 1e-9 < $need) {
                    return null;                     // genuinely insufficient
                }
            }
        } else {
            $pdo->prepare("UPDATE player_state SET $col = $col + ?, updated_at = ? WHERE user_id = ?")
                ->execute([$delta, $now, $uid]);
        }

        $bal = self::balanceOf($pdo, $uid, $cur);
        $pdo->prepare('INSERT INTO ledger(user_id,currency,delta,balance,reason,created_at) VALUES(?,?,?,?,?,?)')
            ->execute([$uid, $cur, $delta, $bal, $reason, $now]);

        if ($cur === 'gold') {
            if ($delta > 0) {
                $pdo->prepare('UPDATE player_state SET run_gold = run_gold + ?, total_gold = total_gold + ? WHERE user_id = ?')
                    ->execute([$delta, $delta, $uid]);
            } else {
                $pdo->prepare('UPDATE player_state SET run_gold = MAX(0, run_gold + ?) WHERE user_id = ?')
                    ->execute([$delta, $uid]);
            }
        }
        return $bal;
    }

    /* ---------------------------------------------------------------- *
     *  Idle settlement — server clock only
     * ---------------------------------------------------------------- */
    public static function settleIdle(PDO $pdo, int $uid): array
    {
        $state  = self::loadState($uid);
        $levels = self::genLevels($uid);
        $sl     = self::skillLevels($uid);
        $d      = self::derived($state, $levels, $sl);
        $now    = time();

        $last   = max(0, (int)$state['last_settle']);
        $active = max(0, (int)($state['last_active'] ?? 0));
        $cap    = (int)$d['offline_cap'];
        $eff    = (float)$d['offline_eff'];

        // Split the window: time while the player was actually interacting (full rate)
        // and time away (offline efficiency, capped). This is what stops the
        // "penalise an always-online player" bug.
        $window    = max(0, min($now - $last, $cap * 4));
        $onlineSec = max(0, min($window, $active > $last ? min($active, $now) - $last : 0));
        $idleSec   = max(0, $window - $onlineSec);

        $paidIdle   = min($idleSec, $cap);
        $capped     = $idleSec > $cap;
        $gain       = $d['gps'] * $onlineSec + $d['gps'] * $paidIdle * $eff;

        $result = [
            'secs'        => $window,
            'online_secs' => $onlineSec,
            'idle_secs'   => $paidIdle,
            'capped'      => $capped,
            'gain'        => $gain,
            'gps'         => $d['gps'],
            'efficiency'  => $eff,
        ];

        if ($gain > 0.5) {
            self::addCurrency($pdo, $uid, 'gold', $gain, $idleSec > 300 ? 'idle_offline' : 'idle_online');
            self::bumpCounter($pdo, $uid, 'gold_earned', (int)floor($gain));
        }
        $pdo->prepare('UPDATE player_state SET last_settle = ?, last_active = ?, updated_at = ? WHERE user_id = ?')
            ->execute([$now, $now, $now, $uid]);

        return $result;
    }

    /* ---------------------------------------------------------------- *
     *  Clicks — batched, rate-limited, server-priced
     * ---------------------------------------------------------------- */
    public static function processClicks(PDO $pdo, int $uid, int $count, int $clientCombo): array
    {
        $count = max(0, min(FI_MAX_CLICK_BATCH, (int)$count));
        $now   = time();

        // Soft anti-cheat: a human sustains ~8 CPS at most. Allow bursts, block farms.
        if (!rate_limit("u:$uid:click_min", FI_RATE_CLICKS_PER_MIN, 60)) {
            return ['clicks' => 0, 'gold' => 0.0, 'crits' => 0, 'throttled' => true];
        }
        if ($count === 0) {
            $pdo->prepare('UPDATE player_state SET last_active = ? WHERE user_id = ?')->execute([$now, $uid]);
            return ['clicks' => 0, 'gold' => 0.0, 'crits' => 0, 'combo' => 0];
        }

        $state  = self::loadState($uid);
        $levels = self::genLevels($uid);
        $sl     = self::skillLevels($uid);
        $d      = self::derived($state, $levels, $sl);
        $base   = (float)$d['click_value'];

        // ---- combo, tracked server-side so the client cannot inflate it ----
        $set     = json_decode((string)($state['settings_json'] ?: '{}'), true) ?: [];
        $lastAt  = (int)($set['comboAt'] ?? 0);
        $window  = (int)(Balance::cfg()['combo']['window_ms'] ?? 2000) / 1000;
        $combo   = ($now - $lastAt <= max(2, $window * 2)) ? (int)($set['combo'] ?? 0) + $count : $count;
        $combo   = max(0, min(5000, $combo));
        $set['combo'] = $combo; $set['comboAt'] = $now;
        $pdo->prepare('UPDATE player_state SET settings_json = ?, last_active = ? WHERE user_id = ?')
            ->execute([json_encode($set, JSON_UNESCAPED_UNICODE), $now, $uid]);

        $cmult = Balance::comboMult(min(50, $combo));

        // ---- crits, resolved in bulk (O(1), still random) ----
        $expected = $count * Balance::critChance();
        $crits    = (int)floor($expected);
        if (random_int(1, 1_000_000) <= (int)(($expected - $crits) * 1_000_000)) {
            $crits++;
        }
        $crits = max(0, min($count, $crits));

        $total = ($count - $crits) * $base * $cmult
               + $crits * $base * $cmult * Balance::critMult();

        $pdo->prepare('UPDATE player_state SET total_clicks = total_clicks + ? WHERE user_id = ?')
            ->execute([$count, $uid]);
        self::addCurrency($pdo, $uid, 'gold', $total, 'click');
        self::bumpCounter($pdo, $uid, 'clicks', $count);

        return [
            'clicks' => $count, 'gold' => $total, 'crits' => $crits, 'combo' => $combo,
            'comboMult' => round($cmult, 3), 'clickValue' => $base * $cmult,
            'totalClicks' => (int)$state['total_clicks'] + $count,
        ];
    }

    /* ---------------------------------------------------------------- *
     *  Quest counters
     * ---------------------------------------------------------------- */
    public static function periodKey(string $kind = 'D'): string
    {
        return $kind === 'W' ? 'W:' . gmdate('o-\WW') : 'D:' . Balance::serverDay();
    }

    public static function bumpCounter(PDO $pdo, int $uid, string $metric, int $by): void
    {
        if ($by === 0) {
            return;
        }
        $pdo->prepare('INSERT INTO player_counters(user_id,period,metric,value) VALUES(?,?,?,?)
                       ON CONFLICT(user_id,period,metric) DO UPDATE SET value = value + excluded.value')
            ->execute([$uid, self::periodKey('D'), $metric, $by]);
    }

    public static function counters(PDO $pdo, int $uid, ?string $period = null): array
    {
        $period = $period ?? self::periodKey('D');
        $st = $pdo->prepare('SELECT metric, value FROM player_counters WHERE user_id = ? AND period = ?');
        $st->execute([$uid, $period]);
        $out = [];
        foreach ($st as $r) {
            $out[$r['metric']] = (int)$r['value'];
        }
        return $out;
    }

    /* ---------------------------------------------------------------- *
     *  Achievements
     * ---------------------------------------------------------------- */
    public static function metricValue(PDO $pdo, int $uid, string $metric, array $state, array $levels): int
    {
        if (str_starts_with($metric, 'gen_')) {
            return (int)($levels[substr($metric, 4)] ?? 0);
        }
        return match ($metric) {
            'clicks'        => (int)$state['total_clicks'],
            'gold_earned'   => (int)$state['total_gold'],
            'prestige_count'=> (int)$state['prestige_count'],
            'level'         => (int)$state['level'],
            'streak_days'   => (int)$state['streak_days'],
            'items_owned'   => count(self::ownedIds($uid)),
            default         => (int)(self::counters($pdo, $uid)[$metric] ?? 0),
        };
    }

    /** Scan and unlock any newly-earned achievements. Returns the newly unlocked list. */
    public static function checkAchievements(PDO $pdo, int $uid): array
    {
        $state  = self::loadState($uid);
        $levels = self::genLevels($uid);
        $st = $pdo->prepare('SELECT ach_id FROM player_achievements WHERE user_id = ?');
        $st->execute([$uid]);
        $have = array_column($st->fetchAll(), 'ach_id');

        $unlocked = [];
        foreach (Balance::achievements() as $a) {
            if (in_array($a['id'], $have, true)) {
                continue;
            }
            $v = self::metricValue($pdo, $uid, $a['metric'], $state, $levels);
            if ($v < (int)$a['target']) {
                continue;
            }
            $pdo->prepare('INSERT OR IGNORE INTO player_achievements(user_id,ach_id) VALUES(?,?)')
                ->execute([$uid, $a['id']]);
            $r = $a['reward'] ?? [];
            if (!empty($r['gold'])) {
                self::addCurrency($pdo, $uid, 'gold', (float)$r['gold'], 'achievement', $a['id']);
            }
            if (!empty($r['gems'])) {
                self::addCurrency($pdo, $uid, 'gems', (float)$r['gems'], 'achievement', $a['id']);
            }
            if (!empty($r['item'])) {
                self::grantItem($pdo, $uid, (string)$r['item'], 'achievement');
            }
            if (!empty($r['xp'])) {
                self::grantXp($pdo, $uid, (float)$r['xp']);
            }
            $unlocked[] = ['id' => $a['id'], 'name' => $a['name'], 'desc' => $a['desc'], 'reward' => $r];
        }
        return $unlocked;
    }

    public static function grantXp(PDO $pdo, int $uid, float $amount): array
    {
        $st = $pdo->prepare('SELECT level, xp FROM player_state WHERE user_id = ?');
        $st->execute([$uid]);
        $s = $st->fetch();
        $from = (int)$s['level'];
        $r = Balance::applyXp($from, (int)$s['xp'], $amount);
        $r['level'] = min(self::MAX_LEVEL, $r['level']);
        $pdo->prepare('UPDATE player_state SET level = ?, xp = ? WHERE user_id = ?')
            ->execute([$r['level'], $r['xp'], $uid]);

        // Level milestones hand out the FIRST cosmetics. This is deliberate:
        // the customization loop must be discovered in the opening session,
        // otherwise the store is never learned and never used (playthrough finding).
        if ($r['level'] > $from) {
            $r['gifts'] = self::grantLevelRewards($pdo, $uid, $from, $r['level']);
        }
        return $r;
    }

    /** Grant every level_reward in (fromLevel, toLevel]. */
    public static function grantLevelRewards(PDO $pdo, int $uid, int $from, int $to): array
    {
        $gifts = [];
        foreach ((Balance::cfg()['level_rewards'] ?? []) as $rw) {
            $lv = (int)($rw['level'] ?? 0);
            if ($lv <= $from || $lv > $to) {
                continue;
            }
            $entry = ['level' => $lv];
            if (!empty($rw['item']) && Balance::item((string)$rw['item'])) {
                self::grantItem($pdo, $uid, (string)$rw['item'], 'level_reward');
                $entry['item'] = (string)$rw['item'];
                $entry['name'] = Balance::item((string)$rw['item'])['name'] ?? $rw['item'];
            }
            if (!empty($rw['gems'])) {
                self::addCurrency($pdo, $uid, 'gems', (float)$rw['gems'], 'level_reward', 'level_' . $lv);
                $entry['gems'] = (int)$rw['gems'];
            }
            if (!empty($rw['gold'])) {
                self::addCurrency($pdo, $uid, 'gold', (float)$rw['gold'], 'level_reward', 'level_' . $lv);
                $entry['gold'] = (float)$rw['gold'];
            }
            $gifts[] = $entry;
            fi_event($uid, 'level_reward', $entry);
        }
        return $gifts;
    }

    public static function grantItem(PDO $pdo, int $uid, string $itemId, string $source): bool
    {
        $pdo->prepare('INSERT INTO player_items(user_id,item_id,qty,source,acquired_at) VALUES(?,?,1,?,?)
                       ON CONFLICT(user_id,item_id) DO UPDATE SET qty = qty + 1')
            ->execute([$uid, $itemId, $source, time()]);
        return true;
    }

    /* ---------------------------------------------------------------- *
     *  Prestige
     * ---------------------------------------------------------------- */
    public static function doPrestige(PDO $pdo, int $uid): array
    {
        $state = self::loadState($uid);
        $check = Balance::canPrestige($state);
        if (!$check['ok']) {
            return ['ok' => false, 'error' => 'not_ready', 'check' => $check];
        }
        $newSparks = $check['potential'];

        $pdo->prepare('UPDATE player_state
                       SET sparks = ?, prestige_count = prestige_count + 1, run_gold = 0,
                           gold = 0, xp = 0, updated_at = ?
                       WHERE user_id = ?')
            ->execute([$newSparks, time(), $uid]);
        $pdo->prepare('DELETE FROM player_gens WHERE user_id = ?')->execute([$uid]);
        $pdo->prepare('DELETE FROM player_skills WHERE user_id = ?')->execute([$uid]);
        $pdo->prepare('INSERT INTO ledger(user_id,currency,delta,balance,reason) VALUES(?,?,?,?,?)')
            ->execute([$uid, 'gold', -(float)$state['gold'], 0.0, 'prestige_burn']);

        fi_event($uid, 'prestige', ['sparks' => $newSparks, 'count' => (int)$state['prestige_count'] + 1]);
        self::checkAchievements($pdo, $uid);

        return ['ok' => true, 'sparks' => $newSparks,
                'gain' => $check['gain'], 'mult' => round($check['new_mult'], 4)];
    }

    /* ---------------------------------------------------------------- *
     *  Streak
     * ---------------------------------------------------------------- */
    public static function claimStreak(PDO $pdo, int $uid): array
    {
        $state = self::loadState($uid);
        $today = Balance::serverDay();
        if (($state['last_claim_day'] ?? null) === $today) {
            return ['ok' => false, 'error' => 'already_claimed', 'streak' => (int)$state['streak_days']];
        }
        $yesterday = gmdate('Y-m-d', strtotime("$today -1 day"));
        $streak = ($state['last_claim_day'] === $yesterday)
            ? (int)$state['streak_days'] + 1
            : 1;

        $reward = Balance::streakReward($streak);
        $pdo->prepare('UPDATE player_state SET streak_days = ?, last_claim_day = ?, updated_at = ? WHERE user_id = ?')
            ->execute([$streak, $today, time(), $uid]);

        if (!empty($reward['gold'])) {
            self::addCurrency($pdo, $uid, 'gold', (float)$reward['gold'], 'streak');
        }
        if (!empty($reward['gems'])) {
            self::addCurrency($pdo, $uid, 'gems', (float)$reward['gems'], 'streak');
        }
        if (!empty($reward['crate'])) {
            $reward['crate_id'] = 'box_rare';
        }
        self::checkAchievements($pdo, $uid);
        return ['ok' => true, 'streak' => $streak, 'reward' => $reward, 'day_in_cycle' => (($streak - 1) % 7) + 1];
    }

    /* ---------------------------------------------------------------- *
     *  Full snapshot for the client
     * ---------------------------------------------------------------- */
    public static function snapshot(int $uid, array $extra = []): array
    {
        $pdo    = db();
        $state  = self::loadState($uid);
        $levels = self::genLevels($uid);
        $sl     = self::skillLevels($uid);
        $d      = self::derived($state, $levels, $sl);
        $en     = Balance::settleEnergy($state, $sl, time());

        // persist energy settlement cheaply
        $pdo->prepare('UPDATE player_state SET energy = ?, energy_at = ? WHERE user_id = ?')
            ->execute([$en['energy'], $en['at'], $uid]);

        $owned = self::ownedItems($uid);
        $ownedIds = array_column($owned, 'item_id');
        $counters = self::counters($pdo, $uid);

        // daily quests
        $period = self::periodKey('D');
        $qst = $pdo->prepare('SELECT quest_id, claimed_at FROM player_quests WHERE user_id = ? AND period = ?');
        $qst->execute([$uid, $period]);
        $claims = [];
        foreach ($qst as $r) {
            $claims[$r['quest_id']] = (int)$r['claimed_at'];
        }
        $quests = [];
        foreach (Balance::quests() as $q) {
            $prog = (int)($counters[$q['metric']] ?? 0);
            // gold_earned uses lifetime total so it is always meaningful
            if ($q['metric'] === 'gold_earned') {
                $prog = (int)$state['total_gold'];
            }
            $done = $prog >= (int)$q['target'];
            $bonus = Balance::questBonus($sl);
            $quests[] = [
                'id' => $q['id'], 'name' => $q['name'], 'metric' => $q['metric'],
                'target' => (int)$q['target'], 'progress' => min($prog, (int)$q['target']),
                'done' => $done, 'claimed' => !empty($claims[$q['id']]),
                'reward' => [
                    'gold' => (int)floor(($q['reward']['gold'] ?? 0) * $bonus),
                    'gems' => (int)($q['reward']['gems'] ?? 0),
                    'xp'   => (int)floor(($q['reward']['xp'] ?? 0) * $bonus),
                ],
            ];
        }

        // achievements
        $ast = $pdo->prepare('SELECT ach_id, unlocked_at FROM player_achievements WHERE user_id = ?');
        $ast->execute([$uid]);
        $haveAch = array_column($ast->fetchAll(), 'ach_id');
        $achs = [];
        foreach (Balance::achievements() as $a) {
            $v = self::metricValue($pdo, $uid, $a['metric'], $state, $levels);
            $achs[] = ['id' => $a['id'], 'name' => $a['name'], 'desc' => $a['desc'],
                       'target' => (int)$a['target'], 'progress' => min($v, (int)$a['target']),
                       'unlocked' => in_array($a['id'], $haveAch, true), 'tier' => (int)$a['tier'],
                       'reward' => $a['reward'] ?? []];
        }

        // skills view
        $skills = [];
        foreach (Balance::skills() as $s) {
            $lvl = (int)($sl[$s['id']] ?? 0);
            $maxed = $lvl >= (int)$s['max'];
            $skills[] = ['id' => $s['id'], 'name' => $s['name'], 'level' => $lvl, 'max' => (int)$s['max'],
                         'effect' => $s['effect'], 'per_level' => (float)$s['per_level'],
                         'cost' => $maxed ? null : round(Balance::skillCost($s, $lvl) * (1 - Balance::costReduction($sl)), 0),
                         'maxed' => $maxed, 'affordable' => !$maxed &&
                            (float)$state['gold'] >= Balance::skillCost($s, $lvl) * (1 - Balance::costReduction($sl))];
        }

        // generators view
        $gens = [];
        foreach (Balance::generators() as $g) {
            $lvl = (int)($levels[$g['id']] ?? 0);
            $unlocked = Balance::genUnlocked($g['id'], $levels);
            $cost = Balance::genCost($g, $lvl, Balance::costReduction($sl));
            $gens[] = [
                'id' => $g['id'], 'name' => $g['name'], 'icon' => $g['icon'] ?? '⚙️',
                'tier' => (int)$g['tier'], 'level' => $lvl, 'unlocked' => $unlocked,
                'need_prev' => (int)($g['need_prev_count'] ?? 0),
                'cost' => round($cost, 0), 'prod_each' => (float)$g['base_prod'],
                'prod_now' => Balance::genProd($g, $lvl) * Balance::prestigeMult($state) * Balance::gpsMult($sl),
                'prod_next' => Balance::genProd($g, $lvl + 1) * Balance::prestigeMult($state) * Balance::gpsMult($sl),
                'affordable' => (float)$state['gold'] >= $cost,
            ];
        }

        // unclaimed level gifts are shown once by the client, then acknowledged
        $ownedIds = array_column($owned, 'item_id');

        $loadout = json_decode((string)($state['loadout_json'] ?: '{}'), true) ?: [];
        $settings = json_decode((string)($state['settings_json'] ?: '{}'), true) ?: [];

        $catalog = [];
        foreach (Balance::catalog() as $it) {
            $catalog[$it['id']] = ['name' => $it['name'], 'slot' => $it['slot'], 'rarity' => $it['rarity'], 'css' => $it['css'] ?? null];
        }

        return array_merge([
            'serverTime'  => time(),
            'serverDay'   => Balance::serverDay(),
            'state' => [
                'gold' => (float)$state['gold'], 'gems' => (int)$state['gems'], 'tokens' => (int)$state['tokens'],
                'energy' => round((float)$en['energy'], 2), 'energyCap' => (float)$en['cap'],
                'level' => (int)$state['level'], 'xp' => (int)$state['xp'], 'xpToNext' => (int)$d['xp_to_next'],
                'sparks' => (int)$state['sparks'], 'prestigeCount' => (int)$state['prestige_count'],
                'runGold' => (float)$state['run_gold'], 'totalGold' => (float)$state['total_gold'],
                'totalClicks' => (int)$state['total_clicks'],
                'streakDays' => (int)$state['streak_days'],
                'streakClaimed' => ($state['last_claim_day'] ?? null) === Balance::serverDay(),
                'lastFreeCrate' => (int)$state['last_free_crate'],
            ],
            'derived' => [
                'gps' => $d['gps'], 'gpsRaw' => $d['gps_raw'],
                'prestigeMult' => round($d['prestige_mult'], 4), 'skillMult' => round($d['skill_mult'], 4),
                'clickValue' => $d['click_value'],
                'offlineEff' => $d['offline_eff'], 'offlineCap' => $d['offline_cap'],
            ],
            'prestige' => Balance::canPrestige($state),
            'gens'      => $gens,
            'skills'    => $skills,
            'quests'    => $quests,
            'achievements' => $achs,
            'owned'     => $owned,
            'loadout'   => $loadout,
            'settings'  => $settings,
            'catalog'   => $catalog,
            'crates'    => array_map(fn($id, $c) => [
                'id' => $id, 'name' => $c['name'], 'price_gems' => $c['price_gems'] ?? null,
                'free_cooldown_hours' => $c['free_cooldown_hours'] ?? 0,
                'odds' => Balance::crateOdds($id),
            ], array_keys(Balance::crates()), array_values(Balance::crates())),
            'slots'     => Balance::slots(),
            'packs'     => Balance::packs(),
            'payProvider' => FI_PAY_PROVIDER,
        ], $extra);
    }
}
