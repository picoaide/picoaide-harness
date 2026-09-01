-- 0050: 能力锁定(仅管理员可发布)。
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
