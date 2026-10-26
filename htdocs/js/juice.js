/* FORGE INFINITE — "juice": particles, floating numbers, shake, haptics, sound.
   Every effect echoes the forge fantasy (embers, sparks, heat) — see BRAND.md §9.
   All of it is disabled under prefers-reduced-motion or the player's own settings. */

import { rnd } from './fmt.js';

/* ------------------------------------------------------------------ *
 *  Settings (read from the store; defaults are safe)
 * ------------------------------------------------------------------ */
let S = { sound: true, haptics: true, particles: true, reducedMotion: false, calmMode: false };
export function setJuiceSettings(s) { S = { ...S, ...(s || {}) }; }
const motionOff = () => S.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ *
 *  Haptics
 * ------------------------------------------------------------------ */
export function haptic(pattern = 8) {
  if (!S.haptics || !navigator.vibrate) return;
  try { navigator.vibrate(pattern); } catch { /* not supported */ }
}

/* ------------------------------------------------------------------ *
 *  Screen shake
 * ------------------------------------------------------------------ */
let shakeRaf = 0, shakeUntil = 0, shakeMag = 0;
export function shake(mag = 4, ms = 160) {
  if (motionOff() || S.calmMode) return;
  const root = document.getElementById('app');
  if (!root) return;
  shakeMag = Math.max(shakeMag, mag);
  shakeUntil = Math.max(shakeUntil, performance.now() + ms);
  if (shakeRaf) return;
  const tick = () => {
    const now = performance.now();
    if (now >= shakeUntil) { root.style.transform = ''; shakeRaf = 0; shakeMag = 0; return; }
    const k = (shakeUntil - now) / ms;
    const x = rnd(-1, 1) * shakeMag * k, y = rnd(-1, 1) * shakeMag * k;
    root.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
    shakeRaf = requestAnimationFrame(tick);
  };
  shakeRaf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ *
 *  Particle layer (single canvas, one RAF loop for everything)
 * ------------------------------------------------------------------ */
let canvas = null, ctx = null, parts = [], raf = 0;

function ensureCanvas() {
  if (canvas && canvas.isConnected) return canvas;
  canvas = document.getElementById('fx');
  if (!canvas) return null;
  ctx = canvas.getContext('2d');
  resize();
  addEventListener('resize', resize, { passive: true });
  addEventListener('orientationchange', resize, { passive: true });
  return canvas;
}
function resize() {
  if (!canvas) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function loop() {
  if (!ctx) { raf = 0; return; }
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const now = performance.now();
  parts = parts.filter(p => p.die > now);
  for (const p of parts) {
    const t = 1 - (p.die - now) / p.life;          // 0 → 1
    p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= 0.99;
    const a = Math.max(0, 1 - t);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.c;
    if (p.glow) { ctx.shadowBlur = 8; ctx.shadowColor = p.c; } else { ctx.shadowBlur = 0; }
    const s = p.s * (1 - t * 0.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.4, s), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  raf = parts.length ? requestAnimationFrame(loop) : 0;
}

function spawn(list) {
  if (!S.particles || motionOff() || S.calmMode) return;
  if (!ensureCanvas()) return;
  if (parts.length > 420) parts.splice(0, parts.length - 420);   // hard cap → stable fps
  parts.push(...list);
  if (!raf) raf = requestAnimationFrame(loop);
}

/** Ember burst — the signature effect of the game. */
export function burst(x, y, { count = 10, color = '#FF7A18', glow = true, spread = 3.4, life = 620, size = 2.6 } = {}) {
  if (!S.particles || motionOff()) return;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = rnd(0, Math.PI * 2), v = rnd(0.6, spread);
    out.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - rnd(0.4, 1.6), g: 0.055,
               s: rnd(size * 0.5, size * 1.5), c: color, glow, life, die: performance.now() + life * rnd(0.7, 1.2) });
  }
  spawn(out);
}

/** Rising embers from the bottom of the screen — used on prestige/level-up. */
export function emberRain(count = 60, color = '#FFB020') {
  if (!S.particles || motionOff()) return;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: rnd(0, innerWidth), y: innerHeight + rnd(0, 120), vx: rnd(-0.4, 0.4), vy: -rnd(1.2, 3.4),
               g: -0.004, s: rnd(1, 3), c: Math.random() < 0.3 ? '#FF7A18' : color,
               glow: true, life: 2600, die: performance.now() + rnd(1600, 2800) });
  }
  spawn(out);
}

/** Full-spectrum celebration (level up, achievement). */
export function confetti(x, y, count = 40) {
  const palette = ['#FFB020', '#FF7A18', '#2DD4BF', '#60A5FA', '#C084FC', '#4ADE80'];
  if (!S.particles || motionOff()) return;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = rnd(0, Math.PI * 2), v = rnd(1.5, 6);
    out.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, g: 0.14,
               s: rnd(1.5, 3.5), c: palette[(Math.random() * palette.length) | 0],
               glow: false, life: 1400, die: performance.now() + rnd(900, 1500) });
  }
  spawn(out);
}

/* ------------------------------------------------------------------ *
 *  Floating numbers
 * ------------------------------------------------------------------ */
export function floatText(x, y, text, cls = '') {
  if (S.calmMode) return;
  const host = document.getElementById('floaters');
  if (!host) return;
  const n = document.createElement('div');
  n.className = 'floater ' + cls;
  n.textContent = text;
  n.style.left = x + 'px';
  n.style.top = y + 'px';
  host.appendChild(n);
  if (host.childElementCount > 26) host.firstChild.remove();
  setTimeout(() => n.remove(), motionOff() ? 200 : 1000);
}

/* ------------------------------------------------------------------ *
 *  Sound — synthesised with WebAudio, zero asset downloads
 * ------------------------------------------------------------------ */
let AC = null;
const ac = () => {
  if (!S.sound) return null;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
    return AC;
  } catch { return null; }
};
function tone({ freq = 440, type = 'sine', dur = 0.08, gain = 0.05, slide = 0, delay = 0 }) {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
let clickStep = 0;
export const sfx = {
  unlockAudio() { ac(); },
  click() {
    // pitch rises with the combo → the loop literally sounds more rewarding
    const f = 300 + Math.min(24, clickStep) * 14;
    clickStep = (clickStep + 1) % 25;
    tone({ freq: f, type: 'triangle', dur: 0.05, gain: 0.035, slide: 60 });
  },
  crit() { tone({ freq: 880, type: 'square', dur: 0.12, gain: 0.05, slide: 500 }); },
  buy() { tone({ freq: 180, type: 'sine', dur: 0.1, gain: 0.06, slide: -60 });
          tone({ freq: 620, type: 'triangle', dur: 0.16, gain: 0.04, slide: 240, delay: 0.05 }); },
  deny() { tone({ freq: 150, type: 'sawtooth', dur: 0.14, gain: 0.035, slide: -50 }); },
  coin() { tone({ freq: 980, type: 'triangle', dur: 0.07, gain: 0.04 });
           tone({ freq: 1320, type: 'triangle', dur: 0.09, gain: 0.03, delay: 0.05 }); },
  chime() { [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.28, gain: 0.045, delay: i * 0.07 })); },
  legendary() { [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.4, gain: 0.05, delay: i * 0.09 })); },
  prestige() { tone({ freq: 70, type: 'sawtooth', dur: 0.7, gain: 0.07, slide: 120 });
               tone({ freq: 220, type: 'sine', dur: 1.1, gain: 0.05, slide: 420, delay: 0.18 }); },
  levelup() { [440, 587, 880].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.2, gain: 0.05, delay: i * 0.06 })); },
};

/* ------------------------------------------------------------------ *
 *  Flash / pulse helpers
 * ------------------------------------------------------------------ */
export function flash(color = 'rgba(255,176,32,.22)', ms = 180) {
  if (motionOff() || S.calmMode) return;
  const n = document.getElementById('flash');
  if (!n) return;
  n.style.background = color;
  n.style.opacity = '1';
  n.style.transition = 'none';
  requestAnimationFrame(() => {
    n.style.transition = `opacity ${ms}ms ease-out`;
    n.style.opacity = '0';
  });
}

export function pulse(node, cls = 'pulse') {
  if (!node || motionOff()) return;
  node.classList.remove(cls);
  void node.offsetWidth;                // restart the animation
  node.classList.add(cls);
}

export function shakeNode(node, ms = 260) {
  if (!node || motionOff()) return;
  node.classList.remove('nope');
  void node.offsetWidth;
  node.classList.add('nope');
  setTimeout(() => node.classList.remove('nope'), ms + 40);
}
