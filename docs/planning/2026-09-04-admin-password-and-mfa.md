# 管理员密码修改 + 管理员 MFA（TOTP）整体规划

> 状态：需求已定案（2026-09-04 评审通过全部决策点），待实施。分支：master。
> 需求：超管可改自己密码 / 重置普通用户密码；本地用户可自助改密；联合登录（LDAP/OIDC，
> `users.source='external'`）用户密码由企业 IdP 管理、不改密；管理员（super_admin/auditor）
> 可选 MFA（FMA = MFA/2FA，TOTP 动态码，**仅保护 webadmin 登录**）。
> 规划文档：`docs/planning/2026-09-04-admin-password-and-mfa.md`

---

## 1. 需求与决策清单（全部已定案）

| # | 项 | 决策 |
|---|----|----|
| R1 | 超管改自己密码 | 新增 `POST /admin/me/password`，旧密码校验；**改密后吊销全部会话（含当前），webadmin 强制登出** |
| R2 | 超管重置普通用户密码 | 复用 `PUT /users/:id` password 字段（服务端已有）；webadmin 加「重置密码」按钮；**被重置用户下次登录强制改密** |
| R3 | 本地员工自助改密 | 新增 `POST /auth/password`；**改密后吊销全部 token（含当前），客户端强制重新登录**；UI = 客户端设置-账号页**内联展开表单** |
| R4 | 管理员 MFA（TOTP） | 可选开/关；容差 ±1 步；**二维码 + secret 文本都显示**；无恢复码 |
| R4a | 关闭自己 MFA | **主密码 + 动态码双验** |
| R4b | 开启自己 MFA | **先验主密码**；开启后**踢掉其他已登录 webadmin 会话**（当前保留） |
| R4c | 兜底（无恢复码） | ① 其他 super_admin 在用户列表「重置 MFA」（不能对自己，可对 auditor/其他超管）→ **吊销其全部会话**；② **运维 CLI 兜底**（唯一超管丢失验证器场景）：`picoaide-server` 新增命令 |
| R4d | 启用超管数量 | **允许唯一超管开 MFA**（不阻止），靠 CLI 兜底 |
| R5 | 密码规则 | 维持 ≥10 位仅长度（三处校验统一复用 minPasswordLength） |
| R6 | 改密时间 | users 加 `password_changed_at`，webadmin 用户列表「上次改密」列展示；审计日志同步记录 |

## 2. 现状盘点（已核实）

- **员工面** `POST /api/client/v2/auth/login`（local/LDAP/OIDC/OpenID）→ 90 天 Bearer `api_tokens`；
  现有端点仅 login/logout/me/usage（`server/internal/serverauth/handler.go`）。
- **管理面** `POST /api/server/admin/login`（**local-only**，`AuthenticateConfiguredAdmin`）→ cookie session
  （`admin_sessions` 表：12h 硬过期 + 60min 滑动空闲；CSRF 窗口 1h；`admin_session.go`）。
- **users 表**：`source`（'local'|'external'）；external 无本地密码；`userJSON()` **不含 `source`**。
- `serverstore.UpdateUserRevokingTokens`：事务内改用户 + 吊销全部 `api_tokens`（审计 2026-L16）。
- `util.HashPassword`=argon2id；`util.Encrypt/Decrypt`=AES-GCM（复用于 TOTP secret 加密）。
- **约束（踩坑记录）**：路由集中声明于 `internal/router/router.go`（命名空间 /api/server、/api/client/v2），
  测试树须同前缀；全 API JSON 信封；管理面 CSRF + `AdminRoute` 权限申报；webadmin 前缀走
  `lib/api-paths.ts` 常量（测试 vi.mock 工厂须同步导出）；迁移最新 0056（06-database.md 的 0048 过时，
  顺带修正）；e2e fixture 网关路径表须同步。

## 3. 总体设计

### 3.1 数据模型（迁移 0057_admin_mfa.sql，PG only）
```sql
ALTER TABLE users ADD COLUMN totp_secret         TEXT NOT NULL DEFAULT '';   -- AES-GCM 密文（复用 master key）；''=未配置
ALTER TABLE users ADD COLUMN totp_enabled        SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;                -- 改密时间（含重置）；仅展示用
ALTER TABLE users ADD COLUMN password_must_change SMALLINT NOT NULL DEFAULT 0; -- 1=下次登录强制改密（重置密码时置位）

CREATE TABLE admin_mfa_challenges (              -- 两步登录挑战（DB 表：无状态/多实例优先，同 admin_sessions 先例）
  id         TEXT PRIMARY KEY,                   -- 随机 48 hex
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts   INT NOT NULL DEFAULT 0,             -- ≥5 作废（防爆破）
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,               -- 5 分钟
  used_at    TIMESTAMPTZ                         -- 消费置位（防重放）
);
CREATE INDEX idx_mfa_challenges_user ON admin_mfa_challenges(user_id);
```
- `serverstore/users.go`：`User` 加 `TotpSecret/TotpEnabled/PasswordChangedAt/PasswordMustChange`；
  `userCols`/`scanUser` 同步；新增 `SetUserMFA`、`UpdateUserPassword`（事务：UPDATE hash +
  password_changed_at + must_change + 清/置标志 + **DELETE 全部 api_tokens + DELETE 全部 admin_sessions**
  —— 全吊销语义）、`RevokeAllSessions(db, userID)`。
- 无恢复码表/字段（已定案取消）。

### 3.2 新端点清单

**员工面（`/api/client/v2/auth`，Bearer）：**
| 端点 | 说明 |
|---|---|
| `POST /password` | `{old_password,new_password}`；旧密码校验 + `source=='local'` + ≥10 位；改密后**吊销全部 api_tokens（含当前）**并按需吊销 admin_sessions；审计 `password_change: self` |
| `POST /login`（改造） | 登录响应加 `must_change_password`（login 成功但标志=1 时客户端进入强制改密态，见 §5） |

**管理面（`/api/server/admin`，session+CSRF）：**
| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /me/password` | ""（有效 session） | 旧密码校验 + local；**吊销全部 api_tokens + 全部 admin_sessions（含当前）**，响应后前端强制登出；审计 `admin_password_change` |
| `GET  /me/mfa` | "" | `{enabled}`（静默） |
| `POST /me/mfa/enable` | "" | 请求带**主密码**；校验通过 → 生成 TOTP secret（pquerna/otp）暂存（服务端 ticket，60s），返回 `{secret, otpauth_url, ticket}` |
| `POST /me/mfa/verify` | "" | `{ticket, code}` 验证通过 → 加密落库 + enabled=1；**吊销该用户其他 admin_sessions（保留当前）**；审计 `admin_mfa_enable` |
| `POST /me/mfa/disable` | "" | **主密码 + 当前动态码双验** → 清空 secret/enabled；吊销该用户其他会话；审计 `admin_mfa_disable` |
| `PUT  /users/:id/mfa` | PermUserWrite（super_admin） | **重置（关闭）其他管理员 MFA**：不能对自己；可对 auditor/其他超管；关闭后**吊销其全部会话**（admin_sessions + api_tokens）；审计 `admin_mfa_reset` |
| `POST /login`（改造） | 公开 | 密码正确且 `totp_enabled=0` → 直接建 session；`totp_enabled=1` → 返回 `{mfa_required:true, mfa_ticket}`，不建 session；登录响应带 `must_change_password` |
| `POST /login/mfa`（新增） | 公开 | `{mfa_ticket, code}` → 校验 ticket（未过期/未用/attempts<5）→ TOTP 校验 → 消费 ticket → 建 session；失败 attempts+1，审计 `admin_mfa_login` fail/success |
| `PUT /users/:id`（改造） | PermUserWrite | password 字段写入时置 `password_must_change=1` + `password_changed_at=now`（全吊销语义保持） |

**运维 CLI 兜底（cmd/server 入口新增）：**
```bash
picoaide-server --reset-mfa <username>   # 或子命令：mfa reset <username>
# 行为：读取 master key → 解密判断 → 清空该用户 totp_secret/totp_enabled + 吊销其全部会话 + 审计 admin_mfa_reset(cli)
# 无 DB 连接失败即报错退出；该命令走本地 DB 直连（PG DSN），不暴露任何远端接口
```

- TOTP：`github.com/pquerna/otp`（`totp.Generate/Validate`，30s、±1 步、SHA1、6 位）。
- 限流：复用 `adminLoginLimiter`（密码、MFA 两段都过桶）；MFA challenge attempts≤5。
- 密码规则：三处（创建/重置/自助/改己）统一 `minPasswordLength=10`。

### 3.3 userJSON 补充
- `"source": u.Source`、`"password_changeable": u.Source=="local" && u.Status==1`、
  `"password_must_change": bool`、`"mfa_enabled": bool`（webadmin 列表 + 员工 /me 同源透出；
  客户端 AccountSection 据此决策改密入口；webadmin 据此控制「重置MFA」按钮可见性）。

## 4. 服务端改动明细（文件级）

| 文件 | 改动 |
|---|---|
| `internal/serverstore/migrations-pg/0057_admin_mfa.sql` | 新建（见 3.1） |
| `internal/serverstore/users.go` | User 字段扩展 + DAO（SetUserMFA / UpdateUserPassword 全吊销 / RevokeAllSessions / 迁移后扫描） |
| `internal/serverstore/users_test.go` | DAO 单测（PG 临时库，密码改后全吊销、must_change 置位/清除） |
| `internal/serverauth/handler.go` | `ChangePassword`；`RegisterRoutes` 挂 `POST /password`；login 响应加 must_change_password |
| `internal/serverauth/admin.go` | 6 个新 handler + login 两步改造 + reset MFA handler；`RegisterAdminRoutes` 挂载 |
| `internal/serverauth/mfa.go`（新） | challenge DAO（Create/Get/Consume）+ TOTP 生成/校验 + 主密码校验复用 |
| `internal/serverauth/admin_test.go` / `handler_test.go` | MFA 全流程 + 改密矩阵（成功/旧密码错/external 拒绝/长度不足/改后全吊销）+ ticket 过期·重放·爆破 + 重置 MFA 权限矩阵 |
| `internal/router/router.go` | 集中挂载全部新路由 |
| `cmd/server/main.go` | `--reset-mfa <username>` 兜底命令 |
| `go.mod` | `+ github.com/pquerna/otp` |

## 5. 强制改密流程（R2 派生，本期实现）

- **触发**：管理员重置密码（`PUT /users/:id` password）→ `password_must_change=1`；
  员工/管理员自助改密（密码正确）→ 清除标志。创建用户默认 0。
- **员工面**：登录成功响应 `must_change_password=true` → 客户端 **auth-gate 进入强制改密态**
  （登录页同风格的改密表单：新密码×2，提交成功后 setSession 进主界面；期间不得进入任何业务界面）。
- **管理面**：`/login` 或 `/login/mfa` 成功且标志=1 → webadmin 进入强制改密拦截页（对话框不可跳过，
  完成 `POST /me/password` 后放行）。
- 审计：`password_force_change`（重置时）与 `password_change`（完成时）。

## 6. webadmin 改动明细（`server/webadmin/`）

| 文件 | 改动 |
|---|---|
| `src/pages/Login.tsx` | 两步登录状态机（密码 → mfa_required → 6 位码）；成功且 must_change → 强制改密拦截 |
| `src/api.ts` / `src/lib/api-paths.ts` | 新封装（loginMFA / changeMyPassword / getMyMFA / enableMFA / verifyMFA / disableMFA / resetUserMFA），前缀走常量 |
| `src/App.tsx` | 侧边栏底部用户区加「修改密码」「安全设置(MFA)」入口；强制改密拦截逻辑 |
| `src/components/PasswordDialog.tsx`（新） | 旧+新+确认（≥10 位）；成功即登出重登 |
| `src/components/MFASettingsDialog.tsx`（新） | 状态；开启：主密码 → 二维码（`qrcode` 依赖）+ **secret 文本同时展示** → 输 6 位码 verify；关闭：主密码+动态码双验 |
| `src/pages/Users.tsx` | 操作列加「重置密码」（external 禁用，成功提示强制改密）与「重置MFA」（mfa_enabled 才显示、super_admin 权限、禁止自己）；列表加「上次改密」列 |
| 测试 | Users.test.tsx / Auth 相关 / api.test.ts / Login 两步流（注意 vi.mock('../api') 常量坑） |

## 7. 客户端改动明细（`packages/host/enterprise/`）

| 文件 | 改动 |
|---|---|
| `src/client/AccountSection.tsx` | **内联展开**改密表单（旧/新/确认）；`source!='local'` 时显示「密码由企业 IdP 管理」提示 |
| `src/auth-gate.ts` | 登录响应 `must_change_password` → 渲染**强制改密态**（改密表单 stage，成功后 setSession）；登录后持久化 `user.source/password_changeable` |
| `src/session-service.ts`（视实现） | 会话状态扩展 source 字段 |
| `src/client/locales.ts` | 中英 key：改密全套 + 强制改密态文案 |
| host 侧（desktop） | `/api/pico/auth/state` 透传 source 字段 |
| 测试 | 既有模式 + e2e fixture 网关加 `/auth/password` 路径 |

**不改**：员工登录页不加 MFA（仅 webadmin，已定案）。

## 8. 审计动作

`password_change`（员工自助/强制改密完成）、`admin_password_change`、`password_force_change`（重置触发）、
`user_tokens_revoked`（沿用）、`admin_mfa_enable`、`admin_mfa_disable`、`admin_mfa_reset`（管理端与 CLI）、
`admin_mfa_login`（success/fail 带计数）。

## 9. 测试与门禁

- Go：`make check`（gofmt/vet/全量测试，PG_DSN_TEST 跑新迁移与 DAO）。
- webadmin：`npm run test` + build。
- 客户端：企业包测试 + `corepack yarn check`；`e2e:client`（fixture 网关同步新路径）。
- 手工冒烟：开 MFA → 两步登录 → 改密 → 全端踢出 → 重置他人密码 → 强制改密 → CLI 兜底。

## 10. 实施阶段

1. **P1 员工自助改密**（/auth/password + source 透出 + AccountSection 内联表单 → 全吊销重登）。
2. **P2 webadmin 重置密码**（UI + must_change + 强制改密流程打通：员工面 + 管理面拦截）。
3. **P3 超管改自己密码**（/me/password + 侧边栏入口 + 全吊销登出）。
4. **P4 管理员 MFA**（0057 迁移 + challenge + 两步登录 + MFA 设置 UI 双显示 + 重置MFA + CLI 兜底 + 审计）。
5. **P5 文档**（03-api-reference / 06-database（修正迁移号 0048→0056）/ 本文档归档）。

## 11. 风险备注

- 「改密后全部吊销」意味着管理员在客户端改密后需重新登录，webadmin 亦然——安全优先（已定案）。
- 强制改密拦截需在 auth-gate 与 webadmin 两侧都做「不可跳过」守卫（客户端防绕过：业务请求在
  未完成改密前拒绝？——服务端不改密完成前不签发业务能力：`must_change` 期间仅放行改密与 /me，
  其余 403 `PASSWORD_CHANGE_REQUIRED`。实现时评估拦截层位置）。
- CLI 兜底命令必须在生产部署文档（DEPLOY/02-build-deploy）中说明。
