-- 0076: usage 的**应用维度归因**（§21.4，2026-09-19 定案）。
--
-- 契约与设计：docs/planning/2026-09-19-wasm-client-only-design.md §21.4
--   「计费：走客户端既有 LLM 链路（**使用者账**）＋**应用维度归因**（本期新增）」
--   「§21.2 链路：客户端既有 LLM 链路（llm-deepseek → 平台 /v1）＋ 出站头
--     `X-Pico-App-Id`（归因）」
--
-- 为什么需要这一列：应用内的 AI 调用走的是**员工自己的** LLM 链路（密钥只在服务端、
-- 计费进使用者账户），因此 usage 行天然只带 user_id。没有 app_id 时，"这个应用吃掉
-- 了多少 AI 成本"只能靠员工自述 —— 而运营面（§21.4 的 AI 用量面板）要的正是这一条。
--
-- 归因语义（三条，别自行放宽）：
--   1. **best-effort**：`X-Pico-App-Id` 缺失/非法 ⇒ 记空串，**绝不影响计费**
--      （§17 认账 8：「老客户端不带 X-Pico-App-Id ⇒ 计费正常但应用维度归因缺失」）；
--   2. **不参与计费**：cost/余额/账本三者的计算完全不看这一列 —— 它只是标签，
--      改它永远不该改变任何金额（否则"伪造一个头就能改价"）；
--   3. **不设 FK 到 apps**：历史 usage 行必须留下，应用被删除/改名不影响已落账的
--      成本核算（核算数据不可因业务对象的生命周期而变）。
--
-- 注：usage 是按 created_at 的分区表 ⇒ `ADD COLUMN` 会自动传播到所有分区与后续
-- 新建分区（PG11+ 语义），与 0065 的 provider_id 完全同款，因此这里只改主表。
--
-- 幂等可重放（IF NOT EXISTS），与既有迁移同风格。

ALTER TABLE usage ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT '';

-- 查询形状 = "某个应用在时间窗内的 AI 用量"（§21.4 面板与运营报表）。
-- 部分索引：绝大多数行（普通聊天，不经应用）的 app_id 是空串，把它们排除在索引外
-- 既省空间也让"按应用聚合"这条查询只扫真正相关的行。
CREATE INDEX IF NOT EXISTS idx_usage_app_time ON usage (app_id, created_at) WHERE app_id <> '';

-- 自检（fail-loud）：列必须存在且类型/缺省与预期一致。
-- 为什么连 DEFAULT 也断言：这一列会被 INSERT 省略（老代码路径不写它），
-- 缺省一旦不是空串，历史语义（"没有归因"）就会与被误写的值混在一起。
DO $usage_app_id_selfcheck$
DECLARE
  col_type TEXT;
  col_default TEXT;
  col_notnull BOOLEAN;
BEGIN
  SELECT data_type, COALESCE(column_default, ''), is_nullable = 'NO'
    INTO col_type, col_default, col_notnull
    FROM information_schema.columns
   WHERE table_name = 'usage' AND column_name = 'app_id';
  IF col_type IS NULL THEN
    RAISE EXCEPTION '0076: usage.app_id 未创建';
  END IF;
  IF col_type <> 'text' THEN
    RAISE EXCEPTION '0076: usage.app_id 类型应为 text，实际为 %', col_type;
  END IF;
  IF col_default NOT LIKE '''''%' THEN
    RAISE EXCEPTION '0076: usage.app_id 缺省应为空串，实际为 %', col_default;
  END IF;
  IF NOT col_notnull THEN
    RAISE EXCEPTION '0076: usage.app_id 应为 NOT NULL（空串表示"无归因"）';
  END IF;
END
$usage_app_id_selfcheck$;
