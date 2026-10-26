<?php
/**
 * Balance playthrough — simulates a REALISTIC casual player for 30 in-game days
 * and asserts the pacing targets from the GDD.
 *
 *   php tests/playthrough.php [baseurl]
 *
 * Player model (≈90 requests/day, far inside the production rate limits):
 *   • 2 h of active play per day, tapping 4/s, buying the best-payback upgrade
 *   • 10 h away → the server settles offline income at 50% efficiency, capped
 *   • claims the daily streak + quests
 *   • prestiges the moment the gate opens
 *   • buys a cosmetic when one is affordable
 *
 * Time travel rewinds `last_settle`/`last_active` in the DB between phases, which
 * is exactly the code path a real returning player hits — so this exercises
 * production logic, not a parallel simulation.
 */
declare(strict_types=1);

$BASE = rtrim($argv[1] ?? 'http://127.0.0.1:8099', '/');
// v2: the DB lives in htdocs/storage/ under a random name — resolve via config.
require_once dirname(__DIR__) . '/htdocs/api/config.php';
$DB   = FI_DB;

/* ------------------------------------------------------------------ */
function ttPdo(): PDO {
    global $DB;
    static $pdo = null;
    if ($pdo === null) { $pdo = new PDO('sqlite:' . $DB); $pdo->exec('PRAGMA busy_timeout = 8000'); }
    return $pdo;
}
function timeTravel(int $uid, int $seconds, bool $active = true): void {
    $t = time() - $seconds;
    $sql = 'UPDATE player_state SET last_settle = ?' . ($active ? ', last_active = ?' : '') . ' WHERE user_id = ?';
    ttPdo()->prepare($sql)->execute($active ? [$t, $t, $uid] : [$t, $uid]);
}
function uidOf(string $token): int {
    return (int)ttPdo()->query('SELECT user_id FROM sessions WHERE id = ' . ttPdo()->quote($token))->fetchColumn();
}

$RATE_HITS = 0;
function rq(string $m, string $p, ?array $b = null, ?string $t = null): array {
    global $BASE, $RATE_HITS;
    for ($attempt = 0; $attempt < 6; $attempt++) {
        $ch = curl_init($BASE . $p);
        $h = ['Accept: application/json'];
        if ($t) $h[] = 'Authorization: Bearer ' . $t;
        if ($b !== null) $h[] = 'Content-Type: application/json';
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $m,
            CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 25,
            CURLOPT_POSTFIELDS => $b === null ? null : json_encode($b)]);
        $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
        $d = json_decode((string)$raw, true);
        if ($code === 429) { $RATE_HITS++; usleep(700000); continue; }   // back off and retry
        return ['code' => $code, 'body' => is_array($d) ? $d : []];
    }
    return ['code' => 429, 'body' => []];
}

/* ------------------------------------------------------------------ */
$PASS = 0; $FAIL = 0;
function t(string $n, bool $ok, string $x = ''): void {
    global $PASS, $FAIL;
    if ($ok) { $PASS++; echo "  \033[32mPASS\033[0m  $n" . ($x ? "  ($x)" : '') . "\n"; }
    else { $FAIL++; echo "  \033[31mFAIL\033[0m  $n" . ($x ? "  ($x)" : '') . "\n"; }
}
function fmtN(float $n): string {
    if ($n < 1000) return number_format($n, 0);
    $s = ['', 'K', 'M', 'B', 'T', 'aa', 'ab', 'ac'];
    $i = (int)floor(log10(max(1.0, $n)) / 3);
    if ($i >= count($s)) return sprintf('%.2e', $n);
    return number_format($n / (10 ** ($i * 3)), 2) . $s[$i];
}

echo "\n=== FORGE INFINITE — 30-day balance playthrough ===\n";

$u = 'pt_' . substr(bin2hex(random_bytes(3)), 0, 6);
$r = rq('POST', '/api/auth.php', ['username' => $u, 'password' => 'testpass123']);
$TOK = $r['body']['token'] ?? '';
if (!$TOK) { echo "registration failed: " . json_encode($r) . "\n"; exit(1); }
$UID = uidOf($TOK);
echo "player: $u (uid $UID)\n\n";

const ACTIVE_H = 2.0;
const AWAY_H   = 10.0;
const TAPS_PS  = 4;          // human-sustainable, far under the anti-cheat ceiling
const BATCH    = 5000;       // server cap per click request

$firstPrestigeDay = null; $firstGen = []; $firstCosmeticDay = null;
$offlineByDay = []; $levelsByDay = []; $gpsByDay = []; $prestigeLog = [];
$questsClaimed = 0; $streakClaims = 0; $cosmeticsBought = 0; $requests = 0; $giftCount = 0; $levelGiftDay = null;
$final = null; $negativeGold = false;

for ($day = 1; $day <= 30; $day++) {

    /* ---------- arrive: server settles the away time ---------- */
    if ($day > 1) timeTravel($UID, (int)(AWAY_H * 3600), false);
    $s = rq('GET', '/api/state.php', null, $TOK)['body']; $requests++;
    $offlineByDay[$day] = (float)($s['idle']['gain'] ?? 0);

    /* ---------- daily streak ---------- */
    $st = rq('POST', '/api/action.php', ['a' => 'claim_streak'], $TOK)['body']; $requests++;
    if (!empty($st['ok'])) $streakClaims++;

    /* ---------- active session, hour by hour ---------- */
    $hours = (int)round(ACTIVE_H);
    for ($h = 0; $h < $hours; $h++) {
        $taps = (int)(3600 * TAPS_PS);
        for ($i = 0; $i < $taps; $i += BATCH) {
            $b = rq('POST', '/api/action.php', ['a' => 'click', 'clicks' => min(BATCH, $taps - $i), 'combo' => 50], $TOK)['body'];
            $requests++;
            if (($b['snapshot']['state']['gold'] ?? 0) < 0) $negativeGold = true;
            $snap = $b['snapshot'] ?? null;
        }
        // advance the clock one hour, then make the purchasing decisions
        timeTravel($UID, 3600);
        $cur = rq('GET', '/api/state.php', null, $TOK)['body']; $requests++;
        if (empty($cur['state'])) continue;

        // buy every upgrade whose payback we can afford, best first
        $guard = 0;
        while ($guard++ < 40) {
            $gold = (float)($cur['state']['gold'] ?? 0);
            $best = null;
            foreach (($cur['gens'] ?? []) as $g) {
                if (!$g['unlocked']) continue;
                $c = (float)$g['cost'];
                if ($c > $gold) continue;
                $gain = (float)$g['prod_next'] - (float)$g['prod_now'];
                if ($gain <= 0) continue;
                $pb = $c / $gain;
                if ($best === null || $pb < $best['pb']) $best = ['id' => $g['id'], 'pb' => $pb];
            }
            if (!$best) break;
            $r2 = rq('POST', '/api/action.php', ['a' => 'buy_gen', 'id' => $best['id'], 'qty' => 1], $TOK)['body']; $requests++;
            if (empty($r2['ok'])) break;
            if (!isset($firstGen[$best['id']])) $firstGen[$best['id']] = $day;
            if (!empty($r2['gifts'])) { $giftCount += count($r2['gifts']); $levelGiftDay ??= $day;
                foreach ($r2['gifts'] as $gg) { if (!empty($gg['item'])) { $firstCosmeticDay ??= $day; $cosmeticsBought++; } } }
            $cur = $r2['snapshot'] ?? $cur;
        }

        // skills
        foreach (($cur['skills'] ?? []) as $k) {
            if (!$k['maxed'] && $k['affordable']) {
                $r3 = rq('POST', '/api/action.php', ['a' => 'buy_skill', 'id' => $k['id']], $TOK)['body']; $requests++;
                if (!empty($r3['snapshot'])) $cur = $r3['snapshot'];
                break;
            }
        }

        // one cosmetic, once
        if ($firstCosmeticDay === null) {
            $g2 = (float)($cur['state']['gold'] ?? 0);
            foreach (($cur['offers'] ?? []) as $o) {
                if ($o['currency'] === 'gold' && $o['slot'] !== 'crate' && $o['price'] <= $g2) {
                    $r4 = rq('POST', '/api/action.php', ['a' => 'buy', 'offer' => $o['id']], $TOK)['body']; $requests++;
                    if (!empty($r4['ok'])) { $firstCosmeticDay = $day; $cosmeticsBought++; if (!empty($r4['snapshot'])) $cur = $r4['snapshot']; }
                    break;
                }
            }
        }

        // quests
        foreach (($cur['quests'] ?? []) as $q) {
            if ($q['done'] && !$q['claimed']) {
                $r5 = rq('POST', '/api/action.php', ['a' => 'claim_quest', 'id' => $q['id']], $TOK)['body']; $requests++;
                if (!empty($r5['ok'])) { $questsClaimed++;
                    if (!empty($r5['gifts'])) { $giftCount += count($r5['gifts']); $levelGiftDay ??= $day;
                        foreach ($r5['gifts'] as $gg) { if (!empty($gg['item'])) { $firstCosmeticDay ??= $day; $cosmeticsBought++; } } }
                    if (!empty($r5['snapshot'])) $cur = $r5['snapshot']; }
            }
        }

        // prestige
        if (!empty($cur['prestige']['ok'])) {
            $r6 = rq('POST', '/api/action.php', ['a' => 'prestige', 'confirm' => 1], $TOK)['body']; $requests++;
            if (!empty($r6['ok'])) {
                if ($firstPrestigeDay === null) $firstPrestigeDay = $day;
                $prestigeLog[] = ['day' => $day, 'sparks' => (int)$r6['sparks'], 'mult' => (float)$r6['mult']];
                if (!empty($r6['snapshot'])) $cur = $r6['snapshot'];
            }
        }
        $final = $cur;
    }

    $levelsByDay[$day] = (int)($final['state']['level'] ?? 0);
    $gpsByDay[$day]    = (float)($final['derived']['gps'] ?? 0);

    if ($day <= 5 || $day % 5 === 0) {
        printf("  day %2d  Lv %-3d  🪙 %-9s  %8s/s  ✦ %-8s gens:%d  offline:%s\n",
            $day, $levelsByDay[$day], fmtN((float)($final['state']['gold'] ?? 0)),
            fmtN($gpsByDay[$day]), fmtN((float)($final['state']['sparks'] ?? 0)),
            count($firstGen), fmtN($offlineByDay[$day]));
    }
}

echo "\n--- pacing results ---\n";
foreach ($firstGen as $id => $d) printf("  %-14s first bought on day %d\n", $id, $d);
printf("  first cosmetic : %s\n", $firstCosmeticDay === null ? 'never' : "day $firstCosmeticDay");
printf("  first prestige : %s\n", $firstPrestigeDay === null ? 'never' : "day $firstPrestigeDay");
printf("  prestiges %d · streak %d · quest claims %d · cosmetics %d · gifts %d · requests %d\n",
    count($prestigeLog), $streakClaims, $questsClaimed, $cosmeticsBought, $giftCount, $requests);
foreach ($prestigeLog as $p) printf("    day %-3d → ✦ %-10s ×%.2f\n", $p['day'], fmtN((float)$p['sparks']), $p['mult']);
printf("  final: Lv %d · %s/s · ✦ %s · lifetime 🪙 %s\n",
    $levelsByDay[30], fmtN($gpsByDay[30]), fmtN((float)($final['state']['sparks'] ?? 0)), fmtN((float)($final['state']['totalGold'] ?? 0)));

echo "\n--- GDD assertions ---\n";
// Informational: the harness fires bursts far faster than a human, so some 429s are expected.
printf("  (harness throttled %d times — a real player sends ~%d requests/day)\n", $RATE_HITS, (int)($requests / 30));
t('request volume is realistic for a human player', $requests / 30 < 300, round($requests / 30) . ' req/day');
t('first upgrade happens on day 1', ($firstGen['apprentice'] ?? 99) === 1, 'day ' . ($firstGen['apprentice'] ?? 'never'));
t('all 10 generators reachable within 30 days', count($firstGen) === 10, count($firstGen) . '/10');
$rg = $firstGen['riftgate'] ?? 99;
// The last tier is the month's horizon; a less-dedicated player reaches it later.
t('final generator unlocked between day 5 and 25', $rg >= 5 && $rg <= 25, "day $rg");
t('first prestige lands between day 2 and 7 (GDD §3.5)',
   $firstPrestigeDay !== null && $firstPrestigeDay >= 2 && $firstPrestigeDay <= 7,
   $firstPrestigeDay === null ? 'never' : "day $firstPrestigeDay");
t('at least 3 prestiges in 30 days (the meta loop must repeat)', count($prestigeLog) >= 3, count($prestigeLog) . ' prestiges');
t('prestige multiplier reaches ≥ ×10 within 30 days', (end($prestigeLog)['mult'] ?? 1) >= 10,
   '×' . number_format(end($prestigeLog)['mult'] ?? 1, 2));
t('a cosmetic is obtained inside the first 2 days (purchase OR level reward)',
   ($firstCosmeticDay !== null && $firstCosmeticDay <= 2) || $levelGiftDay !== null && $levelGiftDay <= 1,
   'purchase day ' . ($firstCosmeticDay === null ? 'never' : $firstCosmeticDay) . ', gift day ' . ($levelGiftDay ?? 'never'));
t('level-milestone gifts actually fire', $giftCount >= 2, $giftCount . ' gifts');
t('level progression reaches ≥ 15 by day 30', $levelsByDay[30] >= 15, 'Lv ' . $levelsByDay[30]);
t('offline earnings pay something every single return', min(array_slice($offlineByDay, 1, null, true)) > 0,
   'min ' . fmtN(min(array_slice($offlineByDay, 1, null, true))));
// The streak is keyed on the real server DAY. A 30-day sim runs in ~3 minutes of
// wall-clock time, so only one claim can legitimately succeed — the e2e suite covers
// the double-claim block. Here we only assert the mechanic responded at all.
// claim_streak is keyed on the REAL server day, and this whole 30-day sim runs in
// about 3 minutes of wall-clock time — so exactly one claim can legitimately succeed.
t('streak claimed exactly once across 30 simulated days that share one real day',
   $streakClaims === 1, $streakClaims . ' streak claims');
t('daily quests were claimable repeatedly', $questsClaimed >= 3, $questsClaimed . ' quest claims');
t('gold never went negative', $negativeGold === false);

echo "\n=== RESULT: $PASS passed, $FAIL failed ===\n";
exit($FAIL === 0 ? 0 : 1);
