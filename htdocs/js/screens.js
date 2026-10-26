/* FORGE INFINITE — all screens.
   Rendered as HTML strings into one host node. A SINGLE delegated click listener
   is attached once by renderShell(), so re-rendering never duplicates handlers. */

import { fmt, fmtFull, fmtPrice, dur, esc, attr, RARITY_ICON, rarityLabel, clamp } from './fmt.js';
import { cfg, item, cssFor, RARITY_CSS } from './balance.js';
import { store, st, dv, snap, gold, xpPct, actions, emit, ingest, registerClick, resetAuth, sync, startLoops } from './store.js';
import { avatarHTML, titleHTML, badgeHTML, itemCardHTML, slotIcon, clickFx, themeFromLoadout } from './cosmetic.js';
import { toast, toastOk, toastErr, toastGold, modal, confirmDialog, revealReward, oddsTableHTML } from './ui.js';
import { sfx, burst, confetti, emberRain, floatText, shake, flash, haptic, shakeNode } from './juice.js';
import { api, getUser } from './api.js';

let host = null;
let currentTab = 'forge';
let buyQty = 1;
let goldenTimer = 0, goldenEl = null;
let wired = false;
let loopsStarted = false;

export function mountScreens(node) { host = node; }
export const getTab = () => currentTab;

export const LOGO_SVG = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true">
  <defs><linearGradient id="emb" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#FFB020"/><stop offset=".45" stop-color="#FF7A18"/>
    <stop offset="1" stop-color="#C2410C"/></linearGradient></defs>
  <path d="M22 22c-7 0-12 4.5-12 10s5 10 12 10c6 0 9-4 12-8 3 4 6 8 12 8 7 0 12-4.5 12-10s-5-10-12-10c-6 0-9 4-12 8-3-4-6-8-12-8z"
        fill="none" stroke="url(#emb)" stroke-width="6" stroke-linejoin="round"/>
  <path d="M18 50h28l-4 8H22z" fill="url(#emb)"/></svg>`;

/* ================================================================== *
 *  AUTH
 * ================================================================== */
export function renderAuth(mode = 'login') {
  const isReg = mode === 'register';
  host.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-brand">
      ${LOGO_SVG}
      <h1 class="wordmark">FORGE<span>INFINITE</span></h1>
      <p class="tagline">It keeps burning while you're gone.</p>
    </div>
    <form class="auth-card" id="authForm" novalidate>
      <h2>${isReg ? 'Light your forge' : 'Welcome back'}</h2>
      <label class="field">
        <span>Username</span>
        <input id="fUser" name="username" autocomplete="username" required
               pattern="[A-Za-z0-9_]{3,20}" minlength="3" maxlength="20" placeholder="3–20 letters, numbers, _" />
      </label>
      <label class="field">
        <span>Password</span>
        <input id="fPass" name="password" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}"
               required minlength="6" maxlength="200" placeholder="At least 6 characters" />
      </label>
      <button class="btn btn-primary btn-block" type="submit">${isReg ? 'Create account & play' : 'Log in'}</button>
      <p class="auth-alt">
        ${isReg ? 'Already have an account?' : 'New here?'}
        <a href="#" data-nav="${isReg ? 'login' : 'register'}">${isReg ? 'Log in' : 'Create one'}</a>
      </p>
      <button id="guestBtn" class="btn btn-ghost btn-block" type="button">Just play — no signup</button>
      <p class="auth-fine">Creates a private smith name you can change later. Progress is saved either way.
        Nothing here costs money to play — purchases are optional cosmetics only.</p>
      <div class="auth-error" id="authError" role="alert"></div>
    </form>
  </div>`;

  const form = document.getElementById('authForm');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const u = document.getElementById('fUser').value.trim();
    const p = document.getElementById('fPass').value;
    const err = document.getElementById('authError');
    const btn = form.querySelector('button[type=submit]');
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Working…';
    try {
      const r = isReg ? await api.register(u, p) : await api.login(u, p);
      localStorage.setItem('fi_token', r.token);
      localStorage.setItem('fi_user', JSON.stringify(r.user));
      sfx.chime();
      await bootIntoGame(r.snapshot);
    } catch (ex) {
      err.textContent = humanError(ex.message || 'Something went wrong');
      btn.disabled = false; btn.textContent = isReg ? 'Create account & play' : 'Log in';
      shakeNode(form); sfx.deny();
    }
  });

  document.getElementById('guestBtn').addEventListener('click', async e => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Lighting the forge…';
    const u = 'Smith' + Math.floor(1000 + Math.random() * 8999);
    const p = 'g' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    try {
      const r = await api.register(u, p);
      localStorage.setItem('fi_token', r.token);
      localStorage.setItem('fi_user', JSON.stringify(r.user));
      sfx.chime();
      await bootIntoGame(r.snapshot);
    } catch (ex) {
      b.disabled = false; b.textContent = 'Just play — no signup';
      toastErr(humanError(ex.message));
    }
  });
}

/* ================================================================== *
 *  GAME SHELL
 * ================================================================== */
const TABS = [
  { id: 'forge',  label: 'Forge',  icon: '🔥' },
  { id: 'skills', label: 'Skills', icon: '⚒️' },
  { id: 'shop',   label: 'Store',  icon: '🛍️' },
  { id: 'ranks',  label: 'Ranks',  icon: '🏆' },
  { id: 'me',     label: 'You',    icon: '👤' },
];

export function renderShell() {
  host.innerHTML = `
    <header class="hud" id="hud"></header>
    <main class="stage" id="stage"></main>
    <nav class="tabbar" id="tabbar" aria-label="Main">
      ${TABS.map(t => `<button class="tab" data-tab="${t.id}" type="button" aria-label="${t.label}">
        <span class="tab-icon" aria-hidden="true">${t.icon}</span>
        <span class="tab-label">${t.label}</span>
        <span class="tab-dot" hidden></span></button>`).join('')}
    </nav>`;

  if (!wired) {
    wired = true;
    host.addEventListener('click', e => {
      const t = e.target.closest('[data-tab]');
      if (t) { setTab(t.dataset.tab); sfx.click(); haptic(6); return; }
      onStageClick(e);
    });
    host.addEventListener('change', e => {
      const sel = e.target.closest('select[data-slot]');
      if (sel) doEquip(sel.dataset.slot, sel.value || null);
    });
  }
  setTab(currentTab, true);
  startLoopsOnce();
}

export function setTab(id, force = false) {
  if (!force && id === currentTab && document.getElementById('stage')?.childElementCount) { refresh(); return; }
  currentTab = id;
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === id;
    t.classList.toggle('on', on);
    t.setAttribute('aria-current', on ? 'page' : 'false');
  });
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.scrollTop = 0;
  const fn = { forge: renderForge, skills: renderSkills, shop: renderShop, ranks: renderRanks, me: renderMe }[id];
  if (fn) fn(stage);
  updateHud();
  updateTabDots();
  if (id === 'forge') startGoldenClick(); else stopGoldenClick();
}

export function refresh() {
  const stage = document.getElementById('stage');
  if (!stage || !snap()) return;
  const fn = { forge: renderForge, skills: renderSkills, shop: renderShop, ranks: renderRanks, me: renderMe }[currentTab];
  if (fn) fn(stage);
  updateHud();
  updateTabDots();
}

function updateTabDots() {
  const s = snap(); if (!s) return;
  const questReady = (s.quests || []).some(q => q.done && !q.claimed);
  const canStreak = s.state && !s.state.streakClaimed;
  const owned = ownedIds();
  const affordable = (store.offers || []).some(o =>
    !owned.includes(o.item) && o.currency === 'gold' && o.price <= gold());
  const skillReady = (s.skills || []).some(k => k.affordable);
  const setDot = (id, on) => {
    const b = document.querySelector(`.tab[data-tab="${id}"] .tab-dot`);
    if (b) b.hidden = !on;
  };
  setDot('forge', questReady || canStreak);
  setDot('shop', affordable);
  setDot('skills', skillReady || !!(s.prestige && s.prestige.ok));
}

/* ---------------- HUD ---------------- */
export function updateHud() {
  const s = snap(); if (!s) return;
  const hud = document.getElementById('hud');
  if (!hud) return;
  if (!hud.childElementCount) {
    hud.innerHTML = `
      <span class="hud-logo">${LOGO_SVG}</span>
      <div class="hud-res">
        <div class="res res-gold" title="Gold"><span class="res-ic">🪙</span><span class="res-v" id="hudGold" data-val="0">0</span></div>
        <div class="res res-gems" title="Gems"><span class="res-ic">💎</span><span class="res-v" id="hudGems">0</span></div>
        <div class="res res-energy" title="Energy"><span class="res-ic">⚡</span><span class="res-v" id="hudEnergy">0</span></div>
      </div>
      <div class="hud-lvl">
        <div class="lvl-row"><span id="hudLevel">Lv 1</span><span class="gps"><span id="hudGps">0</span>/s</span></div>
        <div class="xpbar" role="progressbar" aria-label="Experience"><i id="hudXp"></i></div>
      </div>
      <button class="hud-gear" data-action="settings" type="button" aria-label="Settings">⚙️</button>`;
  }
  const g = document.getElementById('hudGold');
  if (g) g.textContent = fmt(gold());
  document.getElementById('hudGems').textContent = fmtFull(s.state.gems);
  document.getElementById('hudEnergy').textContent = `${Math.floor(s.state.energy)}/${Math.floor(s.state.energyCap)}`;
  document.getElementById('hudLevel').textContent = 'Lv ' + s.state.level;
  document.getElementById('hudGps').textContent = fmt(dv().gps || 0);
  document.getElementById('hudXp').style.width = (xpPct() * 100).toFixed(1) + '%';
}

/* ================================================================== *
 *  SCREEN: FORGE
 * ================================================================== */
function renderForge(root) {
  const s = snap(); if (!s) return;
  const claimable = (s.quests || []).filter(q => q.done && !q.claimed).length;
  const canStreak = !s.state.streakClaimed;

  root.innerHTML = `
  <section class="screen screen-forge">
    <div class="forge-head">
      <div class="forge-stat">
        <span class="lbl">Per second</span>
        <span class="big" id="forgeGps">${fmt(dv().gps || 0)}</span>
      </div>
      <div class="forge-stat right">
        <span class="lbl">Sparks</span>
        <span class="big ember">✦ ${fmtFull(s.state.sparks)}</span>
        <span class="sub">×${(dv().prestigeMult || 1).toFixed(2)} output</span>
      </div>
    </div>

    <div class="forge-stage" id="forgeStage">
      <div class="forge-glow" aria-hidden="true"></div>
      <button class="forge-btn" id="forgeBtn" type="button" aria-label="Strike the forge">
        <span class="forge-anvil" aria-hidden="true">⚒️</span>
        <span class="forge-ring" aria-hidden="true"></span>
      </button>
      <div class="combo-wrap" id="comboWrap" hidden>
        <span class="combo-x" id="comboX">×1.00</span>
        <span class="combo-bar"><i id="comboBar"></i></span>
      </div>
      <div class="click-hint">Tap the forge · <span id="clickVal">${fmt(dv().clickValue || 1)}</span> per tap</div>
    </div>

    ${canStreak || claimable ? `
    <div class="claim-strip">
      ${canStreak ? `<button class="claim-card" data-action="streak" type="button">
        <span class="cc-ic">📅</span>
        <span class="cc-body"><b>Daily reward ready</b><small>${streakDots(s.state.streakDays)}</small></span>
        <span class="cc-cta">Claim</span></button>` : ''}
      ${claimable ? `<button class="claim-card" data-action="scroll-quests" type="button">
        <span class="cc-ic">🎯</span>
        <span class="cc-body"><b>${claimable} quest${claimable > 1 ? 's' : ''} ready</b><small>Tap to collect</small></span>
        <span class="cc-cta">Go</span></button>` : ''}
    </div>` : ''}

    <div class="panel" id="questPanel">
      <h3 class="panel-h">Daily quests <span class="panel-hint">resets 00:00 UTC</span></h3>
      <div class="quest-list">${(s.quests || []).map(questRowHTML).join('')}</div>
    </div>

    <div class="panel">
      <div class="panel-h row">
        <h3>Generators</h3>
        <div class="qty-switch" role="group" aria-label="Buy quantity">
          ${[1, 10, 100, 'max'].map(q => `<button type="button" data-qty="${q}" class="${buyQty === q ? 'on' : ''}">${q === 'max' ? 'MAX' : '×' + q}</button>`).join('')}
        </div>
      </div>
      <div class="gen-list" id="genList">${(s.gens || []).map(genRowHTML).join('')}</div>
    </div>

    <div class="panel">
      <h3 class="panel-h">Prestige</h3>
      ${prestigeHTML(s)}
    </div>
  </section>`;

  wireForge(root);
}

function questRowHTML(q) {
  const pct = clamp(q.progress / Math.max(1, q.target), 0, 1);
  const ready = q.done && !q.claimed;
  return `<div class="quest ${ready ? 'ready' : ''} ${q.claimed ? 'claimed' : ''}">
    <div class="q-main">
      <span class="q-name">${esc(q.name)}</span>
      <span class="q-prog">${fmt(q.progress)} / ${fmt(q.target)}</span>
    </div>
    <div class="q-bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
    <div class="q-foot">
      <span class="q-reward">${q.reward.gold ? `🪙 ${fmtPrice(q.reward.gold)}` : ''}${q.reward.gems ? ` 💎 ${q.reward.gems}` : ''}${q.reward.xp ? ` ✨${fmt(q.reward.xp)}` : ''}</span>
      ${q.claimed ? '<span class="q-done">Claimed ✓</span>'
        : `<button class="btn ${ready ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}" type="button"
             data-action="claim-quest" data-id="${attr(q.id)}" ${ready ? '' : 'disabled'}>${ready ? 'Claim' : 'In progress'}</button>`}
    </div></div>`;
}

function costGrowthOf(id) {
  const g = (cfg()?.generators || []).find(x => x.id === id);
  return g ? g.cost_growth : 1.15;
}
function redOf(s) {
  const b = (s.skills || []).find(x => x.id === 'bargainer');
  if (!b) return 0;
  const def = (cfg()?.skills || []).find(x => x.id === 'bargainer');
  return Math.min(0.25, (def?.per_level ?? 0.01) * b.level);
}
/** g.cost already carries the Bargainer discount, so the geometric sum must not reapply it. */
function bulkCostRaw(nextCost, growth, qty) {
  return nextCost * (Math.pow(growth, qty) - 1) / (growth - 1);
}
function maxAffordableRaw(nextCost, growth, goldNow) {
  if (goldNow < nextCost) return 0;
  return Math.max(0, Math.floor(Math.log(goldNow * (growth - 1) / nextCost + 1) / Math.log(growth)));
}

function genRowHTML(g) {
  if (!g.unlocked) {
    return `<div class="gen locked">
      <span class="gen-ic">🔒</span>
      <span class="gen-body"><b>???</b><small>Reach level ${g.need_prev} of the previous generator</small></span>
    </div>`;
  }
  const growth = costGrowthOf(g.id);
  const qty = buyQty === 'max' ? Math.max(1, maxAffordableRaw(g.cost, growth, gold())) : buyQty;
  const total = bulkCostRaw(g.cost, growth, qty);
  const can = gold() >= total;
  const perSec = g.prod_each * (dv().prestigeMult || 1) * (dv().skillMult || 1);
  return `<div class="gen ${can ? 'can' : 'cant'}" data-gen="${attr(g.id)}">
    <span class="gen-ic" aria-hidden="true">${g.icon}</span>
    <span class="gen-body">
      <b>${esc(g.name)} <em class="gen-lv">Lv ${fmtFull(g.level)}</em></b>
      <small>+${fmt(perSec)}/s each · now ${fmt(g.prod_now)}/s</small>
    </span>
    <button class="gen-buy ${can ? '' : 'disabled'}" type="button" data-action="buy-gen" data-id="${attr(g.id)}" data-qty="${qty}"
            aria-label="Buy ${qty} ${attr(g.name)} for ${fmtPrice(total)} gold">
      <span class="gb-qty">${buyQty === 'max' ? 'MAX' : '×' + qty}</span>
      <span class="gb-cost">🪙 ${fmtPrice(total)}</span>
    </button>
  </div>`;
}

function prestigeHTML(s) {
  const p = s.prestige || {};
  const ready = !!p.ok;
  const prog = clamp((s.state.runGold || 0) / Math.max(1, p.need_gold || 1), 0, 1);
  return `<div class="prestige ${ready ? 'ready' : ''}">
    <p class="p-lead">${ready
      ? `Reset the forge for <b class="ember">✦ ${fmtFull(p.potential)}</b> sparks → <b class="ember">×${(p.new_mult || 1).toFixed(2)}</b> output <u>forever</u>.`
      : `Earn <b>🪙 ${fmt(p.need_gold || 0)}</b> lifetime gold this run to unlock your next prestige.`}</p>
    <div class="q-bar"><i style="width:${(prog * 100).toFixed(2)}%"></i></div>
    <div class="p-foot">
      <span class="small">Run gold 🪙 ${fmt(s.state.runGold || 0)} · Prestiges ${fmtFull(s.state.prestigeCount || 0)}</span>
      <button class="btn ${ready ? 'btn-primary' : 'btn-ghost'} btn-sm" type="button" data-action="prestige" ${ready ? '' : 'disabled'}>
        ${ready ? 'Prestige now' : 'Locked'}</button>
    </div>
    <p class="p-keep small">You keep: cosmetics, titles, achievements, collection, sparks.</p>
  </div>`;
}

function streakDots(days) {
  const inCycle = ((Math.max(0, days) - 1) % 7 + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => `<i class="dot ${i <= inCycle ? 'on' : ''} ${i === 6 ? 'big' : ''}"></i>`).join('');
}

/* ---------------- forge interactions ---------------- */
function wireForge(root) {
  const btn = document.getElementById('forgeBtn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';

  let down = false, holdTimer = 0, held = 0;

  const doClick = (x, y) => {
    if (!snap()) return;
    registerClick(1);
    const s = snap();
    const fx = clickFx(s.loadout, s.catalog) || { count: 10, color: '#FF7A18', life: 620, glow: true };
    burst(x, y, { count: fx.count, color: fx.color, life: fx.life, glow: fx.glow });
    const per = (dv().clickValue || 1) * (1 + Math.min(1, 0.02 * Math.min(50, store.combo)));
    floatText(x + (Math.random() * 24 - 12), y - 14, '+' + fmt(per), 'f-gold');
    sfx.click(); haptic(8);
    updateCombo();
    updateHud();
  };

  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    down = true; held = 0;
    btn.classList.add('down');
    doClick(e.clientX, e.clientY);
    // hold-to-repeat at ~9/s: fast and satisfying, still under the anti-cheat ceiling
    holdTimer = setInterval(() => {
      if (!down) return;
      held++;
      const r = btn.getBoundingClientRect();
      doClick(r.left + r.width / 2 + (Math.random() * 44 - 22),
              r.top + r.height / 2 + (Math.random() * 44 - 22));
    }, 110);
  });
  const endHold = () => {
    if (!down) return;
    down = false; btn.classList.remove('down'); clearInterval(holdTimer);
    if (held > 0) sync(true);
  };
  btn.addEventListener('pointerup', endHold);
  btn.addEventListener('pointercancel', endHold);
  btn.addEventListener('pointerleave', endHold);
  btn.addEventListener('contextmenu', e => e.preventDefault());

  root.querySelectorAll('.qty-switch button').forEach(b => b.addEventListener('click', () => {
    const q = b.dataset.qty;
    buyQty = q === 'max' ? 'max' : parseInt(q, 10);
    sfx.click();
    root.querySelectorAll('.qty-switch button').forEach(x => x.classList.toggle('on', x === b));
    const list = document.getElementById('genList');
    if (list) list.innerHTML = (snap()?.gens || []).map(genRowHTML).join('');
  }));

  startGoldenClick();
}

function updateCombo() {
  const w = document.getElementById('comboWrap');
  if (!w) return;
  const c = store.combo;
  if (c < 3) { w.hidden = true; return; }
  w.hidden = false;
  const m = 1 + Math.min(1, 0.02 * Math.min(50, c));
  document.getElementById('comboX').textContent = '×' + m.toFixed(2);
  const bar = document.getElementById('comboBar');
  if (bar) bar.style.width = (clamp(1 - (Date.now() - store.comboAt) / 2000, 0, 1) * 100).toFixed(1) + '%';
}

/* ---------------- Golden Click (variable-ratio reward) ---------------- */
function startGoldenClick() {
  stopGoldenClick();
  const c = cfg()?.golden_click || { min_spawn_secs: 45, max_spawn_secs: 180 };
  const schedule = () => {
    goldenTimer = setTimeout(spawn, (c.min_spawn_secs + Math.random() * (c.max_spawn_secs - c.min_spawn_secs)) * 1000);
  };
  const spawn = () => {
    if (currentTab !== 'forge' || document.hidden) { schedule(); return; }
    const stage = document.getElementById('forgeStage');
    if (!stage) { schedule(); return; }
    const n = document.createElement('button');
    n.className = 'golden'; n.type = 'button'; n.textContent = '🌟';
    n.setAttribute('aria-label', 'Golden click — claim the bonus');
    n.style.left = (10 + Math.random() * 68) + '%';
    n.style.top = (6 + Math.random() * 62) + '%';
    stage.appendChild(n);
    goldenEl = n;
    n.addEventListener('click', () => {
      const r = n.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      n.remove(); goldenEl = null;
      burst(x, y, { count: 46, color: '#FFD166', glow: true, spread: 6, life: 1100 });
      flash('rgba(255,209,102,.30)', 260);
      shake(6, 260);
      sfx.chime(); haptic([15, 30, 40]);
      const roll = Math.random();
      const taps = roll < 0.6 ? 60 : roll < 0.95 ? 150 : 400;
      registerClick(taps);
      floatText(x, y, `×${taps} TAP BURST`, 'f-crit');
      toastGold(`Golden Click — ${taps} taps credited!`);
      updateHud();
      sync(true);
      schedule();
    });
    setTimeout(() => {
      if (goldenEl !== n) return;
      n.classList.add('fade');
      setTimeout(() => n.remove(), 500);
      goldenEl = null;
      schedule();
    }, 9000);
  };
  schedule();
}
function stopGoldenClick() {
  clearTimeout(goldenTimer); goldenTimer = 0;
  if (goldenEl) { goldenEl.remove(); goldenEl = null; }
}

/** Level-milestone gifts are how a new player discovers the customization
 *  system. They get a proper reveal, not a toast. */
function celebrateGifts(gifts) {
  if (!Array.isArray(gifts) || !gifts.length) return;
  const cat = snap()?.catalog || {};
  const itemGift = gifts.find(g => g.item);
  const gems = gifts.reduce((n, g) => n + (g.gems || 0), 0);
  if (itemGift) {
    const it = cat[itemGift.item] || item(itemGift.item);
    if (it) {
      emberRain(34, '#FFB020');
      revealReward({ name: it.name, rarity: it.rarity, slot: it.slot,
                     css: cssFor(it) || RARITY_CSS[it.rarity], isNew: true });
      return;
    }
  }
  if (gems) { sfx.coin(); confetti(innerWidth / 2, innerHeight * 0.4, 26); toastGold(`Level reward · 💎 ${gems}`); }
}

/* ================================================================== *
 *  SCREEN: SKILLS
 * ================================================================== */
const SKILL_EFF = {
  click_value:    v => `+${(v * 100).toFixed(0)}% tap value`,
  gps:            v => `+${(v * 100).toFixed(0)}% output`,
  offline:        v => `+${(v * 100).toFixed(0)}% offline rate & cap`,
  drop_rate:      v => `+${(v * 100).toFixed(0)}% luck`,
  cost_reduction: v => `−${(v * 100).toFixed(0)}% upgrade costs`,
  energy:         v => `+${v.toFixed(0)} energy cap`,
  battle_power:   v => `+${(v * 100).toFixed(0)}% battle power`,
  tax_reduction:  v => `−${(v * 100).toFixed(1)}% market tax`,
  quest_reward:   v => `+${(v * 100).toFixed(0)}% quest rewards`,
  streak_freeze:  v => `+${v.toFixed(0)} streak freeze`,
};

function renderSkills(root) {
  const s = snap(); if (!s) return;
  root.innerHTML = `<section class="screen">
    <h2 class="screen-h">Skills</h2>
    <p class="screen-sub">Permanent for this run. Prestige resets them — and pays you back in sparks.</p>
    <div class="skill-list">
      ${(s.skills || []).map(k => {
        const f = SKILL_EFF[k.effect] || (x => String(x));
        const eff = f(k.per_level * k.level);
        const nxt = f(k.per_level * (k.level + 1));
        return `<div class="skill ${k.maxed ? 'maxed' : k.affordable ? 'can' : 'cant'}">
          <span class="sk-body">
            <b>${esc(k.name)} <em>Lv ${k.level}/${k.max}</em></b>
            <small>${k.level ? eff : 'Not trained'}${k.maxed ? '' : ` → <span class="nxt">${nxt}</span>`}</small>
            <span class="sk-pips">${Array.from({ length: Math.min(k.max, 20) }, (_, i) =>
              `<i class="${i < k.level ? 'on' : ''}"></i>`).join('')}</span>
          </span>
          <button class="btn ${k.maxed ? 'btn-ghost' : k.affordable ? 'btn-primary' : 'btn-ghost'} btn-sm" type="button"
            data-action="buy-skill" data-id="${attr(k.id)}" data-name="${attr(k.name)}" ${k.maxed || !k.affordable ? 'disabled' : ''}>
            ${k.maxed ? 'Maxed' : '🪙 ' + fmtPrice(k.cost)}</button>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

/* ================================================================== *
 *  SCREEN: SHOP
 * ================================================================== */
function ownedIds() { return (snap()?.owned || []).map(o => o.item_id); }
const serverNowLocal = () => (snap()?.serverTime || Math.floor(Date.now() / 1000));
const countCrates = cat => Object.values(cat || {}).filter(c => c.slot === 'crate').length;

let shopTab = 'cosmetics';
function renderShop(root) {
  const s = snap(); if (!s) return;
  const ctx = { s, offers: store.offers || [], owned: ownedIds(), cat: s.catalog || {} };
  root.innerHTML = `<section class="screen">
    <h2 class="screen-h">Store</h2>
    <div class="seg" role="tablist" aria-label="Store sections">
      ${[['cosmetics', 'Cosmetics'], ['crates', 'Crates'], ['gems', 'Gems'], ['owned', `Owned (${ctx.owned.length})`]]
        .map(([id, l]) => `<button role="tab" aria-selected="${shopTab === id}" class="${shopTab === id ? 'on' : ''}" data-shoptab="${id}" type="button">${l}</button>`).join('')}
    </div>
    <div id="shopBody">${shopBodyHTML(shopTab, ctx)}</div>
  </section>`;

  root.querySelectorAll('[data-shoptab]').forEach(b => b.addEventListener('click', () => {
    shopTab = b.dataset.shoptab;
    root.querySelectorAll('[data-shoptab]').forEach(x => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
    document.getElementById('shopBody').innerHTML = shopBodyHTML(shopTab, ctx);
    sfx.click();
  }));
}

function shopBodyHTML(tab, { s, offers, owned, cat }) {
  if (tab === 'owned') {
    if (!owned.length) return `<p class="empty">Nothing yet — your collection starts with the first crate.</p>`;
    const total = Object.keys(cat).length - countCrates(cat);
    return `<div class="inv-grid">${owned.map(id => {
      const it = cat[id] || item(id);
      if (!it) return '';
      const eq = Object.values(s.loadout || {}).includes(id);
      return `<div class="inv-item">
        ${itemCardHTML({ ...it, id }, { owned: true, action: 'open-shop-item' })}
        <div class="inv-actions">
          ${eq ? `<button class="btn btn-ghost btn-sm" type="button" data-action="unequip" data-slot="${attr(it.slot)}">Unequip</button>`
               : `<button class="btn btn-primary btn-sm" type="button" data-action="equip" data-slot="${attr(it.slot)}" data-item="${attr(id)}">Equip</button>`}
        </div></div>`;
    }).join('')}</div>
    <div class="collection-bar"><span>${owned.length} / ${total} collected</span>
      <div class="q-bar"><i style="width:${(owned.length / Math.max(1, total) * 100).toFixed(1)}%"></i></div></div>`;
  }

  if (tab === 'crates') {
    const crates = s.crates || [];
    return crates.map(c => {
      const freeIn = Math.max(0, (s.state.lastFreeCrate || 0) + (c.free_cooldown_hours || 0) * 3600 - serverNowLocal());
      const freeReady = c.free_cooldown_hours > 0 && freeIn <= 0;
      const ownedCrates = (s.owned || []).filter(o => o.item_id === c.id).reduce((n, o) => n + (o.qty || 1), 0);
      return `<div class="crate-card">
        <div class="crate-art" aria-hidden="true">📦</div>
        <div class="crate-body">
          <h3>${esc(c.name)}</h3>
          <p class="small">One random cosmetic. Duplicates convert to gold. Full odds are always public.${ownedCrates ? ` <b>You hold ${ownedCrates}.</b>` : ''}</p>
          <div class="crate-actions">
            ${ownedCrates ? `<button class="btn btn-primary" type="button" data-action="open-crate" data-id="${attr(c.id)}" data-free="0">Open one</button>` : ''}
            ${c.free_cooldown_hours > 0 ? `<button class="btn ${freeReady ? 'btn-primary' : 'btn-ghost'}" type="button"
                 data-action="open-crate" data-id="${attr(c.id)}" data-free="1" ${freeReady ? '' : 'disabled'}>
                 ${freeReady ? 'Open free crate' : 'Free in ' + dur(freeIn)}</button>` : ''}
            ${c.price_gems ? `<button class="btn ${s.state.gems >= c.price_gems ? 'btn-primary' : 'btn-ghost'}" type="button"
                 data-action="buy-crate" data-id="${attr(c.id)}" ${s.state.gems >= c.price_gems ? '' : 'disabled'}>Buy · 💎 ${c.price_gems}</button>` : ''}
            <button class="btn btn-ghost btn-sm" type="button" data-action="show-odds" data-id="${attr(c.id)}">See odds</button>
          </div>
        </div></div>`;
    }).join('') + `<div class="notice">
      <b>Fair play rules.</b> Odds are published before you buy. Items from paid crates cannot be traded.
      Nothing you buy with money makes you stronger — cosmetics only.</div>`;
  }

  if (tab === 'gems') {
    return `<div class="pack-list">${(s.packs || []).map(p => `
      <div class="pack ${p.featured ? 'featured' : ''}">
        ${p.featured ? '<span class="pack-flag">Best value</span>' : ''}
        <div class="pack-gems">💎 ${fmtFull(p.gems)}</div>
        ${p.bonus ? `<div class="pack-bonus">+${p.bonus}% bonus</div>` : ''}
        <div class="pack-usd">$${Number(p.usd).toFixed(2)}</div>
        <button class="btn btn-primary btn-block" type="button" data-action="buy-pack" data-pack="${attr(p.id)}">Buy with crypto</button>
      </div>`).join('')}</div>
      <div class="notice">
        <b>How payment works.</b> You pay in crypto (USDT, USDC, BTC, ETH, LTC, TON) through a licensed gateway.
        The quote locks for 15 minutes. Gems are credited once the network confirms — exactly once, even if you reload.
        <br><br><b>There is no way to convert anything back into money.</b> No withdrawals, no cash-out, no trading of paid items.
        ${s.payProvider ? '' : '<br><br><span class="warn-inline">Payments are currently in demo mode — no real money moves.</span>'}
      </div>
      <div class="free-gems">
        <h4>Earning gems without paying</h4>
        <p class="small">Daily quests, streaks, achievements and level milestones give roughly
        <b>~880 gems a month</b> — about one epic cosmetic. Paying is a time-saver and a way to support the game, never a requirement.</p>
      </div>`;
  }

  // cosmetics
  const groups = {};
  for (const o of offers) {
    if (o.slot === 'crate') continue;
    (groups[o.slot] ||= []).push(o);
  }
  const order = ['frame', 'avatar', 'background', 'title', 'win_fx', 'click_fx', 'pet', 'theme', 'sound', 'signature', 'banner', 'badge'];
  const html = order.filter(sl => groups[sl]).map(sl => `
    <div class="shop-group">
      <h3 class="group-h">${slotIcon(sl)} ${esc(sl.replace(/_/g, ' '))}</h3>
      <div class="shop-grid">${groups[sl].map(o => {
        const base = cat[o.item] || {};
        const it = { ...base, id: o.item, name: o.name, slot: o.slot, rarity: o.rarity, css: base.css ?? o.css };
        const isOwned = owned.includes(o.item);
        const afford = o.currency === 'gold' ? gold() >= o.price : s.state.gems >= o.price;
        return itemCardHTML(it, { owned: isOwned, price: o.price, currency: o.currency, affordable: afford, action: 'open-shop-item' });
      }).join('')}</div>
    </div>`).join('');
  return html || '<p class="empty">The store is restocking.</p>';
}

function openItemSheet(id) {
  const s = snap(); if (!s) return;
  const cat = s.catalog || {};
  const it = cat[id] || item(id);
  if (!it) return;
  const offer = (store.offers || []).find(o => o.item === id);
  const isOwned = ownedIds().includes(id);
  const equipped = Object.entries(s.loadout || {}).some(([, v]) => v === id);
  const css = cssFor(it) || RARITY_CSS[it.rarity] || '';

  modal({
    title: null, kind: 'item',
    body: `<div class="item-detail">
      <div class="id-art r-${esc(it.rarity)}" style="${attr(css)}">${slotIcon(it.slot)}</div>
      <h3>${esc(it.name)}</h3>
      <p class="id-rarity r-${esc(it.rarity)}-text">${RARITY_ICON[it.rarity] || ''} ${esc(rarityLabel(it.rarity))} · ${esc(String(it.slot).replace(/_/g, ' '))}</p>
      <p class="id-note">${noteFor(it)}</p>
      ${offer && !isOwned ? `<p class="id-price">${offer.currency === 'gems' ? '💎' : '🪙'} <b>${fmtFull(offer.price)}</b></p>` : ''}
      ${offer?.stockLeft ? `<p class="id-stock small">Only ${offer.stockLeft} left in this edition</p>` : ''}
      ${offer?.endsAt ? `<p class="id-stock small">Leaves the store in ${dur(offer.endsAt - serverNowLocal())}</p>` : ''}
    </div>`,
    actions: isOwned
      ? (equipped
          ? [{ label: 'Unequip', class: 'btn-ghost', onClick: () => doEquip(it.slot, null) }, { label: 'Close', class: 'btn-ghost' }]
          : [{ label: 'Equip', class: 'btn-primary', onClick: () => doEquip(it.slot, id) }, { label: 'Close', class: 'btn-ghost' }])
      : offer
        ? [{ label: 'Close', class: 'btn-ghost' },
           { label: offer.currency === 'gems' ? `Buy · 💎 ${fmtFull(offer.price)}` : `Buy · 🪙 ${fmtPrice(offer.price)}`,
             class: 'btn-primary', onClick: () => buyOffer(offer.id) }]
        : [{ label: 'Close', class: 'btn-ghost' }],
  });
}

function noteFor(it) {
  const notes = {
    frame: 'Shown around your avatar everywhere — chat, ranks, battles and your public profile.',
    avatar: 'Your portrait. Animated portraits move on every screen that shows you.',
    background: 'The backdrop of your public profile page.',
    title: 'Displayed under your name on every screen other players see.',
    win_fx: 'Plays on the battle result screen — your opponent watches it too.',
    click_fx: 'Particles that follow every tap on the forge. Only you see these.',
    pet: 'A companion that sits on your forge screen and profile.',
    theme: 'Reskins the whole game for you. Purely visual, no advantage.',
    sound: 'A different set of forge sounds. Everything is muted by default.',
    signature: 'Unlocks a custom line of text on your public profile.',
    banner: 'Your clan banner, shown in wars and on the clan leaderboard.',
    badge: 'Earned, never sold. Proof of what you actually did.',
  };
  return notes[it.slot] || 'A cosmetic. It changes how you look, never how strong you are.';
}

async function buyOffer(offerId) {
  const o = (store.offers || []).find(x => x.id === offerId);
  if (!o) return;
  const s = snap();
  const have = o.currency === 'gold' ? gold() : s.state.gems;
  if (have < o.price) {
    sfx.deny();
    toastErr(o.currency === 'gold' ? 'Not enough gold yet' : 'Not enough gems — see the Gems tab');
    return;
  }
  const r = await actions.buy(o.id);
  if (!r.ok) { sfx.deny(); toastErr(humanError(r.error)); return; }
  sfx.buy(); haptic(20);
  if (r.slot === 'crate') {
    toastOk(`Bought ${r.name}`);
    await sync(false);
    openCrate(r.item, false);
    return;
  }
  const it = (snap()?.catalog || {})[r.item] || item(r.item);
  if (it) {
    revealReward({ name: it.name, rarity: it.rarity, slot: it.slot, css: cssFor(it) || RARITY_CSS[it.rarity], isNew: true });
    if (it.rarity === 'legendary' || it.rarity === 'limited') emberRain(70, '#FBBF24');
    const yes = await confirmDialog({ title: 'Equip it now?', message: `${it.name} will replace whatever is in that slot.`, confirmLabel: 'Equip' });
    if (yes) { await doEquip(it.slot, it.id, true); return; }
  } else {
    toastOk(`Bought ${r.name}`);
  }
  refresh();
}

async function openCrate(id, free) {
  const r = await actions.openCrate(id, free);
  if (!r.ok) { sfx.deny(); toastErr(humanError(r.error)); return; }
  const rw = r.reward || {};
  const it = (snap()?.catalog || {})[rw.item] || item(rw.item);
  if (rw.type === 'dupe') {
    revealReward({ name: rw.name, rarity: rw.rarity, slot: it?.slot, css: it ? (cssFor(it) || RARITY_CSS[it.rarity]) : '', dupe: true, gold: rw.gold });
    sfx.coin();
  } else if (it) {
    revealReward({ name: it.name, rarity: it.rarity, slot: it.slot, css: cssFor(it) || RARITY_CSS[it.rarity], isNew: true });
    if (it.rarity === 'legendary' || it.rarity === 'limited') emberRain(80, '#FBBF24');
  }
  refresh();
}

function showOdds(id) {
  const c = (snap()?.crates || []).find(x => x.id === id);
  if (!c) return;
  modal({ title: `${c.name} — drop rates`, body: oddsTableHTML(c.odds), kind: 'odds',
          actions: [{ label: 'Got it', class: 'btn-primary' }] });
}

async function doEquip(slot, itemId, silent) {
  const r = await actions.equip(slot, itemId);
  if (!r.ok) { toastErr(humanError(r.error)); sfx.deny(); return; }
  sfx.buy(); haptic(12);
  if (!silent) toastOk(itemId ? 'Equipped' : 'Slot cleared');
  if (slot === 'theme') {
    const th = themeFromLoadout(r.loadout || snap()?.loadout, snap()?.catalog);
    document.documentElement.setAttribute('data-theme', th || 'ember');
  }
  refresh();
}

async function buyPack(packId) {
  const s = snap();
  const pack = (s.packs || []).find(p => p.id === packId);
  if (!pack) return;
  if (!s.payProvider) {
    const ok = await confirmDialog({
      title: 'Demo mode',
      message: `Payments are not connected yet, so no real money moves. Simulate buying ${pack.label} ($${pack.usd}) and receive ${fmtFull(pack.gems)} gems?`,
      confirmLabel: 'Simulate purchase',
    });
    if (!ok) return;
    const inv = await api.createPay(packId);
    if (!inv.ok) { toastErr('Could not create the invoice'); return; }
    const r = await api.confirmDemoPay(inv.idem);
    if (r.ok) {
      sfx.coin(); emberRain(40, '#2DD4BF');
      toastGold(`+${fmtFull(r.gems || pack.gems)} gems (demo)`);
      await sync(false); refresh();
    } else toastErr(humanError(r.error));
    return;
  }
  const inv = await api.createPay(packId);
  if (!inv.ok) { toastErr('Could not start the payment'); return; }
  if (inv.checkout) location.href = inv.checkout;
  else toastErr('The gateway did not return a checkout link');
}

/* ================================================================== *
 *  SCREEN: RANKS
 * ================================================================== */
function renderRanks(root) {
  const s = snap(); if (!s) return;
  const lb = store.leaderboard || [];
  const cat = s.catalog || {};
  const meName = getUser()?.username;
  root.innerHTML = `<section class="screen">
    <h2 class="screen-h">Leaderboard</h2>
    <p class="screen-sub">You are <b>#${fmtFull(store.myRank || 0)}</b> by lifetime gold · ${fmtFull(s.online || 0)} smiths online</p>
    <div class="lb">
      ${lb.length ? lb.map(p => `<div class="lb-row ${p.username === meName ? 'me' : ''}">
        <span class="lb-rank">${p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : '#' + p.rank}</span>
        <button class="lb-id" type="button" data-action="view-profile" data-user="${attr(p.username)}">
          ${avatarHTML(p.loadout, cat, { size: 38, username: p.username })}
          <span class="lb-name">${esc(p.username)}<span class="lb-sub">${titleHTML(p.loadout, cat)} Lv ${fmtFull(p.level)} · ✦ ${fmtFull(p.sparks)}</span></span>
        </button>
        <span class="lb-score">🪙 ${fmt(p.totalGold)}</span>
      </div>`).join('') : '<p class="empty">No rankings yet — be the first.</p>'}
    </div>
    <h2 class="screen-h mt">Achievements</h2>
    <div class="ach-list">${(s.achievements || []).map(a => `<div class="ach ${a.unlocked ? 'on' : ''}">
      <span class="ach-ic" aria-hidden="true">${a.unlocked ? '🏅' : '🔒'}</span>
      <span class="ach-body"><b>${esc(a.name)}</b><small>${esc(a.desc)}</small>
        <span class="q-bar"><i style="width:${(clamp(a.progress / Math.max(1, a.target), 0, 1) * 100).toFixed(1)}%"></i></span></span>
      <span class="ach-prog">${fmt(a.progress)}/${fmt(a.target)}</span></div>`).join('')}</div>
  </section>`;
}

export async function viewProfile(username) {
  try {
    const r = await api.profile(username);
    const p = r.profile;
    modal({
      title: null, kind: 'profile',
      body: `<div class="pub-profile">
        <div class="pp-top">
          ${avatarHTML(p.loadout, p.catalog, { size: 72, username: p.username })}
          <div><h3>${esc(p.username)}</h3>
          <p class="pp-sub">${titleHTML(p.loadout, p.catalog)} ${badgeHTML(p.loadout, p.catalog)}</p>
          ${p.signature ? `<p class="pp-sig">${esc(p.signature)}</p>` : ''}</div>
        </div>
        <div class="pp-stats">
          <div><b>Lv ${fmtFull(p.level)}</b><small>level</small></div>
          <div><b>✦ ${fmtFull(p.sparks)}</b><small>sparks</small></div>
          <div><b>${fmt(p.gps)}</b><small>per second</small></div>
          <div><b>#${fmtFull(p.rank)}</b><small>rank</small></div>
          <div><b>${fmt(p.totalGold)}</b><small>lifetime gold</small></div>
          <div><b>${p.collection.owned}/${p.collection.total}</b><small>collection</small></div>
        </div>
        <p class="small">Joined ${p.joinedDays} day${p.joinedDays === 1 ? '' : 's'} ago · ${fmtFull(p.totalClicks)} taps · ${p.streak}-day streak · ${p.achievements} achievements</p>
      </div>`,
      actions: [{ label: 'Close', class: 'btn-primary' }],
    });
  } catch { toastErr('Could not load that profile'); }
}

/* ================================================================== *
 *  SCREEN: ME
 * ================================================================== */
function renderMe(root) {
  const s = snap(); if (!s) return;
  const cat = s.catalog || {};
  const me = getUser() || {};
  const owned = ownedIds();
  const cosmeticCount = Object.values(cat).filter(i => i.slot !== 'crate').length;

  root.innerHTML = `<section class="screen">
    <div class="me-hero">
      <div class="me-avatar">${avatarHTML(s.loadout, cat, { size: 96, username: me.username })}</div>
      <h2 class="me-name">${esc(me.username || '')}</h2>
      <p class="me-titles">${titleHTML(s.loadout, cat)} ${badgeHTML(s.loadout, cat)}</p>
      <div class="me-stats">
        <div><b>Lv ${fmtFull(s.state.level)}</b><small>level</small></div>
        <div><b>✦ ${fmtFull(s.state.sparks)}</b><small>sparks</small></div>
        <div><b>${fmt(dv().gps)}</b><small>per second</small></div>
        <div><b>#${fmtFull(store.myRank || 0)}</b><small>rank</small></div>
      </div>
      <div class="me-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-action="share-profile">Share profile</button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="settings">Settings</button>
      </div>
    </div>

    <div class="panel">
      <h3 class="panel-h">Customize <span class="panel-hint">${owned.length} owned</span></h3>
      <div class="slots">
        ${(s.slots || []).map(slot => {
          const eqId = (s.loadout || {})[slot];
          const it = eqId ? cat[eqId] : null;
          const opts = owned.filter(id => (cat[id] || {}).slot === slot);
          return `<div class="slot-row">
            <span class="slot-ic" aria-hidden="true">${slotIcon(slot)}</span>
            <span class="slot-body"><b>${esc(slot.replace(/_/g, ' '))}</b>
              <small>${it ? esc(it.name) : (opts.length ? 'Not equipped' : 'Nothing owned yet')}</small></span>
            <span class="slot-ctl">
              ${opts.length > 1 ? `<select data-slot="${attr(slot)}" class="sel" aria-label="${attr(slot)}">
                <option value="">— none —</option>
                ${opts.map(id => `<option value="${attr(id)}" ${id === eqId ? 'selected' : ''}>${esc((cat[id] || {}).name || id)}</option>`).join('')}
              </select>` : (it ? `<button class="btn btn-ghost btn-sm" type="button" data-action="unequip" data-slot="${attr(slot)}">Remove</button>` : '')}
            </span>
          </div>`;
        }).join('')}
      </div>
      <label class="field inline">
        <span>Profile signature</span>
        <input id="sigInput" maxlength="120" placeholder="One line other players will see"
               value="${attr((s.settings || {}).signature || '')}" />
      </label>
      <button class="btn btn-primary btn-block" type="button" data-action="save-sig">Save signature</button>
    </div>

    <div class="panel">
      <h3 class="panel-h">Collection</h3>
      <div class="album">${Object.values(cat).filter(i => i.slot !== 'crate').map(it => {
        const has = owned.includes(it.id);
        return `<div class="album-cell ${has ? 'has' : 'no'} r-${attr(it.rarity)}" title="${attr(it.name)}">
          <span class="ac-art" style="${attr(has ? (cssFor(it) || RARITY_CSS[it.rarity] || '') : '')}">${has ? slotIcon(it.slot) : '?'}</span>
          <span class="ac-name">${has ? esc(it.name) : 'Locked'}</span></div>`;
      }).join('')}</div>
      <p class="small">Owned ${owned.length} of ${cosmeticCount}. Completing a set is worth more than any single item.</p>
    </div>
  </section>`;
}

function shareProfile() {
  const u = getUser()?.username || '';
  const url = location.origin + location.pathname.replace(/index\.html$/, '') + '?u=' + encodeURIComponent(u);
  if (navigator.share) navigator.share({ title: 'Forge Infinite', text: `My forge: ${u}`, url }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toastOk('Profile link copied'), () => toastErr(url));
  else toastErr(url);
}

/* ================================================================== *
 *  SETTINGS
 * ================================================================== */
function openSettings() {
  const s = snap() || {};
  const set = s.settings || {};
  const on = (k, dflt = true) => (set[k] === undefined ? dflt : !!set[k]);
  const row = (key, label, hint, dflt = true) => `<label class="set-row">
      <span><b>${label}</b><small>${hint}</small></span>
      <input type="checkbox" data-set="${key}" ${on(key, dflt) ? 'checked' : ''} />
    </label>`;
  modal({
    title: 'Settings', kind: 'settings',
    body: `<div class="settings">
      ${row('sound', 'Sound', 'Synthesised in the browser — no downloads')}
      ${row('haptics', 'Haptics', 'Vibration on mobile')}
      ${row('particles', 'Particles', 'Embers and sparks')}
      ${row('reducedMotion', 'Reduced motion', 'No shake, no count-up animations', false)}
      ${row('calmMode', 'Calm mode', 'Hides timers, crates and store pressure. The game stays fully playable.', false)}
      <hr/>
      <p class="small">Account: <b>${esc(getUser()?.username || '')}</b></p>
      <button class="btn btn-ghost btn-block" type="button" data-act="logout">Log out</button>
      <p class="small dim">Forge Infinite v1.0 · progress lives on the server · no ads, no forced waiting, no pay-to-win.</p>
    </div>`,
    actions: [{ label: 'Done', class: 'btn-primary' }],
    onMount: m => {
      m.panel.querySelectorAll('input[data-set]').forEach(inp => inp.addEventListener('change', async () => {
        const patch = { [inp.dataset.set]: inp.checked };
        await actions.saveSettings(patch);
        emit('settings', patch);
        if (inp.dataset.set === 'calmMode') document.body.classList.toggle('calm', inp.checked);
        if (inp.dataset.set === 'sound' && inp.checked) sfx.click();
      }));
      m.panel.querySelector('[data-act=logout]').addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Log out?', message: 'Your progress stays safe on the server.', confirmLabel: 'Log out', danger: true });
        if (!ok) return;
        await api.logout();
        m.close();
        resetAuth();
      });
    },
  });
}

/* ================================================================== *
 *  Delegated action handler
 * ================================================================== */
function onStageClick(e) {
  const b = e.target.closest('[data-action]');
  if (!b || b.disabled) return;
  const a = b.dataset.action;

  switch (a) {
    case 'settings': openSettings(); return;
    case 'share-profile': shareProfile(); return;
    case 'save-sig': {
      const v = document.getElementById('sigInput')?.value ?? '';
      actions.saveSettings({ signature: v }).then(r => {
        if (r.ok) { toastOk('Signature saved'); refresh(); } else toastErr('Could not save');
      });
      return;
    }
    case 'scroll-quests':
      document.getElementById('questPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    case 'streak': claimStreak(); return;
    case 'prestige': doPrestige(); return;
    case 'view-profile': viewProfile(b.dataset.user); return;

    case 'buy-gen': {
      const id = b.dataset.id, qty = parseInt(b.dataset.qty || '1', 10);
      actions.buyGen(id, qty).then(r => {
        if (r.ok) {
          sfx.buy(); haptic(15);
          const rect = b.getBoundingClientRect();
          burst(rect.left + rect.width / 2, rect.top + rect.height / 2, { count: 14, color: '#FFB020' });
          celebrateGifts(r.gifts);
          refresh();
        } else if (r.error === 'not_enough') { sfx.deny(); shakeNode(b); toastErr('Not enough gold yet'); }
        else if (r.error === 'locked') { sfx.deny(); toastErr('That generator is still locked'); }
        else toastErr(humanError(r.error));
      });
      return;
    }
    case 'buy-skill': {
      actions.buySkill(b.dataset.id).then(r => {
        if (r.ok) { sfx.buy(); haptic(15); toastOk(`${b.dataset.name || 'Skill'} → level ${r.level}`); refresh(); }
        else { sfx.deny(); shakeNode(b); toastErr(humanError(r.error)); }
      });
      return;
    }
    case 'claim-quest': {
      actions.claimQuest(b.dataset.id).then(r => {
        if (r.ok) {
          sfx.coin(); haptic(20);
          const rect = b.getBoundingClientRect();
          confetti(rect.left + rect.width / 2, rect.top, 28);
          if (r.levelled) { sfx.levelup(); toastGold('Level up! You are now level ' + r.level); }
          else toastOk(`Quest complete · 🪙 ${fmtPrice(r.gold || 0)}${r.gems ? ' · 💎 ' + r.gems : ''}`);
          celebrateGifts(r.gifts);
          refresh();
        } else toastErr(humanError(r.error));
      });
      return;
    }
    case 'open-shop-item': openItemSheet(b.dataset.item); return;
    case 'buy-offer': buyOffer(parseInt(b.dataset.offer, 10)); return;
    case 'open-crate': openCrate(b.dataset.id, b.dataset.free === '1'); return;
    case 'buy-crate': {
      const offer = (store.offers || []).find(o => o.item === b.dataset.id);
      if (!offer) { toastErr('That crate is not on sale right now'); return; }
      buyOffer(offer.id);
      return;
    }
    case 'show-odds': showOdds(b.dataset.id); return;
    case 'equip': doEquip(b.dataset.slot, b.dataset.item); return;
    case 'unequip': doEquip(b.dataset.slot, null); return;
    case 'buy-pack': buyPack(b.dataset.pack); return;
    default: return;
  }
}

async function claimStreak() {
  const r = await actions.claimStreak();
  if (!r.ok) { toastErr(humanError(r.error)); sfx.deny(); return; }
  sfx.chime(); haptic([12, 30, 12]);
  confetti(innerWidth / 2, innerHeight * 0.4, 46);
  const rw = r.reward || {};
  toastOk(`Day ${r.streak} · ${rw.gold ? '🪙 ' + fmtPrice(rw.gold) : ''}${rw.gems ? ' 💎 ' + rw.gems : ''}${rw.crate ? ' 📦 a crate!' : ''}`);
  refresh();
}

async function doPrestige() {
  const s = snap();
  const p = s.prestige || {};
  if (!p.ok) { toastErr('Not ready yet'); return; }
  const yes = await confirmDialog({
    title: 'Prestige the forge?',
    message: `Gold, generator levels and skills reset to zero. You gain ✦ ${fmtFull(p.gain || 0)} sparks → ×${(p.new_mult || 1).toFixed(2)} output forever. Cosmetics, titles and achievements are kept.`,
    confirmLabel: 'Prestige', danger: true,
  });
  if (!yes) return;
  const r = await actions.prestige(true);
  if (!r.ok) { toastErr(humanError(r.error)); return; }
  flash('rgba(255,240,200,.55)', 420);
  shake(9, 500);
  emberRain(90);
  sfx.prestige(); haptic([30, 50, 30, 50, 120]);
  modal({
    title: null, kind: 'prestige',
    body: `<div class="prestige-reveal">
      <div class="pr-sparks">✦ ${fmtFull(r.sparks)}</div>
      <div class="pr-mult">×${(r.mult || 1).toFixed(2)}</div>
      <div class="pr-label">permanent output</div>
      <p class="pr-note">Your cosmetics, titles and collection are safe.</p></div>`,
    actions: [{ label: 'Rebuild the forge', class: 'btn-primary' }],
  });
  refresh();
}

/* ================================================================== *
 *  Offline earnings — the strongest return hook (GDD §3.7)
 * ================================================================== */
export function showOffline(idle) {
  if (!idle || !(idle.gain >= 1)) return;
  const node = document.createElement('div');
  node.className = 'offline';
  node.innerHTML = `
    <div class="off-glow" aria-hidden="true"></div>
    <p class="off-hi">Welcome back</p>
    <p class="off-sub">Your forge burned for <b>${dur(idle.secs)}</b>${idle.capped ? ' (capped)' : ''}</p>
    <div class="off-amount" id="offAmount">🪙 0</div>
    <p class="off-rate small">${fmt(idle.gps)}/s at ${Math.round((idle.efficiency || 1) * 100)}% efficiency</p>`;

  modal({
    title: null, kind: 'offline', body: node,
    actions: [{ label: 'Collect', class: 'btn-primary', onClick: () => { sfx.coin(); confetti(innerWidth / 2, innerHeight * 0.45, 40); } }],
    onMount: () => {
      const target = Number(idle.gain) || 0;
      const out = node.querySelector('#offAmount');
      const t0 = performance.now(), MS = 1400;
      const step = now => {
        const p = Math.min(1, (now - t0) / MS), e = 1 - Math.pow(1 - p, 3);
        out.textContent = '🪙 ' + fmt(target * e);
        if (p < 1) requestAnimationFrame(step);
        else { out.textContent = '🪙 ' + fmt(target); emberRain(40); }
      };
      requestAnimationFrame(step);
      sfx.chime();
    },
  });
}

/* ================================================================== *
 *  Boot into the game after auth
 * ================================================================== */
export async function bootIntoGame(snapshot) {
  if (snapshot) {
    ingest({ ...snapshot, offers: snapshot.offers || [], leaderboard: snapshot.leaderboard || [],
             poll: snapshot.poll || 10, online: snapshot.online || 0 });
  }
  if (!snapshot?.gens) await sync(false);
  renderShell();
  refresh();
  const s = snap();
  if (s?.idle && s.idle.secs >= 60 && s.idle.gain >= 1) showOffline(s.idle);
}

function startLoopsOnce() { if (!loopsStarted) { loopsStarted = true; startLoops(); } }

/* ================================================================== *
 *  Errors → human copy. Brand voice: never blame the player.
 * ================================================================== */
export function humanError(code) {
  return ({
    not_enough: 'Not enough for that yet',
    already_owned: 'You already own this one',
    offer_unavailable: 'That offer is no longer available',
    locked: 'Still locked — keep building',
    maxed: 'Already at maximum level',
    already_claimed: 'Already claimed — come back tomorrow',
    not_complete: 'Not finished yet',
    no_crate: 'You do not have that crate',
    cooldown: 'The free crate is still recharging',
    not_owned: 'You do not own that item',
    slot_mismatch: 'That item goes in a different slot',
    unauthorized: 'Please log in again',
    rate: 'Easy there — give it a second',
    rate_limited: 'Easy there — give it a second',
    server_error: 'Something hiccuped on our side. Try again.',
    network: 'Connection trouble. Retrying…',
  })[code] || 'Something went wrong';
}
