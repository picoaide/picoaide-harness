-- 0046: RBAC 角色模型
-- 企业级权限细分(设计 v3b: 2026-09-04-client-login-brand-ux.md):
-- users.role 枚举 super_admin/auditor/user, 取代 is_admin 布尔。
-- is_admin 保留列但不再写入新值(历史 dump 兼容), 读点全部切 role。
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('super_admin','auditor','user'));

-- 回填: 存量 is_admin=1 → super_admin(权限不收缩); is_admin=0 → user。
-- 幂等: 仅回填尚未显式赋值过 role 的行(迁移后新建行已带 role)。
UPDATE users SET role = 'user' WHERE is_admin = 0 AND role = 'user';
UPDATE users SET role = 'super_admin' WHERE is_admin = 1 AND role = 'user';

-- 管理会话空闲超时: last_used_at 供 12h 硬上限 + 60min 空闲滑动到期。
ALTER TABLE admin_sessions ADD COLUMN last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();
