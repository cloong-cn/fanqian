# 饭钱账本 (cw.example.com)

多人共用伙食费的记账小程序。Node.js（仅依赖 `pg`）+ PostgreSQL，前端无框架。

## 部署结构（服务器上）
- 代码：`/srv/cw/app`（就是本仓库），系统用户 `cw`
- 服务：`systemctl restart cw`（`/etc/systemd/system/cw.service`，监听 127.0.0.1:8790）
- 数据库：本机 PG 15，库 `cw`，unix socket + peer 认证（无密码）
- Nginx：`/etc/nginx/conf.d/cw.conf`
- 备份：`cw-backup.timer` 每天 03:30 → `/srv/cw/backups`

## 改代码的流程
    cd /srv/cw/app
    # 改文件……
    node --check server.js && node --check public/app.js
    chown -R cw:cw /srv/cw/app && systemctl restart cw
    git add -A && git commit -m "说明改了什么"
    # 改坏了想退回：git log 找到版本，git checkout <版本> -- <文件>，再 restart

前端 `public/sw.js` 里的 `CACHE` 名字在外壳文件大改后可以加一，促使旧缓存清掉（本身是网络优先，不改也会更新）。

## 管理员命令
    cd /srv/cw/app && sudo -u cw node server.js create-admin <用户名> <显示名> [密码]

## 备份与恢复
备份只放在本机 `/srv/cw/backups`（每天 03:30，保留 60 天），服务器整体靠云厂商快照兜底。
手动备份一次：`systemctl start cw-backup.service`

从备份恢复（会覆盖当前数据，先停服务）：

    systemctl stop cw
    sudo -u postgres dropdb cw && sudo -u postgres createdb -O cw cw
    zcat /srv/cw/backups/cw-YYYYMMDD-HHMM.sql.gz | sudo -u cw psql -q -d cw
    systemctl start cw

## 测试
改完代码后跑一遍：`sh tests/run.sh`（接口测试，用临时 zz* 账号，跑完自动清理；最后一行应是「失败 0 项」）
