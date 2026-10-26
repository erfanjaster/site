<?php
/**
 * GET/POST api/state.php — THE aggregated endpoint.
 * One request returns everything the client needs (see GDD §9.1).
 * Optional body: {clicks:int, combo:int} to settle a click batch in the same round-trip.
 */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$me = require_auth();
$uid = $me['user_id'];

if (!rate_limit("u:$uid:state", FI_RATE_STATE_PER_MIN, 60)) {
    api_fail('rate limited', 429);
}

$pdo = db();

// 1) settle idle income first, so the snapshot always shows fresh numbers
$idle = Game::settleIdle($pdo, $uid);

// 2) settle a batched click payload in the same round-trip (saves a request)
$clicks = null;
$n = req_int('clicks', 0);
if ($n > 0) {
    $clicks = Game::processClicks($pdo, $uid, $n, req_int('combo', 0));
    // clicks may have produced level-ups via quests; re-settle is unnecessary
    $idle = Game::settleIdle($pdo, $uid);
} else {
    // keep the "active" marker fresh so online time is not paid at the offline rate
    $pdo->prepare('UPDATE player_state SET last_active = ? WHERE user_id = ?')->execute([time(), $uid]);
}

// 3) achievements scan (cheap: indexed reads only)
$newAch = Game::checkAchievements($pdo, $uid);

// 4) shop offers — cached for 30 s across all players
$offers = fi_cached('offers_v1', 30, fn() => Shop::offers());

// 5) leaderboard — cached for 60 s
$lb = fi_cached('lb_top50_v1', 60, function () {
    $st = db()->prepare('SELECT * FROM v_lb LIMIT 50');
    $st->execute();
    $out = [];
    $rank = 0;
    foreach ($st as $r) {
        $out[] = ['rank' => ++$rank, 'username' => $r['username'], 'level' => (int)$r['level'],
                  'sparks' => (int)$r['sparks'], 'prestige' => (int)$r['prestige_count'],
                  'totalGold' => (float)$r['total_gold'],
                  'loadout' => json_decode((string)($r['loadout_json'] ?: '{}'), true) ?: []];
    }
    return $out;
});

$online = fi_cached('online_count', 30, function () {
    return (int)db()->query("SELECT COUNT(*) FROM users WHERE last_seen_at > strftime('%s','now') - 300")->fetchColumn();
});

$myRank = fi_cached('lb_rank_' . $uid, 60, function () use ($uid) {
    $st = db()->prepare('SELECT COUNT(*) + 1 FROM player_state WHERE total_gold > (SELECT total_gold FROM player_state WHERE user_id = ?)');
    $st->execute([$uid]);
    return (int)$st->fetchColumn();
});

$snap = Game::snapshot($uid, [
    'idle'       => $idle,
    'clicks'     => $clicks,
    'newAchievements' => $newAch,
    'offers'     => $offers,
    'leaderboard'=> $lb,
    'myRank'     => $myRank,
    'online'     => $online,
    'poll'       => $online > 300 ? 30 : ($online > 120 ? 20 : 10),
]);

json_out(array_merge(['ok' => true], $snap));

/* ------------------------------------------------------------------ */
function fi_cached(string $key, int $ttl, callable $build): mixed
{
    $pdo = db();
    $now = time();
    $st = $pdo->prepare('SELECT v, until_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch();
    if ($row && (int)$row['until_at'] > $now) {
        $d = json_decode((string)$row['v'], true);
        if ($d !== null) {
            return $d;
        }
    }
    $val = $build();
    $pdo->prepare('INSERT INTO cache(k,v,until_at) VALUES(?,?,?)
                   ON CONFLICT(k) DO UPDATE SET v = excluded.v, until_at = excluded.until_at')
        ->execute([$key, json_encode($val, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $now + $ttl]);
    return $val;
}
