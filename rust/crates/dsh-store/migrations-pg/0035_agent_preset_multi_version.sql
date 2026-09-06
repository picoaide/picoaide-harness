-- 0035: Agent 预设多版本化(与 shared_skills(0034) 对齐)。
-- 现有 agent_presets 是 name UNIQUE(单版本);改为 name+version 复合唯一。
-- PG 可用 ALTER 一次完成:原 UNIQUE(name) 约束名未知,先删表重建更稳妥
-- (表无外键引用,agent_presets 为独立审核表)。
CREATE TABLE agent_presets_new (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, version)
);
INSERT INTO agent_presets_new (id, name, display_name, version, description, author, checksum, status, reason, created_at, updated_at)
  SELECT id, name, display_name, version, description, author, checksum, status, reason, created_at, updated_at FROM agent_presets;
DROP TABLE agent_presets;
ALTER TABLE agent_presets_new RENAME TO agent_presets;
CREATE INDEX IF NOT EXISTS idx_agent_presets_name ON agent_presets(name);
CREATE INDEX IF NOT EXISTS idx_agent_presets_status ON agent_presets(status);
