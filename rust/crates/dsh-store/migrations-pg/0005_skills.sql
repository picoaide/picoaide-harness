CREATE TABLE skills (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  git_url TEXT NOT NULL,
  git_ref TEXT NOT NULL DEFAULT 'main',
  checksum TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,       -- 下架置 0(不删行,bootstrap 建议清单过滤)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
