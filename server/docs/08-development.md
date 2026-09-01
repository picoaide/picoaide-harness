# 开发指南

## 1. 目录结构

```
cmd/server/            # 服务端入口(--bootstrap-admin/-addr/-data/-db-driver/-pg-dsn + / 与 /portal 门户页 + webadmin 静态内嵌)
internal/              # router(路由唯一真源)/serverauth(认证/管理端/RBAC)/llmgateway(网关)/
                       # marketplace(技能商城)/agentshare/sharedskills(共享内容)/
                       # capabilities(能力中心聚合)/connectors/brand(品牌门户)/
                       # bootstrap/telemetry/serverstore(DAO+PG 迁移)/util(crypto 等)
webadmin/              # Vite React + shadcn,pages/(Login/Users/Departments/Auth/Brand/Gateway/Usage/Marketplace/Capabilities/Connectors/Audit/ErrorMonitoring/ServerInfo)
scripts/               # install-server.sh(一键部署)+ deploy.sh(容器化生命周期)+ mock-upstream.go
docs/                  # 本文档集(superpowers/ 为历史设计文档)
```

## 2. 工程原则(节选,完整见 AGENTS.md)

1. UI 一律 shadcn/ui,禁止自写 UI 组件(`npx shadcn@latest add <name>` 拉取);webadmin 统一。
2. 函数尽量复用:同一逻辑只实现一次,重复 2 次即提取共享模块(服务端 serverstore DAO、util、公共中间件;客户端归档安全校验等)。
3. **TDD 红-绿-commit**:每个任务先写测试(红)→ 实现(绿)→ commit;非平凡逻辑必须有可运行测试(Go `_test.go` / TS `*.test.ts`)。
4. 每任务结束 commit,信息 `feat:|fix:|test:|docs:|chore:` 单行 ≤72 字符。
5. 安全边界不得绕过:凭证 AES-GCM、API token 只存哈希、TOFU 证书校验、限流/审计、归档安全校验(SKILL.md/agent.cordis.yml 顶层要求、越界/symlink 拒绝)。
6. 服务端 API 一律 JSON 信封;客户端接入方经 `/api/client/v2/*` 与 `/v1/*` 网关。

## 3. TDD 流程

```bash
# 1) 写测试 → 运行确认红(DB 用例:设置 PG_DSN_TEST 指向临时测试库;不设则自动 Skip)
PG_DSN_TEST=postgres://picoaide:ci@127.0.0.1:5432/picoaide_test?sslmode=disable go test ./internal/... -run TestXxx
# 2) 实现 → 运行确认绿
# 3) git add -A && git commit -m "feat: xxx"
```

实施计划:docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md(阶段 1 服务端网关 → 2 客户端骨架 → 3 本地能力 → 4 产品化;按序执行)。

## 4. 常用命令

```bash
make test              # 服务端全量测试(不依赖数据库;无 PG 时 DB 用例 Skip)
make test-server       # 服务端各业务域(显式枚举全部包)
make check             # gofmt + go vet + test-server + webadmin 测试与构建(提交前跑)
make build-server / webadmin / docker-image / release-export
PICOAI_ADMIN_PASSWORD=x bin/picoaide-server -addr :8080 -data ./data -db-driver pg -pg-dsn <DSN> --bootstrap-admin admin
go run scripts/mock-upstream.go    # 假上游(无外网验证网关)
# 桌面客户端(Yarn workspace,见仓库根 README):
corepack yarn workspace dsh-plugin-desktop dev   # 开发
corepack yarn ws dsh-plugin-desktop test         # 单测(等)
```

## 5. 测试约定

- 服务端:每测试独立临时 PostgreSQL 库(`NewTestDB`/pgx CREATE/DROP DATABASE),覆盖认证(token 生命周期/限流/admin CSRF/RBAC)、网关代理(流式/错误映射/限流/计量)、商城与共享(授权/审计/多版本/归档安全)、迁移、能力中心聚合、品牌门户。
- 桌面客户端与 webadmin:vitest(仓库 Yarn workspace / webadmin npm)。

## 6. CI

`.github/workflows/ci.yml`:server(Go 1.26,`go vet` + `go test ./...`——CI 不提供数据库,DB 用例自动 Skip)+ deploy 脚本/compose 校验)/ desktop-linux/windows/macos(Node 24,Yarn 门禁与三平台产物)/ release(GitHub Release)。本地 `make check` 近似 CI 的 server+webadmin 部分。

## 7. 契约(改代码前必读,两端必须一致)

- REST 错误信封:`{"error":{"code","message"}}`;code 见 03-api-reference.md §1。
- bootstrap:`{default_model, models, skills, web, connectors}` 服务端 ↔ 客户端 `BootstrapConfig` 严格对齐。
- 命名空间:全部路由经 `internal/router.Register` 集中声明(唯一真源),禁止业务包自行 `r.Group()` 注册生产路由。
- DB:PostgreSQL 唯一,迁移 `internal/serverstore/migrations-pg/`(0001–0048)——见 06-database.md。
- 客户端侧(桌面)契约见仓库根 `docs/plugin-development.md` 与 `packages/host/desktop/docs/plugin-services.md`。

## 8. 客户端本地配置(桌面侧,见仓库根文档)

桌面客户端的本地设置由官方 DSH settings 与自研插件(enterprise/connectors/cron/browser)负责,见 `packages/host/*` 与 `packages/client/*`;服务端不持有客户端本地设置。
