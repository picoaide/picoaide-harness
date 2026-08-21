# 开发指南

## 1. 目录结构

```
cmd/server/            # 服务端入口(--bootstrap-admin/-addr/-data + webadmin 静态内嵌)
internal/              # serverauth(认证/管理端)/ llmgateway(网关)/ marketplace(商城)/
                       # knowledge(知识库)/ serverstore(DAO+迁移)/ util(crypto 等)/ bootstrap/webadmin(embed)
desktop/
  src/main/            # index.ts(工具注册表)/ ipc.ts / cdp_server.ts / plugin_ipc.ts / ws.d.ts
                       # agent/(engine/modes/continue/events/artifacts/provider)
                       # tools/(filesystem/terminal/sandbox/screen/ocr/clipboard/web/browser/paths)
                       # mcp/(adapter/installer/integration/runner)  skill/(loader/installer/integration)
                       # store/(db/migrations/conversations/messages/artifacts/settings)
                       # gateway/(auth/bootstrap/config/health/marketplace/remote_mcp/tls)
  src/preload/         # contextBridge 白名单 API
  src/renderer/        # api/ components/(ui=shadcn + 业务) pages/(Login/Main/Settings) stores/ lib/
  tests/               # E2E/冒烟预留
browser-extension/     # Chrome MV3 插件
webadmin/              # Vite React + shadcn,pages/(Login/Users/Gateway/Usage/Marketplace)
scripts/               # pkg-*.sh + mock-upstream.go
docs/                  # 本文档集
```

## 2. 工程原则(节选,完整见 AGENTS.md)

1. UI 一律 shadcn/ui,禁止自写 UI 组件(`npx shadcn@latest add <name>` 拉取);renderer 与 webadmin 统一。
2. 函数尽量复用:同一逻辑只实现一次,重复 2 次即提取共享模块(客户端 `tools/paths.ts` 的 `isAllowed`、审批门控、编码检测、gateway 连接器;服务端 serverstore DAO、util、公共中间件)。
3. **TDD 红-绿-commit**:每个任务先写测试(红)→ 实现(绿)→ commit;非平凡逻辑必须有可运行测试(Go `_test.go` / TS `*.test.ts`)。
4. 每任务结束 commit,信息 `feat:|fix:|test:|docs:|chore:` 单行 ≤72 字符。
5. 零配置原则:客户端不得新增"员工功能配置"入口;唯一本地配置 = 可访问目录 + 建议安装管理 + 刷新。
6. 安全边界不得绕过:审批门控、`isAllowed`、命令白名单、凭证不落盘、TOFU 指纹、插件启发式审批。
7. 服务端 HTTP 全走 `session.defaultSession.fetch`(证书/TOFU);登录页拒绝非 HTTPS 远程地址。

## 3. TDD 流程

```bash
# 1) 写测试 → 运行确认红
go test ./internal/serverauth/... -run TestXxx        # 服务端
cd desktop && npm test -- engine                       # 客户端
# 2) 实现 → 运行确认绿
# 3) git add -A && git commit -m "feat: xxx"
```

实施计划:docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md(阶段 1 服务端网关 → 2 客户端骨架 → 3 本地能力 → 4 产品化;按序执行)。

## 4. 常用命令

```bash
make test              # 服务端全量测试
make test-server       # 服务端各域
make test-client       # desktop npm test + typecheck
make check             # gofmt + go vet + 全部测试(提交前跑)
make build-server / build-client / build-desktop / webadmin / pkg-*
cd desktop && npm run dev        # electron-vite 开发
cd desktop && npx electron .     # 生产模式(先 build)
PICOAI_ADMIN_PASSWORD=x bin/picoaide-server -addr :8080 -data ./data --bootstrap-admin admin
bash scripts/mock-upstream.go    # 假上游(无外网验证网关)
```

## 5. 测试约定

- 客户端单测内嵌源文件旁(`*.test.ts`,vitest);`tests/` 为 E2E 预留。
- 引擎测试覆盖:审批门控(超时/队列/cancel/allow_dir)、三模式、恢复截断、`PICOAI_TEST_AUTO_APPROVE` 钩子、事件流。
- 服务端测试覆盖:认证(token 生命周期/限流/admin CSRF)、网关代理(流式/错误映射/限流)、商城(凭证加密/拉取限流/审计)、知识库(权限/搜索)、迁移。

## 6. CI

`.github/workflows/ci.yml`:server(Go 1.24, make test-server + build)/ desktop(Node 20, npm ci + test + typecheck + build)/ webadmin(Node 20, build)。本地 `make check` 近似 CI 的 server+desktop 部分。

## 7. 契约(改代码前必读,两端必须一致)

- 事件协议:`agent:event` 全 snake_case(text_delta/reasoning_delta/tool_start/tool_end/tool_error/confirm_required/artifact/done/canceled/error)——见 01-architecture.md §4。
- REST 错误信封:`{"error":{"code","message"}}`;code 见 03-api-reference.md §1。
- bootstrap:`{default_model, models, skills, mcp, web}` 服务端 ↔ 客户端 `BootstrapConfig` 严格对齐。
- CDP 桥:固定 `127.0.0.1:54321`,JSON-RPC(`browser.tabInfo/getContent/click/type/navigate/scroll/executeScript`)。
- 审批签名:`confirm(requestId, ok)`;`needsApprovalFor(command, allowedDirs)`;`isAllowed(absPath, allowedDirs)`。
- DB:客户端 4 表 + schema_migrations;服务端 17 表(迁移 0001-0009,0007 废弃)——见 06-database.md。

## 8. 客户端本地 settings 键

| 键 | 说明 |
|----|------|
| `allowed_dirs` | 可访问目录列表(安全边界,JSON 数组) |
| 建议安装 | 已装 skill/mcp 记录(installer 模块) |
| 其余 | 内部缓存,不向员工开放配置入口 |
