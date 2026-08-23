CREATE TABLE mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'stdio',   -- http|stdio
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  env TEXT NOT NULL DEFAULT '{}',            -- JSON,敏感值 AES-GCM 加密
  headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE TABLE mcp_config_downloads (          -- 凭证拉取审计(防批量导出)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mcp_id INTEGER NOT NULL REFERENCES mcp_servers(id),
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_downloads_user ON mcp_config_downloads(user_id, created_at);
-- 无 mcp_server_grants 表:管理员只上架/配置,员工自选安装(企业内可信环境)
