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

sec('表单登录（浏览器保存密码用）');
{
  const form = (u, pw, origin) => fetch(B + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
    body: new URLSearchParams({ username: u, password: pw }) });
  const good = await form('zzadmin', 'test-admin-1', B);
  ok(good.status === 303 && good.headers.get('location') === '/' && /cw_session=[a-f0-9]{64}/.test(good.headers.get('set-cookie') || ''), 'form login success -> 303 / + cookie');
  const badf = await form('ZZadmin', 'nope', B);
  ok(badf.status === 303 && badf.headers.get('location') === '/?e=bad&u=zzadmin' && !badf.headers.get('set-cookie'), 'form login failure -> 303 with error, no cookie');
  ok((await form('zzadmin', 'test-admin-1', 'https://evil.example')).status === 403, 'form login from other site rejected');
  ok((await form('zzadmin', 'test-admin-1', null)).status === 403, 'form login without Origin rejected');
}
await anon.req('GET', '/api/me');
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


sec('部门：隔离与权限');
{
  const S = A;   // zzadmin 是总管理员（命令行创建）
  const meS = (await S.get('/api/me')).d;
  ok(meS.user.isSuper && meS.dept && meS.dept.id, 'CLI admin is super admin with a dept');
  const d1 = meS.dept.id;
  // 本节用一个全新的 1 部门用户（前面的 U 已退出登录且被锁定）
  const y = await S.post('/api/admin/users', { username: 'zzy', displayName: '测Y', password: 'yyyyyy', deptId: d1 });
  const Yc = new C(); await Yc.login('zzy', 'yyyyyy');
  ok((await Yc.post('/api/admin/depts', { name: 'zz不该成功' })).s === 403, 'regular user cannot create dept');
  const nd = await S.post('/api/admin/depts', { name: 'zz测试部' });
  ok(nd.s === 200 && nd.d.id, 'super creates dept');
  const d2 = nd.d.id;
  ok((await S.post('/api/admin/depts', { name: 'zz测试部' })).s === 400, 'duplicate dept name rejected');
  const x = await S.post('/api/admin/users', { username: 'zzx', displayName: '测X', password: 'xxxxxx', deptId: d2 });
  const xa = await S.post('/api/admin/users', { username: 'zzxa', displayName: '测X管', password: 'xxxxxx', deptId: d2, isAdmin: true });
  ok(x.s === 200 && xa.s === 200, 'super creates users in new dept');
  const X = new C(), XA = new C();
  await X.login('zzx', 'xxxxxx'); await XA.login('zzxa', 'xxxxxx');
  const poolU0 = (await Yc.get('/api/me')).d.poolCents;
  ok((await S.post('/api/admin/topups', { userId: x.d.id, amount: '100' })).s === 200, 'super tops up dept-2 user');
  await X.post('/api/expenses', { meal: 'lunch', amount: '30' });
  const mx = (await X.get('/api/me')).d;
  ok(mx.dept.id === d2 && mx.balanceCents === 7000 && mx.poolCents === 7000, 'dept-2 pool only counts dept-2', JSON.stringify([mx.balanceCents, mx.poolCents]));
  ok(mx.todayAllCents === 3000, 'dept-2 today total only counts dept-2', String(mx.todayAllCents));
  ok((await Yc.get('/api/me')).d.poolCents === poolU0, 'dept-1 pool unaffected by dept-2 money');
  ok(mx.deptCount >= 2, 'deptCount reported');

  // 部门管理员只能管本部门
  const xau = (await XA.get('/api/admin/users')).d;
  ok(Array.isArray(xau) && xau.every((u) => u.deptId === d2) && xau.length === 2, 'dept admin lists only own dept');
  ok((await XA.get('/api/admin/users?dept=' + d1)).d.every((u) => u.deptId === d2), 'dept admin cannot switch dept via param');
  ok((await XA.put('/api/admin/users/' + y.d.id, { displayName: 'hack' })).s === 404, 'dept admin cannot edit other-dept user');
  ok((await XA.post('/api/admin/topups', { userId: y.d.id, amount: '1' })).s === 404, 'dept admin cannot top up other-dept user');
  ok((await XA.get('/api/day?user_id=' + y.d.id)).s === 404, 'dept admin cannot read other-dept day');
  const uExp = (await Yc.post('/api/expenses', { meal: 'dinner', amount: '9' })).d;
  ok((await XA.put('/api/expenses/' + uExp.id, { amount: '1' })).s === 404, 'dept admin cannot edit other-dept record');
  ok((await XA.del('/api/expenses/' + uExp.id)).s === 404, 'dept admin cannot delete other-dept record');
  await Yc.post('/api/topups', { amount: '5' });
  const uPend = (await S.get('/api/admin/topups?status=pending')).d.find((t) => t.user_id === y.d.id);
  ok((await XA.post(`/api/admin/topups/${uPend.id}/approve`)).s === 404, 'dept admin cannot approve other-dept top-up');
  ok(!(await XA.get('/api/admin/topups')).d.some((t) => t.user_id === y.d.id), 'dept admin top-up list excludes other dept');
  ok(!(await XA.get(`/api/admin/expenses?from=${T}&to=${T}`)).d.some((r) => r.userId === y.d.id), 'dept admin expense list excludes other dept');
  const xaAll = (await XA.get(`/api/analytics?from=${T}&to=${T}&user_id=all&dept=${d1}`)).d;
  ok(xaAll.totalCents === 3000 && xaAll.byUser.every((u) => [x.d.id, xa.d.id].includes(u.id)), 'dept admin all-stats = own dept only', String(xaAll.totalCents));
  const xaEx = await XA.req('GET', `/api/export?from=${T}&to=${T}&user_id=all&dept=${d1}`, undefined, true);
  ok(decodeURIComponent(xaEx.h.get('content-disposition')).includes('zz测试部'), 'dept admin export = own dept');
  ok(!(await XA.get('/api/admin/audit')).d.some((r) => r.targetId === y.d.id), 'dept admin log excludes other dept');
  ok((await XA.get('/api/admin/depts')).d.length === 1, 'dept admin sees only own dept in dept list');
  ok((await XA.put('/api/admin/users/' + x.d.id, { deptId: d1 })).s === 403, 'dept admin cannot move users');
  ok((await XA.put('/api/admin/depts/' + d2, { name: 'zz改' })).s === 403, 'dept admin cannot rename dept');
  // 部门管理员可以管本部门：设/取消管理员
  ok((await XA.put('/api/admin/users/' + x.d.id, { isAdmin: true })).s === 200, 'dept admin promotes own-dept user');
  ok((await X.get('/api/admin/users')).s === 200, 'promoted user gains admin access without relogin');
  ok((await XA.put('/api/admin/users/' + x.d.id, { isAdmin: false })).s === 200, 'dept admin demotes');
  ok((await X.get('/api/admin/users')).s === 403, 'demoted user loses admin access');
  ok((await X.get('/api/me')).s === 200, 'role change does not log the user out');

  // 总管理员：跨部门
  ok((await S.get('/api/admin/users?dept=' + d2)).d.length === 2, 'super can view other dept via param');
  const sAll = (await S.get(`/api/analytics?from=${T}&to=${T}&user_id=all&dept=${d2}`)).d;
  ok(sAll.totalCents === 3000, 'super stats for chosen dept');
  // 部门管理员不能动总管理员（把总管理员调进 d2 再测）
  const sup2 = await S.post('/api/admin/users', { username: 'zzsup', displayName: '测总2', password: 'ssssss', deptId: d2 });
  // 同部门的部门管理员不能动总管理员
  const da1 = await S.post('/api/admin/users', { username: 'zzda1', displayName: '测部管1', password: 'dddddd', deptId: d1, isAdmin: true });
  const DA1 = new C(); await DA1.login('zzda1', 'dddddd');
  ok((await DA1.put('/api/admin/users/' + meS.user.id, { resetPassword: true })).s === 403, 'dept admin cannot reset super password');
  ok((await DA1.put('/api/admin/users/' + meS.user.id, { disabled: true })).s === 403, 'dept admin cannot disable super');
  ok((await DA1.post('/api/admin/topups', { userId: meS.user.id, amount: '-10' })).s === 403, 'dept admin cannot change super balance');
  ok((await DA1.put('/api/admin/users/' + y.d.id, { displayName: '测U' })).s === 200, 'dept admin can manage own-dept user');
  ok((await S.put('/api/admin/users/' + meS.user.id, { isAdmin: false })).s === 400, 'super cannot demote self');
  ok((await S.put('/api/admin/depts/' + d2, { name: 'zz测试部二' })).s === 200, 'super renames dept');
  ok((await S.del('/api/admin/depts/' + d2)).s === 400, 'cannot delete dept with members');
  // 调动：余额跟人走
  const poolBefore = (await Yc.get('/api/me')).d.poolCents;
  ok((await S.put('/api/admin/users/' + x.d.id, { deptId: d1 })).s === 200, 'super moves user to dept 1');
  ok((await Yc.get('/api/me')).d.poolCents === poolBefore + 7000, 'moved balance joins dept-1 pool');
  ok((await X.get('/api/me')).d.dept.id === d1, 'moved user now in dept 1');
  ok((await S.put('/api/admin/users/' + meS.user.id, { deptId: d2 })).s === 400, 'super cannot move self');
  for (const id of [xa.d.id, sup2.d.id]) await S.put('/api/admin/users/' + id, { deptId: d1 });
  ok((await S.del('/api/admin/depts/' + d2)).s === 200, 'empty dept can be deleted');
}

console.log(`\n通过 ${pass} 项，失败 ${failN} 项`);
