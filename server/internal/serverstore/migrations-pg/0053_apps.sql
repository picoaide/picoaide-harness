-- 0053: 统一应用模型(apps / app_releases / app_grants)——决策
-- docs/decisions/2026-09-01-skill-app-management.md 的 P2。
--
-- 病根: 技能资产分散在三张语义不同的表里——
--   skills(市场,单版本原地覆盖,无审核) / shared_skills(组织,多版本+审核) /
--   agent_presets(组织智能体,多版本+审核),各自一套授权表与端点。
--   「市场技能没有版本历史、不能回滚」正是单版本模型的直接后果。
-- 目标模型: App(长期身份) + Release(不可变版本快照)。
--   * PK 为 (kind, app_id): 技能与智能体允许同名(能力中心一直以 {kind}:{name}
--     为复合键);同 kind 下 app_id 全局唯一,跨渠道互斥沿用既有语义。
--   * channel 是分发渠道(market/org),不再是三套数据模型。
--   * 审核状态在 Release 上: 市场发布(管理员)直接 approved,组织发布 pending。
--   * quality 保留在 Release 上(与现行 shared_skills/agent_presets 语义一致,
--     不在迁移里改变审核语义;App 级展示取其展示版本的 quality)。
--   * 锁定沿用 capability_locks(kind,name): 它要支持对**尚不存在**的名字预锁定,
--     不能依附 apps 行。
CREATE TABLE apps (
  kind        TEXT NOT NULL CHECK (kind IN ('skill','agent')),
  app_id      TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  owner       TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL CHECK (channel IN ('market','org')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, app_id)
);

CREATE TABLE app_releases (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  version     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  changelog   TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',   -- JSON 数组字符串
  author      TEXT NOT NULL DEFAULT '',   -- 包内署名
  publisher   TEXT NOT NULL DEFAULT '',   -- 发布账号(取自登录态,不可伪造)
  checksum    TEXT NOT NULL DEFAULT '',
  size        BIGINT NOT NULL DEFAULT 0,
  archive     BYTEA,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason      TEXT NOT NULL DEFAULT '',
  quality     TEXT NOT NULL DEFAULT '',
  downloads   BIGINT NOT NULL DEFAULT 0,
  calls       BIGINT NOT NULL DEFAULT 0,
  deleted_at  TIMESTAMPTZ,               -- 软删:版本号永久占用,不可复用
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, app_id, version),
  FOREIGN KEY (kind, app_id) REFERENCES apps(kind, app_id) ON DELETE CASCADE
);
CREATE INDEX idx_app_releases_app ON app_releases(kind, app_id);
CREATE INDEX idx_app_releases_status ON app_releases(status);

CREATE TABLE app_grants (
  kind         TEXT NOT NULL,
  app_id       TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
  grantee      TEXT NOT NULL,
  PRIMARY KEY (kind, app_id, grantee_type, grantee)
);
