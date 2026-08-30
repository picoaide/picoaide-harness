# CodeQL 审计报告（企业级登录/权限/品牌改造后重跑）

> 日期：2026-09-04　|　分支：feat/enterprise-rbac-brand　|　工具：CodeQL 2.26.2
> 范围：本次改造（Phase 0-4 + 集成测试）涉及的全部 Go/JS/TS 代码。

## 结论总览

| 语言 | 扫描文件 | 发现数 | 本次引入 | 已修复 | 遗留(非本次) |
|---|---|---|---|---|---|
| Go | 64/115（排除测试） | 10 | 1 | 1 | 9 |
| JavaScript/TypeScript | 66/66 | 0 | 0 | — | 0 |

**JS/TS 零发现**（webadmin 前端 + enterprise client 全部安全）。

## Go 发现明细

### ✅ 本次引入并已修复（1）
| 规则 | 位置 | 说明 | 修复 |
|---|---|---|---|
| go/path-injection | `internal/brand/brand.go` uploadLogo | logo 文件名拼接（`name+ext`）依赖用户输入 | 加严格文件名白名单（`^[a-z]{3,8}\.(svg\|png\|webp\|ico)$`），纵深防御 |

### ⚠️ 既有遗留（非本次引入，9）
| 规则 | 位置 | 说明 |
|---|---|---|
| go/log-injection | `llmgateway/embedding.go:105/119`、`handler.go:150`、`messages.go:289` | 用户可控 model 入 log（此前审计 P2 已知残留，新增 messages.go 一处同源） |
| go/path-injection | `marketplace/admin.go:159/162`、`sharedskills/routes.go:362` | 既有 skill 归档路径拼接（旧代码，未在本改造范围） |
| go/clear-text-logging | `scripts/mock-upstream.go:239` | 测试脚本（非生产） |
| go/unhandled-writable-file-close | `util/crypto.go:57` | master.key 文件句柄（既有） |

> 备注：marketplace/sharedskills 的 path-injection 与旧审计使用的查询套件不同（本次用 security-and-quality 全套，覆盖更广），非本次变更引入。

## 后续建议（P2 非阻塞）
1. llmgateway `log.Printf` 使用 `%q`/白名单 model（4 处，低风险——仅日志注入）
2. marketplace/sharedskills 归档路径加 `filepath.Clean` + 白名单（需专用测试）
3. crypto.go 文件句柄显式 close

## 门禁状态
- `make check` 等价项（gofmt/vet/全 Go 测试/webadmin 测试+build）：全部通过（见会话记录）
- `yarn check` 等价项（enterprise typecheck + 84 测试）：通过
