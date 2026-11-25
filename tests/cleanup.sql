-- 删除所有测试账号（用户名以 zz 开头）及其数据和日志
BEGIN;
CREATE TEMP TABLE zz AS SELECT id FROM users WHERE username LIKE 'zz%';
DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM zz) OR target_user_id IN (SELECT id FROM zz);
DELETE FROM expenses WHERE user_id IN (SELECT id FROM zz);
DELETE FROM topups   WHERE user_id IN (SELECT id FROM zz);
UPDATE topups SET created_by=NULL WHERE created_by IN (SELECT id FROM zz);
DELETE FROM sessions WHERE user_id IN (SELECT id FROM zz);
DELETE FROM users WHERE id IN (SELECT id FROM zz);
DELETE FROM login_fails WHERE key LIKE 'zz%';
DELETE FROM audit_log WHERE action LIKE 'dept.%' AND detail LIKE '%zz%';
DELETE FROM departments WHERE name LIKE 'zz%' AND id <> 1;
COMMIT;
