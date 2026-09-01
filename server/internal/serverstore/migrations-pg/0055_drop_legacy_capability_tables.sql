-- 0055: 下线统一应用模型之前的六张旧表(P5)。
-- 前置(2026-09-01 已核实):
--   * 0053/0054 已把 skills / shared_skills / agent_presets 及三张授权表
--     完整回填进 apps / app_releases / app_grants(生产核对 30/30/30);
--   * 全部读写已切到统一模型,生产代码对旧表零引用
--     (最后一处遗漏是 departments.go 的删除守卫仍在数 agent_preset_grants,
--      本次一并修正为统计 app_grants);
--   * 目标机保留了下线前的 pg_dump 备份(/tmp/pre-p2-backup.sql)。
-- 顺序:先删授权表(无外键依赖),再删主体表。
DROP TABLE IF EXISTS skill_grants;
DROP TABLE IF EXISTS shared_skill_grants;
DROP TABLE IF EXISTS agent_preset_grants;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS shared_skills;
DROP TABLE IF EXISTS agent_presets;
