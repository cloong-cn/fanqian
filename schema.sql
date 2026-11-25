-- 记账系统数据库结构。金额一律用"分"（整数）保存，避免小数误差。
CREATE TABLE IF NOT EXISTS users (
  id           serial PRIMARY KEY,
  username     text NOT NULL UNIQUE,
  display_name text NOT NULL,
  pw_hash      text NOT NULL,
  is_admin     boolean NOT NULL DEFAULT false,
  disabled     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- 吃饭花费，一顿可以有多条
CREATE TABLE IF NOT EXISTS expenses (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id),
  day        date NOT NULL,
  meal       text NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','other')),
  item       text NOT NULL,
  cents      int  NOT NULL CHECK (cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_user_day ON expenses(user_id, day);

-- 充值 / 调整。status: pending=用户申请待确认, done=已入账, rejected=已拒绝
-- cents 可以为负（管理员扣减调整）
CREATE TABLE IF NOT EXISTS topups (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id),
  cents      int NOT NULL CHECK (cents <> 0),
  note       text NOT NULL DEFAULT '',
  status     text NOT NULL CHECK (status IN ('pending','done','rejected')),
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS topups_user ON topups(user_id);

CREATE TABLE IF NOT EXISTS login_fails (
  key        text PRIMARY KEY,
  count      int NOT NULL,
  first_at   timestamptz NOT NULL
);

-- 操作日志：谁、什么时候、对谁的账户、做了什么
CREATE TABLE IF NOT EXISTS audit_log (
  id             serial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       int REFERENCES users(id) ON DELETE SET NULL,
  target_user_id int REFERENCES users(id) ON DELETE SET NULL,
  action         text NOT NULL,
  detail         text NOT NULL DEFAULT '',
  data           jsonb
);
CREATE INDEX IF NOT EXISTS audit_target ON audit_log(target_user_id, id DESC);

-- 被管理员改过的消费记录做个标记，用户自己能看到
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS admin_edited boolean NOT NULL DEFAULT false;

-- 部门：每个部门的资金池、记录、统计互相独立
CREATE TABLE IF NOT EXISTS departments (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO departments(id, name) VALUES (1, '部门一') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('departments', 'id'), GREATEST((SELECT MAX(id) FROM departments), 1));
ALTER TABLE users ADD COLUMN IF NOT EXISTS dept_id int NOT NULL DEFAULT 1 REFERENCES departments(id);
-- 总管理员：管所有部门；is_admin 只管自己部门
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super boolean NOT NULL DEFAULT false;
-- 升级时：还没有总管理员的话，把现有管理员设为总管理员（保证系统里总有人能管部门）
UPDATE users SET is_super = true WHERE is_admin AND NOT disabled AND NOT EXISTS (SELECT 1 FROM users WHERE is_super AND NOT disabled);
CREATE INDEX IF NOT EXISTS users_dept ON users(dept_id);

-- 按日期范围统计（所有人 / 管理员消费列表）用的覆盖索引
CREATE INDEX IF NOT EXISTS expenses_day ON expenses(day) INCLUDE (user_id, cents, meal);
CREATE INDEX IF NOT EXISTS topups_user_status ON topups(user_id, status) INCLUDE (cents);

-- 部门开关：成员之间能否互相查看消费记录（只读，不含个人余额）。默认关闭
ALTER TABLE departments ADD COLUMN IF NOT EXISTS members_visible boolean NOT NULL DEFAULT false;
