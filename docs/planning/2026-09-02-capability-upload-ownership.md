# 规划：能力中心上传归属权（同名互斥 + 管理面）

日期：2026-09-02　分支：master　状态：**规划，待用户拍板 3 个决策点后实施**

## 一、需求

能力中心的技能/智能体上传需要**归属权**：

1. 员工 A 上传了某个技能（能力）后，员工 B 不允许再上传同名技能；
2. 管理员上传（上架）的技能，普通员工不允许上传同名技能。

## 二、现状核实（重要：两条规则的内核级实现已存在）

2026-09-01 的统一 App/Release 模型（决策 `docs/decisions/2026-09-01-skill-app-management.md`，P0–P5 已全部实施）已经把归属权做进了**唯一发布内核**。三条上传路径（员工技能 / 员工智能体 / 管理后台上架）全部经 `appstore.Publish`，归属检查只实现一次：

| 现状机制 | 代码位置 | 命中什么场景 |
|---|---|---|
| **归属保护** | `server/internal/appstore/publish.go:138-141` | App 已存在且 `owner != 发布者`（非管理员）→ `404 NOT_FOUND "能力不存在"`（不泄露存在性）。**规则 1 已满足** |
| **跨渠道同名互斥** | `publish.go:129-137` | 一个 `(kind, app_id)` 只能属于一个渠道；管理员上架进「市场」后，员工同名传「组织」→ `409 NAME_TAKEN`。**规则 2 的市场路径已满足** |
| **应用锁定（占名）** | `0050` 迁移 + `publish.go:116-127` | 管理员在 webadmin 预锁定任意名字（可锁定**尚不存在**的名字）→ 员工命中 `403 APP_LOCKED` + 原样回显理由；管理员发布不受限。**规则 2 的主动管控路径已满足** |
| **版本不可复用/递增** | `publish.go:143-170` | `VERSION_EXISTS`（含被拒/软删）/ `VERSION_NOT_INCREASING` / `CONTENT_UNCHANGED`，作者重复上传也会被拦 |
| **owner 一经写入不可被改写** | `serverstore/apps.go UpsertApp` | `COALESCE(NULLIF(apps.owner,''), excluded.owner)`——后续任何发布都不能覆盖归属 |
| **归属=登录态，不可伪造** | `publish.go` `Publisher` | 取自 Bearer 登录用户，与包内署名（`author`）分列存储；归属判断只认 `Publisher` |

测试：`server/internal/appstore/publish_test.go` `TestPublishLockAndOwnership` 已覆盖「锁定拒绝 / 跨渠道 NAME_TAKEN / 他人 App 归属保护 404」。

**结论**：需求的两条规则不是"从零实现"，而是**语义核验 + 边界补强 + 管理面补齐**。本规划避免重复建设，只做增量。

## 三、归属语义定案（顺带把规则写成显式契约）

- **归属主体**：`apps.owner` = 首个成功占名的发布者（登录态用户名）。**pending 即占名**；被拒、被软删后仍占名——与「版本号一经使用永久占位」同一防抢占精神。
- **同名判定粒度**：`(kind, app_id)`。技能与智能体允许同名（能力中心卡片复合键历来如此）；`app_id` 强制小写 kebab（`my-skill` vs `My-Skill` 结构性归一，无变体绕行）。
- **归属只约束「谁能发新版本」，与以下维度正交**：
  - 授权（grants）：谁能**看/装**由授权决定，与归属无关；
  - 锁定（capability_locks）：锁定只约束「谁能写」，且支持占名预锁定；
  - 渠道（market/org）：App 一经建立不得改渠道（结构性互斥）;
  - 质量（quality）/上下架（enabled）：审核动作只改状态位。

### 发布权限矩阵（一次 Publish 的判定顺序）

| 场景 | 结果 |
|---|---|
| 员工、自己的 App、版本递增 + 有 changelog | 成功（pending） |
| 员工、他人 App（任意状态：pending/approved/rejected/软删） | **404** "能力不存在"（不泄露存在性） |
| 员工、被锁定的名字 | **403** APP_LOCKED + 回显理由 |
| 员工、名字已被管理员发到市场 | **409** NAME_TAKEN |
| 员工、同名另一渠道 | **409** NAME_TAKEN |
| 管理员、任意名字/任意渠道 | 成功（跳过锁定与归属检查，发布即 approved） |
| 任何人、重复版本/降版本/内容未变 | 409 系列对应错误码 |

## 四、缺口清单（本规划的真实增量）

### G1【漏洞】空 owner 的历史行可被员工接管

`publish.go:139` 的归属保护要求 `existingApp.Owner != ""` 才生效；`UpsertApp` 对空 owner 会写入新发布者（`publish.go:184-187`）。0054 回填的 owner 来自旧表作者列，虽然旧语义为上传者（一般非空），但**空值行一旦存在，任何员工都能"接管"该名字并成为 owner**——违反规则 1。

**修法（推荐）**：非管理员发布命中空 owner 的 App → 一律 404（视同不存在，与归属保护同规则）。这是防御性收紧，不依靠数据迁移。

### G2【管理面缺失】归属无法转移/展示，owner 不可维护

- 员工离职/被禁用/账号改名 → 技能归属永久绑定旧账号，无任何转让途径（管理员虽能发新版本，但 `apps.owner` 仍显示旧账号，且 2026-09-01 决策文档 §3 明确模型里"owner = 首次发布者**或管理员指定**"——"管理员指定"未实现）；
- webadmin 审批队列的「作者」列已显示上传者（Author=Publisher 适配），但**没有「归属」列与转移操作**；
- 客户端卡片显示作者（=上传者），但**没有"归属人"标识**——员工无法区分"这是谁维护的"。

**修法**：新增管理端归属转移端点 + webadmin 转移弹窗 + 审计。

### G3【客户端】上传失败文案误导 + 状态码被重映射

- 员工 B 上传被 404 时看到的是"能力不存在"，会以为系统故障或名字不合法——实际是"名字已被别人占用（或不可用）"；
- `auth-gate.ts:1191-1195` 的上传错误转发把所有非 `PENDING_LIMIT`/`NAME_TAKEN` 的服务端状态码一律重映射为 **422**（`VERSION_EXISTS`=409、`APP_LOCKED`=403、`NOT_FOUND`=404 全被压平），客户端只能拿到 message 文本，状态语义丢失。

**修法**：① 状态码透传（服务端原样转发）；② 上传前客户端本地预检（对照可见列表/本地创作中同名且非自己 → 直接提示"名称已被占用，请改名"，不发请求）；③ 服务端 404 的 message 改为更中性的通用文案（见决策点 1）。

### G4【测试与文档】归属语义缺正式断言与文档

`publish_test.go` 已有所有权核心用例，但缺：空 owner 接管、被拒后归属仍保留、软删后占名、转移后新旧归属行为、审计条目。服务端文档（`server/docs/07-marketplace.md` / `08-agent-share.md`）未把「归属」写成显式契约。

## 五、决策点（2026-09-02 用户拍板：「按照你的来」，技能负责人管理员可修改）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 员工撞他人名字时，服务端行为 | **保持 404 + 通用文案**（"名称不可用:可能已被占用或不属于你"）——不泄露存在性，客户端预检负责友好提示 |
| D2 | 归属转移是否纳入本轮 | **纳入**——`PUT /api/server/admin/apps/:kind/:app_id/owner` + webadmin 转移弹窗 + 审计 `app_owner_transfer`（用户补充：技能负责人管理员可修改 ✓） |
| D3 | 部门级共属（同部门同事可续传）| **不做**。个人归属保持确定性，列为未来可选项 |

## 六、实施方案

### P1 服务端（独立可上线）

1. **空 owner 收紧**（G1）：`appstore.Publish` 归属保护条件改为——非管理员发布且 App 存在时，`Owner != req.Publisher`（含空 owner）一律 404。注意保留「首次发布」（App 不存在）路径不受影响。
2. **归属转移端点**（G2）：
   - `PUT /api/server/admin/apps/:kind/:app_id/owner`，body `{owner}`；
   - 校验：`kind ∈ skill|agent`、目标账号存在（`serverstore.GetUserByUsername`）、owner 非空、App 存在；
   - 权限：`PermCapabilityWrite`（与锁定同为能力中心管控动作）；
   - 审计：`app_owner_transfer`，明细含 `kind:app_id 旧owner → 新owner`（沿用审计明细正则可还原的格式）；
   - 路由：`internal/router` 集中声明 + `serverauth.RegisterAdminRoutes` 镜像（测试树同步，防止 rbac 回退漏测）；
   - **不做**的边界：不接受清空 owner（防误操作置为无主）；管理员对自己发布的 app 也可转移（交给正式维护人）。
3. **测试**（TDD）：
   - 空 owner 行：员工 404 / 管理员可发布；
   - 转移后：新归属可续传（版本递增）、旧归属 404、审计条目含新旧值；
   - 被拒/软删后占名（员工 B 仍 404）；
   - 权限矩阵表（第三节）逐行断言。

### P2 客户端（独立可上线）

1. `auth-gate.ts` 上传错误转发改为**透传服务端 status**（G3），错误码与 message 不再压平；
2. `CapabilityCenterPanel` 上传预检（G3）：上传前对照当前可见列表——目标 `(kind, name)` 已存在（来源 org/market）且本地"我的"分区无同 owner 记录 → `failed` 提示"名称已被占用，请更换名称或联系管理员"；命中自己已发布行 → 提示"已由你发布，请升级版本（vX+1）"；预检通过才发请求，服务端校验仍是权威；
3. 404 兜底文案：收到 `NOT_FOUND` 时展示通用"名称不可用"文案（与 D1 一致）。

### P3 webadmin（独立可上线）

1. 能力中心统一审批页（`Capabilities.tsx`，status=all/approved 过滤）行操作增加「转移归属」弹窗（目标用户搜索选择，复用 Users 页的账号检索/选择交互）；
2. 表格增加「归属」列（= 上传者/owner，作者列语义保留展示包内署名）；
3. 审计页文案不变（新动作自然出现）。

### P4 文档

- 决策文档 `2026-09-01-skill-app-management.md` 追加本轮实施记录（含 `app_owner_transfer` 审计动作）；
- `server/docs/07-marketplace.md` / `08-agent-share.md` 补「归属」显式契约（第三节表格）；
- 能力中心客户端文案按 D1 结果同步（i18n）。

## 七、明确不做（保持现状）

- 部门级/多属主协作（D3）；
- 渠道转移（管理员把员工 org 技能改发市场）——未来可选，涉及 app 级变更语义；
- App 级删除/改名（破坏性，与版本/名称永久占位冲突）；
- 锁定通配前缀（2026-09-01 决策已明确不做）；
- 客户端面 `/api/client/v2/apps/*` 路由（2026-09-01 决策已明确不做）。

## 八、验收标准

1. 员工 B 上传员工 A 已占名的 X（pending / approved / rejected / 软删四种状态）→ 404，且响应不含任何归属信息；
2. 员工 A 本人对 X 续传新版本正常；被拒后仍可升版本重提；
3. 管理员上架市场同名 → 员工上传 409 NAME_TAKEN；锁定名 → 403 APP_LOCKED 且回显理由；
4. 空 owner 历史行：员工 404，管理员可发布并指定归属；
5. 转移归属后：新归属可续传、旧归属 404、审计 `app_owner_transfer` 可检索到新旧值；
6. 客户端：撞名场景本地预检给友好提示且不发请求；服务端兜底错误不被压平为 422；
7. 门禁：`make check` + `corepack yarn check` 全绿；每阶段独立可上线。

## 九、实施记录（2026-09-02 完成，3 个 commit）

- **P1 服务端**：`appstore.Publish` 空 owner 收紧（404 接管防护）+ 归属转移端点 `PUT /api/server/admin/apps/:kind/:app_id/owner`（`serverstore.SetAppOwner`、RBAC `capability:write`、审计 `app_owner_transfer`、`CapabilityItem.is_owner` + `ApprovalRow.owner`）+ TDD（`publish_test.go` 4 组新用例 / `admin_test.go`）；commit `0acbdfae7a`。
- **P2 客户端**：`ApiError.status` 透传 + auth-gate 技能/智能体上传代理状态码不再压平 + `CapabilityCenterPanel` 撞名本地预检（`is_owner`）；commit `9c169d26b0`。
- **P3 webadmin**：审批页「归属」列 + 「转移归属(负责人)」弹窗；106 测试全绿（+3 用例）；commit `2fab7c2c25`。
- **P4 文档**：决策文档 2026-09-01 追加实施记录；`server/docs/07-marketplace.md` §5 / `08-agent-share.md` §7 归属契约；本节。
- 门禁：`go test ./...`（含 PG 临时库用例）+ `go vet` + webadmin vitest 106 + typecheck/build 全部通过；未跑 `make check`/`yarn check` 全量（收尾统一执行）。
