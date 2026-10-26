<?php
/**
 * Load test — measures api/state.php under concurrency and converts the result
 * into a shared-hosting capacity estimate with Little's Law.
 *   php tests/load.php [baseurl] [users] [requests_each] [concurrency]
 *
 * NOTE: temporarily raise FI_RATE_REGISTER_PER_HOUR (api/config.php) to create
 * many test accounts from one IP. Production should stay at 8.
 */
declare(strict_types=1);
$BASE = rtrim($argv[1] ?? 'http://127.0.0.1:8099', '/');
$USERS = (int)($argv[2] ?? 40);
$EACH  = (int)($argv[3] ?? 25);
$CONC  = max(1, (int)($argv[4] ?? 20));

function one(string $m, string $p, ?array $b, ?string $t): array {
    global $BASE;
    $ch = curl_init($BASE . $p);
    $h = ['Accept: application/json'];
    if ($t) $h[] = 'Authorization: Bearer ' . $t;
    if ($b !== null) $h[] = 'Content-Type: application/json';
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $m,
        CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 30,
        CURLOPT_POSTFIELDS => $b === null ? null : json_encode($b)]);
    $t0 = microtime(true);
    $raw = curl_exec($ch);
    $ms = (microtime(true) - $t0) * 1000;
    curl_close($ch);
    return ['ms' => $ms, 'body' => json_decode((string)$raw, true) ?: []];
}

echo "\n=== FORGE INFINITE — load test ===\n";

// --- single-request baseline (unloaded latency) ---
$admin = one('POST', '/api/auth.php', ['username' => 'ld0_' . bin2hex(random_bytes(2)), 'password' => 'loadtest1'], null);
$TOK0 = $admin['body']['token'] ?? null;
if (!$TOK0) { echo "could not create the first player (is FI_RATE_REGISTER_PER_HOUR too low?)\n"; exit(1); }
one('POST', '/api/action.php', ['a' => 'click', 'clicks' => 500, 'combo' => 20], $TOK0);
$base = [];
for ($i = 0; $i < 12; $i++) { $r = one('GET', '/api/state.php', null, $TOK0); if (!empty($r['body']['ok'])) $base[] = $r['ms']; }
sort($base);
$baseline = $base ? $base[(int)floor(count($base) * 0.5)] : 0.0;
printf("unloaded p50 latency : %.1f ms\n", $baseline);

// --- build the cohort ---
// Preferred path: use the pre-seeded load-test accounts (created by
// `php api/db_install.php --seed-loadtest`) so we never touch the public
// registration endpoint, whose anti-farm cap is deliberately 8/IP/hour.
$tokens = [$TOK0];
for ($i = 0; $i < $USERS - 1 && count($tokens) < $USERS; $i++) {
    $tokens[] = str_pad('10ade' . $i, 64, '0');   // matches api/db_install.php --seed-loadtest
}
// verify they are real sessions; fall back to registering if the seed is missing
$valid = [];
foreach ($tokens as $tk) {
    $probe = one('GET', '/api/state.php', null, $tk);
    if (!empty($probe['body']['ok'])) { $valid[] = $tk; }
}
if (count($valid) < $USERS * 0.8) {
    printf("seeded cohort missing — registering %d players over HTTP instead\n", $USERS - count($valid));
    for ($i = count($valid); $i < $USERS; $i++) {
        $r = one('POST', '/api/auth.php', ['username' => 'ld' . $i . '_' . bin2hex(random_bytes(2)), 'password' => 'loadtest1'], null);
        if (!empty($r['body']['token'])) { $valid[] = $r['body']['token']; }
    }
}
$tokens = $valid;
printf("%d players ready\n", count($tokens));
foreach ($tokens as $tk) { one('POST', '/api/action.php', ['a' => 'click', 'clicks' => 300, 'combo' => 20], $tk); }

// --- concurrent phase ---
$queue = [];
foreach ($tokens as $tk) { for ($i = 0; $i < $EACH; $i++) { $queue[] = $tk; } }
shuffle($queue);
$total = count($queue);
printf("firing %d requests at concurrency %d…\n", $total, $CONC);

$lat = []; $ok = 0; $throttled = 0; $errs = 0;
$wall0 = microtime(true);
foreach (array_chunk($queue, $CONC) as $chunk) {
    $mh = curl_multi_init();
    $meta = [];                                   // integer index → [handle, t0]
    foreach (array_values($chunk) as $i => $tk) {
        $ch = curl_init($BASE . '/api/state.php');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . $tk]]);
        curl_multi_add_handle($mh, $ch);
        $meta[$i] = [$ch, microtime(true)];
    }
    do { $st = curl_multi_exec($mh, $run); if ($run) curl_multi_select($mh, 0.05); } while ($run && $st === CURLM_OK);
    foreach ($meta as $i => [$ch, $t0]) {
        $body = curl_multi_getcontent($ch);
        $d = json_decode((string)$body, true);
        $ms = (microtime(true) - $t0) * 1000;
        if (is_array($d) && !empty($d['ok'])) { $ok++; $lat[] = $ms; }
        elseif (is_array($d) && in_array($d['error'] ?? '', ['rate', 'rate limited', 'rate_limited'], true)) { $throttled++; }
        else { $errs++; }
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
}
$wall = microtime(true) - $wall0;

sort($lat);
$n = count($lat);
$pct = fn(float $p) => $n ? $lat[min($n - 1, (int)floor($n * $p))] : 0.0;
$avg = $n ? array_sum($lat) / $n : 0.0;

printf("\n--- results ---\n");
printf("ok %d · throttled %d · errors %d\n", $ok, $throttled, $errs);
printf("throughput  : %.1f req/s over %.2f s\n", $total / max(0.001, $wall), $wall);
printf("latency avg : %.1f ms\n", $avg);
printf("latency p50 : %.1f ms\n", $pct(0.5));
printf("latency p95 : %.1f ms\n", $pct(0.95));
printf("latency p99 : %.1f ms\n", $pct(0.99));

// --- Little's Law → shared-hosting capacity ---
$rt = max(0.010, $avg / 1000);
printf("\n--- capacity estimate (Little's Law, %.0f ms average response) ---\n", $avg);
printf("%-8s %-8s %-11s %-11s %s\n", 'CCU', 'poll', 'req/s', 'procs', 'verdict vs EP=20');
foreach ([10, 30, 60] as $poll) {
    foreach ([100, 500, 1000, 2000, 5000] as $ccu) {
        $rps = $ccu * 0.35 / $poll;          // ~35% of CCU polls actively
        $need = $rps * $rt;
        $v = $need <= 14 ? '✅ comfortable' : ($need <= 20 ? '⚠ at the limit' : '❌ migrate to VPS');
        printf("%-8s %-8s %-11s %-11s %s\n", $ccu, $poll . 's', number_format($rps, 1), number_format($need, 2), $v);
    }
}
printf("\nerrors: %d %s\n", $errs, $errs === 0 ? '(clean)' : '← investigate before launch');
exit($errs === 0 ? 0 : 1);
