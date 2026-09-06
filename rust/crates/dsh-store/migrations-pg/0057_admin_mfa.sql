-- 0057: 密码修改能力 + 管理员 MFA(TOTP)。
-- 需求: 管理员改自己密码/重置普通用户密码/员工自助改密/管理员可选双因素认证
-- (docs/planning/2026-09-04-admin-password-and-mfa.md)。
--
-- users 新增列:
--   * password_must_change: 1 = 下次登录强制改密(管理员重置密码时置位, 改密成功清除)
--   * password_changed_at:  上次改密时间(展示/审计用; 创建时 NULL = 从未改密)
--   * totp_secret:   管理员 TOTP 密钥密文(AES-GCM + master key; '' = 未配置)
--   * totp_enabled:  1 = 已启用(仅 verify 成功才置 1)
-- admin_mfa_challenges: 两步登录/开启 MFA 的一次性挑战(DB 表而非内存 —— 无状态
-- 多实例一致, 同 admin_sessions 先例)。
ALTER TABLE users ADD COLUMN password_must_change SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN totp_enabled SMALLINT NOT NULL DEFAULT 0;

CREATE TABLE admin_mfa_challenges (
  id         TEXT PRIMARY KEY,            -- 随机 48 hex
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'login',  -- 'login' 两步登录 | 'enable' 开启 MFA 暂存密钥
  secret     TEXT NOT NULL DEFAULT '',    -- kind='enable' 时的 TOTP 密钥密文(其余为空)
  attempts   INT NOT NULL DEFAULT 0,      -- 失败计数, >=5 作废(防爆破)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,        -- 5 分钟
  used_at    TIMESTAMPTZ                  -- 消费置位(防重放)
);
CREATE INDEX idx_mfa_challenges_user ON admin_mfa_challenges(user_id);
