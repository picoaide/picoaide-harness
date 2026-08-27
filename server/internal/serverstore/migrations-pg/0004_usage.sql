-- usage: 按月原生分区主表(PG 2026-08 起;分区由 ensureUsagePartition 自动建)。
-- 原 0004 创建普通表,0039 起改为分区结构:PK 必须含分区列 created_at;
-- PG16 在主表建索引会自动传播到已有/新建分区。
CREATE TABLE IF NOT EXISTS usage (
  id BIGSERIAL NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_usage_user_time ON usage(user_id, created_at);
