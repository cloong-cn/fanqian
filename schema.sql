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
