# 维护手册

写给以后接手这个项目的人。先读完这一页再动代码，大约 10 分钟。

## 一句话架构

```
浏览器（public/ 下的单页应用，无框架、无构建）
   │  HTTPS
Nginx（证书、gzip、限流、安全头）
   │  http://127.0.0.1:8790
server.js（Node 内置 http，唯一依赖 pg）
   │  unix socket，peer 认证
PostgreSQL（库 cw，表结构见 schema.sql）
```

没有构建步骤、没有 ORM、没有前端框架：改完文件重启服务就生效。

## 目录与"去哪改"

| 想改什么 | 去哪里 |
|---|---|
| 接口、权限、业务规则 | `server.js`，按 `// ---------- 分区 ----------` 注释找 |
| 表结构 | `schema.sql`（每次启动都会执行，必须可重复执行，见下文） |
| 页面 | `public/app.js`，每个页面一个 `renderXxx()` 函数 |
| 样式 | `public/style.css`（颜色变量在顶部 `:root`，深色模式在 `prefers-color-scheme: dark`） |
| Excel 导出格式 | `xlsx.js`（生成器）+ `server.js` 里的 `/api/export`（内容） |
| 部署、备份 | `deploy/`（systemd、nginx 示例、`backup.sh`） |
| 测试 | `tests/api.test.mjs` |

`server.js` 的分区顺序：事务 → 读缓存 → 工具 → 余额 → 会话 → 业务规则 → 操作日志 → 部门范围 → 路由与各接口 → 管理员 → 部门 → 日志查询 → 静态文件 → 服务。

`public/app.js` 的页面和网址：`#/` 记账（`renderHome`）、`#/bill` 账单（`renderBill`，里面分 `renderHistory` 明细和 `renderStats` 统计）、`#/topup` 充值、`#/me` 我的、`#/log` 我的账户变动、`#/admin` 管理（`adminUsers` / `adminTopups` / `adminExpenses` / `adminAudit` / `adminDepts`）。路由表在文件最后。

## 不能破坏的规则（数据正确性）

1. **金额一律用"分"（整数）**。前端显示时才除以 100。不要引入浮点金额。解析用户输入只用 `parseAmount()`。
2. **余额不存储，永远现算**：`余额 = 已入账充值(topups.status='done') − 所有消费(expenses)`。部门总余额 = 部门内所有人余额之和。不要加"余额"字段，那样一定会和流水对不上。
3. **调余额只能新增一条 topups 记录**（正数充值、负数扣减、"余额校正"），不要改旧记录的金额。这样每一分钱的来龙去脉都查得到。
4. **每个写操作都要记操作日志**：调用 `audit(db, 操作人, 被操作的人, 'xxx.yyy', '给人看的中文描述')`。日志只增不删。
5. **写请求自动在一个数据库事务里**（`route()` 里写请求默认 `tx: true`）：处理函数中途抛错，这次请求的所有改动都会撤销，不会留下"记录改了、日志没写"的半截数据。在处理函数里直接用 `db.query()` 就行，它会自动走事务连接。只有登录/退出设了 `tx: false`（登录失败计数必须保留）。需要"先读再根据结果写"（比如设置余额算差额）时，先 `SELECT ... FOR UPDATE` 锁住相关用户行。
6. **日期按北京时间**：用 `todayStr()`、`addDays()`，不要用 `new Date()` 直接取日期。数据库里 `day` 是 `date` 类型。
7. **删除一律是逻辑删除**：`users.deleted_at` / `departments.deleted_at` 打标记，不真删数据。查"当前有效"的人或部门时要加 `deleted_at IS NULL`（`userInScope`、`adminDept` 已经处理）；统计历史时**不要**排除已删除的人，否则合计会对不上。只能删余额为 0 的账号（`notDeletableReason`）。随部门删除的账号 `deleted_with_dept=true`，恢复部门时一起恢复。
8. **普通用户只能改今天和昨天**：`canEditDay()`。管理员不限，管理员改别人的记录会打上 `admin_edited` 标记。

9. **合买**（`splits` / `split_members`，`server.js` 的「合买」分区）：被选的人全部表态完自动结算，发起人或本部门管理员也可提前结算（未表态的算不参加）。按同意人数平分，`Math.round` 到分，尾差由发起人补齐（发起人没参加则由最早同意的人补齐），见 `splitShares()`。结算时给每个同意的人记一条 `meal='other'` 的消费，`expenses.split_id` 指回合买；普通用户不能改这类记录。有进行中合买的人不能删除。

## 权限模型

三种角色：总管理员 `is_super`（管所有部门）、部门管理员 `is_admin`（只管本部门）、普通用户。登录后 `currentUser()` 会把总管理员的 `is_admin` 也设为 true。

**权限必须在服务端判断**，前端隐藏按钮只是为了好看。写新接口时用这几个现成的函数，不要自己拼：

| 函数 | 用途 |
|---|---|
| `route(方法, 路径, 处理函数, { auth })` | `auth`: `none` / `user`（默认）/ `admin` / `super` |
| `adminDept(user, query.get('dept'))` | 管理员当前操作的部门（只有总管理员能切换） |
| `userInScope(user, id)` | 管理员要操作的目标用户，必须在他能管的部门里，否则 404 |
| `viewUserId(user, raw)` | **只读**查看谁的数据：自己 / 管理员范围内 / 开了"成员互相查看"的同部门成员 |
| `targetUserId(user, raw)` | **写**：替谁记账，只有管理员能替别人 |

部门开关 `departments.members_visible` 只放开"只读看明细和统计"，个人余额始终只有本人和管理员能看（`/api/analytics` 里 `hiddenBalance`）。

## 读缓存（改代码最容易踩的坑）

部门总余额、今日合计、用户列表等用 `cached(key, fn)` 放在进程内存里（30 秒过期）。**任何写请求成功后，路由会自动调用 `invalidateCache()` 清空**，所以通过接口改数据总是立即可见。

要注意：
- 如果你在 HTTP 接口**之外**写数据库（定时任务、命令行），写完必须调用 `invalidateCache()`，或者重启服务。直接用 psql 改数据最多 30 秒后可见。
- 本服务只能跑**一个进程**（缓存在进程内）。要多进程，得先去掉或换掉缓存。

## 表结构怎么改

`schema.sql` 每次启动都会完整执行一遍，所以每条语句都必须**可重复执行**：

```sql
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ...;
```

新内容一律追加在文件末尾，不要修改已有语句（线上库已经执行过了）。不要在这里写 `DROP` 或删除数据的语句。启动前会自动备份一次，改坏了可以恢复（见下文）。

## 加一个新功能的检查清单

1. 后端：`route(...)`，选对 `auth`，用上面的权限函数取用户/部门；写操作记 `audit()`
2. 输入校验：金额 `parseAmount`、日期 `validDay`、文本 `cleanText(v, 最大长度)`，非法输入抛 `bad('中文提示')`（400）
3. 前端：读用 `apiGet()`，写用 `api()`。拼 HTML 时用户输入必须经过 `esc()`
4. 在 `tests/api.test.mjs` 里加测试，尤其是"别人/别的部门不能访问"
5. 跑测试、重启、提交（见下面的流程）
6. 外壳文件（`index.html` / `app.js` / `style.css`）改动较大时，把 `public/sw.js` 里的 `CACHE` 版本号加一

## 日常操作

```sh
cd /srv/cw/app
node --check server.js && node --check public/app.js     # 语法检查
chown -R cw:cw /srv/cw/app && systemctl restart cw         # 上线（重启前自动备份一次）
sh tests/run.sh                                            # 最后一行应为"失败 0 项"
git add -A && git commit -m "说明改了什么"
```

- 看日志：`journalctl -u cw -f`（报错会打印在这里）；备份日志：`journalctl -u cw-backup`
- 退回某个版本：`git log` 找到版本号，`git checkout <版本> -- <文件>`，再重启
- 新建总管理员 / 忘了管理员密码：`sudo -u cw node server.js create-admin <用户名> <显示名> [密码]`
- 普通用户忘了密码：管理员在"管理 → 用户"里重置

测试是对**正在运行的服务**跑的：会建 `zz` 开头的临时用户和部门，跑完自动删除（`tests/cleanup.sql`），不碰真实数据。所以真实用户名不要以 `zz` 开头。

## 备份与恢复

- `deploy/backup.sh`：每 2 小时一次（`cw-backup.timer`），另外每次服务启动前一次。备份在 `/srv/cw/backups/cw-日期-时间.sql.gz`
- 先写临时文件，检查 pg_dump 成功、内容完整、能解压，才保存为正式备份，所以不会留下坏备份
- 保留 60 天，并且无论如何至少保留最近 30 份（备份连续失败也不会把旧的删光）
- 手动备份：`systemctl start cw-backup.service`
- 备份和数据库在同一台机器上。要防整机损坏，需要服务器快照或把备份复制到别处

检查备份能不能用（还原到临时库对比，不影响线上）：

```sh
f=$(ls -1t /srv/cw/backups/cw-*.sql.gz | head -1)
sudo -u postgres createdb cw_restoretest
zcat "$f" | sudo -u postgres psql -q -d cw_restoretest -v ON_ERROR_STOP=1
Q="SELECT (SELECT count(*) FROM expenses), (SELECT count(*) FROM topups), (SELECT sum(cents) FROM expenses)"
sudo -u postgres psql -d cw -tAc "$Q"; sudo -u postgres psql -d cw_restoretest -tAc "$Q"   # 两行应一致（最近一次备份之后新记的除外）
sudo -u postgres dropdb cw_restoretest
```

真正恢复（会覆盖当前数据，先自己再备份一次当前库）：

```sh
systemctl start cw-backup.service          # 先把现状也备份一份
systemctl stop cw
sudo -u postgres dropdb cw && sudo -u postgres createdb -O cw cw
zcat /srv/cw/backups/cw-YYYYMMDD-HHMMSS.sql.gz | sudo -u cw psql -q -d cw -v ON_ERROR_STOP=1
systemctl start cw
```

注意：恢复前 `systemctl start cw` 会再触发一次备份，不影响。

## 常见问题

| 现象 | 排查 |
|---|---|
| 页面打不开 / 502 | `systemctl status cw`、`journalctl -u cw -n 50`；数据库 `systemctl status postgresql` |
| 改了前端没生效 | 手机上是已安装的 App：完全关闭再打开；或把 `sw.js` 的 `CACHE` 加一 |
| 登录提示"尝试次数太多" | 同一账号同一 IP 失败 8 次锁 15 分钟，等待或 `DELETE FROM login_fails;` |
| 某人余额"不对" | 余额是现算的，不会算错，通常是记录本身有问题：看他的"账户变动记录"和管理 → 日志，就能找到是哪一笔 |
| 用 psql 改了数据页面没变 | 进程内缓存，最多 30 秒，或 `systemctl restart cw` |
