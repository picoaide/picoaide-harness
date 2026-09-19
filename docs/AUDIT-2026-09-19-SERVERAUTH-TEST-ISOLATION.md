# 审计：`internal/serverauth` 跨用例状态污染（登录失败预算被前一个用例打满）

> ⚠️ **历史记录 · 对象已删除（2026-09-20 追记，W4-12）**：本文件引用的下列对象已随「WASM 应用客户端专属」改造的 **W4 删除波次**（2026-09-19/20）**从源码整体删除** —— `internal/wasmapp/session/**`（应用会话 + 主站登录/换票 HTML 面）、`internal/wasmapp/anonlimit/**`、`internal/wasmapp/edge/hostgate.go`（主机名门控）、`internal/wasmapp/aichat/**`、应用子域与应用基域配置面、`entry_url`。
> **阅读口径**：本文件是**当时的审计/决策记录**，凡出现上述对象一律按历史理解，**不得据此实施、也不得当作现行契约**。现行模型见 `docs/planning/2026-09-19-wasm-client-only-design.md`，接口面见 `server/docs/03-api-reference.md` §11b。

**结论速览**：`TestAdminUsageDept` 的失败是**跨用例状态污染**，不是该用例或被它测的接口有缺陷。
包级共享的登录失败预算桶（`sharedLoginLimiter` / `sharedLoginIPLimiter`）在产品里是**有意共享**的
（客户端面与管理面必须共用一份预算），但它的**桶键里那段"每库作用域"是假的**：
`dbLimiterScope()` 用 `fmt.Sprintf("%p", db)` 标识 DB 实例，而每个用例的临时库句柄在用例结束、
被 GC 之后，Go 分配器会把**同一个地址**发给后面的 `sql.Open`（实测 40 次 open/close 有 **39 次**
拿到同一指针）⇒ 不同用例实际上落在**同一个桶**里。`TestAuditFixRandomUsernameStillRateLimitedByIP`
故意记录满 `loginIPMaxAttempts = 60` 次失败（断言第 61 次被拒），用完不做成功登录 ⇒ 桶在该用例结束后
**仍然满着**；5 分钟窗口内任何落到同一键的用例，在鉴权之前就被 429 —— 连**密码正确**的登录也进不来。

**判定**：①主因是**测试隔离缺陷**（修测试面，产品限流阈值一律不动）；②复核过程中同时确认了一条
**真实的产品缺陷**（审计 2026-09-13 P1-3 修 OIDC 回调桶时**漏掉了登录 IP 桶**：反代下桶键坍缩成
Caddy 的 IP，60 次失败登录即可锁死全组织登录）——按 `server-rs/PORTING-PLAYBOOK.md` §2 已登记
`server-rs/DEVIATIONS.md` **A 类**并同时修 Go 侧。

- 改动文件（5 个，生产代码 2 个 + 测试 3 个）：
  - `server/internal/serverauth/ratelimit.go`（登录 IP 桶键统一构造点 + `loginFailed/loginSucceeded` 同步）
  - `server/internal/serverauth/admin.go`（管理面登录 + MFA 第二步的 IP 维度改按真实客户端 IP）
  - `server/internal/serverauth/ratelimit_isolation_test.go`（**新增**：测试专用重置钩子 + 两条回归用例）
  - `server/internal/serverauth/handler_test.go`（`newTestAPI`：每用例重置 + 可信代理与生产同口径）
  - `server/internal/serverauth/admin_test.go`（`mustDB` / `adminRouter`：同上）
- 改动规模（`git diff --numstat`）：`admin.go` +7/−2、`admin_test.go` +9、`handler_test.go` +8、
  `ratelimit.go` +42/−12、新增 `ratelimit_isolation_test.go` 197 行；**未提交**（主控统一提交）。
- 台账：`server-rs/DEVIATIONS.md` 追加 A 类一条（Rust 侧随 `serverauth` crate 移植时落地同一修复）。

---

## 1. 现象与复现

```bash
cd server && GOCACHE=/data/picoaide-harness/temp/go-build GOMODCACHE=/data/picoaide-harness/temp/gomodcache \
  GOPATH=/data/picoaide-harness/temp/gopath \
  PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test \
  go test ./internal/serverauth -count=1
```

```
--- FAIL: TestAdminUsageDept (0.87s)
    usage_admin_test.go:33: login: 429 {"error":{"code":"RATE_LIMITED","message":"登录尝试过于频繁,请稍后再试"}}
FAIL	github.com/picoaide/picoaide/internal/serverauth	295.038s
```

`usage_admin_test.go:33` 是 `adminSession()` 里**第一次、且密码完全正确**的管理面登录
（`{"username":"boss","password":"pw123456"}`）。单跑该用例必绿：

```bash
go test ./internal/serverauth -count=1 -run TestAdminUsageDept   # PASS
```

⇒ 典型的"整包红、单跑绿"，且**只在特定时序下红**（见 §3）。

## 2. 根因机制（带 `文件:行号`）

### 2.1 谁把桶打满的

给 limiter 加临时日志（`PICOAI_RL_DEBUG=1`，已随本次改动移除）跑整包，日志把**归属**钉死：

```
=== RUN   TestAuditFixRandomUsernameStillRateLimitedByIP            (audit_fix_20260913_test.go:155)
[RL] record key="db:0x5b4c9d9b040|ip:192.0.2.1" n=59 limit=60
[RL] record key="db:0x5b4c9d9b040|ip:192.0.2.1" n=60 limit=60
[RL] REFUSE key="db:0x5b4c9d9b040|ip:192.0.2.1" n=60 limit=60
    audit_fix_20260913_test.go:166: 第 61 个随机用户名请求被 IP 桶拦下
```

- 打满者：`audit_fix_20260913_test.go:155-173` `TestAuditFixRandomUsernameStillRateLimitedByIP`
  —— 用 60 个**随机用户名**错误密码把 IP 桶记满（这正是审计 2026-09-13 P1-2 想钉住的行为：
  "随机用户名也绕不过 IP 桶"），第 61 次被拒是它**自己的断言**。
- 它不做成功登录 ⇒ **没有**任何 `reset` 清掉这个键。
- 累计失败总数 >= 60 的键在整个 run 里只有这一个（其余最高 10，都来自各自用例的
  `limit=10` 账号桶）；而那个 `REFUSE` 之后，桶里仍留着 60 条 5 分钟窗口内的记录。

### 2.2 为什么"下一个用例"会落到同一个桶

桶键的构造（`ratelimit.go`）：

| 位置 | 内容 |
|---|---|
| `ratelimit.go:224-226` | `dbLimiterScope(db) = fmt.Sprintf("db:%p\|", db)` |
| `ratelimit.go:60` | `loginIPMaxAttempts = 60`（IP 桶阈值，**不读 env**，与账号桶的 `maxAttemptsFn` 不同） |
| `ratelimit.go:269-279` | `loginAllowed()` 判定 `scope+loginKey` / `scope+"u:"+user` / `scope+"ip:"+host` |
| `ratelimit.go:315-330` | `loginFailed()` / `loginSucceeded()` 记账/清账（三桶） |
| `admin.go:346,401` | 管理面 `srcIPKey` / MFA `mfaIPKey` |

`dbLimiterScope` 的注释写明它存在的理由是"测试的每个临时库互不污染"，但 `%p` **做不到**这点。
探针（`temp-probe`，40 次 `sql.Open` + `Close` + `runtime.GC()`）：

```
iter= 0 ptr=0x2492e13c49c0 total_seen=1
iter= 1 ptr=0x2492e13c45b0 total_seen=1
iter= 2 ptr=0x2492e13c45b0 total_seen=2
distinct pointers over 40 open/close cycles: 2
  reused 0x2492e13c45b0 x39          <-- 39/40 复用同一地址
```

真实 run 里也直接观测到**不同用例共用一个作用域**（同一份 `[RL]` 日志按 `=== RUN` 归属统计）：

```
3 tests share scope db:0x5b4c9ac1ad0:
  TestAdminAuthConfig / TestLoginLogoutMe / TestPasswordChangeGuardBlocksBusiness
2 tests share scope db:0x5b4c9ac12b0:
  TestAdminTokens / TestEmployeeChangePassword
```

⇒ 每个用例 `serverstore.NewTestDB()` 拿到的临时库是**新库**（数据隔离成立），但限流桶键里的
"库身份"是**复用的地址**，限流桶**不隔离**。

### 2.3 为什么"正常登录"会被 429

`TestAdminUsageDept` 第一步就是 `adminSession()`（正确密码）。管理面登录在
`admin.go:344` 先做三桶判定，`PICOAI_LOGIN_MAX_ATTEMPTS=10000` 已被 `adminRouter`
（`admin_test.go:557`）放宽，唯一的 60 上限桶就是 IP 桶 —— 只要它满，**正确密码也到不了
`AuthenticateConfiguredAdmin`**。且成功登录才有机会 `reset` 桶（`admin.go:365`），
而成功登录正是被拒的那一步 ⇒ 窗口内**自我锁死**，只能等 5 分钟滑窗自然过期。

### 2.4 确定性复现（A/B）

把 `dbLimiterScope` 临时改成常量（模拟"地址复用 ⇒ 同键"这一既成事实），跑
`-run 'TestAuditFixRandomUsernameStillRateLimitedByIP|TestAdminUsageDept'`：

```
# A：常量作用域 + 无重置（= 修复前的产品+测试状态）
--- FAIL: TestAdminUsageDept (1.32s)
    usage_admin_test.go:33: login: 429 {"error":{"code":"RATE_LIMITED","message":"登录尝试过于频繁,请稍后再试"}}
FAIL	github.com/picoaide/picoaide/internal/serverauth	35.564s
```

**与现场报错逐字一致**。同一把"复用"改成用例级重置后（= 本次修复）：

```
    audit_fix_20260913_test.go:166: 第 61 个随机用户名请求被 IP 桶拦下
--- PASS: TestAuditFixRandomUsernameStillRateLimitedByIP (21.27s)
--- PASS: TestAdminUsageDept (1.58s)
ok  	github.com/picoaide/picoaide/internal/serverauth	23.401s
```

注意：爆破用例**自己那条 429 断言照旧成立**（限流没有被放宽），只是不再溢出到下一个用例。

### 2.5 限流参数与判定路径（复核表）

| 桶 | 键 | 上限 | 窗口 | 计数（`record`） | 不计数 | 清空（`reset`） |
|---|---|---|---|---|---|---|
| `ip\|username` | `scope + loginHost(c) + "\|" + username`（**RemoteAddr**） | `PICOAI_LOGIN_MAX_ATTEMPTS`（缺省 10，**每次判定实时读 env**，`ratelimit.go:41-46,94-101`） | 5min（`newRateLimiter`，`ratelimit.go:114-121`） | 认证失败（`loginFailed` / 管理面 `lim.record(ipKey)`） | `allow()` 本身**不记账**（2026-09-08 P1-3：成功登录不再占配额） | 认证成功（`loginSucceeded` / `reset(ipKey)`） |
| `u:username` | `scope + "u:" + username` | 同上（10） | 5min | 同上 | 同上 | 同上 |
| **登录 IP 桶** | `loginIPBudgetKey`（本次改为 **ClientIP**；原 `scope+"ip:"+loginHost(c)`） | **`loginIPMaxAttempts = 60`（常量，不读 env）**，`ratelimit.go:60` | 5min | 同上（每个失败请求给 IP 桶 +1） | 同上；`/auth/me`、`/auth/usage` 等已认证接口**不经**此桶 | 同上（**成功登录才清空**——这正是"桶满即无人能登录"的原因） |
| OIDC 回调桶 | `clientIPKey(c)` = `"ip:"+ClientIP()`（**无 db scope**） | 60（`callbackLimiterMaxAttempts`，`ratelimit.go:50`） | 5min | 失败回调（`oidcCallbackFailed`） | 成功回调 | `oidcCallbackSucceeded` |
| OIDC/OpenID 流程桶 | `"oidc-login-ip:"+ClientIP()`（**无 db scope**） | 60（与 IP 桶同一个 limiter 实例） | 5min | **每个** `/auth/{oidc,openid}/login` 请求都 +1（`oidc.go:246-252`：`allow` 后立即 `record`，防流程表/出站 discovery 被放大） | — | 无（该键不随成功清空） |
| MFA 第二步 IP 桶 | `"mfa-ip:"+ClientIP()`（本次由 RemoteAddr 改；**无 db scope**） | `PICOAI_LOGIN_MAX_ATTEMPTS`（10） | 5min | 动态码错误 | 票据无效/用户不可用等前置拒绝**不计数**（`admin.go:408-414` 直接返回） | MFA 成功（`admin.go:437-438`） |
| MFA 第二步账号桶 | `"u:"+username+"\|mfa"` | 同上（10） | 5min | 同上 | 同上 | 同上 |

另外两条与本案相关的判定事实：①密码校验前还有**并发闸** `passwordVerifySlots`（`ratelimit.go:356`，
过载返回 429 但**不计数**）；②`TestAdminUsageDept` 走的是管理面 `handleLogin`，
`adminRouter` 已把 env 阈值放宽到 10000（`admin_test.go:557`）⇒ 能拦住它的只有**恒定 60 的 IP 桶**。

### 2.6 复核过的"不算问题"的三种猜测

| 猜测 | 复核结果 |
|---|---|
| "成功登录也被计数" | **不成立**：2026-09-08 P1-3 起 `allow()` 不记账，只有 `record()`（失败）记账，成功走 `reset`。本次未改这条语义。 |
| "`PICOAI_LOGIN_MAX_ATTEMPTS` 被前一个用例改小" | **不成立**：`loginLimiter.maxAttemptsFn`（`ratelimit.go:41-46,94-101`）每次判定实时读 env，`t.Setenv` 不泄漏；且 IP 桶 **60 是常量**，不受 env 影响。 |
| "IP 桶键带用户名、被换用户名绕过" | **不成立**：打满的键是 `...\|ip:192.0.2.1`（纯 IP），与用户名无关。 |

## 3. 为什么 CI 没抓到（其实 CI 也会红，条件如下）

CI 跑的是 `go test ./... -count=1 -p 1`（`.github/workflows/ci.yml:216`，
`PG_DSN_TEST` 见 `:172`），与本机复现命令同义 ⇒ **同一进程内跑整包，机制完全适用，CI 会红**。
但红需要同时满足两个**时序性**条件：

1. **分配器把"被污染的那个作用域地址"发给后面某个会做登录的用例**。地址是否复用取决于 GC 时机与
   该次 run 的分配序列 —— 本机两次整包 run：现场那次命中（`TestAdminUsageDept`），
   我加日志那次没命中（后继用例拿到别的地址）。
2. **该用例在打满后的 5 分钟滑窗内运行**。整包耗时越接近/超过 5 分钟，越容易被窗口"救活"：
   我那次带日志的 run 被日志拖到 **511.9s** ⇒ 整包**通过**（`PASS / ok 511.912s`）；
   现场那次 **295s** ⇒ 命中。⇒ 机器越快（或越慢到超过窗口）都可能翻面，
   这就是"偶发、重跑即绿/即红"的来源。

一句话：**不是 CI 漏了这条门禁，而是这条门禁本身是非确定性的**；本次修复把它变成确定性通过
（残余 `%p` 复用不再有影响）。

## 4. 修法

### 4.1 测试面（主因，产品限流阈值/键一律不动）

1. **新增测试专用重置钩子**（`ratelimit_isolation_test.go`，只在 `_test.go` 内可见，生产二进制不可达）：

   ```go
   func resetSharedLimitersForTest() {
       for _, l := range []*loginLimiter{sharedLoginLimiter(), sharedLoginIPLimiter()} {
           l.mu.Lock(); l.attempts = map[string][]time.Time{}; l.lastSweep = time.Time{}; l.mu.Unlock()
       }
   }
   ```

   只清**内容**、不替换实例：`New()` 在构造期就把单例指针存进了 `API/AdminAPI`（`handler.go:48-49`），
   替换实例对已构造的对象无效。与包内既有先例同口径（`internal/telemetry` 的
   `resetErrorReportingLimiter`，注释写着同一个病因："限流器是进程级共享(跨用例)…不重置就会与
   前一个用例互相挤占同一预算,用例顺序一变就假红"）。

2. **在所有构造登录入口的测试辅助函数里调用**：`newTestAPI`（`handler_test.go:24`）、
   `mustDB`（`admin_test.go:488`，覆盖 `adminRouter` 与自建路由树的用例）。
   这样"每个用例一份临时库"的既有生命周期扩展为"每个用例一份失败预算"。

3. **不让"更严的默认"掩盖判据**：`newTestAPI` / `adminRouter` 补
   `SetTrustedProxies([]string{"127.0.0.1","::1"})`（与 `cmd/server/main.go:138-145` 同口径：
   缺省只信回环 + 显式配置）。否则 gin 的缺省"信任所有代理"会让
   `TestLoginRateLimitXFFSpoof`（C-1：伪造 XFF 不得重置预算）在改成 `ClientIP()` 之后
   **因账号桶而"假绿"**——断言还在，语义却不再被测。

4. 明确**不做**的事：不动 `loginIPMaxAttempts=60`、不动窗口、不动账号桶阈值、
   不跳过任何限流用例、不弱化任何 429 断言。

### 4.2 产品面（顺带确认的真实缺陷，按 §2 走 DEVIATIONS）

**缺陷**：审计 2026-09-13 P1-3 把 OIDC **回调**桶从 `RemoteAddr` 改成 `ClientIP()`（因为反代下
60 次失败回调会锁死全组织 SSO），但**登录 IP 桶漏了** —— 它仍用 `loginHost()`（= `RemoteAddr`）。
生产 compose 前面是 Caddy（`docker-compose.yml:98` 缺省 `PICOAI_TRUSTED_PROXIES=172.28.0.2`），
所有请求的 `RemoteAddr` 都是代理 IP ⇒ 那个 60 次/5min 的桶变成**全组织共用**：
任意 60 次失败登录就能让**所有人**（含密码正确者）在窗口内登不进来，攻击者用 ~12 次/分钟
即可长期维持。`cmd/server/main.go:135-139` 的注释写着 `SetTrustedProxies` 的目的就是
"登录限流键不再坍缩为单一代理 IP"——这条意图在登录 IP 桶上此前**没有落实**。

**修法**（不新增阈值、不放宽任何判定；XFF 仍只信可信代理，比无条件采信更严）：

| 位置 | 改动 |
|---|---|
| `ratelimit.go:255-259` | 新增**唯一**键构造点 `loginIPBudgetKey(db,c) = dbLimiterScope(db) + "ip:" + c.ClientIP()`；`AllowLoginAttempt/RecordLoginFailure/ResetLoginSuccess` 走同形的 `loginIPBudgetKeyForHost` |
| `ratelimit.go:269-279` | `loginAllowed()` 的 IP 桶判定改用它 |
| `ratelimit.go:315-330` | `loginFailed()` / `loginSucceeded()` 同步 —— **同一处曾漏改**（判定键 ≠ 记账键 ⇒ 桶永远判不满，限流静默失效），正是新回归测试抓出来的；现已把键收敛到单一构造点，物理上杜绝再次分叉 |
| `admin.go:346` | 管理面 `srcIPKey` 改用它（与客户端面共用同一键） |
| `admin.go:401` | MFA 第二步 `mfaIPKey` 改 `c.ClientIP()`（同类坍缩：反代下 10 个错误动态码锁死所有管理员第二步） |

`clientIPKey`（`ratelimit.go:244`）与 `loginKey`（`ratelimit.go:217`）的注释同步写清"哪个桶按
什么 IP 计、为什么"：`ip|username` 桶**保留 RemoteAddr**（它与 `u:username` 是同一份 10 次预算，
坍缩只会更严；真正会造成全组织 DoS 的是纯 IP 的 60 次桶）。

## 5. 验证证据

| 证据 | 结果 |
|---|---|
| 确定性复现（§2.4 A/B） | 常量作用域 + 无重置 → `TestAdminUsageDept` 429（与现场逐字一致）；同作用域 + 重置 → 全绿，且爆破用例自己的 429 仍在 |
| 整包 ×3（连续，修复后） | `ROUND1 exit=0 200.5s` / `ROUND2 exit=0 210.1s` / `ROUND3 exit=0 246.1s`，三次日志里 `^--- FAIL` 计数均为 0（`temp/sa-verify/rounds-summary.txt`、`roundN.log`） |
| **负载下**（8 个 CPU spinner + 整包，实测峰值 load 24.58） | `LOADED exit=0 elapsed=284s` / `ok … 268.724s`，`^--- FAIL` = 0；其中 `TestAuditFixRandomUsernameStillRateLimitedByIP` 43.29s、`TestAdminUsageDept` 2.59s 全绿（`temp/sa-verify/loaded.log`、`loaded-summary.txt`） |
| 单跑关键用例（每条独立进程） | 9/9 `exit=0`、各 1 pass / 0 fail：`TestAdminUsageDept`、`TestLoginRateLimit`、`TestLoginRateLimitXFFSpoof`、`TestAuditFixRandomUsernameStillRateLimitedByIP`、`TestAuditFixLoginBudgetSharedAcrossSurfaces`、`TestAuditFixMFALoginIsRateLimited`、`TestAuditFixOIDCCallbackKeyUsesClientIP`、`TestSharedFailureBudgetIsClearedPerCase`、`TestLoginIPBudgetKeyUsesTrustedProxyClientIP`（`temp/sa-verify/single-summary.txt`、`single-*.log`） |
| `gofmt -l internal/serverauth/` | 空 |
| `go vet ./internal/serverauth/...` | 无输出 |
| 变异验证（回归测试有保护力） | 停用 `resetSharedLimitersForTest()` → `TestSharedFailureBudgetIsClearedPerCase` **红**（"键 … 残留 60 次"）；把 `loginIPBudgetKey` 退回 `RemoteAddr` → `TestLoginIPBudgetKeyUsesTrustedProxyClientIP` **红**（键落在 `ip:192.0.2.1`） |
| 跨包不回归 | `go build ./...` + `go vet ./...` + 会走登录入口的 9 个包（router / cmd/server / marketplace / capabilities / sharedskills / agentshare / connectors / wasmapp/session / telemetry）全绿，见 `temp/sa-verify/cross-package-summary.txt` |

新增回归用例：

- `TestSharedFailureBudgetIsClearedPerCase`（`ratelimit_isolation_test.go`）
  —— 把桶打满 → 断言下一个用例（统一入口）拿到干净预算且正常登录 200。
- `TestLoginIPBudgetKeyUsesTrustedProxyClientIP`（同文件）
  —— ①可信代理转发的 XFF 决定桶键（两个真人两个桶）；②不可信来源伪造 XFF 不改变桶键（C-1）；
  ③一个真人打满预算后另一个真人的正确密码仍 200（反代坍缩 DoS 不复现）。

## 6. 影响面

- **产品行为**：登录/MFA 的**阈值与窗口不变**；变化只在"IP 维度按哪个 IP 计"——
  反代部署（compose 缺省 trusted proxies）下由"代理 IP"变为"真实客户端 IP"，
  即恢复 `cmd/server/main.go` 声明的意图。未配置 `PICOAI_TRUSTED_PROXIES` 时
  `ClientIP()==RemoteAddr`，行为与修复前**完全一致**（fail-closed，无回归）。
- **攻击面**：不变差 —— 伪造 XFF 仍只对可信代理生效；`ip|username`、`u:username` 桶语义未动；
  纯 IP 桶的阈值未动。唯一变化是"一个来源的失败不再连坐其他来源"，这正是审计 P1-2/P1-3 的本意。
- **可观测性**：审计日志里的 `ip=` 一直用 `c.ClientIP()`，本次改动让**限流键**与**审计 IP** 口径一致。
- **测试行为**：用例之间不再共享失败预算；`newTestAPI`/`adminRouter` 现在显式声明可信代理
  （与生产同口径），`TestLoginRateLimitXFFSpoof` 的判据不再依赖 gin 的缺省信任策略。
- **性能**：键构造多一次 `c.ClientIP()`（gin 内部几次字符串解析），仅失败/判定路径，可忽略。

## 7. 同类隐患清单（本次只修 `serverauth`，其余交主控）

扫描口径：`grep` 全仓 `sync.Once` 单例、包级可变 `map/slice/&T{}`、可被测试替换的钩子变量，
逐条判断"是否会被测试共享 + 是否累积状态 + 是否已自清理"。

| # | 位置 | 形态 | 判断 | 备注 |
|---|---|---|---|---|
| 1 | `serverauth/ratelimit.go:67-86` | `sharedLoginLimiter` / `sharedLoginIPLimiter` 包级单例 + `%p` 作用域 | **已修**（本审计） | 阈值/窗口未动，仅测试面隔离 + IP 维度键修正 |
| 2 | `serverauth/ratelimit.go:356` | `passwordVerifySlots`（并发闸 chan） | 低 | 是"闸"不是"累积器"；`TestAuditFixPasswordVerifyGateIsBounded` 会全部释放；若某用例泄漏槽位只会让它变慢/被拒，不会跨用例累积 |
| 3 | `serverauth/rbac.go:139` | `adminRoutes []adminRoutePerm` 只 append | 低 | 每个用例 `RegisterAdminRoutes` 都追加（重复条目、内存增长），判定是集合语义 ⇒ 行为中性；**不并发**所以无竞态 |
| 4 | `serverauth/sysinfo.go:181-182` | `defaultUpdateCheckOnce/Val` | 低 | 缓存 checker 单例；与限流无关，未见用例互相影响 |
| 5 | `serverauth/{mfa.go:60 nowFn, ldap.go:26 ldapTimeout, admin.go:173 ldapProbeDialHook}` | 可替换钩子 | 低（已规范） | 三处赋值都配了 `t.Cleanup`/`defer` 还原（`mfa_test.go:31`、`ldap_test.go:250`、`testconn_test.go:62`） |
| 6 | `telemetry/errorreporting.go:64-65` | `errorReportingLimiter` 单例（按**用户 id** 计）+ `errorReportingPerUserPerMin` **包 init 冻结** env | **中** | 桶已有 `resetErrorReportingLimiter()`（测试面先例）；但阈值是包级 var，`t.Setenv` 对它**无效** —— 与 `loginLimiter.maxAttemptsFn` 注释里点名的同一个坑（"共享单例不能在创建时固化 env"），当前无用例受影响，属**潜在**缺陷，建议同法改为实时读 env |
| 7 | `llmgateway/handlers.go:150` | `gatewayInflight` 包级，按**用户 id** 计并发 | 低-中 | 用户 id 在每用例临时库里都从 1 开始 ⇒ 结构上与本案同族；但中间件 `defer release()`（`handlers.go:191`）且归零删键，泄漏风险低；已有用例显式断言跑完表为空 |
| 8 | `llmgateway/balance_settlement.go:1316,1364` | `promptEstimationClampMonitor` / `promptEstimationMonitor` 包级累积计数器 | 低（已规范） | 有 `reset()` 且相关用例在断言前调用（`audit_r7b/r7c_billing_test.go`）——**正面样例**：包级状态 + 显式 reset API |
| 9 | `llmgateway/upstream.go:44 InvalidateUpstreams` | 包级 upstream 缓存 | 低（已规范） | 同上，测试显式失效 |
| 10 | `llmgateway/channels/channel.go:33` | `registry` 包级 map，`Register` 只写不删 | 低-中 | 用例注册的渠道会泄漏到后续用例；因按名字幂等、且无用例断言"渠道数量"而未爆；若将来加 `Names()` 计数断言会踩 |
| 11 | `llmgateway/handler.go:37,44,55 maxUpstreamBody/streamIdleTimeout/maxStreamLineBytes` 等 | 可替换钩子 | 低（已规范） | `handler_test.go:380`、`failover_test.go:266`、`handler_stream_limit_test.go:59` 都 defer 还原 |
| 12 | `llmgateway/audit_r3_billing_test.go:137` | `DecryptSecret` 钩子**未还原**（同文件后续用例不再需要它） | 低 | 泄漏后的取值与其它用例一致（`return s,nil`），行为中性；但属"未还原的全局钩子"，建议补 `t.Cleanup` |
| 13 | `updatecheck/updatecheck.go:178 ChannelFile`、`clientrelease/clientrelease.go:30 Dir`、`skillseed/skillseed.go:53 Dir`、`appserver.isolationProbeRunner` | 可替换的全局钩子 | 低 | 前两个用例都配 `t.Cleanup`；其余按只读默认值使用 |
| 14 | ⚠️ **对象已删除（W4）**：`wasmapp/anonlimit` 已随客户端专属改造删除（保留列仅作历史）；`llmgateway` 的 `rateLimiter` | 均为**实例化**（`anonlimit.New` / `newRateLimiter`），非包级 | — | 无跨用例共享 |

**给主控的建议（本次不做）**：把"包级单例 + 进程级累积状态"的测试隔离做成一条可检查的纪律 ——
新增此类单例时，必须在同包 `_test.go` 里提供 `resetXxxForTest()` 并在统一测试入口调用
（现有先例：`telemetry.resetErrorReportingLimiter`、`llmgateway.InvalidateUpstreams`、
`promptEstimationClampMonitor.reset`）。第 6 项（telemetry 的 env 冻结阈值）是唯一有真实产品影响的
候选，建议单独排期。

## 8. 复现/验证脚本（可重用）

- `temp/sa-verify/run3.sh`：3 次整包串行（`rounds-summary.txt` + `roundN.log`）。
- `temp/sa-verify/loaded.sh`：8 个 CPU spinner 下整包（`loaded.log`）。
- `temp/sa-verify/single.sh`：关键用例逐条单跑（`single-*.log`）。
- 临时探针 `server/temp-probe/`（`%p` 地址复用实验，**已删**）。
