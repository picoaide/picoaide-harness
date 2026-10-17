-- 0085: web_search 按次计费（DeepSeek Search 费用）的计量列。
--
-- 背景:DeepSeek 官方自 2026-11-01 00:00(北京时间)起,对 DeepSeek Harness /
-- Claude Code / Codex 经 **Server 端工具调用** 访问 Search / Fetch 的请求按
-- 5 元/千次成功请求计费(https://api-docs.deepseek.com/zh-cn/guides/search)。
-- 网关在 /v1/messages 的 Anthropic 兼容代理链路上只能看到模型 token 用量,
-- 看不到这笔按次费用 —— 不单独计量就会整段漏计。
--
-- 口径:
--   * search_requests = 本次请求成功返回了网页结果的 web_search 次数;
--   * 费用 = token 费用 + search_requests × settings['usage.search_price_per_1k'] / 1000;
--   * 按次费用是独立价目,**不参与峰谷折扣**(官方 Search/Fetch 是无时段差异的
--     固定单价);峰谷折扣只乘模型 token 费用。
--
-- 列挂在分区父表上,PG 会同步到已有分区;之后按月新建的分区通过
-- PARTITION OF usage 自动继承该列。
--
-- `IF NOT EXISTS`:迁移必须可重放。测试夹具会把库退回 0080 之前再整段重放
-- (migrate_lock_budget_test.go 的 blockBefore0080),而该动作只删版本行、不删
-- 后加列;没有这个守卫时重放会在"列已存在"处失败,把"释放锁后必须恢复"的
-- 判据打成假红。与 0080/0081/0082 的写法一致。
ALTER TABLE usage ADD COLUMN IF NOT EXISTS search_requests BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN usage.search_requests IS
    '本次请求成功返回结果的 web_search 次数(按 settings usage.search_price_per_1k 计费,不参与峰谷折扣)';
