# webadmin ↔ wasm 应用平台：审核闭环、列表分页、错误信封与诊断出口（2026-09-19）

本轮把刚完成的服务端「审核闭环」接到管理端，并修掉四条审计项：
P1-6（错误信封的 hints/details 被丢）、P1-7（列表静默截断 200 条）、
P1-9/P2-4（管理端零诊断入口 + 水位零出口）、P2-1/P2-2/P2-6（限制项错误态、
保存后不自洽、冻结应用仍能"上架成功"）。

## 1. 新增/变更的端点（全部走 `internal/router` 集中声明）

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/server/admin/wasm-apps?q=&status=&limit=&offset=&include_deleted=&owner=` | `capability:read` | 列表；新增 `total`/`truncated`/`limit`/`offset`/`q`/`status` 回显，`q` 在**分页之前**过滤 |
| GET | `/api/server/admin/wasm-apps/:app_id/releases?status=pending` | `capability:read` | 待审版本清单（服务端本轮已实现，前端本轮接线） |
| POST | `/api/server/admin/wasm-apps/:app_id/releases/:version/approve` | `capability:write` | 审核通过 |
| POST | `/api/server/admin/wasm-apps/:app_id/releases/:version/reject` | `capability:write` | 审核拒绝（`{"reason": "…"}`，≤200 字） |
| GET | `/api/server/admin/wasm-apps/:app_id/diagnostics` | `capability:read` | **本轮新增**：管理面诊断出口（员工面语义未改，仅加管理面出口） |
| GET | `/api/server/admin/wasm-apps/runtime` | `capability:read` | **本轮新增**：平台级只读运行时水位 |

`status` 取值：`all`（缺省）/ `pending` / `published` / `unpublished` / `frozen` / `deleted`
（`deleted` 等价于 `include_deleted=true`）。非法取值回 400 `VALIDATION` +
`details.field=status` + hints，不静默忽略。

## 2. 待接线清单（需要改本清单之外的包才能完成）

以下水位在服务端**已有导出访问器**，但没有接到 `api.Options` 上，因此
`GET /wasm-apps/runtime` 目前把它们如实列在响应的 `unavailable` 段里
（页面显示"不是 0，是取不到"），而不是静默省略：

| 水位 | 现状 | 需要的改动 |
| --- | --- | --- |
| `anon_limit`（匿名限流拒绝/淘汰/桶数） | `anonlimit.Limiter.Stats()` 已是导出方法 | `cmd/server/wasmapp.go` 的 `wasmapi.Options{}` 增加 `RuntimeStats` 闭包并调用 `limiter.Stats()` |
| `ai_revoke_failures`（aichat 吊销失败数） | `aichat.Client.RevokeFailures()` 已是导出方法 | 同上，调用 `ai.RevokeFailures()` |
| `module_cache`（进程内模块缓存条目/字节） | 住在 `appserver` 的私有 `moduleCache` | `appserver.Server` 增加 `ModuleCacheStats() (entries int, bytes int64)` 后经 `api.Options` 注入 |
| `appdb_handles`（应用库句柄数） | 住在 `appserver` 的私有 `appDBPool`（`pool.size()`） | `appserver.Server` 增加 `AppDBPoolStats() (handles int, max int)` 后经 `api.Options` 注入 |

`appserver` 当时由并发改造代理收尾，因此本轮**没有**改动它，也没有改动
`cmd/server`（不在本轮改动范围内）。

另一条同类缺口（列表 SQL 下推）：

| 项 | 现状 | 需要的改动 |
| --- | --- | --- |
| 列表 `LIMIT/OFFSET` 下推 | `serverstore.ListWasmApps` 不接受 limit/offset/关键字，`adminList` 只能在**已取回的列表**上过滤+切片 | 给 `serverstore.WasmAppFilter` 增加 `Query/Limit/Offset`（零值 = 现状，向后兼容）并加 `CountWasmApps`；`adminList` 改用它 |

**行为契约不受影响**（`total`/`truncated` 正确、第 201 个应用可检索、组件用例齐备），
代价只是大表时仍整表读进内存 —— 与改动前一致，没有变得更差。

## 3. 几个口径决定

- **冻结应用上架 → 403 `APP_FROZEN`（不是 409）**：`apperr` 的 code→status 映射表
  （`apperr.go`）是唯一权威，员工面 `release.go` 对同一条件已经返回 403
  `APP_FROZEN` + hint。为管理面另造 409 会让"一个条件两个状态码"，排障手册要写两套。
  管理端同时把冻结行的「上架」按钮禁用（体验层），服务端是护栏。
- **诊断面放行已退役应用**：员工面 `ownedApp(c, appID, true)` 早已如此；管理面
  `loadAdminApp(..., allowDeleted=true)` 与之同口径（只读放行、写面仍 404）。
- **运行时水位放在「限制项」页**：执行槽/编译队列/缓存水位正是限制项在运行期的表现，
  管理员调完并发/内存的下一步就是看实际水位；设置页讲的是应用访问域名，与运行时无关。
- **`ApiError.details = body.error.details ?? body.detail`**：通用信封把附加信息放在
  顶层 `detail`（错误上报的 DNS/CONNECT/TLS 分类），wasm 平台放在 `error.details`。
  两个字段都保留，`detail` 的既有消费方行为不变。
