# 2026-09-11 员工余额(0061)与全仓审计修复

## 背景

1. 产品需要"员工余额"：管理员可手动充值；每月定时向全员发放；发放方式可配置为
   **增加**(当前余额 + 月额度)或**覆盖**(重置为月额度)。
2. 2026-09-11 全仓审计发现 8 条 P1 / 13 条 P2 问题，本次一并修复(F1-F21)。

## 一、员工余额(0061)

### 数据模型

- `users.balance_money DOUBLE PRECISION NOT NULL DEFAULT 0`：存量余额(元)。
- `balance_grants(month TEXT PRIMARY KEY, mode, amount, affected, actor, created_at)`：
  北京月发放幂等锚。`INSERT ... ON CONFLICT DO NOTHING` 抢锁，跨实例/重启/重入
  同一月份只会发放一次；管理员手动发放同样占用锚点，不会与定时任务重复加钱。

### 语义与流水

- **充值**：`POST /api/server/admin/users/:id/balance
  {mode: add|deduct|set, amount, reason}`；调整后不得为负(扣多了 400)；审计
  `balance_adjust`(旧值→新值 + 备注)。
- **消费**：`RecordUsage*` / `UpdateUsageTokens*` 在**同一事务**内按 `usage.cost`
  扣减余额(微元精度 1e-6，不按分抹零)；流式 pending 回填只扣差额，重复回填不重复扣。
- **闸门**：`settings balance.enabled=true` 时余额 ≤ 0 的网关请求返回 429
  `QUOTA_EXCEEDED`(管理员豁免)。默认关闭：存量部署升级后余额全为 0，默认开启会
  在升级瞬间全员被拦。
- **月度发放**：`internal/balance.Scheduler` 每小时检查；`balance.enabled` 且
  月额度 > 0 时，进入新北京月即自动发放一次(停机跨月后启动补发)。发放范围为
  `status=1 AND role='user'` 的启用普通员工(管理员网关豁免、审计员不可用客户端)。
- **员工侧展示**：`GET /api/client/v2/auth/usage` 增加
  `balance_money/balance_enabled/balance_monthly/balance_mode`；账户卡在启用时以
  余额为主数字，余额 ≤ 0 显示红色"余额不足"。

### 管理端页面(webadmin 用户管理)

- 用户列表新增「余额」列；行内「余额」按钮打开调整对话框：增加/扣减/设为三选一、
  金额输入 `inputMode="decimal"`、快捷金额(±10/50/100/500)、实时显示"调整后余额"
  (扣减超限显示负数并禁用提交)、可选备注(写入审计)。
- 页面顶部「月度余额发放」卡片：余额闸门开关、发放方式(增加/覆盖二选一)、
  每人每月额度(数字输入 + 快捷额度)、保存设置、立即发放本月(幂等；本月已发会
  提示且不会重复加钱)、本月/最近发放与员工余额合计展示。

## 二、审计修复清单(F1-F21)

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| F1 | CSRF token 2h 过期 vs 会话 12h，前端无自愈 | token 改为会话绑定 HMAC(`IssueSessionCSRF`)；CSRF 失败返回 `CSRF_EXPIRED`；webadmin 自动刷新 token 并重试一次(单飞) |
| F2 | auth.enabled 热更新失效(启用/禁用 LDAP 都要重启) | `API.ReloadProviders` 热重建；OIDC 路由改为固定 oidc/openid + 请求时动态解析 provider；保存配置后 main 注入的 `ReloadAuth` 立即生效 |
| F3 | 组织树 30s 缓存无主动失效 → 环检测可绕过、热路径死循环 | 新增 `InvalidateGroupTree` 并在部门/组/成员写路径调用；`subtreeGroupIDs`/`userIDToDepts`/`preOrderNodes` 全部加 visited 兜底；补回归测试 |
| F4 | 流式断连删 pending → 上游已产生费用不计费 | 上游请求与客户端断开解耦(`context.WithoutCancel`)；断开后继续 drain 直到拿到 usage；拿不到按已转发字节估算回填；不再删除有内容的 pending |
| F5 | `/sidebar/file` 同源返回 html/svg 且 cwd 可任填 → 本地 XSS/RCE | html/htm 强制 attachment+octet-stream+nosniff；svg 加 sandbox CSP+nosniff；cwd 覆盖只对已注册会话生效 |
| F6 | memory-evolve 技能管理 API 无任何栅栏 | 每个请求校验 loopback socket + loopback Host + origin/sec-fetch-site 同源 |
| F7 | session 持久化异步写与 clear 竞态 → 登出后 token 复活 | persist 增加代际(epoch)校验，clear/换号后在途写入作废；写盘前二次校验 |
| F8 | 配额检查-使用非原子(TOCTOU) | 余额闸门提供硬限制(存量为原子扣减)；月度配额保留为软上限(页面语义已说明) |
| F9 | 用户名大小写口径全链路不一致 | users 查询/授权比较改 `lower()`；CreateUser 先做 nocase 查重；干净库迁移期建 `lower(username)` 唯一索引，脏数据启动告警 |
| F10 | provider base_url 无校验(SSRF/密钥外泄) | 保存时 scheme/userinfo/metadata 校验；运行时 Dial 复检拦截 link-local/metadata(私网自建上游仍允许) |
| F11 | usage 分区 DETACH/DROP 错误被吞、孤儿表使当月写入 500 | relispartition 区分真分区/孤儿表；DETACH 失败复检后上抛；孤儿表直接清理；ensureUsagePartition 识别孤儿并报明确错误 |
| F12 | deep link 可静默切换会话到攻击者服务器 | 已登录且目标 server 不同 → 拒绝并提示先登出 |
| F13 | TOFU 证书校验是死代码，且接管后会让系统 CA 全部失败 | auth-gate 接线；**2026-09-11 修正**：没有任何 pin 时**不安装**校验钩子（纯 Electron 默认校验）；有 pin 时先放行平台已信任的证书（`verificationResult === 'net::OK'`，见下），自签名需 `PICOAI_TLS_PINS` 或历史 pin，未知/不匹配拒绝并告警 |
| F14 | setAuthConfig 非事务 + 20+ 处吞错 → 半套配置 | 全部设置键单事务写入，失败回滚；校验/加密前移 |
| F15 | better-sidebar fence 只信 Host 头 | Host 自称 loopback 时必须 socket 也是 loopback；显式 trustedHosts 仍放行 |
| F16 | 审计哈希链全局 advisory lock 写放大 | 每 DB 单 worker 串行 + 批量(≤20 条/2ms)合并事务，锁每次批量获取一次；调用方仍同步等待结果 |
| F17 | 客户端/管理面登录限流各一份预算 | 共享同一 limiter 单例 |
| F18 | LDAP 停用对账硬上限 10 万用户 | 分页遍历全部用户 |
| F19 | createUser 建号与角色写入非原子 | 密码哈希 + 角色/状态一次 INSERT |
| F20 | preOrderNodes 多根森林只遍历一个根 | 收集全部根 + visited 环保护 |
| F21 | go.mod pquerna/otp 被误标 indirect | 移入直接依赖块(不再触发 toolchain 侧改写) |

## 三、验证

- Go：`go test ./... -count=1` 22 个包全绿(PG 容器，DB 用例不再 skip)；新增余额、
  环检测、流式计费回归测试。
- TypeScript/前端：enterprise 240 用例、account-card 18、better-sidebar typecheck、
  webadmin 122、browser 206、memory-evolve 18 全绿。
- GUI：Playwright 驱动真实前后端截图验证余额列表/设置卡片/调整对话框/快捷金额/
  超额拦截/发放幂等/CSRF 自动续期(截图 @ `.audit` 或验收时生成)。

## 四、遗留与运维说明

- 月度 token/金额配额仍是"检查后消费"的软上限；需要硬预算时启用余额闸门。
- 自签名服务端：客户端默认因系统 CA 不信任而拒绝；用 `PICOAI_TLS_PINS="host:port=sha256hex,..."`

> **2026-09-11 v2.7.0 线上事故与修正（重要）**：F13 的实现把 Electron 的
> `request.verificationResult` 当成**数字 0** 判断，而它在 Electron 43 里是
> **字符串**（实测受信任时为 `"net::OK"`，不受信任时形如
> `"net::CERT_AUTHORITY_INVALID"`）。于是"平台已信任就放行"这条快路径**从未
> 命中**：所有 HTTPS（公网 CA、客户前置 Caddy 发的正规证书、连 Chromium 自己
> 的 `redirector.gvt1.com`）都掉进指纹库，未 pin 一律 `-2` 拒绝 —— 渠道客户端
> 登录直接 `net::ERR_FAILED`，而证书本身完全正常（`knownRoot=true`）。
> 修正两点：①按真实形状判定（并保留数字 0 的兼容分支）；②**没有 pin 就不装
> 钩子**（用户定案："TLS 用默认的就行，前面还套了一层 Caddy"），把"是否偏离
> 默认校验"这件事收敛成"管理员显式 pin 过"。回归测试钉在
> `packages/host/enterprise/tests/tls.spec.ts`（`'net::OK'` 直接放行 +
> 空库不安装钩子）。
  带外分发指纹，或把企业 CA 装入系统信任库。
- 历史大小写重复用户名不会被自动合并：启动日志会给出列表，请管理员人工处理后再建唯一索引。

## 五、高视角复核修正（2026-09-11 第二轮）

对第一轮修复做独立复核（"测试全绿 ≠ 无问题"），发现并修复 3 个遗漏/新风险：

1. **F9 遗漏**：用户授权比较（`app_grants.grantee_type='user'`）仍是大小写敏感，与已改为
   NOCASE 的登录/创建口径不一致（授权给 `Alice`、登录 `alice` 会失配）。已统一
   `lower(grantee)=lower(?)`，删除用户授权路径同步修正。
2. **F10 遗漏**：模型同步（`channels.HTTPFetch`）与渠道余额查询使用独立 HTTP client，
   绕过了 provider 请求侧的 Dial 复检（DNS rebinding 防护有空隙）。新增
   `internal/util/netguard`（`IsBlockedOutboundIP/Host`、`SafeOutboundTransport`），
   保存校验与全部出站 client（网关转发/模型同步/余额查询）共用同一口径。
3. **新风险（余额语义）**：第一轮实现里余额在闸门**关闭**期间也随消费扣减。默认关闭
   数周后管理员首次开启闸门时，全员余额已被历史消费扣成负数，会在一瞬间被全部拦截
   （必须先用覆盖模式发钱才能恢复）。修正为：**仅闸门开启时扣费**（关闭期间余额是纯
   充值池）；并且保存"开启 + 额度 > 0"时**自动补发本月**（`balance_grants.month`
   幂等，已发不重复），消除从保存到调度器下一个 tick（最长 1 小时）之间的 0 余额窗口。
   前端在自动发放后同步刷新用户列表（否则余额列看起来"没生效"）。

### 第二轮补的回归测试

| 覆盖 | 位置 |
| --- | --- |
| F15 fence：Host 伪造 loopback + 远程 socket 必须拒绝、trustedHosts 放行 | better-sidebar `tests/trust-fence.spec.ts`（6 例） |
| F12：已登录拒绝切换服务器 / 未登录接受 / 同服务器刷新 token 接受 | enterprise `tests/deep-link-listener.spec.ts`（3 例） |
| F13：平台已信任直接放行（`'net::OK'` 字符串 + 数字兼容）、无 pin 不安装钩子、PICOAI_TLS_PINS 生效、畸形 pin 忽略 | enterprise `tests/tls.spec.ts` |
| F7：clear() 后在途异步 persist 不得复活 token 文件 | enterprise `tests/session-service.spec.ts` |
| F16：60 并发审计后哈希链完整无断链 | serverstore `audit_test.go` |
| F8：未启用不扣余额 / 启用后扣减 | serverstore `balance_test.go` |
| F8：保存开启闸门自动补发本月且重复保存不重复加钱 | serverauth `admin_test.go` |
| F1：会话绑定 CSRF 可用、篡改/错会话拒绝 | serverauth `admin_test.go` |
| F10：链路本地/metadata IP 拦截、私网/环回放行、metadata 主机名识别 | util `netguard_test.go` |

### 第二轮补充：共享限流器的三个配套修正（F17）

复核过程中由"跨入口共享预算"的回归测试连带发现：

1. F17 的初版修复曾在一次文件恢复中被回退（管理端仍是独立 limiter），新回归测试
   `TestLoginLimiterSharedAcrossSurfaces` 抓到后重新落地；
2. 共享单例的限流键按 **DB 实例**加 scope：生产单 DB 下客户端面/管理面真正共享
   同一失败预算，测试的每个临时库互不污染（否则共享单例会跨测试互相限流）；
3. `PICOAI_LOGIN_MAX_ATTEMPTS` 改为**每次判定实时读取**：共享单例不能在创建时
   固话阈值，否则某个测试的临时 env 会永久影响后续用例（阈值过大 → 限流测试
   永不触发；过小 → 正常登录被误伤）。
