<?php
/**
 * FORGE INFINITE — Balance engine (SERVER AUTHORITATIVE)
 *
 * Every formula in the GDD lives here. The client mirrors these formulas in
 * js/balance.js for instant rendering, but the server is always the truth.
 * All numbers come from public/config/balance.json — change balance without redeploying code.
 */
declare(strict_types=1);

final class Balance
{
    private static ?array $cfg = null;
    private static array $genById = [];
    private static array $itemById = [];
    private static array $skillById = [];
    private static array $questById = [];
    private static array $achById = [];

    public static function cfg(): array
    {
        if (self::$cfg === null) {
            $raw = file_get_contents(FI_BALANCE_JSON);
            if ($raw === false) {
                throw new RuntimeException('balance.json not readable');
            }
            $c = json_decode($raw, true);
            if (!is_array($c)) {
                throw new RuntimeException('balance.json is not valid JSON');
            }
            self::$cfg = $c;
            foreach ($c['generators'] ?? [] as $g) {
                self::$genById[$g['id']] = $g;
            }
            foreach ($c['catalog'] ?? [] as $i) {
                self::$itemById[$i['id']] = $i;
            }
            foreach ($c['skills'] ?? [] as $s) {
                self::$skillById[$s['id']] = $s;
            }
            foreach ($c['quests_daily'] ?? [] as $q) {
                self::$questById[$q['id']] = $q;
            }
            foreach ($c['achievements'] ?? [] as $a) {
                self::$achById[$a['id']] = $a;
            }
        }
        return self::$cfg;
    }

    public static function generators(): array { return self::cfg()['generators'] ?? []; }
    public static function gen(string $id): ?array { self::cfg(); return self::$genById[$id] ?? null; }
    public static function item(string $id): ?array { self::cfg(); return self::$itemById[$id] ?? null; }
    public static function catalog(): array { self::cfg(); return self::$itemById; }
    public static function skill(string $id): ?array { self::cfg(); return self::$skillById[$id] ?? null; }
    public static function skills(): array { return self::cfg()['skills'] ?? []; }
    public static function quests(): array { return self::cfg()['quests_daily'] ?? []; }
    public static function quest(string $id): ?array { self::cfg(); return self::$questById[$id] ?? null; }
    public static function achievements(): array { return self::cfg()['achievements'] ?? []; }
    public static function achievement(string $id): ?array { self::cfg(); return self::$achById[$id] ?? null; }
    public static function crates(): array { return self::cfg()['crates'] ?? []; }
    public static function crate(string $id): ?array { return (self::cfg()['crates'] ?? [])[$id] ?? null; }
    public static function slots(): array { return self::cfg()['slots'] ?? []; }
    public static function levelRewards(): array { return self::cfg()['level_rewards'] ?? []; }
    public static function packs(): array { return self::cfg()['gem_packs'] ?? []; }

    /* -------------------------------------------------------------- *
     *  Generators
     *  cost(n) = base_cost * cost_growth^n          (n = level you already own)
     *  prod(n) = base_prod * n                      (LINEAR — see GDD §3.1)
     * -------------------------------------------------------------- */
    public static function genCost(array $g, int $level, float $costReduction = 0.0): float
    {
        $cost = (float)$g['base_cost'] * ((float)$g['cost_growth'] ** $level);
        return max(1.0, $cost * (1.0 - min(0.25, max(0.0, $costReduction))));
    }

    public static function genProd(array $g, int $level): float
    {
        return $level > 0 ? (float)$g['base_prod'] * $level : 0.0;
    }

    /** A generator is unlocked when the previous one reaches need_prev_count. */
    public static function genUnlocked(string $genId, array $levels): bool
    {
        $gens = self::generators();
        foreach ($gens as $idx => $g) {
            if ($g['id'] !== $genId) {
                continue;
            }
            if ($idx === 0) {
                return true;
            }
            $prev = $gens[$idx - 1];
            return (int)($levels[$prev['id']] ?? 0) >= (int)$g['need_prev_count'];
        }
        return false;
    }

    public static function gpsRaw(array $levels): float
    {
        $sum = 0.0;
        foreach (self::generators() as $g) {
            $sum += self::genProd($g, (int)($levels[$g['id']] ?? 0));
        }
        return $sum;
    }

    /* -------------------------------------------------------------- *
     *  Skills
     *  cost(L) = base_cost * growth^L
     * -------------------------------------------------------------- */
    public static function skillCost(array $s, int $level): float
    {
        return (float)$s['base_cost'] * ((float)$s['growth'] ** $level);
    }

    /** @return array<string,int> skill_id => level */
    public static function skillLevels(array $rows): array
    {
        $out = [];
        foreach ($rows as $r) {
            $out[$r['skill_id']] = (int)$r['level'];
        }
        return $out;
    }

    public static function skillLevel(array $sl, string $id): int
    {
        return max(0, (int)($sl[$id] ?? 0));
    }

    public static function gpsMult(array $sl): float
    {
        $s = self::skill('efficient_forge');
        return 1.0 + ($s ? (float)$s['per_level'] * self::skillLevel($sl, 'efficient_forge') : 0.0);
    }

    public static function clickMult(array $sl): float
    {
        $s = self::skill('sharp_hands');
        return 1.0 + ($s ? (float)$s['per_level'] * self::skillLevel($sl, 'sharp_hands') : 0.0);
    }

    public static function costReduction(array $sl): float
    {
        $s = self::skill('bargainer');
        return $s ? min(0.25, (float)$s['per_level'] * self::skillLevel($sl, 'bargainer')) : 0.0;
    }

    public static function questBonus(array $sl): float
    {
        $s = self::skill('focus');
        return 1.0 + ($s ? (float)$s['per_level'] * self::skillLevel($sl, 'focus') : 0.0);
    }

    public static function dropBonus(array $sl): float
    {
        $s = self::skill('lucky_star');
        return $s ? (float)$s['per_level'] * self::skillLevel($sl, 'lucky_star') : 0.0;
    }

    /* -------------------------------------------------------------- *
     *  Prestige
     * -------------------------------------------------------------- */
    public static function prestigeMult(array $state): float
    {
        $b = self::cfg()['prestige']['gps_bonus_per_spark'] ?? 0.02;
        return 1.0 + $b * (float)($state['sparks'] ?? 0);
    }

    /** Power curve, NOT sqrt: a sqrt curve plateaus inside two weeks and kills the
     *  meta loop (see balance.json → balance_warnings). All coefficients are data. */
    public static function sparksFor(float $runGold): int
    {
        $p     = self::cfg()['prestige'] ?? [];
        $coef  = (float)($p['coef'] ?? 3.0);
        $div   = (float)($p['divisor'] ?? 1e6);
        $expo  = (float)($p['exponent'] ?? 0.4);
        if ($runGold <= 0 || $div <= 0) {
            return 0;
        }
        return (int)floor($coef * (($runGold / $div) ** $expo));
    }

    public static function canPrestige(array $state): array
    {
        $c    = self::cfg()['prestige'] ?? [];
        $gate = (float)($c['gate_multiplier'] ?? 1.75);
        $min  = (int)($c['min_sparks_to_prestige'] ?? 5);
        $pot  = self::sparksFor((float)$state['run_gold']);
        $cur  = (int)$state['sparks'];
        $need = max($min, (int)ceil($cur * $gate));
        return [
            'potential'  => $pot,
            'current'    => $cur,
            'gain'       => max(0, $pot - $cur),
            'required'   => $need,
            'ok'         => $pot >= $need && $pot > $cur,
            'new_mult'   => 1.0 + (float)($c['gps_bonus_per_spark'] ?? 0.02) * $pot,
            'need_gold'  => self::goldForSparks($need),
            'gate'       => $gate,
        ];
    }

    /** Inverse of sparksFor — used for "you need X more gold" hints. */
    public static function goldForSparks(int $sparks): float
    {
        if ($sparks <= 0) {
            return 0.0;
        }
        $p    = self::cfg()['prestige'] ?? [];
        $coef = (float)($p['coef'] ?? 3.0);
        $div  = (float)($p['divisor'] ?? 1e6);
        $expo = (float)($p['exponent'] ?? 0.4);
        return ($sparks / $coef) ** (1.0 / $expo) * $div;
    }

    /* -------------------------------------------------------------- *
     *  Offline / idle
     * -------------------------------------------------------------- */
    public static function offlineEfficiency(array $sl): float
    {
        $c = self::cfg()['idle'];
        return min(1.0, (float)$c['offline_efficiency_base']
            + (float)$c['offline_efficiency_per_skill'] * self::skillLevel($sl, 'night_shift'));
    }

    public static function offlineCap(array $sl): int
    {
        $c = self::cfg()['idle'];
        return min((int)$c['offline_cap_secs_max'],
            (int)$c['offline_cap_secs_base'] + (int)$c['offline_cap_per_skill_secs'] * self::skillLevel($sl, 'night_shift'));
    }

    /* -------------------------------------------------------------- *
     *  Clicks
     * -------------------------------------------------------------- */
    public static function clickValue(array $state, array $sl, float $gpsRaw): float
    {
        $base = 1.0 + (float)($state['prestige_count'] ?? 0);
        return ($base + 0.05 * $gpsRaw) * self::clickMult($sl);
    }

    /** Combo bonus: +2% per consecutive click, capped at +100%. */
    public static function comboMult(int $combo): float
    {
        $c = self::cfg()['combo'];
        return 1.0 + min((float)$c['max_bonus'], (float)$c['per_click_bonus'] * max(0, $combo));
    }

    public static function critChance(): float  { return (float)(self::cfg()['combo']['crit_chance'] ?? 0.05); }
    public static function critMult(): float    { return (float)(self::cfg()['combo']['crit_multiplier'] ?? 10); }

    /* -------------------------------------------------------------- *
     *  Levels & XP
     * -------------------------------------------------------------- */
    public static function xpToNext(int $level): int
    {
        return (int)floor(100 * (1.35 ** max(0, $level - 1)));
    }

    /** Apply XP, return ['level'=>, 'xp'=>, 'levelled'=>bool] */
    public static function applyXp(int $level, int $xp, float $amount): array
    {
        $xp += (int)floor($amount);
        $levelled = false;
        $guard = 0;
        while ($xp >= self::xpToNext($level) && $guard++ < 500) {
            $xp -= self::xpToNext($level);
            $level++;
            $levelled = true;
        }
        return ['level' => $level, 'xp' => $xp, 'levelled' => $levelled];
    }

    /* -------------------------------------------------------------- *
     *  Energy
     * -------------------------------------------------------------- */
    public static function energyCap(array $sl): float
    {
        $c = self::cfg()['energy'];
        return (float)$c['cap_base'] + (float)$c['regen_secs_per_point'] / 600.0 * self::skillLevel($sl, 'stamina');
    }

    public static function settleEnergy(array $state, array $sl, int $now): array
    {
        $cap  = self::cfg()['energy']['cap_base'] + self::skillLevel($sl, 'stamina');
        $rate = (float)self::cfg()['energy']['regen_secs_per_point'];
        $at   = (int)($state['energy_at'] ?? $now);
        $gain = $rate > 0 ? (max(0, $now - $at) / $rate) : 0.0;
        return ['energy' => min((float)$cap, (float)$state['energy'] + $gain), 'at' => $now, 'cap' => (float)$cap];
    }

    /* -------------------------------------------------------------- *
     *  Loot
     * -------------------------------------------------------------- */
    /** Roll a crate. Returns ['item_id'=>string|null,'roll'=>int,'total'=>int]. */
    public static function rollCrate(string $crateId, array $ownedIds, float $dropBonus = 0.0): array
    {
        $crate = self::crate($crateId);
        if (!$crate) {
            throw new RuntimeException('unknown_crate');
        }
        $entries = $crate['entries'] ?? [];
        $total = 0;
        foreach ($entries as $e) {
            $total += max(0, (int)$e[1]);
        }
        if ($total <= 0) {
            throw new RuntimeException('empty_loot_table');
        }
        $roll = random_int(1, $total);
        $acc = 0;
        foreach ($entries as $e) {
            $acc += max(0, (int)$e[1]);
            if ($roll <= $acc) {
                return ['item_id' => (string)$e[0], 'roll' => $roll, 'total' => $total,
                        'dupe' => in_array((string)$e[0], $ownedIds, true)];
            }
        }
        return ['item_id' => null, 'roll' => $roll, 'total' => $total, 'dupe' => false];
    }

    /** Public odds list for the UI (research: odds must always be displayed). */
    public static function crateOdds(string $crateId): array
    {
        $crate = self::crate($crateId);
        if (!$crate) {
            return [];
        }
        $total = 0;
        foreach ($crate['entries'] as $e) {
            $total += max(0, (int)$e[1]);
        }
        $out = [];
        foreach ($crate['entries'] as $e) {
            $item = self::item((string)$e[0]);
            $out[] = [
                'item_id' => (string)$e[0],
                'name'    => $item['name'] ?? $e[0],
                'rarity'  => $item['rarity'] ?? 'common',
                'chance'  => $total > 0 ? round(max(0, (int)$e[1]) / $total * 100, 3) : 0.0,
            ];
        }
        usort($out, fn($a, $b) => $b['chance'] <=> $a['chance']);
        return $out;
    }

    /* -------------------------------------------------------------- *
     *  Streak
     * -------------------------------------------------------------- */
    public static function streakReward(int $dayInCycle): array
    {
        $w = self::cfg()['streak']['week1'] ?? [];
        $idx = (($dayInCycle - 1) % 7 + 7) % 7;
        return $w[$idx] ?? ['gold' => 100000];
    }

    public static function serverDay(): string
    {
        return gmdate('Y-m-d');
    }
}
