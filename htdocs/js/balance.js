/* FORGE INFINITE — client mirror of api/Balance.php.
   Used ONLY for instant rendering and optimistic UI. The server is always the truth:
   after every sync we overwrite local values with the server snapshot. */

let CFG = null;
let genById = {}, itemById = {}, skillById = {};

export async function loadBalance() {
  if (CFG) return CFG;
  // Single-file builds embed the config as window.FI_BALANCE so there is no
  // fetch at all (which also makes the file work from file:// with no CORS).
  if (globalThis.FI_BALANCE) {
    CFG = JSON.parse(JSON.stringify(globalThis.FI_BALANCE));
  } else {
    const url = globalThis.FI_CONFIG_URL || ('config/balance.json?v=' + (globalThis.FI_VER || '1'));
    const r = await fetch(url, { cache: 'force-cache' });
    CFG = await r.json();
  }
  for (const g of CFG.generators || []) genById[g.id] = g;
  for (const s of CFG.skills || []) skillById[s.id] = s;

  // balance.json ships `catalog` as an ARRAY; the server snapshot ships it as an
  // id-keyed OBJECT. Normalise to the object form so both code paths behave
  // identically — this mismatch is exactly the kind of thing that causes
  // "undefined item" bugs later.
  if (Array.isArray(CFG.catalog)) {
    const dict = {};
    for (const it of CFG.catalog) dict[it.id] = it;
    CFG.catalog = dict;
  }
  for (const [id, it] of Object.entries(CFG.catalog || {})) itemById[id] = { id, ...it };

  // Crates are items too. The server creates real `items` rows for them in
  // Shop::seedContent(); mirror that here so offers() can resolve crate names.
  for (const [cid, c] of Object.entries(CFG.crates || {})) {
    if (!itemById[cid]) {
      itemById[cid] = { id: cid, name: c.name, slot: 'crate', rarity: 'rare', tradable: 0, css: null };
    }
  }
  return CFG;
}

export const cfg = () => CFG;
export const gen = id => genById[id];
export const item = id => itemById[id];
export const skill = id => skillById[id];

/* ---------------- generators ---------------- */
export const genCost = (g, level, costReduction = 0) =>
  Math.max(1, g.base_cost * Math.pow(g.cost_growth, level) * (1 - Math.min(0.25, costReduction)));

export const genProd = (g, level) => (level > 0 ? g.base_prod * level : 0);

/** Geometric sum for buying `qty` levels at once. */
export function bulkCost(g, level, qty, costReduction = 0) {
  const r = g.cost_growth, k = 1 - Math.min(0.25, costReduction);
  return g.base_cost * k * Math.pow(r, level) * (Math.pow(r, qty) - 1) / (r - 1);
}

/** How many levels can be afforded with `gold`. */
export function maxAffordable(g, level, gold, costReduction = 0) {
  const r = g.cost_growth, k = 1 - Math.min(0.25, costReduction);
  const c0 = g.base_cost * k * Math.pow(r, level);
  if (gold < c0) return 0;
  const n = Math.floor(Math.log(gold * (r - 1) / c0 + 1) / Math.log(r));
  return Math.max(0, n);
}

/* ---------------- derived ---------------- */
export const gpsRaw = levels => Object.entries(levels).reduce((s, [id, lv]) => {
  const g = genById[id]; return s + (g ? genProd(g, lv) : 0);
}, 0);

export const prestigeMult = sparks => 1 + ((CFG?.prestige?.gps_bonus_per_spark) ?? 0.02) * (sparks || 0);

const P = () => CFG?.prestige || {};
/** Must stay in lock-step with api/Balance.php::sparksFor. */
export const sparksFor = runGold => {
  const { coef = 3, divisor = 1e6, exponent = 0.4 } = P();
  if (!(runGold > 0)) return 0;
  return Math.floor(coef * Math.pow(runGold / divisor, exponent));
};
export const goldForSparks = s => {
  if (!(s > 0)) return 0;
  const { coef = 3, divisor = 1e6, exponent = 0.4 } = P();
  return Math.pow(s / coef, 1 / exponent) * divisor;
};
export const prestigeGate = () => Number(P().gate_multiplier ?? 1.75);

export const xpToNext = level => Math.floor(100 * Math.pow(1.35, Math.max(0, level - 1)));

export const skillCost = (s, level) => s.base_cost * Math.pow(s.growth, level);

export const comboMult = combo =>
  1 + Math.min(CFG?.combo?.max_bonus ?? 1, (CFG?.combo?.per_click_bonus ?? 0.02) * Math.max(0, combo));

export const clickValue = (prestigeCount, gpsRawVal, skillMult) =>
  (1 + (prestigeCount || 0) + 0.05 * (gpsRawVal || 0)) * (skillMult || 1);

export const critChance = () => Number(CFG?.combo?.crit_chance ?? 0.05);
export const critMult   = () => Number(CFG?.combo?.crit_multiplier ?? 10);

/* ---------------- cosmetics rendering ---------------- */
/** Convert an item's `css` descriptor into an inline style string.
    Themes are handled separately (they swap document-level custom properties). */
export function cssFor(it) {
  const c = it?.css;
  if (!c || typeof c !== 'object') return '';
  const out = [];
  if (c.ring) out.push(`box-shadow:${c.ring}`);
  if (c.bg) out.push(`background-image:${c.bg}`);
  if (c.border) out.push(`border:${c.border}`);
  if (c.color) out.push(`color:${c.color}`);
  if (c.pad) out.push(`padding:${c.pad}`);
  if (c.rad !== undefined) out.push(`border-radius:${c.rad}px`);
  if (c.anim) out.push(`animation:fi-${c.anim} 3.2s ease-in-out infinite`);
  if (c.particles) out.push(`--fx-count:${c.particles}`, `--fx-color:${c.color || '#FFC53D'}`, `--fx-life:${c.life || 600}ms`);
  if (c.glow) out.push(`filter:drop-shadow(0 0 6px ${c.color || '#FF7A18'})`);
  return out.join(';');
}

/** Rarity-driven fallback styling when an item has no bespoke css. */
export const RARITY_CSS = {
  common:     'box-shadow:0 0 0 1px #A8A29E',
  uncommon:   'box-shadow:0 0 0 2px #4ADE80',
  rare:       'box-shadow:0 0 0 2px #60A5FA, 0 0 12px rgba(96,165,250,.35)',
  epic:       'box-shadow:0 0 0 2px #C084FC, 0 0 16px rgba(192,132,252,.45)',
  legendary:  'box-shadow:0 0 0 2px #FBBF24, 0 0 20px rgba(251,191,36,.5)',
  limited:    'box-shadow:0 0 0 2px #FB7185, 0 0 20px rgba(251,113,133,.45)',
};

/* ---------------- loot (mirrors Balance::rollCrate / crateOdds) ---------------- */
/** Weighted roll. `ownedIds` lets the caller detect duplicates. RNG stays client-side
 *  in the demo only — production rolls on the server with random_int(). */
export function rollCrateLocal(crateId, ownedIds = []) {
  const c = (CFG?.crates || {})[crateId];
  if (!c) throw new Error('unknown_crate');
  const entries = c.entries || [];
  const total = entries.reduce((a, e) => a + Math.max(0, e[1] | 0), 0);
  if (total <= 0) throw new Error('empty_loot_table');
  const roll = 1 + Math.floor(Math.random() * total);
  let acc = 0;
  for (const e of entries) {
    acc += Math.max(0, e[1] | 0);
    if (roll <= acc) return { item_id: String(e[0]), roll, total, dupe: ownedIds.includes(String(e[0])) };
  }
  return { item_id: null, roll, total, dupe: false };
}

/** Public odds list — the same table the server returns, and the same one the UI shows. */
export function crateOddsLocal(crateId) {
  const c = (CFG?.crates || {})[crateId];
  if (!c) return [];
  const entries = c.entries || [];
  const total = entries.reduce((a, e) => a + Math.max(0, e[1] | 0), 0);
  return entries
    .map(e => {
      const it = itemById[String(e[0])] || {};
      return { item_id: String(e[0]), name: it.name || e[0], rarity: it.rarity || 'common',
               chance: total > 0 ? Math.round(Math.max(0, e[1] | 0) / total * 100000) / 1000 : 0 };
    })
    .sort((a, b) => b.chance - a.chance);
}

export const THEMES = {
  ember:   {},   // default tokens in style.css
  midnight:{ '--bg-base':'#0D1017','--bg-void':'#070910','--surface-1':'#151A24','--surface-2':'#1D2431',
             '--surface-3':'#28313F','--line':'#2C3644','--line-strong':'#3E4B5C','--ember':'#60A5FA',
             '--ember-hot':'#93C5FD','--ember-deep':'#1D4ED8','--fg':'#E6EDF7','--fg-muted':'#A6B3C6','--fg-dim':'#7A879B' },
  verdant: { '--bg-base':'#0E1410','--bg-void':'#080C09','--surface-1':'#16201A','--surface-2':'#1D2A22',
             '--surface-3':'#26352C','--line':'#2C3B31','--line-strong':'#3E5145','--ember':'#4ADE80',
             '--ember-hot':'#86EFAC','--ember-deep':'#15803D','--fg':'#E8F2EA','--fg-muted':'#A9BFAE','--fg-dim':'#7E9284' },
  bone:    { '--bg-base':'#F6F1E7','--bg-void':'#E7DFD0','--surface-1':'#FFFFFF','--surface-2':'#FBF7EF',
             '--surface-3':'#F0E9DC','--line':'#DCD3C2','--line-strong':'#C2B7A2','--ember':'#C2410C',
             '--ember-hot':'#EA580C','--ember-deep':'#7C2D12','--fg':'#241C12','--fg-muted':'#5A4E3E','--fg-dim':'#7D7161',
             '--fg-inverse':'#FFF7ED' },
};
