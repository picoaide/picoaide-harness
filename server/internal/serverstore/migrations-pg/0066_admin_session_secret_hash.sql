-- 0066: 管理会话凭证只存哈希(审计 2026-09-13 P2-2)。
--
-- 背景:admin_sessions.id 就是下发给浏览器的 cookie 值(明文),任何能读
-- 数据库的路径(备份/pg_dump/只读副本/注入)都能在 12 小时有效期内直接
-- 冒充管理员。api_tokens 早就是"只存 SHA-256"的口径,这里对齐。
--
-- 迁移:新增 secret_hash 列(cookie 值的 SHA-256,唯一),id 退回为纯内部主键。
-- 旧行 secret_hash='' 不再可登录(会话在升级后失效,用户重新登录一次)——
-- 这是刻意的:保留可用的明文会话等于没修。
ALTER TABLE admin_sessions ADD COLUMN secret_hash TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_sessions_secret_hash
  ON admin_sessions (secret_hash) WHERE secret_hash <> '';
