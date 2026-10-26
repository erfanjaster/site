<?php
/**
 * CLI installer:  php api/db_install.php [--force]
 * Creates the database in storage/ (random filename, see config.php),
 * applies install.sql and seeds content from balance.json.
 * Safe to re-run (idempotent). Use --force to rebuild from scratch.
 */
declare(strict_types=1);
// v2: jobs/installers must never be runnable from the web (htdocs layout).
if (PHP_SAPI !== 'cli') { http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); exit('403 — CLI only. Run via SSH/cron: php ' . basename(__FILE__)); }
require_once __DIR__ . '/config.php';

$force = in_array('--force', $argv ?? [], true);
if ($force && file_exists(FI_DB)) {
    @unlink(FI_DB);
    @unlink(FI_DB . '-wal');
    @unlink(FI_DB . '-shm');
    echo "removed existing database\n";
}
$dir = dirname(FI_DB);
if (!is_dir($dir)) { mkdir($dir, 0775, true); }

$pdo = new PDO('sqlite:' . FI_DB, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);
$pdo->exec('PRAGMA journal_mode = WAL');
$pdo->exec('PRAGMA busy_timeout = 5000');
$pdo->exec('PRAGMA synchronous = NORMAL');
$pdo->exec('PRAGMA foreign_keys = ON');

$sql = file_get_contents(__DIR__ . '/install.sql');
$pdo->exec($sql);
echo "schema applied\n";

require_once __DIR__ . '/Balance.php';
require_once __DIR__ . '/Shop.php';
Shop::seedContent($pdo);

$c = fn(string $q) => (int)$pdo->query($q)->fetchColumn();
printf("seeded: %d items, %d offers, %d loot entries, %d achievements\n",
    $c('SELECT COUNT(*) FROM items'), $c('SELECT COUNT(*) FROM shop_offers'),
    $c('SELECT COUNT(*) FROM loot_entries'), $c('SELECT COUNT(*) FROM achievements'));

// integrity check
$ic = $pdo->query('PRAGMA integrity_check')->fetchColumn();
$fm = $pdo->query('PRAGMA foreign_key_check')->fetchAll();
echo "integrity_check: $ic | foreign_key_check: " . count($fm) . " issues\n";

// compliance assertion: no cosmetic may carry power
$bad = $pdo->query('SELECT COUNT(*) FROM items WHERE power_effect <> 0')->fetchColumn();
echo $bad == 0 ? "compliance: PASS (all cosmetics have power_effect = 0)\n"
               : "compliance: FAIL ($bad items carry power!)\n";


// ---- optional: seed a load-test cohort straight into the DB ----
// Lets tests/load.php measure concurrency without hammering the public
// registration endpoint (whose anti-farm cap is deliberately 8/IP/hour).
// NOTE: bootstrap.php is intentionally NOT loaded here, so this block must not
// call Game::/db() — it works on the local $pdo only.
if (in_array('--seed-loadtest', $argv ?? [], true)) {
    $n    = 60;
    $hash = password_hash('loadtest1', PASSWORD_DEFAULT);
    $insU = $pdo->prepare('INSERT OR IGNORE INTO users(username,pass_hash) VALUES(?,?)');
    $insP = $pdo->prepare('INSERT OR IGNORE INTO player_state(user_id,gems) VALUES(?,50)');
    $insS = $pdo->prepare('INSERT OR IGNORE INTO sessions(id,user_id,expires_at) VALUES(?,?,?)');
    $made = 0;
    for ($i = 0; $i < $n; $i++) {
        $u = 'loadbot' . $i;
        $insU->execute([$u, $hash]);
        $uid = (int)$pdo->query('SELECT id FROM users WHERE username = ' . $pdo->quote($u))->fetchColumn();
        if (!$uid) {
            continue;
        }
        $insP->execute([$uid]);
        // exactly 64 hex chars, matching what new_session_token() produces
        $token = str_pad('10ade' . $i, 64, '0');
        $insS->execute([$token, $uid, time() + 86400]);
        $made++;
    }
    echo "seeded $made load-test players\n";
    echo "token pattern: " . str_pad('10ade0', 64, '0') . " …\n";
}

echo "database ready at " . FI_DB . "\n";
