# WASM 应用平台审计发现与处置（2026-09-19）

> 用户原话：「你自己再检查一下性能方面，和流程配置，还有哪些不人性化的地方，只查 wasm 代码就行。」
>
> 审计范围：`server/internal/wasmapp/**`、`server/cmd/server/wasmapp*.go`、`server/internal/router/**`（wasm 段）、
> `packages/client/wasm-apps/**`、`packages/host/enterprise/src/wasm-app*.ts`、`server/webadmin/src/**`（应用中心/应用平台）。
> 审计方式：只读代码审计 + 逐条复核（本文件是结论与处置，不含未复核的推测）。

## 0. 三条最重的发现（都是"界面说的话与系统做的事不一致"）

| 编号 | 问题 | 后果 |
|---|---|---|
| **P0-1** | 打开「更新审批」后，全组织新版本永久停在 `pending` —— 管理端**没有任何审批端点** | 开关的净效果是"全组织停止接收更新"；发布者拿 201，没有后续指引；版本号还永久占位 |
| **P0-2** | `instance_memory_mb` 是死旋钮：提示"需重启"，但重启后执行侧仍按部署档位跑；重启后连提示都消失 | 账本按 32 MiB 算、实例按 64 MiB 跑 ⇒ 2 GB 机器 OOM；反向调大也不会生效 |
| **P0-3** | 每次应用请求都从 PostgreSQL 拉整份 wasm 制品（≤32 MiB）并丢弃（模块缓存命中时无人读它） | 默认档 32 并发下瞬时堆可达 ~1 GiB，而这笔内存**不在**四笔账里 |

## 1. P0 处置

- **P0-1**：补齐闭环 —— 新增 `GET /wasm-apps/:app_id/releases?status=pending` 与
  `POST .../releases/:version/approve|reject`（复用既有的 `serverstore.SetReleaseStatusForReview`，
  它是审核专用且带 archive 原子语义），`adminList` 下发待审计数，管理端加待审筛选与操作。
- **P0-2**：让旋钮真的生效 —— 装配期用**当前生效的限制项**（settings > 档位 > 默认）折算单实例内存页数
  构造 runtime；装配期把 `ApplyLimits` 返回的 `restart` 回写持有者，让"重启后仍不一致"如实显示；
  `/limits` 视图如实给出档位名。补"设置值 ≠ 档位值"时 runtime 必须用设置值的测试（变异即红）。
- **P0-3**：请求路径改轻量投影（不含 archive），archive 只在冷编译时按需加载；
  并让"每请求制品缓冲"进入内存账或至少有明确注释。

## 2. P1 清单与处置

| 编号 | 发现 | 处置 |
|---|---|---|
| P1-1 | 静态资源热路径：每请求 3 次 DB 查询（含一次 4 表 JOIN）+ `assets.Open` + `loadAppConfig` + 再读一遍文件，零缓存 | **修**：`(appID, releaseID)` 级缓存 assets/appcfg；静态直出判定提前 |
| P1-2 | 静态资源 304 也要读全文并算 SHA-256（5 分钟缓存窗口后的复验风暴） | **修**：ETag/content-type 缓存，命中 `If-None-Match` 直接 304、不碰磁盘 |
| P1-3 | 发布表单不预填当前配置 ⇒ 一次纯代码更新会**静默改写线上 `access`**；`data_sensitivity` 被硬填 `internal` | **修**（安全语义）：进表单预填当前 access/owner/purpose；变更 access 要二次确认；敏感度不留默认 |
| P1-4 | 目录与 `wasm_app_list` 都不下发"当前版本"，而工具描述要求"先查当前版本" | **修**：catalog 行补 `current_version`（与 `adminList` 同源） |
| P1-5 | 客户端应用中心加载失败丢弃服务端结构化信封，只显示 `加载失败 (HTTP 502)` | **修**：复用包内既有的 `parseErrorEnvelope`，渲染 code/message/hints |
| P1-6 | 管理端把错误信封的 `hints`/`details` 全丢（`ApiError` 上没有 `hints`），且有一条"假绿"测试钉住 | **修**：`ApiError` 补 `hints`/`details`，测试改用真实信封 |
| P1-7 | 应用列表静默截断到 200 条：无 total/分页/搜索/批量，SQL 也没有 LIMIT | **修**：下发 total/truncated + 服务端 LIMIT；前端搜索 + 状态筛选 + 分页 |
| P1-8 | 管理端下架/冻结不触发 `EvictApp`（发布者路径有），门禁是源码 grep（假绿） | **修**：补 evict 调用 + 换行为断言 |
| P1-9 | 管理端零运行诊断入口（diagnostics 端点只在员工 Bearer 面） | **修**：加管理面只读 diagnostics 端点 + 详情抽屉 |
| P1-10 | 页面发布路径无体积闸门，超限文件在渲染进程主线程做全量 base64 | **修**：选文件即判 32 MiB，`WASM_MAX_BYTES` 纳入跨端契约 |
| P2-1 | 「应用平台」页首屏失败 = 永久骨架屏（错误块在 `return <Skeleton/>` 之后） | 修（随页面合并一起） |
| P2-2 | 限制项保存被拒后界面不自洽（红字报错与绿色"水位正常"同屏），且无刷新入口 | 修 |
| P2-3 | `/readyz` 执行槽饱和判据用编译期常量（32），与档位/控制台值脱钩 | 修 |
| P2-4 | 匿名限流拒绝数、aichat 吊销失败数、库句柄数等水位零出口 | 修（并入 P1-9 的诊断面） |
| P2-5 | `/readyz` 未认证且每请求 DB Ping + statfs + 读 `/proc/meminfo` | 修（加秒级缓存） |
| P2-6 | 冻结应用仍能"上架"并返回成功（但依旧 404）；冻结单击即生效无二次确认 | 修 |
| P2-7 | 应用日志刷盘发生在**持有执行槽/库句柄**期间（defer 顺序） | 修（调整 defer 顺序/异步化） |
| P2-8 | 分片 PUT 对确定性 4xx 也重试 3 轮并把错误码压成 `UPLOAD_INCOMPLETE` | 修 |
| P2-9 | `whitelist` 的服务端文案与真实语义相反（平台不比对名单）；客户端文案里的 `**` 原样显示 | 修（文案） |
| P2-10 | 目录解析遇字段改名静默降级成"还没有可用的应用"，且该契约无跨端对拍 | 修（跳过行计数 + 契约对拍用例） |

## 3. 明确不修（已认账或超范围）

- R37「归档保留期到期真删」后台任务未实现（响应体自己写着"当前未实现"）—— 已认账缺口。
- 管理面无应用删除路由（只有发布者可删）—— 产品决策，未拍板。
- `access=whitelist` 由应用自校验名单（R24）—— 有意的设计，只修文案。
- 目录/工具面全量下发（几百应用时进模型上下文过大）—— 需要产品拍板分页语义。

## 4. 复现与验证方式（供后续回归）

- 本地端到端环境见 `temp/wasm-verify/README.md`（真实服务端 + TLS 反代 + 真实 Chromium 探针）。
- 审计证据的行号基于 `e3b73963d7`；修复后如行号漂移，以函数名为准。
