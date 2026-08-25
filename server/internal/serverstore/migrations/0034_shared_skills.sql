-- 0034: 共享技能(员工本地 skill 上传 → 管理员审核 → 全员共享,多版本并存)。
-- 与 agent_presets(0032) 同模型,区别:UNIQUE(name, version) 允许同一技能多个已审核版本,
-- 客户端按版本号提示更新;status 状态机同 agentshare(pending → approved | rejected)。
CREATE TABLE shared_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime')),
  UNIQUE(name, version)
);
CREATE INDEX IF NOT EXISTS idx_shared_skills_name ON shared_skills(name);
CREATE INDEX IF NOT EXISTS idx_shared_skills_status ON shared_skills(status);
