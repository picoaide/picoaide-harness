-- 0054: 把三张旧表回填进统一应用模型(apps / app_releases / app_grants)。
-- 顺序: 先建 App 身份,再灌 Release,最后合并授权。
-- 旧表在兼容期内保留(只读备份),P5 再下线——回填失败不会丢数据。
--
-- 语义映射:
--   skills(市场)        → kind=skill, channel=market, release.status=approved
--                         (市场由管理员上架,等价于已审核通过)
--   shared_skills(组织) → kind=skill, channel=org,   release.status 原样保留
--   agent_presets(组织) → kind=agent, channel=org,   release.status 原样保留
--   App.title/owner 取「展示版本」的值: 组织库取最新一行,市场取该行本身。

-- ---- 1) App 身份 ----
INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled, created_at, updated_at)
SELECT 'skill', s.name, COALESCE(NULLIF(s.display_name, ''), s.name), s.description,
       s.author, 'market', s.enabled, s.created_at, s.updated_at
FROM skills s
ON CONFLICT (kind, app_id) DO NOTHING;

-- 组织共享技能:同名多版本归并为一个 App,元数据取 created_at 最新的一行。
INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled, created_at, updated_at)
SELECT 'skill', t.name, COALESCE(NULLIF(t.display_name, ''), t.name), t.description,
       t.author, 'org', 1, t.created_at, t.updated_at
FROM (
  SELECT DISTINCT ON (name) name, display_name, description, author, created_at, updated_at
  FROM shared_skills ORDER BY name, created_at DESC
) t
ON CONFLICT (kind, app_id) DO NOTHING;

INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled, created_at, updated_at)
SELECT 'agent', t.name, COALESCE(NULLIF(t.display_name, ''), t.name), t.description,
       t.author, 'org', 1, t.created_at, t.updated_at
FROM (
  SELECT DISTINCT ON (name) name, display_name, description, author, created_at, updated_at
  FROM agent_presets ORDER BY name, created_at DESC
) t
ON CONFLICT (kind, app_id) DO NOTHING;

-- ---- 2) Release 版本快照 ----
INSERT INTO app_releases (kind, app_id, version, title, description, author, publisher,
                          checksum, size, archive, status, downloads, calls, created_at, updated_at)
SELECT 'skill', s.name, s.version, COALESCE(NULLIF(s.display_name, ''), s.name), s.description,
       s.author, s.author, s.checksum, COALESCE(octet_length(s.archive), 0), s.archive,
       'approved', s.downloads, s.calls, s.created_at, s.updated_at
FROM skills s
ON CONFLICT (kind, app_id, version) DO NOTHING;

INSERT INTO app_releases (kind, app_id, version, title, description, author, publisher,
                          checksum, size, archive, status, reason, quality, downloads, calls,
                          created_at, updated_at)
SELECT 'skill', s.name, s.version, COALESCE(NULLIF(s.display_name, ''), s.name), s.description,
       s.author, s.author, s.checksum, COALESCE(octet_length(s.archive), 0), s.archive,
       s.status, s.reason, s.quality, s.downloads, s.calls, s.created_at, s.updated_at
FROM shared_skills s
ON CONFLICT (kind, app_id, version) DO NOTHING;

INSERT INTO app_releases (kind, app_id, version, title, description, author, publisher,
                          checksum, size, archive, status, reason, quality, downloads,
                          created_at, updated_at)
SELECT 'agent', p.name, p.version, COALESCE(NULLIF(p.display_name, ''), p.name), p.description,
       p.author, p.author, p.checksum, COALESCE(octet_length(p.archive), 0), p.archive,
       p.status, p.reason, p.quality, p.downloads, p.created_at, p.updated_at
FROM agent_presets p
ON CONFLICT (kind, app_id, version) DO NOTHING;

-- ---- 3) 授权 ----
INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
SELECT 'skill', g.skill_name, g.grantee_type, g.grantee FROM skill_grants g
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind='skill' AND a.app_id=g.skill_name)
ON CONFLICT DO NOTHING;

INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
SELECT 'skill', g.skill_name, g.grantee_type, g.grantee FROM shared_skill_grants g
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind='skill' AND a.app_id=g.skill_name)
ON CONFLICT DO NOTHING;

INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
SELECT 'agent', g.preset_name, g.grantee_type, g.grantee FROM agent_preset_grants g
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind='agent' AND a.app_id=g.preset_name)
ON CONFLICT DO NOTHING;
