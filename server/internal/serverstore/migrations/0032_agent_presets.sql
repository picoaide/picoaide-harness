-- 0032: 共享 Agent 预设(员工创造模式上传 → 管理员审核 → 全员共享)。
-- 状态机 pending → approved | rejected;approved = 全员可见可下载(无 grants 表)。
-- name = preset 目录名(上游 PRESET_ID 规则);checksum = 上传归档 sha256;
-- author = 上传者 username;rejected 行保留供同名重提覆盖。
CREATE TABLE agent_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  author TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_agent_presets_status ON agent_presets(status);
