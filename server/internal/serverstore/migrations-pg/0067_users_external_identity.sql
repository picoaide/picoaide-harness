-- 0067: 外部身份绑定到 IdP 主体(sub / DN),不再只按用户名(审计 2026-09-13 P2-9)。
--
-- 背景:provisionUser 只按 username 匹配行,唯一守卫是"external 不得接管
-- local"。于是**外部身份之间**没有任何绑定:同时启用 LDAP+OIDC 时,或 IdP
-- 允许用户自选 preferred_username/email 时,任何同名的 external 身份都会
-- 复用同一行(余额/授权/归属/用量历史),即账号接管。
--
-- 修法:
--   * external_id     = IdP 主体标识(OIDC 的 sub;LDAP 的 entry DN);
--   * external_source = 该主体来自哪套 IdP(ldap/oidc/openid),便于排障与
--     后续按来源做组同步;
--   * 存量行 external_id='' ⇒ 首次登录时"认领"(写入),之后必须逐字匹配,
--     不匹配即拒绝登录(管理员需显式处理,不再静默复用)。
ALTER TABLE users ADD COLUMN external_id TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN external_source TEXT NOT NULL DEFAULT '';
