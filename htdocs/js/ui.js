/* FORGE INFINITE — shared UI primitives: toasts, modals, bottom sheets.
   Everything is keyboard- and screen-reader-friendly: focus trap, Esc to close,
   aria-modal, and focus restored to the element that opened it. */

import { h, esc } from './fmt.js';
import { sfx, haptic, shake } from './juice.js';

let toastHost = null;

export function toast(msg, { kind = 'info', ms = 2600 } = {}) {
  toastHost = toastHost || document.getElementById('toasts');
  if (!toastHost) return;
  const n = h('div', { class: `toast t-${kind}`, role: 'status' }, msg);
  toastHost.appendChild(n);
  requestAnimationFrame(() => n.classList.add('in'));
  if (toastHost.childElementCount > 4) toastHost.firstChild.remove();
  setTimeout(() => { n.classList.remove('in'); setTimeout(() => n.remove(), 260); }, ms);
}

export const toastOk = m => toast(m, { kind: 'ok' });
export const toastErr = m => toast(m, { kind: 'err' });
export const toastGold = m => toast(m, { kind: 'gold' });

/* ------------------------------------------------------------------ *
 *  Modal / bottom sheet
 * ------------------------------------------------------------------ */
let openModals = [];

export function modal({ title, body, actions = [], kind = 'modal', onMount = null, dismissable = true }) {
  const host = document.getElementById('modals');
  if (!host) return null;
  const prevFocus = document.activeElement;

  const back = h('div', { class: 'modal-back' });
  const panel = h('div', {
    class: `modal m-${kind}`, role: 'dialog', 'aria-modal': 'true',
    'aria-label': typeof title === 'string' ? title : 'Dialog',
  });
  if (title) panel.append(h('h2', { class: 'modal-title', html: typeof title === 'string' ? esc(title) : '' }));
  if (title && typeof title !== 'string') panel.querySelector('.modal-title').replaceWith(title);

  const content = h('div', { class: 'modal-body' });
  if (typeof body === 'string') content.innerHTML = body;
  else if (body) content.append(body);
  panel.append(content);

  if (actions.length) {
    const bar = h('div', { class: 'modal-actions' });
    for (const a of actions) {
      bar.append(h('button', {
        class: 'btn ' + (a.class || 'btn-ghost'), type: 'button', text: a.label,
        onclick: () => { if (!a.keepOpen) close(); a.onClick && a.onClick(close); },
      }));
    }
    panel.append(bar);
  }

  back.addEventListener('click', () => { if (dismissable) close(); });
  host.append(back, panel);
  requestAnimationFrame(() => { back.classList.add('in'); panel.classList.add('in'); });
  sfx.unlockAudio();
  haptic(12);

  const focusables = () => [...panel.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(n => !n.disabled && n.offsetParent !== null);
  setTimeout(() => { (focusables()[0] || panel).focus?.(); }, 60);

  function onKey(e) {
    if (e.key === 'Escape' && dismissable) { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }
  document.addEventListener('keydown', onKey);

  function close() {
    document.removeEventListener('keydown', onKey);
    back.classList.remove('in'); panel.classList.remove('in');
    setTimeout(() => { back.remove(); panel.remove(); }, 220);
    openModals = openModals.filter(m => m !== api);
    prevFocus?.focus?.();
  }
  const api = { close, panel, content };
  openModals.push(api);
  onMount && onMount(api);
  return api;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const m = modal({
      title, body: `<p class="modal-text">${esc(message)}</p>`,
      actions: [
        { label: cancelLabel, class: 'btn-ghost', onClick: () => { done = true; resolve(false); } },
        { label: confirmLabel, class: danger ? 'btn-danger' : 'btn-primary',
          onClick: () => { done = true; resolve(true); } },
      ],
      onMount: () => {},
    });
    // closing by backdrop/Esc = cancel
    const obs = setInterval(() => {
      if (!m || !m.panel.isConnected) { clearInterval(obs); if (!done) resolve(false); }
    }, 200);
  });
}

/* ------------------------------------------------------------------ *
 *  Reward reveal — the crate/loot moment. Rarity decides the drama.
 * ------------------------------------------------------------------ */
export function revealReward({ name, rarity, slot, css, dupe = false, gold = 0, isNew = true }) {
  const { RARITY_ICON, rarityLabel } = require_fmt();
  const big = rarity === 'legendary' || rarity === 'limited' || rarity === 'epic';
  const body = document.createElement('div');
  body.className = 'reveal';
  body.innerHTML = `
    <div class="reveal-burst r-${esc(rarity)}"></div>
    <div class="reveal-art r-${esc(rarity)}" style="${esc(css || '')}">${slotGlyph(slot)}</div>
    <div class="reveal-rarity r-${esc(rarity)}-text">${RARITY_ICON[rarity] || ''} ${esc(rarityLabel(rarity))}</div>
    <h3 class="reveal-name">${esc(name)}</h3>
    ${dupe ? `<p class="reveal-note">You already own this — converted to <b>🪙 ${Math.floor(gold).toLocaleString('en-US')}</b></p>` : ''}
    ${isNew && !dupe ? '<p class="reveal-note new">New addition to your collection</p>' : ''}`;

  if (big) { shake(7, 320); sfx.legendary(); haptic([18, 40, 18, 40, 60]); }
  else { sfx.chime(); haptic(18); }

  return modal({
    title: null, body, kind: 'reveal',
    actions: [{ label: dupe ? 'Nice' : 'Equip later', class: 'btn-primary', onClick: () => {} }],
  });
}

function slotGlyph(slot) {
  return { avatar: '🧑‍🔧', frame: '🖼️', background: '🌌', title: '🏷️', click_fx: '🖱️',
           win_fx: '✨', theme: '🎨', sound: '🔊', pet: '🐾', banner: '🏳️',
           signature: '✍️', badge: '🎖️', crate: '📦' }[slot] || '🎁';
}

function require_fmt() {
  // small local shim to avoid a circular import with fmt.js
  return {
    RARITY_ICON: { common: '●', uncommon: '◆', rare: '◆◆', epic: '✦', legendary: '✦✦', limited: '⧗' },
    rarityLabel: r => ({ common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', limited: 'Limited' }[r] || r),
  };
}

/* ------------------------------------------------------------------ *
 *  Odds table — research finding: odds must ALWAYS be visible (GDD §13 R4)
 * ------------------------------------------------------------------ */
export function oddsTableHTML(odds) {
  const rows = (odds || []).map(o =>
    `<tr class="r-${esc(o.rarity)}-row"><td>${esc(o.name)}</td><td class="num">${o.chance.toFixed(3)}%</td></tr>`).join('');
  return `<div class="odds">
    <h4>Drop rates <span class="small">(always public)</span></h4>
    <table class="odds-table"><tbody>${rows}</tbody></table>
  </div>`;
}
