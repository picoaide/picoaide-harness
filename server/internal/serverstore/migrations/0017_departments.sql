-- 0017: groups 升级为部门实体(金字塔组织架构)。
-- parent_id 0 = 顶层部门;leader_id 引用 users.id(0 = 未设主管)。
-- 权限语义:授权给部门 X → X 及子部门成员可见(向下继承);
-- 用户有效组 = 归属部门 + 祖先链;部门主管额外获得其部门子树授权(向上兼容)。
ALTER TABLE groups ADD COLUMN parent_id INTEGER DEFAULT 0;
ALTER TABLE groups ADD COLUMN leader_id INTEGER DEFAULT 0;
ALTER TABLE groups ADD COLUMN description TEXT DEFAULT '';
CREATE INDEX idx_groups_parent ON groups(parent_id);
