-- 0035: Agent 预设多版本化(与 shared_skills(0034) 对齐)。
-- 现有 agent_presets 是 name UNIQUE(单版本);改为 name+version 复合唯一,
-- 允许同一预设多个已审核版本,客户端按版本号提示更新。
-- 因 SQLite 不能直接改 UNIQUE 约束,重建表并迁移数据(version 保留原值)。
-- 旧行 version 均 '1.0.0';display_name/description/checksum/reason 全保留。
CREATE TABLE agent_presets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime')),
  UNIQUE(name, version)
);
INSERT INTO agent_presets_new (id, name, display_name, version, description, author, checksum, status, reason, created_at, updated_at)
  SELECT id, name, display_name, version, description, author, checksum, status, reason, created_at, updated_at FROM agent_presets;
DROP TABLE agent_presets;
ALTER TABLE agent_presets_new RENAME TO agent_presets;
CREATE INDEX IF NOT EXISTS idx_agent_presets_name ON agent_presets(name);
CREATE INDEX IF NOT EXISTS idx_agent_presets_status ON agent_presets(status);
