# WASM 应用平台：审核闭环 / 实例内存旋钮 / 请求路径制品投影（2026-09-19）

本文件记录 2026-09-19 只读审计后修复的三条 P0 与一条 P1 的**决策与边界**。
改动全部落在服务端（`server/internal/wasmapp/**`、`server/internal/serverstore/wasmapps.go`、
`server/internal/router/**`、`server/cmd/server/**`）。设计基线仍是
`docs/planning/2026-09-17-wasm-app-platform.md`（§8 R17/R23、§4.6、§4.3）。

## 1. 审核开关的闭环（P0-1）

**问题**：`wasm.review_required` 打开后 `publish.go` 把新版本落成 `pending`，而
生效版本只认 `approved` —— 管理端却**没有任何审批端点**（router 的 wasm 路由表里
没有 approve/reject），列表也不下发任何待审信息。于是"开启审核" = 全组织再也发不出
新版本（含新应用的第一个版本），且界面上看不到积压。webadmin 的开关文案与设计文档
§8（"管理员在 webadmin 审批"）都承诺了这条链路。

**决策：补齐闭环，不降级开关。** 三条端点挂在既有管理面分组（`internal/router` 集中申报）：

| 方法 | 路径 | 权限点 |
| --- | --- | --- |
| GET | `/api/server/admin/wasm-apps/:app_id/releases?status=pending\|approved\|rejected\|all` | `capability:read` |
| POST | `/api/server/admin/wasm-apps/:app_id/releases/:version/approve` | `capability:write` |
| POST | `/api/server/admin/wasm-apps/:app_id/releases/:version/reject`（可选 body `{"reason":"…"}`） | `capability:write` |

四条不变量（都有回归用例，见 `internal/wasmapp/api/admin_review_test.go`）：

1. **状态写入复用 `serverstore.SetReleaseStatusForReview`** —— 不另写状态机。
   "approved 与归档非空"、"rejected 与释放归档"都在同一条条件 UPDATE 里判定，
   并发 approve/reject 交错产不出 `approved + archive IS NULL` 的坏行（N-4）。
   拒绝已释放归档的版本 ⇒ 409（与 agentshare/sharedskills 同语义）。
2. **通过后把 `apps.current_release_id` 对齐到"最新 approved"**：线上交付走
   `max(id) approved`（`LatestApprovedWasmReleaseMeta`），管理面列表的
   `current_version` 走 `current_release_id` 投影 —— 两者必须同口径，否则
   "列表显示旧版本、实际服务新版本"。审批一个**更旧**的待审版本时不会把投影倒退
   （取的是最新 approved）。
3. **拒绝不是下架手段**：拒绝线上生效版本会释放它的字节 ⇒ 应用当场没有可交付版本。
   该路径被显式拒绝（409），停服务请用 unpublish / freeze。
4. **积压可见**：`adminList` 每行下发 `pending_releases`（版本号数组）与
   `pending_count`，顶层再下发全组织 `pending_count` —— 开关的后果必须出现在开关旁边。
   审计动作 `wasm_app_release_approve` / `wasm_app_release_reject` 沿用 `wasm_app_*`
   风格；明细只含版本号与（折成单行的）拒绝理由，不含制品内容（拒绝理由上限 200 字，
   因为审计链是追加型的、写进去改不掉）。

前端（webadmin）接线见修复报告 §4 的待接线清单（当时 `AppCenter.tsx` 正被页面合并
代理改动，本波次不碰前端）。

## 2. `instance_memory_mb` 必须真的生效（P0-2）

**问题**：执行侧 runtime 的单实例内存上限只取自部署档位
（`appserver.New` 用 `prof.InstanceMemoryPages`）；控制台保存的值只在
`ApplyLimits` 里被比较出"需重启"，装配期把返回值只打了一行日志 ⇒ 重启后
`restart_pending` 被清空（界面显示"无需重启"）而实际值仍是档位值。后果是
"自检按设置算账、实际按档位跑"（2 GB 机器 OOM），正是 2026-09-18 决策要防的分叉。

**决策：让旋钮生效（而不是移除旋钮）。**

- `appserver.Options` 新增 `Limits applimits.Limits`（**当前生效**的限制项：
  控制台设置 > 部署档位 > 编译期默认，解析在 `cmd/server` 的 `wasmLimitsHolder`）。
  `MemoryProfile` 降级为**默认值来源**。装配期用它一次算齐：runtime 页上限、
  队列并发、模块缓存上限、库句柄上限 —— 免得"限制项按设置、并发按档位"再次分叉。
- 装配期把 `appSrv.ApplyLimits(...)` 的返回**回写持有者**
  （`wasmLimitsHolder.ApplyStartup`）：重启后 `restart_pending` 为空是"被断言过的
  事实"，不为空则如实显示（不再被静默抹平）。
- `/wasm-apps/limits` 视图如实反映来源：`source_label`（"控制台保存（wasm.limits）" /
  "部署档位 small（PICOAI_WASM_MEMORY_PROFILE）"）、`profile`（档位名），
  四笔账的 `budget.profile` 由硬写的 `"settings"` 改为
  `limits/setting` 或 `limits/profile:<name>`（与启动自检日志同一形态）。

语义边界：`instance_memory_mb` 仍是"**改了要重启**"的字段（wazero RuntimeConfig
不可变），但重启之后**一定**等于设置值；`restart_pending` 只有在"装配期之后又改了"
时非空。回归：`appserver/limits_instance_memory_test.go`（夹具：档位 small=64 MiB、
设置 128 MiB）+ `cmd/server/wasmapp_test.go` 的装配级用例（真 PG → 保存设置 →
装配 → 断言 runtime 页数 = 2048 且 `GET /wasm-apps/limits` 的 `restart_pending` 为空）。

## 3. 请求路径不得拉整份制品（P0-3）

**问题**：`serve.go` 每请求调 `LatestApprovedWasmRelease`，而它用**含 archive** 的
全列查询。模块缓存命中（暖机常态）时 `rel.Wasm` 没有任何读者 —— 唯一读者是冷编译。
代价：单请求瞬时堆可达 `并发 × 32 MiB`（默认档 32 并发 ≈ 1 GiB），而四笔账里没有这笔。

**决策：请求路径取轻量投影，字节按需加载。**

- `serverstore` 新增 `wasmReleaseServeColumns`（= 清单列，**不含 archive**）、
  `LatestApprovedWasmReleaseMeta`（请求路径唯一入口）、`GetWasmReleaseMeta`（单版本元数据）。
  含字节的旧函数**改名** `LatestApprovedWasmReleaseFull`：名字里的 Full 就是成本提示，
  调用点只有"本来就要字节"的地方（发布/播种期校验、离线诊断）。
- `appserver.serveWasm` 的模块缓存 `acquire` 回调（**只在冷编译时执行**）先调
  `loadReleaseWasm` 取字节，再编译 ⇒ 缓存命中时既不查 archive 也不碰加载函数。
- `readyz` 的内存四笔账补了记账边界说明：这笔瞬时缓冲**不计入**是因为已被结构上
  消除（不是被忽略）；任何"让请求路径重新持有制品字节"的改动必须回到那里重新算账。

验证：`appserver/archive_ondemand_test.go` 用 **PostgreSQL 自己的 TOAST 访问计数**
做端到端判据 —— 暖机后连续请求，`pg_statio_user_tables.toast_blks_{hit,read}` 必须
一动不动；随后用一个"真的把 archive 取回来"的正对照证明该指标在本环境是活的
（注意：`octet_length(archive)` **不**触碰 TOAST，未压缩的 out-of-line 值可以直接从
指针读出长度 —— 第一版正对照就栽在这里）。

## 4. 管理端处置必须逐出进程内驻留（P1-8）

**问题**：发布者路径（下架/删除）会调 `OnAppEvict`，**管理端不会**
（`adminUnpublish` / `adminFreeze` 都没有），而文档与装配注释都声称"下架/冻结/删除"
都在内。唯一门禁是 `cmd/server` 的一条**源码 grep**（断言某行字符串还在）—— 它分不清
"接上了"与"handler 从不调用"，所以缺陷一路绿灯。

**决策：补调用 + 把 grep 换成行为断言。**

- `adminUnpublish`（下架成功、写完审计后）与 `adminFreeze`（冻结成功、写完审计后）
  调用同一个 `h.evictApp`（与发布者路径同一钩子）。上架与解冻**不**逐出。
- 抽出具名构造函数 `newWasmAppEvictor(wasmAppEvictor)`（接口 = 最小依赖面），
  装配处 `OnAppEvict: newWasmAppEvictor(appSrv)`。
- **删掉那条 grep 门禁**，换成两层行为断言：
  - `internal/wasmapp/api/admin_evict_test.go`：计数假钩子，断言下架/冻结各调用一次、
    幂等路径与上架/解冻不调用；
  - `cmd/server/wasmapp_test.go` 的 `TestWasmAdminDisposalEvictsRuntimeCache`：
    真装配 → 暖一个真实模块进 `appserver` 模块缓存 → 调**真实的管理端 handler**
    （经 `AdminRoute` 挂载）→ 断言 `appserver.CachedModuleCount()` 归零。
    为此给 `appserver.Server` 加了只读访问器 `CachedModuleCount()`
    （此前 `EvictApp` 的返回值被钩子丢弃 ⇒ 逐出效果在测试里不可观测）。
