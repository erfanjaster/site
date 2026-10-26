<?php
/**
 * GET api/profile.php?u=<username> — the public showcase page data.
 * This is the monetization surface: it renders every equipped cosmetic (GDD §5.4).
 */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$name = trim((string)($_GET['u'] ?? ''));
if ($name === '' || strlen($name) > 24) {
    api_fail('missing user');
}

$st = db()->prepare('SELECT u.id, u.username, u.created_at, s.*
                     FROM users u JOIN player_state s ON s.user_id = u.id
                     WHERE u.username = ? AND u.is_banned = 0');
$st->execute([$name]);
$row = $st->fetch();
if (!$row) {
    api_fail('not found', 404);
}
$uid = (int)$row['id'];

$levels = Game::genLevels($uid);
$sl     = Game::skillLevels($uid);
$state  = ['sparks' => (int)$row['sparks'], 'prestige_count' => (int)$row['prestige_count'], 'level' => (int)$row['level']];
$d      = Game::derived($state, $levels, $sl);

$ownedIds = Game::ownedIds($uid);
$loadout  = json_decode((string)($row['loadout_json'] ?: '{}'), true) ?: [];
$settings = json_decode((string)($row['settings_json'] ?: '{}'), true) ?: [];

$catalog = [];
foreach (Balance::catalog() as $id => $it) {
    $catalog[$id] = ['name' => $it['name'], 'slot' => $it['slot'], 'rarity' => $it['rarity'], 'css' => $it['css'] ?? null];
}

// rank
$rk = db()->prepare('SELECT COUNT(*) + 1 FROM player_state WHERE total_gold > ?');
$rk->execute([(float)$row['total_gold']]);

// achievements count
$ac = db()->prepare('SELECT COUNT(*) FROM player_achievements WHERE user_id = ?');
$ac->execute([$uid]);

json_out([
    'ok' => true,
    'profile' => [
        'username'    => $row['username'],
        'joinedDays'  => max(1, (int)floor((time() - (int)$row['created_at']) / 86400)),
        'level'       => (int)$row['level'],
        'sparks'      => (int)$row['sparks'],
        'prestige'    => (int)$row['prestige_count'],
        'gps'         => $d['gps'],
        'totalGold'   => (float)$row['total_gold'],
        'totalClicks' => (int)$row['total_clicks'],
        'streak'      => (int)$row['streak_days'],
        'rank'        => (int)$rk->fetchColumn(),
        'achievements'=> (int)$ac->fetchColumn(),
        'collection'  => ['owned' => count($ownedIds), 'total' => count(Balance::catalog())],
        'loadout'     => $loadout,
        'signature'   => (string)($settings['signature'] ?? ''),
        'ownedIds'    => $ownedIds,
        'catalog'     => $catalog,
    ],
]);
