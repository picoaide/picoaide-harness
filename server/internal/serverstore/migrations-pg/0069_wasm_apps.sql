-- 0069: WASM 应用平台 —— 数据模型放开 + 调用事件 + 审计 app 维度(2026-09-17)。
--
-- 唯一设计基线 docs/planning/2026-09-17-wasm-app-platform.md:
--   §11 第 3 项  迁移一件: apps.kind / apps.channel CHECK 放开; **不新增标识列**
--                (域名标签就是 app_id, 同 kind 内由主键 (kind, app_id) 唯一)。
--                app_releases.status 的 CHECK 已含 pending/approved/rejected, 不动。
--   §5.3 / §11 第 16 项  保留最近 3 个曾生效版本 + 每用户 1 GiB 制品(列 + 统计口径)
--   §4.8        Host 第一级标签 → apps.app_id(kind='wasm_app'); 查不到即 404, 绝不回落主站
--   §4.9        审计 app_id 可空列 + 索引 + 哈希链版本化; 调用事件独立表(不进哈希链)
--   R37         冻结(只读快照 90 天) → 真删
--
-- 为什么 wasm 应用在 apps/app_releases 上要新列(设计只写了"CHECK 放开",
-- 列必须由本迁移落地):
--   * purpose / data_sensitivity / config_json / visible 是 §4.2 应用配置文件
--     (picoaide.app.json)在 **apps 上的当前生效投影**: 应用中心目录与运维面要能
--     一次查询过滤(§8 R34/R38), 不必逐行解析 JSON; 每版不可变快照仍在
--     app_releases.config_json(§4.2「改任何一项 = 发新版」)。
--   * current_release_id 承载 §8「开启审核时: 新版进待审队列, 待审期间线上仍为
--     旧版本」—— 生效版本必须是**显式一行**, 而不是"最新 approved"的隐式推导。
--   * frozen_at / deleted_at 承载 R37 的冻结与退役。
--   这些都不是**标识列**: 域名标签仍是 app_id, 没有新增 slug/host 列。
--   * 制品字节复用既有 app_releases.archive(BYTEA): 审核不变量 N-4
--     (「approved 必须有归档字节」)因此对 wasm 版本同样成立, 配额按
--     octet_length(archive) 统计, GC 置空后立即释放。
--
-- 幂等可重放(IF EXISTS / IF NOT EXISTS / DO $$ 自检), 与既有迁移同风格。
-- 自检段会在**任何**残留的旧 CHECK 仍拒绝 wasm_app 时 RAISE, 迁移失败而不是
-- 静默留下"看起来放开了、其实插不进去"的 schema(本任务最易错的一点)。

-- ===== 1) apps.kind: 加 wasm_app(不新增标识列) =====
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_kind_check;
ALTER TABLE apps ADD CONSTRAINT apps_kind_check CHECK (kind IN ('skill','agent','wasm_app'));

-- ===== 2) apps.channel: 加 wasm =====
-- wasm 应用既不在市场(market)也不在组织共享库(org): 它的分发面是
-- <app_id>.<基域> 应用子域(§4.8), 与能力中心的两个渠道正交。取独立值而不是
-- 复用 org/market, 是为了让**既有按 channel 过滤的查询**(marketplace/agentshare/
-- capabilities/sharedskills 全部显式传 market|org)天然把 wasm 应用排除在外,
-- 不会把它们当成技能/智能体展示。
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_channel_check;
ALTER TABLE apps ADD CONSTRAINT apps_channel_check CHECK (channel IN ('market','org','wasm'));

-- ===== 3) apps: wasm 应用的附加状态列(默认值 = 技能/智能体行的原语义) =====
ALTER TABLE apps ADD COLUMN IF NOT EXISTS purpose           TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS data_sensitivity  TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS config_json       TEXT NOT NULL DEFAULT '';
-- visible 默认 1: 建应用即可见(§4.2 未给默认值时取"创建自由"), 只有
-- SetWasmAppConfig 一条写入路径(从配置文件投影), 避免零值把应用静默隐藏。
ALTER TABLE apps ADD COLUMN IF NOT EXISTS visible           INTEGER NOT NULL DEFAULT 1;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS current_release_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS frozen_at         TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- ===== 4) app_releases: wasm 版本快照的配置与资源目录 =====
-- 制品字节走既有 archive 列(见文件头), 这里只加"随包配置 + 抽取出的资源目录"。
-- assets_dir = <data_root>/apps/<app_id>/assets/<release_id>/(§4.2), 落库是为了
-- 布局可演进时旧版本仍可定位; 它由宿主推导, 应用拿不到路径语义。
ALTER TABLE app_releases ADD COLUMN IF NOT EXISTS config_json TEXT NOT NULL DEFAULT '';
ALTER TABLE app_releases ADD COLUMN IF NOT EXISTS assets_dir  TEXT NOT NULL DEFAULT '';

-- ===== 5) 自检: 旧 CHECK 若仍拒绝 wasm_app, 本迁移必须失败(fail-loud) =====
-- 试插一行再让异常回滚(PL/pgSQL 的 EXCEPTION 块 = 子事务, 持久状态回滚),
-- 因此这里能真正验证"约束放开了", 而不只是"我加了一条新约束"。
DO $wasm_check_probe$
BEGIN
  BEGIN
    INSERT INTO apps (kind, app_id, channel) VALUES ('wasm_app', '__migration_0069_probe__', 'wasm');
    RAISE EXCEPTION 'probe rollback';
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION '0069: apps 上仍有拒绝 wasm_app/wasm 的 CHECK 约束(旧约束未被放开)';
    WHEN raise_exception THEN
      NULL; -- 探针自己的回滚信号, 预期路径
  END;
END
$wasm_check_probe$;

-- ===== 6) audit_logs: app 维度 + 哈希链版本化(§4.9) =====
-- 0048 的链口径: hash = sha256(prev_hash|username|action|detail|created_at)
-- (audit.go 的 auditHashPayload)。**加列不会改变旧行的链输入**, 所以旧行天然
-- 仍可校验; 但把 app_id 纳入链输入必须让校验器知道"这一行用哪个口径",
-- 故引入 hash_version:
--   1 = 0048 口径(不含 app_id) —— 存量行与本迁移后的非应用审计仍然写 1
--   2 = 追加 "|" + app_id 的口径   —— 带应用维度的审计写 2
-- 校验器按 hash_version 选算法(audit.go VerifyAuditChain); 因此"加列前写入的
-- 行"与"加列后写入的行"在同一条链里都能校验通过, 且篡改 app_id 会被发现。
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS app_id TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS hash_version SMALLINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_audit_logs_app ON audit_logs(app_id);

-- ===== 7) wasm 调用事件: 独立表, 不进哈希链(§4.9) =====
-- 回答"这个应用刚才为什么被杀"的唯一载体。字段与 §4.9 逐项对应:
--   app_id / user_id / outcome / reason_code / cpu_ms / peak_memory_bytes /
--   host_call_count / host_call_ms / queue_wait_ms / response_bytes /
--   db_rows / db_bytes / guest_exit_code / stderr_tail / created_at
-- 刻意**不加外键**: 应用退役(R37 真删)后诊断记录仍要能留下(7 天保留),
-- 且每次请求一条的写入热路径不该多付一次 FK 检查。
-- user_id = 0 表示匿名请求(mode=public), 不是"未知": §4.9 要求必须带 user_id
-- 才能追责"谁在什么时候用了哪个应用"。
-- outcome 不加 CHECK 枚举: 诊断是旁路, 词汇表漂移时**存下来**比静默丢弃更有用
-- (diag 侧把一切 != 'ok' 视为失败)。
CREATE TABLE IF NOT EXISTS wasm_call_events (
  id                BIGSERIAL PRIMARY KEY,
  app_id            TEXT NOT NULL,
  user_id           BIGINT NOT NULL DEFAULT 0,
  outcome           TEXT NOT NULL,
  reason_code       TEXT NOT NULL DEFAULT '',
  cpu_ms            BIGINT NOT NULL DEFAULT 0,
  peak_memory_bytes BIGINT NOT NULL DEFAULT 0,
  host_call_count   BIGINT NOT NULL DEFAULT 0,
  host_call_ms      BIGINT NOT NULL DEFAULT 0,
  queue_wait_ms     BIGINT NOT NULL DEFAULT 0,
  response_bytes    BIGINT NOT NULL DEFAULT 0,
  db_rows           BIGINT NOT NULL DEFAULT 0,
  db_bytes          BIGINT NOT NULL DEFAULT 0,
  guest_exit_code   INTEGER NOT NULL DEFAULT 0,
  stderr_tail       TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 诊断 API 的查询形状: 按应用取最近 N 条(§4.9 诊断 API)。
CREATE INDEX IF NOT EXISTS idx_wasm_call_events_app ON wasm_call_events(app_id, created_at DESC);
-- 保留期清理(limits.CallEventRetentionDays = 7 天)按 created_at 删除:
-- 没有这条索引时每次清理都是一次全表扫, 而调用事件是每请求一行的写入热表。
CREATE INDEX IF NOT EXISTS idx_wasm_call_events_created ON wasm_call_events(created_at);
