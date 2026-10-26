<?php
/**
 * FORGE INFINITE — bootstrap: DB, JSON I/O, auth, rate limiting, logging.
 * Every API endpoint requires this file first.
 */
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/Balance.php';
require_once __DIR__ . '/Game.php';
require_once __DIR__ . '/Shop.php';

/* ------------------------------------------------------------------ *
 *  Database
 * ------------------------------------------------------------------ */
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $dir = dirname(FI_DB);
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    $fresh = !file_exists(FI_DB);

    $pdo = new PDO('sqlite:' . FI_DB, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
        PDO::ATTR_TIMEOUT            => 10,
    ]);

    // ---- the four pragmas that make SQLite survive shared hosting ----
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA synchronous  = NORMAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA cache_size   = -8000');
    $pdo->exec('PRAGMA temp_store   = MEMORY');
    $pdo->exec('PRAGMA wal_autocheckpoint = 500');

    if ($fresh) {
        fi_install($pdo);
    } else {
        // v2 auto-migration: install.sql is fully idempotent (IF NOT EXISTS),
        // so re-running it on a v1 database only adds the new tables/indexes.
        // The probe is one indexed sqlite_master lookup (~µs).
        $has = $pdo->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_audit'")->fetchColumn();
        if (!$has) {
            fi_install($pdo);
        }
    }
    return $pdo;
}

/** Run install.sql then seed content from balance.json. Idempotent. */
function fi_install(?PDO $pdo = null): void
{
    $pdo = $pdo ?? db();
    $sql = file_get_contents(__DIR__ . '/install.sql');
    if ($sql === false) {
        throw new RuntimeException('install.sql missing');
    }
    $pdo->exec($sql);
    Shop::seedContent($pdo);
}

/* ------------------------------------------------------------------ *
 *  Output
 * ------------------------------------------------------------------ */
function json_out(array $data, int $code = 200): never
{
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, max-age=0');
        header('X-Server-Time: ' . time());
        header('X-FI-Version: ' . FI_VERSION);
        header_remove('X-Powered-By');
        // Security headers
        header("X-Content-Type-Options: nosniff");
        header("X-Frame-Options: SAMEORIGIN");
        header("Referrer-Policy: strict-origin-when-cross-origin");
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function api_fail(string $msg, int $code = 400, array $extra = []): never
{
    json_out(array_merge(['ok' => false, 'error' => $msg], $extra), $code);
}

/** Read the JSON request body (tolerates form-encoded too). */
function req_body(): array
{
    static $body = null;
    if ($body !== null) {
        return $body;
    }
    $raw = file_get_contents('php://input') ?: '';
    $dec = json_decode($raw, true);
    $body = is_array($dec) ? $dec : $_POST;
    return $body;
}

function req_str(string $k, string $def = ''): string
{
    $b = req_body();
    if (array_key_exists($k, $b)) {
        $v = $b[$k];
        return is_string($v) ? $v : (string)$v;
    }
    if (array_key_exists($k, $_GET)) {          // GET-style endpoints (e.g. pay.php?a=packs)
        return (string)$_GET[$k];
    }
    return $def;
}

function req_int(string $k, int $def = 0): int
{
    $b = req_body();
    $v = $b[$k] ?? $def;
    return is_numeric($v) ? (int)$v : $def;
}

/* ------------------------------------------------------------------ *
 *  Rate limiting (fixed window in SQLite — no Redis on shared hosting)
 * ------------------------------------------------------------------ */
function rate_limit(string $key, int $max, int $windowSec): bool
{
    $now = time();
    $cut = $now - $windowSec;
    $pdo = db();

    $st = $pdo->prepare('SELECT count, window_start FROM rate_limits WHERE key = ?');
    $st->execute([$key]);
    $row = $st->fetch();

    if (!$row || (int)$row['window_start'] < $cut) {
        $pdo->prepare('INSERT INTO rate_limits(key,count,window_start) VALUES(?,1,?)
                       ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start')
            ->execute([$key, $now]);
        return true;
    }
    if ((int)$row['count'] >= $max) {
        return false;
    }
    $pdo->prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')->execute([$key]);
    return true;
}

function client_ip(): string
{
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
}

/* ------------------------------------------------------------------ *
 *  Auth — bearer token sessions
 * ------------------------------------------------------------------ */
function auth_token(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (!$h && function_exists('apache_request_headers')) {
        $all = apache_request_headers();
        $h = $all['Authorization'] ?? $all['authorization'] ?? '';
    }
    if (preg_match('/^Bearer\s+(\S+)$/i', trim($h), $m)) {
        return $m[1];
    }
    return (string)(req_body()['token'] ?? '');
}

/** Returns ['user_id'=>int,'username'=>string,'role'=>string] or fails with 401. */
function require_auth(bool $touch = true): array
{
    $tok = auth_token();
    if ($tok === '' || strlen($tok) < 32) {
        api_fail('unauthorized', 401);
    }
    $st = db()->prepare('SELECT s.user_id, s.expires_at, u.username, u.role, u.is_banned, u.last_seen_at
                         FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.id = ?');
    $st->execute([$tok]);
    $s = $st->fetch();
    if (!$s || (int)$s['expires_at'] < time()) {
        api_fail('unauthorized', 401);
    }
    if ((int)$s['is_banned'] === 1) {
        api_fail('banned', 403);
    }
    if ($touch) {
        $now = time();
        $last = (int)$s['last_seen_at'];
        db()->prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')->execute([$now, (int)$s['user_id']]);
        // Retention telemetry: one session_start event per return visit
        // (≥30 min gap, or first hit of a new UTC day). The admin panel
        // derives DAU/WAU/MAU + cohort retention from these events.
        if ($last <= 0 || $now - $last >= 1800 || gmdate('Y-m-d', $last) !== gmdate('Y-m-d', $now)) {
            fi_event((int)$s['user_id'], 'session_start', ['gap' => $last > 0 ? $now - $last : null]);
        }
    }
    return ['user_id' => (int)$s['user_id'], 'username' => (string)$s['username'], 'role' => (string)$s['role']];
}

function new_session_token(int $userId): string
{
    $tok = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO sessions(id,user_id,expires_at,ip) VALUES(?,?,?,?)')
        ->execute([$tok, $userId, time() + FI_SESSION_DAYS * 86400, client_ip()]);
    return $tok;
}

/* ------------------------------------------------------------------ *
 *  Validation helpers
 * ------------------------------------------------------------------ */
/** mb_substr with a safe fallback (mbstring is not enabled on every shared host). */
function fi_substr(string $s, int $max): string
{
    if (function_exists('mb_substr')) {
        return mb_substr($s, 0, $max, 'UTF-8');
    }
    $s = preg_replace('/[\x80-\xFF]/', '?', $s) ?? $s;   // ASCII-safe truncation fallback
    return substr($s, 0, $max);
}

function valid_username(string $u): bool
{
    return (bool)preg_match('/^[A-Za-z0-9_]{3,20}$/', $u);
}

function valid_password(string $p): bool
{
    return strlen($p) >= 6 && strlen($p) <= 200;
}

/* ------------------------------------------------------------------ *
 *  Telemetry + audit
 * ------------------------------------------------------------------ */
function fi_event(?int $userId, string $name, array $props = []): void
{
    try {
        db()->prepare('INSERT INTO events(user_id,name,props_json) VALUES(?,?,?)')
            ->execute([$userId, $name, $props ? json_encode($props, JSON_UNESCAPED_UNICODE) : null]);
    } catch (Throwable) {
        // telemetry must never break a request
    }
}

/** Immutable audit trail for every admin-panel mutation. */
function fi_audit(?int $actorId, ?string $actorName, string $action, ?string $targetType = null, mixed $targetId = null, array $detail = []): void
{
    try {
        db()->prepare('INSERT INTO admin_audit(actor_id,actor_name,action,target_type,target_id,detail_json,ip) VALUES(?,?,?,?,?,?,?)')
            ->execute([$actorId, $actorName, $action, $targetType,
                       $targetId === null ? null : (string)$targetId,
                       $detail ? json_encode($detail, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
                       client_ip()]);
    } catch (Throwable) {
        // audit must never break a request
    }
}

/* ------------------------------------------------------------------ *
 *  Short atomic-transaction helper.
 *  Uses BEGIN IMMEDIATE so concurrent writers queue instead of deadlocking.
 * ------------------------------------------------------------------ */
function fi_tx(callable $fn): mixed
{
    $pdo = db();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $r = $fn($pdo);
        $pdo->exec('COMMIT');
        return $r;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
        throw $e;
    }
}

/* ------------------------------------------------------------------ *
 *  CORS / preflight (same-origin by default; adjust if you split domains)
 * ------------------------------------------------------------------ */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    header('Access-Control-Allow-Origin: ' . ($_SERVER['HTTP_ORIGIN'] ?? '*'));
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 86400');
    exit;
}
