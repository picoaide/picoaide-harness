# WASM 应用平台：可运营化（限制项后台配置 + 内置演示应用），2026-09-19

> 用户要求原文：「这个并发应用数量，和应用允许内存占用数量还有哪些可配置项，需要后台有个
> 配置页面。另外你端到端的测试一下服务是否真的能正常请求 … 另外代码仓库里也要有几个 demo，
> 各种权限模式的，安装以后就能给客户演示的。这个应该是系统安装以后直接带的展示，可以删除的。」
>
> 本文记录三件事的落点与踩过的坑。内存模型本身见 `2026-09-18-wasm-memory-footprint.md`。

## 1. 限制项后台可配置

### 1.1 模型与优先级

`server/internal/wasmapp/applimits` 是**唯一模型**（字段名即跨语言契约，webadmin 表单与它逐字对齐）：

| 分组 | 字段 | 生效方式 |
|---|---|---|
| 并发 | `max_instances` / `app_running` / `app_queue` | 即时（`queue.Scheduler.SetOptions`） |
| 并发 | `user_global_running` / `user_per_app_running` / `user_per_app_queued` | 即时 |
| 内存 | `instance_memory_mb` | **需重启**（wazero 的 `WithMemoryLimitPages` 属 RuntimeConfig，执行侧 runtime 进程内单例、建好不可变） |
| 内存 | `module_cache_mb` / `module_cache_idle_min` | 即时（`moduleCache.SetBounds`，收紧时立刻按 LRU 淘汰） |
| 内存 | `appdb_idle_min` | 即时（`appDBPool.SetLimits`，收紧时关最久未用的空闲句柄） |
| 内存 | `appdb_cache_kib` | 下一个新建连接（连接级 PRAGMA） |

优先级：**控制台保存的设置（`settings.wasm.limits`）> 部署档位 `PICOAI_WASM_MEMORY_PROFILE` > 编译期默认**。
解析与持有在 `cmd/server/wasmapp_limits.go`（原子读；写路径只有控制台）。

### 1.2 保存路径 fail-loud，启动路径可恢复

- **保存**：超范围拒（含"提交片段"——缺字段会被点名，而不是报成另一个字段超范围）；四笔账
  （并发 × 单实例上限 + 编译峰值 + 上传峰值 + 模块缓存）超过可用内存 70% 拒。判据与启动自检
  **同一份**（否则"先进控制台把并发拉满"就能绕过启动自检）。
- **启动**：若保存过的设置**后来**因机器变忙而超水位 ⇒ **回落部署档位 + 大声告警**，而不是
  拒绝启动。理由：设置是运行期产物，让它把服务端锁死在启动失败上，运维连控制台都进不去。

### 1.3 API 与页面

- `GET /api/server/admin/wasm-apps/limits`：当前值 + 来源 + 默认值 + 档位预设 + 取值区间 +
  四笔账预览（含服务端读到的可用内存与水位比例）+ `restart_pending`。
- `PUT`：body `{"limits":{…}}` 保存；`{"limits":null}` 清空设置回到档位/默认。审计动作
  `wasm_limits_change`（权限点 `capability:write`，读用 `capability:read`）。
- webadmin 新页 **运维 → 应用平台**（`/app-platform`）：档位一键套用、编辑期实时预览
  （超水位当场变红）、需重启字段带徽标、保存后如实在 flash 里说明"已即时生效/需重启"。

## 2. 内置演示应用（装完即用、可删除）

- **制品与清单随镜像分发**：`/opt/picoaide/demo-apps/{app.wasm,demos.json}`（Dockerfile 构建，
  `demoapps/appdemo` 编译成 wasm32-wasip1）。
- **一份 wasm，三种权限模式**：`demos.json` 把它播种成
  `demo-public`（匿名可达）/ `demo-login`（登录可见）/ `demo-whitelist`（名单可见）。
  准入模式是平台侧配置；**whitelist 的名单比对按 R24 由应用自己读 `picoaide.app.json` 完成**
  （平台只负责"要求登录 + 告知模式"），演示页把这一点直接写在页面上。
- **播种**：`internal/wasmapp/appseed` 在服务端启动时执行（`cmd/server/wasmapp_demo.go`，
  归属人 = 最早的超管）。**判据是"库里是否已存在该 app_id"**：存在（含软删/冻结）即跳过
  ⇒ 管理员删除演示应用后，重启也不会被塞回来。
- 播种会显式写出**版本资源目录** `<data_root>/apps/<app_id>/assets/<release_id>/picoaide.app.json`
  （见 §3.2），播种的 release 为 `approved` 且应用直接上架。

## 3. 三个必须记住的坑

### 3.1 `abi.WriteFrame` **不 flush**

`abi.WriteFrame(w, payload)` 只往 `io.Writer` 写字节；示例里的 `writeFrame` 自带 `out.Flush()`。
漏掉 flush 的症状极具误导性：guest 写出 RPC 帧后一直等响应，**host_call_count=0**、
10 s 后 `RUNTIME_TIMEOUT`、页面 504 —— 看起来像"编译/运行环境坏了"，实际是自己的缓冲没刷出去。

### 3.2 版本**必须**有资源目录

应用子域管线在请求路径上 `assets.Open(root, app_id, release_id)`，**失败即 500**
（"该版本的资源目录缺失"）；随后还要 `loadAppConfig` 读 `picoaide.app.json`，读不到同样 500
（绝不按匿名处理）。因此任何"绕过 HTTP 发布链路"的播种（内置演示、批量导入）都必须自己把
资源目录与配置写出来 —— 只写 `apps` + `app_releases` 是不够的。

### 3.3 镜像内文件权限：服务端以 `picoaide` 用户运行

演示制品拷进镜像时若保留 `0600 root`，运行期读不到（`appseed: 装载失败：Permission denied`）。
Dockerfile 里补了 `chmod -R a+rX /out/demo-apps`；本机往容器里 `docker cp` 时也要先 `chmod 644`。

## 4. 验证（可复跑）

- 单元/集成：`applimits`（默认值等于编译期常量、档位折算、片段/未知字段/超范围全拒、四笔账随
  限制项变化、`NeedsRestart` 只认 `instance_memory_mb`、区间表覆盖全部字段）；`appseed`
  （三种 access 落库正确、资源目录与配置写出、二次播种全跳过、软删后不重建、坏制品被魔数校验拒、
  目录缺失=非错误）；`readyz`/`appserver`/`queue`/`cmd/server` 既有用例全绿。
- 本地（真服务端 + 真 PG）：管理员登录 → GET 视图 → PUT 生效（日志 `限制项已下发 … restart=[]`）
  → 超水位 400 → 非法值 400 → 落库；演示播种 3 个 → 删除一个 → **重启后仍不重建**。
- 测试环境（2 GB 机器，`small` 档）：`GET/PUT /wasm-apps/limits` 与真实管理员会话通过；
  三个演示子域分别验证：匿名 200（且匿名写库成功）、匿名 302 换票 + 登录后 200 显示身份、
  名单内 200 / **名单外 403 且页面显示本人账号**；管理端 bundle 含 `/app-platform` 路由。
