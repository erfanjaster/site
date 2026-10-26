/* Verifies the SINGLE-FILE demo build (forge-infinite-demo.html):
   • the embedded balance JSON parses
   • the inlined bundle parses as JavaScript
   • every module factory instantiates and the game logic actually runs
   Build it first:  node tools/build-demo-single-file.mjs */
import './dom-shim.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = new URL('../forge-infinite-demo.html', import.meta.url);
let pass = 0, fail = 0;
const t = (n, ok, x = '') => {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${n}${x ? '  (' + x + ')' : ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${n}${x ? '  (' + x + ')' : ''}`); }
};

console.log('\n=== single-file demo build ===');
t('forge-infinite-demo.html exists (run: node tools/build-demo-single-file.mjs)', existsSync(FILE));
if (!existsSync(FILE)) { console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`); process.exit(1); }

const html = readFileSync(FILE, 'utf8');

// 1) embedded config
const bal = html.match(/<script id="fi-balance" type="application\/json">([\s\S]*?)<\/script>/);
t('balance config is embedded inline', !!bal);
let cfg = null;
try { cfg = JSON.parse(bal[1]); } catch (e) { t('embedded JSON parses', false, e.message); }
if (cfg) {
  t('embedded JSON parses', true, Object.keys(cfg).length + ' sections');
  t('embedded catalogue matches the source config',
     cfg.catalog.length === JSON.parse(readFileSync(new URL('../htdocs/config/balance.json', import.meta.url), 'utf8')).catalog.length,
     cfg.catalog.length + ' items');
}

// 2) no external resources at all
const ext = [...html.matchAll(/(?:src|href)="((?:https?:)?\/\/[^"]*)"/g)].map(m => m[1]);
t('zero external resource URLs', ext.length === 0, ext.join(', ') || 'none');
t('no <link> to a stylesheet', !/<link[^>]+stylesheet/.test(html));
t('no module script tags (would need CORS)', !/<script[^>]+type="module"/.test(html));
t('service worker is not registered', /FI_SINGLE_FILE\s*=\s*true/.test(html));

// 3) extract the bundle, stub the DOM-only preamble, and actually execute it
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const bundle = scripts.find(s => s.includes('__fi_main'));
t('found the inlined bundle', !!bundle, bundle ? (bundle.length / 1024).toFixed(0) + ' KB' : '');
writeFileSync('/tmp/_bundle_raw.mjs', bundle);

const runnable = bundle
  .replace(/window\.FI_BALANCE\s*=\s*JSON\.parse\([^;]+\);/, 'globalThis.FI_BALANCE = __EMBEDDED_CFG__;')
  .replace(/__fi_main\(\);\s*$/, '')
  + '\nexport const __factories = { __fi_fmt, __fi_balance, __fi_juice, __fi_ui, __fi_cosmetic, __fi_demo, __fi_api, __fi_store, __fi_screens, __fi_main };\n';
writeFileSync('/tmp/_bundle_run.mjs',
  'globalThis.__EMBEDDED_CFG__ = ' + JSON.stringify(cfg) + ';\n' + runnable);

const mod = await import('/tmp/_bundle_run.mjs').catch(e => { console.log('  \x1b[31mFAIL\x1b[0m  bundle executes: ' + e.message); return null; });
t('bundle executes without errors', !!mod);
if (mod) {
  const F = mod.__factories;
  const B = F.__fi_balance(); await B.loadBalance();
  t('balance factory loads the embedded config (no fetch)', Object.keys(B.cfg().catalog).length >= 25,
     Object.keys(B.cfg().catalog).length + ' items');
  const fmt = F.__fi_fmt();
  t('number notation works', fmt.fmt(1.234e15) === '1.23aa', fmt.fmt(1.234e15));
  const D = F.__fi_demo(); D.resetDemo('Bundle');
  const snap = D.snapshot();
  t('demo snapshot is complete', snap.gens.length === 10 && snap.offers.length >= 25 && snap.crates.length >= 2,
     `${snap.gens.length} gens / ${snap.offers.length} offers / ${snap.crates.length} crates`);
  D.demoActions.click(400, 40);
  t('gameplay runs inside the bundle', D.demoState().gold > 0 && D.demoState().totalClicks === 400,
     Math.round(D.demoState().gold) + ' gold');
  const rr = D.demoActions.buy_gen('apprentice', 5);
  t('purchasing works inside the bundle', rr.ok && rr.level === 5, 'level ' + rr.level);
  const ui = F.__fi_ui(); const cos = F.__fi_cosmetic(); const j = F.__fi_juice();
  t('UI / cosmetic / juice factories instantiate', !!(ui && cos && j));
  t('screens factory instantiates', !!F.__fi_screens());
  t('store factory instantiates', !!F.__fi_store());
  t('api factory instantiates and is in demo mode', !!F.__fi_api());
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
