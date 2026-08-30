# 企业级登录、权限与品牌一体化设计（v3b）

> 状态：**待评审（Draft v3b）**　|　日期：2026-09-04　|　分支建议：`feat/enterprise-rbac-brand`
> 版本沿革：v1（纯品牌 UI 方案，已废弃）→ v2（4 角色 agent 审计后 RBAC 方案）→ v3（用户 6 项决策）→ **v3b（用户最终决策：管理后台仅本地账户，SSO/LDAP 均不进后台）**
> 审计过程：4 个独立角色 agent（安全架构 / UX&产品 / 首席工程 / 合规治理）并行审计 v1 并出报告，v3b 为全部决策收敛后的定稿。

---

## 0. 执行摘要

以**企业视角**统一设计：**身份（RBAC 角色）→ 门户（webadmin 分区）→ 登录（客户端两步式）→ 品牌（三处展示）→ 门户首页（自定义+客户端下载）**，全部由服务端配置驱动，服务端强制（非前端隐藏）。

### v3 关键决策（用户拍板）

| # | 决策 | 定案 |
|---|---|---|
| 1 | **移除 operator 运维角色** | 角色收敛为 3 元：`super_admin / auditor / user`（企业级功能权限细分通过权限点保留，但用户面角色简单化） |
| 2 | **审计账号不允许使用客户端** | auditor 仅 webadmin 只读审计工作台；客户端登录时按 role 拒绝进入（服务端 login 响应 role=auditor → 客户端显示「审计账号不可登录客户端，请使用管理后台」并终止） |
| 3 | **隐藏本地登录，但管理后台必须本地登录** | `auth.hide_local`（默认关闭）：启用后**客户端登录页不显示本地账号入口**（仅显示 IdP 方式）；**管理后台恒仅本地账户登录**（SSO 与 LDAP 均不允许进后台，与 hide_local 无关） |
| 4 | **默认首页可自定义 + 客户端下载地址** | 服务端根路径 `/` 与 webadmin 首页可由管理员定制（欢迎语/应用栏/客户端下载链接），品牌配置页扩展「门户首页」配置块 |
| 5 | **品牌快照** | v1 内置：`brand_snapshots` 表 + 自动快照 + 恢复上一版本（已定） |
| 6 | **审计导出** | v1 只做「审计页 CSV 导出」轻量版；SIEM webhook 放 P2（已定） |
| 7 | **管理后台仅本地账户（v3b 新增）** | **SSO（OIDC/OpenID）与 LDAP 一律不进管理后台**。webadmin 登录仅本地账号密码；`AuthenticateConfiguredAdmin` 改为只尝试 local；LDAP 仅服务端员工面可用；SSO 仅客户端生效 |

---

## 1. 角色与权限模型（RBAC，3 元）

### 1.1 角色定义

| 角色 | 语义 | 登录面 | 权限特征 |
|---|---|---|---|
| `super_admin` 超级管理员 | 企业系统所有者 / 配置者 | webadmin 全量 + 客户端可用 | 全量权限点；唯一可改认证/角色/品牌/审计保留策略/密钥轮换 |
| `auditor` 审计员 | 合规/审计人员 | **仅 webadmin 只读审计工作台**（禁客户端） | `audit:read` + 脱敏 `usage:read` + 脱敏 `user:read` + 登录日志；**零写** |
| `user` 普通员工 | 最终用户 | 客户端（全功能） | 无任何 `/api/admin/*` 权限（403） |

> **企业视角注释**：v2 的 operator 被用户拍板移除——「企业级功能权限细分」由权限点（`rolePerms` 表）承载，但用户面角色仅 3 元，避免角色爆炸。未来需要运维专职时，可重新引入 operator（只需在 `rolePerms` 加一行 + 迁移 CHECK 约束加值），权限引擎不变。

### 1.2 权限点清单（`server/internal/serverauth/rbac.go`）

```go
const (
    PermUserRead        = "user:read"
    PermUserWrite       = "user:write"       // 增改删用户、配额
    PermRoleAssign      = "role:assign"      // 角色分配/提权降权
    PermDeptRead        = "dept:read"
    PermDeptWrite       = "dept:write"
    PermAuthRead        = "auth:read"        // 认证配置（脱敏）
    PermAuthWrite       = "auth:write"       // 认证配置（含 client_secret / hide_local）
    PermGatewayRead     = "gateway:read"
    PermGatewayWrite    = "gateway:write"
    PermUsageRead       = "usage:read"
    PermQuotaWrite      = "quota:write"
    PermMarketRead      = "market:read"
    PermMarketWrite     = "market:write"
    PermCapabilityRead  = "capability:read"
    PermCapabilityWrite = "capability:write"
    PermConnectorRead   = "connector:read"
    PermConnectorWrite  = "connector:write"
    PermAuditRead       = "audit:read"
    PermAuditRetention  = "audit:retention:write"
    PermBrandRead       = "brand:read"
    PermBrandWrite      = "brand:write"
    PermPortalRead      = "portal:read"      // 门户首页自定义（含客户端下载地址）
    PermPortalWrite     = "portal:write"
    PermServerInfoRead  = "server-info:read"
    PermErrorMonRead    = "error-monitoring:read"
)
```

角色→权限映射（Go 内表，不落 DB）：

```go
var rolePerms = map[string][]string{
    "super_admin": {All}, // 全量
    "auditor":     {PermAuditRead, PermUsageRead, PermUserRead}, // 只读三元组
    "user":        {},
}
```

### 1.3 数据模型与迁移

**迁移 `0046_rbac_roles.sql`（PG-only）**：

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('super_admin','auditor','user'));
UPDATE users SET role = 'user' WHERE is_admin = 0 AND role = 'user';
UPDATE users SET role = 'super_admin' WHERE is_admin = 1 AND role = 'user';
```

- **回填语义**：`is_admin=1` → `super_admin`（存量全量权限不收缩）；`is_admin=0` → `user`。
- **双真源**：`is_admin` 保留列不再写入新值；全部读点切 `role`；`User.IsAdmin()` 单源方法 `return u.Role == "super_admin"`。
- `ValidateAdminSession` → `role != 'user' && status == 1`（auditor 可入管理门户，按权限点细分；但客户端登录侧 auditor 拒绝，见 §4.5）。

### 1.4 权限判定引擎（服务端强制）

```
AdminAuth (会话+CSRF) → RequirePermission(perm) (403 FORBIDDEN)
```

- 新增 `serverauth/admin_rbac.go`：路由表 `{method, path, perm}` 集中声明**全部** `/api/admin/*`。
- 各业务包（marketplace/agentshare/sharedskills/capabilities/connectors/llmgateway）的 `RegisterAdminRoutes` 改为**登记 handler 进集中表**（不另起 group，避免分裂中间件链）；CSRF/body 上限/会话由 serverauth 统一组装。
- `/api/admin/login`、`/api/admin/auth/methods` 保持公开。
- `HasPermission(user, perm)` 纯函数（无 DB）。
- **fall-open 防护**：`init()` 遍历 gin 全部路由断言每条 `/api/admin/*` 有 perm 映射，缺失 panic（测试兜底）。

### 1.5 员工面角色下发

- `/api/auth/login`、`/api/auth/me`、`/api/config/bootstrap` 增 `role` + `permissions`（员工面单点来源）。
- `userJSON` 增 `"role"`；auditor 员工面登录（login 响应 role=auditor）→ 客户端侧拦截（§4.5）。

---

## 2. webadmin 门户重设计

### 2.1 信息架构：分区 + 角色导航矩阵（3 元简化）

| 分区 | 页面 | super_admin | auditor |
|---|---|---|---|
| **运营管理** | 用户 / 角色权限 / 部门 / 认证 / 品牌 / 门户首页 | ✅ | ❌ |
| **系统运维** | 网关 / 市场·技能 / 能力中心 / 连接器 / 服务器信息 / 错误监控 / 用量 | ✅ | ❌ |
| **审计追溯** | 审计日志 / 用量报表(脱敏只读) / 登录日志 | ✅ 可读 | ✅ **只读** |

- nav 按 `permissions` 动态渲染（体验层）；每页 API 走 `RequirePermission`（安全层）。**「菜单是体验，权限是护栏；只隐藏不设防 = 假安全」**。
- 默认落地页：`/` → 分析角色第一个有权限分区（super_admin→运营管理；auditor→审计追溯）；user 无 webadmin 权限 → 显示「无权限，请使用客户端」页 + 客户端下载链接（门户首页可作为未认证入口，§2.1b）。
- auditor 登录后顶部「只读模式」横幅。

### 2.1b 门户首页（新：自定义默认首页）

**背景**：webadmin `App.tsx` 当前 `path="/" → Navigate to="/users"`（默认跳到用户管理，登录后无"首页"概念；服务端根路径 `/` 404）。v3 新增**门户首页**概念：

- **认证前**（未登录访问 `/admin/` 或服务端根 `/`）：展示**门户首页**（品牌 login 配置 + 欢迎语 + **客户端下载地址** + 登录入口）。这解决「默认首页空」问题，同时给新员工/外部访客提供客户端下载入口。
- **认证后**：跳转角色默认分区（可配置 `portal.landing_path` 覆盖）。
- **服务端根路径 `/`**：不再 404，返回门户首页 HTML（与 `/admin/` 一样的 SPA 入口或独立轻量页）；`/login` 已有（`webServer` 客户端登录页 `/login` 是桌面端接口——注意区分：服务端 `/` 与 webadmin `/admin/` 是浏览器面，桌面客户端登录页由 auth-gate 内嵌，不受影响）。

**门户配置键**（settings，`portal.*` 前缀）：

| 键 | 含义 | 默认 |
|---|---|---|
| `portal.enabled` | 启用自定义门户首页 | `true` |
| `portal.welcome` | 欢迎语标题 | 空 |
| `portal.subtitle` | 副标题 | 空 |
| `portal.client_download_url` | **客户端下载地址**（GitHub Releases / 内网分发链接） | 官方 Releases URL |
| `portal.client_download_note` | 下载说明文字 | 空 |
| `portal.landing_path` | 登录后默认落地页 | ``（角色默认） |

**客户端下载地址来源**：`client_download_url` 可由管理员填任意 URL（默认 GitHub Releases `https://github.com/picoaide/picoaide-harness/releases/latest`）；门户页展示下载按钮 + 说明。**品牌/门户一致性**：门户页复用 `brand.login.*`（logo/名称/副标题），与登录页同源。

### 2.2 角色权限管理页（新：替换 Users.tsx is_admin switch）

- 创建/编辑用户：**角色选择器**（radio 卡片，3 选项各带一句话解释：super_admin「全量管理」/ auditor「只读审计，不可使用客户端」/ user「普通员工，使用客户端」）。
- 变更角色：二次确认（后果文案）+ `role_change` 审计（old→new+操作者）。
- 移除最后一个 super_admin：阻塞确认 + `ErrLastAdmin` 守卫（保留）。
- **auditor 不可提升**（无权限点证明——仅 super_admin 可做 `role:assign`）。

### 2.3 认证配置页重设计（驱动式 Tab 分区 + 登录面矩阵）

**登录面矩阵（v3b 核心）**——先明确定义每种方式在两类登录面中的可用性：

| 认证方式 | 客户端（桌面） | 管理后台（webadmin） | 说明 |
|---|---|---|---|
| 本地账号 local | 默认可用（`hide_local` 可隐藏入口） | **✅ 唯一允许** | 管理后台恒仅本地账户 |
| LDAP | ✅ 员工面可用 | ❌ **禁止** | 后台登录不再走 `ldap` provider |
| OpenID / OIDC（SSO） | ✅ 唯一 SSO 展示面 | ❌ **禁止** | OIDC 回调只签员工 token，永不建 admin session |

**服务端强制**（v3b）：
- `AuthenticateConfiguredAdmin` 改为**只尝试 local**（删除 `order := []string{"ldap", "local"}` 的 ldap 分支）；`configuredAdminOnly` 语义 = 仅本地账号 + `role != 'user'`。
- **LDAP 员工面不变**（`/api/auth/login` 仍走 ConfigureProviders 的 ldap 员工认证）；仅 webadmin 的 `handleLogin` 改走 local-only 辅助函数。
- **SSO 仅客户端生效**：OIDC/OpenID 回调逻辑不变（签发员工 API token → `picoaide://` 深链），**永不**为 webadmin 建 admin session——现状已如此，v3b 明确其为契约（写测试断言）。

**新 IA**（v2 保持，追加 `hide_local`）：

```
┌ 认证方式 ───────────────────────────────────────────────┐
│ [本地账号✓恒启用(后台)] [LDAP] [OpenID] [OIDC]  ← Tab    │
├──────────────────────────────────────────────────────────┤
│ 启用开关 ● (未配齐必填项时禁用+提示"完成配置后可启用")     │
│ 基础字段：服务器地址 / Bind DN / Base DN / 用户过滤        │
│ ▸ 高级（折叠）：组过滤 / 组属性 / TLS / 超时               │
│ [测试连接] [保存]                                        │
├──────────────────────────────────────────────────────────┤
│ ● 隐藏客户端本地登录入口 (auth.hide_local)               │
│   说明：仅作用于客户端登录页（员工端）。管理后台恒仅本地   │
│   账户登录（SSO/LDAP 均不进后台，不受此开关影响）。        │
└──────────────────────────────────────────────────────────┘
```

- **`auth.hide_local`**（v3）：默认 `false`；`true` 时**仅客户端登录页** `methods` 端点返回 local `hidden:true`（客户端不渲染本地方式卡片）；**管理后台本地登录恒可用、不受此开关影响**。服务端 local 认证恒接受（admin 回退）。
- **webadmin 登录页**（`Login.tsx` 重设计）：**移除全部 SSO/LDAP 卡片与跳转按钮**（现有 `METHOD_META` 含 ldap/openid/oidc 误导路径），只保留**单一本地账号密码表单**（用户名+密码+登录按钮）。LDAP 管理员改用本地账号登录后台（企业 LDAP 管理员账号 ≠ 后台管理员账号；后台本地账户独立管理）。
- 版本兼容：`/api/admin/auth/methods` 响应 local 增加 `"hidden": bool`（hide_local 时 true）。

### 2.4 品牌配置页（新，含门户首页）

见 §5（品牌 + 门户首页合并为一个配置页，Tab：登录页品牌 / 客户端品牌 / 门户首页）。

### 2.5 审计增强

- 事件补齐：`login_success` / `login_fail`(username+IP) / `logout` / `role_change` / `auth_config`(字段级) / `brand_update` / `brand_snapshot` / `portal_update` / `quota_update` / `budget_update` / `token_revoke` / `export`。
- 保留策略：`audit.retention_days` 默认 180；安全/权限/认证类强制 365 天。
- **prev_hash 哈希链**：`audit_logs` 加列；写入链式计算；服务层只增（`PurgeOldAuditLogs` 按策略整块删，删前导出）；**auditor 只读不可改**。
- 审计页：auditor 可查全部（脱敏：凭证不可见/费用按日聚合/用户邮箱脱敏域名）+ **CSV 导出**（v1 轻量版，记 `export` 审计）。

### 2.6 登录与会话安全

- `AdminSessionTTL` 24h → 12h 硬上限 + 空闲 60min 滑动（`admin_sessions.last_used_at`）。
- 登录限流扩展（含 OIDC 回调）+ `login_fail` 审计。
- CSRF 覆盖全部非 GET（含品牌 multipart 上传）。
- 生产强制 HTTPS（部署层，文档要求）。

---

## 3. 服务端品牌 API

### 3.1 配置键（settings KV，不新增表）

| 键 | 含义 | 默认 |
|---|---|---|
| `brand.enabled` | 启用自定义品牌 | `false` |
| `brand.login.logo/display_name/tagline/welcome` | 登录页 | 空/`PicoAide`/`Enterprise AI Gateway`/空 |
| `brand.client.logo/display_name/tagline/accent` | 客户端 | 空/`PicoAide Harness`/空/空 |
| `brand.favicon` | favicon | 空 |
| `brand.title` | 页面标题后缀 | `PicoAide Harness` |

### 3.2 端点

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/brand` | 公开 | 品牌全量（`enabled=false` 返回空配置，防旧 logo 缓存） |
| `GET /api/brand/logo/:name` | 公开 | `name∈{login,client,favicon}` 白名单；ETag 短缓存；`nosniff` |
| `GET/PUT /api/admin/brand` | `brand:read`/`brand:write` | 文本字段 JSON；logo multipart |
| `DELETE /api/admin/brand/logo` | `brand:write` | 移除 logo |

**Logo 文件**：`dataDir/brand/`（0700）；文件名白名单；≤4MB；扩展名→MIME 白名单（不做嗅探）；**SVG sanitize**（strip script/on*/javascript:）；`nosniff`。

**品牌快照**（v3 保留）：`brand_snapshots` 表（`created_at`+JSON），每次 `brand_update` 自动存前版（保留 10 份）；配置页「恢复上一版本」/「恢复默认」。

**portal 端点**（§2.1b）：`GET /api/portal`（公开，门户首页文案+客户端下载地址）；`GET/PUT /api/admin/portal`（`portal:read`/`portal:write`）。

### 3.3 methods 端点增强

`/api/admin/auth/methods` 增加 `browser: bool` + `hidden: bool`（hide_local 时 local hidden=true）。

---

## 4. 客户端改造（dsh-enterprise）

### 4.1 登录页两步式

```
[Step1 服务端地址] ──下一步──▶ [探测/拉取中] ──任一成功──▶ [Step2 品牌+登录方式]
        ▲                            │均失败(内联报错,按钮不置灰)│
        └────────────────────────────┘                        │
                                                              ▼
                                          [方式选择器+表单/跳转登录按钮]
```

- **Step 1**：URL 输入 +「下一步」**不置灰**；并行拉 `/api/brand` + `/api/pico/auth/methods?server=<url>`；均失败停留 Step1 内联报错；任一成功进 Step2。
- **Step 2 品牌区**：logo/名称/副标题/欢迎语/主色（`client.accent` 强调色）+ 固定占位高（防跳动）。无配置回退默认。
- **Step 2 登录方式区**：
  - 1 种 → 直接内联；>1 种 → 方式卡片选择器（label+desc+配置徽章）；未配置置灰。
  - 密码类（local/ldap）→ 用户名+密码表单；浏览器类（browser:true）→ 「使用 <label> 登录」+轮询授权。
  - **hide_local=true 时**：local 卡片（`hidden:true`）不渲染（仅显示 IdP/浏览器方式）；但服务端 local 仍有效（admin 回退）。
- 「修改地址」回 Step1（localStorage 预填，可清除）。

> **客户端 = 唯一 SSO 展示面**（v3b）：客户端登录页展示 `local/ldap/openid/oidc` 中服务端启用的全部方式（local 可被 hide_local 隐藏），SSO 跳转仅发生在客户端；管理后台登录页不展示任何 SSO/LDAP 入口。

### 4.2 登录后品牌三处展示

| 位置 | 数据源 | 实现 |
|---|---|---|
| sidebar 品牌 mark/name | `brand.client.*` | `Brand.tsx` 动态化（logo_url 用 `<img>`，失败回退花括号） |
| hero 品牌 mark+headline | `brand.client.*` | mark 同 logo；headline CSS content 注入 display_name |
| **右上角**（新） | `brand.client.logo+display_name` | 注册 `conversation.session.header.actions` slot → `BrandBadge`（logo 24px+名称，纯装饰） |
| 页面标题 | `brand.title` | `document.title` |

**Host 侧 `brand-sync.ts`**：`SESSION_CHANGED_EVENT` → 拉 `GET /api/brand`（带 token）→ 内存 store（serverURL 键控）→ emit `pico/brand-changed`；登出清空回退默认。

### 4.3 认证方式归类

`/api/pico/auth/methods` 转发服务端 `browser`+`hidden` 标记；客户端判定只用 `m.browser` / `m.hidden`（删除硬编码 openid/oidc 白名单）。

### 4.4 客户端角色差异化（仅 user 可用）

- 登录/restore 时 session 存 `role`。
- **auditor**（v3 决策 2）：**禁止使用客户端**。实现：
  - 服务端：`login` 响应携带 role；客户端登录成功后检查 `role === 'auditor'` → **不保存 session**，显示「该账号为审计账号，仅可登录管理后台查看审计信息，请使用浏览器访问 `<server>/admin/`」+ 打开该 URL（`shell.openExternal`），并终止登录流程（登录页保持）。
  - 深链回调同样处理（role=auditor → 拒绝 + 提示）。
  - 服务端侧再兜底：桌面客户端 `BearerAuth` 对 auditor 的 `/v1/*` 调用若被误放行，网关层按 role 拒绝（审计账号不得产生 LLM 调用）——**审计账号员工面 API 全拒**（`/api/auth/*` 只放行 me/logout，`/v1/*` 403，`/api/config/bootstrap` 403），确保「不允许使用客户端」在服务端强制。
  - **注意**：auditor 的 webadmin 会话（cookie）与员工面 token（Bearer）是两套——auditor 可登录 webadmin（cookie），但**不可取得员工面 token**（login 端点拒绝 auditor 发 token？——需取舍：auditor 用 webadmin 登录，员工 login 端点对 auditor 返回 AUTH_FAILED「审计账号不可登录客户端」）。**决策**：员工面 `/api/auth/login`（local/ldap/oidc/openid 密码流）对 `role=auditor` 一律拒绝（401 带原因码 `AUDITOR_NOT_ALLOWED`）；webadmin `/api/admin/login` 不受限（auditor 用该入口进审计工作台）。
- super_admin / user：客户端无额外限制。

### 4.5 客户端代理角色校验（双保险）

- Host 侧 `/api/pico/*`（capabilities/connectors/skills 等写类）按 session.role 校验：role=auditor 因 §4.4 已不可能有 session，但防御性断言（如未来放开边界，此处拦截）。

---

## 5. 品牌 + 门户首页配置页（webadmin）

### 5.1 布局（3 Tab + 预览窗）

```
┌ 品牌与门户 ─────────────────────────────────────────┐
│ ● 启用自定义品牌                          [恢复默认] │
│ ┌ 登录页品牌 [客户端品牌] [门户首页] (Tab) ────────┐ │
│ │ 登录页: Logo 上传(预览) 产品名 副标题 欢迎语     │ │
│ │ 客户端: Logo 名称 副标题 主色(取色器+hex)        │ │
│ │ 门户首页: 欢迎语 副标题 客户端下载URL 下载说明    │ │
│ └─────────────────────────────────────────────────┘ │
│ [保存]                    [恢复上一版本]             │
├──────────────────────────────────────────────────────┤
│ 预览窗: 登录页/客户端 hero/门户首页 实时联动          │
└──────────────────────────────────────────────────────┘
```

- **实时预览**：改字段即时反映（同 React state），**保存后生效**。
- **门户首页 Tab**：欢迎语/副标题/客户端下载 URL/说明 + 预览（门户渲染样式）。
- **恢复默认**：明确后果式二次确认；**恢复上一版本**：读 `brand_snapshots` 最近一份。
- logo 校验：≤4MB / svg/png/webp/ico；上传即时预览。
- 服务端强制：PUT 需 `brand:write`/`portal:write`；auditor 无此页（nav 不渲染+API 403）。

### 5.2 webadmin 自身品牌跟随

- webadmin 登录页 + 侧栏品牌从 `GET /api/brand` 拉取（公开端点，登录前可用）；门户首页复用 `brand.login.*` + `portal.*`。
- **服务端根路径 `/`**：返回门户首页（公开；未认证用户可见客户端下载地址与登录入口）——解决「默认首页空」+「客户端下载地址」。

---

## 6. 审计增强汇总

| 事件 | 触发 | 字段 | 保留 |
|---|---|---|---|
| `login_success` / `login_fail` | 员工面+admin 登录+OIDC 回调（含 auditor 拦截） | username, source_ip, method | 365d |
| `logout` | 员工/管理端登出 | username | 365d |
| `role_change` | 角色分配/变更 | user, old, new, operator | 365d |
| `auth_config` | 认证配置变更（字段级） | changed keys（脱敏） | 365d |
| `brand_update` / `brand_snapshot` | 品牌/门户保存/回滚 | diff 摘要 | 365d |
| `portal_update` | 门户首页变更 | diff | 365d |
| `quota_update` / `budget_update` | 配额/部门预算 | user/dept, old, new | 365d |
| `token_revoke` / `token_rotate` | token 吊销/轮换 | user, token_id | 365d |
| `user_update` / `dept_update` / `market_*` / `connector_*` / `gateway_*` | 既有 | 既有 | 90d |
| `export` | 审计 CSV 导出 | 导出范围 | 365d |

- prev_hash 哈希链 + 保留策略 `audit.retention_days`（默认 180；安全类强制 365）。
- auditor 脱敏视图（凭证不可见/费用按日/邮箱脱敏域名）。

---

## 7. 实施阶段与仓库边界

> 分支：`feat/enterprise-rbac-brand`。服务端改动限 `server/`；客户端限 `packages/host/enterprise/` 与 `packages/host/desktop/`（品牌槽在 enterprise 插件）；上游不动（`deepseek-harness/` 只读）。

### Phase 0：RBAC 基础（高风险，先行，独立提交）
- [ ] 0.1 迁移 `0046_rbac_roles.sql`：`users.role`(3 值 CHECK) + 回填 + `admin_sessions.last_used_at`
- [ ] 0.2 `serverauth/rbac.go`：权限点 + rolePerms + HasPermission + RequirePermission + AdminRoles()
- [ ] 0.3 `admin_rbac.go` 路由表收敛（6 业务包登记）+ init() 完整性断言
- [ ] 0.4 userJSON/bootstrap 增 role+permissions；ValidateAdminSession 改 role 判
- [ ] 0.5 handleMe 返回 role/perms；webadmin App.tsx nav 动态权限 + 角色落地页
- [ ] 0.6 角色管理（Users.tsx 角色选择器 + role_change 审计 + 最后 super_admin 守卫）
- [ ] 0.7 测试：路由表完整性 / 角色×权限矩阵 / 迁移回填 / auditor 各写端点 403

### Phase 1：认证配置页重设计 + 登录安全 + hide_local + 后台本地-only
- [ ] 1.1 **服务端强制后台本地-only**：`AuthenticateConfiguredAdmin` 改为只尝试 local（删除 ldap 分支）；新增 `localAdminOnly` 测试断言（ldap 模式 / OIDC 回调均不得产生 admin session）
- [ ] 1.2 Auth.tsx 重构（Tab 分区+启用绑定配置+测试连接+auditor 只读脱敏）+ 登录面矩阵提示（「SSO/LDAP 仅员工面，后台恒本地」）
- [ ] 1.3 **webadmin Login.tsx 重设计**：移除 SSO/LDAP 方式卡片与跳转按钮，只保留单一本地账号密码表单
- [ ] 1.4 `auth.hide_local` 键 + methods `hidden` 标记（仅客户端消费；后台登录忽略）
- [ ] 1.5 redirect_url 校验 + 认证改动字段级审计
- [ ] 1.6 会话 12h+空闲 60min；限流扩展 + login 审计事件

### Phase 2：品牌 + 门户首页（服务端 + webadmin）
- [ ] 2.1 `internal/brand/` 包：/api/brand + /api/admin/brand + logo 白名单/sanitize/ETag + brand_snapshots
- [ ] 2.2 `internal/portal/`（或并入 brand 包）：/api/portal + /api/admin/portal (portal.* settings)
- [ ] 2.3 webadmin Brand.tsx（3 Tab+实时预览+恢复默认/上一版本）
- [ ] 2.4 服务端根路径 `/` 返回门户首页；webadmin 登录页/侧栏品牌跟随
- [ ] 2.5 methods `browser` 标记
- [ ] 2.6 测试：品牌/门户端点（启用/关闭/上传/白名单/sanitize/快照/门户）

### Phase 3：客户端（登录两步式 + 品牌 + auditor 拦截）
- [ ] 3.1 auth-gate.ts Step1/Step2 + brand/methods 并行探测 + 方式选择器（browser/hidden）
- [ ] 3.2 brand-sync.ts + Brand.tsx 动态化 + 右上角 BrandBadge + hero/accent
- [ ] 3.3 auditor 登录拦截（login 响应 role=auditor → 拒存 session + 提示打开 admin + 服务端员工面全拒）
- [ ] 3.4 客户端代理角色校验（/api/pico/* 写类防御断言）
- [ ] 3.5 测试：dsh-enterprise（Step 状态机/brand-sync/BrandMark/browser/auditor 拦截）

### Phase 4：审计增强 + 联调
- [ ] 4.1 audit_logs prev_hash 链 + 审计事件补齐 + 保留策略 + Audit.tsx（脱敏视图+CSV 导出）
- [ ] 4.2 端到端：super_admin/auditor/user 登录 webadmin 见各自分区；auditor 写 403；auditor 客户端拦截；OIDC 深链回归；门户首页展示下载地址
- [ ] 4.3 门禁：`make check` + `yarn check` 全绿

---

## 8. 风险与权衡

| 议题 | 权衡 | 决策 |
|---|---|---|
| operator 移除 | 用户拍板：角色简化 3 元；权限点保留细分能力 | 3 元（未来可加） |
| auditor 禁客户端 | 审计账号零使用风险；但 auditor 无法用 AI | 用户拍板：仅 webadmin 只读；员工面全拒 |
| hide_local | 客户端隐藏 vs 后台必须本地登录 | `auth.hide_local` 只作用于客户端登录页；后台恒本地 |
| **后台仅本地账户**（v3b） | 管理员需独立维护本地账户（不进 LDAP/SSO）；换来后台认证链路极简、无 IdP 故障影响后台可用性 | **用户拍板**：SSO/LDAP 一律不进后台；`AuthenticateConfiguredAdmin` local-only |
| 门户首页 | 默认空 → 自定义+客户端下载地址 | `portal.*` + 服务端 `/` 门户 + 下载 URL |
| 品牌快照 | 成本低合规加分 | v1 内置 |
| 审计导出 | SIEM 重 | v1 CSV 轻量；SIEM P2 |
| 员工面 auditor 全拒 | 员工 login 端点拒 auditor 会否影响 webadmin（不会，webadmin 走 /api/admin/login cookie 会话） | 安全优先 |

---

## 9. 开放问题（低优先，可后议）

1. **门户首页是否对未认证开放**：默认开放（含客户端下载），企业敏感内网可要求登录后才见（`portal.public` 键，默认 true）——是否要？默认开放，可后配。
2. **auditor 客户端拦截提示文案**：是否需要提供「切换账号」快捷入口？（默认提示+打开 admin URL）
3. **`portal.client_download_url` 默认值**：官方 GitHub Releases（已定）——是否改成内网分发（默认仍官方）。

---

## 10. 验收标准

1. 3 角色登录 webadmin：super_admin 全量 / auditor 只读审计分区 / user 403（无权限页+客户端下载提示）
2. **后台仅本地账户**：webadmin 登录页仅本地账号密码表单（无 SSO/LDAP 入口）；`AuthenticateConfiguredAdmin` local-only（ldap 模式 / OIDC 回调均不产生 admin session，测试断言）
3. auditor 员工面登录被拒（服务端 401 `AUDITOR_NOT_ALLOWED`）+ 客户端不存 session + 提示打开 admin
4. 认证配置页 Tab 分区 + 启用绑定配置 + 测试连接 + hide_local（客户端隐藏 local；后台登录不受影响）
5. 客户端登录页两步式：品牌正确 + methods(browser/hidden) 渲染 + 不可达停留 Step1
6. 客户端登录后三处品牌（sidebar/hero/右上角）跟随服务端
7. 门户首页：服务端 `/` 与 webadmin 未登录可展示自定义欢迎语+客户端下载地址
8. 审计：login 成败/角色变更/品牌/门户变更留痕 + 哈希链 + 保留策略 + CSV 导出
9. `make check` + `yarn check` 全绿；rbac 路由表完整性断言测试通过
