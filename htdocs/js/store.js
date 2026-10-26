/* FORGE INFINITE — client store: state, click batching, sync loop, local prediction.
   Design rule: the server owns the truth. Local values are predictions used only
   for smooth rendering, and they are overwritten on every sync. */

import { api, getToken, clearSession, serverNow } from './api.js';
import { loadBalance, prestigeMult, comboMult } from './balance.js';
import { sfx, setJuiceSettings } from './juice.js';

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export const store = {
  ready: false,
  snapshot: null,
  offers: [],
  leaderboard: [],
  myRank: 0,
  online: 0,
  poll: 10,
  lastIdle: null,
  lastClicks: null,
  newAchievements: [],
  // local prediction
  localGold: 0,
  localXp: 0,
  combo: 0,
  comboAt: 0,
  pendingClicks: 0,
  syncing: false,
  error: null,
  lastSyncAt: 0,
};

/* ------------------------------------------------------------------ *
 *  Accessors
 * ------------------------------------------------------------------ */
export const snap = () => store.snapshot;
export const st = () => store.snapshot?.state || {};
export const dv = () => store.snapshot?.derived || {};

/** Gold as displayed: server value + locally predicted accrual since the last sync. */
export function gold() {
  const s = store.snapshot;
  if (!s) return store.localGold;
  const dt = Math.max(0, (Date.now() / 1000) - (store.lastSyncAt || Date.now() / 1000));
  return store.localGold + (dv().gps || 0) * dt;
}

export function level() { return st().level || 1; }
export function xpPct() {
  const s = st();
  return s.xpToNext > 0 ? Math.min(1, (s.xp || 0) / s.xpToNext) : 0;
}

export function applyTheme(name) {
  const root = document.documentElement;
  root.dataset.theme = name && name !== 'ember' ? name : '';
  if (name && name !== 'ember') root.setAttribute('data-theme', name);
  else root.removeAttribute('data-theme');
}

/* ------------------------------------------------------------------ *
 *  Sync
 * ------------------------------------------------------------------ */
export async function sync(flushClicks = true) {
  if (!getToken()) return null;
  if (store.syncing) return store.snapshot;
  store.syncing = true;
  try {
    const clicks = flushClicks ? store.pendingClicks : 0;
    const combo = store.combo;
    if (clicks > 0) { store.pendingClicks = 0; }
    const d = await api.state(clicks, combo);
    ingest(d);
    store.error = null;
    return store.snapshot;
  } catch (e) {
    store.error = e.code === 429 ? 'Slow down — syncing again shortly.' : (e.message || 'network');
    if (e.code === 401) { clearSession(); emit('loggedout'); }
    emit('error', store.error);
    return null;
  } finally {
    store.syncing = false;
  }
}

export function ingest(d) {
  if (!d) return;
  const prevLevel = store.snapshot?.state?.level ?? 0;
  const prevSparks = store.snapshot?.state?.sparks ?? 0;

  store.snapshot = d;
  store.offers = d.offers || store.offers;
  store.leaderboard = d.leaderboard || store.leaderboard;
  store.myRank = d.myRank || store.myRank;
  store.online = d.online ?? store.online;
  store.poll = d.poll || store.poll;
  store.lastIdle = d.idle || null;
  store.lastClicks = d.clicks || null;
  store.newAchievements = d.newAchievements || [];
  store.lastSyncAt = Date.now() / 1000;

  store.localGold = Number(d.state?.gold || 0);
  store.localXp = Number(d.state?.xp || 0);

  // settings → juice + theme
  const s = d.settings || {};
  setJuiceSettings({
    sound: s.sound !== false,
    haptics: s.haptics !== false,
    particles: s.particles !== false,
    reducedMotion: !!s.reducedMotion,
    calmMode: !!s.calmMode || new URLSearchParams(location.search).has('calm'),
  });
  const themeItem = (d.loadout || {}).theme;
  const themeCss = themeItem ? d.catalog?.[themeItem]?.css?.theme : null;
  applyTheme(themeCss || s.theme || 'ember');

  if (prevLevel && d.state?.level > prevLevel) emit('levelup', d.state.level);
  if (d.state?.sparks > prevSparks && prevSparks !== undefined && prevLevel) emit('prestiged', d.state.sparks);
  if (store.newAchievements.length) emit('achievements', store.newAchievements);
  emit('state', d);
}

/* ------------------------------------------------------------------ *
 *  Clicks — buffered, flushed with the sync so a burst costs 1 request
 * ------------------------------------------------------------------ */
const COMBO_WINDOW = 2000;
let flushTimer = 0;

export function registerClick(n = 1) {
  const now = Date.now();
  store.combo = (now - store.comboAt <= COMBO_WINDOW * 2) ? store.combo + n : n;
  store.comboAt = now;
  store.pendingClicks += n;

  // optimistic local gold so the counter never feels laggy
  const per = (dv().clickValue || 1) * comboMult(Math.min(50, store.combo));
  store.localGold += per * n;

  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = 0; sync(true); }, 700);
  } else if (store.pendingClicks >= 60) {
    clearTimeout(flushTimer); flushTimer = 0; sync(true);
  }
}

export function comboDecayTick() {
  if (store.combo && Date.now() - store.comboAt > COMBO_WINDOW) { store.combo = 0; emit('combo', 0); }
}

/* ------------------------------------------------------------------ *
 *  Actions
 * ------------------------------------------------------------------ */
async function act(a, params = {}) {
  try {
    const r = await api.action(a, params);
    if (r.snapshot) ingest({ ...store.snapshot, ...r.snapshot, offers: store.offers, leaderboard: store.leaderboard });
    if (!r.ok) emit('actionfail', { a, error: r.error, ...r });
    return r;
  } catch (e) {
    emit('actionfail', { a, error: e.message || 'network' });
    return { ok: false, error: e.message || 'network' };
  }
}

export const actions = {
  click: (n, combo) => act('click', { clicks: n, combo }),
  buyGen: (id, qty = 1) => act('buy_gen', { id, qty }),
  buySkill: id => act('buy_skill', { id }),
  claimQuest: id => act('claim_quest', { id }),
  claimStreak: () => act('claim_streak'),
  buy: offer => act('buy', { offer }),
  openCrate: (id, free) => act('open_crate', { id, free: free ? 1 : 0 }),
  equip: (slot, item) => act('equip', { slot, item: item || '' }),
  prestige: (confirm) => act('prestige', { confirm: confirm ? 1 : 0 }),
  saveSettings: settings => act('save_settings', { settings }),
};

/* ------------------------------------------------------------------ *
 *  Loop: local prediction between syncs + adaptive polling
 * ------------------------------------------------------------------ */
let pollTimer = 0;

export function startLoops() {
  // 1. render tick (60 fps) — only touches the DOM nodes that show live numbers
  let last = performance.now();
  const frame = now => {
    const dt = (now - last) / 1000; last = now;
    comboDecayTick();
    emit('tick', { dt, now });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // 2. network tick — interval chosen by the server, stretched when the tab is hidden
  const schedule = () => {
    clearTimeout(pollTimer);
    const hidden = document.hidden;
    const secs = hidden ? Math.max(30, store.poll * 6) : store.poll;
    pollTimer = setTimeout(async () => { await sync(true); schedule(); }, secs * 1000);
  };
  schedule();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { sync(true); schedule(); }
    else { sync(true); }
  });
  addEventListener('online', () => sync(true));

  // 3. flush pending clicks before the tab goes away
  addEventListener('pagehide', () => { if (store.pendingClicks > 0 && navigator.sendBeacon) {
    const body = JSON.stringify({ a: 'click', clicks: store.pendingClicks, combo: store.combo });
    navigator.sendBeacon('api/action.php', new Blob([body], { type: 'application/json' }));
    store.pendingClicks = 0;
  } });
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */
export async function boot() {
  await loadBalance();
  if (!getToken()) { store.ready = true; emit('needauth'); return false; }
  const d = await sync(false);
  store.ready = true;
  if (d) {
    emit('ready', d);
    // The offline-earnings popup is the strongest return hook in the game (GDD §3.7).
    if (d.idle && d.idle.secs >= 60 && d.idle.gain >= 1) emit('offline', d.idle);
  } else {
    emit('needauth');
  }
  return !!d;
}

export function resetAuth() { clearSession(); store.snapshot = null; emit('needauth'); }

export { serverNow, sfx };
