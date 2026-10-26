<?php
/** GET api/leaderboard.php?limit=50 — public, cached 60 s. */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$limit = max(10, min(100, (int)($_GET['limit'] ?? 50)));

$rows = fi_cached('lb_top' . $limit . '_v1', 60, function () use ($limit) {
    $st = db()->prepare('SELECT * FROM v_lb LIMIT ' . $limit);
    $st->execute();
    $out = [];
    $rank = 0;
    foreach ($st as $r) {
        $out[] = [
            'rank' => ++$rank, 'username' => $r['username'], 'level' => (int)$r['level'],
            'sparks' => (int)$r['sparks'], 'prestige' => (int)$r['prestige_count'],
            'totalGold' => (float)$r['total_gold'],
            'loadout' => json_decode((string)($r['loadout_json'] ?: '{}'), true) ?: [],
        ];
    }
    return $out;
});

json_out(['ok' => true, 'leaderboard' => $rows, 'cachedFor' => 60, 'serverTime' => time()]);

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
