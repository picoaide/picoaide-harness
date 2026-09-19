-- 0075: WASM 应用平台 —— 打开计数（F16，2026-09-19 第三轮 Q1–Q9 定稿）。
--
-- 契约与设计：docs/planning/2026-09-19-wasm-client-only-design.md
--   §5.1b  打开校验（`POST /api/client/v2/apps/wasm/:app_id/open`）每次调用记一次打开；
--   §8.9   存储定稿：明细表 + 日汇总表，明细 90 天、日汇总长期保留。
--
-- 两张表的分工（不是冗余）：
--   * `wasm_app_opens`（明细）：一行 = 一次打开，带 user_id/dept_id/时刻/client_version。
--     用途是"谁在用"与"按部门向上汇总"；**保留 90 天**（隐私/体量），
--     超期由 Go 定时器清理（先汇总后清理，见 internal/wasmapp/opens）。
--   * `wasm_app_opens_daily`（日汇总）：`(app_id, day, dept_id)` 一行，pv/uv 两个计数。
--     **长期保留** —— 趋势与 TOP N 看板不能因为明细过期而断档。
--
-- ⚠️ 主键里的 dept_id 用 **0 表示"无部门"**（NULL 不能进主键）：
--   设计 §8.9 对**明细表**写的是"无部门记 NULL"（明细保持了 NULL 语义，见下表），
--   而汇总表的 `(app_id, day, dept_id)` 是主键 ⇒ 三列都必须 NOT NULL。
--   因此汇总侧用 0 作哨兵，聚合 SQL 用 `COALESCE(dept_id, 0)` 对齐；
--   两个 0/无部门行在汇总里天然合成同一行（不会出现"NULL 行 + 0 行"两份）。
--
-- 时区口径（§5.1b 第 3 条，**冻结**）：`day` 是**服务端本地日**（Go 的 time.Local，
--   由部署的 TZ 决定），不是 UTC 日、也不是数据库会话时区。日边界由应用侧
--   `serverstore.LocalDay` 算好后再传给 SQL（不写 `opened_at::date`，那会取 PG 会话
--   时区 —— 应用与数据库是两个容器，不一致时同一天会落进两个 day 值且无任何报错）。
--   open 响应里的 `opens.today` 用同一份口径（否则"今天被打开 N 次"会与看板差一天）。
--   注意：改部署 TZ 不迁移历史 day 行（历史仍按当时口径），这是有意的取舍。
--
-- 部门口径（§8.9）：`dept_id` = 打开时刻用户的**主部门**（`groups.id`）。
--   用户当天换部门 ⇒ 以**打开时刻**的部门为准，同一用户当天可以出现在两个部门行；
--   UV 按 `(app_id, day, dept_id)` 去重（不是按 (app_id, day) 全局去重）——
--   这是冻结口径，不要在聚合 SQL 里"顺手"改成全局 UV。
--
-- 幂等可重放（IF NOT EXISTS），与既有迁移同风格。

-- ===== 1) 明细表（90 天） =====
CREATE TABLE IF NOT EXISTS wasm_app_opens (
  id             BIGSERIAL   PRIMARY KEY,
  app_id         TEXT        NOT NULL,
  user_id        BIGINT      NOT NULL,
  -- 打开时刻用户的主部门；无部门记 NULL（聚合时 COALESCE 成 0）。
  --
  -- 不设 FK 到 groups：部门删除时（0017 要求先清空成员/授权）历史计数行**必须留下**
  -- —— 统计的核心用途之一恰恰是"这个应用在被裁撤的部门里用过"。删行等于篡改历史。
  dept_id        BIGINT,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 客户端自报的**已缓存版本**（open 请求的 current_version）。
  -- 空串 = 首次打开 / 缓存已清 —— 这一列让运营面能分辨"改版后仍有人在用旧缓存"。
  client_version TEXT        NOT NULL DEFAULT ''
);

-- 三个索引 = §8.9 点名的三个查询形状（按应用看趋势 / 按人看行为 / 按部门汇总）。
CREATE INDEX IF NOT EXISTS idx_wasm_app_opens_app_time  ON wasm_app_opens (app_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_wasm_app_opens_user_time ON wasm_app_opens (user_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_wasm_app_opens_dept_time ON wasm_app_opens (dept_id, opened_at);

-- ===== 2) 日汇总表（长期） =====
CREATE TABLE IF NOT EXISTS wasm_app_opens_daily (
  app_id  TEXT   NOT NULL,
  day     DATE   NOT NULL,
  -- 0 = 无部门（与明细的 NULL 是同一件事的两种表示，见文件头）。
  dept_id BIGINT NOT NULL DEFAULT 0,
  -- pv = 当日打开次数（每次打开 +1，不去重）；uv = 当日按 user_id 去重人数。
  pv      BIGINT NOT NULL DEFAULT 0,
  uv      BIGINT NOT NULL DEFAULT 0,
  -- updated_at 让"这张表最后一次被定时器刷新"可诊断（缺它就只能靠猜：
  -- 汇总停摆与"真的没人用"在数据上长得一样）。
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, day, dept_id)
);

-- 看板查询形状：按日期的跨应用 TOP N（顺序与主键前缀不同，故另建索引）。
CREATE INDEX IF NOT EXISTS idx_wasm_app_opens_daily_day ON wasm_app_opens_daily (day DESC);

-- ===== 3) 自检（fail-loud） =====
-- 迁移自检的既有口径：把"这一步本该成立的事实"再断言一次，避免"DDL 静默没生效"
-- 却继续往下跑（真 PG 上 IF NOT EXISTS 遇到同名的**错误形状**对象时会沉默）。
DO $wasm_app_opens_selfcheck$
DECLARE
  pk_cols TEXT;
BEGIN
  IF to_regclass('public.wasm_app_opens') IS NULL THEN
    RAISE EXCEPTION '0075: wasm_app_opens 未创建';
  END IF;
  IF to_regclass('public.wasm_app_opens_daily') IS NULL THEN
    RAISE EXCEPTION '0075: wasm_app_opens_daily 未创建';
  END IF;
  -- 主键必须是 (app_id, day, dept_id) 三列：少了任何一列，日汇总就会退化成
  -- "每天一行"（丢部门维度）而运行期 upsert 仍能跑通 —— 这类静默退化只能靠自检拦住。
  SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum))
    INTO pk_cols
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
   WHERE i.indrelid = 'public.wasm_app_opens_daily'::regclass AND i.indisprimary;
  IF pk_cols IS DISTINCT FROM 'app_id,day,dept_id' THEN
    RAISE EXCEPTION '0075: wasm_app_opens_daily 主键应为 (app_id,day,dept_id)，实际为 %', COALESCE(pk_cols, '<无>');
  END IF;
END
$wasm_app_opens_selfcheck$;
