-- 0039: usage 按月原生分区 + 日/月记账本。
-- 背景(PG-only 2026-08):
--   usage 是最高写入频次表(每次 LLM 调用 1 行),无清理策略数据无限累积;
--   200 员工 × 2 万次/月 ≈ 240 万行/年。明细保留 N 个月(默认 6,可配),
--   按月份 DROP PARTITION 秒删;明细删除不影响永久账本(usage_daily/monthly)。
--
-- 结构:
--   usage         主表 PARTITION BY RANGE (created_at),按月分区 usage_YYYYMM
--                 (PK 含 created_at;PG16 建索引自动传播到分区)
--   usage_daily   日账 PARTITION BY RANGE (day),按年分区 usage_daily_YYYY
--                 UNIQUE(user_id, model, day) —— 永久保留,由账本任务生成
--   usage_monthly 月账 普通表 UNIQUE(user_id, model, month) —— 永久保留,
--                 由日账聚合生成(最终兜底)
--
-- 账本生成: serverstore.RebuildUsageLedger(from,to) 从 usage 明细 UPSERT
--   日账/月账(幂等);每日任务 + 启动补算调用。保留策略:
--   CleanupUsageRetention(settings usage.retention_months,0=永久) DROP 过期分区。
--
-- 老库升级: usage 已有数据(若有)由 Go 侧 ensureUsagePartition 按月份
--   迁入分区;本迁移只建结构(新库无数据,直接 CREATE)。

-- ---- 1. usage 分区主表 ----
CREATE TABLE IF NOT EXISTS usage (
  id BIGSERIAL NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL DEFAULT 'chat',
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 当前月分区(写路径由 ensureUsagePartition 幂等创建后续月)
CREATE TABLE IF NOT EXISTS usage_202608 PARTITION OF usage
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- 主表索引(PG16 传播到已有/新建分区)
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON usage(model, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage(kind);
CREATE INDEX IF NOT EXISTS idx_usage_user_cost ON usage(user_id, cost);

-- ---- 2. usage_daily 日账(按年分区,永久) ----
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  day DATE NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model, day)
) PARTITION BY RANGE (day);
CREATE TABLE IF NOT EXISTS usage_daily_2026 PARTITION OF usage_daily
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);

-- ---- 3. usage_monthly 月账(普通表,永久) ----
CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  month DATE NOT NULL,  -- 月初(YYYY-MM-01)
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model, month)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_month ON usage_monthly(month);
