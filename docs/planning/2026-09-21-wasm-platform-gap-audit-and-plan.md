# WASM 应用平台：功能缺口审计与「作者检查自己 SQL 数据」专项规划

- 日期：2026-09-21
- 基线：`feat/dsh-0.1.6-upgrade` @ `c7616c1f19bec3917cb8ae4c0b04bee52589d4bc`
- 性质：**只读审计 + 规划**。未修改任何代码/配置；本文档是唯一交付物。
- 需求来源（用户原话）：「仔细审计我们的 WASM 在实现还有哪些功能？然后还有就是作者不能够检查自己的 SQL 数据。你先做规划，现在还有哪些没有做完的功能和还需要补充的功能。先不要改代码，先做计划。」

---

## 0.0 实施状态（2026-09-21 第二/三轮审计修复后更新）

> ⚠️ **这一节只是"该看哪里"的索引，不是闭合凭据。** 按本仓纪律，任何"已完成"的判据都是
> **可复跑的用例 + 变异验证**，不是本文档的状态列。行文中的提交号可 `git show` 复核。

**已落地（本文档 §3 的 P0 全部 + §5 专项 + 二/三轮审计的 P1/P2）**：

| 波次 | 内容 | 落地位置 |
| --- | --- | --- |
| W0 · P0-0 | 段内**计数向量越界分配**（15 字节模块 ⇒ 256 GiB 映射 ⇒ 进程 `fatal error`） | `wasmmod/parse.go` 的 `checkVecCount`；判据 `TestValidateRejectsOversizedVectorCounts` 等；变异：关掉判据 + `ulimit -v` 复现 OOM |
| W0 · P0-4 | DataCount 段位置的**规范位置**（与 wazero `checkSectionOrder` 同判） | `parse.go` 的 DataCount 特例；判据：平台侧 + wazero 侧（`runtime/datacount_test.go`） |
| W0 · P0-5 | `.debug_*` 段的**三处同源**分类 + 段预算口径统一 | `assets.ToolchainSectionPrefixes` / `CountsTowardSectionBudget`；`pack-assets.mjs`；`preview.mjs`；判据见 `assets_test.go` 与 `wasmmod/pack_assets_test.go` |
| W0 · P0-6 | 白名单补 `sock_recv`/`sock_send`（TinyGo `net/url`） | `imports_gen.go` 重新生成；判据含"夹具真产出符号"前置断言 |
| §5 专项 | 作者数据面 `GET …/wasm/:app_id/rows`（只读、默认脱敏、显式 `unmask`、全审计）+ 客户端数据面板 + AI 工具 | `api/rows.go`、`api/read.go`、`client/…/DataBrowserPanel.tsx`、`wasm-app-tools.ts`；决策记录 `docs/decisions/2026-09-21-app-author-data-surface.md`（含 §5.9 十个待拍板点逐条落实与认账） |
| 二轮审计 P1 | 段序判据与 wazero 同判（重复段恒拒）；`cachetrust.Ensure` 不再跟随符号链接改权限、失败不再报"可信"；执行侧缓存不可用一律降级（不再 `log.Fatalf`）；宿主 `GET …/rows` 加**持有性证明** | `parse.go`、`cachetrust.go`、`runtime/{config,runtime}.go`、`wasm-apps.ts` |
| 二轮审计 P2 | 日志/审计/LDAP 三处**共用一份转义策略**（C0+C1+Cf/Zl/Zp、按转义边界截断）；`appdb.SafePath` 拒符号链接；审计"读成功才记账"；畸形响应不再渲染成"空表" | `util/control.go`、`logbuf`、`auth-gate`/`ldap.go`、`appdb.go`、`api/{read,rows}.go` |

**仍未做**（"未做"既不是"不打算做"，也不是"已排期"；各自要独立决策）：

- §3 的 **B1–B5 五类接线缺口**（应用窗口↔browser runtime、`window.ratio` 进建窗、缓存 `put/get` 闭环、下架清浏览器存储、应用 AI 归因）—— 它们是"设计已冻结、实现没接通"，与本次的安全/数据面修复不是同一批。
- §3 里的 P1/P2 余项（部门用量汇总与 UV、目录服务端分页、模块缓存统计面、`/readyz` 细分、`--ro-bind-try /etc` 收窄编译进程可读面等）。
- §5.9 第 2 点的**规划推荐口径**（AI 默认关 + 显式授权卡）：当前实现是"默认开 + 只脱敏 + 全审计"，已在决策记录里如实认账并写明改法（一处改动）。

---

## 0. 摘要

**A0. 发版前必修（安全）**：`wasmmod` 段解析对段内"计数向量"做无界分配 ⇒ 任意已登录员工用 **15 字节**的 wasm 打 `POST /api/client/v2/apps/wasm/validate` 即可让**整个服务端进程** `fatal error: out of memory` 退出（不可 recover、无审计、无信封）。2026-09-18 沙箱审计已登记为 P0，**本次独立复现仍存在，且它从未进入任何"未闭环清单"**。修法 3 行 + 一组用例。

**A1. 工具链有三个"合法产物发不出去"的 P0**（D 报告用**真服务端 + 真编译**实测，三条**一个都没修**）：
① **DataCount 段位置判据与平台自己的运行时 wazero 互斥** ⇒ 任何带 DataCount 的模块（TinyGo 默认、bulk-memory 的 LLVM/Rust/Zig 配置）**100% 无法发布**，且没有可利用的绕法（规范位置 → `SECTION_MALFORMED`；改升序 → 真编译器 `invalid section order`）；
② **`.debug_*` 段被当应用资源发布**（Rust 默认产物 97.7% 是 DWARF，会作为可直出资源、吃掉一半段额度 ⇒ 信息泄露）；
③ **导入白名单缺 `sock_recv`/`sock_send`**（TinyGo 的 `net/url` 被拒）。

**A. 平台主体是能用的**：应用中心（搜索/我发布的/分页/空态）、发布（AI 工具 + 客户端表单 + 宿主路由三条可达路径）、独立窗口、上下架、删除、审核队列、打开计数与运营看板、限制项控制台、诊断面板、深链分享 —— 都有实现与判据，端到端已在测试环境跑通（v2.7.6 已上线）。服务端客户端面 18 条 + 管理面 16 条共 34 条路由**全部有真实实现**，F1–F16 中服务端承担的部分除"应用 AI 归因"外全部落地。

**B. 但存在 5 类"设计已冻结、实现没接通"的缺口**（不是设计空白，是接线没做完）：

| # | 缺口 | 后果 |
| --- | --- | --- |
| B1 | 应用窗口未接入 browser runtime（`registerApp` 零生产调用点） | AI 无法操作用户的应用窗口，控制权胶囊不存在（设计 F7/§7.2 冻结） |
| B2 | 作者声明的 `window.ratio/width/height` 从不进入建窗路径 | 比例锁定与首次尺寸不生效，而详情页却显示"窗口比例 16:9" |
| B3 | 客户端静态资源缓存只接了"失效"半环（`put/get/conditional` 零调用点） | F11 缓存零效果，每次打开全量回源；28 条缓存用例全绿掩盖了它 |
| B4 | 浏览器存储清理（下架/冻结/删除时）零实现；分区名缺服务端哈希 | 下架后应用 origin 的 localStorage/IndexedDB 留盘；换服务端时跨租户串味 |
| B5 | 应用 AI 归因只读一个**没有任何客户端发送方**的请求头 | 管理端"应用 AI 用量"恒显示"统计尚未上线" |

**C. 作者（尤其 AI 作者）排障闭环是断的 —— 这是本次最值得投的一块**：
- 作者**看不到应用库的行数据**（全仓无任何行内容出口）；
- 唯一的数据面自省端点 `GET …/wasm/:app_id/schema`（表/列/行数/占用）**有实现、有鉴权、有审计、有测试，却没有任何产品入口**（客户端/管理端都不调）；
- 应用 `log` 的"7 天保留"与"诊断聚合"**没实现**（只写服务端 stdout，无表无端点），而技能文档已向作者承诺；
- 调用事件里的 `db_rows`/`db_bytes` **只写不读**（诊断 SQL 没 select 它们），作者拿不到"这次写了几行"；
- 本地假宿主 `preview.mjs` 用**正则解析 SQL + 内存表**、且"每次调用都是全新内存库"⇒ 开发期结构性无法验证真实 SQL；
- AI 只有 `wasm_app_list/validate/publish` 三个工具，**没有任何回读工具**，而技能文档要求它"先读诊断，再改代码"。

**D. 生命周期与运维面缺一半**：无版本回滚（生效版本恒 = 最新 approved）；管理端无删除/恢复/导出入口；仓内**没有任何反软删实现**；冻结保留期的"定期快照"与"到期真删"两个后台任务**代码里自己写着未实现**（`api/read.go:739-745`）⇒ 冻结 = 事实上的永久封存。

**E. 文档漂移已成规模（会直接误导 AI 作者）**：D 路逐条对拍 **94 条作者面断言 = 66 条一致 / P0×1 + P1×9 + P2×12 = 22 条漂移 / 6 条无法验证**，另有 3 条反向漂移（代码/模型可见文案过期）。最严重的一条是**文档承诺了不存在的"冻结快照 + 90 天后真删"**（P0）；另有 `DB_LIMIT` 说成会报错（实际只置 `truncated`）、`FORBIDDEN` 归错失败码、`window.width/height` 类型写反、`Cache-Control` 说成应用可设（实为宿主独占静默丢弃）、以及**模型可见的工具描述仍写着"应用地址是 https://<app_id>.<企业域名>"**（该域名模型已随 W4 删除）。生成物类文档（limits/imports/app-config）与代码规格表**同源一致**（两条 `-check` EXIT=0），漂移出在"规格表文案 × 运行行为"——只改 `.md` 会被门禁打回。

**F. 「作者不能检查自己的 SQL 数据」的正确定位**：设计总纲 §3 F1–F16、§17、§21.7、09-17 基线、作者指南、技能文档**都没有承诺过**行数据查看 ⇒ 这**不是未完成功能，是一个未立项的产品空白**；而 `app-lifecycle.ts:22` 已明写"导出、自省、审批留给管理端与后续波次（不该在没有产品决策的情况下暴露）"。**所以这一步要先拍产品决策，再动代码**（§5 给了方案与 10 个待拍板点）。

**G. 建议的下一步**：本文 §6 给了四波实施建议。**W0 = 先修 A0 的 OOM**（3 行，发版前）；第一波（W1，约 1 周）只做"闭合已承诺 + 接线零成本项"：AI 回读工具 + `db_rows/db_bytes` 进诊断 + `schema` 补入口 + 本地真 SQLite 预览 + 文档承诺对齐。第二波才是"应用库只读数据面"这件需要拍板的新能力。

---

## 1. 审计范围与方法

### 1.1 范围
- 服务端：`server/internal/wasmapp/**`（27 包）、`server/internal/router`、`server/cmd/server` 装配、`server/internal/serverstore` 的 wasm DAO 与迁移 0069–0076、`server/internal/llmgateway/app_attribution.go`。
- 宿主/客户端：`packages/host/wasm-apps-host/**`、`packages/host/enterprise/src/wasm-app*.ts`、`packages/host/browser/**`（surface seam）、`packages/host/desktop/src` 装配、`packages/client/wasm-apps/**`。
- 管理端：`server/webadmin/**`。
- 作者工具链与文档：`server/skills/app-builder/**`、`docs/wasm-app-authoring.md`、`server/demoapps`、`site/`。

### 1.2 方法
- 6 条并行**只读**审计泳道，每条独立产出报告（证据一律 `文件:行号` 或实跑输出）；主控另做主线自研（应用库可观测性 + 缓存 + 归因）。
- **文档/台账的自述状态不作为证据**（本项目已实测"台账状态列大面积过期"，本次又抓到两处：旧审计"`wasm_app_*` 工具零实现"已被推翻；台账"缓存 version 未接线"实际是"缓存整体未接线"）。
- 子报告（`temp/wasm-gap-audit-2026-09-20/`，均为只读、开工时 `git status` 干净、各带自己的实跑证据与自查）：

| 报告 | 范围 | 规模 |
| --- | --- | --- |
| `A-server.md` | 服务端能力面、34 条路由（客户端面 18 + 管理面 16）总表、F1–F16 服务端部分、死接线清单 | 320 行 |
| `B-client-host.md` | 客户端与宿主（应用中心/窗口/安全链路/应用 AI/工具面/判据质量） | 536+ 行 |
| `C-appdb-observability.md` | 应用库可观测性专题（用户点名项） | 682 行 |
| `D-authoring.md` + `D-docs-drift.md` | 作者工具链端到端（真服务端 + 真编译实测）+ 作者面文档 × 代码漂移（94 条断言对拍） | 313 + 246 行 |
| `C-preview.md` | `preview.mjs` 假宿主能力边界（46 行差异表、48 条宿主调用实测） | 365 行 |
| `E-webadmin.md` | 管理端与前后端契约（17 条端点对拍 + 双向缺口） | 289 行 |
| `F-unresolved.md` | 已登记未闭环项逐条独立核验（仍开 21 / 部分闭合 8 / 已闭合 40+ / 与原判不一致 14 处） | 462 行 |

### 1.3 判定标签
`已实现（有判据）` / `已实现（判据弱）` / `部分实现` / `未实现` / `无法验证`。
「判据弱」= 只钉字符串、只断言存在性、mock 掩盖契约、变异不会变红（本项目已登记 8 类假绿模式）。

---

## 2. 平台现状：能做什么（基线）

### 2.1 员工面（客户端内）
| 能力 | 状态 | 关键证据 |
| --- | --- | --- |
| 应用中心：目录/搜索/「我发布的」/分页/三种空态 | 已实现 | `AppCenterPanel.tsx:695-750`、`catalog-filter.ts:39-129` |
| 打开应用（本机路由 + 持有性证明 + 会话闸门） | 已实现 | `open-app.ts:446`、`host-proof.ts`、宿主 `index.ts:536-542` |
| 独立窗口（单应用单窗口/聚焦导航/尺寸记忆） | 部分实现 | 比例与首次尺寸未生效（§3 · P0-2） |
| 深链分享 `scheme://app/<id>?path=` | 已实现 | `deep-link.ts:84-88`、未拿到 scheme 时 fail-closed |
| 发布 / 发新版 / 上下架 / 删除 | 已实现 | `PublishForm.tsx`、`publish-app.ts`、`app-lifecycle.ts:140-218` |
| 版本历史与审核结论（含被拒理由） | 已实现 | `app-releases.ts:180`、`AppCenterPanel.tsx:1991-2028` |
| 应用诊断面板（失败码/计数/hints） | 已实现 | `AppCenterPanel.tsx:2038-2070`、`app-lifecycle.ts:314` |
| 今日打开次数 + 隐私说明 | 已实现 | `AppCenterPanel.tsx:1431-1432` |
| 应用 AI 面板（授权/撤销 + 聊天） | 部分实现 | 授权完整；**聊天链路不可达**（§3 · P1-5） |
| 应用内 AI（客户端 AI loop，`POST /__picoaide/ai/chat`） | 已实现（应用页内） | `handler.ts:201-242`、`ai-chat.ts` |

### 2.2 作者面（AI + 人）
| 能力 | 状态 | 关键证据 |
| --- | --- | --- |
| 宿主工具 `wasm_app_list/validate/publish` | 已实现（有判据） | `wasm-app-tools.ts:445/473/515`、注册于 `auth-gate.ts:2519` |
| 客户端发布表单（全部字段 + 校验） | 已实现 | `PublishForm.tsx:193-639` |
| 预检（不占版本号、不进审计） | 已实现 | `POST /apps/wasm/validate` |
| 诊断入口（人） | 已实现 | 应用中心行内按钮 |
| 诊断/自省入口（AI） | **未实现** | 工具面只有 3 个，无回读工具 |
| 表结构自省（API） | 已实现但**无入口** | `read.go:207-228`；客户端/管理端零消费者 |
| 行数据查看 | **不存在** | 全仓零出口（C 报告 §1.5，19 关键词 0 命中） |
| 应用日志回读 | **不存在** | `hostenv.go:53-63` 只写平台 stdout |
| 本地预览（假宿主） | 部分实现 | `preview.mjs` 正则解析 SQL + 每次调用全新内存库 |

### 2.3 管理面（webadmin）
| 能力 | 状态 | 关键证据 |
| --- | --- | --- |
| 应用列表（筛选/搜索/翻页/访问级别）、详情抽屉 | 已实现 | `Apps.tsx:473-500` |
| 审核队列 + 通过/拒绝（理由必填） | 已实现 | `admin.go:428-490`、`Apps.tsx:566-598` |
| 上架/下架/冻结/归属转移 | 已实现 | `router.go:199-203` |
| 打开计数（列表列 + 详情日/部门 + TOP N 看板） | 已实现 | `admin_opens.go`、`OpensBoard.tsx`、`opens-contract-parity.spec.ts` |
| 限制项控制台（档位/五笔账/需重启徽标/来源） | 已实现 | `Limits.tsx`、`GET|PUT /limits` |
| 运行时水位 | 已实现 | `GET /runtime` |
| 应用 AI 用量面板 | 部分实现 | 契约与四态渲染对，**数据源恒空**（§3 · P1-6） |
| 诊断（管理员排障） | 已实现 | `GET /wasm-apps/:app_id/diagnostics` |
| 删除 / 恢复 / 导出 | **未实现** | 只有员工面；全仓无反软删 |
| 应用库表结构/行数据 | **未实现** | 管理面连 `schema` 出口都没有 |
| 版本历史全量视图 / 回滚 | 部分 / 未实现 | UI 只取 pending+rejected；无回滚端点 |
| 应用日志 / 成功调用事件 | 未实现 | 无端点 |

### 2.4 运维面
| 能力 | 状态 | 关键证据 |
| --- | --- | --- |
| 内存档位（default/small/large + 启动自检 + 控制台可配 11 项） | 已实现 | `memprofile`、`applimits`、`docs/decisions/2026-09-19-wasm-platform-operations.md` |
| 模块缓存/库句柄淘汰（空闲逐出 + 事件逐出 + FreeOSMemory） | 已实现 | `appserver/modules.go`、`dbpool.go` |
| 调用事件清理调度器、打开计数清理 | 已实现 | `events/scheduler.go`、`opens/scheduler.go` |
| 编译隔离（`PICOAI_COMPILE_ISOLATION`） | 部分实现 | 代码侧 `require` 已真 fail-closed（`isolate_linux.go:221-223` + `wasmapp.go:241/253`），但**部署默认仍是 `auto`**（`docker-compose.yml:115`）；`/etc` 对编译进程整目录可读（`isolate_linux.go:42-44`） |
| 冻结保留期快照 / 到期真删 | **未实现** | `api/read.go:739-745` 自述 |
| 沙箱逃逸面 | 已判定不可逃逸（能力不存在级） | `temp/wasm-audit/WASM-SANDBOX-AUDIT.md` |

### 2.5 设计 F1–F16 状态总表
| F | 设计承诺 | 判定 |
| --- | --- | --- |
| F1 应用中心 | 搜索/我发布的/分页/三空态 | 已实现 |
| F2 打开应用 | 先开窗骨架屏 → 校验回来再加载 | **部分实现**（顺序倒置，P1-9） |
| F3 独立窗口 | 单窗口/记忆尺寸/**强制宽高比**/刷新返回 | **部分实现**（比例与首次尺寸未接线 P0-2；无刷新/返回 P1-8） |
| F4 应用内容 | 服务端执行后原样透传 | 已实现 |
| F5 身份 | 帧内 user（含 is_publisher） | 已实现（A 报告复核） |
| F6 分享 | 只有深链 + fail-closed | 已实现 |
| F7 AI 操作应用窗口 | browser_* 可达 + 控制权胶囊 | **未实现**（P0-1） |
| F8 会话过期 | 可读页 + 保留路径 + 重登继续 | **部分实现**（无重登动作/路径回填 P1-7） |
| F9 平台不可达 | 本地错误页 + 重试 | **部分实现**（无重试 P1-7） |
| F10 版本切换 | 每次打开校验版本 | 已实现（`changed` 分支已接线） |
| F11 静态资源缓存 | 按 app_id+version 缓存 + 命中直出 | **未实现**（只有失效半环 P1-3） |
| F12 外链与下载 | 内置浏览器新标签 + 提示条 + 下载反馈 | **部分实现**（一律 deny window.open；提示条零消费者） |
| F13 浏览器存储 | 可用性/隔离/生命周期 | **部分实现**（可用性 Linux 实测；清理未实现 P1-4；分区缺 server hash P2-9） |
| F14 管理端 | 列表/审核/上下架/冻结/归属 + 打开计数 | 部分实现（缺删除/恢复/导出/数据面） |
| F15 渠道白标 | 双 scheme 显式配置 + CI 硬校验 | 代码已实现；四渠道配置已核验（F 报告实跑判据 4/4 EXIT=0） |
| F16 打开校验与计数 | 每次打开校验 + 计数 + 运营视图 | 已实现 |

---

## 3. 未完成功能清单（按优先级）

> 编号是**全局流水号**（P0-x / P1-x / P2-x 连号；P1 从 4 起，因为前三条已并入 P0 组）。工作量 S/M/L 只是量级参考，不是排期承诺。

> 每条格式：**现状证据 → 缺什么 → 用户可见后果 → 工作量（S/M/L）**。工作量只是量级参考，不是排期承诺。

### P0-0 · 安全阻断项（必须先修，与功能无关）

**P0-0（唯一"零成本全站瘫痪"入口）`wasmmod` 段解析无界分配 → 单个请求杀死 API 进程**
- 证据：`server/internal/wasmapp/wasmmod/parse.go:421`（类型段）、`:475`（导入段）、`:558`（导出段）三处 `make([]T, 0, n)` 直接使用段内计数向量 `n`，**未与剩余载荷长度比对**（同批只补了内层 `np`/`nr` 两个计数：`:439`/`:454`）。可达链：`POST /api/client/v2/apps/wasm/validate`（**普通员工 Bearer**）→ `api/publish.go:174` → `compile.ValidateWasm` → `compile/staticvalidate.go:50` → `wasmmod.Validate`，注释明写"**不发子进程**"（`compiler.go:419`）⇒ 崩溃发生在 **API server 父进程**。
- A 报告已独立复现：构造的 15 字节模块（`00 61 73 6d 01 00 00 00 02 05 ff ff ff ff 0f`）触发
  `runtime: out of memory: cannot allocate 274877906944-byte block` → `fatal error: out of memory`，**exit 2**，`gin.Recovery` 抓不住、无错误信封、无审计。
- 修法：三处 `readU32` 后补 `if uint64(n) > uint64(len(payload)-used) { return malformedf(...) }`；补"计数向量与载荷一致性"门禁用例。
- 工作量：**S**（3 行 + 一组用例）。**这是发版前必修项。**
- 备注：该条 2026-09-18 沙箱审计已登记为 P0，**至今未修**（本次复核仍在）。

### P0 · 设计已冻结但接线缺失（改完即兑现，不需要新产品决策）

**P0-1 应用窗口未接入 browser runtime（F7 / 设计 §7.2）**
- 证据：`packages/host/browser/src/surface.ts:79/129`（`registerApp` 已实现、`kind:'app'` 已建模），但全仓调用点**只有测试**；`wasm-apps-host` 声明依赖 `@picoaide/dsh-browser` 却只 import `./guard`；`tools.ts:406-413` 把 `appSurfaces()` 映射成 `kind:'app'` 行 ⇒ 恒空。
- 缺：建窗/关窗/关闭全部三处调 `registerApp`/注销；把手柄 `webContents` 交给 browser pool 的 CDP 附着路径；控制权状态投影。
- 后果：AI 无法操作用户的应用窗口；`browser_list_tabs` 永不出 `kind:'app'`；控制权胶囊（"我来操作/交给 AI"）不存在。
- 工作量：**M**（接缝已存在）。

**P0-2 作者声明的窗口规格不生效（F3）**
- 证据：`wasm-apps-host/src/index.ts:460` 调 `windows.open(appId, path)` **缺第三参 ratio**；`windows.ts:480-491/515` 的 `declaredRatio` 因此恒 `undefined`（`remembered.ratio` 只在 `:521` 由它自己写入 ⇒ 环路自锁）；平台 `open` 响应（`api/open.go:191-196`）与宿主解析器（`open-gate.ts:126-137`）都**没有 window 字段**；客户端详情页却渲染"窗口比例：16:9"（`AppCenterPanel.tsx:1409-1420`）。
- 缺：三选一接线 —— ①`open` 响应加 `window`（服务端改）②客户端把目录行的 window 规格带进 `POST /api/pico/wasm-apps/open` body ③宿主单独拉一次目录。
- 后果：`picoaide.app.json` 里写的 `window.ratio/width/height` 全部无效（首次一律 1280×720），界面承诺与行为不一致。
- 工作量：**M**。

**P0-3 客户端静态资源缓存零效果（F11）**
- 证据：`index.ts:269` 构造 `WasmAppsCache`，全仓**只调 `clearApp`**（`:585`/`:625`）；`cache.ts` 的 `get/put/conditional/isStaticSubresource/clearAll/securityHeaders` 在 `cache.ts` 之外**零调用点**；`handler.ts` 无 cache 依赖；`APP_VERSION_HEADER` 只有对拍用例引用。`cache.spec.ts` 28 例全绿造成"缓存已实现"的假象。
- 后果：每次打开都把全部静态子资源重新拉一遍（弱网明显变慢）；F11 的性能承诺未兑现（安全性未受影响——因为根本没缓存）。
- 工作量：**M**（缓存本体与用例质量高，缺接线）。

**P0-4 带 DataCount 段的模块 100% 发不出去（工具链覆盖面被两个判据卡死）**
- 证据（D 报告用**真服务端 + 真编译**实测）：平台预检只接受"段 id 纯升序"（`wasmmod/parse.go:294-296`），而平台自己的运行时 wazero **只接受规范位置**（Element 之后、Code 之前；`wazero@v1.12.0/internal/wasm/binary/decoder.go:193-205`）。实测：规范位置 → `422 SECTION_MALFORMED`；改成升序 → 预检通过、**真编译器**回 `422 invalid section order` ⇒ **两条路都堵死，没有可利用的绕过**。受影响：TinyGo 默认产物、启用 bulk-memory 的 LLVM/Rust/Zig 配置。
- 修法：`parse.go:294-296` 加 DataCount 特例（`current==DataCount ⇒ previous<=Element`；`previous==DataCount ⇒ current>=Code`，与 wazero 同判）+ 一条"规范位置接受、乱序拒绝"的用例。
- 工作量：**S**（约 5 行）。**这是"官方支持语言"承诺能否成立的开关。**

**P0-5 `.debug_*` 段被当成应用资源发布（信息泄露 + 额度浪费）**
- 证据：`assets/assets.go:78-87` 的 `ToolchainSections` 不含 `.debug_*`，`IsLogicalAssetPath` 对其返回 true（`:124-140`）；D 报告实测 `.debug_info/.debug_line/.debug_abbrev` 全部进资源集，真服务端 validate 200 且出现在 `assets` 列表里。Rust `wasm32-wasip1` 默认产物 **2,083,074 B 自定义段（占模块 97.7%）全是 DWARF**，会作为可直出资源发布、吃掉 4 MiB 段额度的一半，并且**任何人可通过静态直出下载**。
- 修法：`ToolchainSections` 补前缀判定（`.debug_*`）+ 同步 `pack-assets.mjs:65-77` + 一条"只能靠前缀判定"的用例。
- 工作量：**S**。

**P0-6 导入白名单缺 `sock_recv`/`sock_send`（三条历史拦路点一个都没修）**
- 证据：`wasmmod/imports_gen.go:78-79` 只有 `sock_accept`/`sock_shutdown`；`imports_coverage_test.go:125-127` 是**故意收紧**到"三个 refapp 参考程序导入面的并集"，而 `references/imports.md` 却宣称白名单是"Go 运行时可能发出的全部导入的保守超集" ⇒ TinyGo 的 `net/url` 路径会被 `IMPORT_NOT_ALLOWED` 拒。
- 修法：改 `refapp` 参考程序后重跑 `go run ./cmd/picoaide-wasm-imports-gen`（白名单是生成物），并同步 coverage 测试口径；文档口径同时修正。
- 工作量：**S**。
- **三条（P0-4/P0-5/P0-6）合起来意味着："官方支持 Go、Rust/Zig 可用但不承诺"这句话今天只在"不用 DataCount + 不带 DWARF + 不碰 net/url"的窄路径上成立。**

### P1 · 承诺断链 / 作者闭环断裂 / 隐私与隔离

**P1-4 诊断与日志的两处承诺断链（作者面）**
- 证据①：`db_rows`/`db_bytes` 在 `serve.go:448-450` 采集、`0069_wasm_apps.sql:114-115` 落库，但 `diag.go:95-96`/`:139-140` 两条 SQL **都没 select** ⇒ 只写不读；而 `references/diagnostics.md:11` 已向作者承诺"数据库读写行数与字节"。
- 证据②：应用 `log` 的"7 天保留"（`diagnostics.md:10`）**未实现** —— 只经 `hostenv.go:53-63` 写服务端 stdout，全仓无应用日志表、无端点、无保留期。
- 后果：作者无法回答"这次请求到底写了几行""应用自己打的日志在哪"。
- 工作量：把两个字段接进诊断 = **S**；日志落库 + 端点 + 保留期 = **M**。

**P1-5 客户端 UI 的应用 AI 面板聊天不可达（设计 §21.7⑦）**
- 证据：`AppAiPanel` 渲染在客户端页面源（`AppCenterPanel.tsx:1482`），打 `/__picoaide/ai/chat`（`app-ai.ts:44/273`），该路径全仓只有协议 handler（`handler.ts:201/210`）；宿主本机 HTTP 面只有 `/api/pico/wasm-apps` 一个前缀。
- 后果：详情页 AI 面板点"发送"必失败，用户以为"应用 AI 坏了"。
- 工作量：**S–M**（二选一需拍板：补本机 HTTP 路由 / 面板改做授权与说明）。

**P1-6 应用维度 AI 用量恒不出数（设计 §21.4 / §21.7⑤）**
- 证据：`app_attribution.go:36/42-47` 只读 `X-Pico-App-Id`；全仓**无任何客户端/宿主发送方**（grep 仅命中注释与 webadmin 文案）；`wasm_app_opens_summary.go:317` 自述"尚未被客户端发送"。
- 后果：管理端"应用 AI 用量"恒显示"统计尚未上线"，"这个应用吃掉多少 AI 成本"答不出来。替代路径（按隐藏会话 id `app:` 前缀派生）**未实施**。
- 工作量：**M**（服务端按前缀派生 + 防伪造判据 + 前端去降级）。

**P1-7 软闸门/错误页的"出路"未接线（F8/F9）**
- 证据：宿主给出 `warning='version-unverified'`（`index.ts:631/655`）而客户端**零解析**；文案 `versionUnverifiedBanner`/`retryAction`/`signInAgainAction`（`app-window-copy.ts:67-83`）零消费者；会话过期页无动作、无路径回填（`pages.ts:112-119`）；平台不可达页无重试（`handler.ts:328-342`）。
- 后果：服务端不可达时静默显示旧内容；令牌过期只能自己回主窗口重登再找应用；网络抖动只能关窗重开。
- 工作量：**S–M**。

**P1-8 应用窗口无刷新/返回（F3）**
- 证据：`electron-adapter.ts:502-542` 只建原生 `BrowserWindow`，全包无 `reload()`/`goBack()` 调用点。
- 后果：页面卡住只能关窗重开（丢应用内 state + 多一次 open 闸门）。
- 工作量：**S–M**（`setAspectRatio` 的 `extraSize` 已为自绘 chrome 预留）。

**P1-9 打开顺序与骨架屏（F2 / §19 Q12）**
- 证据：`index.ts:569` 先 `await openGate.check(...)`（预算 30 s）再 `:633 requestOpen`；骨架屏文案 `loadingSkeletonTitle` 零消费者。
- 后果：首次打开/服务端慢时**最长 30 秒屏幕上没有任何窗口**；不可达时"什么都没发生"（回 502，不建窗）。
- 工作量：**M**（需要与"新建=硬闸门"的口径对齐）。

**P1-10 F13 浏览器存储清理未实现 + 分区缺服务端哈希**
- 证据①：设计 `design.md:72` 明写"下架/冻结/删除时同批清浏览器存储"，实测 `grep clearStorageData|clearCache|session.clear` 在 `wasm-apps-host/src` **0 命中**，而分区是 `persist:` ⇒ 应用 origin 的 localStorage/IndexedDB 留盘。
- 证据②：`partition.ts:47-49` 的分区名是 `persist:agent-browser-<user>`，**缺 `@<server-hash>`**（设计 §7.2 冻结），而 `sessionScope()` 在缓存侧已按 server hash 区分 ⇒ **同一台机器切换服务端地址时，新旧租户共用同一个持久分区**（本仓部署拓扑里测试/正式并存，真实可触发）。
- 后果：下架/删除后重新发布同名应用能读回"上一世"存储；换环境时跨租户串味（cookie/localStorage/IndexedDB）。
- 工作量：清理 **S**；分区加 hash **S**（必须与 browser 泳道同批改，否则窗口空白）。

**P1-11 F12 外链与下载的 UX 半边未接线**
- 证据：`electron-adapter.ts:593-597` 一律 deny `window.open`，没有"改开内置浏览器新标签"；`externalLinkNotice`（`app-window-copy.ts:18`）、`downloadStartedNotice`（`:27`）零消费者。
- 后果：应用里的 http(s) 外链点了没反应（或被拒），用户不知道为什么；下载无任何反馈。
- 工作量：**S–M**。

**P1-12 管理端缺删除/恢复/导出 + 无任何反软删实现**
- 证据：删除只在员工面（`router.go:137` → `release.go:191`）、导出只在员工面（`router.go:136`）；管理面（`router.go:198-240`）无这两条；全仓 `Restore|Undelete|deleted_at = NULL` **零命中**；`Apps.tsx:1250-1259` 对已删除行仍渲染一个必得 404 的"解冻"按钮。
- 后果：管理员无法在控制台完成"退役→保留→处置"闭环，也看不到应用数据规模；误删无法恢复（只能靠 DBA/运维）。
- 工作量：**S**（复用既有 store 函数）+ 恢复语义需拍板。

**P1-13 应用库可观测性：三处该补的小事（不含行数据这一新产品能力）**
- ①`schema` 端点补客户端入口（宿主白名单已支持 `wasm-apps.ts:1642`，客户端只做 4 个后缀）——**S**；
- ②`db_rows`/`db_bytes` 进诊断失败记录（同 P1-4）——**S**；
- ③本地 `preview.mjs` 换成真 SQLite（Node 22+ 自带 `node:sqlite`）——**M**；同时补上它缺失的四条**宿主规则**：限额、鉴权形态、事务闸门、`/api` 保留前缀（D 报告实测：本地假宿主 = 内存桩 + 三个正则 SQL + 零限额零鉴权 + 不挡 `/api`，是"本地绿、线上红"的系统性来源，46 行差异表在 `C-preview.md` §4）。
- 后果：作者能在"结构/写入量/本地语义/本地规则一致性"四个层面自证；行数据仍缺（见 §5）。

**P1-14 R37 的「定期快照 + 保留期后真删」没有执行者（数据生命周期承诺落空）**
- 证据：`api/release.go:25`、`:228`、`api/read.go:740`、`:744` 四处**代码自述"当前未实现"**；`limits.RetirementSnapshotRetentionDays=90`（`limits/limits.go:402`）只被用于展示。
- 缺：①按 `deleted_at/frozen_at + 90d` 扫描并真删（版本制品 + 应用库 + 可选快照）的调度器；②`VACUUM INTO` 快照任务；③删除计数进 `/readyz` 或 `adminRuntime`。仓库已有三个同款调度器可抄（`cmd/server/wasmapp.go:203-211` events、`:408-410` upload、`:414-415` opens）。
- 后果：软删应用的制品与应用库**永久占盘**；对客户的"保留 90 天后彻底删除"是**合规级空承诺**；导出体还告诉读者"快照由后台任务执行"。
- 工作量：**M**（需先拍"真删是否留快照、留多久"）。

**P1-15 打开计数的部门维度口径错（会给出错误结论）**
- 证据：设计 §8.9 要求"按部门树向上汇总"，`serverstore/wasm_app_opens.go:265-268` 只 `GROUP BY dept_id`（不上卷）；`:281-282` 把各部门 UV 直接相加（同一天换部门者被重复计）⇒ total UV 可能大于真实去重人数。
- 后果：管理员看到"上级部门打开量偏低""总 UV 比明细人数多"这类自相矛盾数字。仓库已有部门树口径可复用（`UserEffectiveGroups`）。
- 工作量：**S/M**。

### P2 · 生命周期、健壮性与纪律

| # | 条目 | 证据 | 后果 | 量 |
| --- | --- | --- | --- | --- |
| P2-14 | 无版本回滚 | 生效版本恒 = `LatestApprovedWasmReleaseMeta`（`admin.go:640-686`）；发布要求版本号严格递增 | 线上出问题只能"发一个旧内容的新版本"，且版本号被永久占用 | M |
| P2-15 | 签名密钥无法轮换 / 技能目录无法热加载 | `appproof.KeyRing.Rotate`（`appproof/appproof.go:299`）与 `skillseed.Catalog.Reload`（`skillseed/skillseed.go:279`）全仓零调用（无路由/无 CLI）；两者注释都写"由运维调用" | 密钥或技能要换只能停服换文件 | S |
| P2-16 | 管理端诊断面板无形状守卫 | `Apps.tsx:619-622` 直塞 state，渲染期裸解引用 `diag.summary.*`（`:1754/1758/1774`）；同页 opens/AI 都走 `require*` | 服务端少发一个字段 ⇒ 整页被 ErrorBoundary 兜成"页面出错了" | S |
| P2-17 | 「更新审批」开关在列表读取失败时仍可用假初值写 | `Apps.tsx:358/503/512-521/869-887`；对照 `Limits.tsx:459-482` 是正确范式 | 首屏失败时显示"关闭：更新即生效"这一未读取的断言，点一下就提交 | S |
| P2-18 | 契约漂移三处 | 前端读了服务端不发的 `OpensDetail.pv/uv`、`OpensPoint.dept_name`（`opens-contract.ts:113/198-200`）；`runtime` 响应零跨端对拍且夹具仍含已删除的 `anon_limit`（`AppPlatform.test.tsx:84`） | 死分支/死字段让"契约"看起来有两套键；Go 改键名不会红 | S |
| P2-19 | 模块缓存/库句柄水位无出口 | `api/admin.go:1302-1315` 自己列出 `module_cache`/`appdb_handles` 不可用；数据源已存在（`appserver/dbpool.go:541`、`:166`），缺 `ModuleCacheStats()`/`AppDBPoolStats()` 与注入 | 平台内存的主要账（≈7×wasm 字节/应用）在控制台看不见 | M |
| P2-20 | 死导出清单（客户端 10 项 + 服务端 ~29 组） | 客户端见 B 报告 §2 P3-12；服务端见 A 报告 G6（含 `readyz`/`memprofile`/`queue`/`events` 的一批只被测试引用的导出） | 读者以为能力存在；口径重复实现会漂（如 `applimits.NeedsRestart` vs `appserver/limits_apply.go:65-68`） | S |
| P2-21 | 文档与代码漂移（作者面 22 条 + 反向漂移 3 条 + 服务端 API 参考缺 4 条端点） | 作者面见 §4.2；**反向漂移最高一条是"模型可见"的**：`wasm-app-tools.ts:209` 的应用地址参数说明仍写 `https://<app_id>.<企业域名>`，而应用子域已随 W4 删除、作者文档全线否认这种地址 ⇒ 模型可能给用户编一个不存在的链接。服务端 `server/docs/03-api-reference.md` **未记录** `catalog`/`schema`/`diagnostics`/`export` 四条端点（grep 零命中）。其余：`api/read.go:730-733` 仍写"资源抽到磁盘目录"、W4-12 三文件七行指向已删除包 | 作者与模型都按文档/描述排障会被带偏 | S |
| P2-22 | `db.query`/`db.exec` 超限"只置 `truncated` 不报错"是**有意偏离**但未同步文档 | `appdb/stmt.go:70-83`/`:100-103` 注释自述（设计原文是"超出即截断并报错"）；`abi.QueryResult.Truncated` 可见 | 应用若忽略该标志会**静默拿到不完整结果**（5000 行 / 8 MiB 处断） | S（改文档）/ M（改行为） |
| P2-23 | `catalog` 无服务端分页/搜索 | `api/read.go:440` `ListWasmApps(filter{})` 后逐行投影，无 `limit/offset/q`（管理面同类接口有：`api/admin.go:117-142`） | 大组织下这条响应无界（客户端虽有分页，但整表仍要一次拉回） | S/M |
| P2-24 | 执行侧无第二道 OS 隔离（与 API server 同进程、数据根 rw） | `appserver/options.go:189`、`serve.go:426`；`runtime/*.go` 无 `os/exec`/bwrap | wazero 逃逸 = server 进程（持 master key/PG DSN/全部应用库）沦陷 | M/L |
| P2-25 | 编译缓存"只有编译进程写"未强制 | `MkdirAll(0700)` 只在新建生效（`compile/compiler.go:344` 无 Stat+Chmod 兜底，同包 appdb/upload 都有）；`VerifyCacheEntry` 恒 nil 且零调用点；**执行侧 `wazero.NewCompilationCacheWithDir` 事实上是写者**（`runtime/config.go:150-155`） | 编译缓存投毒面 | M |
| P2-26 | 编译隔离的部署面与 `/etc` 暴露 | `PICOAI_COMPILE_ISOLATION` 默认 `auto`（`docker-compose.yml:115`、`.env.example:68` 是注释掉的 require）；`--ro-bind-try /etc` 让整个 `/etc` 对编译进程可读（`isolate_linux.go:42-44/291-293`） | 生产未强制隔离；改 argv 形状需同步 `isolate_linux_test.go` | S/M |
| P2-27 | 日志行伪造 / 1xx 放行 / `/readyz` 未认证水位 / **content-type 隐式嗅探** | `logbuf.go:42-63` 与 `hostenv.go:54-60` 均不剥 `\r\n`；`respond.go:52-55` 放行 100–199；`main.go:674` 无条件注册 `/readyz` 且暴露内存/队列/缓存/丢包水位；非白名单 content-type 在 `edge/primitives.go:296-301` 是 **delete**（不是改写）⇒ 由 Go 标准库隐式嗅探接管（`static.go:135-136` 注释自认） | 日志欺骗；协议面小缺陷；运维面暴露（无凭据）；内容类型可被字节内容左右 | S |
| P2-28 | 内存账与实测 RSS 无对拍判据；`start` 段死循环错误码无夹具 | `readyz.go:225-228` 五项账本 + `reclaim.go` 已有回收，但无"模型 vs 实测"断言；`runtime/errors.go:289-312` 分类依赖 wazero 错误串，测试只有函数体内死循环 | 账本口径已修，缺机器判据；错误码分类需夹具才能定 | S/M |

### P3 · 需拍板后才算"缺口"的产品空白
- **应用库行数据查看**（§5 专项）。
- **设计里写过、但从未实现的宿主原语**（A 报告 §1 核准：宿主能力面 = `abi.HostMethods` 8 方法 + `abi.ping` 的封闭表）：**出站 HTTP/网络、定时/cron、跨应用调用、`assets` 写、bulk/分页原语**。它们不是"接线漏了"而是**从未实现**；要不要做是产品决策（注意：出站网络与沙箱"不可逃逸"结论直接冲突，若做必须重新论证）。
- **站内公告**（管理端只有复制模板，无触达通道：`announcements.ts` 纯前端）。
- **应用级 AI 配额/熔断**（设计自认 F-45 未做；现行=用使用者余额 + 网关限流）。
- **管理端查看应用数据/日志**（合规与隐私决策）。
- **应用窗口的"关于/清除本应用数据"入口**（B 报告建议 1/2）。
- **应用中心"最近打开失败"汇总**（员工侧第一手判据）。

### 3.5 需要补充的功能（建议清单，按价值排序）
1. **AI 作者的诊断与自省工具**（`wasm_app_diagnostics` / `wasm_app_schema`）—— 今天 AI 只有"写"没有"看"，而它是本产品的主要作者；这是投入产出比最高的一项（复用既有端点，S/M）。
2. **应用日志回读**（落库/环形缓冲 + 端点 + 面板 + 保留期）—— 闭合 `diagnostics.md` 已写下的承诺；也是"应用静默失败"类问题的唯一抓手（M）。
3. **应用数据只读面**（§5；需拍板）。
4. **本地真 SQLite 预览**（`preview.mjs --data-dir/--dump-tables`）—— 让作者在开发期就能验 SQL 语义，成本最低、风险为零（S）。
5. **管理端删除/恢复/导出**（复用既有 store 函数；恢复语义需拍板）（S）。
6. **冻结保留期：定期快照 + 到期真删**（调度器 + `VACUUM INTO` + 计数进 readyz）（M）。
7. **应用窗口最小 chrome**：刷新 / 返回 / "关于本应用" / "清除本应用数据"（S–M）。
8. **员工侧"最近打不开的应用"汇总**（把 `OpenFailureReason` 落到本地并展示）（S）。
9. **版本回滚**（新端点 + 审计 + 与永久占号的语义定义）（M）；**灰度/按人放量**（需要把版本选择维度接进 `appserver` 的版本解析 + 缓存键变更，L）。
10. **看到真实请求的输入**：`wasm_call_events` 加"请求指纹"列（path + query 形态 + body 长度/hash，**不存明文 body**，配采样与脱敏）—— 今天只能看 `reason_code` 计数，无法知道"用户点了什么才炸"（M）。
11. **把线上诊断/数据拉到本地**：诊断导出为本地 JSON 文件 + 应用库快照导出（作者本人 + 审计 + 体积上限）（M）。
12. **更可用的错误与性能证据**：`stderr_tail` 结构化（panic 首行 + 栈顶 N 帧，而不是纯截尾 2 KiB）；`host_call_ms` 拆成 AI/DB/assets 分项；函数级 CPU/内存剖析（S/M、S、L）。
13. **三平台协议/存储探针补测 + 把 `check:wasm-client-only` 从 advisory 转阻塞**（H3/H4；需要真机与 CI 变更）（M）。
14. **应用模板/脚手架生成器**（把 `examples/go` 扩成多形态模板：列表+详情、表单+校验、名单准入、AI 调用；`scaffold.mjs --name X`）（M，模板市场长期）。
15. **官网补应用作者文档**（`site/` 今天只有部署页提到 wasm）（S）。
16. **应用 AI 用量归因接线**（P1-6；前端面板与契约已就绪，只缺数据源）。

---

## 4. 服务端、工具链与未闭环项的缺口（A/D/F 三报告已并入）

### 4.1 服务端（A 报告结论）
- **端点面**：客户端面 18 条 + 管理面 16 条（共 34 条）路由**全部有真实实现**，无 501/占位分支；请求管线（`appserver.serveApp` 十步）、身份注入（无匿名面）、跨源写校验、持有性证明（签发 + `request`/`open` 共用 `requireProof`）、宿主能力面（8 方法封闭表 + 唯一真表）、应用库加固、发布链（预检真编译 + 干跑 → 落库 → 投影 → 审计 → 版本 GC）、版本号永久占位、审核开关、上下架/冻结/删除、归属转移、缓存与句柄回收、水位闸门（`AllowPublish` 接进 publish **与** validate）、打开计数（同天同源 + UV 真去重 + `uv<=pv` 不变量）、调用事件与诊断、分片上传、演示/技能播种、渠道 scheme fail-loud、**W4 删除波次（`session`/`anonlimit`/`aichat` 整包、`edge` 主机门控、基域配置面、`ai.chat` 能力面）已删净** —— 均有判据。
- **缺口**：P0-0（OOM）、P1-6（归因不出数 + 可伪造）、P1-14（快照/真删）、P1-15（部门上卷/UV）、P2-19/20/22/23，以及 G6 的死接线清单（签名密钥轮换、技能热加载、模块缓存水位、`VerifyCacheEntry` 恒 nil、`registry.KindWasmApp` 与 `serverstore.AppKindWasmApp` 两份字面量等）。
- **沙箱审计遗留（本次未复现，登记未修）**：编译缓存写者未强制（`compile/doc.go:88-112`，`VerifyCacheEntry` 恒 nil、`cacheDirIsTrustBoundary` 只 warning）、执行侧无第二道 OS 隔离、`/readyz` 无鉴权水位、应用日志未剥离 `\r\n` 可伪造宿主日志行、1xx 状态码放行、content-type 白名单可被 Go 嗅探绕过。

### 4.2 作者工具链与文档（D 报告部分并入）
**文档漂移实测（`D-docs-drift.md`：逐条对拍 94 条断言 = 66 条一致 + P0×1 + P1×9 + P2×12 + 6 条无法验证；另 3 条反向漂移）**
- 客观校验：`picoaide-limits-gen -check` EXIT=0（97 条目）、`picoaide-wasm-imports-gen -check` EXIT=0（34 条并集）⇒ 生成物类文档 100% 与代码规格表同源；**漂移出在"规格表本身与运行行为不一致"**。
- **P0-1（文档承诺不存在的能力）**：`references/publishing.md:171` 写"冻结 = 只读快照（保留 90 天）→ 可导出 → 真删并审计"，而快照与真删两个后台任务**都不存在**（同 P1-14）⇒ 作者/AI 会把"删除"当合规手段告诉用户，实际制品与应用库无限期保留。
- **P1 代表项**：①`FORBIDDEN/403` 被写成"不是发布者或已冻结"，实际非发布者是 **404 同形**、冻结是独立码 `APP_FROZEN`（`release.go:64`、`publish.go:736`）；②`DB_LIMIT/507` 被写成"返回超行数"，实际**只置 `truncated` 不报错**（`appdb/stmt.go:70-82`），而同文档 `:140` 又是对的；③`limits.md` 的 `sql_max_rows` 说明源于 `limitsspec.go:109` 的错误文案；④`window.width/height` 在生成物里类型写 `string`，代码只收 JSON 数字（`appcfg.go:614-625`），两份作者文档给出相反类型；⑤`window_fields` 引用不存在的 `max`（真实区间 320–7680 硬编码在 `appcfg.go:102-103`）；⑥`Cache-Control`/`X-Content-Type-Options` 被列为"应用可设置"，实际是宿主独占（`respond.go:20-32`）会静默丢弃；⑦诊断响应结构缺 `{"diagnostics":{summary,failures,hints}}` 骨架；⑧`evidence` 字段（`RUNTIME_MEMORY` 误判排查的唯一依据）未写进文档；⑨`window.ratio` 类型不准确（字符串 `"1.5"` 被拒）。
- **P2 代表项**：分片阈值实为"base64 长度 > 8 MiB"≈**6 MiB 产物**（`wasm-apps.ts:1002`）；`app_ai_unavailable` 还有 **502**；`NAME_TAKEN` 的"同名不同人是不同应用"方向相反（实际永久占有）；§7.1 补充码表缺 `APP_FROZEN`/`VALIDATE_FAILED`/`SECTION_OVERSIZE`；工具 deadline 是 **120 s**（90 s 是出站预算）；`wasm_app_publish` 把 `title` 设成恒必填（HTTP 契约是仅首版必填）。
- **TinyGo 支持面（三条拦路点全部仍在，见 P0-4/P0-5/P0-6）**：DataCount 段位置判据与 wazero 互斥、`.debug_*` 被当资源、白名单缺 `sock_recv`/`sock_send`。文档未提示这三点，而 `SKILL.md:40` 把 TinyGo 归类为"官方支持的 Go"。
- **主干链路实测可用（D 起了真服务端 + 真 PG 跑了一遍）**：脚手架 `cp -a examples/go` → `go build`（18.6s）→ `pack-assets` → `preview` → `validate 200` → `publish 201` → 迭代 `1.0.1 201` → 同号重发 `400 VERSION_NOT_NEWER` → 诊断 200 → 版本历史 200。Zig 产物预检 ACCEPT；Rust 产物静态预检通过（拦路点是 `.debug_*`）。
- **本地假宿主保真度（`C-preview.md` 46 行差异表）**：`preview.mjs` 是**内存桩**（实测 POST 后另起进程 GET 为空 ⇒ 作者看不到自己写进去的数据）、SQL 只有三个正则形状（无 DELETE/JOIN/聚合/WHERE）、**零限额零鉴权无事务闸门**、**没实现 `/api` 保留前缀**（`:132-138` ↔ `appserver/static.go:260-263`）；"先打包"守卫对 Go 产物失效（`go:buildid` 不在 `:48-51` 的名单里）。
- **"发出去之后"基本为空**：AI 工具面已接通（旧"0 调用方"判定作废，115 用例绿），但只有 list/validate/publish —— **无诊断、无下架、无删除、无回滚**；诊断不记录请求输入（`events.go:332-335` 的 16 列无 path/query/body）；`export` 明确不含使用者数据。**另一个安全观察（G17）**：本机 `/api/pico/apps/wasm/*` 的 GET 面**不是安全边界** —— `guard` 只查 loopback + 一个"纯标记"头（`auth-gate.ts:1312-1316` 与 `loopback.ts:66-72` 自述"a curl with a forged Origin passes this too"），只有写面才要持有性证明。
- **官网无应用作者文档**（`site/src/content/docs/` 只有 8 篇部署页提到 wasm）—— 对外交付面缺"怎么写应用"这一层。

### 4.3 已登记未闭环项核验（F 报告：逐条回代码验；**仍开 21 / 部分闭合 8 / 已闭合 40+（含 4 条因 W4 作废）/ 与原判不一致 14 处**）
**已闭合（判据可打破）—— 注意其中多条在台账里仍写着"未做"**
- **W4 删除波次**：`session`/`anonlimit`/`aichat` 整包、`edge` 主机门控、子域换票链、`ai.chat` 能力面已删净；`node scripts/wasm/check-old-model-residue.mjs` 实跑 `PASS`（A=0；B=34≤34；ANN=64≤65；C=472；D=5）。⇒ **依赖子域/匿名面/Cookie 的三条老 P2（Cookie 遮蔽、匿名令牌桶、"应用级 AI 熔断"）整体作废**。
- **W4-12 已闭合**（台账记"未做"）：三个文档文件已加"对象已删除"横幅 + 就地标注；实跑 `go build ./internal/wasmapp/session/` → directory not found 佐证。
- **§T 的 L2 认账 ②④已闭合**：真实窗口适配器（`electron-adapter.ts:445 createRealElectronWindowAdapter` + `main.ts:389` provide）与 AI runner（`app-ai-runner.ts:378-382` + 真实 Context 判据）都已接线。
- **`TestServe_ResponseFrameTooLarge` 长期失败已闭合**：实跑 `-count=3` → 3/3 PASS，判据未被削弱（仍断言 `RUNTIME_OUTPUT_OVERRUN` + 单帧上限 + `elapsed<=budget`）。
- **H1 已闭合**：四个渠道的 `desktop.app_origin_scheme` 均已配置并有判据（实跑 4/4 EXIT=0）。**但台账 §H1 给的判据命令不完整**——只设 `GITHUB_REF_NAME` 会静默退化成 official-only，必须 `GITHUB_REF=refs/tags/…` 与 `GITHUB_REF_NAME=…` 同时给。
- **§22.2 四条本机 API 冻结条款 + §22.3 五项迁移就绪**、**clientchain P0-1/P1/P2**、**audit-f1f4 三项必修**、**W0-D 存储探针（已入库、Linux 15/15）**、**appdb 深层加固（四层 + ATTACH 金丝雀 + `DeniedStatementKinds` 含 PRAGMA）**、**§22.2 本机 API 冻结** —— 均闭合。
- 另外两条"与原判不一致"的更正：**A9 从"无法判定"改判已闭合**（实跑 2 PASS：预算分支先于错误分类 ⇒ start/纯 wasm 死循环报 `RUNTIME_TIMEOUT`）；**台账自相矛盾**一处（§AB 记某两栈未升级 vs §AH 记三环境已升）。

**仍开（按严重度）**
| # | 条目 | 证据 | 影响 |
| --- | --- | --- | --- |
| F-1 | **P0-0 的 OOM 未修**（且**不在任何"未闭环"清单里** —— 属登记覆盖缺口） | `parse.go:421/475/558-559`；`Import`=64 B ⇒ `0xFFFFFFFF×64 B = 256 GiB`；`grep MaxUint32/0xFFFFFFFF wasmmod/*_test.go` 零命中 | 见 P0-0 |
| F-2 | 应用维度归因**不只是"不出数"，还真能伪造**，且**前端契约文档反向声明"伪造头会被忽略 + warn"**（该服务端校验不存在） | `app_attribution.go:42-47`；`opens-contract.ts:57`、`admin_opens.go:216` | 归因数据可被任意 bearer 污染；文档声称已有防护 |
| F-3 | 执行侧无第二道 OS 隔离（与 API server 同进程、数据根 rw） | `appserver/options.go:189`、`serve.go:426`；`runtime/*.go` 无 `os/exec`/bwrap | wazero 逃逸 = server 进程（持 master key/PG DSN/全部应用库）沦陷 |
| F-4 | 编译缓存"只有编译进程写"纯属约定 | 无权限位/独立 uid/只读挂载；`MkdirAll(0700)` 只在新建生效（`compiler.go:344` 无 Stat+Chmod 兜底，同包 appdb/upload 都有）；`VerifyCacheEntry` 恒 nil 且**零调用点**；**执行侧 `wazero.NewCompilationCacheWithDir` 事实上是写者**（`runtime/config.go:150-155`） | 缓存投毒面 |
| F-5 | `--ro-bind-try /etc` 让整个 `/etc` 对编译进程可读 | `compile/isolate_linux.go:42-44`、`:291-293` | 隔离面；修法会改 argv 形状，需同步 argv 断言 |
| F-6 | 应用日志可伪造宿主日志行（`logbuf` 入口不剥 `\r\n`、`flushAppLogs` 出口也不剥） | `logbuf/logbuf.go:42-63`、`hostenv.go:54-60`；`grep ReplaceAll/ContainsAny` 零命中 | 日志欺骗/污染 |
| F-7 | 1xx 状态码放行 | `respond.go:52-55`（`status<100 \|\| >599` ⇒ OK） | 协议面小缺陷，修法 1 行 |
| F-8 | `/readyz` 无鉴权且暴露内部水位（内存档位/队列深度/缓存字节/事件丢包…） | `cmd/server/main.go:674`；`readyz.go:217-250` | 暴露面（无凭据），是否收敛到运维网段是产品口径 |
| F-9 | `PICOAI_COMPILE_ISOLATION` 生产默认仍是 `auto` | `docker-compose.yml:115`、`.env.example:68` 是注释掉的 `require`、`AI-DEPLOY.md` 零命中 | 部署面未落地（代码侧 require 已真 fail-closed） |
| F-10 | 内存账与实测 RSS 无对拍判据（账本已扩到 5 项 + 有回收机制） | `readyz.go:225-228`、`appserver/reclaim.go` | **部分闭合**：口径已修，缺机器判据 |
| F-11 | `start` 段死循环的错误码分类无法静态判定且无夹具 | `runtime/errors.go:289-312`；测试只有函数体内死循环 | 需 start 段夹具 + 期望码断言 |
| F-12 | 三平台协议/存储探针与 `PROBE-RESULTS.md` 仍缺；`check:wasm-client-only` 仍 advisory | 探针在库但 Win/macOS 未跑；CI 未接 | = H3/H4 |
| F-13 | **content-type 仍可被 Go 隐式嗅探**（F 报告自我纠正：初判"已闭合"是错的） | 非白名单 CT 在 `edge/primitives.go:296-301` 是 **delete**（不是改写），`appserver/respond.go:42-71` 不设默认 CT ⇒ 落到 Go 标准库隐式嗅探（`static.go:135-136` 注释自认"否则宁可不写（由 Go 嗅探）"） | 内容类型可被字节内容左右；**教训：搜符号 ≠ 搜能力** |
| F-14 | 渠道仓 `ci-channels.sh:98` 仍 `git clone --depth 1` 不 pin commit（H2 仍开） | 同一源码 tag 可产出配置不同的客户端（2026-09-12 已因此出过数据根漂移事故） | 构建可复现性 |

**作废（因 W4 删除整体不适用）**：子域 Cookie 遮蔽主站、全局匿名令牌桶跨租户、`ai.chat` 应用级熔断、浏览器 cookie 排序 —— 四条的对象（子域/匿名面/换票链/服务端 AI 通道）都已不存在。

**认账（成立，非缺陷）**：下载行为不在验证范围、`window.ratio` 多显示器口径、审计明细不含应用请求、跨渠道深链不工作、应用 AI 无工具≠无风险、服务端 wasm 已无 AI 能力（迁移面已改写）。

---

## 5. 专项：作者为什么看不到自己的 SQL 数据（用户点名项）

### 5.1 现状：三样看得到，三样看不到
| 看得到 | 端点/入口 | 内容 |
| --- | --- | --- |
| 表结构 + 行数 + 占用 | `GET …/wasm/:app_id/schema`（**无 UI 入口**） | 表名/列名/类型/not_null/pk/每表行数/库体积/页数/上限/使用率 |
| 控制面元数据 | `GET …/wasm/:app_id/export` | 应用与版本元数据；`database.included=false`（明确不含使用者数据） |
| 失败码 + hints + stderr 尾巴 | `GET …/wasm/:app_id/diagnostics`（客户端有面板） | 失败/被杀记录、reason_code、hints、峰值 CPU/内存 |

| 看不到 | 证据 |
| --- | --- |
| **行内容（row values）** | 全仓零出口（C 报告：19 关键词 0 命中 + `appdb.Query` 无 API 调用点） |
| **应用自己的日志（`log`）** | 只写服务端 stdout，无表无端点（`hostenv.go:53-63`） |
| **行级写入量** | `db_rows/db_bytes` 只写不读（`diag.go:95-96/139-140` 没 select） |

### 5.2 今天怎么临时看到数据（都不应作为长期方案）
1. **运维侧直连文件**：应用库是宿主盘上的普通 SQLite 文件 `<data_root>/apps/<app_id>/app.db`（`appdb/appdb.go:290-298`），运维可在服务端主机上用 `sqlite3` 打开；**必须只读或先 `VACUUM INTO` 出快照**（WAL 模式下直接开可能看到未检查点的状态，且写锁会影响线上）。
2. **让应用自己 `log`**：把关键值打进日志，再去服务端主机看平台 stdout（`wasm-app[<app_id>] …`）——需要运维权限，且无保留期、无检索。
3. **发一版 debug 页**：作者自己写一个只读页并打开看 —— 要发版、要占版本号、应用坏时正好用不了，且会把调试面暴露给所有使用者（除非用 `access=whitelist` 只放自己）。
4. **诊断面板**：只能看失败码与 hints，回答不了"库里有什么"。

### 5.3 为什么这是问题（作者闭环断在三处）
1. **开发期**：本地假宿主用正则解析 SQL + 每次调用全新内存库 ⇒ 真实 SQL 语义（类型/约束/LIKE/聚合/错误）无法验证。
2. **发布后**：作者（AI）没有任何回读工具 ⇒ 发布完就"盲了"；技能文档却要求"先读诊断，再改代码"。
3. **线上排障**：员工报"数据不对"，作者无法回答"库里到底有什么"，只能改代码发一版 dump 页。

### 5.4 任何方案都必须遵守的硬约束（逐条已取证）
- **语句面**：`appdb/sqlgate.go` 只允许单语句、种类白名单（SELECT/INSERT/UPDATE/DELETE）、拒 DDL/PRAGMA/ATTACH/WITH、拒保留列 `_row_id` 及其别名、拒 `sqlite_`/`pragma_` 标识符。
- **连接面**：只读连接 `mode=ro + query_only`、全套 `SQLITE_LIMIT_*`、`max_page_count`（100 MB 库上限）、WAL；`api/read.go:230-237` 已给出"平台读自己的文件"这一先例与其理由。
- **限额**：单条 SQL ≤ 64 KiB、单语句 5 s、单次查询 ≤ 5000 行 / 8 MiB、单值 ≤ 1 MiB。
- **鉴权**：`ownedApp`（发布者本人 + 超管；非发布者 **404 与"不存在"同形**，不泄露存在性）。
- **审计的两分法**（本次必须遵守）：应用请求 = 不写 `audit_logs`（只落 `wasm_call_events`）；**作者控制面动作 = 写审计**（已有先例：`wasm_app_schema_view`、`wasm_app_export`）。读行数据属**后者**。
- **计量面**：`appdb.Open` 的句柄带每请求计量；新端点必须用**独立句柄**，否则会污染 `serve.go:448` 的每请求 `db_rows/db_bytes`。
- **隐私**：应用库是"同一应用内所有用户共享"的数据，可能含员工 PII；`data_sensitivity` 只是作者**声明**（自由文本，非枚举），不能直接当策略开关。

### 5.5 一个关键的安全论证（决定这件事能做到多大）
应用代码是作者写的，而应用对应用库**有完整读写权**（R15：不做行级过滤）⇒ **作者今天已经可以**发布一个把整表渲染到页面的版本、自己打开看。因此"平台侧只读数据面"**不扩大**作者对数据的有效访问，只是把"先发一版调试代码"变成"直接查"。真正的新增面是 **AI 读行内容 ⇒ 使用者 PII 进入模型上下文**，这是产品决策，不是技术拦路。

### 5.6 候选方案
| 方案 | 机制 | 优点 | 缺点/风险 | 量 |
| --- | --- | --- | --- | --- |
| **A 只读行浏览** | 新端点 `GET …/wasm/:app_id/rows?table=&limit≤200&offset=`，**复用 `appdb.Open` + `appdb.DB.Query`**（白名单/5 s/5000 行/8 MiB/`_row_id` 投影剥离/只读连接池全部免费继承） | 最小、无 SQL 注入面、可复用全部既有加固 | 表达力弱（无法 WHERE/聚合），排障时常不够 | M |
| **B 只读查询** | 新端点 `POST …/wasm/:app_id/query`，SQL 走**同一份 sqlgate**（仅 SELECT）+ 只读连接 + 同额限额 | 表达力强，作者/AI 自助 | 平台开始执行"作者提供的 SQL"（但应用本来就能让平台执行它提供的 SQL）；SQL 文本含 PII 的日志风险 | M |
| **C 应用自建数据页** | 作者在应用里写只读页 | 零新平台面 | 要发版才能看；应用坏时正好看不到；AI 做不到 | — |
| **D 本地真 SQLite** | `preview.mjs` 用 `node:sqlite` 落本地文件 + 同额闸门 | 开发期闭环、零生产风险、数据可随便看 | 只解决开发期 | S |
| **E 证据面补强** | 失败事件带 SQL 摘要（脱敏截断）+ 应用日志回读端点 | 回答"我的写到底执行了没" | 仍看不到行值 | M |

**推荐组合**：**D（开发期）+ A（线上只读，默认脱敏 + 强制分页）+ E（证据）+ AI 工具面**；B 作为第二阶段（当 A 的排障表达力被证明不够时再上，且必须复用同一份 sqlgate）；C 写入文档作为兜底。

### 5.7 推荐路线的设计要点（方案 A）
- 端点：`GET /api/client/v2/apps/wasm/:app_id/rows`（+ 管理面同形 `GET /api/server/admin/wasm-apps/:app_id/rows`，`capability:read`）。
- 参数：`table`（必填，过 `validateTableName`）、`limit`（默认 50，上限 200）、`offset`（上限 100 万，或改用不透明游标）、`order`（只允许平台内部 `_row_id` 升/降序，**不暴露列名排序**避免建立索引探测面）。
- 输出：`{columns:[{name,type}], rows:[[…]], truncated:{rows:bool,bytes:bool}, row_id_hidden:true}`；单值超 4 KiB 截断并标记；整体 ≤ 1 MiB。
- 鉴权：沿用 `ownedApp`（非发布者 404 同形）；**写审计** `wasm_app_rows_view`（记 `table`/`limit`/`offset`/行数，**不记行内容**）。
- 脱敏：默认按列名启发式打码（`*password*`/`*token*`/`*secret*`/`*id_card*`/`*phone*`…），显式 `unmask=1` 才给原值且**该次调用单独审计**。
- 复用：`appdb.Open` 独立句柄（勿污染计量）、`validateTableName`、`projectColumns` 语义（`_row_id` 必须剥离）。
- **客户端落点**：应用详情视图 `AppDetailView`（`AppCenterPanel.tsx:1364`，`data-role="app-detail"`）已经承载"访问级别 / 生效版本 / 窗口规格 / 今日打开次数"，数据面板应作为它的一个同级区段（只在发布者本人可见时渲染），与既有 `DiagnosticsBlock`（`:2038-2070`）同族；不要新开页面。
- **AI 工具面**：`wasm_app_diagnostics`（必做，P1-4 的 AI 半边）、`wasm_app_schema`（结构+行数，默认给 AI）、`wasm_app_rows`（**默认不给 AI**；要开必须走"每次显式用户同意"的授权卡，与既有应用 AI 授权同族）。
- **本地**：`preview.mjs --data-dir <工作区内目录>` 用 `node:sqlite` 建真库，作者可直接用任何 SQLite 工具打开该文件；`--dump-tables` 打印表清单与行数。
- **证据面**：失败事件补 `db_rows/db_bytes`（P1-4），并在 SQL 报错时记一条**截断+脱敏的 SQL 摘要**（可选、默认关）。

### 5.8 判据与变异验证建议（施工时必须带）
1. 非发布者访问 `rows` ⇒ 404 且与"应用不存在"**逐字节同形**（变异：改成 403 ⇒ 红）。
2. `limit=201` ⇒ 拒绝或截断到 200（变异：去掉 clamp ⇒ 红）。
3. 行内容里出现 `_row_id` ⇒ 不存在（变异：不剥投影 ⇒ 红）。
4. 默认脱敏：`password` 列返回 `***`（变异：去掉脱敏 ⇒ 红）。
5. 审计：每次调用产生一条 `wasm_app_rows_view`，且**内容不含行值**（变异：审计里带 row JSON ⇒ 红）。
6. 计量隔离：调 `rows` 后，随后一次应用请求的 `db_rows` 不受影响（变异：复用共享句柄 ⇒ 红）。
7. 只读：对 `rows` 传 `table` 为视图/`sqlite_master` ⇒ 拒（变异：不校验表名 ⇒ 红）。
8. AI 工具：默认工具清单**不含** `wasm_app_rows`（变异：默认注册 ⇒ 红）。

### 5.9 需要拍板的 10 个点
1. 行数据是否对**作者本人**开放？（推荐：开放，只读）
2. 是否对**AI**开放？默认关还是每次授权？（推荐：默认关 + 显式授权卡）
3. 是否对**管理员**开放？（推荐：开放，单独审计；合规上通常需要）
4. 是否允许**写**（清理脏数据）？（推荐：首版不允许）
5. 自由 SQL 还是结构化浏览？（推荐：先结构化，B 方案二期）
6. 审计粒度：每次查询一条 vs 每次会话一条？（推荐：每次查询，字段不含行值）
7. 是否允许导出数据文件？（`export` 已明确不含数据；若允许需独立端点 + 管理员动作）
8. 脱敏策略由谁定：列名启发式 vs 作者声明？（推荐：启发式默认 + 作者可声明 `sensitive_columns`）
9. 应用退役/冻结后是否仍可读行数据？（推荐：冻结期可读只读快照，软删后仅管理员）
10. 是否给员工看？（推荐：不给；R36/R24 口径不变）

---

## 6. 建议的实施波次

**W0 · 安全与工具链止血（当天到两天，都是 S 级且都有实测判据）**
- 修 P0-0（`wasmmod/parse.go` 三处计数向量越界分配），补"计数向量与载荷一致性"用例，跑 `wasmmod` 全量。
- 修 P0-4（DataCount 规范位置）、P0-5（`.debug_*` 前缀判定 + `pack-assets.mjs` 同步）、P0-6（`sock_recv`/`sock_send` 白名单重生成）—— 这三条决定"平台到底支持哪些语言"这句话能不能对外说。
- 同日可顺手做 P2-21 里两条会误导排障的漂移（`export` 的 assets 指向、`diagnostics.md` 的日志/计量承诺、模型可见的"应用域名"描述）——它们与 W0 同一批文档改动。

**W1 · 闭合承诺与零成本接线（约 1 周，不需要产品决策）**
- AI 回读工具：`wasm_app_diagnostics`（+`wasm_app_schema`）。
- `db_rows`/`db_bytes` 进诊断；应用日志落库 + 回读端点（或先明确改文档承诺）。
- `schema` 补客户端入口（诊断块里加"应用信息/生效配置"折叠区）。
- `preview.mjs` 支持真 SQLite（`--data-dir`/`--dump-tables`）。
- 文档漂移批量修（`diagnostics.md`、`read.go:730-733`、W4-12 三文件、`03-api-reference.md`）。
- 判据：上述每条都要有行为级判据 + 变异验证；旧文档承诺要么兑现要么销账。

**W2 · 已冻结设计接线（约 1–2 周）**
- P0-1 应用窗口接入 browser surface（+控制权投影）；P0-2 窗口规格接线；P0-3 缓存读写接线。
- P1-7 错误页动作、P1-8 刷新/返回、P1-11 外链与下载反馈。
- P1-10 存储清理 + 分区 server hash（与 browser 泳道同批）。
- 判据：真机（打包版 + 真实服务端）断言"AI 能列出应用窗口并能操作""比例被强制""第二次打开命中缓存（平台侧请求数下降）"。

**W3 · 生命周期与运维闭环（约 1 周）**
- 版本回滚（新端点 + 审计 + 与版本号永久占位的关系定义）。
- 冻结保留期快照 + 到期真删后台任务；管理端删除/恢复/导出入口。
- P1-6 AI 归因替代路径（按 `app:` 会话前缀派生 + 伪造头防护）。
- 判据：回滚后 `open` 返回旧版本号且资源随版本失效；快照可导出、真删后数据根无残留。

**W4 · 应用库数据面（需先拍 §5.8）**
- 方案 A 端点 + 客户端数据面板 + 审计/脱敏 + 判据与变异。
- 视拍板结果决定是否上 B（只读 SQL）与管理员视角。

**依赖与不可并行项**
- W2 的分区名改动必须与 browser 泳道同批（否则协议 handler 注册到没人用的分区 ⇒ 窗口空白）。
- W4 若上 B 方案，必须与 `sqlgate` 的维护者同批（闸门只能有一份实现）。
- 任何触碰 `packages/host/**` 的改动要过构建依赖图不变量（叶子包零依赖、声明边==实测边）。

---

## 7. 认账、待裁决与未覆盖

### 7.1 需要拍板的两处口径冲突（F 报告提出）
1. **分区名是否含服务端哈希**：设计 §23.2 R2S-8 要求 `persist:agent-browser-<user>@<server-hash>`，实现是 `persist:agent-browser-<user>`（`partition.ts:47-50`，与内置浏览器同形且有 spec 钉死）—— **二者只能留一个**。留实现 ⇒ 改设计；留设计 ⇒ 两侧同批改 + 旧分区一次性清理。
2. **名为"私有仓"的 `picoaide/channels` 实测可匿名克隆**（F 报告 `git ls-remote` 成功）—— 若本意是私有，需要关读权限；否则应在文档里如实称其为公开仓（它现在承载着各渠道的品牌与默认服务器地址）。

### 7.2 认账
- **设计 §21.7 五条追加认账在 HEAD 上全部仍开**（B 报告逐条复核）：⑤ 归因不出数（含"伪造头未拦"，且 webadmin 契约反向声明已有防护）、⑥ 隐藏会话元数据放不下 `app_id`（已改判为"会话 id 前缀可判定"，属既知差异而非缺口）、⑦ 面板聊天不可达、⑧ "客户端按目录对比"触发源未做、⑨ 原子写无 fsync（上游 `.d.ts` 明写该缺口 out of scope）。
- **本次核验纠正了多条过期登记**（F 报告"与原判不一致 14 处"）：W4-12、§T 的窗口适配器与 AI runner、`TestServe_ResponseFrameTooLarge`、W0-D 存储探针、appdb 深层、start 段死循环错误码 —— 这些**已闭合**；而 `content-type` 恰恰相反（F 自我纠正为**仍开**）。⇒ "台账说未做"既不能当"仍未做"，也不能当"已做"，只能当"该看哪里"。
- **发布前置现状**：H1（四渠道 `app_origin_scheme`）**已闭合**（判据实跑 4/4 EXIT=0；注意判据命令必须 `GITHUB_REF` + `GITHUB_REF_NAME` 同时给，只给后者会静默退化成 official-only）；**H2（渠道仓不 pin commit）仍开**；H3（三平台探针）/H4（`check:wasm-client-only` 转阻塞）仍开。

### 7.3 未覆盖
- 本次是**只读审计**：所有"未实现"结论都基于"读代码 + 指定关键词搜索 + 部分实跑"，**不等于"作者没写"**；施工前每条应再复现一次。
- 未跑整仓门禁、未在打包产物上复验客户端行为、未做真机（Windows/macOS）验证；三平台协议/存储结论仍只有 Linux 实测。小数项（TinyGo 真实产物因无工具链未实测、AI 面板真机联调、审批开启下的作者体验、并发压测）已在 D 报告末尾认账。
- 审计基线是 `feat/dsh-0.1.6-upgrade`（比 master 多 15 个 DSH 0.1.6 升级提交）；WASM 平台代码与 master 一致。
- 子报告（`temp/wasm-gap-audit-2026-09-20/`）里各自列了"无法验证/需真机"清单与实跑输出；本文件是汇总与规划，具体证据请回到对应子报告。
