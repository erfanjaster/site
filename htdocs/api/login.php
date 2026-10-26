<?php
/** POST {username,password} → bearer token. */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$u = trim(req_str('username'));
$p = (string)(req_body()['password'] ?? '');

if (!rate_limit('ip:' . client_ip() . ':login', FI_RATE_AUTH_PER_HOUR, 3600)) {
    api_fail('too many attempts, try again in an hour', 429);
}

$st = db()->prepare('SELECT id, pass_hash, is_banned FROM users WHERE username = ?');
$st->execute([$u]);
$row = $st->fetch();

if (!$row || !password_verify($p, (string)$row['pass_hash'])) {
    fi_event(null, 'login_fail', ['username' => $u, 'ip' => client_ip()]);
    api_fail('invalid username or password', 401);
}
if ((int)$row['is_banned'] === 1) {
    api_fail('this account is suspended', 403);
}

$uid = (int)$row['id'];
if (password_needs_rehash((string)$row['pass_hash'], PASSWORD_DEFAULT)) {
    db()->prepare('UPDATE users SET pass_hash = ? WHERE id = ?')
        ->execute([password_hash($p, PASSWORD_DEFAULT), $uid]);
}

$tok = new_session_token($uid);
db()->prepare('UPDATE users SET last_seen_at = ?, last_ip = ? WHERE id = ?')
    ->execute([time(), client_ip(), $uid]);
Game::bumpCounter(db(), $uid, 'sessions', 1);
fi_event($uid, 'login');

json_out(['ok' => true, 'token' => $tok, 'user' => ['id' => $uid, 'username' => $u],
          'snapshot' => Game::snapshot($uid)]);
