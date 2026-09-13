# PicoAide 服务端安全审计报告（2026-09-13）

- **审计对象**：`server/`（Go 服务端，114 个非测试文件 / 约 30,536 行；另有 130 个 `_test.go`）
- **基线**：`master` @ `3db78e585a`（v2.7.2），工作区干净，未做任何代码修改
- **范围**：认证与会话（local/LDAP/OIDC/MFA/CSRF/限流）、RBAC 与路由护栏、LLM 网关（转发/密钥/计量/结算）、归档与文件路径、出站请求（SSRF）、加密与密钥管理、审计哈希链
- **方法**：
  1. 人工逐包审读（认证、网关、归档、serverstore、util、cmd/server）；
  2. **CodeQL** `go-security-extended.qls`（35 条查询，覆盖全部 114 个非测试文件）→ **0 结果**；
  3. `go build ./...` + `go vet ./...` 全绿；`go test ./... -count=1`（接 `pg-test` 容器，全部 DB 用例真实执行）**23 个包全绿**——注意 P0-1 恰恰被 `handler_test.go:208-215` 断言"客户端显式 false 应被尊重"锁成预期，**门禁全绿不等于安全**；
  4. 对高危疑点写**运行期探针**（真实 PostgreSQL 临时库 + 真实 httptest 路由树）复现，共 6 组探针，结果见各条正文；
  5. 对 2026-09-06 / 09-08 两轮旧审计报告与 R2–R6 修复批次做去重核对，只报**当前 HEAD 仍存在**的问题。
- **探针位置**：`temp/audit-20260913/`（审计后已从 `server/` 树中移除，`git status` 干净）

---

## 0. 修复状态（2026-09-13 修复批次）

**26 条全部处理：25 条已修复并带永久回归测试，1 条（P3-6）判定为"接受的风险"并记录理由。**

| 编号 | 状态 | 修复要点 | 回归测试 |
|---|---|---|---|
| P0-1 | ✅ 已修 | 服务端**强制** `stream_options.include_usage=true`（客户端无权关闭）；上游漏报 usage 时按**客户端原始请求体字节**兜底估算 prompt 侧（仅当确有交付内容，避免为失败请求计费） | `TestStreamUsageCannotBeDisabledByClient`、`TestStreamPromptFallbackWhenUpstreamOmitsUsage`、`TestNonStreamPromptFallbackWhenUsageMissing`（旧反向断言已改写） |
| P1-1 | ✅ 已修 | 票据"检查+占用"合并为一条 `UPDATE … RETURNING`（5 次上限变硬）；第二步加 IP/用户双桶限流；TOTP 记录已用时间步 | `TestAuditFixMFAChallengeAttemptsAreAtomic`、`TestAuditFixMFALoginIsRateLimited`、`TestAuditFixTOTPReplayRejected` |
| P1-2 | ✅ 已修 | 新增单 IP 失败桶（60/5min）+ 全局密码校验并发闸（4×CPU，上限 32，超时 429）；所有密码校验点（员工/管理员登录、改密、MFA 开关）统一走闸 | `TestAuditFixRandomUsernameStillRateLimitedByIP`、`TestAuditFixPasswordVerifyGateIsBounded` |
| P1-3 | ✅ 已修 | 回调动限流桶键改用 `c.ClientIP()`（可信代理下解析真实 IP，不可信来源伪造 XFF 无效） | `TestAuditFixOIDCCallbackKeyUsesClientIP`（真实引擎 + 可信代理配置） |
| P1-4 | ✅ 已修 | OIDC discovery/token/JWKS 统一走受护栏 client（`SafeOutboundTransport` + 逐跳重定向复检）；issuer **保存时**与"测试连接"共用同一校验器 | `TestAuditFixIssuerValidationRejectsMetadataAndBadSchemes`、`TestAuditFixOIDCOutboundClientGuardsMetadata` |
| P1-5 | ✅ 已修 | Anthropic `/messages` 流式转发改用 `context.WithoutCancel`（与 chat 同源） | 由 `TestAnthropicStreamWithoutUsageStillBilled` 覆盖 |
| P1-6 | ✅ 已修 | 迁移 0065 增加 `usage.provider_id`；取价按**实际命中的 provider**（回填从行内读），name 口径兜底加 `ORDER BY provider_id` 确定性排序 | `TestAuditFixPricingFollowsChosenProvider` |
| P2-1 | ✅ 已修 | 员工面列表与下载均按 `apps.enabled=1` 过滤（批量查询，不 N+1） | agentshare 新增用例（子代理 A 交付） |
| P2-2 | ✅ 已修 | 迁移 0066：`admin_sessions.secret_hash`，cookie 值只存 SHA-256；吊销"其它会话"改按 `secret_hash` 比较 | `TestAuditFixAdminSessionStoresOnlyHash` |
| P2-3 | ✅ 已修 | 迁移 0064：`users.last_totp_step` + `ConsumeTOTPStep` 原子占用；同一 (user, step) 只能成功一次 | `TestAuditFixTOTPReplayRejected` |
| P2-4 | ✅ 已修 | OIDC 流程表满 **fail-closed**（拒绝新流程，不再驱逐在途）；`/auth/{oidc,openid}/login` 加 IP 限流 | `TestAuditFixOIDCFlowTableFullFailsClosed` |
| P2-5 | ✅ 已修 | 预览上限统一到 `skillmanifest.MaxSkillMDBytes`（四处同值锁定）；渠道同步改打 **provider 自己的 base_url**（自建代理的 key 不再被发往厂商端点） | `preview_limit_single_source_test.go`（子代理 A）、`TestAuditFixProviderSyncUsesOwnBaseURL` |
| P2-6 | ✅ 已修 | 包内 `author` 不再回写 `apps.owner`（只写展示名 `SetAppTitle`），官方 App 的空归属保持不变 | marketplace 新增用例（子代理 A 交付） |
| P2-7 | ✅ 已修 | LDAP 拨号加连接期 IP 复检；**保存时**拒绝非回环明文 `ldap://`（逃生阀 `PICOAI_LDAP_ALLOW_PLAINTEXT=1`，存量配置不受影响） | `TestAuditFixLDAPDialGuardsMetadata`、`TestAuditFixPlaintextLDAPRejectedByDefault` |
| P2-8 | ✅ 已修 | pending 行清理阈值 1h → 6h（远超 90s 空闲超时的流上限） | `TestAuditFixPendingUsageRetentionExceedsStreamLifetime` |
| P2-9 | ✅ 已修 | 迁移 0067：`users.external_id/external_source`；外部身份绑定 IdP 主体（OIDC `sub` / LDAP DN），同名不同主体一律拒绝；组同步仅在 IdP **下发了组声明**时执行（不再跨源清空） | `TestAuditFixExternalIdentityIsBoundToSubject`、`TestAuditFixGroupsOnlySyncedWhenClaimPresent` |
| P2-10 | ✅ 已修 | 上游错误体收敛为 `{error:{message,type,code}}`（≤2KB，非 JSON 给固定文案）；落账判定收紧为 2xx | `TestUpstreamErrorBodySanitized`、`TestSanitizeUpstreamErrorNonJSON` |
| P2-11 | ✅ 已修 | 网关两个命名空间挂 `InFlightGuard`（单用户同时在跑请求 ≤32，可 `PICOAI_GATEWAY_MAX_INFLIGHT_PER_USER` 覆盖）；embedding client 改单例复用连接池 | `TestAuditFixPerUserInflightIsBounded` |
| P2-12 | ✅ 已修 | 渠道素材统一 `nosniff` + `default-src 'none'; …; sandbox` CSP，SVG 加脚本特征检查（命中即 404，官方 logo 实测放行） | channel 包 30 个用例 + 变异验证（子代理 B 交付） |
| P3-1 | ✅ 已修 | `newEngine()` 统一 `RedirectTrailingSlash=false`：带尾斜杠的 API 请求从 307 变为 404 JSON（不再跳过限体中间件） | `TestAuditFixTrailingSlashNoRedirect` |
| P3-2 | ✅ 已修 | 管理面限流键纳入 `dbLimiterScope` 命名空间，与客户端面真正共享同一失败预算 | `TestAuditFixLoginBudgetSharedAcrossSurfaces` |
| P3-3 | ✅ 已修 | 余额查询 client 显式拒绝重定向 | `TestAuditFixBalanceClientRejectsRedirect` |
| P3-4 | ✅ 已修 | 磁盘回退前校验 version 单段合法性 + `Clean` 后前缀断言（越界按"归档缺失"处理） | `skill_archive_path_test.go`（子代理 A 交付） |
| P3-5 | ✅ 已修 | 下载/门户 URL 来源优先取管理员配置的"对外地址"（`server.base_url`，main 注入 resolver），无配置才回落请求头 | clientrelease 既有用例 + 新逻辑 |
| P3-6 | ⚠️ 接受 | 单请求多次全量解压（上限 16MB 原始 / 64MB 解包 / 10000 条目；需登录 + pendingCap=10，无越权/越界后果）。压缩比闸会误伤高压缩率的合法文本技能，收益与风险不成比例，**记录为接受的性能风险** | — |
| P3-7 | ✅ 已修 | `go mod tidy`：未使用的 go-git 依赖树（17 条 require + 83 条 go.sum）移除 | 构建/vet/全量测试 |

### 升级与行为变更注意（运维必读）

1. **迁移 0064–0067 自动应用**。`0066` 会让**现有管理会话全部失效**（旧行的会话凭证是明文，保留可用等于没修）——管理员升级后需重新登录一次。
2. **P2-7**：新保存/修改 LDAP 配置时，非回环 `ldap://` 会被拒绝；内网目录必须用 `ldaps://`，或显式设置 `PICOAI_LDAP_ALLOW_PLAINTEXT=1` 放行（存量配置不受影响，登录路径不因升级而中断）。
3. **P0-1 行为变更**：客户端传 `stream_options.include_usage=false` 不再被尊重（计量需要上游回报 usage）；若上游漏报，输入侧按请求体字节**低估**兜底并标记 `estimated=true`。
4. **P2-10 行为变更**：上游 4xx 响应体只透传 `error.message/type/code`（其余字段丢弃），依赖上游自有错误字段的客户端需调整。
5. **P3-1 行为变更**：带尾斜杠的 API 请求返回 404 JSON（此前 307）。

### 验收证据：用**原审计探针**复跑（修复后无法再复现）

| 探针（`temp/audit-20260913/`） | 修复前 | 修复后（2026-09-13 复跑） |
|---|---|---|
| `llmgateway_probe_test.go`（P0） | 关闭 `include_usage` 后 `prompt_tokens=0 / cost=0.000150` | **两行完全一致**：`prompt_tokens=1234 completion_tokens=5 cost=0.012390`（第二行即攻击形态，已按输入计费） |
| `serverauth_probe_test.go`（P1-1 并发） | 同一票据 40 并发 → **10 次**穿过"最多 5 次"的门 | 40 并发 → **恰好 5 次**（原子占用生效） |
| 同上（P1-1 重放） | 同一 TOTP 码两次都 **200** | 第一次 200、第二次 **401 动态码错误或已失效** |
| 同上（P3-2 分桶） | 客户端 3 次失败后管理面仍可继续（401×3） | 管理面**立即 429×3**（预算真正共享） |
| `serverauth_oidc_probe_test.go`（P1-3） | 不同 `X-Forwarded-For` → **同一桶键** `ip:172.28.0.2`，第 61 个无辜用户 429 | 桶键分别为 `ip:203.0.113.7` / `ip:198.51.100.9`，探针的"坍缩"前置断言**直接失败**（漏洞已不存在） |
| `serverstore_probe_test.go`（P1-6） | 一次 UPDATE 后单价 1.00 → **100.00** | 物理行序同样翻转，取价恒为 **1.00**（确定性）；实际命中 provider 时按该 provider 价（`TestAuditFixPricingFollowsChosenProvider`：0.2 元而非 0.002 元） |
| `router_probe_test.go`（P3-1） | 合成 engine 上复现 gin 的 307 行为 | 生产引擎由 `cmd/server` 的 `TestAuditFixTrailingSlashNoRedirect` 断言：`/api/client/v2/auth/login/` → **404 JSON**（不再 307、不再跳过限体中间件） |
| P1-2 随机用户名放大 | 30 次随机用户名全部 401、无任何节流 | `TestAuditFixRandomUsernameStillRateLimitedByIP`：**第 61 个请求被单 IP 桶拦下**；并发闸另有 `TestAuditFixPasswordVerifyGateIsBounded` |

> 注：`serverauth_probe_test.go` 的顺序段使用 `PICOAI_LOGIN_MAX_ATTEMPTS=10000` 的测试夹具（探针自身设置），"顺序 15 次无 429"是夹具产物；第二步限流的真实验证在 `TestAuditFixMFALoginIsRateLimited`（阈值 3，5 轮内必现 429）。

---

## 1. 结论摘要（审计时点的原始判定）

| # | 级别 | 问题 | 可达性 | 验证 |
|---|---|---|---|---|
| P0-1 | **P0** | 流式请求 `stream_options.include_usage=false` → 输入 token 计费恒为 0 | 任意员工 token，一行请求体 | **已复现** |
| P1-1 | P1 | 管理员 MFA 可无限爆破（票据可无限重签 + 尝试计数非原子 + 零限流） | 已知管理员密码 | **已复现（3 条独立证据）** |
| P1-2 | P1 | 未认证者可用随机用户名无限触发 argon2id(64MB) → OOM DoS | 无需认证 | **已复现** |
| P1-3 | P1 | OIDC 回调限流桶键用 `RemoteAddr`，反代下全组织共享 → 61 个未认证请求锁死全员 SSO | 无需认证（前置：开启 OIDC） | **已复现** |
| P1-4 | P1 | OIDC 运行期出站未装 netguard + issuer 保存零校验（护栏只在"测试连接"按钮） | super_admin 配置 + 未认证放大 | 代码确认 |
| P1-5 | P1 | Anthropic `/messages` 转发未解耦客户端 context → 早断连后输入侧 0 计费 | 任意员工 token | 代码确认（与 P0-1 同源） |
| P1-6 | P1 | 同名模型挂多 provider 时计价无确定性（一次 UPDATE 即换价 100 倍／可命中 0 价） | 多 provider 部署 | **已复现** |
| P2-1 | P2 | agent-presets 员工面不检查 `apps.enabled`：下架后仍可列出/下载 | 已授权员工 | 代码确认 |
| P2-2 | P2 | 管理会话 token 明文入库（`api_tokens` 只存哈希，口径不一致） | 需 DB 读面 | 代码确认 |
| P2-3 | P2 | TOTP 无重放保护：同一动态码在窗口内可重复使用 | 需密码+票据 | **已复现** |
| P2-4 | P2 | OIDC flow 表（上限 1000）可被匿名刷满并驱逐在途流程 | 无需认证 | 代码确认 |
| P2-5 | P2 | 渠道同步用渠道硬编码 URL，忽略自定义 `base_url` → key 被发往厂商端点 | 管理员误配后**每小时自动** | 代码确认 |
| P2-6 | P2 | 官方 App 的 `owner` 被上传包内 `author:` 回写 | super_admin 上传 | 代码确认 |
| P2-7 | P2 | LDAP 探测/运行期无出站 IP 复检，且允许 `ldap://` 明文传 bind 密码 | super_admin | 代码确认 |
| P2-8 | P2 | >1h 的长流 pending 行被定时清理 → 之后回填必然失败，整条流零计费 | 任意员工（构造长流） | 代码确认 |
| P2-9 | P2 | 外部身份之间无绑定：IdP 可自选用户名时接管同名 external 账号；groups 全量替换会清掉他源组 | 需 LDAP+OIDC 并用或 IdP 可自选名 | 代码确认（前提依赖 IdP） |
| P2-10 | P2 | 上游 4xx 错误体原样透传给员工（`<400` 落账判定偏远为次要） | 任意员工 | 代码确认 |
| P2-11 | P2 | 网关无并发准入：单员工可打满连接/内存（仓库既有实测 1500 并发上限） | 任意员工 | 代码 + 既有实测 |
| P2-12 | P2 | 渠道 SVG 素材下发无 `nosniff`/CSP/脚本特征检查（桌面侧已做） | 需渠道包被污染 | 代码确认 |
| P3-1 | P3 | 尾斜杠 307 跳过分组中间件（1MB bodyLimit 不生效） | 无需认证 | **已复现** |
| P3-2 | P3 | 管理面与客户端面登录失败预算仍分桶（F17 注释宣称的"共享预算"未达成） | 无需认证 | **已复现** |
| P3-3 | P3 | `/providers/:id/balance` 的 HTTP client 跟随重定向（其他出站均显式拒绝） | super_admin | 代码确认 |
| P3-4 | P3 | marketplace 用未校验的 `s.Version` 拼磁盘路径（需存量脏数据） | super_admin | 代码确认 |
| P3-5 | P3 | 下载 URL 由请求 `Host`/`X-Forwarded-Proto` 决定（`no-store` 已缓解缓存投毒） | 无需认证 | 代码确认 |
| P3-6 | P3 | 归档单请求最多 4 次全量解压（CPU 放大，需登录） | 员工 | 代码确认 |

---

## 1.1 与上一轮（2026-09-08）审计的关系

- 2026-09-08 报告的 5 条 P0 中，**服务端相关的 3 条**（OIDC 回调占全局桶、登录限流成功也计数、`r.Use` 挂载在路由之后）本轮复核**已修复**；`oidc.go` 的 P0-2 修复引入了新的桶键问题（见 P1-3），属"修一半"。
- 2026-09-06 / 09-08 两轮报告的服务端 P1 在 09-09 之后的 PR #17 与 R2–R6 批次中已陆续修复；本轮对其中与本次范围重叠的项**抽查复核**（密钥明文落 settings、限流计数、删除模型后仍可调用、祖先链重复计数、审计链执行者等）**未见复发**。本轮 P1/P2 多为 09-10 之后新增或改动代码（余额/报表/OIDC 热重建/渠道/流式计费）引入。
- 本报告可独立阅读，不依赖旧报告。

---

## 2. P0：流式输入侧计费完全旁路（已复现）

**位置**：`server/internal/llmgateway/handler.go:236-260`、`server/internal/llmgateway/balance_settlement.go:245-266`、`handler.go:648`；回归测试把该行为锁成预期：`handler_test.go:208-215`

```go
// handler.go:245-253 —— 客户端显式 include_usage=false 时"尊重"客户端
if opts, ok := body["stream_options"]; ok {
    if m, isMap := opts.(map[string]any); isMap {
        if v, has := m["include_usage"]; has {
            if b, isBool := v.(bool); isBool && !b {
                return raw, nil          // ← 不再注入 include_usage=true
            }
        }
        ...
```

```go
// balance_settlement.go:245-266 —— 兜底只估算 completion,注释明说"输入 token 无法由响应字节推知"
func estimateCompletionFallback(promptTokens, completionTokens, deliveredBytes int64) (int64, bool) {
    if completionTokens > 0 { return completionTokens, false }
    ...
```

**攻击**：任意员工发一个流式请求，带
`{"model":"…","stream":true,"stream_options":{"include_usage":false},"messages":[…超长上下文…]}`
→ 上游（OpenAI 兼容语义）不再下发 usage 块 → 服务端 `reportedPT=0` → 收尾只按**已交付字节**估算 completion（上限 65536）→ **prompt_tokens 恒为 0**，输入侧免费。可无限重复；长上下文场景输入费用是账单大头。

**探针实证**（`temp/audit-20260913/llmgateway_probe_test.go`，真实 PG + 真实路由树，假上游"只在被要求时才回 usage"）：

```
默认请求:       usage 行 prompt_tokens=1234 completion_tokens=5   cost=0.012390
include_usage=false: usage 行 prompt_tokens=0    completion_tokens=15  cost=0.000150 (estimated=true)
【结论】同一 prompt,关闭 include_usage 后输入记 0 → 输入侧免费
```

**修复建议**（任一即可，建议 1+2 同时）：
1. 服务端**无条件**覆盖为 `stream_options.include_usage=true`（客户端无权关闭计量；现有测试 `TestApplyStreamUsageRequest` 的第三条断言必须反向重写）；
2. 流式结算补 prompt 侧兜底：按请求体字节估算（`estimateTokensFromBytes(len(raw))`，与 embedding 同口径），或让上游 usage 缺失时整条流按 `estimated` 标记并计入 prompt 估算；
3. 补反向回归：客户端传 `include_usage:false` 时，落账的 `prompt_tokens` 必须 > 0 且 `estimated=true`。

---

## 3. P1 详细

### 3.1 MFA 第二步可无限爆破（已复现三条独立证据）

**位置**：`internal/serverauth/admin.go:274-308`（`handleLoginMFA` 全函数零限流）、`admin.go:243-257`（密码正确即 `lim.reset` 并签发新票据）、`internal/serverauth/mfa.go:94-107/137-153`、`internal/router/router.go:229`（该路由无任何限流中间件）

| 证据 | 探针结果 | 含义 |
|---|---|---|
| 无限重签票据 | 3 轮"密码登录 → 新票据 → 5 次错误码"共 15 次有效猜测，**0 次 429** | 设计上限 5/票被"新票"绕过，实际无上限 |
| 并发绕过 attempts 门 | 同一票据 **40 并发 → 10 个请求通过 attempts 门**（设计上限 5） | `SELECT attempts` → 判断 → `UPDATE attempts+1` 非原子（stale read） |
| TOTP 重放 | 同一动态码用于两个票据，**两次都 200** | 无"已用步长"记录 |

**攻击**：只需管理员密码（MFA 的唯一威胁模型）→ 循环「POST /login（成功，清空预算，发新票）→ 并发猜码」。6 位 TOTP ±1 步 ≈ 3/10⁶，平均 33 万次猜测；按每分钟数百并发猜测计，**分钟级即可命中**，命中后直接建管理员会话。
**修复**：① per-user TOTP 失败限流（失败 5 次/5 分钟 → 锁定/延迟）；② 票据消费原子化（`UPDATE … SET used_at=now() WHERE id=? AND attempts<5 … RETURNING`，一条语句完成"检查+占用"）；③ 记录并拒绝已使用的 time-step，杜绝重放；④ `/login/mfa` 纳入登录限流桶（含 IP 维度）。

### 3.2 未认证者可无限触发 argon2id(64MB) → OOM DoS（已复现）

**位置**：`internal/serverstore/users.go:86-112`（未知用户也跑 dummy 校验）、`internal/serverauth/ratelimit.go:104-156/177-183`（桶键含 username，无全局/IP 聚合桶，`maxEntries=10000` 只约束 map 键数）

```go
// users.go:99-102 —— 未知用户走等价成本的 dummy 校验(防时序枚举)
if err != nil {
    util.VerifyPassword(dummyPasswordHash, password)
    return User{}, ErrNotFound
}
// util/password.go:14 —— argonMemory = 64 * 1024 (KiB) = 64 MiB / 次
```

**探针**（`serverauth_probe_test.go`，阈值设为 3）：

```
[随机用户名] 30 次未认证登录: 状态码分布=map[401:30] 总耗时=2.61s 单次≈87ms
[同名账号]   6 次错误密码:    状态码分布=map[401:3 429:3]   ← 账号桶正常工作
```

即：**换一个随机用户名即可完全绕过限流**。每次请求 = 64MB 内存 + ~87ms CPU + 一条审计行（含哈希链 advisory lock）。数百并发即数十 GB 峰值 → OOM kill / 全站不可用（该服务端既有压测记录：2000 并发流式曾致 healthz 无响应）。
**修复**：① 增加 IP 维度与全局维度的并发/令牌桶（账号桶保留）；② 未知用户名不跑完整 argon2id，改固定低延迟 + 有界缓存负结果（用户名不存在的结果可缓存 30s）；③ 对 `/auth/login` 全局信号量限制同时在跑的密码校验数（如 `min(4×CPU, 64)`）。

### 3.3 OIDC 回调限流桶键坍缩 → 未认证者锁死全组织 SSO

**位置**：`internal/serverauth/ratelimit.go:193-199`（`clientIPKey` 用 `c.Request.RemoteAddr`）、`internal/serverauth/oidc.go:270-291`（未知 state 也计数）、`cmd/server/main.go:133-143`（`SetTrustedProxies` 只影响 `c.ClientIP()`，对限流键无效）

**攻击**（无需认证，前置：已启用 OIDC）：`GET /api/client/v2/auth/oidc/login` 一次拿到自带 cookie 的 state → 用该 cookie + state 重放 `GET …/callback?code=x&state=…` 61 次（第 2 次起走 `errOIDCState` 分支，**零网络 I/O**，只写一条失败计数）→ 60/5min 的桶被填满 → **所有用户**的回调在 Caddy 容器 IP 这个键上被 429。SSO-only 部署 = 全员无法登录，每 5 分钟重放一轮即可长期维持。
**修复**：① 用 `c.ClientIP()`（可信代理下为真实 IP）替代 `RemoteAddr`；② 未知/失效 state 不应等权计入（真正的"交换失败"才计数）；③ 对该桶加按 state/会话维度与全局上限。

**探针实证**（`temp/audit-20260913/serverauth_oidc_probe_test.go`，注册假 browser provider，逐个换 `X-Forwarded-For` 模拟同一 Caddy 后面的不同真人）：

```
桶键: XFF=203.0.113.7 → "ip:172.28.0.2"; XFF=198.51.100.9 → "ip:172.28.0.2"; 无 XFF → "ip:172.28.0.2"
61 个回调(第 61 个来自不同 X-Forwarded-For 的无辜用户): 状态码分布=map[401:60 429:1], 无辜用户=429
【结论】未认证攻击者用同一来源 IP 的 60 次失败回调即可让全组织 SSO 回调 429
```

### 3.4 OIDC 运行期出站无 netguard，issuer 保存零校验

**位置**：`internal/serverauth/admin.go:1296/1299`（issuer 只 `TrimSpace`）、`internal/serverauth/oidc.go:80`（`oidc.NewProvider(ctx, issuer)` 走 go-oidc 默认 `http.DefaultClient`；全仓**无** `oidc.ClientContext` 注入）；对照：`admin.go:1726-1752` 的"测试连接"端点有 `issuerURLRe` + `SafeOutboundTransport`。

**攻击**：super_admin 在认证配置里保存 `issuer=http://169.254.169.254`（保存路径无 scheme/host 校验）→ `ReloadAuth` 立即触发 `GET <issuer>/.well-known/openid-configuration`（默认 client：**无 IP 复检、默认跟随 302、无响应体上限**）。若内网目标返回合法 discovery 文档，则任何**未认证**访客可用 login/callback 持续触发 token/jwks 请求，形成可重复的盲 SSRF（amplifier）。
**修复**：保存时过 `issuerURLRe` **且** `util.CheckOutboundTarget`；运行期 `oidc.ClientContext(ctx, &http.Client{Transport: util.SafeOutboundTransport(), CheckRedirect: 拒绝})`；把"测试连接"与"保存"的校验收敛到同一函数（单一真源）。

### 3.5 Anthropic `/messages` 路径客户端断开 → 输入侧 0 计费

**位置**：`internal/llmgateway/messages.go:390`（`http.NewRequestWithContext(c.Request.Context(), …)`）对照 `handler.go:320-326`（chat 流式已用 `context.WithoutCancel`）

**攻击**：员工在 `/v1/messages` 上早断连（或在最后一个 content chunk 后、usage 的 `message_delta` 之前断开）→ 客户端 context 取消 → 上游请求被取消 → 永远拿不到 usage → 收尾只按已转发字节估 completion，**prompt 记 0**。与 P0-1 同源（输入侧无兜底），此处多了"主动断连"这一触发器。
**修复**：与 chat 路径同源处理（流式一律 `context.WithoutCancel` + drain 上限），并加测试断言"客户端断开后上游仍拿到 usage"。

### 3.6 同名模型多 provider 时计价不确定（可命中 0 价）

**位置**：`internal/serverstore/gateway.go:466-489`（`SELECT … FROM models WHERE name = ?` + `QueryRow`，**无 ORDER BY**）、`:491-509`（缓存价同理）；`internal/serverstore/migrations-pg/0011_model_unique.sql`（全局唯一约束被改为 `UNIQUE (provider_id, name)`，**同名多行合法**，同名 failover 是既有设计）

**影响**：同名模型（如官方 + 自建镜像都叫 `deepseek-chat`）会按物理首行取价；`SyncProviderModel` 的 `ON CONFLICT DO UPDATE` 会重写元组位置 → **同一模型在不同时刻按不同 provider 的价格计费**，其中一行未定价即 `0 元` 全免。`ModelPrices`/`ModelCachePrice` 是全仓唯一取价入口（`grep` 确认），即整条计费链。
**修复**：把**实际命中的 provider_id**（failover 决定的那一个）带入计价；或建立"模型名 → 权威计价 provider"的唯一映射并在管理端显式呈现；至少在 `WHERE name=?` 后加确定性 `ORDER BY provider_id` 并禁止同名多行各自定价。

**探针实证**（`temp/audit-20260913/serverstore_probe_test.go`，真实 PG：两个 provider 各挂同名 `dup`，单价 1 vs 100）：

```
物理行序:            [(0,1) provider=1 in=1] [(0,2) provider=2 in=100]
ModelPrices(dup) 第 1 次 → 输入 1.00 输出 2.00
UPDATE(仅改名,模拟每小时同步的 ON CONFLICT DO UPDATE)后物理行序: [(0,2) provider=2 in=100] [(0,3) provider=1 in=1]
ModelPrices(dup) 第 2 次 → 输入 100.00 输出 200.00
【结论】无任何计费配置变更,仅一次 UPDATE 就让计价从 1.00 变成 100.00(相差 100 倍)
未定价同名行场景: ModelPrices(dup3) → 0.00 / 0.00(该模型全免)
```

---

## 4. P2 详细

### 4.1 agent-presets 员工面不检查 `apps.enabled`：下架不生效
`internal/agentshare/routes.go:767-775`（`serveArchive` 只查 `Status==approved` 与授权）、`internal/serverstore/agent_presets.go:206-222`（`ListVisibleAgentPresets` 不过滤 enabled/channel）；对照市场技能 `internal/marketplace/skill_api.go:131-136`（`s.Enabled != 1` → 404 "技能已下架"，C-10）与 `internal/capabilities/capabilities.go:388-392`。
`DELETE /api/server/admin/agents/:name` 只把 `apps.enabled=0`（`marketplace/agent_api.go:239-248`），**不撤销授权**。→ 已授权员工/作者仍可 `GET /api/client/v2/agent-presets[/<name>/archive]` 列出并下载已下架内容（UI 隐藏，改造客户端即可绕过）。
**修复**：员工面查询 join `apps.enabled=1`（并显式声明渠道语义）。

### 4.2 管理会话 token 明文入库
`internal/serverauth/admin_session.go:34-53`（cookie 原值 `randomHex(24)` 直接作为 `admin_sessions.id` 落库），对照 `internal/serverstore/tokens.go:12-25`（`api_tokens` 只存 SHA-256）。
任何 DB 读面（备份/`pg_dump`/只读副本/注入）→ 12h 内可直接冒充管理员（cookie 就是会话凭证）。**修复**：存哈希（`sha256(id)`），按哈希查会话。

### 4.3 TOTP 无重放保护（已复现）
`internal/serverauth/mfa.go:56-62`（`totp.Validate` 默认 ±1 步 = 同时 3 个码有效，无已用步长记录）。探针：同一动态码连续用于两个票据，**两次都 200**。**修复**：按 `(user_id, time_step)` 记录已用码（或把 step 绑定进票据消费）。

### 4.4 OIDC flow 表可被匿名刷满并驱逐在途流程
`internal/serverauth/oidc.go:42-45/100-122`：`/auth/{oidc,openid}/login` 无限流；表满 1000 时**驱逐最旧**。1000 次匿名 GET 即可让正在登录的真人回调收到"state 无效或已过期"。**修复**：给 login 端点加 IP 限流，或"满"时拒绝新流程（fail-closed）而不是驱逐在途流程。

### 4.5 渠道同步把 provider key 发往渠道硬编码 URL
`internal/llmgateway/sync.go:35-70`（`ch.FetchModels(...)` 用渠道自带 BaseURL）、`internal/llmgateway/channels/deepseek.go:22-27`（`https://api.deepseek.com`）、`internal/llmgateway/admin.go:242-254`（允许 `channel=deepseek` + 自定义 `base_url`）。
`SyncOnce` 由 `SyncLoop` **每小时**跑一次（`main.go:217`），覆盖所有 `enabled` 且带 key 的 provider → 自建代理的 key 被自动发送到厂商端点。
**修复**：同步走 `p.BaseURL`（与推理一致），或在保存时禁止"渠道 + 自定义 base_url"组合（或明确告警并要求确认）。

### 4.6 官方 App 的 owner 被包内 `author:` 回写
`internal/marketplace/agent_api.go:178-183`（`UpsertApp{... Owner: man.Author}`）+ `internal/serverstore/apps.go:129-137`（`owner = COALESCE(NULLIF(apps.owner,''), excluded.owner)` 把官方刻意保留的空 owner 当"未设置"）+ `internal/appstore/publish.go:196-206`（官方 `owner=""` 是有意设计）。
→ 管理员上传一份 `author: <某员工>` 的 preset 包，该员工即成为**官方**内容的归属人（"我的"分区、可见 pending/rejected 行、后续归属保护以他为基准）。official 锁与蓝标不受影响。
**修复**：该处不回写 owner（或仅当 `app.Official==0 && app.Owner==""`）。

### 4.7 LDAP 探测/运行期无出站复检，且允许明文 `ldap://` 传 bind 密码
`internal/serverauth/admin.go:1681-1715`（`ProbeDirectory` 直连，对照同文件 `:1749-1752` 的 OIDC 分支已装 `SafeOutboundTransport`）、`internal/serverauth/ldap.go:78-89`（dial 无 IP 检查）。需 super_admin，可探测 link-local/metadata + DNS rebinding；`ldap://` 明文传目录密码。**修复**：LDAP 连接同样装连接期 IP 复检，并对 `ldaps://` 之外的 scheme 给出显式风险提示/拒绝。

### 4.8 >1h 长流 pending 行被清理 → 回填必失败（零计费）
`internal/llmgateway/sync.go:143-147`（每小时 `CleanupPendingUsage(now-1h)`）+ `internal/serverstore/usage.go:366-375`（删 `prompt=0 AND completion=0 AND created_at<cutoff` 的流式 kind 行）。停留 >1h 的流式请求 pending 行被删后，后续 `UpdateUsageTokens…` 只能失败（handler 只补一条 SSE error 事件），**已转发的全部内容零计费**。**修复**：给 pending 行加"活跃心跳"或把清理阈值提到远超流上限（如 6h），并让回填失败可重建行。

### 4.9 外部身份之间无绑定（IdP 自选用户名 → 接管同名 external 账号）
`internal/serverauth/handler.go:437-483`（仅按 `username` 查行；唯一守卫是"external 不得接管 local"，`external↔external` 直接复用整行）、`internal/serverstore/users.go:215-217`（大小写不敏感）、`internal/serverauth/oidc.go:176-187`（`preferred_username → email → sub`，不校验 `email_verified`）、`handler.go:477-481`（每次登录 `SyncUserGroups` 全量替换 → OIDC 不下发 groups 时会**清空** LDAP 同步来的组）。
前提：同时启用 LDAP+OIDC，或 IdP 允许用户自选 `preferred_username`/`email`。影响：接管他人本地行的余额/授权/归属/用量历史。**修复**：外部身份绑定到 `(source, sub/唯一 IdP 标识)` 而非用户名；用户名冲突一律拒绝并要求管理员显式迁移；groups 同步按来源分别记录、避免跨源互相清空。

### 4.10 上游 4xx 错误体原样透传（另：3xx 边界判定偏远）
`internal/llmgateway/handler.go:479-497`（4xx body ≤1MB 透传，仅对 key 做脱敏）、`:444`（`if resp.StatusCode < 400` 即落账）。上游/中转的内部错误信息（内网主机名、栈、配额提示）会到达员工；`<400` 的判定对 3xx（如无 `Location` 的 3xx / 304）会落一行 0 token usage——注意网关 client 未设 `CheckRedirect`，正常重定向会被 Go 默认跟随，故 3xx 分支实践影响很小，仅属边界不严。
**修复**：4xx 只透传白名单字段（`error.message`/`error.type`）或统一信封；判定收紧为 `>=200 && <300`。

### 4.11 网关无并发准入
`internal/llmgateway/meter.go` 只有 begin/snapshot（`concurrency.go` 的 Target 仅管理端展示）、`internal/llmgateway/embedding.go:71/219` 每请求新建 `http.Client`（连接池不复用）+ 每请求 16MB `ReadAll`。结合仓库既有实测（单实例 ~1500 并发上限），**单个员工脚本即可拖垮全站**。**修复**：按用户/全局的 in-flight 信号量（超限 429/排队）＋ embedding 复用带连接池的 client。

### 4.12 渠道 SVG 素材下发无 `nosniff`/CSP/脚本特征检查
`internal/channel/handlers.go:42-54`（`serveAsset` 只设 `Cache-Control` 后 `http.ServeFile`），路由 `internal/router/router.go:152-161`。对照桌面侧 `packages/host/desktop/src/brand-web-route.ts:107-114` 的 `sanitizeBrandSvg` + `X-Content-Type-Options: nosniff` + `default-src 'none'`。
渠道包若被污染（供应链/私有仓），含脚本的 SVG 直接导航即在**服务端源**上执行脚本（与 `/admin/` 同源）。**修复**：与服务端已有口径一致——下发前做脚本特征检查、加 `nosniff` 与 `Content-Security-Policy: default-src 'none'`。

---

## 5. P3（加固项）

1. **尾斜杠 307 跳过分组中间件**（已复现：`POST /api/client/v2/x/` → 307、分组中间件未执行）→ `router.go:72-73` 的 1MB `bodyLimitMiddleware` 在该路径不生效。实际影响有限（gin 不读 body；Go 仅 drain ≤256KB 后关连接），但建议 `r.RedirectTrailingSlash = false` 或把限体放到 NoRoute 之前的引擎级中间件。
2. **登录失败预算两入口仍分桶**（已复现：客户端面 3 次失败后第 4 次 429，管理面紧接着仍可继续尝试）→ `admin.go:243-244` 用裸 `ip|user`、`u:user`，客户端面用 `dbLimiterScope(db)+…` 前缀，`ratelimit.go:48-53` 注释宣称的"共享同一失败预算"未达成（同一账号每 5 分钟仍可双入口各 10 次）。建议统一键命名空间（这是**门禁/注释与实现不符**，非新漏洞）。
3. **余额查询 client 跟随重定向**：`internal/llmgateway/balance.go:30` 未设 `CheckRedirect`（对照 `internal/reports/reports.go:47-49` 明确拒绝）。恶意/被劫持的"deepseek 系"上游可让服务端对内网发盲 GET（跨主机重定向会剥 Authorization）。建议统一拒绝重定向。
4. **marketplace 用未校验的 `s.Version` 拼磁盘路径**：`internal/marketplace/admin.go:449-458`（`filepath.Join(cacheDir, s.Name+"-"+s.Version+ext)`）。仅存量 legacy 行（`archive IS NULL` 且 version 含 `..`）可达，且仅 super_admin、只能命中 `*.zip/*.tar.gz`。建议对 version 过 `SafePathSegment` 并断言 `Clean` 结果在 cacheDir 前缀内。
5. **下载 URL 由请求 `Host`/`X-Forwarded-Proto` 决定**：`internal/clientrelease/clientrelease.go:196-239`。`no-store` 已挡住缓存投毒，但建议 `PICOAI_PUBLIC_BASE_URL` 之外不接受 Host 作为权威来源（或用可信代理白名单）。
6. **归档单请求最多 4 次全量解压/扫描**（`archiveutil` Validate → ListContents → ExtractFileContent → normalize，16MB 原始 / 64MB 解包 / 10000 条目），需登录 + pendingCap=10，未见武器化价值；建议加压缩比与总遍数闸。
7. **`server/go.mod` 残留未使用的 `github.com/go-git/go-git/v5` 依赖树**：全仓 `grep` 0 处 import（git 源模式已随 0052 移除），但 `require` 与 `go.sum` 仍带着 go-git 及其 12+ 个间接依赖（`ProtonMail/go-crypto`、`cloudflare/circl`、`skeema/knownhosts`、`xanzy/ssh-agent` 等）；本轮 `go build`（`-mod=mod`）会自动把它们剪掉，说明确为死依赖。属供应链面收敛（少一份需要跟踪 CVE 的依赖），建议跑一次 `go mod tidy` 并入下一个常规提交。

---

## 6. 已复核确认到位的防护（避免重复投入）

- **注入面**：CodeQL `go-security-extended`（SQL 注入/路径穿越/ZipSlip/命令注入/XSS/日志注入/弱随机/弱加密/SSRF 等 35 条）**0 结果**；`go vet` 干净；全仓无 `os/exec`、无 `InsecureSkipVerify`、无 `math/rand`；SQL 全参数化（唯一的动态片段 `GROUP BY`/表名均来自白名单常量或时间格式化）；`?`→`$N` 重写层不引入注入面。
- **认证**：api_tokens 32B CSPRNG + 只存 SHA-256 + 90 天 + 每次校验 revoked/status；改密/降权/禁用/重置 MFA 同事务吊销全部会话与 token；员工与管理面强制改密守卫（白名单逐一核对无绕过）；外部身份不得接管本地账号（`provisionUser` 显式拒绝）；管理员登录 local-only。
- **会话/CSRF**：cookie HttpOnly + SameSite=Lax + Secure 三态、无 Domain、12h 硬 TTL + 60min 滑动、无会话固定；CSRF = 每会话随机 key 的 HMAC（`hmac.Equal`，会话绑定 + 时间窗双通道），除 GET/HEAD 外全部强制；全仓无 CORS 中间件。
- **密码/MFA 存储**：argon2id（64MB/t=3/p=2）+ 常量时间比较 + dummy 时序对齐（副作用见 P1-2）；TOTP secret 仅 AES-GCM 密文；MFA 票据一次消费且"先消费后建会话"；重置他人 MFA 禁对自己 + 全量吊销；`--reset-mfa` 需宿主权限。
- **RBAC/路由**：生产树 **125 条**管理路由**全部**经 `AdminRoute` 申报（探针实测"未申报=0"），且 `cmd/server/main_test.go:74-101` 对**生产树**逐条断言（我本轮核对了该断言的存在与遍历对象，2026-09 的 fall-open 防护是**有牙齿**的）；员工面/网关面全部经 `BearerAuth`；`role` 不可由请求伪造；auditor 只有 3 个只读权限点。
- **密钥管理**：上游 key / LDAP bind 密码 / OIDC client_secret 全 AES-GCM（`enc:v1:`）且读接口一律 `***`；日志与响应体/头/SSE 行统一 `redactSecrets`；访问日志丢弃 query（OIDC code/state 不入日志）。
- **出站护栏**：网关转发（chat/completions/responses/embedding）、渠道同步、余额查询、认证测试、报表 webhook 均装 `SafeOutboundTransport`（含代理感知复检，堵住 HTTP(S)_PROXY 绕过）——**唯二例外**是 OIDC 运行期（P1-4）与 LDAP（P2-7）。
- **归档/路径**：服务端**不落盘解压**（zip-slip/tar-slip/符号链接/TOCTOU 这一整类结构上不存在）；条目名归一化 + 拒绝绝对路径/`\`/盘符/`..`；`name/version` 走 `SafePathSegment`+正则；下载面"未授权/未过审 → 同 404"（不泄露存在性）；上传元数据一律以包内为准并过长度/字符/深度三层闸。
- **审计**：哈希链 + PG advisory lock 串行写入 + SAVEPOINT 逐条隔离 + 有界重试 + 失败计数可见 + 启动校验 + 读侧按查看者脱敏凭据型 URL。
- **可用性（本轮之前已修）**：Logger/Recovery 先于路由注册、404/405/panic 统一 JSON、`MaxHeaderBytes=16KB`、慢流/大行/空闲超时、客户端断开 drain 上限、结算失败 fail-closed（不交付未落账内容）。

---

## 7. 修复优先序（建议）

| 顺序 | 项 | 理由 |
|---|---|---|
| 1 | **P0-1 流式输入侧计费** | 任意员工一行参数即可白嫖，直接资金损失；修复面小（3 处 + 1 个反向测试） |
| 2 | **P1-2 argon2 DoS** | 无需认证、可致全站不可用；加一个 IP/全局桶 + 未知用户负缓存即可 |
| 3 | **P1-1 MFA 爆破** | 唯一保护超管的第二因子在"已知密码"场景失效；改票据消费为原子 + 加限流 |
| 4 | **P1-3 OIDC 回调桶键** | 无需认证锁死全员 SSO，一行改动（`c.ClientIP()`）+ 失败分类 |
| 5 | **P1-4 OIDC 出站护栏 / P1-5 messages 断连计费 / P1-6 计价键** | 三条都是"已有正确实现、漏了一处"的同族缺口 |
| 6 | P2-1/4.5/4.8/4.10/4.11 | 控制面语义与计量稳健性 |
| 7 | P2-2/4.3/4.4/4.6/4.7/4.9/4.12 与全部 P3 | 纵深与一致性 |

**系统性建议**（本轮多条根因）：把"同一不变式只允许一份实现"扩展到**安全常量与判定**——出站护栏（OIDC/LDAP 漏装）、取价键（同名多行）、enabled/channel 可见性（skill 查、agent 不查）、预览上限（1MB vs 128KB）、限流键命名空间（两套前缀）都是"多份拷贝漂移"。建议为每条不变式配一个**锁定测试**（本仓已有 `archiveutil/limits_single_source_test.go` 这类机制可套用）。

---

## 8. 附：探针与复现

审计后已从 `server/` 树移除探针文件，`git status` 干净；源码副本与运行记录保存在 `temp/audit-20260913/`：

| 文件 | 验证内容 | 运行方式 |
|---|---|---|
| `serverauth_probe_test.go` | MFA 无限票据/并发绕过/重放、argon2 随机用户名放大、登录限流分桶 | `PG_DSN_TEST=… go test ./internal/serverauth/ -run TestAuditProbe -v` |
| `serverauth_oidc_probe_test.go` | OIDC 回调桶键坍缩（XFF 被忽略）→ 61 请求锁死全组织 SSO | 同上（`-run TestAuditProbeOIDCCallbackBucketCollapse`） |
| `llmgateway_probe_test.go` | 流式 `include_usage=false` → prompt_tokens=0 | `PG_DSN_TEST=… go test ./internal/llmgateway/ -run TestAuditProbe -v` |
| `router_probe_test.go` | 生产/镜像管理路由数量、生产树权限申报=0、尾斜杠 307 跳过中间件 | `go test ./internal/router/ -run TestAuditProbe -v` |
| `serverstore_probe_test.go` | 同名模型计价随物理行序翻转（1.00 → 100.00，一次 UPDATE）／未定价同名行 → 0 元 | `PG_DSN_TEST=… go test ./internal/serverstore/ -run TestAuditProbe -v` |

工具链环境（本机）：`PATH=$PATH:/usr/local/go/bin`、`GOMODCACHE=$PWD/temp/gomodcache`、`GOPATH=$PWD/temp/gopath`、`GOCACHE=$PWD/temp/gocache-go`、`GOFLAGS=-mod=mod`、`PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test?sslmode=disable`（`pg-test` 容器）。
CodeQL：`codeql database create temp/codeql-go-db --language=go --source-root server` → `codeql database analyze temp/codeql-go-db --format=sarif-latest --output=temp/codeql-go-results.sarif codeql/go-queries:codeql-suites/go-security-extended.qls`（扫描 114/244 文件 = 全部非测试文件；35 条查询；结果 0）。
