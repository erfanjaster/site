<?php
/**
 * DEV ONLY — router for PHP's built-in server with the v2 htdocs layout:
 *   php -S 0.0.0.0:8099 dev-router.php        (run from forge-infinite-v2/)
 * Mimics the production .htaccess blocks (storage/, jobs/, sensitive files)
 * so local behaviour matches Apache. Never deploy this file.
 */
declare(strict_types=1);

$pub = __DIR__ . '/htdocs';
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$uri = rawurldecode($uri);

// --- production parity: hard blocks
if (preg_match('#^/(storage|jobs|tests|tools)(/|$)#', $uri)
    || preg_match('/\.(?:sqlite3?|db|sql|log|md|ini|env|bak)$/i', $uri)
    || preg_match('#(^|/)\.(?!well-known)#', $uri)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "403 Forbidden (dev-router mirrors .htaccess)";
    return true;
}

// /api/<file>.php
if (preg_match('#^/api/([a-z_]+)\.php#', $uri, $m)) {
    $file = $pub . '/api/' . $m[1] . '.php';
    if (is_file($file)) { require $file; return true; }
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => 'endpoint_not_found']);
    return true;
}

// /install.php (root installer)
if ($uri === '/install.php' && is_file($pub . '/install.php')) {
    require $pub . '/install.php';
    return true;
}

// /u/<name> → public profile API
if (preg_match('#^/u/([A-Za-z0-9_]{3,20})$#', $uri, $m)) {
    $_GET['u'] = $m[1];
    require $pub . '/api/profile.php';
    return true;
}

// static files
$path = $pub . $uri;
if (is_dir($path)) {
    foreach (['index.html', 'index.php'] as $idx) {
        if (is_file($path . '/' . $idx)) { $path = $path . '/' . $idx; break; }
    }
}
if ($uri !== '/' && is_file($path)) {
    if (str_ends_with($path, '.php')) { require $path; return true; }
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $mime = ['html' => 'text/html; charset=utf-8', 'css' => 'text/css; charset=utf-8',
             'js' => 'text/javascript; charset=utf-8', 'json' => 'application/json; charset=utf-8',
             'svg' => 'image/svg+xml', 'png' => 'image/png', 'ico' => 'image/x-icon',
             'webmanifest' => 'application/manifest+json', 'txt' => 'text/plain; charset=utf-8'][$ext] ?? null;
    if ($mime) { header('Content-Type: ' . $mime); }
    header('Cache-Control: no-cache');
    readfile($path);
    return true;
}

// SPA fallback (game shell)
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
readfile($pub . '/index.html');
return true;
