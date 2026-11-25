'use strict';
// 记账服务：Node 内置 http + pg。只监听本机，由 nginx 反代。
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { buildXlsx } = require('./xlsx');

const PORT = Number(process.env.PORT || 8790);
const HOST = '127.0.0.1';
const TZ = 'Asia/Shanghai';
const SESSION_DAYS = 30;
const LOW_BALANCE_CENTS = 5000;

// 数据库：默认用本机 unix socket + peer 认证（无需密码）；也可用标准的 PGHOST/PGDATABASE/PGUSER/PGPASSWORD 环境变量
const db = new Pool({ host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE || 'cw', max: 5 });

// 可选：umami 访问统计。设置了 UMAMI_SCRIPT 和 UMAMI_WEBSITE_ID 才会在页面里注入脚本
const UMAMI = process.env.UMAMI_SCRIPT && process.env.UMAMI_WEBSITE_ID
  ? `<script defer src="${process.env.UMAMI_SCRIPT}" data-website-id="${process.env.UMAMI_WEBSITE_ID}" data-auto-track="false"${process.env.UMAMI_DOMAINS ? ` data-domains="${process.env.UMAMI_DOMAINS}"` : ''}></script>\n`
  : '';

// ---------- 工具 ----------
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
function validDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// "12.5" / "12" / 12.5 -> 1250；非法返回 null
function parseAmount(v, allowNegative = false) {
  const s = String(v ?? '').trim();
  if (!/^-?\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const cents = Number(i) * 100 + Number((f + '00').slice(0, 2));
  if (cents === 0) return null;
  if (neg && !allowNegative) return null;
  return neg ? -cents : cents;
}
function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
const MEALS = ['breakfast', 'lunch', 'dinner', 'other'];

// 密码：scrypt
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

// 好记的密码：单词-4位数字
const WORDS = ('apple banana cherry grape lemon mango melon peach pear plum ' +
  'panda tiger lion koala zebra rabbit dolphin eagle otter fox ' +
  'river ocean cloud rain snow sunny star moon forest garden ' +
  'coffee cookie noodle rice tofu honey candy pizza bread sugar ' +
  'red blue green gold silver purple orange happy lucky magic').split(' ');
function memorablePassword() {
  const w = WORDS[crypto.randomInt(WORDS.length)];
  const n = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${w}-${n}`;
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- 余额 ----------
async function balances(userId) {
  const { rows: [r] } = await db.query(`
    WITH d AS (SELECT id FROM users WHERE dept_id = (SELECT dept_id FROM users WHERE id=$1))
    SELECT
      (SELECT COALESCE(SUM(cents),0) FROM topups WHERE status='done' AND user_id IN (SELECT id FROM d))
        - (SELECT COALESCE(SUM(cents),0) FROM expenses WHERE user_id IN (SELECT id FROM d)) AS pool,
      (SELECT COALESCE(SUM(cents),0) FROM topups WHERE status='done' AND user_id=$1)
        - (SELECT COALESCE(SUM(cents),0) FROM expenses WHERE user_id=$1) AS mine,
      (SELECT COALESCE(SUM(cents),0) FROM topups WHERE status='pending' AND user_id=$1) AS pending`, [userId]);
  return { poolCents: Number(r.pool), balanceCents: Number(r.mine), pendingCents: Number(r.pending) };
}

// ---------- 会话 ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function currentUser(req) {
  const token = parseCookies(req).cw_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await db.query(`
    SELECT u.id, u.username, u.display_name, u.is_admin, u.is_super, u.dept_id,
           s.expires_at < now() + interval '${SESSION_DAYS - 1} days' AS stale
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token=$1 AND s.expires_at > now() AND NOT u.disabled`, [tokenHash]);
  const u = rows[0];
  if (!u) return null;
  u.is_admin = u.is_admin || u.is_super;   // 总管理员自然也是管理员
  // 滑动续期：每天第一次访问时把有效期重新推到 30 天后，经常用的人不会被登出
  if (u.stale) {
    await db.query(`UPDATE sessions SET expires_at = now() + $2::interval WHERE token=$1`, [tokenHash, `${SESSION_DAYS} days`]);
    u.renewToken = token;
  }
  return u;
}
function sessionCookie(token, maxAge) {
  return `cw_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
}

// ---------- 业务规则 ----------
// 普通用户只能改今天和昨天的记录；管理员不限
function canEditDay(user, day) {
  if (user.is_admin) return true;
  const today = todayStr();
  return day <= today && day >= addDays(today, -1);
}
function rowExpense(r) {
  return { id: r.id, userId: r.user_id, day: r.day, meal: r.meal, item: r.item, cents: r.cents,
    time: r.time || null, adminEdited: !!r.admin_edited };
}
// 查询消费记录时统一取的列
const EXP_COLS = `id,user_id,to_char(day,'YYYY-MM-DD') AS day,meal,item,cents,admin_edited,
  to_char(created_at AT TIME ZONE '${TZ}','HH24:MI') AS time`;

// ---------- 操作日志 ----------
const MEAL_CN = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', other: '其他' };
const fmtY = (c) => (c < 0 ? '-' : '') + '¥' + (Math.abs(c) / 100).toFixed(2);
const fmtD = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`;
const expDesc = (r) => `${fmtD(r.day)} ${MEAL_CN[r.meal]}${r.item ? '（' + r.item + '）' : ''} ${fmtY(r.cents)}`;
async function audit(q, actorId, targetUserId, action, detail, data = null) {
  await q.query(`INSERT INTO audit_log(actor_id,target_user_id,action,detail,data) VALUES($1,$2,$3,$4,$5)`,
    [actorId, targetUserId, action, detail, data ? JSON.stringify(data) : null]);
}

// ---------- 部门范围 ----------
// 管理员当前操作的部门：总管理员可以用 dept 参数切换，其他管理员固定为自己的部门
async function adminDept(user, raw) {
  if (raw !== undefined && raw !== null && raw !== '' && user.is_super) {
    const id = Number(raw);
    const { rows: [d] } = await db.query(`SELECT id FROM departments WHERE id=$1`, [Number.isInteger(id) && id > 0 && id < 2147483647 ? id : 0]);
    if (!d) throw bad('部门不存在');
    return d.id;
  }
  return user.dept_id;
}
// 目标用户必须在管理员能管的范围内（总管理员不限；部门管理员只能管本部门）
async function userInScope(user, id, q = db) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(404, '用户不存在');
  const { rows: [u] } = await q.query(`SELECT * FROM users WHERE id=$1`, [n]);
  if (!u || (!user.is_super && u.dept_id !== user.dept_id)) throw new HttpError(404, '用户不存在');
  return u;
}

// ---------- 路由 ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });   // auth: none | user | admin | super
}

// 登录核心：成功返回 token，失败抛 HttpError（401 密码不对 / 429 锁定）
async function doLogin(rawUser, rawPass, req) {
  const username = cleanText(rawUser, 40).toLowerCase();
  const password = String(rawPass ?? '').slice(0, 200);
  const key = `${username}|${clientIp(req)}`;
  const { rows: [fail] } = await db.query(
    `SELECT count FROM login_fails WHERE key=$1 AND first_at > now() - interval '15 minutes'`, [key]);
  if (fail && fail.count >= 8) throw new HttpError(429, '尝试次数太多，请 15 分钟后再试');

  const { rows: [u] } = await db.query(`SELECT * FROM users WHERE username=$1`, [username]);
  const ok = checkPassword(password, u ? u.pw_hash : DUMMY_HASH) && u && !u.disabled;
  if (!ok) {
    await db.query(`
      INSERT INTO login_fails(key,count,first_at) VALUES($1,1,now())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN login_fails.first_at > now() - interval '15 minutes' THEN login_fails.count+1 ELSE 1 END,
        first_at = CASE WHEN login_fails.first_at > now() - interval '15 minutes' THEN login_fails.first_at ELSE now() END`, [key]);
    throw new HttpError(401, '用户名或密码不对');
  }
  await db.query(`DELETE FROM login_fails WHERE key=$1`, [key]);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query(`INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,now() + $3::interval)`,
    [tokenHash, u.id, `${SESSION_DAYS} days`]);
  return token;
}
route('POST', '/api/login', async ({ body, req, res }) => {
  const token = await doLogin(body.username, body.password, req);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
  return { ok: true };
}, { auth: 'none' });

// 浏览器原生表单登录（让浏览器可靠地弹出"保存密码"）：成功跳回首页，失败带错误跳回登录页
async function formLogin(req, res) {
  const redirect = (loc) => { res.writeHead(303, { Location: loc, 'Cache-Control': 'no-store' }); res.end(); };
  // 只接受本站页面提交的表单（防止别的网站替你登录到别人的账号）
  let sameOrigin = false;
  try { sameOrigin = new URL(req.headers.origin || '').host === req.headers.host; } catch {}
  if (!sameOrigin) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('请从登录页登录'); }
  let raw = '';
  try { raw = await readBody(req); } catch { return redirect('/?e=bad'); }
  const f = new URLSearchParams(raw);
  const u = cleanText(f.get('username'), 40).toLowerCase();
  try {
    const token = await doLogin(f.get('username'), f.get('password'), req);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
    return redirect('/');
  } catch (e) {
    const code = e instanceof HttpError && e.status === 429 ? 'locked' : 'bad';
    if (!(e instanceof HttpError)) console.error(e);
    return redirect(`/?e=${code}&u=${encodeURIComponent(u)}`);
  }
}

route('POST', '/api/logout', async ({ req, res }) => {
  const token = parseCookies(req).cw_session;
  if (token) await db.query(`DELETE FROM sessions WHERE token=$1`,
    [crypto.createHash('sha256').update(token).digest('hex')]);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
}, { auth: 'none' });

route('GET', '/api/me', async ({ user }) => {
  return {
    user: { id: user.id, username: user.username, displayName: user.display_name, isAdmin: user.is_admin, isSuper: user.is_super },
    dept: (await db.query(`SELECT id, name FROM departments WHERE id=$1`, [user.dept_id])).rows[0],
    deptCount: Number((await db.query(`SELECT COUNT(*) AS n FROM departments`)).rows[0].n),
    today: todayStr(),
    lowBalanceCents: LOW_BALANCE_CENTS,
    todayAllCents: Number((await db.query(`SELECT COALESCE(SUM(e.cents),0) AS c FROM expenses e JOIN users u ON u.id=e.user_id
      WHERE e.day=$1 AND u.dept_id=$2`, [todayStr(), user.dept_id])).rows[0].c),
    ...(await balances(user.id)),
  };
});

route('POST', '/api/password', async ({ user, body }) => {
  const { rows: [u] } = await db.query(`SELECT pw_hash FROM users WHERE id=$1`, [user.id]);
  if (!checkPassword(String(body.old ?? ''), u.pw_hash)) throw bad('原密码不对');
  const pw = String(body.new ?? '');
  if (pw.length < 6 || pw.length > 100) throw bad('新密码至少 6 位');
  await db.query(`UPDATE users SET pw_hash=$1 WHERE id=$2`, [hashPassword(pw), user.id]);
  await audit(db, user.id, user.id, 'user.password', '自己修改了密码');
  return { ok: true };
});

// 某一天的记录（自己的；管理员可带 user_id 看别人）
route('GET', '/api/day', async ({ user, query }) => {
  const day = query.get('date') || todayStr();
  if (!validDay(day)) throw bad('日期不对');
  const uid = await targetUserId(user, query.get('user_id'));
  const { rows } = await db.query(
    `SELECT ${EXP_COLS} FROM expenses
     WHERE user_id=$1 AND day=$2 ORDER BY id`, [uid, day]);
  return { day, editable: canEditDay(user, day), items: rows.map(rowExpense) };
});

async function targetUserId(user, raw) {
  if (raw && user.is_admin) return (await userInScope(user, raw)).id;
  return user.id;
}

route('POST', '/api/expenses', async ({ user, body }) => {
  const day = String(body.day || todayStr());
  if (!validDay(day)) throw bad('日期不对');
  if (!canEditDay(user, day)) throw new HttpError(403, '只能记今天和昨天的账');
  if (!MEALS.includes(body.meal)) throw bad('请选择早餐 / 午餐 / 晚餐');
  const item = cleanText(body.item, 40);
  const cents = parseAmount(body.amount);
  if (!cents) throw bad('金额不对');
  const uid = await targetUserId(user, body.user_id);
  const { rows: [r] } = await db.query(
    `INSERT INTO expenses(user_id,day,meal,item,cents,admin_edited) VALUES($1,$2,$3,$4,$5,$6)
     RETURNING ${EXP_COLS}`, [uid, day, body.meal, item, cents, uid !== user.id]);
  // 自己记账不写日志（记录本身就是痕迹）；替别人记才写
  if (uid !== user.id) await audit(db, user.id, uid, 'expense.create', `替对方新增 ${expDesc(r)}`, { after: rowExpense(r) });
  return rowExpense(r);
});

async function loadOwnExpense(user, id) {
  const { rows: [r] } = await db.query(
    `SELECT ${EXP_COLS} FROM expenses WHERE id=$1`, [id]);
  if (!r) throw new HttpError(404, '记录不存在');
  if (r.user_id !== user.id) {
    if (!user.is_admin) throw new HttpError(404, '记录不存在');
    await userInScope(user, r.user_id).catch(() => { throw new HttpError(404, '记录不存在'); });
  }
  if (!canEditDay(user, r.day)) throw new HttpError(403, '这条记录太早了，不能再修改，请联系管理员');
  return r;
}

route('PUT', '/api/expenses/:id', async ({ user, params, body }) => {
  const r = await loadOwnExpense(user, params.id);
  const meal = body.meal ?? r.meal;
  if (!MEALS.includes(meal)) throw bad('餐次不对');
  const item = body.item !== undefined ? cleanText(body.item, 40) : r.item;
  const cents = body.amount !== undefined ? parseAmount(body.amount) : r.cents;
  if (!cents) throw bad('金额不对');
  if (meal === r.meal && item === r.item && cents === r.cents) return rowExpense(r);
  const byOther = r.user_id !== user.id;
  const { rows: [n] } = await db.query(
    `UPDATE expenses SET meal=$1,item=$2,cents=$3,updated_at=now(),admin_edited = admin_edited OR $5 WHERE id=$4
     RETURNING ${EXP_COLS}`, [meal, item, cents, r.id, byOther]);
  const changes = [];
  if (cents !== r.cents) changes.push(`金额 ${fmtY(r.cents)} → ${fmtY(cents)}`);
  if (meal !== r.meal) changes.push(`餐次 ${MEAL_CN[r.meal]} → ${MEAL_CN[meal]}`);
  if (item !== r.item) changes.push(`内容「${r.item || '空'}」→「${item || '空'}」`);
  await audit(db, user.id, r.user_id, 'expense.update', `修改 ${fmtD(r.day)} ${MEAL_CN[r.meal]}：${changes.join('，')}`,
    { before: rowExpense(r), after: rowExpense(n) });
  return rowExpense(n);
});

route('DELETE', '/api/expenses/:id', async ({ user, params }) => {
  const r = await loadOwnExpense(user, params.id);
  await db.query(`DELETE FROM expenses WHERE id=$1`, [r.id]);
  await audit(db, user.id, r.user_id, 'expense.delete', `删除 ${expDesc(r)}`, { before: rowExpense(r) });
  return { ok: true };
});

// 历史：按月，按天分组
route('GET', '/api/history', async ({ user, query }) => {
  const month = query.get('month') || todayStr().slice(0, 7);
  if (!MONTH_RE.test(month) || !validDay(month + '-01')) throw bad('月份不对');
  const uid = await targetUserId(user, query.get('user_id'));
  const from = month + '-01';
  const { rows } = await db.query(
    `SELECT ${EXP_COLS} FROM expenses
     WHERE user_id=$1 AND day >= $2::date AND day < ($2::date + interval '1 month')
     ORDER BY day DESC, id`, [uid, from]);
  const days = new Map();
  let total = 0;
  for (const r of rows) {
    if (!days.has(r.day)) days.set(r.day, { day: r.day, cents: 0, editable: canEditDay(user, r.day), items: [] });
    const d = days.get(r.day);
    d.cents += r.cents; d.items.push(rowExpense(r)); total += r.cents;
  }
  return { month, totalCents: total, days: [...days.values()] };
});

// 最近 30 天每日合计 + 本周/本月合计
route('GET', '/api/stats', async ({ user, query }) => {
  const uid = await targetUserId(user, query.get('user_id'));
  const today = todayStr();
  const from = addDays(today, -29);
  const { rows } = await db.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, SUM(cents)::int AS cents FROM expenses
     WHERE user_id=$1 AND day >= $2 AND day <= $3 GROUP BY day`, [uid, from, today]);
  const map = new Map(rows.map((r) => [r.day, r.cents]));
  const series = [];
  for (let i = 0; i < 30; i++) { const d = addDays(from, i); series.push({ day: d, cents: map.get(d) || 0 }); }
  const { rows: [m] } = await db.query(
    `SELECT COALESCE(SUM(cents),0)::int AS cents FROM expenses
     WHERE user_id=$1 AND day >= date_trunc('month',$2::date) AND day <= $2`, [uid, today]);
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; // 周一=0
  const weekFrom = addDays(today, -dow);
  const week = series.filter((s) => s.day >= weekFrom).reduce((a, s) => a + s.cents, 0);
  return { series, todayCents: map.get(today) || 0, weekCents: week, monthCents: m.cents };
});

// 统计分析。scope：自己；管理员可传 user_id=<id> 或 user_id=all
route('GET', '/api/analytics', async ({ user, query }) => {
  const today = todayStr();
  let from = query.get('from'), to = query.get('to');
  if (!validDay(from) || !validDay(to) || from > to) throw bad('日期不对');
  if (to > today) to = today;
  if (from > to) from = to;
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (span > 800) throw bad('时间范围太长');
  const all = user.is_admin && query.get('user_id') === 'all';
  const uid = all ? null : await targetUserId(user, query.get('user_id'));
  const dept = all ? await adminDept(user, query.get('dept')) : null;
  // $1 from, $2 to, $3 uid（null=所有人）, $4 部门（只在所有人时生效）
  const SCOPE = `($3::int IS NULL OR user_id=$3) AND ($4::int IS NULL OR user_id IN (SELECT id FROM users WHERE dept_id=$4))`;
  const W = `day >= $1 AND day <= $2 AND ${SCOPE}`;
  const args = [from, to, uid, dept];

  const [daily, meals, items, weekday, prev, monthly] = await Promise.all([
    db.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, SUM(cents)::int AS cents FROM expenses WHERE ${W} GROUP BY day`, args),
    db.query(`SELECT meal, SUM(cents)::int AS cents, COUNT(*)::int AS n FROM expenses WHERE ${W} GROUP BY meal`, args),
    db.query(`SELECT item, SUM(cents)::int AS cents, COUNT(*)::int AS n FROM expenses WHERE ${W} AND item <> ''
              GROUP BY item ORDER BY SUM(cents) DESC, COUNT(*) DESC LIMIT 8`, args),
    db.query(`SELECT EXTRACT(ISODOW FROM day)::int AS dow, SUM(cents)::int AS cents FROM expenses WHERE ${W} GROUP BY 1`, args),
    db.query(`SELECT COALESCE(SUM(cents),0)::int AS cents FROM expenses WHERE day >= $1 AND day <= $2 AND ${SCOPE}`,
              [addDays(from, -span), addDays(from, -1), uid, dept]),
    db.query(`SELECT to_char(date_trunc('month',day),'YYYY-MM') AS month, SUM(cents)::int AS cents FROM expenses
              WHERE day >= (date_trunc('month',$1::date) - interval '11 months') AND day <= $2::date AND ${SCOPE} GROUP BY 1`,
              [to, to, uid, dept]),
  ]);

  const dmap = new Map(daily.rows.map((r) => [r.day, r.cents]));
  const series = [];
  const dowDays = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < span; i++) {
    const d = addDays(from, i);
    series.push({ day: d, cents: dmap.get(d) || 0 });
    dowDays[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]++;
  }
  const total = series.reduce((a, s) => a + s.cents, 0);
  const wmap = new Map(weekday.rows.map((r) => [r.dow, r.cents]));
  const mmap = new Map(monthly.rows.map((r) => [r.month, r.cents]));
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(to.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - i);
    const m = d.toISOString().slice(0, 7);
    months.push({ month: m, cents: mmap.get(m) || 0 });
  }
  const out = {
    from, to, days: span,
    totalCents: total,
    prevCents: prev.rows[0].cents,
    recordedDays: daily.rows.length,
    avgPerDayCents: Math.round(total / span),
    series,
    meals: MEALS.map((m) => { const r = meals.rows.find((x) => x.meal === m); return { meal: m, cents: r ? r.cents : 0, n: r ? r.n : 0 }; }),
    weekday: dowDays.map((n, i) => ({ dow: i, avgCents: n ? Math.round((wmap.get(i + 1) || 0) / n) : 0 })),
    topItems: items.rows,
    months,
  };
  if (all) {
    const [byUser, tops] = await Promise.all([
      db.query(`SELECT u.id, u.display_name, COALESCE(SUM(e.cents),0)::int AS cents, COUNT(DISTINCT e.day)::int AS days
                FROM users u LEFT JOIN expenses e ON e.user_id=u.id AND e.day >= $1 AND e.day <= $2
                WHERE u.dept_id=$3 GROUP BY u.id ORDER BY cents DESC, u.id`, [from, to, dept]),
      db.query(`SELECT COALESCE(SUM(cents),0)::int AS cents FROM topups WHERE status='done'
                AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2
                AND user_id IN (SELECT id FROM users WHERE dept_id=$3)`, [from, to, dept]),
    ]);
    out.byUser = byUser.rows.map((r) => ({ id: r.id, name: r.display_name, cents: r.cents, days: r.days }));
    out.topupCents = tops.rows[0].cents;
  } else {
    // 按最近 30 天日均，余额还够吃几天
    const { rows: [r30] } = await db.query(
      `SELECT COALESCE(SUM(cents),0)::int AS cents FROM expenses WHERE user_id=$1 AND day > $2 AND day <= $3`,
      [uid, addDays(today, -30), today]);
    const bal = await balances(uid);
    out.balanceCents = bal.balanceCents;
    out.avg30Cents = Math.round(r30.cents / 30);
    out.runwayDays = out.avg30Cents > 0 ? Math.floor(bal.balanceCents / out.avg30Cents) : null;
  }
  return out;
});

// 导出 Excel：自己；管理员可传 user_id=<id> 或 all
route('GET', '/api/export', async ({ user, query }) => {
  const from = query.get('from'), to = query.get('to');
  if (!validDay(from) || !validDay(to) || from > to) throw bad('日期不对');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 1100) throw bad('时间范围太长');
  const all = user.is_admin && query.get('user_id') === 'all';
  const uid = all ? null : await targetUserId(user, query.get('user_id'));
  const dept = all ? await adminDept(user, query.get('dept')) : null;
  const { rows: ex } = await db.query(`
    SELECT to_char(e.day,'YYYY-MM-DD') AS day, EXTRACT(ISODOW FROM e.day)::int AS dow, e.meal, e.item, e.cents,
           u.id AS uid, u.display_name
    FROM expenses e JOIN users u ON u.id=e.user_id
    WHERE e.day >= $1 AND e.day <= $2 AND ($3::int IS NULL OR e.user_id=$3) AND ($4::int IS NULL OR u.dept_id=$4)
    ORDER BY e.day, u.id, array_position(ARRAY['breakfast','lunch','dinner','other'], e.meal), e.id`, [from, to, uid, dept]);
  const { rows: tops } = await db.query(`
    SELECT to_char(t.created_at AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS at, u.display_name, t.cents, t.status, t.note
    FROM topups t JOIN users u ON u.id=t.user_id
    WHERE (t.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR t.user_id=$3) AND ($4::int IS NULL OR u.dept_id=$4)
    ORDER BY t.created_at`, [from, to, uid, dept]);

  const Y = (c) => c / 100;
  const WK = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const MN = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', other: '其他' };
  const ST = { pending: '待确认', done: '已入账', rejected: '已拒绝' };
  const sum = (arr) => arr.reduce((a, x) => a + x, 0);
  const nameCol = all ? [{ header: '姓名', width: 10 }] : [];
  const withName = (r, row) => (all ? [row[0], row[1], r.display_name, ...row.slice(2)] : row);
  const insertName = (row, name) => (all ? [row[0], row[1], name, ...row.slice(2)] : row);

  // 明细
  const detail = {
    name: '明细',
    columns: [{ header: '日期', width: 12 }, { header: '星期', width: 7 }, ...nameCol,
      { header: '餐次', width: 7 }, { header: '内容', width: 22 }, { header: '金额', width: 12, type: 'money' }],
    rows: ex.map((r) => withName(r, [r.day, WK[r.dow], MN[r.meal], r.item, Y(r.cents)])),
  };
  detail.totalRow = [...Array(detail.columns.length - 1).fill(''), Y(sum(ex.map((r) => r.cents)))];
  detail.totalRow[0] = `合计（${ex.length} 笔）`;

  // 每日汇总（管理员导出所有人时按 日期+人）
  const dmap = new Map();
  for (const r of ex) {
    const k = r.day + '|' + r.uid;
    if (!dmap.has(k)) dmap.set(k, { day: r.day, dow: r.dow, name: r.display_name, breakfast: 0, lunch: 0, dinner: 0, other: 0 });
    dmap.get(k)[r.meal] += r.cents;
  }
  const drows = [...dmap.values()];
  const mealKeys = ['breakfast', 'lunch', 'dinner', 'other'];
  const daily = {
    name: '每日汇总',
    columns: [{ header: '日期', width: 12 }, { header: '星期', width: 7 }, ...nameCol,
      ...mealKeys.map((m) => ({ header: MN[m], width: 11, type: 'money' })), { header: '合计', width: 12, type: 'money' }],
    rows: drows.map((d) => insertName([d.day, WK[d.dow], ...mealKeys.map((m) => Y(d[m])), Y(sum(mealKeys.map((m) => d[m])))], d.name)),
  };
  daily.totalRow = insertName(['合计', '', ...mealKeys.map((m) => Y(sum(drows.map((d) => d[m])))), Y(sum(ex.map((r) => r.cents)))], '');

  const sheets = [detail, daily];

  if (all) {
    const { rows: us } = await db.query(`
      SELECT u.id, u.display_name, u.username,
        COALESCE((SELECT SUM(cents) FROM topups t WHERE t.user_id=u.id AND status='done'),0)
          - COALESCE((SELECT SUM(cents) FROM expenses e WHERE e.user_id=u.id),0) AS balance
      FROM users u WHERE u.dept_id=$1 ORDER BY u.id`, [dept]);
    const per = us.map((u) => {
      const mine = ex.filter((r) => r.uid === u.id);
      const m = Object.fromEntries(mealKeys.map((k) => [k, sum(mine.filter((r) => r.meal === k).map((r) => r.cents))]));
      return [u.display_name, u.username, ...mealKeys.map((k) => Y(m[k])), Y(sum(mine.map((r) => r.cents))),
        new Set(mine.map((r) => r.day)).size, Y(Number(u.balance))];
    });
    sheets.push({
      name: '每人汇总',
      columns: [{ header: '姓名', width: 10 }, { header: '用户名', width: 12 },
        ...mealKeys.map((k) => ({ header: MN[k], width: 11, type: 'money' })), { header: '合计', width: 12, type: 'money' },
        { header: '记账天数', width: 9, type: 'int' }, { header: '当前余额', width: 12, type: 'money' }],
      rows: per,
      totalRow: ['合计', '', ...[2, 3, 4, 5, 6].map((i) => Math.round(sum(per.map((r) => r[i])) * 100) / 100), '',
        Math.round(sum(per.map((r) => r[8])) * 100) / 100],
    });
  }

  sheets.push({
    name: '充值记录',
    columns: [{ header: '时间', width: 17 }, ...(all ? [{ header: '姓名', width: 10 }] : []),
      { header: '金额', width: 12, type: 'money' }, { header: '状态', width: 8 }, { header: '备注', width: 20 }],
    rows: tops.map((t) => [t.at, ...(all ? [t.display_name] : []), Y(t.cents), ST[t.status], t.note]),
  });

  let who = all ? (await db.query(`SELECT name FROM departments WHERE id=$1`, [dept])).rows[0].name + '全部' : '全部';
  if (!all) { const { rows: [u] } = await db.query(`SELECT display_name FROM users WHERE id=$1`, [uid]); who = u ? u.display_name : '用户'; }
  return { __file: { name: `饭钱账本_${who}_${from}至${to}.xlsx`, data: buildXlsx(sheets),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } };
});

// 常吃的东西（快捷按钮）
route('GET', '/api/suggest', async ({ user }) => {
  const { rows } = await db.query(
    `SELECT meal, item, cents, COUNT(*) AS n FROM expenses
     WHERE user_id=$1 AND day > now() - interval '60 days'
     GROUP BY meal,item,cents ORDER BY n DESC, MAX(id) DESC LIMIT 24`, [user.id]);
  return rows.map((r) => ({ meal: r.meal, item: r.item, cents: r.cents }));
});

// 充值
route('GET', '/api/topups', async ({ user }) => {
  const { rows } = await db.query(
    `SELECT id,cents,note,status,created_at FROM topups WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [user.id]);
  return rows;
});
route('POST', '/api/topups', async ({ user, body }) => {
  const cents = parseAmount(body.amount);
  if (!cents) throw bad('金额不对');
  const { rows: [p] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM topups WHERE user_id=$1 AND status='pending'`, [user.id]);
  if (p.n >= 3) throw bad('已有 3 条待确认的充值，请等管理员确认');
  await db.query(`INSERT INTO topups(user_id,cents,note,status,created_by) VALUES($1,$2,$3,'pending',$1)`,
    [user.id, cents, cleanText(body.note, 60)]);
  await audit(db, user.id, user.id, 'topup.request', `申请充值 ${fmtY(cents)}`);
  return { ok: true };
});
route('DELETE', '/api/topups/:id', async ({ user, params }) => {
  const { rows: [t] } = await db.query(
    `DELETE FROM topups WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING cents`, [params.id, user.id]);
  if (!t) throw new HttpError(404, '找不到这条待确认的充值');
  await audit(db, user.id, user.id, 'topup.cancel', `撤回充值申请 ${fmtY(t.cents)}`);
  return { ok: true };
});

// ---------- 管理员 ----------
route('GET', '/api/admin/users', async ({ user, query }) => {
  const dept = await adminDept(user, query.get('dept'));
  const { rows } = await db.query(`
    SELECT u.id,u.username,u.display_name,u.is_admin,u.is_super,u.dept_id,u.disabled,
      COALESCE((SELECT SUM(cents) FROM topups t WHERE t.user_id=u.id AND status='done'),0)
        - COALESCE((SELECT SUM(cents) FROM expenses e WHERE e.user_id=u.id),0) AS balance,
      COALESCE((SELECT SUM(cents) FROM expenses e WHERE e.user_id=u.id
        AND day >= date_trunc('month', $1::date)),0) AS month_spent,
      (SELECT to_char(MAX(day),'YYYY-MM-DD') FROM expenses e WHERE e.user_id=u.id) AS last_day
    FROM users u WHERE u.dept_id=$2 ORDER BY u.disabled, u.id`, [todayStr(), dept]);
  return rows.map((r) => ({
    id: r.id, username: r.username, displayName: r.display_name, isAdmin: r.is_admin || r.is_super, isSuper: r.is_super,
    deptId: r.dept_id, disabled: r.disabled,
    balanceCents: Number(r.balance), monthSpentCents: Number(r.month_spent), lastDay: r.last_day,
  }));
}, { auth: 'admin' });

route('POST', '/api/admin/users', async ({ user, body }) => {
  const username = cleanText(body.username, 40).toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(username)) throw bad('用户名只能用 2-20 位小写字母、数字、下划线');
  const displayName = cleanText(body.displayName, 20) || username;
  const password = body.password ? String(body.password) : memorablePassword();
  if (password.length < 6 || password.length > 100) throw bad('密码至少 6 位');
  const dept = await adminDept(user, body.deptId);
  try {
    const { rows: [u] } = await db.query(
      `INSERT INTO users(username,display_name,pw_hash,is_admin,dept_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [username, displayName, hashPassword(password), !!body.isAdmin, dept]);
    await audit(db, user.id, u.id, 'user.create', `新建用户 ${displayName}（${username}）${body.isAdmin ? '，管理员' : ''}`);
    return { id: u.id, username, password };
  } catch (e) {
    if (e.code === '23505') throw bad('用户名已存在');
    throw e;
  }
}, { auth: 'admin' });

route('PUT', '/api/admin/users/:id', async ({ user, params, body }) => {
  const u = await userInScope(user, params.id);
  const id = u.id;
  // 部门管理员不能动总管理员
  if (u.is_super && !user.is_super) throw new HttpError(403, '不能修改总管理员');
  const out = { ok: true };
  if (body.displayName !== undefined) {
    const n = cleanText(body.displayName, 20);
    if (!n) throw bad('名字不能为空');
    await db.query(`UPDATE users SET display_name=$1 WHERE id=$2`, [n, id]);
    if (n !== u.display_name) await audit(db, user.id, id, 'user.rename', `改名 ${u.display_name} → ${n}`);
  }
  if (body.disabled !== undefined || body.isAdmin !== undefined) {
    if (id === user.id) throw bad('不能停用或降级自己');
    if (body.disabled !== undefined) {
      await db.query(`UPDATE users SET disabled=$1 WHERE id=$2`, [!!body.disabled, id]);
      await audit(db, user.id, id, body.disabled ? 'user.disable' : 'user.enable', body.disabled ? '停用账号' : '启用账号');
    }
    if (body.isAdmin !== undefined && !!body.isAdmin !== u.is_admin) {
      if (u.is_super) throw bad('总管理员不需要单独设置');
      await db.query(`UPDATE users SET is_admin=$1 WHERE id=$2`, [!!body.isAdmin, id]);
      await audit(db, user.id, id, 'user.role', body.isAdmin ? '设为部门管理员' : '取消部门管理员');
    }
    // 停用要立刻踢下线；改角色不用（每次请求都会重新读取角色）
    if (body.disabled) await db.query(`DELETE FROM sessions WHERE user_id=$1`, [id]);
  }
  if (body.deptId !== undefined && Number(body.deptId) !== u.dept_id) {
    if (!user.is_super) throw new HttpError(403, '只有总管理员能调整部门');
    if (id === user.id) throw bad('不能调整自己的部门');
    const { rows: [d] } = await db.query(`SELECT id, name FROM departments WHERE id=$1`, [Number(body.deptId) || 0]);
    if (!d) throw bad('部门不存在');
    const { rows: [from] } = await db.query(`SELECT name FROM departments WHERE id=$1`, [u.dept_id]);
    await db.query(`UPDATE users SET dept_id=$1 WHERE id=$2`, [d.id, id]);
    await audit(db, user.id, id, 'user.move', `从「${from.name}」调到「${d.name}」（余额随人转过去）`);
  }
  if (body.resetPassword) {
    const pw = typeof body.resetPassword === 'string' ? body.resetPassword : memorablePassword();
    if (pw.length < 6 || pw.length > 100) throw bad('密码至少 6 位');
    await db.query(`UPDATE users SET pw_hash=$1 WHERE id=$2`, [hashPassword(pw), id]);
    if (id !== user.id) await db.query(`DELETE FROM sessions WHERE user_id=$1`, [id]);
    await audit(db, user.id, id, 'user.resetpw', '重置了密码');
    out.password = pw;
  }
  return out;
}, { auth: 'admin' });

route('GET', '/api/admin/topups', async ({ user, query }) => {
  const status = query.get('status');
  const uid = query.get('user_id');
  const where = []; const args = [];
  args.push(await adminDept(user, query.get('dept'))); where.push(`u.dept_id=$${args.length}`);
  if (status) { args.push(status); where.push(`t.status=$${args.length}`); }
  if (uid) { args.push(Number(uid)); where.push(`t.user_id=$${args.length}`); }
  const { rows } = await db.query(`
    SELECT t.id,t.user_id,u.display_name,t.cents,t.note,t.status,t.created_at,t.decided_at
    FROM topups t JOIN users u ON u.id=t.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (t.status='pending') DESC, t.id DESC LIMIT 200`, args);
  return rows;
}, { auth: 'admin' });

// 管理员加减余额；或传 setTo 直接把余额设成某个数（自动算差额，记一笔"余额校正"）
route('POST', '/api/admin/topups', async ({ user, body }) => {
  const uid = Number(body.userId);
  const note = cleanText(body.note, 60);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 锁住该用户，防止同时操作时差额算错
    const target = await userInScope(user, uid, client);
    if (target.is_super && !user.is_super) throw new HttpError(403, '不能调整总管理员的余额');
    await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [uid]);
    let cents, finalNote = note;
    if (body.setTo !== undefined) {
      const s = String(body.setTo).trim();
      const target = s === '0' || /^-?0+(\.0{1,2})?$/.test(s) ? 0 : parseAmount(s, true);
      if (target === null) throw bad('金额不对');
      const { rows: [b] } = await client.query(`
        SELECT (SELECT COALESCE(SUM(cents),0) FROM topups WHERE status='done' AND user_id=$1)
             - (SELECT COALESCE(SUM(cents),0) FROM expenses WHERE user_id=$1) AS bal`, [uid]);
      const cur = Number(b.bal);
      cents = target - cur;
      if (cents === 0) throw bad('余额已经是这个数了');
      const f = (c) => (c < 0 ? '-' : '') + '¥' + (Math.abs(c) / 100).toFixed(2);
      finalNote = `余额校正 ${f(cur)} → ${f(target)}${note ? '：' + note : ''}`.slice(0, 120);
    } else {
      cents = parseAmount(body.amount, true);
      if (!cents) throw bad('金额不对');
    }
    await client.query(`INSERT INTO topups(user_id,cents,note,status,created_by,decided_at) VALUES($1,$2,$3,'done',$4,now())`,
      [uid, cents, finalNote, user.id]);
    await audit(client, user.id, uid, body.setTo !== undefined ? 'balance.set' : 'balance.adjust',
      body.setTo !== undefined ? finalNote : `${cents > 0 ? '充值' : '扣减'} ${fmtY(cents)}${note ? '：' + note : ''}`);
    await client.query('COMMIT');
    return { ok: true, cents };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}, { auth: 'admin' });

route('POST', '/api/admin/topups/:id/approve', async ({ user, params }) => {
  const { rows: [t] } = await db.query(
    `UPDATE topups SET status='done',decided_at=now() WHERE id=$1 AND status='pending'
       AND ($2 OR user_id IN (SELECT id FROM users WHERE dept_id=$3)) RETURNING user_id,cents`, [params.id, user.is_super, user.dept_id]);
  if (!t) throw new HttpError(404, '找不到待确认的记录');
  await audit(db, user.id, t.user_id, 'topup.approve', `确认充值 ${fmtY(t.cents)} 已入账`);
  return { ok: true };
}, { auth: 'admin' });
route('POST', '/api/admin/topups/:id/reject', async ({ user, params }) => {
  const { rows: [t] } = await db.query(
    `UPDATE topups SET status='rejected',decided_at=now() WHERE id=$1 AND status='pending'
       AND ($2 OR user_id IN (SELECT id FROM users WHERE dept_id=$3)) RETURNING user_id,cents`, [params.id, user.is_super, user.dept_id]);
  if (!t) throw new HttpError(404, '找不到待确认的记录');
  await audit(db, user.id, t.user_id, 'topup.reject', `拒绝充值申请 ${fmtY(t.cents)}`);
  return { ok: true };
}, { auth: 'admin' });

// 所有人的消费记录（可按用户、日期筛选）
route('GET', '/api/admin/expenses', async ({ user, query }) => {
  const from = query.get('from') || addDays(todayStr(), -6);
  const to = query.get('to') || todayStr();
  if (!validDay(from) || !validDay(to)) throw bad('日期不对');
  const args = [from, to, await adminDept(user, query.get('dept'))]; let extra = ' AND u.dept_id=$3';
  if (query.get('user_id')) { args.push(Number(query.get('user_id')) || 0); extra += ` AND e.user_id=$4`; }
  const { rows } = await db.query(`
    SELECT e.id,e.user_id,u.display_name,to_char(e.day,'YYYY-MM-DD') AS day,e.meal,e.item,e.cents,e.admin_edited,
      to_char(e.created_at AT TIME ZONE '${TZ}','HH24:MI') AS time
    FROM expenses e JOIN users u ON u.id=e.user_id
    WHERE e.day >= $1 AND e.day <= $2 ${extra}
    ORDER BY e.day DESC, u.id, e.id LIMIT 2000`, args);
  return rows.map((r) => ({ ...rowExpense(r), displayName: r.display_name }));
}, { auth: 'admin' });

// ---------- 部门 ----------
// 部门列表：总管理员看全部，部门管理员只看自己部门
route('GET', '/api/admin/depts', async ({ user }) => {
  const { rows } = await db.query(`
    SELECT d.id, d.name,
      (SELECT COUNT(*) FROM users u WHERE u.dept_id=d.id AND NOT u.disabled)::int AS members,
      COALESCE((SELECT SUM(t.cents) FROM topups t JOIN users u ON u.id=t.user_id WHERE u.dept_id=d.id AND t.status='done'),0)
        - COALESCE((SELECT SUM(e.cents) FROM expenses e JOIN users u ON u.id=e.user_id WHERE u.dept_id=d.id),0) AS pool
    FROM departments d WHERE $1 OR d.id=$2 ORDER BY d.id`, [user.is_super, user.dept_id]);
  return rows.map((r) => ({ id: r.id, name: r.name, members: r.members, poolCents: Number(r.pool) }));
}, { auth: 'admin' });
route('POST', '/api/admin/depts', async ({ user, body }) => {
  const name = cleanText(body.name, 20);
  if (!name) throw bad('请填写部门名称');
  try {
    const { rows: [d] } = await db.query(`INSERT INTO departments(name) VALUES($1) RETURNING id`, [name]);
    await audit(db, user.id, null, 'dept.create', `新建部门「${name}」`);
    return { id: d.id, name };
  } catch (e) { if (e.code === '23505') throw bad('已有同名部门'); throw e; }
}, { auth: 'super' });
route('PUT', '/api/admin/depts/:id', async ({ user, params, body }) => {
  const name = cleanText(body.name, 20);
  if (!name) throw bad('请填写部门名称');
  const { rows: [d] } = await db.query(`SELECT name FROM departments WHERE id=$1`, [params.id]);
  if (!d) throw new HttpError(404, '部门不存在');
  try { await db.query(`UPDATE departments SET name=$1 WHERE id=$2`, [name, params.id]); }
  catch (e) { if (e.code === '23505') throw bad('已有同名部门'); throw e; }
  if (name !== d.name) await audit(db, user.id, null, 'dept.rename', `部门改名「${d.name}」→「${name}」`);
  return { ok: true };
}, { auth: 'super' });
route('DELETE', '/api/admin/depts/:id', async ({ user, params }) => {
  const { rows: [d] } = await db.query(`SELECT name, (SELECT COUNT(*) FROM users WHERE dept_id=$1)::int AS n FROM departments WHERE id=$1`, [params.id]);
  if (!d) throw new HttpError(404, '部门不存在');
  if (d.n > 0) throw bad('部门里还有人（含已停用的），先把人调走才能删除');
  await db.query(`DELETE FROM departments WHERE id=$1`, [params.id]);
  await audit(db, user.id, null, 'dept.delete', `删除部门「${d.name}」`);
  return { ok: true };
}, { auth: 'super' });

// ---------- 日志查询 ----------
function rowAudit(r) {
  return { id: r.id, at: r.at, action: r.action, detail: r.detail, actor: r.actor_name, actorId: r.actor_id,
    target: r.target_name, targetId: r.target_user_id };
}
const AUDIT_SQL = `SELECT a.*, ua.display_name AS actor_name, ut.display_name AS target_name
  FROM audit_log a LEFT JOIN users ua ON ua.id=a.actor_id LEFT JOIN users ut ON ut.id=a.target_user_id`;
// 别人（管理员）对我账户做过的事
route('GET', '/api/audit/mine', async ({ user }) => {
  const { rows } = await db.query(`${AUDIT_SQL} WHERE a.target_user_id=$1 AND a.actor_id IS DISTINCT FROM $1
    ORDER BY a.id DESC LIMIT 200`, [user.id]);
  return rows.map(rowAudit);
});
// 管理员看全部日志：可按用户筛选，可只看"管理员动了别人的账"
route('GET', '/api/admin/audit', async ({ user, query }) => {
  const args = [await adminDept(user, query.get('dept'))]; const where = ['COALESCE(ut.dept_id, ua.dept_id) = $1'];
  if (query.get('user_id')) { args.push(Number(query.get('user_id'))); where.push(`(a.target_user_id=$${args.length} OR a.actor_id=$${args.length})`); }
  if (query.get('others') === '1') where.push(`a.actor_id IS DISTINCT FROM a.target_user_id`);
  const { rows } = await db.query(`${AUDIT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT 300`, args);
  return rows.map(rowAudit);
}, { auth: 'admin' });

// ---------- 静态文件 ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 前端路由兜底
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      res.writeHead(404); return res.end('not found');
    }
    if (UMAMI && path.basename(file) === 'index.html') data = Buffer.from(data.toString('utf8').replace('</head>', UMAMI + '</head>'));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- 服务 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 16384) { reject(new HttpError(413, '请求太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/login') return formLogin(req, res).catch((e) => { console.error(e); res.writeHead(500); res.end(); });
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, '接口不存在');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
    if (Object.values(params).some((v) => !(v > 0 && v <= 2147483647))) throw new HttpError(404, '记录不存在');
    let body = {};
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      // 只接受 JSON：跨站表单无法伪造这种请求（防 CSRF）。DELETE 跨站必须经过 CORS 预检，本身就伪造不了
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, '只接受 JSON');
      const raw = await readBody(req);
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw bad('JSON 格式不对'); }
      if (typeof body !== 'object' || body === null) body = {};
    }
    let user = null;
    if (r.auth !== 'none') {
      user = await currentUser(req);
      if (!user) throw new HttpError(401, '请先登录');
      if (user.renewToken) res.setHeader('Set-Cookie', sessionCookie(user.renewToken, SESSION_DAYS * 86400));
      if (r.auth === 'admin' && !user.is_admin) throw new HttpError(403, '需要管理员权限');
      if (r.auth === 'super' && !user.is_super) throw new HttpError(403, '需要总管理员权限');
    }
    const result = await r.handler({ req, res, user, params, body, query: url.searchParams });
    if (result && result.__file) {
      const f = result.__file;
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.data.length, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      return res.end(f.data);
    }
    send(200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    console.error(e);
    send(500, { error: '服务器出错了' });
  }
});

// 定时清理过期会话
setInterval(() => {
  db.query(`DELETE FROM sessions WHERE expires_at < now()`).catch(() => {});
  db.query(`DELETE FROM login_fails WHERE first_at < now() - interval '1 day'`).catch(() => {});
}, 3600 * 1000).unref();

async function main() {
  await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // 命令行：node server.js create-admin <用户名> <显示名> [密码]
  if (process.argv[2] === 'create-admin') {
    const [, , , username, displayName, pw] = process.argv;
    const password = pw || memorablePassword();
    await db.query(
      `INSERT INTO users(username,display_name,pw_hash,is_admin,is_super) VALUES($1,$2,$3,true,true)
       ON CONFLICT (username) DO UPDATE SET pw_hash=EXCLUDED.pw_hash, is_admin=true, is_super=true, disabled=false`,
      [username.toLowerCase(), displayName || username, hashPassword(password)]);
    console.log(`总管理员 ${username} 的密码：${password}`);
    await db.end();
    return;
  }
  server.listen(PORT, HOST, () => console.log(`cw listening on ${HOST}:${PORT}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
