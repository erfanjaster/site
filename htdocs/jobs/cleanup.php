<?php
/**
 * CRON — every hour:  php /home/USER/app/jobs/cleanup.php
 * Purges expired sessions, stale rate-limit rows and empty player_items.
 */
declare(strict_types=1);
// v2: jobs/installers must never be runnable from the web (htdocs layout).
if (PHP_SAPI !== 'cli') { http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); exit('403 — CLI only. Run via SSH/cron: php ' . basename(__FILE__)); }
require_once dirname(__DIR__) . '/api/bootstrap.php';
$pdo = db(); $now = time();
$n = [];
$pdo->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([$now]);
$n['sessions'] = (int)$pdo->query('SELECT changes()')->fetchColumn();
$pdo->prepare('DELETE FROM rate_limits WHERE window_start < ?')->execute([$now - 7200]);
$n['rate_limits'] = $pdo->query('SELECT changes()')->fetchColumn();
$pdo->exec('DELETE FROM player_items WHERE qty <= 0');
$n['empty_items'] = $pdo->query('SELECT changes()')->fetchColumn();
$pdo->exec('DELETE FROM cache WHERE until_at < ' . ($now - 86400));
$n['stale_cache'] = $pdo->query('SELECT changes()')->fetchColumn();
$pdo->exec('DELETE FROM events WHERE created_at < ' . ($now - 86400 * 90));   // keep 90 days
$n['old_events'] = $pdo->query('SELECT changes()')->fetchColumn();
echo json_encode(['ok' => true, 'purged' => $n]), "\n";
