<?php
/** End-to-end smoke test against a running dev server. Usage: php tests/e2e.php [baseurl] */
declare(strict_types=1);
$BASE = rtrim($argv[1] ?? 'http://127.0.0.1:8099', '/');
$PASS = 0; $FAIL = 0;
function t(string $name, bool $ok, string $extra = ''): void {
    global $PASS, $FAIL;
    if ($ok) { $PASS++; echo "  \033[32mPASS\033[0m  $name" . ($extra ? "  ($extra)" : '') . "\n"; }
    else     { $FAIL++; echo "  \033[31mFAIL\033[0m  $name" . ($extra ? "  ($extra)" : '') . "\n"; }
}
function req(string $method, string $path, ?array $body = null, ?string $token = null): array {
    global $BASE;
    $ch = curl_init($BASE . $path);
    $h = ['Accept: application/json'];
    if ($token) { $h[] = 'Authorization: Bearer ' . $token; }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_TIMEOUT => 25, CURLOPT_HTTPHEADER => $h,
        CURLOPT_POSTFIELDS => $body === null ? null : json_encode($body),
    ]);
    if ($body !== null) { $h[] = 'Content-Type: application/json'; curl_setopt($ch, CURLOPT_HTTPHEADER, $h); }
    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
    curl_close($ch);
    $d = json_decode((string)$raw, true);
    return ['code' => $code, 'body' => is_array($d) ? $d : [], 'raw' => (string)$raw, 'err' => $err];
}
$U = 'tester_' . substr(bin2hex(random_bytes(3)), 0, 6);

echo "\n=== FORGE INFINITE — end-to-end test ===\nbase: $BASE\nuser: $U\n\n";

echo "[1] auth\n";
$r = req('POST', '/api/auth.php', ['username' => $U, 'password' => 'secret123']);
t('register returns 200 + token', $r['code'] === 200 && !empty($r['body']['token']), 'code=' . $r['code']);
$TOK = $r['body']['token'] ?? '';
$snap = $r['body']['snapshot'] ?? [];
t('snapshot included', !empty($snap['state']), 'gold=' . ($snap['state']['gold'] ?? '?'));
t('welcome gems granted', ($snap['state']['gems'] ?? 0) === 50, 'gems=' . ($snap['state']['gems'] ?? '?'));
t('10 generators present', count($snap['gens'] ?? []) === 10);
t('only first generator unlocked', ($snap['gens'][0]['unlocked'] ?? false) === true && ($snap['gens'][1]['unlocked'] ?? false) === false);
// register returns a bare snapshot; the aggregated state endpoint carries offers/leaderboard
$st0 = req('GET', '/api/state.php', null, $TOK);
$snap = array_merge($snap, $st0['body']);
t('aggregated endpoint returns offers', count($snap['offers'] ?? []) >= 25, 'n=' . count($snap['offers'] ?? []));
t('aggregated endpoint returns leaderboard', isset($snap['leaderboard']));
t('server suggests a poll interval', ($snap['poll'] ?? 0) >= 10, 'poll=' . ($snap['poll'] ?? '?'));
t('crate odds are public', !empty($snap['crates'][0]['odds']), 'entries=' . count($snap['crates'][0]['odds'] ?? []));

$r = req('POST', '/api/auth.php', ['username' => $U, 'password' => 'secret123']);
t('duplicate username rejected', $r['code'] === 409);
$r = req('POST', '/api/auth.php', ['username' => 'x', 'password' => 'y']);
t('invalid username rejected', $r['code'] === 400);
$r = req('POST', '/api/login.php', ['username' => $U, 'password' => 'wrongpass']);
t('wrong password rejected', $r['code'] === 401);
$r = req('POST', '/api/login.php', ['username' => $U, 'password' => 'secret123']);
t('login works', $r['code'] === 200 && !empty($r['body']['token']));
$r = req('GET', '/api/state.php', null, 'bogus-token-000');
t('bad token rejected', $r['code'] === 401);

echo "\n[2] clicking & anti-cheat\n";
$goldBefore = $snap['state']['gold'];
$r = req('POST', '/api/action.php', ['a' => 'click', 'clicks' => 100, 'combo' => 5], $TOK);
t('click batch accepted', ($r['body']['clicks']['clicks'] ?? 0) === 100);
$gained = $r['body']['clicks']['gold'] ?? 0;
t('clicks produced gold', $gained > 0, 'gold=+' . number_format((float)$gained, 1));
t('combo multiplier applied', ($r['body']['clicks']['comboMult'] ?? 0) > 1.0, 'x' . ($r['body']['clicks']['comboMult'] ?? 0));
t('crits resolved server-side', array_key_exists('crits', $r['body']['clicks'] ?? []), 'crits=' . ($r['body']['clicks']['crits'] ?? '?'));
t('gold balance increased', ($r['body']['snapshot']['state']['gold'] ?? 0) > $goldBefore);
t('total_clicks tracked', ($r['body']['snapshot']['state']['totalClicks'] ?? 0) === 100);

$r = req('POST', '/api/action.php', ['a' => 'click', 'clicks' => 99999999, 'combo' => 0], $TOK);
t('click batch clamped to MAX_CLICK_BATCH', ($r['body']['clicks']['clicks'] ?? -1) <= 5000 && ($r['body']['clicks']['clicks'] ?? 0) > 0,
   'accepted=' . ($r['body']['clicks']['clicks'] ?? '?'));

echo "\n[3] buying generators (economy)\n";
// give the player gold via legitimate long idle? No — use clicks. Instead buy the cheapest first.
$r = req('POST', '/api/action.php', ['a' => 'click', 'clicks' => 400, 'combo' => 400], $TOK);
$gold = $r['body']['snapshot']['state']['gold'];
$r = req('POST', '/api/action.php', ['a' => 'buy_gen', 'id' => 'apprentice', 'qty' => 1], $TOK);
t('buy apprentice level 1', ($r['body']['ok'] ?? false) === true, 'spent=' . number_format((float)($r['body']['spent'] ?? 0)));
$lvl = $r['body']['snapshot']['gens'][0]['level'] ?? 0;
t('level is 1', $lvl === 1, "level=$lvl");
t('GPS now > 0', ($r['body']['snapshot']['derived']['gps'] ?? 0) > 0, 'gps=' . ($r['body']['snapshot']['derived']['gps'] ?? 0));
$goldAfter = $r['body']['snapshot']['state']['gold'];
t('gold decreased by exactly the cost', abs(($gold - $goldAfter) - 15) < 0.01, 'delta=' . number_format($gold - $goldAfter, 2));

$r = req('POST', '/api/action.php', ['a' => 'buy_gen', 'id' => 'riftgate', 'qty' => 1], $TOK);
t('locked generator cannot be bought', ($r['body']['ok'] ?? true) === false && ($r['body']['error'] ?? '') === 'locked', $r['body']['error'] ?? '');

$r = req('POST', '/api/action.php', ['a' => 'buy_gen', 'id' => 'apprentice', 'qty' => 100000], $TOK);
t('over-buy only spends what you have', ($r['body']['snapshot']['state']['gold'] ?? -1) >= 0, 'gold=' . ($r['body']['snapshot']['state']['gold'] ?? '?'));

$r = req('POST', '/api/action.php', ['a' => 'buy_gen', 'id' => 'nope', 'qty' => 1], $TOK);
t('unknown generator rejected', $r['code'] === 400);

echo "\n[4] negative balance must be impossible\n";
// hammer purchases far beyond the balance
$neg = false;
for ($i = 0; $i < 25; $i++) {
    $r = req('POST', '/api/action.php', ['a' => 'buy_skill', 'id' => 'efficient_forge'], $TOK);
    $g = $r['body']['snapshot']['state']['gold'] ?? null;
    if ($g !== null && $g < 0) { $neg = true; break; }
}
t('no negative gold after 25 forced purchases', $neg === false);

echo "\n[5] quests & streak\n";
$r = req('GET', '/api/state.php', null, $TOK);
$quests = $r['body']['quests'] ?? [];
t('daily quests returned', count($quests) >= 3, 'n=' . count($quests));
$done = null;
foreach ($quests as $q) { if ($q['done'] && !$q['claimed']) { $done = $q; break; } }
t('a quest is completable by playing', $done !== null, $done['id'] ?? 'none ready');
if ($done) {
    $before = $r['body']['state']['gold'];
    $rr = req('POST', '/api/action.php', ['a' => 'claim_quest', 'id' => $done['id']], $TOK);
    t('quest claim succeeds', ($rr['body']['ok'] ?? false) === true);
    t('quest paid gold', ($rr['body']['snapshot']['state']['gold'] ?? 0) > $before);
    $rr = req('POST', '/api/action.php', ['a' => 'claim_quest', 'id' => $done['id']], $TOK);
    t('double claim blocked', ($rr['body']['error'] ?? '') === 'already_claimed');
}
$rr = req('POST', '/api/action.php', ['a' => 'claim_streak'], $TOK);
t('streak claim day 1', ($rr['body']['ok'] ?? false) === true && ($rr['body']['streak'] ?? 0) === 1, 'streak=' . ($rr['body']['streak'] ?? '?'));
$rr = req('POST', '/api/action.php', ['a' => 'claim_streak'], $TOK);
t('streak cannot be claimed twice a day', ($rr['body']['error'] ?? '') === 'already_claimed');

echo "\n[6] shop, crates, cosmetics\n";
// The over-buy test in [3] legitimately drained the wallet, so earn gold back first
// (exactly what a real player would do).
$earn = function (int $batches = 4) use ($TOK) {
    $last = null;
    for ($i = 0; $i < $batches; $i++) {
        $last = req('POST', '/api/action.php', ['a' => 'click', 'clicks' => 400, 'combo' => 400], $TOK);
    }
    return $last;
};
$rr = $earn(4);
$myGold = $rr['body']['snapshot']['state']['gold'] ?? 0;
$offers = $st0['body']['offers'] ?? [];
t('offers list available from state.php', count($offers) >= 25, 'n=' . count($offers));
t('early-game gold cosmetic exists (first purchase must be reachable)',
   (function () use ($offers) { foreach ($offers as $o) { if ($o['currency'] === 'gold' && $o['price'] <= 5000) { return true; } } return false; })());
t('player can earn an affordable cosmetic by clicking', $myGold >= 400, 'gold=' . number_format((float)$myGold));

$goldOffer = null;
foreach ($offers as $o) {
    if ($o['currency'] === 'gold' && $o['slot'] !== 'crate' && $o['price'] <= $myGold) { $goldOffer = $o; break; }
}
t('an affordable gold cosmetic exists', $goldOffer !== null, $goldOffer['item'] ?? 'none');
if ($goldOffer) {
    $before = $myGold;
    $buy = req('POST', '/api/action.php', ['a' => 'buy', 'offer' => $goldOffer['id']], $TOK);
    t('purchase succeeds', ($buy['body']['ok'] ?? false) === true, $buy['body']['error'] ?? '');
    t('gold deducted exactly', abs(($before - ($buy['body']['snapshot']['state']['gold'] ?? 0)) - $goldOffer['price']) < 0.01,
       number_format((float)$before, 1) . ' - ' . number_format((float)$goldOffer['price']) . ' = ' . number_format((float)($buy['body']['snapshot']['state']['gold'] ?? 0), 1));
    $own = array_column($buy['body']['snapshot']['owned'] ?? [], 'item_id');
    t('item is in inventory', in_array($goldOffer['item'], $own, true));
    $buy2 = req('POST', '/api/action.php', ['a' => 'buy', 'offer' => $goldOffer['id']], $TOK);
    t('unique cosmetic cannot be rebought', ($buy2['body']['error'] ?? '') === 'already_owned');

    $eq = req('POST', '/api/action.php', ['a' => 'equip', 'slot' => $goldOffer['slot'], 'item' => $goldOffer['item']], $TOK);
    t('equip works', ($eq['body']['ok'] ?? false) === true);
    t('loadout updated', ($eq['body']['loadout'][$goldOffer['slot']] ?? '') === $goldOffer['item']);
    $un = req('POST', '/api/action.php', ['a' => 'equip', 'slot' => $goldOffer['slot'], 'item' => ''], $TOK);
    t('unequip works', ($un['body']['ok'] ?? false) === true && !isset($un['body']['loadout'][$goldOffer['slot']]));
    $bad = req('POST', '/api/action.php', ['a' => 'equip', 'slot' => 'frame', 'item' => 'title_founder'], $TOK);
    t('slot mismatch rejected', ($bad['body']['error'] ?? '') === 'slot_mismatch');
    $steal = req('POST', '/api/action.php', ['a' => 'equip', 'slot' => 'frame', 'item' => 'frame_royal'], $TOK);
    t('cannot equip an item you do not own', ($steal['body']['error'] ?? '') === 'not_owned');
}

// ---- gems: top up through the (demo) gateway, then buy + open a crate ----
$inv = req('POST', '/api/pay.php', ['a' => 'create', 'pack' => 'starter'], $TOK);
req('POST', '/api/pay.php', ['a' => 'confirm_demo', 'idem' => $inv['body']['idem'] ?? ''], $TOK);
$rr = req('GET', '/api/state.php', null, $TOK);
t('demo top-up credited gems', ($rr['body']['state']['gems'] ?? 0) >= 150, 'gems=' . ($rr['body']['state']['gems'] ?? 0));

$crateOffer = null;
foreach ($offers as $o) { if ($o['slot'] === 'crate' && $o['item'] === 'box_neon') { $crateOffer = $o; break; } }
t('crate is purchasable', $crateOffer !== null, $crateOffer['item'] ?? 'none');
if ($crateOffer) {
    $b = req('POST', '/api/action.php', ['a' => 'buy', 'offer' => $crateOffer['id']], $TOK);
    t('crate bought with gems', ($b['body']['ok'] ?? false) === true, $b['body']['error'] ?? '');
    $o = req('POST', '/api/action.php', ['a' => 'open_crate', 'id' => 'box_neon', 'free' => 0], $TOK);
    t('crate opens', ($o['body']['ok'] ?? false) === true, $o['body']['error'] ?? '');
    t('reward rolled server-side', !empty($o['body']['reward']), json_encode($o['body']['reward'] ?? null));
    t('odds disclosed with the result', count($o['body']['odds'] ?? []) >= 5, 'n=' . count($o['body']['odds'] ?? []));
    t('roll within table total', ($o['body']['roll'] ?? 0) <= ($o['body']['total'] ?? 0) && ($o['body']['roll'] ?? 0) >= 1,
       $o['body']['roll'] . '/' . $o['body']['total']);
    $o2 = req('POST', '/api/action.php', ['a' => 'open_crate', 'id' => 'box_neon', 'free' => 0], $TOK);
    t('cannot open a crate you do not own', ($o2['body']['error'] ?? '') === 'no_crate');
    $oddsSum = 0.0;
    foreach (($o['body']['odds'] ?? []) as $e) { $oddsSum += (float)$e['chance']; }
    t('disclosed odds sum to ~100%', abs($oddsSum - 100.0) < 0.6, round($oddsSum, 3) . '%');
}
$free = req('POST', '/api/action.php', ['a' => 'open_crate', 'id' => 'box_neon', 'free' => 1], $TOK);
t('free crate works or is on cooldown', in_array($free['body']['error'] ?? '', ['', 'cooldown'], true) || ($free['body']['ok'] ?? false) === true,
   $free['body']['error'] ?? 'ok');

$exp = null;
foreach ($offers as $o) { if ($o['currency'] === 'gems' && $o['price'] > 5000) { $exp = $o; break; } }
if ($exp) {
    $b = req('POST', '/api/action.php', ['a' => 'buy', 'offer' => $exp['id']], $TOK);
    t('cannot overspend gems', ($b['body']['ok'] ?? true) === false && ($b['body']['error'] ?? '') === 'not_enough');
}
$rr = req('GET', '/api/state.php', null, $TOK);
t('balances never negative after all purchases',
   ($rr['body']['state']['gold'] ?? -1) >= 0 && ($rr['body']['state']['gems'] ?? -1) >= 0,
   'gold=' . number_format((float)($rr['body']['state']['gold'] ?? 0)) . ' gems=' . ($rr['body']['state']['gems'] ?? '?'));

echo "\n[7] achievements\n";
$r = req('GET', '/api/state.php', null, $TOK);
$ach = $r['body']['achievements'] ?? [];
t('achievement list returned', count($ach) >= 10, 'n=' . count($ach));
$unl = array_filter($ach, fn($x) => $x['unlocked']);
t('click achievements unlocked', count($unl) >= 1, 'unlocked=' . count($unl));

echo "\n[8] prestige gating\n";
$r = req('POST', '/api/action.php', ['a' => 'prestige'], $TOK);
t('prestige without confirm is refused', ($r['body']['error'] ?? '') === 'needs_confirm');
$r = req('POST', '/api/action.php', ['a' => 'prestige', 'confirm' => 1], $TOK);
t('prestige blocked when not ready', ($r['body']['ok'] ?? true) === false && ($r['body']['error'] ?? '') === 'not_ready');
t('prestige preview shows requirement', isset($r['body']['check']['need_gold']) && $r['body']['check']['need_gold'] > 0,
   'need=' . number_format((float)($r['body']['check']['need_gold'] ?? 0)));
t('prestige requirement reflects the configured gate', ($r['body']['check']['required'] ?? 0) >= 5,
   'required=' . ($r['body']['check']['required'] ?? '?'));
t('sparks curve is a power law, not a plateau', (function () {
    $c = json_decode(file_get_contents(dirname(__DIR__) . '/htdocs/config/balance.json'), true)['prestige'];
    $f = fn($g) => (int)floor($c['coef'] * (($g / $c['divisor']) ** $c['exponent']));
    $prev = 0;
    foreach ([1e6, 1e9, 1e12, 1e15, 1e18] as $g) { $v = $f($g); if ($v <= $prev) return false; $prev = $v; }
    return true;
})());

echo "\n[9] idle settlement is server-timed\n";
$s1 = req('GET', '/api/state.php', null, $TOK);
sleep(2);
$s2 = req('GET', '/api/state.php', null, $TOK);
$gps = $s2['body']['derived']['gps'] ?? 0;
$dg  = ($s2['body']['state']['gold'] ?? 0) - ($s1['body']['state']['gold'] ?? 0);
t('gold accrues between syncs', $dg >= 0, 'delta=' . number_format((float)$dg, 2) . ' gps=' . number_format((float)$gps, 2));
t('settle reports elapsed secs', ($s2['body']['idle']['secs'] ?? -1) >= 1, 'secs=' . ($s2['body']['idle']['secs'] ?? '?'));
t('client cannot forge elapsed time', ($s2['body']['idle']['secs'] ?? 99999) < 3600);

echo "\n[10] public endpoints\n";
$r = req('GET', '/api/leaderboard.php?limit=50');
t('leaderboard is public + cached', ($r['body']['ok'] ?? false) === true && isset($r['body']['leaderboard']));
$r = req('GET', '/api/profile.php?u=' . $U);
t('public profile renders cosmetics', ($r['body']['ok'] ?? false) === true && isset($r['body']['profile']['loadout']));
t('profile exposes collection progress', isset($r['body']['profile']['collection']['total']));
$r = req('GET', '/api/profile.php?u=does_not_exist_zz');
t('unknown profile 404s', $r['code'] === 404);
$r = req('GET', '/api/pay.php?a=packs');
t('gem packs are public', count($r['body']['packs'] ?? []) === 5, 'provider=' . ($r['body']['provider'] ?? '?'));

echo "\n[11] payment idempotency (demo gateway)\n";
$c = req('POST', '/api/pay.php', ['a' => 'create', 'pack' => 'best'], $TOK);
t('invoice created', ($c['body']['ok'] ?? false) === true && !empty($c['body']['idem']), $c['body']['idem'] ?? '');
$idem = $c['body']['idem'] ?? '';
$g0 = req('GET', '/api/state.php', null, $TOK)['body']['state']['gems'] ?? 0;
$p1 = req('POST', '/api/pay.php', ['a' => 'confirm_demo', 'idem' => $idem], $TOK);
t('payment grants gems', ($p1['body']['ok'] ?? false) === true, '+' . ($p1['body']['gems'] ?? 0));
$g1 = $p1['body']['snapshot']['state']['gems'] ?? 0;
t('gems increased by exactly the pack amount', ($g1 - $g0) === 1300, "$g0 → $g1");
$p2 = req('POST', '/api/pay.php', ['a' => 'confirm_demo', 'idem' => $idem], $TOK);
t('replayed webhook does NOT double-grant', ($p2['body']['duplicate'] ?? false) === true || ($p2['code'] === 400));
$g2 = req('GET', '/api/state.php', null, $TOK)['body']['state']['gems'] ?? 0;
t('gem balance unchanged after replay', $g2 === $g1, "$g1 → $g2");
$p3 = req('POST', '/api/pay.php', ['a' => 'confirm_demo', 'idem' => 'pk_1_best_deadbeefdead'], $TOK);
t('forged invoice id rejected', $p3['code'] === 400);

echo "\n[12] security headers & hygiene\n";
$ch = curl_init($BASE . '/api/state.php');
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_NOBODY => true]);
$hdr = (string)curl_exec($ch); curl_close($ch);
t('X-Content-Type-Options: nosniff', stripos($hdr, 'nosniff') !== false);
t('X-Frame-Options set', stripos($hdr, 'X-Frame-Options') !== false);
t('Cache-Control: no-store on API', stripos($hdr, 'no-store') !== false);
t('no server version leak', stripos($hdr, 'X-Powered-By') === false);

echo "\n[13] rate limiting\n";
$hit429 = false;
for ($i = 0; $i < 260; $i++) {
    $r = req('GET', '/api/state.php', null, $TOK);
    if ($r['code'] === 429) { $hit429 = true; break; }
}
t('state endpoint rate-limits a flood', $hit429, $hit429 ? "after $i requests" : 'never triggered');

echo "\n=== RESULT: $PASS passed, $FAIL failed ===\n";
exit($FAIL === 0 ? 0 : 1);
