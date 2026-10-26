/* FORGE INFINITE — entry point */

import { boot, store, snap, bus, actions } from './store.js';
import { renderAuth, renderShell, refresh, updateHud, showOffline, mountScreens, humanError, viewProfile } from './screens.js';
import { getToken } from './api.js';
import { sfx, setJuiceSettings, confetti } from './juice.js';
import { toastOk, toastErr, toastGold } from './ui.js';
import { loadBalance } from './balance.js';
import { fmt } from './fmt.js';

const qs = new URLSearchParams(location.search);
window.FI_VER = '1.0.0';

/* Calm mode straight from the URL — an accessibility/ethics feature, not a
   setting buried in a menu (BRAND.md §12, GDD §13.5). */
const calmRequested = qs.has('calm');

async function start() {
  mountScreens(document.getElementById('app'));
  bindGlobalEvents();

  await loadBalance().catch(() => toastErr('Could not load game data. Reload the page.'));

  // Payment gateway return
  if (qs.get('paid') === '1') toastGold('Payment confirmed — gems added to your account');
  if (qs.get('paid') === '0') toastErr('Payment cancelled. Nothing was charged.');

  // Public profile deep link: /?u=Name
  const profileUser = qs.get('u');
  if (profileUser) {
    if (!getToken()) { renderAuth('login'); }
    else { const ok = await boot(); if (ok) { renderShell(); refresh(); } else renderAuth('login'); }
    viewProfile(profileUser);
    hideBoot();
    return;
  }

  const ok = await boot();
  hideBoot();
  if (!ok) { renderAuth('login'); return; }
  afterAuth(snap());
}

function afterAuth(s) {
  if (calmRequested || s?.settings?.calmMode) {
    setJuiceSettings({ calmMode: true });
    document.body.classList.add('calm');
    actions.saveSettings({ calmMode: true });
  }
  renderShell();
  refresh();
  if (s?.idle && s.idle.secs >= 60 && s.idle.gain >= 1) showOffline(s.idle);
  registerSW();
}

/* ------------------------------------------------------------------ *
 *  Global wiring
 * ------------------------------------------------------------------ */
function bindGlobalEvents() {
  // Browsers block audio until the first gesture
  addEventListener('pointerdown', () => sfx.unlockAudio(), { once: true });

  bus.addEventListener('state', () => { if (snap()) { updateHud(); softRefresh(); } });
  bus.addEventListener('needauth', () => renderAuth('login'));
  bus.addEventListener('loggedout', () => renderAuth('login'));

  bus.addEventListener('levelup', e => {
    sfx.levelup();
    confetti(innerWidth / 2, innerHeight * 0.35, 34);
    toastGold(`Level ${e.detail}!`);
  });
  bus.addEventListener('achievements', e => {
    for (const a of e.detail) { sfx.chime(); toastOk(`🏅 ${a.name} — ${a.desc}`); }
  });
  bus.addEventListener('error', e => {
    if (e.detail && e.detail !== 'rate_limited') toastErr(humanError(e.detail));
  });
  bus.addEventListener('settings', e => {
    if (e.detail && 'calmMode' in e.detail) document.body.classList.toggle('calm', !!e.detail.calmMode);
  });

  // Auth-screen navigation (login ⇄ register)
  document.addEventListener('click', e => {
    const n = e.target.closest('[data-nav]');
    if (!n) return;
    e.preventDefault();
    renderAuth(n.dataset.nav);
  });

  // Keep the gold counter alive between syncs — this is what makes an idle game
  // feel alive without spending a single extra HTTP request.
  setInterval(() => {
    if (!snap()) return;
    const node = document.getElementById('hudGold');
    if (!node) return;
    const dt = Math.max(0, Date.now() / 1000 - (store.lastSyncAt || Date.now() / 1000));
    const val = store.localGold + (snap().derived?.gps || 0) * dt;
    node.textContent = fmt(val);
    const comboBar = document.getElementById('comboBar');
    const comboWrap = document.getElementById('comboWrap');
    if (comboWrap) {
      comboWrap.hidden = store.combo < 3;
      if (comboBar) comboBar.style.width =
        (Math.max(0, 1 - (Date.now() - store.comboAt) / 2000) * 100).toFixed(1) + '%';
    }
  }, 100);
}

let refreshTimer = 0;
function softRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { try { refresh(); } catch (e) { console.warn('[fi] render', e); } }, 400);
}

function hideBoot() {
  const b = document.getElementById('boot');
  if (!b) return;
  b.classList.add('gone');
  setTimeout(() => b.remove(), 500);
}

function registerSW() {
  if (globalThis.FI_SINGLE_FILE) return;                       // single-file build
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

start().catch(err => {
  console.error(err);
  const app = document.getElementById('app');
  if (app) app.innerHTML = `<div class="fatal">
    <h2>The forge would not light</h2>
    <p class="small">${String(err?.message || err)}</p>
    <button class="btn btn-primary" onclick="location.reload()">Reload</button></div>`;
  hideBoot();
});
