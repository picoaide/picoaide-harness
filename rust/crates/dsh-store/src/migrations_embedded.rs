// 自动生成：migrations-pg/*.sql 编译期嵌入。
// 请勿手工编辑。

use super::Migration;

pub fn all_migrations() -> Vec<Migration> {
    vec![
        Migration { version: 0001, name: "0001_init.sql".into(), sql: r#"CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  email TEXT,
  password_hash TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  is_admin INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_groups (
  user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"#.into() },
        Migration { version: 0002, name: "0002_tokens.sql".into(), sql: r#"CREATE TABLE api_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'desktop',
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tokens_user ON api_tokens(user_id);
"#.into() },
        Migration { version: 0003, name: "0003_gateway.sql".into(), sql: r#"CREATE TABLE gateway_providers (
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
"#.into() },
        Migration { version: 0004, name: "0004_usage.sql".into(), sql: r#"-- usage: 按月原生分区主表(PG 2026-08 起;分区由 ensureUsagePartition 自动建)。
-- 原 0004 创建普通表,0039 起改为分区结构:PK 必须含分区列 created_at;
-- PG16 在主表建索引会自动传播到已有/新建分区。
CREATE TABLE IF NOT EXISTS usage (
  id BIGSERIAL NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_usage_user_time ON usage(user_id, created_at);
"#.into() },
        Migration { version: 0005, name: "0005_skills.sql".into(), sql: r#"CREATE TABLE skills (
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
"#.into() },
        Migration { version: 0009, name: "0009_admin_session.sql".into(), sql: r#"CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
"#.into() },
        Migration { version: 0010, name: "0010_channel.sql".into(), sql: r#"ALTER TABLE gateway_providers ADD COLUMN channel TEXT NOT NULL DEFAULT '';
"#.into() },
        Migration { version: 0011, name: "0011_model_unique.sql".into(), sql: r#"-- 模型名唯一改为按 provider 维度(跨 provider 允许同名模型)。
-- PG 无需 create-new-copy 重建(无 SQLite AUTOINCREMENT 迁移问题):
-- 直接去掉 0003 建立的全局唯一约束 models_name_key,改为 (provider_id, name) 复合唯一。
ALTER TABLE models DROP CONSTRAINT IF EXISTS models_name_key;
ALTER TABLE models ADD CONSTRAINT models_provider_name_key UNIQUE (provider_id, name);
"#.into() },
        Migration { version: 0016, name: "0016_grants.sql".into(), sql: r#"-- 0016: skill grants (admin-authorized usage, strict default).
-- Subjects are usernames or group names (grantee_type disambiguates);
-- groups are resolved via the groups/user_groups tables at query time,
-- so revoking a grant (or LDAP group membership) takes effect immediately.
-- Admins are implicitly allowed everywhere and never need a grant row.
CREATE TABLE skill_grants (
  skill_name TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
  grantee TEXT NOT NULL,
  PRIMARY KEY(skill_name, grantee_type, grantee)
);
"#.into() },
        Migration { version: 0017, name: "0017_departments.sql".into(), sql: r#"-- 0017: groups 升级为部门实体(金字塔组织架构)。
-- parent_id 0 = 顶层部门;leader_id 引用 users.id(0 = 未设主管)。
-- 权限语义:授权给部门 X → X 及子部门成员可见(向下继承);
-- 用户有效组 = 归属部门 + 祖先链;部门主管额外获得其部门子树授权(向上兼容)。
ALTER TABLE groups ADD COLUMN parent_id INTEGER DEFAULT 0;
ALTER TABLE groups ADD COLUMN leader_id INTEGER DEFAULT 0;
ALTER TABLE groups ADD COLUMN description TEXT DEFAULT '';
CREATE INDEX idx_groups_parent ON groups(parent_id);
"#.into() },
        Migration { version: 0018, name: "0018_seed_everyone_group.sql".into(), sql: r#"-- 0018: seed the reserved implicit 全员 (everyone) group.
-- 全员 is the implicit "everyone" department: every user belongs to it and
-- grants to it cover all users (UserEffectiveGroups). CreateDepartment rejects
-- the name, so only the system can create this row; seeding here makes the
-- feature work on fresh installs (previously it only worked in tests that
-- inserted the row manually).
INSERT INTO groups (name)
SELECT '全员' WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = '全员');
"#.into() },
        Migration { version: 0019, name: "0019_groups_nocase_unique.sql".into(), sql: r#"-- 0019: groups.name uniqueness becomes case-insensitive.
-- The whole permission system treats group names as NOCASE (lookups, grant
-- resolution, rename cascade), but the UNIQUE constraint was BINARY — "Sales"
-- and "sales" could coexist, breaking checkbox UIs and NOCASE lookups that
-- pick an arbitrary row. PG 无 COLLATE NOCASE,改用函数唯一索引 LOWER(name)
-- 实现大小写不敏感唯一,无需 create-new-copy 重建(0017 已补全其余列);
-- idx_groups_parent 已由 0017 建立,此处不重建。
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_name_key;
CREATE UNIQUE INDEX idx_groups_name_nocase ON groups (LOWER(name));
"#.into() },
        Migration { version: 0020, name: "0020_usage_kind.sql".into(), sql: r#"-- 0020: usage rows carry a kind (chat | embedding) so pending-stream cleanup
-- only targets chat rows. Embedding rows legitimately record prompt_tokens>0
-- with completion_tokens=0, and rows whose upstream omitted usage are real
-- request counts — they must not be purged as stale stream pendings.
ALTER TABLE usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
"#.into() },
        Migration { version: 0021, name: "0021_user_quota.sql".into(), sql: r#"-- per-user monthly traffic quota in tokens:
--   NULL = follow the global default (settings 'usage.monthly_quota')
--   0    = unlimited (explicit)
--   >0   = capped at N tokens per calendar month
-- admins are always unlimited (enforced at the gateway, not stored here).
ALTER TABLE users ADD COLUMN quota_tokens BIGINT;
"#.into() },
        Migration { version: 0022, name: "0022_money_quota.sql".into(), sql: r#"-- 0022: money (cost) dimension for usage and per-user monthly money quota.
--
-- users.quota_money  (REAL, yuan per calendar month):
--   NULL = follow the global default (settings 'usage.monthly_quota_money')
--   0    = unlimited (explicit)
--   >0   = capped at N yuan per calendar month
-- admins are always unlimited (enforced at the gateway, not stored here).
--
-- models.input_price_per_1m / output_price_per_1m (REAL, yuan per 1M tokens):
--   NULL/0 = model not priced -> cost contributes 0 (page shows 未定价 hint).
--   embedding reuses input price (embedding rows have completion_tokens=0).
--
-- usage.cost (REAL, yuan): cost denormalized at record time so later price
--   edits / model deletion never rewrite history; money quota enforcement and
--   dashboards both read SUM(cost) — one consistent basis.
ALTER TABLE users ADD COLUMN quota_money DOUBLE PRECISION;
ALTER TABLE models ADD COLUMN input_price_per_1m DOUBLE PRECISION;
ALTER TABLE models ADD COLUMN output_price_per_1m DOUBLE PRECISION;
ALTER TABLE usage ADD COLUMN cost DOUBLE PRECISION NOT NULL DEFAULT 0;
"#.into() },
        Migration { version: 0023, name: "0023_offpeak_discount.sql".into(), sql: r#"-- 0023: per-model off-peak (谷时) discount for time-based pricing.
--
-- DeepSeek 官方错峰优惠:每日北京时间 16:30-00:30(即 UTC 08:30-16:30)
-- 按标准价的 50% 计费。为通用支持时段计价,模型级折扣率:
--   offpeak_discount REAL:
--     NULL = 无峰谷价(全天按标准价)
--     0 < d < 1 = 低谷窗口内费用 × d(DeepSeek 官方 = 0.5)
--     1 = 显式无折扣(等价 NULL,便于 UI 显式表达)
-- 费用在记录时按「请求时刻是否处于低谷窗口」折算并落库(0022 的 cost),
-- 窗口内请求用折扣价,窗口外用标准价;改折扣只影响之后产生的费用。
ALTER TABLE models ADD COLUMN offpeak_discount DOUBLE PRECISION;
"#.into() },
        Migration { version: 0024, name: "0024_dept_budget.sql".into(), sql: r#"-- 0024: department-level monthly money budget (部门月度金额预算,元)。
--
-- groups.budget_money REAL:
--   NULL = 无部门预算(不限)
--   >0   = 该部门树(含全部子部门)成员当月费用合计上限
--
-- 语义:员工预算链 = 归属部门 + 祖先链(不含主管子树 —— 主管向上兼容是
-- 授权/知识库语义,预算只约束归属链,否则部门预算可被主管绕过)。
-- 任一预算部门当月累计费用超限 → 该部门成员请求被网关 429 拦截。
-- 与 usage.cost(0022 记录时定价)同一口径:按部门聚合 SUM(cost)。
ALTER TABLE groups ADD COLUMN budget_money DOUBLE PRECISION;
"#.into() },
        Migration { version: 0025, name: "0025_usage_created_at_index.sql".into(), sql: r#"-- 0025: usage 表 created_at 单列索引。
-- UsageAggregate 的日期范围聚合(WHERE created_at >= ? AND created_at < ?)
-- 无法走既有复合索引 idx_usage_user_time(user_id 前缀),在数据量增长后
-- 退化为全表扫描;60s 轮询(≤7 天按日分组)会放大该开销(审计高3)。
-- 纯增量迁移,旧索引保留(员工月用量查询仍走 idx_usage_user_time)。
CREATE INDEX idx_usage_time ON usage(created_at);
"#.into() },
        Migration { version: 0027, name: "0027_user_groups_group_index.sql".into(), sql: r#"-- 0027: user_groups(group_id) 索引(审计 L3:N+1/全表扫治理)。
-- 部门成员统计/预算聚合(DeptMemberIDs/DeptMonthlyCostBatch)按 group_id
-- 查询 user_groups,此前无索引需全表扫;随部门与成员规模线性放大。
CREATE INDEX idx_user_groups_group ON user_groups(group_id);
"#.into() },
        Migration { version: 0028, name: "0028_audit_cleanup.sql".into(), sql: r#"-- 0028: 知识库与 MCP 功能下线清理。
-- 1) 审计日志表独立更名:kb_audit_logs → audit_logs(用户/部门/技能等敏感
--    操作审计继续保留,知识库/MCP 操作标签随功能删除)。
-- 2) 删除全部知识库(0008/0012/0013/0014/0015)与 MCP(0006/0026)表。
-- 新库先建一张空的 kb_audit_logs(与旧库同构)以确保无条件搬迁语句可编译,
-- 随后统一 DROP;旧库表已存在时 CREATE IF NOT EXISTS 跳过,数据完整搬入。
-- 子表先删,避免 FK 下 DROP TABLE 失败(mcp_config_downloads → mcp_servers;
-- kb_chunks → kb_documents)。
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kb_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO audit_logs (id, username, action, detail, created_at)
  SELECT id, username, action, detail, created_at FROM kb_audit_logs
  ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS kb_chunk_embeddings;
DROP TABLE IF EXISTS kb_chunks_fts;
DROP TABLE IF EXISTS kb_chunks;
DROP TABLE IF EXISTS kb_documents;
DROP TABLE IF EXISTS kb_folder_users;
DROP TABLE IF EXISTS kb_folder_groups;
DROP TABLE IF EXISTS kb_folders;
DROP TABLE IF EXISTS kb_fts_trigram;
DROP TABLE IF EXISTS kb_fts;
DROP TABLE IF EXISTS kb_audit_logs;
DROP TABLE IF EXISTS mcp_grants;
DROP TABLE IF EXISTS mcp_config_downloads;
DROP TABLE IF EXISTS mcp_servers;
"#.into() },
        Migration { version: 0029, name: "0029_model_cache_price.sql".into(), sql: r#"-- 0029: models 增加缓存命中输入价(元/百万 token)。
-- DeepSeek 等上游对命中缓存的输入 token 按更低单价计费;该列为定价参考字段,
-- nil = 未配置缓存价(计费仍按 input_price_per_1m),>0 = 缓存命中输入 token 单价。
ALTER TABLE models ADD COLUMN cache_input_price_per_1m DOUBLE PRECISION;
"#.into() },
        Migration { version: 0030, name: "0030_usage_cache_tokens.sql".into(), sql: r#"-- 0030: usage 增加缓存命中输入 token 数(DeepSeek 缓存计费)。
-- prompt_cache_hit_tokens = 上游返回的缓存命中输入 token;未配置时按 0 计,
-- 命中部分按 models.cache_input_price_per_1m(0029)计费,未配置则回退输入价。
ALTER TABLE usage ADD COLUMN cache_prompt_tokens BIGINT NOT NULL DEFAULT 0;
"#.into() },
        Migration { version: 0031, name: "0031_indexes.sql".into(), sql: r#"-- 0031: 生产查询索引优化(对齐 SQLite 0031)。
-- 基于真实查询模式(审计页筛选/90天清理/用量聚合)新增索引:
--   1. audit_logs 三列(操作者/操作类型/时间)— 审计页筛选 + 90 天清理全表扫
--   2. api_tokens.expires_at — 90 天过期清理
--   3. usage(model, created_at) — 按模型+时间统计
--   4. usage(kind) — chat/embedding 分类统计
--   5. usage(user_id, cost) — 用户维度费用聚合(配额/部门预算)
-- 全部幂等(CREATE INDEX IF NOT EXISTS),纯增量不重建表。
CREATE INDEX IF NOT EXISTS idx_audit_username ON audit_logs(username);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON api_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON usage(model, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage(kind);
CREATE INDEX IF NOT EXISTS idx_usage_user_cost ON usage(user_id, cost);
"#.into() },
        Migration { version: 0032, name: "0032_agent_presets.sql".into(), sql: r#"-- 0032: 共享 Agent 预设(员工创造模式上传 → 管理员审核 → 全员共享)。
-- 状态机 pending → approved | rejected;approved = 全员可见可下载(无 grants 表)。
-- name = preset 目录名(上游 PRESET_ID 规则);checksum = 上传归档 sha256;
-- author = 上传者 username;rejected 行保留供同名重提覆盖。
CREATE TABLE agent_presets (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  author TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_presets_status ON agent_presets(status);
"#.into() },
        Migration { version: 0033, name: "0033_agent_preset_reason.sql".into(), sql: r#"-- 0033: 共享 Agent 审核拒绝理由(管理员 reject 时记录,作者可见,重提时清空)。
ALTER TABLE agent_presets ADD COLUMN reason TEXT NOT NULL DEFAULT '';
"#.into() },
        Migration { version: 0034, name: "0034_shared_skills.sql".into(), sql: r#"-- 0034: 共享技能(员工本地 skill 上传 → 管理员审核 → 全员共享,多版本并存)。
-- 与 agent_presets(0032) 同模型,区别:UNIQUE(name, version) 允许同一技能多个已审核版本,
-- 客户端按版本号提示更新;status 状态机同 agentshare(pending → approved | rejected)。
CREATE TABLE shared_skills (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, version)
);
CREATE INDEX IF NOT EXISTS idx_shared_skills_name ON shared_skills(name);
CREATE INDEX IF NOT EXISTS idx_shared_skills_status ON shared_skills(status);
"#.into() },
        Migration { version: 0035, name: "0035_agent_preset_multi_version.sql".into(), sql: r#"-- 0035: Agent 预设多版本化(与 shared_skills(0034) 对齐)。
-- 现有 agent_presets 是 name UNIQUE(单版本);改为 name+version 复合唯一。
-- PG 可用 ALTER 一次完成:原 UNIQUE(name) 约束名未知,先删表重建更稳妥
-- (表无外键引用,agent_presets 为独立审核表)。
CREATE TABLE agent_presets_new (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, version)
);
INSERT INTO agent_presets_new (id, name, display_name, version, description, author, checksum, status, reason, created_at, updated_at)
  SELECT id, name, display_name, version, description, author, checksum, status, reason, created_at, updated_at FROM agent_presets;
DROP TABLE agent_presets;
ALTER TABLE agent_presets_new RENAME TO agent_presets;
CREATE INDEX IF NOT EXISTS idx_agent_presets_name ON agent_presets(name);
CREATE INDEX IF NOT EXISTS idx_agent_presets_status ON agent_presets(status);
"#.into() },
        Migration { version: 0036, name: "0036_share_grants.sql".into(), sql: r#"-- 0036: 共享 skill/agent 授权制(审核通过后仍需管理员授权才可见可装)。
-- 与商城 skill_grants(0016) 同模型:资源授权给 user 或 @group,admin 恒全量;
-- 授权对象 = 资源 name(同名多版本共享一个授权);作者自己上传的始终可见。
CREATE TABLE shared_skill_grants (
  skill_name TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
  grantee TEXT NOT NULL,
  PRIMARY KEY(skill_name, grantee_type, grantee)
);
CREATE TABLE agent_preset_grants (
  preset_name TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
  grantee TEXT NOT NULL,
  PRIMARY KEY(preset_name, grantee_type, grantee)
);
"#.into() },
        Migration { version: 0037, name: "0037_shared_quality.sql".into(), sql: r#"-- 0037: 共享资源质量标记(能力中心「组织库」官方/精选徽章)。
-- 与市场「免费/专业」分级词表隔离:「专业」一词全产品只作市场定价语义,
-- 组织库质量用 quality('' | 'official' | 'featured') 互斥标记。
-- 显示层仅对 approved 行生效;admin 可随时设置/清除(qualify 审计)。
ALTER TABLE shared_skills ADD COLUMN quality TEXT NOT NULL DEFAULT '' CHECK (quality IN ('', 'official', 'featured'));
ALTER TABLE agent_presets ADD COLUMN quality TEXT NOT NULL DEFAULT '' CHECK (quality IN ('', 'official', 'featured'));
"#.into() },
        Migration { version: 0038, name: "0038_missing_indexes.sql".into(), sql: r#"-- 0038: 缺失索引补全(对齐 SQLite 0038,基于 EXPLAIN 审计)。
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
"#.into() },
        Migration { version: 0039, name: "0039_usage_partition_ledger.sql".into(), sql: r#"-- 0039: usage 按月原生分区 + 日/月记账本。
-- 背景(PG-only 2026-08):
--   usage 是最高写入频次表(每次 LLM 调用 1 行),无清理策略数据无限累积;
--   200 员工 × 2 万次/月 ≈ 240 万行/年。明细保留 N 个月(默认 6,可配),
--   按月份 DROP PARTITION 秒删;明细删除不影响永久账本(usage_daily/monthly)。
--
-- 结构:
--   usage         主表 PARTITION BY RANGE (created_at),按月分区 usage_YYYYMM
--                 (PK 含 created_at;PG16 建索引自动传播到分区)
--   usage_daily   日账 PARTITION BY RANGE (day),按年分区 usage_daily_YYYY
--                 UNIQUE(user_id, model, day) —— 永久保留,由账本任务生成
--   usage_monthly 月账 普通表 UNIQUE(user_id, model, month) —— 永久保留,
--                 由日账聚合生成(最终兜底)
--
-- 账本生成: serverstore.RebuildUsageLedger(from,to) 从 usage 明细 UPSERT
--   日账/月账(幂等);每日任务 + 启动补算调用。保留策略:
--   CleanupUsageRetention(settings usage.retention_months,0=永久) DROP 过期分区。
--
-- 老库升级: usage 已有数据(若有)由 Go 侧 ensureUsagePartition 按月份
--   迁入分区;本迁移只建结构(新库无数据,直接 CREATE)。

-- ---- 1. usage 分区主表 ----
CREATE TABLE IF NOT EXISTS usage (
  id BIGSERIAL NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL DEFAULT 'chat',
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 当前月分区(写路径由 ensureUsagePartition 幂等创建后续月)
CREATE TABLE IF NOT EXISTS usage_202608 PARTITION OF usage
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- 主表索引(PG16 传播到已有/新建分区)
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON usage(model, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage(kind);
CREATE INDEX IF NOT EXISTS idx_usage_user_cost ON usage(user_id, cost);

-- ---- 2. usage_daily 日账(按年分区,永久) ----
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  day DATE NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model, day)
) PARTITION BY RANGE (day);
CREATE TABLE IF NOT EXISTS usage_daily_2026 PARTITION OF usage_daily
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);

-- ---- 3. usage_monthly 月账(普通表,永久) ----
CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  month DATE NOT NULL,  -- 月初(YYYY-MM-01)
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model, month)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_month ON usage_monthly(month);
"#.into() },
        Migration { version: 0040, name: "0040_skill_archive_stats.sql".into(), sql: r#"-- 0040: 技能商城改为压缩包上传(归档直接存 DB)+ 下载/调用统计。
-- 背景(2026-08):
--   skills(git 模式)与 shared_skills(员工上传)此前都把归档放在磁盘缓存;
--   本迁移把归档列加入两张表(上传包不入磁盘),并新增下载/调用计数列。
--
-- 字段:
--   skills.source        'git'(老模式,克隆+打包) | 'upload'(压缩包上传,归档存 DB)
--   skills.archive       上传包的原始字节(仅 source='upload' 时非空)
--   skills.downloads     归档下载次数(GET /archive 成功即 +1)
--   skills.calls         技能被调用次数(客户端 telemetry 上报累加)
--   shared_skills.archive     员工上传的归档字节(DB 直存,不再落磁盘)
--   shared_skills.downloads   归档下载次数
--   shared_skills.calls       技能调用次数
--
-- 老数据:既有 skills 行默认 source='git',既有 shared_skills 行归档仍在磁盘,
--   下载/预览实现保留磁盘回退(只读),新上传一律写 DB。

ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'git';
ALTER TABLE skills ADD COLUMN archive BYTEA;
ALTER TABLE skills ADD COLUMN downloads BIGINT NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN calls BIGINT NOT NULL DEFAULT 0;

ALTER TABLE shared_skills ADD COLUMN archive BYTEA;
ALTER TABLE shared_skills ADD COLUMN downloads BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shared_skills ADD COLUMN calls BIGINT NOT NULL DEFAULT 0;
"#.into() },
        Migration { version: 0041, name: "0041_agent_preset_archive.sql".into(), sql: r#"-- 0041: 共享 Agent 预设归档直存 DB(与技能 0040 对齐——所有上传不落盘)。
-- 背景(2026-08):shared_skills/skills 的归档已在 0040 直存 DB,但
--   agent_presets(共享 Agent 预设)的上传仍写磁盘缓存(archive 文件);
--   本迁移把归档列加入 agent_presets,上传/重提/下载/预览/删除全部走 DB。
--
-- 字段:
--   agent_presets.archive  上传的归档字节(直存 DB,不再落磁盘)
--   agent_presets.downloads 归档下载次数(GET /archive 成功即 +1)
--
-- 老数据:既有 agent_presets 行归档在磁盘,下载/预览保持磁盘回退(只读);
--   新上传一律写 DB(与 shared_skills 0040 的处理一致)。

ALTER TABLE agent_presets ADD COLUMN archive BYTEA;
ALTER TABLE agent_presets ADD COLUMN downloads BIGINT NOT NULL DEFAULT 0;
"#.into() },
        Migration { version: 0042, name: "0042_connectors.sql".into(), sql: r#"-- 0042: 连接器目录服务端化——连接器定义从客户端硬编码改为服务端下发。
-- 背景(2026-08):此前连接器(ConnectorDef:认证方式/字段/MCP 端点)硬编码在
--   客户端 connectors 包,新增/修改连接器必须重新打包发版;本迁移建立
--   connectors 表作为唯一目录源,webadmin 图形化管理,客户端经
--   GET /api/config/bootstrap 下发(connectors[]) 获取。
--
-- 字段:
--   connectors.id           稳定标识(如 moka/glitchtip),客户端按 id 匹配凭证
--   connectors.name         展示名(webadmin/客户端连接器中心)
--   connectors.description  展示描述
--   connectors.auth_mode    oauth|device|token|server-side
--   connectors.definition   JSON:认证配置 + token 字段 + MCP 服务器(与客户端
--                           ConnectorDef 对齐,服务端校验必填项)
--   connectors.enabled      下架开关(0=bootstrap 不下发,客户端隐藏)
--   connectors.updated_at   变更时间(审计对照)
--
-- 种子数据:迁入现有两个内置连接器(moka/glitchtip)的等价定义,
--   保证升级后行为不变;后续增删改全部经 webadmin。

CREATE TABLE IF NOT EXISTS connectors (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    auth_mode   TEXT NOT NULL CHECK (auth_mode IN ('oauth', 'device', 'token', 'server-side')),
    definition  TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 种子:moka(OAuth + streamable-http)+ glitchtip(token + stdio)+
-- sales-easy(销售易 NeoCRM,OAuth + streamable-http)。
-- 覆盖客户端此前全部硬编码连接器(0042 核查 2026-08-28:sales-easy 曾随
-- dedupeById 注册但未入表,现补齐)。
-- glitchtip 的 DEFAULT 字段值由服务端设置页(web.glitchtip_base_url/
-- web.glitchtip_organization)在 bootstrap 时合成注入,数据库存定义不含
-- 部署地址(源码/DB 均不含自部署主机名,见客户端旧 glitchtip.ts 约束)。
INSERT INTO connectors (id, name, description, auth_mode, definition) VALUES
('moka', 'Moka HR 智能体',
 '招聘和人事一体的 AI 同事,把查询与执行收进一个对话。人才推荐、招聘动态、考勤绩效、审批待办,一句话问清;智能寻聘、面试分析与面试官评估,一句话发起。',
 'oauth',
 '{"auth":{"discoveryUrl":"https://mcp.mokahr.com/mcp","clientId":"","authorizeUrl":"","tokenUrl":"","redirectUri":"http://127.0.0.1/callback","pkce":true,"publicClient":true,"scopes":"offline_access"},"mcp":[{"serverName":"moka","transport":"streamable-http","url":"https://mcp.mokahr.com/mcp"}]}'),
('glitchtip', 'GlitchTip',
 'GlitchTip(Sentry 兼容错误追踪):查询 issue 与最新事件堆栈,用于错误排查与监控告警',
 'token',
 '{"tokenFields":[{"key":"GLITCHTIP_BASE_URL","label":"服务地址(必填,如自部署地址或 app.glitchtip.com)","type":"text","required":true},{"key":"GLITCHTIP_TOKEN","label":"API Token(Auth Tokens 页创建,需 org:read / project:read / event:read)","type":"password","required":true},{"key":"GLITCHTIP_ORGANIZATION","label":"组织 slug(如 picoaide)","type":"text","required":true}],"examples":["查询当前未解决的错误 issue","查看最近一次异常的堆栈详情","列出错误追踪中的高优先级问题"],"mcp":[{"serverName":"glitchtip","transport":"stdio","command":"npx","args":["-y","glitchtip-mcp"],"env":{}}]}'),
('sales-easy', '销售易',
 '销售易 NeoCRM 官方 MCP:查询客户、线索、商机、联系人,执行 XOQL 查询与元数据操作',
 'oauth',
 '{"auth":{"authorizeUrl":"https://mcp.xiaoshouyi.com/oauth/authorize","tokenUrl":"https://mcp.xiaoshouyi.com/oauth/token","registrationEndpoint":"https://mcp.xiaoshouyi.com/oauth/register","clientId":"","redirectUri":"","scopes":"offline_access","pkce":true,"publicClient":true},"examples":["查询最近赢单的 10 个商机","统计各行业客户数量","帮我找一下联系人张三"],"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.xiaoshouyi.com/mcp"}]}')
ON CONFLICT (id) DO NOTHING;
"#.into() },
        Migration { version: 0043, name: "0043_provider_protocol.sql".into(), sql: r#"-- 0043: 上游协议标识——Anthropic 兼容代理路由。
-- 背景(2026-08):web_search 工具此前直连 DeepSeek 官方 Anthropic 兼容端点
--   (https://api.deepseek.com/anthropic/v1/messages),官方 key 随客户端下发,
--   抓包即可泄露并无限使用。本次让搜索也走服务端网关:网关新增 Anthropic
--   兼容 /v1/messages 路由,provider 表以 protocol 区分上游方言——
--   openai(默认,现有行为不变)/anthropic(/v1/messages 专用)。
--
-- 字段:
--   gateway_providers.protocol  openai|anthropic,默认 openai(存量行不变)
--   models 表不新增列:模型路由按 (models.name, provider.protocol) 匹配,
--   同一模型名可同时挂 openai 与 anthropic 两个 provider(两协议两端点)。

ALTER TABLE gateway_providers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'
    CHECK (protocol IN ('openai', 'anthropic'));
"#.into() },
        Migration { version: 0044, name: "0044_provider_protocol_both.sql".into(), sql: r#"-- 0044: 上游协议支持 both——同一 key 同时服务 chat(OpenAI)与 search(Anthropic)。
-- 背景(2026-08):DeepSeek 官方同一 API key 同时支持 OpenAI 兼容端点
--   (api.deepseek.com/v1/chat/completions)与 Anthropic 兼容端点
--   (api.deepseek.com/anthropic/v1/messages);此前 0043 要求 webadmin 为
--   搜索单独配一个 anthropic 协议上游(公用 key 配两边,运维负担)。
--   both 让一个 provider 同时匹配两条路由,零额外配置。
--
-- 语义:
--   gateway_providers.protocol = openai|anthropic|both(默认 openai)
--   both 的路由匹配:chat/embeddings 与 messages 都命中该 provider;
--   base_url 是 OpenAI 端点(不含 /anthropic),anthropic 端点自动推导:
--     base_url + /anthropic/v1 + /messages(DeepSeek 官方布局);
--   若管理员显式填了含 /anthropic/v1 的 base_url,推导尊重已填路径。
--
-- 存量行不自动升级(不是所有 openai 上游都支持 Anthropic 端点);
-- DeepSeek 官方上游在 webadmin 把 protocol 改为 both 即可(零额外 key)。

ALTER TABLE gateway_providers DROP CONSTRAINT gateway_providers_protocol_check;
ALTER TABLE gateway_providers ADD CONSTRAINT gateway_providers_protocol_check
    CHECK (protocol IN ('openai', 'anthropic', 'both'));
"#.into() },
        Migration { version: 0045, name: "0045_connectors_glitchtip_disabled.sql".into(), sql: r#"-- 0045: 下架 GlitchTip 连接器(错误监控已是独立自动集成)。
-- 背景(2026-08-29):GlitchTip 有两个独立角色——
--   1) 错误监控(Sentry DSN):客户端登录后自动上报异常,经 error-reporting
--      插件直接调 GlitchTip,不经连接器(正常工作,保留)。
--   2) 连接器 MCP(token 模式):AI 查询 issue/堆栈,需用户手动填 API Token
--      并点击"连接"——企业内仅用于收集错误上报,无需 AI 查询,故下架。
-- enabled=0:连接器目录(bootstrap connectors[])不再下发,客户端连接器中心
--   不显示 GlitchTip;错误监控不受影响(独立于连接器目录)。
UPDATE connectors SET enabled = 0 WHERE id = 'glitchtip';
"#.into() },
        Migration { version: 0046, name: "0046_rbac_roles.sql".into(), sql: r#"-- 0046: RBAC 角色模型
-- 企业级权限细分(设计 v3b: 2026-09-04-client-login-brand-ux.md):
-- users.role 枚举 super_admin/auditor/user, 取代 is_admin 布尔。
-- is_admin 保留列但不再写入新值(历史 dump 兼容), 读点全部切 role。
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('super_admin','auditor','user'));

-- 回填: 存量 is_admin=1 → super_admin(权限不收缩); is_admin=0 → user。
-- 幂等: 仅回填尚未显式赋值过 role 的行(迁移后新建行已带 role)。
UPDATE users SET role = 'user' WHERE is_admin = 0 AND role = 'user';
UPDATE users SET role = 'super_admin' WHERE is_admin = 1 AND role = 'user';

-- 管理会话空闲超时: last_used_at 供 12h 硬上限 + 60min 空闲滑动到期。
ALTER TABLE admin_sessions ADD COLUMN last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();
"#.into() },
        Migration { version: 0047, name: "0047_brand_snapshots.sql".into(), sql: r#"-- 0047: 品牌快照(设计 v3b 2026-09-04)。
-- 每次 brand_update 保存前一版配置 JSON, 供「恢复上一版本」;
-- 保留最近 10 份(写入时应用层裁剪)。
CREATE TABLE brand_snapshots (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data TEXT NOT NULL
);
"#.into() },
        Migration { version: 0048, name: "0048_audit_hash_chain.sql".into(), sql: r#"-- 0048: 审计日志防篡改哈希链(合规审计建议, 设计 v3b)。
-- 每条日志记录 prev_hash(前一条的 hash)与自身 hash(sha256(prev|username|
-- action|detail|created_at)), 形成链; 篡改中间条目会破坏后续所有校验。
-- 旧行迁移后 hash=''(仅首条 chain 起点), 新写入自动带链。
ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN hash TEXT NOT NULL DEFAULT '';
"#.into() },
        Migration { version: 0049, name: "0049_model_concurrency.sql".into(), sql: r#"-- 0049: 按模型并发峰值统计(管理后台「服务器信息」指标)。
-- 需求(2026-08-31): 向 DeepSeek 官方申请扩容需要「历史峰值并发」依据;
--   flash 目标 2500、pro 目标 500(可在模型的 default_params.concurrency_target
--   配置,前端展示对照)。
-- 数据来源: 网关请求在发起时内存计数(in-flight),采样 goroutine 每 15s
--   写入本表(按模型+天粒度): max 用 GREATEST 累计,永不回退;
--   history: 仅保留近 90 天(子查询 WHERE day >= now - 90)。
-- 说明: 并发 = 发起→结束的活跃请求(含流式;非 QPS)。usage 表只有结束记录,
--   不能从中推断并发,故单独聚合。
CREATE TABLE IF NOT EXISTS model_concurrency_stats (
  model TEXT NOT NULL,
  day DATE NOT NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 0,   -- 当日历史峰值(in-flight 采样)
  peak_at TIMESTAMPTZ,                          -- 峰值触发时刻(诊断用)
  PRIMARY KEY (model, day)
);
CREATE INDEX IF NOT EXISTS idx_conc_stats_day ON model_concurrency_stats(day);
"#.into() },
        Migration { version: 0050, name: "0050_capability_locks.sql".into(), sql: r#"-- 0050: 能力锁定(仅管理员可发布)。
-- 需求(2026-09-01): 管理员需要把某些技能/智能体标记为「员工不可上传分享」,
--   员工发布命中时明确拒绝并回显理由(决策 2026-09-01 D4)。
-- 语义:
--   * 锁定只约束「谁能写」,与授权(可见性)、上下架、质量标记正交;
--   * 管理员发布不受锁定限制;
--   * 允许对**尚不存在**的名字预先锁定(占名),防止员工抢占官方命名——
--     因此本表以 (kind, name) 为主键,不对 skills/shared_skills 建外键。
CREATE TABLE capability_locks (
  kind       TEXT NOT NULL,                    -- 'skill' | 'agent'
  name       TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',         -- 员工被拒时原样回显
  locked_by  TEXT NOT NULL DEFAULT '',         -- 操作管理员用户名(审计冗余)
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (kind, name)
);
"#.into() },
        Migration { version: 0051, name: "0051_skill_display_name.sql".into(), sql: r#"-- 0051: 市场技能展示名。
-- 需求(2026-09-01): 能力中心「市场」卡片一直显示目录名(如 team-knowledge-wiki),
--   而安装后又显示中文名——根因是 skills 表**没有展示名字段**,聚合面
--   (internal/capabilities) 只能回退成 name。组织共享库有 display_name,
--   市场域没有,这是两条链路唯一的元数据缺口。
-- 取值: 发布/规范化时从包内 SKILL.md 的 frontmatter `title` 写入(包内即真相);
--   为空时读侧回退 name,保持旧行为不变。
ALTER TABLE skills ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
"#.into() },
        Migration { version: 0052, name: "0052_drop_skill_git_mode.sql".into(), sql: r#"-- 0052: 移除市场技能的 git 源模式。
-- 背景(2026-09-01): 「包内即真相」要求发布时就能对归档做严格校验,而 git 模式
--   在创建时没有归档可校验(元数据靠管理员手填),既绕过校验,又导致「创建时填
--   了版本 → 首次上传同版本归档被递增校验挡死」的缺陷。
-- 现状核实: 生产库仅存的 git 行是端到端测试残留,无真实技能依赖该模式。
-- 结论: 归档上传成为唯一入口,source/git_url/git_ref 三列一并移除。
ALTER TABLE skills DROP COLUMN IF EXISTS git_url;
ALTER TABLE skills DROP COLUMN IF EXISTS git_ref;
ALTER TABLE skills DROP COLUMN IF EXISTS source;
"#.into() },
        Migration { version: 0053, name: "0053_apps.sql".into(), sql: r#"-- 0053: 统一应用模型(apps / app_releases / app_grants)——决策
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
"#.into() },
        Migration { version: 0054, name: "0054_apps_backfill.sql".into(), sql: r#"-- 0054: 把三张旧表回填进统一应用模型(apps / app_releases / app_grants)。
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
"#.into() },
        Migration { version: 0055, name: "0055_drop_legacy_capability_tables.sql".into(), sql: r#"-- 0055: 下线统一应用模型之前的六张旧表(P5)。
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
"#.into() },
        Migration { version: 0056, name: "0056_report_subscriptions.sql".into(), sql: r#"-- 0056: 月度报表订阅(2026-09 P1 用量中心)。
-- 周期生成上月用量汇总并推送到企业 webhook(钉钉/企微/飞书自定义机器人等)。
CREATE TABLE report_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  hook_url    TEXT NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
"#.into() },
        Migration { version: 0057, name: "0057_admin_mfa.sql".into(), sql: r#"-- 0057: 密码修改能力 + 管理员 MFA(TOTP)。
-- 需求: 管理员改自己密码/重置普通用户密码/员工自助改密/管理员可选双因素认证
-- (docs/planning/2026-09-04-admin-password-and-mfa.md)。
--
-- users 新增列:
--   * password_must_change: 1 = 下次登录强制改密(管理员重置密码时置位, 改密成功清除)
--   * password_changed_at:  上次改密时间(展示/审计用; 创建时 NULL = 从未改密)
--   * totp_secret:   管理员 TOTP 密钥密文(AES-GCM + master key; '' = 未配置)
--   * totp_enabled:  1 = 已启用(仅 verify 成功才置 1)
-- admin_mfa_challenges: 两步登录/开启 MFA 的一次性挑战(DB 表而非内存 —— 无状态
-- 多实例一致, 同 admin_sessions 先例)。
ALTER TABLE users ADD COLUMN password_must_change SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN totp_enabled SMALLINT NOT NULL DEFAULT 0;

CREATE TABLE admin_mfa_challenges (
  id         TEXT PRIMARY KEY,            -- 随机 48 hex
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'login',  -- 'login' 两步登录 | 'enable' 开启 MFA 暂存密钥
  secret     TEXT NOT NULL DEFAULT '',    -- kind='enable' 时的 TOTP 密钥密文(其余为空)
  attempts   INT NOT NULL DEFAULT 0,      -- 失败计数, >=5 作废(防爆破)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,        -- 5 分钟
  used_at    TIMESTAMPTZ                  -- 消费置位(防重放)
);
CREATE INDEX idx_mfa_challenges_user ON admin_mfa_challenges(user_id);
"#.into() },
        Migration { version: 0058, name: "0058_model_input_modalities.sql".into(), sql: r#"-- 0058: 模型输入模态(图片支持配置)。
-- 需求: 客户端模型清单需要「是否支持图片输入」的权威配置, bootstrap 统一下发
-- (客户端 llm-deepseek 目录 inputModalities; 缺失时默认仅 text, 视觉模型会被
-- 误判为不支持图片)。
--
-- models 新增列:
--   * input_modalities: JSON 文本数组, 取值 'text'/'image'(如 '["text"]' /
--     '["text","image"]'); 默认仅 text(与客户端 schema 缺省一致)。
--     渠道同步模型不覆盖该列(管理员配置在重同步时保留, 见 SyncProviderModel)。
ALTER TABLE models ADD COLUMN input_modalities TEXT NOT NULL DEFAULT '["text"]';
"#.into() },
        Migration { version: 0059, name: "0059_app_official.sql".into(), sql: r#"-- 0059: 能力中心「官方」机制(2026-09-04 定案)。
-- 官方 = App 级属性(apps.official=1),独立于 quality 质量标记:
--   * official=1 时 owner=''(无个人归属, 展示「官方」, 蓝标)
--   * 官方内容仅管理员可上传新版(appstore.Publish 检查)
--   * quality 的 'official' 值退役(只留 ''|featured),官方语义移交本列
-- 存量迁移:
--   1) 当前展示版本(最高 approved 且未软删)quality='official' 的 App → 转官方;
--   2) quality 列 official 值清空(历史版本也清——官方语义不再存在于质量维度)。
ALTER TABLE apps ADD COLUMN official SMALLINT NOT NULL DEFAULT 0;

UPDATE apps a SET official = 1, owner = ''
 WHERE EXISTS (SELECT 1 FROM app_releases r
               WHERE r.kind = a.kind AND r.app_id = a.app_id
                 AND r.status = 'approved' AND r.deleted_at IS NULL
                 AND r.quality = 'official');

UPDATE app_releases SET quality = '' WHERE quality = 'official';
"#.into() },
    ]
}
