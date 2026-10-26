/* FORGE INFINITE — API client + local session + optimistic sync.
   When window.FI_DEMO is set (demo.html only) every call is served locally by
   js/demo.js — zero network access, so it works inside sandboxed previews. */

const TOKEN_KEY = 'fi_token';
const USER_KEY = 'fi_user';
// v2: auto-detect subfolder installs (example.com/game/) from the page URL —
// zero-config. window.FI_API_BASE still wins when explicitly set.
const AUTO_BASE = (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))
  ? location.pathname.replace(/\/(index\.html|demo\.html)?$/, '')
  : '';
const BASE = ((window.FI_API_BASE ?? AUTO_BASE) || '').replace(/\/$/, '');

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const getUser = () => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } };
export const setSession = (token, user) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};
export const clearSession = () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); };

let serverTimeOffset = 0;                     // serverTime - localTime, in seconds
export const serverNow = () => Math.floor(Date.now() / 1000) + serverTimeOffset;

const DEMO = () => !!globalThis.FI_DEMO;
let demoMod = null;
const demo = async () => (demoMod ||= await import('./demo.js'));

/** Translate an api.* call into a demo-engine call. Returns null if unhandled. */
async function demoCall(path, body) {
  const d = await demo();
  const b = body || {};
  if (path.endsWith('/api/auth.php'))   { d.loadDemo(b.username || 'Smith'); return { ok: true, token: 'demo-token', user: { username: d.demoState().username }, snapshot: d.snapshot({ welcome: true }) }; }
  if (path.endsWith('/api/login.php'))  { d.loadDemo(b.username || 'Smith'); return { ok: true, token: 'demo-token', user: { username: d.demoState().username }, snapshot: d.snapshot() }; }
  if (path.startsWith('/api/state.php')){ const r = d.demoActions.click(b.clicks || 0, b.combo || 0); return d.snapshot({ clicks: b.clicks ? r : null }); }
  if (path.endsWith('/api/action.php')) {
    const fn = d.demoActions[b.a];
    if (!fn) return { ok: false, error: 'unknown action' };
    const argMap = { buy_gen: () => [b.id, b.qty], buy_skill: () => [b.id], claim_quest: () => [b.id],
      claim_streak: () => [], buy: () => [b.offer], open_crate: () => [b.id, !!b.free],
      equip: () => [b.slot, b.item || null], prestige: () => [!!b.confirm],
      save_settings: () => [b.settings], click: () => [b.clicks, b.combo], logout: () => [] };
    const out = fn(...(argMap[b.a] ? argMap[b.a]() : []));
    d.saveDemo();
    return { ...out, snapshot: out && out.ok !== false ? d.snapshot() : undefined };
  }
  if (path.startsWith('/api/leaderboard.php')) return { ok: true, leaderboard: d.snapshot().leaderboard, cachedFor: 60 };
  if (path.startsWith('/api/profile.php')) {
    const s = d.snapshot();
    return { ok: true, profile: { username: s.state ? d.demoState().username : 'Smith', joinedDays: 1,
      level: s.state.level, sparks: s.state.sparks, prestige: s.state.prestigeCount, gps: s.derived.gps,
      totalGold: s.state.totalGold, totalClicks: s.state.totalClicks, streak: s.state.streakDays,
      rank: 1, achievements: d.demoState().achievements.length,
      collection: { owned: s.owned.length, total: Object.keys(s.catalog).length },
      loadout: s.loadout, signature: s.settings.signature || '', ownedIds: s.owned.map(o => o.item_id),
      catalog: s.catalog } };
  }
  if (path.startsWith('/api/pay.php')) {
    if (path.includes('a=packs')) return { ok: true, packs: d.snapshot().packs, provider: '', coins: [], quoteLockMinutes: 15 };
    if (b.a === 'create') {
      const pack = (d.snapshot().packs || []).find(p => p.id === b.pack);
      if (!pack) return { ok: false, error: 'unknown_pack' };
      return { ok: true, demo: true, idem: 'demo-' + Date.now() + '-' + pack.id, pack };
    }
    if (b.a === 'confirm_demo') {
      const packId = String(b.idem || '').split('-').pop();
      const pack = (d.snapshot().packs || []).find(p => p.id === packId);
      if (!pack) return { ok: false, error: 'unknown_pack' };
      const before = d.demoState().gems;
      if (!d.demoGrantGems(pack.gems)) return { ok: false, error: 'server_error' };
      d.saveDemo();
      return { ok: true, gems: pack.gems, pack: pack.id,
               snapshot: d.snapshot(), balanceBefore: before };
    }
    if (b.a === 'history') return { ok: true, payments: [] };
  }
  return null;
}

async function call(path, body, { auth = true, retries = 1 } = {}) {
  if (DEMO()) {
    const r = await demoCall(path, body);
    if (r) return r;
  }
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  const tok = getToken();
  if (auth && tok) headers['Authorization'] = 'Bearer ' + tok;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method: body === undefined || body === null ? 'GET' : 'POST',
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
      const st = res.headers.get('X-Server-Time');
      if (st) serverTimeOffset = (parseInt(st, 10) | 0) - Math.floor(Date.now() / 1000);

      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status === 401) {
        clearSession();
        const e = new Error('unauthorized'); e.code = 401; throw e;
      }
      if (res.status === 429) {
        const e = new Error(data?.error || 'rate_limited'); e.code = 429; throw e;
      }
      if (!res.ok || !data) {
        const e = new Error(data?.error || ('http_' + res.status)); e.code = res.status; e.data = data; throw e;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (err.code === 401 || err.code === 429 || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));     // back off on network blips
    }
  }
  throw lastErr;
}

export const api = {
  call,
  register: (username, password) => call('/api/auth.php', { username, password }, { auth: false }),
  login:    (username, password) => call('/api/login.php', { username, password }, { auth: false }),
  state:    (clicks = 0, combo = 0) => call('/api/state.php', (clicks > 0 ? { clicks, combo } : null)),
  action:   (a, params = {}) => call('/api/action.php', { a, ...params }),
  leaderboard: (limit = 50) => call(`/api/leaderboard.php?limit=${limit}`, null, { auth: false }),
  profile:  (username) => call('/api/profile.php?u=' + encodeURIComponent(username), null, { auth: false }),
  packs:    () => call('/api/pay.php?a=packs', null, { auth: false }),
  createPay:(pack) => call('/api/pay.php', { a: 'create', pack }),
  confirmDemoPay: (idem) => call('/api/pay.php', { a: 'confirm_demo', idem }),
  payHistory: () => call('/api/pay.php', { a: 'history' }),
  logout:   () => call('/api/action.php', { a: 'logout' }).catch(() => {}),
};
