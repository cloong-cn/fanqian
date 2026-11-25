'use strict';
// 饭钱账本前端：无框架，hash 路由
const $app = document.getElementById('app');
const MEALS = [
  { key: 'breakfast', name: '早餐' },
  { key: 'lunch', name: '午餐' },
  { key: 'dinner', name: '晚餐' },
  { key: 'other', name: '其他' },
];
const MEAL_NAME = Object.fromEntries(MEALS.map((m) => [m.key, m.name]));
const STATUS_NAME = { pending: '待确认', done: '已入账', rejected: '已拒绝' };
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

let me = null;
const state = { day: null, month: null, adminTab: 'users', adminFilter: null, statPeriod: 'month', billUser: '', members: null };

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function money(c, { sign = false, cur = true } = {}) {
  const neg = c < 0; const a = Math.abs(c);
  let s = (a / 100).toFixed(a % 100 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : sign && c > 0 ? '+' : '') + (cur ? '¥' : '') + s;
}
const yuan = (c) => money(c);
const compact = (c) => { const y = c / 100; return y >= 10000 ? (y / 10000).toFixed(y >= 100000 ? 0 : 1) + '万' : String(Math.round(y)); };
const amountInput = (c) => (c / 100).toFixed(c % 100 === 0 ? 0 : 2);
function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dow = (day) => (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7; // 周一=0
const md = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
function relDay(day) {
  if (day === me.today) return '今天';
  if (day === addDays(me.today, -1)) return '昨天';
  return '周' + WEEK[dow(day)];
}
function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}

// ---------- 动效工具 ----------
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let enterNext = false;            // 下一次 shell() 渲染是否播放"进场"动画（只在切换页面时）
let lastAddedId = null;           // 刚记的那一笔，渲染时高亮
const countMemo = new Map();      // 数字滚动：记住每个数字上一次显示的值
// 让带 data-count 的元素从上一次的值滚动到新值
function animateCounts(root = $app) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count), key = el.dataset.key || '', cur = el.dataset.cur !== '0';
    const fmt = (v) => money(Math.round(v), { cur });
    const from = countMemo.has(key) ? countMemo.get(key) : (enterNextWasSet ? 0 : to);
    countMemo.set(key, to);
    if (from === to || reduceMotion() || !key) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    el.textContent = fmt(from);
    requestAnimationFrame(step);
  });
}
let enterNextWasSet = false;
const countSpan = (cents, key, { cur = true } = {}) => `<span data-count="${cents}" data-key="${key}" data-cur="${cur ? 1 : 0}">${money(cents, { cur })}</span>`;

// 顶部加载条：请求超过 200ms 才出现，避免闪烁
const $load = document.createElement('div'); $load.id = 'loadbar'; document.body.appendChild($load);
let inflight = 0, loadTimer = null;
function loading(on) {
  inflight += on ? 1 : -1;
  if (inflight > 0 && !loadTimer && !$load.classList.contains('on')) loadTimer = setTimeout(() => { loadTimer = null; if (inflight > 0) $load.classList.add('on'); }, 200);
  if (inflight <= 0) { inflight = 0; clearTimeout(loadTimer); loadTimer = null; $load.classList.remove('on'); }
}

const pending = new Set();
// 同一个 GET 正在请求或 1.5 秒内刚请求过，就复用结果（切页时预取的数据由页面直接用上）
const getCache = new Map();
function apiGet(url) {
  const hit = getCache.get(url);
  if (hit && Date.now() - hit.at < 1500) return hit.p;
  const p = api('GET', url);
  getCache.set(url, { p, at: Date.now() });
  p.catch(() => getCache.delete(url));
  return p;
}
async function api(method, url, body) {
  if (method !== 'GET') getCache.clear();   // 有写操作，之前预取的数据作废
  const key = method === 'GET' ? null : method + ' ' + url + ' ' + JSON.stringify(body ?? {});
  if (key && pending.has(key)) { const e = new Error('处理中'); e.silent = true; throw e; }
  if (key) pending.add(key);
  loading(true);
  try { return await apiRaw(method, url, body); } finally { loading(false); if (key) pending.delete(key); }
}
async function apiRaw(method, url, body) {
  const opt = { method, headers: {} };
  if (body === undefined && method !== 'GET') body = {};
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); } catch { throw new Error('网络连接失败，请检查网络后重试'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { me = null; renderLogin(); throw new Error('请先登录'); }
  if (!res.ok) throw new Error(data.error || '出错了');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}
const fail = (e) => { if (!e || !e.silent) toast((e && e.message) || String(e)); };

// ---------- 底部弹窗 ----------
const $sheet = document.getElementById('sheet');
const $back = document.getElementById('sheet-backdrop');
let sheetTimer = null;
function openSheet(html, onMount, focus = true) {
  clearTimeout(sheetTimer); $sheet.classList.remove('closing'); $back.classList.remove('closing');
  $sheet.innerHTML = html; $sheet.hidden = false; $back.hidden = false;
  onMount && onMount($sheet);
  const first = $sheet.querySelector('[autofocus]') || (focus && $sheet.querySelector('input:not([type=checkbox])'));
  if (first) setTimeout(() => first.focus(), 60);
}
function closeSheet() {
  if ($sheet.hidden || $sheet.classList.contains('closing')) return;
  const done = () => { $sheet.hidden = true; $back.hidden = true; $sheet.innerHTML = ''; $sheet.classList.remove('closing'); $back.classList.remove('closing'); };
  if (reduceMotion()) return done();
  $sheet.classList.add('closing'); $back.classList.add('closing');
  sheetTimer = setTimeout(done, 200);
}
$back.addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------- 图标 ----------
const ICONS = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6h-6v6H4.5a1 1 0 0 1-1-1z"/>',
  history: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 2.5v4M16 2.5v4"/>',
  bill: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  me: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.6-3.8 4.5-5.5 8-5.5s6.4 1.7 8 5.5"/>',
  admin: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  bowl: '<path d="M4 11h16a8 8 0 0 1-16 0z"/><path d="M9 7c0-1.5 1.5-1.5 1.5-3M13.5 7c0-1.5 1.5-1.5 1.5-3"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  phone: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M11 18.5h2"/>',
  excel: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9.5 12.5l5 5M14.5 12.5l-5 5"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/>',
  breakfast: '<path d="M3 18h18M6 18a6 6 0 0 1 12 0"/><path d="M12 4v3M4.9 8.9l2 2M19.1 8.9l-2 2"/>',
  lunch: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  dinner: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  other: '<path d="M5 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2M12 3.5v2"/>',
};
const icon = (k, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
const mealVar = (m) => `--m: var(--m-${m})`;
const initial = (name) => esc([...String(name)][0] || '?');

function shell(active, inner, { pendingBadge = false } = {}) {
  const tabs = [['home', '记账', '#/'], ['bill', '账单', '#/bill'], ['me', '我的', '#/me']];
  if (me.user.isAdmin) tabs.push(['admin', '管理', '#/admin']);
  const enter = enterNext; enterNext = false; enterNextWasSet = enter;
  $app.innerHTML = `<div class="wrap ${enter ? 'enter' : ''}">${inner}</div>
    <nav class="tabs ${enter ? 'enter' : ''}">${tabs.map(([k, n, h]) => `<a href="${h}" class="${k === active ? 'on' : ''}">${icon(k)}${n}${k === 'admin' && pendingBadge ? '<span class="dotb"></span>' : ''}</a>`).join('')}</nav>`;
  animateCounts();
}
function header(title, right = '') {
  return `<header class="top"><div><div class="title">${title}</div></div><div class="right">${right}</div></header>`;
}

async function refreshMe() {
  me = await api('GET', '/api/me');
  if (!me.user.isSuper || !state.adminDept) state.adminDept = me.dept.id;
}
// 管理员接口带上当前操作的部门（只有总管理员能切换部门）
const withDept = (url) => (me && me.user.isSuper ? url + (url.includes('?') ? '&' : '?') + 'dept=' + state.adminDept : url);
const deptName = (id) => ((state.depts || []).find((d) => d.id === id) || {}).name || (me.dept && me.dept.id === id ? me.dept.name : '');
async function loadDepts() { state.depts = await apiGet('/api/admin/depts'); return state.depts; }

// ---------- 登录 ----------
// 表单登录失败时服务器会跳回 /?e=bad&u=xxx；页面加载时读一次，然后清掉地址栏参数
let loginFlash = (() => {
  const q = new URLSearchParams(location.search);
  const f = { e: q.get('e'), u: q.get('u') || '' };
  if (f.e) history.replaceState(null, '', location.pathname + location.hash);
  return f;
})();
function renderLogin() {
  // 表单用标准的 name/autocomplete，让手机自带的密码管理（iCloud 钥匙串 / Google 密码管理）能识别并记住
  // 用浏览器原生提交（POST /login → 跳回首页），各家浏览器都能可靠地提示"保存密码"
  if (document.getElementById('login')) return;   // 已经在登录页，不重复渲染（否则会清掉正在输入的内容）
  const errCode = loginFlash.e, lastUser = loginFlash.u;
  $app.innerHTML = `<form class="login" id="login" method="post" action="/login" autocomplete="on">
    <img class="logo" src="/icon.svg" alt="">
    <h1>饭钱账本</h1>
    <div class="tagline">记下每一顿，花得明明白白</div>
    <div class="field"><input id="u" name="username" value="${esc(lastUser)}" placeholder="用户名" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>
    <div class="field pw-field"><input id="p" name="password" type="password" placeholder="密码" autocomplete="current-password" required>
      <button type="button" class="eye" id="eye" aria-label="显示密码">${icon('eye')}</button></div>
    <div class="err" id="err">${errCode === 'locked' ? '尝试次数太多，请 15 分钟后再试' : errCode ? '用户名或密码不对' : ''}</div>
    <button class="btn block" type="submit">登录</button>
    <div class="small muted" style="text-align:center;margin-top:14px">登录后 30 天内常用不用再输密码</div>
  </form>`;
  trackPage('/login');
  const pw = document.getElementById('p'), eye = document.getElementById('eye');
  eye.onclick = () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    eye.innerHTML = icon(show ? 'eyeOff' : 'eye'); eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  };
  if (lastUser) setTimeout(() => pw.focus(), 50);
  document.getElementById('login').addEventListener('submit', (e) => {
    const btn = e.target.querySelector('button[type=submit]');
    if (btn.dataset.busy) { e.preventDefault(); return; }       // 防连点
    btn.dataset.busy = '1'; btn.textContent = '登录中…';
  });
}

// ---------- 余额卡片 ----------
function heroCard(monthCents) {
  const low = me.balanceCents < me.lowBalanceCents;
  const flags = [];
  if (me.balanceCents < 0) flags.push('<span class="flag">已欠费</span>');
  else if (low) flags.push('<span class="flag">余额不多了</span>');
  if (me.pendingCents) flags.push(`<span class="flag wait">${yuan(me.pendingCents)} 待确认</span>`);

  return `<section class="hero">
    <div class="label">我的余额 ${flags.join('')}</div>
    <div class="big num ${me.balanceCents < 0 ? 'neg' : ''}"><span class="cur">¥</span>${countSpan(me.balanceCents, 'bal', { cur: false })}</div>
    <button class="pill" data-go="#/topup">充值</button>
    <div class="row4">
      <div><div class="k">部门总余额</div><div class="v num">${countSpan(me.poolCents, 'pool')}</div></div>
      <div><div class="k">今日大家共花</div><div class="v num">${countSpan(me.todayAllCents, 'today-all')}</div></div>
      <div><div class="k">我本月已花</div><div class="v num">${countSpan(monthCents, 'month')}</div></div>
      <div><div class="k">我今日已花</div><div class="v num" id="hero-today">—</div></div>
    </div>
  </section>`;
}
function bindGo(root = $app) { root.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { location.hash = b.dataset.go; }); }

// ---------- 记账（首页） ----------
let suggestCache = null;
async function renderHome() {
  if (!state.day) state.day = me.today;
  const yesterday = addDays(me.today, -1);
  if (!me.user.isAdmin && state.day !== me.today && state.day !== yesterday) state.day = me.today;
  const [dayData, stats, suggest] = await Promise.all([
    apiGet('/api/day?date=' + state.day),
    apiGet('/api/stats'),
    suggestCache ? Promise.resolve(suggestCache) : apiGet('/api/suggest'),
  ]);
  suggestCache = suggest;
  const total = dayData.items.reduce((a, x) => a + x.cents, 0);
  const editable = dayData.editable;

  const mealsHtml = MEALS.map((m) => {
    const items = dayData.items.filter((x) => x.meal === m.key);
    if (m.key === 'other' && !items.length) return '';
    const sum = items.reduce((a, x) => a + x.cents, 0);
    return `<section class="card meal" style="${mealVar(m.key)}" data-meal="${m.key}">
      <div class="meal-head">
        <div class="meal-icon">${icon(m.key)}</div>
        <div class="name">${m.name}</div>
        <div class="sum num ${sum ? '' : 'zero'}">${sum ? yuan(sum) : '未记'}</div>
        ${editable ? `<button class="add-btn" data-add="${m.key}" aria-label="添加${m.name}">${icon('plus')}</button>` : ''}
      </div>
      ${items.length ? `<ul class="items">${items.map((x) => `<li data-id="${x.id}" class="${editable ? '' : 'ro'} ${x.id === lastAddedId ? 'new' : ''}">${itemLabel(x)}<span class="amt num">${yuan(x.cents)}</span></li>`).join('')}</ul>` : ''}
    </section>`;
  }).join('');

  const isOld = state.day < yesterday;
  shell('home', `
    <header class="top"><div><div class="hello">${greeting()}${me.deptCount > 1 ? ' · ' + esc(me.dept.name) : ''}</div><div class="title">${esc(me.user.displayName)}</div></div>
      <div class="right">${md(me.today)}<br>周${WEEK[dow(me.today)]}</div></header>
    ${heroCard(stats.monthCents)}
    <div class="daybar">
      <div class="seg">
        <button data-day="${me.today}" class="${state.day === me.today ? 'on' : ''}">今天</button>
        <button data-day="${yesterday}" class="${state.day === yesterday ? 'on' : ''}">昨天</button>
        ${me.user.isAdmin ? `<button data-pick class="${isOld ? 'on' : ''}">${isOld ? md(state.day) : '其他日期'}</button>` : ''}
      </div>
      <div class="total"><div class="k">${md(state.day)}合计</div><div class="v num">${countSpan(total, 'day-' + state.day)}</div></div>
    </div>
    ${editable && !suggest.length && !dayData.items.length && !lsGet('cw.hintDone') ? `<div class="hint">
      <div class="meal-icon" style="--m: var(--accent)">${icon('plus')}</div>
      <div><b>怎么记账</b><div class="small">吃完饭点一下对应的餐次，输入花了多少钱就行。记下后会自动从你的余额里扣。</div></div>
      <button class="hint-x" id="hint-x" aria-label="知道了">知道了</button></div>` : ''}
    ${mealsHtml}
    ${editable ? `<button class="btn soft block" data-add="other" style="margin-top:2px">${icon('plus')} 其他（零食、饮料…）</button>`
      : `<div class="locked">${icon('lock')}这一天已锁定，如需修改请联系管理员</div>`}`);
  { const el = document.getElementById('hero-today'); el.innerHTML = countSpan(stats.todayCents, 'today'); animateCounts(el); }
  bindGo();

  $app.querySelectorAll('.seg button[data-day]').forEach((b) => b.onclick = () => { state.day = b.dataset.day; renderHome().catch(fail); });
  const pick = $app.querySelector('.seg button[data-pick]');
  if (pick) pick.onclick = () => openSheet(`<h2>选择日期</h2><input type="date" id="pd" max="${me.today}" value="${state.day}">
      <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">确定</button></div>`, (s) => {
    s.querySelector('#c').onclick = closeSheet;
    s.querySelector('#o').onclick = () => { const v = s.querySelector('#pd').value; if (v) { state.day = v; closeSheet(); renderHome().catch(fail); } };
  }, false);
  $app.querySelectorAll('[data-add]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); addSheet(b.dataset.add, suggest); });
  // 点餐次卡片的空白处（不是某一笔记录）也能记
  if (editable) $app.querySelectorAll('section.meal').forEach((sec) => sec.onclick = (e) => {
    if (e.target.closest('li[data-id]')) return;
    addSheet(sec.dataset.meal, suggest);
  });
  const dh = document.getElementById('hint-x');
  if (dh) dh.onclick = () => { lsSet('cw.hintDone', '1'); dh.closest('.hint').remove(); };
  if (editable) $app.querySelectorAll('li[data-id]').forEach((li) => li.onclick = () => {
    editExpense(dayData.items.find((i) => i.id === Number(li.dataset.id)), () => renderHome());
  });
}

function addSheet(meal, suggest) {
  const chipsFor = (m) => {
    const own = suggest.filter((s) => s.meal === m);
    const seen = new Set();
    const list = (own.length ? own : suggest).filter((c) => { const k = c.item + '|' + c.cents; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
    return list.length ? `<div class="field"><label>常用金额，点一下直接记</label><div class="chips">${list.map((c) =>
      `<button type="button" class="chip num" data-i="${suggest.indexOf(c)}">${c.item ? esc(c.item) + '<span class="p">' + yuan(c.cents) + '</span>' : yuan(c.cents)}</button>`).join('')}</div></div>` : '';
  };
  openSheet(`<h2>记一笔 · ${md(state.day)}</h2>
    <div class="field"><div class="seg full" id="ms">${MEALS.map((m) => `<button type="button" data-m="${m.key}" class="${m.key === meal ? 'on' : ''}">${m.name}</button>`).join('')}</div></div>
    <form id="af">
      <div class="field money-input"><span>¥</span><input name="amount" inputmode="decimal" placeholder="0" autocomplete="off" required autofocus></div>
      <div id="chips">${chipsFor(meal)}</div>
      <button class="btn block">记下</button>
    </form>`, (s) => {
    const bindChips = () => s.querySelectorAll('.chip').forEach((c) => c.onclick = () => {
      const x = suggest[Number(c.dataset.i)];
      submitExpense(meal, x.item, amountInput(x.cents));
    });
    s.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
      meal = b.dataset.m;
      s.querySelectorAll('[data-m]').forEach((o) => o.classList.toggle('on', o === b));
      s.querySelector('#chips').innerHTML = chipsFor(meal); bindChips();
    });
    bindChips();
    s.querySelector('#af').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      submitExpense(meal, '', fd.get('amount'));
    });
  });
}

async function submitExpense(meal, item, amount) {
  try {
    const r = await api('POST', '/api/expenses', { day: state.day, meal, item, amount: String(amount).trim() });
    closeSheet(); suggestCache = null; lastAddedId = r.id; lsSet('cw.hintDone', '1');
    if (navigator.vibrate) navigator.vibrate(10);
    await refreshMe(); await renderHome(); lastAddedId = null;
    toast(`已记下 ${item || MEAL_NAME[meal]} ${yuan(r.cents)}`);
  } catch (e) { fail(e); }
}

function editExpense(x, after) {
  openSheet(`<h2>修改记录</h2>
    <div class="field"><div class="seg full" id="ms">${MEALS.map((m) => `<button type="button" data-m="${m.key}" class="${m.key === x.meal ? 'on' : ''}">${m.name}</button>`).join('')}</div></div>
    <div class="field money-input"><span>¥</span><input id="ea" inputmode="decimal" value="${amountInput(x.cents)}"></div>
    ${x.item ? `<div class="small muted" style="margin:-4px 2px 10px">内容：${esc(x.item)}</div>` : ''}
    <div class="btns"><button class="btn danger" id="del">删除</button><button class="btn" id="save">保存</button></div>`, (s) => {
    let meal = x.meal;
    s.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => { meal = b.dataset.m; s.querySelectorAll('[data-m]').forEach((o) => o.classList.toggle('on', o === b)); });
    s.querySelector('#save').onclick = async () => {
      try {
        await api('PUT', '/api/expenses/' + x.id, { meal, amount: s.querySelector('#ea').value.trim() });
        closeSheet(); suggestCache = null; await refreshMe(); await after(); toast('已保存');
      } catch (e) { fail(e); }
    };
    s.querySelector('#del').onclick = async () => {
      if (!confirm(`删除这笔 ${MEAL_NAME[x.meal]} ${yuan(x.cents)}？`)) return;
      try {
        await api('DELETE', '/api/expenses/' + x.id); closeSheet(); suggestCache = null;
        const li = $app.querySelector(`[data-id="${x.id}"]`);
        if (li && !reduceMotion()) { li.style.height = li.offsetHeight + 'px'; li.offsetHeight; li.classList.add('removing'); await sleep(260); }
        await refreshMe(); await after(); toast('已删除');
      }
      catch (e) { fail(e); }
    };
  }, false);
}

// ---------- 明细 ----------
// 记录名：有内容显示内容，没有就显示记账时间；管理员改过的加标记
function itemLabel(x, prefix = '') {
  const main = x.item ? esc(x.item) : `<span class="muted">${x.time ? x.time + ' 记' : '一笔'}</span>`;
  return `<span class="name">${prefix}${main}${x.adminEdited ? '<span class="badge wait">管理员改过</span>' : ''}</span>`;
}
const emptyState = (text) => `<div class="card empty-state">${icon('bowl')}${text}</div>`;

// ---------- 账单（明细 + 统计） ----------
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let billSwap = false;   // 页内切换明细/统计时，只给内容区播放切换动画
// 账单"查看谁"：默认自己；部门开启成员互相查看后可选同部门其他人（只读）；管理员还可选"所有人"
const billUserName = () => {
  if (!state.billUser) return '';
  if (state.billUser === 'all') return deptName(state.adminDept) + '所有人';
  return ((state.members || []).find((m) => String(m.id) === state.billUser) || {}).name || '';
};
function memberPicker() {
  const others = (state.members || []).filter((m) => m.id !== me.user.id);
  if (!others.length && !me.user.isAdmin) return '';
  return `<div class="viewer"><span class="small muted">查看</span><select id="bu">
    <option value="">我自己</option>
    ${me.user.isAdmin ? `<option value="all" ${state.billUser === 'all' ? 'selected' : ''}>${esc(deptName(state.adminDept))}所有人</option>` : ''}
    ${others.map((m) => `<option value="${m.id}" ${String(m.id) === state.billUser ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
  </select></div>
  ${state.billUser && state.billUser !== 'all' && !me.user.isAdmin ? `<div class="viewing">${icon('eye')}正在看 ${esc(billUserName())} 的记录（只读）</div>` : ''}`;
}
function billShell(tab, inner, exportArgs) {
  shell('bill', `
    ${header('账单', `<button class="btn soft sm" id="xbtn">${icon('excel')} 导出</button>`)}
    <div class="seg full bill-seg" style="margin-bottom:12px">
      <button data-bt="detail" class="${tab === 'detail' ? 'on' : ''}">明细</button>
      <button data-bt="stats" class="${tab === 'stats' ? 'on' : ''}">统计</button>
    </div>
    ${memberPicker()}
    <div class="bill-body ${billSwap ? 'swap' : ''}">${inner}</div>`);
  billSwap = false;
  document.getElementById('xbtn').onclick = () => exportSheet(exportArgs()).catch(fail);
  const bu = document.getElementById('bu');
  if (bu) bu.onchange = () => { state.billUser = bu.value; state.openDays = new Set(); billSwap = true; renderBill().catch(fail); };
  $app.querySelectorAll('[data-bt]').forEach((b) => b.onclick = () => {
    if (b.dataset.bt === state.billTab) return;
    switchBill(b.dataset.bt).catch(fail);
  });
}
// 明细 ↔ 统计 联动：两边看同一个月
function monthToPeriod(month) {
  const cur = me.today.slice(0, 7);
  const d = new Date(cur + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1);
  if (month === cur) return 'month';
  if (month === d.toISOString().slice(0, 7)) return 'last';
  return 'm:' + month;
}
async function switchBill(tab) {
  if (tab === 'stats') state.statPeriod = monthToPeriod(state.month || me.today.slice(0, 7));
  else state.month = periodRange(state.statPeriod)[1].slice(0, 7);   // 统计范围的最后一个月
  state.billTab = tab; lsSet('cw.billTab', tab);
  billSwap = true; hideTip(); resizeHook = null;
  await (tab === 'stats' ? renderStats() : renderHistory());
  trackPage(currentPagePath());
}
async function loadMembers() {
  state.members = await apiGet(me.user.isAdmin ? withDept('/api/members') : '/api/members');
  // 选中的人已经不能看了（开关被关 / 调走了）就回到自己
  if (state.billUser && state.billUser !== 'all' && !state.members.some((m) => String(m.id) === state.billUser)) state.billUser = '';
  if (state.billUser === 'all' && !me.user.isAdmin) state.billUser = '';
}
async function renderBill() {
  if (!state.billTab) state.billTab = lsGet('cw.billTab') === 'stats' ? 'stats' : 'detail';
  if (!state.members) await loadMembers();
  await (state.billTab === 'stats' ? renderStats() : renderHistory());
}

const MEAL_SHORT = { breakfast: '早', lunch: '午', dinner: '晚', other: '其他' };
let compactRoNote = '';   // 看别人的记录时，展开后的提示文字
// 紧凑行：左边一块（日期或人名）+ 各餐小计 + 合计，点开看每一笔
function compactRow(key, left, items, editable, openSet) {
  const sums = MEALS.map((m) => ({ m: m.key, c: items.filter((x) => x.meal === m.key).reduce((a, x) => a + x.cents, 0) })).filter((x) => x.c);
  const total = items.reduce((a, x) => a + x.cents, 0);
  const open = openSet.has(key);
  const edited = items.some((x) => x.adminEdited);
  return `<li class="day-row ${open ? 'open' : ''}" data-key="${esc(key)}">
    <button class="dsum" aria-expanded="${open}">
      ${left}
      <span class="dmeals">${sums.map((x) => `<span class="ms" style="${mealVar(x.m)}"><i class="mdot"></i>${MEAL_SHORT[x.m]} <span class="num"><span class="cy">¥</span>${money(x.c, { cur: false })}</span></span>`).join('')}${edited ? '<span class="badge wait">改过</span>' : ''}</span>
      <span class="dtot num">${yuan(total)}</span>
      ${icon('chev', 'dchev')}
    </button>
    <div class="dbody"><div><ul class="items">${items.map((x) => `<li data-id="${x.id}" class="${editable ? '' : 'ro'}" style="${mealVar(x.meal)}">
      <span class="mdot"></span><span class="tag">${MEAL_NAME[x.meal]}</span>${itemLabel(x)}<span class="amt num">${yuan(x.cents)}</span></li>`).join('')}</ul>
      ${editable ? '' : `<div class="small muted dlock">${compactRoNote || '已锁定，修改请联系管理员'}</div>`}</div></div>
  </li>`;
}
function bindCompact(openSet, allItems, onEdit) {
  $app.querySelectorAll('.day-row .dsum').forEach((b) => b.onclick = () => {
    const row = b.closest('.day-row'), key = row.dataset.key;
    const open = !row.classList.contains('open');
    row.classList.toggle('open', open); b.setAttribute('aria-expanded', open);
    if (open) openSet.add(key); else openSet.delete(key);
  });
  $app.querySelectorAll('.day-row li[data-id]:not(.ro)').forEach((li) => li.onclick = () => {
    editExpense(allItems.find((i) => i.id === Number(li.dataset.id)), onEdit);
  });
}
const dateLeft = (day) => `<span class="dnum"><b class="num">${Number(day.slice(8))}</b><small>${relDay(day)}</small></span>`;
// 按周分组，每天一行
function compactDays(days, openSet) {
  const weekStart = (d) => addDays(d, -dow(d));
  const weekSum = new Map();
  for (const d of days) weekSum.set(weekStart(d.day), (weekSum.get(weekStart(d.day)) || 0) + d.cents);
  let lastWeek = null, html = '';
  for (const d of days) {
    const ws = weekStart(d.day);
    if (ws !== lastWeek) {
      if (lastWeek) html += '</ul></div>';
      html += `<div class="week-head"><span>${md(ws)} – ${md(addDays(ws, 6))}</span><span class="num">${yuan(weekSum.get(ws))}</span></div><div class="card flush"><ul class="days">`;
      lastWeek = ws;
    }
    html += compactRow(d.day, dateLeft(d.day), d.items, d.editable, openSet);
  }
  return html + (lastWeek ? '</ul></div>' : '');
}
// 管理员看所有人：按天分组，每人一行
function compactPeople(days, openSet) {
  return days.map((d) => {
    const people = new Map();
    for (const x of d.items) { if (!people.has(x.userId)) people.set(x.userId, { name: x.displayName, items: [] }); people.get(x.userId).items.push(x); }
    return `<div class="week-head"><span>${md(d.day)} ${relDay(d.day)}</span><span class="num">${yuan(d.cents)}</span></div>
      <div class="card flush"><ul class="days">${[...people].map(([uid, p]) =>
        compactRow(`${d.day}|${uid}`, `<span class="dperson"><span class="avatar">${initial(p.name)}</span><span class="pn">${esc(p.name)}</span></span>`, p.items, true, openSet)).join('')}</ul></div>`;
  }).join('');
}

async function renderHistory() {
  if (!state.month) state.month = me.today.slice(0, 7);
  if (!state.openDays) state.openDays = new Set();
  const [y, m] = state.month.split('-').map(Number);
  const monthEnd = (() => { const d = new Date(Date.UTC(y, m, 0)); const e = d.toISOString().slice(0, 10); return e > me.today ? me.today : e; })();
  const who = state.billUser;
  let h;
  if (who === 'all') {
    // 管理员看全部门：按天分组、每人一行
    const rows = await api('GET', withDept(`/api/admin/expenses?from=${state.month}-01&to=${monthEnd}`));
    const days = [];
    for (const r of rows) { let d = days[days.length - 1]; if (!d || d.day !== r.day) days.push(d = { day: r.day, cents: 0, items: [], editable: true }); d.cents += r.cents; d.items.push(r); }
    h = { days, totalCents: rows.reduce((a, r) => a + r.cents, 0), people: true };
  } else {
    h = await apiGet('/api/history?month=' + state.month + (who ? '&user_id=' + who : ''));
  }
  compactRoNote = who && who !== 'all' && !me.user.isAdmin ? `这是 ${esc(billUserName())} 的记录，只能查看` : '';
  const isCurrent = state.month >= me.today.slice(0, 7);
  const avg = h.days.length ? Math.round(h.totalCents / h.days.length) : 0;
  billShell('detail', `
    <div class="monthbar">
      <button class="icon-btn" id="prev" aria-label="上个月">${icon('left')}</button>
      <div class="mid"><div class="m small muted">${y}年${m}月 · 记账 ${h.days.length} 天</div><div class="v num">${yuan(h.totalCents)}</div>${h.days.length ? `<div class="small muted">平均每天 ${yuan(avg)}</div>` : ''}</div>
      <button class="icon-btn" id="next" aria-label="下个月" ${isCurrent ? 'disabled' : ''}>${icon('chev')}</button>
    </div>
    ${h.days.length ? (h.people ? compactPeople(h.days, state.openDays) : compactDays(h.days, state.openDays)) : emptyState('这个月还没有记录')}`,
    () => ({ from: state.month + '-01', to: monthEnd, scope: me.user.isAdmin ? who : '' }));
  const shift = (n) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); state.month = d.toISOString().slice(0, 7); renderHistory().catch(fail); };
  document.getElementById('prev').onclick = () => shift(-1);
  document.getElementById('next').onclick = () => shift(1);
  bindCompact(state.openDays, h.days.flatMap((d) => d.items), () => renderHistory());
}

// ---------- 图表 ----------
const $tip = document.createElement('div'); $tip.id = 'tip'; document.body.appendChild($tip);
function showTip(html, x, y) {
  $tip.innerHTML = html; $tip.classList.add('show');
  const r = $tip.getBoundingClientRect();
  let left = x - r.width / 2; left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
  let top = y - r.height - 12; if (top < 8) top = y + 16;
  $tip.style.left = left + 'px'; $tip.style.top = top + 'px';
}
function hideTip() { $tip.classList.remove('show'); }
window.addEventListener('scroll', hideTip, { passive: true });
// 给容器绑定悬停/触摸：带 data-tip 的元素显示提示，data-k 相同的柱子高亮
function bindTips(root) {
  root.querySelectorAll('[data-tipbox]').forEach((box) => {
    const move = (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t || !box.contains(t)) { hideTip(); box.classList.remove('hovering'); box.querySelectorAll('.on').forEach((n) => n.classList.remove('on')); return; }
      showTip(t.dataset.tip, e.clientX, e.clientY);
      if (t.dataset.k !== undefined) {
        box.classList.add('hovering');
        box.querySelectorAll('.bar').forEach((b) => b.classList.toggle('on', b.dataset.k === t.dataset.k));
      }
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerdown', move);
    box.addEventListener('pointerleave', () => { hideTip(); box.classList.remove('hovering'); });
  });
}
function niceMax(v) {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
// 柱状图：data = [{label, value, tip, dim}]，单一系列
function columnChart(data, { width, height = 160, avg = null, labelEvery = null } = {}) {
  const L = 34, R = 4, T = 10, B = 22;
  const w = Math.max(200, width), h = height;
  const iw = w - L - R, ih = h - T - B;
  const max = niceMax(Math.max(...data.map((d) => d.value), avg || 0));
  const y = (v) => T + ih - (v / max) * ih;
  const band = iw / data.length;
  const bw = Math.max(2, Math.min(24, band * 0.62));
  const ticks = [0, max / 2, max];
  const every = labelEvery || Math.ceil(data.length / 6);
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`;
  s += `<g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${w - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`).join('')}</g>`;
  s += `<g class="axis">${ticks.map((t) => `<text x="${L - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${compact(t)}</text>`).join('')}</g>`;
  data.forEach((d, i) => {
    const cx = L + band * i + band / 2;
    if (d.value > 0) {
      const top = y(d.value), bh = T + ih - top, r = Math.min(4, bw / 2, bh);
      const x0 = cx - bw / 2, x1 = cx + bw / 2, yb = T + ih;
      s += `<path class="bar ${d.dim ? 'dim' : ''}" data-k="${i}" style="animation-delay:${Math.round(i / data.length * 320)}ms" d="M${x0.toFixed(1)},${yb} V${(top + r).toFixed(1)} Q${x0.toFixed(1)},${top.toFixed(1)} ${(x0 + r).toFixed(1)},${top.toFixed(1)} H${(x1 - r).toFixed(1)} Q${x1.toFixed(1)},${top.toFixed(1)} ${x1.toFixed(1)},${(top + r).toFixed(1)} V${yb} Z"/>`;
    }
    if ((data.length - 1 - i) % every === 0) {
      s += `<g class="axis"><text x="${cx.toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(d.label)}</text></g>`;
    }
    s += `<rect class="hit" data-k="${i}" data-tip="${esc(d.tip)}" x="${(L + band * i).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${ih}"/>`;
  });
  if (avg) {
    const ay = y(avg).toFixed(1);
    s += `<g class="avg"><line x1="${L}" x2="${w - R}" y1="${ay}" y2="${ay}"/><text x="${w - R}" y="${(y(avg) - 4).toFixed(1)}" text-anchor="end">日均 ${yuan(avg)}</text></g>`;
  }
  return s + '</svg>';
}
function hbars(rows) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="hbars" data-tipbox>${rows.map((r, i) => `<div class="hbar" data-tip="${esc(r.tip)}">
    <div class="row"><span class="rank">${i + 1}</span><span class="n">${esc(r.name)}</span><span class="c">${esc(r.meta || '')}</span><span class="v num">${yuan(r.value)}</span></div>
    <div class="track"><div class="fill" style="width:${(r.value / max * 100).toFixed(1)}%"></div></div></div>`).join('')}</div>`;
}

// ---------- 统计 ----------
function periodRange(p) {
  const t = me.today;
  if (p && p.startsWith('m:')) {
    const mo = p.slice(2), [yy, mm] = mo.split('-').map(Number);
    let end = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
    if (end > t) end = t;
    return [mo + '-01', end, `${yy === Number(t.slice(0, 4)) ? '' : yy + '年'}${mm}月`];
  }
  if (p === 'week') return [addDays(t, -dow(t)), t, '本周'];
  if (p === 'month') return [t.slice(0, 8) + '01', t, '本月'];
  if (p === 'last') {
    const d = new Date(t.slice(0, 7) + '-01T00:00:00Z'); d.setUTCDate(0);
    const end = d.toISOString().slice(0, 10);
    return [end.slice(0, 8) + '01', end, '上月'];
  }
  if (p === '30') return [addDays(t, -29), t, '近30天'];
  if (p === '90') return [addDays(t, -89), t, '近90天'];
  return [t.slice(0, 4) + '-01-01', t, '今年'];
}
function aggregateMonthly(series) {
  const m = new Map();
  for (const s of series) m.set(s.day.slice(0, 7), (m.get(s.day.slice(0, 7)) || 0) + s.cents);
  return [...m].map(([k, v]) => ({ month: k, cents: v }));
}

let statUsers = null;
async function renderStats() {
  const [from, to, pname] = periodRange(state.statPeriod);
  const scope = state.billUser;
  const q = new URLSearchParams({ from, to });
  if (scope) q.set('user_id', scope);
  if (scope === 'all' && me.user.isSuper) q.set('dept', state.adminDept);
  const a = await api('GET', '/api/analytics?' + q);
  const all = scope === 'all';
  const periods = [['week', '本周'], ['month', '本月'], ['last', '上月'], ['30', '近30天'], ['90', '近90天'], ['year', '今年']];
  // 从明细带过来的某个具体月份，作为一个额外的选项放在最前面
  if (state.statPeriod.startsWith('m:')) periods.unshift([state.statPeriod, pname]);

  // 增减
  let delta = '<div class="delta">上期无记录</div>';
  if (a.prevCents > 0) {
    const pct = Math.round((a.totalCents - a.prevCents) / a.prevCents * 100);
    delta = pct === 0 ? '<div class="delta">与上期持平</div>'
      : `<div class="delta ${pct > 0 ? 'up' : 'down'}">${icon(pct > 0 ? 'up' : 'down')}比上期${pct > 0 ? '多' : '少'} ${Math.abs(pct)}%</div>`;
  }
  const tile4 = a.hiddenBalance
    ? `<div class="tile"><div class="k">记了多少笔</div><div class="v num">${a.meals.reduce((x, m) => x + m.n, 0)}<small>笔</small></div><div class="delta">余额只有本人能看</div></div>`
    : all
    ? `<div class="tile"><div class="k">期间充值</div><div class="v num">${yuan(a.topupCents)}</div><div class="delta">已确认入账</div></div>`
    : `<div class="tile"><div class="k">余额还够吃</div><div class="v num">${a.runwayDays == null ? '—' : a.runwayDays < 0 ? '已欠费' : a.runwayDays}<small>${a.runwayDays != null && a.runwayDays >= 0 ? '天' : ''}</small></div>
       <div class="delta">按近30天每个吃饭日 ${yuan(a.avg30Cents)}</div></div>`;

  // 趋势：90 天以内按天，否则按月
  const byDay = a.days <= 92;
  const trendData = byDay
    ? a.series.map((s) => ({ label: `${Number(s.day.slice(5, 7))}/${Number(s.day.slice(8))}`, value: s.cents, tip: `<b>${md(s.day)} 周${WEEK[dow(s.day)]}</b><br>${yuan(s.cents)}` }))
    : aggregateMonthly(a.series).map((s) => ({ label: `${Number(s.month.slice(5))}月`, value: s.cents, tip: `<b>${s.month.replace('-', '年')}月</b><br>${yuan(s.cents)}` }));

  const mealTotal = a.meals.reduce((x, m) => x + m.cents, 0);
  const mealsHtml = mealTotal ? `
    <div class="segbar" data-tipbox>${a.meals.filter((m) => m.cents).map((m) => `<div style="${mealVar(m.meal)};flex:${m.cents} 1 0" data-tip="<b>${MEAL_NAME[m.meal]}</b><br>${yuan(m.cents)} · ${Math.round(m.cents / mealTotal * 100)}%"></div>`).join('')}</div>
    <div class="legend-rows">${a.meals.map((m) => `<div class="lr" style="${mealVar(m.meal)}">
      <span class="mdot"></span>
      <span>${MEAL_NAME[m.meal]} <span class="meta">${m.n} 笔${m.n ? ' · 平均 ' + yuan(Math.round(m.cents / m.n)) : ''}</span></span>
      <span class="num">${yuan(m.cents)}</span>
      <span class="pct num">${mealTotal ? Math.round(m.cents / mealTotal * 100) : 0}%</span></div>`).join('')}</div>` : '<div class="muted small">暂无数据</div>';

  billShell('stats', `
    <div class="scroll-row" style="margin-bottom:6px"><div class="seg">${periods.map(([k, n]) => `<button data-p="${k}" class="${k === state.statPeriod ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <div class="small muted" style="margin:0 2px 12px">${md(from)} – ${md(to)}</div>
    <div class="tiles">
      <div class="tile"><div class="k">${pname}花费</div><div class="v num">${countSpan(a.totalCents, 'st-total-' + scope)}</div>${delta}</div>
      <div class="tile"><div class="k">日均</div><div class="v num">${countSpan(a.avgPerDayCents, 'st-avg-' + scope)}</div><div class="delta">只算有记录的 ${a.recordedDays} 天</div></div>
      <div class="tile"><div class="k">记账天数</div><div class="v num">${a.recordedDays}<small>/ ${a.days} 天</small></div><div class="delta">没记的天不算进日均</div></div>
      ${tile4}
    </div>
    ${all && a.byUser ? `<div class="card anim"><h3>每人花费</h3><div class="sub">${pname} · 按金额排序</div>
      ${hbars(a.byUser.map((u) => ({ name: u.name, value: u.cents, meta: `${u.days} 天`, tip: `<b>${esc(u.name)}</b><br>${yuan(u.cents)} · 记账 ${u.days} 天` })))}</div>` : ''}
    <div class="card"><h3>${byDay ? '每日花费' : '每月花费'}</h3><div class="sub">点柱子查看具体金额</div>
      <div class="chart-box" data-tipbox data-chart="trend"></div></div>
    <div class="card anim"><h3>早中晚分布</h3><div class="sub">${pname}各餐次花费占比</div>${mealsHtml}</div>
    <div class="card"><h3>星期规律</h3><div class="sub">每个星期几平均花多少</div>
      <div class="chart-box" data-tipbox data-chart="week"></div></div>
    ${a.topItems.length ? `<div class="card anim"><h3>花钱最多的</h3><div class="sub">${pname}按总金额排名</div>
      ${hbars(a.topItems.map((t) => ({ name: t.item, value: t.cents, meta: `${t.n} 次`, tip: `<b>${esc(t.item)}</b><br>${t.n} 次 · 共 ${yuan(t.cents)} · 平均 ${yuan(Math.round(t.cents / t.n))}` })))}</div>` : ''}
    <div class="card"><h3>近 12 个月</h3><div class="sub">每月总花费</div>
      <div class="chart-box" data-tipbox data-chart="months"></div></div>`, () => ({ from, to, scope: me.user.isAdmin ? scope : '' }));

  const draw = (anim = false) => {
    const boxes = Object.fromEntries([...$app.querySelectorAll('[data-chart]')].map((b) => [b.dataset.chart, b]));
    Object.values(boxes).forEach((b) => b.classList.toggle('anim', anim));
    const w = boxes.trend.clientWidth;
    boxes.trend.innerHTML = columnChart(trendData, { width: w, avg: byDay && a.avgPerDayCents ? a.avgPerDayCents : null });
    boxes.week.innerHTML = columnChart(a.weekday.map((d) => ({ label: '周' + WEEK[d.dow], value: d.avgCents, tip: `<b>周${WEEK[d.dow]}</b><br>有记录的${'周' + WEEK[d.dow]}平均 ${yuan(d.avgCents)}` })), { width: w, height: 140, labelEvery: 1 });
    boxes.months.innerHTML = columnChart(a.months.map((m) => ({ label: `${Number(m.month.slice(5))}月`, value: m.cents, tip: `<b>${m.month.replace('-', '年')}月</b><br>${yuan(m.cents)}` })), { width: w, height: 140, labelEvery: 2 });
  };
  draw(true);
  bindTips($app);
  resizeHook = draw;
  $app.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => { state.statPeriod = b.dataset.p; renderStats().catch(fail); });
}
let resizeHook = null, resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => resizeHook && resizeHook(), 150); });

// ---------- 导出 Excel ----------
async function downloadExport(from, to, scope) {
  const q = new URLSearchParams({ from, to });
  if (scope) q.set('user_id', scope);
  if (scope === 'all' && me.user.isSuper) q.set('dept', state.adminDept);
  const res = await fetch('/api/export?' + q);
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '导出失败'); }
  const blob = await res.blob();
  const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') || '');
  const name = m ? decodeURIComponent(m[1]) : '饭钱账本.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
async function exportSheet({ from, to, scope = '' } = {}) {
  if (!from) [from, to] = periodRange('month');
  let users = [];
  if (me.user.isAdmin) users = statUsers || (statUsers = await api('GET', withDept('/api/admin/users')));
  const quick = [['month', '本月'], ['last', '上月'], ['90', '近90天'], ['year', '今年']];
  openSheet(`<h2>导出 Excel</h2>
    ${me.user.isAdmin ? `<div class="field"><label>导出谁的</label><select id="xs">
      <option value="">我自己</option><option value="all" ${scope === 'all' ? 'selected' : ''}>${esc(deptName(state.adminDept))}所有人</option>
      ${users.filter((u) => u.id !== me.user.id).map((u) => `<option value="${u.id}" ${String(u.id) === scope ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}
    </select></div>` : ''}
    <div class="field"><label>时间范围</label><div class="date-row"><input type="date" id="xf" value="${from}" max="${me.today}"><input type="date" id="xt" value="${to}" max="${me.today}"></div></div>
    <div class="chips" style="margin:-4px 0 14px">${quick.map(([k, n]) => `<button type="button" class="chip" data-q="${k}">${n}</button>`).join('')}</div>
    <p class="small muted" style="margin:0">表格里有：消费明细、每日汇总（按早中晚分列）${me.user.isAdmin ? '、每人汇总' : ''}、充值记录。</p>
    <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">${icon('excel')} 下载</button></div>`, (s) => {
    s.querySelector('#c').onclick = closeSheet;
    s.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => { const [f, t] = periodRange(b.dataset.q); s.querySelector('#xf').value = f; s.querySelector('#xt').value = t; });
    s.querySelector('#o').onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const name = await downloadExport(s.querySelector('#xf').value, s.querySelector('#xt').value, me.user.isAdmin ? s.querySelector('#xs').value : '');
        closeSheet(); toast('已下载 ' + name);
      } catch (err) { fail(err); btn.disabled = false; }
    };
  }, false);
}

// ---------- 充值 ----------
async function renderTopup() {
  const list = await api('GET', '/api/topups');
  const stats = await api('GET', '/api/stats');
  shell('me', `
    <header class="top"><div><a href="#/me" class="small">‹ 我的</a><div class="title">充值</div></div></header>
    ${heroCard(stats.monthCents).replace('<button class="pill" data-go="#/topup">充值</button>', '')}
    <form class="card" id="tf">
      <h3>申请充值</h3>
      <div class="sub">把钱交给管理员后在这里提交，管理员确认收到后余额才会增加。</div>
      <div class="field money-input"><span>¥</span><input name="amount" inputmode="decimal" placeholder="0" required></div>
      <div class="chips" style="margin:-4px 0 14px">${[100, 200, 300, 500].map((v) => `<button type="button" class="chip" data-v="${v}">¥${v}</button>`).join('')}</div>
      <div class="field"><input name="note" placeholder="备注（可不填）" maxlength="60"></div>
      <button class="btn block">提交申请</button>
    </form>
    <div class="section-title"><h3>充值记录</h3></div>
    <div class="card flush">${list.length ? `<ul class="list">${list.map((t) => `<li style="cursor:default">
        <div class="main"><div class="t num">${money(t.cents, { sign: true })}</div><div class="d">${fmtTime(t.created_at)}${t.note ? ' · ' + esc(t.note) : ''}</div></div>
        <div class="r"><span class="badge ${t.status === 'pending' ? 'wait' : t.status === 'rejected' ? 'off' : 'accent'}">${STATUS_NAME[t.status]}</span>
        ${t.status === 'pending' ? `<div><button class="btn soft sm" style="margin-top:6px" data-cancel="${t.id}">撤回</button></div>` : ''}</div></li>`).join('')}</ul>`
        : `<div class="empty-state">${icon('wallet')}还没有充值记录</div>`}</div>`);
  { const el = document.getElementById('hero-today'); el.innerHTML = countSpan(stats.todayCents, 'today'); animateCounts(el); }
  const f = document.getElementById('tf');
  f.querySelectorAll('[data-v]').forEach((c) => c.onclick = () => { f.amount.value = c.dataset.v; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    try { await api('POST', '/api/topups', { amount: fd.get('amount').trim(), note: fd.get('note') }); await refreshMe(); await renderTopup(); toast('已提交，等管理员确认'); }
    catch (err) { fail(err); }
  });
  $app.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
    try { await api('DELETE', '/api/topups/' + b.dataset.cancel); await refreshMe(); await renderTopup(); toast('已撤回'); } catch (e) { fail(e); }
  });
}

// ---------- 我的 ----------
function renderMe() {
  shell('me', `
    ${header('我的')}
    <div class="card" style="display:flex;align-items:center;gap:14px">
      <div class="avatar lg">${initial(me.user.displayName)}</div>
      <div><div style="font-weight:600;font-size:17px">${esc(me.user.displayName)}${me.user.isSuper ? '<span class="badge accent">总管理员</span>' : me.user.isAdmin ? '<span class="badge accent">管理员</span>' : ''}</div>
      <div class="small muted">用户名 ${esc(me.user.username)}${me.deptCount > 1 ? ' · ' + esc(me.dept.name) : ''}</div></div>
      <div style="margin-left:auto;text-align:right"><div class="small muted">余额</div><div class="num ${me.balanceCents < 0 ? 'neg' : ''}" style="font-weight:700;font-size:18px">${yuan(me.balanceCents)}</div></div>
    </div>
    <div class="card flush"><ul class="list">
      <li data-go="#/topup"><span class="meal-icon" style="--m: var(--accent)">${icon('wallet')}</span><div class="main"><div class="t">充值</div><div class="d">申请充值、查看充值记录</div></div>${me.pendingCents ? `<span class="badge wait">${yuan(me.pendingCents)} 待确认</span>` : ''}${icon('chev', 'chev')}</li>
      <li id="pw"><span class="meal-icon" style="--m: var(--m-lunch)">${icon('key')}</span><div class="main"><div class="t">修改密码</div></div>${icon('chev', 'chev')}</li>
      <li data-go="#/log"><span class="meal-icon" style="--m: var(--m-other)">${icon('history')}</span><div class="main"><div class="t">账户变动记录</div><div class="d">管理员对我账户做过的操作</div></div>${icon('chev', 'chev')}</li>
      <li id="xls"><span class="meal-icon" style="--m: var(--good)">${icon('excel')}</span><div class="main"><div class="t">导出 Excel</div><div class="d">下载消费明细和汇总表</div></div>${icon('chev', 'chev')}</li>
      <li id="a2hs"><span class="meal-icon" style="--m: var(--m-dinner)">${icon('phone')}</span><div class="main"><div class="t">添加到手机桌面</div><div class="d">像 App 一样打开</div></div>${icon('chev', 'chev')}</li>
    </ul></div>
    <button class="btn soft block" id="lo" style="color:var(--danger)">${icon('out')} 退出登录</button>`);
  bindGo();
  document.getElementById('pw').onclick = () => openSheet(`<h2>修改密码</h2>
    <form id="pf">
      <div class="field"><input type="password" name="old" placeholder="原密码" autocomplete="current-password" required></div>
      <div class="field"><input type="password" name="new" placeholder="新密码（至少 6 位）" autocomplete="new-password" minlength="6" required></div>
      <button class="btn block">保存</button></form>`, (s) => {
    s.querySelector('#pf').addEventListener('submit', async (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      try { await api('POST', '/api/password', { old: fd.get('old'), new: fd.get('new') }); closeSheet(); toast('密码已修改'); } catch (err) { fail(err); }
    });
  });
  document.getElementById('xls').onclick = () => exportSheet().catch(fail);
  document.getElementById('a2hs').onclick = () => openSheet(`<h2>添加到手机桌面</h2>
    <p><b>iPhone（Safari）</b>：点底部的「分享」按钮 → 「添加到主屏幕」。</p>
    <p><b>安卓（Chrome / 自带浏览器）</b>：点右上角菜单 → 「添加到主屏幕」或「安装应用」。</p>
    <p class="muted small">登录状态会保持 30 天。</p>
    <div class="btns"><button class="btn" id="ok">知道了</button></div>`, (s) => { s.querySelector('#ok').onclick = closeSheet; }, false);
  document.getElementById('lo').onclick = async () => { await api('POST', '/api/logout', {}).catch(() => {}); me = null; location.hash = '#/'; renderLogin(); };
}

// ---------- 操作日志 ----------
function auditList(rows, { showTarget = false } = {}) {
  if (!rows.length) return `<div class="card empty-state">${icon('history')}还没有记录</div>`;
  return `<div class="card flush"><ul class="list">${rows.map((r) => `<li style="cursor:default;align-items:flex-start">
    <div class="avatar" style="width:34px;height:34px;font-size:14px">${initial(r.actor || '?')}</div>
    <div class="main"><div class="t" style="font-size:14px">${esc(r.detail)}</div>
      <div class="d">${fmtTime(r.at)} · ${esc(r.actor || '已删除用户')}${showTarget && r.targetId && r.targetId !== r.actorId ? ' → ' + esc(r.target || '') : ''}</div></div></li>`).join('')}</ul></div>`;
}
async function renderMyLog() {
  const rows = await api('GET', '/api/audit/mine');
  shell('me', `<header class="top"><div><a href="#/me" class="small">‹ 我的</a><div class="title">账户变动记录</div></div></header>
    <p class="small muted" style="margin:-6px 2px 12px">管理员对你的账户做过的所有操作（充值确认、调整余额、修改或删除你的记录等）都会记在这里，不能删除。</p>
    ${auditList(rows)}`);
}

// ---------- 管理 ----------
async function renderAdmin() {
  const tab = state.adminTab;
  const [pending, depts] = await Promise.all([apiGet(withDept('/api/admin/topups?status=pending')), loadDepts()]);
  const tabs = [['users', '用户'], ['topups', '充值'], ['expenses', '消费'], ['audit', '日志']];
  if (me.user.isSuper) tabs.push(['depts', '部门']);
  // 总管理员：顶部切换正在管理的部门
  const switcher = me.user.isSuper && depts.length > 1 && tab !== 'depts' ? `<div class="field" style="margin-bottom:10px"><select id="ad">${depts.map((d) =>
    `<option value="${d.id}" ${d.id === state.adminDept ? 'selected' : ''}>${esc(d.name)}（${d.members} 人）</option>`).join('')}</select></div>` : '';
  const head = `${header('管理', me.deptCount > 1 && !me.user.isSuper ? esc(me.dept.name) : '')}${switcher}<div class="seg full" style="margin-bottom:14px">${tabs.map(([k, n]) =>
    `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${n}${k === 'topups' && pending.length ? ` <span class="badge count">${pending.length}</span>` : ''}</button>`).join('')}</div>`;
  let body, mount;
  if (tab === 'users') [body, mount] = await adminUsers();
  else if (tab === 'topups') [body, mount] = await adminTopups();
  else if (tab === 'audit') [body, mount] = await adminAudit();
  else if (tab === 'depts' && me.user.isSuper) [body, mount] = await adminDepts(depts);
  else [body, mount] = await adminExpenses();
  shell('admin', head + body, { pendingBadge: pending.length > 0 });
  $app.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { state.adminTab = b.dataset.t; renderAdmin().then(() => trackPage(currentPagePath())).catch(fail); });
  const ad = document.getElementById('ad');
  if (ad) ad.onchange = () => { state.adminDept = Number(ad.value); statUsers = null; state.members = null; state.billUser = ''; state.adminFilter = null; state.auditFilter = null; renderAdmin().catch(fail); };
  mount();
}

async function adminDepts(depts) {
  const gone = await api('GET', '/api/admin/depts/deleted');
  const html = `<div class="section-title"><h3>部门 ${depts.length}</h3><span class="extra">各部门的钱和记录互相独立</span></div>
    <div class="card flush"><ul class="list">${depts.map((d) => `<li data-d="${d.id}">
      <div class="avatar">${initial(d.name)}</div>
      <div class="main"><div class="t">${esc(d.name)}${d.id === me.dept.id ? '<span class="badge">我所在</span>' : ''}</div><div class="d">${d.members} 人</div></div>
      <div class="r"><div class="small muted">部门总余额</div><div class="num ${d.poolCents < 0 ? 'neg' : ''}" style="font-weight:600">${yuan(d.poolCents)}</div></div>${icon('chev', 'chev')}</li>`).join('')}</ul></div>
    <button class="btn block" id="addd">${icon('plus')} 新建部门</button>
    <p class="small muted" style="margin:12px 2px">新部门建好后，在顶部切换到该部门，再去「用户」里给它建人。也可以把某人设为「部门管理员」，让他自己管这个部门。</p>
    ${gone.length ? `<details class="deleted-box"><summary>已删除的部门 ${gone.length}</summary>
      <div class="card flush"><ul class="list">${gone.map((d) => `<li style="cursor:default">
        <div class="avatar off">${initial(d.name)}</div>
        <div class="main"><div class="t">${esc(d.name)}</div><div class="d">${fmtTime(d.deletedAt)} 删除${d.members ? ` · 含 ${d.members} 个账号` : ''}</div></div>
        <div class="r"><button class="btn soft sm" data-drestore="${d.id}">恢复</button></div></li>`).join('')}</ul></div>
      <p class="small muted" style="margin:8px 2px">恢复部门时，当初随部门一起删除的账号也会一起恢复。</p></details>` : ''}`;
  const mount = () => {
    const nameSheet = (title, value, onOk) => openSheet(`<h2>${title}</h2><div class="field"><input id="dn" maxlength="20" value="${esc(value)}" placeholder="例如 技术部"></div>
      <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">保存</button></div>`, (s) => {
      s.querySelector('#c').onclick = closeSheet;
      s.querySelector('#o').onclick = async () => { try { await onOk(s.querySelector('#dn').value); closeSheet(); await refreshMe(); await renderAdmin(); } catch (e) { fail(e); } };
    });
    document.getElementById('addd').onclick = () => nameSheet('新建部门', '', async (name) => {
      const d = await api('POST', '/api/admin/depts', { name });
      state.adminDept = d.id; toast(`已新建「${d.name}」，已切换到该部门`);
    });
    $app.querySelectorAll('[data-drestore]').forEach((b) => b.onclick = async () => {
      const d = gone.find((x) => x.id === Number(b.dataset.drestore));
      if (!confirm(`恢复部门「${d.name}」${d.members ? `和其中 ${d.members} 个账号` : ''}？`)) return;
      try { const r = await api('POST', `/api/admin/depts/${d.id}/restore`, {}); await refreshMe(); await renderAdmin(); toast(r.users ? `已恢复，含 ${r.users} 个账号` : '已恢复'); } catch (e) { fail(e); }
    });
    $app.querySelectorAll('[data-d]').forEach((li) => li.onclick = () => {
      const d = depts.find((x) => x.id === Number(li.dataset.d));
      openSheet(`<h2>${esc(d.name)}</h2><div class="actions">
        <button class="btn" data-x="go">${icon('me')} 管理这个部门的人</button>
        <button class="btn soft" data-x="rename">改名</button>
        ${d.id !== me.dept.id ? '<button class="btn danger" data-x="del">删除部门</button>' : ''}
      </div><p class="small muted">${d.id === me.dept.id ? '这是你所在的部门，不能删除。' : '删除只是隐藏，数据全部保留，可以恢复。部门里每个人的余额都要是 0 才能删。'}</p>`, (s) => {
        s.querySelectorAll('[data-x]').forEach((b) => b.onclick = async () => {
          if (b.dataset.x === 'go') { closeSheet(); state.adminDept = d.id; state.adminTab = 'users'; statUsers = null; renderAdmin().catch(fail); }
          if (b.dataset.x === 'rename') nameSheet('部门改名', d.name, (name) => api('PUT', '/api/admin/depts/' + d.id, { name }));
          if (b.dataset.x === 'del') {
            if (!confirm(`删除部门「${d.name}」？${d.members ? `\n部门里的 ${d.members} 个账号也会一起删除，不能再登录。` : ''}\n数据全部保留，可以在「已删除的部门」里恢复。`)) return;
            try { await api('DELETE', '/api/admin/depts/' + d.id); if (state.adminDept === d.id) state.adminDept = me.dept.id; closeSheet(); await refreshMe(); await renderAdmin(); toast('部门已删除，可恢复'); } catch (e) { fail(e); }
          }
        });
      }, false);
    });
  };
  return [html, mount];
}

function showPassword(username, pw) {
  openSheet(`<h2>${esc(username)} 的密码</h2><div class="pw-show">${esc(pw)}</div>
    <p class="small muted">请现在记下来告诉对方，之后不会再显示。对方登录后可以在「我的」里自己改密码。</p>
    <div class="btns"><button class="btn soft" id="cp">复制</button><button class="btn" id="ok">好了</button></div>`, (s) => {
    s.querySelector('#ok').onclick = closeSheet;
    s.querySelector('#cp').onclick = () => navigator.clipboard.writeText(pw).then(() => toast('已复制'), () => toast('复制失败，请手动记下'));
  }, false);
}

function visCard() {
  const d = (state.depts || []).find((x) => x.id === state.adminDept);
  if (!d) return '';
  return `<label class="card switch-row"><div><div class="t">成员互相查看消费记录</div>
    <div class="small muted">${d.membersVisible ? '已开启：本部门的人可以在「账单」里查看彼此的明细和统计（只读，看不到别人的余额）' : '已关闭：每个人只能看自己的记录'}</div></div>
    <input type="checkbox" class="switch" id="vis" ${d.membersVisible ? 'checked' : ''}></label>`;
}
async function adminUsers() {
  const all = await api('GET', withDept('/api/admin/users'));
  statUsers = all;
  const users = all.filter((u) => !u.deleted), deleted = all.filter((u) => u.deleted);
  const total = all.reduce((a, u) => a + u.balanceCents, 0);
  const html = `
    <div class="tiles">
      <div class="tile"><div class="k">部门总余额</div><div class="v num ${total < 0 ? 'neg' : ''}">${yuan(total)}</div></div>
      <div class="tile"><div class="k">本月总花费</div><div class="v num">${yuan(users.reduce((a, u) => a + u.monthSpentCents, 0))}</div></div>
    </div>
    ${visCard()}
    <div class="section-title"><h3>用户 ${users.length}</h3><span class="extra">点用户查看操作</span></div>
    <div class="card flush"><ul class="list">${users.map((u) => `<li data-u="${u.id}">
      <div class="avatar">${initial(u.displayName)}</div>
      <div class="main"><div class="t">${esc(u.displayName)}${u.isSuper ? '<span class="badge accent">总管理员</span>' : u.isAdmin ? '<span class="badge accent">管理员</span>' : ''}${u.disabled ? '<span class="badge off">已停用</span>' : ''}</div>
        <div class="d">${esc(u.username)} · 本月 ${yuan(u.monthSpentCents)} · 最近 ${u.lastDay ? md(u.lastDay) : '无记录'}</div></div>
      <div class="r num ${u.balanceCents < 0 ? 'neg' : ''}" style="font-weight:600">${yuan(u.balanceCents)}</div>${icon('chev', 'chev')}</li>`).join('')}</ul></div>
    <button class="btn block" id="add">${icon('plus')} 新建用户</button>
    ${deleted.length ? `<details class="deleted-box"><summary>已删除的账号 ${deleted.length}</summary>
      <div class="card flush"><ul class="list">${deleted.map((u) => `<li style="cursor:default">
        <div class="avatar off">${initial(u.displayName)}</div>
        <div class="main"><div class="t">${esc(u.displayName)}</div><div class="d">${esc(u.username)} · ${fmtTime(u.deletedAt)} 删除</div></div>
        <div class="r"><button class="btn soft sm" data-restore="${u.id}">恢复</button></div></li>`).join('')}</ul></div>
      <p class="small muted" style="margin:8px 2px">删除只是隐藏，记录全部保留；恢复后可以照常登录（密码不变）。</p></details>` : ''}`;
  const mount = () => {
    $app.querySelectorAll('[data-restore]').forEach((b) => b.onclick = async () => {
      const u = deleted.find((x) => x.id === Number(b.dataset.restore));
      if (!confirm(`恢复 ${u.displayName} 的账号？`)) return;
      try { await api('POST', `/api/admin/users/${u.id}/restore`, {}); state.members = null; await refreshMe(); await renderAdmin(); toast('已恢复'); } catch (e) { fail(e); }
    });
    document.getElementById('add').onclick = () => openSheet(`<h2>新建用户${me.deptCount > 1 ? ' · ' + esc(deptName(state.adminDept)) : ''}</h2>
      <div class="field"><label>用户名（登录用，小写字母/数字）</label><input id="nu" autocapitalize="off" autocorrect="off" maxlength="20" placeholder="例如 xiaowang"></div>
      <div class="field"><label>显示名字</label><input id="nd" maxlength="20" placeholder="例如 小王"></div>
      <div class="field"><label>密码</label><input id="np" maxlength="100" placeholder="留空自动生成好记的"></div>
      <div class="field"><label>初始充值（元）</label><input id="na" inputmode="decimal" placeholder="可不填"></div>
      <label class="check"><input type="checkbox" id="nadm"> 设为部门管理员（可以管理本部门的人和账）</label>
      <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">创建</button></div>`, (s) => {
      s.querySelector('#c').onclick = closeSheet;
      s.querySelector('#o').onclick = async () => {
        try {
          const r = await api('POST', '/api/admin/users', { username: s.querySelector('#nu').value, displayName: s.querySelector('#nd').value, password: s.querySelector('#np').value || undefined, isAdmin: s.querySelector('#nadm').checked, deptId: me.user.isSuper ? state.adminDept : undefined });
          const amt = s.querySelector('#na').value.trim();
          if (amt) await api('POST', '/api/admin/topups', { userId: r.id, amount: amt, note: '初始充值' });
          await refreshMe(); await renderAdmin(); showPassword(r.username, r.password);
        } catch (e) { fail(e); }
      };
    });
    $app.querySelectorAll('[data-u]').forEach((li) => li.onclick = () => userActions(users.find((x) => x.id === Number(li.dataset.u))));
    const vis = document.getElementById('vis');
    if (vis) vis.onchange = async () => {
      try {
        await api('PUT', `/api/admin/depts/${state.adminDept}/visibility`, { membersVisible: vis.checked });
        state.members = null; await refreshMe(); await renderAdmin();
        toast(vis.checked ? '已开启，本部门成员可以互相查看记录' : '已关闭');
      } catch (e) { vis.checked = !vis.checked; fail(e); }
    };
  };
  return [html, mount];
}

function userActions(u) {
  const locked = u.isSuper && !me.user.isSuper;   // 部门管理员不能改总管理员
  openSheet(`<h2>${esc(u.displayName)} <span class="small muted">余额 ${yuan(u.balanceCents)}</span></h2>
    <div class="actions">
      ${locked ? '' : `<button class="btn" data-a="topup">${icon('wallet')} 充值 / 调整余额</button>`}
      <button class="btn soft" data-a="view">${icon('history')} 查看消费记录</button>
      <button class="btn soft" data-a="stats">${icon('stats')} 查看统计</button>
      ${locked ? '' : `<button class="btn soft" data-a="pw">${icon('key')} 重置密码</button>
      <button class="btn soft" data-a="rename">${icon('me')} 改名</button>`}
      ${u.id !== me.user.id && !u.isSuper ? `<button class="btn soft" data-a="role">${icon('admin')} ${u.isAdmin ? '取消部门管理员' : '设为部门管理员'}</button>` : ''}
      ${me.user.isSuper && u.id !== me.user.id && (state.depts || []).length > 1 ? `<button class="btn soft" data-a="move">${icon('out')} 调到其他部门</button>` : ''}
      ${u.id !== me.user.id && !locked ? `<button class="btn ${u.disabled ? 'soft' : 'danger'}" data-a="toggle">${u.disabled ? '启用账号' : '停用账号'}</button>` : ''}
      ${u.id !== me.user.id && !u.isSuper ? `<button class="btn danger" data-a="del">删除账号</button>` : ''}
    </div>`, (s) => {
    s.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'topup') openSheet(`<h2>调整 ${esc(u.displayName)} 的余额</h2>
        <div class="field"><div class="seg full"><button type="button" data-mode="add" class="on">加 / 减金额</button><button type="button" data-mode="set">直接设为</button></div></div>
        <div class="field money-input"><span>¥</span><input id="ta" inputmode="decimal" placeholder="0" autocomplete="off"></div>
        <div class="preview" id="pv"></div>
        <div class="field"><input id="tn" maxlength="60" placeholder="备注（可不填），例如 12月饭钱"></div>
        <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">确定</button></div>`, (s2) => {
        let mode = 'add';
        const inp = s2.querySelector('#ta'), pv = s2.querySelector('#pv');
        const parse = (v) => { v = v.trim(); return /^-?\d{1,7}(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null; };
        const update = () => {
          const c = parse(inp.value);
          let html = `当前余额 <b class="num">${yuan(u.balanceCents)}</b>`;
          if (c !== null) {
            const target = mode === 'set' ? c : u.balanceCents + c;
            const diff = target - u.balanceCents;
            html += ` → <b class="num ${target < 0 ? 'neg' : ''}">${yuan(target)}</b>`;
            if (mode === 'set') html += diff === 0 ? '<br><span class="muted">余额不变</span>' : `<br><span class="muted">将记一笔 ${money(diff, { sign: true })} 的余额校正</span>`;
          } else {
            html += `<br><span class="muted">${mode === 'set' ? '填目标余额，系统自动算差额' : '正数加钱，负数扣钱（例如 -50）'}</span>`;
          }
          pv.innerHTML = html;
        };
        s2.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
          mode = b.dataset.mode;
          s2.querySelectorAll('[data-mode]').forEach((o) => o.classList.toggle('on', o === b));
          inp.placeholder = mode === 'set' ? String(Math.max(0, Math.round(u.balanceCents / 100))) : '0';
          update(); inp.focus();
        });
        inp.addEventListener('input', update); update();
        s2.querySelector('#c').onclick = closeSheet;
        s2.querySelector('#o').onclick = async () => {
          const v = inp.value.trim(), note = s2.querySelector('#tn').value;
          if (!v) return toast('请填写金额');
          if (mode === 'set' && parse(v) !== null && !confirm(`确定把 ${u.displayName} 的余额设为 ${yuan(parse(v))}？`)) return;
          try {
            await api('POST', '/api/admin/topups', mode === 'set' ? { userId: u.id, setTo: v, note } : { userId: u.id, amount: v, note });
            closeSheet(); await refreshMe(); await renderAdmin(); toast(mode === 'set' ? '余额已设置' : '已入账');
          } catch (e) { fail(e); }
        };
      });
      if (a === 'pw') openSheet(`<h2>重置 ${esc(u.displayName)} 的密码</h2>
        <div class="field"><input id="rp" maxlength="100" placeholder="留空自动生成好记的"></div>
        <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">重置</button></div>`, (s2) => {
        s2.querySelector('#c').onclick = closeSheet;
        s2.querySelector('#o').onclick = async () => {
          try { const r = await api('PUT', '/api/admin/users/' + u.id, { resetPassword: s2.querySelector('#rp').value || true }); showPassword(u.username, r.password); }
          catch (e) { fail(e); }
        };
      });
      if (a === 'rename') openSheet(`<h2>改名</h2><div class="field"><input id="rn" maxlength="20" value="${esc(u.displayName)}"></div>
        <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">保存</button></div>`, (s2) => {
        s2.querySelector('#c').onclick = closeSheet;
        s2.querySelector('#o').onclick = async () => {
          try { await api('PUT', '/api/admin/users/' + u.id, { displayName: s2.querySelector('#rn').value }); closeSheet(); await refreshMe(); statUsers = null; await renderAdmin(); } catch (e) { fail(e); }
        };
      });
      if (a === 'toggle') {
        if (!confirm(`${u.disabled ? '启用' : '停用'} ${u.displayName}？${u.disabled ? '' : '\n停用后对方无法登录，记录和余额保留。'}`)) return;
        api('PUT', '/api/admin/users/' + u.id, { disabled: !u.disabled }).then(() => { closeSheet(); renderAdmin(); }).catch(fail);
      }
      if (a === 'del') {
        if (u.balanceCents !== 0) return toast(`余额还有 ${yuan(u.balanceCents)}，请先把余额设为 0 再删除`);
        if (!confirm(`删除 ${u.displayName} 的账号？\n删除后不能登录、不再显示，历史记录全部保留，可以在「已删除的账号」里恢复。`)) return;
        api('DELETE', '/api/admin/users/' + u.id).then(async () => { closeSheet(); statUsers = null; state.members = null; await refreshMe(); await renderAdmin(); toast('已删除，可恢复'); }).catch(fail);
      }
      if (a === 'role') {
        const to = !u.isAdmin;
        if (!confirm(to ? `把 ${u.displayName} 设为部门管理员？\n他可以管理本部门所有人的账户和记录。` : `取消 ${u.displayName} 的部门管理员？`)) return;
        api('PUT', '/api/admin/users/' + u.id, { isAdmin: to }).then(() => { closeSheet(); statUsers = null; renderAdmin(); toast(to ? '已设为部门管理员' : '已取消管理员'); }).catch(fail);
      }
      if (a === 'move') openSheet(`<h2>把 ${esc(u.displayName)} 调到</h2>
        <div class="field"><select id="mv">${state.depts.filter((d) => d.id !== u.deptId).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <p class="small muted">他的余额（${yuan(u.balanceCents)}）和历史记录会跟着一起过去，两个部门的总余额会相应变化。</p>
        <div class="btns"><button class="btn soft" id="c">取消</button><button class="btn" id="o">确定调动</button></div>`, (s2) => {
        s2.querySelector('#c').onclick = closeSheet;
        s2.querySelector('#o').onclick = async () => {
          try { await api('PUT', '/api/admin/users/' + u.id, { deptId: Number(s2.querySelector('#mv').value) }); closeSheet(); statUsers = null; await renderAdmin(); toast('已调动'); } catch (e) { fail(e); }
        };
      }, false);
      if (a === 'view') { closeSheet(); state.adminTab = 'expenses'; state.adminFilter = { userId: String(u.id) }; renderAdmin().catch(fail); }
      if (a === 'stats') { closeSheet(); state.billUser = u.id === me.user.id ? '' : String(u.id); state.members = null; location.hash = '#/stats'; }
    });
  }, false);
}

async function adminTopups() {
  const list = await api('GET', withDept('/api/admin/topups'));
  const html = `<div class="card flush">${list.length ? `<ul class="list">${list.map((t) => `<li style="cursor:default">
      <div class="avatar">${initial(t.display_name)}</div>
      <div class="main"><div class="t">${esc(t.display_name)} <span class="num">${money(t.cents, { sign: true })}</span></div>
        <div class="d">${fmtTime(t.created_at)}${t.note ? ' · ' + esc(t.note) : ''}</div></div>
      <div class="r">${t.status === 'pending'
        ? `<div style="display:flex;gap:6px"><button class="btn danger sm" data-rej="${t.id}">拒绝</button><button class="btn sm" data-ok="${t.id}">确认收到</button></div>`
        : `<span class="badge ${t.status === 'rejected' ? 'off' : 'accent'}">${STATUS_NAME[t.status]}</span>`}</div></li>`).join('')}</ul>`
      : `<div class="empty-state">${icon('wallet')}还没有充值记录</div>`}</div>`;
  const mount = () => {
    $app.querySelectorAll('[data-ok]').forEach((b) => b.onclick = async () => {
      try { await api('POST', `/api/admin/topups/${b.dataset.ok}/approve`, {}); await refreshMe(); await renderAdmin(); toast('已入账'); } catch (e) { fail(e); }
    });
    $app.querySelectorAll('[data-rej]').forEach((b) => b.onclick = async () => {
      if (!confirm('拒绝这条充值申请？')) return;
      try { await api('POST', `/api/admin/topups/${b.dataset.rej}/reject`, {}); await renderAdmin(); } catch (e) { fail(e); }
    });
  };
  return [html, mount];
}

async function adminAudit() {
  const f = state.auditFilter || (state.auditFilter = { userId: '', others: true });
  const q = new URLSearchParams();
  if (f.userId) q.set('user_id', f.userId);
  if (f.others) q.set('others', '1');
  const [users, rows] = await Promise.all([api('GET', withDept('/api/admin/users')), api('GET', withDept('/api/admin/audit?' + q))]);
  const html = `<div class="card">
      <div class="field"><select id="au"><option value="">所有人</option>${users.map((u) => `<option value="${u.id}" ${String(u.id) === f.userId ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" id="ao" ${f.others ? 'checked' : ''}> 只看动了别人账户的操作</label>
    </div>
    <div class="section-title"><h3>最近 ${rows.length} 条</h3><span class="extra">日志不能修改或删除</span></div>
    ${auditList(rows, { showTarget: true })}`;
  const mount = () => {
    document.getElementById('au').onchange = (e) => { f.userId = e.target.value; renderAdmin().catch(fail); };
    document.getElementById('ao').onchange = (e) => { f.others = e.target.checked; renderAdmin().catch(fail); };
  };
  return [html, mount];
}

async function adminExpenses() {
  const f = state.adminFilter || (state.adminFilter = {});
  if (!state.adminOpen) state.adminOpen = new Set();
  if (!f.from) f.from = addDays(me.today, -6);
  if (!f.to) f.to = me.today;
  const q = new URLSearchParams({ from: f.from, to: f.to });
  if (f.userId) q.set('user_id', f.userId);
  const [users, rows] = await Promise.all([api('GET', withDept('/api/admin/users')), api('GET', withDept('/api/admin/expenses?' + q))]);
  const total = rows.reduce((a, r) => a + r.cents, 0);
  const days = [];
  for (const r of rows) {
    let d = days[days.length - 1];
    if (!d || d.day !== r.day) days.push(d = { day: r.day, cents: 0, items: [], editable: true });
    d.cents += r.cents; d.items.push(r);
  }
  const quick = [['0', '今天'], ['6', '近7天'], ['m', '本月'], ['29', '近30天']];
  const html = `
    <div class="card">
      <div class="field"><select id="fu"><option value="">所有人</option>${users.map((u) => `<option value="${u.id}" ${String(u.id) === f.userId ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select></div>
      <div class="date-row" style="margin-bottom:10px"><input type="date" id="ff" value="${f.from}" max="${me.today}"><input type="date" id="ft" value="${f.to}" max="${me.today}"></div>
      <div class="chips">${quick.map(([k, n]) => `<button class="chip" data-r="${k}">${n}</button>`).join('')}<button class="chip" id="xadm" style="margin-left:auto">${icon('excel')} 导出</button></div>
    </div>
    <div class="section-title"><h3>合计 <span class="num">${yuan(total)}</span></h3><span class="extra">${rows.length} 笔 · 点开可修改</span></div>
    ${!days.length ? emptyState('这段时间没有记录') : f.userId ? compactDays(days, state.adminOpen) : compactPeople(days, state.adminOpen)}`;
  const mount = () => {
    const reload = () => renderAdmin().catch(fail);
    document.getElementById('xadm').onclick = () => exportSheet({ from: f.from, to: f.to, scope: f.userId || 'all' }).catch(fail);
    document.getElementById('fu').onchange = (e) => { f.userId = e.target.value; reload(); };
    document.getElementById('ff').onchange = (e) => { if (e.target.value) { f.from = e.target.value; reload(); } };
    document.getElementById('ft').onchange = (e) => { if (e.target.value) { f.to = e.target.value; reload(); } };
    $app.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => {
      const r = b.dataset.r; f.to = me.today;
      f.from = r === 'm' ? me.today.slice(0, 8) + '01' : addDays(me.today, -Number(r));
      reload();
    });
    bindCompact(state.adminOpen, rows, () => renderAdmin());
  };
  return [html, mount];
}

// ---------- 访问统计（umami）----------
// 本应用页面切换不改变网址路径，umami 默认只记第一次打开，所以每次切页手动上报一个"虚拟路径"。
// 只上报页面名，不含金额、姓名等任何数据。index.html 里没放 umami 脚本时这里什么也不做。
let lastTracked = '';
function trackPage(path) {
  if (path === lastTracked) return;
  if (!window.umami || typeof window.umami.track !== 'function') return;   // 脚本还没加载好：先不记，加载后补报
  lastTracked = path;
  try { window.umami.track((p) => ({ ...p, url: path, title: '饭钱账本' })); } catch {}
}
function currentPagePath() {
  const h = (location.hash.replace(/^#/, '') || '/');
  if (!me) return '/login';
  if (h === '/bill' || h === '/history' || h === '/stats') return '/bill/' + (state.billTab || 'detail');
  if (h === '/admin') return '/admin/' + state.adminTab;
  return h === '/' ? '/home' : h;
}
// 脚本异步加载，可能晚于第一次渲染；加载好后补报当前页
window.addEventListener('load', () => setTimeout(() => trackPage(currentPagePath()), 300));

// ---------- 路由 ----------
async function route() {
  if (!me) return renderLogin();
  loginFlash = { e: null, u: '' };
  closeSheet(); hideTip(); resizeHook = null; enterNext = true;
  const h = location.hash.replace(/^#/, '') || '/';
  try {
    if (h === '/bill') await renderBill();
    else if (h === '/history' || h === '/stats') { state.billTab = h === '/stats' ? 'stats' : 'detail'; lsSet('cw.billTab', state.billTab); await renderBill(); }
    else if (h === '/topup') await renderTopup();
    else if (h === '/log') await renderMyLog();
    else if (h === '/me') renderMe();
    else if (h === '/admin' && me.user.isAdmin) await renderAdmin();
    else await renderHome();
    window.scrollTo(0, 0);
    trackPage(currentPagePath());
  } catch (e) { if (me) fail(e); }
}
// 切页：页面要用的数据和 /api/me 同时发出，省掉一次往返
function prefetch(h) {
  try {
    if (h === '/') { apiGet('/api/day?date=' + (state.day || me.today)); apiGet('/api/stats'); if (!suggestCache) apiGet('/api/suggest'); }
    else if (h === '/bill' && (state.billTab || lsGet('cw.billTab')) !== 'stats' && state.billUser !== 'all')
      apiGet('/api/history?month=' + (state.month || me.today.slice(0, 7)) + (state.billUser ? '&user_id=' + state.billUser : ''));
    else if (h === '/admin' && me.user.isAdmin) { apiGet(withDept('/api/admin/topups?status=pending')); apiGet('/api/admin/depts'); }
  } catch {}
}
window.addEventListener('hashchange', () => {
  if (!me) return;
  prefetch(location.hash.replace(/^#/, '') || '/');
  refreshMe().then(route).catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && me && $sheet.hidden) {
    const old = me.today;
    refreshMe().then(() => { if (me.today !== old) { state.day = me.today; route(); } }).catch(() => {});
  }
});

refreshMe().then(route).catch((e) => {
  if (!navigator.onLine || /网络/.test(e.message)) {
    $app.innerHTML = `<div class="login"><img class="logo" src="/icon.svg" alt=""><h1>没有网络</h1><div class="tagline">连上网络后再打开</div><button class="btn block" id="rt">重试</button></div>`;
    document.getElementById('rt').onclick = () => location.reload();
  } else if (!me) renderLogin();
});
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
