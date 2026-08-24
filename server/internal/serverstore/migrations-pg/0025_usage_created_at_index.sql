-- 0025: usage 表 created_at 单列索引。
-- UsageAggregate 的日期范围聚合(WHERE created_at >= ? AND created_at < ?)
-- 无法走既有复合索引 idx_usage_user_time(user_id 前缀),在数据量增长后
-- 退化为全表扫描;60s 轮询(≤7 天按日分组)会放大该开销(审计高3)。
-- 纯增量迁移,旧索引保留(员工月用量查询仍走 idx_usage_user_time)。
CREATE INDEX idx_usage_time ON usage(created_at);
