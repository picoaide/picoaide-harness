-- 0070: WASM 应用平台 —— 员工浏览器会话 + 应用子域会话（2026-09-17）。
--
-- 唯一设计基线 docs/planning/2026-09-17-wasm-app-platform.md:
--   §4.7      应用子域会话 = 一次性换票（code 单次、60 s、绑 (user, app)）；
--             换票端点 POST + Origin == 主站源 + next 白名单
--   §6.1      请求链路①–⑤：无应用 Cookie ⇒ 302 主站换票 ⇒ 302 回子域 ⇒ 兑换 ⇒ 干净 URL
--   §10.4     第 39/40/41/42/43/46/49 项（会话、身份与准入）
--   §13       「员工浏览器会话（R16）不存在（picoaide_session 是管理员专属；员工只有
--             Bearer）」⇒ 本迁移就是 R16 的落地：员工会话表 + 应用子域会话表
--
-- 为什么是两张表（而不是把 app_id 塞进一张表）：
--   1. 二者生命周期不同：员工会话是「浏览器登录」的产物（主站 host-only Cookie），
--      应用子域会话是「换票兑换」的产物（每个 <app_id>.<基域> 各自一份 Cookie）；
--   2. §10.4 第 46 项要求「员工登出 ⇒ 旧应用令牌立即失效」：靠 app_sessions 上的
--      FK ON DELETE CASCADE + employee_session_id 索引，一次登出即整批失效，
--      不必按 app 逐个枚举（见 session.RevokeSession 的显式 DELETE，二者互为兜底）；
--   3. §10.4 第 40 项要求「跨应用兑换一律拒」：app_sessions.app_id 是绑定列，
--      兑换时逐请求比对当前子域的 app_id。
--
-- 两条与既有系统同口径的硬约束：
--   * **只存 SHA-256**（token_hash），明文只存在于浏览器 Cookie 里 —— 与
--     api_tokens.token_hash（0002/0066 注释）和 admin_sessions.secret_hash（0066）
--     完全一致：任何读到库的人都拿不到可用会话。
--   * 时间列统一 TIMESTAMPTZ + now()（与全仓 PG-only 口径一致）。
--
-- 幂等可重放（IF NOT EXISTS），与既有迁移同风格。

-- ===== 1) 员工浏览器会话（R16） =====
-- 一行 = 一次「主站登录」在一个浏览器里的一份会话。
-- Cookie 名 picoaide_emp：host-only（不设 Domain）+ HttpOnly + Path=/ +
-- SameSite=Lax + 仅 https 才 Secure（fail-closed，§10.4 第 49 项）。
-- TTL = limits.AppSessionTTL（8 h），过期判断在读取路径上做（不依赖定时清理）。
CREATE TABLE IF NOT EXISTS employee_sessions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- token_hash = SHA-256(hex) of the raw cookie value. UNIQUE ⇒ 一个明文只对应一行。
  token_hash   TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  -- last_seen_at 由主站交互与换票刷新（应用子域请求不写，保持应用请求路径只读）。
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- user_agent / ip 只作运维排查用（会话列表）；不参与任何鉴权判定。
  user_agent   TEXT        NOT NULL DEFAULT '',
  ip           TEXT        NOT NULL DEFAULT '',
  -- revoked_at 非空 = 已吊销（登出，或管理员按会话批量吊销）。
  -- 读取路径同时校验 revoked_at IS NULL 与 expires_at > now()：
  -- 两把闸都要过，任一漏设都还能挡住（纵深）。
  revoked_at   TIMESTAMPTZ
);

-- token_hash 的索引由上面的 UNIQUE 约束自带（PG 为唯一约束建唯一索引），
-- 这里**不重复建**同列普通索引：双索引只会放大写入而不带来任何查询收益。
-- user_id 必须显式建：按用户批量吊销 / 会话列表（UNIQUE 索引帮不上）。
CREATE INDEX IF NOT EXISTS idx_employee_sessions_user ON employee_sessions(user_id);
-- 过期清理扫描（与 api_tokens 的 idx_tokens_expires 同口径）。
CREATE INDEX IF NOT EXISTS idx_employee_sessions_expires ON employee_sessions(expires_at);

-- ===== 2) 应用子域会话 =====
-- 一行 = 一次换票兑换出的、属于**某一个应用子域**的会话。
-- Cookie 名 picoaide_app：host-only（每个 <app_id>.<基域> 各自一份，天然不共享）
-- + HttpOnly + Path=/ + SameSite=Strict（§15.1 第 3 条：同站跨源写必须靠 Strict
-- 之外的最外层 Origin 校验，这里 Strict 是纵深）+ 仅 https 才 Secure。
-- TTL = limits.AppSessionTTL（8 h），与员工会话一致：应用会话不活得比它长。
CREATE TABLE IF NOT EXISTS app_sessions (
  id                  BIGSERIAL PRIMARY KEY,
  -- §10.4 第 46 项的实现手段：员工登出 ⇒ 级联删掉其名下全部应用子域会话。
  -- 可空是为了「会话表被单独清理」时不连带毁掉审计线索（正常路径永远非空）。
  employee_session_id BIGINT      REFERENCES employee_sessions(id) ON DELETE CASCADE,
  user_id             BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- app_id 即域名标签（§4.1）：兑换时逐请求比对当前子域，跨应用一律拒（§10.4 第 40 项）。
  app_id              TEXT        NOT NULL,
  -- token_hash = SHA-256(hex) of the raw cookie value（与 employee_sessions 同口径）。
  token_hash          TEXT        NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL
);

-- token_hash 同样由 UNIQUE 约束自带索引，不重复建。
-- app_id：按应用枚举会话（运维/诊断）。
CREATE INDEX IF NOT EXISTS idx_app_sessions_app ON app_sessions(app_id);
-- user_id：按用户批量吊销（管理员处置）。
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id);
-- employee_session_id：**FK 的级联删除走这一列**。PG 不会为 FK 自动建索引，
-- 缺了它每次登出都要全表扫 app_sessions（会话表会随使用量增长）——
-- 它同时也服务「显式 DELETE ... WHERE employee_session_id = ?」。
CREATE INDEX IF NOT EXISTS idx_app_sessions_employee ON app_sessions(employee_session_id);
