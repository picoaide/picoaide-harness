# picoaide-next 后端同步差异分析

对比基准：当前仓库 `server/`（commit `921a638`，2026-08-16 引入后未再更新）
                vs `picoaide/picoaide-next@server-webadmin-only`（`31364b5`，2026-08-19，最新最全分支）

## 一、目录结构对比

两边核心布局**一致**，均为 Go 服务端 + webadmin 前端：

```
cmd/server + internal/{bootstrap,knowledge,llmgateway,marketplace,serverauth,serverstore,util}
+ webadmin/ + docker/ + scripts/ + 根级 Makefile/Caddyfile/Dockerfile/docker-compose.yml/go.mod
```

`internal/llmgateway/channels/` 子包两边都有（非新增结构）。

| 差异项 | 当前 server/ | server-webadmin-only |
|---|---|---|
| `docs/`（01-08 全量 + 审计报告 + research-usage-page） | ❌ 无 | ✅ 有（87 文件） |
| `AGENTS.md` / `CHANGELOG.md` / `README.md` / `.gitignore` / `.dockerignore` | ❌ | ✅ |
| `.github/workflows/`（ci.yml + docker.yml） | ❌ | ✅ |
| `webadmin/vitest.config.ts` + `src/test/setup.ts` + `components.json` | ❌ | ✅（前端测试基建） |
| `scripts/dev-env.sh` | ✅ | ❌ 已删（被根级 dev-env 方案替代） |
| `webadmin/dist/` 提交 | ✅ | ❌ 不再提交构建产物 |
| `bin/`（本地编译产物 picoaide-server） | 有（gitignore） | 无 |

## 二、文件级差异总览（204 个文件）

- **新增 117**：docs 87、serverstore 16、webadmin 16、.github 2、根文档 5
- **修改 85**：internal 61、webadmin 12、cmd 1、Makefile 1、scripts 1
- **删除 2**：`scripts/dev-env.sh`、`webadmin/dist/index.html`

代码 diff 规模（不含 docs）：**+16604 / -1476** 行，go.mod **零依赖变化**（全部功能用标准库/SQLite 实现）。

## 三、功能增量（按模块）

### 1. internal/serverstore — +4147/-63（最大增量）
- **新文件**：`budget.go`（货币预算）、`departments.go`（部门树）、`effective.go`（生效配额计算）
- **迁移 15 → 26**，新增 11 个：
  - `0017_departments` 部门表
  - `0018_seed_everyone_group` 预留 everyone 组
  - `0019_groups_nocase_unique` 组名大小写唯一
  - `0020_usage_kind` 用量类型
  - `0021_user_quota` 用户配额
  - `0022_money_quota` 货币配额
  - `0023_offpeak_discount` 低谷折扣
  - `0024_dept_budget` 部门预算
  - `0025_usage_created_at_index` 用量索引（审计修复）
  - `0026_mcp_name_unique` MCP 名唯一（FK-safe 去重）
  - `0027_user_groups_group_index` 用户组索引

### 2. webadmin — +7669/-908
- 新增 **Departments.tsx 页面**（部门树管理、继承预算显示）
- 新增 6 个页面测试（api/Departments/Gateway/Knowledge/Marketplace/Usage/Users）+ vitest 基建
- 修改 12 个：App/api/Usage（用量页大改）/Gateway/Marketplace/Knowledge/Users/Audit 等
- 新增 UI 组件：checkbox/skeleton/tabs

### 3. internal/llmgateway — +1674/-80
- admin.go、sync.go、upstream.go、channels/（多通道）、routes.go、handler.go、embedding.go

### 4. internal/serverauth — +1557/-115
- admin.go、handler.go、ldap.go、oidc.go、ratelimit.go、bootstrap_admin.go（配额/预算相关认证）

### 5. internal/marketplace — +791/-60
- 新增 **skill_api.go**：`GET /api/marketplace/skills/updates` 技能自动升级接口
- admin.go、credentials.go

### 6. internal/knowledge — +714/-92
- admin/import/chunk_index/lexical/mcp/queue/search 修复（审计 A4）

### 7. 其他 — +40
- bootstrap +5、util +22（crypto/password）、cmd +13、Makefile 微调

## 四、同步方案（目录映射）

**直接覆盖到 `server/`**（路径前缀与 webadmin 分支根一一对应）：
```
cmd internal webadmin docker scripts Makefile Caddyfile Dockerfile
docker-compose.yml go.mod go.sum + 新增 .dockerignore
```

**需要决策（勿直接覆盖）**：
- `AGENTS.md` / `README.md` / `CHANGELOG.md` / `docs/` / `.github/` / `.gitignore`
  → 这些是 picoaide-next 仓库根级文件，与当前仓库根同名内容冲突
  （当前仓库根有 DSH Desktop 版 AGENTS.md、产品 docs/、.github/ci.yml）
- `docs/research-usage-page/`（56 万行第三方项目源码树调研 JSON）→ 建议排除
- `scripts/dev-env.sh` 将被删除 → 确认是否保留

**同步风险点**：
- 工作区 server/ 无未提交改动 ✅（同步安全；`bin/` 为 gitignore 产物）
- DB 升级链 0016 → 0027（迁移按顺序执行）
- webadmin package.json/lock 有变 → 需 `npm ci` + vitest
- 验证：`go build ./... && go test ./...` + webadmin `npm run test`
