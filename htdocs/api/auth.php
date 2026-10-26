<?php
/** POST {username,password} → create a player and return a bearer token. */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$u = trim(req_str('username'));
$p = (string)(req_body()['password'] ?? '');

if (!valid_username($u)) {
    api_fail('username must be 3-20 chars: letters, numbers, underscore');
}
if (!valid_password($p)) {
    api_fail('password must be at least 6 characters');
}
if (!rate_limit('ip:' . client_ip() . ':register', FI_RATE_REGISTER_PER_HOUR, 3600)) {
    api_fail('too many attempts, try later', 429);
}

$pdo = db();
$st = $pdo->prepare('SELECT id FROM users WHERE username = ?');
$st->execute([$u]);
if ($st->fetchColumn()) {
    api_fail('username already taken', 409);
}

$hash = password_hash($p, PASSWORD_DEFAULT);
$pdo->prepare('INSERT INTO users(username,pass_hash,last_ip) VALUES(?,?,?)')
    ->execute([$u, $hash, client_ip()]);
$uid = (int)$pdo->lastInsertId();

Game::loadState($uid);                       // creates player_state with the welcome gems
$pdo->prepare('UPDATE player_state SET gems = gems + ? WHERE user_id = ? AND gems = ?')
    ->execute([0, $uid, FI_STARTING_GEMS]);  // starting gems already set on insert

$tok = new_session_token($uid);
fi_event($uid, 'register', ['ip' => client_ip()]);
Game::bumpCounter($pdo, $uid, 'sessions', 1);

json_out(['ok' => true, 'token' => $tok, 'user' => ['id' => $uid, 'username' => $u],
          'snapshot' => Game::snapshot($uid, ['welcome' => true])]);
