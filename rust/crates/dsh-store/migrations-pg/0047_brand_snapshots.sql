-- 0047: 品牌快照(设计 v3b 2026-09-04)。
-- 每次 brand_update 保存前一版配置 JSON, 供「恢复上一版本」;
-- 保留最近 10 份(写入时应用层裁剪)。
CREATE TABLE brand_snapshots (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data TEXT NOT NULL
);
