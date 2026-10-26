<?php
/**
 * FORGE INFINITE — admin API  (POST /api/admin.php {a: '...'})
 *
 * Powers the /admin/ panel: economy charts from `ledger`, retention from
 * `events` (session_start), player management, audit trail, backups and a
 * system/security self-check. Access: role 'admin' (mutations) or 'mod'
 * (read-only). Every mutation is written to `admin_audit`.
 */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$me  = require_auth();
$uid = $me['user_id'];
$role = $me['role'];
if (!in_array($role, ['admin', 'mod'], true)) {
    api_fail('forbidden', 403);
}
if (!rate_limit("u:$uid:admin", FI_RATE_ADMIN_PER_MIN, 60)) {
    api_fail('rate limited', 429);
}

$pdo = db();
$a = req_str('a', 'overview');
$readOnly = ['me', 'overview', 'economy', 'retention', 'players', 'player', 'events_explore', 'ledger_explore', 'system'];
if ($role !== 'admin' && !in_array($a, $readOnly, true)) {
    api_fail('forbidden: moderators are read-only', 403);
}

/* ---------------- helpers ---------------- */
$day = static fn(int $ts): string => gmdate('Y-m-d', $ts);
$clampDays = static fn(): int => max(7, min(90, req_int('days', 30)));
$page = max(1, req_int('page', 1));
$perPage = 25;

$scalar = function (string $sql, array $p = []) use ($pdo) {
    $st = $pdo->prepare($sql);
    $st->execute($p);
    return $st->fetchColumn();
};
$rows = function (string $sql, array $p = []) use ($pdo) {
    $st = $pdo->prepare($sql);
    $st->execute($p);
    return $st->fetchAll();
};
/** Distinct active users (session_start) inside a window; falls back to last_seen while telemetry is young. */
$activeUsers = function (int $since) use ($scalar): int {
    $n = (int)$scalar("SELECT COUNT(DISTINCT user_id) FROM events WHERE name='session_start' AND user_id IS NOT NULL AND created_at >= ?", [$since]);
    if ($n === 0) {
        $n = (int)$scalar('SELECT COUNT(*) FROM users WHERE last_seen_at >= ?', [$since]);
    }
    return $n;
};

try {
    switch ($a) {

    /* ------------------------------------------------ identity */
    case 'me':
        json_out(['ok' => true, 'me' => ['id' => $uid, 'username' => $me['username'], 'role' => $role],
                  'version' => FI_VERSION]);

    /* ------------------------------------------------ overview KPIs */
    case 'overview':
        $now = time();
        $d1 = $now - 86400; $d7 = $now - 7 * 86400; $d30 = $now - 30 * 86400;

        $econ = function (string $cur, int $since) use ($scalar): array {
            $created = (float)$scalar('SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency=? AND delta>0 AND created_at>=?', [$cur, $since]);
            $burned  = (float)$scalar('SELECT COALESCE(-SUM(delta),0) FROM ledger WHERE currency=? AND delta<0 AND created_at>=?', [$cur, $since]);
            return ['created' => $created, 'burned' => $burned, 'net' => $created - $burned,
                    'ratio' => $burned > 0 ? round($created / $burned, 3) : null];
        };
        $topReasons = function (string $sign, int $since) use ($rows): array {
            $op = $sign === '+' ? '>' : '<';
            $agg = $sign === '+' ? 'SUM(delta)' : '-SUM(delta)';
            return $rows("SELECT reason, currency, $agg AS total, COUNT(*) AS n FROM ledger
                          WHERE delta $op 0 AND created_at>=? GROUP BY reason, currency
                          ORDER BY ABS(total) DESC LIMIT 6", [$since]);
        };

        $dau = $activeUsers($d1); $wau = $activeUsers($d7); $mau = $activeUsers($d30);
        json_out(['ok' => true, 'overview' => [
            'users_total'    => (int)$scalar('SELECT COUNT(*) FROM users'),
            'users_new_24h'  => (int)$scalar('SELECT COUNT(*) FROM users WHERE created_at>=?', [$d1]),
            'users_new_7d'   => (int)$scalar('SELECT COUNT(*) FROM users WHERE created_at>=?', [$d7]),
            'online_now'     => (int)$scalar('SELECT COUNT(*) FROM users WHERE last_seen_at>?', [$now - 300]),
            'dau' => $dau, 'wau' => $wau, 'mau' => $mau,
            'stickiness'     => $mau > 0 ? round(100 * $dau / $mau, 1) : 0,
            'sessions_24h'   => (int)$scalar("SELECT COUNT(*) FROM events WHERE name='session_start' AND created_at>=?", [$d1]),
            'gold_circ'      => (float)$scalar('SELECT COALESCE(SUM(gold),0) FROM player_state'),
            'gems_circ'      => (int)$scalar('SELECT COALESCE(SUM(gems),0) FROM player_state'),
            'tokens_circ'    => (int)$scalar('SELECT COALESCE(SUM(tokens),0) FROM player_state'),
            'gold_24h'       => $econ('gold', $d1),
            'gold_7d'        => $econ('gold', $d7),
            'gems_24h'       => $econ('gems', $d1),
            'ledger_tx_24h'  => (int)$scalar('SELECT COUNT(*) FROM ledger WHERE created_at>=?', [$d1]),
            'revenue_total'  => (float)$scalar("SELECT COALESCE(SUM(amount_usd),0) FROM payments WHERE status='paid'"),
            'revenue_30d'    => (float)$scalar("SELECT COALESCE(SUM(amount_usd),0) FROM payments WHERE status='paid' AND COALESCE(paid_at,created_at)>=?", [$d30]),
            'payers_30d'     => (int)$scalar("SELECT COUNT(DISTINCT user_id) FROM payments WHERE status='paid' AND COALESCE(paid_at,created_at)>=?", [$d30]),
            'top_faucets_7d' => $topReasons('+', $d7),
            'top_sinks_7d'   => $topReasons('-', $d7),
            'last_snapshot'  => $rows('SELECT * FROM economy_snapshots ORDER BY taken_at DESC LIMIT 1')[0] ?? null,
        ]]);

    /* ------------------------------------------------ economy (from ledger) */
    case 'economy':
        $days = $clampDays();
        $cur = req_str('currency', 'gold');
        if (!in_array($cur, ['gold', 'gems', 'tokens'], true)) { $cur = 'gold'; }
        $since = time() - $days * 86400;

        $raw = $rows("SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS d,
                             SUM(CASE WHEN delta>0 THEN delta ELSE 0 END)  AS created,
                             SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) AS burned,
                             COUNT(*) AS txns
                      FROM ledger WHERE currency=? AND created_at>=? GROUP BY d ORDER BY d", [$cur, $since]);
        $byDay = [];
        foreach ($raw as $r) { $byDay[$r['d']] = $r; }
        $series = [];
        for ($i = $days - 1; $i >= 0; $i--) {
            $d = $day(time() - $i * 86400);
            $r = $byDay[$d] ?? ['created' => 0, 'burned' => 0, 'txns' => 0];
            $created = (float)$r['created']; $burned = (float)$r['burned'];
            $series[] = ['day' => $d, 'created' => $created, 'burned' => $burned,
                         'net' => $created - $burned, 'txns' => (int)$r['txns']];
        }

        $reasons = $rows('SELECT reason,
                                 SUM(CASE WHEN delta>0 THEN delta ELSE 0 END)  AS created,
                                 SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) AS burned,
                                 COUNT(*) AS n
                          FROM ledger WHERE currency=? AND created_at>=?
                          GROUP BY reason ORDER BY (created+burned) DESC LIMIT 18', [$cur, $since]);

        $circ = (float)$scalar("SELECT COALESCE(SUM($cur),0) FROM player_state");
        $median = (float)$scalar("SELECT COALESCE((SELECT $cur FROM player_state ORDER BY $cur
                                   LIMIT 1 OFFSET (SELECT COUNT(*) FROM player_state)/2),0)");
        $holders = $rows("SELECT u.username, u.id AS user_id, s.$cur AS balance
                          FROM player_state s JOIN users u ON u.id=s.user_id
                          ORDER BY s.$cur DESC LIMIT 10");

        json_out(['ok' => true, 'economy' => [
            'currency' => $cur, 'days' => $days, 'series' => $series, 'reasons' => $reasons,
            'circulation' => $circ, 'median' => $median, 'top_holders' => $holders,
            'snapshots' => $rows('SELECT * FROM economy_snapshots ORDER BY taken_at DESC LIMIT 60'),
        ]]);

    /* ------------------------------------------------ retention (from events) */
    case 'retention':
        $days = $clampDays();
        $since = time() - $days * 86400;

        $rawDau = $rows("SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS d,
                                COUNT(DISTINCT user_id) AS dau, COUNT(*) AS sessions
                         FROM events WHERE name='session_start' AND user_id IS NOT NULL AND created_at>=?
                         GROUP BY d", [$since]);
        $rawNew = $rows("SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS d, COUNT(*) AS n
                         FROM users WHERE created_at>=? GROUP BY d", [$since]);
        $mDau = []; foreach ($rawDau as $r) { $mDau[$r['d']] = $r; }
        $mNew = []; foreach ($rawNew as $r) { $mNew[$r['d']] = (int)$r['n']; }
        $series = [];
        for ($i = $days - 1; $i >= 0; $i--) {
            $d = $day(time() - $i * 86400);
            $series[] = ['day' => $d, 'dau' => (int)($mDau[$d]['dau'] ?? 0),
                         'sessions' => (int)($mDau[$d]['sessions'] ?? 0), 'new' => $mNew[$d] ?? 0];
        }

        // --- daily registration cohorts → D0/D1/D2/D3/D5/D7/D14/D30 ---
        $marks = [1, 2, 3, 5, 7, 14, 30];
        $cohortDays = 21;
        $cohortUsers = $rows("SELECT id, strftime('%Y-%m-%d', created_at, 'unixepoch') AS d
                              FROM users WHERE created_at >= ?", [time() - $cohortDays * 86400]);
        $cohortOf = []; $members = [];
        foreach ($cohortUsers as $u) { $cohortOf[(int)$u['id']] = $u['d']; $members[$u['d']][] = (int)$u['id']; }

        $seen = []; // "uid" => [ 'Y-m-d' => true ]
        if ($cohortOf) {
            $ev = $rows("SELECT user_id, strftime('%Y-%m-%d', created_at, 'unixepoch') AS d
                         FROM events WHERE name='session_start' AND user_id IS NOT NULL AND created_at >= ?
                         GROUP BY user_id, d", [time() - ($cohortDays + 31) * 86400]);
            foreach ($ev as $e) {
                if (isset($cohortOf[(int)$e['user_id']])) { $seen[(int)$e['user_id']][$e['d']] = true; }
            }
        }
        $today = $day(time());
        $cohorts = [];
        $markSum = array_fill_keys($marks, [0, 0]); // mark => [retained, eligibleUsers]
        krsort($members);
        foreach ($members as $cDay => $ids) {
            $row = ['day' => $cDay, 'size' => count($ids), 'r' => []];
            $base = strtotime($cDay . ' UTC');
            foreach ($marks as $m) {
                $target = $day($base + $m * 86400);
                if ($target > $today) { $row['r']['D' . $m] = null; continue; }
                $kept = 0;
                foreach ($ids as $id) { if (!empty($seen[$id][$target])) { $kept++; } }
                $row['r']['D' . $m] = round(100 * $kept / max(1, count($ids)), 1);
                $markSum[$m][0] += $kept; $markSum[$m][1] += count($ids);
            }
            $cohorts[] = $row;
        }
        $summary = [];
        foreach ($marks as $m) {
            $summary['D' . $m] = $markSum[$m][1] > 0 ? round(100 * $markSum[$m][0] / $markSum[$m][1], 1) : null;
        }

        $dau = $activeUsers(time() - 86400); $wau = $activeUsers(time() - 7 * 86400); $mau = $activeUsers(time() - 30 * 86400);
        json_out(['ok' => true, 'retention' => [
            'days' => $days, 'series' => $series, 'cohorts' => $cohorts, 'summary' => $summary,
            'marks' => $marks, 'dau' => $dau, 'wau' => $wau, 'mau' => $mau,
            'stickiness' => $mau > 0 ? round(100 * $dau / $mau, 1) : 0,
            'activity_mix_7d' => $rows("SELECT name, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users
                                        FROM events WHERE created_at>=? GROUP BY name ORDER BY n DESC LIMIT 14",
                                        [time() - 7 * 86400]),
        ]]);

    /* ------------------------------------------------ players */
    case 'players':
        $q = trim(req_str('q', ''));
        $sortMap = ['created' => 'u.created_at DESC', 'last_seen' => 'u.last_seen_at DESC',
                    'gold' => 's.gold DESC', 'gems' => 's.gems DESC', 'level' => 's.level DESC',
                    'clicks' => 's.total_clicks DESC', 'total_gold' => 's.total_gold DESC'];
        $sort = $sortMap[req_str('sort', 'created')] ?? $sortMap['created'];
        $where = ''; $p = [];
        if ($q !== '') { $where = 'WHERE u.username LIKE ?'; $p[] = '%' . $q . '%'; }
        $total = (int)$scalar("SELECT COUNT(*) FROM users u LEFT JOIN player_state s ON s.user_id=u.id $where", $p);
        $off = ($page - 1) * $perPage;
        $list = $rows("SELECT u.id, u.username, u.role, u.is_banned, u.created_at, u.last_seen_at,
                              s.level, s.gold, s.gems, s.tokens, s.sparks, s.prestige_count,
                              s.total_clicks, s.total_gold
                       FROM users u LEFT JOIN player_state s ON s.user_id=u.id
                       $where ORDER BY $sort LIMIT $perPage OFFSET $off", $p);
        json_out(['ok' => true, 'players' => $list, 'total' => $total, 'page' => $page,
                  'pages' => max(1, (int)ceil($total / $perPage))]);

    case 'player':
        $pid = req_int('id', 0);
        $u = $rows('SELECT u.*, s.* FROM users u LEFT JOIN player_state s ON s.user_id=u.id WHERE u.id=?', [$pid])[0] ?? null;
        if (!$u) { api_fail('player not found', 404); }
        unset($u['pass_hash']);
        json_out(['ok' => true, 'player' => $u,
            'ledger' => $rows('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 40', [$pid]),
            'events' => $rows('SELECT * FROM events WHERE user_id=? ORDER BY id DESC LIMIT 40', [$pid]),
            'payments' => $rows('SELECT * FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 20', [$pid]),
            'items_owned' => (int)$scalar('SELECT COUNT(*) FROM player_items WHERE user_id=? AND qty>0', [$pid]),
            'sessions' => (int)$scalar('SELECT COUNT(*) FROM sessions WHERE user_id=?', [$pid]),
        ]);

    /* ------------------------------------------------ mutations (admin only) */
    case 'grant':
        $pid = req_int('user_id', 0);
        $cur = req_str('currency', '');
        $amount = (float)(req_body()['amount'] ?? 0);
        $note = fi_substr(trim(req_str('note', '')), 120);
        if (!in_array($cur, ['gold', 'gems', 'tokens'], true)) { api_fail('bad currency'); }
        if ($amount == 0.0 || abs($amount) > 1e15) { api_fail('bad amount'); }
        if ($cur !== 'gold') { $amount = (float)(int)$amount; if ($amount == 0.0) { api_fail('bad amount'); } }
        $target = $rows('SELECT username FROM users WHERE id=?', [$pid])[0] ?? null;
        if (!$target) { api_fail('player not found', 404); }
        Game::loadState($pid);
        $bal = fi_tx(fn(PDO $tx) => Game::addCurrency($tx, $pid, $cur, $amount, 'admin_grant'));
        if ($bal === null) { api_fail('موجودی بازیکن برای این کسر کافی نیست'); }
        fi_event($pid, 'admin_grant', ['by' => $me['username'], 'cur' => $cur, 'amount' => $amount, 'note' => $note]);
        fi_audit($uid, $me['username'], 'grant', 'user', $pid, ['currency' => $cur, 'amount' => $amount, 'note' => $note, 'target' => $target['username'], 'new_balance' => $bal]);
        json_out(['ok' => true, 'balance' => $bal]);

    case 'set_ban':
        $pid = req_int('user_id', 0);
        $ban = req_int('banned', 0) ? 1 : 0;
        if ($pid === $uid) { api_fail('نمی‌توانید خودتان را بن کنید'); }
        $t = $rows('SELECT username, role FROM users WHERE id=?', [$pid])[0] ?? null;
        if (!$t) { api_fail('player not found', 404); }
        if ($t['role'] === 'admin') { api_fail('ادمین را نمی‌توان بن کرد — اول نقش او را عوض کنید'); }
        $pdo->prepare('UPDATE users SET is_banned=? WHERE id=?')->execute([$ban, $pid]);
        if ($ban) { $pdo->prepare('DELETE FROM sessions WHERE user_id=?')->execute([$pid]); }
        fi_audit($uid, $me['username'], $ban ? 'ban' : 'unban', 'user', $pid, ['target' => $t['username']]);
        json_out(['ok' => true]);

    case 'set_role':
        $pid = req_int('user_id', 0);
        $newRole = req_str('role', '');
        if (!in_array($newRole, ['player', 'mod', 'admin'], true)) { api_fail('bad role'); }
        if ($pid === $uid) { api_fail('نقش خودتان را نمی‌توانید عوض کنید'); }
        $t = $rows('SELECT username, role FROM users WHERE id=?', [$pid])[0] ?? null;
        if (!$t) { api_fail('player not found', 404); }
        if ($t['role'] === 'admin' && $newRole !== 'admin'
            && (int)$scalar("SELECT COUNT(*) FROM users WHERE role='admin'") <= 1) {
            api_fail('این تنها ادمین سیستم است');
        }
        $pdo->prepare('UPDATE users SET role=? WHERE id=?')->execute([$newRole, $pid]);
        fi_audit($uid, $me['username'], 'set_role', 'user', $pid, ['target' => $t['username'], 'from' => $t['role'], 'to' => $newRole]);
        json_out(['ok' => true]);

    case 'set_password':
        $pid = req_int('user_id', 0);
        $pw = (string)(req_body()['password'] ?? '');
        if (strlen($pw) < 6 || strlen($pw) > 200) { api_fail('password must be at least 6 characters'); }
        $t = $rows('SELECT username FROM users WHERE id=?', [$pid])[0] ?? null;
        if (!$t) { api_fail('player not found', 404); }
        $pdo->prepare('UPDATE users SET pass_hash=? WHERE id=?')->execute([password_hash($pw, PASSWORD_DEFAULT), $pid]);
        $pdo->prepare('DELETE FROM sessions WHERE user_id=?')->execute([$pid]); // force re-login everywhere
        fi_audit($uid, $me['username'], 'set_password', 'user', $pid, ['target' => $t['username']]);
        json_out(['ok' => true]);

    /* ------------------------------------------------ explorers */
    case 'events_explore':
        $name = trim(req_str('name', ''));
        $pid = req_int('user_id', 0);
        $conds = []; $p = [];
        if ($name !== '') { $conds[] = 'e.name=?'; $p[] = $name; }
        if ($pid > 0)     { $conds[] = 'e.user_id=?'; $p[] = $pid; }
        $where = $conds ? 'WHERE ' . implode(' AND ', $conds) : '';
        $total = (int)$scalar("SELECT COUNT(*) FROM events e $where", $p);
        $off = ($page - 1) * $perPage;
        json_out(['ok' => true,
            'events' => $rows("SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id=e.user_id
                               $where ORDER BY e.id DESC LIMIT $perPage OFFSET $off", $p),
            'names' => $rows("SELECT name, COUNT(*) AS n FROM events WHERE created_at>=? GROUP BY name ORDER BY n DESC", [time() - 30 * 86400]),
            'total' => $total, 'page' => $page, 'pages' => max(1, (int)ceil($total / $perPage))]);

    case 'ledger_explore':
        $cur = trim(req_str('currency', ''));
        $reason = trim(req_str('reason', ''));
        $pid = req_int('user_id', 0);
        $conds = []; $p = [];
        if (in_array($cur, ['gold', 'gems', 'tokens', 'energy'], true)) { $conds[] = 'l.currency=?'; $p[] = $cur; }
        if ($reason !== '') { $conds[] = 'l.reason=?'; $p[] = $reason; }
        if ($pid > 0)       { $conds[] = 'l.user_id=?'; $p[] = $pid; }
        $where = $conds ? 'WHERE ' . implode(' AND ', $conds) : '';
        $total = (int)$scalar("SELECT COUNT(*) FROM ledger l $where", $p);
        $off = ($page - 1) * $perPage;
        json_out(['ok' => true,
            'ledger' => $rows("SELECT l.*, u.username FROM ledger l LEFT JOIN users u ON u.id=l.user_id
                               $where ORDER BY l.id DESC LIMIT $perPage OFFSET $off", $p),
            'reasons' => $rows("SELECT reason, currency, COUNT(*) AS n FROM ledger WHERE created_at>=? GROUP BY reason, currency ORDER BY n DESC LIMIT 40", [time() - 30 * 86400]),
            'total' => $total, 'page' => $page, 'pages' => max(1, (int)ceil($total / $perPage))]);

    /* ------------------------------------------------ system & ops */
    case 'system':
        $tables = ['users', 'sessions', 'player_state', 'items', 'shop_offers', 'ledger', 'events', 'payments', 'admin_audit', 'economy_snapshots'];
        $counts = [];
        foreach ($tables as $t) {
            try { $counts[$t] = (int)$scalar("SELECT COUNT(*) FROM $t"); } catch (Throwable) { $counts[$t] = null; }
        }
        $dbBase = basename(FI_DB);
        json_out(['ok' => true, 'system' => [
            'version' => FI_VERSION, 'php' => PHP_VERSION, 'sapi' => PHP_SAPI,
            'server' => $_SERVER['SERVER_SOFTWARE'] ?? null,
            'server_time' => gmdate('c'),
            'sqlite' => (string)$scalar('SELECT sqlite_version()'),
            'journal_mode' => (string)$scalar('PRAGMA journal_mode'),
            'db_file' => $dbBase,
            'db_randomized' => $dbBase !== 'game.db',
            'db_size' => is_file(FI_DB) ? filesize(FI_DB) : 0,
            'wal_size' => is_file(FI_DB . '-wal') ? filesize(FI_DB . '-wal') : 0,
            'https' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
            'debug' => FI_DEBUG,
            'pay_provider' => FI_PAY_PROVIDER === '' ? 'demo' : FI_PAY_PROVIDER,
            'tables' => $counts,
            'protection' => [
                'root_htaccess'    => is_file(FI_ROOT . '/.htaccess'),
                'storage_htaccess' => is_file(FI_STORAGE . '/.htaccess'),
                'storage_guard'    => is_file(FI_STORAGE . '/index.php'),
                'jobs_htaccess'    => is_file(FI_ROOT . '/jobs/.htaccess'),
                'api_htaccess'     => is_file(FI_ROOT . '/api/.htaccess'),
                'installed_lock'   => is_file(FI_STORAGE . '/installed.lock'),
                'installer_present' => is_file(FI_ROOT . '/install.php'),
                'web_config'       => is_file(FI_ROOT . '/web.config'),
            ],
            'backups' => array_map(static fn($f) => ['name' => basename($f), 'size' => filesize($f), 'at' => filemtime($f)],
                                    glob(FI_STORAGE . '/backup/*.db') ?: []),
            'audit' => $rows('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 30'),
        ]]);

    case 'backup_now':
        $dir = FI_STORAGE . '/backup';
        if (!is_dir($dir)) { @mkdir($dir, 0775, true); }
        $name = 'game-' . gmdate('Ymd-His') . '.db';
        $out = $dir . '/' . $name;
        $pdo->exec('VACUUM INTO ' . $pdo->quote($out));
        $files = glob($dir . '/*.db') ?: [];
        usort($files, static fn($x, $y) => filemtime($y) <=> filemtime($x));
        foreach (array_slice($files, 14) as $old) { @unlink($old); } // keep 14 newest (cron keeps 7)
        fi_audit($uid, $me['username'], 'backup_now', 'system', $name, ['size' => filesize($out)]);
        json_out(['ok' => true, 'backup' => $name, 'size' => filesize($out)]);

    case 'snapshot_now':
        $dayAgo = time() - 86400;
        $faucet = (float)$scalar("SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency='gold' AND delta>0 AND created_at>?", [$dayAgo]);
        $sink   = (float)$scalar("SELECT COALESCE(-SUM(delta),0) FROM ledger WHERE currency='gold' AND delta<0 AND created_at>?", [$dayAgo]);
        $ratio  = $sink > 0 ? $faucet / $sink : ($faucet > 0 ? 99.0 : 1.0);
        $median = (float)$scalar('SELECT COALESCE((SELECT gold FROM player_state ORDER BY gold LIMIT 1 OFFSET (SELECT COUNT(*) FROM player_state)/2),0)');
        $pdo->prepare('INSERT INTO economy_snapshots(total_gold,total_gems,gold_created_24h,gold_burned_24h,faucet_sink_ratio,median_gold,active_users_24h,new_users_24h,revenue_usd)
                       VALUES(?,?,?,?,?,?,?,?,?)')->execute([
            (float)$scalar('SELECT COALESCE(SUM(gold),0) FROM player_state'),
            (int)$scalar('SELECT COALESCE(SUM(gems),0) FROM player_state'),
            $faucet, $sink, round($ratio, 4), $median,
            (int)$scalar('SELECT COUNT(*) FROM users WHERE last_seen_at>?', [$dayAgo]),
            (int)$scalar('SELECT COUNT(*) FROM users WHERE created_at>?', [$dayAgo]),
            (float)$scalar("SELECT COALESCE(SUM(amount_usd),0) FROM payments WHERE status='paid'"),
        ]);
        $sid = (int)$pdo->lastInsertId();
        fi_audit($uid, $me['username'], 'snapshot_now', 'system', $sid, ['ratio' => round($ratio, 3)]);
        json_out(['ok' => true, 'snapshot_id' => $sid, 'ratio' => round($ratio, 3)]);

    default:
        api_fail('unknown_action');
    }
} catch (Throwable $e) {
    error_log('[admin] ' . $a . ': ' . $e->getMessage());
    api_fail(FI_DEBUG ? $e->getMessage() : 'server_error', 500);
}
