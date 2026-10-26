<?php
/**
 * DEV ONLY — seeds 35 days of realistic fake analytics so the admin panel
 * charts (economy from `ledger`, retention from `events`) have data to show
 * before real players arrive.
 *
 *   php jobs/seed_demo.php            # refuses if the game already has >5 users
 *   php jobs/seed_demo.php --force    # seed anyway
 *   php jobs/seed_demo.php --purge    # delete every demo_* user and their data
 *
 * ⚠️ DELETE THIS FILE (or purge) before real launch. Demo usernames are
 * prefixed demo_ so they are trivial to identify and remove.
 */
declare(strict_types=1);

// v2: must never be runnable from the web (htdocs layout).
if (PHP_SAPI !== 'cli') { http_response_code(403); header('Content-Type: text/plain; charset=utf-8'); exit('403 — CLI only.'); }

require_once dirname(__DIR__) . '/api/bootstrap.php';

$pdo = db();
$args = $argv ?? [];

if (in_array('--purge', $args, true)) {
    $ids = $pdo->query("SELECT id FROM users WHERE username LIKE 'demo\\_%' ESCAPE '\\'")->fetchAll(PDO::FETCH_COLUMN);
    if (!$ids) { echo "no demo users found\n"; exit(0); }
    $in = implode(',', array_map('intval', $ids));
    $pdo->exec("DELETE FROM events WHERE user_id IN ($in)");
    $pdo->exec("DELETE FROM users WHERE id IN ($in)"); // cascades: state, ledger, payments…
    echo 'purged ' . count($ids) . " demo users\n";
    exit(0);
}

$existing = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE username NOT LIKE 'demo\\_%' ESCAPE '\\'")->fetchColumn();
if ($existing > 5 && !in_array('--force', $args, true)) {
    fwrite(STDERR, "Refusing: $existing real users already exist. Use --force only if you really mean it.\n");
    exit(1);
}

mt_srand(20261026);
$now = time();
$day0 = $now - 35 * 86400;
$hash = password_hash('demo12345', PASSWORD_DEFAULT);

$insUser = $pdo->prepare('INSERT OR IGNORE INTO users(username,pass_hash,created_at,last_seen_at,last_ip) VALUES(?,?,?,?,?)');
$insState = $pdo->prepare('INSERT OR IGNORE INTO player_state(user_id,gold,gems,tokens,level,xp,sparks,prestige_count,run_gold,total_gold,total_clicks,streak_days,last_settle,last_active,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
$insLedger = $pdo->prepare('INSERT INTO ledger(user_id,currency,delta,balance,reason,created_at) VALUES(?,?,?,?,?,?)');
$insEvent = $pdo->prepare('INSERT INTO events(user_id,name,props_json,created_at) VALUES(?,?,?,?)');
$insPay = $pdo->prepare("INSERT INTO payments(user_id,pack_id,amount_usd,gems,provider,idem_key,status,created_at,paid_at) VALUES(?,?,?,?,?,?, 'paid',?,?)");

$names = ['aria','darya','kian','soroush','mitra','omid','nilou','parsa','tara','yasin','baran','kourosh','shirin','arman','diba','farhad','golnar','hirad','iliya','jaleh'];
$created = 0; $ledgerRows = 0; $eventRows = 0;

$pdo->exec('BEGIN IMMEDIATE');
$userCount = 150;
for ($u = 0; $u < $userCount; $u++) {
    // registration day: mild growth curve (more recent registrations)
    $regDay = (int)floor(35 * pow(mt_rand() / mt_getrandmax(), 1.35));
    $regTs = $day0 + $regDay * 86400 + mt_rand(0, 86000);
    $username = 'demo_' . $names[$u % count($names)] . '_' . (1000 + $u);
    $insUser->execute([$username, $hash, $regTs, $regTs, '127.0.0.1']);
    $uid = (int)$pdo->lastInsertId();
    if (!$uid) { continue; }
    $created++;

    // persona: 12% core, 40% casual, 48% trier
    $r = mt_rand(1, 100);
    $persona = $r <= 12 ? 'core' : ($r <= 52 ? 'casual' : 'trier');

    $gold = 0.0; $gems = 50; $tokens = 0; $totalGold = 0.0; $clicks = 0; $xp = 0; $prestiges = 0; $streak = 0;
    $maxDay = 35 - $regDay;
    $insEvent->execute([$uid, 'register', json_encode(['ip' => '127.0.0.1']), $regTs]); $eventRows++;
    $insLedger->execute([$uid, 'gems', 50, 50, 'welcome', $regTs]); $ledgerRows++;

    for ($d = 0; $d <= $maxDay; $d++) {
        $p = match ($persona) {
            'core'   => $d === 0 ? 1.0 : 0.86,
            'casual' => $d === 0 ? 1.0 : max(0.06, 0.62 * pow(0.93, $d)),
            default  => $d === 0 ? 1.0 : max(0.01, 0.34 * pow(0.55, $d)),
        };
        if ((mt_rand() / mt_getrandmax()) > $p) { continue; }

        $ts = $regTs + $d * 86400 + mt_rand(0, 80000);
        if ($ts > $now) { $ts = $now - mt_rand(60, 3600); }
        $streak = min(30, $streak + 1);
        $ageBoost = pow(1.55, $d); // idle economies grow exponentially

        // 1–3 sessions that day
        $sessions = $persona === 'core' ? mt_rand(2, 4) : mt_rand(1, 2);
        for ($s = 0; $s < $sessions; $s++) {
            $insEvent->execute([$uid, 'session_start', json_encode(['gap' => mt_rand(1800, 70000)]), $ts + $s * 5400]); $eventRows++;
        }
        // ledger: idle + clicks (faucet)
        $idle = round((900 + mt_rand(0, 1600)) * $ageBoost);
        $gold += $idle; $totalGold += $idle;
        $insLedger->execute([$uid, 'gold', $idle, $gold, $d % 3 ? 'idle_offline' : 'idle_online', $ts]); $ledgerRows++;
        $clickN = mt_rand(60, 1400); $clicks += $clickN;
        $clickGold = round($clickN * (1.5 + $d * 0.12) * (0.8 + mt_rand(0, 40) / 100));
        $gold += $clickGold; $totalGold += $clickGold;
        $insLedger->execute([$uid, 'gold', $clickGold, $gold, 'click', $ts + 600]); $ledgerRows++;
        // quest / streak rewards
        if (mt_rand(1, 100) <= 55) {
            $q = round((200 + mt_rand(0, 500)) * sqrt($ageBoost));
            $gold += $q; $totalGold += $q; $xp += mt_rand(40, 130);
            $insLedger->execute([$uid, 'gold', $q, $gold, 'quest_daily', $ts + 1200]); $ledgerRows++;
            $insEvent->execute([$uid, 'quest_claim', json_encode(['quest' => 'd_clicks']), $ts + 1200]); $eventRows++;
        }
        // generator purchases (main gold sink) — keeps faucet/sink near ~1.0
        $spendFrac = 0.76 + mt_rand(0, 22) / 100; // → faucet/sink ratio lands in the healthy ~1.0–1.15 band
        $spend = round($gold * $spendFrac);
        if ($spend > 0) {
            $gold -= $spend;
            $insLedger->execute([$uid, 'gold', -$spend, $gold, 'buy_gen', $ts + 1800]); $ledgerRows++;
            $insEvent->execute([$uid, 'buy_gen', json_encode(['gen' => 'g' . mt_rand(1, 10), 'qty' => mt_rand(1, 10), 'gold' => $spend]), $ts + 1800]); $eventRows++;
        }
        // cosmetics spend with gems
        if ($gems >= 120 && mt_rand(1, 100) <= 16) {
            $price = [120, 300, 350, 400, 900][mt_rand(0, 4)];
            if ($gems >= $price) {
                $gems -= $price;
                $insLedger->execute([$uid, 'gems', -$price, $gems, 'shop_buy', $ts + 2400]); $ledgerRows++;
                $insEvent->execute([$uid, 'shop_buy', json_encode(['item' => 'cosmetic_' . mt_rand(1, 31), 'cur' => 'gems', 'price' => $price]), $ts + 2400]); $eventRows++;
            }
        }
        if (mt_rand(1, 100) <= 20) {
            $insEvent->execute([$uid, 'crate_open', json_encode(['crate' => 'supply', 'item' => 'cosmetic_' . mt_rand(1, 31), 'free' => true]), $ts + 3000]); $eventRows++;
        }
        // prestige for older core players
        if ($persona === 'core' && $d > 4 && mt_rand(1, 100) <= 7) {
            $prestiges++;
            $insEvent->execute([$uid, 'prestige', json_encode(['sparks' => $prestiges * mt_rand(3, 9), 'count' => $prestiges]), $ts + 3600]); $eventRows++;
        }
        $lastSeen = $ts;
    }

    // payers: ~5% buy gem packs
    if (mt_rand(1, 100) <= 5) {
        $packs = [['gems_100', 4.99, 100], ['gems_550', 19.99, 550], ['gems_1200', 39.99, 1200]];
        $n = mt_rand(1, 3);
        for ($i = 0; $i < $n; $i++) {
            [$pid_, $usd, $g] = $packs[mt_rand(0, 2)];
            $pts = $regTs + mt_rand(86400, max(90000, $now - $regTs));
            if ($pts > $now) { $pts = $now - mt_rand(3600, 86400); }
            $gems += $g;
            $insPay->execute([$uid, $pid_, $usd, $g, 'demo', 'seed-' . $uid . '-' . $i . '-' . $pts, $pts, $pts]);
            $insLedger->execute([$uid, 'gems', $g, $gems, 'iap', $pts]); $ledgerRows++;
            $insEvent->execute([$uid, 'iap_complete', json_encode(['pack' => $pid_, 'usd' => $usd, 'gems' => $g]), $pts]); $eventRows++;
        }
    }

    $level = max(1, min(60, (int)floor(1 + log(1 + $xp / 100) / log(1.35))));
    $insState->execute([$uid, $gold, $gems, $tokens, $level, $xp, $prestiges * 6, $prestiges,
                        $totalGold, $totalGold, $clicks, $streak, $now, $lastSeen ?? $regTs, $now]);
    $pdo->prepare('UPDATE users SET last_seen_at=? WHERE id=?')->execute([$lastSeen ?? $regTs, $uid]);
}
$pdo->exec('COMMIT');

echo "seeded: $created demo users, $ledgerRows ledger rows, $eventRows event rows (35 days)\n";
echo "open /admin/ to see the charts. Remove with: php jobs/seed_demo.php --purge\n";
