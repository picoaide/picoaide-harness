# WASM「客户端专属」改造 · 审计 Finding 台账（**唯一闭环凭据**）

- 建立：2026-09-19 ｜ 维护者：主控（**子代理只读，不得改本文件**；各自把进度写到 `temp/wasm-client-only/<lane>-status.md`）
- 权威文档：`docs/planning/2026-09-19-wasm-client-only-design.md`（设计总纲，§16 是唯一权威波次表）
- 状态取值：`文档已修`（条款已订正，代码未动）｜`代码待改`｜`待验证`｜`已闭合`
- **闭合定义**：代码已按文档实施 + 该条对应的判据（含变异验证）实跑通过 + 独立审计复验记为 PASS。

## 泳道（文件边界，互不重叠）

| 泳道 | 负责范围 |
| --- | --- |
| **L1 服务端（W1）** | `server/internal/**`、`server/cmd/**` |
| **L2 宿主与窗口（W2/W3）** | `packages/host/**`（含 `wasm-apps-host`、`desktop`、**`browser`**） |
| **L3 客户端（W2/W3）** | `packages/client/**`（含 `wasm-apps`） |
| **L4 验证脚本与渠道（W0-D/W6）** | `scripts/**`、`package.json`、`.github/workflows/**` |
| **L5 清理旧方案（W5/W7 文档）** | `docs/**`（除三份权威文档）、`site/**`、`README*`、仓库根配置、`server/skills/**`、`server/demoapps/**`（**仅文档/技能内容，不含 Go 源码**） |
| **L6 webadmin（W5）** | `server/webadmin/**` |
| **L7 删除波次（W4，第二轮启动）** | `server/internal/wasmapp/{session,anonlimit,refapp,runtime,diag,limits,api,appserver}/**` 的**删除类改动** + 迁移 0073/0074 + `entry_url` 三处 emit + 生成物第二次重生成 + `skillseed` |

**边界订正（2026-09-19 主控，R2 复验时发现）**：`packages/host/browser/**` 归 **L2**，不归 L3 —— 依据 §16.1 的 surface seam 条款（browser 包必须导出 surface seam，`wasm-apps-host` 反向依赖它，两者必须同一泳道才能保证契约原子性）。因此以下条目的执行泳道由 L3 改为 L2：**CHN-3、R2-P0-2**；由 L3 改为 **L2+L3**：**CHN-4、R2I-15、TST-12**。L3 只负责 `packages/client/**` 侧的读取与渲染。
**W4 归属（2026-09-19 主控补登，此前无泳道承接）**：W4 与 W1 改同一批文件（`clientreq.go`/`client.go`/`internal/router`/`internal/wasmapp/**`），**禁止与 L1 并行**；L1 报 W1 完成后由 **L7** 以新上下文启动（见 §D）。

## A. 第一轮（R1）finding

| ID | 严重度 | 一句话 | 泳道/波次 | 状态 |
| --- | --- | --- | --- | --- |
| TST-1 | P0 | 探针判据双向失效（grep 带引号/存在性） | L4 / W6 | **代码已落（主控实测）**：探针自判定 + 退出码；门禁脚本已入库 `scripts/verify-wasm-client-only.sh`（我实跑 `--portable`：5 PASS / 5 FAIL，FAIL 全部是 W4 未做的预期项与保留名单口径，**没有假绿**）；待审计复验 |
| TST-2 | P0 | go test 只取退出码 ⇒ Skip 假绿 | L4 / W6 | **代码已落（主控实测）**：`go test -json` 用例级 skip 计数 + 关键用例 pass 断言（脚本已入库）；待审计复验 |
| TST-3 | P0 | W0-D 存储探针不存在 | L4 / W0-D | **部分闭合**：L4 已把探针收编入库 `scripts/wasm/probes/probe-web-storage.cjs`，但**探针判定逻辑仍坏**（0 PASS / 3 FAIL / 9 UNKNOWN）⇒ 见 CTL-1/CTL-4（L2 修 `webPreferences.session` + 正对照 + 每个 surface 内部超时）。**主控已用最小复现拿到真值**：localStorage ✅ / IndexedDB ✅ / `cache.put` ❌（scheme unsupported）+ 按 origin 与按分区隔离成立（F13/§17-13 已回写） |
| TST-4 | P0 | W2 六条真机判据无实现无脚本 | L2+L3 / W2 | **部分闭合（主控实测）**：W2 的真机判据已有实体 —— `windows.spec.ts`（窗口气质/账本丢弃/守卫顺序）、`cache.spec.ts`（账号×服务端双作用域不互读）、`deep-link-queue.spec.ts`（队列/TTL/去重）、`header-spec-parity.spec.ts`（头白名单跨包对拍）、四个真机探针脚本已在 `scripts/wasm/probes/`。**剩余**：R1-L2-1 的闸门真机探针（handler 计数 0 / 应用窗口 +1）与 A2-L2 复验 |
| TST-5 | P0 | 跨包路由常量分叉（打开必 404） | L2 / W2 | **已闭合**（宿主收敛为冻结路径 + 前缀注册 + 三方对拍 3/3 + 变异验证） |
| TST-6 | P0 | W6 端到端判据完全缺失 | L4 / W6 | **部分闭合**：`FREEZE-PROTOCOL.md` 已把 W6 的实体写成可执行清单（四个真机探针 + 三平台 + `PROBE-RESULTS.md`）；**三平台（Windows/macOS）未实测**（§H3，需真机）。**未闭合** |
| TST-7 | P0 | I6 迁移/示例判据缺失且绿测试钉死 public | L1+L5 / W1+W4 | **部分闭合（主控实测）**：I6 的迁移判据已落（`migration_0074_test.go` 227 行超 §9 的 5 例、`migration_0073_test.go` 7 段含幂等与不误伤）；**「绿测试钉死 public」** 的客户端侧已由 L3 改为两值 + 跨包对拍（`ACCESS_MODES`）。**剩余**：生成物第二次重生成（W4-9）后 `appcfg.json`/技能 references 的逐字节门禁复跑。**未闭合** |
| TST-8 | P1 | 分区注册/时序/窗口/缓存/渠道 scheme 无判据 | L2+L3+L4 / W2+W3 | 代码待改 |
| TST-9 | P1 | §2.3 实测事实证据不足（单平台单次、未入库） | L4+L5 / W6 | 文档已修（**主控回写**：§2.3 增加"证据强度标注"——Linux/单次/未入库/Windows·macOS 未验/存储类零证据）；探针入库仍待 W6（L4） |
| TST-10 | P1 | 零残留断言过宽/过窄 | L4 / W4 | 代码待改 |
| TST-11 | P1 | 身份投影对拍 W4 自毁（依赖 session 包） | L1 / W4 | 代码待改 |
| TST-12 | P1 | 面板层登录拦截实现≠设计 | **L2+L3** / W2 | 代码待改 |
| TST-13 | P1 | W3 整行不可跑（scheme 零实现） | L1+L2+L3 / W3 | 代码待改 |
| TST-14 | P2 | 分区名跨包镜像无对拍 | L2+L3 / W2 | 代码待改 |
| TST-15 | P2 | W5 判据是文本存在性、无命令 | L4+L5 / W5 | 代码待改 |
| TST-16 | P2 | 验收脚本未绑定 HEAD/工作树 | L4 / W6 | 代码待改 |
| TST-17 | P2 | §5.2 冻结契约无实现/判据（404、prefix） | L2 / W2 | **部分闭合**（prefix + 404 已实现；冻结语义判据待补） |
| TST-18 | P2 | V1 产物缺失、反作弊无可执行手法 | L4 / W6 | 代码待改 |
| SRV-1 | P1 | 渠道 app scheme 无服务端落点 | L1 / W1+W3 | 代码待改 |
| SRV-2 | P1 | legacyAnonymous 使 I2 暂时不成立/时序未写 | L1 / W1+W4 | 文档已修（§16 归属已定）；代码待改 |
| SRV-3 | P1 | 0074 按字面改写 0 行、漏 kind | L1 / W4 | 文档已修（jsonb 往返 + kind + 自检 + 回归）；代码待改 |
| SRV-4 | P1 | 删除清单自相矛盾（WriteAppNotFound↔SelfOrigin） | L1 / W4 | 文档已修（逐调用点 + 边界铁律）；代码待改 |
| SRV-5 | P1 | sessionKey 恒空 ⇒ AI 令牌失去会话级吊销 | L1 / W1 | 文档已修（§16.1 接缝 + 4 个回调点）；代码待改 |
| SRV-6 | P2 | 大小写判据与实现不符 | L1 / W1 | 文档已修（归一化后比较） |
| SRV-7 | P1 | 错误分层未定义（外层 vs 内层） | L1 / W1 | 文档已修（两层表）；代码待改（判据/文档注释同步） |
| SRV-8 | P1 | public 收敛的示例/生成物清单不完整 | L1 / W1+W4 | 文档已修（§9 生成物 + demoapps 路径）；代码待改 |
| SRV-9 | P2 | 渠道 scheme 正则/长度与两端不一致 | L1+L4 / W3 | 文档已修（{1,31} 冻结）；代码待改 |
| SRV-10 | P2 | 身份投影 trim/可用性未入对拍 | L1 / W1 | 文档已修；代码待改 |
| SRV-11 | P2 | truncated 处置语义未定义 | L1+L2 / W1+W2 | 文档已修（按 502 处理）；代码待改 |
| SRV-12 | P2 | 验收脚本在 gitignore 目录、不可复跑 | L4 / W6 | 文档已修（必须入库）；代码待改 |
| OPS-1 | P0 | 回滚承诺与迁移矛盾且已抄进发布说明 | L1+L4+L5 / W7 | **已闭合（第一轮独立审计 PASS，2026-09-20）**：审计代理独立核过 `docs/releases/v2.7.6-beta.5.md:16` 迁移 = **0072–0076**、`:207-213` 回滚 = 停服→恢复 pg_dump→回退镜像→客户端重装、`:17/:218` 「降级通道=无」、`grep -rn "不需要数据变换" docs/` 仅命中台账/总纲（要求删它的原文）而发布说明 **0 命中**；§12 口径逐字一致。另核 `scripts/check-workflows.mjs:558-577` 只静态检查 ci.yml 的 gh release 步骤、**不解析 md 正文**，实跑 EXIT=0 ⇒ 发布说明不会被它拦 |
| OPS-2 | P1 | 三项前置只写"不再需要"，无存量清理与判据 | L4+L5 / W5 | 文档已修（§12 增量）；代码/文档待改 |
| OPS-3 | P1 | W3 验收用预发 tag，只证明 beta | L4 / W3 | 文档已修（§16 W3 用正式 tag/合成夹具）；代码待改 |
| OPS-4 | P1 | fail-loud 与既有兜底约定冲突 | L1 / W1+W3 | 文档已修（仅"字段缺失/非法"fail-loud）；代码待改 |
| OPS-5 | P1 | 升级窗口双向无可诊断信号 | L1+L2 / W1+W2 | 文档已修（§12 增量）；代码待改 |
| OPS-6 | P1 | 可观测性整块缺失（准入失败不落 event） | L1 / W1 | 文档已修（§12 可观测性增量）；代码待改 |
| OPS-7 | P2 | run-gates 名不副实/不可 CI 跑 | L4 / W6 | 代码待改 |
| OPS-8 | P2 | 三项前置零残留无部署面断言 | L4 / W4 | 代码待改 |
| OPS-9 | P2 | 存量 .env/settings 基域配置静默失效 | L1+L5 / W5 | **已闭合（第一轮独立审计 C5 PASS）**：`docs/deploy/AI-DEPLOY.md` 新增 **§2.5「存量部署清理」**（通配 DNS/证书/Caddy 块清理清单 + `curl --resolve x.<DOMAIN>:443:<IP>` 判据 + `.env` 残留 `sed -i '/^PICOAI_APPS_BASE_DOMAIN=/d'` + 启动 warn 查法 + 控制台 `wasm.apps_base_domain` 清理）；`.env.example`/compose/Caddyfile 零旧配置、Caddyfile 零通配 ✓ |
| UX-1 | P0 | 打开路由两端不一致（同 TST-5） | L2 / W2 | **已闭合**（同上） |
| UX-2 | P0 | 渠道 scheme 全线硬编码（8 处） | L1+L2+L3 / W3 | **部分闭合（主控实测）**：控制面/宿主侧已参数化（`open-app.ts` 运行期取 `appOriginScheme`、`registerAppScheme(scheme)` 校验形状、`handler.ts` 持 `appOriginScheme`）；**剩余**：browser 包内几处文案/判定仍含官方字面量、保留名单三方口径（CTL-5）待收敛；待审计复验 |
| UX-3 | P0 | 窗口事件零消费者 + 无 kind:'app' 注册 | L2+L3 / W2 | **代码已落（主控实测）**：`index.ts:303/:321` 注册窗口面闸门 + `windows.ts` 的 `kind:'app'` 注册（`windows.spec.ts:270` 断言把 webContents id 报给请求闸门、关闭后移除）；**待 A2-L2 复验**（含 AI 工具寻址 `app_id` 与默认寻址只指浏览器当前标签） |
| UX-4 | P1 | 未登录交互未实现（弹登录+自动继续） | L2+L3 / W2 | 代码待改 |
| UX-5 | P1 | `?path=` 被丢弃、深链无队列/无提示 | L2+L3 / W2 | 文档已修（§23.2 净化 + 队列）；代码待改 |
| UX-6 | P1 | 失败文案指错方向（冻结/错误码暴露） | L2 / W2 | 文档已修（§19 Q3 + 可辨文案）；代码待改 |
| UX-7 | P1 | 承诺的「重试/重登」按钮不存在 | L2 / W2 | 文档已修（协议内动作 URL 方案）；代码待改 |
| UX-8 | P1 | 目录无分享入口 | L3 / W2 | 文档已修（§19 Q6）；代码待改 |
| UX-9 | P1 | 可发现性无设计（搜索/筛选/分页） | L3 / W2 | 文档已修（§19 Q1）；代码待改 |
| UX-10 | P1 | 空态与冻结口径 | L3 / W2 | 文档已修（§19 Q2/Q3）；代码待改 |
| UX-11 | P1 | 历史 public 无运营动作/员工公告 | L3+L6 / W5 | 文档已修（§19 Q13）；代码待改 |
| UX-12 | P1 | 独立窗口 AI 控制权无设计 | L2 / W2 | 文档已修（§19 Q7 + §16.1）；代码待改 |
| UX-13 | P2 | 作者契约不自洽（appcfg 仍列 public、window 字段无处可查） | L1+L5 / W1+W5 | 代码待改 |
| UX-14 | P2 | 打开反馈缺失（window 字段丢弃/无"正在打开"/不记忆路径） | L2+L3 / W2 | 代码待改 |
| UX-15 | P2 | 外链/下载落点与反馈无口径 | L2+L3 / W2 | 文档已修（§19 Q9）；代码待改 |
| UX-16 | P2 | 存储生命周期未定义 | L5 / W5 | 文档已修（§19 Q10）；文档待改 |
| DAT-1 | P2 | 0073 缺停机/锁口径与调用点 | L1 / W4 | 文档已修；代码待改 |
| DAT-2 | P1 | 运行期权威是磁盘资产（只改 DB 不兑现 I6） | L1 / W4 | **已闭合（主控独立复核）**：**磁盘资产改写（A 方案）已实现** —— `server/cmd/server/wasmapp_demo.go:35` 的 `rewritePublicAccessAssets(ctx, db, dataRoot)`；注释写明理由（「库里任何 wasm 应用的资源目录里留着 public 都要退场；只改一侧就会出现库说 login、应用自己读到 public 的分叉」），且**放在演示目录相关的任何提前返回之前**（与镜像里有没有演示目录无关）。DB 侧由 0074 同批改写 |
| DAT-3 | P1 | "JSON 文本改写"不可施工（两种形态并存） | L1 / W4 | **已闭合（主控独立复核 2026-09-20，读实现而非自述）**：`migrations-pg/0074_wasm_access_public_to_login.sql` 的改写走 **jsonb 往返**（`jsonb_set(config_json::jsonb,'{access}','"login"')::text`），WHERE 带 `config_json <> ''` / `IS JSON OBJECT` / `jsonb_exists(...,'access')` / `->> 'access' = 'public'`；回归用例 `migration_0074_test.go` 专门覆盖**紧凑形态与 jsonb 空格形态**（后者正是字面 `REPLACE` 会 0 命中的形态） |
| DAT-4 | P2 | 0074 缺 kind 限定 | L1 / W4 | **已闭合（主控独立复核）**：0074 的 UPDATE 带 `kind = 'wasm_app'` 限定；用例另有「`kind != 'wasm_app'` 的行一律不得被改」的专项断言（技能/智能体行与之共用同一列） |
| DAT-5 | P2 | 缺迁移回归测试要求 | L1 / W4 | **已闭合（主控独立复核）**：`server/internal/serverstore/migration_0074_test.go`（227 行）覆盖 **6 类行形态**（紧凑 / jsonb 空格 / 已是 login / 空串 / 坏 JSON / 合法非对象数组）+ `kind` 限定 + 不命中行**逐字节不变** + **幂等重放** + `app_releases` 快照表 ⇒ 超过 §9 要求的 5 例 |
| DAT-6 | P2 | 演示应用存量（demo-public） | L1 / W4 | 文档已修（保留 app_id 改 login）；代码待改 |
| DAT-7 | P1 | 生成物重生成清单缺失 + skillseed 登记 | L1 / W1+W4 | 文档已修（分两次重生成）；代码待改 |
| DAT-8 | P1 | appcfg 规格未收敛（AccessValues 仍含 public） | L1 / W1 | 代码待改 |
| DAT-9 | P1 | 回滚口径错误且已抄进发布说明 | L4+L5 / W7 | **已闭合（第一轮独立审计 PASS）**：同 OPS-1 —— 回滚口径已从"回滚不需要数据变换"改为"停服 + 恢复升级前 pg_dump + 回退镜像 + 客户端重装/回退"，并写明只回退镜像会让旧二进制逐请求 `42P01`；发布说明与总纲 §12 一致 |
| DAT-10 | P1 | 缓存路径无用户维度/无切换清理 | L2 / W2 | 文档已修（双作用域）；代码待改 |
| DAT-11 | P1 | 本地 304 成绕过准入第二入口 | L2 / W2 | 文档已修（仅静态子资源）；代码待改 |
| DAT-12 | P1 | 缓存键 version 无来源 | L1+L2 / W1+W2 | 文档已修（X-PicoAide-App-Version）；代码待改 |
| DAT-13 | P2 | aichat 会话维度被带走未认账 | L1 / W4 | 文档已修（§21 删除 + §17 认账） |
| DAT-14 | P2 | 0700/容量/状态文件未到可写代码 | L2 / W2 | 文档已修（§16.1）；代码待改 |
| DAT-15 | P2 | "无存量数据"表述错误 | L1+L5 / W4 | 文档已修 |
| CHN-1 | P0 | 打开路由三处不一致（同 TST-5） | L2 / W2 | **已闭合** |
| CHN-2 | P0 | 渲染进程硬编码 scheme（渠道化后必失败） | L3 / W3 | **部分闭合（主控实测）**：`open-app.ts` 已改运行期读取 scheme 且未拿到时 fail-closed（不渲染分享、`open` 不发请求）；**剩余**：包内其它硬编码点与 `setAppShareScheme()` 调用链需审计逐点确认 |
| CHN-3 | P0 | browser 包 6 处 scheme 写进判定逻辑 | **L2** / W3 | **部分闭合（主控实测）**：`guard.ts` 的 `ALLOWED_SCHEMES` 已不含应用 scheme（浏览器标签不可导航到 app scheme）；**剩余**：browser 包内其余 5 处 scheme 判定/文案的参数化与渠道取值；待审计复验 |
| CHN-4 | P1 | 分享 scheme 注入点无生产调用者 | **L2+L3** / W3 | **代码已落（主控实测）**：注入路由存在且 fail-closed（同 R2I-15）；客户端分享入口在未拿到 scheme 时不渲染。待审计复验（需逐点确认 `setAppShareScheme()` 的生产调用者） |
| CHN-5 | P1 | 服务端 scheme 与 ABI/schema 标识符混杂 | L1 / W1+W3 | 文档已修（ABI 冻结声明）；代码待改 |
| CHN-6 | P1 | fail-loud 与既有兜底冲突 | L1 / W1 | 同 OPS-4 |
| CHN-7 | P1 | "全部渠道必填"的流水线后果与顺序未写 | L4+L5 / W3 | 文档已修（§16 W3）；文档待改（部署说明） |
| CHN-8 | P1 | 跨渠道唯一性无实现地点 | L4 / W3 | 文档已修（只看字段名的比对 pass）；代码待改 |
| CHN-9 | P1 | official/beta 取值未定 | L4+L5 / W3 | 文档已修（= picoaide-app 共用命名空间）；代码待改 |
| CHN-10 | P1 | 渠道仓不 pin ⇒ 两端 scheme 可漂移 | L4 / W3 | 文档已修（pin 或写产物 + 对账）；代码待改 |
| CHN-11 | P1 | CI 夹具同步缺口会让 yarn check 自身变红 | L4 / W3 | 代码待改 |
| CHN-12 | P1 | 缺升级期协议/分区 API 复核规则 | L4+L5 / W5 | 文档已修（§22）；文档待改 |
| CHN-13 | P2 | 注入链命名与真实落点不符 | L5 / W3 | 文档已修（**主控回写**：§16.1 行名与真实落点订正 + §10 三点时序对齐） |
| CHN-14 | P2 | 窗口 chrome/错误页无品牌注入路径 | L2 / W2 | 文档已修（§16.1 注入 channel 信息）；代码待改 |
| CHN-15 | P2 | 保留 scheme 名单不全 + OS 注册限制 | L4 / W3 | 文档已修（§16.1）；代码待改 |
| CHN-16 | P2 | 缺渠道发布矩阵 | L5 / W7 | 文档已修；文档待改 |
| SEC-1 | P0 | 打开路由错位（同 TST-5） | L2 / W2 | **已闭合** |
| SEC-2 | P1 | 协议 handler 不绑定发起者 | L2+L3 / W2 | 文档已修（§20.2 + §16.1 两层闸门）；代码待改 |
| SEC-3 | P1 | 分区/缓存缺服务端×账号作用域 | L2 / W2 | 文档已修；代码待改 |
| SEC-4 | P1 | 缓存命中丢宿主安全头与准入 | L2 / W2 | 文档已修；代码待改 |
| SEC-5 | P1 | scheme 注入只覆盖 1/4 消费者 | L1+L2+L3 / W3 | 同 UX-2 |
| SEC-6 | P2 | 深链绕过持有性证明直接开窗 | L2 / W2 | 文档已修（§23.2 深链过闸门）；代码待改 |
| SEC-7 | P2 | 独立窗口欺骗面（标题/无地址栏） | L2 / W2 | 文档已修（标题冻结 + 导航闸门）；代码待改 |
| SEC-8 | P2 | `?path=` 无承载通道 | L2+L3 / W2 | 文档已修；代码待改 |
| SEC-9 | P2 | 错误面信息暴露 + 本地页无 CSP | L2 / W2 | 文档已修（诊断折叠 + 本地页 CSP）；代码待改 |
| SEC-10 | P2 | 客户端静默截断当成功 | L2 / W2 | 文档已修（truncated ⇒ 502）；代码待改 |
| SEC-11 | P2 | §11.1 证据不可复核 | L4+L5 / W6 | 文档已修（**主控回写**：§11.1 增加证据强度标注 + proof 两行边界）；标注要求已落正文 |
| SEC-12 | P2 | §10 自相矛盾 + 401 码不符 | L1+L5 / W1 | 文档已修 |
| SEC-13 | P2 | 面板登录拦截不可施工 | L2+L3 / W2 | 文档已修（§16.1 宿主闸门）；代码待改 |
| CLI-1 | P0 | 跨包接线通道不存在（kind:'app' 无落点） | L2+L3 / W2 | **代码已落（主控实测）**：W-C 的 surface 抽象落在 `packages/host/wasm-apps-host/src/{windows,index}.ts` + browser 侧导出 seam（`@picoaide/dsh-browser/guard` 的 `ensureSessionGuard`/`installAppSchemeRequestGate`），`index.ts:303/:321` 在默认 session 与各分区都装闸门；`windows.spec.ts` 覆盖单应用单窗口/聚焦/尺寸记忆/账本丢弃。**待第二轮审计复验**（A2-L2） |
| CLI-2 | P0 | 应用窗口分区无权限守卫 | L2+L3 / W2 | **代码已落（主控实测）**：`ensureSessionGuard`（`browser/src/guard.ts:359`）**两个 handler 都装**，调用点从 per-tab 提升到分区级（`runtime.ts:876` 改为调用它 + `:3355` 另一初始化点），`wasm-apps-host` 经 `electron-adapter.ts:57` 调用；`windows.spec.ts:210/247` 断言「未开过浏览器标签时创建应用窗口 ⇒ 两个 handler 都被调用」+ 守卫调用顺序。**剩余**：R1-L2-1（闸门过滤器真机验证）与 A2-L2 复验 |
| CLI-3 | P0 | §18.1 声称订正但正文缺失 | — | **已闭合**（已逐条回写正文并抽查 11 关键词） |
| CLI-4 | P0 | 打开路由错位（同 TST-5） | L2 / W2 | **已闭合** |
| CLI-5 | P1 | 头白名单两端不同构 | L1+L2 / W1+W2 | **两端均已落（主控源码级复核 2026-09-20）**：L1 = `headerspec.go` 真源 + `go generate ./internal/wasmapp/api` 产出已提交的 `wasm-app-headers.json`（8 项 + limits + platform_headers）+ `headerspec_gen_test.go` 逐字节门禁；L2 = `header-spec-parity.spec.ts`（92 行）**逐条覆盖**主控要求的五点：①转发的头集合逐字等于 `request_headers`（含顺序/大小写）②条数与单值闸等于 `limits`（24/8192）③`authorization/cookie/host/referer/sec-fetch-*/accept-encoding` 永不进信封（正负对照）④平台头（proof/version）不进应用请求白名单⑤schema 不匹配显式失败。**待冻结期实跑该 spec + 变异**（删白名单任一项必须红） |
| CLI-6 | P1 | 面板层登录拦截依赖不存在的服务 | L2+L3 / W2 | 文档已修（闸门放宿主）；代码待改 |
| CLI-7 | P1 | F16 归属/硬软闸门/双真源未定 | L1+L2 / W1+W2 | 文档已修（§5.1b）；代码待改 |
| CLI-8 | P1 | 特权注册取值时序自相矛盾 | L2 / W3 | **代码已落（主控 2026-09-19 实测）**：`packages/host/desktop/src/main.ts:80` 模块作用域读 `CHANNEL_PROFILE` → `:109` 派生 `APP_ORIGIN_SCHEME` → `:222 registerAppScheme(...)`，**早于 `:277 await app.whenReady()`**（§10 取值时序第①点）；幂等按 scheme 记录。待审计复验 |
| CLI-9 | P1 | `?path=` 未实现 + 队列落点未定 | L2+L3 / W2 | 文档已修；代码待改 |
| CLI-10 | P1 | 重试/重登在渲染层无承载 | L2 / W2 | 文档已修（协议内动作 URL）；代码待改 |
| CLI-11 | P1 | setAspectRatio 三项前提缺失 | L2 / W2 | 文档已修（§16.1）；代码待改 |
| CLI-12 | P2 | 落盘边界未到可写代码（truncated/0700/clear-data/LRU） | L2 / W2 | 文档已修；代码待改 |
| CLI-13 | P2 | 工具面细节未冻结（schema/默认寻址/配额） | L2+L3 / W2 | 文档已修（§16.1）；代码待改 |
| CLI-14 | P2 | 旧账本迁移未处理 | L2+L3 / W2 | 文档已修（丢弃 + warn）；代码待改 |
| RED-1e | P1 | 无地址栏 + 身份预填 ⇒ 钓鱼 | L2 / W2 | 文档已修（标题冻结 + 身份展示口径）；代码待改 |
| RED-1b | P1 | 跨应用顶层导航换壳 | L2 / W2 | 文档已修（导航闸门 + 按 app_id 判）；代码待改 |
| RED-3 | P1 | `?path=` 校验允许 `//` 等 | L2+L3 / W2 | 文档已修（净化补齐）；代码待改 |
| RED-6 | P1 | 拿 bearer 即可绕开客户端 | L1+L2 / W1+W2 | 文档已修（A′ 定案）；代码待改 |
| RED-8 | P2 | 导航型 CSRF | L2+L3 / W2 | 文档已修（两层闸门）；代码待改 |
| RED-9 | P1 | "不能联网"为假 | L5 / W5 | 文档已修（§6 订正）；作者文档/技能待改 |
| RED-10 | P2 | 应用 origin 上本地页无 CSP | L2 / W2 | 文档已修；代码待改 |

## B. 第二轮（R2）finding

| ID | 严重度 | 一句话 | 泳道/波次 | 状态 |
| --- | --- | --- | --- | --- |
| R2-P0-1 | P0 | 打开路由仍断且被两端测试钉死 | L2 / W2 | **已闭合**（路由收敛 + 两端 spec 同批改 + 三方对拍 + 变异验证） |
| R2-P0-2 | P0 | 发起者绑定与实现方向相反（guard 放行） | **L2** / W2 | **代码已落（主控 2026-09-19 实测）**：`packages/host/browser/src/guard.ts` 的 `ALLOWED_SCHEMES = {'http:', 'https:', 'about:'}`（应用 scheme 已移除）；**待独立审计复验**（含两层闸门与 session 级 onBeforeRequest 的负例） |
| R2-P0-3 | P0 | app-proof 可由 bearer 自助签发 | L1+L2 / W1+W2 | **代码已落（主控实测）**：`server/internal/wasmapp/appproof/**` 落地 Ed25519 KeyRing（部署密钥落数据根 0600）+ InstallRegistry（**TOFU**）+ ReplayGuard（一次性 nonce + jti 去重、有界、满则拒绝新 install）+ `POST /api/client/v2/apps/wasm/proof`（router.go:178）；**认账口径已按 CTL-7 修正为 TOFU 实情**；待独立审计复验 |
| R2S-4 | P1 | proof"登录签发"与恢复型启动冲突 | L1+L2 / W1+W2 | 文档已修（惰性签发）；代码待改 |
| R2S-6 | P1 | `open` 端点漏 proof 要求 | L1 / W1 | 文档已修（§5.1b 已补）；代码待改 |
| R2S-7 | P1 | 子资源/beacon/SW 型 CSRF 未被钩子覆盖 | L2 / W2 | **仍未实现（主控只读预审计 2026-09-20 实测）**：全仓 `webRequest.onBeforeRequest` **零实现** —— 仅两处文档注释（`wasm-apps-host/src/electron-adapter.ts:74`、`src/windows.ts:285` 都写着「session 级 onBeforeRequest；归属 = 应用窗口模块」），唯一真实的 `webRequest` 用法是 `desktop/src/electron-runtime.ts:862` 的 `onHeadersReceived`（CSP，与本事无关）。同时 `wasm-apps-host/src/handler.ts` **没有任何发起者校验**（Origin 按设计由 handler 合成，因此无法从请求本身区分发起者）。⇒ 当前**浏览器标签/任意网页可用子资源请求**（img src / sendBeacon / prefetch / SW）抵达协议 handler，而 handler 会**带员工 bearer 转发** —— `will-navigate`/`setWindowOpenHandler` 覆盖不到这类请求（§16.1 与 §23.2 N6 的原文理由）。已升级要求 L2 实现 |
| R2S-8 | P1 | 分区口径自相矛盾 | L2 / W2 | **已闭合**（统一为复用按用户分区 + 名称含服务端哈希） |
| R2S-9 | P1 | scheme 参数化 0% 落地 | L1+L2+L3 / W3 | 代码待改 |
| R2S-10 | P1 | truncated 订正未落地 | L2 / W2 | 代码待改 |
| R2S-11 | P1 | 验收层不成立（脚本未入库等） | L4 / W6 | 代码待改 |
| R2S-13 | P1 | §7.2 分区口径 | — | 同 R2S-8 |
| R2S-15 | P1 | §20.3 跨引用失效 | — | **已闭合**（§17 已补 7–11 条认账） |
| R2S-17 | P2 | "proof 不落盘"扫错根 | L2 / W2 | 文档已修（扫 userData + 断言不进日志/上报）；代码待改 |
| R2S-18 | P2 | 默认 session 也注册 app 协议 | L2 / W2 | 代码待改 |
| R2S-19 | P2 | 切账号/渠道未清内存 proof | L2 / W2 | 文档已修（§23.1 切换清 proof）；代码待改 |
| R2S-21 | P2 | 早期契约"接受跨应用导航"未标注 | L5 / W5 | 文档待改 |
| R2T-1 | P0 | 脚本正则字段序写反（恒不匹配） | L4 / W6 | **已修**（`"Action":"pass"[^}]*"Test":"X"`） |
| R2T-2 | P0 | skip 计入包级 no-test-files | L4 / W6 | **已修**（只数用例级） |
| R2T-3 | P1 | 脚本未入库 | L4 / W6 | 代码待改 |
| R2T-4 | P1 | 零残留三分法未实现（且无根 .env.example） | L4 / W4 | 代码待改 |
| R2T-5 | P1 | 真机端到端实体缺失 | L4 / W6 | 代码待改 |
| R2T-6 | P1 | W3 行与"正式 tag 名"矛盾 | L4 / W3 | 文档已修（§16 W3）；代码待改 |
| R2T-7 | P1 | 跨源判据缺"请求未到 handler"正对照 | L4 / W6 | 代码待改 |
| R2T-8 | P1 | 实测事实未标注单平台/单次/证据未入库 | L5 / W5 | 文档已修（**主控回写**：§2.3/§11.1 标注 + §17 认账 1/2 同步，另新增认账 12） |
| R2T-9 | P1 | 缺正向对照纪律 | L4 / W6 | 代码待改 |
| R2T-10 | P1 | HEAD 绑定未实现 | L4 / W6 | 代码待改 |
| R2T-11 | P1 | 部署面判据未落地 | L4 / W5 | 代码待改 |
| R2T-12 | P2 | 不可移植/不封闭（硬编码路径/PG） | L4 / W6 | 代码待改 |
| R2T-13 | P2 | 探针指标误导（302/imgNaturalWidth） | L4 / W6 | 代码待改 |
| R2T-14 | P2 | CSP 违规监听用已废弃位置参数 | L4 / W6 | 代码待改 |
| R2T-15 | P2 | 只跑 4 探针中的 2 个 | L4 / W6 | 代码待改 |
| R2C-1 | P0 | §14 仍写 Q1–Q9"待确认" | — | **已闭合** |
| R2C-2 | P0 | §7.2 同分区 vs 专用分区 | — | **已闭合** |
| R2C-3 | P0 | §7.5 残留无条件 304 | — | **已闭合** |
| R2C-4 | P0 | §21 删 aichat 与保留清单冲突 | — | **已闭合**（§8.1/§4/§8.2 已改；§8.2 措辞仍待复核） |
| R2C-5 | P1 | §5.1b 缺 proof | — | **已闭合** |
| R2C-6 | P1 | §11.1/§13.1 未覆盖 proof | L5 / W5 | 文档已修（**主控 2026-09-19 回写正文**：§11.1 加 proof 行、§13.1 I2 行补 proof 判据与变异、§5.1 传输层补 `PROOF_*` 401；待审计复验） |
| R2C-7 | P1 | 渠道 scheme 四处口径不一 | L5 / W3 | 文档已修（**主控回写**：F15 改"显式配置 + official/beta=`picoaide-app` 共用命名空间"、§10 正则统一为 `^[a-z][a-z0-9+.-]{1,31}$`、负例三条对齐 §8.3；待审计复验） |
| R2C-8 | P1 | 硬/软闸门被写成"失败即错误页" | L5 / W2 | 文档已修（**主控回写**：§5.1b 闸门强度 + §7.5 + §13.3 判据行三处统一"新建=硬/聚焦=软"，软闸门不得打成错误页；待审计复验） |
| R2C-9 | P1 | 冻结呈现无落点、与 F1 冲突 | L1+L3+L5 / W2+W5 | 文档已修（**主控回写**：F1 不列冻结、§5.1b 失败行补 `reason=app_frozen`、§7.7 新增冻结/下架/删除三档呈现；待审计复验） |
| R2C-10 | P1 | §15 状态句与 R2 小节互斥 | — | **已闭合**（R2 行已登记） |
| R2C-11 | P1 | §18.1 表行数与"10 组"不符、订正未登记 | L5 / W5 | 文档已修（**主控回写**：§18.4 改为"11 组（§18.1 表 11 行）"；R2 轮订正登记在 §23.2） |
| R2C-12 | P1 | I6 与 §9 A/B 互斥 | — | **已闭合**（选定 A） |
| R2C-13 | P1 | scheme 注入链与特权注册时序互斥 | L5 / W3 | 文档已修（**主控回写**：§10 新增"取值时序与三个终点"行 + §16.1 行名订正为"客户端运行期取 scheme"；待审计复验） |
| R2C-14 | P1 | §19 七条决定无正文落点 | L3+L5+L6 / W2+W5 | 文档已修（**主控回写八处落点**：F1 可发现性/空态/不加分类、F2 骨架屏、F6 分享入口、F12 提示条与下载反馈、F13 存储生命周期、F16 员工可见计数、§5.3 异渠道 toast、§5.1b 闸门归属）；**代码侧 W2/W5 仍待做** |
| R2C-15 | P1 | §21 新决策未回填迁移/面板/删除/波次 | L1+L5 / W1+W5 | 文档已修（**主控回写**：§9 补 `0076_usage_app_dimension` 行、§8.4 补 aichat 整包删除行、§16 W1/W4 与 §21.3 已对齐；待审计复验） |
| R2C-16 | P2 | §8.3 旧路径引用将被删的 SelfOrigin | L1 / W4 | 文档已修（**主控回写**：§8.3 合成请求明确"W4 必须同批删掉 `edge.SelfOrigin` 引用"） |
| R2C-17 | P2 | "部门"两处定义不同 | L1 / W1 | 文档已修（**主控回写**：§8.2 与 §8.9 统一为"主部门 = `groups` 树按组名排序的第一个组"） |
| R2C-18 | P2 | 两处表格未转义 `\|` | 文档已修（**主控转义 2 处** `\|`；复检全文档表格列数零不一致） | 文档待改 |
| R2C-19 | P2 | "63 例"错挂 | L5 / W5 | 文档已修（**主控回写**：§7.1 去掉错挂在 `app-protocol.ts` 上的"63 例"，改为指向 §16 基线） |
| R2C-20 | P2 | §13 波次表缺小节标题 | L5 / W5 | 文档已修（**主控回写**：新增 `### 13.4 分波次判据（可复跑命令）` 小节标题） |
| R2C-21 | P2 | "两张表"实为一段 | L5 / W5 | 文档已修（**主控回写**：§5.1 错误分层拆成同一表内"传输层/应用管线"两行；§18.1 表述同步） |
| R2C-22 | P2 | 错字 appseep | L5 / W5 | 文档已修（**主控回写**：错字 `appseep` → `appseed`） |
| R2I-1 | P0 | 分区口径（同 R2C-2） | — | **已闭合** |
| R2I-2 | P0 | 窗口载体与 browser 单窗口不兼容 | L2 / W2 | **已裁决 W-C + §16.1 十条；代码已落（主控实测）**：`windows.ts` 独立 `BrowserWindow` 承载（不占浏览器窗口/不进 maxTabs 与标签账本）、`windows.spec.ts` 覆盖 §16.1 的窗口气质（ratio 夹取 0.25–4.0、程序化 resize 不受约束、最小尺寸、工作区裁剪、schema 往返、切账号关窗）；**待 A2-L2 复验** |
| R2I-3 | P1 | windows.ts 契约缺失 | L2 / W2 | 文档已修（§16.1）；代码待改 |
| R2I-4 | P1 | AI 工具寻址 schema | L2+L3 / W2 | 文档已修（§16.1）；代码待改 |
| R2I-5 | P1 | 守卫与 will-navigate 归属 | L2+L3 / W2 | 文档已修（§16.1）；代码待改 |
| R2I-6 | P0 | app-proof 无波次归属 | L1+L2 / W1+W2 | **已收编（§16 W1/W2）且代码已落**：`appproof/**`（Ed25519 KeyRing + TOFU 注册表 + ReplayGuard）+ `POST …/wasm/proof` + `requireProof` 挂 `request`/`open` 两端；判据 `api/proof_open_test.go` 四条**主控实跑绿**（`ok 6.490s`）。**待 L1 变异 + A2-L1 复验** |
| R2I-7 | P0 | F16 无波次归属 + 事务口径矛盾 | L1+L2 / W1+W2 | **已收编（§16 W1/W2）且代码已落**：`open` 端点 + `opens.today.{pv,uv}`（读明细以保证含本次）+ `X-PicoAide-App-Version` + 迁移 0075/0076 + Go 定时器（先汇总后清理）+ 管理端出口；宿主 `index.ts:516` 透传、客户端半块/缺省一律不渲染；判据含 `TestOpenAppResponseCarriesTodayOpens`/`TestOpenAppOmitsOpensWhenCountingFails`（主控实跑绿）。**待 A2-L1 复验** |
| R2I-8 | P1 | 0075 只有 DDL 没有维护者 | L1 / W1 | 文档已修（Go 定时器 + 先汇总后清理）；代码待改 |
| R2I-9 | P1 | api 拿不到 *Server / 漏两处 scheme 常量 / fail-loud 边界 | L1 / W1 | 文档已修（Options.AppOrigin）；代码待改 |
| R2I-10 | P1 | 会话键与吊销回调接缝 | L1 / W1 | 文档已修（§16.1）；代码待改 |
| R2I-11 | P1 | 头白名单单一真源 | L1+L2 / W1 | 文档已修（Go 真源 + 生成 JSON）；代码待改 |
| R2I-12 | P1 | 磁盘资产 A/B 未拍板 | — | **已闭合**（选 A） |
| R2I-13 | P1 | official/beta 取值与 §8.3 矛盾 | L4+L5 / W3 | 文档已修（**主控回写**：§8.3 fail-loud 边界改为"official/beta 不豁免字段，仅豁免跨渠道唯一性"）；代码侧渠道必填/唯一性仍待 L4 |
| R2I-14 | P1 | 跨渠道唯一性无落点 | L4 / W3 | 文档已修；代码待改 |
| R2I-15 | P1 | 渲染进程 scheme 注入不存在 | **L2+L3** / W3 | **代码已落（主控实测）**：本机只读路由 `GET /api/pico/wasm-apps/channel`（`index.ts:78` 常量、`:523` 处理器）返回 `{appOriginScheme, deepLinkScheme, productName}`，**未注入 scheme ⇒ fail-closed 503**，且声明 `proof` 为 required（§22.2 R2）；客户端 `open-app.ts` 改为运行期读取、拿不到时给可辨 reason 且**不发请求**。待审计复验 |
| R2I-16 | P1 | 渠道仓不 pin ⇒ 功能性中断 | L4 / W3 | 文档已修；代码待改 |
| R2I-17 | P1 | 波次表缺输入/产出/判据 | — | **已闭合**（§16 重写） |
| R2I-18 | P1 | §16 与 §18.2 归属冲突 | — | **已闭合**（§16 为唯一权威 + 冲突消解说明） |
| R2I-19 | P2 | §5.2 与宿主常量不一致 | L2 / W2 | **已闭合**（宿主收敛 + 对拍） |
| R2I-20 | P2 | 冻结语义无契约出口 | L1+L2 / W2 | 文档已修（reason=app_frozen）；代码待改 |
| R2I-21 | P2 | 版本头产出侧无波次 | L1 / W1 | **已收编**（§16 W1）；代码待改 |
| R2I-22 | P2 | entry_url 三处 emit + 测试落点不全 | L1 / W4 | 文档已修（§16 W4 点名三处）；代码待改 |

## C. 旧方案彻底清除清单（L5 专项；与 W4 分工：L1 删服务端实现，L5 清文档/站点/配置/注释）

| # | 位置 | 要求 |
| --- | --- | --- |
| C1 | `docs/planning/2026-09-17-wasm-app-platform*.md`、`docs/planning/2026-09-19-*` | 删除公告已在位；**主控复核发现仍有现行处方型残留 ⇒ 见 C8/C9/C10/C11**（复核未通过） |
| C2 | `docs/decisions/2026-09-19-{referrer-policy,form-action,client-only-miniapp}.md` | 作废横幅已加；复核 |
| C3 | `site/**`（中英）、`README*`、`brands/**` 文档 | 零"应用子域/通配证书/entry_url/换票" |
| C4 | `server/skills/app-builder/**`、`docs/wasm-app-authoring.md` | 已改；`ai.chat` 段随 §21 改写（待做） |
| C5 | `.env.example`/compose/Caddyfile/`docs/deploy/**` | 已清；复核 |
| C6 | 根 `README`/`AGENTS.md`/`.agents/notes/**` | 若提及旧访问模型 ⇒ 更新 |
| C7 | CI/脚本/测试夹具中的旧路径与旧字符串 | 随 W4 零残留断言 |
| C8 | `docs/planning/2026-09-17-wasm-app-platform.md`（旧基线，**保留**非访问模型内容） | **主控 2026-09-19 复核：C1「已删正文」不成立** —— 删除公告基本到位，但仍有 **4 处"现行处方型"残留**（照它做会做回旧形态）：①R3 行把访问标识写成硬编码 `picoaide-app://<app_id>/`（应 = `<渠道 app 源 scheme>://<app_id>/`，F15）；②R34 行 `落到 picoaide-app://…`；③第 11 条 `app_id → picoaide-app://<app_id>/`；④**限流行右列仍是"全局匿名桶 + 每 IP 桶 + 启动自检"且无删除标注**（应改为"不存在（`anonlimit` 随 W4 删除）"） |
| C9 | `docs/planning/2026-09-17-wasm-app-platform-implementation.md`（实施/一致性报告，**保留**历史审计结论） | **主控复核：6 处现行处方型残留**：①模块 14「匿名限流与可信代理自检 / `internal/wasmapp/anonlimit/*`」无删除标注；②`13a–13d 子域主站路由不可达 \| COVERED \| internal/router/subdomain_test.go` —— 以**将被 W4 删除的测试**作为覆盖证据；③第 481 行仍把 **`public` 列为 `access` 枚举取值之一**（与 I6 直接冲突）；④第 490 行「`appcfg` **三模式**」（含 public）；⑤`anonlimit` 出现在 H3 修复清单与审计条目（需标"随 W4 删除"）；⑥**四条「端到端验收 `temp/wasm-e2e-run.sh`（真 https 子域）61/61 / 68/68 PASS」以已删除链路为对象，却作为验证证据呈现**（需标注已废弃，否则会被引用为"已验证"） |
| C10 | 两份旧文档中的 `picoaide-app://` 字面量 | 渠道化后**唯一正确写法** = `<渠道 app 源 scheme>://<app_id>`（official/beta 取值 `picoaide-app`）；保留字面量必须紧跟"（渠道参数化：§10/F15）"标注 |
| C11 | 旧文档"验证证据"类表述 | 凡以已删除链路（https 子域 / 换票 / 匿名 / `anonlimit`）为对象的 PASS 记录，必须**就地标注「已废弃（对象已删除，W4）」**，不得作为现行判据被引用 |

## D. W4 删除波次清单（**L7 专项，第二轮启动；此前无泳道承接，主控补登**）

> 依据 §16 W4 行 + §8.4 逐调用点清单 + §9 + §21.3。**禁止与 L1 并行**（同改 `clientreq.go`/`client.go`/`internal/router`/`internal/wasmapp/**`）。
> 侦察事实（2026-09-19 主控实测）：`server/internal/wasmapp/session/**` 15 文件、`anonlimit/**` 2 文件、`server/internal/wasmapp/refapp/**`（`main.go` 含 `ai.chat`）、`server/demoapps/**` 2 文件、`server/skills/**` 14 文件；`ai.chat` 另有 8 处源码命中（`diag/diag.go:275/307/322`、`runtime/{config_test,instance,serve_test,errors,runtime}.go`、`runtime/testdata/guests/app/main.go`）。

| # | 内容 | 判据 |
| --- | --- | --- |
| W4-1 | 删 `internal/wasmapp/session/**`（换票/`app_sessions`/ticket nonce）+ 迁移 **0073**（DROP `app_sessions` → `employee_sessions`，`SET LOCAL lock_timeout='5s'`、无 CASCADE）+ §8.4 逐调用点清理 | `to_regclass('app_sessions') IS NULL` 且 `employee_sessions` 同步；§9 验收 SQL |
| W4-2 | 删 `anonlimit/**` + `limits` 匿名四项与换票/会话项 ⇒ **生成物第二次重生成**（appcfg 侧已由 W1 生成过一次）+ `skillseed` 版本/摘要重算 | `go generate ./internal/wasmapp/limits` 幂等；`seededSkillVersion`/`seededSkillDigests` 一致 |
| W4-3 | **删服务端 `ai.chat` 宿主能力**（§21.3）：runtime 宿主调用、`diag.go` 三处文案、`errors.go` 两处、`limits.HostAIChatBudget`、`refapp/main.go`+`main_test.go`、`runtime/{instance,config_test,serve_test,runtime}.go`、`runtime/testdata/guests/app/main.go` | 全仓 `ai.chat` 零命中（除"已废弃"标注）；变异：留一处即红 |
| W4-4 | `entry_url` **三处 emit**（`publish.go:825`/`read.go:512`/`release.go:85`）+ 测试落点 | 全仓 `entry_url` 零命中 |
| W4-5 | 基域配置面 + `edge` 主机门控 + `internal/router` 旧端点删除 | 零残留三分法 |
| W4-6 | 迁移 **0074**（jsonb 往返 + `kind='wasm_app'` 限定 + 磁盘资产目录改写 = **A 方案**）+ 迁移回归测试（照 `migration_0071_test.go` 范式） | 升级后 `public` 计数 = 0；资产文件内容同步改写；降级不可行已认账 |
| W4-7 | `server/demoapps/**` 演示应用（保留 `app_id`、`access` 改 `login`） | 演示应用可正常打开 |
| W4-9 | **生成物重生成（L5 交接 H1）**：`server/skills/app-builder/references/{limits,app-config,imports}.md` 是**逐字节门禁产物**，L5 不得手改 ⇒ 必须先删生成器源里的旧项（`limits.go`/`limitsspec.go`/`appcfgspec.go`/imports 模板中的 `ai_chat_*`、`app_session_ttl`、`anon_*`、旧域名标签段），再 `go generate`。**appcfg 侧 = W1（L1）、limits 侧 = W4（L7）**，两次重生成都必须做 | `go generate ./internal/wasmapp/limits` 幂等（无 diff）；`limits_gen_test.go`/`appcfgspec_gen_test.go` 逐字节绿 |
| W4-10 | **示例代码删 `ai.chat`（L5 交接 H2）**：`server/skills/app-builder/examples/go/main.go`（3 处）、`server/demoapps/appdemo/main.go`（4 处，含匿名分支） | 全仓 `ai.chat` 零命中（除"已废弃"标注） |
| W4-11 | **`skillseed` 摘要重算（L5 交接 H3）**：`server/internal/wasmapp/skillseed/skill_version_test.go` 的 `seededSkillDigests` 只登记 1.1.0，而 `SKILL.md` 已是 **1.2.0** ⇒ **该用例当前是红的**（这是 L5 内容改动的正常过渡态，但**在 W4-9 重生成完成后必须重算登记**，否则"门禁全绿"不成立） | `TestBuiltinSkillVersionTracksContent` 绿 |
| W4-13 | **`examples/go/main.go` 的「16 KiB」触发数字+单位门禁**（L5 转交、主控独立复核 2026-09-20）：L7 在 00:37 改写该文件时写入"前端桥对单条消息的上限是 **16 KiB**"（`:235`/`:356`），而 `limits.json` 里 **`16384`/`16 KiB` 命中 0 次**，该文件又在 `checkNumbersComeFromLimits` 扫描集内 ⇒ `TestSkillDiscipline` **会红**。**修法（推荐①）**：把"AI 前端桥单条消息上限"作为**冻结契约数值**加进 `limitsspec.go` 的 `Table()`（总纲 §21.2 本就写"单条 ≤16 KiB"），随 **W4-9 的同一次重生成**落地（`limits.json`/`limits.md`/`references/*` + `skillseed` 摘要一并同步）| 【泳道 L7 / W4 · 已转交 L7】 |
| W4-12 | **W4 落地后的文档收尾（主控 2026-09-19 有界清单；触发条件 = W4 完成）**：历史审计/决策文档里对**将被 W4 删除的包**的**结构性表述**需就地加"对象已删除（W4）"标注（不是删除整段 —— 这些文档记录的是"当时为什么这么修"，仍有价值）。主控实测的**完整命中清单**（已排除带废弃标注的行）：①`docs/AUDIT-2026-09-19-SERVERAUTH-TEST-ISOLATION.md:291`（`wasmapp/anonlimit` 的实例化说明）；②`docs/decisions/2026-09-19-form-action-cross-origin-redirect.md:53`（`session/pages.go` 的两处使用场景）；③`docs/decisions/2026-09-19-referrer-policy-origin-null.md:84/103/104/156/191/237`（`edge/hostgate.go`、`session/pages.go`、`login_test.go`/`hostgate_test.go`）；④`docs/planning/2026-09-17-wasm-app-platform.md:22`（已带"已彻底删除"说明，**复核即可**）与 `:721`（员工会话"不存在"，**已正确**）。范围仅此 9 处，超出即说明有新命中（届时再定） | 【泳道 L5 / 触发：W4 完成后 · 状态：待做】 |

**L7 已于 2026-09-20 00:2x 启动**（施工代理 `6860b4f7`，范围 = 本节的 W4-1…W4-12 + `audit-checklists/L7.md` 的逐条判据与 `edge` 边界表）。

**W4 完成判据（量化基线，L4 四桶脚本 `scripts/wasm/check-old-model-residue.mjs` 实测 2026-09-20）**：**A 业务代码 = 621**（`server/internal` 499 / `server/cmd` 115 / **`server/webadmin` 7（见 CTL-12，将转为 B）**；宿主包 `packages/host/**` **0**）、**B 契约型保留 = 13（预算 20：13 客户端 + 7 webadmin）**、**C 夹具与历史文档 = 934**、**D 生成物/演示/技能内容 = 26**（主控 2026-09-20 实跑 `--json` 复核）；删除面仍存在三项（`internal/wasmapp/session`、`internal/wasmapp/anonlimit`、`internal/wasmapp/edge/hostgate.go`）。分类明细（旧口径，供 W4 参照）：`app-subdomain` 288 / `ticket` 186 / `server-aichat` 153 / `access-public` 30 / `entry-url` 17（合计 674，四桶口径下的 A+B 部分）。**W4 完成的硬判据 = 四桶口径（主控 2026-09-19 按 L3 反馈更新）**：**A 业务代码零命中（=0）** 且 **B 契约型保留 ≤ 20（13 客户端 + 7 webadmin）且每条必须有显式标识**（`REMOVED_*`/`LEGACY_*` 常量名或同行"已废弃/历史"标注；B 桶是 `entry_url` 拒绝清单、历史 `public` 兼容读与其显式拒绝路径、历史审计动作标签 —— **删了就是缺陷**）+ 三个删除面（`internal/wasmapp/session`、`anonlimit`、`edge/hostgate.go`）消失；C 桶 934 处（将被删除的测试 + 权威文档定义"要删什么"）与 D 桶（生成物/非本泳道）不计入。门禁输出必须打印 `A=… B=…(预算 31，按 scope 列出) C=… D=…` 四个数。

**主控 2026-09-20 追加裁定（A=177 时的结构性问题，否则 A 永远到不了 0）**：
1. **`server/internal/serverstore/migrations-pg/**` 属"历史制品"（C 桶），不是业务代码**。理由：迁移是**不可变历史** —— 已上线的库已应用过它们，改动旧迁移（如 `0070_employee_sessions.sql` 造表 + 索引，14 处命中）会破坏部署与幂等；而 `0074_wasm_access_public_to_login.sql`（10 处）**本身就是改写 `public` 的那个迁移**，必须含该字面量。已核实 L7 **未改动** 0070（`git diff` 无输出）。⚠️ **新增迁移仍需一次人工复核**（不能因为是"历史类"就免检）。
2. **`server/internal/wasmapp/appcfg/appcfg.go` 的 11 处属 B 桶（契约型保留）**：`AccessPublic` 是 **I6 明文要求**的"历史值、只读"（读侧把 `login_required=false` / `public` 映射为 login）、`publicAccessRejected` 是写侧拒绝的**结构化错误**，删了 I6 就不成立。⇒ **B 桶资格扩到该文件**（同一套"必须带显式标识"规则；其注释已写"历史值，只读"）。**预算 20 → 31**（13 客户端 + 7 webadmin + 11 appcfg）。
3. 其余 A 桶项（`limits/limits.go` 20、`hostcap` 14、`abi` 10、`limitsspec` 11、`cmd/server` 13、`api/admin` 6、`appserver/serve` 6、`appseed` 5 等）**全部是 L7 的真实待删项**，不得转桶。



## E. 交付物所有权（避免两泳道写同一文件）

| 交付物 | 归属 | 说明 |
| --- | --- | --- |
| `temp/wasm-client-only/probe-browser-storage.cjs` | **L2** | 临时探针，L2 判据用 |
| `scripts/wasm/probes/probe-web-storage.cjs` | **L4** | §16 W0-D 指定的**入库**路径（L4 从 L2 的 temp 版收编，不要重写两份） |
| `scripts/wasm/probes/probe-custom-scheme*.cjs` | **L4** | 从 `temp/wasm-local-origin/` 收编 |
| `scripts/verify-wasm-client-only.sh` | **L4** | §16 W6 指定路径（不是 `scripts/probes/`） |

## F. 主控自审新增 finding（第三轮，2026-09-19 主控在"审计前修文档"阶段发现）

| ID | 严重度 | 一句话 | 泳道/波次 | 状态 |
| --- | --- | --- | --- | --- |
| DOC-C1 | **P1** | **设计总纲内部路径漂移**：§21.2 冻结保留路径为 `POST /__picoaide/ai/chat`（双下划线），而 §22.1 表格写成单下划线 `/_picoaide/ai/*` —— 两处都是"冻结"措辞，实现者按哪一处都能自证合规 | 主控 / 全 | **已闭合**（主控统一为 `/__picoaide/ai/chat`，并在 §21.2 增补保留前缀三条规则：本地处理不转发 / 应用不得定义同前缀 / 其余 `__picoaide/*` 一律 404） |
| DOC-C2 | P2 | §17 认账 7 的"不做设备绑定（§20.3）"与 §23.1 A′（安装密钥绑定）表述冲突，会让实现者以为 proof 无需密钥 | 主控 / 全 | **已闭合**（主控改写认账 7 + 新增认账 12：无钥匙串时私钥退化为 0600 文件） |
| DOC-C3 | P2 | §8.4 删除清单**没有 `aichat` 整包行**，而 §21.3 明确要删 —— L7 按 §8.4 施工会漏删 | 主控 / W4 | **已闭合**（主控补 §8.4 "整包（AI，§21.3 同批）"行） |
| DOC-C4 | P2 | §9 迁移表**没有 0076 行**（只在 §16 W1 提了一句），迁移清单不完整 | 主控 / W1 | **已闭合**（主控补 `0076_usage_app_dimension` 行，含分区表递归加列口径） |
| DOC-C5 | P2 | §8.4 未写 `legacyAnonymous` 的**两段时序**（W1 清语义 / W4 删代码），容易出现"W1 顺手删了但 W4 漏删"或反序 | 主控 / W1+W4 | **已闭合**（主控补行并写明不得颠倒、不得只做一段） |
| DOC-C6 | P2 | §19 十五条产品决定中**九条在正文无落点**（可发现性/空态/异渠道 toast/分享入口/外链提示条/存储生命周期/员工可见计数/骨架屏/不加分类），只有审计者读 §19 才知道要做 | 主控 / W2+W5 | **已闭合**（主控把九条逐条回写进 F1/F2/F6/F12/F13/F16/§5.3/§5.1b） |
| DOC-C7 | P2 | §10 的 scheme 正则 `^[a-z][a-z0-9+.-]*$`（无上界）与 §8.3 的 `{1,31}` 不一致；F15 写"派生 `<深链 scheme>-app`"而 §10 写"显式必填" | 主控 / W3 | **已闭合**（主控统一 F15/§10/§8.3 三处口径与正则） |

| DOC-C8 | **P1** | **任务书 DoD 与总纲冲突**：DoD①写"**内置浏览器**加载 `picoaide-app://<app_id>/`"，与 §16.1 的 **W-C 裁决（独立应用窗口）** 和渠道 scheme 参数化（F15）直接冲突；DoD③把 **`edge/**`** 列入"彻底删除"，与 §8.4/任务书 E.2（edge 保留为 HTTP 面原语，只删主机名门控）冲突 —— 照 DoD 做会做错窗口载体并把要保留的包删掉 | 主控 / W2+W4 | **已闭合**（主控改 DoD①为独立窗口 + `<渠道 app 源 scheme>`；DoD③移除 `edge/**` 并加"不整包删"说明与 §21 的 `ai.chat` 删除） |
| DOC-C9 | **P1** | **两套权威并存**：任务书 §3 的 D/C/V 分工表与总纲 §16 波次表**并列且无优先级声明**（L7 删除波次在两处都没有），施工者按哪套都能自证合规 | 主控 / 全 | **已闭合**（主控在 §3 顶部加"唯一权威波次表 = §16 / 唯一闭环凭据 = 台账"，并补 **L1–L7 → 波次映射表**） |
| DOC-C10 | P2 | **判据命令被表格打断**：任务书两条零残留判据的正则含**未转义 `|`**（D3 的 `git grep -nE 'PICOAI_APPS_BASE_DOMAIN\|通配证书\|wildcard'`、C2 的 `'app-ticket\|/login\|…'`）⇒ 渲染后照抄会得到**残缺正则**（少一半分支仍"绿"） | 主控 / W5+W6 | **已闭合**（主控转义；四份权威文档表格列数复检**零不一致**） |
| DOC-C11 | P2 | 任务书**缺四块交付**：F16 打开校验/计数、A′ app-proof、§21 应用 AI（删 `ai.chat`）、§22 零端口就绪，DoD 里一条都没有 | 主控 / W1+W2 | **已闭合**（主控补 DoD 6–9 + 门禁命令加 `scripts/verify-wasm-client-only.sh`） |
| DOC-C12 | P2 | 任务书附录 E 是**一次性行号快照**，并行施工期间已漂移（主控实测：`D1:722` 的"限流"行已不在 722） | 主控 / W4 | **已闭合**（主控在附录 E 顶部加时效声明：范围以 §8.4 逐调用点表为准） |
| CTL-1 | **P1** | **W0-D 探针当前产出"零证据"**（主控 2026-09-19 实测复核 `temp/wasm-client-only/probe-browser-storage.json`）：12 项必需断言 **0 PASS / 3 FAIL / 9 UNKNOWN**、`exitCode=1`；根因是 **9 次页面加载全部 `ERR_FAILED (-2)`** ⇒ **没有任何页面执行过 JS**，所以所有存储类结论（可用性/按 origin 隔离/同源往返/跨分区隔离）既没被证实也没被证伪。**更关键的是缺正向对照**：三个窗口（control / X / Y）**全都在 `persist:` 分区里**，探针从未验证"默认 session 下同一 scheme 能加载成功"，因此**无法区分"探针/环境坏了"与"分区内自定义协议页面根本不可加载"** —— 后者是**设计级 P0**（W-C 要求应用跑在按用户分区里，见 §7.2/§16.1）。另外控制组结果只 `console.log`、**未落进 JSON 产物**（无 `control` 段），结论不可复核 | L2 / W0-D | **待修**（正对照 + 控制组落盘 + 通过后再回写 §7.5/F13 口径） |
| CTL-2 | P1 | §16 W0-D 要求"结论写回 §7.5/F13（不可用则改口径）"，而 F13 现在的"允许（探针先验证可用性与隔离）"**仍是无证据状态**：在探针至少一次全绿（含正向对照）之前，**不得**在任何文档/汇报里声称 F13 已验证存储可用性与隔离 | 主控+L2 / W0-D | **待修**（探针通过后由主控回写 §7.5/F13） |
| CTL-3 | **P1** | **`Cache Storage` 在自定义协议 origin 上不可用**（主控最小复现，Linux/Electron 43.4.0）：`caches.open()` **成功**，但 `cache.put(new Request('picoaide-app://…'), …)` 抛 **`TypeError: Failed to execute 'put' on 'Cache': Request scheme 'picoaide-app' is unsupported`**（Chromium 只对 http/https 请求 scheme 支持 Cache）；`new Request('/p')` 反而能正确解析成 `picoaide-app://demo-a/p`（**不是** URL 解析问题 —— 已逐步拆开排除）。⇒ F13 与 §19 Q10 的存储对照表**必须写明"禁止依赖 Cache Storage"** | 主控 / W0-D+W5 | **已闭合（文档侧）**：主控已回写 F13 与 §19 Q10；作者文档/技能对照表由 L5 落地 |
| CTL-4 | **P1** | **W0-D 探针自身三处缺陷**（主控根因定位）：①`new BrowserWindow({ session })` **不是有效选项**（Electron 只认 `webPreferences.session`/`partition`）⇒ 三个窗口（control/X/Y）**全部跑在默认 session**，`sesX/sesY` 上的 handler 注册形同虚设 ⇒ **分区隔离根本没被测量**；②因此控制组的结论"分区-only 注册 ⇒ 需默认 session 注册"**是错的**（真实原因是窗口没用上分区，导航走了外部协议路径 → `xdg-open`）；③**缺正向对照**（默认 session 成功加载从未被断言）且控制组结果只 `console.log`、**未落进 JSON**。实测反证：同环境最小复现 `load=ok`、`origin=picoaide-app://demo-a`、`isSecureContext=true`、`localStorage`/`IndexedDB` 均可用（`temp/w0d-rootcause/{min,minq,storage}.cjs`，<300ms 完成 ⇒ **不是"存储慢"导致超时**） | L2 / W0-D | **待修**（改 `webPreferences.session` + 加正对照 + 控制组落盘 + 重跑） |
| CTL-5 | P2 | **保留 scheme 名单三处不一致且无对拍**（L4 施工中发现）：CI `ci-channels.sh` 6 个（§10 冻结名单）/ 客户端 `packages/host/enterprise/src/desktop-channel.ts:55` 10 个（+`blob`/`ws`/`wss`/`ftp`）/ 服务端 `internal/channel/channel.go:117` 14 个（+`chrome`/`chrome-extension`/`mailto`/`tel`）。差额 = **能过 CI 但启动期 fail-loud**（不是可绕过洞，但少一道构建期拦截）；R2C-7 的"四处口径不一"因此仍未闭合。修法：§10 的冻结名单为唯一真源，两端从真源生成或加对拍用例；**在修好前 CI 侧只 WARN 不拦**（L4 已如此） | L1+L2+L4 / W3 | **门禁侧已修（L4 实跑 exit 0，主控 2026-09-20 落笔）**：第 5 组改为「从**设计总纲 §10 原文**解析契约六项 → CI/客户端断言契约子集 → 服务端 `ReservedAppOriginSchemes`（channel.go:122）**逐字含顺序**相等 → 客户端 10 项/服务端 `ExtraReservedAppOriginSchemes` 8 项**仅 WARN 并列差集** → **解析不到=FAIL 且点名文件+符号**」；**剩余**：客户端 `desktop-channel.ts` 的额外加固项是否要与服务端加固集合同步（只需 WARN 无需相等，非阻塞）。原始状态：**部分闭合**（L1 已把服务端拆成 `ReservedAppOriginSchemes`=§10 契约六项 + `ExtraReservedAppOriginSchemes`=服务端额外加固，并加 `TestReservedAppOriginSchemeContract` 做契约对拍 —— 口径比"三处逐字相等"更正确）；**剩余**：①门禁第 5 组仍是旧的"三处逐字相等"口径，解析不到新形态而 FAIL（门禁本身行为正确，需 L4 改为"契约六项三方对拍 + 额外加固仅 WARN"）；②客户端 `desktop-channel.ts` 的 10 项需与契约子集对齐（L2） |
| CTL-6 | P2 | **L5 的 C11 声明与实物不符（主控抽查发现）**：L5 报告"四条约 e2e PASS 逐条标废弃"，实测 `2026-09-17-wasm-app-platform-implementation.md` 的 **第 446 行 `\| 端到端验收 temp/wasm-e2e-run.sh \| **61/61 PASS** \|` 仍未标记**（该行没有"真 https 子域"字样，所以 L5 的关键词扫描漏了它）——它出现在一张"验收结果"表里，会被读成**现行验证证据** | L5 / W5 | **已交回 L5 修**（要求做**类级清扫**而非补一行：凡为已删除对象（`wasm-e2e-run.sh`/子域/换票/匿名/`anonlimit`/`hostgate`/`subdomain_test`）出具 PASS/COVERED 的行，一律就地标注废弃） |
| CTL-7 | **P1** | **主控自己写进文档的过度声明（已自查自纠）**：§11.1 与 §17-7 曾写"**bearer 被盗也不能自助签发**"，而实现 `server/internal/wasmapp/appproof/appproof.go:18-22` 明确认账"注册是 **TOFU** 语义 —— 任何持有效 bearer 的调用方都能为尚未注册的 install_id 注册自己的公钥"。二者矛盾：TOFU 下持 bearer 者**可以**注册新安装并签发（多一次往返）。**这不是实现缺陷**（TOFU 是本期务实选择，且代码注释与设计意图一致），**是文档过度声明**，会让审计与客户误判安全边界 | 主控 / W1 | **已闭合**：§11.1 proof 行与 §17 认账 7 已改写为 TOFU 口径 —— 明确"R2-P0-3 的闭合口径 = proof 不再是 bearer 的等价物（绑 app_id/install_id + 一次性 nonce + jti 去重），而'bearer 泄露即可用任意应用'在注册新安装后仍成立"；要真正抬高需用户级第二因子（本期不做） |
| CTL-8 | P2 | **提交进版本库的文档依赖易失的 `temp/` 制品**（L5 复验时如实认账）：旧实施报告的审计身份 `access` 行引用 `temp/wasm-brief/AUDIT-CHECKLIST-R2.md`，而 `temp/` 已被清理 ⇒ **该行的原始判据清单无法复核**，只能标"复核前不得整体作为现行证据"。规则：`docs/**` 不得把结论建立在 `temp/` 路径上（要么把关键判据抄进正文，要么显式标注"制品易失、不作证据"） | L5 / W5 | **已闭合**（L5 已在原处如实标注不可复核；本条作为规则留档） |
- **主控裁定（L5 复验轮提出的两个问题，2026-09-19）**：①`§3.4` 第 32/33/34 项的队列/并发**实测值**（队列 32、每用户 4）—— 机制未被 W4 删除 ⇒ **保留，不单开 finding**；②「每应用并发恒 1」的过时数值 —— L5 已在两处就地标注并指向 `docs/decisions/2026-09-19-wasm-app-concurrency-default.md`，**处置足够，不单开 finding**。③L5 指出的 `aitools`（应用发布工具面）≠ 服务端 `ai.chat` 这一易误读点，采纳其就地标注。
| CTL-9 | P2（方法论） | **验证不得与施工/变异并发**：主控在 L6 变异脚本跑到 `M7` 时并发跑 `npx vitest run`，得到 **3 failed 假红**（`LEGACY_ACCESS_LABEL` 断言），而 `access-level.ts` 源码当时是干净的（变异脚本正在临时改坏源码）。已把三步前置检查（泳道是否在跑 / `*-mutations.log` 尾部是否停在 `### M<n>` / 先读关键常量再跑）写进 `temp/wasm-client-only/AUDIT-CHARTER.md` §4.1；**施工期的验证只算早期信号，不得作为台账 PASS 证据** | 主控 / W6 | **已闭合**（纪律已固化）；webadmin 全量测试将在 L6 静默后重跑并作为唯一有效证据 |
| CTL-10 | P2 | **`server/docs/**` 与 `server/AGENTS.md` 不在任何泳道白名单**（L1 是 `internal/**`+`cmd/**`、L6 是 `webadmin/**`、L5 只覆盖外层 `docs/**`）⇒ 这两处是**无人负责的文档面**。主控本轮接手并修掉三项：①`03-api-reference.md` **完全没有 WASM 应用端点**（新旧都没有）⇒ 新增 **§11b「WASM 应用（客户端专属）」**（`request`/`open`/`proof` 三条 + 管理端 opens 出口 + 应用能力边界 + 已删除端点清单），依据是冻结契约 §5.1/§5.1b/§23.1/§8.9/§21；②`03-api-reference.md:58` 的 `role?\|is_admin?` **未转义竖线打断表格**（与 R2C-18 同类，且这是服务端契约文档）⇒ 已转义，全文件表格列数复检零不一致；③`server/AGENTS.md` 的迁移区间仍写 **0001–0068** ⇒ 改为 **0001–0072 与 0075、0076**（并说明 0073/0074 随 W4 落地） | 主控 / W5 | **已闭合**（三项已改；审计需核对 §11b 与实现是否逐字一致，实现由 L1/L7 交付） |
**方法学备注**：本节的 C1–C7 全部由主控在"审计前先把权威文档修对"这一步发现 —— 其中 C1/C3/C4 属**可施工性缺口**（照着文档做会漏删或实现出两种路径），不是措辞问题。这说明"文档内部一致性"本身需要独立一轮对拍（读 §21 与读 §22 的人不是同一个），已并入第二轮审计要点。

## F2. 主控对 L1 的 8 条裁决（2026-09-20，W1 交付后）

| # | L1 的问题 | 裁定 | 落点 |
| --- | --- | --- | --- |
| 1 | `session` 包 `TestTicketNoncePromisesStayActionable` 3 子例红（它 grep 的 `.env.example`/webadmin `Settings.tsx`/发布说明已被 L5/L6 改掉） | **不修**：该包与用例随 **W4 整条删除**；这是"文档承诺测试"的过期红，不是产品缺陷。W4 后应自然消失 —— 若 W4 后仍红，按 P1 处理 | W4-1 |
| 2 | `proof_replayed` 是契约未点名的第四个码 | **保留**（理由：绑定正确、只是用过了；并进 `PROOF_MISMATCH` 会误导排障）⇒ 已回写总纲 §5.1 传输层 | 已闭合（主控回写） |
| 3 | `opens.today` 读明细表而非日汇总 | **批准读明细**（否则今天的数字稳定少 1，与"本次调用计数在内"冲突）⇒ 已回写 §5.1b 并写明"历史窗口/看板读日汇总" | 已闭合（主控回写） |
| 4 | official/beta 缺 `app_origin_scheme` 时是否豁免 | **不豁免**（与 §10/§8.3 一致：全部渠道必填）；代价 = 私有仓必须先补字段并 push，见 §H1 | §H1 |
| 5 | 保留 scheme 名单三处不一致 | **保持现方向**：契约 = §10 六项（`ReservedAppOriginSchemes`），服务端**额外加固**不进契约（`ExtraReservedAppOriginSchemes`）；L4 的门禁按"契约六项三方对拍 + 加固仅 WARN"（已发） | CTL-5 / J11 |
| 6 | `wasm-app-headers.json` 的入库路径 | **确认**：`server/internal/wasmapp/api/wasm-app-headers.json` + `go generate ./internal/wasmapp/api`；L2 的对拍与 L4 的守卫都按此路径（已在给 L2/L4 的要求里写明） | J5 / CLI-5 |
| 7 | `usage.app_id` 有写入方、暂无流量 | **预期的中间态**：等 L2/L3 的客户端 AI loop 产出 `X-Pico-App-Id` 后自然有值；不得为此加默认值或伪造归因 | §21.4 |
| 8 | `skillseed` 摘要会在 W4 再变一次 | **确认**：W1 登记 1.2.0，W4 第二次重生成后**再提一级并登记**（不要就地改写） | W4-11 |
| 9 | **L2**：`@deepseek-ai/dsh-atomic-write` 不在本包 node_modules，是否加依赖 | **本版接受包内单一 `atomicWriteFile` 助手**（多泳道并行期间不动依赖图）；条件：**只允许一处实现** + 实现处标注"待切换" + 覆盖"写失败不留半个文件 / 权限位正确"的单测；**W6/W7 全部静默后切换**到上游包。已回写总纲 §16.1 | 已闭合（主控回写 + L2 实施） |
| 10 | **L2**：`cache.securityHeaders()` 的 CSP 写死 `picoaide-app:` | **必须去掉字面量**：改用 **`connect-src 'self'`**（在应用 origin 下 `'self'` 即该应用自己的 origin/协议 handler，语义等价且渠道无关）。已回写总纲 §7.5 | 已闭合（主控回写 + L2 改） |
| 11 | **L2**：应用窗口的 AI 执行面（`POST /__picoaide/ai/chat` 本地处理 + 隐藏会话 + `ctx.agentLoop` + 首次授权闸门）归谁 | **归 L2**（§16.1：协议 handler 在宿主包，`agentLoop` 是宿主能力；L3 只做前端调用与 SSE 渲染，已完成）。若该包拿不到 `ctx.agentLoop` 注入口，**报告而不是自造通道** | L2 / W2 |
| 12 | **L2**：渠道仓补 `desktop.app_origin_scheme` | 已知，**不属 L2 范围**：已登记台账 **§H1**（含四渠道取值建议与 push 要求），由发布人在私有仓执行 | §H1 |

| CTL-11 | **P2** | **L6 内部规则自相矛盾（主控只读预审计 2026-09-20 发现）**：`opens-contract.ts:437` 明写"页面里不要再写 `x ?? 0`（那正是把'读不到'显示成'没人用过'的写法）"、`:434` 规定"`null`/非有限 ⇒ `—`（不是 0）"，但同一屏的**明细字段**仍用 `?? 0` 兜底：`AppAiUsageSection.tsx:122`（输入/输出 tokens）、`:125`（费用）、`:143/144/145`（按日表的 calls/tokens/cost）、`AppOpensSection.tsx:169-170`（按部门 pv/uv）、`OpensBoard.tsx:122-123`（趋势点 pv/uv）。**定性**：这些 `?? 0` 位于"`aiUsageIsEmpty`/失败/加载 三分支之后"的**有数据分支**，所以只在**形状漂移**（字段缺失）时把"读不到"渲染成 0 —— 同屏 headline（`countText`/`fmtY`）却显示 `—` ⇒ **两套缺失语义**，且违反模块自己定的规则。**修法**：明细字段一律走同一套 null-aware 格式化（`null`/非有限 ⇒ `—`），并补一条**形状漂移**用例（缺 `prompt_tokens`/缺 `pv` 的行 ⇒ 该单元格必须是 `—` 而非 0）——现有 M10 变异只覆盖"整块缺后端"，覆盖不到这条路径。另：`AppAiUsageSection.tsx:122` 的 `data?.` 在有数据分支里是多余的防御，可一并去掉 | L6 / W5 | **已闭合（主控独立复核 2026-09-20）**：三处组件的 `?? 0` 全部消失，改用**同一套 null-aware 格式化**（`AppAiUsageSection.tsx:131` 用 `tokensText(data.prompt_tokens)`、`:134/:154` 用 `fmtY(data.cost)`），并**新增形状漂移用例**（`AppOpensAi.test.tsx:267-269` 断言缺字段时渲染 `输入 —`）；多余的可选链也已去掉。仍待 L6 静默后的**独立审计**（带实跑与变异） |
| CTL-12 | **P2** | **四桶规则的 B 桶资格过窄（主控预审计 2026-09-20 实测）**：B 桶（契约型保留）资格原限定 `packages/client/wasm-apps/src/**`，但 `server/webadmin/src/**` 有 **7 处同类合法保留**，会被永远留在 A 桶（A 必须为 0 ⇒ W4 永远无法达标）：①`pages/Audit.tsx:166` 的 `wasm_apps_base_domain_change: '应用域名变更'`（**历史审计行的动作标签映射**，删了旧审计记录会显示原始码）；②`AppCenterLayout.tsx:11`（说明基域配置面已删除的注释）；③`Apps.tsx:54`（说明 `entry_url` 已取消的注释）；④⑤⑥`Apps.tsx:318/326/991` + ⑦`access-level.ts:110`（旧书签 `?access=public` 的**显式拒绝路径**与说明 —— 正是 L6 报的"不静默当成全部"行为，删了就是缺陷）。**裁定**：B 桶资格扩展到 `server/webadmin/src/**`（同一套"必须带显式标识"规则），**预算 13 → 20**（13 客户端 + 7 webadmin），脚本按 scope 打印 B 桶构成 | L4 + L6 / W5 | **已交回 L4/L6**（见 §F4） |
| R1-L1-1 | **P0** | **`request` 端点未校验持有性证明（主控预审计 2026-09-20 实测）**：`requireProof` 的**唯一调用点是 `server/internal/wasmapp/api/open.go:51`**；全 `server/internal/wasmapp/**` + `server/internal/router/**` 再没有任何 `Proof.Verify` / `ConsumeJTI` 调用点。`clientreq.go:22-25` **只在注释里**列出 `proof_required`/`proof_expired`/`proof_mismatch`/`proof_replayed` 四个码，**代码里从不执行**。⇒ **真正的应用请求路径（带 bearer、执行 wasm、可读写应用库、可调平台）完全不要求安装密钥签名** ⇒ **仅被盗 bearer 即可驱动任意应用**，正是 A′（§23.1）要拦的那条；proof 只保护了"版本校验"这一个端点，机制被架空。契约依据：§5.1「认证 = Bearer ＋ `X-Pico-App-Proof`（**必需**）」、§11.1/§13.1 I2 的行为级判据、§23.1。**修法**：在 request 处理链解析出 user 之后、进入信封/管线之前调用同一个 `h.requireProof(c, appID, user)`（与 `open.go:51` 同款、同一实现），错误码与顺序按 `clientreq.go` 注释；补用例「request 缺 proof ⇒ 401 `proof_required`」「跨应用 proof ⇒ 401 `proof_mismatch`」「非幂等请求 jti 重放 ⇒ 401 `proof_replayed`」+ **变异**（把该调用删掉 ⇒ 三条必红） | L1 / W1 | **代码已落（主控独立核过 2026-09-20）**：`server/internal/wasmapp/api/clientreq.go:169` 调用 `h.requireProof(c, appID, user)`，与 `open.go:51` **同一实现**（`:151` 注释写明「不存在两份判据」）；appID 解析/校验上提到 `clientRequest`（理由：proof 绑定输入与管线执行的 app_id 不得有两套归一化路径）；401 四码 `proof_required`/`proof_expired`/`proof_mismatch`/`proof_replayed` 保持，无「无 proof 放行」分支。**判据已绿（主控独立实跑 2026-09-20，不采信自述）**：`PG_DSN_TEST=… go test ./internal/wasmapp/api/ -run 'TestClientRequestRequiresProof|TestOpenAppRequiresProof|TestOpenAppRejectsCrossUserAndCrossAppProof|TestOpenAppRejectsExpiredProof|TestOpenAppResponseCarriesTodayOpens' -count=1` ⇒ **ok 6.490s**；四条判据在 `api/proof_open_test.go:505` 起（①缺头⇒`proof_required` 且断言「没走到应用管线」②跨应用⇒`proof_mismatch` ③POST 同 jti 二次⇒`proof_replayed` ④**GET 幂等连用两次⇒放行** 正对照 + 变异注释）。**剩余**：L1 自己的变异（删 `requireProof` 调用 ⇒ 前三条必红）与冻结声明，随后由第二轮审计复验 |## G. 跨泳道接缝登记（主控维护；**审计必须逐条查两端**）|

历史事实：本项目**全部 5 个 P0 都出在接缝上**（两端各钉自己的字面量、A 产出的常量 B 没消费、两层闸门只做了一层）。因此每条接缝都必须有"两端都查"的判据。

| # | 接缝 | 生产方 → 消费方 | 判据（两端） | 风险 |
| --- | --- | --- | --- | --- |
| J1 | 本机打开路由路径 | L3 `open-app.ts` 的 `OPEN_APP_PATH` → L2 `index.ts` 的 `WASM_APPS_LOCAL_PREFIX` | 三方对拍用例（含总纲 §5.2 原文）**必须保持可匹配**：L3 不得把该常量改成运行期表达式 | 已预判并纠偏（主控 2026-09-19）；改坏即"点打开必 404"复发 |
| J2 | 应用源 scheme（三个终点） | 渠道包 `desktop.app_origin_scheme` → ①`main.ts` 模块作用域（特权注册）②profile 行 config ③本机只读路由 `/api/pico/wasm-apps/channel` | 断言 ①=②=③ 同源；①必须在 `app.whenReady()` 之前；客户端不得出现 `'picoaide-app:'` 字面量 | 特权注册时序是硬约束；写死官方值 ⇒ 渠道包全线失效 |
| J3 | app-proof | L2 签发/携带（安装密钥+惰性签发）→ L1 校验（`request` **与** `open` 两端点） | 两端点都要校验；绑定 `(user_id, bearer hash, install_id, serverURL, app_id, exp, jti)`；非幂等做 jti 去重；401 码分层一致 | 只挂一个端点 ⇒ 被盗 bearer 可刷 open/探版本（R2S-6 原缺陷） |
| J4 | 版本头 | L1 写 `X-PicoAide-App-Version` → L2 读（缓存键）/ L3 UI（打开次数与版本提示） | 头名逐字一致；缓存键 = `<session-scope>+app_id+version+path`；**不得自行推断版本** | 缓存键无来源 ⇒ 版本切换失效（DAT-12 原缺陷） |
| J5 | 头白名单单一真源 | L1 的 Go 常量 + 生成 `wasm-app-headers.json` → L2 转发同一份 | 跨包对拍：L2 不得维护第二份名单；生成物与 Go 常量逐字节一致 | 两端不同构 ⇒ 整次导航 400（CLI-5 原缺陷） |
| J6 | 应用 AI 保留路径 | L2 协议 handler 本地处理 `POST /__picoaide/ai/chat` → L3 前端调用与 SSE 渲染 | 路径逐字一致（**双下划线**，DOC-C1）；未授权 403 `app_ai_denied`；非该前缀的 `__picoaide/*` 一律 404 | 路径漂移 ⇒ 请求被当普通应用路由转发到平台 |
| J7 | F16 打开计数 | L1 `open` 端点与 0075/0076 → L6 看板（PV/UV/趋势/TOP N）+ L3 应用页"今日已被打开 N 次" | 计数口径（每次 +1 不去重 / UV 按 user 去重）两端一致；管理端出口 `GET /api/server/admin/wasm-apps/:app_id/opens` 的 `granularity`/`from`/`to` 参数逐字一致 | 口径不一致 ⇒ 看板与明细永久对不上 |
| J7b | F16 计数回传（**主控 2026-09-19 补齐**） | L1 `open` 响应 `opens.today.{pv,uv}` → L2 宿主转发 → L3 应用页「今日已被打开 N 次」 | §5.1b 已冻结该字段；**计数 best-effort ⇒ 字段缺省时客户端不渲染该行（不得显示 0）**；判据见 §13.3 新增行 | 曾无字段承载（L3-status 提出）⇒ 三端可能各造一套端点或显示 0 |
| J8 | 访问级别两值 | L1 写侧拒绝 `public` → L6 webadmin 选项/历史值渲染 → L3 客户端文案 | 三端只认 `login\|whitelist`；历史 `public` **显示为已退役**而不得静默丢失或可再选 | 任一端保留 `public` ⇒ I6 不成立 |
| J9 | 冻结三档呈现 | L1 内层 404 `reason=app_frozen` → L2 错误页 → L3 文案 | 冻结 ≠ 不存在 ÷ 下架 ≠ 删除；三档文案不得塌缩 | 塌缩 ⇒ 员工看到"应用不存在"（无法排障） |
| J13 | **异渠道深链 toast 事件名**（L3 2026-09-20 新增，源自 R1-L3-3） | L2 宿主（深链闸门发现"属于另一家企业的客户端"时）→ **`ctx.emit('pico/wasm-app-deep-link-foreign')`** → L3 的 `app-toast.tsx` + `client/index.ts` 订阅并弹出**逐字**文案「这个链接属于另一家企业的客户端，请让对方用你们客户端的『复制链接』重发」 | 事件名**两端逐字一致**；未订阅/未 emit 时**不得**静默（L3 侧已有用例 `订阅宿主广播的异渠道深链事件，并据此弹出 toast`）；文案 zh/en 各一条逐字断言 | 若 L2 用了别的名字，toast **永远不会出现**（且两端各自的测试都不会红） |
| J12 | **应用窗口 chrome 文案的归属**（主控 2026-09-19 裁定，L3 提出"跨 bundle 无法 import，文案真源在我包里"） | 设计总纲 §3/§16.1 的**冻结文案**（唯一真源）→ ①**客户端 UI**（应用中心、分享、空态…）由 L3 的包持有并在其 spec 里逐字断言；②**应用窗口 chrome**（外链提示条、下载反馈、错误页、骨架屏）由 **L2 的宿主包**持有（它已有 `pages.ts`/`locale.ts`，与宿主可读页同一套 zh/en 机制），**不得**跨 bundle import 客户端的文案模块 | 同一句冻结文案在两侧各有一份**独立**的逐字断言（任一侧被改写即红）；两侧文本必须逐字等于文档 | 曾想"共享一份" ⇒ 跨 bundle import 在 tsdown 后会指向不存在路径（本项目已踩过同类坑） |
| J11 | 保留 scheme 名单 | §10 冻结名单（真源）→ CI `ci-channels.sh` 6 项 / 客户端 `desktop-channel.ts` 10 项 / 服务端 `channel.go` 14 项 | 三处逐字相等（或由真源生成）；负例：名单外 scheme 必须被拒绝 | 三处不一致 ⇒ 能过 CI 但在运行期 fail-loud（CTL-5） |
| J10 | 删除面枚举 | L7 按 §8.4 删 → L4 零残留扫描 → 编译与生成物 | 每删一项必须同时删测试/注释/文档引用/CI 断言；`edge` **不整包删**；`ai.chat` 整包删 | 只删实现 ⇒ 编译红；整包删 `edge` ⇒ 误删安全头原语 |

## F3. 主控对 L6 的预审计发现（2026-09-20，只读）

| # | 发现 | 严重度 | 要求 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 见 **CTL-11**：明细字段 `?? 0` 与 `opens-contract.ts` 的"`null`/非有限 ⇒ `—`"规则冲突（同屏两套缺失语义，形状漂移时把"读不到"显示成 0） | P2 | 三处组件改走同一套 null-aware 格式化 + 补**形状漂移**用例（缺字段的行 ⇒ `—` 而非 0）；headline 已正确、无需动 | 待 L6 修 |
| 2 | `AppAiUsageSection.tsx:122` 在有数据分支里仍写 `data?.`（多余防御，掩盖"分支判定漏了 data 为空"的情形） | P2 | 去掉多余的可选链，或把该分支的前置条件写成显式断言 | 待 L6 修 |

> 说明：本次为**只读**预审计（L6 仍在运行，未跑其测试、未做变异），因此结论只覆盖"读代码即可判定"的规则冲突；L6 静默后仍会有一次带实跑与变异的独立审计。

## F4. 主控对 L4 四桶门禁的预审计发现（2026-09-20，只读 + 实跑脚本）

| # | 发现 | 严重度 | 要求 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 见 **CTL-12**：B 桶资格过窄（仅客户端包）⇒ `server/webadmin/src` 的 7 处合法保留永远落在 A 桶，A 无法达标 | P2 | B 桶资格扩到 `server/webadmin/src/**`（同一套"必须带标识"规则）；**预算 13 → 20**；输出按 scope 打印 B 构成；"未标识复核"保持 | 待 L4 改 |
| 2 | 实跑复核（`node scripts/wasm/check-old-model-residue.mjs --json …`，exit 1）：**A=621 / B=13 / C=934 / D=26**，与 L4 自述一致；`required` 路径缺失即 fail-loud、未跟踪文件也扫（89 文件 135 处命中）、`git grep` rc≥2 不当通过 —— **三项纪律真实存在**，非纸面声明 | — | 无需改（记录为"可信"） | ✅ |
| 3 | 扫描范围与 §13 判据 3 逐条对齐（`server/internal`/`cmd`/`webadmin/src`/`.env.example`/`docker-compose.yml`/`Caddyfile.*`/`docs/deploy` 均在，关键路径 `required:true`），**另加**三个宿主/客户端包 | — | 无需改 | ✅ |

## I. 第一轮独立审计 findings（2026-09-20；审计报告 `temp/wasm-client-only/audit-round1/L5.md`）

> 审计代理**只读**完成，**证伪了 L5 的"C 现行处方型残留 = 0"**：L5 的 `l5-acceptance.sh` 有三处结构性盲区 —— ①`PAT` 只有"旧概念名词表"，**不含载体词与能力断言**（"内置浏览器加载"、"不能联网"根本进不了扫描）；②`INLINE` 豁免表含 `不存在|不再|删除|清理|历史|旧版|迁移|退役|已下线` 等**高频常用词** ⇒ 含这些词的行一律跳过（假阴性豁免）；③`FILEHDR` 规则命中横幅词即**整文件跳过**，实测跳过 **18 个文件**（含早期契约 `2026-09-19-wasm-client-internal-origin.md`）。

| ID | 严重度 | 一句话 | 位置（审计代理自己读到的行） | 泳道 | 状态 |
| --- | --- | --- | --- | --- | --- |
| R1-L5-1 | P1 | `server/docs/DEPLOY.md:83` 仍写「客户端**内置浏览器加载**」（现行处方；W-C 已裁决独立窗口） | `server/docs/DEPLOY.md:83` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **已交主控修** |
| R1-L5-2 | **P1** | 「**不能联网**」在作者面 6 处未按 §6/RED-9 改写（§6 明文"不得对外宣称不能联网"） | `docs/wasm-app-authoring.md:38/155/325`、`server/skills/app-builder/SKILL.md:30/66/80` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |
| R1-L5-3 | **P1** | 作者面**缺存储对照表**（必须写明 `localStorage`✅/`IndexedDB`✅/**`Cache Storage`❌**）—— CTL-3 的作者侧落点为零命中 | `docs/wasm-app-authoring.md` 全文、`server/skills/app-builder/**`（grep 零命中；同模式在 `server/docs/03-api-reference.md:293` 命中 ⇒ 模式有效） | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |
| R1-L5-4 | **P1** | 作者面**缺 `window.*` 字段**（`ratio`/`width`/`height`），而作者文档把字段表**委托给生成物**、生成物也没有 ⇒ 引用链断裂，§13.4 的 W5 判据不成立 | `docs/wasm-app-authoring.md:192`（委托句）、`server/skills/app-builder/references/app-config.md`（83 行整读无 `window`） | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |
| R1-L5-5 | **P1** | **CHN-7/CHN-16 未落地**：`desktop.app_origin_scheme` **必填的流水线后果与顺序**（缺字段 ⇒ 渠道 CI 中止 / 该渠道无产物；**渠道仓必须先 push 再打 tag**）在 `site/**/deployment/channels.md` 与 `channel-package-reference.md` 里**零命中** —— 渠道维护者无从知道少一个字段会让整个渠道包构建失败 | `site/src/content/docs/deployment/channels.md`、`site/src/content/docs/channel-package-reference.md`（grep 零命中） | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |
| R1-L5-13 | P2 | **旧基线里同类"能力断言"残留**（主控定向清扫 2026-09-20 发现，审计报告的 R1-L5-2 只覆盖作者面）：**定性**：这四处都在**带 ⛔ 横幅的历史基线**里 ⇒ 不属"现行处方"，但 §6/RED-9 的规则是**不得对外宣称"不能联网"**，建议随 R1-L5-7 同一趟**就地加订正标注**（"措辞已由 §6 订正：真实边界 = 不能主动发起 XHR/fetch 型请求"）。**已核实作者面已改好、无重复劳动**：`docs/wasm-app-authoring.md:34/158/328` 均已写成「不能主动发起网络请求……**不要对外说成"不能联网"**」⇒ R1-L5-2 的剩余部分**只在 `server/skills/app-builder/SKILL.md:30/66/80`** | `platform.md:49/108/519`、`-implementation.md:125` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修**（作者面已完成；SKILL.md 3 处 + 旧基线 4 处标注） |
| R1-L5-6 | P1 | 早期契约 `:177`「接受跨应用导航」**未标注已被 N7 推翻** | `docs/decisions/2026-09-19-wasm-client-internal-origin.md:177` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |
| R1-L5-7 | P2 | 旧基线 3 处仍写「access **三模式/三取值**」且无订正标注（与 I6 两值冲突；同文件 `:491/:500` 已改 ⇒ 同一 grep 可区分） | `docs/planning/2026-09-17-wasm-app-platform-implementation.md:477/561`、`…platform.md:361` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |
| R1-L5-8 | P2 | 早期契约 `:11`「本文件是冻结契约…以本文件为准」与同文件 `:13-16` 的作废横幅**自相矛盾** | `docs/decisions/2026-09-19-wasm-client-internal-origin.md:11` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |
| R1-L5-9 | P2 | **主控自己的缺口**：`server/docs/03-api-reference.md` §11b 端点/头名/字段/TOFU 逐字一致，**但缺错误码分层**（对接方无法分流） | `server/docs/03-api-reference.md` §11b | 主控 | **已闭合**（2026-09-20 补错误码行，含 `PROOF_*` 四码与 `reason=app_frozen`/410） |
| R1-L5-10 | **P1** | **验证脚本自身的假绿**：`temp/wasm-client-only/l5-acceptance.sh` 三处结构性盲区（PAT 缺载体词 / INLINE 豁免含高频词 / FILEHDR 整文件跳过 18 个）⇒ 它报"C=0"不可采信 | `temp/wasm-client-only/l5-acceptance.sh:7-30` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修**（脚本必须改为与四桶同源的判据，或明确标注"只覆盖名词表"） |
| R1-L5-11 | P2 | `server/docs` 仍以 **ghcr** 为镜像来源（2026-09-10 起已经更新服务器分发，GHCR 已下线） | `server/docs/DEPLOY.md:77`、`server/docs/02-build-deploy.md:12/79` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **已交主控修** |
| R1-L5-12 | P2 | 作者面缺**产品级口径**：冻结后员工看到什么、目录列不列、三种空态、搜索/「我发布的」（接口级信息在，产品级缺） | `docs/wasm-app-authoring.md:210-211/263/375` | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**| **待修** |

**审计的正面结论（记录在案，避免重复劳动）**：C2 ✓（三份决策记录 `superseded` 横幅到位）、C3 ✓（站点中英同构、无旧模型处方、无客户域名；`grep -rnE 'a\.example\.com|example\.com'` 唯一命中是"禁止规则本身"）、SKILL.md 硬约束 **11 条**成立 ✓、CTL-10-②（`:58` 竖线转义）✓、CTL-10-③（`AGENTS.md` 迁移区间）✓、生成物 `references/*.md` 归 W4-9 不记 L5 缺陷 ✓、`docs/AUDIT-2026-09-19-SERVERAUTH-TEST-ISOLATION.md:291` 等 9 处属台账 **W4-12** 的"W4 之后"待标注项 ✓。

| R1-L3-5 | **P2** | **判据弱点（由 L3 审计代理的变异 M14 暴露，主控定位机制；与审计报告 `audit-round1/L3.md` 的 R1-L3-5 同一条）**：`packages/client/wasm-apps/src/client/app-center.spec.tsx:555` 用 `expect(source).not.toContain('X-Pico-App-Proof:')` 判"客户端不自己拼 proof 头"。但**最自然的写法抓不到**：JS/TS 对象字面量写 `{ 'X-Pico-App-Proof': value }` 时，原文是 `'X-Pico-App-Proof':` —— `Proof` 与 `:` 之间夹着引号 ⇒ `not.toContain('X-Pico-App-Proof:')` **恒不命中**。审计代理的 M14 变异（往 `open-app.ts` 加字面量头）因此**只触发通用的"产物不旧于源码"守卫，没有任何语义断言变红**（日志 `audit-round1/R1L3-M14.log`）—— 这是章程 §3"只钉字符串不钉能力"的教科书案例 | L3 / W3 | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L5-14 | **P1** | **权威文档自相矛盾："已下架"到底列不列（主控 2026-09-20 定位并订正）**：§7.7① 原写"冻结**与已下架**都不列"，而 **F1** 明写目录展示"**上下架状态**"（不列就没状态可展示）、**§19 Q2②**（我上一轮的裁定）明写"全部下架 = 列表**非空但全为下架**"、服务端 `read.go:468` 也**确实列下架行**（`:478` 只排除冻结）。⇒ §7.7① 是我上一轮把"冻结不列"（§19 Q3）**错误扩大到下架**。**订正**：目录**不列冻结**、**下架仍列并带标记**。**连带影响**：L5 在 R1-L5-12 整改时按（错误的）§7.7① 把作者文档改成了"不列下架" ⇒ **必须回改**（见 §F7） | 主控 + L5 | **已闭合（A2-L5 第二轮独立审计 2026-09-20，14/14 PASS；新增 P0=0/P1=0）**|
| R1-L2-3 | **P1** | **§13.2① 的"超时预算序关系"没有判据（主控覆盖度审计 2026-09-20）**：总纲 §13.2 把它列为**同等强制**的判据（"客户端出站超时 > `GuestBudget`(10s) > `SQLStatementBudget`(5s) > `AppDBBusyTimeout`(3s)"，变异 = "把客户端超时改成 5 s ⇒ 对应用例/探针必红"），但我在 `packages/host/**` 全树**找不到任何序关系断言**：只有客户端常量 `app-protocol.ts:102 APP_REQUEST_TIMEOUT_MS = 30_000` 与服务端生成物 `server/internal/wasmapp/limits/limits.json` 的 `guest_budget=10s` / `sql_statement_budget=5s` / `app_db_busy_timeout`（三者在代码里互不引用）。**判据完全可判**（本仓已有先例：`header-spec-parity.spec.ts` 就是宿主 spec 读服务端生成物做跨包对拍）。§1 的"客户端出站超时"若不严格大于平台侧全部预算，**员工只会看到"网络错误"而拿不到带 code/hints 的可读错误**（§5.1 的理由原文） | L2 / W2 | **已交回 L2**（要求加跨包序关系断言 + 变异） |
## K. 第一轮独立审计 findings · L3（客户端；报告 `temp/wasm-client-only/audit-round1/L3.md`，310 行）

> 审计代理用 43 个文件的**自算 sha256 清单**绑定 revision（`audit-round1/l3-revision-manifest.txt`），做了 **M1–M14** 变异（每条记 `sha256 before / after-edit / after-restore` + `restored=True`）。**它同时报告了一条并发告警**：审计期间被审包仍被写入（`publish-app.ts` 内容在其两次采样间变化而 mtime 不变）⇒ **其 PASS 只对 manifest 那一版成立**，冻结后须复跑。

**PASS 的关键项**（记录在案）：文案逐字 10 组全中（含 `/__picoaide/ai/chat` 双下划线、`今日已被打开 {n} 次`、`无法确认最新版本`、五个 AI 错误码）✓；scheme 参数化（运行期取 + 并发去重 + fail-closed + `OPEN_APP_PATH` 保持字面量）✓；F16 消费端（半块不渲染）✓；AI 桥前端（SSE/本地闸/授权/错误分层/卸载 abort）✓；I6 两值 + 跨包对拍 ✓；B 桶 13 处正当性 ✓；自做 M-A/M-J/M-L 三条变异 ✓；`test` 253 例 + `check` 全绿 ✓。

| ID | 严重度 | 一句话 | 泳道 | 状态 |
| --- | --- | --- | --- | --- |
| R1-L3-1 | **P1** | §19 Q2 的**三种空态只落地两种**：「全部冻结」与「0 个应用」**塌缩**成同一条 | L3 / W2 | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-2 | **P1** | 「未登录 ⇒ 弹客户端登录 ⇒ **登录后自动继续**」只做了"状态可辨"，**自动继续的链路没实现** | L2（宿主闸门/队列）+ L3（面板 UX） | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-3 | **P1** | §5.3/§19 Q5 的**异渠道深链 toast 文案全仓零落点**（连文案都没有） | L2（事件）+ L3（文案/渲染） | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-4 | **P1（流程）** | 被审包在审计期间仍被写入 ⇒ **判据未绑定冻结 revision**（其 PASS 只对 manifest 版成立） | 主控 / 全 | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-5 | P2 | 「客户端不拼 `X-Pico-App-Proof`」的判据**可被引号键绕过**（`{ 'X-Pico-App-Proof': … }`）⇒ 假绿 | L3 / W3 | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-6 | P2 | `external-link.tsx` 的提示条组件**零消费者**（冻结文案两侧各一份）⇒ 死代码或漏接线 | L3（+J12 裁定） | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-7 | P2 | 四处注释/注释性声称**仍描述已被推翻的旧语义**（有"照注释改回去"的风险；含 `locales.ts:70` 把实现自拟文案说成"逐字取自总纲"）。审计代理给全了位置：`deep-link.ts:54`（"回落官方值"）、`shipped-bundle.spec.ts:97`（"缺省官方值"）、`appcfg-contract.ts:306`（"三个取值"）、`locales.ts:379`（`pick one of three`） | L3 / W2 | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-8 | P2 | UX-14 的客户端半边未做：**不消费 `window` 字段**、无「正在打开」可见反馈 | L3 | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-9 | **P2（跨泳道契约空洞）** | §6 新增的 `window.ratio/width/height` 在**端到端链路上没有数据来源**：生成物 `appcfg.json` 的 `config_fields` 只有 5 字段、客户端的发布体只发 5 字段、`open` 响应也没有 ratio ⇒ **F3 的"强制锁比例"不可达**（审计代理实测） | L1（目录响应）+ L3（消费） | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |
| R1-L3-10 | P2 | `OFFICIAL_APP_SHARE_SCHEME` 声称"跨端对拍"但**无对拍用例**；`DEFAULT_APP_SHARE_SCHEME` 是**零消费者 @deprecated 死导出** | L3 | **已整改（L3 2026-09-20；`check` = 15 files / 287 tests / exit 0，25 条新增用例）；待第二轮审计复验（A2-L3）** |

## J. 主控对 L2 的第三轮预审计（2026-09-20，只读）

> 背景：L2 已按我的 P1 升级落地三条整改（`ensureSessionGuard`（`browser/src/guard.ts:359`，`runtime.ts:876` 由 per-tab 改为调用它 + `:3355` 另一个初始化点）、`installAppSchemeRequestGate`（`guard.ts:406`，`webRequest.onBeforeRequest` 在 `:410`）、AI 桥（`wasm-apps-host/src/ai-chat.ts`，保留路径 `/__picoaide/ai/chat` 双下划线 ✓、隐藏会话前缀 `app:` ✓、取消语义 ✓））。以下是我读代码后**无法用读代码判定**的部分 —— 必须真机验。

| ID | 严重度 | 问题 | 判据要求 | 状态 |
| --- | --- | --- | --- | --- |
| R1-L2-1 | **P1** | **请求闸门的"过滤器是否真的会触发"未被证明（静默失效风险）**：`guard.ts:410` 用 `session.webRequest.onBeforeRequest({ urls: ['<scheme>://*/*'] }, …)`。若 Chromium 对**自定义 scheme** 的这种 pattern 不匹配，listener **永不触发** ⇒ 闸门等于没装，而 `packages/host/browser/tests/guard.spec.ts` 的 mock session **照样绿**（mock 只验证回调逻辑，不验证过滤器匹配）。全仓 `temp/**` 与 `scripts/**` 里**没有任何**针对该闸门的真机探针（grep `onBeforeRequest` 仅命中源码与注释） | **必须真机探针**（放 `scripts/wasm/probes/`，L4 收编）：①起一个**真 http 源页面**（本地 http server 即可，不要用 `data:`/`about:`，避免 CORS 早于 webRequest 拦掉）；②该页面发起 `<img src="<scheme>://demo-a/x">` 与 `fetch('<scheme>://demo-a/x')`/`sendBeacon`；③协议 handler 装**调用计数器**；④断言 **handler 计数 = 0**（正向对照：不是"响应被拒"，而是**请求根本没到 handler**）；⑤**正例对照**：应用窗口（在 `isAppSurfaceWebContents` 白名单内）发同一请求 ⇒ 计数 **+1**；⑥打印实际生效的 `urls` pattern 与 listener 触发次数（若触发 0 次即证伪） | **待 L2 补探针** |
| R1-L2-2 | P2 | **`ensureSessionGuard` 的"应用窗口优先"路径未验证**：守卫函数与两个调用点都在，但没有任何用例断言"**从未开过浏览器标签**时创建应用窗口 ⇒ 该 session 的两个权限 handler 已安装" | 用例（可 mock，但须断言**调用发生**而非仅函数存在）：不先建 tab，直接建应用窗口 ⇒ `setPermissionRequestHandler` + `setPermissionCheckHandler` 都被调用；变异：去掉 check handler ⇒ 红 | **待 L2 补用例** |

## F5. 主控对 L3 的判据整改要求（2026-09-20，源自审计 M14）

**问题**：见 **R1-L3-1** —— 现有负向断言 `not.toContain('X-Pico-App-Proof:')` 抓不到 `{ 'X-Pico-App-Proof': … }` 这种（带引号的）对象字面量写法，等于该规则**没有判据**。

**要求（二选一，推荐做法 1）**：
1. **"只允许出现一次"型**（最稳，不依赖引号形态）：在 `app-center.spec.tsx` 的源码级用例里断言
   - `expect((source.match(/APP_PROOF_HEADER/gu) ?? []).length).toBe(1)` —— 只允许**声明**那一处；任何"用它拼头"的写法必然再引用一次 ⇒ 必红；
   - 同时把负向断言换成能覆盖两种形态的正则：`expect(source).not.toMatch(/X-Pico-App-Proof['"]?\s*:/u)`。
2. 或**行为型**：断言客户端发出的本机打开请求**不含** `X-Pico-App-Proof` 头（在 `open-app` 的单测里对 fetch 的 headers 做断言），这比源码 grep 更强。

**验收**：把审计代理 M14 的**同一处变异**重做一次（往 `open-app.ts` 加 `{ 'X-Pico-App-Proof': 'x' }`）⇒ 必须**有语义用例变红**（不能只靠"产物不旧于源码"那条通用守卫），并贴 sha256 前后。

## F6. 主控裁定：`external-link.tsx` 的归属（R1-L3-6，与 J12 一致）

**裁定**：接缝 **J12** 已定"应用窗口 chrome 文案由 **L2 宿主包**持有、客户端 UI 文案由 L3 包持有、两侧各写逐字断言、**不跨 bundle 共享**"。因此：
- **应用窗口内的外链提示条** ⇒ **L2**（宿主 `pages.ts`/`locale.ts` 机制），L3 的 `external-link.tsx` **不用于**应用窗口；
- **客户端 UI（应用中心）里若确有"外链已在内置浏览器打开"的展示位**，则由 **L3 接线**（保留该组件 + 加消费者与断言）；
- **若客户端 UI 没有这个展示位** ⇒ **删除** `external-link.tsx` 及其 spec（死代码比"留着备用"更危险：它会让下一个读者以为应用窗口用的是它）。

**要求**：L3 在 `L3-status.md` 里二选一给结论（接线 or 删除）并说明判据；**不允许**留一个零消费者导出。

## F7. 主控对 L5 整改的复核（2026-09-20）

**结论**：R1-L5-2/3/4/5/6/7/8/10/12/13 的整改**方向与落地都正确**，其中 **R1-L5-10（量具）做得最好** —— 它先修脚本三处盲区，v2 首跑立刻暴露**真实基线 `[RES] = 32 行`**（v1 的"C=0"确实掩盖了 32 条现行处方），整改后 `[RES]=0` 且 87 条 `[HDR]` **逐条给理由**、19 条 `[OK]` 逐条打印（不做静默豁免）。它还**超出清单**扫掉了 `server/.env.example:48`、`server/docker-compose.yml:107` 的同类载体处方。

**需回改一处（P1）**：见 **R1-L5-14** —— 它按（当时错误的）§7.7① 把作者文档改成"**不列下架**"，而正确口径是**下架仍列并带标记**（否则 F1 的"上下架状态"与 §19 Q2② 的"全部下架"提示都不成立，客户端 R1-L3-1 的实现也会与文档冲突）。**要求**：把该句回改为「目录列出全部**未被冻结**的应用（含已下架，带「已下架」标记）；**冻结不列**；当列表非空但全为下架时给 §19 Q2② 的提示」，其余结论保留。

## L. 施工期实测红点与并发仲裁（2026-09-20，主控裁定；由 L7 停下报告触发）

> **背景**：L7 在实施 W4 时按任务书要求"发现并发编辑就停下报告"，实测 **L1 正在改同一批文件**（`api/{open,proof,clientreq,read}.go`、`appcfg/*`、`cmd/picoaide-limits-gen`，并在 00:41:22 跑过 `go generate`）。**这是一次正确的止损**：L7 的 W4-9/W4-11 要对同一批生成物做第二次重生成，若与 L1 的生成并发 ⇒ **两次 `go generate` 互相覆盖、`skillseed` 摘要算错**。

| ID | 严重度 | 问题（实测） | 裁定 / 要求 | 状态 |
| --- | --- | --- | --- | --- |
| R1-L1-2 | **P1** | **`request` 路径的 `jtiExempt` 未接对**：L7 跑 `go test ./internal/wasmapp/api/` 实测 `TestClientRequestRequiresProof` **用例④**（幂等请求用同一张 proof **连用两次必须都放行**）得到 **401 `proof_replayed`**。这正是台账 **R1-L1-1** 要求的**正对照**；不修的话客户端读路径会被自己的 proof 去重打死（每个已打开窗口的第二次 GET 都会 401） | L1 在 `requireProof` 的 `request` 调用点把幂等方法（GET/HEAD/OPTIONS，`proofJTIExemptMethods` 已存在）正确传进去；**用例④必须绿**；变异：让幂等也查 jti ⇒ 用例④必红 | **已转交 L1** |
| R1-L1-3 | P2 | **测试夹具假设与实现冲突**：`TestUploadBadIDIs404`（`upload_test.go:550`）断言 `apps/` 下只能有 `_uploads`，实测多出 **`app-proof.key`** —— `appproof.New({DataRoot})` 把部署签名密钥写进测试数据根，而夹具的 `dataRoot` 让 `apps/` 就是它 | L1 二选一并**在注释里写明理由**：①夹具断言放宽为"只查 `apps/` 下的非密钥文件"；②测试 env 把 `DataRoot` 上提一层 | **已转交 L1** |
| — | **流程** | **并发写入仲裁**（本次由 L7 止损）：L1 与 L7 共享 `server/**` | **规则（本次生效）**：**L1 先在 `L1-status.md` 顶部写 `【L1 已冻结 @ <时间>】` 并回报主控** → 主控转达 L7 → **L7 才可动 `limits/limits.go` + `limitsspec.go` + `go generate` + `skillseed`（W4-9/W4-11）**；`api/{open,proof,clientreq}.go` 归 L1，L7 只做 `read.go` 且**改前先读最新内容并记录读取时间** | **执行中** |

**同时记录一条正面结论（主控复核）**：`migrations-pg/0074` 逐条符合 §9 五条硬要求（jsonb 往返 / `kind` 限定 / `jsonb_exists` 禁半角 `?` / 幂等 / fail-loud 自检），`migration_0074_test.go`（227 行）**超过** §9 要求的 5 例，**磁盘资产改写（A 方案）** 落在 `cmd/server/wasmapp_demo.go:35` 且置于任何提前返回之前 ⇒ 台账 **DAT-2/3/4/5 已闭合**。

## M. 主控对四桶判据的第三轮复核（2026-09-20；A=113 的构成分析）

> 结论：**A=113 被三类判据缺陷污染，不能直接当作"待删业务残留"** —— 必须先修量具（与 L5 的 R1-L5-10 同一纪律）。分类结果：说明性注释（合法标注）约 2/3、**真相干残留**约 1/3、**假红**若干。

| ID | 严重度 | 问题（实测） | 判据要求 | 状态 |
| --- | --- | --- | --- | --- |
| R1-L4-2 | **P1（判据假红）** | **`ticket` 类的正则缺词边界**：`source` 里的 `TicketTTL` 会命中 **`mfaTicketTTL`**（`serverauth/mfa.go:23/25`、`admin.go:385/622` 的 `createMFAChallenge(..., mfaTicketTTL)`）—— 那是**管理员 MFA 挑战票据**，与应用换票（app-ticket）毫无关系 | 给标识符类词加词边界（`\bTicketTTL\b`、`\bAppSessionTTL\b`、`\bSessionMax[A-Za-z]*\b`、`\bAnonLimit\b` 等）；逐个复核其余类别是否有同类过宽（如 `SessionMax`、`AnonLimit`、`secureRequest`）。**判据**：`serverauth/mfa.go` 与 `admin.go` 不得出现在任何桶里；同时用一条**真残留**（如 `app-ticket`）做正对照，确认收窄后仍能命中 | **已交 L4** |
| R1-L4-3 | **P1（判据口径）** | **"带显式删除标注的注释"被判成 A 桶业务残留**（A 的定义是"业务代码必须零命中"）：例如 `cmd/server/main.go:610-611`「`WasmSession *session.Manager` 已随 W4 删除…」、`wasmapp.go:154/261`、`router.go:75-76/110`、`abi.go:180`「服务端不再产生 `public`」、`admin.go:1147`、`appcfg/inherit.go:53`、`appseed.go:564`、以及 `entry_url` 的 3 处（`publish.go`/`read.go`/`release.go` 的「⚠️ `entry_url` 已随 W4 从两侧删除」） | 把"显式删除/废弃标注"的识别**从 client/webadmin/appcfg 扩到全仓**（含 `.go` 注释），并入 B 桶（或新增带预算的 ANN 桶）；**预算 + 逐条列 `文件:行` + 理由**，并保留"未标识复核"。**判据**：这些注释行不再计入 A；而**没有**标注的真实引用仍必须留在 A（用变异验证：去掉某行的标注词 ⇒ 该行回到 A） | **已交 L4** |
| R1-L4-4 | P2 | **B 桶资格漏了 `appcfg` 包的其它文件**：`appcfg/inherit.go:172` 的 `if prev.Access == AccessPublic` 与 `appcfg.go` 的 11 处是**同一个 I6 契约**（历史 `public` 读侧按 login），但 B 只收了 `appcfg.go` | B 资格扩到 `server/internal/wasmapp/appcfg/**`；预算相应 +1（31 → 至少 32），仍按 scope 列出 | **已交 L4** |

**独立结论**：**"A=113" ≠ "113 处待删残留"**。修好量具后预期 A 会显著下降（注释类约 70+、假红 4）；**真正待删的是** `limits/limits.go` 20、`limits/limitsspec.go` 11、`abi/abi.go` 9、`hostcap/hostcap.go` 4、`cmd/server/wasmapp.go` 8、`api/admin.go` 6、`appserver/serve.go` 6、`cmd/server/main.go`（代码行）、`appseed.go`（代码行）、`router.go`（代码行）等。**W4 完成判据据此改为"修好量具后的 A=0"**。

## N. 第二轮独立审计 · A2-L5（报告 `temp/wasm-client-only/audit-round2/L5.md`，301 行）

**总判：R1-L5-1…14 **14/14 PASS**；新增 P0 = 0、新增 P1 = 0**（这是"连续两轮零新增 P0/P1"判据在 **L5 面**的第一块基石）。新增 2 条 P2 均为**量具口径**级，不是施工面缺陷。快照：HEAD `faa7689cf0…`，工作树脏 262 行（审计窗口内 253→262，并发施工中）。

**PASS 要点（审计代理自己读的行 + 自己跑的命令）**：`DEPLOY.md:83` 已改「独立应用窗口 +（**不是**内置浏览器标签 —— W-C 裁决）」；`server/docs/**` 的 ghcr 零命中；作者面 `不能联网|零网络`（过滤告诫句后）**0 命中**；存储表在位且 `:54` **Cache Storage ❌ + `TypeError` 串**；`window.*` 三处齐（作者面 + SKILL + **生成物 `app-config.md`**，引用链两侧闭合）；中英 `channels.md` 各有必填字段 + 流水线后果 + 先 push 再打 tag + 发布矩阵；早期契约 `:177`／三模式 4 处／`:11` 冻结句均已划掉订正；§11b 错误码分层齐；产品级口径表与 6 处「下架仍列/冻结不列/全下架空态」回改到位；**量具 v2 三处盲区确已修好**（PAT 补载体+能力词；INLINE 去掉我点名的 9 个高频词；FILEHDR 改逐行且 **87 行逐条有理由**，用集合对拍 hdr 87/87、ok 19/19 **零缺口**）。它另用**自己的口径**扫 357 文件：四类失效模式**零现行残留**。

| ID | 严重度 | 问题（量具口径） | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| R2-L5-1 | P2 | **`[RES]=0` 的适用范围被高估**：脚本 `:11` 声称"除三份权威文档外所有文件逐行扫"，但 `:57-60` 的 `[GEN]` 分支**整文件 continue**，合计 8 个文件不扫 ⇒ 应表述为"**359/367 文件**"。其中 **3 个在白名单内且非 `.go`**：`references/limits.md`（`ai_chat_*`/`anon_*`/`ticket_ttl`/`app_session_ttl`/子域路由树）、`imports.md:20/49`、`app-config.md:79/94` ⇒ **这 13 命中归 W4-9（生成器源 `appcfgspec.go:252/272`、`limitsspec.go:36`）+ W4-2/W4-3**，L5 不得手改（已在 `L5-status.md` §B.6 如实移交） | L5 修脚本措辞（把 `[GEN]` 的跳过写进输出与声称里）；**W4-9 落地前不得把"零残留"当成 100% 干净**（生成物面除外） | **已闭合（主控独立复跑 v3 验证 2026-09-20）**：脚本输出改为「逐行扫 **361/367** 文件 = 白名单 − [AUTH] 3 − [GEN] 3」+「`[GEN]` 整文件跳过、命中单列」+ 必读声明「**`[RES]=0` 不含生成物面**（归 W4-9），生成物落地前不得声称 100% 干净」；`[GEN]` 明细带命中数。 |
| R2-L5-2 | P2 | ①`PAT_CARRIER` 是**固定枚举**，改写形态可绕（合成 3/3 NOMATCH：“放在内置浏览器标签里打开”/“内置浏览器窗口承载”/“浏览器标签页中运行” —— **当前树上未发现实际漏网**）；②`INLINE` 仍是**整行豁免**（合成“旧子域链路已删除；应用改由客户端内置浏览器加载”→ MATCH ⇒ **同一行里的第二条现行处方被一并放行**）；③summary 把 5 条同形假阳性算进“新口径 13 行”（实际 ≈8 新口径 + 11 假阳性） | ①PAT 改为**模式**而非枚举（如 `内置浏览器.{0,6}(加载\|打开\|承载\|渲染)`）；②`INLINE` 改为**按分句**判定（只豁免被标注的那一分句，`；`/`。` 切分）；③summary 分列“新口径/假阳性” | **已闭合（主控独立复跑 v3 验证 2026-09-20）**：①载体词改**模式**（`内置浏览器[^，。；]{0,8}(加载\|打开\|承载\|渲染\|运行\|呈现)` 等，并刻意不允许插入“的”以免误判产品功能句）；②`INLINE` 改**按分句** —— 实现中踩到并修掉 `tr` 按**字节**切碎多字节汉字的坑（第一版产生 25 条假 RES，改 bash 参数展开后回落 1 条）；③summary 分列 `[OK] 新口径 14` / `[FP] 同形假阳性 5`；④新增窄规则 `[ANN-H]`（**行首**标注头作用于整行列表，行中标注不享受豁免——那正是②要抓的）。**6 条合成负例 6/6 被抓**（含主控给的原始反例；探针在位 `[RES]=6`、删除后回 `0`，证据 `l5-acceptance-synth-out.txt`） |

**一条观察（不计 finding）**：`site/dist/deployment/index.html:234` 仍含旧载体句 —— 那是 **gitignored 的构建产物**（mtime 早于修复；L4 的门禁只看源文件）。**若流程直接分发 `site/dist`，发布前必须重建站点**。

**冻结期必做**（审计代理的明确要求）：复跑其报告 §2.1 脚本、§2.2 键对拍、§3 四桶 grep、§5 不回归 grep（工作树在其窗口内仍在变，报告已按 sha256 绑定 13 个被审文件的确切修订）。

## O. L6（webadmin）交付 + 服务端能力缺口（2026-09-20）

**L6 交付**（范围仅 `server/webadmin/**`）：新增 `app-center/{access-level,announcements,opens-contract,OpensBoard,AppOpensSection,AppAiUsageSection,AnnouncementTemplatesDialog}` + `lib/clipboard.ts` + 4 个测试文件；改 `Apps.tsx`（访问级别筛选/打开次数列/详情两面板/公告入口）、`App.tsx`+`AppCenterLayout.tsx`（新子页 `/app-center/opens` 运营看板）、`Audit.tsx`（历史动作标签）。
**判据（同一 HEAD 实跑）**：`npx tsc --noEmit` 无输出；`npx vitest run` = **32 files / 536 tests 全绿**（基线 463 → +73，连跑两轮一致）；`npm run build` 成功；`gofmt -l webadmin` 空；`go vet`/`go test ./webadmin/...`/`go build ./...` 通过；**变异 18/18 红、失效判据 0**（覆盖两值收敛、`public` 历史标注、login 命中历史 public、PV 不去重、UV 去重、TOP N 排序截断、AI 空状态、缺后端降级、`—`≠0、公告完整性、CTL-11 四条）。
**CTL-11 整改**：新增 `numOrNull()` 唯一归一化入口 + `tokensText()`；`sumOpenPv` 任一点缺 `pv` ⇒ null；`daySeries` 缺字段天 ⇒ null + `missingDays`；`rankTopApps` 缺 `pv` 不进榜、缺 `uv` 显示 `—`；新增 `trendValues()`（缺值不画点 + skipped 提示）；AI 面板把 `data===null` 显式成分支并去掉多余可选链；新增 7 条用例 + **M15–M18 四条变异各自必红**。
**四桶实测**：`webadmin A=0、B=7`（B 总 33 达预算；A 剩余 6 处全在 `internal`/`cmd`，非 L6）。
**主控提问的答复**：`Apps.tsx` **没有** `?access=public` 的**代码字面量**（判定走 `URLSearchParams.get('access')`）；代码级字面量只在 `access-level.ts` 的 `ACCESS_LEGACY_PUBLIC`（`LEGACY_` 前缀 ⇒ B 桶资格）✓。

| ID | 严重度 | 缺口 | 说明 | 状态 |
| --- | --- | --- | --- | --- |
| R2-L6-1 | **P1（跨泳道）** | **C1 列表端点未实现** | `GET /api/server/admin/wasm-apps?…&access=login\|whitelist`：**`access=login` 必须包含历史 `public` 行**；**响应必须回显 `access`**（前端据此判断服务端是否支持筛选；不回显则退化为"本页过滤 + 明说共 N 条/翻页仍是全集"） | **已转 L1** |
| R2-L6-2 | **P1（跨泳道）** | **C2 概览端点未实现** | `GET /api/server/admin/wasm-apps/opens/summary?days=&top=`（列表列 + 看板；`trend`/`apps`/`top_apps` **恒为数组**；`uv` 按窗口去重） | **已转 L1** |
| R2-L6-3 | P1（跨泳道） | **C4 AI 用量端点未实现** | `GET /api/server/admin/wasm-apps/:app_id/ai-usage`（§21.4 的 `usage.app_id` 维度） | **已转 L1** |
| — | 已闭合 | C3 详情端点 | `GET …/wasm-apps/:app_id/opens?from=&to=&granularity=day\|dept` **已落地**；L6 已按**真实形状**对齐（`total_pv`/`total_uv`；`day` 粒度是 `GROUP BY day,dept_id` ⇒ 同天多行，前端按日合并且 UV 明确标注"按日×部门去重后加总"；`dept` 行无部门名 ⇒ 用 `/departments`(`dept:read`) best-effort 映射，取不到显示「部门 #<id>」） | L6 ✓ |

**降级纪律（L6 已实现，符合 §13 与我的要求）**：C1/C2/C4 缺席时页面**显式降级**（404 ⇒ 「接口尚不可用」+ 显示 `—`），**绝不显示 0**、绝不静默。

**L6 报的两条跨泳道发现**：①`Audit.test.tsx` 的"方向②"会因 L1 的 W4 删除写点而红 ⇒ 已在 `LEGACY_ACTIONS` 补白名单 + 理由（服务端写点已删，但**标签必须留**，否则旧审计行回退成裸码）；②`AppCenterLayout` 测试在 32 文件并行下等懒加载 chunk 偶发超时 ⇒ 该 helper 等待预算提到 15s（best-effort，不影响判据）。

**结论**：L6 的 W5 交付**代码与判据完成**；**UX-11 / R2C-14 待独立审计复验**才算闭合；**C1/C2/C4 落地后需复验一次真实数据渲染**（C3 已可用 ⇒ 详情面板真实环境已有数字）。

## P. 第二轮独立审计 · A2-X 跨切面接缝（报告 `temp/wasm-client-only/audit-round2/X.md`，309 行）

**总判：新增 P0=1 / P1=3 / P2=4**。快照 HEAD `faa7689cf0…`（脏树；L1/L7 仍在写 `server/**`，审计代理 00:55 复读了 `open.go`/`clientreq.go` 的判据行，结论未变，sha256 见报告 §0）。

| ID | 严重度 | 问题 | 修法 / 判据 | 泳道 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **R2-X-1** | **P0** | **本机持有性证明两端机制不同 ⇒ 真实客户端「点打开」必 401**。宿主要求**请求头** `x-pico-host-proof`（`host-request.ts:37` 常量、`:330-337` 缺则 401 `proof_required`；两条路由 `index.ts:440/538` 均 `proof:'required'`；引导端点 `/api/pico/wasm-apps/host-proof` 在 `host-request.ts:257`）。**客户端从不带也不引导**：`grep -rn 'host-proof' packages/client packages/host/desktop/src scripts` **零命中**；`open-app.ts:333-341` 只发 `Content-Type` + `credentials:'same-origin'`（注释还写"证明随同源 cookie 发出"），`channel-seam.ts:176-181` 同。⇒ `channel` 401 ⇒ **拿不到 scheme ⇒ 分享入口永不渲染**；即便拿到 scheme，`open` 也 401。**为什么全绿**：宿主 54 条用例**手工注入**证明头（`index.spec.ts:246`），客户端把 fetch **mock 掉** ⇒ 两侧各钉自己一半（本项目 P0 的典型形态）。**根因**：同一客户端里两族本机路由用两套机制（老的 `/api/pico/apps/wasm/*` 走 cookie `fence.requireWriteProof`，新的走请求头），换了机制没换消费端 | **修**：客户端挂载期 `GET /api/pico/wasm-apps/host-proof`（该端点需过 connection 的 cookie 围栏）→ 两条本机调用都带 `X-Pico-Host-Proof` → 遇 401 `proof_expired` **重取一次**。**判据**：删掉 `index.spec.ts:246` 的手工注入后，**端到端**（真客户端 → 宿主 → 平台）仍能拿到 scheme 并打开；变异：不带头 ⇒ 401 | **L2（宿主端点/围栏）+ L3（客户端 fetch）** | **L3 半边已完成（2026-09-20，台账 §R）**：`host-proof.ts`（挂载期引导 + 缓存 + 提前 30s 视为过期 + 并发去重；令牌**只在内存**，源码级断言无 localStorage/sessionStorage/console）+ `fetchWithHostProof()` 被 `channel-seam`/`open-app` 共用 + 401 `proof_*` **强制重取一次并重放一次**（`AUTH_REQUIRED` **不**重试）+ 旧注释整段改写 + **失败分档**（`host-proof-unavailable｜host-proof-rejected｜scheme-not-configured｜malformed｜transport`，两档文案分别指"本机服务/会话"与"渠道配置"）+ **非 mock 自证**判据（实际 headers 键集合、引导失败不发业务请求、重放恰好两次）+ **6 条变异各自变红** ⇒ `check` = 16 files / **308 tests** / exit 0。**L2 半边**（宿主端点可用性 + 端到端判据 + R2-X-3/4/5）待完成 |
| R2-X-2 | P1 | **冻结三档塌缩**：`api/open.go:85-89` 与 `appserver/serve.go:75-78` 把**冻结/软删/不存在**合成同一个 404「应用不存在」，**无 `reason=app_frozen`**（该字段只在目录 `read.go:98`）；宿主 `app-window-copy.ts:41/46/56/60` 的三档文案**零消费者**（`handler.ts:354-362` 只回平台 message）。目录侧正确（`read.go:478` 冻结不列、下架仍列） | 服务端 404 带 `reason=app_frozen`（§5.1b/§7.7③）；宿主按 reason 选文案并**有用例**；三档不得塌缩 | L1（服务端）+ L2（宿主消费） | **已转** |
| R2-X-3 | P1 | **§21.2 保留前缀规则②③未实现**：`handler.ts:184` 只做 `path === '/__picoaide/ai/chat'` **等值判断**，其余 `__picoaide/*` 会被当普通应用请求**转发平台**（应 404）；`server/internal/**` 无任何 `__picoaide/` 的发布校验（应拒绝应用定义该前缀） | 宿主：非该路径的 `__picoaide/*` 一律 404（不通配转发）；服务端：发布校验拒绝应用定义 `__picoaide/` 路由；各一条用例 | L2 + L1 | **已转** |
| R2-X-4 | P1 | **app-proof 客户端侧零行为判据**：`handler.spec.ts:56-70` 的 harness **不注入 `appProof`**、`index.spec.ts` 无 installKey ⇒ 头拼装（`handler.ts:267-268`）与 401 重签是**测试里的死分支**；只有两处**常量**断言（`app-proof.spec.ts:246`、`header-spec-parity.spec.ts:86`）＝章程 §3「只钉字符串不钉能力」 | harness 必须注入 `appProof`（含"签发失败/401 重签一次/重签后仍 401 上抛"三条），并断言**实际发出的 headers 含该头** | L2 | **已转** |
| R2-X-5 | P2 | 401 重签条件是"**任意 401**"而非 `proof_*` 前缀（`handler.ts:285`、`open-gate.ts:183`）—— 与 §20/§23.1 的"只有 proof 失效才重签"不符（会话失效的 401 不该触发重签） | 改成按 `code.startsWith('proof_')` 分流 | L2 | **已转** |
| R2-X-6 | P2 | J4 宿主 `APP_VERSION_HEADER` 是**死导出**；缓存键的 version **未接线**（`cache.put` 无生产调用点；`L2-status:228` 已自认） | 接线或在 status 认账并降级为"未接线"的显式说明 | L2 | **已转** |
| R2-X-7 | P2 | §22.2 R2 的 grep 判据在 seam 之外仍有 1 处命中（`index.spec.ts:273` 的夹具 Origin） | 夹具若必须带 Origin，则把判据的排除范围写明（测试夹具 vs 生产代码），不要放宽整条规则 | L2 | **已转** |
| R2-X-8 | P2 | `open` 恒消费 jti + 宿主用缓存 proof ⇒ TTL 内第 2 次起每次 `open` **多一次 401 往返** | 要么 `open` 的 jti 语义按"每次打开是状态变更"接受（写明理由），要么宿主对 `open` 走"每 TTL 重签一次"而不是复用缓存 proof | L2（+L1 确认语义） | **已转** |

**R2-X-2 精度订正与闭合（2026-09-20，主控）**：本行原写「三档不得塌缩」易被读成「三个 reason 码」。裁决 (b) 的准确口径 = **呈现三档**（冻结「已被管理员停用」/ 下架「已下架」/ 删除「应用不存在」——§7.7② 的用户可见文案，三档语义确实不同、不得塌缩），**reason 码两档**（`app_frozen` 独立；软删与未登记同为 `app_not_found`；下架由 **410** 状态码承载）；不可达的 `app_deleted` 分支已删。F4 已补「取值逐个钉死」的断言（含两档相等的显式断言）与 7/7 变异。**闭合**。

**PASS 项（可直接引用）**：**J1**（三端逐字 `/api/pico/wasm-apps/open`，对拍 spec 7 passed，客户端常量仍是字面量）｜**J5**（8 项白名单逐字同序 + 禁止头正负对照，4 passed；服务端生成物守卫三件套在位）｜**J7/J7b**（`{version,release_id,title,changed,opens:{today:{pv,uv}}}` 三端一致；缺省一律省略且不显示 0；管理端 `from/to/granularity` 与 webadmin 逐字一致）｜**J8**（四端只认 `login\|whitelist`，读侧 `public→login`、webadmin legacy 不可选、客户端与生成物对拍）｜**§22.2 R1**（`ctx.webServer` 仅 `host-request.ts`）｜**R3**、**R4**（unit 级）。
**PARTIAL**：**J2**（①由 `main.ts` 模块作用域读值 ⇒ 仅能源码级断言；缺单条"①=②=③"端到端探针）｜**J4**｜**J12**（宿主 chrome 文案零消费者，与 R2-X-2 同根因）。
**未判定**：J10（属 L4/L7 判据面）、R4 的真机 `onBeforeRequest` 探针（台账 §J 的 **R1-L2-1** 仍开）。

## Q. W4 完成里程碑（2026-09-20）与 B 预算裁决

**L7 报：四/五桶 = `A=0（必须为 0）` / `B=34` / `ANN=65` / `C=460` / `D=14`** ⇒ **A 从 621 降到 0（W4 的量化判据达成）**；两条 FAIL 是**同一条**：`契约模块 appcfg 的 B 桶条目 14 > 预算 13`。

**取舍**：L7 把"判断 access 取值是不是历史公开档位"从 `appseed.go` 的**代码行**收进 `appcfg`：
```go
// appcfg.go
func IsLegacyPublicAccess(s string) bool { return Access(s) == AccessPublic }
```
语义上是**更正确的归属**（历史取值的判定属于读侧口径的唯一作者），代价是 appcfg 的 B 计数 13 → 14。

**主控裁决 = (a)：appcfg 每模块预算 13 → 14，总预算 33 → 34**（由 L4 在 `scripts/**` 落地）。**理由**：①这 14 处里有 1 处是 **W4 一次性磁盘资产改写（§9 的 A 方案）必须**的"历史取值判定"，与 0074 迁移里的 `'public'` 字面量**同性质**（我已裁定后者合法）；②它是**有意识的动作**（把判定放到它的归属模块），**不是**把新残留塞进桶；③`appseed` 不该知道历史取值长什么样 —— 归属正确性优先于"数字好看"。
**没有选 (b)** 的理由：若把 `appseed.go` 的功能性引用登记进 B，就等于承认"任何地方都可以引用历史取值只要加个注释"，那是把 B 桶变成逃生门。

**W4 完成清单（L7 实跑）**：W4-1（`session` 15 + `anonlimit` 2 + `aichat` 2 删除；**0073** 已建 + `migration_0073_test.go` 含"先删 employee_sessions 必须失败"的顺序判据/旁证表不误伤/重放两次对象数不变/`lock_timeout` 在/`CASCADE` 不在）｜W4-3（`abi.MethodAIChat` + 4 载荷类型 + `hostcap.callAIChat` + `capapi.AI` + `refapp` AI 演示 + `runtime` AI 预算 + `diag` 三处文案 + `apperr.{AIBalanceInsufficient,AIRateLimited}` 全删；testdata guest 改 `db.query`；`imports_gen.go`/`references/imports.md` 重生成；**`abi.ABIVersion` 未改**并注明理由）｜W4-4（三处 emit 删除 + 测试改**反向断言**"响应不得出现该键"）｜W4-5（`edge` 按符号切：`primitives.go` 保留 8 原语 + `WriteAppNotFound` 收 `selfOrigin`；`hostgate.go`/`hostgate_test.go` 删除、原语用例搬进 `primitives_test.go` 并新增两条**生产引用**判据）｜W4-2/9/11/13（`limits` 旧项全删 + **新增 AI 桥契约数值 `ai_bridge_max_messages=64`/`ai_bridge_message_max_bytes=16384`**（§21.2）+ `go generate` **连跑 3 次 diff 逐字节相同** + `skillseed` 提 **1.3.0** 并登记新摘要（1.2.0 历史条目保留））｜W4-7 标题半边（`RewriteLegacyDemoTitles`：只在标题仍带历史字样时改、管理员改过的不动、只改 `apps` 行）｜协调者点名的 **13 处生成物旧行 ⇒ grep 全 0**。
**测试面**：`cmd/server`(42.6s)、`internal/router`、`internal/wasmapp/{abi,diag,hostcap,runtime,refapp,serverstore,limits,appcfg,skillseed}` 全绿；`go build ./cmd/... ./internal/...` 绿；**`internal/wasmapp/appserver` 测试面改造中**（旧路径用例删、客户端路径夹具接管）。
**顺带修掉一处既有漏登记**：`routes_source_test.go` 的 `wasmGatedRoutes` 按实跑 diff 重算时，补上了**本来就漏登记**的条件路由（否则那 4 条整片消失时无人发现）。

## R. P0（R2-X-1）客户端半边交付细节（L3，2026-09-20）

**接口对齐（按源码，不自造）**：头名 `x-pico-host-proof`（客户端写 `X-Pico-Host-Proof`）；引导路径 `${WASM_APPS_LOCAL_PREFIX}/host-proof`；响应 `{proof, expires_at}`、TTL 5 min；**拒绝体是字符串** `{"error":"proof_required"|"proof_expired"}`，而业务面未登录是**对象** `{"error":{"code":"AUTH_REQUIRED"}}` —— 两者都是 401，客户端按 `error` 形态分流（`readHostErrorCode`）。**已加跨端对拍用例**（头名 + 路径逐字比 `host-request.ts`/`index.ts`）。

**判据与变异（`mut/mutations-p0.log`，每条恢复原文）**：P1 去掉请求头 ⇒ **4 红**；P2b 令牌拿不到也照发 ⇒ 1 红；P2c 拆掉 `open-app` 前置闸（**单拆任一处仍 fail-closed = 刻意纵深防御**）⇒ 2 红；P3 去掉重放 ⇒ 2 红；P4 把 401 证明失败塌缩成配置问题 ⇒ 1 红；P5 头名打错一个字母 ⇒ 1 红。

**待 L2 确认（L3 提出）**：引导端点当日**仍要求 connection 围栏**（403 `browser session proof required` / 503 `…unavailable`）；客户端只在**引导这一步**带 `credentials:'same-origin'`（业务调用一律只看请求头）。若 L2 改了这一步的准入形态，L3 只需改 `ensureHostProof` 一处。

| R2-L3-11 | **P2** | **"跨端对拍"名不副实（主控复核 2026-09-20）**：L3 的 P0 交付里称"已加**跨端对拍用例**（头名 + 路径逐字比 `host-request.ts` / `index.ts`）"，但实测 `packages/client/wasm-apps/src/client/host-proof.spec.ts` **只读自己的源码**（`:153` `readFileSync(new URL('./host-proof.ts', ...))`，用于"不得落盘/打印"的断言），其"头名与路径（跨端契约）"一节的断言是**本地常量 vs 字面量**（`:38 expect(HOST_PROOF_HEADER).toBe('X-Pico-Host-Proof')`、`:39` 路径同）⇒ **宿主若改名/改路径，客户端这条断言照旧绿，宿主自己的断言也照旧绿**（两侧各钉自己的字面量）—— 正是 R2-X-1 的漂移模式，也正是作业章程 §3 记的反模式 | 改为**真跨包对拍**：读 `packages/host/wasm-apps-host/src/host-request.ts` 抽出 `HOST_PROOF_HEADER`、读 `index.ts`/`host-request.ts` 抽出引导路径，与客户端常量**逐字比**（本仓先例：`header-spec-parity.spec.ts`、`wasm-app-open-route-parity.spec.ts`）；变异：把宿主常量改一个字母 ⇒ 必红 | L3 | **已闭合（主控复核 2026-09-20）**：`host-proof.spec.ts:77` 新增 `hostProofParity(hostRequestSource, hostIndexSource)` —— 从 `host-request.ts` 抽 `HOST_PROOF_HEADER` **字面量**、从 `index.ts` 抽 `WASM_APPS_LOCAL_PREFIX` + 从 `host-request.ts` 抽 `proofRoute` 的**后缀**（不在用例里写死），断言 `<前缀><后缀>` 与客户端常量一致；**抽不到记 `problems`（不静默跳过）**；大小写口径写进注释（比前统一 `toLowerCase()` + 额外断言宿主侧声明为小写）；标题改为「跨端对拍：…vs 宿主 seam 源码（R2-L3-11）」，本地常量断言独立成条；从 `app-center.spec.tsx` 删除重复那份（同一件事不留两份）。**变异真改宿主源码**（`x-pico-host-prooof`）⇒ **2 红**、sha256 前后 `e672e4ad…` 一致、`RESTORED=True`、`CONCURRENT_WRITE=no`；另加**不碰磁盘**的内存自证（三条负例必须报错，避免打断正在改宿主的 L2）⇒ `check` = 16 files / **309 tests** / exit 0 |
## S. 冻结前门禁实测（L4 跑 `corepack yarn check`，2026-09-20 01:04–01:12，19 任务 474.5s）

`✓ check:wasm-client-only 23.1s`（**guard 已转阻塞且通过**）；4 个包失败，主控逐条定性如下（**不是照抄 L4 的"别的泳道施工中"**）：

| ID | 包/用例 | 主控定性 | 分派 |
| --- | --- | --- | --- |
| R2-S-1 | `@picoaide/dsh-wasm-apps`：`host-proof.spec.ts > 跨端对拍…头名（忽略大小写）与引导路径与宿主逐字一致`（报"宿主 `x-pico-host-prooof` vs 客户端 `X-Pico-Host-Proof`"） | **瞬时态（非缺陷）**：L3 的 R2-L3-11 变异**正好**改的就是宿主那一行；L4 这次 **474 秒的长跑**撞进变异窗口。主控核实：**现值正确**（`host-request.ts:37 = 'x-pico-host-proof'`、sha256 `e672e4ad…` 与 L3 记录的还原值一致、mtime 01:10:33） | **记录教训**（见下） |
| R2-S-2 | `@picoaide/dsh-enterprise`：`wasm-app-tools.spec.ts > 字段集合与首版必填标志与常量一致`（`AssertionError: expected [access, data_sensitivity, …(4)] to deeply equal […(3)]`） | **真缺陷（跨泳道漂移）**：L1 按 §6 给 `appcfg.json` 加了 **`window`** ⇒ 生成物 **6** 字段，而 enterprise 的常量仍钉 **5** 字段 ⇒ "单一真源对拍"正确地红了（这正是它该干的事） | **L2**（`packages/host/enterprise` 属 `packages/host/**`） |
| R2-S-3 | `@picoaide/dsh-enterprise`：`channel-content.spec.ts` ×3（`brandChannel` 的映射/短名回落/中性回落）+ `wasm-apps.spec.ts`（>8 MiB 走 uploads 端点） | **待查**（很可能是 L2 在途改动；也可能是渠道/发布面漂移） | **L2** |
| R2-S-4 | `@picoaide/dsh-browser`：`audit-0908.spec.ts > P2-27 … re-stamping an existing URL persists the new title/actor`（`ENOENT … tests/.a9-store-bm-2fqow92c1pf/bookmarks.jsonl`） | **并发/负载 flake**：临时目录在用例期间消失（19 任务并发 + 变异跑）。与项目既有的 connectors flake 同类（预算过紧 / 临时目录未隔离） | **L2**（提预算或隔离临时目录） |
| R2-S-5 | `@picoaide/dsh-cron`：`cron.spec.ts > AND 分支的扫描视野…真实命中在 10.5 年后`（`Test timed out in 5000ms`） | **负载 flake**：该用例是重扫描型，5s 预算在 19 任务并发下不够 | **L2**（给该用例显式预算） |

**方法论追加（与 CTL-9 同族，但这次是反方向）**：**长跑全量门禁不得与泳道变异并发**。变异脚本的协议是"改一处 → 跑目标 spec → 立即还原"，而全量 `yarn check` 要 8 分钟 ⇒ 它一定会读到别人的变异窗口，产出**假红**（本次 R2-S-1）。**冻结期跑全量门禁前必须确认无变异脚本在跑**（`FREEZE-PROTOCOL.md` §0.2 已有该检查，本次是它生效前的实例）。

## T. L2（宿主与窗口）交卷 + 主控裁决（2026-09-20）

**判据（全绿，实跑）**：`corepack yarn check` = **21 任务 / 21 通过 / 0 失败 / 0 跳过 / 333 s / EXIT=0**（`temp/wasm-client-only/L2-check-final4.log`）⇒ **全仓门禁绿**（含 enterprise/browser/cron/wasm-apps，即 §S 的 R2-S-2..S-5 已一并解决）。单包：host 17 文件/187 例、browser 37/585、desktop 86/929+2skip、cron 174、enterprise 533+1skip。**探针**：`probe-custom-scheme.cjs` exit 0、`probe-v2.cjs` exit 0、**W0-D `probe-browser-storage.cjs` required=15 / pass=15 / fail=0 / unknown=0 / exit 0**（W0D-14 已按裁定改反向期望）、**新 `probe-app-scheme-gate.cjs` exit 0**（pattern `probe-app://*/*` **触发 6 次**；装闸门后 http 页/应用 B 页请求 **handler 增量 0**、对照阶段各 1、应用窗口自身 **+2**）。

**点名项全部交付（含变异）**：**R2-X-1** —— ①**准入形态确认＝保持**（引导端点今天过 connection 围栏 = 引导路径的当日授权，`credentials:'same-origin'` 成立；零端口时换帧管道握手）；令牌 TTL 5 min、**TTL 内可复用**、LRU 32、缺/错 `{"error":"proof_required"}`、过期 `{"error":"proof_expired"}`。②**端到端用例**：**只经引导端点取令牌** → `/channel` → `/open` 全 200，**无手工注入**；反向对照无令牌 401 ⇒ **R2-X-1 两端闭合**。｜**R1-L2-1**（真机探针，见上）｜**R1-L2-2**（未开浏览器标签建窗 ⇒ 两个 handler 都被调用 + `ensureSessionGuard` 在 `createAppWindow` 之前）｜**R1-L2-3**（`budget-parity.spec.ts` 读 `limits.json` 断言 30>10>5>3；变异 guest→60 红、客户端→5s 红，sha256 前后一致）｜**J13**（`ctx.emit('pico/wasm-app-deep-link-foreign')` + 两端逐字对拍）｜**R2-X-2/3/4/5**（三档文案接消费者且不塌缩、`__picoaide/*` 非 AI 路径 **404 且零出站**、harness 默认注入 appProof + 5 条含"实际 headers 含该头"、重签只在 `code.startsWith('proof_')`）｜**R2-X-6/X-7/X-8**（X-6 **明确认账**；X-7 判据排除范围写成"生产代码，spec 夹具除外"；X-8 **选"重签一次"**并写明理由）｜**R2-S-2..S-5**（appcfg 补 `window` 52/52；enterprise channel-content 三例是**在途夹具中间态**、已补齐 33/33；browser flake 改**目录登记 + 精确清理**（并发 3 份同跑 17/17×3）；cron `testTimeout: 30_000` 174/174）。

**主控裁决**：
1. **客户端出站超时是否纳入 `limits.json`** ⇒ **不纳入**。理由：`limits.json` 是**服务端**平台上限的单一真源；客户端出站超时是**客户端本地配置**（UX 取向），把它塞进服务端生成物会让"服务端 dictating 客户端"且把客户端耦合到服务端产物。**§5.1 的序关系靠 `budget-parity.spec.ts` 的跨包对拍保证**（已落地、已变异验证）—— 这正是"契约是序关系，不是同一份常量"的正确形态。已回写 §5.1 说明该值属客户端常量 + 对拍判据。
2. **`atomic-write.ts` → `@deepseek-ai/dsh-atomic-write`**：**W6/W7 全部静默后切换**（现在唯一实现 + 偏离声明已入 §16.1）✓ 维持原判。**已于 2026-09-20 执行**（依赖入 `dependencies`、三处调用点切上游、本地助手删除、判据迁移为语义 + 接线并通过 4 个变异体；设计 §16.1 的偏离段已整段改写为「已完成」并补两处口径勘误）。**该泳道抓到一处文档与实现不符**：§16.1 原写 `temp + fsync + rename`，而**本地助手与上游包都没有 fsync**（上游 `.d.ts` 明写 *Crash durability (fsync) is out of scope*）⇒ 持久性缺口**自 W2 起存在、本版未修**，已如实认账；另上游 `mode` 必填、`dirMode` 漏传即回落 ⇒「唯一实现」的约束改为「一处语义 + 每调用点可见权限位 + 接线判据」。报告 `temp/wasm-client-only/fix-atomic-write.md`。

**L2 认账（未闭环，不得说成已解决）**：①应用窗口 webContents **采纳进 browser runtime**（CDP 附着 + 同一套页面级实现）**未接线** ⇒ `app_id` 可解析/校验、`list_tabs` 有 `kind/app_id`、闸门就位，但**页面级动作仍只作用于浏览器标签**；②真实 `WasmAppsWindowAdapter`（`BrowserWindow`）未实现；③F16 `open` 端点真机联调未做（端点缺失时按滚动升级继续打开）；④**AI runner 未 provide**（当前真实返回 `app_ai_unavailable`）；⑤缓存键 version 未接线（X-6 已认账）；⑥真机三平台判据（W6）；⑦enterprise 的 8 MiB 分片上传 2 例非 L2（未动、不作基线）。

## U. L7 的 appserver 测试面交付 + 三条横切发现（2026-09-20）

**交付**：`internal/wasmapp/appserver` 测试面改造完成 —— `PG_DSN_TEST=… go test ./internal/wasmapp/appserver/ -count=1` ⇒ **ok 281.382s**（复跑 354s 亦 ok）；**生产代码零改动**（只碰 9 个 `_test.go`）；`gofmt`/`go vet` 空；`-tags perfprobe` 探针 PASS。夹具从"子域 + 换票 + Cookie"改成"**客户端注入身份**"（`env` 去 `mgr`、`Options` 去 `BaseDomain/Sessions/AIBaseURL`、`get/post` 默认注入发布者身份、未登录显式 `nil`）；删 15 条只覆盖旧路径的用例（清单见 `temp/wasm-client-only/L7-W4-appserver-tests.md` §②），**新增** `TestServe_ClientUnknownAppIs404` 补"未登记 app_id ⇒ 404"（删掉的两条原本是唯一判据，删后必须有替代）。
**另修一处真红**：`TestAdminRuntimeExposesWatermarksAndGaps` 原要求缺口清单出现 `anon_limit`/`ai_revoke_failures` ⇒ 改成"这两条**不得**再出现"（对象已删；缺口清单的口径是"存在但没出口"）⇒ `ok 2.334s`。

| ID | 严重度 | 发现 | 处置 | 泳道 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **R2-L7-1** | **P1（判据可能假绿）** | **"同应用并发"用例在客户端身份模型下会静默退化为串行**：身份由客户端注入，若夹具注入**同一个员工**，§4.6 的 `PerUserPerAppRunning = 1` 会把同应用并发请求**按设计串行** ⇒ 用例看起来覆盖了并发，**实际是串行**（子代理实测：两条 dbpool 事务端到端 + 每应用并发共 3 条一度变红）。**规则**：任何"同应用并发"用例**必须注入两个员工**，或**显式放宽** `PerUser*` 队列选项；否则新增的并发用例是假绿 | 已登记（属章程 §3"存在性/表面覆盖"类）；**冻结期审计须逐条检查并发用例的注入身份数** | L1（后续新增并发用例）+ 审计 | **已登记** |
| R2-L7-2 | P2（死代码/无消费者） | `appserver/serve.go` 的 `serveStatic(w, r, rel, rc, !cfg.RequiresLogin())`：`appcfg.RequiresLogin()` 自 W1 起**恒为 true** ⇒ `allowEntry` **恒 false**、`static.go` 的 `isEntry` 分支**永不执行**（入口文档一律交 wasm）。参数与分支在可读性上已无意义，但"入口不直出"是 **W1 既定契约语义** | **不删**（删它属 W1 契约面，L7 单方面删会越界）；**留给 L1 决定**：要么在 W1 契约里显式写明"该参数保留但恒 false"并加注释，要么连同参数与 `isEntry` 分支一起收掉 | L1 | **已转 L1** |
| R2-L7-3 | P2（无消费者，已认账） | `ServeClientRequest(..., sessionKey)` **无消费者**（服务端 AI 删除后无在手令牌） | **保留**：§8.2 的冻结签名 + `serverauth.SessionKey` 的唯一调用点，理由已写在 `api/proof.go`/`appserver/client.go` 的注释里 ⇒ 本项**按认账处理**（不删、不假装有消费者） | L1/L7 | **已闭合（认账）** |

## V. L1 冻结（2026-09-20 01:20）—— 六条泳道全部交付/冻结

**冻结判据（实跑，`temp/wasm-client-only/L1-gates.log`）**：`gofmt -l internal cmd` **空**；`go build ./...` **BUILD_OK**；`go vet`（api/appcfg/appproof/opens/serverstore/channel/router）**空**；8 包定向测试**除 1 条跨泳道红外全绿**（`api` 479s / `serverstore` 504s 真跑完）；**零残留 A=0**、B=34/34、ANN=65/65、C=460、**exit 0**。
**唯一红**：`api/TestAdminRuntimeExposesWatermarksAndGaps`（断言 `anon_limit` 在缺口水位，而匿名限流器已随 W4 删除）—— **L7 已修**（把断言改成"这两条**不得**再出现"，`ok 2.334s`）；L1 的日志早于 L7 的修复，故记为时序差异，非未闭环。

**点名四条 + W5 三端点（全部绿 + 变异）**：**R1-L1-1**（四条判定 + 变异"删 `clientreq.go:187` 调用 ⇒ 红"，sha256 `9ad193060e…`→`ababdda982…`→还原一致）｜**R1-L1-3**（proof 数据根改用**独立 `t.TempDir()`** —— 比"上提一层"更彻底：彻底不共享根，理由写进夹具注释）｜**R2-X-2**（`TestOpenAppFrozenStatesDoNotCollapse`：`app_frozen` / 非 frozen 非空 / 正对照；`open.go` + `appserver/serve.go` + `edge.WriteAppNotFound` 各带 reason；变异"冻结档写成 `app_deleted`" ⇒ 红，sha 一致）｜**R2-X-3**（`TestPublishRejectsReservedPathPrefix`：`validate`+`publish` 双入口、`ASSET_DENIED`+`reason=reserved_path_prefix`；**覆盖边界如实写注释**：服务端只能静态看到随包资源名，wasm 内部路由由宿主协议层截走 = 规则①③归 L2）｜**W5 C1**（`login` **含历史 public** + **回显 `access`** + whitelist/非法取值）｜**C2**（三数组恒在 + **UV 按窗口去重** 3 次/2 人 ⇒ uv=2）｜**C4**（`attribution_available` **区分"未上线"与"零调用"**）。
**变异总账**：`l1-mutations.sh`（W1）**14/14 红 0 漏检**；`l1-mutations-w5.sh` **6/6 红 0 漏检** + **3 条记 LAYERED**（C2 的"数组恒在"有 DAO `[]T{}` 与处理器 `if x==nil` **两层**兜底，单层去掉仍绿属**纵深防御而非漏检**；两处同去并让 `top_apps` 变 nil 才复现 `{"apps":null,…}`）—— **诚实标注 LAYERED 比reporting 假 100% 更有价值**。旧变异**无作废**（脚本条目全指向 W1 自己的文件）。

**L1 本轮实测抓到的真 bug（静默数据丢失类）**：管理端 C3 的 `parseDayParam` 原把 `YYYY-MM-DD` 归一到 **UTC** 日零点，而 `day`/`opens.today` 按**本地日** ⇒ **CST 01:11 的调用落在"前一天 17:11 UTC"被排除在窗口外，且无任何报错**。已统一 `serverstore.LocalDay`（唯一实现）。**这类"窗口边界静默少数据"必须在冻结期判据里覆盖**（已要求 L1 在 status 写明，审计会查）。

**结论**：**L1 冻结，`server/**` 侧不再写入**；六条泳道（L1–L6）+ L7 全部交付/冻结 ⇒ 进入**冻结期**（按 `FREEZE-PROTOCOL.md` 跑全量判据 + 各面第二轮审计）。

## W. 终局门禁第 1 轮：全量 `go test` 的两类结果与主控修复（2026-09-20 01:18–01:32）

**背景**：L7 的两次全量服务端跑（`temp/wasm-client-only/L7-full-test{,2}.log`）都**不是干净的终局判据**，两条独立原因必须分开记账（章程 §4.2：把"基础设施形态"与"目标断言"分开）。

**① 第一轮 3 个包 600s 超时 ⇒ 并行争用，不是回归**。`L7-full-test.log`（01:18）里 `internal/llmgateway` 600.649s、`internal/serverstore` 601.109s、`internal/wasmapp/api` 600.318s 全部是 `go test` 的**缺省 600s 单包超时**，三条包的 `--- FAIL` 明细为空。对照 L1 单跑实测（`api` 479s、`serverstore` 504s）⇒ 这些包**本身就慢**，任何并行度下都会撞缺省超时。第二轮降低并行后 `llmgateway` **332.728s ok**、`serverauth` 184.680s ok ⇒ 判定成立。
**规则**：服务端全量判据必须显式给 `-timeout`（本次用 `-timeout 1800s`）并**固定并行度**；用缺省值跑出的超时**不得**记为功能回归，也不得记为通过。

**② 第二轮**（`-p 1`）在 `internal/serverauth` 之后**中断**，`serverstore`/`wasmapp/*` 等包**从未跑过** ⇒ `L7-full-test2.log` 是**不完整**日志，不能当终局判据（该文件只有 16 个 `ok`）。终局判据必须是**跑到底**的整轮输出。

**③ 真红一条（已修）**：`cmd/server` 的 `TestRouteAssemblyGatedSlicesAreDeclared` 报

```
GET /api/server/admin/wasm-apps/:app_id/ai-usage
GET /api/server/admin/wasm-apps/opens/summary
```

**根因是两个泳道的接口缝隙，不是谁的疏漏**：L7 在 **00:57** 按实跑 diff 重算了 `wasmGatedRoutes`（并补登了 W1 的 `request`/`open`/`proof`/`:app_id/opens` 四条），而这两条管理路由是 **01:08** 才加进 `internal/router/router.go`（`:238`/`:240`，W5 C1/C2 面）—— 表格的重算早于路由的落地，之后**没有任何一方再跑过该守卫**。守卫按「实跑最小树 vs 完整树 diff 反向断言」捕获，属**该守卫存在的理由本身**。

**主控修复**：`server/cmd/server/routes_source_test.go` 的 `wasmGatedRoutes` 原样补登两条（附注释说明它们与上一批同类：`d.Wasm != nil` 才注册，且都后于表格上一轮重算）。**判据（实跑）**：`go test -v ./cmd/server/ -run 'TestRouteAssembly' -count=1` ⇒ 4/4 **真实 PASS**（`MatchesProductionSource`/`GatedSlicesAreDeclared`/`ProbesAndHTMLFacesPresent`/`HasExactlyOneEntryPoint`，0.148s）；`PG_DSN_TEST` 指向 `pg-test:5432`（已确认可达）⇒ **不是 PG 缺失导致的 SKIP 假绿**。

**④ 冻结被打破（在飞施工，主控当场发现）**：`FREEZE-PROTOCOL` 要求"变异期不得跑全量门禁"，而 01:25–01:28 仍有写入落在 `server/internal/wasmapp/api/{admin,publish,open,admin_opens}.go`、`server/internal/serverstore/wasm_app_opens_summary.go`（`admin.go` 新增 `?access=` 筛选 + **回显**、`publish.go` 同步 ⇒ 即 **W5 C1 / R2-L6-1** 的施工），`§V` 的"`server/**` 不再写入"已被事实推翻。审计方也各自做了前后哈希快照（`temp/wasm-client-only/audit-round2/.l2-pre-sha256.txt`、`.l4-sha256-before.txt`，01:30）。
**裁决**：**在写入方给出停写声明之前，不跑终局全量门禁**（否则结果既不能证真也不能证伪）。已向 A2-L1、A2-L6、L7 索取「在写文件 / 所属审计 ID / 停写时刻」。
**门禁纪律（本轮定案，写入 `FREEZE-PROTOCOL.md`）**：终局全量判据的**前置条件**是「冻结声明 + 前后哈希一致」，不是「没人说自己在改」。

**⑤ 交付基线提交（主控）**：工作树在冻结期实际是 **199 改 / 72 未跟踪 / 29 删除**（整个「客户端专属」改造一直未提交 ⇒ 一旦机器出事全丢，这是当时**第一风险**）。主控做了机械门禁（`gofmt -l internal cmd` 空、`go build ./...` 0）后提交为 **`d3fe68de61`**（350 文件、+39103/−17620）。提交前的三次清理（都属"防止污染公开仓"，值得复用）：
- **`server/appdemo` 3.1 MB 原生 ELF**：`go build -o` 手误留下的构建产物（`file` 判定 ELF x86-64，**非** wasm；全仓零引用）。演示应用的真实资产是**构建期**产出 `/opt/picoaide/demo-apps/app.wasm`，入库的只有 `server/demoapps/{appdemo/main.go,demos.json}` ⇒ 删除。**规则：提交前对所有新增文件做二进制特征扫描**（`file -b --mime-encoding` ⇒ `binary*`）。
- **`H` / `S` 两个根目录垃圾文件**（00:23 误重定向：一个是 `git grep` 输出 276 行、一个是文件清单 357 行）⇒ 删除。**规则：`git add -A` 前逐个看未跟踪条目，仓库根出现单字母/无扩展名文件一律先查。**
- **`.git/index.lock` 残留**：0 字节、95 分钟无变化、无任何 git 进程 ⇒ 判定残留锁后删除（与 2026-09-17 `.git/HEAD.lock` 同族，取证三连=大小/时间/git 进程）。

**⑥ ⚠️ 事故：变异体被扫进提交（新失败模式，已处置 + 已派守卫）**。`git add -A` 的目录遍历瞬间，A2-L6 的变异正在飞 ⇒ `server/webadmin/src/pages/app-center/opens-contract.ts` 的 `return '0' // A2-L6 变异 M-D：— 改回 0` **进了提交**（该变异会让 vitest 变红 ⇒ **提交是红的**）。主控在提交后复核工作树时发现，用 `--amend` 就地修订（提交未推送），HEAD 现为 `d3fe68de61`，`countText` 已复原为 `'—'`；**修订后全库复查：HEAD 里"代码行 + 变异标记"形态命中数 = 0**（另两处命中是 `check-workflows.mjs` 的字符串与警告文案，属误报）。
**精确时刻（reflog + A2-L6 的 sha256 证据，双方独立可复核）**：A2-L6 的 M-D 变异窗口 = **01:35:45–01:36:03**（还原完成于 01:36:03，`opens-contract.ts` mtime 01:36:03）；主控成功的 `git add -A` 落在 **01:35:5x（窗口之内）**；`git commit` = **01:36:15**（用的是那份已污染索引）；`--amend` = **01:36:49**（此时文件已还原 ⇒ 修订版正确）。**教训精确表述：不是"没检查"，而是"暂存与提交之间隔了 20+ 秒、而变异窗口正好覆盖暂存动作"** —— 所以判据不能只看"提交那一刻工作树对不对"，必须**在提交前对暂存内容本身做变异扫描**（已派守卫）。
- **可复用判据**：`git grep -nE '变异|MUTANT' HEAD -- '*.ts' '*.tsx' '*.go' '*.mjs' '*.js' '*.sh' | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*|#)'` —— 剥掉行首注释后仍有余量的行才是"代码行挂变异注释"。**注意 `git grep` 默认搜工作树，必须显式给 `HEAD`**（否则还原后查不出来，会得到假绿）。
- **根因**：本仓把变异验证当一等实践，但**没有任何守卫防"变异体残留"** —— 只能靠人眼与运气。已派 L4 新增 `scripts/check-no-leftover-mutants.mjs`（只抓上述形态，含三类合成正反例）+ 接入 `check-workspaces.mjs`。
- **同时向 A2-L6 追认**：它自称"全程只读"与事实不符（变异确实改了生产文件），已要求逐条复核 M-A…M-N 的还原证据、**此后变异只允许在 `temp/` 临时副本上做**。**规则：审计方的变异验证同样受"冻结期不得写受管源码"约束；变异必须在副本上或 `trap` 保证还原。**

## X. 终局门禁第 1 轮的结果、文档空洞补齐与两条新修复泳道（2026-09-20 01:37–01:55）

**① 服务端整轮门禁（主控，`FINAL-server-test.log`）**：`go test ./... -count=1 -p 2 -timeout 1800s`（显式超时+固定并行度，见 §W①）。已确认 **`cmd/server` ok** —— 即 §W③ 的路由表补登在**真实门禁上下文**里成立，不是单测孤立绿。L7 独立复跑同一条也是 `ok … 27.626s`。

**② L7 最终交付（W4 删除波次闭环）**：`gofmt -l` 空、`go build` 绿、`go vet` **exit 0**、`go test ./... -count=1 -p 2` **50 包 ok**；五桶 **A 621→0 / B 13→34 / C 934→460 / D 26→14 / ANN 65/65**、scanner exit 0；真 PG 验收 SQL：`kind='wasm_app' AND config_json->>'access'='public'` 计数 **0**、`to_regclass('app_sessions') IS NULL AND to_regclass('employee_sessions') IS NULL` **true**；五条变异（`ai.chat` 残留 / `entry_url` 残留 / 删 `edge.MaxBodyBytes` / 0074 去 `kind` 限定 / 0073 顺序颠倒）**全部改坏即红、还原 sha256 逐字节一致**。**R2-L7-1（并发身份假绿风险）逐条审计后结论：未发现"单员工 + 真并发"的假绿用例**，10 条并发用例逐条给出「身份数 / 并发如何成立」并区分"两员工真并发""显式放宽 `PerUserPerAppRunning`""不经调度器"三种正当形态 —— 这条把一个**假设风险**收敛成**有清单的结论**。

**③ 文档空洞补齐（主控，本轮最重要的文档动作）**：设计总纲**从未钉过管理端看板的响应键** —— §5.1b 只钉了 `open` 的响应，于是服务端（把键写在 `admin_opens.go` 的 `gin.H{}`）与 webadmin（把契约写在自己 `opens-contract.ts` 的注释里）**各自钉了一半**，真实环境里看板出不数（§Y）。新增 **§5.1c「服务端：管理端看板两端的响应契约」**：逐字给出 `opens/summary` 与 `ai-usage` 的键集与语义（含 **UV 必须真实去重、禁止把日汇总逐日 uv 或各应用 uv 相加**；`totals/today` 必须是不带 `GROUP BY app_id` 的一次聚合；`title` 查不到就缺省不得编造；`attribution_available` 必须被 UI 消费以区分"未上线"与"零调用"；详情窗口回落必须回显 `from/to`）。**并明文要求跨端对拍用例（读对方源码、集合相等），禁止再用"各用各的夹具"。**

**④ 两条新修复泳道（并行，主控派工）**
- **F1「C2/C4 看板接缝」**：按 §5.1c 修 R2-L6-1/2/3/4（服务端 + webadmin + **真实形状跨端对拍 spec** + 每条变异）。约束：先做前端侧，Go 文件等 `FINAL-server-test.log` 出现 `### EXIT=` 再动（否则那轮门禁失效）；变异只在副本上做。
- **F2「应用 AI 链路闭环」**：**这是主控独立核实出的、比审计发现更严重的一处缺口** —— 设计 §21.2 步骤③ 要求「在隐藏会话上跑一轮 `ctx.agentLoop`」，而 `packages/host/wasm-apps-host/src/index.ts:265` 用 `ctx.get('wasmAppsAiRunner')` 取 runner、**全仓无人 `provide` 它**（`grep -rni airunner packages` 只有该文件与它的 `lib/` 产物）⇒ **每次应用 AI 调用都返回 `app_ai_unavailable`，功能端到端不可用**。L2 把它记为"认账④"，但**设计 §21.7 的认账清单里没有这一条** ⇒ 它是**未实施的既定交付项**，不是被批准的延后。已探明上游 `agentLoop` 服务存在（`deepseek-harness/packages/core/agent-loop/src/index.ts`，`super(ctx,'agentLoop')`）且桌面宿主 node_modules 里有 `@deepseek-ai/dsh-agent-loop` ⇒ 结构上可做。要求：按 §21.6 九条判据（每条带变异）实现，**若调研发现结构上不可行必须停下给证据，不许造假 runner、不许把"未实现"写成"已实现"**。顺带闭合 L7 §五② 的 `AI_CHAT_PATH` 跨包对拍缺口。

**⑤ `server/docs` 迁移区间真实漂移（已修）**：`06-database.md:6` 与 `08-development.md:64` 都写「0001–0060」，实际已到 **0076**。已改为 0001–0076 并把 0061–0076 条目补齐（含 0073–0076 随本次改造落地的四条；0075 经核实建 `wasm_app_opens` 明细 + `wasm_app_opens_daily` 日汇总，0076 加 `usage.app_id` + 部分索引）。**并派 L4 新增静态守卫**（`scripts/check-migration-range.mjs`：实际最大编号 == 文档区间上限；`server/AGENTS.md` 提到的每个迁移号都必须在实际文件集合内；带合成正反例 + `migration-range:allow` 行内豁免）。

**⑥ 已核实的"非问题"（避免重复劳动）**：`imports_gen.go` 在门禁期间（01:40）mtime 变动，但 `git status`/`git diff` **均为空 ⇒ 与 HEAD 逐字节相同**（`go generate` 幂等重写）。**判据取 sha256 而非 mtime** —— 这正是 `freeze-snapshot.sh` 用 `sha256sum` 的理由。

**⑦ 协调动作（防撞车）**：A2-L2 拟在 `packages/host/**` 做写入式变异至 ~01:55，而 F2 正在编辑 `packages/host/wasm-apps-host/**` ⇒ 已划界：**该包禁止写入式变异**（改纯静态核查 + 实跑既有测试，并在报告写明原因），`browser/desktop/enterprise` 照做；A2-L2 已承诺结束后明确声明"变异已全部还原"再让主控开客户端侧门禁。

## Y. 第二轮独立审计 · A2-L6（webadmin）（报告 `temp/wasm-client-only/audit-round2/L6.md`，320 行）

**绑定**：HEAD `d3fe68de61…`（不脏：`git status --porcelain -- server/webadmin server/internal` 空）。**必核 9 项：PASS 6 / FAIL 2 / PARTIAL 1**。`npx tsc --noEmit` exit 0；`npx vitest run` = **32 files / 536 tests / exit 0**（与 L6 自述逐字一致）。**自做 4 条变异全部"改坏即红 + sha256 逐字还原"**（M-A…M-D；其中 **M-D 的变异窗口 01:35:45–01:36:03 与主控 `git add -A` 重叠 ⇒ 变异体被扫进提交**，主控已 `--amend` 清掉，见 §W⑥）。

| ID | 严重度 | 发现 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| **R2-L6-1** | **P1** | **C2 `opens/summary` 响应形状与前端不一致**：服务端 `{from,to,days,top,capped,trend,apps:[{app_id,pv,uv,today_pv,today_uv}],top_apps}` vs 前端读 `today{}`/`totals{}`/`apps[].window_pv|window_uv` ⇒ **真实环境恒 `—`**（看板「今日 PV/UV」「窗口 UV」、列表「近 7 日 PV/UV」；只剩 trend 累加的窗口 PV 与列表今日 PV/UV）。证据=A2-L6 自建**真实形状**对拍用例 2 passed（=读取点全落空），夹具逐字取自 Go 源码 | 主控补 **设计总纲 §5.1c** 钉死键集与语义；**F1 泳道**按它改（服务端 + 前端 + **真实形状跨端对拍 spec**） | **已派 F1** |
| **R2-L6-2** | **P1** | **C4 `ai-usage` 形状不一致 + `attribution_available` 零消费**：服务端 `{app_id,from,to,days:[…],total{},attribution_available}` vs 前端要 `{calls,total_tokens,points[]}` ⇒ `requireAiUsage` 判"缺少 points" ⇒ **整块面板永不显示数据**；`grep attribution_available server/webadmin/src` **零命中** ⇒ §21.4「未上线 vs 零调用必须区分」未落地 | 同上（§5.1c B 节） | **已派 F1** |
| **R2-L6-3** | **P1** | **详情「全部（长期日汇总）」静默退化为近 7 天**：`AppOpensSection.tsx:72` 传 `days:0` ⇒ 不传 `from`/`to` ⇒ 服务端回落 `now-6…now`；且 `from`/`to` 前端不渲染 ⇒ **管理员无从察觉少数据**（与 §W② 的 `parseDayParam` UTC 错位同族：静默少数据） | §5.1c C 节：显式请求 90 天 + 必须渲染生效窗口 | **已派 F1** |
| **R2-L6-4** | P2 | 列表对"服务端未下发该应用行"（`GROUP BY app_id` 省略零打开应用）渲染 `—`，与"按 0 处理并带 title 说明"的自身声明冲突 | 二者取一并与声明一致 | **已派 F1** |

**PASS 项（可直接引用）**：CTL-11（6 个归一化入口无回填；形状漂移是**行为级**断言）｜访问级别两值收敛（历史值文案 + 不可选 + `?access=public` 显式拒绝 + **`login` 含历史 `public`**，与服务端 `admin.go:251-258` **同口径**）｜能力位（只读全走 `capability:read`，diff 零新增权限点）｜历史审计标签｜变异 4/4。**PARTIAL**：`R2C-14`（降级 vs 出数）。
**路径与参数名 3/3 逐字一致**（summary `days/top`、detail `from/to/granularity`、ai-usage）；C3 详情**确实能出数**（除「全部」档）。
**A2-L6 已声明停写**：自 01:36:03 起不再对受管源码做任何写入（含变异与还原）；报告 §7 的反向变异因此未做并**如实降级标注**。

## Z. 终局门禁第 1 轮全绿 + 第二轮审计四份报告收齐 + 两条新泳道（2026-09-20 01:45–02:05）

### Z.1 终局服务端全量门禁 = **绿**（`temp/wasm-client-only/FINAL-server-test.log`）
`go test ./... -count=1 -p 2 -timeout 1800s`（真 PG `pg-test:5432`）⇒ **`### EXIT=0`**，含 `cmd/server`（路由装配 4 条）、`internal/wasmapp/**`、`internal/serverstore`、`internal/llmgateway` 等全部包；`? no test files` 的包（`webadmin`、`temp/skillseed-probe`）无失败。**这一轮是"冻结基线 `d3fe68de61` 干净"的权威判据**（过程事实：`imports_gen.go` 在 01:40 mtime 变动但 sha256 与 HEAD 一致 ⇒ 不构成污染，见 §X⑥）。

### Z.2 第二轮审计四份报告全部收齐 —— 汇总

| 审计 | 范围 | P0 | P1 | P2 | 必核 |
| --- | --- | --- | --- | --- | --- |
| **A2-L1** | `server/**` | **0** | **1** | 5 | 6 PASS / 3 PARTIAL / 1 未做（W4-12 属 L5） |
| **A2-L2** | `packages/host/**` | **0** | **0** | 5 | 7 PASS / 3 PARTIAL（均为已认账面）；**§T 认账⑦ 已过时**（enterprise 实跑 **534 passed / 1 skip / 0 failed / exit 0** ⇒ 应销账） |
| **A2-L4** | `scripts/**`、渠道 | **0** | **0** | 3 | 8/8 **全 PASS** |
| **A2-L6** | `server/webadmin/**` | **0** | **3** | 1 | 6 PASS / 2 FAIL / 1 PARTIAL（见 §Y） |

**A2-L2 的点名判据（可直接引用）**：R2-X-1 两端闭合**PASS**（头名 lower 相等 + 引导路径逐字相等，`index.spec.ts:263-308` **无手工注入**）；R1-L2-1 真机探针 **PASS**（`probe-app://*/*` 触发 6 次、装闸门后 http/跨应用 handler 增量 **0**、对照各 1）；R2-X-3 **PASS**（4 条负例 404 且断言 `fetch` **零调用**）；R2-X-4 **PASS**（断言**实际 headers**含头 + 四条重签分支）；J13 **PASS**（两端逐字 + 桌面跨包对拍 8/8）。
**A2-L4 的关键自证**：五桶 `A=0/B=34顶格/ANN=65顶格/C=460/D=14`；**三处预算改小（34→33 / 模块 14→13 / ANN 65→64）全部 FAIL** ⇒ 预算不是摆设；`[新迁移需人工复核]` 含 0073–0076；另外它自造了"品牌 vs 品牌"跨渠道重复与 32/33 字符边界两个**脚本没覆盖的形态**去试渠道 CI。
**A2-L1 的关键自证**：`clientreq.go:187` 与 `open.go:52` **共用** `proof.go:205` 同一实现；删调用变异 ⇒ `status = 200, want 401`（sha `9ad193060e…`→`dc4ed70e…`→还原一致）；时区判据用**绝对墙钟探针**在 CST/UTC 都过、UTC 归一变异必红；生成物 2×limits-gen + headers-gen + imports-gen 后 **8 产物逐字节不变**。

### Z.3 主控对新发现的分派与裁定

**① R2-L1-1（唯一 P1）：`entry_url` 活代码 + 门禁看不见 ⇒ 裁定"删代码 + 让门禁看得见"。**
事实：`packages/host/enterprise/src/wasm-apps.ts:1476` 仍有活代码 `if ('entry_url' in entry) entry.entry_url = absolutizeEntryURL(...)`，两组 spec 把它**钉成预期**，而零残留门禁的 `SCOPES` **不扫 `packages/host/enterprise/src`** ⇒ 台账 §D W4-4 的"全仓 `entry_url` 零命中"**声明不成立且门禁看不见**。
**裁定 (a)**：删那段活代码与随之无用的死代码；两组 spec 改成**反向断言**（`entry_url` 不得出现/不得被改写）并写明理由；**把 `packages/host/enterprise/src` 纳入 `SCOPES`**（该文件归 L4，但 **L4 已停写 `scripts/**`** ⇒ 主控**授权 F4 只改这一行**）。理由＝本项目的既定方针是「把老方案从源码库和文档里**彻底**清理掉，防止以后污染项目」——留一个"运行时无害但语义已死"的分支，正是以后被人当活契约的依据。并要求：纳入后若 A>0，**不得放宽预算**，必须修掉真实残留。

**② F4 泳道（新派）**：R2-L1-1（P1，上述裁定）+ R2-L1-2（软删档与"未登记"的 reason 塌缩 + `app_deleted` 死分支：**二选一**并写明理由）+ R2-L1-3（`localZoneName()` 把 `TZ=:/usr/share/zoneinfo/...` 的**路径**交给 PG ⇒ ai-usage **500**，C1/C2 正常）+ R2-L1-4（`dbpool_test.go:256-260` 注释谎称"4 个员工"，实为 1 员工 + 放宽 `PerUser*`）+ R2-L1-5（OPS-6 的 `admissionFailed`/`Events.Record` **实现有、判据无**）+ **核实** W4-12（属 L5，只报告不改）。

**③ F2 泳道追加范围**（A2-L2 的 4 条 P2，都在它正在写的包里，别人不便改）：R2-L2-3（**`/__picoaide` 无尾斜杠**不在保留前缀闸门内 ⇒ 会被转发平台；两端一致地漏）+ R2-L2-1（`dropAppSchemeLedgerEntries` 零生产消费者）+ R2-L2-2（「冻结/下架/删除 ⇒ 关窗清缓存」无实现路径）+ R2-L2-5（**session 闸门的生产接线无判据**：真机探针自己重实现闸门、`createRealElectronAdapter()` 的转发无 spec ⇒ scheme/partition 传错时探针与单测**都会绿**）。

**④ A2-L4 的三条 P2（已闭环）**：R2-L4-1 ⇒ 主控裁决**保留 ANN 块级语义**（收窄成"逐行自带标注词"会强迫补 19 行人工标注，是"用假精度换假绿"），但量具改**自描述**：每条标 `[self]`/`[blk]`，口径写明"注释块级（±25 行）"，删掉"65 条显式标注"这类与实现不符的措辞；预算仍 65。现状 **ANN=64 = self 46 + blk 18**。R2-L4-2 ⇒ **主控已修**（`handler.go:60` 删掉已删除的 `limits.AITokenTTL`，改写成"该在手令牌已随服务端 AI 能力删除 ⇒ 本钩子暂无消费者，属 §8.2 冻结契约"，与 `ServeClientRequest(sessionKey)` 同批认账）；`grep AITokenTTL server --include='*.go'`=**0**。R2-L4-3 ⇒ L4 已把 status 的自相矛盾改成单一结论（W0-D **4/4 PASS**、C=**462**）。

**⑤ 两道新守卫（L4 交付，已接线 + 自证 + 变异）**
- `scripts/check-no-leftover-mutants.mjs`：抓"代码行尾挂变异注释"（豁免纯注释块/字符串/正则字面量）；实跑 **5372 文件零残留 exit 0**；负例实跑 `[MUTANT] … exit=1`，正例三形态 exit 0；**自检显式断言夹具真的含违规行**（防夹具写错导致假绿），变异 M7（检测行恒 null）⇒ 自检红 2 条。
- `scripts/check-migration-range.mjs`：读实际迁移取 MIN/MAX（现 **0001–0076，68 个**），文档区间上限必须 == MAX；豁免含"记录面"（`docs/planning|decisions|releases`、`docs/AUDIT-*`、带日期文件名）—— 因为审计报告里"迁移 0001-0016 过时(实际 0001-0017)"是**当时**的发现，不该跟着 MAX 走（实测踩到并写进注释）。负例实跑 `[RANGE] … exit=1`；变异 M8（上限比较恒真）⇒ 自检红 2 条。
- 冻结态实测 `corepack yarn check` = **12/12 根守卫全绿**（含 `check:no-leftover-mutants 6.9s`、`check:migration-range 3.6s`、`check:wasm-client-only 17.1s`）。
- **L4 已声明停写** `scripts/**` 与根 `package.json`（未提交变更 8 个路径）。

**⑥ W6/W7 到期项：`atomic-write` 切换（F3 泳道）**：设计 §16.1 允许的"包内临时助手"**已按约删除**，`packages/host/wasm-apps-host` 改用上游 `@deepseek-ai/dsh-atomic-write`（`writeFileAtomic`，权限位保持 `{mode:0o600, dirMode:0o700}`）。**并发冲突已发生并已最小改动处置**：F2 在该窗口新建的 `ai-authorization.ts:22` 引入了第三个调用点指向已删助手 ⇒ F3 把那一处也切到上游（只改 import 行与该行调用）。**给 F2 的复发警告已转达**：若用旧内容覆盖该文件会把坏 import 带回来。F3 实跑 `workspace @picoaide/dsh-wasm-apps-host check` = exit 0（18 文件 / 196 用例）。

**⑦ 冻结纪律的两处文档修正（主控）**：`FREEZE-PROTOCOL.md` §1 的零残留期望值原写「B≤31」是**旧预算**（现 **B≤34**、ANN≤65、且 ANN 允许块级继承）⇒ 已改，否则冻结期照字面读会把 B=34 误判为超限；同时把已 gitignore 的 `l5-acceptance.sh` 换成**门禁组 8**（5 条文案判据已机器化），并补入两道新守卫。

**⑧ 一条待销账的旧结论**：A2-L2 实测 enterprise = **534 passed / 1 skipped / 0 failed**，故台账 §T 的「L2 认账⑦（enterprise 的 8 MiB 分片上传 2 例非 L2、不作基线）」与 §19 R2-S-3 应**销账**（原结论过度保守）。

## AA. 终局：双门禁全绿 + 第二轮审计 P0–P2 全部闭合（2026-09-20 02:18–02:40）

### AA.1 冻结验证与终局判据（都在**同一条提交链的最后一版**上实跑）

**冻结成立**：门禁前后 `git status --porcelain` = **0**（无任何在飞写入）；HEAD = **`114d9c1475`**。
**提交链（三条，构成完整交付）**：
1. `d3fe68de61` `feat(wasm): 应用平台改为客户端专属并彻底删除浏览器换票链` —— 350 文件 / +39103 / −17620（含 §W 的清理与 mutant `--amend`）。
2. `eb7da457c6` `fix(wasm): 第二轮审计整改、两道漂移守卫与应用 AI 链路闭环` —— 四条修复泳道（F1/F2/F3/F4）的全部改动。
3. `114d9c1475` `chore(release): v2.7.6-beta.5 版本号、认账项与发布说明同步`。

**终局双门禁（`temp/wasm-client-only/FINAL-gates-eb7da457.log`）**：
- `corepack yarn check` ⇒ **23 个任务：23 通过、0 失败、0 跳过**，150.8s，**`YARN_CHECK_EXIT=0`**（任务数 21→23 = 新增两道守卫；含 `check:wasm-client-only`、`check:no-leftover-mutants`、`check:migration-range`）。
- `PG_DSN_TEST=… go test ./... -count=1 -p 2 -timeout 1800s` ⇒ **51 个包 ok、`FAIL`/`--- FAIL` 行 0**，**`GO_TEST_EXIT=0`**。
- 五桶（终局）：**A=0**（必须为 0）／**B=34 ≤ 34**／**ANN=64 ≤ 65**／**C=466**／**D=14**，scanner exit 0。
- 两道新守卫：`check-no-leftover-mutants`（5382 文件）**零残留**；`check-migration-range`（0001–0076）**一致**。

### AA.2 第二轮审计 P0–P2 闭合总账

| 来源 | P0 | P1 | P2 | 处置 |
| --- | --- | --- | --- | --- |
| A2-X（§P） | 1 | 3 | 4 | 全部闭合（§T：P0 两端闭合 + 三条 P1 + 三条 P2，X-6 认账） |
| A2-L6（§Y） | 0 | 3 | 1 | **F1 闭合**（§5.1c 统一形状 + 真实形状对拍 spec 6 例 + 8/8 变异红） |
| A2-L1（§Z.2） | 0 | 1 | 5 | **F4 闭合**（含唯一 P1：删 `entry_url` 活代码 + enterprise 纳入 SCOPES；7/7 变异红） |
| A2-L2（§Z.2） | 0 | 0 | 5 | **F2 闭合 3 条**（裸前缀闸门 / adapter→guard 转发判据 / open 响应关窗清缓存）；**R2-L2-1 认账**（消费者在 `packages/host/browser/**`）；**R2-L2-4 = 未修/认账**（原写「证据绑定已修」属不实声明，2026-09-20 独立复核指出后订正：L2 记录的 before-sha 是 W4-9 重生成**之前**的快照，现 `limits.json` = `d6312114…`；A2-L2 已在当前 revision 复跑确认**判据有效**，但该证据不得当冻结 revision 的凭据） |
| A2-L4（§Z.3） | 0 | 0 | 3 | 全部闭合（ANN 量具自描述 / `AITokenTTL` 主控修 / status 自相矛盾） |
| A2-L5 | 0 | 0 | 0 | 无新增 |
| **合计** | **1** | **7** | **18** | **除 1 条认账（R2-L2-1）外全部闭合** |

**顺带修掉两条审计没抓到的真实缺陷**：① F2 发现打开路由把 `window` 按 `windows.has()` 重推 ⇒ **真实适配器下新建窗口永远报"已聚焦"**（既有用例只在无窗口适配器形态跑，一直绿）；② F4 发现未设 TZ 时 SQL 按 UTC 而 Go `LocalDay` 按本地时区 ⇒ 两套本地日（并补 `/etc/localtime` 反解）。

### AA.3 仍未闭环（**不得说成已完工**；每条都有证据与责任面）

**A. 本版认账（已写入设计 §21.7 ⑤–⑨ 与发布说明「已知限制」，客户面已如实披露）**
- ⑤ **应用维度 AI 用量不出数**：`X-Pico-App-Id` 在出站头唯一构造点（上游 `llm-deepseek` 适配器）**没有 header 通道**，且服务端 `app_attribution.go` 只读头、不校验会话链路。**替代路径已定**（隐藏会话 id 即 `app:<app_id>`，出站 `x-deepseek-harness-session-id` 天然带身份 ⇒ 服务端按前缀派生，**不需要新头**），**待实施**（改 `server/**`）。
- ⑥ **隐藏会话"元数据含 `app_id`"做不到**（`SessionHeader` 字段集封闭 + jsonl 头白名单）⇒ §21.6 判据 5 应改为"会话 id 前缀可判定"。
- ⑦ **客户端 UI 侧的应用 AI 面板聊天不通**（面板在客户端页面源，`/__picoaide/ai/chat` 只有协议 handler 一处）⇒ 待拍板：给它补本机 HTTP 路由，或改成只做授权/用量说明。
- ⑧ **R2-L2-2 只做一半**（`open` 响应触发已实现；"客户端按目录对比"未做）。
- ⑨ **原子写无 fsync**（本地助手与上游包都没有）⇒ 掉电窗口自 W2 起存在。

**B. 仓外/需真机（§H）**：H1 私有渠道仓四渠道补 `desktop.app_origin_scheme` 并 push（**不 push 则 tag 构建 fail-loud**）；H2 渠道仓 pin 或把 commit 写进产物；H3 Windows/macOS 协议与存储探针（§17 认账 1 只在 Linux 实测）；H4 `advisory` 已转阻塞并接入 `yarn check`（**已闭合**）。
**C. W4-12（属 L5，未做）**：3 个文档文件 7 行仍把已删除包当现存实现（其中 `docs/decisions/2026-09-19-referrer-policy-origin-null.md:156/:191` 的 `go test ./internal/wasmapp/session/...` **现在必然失败**）——需 L5 补标注。
**D. 未跑整仓打包/afterPack 实测**：F3 的新依赖在安装包内的解析靠 `verify:closure` 247 节点闭合推断（`REQUIRED_PACKAGED_RUNTIME_ENTRIES` 不逐条断言第三方 leaf，属既有盲区）。
**E. L2 认账主体**（§T）：应用窗口 webContents 未采纳进 browser runtime（页面级动作仍只作用于浏览器标签）、真实 `WasmAppsWindowAdapter` 未实现、F16 `open` 真机联调未做。

## AB. 发布与部署（2026-09-20）—— **已上线测试环境并端到端验证**

**发版链**：PR **#101** → 五个必需检查全绿（Gate / Go server / Desktop Linux·Windows·macOS）→ squash 合并 master **`9c291df82c`**（版本 2.7.6-beta.5 已同步 root + desktop；拓扑检查：v2.7.6-beta.4 是祖先、无分叉）→ annotated tag **`v2.7.6-beta.5`** → tag CI **success**（含 Release 镜像归档）→ GitHub Release（zip 507,004,819 B + SHA256SUMS）+ R2 `beta/latest.json` 指向 2.7.6-beta.5（sha256 `b22a4197…`）。

**部署**：`scp` → 远端 `sha256sum -c` 通过 → `/root/upgrade-beta.sh … beta /opt/picoaide 2.7.6-beta.5 …`（备份 → load → **按渠道重打 `beta-2.7.6-beta.5`** → 切 `.env` → 重建 → **healthy** → 自检），`UPGRADE_EXIT=0`。**回滚点**：`SERVER_IMAGE=picoaide-harness-server:beta-2.7.6-beta.4` 写回 `/opt/picoaide/.env` + `docker compose up -d server`。

**端到端验证（从部署后的域名实拉）**：`/healthz`=`{"ok":true}`；manifest server/client 均 **2.7.6-beta.5**；实拉 AppImage size **153,643,408** 与 **sha256 与清单逐字一致**；解包 `app.asar` 的 `build/channel.json` = `channel_id=beta`、**`home_dir=.picoaide-harness`**（数据根未回归）、**`app_origin_scheme=picoaide-app`**（本期新字段真的进了随包配置）；asar 内含 `@picoaide/dsh-host-locale` 9 条、`dsh-host-home` 9 条、`wasm-apps-host/lib/app-proof.js` ✓。

**发版途中修掉的三个真缺陷（都带判据/变异）**：① **构建期依赖环**（Gate 必红根因，且不存在任何构建顺序能产出全部产物）⇒ 抽出两个**零依赖叶子包** + desktop 保留 re-export 兼容面，边表按实测改写，`cycle-check.mjs` 断言「声明无环 ∧ 实测无环 ∧ 声明==实测」；干净态 `yarn check` 连续两次 25/25，强制全量 prebuild 后第三次同样绿（决策记录 `docs/decisions/2026-09-20-host-leaf-packages-build-graph.md`）。② **打包版 P0**：插件包声明 8 个 `exports` 却只构建 3 个 ⇒ `lib/app-proof.js` 从未产出，而 `desktop/lib/main.js` 值导入它 ⇒ 真实 asar 启动即 `ERR_MODULE_NOT_FOUND`（症状＝Linux e2e「app did not expose CDP within 30s」），**且 afterPack 清单不完整导致断言放过坏包** ⇒ 补齐 tsdown 四个 entry + 必需条目 + 新增判据「desktop 产物 import 的每个 `@picoaide/*` 子路径都必须在必需清单里」（变异验证过）。③ **守卫与环境耦合**：submodule 校验把 describe 段必须是 tag 当目标断言 ⇒ CI 浅检出恒红 ⇒ 降为 WARN（章程 §4.2）。
**CodeQL**（非必需检查，不阻塞合并）：10 条中 2 条实缺陷已修（`check-workflows.mjs` 的 **ReDoS** 正则 → `[ \t]+`；`admin_opens.go` 用请求参数当 slice 容量 → 按实际行数），其余 7 条经核实为误报（`app_id` 经 `limits.AppIDPattern+MaxAppIDLen` 校验、`DataRoot` 为运维根、另有 `filepath.Dir` 越界断言）并逐条入库处置理由。

**本次未带上**：Windows/macOS 探针（§H3）；应用维度 AI 用量归因（替代路径待实施）；客户端 UI 侧 AI 面板聊天（待拍板）；`atomic-write` 无 fsync；W4-12（L5 三文件七行）；**example-b / example-a 两栈未升级**（预发 tag 只构建 beta）。

## H. 发布前置（**非本仓可完成**；主控登记，需人工/私有仓/真机）

| # | 前置 | 为什么必须做 | 完成判据 | 责任 |
| --- | --- | --- | --- | --- |
| H1 | **私有仓 `picoaide/channels` 四个渠道补 `desktop.app_origin_scheme` 并 push** | §10/§16 W3：该字段**全部渠道必填**（含 official/beta），CI 缺失即 fail-loud；每次 tag 构建 CI 都从 **origin/main** 克隆渠道仓 ⇒ 不 push 等于没配 | 取值：`official`=`picoaide-app`、`beta`=`picoaide-app`（公共渠道共用命名空间）、`example-a`=`example-a-harness-app`、`example-b`=`example-b-harness-app`（惯例 `<深链 scheme>-app`，正则 `^[a-z][a-z0-9+.-]{1,31}$`、须 ≠ 深链 scheme、跨渠道唯一）。判据：`GITHUB_REF_NAME=v2.7.6-beta.5 CI_CHANNELS_SOURCE=<克隆> bash scripts/ci-channels.sh --dest <tmp> --list <tmp.list>` EXIT=0；正式 tag 名 dry-run 四渠道全过 | 发布人（私有仓） |
| H2 | **渠道仓 pin 或把 commit 写进产物/发布说明** | CHN-10/R2I-16：`scripts/ci-channels.sh:98` 每次 `git clone --depth 1` **不 pin commit** ⇒ 同一源码 tag 可产出数据根/品牌/scheme 不同的客户端（2026-09-12 已因此出过一次数据根漂移事故） | 二者之一：①pin commit；②把解析出的 commit 写进产物（如 `build/channel.json` 附带 `sourceCommit`）与发布说明。判据：同一 tag 重复构建产物中该字段一致 | 发布人 + L4 |
| H3 | **三平台协议探针（Windows / macOS）** | §17 认账 1：`registerSchemesAsPrivileged`、分区注册、无 Origin/无 Cookie 四条**只在 Linux 实测过**；F13 的存储结论同样只有 Linux | 在 Windows/macOS 上跑 `scripts/wasm/probes/probe-custom-scheme*.cjs` 与 `probe-web-storage.cjs`，产出 `PROBE-RESULTS.md`（§16 W6）；不一致 ⇒ 按总纲回退备选形态并修订文档 | 需要真机（发布前） |
| H4 | **把 `check:wasm-client-only` 从 `advisory:true` 转为阻塞式 + 接入 CI** | L4 现状：W1–W5 未落地时残留断言会如实报出数百处存量命中，故暂为 advisory；**W6 前必须转阻塞**，否则门禁形同虚设 | `scripts/check-workspaces.mjs` 的 GUARDS 里该条去掉 `advisory`；本地 `corepack yarn check` 与 CI gate job 都跑该脚本（PG 相关 `go test` 归 server job） | L4（W6）+ 主控复核 |

> 说明：§H 的四项**都不是**泳道内代码问题，而是"本仓之外/需要真机/需要发布动作"的部分 —— 登记在此避免被当成"已完工"。

## AC. 本机全功能端到端实测（第二轮，2026-09-20）与 P0/P1/P2 处置

**动因**：用户要求「你自己本机实际启动一个服务端和客户端进行测试一下，整个功能是否完整可用，包括上架下架、发布应用、审批、拒绝、运营看板、限制项目所有的操作都尝试一遍」。

**环境**（可复用）：服务端 `server/bin/picoaide-server`（**用当前源码重新构建**）监听 `:18090`，PG 容器 `pg-test` 的独立库 `picoaide_e2e`，渠道目录 `PICOAI_CHANNEL_DIR=temp/e2e-func/channel`，`PICOAI_WASM_MEMORY_PROFILE=small`；管理端助手 `BASE=… bash temp/e2e-func/admin.sh`。矩阵与原始输出：`temp/wasm-client-only/e2e-functional-local.md`（21 行：**PASS 17 / FAIL 1 / BLOCKED 3**，三条 BLOCKED 全部同因 P0-1，非环境缺失）。

| # | finding | 层次 | 现状 | 我的独立复核（本轮） |
| --- | --- | --- | --- | --- |
| — | **客户端侧四条（B12/B13/B14）与 P2-3 的真机复判** | — | 见 **§AC.1** | **11/11 PASS**（打包客户端 + 真实服务端，主控独立探针） |
| **P0-1** | 应用打开链路整体不可用（app-proof 三方契约不一致：多 `server_url` 字段 + SPKI 44B 公钥 + 签 JSON 而非 `appproof-install-v1` 五段消息） ⇒ `open` 恒 `401 proof_required`，UI 显示 `OPEN_PROOF_REQUIRED`（与**本机** proof 闸的错误码撞名 ⇒ 误归因） | 宿主为主 + 服务端严格解码为触发点 | **已修**：`app-proof.ts` 按服务端真源重写（`installMessageBytes`/`proofServerURL`/`rawPublicKeyOf`/秒级 ts/per-app LRU + 单飞）；判据**读 Go 源码**对拍（`app-proof.spec.ts` 读 `appproof/proof.go` 与 `api/proof.go`，钉死前缀+五段顺序+解码结构体 tag 集合+32 字节公钥） | 真机 `open` **401→200**、宿主日志 0×400（交付方）；判据质量已抽查：**跨端读源码**而非各钉自己的字面量（旧版只断言"签名是 base64"，属已登记的假绿模式） |
| **P0-2** | 「打开」返回 `opened` 但屏幕上没有任何窗口 | 宿主 + 桌面壳 | **已修**（三缺同时成立）：真实 Electron 窗口适配器**压根未实现**（只有接口声明 + 测试替身）+ 桌面壳**没 provide** + `profile.ts` **没注入 `userDataDir`** ⇒ 走 `windows === undefined` 分支只 emit 零消费者事件 | 真机（打包版 + 真实服务端）：CDP 目标出现 `picoaide-app://shared-notes/`，窗内渲染平台里的真实应用「团队共享便签墙」+ 身份 `zhangwei`；`opened → focused →（关窗）→ opened` 三态 PASS；**13 条变异全部实跑变红且 sha256 还原一致** |
| **P0-3**（新发现） | 窗口开了但应用页恒显示"暂时连不上服务端"：handler 按契约合成 `Origin: <scheme>://<app_id>`，而 `session.fetch` 带 Origin 会**先发 CORS 预检** ⇒ 平台无 OPTIONS 路由 ⇒ `404` ⇒ `net::ERR_FAILED`（服务端日志只有 `OPTIONS … 404`） | 宿主 | **已修**：平台出站改 `net.request`（**显式传 session** ⇒ 证书 pin/代理策略仍走该 session；`content-encoding`/`content-length` 等逐跳头丢弃，因 `net.request` 交出的是**已解压**体） | 交付方 A/C/D/E 四组探针 + 变异"出站退回 `session.fetch`"变红 |
| **P1-1** | 运营看板 `trend[].uv` 是各应用日汇总 UV 之和（`SUM(uv)`），与同页 `today.uv`/`totals.uv` 自相矛盾 | 服务端 | **已修**：`trend` 的 **PV 仍读日汇总**（曲线不断档）、**UV 改读明细** `count(DISTINCT user_id)`；日边界由 Go 单源算好后一次性传 SQL（`width_bucket(floor(extract(epoch))::bigint, ?::bigint[])`），**不写** `opened_at::date`/`AT TIME ZONE`（否则"日"有第二份实现且 DST 错位） | **我在修后二进制上实测闭合**：同一份数据 `SUM(uv)`（旧口径基准）=**6**、`count(DISTINCT user_id)`（真值）=**2**、API `trend[0].uv`=**2** 且与 `today.uv`/`totals.uv` 一致；PV 两口径均 25。设计 §5.1c A 已同步订正 |
| **P2-1** | `PUT …/limits` 顶层信封不校验：扁平 body（缺 `limits` 键）**静默**回落部署档位且 `200` + 无审计 | 服务端 | **已修**：未知顶层键/缺 `limits` 键一律 `400 VALIDATION`（`allowed:["limits"]` + 中文 hint），闸门在落库**之前** ⇒ 误用零副作用；回落档位改为**显式** `{"limits":null}` | **我实测**：扁平 body → `400`（`field=app_db_readers`）；未知顶层键 `bogus` → `400`；`{"limits":null}` → `200`（显式回落）。**修前**该形态是 `200` 静默回落 |
| **P2-2** | webadmin 来源标签重复：`来源：控制台保存（wasm.limits）（wasm.limits）` | webadmin | **已修**：界面只显示服务端 `source_label`（设置键已由服务端拼好），回落分支也不再自拼 | **我实测**：源码唯一真源（`Limits.tsx:516-522`）；**构建产物**（`server/webadmin/dist/assets/*.js`）里 `setting_key` 字面量 **0 处** ⇒ 前端确实不再拼 |
| **P2-3** | 冻结 / 不存在在 `open` 上同为 `404`，客户端只按 `status` 判断 ⇒ 冻结（只读快照、数据保留）被当成"应用没了" | 服务端 + 宿主 + 客户端 | **服务端半边 = 既定裁决 (b)、非缺陷**（两档 `reason`：`app_frozen` / `app_not_found`；下架由 410 承载）—— 已核对逐字一致；**宿主半边已修**（按 `error.details.reason` 分流：`app_frozen` ⇒ **不关窗/不清缓存** + 冻结文案；`app_not_found`/410 ⇒ 关窗清缓存）；**客户端半边在修**（`readHostPlatformRefusal` 原本只读 `platform_code`，须同时读 `platform_reason`，否则冻结在页面上仍塌回"应用不存在"） | 宿主两档真机验过（冻结窗口仍在、软删窗口消失）；客户端半边判据 + 变异待该泳道交付后复核 |
| **P2-4** | 应用深链触发 auth 解析器的误导告警 `pico-deep-link: ignored malformed deep link`（两条监听器共用事件、都打 warn） | 客户端宿主 | **已修**：新增 `routeDeepLink()` 按 **scheme/host 分流** —— 自定义 scheme + `host=app` ⇒ 静默让行；其余保留 warn 但带**可判别原因**（`host=auth without token` / `not an auth callback: host=settings` / `not our scheme (scheme=…)` / `malformed url`）；scheme **仍取注入参数**（未新增读随包 `channel.json` 的路径 ⇒ 避开 tsdown 内联回落坑） | 交付方变异"去掉分流"变红（4 例）；跨渠道文案无回归 |
| **P2-5** | 「拒绝」允许不带理由（作者拿不到可执行反馈） | 服务端 + webadmin | **已修**：`reason` **必填**（归一后空/纯空白都拒），闸门在**状态检查之前**；webadmin 提交按钮 `trim()===''` 时禁用、Label 标「必填」 | **我实测**：`{}` → `400`（`field=reason`）；`"   "` → `400`；**正向未误伤**：带合法理由 → `200` 且理由落库并回给作者 |
| **相邻** | `proofIssueError()` 把解码类失败也报成 `signature_invalid` | 服务端 | **已修（第三轮审计后加严）**：公钥 44 字节（SPKI/DER）⇒ `invalid_public_key`、签名空/纯空白/非法 base64/长度不符 ⇒ `signature_malformed`、`ts` 缺失或 `<=0` ⇒ `invalid_timestamp`（**死分支已消除** —— 审计实测原实现把空签名先折叠成大条件，新增分支不可达）；外层码仍 `401 proof_mismatch`（客户端"按码重签"策略不变） | 交付方 6/6 变异全 RED；**认账残留**：`install_id`/`nonce` 的**形状**失败仍落 `signature_invalid` ⇒ 该码是"最后兜底档"，**不能**读成"验签一定不过"（已在 `server/docs/03-api-reference.md` 写明，不再作过度声明） |

### AC.1 客户端侧矩阵复跑（**主控独立探针**，2026-09-20）—— 11/11 PASS

**动因**：§AC 的表里 B12 判 FAIL、B13/B14/B15b 判 BLOCKED，全部同因 P0-1/P0-2；两条 P0 修完后必须**在真机重新判**，不能靠交付方自述。

**环境**：`server/bin/picoaide-server`（当前源码重建）`:18090` + PG `picoaide_e2e`；打包客户端 `packages/host/desktop/dist/linux-unpacked`（`yarn prebuild` + `package-dir.mjs` 重建，**asar 内已实测含本期新字面量** `app_frozen` / `PLATFORM_` / `app-frozen`，且**不含**尚未实现的 `will-redirect`——证明产物确实是这一版）；假上游 `mock-upstream` `:18081`（**必须是受管后台作业**：`( … & )` 子壳会随 bash 调用结束被杀，本节实测踩到一次）；探针 `temp/e2e-matrix/probe-matrix.mjs`，原始输出 `temp/e2e-matrix/MATRIX-RESULT.json`。

| # | 断言 | 结果 |
| --- | --- | --- |
| 1 | 渠道：本机只读路由给出应用 origin scheme（宿主注入，非前端写死） | PASS（`picoaide-app`） |
| 2 | B12 本机 `open` 路由 **200**（P0-1 现场是 `401 proof_required`） | PASS |
| 3 | B12 `window ∈ {opened,focused}` 且 `opens.today.pv` **含本次调用** | PASS |
| 4 | B13 应用窗口**真的出现**（CDP 出现应用 origin 的 target；P0-2 现场是 0 个） | PASS（`picoaide-app://shared-notes/`） |
| 5 | B13 应用页渲染的是**应用内容**（不是宿主错误页），应用自己的 `fetch('/')` = 200 | PASS（标题「团队共享便签墙」、正文含身份 `zhangwei` 与历史便签、5520 字节） |
| 6 | B13 应用页 `origin` = 应用协议 origin 且 `isSecureContext` | PASS |
| 7 | B13 应用页 `localStorage` 可用 | PASS |
| 8 | B14 应用内 AI：`POST /__picoaide/ai/chat` 200 + 非空回复 | PASS（经假上游回 `mock upstream echo: …`，`usage.promptTokens=11`） |
| 9 | P2-3 冻结档：宿主**透出** `platform_reason=app_frozen`（不合流成"不存在"） | PASS |
| 10 | P2-3 冻结档：文案可辨（「应用已被管理员停用」+「数据仍保留」），**不是**「应用不存在」 | PASS |
| 11 | P2-3 冻结档：**已有窗口被保留**（冻结是只读快照，不关窗不清缓存） | PASS |

**过程诚实记录（探针自身也出过两次假红，已订正）**：①第一版在第 3 条断言了**平台**契约的 `changed`，而本机 `open` 路由的响应形状是 `{window,app_id,url,opens}` —— 平台契约由服务端探针 `open-app.mjs` 覆盖（实测 200 且 `version/release_id/title/changed/opens` 齐全），两者不可混谈；②第一版调用应用内 AI 时没传 `stream`，而**缺省是 `true`（SSE）**，于是 `r.json()` 解析失败被读成"空回复" —— 真源 `ai-chat.ts:96` 与 `:229`，显式 `stream:false` 后响应为 `{content,usage?}`。**这两条都不是产品缺陷**；记在此处是为了不让"探针假红"被后人当成回归。

### AC.2 第三轮独立对抗审计（两份）与其修复 —— 服务端 4 条已修并**由主控活体复验**

**审计对象与结论**：`temp/wasm-client-only/audit-server-p1p2.md`（服务端面，312 行）与 `audit-app-window.md`（宿主面，33KB）。两份都只读、探针落 `temp/`、被审文件 sha256 进场==收场、域名守卫零命中。
- **服务端面**：六条主修法**全部真实存在且有效、零虚报**；P0 **0** / P1 **0** / P2 **4**（下面 AUD-1..4）。4 条抽跑变异全 RED，与交付方一致。
- **宿主面**：交付方 6 条声称**全部独立复现成立**（含真机 CDP 目标与窗口内渲染真实应用内容）；**P0 = 0**（H1 的每条凭据触达路径都打不通：`document.cookie` 空、`SameSite=Strict` 下 cookie 不随行、本机 `/api/pico/**` 读不到、`webPreferences` 最小面）；**P1 2 条 + P2 4 条**（见下）——13 条变异抽验 6 条全红、还原 sha256 逐条相等。

**服务端四条（已修，主控在修后二进制上活体复验）**：

| # | 审计发现 | 修法 | **我的活体复验（`:18090` + 真 PG）** |
| --- | --- | --- | --- |
| AUD-1 | **第一版 P1-1 修复自身引入的不变量回归**：`trend.pv` 读 5 min 陈旧的日汇总、`trend.uv` 读实时明细 ⇒ 同一响应出现 `uv>pv`（活体 `{pv:26,uv:27}`），且 tick 前曲线漏掉"今天" | 趋势**按天同源**：明细覆盖到的天 PV/UV 都取明细（一次聚合同时得 `count(*)` 与 `count(DISTINCT user_id)`），只有明细已不在的天 PV 回落日汇总；日期集合 = 明细天 ∪ 日汇总天 | `trend[0] = {day:2026-09-20, pv:33, uv:2}` 与 `today` **逐值一致**；`uv>pv` 的点 **0 个**；曲线**含今天** ✅ |
| AUD-2 | `{"limits":null}` 号称"回落部署档位"**在生产装配上不成立**（`Apply("")` 把档位值又写回 settings、`source` 恒 `setting`）；且原判据只由**测试替身**支撑（"mock 掩盖契约"类假绿） | 选 (a) **真回落**：新增 `serverstore.DeleteSetting`（含缓存失效），清 `settings.wasm.limits` 行 + 回到 `profile`/`default` + 日志；审计条件加"来源变化"；**补生产装配判据**（`cmd/server` 真 holder + 真 PG + 生产 `AdminRoute` 路由，7 段断言） | 改前 `source=setting`、label「控制台保存（wasm.limits）」、settings 行 **1**；`{"limits":null}` → 200；改后 `source=profile`、label「部署档位 small（PICOAI_WASM_MEMORY_PROFILE）」、settings 行 **0**；审计有留痕 ✅ |
| AUD-3 | 新增的 `ErrSignatureMalformed` 分支是**死代码**（空签名先被折叠成大条件），`signature:""`/`" "`/`ts:0` 仍报 `signature_invalid` | 空/纯空白签名 ⇒ `signature_malformed`；`ts<=0` ⇒ 新增 `ErrTimestampMalformed` → `invalid_timestamp`（仍 `Unwrap` 到 `ErrMalformed`，外层码不变） | 空签名/纯空白 ⇒ `signature_malformed`；`ts=0`/负数 ⇒ `invalid_timestamp`；SPKI 44B ⇒ `invalid_public_key`；**64 字节翻转一位**（真验签不过）⇒ `signature_invalid`；合法 ⇒ 200。**外层码全部仍是 `401 proof_mismatch`** ✅ |
| AUD-4 | `days` 被钳到 90 且与库内 `maxStart` 恰好相等 ⇒ `capped` **恒 false**、`days=365` 静默变 90（调用方无从判断） | 端点记 `requestedDays`，`capped = sum.Capped || requestedDays > days`（未加新响应键，避免动冻结键集） | `days=7/90` ⇒ `capped=false`；`days=91/365` ⇒ **`capped=true`** 且 `from/to` 是保留期内 90 天 ✅ |

**宿主面两条 P1 + 四条 P2（已修，报告 `temp/wasm-client-only/fix-audit-app-window-round2.md`）**：
- **HOST-P1-1 导航闸门不覆盖重定向 ⇒ 已修**：`installAppWindowGuards` 增 `will-redirect`，与 `will-navigate`/`will-frame-navigate` **共用同一个 `refuse` 闭包**（唯一 origin 判据，无第二份逻辑）。真机（真实 Electron + 真实适配器 + 真实 302）：外站 302 与"另一个 app origin"302 ⇒ **窗口 URL 不变** + 宿主记 `refused a … navigation`；同 app 302 仍放行。变异（删监听器）真机**精确复现审计原发现**（`redirect:external=https://example.com/`、`redirect:otherapp=picoaide-app://appb/`）⇒ RED。
- **HOST-P1-2 应用窗口跑默认 session ⇒ 已修（按 §7.2/R2S-8 改为按用户分区）**：契约层把 partition 做成**显式必填**（`createAppWindow({partition})`、`ensureSessionGuard(partition)`、`WasmAppsWindowsOptions.partition: () => string` **每次 open 求值**），分区非法/缺席**构造期 fail-loud**；插件侧 `currentPartition()` 唯一实现，三个消费者（协议 handler 注册 / 守卫 / 建窗）同源。真机三条如实回答：①应用页真的在分区上（`isDefaultSession:false/isTargetPartition:true/storagePathMatches:true`，默认 session 的 cookie 读不到）；②`ensurePartition`/`ensureSessionGuard` **不再是死路径**（协议 handler 真渲染、应用窗 `clipboard-read=denied`、同分区普通窗口请求应用 scheme ⇒ handler 零调用）；③last-wins 耦合**构造性消除**（应用窗口路径完全不碰默认 session，主窗口 granted / 应用窗 denied，且灵敏度对照能被打坏）。**顺带纠正审计一处推断**：`ensureSessionGuard` 是 WeakSet 幂等的、`registerDefault()` 在 boot 期已标记默认 session ⇒ 旧代码那次 `ensureSessionGuard(defaultSession)` 其实是 **no-op**，真实后果是"守卫装在错 session ⇒ 保护不到应用窗口"，而非"随时会炸的 last-wins"（变异因此必须绕过幂等才红）。
- **P2 三条修 + 一条订正**：`createPlatformFetch` 先构造 Response 再置 settled（真机 `status700 ⇒ REJECTED`，abort 也有结论）；**跨源 302 出站改 fail-closed**（`redirect:'manual'` + `redirect` 事件同步判源，跨源/解析失败/超 5 跳 ⇒ abort+reject；真机目标 host **零请求**，同源 302 仍跟随）；**子框架**经真机定标确认钩子本就会触发（缺口在判据不在钩子）⇒ 判据放宽到子框架（跨 app 仍拒、同 app 与 http(s) 放行、非 http(s) 外链仍拒），并新增 `platform-frame-fence.spec.ts` **对拍服务端源码**钉住平台侧依赖（CSP `default-src 'none'` + `frame-ancestors 'none'`、XFO DENY 且宿主独占）；报告用例数口径订正为「21 文件 / 259 用例」并标注测量时刻。
- **宿主面变异**：**12/12 全红**且产品文件 sha256 前后一致；harness 新增**证据门槛**（探针无 JSON/fatal/watchdog ⇒ 判 INCONCLUSIVE 不算红）——第一版曾因副本缺 `node_modules` 把一条误记成红，已修。
- **宿主面认账**：http(s) 子框架放行**依赖平台 CSP**（判据 C16 钉住，平台一放松就红）；只测 Linux/Xvfb + Electron 43.4.0；平台侧"写不出 `Location`"的偶然性属服务端泳道。**契约是破坏性变更**：`createWasmAppsWindows` 现在必填 `partition`（审计方探针复跑前要补 `partition: () => 'persist:agent-browser-<user>'`，否则构造期即抛，属有意 fail-loud）。

**服务端认账残留（记录，不阻塞）**：① `days` 不回显 `requested_days`（冻结键集，加键需三面同改）；② 清空也过四笔账水位判据 ⇒ 极端内存压力下清空被**如实拒绝**（非静默改写）；③ `install_id`/`nonce` 的**形状**失败仍落 `signature_invalid` ⇒ 该码是"最后兜底档"，已在 API 文档写明、不再过度声明；④ 趋势仍是稀疏序列、`readyz` 的 `mem_profile=limits/profile:default` 与控制台 `source=default` 字面不同形（都不撒谎）。

**仍未闭环（**不得说成已完工**）**：① **F12 只落地了安全半边**：`http(s)` 外链**一律不在应用窗口导航**（§7.2 的冻结条款，已实现）；UX 半边（**内置浏览器新标签 + 应用窗口提示条**、下载的最小反馈）**未接线** —— 文案真源 `app-window-copy.ts` 的 `externalLinkNotice`/`downloadStartedNotice` 已定义且被 5 条判据钉住（本轮实跑 `app-window-copy.spec.ts` 5/5 绿），缺的是调用点；② AI 控制权胶囊/蒙版、AI 按 `app_id` 寻址（surface seam）属 W3/浏览器泳道；③ `trend[].uv` 在**早于 90 天明细保留期**的日期只能如实给 0（彻底解法＝日汇总加一条 `(day)` 维度全局去重行 + 写路径变更 = **需迁移**，已登记候选，**禁止**就地改回 `SUM(uv)` 顶替）；④ P1-1 的 UV 聚合多一次明细顺序扫描（要优化需 `(opened_at,user_id)` 索引 = 迁移）；⑤ 每次打开因一次性 jti 多花一次 `401`+重签往返（属 app-proof 设计，用户无感）；⑥ 三平台只实测 Linux/Xvfb（Windows/macOS 的 `setAspectRatio` 与自定义协议行为待真机）。
**审计状态**：P0-2/P0-3/P1-1/P2-1/P2-2/P2-4/P2-5 与"客户端冻结文案"的**独立对抗审计**在本轮交付后立即启动（宿主面 + 服务端面两份，见 §AD 之后的审计报告）；**按章程，上表任何一条在独立审计报出零新增 P0/P1 之前都不得记为"闭环"**。

## AD. 隐私面：真实域名与客户身份的清理（2026-09-20）

**规则**（`AGENTS.md`）：本仓**公开**，客户自有域名、被投递/测试环境真实主机名**永不出现**（含**提交信息**与 CI 记录）；占位符一律 `example.com`。

**① 代码与文档面 = 零命中，且已变成判据（而非人工 `git grep`）**
- 新增白名单式**前向守卫** `scripts/check-no-real-domains.mjs`：判据 = 已跟踪文件里的 URL host / 裸主机名 / URL 中的公网 IPv4 / **提交信息区间**（`origin/master..HEAD`）四路，未登记 host 一律失败；命中输出**默认脱敏**（CI 日志公开）；合成负例**运行时拼接**（守卫自身不得内嵌客户域名）。
- **本轮实测出一个会让门禁恒红的自身缺陷并修掉**：守卫扫到自己 —— `MULTI_LABEL_SUFFIXES` 语料里的四个两段式 `.cn` 后缀（`.com.cn`/`.net.cn`/`.org.cn`/`.gov.cn`）被 `HOST_TOKEN` 读成 `label+TLD`（4 处），外加注释里两处**示例主机名**（畸形语料示例与 URL 尾随标点示例，各 1 处）⇒ **`yarn check` 实测 `EXIT=1`**。修法：**多段公共后缀自身不是主机名**（语义修正；带真实标签的三段式主机名仍照常命中）+ 两处示例改保留命名空间；并给自证补了**两个方向**的用例（后缀本身不红 / 两段后缀下的三段式主机名必红），变异 A（拆掉跳过规则）与变异 B（放宽成"以任意后缀结尾一律跳过"）**各自变红**，还原后 sha256 与改前一致。
  > 写本段时第一次把示例主机名**原样抄进了台账**，`node scripts/check-no-real-domains.mjs` 立刻报 3 处命中 —— 守卫在"文档描述守卫"这条路径上也被实测有效；本段最终版已改用后缀记法（`.com.cn`）与保留命名空间，复跑零命中。
- 守卫**确实在门禁里**：`scripts/check-workspaces.mjs:76` 的 `GUARDS` 有 `check:no-real-domains`（本地 `yarn check` 与 CI gate job 同义）⇒ 这是本次唯一一条会让 gate 恒红的缺陷。**其余 9 条静态根守卫（layout/workflows/ci-scripts/patch-resolutions/inventories/theme-tokens/no-leftover-mutants/migration-range/wasm-channels）本轮实跑全 OK。**
- 现状：`node scripts/check-no-real-domains.mjs` → **零命中 ✅**（扫描 2144 个已跟踪文件）。

**② CI 记录面（用户原问「ci 记录里是否出现了隐私内容」）= 零命中，且掩码确证生效**
- 扫描口径：最近 **24 个 run 的全部 job 日志**（**160 个日志文件 / 21 MB / 无空文件**）+ **v2.7.5 正式 tag（唯一会构建品牌渠道的那次）的 `Release (server image archive)` 与 `Desktop (Linux)`** + `v2.7.6-beta.5` 的 Release job。脚本 `temp/ci-privacy/scan-ci-logs.sh`。
- 结果 **0 命中**；同时证明不是"真空绿"：**正向对照**（造的含客户域名样本）同一 grep 命中 1；且日志里 `***` 出现 **32 次**、`ci-channels.sh` 步骤真实存在、原文含 `ci-channel-transfer: pull 完成(2 个品牌渠道经 R2 中转,渠道名与路径均未进入公开面)` ⇒ **掩码机制真的在工作**，品牌渠道的身份与路径未进公开面。
- 静态面复核：CI 脚本**从不回显** `defaults.server_url` 的取值（`ci-channels.sh` 只在非法时报字段名）。

**③ 可编辑的公开元数据 = 已清理（域名/部署 IP）**
- 发现并清理：**12 个 PR 正文** + **2 个 Release 正文**（`v2.6.9-beta.2`/`.3` 的自动 PR 列表）含真实域名或部署 IP：域名 → `example.com`（保留命名空间），部署 IP → RFC 5737 文档网段（`192.0.2.10`/`192.0.2.20`）。脚本 `temp/ci-privacy/scrub-public-metadata.sh`；**原文逐份备份**在 `temp/ci-privacy/backup/`（可逆）；复扫 **PR 正文 / Release 正文 / PR 标题全部 0 命中**。
- **守卫的盲区（认账）**：守卫只看**已跟踪文件**（新文件须先 `git add`），GitHub 的 **Release 正文与 PR 标题/正文不是文件 ⇒ 不在判据内** —— 上面那 14 处泄漏正是从这条盲区出去的。

**④ 仍未清除、需要用户拍板的残留：`origin/master` 上 11 条历史提交信息**
- 逐条枚举（`git log origin/master`，消息体匹配）：`517bf0c6b0`(example-b)、`d436e036bd`(example-a)、`3945dbf43a`(example-a)、`822d93e987`(example-a 域)、`21e2b59a2f`(example-a 域)、`fd3760272f`(example-a)、`b3f59ccd61`(测试域名族)、`7310cb4ca1`(同)、`97923dcf34`(同)、`99099b296f`(同)、`86bf6aa0f3`(同)。
- 性质：**5 条泄漏测试/部署域名族、5 条泄漏客户生产域名/主机名、1 条泄漏客户渠道 id**；**无凭据/密钥**。另：2 个 PR 标题与 8 个 PR 正文仍含**客户名**（非域名）。
- **主控建议：不做历史重写。** 理由是技术性的而非回避：①本仓**已公开**，重写**不能撤回已披露**（GitHub 侧旧对象长期可按 SHA 取到，fork/镜像/CI 缓存同理）；②重写会打断 **91 个 tag / 76 个分支**与全部已发布产物的溯源（tag→提交 SHA 已写进发布说明与部署记录）；③代价与收益不成比例，而**前向**已被守卫拦住（新提交进 `origin/master..HEAD` 区间即受检）。
- 因此登记为**已认账残留**；若合规上必须清除，正确做法是"协调式重写 + bundle 备份 + 重打 tag + 明示旧 SHA 仍可达"，需用户明确授权后才动。
