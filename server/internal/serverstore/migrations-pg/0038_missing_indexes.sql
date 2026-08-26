-- 0038: 缺失索引补全(对齐 SQLite 0038,基于 EXPLAIN 审计)。
-- 审计发现(2026-08-26):
--   1. skill_grants / shared_skill_grants / agent_preset_grants 的
--      AccessibleSkillNames / AccessibleSharedResourceNames 查询:
--      WHERE (grantee_type = 'user' AND grantee = ?) OR (grantee_type =
--      'group' AND LOWER(grantee) = LOWER(?)) —— 权限热路径(每次请求),
--      现有 PK 是 (resource, grantee_type, grantee),grantee 非前缀无法使用
--      → 全表扫描。需 (grantee_type, grantee) 复合索引。
--   2. admin_sessions.expires_at —— CreateAdminSession 每次登录执行
--      DELETE WHERE expires_at < ?(C-15 防会话表失控增长),无索引全表扫。
--   3. shared_skills / agent_presets 的 WHERE author=? AND status=?
--      (上传配额检查/待审列表),现有仅 status 单列索引,需 (author, status)。
-- 全部幂等(CREATE INDEX IF NOT EXISTS),纯增量不重建表。
CREATE INDEX IF NOT EXISTS idx_skill_grants_grantee ON skill_grants(grantee_type, grantee);
CREATE INDEX IF NOT EXISTS idx_shared_grants_grantee ON shared_skill_grants(grantee_type, grantee);
CREATE INDEX IF NOT EXISTS idx_agent_grants_grantee ON agent_preset_grants(grantee_type, grantee);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_shared_skills_author_status ON shared_skills(author, status);
CREATE INDEX IF NOT EXISTS idx_agent_presets_author_status ON agent_presets(author, status);
