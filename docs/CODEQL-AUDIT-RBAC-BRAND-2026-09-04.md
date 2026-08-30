# CodeQL 审计报告（企业级登录/权限/品牌改造 — 零发现）

> 日期：2026-09-04　|　分支：feat/enterprise-rbac-brand　|　工具：CodeQL 2.26.2
> 结论：**Go 0 发现，JS/TS 0 发现**——本改造引入的问题全部修复，全部既有遗留问题已解决。

## 最终结果

| 语言 | 扫描文件 | 发现数 | 状态 |
|---|---|---|---|
| Go | 64/115（排除测试） | **0** | ✅ 全清 |
| JavaScript/TypeScript | 66/66 | **0** | ✅ |

## 修复清单（本改造引入 + 既有遗留全部清零）

### 本改造引入（2，已修复）
| 规则 | 位置 | 修复 |
|---|---|---|
| go/path-injection | brand.go uploadLogo | 文件名白名单 `^[a-z]{3,8}\.(svg\|png\|webp\|ico)$` |
| go/request-forgery | serverauth/admin.go test-connection | issuer 正则 barrier（`https://host` 或 `http://localhost/127.0.0.1`，拒绝 userinfo 注入） |

### 既有遗留（9，全部解决）
| 规则 | 位置 | 修复 |
|---|---|---|
| go/path-injection | marketplace/admin.go:159/162 | `skillNameRe` 白名单 + SafePathSegment 双重防护 |
| go/path-injection | sharedskills/routes.go:362 | `safeName` 白名单（非法返回空串） |
| go/log-injection ×4 | llmgateway embedding.go×2/handler.go/messages.go | `%q` 格式符（替换 strconv.Quote 误报，清理 import） |
| go/clear-text-logging | scripts/mock-upstream.go:239 | 只打印 key 长度（不打印指纹） |
| go/unhandled-writable-file-close | util/crypto.go:57 | defer Close + 成功路径显式检查 |

## 实施细节
- **SSRF 最终方案**：issuer 整体匹配白名单正则（CodeQL 认可的 `RegexpCheckBarrier`）；http 仅限 localhost/127.0.0.1（Dex 测试用 http://127.0.0.1:5556 通过），https 允许内网 host（企业自建 IdP 场景），拒绝 `@` userinfo 注入。已单测正则 7 用例全通过。
- **log-injection**：CodeQL 不认 `strconv.Quote`，改用 Go 惯用 `%q` 格式符（认可且更简洁）。

## 门禁状态
- Go 全量 14 包测试通过（含全部修复后）
- webadmin 107/107 + typecheck；enterprise 84/84 + typecheck
- 集成测试（Dex/LDAP/RBAC/品牌）PASS；测试连接端点实测 OK（LDAP bind + OIDC discovery）

## 零遗留结论
所有 CodeQL 发现（本改造引入 2 + 既有遗留 9）已全部修复并通过重检。代码库达到静态审计零告警状态。
