-- 模型名唯一改为按 provider 维度(跨 provider 允许同名模型)。
-- PG 无需 create-new-copy 重建(无 SQLite AUTOINCREMENT 迁移问题):
-- 直接去掉 0003 建立的全局唯一约束 models_name_key,改为 (provider_id, name) 复合唯一。
ALTER TABLE models DROP CONSTRAINT IF EXISTS models_name_key;
ALTER TABLE models ADD CONSTRAINT models_provider_name_key UNIQUE (provider_id, name);
