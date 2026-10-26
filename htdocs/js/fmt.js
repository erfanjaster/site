/* FORGE INFINITE — big-number formatting + tiny helpers
   Notation follows the idle-game standard: K, M, B, T, aa, ab, ac…  */

const SUFFIX_A = ['', 'K', 'M', 'B', 'T'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Suffix index → string. 0-4 = K/M/B/T, then aa, ab, ac … az, ba, bb … */
export function suffix(i) {
  if (i < SUFFIX_A.length) return SUFFIX_A[i];
  const n = i - SUFFIX_A.length;
  const a = LETTERS[Math.floor(n / 26) % 26];
  const b = LETTERS[n % 26];
  return a + b;
}

/** Format any number for display. Never emits a raw 18-digit string. */
export function fmt(n, decimals = 2) {
  n = Number(n) || 0;
  const neg = n < 0;
  n = Math.abs(n);
  if (n < 1000) {
    const s = n < 10 && n % 1 !== 0 ? n.toFixed(1) : Math.floor(n).toString();
    return (neg ? '-' : '') + s;
  }
  let tier = Math.floor(Math.log10(n) / 3);
  const maxTier = SUFFIX_A.length - 1 + 26 * 26;
  if (tier > maxTier) return (neg ? '-' : '') + n.toExponential(2).replace('+', '');
  const scaled = n / Math.pow(10, tier * 3);
  const d = scaled < 10 ? decimals : (scaled < 100 ? Math.min(decimals, 1) : 0);
  return (neg ? '-' : '') + scaled.toFixed(d) + suffix(tier);
}

/** Full grouped number — used where precision matters (prices you are about to pay). */
export function fmtFull(n) {
  n = Math.floor(Number(n) || 0);
  return n.toLocaleString('en-US');
}

/** Compact for prices: shows the exact integer when small, otherwise fmt(). */
export function fmtPrice(n) {
  n = Number(n) || 0;
  return n < 100000 ? fmtFull(n) : fmt(n);
}

/** 72 → "1m 12s" · 7200 → "2h" · 90000 → "1d 1h" */
export function dur(secs) {
  secs = Math.max(0, Math.floor(Number(secs) || 0));
  if (secs < 60) return secs + 's';
  let m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  let h = Math.floor(m / 60);
  m = m % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  h = h % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Countdown to a unix timestamp, ticking. */
export function until(ts, nowSec) {
  return dur(Math.max(0, (ts | 0) - (nowSec | 0)));
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rnd = (a, b) => a + Math.random() * (b - a);
export const pick = arr => arr[(Math.random() * arr.length) | 0];

/** Escapes text for safe HTML insertion — every user-generated string goes through this. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Attribute-safe variant (also strips control chars). */
export function attr(s) {
  return esc(s).replace(/[\u0000-\u001f]/g, '');
}

export function el(sel, root = document) { return root.querySelector(sel); }
export function els(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'limited'];
export const RARITY_ICON = { common: '●', uncommon: '◆', rare: '◆◆', epic: '✦', legendary: '✦✦', limited: '⧗' };

export function rarityLabel(r) {
  return { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', limited: 'Limited' }[r] || r;
}

/** Smoothly animate a number from its current displayed value to the target. */
export function animateNumber(node, to, { ms = 650, formatter = fmt } = {}) {
  const from = Number(node.dataset.val || 0);
  to = Number(to) || 0;
  if (from === to) { node.textContent = formatter(to); node.dataset.val = to; return; }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || ms <= 0) {
    node.textContent = formatter(to); node.dataset.val = to; return;
  }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - p, 3);           // easeOutCubic
    node.textContent = formatter(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
    else node.dataset.val = to;
  };
  node.dataset.val = to;
  requestAnimationFrame(step);
}
