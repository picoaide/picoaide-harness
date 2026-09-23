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
--
-- 「同名不同源」的归并规则(2026-09-23 修,P1 静默丢数据;规则是**确定性**的):
--   统一模型的身份键是 **apps.PRIMARY KEY (kind, app_id)**(0053),**不含 channel**
--   ⇒ 同一个 kind 下,市场与组织**不可能各有一行同名 App**;产品规则也是
--   "跨渠道同名 = 409 NAME_TAKEN"(appstore.Publish,2026-09-02 起)。
--   由此三条规则(改这里之前先读 0055 的自检,两者是同一个不变量):
--     1. 市场行**占名**:它先插入,拿到 (kind, name) 这一身份;
--     2. 组织行**绝不并入市场 App**:`ON CONFLICT DO NOTHING` 之外,Release 与授权
--        的插入都要求目标 App 确为 channel='org' —— 否则组织版本会挂到市场 App 下
--        (归属错配 + 组织内容继承市场可见性),组织授权也会落到市场 App 上;
--     3. 于是冲突本身无法在统一模型里表示,**不猜也不丢**:本迁移只发 WARNING 点名
--        冲突清单(便于审计),0055 在 DROP 旧表之前 fail-loud 中止升级并给出处置
--        指引 —— 旧表原样保留,可以恢复。
--   (注:任务书示例的"组织行以 channel='org' 单独建 app 行"在 (kind, app_id) 主键
--    下**结构上不可实现**;要支持跨渠道同名必须改主键与全部按 app_id 寻址的接口,
--    那是独立的产品决策,不在本修复范围内。)

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
-- 只在 App 身份确实归组织(channel='org')时才挂 Release:同名被市场行占名时,
-- 挂到市场 App 下就是归属错配(见文件头规则 2)。0055 的自检会把这种行点名。
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind = 'skill' AND a.app_id = s.name AND a.channel = 'org')
ON CONFLICT (kind, app_id, version) DO NOTHING;

INSERT INTO app_releases (kind, app_id, version, title, description, author, publisher,
                          checksum, size, archive, status, reason, quality, downloads,
                          created_at, updated_at)
SELECT 'agent', p.name, p.version, COALESCE(NULLIF(p.display_name, ''), p.name), p.description,
       p.author, p.author, p.checksum, COALESCE(octet_length(p.archive), 0), p.archive,
       p.status, p.reason, p.quality, p.downloads, p.created_at, p.updated_at
FROM agent_presets p
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind = 'agent' AND a.app_id = p.name AND a.channel = 'org')
ON CONFLICT (kind, app_id, version) DO NOTHING;

-- ---- 3) 授权 ----
-- 授权同样按**归属通道**插入:授权表只有 (name, grantee) 两列,身份全部来自 App 行;
-- 让组织授权落到市场 App 上等于把"组织内授权可见"的东西变成"市场可见"。
INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
SELECT 'skill', g.skill_name, g.grantee_type, g.grantee FROM skill_grants g
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind='skill' AND a.app_id=g.skill_name AND a.channel='market')
ON CONFLICT DO NOTHING;

INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
SELECT 'skill', g.skill_name, g.grantee_type, g.grantee FROM shared_skill_grants g
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind='skill' AND a.app_id=g.skill_name AND a.channel='org')
ON CONFLICT DO NOTHING;

INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
SELECT 'agent', g.preset_name, g.grantee_type, g.grantee FROM agent_preset_grants g
WHERE EXISTS (SELECT 1 FROM apps a WHERE a.kind='agent' AND a.app_id=g.preset_name AND a.channel='org')
ON CONFLICT DO NOTHING;

-- ---- 4) 冲突点名(WARNING,不中止) ----
-- 跨源同名(市场 skills 与组织 shared_skills 同名)在统一模型里没有合法表示:
-- 组织行不会进 apps/app_releases/app_grants(见文件头规则 2/3)。这里把清单写进
-- 迁移日志便于审计;真正拦住升级的是 0055 的 fail-loud 自检(DROP 之前)。
DO $apps_backfill_conflict_report$
DECLARE
  v_n BIGINT;
  v_list TEXT;
BEGIN
  IF to_regclass('public.skills') IS NULL OR to_regclass('public.shared_skills') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(DISTINCT s.name) INTO v_n FROM skills s JOIN shared_skills o ON o.name = s.name;
  IF v_n > 0 THEN
    SELECT string_agg(x.name, ', ' ORDER BY x.name) INTO v_list
      FROM (SELECT DISTINCT s.name FROM skills s
              JOIN shared_skills o ON o.name = s.name
             ORDER BY s.name LIMIT 20) x;
    RAISE WARNING '0054: 检测到 % 个跨源同名技能(市场 skills 与组织 shared_skills):%(最多列 20 个);组织行不会并入市场 App,0055 会在 DROP 旧表之前中止升级并给出处置指引',
      v_n, COALESCE(NULLIF(v_list, ''), '');
  END IF;
END
$apps_backfill_conflict_report$;
