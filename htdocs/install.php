<?php
/**
 * FORGE INFINITE v2 — one-click web installer for htdocs-only hosting.
 *
 *   1. Upload the whole package into htdocs / public_html.
 *   2. (Recommended) set FI_SETUP_KEY in api/config.php, then open
 *      https://yourdomain.com/install.php?key=YOUR_KEY
 *   3. Create the first admin account. The installer locks itself
 *      (storage/installed.lock) and renames itself when done.
 *
 * Safe by design: refuses to run when a lock exists or when an admin
 * already exists; re-running db_install logic is idempotent anyway.
 */
declare(strict_types=1);

require_once __DIR__ . '/api/config.php';

$lock = FI_STORAGE . '/installed.lock';
$key  = (string)($_GET['key'] ?? $_POST['key'] ?? '');

function page(string $title, string $body): never
{
    header('Content-Type: text/html; charset=utf-8');
    header('X-Robots-Tag: noindex, nofollow');
    echo '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>' . htmlspecialchars($title) . ' · Forge Infinite</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:22px 14px;
background:radial-gradient(ellipse 90% 46% at 50% -6%,rgba(255,122,24,.18),transparent 62%),#12100D;
color:#F7F1E5;font-family:Tahoma,"Segoe UI",system-ui,sans-serif;line-height:1.8}
.card{width:min(100%,520px);background:linear-gradient(175deg,#262019,#1B1815 40%);border:1px solid #55483A;
border-radius:22px;padding:26px 22px;box-shadow:0 22px 60px rgba(0,0,0,.6)}
h1{font-size:21px;margin:0 0 4px}.sub{color:#C2B6A4;font-size:13px;margin:0 0 18px}
.chk{display:flex;justify-content:space-between;gap:10px;padding:8px 2px;border-bottom:1px solid #3B3229;font-size:13.5px}
.ok{color:#4ADE80;font-weight:700}.bad{color:#F87171;font-weight:700}.warn{color:#FBBF24;font-weight:700}
label{display:block;font-size:13px;color:#C2B6A4;margin:14px 0 5px}
input{width:100%;min-height:48px;border-radius:12px;border:1px solid #3B3229;background:#171310;color:#F7F1E5;
padding:10px 13px;font-size:15px;direction:ltr;text-align:left}
input:focus{border-color:#FF7A18;outline:none;box-shadow:0 0 0 3px rgba(255,122,24,.22)}
.btn{width:100%;min-height:50px;margin-top:20px;border:0;border-radius:14px;cursor:pointer;font-size:15px;font-weight:800;
background:linear-gradient(135deg,#FFCE54,#FF7A18 58%,#C2410C);color:#1D1104;box-shadow:0 4px 18px rgba(255,122,24,.38)}
.err{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.45);color:#FECACA;border-radius:12px;padding:10px 13px;font-size:13.5px}
.note{background:rgba(125,211,252,.07);border:1px solid #3B3229;border-right:3px solid #7DD3FC;border-radius:12px;padding:10px 13px;font-size:13px;color:#C2B6A4}
a{color:#FFB020}code{direction:ltr;display:inline-block;background:#171310;border:1px solid #3B3229;border-radius:6px;padding:1px 7px;font-size:12.5px}
ul{margin:8px 0;padding-right:18px;font-size:13.5px}.en{direction:ltr;text-align:left;font-size:12px;color:#93876F}
</style></head><body><main class="card">' . $body . '</main></body></html>';
    exit;
}

/* ---------------- guards ---------------- */
if (is_file($lock)) {
    http_response_code(403);
    page('قبلاً نصب شده', '<h1>🔒 سیستم قبلاً نصب شده است</h1>
    <p class="sub">برای نصب مجدد، اول فایل زیر را حذف کنید. در غیر این صورت، همین حالا <b>install.php</b> را از روی هاست پاک کنید.</p>
    <p><code>storage/installed.lock</code></p>
    <p class="en">Already installed. Delete install.php now.</p>');
}
if (FI_SETUP_KEY !== '' && !hash_equals(FI_SETUP_KEY, $key)) {
    http_response_code(403);
    page('کلید نصب لازم است', '<h1>🗝️ کلید نصب لازم است</h1>
    <p class="sub">در فایل <code>api/config.php</code> یک FI_SETUP_KEY تعریف شده. آدرس را این‌طور باز کنید:</p>
    <p><code>install.php?key=YOUR_KEY</code></p>');
}

/* ---------------- environment checks ---------------- */
$checks = [];
$checks[] = ['PHP 8.1 یا بالاتر', PHP_VERSION, version_compare(PHP_VERSION, '8.1.0', '>=') ? 'ok' : 'bad'];
$checks[] = ['افزونه pdo_sqlite', extension_loaded('pdo_sqlite') ? 'فعال' : 'غیرفعال!', extension_loaded('pdo_sqlite') ? 'ok' : 'bad'];
if (!is_dir(FI_STORAGE)) { @mkdir(FI_STORAGE, 0775, true); }
if (!is_dir(FI_STORAGE . '/backup')) { @mkdir(FI_STORAGE . '/backup', 0775, true); }
$writable = is_dir(FI_STORAGE) && is_writable(FI_STORAGE);
$checks[] = ['پوشه storage قابل نوشتن', $writable ? 'بله' : 'خیر — دسترسی 0775 بدهید', $writable ? 'ok' : 'bad'];
$server = $_SERVER['SERVER_SOFTWARE'] ?? 'PHP built-in / unknown';
$isApacheLike = (bool)preg_match('/apache|litespeed/i', $server);
$checks[] = ['وب‌سرور (' . $server . ')', $isApacheLike ? '.htaccess پشتیبانی می‌شود ✓' : '⚠ nginx/IIS؟ اسنیپت راهنما را اعمال کنید', $isApacheLike ? 'ok' : 'warn'];
$checks[] = ['HTTPS', (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'فعال' : '⚠ AutoSSL را فعال کنید', (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'ok' : 'warn'];

$hardFail = false;
foreach ($checks as $c) { if ($c[2] === 'bad') { $hardFail = true; } }
$checksHtml = '';
foreach ($checks as [$label, $val, $st]) {
    $checksHtml .= '<div class="chk"><span>' . htmlspecialchars($label) . '</span><span class="' . $st . '">' . htmlspecialchars($val) . '</span></div>';
}

/* ---------------- protective files (FTP clients love to drop dotfiles) ---------------- */
function ensure_file(string $path, string $content): string
{
    if (is_file($path)) { return 'exists'; }
    return @file_put_contents($path, $content) !== false ? 'created' : 'FAILED';
}
$storageHt = "# Forge Infinite — deny ALL web access to storage/\nOptions -Indexes\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\nphp_admin_flag engine off\n";
$jobsHt    = "# Forge Infinite — cron scripts: CLI only\nOptions -Indexes\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n";
$apiHt     = "# Forge Infinite — deny non-PHP files in api/\nOptions -Indexes\n<FilesMatch \"\\.(?:sql|sqlite|sqlite3|db|log|md|txt|json|bak|ini|env)$\">\n  <IfModule mod_authz_core.c>\n    Require all denied\n  </IfModule>\n  <IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n  </IfModule>\n</FilesMatch>\n";
$guardPhp  = "<?php http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); exit('403 Forbidden');\n";

/* ---------------- POST: perform the install ---------------- */
$error = '';
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && !$hardFail) {
    $admin = trim((string)($_POST['admin_user'] ?? ''));
    $pass  = (string)($_POST['admin_pass'] ?? '');
    $pass2 = (string)($_POST['admin_pass2'] ?? '');

    if (!preg_match('/^[A-Za-z0-9_]{3,20}$/', $admin)) {
        $error = 'نام کاربری ادمین باید ۳ تا ۲۰ کاراکتر لاتین/عدد/آندرلاین باشد.';
    } elseif (strlen($pass) < 8) {
        $error = 'رمز ادمین باید حداقل ۸ کاراکتر باشد.';
    } elseif ($pass !== $pass2) {
        $error = 'رمز عبور و تکرارش یکی نیستند.';
    } else {
        try {
            // 1) protective files (repairs dotfiles lost during FTP upload)
            $prot = [
                'storage/.htaccess' => ensure_file(FI_STORAGE . '/.htaccess', $storageHt),
                'storage/index.php' => ensure_file(FI_STORAGE . '/index.php', $guardPhp),
                'jobs/.htaccess'    => ensure_file(FI_ROOT . '/jobs/.htaccess', $jobsHt),
                'jobs/index.php'    => ensure_file(FI_ROOT . '/jobs/index.php', $guardPhp),
                'api/.htaccess'     => ensure_file(FI_ROOT . '/api/.htaccess', $apiHt),
            ];

            // 2) database + seed (db() auto-installs a fresh DB; fi_install is idempotent)
            require_once __DIR__ . '/api/bootstrap.php';
            $pdo = db();
            fi_install($pdo);
            $jm = (string)$pdo->query('PRAGMA journal_mode')->fetchColumn();
            $ver = (string)$pdo->query('SELECT sqlite_version()')->fetchColumn();

            // 3) first admin (refuse if ANY admin already exists)
            $admins = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role='admin'")->fetchColumn();
            if ($admins > 0) {
                throw new RuntimeException('یک حساب ادمین از قبل وجود دارد — نصب‌کننده قفل شد.');
            }
            $st = $pdo->prepare('SELECT id FROM users WHERE username = ?');
            $st->execute([$admin]);
            $uid = (int)($st->fetchColumn() ?: 0);
            if ($uid) {
                $pdo->prepare("UPDATE users SET pass_hash = ?, role = 'admin' WHERE id = ?")
                    ->execute([password_hash($pass, PASSWORD_DEFAULT), $uid]);
            } else {
                $pdo->prepare("INSERT INTO users(username,pass_hash,last_ip,role) VALUES(?,?,?,'admin')")
                    ->execute([$admin, password_hash($pass, PASSWORD_DEFAULT), client_ip()]);
                $uid = (int)$pdo->lastInsertId();
            }
            Game::loadState($uid);
            fi_event($uid, 'register', ['via' => 'installer']);
            fi_audit($uid, $admin, 'install', 'system', null, ['journal_mode' => $jm, 'sqlite' => $ver]);

            // 4) lock + self-destruct
            @file_put_contents($lock, json_encode(['at' => gmdate('c'), 'admin' => $admin, 'ip' => client_ip()]) . "\n");
            $renamed = @rename(__FILE__, __FILE__ . '.done');

            $protHtml = '';
            foreach ($prot as $f => $r) {
                $protHtml .= '<div class="chk"><span><code>' . htmlspecialchars($f) . '</code></span><span class="' . ($r === 'FAILED' ? 'bad' : 'ok') . '">' .
                    ($r === 'exists' ? 'موجود ✓' : ($r === 'created' ? 'ساخته شد ✓' : 'خطا! دستی بسازید')) . '</span></div>';
            }
            $walWarn = $jm === 'wal' ? '' : '<p class="err">⚠️ حالت journal دیتابیس <b>' . htmlspecialchars($jm) . '</b> است، نه wal. یعنی فضای هاست روی فایل‌سیستم شبکه‌ای (NFS) است و SQLite ممکن است خراب شود. با پشتیبانی هاست صحبت کنید یا به VPS/MySQL فکر کنید.</p>';

            page('نصب کامل شد', '<h1>🎉 نصب کامل شد!</h1>
            <p class="sub">Forge Infinite v' . FI_VERSION . ' آماده است. SQLite ' . htmlspecialchars($ver) . ' · journal: <code>' . htmlspecialchars($jm) . '</code></p>
            ' . $walWarn . '
            <div class="chk"><span>حساب ادمین</span><span class="ok"><code>' . htmlspecialchars($admin) . '</code></span></div>
            <div class="chk"><span>دیتابیس</span><span class="ok"><code>storage/' . htmlspecialchars(basename(FI_DB)) . '</code></span></div>
            ' . $protHtml . '
            <div class="chk"><span>install.php</span><span class="' . ($renamed ? 'ok' : 'bad') . '">' .
                ($renamed ? 'خودکار غیرفعال شد ✓' : '⚠ همین حالا دستی پاکش کنید!') . '</span></div>
            <p style="margin-top:18px"><b> قدم بعدی — حتماً این سه لینک باید 403/404 بدهند:</b></p>
            <ul>
              <li><a href="storage/" target="_blank" rel="noopener">storage/</a></li>
              <li><a href="api/install.sql" target="_blank" rel="noopener">api/install.sql</a></li>
              <li><a href="jobs/backup.php" target="_blank" rel="noopener">jobs/backup.php</a></li>
            </ul>
            <p class="note">بعد وارد <a href="./">بازی</a> شوید و با حساب ادمین لاگین کنید؛ پنل مدیریت از آدرس <a href="admin/">/admin/</a> در دسترس است. سه کرون‌جاب داخل <code>jobs/crons.txt</code> را هم در cPanel ثبت کنید.</p>');
        } catch (Throwable $e) {
            $error = 'خطا هنگام نصب: ' . $e->getMessage();
            if (isset($lock) && isset($uid)) { /* partial state — still lock to be safe */ }
        }
    }
}

/* ---------------- GET: form ---------------- */
$keyField = FI_SETUP_KEY !== '' ? '<input type="hidden" name="key" value="' . htmlspecialchars($key) . '">' : '';
$body = '<h1>🔥 نصب Forge Infinite</h1>
<p class="sub">نسخه ' . FI_VERSION . ' · مخصوص هاست اشتراکی (همه‌چیز داخل htdocs)</p>
' . $checksHtml .
($error !== '' ? '<p class="err" style="margin-top:14px">' . htmlspecialchars($error) . '</p>' : '') .
($hardFail
  ? '<p class="err" style="margin-top:14px">موارد قرمز بالا را اول درست کنید (معمولاً در cPanel → Select PHP Version افزونه sqlite3/pdo_sqlite را تیک بزنید).</p>'
  : '<form method="post" autocomplete="off">' . $keyField . '
  <label for="u">نام کاربری ادمین (لاتین، برای ورود به بازی و پنل)</label>
  <input id="u" name="admin_user" required pattern="[A-Za-z0-9_]{3,20}" placeholder="e.g. erfanjaster">
  <label for="p">رمز عبور ادمین (حداقل ۸ کاراکتر)</label>
  <input id="p" name="admin_pass" type="password" required minlength="8" autocomplete="new-password">
  <label for="p2">تکرار رمز عبور</label>
  <input id="p2" name="admin_pass2" type="password" required minlength="8" autocomplete="new-password">
  <button class="btn" type="submit">نصب کن 🚀</button>
  <p class="note" style="margin-top:16px">دیتابیس با یک نام تصادفی داخل <code>storage/</code> ساخته می‌شود و دسترسی وب به آن با چند لایه محافظ بسته می‌شود. بعد از نصب، این فایل خودش را قفل و غیرفعال می‌کند.</p>
</form>');
page('نصب Forge Infinite', $body);
