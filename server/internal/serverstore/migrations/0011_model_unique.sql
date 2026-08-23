-- 模型名唯一改为按 provider 维度(跨 provider 允许同名模型)
CREATE TABLE models_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES gateway_providers(id),
  display_name TEXT,
  default_params TEXT NOT NULL DEFAULT '{}',
  UNIQUE (provider_id, name)
);
INSERT INTO models_new (id, name, provider_id, display_name, default_params)
  SELECT id, name, provider_id, display_name, default_params FROM models;
DROP TABLE models;
ALTER TABLE models_new RENAME TO models;
