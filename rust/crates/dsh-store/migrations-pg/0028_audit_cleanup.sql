-- 0028: 知识库与 MCP 功能下线清理。
-- 1) 审计日志表独立更名:kb_audit_logs → audit_logs(用户/部门/技能等敏感
--    操作审计继续保留,知识库/MCP 操作标签随功能删除)。
-- 2) 删除全部知识库(0008/0012/0013/0014/0015)与 MCP(0006/0026)表。
-- 新库先建一张空的 kb_audit_logs(与旧库同构)以确保无条件搬迁语句可编译,
-- 随后统一 DROP;旧库表已存在时 CREATE IF NOT EXISTS 跳过,数据完整搬入。
-- 子表先删,避免 FK 下 DROP TABLE 失败(mcp_config_downloads → mcp_servers;
-- kb_chunks → kb_documents)。
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kb_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO audit_logs (id, username, action, detail, created_at)
  SELECT id, username, action, detail, created_at FROM kb_audit_logs
  ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS kb_chunk_embeddings;
DROP TABLE IF EXISTS kb_chunks_fts;
DROP TABLE IF EXISTS kb_chunks;
DROP TABLE IF EXISTS kb_documents;
DROP TABLE IF EXISTS kb_folder_users;
DROP TABLE IF EXISTS kb_folder_groups;
DROP TABLE IF EXISTS kb_folders;
DROP TABLE IF EXISTS kb_fts_trigram;
DROP TABLE IF EXISTS kb_fts;
DROP TABLE IF EXISTS kb_audit_logs;
DROP TABLE IF EXISTS mcp_grants;
DROP TABLE IF EXISTS mcp_config_downloads;
DROP TABLE IF EXISTS mcp_servers;
