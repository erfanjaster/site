<?php
/**
 * CRON — daily:  php /home/USER/app/jobs/backup.php
 * Uses the SQLite online backup API. NEVER copy the .db file with `cp` while
 * WAL is enabled — the -wal and -shm files would be missed and the copy corrupt.
 */
declare(strict_types=1);
// v2: jobs/installers must never be runnable from the web (htdocs layout).
if (PHP_SAPI !== 'cli') { http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); exit('403 — CLI only. Run via SSH/cron: php ' . basename(__FILE__)); }
require_once dirname(__DIR__) . '/api/bootstrap.php';

$dir = dirname(FI_DB) . '/backup';
if (!is_dir($dir)) { mkdir($dir, 0770, true); }
$out = $dir . '/game-' . gmdate('Ymd-His') . '.db';

$src = db();
$dst = new PDO('sqlite:' . $out, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

if (method_exists($src, 'sqliteCreateFunction') && method_exists($dst, 'backup')) {
    // PHP 8.3+ has PDO::backup(); fall back otherwise
}
if (method_exists($src, 'backup')) {
    $src->backup($dst);
} else {
    // Portable fallback: dump via the sqlite3 CLI if present, else VACUUM INTO
    try {
        $src->exec("VACUUM INTO " . $src->quote($out));
    } catch (Throwable $e) {
        fwrite(STDERR, "backup failed: " . $e->getMessage() . "\n");
        exit(1);
    }
}

// keep the 7 newest
$files = glob($dir . '/game-*.db') ?: [];
sort($files);
while (count($files) > 7) { @unlink(array_shift($files)); }

$size = file_exists($out) ? filesize($out) : 0;
echo json_encode(['ok' => true, 'file' => basename($out), 'bytes' => $size]), "\n";
