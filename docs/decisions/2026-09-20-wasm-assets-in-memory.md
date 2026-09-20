# 随包资源改为内存直出（不再抽取到宿主盘）

- 日期：2026-09-20
- 状态：已定案（用户口述：「不要抽取出来放到宿主盘，宿主盘只能保存 wasm 文件，
  应该从内存里直接响应」）
- 影响面：`server/internal/wasmapp/{assets,appserver,api,appseed,hostcap}`、
  `<data_root>/apps/<app_id>/` 的磁盘布局、文档与内置技能口径

## 1. 背景与问题

原设计（设计总纲 §4.2）：发布期把 wasm 的**自定义段**当作随包静态资源抽到
`<data_root>/apps/<app_id>/assets/<release_id>/`，运行期宿主从该目录读盘：
静态资源按路径直出、应用用 `assets.read` 读配置与素材。设计总纲把这一步写成
"抽出失败 = 发布失败"，即**磁盘目录是交付面的一部分**。

2026-09-20 实测暴露了这套设计的三个结构性问题：

1. **两条链路必须各写一遍"抽段落盘"**。演示应用不走 HTTP 发布链路（启动时由
   `appseed` 直接落 `apps` / `app_releases` 行），于是它也必须自己把段抽到磁盘 ——
   而它只写了 `picoaide.app.json`，三个新演示（前后端分离，页面在 `web/`）的
   `index.html` / `static/*` 从未落盘 ⇒ 入口页 `assets.read("index.html")` 500。
   这不是"忘了写一行"，而是"同一件事有两处实现"的必然结果。
2. **磁盘与库两份权威**。应用配置同时存在于 `app_releases.config_json` 与磁盘
   `<release>/picoaide.app.json`，必须写一致性判据（`releaseAssetsIncompleteReason`）
   并做半成品自愈，否则会出现"库说 A、盘说 B"。这是纯粹由冗余引入的复杂度。
3. **磁盘即攻击面**。路径要逐段 `Lstat` 拒符号链接、要 realpath 前缀比对、要
   原子写（temp + fsync + rename）防半写、要防"抽取目录自身是指向根外的链接"。
   这些防御在内存模型下**全部不需要**：没有路径拼接，就没有路径穿越。

## 2. 决定

**随包资源不再落盘。** 运行期从 wasm 字节解析自定义段，构造成内存资源集
（`assets.Set`）并常驻在应用平台的版本缓存里；静态直出、`assets.read`、
应用配置读取三条路径**全部**走这份内存资源集。

磁盘上只保留：

- 各应用自己的 SQLite 库 `<data_root>/apps/<app_id>/app.db`（业务数据，必须持久）；
- 平台级编译缓存（wazero 的编译产物）与日志等既有平台数据；
- **wasm 制品本体仍在 PostgreSQL**（`app_releases.wasm`，签发/审核/回滚的权威面），
  不因本次改动搬家。

## 3. 口径与不变量

| 项 | 口径 |
| --- | --- |
| 资源上限 | 不变：单文件与段总量同源 `limits.SectionTotalMaxBytes`（4 MiB/版本） |
| 逻辑路径规则 | 不变：相对、`/` 分隔、无 `..`/冒号/控制字符、`MaxPathBytes`/`MaxSegmentBytes` |
| 保留资源 | `picoaide.app.json` 仍由平台独占：模块里的同名段忽略，运行期由**库内** `config_json` 注入内存资源集，仍然永不直出 |
| 工具链元数据段 | 仍不作为资源（`name` / `producers` / `go:buildid` …），判据与打包脚本同源 |
| 响应缓存 | ETag 仍 = `hash(app_id ‖ version ‖ path ‖ content)`，`Cache-Control: private, max-age=5min`，`If-None-Match` 304 不重算 |
| 准入与状态 | 冻结/下架/删除/未登记/无 approved 版本的行为一字不变 |
| 内存口径 | 资源字节计入**模块缓存的字节预算**（`module_cache_mb`），与模块同生命周期：LRU + 空闲 TTL（`module_cache_idle_min`）+ 应用级逐出（下架/冻结/删除）。**不新增第五笔账**，但要在限制项说明里写明该预算包含随包资源 |
| 失败语义 | "资源目录缺失"这一类平台故障**消失了**；新的平台故障是"生效版本的 wasm 读不出来/解析不了"，仍是 500 + 可读信封 |

## 4. 迁移与清理

- 历史 `<data_root>/apps/<app_id>/assets/` 目录是**平台派生数据**（配置来自库、
  素材来自 wasm 字节），启动时 best-effort 清理并记日志；清理失败不影响启动。
- 应用无需重新发布：内存资源集由**已在库里的 wasm** 解析得到，与磁盘目录无关。
- 回滚：回退到旧镜像即可（旧镜像会因目录已被清理而按"平台故障"报错）⇒
  **本版与旧版不构成平滑回滚对**，回滚必须同时恢复备份的数据目录（见发布说明）。

## 5. 被本次改动删掉的机制（连同其判据一起删）

- `assets.Store`（磁盘目录读写、符号链接防御、原子写、`List` 走盘）；
- 发布链路的 staging 目录与 `rename` 原子改名、按版本目录的 GC 删除；
- `appseed` 写版本资源目录、`releaseAssetsIncompleteReason` 的磁盘半边；
- `RewritePublicAccessAssets` 的磁盘半边（库内 `config_json` 的改写保留）。

## 6. 代价（如实认账）

- **冷加载多一次自定义段解析**：与"读 wasm + 编译"同一路径，实测可忽略；
  但**首次静态请求**（例如 CSS）在缓存未命中时会触发一次 wasm 读取 + 段解析
  （不触发编译）——由版本缓存摊销，空闲 TTL 后重新付一次。
- 常驻内存增加"资源字节 × 缓存里的应用数"，上限 4 MiB/应用，已并入模块缓存预算。
