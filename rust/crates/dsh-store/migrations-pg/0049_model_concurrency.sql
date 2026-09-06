-- 0049: 按模型并发峰值统计(管理后台「服务器信息」指标)。
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
