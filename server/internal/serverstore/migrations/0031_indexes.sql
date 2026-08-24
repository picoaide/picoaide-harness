-- 0031: 生产查询索引优化(对齐 PG 0031)。
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
