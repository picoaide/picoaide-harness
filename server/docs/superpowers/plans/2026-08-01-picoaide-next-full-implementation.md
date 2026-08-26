# PicoAide-Next 全量实施计划

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全新重写企业内网桌面 AI 办公智能体:Electron+React+TS 桌面客户端(本地跑完整 Agent)+ Go 服务端纯网关(认证/AI 网关/双商城/知识库)。

**Architecture:** 客户端(Agent 引擎基于 Vercel AI SDK streamText 多步循环,本地工具 + 本地受限沙盒执行 + 本地 MCP/Skill 运行时 + better-sqlite3 会话,消息持久化、中断可重跑恢复;**员工零配置:登录即用,模型/技能/MCP 建议全部由服务端 bootstrap 下发,所有配置由管理员在管理页完成**)经 Bearer token 连服务端;服务端(AI 网关 OpenAI 兼容代理 + LDAP/OIDC/本地认证 + Skill/MCP 商城(建议安装制)+ 知识库远程 MCP + 极简管理页)。零代码迁移,旧仓库 `/data/picoaide` 仅作参考。

**Tech Stack:** 服务端 Go 1.24+(gin、modernc.org/sqlite、argon2id、AES-GCM、FTS5);客户端 Electron + TypeScript + React 18 + electron-vite + Vercel AI SDK(`ai`、`@ai-sdk/openai-compatible`、`@ai-sdk/sandbox-just-bash`)+ better-sqlite3 + @modelcontextprotocol/sdk + tesseract.js + iconv-lite + Vitest。

**前置参考(只读,禁止复制):** `/data/picoaide/internal/store/users.go`(argon2)、`/data/picoaide/internal/store/migrations/`(迁移命名)、`/data/picoaide/internal/authsource/`(认证注册表)、`/data/picoaide/internal/skill/`(技能解析)。

---

## 0. 总体执行框架(所有阶段通用)

### 0.1 仓库与约定

- 仓库:`/data/picoaide-next`,module 名 `github.com/picoaide/picoaide`
- 分支:开发在 `dev` 分支(自 `master` 切出),每任务完成后 commit 到 dev;阶段验收后合并 master
- 提交信息:`feat: / fix: / test: / docs: / chore:`,单行 ≤72 字符,如 `feat: add api token auth middleware`
- 每个任务结束必须 commit,不允许"多个任务一个 commit"

### 0.2 目录规约(与设计文档 §3.2 一致)

```
cmd/server/ internal/{serverauth,llmgateway,marketplace,knowledge,serverstore,util,bootstrap}(服务端 Go)
desktop/{src/{main,preload,renderer},tests}(Electron 客户端 TS)
browser-extension/(浏览器插件 MV3:manifest/background/content/options)
webadmin/ docs/ scripts/ data/
```

### 0.3 Makefile 目标(任务 1.1 建立,全程维护)

| 目标 | 内容 |
|------|------|
| `make test` | `go test ./... -count=1`(服务端 Go 代码) |
| `make test-server` | `go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/knowledge/... ./internal/serverstore/... -count=1` |
| `make test-client` | `cd desktop && npm test && npm run typecheck`(客户端 Vitest) |
| `make build-client` | `cd desktop && npm run build`(electron-vite 产出 `desktop/out/`;`dist/` 为 electron-builder 打包输出) |
| `make webadmin` | `cd webadmin && npm run build` |
| `make build-server` | 编译 `bin/picoaide-server` |
| `make build-desktop` | `cd desktop && npm run build && npx electron-builder --dir`(本地调试包,产出 `desktop/dist/`) |
| `make docker-image` | `docker buildx build --platform linux/amd64 -t ghcr.io/picoaide/picoaide-harness-server .`(amd64 镜像,阶段 4) |
| `make check` | format + lint(go vet + tsc)+ test |
| `make pkg-linux` / `pkg-windows` / `pkg-macos` | 阶段 4 打包(Linux 本机;Windows/macOS 走 CI 矩阵) |

### 0.4 公共契约(先固化,所有实现对齐)

#### 0.4.1 REST 错误格式

所有非 2xx 响应体:

```json
{"error": {"code": "ERR_CODE", "message": "人类可读信息"}}
```

错误码约定:`AUTH_REQUIRED`(401)/ `AUTH_FAILED`(401)/ `FORBIDDEN`(403,**管理端非超管操作**)/ `NOT_FOUND`(404)/ `VALIDATION`(400)/ `UPSTREAM`(502)/ `RATE_LIMITED`(429)/ `INTERNAL`(500)。

#### 0.4.2 认证头

- 客户端 API:`Authorization: Bearer <api_token>`
- 管理页:`Cookie: picoaide_session=<session_id>` + CSRF 头 `X-CSRF-Token`

#### 0.4.3 流式 LLM 事件(客户端 UI 协议)

Electron main 进程经 ipc(`agent:event`)发送给 renderer 的事件:

```json
{"type":"text_delta","data":"..."}
{"type":"reasoning_delta","data":"..."}
{"type":"tool_start","data":{"id":"...","name":"file_read","input":{...}}}
{"type":"tool_end","data":{"id":"...","name":"file_read","output":"...","duration_ms":120}}
{"type":"tool_error","data":{"id":"...","name":"...","error":"..."}}
{"type":"confirm_required","data":{"request_id":"...","op":"file_delete","target":"/home/u/x.doc","reason":"删除文件"}}
{"type":"artifact","data":{"path":"/home/u/picoaide/workspaces/1/reports/2026-08-01.md","type":"file","size":1234}}
{"type":"done","data":{"usage":{"prompt_tokens":100,"completion_tokens":50}}}
{"type":"canceled","data":{"reason":"user_canceled"}}
{"type":"error","data":"错误信息"}
```

#### 0.4.4 工具 JSON Schema 约定

工具定义用 AI SDK `tool({ description, inputSchema: z.object({...}), execute })`(zod 模式,序列化后为 OpenAI function-calling schema,服务端网关原样转发)。注册在 `desktop/src/main/agent/engine.ts` 的工具注册表。

#### 0.4.5 里程碑判定

每个阶段末按"验收清单"逐条手工核对(见各阶段末 Task),全部通过才算完成;未通过则修复后重跑。

---

## 阶段 1:服务端网关(约 2-3 周)

**目标:** 可 curl 全链路验证的网关:登录 → token → AI 网关流式对话 → 拉技能包 → 拉 MCP 配置 → 知识库查询。管理页可用。

**顺序说明:** Task 1.1→1.2→1.3 是地基(串行);1.4→1.7 认证域(串行);1.8→1.10 网关域;1.11 Skill 商城;1.12 凭证加密(前置 1.8 的 key 落库);1.13 MCP 商城(依赖 1.12 解密);1.14→1.15 知识库域;认证/网关/商城/知识库四域完成前互不依赖,可并行;1.16a 管理端会话→1.16b 管理端业务 API(依赖 1.11/1.13 的 admin 端点承接)→1.16c webadmin 前端;1.17 验收在全部之后。

---

### Task 1.1: 仓库骨架

**Files:**
- Create: `go.mod`, `Makefile`, `.gitignore`, `README.md`, `.github/workflows/ci.yml`, `cmd/server/main.go`(最小 HTTP 服务), `internal/serverstore/db.go`(仅 Open + Ping), `internal/util/safe.go`

- [ ] **Step 1: 初始化 module 与目录**

Run: `cd /data/picoaide-next && go mod init github.com/picoaide/picoaide && mkdir -p cmd/server internal/{serverauth,llmgateway,marketplace,knowledge,serverstore,util} desktop/src/{main,preload,renderer} webadmin docs scripts data`
Expected: 目录创建成功,`go.mod` 第一行 `module github.com/picoaide/picoaide`

- [ ] **Step 2: 写最小 main + db 打开测试(红)**

Create: `cmd/server/main.go`(占位:监听 `:8080` 返回 200)、`internal/serverstore/db_test.go`(测试 `Open` 返回非 nil 且 Ping 成功;临时目录建库)
Run: `go test ./internal/serverstore/ -count=1`
Expected: FAIL(db.Open 未定义)

- [ ] **Step 3: 实现 db.Open**

Create: `internal/serverstore/db.go` — 签名 `func Open(path string) (*sql.DB, error)`,用 `modernc.org/sqlite` 驱动(`driverName="sqlite"`,`dsn="file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"`),带 `PRAGMA foreign_keys=ON` 验证
Run: `go test ./internal/serverstore/ -count=1`
Expected: PASS

- [ ] **Step 4: 写 Makefile + .gitignore + 目录 README**

Create: `Makefile`(§0.3 全部目标,先给 `test`/`build-server` 真实实现,其余占位 `@echo "not yet"`)、`.gitignore`(bin/ build/ node_modules/ dist/ data/ *.db)
Run: `make test && make build-server`
Expected: 测试通过,`bin/picoaide-server` 产出

- [ ] **Step 5: 写 util/safe.go 及测试**

Create: `internal/util/safe.go` — `SafePathSegment(s string) bool`(拒绝空、`/`、`\`、`..`、`.`)、`internal/util/safe_test.go`(表驱动:合法/非法样例)
Run: `go test ./internal/util/ -count=1`
Expected: PASS

- [ ] **Step 6: 写 CI 工作流 + embed 占位**

Create: `.github/workflows/ci.yml` — 触发:push/PR;job1(ubuntu):`make test-server` + `go build ./...` + **交叉编译验证 `GOOS=linux GOARCH=amd64 go build ./cmd/server` 与 `GOOS=linux GOARCH=arm64 go build ./cmd/server`**;job2(ubuntu):`[ -f desktop/package.json ] && (cd desktop && npm ci && npm test && npm run typecheck && npm run build) || true`(desktop 目录 2.1 才建,未建时跳过,防阶段 1 期间 CI 红);job3(ubuntu):`[ -d webadmin ] && (cd webadmin && npm ci && npm run build) || true`(webadmin 目录 1.16c 才建,**未建时跳过**;阶段 4 追加三平台**测试+打包**矩阵、Docker amd64 镜像构建与插件 E2E)
Create: `webadmin/dist/index.html` **占位文件**(内容为"webadmin 未构建";1.16a 的 go:embed 依赖此文件存在,否则空目录 embed 编译失败;1.16c 构建后自动替换)
Run: 推送到 GitHub 验证绿
Expected: 三个 job 全绿(1.1-1.16a 期间 job2/job3 自动跳过)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: repo skeleton, Makefile, db open, safe path util"
```

---

### Task 1.2: 迁移框架 + 初始表

**Files:**
- Create: `internal/serverstore/migrate.go`, `internal/serverstore/migrations/0001_init.sql`, `internal/serverstore/migrate_test.go`

- [ ] **Step 1: 写迁移框架测试(红)**

测试要求:`ApplyMigrations(db)` 后 `schema_migrations` 表存在且 version=1;重复调用幂等;迁移失败时返回错误
Run: `go test ./internal/serverstore/ -run TestApplyMigrations -count=1`
Expected: FAIL(ApplyMigrations 未定义)

- [ ] **Step 2: 实现迁移框架**

`migrate.go`:嵌入式 SQL 文件列表(按文件名序),`schema_migrations(version INTEGER PRIMARY KEY, applied_at)`;每个迁移在一个事务内执行并记录版本;失败回滚该迁移
Create: `internal/serverstore/migrations/0001_init.sql`:
- `users(id INTEGER PK AUTOINCREMENT, username TEXT UNIQUE NOT NULL, display_name TEXT, email TEXT, password_hash TEXT, source TEXT NOT NULL DEFAULT 'local', is_admin INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, created_at, updated_at)`
- `groups(id, name UNIQUE, created_at)`、`user_groups(user_id, group_id, PRIMARY KEY(user_id,group_id))`
- `settings(key TEXT PK, value TEXT)`
Run: `go test ./internal/serverstore/ -run TestApplyMigrations -count=1`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: versioned migration framework with initial schema"
```

---

### Task 1.3: 用户/设置数据访问层

**Files:**
- Create: `internal/serverstore/users.go`, `internal/serverstore/users_test.go`, `internal/serverstore/settings.go`, `internal/serverstore/settings_test.go`

- [ ] **Step 1: 写测试(红)**

- `users_test.go`:`CreateUser`(username 冲突报错)、`GetUserByUsername`、`UpdateUser`(改 display_name/status)、`ListUsers`(分页)
- `settings_test.go`:`SetSetting/GetSetting`、`GetAllSettings`(展平 KV map)、覆盖写
Run: `go test ./internal/serverstore/ -run 'TestUsers|TestSettings' -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`users.go`:结构体 `User{ID, Username, DisplayName, Email, PasswordHash, Source, IsAdmin, Status, CreatedAt, UpdatedAt}`,方法签名:`CreateUser(db, *User) (int64, error)`(SQLite `INSERT`+`LastInsertId`,唯一冲突返回 `ErrDuplicate`)、`GetUserByUsername(db, username) (*User, error)`(not found 返回 `ErrNotFound`)、`UpdateUser(db, *User) error`、`ListUsers(db, offset, limit) ([]User, int64, error)`
`settings.go`:`SetSetting(db, key, value)`(UPSERT)、`GetSetting(db, key) (string, bool, error)`、`GetAllSettings(db) (map[string]string, error)`
错误变量集中在 `internal/serverstore/errors.go`:`ErrNotFound`/`ErrDuplicate`(用 `errors.Is` 判断)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: users and settings data access layer"
```

---

### Task 1.4: 密码哈希 + 本地认证

**Files:**
- Create: `internal/util/password.go`, `internal/util/password_test.go`
- Modify: `internal/serverstore/users.go`(加 `AuthenticateLocal`), `internal/serverstore/users_test.go`

- [ ] **Step 1: 写测试(红)**

- `password_test.go`:`HashPassword(pw)` 与 `VerifyPassword(hash, pw)` 往返成功;错误密码失败;hash 含 argon2id 前缀 `$argon2id$`;两次 Hash 不同 salt
- `users_test.go` 增:`CreateUser` 传入明文密码时自动 hash(`CreateUserWithPassword(db, username, password)`),`AuthenticateLocal(db, username, password) (User, error)` 正确/错误密码两分支
Run: `go test ./internal/util/ ./internal/serverstore/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`password.go`:`HashPassword(pw string) (string, error)`、`VerifyPassword(hash, pw string) bool`,参数沿用旧项目设计:memory 64MB、iterations 3、parallelism 2、keyLen 32、salt 16 字节随机;输出格式 `$argon2id$v=19$m=65536,t=3,p=2$<salt_b64>$<hash_b64>`
`users.go`:新增 `CreateUserWithPassword`(内部调 `HashPassword`)与 `AuthenticateLocal`(查用户 → `VerifyPassword` → 校验 status=1)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: argon2id password hashing and local auth"
```

---

### Task 1.5: Token 认证 + 登录/登出 API

**Files:**
- Create: `internal/serverstore/tokens.go`, `internal/serverstore/tokens_test.go`, `internal/serverauth/token.go`, `internal/serverauth/token_test.go`, `internal/serverauth/handler.go`, `internal/serverauth/handler_test.go`
- Create: `internal/serverstore/migrations/0002_tokens.sql`
- Modify: `cmd/server/main.go`(挂 gin 路由)

- [ ] **Step 1: 写测试(红)**

- `tokens_test.go`:CreateToken(存 hash,expires_at=now+90d)、GetTokenByHash、RevokeToken、TokenForUser(列出未吊销)、过期 token 校验失败
- `token_test.go`:`IssueToken(userID)` 返回随机 32 字节 base64url token(明文),内部存 `SHA256(token)`;`VerifyToken(raw) (*store.User, error)` 校验存在/未吊销/**未过期**/关联用户有效
- `handler_test.go`(httptest):`POST /api/auth/login`(正确/错误密码/限流)、`POST /api/auth/logout`、`GET /api/auth/me`(带 token 返回用户信息)、`--bootstrap-admin` 引导(无超管时创建、已有超管时忽略)
Run: `go test ./internal/serverstore/ ./internal/serverauth/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 0002 + 实现**

Create: `internal/serverstore/migrations/0002_tokens.sql`:
```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'desktop',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  expires_at DATETIME NOT NULL,
  last_used_at DATETIME,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tokens_user ON api_tokens(user_id);
```
`handler.go`:gin 路由组 `/api/auth`;登录限流:内存滑动窗口 map[ip+username] 10 次/5 分钟(**有界:上限 10000 条目;满时拒绝新条目(429)且不逐出窗口内活跃条目,过期条目惰性清理;超出返回 429 `RATE_LIMITED`**);登录成功更新 `last_used_at`
**超管引导**:`main.go` 支持 `--bootstrap-admin <username>` 启动参数;密码必须取 env `PICOAI_ADMIN_PASSWORD`(**缺失则启动失败并提示,不打印密码/随机密码到日志**);仅当 `users` 表无任何 `is_admin=1` 用户时生效,已存在超管则忽略——**不做"首注册即超管"注册端点**(存在抢先接管与 TOCTOU 风险)
`main.go`:注册路由,`/api/auth/me` 走 `BearerAuth` 中间件(读 `Authorization` → `VerifyToken` → 注入 context)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: api token issuance and auth endpoints"
```

---

### Task 1.6: LDAP 认证 Provider

**Files:**
- Create: `internal/serverauth/provider.go`(注册表 + 接口), `internal/serverauth/ldap.go`, `internal/serverauth/ldap_test.go`(用测试假 LDAP server 或 mock), `internal/serverstore/groups.go`, `internal/serverstore/groups_test.go`(LDAP 组映射需 groups 数据层)

- [ ] **Step 1: 写接口与测试(红)**

`provider.go`:
```go
type UserInfo struct { Username, DisplayName, Email string; Groups []string }
type PasswordProvider interface {   // 密码认证:local / ldap
  Name() string
  Authenticate(username, password string) (UserInfo, error)
  Configure(cfg map[string]string) error
}
type BrowserProvider interface {    // 浏览器认证:oidc(与密码认证独立,不继承)
  Name() string
  AuthURL(state string) (string, error)
  HandleCallback(code, state string) (UserInfo, error)
  Configure(cfg map[string]string) error
}
```
`provider.go`:注册表 + 上述两接口(与设计 §4.1.1 一致,BrowserProvider 不内嵌 PasswordProvider)
`ldap_test.go`:用 `github.com/jtblin/go-ldap-client`(或同等)的 mock 接口验证:绑定失败返回认证错误;成功返回 UserInfo 且组映射正确
Run: `go test ./internal/serverauth/ -run TestLDAP -count=1`
Expected: FAIL(接口未实现)

- [ ] **Step 2: 实现 LDAP**

`ldap.go`:配置键 `server_url`/`bind_dn`/`bind_password`/`base_dn`/`user_filter`/`group_filter`/`group_attr`,从 `settings` 加载(`serverauth.Configure`);`Authenticate`:匿名/服务账号绑定 → 用户搜索(**username 必须过 `ldap.EscapeFilter` 转义,防 LDAP 注入**)→ 用户绑定验证密码 → 组搜索
`handler.go` 修改:登录时按 settings `auth.mode`(local|ldap|both)路由到对应 provider;LDAP 用户首次登录自动建本地 `users` 行(source='ldap')并**将组映射写入 `user_groups`(1.2 已建表)——需同步建 groups 数据层(`serverstore/groups.go`:`GetOrCreateGroup(name)`/`UserGroups(userID)`,1.3 的 Files 未含,此处补建)——知识库文件夹权限(`kb_folder_groups`)依赖此数据;webadmin 组管理界面二期;本地账号部署无组映射,知识库以用户级授权兜底**
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: LDAP password provider with auto-provisioning"
```

---

### Task 1.7: OIDC 认证 Provider

**Files:**
- Create: `internal/serverauth/oidc.go`, `internal/serverauth/oidc_test.go`

- [ ] **Step 1: 写测试(红)**

用 `github.com/coreos/go-oidc/v3` + httptest 起假 IdP(issuer/discovery/keys/token 端点),验证:授权码兑换 token、ID token 解析出 username/email、错误 code 返回认证失败
Run: `go test ./internal/serverauth/ -run TestOIDC -count=1`
Expected: FAIL

- [ ] **Step 2: 实现 OIDC**

`oidc.go`:`BrowserProvider` 接口扩展(在 provider.go 中定义):
```go
type BrowserProvider interface {
  PasswordProvider
  AuthURL(state string) (string, error)     // 授权 URL
  HandleCallback(code, state string) (UserInfo, error)
}
```
端点:`GET /api/auth/oidc/login`(返回 authURL)、`GET /api/auth/oidc/callback`(code 兑换 → 建/取用户 → **颁发正式 api_token(90 天,与登录 token 同构)** → 重定向 `picoaide://auth?token=...` 给客户端 scheme;**URL 日志风险由 OS 协议拉起确认缓解,不缩短 token 时效**)
配置键:issuer/client_id/client_secret/redirect_url
**状态管理**:state + PKCE verifier 服务端存内存/session(重启失效,注明);校验 nonce;state 不匹配拒绝
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: OIDC browser provider with callback flow"
```

---

### Task 1.8: AI 网关 — OpenAI 兼容代理(核心)

**Files:**
- Create: `internal/llmgateway/handler.go`, `internal/llmgateway/upstream.go`, `internal/llmgateway/handler_test.go`
- Modify: `cmd/server/main.go`、`internal/serverstore/migrations/0003_gateway.sql`

- [ ] **Step 1: 写测试(红)**

- `handler_test.go`(httptest,假上游 server):
  - 非流式:`POST /v1/chat/completions` 带 token → 转发到上游(断言上游收到相同 body 和 key)→ 原样返回上游响应
  - 流式:`stream=true` → 上游返回 SSE 分块 → 网关逐块转发,Content-Type `text/event-stream`,无缓冲
  - 401:无 token;403:吊销 token;502:上游 5xx 或超时(重试 1 次后 502)
  - 限流:同用户 60 次/分钟(可配置)超出 → 429 `RATE_LIMITED`
Run: `go test ./internal/llmgateway/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0003_gateway.sql`:
```sql
CREATE TABLE gateway_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,            -- openai|deepseek|qwen|glm|openrouter
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,            -- AES-GCM 加密(1.12 落地加密,本节先存明文并注明)
  models TEXT NOT NULL DEFAULT '[]',    -- 该上游可用的模型名 JSON
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,            -- 对外模型名,如 "deepseek-chat"
  provider_id INTEGER NOT NULL REFERENCES gateway_providers(id),
  display_name TEXT, default_params TEXT NOT NULL DEFAULT '{}'
);
```
`upstream.go`:`type Upstream struct { Name, BaseURL, APIKey, Models []string }`,`LoadUpstreams(db) ([]Upstream, error)`(本节 `api_key_enc` 暂按明文读,1.12 改解密)、`MatchModel(db, modelName) (*Upstream, error)`
`handler.go`:路由组 `/v1` 挂 `BearerAuth`;`chat/completions`:解析请求 `{model, messages, stream, ...}` → MatchModel → 拼接上游 `base_url + /chat/completions` → `http.Client` 转发(透传 body、Authorization 换成上游 key)→ 流式时逐行读 SSE 转写(保持 `data:` 行与 `[DONE]`);**per-user 令牌桶限流**(默认 60 req/min,`gateway.rate_limit` settings 可配,超限 429)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: openai-compatible LLM gateway proxy with streaming"
```

---

### Task 1.9: usage 计量

**Files:**
- Create: `internal/serverstore/migrations/0004_usage.sql`, `internal/serverstore/usage.go`, `internal/serverstore/usage_test.go`
- Modify: `internal/llmgateway/handler.go`

- [ ] **Step 1: 写测试(红)**

- `usage_test.go`:`RecordUsage(db, userID, model, pt, ct)`、`UsageByUser(db, userID, since, until)`(按日聚合)、`UsageTotal(db, since, until)`
- `handler_test.go` 增:流式响应开始先落一行待定 usage(0 token),结束后回填(prompt/completion tokens 取自 SSE 最后 chunk 的 `usage` 字段);**客户端中途断开 → 待定行保留(usage 不丢)**
Run: `go test ./internal/serverstore/ ./internal/llmgateway/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0004_usage.sql`:
```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_usage_user_time ON usage(user_id, created_at);
```
`handler.go`:流式路径——**请求开始时先 `RecordUsage(0,0)` 落待定行**,最后一个 `data:` chunk 若含 `usage`,提取并回填该行;非流式:取响应体 `usage` 后落库;两者都忽略解析失败(仅记日志,不阻断响应);断连场景待定行保留,**服务启动时清理 1 小时前仍未回填的全零待定行**(防统计污染与表膨胀)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: per-user token usage metering"
```

---

### Task 1.10: 模型列表 API

**Files:**
- Create: `internal/llmgateway/models.go`, `internal/llmgateway/models_test.go`
- Modify: `cmd/server/main.go`

- [ ] **Step 1: 写测试(红)**

`GET /v1/models`(带 token)→ 200 返回 `{"models":[{"id":"deepseek-chat","display_name":"..."}]}`(来自 models 表 join provider);无 token 401
Run: `go test ./internal/llmgateway/ -run TestModels -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`models.go`:`ListModels(db) ([]Model, error)`(SQL join `models` + `gateway_providers`,`enabled=1`;按组授权模型过滤**二期**,本期全量可见);handler 注册到 `/v1/models`
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: models list endpoint"
```

---

### Task 1.11: Skill 商城(Git 源打包分发)

**Files:**
- Create: `internal/serverstore/migrations/0005_skills.sql`, `internal/serverstore/skills.go`, `internal/serverstore/skills_test.go`, `internal/marketplace/skill_pack.go`, `internal/marketplace/skill_pack_test.go`, `internal/marketplace/skill_api.go`, `internal/marketplace/skill_api_test.go`

- [ ] **Step 1: 写测试(红)**

- `skills_test.go`:AddSkill/UpdateSkill/DeleteSkill/ListSkills/GetSkill
- `skill_pack_test.go`:`BuildPackage(repoPath, name, version)` 产出合法 tar.gz:`metadata.yaml` 存在且字段正确、`SKILL.md` 存在、文件名单全是相对路径且无 `..`;`ValidatePackage(io.Reader)` 拒绝含绝对路径/`..`/**symlink/hardlink 条目**的包、拒绝超 100MB
- `skill_api_test.go`(httptest):`GET /api/marketplace/skills`(列表)、`GET /api/marketplace/skills/:name`(详情)、`GET /api/marketplace/skills/:name/archive`(下载,Content-Type `application/gzip`,带 `X-Skill-Version`)
Run: `go test ./internal/serverstore/ ./internal/marketplace/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0005_skills.sql`:
```sql
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  git_url TEXT NOT NULL,
  git_ref TEXT NOT NULL DEFAULT 'main',
  checksum TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,       -- 下架置 0(不删行,bootstrap 建议清单过滤)
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
```
`skill_pack.go`:clone(`go-git`,**浅克隆 `--depth 1` + 仓库大小限制 >200MB 拒绝**)到 `data/skills-cache/<name>/` → 校验 metadata.yaml(结构:name/version/author/description/dependencies/entrypoint,**name 过 `SafePathSegment`**)与 SKILL.md 存在 → tar.gz 到 `data/skills-cache/<name>-<version>.tar.gz`(缓存命中直接返回;构建新版本时清理旧包);tar 写入时对每个 entry 校验 `filepath.Clean` 后不以 `..` 开头、非绝对路径、**拒绝 symlink/hardlink 条目**
`skill_api.go`:**列表(仅 enabled)/详情/archive 三个公开端点**;`POST/PUT/DELETE /api/admin/skills`(上架/更新/**下架=置 enabled=0**)在任务 1.16b 与 AdminAuth 同批落地(1.11 只实现并测试公开端点;admin 端点测试同 1.16b)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: skill marketplace with git pack and download API"
```

---

### Task 1.12: 凭证加密(AES-GCM)

**Files:**
- Create: `internal/util/crypto.go`, `internal/util/crypto_test.go`, `internal/marketplace/credentials.go`
- Modify: `internal/llmgateway/upstream.go`, `internal/serverstore/settings.go`

- [ ] **Step 1: 写测试(红)**

- `crypto_test.go`:Encrypt/Decrypt 往返;错误密文报错;密文带 `enc:v1:` 前缀;不同明文不同密文(随机 nonce)
- 集成:无 `PICOAI_MASTER_KEY` env 时 `EnsureMasterKey()` 生成 32 字节随机写入 `data/master.key`(0600),可被 `GetMasterKey()` 取回;有 env 时优先用 env;**master key 不写 settings 表**(与密文同库则加密形同虚设)
Run: `go test ./internal/util/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`crypto.go`:AES-256-GCM,`Encrypt(key, plaintext) string`(输出 `enc:v1:<base64(nonce+ciphertext)>`)、`Decrypt(key, s string) (string, error)`;key 16/24/32 字节按长度
`credentials.go`:`EncryptEnv(db, env map[string]string) map[string]string`(值非空且 key 在敏感名单 `app_id,app_secret,token,api_key,password,secret,key` 中则加密)、`DecryptEnv(db, env)` 反向
`upstream.go` 修改:`LoadUpstreams` 用 `GetMasterKey` 解密 `api_key_enc`(1.8 暂存的明文 → 此处转加密格式)
**注:** 原 0007_gateway_key 迁移已废弃(master key 不再落库),迁移编号 0006 后直接 0008/0009;**`data/` 目录权限 0700**;master key 轮换无,列为已知限制
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: AES-GCM credential encryption with master key"
```

---

### Task 1.13: MCP 插件商城(建议安装制)

**前置:** Task 1.12(凭证加密,config 下发需解密)。

**Files:**
- Create: `internal/serverstore/migrations/0006_mcp.sql`, `internal/serverstore/mcp_servers.go`, `internal/serverstore/mcp_servers_test.go`, `internal/marketplace/mcp_api.go`, `internal/marketplace/mcp_api_test.go`

- [ ] **Step 1: 写测试(红)**

- `mcp_servers_test.go`:AddMCPServer/UpdateMCPServer/DeleteMCPServer/ListMCPServers/GetMCPServer;下载审计:RecordDownload/ListDownloads
- `mcp_api_test.go`(httptest):`GET /api/marketplace/mcp`(仅 enabled,已脱敏——env 中值替换为 `"***"`)、`GET /api/marketplace/mcp/:id/config`(**带有效 token 即返回完整 env/headers 含解密后的敏感值——建议安装制,无授权表**;无 token → 401;**下架(enabled=0)插件 → 404**;**同用户高频拉取 → 429 且记录入 mcp_config_downloads**)
Run: `go test ./internal/serverstore/ ./internal/marketplace/ -run TestMCP -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0006_mcp.sql`:
```sql
CREATE TABLE mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'stdio',   -- http|stdio
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  env TEXT NOT NULL DEFAULT '{}',            -- JSON,敏感值 AES-GCM 加密
  headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE TABLE mcp_config_downloads (          -- 凭证拉取审计(防批量导出)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mcp_id INTEGER NOT NULL REFERENCES mcp_servers(id),
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_downloads_user ON mcp_config_downloads(user_id, created_at);
-- 无 mcp_server_grants 表:管理员只上架/配置,员工自选安装(企业内可信环境)
```
`mcp_api.go`:`list` 脱敏(env 值全部 `"***"`,含 description)、`config` 解密(env/headers 中标记 `"enc:v1:<base64>"` 的值用 AES-GCM 解密后返回);**config:仅校验登录(无 grant 概念)+ enabled 校验(下架 → 404)+ per-user 限流(如 30 次/小时,超限 429)+ 每次成功拉取写 `mcp_config_downloads` 审计行**;`POST/PUT/DELETE /api/admin/mcp`(上架/编辑/下架=置 enabled=0)在任务 1.16b 与 AdminAuth 同批落地(1.13 只实现并测试公开端点)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: MCP plugin marketplace with self-install config"
```

---

### Task 1.14: 知识库(存储 + FTS5 检索)

**Files:**
- Create: `internal/serverstore/migrations/0008_kb.sql`, `internal/serverstore/knowledge.go`, `internal/serverstore/knowledge_test.go`, `internal/knowledge/index.go`, `internal/knowledge/search.go`, `internal/knowledge/knowledge_test.go`

- [ ] **Step 1: 写测试(红)**

- `knowledge_test.go`(store 层):CreateKBFolder/CreateKBDocument/DeleteKBDocument/ListKBFolders;权限:GrantFolderUser/GrantFolderGroup/GetAccessibleFolderIDs
- `knowledge_test.go`(服务层):`Search(db, userID, query, page, pageSize)` 命中 FTS5 中文(**unicode61 将连续汉字视为单 token,查询用前缀:文档含"知识库" → Search("知识") 命中;引号注入输入不报错**)、结果按相关度排序、权限外文档不可见;`IndexDocument`(txt/md 抽取文本);`kb_read` 越权文档拒绝、`kb_upload` 到无权限 folder 拒绝
Run: `go test ./internal/serverstore/ ./internal/knowledge/ -run TestKB -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0008_kb.sql`:
```sql
CREATE TABLE kb_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE TABLE kb_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, content TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'text', size INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'upload', created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE TABLE kb_folder_users (folder_id INTEGER NOT NULL, username TEXT NOT NULL, PRIMARY KEY(folder_id, username));
CREATE TABLE kb_folder_groups (folder_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY(folder_id, group_id));
CREATE TABLE kb_audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE VIRTUAL TABLE kb_fts USING fts5(title, content, content='kb_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER kb_ai AFTER INSERT ON kb_documents BEGIN INSERT INTO kb_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
CREATE TRIGGER kb_ad AFTER DELETE ON kb_documents BEGIN INSERT INTO kb_fts(kb_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content); END;
CREATE TRIGGER kb_au AFTER UPDATE ON kb_documents BEGIN INSERT INTO kb_fts(kb_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content); INSERT INTO kb_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
```
`index.go`:`IndexDocument(db, doc)` 插入 kb_documents(txt/md 文本抽取;docx/pdf 抽取在任务 4.2 实现);`search.go`:`Search` 用 FTS5 `MATCH` —— **查询词拆分后每词转 `"<词>"*` 前缀查询(星号在引号外;先剥离 `"` `*` `(` `)` `:` 与控制字符,防语法注入),空查询词直接返回空;兜底 `LIKE '%词%'` 补齐 2 字及以下短词召回**,join `kb_documents`,按 `bm25(kb_fts)` 排序,分页;权限:先 `GetAccessibleFolderIDs`(用户直属 + 其组所属 + folder_id=0 全局),再 `WHERE folder_id IN (...)`
**注意:** unicode61 不按字切分连续汉字(整词单 token),所以必须前缀查询 + LIKE 兜底;**如验收发现中文效果差,在此任务内切换 trigram tokenize 并回归测试**(二选一,实施时用真实数据验证)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: knowledge base storage with FTS5 search"
```

---

### Task 1.15: 知识库远程 MCP

**Files:**
- Create: `internal/knowledge/mcp.go`, `internal/knowledge/mcp_test.go`
- Modify: `cmd/server/main.go`

- [ ] **Step 1: 写测试(红)**

`POST /api/mcp/knowledge/message`(带 token)JSON-RPC:
- `tools/list` → 返回 kb_search/kb_read/kb_list/kb_upload
- `tools/call` kb_search:合法查询 → 结果 JSON 文本;空 query → isError true;越权文档不出现
- `tools/call` kb_read:越权 doc_id → isError true;kb_upload:无权限 folder → isError true
Run: `go test ./internal/knowledge/ -run TestMCP -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`mcp.go`:JSON-RPC 2.0 请求/响应式处理器:
- 请求体 `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_search","arguments":{...}}}`
- 响应 `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}],"isError":false}}`
- 工具:`kb_search(query, page, page_size)`、`kb_read(doc_id)`、`kb_list(folder_id)`、`kb_upload(title, content, folder_id)`;**每个工具都做权限校验**(search:folder 集合过滤;read:文档所属 folder 可访问;upload:目标 folder 已授权);**kb_upload 写 kb_audit_logs(管理端删除文档亦写审计,1.16b)**
- username 从 Bearer token 中间件 context 取
`main.go`:`/api/mcp/knowledge/message` 挂路由
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: knowledge base remote MCP endpoint"
```

---

### Task 1.16a: 管理端会话 + 用户/用量 API

**Files:**
- Create: `internal/serverstore/migrations/0009_admin_session.sql`, `internal/serverauth/admin_session.go`, `internal/serverauth/admin_session_test.go`, `internal/serverstore/admin.go`, `internal/serverstore/admin_test.go`
- Modify: `cmd/server/main.go`(挂 session 中间件 + `/api/admin/*` 路由)

- [ ] **Step 1: 写测试(红)**

- `admin_session_test.go`:AdminLogin(仅 is_admin=1 用户)、session 创建/校验/过期(24h)、CSRF token 签发与校验(带时间窗口容差)
- `admin_test.go`(httptest):`/api/admin/users`(GET/PUT/POST/DELETE,非超管 403)、`/api/admin/logout`(登出删 session)、`/api/admin/usage` 聚合(按日/模型/用户)
Run: `go test ./internal/serverauth/ ./internal/serverstore/ -count=1`
Expected: FAIL

- [ ] **Step 2: 迁移 + 实现**

Create: `internal/serverstore/migrations/0009_admin_session.sql`:
```sql
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,             -- 随机 session id
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_key TEXT NOT NULL,          -- HMAC key
  expires_at DATETIME NOT NULL
);
```
`admin_session.go`:登录走现有 `AuthenticateLocal` + `is_admin` 校验;`AdminAuth` 中间件(cookie `picoaide_session` → 校验未过期;**cookie 设 HttpOnly + SameSite=Lax,HTTPS 下加 Secure**);CSRF:HMAC-SHA256(csrf_key, 小时窗口)双窗口校验,管理端请求带 `X-CSRF-Token`;**`POST /api/admin/logout` 删除 session(webadmin 提供登出按钮)**
`admin.go`:`/api/admin/users` CRUD、`/api/admin/logout`、`/api/admin/usage` 聚合(by day/model/user,`?from=&to=&group=`)
`main.go`:`/api/admin/*` 挂 AdminAuth
**注:** go:embed 的 `webadmin/dist/index.html` 由 Task 1.1 预置占位文件,1.16c 构建后自动替换(空目录 embed 会编译失败)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: admin session auth with users and usage APIs"
```

---

### Task 1.16b: 管理端业务 API(bootstrap + providers/models + 商城/知识库管理)

**Files:**
- Create: `internal/bootstrap/bootstrap.go`, `internal/bootstrap/bootstrap_test.go`
- Modify: `cmd/server/main.go`(挂 `/api/config/*` 路由), `internal/marketplace/skill_api.go` / `mcp_api.go`(admin 端点挂 AdminAuth), `internal/knowledge/admin.go`(管理端 API)

- [ ] **Step 1: 写测试(红)**

- `bootstrap_test.go`(httptest):`GET /api/config/bootstrap`(带 token → `{default_model, models, skills(仅 enabled), mcp(仅 enabled,脱敏)}`;**default_model 不属于 enabled models 时返回 VALIDATION 错误日志 + 用列表首个模型兜底**;无 token → 401)
- `admin_test.go` 增:skill/mcp admin CRUD(非超管 403;skill 下架=置 enabled=0;mcp 下架=置 enabled=0)、`/api/admin/providers` + `/api/admin/models`(CRUD + 默认模型设置,保存时校验 default_model 属于 enabled models)、`/api/admin/kb`(上传/删除/文件夹/授权,非超管 403)、`/api/admin/mcp-downloads`(凭证下载审计列表)
Run: `go test ./internal/bootstrap/ ./internal/serverstore/ ./internal/marketplace/ ./internal/knowledge/ -count=1`
Expected: FAIL

- [ ] **Step 2: 实现**

`bootstrap.go`:`GET /api/config/bootstrap`(BearerAuth)——聚合返回:**`{default_model, models, skills, mcp, web}`(字段名固定,客户端 2.4 `BootstrapConfig` 严格对齐)**;模型列表来自 `ListModels`(enabled provider),技能建议来自 skills 表 enabled 全部,**MCP 建议复用 marketplace 查询逻辑(不直接读表,防漂移)**,脱敏;**`web: {allow_private, search_endpoint}` 来自 settings(webadmin 网关页配置)**;**default_model 无效时用列表首个模型兜底并记日志**——员工零配置的唯一启动入口
`admin.go` 增:`/api/admin/providers` + `/api/admin/models`(CRUD + `gateway.default_model` 设置,**保存时校验属于 enabled models**)、`/api/admin/skills` POST/PUT/DELETE(承接 1.11,下架=置 enabled=0)、`/api/admin/mcp` POST/PUT/DELETE(承接 1.13,上架/编辑/下架=置 enabled=0,无 grants)、`/api/admin/kb`(上传/删除/文件夹/授权;txt/md 抽取,docx/pdf 在 4.2)、`/api/admin/mcp-downloads`(凭证下载审计列表)
`main.go`:`/api/config/*` 挂 BearerAuth

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: bootstrap config and admin business APIs"
```

---

### Task 1.16c: webadmin 前端(极简 React 五页)

**Files:**
- Create: `webadmin/`(Vite React 应用):`package.json`、`vite.config.ts`、`src/{main.tsx,App.tsx,api.ts,pages/{Login,Users,Gateway,Usage,Marketplace}.tsx}`
- Modify: `cmd/server/main.go`(静态服务 `/admin/*` → `webadmin/dist/index.html`,go:embed 已含占位)

- [ ] **Step 1: 前端五个核心页**

`webadmin` 依赖:`react`、`react-dom`、`react-router-dom`、**shadcn/ui + Tailwind(与客户端统一,Table/Button/Dialog/Input/Card 等现成组件)**;页面:
- Login:超管登录(session cookie)
- Users:列表(分页)/创建(用户名+密码+admin 勾选)/禁用/删除
- Gateway:上游 provider CRUD(base_url + api_key 输入框,回显掩码)、models 管理、**默认模型设置、web 抓取私有网段开关**
- Usage:按日/用户/模型的聚合表 + **柱状图(shadcn `chart` 组件,基于 Recharts,`npx shadcn@latest add chart`)**
- Marketplace:skills 上架(Git URL 表单)/下架;mcp 插件 CRUD(transport/command/args/url/env/headers/description;无 grants——员工自选安装)+ **凭证下载审计表**
Run: `cd webadmin && npm install && npm run build`,然后启动服务端访问 `/admin/` 手工验证五个页面 CRUD 与 `make test-server`
Expected: 页面可用,测试通过

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: minimal web admin with session auth and CRUD pages"
```

---

### Task 1.17: 阶段 1 验收

**Files:**
- Create: `scripts/mock-upstream.go`(独立可运行的假上游:监听 `:8081`,返回固定 OpenAI 兼容 JSON/SSE 响应;供无外网/无上游 key 环境验证网关链路)

- [ ] **Step 1: 全量测试**

Run: `make test-server && go test ./... -count=1`
Expected: 全部 PASS

- [ ] **Step 2: curl 端到端冒烟(本地起服务端)**

前置:本机装有 `curl` 与 `jq`。
Run(依次,每步断言):
```bash
# 1. 建超管(密码必须经 env 提供;缺失则启动失败)
PICOAI_ADMIN_PASSWORD='Admin@123456' bin/picoaide-server -addr :8080 -data ./data --bootstrap-admin admin &
TOKEN=$(curl -s -XPOST localhost:8080/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Admin@123456"}' | jq -r .token)
# 1.5 启动配置(零配置核心:模型+默认模型+建议清单)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/config/bootstrap | jq
# 1.6 管理端登录(session + CSRF;1.16a/1.16b/1.16c 后可用)
ADMIN_COOKIE=$(curl -s -c /tmp/pa.jar -XPOST localhost:8080/api/admin/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Admin@123456"}' | jq -r .csrf_token)
# 上架一个技能(Git 源;curl 带 X-CSRF-Token 与 cookie;也可在管理页手工上架)
curl -b /tmp/pa.jar -H "X-CSRF-Token: $ADMIN_COOKIE" -H 'Content-Type: application/json' \
  -XPOST localhost:8080/api/admin/skills -d '{"name":"demo","git_url":"...","version":"1.0.0"}'
# 2. 网关(需先在管理页配好上游 key;SSE 流式返回;注意网关限流默认 60 req/min)
curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  localhost:8080/v1/chat/completions -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}'
# 3. 商城
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/marketplace/skills | jq            # 建议清单(仅 enabled)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/marketplace/mcp | jq               # 建议清单(脱敏)
# 3.5 插件配置拉取(需先上架一个 mcp 插件;登录即可,无授权)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/marketplace/mcp/1/config | jq
# 4. 知识库
curl -XPOST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  localhost:8080/api/mcp/knowledge/message -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"测试"}}}'
```
Expected: 全链路成功;错误路径(错密码 401、管理端非超管 403、超限 429)按契约返回
**无外网/无上游 key 环境**:第 2 步起独立 mock 上游(`scripts/mock-upstream.go`:可运行 Go 程序,监听 `:8081` 返回固定 OpenAI 兼容 SSE/JSON 响应;1.8 的 httptest 假上游为进程内 mock,不可独立运行),管理页把 mock 配为上游即可验证转发与流式链路;有真实 key 时再替换,记录在验收备注

- [ ] **Step 3: 合并 master**

```bash
git checkout master && git merge dev && git tag -a v0.1.0 -m "server gateway milestone"
```

---

## 阶段 2:客户端骨架(约 2-3 周)

**目标:** Electron 桌面端登录服务端,Ask 模式完成一次对话,会话持久化,重启恢复。

**前置:** 阶段 1 完成(依赖 `/v1/chat/completions`、`/api/auth/*`)。

**技术栈变更说明:** 客户端为 Electron + TypeScript(主进程 Node)+ React renderer,Vercel AI SDK 引擎。`desktop/` 是独立 npm 包;`internal/localstore` 等 Go 客户端包**不再存在**,数据层为 `desktop/src/main/store/`(better-sqlite3)。

---

### Task 2.1: Electron + React 脚手架(electron-vite)

**Files:**
- Create: `desktop/package.json`、`desktop/tsconfig.json`、`desktop/tsconfig.main.json`、`desktop/electron.vite.config.ts`、`desktop/electron-builder.yml`(基础)、`desktop/src/main/index.ts`、`desktop/src/main/ipc.ts`(最小)、`desktop/src/preload/index.ts`、`desktop/src/renderer/{main.tsx,App.tsx}`、`desktop/src/renderer/index.html`、`.gitignore` 追加 `desktop/dist`、`desktop/node_modules`

- [ ] **Step 1: 初始化 package + 依赖**

Run: `cd /data/picoaide-next && mkdir -p desktop/src/{main,preload,renderer}`
> 注:postinstall 的 `electron-rebuild -f -w better-sqlite3` 在 2.2 安装 better-sqlite3 前必失败,故 **2.1 用 `npm install --ignore-scripts` 安装**;2.2 装完 better-sqlite3 后手动执行 `npx electron-rebuild -f -w better-sqlite3`(此后每次 `npm install` 自动 rebuild)
Create: `desktop/package.json`:
```json
{
  "name": "picoaide-desktop",
  "version": "0.2.0",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  },
  "dependencies": {
    "react": "^18", "react-dom": "^18"
  },
  "devDependencies": {
    "electron": "^33", "electron-builder": "^25", "electron-vite": "^2",
    "vite": "^5", "typescript": "^5", "@vitejs/plugin-react": "^4",
    "vitest": "^2", "@electron/rebuild": "^3"
  }
}
```
Run: `cd desktop && npm install --ignore-scripts`
Expected: 安装成功,`node_modules` 出现(postinstall 跳过;2.2 装完 better-sqlite3 后手动 rebuild)

- [ ] **Step 2: 最小 main/preload/renderer**

Create: `desktop/electron.vite.config.ts` — main/preload 用 esbuild(外置 `electron` 与原生模块),renderer 用 react 插件(此为本项目标准三段式构建,`dev` 同时起 vite 与 electron)
Create: `desktop/src/main/index.ts` — 创建 `BrowserWindow`(900x680,`webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }`),开发环境加载 `process.env['ELECTRON_RENDERER_URL']`(electron-vite 注入),生产加载 `out/renderer/index.html`;`app.whenReady` → 创建窗口
Create: `desktop/src/main/ipc.ts` — `registerIpcHandlers()` 纯函数:`ipcMain.handle('picoaide:version', () => '0.2.0')`(handler 抽成纯函数、不依赖 Electron API,便于 Vitest 单测)
Create: `desktop/src/preload/index.ts` — `contextBridge.exposeInMainWorld('picoaide', { version: () => ipcRenderer.invoke('picoaide:version') })`
Create: `desktop/src/renderer/main.tsx` — React 渲染 `App.tsx`,`App.tsx` 显示 `window.picoaide.version()`
Run: `cd desktop && npm run build`
Expected: `desktop/out/main/index.js` 与 `desktop/out/renderer/index.html` 产出

- [ ] **Step 3: 冒烟启动**

Run: `cd desktop && npm run dev`
Expected: electron 窗口自动出现,页面显示 `0.2.0`(dev 一体化:主进程改动自动重启,renderer HMR)

- [ ] **Step 4: 写最小测试**

Create: `desktop/src/main/ipc.test.ts` — 测试 `registerIpcHandlers` 中 `picoaide:version` handler 返回 `0.2.0`(handler 为纯函数,不依赖 Electron API)
Run: `cd desktop && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/ .gitignore
git commit -m "feat: electron-vite react scaffold with version preload api"
```

---

### Task 2.2: 本地 SQLite 存储层(better-sqlite3)

**Files:**
- Create: `desktop/src/main/store/db.ts`、`desktop/src/main/store/migrations.ts`、`desktop/src/main/store/conversations.ts`、`desktop/src/main/store/messages.ts`、`desktop/src/main/store/artifacts.ts`、`desktop/src/main/store/settings.ts`、`desktop/src/main/paths.ts`
- Test: `desktop/src/main/store/*.test.ts`

- [ ] **Step 1: 安装依赖**

Run: `cd desktop && npm i better-sqlite3 && npm i -D @types/better-sqlite3 && npx electron-rebuild -f -w better-sqlite3`
Expected: 安装成功;`npx electron-rebuild` 让原生模块匹配 Electron ABI(否则 `npx electron .` 运行时报 NODE_MODULE_VERSION mismatch——vitest 跑系统 Node 测不出此问题)

- [ ] **Step 2: 写测试(红)**

- `db.test.ts`:`openDb(tmpfile)`(临时文件库,WAL 断言需文件库——`:memory:` 库 journal_mode 恒为 memory)执行迁移后 **4 张业务表**(conversations/messages/artifacts/settings)+ `schema_migrations` 存在;重复 open 幂等;`PRAGMA journal_mode=WAL` 生效
- `conversations.test.ts`:create/list(updated_at 倒序)/get/delete(级联删 messages)/status 列(create 默认 'done',可置 'running')
- `messages.test.ts`:append/list(按 id 升序)/tool_calls JSON 往返/**tool_call_id+tool_name+is_error 往返**
- `artifacts.test.ts`、`settings.test.ts`:同语义
Run: `cd desktop && npx vitest run src/main/store`
Expected: FAIL(db 模块未实现)

- [ ] **Step 3: 实现**

`paths.ts`:`dataDir()` 按平台:`~/.local/share/picoaide`(Linux)/`~/Library/Application Support/picoaide`(macOS)/`%APPDATA%/picoaide`(Windows);`dbPath()`/`workspaceDir()`
`db.ts`:`openDb(filePath)` 返回 better-sqlite3 实例,WAL + `foreign_keys=ON`
`migrations.ts`:版本表 `schema_migrations(version INTEGER PRIMARY KEY, applied_at)` + 迁移数组(与设计文档 §3.5 表结构一致,4 张业务表:conversations/messages/artifacts/settings;**conversations 含 `status` 列,messages 含 `tool_call_id`/`tool_name`/`is_error` 列**,无 memories/workflow_state——任务状态即消息历史,见设计 3.3.1a):
```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'ask',
  status TEXT NOT NULL DEFAULT 'done',   -- running | executing | planning | approved | rejected | done | failed
  model TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
```
各表方法签名:与设计文档 §3.5 一致,全部同步 API(better-sqlite3 特性)
Run: `cd desktop && npx vitest run src/main/store`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/store desktop/src/main/paths.ts
git commit -m "feat: better-sqlite3 local store with migrations"
```

---

### Task 2.3: AI SDK 引擎探针(核心风险验证)

**Files:**
- Create: `desktop/src/main/agent/provider.ts`、`desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/events.ts`、`desktop/src/main/agent/engine.test.ts`

**目的:** 验证 `@ai-sdk/openai-compatible` 对接自研网关 + `streamText` 流式/多步循环/**审批门控**基本链路。不依赖真服务端,用模拟 Provider。

- [ ] **Step 1: 安装依赖**

Run: `cd desktop && npm i ai @ai-sdk/openai-compatible zod && npm view ai version`
Expected: 安装成功;记录当前 `ai` 版本(本任务所有 API 用法以该版本实测为准——**若探针失败,先按实际 API 修正引擎设计,再改本计划 Task 2.5/3.7/3.8 的对应描述**)

- [ ] **Step 2: 写探针测试(红)**

`engine.test.ts`:
- `MockProvider`:实现 `LanguageModelV4`(以安装版本导出为准)的最小桩——`streamText` 调用时按输入消息返回固定文本分块或固定 tool-call
- `provider.ts` 的 `createGatewayModel(serverURL, token, modelID)` 返回 OpenAI 兼容 chatModel
- `events.ts` 的 `toAgentEvent` 把 streamText 的 stream part(`text-delta`/`tool-call`/`finish`)转成 UI 事件
- **消息转换探针**:`toModelMessage`/`fromModelMessage`——DB 行(含 tool_call_id/tool_name/is_error)→ AI SDK 消息 → DB 行往返一致;失败工具结果(is_error=1)转换后仍回传 Agent
- **审批门控探针(核心)**:注册一个 `needsApproval: true` 的工具 → mock model 返回该工具调用 → 断言 `execute` **挂起不执行**且引擎发出 `confirm_required` → `confirm(requestId, true)` 后工具执行结果出现;`confirm(requestId, false)` → 工具收到拒绝错误;超时(60s)→ 自动拒绝;**一步内多个高危工具 → 确认队列串行(一次一个 confirm_required)**;**引擎未配置 AI SDK 工具执行超时(toolMs)或 ≥ 审批超时+余量**(否则审批窗口被掐断)
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL(未实现)

- [ ] **Step 3: 实现**

`provider.ts`:
```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
export function createGatewayModel(serverURL: string, token: string, modelID: string) {
  return createOpenAICompatible({ name: 'gateway', baseURL: `${serverURL}/v1`, apiKey: token }).chatModel(modelID)
}
```
`events.ts`:UI 事件类型(§0.4.3 契约,TS 版)+ `toAgentEvent` 把 stream part 转换为 `text_delta`/`reasoning_delta`/`tool_start`/`tool_end`/`done` 回调
`engine.ts`(骨架):
```ts
export interface EngineConfig { model; serverURL; token; sysPrompt; maxSteps: 20 }
export class AgentEngine {
  constructor(cfg: EngineConfig, deps: EngineDeps)
  // 审批门控:needsApproval 工具在 execute 内挂起,等待 confirm(requestId, ok)(60s 超时)
  async ask(content: string, history: Message[]): Promise<AsyncIterable<AgentEvent>>  // Ask:streamText 单步
  confirm(requestId: string, ok: boolean): void
  cancel(): void
}
```
- `needsApproval` 由工具注册表标记(engine 内部约定字段),execute 内先 emit `confirm_required` 再 await 用户回执(Promise map),超时按拒绝处理
Run: `cd desktop && npx vitest run src/main/agent`
Expected: PASS(探针通过 → streamText + 审批门控链路可行)

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/agent desktop/package.json desktop/package-lock.json
git commit -m "feat: ai sdk engine probe with gateway provider"
```

---

### Task 2.4: 服务端连接器(登录/token/网关/商城/远程MCP/TLS)

**Files:**
- Create: `desktop/src/main/gateway/auth.ts`、`desktop/src/main/gateway/health.ts`、`desktop/src/main/gateway/config.ts`、`desktop/src/main/gateway/bootstrap.ts`、`desktop/src/main/gateway/tls.ts`、`desktop/src/main/gateway/marketplace.ts`、`desktop/src/main/gateway/remote_mcp.ts`、`desktop/src/main/gateway/auth.test.ts`、`desktop/src/main/gateway/health.test.ts`、`desktop/src/main/gateway/marketplace.test.ts`、`desktop/src/main/gateway/bootstrap.test.ts`、`desktop/src/main/gateway/remote_mcp.test.ts`、`desktop/src/main/gateway/tls.test.ts`
- Modify: `desktop/src/main/index.ts`(挂载 certificateVerifyProc)

- [ ] **Step 1: 写测试(红)**

- `auth.test.ts`:`login(serverURL, username, password)` 用 fetch mock 断言 POST `/api/auth/login`、成功返回 token;`saveSession/loadSession/clearSession` —— **safeStorage 可用时经 `safeStorage.encryptString` 加密落盘;不可用(如无 keychain 的 Linux)回退明文 config.json 0600;Windows 无密钥链时回退不落盘(每次启动重登)**
- `health.test.ts`:`ping(serverURL, token)` — mock fetch:200 → true;网络错误 → false;**401 → `auth_expired`(区别于离线)**
- `marketplace.test.ts`:`listSkills/downloadArchive(带 token,校验 Content-Type 与 X-Skill-Version)`、`listMcp/getMcpConfig(校验敏感值已解密)`、`kbSearch(JSON-RPC 请求/响应解析,isError 透传)`
- `bootstrap.test.ts`:`getBootstrap()` — mock fetch 断言 GET `/api/config/bootstrap`、返回 `{ default_model, models, skills, mcp, web }`(字段与 1.16b 固定 schema 严格一致);**default_model 无效时客户端用列表首个模型兜底并提示**;登录后拉取缓存,设置页"刷新"可重拉(管理员改动后生效)
- `marketplace.test.ts` 增:`getMcpConfig(下架插件 → 404;超限 → 429)`
- `remote_mcp.test.ts`:`kbSearch/kbRead/kbList/kbUpload(JSON-RPC 请求/响应解析,isError 透传)`
- `tls.test.ts`:证书指纹计算(sha256 of DER)、TOFU 存储/比对(首次存、后续同指纹通过、不同指纹拒绝);**确认所有服务端 HTTP 经 `session.defaultSession.fetch`(指纹校验对 Node fetch 无效)**
Run: `cd desktop && npx vitest run src/main/gateway`
Expected: FAIL

- [ ] **Step 2: 实现**

`config.ts`:`Session{ serverURL, username, token }`、`BootstrapConfig{ default_model, models, skills, mcp, web }`(与 1.16b 响应 schema 严格对齐),`sessionPath()`(paths.ts)
`auth.ts`:`login` 用 **`session.defaultSession.fetch`**(走 Chromium 网络栈,certificateVerifyProc 生效),超时 15s,401 抛 `AuthError`;`saveSession` 经 **Electron safeStorage** 加密 token(不可用则 JSON 0600;Windows 无密钥链 → 不落盘、本次会话内存持有并提示)、`loadSession` 读、`clearSession` 删
`bootstrap.ts`:`getBootstrap()` 登录成功后拉取 `/api/config/bootstrap`,缓存于内存;**每次应用启动重拉,设置页"刷新"按钮手动重拉**(管理员改默认模型/上下架插件后重启或刷新即生效);**default_model 无效 → 列表首个模型兜底 + 提示**;默认模型/技能建议/MCP 建议全部来自服务端,客户端不提供任何配置入口
`tls.ts`:**TOFU 指纹校验**——首次连接服务器(非 localhost)若为自签证书:计算证书 sha256 指纹 → 经 UI 弹窗"信任此证书?"(信任则存 `config.json` 的 `server_fingerprints`)→ 后续连接指纹不匹配则拒绝并提示(防 MITM);`certificateVerifyProc` 在 `main/index.ts` 挂载;**关键:全部服务端 HTTP(登录/health/商城/远程 MCP/AI SDK 流式)统一走 `session.defaultSession.fetch` 或 AI SDK 的 `fetch` 注入参数(certificateVerifyProc 只对 Chromium 网络栈生效)**;**登录页 URL 校验:远程地址拒绝非 HTTPS,仅 localhost/127.0.0.1 允许 http**
`health.ts`:`createHealthPoller(session, { intervalMs: 15000 })` — 返回 `{ start(cb), stop() }`,轮询 `GET /api/auth/me`,结果经回调输出 `online|offline|auth_expired`
`marketplace.ts`:商城 API 客户端——`listSkills()` / `downloadArchive(name)`(校验 Content-Type `application/gzip`)/ `listMcp()`(建议清单)/ `getMcpConfig(id)`(安装/启动重拉凭证,返回解密后 env/headers;404/429 透传)
`remote_mcp.ts`:知识库远程 MCP 客户端——`kbSearch(query, page, pageSize)`/`kbRead(docId)`/`kbList(folderId)`/`kbUpload(title, content, folderId)` 走 `POST /api/mcp/knowledge/message` JSON-RPC(协议见 Task 1.15),`isError` 透传为错误
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/gateway
git commit -m "feat: gateway client with login session tls and marketplace"
```

---

### Task 2.5: Ask 模式引擎(可运行的最小 Agent)

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/modes.ts`
- Create: `desktop/src/main/agent/modes.test.ts`、`desktop/src/main/ipc.ts`(扩展)、`desktop/src/main/ipc.test.ts`
- Modify: `desktop/src/main/index.ts`(注册 ipc)

- [ ] **Step 1: 写测试(红)**

`ipc.test.ts`(mock session + mock model):`handleChatAsk({ conversationId, content })` → 会话落库(user+assistant 两条)、流式事件经事件发射器推送、完成后 messages 表可读回
`modes.test.ts`:Ask 模式 `buildRunConfig(mode)` 返回 `{ tools: {}, maxSteps: 1 }`;Craft 返回 `{ tools: <注册表>, maxSteps: 20 }`
Run: `cd desktop && npx vitest run src/main/agent src/main/ipc.test.ts`
Expected: FAIL

- [ ] **Step 2: 实现**

`modes.ts`:
```ts
export type Mode = 'ask' | 'plan' | 'craft'
export function buildRunConfig(mode: Mode, tools: Record<string, Tool>, maxSteps: number) {
  if (mode === 'ask') return { tools: {}, maxSteps: 1 }
  return { tools, maxSteps }
}
```
`engine.ts` 完成 Ask 路径:
```ts
async ask(input: { conversationId: number; content: string }): Promise<RunHandle> {
  const history = store.messages.list(input.conversationId).map(toModelMessage)
  // 上下文窗口:发送给 LLM 的历史最多最近 50 条消息(超出仅存 DB 供 UI 查看)
  // 上游 502 → 重试 1 次,再失败 emit('error') 并置 status='failed'
  // 模型取 bootstrap 默认模型(员工零选择,登录即用)
  const result = await streamText({ model, system, messages: [...lastN(history, 50), userMsg], tools: {}, fetch: sessionFetch })
  // result.textStream → for await → emit('text_delta') ; finish → emit('done')
}
```
`ipc.ts`:`ipcMain.handle('chat:ask', ...)`、`ipcMain.handle('chat:new', ...)`、`webContents.send('agent:event', ev)` 推送;`index.ts` 注册
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main
git commit -m "feat: ask-mode engine with ipc bridge"
```

---

### Task 2.6: React 聊天 UI(shadcn/ui)

**Files:**
- Create: `desktop/src/renderer/src/api/picoaide.ts`、`desktop/src/renderer/src/stores/chat.ts`、`desktop/src/renderer/src/stores/auth.ts`、`desktop/src/renderer/src/pages/Main.tsx`、`desktop/src/renderer/src/components/{ChatInput,Messages}.tsx`、`desktop/src/renderer/src/components/ui/(shadcn 生成的组件)`
- Modify: `desktop/src/renderer/App.tsx`、`desktop/package.json`

- [ ] **Step 1: 安装依赖 + 初始化 shadcn/ui + 状态层准备**

Run: `cd desktop && npm i zustand && npm i -D tailwindcss @tailwindcss/vite && npx shadcn@latest init`(Vite 模式;按 CLI 输出接入 Tailwind 4 + globals.css)
Run: `cd desktop && npx shadcn@latest add button input textarea card scroll-area dialog`(按需拉取 shadcn 组件到 `components/ui/`;webadmin 侧另加 `chart`(Recharts)供用量柱状图)
Expected: 安装成功,Tailwind + shadcn 组件就绪(`components/ui/` 生成)

- [ ] **Step 2: 状态层 + API 封装**

Create: `desktop/src/renderer/src/api/picoaide.ts` — 封装 `window.picoaide.*`(chatAsk/onEvent/loadConversations/…),事件订阅 `window.picoaide.onAgentEvent(cb)`(preload 的 ipcRenderer.on 包装,返回取消函数)
Create: `desktop/src/renderer/src/stores/chat.ts`(Zustand):`conversations/messages/streaming/mode`,actions:`newConversation/loadConversation/sendMessage/onAgentEvent/appendDelta/selectConversation`
Create: `desktop/src/renderer/src/stores/auth.ts`:`status/login/logout`
Run: `cd desktop && npm run build`
Expected: 编译通过

- [ ] **Step 3: 组件(基于 shadcn/ui)**

- `Messages.tsx`:渲染消息列表(shadcn `card`/`scroll-area`),streaming 时展示流式增量,自动滚动(尾随 `scrollIntoView`)
- `ChatInput.tsx`:`textarea` + Enter 发送 + 模式切换(Ask/Plan/Craft 按钮,阶段 3 前仅 Ask 可用)
- `Main.tsx`:左侧会话列表 + 右侧聊天区;样式走 Tailwind + shadcn 主题变量
- 后续阶段 3 组件(ConfirmModal/ToolCalls/ArtifactsPanel/Login/Settings)同样基于 shadcn(`dialog`/`alert-dialog` 等)
Run: `cd desktop && npm run build`
Expected: 编译通过,`npx electron .` 手工验证(需本机服务端 + 已登录,阶段 2.7 后联调)

- [ ] **Step 4: Commit**

```bash
git add desktop/src/renderer desktop/package.json desktop/package-lock.json
git commit -m "feat: react chat ui with shadcn and zustand"
```

---

### Task 2.7: 登录页 + token 持久化

**Files:**
- Create: `desktop/src/renderer/src/pages/Login.tsx`
- Modify: `desktop/src/preload/index.ts`(暴露 login/loadSession/logout/onAgentEvent)、`desktop/src/main/ipc.ts`(auth handlers)、`desktop/src/renderer/App.tsx`(路由:未登录 → Login)

- [ ] **Step 1: preload + ipc 扩展**

`preload/index.ts` 增:`login(serverURL, username, password)`、`loadSession()`、`logout()`、`onAgentEvent(cb)`(返回取消函数)、`onConnectionStatus(cb)`
`ipc.ts` 增:`auth:login`、`auth:loadSession`、`auth:logout`(调 gateway/auth.ts)
Run: `cd desktop && npm run typecheck`
Expected: 类型通过

- [ ] **Step 2: Login 页 + OIDC 深链**

Form:服务端 URL + 用户名 + 密码 + 登录按钮 + **"企业账号登录"(OIDC)入口**(打开系统浏览器走 `/api/auth/oidc/login`)+ 错误提示(401 → "用户名或密码错误";网络错误 → "无法连接服务器");**登录成功后自动拉取 bootstrap(模型/默认模型/建议清单)再进主界面——员工登录即用,无任何配置步骤**;**OIDC 深链处理**(`main/index.ts` 注册 `open-url`/`second-instance` 事件):`picoaide://auth?token=...` → 解析 token → saveSession → 通知 renderer 进入主界面;**token 为正式 api_token,直接作为会话 token 使用**;`App.tsx` 用 `loadSession()` 判断初始路由
Run: `cd desktop && npm run build && npx electron .`,连本机服务端验证成功/失败分支
Expected: 正常

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: login page with session persistence"
```

---

### Task 2.8: 离线检测与重连

**Files:**
- Create: `desktop/src/renderer/src/stores/connection.ts`
- Modify: `desktop/src/main/index.ts`(启动 health poller)、`desktop/src/preload/index.ts`

- [ ] **Step 1: 实现**

`index.ts`:登录成功后 `createHealthPoller(session, cb)` 启动,`cb` 经 `webContents.send('connection:status')` 推送
`connection.ts`:状态 `online|offline|auth_expired`;`offline` 顶部横幅"已断开,将自动重连";**`auth_expired`(401)弹出"登录已过期,请重新登录"跳登录页(区别于网络故障)**;发送时 offline 直接本地报错
Run: `cd desktop && npm run build && npx electron .` 停服务端观察横幅
Expected: 正常

- [ ] **Step 2: Commit**

```bash
git add desktop/src
git commit -m "feat: offline detection and reconnect banner"
```

---

### Task 2.9: 阶段 2 验收

- [ ] **Step 1: 全量测试**

Run: `cd desktop && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 2: 手工场景(本机服务端 + electron .)**

1. 首次启动 → 登录页 → 输 URL/账号密码 → 进入主界面(**登录即用,默认模型/建议清单自动就绪**)
2. 新建会话 → 输入"你好,介绍你自己" → 流式回复 → 重启客户端 → 会话列表仍在 → 点开历史可见消息
3. 停掉服务端 → 顶部离线横幅出现 → 重启服务端 → 自动恢复在线
**无真实上游 key 环境**:服务端网关配 mock 上游(`scripts/mock-upstream.go`)验证流式链路,有真实 key 时替换
Expected: 三场景全部通过

- [ ] **Step 3: 合并 master**

```bash
git checkout master && git merge dev && git tag -a v0.2.0 -m "client skeleton milestone"
```

---

## 阶段 3:本地能力(约 3-4 周)

**目标:** Craft 模式全流程:真实文件任务("汇总桌面 Word 成 500 字汇报存回桌面")跑通;本地工具 + 审批确认 + Skill + MCP 插件 + 产物面板 + 沙盒执行 + 浏览器插件桥(CDP)。

---

### Task 3.1: 文件工具

**Files:**
- Create: `desktop/src/main/tools/filesystem.ts`、`desktop/src/main/tools/filesystem.test.ts`

- [ ] **Step 1: 写测试(红)**

用 `fs.mkdtempSync` 建临时目录树,每工具验证:
- `file_read(path, encoding)`:UTF-8 正常;GBK 文件正确解码(`iconv-lite` 或 `TextDecoder('gbk')` — 先写 GBK 字节,断言输出中文);**docx 文件自动抽取纯文本(mammoth 惰性加载:`.docx` → 解包 word/document.xml 提取,失败返回明确错误)——旗舰场景"汇总桌面 Word"依赖**
- `file_write/file_edit/file_append`:内容正确;越界路径(`/etc/passwd`、`../x`)返回明确错误
- `file_delete`:存在删除、不存在报错
- `file_list/file_search`:递归、按名过滤
Run: `cd desktop && npm i mammoth && npx vitest run src/main/tools/filesystem`
Expected: FAIL

- [ ] **Step 2: 实现**

`filesystem.ts`:
```ts
export interface FileToolContext { allowedDirs: string[]; cwd: string }
export function createFileTools(ctx: FileToolContext): Record<string, Tool>  // AI SDK tool 格式
export function isAllowed(absPath: string, allowedDirs: string[]): boolean  // 前缀边界 + realpath 校验
```
- 编码检测:GBK 用 `iconv-lite`(`npm i iconv-lite`),探测:BOM 优先,否则 UTF-8 严格校验失败回退 GBK;**`.docx` 用 mammoth 抽取纯文本(惰性加载,`.docx` 时才引入依赖);其他二进制(如 .xlsx/.pdf)返回"不支持解析"明确错误**
- 工具注册为 AI SDK `tool({ description, inputSchema: z.object({...}), execute })`,`file_delete` 标记 `needsApproval: true`(引擎层审批门控识别,见 3.7)
- 越界返回 `throw new ToolError('路径不在允许目录内: ' + path)`(AI SDK 工具错误 → tool_error 事件)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/filesystem.ts desktop/package.json desktop/package-lock.json
git commit -m "feat: local filesystem tools with encoding detection"
```

---

### Task 3.2: 终端工具

**Files:**
- Create: `desktop/src/main/tools/terminal.ts`、`desktop/src/main/tools/terminal.test.ts`

- [ ] **Step 1: 写测试(红)**

- `commandExec('echo hello')` → stdout 正确、exit code 0
- 超时:`sleep 5` with 1s timeout → 超时错误且进程被 kill(用 `child_process.spawn` + `AbortController` / `kill(-pid)` 进程组)
- 输出截断:cat 10KB 文件 → 输出 ≤50KB 且有截断标记
- **审批判定**(`needsApprovalFor(command)` 纯函数):`ls -la`/`cat a.md` → false;`;rm -rf /`、`$(rm -rf /)`、`rm -rf /`、`/usr/bin/rm x`、`cat a > out.txt`、`find . -delete`(find 不在白名单)、**`ls\nrm -rf /`(换行)、`cat $HOME/.ssh/id_rsa`(裸 `$`)、`cat /etc/passwd`(越出可访问目录)** → true;白名单命令路径参数 realpath 在可访问目录内才免审批
Run: `cd desktop && npx vitest run src/main/tools/terminal`
Expected: FAIL

- [ ] **Step 2: 实现**

`terminal.ts`:
```ts
export interface CommandResult { stdout: string; stderr: string; code: number }
export async function commandExec(command: string, opts: { cwd: string; timeoutSec: number; maxOutput: number; allowedDirs: string[] }): Promise<CommandResult>
export function needsApprovalFor(command: string, allowedDirs: string[]): boolean
```
- `spawn(command, { shell: true, cwd })`,输出累计超 `maxOutput`(50KB)截断
- 超时:`setTimeout` → `process.kill(-child.pid, 'SIGKILL')`(posix 进程组,防子进程残留;Windows 用 `taskkill /pid /T /F` 分支)
- **审批策略(防绕过)**:判定前**拒绝全部控制字符(含换行 `\n`/`\r`/`\0`)与裸 `$`**(`$(`/`${` 已拒,`$VAR` 也拒);含 shell 拼接字符(`;`/`&&`/`\|\|`/`\|`/反引号/`>`/`<`)或**首词不在安全白名单**(`ls,cat,pwd,mkdir,cp,mv,echo,head,tail,grep,wc,date,df,du,uname`——**不含 find**,其 `-exec`/`-delete` 可递归删除)或**路径参数(如存在)经 realpath 解析后越出可访问目录**(`cat /etc/passwd` 拒绝)→ 注册 `needsApproval: true`;**弹窗展示与执行同一命令串**(不二次拼接,展示=执行)
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/terminal.ts
git commit -m "feat: terminal tool with timeout and output truncation"
```

---

### Task 3.3: 沙盒执行工具(本地受限会话)

**Files:**
- Create: `desktop/src/main/tools/sandbox.ts`、`desktop/src/main/tools/sandbox.test.ts`(mock)

- [ ] **Step 1: 安装 + 写测试(红)**

Run: `cd desktop && npm i @ai-sdk/sandbox-just-bash`
`sandbox.test.ts`(mock `createJustBashSandbox`):`sandboxExec({ command: 'cat hello.txt' })` → 调 `createSession().run()`;输出截断;会话停止;**无凭证需求(本地执行,数据不出本机)**
Run: `cd desktop && npx vitest run src/main/tools/sandbox`
Expected: FAIL

- [ ] **Step 2: 实现**

`sandbox.ts`:
```ts
import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash'   // 以实际安装版本 API 为准
export function createSandboxTool(sandbox: ReturnType<typeof createJustBashSandbox>): Tool
// sandboxExec({ command, timeoutSec }) → 本地受限会话 run,stdout/stderr/code,输出截断 50KB
```
- 单例 sandbox 实例,惰性创建;不可信代码/技能脚本在此执行
- 本地 bash 受限会话:无用户文件访问权限;离线可用,无需任何云端凭证
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/sandbox.ts desktop/package.json desktop/package-lock.json
git commit -m "feat: local sandbox exec tool"
```
**能力边界**:just-bash 为 JS 模拟 bash + 虚拟文件系统(非 OS 级沙盒),仅时间/输出受限、**网络不受限**;可执行命令集以实际包为准——**本任务实测 `python3` 是否可用**,不可用则文档明确"技能脚本仅支持内置命令集"并降级提示

---

### Task 3.4: 屏幕截图 + OCR

**Files:**
- Create: `desktop/src/main/tools/screen.ts`、`desktop/src/main/tools/ocr.ts`、`desktop/src/main/tools/screen.test.ts`

- [ ] **Step 1: 写测试(红)**

- `screen.ts`:`captureScreen()` 用 `desktopCapturer.getSources({ types: ['screen'] })` → `nativeImage.toPNG()` → base64;测试环境跳过真实截图,断言结构正确
- `ocr.ts`:`ocrImage(pngBase64)` 用 tesseract.js(`npm i tesseract.js`);测试:合成含文本图片 → 返回非空字符串(CI 无 GPU 可 skip,本地验证中文)
Run: `cd desktop && npx vitest run src/main/tools/screen src/main/tools/ocr`
Expected: FAIL

- [ ] **Step 2: 实现**

`screen.ts`:`captureScreen()` — Electron main 的 `desktopCapturer`,返回 `{ pngBase64, width, height }`(Base64 直传 renderer 预览);**注册 `needsApproval: true`(截屏含密码/OTP 等敏感信息)**
`ocr.ts`:tesseract.js 惰性初始化(单例,首次调用 `createWorker('chi_sim+eng')`);**语言包 `chi_sim.traineddata`/`eng.traineddata` 打包进 `desktop/resources/tessdata/`,`langPath` 指向本地(不依赖 CDN,离线可用;打包配置 asarUnpack 见 4.1)**;失败降级:抛"OCR 不可用",截图工具照常工作
Run: 同上 + 手工验证
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/screen.ts desktop/src/main/tools/ocr.ts desktop/package.json desktop/package-lock.json
git commit -m "feat: screen capture and lazy ocr"
```

---

### Task 3.5: 剪贴板工具

**Files:**
- Create: `desktop/src/main/tools/clipboard.ts`、`desktop/src/main/tools/clipboard.test.ts`

- [ ] **Step 1: 实现 + 测试**

`clipboard.ts`:用 Electron `clipboard` 模块:`clipboardRead()`(标记 `needsApproval: true`)、`clipboardWrite(text)`
- AI SDK tool 注册,`clipboard_read` 触发审批流
- `clipboard.test.ts`:断言 `clipboard_read` 工具注册 `needsApproval: true`、`clipboard_write` 不带(纯函数注册检查,不触真实剪贴板)
Run: `cd desktop && npm run typecheck && npx vitest run src/main/tools/clipboard`
Expected: 通过

- [ ] **Step 2: Commit**

```bash
git add desktop/src/main/tools/clipboard.ts
git commit -m "feat: clipboard tools"
```

---

### Task 3.6: 可访问目录模型 + 越界防护

**Files:**
- Modify: `desktop/src/main/tools/filesystem.ts`(抽 `isAllowed` 到 `desktop/src/main/tools/paths.ts`)、`desktop/src/main/store/settings.ts`(allowed_dirs)
- Create: `desktop/src/main/tools/paths.ts`、`desktop/src/main/tools/paths.test.ts`

- [ ] **Step 1: 写测试(红)**

`paths.test.ts`:`isAllowed` — 前缀匹配、`/home/u/a` vs `/home/u/ab` 不误判(必须 `allowed + path.sep` 边界)、符号链接 `fs.realpathSync` 后校验(指向外部 → 拒绝)
Run: `cd desktop && npx vitest run src/main/tools/paths`
Expected: FAIL

- [ ] **Step 2: 实现**

`paths.ts`:`isAllowed(absPath, allowedDirs)`;引擎启动时从 settings 读 `allowed_dirs`(默认工作目录 `workspaces/`);所有工具统一调用
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools
git commit -m "feat: shared allowed-dirs path guard"
```

---

### Task 3.7: 高危操作审批(引擎层门控)

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/engine.test.ts`、`desktop/src/main/ipc.ts`
- Create: `desktop/src/renderer/src/components/ConfirmModal.tsx`

- [ ] **Step 1: 写测试(红)**

`engine.test.ts`(Craft 模式 + mock model):模型第一轮返回 tool-call 且该工具 `needsApproval` → **execute 挂起不执行**,引擎发出 `confirm_required`(含 request_id)→ `confirm(request_id, true)` 后工具执行结果出现;`confirm(request_id, false)` → 工具返回拒绝错误;**60s 未确认 → 自动拒绝(自弹窗可见起算)**;**一步多个高危工具 → 确认串行排队(一次一个)**;**cancel() → 挂起审批全部拒绝、pending map 清理、无泄漏**
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL

- [ ] **Step 2: 实现**

`engine.ts`:
```ts
// 审批门控:注册表标记 needsApproval 的工具,execute 内先 emit('confirm_required', {request_id, op, target, reason})
// → 挂起等待 engine.confirm(request_id, ok)(Promise map,60s 超时按拒绝;超时/回执/取消均清理 map)
// → 主进程缓冲 confirm_required 事件,renderer 就绪后补发(防弹窗丢失)
// → ConfirmModal 按 request_id 串行排队,一次一个弹窗
```
**审批测试钩子**:引擎读 env `PICOAI_TEST_AUTO_APPROVE`(`1` 自动允许 / `0` 自动拒绝),**仅测试构建生效(打包时剔除),E2E 免人工点弹窗**;单测直接测 `confirm()` 全分支
`ipc.ts` 增:`agent:confirm` handler;`index.ts` 转发 `confirm_required` 事件到 renderer(带缓冲)
`ConfirmModal.tsx`:弹窗(操作名 + 目标路径 + 原因 + 允许/拒绝 + 60s 倒计时;队列中待显示条目可见)
Run: 同上 + 手工验证
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: engine-level approval gate for high-risk tools"
```

---

### Task 3.8: Craft 模式全流程

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/modes.ts`、`desktop/src/main/agent/engine.test.ts`、`desktop/src/main/store/conversations.ts`
- Create: `desktop/src/renderer/src/components/ToolCalls.tsx`

- [ ] **Step 1: 写测试(红)**

`engine.test.ts` 增(Craft):mock model 两轮:第一轮 tool-call(file_read),第二轮文本 → 断言:工具执行结果回传、事件含 tool_start/tool_end、最终 done、`conversations.status` 由 running 置 done;步数到达上限(永远 tool-call)→ 引擎报错"达到最大步骤数";**工具被用户拒绝 → 拒绝作为 is_error 工具结果回传,循环继续(Agent 可重试其他路径),不崩溃**;**cancel() → 收到 canceled 事件,status 置 failed**;**删除运行中会话 → 引擎落库容错(跳过)不崩溃**
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL

- [ ] **Step 2: 实现**

`engine.ts` Craft 路径:**多步循环(streamText,步数上限 20,每 run 独立 AbortController)**:
```ts
// 1. conversations.status='running'
// 2. for step < 20:
//      result = streamText({ model, messages, system, tools, fetch: sessionFetch })
//      textStream → emit('text_delta');工具 execute(含审批门控)→ tool_start/tool_end/tool_error 事件
//      assistant 消息 + 工具结果落 messages 表(tool 行含 tool_call_id/tool_name/is_error)
//      工具失败/拒绝 → 捕获为 is_error=1 工具结果回填(不抛出,循环继续)
//      result 无工具调用 → break
// 3. status='done'|'failed';cancel → emit('canceled') + status='failed'
// 4. 步数超限 → emit('error','达到最大步骤数') + UI 提示"继续/停止"("继续"= 以当前消息上下文重发 run,步数重置)
```
**远程 KB 工具注册**:`kb_search/kb_read/kb_list/kb_upload`(remote_mcp.ts,2.4 已实现客户端)在引擎工具注册表中注册为 AI SDK tool;**`kb_upload` 标记 `needsApproval: true`(数据外发口)**;插件失败/不可达 → tool_error 回传 Agent
`ToolCalls.tsx`:折叠卡片(工具名/输入/输出/耗时/失败标红)
Run: 同上 + 手工:登录后 Craft 让 Agent 读本机文件
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: craft mode with multi-step loop and tool cards"
```

---

### Task 3.9: 产物面板 + 中断继续(重跑恢复)

**Files:**
- Create: `desktop/src/main/agent/artifacts.ts`、`desktop/src/main/agent/artifacts.test.ts`、`desktop/src/main/agent/continue.ts`、`desktop/src/main/agent/continue.test.ts`、`desktop/src/renderer/src/components/ArtifactsPanel.tsx`
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/main/agent/engine.test.ts`、`desktop/src/main/index.ts`(启动扫描未完成任务)

- [ ] **Step 1: 写测试(红)**

- `artifacts.test.ts`:文件类工具返回值含 `{ path, size }` → 引擎从返回值提取 → `artifact` 事件 + artifacts 表落库;**返回值无 path 字段 → 跳过登记(不报错)**
- `continue.test.ts`:`continueConversation(convId)`:会话 `status='running'`(或 'executing',消息历史完整)→ 新 run **截断到最后一条 user 消息**(其后的 assistant/tool 行不进入上下文)重跑,事件续推;完成后 status='done'
Run: `cd desktop && npx vitest run src/main/agent`
Expected: FAIL

- [ ] **Step 2: 实现**

`artifacts.ts`:工作目录管理器(创建/清理);类型按扩展名 map(`.md→report,.png/.jpg→image,.html→html,.pptx→ppt,.docx→docx,.xlsx→xlsx,其他→file`);**产物登记契约:文件类工具返回值须含 `path`(绝对路径)/`size` 字段,引擎提取登记,缺字段跳过**
`continue.ts`:启动时扫描 `status IN ('running','executing')` 会话 → UI 提示"有未完成任务,是否继续" → **重跑恢复**:截断到最后一条 user 消息重新发起多步循环(旧 assistant/tool 行保留在 DB 供查看但不进入上下文;非状态机级恢复,工具重执行)
`ArtifactsPanel.tsx`:右侧面板列出当前会话产物,点击"在文件夹中显示"(main `shell.showItemInFolder`)
Run: 同上 + 手工验证
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: artifacts panel and conversation resume"
```

---

### Task 3.10: Plan 模式

**Files:**
- Modify: `desktop/src/main/agent/modes.ts`、`desktop/src/main/agent/modes.test.ts`、`desktop/src/main/agent/engine.ts`、`desktop/src/renderer/src/components/ChatInput.tsx`、`desktop/src/renderer/src/stores/chat.ts`、`desktop/src/preload/index.ts`、`desktop/src/main/ipc.ts`(approvePlan 通道:preload 暴露 `approvePlan(convId, ok)`,ipc `chat:approvePlan` → engine 发起带 tools 的第二轮)

- [ ] **Step 1: 写测试(红)**

`modes.test.ts`:Plan 首轮 `tools: {}`(无工具)产出计划 → 用户确认(`approvePlan()`)→ 同会话第二轮带 tools 执行;拒绝则终止
Run: `cd desktop && npx vitest run src/main/agent/modes`
Expected: FAIL

- [ ] **Step 2: 实现**

`modes.ts`:Plan 状态复用 `conversations.status`(2.2 已建列,无需新迁移;值域扩展:planning|approved|rejected|executing,默认 'done');UI:Plan 消息后显示"执行计划"按钮
Run: 同上 + 手工
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src
git commit -m "feat: plan-then-execute mode"
```

---

### Task 3.11: Skill 运行时(沙盒执行)

**Files:**
- Create: `desktop/src/main/skill/loader.ts`、`desktop/src/main/skill/loader.test.ts`、`desktop/src/main/skill/installer.ts`、`desktop/src/main/skill/installer.test.ts`、`desktop/src/renderer/src/pages/Settings.tsx`(基础版,3.12 扩展、3.13 完善——**创建提前到此,避免 3.11/3.12 Modify 不存在的文件**)
- Modify: `desktop/src/main/agent/engine.ts`

- [ ] **Step 1: 写测试(红)**

- `loader.test.ts`:构造 `skills/<name>/`(SKILL.md + metadata.yaml + scripts/run.py)→ `load(name)` 返回 `{ instruction, entrypoint }`;缺 SKILL.md 报错
- `installer.test.ts`:从 mock 商城端点下载 tar.gz → 解压到 skills 目录(路径穿越防护:拒绝 `../` 条目)→ 版本记 settings;卸载删目录
Run: `cd desktop && npx vitest run src/main/skill`
Expected: FAIL

- [ ] **Step 2: 实现**

`loader.ts`:`load(skillsDir, name)` 读 SKILL.md 为 instruction,metadata 校验(语义化版本;**name 过 `SafePathSegment`**;自带 `tools/` 目录本期忽略,二期注册);**提示注入实现在 engine.ts 内(启动时拼入 sysPrompt),不单独建 inject.ts**;`installer.ts`:技能**建议清单来自 bootstrap.skills**(archive 下载走 `/api/marketplace/skills/:name/archive` 端点),下载 → tar 条目安全校验(`tar` 流式读取,拒绝 `..`/绝对路径/**symlink 条目**)→ 解压;已装列表记 settings `skills.installed`;**第三方 skill 首次安装弹窗风险提示(展示作者/来源)**
`engine.ts`:启动时已装 skill 的 instruction 拼入 sysPrompt(`## Skills\n` + 正文);`skill_exec <name>` 工具注册(**走本地沙盒 sandbox.ts 执行**,60s 超时,输出截断)
`Settings.tsx`(基础版):账户信息(URL/用户名/当前模型只读展示)+ 登出按钮(可访问目录与刷新在 3.13 完善,3.11 不做数据通道)
Run: 同上 + 手工:安装示例技能 → 对话中生效
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/skill desktop/src/renderer/src/pages/Settings.tsx
git commit -m "feat: skill loader installer with sandbox exec"
```

---

### Task 3.12: MCP 插件运行时

**Files:**
- Create: `desktop/src/main/mcp/installer.ts`、`desktop/src/main/mcp/runner.ts`、`desktop/src/main/mcp/adapter.ts`、`desktop/src/main/mcp/runner.test.ts`、`desktop/src/main/mcp/adapter.test.ts`
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/renderer/src/pages/Settings.tsx`

- [ ] **Step 1: 安装依赖 + 写测试(红)**

Run: `cd desktop && npm i @modelcontextprotocol/sdk`
`runner.test.ts`:mock stdio MCP server(测试脚本进程,响应 `initialize`/`tools/list`/`tools/call`)→ `listTools()` 返回工具、`callTool(name, args)` 返回结果;进程崩溃 → 自动重启 1 次后可调用;**再崩溃 → 停用并发出停用事件**
`adapter.test.ts`:**高危启发式**——插件工具名/描述含 `delete/remove/write/exec/shell/http/post` → 注册 `needsApproval: true`
Run: `cd desktop && npx vitest run src/main/mcp`
Expected: FAIL

- [ ] **Step 2: 实现**

`installer.ts`:**建议安装制**——从 `bootstrap` 的 MCP 建议清单展示 → 员工点击安装时调 `GET /api/marketplace/mcp/:id/config`(带 token,登录即可;404/429 透传)→ `config.json` 仅存非敏感字段(transport/command/args/url/description,**env/headers 敏感值不落盘**);**启动重拉:客户端每次启动(登录态下)对已安装插件重拉 `/config` 获取凭证到内存(不落盘;服务端下架 → 404 → 插件标记停用);安装时风险弹窗为硬防线**(展示插件名/作者/来源/命令/权限范围,员工知情后决定)
`runner.ts`:配置 `transport: stdio` → `new StdioClientTransport({ command, args, env })`(SDK 单 options 对象签名)+ `Client`(initialize/handshake);**command 校验:白名单二进制(绝对路径或 npx/node/python3/docker),args 拒绝 shell 元字符**;崩溃监听(进程退出)→ 自动重启 1 次 → **再失败停用 + 事件提示**;`transport: http` → `new StreamableHTTPClientTransport(url, { headers })`
`adapter.ts`:把 MCP 工具定义转换为 AI SDK `tool`(`inputSchema: z.object(JSON Schema 转换)`),execute 桥接 `callTool`;**按工具名/描述启发式强制审批——动词表:delete/remove/write/exec/shell/http/post/put/send/upload/publish/push/sync/purge/clear/truncate/unlink/rm 等(大小写不敏感,**best-effort 仅减噪,不作安全边界**;真正的硬防线=安装弹窗),插件工具不默认可信**
`installer.ts` 落盘:`config.json` 权限 0600;**headers(可含 Authorization)与 env 同策略——敏感值仅进程内存,不落盘;每次启动重拉**
`engine.ts`:启动时加载已启用插件,工具并入注册表;插件失败 → tool_error
`Settings.tsx`(扩展):插件**建议清单**(来自 bootstrap:名称/描述/推荐标记)+ 已安装列表(启用/禁用/查看配置脱敏/卸载)+ **技能管理区(3.11 已建)**
Run: 同上 + 手工:安装 xiaohongshu 类插件调用
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/mcp desktop/package.json desktop/package-lock.json
git commit -m "feat: local mcp plugin runtime with stdio and http"
```

---

### Task 3.13: 设置页完善(零配置原则)

**Files:**
- Modify: `desktop/src/renderer/src/pages/Settings.tsx`(完善)、`desktop/src/main/store/settings.ts` 扩展、`desktop/src/main/agent/engine.ts`(越界引导)、`desktop/src/main/tools/paths.ts`(授权回调)
- Modify: `desktop/src/preload/index.ts`、`desktop/src/main/ipc.ts`

- [ ] **Step 1: 实现**

**零配置原则:功能配置全部来自服务端 bootstrap(模型/默认模型/建议清单),客户端无配置入口**;设置页仅保留:
- 可访问目录:列表增删(settings `allowed_dirs`,JSON 数组)——**唯一本地配置项**(本地安全边界)
- **越界引导**:工具访问可访问目录外路径被拒 → 弹窗"是否将 X 加入可访问目录?" → 确认后自动加入并重试(旗舰场景一键授权,无需预先配置)
- 建议安装管理:MCP 插件建议清单(来自 bootstrap)+ 已安装管理(启用/卸载);技能同(3.11)
- 服务端信息:URL/用户名/当前模型(bootstrap 默认模型,只读展示),登出按钮,**"刷新配置"按钮(重拉 bootstrap,管理员改动后生效)**
Run: `cd desktop && npm run build && npx electron .` 逐项验证:登录即用(默认模型自动生效)、越界引导授权、可访问目录保存/重启生效、刷新按钮
Expected: 正常

- [ ] **Step 2: Commit**

```bash
git add desktop/src
git commit -m "feat: zero-config settings page with boundary guide"
```

---

### Task 3.14: Web 工具(web_fetch / web_search)

**Files:**
- Create: `desktop/src/main/tools/web.ts`、`desktop/src/main/tools/web.test.ts`
- Modify: `desktop/src/main/agent/engine.ts`(工具注册)

- [ ] **Step 1: 写测试(红)**

- `web_fetch`:mock fetch——成功返回 HTML 转文本(去 `<script>/<style>` 标签);>5MB → 截断错误;超时 15s → 错误;非 2xx → 错误
- `web_search`:配置了搜索端点 → 返回结果列表;未配置 → 明确错误"web_search 未配置"
Run: `cd desktop && npx vitest run src/main/tools/web`
Expected: FAIL

- [ ] **Step 2: 实现**

`web.ts`:
```ts
export async function webFetch(url: string, opts: { maxBytes?: number; timeoutSec?: number }): Promise<string>
export async function webSearch(query: string): Promise<{ title: string; url: string; snippet: string }[]>
```
- `web_fetch`:HTTP GET,大小限制默认 5MB,超时 15s,HTML→文本;仅 http/https;**默认拒绝 loopback/私有/链路本地网段(SSRF 防护),`bootstrap.web.allow_private=true` 时放开(管理员配置,随启动配置下发,客户端不可自设)**
- `web_search`:调 `bootstrap.web.search_endpoint`(管理员配置;未配置返回明确错误)
- 引擎注册进工具表(Craft/Plan 模式可用);外发目标为显式 URL(用户可见 tool_start 输入),不自动外发
Run: 同上
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tools/web.ts
git commit -m "feat: web fetch and search tools"
```

---

### Task 3.15: 浏览器插件桥(CDP)

**定位:纯本地客户端功能(客户端 ↔ 员工本机浏览器 WebSocket 直连,不经服务端、离线可用)——让 AI Agent 控制浏览器,操作员工自己浏览器中已登录的系统/页面。**

**Files:**
- Create: `desktop/src/main/cdp_server.ts`、`desktop/src/main/cdp_server.test.ts`、`desktop/src/main/tools/browser.ts`、`desktop/src/main/tools/browser.test.ts`、`browser-extension/manifest.json`、`browser-extension/background.js`、`browser-extension/content.js`、`browser-extension/README.md`
- Modify: `desktop/src/main/index.ts`(启动/关闭 CDP 服务)、`desktop/src/main/agent/engine.ts`(注册 browser_* 工具)、`desktop/src/renderer/src/pages/Settings.tsx`(插件连接状态展示)

- [ ] **Step 1: 写测试(红)**

- `cdp_server.test.ts`:起真实 WebSocket 服务(临时端口)——**连接即成功(无鉴权,零配置);JSON-RPC 请求/响应往返(browser.tabInfo/browser.getContent 由 mock handler 返回);端口被占用 → 启动报错并提示**
- `browser.test.ts`:工具注册——`browser_tab_info`/`browser_get_content` 不标记审批;`browser_click`/`browser_type`/`browser_navigate`/`browser_scroll`/`browser_execute_js` 标记 `needsApproval: true`;插件未连接 → 明确错误
Run: `cd desktop && npx vitest run src/main/cdp_server src/main/tools/browser`
Expected: FAIL

- [ ] **Step 2: 实现**

`cdp_server.ts`:`startCdpServer()` **固定监听 `127.0.0.1:54321`**(仅绑定回环地址;**无鉴权**;端口被占用 → 启动报错"端口 54321 被占用,请关闭占用程序"(设置页可改端口,默认 54321,改动后插件侧同步说明));JSON-RPC 2.0 分派——`browser.tabInfo`/`browser.getContent`/`browser.click`/`browser.type`/`browser.navigate`/`browser.scroll`/`browser.executeScript`,响应 `{id, result|error}`;客户端退出关闭端口
`tools/browser.ts`:注册 `browser_*` AI SDK 工具,execute 转发 CDP 请求;**操作类与 executeScript 标记 `needsApproval: true`(引擎层审批门控)**,读取类直接可用;插件未连接 → `ToolError('浏览器插件未连接')`
`index.ts`:应用启动时启动 CDP 服务,退出时关闭
`Settings.tsx`:插件连接状态(已连接/未连接)+ 端口展示(默认 54321,可改)
`browser-extension/`(Chrome MV3,**零配置**):`manifest.json`(permissions: `tabs`/`activeTab`/`scripting`)+ background service worker(**默认直连 `ws://127.0.0.1:54321`**,断线指数退避重连;转发 CDP 命令到 content script)+ content script(点击/输入/滚动/取文本/执行 JS)+ README(开发者模式加载说明;**无 options 页,安装即用**)
Run: 同上 + 手工:装插件(开发者模式加载)→ 客户端启动 → 插件自动连上 → Craft 让 Agent 读取当前标签页内容/点击/导航
**插件 E2E 自动化(本任务内)**:`cd desktop && npm i -D playwright`——Playwright 启动真实 Chrome 并 `--load-extension=browser-extension/`,连真实客户端 CDP 端口,断言 tabInfo/getContent/click/navigate 全链路(CI 用 `xvfb-run`)
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/cdp_server.ts desktop/src/main/tools/browser.ts browser-extension/
git commit -m "feat: browser extension bridge over local CDP"
```

---

### Task 3.16: 阶段 3 验收

- [ ] **Step 1: 全量测试**

Run: `cd desktop && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 2: 真实任务端到端(本机)**

准备:桌面目录放 2-3 个 .docx/.md 文件;服务端知识库上传一篇文档(**1.16c 已建 webadmin,经管理页上传或 curl 管理 API**)
1. Craft 模式:"汇总桌面/文档里的文件,生成 500 字汇报保存到桌面" → **首次访问桌面目录触发越界引导弹窗 → 一键授权后自动重试** → 产物出现在产物面板 → 打开文件内容正确(docx 经 mammoth 抽取)
2. 高危:要求 Agent 删除文件 → 审批弹窗 → 拒绝后 Agent 收到拒绝且循环继续
3. 技能:安装一个商城技能(建议清单) → 新对话中生效(脚本在本地沙盒执行)
4. 插件:安装 stdio 插件(建议清单) → 对话中调用成功(高危插件工具触发审批)
5. 知识库:Craft 模式让 Agent 查询知识库文档(kb_search)→ 返回正确内容;**要求其把本地内容写入知识库(kb_upload)→ 触发审批**;kb_read 越权文档 → 明确错误
6. 长任务:让 Agent 执行多步任务,任务中途重启客户端 → 提示恢复 → 继续完成
7. 管理员改动:管理页改默认模型/下架插件 → 客户端"刷新配置" → 生效
8. 浏览器插件:安装扩展连上 CDP → Craft 让 Agent 读取当前标签页 → 点击/输入触发审批 → 拒绝后循环继续;未装插件时 browser_* 返回"插件未连接"
Expected: 全部通过

- [ ] **Step 3: 合并 master**

```bash
git checkout master && git merge dev && git tag -a v0.3.0 -m "local capabilities milestone"
```

---

## 阶段 4:产品化(约 2-3 周)

**目标:** 三平台打包分发、管理页完善、全套文档、性能优化、E2E 冒烟。

---

### Task 4.1: 三平台打包(客户端)

**Files:**
- Create: `desktop/electron-builder.yml`(完善)、`scripts/pkg-linux.sh`、`scripts/pkg-windows.sh`、`scripts/pkg-macos.sh`、`Makefile` 增 `pkg-*` 目标

- [ ] **Step 1: 配置 electron-builder**

`desktop/electron-builder.yml`:
```yaml
appId: com.picoaide.desktop
productName: PicoAide
directories: { output: dist, buildResources: resources }
files: [out/**, resources/**]        # resources 随包:OCR 语言包/图标
protocols:                               # OIDC 回调 picoaide://auth?token=... 需要
  - name: PicoAide
    schemes: [picoaide]
asarUnpack:                              # 原生模块与 wasm/模型必须解包
  - "**/*.node"
  - "**/tesseract.js-core/**/*.wasm"
  - "resources/tessdata/**"
linux: { target: [deb, AppImage], category: Utility }
win: { target: [nsis], arch: [x64] }
nsis: { oneClick: false, allowToChangeInstallationDirectory: true }
mac: { target: [dmg], category: public.app-category.productivity, arch: [arm64, x64] }
```
- 注:`protocols` 用于 OIDC 登录回调(1.7);`asarUnpack` 用于 better-sqlite3 原生模块与 tesseract.js 的 wasm/traineddata(2.2/3.4 依赖);electron-builder 会自动 npmRebuild 原生模块;**mac `arch: [arm64, x64]` 覆盖 Apple Silicon(M 系列)与 Intel;CI 用 `macos-14`(arm64 runner)原生产出 arm64 dmg**
- **签名/公证(企业内部分发注意)**:macOS 未签名 dmg 会被 Gatekeeper 拦截——需 Developer ID 证书 + notarize 配置(有证书则加 `mac.notarize`,无证书企业内用"右键打开"并文档说明);Windows 同理需代码签名证书(无证书则 SmartScreen 警告,企业内可接受并说明)
- [ ] **Step 2: 打包脚本**

- Linux:`npm run build && electron-builder --linux` → `dist/picoaide_0.4.0_amd64.deb` + AppImage(arm64 可选)
- Windows:`electron-builder --win` → `dist/picoaide-setup.exe`(CI windows-latest)
- macOS:`electron-builder --mac` → `dist/picoaide-arm64.dmg` + `picoaide-x64.dmg`(CI macos-14 arm64 原生 + x64 交叉;M 系列即装 arm64)
- 版本号从 `package.json` version 注入
Run: `bash scripts/pkg-linux.sh`
Expected: Linux 安装包产出,安装后可启动登录(Windows/macOS 在 CI 对应 runner 验证)

- [ ] **Step 3: Commit**

```bash
git add desktop/electron-builder.yml scripts/ Makefile
git commit -m "feat: three-platform electron packaging with arm64"
```

---

### Task 4.2: 管理页完善

**Files:**
- Modify: `webadmin/src/pages/Usage.tsx`、Create: `webadmin/src/pages/Knowledge.tsx`(1.16c 未建此页,4.2 为首次创建)

- [ ] **Step 1: 用量图表 + 知识库上传**

- Usage:**按日柱状图(shadcn chart/Recharts bar chart)**、按模型/用户排行表、日期范围筛选(API:`/api/admin/usage?from=&to=&group=day|model|user`,1.16a 已实现)
- Knowledge:文档上传(**txt/md 已有;docx/pdf 补文本抽取:选库实施期定,如 `ledongthuc/pdf` + docx 解析库,抽取失败给出明确错误**)、文件夹管理、用户/组授权、搜索预览(API 为 1.16b 的 `/api/admin/kb/*`)
Run: `cd webadmin && npm run build`,手工验证
Expected: 正常

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: usage charts and knowledge admin"
```

---

### Task 4.3: 全套文档

**Files:**
- Create: `docs/01-architecture.md`、`docs/02-build-deploy.md`、`docs/03-api-reference.md`、`docs/04-auth.md`、`docs/05-agent-system.md`、`docs/06-database.md`、`docs/07-marketplace.md`、`docs/08-development.md`、`README.md`

- [ ] **Step 1: 按 §11 文档计划编写**

内容以设计文档为准,更新为实际实现细节(端点/表/目录有出入处以代码为准;客户端章节按 Electron/AI SDK streamText 多步循环/审批门控/本地沙盒实际实现写)
- `README.md`:项目简介、快速开始(服务端 + 客户端)、截图占位
Run: 通读全文,交叉检查 API/表名与代码一致(用 `grep` 抽查 3 处)
Expected: 一致

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs: full documentation set"
```

---

### Task 4.4: 性能优化

**Files:**
- Modify: `desktop/src/main/agent/engine.ts`、`desktop/src/renderer/src/components/Messages.tsx`、`desktop/src/main/store/db.ts`

- [ ] **Step 1: 实施与验证**

- 流式渲染节流:React `useDeferredValue`/requestAnimationFrame 合并 text_delta 渲染(>10 delta/s 时),验证长回复无卡顿
- SQLite WAL 自动检查点:`PRAGMA wal_autocheckpoint(1000)`;会话页加载 >200 条消息时分页(先加载最近 100,向上滚动加载更多)
- OCR 惰性加载回归确认(3.4 已做,此处复验)
Run: `cd desktop && npm run build && npx electron .` 长对话(50+ 轮)滚动流畅;`npm test` 无明显退化
Expected: 流畅

- [ ] **Step 2: Commit**

```bash
git add desktop/src
git commit -m "perf: streaming throttle and message pagination"
```

---

### Task 4.5: E2E 冒烟(全自动)

**Files:**
- Create: `scripts/e2e/smoke.sh`(服务端 curl 链路)、`scripts/e2e/smoke_client.sh`(客户端冒烟)、`scripts/e2e/smoke_plugin.spec.ts`(浏览器插件 Playwright)

- [ ] **Step 1: 服务端冒烟脚本**

复用阶段 1 验收的 curl 链路脚本化,加断言(退出码非 0 即失败):超管引导→登录→网关对话(stream,可用 mock 上游)→技能列表→MCP 列表→知识库搜索
Run: `bash scripts/e2e/smoke.sh`
Expected: 全绿

- [ ] **Step 2: 客户端全自动冒烟(审批钩子)**

在打包产物上:**Playwright(Electron)** 驱动启动 → 自动登录(预设 config)→ 发起一次 Ask → 断言收到 done 事件;**Craft 高危操作:置 `PICOAI_TEST_AUTO_APPROVE=1` 自动允许,断言工具执行结果;`=0` 自动拒绝,断言 Agent 收到拒绝并继续**;CI(Linux)用 `xvfb-run` 跑无头 Electron(依赖:`cd desktop && npm i -D playwright`)
Run: CI(xvfb-run)与打包机执行
Expected: 通过

- [ ] **Step 3: 浏览器插件 E2E**

`smoke_plugin.spec.ts`:Playwright 启动真实 Chrome 加载 `browser-extension/`(MV3) → 起真实客户端(或测试模式 CDP 服务)→ 断言插件自动连接、`browser.tabInfo`/`getContent` 返回、`click`/`navigate` 生效
Run: CI(Linux `xvfb-run`)执行
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e
git commit -m "test: e2e smoke scripts"
```

---

### Task 4.6: 发布(客户端三平台 + 服务端 Docker 镜像 + 插件包)

**Files:**
- Create: `Dockerfile`(服务端多阶段:golang 构建 → distroless/alpine 运行,ARG TARGETARCH 交叉编译)、`scripts/pkg-extension.sh`(浏览器插件 zip:打包 `browser-extension/` 为 `picoaide-extension.zip`)
- Modify: `.github/workflows/ci.yml`(阶段 4 追加发布矩阵)

- [ ] **Step 1: 版本与发布**

```bash
# 本机(Linux)出 deb + AppImage
bash scripts/pkg-linux.sh
# Windows/macOS 由 CI 矩阵产出(.github/workflows/ci.yml 阶段 4 追加:
#   windows-latest → npm test + electron-builder --win → picoaide-setup.exe
#   macos-14(arm64)→ npm test + electron-builder --mac(arm64/x64)→ picoaide-arm64.dmg + picoaide-x64.dmg
#   ubuntu         → docker buildx build --platform linux/amd64 \
#                      -t ghcr.io/picoaide/picoaide-harness-server:<tag> --push(amd64 镜像)
#                    + bash scripts/pkg-extension.sh → picoaide-extension.zip
#  全部产物上传 artifact/Release)
git checkout master && git merge dev && git tag -a v0.4.0 -m "picoaide desktop 0.4.0"
```
Expected: Linux 安装包在本机 `desktop/dist/`;win/mac(含 M 系列 arm64)包、服务端双架构 Docker 镜像、浏览器插件 zip 由 CI 产出,全部可下载;tag 建立

- [ ] **Step 2: 服务端 Docker 镜像**

`Dockerfile`:多阶段——`golang:1.24` 构建(`CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH` + `go:embed webadmin/dist` 预构建传入)→ 运行镜像 `distroless` 或 `alpine`(含 `-data` 目录挂载卷、0700 权限说明);CI 用 `docker/build-push-action` + buildx QEMU 交叉构建双平台
Run: `make docker-image` 本地验证单平台 + CI 验证双平台
Expected: `ghcr.io/picoaide/picoaide-harness-server` 出现 `linux/amd64` 与 `linux/arm64` 两个平台标签

- [ ] **Step 3: 浏览器插件包**

`scripts/pkg-extension.sh`:`zip -r picoaide-extension.zip browser-extension/`(剔除 README/测试,含 manifest.json/background/content);产物上传 Release
Run: `bash scripts/pkg-extension.sh`
Expected: `picoaide-extension.zip` 产出,解压后 `chrome://extensions` 开发者模式可直接加载

- [ ] **Step 4: 发布说明**

Create: `CHANGELOG.md`(汇总四阶段功能)
Run: 通读核对
Expected: 完成

- [ ] **Step 5: Commit**

```bash
git add Dockerfile scripts/pkg-extension.sh CHANGELOG.md
git commit -m "docs: changelog for 0.4.0"
```

---

## 自审记录(计划编写时完成)

**Spec 覆盖检查:**
- §3.1 客户端技术栈 → Task 2.1(壳)/2.2(DB)/2.3(引擎探针)/2.4(网关客户端)
- §3.3 Agent 引擎三模式 + 多步循环 + 审批门控 → Task 2.3/2.5(Ask)、3.8(Craft)、3.10(Plan)、3.7(审批)、3.9(继续)
- §3.3a 长任务与恢复(消息即状态)→ Task 3.9(continue)
- §3.3b 沙盒执行(本地受限会话)→ Task 3.3(工具)、3.11(skill 脚本)
- §3.4 本地工具全表(含 web 工具、docx 抽取)→ Task 3.1-3.5、3.14
- §3.5 本地 SQLite 四表(含 status 列)→ Task 2.2
- §3.6 本地 MCP 运行时(审批启发式/命令白名单/**凭证启动重拉**)→ Task 3.12
- §3.7 Skill 运行时 → Task 3.11
- §3.8 浏览器插件桥(CDP)→ Task 3.15
- §4.1 认证(本地/LDAP/OIDC/token 过期/超管引导)→ Task 1.4-1.7
- §4.2 AI 网关 + 限流 + 计量 + **bootstrap 启动配置** → Task 1.8-1.10、1.16b、2.4
- §4.3/4.4 商城(**企业内分发,建议安装制,无授权;凭证限流+审计**)→ Task 1.11-1.13、1.16b、3.11-3.12
- §4.5 知识库 + 远程 MCP(权限校验;**客户端 KB 工具注册**)→ Task 1.14-1.15、2.4、3.8
- §4.7 管理页(全部配置入口)→ Task 1.16a/1.16b/1.16c/4.2
- §5 安全(审批/越界/加密/TOFU/限流)→ Task 1.5/1.8/1.12/2.4/3.6/3.7/3.12
- §6 错误边界 → 分散在各任务测试(超时/重连/审批超时/断连 usage)
- **AI 全自动化测试(§7.1)** → 审批测试钩子(3.7)/插件 Playwright E2E(3.15、4.5 Step 3)/客户端冒烟(4.5 Step 2)/CI 三平台矩阵(1.1、4.6);保留人工:真实企业环境联调、手感验收(3.16)
- **零配置原则** → Task 2.4(bootstrap)、2.7(登录即用)、3.13(设置页仅本地边界)
- §8 实施阶段 → 全部映射为 Task 1.1-4.6
- **发布产物(三平台客户端 + 双架构服务端镜像 + 插件包)** → Task 4.1(mac arm64)/4.6(Docker buildx + 插件 zip)/1.1(CI 交叉编译验证)

**待实施时确认的选型**(不影响任务结构,在每个任务内决策并记录):OCR 语言包加载路径(tesseract.js langPath)、MCP TS SDK 版本 API(@modelcontextprotocol/sdk v1 构造签名)、中文 FTS5(unicode61 前缀 vs trigram)、web_search 端点、@ai-sdk/sandbox-just-bash 实际 API 形状、docx/pdf 抽取库、electron-vite 当前版本约定、bootstrap 响应结构字段名、浏览器插件分发方式(开发者模式 vs 组策略)。

**类型/签名一致性检查:**
- `createGatewayModel(serverURL, token, modelID)`(Task 2.3 定义)→ 2.5/3.8 一致引用
- `getBootstrap()`(Task 2.4)→ 2.7(登录即用)/3.11/3.12/3.13(建议清单)消费
- `AgentEvent`(§0.4.3 TS 版,含 `canceled`)→ 2.3 定义、2.6/3.7/3.8/3.9 消费,字段名固定(snake_case)
- `buildRunConfig(mode, tools, maxSteps)`(Task 2.5)→ 3.8/3.10 复用
- `isAllowed(absPath, allowedDirs)`(Task 3.6)→ 3.1/3.2 复用
- `confirm(requestId, ok)`(Task 3.7)→ 引擎层审批门控签名;preload/ipc 与 ConfirmModal 同签名
- `needsApprovalFor(command, allowedDirs)`(Task 3.2)→ 3.7 审批门控消费
- `startCdpServer()`(Task 3.15)→ index.ts 启动/关闭;browser_* 工具(3.15)经审批门控注册
- `toModelMessage`/`fromModelMessage`(Task 2.3 探针)→ 2.5/3.8/3.9 一致(含 tool_call_id/tool_name/is_error)
- `store.*` 方法(任务 2.2)→ 2.5/3.9/3.10 一致
- 服务端 Go 侧签名(阶段 1)不受客户端改动影响,保持任务 1.x 原文

---

## 知识库进化轮(2026-08,已合入主线)

> 背景:需求升级为"几千文档 + AI 聊天实时检索总结"。市场调研(RAGFlow/QAnything/FastGPT/MaxKB 源码级研究)后按"借鉴模式、纯 Go 改造"推进,TDD 红-绿-commit。

### A1 trigram 检索(commit 98087b1)
- 迁移 0013 `kb_fts_trigram`(trigram tokenizer,modernc 内置免 CGO)+ 词长分流:≥3 rune 走 trigram 子串、1-2 rune 走 unicode61 前缀 + LIKE 兜底
- `lexical.go`:fineTokens(单字+英文词)+ 0.4/0.6 加权 Jaccard;标题加权;Go 侧排序分页(单遍,COUNT 与结果天然一致)

### A2 分块检索(commit bffc425)
- 迁移 0014 `kb_chunks`(800 rune + 100 重叠、标题路径 第X章>第X条、超长段句级硬切、代码围栏、有序列表防误判)+ `kb_chunks_fts`
- `kb_search` 返回块级命中(doc/chunk id、标题路径、score);`kb_read(chunk_ids)` 定点读取;create/update/queue-complete 原子写块;启动补分块

### A3 批量导入(commit 188ff94)
- `POST /api/admin/kb/import-zip`(≤200 文件/≤512MB 解压,文件名消毒,异步队列)
- `GET /api/admin/kb/import-status`(pending/ready/error + 错误明细 + embed_missing);webadmin 进度条 + 单文件重试
- `kb_list(include_docs)` 文档枚举

### B1 网关 embeddings(commit f232a68)
- `POST /v1/embeddings`(Bearer 认证 + 限流 + usage 计量,string/数组 input)
- `llmgateway.Embedder` 进程内客户端(渠道故障转移,4xx 停链/5xx 换路)

### B2 混合检索(commit 21ca12d)
- 迁移 0015 `kb_chunk_embeddings`(归一化 BLOB);后台向量化循环 + 启动回填(批量 32,幂等)
- SearchChunks 两阶段:词法 top-100 ‖ 向量 top-100 → RRF(k=60)融合 → 分页;双路命中排前;dims 不匹配 SQL 过滤;退化链完整(无模型/上游失败 → 纯词法)
- admin:embedding-model GET/PUT、embedding-reindex;webadmin 向量模型配置卡 + 命中测试(块级结果 + score + hybrid/lexical 徽标)

### 反思轮(commit 47a75ff)
- 分块器误判修复(第X条句式/列表级联/ASCII 句切分/代码围栏)
- 词法深命中锚点窗口;块级检索补文档标题召回(kb_fts_trigram OR + d.title LIKE)
- 向量路径超时/并发删除零值防护;zip 解压总量上限

---

## 测试体验升级轮(2026-08,已合入主线)

> 目标:摆脱"打包安装 + 推生产才能测试"的路径。全部测试走**真实 HTTP 接口链路**(数据内容可模拟,接口不模拟)。

### 本地一键环境(dev-env)
- `scripts/dev-env.sh` + `make dev-env`:起 mock 上游 + 本地服务端(dev-data/ 持久)→ 管理 API 灌 seed(部门知识库/技能/MCP/授权/alice·bob)→ 客户端 `npm run dev` 登录 `http://127.0.0.1:18080`
- seed.sh `SEED_LOCAL=1`(技能本地 file:// 裸仓库,不 ssh)+ gateway.local.json(mock-chat 默认模型)
- `PICOAI_UPSTREAM_KEY=sk-xxx` 可切真实 DeepSeek;`PICOAI_LOGIN_MAX_ATTEMPTS` 放宽测试登录限流
- 期间修复:用户组 JSON 数组拆分、mock 渠道缺失致 gateway 校验失败吞错

### UI 组件测试(Vitest + Testing Library + jsdom,`make test-ui`)
- desktop renderer:ChatInput(9)/ArtifactsPanel(4)/Main(3)/Settings(3),window.picoaide 桥统一 stub
- webadmin:Gateway(4)/Knowledge(4)/Marketplace(3)/Users(3),request API mock
- 经验:Radix Select item 选择在 jsdom 不可用 → 由浏览器 E2E 覆盖(组件测试断言选项渲染)

### 浏览器/Electron E2E(`make test-e2e`,依赖 dev-env)
- `admin_ui.spec.ts`:真实浏览器走 dev-env 管理端全流程(登录/渠道联动/命中测试/授权/部门组)
- `smoke_client_full.spec.ts` 扩展:知识库检索场景(mock `TOOLCALL:kb_search` → 真实 kb_search 工具 → 块级结果渲染);E2E 需 `--workers=1`(共享 dev-env)

### 测试暴露并修复的产品缺陷
- **admin 用户 MCP 知识库工具不可用**(GetAccessibleFolderIDs 无 admin 特判 → total 0)→ kb_search/read/list/upload 对 IsAdmin 全量(与 marketplace 语义一致)
- mock 上游二进制未热更(rebuild 后需重启 dev-env 的 mock 进程)
