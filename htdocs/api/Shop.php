<?php
/**
 * FORGE INFINITE — Shop, crates and cosmetics.
 *
 * Compliance rules baked into the code (GDD §13):
 *  • items sold for real money have power_effect = 0 — asserted on seed
 *  • crate contents obtained with PAID currency are flagged non-tradable
 *  • crate odds are always returned to the client
 */
declare(strict_types=1);

final class Shop
{
    /* ---------------------------------------------------------------- *
     *  Seed the catalogue from balance.json (idempotent)
     * ---------------------------------------------------------------- */
    public static function seedContent(PDO $pdo): void
    {
        // items
        $ins = $pdo->prepare('INSERT INTO items(id,name,slot,rarity,tradable,power_effect,css_json,edition_left)
                              VALUES(?,?,?,?,?,?,?,?)
                              ON CONFLICT(id) DO UPDATE SET name=excluded.name, slot=excluded.slot,
                                rarity=excluded.rarity, tradable=excluded.tradable, css_json=excluded.css_json');
        foreach (Balance::catalog() as $id => $it) {
            // HARD RULE: cosmetics never carry power.
            $ins->execute([
                $id, $it['name'], $it['slot'], $it['rarity'],
                (int)($it['tradable'] ?? 1), 0.0,
                json_encode($it['css'] ?? null, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                isset($it['css']['edition']) ? (int)$it['css']['edition'] : null,
            ]);
        }

        // shop offers: one per priced catalogue item (crates are added separately)
        $pdo->exec('DELETE FROM shop_offers WHERE item_id NOT IN (SELECT id FROM items)');
        $exists = $pdo->prepare('SELECT 1 FROM shop_offers WHERE item_id = ?');
        $addOffer = $pdo->prepare('INSERT INTO shop_offers(item_id,currency,price,stock_total,stock_left,featured,sort_order)
                                   VALUES(?,?,?,?,?,?,?)');
        $n = 0;
        foreach (Balance::catalog() as $id => $it) {
            if (!empty($it['css']['achievement'])) {
                continue;                       // earned, never sold
            }
            $cur = null; $price = null;
            if (!empty($it['price_gems'])) { $cur = 'gems'; $price = (int)$it['price_gems']; }
            elseif (!empty($it['price_gold'])) { $cur = 'gold'; $price = (int)$it['price_gold']; }
            if ($cur === null) { continue; }

            $exists->execute([$id]);
            if ($exists->fetchColumn()) { continue; }

            $stock = isset($it['css']['edition']) ? (int)$it['css']['edition'] : null;
            $addOffer->execute([$id, $cur, $price, $stock, $stock,
                ($it['rarity'] === 'legendary' || $it['rarity'] === 'limited') ? 1 : 0, ++$n]);
        }

        // crates as purchasable offers (item rows with slot 'crate')
        foreach (Balance::crates() as $cid => $crate) {
            $pdo->prepare('INSERT OR IGNORE INTO items(id,name,slot,rarity,tradable,power_effect)
                           VALUES(?,?,?,\'rare\',0,0)')->execute([$cid, $crate['name'], 'crate']);
            $exists->execute([$cid]);
            if (!$exists->fetchColumn() && !empty($crate['price_gems'])) {
                $addOffer->execute([$cid, 'gems', (int)$crate['price_gems'], null, null, 1, 100 + $n]);
            }
        }

        // loot tables
        $pdo->exec('DELETE FROM loot_entries');
        $li = $pdo->prepare('INSERT INTO loot_entries(table_id,item_id,weight) VALUES(?,?,?)');
        foreach (Balance::crates() as $cid => $crate) {
            foreach ($crate['entries'] as $e) {
                $li->execute([$cid, (string)$e[0], (int)$e[1]]);
            }
        }

        // achievements
        $ai = $pdo->prepare('INSERT INTO achievements(id,name,desc_t,metric,target,reward_json,tier)
                             VALUES(?,?,?,?,?,?,?)
                             ON CONFLICT(id) DO UPDATE SET name=excluded.name, desc_t=excluded.desc_t,
                               target=excluded.target, reward_json=excluded.reward_json');
        foreach (Balance::achievements() as $a) {
            $ai->execute([$a['id'], $a['name'], $a['desc'], $a['metric'], (int)$a['target'],
                          json_encode($a['reward'] ?? [], JSON_UNESCAPED_UNICODE), (int)($a['tier'] ?? 1)]);
        }
    }

    /* ---------------------------------------------------------------- *
     *  Purchase an offer
     * ---------------------------------------------------------------- */
    public static function buy(int $uid, int $offerId): array
    {
        return fi_tx(function (PDO $pdo) use ($uid, $offerId) {
            $now = time();
            $st = $pdo->prepare('SELECT o.*, i.slot, i.rarity, i.name, i.edition_left, i.tradable
                                 FROM shop_offers o JOIN items i ON i.id = o.item_id
                                 WHERE o.id = ? AND o.is_active = 1
                                   AND (o.ends_at IS NULL OR o.ends_at > ?)
                                   AND (o.stock_left IS NULL OR o.stock_left > 0)');
            $st->execute([$offerId, $now]);
            $offer = $st->fetch();
            if (!$offer) {
                return ['ok' => false, 'error' => 'offer_unavailable'];
            }
            $itemId = (string)$offer['item_id'];

            // Crates are consumable — everything else is a unique cosmetic.
            if ($offer['slot'] !== 'crate') {
                $dup = $pdo->prepare('SELECT 1 FROM player_items WHERE user_id = ? AND item_id = ?');
                $dup->execute([$uid, $itemId]);
                if ($dup->fetchColumn()) {
                    return ['ok' => false, 'error' => 'already_owned'];
                }
            }

            $cur   = (string)$offer['currency'];
            $price = (float)$offer['price'];
            $bal   = Game::balanceOf($pdo, $uid, $cur);
            if ($bal + 1e-9 < $price) {
                return ['ok' => false, 'error' => 'not_enough', 'need' => $price, 'have' => $bal];
            }
            if (Game::addCurrency($pdo, $uid, $cur, -$price, 'shop_buy', (string)$offerId) === null) {
                return ['ok' => false, 'error' => 'not_enough'];
            }

            // Paid-crate contents must not be tradable (GDD §13 R2)
            $tradable = $cur === 'gems' ? 0 : (int)$offer['tradable'];

            Game::grantItem($pdo, $uid, $itemId, $cur === 'gems' ? 'iap_gems' : 'shop');
            $pdo->prepare('UPDATE player_items SET source = ? WHERE user_id = ? AND item_id = ?')
                ->execute([$cur === 'gems' ? 'gems' : 'gold', $uid, $itemId]);

            if ($offer['stock_left'] !== null) {
                $pdo->prepare('UPDATE shop_offers SET stock_left = MAX(0, stock_left - 1) WHERE id = ?')
                    ->execute([$offerId]);
                $pdo->prepare('UPDATE items SET edition_left = MAX(0, COALESCE(edition_left,1) - 1) WHERE id = ?')
                    ->execute([$itemId]);
            }

            Game::bumpCounter($pdo, $uid, 'spent_' . $cur, (int)$price);
            Game::bumpCounter($pdo, $uid, 'buys', 1);
            Game::grantXp($pdo, $uid, 15);
            fi_event($uid, 'shop_buy', ['item' => $itemId, 'cur' => $cur, 'price' => $price]);
            Game::checkAchievements($pdo, $uid);

            return ['ok' => true, 'item' => $itemId, 'name' => $offer['name'],
                    'rarity' => $offer['rarity'], 'slot' => $offer['slot'],
                    'tradable' => $tradable, 'spent' => ['cur' => $cur, 'amount' => $price]];
        });
    }

    /* ---------------------------------------------------------------- *
     *  Open a crate (owned, or the free cooldown one)
     * ---------------------------------------------------------------- */
    public static function openCrate(int $uid, string $crateId, bool $useFree = false): array
    {
        $crate = Balance::crate($crateId);
        if (!$crate) {
            return ['ok' => false, 'error' => 'unknown_crate'];
        }
        $cooldown = (int)($crate['free_cooldown_hours'] ?? 0) * 3600;

        return fi_tx(function (PDO $pdo) use ($uid, $crateId, $crate, $cooldown, $useFree) {
            $now = time();
            $state = Game::loadState($uid);

            if ($useFree) {
                if ($cooldown <= 0) {
                    return ['ok' => false, 'error' => 'no_free_crate'];
                }
                if ((int)$state['last_free_crate'] + $cooldown > $now) {
                    return ['ok' => false, 'error' => 'cooldown',
                            'ready_in' => (int)$state['last_free_crate'] + $cooldown - $now];
                }
                $pdo->prepare('UPDATE player_state SET last_free_crate = ? WHERE user_id = ?')
                    ->execute([$now, $uid]);
            } else {
                // must own at least one crate item to consume
                $st = $pdo->prepare('SELECT qty FROM player_items WHERE user_id = ? AND item_id = ?');
                $st->execute([$uid, $crateId]);
                $qty = (int)$st->fetchColumn();
                if ($qty <= 0) {
                    return ['ok' => false, 'error' => 'no_crate'];
                }
                $pdo->prepare('UPDATE player_items SET qty = qty - 1 WHERE user_id = ? AND item_id = ?')
                    ->execute([$uid, $crateId]);
                $pdo->prepare('DELETE FROM player_items WHERE user_id = ? AND item_id = ? AND qty <= 0')
                    ->execute([$uid, $crateId]);
            }

            $sl     = Game::skillLevels($uid);
            $owned  = Game::ownedIds($uid);
            $roll   = Balance::rollCrate($crateId, $owned, Balance::dropBonus($sl));
            $itemId = $roll['item_id'];
            $item   = $itemId ? Balance::item($itemId) : null;

            $result = ['ok' => true, 'free' => $useFree, 'crate' => $crateId,
                       'roll' => $roll['roll'], 'total' => $roll['total'], 'odds' => Balance::crateOdds($crateId)];

            if (!$item) {
                $result['reward'] = ['type' => 'gold', 'amount' => 0];
                return $result;
            }

            // duplicate → converted to gold at dupe_gold_pct of shop value
            if (in_array($itemId, $owned, true)) {
                $pct  = (float)($crate['dupe_gold_pct'] ?? 25);
                $val  = (float)($item['price_gold'] ?? 0) ?: ((float)($item['price_gems'] ?? 0) * 25000.0);
                $gold = max(1000.0, $val * $pct / 100.0);
                Game::addCurrency($pdo, $uid, 'gold', $gold, 'crate_dupe', $itemId);
                $result['reward'] = ['type' => 'dupe', 'item' => $itemId, 'name' => $item['name'],
                                     'rarity' => $item['rarity'], 'gold' => $gold];
            } else {
                Game::grantItem($pdo, $uid, $itemId, $useFree ? 'free_crate' : 'crate');
                // R2: paid crate contents are not tradable
                if (!$useFree) {
                    $pdo->prepare('UPDATE player_items SET source = ? WHERE user_id = ? AND item_id = ?')
                        ->execute(['paid_crate', $uid, $itemId]);
                    $pdo->prepare('UPDATE items SET tradable = 0 WHERE id = ?')->execute([$itemId]);
                }
                $result['reward'] = ['type' => 'item', 'item' => $itemId, 'name' => $item['name'],
                                     'rarity' => $item['rarity'], 'slot' => $item['slot'],
                                     'css' => $item['css'] ?? null, 'new' => true];
            }

            Game::bumpCounter($pdo, $uid, 'crates', 1);
            Game::grantXp($pdo, $uid, 25);
            fi_event($uid, 'crate_open', ['crate' => $crateId, 'item' => $itemId, 'free' => $useFree]);
            Game::checkAchievements($pdo, $uid);
            return $result;
        });
    }

    /* ---------------------------------------------------------------- *
     *  Equip / unequip a cosmetic
     * ---------------------------------------------------------------- */
    public static function equip(int $uid, string $slot, ?string $itemId): array
    {
        $slots = Balance::slots();
        if (!in_array($slot, $slots, true)) {
            return ['ok' => false, 'error' => 'bad_slot'];
        }
        if ($itemId !== null) {
            $item = Balance::item($itemId);
            if (!$item) {
                return ['ok' => false, 'error' => 'unknown_item'];
            }
            if ($item['slot'] !== $slot) {
                return ['ok' => false, 'error' => 'slot_mismatch'];
            }
            $st = db()->prepare('SELECT 1 FROM player_items WHERE user_id = ? AND item_id = ?');
            $st->execute([$uid, $itemId]);
            if (!$st->fetchColumn()) {
                return ['ok' => false, 'error' => 'not_owned'];
            }
        }
        return fi_tx(function (PDO $pdo) use ($uid, $slot, $itemId) {
            $st = $pdo->prepare('SELECT loadout_json FROM player_state WHERE user_id = ?');
            $st->execute([$uid]);
            $loadout = json_decode((string)($st->fetchColumn() ?: '{}'), true) ?: [];
            if ($itemId === null) {
                unset($loadout[$slot]);
            } else {
                $loadout[$slot] = $itemId;
            }
            $pdo->prepare('UPDATE player_state SET loadout_json = ?, updated_at = ? WHERE user_id = ?')
                ->execute([json_encode($loadout, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), time(), $uid]);
            fi_event($uid, 'equip', ['slot' => $slot, 'item' => $itemId]);
            return ['ok' => true, 'loadout' => $loadout];
        });
    }

    /* ---------------------------------------------------------------- *
     *  Offers list for the client
     * ---------------------------------------------------------------- */
    /** Global (user-independent) offer list — safe to cache across players.
     *  Ownership is resolved on the client from snapshot.owned. */
    public static function offers(): array
    {
        $now = time();
        $st = db()->prepare('SELECT o.id, o.item_id, o.currency, o.price, o.stock_left, o.ends_at, o.featured,
                                    i.name, i.slot, i.rarity, i.css_json, i.edition_left
                             FROM shop_offers o JOIN items i ON i.id = o.item_id
                             WHERE o.is_active = 1 AND (o.ends_at IS NULL OR o.ends_at > ?)
                               AND (o.stock_left IS NULL OR o.stock_left > 0)
                             ORDER BY o.featured DESC, o.sort_order ASC, o.price ASC');
        $st->execute([$now]);
        $out = [];
        foreach ($st as $r) {
            $out[] = [
                'id' => (int)$r['id'], 'item' => $r['item_id'], 'name' => $r['name'],
                'slot' => $r['slot'], 'rarity' => $r['rarity'],
                'css' => json_decode((string)($r['css_json'] ?: 'null'), true),
                'currency' => $r['currency'], 'price' => (float)$r['price'],
                'stockLeft' => $r['stock_left'] === null ? null : (int)$r['stock_left'],
                'endsAt' => $r['ends_at'] === null ? null : (int)$r['ends_at'],
                'featured' => (bool)$r['featured'],
            ];
        }
        return $out;
    }
}
