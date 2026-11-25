#!/bin/bash
# 饭钱账本数据库备份（由 cw-backup.timer 每 2 小时调用，cw.service 每次启动前也会调用一次）
#  - 先写临时文件，确认 pg_dump 成功、内容完整、gzip 可解压，才改成正式文件名：不会留下"坏备份"
#  - 只有本次备份成功才清理旧备份；超过 KEEP_DAYS 天的才删，并且无论如何至少保留最近 MIN_KEEP 份
#    （万一备份连续失败很久，也不会把旧备份删光）
set -euo pipefail
DIR=${BACKUP_DIR:-/srv/cw/backups}
DB=${PGDATABASE:-cw}
KEEP_DAYS=${KEEP_DAYS:-60}
MIN_KEEP=${MIN_KEEP:-30}

f="$DIR/cw-$(date +%Y%m%d-%H%M%S).sql.gz"
tmp="$DIR/.backup-$$.sql"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

pg_dump -d "$DB" > "$tmp"
# pg_dump 正常结束时最后会写这一行；没有就说明备份不完整
tail -n 5 "$tmp" | grep -q 'PostgreSQL database dump complete' || { echo "备份不完整：$tmp" >&2; exit 1; }
grep -q '^COPY public.expenses ' "$tmp" || { echo "备份里没有 expenses 表" >&2; exit 1; }
gzip -c "$tmp" > "$tmp.gz"
gzip -t "$tmp.gz"
mv "$tmp.gz" "$f"
echo "备份完成：$f（$(stat -c %s "$f") 字节）"

# 清理旧备份
mapfile -t all < <(ls -1t "$DIR"/cw-*.sql.gz 2>/dev/null)
n=${#all[@]}
for ((i = n - 1; i >= MIN_KEEP; i--)); do
  if [ -n "$(find "${all[$i]}" -mtime +"$KEEP_DAYS")" ]; then rm -f "${all[$i]}"; echo "删除旧备份：${all[$i]}"; fi
done
