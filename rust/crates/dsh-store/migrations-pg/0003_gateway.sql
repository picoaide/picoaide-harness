CREATE TABLE gateway_providers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  models TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE models (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES gateway_providers(id),
  display_name TEXT,
  default_params TEXT NOT NULL DEFAULT '{}'
);
