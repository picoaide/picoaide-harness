# 全仓自研代码审计报告（2026-09-23）

- **基线**：`master` @ `8405f78de6`，版本 `2.8.1`，上游 pin `ddefc45fbc7f`（dsh-v0.1.6-alpha.2）
- **范围**：本仓自研代码全部（客户端 `packages/**`、服务端 `server/**`、脚本与构建链 `scripts/**`、`.github/workflows/**`）；`deepseek-harness/`（只读上游 submodule）不是审计对象，但误用其 API 计入我方缺陷
- **重点**：客户端技能库安装/卸载/本地技能管理（用户点名"明确有 bug"）→ A 路专项；客户端各类问题 → B/C/D 路；服务端各类问题 → E/F/G/H 路；设计缺陷 → I 路；门禁可信度 → J 路；构建发布与文档 → K 路
- **方法**：11 路独立子代理并行只读审计 + 主控自查与交叉复核。所有 P0/P1 均要求 `文件:行` + 代码证据 + 推理链，能复现的必须给可复跑探针；探针统一落在 `temp/audit-2026-09-23/probes/**`（运行时产物、python 脚本、Go 探针、vitest spec、jsdom 探针）
- **纪律**：审计阶段只读（未修改任何 git-tracked 文件）；公开仓纪律（真实客户域名/主机名/IP/渠道名/品牌名一律用占位符）；不跑全量门禁以免多路互相踩

## 1. 总计

| 级别 | 客户端 (A–D) | 服务端 (E–H) | 设计 (I) | 测试/门禁 (J) | 构建发布 (K) | 合计 |
|---|---|---|---|---|---|---|
| **P0** | 1 | 4 | 1 | 0 | 0 | **6** |
| **P1** | 21 | 12 | 8 | 22 | 3 | **66** |
| P2 | 47 | 26 | 14 | 42 | 4 | **133** |
| P3 | 44 | 38 | 7 | 38 | 4 | **131** |
| 合计 | 109 | 80 | 30 | 102 | 11 | **332** |

> 口径：一条 = 一个可独立处置的缺陷。J 路的 22 条 P1 是**门禁/测试自身**的判别力缺陷（不直接是产品缺陷），单独计数以便区分处置节奏。B 路的 P1 含子代理补充条目（B-09/B-10/B-26）。

**一句话总判**：没有人身安全或不可恢复的越权/沙箱逃逸级缺陷，但存在**6 条 P0**——四条会造成**静默、不可逆的数据/配置/计费损失**（provider 价格被清零、cron 任务账本被覆盖、webadmin 部门归属被清空、LDAP/OIDC 配置被抹除），一条会**销毁已发布归档**，一条**公开仓身份纪律**违规。客户端技能库链路确实存在用户可感知的实质缺陷（5 条 P1，含"装完永远加载不到""同名自制技能被静默覆盖/删除""符号链接写穿技能库"）。

## 2. P0 清单（6 条）

| ID | 标题 | 位置 | 影响 | 修复状态 |
|---|---|---|---|---|
| **G-01** | 管理员一次常规「编辑上游→保存」把该上游**全部模型价格清零**，之后照常 200 交付、token 照记、`cost=0`；且全字段未变时零审计 | `serverstore/gateway.go:320-327`、`llmgateway/admin.go:404-414`、`webadmin/src/pages/Gateway.tsx:630,389-390` | 全组织 AI 费用归零；视觉模型退回 text-only；`default_params`（并发/max_output/上下文）一起丢失 | 修复中（泳道 F1） |
| **CR-1** | cron 账本**读失败被当"首次运行"**：任何 errno 都返回无标记空账本，下一次 `persist()` 覆盖不可读的原文件 ⇒ 全部定时任务（含 prompt）消失且**无备份** | `packages/host/cron/src/host-ledger.ts:212-218`、`:288-297`（真机 EACCES 复现） | 静默不可逆数据丢失 | 修复中（泳道 D1） |
| **WEB-1** | 部门树 GET 失败后「设置部门」对话框**不锁写面**，保存发出 `{"group_ids":[]}` ⇒ 清空该用户全部部门归属 | `server/webadmin/src/pages/Users.tsx:233-261,684` + `serverauth/admin.go:1779-1783,1827` | 部门级授权/预算同时失效 | 修复中（泳道 W1） |
| **WEB-2** | `GET /auth` 失败后整表解锁且为空初值 ⇒ 一次保存抹掉 LDAP/OIDC/OpenID 全部配置**并覆盖已存密钥** | `server/webadmin/src/pages/Auth.tsx:72,79-101,206,337` + `serverauth/admin.go:1426-1480` | 全员 SSO 当场失败，密钥不可恢复 | 修复中（泳道 W1） |
| **ID-01** | 「拒绝一个版本」在三个面三份实现，只有 WASM 面带前置条件：对**已通过且在服务中**的版本点「拒绝」会 `archive=NULL,size=0` ⇒ **不可恢复销毁归档字节**、版本对全员 404、版本号被烧掉；确认文案却写「可重新上传」 | 销毁点 `serverstore/apps.go:477-490`；WASM 正确守卫 `wasmapp/api/admin.go:559-575`；org 面 `sharedskills/routes.go:375-378`、`agentshare/routes.go:598-601`；UI `webadmin/src/pages/Capabilities.tsx:382-384,419` | 已交付内容不可恢复丢失 + 承诺与事实相反 | 修复中（泳道 G1） |
| **G-9**（公开仓纪律） | `scripts/check-no-real-domains.mjs:334,337` 的 selfTest 夹具用**运行时拼接**内嵌真实客户主机名片段与真实部署 IP 的四段十进制字面量 | 同上 | 违反 `AGENTS.md` 铁律 0（本仓公开；同类字符串曾导致一次全量历史重写） | 修复中（泳道 J1） |

## 3. P1 清单（按区域，含修复状态）

### 3.1 客户端技能库安装/卸载/本地技能管理（用户点名项，A 路 5 条）

| ID | 标题 | 位置 | 修复状态 |
|---|---|---|---|
| A1 | **装得上、运行时永远加载不到**：安装器名字规则比运行时 `isSkillName` 宽，且只查"根有 SKILL.md"、见 `---` 就不校验 ⇒ `my.skill`/`my_skill`/`alpha--beta`/缺 description/非法 frontmatter name 五种形态**安装成功但被运行时静默忽略**（界面显示已安装、模型侧没有、零报错） | `skill-install.ts:30,118-120,189-219` ↔ 上游 `skill/src/index.ts:21,35` | 修复中（S1） |
| A2 | 同名**本地自制**技能被市场/内置行的「更新」**静默整树覆盖**（覆盖确认是死代码：更新按钮硬编码 `force:true`） | `CapabilityCenterPanel.tsx:644-653,884,919-923` + `auth-gate.ts:2382-2398,2493-2518` | 修复中（S1） |
| A3 | 「卸载」按目录名删除、**不校验来源** ⇒ 删掉用户自制的同名技能目录 | `skill-install.ts:270-280`、`auth-gate.ts:2462,2496` | 修复中（S1） |
| A4 | `skill_manage` 写技能缺 `anchorDir` 断言：预置目录符号链接即可**写穿技能库外并返回 `ok:true`** | `memory-evolve/lib/skills.js:247-251` + `lib/sync/filesets.js:155-168,181-196,683-685` | 修复中（S2） |
| A5 | `fs.cpSync` 回落遇"目标同路径是文件"**直接 abort 宿主进程**（实测 exit 134），且 abort 前已写半成品 | `memory-evolve/lib/skills.js:196-203` | 修复中（S2） |

### 3.2 客户端宿主与插件（B/C 路）

| ID | 标题 | 位置 | 状态 |
|---|---|---|---|
| B-01 | `did-fail-load` 不区分主框架：**一次子框架失败**即整窗 reload、第二次换成崩溃回退页（真机 Electron 复现） | `electron-runtime.ts:918-926` | 修复中（B1） |
| B-02 | 致命启动失败无用户可见出口（注释自称有恢复对话框，实现里没有） | `main.ts:514-517`、`startup-rows.ts:152-157` | 修复中（B1） |
| B-03 | 崩溃回退的"重试一次"latch 被两个事件共用且不串行 ⇒ 错误页与 reload 同时发出 | `electron-runtime.ts:1008,1021-1035` | 修复中（B1） |
| B-07 | 下载器的文件系统/永久错误被压成可重试的 `network` 分类 ⇒ 本地永久错误重试 5 次并报"网络问题" | `update-download.ts` → `updates.ts` | 修复中（B1） |
| B-08 | 安装包下载**无停滞/超时检测** ⇒ 更新流程永久卡在"下载中"，占位让后续检查全部早退 | `updates.ts` | 修复中（B1） |
| B-09 | 渠道构建可**静默回落官方**数据根/userData/app origin | `scripts/channel-build.ts:410-413,437`、`desktop-channel.ts:445-460`、`verify-channel-package.ts:118` | 待排期 |
| B-10 | 登出吞掉 `unlink` 错误 ⇒ `{ok:true}` + 内存已清 + **文件仍在** ⇒ 下次启动自动登回 | `enterprise/src/session-service.ts:149-154` | 待排期 |
| B-26 | 更新插件 teardown 在重试退避期间**死锁**（quit 卡满宽限 + exit 1 + relaunch 被丢） | `updates.ts:227-234,847-861` | 待排期 |
| C-01 | 面板装载器 Esc 让位判据只认 `[role=dialog][aria-modal=true]`，不认 `role="alertdialog"` ⇒ 在「下架/删除」确认框上按 Esc **关掉整个应用中心** | `panel-surface/src/client/surface.tsx:153` + `wasm-apps/.../AppCenterPanel.tsx:1648,1973,2002` | 待排期 |
| C-02 | 「发布新版」表单 `submit` 的 `useCallback` 漏三个窗口几何依赖 ⇒ 作者最后填的窗口比例/尺寸被静默丢弃 | `wasm-apps/.../PublishForm.tsx:436,522` | 待排期 |

### 3.3 内置浏览器 / WASM 宿主 / 连接器 / cron（D 路）

| ID | 标题 | 位置 | 状态 |
|---|---|---|---|
| CN-1 | MCP 传输缝只禁重定向、**不施加出站 URL 策略** ⇒ `WWW-Authenticate: resource_metadata=` 可让 SDK 真访问任意 URL 并**带上 bearer 与静态头** | `connectors/src/mcp-transport-fence.ts:527-542,567-573` | 修复中（D2） |
| CN-2 | 静态端点分支不传 discovery ⇒ SDK 自行发现并把**存储的 refresh token** POST 到 MCP 自报的 token 端点（种子行即此形态） | `connectors/src/index.ts:428-459` vs `:472-476`；`mcp-oauth-provider.ts:279-289` | 修复中（D2） |
| BR-1 | 换号期间在飞的导航把**旧账号 URL** 写进**新账号** history/op log | `browser/src/runtime.ts:1963-2009,1100-1103` | 修复中（D3） |
| BR-2 | 渲染进程崩溃后**无界重载**（实测 100ms 内 4999 次、op log 洪泛） | `browser/src/runtime.ts:1064-1070` | 修复中（D3） |
| CP-1 | `browser_list_tabs` 的 render 不输出 `kind`/`app_id` ⇒ **应用窗口寻址对模型断路** | `browser/src/tools.ts:1358-1366,492-503` | 修复中（D3） |
| WS-1 | 直接切账号（无登出）不重建应用窗口 ⇒ 新用户聚焦并使用**上一用户分区**里的窗口 | `wasm-apps-host/src/index.ts:571-586`、`windows.ts:668-679` | 修复中（D3） |

### 3.4 服务端（E–H 路）

| ID | 标题 | 位置 | 状态 |
|---|---|---|---|
| E-01 | 登录失败预算「判定-记账」分离 ⇒ 20 并发错密实测 `401=16/429=4`（阈值 10），200 并发连续三次 `401=18/16/16` | `serverauth/ratelimit.go:130-189` + `handler.go:298,316`；管理面同形 | 修复中（E1） |
| G-02 | 渠道同步一轮**目录抖动**即物理删除有价模型行、下轮无价插回 ⇒ 该模型**永久免费**，无日志无审计 | `serverstore/gateway.go:388-396,341-351`、`llmgateway/sync.go:166` | 修复中（F1） |
| G-03 | embedding 落账 `provider_id=0` ⇒ failover 后按**别家价格**计费（实测 100× 多收） | `llmgateway/embedding.go:241`、`serverstore/usage.go:217-219,249` | **已修**（F2，带变异验证） |
| G-04 | `/v1/completions`、`/v1/responses` 流式用客户端 ctx（chat/anthropic 都用 `WithoutCancel`）⇒ 断连取消上游、少收/零落账 | `llmgateway/completions.go:170` | **已修**（F2） |
| G-05 | `weekFill` 不对齐周一 ⇒ `group=week` 丢尾部周桶（3 次/600 token 报成 1 次/100） | `serverstore/usage.go:506-515` | **已修**（F2） |
| G-06 | 账本回退切分点按月历而非"明细分区是否还在" ⇒ 明细仍在也读账本、静默 0；账本无周期重建 | `serverstore/usage_ledger.go:287-291,305` | 待排期（改动账本语义） |
| G-07 | 调大/关闭保留期后，已 DROP 月份从报表消失 | `serverstore/usage_ledger.go:280-291` | 待排期 |
| G-P1 | `skillmanifest` 的 YAML 解析只做长度+字符计数 ⇒ **merge key（`<<:`）fanout^k 展开**可被普通员工 Bearer 触发（2732B 输入 86–143 秒 CPU，爆炸点在发布咨询锁之前）；同一攻击类在姊妹模块 `agentshare/composition.go` 已被当真实漏洞修掉 | `skillmanifest/manifest.go:220-232`；可达 `sharedskills/routes.go:243`、`agentshare/routes.go:395` | 修复中（G1） |
| WASM-1 | `wasmmod/parse.go:536-578` 二级计数（`np`/`nr`）只继承一级上界 ⇒ 32 MiB 模块经 `wasmmod.Validate`（同进程、不发子进程）实测 `TotalAlloc 2.00 GiB`、RSS +590 MiB；入口是任意员工可调的 `/apps/wasm/validate` | `wasmmod/parse.go:536-578,592` | 修复中（H1） |
| WDB-1 | `SQLMaxResultBytes` 在单行物化+`[]byte→string` 之后才判 ⇒ `SELECT zeroblob(1MiB)×128` 实测 384 MiB / 446 ms（文档上限 8 MiB） | `wasmapp/appdb/stmt.go:85-113` | 修复中（H1） |
| WEB-3 | 应用中心详情抽屉三个 loader 无请求序号守卫 ⇒ 上一应用的迟到响应写进当前抽屉 | `webadmin/src/pages/app-center/Apps.tsx:562-645,1657` | 修复中（W1） |

### 3.5 设计缺陷（I 路，8 条）

真源重复测绘共 30 组（7 组判定安全、有真对拍；23 组为缺陷或部分缺陷），其中 **4 组分叉已在当前工作树实测复现**：

- **ID-02**：渠道构建的关键行注入靠 `rows.has(...)` **静默跳过** —— 缺一行等于品牌/服务端地址/深链 scheme 全丢且零信号；同文件 `desktop-shell` 行已用 `throw` fail-loud，其余 6 处静默，**现有测试还把"缺行就跳过"钉成预期**。
- **ID-03**：`app_id` 形态正则三份、声明真源互相指认、注释声称的"对拍"实为单向抽样。
- **ID-13**：渠道 id 形态**五份副本**，客户端/CI 比服务端**更宽**（`ab-`、`ab--` 能过 CI 与客户端校验并随包发布，服务端 `IsChannelID` 判非法 ⇒ `ResolveChannel()` 返回"不可确定"）；四份注释都声称"同源"。
- **ID-04**：其余无对拍的真源组（契约靠注释，注释已漂移）。

P2/P3 还包括：审计写入 best-effort 且 94 处调用点全部丢弃错误（计数有 API 出口、管理后台零展示）；安装器备份目录无清扫者；cron「删除运行中任务」两个入口结论相反；连接器瞬时刷新失败落终态并永久移出心跳；渠道 `home_dir` 变更无检测/迁移（旧数据根被静默遗弃）；应用源分区存储从不清理；`.legacy-claim` 锁无陈旧属主回收；浏览器数据根回落硬编码官方目录（绕过渠道派生点）。

### 3.6 门禁与测试可信度（J 路，22 条 P1）

**不能信的区域（本轮实测）**：

- **CSP 守卫只钉字面量不钉能力**：`electron-runtime.spec.ts:1175-1184` 是 `toContain` 子串 ⇒ 放宽 `script-src`（追加 `https: blob:`）、新增 `frame-src *`+`object-src *`、删除 `connect-src` **三种真实放宽全部通过**。
- **afterPack 真产物门禁双缺口**：`verify-packaged-runtime.ts:1040-1043` 仍是"整包目录不存在 ⇒ 不算缺失"，6 个原生包家族只有 1 个被补偿断言罩住 ⇒ 整包删掉 5 个家族 afterPack 依然 PASS；`REQUIRED_PACKAGED_RUNTIME_ENTRIES` **无完整性 oracle** ⇒ 删 3 条（图标/preload/web 产物）后 69/69 全绿（`it.each(清单)` 是自同义反复）。
- **权限点跨端对拍是 FAKE**：`webadmin/src/lib/nav.test.ts` 手抄 `AllPermissions` 副本、不读 Go 源 ⇒ 改 Go 权限点 13/13 全绿（本仓唯一确认的假对拍）。
- **路由申报守卫方向错**：判据是源码文本 `strings.Contains` + 硬编码 9 个字段名 ⇒ 把 `Wasm: wasmPlat.API` 注释掉/置 nil 时 8 条守卫全绿，而生产**静默丢 39 条 WASM 路由**；整行删除才红。
- **e2e 判据层多重恒真**：4 条"含预期内容/可打开/可输入/命令回显"的断言是恒真或 existence（"未执行也过"）；4 个探针硬编码 fixture 端口与 CDP 端口并**静默附着**到别的运行实例。
- **CI 静态守卫的模式绕过**：`|| /bin/true`、`|| sh -c 'exit 0'`、`|| $NOOP`、`set +o errexit`、`trap 'exit 0' ERR`、`time go test … -timeout 120m` + 诱饵 全部放行；守卫只保证"模式"不保证"步骤存在"（删 `go vet`/`npm test`/Release 步骤/整个 release job 全部 EXIT=0）。
- **许可证守卫**：`SEE LICENSE IN <file>` 只查文件存在不判文本 ⇒ GPL-3.0 文本也通过。
- **两条判据在 CI 里 100% 空转**：DST 日界用例因 CI 不设 `TZ` 恒 skip；全仓唯一 race 用例**零断言**且没有任何门禁跑 `-race`。
- **`make check` 与 CI 的 gofmt 口径分歧**：本地扫 `cmd internal demoapps`、CI 只扫 `cmd internal` ⇒ demoapps 格式问题"CI 绿、本地红"。

**可以信的区域（同样实测）**：WASM 沙箱三不变量、限流桶键、服务端条件注册路由声明表（双向）、usage 跨语言契约（真读对端 TS 源、集合全等）、`yarn check` 编排器本身（无假绿通道）、Go 测试库隔离。

### 3.7 构建/发布/文档（K 路 3 条 P1）

- **K-01**：R2 上传后**不校验大小/哈希**（只断言对象存在）⇒ 假 aws 把对象截断到 10 字节仍 EXIT=0 并写出指向损坏对象的 `latest.json`（与 2026-09-22 现场"宣告 522MB / 实际可读 383MB"同形）。
- **K-02**：同机多渠道德镜像 **tag 覆盖零防护零文档**（所有渠道共用 `picoaide-harness-server:v<ver>`，而部署文档的升级步骤正是踩坑序列）。
- **K-03**：README 中英两份的下载指引指向**不存在的 Release 资产**（客户端已随镜像分发，官网口径才是对的）。

## 4. 修复计划与状态

修复按"模块边界互不重叠"切泳道，每条修复必须带**回归测试 + 变异验证**（把实现改回旧行为，对应用例必须变红）。

状态列已于 2026-09-23 按**提交事实**核对（不是泳道自述）：主修复批 = `e0c95bf4e6`（6 P0 + 41 P1，177 文件），后续按缺陷追加的修复提交列在"状态"里。每条修复的变异验证与复跑输出在 `temp/audit-2026-09-23/fix-*.md` 与 `temp/round2-2026-09-23/fix-*.md`。

| 泳道 | 范围 | 覆盖缺陷 | 状态 |
|---|---|---|---|
| **F1** | `serverstore/gateway.go`、`llmgateway/admin.go`、`webadmin Gateway.tsx` | G-01（P0）、G-02 | **已修**：`e0c95bf4e6` + `4d4bbd8217`（缺失行不参与取参/缓存价）+ `28710ef460`（出站净化 allowlist 键随构造点更新） |
| **F2** | `llmgateway/{embedding,completions}.go`、`serverstore/usage.go` | G-03、G-04、G-05 | **已修**（`e0c95bf4e6`；变异全红，见 `temp/audit-2026-09-23/fix-F2-billing-aggregation.md`） |
| **S1** | `enterprise/src/{skill-install,auth-gate,archive-util}.ts`、`client/CapabilityCenterPanel.tsx` | A1、A2、A3、A6、A7、A8、A11、A12、A13、A15 | **已修**：`e0c95bf4e6` + `b4bee8c2e8`（收口两条 PARTIAL 与两条 P2） |
| **S2** | `vendor/memory-evolve/lib/**` | A4、A5、A9、A10、A16、上游 #59 本地加固 | **已修**：`e0c95bf4e6` + `4f49f31237`（随包同步来源闸门 + 渠道互斥） |
| **W1** | `webadmin/src/pages/{Users,Auth,Apps}.tsx` | WEB-1（P0）、WEB-2（P0）、WEB-3 | **已修**（`e0c95bf4e6`） |
| **D1** | `packages/host/cron/**` | CR-1（P0）、CR-2、CR-3、CR-4、CR-6、CR-7 | **已修**（`e0c95bf4e6`） |
| **D2** | `packages/host/connectors/**` | CN-1、CN-2、CN-3、CN-4、CN-5、CN-9 | **已修**：`e0c95bf4e6` + `ae1bccc222`（零凭据连接器不被设备码闸门误拒） |
| **D3** | `packages/host/{browser,wasm-apps-host}/**` | WS-1、BR-1、BR-2、CP-1、BR-3、WS-2、SN-1/EV-1 | **已修**（`e0c95bf4e6`） |
| **E1** | `serverauth/ratelimit.go`（+限流调用点） | E-01 | **已修**（`e0c95bf4e6`） |
| **J1** | `scripts/check-no-real-domains.mjs`、`desktop/scripts/verify-packaged-runtime.ts`、相关 spec、`cmd/server/routes_source_test.go` | G-9（P0）、G-1、G-2、T-01、T-02、T-03、T-04 | **已修**：`e0c95bf4e6` + `13846fad4c`（README.i18n 哈希漏记）+ `b015d2911c`（变异体守卫只扫可提交文件 + 扫描根断言） |
| **G1** | `serverstore/apps.go`、`sharedskills`、`agentshare`、`skillmanifest`、`marketplace`、`capabilities`、`webadmin Capabilities.tsx` | ID-01（P0）、G-P1、marketplace owner 无审计、待审投影污染、`appendSharedSkill` 漏拷、ID-03 | **已修**：`e0c95bf4e6` + `4d4bbd8217`（审核拒绝 error.code 三面同码）+ `0b50e83a54`（组织共享内容按 channel 走正确管理面命名空间） |
| **H1** | `wasmapp/{wasmmod,appdb,abi,api,diag}` | WASM-1、WDB-1、ABI-1 | **已修**：`e0c95bf4e6` + `4d4bbd8217` |
| **B1** | `packages/host/desktop/src/**` | B-01、B-02、B-03、B-05、B-07、B-08 | **已修**：`e0c95bf4e6` + `9bac6c24db`（增量重建判定必须校验声明产物存在） |
| **K1** | `scripts/ci-*.sh`、`ci.yml`、README、`docs/deploy/**`、site deployment 页 | K-01、K-02、K-03、K-04、K-05、K-07 | **已修**：`e0c95bf4e6` + `b8cbc30ddd`（文档与技能内容对齐代码真值） |

**第二轮（2026-09-23 同日）新增并已修**：MIG-1（**P0**，旧库 `usage` 普通表升级 ⇒ 崩溃循环，`accce75cc5`）、MIG-2（P1，同名技能回填静默丢 release，`accce75cc5`）、以及 W2/W3/W4 三路复核的其余 P1（详见 §7）。

**待排期（下一轮）**：B-09/B-10/B-26、C-01/C-02、G-06/G-07、ID-02/ID-04/ID-13 的收敛、J 路其余 P1（e2e 恒真断言、check-workflows 绕过、许可证守卫、TZ/race 空转）、以及 P2/P3（详见各子报告）。第二轮 W2/W3 的残余条目（`schema_migrations` 无校验和、站点侧上游 pin 等）见 §7 的处置列。

**收敛纪律**：每批修复完成后必须做 ①目标包测试单跑绿 ②变异验证红 ③独立子代理复审（不告知原判定）④连续两轮独立审计零新增 P0/P1 才算闭环。

## 5. 重要否定结论（勿重复排查）

- **WASM 沙箱不可逃逸**（能力不存在级）：只 instantiate `wasi_snapshot_preview1`、ModuleConfig 零 preopen、不传 args/env、能力面是封闭表且无路径参数、单实例/预算/大小上限真实生效。反证：注入 `WithFS(os.DirFS("/"))` 后 `open /etc/passwd` 变 ALLOWED ⇒ 用例必红。
- **客户端归档面已硬化**：zip/tar 的路径穿越、绝对路径、符号/硬链接、特殊文件、重复与大小写碰撞、70MiB 炸弹、"zip 声明尺寸撒谎" 全部被拒（17 组探针、库外零写入）；卸载/覆盖对符号链接只 unlink 不跟随；`SKILL_NAME_PATTERN` 对 `..`/`/`/绝对路径安全。
- **能力中心归属/占名语义正确**：历史空 owner 行不可被接管（409 且 owner 未改写）；大小写/Unicode/`..`/斜杠/空名在任何 DB 写入前被封死；首版占名竞态已由事务级咨询锁关闭；skillseed 内容摘要门禁真实有效（独立复算一致）。
- **服务端认证面**：管理面 152 条路由 / 申报 149 条 / **未申报=0**，149 条非公开路由未认证**全部 401**；`r.Use` 顺序、JSON 信封、访问日志丢 query、LDAP 空口令拒绝、OIDC state+PKCE+nonce+flow fail-closed、MFA 原子占用 + TOTP 步防重放、七条吊销路径、审计哈希链（6 万行清理 244ms）均达标。
- **门禁可信面**：见 §3.6 末段。
- **`check-workflows.mjs` 的字面量覆盖**：对 `|| true`、`continue-on-error: true`、job timeout 缩小、删 `go test -timeout` 四种变异**全部 EXIT=1**。
- **真 `app.asar`（2.8.0）无自有源码/map**；前端 dist 的 124 条相对资源引用 0 缺失。

## 6. 附录

### 6.1 子报告索引（`temp/audit-2026-09-23/`，会话内工作产物）

| 报告 | 覆盖 | 计数 (P0/P1/P2/P3) |
|---|---|---|
| `A-skill-management.md` | 客户端技能库安装/卸载/本地技能管理 | 0/5/7/5 |
| `B-client-host.md` | 桌面宿主（Electron/会话/更新/打包） | 0/8/8/5 |
| `C-client-plugins.md` | 客户端插件包（packages/client） | 0/2/15/14 |
| `D-browser-wasm-host.md` | 浏览器/WASM 宿主/连接器/cron | 1/6/17/20 |
| `E-server-auth-rbac.md` | 服务端认证/RBAC/会话/路由/限流 | 0/1/0/6 |
| `F-server-gateway-billing.md` | LLM 网关/计费/用量/账本 | 1/6/8/8 |
| `G-server-capability-appstore.md` | 能力中心/市场/共享技能/技能清单 | 0/1/7/13 |
| `H-server-wasm-webadmin-portal.md` | WASM 平台/webadmin/门户/客户端交付 | 2/4/11/11 |
| `I-design-defects.md` | 设计缺陷与跨模块一致性（30 组真源测绘） | 1/8/14/7 |
| `J-test-efficacy.md` | 测试与门禁有效性（假绿审计） | 0/22/42/38 |
| `K-build-release-docs.md` | 构建/打包/渠道/CI/发布/运维/文档漂移 | 0/3/4/4 |

### 6.2 探针与复跑

- 客户端技能链路：`probes/skill/*.mjs`（真实 import 生产 TS 源码 + pinned 上游包）
- 桌面宿主：`probes/desktop/*.spec.ts`、`probe-fs-error-as-network.mjs`、`probe-download-stall.mjs`
- 浏览器/连接器/cron：`probes/host/**`（含 `cn/`、`br-*.spec.ts`、`probe-a-user-switch.mjs` 等）
- 服务端：`probes/serverauth/run-probes.sh`、`probes/gateway/{probe_gwcore_test.go,zz_auditgw_probe_test.go,run-probes.sh}`、`probes/wasm/{main.go,amp.go,frame.go}`、`probes/capability/PROBE-LOG.md`
- 门禁：`probes/tests/**`（每条变异都附还原后的 sha256）
- 构建发布：`probes/build/{r2/run-probe.sh,mutate.mjs,doc-path-drift2.mjs}`

PostgreSQL 探针统一使用容器 `pg-test`（`postgres:postgres@127.0.0.1:5432`，测试助手自建临时库）；Go 构建缓存统一落 `temp/audit-2026-09-23/probes/gocache`。

### 6.3 复核提示

- 审计期间工作区存在**并发写者**（本仓为多会话共享工作目录）：`git status` 里的 `M` 条目可能同时包含修复泳道的改动与他人改动。提交时必须用**部分提交**（`git commit -m "<msg>" -- <路径...>`），并在提交前 `git diff -- <file>` 看内容。
- 本地 `node scripts/check-no-leftover-mutants.mjs` 曾恒红（命中未跟踪且被 `.git/info/exclude` 忽略的 `audit/r8/run-mutations-r8.sh:62`——那是一个**变异驱动脚本**，其"变异后代码"是多行单引号字符串参数）。已修（`b015d2911c`）：默认只扫**能进提交的文件**（`git ls-files --cached --others --exclude-standard`），扫描根不是仓库根即 fail-loud，另留 `--all-files` 供排查。

## 7. 第二轮与第三轮审计（增量）

### 7.1 第二轮：三路复核 + 用户点名区专项（2026-09-23 同日）

| 路 | 覆盖 | 新增 P0 | 新增 P1 | 报告 |
|---|---|---|---|---|
| W1 | 首轮修复的回归面（逐条回归首轮 6 P0 + 41 P1 的修复） | 0 | 0 | `temp/round2-2026-09-23/W1-regression.md` |
| W2 | 首轮未覆盖面：`cmd/server` 装配面、13 个未覆盖包的包级 `go test`、`migrations-pg`（72 文件）、`llmgateway` 21 条管理路由的 75 例畸形输入矩阵 | **1** | 8 | `W2-server.md` |
| W3 | 客户端 UI 契约与文档真值、`webadmin` 未覆盖面、死链 | 0 | 5 | `W3-client-docs.md` |
| W4 | 用户点名区：本地技能发现与溯源（11 个探针） | 0 | 2（另 P2×5、P3×5） | `W4-skill-roots.md` |
| **合计** | | **1** | **15** | |

- **第二轮唯一的 P0 = MIG-1**：`migrations-pg/0039` 假设 `usage` 已是分区表，而 v2.4.0 旧库的 `0004` 被原地重写成分区版、`migrate.go` 只记版本号不校验和 ⇒ 升级时 `ERROR: "usage" is not partitioned` → 回滚 + 版本不落库 + `log.Fatalf` ⇒ **启动崩溃循环**。修法 `accce75cc5`：原地转换普通表 + 逐行迁移 + fail-loud 自检 + 用真实 v2.4.0 载荷做回归（变异 8/8 红）。同批修掉 MIG-2（P1）：`0054/0055` 同名技能回填静默丢组织 release 后 DROP 源表 ⇒ 改为确定性归并 + DROP 前逐行比对 fail-loud。
- **用户现场报障的 P1 确认并修复**（`0b50e83a54`）：客户端市场页把组织共享技能合并进列表却仍打**市场命名空间**接口 ⇒ 20 次 404。该条**首轮审计未发现**（11 份子报告 + 3 份复审 + 6 份重构报告全文检索均无此条）；结构性原因是分区把"服务端市场面"与"webadmin 面"切开，且首轮 webadmin 判据里没有"每行动作的命名空间是否与 `channel` 一致"。二轮起把**跨面拼接**列为固定判据（见 §7.2）。
- **技能库两条 P1**（`4f49f31237`）：①随包插件开机同步是唯一无闸门的写者，会静默整树覆盖用户同名技能（用户文件被删、正文被换、还被标成商店来源）；②市场 × 插件同名双向静默覆盖 + provenance 归属与实际内容不一致。修法：插件侧新增来源闸门（渠道相同按 `x-version` 更新；其它商店渠道 ⇒ `SKILL_CHANNEL_CONFLICT`；无溯源/未知 ⇒ `SKILL_LOCAL_CONTENT`），安装侧渠道互斥需显式 `?overwrite=1`。
- **闸门带来的升级余波，用"可验证同一性"而非启发式收口**（`920c62f02a`）：A9 写溯源不在任何已发布 tag 里 ⇒ 现场存在"旧版插件同步落下、但目录没有 `.picoaide` 溯源"的历史副本，会被新闸门按用户内容拒收（当时无碍，但将来插件升 `x-version` 时不会自动更新）。判据取**逐字同一性**：条目集合逐项相同（文件与目录都算）+ 每个普通文件字节逐字相同 + 全程无符号链接/FIFO/读取失败 ⇒ 判定为随包技能的未溯源副本，**换入之前**补写 `channel:'plugin'` 溯源并报 `adopted`；写失败 ⇒ `refused` + `SKILL_ADOPT_FAILED`（只回收本次可能建出的空 `.picoaide/`，绝不递归删），不存在"内容已换、溯源没写"。渠道互斥优先于同一性（内容相同但溯源是 market/org/builtin 仍拒）。落点四态可区分：`adopted` / `synced` / `unchanged` / `refused`（均点名技能与目录）。**明确不加 mtime/大小判据**：大小是字节比较的推论，mtime 在"安装包解包 / 旧同步写入 / `cp -a`"三条真实链路上不可比，只会误拒真正的历史副本（属"看起来更严、实际更不可靠"）。
- **对上面两个技能库提交的独立对抗性复审结论**（`temp/verify-skill-r3/VERIFY.md`；基线钉字节：`skills-sync.js` sha256 `7d604244…`、`skill-install.ts` 快照 `221c9038…`；两提交**不在 `origin/master`、不在任何 tag** ⇒ 未发布）：
  - `4f49f31237`（来源闸门 + 安装侧渠道互斥）⇒ **成立**。24 组对抗性用例逐条实测：市场/组织/内置同名 ⇒ `refused`+`SKILL_CHANNEL_CONFLICT` 且内容与溯源逐字未变；用户手写 ⇒ `SKILL_LOCAL_CONTENT` 且用户文件保留；`appId` 不符 / 渠道未知（`PLUGIN`、`" plugin"`、西里尔同形字）/ 标记 JSON 坏 / 8–32MiB 垃圾标记 ⇒ `refused` 且不采纳；`SKILL.md` 或落点是符号链接（含悬空、指向库外）⇒ `refused` 且**库外零写入**；同渠道更新**不需**多余确认。变异：拆闸门 17/20 红、删逐字节比较 1 红、采纳失败改静默 1 红、渠道互斥恒假 4 红。
  - `920c62f02a`（内容同一性采纳）⇒ **部分成立**：静态判据与目标状态全部相符，但"不存在中间态"的绝对表述被三个口子推翻，均已另派修复：**F1（P2）判定→写溯源之间的 TOCTOU**（复现：比较期间写入的用户文件被盖上 `channel:'plugin'`，下一轮随包升版**被静默删除**）；**F2（P3）标记读取无类型/体积闸门**（`.picoaide/release.json` 是 FIFO 时启动同步挂起 12s 不返回、指向大文件则整份读入内存）；**F3（P3）与安装器不互斥**（并发下仍能产出"内容是插件版 + 溯源是 market"这一 P1-2 归属错，**且该终态不会自愈**）。另有 F4（渠道常量两份无对拍门禁）、F5（面板按键看 409 而不看 `error.code`）。
  - **认账代价**（须随下次发布说明披露）：一份**逐字未改动**的用户自制副本会被判定为随包技能并采纳（该目录里不存在任何用户创作的字节；改一个字节或加一个文件即不再成立）。

**用户点名五问的结论**（W4，11 个探针；全文见 `temp/round2-2026-09-23/W4-skill-roots.md`）：

1. **本地技能扫描根共 6 处**：项目 `.dsh/skills`(rank 100)、项目 `.agents/skills`(200)、custom(300，仅 cordis preset 自带)、`$DSH_HOME/skills`(400)、`~/.agents/skills`(500)、bundled(600，本产品不设)；层内按 (rank, providerOrder, localOrder) 先到先得，层间近者覆盖。**能力中心只覆盖 rank 400 一条** ⇒ 与发现面存在双向差集。
2. **结构缝**：①"已安装"判据 = 目录名存在，与 provenance 不同源；②名字等值约束让历史非法名技能在面板**静默消失**（无迁移提示）；③provenance 三处不自洽。
3. **本地 × 线上冲突**：安装/覆盖闸门有效（无 `?overwrite=1` 一律 409 `LOCAL_CONTENT` 且内容逐字保留）；**唯一无闸门的写者是随包插件开机同步**（已修，见上）。
4. **本地写好再上传不会显示成"从线上下载的"**：上传本身不写任何本地标记（上传前后目录 sha256 逐字节相同、`installedOrigin='local'`、`originChannel=null`）。但审核通过后 `mergeItems` 的权威序（market > org > local）会让卡片翻成"其他安装"+「卸载」，**上传入口再也点不到**（P2-1，未修）。
5. 另发现 P2×5、P3×5（`provenance.version` 不随原地换入刷新、插件技能卸载不持久且无墓碑等）。

### 7.2 第三轮：三路独立审计（服务端核心 / 客户端宿主 / 门禁完整性）

第三轮按"审计范围与修复泳道不重叠"切分；另外对两处高风险修复各派一名**对抗性复审**（修复方不得自证，判据必须能被打坏）。

| 路 | 范围 | 新增 P0 | 新增 P1 | 报告 |
|---|---|---|---|---|
| **R3-A** | 服务端核心：`wasmapp/**`（全部子包）+ `marketplace/sharedskills/capabilities/agentshare/connectors/clientrelease/portal/bootstrap/telemetry/reports/balance/util/channel/appstore` | **0** | **2**（A-1/A-2） | `R3-A-server-core.md`（0/2，另 P2×8、P3×3） |
| **R3-B** | 客户端与宿主：`desktop` / `browser` / `connectors` / `cron` / `client/*`（锚定 `7e7ac1c27d`） | **0** | **1**（B-2 cron 封笔） | `R3-B-client-host.md`（0/1，另 P2×2、P3×3）；子报告 `R3-B2-connectors.md`、`R3-B3-cron.md` |
| **R3-C** | 门禁完整性：`yarn check` 全组成（编排器 + 14 个根守卫）、CI、打包验证脚本、`server/Makefile`（五泳道：本泳道 + CI / 打包 / 中等守卫 / WASM 门禁） | **0** | **15** | `R3-C-gate-integrity.md` + `sub/{C-ci,P-packaging,G-medium-guards,W-wasm-gate}.md` |
| **V1** | 对抗性复审：技能库两个提交（用户点名区） | — | 判 `920c62f02a` **部分成立**（F1 TOCTOU / F3 与安装器不互斥） | `temp/verify-skill-r3/VERIFY.md` |
| **V2** | 对抗性复审：provider PUT 原子化（`0dd74681b7`） | 待回填 | 待回填 | `temp/verify-put-r3/VERIFY.md` |

**R3-C 的四条 P1（全部是"假绿门禁"，即会让其他所有结论失去支撑的那一类）**

1. **C-1** 编排器遇到 `needs` 成环时**静默丢弃**这些包：摘要仍打印「27 个任务:27 通过、0 失败、0 跳过」且 **EXIT=0** —— 包从未运行（把 `needs` 打错一个字符同理，且会让包排到依赖之前）。
2. **C-3** **只改文档的 PR 整条门禁被跳过**，而分支保护把 skipped 计为成功 ⇒ 域名守卫（铁律 0）、迁移区间守卫、布局守卫在文档改动上**一次都没跑**（审计方以线上 PR 与分支保护实况取证）。
3. **C-4** `check-no-real-domains` 的**提交信息判据在 PR 的 CI 里恒为空跑**：gate 的 checkout 是 depth-1（无 `fetch-depth`），解析不到 base ⇒ 退化成"只看 HEAD"（PR 上就是那条 merge commit）。
4. **C-7** CI 可把门禁换成自己的弱化形态而**无任何守卫**：`yarn check --no-guards`（丢掉全部根守卫）/ `--only <单包>` / `--changed <ref>` 三种写法在 `check-workflows.mjs` 下**全部 EXIT=0**。

另有 R3-C 的 P2×4 / P3×1（含 `check-migration-range` 在"有迁移目录但无被扫文档"的合成树上仍宣称一致；`check-no-leftover-mutants` 对"同行字符串字面量里的变异标记"仍不报），以及由它交叉验证的分片报告（CI / 打包 / 中等守卫 / WASM 门禁）。

**其中"C-6 假一致"已修复**（`1305dcf450`）：`check-migration-range.mjs` 在"有迁移目录、零文档可扫"的树上会打印「扫描 0 个 md」却仍宣称「文档区间与实际一致 ✅」并 **EXIT=0**（连那棵树里并不存在的 `server/AGENTS.md` 也一并宣称"迁移号都存在"）。修法：`scanned === 0 || !agentsScanned` ⇒ **fail-loud** 并给出修法。三向实测：真实仓库 0 / 合成树（只有迁移目录）1（带修法提示）/ 夹具形态（迁移+文档+`AGENTS.md` 且区间一致）0；再把该守卫自带夹具矩阵跑一遍（`node scripts/verify-check-workspaces.mjs`）⇒ **EXIT=0**。

**第三轮新增的门禁面同样做了注入验证**（新守卫不能只信它自己的自述）：`scripts/check-doc-claims.mjs`（文档数字守卫，pin 与平台模块表**双向相等**、扫描器失效 fail-loud、带 `--selftest` 与 `doc-claim:allow` 豁免）——注入 pin 漂移 ⇒ 退出码 1、注入「共 9 项」→「8 项」⇒ 退出码 1、干净态 ⇒ 0、空树 `--root` ⇒ 1（`找不到 upstream.json —— 拒绝把"读不到真源"当通过`）。

**R3-A（服务端核心）的两条 P1（已派修复）**：**A-1** 宿主→guest 方向只有 `assets.read` 修了"单帧预算"桥 ⇒ `db.query` 结果（平台允许 1–8 MiB）被写成超帧，应用收不到结果，官方技能骨架下表现为 10 s `RUNTIME_TIMEOUT` 且**应用已写好的响应被丢弃**；**A-2** `POST /api/client/v2/apps/wasm/validate` **无归属校验** ⇒ 任意已登录员工可用最简 config 换回**他人应用**的生效配置（`whitelist`/`purpose`/`data_sensitivity`/`owner`/`sensitive_columns`）并附 `first_release` 存在性 oracle。另 8 条 P2 中最具代表性的是 **A-6**（`abi.MaxResponseBodyBytes` 512 KiB 自称"保证可交付"被 JSON 转义证伪：`<`×512 KiB 编码后 3,145,840 B > 1 MiB 帧，而钉住它的回归用例用的是**零转义夹具** ⇒ 假绿）与 **A-10**（两个版本比较器对同一对版本给出**相反**结论：`util.CompareSemVer("1.0.0-1","1.0.0")=+1` 而 `registry.CompareVersions=-1`）。R3-A 明确结论：**新增 P0 = 0**（无进程级崩溃/静默计费错误/沙箱逃逸）。

**R3-B（客户端/宿主）的其余发现与处置**：B-1（P2，设备码定义缺 `verificationUrl` 时被判 `connected` 且注册 MCP —— CN-3 缺陷类经另一扇门回归，`ae1bccc222^` 的 A/B 证明是回归）**已修**：连接期 fail-loud（`4b8d808fa9`），判据同时钉两侧（坏形状必须拒绝且零 request；"完全没有 auth 块"的形状保持既有语义），变异验证把源码回退到修复前 ⇒ 新用例红（`expected 'resolved' to match /verificationUrl/`）且对照用例仍绿；包级 41 文件 / 362 用例 EXIT=0。B-3（P2，`deadGrants` 按连接器 id 记账而事实属账号凭据世代）**已修并独立复核**：修复提交 `28e2062e38`；复核方式=用**审计方自己的探针**（`temp/round3-2026-09-23/connectors-probes/p4-deadgrant.mjs`，非修复方的测试）重跑 ⇒ 打印 `VERDICT: not reproduced`（账号 B 由 `unauthorized`+0 注册变为 `connected`+注册成功、对照账号 C 仍正常）。B-2（cron 封笔）**已修**（`eb981016cb`：`dispose()` 改为 flush → 封笔 → 放锁 的硬顺序，写路径统一走 `assertOpen()` 抛 `ledger is disposed: write refused`；8 条回归用例修复前 4 红 4 绿、6 个变异全杀、包级 22 文件/203 用例 EXIT=0、审计方原探针复跑 `DISK LOST job-2 : false`）。B-4/B-5 已另派泳道（B-4 修空白名并与 GUI 面同源；B-5 按「如实跳过 + 改注释 + 让跳过可观测」处置，不补跑）。B-4（P3，`cron_create` 接受空白名，与 `protocol.ts` 的 GUI 面判据不一致）、B-5（P3，`cron.ts` 注释声称 DST 缺口"forward 归一"而实现零触发、静默丢触发）**待随 cron 批次处置**。审计方另**撤回**上一轮 B-20（mac afterPack 原生件校验死代码：mac 目标只有 arm64，而 `verify-mac-smoke.ts` 对同一份清单逐个 exists+lipo 已补偿），并确认 SH-1（真实适配器未实现 `webContents.stop` ⇒ `stopPendingLoads()` 静默 no-op）仍未修。

**R3-B3 的一条 P1（cron）**：`HostCronLedger.dispose()` **不封笔** —— dispose 之后的写入越过已释放的锁，覆写**继任世代**的 `ledger.json`（探测到机制级证据；正常退出路径窗口小，HMR / 同进程重建路径窗口大，故定 P1 而非 P0）。

**V1 的结论（用户点名区）**：`4f49f31237` 判**成立**（24 组对抗性用例逐条实测，静态目标状态无一漏网）；`920c62f02a` 判**部分成立**（静态判据全对，但"不存在中间态"被三个口子推翻：F1 判定→写溯源 TOCTOU、F2 标记读取无类型/体积闸门、F3 与安装器不互斥且终态不自愈）。三条已派修复，处置与证据见 §7.1。

### 7.3 处置拍板（主控决定，含"接受/推迟"的书面理由）

按"能修则修；结构上不该修或代价不划算的，必须留下理由与触发条件"的口径，以下条目**不修**或**推迟**，均已在对应报告/文档留痕：

| 条目 | 处置 | 理由与触发条件 |
|---|---|---|
| **MIG-4** `schema_migrations` 无校验和 | **接受（不改迁移框架）** | 迁移是"已应用即永不原地修改"的追加式纪律，真源 `migrate.go` 只记 `version/applied_at`；改形状一律走新迁移 + 同事务内检测/转换/搬运/`setval`/fail-loud（范例 `0039` §0）。全仓已核实**无任何文档声称迁移有校验和**（即无失真）。书面结论落 `server/docs/06-database.md`，并写明三条未来触发条件（引入外部工具改库 / 出现多写者 / 需要跨版本重放）。 |
| **D-8/D-9 的判据目前是一次性探针**（文档导航表 ↔ `nav.ts`、端点表 ↔ `router.AdminRoute` 双向同序） | **提升为常设守卫（下一批）** | 探针实测已抓到真实漂移（导航表漏 `/gateway-files`、`/app-center`，端点表缺逐方法展开），值得固化；为避免与守卫批次同文件冲突，排在 L-F 的 C-3/C-4/C-7 落地之后，并要求**注入验证**（改一处文档即红）。 |
| **F5** 面板按键看 409 而不看 `error.code` | **推迟** | 现状：跨渠道冲突会多一次往返后由面板确认条闭环（功能正确、无数据风险）；`auth-gate` 六处原样透出上游状态码会让任意上游 409 弹一次假确认 —— 属体验问题，改它要同时动面板判据与路由透传策略，单独排期。 |
| **P2-1** 审核通过后 `mergeItems` 权威序让市场卡片翻成"其他安装"，上传入口不可达 | **推迟（产品决策）** | 上传本身不写本地标记（用户已确认的事实）；"我的上传被审核通过后如何再更新"属产品入口设计，需拍板后再动。 |
| **B-2 定级（cron 封笔）** | **维持 P1** | 机制级证明（`DISK LOST job-2 : true`，磁盘 rev 5 / 内存 rev 3）+ 终态不可自愈（继任世代的任务从磁盘消失）；可达面是同进程第二代账本（用户补丁热加载/插件行重启），虽被 shipped 桌面默认关闭 hmr 缩小，但"字段只写不读"属结构性缺陷。 |
| **B-3 定级（`deadGrants`）** | **维持 P2** | 触发需要"两个账号共享同一 `updatedAt` 凭据世代"（复制/批量供应凭据的现实场景），后果是可用凭据被判 `unauthorized` 且零注册。 |
| **B-5 的 DST 策略** | **如实跳过 + 改注释 + 让跳过可观测**（不补跑） | `catchUpMissed=false` 是已文档化的默认语义，"补跑"会改变既有产品行为；真正的问题是注释与实现相反且丢触发**静默**。随 cron 批次一并做（与 B-4 同包，等封笔泳道释放）。 |
| **B-4 的空白任务名** | **修（随 cron 批次）** | 工具参数自称"非空"而实现只 `trim()`，与 GUI 面判据不一致且会在磁盘留下空名任务；属同一批。 |
| **W4 的 P2-5**（插件技能卸载不持久/无墓碑）与 `provenance.version` 不随原地换入刷新 | **推迟** | 前者需要"墓碑"数据结构（属插件技能生命周期设计）；后者是 A9"逐字保留溯源"语义的直接后果，与技能库修复同文件，随下一批一起评估。 |
| 第三轮 C-9（`check-no-leftover-mutants` 对"同行字符串字面量里的变异标记"不报） | **接受并记录为已知边界** | 该豁免是为"检测/说明变异"的合法写法而设（守卫自己的正则常量、说明性文案）；把它收紧需要语法级判断，误报成本高于收益。**认账**：变异若把标记藏进同行字符串字面量，本守卫不报。 |
| `deadGrants` 修复的两条认账（`28e2062e38`） | **接受** | ①标记生命周期＝每（账号, 连接器）一条、随插件实例存活**不清理**（上界极小）；若要有界只能只留当前作用域，代价是切回旧账号会再向 IdP 出示一次已吊销的 refresh token（正是 CN-5 修掉的形态）⇒ 不采用。②作用域取 `store.dir`（凭据文件身份）：显式 `storeBaseDir` 的嵌入方多账号共用目录即共用标记（那里本就是同一份凭据文件）。 |
| `lastAnnouncedToken`（与 deadGrants 同族怀疑） | **不构成已证明缺陷，保持现状** | 其值就是 access token 本身（自带账号身份），跨账号误判要求两份凭据的令牌逐字相同＝同一份材料 ⇒ 无法构造真实越权/误判。 |
| **门禁面最严重的一条（`check-patch-pin` 断言从未执行）** | **已修**（`2f6eda18a1`） | 本仓 `nmHoistingLimits: workspaces` ⇒ patched 包**不落在仓库根 `node_modules/`**（根下只有 `yaml`），实际装在 `packages/*/*/node_modules/@deepseek-ai/…`；旧代码只查 `<root>/node_modules/<name>`，因此「已安装的补丁目标版本 == pin」这条断言**在本仓从未真正执行过一次**，且因根 `node_modules` 存在连"未安装"提示都不打印（这正是主控独立复现到的 `EXIT=0` 的真身）。修后：按"仓库根 + 每个 workspace 的 node_modules"逐份断言版本 == pin（真仓库实测校验 **10 份拷贝**、`OK` 且条数可见），未安装依赖时**默认 fail-loud**（要只查接线必须显式 `--skip-installed`），并每次运行自带 `selfTest()` 5 例（缺/空 node_modules 必红、已装==pin 必绿、已装≠pin 必红点名）。**教训**：`EXIT=0` 的守卫可能是"断言从未跑过"，而不只是"判据太弱"。 |
| **R3-A 的 8 条 P2 / 3 条 P3**（A-3~A-13） | **已并入 wasmapp 修复泳道，按优先级止损** | 已随 A-1/A-2 一并交办并给了判据：A-6/A-7 可交付响应体口径（保证值 ≈170 KiB、1 MiB 仅为原始帧上限，同步 abi 注释/作者手册/客户端常量并让 parity 用例真钉 `response_body_bytes_max`）、A-10 收编到一个 SemVer §11 正确的比较器、A-11 省略 `enabled` = 保持现值、A-8 最小处置（该文件刚被 `f4a9a7774b` 改过，须先看 HEAD 内容）。优先级 A-2 → A-1 → A-11 → A-10 → A-6/7 → A-8/9，**未做的必须逐条回报"未做 + 原因 + 建议判据"**。其中 **A-6 与 A-3 是本轮最值得注意的两条**：前者是"自称保证可交付"的常量被平台自己的 JSON 转义证伪，且**钉住它的回归用例用零转义夹具 ⇒ 假绿**；后者是审核开关**读取失败被当作"审核关"**（fail-open，未审批版本直接 `approved`）。 |
| **技能库收口的四条拍板**（`fa49eb7f5b`） | **接受** | ①技能库根留下点开头的空 `.skill-locks/`：**接受** —— 发现器与清单看不见它；改成释放时 `rmdir` 会引入 `mkdir→open(wx)` 的 ENOENT 竞争面（两端都要加重建重试），代价大于收益（已按它放行三处旧断言并新增"锁不得残留"断言）。②**安装器侧有界等待 5s / 同步侧零等待**的有意不对称：**接受** —— 同步跑在 `apply()` 启动路径且与安装器同进程，忙等会饿死异步持锁者（自锁）；只可调大常量，**不得改成无界**。③**F5**（面板按 409 状态码而非 `data.code` 判覆盖确认）：**保持推迟**（牵动确认条渲染与 61 例面板 spec）。④复审 §6.6 其余遗留（卸载不持久、面板预判、`provenance.version` 陈旧、W4 §6 的 P2-1~P2-4）**本批未动，保持排队**。 |
| **守卫面仍存的 6 处静默通过形态**（`2f6eda18a1` 同批认账，**未修**） | **认账并排队** | 逐条：①`verify-licenses` 空依赖树时通过；②`check-no-leftover-mutants --root` 指向不存在目录时通过；③`check-no-real-domains` 空仓（无被跟踪文件）时通过；④两条以**异常栈**形式失败的守卫（报错形态不统一，难以被机器判读）；⑤`electron-shots` 无静态覆盖；⑥真机端到端未跑。它们的修法与 4 处已修的同类（"扫不到 ⇒ 拒绝宣称一致"），但**本批未做**，不得读作"守卫面已全部硬化"。 |
| **V2 复审的 P2：审计不可写 ⇒ 配置保存整体失败**（原为 `200` + 静默丢审计） | **接受（fail-closed，不加代码旁路）** | 对"改配置即改钱"的路径，宁可保存失败也不能静默丢审计 —— 后者正是本次修掉的那一类。**明确不做**运营侧旁路开关：那会把"静默丢审计"重新引入。运维出路是修审计存储（锁/磁盘），不是绕过。要求错误文案可行动（点名审计链写入失败及其可能原因）。 |
| **V2 复审的 P3-a：丢失更新窗口被放大**（事务外读 → 事务内整行写回；确定性复现：并发改名把刚轮换的密钥写回旧密文） | **排队修（一行级）** | 建议修法：事务内 `SELECT … FOR UPDATE` 重读作为写入基线。本轮未做（V2 明确"不构成本次回归"），但属真实数据完整性风险，列为下一批首选项。 |
| **V2 复审的 P3-b：行锁持有时间 O(清单长度)**（2000 模型 ⇒ 941 ms） | **接受并记录上界** | 上界由 `adminMaxBodyBytes`(1 MiB) 约束；建议后续给 models 加显式上限或改增量 diff。 |
| **`POST /providers` 仍是同族半提交**（`AddGatewayProvider` + 独立事务同步 + 补偿删除 `_ =` + 异步审计 `_ =`） | **排队修（对称收口成本低）** | 三个 `Tx` 变体已在手（V2 指出），建议下一批对称收口。 |
| **C-10** 域名白名单可自注册 + 分支保护必需评审人数为 0 | **需用户在 GitHub 侧处置（本会话不可改仓库设置）** | 现状：同一个提交既能往 `ALLOWED_DOMAINS` 加白名单条目、又能让守卫放行，且无需任何人工评审 ⇒ 铁律 0 的第一道防线完全依赖"提交者自觉"。代码侧可做的缓解（每条白名单必须带 owner+理由、白名单变更与守卫变更不得同提交）无法真正阻止有写权限者；**建议**给 `scripts/check-no-real-domains.mjs`（及其白名单）配 CODEOWNERS，并把 `required_approving_review_count` 提到 ≥1。 |
| **P-1** 打包必需清单"单条删除＝同时删断言" | **已派修复** | 要求反向 oracle（归档里每个 `@picoaide/*/lib/**` 真实 specifier 都必须被清单覆盖）+ 每包条数棘轮，使"悄悄删条目"必然红；3 组变异验证。 |
| **W-1~W-5**（WASM 门禁：树移出扫描面/三方对拍改名退化为 PENDING/桶上限来自 env/组 3 与组 6 从不执行） | **排队**（等 `verify-wasm-client-only.sh` 从 L-B 释放） | 组 3 的 `check-go-test-json.mjs` 与组 6 的 4 个协议探针**本机 4/4 PASS、21s 却从不被 CI 执行** ⇒ 属"有能力、没接线"的假保证；接线归 CI 泳道（已并入 L-F）。 |
| `check:wasm-channels` 是否"声明了却从不运行" | **核实为误判（无孤儿守卫）** | 它由 `verify-wasm-client-only.sh:361` 间接调用，而 `check:wasm-client-only` 在编排器 `GUARDS` 内。逐条核对 package.json 的 `check:*` ↔ 编排器后：**无孤儿守卫**。 |

### 7.4 收敛判定

**判定：未达成"连续两轮独立审计零新增 P0/P1"。** 第一轮 6 P0 + 66 P1、第二轮 1 P0 + 15 P1、**第三轮 0 P0 + 19 P1**（R3-A 2 / R3-B 1 / R3-B3 1 / R3-C 15）—— 第三轮不是干净轮，按口径干净的一对必须顺延到第四、五轮。

**第三轮新增 P1 的归属与本轮处置**

| 面 | 条数 | 处置 |
|---|---|---|
| R3-A 服务端核心 | 2（A-1 帧预算只修一条桥、A-2 `validate` 无归属校验） | 已派修复泳道（要求枚举全部 host→guest 返回路径；归属校验与既有 owner-only 404 同形且不泄露存在性；≥4 变异） |
| R3-B 客户端/宿主 | 1（B-2 cron `dispose()` 不封笔） | **已修** `eb981016cb`（flush → 封笔 → 放锁 硬顺序；8 用例修复前 4 红、6 变异全杀、包级 22 文件/203 用例 EXIT=0；审计方原探针复跑 `DISK LOST job-2 : false`） |
| R3-B3 cron | 1（同 B-2） | 同上；B-4（空白名）/B-5（DST 静默丢触发）已另派（B-5 定调"如实跳过 + 改注释 + 让跳过可观测"） |
| R3-C 门禁完整性 | 15（C-1/C-3/C-4/C-7 + CI-C1~C3 + P-1 + G-1/G-2/G-8 + W-1~W-5） | 已派：CI 面 7 条、中等守卫 3 条、打包 P-1；**排队**：C-1/C-2 与 W-1~W-5（其所需文件被一条仍在运行的泳道持有，主控不向活写者动手） |

**同轮独立复核（修复方不得自证）**：**provider PUT 原子化（`0dd74681b7`）⇒ 总判"修复成立"**（`temp/verify-put-r3/VERIFY.md`，358 行：事务边界 `Begin→UpdateGatewayProviderTx→SyncProviderModelsTx→tx 读快照→AuditLogTx→Commit`、15 条 return 逐条核对、事务开始后 5 条错误分支**全部回滚**、事务内零出网；契约面动作名与明细串逐字未变、审计链可混排；新用例在父提交上**必红**且红在"provider 行 + 密钥已落库"；13 条自写边界用例修复态 13/13 绿、其中 4 条在父提交上红；包级 `llmgateway` ok 369.5s、`serverstore` ok 202.1s）。技能库两提交 ⇒ `4f49f31237` 成立、`920c62f02a` 部分成立（三个口子已派修）；provider PUT 原子化 ⇒ 独立复审进行中；connectors 死授权 ⇒ 用**审计方自己的探针**复跑得 `VERDICT: not reproduced`（修复前 REPRODUCED）。

**已落地的修复（第三轮窗口内）**：`7e7ac1c27d`（建流失败不再遗留回调服务器与定时器）、`4b8d808fa9`（设备码定义缺验证地址 fail-loud）、`28e2062e38`（死授权按账号记账）、`8f8e88c7aa`（真实适配器 `stop` 透传）、`eb981016cb`（cron 封笔）、`f4a9a7774b`（市场归档端点）、`0dd74681b7`（provider PUT 事务化）、`1305dcf450`（迁移区间守卫 fail-loud）、`d6a891f1b4`/`30b5c85c82`/`ca5a7c3e56`（文档与数字真值 + 新守卫）、`920c62f02a`（内容同一性采纳）、`4f49f31237`（随包同步闸门 + 渠道互斥）、`2f6eda18a1`（4 条根守卫 fail-loud：空扫描面/缺失输入不再静默通过；含 `check-patch-pin` 那条**从未执行过**的断言）、`322be5186d`（integration-tests 两条不可达断言改为有判别力 + 缺环境显式 `exit 77`）、`812f539923`（集成测试判据自检 + 假网关正反例接入门禁）、`d73a421bfe`（编排器 GUARDS 登记 `check:integration-tests`）、`8f07fcd1ff`（账户浮层补齐 ARIA 契约，一次 Esc 只关一层）、`aea28fbae1`（中等守卫三条假绿：零字节补丁/丢整段/glitchtip 自测不驱动 ssh 与容器判定；并自行发现并修掉「容器不可达只打 UNKNOWN 却 exit 0」这条同族 fail-open）、`ec0121f543`（webadmin 审计 sink 白名单补 `AuditLogTx`，修 provider PUT 事务化引入的跨面真红）、`fa49eb7f5b`（**独立复审在用户点名区打出的三个缺口全部收口**：随包同步与安装器共用 per-name 锁、采纳写溯源后复检同一性、标记读取加类型/体积闸门）。

**判定口径（写给下一轮的执行者）**
1. **"绿" = FAIL=0 且 SKIP=0** —— 编排器在某包失败时会**级联跳过**依赖它的包，跳过等于没验证。
2. **提交态验证**只能"主树冻结 + `temp/round3-2026-09-23/freeze-snapshot.sh` 前后两份逐文件 sha256 比对"；软链式 `git worktree` 会串到主树在途产物（已实测），结论不可信。
3. **未验证项 ≠ 通过**：整仓 `yarn check` 全量、`server/Makefile` 全量、Windows/macOS 打包与 afterPack 的反向注入、渠道真打包、R3-C 的 WASM 组 3 真 PG 路径等，均**尚未在冻结态跑过**，不得写成"已验证"。
4. **冻结必须真的冻结**：`check:wasm-client-only` 的 **HEAD 绑定判据**会在并发会话提交时把整轮判红（本批实测一次：跑动过程中 HEAD 从 `d73a421bfe` 前进到 `bbba3db4ca`… 组内 15 项判据本身全 PASS）—— 这与"全量门禁必须在冻结态跑"是同一条纪律的两个侧面。
5. **认账项**：C-10（域名白名单可自注册 + 分支保护必需评审人数为 0）需在 GitHub 仓库设置侧处置（CODEOWNERS + `required_approving_review_count ≥ 1`），代码侧无法阻止有写权限者自放行。
