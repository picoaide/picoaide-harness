# AGENTS.md — PicoAide Harness 服务端

> 本文件是给 AI 编码代理的项目级指令。先读它,再读服务端文档(`server/docs/01-architecture.md` 与 `server/docs/03-api-reference.md`)。代码与文档冲突时以代码为准,并同步修订文档。
>
> 服务端是 PicoAide Harness 平台的企业管控面,与桌面客户端(`packages/host/desktop`、`packages/host/*` 与 `packages/client/*`)同属一个仓库;员工/第三方客户端经 HTTP 接口(`/api/client/v2/*` 与 `/v1/*` 网关)接入。

## 1. 项目是什么(一句话)

**企业内网 AI 办公智能体的服务端与管理系统**:Go 服务端提供认证、LLM 网关(密钥不出服务端、按用户计量计费)、技能商城、共享内容与全部管理接口;webadmin 管理端(shadcn SPA,内嵌进服务端二进制)负责用户/部门/网关/用量/商城/能力中心/门户等全部配置（对外文案与标识来自渠道配置，不在管理端编辑）。

## 2. 第一性原理(设计为什么是这样,改设计前先过一遍)

1. **服务端是唯一控制面**——密钥只存服务端(AES-GCM + master key 文件);所有功能配置(模型/上游密钥/技能/凭证/配额/价格)由管理员在 webadmin 完成;登录后 `GET /api/client/v2/config/bootstrap` 统一下发(默认模型+建议清单)。
2. **严格默认拒绝**——商城与共享内容(shared_skills/agent_presets)均为**审核 + 授权双门制**:上架/审核通过后**未授权用户一律不可见不可用**(404 不泄露存在性);授权对象 = 用户或部门组(组名大小写不敏感);admin 恒全量不落表;授权变更必审计(audit_logs);改密/降权/禁用自动吊销全部 API token。
3. **部门(组)即金字塔组织架构**(迁移 0017)——`groups` 含 parent_id/leader_id:部门树任意层级、部门主管、员工**多部门归属**(2026-09:`PUT /api/server/admin/users/:id/department` 接受 `group_ids` 数组,兼容旧 `group_id` 单部门);权限继承:`UserEffectiveGroups` = 归属部门+祖先链(授权给部门覆盖子部门成员)+ 主管部门子树(主管向上继承)+ 隐式「全员」组(全员为保留名,禁建/删/改名);部门改名级联授权表(NOCASE)、删除须无成员/子部门/授权引用;LDAP 登录全量同步组(空组即回收)。
4. **计量即金钱**——usage 表记录每次 LLM 调用的 token 与费用(`cost`,记录时按模型定价与峰谷窗口折算,0022/0023)。员工侧的额度**只有账户余额一种**(0061/0062):存量、消费即扣(与 usage 同事务)、可逐笔对账;`settings balance.enabled=true` 时余额耗尽在网关 429 `BALANCE_EXHAUSTED`(admin 豁免,未开通余额账户的员工不受约束)。
   2026-09-11 起**下线**了员工 token 配额、员工金额配额与部门预算(三套并行机制互相打架:手动充了钱仍被软配额拦住;只有余额是可对账的)——列与 settings 键保留在库中但不再读写,详见 docs/planning/2026-09-11-balance-quota-consolidation.md。价格/峰谷窗口管理员可配置,改价只影响之后产生的费用。
5. **无状态优先**——服务端接口保持无状态(Bearer token / 管理端 session);客户端引擎概念(审批门控/CDP/本地沙盒)属于桌面客户端侧,不在服务端演进。

## 3. 不可违背的工程原则

1. **UI 组件一律使用 shadcn/ui,禁止自写 UI 组件**:webadmin 全部来自 `components/ui/`(不足时 `npx shadcn@latest add <name>` 拉取)。业务组件只做**组合与状态编排**。
2. **函数尽量复用,禁止复制粘贴**:新增代码前先搜仓库是否已有等价函数;同一逻辑只实现一次,重复 2 次即提取共享模块(serverstore DAO、util 包、公共中间件)。
3. **TDD 红-绿-commit**:每个任务先写测试(红)→ 实现(绿)→ commit;每个非平凡逻辑模块必须有可运行测试(Go `_test.go` / TS `*.test.ts`)。
4. **每任务结束必须 commit**,提交信息 `feat:|fix:|test:|docs:|chore:` 单行 ≤72 字符。
5. **安全边界不得绕过**:凭证 AES-GCM 加密、API token 只存哈希、TOFU 证书校验(客户端接入方)、限流/审计——一律不许为省事而移除。
6. **管理端 HTTP 走 `/api/server/admin/*`(session + CSRF)**:错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`。
7. **对外内容只走渠道配置(2026-09-10)**:客户端登录页/界面与服务端门户看到的一切（名称、标语、欢迎语、标识、主题色）来自**渠道配置**（镜像内 `/opt/picoaide/channel/`，构建时由私有仓 `picoaide/channels` 注入，见 `internal/channel`）。**不要再新增在线编辑这些内容的接口** —— 改内容 = 改渠道配置并重新构建镜像，这样内容可审计。旧的 `internal/brand`（上传/快照/开关）与 `brand:*` 权限已删除。
8. **镜像只从更新服务器分发**：不经任何镜像仓库（GHCR 已下线）。客户端安装包随服务端镜像发布，由服务端自身下发（`internal/clientrelease`）。

## 4. 架构总览

```
第三方客户端 / 员工接入 ──HTTPS/Bearer token──▶ Go 服务端
  ├─ 认证:local/LDAP/OIDC + api_tokens(90天过期)+ /api/client/v2/auth/me|usage
  ├─ AI 网关:/v1/chat/completions|embeddings|messages|completions|responses|models + per-user 限流 + usage 计量(费用/峰谷)
  ├─ bootstrap:/api/client/v2/config/bootstrap(默认模型+建议清单+connectors[])
  ├─ 商城/共享:/api/client/v2/marketplace|shared-skills|agent-presets|capabilities(授权制/双门制)
  ├─ 审计:/api/server/admin/audit(用户/部门/技能等敏感操作留痕)
  └─ 管理端 webadmin(go:embed 内嵌,/admin/):用户/部门/网关/用量/商城/能力中心/门户 —— 全部配置入口
```

## 5. 技术栈

- **服务端**:Go 1.26.6、gin、jackc/pgx/v5(PostgreSQL 唯一,无 SQLite)、argon2id、AES-GCM、go-ldap/v3、coreos/go-oidc/v3、go-git
- **webadmin**:Vite + React + shadcn/ui + react-router-dom(VChart 图表),Node 24

## 6. 目录结构

```
cmd/server/            # 服务端入口(--bootstrap-admin/-addr/-data/-db-driver/-pg-dsn/门户页渲染)
internal/              # router(路由唯一真源)/serverauth/llmgateway/marketplace/agentshare/sharedskills/
                       # capabilities/connectors/channel/clientrelease/portal/bootstrap/telemetry/serverstore/util
webadmin/              # 管理端(Vite React + shadcn,dist 内嵌进服务端二进制)
docs/                  # 服务端文档(01-09/DEPLOY;superpowers/ 为历史设计文档)
scripts/               # mock-upstream.go(假上游);部署脚本已于 2026-09-10 移除
data/                  # 服务端运行时数据(0700,gitignore);数据库在 PostgreSQL(单 compose 内置 postgres 容器)
```

## 7. 关键契约(两端必须一致)

### 7.0 API 命名空间与强制 JSON(2026-09 工程化重构)

- **命名空间唯一真源**:`internal/router` 包(常量 `NamespaceServer` / `NamespaceClientV2`)。
  - `/api/server/*` — 服务端管理面(webadmin/运维/审计: 用户/部门/网关/门户配置等)。
  - `/api/client/v2/*` — 客户端员工面(桌面客户端/员工接入: auth/bootstrap/channel/marketplace/共享/能力中心/门户等)。
  - `/v1/*` — LLM 网关独立命名空间(OpenAI/Anthropic 兼容,含官方原生无 `/v1` 变体),`BearerAuth` 保护。
  - 旧命名空间(`/api/*`、`/v2/api/*`、`/v2/v1/*`)已迁移移除,禁止新增旧前缀路由。
- **路由集中声明**:所有路由必须经 `internal/router.Register(r, Deps)` 集中声明(分组/认证中间件/权限申报),业务包**不得**自行 `r.Group()` 注册生产路由(仅测试自建路由树例外);业务包通过 `handlers.go` 的 `NewHandlers(db, ...)` 暴露 gin.HandlerFunc 集合。
- **Go API 所有端点必须返回 JSON**:任何 `*gin.Context` 响应(body)一律为 JSON——
  - 成功:`c.JSON(...)` / `gin.H{...}`;
  - 失败:统一错误信封 `{"error":{"code":"ERR_CODE","message":"..."}}`(经 `serverauth.WriteError`);
  - **禁止** `c.HTML` / `c.String`(text/plain) / 无 body 响应作为 API 响应;
  - 404(NoRoute) 与 panic(Recovery) 也必须 JSON 信封——`mountAPIGuards` 已统一;
  - 例外(产品 HTML 面,非 API):`/` `/portal`(门户首页)、`/admin/*`(webadmin SPA)、`/healthz`(JSON 探针);SSE(`text/event-stream`)与二进制归档下载(application/gzip)是流式/文件语义,不适用 JSON 约束。
- **认证与权限**:客户端面 Bearer(`serverauth.BearerAuth`);管理面会话+CSRF + RBAC(`serverauth.AdminAuth` + `AdminRoute` 权限申报,fall-open 防护)。
- **客户端调用面**:桌面客户端(enterprise)调 `/api/client/v2/*`;webadmin 调 `/api/server/admin/*` 与公开 `/api/client/v2/channel`。新增/修改端点时两端必须同步(见 §8 检查)。

### 7.1 REST 错误
- **REST 错误**:`{"error":{"code":"ERR_CODE","message":"..."}}`;`AUTH_REQUIRED`/`AUTH_FAILED`/`FORBIDDEN`(管理端)/`NOT_FOUND`/`VALIDATION`/`UPSTREAM`/`RATE_LIMITED`/`INTERNAL`(健康探针与 404 NoRoute 同信封)
- **bootstrap**:`{default_model, models, skills, web, connectors}`(接入方对 skills/web 缺省值兜底;connectors 为服务端连接器目录,0042 起)
- **员工用量接口**:`GET /api/client/v2/auth/usage` → `{balance_money, balance_activated, balance_enabled, balance_monthly, balance_mode, is_admin, today/yesterday/monthly/total usage+cost}`(账户卡的数据源;字段集合是**跨语言契约**,由 `server/internal/serverauth/usage_contract_test.go` 与 `packages/client/account-card/src/usage-contract.ts` 对拍)
- **DB**:PostgreSQL 唯一,迁移 `internal/serverstore/migrations-pg/` 0001–0062(0034 shared_skills 多版本、0035 agent_presets 多版本、0036 共享授权、0037 quality、0039 usage 分区 + 日/月账本、0040/0041 归档直存 DB、0042 connectors、0043/0044 provider protocol、0045 glitchtip 下架、0046 rbac 角色、0048 审计哈希链、0057 管理员 MFA、0061/0062 员工余额与账本)
- **审计契约**:`GET /api/server/admin/audit?page=&size=&action=&username=`(敏感操作留痕;默认保留 180 天,settings `audit.retention_days` 可配;0048 起哈希链防篡改)
- **费用口径**:cost 记录时按 输入×input_price/1e6 + 输出×output_price/1e6(缓存命中另按 `cache_input_price_per_1m`,0029),高峰窗口(settings `usage.peak_windows`,北京时间)外 × `offpeak_discount`;员工侧不再有"配额/剩余"概念(见上条),拦截只看账户余额

- **员工余额(0061/0062,2026-09-11 收敛)**:`users.balance_money` 是**账户余额**(元,存量)——员工唯一可花的钱。
  - 开通语义:`users.balance_activated_at` 在**首次入账**(发放或人工充值)时置位;未开通用户既不扣余额也不被闸门拦截(存量部署开启闸门不会误拦全员,关闭期间的消费也不会产生欠款);
  - 消费:已开通用户的消费**始终**扣减(`settleUsageCostTx` 与 usage 落账同事务,按该行"已计费金额"结算差额:重复回填不重复扣、费用下调自动记 `refund`);闸门开关只决定"拦不拦",不决定"记不记";
  - 账本:`balance_ledger` 追加型流水,**不变量** `users.balance_money == SUM(balance_ledger.amount)`;消费/回补带 `usage_id`;
  - 闸门:`settings balance.enabled=true` 且已开通 且 `QuantizeMoney(余额) <= 0` → 429 `BALANCE_EXHAUSTED`(管理员豁免,查询失败 fail-closed);精度三层同源:记账微元 1e-6 / 判定与展示都走 `serverstore.QuantizeMoney`(分位);
  - 管理:`POST /api/server/admin/users/:id/balance {mode:add|deduct|set|clear,amount,reason}`(审计 `balance_adjust`)、`GET /api/server/admin/users/:id/balance/ledger`(流水 + `ledger_sum` 对账)、`GET/PUT /api/server/admin/balance`(enabled/monthly_amount/monthly_mode=add|cover)、`POST /api/server/admin/balance/grant`(补发本月,逐人幂等);
  - 月度发放:`internal/balance` 调度器每 10 分钟检查,幂等锚是 `balance_grant_items(user_id, month)`(**逐人·月**,不再是整月单锚)——新入职/漏发/重新启用的员工会被下一轮自动补齐;`cover` 模式把清零差额记成 `reset` 流水(抹掉的手工充值可追溯);发放与闸门**解耦**(额度 > 0 就发,是否拦截由 enabled 单独决定);
  - 员工侧:`GET /api/client/v2/auth/usage` 返回 `balance_money/balance_activated/balance_enabled/balance_monthly/balance_mode`;未开通时客户端不渲染余额行;
  - 整体设计与审计问题清单:`docs/planning/2026-09-11-balance-quota-consolidation.md`;初版余额与第一轮修正见 `docs/decisions/2026-09-11-balance-and-audit-fixes.md`。

## 8. 常用命令

```bash
make test              # go test ./... -count=1(服务端全量;不依赖数据库,无 PG 时 DB 用例自动 Skip,设 PG_DSN_TEST 则全量)
make test-server       # 服务端各业务域测试(目录通配 internal/... + cmd/...;-p $(TEST_PARALLEL) 默认 4)
make test-server-fast  # 同 test-server 但不带 -count=1 → 无改动时整轮命中 go test 结果缓存(实测全仓 0.3s)
make webadmin          # cd webadmin && npm run build(产物内嵌进服务端二进制)
make build-server      # make webadmin + go build -o bin/picoaide-server
make docker-image      # 本地构建服务端镜像(发布镜像走更新服务器,不经镜像仓库)
make check             # gofmt + go vet + test-server + webadmin 测试与构建(发布门禁)
make check-fast        # 开发循环:gofmt + vet + test-server-fast + webadmin 单测(不建 webadmin 产物,实测 15.6s)
# 测试库:每个 DB 用例从模板库 picoaide_tmpl_<迁移哈希> 克隆(见 internal/serverstore/dbtest.go),
#   不再逐用例重放 52 个迁移(单用例固定开销 1.5s → ~0.1s);换迁移/跨月会自动生成新模板库,
#   模板不可用时自动回落到"空库 + 全量迁移"。提速实测见 ../../docs/decisions/2026-09-10-verification-speedup.md。
PICOAI_ADMIN_PASSWORD=x bin/picoaide-server -addr :8080 -data ./data --bootstrap-admin admin
go run scripts/mock-upstream.go 起假上游  # 无外网/无 key 环境验证网关
# 生产部署:按 ../../docs/deploy/AI-DEPLOY.md 执行(脚本已下线,交付物=一个镜像)
# 数据库: PostgreSQL 唯一。-db-driver 仅接受 pg(默认;pg-external 为历史兼容别名,部署层已不用),-pg-dsn 必填;
#   迁移 DDL 见 internal/serverstore/migrations-pg/(迁移自动应用)。SQLite 与 migrate-sqlite-pg 已下线,
#   老数据需先在历史版本完成迁移。
```

## 9. 文档与实施

- 架构设计:docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md(ADR、安全设计、错误边界;历史设计文档)
- 实施计划:docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md(阶段 1 服务端网关仍有效;阶段 2/3 客户端相关已下线)
- 部署:../../docs/deploy/AI-DEPLOY.md(唯一部署说明:首次部署/升级/回滚/排障)与 docs/DEPLOY.md(容器化设计说明)、docs/02-build-deploy.md(构建、systemd、CI)
