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

| 泳道 | 范围 | 覆盖缺陷 | 状态 |
|---|---|---|---|
| **F1** | `serverstore/gateway.go`、`llmgateway/admin.go`、`webadmin Gateway.tsx` | G-01（P0）、G-02 | 进行中 |
| **F2** | `llmgateway/{embedding,completions}.go`、`serverstore/usage.go` | G-03、G-04、G-05 | **完成**（变异全红，见 `temp/audit-2026-09-23/fix-F2-billing-aggregation.md`） |
| **S1** | `enterprise/src/{skill-install,auth-gate,archive-util}.ts`、`client/CapabilityCenterPanel.tsx` | A1、A2、A3、A6、A7、A8、A11、A12、A13、A15 | 进行中 |
| **S2** | `vendor/memory-evolve/lib/**` | A4、A5、A9、A10、A16、上游 #59 本地加固 | 进行中 |
| **W1** | `webadmin/src/pages/{Users,Auth,Apps}.tsx` | WEB-1（P0）、WEB-2（P0）、WEB-3 | 进行中 |
| **D1** | `packages/host/cron/**` | CR-1（P0）、CR-2、CR-3、CR-4、CR-6、CR-7 | 进行中 |
| **D2** | `packages/host/connectors/**` | CN-1、CN-2、CN-3、CN-4、CN-5、CN-9 | 进行中 |
| **D3** | `packages/host/{browser,wasm-apps-host}/**` | WS-1、BR-1、BR-2、CP-1、BR-3、WS-2、SN-1/EV-1 | 进行中 |
| **E1** | `serverauth/ratelimit.go`（+限流调用点） | E-01 | 进行中 |
| **J1** | `scripts/check-no-real-domains.mjs`、`desktop/scripts/verify-packaged-runtime.ts`、相关 spec、`cmd/server/routes_source_test.go` | G-9（P0）、G-1、G-2、T-01、T-02、T-03、T-04 | 进行中 |
| **G1** | `serverstore/apps.go`、`sharedskills`、`agentshare`、`skillmanifest`、`marketplace`、`capabilities`、`webadmin Capabilities.tsx` | ID-01（P0）、G-P1、marketplace owner 无审计、待审投影污染、`appendSharedSkill` 漏拷、ID-03 | 进行中 |
| **H1** | `wasmapp/{wasmmod,appdb,abi,api,diag}` | WASM-1、WDB-1、ABI-1 | 进行中 |
| **B1** | `packages/host/desktop/src/**` | B-01、B-02、B-03、B-05、B-07、B-08 | 进行中 |
| **K1** | `scripts/ci-*.sh`、`ci.yml`、README、`docs/deploy/**`、site deployment 页 | K-01、K-02、K-03、K-04、K-05、K-07 | 进行中 |

**待排期（下一轮）**：B-09/B-10/B-26、C-01/C-02、G-06/G-07、ID-02/ID-04/ID-13 的收敛、J 路其余 15 条 P1（e2e 恒真断言、check-workflows 绕过、许可证守卫、TZ/race 空转、gofmt 口径）、以及 P2/P3（详见各子报告）。

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
- 本地 `node scripts/check-no-leftover-mutants.mjs` 当前为红，命中未跟踪且被 `.git/info/exclude` 忽略的 `audit/r8/run-mutations-r8.sh:62`（该守卫以 `cwd` 为根、无"根必须是仓库根"断言）——与提交内容无关，但会使本地 `yarn check` 变红。
