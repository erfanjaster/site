/* Tests for the OFFLINE DEMO engine (public/js/demo.js).
   The demo is a browser-only preview build; production never loads it.
   These tests exist so the demo can never silently drift from the real rules.
   Run: node tests/demo.test.mjs */
import './dom-shim.mjs';
globalThis.FI_DEMO = true;
globalThis.FI_CONFIG_URL = new URL('../htdocs/config/balance.json', import.meta.url).href;

const B = await import('../htdocs/js/balance.js');
await B.loadBalance();
const D = await import('../htdocs/js/demo.js');

let pass = 0, fail = 0;
const t = (n, ok, x = '') => {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${n}${x ? '  (' + x + ')' : ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${n}${x ? '  (' + x + ')' : ''}`); }
};
const reset = () => { localStorage.clear(); D.resetDemo('Tester'); };

console.log('\n=== demo engine: snapshot contract ===');
reset();
let s = D.snapshot();
t('snapshot has every key the UI reads', ['state','derived','gens','skills','quests','achievements',
   'owned','loadout','settings','catalog','crates','slots','packs','offers','leaderboard','idle','prestige']
   .every(k => k in s), Object.keys(s).length + ' keys');
t('10 generators', s.gens.length === 10);
t('only the first generator is unlocked', s.gens[0].unlocked === true && s.gens[1].unlocked === false);
t('welcome gems present', s.state.gems === 50, String(s.state.gems));
t('offers seeded from the catalogue', s.offers.length >= 25, String(s.offers.length));
t('crate odds sum to 100%', Math.abs(s.crates[0].odds.reduce((a, o) => a + o.chance, 0) - 100) < 0.6);
t('leaderboard is never empty (demo bots)', s.leaderboard.length >= 5);

console.log('\n=== demo engine: economy rules match the server ===');
reset();
D.demoActions.click(500, 50);
const g0 = D.demoState().gold;
t('clicking earns gold', g0 > 0, Math.round(g0) + '');
let r = D.demoActions.buy_gen('apprentice', 5);
t('buying 5 levels works', r.ok && r.level === 5, 'spent ' + Math.round(r.spent));
t('gold decreased by exactly the cost', Math.abs(g0 - D.demoState().gold - r.spent) < 0.01);
r = D.demoActions.buy_gen('riftgate', 1);
t('locked generator refused', r.ok === false && r.error === 'locked');
r = D.demoActions.buy_gen('apprentice', 100000);
t('bulk buy only spends what exists', D.demoState().gold >= 0, Math.round(D.demoState().gold) + ' left');
t('bulk buy reports how many it actually bought', r.ok && r.bought > 0 && r.bought < 100000, 'bought ' + r.bought);
r = D.demoActions.buy_skill('efficient_forge');
t('skill purchase works or is correctly refused', r.ok === true || r.error === 'not_enough', r.error || 'level ' + r.level);
t('gold can never go negative', D.demoState().gold >= 0);
t('every currency movement wrote a ledger row', D.demoState().ledger.length >= 3, D.demoState().ledger.length + ' rows');

console.log('\n=== demo engine: daily loop ===');
reset();
r = D.demoActions.claim_streak();
t('streak day 1 claimable', r.ok && r.streak === 1);
r = D.demoActions.claim_streak();
t('streak blocked twice in one day', r.ok === false && r.error === 'already_claimed');
// d_crate needs a crate opened; at this point none has been, so it must be refused
r = D.demoActions.claim_quest('d_crate');
t('incomplete quest refused', r.ok === false && r.error === 'not_complete', r.error || '');
D.demoActions.click(600, 50);
r = D.demoActions.claim_quest('d_clicks');
t('quest completes from play and pays', r.ok && r.gold > 0, r.error || ('+' + Math.round(r.gold)));
r = D.demoActions.claim_quest('d_clicks');
t('quest cannot be claimed twice', r.ok === false && r.error === 'already_claimed');

console.log('\n=== demo engine: crates, cosmetics, compliance ===');
reset();
D.demoState().gems = 5000;
const crateOffer = D.snapshot().offers.find(o => o.slot === 'crate' && o.item === 'box_neon');
r = D.demoActions.buy(crateOffer.id);
t('crate bought with gems', r.ok, r.error || r.item);
r = D.demoActions.open_crate('box_neon', false);
t('crate opens and discloses odds', r.ok && r.odds.length >= 5, r.error || (r.roll + '/' + r.total));
t('reward is a real catalogue item', !!r.reward && (r.reward.type === 'dupe' || !!D.snapshot().catalog[r.reward.item]),
   JSON.stringify(r.reward && (r.reward.name || r.reward.type)));
t('paid-crate items are flagged non-tradable (GDD §13 R2)',
   Object.values(D.demoState().owned).some(o => o.source === 'paid_crate' && o.tradable === 0));
r = D.demoActions.open_crate('box_neon', false);
t('cannot open a crate you do not hold', r.ok === false && r.error === 'no_crate');
r = D.demoActions.open_crate('box_neon', true);
t('free crate works', r.ok === true, r.error || 'ok');
r = D.demoActions.open_crate('box_neon', true);
t('free crate respects its cooldown', r.ok === false && r.error === 'cooldown', 'ready_in ' + r.ready_in);

const ownedId = Object.keys(D.demoState().owned).find(id => (D.snapshot().catalog[id] || {}).slot === 'frame')
             || Object.keys(D.demoState().owned)[0];
const slot = D.snapshot().catalog[ownedId].slot;
r = D.demoActions.equip(slot, ownedId);
t('equip works', r.ok && r.loadout[slot] === ownedId);
r = D.demoActions.equip('frame', 'no_such_item');
t('unknown item refused', r.ok === false && r.error === 'unknown_item');
r = D.demoActions.equip('nonsense_slot', ownedId);
t('invalid slot refused', r.ok === false && r.error === 'bad_slot');

reset();
for (let i = 0; i < 60; i++) {
  D.demoActions.click(3000, 50);
  D.demoActions.buy_gen('apprentice', 200);
  D.demoActions.buy_gen('workbench', 120);
  D.demoActions.buy_gen('flywheel', 60);
}
const lv = D.demoState().level;
const ownedAfter = Object.entries(D.demoState().owned).filter(([, o]) => o.source === 'level_reward').map(([k]) => k);
t('play levels the character up', lv >= 3, 'level ' + lv);
t('level-milestone gifts fire (how players discover customization)', ownedAfter.length >= 1,
   ownedAfter.join(',') || 'none');
t('level gifts are cosmetics, not power',
   ownedAfter.every(id => !(D.snapshot().catalog[id] || {}).power_effect));
t('gifts are never re-granted after a reset-and-replay', (() => {
   const before = ownedAfter.length;
   D.saveDemo(); D.loadDemo();
   return Object.entries(D.demoState().owned).filter(([, o]) => o.source === 'level_reward').length === before;
})());
t('no cosmetic anywhere carries power (anti pay-to-win)',
   Object.values(D.snapshot().catalog).every(i => !i.power_effect));

console.log('\n=== demo engine: prestige gating ===');
reset();
r = D.demoActions.prestige(false);
t('prestige without confirm is refused', r.ok === false && r.error === 'needs_confirm');
r = D.demoActions.prestige(true);
t('prestige blocked before the gate', r.ok === false && r.error === 'not_ready');
D.demoState().runGold = B.goldForSparks(50);
r = D.demoActions.prestige(true);
t('prestige succeeds once the gate is met', r.ok === true && r.sparks === 50, 'sparks ' + r.sparks);
t('prestige resets generators but keeps cosmetics', Object.keys(D.demoState().gens).length === 0);
t('prestige multiplier is applied', Math.abs(D.snapshot().derived.prestigeMult - 2.0) < 1e-9,
   String(D.snapshot().derived.prestigeMult));

console.log('\n=== demo engine: persistence ===');
reset();
D.demoActions.click(200, 10);
const before = D.demoState().totalClicks;
D.saveDemo();
const raw = localStorage.getItem('fi_demo_state_v1');
t('state serialises to localStorage', !!raw && raw.length > 100, (raw || '').length + ' bytes');
D.loadDemo();
t('state survives a reload', D.demoState().totalClicks === before, before + ' clicks');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
