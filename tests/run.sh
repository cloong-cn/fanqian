#!/bin/sh
# 对线上服务跑一遍接口测试，用临时账号 zz*，跑完自动清理。用法：sh tests/run.sh
set -e
cd "$(dirname "$0")/.."
sudo -u cw psql -q -d cw -f tests/cleanup.sql >/dev/null 2>&1
sudo -u cw node server.js create-admin zzadmin 测试管理员 test-admin-1 >/dev/null
node tests/api.test.mjs; rc=$?
sudo -u cw psql -q -d cw -f tests/cleanup.sql >/dev/null 2>&1
exit $rc
