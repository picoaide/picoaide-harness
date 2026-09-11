-- 0062: 余额账本 + 逐人发放 + 开通语义。
--
-- 设计文档:docs/planning/2026-09-11-balance-quota-consolidation.md
--
-- 三件事:
--   1. balance_ledger        —— 追加型流水,成为余额的唯一账本真源。
--      不变量 I1:users.balance_money == SUM(balance_ledger.amount)(每用户)。
--   2. balance_grant_items   —— 逐人·月的发放幂等锚(取代"每北京月一条
--      全体 UPDATE"),让新入职/漏发/重新启用的员工被下一次 tick 自动补齐。
--   3. users.balance_activated_at —— 余额账户开通时点(首次入账置位)。
--      未开通用户不扣余额、不被余额闸门拦截:存量部署开启闸门不会误拦,
--      闸门关闭期间的消费也不会凭空产生欠款。
--
-- 幂等:对象 IF NOT EXISTS;回填只对"尚无任何流水"的用户写入,可重复执行。
-- 时区:北京月一律用 `now() AT TIME ZONE 'UTC' + interval '8 hours'`(固定 +8,
-- 不依赖 tzdata,与 Go 侧 BeijingOffset / bjWallExpr 同口径)。

CREATE TABLE IF NOT EXISTS balance_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  kind          TEXT NOT NULL,              -- grant | reset | adjust | consume | refund
  amount        DOUBLE PRECISION NOT NULL,  -- 带符号:正=入账,负=出账(微元精度 1e-6)
  balance_after DOUBLE PRECISION NOT NULL,  -- 该笔之后的账户余额(微元)
  reason        TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',   -- 管理员用户名 / 'system'
  usage_id      BIGINT,                     -- consume/refund 关联 usage.id
  month         TEXT NOT NULL DEFAULT '',   -- 发放批次(北京月 YYYYMM),非发放为 ''
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_balance_ledger_user ON balance_ledger (user_id, id DESC);
-- 按 usage 行查"已计费金额"(consume 累加 / refund 冲减),支持费用向下修正时回补。
CREATE INDEX IF NOT EXISTS idx_balance_ledger_usage
  ON balance_ledger (usage_id) WHERE usage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS balance_grant_items (
  user_id    BIGINT NOT NULL,
  month      TEXT NOT NULL,                 -- 北京月 YYYYMM
  amount     DOUBLE PRECISION NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'add',   -- 入账时的发放方式
  actor      TEXT NOT NULL DEFAULT '',      -- 'system' | 管理员用户名
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_activated_at TIMESTAMPTZ;

-- 回填:给"尚无流水"的用户建立期初余额,并补记当月已发生的发放。
-- 单条语句内两个分支各自看到同一快照(NOT EXISTS 不会看到本语句新插入的行),
-- 因此对"当月已发放 A、当前余额 B"的用户会写入两条流水:
--   adjust(B-A, balance_after=B-A) + grant(A, balance_after=B)  → 合计 B = I1 ✓
-- 未被发放过的用户只写 adjust(B);B=0 且未被发放过的用户不写流水(=未开通)。
INSERT INTO balance_ledger (user_id, kind, amount, balance_after, reason, actor, month)
SELECT u.id, 'adjust',
       u.balance_money - COALESCE(i.amount, 0),
       u.balance_money - COALESCE(i.amount, 0),
       '迁移期初余额', 'system', ''
FROM users u
LEFT JOIN balance_grant_items i
  ON i.user_id = u.id
 AND i.month = to_char(now() AT TIME ZONE 'UTC' + interval '8 hours', 'YYYYMM')
WHERE NOT EXISTS (SELECT 1 FROM balance_ledger l WHERE l.user_id = u.id)
  AND u.balance_money - COALESCE(i.amount, 0) <> 0
UNION ALL
SELECT u.id, 'grant', i.amount, u.balance_money, '迁移补记当月发放', 'migration', i.month
FROM users u
JOIN balance_grant_items i
  ON i.user_id = u.id
 AND i.month = to_char(now() AT TIME ZONE 'UTC' + interval '8 hours', 'YYYYMM')
WHERE NOT EXISTS (SELECT 1 FROM balance_ledger l WHERE l.user_id = u.id)
  AND i.amount <> 0;

-- 回填 2:当月已有发放批次 → 为该批次覆盖范围内、且本月尚无逐人锚的用户补锚,
-- 避免升级后调度器把当月额度再发一次。(历史月份不回填:调度器只补当月。)
INSERT INTO balance_grant_items (user_id, month, amount, mode, actor)
SELECT u.id, g.month, g.amount, g.mode, 'migration'
FROM users u
CROSS JOIN balance_grants g
WHERE u.status = 1 AND u.role = 'user'
  AND g.month = to_char(now() AT TIME ZONE 'UTC' + interval '8 hours', 'YYYYMM')
ON CONFLICT (user_id, month) DO NOTHING;

-- 开通态:有流水(即入过账)的用户即为已开通。
UPDATE users SET balance_activated_at = now()
WHERE balance_activated_at IS NULL
  AND EXISTS (SELECT 1 FROM balance_ledger l WHERE l.user_id = users.id);
