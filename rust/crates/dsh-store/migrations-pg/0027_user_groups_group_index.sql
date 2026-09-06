-- 0027: user_groups(group_id) 索引(审计 L3:N+1/全表扫治理)。
-- 部门成员统计/预算聚合(DeptMemberIDs/DeptMonthlyCostBatch)按 group_id
-- 查询 user_groups,此前无索引需全表扫;随部门与成员规模线性放大。
CREATE INDEX idx_user_groups_group ON user_groups(group_id);
