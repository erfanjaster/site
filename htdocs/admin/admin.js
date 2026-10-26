/* =====================================================================
   FORGE INFINITE — admin panel (v2)
   Vanilla JS, zero dependencies. Charts are hand-rendered inline SVG.
   Talks to ../api/admin.php with the game bearer token (admin/mod role).
   ===================================================================== */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOKEN_KEY = 'fi_admin_token';
const API = '../api/admin.php';
const LOGIN = '../api/login.php';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  me: null,
  view: 'overview',
  eco: { days: 30, currency: 'gold' },
  ret: { days: 30 },
  players: { q: '', sort: 'created', page: 1 },
  events: { name: '', page: 1 },
  ledger: { currency: '', reason: '', page: 1 },
};

/* ---------------- formatting ---------------- */
const nf = new Intl.NumberFormat('en-US');
const fmtInt = n => nf.format(Math.round(+n || 0));
function fmtCompact(n) {
  n = +n || 0;
  const a = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [v, u] of units) if (a >= v) return (n / v).toFixed(a >= v * 100 ? 0 : 1).replace(/\.0$/, '') + u;
  return String(Math.round(n));
}
const fmtNum = n => (Math.abs(+n) >= 1e7 ? fmtCompact(n) : fmtInt(n));
const fmtDateTime = ts => ts ? new Date(ts * 1000).toLocaleString('fa-IR-u-nu-latn', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString('fa-IR-u-nu-latn') : '—';
function fmtBytes(b) {
  b = +b || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 90) return 'الان';
  if (s < 5400) return Math.round(s / 60) + ' دقیقه پیش';
  if (s < 129600) return Math.round(s / 3600) + ' ساعت پیش';
  return Math.round(s / 86400) + ' روز پیش';
}
const ratioClass = r => r == null ? '' : (r >= 0.9 && r <= 1.1 ? 'ratio-ok' : (r >= 0.75 && r <= 1.25 ? 'ratio-warn' : 'ratio-bad'));

/* ---------------- toasts ---------------- */
function toast(msg, ok = true) {
  const t = document.createElement('div');
  t.className = 'toast ' + (ok ? 'ok' : 'err-t');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

/* ---------------- API ---------------- */
async function api(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
    body: JSON.stringify({ ...body, token: state.token }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401) { logout(false); throw new Error('نشست منقضی شد؛ دوباره وارد شوید'); }
  if (!data.ok) throw new Error(data.error || ('خطای ' + res.status));
  return data;
}

/* ---------------- SVG charts ---------------- */
const C = { up: '#4ADE80', down: '#F87171', ember: '#FFB020', steel: '#7DD3FC', violet: '#C084FC', gem: '#2DD4BF', grid: '#3B3229' };
let chartSeq = 0;

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/** Multi-line chart with soft gradient areas. series: [{label,color,data:[n..],fill}] */
function lineChart({ series, x, height = 230 }) {
  const W = 760, H = height, L = 52, R = 12, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(1, ...series.flatMap(s => s.data)));
  const n = Math.max(2, x.length);
  const px = i => L + (i / (n - 1)) * iw;
  const py = v => T + ih - (v / max) * ih;
  const id = 'g' + (++chartSeq);
  let defs = '', paths = '', dots = '';
  series.forEach((s, si) => {
    const gid = id + '_' + si;
    defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".32"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
    const pts = s.data.map((v, i) => [px(i), py(v)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    if (s.fill !== false) paths += `<path d="${d} L${px(pts.length - 1).toFixed(1)} ${T + ih} L${px(0).toFixed(1)} ${T + ih} Z" fill="url(#${gid})"/>`;
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    dots += pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="6" fill="transparent"><title>${esc(x[i])} · ${esc(s.label)}: ${fmtInt(s.data[i])}</title></circle><circle cx="${p[0]}" cy="${p[1]}" r="2" fill="${s.color}"/>`).join('');
  });
  let grid = '', ylab = '';
  for (let g = 0; g <= 4; g++) {
    const v = max * g / 4, y = py(v);
    grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/>`;
    ylab += `<text class="lbl" x="${L - 7}" y="${y + 3.5}" text-anchor="end">${fmtCompact(v)}</text>`;
  }
  const step = Math.max(1, Math.ceil(x.length / 8));
  const xlab = x.map((v, i) => i % step === 0 ? `<text class="lbl" x="${px(i)}" y="${H - 7}" text-anchor="middle">${esc(String(v).slice(5))}</text>` : '').join('');
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img"><defs>${defs}</defs><g class="grid">${grid}</g>${paths}${dots}${ylab}${xlab}</svg></div>
  <div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

/** Grouped bars (created vs burned) + optional net line. */
function barChart({ x, a, b, line, height = 250 }) {
  const W = 760, H = height, L = 52, R = 12, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(1, ...a.data, ...b.data, ...(line ? line.data.map(Math.abs) : [])));
  const n = x.length, slot = iw / Math.max(1, n), bw = Math.max(2, slot * 0.34);
  const py = v => T + ih - (v / max) * ih;
  let bars = '';
  for (let i = 0; i < n; i++) {
    const cx = L + slot * i + slot / 2;
    const ya = py(a.data[i]), yb = py(b.data[i]);
    bars += `<rect x="${(cx - bw - 1).toFixed(1)}" y="${ya.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, T + ih - ya).toFixed(1)}" rx="1.5" fill="${a.color}" opacity=".9"><title>${esc(x[i])} · ${esc(a.label)}: ${fmtInt(a.data[i])}</title></rect>`;
    bars += `<rect x="${(cx + 1).toFixed(1)}" y="${yb.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, T + ih - yb).toFixed(1)}" rx="1.5" fill="${b.color}" opacity=".9"><title>${esc(x[i])} · ${esc(b.label)}: ${fmtInt(b.data[i])}</title></rect>`;
  }
  let lp = '';
  if (line) {
    // net normalized to its own max, centered on a dashed zero line
    const nmax = niceMax(Math.max(1, ...line.data.map(Math.abs)));
    const midY = T + ih / 2;
    const npy = v => midY - (v / nmax) * (ih / 2);
    const d = line.data.map((v, i) => (i ? 'L' : 'M') + (L + slot * i + slot / 2).toFixed(1) + ' ' + npy(v).toFixed(1)).join(' ');
    lp = `<line x1="${L}" y1="${midY}" x2="${W - R}" y2="${midY}" stroke="${line.color}" stroke-opacity=".25" stroke-dasharray="3 4"/>
          <path d="${d}" fill="none" stroke="${line.color}" stroke-width="2" stroke-dasharray="5 3" stroke-linejoin="round"/>`
      + line.data.map((v, i) => `<circle cx="${(L + slot * i + slot / 2).toFixed(1)}" cy="${npy(v).toFixed(1)}" r="5" fill="transparent"><title>${esc(x[i])} · ${esc(line.label)}: ${fmtInt(v)}</title></circle>`).join('');
  }
  let grid = '', ylab = '';
  for (let g = 0; g <= 4; g++) {
    const v = max * g / 4, y = py(v);
    grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/>`;
    ylab += `<text class="lbl" x="${L - 7}" y="${y + 3.5}" text-anchor="end">${fmtCompact(v)}</text>`;
  }
  const step = Math.max(1, Math.ceil(x.length / 8));
  const xlab = x.map((v, i) => i % step === 0 ? `<text class="lbl" x="${(L + slot * i + slot / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(String(v).slice(5))}</text>` : '').join('');
  const items = [a, b, ...(line ? [line] : [])];
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img"><g class="grid">${grid}</g>${bars}${lp}${ylab}${xlab}</svg></div>
  <div class="legend">${items.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

/* Horizontal stacked created/burned rows (reason breakdown). */
function reasonBars(reasons) {
  const max = Math.max(1, ...reasons.map(r => (+r.created) + (+r.burned)));
  return `<div class="hbars">` + reasons.map(r => {
    const c = +r.created || 0, b = +r.burned || 0, tot = c + b;
    const w = (tot / max * 100).toFixed(1);
    const cw = tot > 0 ? (c / tot * 100).toFixed(1) : 0;
    return `<div class="hbar"><span class="nm" title="${esc(r.reason)}">${esc(r.reason)}</span>
      <span class="track"><span class="fill-c" style="width:${(w * cw / 100).toFixed(1)}%"></span><span class="fill-b" style="width:${(w * (100 - cw) / 100).toFixed(1)}%"></span></span>
      <span class="vv" title="ساخته‌شده ${fmtInt(c)} · سوخته ${fmtInt(b)}">${fmtNum(tot)}</span></div>`;
  }).join('') + `</div>
  <div class="legend"><span><i style="background:${C.up}"></i>ورودی (faucet)</span><span><i style="background:${C.down}"></i>خروجی (sink)</span></div>`;
}

function pager(page, pages, onprefix) {
  return `<div class="pager">
    <button class="btn btn-sm" data-pg="${onprefix}:prev" ${page <= 1 ? 'disabled' : ''}>قبلی</button>
    <span>صفحه <span class="num">${page}</span> از <span class="num">${pages}</span></span>
    <button class="btn btn-sm" data-pg="${onprefix}:next" ${page >= pages ? 'disabled' : ''}>بعدی</button>
  </div>`;
}

/* =====================================================================
   VIEWS
   ===================================================================== */
const content = () => $('#content');
const kpi = (lbl, val, cls = '', sub = '') =>
  `<div class="kpi"><div class="lbl">${esc(lbl)}</div><div class="val ${cls}">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

/* ---------------- overview ---------------- */
async function viewOverview() {
  const { overview: o } = await api({ a: 'overview' });
  const g = o.gold_24h, ratio = g.ratio;
  const ratioHtml = ratio == null ? '—'
    : `<span class="${ratioClass(ratio)}">${ratio}</span>`;
  const econAlert = ratio != null && (ratio > 1.2 || ratio < 0.75)
    ? `<div class="alert bad">⚠️ <b>هشدار تورم:</b> نسبت ورودی/خروجی طلای ۲۴ ساعت اخیر <span class="num">${ratio}</span> است (باند سالم 0.9 تا 1.1). در بخش «اقتصاد» دلایل را بررسی کنید.</div>` : '';
  content().innerHTML = `
    <div><h2 class="view-h">📊 نمای کلی</h2><p class="view-sub">وضعیت زنده‌ی بازی از جداول users، ledger و events</p></div>
    ${econAlert}
    <div class="grid kpis">
      ${kpi('کل بازیکنان', fmtInt(o.users_total), 'ember', `جدید ۲۴س: <span class="num">${fmtInt(o.users_new_24h)}</span> · ۷روز: <span class="num">${fmtInt(o.users_new_7d)}</span>`)}
      ${kpi('آنلاین الان', fmtInt(o.online_now), 'steel', 'فعال در ۵ دقیقه اخیر')}
      ${kpi('DAU · WAU · MAU', `${fmtInt(o.dau)} / ${fmtInt(o.wau)} / ${fmtInt(o.mau)}`, '', `چسبندگی (DAU/MAU): <span class="num">${o.stickiness}%</span>`)}
      ${kpi('نشست‌های ۲۴س', fmtInt(o.sessions_24h), '', 'رویداد session_start')}
      ${kpi('طلای در گردش', fmtNum(o.gold_circ), 'gold')}
      ${kpi('جم در گردش', fmtNum(o.gems_circ), 'gem')}
      ${kpi('نسبت faucet/sink طلا (۲۴س)', ratioHtml, '', `ساخته‌شده <span class="num">${fmtNum(g.created)}</span> · سوخته <span class="num">${fmtNum(g.burned)}</span>`)}
      ${kpi('تراکنش‌های ledger (۲۴س)', fmtInt(o.ledger_tx_24h), '')}
      ${kpi('درآمد کل (USD)', '$' + fmtInt(o.revenue_total), 'gold', `۳۰ روز: $${fmtInt(o.revenue_30d)} · پرداخت‌کننده: <span class="num">${fmtInt(o.payers_30d)}</span>`)}
    </div>
    <div class="grid cols2">
      <div class="card"><h3>🚰 بزرگ‌ترین ورودی‌های ارز (۷ روز)</h3>
        ${o.top_faucets_7d.length ? reasonRows(o.top_faucets_7d, true) : '<p class="muted">داده‌ای نیست</p>'}</div>
      <div class="card"><h3>🔥 بزرگ‌ترین خروجی‌های ارز (۷ روز)</h3>
        ${o.top_sinks_7d.length ? reasonRows(o.top_sinks_7d, false) : '<p class="muted">داده‌ای نیست</p>'}</div>
    </div>
    ${o.last_snapshot ? `<div class="card"><h3>🩺 آخرین اسنپ‌شات سلامت اقتصاد <span class="hint">${fmtDateTime(o.last_snapshot.taken_at)} — از کرون‌جاب economy.php یا دکمه‌ی بخش سیستم</span></h3>
      <div class="grid kpis">
        ${kpi('طلای ساخته‌شده ۲۴س', fmtNum(o.last_snapshot.gold_created_24h), 'gold')}
        ${kpi('طلای سوخته ۲۴س', fmtNum(o.last_snapshot.gold_burned_24h))}
        ${kpi('نسبت', `<span class="${ratioClass(o.last_snapshot.faucet_sink_ratio)}">${o.last_snapshot.faucet_sink_ratio ?? '—'}</span>`)}
        ${kpi('میانه‌ی موجودی طلا', fmtNum(o.last_snapshot.median_gold), 'gold')}
        ${kpi('فعال ۲۴س', fmtInt(o.last_snapshot.active_users_24h), 'steel')}
      </div></div>` : `<div class="alert warn">هنوز اسنپ‌شات اقتصاد ثبت نشده؛ کرون‌جاب <span class="mono">jobs/economy.php</span> را فعال کنید یا از بخش «سیستم» یک اسنپ‌شات دستی بگیرید.</div>`}`;
}
function reasonRows(list, positive) {
  const max = Math.max(1, ...list.map(r => Math.abs(+r.total)));
  return `<div class="hbars">` + list.map(r => {
    const t = Math.abs(+r.total);
    return `<div class="hbar"><span class="nm" title="${esc(r.reason)}">${esc(r.reason)} <span class="dim">${esc(r.currency)}</span></span>
      <span class="track"><span class="${positive ? 'fill-c' : 'fill-b'}" style="width:${(t / max * 100).toFixed(1)}%"></span></span>
      <span class="vv">${fmtNum(t)}</span></div>`;
  }).join('') + `</div>`;
}

/* ---------------- economy ---------------- */
const CUR_LABEL = { gold: 'طلا', gems: 'جم', tokens: 'توکن' };
async function viewEconomy() {
  const e = state.eco;
  const { economy: d } = await api({ a: 'economy', days: e.days, currency: e.currency });
  const x = d.series.map(s => s.day);
  const totC = d.series.reduce((a, s) => a + s.created, 0);
  const totB = d.series.reduce((a, s) => a + s.burned, 0);
  const ratio = totB > 0 ? Math.round(totC / totB * 1000) / 1000 : null;
  content().innerHTML = `
    <div><h2 class="view-h">💰 اقتصاد بازی</h2><p class="view-sub">تحلیل جریان ارز از جدول ledger — هر تغییر موجودی یک ردیف است</p></div>
    <div class="toolbar">
      <select id="ecoCur" aria-label="ارز">${Object.entries(CUR_LABEL).map(([k, v]) => `<option value="${k}" ${e.currency === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select id="ecoDays" aria-label="بازه">${[7, 14, 30, 60, 90].map(n => `<option ${n === e.days ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="sub">روز اخیر</span><span class="spacer"></span>
      <button class="btn btn-sm" id="snapBtn">📸 ثبت اسنپ‌شات الان</button>
    </div>
    <div class="grid kpis">
      ${kpi(CUR_LABEL[d.currency] + ' در گردش', fmtNum(d.circulation), d.currency === 'gems' ? 'gem' : 'gold')}
      ${kpi('میانه‌ی موجودی بازیکن', fmtNum(d.median), '')}
      ${kpi('ساخته‌شده در بازه', fmtNum(totC), '')}
      ${kpi('سوخته در بازه', fmtNum(totB), '')}
      ${kpi('نسبت faucet/sink بازه', ratio == null ? '—' : `<span class="${ratioClass(ratio)}">${ratio}</span>`, '', 'باند سالم: 0.9 تا 1.1')}
    </div>
    <div class="card"><h3>جریان روزانه‌ی ${esc(CUR_LABEL[d.currency])} <span class="hint">خط‌چین زرد = خالص روزانه (مقیاس خودش، مرکز = صفر)</span></h3>
      ${barChart({ x, a: { label: 'ساخته‌شده (faucet)', color: C.up, data: d.series.map(s => s.created) }, b: { label: 'سوخته (sink)', color: C.down, data: d.series.map(s => s.burned) }, line: { label: 'خالص', color: C.ember, data: d.series.map(s => s.net) } })}
    </div>
    <div class="grid cols2">
      <div class="card"><h3>تفکیک بر اساس دلیل (reason) <span class="hint">در بازه‌ی انتخاب‌شده</span></h3>
        ${d.reasons.length ? reasonBars(d.reasons) : '<p class="muted">داده‌ای نیست</p>'}</div>
      <div class="card"><h3>🏦 ثروتمندترین بازیکنان (${esc(CUR_LABEL[d.currency])}) <span class="hint">برای کشف اکسپلویت</span></h3>
        <div class="hbars">${d.top_holders.map(h => {
          const max = Math.max(1, ...d.top_holders.map(t => +t.balance));
          return `<div class="hbar"><span class="nm clickable" data-player="${h.user_id}">${esc(h.username)}</span>
            <span class="track"><span class="fill-c" style="width:${(+h.balance / max * 100).toFixed(1)}%;background:linear-gradient(90deg,#D97706,#FFC53D)"></span></span>
            <span class="vv">${fmtNum(h.balance)}</span></div>`;
        }).join('') || '<p class="muted">—</p>'}</div></div>
    </div>`;
  $('#ecoCur').onchange = ev => { state.eco.currency = ev.target.value; rerender(); };
  $('#ecoDays').onchange = ev => { state.eco.days = +ev.target.value; rerender(); };
  $('#snapBtn').onclick = async () => {
    try { const r = await api({ a: 'snapshot_now' }); toast('اسنپ‌شات #' + r.snapshot_id + ' ثبت شد (نسبت ' + r.ratio + ')'); rerender(); }
    catch (e) { toast(e.message, false); }
  };
  bindPlayers();
}

/* ---------------- retention ---------------- */
async function viewRetention() {
  const r = state.ret;
  const { retention: d } = await api({ a: 'retention', days: r.days });
  const x = d.series.map(s => s.day);
  const sum = d.summary;
  const sumCard = (k) => sum[k] == null ? '—' : `<span class="num">${sum[k]}%</span>`;
  content().innerHTML = `
    <div><h2 class="view-h">📈 ریتنشن و فعالیت</h2><p class="view-sub">از رویدادهای session_start در جدول events (یک رویداد به‌ازای هر بازگشت بازیکن)</p></div>
    <div class="toolbar">
      <select id="retDays" aria-label="بازه">${[7, 14, 30, 60, 90].map(n => `<option ${n === r.days ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="sub">روز اخیر</span>
    </div>
    <div class="grid kpis">
      ${kpi('DAU (امروز/۲۴س)', fmtInt(d.dau), 'ember')}
      ${kpi('WAU', fmtInt(d.wau), 'steel')}
      ${kpi('MAU', fmtInt(d.mau), '')}
      ${kpi('چسبندگی DAU/MAU', `<span class="num">${d.stickiness}%</span>`, '', 'بالای ۲۰٪ = عالی')}
      ${kpi('ریتنشن D1', sumCard('D1'), '', 'میانگین کوهورت‌های بالغ')}
      ${kpi('ریتنشن D7', sumCard('D7'), '')}
      ${kpi('ریتنشن D30', sumCard('D30'), '')}
    </div>
    <div class="card"><h3>کاربران فعال روزانه و ثبت‌نام جدید</h3>
      ${lineChart({ x, series: [
        { label: 'DAU', color: C.ember, data: d.series.map(s => s.dau) },
        { label: 'کاربر جدید', color: C.steel, data: d.series.map(s => s.new) },
        { label: 'نشست', color: C.violet, data: d.series.map(s => s.sessions), fill: false },
      ] })}</div>
    <div class="card"><h3>🎯 جدول کوهورت ثبت‌نام <span class="hint">درصدی از کاربران هر روز که در روز Dn برگشته‌اند · ۱۴ روز اخیر</span></h3>
      ${d.cohorts.length ? cohortTable(d) : '<p class="muted">هنوز داده‌ی کوهورت نداریم — بعد از چند روز فعالیت بازیکنان پر می‌شود.</p>'}</div>
    <div class="card"><h3>🧩 ترکیب فعالیت (۷ روز) <span class="hint">فراوانی رویدادها در events</span></h3>
      ${d.activity_mix_7d.length ? `<div class="hbars">${d.activity_mix_7d.map(ev => {
        const max = Math.max(1, ...d.activity_mix_7d.map(t => +t.n));
        return `<div class="hbar"><span class="nm" title="${esc(ev.name)}">${esc(ev.name)}</span>
          <span class="track"><span class="fill-c" style="width:${(+ev.n / max * 100).toFixed(1)}%;background:linear-gradient(90deg,#C2410C,#FFB020)"></span></span>
          <span class="vv">${fmtInt(ev.n)}</span></div>`;
      }).join('')}</div>` : '<p class="muted">داده‌ای نیست</p>'}</div>`;
  $('#retDays').onchange = ev => { state.ret.days = +ev.target.value; rerender(); };
}
function cohortTable(d) {
  const marks = d.marks.map(m => 'D' + m);
  const rows = d.cohorts.map(c => `<tr><td class="num">${esc(c.day)}</td><td class="num">${fmtInt(c.size)}</td>` +
    marks.map(mk => {
      const v = c.r[mk];
      if (v == null) return '<td class="na">·</td>';
      const a = Math.min(0.62, v / 100 * 0.85);
      return `<td class="cell" style="background:rgba(74,222,128,${a.toFixed(2)})">${v}%</td>`;
    }).join('') + '</tr>').join('');
  return `<div class="tbl-wrap"><table class="cohort"><thead><tr><th>روز ثبت‌نام</th><th>تعداد</th>${marks.map(m => `<th class="num">${m}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ---------------- players ---------------- */
async function viewPlayers() {
  const p = state.players;
  const d = await api({ a: 'players', q: p.q, sort: p.sort, page: p.page });
  content().innerHTML = `
    <div><h2 class="view-h">👥 بازیکنان</h2><p class="view-sub">کل: <span class="num">${fmtInt(d.total)}</span> نفر — روی نام بازیکن کلیک کنید</p></div>
    <div class="toolbar">
      <input type="search" id="pq" placeholder="جستجوی نام کاربری…" value="${esc(p.q)}" dir="ltr" style="text-align:left;min-width:200px">
      <select id="psort" aria-label="مرتب‌سازی">
        ${[['created', 'جدیدترین'], ['last_seen', 'آخرین فعالیت'], ['gold', 'بیشترین طلا'], ['gems', 'بیشترین جم'], ['level', 'بالاترین لول'], ['clicks', 'بیشترین کلیک'], ['total_gold', 'مجموع طلای عمر']].map(([k, v]) => `<option value="${k}" ${p.sort === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <div class="tbl-wrap"><table><thead><tr>
      <th>بازیکن</th><th>لول</th><th>طلا</th><th>جم</th><th>پرستیژ</th><th>کلیک</th><th>عضویت</th><th>آخرین فعالیت</th><th>وضعیت</th>
    </tr></thead><tbody>
      ${d.players.map(u => `<tr class="${u.is_banned ? 'banned' : ''}">
        <td><span class="clickable" data-player="${u.id}">${esc(u.username)}</span>
          ${u.role === 'admin' ? '<span class="tag admin">admin</span>' : u.role === 'mod' ? '<span class="tag mod">mod</span>' : ''}</td>
        <td class="num">${u.level ?? '—'}</td>
        <td class="num">${u.gold == null ? '—' : fmtNum(u.gold)}</td>
        <td class="num">${u.gems ?? '—'}</td>
        <td class="num">${u.prestige_count ?? '—'}</td>
        <td class="num">${u.total_clicks == null ? '—' : fmtInt(u.total_clicks)}</td>
        <td>${fmtDate(u.created_at)}</td>
        <td title="${esc(fmtDateTime(u.last_seen_at))}">${ago(u.last_seen_at)}</td>
        <td>${u.is_banned ? '<span class="tag ban">بن</span>' : '<span class="muted small">فعال</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted" style="text-align:center">بازیکنی پیدا نشد</td></tr>'}
    </tbody></table></div>
    ${pager(d.page, d.pages, 'players')}`;
  let t;
  $('#pq').oninput = ev => { clearTimeout(t); t = setTimeout(() => { state.players.q = ev.target.value.trim(); state.players.page = 1; rerender(true); }, 350); };
  $('#psort').onchange = ev => { state.players.sort = ev.target.value; state.players.page = 1; rerender(); };
  bindPlayers(); bindPager('players', d.page, d.pages);
}

/* ---------------- events ---------------- */
async function viewEvents() {
  const p = state.events;
  const d = await api({ a: 'events_explore', name: p.name, page: p.page });
  content().innerHTML = `
    <div><h2 class="view-h">🧾 رویدادها (events)</h2><p class="view-sub">تله‌متری رفتاری بازی — کل: <span class="num">${fmtInt(d.total)}</span></p></div>
    <div class="toolbar">
      <select id="evName" aria-label="نوع رویداد"><option value="">همه‌ی رویدادها</option>
        ${d.names.map(n => `<option value="${esc(n.name)}" ${p.name === n.name ? 'selected' : ''}>${esc(n.name)} (${fmtInt(n.n)})</option>`).join('')}</select>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>زمان</th><th>بازیکن</th><th>رویداد</th><th>جزئیات</th></tr></thead><tbody>
      ${d.events.map(e => `<tr><td class="num dim">${e.id}</td><td>${fmtDateTime(e.created_at)}</td>
        <td>${e.username ? `<span class="clickable" data-player="${e.user_id}">${esc(e.username)}</span>` : '<span class="dim">سیستم</span>'}</td>
        <td class="mono">${esc(e.name)}</td>
        <td class="mono dim" style="font-size:11px;max-width:340px;overflow:hidden;text-overflow:ellipsis">${esc(e.props_json || '')}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted" style="text-align:center">رویدادی نیست</td></tr>'}
    </tbody></table></div>
    ${pager(d.page, d.pages, 'events')}`;
  $('#evName').onchange = ev => { state.events.name = ev.target.value; state.events.page = 1; rerender(); };
  bindPlayers(); bindPager('events', d.page, d.pages);
}

/* ---------------- ledger ---------------- */
async function viewLedger() {
  const p = state.ledger;
  const d = await api({ a: 'ledger_explore', currency: p.currency, reason: p.reason, page: p.page });
  content().innerHTML = `
    <div><h2 class="view-h">📒 دفتر کل (ledger)</h2><p class="view-sub">هر تغییر ارز با دلیل و موجودی بعد از آن — کل: <span class="num">${fmtInt(d.total)}</span></p></div>
    <div class="toolbar">
      <select id="lgCur" aria-label="ارز"><option value="">همه ارزها</option>
        ${['gold', 'gems', 'tokens', 'energy'].map(c => `<option ${p.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <select id="lgReason" aria-label="دلیل"><option value="">همه دلایل</option>
        ${d.reasons.map(r => `<option value="${esc(r.reason)}" ${p.reason === r.reason ? 'selected' : ''}>${esc(r.reason)} · ${esc(r.currency)} (${fmtInt(r.n)})</option>`).join('')}</select>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>زمان</th><th>بازیکن</th><th>ارز</th><th>تغییر</th><th>موجودی بعد</th><th>دلیل</th></tr></thead><tbody>
      ${d.ledger.map(l => `<tr><td class="num dim">${l.id}</td><td>${fmtDateTime(l.created_at)}</td>
        <td>${l.username ? `<span class="clickable" data-player="${l.user_id}">${esc(l.username)}</span>` : '—'}</td>
        <td class="mono">${esc(l.currency)}</td>
        <td class="num ${+l.delta >= 0 ? 'up' : 'down'}">${+l.delta >= 0 ? '+' : ''}${fmtNum(l.delta)}</td>
        <td class="num">${fmtNum(l.balance)}</td>
        <td class="mono">${esc(l.reason)}</td></tr>`).join('')
      || '<tr><td colspan="7" class="muted" style="text-align:center">تراکنشی نیست</td></tr>'}
    </tbody></table></div>
    ${pager(d.page, d.pages, 'ledger')}`;
  $('#lgCur').onchange = ev => { state.ledger.currency = ev.target.value; state.ledger.page = 1; rerender(); };
  $('#lgReason').onchange = ev => { state.ledger.reason = ev.target.value; state.ledger.page = 1; rerender(); };
  bindPlayers(); bindPager('ledger', d.page, d.pages);
}

/* ---------------- system ---------------- */
async function viewSystem() {
  const { system: s } = await api({ a: 'system' });
  const P = s.protection;
  const okIco = b => b ? '<span class="up">✅ هست</span>' : '<span class="down">❌ نیست!</span>';
  const warnings = [];
  if (P.installer_present) warnings.push('⚠️ فایل <span class="mono">install.php</span> هنوز روی هاست هست — پاکش کنید (قفل شده، ولی بهتر است نباشد).');
  if (s.debug) warnings.push('⚠️ <span class="mono">FI_DEBUG</span> روشن است — در پروداکشن خاموش کنید.');
  if (s.journal_mode !== 'wal') warnings.push('🚨 journal_mode دیتابیس <b>' + esc(s.journal_mode) + '</b> است نه <b>wal</b> — فضای هاست NFS است و SQLite در معرض خرابی است.');
  if (!s.db_randomized) warnings.push('⚠️ نام دیتابیس <span class="mono">game.db</span> قابل حدس است؛ نام تصادفی امن‌تر است.');
  if (!P.storage_htaccess || !P.jobs_htaccess || !P.api_htaccess) warnings.push('🚨 یکی از .htaccessهای محافظ آپلود نشده (کلاینت‌های FTP فایل‌های نقطه‌دار را مخفی می‌کنند). دستی آپلود کنید.');
  if (!s.https) warnings.push('⚠️ HTTPS فعال نیست — از cPanel → SSL/TLS Status → AutoSSL فعال کنید.');
  const base = location.origin + location.pathname.replace(/admin\/?$/, '');
  content().innerHTML = `
    <div><h2 class="view-h">🛡️ سیستم و امنیت</h2><p class="view-sub">خودارزیابی زنده‌ی محیط اجرا و لایه‌های محافظ دیتابیس داخل htdocs</p></div>
    ${warnings.length ? `<div class="alert ${warnings.some(w => w.startsWith('🚨')) ? 'bad' : 'warn'}">${warnings.join('<br>')}</div>` : '<div class="alert ok">✅ همه‌ی بررسی‌های امنیتی پاس شدند.</div>'}
    <div class="grid kpis">
      ${kpi('نسخه بازی', esc(s.version), 'ember')}
      ${kpi('PHP', '<span class="num">' + esc(s.php) + '</span>', '', esc(s.sapi || ''))}
      ${kpi('SQLite', '<span class="num">' + esc(s.sqlite) + '</span>', '', 'journal: <span class="mono">' + esc(s.journal_mode) + '</span>')}
      ${kpi('حجم دیتابیس', fmtBytes(s.db_size), 'gold', 'WAL: ' + fmtBytes(s.wal_size))}
      ${kpi('درگاه پرداخت', s.pay_provider === 'demo' ? '🧪 دمو' : esc(s.pay_provider), s.pay_provider === 'demo' ? '' : 'ember')}
      ${kpi('زمان سرور (UTC)', '<span class="num" style="font-size:15px">' + esc(s.server_time.replace('T', ' ').slice(0, 19)) + '</span>', '')}
    </div>
    <div class="grid cols2">
      <div class="card"><h3>🧱 لایه‌های محافظ htdocs</h3><div class="checks">
        <div class="check"><span class="mono">.htaccess ریشه</span>${okIco(P.root_htaccess)}</div>
        <div class="check"><span class="mono">storage/.htaccess</span>${okIco(P.storage_htaccess)}</div>
        <div class="check"><span class="mono">storage/index.php (گارد)</span>${okIco(P.storage_guard)}</div>
        <div class="check"><span class="mono">jobs/.htaccess</span>${okIco(P.jobs_htaccess)}</div>
        <div class="check"><span class="mono">api/.htaccess</span>${okIco(P.api_htaccess)}</div>
        <div class="check"><span class="mono">web.config (IIS)</span>${okIco(P.web_config)}</div>
        <div class="check"><span>نام تصادفی دیتابیس</span>${s.db_randomized ? '<span class="up">✅ ' + esc(s.db_file) + '</span>' : '<span class="warn-t">⚠ game.db</span>'}</div>
        <div class="check"><span>قفل نصب (installed.lock)</span>${okIco(P.installed_lock)}</div>
        <div class="check"><span>install.php روی هاست</span>${P.installer_present ? '<span class="warn-t">⚠️ هنوز هست — حذفش کنید</span>' : '<span class="up">✅ حذف شده</span>'}</div>
        <div class="check"><span>FI_DEBUG</span>${s.debug ? '<span class="warn-t">⚠️ روشن</span>' : '<span class="up">✅ خاموش</span>'}</div>
        <div class="check"><span>HTTPS</span>${s.https ? '<span class="up">✅ فعال</span>' : '<span class="warn-t">⚠️ غیرفعال</span>'}</div>
      </div>
      <p class="small muted" style="margin-top:10px">تست دستی (باید 403/404 بدهند):
        <a href="${base}storage/" target="_blank" rel="noopener">storage/</a> ·
        <a href="${base}api/install.sql" target="_blank" rel="noopener">install.sql</a> ·
        <a href="${base}jobs/backup.php" target="_blank" rel="noopener">jobs/backup.php</a></p>
      </div>
      <div class="card"><h3>🗄️ رکورد جداول</h3><div class="checks">
        ${Object.entries(s.tables).map(([t, n]) => `<div class="check"><span class="mono">${esc(t)}</span><span class="num">${n == null ? '—' : fmtInt(n)}</span></div>`).join('')}
      </div>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn btn-sm btn-primary" id="bkBtn">💾 گرفتن بک‌آپ الان</button>
        <button class="btn btn-sm" id="snapBtn2">📸 اسنپ‌شات اقتصاد</button>
      </div>
      <p class="small muted">بک‌آپ‌ها در <span class="mono">storage/backup/</span> (غیرقابل دانلود از وب):<br>
      ${s.backups.length ? s.backups.map(b => `<span class="mono">${esc(b.name)}</span> (${fmtBytes(b.size)})`).join('<br>') : 'هنوز بک‌آپی نیست'}</p>
      </div>
    </div>
    <div class="card"><h3>⏰ کرون‌جاب‌های cPanel <span class="hint">مسیر را با پوشه‌ی هاست خودتان تنظیم کنید</span></h3>
      <pre class="code">15 * * * * /usr/local/bin/php /home/USER/public_html/jobs/cleanup.php &gt;/dev/null 2&gt;&amp;1
45 * * * * /usr/local/bin/php /home/USER/public_html/jobs/economy.php &gt;&gt;/home/USER/public_html/storage/economy.log 2&gt;&amp;1
10 3 * * * /usr/local/bin/php /home/USER/public_html/jobs/backup.php &gt;&gt;/home/USER/public_html/storage/backup.log 2&gt;&amp;1</pre>
      <h3 style="margin-top:16px">🌐 اگر وب‌سرور nginx است</h3>
      <p class="small muted">nginx فایل .htaccess را نمی‌خواند. این قطعه باید داخل server block قرار بگیرد (نام تصادفی دیتابیس لایه‌ی آخر دفاع است):</p>
      <pre class="code">location ^~ /storage/ { deny all; return 403; }
location ^~ /jobs/    { deny all; return 403; }
location ~* \\.(sqlite3?|db|sql|log|md|ini|env|bak)$ { deny all; return 403; }
location ~ /\\.(?!well-known) { deny all; return 403; }</pre>
    </div>
    <div class="card"><h3>📜 لاگ اقدامات ادمین (admin_audit)</h3>
      <div class="tbl-wrap" style="border:0"><table class="mini" style="min-width:0"><thead><tr><th>زمان</th><th>ادمین</th><th>اقدام</th><th>هدف</th><th>جزئیات</th></tr></thead><tbody>
      ${s.audit.map(a => `<tr><td>${fmtDateTime(a.created_at)}</td><td>${esc(a.actor_name || '—')}</td><td class="mono">${esc(a.action)}</td>
        <td class="mono">${esc(a.target_type || '')}:${esc(a.target_id || '')}</td>
        <td class="props">${esc(a.detail_json || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">هنوز اقدامی ثبت نشده</td></tr>'}
      </tbody></table></div></div>`;
  $('#bkBtn').onclick = async () => {
    try { const r = await api({ a: 'backup_now' }); toast('بک‌آپ ساخته شد: ' + r.backup + ' (' + fmtBytes(r.size) + ')'); rerender(); }
    catch (e) { toast(e.message, false); }
  };
  $('#snapBtn2').onclick = async () => {
    try { const r = await api({ a: 'snapshot_now' }); toast('اسنپ‌شات #' + r.snapshot_id + ' ثبت شد'); }
    catch (e) { toast(e.message, false); }
  };
}

/* ---------------- player drawer ---------------- */
async function openPlayer(id) {
  const back = $('#drawer'), body = $('#drawerBody');
  back.classList.remove('hidden');
  body.innerHTML = '<p class="muted">در حال بارگذاری…</p>';
  try {
    const d = await api({ a: 'player', id });
    const p = d.player;
    const isAdmin = state.me?.role === 'admin';
    const self = state.me?.id === +p.id;
    body.innerHTML = `
      <h2>${esc(p.username)} ${p.role === 'admin' ? '<span class="tag admin">admin</span>' : p.role === 'mod' ? '<span class="tag mod">mod</span>' : ''}
      ${+p.is_banned ? '<span class="tag ban">بن شده</span>' : ''}</h2>
      <dl class="kv">
        <dt>آیدی</dt><dd>${p.id}</dd>
        <dt>عضویت</dt><dd>${fmtDate(p.created_at)}</dd>
        <dt>آخرین فعالیت</dt><dd>${ago(p.last_seen_at)}</dd>
        <dt>لول / XP</dt><dd>${p.level ?? '—'} / ${p.xp ?? '—'}</dd>
        <dt>طلا</dt><dd>${p.gold == null ? '—' : fmtInt(p.gold)}</dd>
        <dt>جم / توکن</dt><dd>${p.gems ?? '—'} / ${p.tokens ?? '—'}</dd>
        <dt>Sparks / پرستیژ</dt><dd>${p.sparks ?? '—'} / ${p.prestige_count ?? '—'}</dd>
        <dt>مجموع طلای عمر</dt><dd>${p.total_gold == null ? '—' : fmtNum(p.total_gold)}</dd>
        <dt>کلیک کل</dt><dd>${p.total_clicks == null ? '—' : fmtInt(p.total_clicks)}</dd>
        <dt>استریک</dt><dd>${p.streak_days ?? '—'} روز</dd>
        <dt>آیتم کازمتیک</dt><dd>${fmtInt(d.items_owned)}</dd>
        <dt>نشست فعال</dt><dd>${fmtInt(d.sessions)}</dd>
      </dl>
      ${isAdmin ? `
      <div class="sec"><h4>💰 تغییر موجودی (grant)</h4>
        <div class="grant-row">
          <select id="grCur"><option value="gold">طلا</option><option value="gems">جم</option><option value="tokens">توکن</option></select>
          <input type="number" id="grAmt" placeholder="مثلاً 100000 یا -500">
          <input type="text" id="grNote" placeholder="یادداشت (اختیاری)">
          <button class="btn btn-sm btn-primary" id="grBtn">اعمال</button>
        </div>
        <p class="small dim">عدد منفی = کسر. در ledger با دلیل admin_grant ثبت و در لاگ ممیزی ذخیره می‌شود.</p></div>
      <div class="sec"><h4>⚙️ مدیریت حساب</h4>
        <div class="grant-row">
          <button class="btn btn-sm ${+p.is_banned ? '' : 'btn-danger'}" id="banBtn" ${self ? 'disabled' : ''}>${+p.is_banned ? '✅ رفع بن' : '🚫 بن کردن'}</button>
          <select id="roleSel" ${self ? 'disabled' : ''}>${['player', 'mod', 'admin'].map(r => `<option ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <button class="btn btn-sm" id="roleBtn" ${self ? 'disabled' : ''}>تغییر نقش</button>
        </div>
        <div class="grant-row" style="margin-top:8px">
          <input type="text" id="pwNew" placeholder="رمز جدید (حداقل ۶)" dir="ltr" style="text-align:left">
          <button class="btn btn-sm" id="pwBtn">ریست رمز</button>
        </div>
        ${self ? '<p class="small dim">روی حساب خودتان این عملیات‌ها قفل است.</p>' : ''}
      </div>` : '<p class="small muted">حساب شما mod است — پنل برای شما فقط‌خواندنی است.</p>'}
      <div class="sec"><h4>📒 آخرین تراکنش‌ها</h4>
        <div class="tbl-wrap" style="border:0"><table class="mini" style="min-width:0"><thead><tr><th>زمان</th><th>ارز</th><th>تغییر</th><th>دلیل</th></tr></thead><tbody>
        ${d.ledger.map(l => `<tr><td>${fmtDateTime(l.created_at)}</td><td class="mono">${esc(l.currency)}</td>
          <td class="num ${+l.delta >= 0 ? 'up' : 'down'}">${+l.delta >= 0 ? '+' : ''}${fmtNum(l.delta)}</td>
          <td class="mono">${esc(l.reason)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">—</td></tr>'}
        </tbody></table></div></div>
      <div class="sec"><h4>🧾 آخرین رویدادها</h4>
        <div class="tbl-wrap" style="border:0"><table class="mini" style="min-width:0"><thead><tr><th>زمان</th><th>رویداد</th><th>جزئیات</th></tr></thead><tbody>
        ${d.events.map(e => `<tr><td>${fmtDateTime(e.created_at)}</td><td class="mono">${esc(e.name)}</td>
          <td class="props">${esc(e.props_json || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">—</td></tr>'}
        </tbody></table></div></div>
      ${d.payments.length ? `<div class="sec"><h4>💳 پرداخت‌ها</h4>
        <div class="tbl-wrap" style="border:0"><table class="mini" style="min-width:0"><thead><tr><th>زمان</th><th>پک</th><th>مبلغ</th><th>وضعیت</th></tr></thead><tbody>
        ${d.payments.map(pm => `<tr><td>${fmtDateTime(pm.created_at)}</td><td class="mono">${esc(pm.pack_id)}</td>
          <td class="num">$${pm.amount_usd}</td><td>${esc(pm.status)}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}`;
    if (isAdmin) {
      $('#grBtn').onclick = async () => {
        const amount = parseFloat($('#grAmt').value);
        if (!amount) { toast('مقدار را وارد کنید', false); return; }
        if (!confirm(`مطمئنید؟ ${amount > 0 ? 'افزودن' : 'کسر'} ${Math.abs(amount)} ${$('#grCur').value} ${amount > 0 ? 'به' : 'از'} ${p.username}`)) return;
        try {
          const r = await api({ a: 'grant', user_id: id, currency: $('#grCur').value, amount, note: $('#grNote').value });
          toast('انجام شد — موجودی جدید: ' + fmtNum(r.balance)); openPlayer(id);
        } catch (e) { toast(e.message, false); }
      };
      const banBtn = $('#banBtn');
      if (banBtn) banBtn.onclick = async () => {
        if (!confirm(+p.is_banned ? 'رفع بن شود؟' : 'این بازیکن بن شود و از همه دستگاه‌ها خارج شود؟')) return;
        try { await api({ a: 'set_ban', user_id: id, banned: +p.is_banned ? 0 : 1 }); toast('انجام شد'); openPlayer(id); rerender(true); }
        catch (e) { toast(e.message, false); }
      };
      const roleBtn = $('#roleBtn');
      if (roleBtn) roleBtn.onclick = async () => {
        try { await api({ a: 'set_role', user_id: id, role: $('#roleSel').value }); toast('نقش تغییر کرد'); openPlayer(id); }
        catch (e) { toast(e.message, false); }
      };
      $('#pwBtn').onclick = async () => {
        const pw = $('#pwNew').value;
        if (pw.length < 6) { toast('رمز باید حداقل ۶ کاراکتر باشد', false); return; }
        if (!confirm('رمز ریست شود و بازیکن از همه دستگاه‌ها خارج شود؟')) return;
        try { await api({ a: 'set_password', user_id: id, password: pw }); toast('رمز تغییر کرد'); $('#pwNew').value = ''; }
        catch (e) { toast(e.message, false); }
      };
    }
  } catch (e) {
    body.innerHTML = '<p class="down">' + esc(e.message) + '</p>';
  }
}
function closeDrawer() { $('#drawer').classList.add('hidden'); }
$('#drawerX').onclick = closeDrawer;
$('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

/* ---------------- plumbing ---------------- */
function bindPlayers() {
  $$('[data-player]').forEach(el => { el.onclick = () => openPlayer(+el.dataset.player); });
}
function bindPager(kind, page, pages) {
  $$('[data-pg]').forEach(btn => {
    btn.onclick = () => {
      const dir = btn.dataset.pg.split(':')[1];
      const st = state[kind];
      st.page = dir === 'next' ? Math.min(pages, page + 1) : Math.max(1, page - 1);
      rerender();
    };
  });
}
const VIEWS = { overview: viewOverview, economy: viewEconomy, retention: viewRetention, players: viewPlayers, events: viewEvents, ledger: viewLedger, system: viewSystem };
async function rerender(keepScroll = false) {
  const fn = VIEWS[state.view] || viewOverview;
  if (!keepScroll) window.scrollTo({ top: 0 });
  try { await fn(); }
  catch (e) { content().innerHTML = `<div class="alert bad">خطا: ${esc(e.message)}</div>`; }
}
function setView(v) {
  state.view = v;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  rerender();
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});

/* ---------------- auth ---------------- */
function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}
function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#meChip').textContent = '👤 ' + state.me.username + ' · ' + state.me.role;
  setView(state.view);
}
function logout(manual = true) {
  state.token = ''; state.me = null;
  localStorage.removeItem(TOKEN_KEY);
  closeDrawer(); showLogin();
  if (manual) toast('خارج شدید');
}
$('#logoutBtn').onclick = () => logout(true);

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#lgErr'); err.textContent = '';
  try {
    const res = await fetch(LOGIN, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#lgUser').value.trim(), password: $('#lgPass').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok || !data.token) throw new Error(data.error || 'نام کاربری یا رمز اشتباه است');
    state.token = data.token;
    const me = await api({ a: 'me' });           // throws 403 for plain players
    state.me = me.me;
    localStorage.setItem(TOKEN_KEY, state.token);
    showApp();
  } catch (ex) {
    state.token = '';
    err.textContent = /403|forbidden/i.test(ex.message) ? 'این حساب نقش ادمین ندارد.' : ex.message;
  }
});

/* ---------------- boot ---------------- */
(async () => {
  if (!state.token) { showLogin(); return; }
  try {
    const me = await api({ a: 'me' });
    state.me = me.me;
    showApp();
  } catch {
    showLogin();
  }
})();
