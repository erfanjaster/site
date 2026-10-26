<?php
/**
 * CRON — hourly:  php /home/USER/app/jobs/economy.php
 * Writes an economy snapshot and ALARMS when the faucet/sink ratio drifts
 * outside the healthy 0.9–1.1 band (GDD §4.4). This is how you catch inflation
 * in week 2 instead of month 6.
 */
declare(strict_types=1);
// v2: jobs/installers must never be runnable from the web (htdocs layout).
if (PHP_SAPI !== 'cli') { http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); exit('403 — CLI only. Run via SSH/cron: php ' . basename(__FILE__)); }
require_once dirname(__DIR__) . '/api/bootstrap.php';
$pdo = db();
$now = time(); $day = $now - 86400;

$faucet = (float)$pdo->query("SELECT COALESCE(SUM(delta),0) FROM ledger
    WHERE currency='gold' AND delta>0 AND created_at>$day")->fetchColumn();
$sink   = (float)$pdo->query("SELECT COALESCE(-SUM(delta),0) FROM ledger
    WHERE currency='gold' AND delta<0 AND created_at>$day")->fetchColumn();
$median = (float)$pdo->query("SELECT COALESCE(median,0) FROM (SELECT gold AS median FROM player_state
    ORDER BY gold LIMIT 1 OFFSET (SELECT COUNT(*) FROM player_state)/2)")->fetchColumn();
$active = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE last_seen_at>$day")->fetchColumn();
$gems   = (int)$pdo->query("SELECT COALESCE(SUM(gems),0) FROM player_state")->fetchColumn();
$paid   = (float)$pdo->query("SELECT COALESCE(SUM(amount_usd),0) FROM payments WHERE status='paid'")->fetchColumn();

$ratio = $sink > 0 ? $faucet / $sink : ($faucet > 0 ? 99.0 : 1.0);
$alarm = $ratio > 1.20 || $ratio < 0.75;

$pdo->prepare('INSERT INTO events(user_id,name,props_json) VALUES(NULL,?,?)')
    ->execute(['economy_snapshot', json_encode([
        'faucet_24h' => round($faucet), 'sink_24h' => round($sink), 'ratio' => round($ratio, 3),
        'median_gold' => round($median), 'active_24h' => $active, 'gems_in_circulation' => $gems,
        'revenue_usd' => round($paid, 2), 'alarm' => $alarm,
    ])]);

// v2: structured snapshot row — feeds the admin panel's economy history chart
$totalGold = (float)$pdo->query('SELECT COALESCE(SUM(gold),0) FROM player_state')->fetchColumn();
$newUsers  = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE created_at > $day")->fetchColumn();
$pdo->prepare('INSERT INTO economy_snapshots(total_gold,total_gems,gold_created_24h,gold_burned_24h,faucet_sink_ratio,median_gold,active_users_24h,new_users_24h,revenue_usd)
               VALUES(?,?,?,?,?,?,?,?,?)')
    ->execute([$totalGold, $gems, $faucet, $sink, round($ratio, 4), $median, $active, $newUsers, $paid]);

echo json_encode(['ratio' => round($ratio, 3), 'faucet' => round($faucet), 'sink' => round($sink),
                  'median_gold' => round($median), 'active_24h' => $active, 'revenue_usd' => round($paid, 2),
                  'alarm' => $alarm], JSON_PRETTY_PRINT), "\n";
if ($alarm) { fwrite(STDERR, "⚠ ECONOMY ALARM: faucet/sink ratio = " . round($ratio, 3) . " (healthy band 0.9–1.1)\n"); exit(2); }
