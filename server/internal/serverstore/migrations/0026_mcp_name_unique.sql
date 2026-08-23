-- 0026: mcp_servers.name 唯一约束(审计 A5-M9)。
--
-- 此前同名插件可重复上架:管理列表与凭证下载审计(mcp_name)无法区分同名行,
-- 创建冲突返回 INTERNAL 而非 VALIDATION。本迁移:
--   1. 把指向重复行的 mcp_grants / mcp_config_downloads 引用迁移到同名保留行
--      (每名取最小 id,审计记录不丢;孤儿引用一并删除);
--   2. 删除重复行;
--   3. 建唯一索引(重复已清,保证创建成功)。
--
-- 实现注意:旧版 1b 用"UPDATE downloads SET mcp_id = (子查询)"——SQLite 对
-- 自引用 UPDATE 的子查询读不到当前行(SET 值为 NULL),在启用外键时触发
-- FOREIGN KEY constraint failed(787)。改为先算好重定向映射再按明确值
-- UPDATE;孤儿记录(引用已不存在的插件)直接删除。

-- 1a. grants 引用迁移:先把重复行的授权复制到保留行(目标主键冲突时
--     INSERT OR IGNORE 防重),再删除指向重复行的旧授权 —— 否则删重复行时
--     残留的旧 grant 外键引用会触发 FOREIGN KEY constraint failed(787)。
INSERT OR IGNORE INTO mcp_grants (mcp_id, grantee_type, grantee)
SELECT keep.id, g.grantee_type, g.grantee
FROM mcp_servers keep
JOIN mcp_servers dup ON dup.name = keep.name AND dup.id != keep.id AND keep.id < dup.id
JOIN mcp_grants g ON g.mcp_id = dup.id;

DELETE FROM mcp_grants
WHERE mcp_id IN (
  SELECT id FROM mcp_servers s
  WHERE s.id > (SELECT MIN(id) FROM mcp_servers WHERE name = s.name));

-- 1b. downloads 引用迁移:先算映射(避免自引用 UPDATE 的 NULL 陷阱),
--     保留行 id → 该名字最小 id;孤儿(源行不存在)删除。
CREATE TEMP TABLE _mcp_dl_redirect AS
SELECT d.id AS dl_id, MIN(s.id) AS keep_id
FROM mcp_config_downloads d
JOIN mcp_servers s ON s.name = (SELECT name FROM mcp_servers WHERE id = d.mcp_id)
GROUP BY d.id;

UPDATE mcp_config_downloads
SET mcp_id = (SELECT keep_id FROM _mcp_dl_redirect WHERE dl_id = mcp_config_downloads.id)
WHERE id IN (SELECT dl_id FROM _mcp_dl_redirect);

DELETE FROM mcp_config_downloads
WHERE id NOT IN (SELECT dl_id FROM _mcp_dl_redirect);

DROP TABLE _mcp_dl_redirect;

-- 2. 删除重复行(保留每名最小 id 的一行)。先算出待删 id 再按明确值删除:
--    SQLite 对"DELETE 子查询引用同一被删表"会触发 FOREIGN KEY constraint
--    failed(787)——即便实际无引用残留;改用预计算的 id 列表规避。
DELETE FROM mcp_servers
WHERE id IN (
  SELECT id FROM mcp_servers s
  WHERE s.id > (SELECT MIN(id) FROM mcp_servers WHERE name = s.name));

-- 3. 唯一索引(此后 AddMCPServer 重名触发 UNIQUE → ErrDuplicate → VALIDATION)
CREATE UNIQUE INDEX idx_mcp_servers_name ON mcp_servers(name);
