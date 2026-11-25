# 饭钱账本

几个人共用一笔伙食费的记账小程序。管理员建好账号、给每个人充值；每个人每天记下早中晚花了多少，随时看自己还剩多少钱。

手机优先，可以"添加到主屏幕"像 App 一样用。后端只有 Node.js + PostgreSQL，唯一的依赖是 `pg`，前端不用任何框架，没有构建步骤。

## 功能

**用户**
- 记账：选早餐 / 午餐 / 晚餐 / 其他，只填金额就行；常用金额一点即记
- 余额：我的余额、账户总余额（所有人合计）、今日大家共花、本月 / 今日我花了多少
- 账单：按天的紧凑明细（按周小计，点开看每一笔），和统计（日均——只算有记录的天、早中晚占比、星期规律、近 12 个月趋势、余额还够吃几天）
- 充值：提交申请，管理员确认收到钱后入账
- 导出 Excel（明细、每日汇总、充值记录）
- 账户变动记录：管理员对自己账户做过的所有操作都看得到
- 普通用户只能改今天和昨天的记录，更早的锁定

**部门**
- 多个部门共用一套系统，各部门的资金池、记录、统计、导出完全独立
- 角色：**总管理员**（管所有部门：新建/改名/删除部门、调人）、**部门管理员**（只管本部门）、普通用户
- 权限在服务端逐个接口校验，部门管理员无法通过任何参数访问其他部门
- 部门开关「成员互相查看消费记录」（默认关）：开启后成员可在账单里只读查看同事的明细和统计，个人余额不公开

**管理员**
- 建用户（自动生成好记的密码，如 `panda-2847`）、重置密码、停用、设为/取消部门管理员
- 给人充值 / 扣减，或直接把余额设为某个数（自动记一笔"余额校正"）
- 审批充值申请；查看、修改所有人的记录
- 操作日志：谁在什么时候改了谁的什么，不能删除；被管理员改过的记录会标出来
- 所有人的统计与导出

**其他**
- 深色模式、动效（尊重系统"减少动态效果"设置）、320px 小屏适配
- 离线时显示提示页（数据从不缓存）
- 可选接入 [umami](https://umami.is/) 统计页面访问（只上报页面名，不含金额和姓名）

## 部署

需要：Node.js 18+（推荐 22/24）、PostgreSQL 13+、Nginx（或其他反向代理，必须 HTTPS——登录 Cookie 带 `Secure`）。

```sh
# 1. 系统用户和代码
sudo useradd --system --home /srv/cw --shell /usr/sbin/nologin cw
sudo git clone <本仓库> /srv/cw/app
cd /srv/cw/app && sudo npm ci --omit=dev && sudo chown -R cw:cw /srv/cw

# 2. 数据库（用 unix socket + peer 认证，不需要数据库密码）
sudo -u postgres psql -c "CREATE ROLE cw LOGIN" -c "CREATE DATABASE cw OWNER cw"
#    确认 pg_hba.conf 里有：local  cw  cw  peer
#    表结构在服务启动时自动创建/升级（schema.sql）

# 3. 第一个总管理员（不填密码会自动生成并打印出来）
sudo -u cw node server.js create-admin admin 管理员

# 4. 服务、备份、Nginx：参考 deploy/ 目录
sudo cp deploy/cw.service deploy/cw-backup.* /etc/systemd/system/   # 备份脚本是 deploy/backup.sh
sudo mkdir -p /srv/cw/backups && sudo chown cw:cw /srv/cw/backups
sudo systemctl daemon-reload && sudo systemctl enable --now cw cw-backup.timer
#    Nginx 配置见 deploy/nginx.conf（含限流和安全头），证书用 certbot 申请
```

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8790` | 只监听 127.0.0.1，由反向代理对外 |
| `PGHOST` / `PGDATABASE` | `/var/run/postgresql` / `cw` | 也支持 `PGUSER`、`PGPASSWORD` 等标准变量 |
| `UMAMI_SCRIPT` / `UMAMI_WEBSITE_ID` | 空 | 都设置了才启用 umami 统计 |
| `UMAMI_DOMAINS` | 空 | 只在这些域名上统计（逗号分隔） |

时区固定为 `Asia/Shanghai`（"今天"按北京时间算），低余额提醒阈值是 50 元，都在 `server.js` 顶部。

## 备份与恢复

`deploy/backup.sh` 每 2 小时、以及每次服务启动前用 `pg_dump` 备份到 `/srv/cw/backups`：确认备份完整才保存，保留 60 天且至少保留最近 30 份。恢复：

```sh
systemctl stop cw
sudo -u postgres dropdb cw && sudo -u postgres createdb -O cw cw
zcat /srv/cw/backups/cw-YYYYMMDD-HHMMSS.sql.gz | sudo -u cw psql -q -d cw -v ON_ERROR_STOP=1
systemctl start cw
```

怎么验证备份可用、恢复前要注意什么，见 [MAINTAINING.md](MAINTAINING.md)。

## 测试

```sh
sh tests/run.sh
```

对正在运行的服务跑 160 多项接口测试（登录与权限、部门隔离、充值流程、记账校验、余额与统计的一致性、管理员操作与日志、导出、防暴力破解、CSRF 等）。测试使用临时账号 `zz*`，跑完自动清理，最后一行应为"失败 0 项"。

## 性能

- 部门总余额、今日合计、管理员用户列表等读多写少的数据放在进程内缓存；本服务是唯一写入方，任何写操作后立即清空（另有 30 秒过期兜底）
- 静态文件读入内存并带 ETag，重复访问只需 304；建议在 Nginx 开启 gzip（见 deploy/nginx.conf），JS/CSS 体积约为原来的 1/3
- 切换页面时页面数据与 `/api/me` 并行请求
- 实测 30 人、3 年约 10 万条记录：`/api/me` 约 3ms，部门统计约 60–90ms，全年全员导出 Excel 约 0.7s

## 安全设计

- 密码用 scrypt 加盐哈希；会话令牌只存哈希；30 天有效，使用时自动续期
- 登录失败 8 次锁定 15 分钟，Nginx 另有限流
- 写操作只接受 JSON（表单登录单独校验 Origin），防 CSRF
- 严格的 CSP；所有用户输入在页面上转义
- 金额全部用"分"（整数）存储，余额实时由流水计算，不存可被改乱的余额字段
- 每个写请求整体在一个数据库事务里，出错全部撤销；设置余额时锁住该用户，并发操作也只生效一次

## 维护

接手维护、要改代码之前，先看 [MAINTAINING.md](MAINTAINING.md)：架构、去哪改、不能破坏的规则、权限函数、缓存的坑、改表结构、备份恢复、常见问题。

## 目录

```
server.js      后端（HTTP 路由、业务规则）
xlsx.js        无依赖的 .xlsx 生成器
schema.sql     表结构（启动时自动执行）
public/        前端（index.html、app.js、style.css、图标、Service Worker）
deploy/        systemd、Nginx 示例配置、备份脚本
tests/         接口测试
```
