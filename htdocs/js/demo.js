/* FORGE INFINITE — demo engine.
   A self-contained port of the PHP game logic that runs entirely in the browser
   with zero network access. Used by demo.html for instant previews, screenshots
   and design review. PRODUCTION NEVER LOADS THIS FILE.

   It deliberately mirrors api/Balance.php + api/Game.php + api/Shop.php so the
   numbers you see here are the real numbers. State lives in localStorage. */

import { cfg, gen, item, genCost, genProd, skillCost, sparksFor, goldForSparks,
         prestigeMult, xpToNext, comboMult, critChance, critMult, rollCrateLocal,
         crateOddsLocal } from './balance.js';
import { clamp } from './fmt.js';

const KEY = 'fi_demo_state_v1';
const now = () => Math.floor(Date.now() / 1000);
const dayKey = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
function freshState(username) {
  return {
    username,
    createdAt: now(),
    gold: 0, gems: 50, tokens: 0,
    energy: 20, energyAt: now(),
    level: 1, xp: 0,
    sparks: 0, prestigeCount: 0,
    runGold: 0, totalGold: 0, totalClicks: 0,
    streakDays: 0, lastClaimDay: null, lastFreeCrate: 0,
    lastSettle: now(), lastActive: now(),
    gens: {}, skills: {}, owned: {}, loadout: {}, settings: {},
    counters: {}, questsClaimed: {}, achievements: [],
    combo: 0, comboAt: 0, lastRewardLevel: 0,
    ledger: [],
  };
}

let S = null;
let lastIdle = null;

export function isDemo() { return true; }

export function loadDemo(user = 'Smith') {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { S = JSON.parse(raw); }
  } catch { S = null; }
  if (!S) S = freshState(user);
  if (typeof S.lastRewardLevel !== 'number') {
    // a save from before level rewards existed: assume everything up to the
    // current level was already handed out, so nobody gets a retroactive dump
    S.lastRewardLevel = S.level || 1;
  }
  return S;
}
export function saveDemo() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* quota */ } }
export function resetDemo(user = 'Smith') { S = freshState(user); saveDemo(); return S; }
export const demoState = () => S;

/* ------------------------------------------------------------------ *
 *  Derived (mirrors Game::derived)
 * ------------------------------------------------------------------ */
function sl() { return S.skills; }
function skillLv(id) { return S.skills[id] || 0; }
function skillDef(id) { return (cfg().skills || []).find(x => x.id === id); }

function skillMultOf(effect, id) {
  const d = skillDef(id);
  return d ? d.per_level * skillLv(id) : 0;
}
const gpsSkillMult   = () => 1 + skillMultOf('gps', 'efficient_forge');
const clickSkillMult = () => 1 + skillMultOf('click_value', 'sharp_hands');
const costReduction  = () => Math.min(0.25, skillMultOf('cost_reduction', 'bargainer'));
const questBonus     = () => 1 + skillMultOf('quest_reward', 'focus');
const dropBonus      = () => skillMultOf('drop_rate', 'lucky_star');

function gpsRaw() {
  let sum = 0;
  for (const g of cfg().generators || []) sum += genProd(g, S.gens[g.id] || 0);
  return sum;
}
function pMult() { return prestigeMult(S.sparks); }
function gps() { return gpsRaw() * pMult() * gpsSkillMult(); }
function clickValue() { return (1 + S.prestigeCount + 0.05 * gpsRaw()) * clickSkillMult(); }

function offlineEff() {
  const c = cfg().idle;
  return Math.min(1, c.offline_efficiency_base + c.offline_efficiency_per_skill * skillLv('night_shift'));
}
function offlineCap() {
  const c = cfg().idle;
  return Math.min(c.offline_cap_secs_max, c.offline_cap_secs_base + c.offline_cap_per_skill_secs * skillLv('night_shift'));
}

/* ------------------------------------------------------------------ *
 *  Currency — the only sanctioned mutator (mirrors Game::addCurrency)
 * ------------------------------------------------------------------ */
function addCur(cur, delta, reason) {
  if (cur === 'gold') {
    const next = S.gold + delta;
    if (next < -1e-9) return false;               // atomic-spend equivalent
    S.gold = Math.max(0, next);
    if (delta > 0) { S.runGold += delta; S.totalGold += delta; }
    else S.runGold = Math.max(0, S.runGold + delta);
  } else if (cur === 'gems') {
    if (S.gems + delta < 0) return false;
    S.gems += delta;
  } else if (cur === 'tokens') {
    if (S.tokens + delta < 0) return false;
    S.tokens += delta;
  } else return false;
  S.ledger.push({ cur, delta, reason, at: now() });
  if (S.ledger.length > 400) S.ledger.splice(0, S.ledger.length - 400);
  return true;
}

/* ------------------------------------------------------------------ *
 *  Counters / quests / achievements
 * ------------------------------------------------------------------ */
function bump(metric, by) {
  const k = dayKey();
  S.counters[k] = S.counters[k] || {};
  S.counters[k][metric] = (S.counters[k][metric] || 0) + by;
}
function counter(metric) {
  return (S.counters[dayKey()] || {})[metric] || 0;
}
function metricValue(m) {
  if (m.startsWith('gen_')) return S.gens[m.slice(4)] || 0;
  switch (m) {
    case 'clicks': return S.totalClicks;
    case 'gold_earned': return Math.floor(S.totalGold);
    case 'prestige_count': return S.prestigeCount;
    case 'level': return S.level;
    case 'streak_days': return S.streakDays;
    case 'items_owned': return Object.keys(S.owned).length;
    default: return counter(m);
  }
}
function checkAchievements() {
  const out = [];
  for (const a of cfg().achievements || []) {
    if (S.achievements.includes(a.id)) continue;
    if (metricValue(a.metric) < a.target) continue;
    S.achievements.push(a.id);
    const r = a.reward || {};
    if (r.gold) addCur('gold', r.gold, 'achievement');
    if (r.gems) addCur('gems', r.gems, 'achievement');
    if (r.item && item(r.item)) S.owned[r.item] = { qty: 1, source: 'achievement', at: now() };
    if (r.xp) grantXp(r.xp);
    out.push({ id: a.id, name: a.name, desc: a.desc, reward: r });
  }
  return out;
}

function grantXp(amount) {
  S.xp += Math.floor(amount);
  let levelled = false;
  let guard = 0;
  while (S.xp >= xpToNext(S.level) && guard++ < 500) { S.xp -= xpToNext(S.level); S.level++; levelled = true; }
  S.level = Math.min(200, S.level);
  if (levelled) {
    const gifts = grantLevelRewards();
    return { levelled, level: S.level, gifts };
  }
  return { levelled, level: S.level, gifts: [] };
}

/** Level milestones hand out the first cosmetics (GDD §3.6).
 *  `lastRewardLevel` is part of the STATE, not a module variable — otherwise it
 *  survives a reset and silently disables every future gift. */
function grantLevelRewards() {
  const gifts = [];
  const from = S.lastRewardLevel || 0;
  for (const rw of cfg().level_rewards || []) {
    if (rw.level <= from || rw.level > S.level) continue;
    const g = { level: rw.level };
    if (rw.item && item(rw.item)) {
      S.owned[rw.item] = S.owned[rw.item] || { qty: 1, source: 'level_reward', at: now() };
      g.item = rw.item; g.name = item(rw.item).name;
    }
    if (rw.gems) { addCur('gems', rw.gems, 'level_reward'); g.gems = rw.gems; }
    if (rw.gold) { addCur('gold', rw.gold, 'level_reward'); g.gold = rw.gold; }
    gifts.push(g);
    S.lastRewardLevel = Math.max(S.lastRewardLevel || 0, rw.level);
  }
  return gifts;
}

/* ------------------------------------------------------------------ *
 *  Idle settlement (mirrors Game::settleIdle, including the online/offline split)
 * ------------------------------------------------------------------ */
function settleIdle() {
  const t = now();
  const last = Math.max(0, S.lastSettle);
  const active = Math.max(0, S.lastActive);
  const cap = offlineCap();
  const eff = offlineEff();
  const window = Math.max(0, Math.min(t - last, cap * 4));
  const onlineSec = Math.max(0, Math.min(window, active > last ? Math.min(active, t) - last : 0));
  const idleSec = Math.max(0, window - onlineSec);
  const paidIdle = Math.min(idleSec, cap);
  const gain = gps() * onlineSec + gps() * paidIdle * eff;
  if (gain > 0.5) { addCur('gold', gain, idleSec > 300 ? 'idle_offline' : 'idle_online'); bump('gold_earned', Math.floor(gain)); }
  S.lastSettle = t; S.lastActive = t;
  lastIdle = { secs: window, online_secs: onlineSec, idle_secs: paidIdle, capped: idleSec > cap,
               gain, gps: gps(), efficiency: eff };
  return lastIdle;
}

/* ------------------------------------------------------------------ *
 *  Actions (mirror api/action.php)
 * ------------------------------------------------------------------ */
function genUnlocked(id) {
  const gs = cfg().generators || [];
  const i = gs.findIndex(g => g.id === id);
  if (i < 0) return false;
  if (i === 0) return true;
  return (S.gens[gs[i - 1].id] || 0) >= (gs[i].need_prev_count || 0);
}

export const demoActions = {
  click(count, comboHint) {
    count = clamp(count | 0, 0, 5000);
    S.lastActive = now();
    if (!count) return { clicks: 0, gold: 0, crits: 0, combo: S.combo };
    const t = now();
    S.combo = (t - S.comboAt <= 4) ? S.combo + count : count;
    S.comboAt = t;
    const cm = comboMult(Math.min(50, S.combo));
    const expected = count * critChance();
    let crits = Math.floor(expected);
    if (Math.random() < expected - crits) crits++;
    crits = clamp(crits, 0, count);
    const base = clickValue();
    const total = (count - crits) * base * cm + crits * base * cm * critMult();
    S.totalClicks += count;
    addCur('gold', total, 'click');
    bump('clicks', count);
    const r = grantXp(count * 0.05);
    checkAchievements();
    return { clicks: count, gold: total, crits, combo: S.combo, comboMult: cm,
             clickValue: base * cm, totalClicks: S.totalClicks, ...r };
  },

  buy_gen(id, qty) {
    const g = gen(id);
    if (!g) return { ok: false, error: 'unknown generator' };
    if (!genUnlocked(id)) return { ok: false, error: 'locked' };
    qty = clamp(qty | 0, 1, 1000);
    const lvl = S.gens[id] || 0;
    const k = 1 - costReduction();
    let total = 0, bought = 0;
    for (let i = 0; i < qty; i++) {
      const c = genCost(g, lvl + i, costReduction());
      if (total + c > S.gold + 1e-9) break;
      total += c; bought++;
    }
    if (!bought) return { ok: false, error: 'not_enough', need: genCost(g, lvl, costReduction()), have: S.gold };
    if (!addCur('gold', -total, 'buy_gen')) return { ok: false, error: 'not_enough' };
    S.gens[id] = lvl + bought;
    bump('buys', bought);
    bump('gen_' + id, bought);
    const r = grantXp(10 * bought * g.tier);
    checkAchievements();
    return { ok: true, bought, spent: total, level: lvl + bought, levelled: r.levelled, gifts: r.gifts };
  },

  buy_skill(id) {
    const d = skillDef(id);
    if (!d) return { ok: false, error: 'unknown skill' };
    const lvl = skillLv(id);
    if (lvl >= d.max) return { ok: false, error: 'maxed' };
    const cost = skillCost(d, lvl) * (1 - costReduction());
    if (!addCur('gold', -cost, 'buy_skill')) return { ok: false, error: 'not_enough', need: cost };
    S.skills[id] = lvl + 1;
    bump('skill_buys', 1);
    grantXp(40);
    checkAchievements();
    return { ok: true, level: lvl + 1, spent: cost };
  },

  claim_quest(id) {
    const q = (cfg().quests_daily || []).find(x => x.id === id);
    if (!q) return { ok: false, error: 'unknown quest' };
    const ck = dayKey() + ':' + id;
    if (S.questsClaimed[ck]) return { ok: false, error: 'already_claimed' };
    const prog = q.metric === 'gold_earned' ? Math.floor(S.totalGold) : metricValue(q.metric);
    if (prog < q.target) return { ok: false, error: 'not_complete', progress: prog };
    S.questsClaimed[ck] = now();
    const b = questBonus();
    const gold = (q.reward.gold || 0) * b, gems = q.reward.gems || 0, xp = (q.reward.xp || 0) * b;
    if (gold) addCur('gold', gold, 'quest');
    if (gems) addCur('gems', gems, 'quest');
    const r = grantXp(xp);
    checkAchievements();
    return { ok: true, gold, gems, xp, levelled: r.levelled, level: r.level, gifts: r.gifts };
  },

  claim_streak() {
    const today = dayKey();
    if (S.lastClaimDay === today) return { ok: false, error: 'already_claimed', streak: S.streakDays };
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    S.streakDays = S.lastClaimDay === y ? S.streakDays + 1 : 1;
    S.lastClaimDay = today;
    const reward = (cfg().streak.week1 || [])[(((S.streakDays - 1) % 7) + 7) % 7] || { gold: 100000 };
    if (reward.gold) addCur('gold', reward.gold, 'streak');
    if (reward.gems) addCur('gems', reward.gems, 'streak');
    checkAchievements();
    return { ok: true, streak: S.streakDays, reward, day_in_cycle: ((S.streakDays - 1) % 7) + 1 };
  },

  buy(offerId) {
    const o = offers().find(x => x.id === offerId);
    if (!o) return { ok: false, error: 'offer_unavailable' };
    const it = item(o.item);
    if (!it) return { ok: false, error: 'offer_unavailable' };
    if (o.slot !== 'crate' && S.owned[o.item]) return { ok: false, error: 'already_owned' };
    if (!addCur(o.currency, -o.price, 'shop_buy')) return { ok: false, error: 'not_enough' };
    S.owned[o.item] = { qty: (S.owned[o.item]?.qty || 0) + 1, source: o.currency === 'gems' ? 'gems' : 'gold', at: now() };
    bump('buys', 1);
    bump('spent_' + o.currency, o.price);
    grantXp(15);
    checkAchievements();
    return { ok: true, item: o.item, name: it.name, rarity: it.rarity, slot: it.slot,
             tradable: o.currency === 'gems' ? 0 : (it.tradable ?? 1),
             spent: { cur: o.currency, amount: o.price } };
  },

  open_crate(id, free) {
    const c = (cfg().crates || {})[id];
    if (!c) return { ok: false, error: 'unknown_crate' };
    const cooldown = (c.free_cooldown_hours || 0) * 3600;
    if (free) {
      if (!cooldown) return { ok: false, error: 'no_free_crate' };
      if (S.lastFreeCrate + cooldown > now()) return { ok: false, error: 'cooldown', ready_in: S.lastFreeCrate + cooldown - now() };
      S.lastFreeCrate = now();
    } else {
      const have = S.owned[id]?.qty || 0;
      if (have <= 0) return { ok: false, error: 'no_crate' };
      S.owned[id].qty = have - 1;
      if (S.owned[id].qty <= 0) delete S.owned[id];
    }
    const roll = rollCrateLocal(id, Object.keys(S.owned), dropBonus());
    const it = roll.item_id ? item(roll.item_id) : null;
    const odds = crateOddsLocal(id);
    const out = { ok: true, free: !!free, crate: id, roll: roll.roll, total: roll.total, odds };
    if (!it) { out.reward = { type: 'gold', amount: 0 }; return out; }
    if (S.owned[roll.item_id]) {
      const pct = c.dupe_gold_pct ?? 25;
      const val = it.price_gold || (it.price_gems || 0) * 25000;
      const g = Math.max(1000, val * pct / 100);
      addCur('gold', g, 'crate_dupe');
      out.reward = { type: 'dupe', item: it.id, name: it.name, rarity: it.rarity, gold: g };
    } else {
      S.owned[it.id] = { qty: 1, source: free ? 'free_crate' : 'paid_crate', at: now(), tradable: free ? 1 : 0 };
      out.reward = { type: 'item', item: it.id, name: it.name, rarity: it.rarity, slot: it.slot, css: it.css || null, new: true };
    }
    bump('crates', 1);
    grantXp(25);
    checkAchievements();
    return out;
  },

  equip(slot, itemId) {
    if (!(cfg().slots || []).includes(slot)) return { ok: false, error: 'bad_slot' };
    if (itemId) {
      const it = item(itemId);
      if (!it) return { ok: false, error: 'unknown_item' };
      if (it.slot !== slot) return { ok: false, error: 'slot_mismatch' };
      if (!S.owned[itemId]) return { ok: false, error: 'not_owned' };
      S.loadout[slot] = itemId;
    } else delete S.loadout[slot];
    return { ok: true, loadout: { ...S.loadout } };
  },

  prestige(confirm) {
    const c = canPrestige();
    if (!confirm) return { ok: false, error: 'needs_confirm', check: c };
    if (!c.ok) return { ok: false, error: 'not_ready', check: c };
    S.sparks = c.potential;
    S.prestigeCount++;
    if (S.gold) addCur('gold', -S.gold, 'prestige_burn');
    S.runGold = 0; S.xp = 0; S.gens = {}; S.skills = {};
    checkAchievements();
    return { ok: true, sparks: S.sparks, gain: c.gain, mult: c.mult };
  },

  save_settings(patch) {
    S.settings = { ...S.settings, ...(patch || {}) };
    if (typeof S.settings.signature === 'string') S.settings.signature = S.settings.signature.slice(0, 120);
    return { ok: true, settings: { ...S.settings } };
  },
};

/** Demo-only gem grant used by the simulated payment flow. */
export function demoGrantGems(n) { return addCur('gems', Math.max(0, n | 0), 'iap_demo'); }

function canPrestige() {
  const p = cfg().prestige || {};
  const pot = sparksFor(S.runGold);
  const gate = p.gate_multiplier ?? 1.75;
  const need = Math.max(p.min_sparks_to_prestige ?? 5, Math.ceil(S.sparks * gate));
  return { potential: pot, current: S.sparks, gain: Math.max(0, pot - S.sparks), required: need,
           ok: pot >= need && pot > S.sparks, mult: 1 + (p.gps_bonus_per_spark ?? 0.02) * pot,
           need_gold: goldForSparks(need), gate };
}

/* ------------------------------------------------------------------ *
 *  Offers (mirrors Shop::offers)
 * ------------------------------------------------------------------ */
export function offers() {
  // Rebuilt every call: it is ~30 rows and must never go stale after a reset.
  const list = [];
  let id = 0;
  for (const it of Object.values(cfg().catalog || {})) {
    if (it.css?.achievement) continue;
    const cur = it.price_gems ? 'gems' : it.price_gold ? 'gold' : null;
    if (!cur) continue;
    list.push({ id: ++id, item: it.id, name: it.name, slot: it.slot, rarity: it.rarity, css: it.css || null,
                currency: cur, price: cur === 'gems' ? it.price_gems : it.price_gold,
                stockLeft: it.css?.edition ?? null, endsAt: null, featured: it.rarity === 'legendary' || it.rarity === 'limited' });
  }
  for (const [cid, c] of Object.entries(cfg().crates || {})) {
    if (!c.price_gems) continue;
    list.push({ id: ++id, item: cid, name: c.name, slot: 'crate', rarity: 'rare', css: null,
                currency: 'gems', price: c.price_gems, stockLeft: null, endsAt: null, featured: true });
  }
  list.sort((a, b) => (b.featured - a.featured) || a.price - b.price);
  return list;
}

/* ------------------------------------------------------------------ *
 *  Snapshot (mirrors Game::snapshot)
 * ------------------------------------------------------------------ */
export function snapshot(extra = {}) {
  if (!S) loadDemo();
  const idle = settleIdle();
  const d = dayKey();
  const ownedList = Object.entries(S.owned).map(([item_id, o]) => ({ item_id, qty: o.qty || 1, source: o.source, acquired_at: o.at }));
  const catalog = {};
  for (const it of Object.values(cfg().catalog || {})) catalog[it.id] = { name: it.name, slot: it.slot, rarity: it.rarity, css: it.css || null };

  const quests = (cfg().quests_daily || []).map(q => {
    const prog = q.metric === 'gold_earned' ? Math.floor(S.totalGold) : metricValue(q.metric);
    const b = questBonus();
    return { id: q.id, name: q.name, metric: q.metric, target: q.target,
             progress: Math.min(prog, q.target), done: prog >= q.target,
             claimed: !!S.questsClaimed[d + ':' + q.id],
             reward: { gold: Math.floor((q.reward.gold || 0) * b), gems: q.reward.gems || 0, xp: Math.floor((q.reward.xp || 0) * b) } };
  });

  const achievements = (cfg().achievements || []).map(a => ({
    id: a.id, name: a.name, desc: a.desc, target: a.target, tier: a.tier, reward: a.reward,
    progress: Math.min(metricValue(a.metric), a.target), unlocked: S.achievements.includes(a.id),
  }));

  const skills = (cfg().skills || []).map(k => {
    const lvl = skillLv(k.id);
    const maxed = lvl >= k.max;
    const cost = Math.round(skillCost(k, lvl) * (1 - costReduction()));
    return { id: k.id, name: k.name, level: lvl, max: k.max, effect: k.effect, per_level: k.per_level,
             cost: maxed ? null : cost, maxed, affordable: !maxed && S.gold >= cost };
  });

  const gens = (cfg().generators || []).map(g => {
    const lvl = S.gens[g.id] || 0;
    const unlocked = genUnlocked(g.id);
    const cost = genCost(g, lvl, costReduction());
    const m = pMult() * gpsSkillMult();
    return { id: g.id, name: g.name, icon: g.icon || '⚙️', tier: g.tier, level: lvl, unlocked,
             need_prev: g.need_prev_count || 0, cost: Math.round(cost), prod_each: g.base_prod,
             prod_now: genProd(g, lvl) * m, prod_next: genProd(g, lvl + 1) * m,
             affordable: S.gold >= cost };
  });

  const energyCap = 20 + skillLv('stamina');
  S.energy = Math.min(energyCap, S.energy + Math.max(0, now() - S.energyAt) / 600);
  S.energyAt = now();

  return {
    ok: true, serverTime: now(), serverDay: d,
    state: { gold: S.gold, gems: S.gems, tokens: S.tokens, energy: Math.round(S.energy * 100) / 100,
             energyCap, level: S.level, xp: S.xp, xpToNext: xpToNext(S.level), sparks: S.sparks,
             prestigeCount: S.prestigeCount, runGold: S.runGold, totalGold: S.totalGold,
             totalClicks: S.totalClicks, streakDays: S.streakDays,
             streakClaimed: S.lastClaimDay === d, lastFreeCrate: S.lastFreeCrate },
    derived: { gps: gps(), gpsRaw: gpsRaw(), prestigeMult: pMult(), skillMult: gpsSkillMult(),
               clickValue: clickValue(), offlineEff: offlineEff(), offlineCap: offlineCap() },
    prestige: canPrestige(),
    gens, skills, quests, achievements,
    owned: ownedList,
    loadout: { ...S.loadout }, settings: { ...S.settings }, catalog,
    crates: Object.entries(cfg().crates || {}).map(([id, c]) => ({
      id, name: c.name, price_gems: c.price_gems || null, free_cooldown_hours: c.free_cooldown_hours || 0,
      odds: crateOddsLocal(id) })),
    slots: cfg().slots || [],
    packs: cfg().gem_packs || [],
    payProvider: '',
    idle,
    offers: offers(),
    leaderboard: demoLeaderboard(),
    myRank: 1,
    online: 1,
    poll: 10,
    ...extra,
  };
}

/** A small static board so the ranks screen is never empty in the demo. */
function demoLeaderboard() {
  const me = { rank: 0, username: S.username, level: S.level, sparks: S.sparks,
               prestige: S.prestigeCount, totalGold: S.totalGold, loadout: S.loadout };
  const bots = [
    ['Emberwright', 42, 8200, 6.2e12], ['Cinderfall', 37, 4100, 2.4e12], ['MoltenMae', 31, 1900, 8.1e11],
    ['Ashenforge', 26, 780, 2.2e11], ['SootQueen', 22, 410, 6.4e10], ['Ironbell', 19, 220, 2.1e10],
    ['Quench', 15, 90, 4.2e9], ['Slaghand', 12, 40, 9.0e8],
  ].map(([u, l, sp, g], i) => ({ rank: 0, username: u, level: l, sparks: sp, prestige: Math.floor(sp / 60), totalGold: g, loadout: {
      frame: i < 2 ? 'frame_aurora' : i < 5 ? 'frame_royal' : 'frame_neon',
      title: i === 0 ? 'title_founder' : null, background: i < 4 ? 'bg_galaxy' : null,
    } }));
  const all = [...bots, me].sort((a, b) => b.totalGold - a.totalGold);
  all.forEach((p, i) => { p.rank = i + 1; });
  return all.slice(0, 20);
}
