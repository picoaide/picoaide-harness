-- 0061: 员工余额(balance)+ 月度余额发放 + 用户名大小写统一。
--
-- 需求(2026-09-11):
--   * users.balance_money: 员工可用余额(元,存量),管理员可手动调整;
--     月度定时任务按配置「增加/覆盖」全员发放。
--   * balance_grants: 每月发放的幂等锚(month 主键)。多实例/重入时
--     INSERT ... ON CONFLICT DO NOTHING 抢锁,确保同一北京月只发放一次。
--   * 网关在 balance.enabled=1 时以余额为硬闸门(余额 <= 0 → 429);
--     消费按 usage.cost 原子扣减余额(与 usage 写入同事务)。
--
-- F9(审计 2026-09-11): 用户标识大小写口径不一致 —— groups 自 0019 起
-- NOCASE,而 users.username 一直大小写敏感,LDAP/本地同名异大小写可产生
-- 影子账号并绕过 provisionUser 的接管保护。此处为干净数据建 LOWER(username)
-- 唯一索引;已有重复时跳过(应用层仍以 NOCASE 查找并拒绝新增重复,启动时告警),
-- 避免升级因历史脏数据直接失败。
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_money DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS balance_grants (
  month      TEXT PRIMARY KEY,              -- 北京月 YYYYMM
  mode       TEXT NOT NULL,                 -- 'add' | 'cover'
  amount     DOUBLE PRECISION NOT NULL,     -- 单人发放额度(元)
  affected   INTEGER NOT NULL DEFAULT 0,    -- 实际影响的用户数
  actor      TEXT NOT NULL DEFAULT '',      -- 触发者(定时任务为空)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users GROUP BY lower(username) HAVING COUNT(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (lower(username));
  END IF;
END $$;
