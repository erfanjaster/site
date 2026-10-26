<?php
/**
 * POST api/action.php  {a: "<action>", ...}
 * Single write endpoint. Every mutation goes through fi_tx() (BEGIN IMMEDIATE).
 */
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$me  = require_auth();
$uid = $me['user_id'];

if (!rate_limit("u:$uid:action", FI_RATE_ACTION_PER_MIN, 60)) {
    api_fail('rate limited', 429);
}

$a = req_str('a');
$pdo = db();

try {
    switch ($a) {

    /* ---------------- click batch ---------------- */
    case 'click': {
        $r = Game::processClicks($pdo, $uid, req_int('clicks', 0), req_int('combo', 0));
        json_out(['ok' => true, 'clicks' => $r, 'snapshot' => Game::snapshot($uid)]);
    }

    /* ---------------- buy generator levels ---------------- */
    case 'buy_gen': {
        $id  = req_str('id');
        $qty = max(1, min(1000, req_int('qty', 1)));
        $g   = Balance::gen($id);
        if (!$g) {
            api_fail('unknown generator');
        }
        $res = fi_tx(function (PDO $pdo) use ($uid, $g, $qty) {
            $levels = Game::genLevels($uid);
            if (!Balance::genUnlocked($g['id'], $levels)) {
                return ['ok' => false, 'error' => 'locked'];
            }
            $state = Game::loadState($uid);
            $sl    = Game::skillLevels($uid);
            $red   = Balance::costReduction($sl);
            $lvl   = (int)($levels[$g['id']] ?? 0);

            // geometric sum of the next $qty levels
            $total = 0.0; $bought = 0;
            $gold  = (float)$state['gold'];
            for ($i = 0; $i < $qty; $i++) {
                $c = Balance::genCost($g, $lvl + $i, $red);
                if ($total + $c > $gold + 1e-9) {
                    break;
                }
                $total += $c; $bought++;
            }
            if ($bought === 0) {
                return ['ok' => false, 'error' => 'not_enough',
                        'need' => Balance::genCost($g, $lvl, $red), 'have' => $gold];
            }
            if (Game::addCurrency($pdo, $uid, 'gold', -$total, 'buy_gen', $g['id']) === null) {
                return ['ok' => false, 'error' => 'not_enough'];
            }
            $pdo->prepare('INSERT INTO player_gens(user_id,gen_id,level) VALUES(?,?,?)
                           ON CONFLICT(user_id,gen_id) DO UPDATE SET level = level + excluded.level')
                ->execute([$uid, $g['id'], $bought]);

            Game::bumpCounter($pdo, $uid, 'buys', $bought);
            Game::bumpCounter($pdo, $uid, 'gen_' . $g['id'], $bought);
            $xp = Game::grantXp($pdo, $uid, 10 * $bought * (int)$g['tier']);
            fi_event($uid, 'buy_gen', ['gen' => $g['id'], 'qty' => $bought, 'gold' => $total]);
            Game::checkAchievements($pdo, $uid);
            return ['ok' => true, 'bought' => $bought, 'spent' => $total, 'level' => $lvl + $bought,
                    'levelled' => !empty($xp['levelled']), 'gifts' => $xp['gifts'] ?? []];
        });
        json_out(array_merge($res, ['snapshot' => Game::snapshot($uid)]));
    }

    /* ---------------- buy skill level ---------------- */
    case 'buy_skill': {
        $id = req_str('id');
        $s  = Balance::skill($id);
        if (!$s) {
            api_fail('unknown skill');
        }
        $res = fi_tx(function (PDO $pdo) use ($uid, $s) {
            $sl   = Game::skillLevels($uid);
            $lvl  = (int)($sl[$s['id']] ?? 0);
            if ($lvl >= (int)$s['max']) {
                return ['ok' => false, 'error' => 'maxed'];
            }
            $cost = Balance::skillCost($s, $lvl) * (1 - Balance::costReduction($sl));
            if (Game::addCurrency($pdo, $uid, 'gold', -$cost, 'buy_skill', $s['id']) === null) {
                return ['ok' => false, 'error' => 'not_enough', 'need' => $cost];
            }
            $pdo->prepare('INSERT INTO player_skills(user_id,skill_id,level) VALUES(?,?,?)
                           ON CONFLICT(user_id,skill_id) DO UPDATE SET level = level + 1')
                ->execute([$uid, $s['id'], 1]);
            Game::bumpCounter($pdo, $uid, 'skill_buys', 1);
            Game::grantXp($pdo, $uid, 40);
            fi_event($uid, 'buy_skill', ['skill' => $s['id'], 'level' => $lvl + 1]);
            Game::checkAchievements($pdo, $uid);
            return ['ok' => true, 'level' => $lvl + 1, 'spent' => $cost];
        });
        json_out(array_merge($res, ['snapshot' => Game::snapshot($uid)]));
    }

    /* ---------------- claim a daily quest ---------------- */
    case 'claim_quest': {
        $qid = req_str('id');
        $q   = Balance::quest($qid);
        if (!$q) {
            api_fail('unknown quest');
        }
        $res = fi_tx(function (PDO $pdo) use ($uid, $q, $qid) {
            $period = Game::periodKey('D');
            $st = $pdo->prepare('SELECT claimed_at FROM player_quests WHERE user_id = ? AND quest_id = ? AND period = ?');
            $st->execute([$uid, $qid, $period]);
            if ($st->fetchColumn()) {
                return ['ok' => false, 'error' => 'already_claimed'];
            }
            $state = Game::loadState($uid);
            $prog = $q['metric'] === 'gold_earned'
                ? (int)$state['total_gold']
                : (int)(Game::counters($pdo, $uid, $period)[$q['metric']] ?? 0);
            if ($prog < (int)$q['target']) {
                return ['ok' => false, 'error' => 'not_complete', 'progress' => $prog];
            }
            $pdo->prepare('INSERT INTO player_quests(user_id,quest_id,period,claimed_at) VALUES(?,?,?,?)')
                ->execute([$uid, $qid, $period, time()]);

            $bonus = Balance::questBonus(Game::skillLevels($uid));
            $gold  = (float)($q['reward']['gold'] ?? 0) * $bonus;
            $gems  = (int)($q['reward']['gems'] ?? 0);
            $xp    = (float)($q['reward']['xp'] ?? 0) * $bonus;
            if ($gold > 0) { Game::addCurrency($pdo, $uid, 'gold', $gold, 'quest', $qid); }
            if ($gems > 0) { Game::addCurrency($pdo, $uid, 'gems', $gems, 'quest', $qid); }
            $lv = Game::grantXp($pdo, $uid, $xp);
            fi_event($uid, 'quest_claim', ['quest' => $qid]);
            Game::checkAchievements($pdo, $uid);
            return ['ok' => true, 'gold' => $gold, 'gems' => $gems, 'xp' => $xp,
                    'levelled' => $lv['levelled'], 'level' => $lv['level'], 'gifts' => $lv['gifts'] ?? []];
        });
        json_out(array_merge($res, ['snapshot' => Game::snapshot($uid)]));
    }

    /* ---------------- daily streak ---------------- */
    case 'claim_streak': {
        $res = Game::claimStreak($pdo, $uid);
        json_out(array_merge($res, ['snapshot' => Game::snapshot($uid)]));
    }

    /* ---------------- buy a shop offer ---------------- */
    case 'buy': {
        $res = Shop::buy($uid, req_int('offer'));
        json_out(array_merge($res, ['snapshot' => Game::snapshot($uid)]));
    }

    /* ---------------- open a crate ---------------- */
    case 'open_crate': {
        $cid = req_str('id');
        $free = (bool)req_int('free', 0);
        $res = Shop::openCrate($uid, $cid, $free);
        json_out(array_merge($res, ['snapshot' => Game::snapshot($uid)]));
    }

    /* ---------------- equip / unequip ---------------- */
    case 'equip': {
        $slot = req_str('slot');
        $body = req_body();
        $item = isset($body['item']) && $body['item'] !== '' && $body['item'] !== null ? (string)$body['item'] : null;
        $res  = Shop::equip($uid, $slot, $item);
        json_out(array_merge($res, $res['ok'] ? ['snapshot' => Game::snapshot($uid)] : []));
    }

    /* ---------------- prestige ---------------- */
    case 'prestige': {
        if (!req_int('confirm', 0)) {
            json_out(['ok' => false, 'error' => 'needs_confirm',
                      'preview' => Balance::canPrestige(Game::loadState($uid))]);
        }
        $res = Game::doPrestige($pdo, $uid);
        json_out(array_merge($res, ['snapshot' => Game::snapshot($uid)]));
    }

    /* ---------------- client settings (theme, sound, calm…) ---------------- */
    case 'save_settings': {
        $in = req_body()['settings'] ?? [];
        if (!is_array($in)) {
            api_fail('bad settings');
        }
        $clean = [];
        foreach (['sound' => 'bool', 'haptics' => 'bool', 'particles' => 'bool',
                  'reducedMotion' => 'bool', 'calmMode' => 'bool', 'theme' => 'str',
                  'signature' => 'str'] as $k => $type) {
            if (!array_key_exists($k, $in)) {
                continue;
            }
            if ($type === 'bool') {
                $clean[$k] = (bool)$in[$k];
            } elseif ($k === 'signature') {
                $clean[$k] = fi_substr(trim((string)$in[$k]), 120);
            } else {
                $clean[$k] = fi_substr(trim((string)$in[$k]), 32);
            }
        }
        $st = $pdo->prepare('SELECT settings_json FROM player_state WHERE user_id = ?');
        $st->execute([$uid]);
        $cur = json_decode((string)($st->fetchColumn() ?: '{}'), true) ?: [];
        // keep internal keys (combo tracking) intact
        foreach (['combo', 'comboAt'] as $keep) {
            if (isset($cur[$keep])) {
                $clean[$keep] = $cur[$keep];
            }
        }
        $pdo->prepare('UPDATE player_state SET settings_json = ?, updated_at = ? WHERE user_id = ?')
            ->execute([json_encode($clean, JSON_UNESCAPED_UNICODE), time(), $uid]);
        json_out(['ok' => true, 'settings' => $clean, 'snapshot' => Game::snapshot($uid)]);
    }

    /* ---------------- logout ---------------- */
    case 'logout': {
        $tok = auth_token();
        $pdo->prepare('DELETE FROM sessions WHERE id = ?')->execute([$tok]);
        json_out(['ok' => true]);
    }

    default:
        api_fail('unknown action');
    }
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->exec('ROLLBACK');
    }
    fi_event($uid, 'action_error', ['a' => $a, 'msg' => $e->getMessage()]);
    if (FI_DEBUG) {
        api_fail('server_error: ' . $e->getMessage(), 500);
    }
    api_fail('server_error', 500);
}
