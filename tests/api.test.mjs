const B = 'http://127.0.0.1:8790';
let pass = 0, failN = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { failN++; console.log('  ✗ FAIL:', name, extra); } };
class C {
  constructor() { this.cookie = ''; }
  async req(method, path, body, raw = false) {
    const h = {}; if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(B + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) { const m = /cw_session=([a-f0-9]*)/.exec(sc); if (m) this.cookie = m[1] ? 'cw_session=' + m[1] : ''; }
    const data = raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => ({}));
    return { s: r.status, d: data, h: r.headers };
  }
  get(p) { return this.req('GET', p); } post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); } del(p) { return this.req('DELETE', p); }
  async login(u, pw) { return this.post('/api/login', { username: u, password: pw }); }
}
const sec = (t) => console.log('▶', t);
const A = new C(), U = new C(), V = new C(), anon = new C();

sec('登录 / 权限');
ok((await A.login('zzadmin', 'test-admin-1')).s === 200, 'admin login');
ok((await anon.get('/api/me')).s === 401, 'anon /api/me 401');
ok((await anon.login('zzadmin', 'wrong')).s === 401, 'wrong password 401');
ok((await anon.login('ZZADMIN', 'test-admin-1')).s === 200, 'username case-insensitive');

sec('管理员建用户');
const cu = await A.post('/api/admin/users', { username: 'zzu', displayName: '测U' });
ok(cu.s === 200 && /^[a-z]+-\d{4}$/.test(cu.d.password), 'create user w/ memorable pw', JSON.stringify(cu.d));
const cv = await A.post('/api/admin/users', { username: 'zzv', displayName: '测V', password: 'vvvvvv' });
ok(cv.s === 200, 'create user w/ given pw');
ok((await A.post('/api/admin/users', { username: 'zzu' })).s === 400, 'duplicate username rejected');
ok((await A.post('/api/admin/users', { username: 'Bad Name!' })).s === 400, 'invalid username rejected');
ok((await U.login('zzu', cu.d.password)).s === 200, 'new user can login');
ok((await V.login('zzv', 'vvvvvv')).s === 200, 'user V login');
ok((await U.get('/api/admin/users')).s === 403, 'non-admin blocked from admin API');
ok((await U.post('/api/admin/topups', { userId: cu.d.id, amount: '999' })).s === 403, 'non-admin cannot top up');

const me0 = (await U.get('/api/me')).d; const T = me0.today;
const Y = new Date(Date.parse(T) - 86400000).toISOString().slice(0, 10);
const OLD = new Date(Date.parse(T) - 3 * 86400000).toISOString().slice(0, 10);
const FUT = new Date(Date.parse(T) + 86400000).toISOString().slice(0, 10);
ok(me0.balanceCents === 0 && !me0.user.isAdmin, 'new user balance 0');

sec('充值：申请 / 撤回 / 确认 / 拒绝 / 上限');
ok((await U.post('/api/topups', { amount: '-5' })).s === 400, 'negative topup request rejected');
ok((await U.post('/api/topups', { amount: '0' })).s === 400, 'zero topup rejected');
ok((await U.post('/api/topups', { amount: '100' })).s === 200, 'request 100');
let mine = (await U.get('/api/topups')).d;
ok((await U.get('/api/me')).d.balanceCents === 0 && (await U.get('/api/me')).d.pendingCents === 10000, 'pending not counted in balance');
ok((await U.del('/api/topups/' + mine[0].id)).s === 200, 'cancel pending (DELETE w/o body)');
ok((await U.del('/api/topups/' + mine[0].id)).s === 404, 'cancel twice -> 404');
for (const a of ['200', '300', '400']) await U.post('/api/topups', { amount: a });
ok((await U.post('/api/topups', { amount: '1' })).s === 400, 'max 3 pending');
const pend = (await A.get('/api/admin/topups?status=pending')).d.filter((t) => t.user_id === cu.d.id);
ok(pend.length === 3, 'admin sees 3 pending');
ok((await A.post(`/api/admin/topups/${pend[0].id}/approve`)).s === 200, 'approve');
ok((await A.post(`/api/admin/topups/${pend[0].id}/approve`)).s === 404, 'approve twice blocked');
ok((await A.post(`/api/admin/topups/${pend[1].id}/reject`)).s === 200, 'reject');
ok((await U.del('/api/topups/' + pend[0].id)).s === 404, 'cannot cancel approved');
ok((await V.del('/api/topups/' + pend[2].id)).s === 404, 'cannot cancel someone else\'s');
await A.post(`/api/admin/topups/${pend[2].id}/approve`);
const approvedSum = [pend[0], pend[2]].reduce((a, t) => a + t.cents, 0);
ok((await U.get('/api/me')).d.balanceCents === approvedSum, 'balance = approved only', String((await U.get('/api/me')).d.balanceCents));

sec('记账：金额 / 日期 / 权限');
const bad = ['0', '-1', 'abc', '1.234', '', '99999999', '1e3'];
for (const amt of bad) ok((await U.post('/api/expenses', { meal: 'lunch', amount: amt })).s === 400, `bad amount "${amt}" rejected`);
ok((await U.post('/api/expenses', { meal: 'brunch', amount: '5' })).s === 400, 'bad meal rejected');
ok((await U.post('/api/expenses', { meal: 'lunch', amount: '5', day: OLD })).s === 403, 'user cannot record 3 days ago');
ok((await U.post('/api/expenses', { meal: 'lunch', amount: '5', day: FUT })).s === 403, 'user cannot record future');
ok((await U.post('/api/expenses', { meal: 'lunch', amount: '5', day: '2026-02-30' })).s === 400, 'invalid date rejected');
const e1 = (await U.post('/api/expenses', { meal: 'breakfast', amount: '5.5' })).d;
const e2 = (await U.post('/api/expenses', { meal: 'lunch', amount: '15' })).d;
const e3 = (await U.post('/api/expenses', { meal: 'lunch', amount: '2', day: Y })).d;
ok(e1.cents === 550 && e2.cents === 1500 && e3.day === Y, 'record today + yesterday');
ok(e1.item === '' && e1.time && !e1.adminEdited, 'amount-only record has time, no admin flag');
const ev = (await V.post('/api/expenses', { meal: 'dinner', amount: '20' })).d;
ok((await V.put('/api/expenses/' + e1.id, { amount: '1' })).s === 404, 'V cannot edit U\'s record');
ok((await V.del('/api/expenses/' + e1.id)).s === 404, 'V cannot delete U\'s record');
ok((await U.get('/api/day?user_id=' + cv.d.id)).d.items.every((x) => x.userId === cu.d.id), 'user_id param ignored for non-admin');
const upd = await U.put('/api/expenses/' + e2.id, { amount: '16', meal: 'dinner' });
ok(upd.s === 200 && upd.d.cents === 1600 && upd.d.meal === 'dinner' && !upd.d.adminEdited, 'user edits own record');
ok((await U.put('/api/expenses/99999999999', { amount: '1' })).s === 404, 'huge id -> 404 not 500');
ok((await U.get('/api/history?month=2026-13')).s === 400, 'invalid month -> 400 not 500');

sec('余额一致性');
let spent = 550 + 1600 + 200;
let m1 = (await U.get('/api/me')).d;
ok(m1.balanceCents === approvedSum - spent, 'balance = topups - expenses', `${m1.balanceCents} vs ${approvedSum - spent}`);
const users = (await A.get('/api/admin/users')).d;
const sumBal = users.reduce((a, u) => a + u.balanceCents, 0);
ok(m1.poolCents === sumBal, 'pool = sum of all balances', `${m1.poolCents} vs ${sumBal}`);
ok(users.find((u) => u.id === cu.d.id).balanceCents === m1.balanceCents, 'admin list balance matches user view');
const allToday = (await A.get(`/api/admin/expenses?from=${T}&to=${T}`)).d.reduce((a, r) => a + r.cents, 0);
ok(m1.todayAllCents === allToday, 'todayAllCents = sum of today', `${m1.todayAllCents} vs ${allToday}`);

sec('管理员：改别人的账 / 锁定日期 / 设余额');
const ae = await A.put('/api/expenses/' + e1.id, { amount: '6' });
ok(ae.s === 200 && ae.d.adminEdited, 'admin edit flags record');
spent += 50;
const old = (await A.post('/api/expenses', { meal: 'lunch', amount: '10', day: OLD, user_id: cu.d.id })).d;
ok(old.day === OLD && old.userId === cu.d.id && old.adminEdited, 'admin can add old record for user');
spent += 1000;
ok((await U.put('/api/expenses/' + old.id, { amount: '1' })).s === 403, 'user cannot edit locked old record');
ok((await U.del('/api/expenses/' + old.id)).s === 403, 'user cannot delete locked old record');
ok((await U.get('/api/me')).d.balanceCents === approvedSum - spent, 'balance after admin changes');
ok((await A.post('/api/admin/topups', { userId: cu.d.id, setTo: '300' })).d.ok, 'set balance 300');
ok((await U.get('/api/me')).d.balanceCents === 30000, 'balance is exactly 300');
ok((await A.post('/api/admin/topups', { userId: cu.d.id, setTo: '300' })).s === 400, 'set same value rejected');
ok((await A.post('/api/admin/topups', { userId: cu.d.id, amount: '-50.5', note: '扣' })).d.ok, 'adjust -50.5');
ok((await U.get('/api/me')).d.balanceCents === 24950, 'balance 249.50');

sec('操作日志');
const myLog = (await U.get('/api/audit/mine')).d;
ok(myLog.length >= 5 && myLog.every((r) => r.actorId !== cu.d.id), 'user sees admin actions only', String(myLog.length));
ok(myLog.some((r) => /金额 ¥5.50 → ¥6.00/.test(r.detail)), 'edit logged with before/after');
ok(myLog.some((r) => /余额校正/.test(r.detail)) && myLog.some((r) => /确认充值/.test(r.detail)) && myLog.some((r) => /拒绝/.test(r.detail)), 'set/approve/reject logged');
const adminLog = (await A.get('/api/admin/audit?user_id=' + cu.d.id)).d;
ok(adminLog.some((r) => r.actorId === cu.d.id && /修改/.test(r.detail)), 'admin sees user self-edit');
ok((await U.get('/api/admin/audit')).s === 403, 'user blocked from full log');

sec('明细 / 统计 / 导出 一致性');
const month = T.slice(0, 7);
const hist = (await U.get('/api/history?month=' + month)).d;
const histSum = hist.days.reduce((a, d) => a + d.cents, 0);
ok(hist.totalCents === histSum, 'history total = sum of days');
const from = month + '-01';
const an = (await U.get(`/api/analytics?from=${from}&to=${T}`)).d;
ok(an.totalCents === hist.totalCents, 'analytics total = history total', `${an.totalCents} vs ${hist.totalCents}`);
ok(an.meals.reduce((a, m) => a + m.cents, 0) === an.totalCents, 'meal breakdown sums to total');
ok(an.series.reduce((a, s) => a + s.cents, 0) === an.totalCents, 'daily series sums to total');
const an2 = (await U.get(`/api/analytics?from=${from}&to=${T}&user_id=all`)).d;
ok(an2.byUser === undefined, 'user cannot request all-users stats');
const anAll = (await A.get(`/api/analytics?from=${from}&to=${T}&user_id=all`)).d;
ok(anAll.byUser.reduce((a, u) => a + u.cents, 0) === anAll.totalCents, 'all-users: per-person sums to total');
const ex = await U.req('GET', `/api/export?from=${from}&to=${T}`, undefined, true);
ok(ex.s === 200 && ex.h.get('content-type').includes('spreadsheetml') && ex.d.slice(0, 2).toString() === 'PK', 'export returns xlsx');
const exAll = await U.req('GET', `/api/export?from=${from}&to=${T}&user_id=all`, undefined, true);
ok(!decodeURIComponent(exAll.h.get('content-disposition')).includes('全部'), 'user cannot export all');

sec('改密码 / 停用 / 退出');
ok((await V.post('/api/password', { old: 'nope', new: 'abcdef' })).s === 400, 'wrong old password rejected');
ok((await V.post('/api/password', { old: 'vvvvvv', new: '123' })).s === 400, 'short new password rejected');
ok((await V.post('/api/password', { old: 'vvvvvv', new: 'newpass1' })).s === 200, 'change password');
ok((await new C().login('zzv', 'newpass1')).s === 200, 'login with new password');
ok((await A.put('/api/admin/users/' + cv.d.id, { disabled: true })).s === 200, 'disable V');
ok((await V.get('/api/me')).s === 401, 'disabled user session killed');
ok((await new C().login('zzv', 'newpass1')).s === 401, 'disabled user cannot login');
const meA = (await A.get('/api/me')).d;
ok((await A.put('/api/admin/users/' + meA.user.id, { disabled: true })).s === 400, 'admin cannot disable self');
ok((await U.post('/api/logout')).s === 200 && (await U.get('/api/me')).s === 401, 'logout ends session');

sec('防暴力破解');
const W = new C(); let last;
for (let i = 0; i < 9; i++) last = await W.login('zzu', 'bad' + i);
ok(last.s === 429, 'lockout after 8 failures', String(last.s));

sec('CSRF');
const r1 = await fetch(B + '/api/expenses', { method: 'POST', headers: { cookie: A.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'meal=lunch&amount=5' });
ok(r1.status === 415, 'form-encoded POST rejected');

console.log(`\n通过 ${pass} 项，失败 ${failN} 项`);
