<?php
/**
 * POST api/pay.php — crypto IAP.
 *
 * {a:"create", pack:"best"}                    → returns an invoice / checkout payload
 * {a:"verify", idem:"<key>"}                   → client-side re-check after redirect
 * IPN webhook: POST with the provider signature → grants gems exactly once.
 *
 * With FI_PAY_PROVIDER = '' the endpoint runs in DEMO mode: it simulates a
 * successful payment so the whole store flow is testable before you have keys.
 * Swap in real credentials and the client code does not change.
 */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$a = req_str('a');

/* ------------------------------------------------------------------ *
 *  Grant gems — the ONE place money becomes game value.
 *  Idempotent on idem_key, so a retried webhook can never double-grant.
 * ------------------------------------------------------------------ */
function grant_pack(int $uid, string $packId, string $idemKey, ?string $txHash, string $provider, string $status = 'paid'): array
{
    $pack = null;
    foreach (Balance::packs() as $p) {
        if ($p['id'] === $packId) { $pack = $p; break; }
    }
    if (!$pack) {
        return ['ok' => false, 'error' => 'unknown_pack'];
    }
    return fi_tx(function (PDO $pdo) use ($uid, $pack, $packId, $idemKey, $txHash, $provider, $status) {
        // already processed?
        $st = $pdo->prepare('SELECT id, status, gems FROM payments WHERE idem_key = ?');
        $st->execute([$idemKey]);
        $prev = $st->fetch();
        if ($prev && $prev['status'] === 'paid') {
            return ['ok' => true, 'duplicate' => true, 'gems' => (int)$prev['gems']];
        }
        if ($prev) {
            $pdo->prepare('UPDATE payments SET status = ?, tx_hash = ?, paid_at = ? WHERE id = ?')
                ->execute([$status, $txHash, time(), (int)$prev['id']]);
        } else {
            $pdo->prepare('INSERT INTO payments(user_id,pack_id,amount_usd,gems,tx_hash,provider,idem_key,status,paid_at)
                           VALUES(?,?,?,?,?,?,?,?,?)')
                ->execute([$uid, $packId, (float)$pack['usd'], (int)$pack['gems'], $txHash, $provider, $idemKey, $status,
                           $status === 'paid' ? time() : null]);
        }
        if ($status !== 'paid') {
            return ['ok' => true, 'pending' => true];
        }
        Game::addCurrency($pdo, $uid, 'gems', (float)$pack['gems'], 'iap', $idemKey);
        Game::grantXp($pdo, $uid, 200);
        fi_event($uid, 'iap_complete', ['pack' => $packId, 'usd' => $pack['usd'], 'gems' => $pack['gems']]);
        return ['ok' => true, 'gems' => (int)$pack['gems'], 'pack' => $packId];
    });
}

/* ------------------------------------------------------------------ */
switch ($a) {

case 'packs':
    json_out(['ok' => true, 'packs' => Balance::packs(), 'provider' => FI_PAY_PROVIDER,
              'coins' => Balance::cfg()['monetization']['coins_accepted'] ?? [],
              'quoteLockMinutes' => Balance::cfg()['monetization']['quote_lock_minutes'] ?? 15]);

case 'create': {
    $me  = require_auth();
    $uid = $me['user_id'];
    $packId = req_str('pack');
    $pack = null;
    foreach (Balance::packs() as $p) {
        if ($p['id'] === $packId) { $pack = $p; break; }
    }
    if (!$pack) {
        api_fail('unknown_pack');
    }
    if (!rate_limit("u:$uid:pay", 10, 3600)) {
        api_fail('too many payment attempts', 429);
    }
    $idem = 'pk_' . $uid . '_' . $packId . '_' . bin2hex(random_bytes(6));

    // record a pending payment row so the webhook can find it
    db()->prepare('INSERT OR IGNORE INTO payments(user_id,pack_id,amount_usd,gems,provider,idem_key,status)
                   VALUES(?,?,?,?,?,?,?)')
        ->execute([$uid, $packId, (float)$pack['usd'], (int)$pack['gems'],
                   FI_PAY_PROVIDER ?: 'demo', $idem, 'pending']);

    if (FI_PAY_PROVIDER === '') {
        // ---- DEMO MODE: no gateway configured ----
        json_out(['ok' => true, 'demo' => true, 'idem' => $idem, 'pack' => $pack,
                  'instructions' => 'Payments are in demo mode. Set FI_PAY_PROVIDER and FI_PAY_API_KEY in api/config.php to go live.']);
    }

    // ---- NOWPayments (invoice API) ----
    if (FI_PAY_PROVIDER === 'nowpayments') {
        $res = fi_http_json('POST', 'https://api.nowpayments.io/v1/invoice', [
            'price_amount'   => (float)$pack['usd'],
            'price_currency' => 'usd',
            'order_id'       => $idem,
            'order_description' => 'Forge Infinite — ' . $pack['label'] . ' (' . $pack['gems'] . ' gems)',
            'ipn_callback_url' => fi_url('/api/pay.php?a=ipn'),
            'success_url'    => fi_url('/?paid=1'),
            'cancel_url'     => fi_url('/?paid=0'),
        ], ['x-api-key: ' . FI_PAY_API_KEY]);
        json_out(['ok' => true, 'idem' => $idem, 'pack' => $pack,
                  'checkout' => $res['invoice_url'] ?? null,
                  'raw' => FI_DEBUG ? $res : null]);
    }

    // ---- CoinGate ----
    if (FI_PAY_PROVIDER === 'coingate') {
        $res = fi_http_json('POST', 'https://api.coingate.com/v2/orders', [
            'price_amount'   => (float)$pack['usd'],
            'price_currency' => 'USD',
            'receive_currency' => 'DO_NOT_CONVERT',
            'order_id'       => $idem,
            'title'          => 'Forge Infinite — ' . $pack['label'],
            'callback_url'   => fi_url('/api/pay.php?a=ipn'),
            'success_url'    => fi_url('/?paid=1'),
            'failure_url'    => fi_url('/?paid=0'),
            'lifetime'       => 900,
        ], ['Authorization: Bearer ' . FI_PAY_API_KEY]);
        json_out(['ok' => true, 'idem' => $idem, 'pack' => $pack,
                  'checkout' => $res['payment_url'] ?? null]);
    }

    api_fail('unsupported_provider');
}

case 'confirm_demo': {
    // DEMO ONLY — reachable solely when FI_PAY_PROVIDER === ''
    if (FI_PAY_PROVIDER !== '') {
        api_fail('demo disabled', 403);
    }
    $me  = require_auth();
    $idem = req_str('idem');
    if ($idem === '' || !preg_match('/^pk_\d+_[a-z]+_[0-9a-f]{12}$/', $idem)) {
        api_fail('bad idem');
    }
    $st = db()->prepare('SELECT user_id, pack_id FROM payments WHERE idem_key = ? AND status = "pending"');
    $st->execute([$idem]);
    $row = $st->fetch();
    if (!$row || (int)$row['user_id'] !== $me['user_id']) {
        api_fail('invoice not found');
    }
    $r = grant_pack($me['user_id'], (string)$row['pack_id'], $idem, 'demo-' . substr(sha1($idem), 0, 16), 'demo');
    json_out(array_merge($r, ['snapshot' => Game::snapshot($me['user_id'])]));
}

case 'ipn': {
    // Provider webhook. Verify the signature, then grant exactly once.
    $raw = file_get_contents('php://input') ?: '';
    $payload = json_decode($raw, true) ?: [];

    if (FI_PAY_PROVIDER === 'nowpayments') {
        $sig = $_SERVER['HTTP_X_NOWPAYMENTS_SIGNATURE'] ?? '';
        $calc = hash_hmac('sha512', $raw, (string)FI_PAY_IPN_SECRET);
        if (!hash_equals($calc, (string)$sig)) {
            fi_event(null, 'ipn_bad_signature', ['ip' => client_ip()]);
            api_fail('bad signature', 403);
        }
        $status = (string)($payload['payment_status'] ?? '');
        if (!in_array($status, ['finished', 'confirmed', 'partially_paid'], true)) {
            json_out(['ok' => true, 'ignored' => $status]);
        }
        $idem = (string)($payload['order_id'] ?? '');
        $packId = '';
        $uid = 0;
        $st = db()->prepare('SELECT user_id, pack_id FROM payments WHERE idem_key = ?');
        $st->execute([$idem]);
        if ($r = $st->fetch()) { $uid = (int)$r['user_id']; $packId = (string)$r['pack_id']; }
        if (!$uid) { api_fail('unknown order', 404); }
        $res = grant_pack($uid, $packId, $idem, (string)($payload['payment_id'] ?? ''), 'nowpayments');
        fi_event($uid, 'ipn_granted', $res);
        json_out(['ok' => true]);
    }

    api_fail('ipn not configured', 501);
}

case 'history': {
    $me = require_auth();
    $st = db()->prepare('SELECT pack_id, amount_usd, gems, status, created_at, tx_hash
                         FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50');
    $st->execute([$me['user_id']]);
    json_out(['ok' => true, 'payments' => $st->fetchAll()]);
}

default:
    api_fail('unknown action');
}

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */
function fi_url(string $path): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $base = rtrim(FI_BASE_URL, '/');
    return $scheme . '://' . $host . $base . $path;
}

function fi_http_json(string $method, string $url, array $body, array $headers = []): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_POSTFIELDS     => json_encode($body),
        CURLOPT_HTTPHEADER     => array_merge(['Content-Type: application/json', 'Accept: application/json'], $headers),
    ]);
    $raw = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false) {
        api_fail('gateway_unreachable: ' . $err, 502);
    }
    $dec = json_decode((string)$raw, true);
    if (!is_array($dec)) {
        api_fail('gateway_bad_response', 502);
    }
    if ($code >= 400) {
        fi_event(null, 'gateway_error', ['code' => $code, 'body' => substr((string)$raw, 0, 500)]);
        api_fail('gateway_error_' . $code, 502);
    }
    return $dec;
}

