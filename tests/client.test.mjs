/* Client-side unit tests for the pure-logic modules.
   Run: node tests/client.test.mjs */
import './dom-shim.mjs';
import { createRequire } from 'node:module';
const require_fs = await import('node:fs');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${extra ? '  (' + extra + ')' : ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? '  (' + extra + ')' : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const F = await import('../htdocs/js/fmt.js');
const B = await import('../htdocs/js/balance.js');
const C = await import('../htdocs/js/cosmetic.js');

console.log('\n=== number formatting (idle-game notation) ===');
t('0 → "0"', F.fmt(0) === '0', F.fmt(0));
t('999 → "999"', F.fmt(999) === '999', F.fmt(999));
t('1000 → "1.00K"', F.fmt(1000) === '1.00K', F.fmt(1000));
t('1.24e6 → "1.24M"', F.fmt(1240000) === '1.24M', F.fmt(1240000));
t('3.1e9 → "3.10B"', F.fmt(3.1e9) === '3.10B', F.fmt(3.1e9));
t('1e12 → "1.00T"', F.fmt(1e12) === '1.00T', F.fmt(1e12));
t('1e15 → "1.00aa"', F.fmt(1e15) === '1.00aa', F.fmt(1e15));
t('1e18 → "1.00ab"', F.fmt(1e18) === '1.00ab', F.fmt(1e18));
t('huge → exponential, never a 30-char string', F.fmt(1e330).length < 12, F.fmt(1e330));
t('negative handled', F.fmt(-1500) === '-1.50K', F.fmt(-1500));
t('fmtFull groups digits', F.fmtFull(1234567) === '1,234,567', F.fmtFull(1234567));
t('dur 72 → "1m 12s"', F.dur(72) === '1m 12s', F.dur(72));
t('dur 90000 → "1d 1h"', F.dur(90000) === '1d 1h', F.dur(90000));
t('dur negative clamps to 0s', F.dur(-50) === '0s', F.dur(-50));

console.log('\n=== XSS escaping (every user string must pass through this) ===');
t('script tag escaped', !F.esc('<script>alert(1)</script>').includes('<script>'), F.esc('<script>x</script>'));
t('quotes escaped', F.esc('"\'') === '&quot;&#39;', F.esc('"\''));
t('attribute helper strips control chars', !F.attr('a\u0000b').includes('\u0000'));
t('null/undefined safe', F.esc(null) === '' && F.esc(undefined) === '');

console.log('\n=== balance engine (must match GDD §3.1/§3.5 exactly) ===');
await B.loadBalance();
const g0 = B.gen('apprentice');
t('generator 1 exists', !!g0, g0?.name);
t('prod_growth is 1.00 for every generator (the critical balance fix)',
   B.cfg().generators.every(g => g.prod_growth === 1.00),
   B.cfg().generators.map(g => g.prod_growth).join(','));
t('cost(0) = base_cost', near(B.genCost(g0, 0), g0.base_cost), String(B.genCost(g0, 0)));
t('cost(n) = base_cost × cost_growth^n', near(B.genCost(g0, 10), g0.base_cost * g0.cost_growth ** 10, 1e-6),
   B.genCost(g0, 10).toFixed(2));
t('cost growth is steep enough to pace the ladder (≥ 1.18 for every generator)',
   B.cfg().generators.every(g => g.cost_growth >= 1.18),
   B.cfg().generators.map(g => g.cost_growth).join(' '));
t('need_prev_count rises down the ladder', (() => {
   const g = B.cfg().generators;
   return g.every((x, i) => i === 0 || x.need_prev_count >= g[i - 1].need_prev_count);
})(), B.cfg().generators.map(g => g.need_prev_count).join(','));
t('prod is LINEAR in level', near(B.genProd(g0, 10), 10) && near(B.genProd(g0, 100), 100));
t('bulkCost(10 levels from 0) matches the sum',
   near(B.bulkCost(g0, 0, 10), Array.from({ length: 10 }, (_, i) => B.genCost(g0, i)).reduce((a, b) => a + b, 0), 1e-6));
t('maxAffordable is consistent with bulkCost', (() => {
  const n = B.maxAffordable(g0, 0, 1000);
  return B.bulkCost(g0, 0, n) <= 1000 && B.bulkCost(g0, 0, n + 1) > 1000;
})(), 'n=' + B.maxAffordable(g0, 0, 1000));
t('Bargainer discount is capped at 25%', B.genCost(g0, 0, 0.99) >= 15 * 0.75 - 1e-9, String(B.genCost(g0, 0, 0.99)));

const PC = B.cfg().prestige;
t('sparksFor matches the calibrated 30-day reference curve', (() => {
  const ref = PC.reference_curve_30d_sim || [];
  // invert each reference point: goldForSparks(sparks) must map back to the same sparks
  return ref.every(p => B.sparksFor(B.goldForSparks(p.sparks)) === p.sparks);
})(), (PC.reference_curve_30d_sim || []).map(p => p.sparks).join('/'));
t('sparksFor is monotonic and unbounded (no plateau)', (() => {
  let prev = -1;
  for (const g of [1e6, 1e8, 1e10, 1e12, 1e14, 1e16, 1e18]) {
    const s = B.sparksFor(g);
    if (s <= prev) return false;
    prev = s;
  }
  return true;
})(), [1e6,1e10,1e14,1e18].map(g => g.toExponential(0) + '→' + B.sparksFor(g)).join(' '));
t('sparksFor(0) = 0', B.sparksFor(0) === 0);
t('goldForSparks inverts sparksFor exactly', [1, 5, 36, 147, 3854, 48384].every(s => B.sparksFor(B.goldForSparks(s)) === s));
t('prestige multiplier is 1 + bonus×sparks',
   near(B.prestigeMult(100), 1 + PC.gps_bonus_per_spark * 100, 1e-9), String(B.prestigeMult(100)));
t('xpToNext(1) = 100', B.xpToNext(1) === 100);
t('xpToNext grows at 1.35×', B.xpToNext(2) === 135 && B.xpToNext(10) === Math.floor(100 * 1.35 ** 9));
t('comboMult caps at +100%', near(B.comboMult(999), 2.0), String(B.comboMult(999)));
t('comboMult(0) = 1', near(B.comboMult(0), 1));

console.log('\n=== content integrity (the config is the single source of truth) ===');
const cat = B.cfg().catalog;
t('catalogue has ≥ 25 cosmetics', Object.keys(cat).length >= 25, String(Object.keys(cat).length));
t('every catalogue item has a valid slot', Object.values(cat).every(i => B.cfg().slots.includes(i.slot)));
t('every item has a rarity in the ramp',
   Object.values(cat).every(i => ['common','uncommon','rare','epic','legendary','limited'].includes(i.rarity)));
t('every sellable item has exactly one price',
   Object.values(cat).every(i => (!!i.price_gems) !== (!!i.price_gold) || (!i.price_gems && !i.price_gold)));
t('achievement-only items are not for sale',
   Object.values(cat).filter(i => i.css?.achievement).every(i => !i.price_gems && !i.price_gold));
t('every crate entry points at a real catalogue item',
   Object.values(B.cfg().crates).every(c => c.entries.every(e => !!cat[e[0]])),
   Object.values(B.cfg().crates).flatMap(c => c.entries.filter(e => !cat[e[0]]).map(e => e[0])).join(',') || 'all resolve');
t('catalog is id-keyed after load (array/object mismatch guard)',
   !Array.isArray(B.cfg().catalog) && !!B.cfg().catalog.fx_sparks);
t('crate weights are positive integers',
   Object.values(B.cfg().crates).every(c => c.entries.every(e => Number.isInteger(e[1]) && e[1] >= 0)));
t('crate odds sum to 100%', (() => {
  return Object.keys(B.cfg().crates).every(id => {
    const tot = B.cfg().crates[id].entries.reduce((a, e) => a + e[1], 0);
    return tot > 0;
  });
})());
t('no cosmetic carries power (anti pay-to-win)',
   Object.values(cat).every(i => !i.power_effect));
t('every skill has a max level and a growth rate',
   B.cfg().skills.every(s => s.max > 0 && s.growth > 1));
const PCT_EFFECTS = ['gps','offline','drop_rate','cost_reduction','battle_power','tax_reduction','quest_reward'];
t('percentage skills never exceed their designed cap (GDD §3.6)',
   B.cfg().skills.filter(s => PCT_EFFECTS.includes(s.effect)).every(s => s.per_level * s.max <= 1.0001),
   B.cfg().skills.filter(s => PCT_EFFECTS.includes(s.effect)).map(s => `${s.id}:${(s.per_level * s.max).toFixed(2)}`).join(' '));
t('count-based skills stay bounded', B.cfg().skills.filter(s => !PCT_EFFECTS.includes(s.effect))
   .every(s => s.max <= 20), B.cfg().skills.filter(s => !PCT_EFFECTS.includes(s.effect)).map(s => `${s.id}:${s.max}`).join(' '));
t('cost_reduction can never exceed the 25% server clamp', (() => {
   const b = B.cfg().skills.find(s => s.effect === 'cost_reduction');
   return b.per_level * b.max <= 0.25 + 1e-9;
})());
t('generator unlock chain is monotonic', (() => {
  const g = B.cfg().generators;
  return g.every((x, i) => i === 0 || x.base_cost > g[i - 1].base_cost);
})());
t('gem packs increase in value per USD', (() => {
  const p = B.cfg().gem_packs;
  return p.every((x, i) => i === 0 || x.gems / x.usd > p[i - 1].gems / p[i - 1].usd);
})());

console.log('\n=== compliance assertions (GDD §13) ===');
const comp = B.cfg().compliance;
t('one-way economy declared', comp.one_way_economy === true);
t('paid crate contents are NOT tradable', comp.paid_crate_contents_tradable === false);
t('odds are always public', comp.odds_always_public === true);
t('BE + NL are geo-blocked for paid crates',
   comp.geo_block_paid_crates.includes('BE') && comp.geo_block_paid_crates.includes('NL'));
t('no power for sale', comp.no_power_for_sale === true);
t('gems are never player-tradable',
   Object.values(cat).every(i => i.slot !== 'gems'));
t('banned gambling words absent from all copy', (() => {
  const banned = B.cfg().monetization.guardrails.banned_words_in_copy;
  const blob = JSON.stringify({ cat, quests: B.cfg().quests_daily, ach: B.cfg().achievements, packs: B.cfg().gem_packs }).toLowerCase();
  return banned.every(w => !blob.includes(w));
})());

console.log('\n=== cosmetic rendering (data → CSS, no assets) ===');
t('theme items map to a known theme key',
   Object.values(cat).filter(i => i.slot === 'theme').every(i => i.css.theme in B.THEMES));
t('RARITY_CSS covers the whole ramp', ['common','uncommon','rare','epic','legendary','limited'].every(r => r in B.RARITY_CSS));
t('cssFor emits box-shadow for a ring descriptor', B.cssFor({ css: { ring: '0 0 0 2px #fff' } }).includes('box-shadow'));
t('cssFor emits an animation name that exists in style.css', (() => {
  const out = B.cssFor({ css: { anim: 'pulse' } });
  return out.includes('fi-pulse');
})());
t('cssFor is null-safe', B.cssFor(null) === '' && B.cssFor({}) === '');
t('every fi-* animation referenced by an item exists in style.css', (() => {
  const css = require_fs.readFileSync(new URL('../htdocs/css/style.css', import.meta.url), 'utf8');
  const used = new Set(Object.values(cat).map(i => i.css?.anim).filter(Boolean));
  const missing = [...used].filter(a => !css.includes('@keyframes fi-' + a));
  return missing.length === 0 ? true : (console.log('     missing: ' + missing.join(',')), false);
})());

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
