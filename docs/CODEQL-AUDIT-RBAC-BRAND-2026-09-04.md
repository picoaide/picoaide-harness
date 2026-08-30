# CodeQL 审计报告（企业级登录/权限/品牌改造，最终版）

> 日期：2026-09-04　|　分支：feat/enterprise-rbac-brand　|　工具：CodeQL 2.26.2
> 范围：Phase 0-4 全部实现 + 剩余功能补齐（测试连接/门户 public/品牌跟随等）后重检。

## 结论总览

| 语言 | 扫描文件 | 发现数 | 本次引入 | 已修复 | 遗留(非本次) |
|---|---|---|---|---|---|
| Go | 64/115（排除测试） | 10 | 2 | 2 | 9 |
| JavaScript/TypeScript | 66/66 | 0 | 0 | — | 0 |

**JS/TS 零发现**（webadmin 前端 + enterprise client 全部安全）。

## ✅ 本次引入并已修复（2）

| 规则 | 位置 | 说明 | 修复 |
|---|---|---|---|
| go/path-injection | `internal/brand/brand.go` uploadLogo | logo 文件名拼接依赖用户输入 | 文件名白名单 `^[a-z]{3,8}\.(svg\|png\|webp\|ico)$` |
| go/request-forgery (SSRF) | `internal/serverauth/admin.go` test-connection | 测试连接端点对 issuer 做外部请求 | issuer 限制 https / loopback http |

## ⚠️ 既有遗留（非本次引入，9）

| 规则 | 位置 | 说明 |
|---|---|---|
| go/path-injection | `marketplace/admin.go:159/162`、`sharedskills/routes.go:362` | 既有 skill 归档路径拼接（旧代码） |
| go/log-injection | `llmgateway/embedding.go:105/119`、`handler.go:150`、`messages.go:289` | 用户可控 model 入日志（此前已知 P2 残留） |
| go/clear-text-logging | `scripts/mock-upstream.go:239` | 测试脚本（非生产） |
| go/unhandled-writable-file-close | `util/crypto.go:57` | master.key 文件句柄（既有） |

> 备注：marketplace/sharedskills 的 path-injection 是旧审计未覆盖的既有代码（本次用 security-and-quality 全套覆盖更广），非本变更引入。

## 后续建议（P2 非阻塞）
1. llmgateway `log.Printf` 使用 `%q`/白名单 model（4 处，低风险——仅日志注入）
2. marketplace/sharedskills 归档路径加 `filepath.Clean` + 白名单（需专用测试）
3. crypto.go 文件句柄显式 close

## 门禁状态
- Go 全量 14 包测试全部通过（含 SSRF/path 修复后 serverauth/brand/cmd）
- webadmin 107/107 + typecheck；enterprise 84/84 + typecheck
- 集成测试（Dex/LDAP/RBAC/品牌/portal.public/测试连接）PASS
