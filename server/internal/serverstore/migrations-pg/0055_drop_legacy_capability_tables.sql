-- 0055: 下线统一应用模型之前的六张旧表(P5)。
-- 前置(2026-09-01 已核实):
--   * 0053/0054 已把 skills / shared_skills / agent_presets 及三张授权表
--     完整回填进 apps / app_releases / app_grants(生产核对 30/30/30);
--   * 全部读写已切到统一模型,生产代码对旧表零引用
--     (最后一处遗漏是 departments.go 的删除守卫仍在数 agent_preset_grants,
--      本次一并修正为统计 app_grants);
--   * 目标机保留了下线前的 pg_dump 备份(/tmp/pre-p2-backup.sql)。
--
-- 数据安全(2026-09-23 修,P1 静默丢数据 —— 独立审计用真实载荷复现):
--   上面那句"生产核对 30/30/30"是**人工一次性核对**,不是判据;而 0054 的
--   `ON CONFLICT DO NOTHING` 在「同名不同源」时会静默丢数据:
--     * 市场 skills 与组织 shared_skills 同名**同版本** ⇒ 组织 release 被丢弃;
--     * 同名**不同版本** ⇒ 组织 release 挂到 channel='market' 的 App 下(归属错配);
--     * 组织授权并进市场 App(授权语义错配);
--   本迁移原先**没有任何自检**就 DROP 六张表 ⇒ 以上内容**永久丢失、无法恢复**。
--
--   现在:DROP 之前逐行比对源表与目标表 —— 每张源表的 (name, version, archive)
--   必须逐行出现在统一模型里,且挂在**同源通道**的 App 下(kind + channel 唯一
--   确定来源:market ← skills,org ← shared_skills/agent_presets);三张授权表
--   (name, grantee_type, grantee) 同样逐行比对,并按同一通道归属判定。
--   任何不一致即 RAISE EXCEPTION **中止升级**并点名冲突清单 —— 宁可挡住
--   (旧表原样保留、数据可恢复),也不要静默丢。
--
--   处置指引(解决后重启即继续:本迁移幂等、可重放,源表还在时自检会重跑):
--     A. 明确接受丢失(可审计):删掉冲突的组织行,例如
--        DELETE FROM shared_skills WHERE name = '<冲突名>' AND version = '<版本>';
--        (连同 shared_skill_grants 里同名行一起删)
--     B. 两份都保留:在旧表里给组织行改名(例如 name = '<冲突名>-org'),并把该行
--        **手工**补进统一模型(apps / app_releases / app_grants 三处的 app_id
--        用新名字、channel='org'),再重启。
--
-- 顺序:先删授权表(无外键依赖),再删主体表。

-- ---- 0. 回填完整性自检(fail-loud) ----
DO $capability_backfill_selfcheck$
DECLARE
  v_report TEXT := '';
  v_checked INTEGER := 0;
  v_src BIGINT;
  v_dst BIGINT;
  v_n BIGINT;
  v_list TEXT;
BEGIN
  -- ---- ① 市场技能 skills → app_releases(kind='skill' AND channel='market') ----
  IF to_regclass('public.skills') IS NOT NULL THEN
    v_checked := v_checked + 1;
    SELECT count(*) INTO v_src FROM skills;
    SELECT count(*) INTO v_dst FROM app_releases r
      JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
     WHERE r.kind = 'skill' AND a.channel = 'market';
    IF v_src <> v_dst THEN
      v_report := v_report || format(E'\n  [skills] 计数不一致: 源 %s 行, 目标(market) %s 行', v_src, v_dst);
    END IF;
    SELECT COALESCE(max(m.total), 0), string_agg(m.line, E'\n    ' ORDER BY m.line) INTO v_n, v_list
      FROM (
        SELECT format('%s@%s (archive sha256=%s)', s.name, s.version,
                      COALESCE(encode(sha256(s.archive), 'hex'), '<NULL>')) AS line,
               count(*) OVER () AS total
          FROM skills s
         WHERE NOT EXISTS (SELECT 1 FROM app_releases r
                             JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
                            WHERE r.kind = 'skill' AND a.channel = 'market'
                              AND r.app_id = s.name AND r.version = s.version
                              AND r.archive IS NOT DISTINCT FROM s.archive)
         ORDER BY s.name, s.version
         LIMIT 20) m;
    IF v_n > 0 THEN
      v_report := v_report || format(E'\n  [skills] %s 行缺失或挂到了非 market 通道:\n    %s', v_n, v_list);
    END IF;
  END IF;

  -- ---- ② 组织技能 shared_skills → app_releases(kind='skill' AND channel='org') ----
  -- 这里的失败绝大多数就是「同名不同源」:市场行占名,组织行落不下来。
  IF to_regclass('public.shared_skills') IS NOT NULL THEN
    v_checked := v_checked + 1;
    SELECT count(*) INTO v_src FROM shared_skills;
    SELECT count(*) INTO v_dst FROM app_releases r
      JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
     WHERE r.kind = 'skill' AND a.channel = 'org';
    IF v_src <> v_dst THEN
      v_report := v_report || format(E'\n  [shared_skills] 计数不一致: 源 %s 行, 目标(org) %s 行', v_src, v_dst);
    END IF;
    SELECT COALESCE(max(m.total), 0), string_agg(m.line, E'\n    ' ORDER BY m.line) INTO v_n, v_list
      FROM (
        SELECT format('%s@%s (archive sha256=%s)', s.name, s.version,
                      COALESCE(encode(sha256(s.archive), 'hex'), '<NULL>')) AS line,
               count(*) OVER () AS total
          FROM shared_skills s
         WHERE NOT EXISTS (SELECT 1 FROM app_releases r
                             JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
                            WHERE r.kind = 'skill' AND a.channel = 'org'
                              AND r.app_id = s.name AND r.version = s.version
                              AND r.archive IS NOT DISTINCT FROM s.archive)
         ORDER BY s.name, s.version
         LIMIT 20) m;
    IF v_n > 0 THEN
      v_report := v_report || format(E'\n  [shared_skills] %s 行缺失或挂到了非 org 通道(常因市场同名占名):\n    %s', v_n, v_list);
    END IF;
  END IF;

  -- ---- ③ 组织智能体 agent_presets → app_releases(kind='agent' AND channel='org') ----
  IF to_regclass('public.agent_presets') IS NOT NULL THEN
    v_checked := v_checked + 1;
    SELECT count(*) INTO v_src FROM agent_presets;
    SELECT count(*) INTO v_dst FROM app_releases r
      JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
     WHERE r.kind = 'agent' AND a.channel = 'org';
    IF v_src <> v_dst THEN
      v_report := v_report || format(E'\n  [agent_presets] 计数不一致: 源 %s 行, 目标(org) %s 行', v_src, v_dst);
    END IF;
    SELECT COALESCE(max(m.total), 0), string_agg(m.line, E'\n    ' ORDER BY m.line) INTO v_n, v_list
      FROM (
        SELECT format('%s@%s (archive sha256=%s)', p.name, p.version,
                      COALESCE(encode(sha256(p.archive), 'hex'), '<NULL>')) AS line,
               count(*) OVER () AS total
          FROM agent_presets p
         WHERE NOT EXISTS (SELECT 1 FROM app_releases r
                             JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
                            WHERE r.kind = 'agent' AND a.channel = 'org'
                              AND r.app_id = p.name AND r.version = p.version
                              AND r.archive IS NOT DISTINCT FROM p.archive)
         ORDER BY p.name, p.version
         LIMIT 20) m;
    IF v_n > 0 THEN
      v_report := v_report || format(E'\n  [agent_presets] %s 行缺失或挂到了非 org 通道:\n    %s', v_n, v_list);
    END IF;
  END IF;

  -- ---- ④ 市场技能授权 skill_grants → app_grants(kind='skill' AND channel='market') ----
  IF to_regclass('public.skill_grants') IS NOT NULL THEN
    v_checked := v_checked + 1;
    SELECT count(*) INTO v_src FROM skill_grants;
    SELECT count(*) INTO v_dst FROM app_grants ag
      JOIN apps a ON a.kind = ag.kind AND a.app_id = ag.app_id
     WHERE ag.kind = 'skill' AND a.channel = 'market';
    IF v_src <> v_dst THEN
      v_report := v_report || format(E'\n  [skill_grants] 计数不一致: 源 %s 行, 目标(market) %s 行', v_src, v_dst);
    END IF;
    SELECT COALESCE(max(m.total), 0), string_agg(m.line, E'\n    ' ORDER BY m.line) INTO v_n, v_list
      FROM (
        SELECT format('%s → %s:%s', g.skill_name, g.grantee_type, g.grantee) AS line,
               count(*) OVER () AS total
          FROM skill_grants g
         WHERE NOT EXISTS (SELECT 1 FROM app_grants ag
                             JOIN apps a ON a.kind = ag.kind AND a.app_id = ag.app_id
                            WHERE ag.kind = 'skill' AND a.channel = 'market'
                              AND ag.app_id = g.skill_name
                              AND ag.grantee_type = g.grantee_type AND ag.grantee = g.grantee)
         ORDER BY g.skill_name, g.grantee_type, g.grantee
         LIMIT 20) m;
    IF v_n > 0 THEN
      v_report := v_report || format(E'\n  [skill_grants] %s 行授权缺失或挂到了非 market 通道:\n    %s', v_n, v_list);
    END IF;
  END IF;

  -- ---- ⑤ 组织技能授权 shared_skill_grants → app_grants(kind='skill' AND channel='org') ----
  IF to_regclass('public.shared_skill_grants') IS NOT NULL THEN
    v_checked := v_checked + 1;
    SELECT count(*) INTO v_src FROM shared_skill_grants;
    SELECT count(*) INTO v_dst FROM app_grants ag
      JOIN apps a ON a.kind = ag.kind AND a.app_id = ag.app_id
     WHERE ag.kind = 'skill' AND a.channel = 'org';
    IF v_src <> v_dst THEN
      v_report := v_report || format(E'\n  [shared_skill_grants] 计数不一致: 源 %s 行, 目标(org) %s 行', v_src, v_dst);
    END IF;
    SELECT COALESCE(max(m.total), 0), string_agg(m.line, E'\n    ' ORDER BY m.line) INTO v_n, v_list
      FROM (
        SELECT format('%s → %s:%s', g.skill_name, g.grantee_type, g.grantee) AS line,
               count(*) OVER () AS total
          FROM shared_skill_grants g
         WHERE NOT EXISTS (SELECT 1 FROM app_grants ag
                             JOIN apps a ON a.kind = ag.kind AND a.app_id = ag.app_id
                            WHERE ag.kind = 'skill' AND a.channel = 'org'
                              AND ag.app_id = g.skill_name
                              AND ag.grantee_type = g.grantee_type AND ag.grantee = g.grantee)
         ORDER BY g.skill_name, g.grantee_type, g.grantee
         LIMIT 20) m;
    IF v_n > 0 THEN
      v_report := v_report || format(E'\n  [shared_skill_grants] %s 行授权缺失或挂到了非 org 通道:\n    %s', v_n, v_list);
    END IF;
  END IF;

  -- ---- ⑥ 组织智能体授权 agent_preset_grants → app_grants(kind='agent' AND channel='org') ----
  IF to_regclass('public.agent_preset_grants') IS NOT NULL THEN
    v_checked := v_checked + 1;
    SELECT count(*) INTO v_src FROM agent_preset_grants;
    SELECT count(*) INTO v_dst FROM app_grants ag
      JOIN apps a ON a.kind = ag.kind AND a.app_id = ag.app_id
     WHERE ag.kind = 'agent' AND a.channel = 'org';
    IF v_src <> v_dst THEN
      v_report := v_report || format(E'\n  [agent_preset_grants] 计数不一致: 源 %s 行, 目标(org) %s 行', v_src, v_dst);
    END IF;
    SELECT COALESCE(max(m.total), 0), string_agg(m.line, E'\n    ' ORDER BY m.line) INTO v_n, v_list
      FROM (
        SELECT format('%s → %s:%s', g.preset_name, g.grantee_type, g.grantee) AS line,
               count(*) OVER () AS total
          FROM agent_preset_grants g
         WHERE NOT EXISTS (SELECT 1 FROM app_grants ag
                             JOIN apps a ON a.kind = ag.kind AND a.app_id = ag.app_id
                            WHERE ag.kind = 'agent' AND a.channel = 'org'
                              AND ag.app_id = g.preset_name
                              AND ag.grantee_type = g.grantee_type AND ag.grantee = g.grantee)
         ORDER BY g.preset_name, g.grantee_type, g.grantee
         LIMIT 20) m;
    IF v_n > 0 THEN
      v_report := v_report || format(E'\n  [agent_preset_grants] %s 行授权缺失或挂到了非 org 通道:\n    %s', v_n, v_list);
    END IF;
  END IF;

  IF v_report <> '' THEN
    RAISE EXCEPTION '0055: 回填自检失败 —— 现在 DROP 旧表会永久丢数据,升级已中止(六张旧表原样保留、可恢复)。按文件头的处置指引解决后重启即继续(本迁移幂等):%',
      v_report;
  END IF;
  IF v_checked = 0 THEN
    RAISE NOTICE '0055: 六张旧表都已不在(幂等重放),跳过回填自检';
  ELSE
    RAISE NOTICE '0055: 回填自检通过 —— % 张旧表的每一行都在统一模型里、且通道归属一致,可安全 DROP', v_checked;
  END IF;
END
$capability_backfill_selfcheck$;

DROP TABLE IF EXISTS skill_grants;
DROP TABLE IF EXISTS shared_skill_grants;
DROP TABLE IF EXISTS agent_preset_grants;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS shared_skills;
DROP TABLE IF EXISTS agent_presets;
