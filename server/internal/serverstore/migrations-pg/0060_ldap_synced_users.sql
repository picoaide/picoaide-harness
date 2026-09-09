-- 0060: 记录 LDAP 目录同步过的用户名(2026-09-08 审计 P1-4)。
-- 背景:deactivateMissingExternalUsers 停用所有 Source='external' 且不在
-- LDAP 目录中的用户,但 OIDC 用户同样是 Source='external'(oidc.go),
-- 于是同时启用 LDAP+OIDC 时,每小时一次的目录同步会把全部 OIDC 用户
-- status=0 并吊销 token,再登录即 401「账号已禁用」且无自愈。
-- 本表只标记"由 LDAP 同步见过"的用户名,停用只针对这些用户名;
-- OIDC 用户永远不会进入本表,因此不再被 LDAP 对账误伤。
CREATE TABLE IF NOT EXISTS ldap_synced_users (
  username  TEXT PRIMARY KEY,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
