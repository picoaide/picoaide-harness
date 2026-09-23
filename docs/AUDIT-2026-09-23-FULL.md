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
>
> **读法**：§1–§6 是第一轮的结论与修复状态；**第二、三轮与"收口批"在 §7**（§7.1 二轮 / §7.2 三轮 / §7.3 处置拍板 / §7.35–§7.37 用户现场项、结构库、**收口批与逐条独立复审** / **§7.4 收敛判定与冻结态门禁数字**）。第三轮 0 P0 + 19 P1 已全部闭环，但**尚未跑第四轮**，因此"连续两轮零新增 P0/P1"的收敛条件**未达成**。

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
| **V2** | 对抗性复审：provider PUT 原子化（`0dd74681b7`） | 判**修复成立**（358 行报告；事务边界、15 条 `return`、5 条错误分支全回滚、事务内零出网、审计链可混排；新用例在父提交上必红） | 另留 3 条排队项（见 §7.3） | `temp/verify-put-r3/VERIFY.md` |

**R3-C 的四条 P1（全部是"假绿门禁"，即会让其他所有结论失去支撑的那一类）**

1. **C-1** 编排器遇到 `needs` 成环时**静默丢弃**这些包：摘要仍打印「27 个任务:27 通过、0 失败、0 跳过」且 **EXIT=0** —— 包从未运行（把 `needs` 打错一个字符同理，且会让包排到依赖之前）。
2. **C-3** **只改文档的 PR 整条门禁被跳过**，而分支保护把 skipped 计为成功 ⇒ 域名守卫（铁律 0）、迁移区间守卫、布局守卫在文档改动上**一次都没跑**（审计方以线上 PR 与分支保护实况取证）。
3. **C-4** `check-no-real-domains` 的**提交信息判据在 PR 的 CI 里恒为空跑**：gate 的 checkout 是 depth-1（无 `fetch-depth`），解析不到 base ⇒ 退化成"只看 HEAD"（PR 上就是那条 merge commit）。
4. **C-7** CI 可把门禁换成自己的弱化形态而**无任何守卫**：`yarn check --no-guards`（丢掉全部根守卫）/ `--only <单包>` / `--changed <ref>` 三种写法在 `check-workflows.mjs` 下**全部 EXIT=0**。

另有 R3-C 的 P2×4 / P3×1（含 `check-migration-range` 在"有迁移目录但无被扫文档"的合成树上仍宣称一致；`check-no-leftover-mutants` 对"同行字符串字面量里的变异标记"仍不报），以及由它交叉验证的分片报告（CI / 打包 / 中等守卫 / WASM 门禁）。

**其中"C-6 假一致"已修复**（`1305dcf450`）：`check-migration-range.mjs` 在"有迁移目录、零文档可扫"的树上会打印「扫描 0 个 md」却仍宣称「文档区间与实际一致 ✅」并 **EXIT=0**（连那棵树里并不存在的 `server/AGENTS.md` 也一并宣称"迁移号都存在"）。修法：`scanned === 0 || !agentsScanned` ⇒ **fail-loud** 并给出修法。三向实测：真实仓库 0 / 合成树（只有迁移目录）1（带修法提示）/ 夹具形态（迁移+文档+`AGENTS.md` 且区间一致）0；再把该守卫自带夹具矩阵跑一遍（`node scripts/verify-check-workspaces.mjs`）⇒ **EXIT=0**。

**第三轮新增的门禁面同样做了注入验证**（新守卫不能只信它自己的自述）：`scripts/check-doc-claims.mjs`（文档数字守卫，pin 与平台模块表**双向相等**、扫描器失效 fail-loud、带 `--selftest` 与 `doc-claim:allow` 豁免）——注入 pin 漂移 ⇒ 退出码 1、注入「共 9 项」→「8 项」⇒ 退出码 1、干净态 ⇒ 0、空树 `--root` ⇒ 1（`找不到 upstream.json —— 拒绝把"读不到真源"当通过`）。

**R3-A（服务端核心）的两条 P1（已派修复）**：**A-1** 宿主→guest 方向只有 `assets.read` 修了"单帧预算"桥 ⇒ `db.query` 结果（平台允许 1–8 MiB）被写成超帧，应用收不到结果，官方技能骨架下表现为 10 s `RUNTIME_TIMEOUT` 且**应用已写好的响应被丢弃**；**A-2** `POST /api/client/v2/apps/wasm/validate` **无归属校验** ⇒ 任意已登录员工可用最简 config 换回**他人应用**的生效配置（`whitelist`/`purpose`/`data_sensitivity`/`owner`/`sensitive_columns`）并附 `first_release` 存在性 oracle。另 8 条 P2 中最具代表性的是 **A-6**（`abi.MaxResponseBodyBytes` 512 KiB 自称"保证可交付"被 JSON 转义证伪：`<`×512 KiB 编码后 3,145,840 B > 1 MiB 帧，而钉住它的回归用例用的是**零转义夹具** ⇒ 假绿）与 **A-10**（两个版本比较器对同一对版本给出**相反**结论：`util.CompareSemVer("1.0.0-1","1.0.0")=+1` 而 `registry.CompareVersions=-1`）。R3-A 明确结论：**新增 P0 = 0**（无进程级崩溃/静默计费错误/沙箱逃逸）。

**R3-B（客户端/宿主）的其余发现与处置**：B-1（P2，设备码定义缺 `verificationUrl` 时被判 `connected` 且注册 MCP —— CN-3 缺陷类经另一扇门回归，`ae1bccc222^` 的 A/B 证明是回归）**已修**：连接期 fail-loud（`4b8d808fa9`），判据同时钉两侧（坏形状必须拒绝且零 request；"完全没有 auth 块"的形状保持既有语义），变异验证把源码回退到修复前 ⇒ 新用例红（`expected 'resolved' to match /verificationUrl/`）且对照用例仍绿；包级 41 文件 / 362 用例 EXIT=0。B-3（P2，`deadGrants` 按连接器 id 记账而事实属账号凭据世代）**已修并独立复核**：修复提交 `28e2062e38`；复核方式=用**审计方自己的探针**（`temp/round3-2026-09-23/connectors-probes/p4-deadgrant.mjs`，非修复方的测试）重跑 ⇒ 打印 `VERDICT: not reproduced`（账号 B 由 `unauthorized`+0 注册变为 `connected`+注册成功、对照账号 C 仍正常）。B-2（cron 封笔）**已修**（`eb981016cb`：`dispose()` 改为 flush → 封笔 → 放锁 的硬顺序，写路径统一走 `assertOpen()` 抛 `ledger is disposed: write refused`；8 条回归用例修复前 4 红 4 绿、6 个变异全杀、包级 22 文件/203 用例 EXIT=0、审计方原探针复跑 `DISK LOST job-2 : false`）。B-4/B-5 **已修**（`cd1f8971c4`）：B-4 把唯一判据收敛到 `jobs.ts` 的 `isUsableJobName()` 且工具面/协议面都调它（空名/纯空白 fail-loud、零落盘，反向用例 `'  Nightly report  '` 照常创建）；B-5 按拍板「如实跳过 + 改注释 + 可观测」落地 —— 判据只报告缺口**不改任何命中时刻**，缺口记录写进 ledger 的 `skippedOccurrences`（有界 8 条、按 (jobId,wallClock) 去重、跨重启回读）+ 可 grep 的 Host 日志 + 面板 3 天内提示。行为等价性用 11 时区 × 18,720 = **205,920 次 `nextRunAtMs` 比对、mismatch=0** 证明（且探针在 7 个时区检出 476 条缺口记录 ⇒ 非空转）；5 个变异全杀；包级 23 文件/220 用例 EXIT=0。B-4/B-5（P3，当时记为"待随 cron 批次处置"）**已在同一批次修完**（`cd1f8971c4`）：B-4 把唯一判据收敛到 `jobs.ts` 的 `isUsableJobName()` 且工具面/协议面都调它（空名/纯空白 fail-loud、零落盘，反向用例 `'  Nightly report  '` 照常创建）；B-5 按拍板「如实跳过 + 改注释 + 可观测」落地 —— 判据只报告缺口**不改任何命中时刻**，缺口记录写进 ledger 的 `skippedOccurrences`（有界 8 条、按 (jobId,wallClock) 去重、跨重启回读）+ 可 grep 的 Host 日志 + 面板 3 天内提示。行为等价性用 11 时区 × 18,720 = **205,920 次 `nextRunAtMs` 比对、mismatch=0** 证明（且探针在 7 个时区检出 476 条缺口记录 ⇒ 非空转）；5 个变异全杀；包级 23 文件/220 用例 EXIT=0。审计方另**撤回**上一轮 B-20（mac afterPack 原生件校验死代码：mac 目标只有 arm64，而 `verify-mac-smoke.ts` 对同一份清单逐个 exists+lipo 已补偿），并确认 SH-1（真实适配器未实现 `webContents.stop` ⇒ `stopPendingLoads()` 静默 no-op）仍未修。

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
| **A-11 的 webadmin 半边** | **已修**（`657f2da55b`） | 服务端已改为"省略 `enabled` 即保持现值"，`server/webadmin/src/pages/Connectors.tsx` 那个**绕过补丁**已删除；判据=表单不回传 `enabled` 时保存后仍为停用（已补用例）。 |
| **A-8 / A-9 未做**（本批已逐条回报） | **已修 + 已独立复验** | A-8：`eae1d08774`（5 个逐名端点补 `requireMarketAgent`，org 行 404 且与"不存在"逐字节同形）+ `2251df8dbb`（agentshare 管理面归档只服务 org 行）+ `5e9001f4ab`（逐端点/坏 body 用例）+ `d24e473b2a`（**生产路由表** ↔ 渠道口径清单双向对拍，关闭"只改 `internal/router` 就绕过守门"的盲区）+ `231914b841`（CI 用例级零 skip 范围纳入两个包）。A-9：`b09ef41659`（official=1 ⇒ owner 恒空 + 归属转移审计带 app_id + 第二写入口守卫）+ `c0e951c6a6`（拒绝提示点名可执行端点）。复验 `temp/verify-a8a11-gaps/VERIFY.md`：**F1/F2/F3/F4/F8 全部成立**，且复验方自己的 MG1/MG6/MG2/MF4 变异均红在贴切的那一条上。 |
| **R3-A 的 8 条 P2 / 3 条 P3**（A-3~A-13） | **已并入 wasmapp 修复泳道，按优先级止损** | 已随 A-1/A-2 一并交办并给了判据：A-6/A-7 可交付响应体口径（保证值 ≈170 KiB、1 MiB 仅为原始帧上限，同步 abi 注释/作者手册/客户端常量并让 parity 用例真钉 `response_body_bytes_max`）、A-10 收编到一个 SemVer §11 正确的比较器、A-11 省略 `enabled` = 保持现值、A-8 最小处置（该文件刚被 `f4a9a7774b` 改过，须先看 HEAD 内容）。优先级 A-2 → A-1 → A-11 → A-10 → A-6/7 → A-8/9，**未做的必须逐条回报"未做 + 原因 + 建议判据"**。其中 **A-6 与 A-3 是本轮最值得注意的两条**：前者是"自称保证可交付"的常量被平台自己的 JSON 转义证伪，且**钉住它的回归用例用零转义夹具 ⇒ 假绿**；后者是审核开关**读取失败被当作"审核关"**（fail-open，未审批版本直接 `approved`）。 |
| **技能库收口的四条拍板**（`fa49eb7f5b`） | **接受** | ①技能库根留下点开头的空 `.skill-locks/`：**接受** —— 发现器与清单看不见它；改成释放时 `rmdir` 会引入 `mkdir→open(wx)` 的 ENOENT 竞争面（两端都要加重建重试），代价大于收益（已按它放行三处旧断言并新增"锁不得残留"断言）。②**安装器侧有界等待 5s / 同步侧零等待**的有意不对称：**接受** —— 同步跑在 `apply()` 启动路径且与安装器同进程，忙等会饿死异步持锁者（自锁）；只可调大常量，**不得改成无界**。③**F5**（面板按 409 状态码而非 `data.code` 判覆盖确认）：**保持推迟**（牵动确认条渲染与 61 例面板 spec）。④复审 §6.6 其余遗留（卸载不持久、面板预判、`provenance.version` 陈旧、W4 §6 的 P2-1~P2-4）**本批未动，保持排队**。 |
| **守卫面仍存的 6 处静默通过形态**（`2f6eda18a1` 同批认账） | **5 处已修，1 处认账** | ①`verify-licenses` 空依赖树 ⇒ `0b42da1088` fail-loud（+ `--allow-empty` 显式入口）；②`check-no-leftover-mutants --root` 指向不存在目录 ⇒ 已 EXIT=2（实测）；③`check-no-real-domains` 空仓 ⇒ `898fecb98e` EXIT=3 且不打印"零命中 ✅"；④两条以异常栈失败的守卫 ⇒ `0b42da1088` 改具名断言（glitchtip 目标缺失 / verify-patches 缺 adm-zip / verify-licenses 空树三条实测：具名、零栈帧、退出码 1）；⑤`electron-shots` 无静态覆盖 ⇒ `ce2139171b`（语法/接线/SKIP 契约 + 聚合层 77 码）；⑥**真机端到端仍未跑**（需 Docker + 真实服务端 + Xvfb + 打包产物，本机不具备）——**认账，不得读作"已验"**。 |
| **V2 复审的 P2：审计不可写 ⇒ 配置保存整体失败**（原为 `200` + 静默丢审计） | **接受（fail-closed，不加代码旁路）** | 对"改配置即改钱"的路径，宁可保存失败也不能静默丢审计 —— 后者正是本次修掉的那一类。**明确不做**运营侧旁路开关：那会把"静默丢审计"重新引入。运维出路是修审计存储（锁/磁盘），不是绕过。要求错误文案可行动（点名审计链写入失败及其可能原因）。 |
| **V2 复审的 P3-a：丢失更新窗口被放大**（事务外读 → 事务内整行写回） | **已修 + 已独立复验**（`1f9c621b98`） | 基线读改到事务内并取 `SELECT … FOR UPDATE`（并发改名不再把刚轮换的密钥/刚改的 base_url 写回旧快照）；复验 `temp/verify-provider-writes/VERIFY.md` 用外部连接持锁 + `pg_stat_activity` 观测的确定性交错证明"承重的是行锁"（自做变异 M-B2"事务内读但不取锁"同样红）。 |
| **V2 复审的 P3-b：行锁持有时间 O(清单长度)**（2000 模型 ⇒ 941 ms） | **接受并记录上界** | 上界由 `adminMaxBodyBytes`(1 MiB) 约束；本次新增的只有一次主键等值查找 + 行锁（`EXPLAIN ANALYZE` 0.137 ms），主导项与提交态一致。增量同步属独立的性能/行为变更，未做。 |
| **`POST /providers` 仍是同族半提交**（`AddGatewayProvider` + 独立事务同步 + 补偿删除 `_ =` + 异步审计 `_ =`） | **已修 + 已独立复验**（`1f9c621b98`） | 手动型收敛为「插行 + `SyncProviderModelsTx` + `AuditLogTx`」单事务（补偿删除整段删除）；渠道型出网同步移到 `Commit` 之后并写明不对称理由。复验自建注入：把 `audit_logs` 改名使审计不可写 ⇒ 修复态 500 + 零行零审计，父提交态 **200 + provider 行已落库 + 零审计**。同批还修了 `AddExcludedModel` 读-改-写竞争（并发删除丢项、下轮同步复活被删模型）与掩码密钥回写（`api_key=="***"` ⇒ 400 VALIDATION，父提交态 **200 + 真密钥被写成 `***`**）。 |
| **分支保护新增必需检查**（CI 泳道建议） | **需用户在 GitHub 侧处置** | 新 job「Gate (root guards, every change)」建议一并加入必需检查；**不加也已关上**（原 Gate 会连带红，因为 gate 的第一步就是"守卫未成功即 exit 1"）。与 C-10 一起做最省事：配 CODEOWNERS + 必需评审人数 ≥1 + 把该 job 设为必需。 |
| **CI 泳道三条取舍** | **接受** | ①C-4 的 fail-loud 对本地浅克隆同样生效（EXIT=3），逃生门是显式 `--no-commit-range`；②`--concurrency`/`--full-output` 刻意放行（不减覆盖面、只影响日志）；③`ci-channel-transfer.sh` 刻意不算"对外上传"（R2 上只是 run 级临时中转前缀、由 release job 的 `always()` 销毁），否则三个桌面打包 job 都要加发布说明检查。 |
| **C-5/C-6/C-8/C-9（P2/P3）** | **已修 + 已独立复验** | C-5（域名守卫扫描面「已跟踪 + 未跟踪未忽略」+ 空扫描面 fail-loud）`898fecb98e`；C-6（迁移区间守卫零文档/缺 `AGENTS.md` fail-loud）`1305dcf450`；C-8（编排器"软降级"进 CI 摘要，有界）+ C-1/C-2（`needs` 成环/打错不再静默丢包、调度表自检）`8844d42963`；C-9（变异守卫的输入/扫描面判据）+ 跨守卫合成正负例 `c6be2b42bd`。复验 `temp/verify-guards-final/VERIFY.md`：**5/5 成立**，且修复前形态可逐字复现（旧版成环 `EXIT=0` + "7 个任务:7 通过、0 失败、0 跳过"）。 |
 + 分支保护必需评审人数为 0 | **需用户在 GitHub 侧处置（本会话不可改仓库设置）** | 现状：同一个提交既能往 `ALLOWED_DOMAINS` 加白名单条目、又能让守卫放行，且无需任何人工评审 ⇒ 铁律 0 的第一道防线完全依赖"提交者自觉"。代码侧可做的缓解（每条白名单必须带 owner+理由、白名单变更与守卫变更不得同提交）无法真正阻止有写权限者；**建议**给 `scripts/check-no-real-domains.mjs`（及其白名单）配 CODEOWNERS，并把 `required_approving_review_count` 提到 ≥1。 |
| **P-1** 打包必需清单"单条删除＝同时删断言" | **已修 + 已独立复验**（`51e37828e0`，续 `17652dad3e`/`5ce4d18ec3`） | 反向 oracle（归档里每个 `@picoaide/*/lib/**` 真实 specifier 都必须被清单覆盖）+ 每包条数棘轮 ⇒ 删条目必红（复验实测：删一条仍需 **24 failed**）；后续把"暂存层接线"判据升级为**能力级**（不注入替身、断言 builder 那一刻 `--config.directories.app` 指向真实暂存目录）⇒ 审计原两种注入形态修前 `17 passed`/`34 passed`、修后必红。 |
| **W-1~W-5**（WASM 门禁：树移出扫描面/三方对拍改名退化为 PENDING/桶上限来自 env/组 3 与组 6 从不执行） | **已修 + 已独立复验 + 已接线** | 判定层 `a910bf9f19`（删除面清单驱动 + 包清单双向断言 + 旧能力结构指纹；桶上限真源移入仓内 JSON，env 只能收紧；判定脚本三段退出码；全组 SKIP 即失败）；CI 接线 `70360f5a33`（`WASM_GATE_EXPECT_HEAD=${{ github.sha }}` 接进 gate 的两处入口 + `check-workflows` [SK-12]③ + `verify-ci-scripts` 静态/动态双判据）⇒ "有能力、没接线"这条形态闭合。 |
| 组 8 载体措辞扫描面 | **已收口**（`bf82c7d03e`） | 扫描面 4 根/148 文件 → 6 根/877 文件（含 `packages/**` 源码，反向保留 vendored `memory-evolve/lib`），当场红出 6 处"应用由内置浏览器承载"的错误模型并逐条改注释（**零豁免**）；缩面两条独立判据（登记值 + `package.json#workspaces`）缺任一即 exit 2。 |
| `check:wasm-channels` 是否"声明了却从不运行" | **核实为误判（无孤儿守卫）** | 它由 `verify-wasm-client-only.sh:504-513` 间接调用，而 `check:wasm-client-only` 在编排器 `GUARDS` 内。逐条核对 package.json 的 `check:*` ↔ 编排器后：**无孤儿守卫**。（行号勘误：第四轮 R4-D 复核发现原文写的 `:361` 在任何提交上都不成立，结论不受影响。） |

### 7.35 用户现场新增（2.8.1，客户端技能库）：`skill_manage create` 在默认沙箱下永久失败且报错误导

- **现象**：用户要求安装一个技能；`skill_manage(action:"create")` 连续三次（同一会话、同一进程）失败，报
  `dsh-memory-evolve: write target <HOME>/memories/pending-skills/<name>/SKILL.md.tmp.<pid> is a symlink or escapes its directory — write refused`。
- **证伪"符号链接"**：会话内的自证探针（`stat -f` / `readlink` / 逐层 `lstat` / `realpath`）显示该路径**是普通文件、父链全是真目录、realpath 在根内** ⇒ 文案与事实不符。
- **真机制（两条叠加）**：
  1. **原子写失败后泄漏 0 字节 `.tmp.<pid>` 且重试非幂等**：临时名是**按 PID 确定**的 `${target}.tmp.${process.pid}`，创建用 `O_EXCL`（`openExclusiveSafe`，`wx`）⇒ 一次失败留下残留后，**同一进程内对该落点的所有重试都命中 EEXIST**，并被统一映射成上面那句"符号链接"拒绝。会话内另见同日更早的同类残留 `<HOME>/memories/dsh-memory-evolve/update-state.json.tmp.<同一 pid>`（0 字节）⇒ 是插件原子写的**通用**缺陷，不是本次技能路径特有。
  2. **技能库在会话工作区之外**：`<HOME>/memories/**`（以及 `~/.agents/skills`）不在 `workspace-write` 的工作区内 ⇒ **agent 连清理残留都要提权**：`rm` 得到 `Operation not permitted` + `[sandbox: file access denied under workspace-write mode]`，最终靠用户批准 `danger-full-access` 才删掉一个 0 字节文件；此后每次技能更新又各要一次批准（本会话共 9 次审批，其中 8 次理由是"技能库在会话工作区之外"）。
- **代价**：agent 被误导去 `app.asar` 里 grep 守卫实现、反复探测文件系统，约 150 步后才用"把 SKILL.md 直接 `cp` 进另一个技能根"绕过；**产品自身的技能安装通道从未成功**。
- **待修（本会话未修，登记为 P1）**：①失败分类与文案（分辨 `EPERM/EACCES`（权限/沙箱）与真正的符号链接/越界，二者不可共用一句）；②原子写失败必须清理自己创建的临时文件，且重试要幂等（临时名加随机后缀或失败即回收）；③数据根（技能库 / memories）与沙箱工作区的关系需要产品决策：要么把自身工具的写入面纳入沙箱允许范围，要么在会话为 `workspace-write` 时对该写入给出**可行动的**指引（而不是让用户反复批准提权）。

### 7.36 Normify 架构结构库：二轮增量刷新完成（结构库本身不入库）

- **形状**：1544 模块（312 容器 + 1232 叶子；+3 为补"新源文件无模块认领"的覆盖缺口）、3551 条唯一 API 键、2536 条 source 证据、1165 条依赖边、312 层渲染数据（容器 100% 覆盖）；产物 `tree.json`/`outline.md`/`api-index.json`/`receipt.json`/`picoaide-architecture.html`（5.49 MB）。
- **自证**：独立校验器 `tools/verify-tree.mjs` **problems 336 → 0**；`repair-plan.mjs` 0 悬空边/0 重复键/0 缺 apis/0 缺 layout；`normify_validate` **408 error → 0 error**（18 条 warning 与任务书"已知可接受"完全吻合，且数字未变）；行号越界 7 → 0；build ✅ render ✅。变更记录 `2026-09-23-incremental-refresh-round2`（**verified**，revision.after `7a82c2db81`，create 3 / modify 480 / delete 0）。
- **做法上的一处关键修正**：没有把 `normify_sync` 的 `affected` 当重建清单 —— 那是"文件→模块"映射的**上界**（含大量只改测试文件、或生成期已读到新内容而无需动的模块）。改为独立只读脚本对全部模块复算指纹并与本区间真改动文件比对，得到 **334 个真漂移模块**再重建；16 个偏粗叶子与 859 条未锚定箭头维持原样（非本轮引入）。
- **认账的不确定性**：①仓库有并发写者，`docs/AUDIT-*` 收尾时仍在被追加 ⇒ 该模块会再次显示 fingerprint-drift（预期，可 `normify_module_refresh` 消掉）；②`verify-packaged-runtime.ts` 当时有未提交改动，4 个 runtime-verify 叶子的行段按当时 HEAD 给出，落地后需再刷一轮；③`update-download.ts` 的两条修复当时只在 `origin/master` 而不在工作树。
- **发现的引擎侧系统性缺陷 6 条（供后续修 normify 本身）**：①`revision` 是单值 SHA 且校验器原本硬编码它 ⇒ 增量刷新必然产生混合值、会把 483 个模块误报成缺陷（校验器已改为接受"生成 revision 或 HEAD 的任一祖先"）；②`module_patch`/`batch` **不重算也不校验** fingerprint ⇒ 改 source 后必须固定跑 second-step `module_refresh`；③"叶子 API 键全项目唯一"与"实现收敛成 re-export"天然冲突，垫片必须用来源前缀键；④`change_close` 对活工作树校验，并发写者下可能永远等不到 0 error 的瞬间（本次被打断 3 次）；⑤子代理工具传输**传不了数组参数**（3 个代理命中 `args/missing: items`，绕法=逐条 patch）；⑥`sync` 的 `affected` 既漏（行号越界类）又过（测试文件类），两端都要独立只读扫描补。

### 7.37 第三轮收口批（同日）：每条修复都由**另一名子代理**独立复审

**提交计数（第四轮 R4-D 复核后校正）**：本批区间 `c0799e4103..HEAD` 共 **40 个提交**；下表列出其中 **37** 个，其余 3 个是收口尾批（`9f670cc635` limits 真源 + 作者手册纠偏、`30aff37522` A-4 顺序判据、`52ea7fbf54` `DB_LIMIT` 口径）与本报告的两次回填提交。原文写的"36 个"是写作时的快照，已按事实校正。

第三轮的三份审计报告（R3-A/R3-B/R3-C）与三份对抗性复审（V1/V2/verifier 报告）给出**全部 P0/P1 与各条 P2/P3** 后，本节记录"修复 → 独立复审 → 复审发现 → 再修 → 再验"的闭环。所有提交都在本地 `master`（**未 push**）；每条修复都要求"回归测试 + 变异验证（把实现改回旧行为，对应用例必须变红）"。

**十个面与本批提交**

| 面 | 提交 | 独立复审结论 |
|---|---|---|
| R3-A 服务端核心（A-3/A-4/A-5/A-8/A-9/A-11/A-12/A-13） | `ff6ee6893f` `b09ef41659` `eae1d08774` `657f2da55b` `777d366fed` `f18548e7dd` `792a503a14` `7b48de77a7` `36e70219c9` `c0e951c6a6` `c532bd93bb` `2260a9d492` `32b15a7b26` | `temp/verify-r3a-p2p3/VERIFY.md`（409 行）：**7 成立 / 1 部分成立**（A-4 漏第三个消费面 ⇒ 已修 `c57998be18`）；`temp/verify-wasm-tail/VERIFY.md`：A-4 客户端半边与 A-5 文档**成立**（并指出文档面未收干净 ⇒ `2260a9d492`/`32b15a7b26`） |
| A-8 复审缺口（F1 生产路由表对拍 / F2·F3 逐端点与坏 body / F4 归档归属 / F6 口径 / F8 CI 范围） | `d24e473b2a` `5e9001f4ab` `2251df8dbb` `231914b841` | 由**发现该缺口的原验证者**复验（`temp/verify-a8a11-gaps/VERIFY.md`，240 行）：**F1/F2/F3/F4/F8 全部成立**，MG1 复现为"修后必红且红在最贴切的那条"，反向对照 MG1b 证明双向断言非恒真 |
| 门禁 C-1/C-2/C-5/C-8/C-9 + 六处静默通过形态 | `8844d42963` `898fecb98e` `0b42da1088` `c6be2b42bd` `ce2139171b` | `temp/verify-guards-final/VERIFY.md`：**5/5 成立**；修复前形态逐字可复现（旧版成环注入 ⇒ `EXIT=0` + 「7 个任务:7 通过、0 失败、0 跳过」）；复验方另跑 10 条自设计变异逐条反证；全量门禁 31/31、0 失败、0 跳过 |
| 门禁精度次生（降级行假阳性 / PATH_OWNERS 文案与自检 / 域名守卫读穿软链） | `9290a3f437` `f8c5984f47` | `temp/verify-tail-guards/VERIFY.md`（426 行）：**成立**；5 条假阳性一条不剩、13 条合成真阳性全收；`--changed` 归属逐字节未变；六问（软链/已跟踪/可见性/扫描面/普通文件/已跟踪文件）全过 |
| WASM 门禁 W-6~W-9 + CI 接线 + 扫描面 | `45281e94e3` `70360f5a33` `bf82c7d03e` | 同上报告：**成立**；SKIP 记账真、PASS 文案动态、W-7a/b 与 W-9 必红、`WASM_GATE_EXPECT_HEAD` 七形态退出码全对、扫描根三条 fail-loud、五桶与 inventory 逐值一致且**清单零改动** |
| 打包 P-2/P-4/P-5/P-6 + 次生 N-1/N-2 | `17652dad3e` `757c07bb5f` `5ce4d18ec3` | `temp/verify-tail-pack/VERIFY.md`：**成立**；审计原两种注入修前 `17 passed`/`34 passed` ⇒ 修后必红；P-4 两处真源逐字同源、单侧改动必红；并抓出修复自身引入的两条回归（渠道覆盖文件进 asar / `invokedDirectly` 经符号链接静默 exit 0）⇒ 已修 |
| 跨端判词闸 F1~F4 | `079771b9c5` | 同 `verify-tail-guards`：**成立**；四种躲过形态（常量型终态/大写 reason/实现放宽 `.htm`/文档多列）全部红，等价重构 4/4 假红的代价已量化 |
| provider/模型写路径 A/B/C/D | `1f9c621b98` | `temp/verify-provider-writes/VERIFY.md`：**A/B/C/D 全部成立**，且用自建注入证明承重机制（审计不可写 ⇒ 修复态 500+零行零审计 ↔ 父提交 200+行已落库+零审计；`FOR UPDATE` 是丢更新与名单丢项的承重点） |
| A-4 残留 + A-12/A-13/A-3/M-A9b 判据加固 | `c57998be18` `4babc6cd75` | `temp/verify-final-batch/VERIFY.md`（本批末复验） |
| 装配函数直挂 `/api` 残差 + SKILL 数值纪律回归 + limits 真源/作者手册漂移 | `2e22601c0a` `0de1f4cb93` `9f670cc635` | 同上；SKILL 回归与 limits 漂移都是**本批自己引入/自己查出**的门禁红（见下） |

**复审抓出并已修掉的次生问题（这就是"修复也要独立复审"的价值）**

1. **A-4 只修了两个消费面**：`POST /apps/wasm/validate` 对冻结/退役应用仍回 `200 {"ok":true}`，而 publish 回 403/404 —— 正是 A-4 要消灭的"预查说可以、发布被拒" ⇒ `c57998be18`（validate 在归属校验后调**同一个** `publishBlockOf`，与真发一次 publish 的错误响应**逐字节相同**；下架不拦）。
2. **A-12 判据测不到时序缺陷**：断言落在 `httptest.ResponseRecorder.Header()`（活 map）上，且测试路由树只注册 GET 而生产注册 GET+HEAD ⇒ `4babc6cd75`（改 `w.Result().Header` 快照 + 补 HEAD + 真实 TCP 用例；时序变异下新判据红、旧判据绿的对照可复现）。
3. **A-13 扫描面按目录名 skip 过宽**：真消费方放进 `packages/vendor/memory-evolve/lib/`（**入库源码**）时用例存活 ⇒ `4babc6cd75`（改结构位置判据 + 扫描面下限）。
4. **A-3 取值无法识别时静默按关**（`""`/`"tru"`）⇒ 加可 grep 的 fail-loud 日志；顺带修掉"平台自己写的 `"false"` 会被误报成无法识别"这一噪音源（返回值逐字相同）。
5. **M-A9b（api 层冗余被删也测不到）**：跨层行为用例对"删任一侧"都存活 ⇒ 补源码级**双侧**判据（Go AST）。
6. **门禁精度三连**：`[DEGRADED]` 把成功摘要误判成降级（9 行里 5 行假阳性）⇒ 排除谓词；`PATH_OWNERS` 注释/报错写"最长前缀优先"而实现是 `find` 先声明者胜、且不拦"嵌套前缀归属另一包" ⇒ 文案改事实 + 新自检；域名守卫对未跟踪软链**读穿**被忽略目标（顺带修好"已跟踪软链"的旧漏报）。
7. **WASM 门禁四条 + 两条未接线**：SKIP 不计账且 PASS 文案说反话、组 8 五条是固定枚举（台账里"已闭合"的写法没进本门禁）、"结论绑定 HEAD"只自洽不绑权威、反向 grep 吞 rc≥2 且扫描根含不存在文件 ⇒ 全部修；另把 `WASM_GATE_EXPECT_HEAD` 真正接进 CI 两处入口、扫描面从 148 扩到 877 个文件并当场红出 6 处错误模型（零豁免）。
8. **打包四条 + 两条回归**：暂存层守卫是字符串匹配（"保留标识符 + 换实现"整体绕过）⇒ 升为能力级；CI 的 gofmt 不覆盖 `server/demoapps` ⇒ 与 Makefile 同源并加同源对拍；"asar bigint 冒烟"在本线不存在且无任何"产物 Electron 版本"判据 ⇒ 补版本断言（bigint 那半留给 `origin/master` 的 #138，见线序事实）；asar 损坏被当成"物理布局"、错误指向不存在的路径 ⇒ 显式区分 `ENOENT` + 布局开关。修复自身又引入两条（渠道覆盖文件进 asar；18 个入口经符号链接目录调用**静默 exit 0**）⇒ `5ce4d18ec3`。
9. **跨端判词闸"抠不出才 throw"** ⇒ 改为**写入点计数**（新增常量型终态 / 大写 reason 都会红）。
10. **装配函数直挂 `/api` 残差**：复核方原描述偏宽（`/api/server/admin/*` 未申报其实会被 `TestAdminRouterNoFallOpen` 抓住），真正对**全部**既有守卫不可见的是另三种带鉴权直挂（员工面 BearerAuth / 非 admin 的 `/api/server/*` / 经 `AdminRoute` 直挂）⇒ `2e22601c0a`（AST 扫描 + 双向白名单 + 反射对拍 gin 方法表 + 扫描面为空 fail-loud；18 条变异实跑）。
11. **本批自己引入的 Go 门禁红**：A-5 收尾把 SKILL 的"8 条自检"改成"9 条自检"，撞上 `TestSkillDiscipline` 的"SKILL 里每个『数字+单位』都必须来自 limits 表"纪律（`8` 当年是撞上 counts 里的 8）⇒ `0de1f4cb93`（改成不产生"数字+单位"的表述；判据一字未放宽；SKILL 版本 2.8.0→2.8.1 + 新目录摘要登记）。同一排查还发现两条**一直存在**的漂移 ⇒ `9f670cc635`：①行浏览分页上限 `rowsMaxLimit=200` 是真平台限制却不在 limits 表里（作者手册那句"一页最多 200 行"能过判据纯属撞上 `diagnostics_max_limit=200`）⇒ 纳入真源（`RowsPageMax` + `rows_page_max` 走生成链）并新增**三方锚定**判据（`rows.go` ↔ `limits` ↔ 作者手册那一句；把文档改成 256 或把真源改成 300 都必红）；②作者手册"5000 行 / 8 MiB（超出截断并**报错**）"与真源不符（真值 **172032 B = 168 KiB** 且只置 `truncated`、不报错，`abi.md` 早在 A-6/A-7 已改对）⇒ 连同同文件另外 4 处同族漂移一并纠偏（`db.query` 原语表、响应体口径"总输出 8 MiB / 保证可交付 168 KiB"、保留期只覆盖调用事件、退役快照"后台任务尚未实现"）。SKILL 版本 2.8.1→2.9.0 + 新摘要登记。
12. **A-4 修法收益的顺序契约**（终态应用不该白耗一次真编译与发布额度）：复审查出"把 `publishBlockOf` 挪到编译之后"这一变异**存活**（用例全绿）⇒ 补一条**行为级**判据把顺序钉住（见下）。

**线序事实（必须与结论一起读）**

- 本地审计线就是**本地 `master`**：`git rev-list --left-right --count origin/master...HEAD` 落后 `origin/master` **恒为 1**（`6e964b9323` = PR #138，issue #130/#128 修复），领先数**随本批提交增长** —— 写作时 `1 96`，第一次冻结提交 `ed30ce6baf` = `1 72`，第二次冻结提交 `52ea7fbf54` = `1 113`，第四轮审计基线 `b996b2e1cd` = `1 114`（第四轮 R4-D 的复核勘误：这三个数原文只写了 `1 96`）。引用时一律以**当时**的 `git rev-list --left-right --count origin/master...HEAD` 为准。回归审计的冻结态门禁跑的是**这条线**，因此结论**不得**读作"对 `origin/master` 已验证"。
- 直接后果一：`origin/master` **已经**实现了 afterPack 的 asar bigint 门禁（`smokePackagedAsarBigintSemantics` + `scripts/asar-bigint-probe.mjs`），所以 P-5 的"这份门禁不存在"**只对本地线成立**；本批只补了它没有的"产物实际 Electron 版本 == `devDependencies.electron`"断言，**没有**重复实现 bigint 那半。
- 直接后果二（合并面，已实测）：`git merge-tree` 显示 `verify-packaged-runtime.ts` **自动合并、0 冲突块**（bigint 冒烟与版本断言共存）；真正的冲突面是 `tests/verify-packaged-runtime.spec.ts` 的 2 处 import 列表（**取并集**）与 `src/updates.ts`（来自本地线其它提交，与本次两提交无关）。

**认账边界（"已修"不等于"这类问题从此不存在"）**

- `[DEGRADED]` 的排除谓词是**整行**判据：`SKIP 0` 与 `: OK —` 两支无锚点 ⇒ 复审构造的 9 种"真降级与摘要同行"形态 9/9 不被收集；但 16 个根守卫完整输出的普查显示被排除的 12 条逐条都是真摘要 ⇒ **真实树零误伤**。这是有意的精度取舍，已在代码注释里记边界。
- 装配函数直挂判据拦不住：函数值/方法值转手（`reg := r.GET`）、反射调用、把 `*gin.Engine` 传进 `internal/**` helper、以及 `NoRoute`/`Use` 这类"不注册路由但改全局行为"。
- 跨端判词闸是**文本级**判据：等价重构（字面量→常量/单出口 helper）会**假红**（4/4 实测）；`read.go` 若把响应对象搬到别的文件构造，计数 `0==0` 仍可能静默（`publish.go` 侧已用全文件计数堵上）。
- provider 写路径的行为变更（认账）：`PUT /providers/:id` 的"不存在 id + 任何坏体"由 404 变 **400**（合法体仍 404）；`deleteModel` 的读错误由"吞掉继续删"收紧为 404/500（FK 保证实测不可达）；`AddExcludedModel`/`SyncProviderModels` 两个非事务变体现在**已无生产调用方**（只剩定义与测试）⇒ 后续新调用方容易绕过"同事务/提交后失效缓存"约定，登记为待办。
- 打包面：Windows/macOS 全部只能**静态判定**（本机 Linux）；`PACKAGED_RUNTIME_LAYOUT` 目前只有测试与显式开关用；经**硬链接**调用入口被设计成 fail-loud（不做"识别并执行"）。
- **真机端到端仍未跑**（需 Docker + 真实服务端 + Xvfb + 打包产物）——与本报告 §7.4 的口径一致，不得读作"已验"。

### 7.38 第四轮审计（同日，四路独立）+ 一条**现场发现的 P0**

**方法**：四路只读并行审计，全部**绑提交 `b996b2e1cd`**，注入/变异只在 `git archive` 副本里做；每条 finding 要求"最小复现 + 文件:行 + REPRODUCED/READ-ONLY-ANALYSIS"标注。本机 4 vCPU 上四路并行 ⇒ 已事先要求"负载型失败必须复跑再判定"（R4-C 独立跑全量 `go test ./... -count=1 -p 2 -timeout 1800s` = **52 包全 ok / 0 FAIL**，可作"本轮无负载型假红"的旁证）。

| 路 | 覆盖 | P0 | P1 | P2 | P3 | 报告 |
|---|---|---|---|---|---|---|
| **R4-A** 门禁与测试可信度 | `scripts/**`（含本轮新增守卫本身）、`.github/workflows/**`、`integration-tests/**`、`packages/host/desktop/scripts/**`、`server/Makefile` | 0 | **7** | 12 | 14 | `temp/round4-2026-09-23/R4-A-guards.md`（+ 3 份子报告） |
| **R4-B** 客户端与宿主 | `packages/client/**`、`packages/host/**`、`packages/vendor/memory-evolve/**` | 0 | 0 | 6 | 11 | `R4-B-client-host.md`（+ SA1 cron/连接器、SA2 浏览器/窗口 子笔记） |
| **R4-C** 服务端核心 | `server/internal/**`、`cmd/**`、`migrations-pg/**`、webadmin 契约面 | 0 | 0 | 5 | 3 | `R4-C-server.md` |
| **R4-D** 设计/跨面契约/文档真值 | 跨端契约、`docs/**`、`server/docs/**`、报告自身真值 | 0 | **1** | 5 | 3 | `R4-D-design-docs.md` |
| **合计** | | **0** | **8** | **28** | **31** | |

**R4-A 的 7 条 P1（全部 REPRODUCED，全部是"绿之下的覆盖面"）**

1. **补丁可以"一处都没生效"而三门禁全绿**：把 `@deepseek-ai/dsh-web-fetch-http`（唯一安装副本，补丁=关掉上游 SSRF 地址守卫）还原成 pristine ⇒ `verify-patch-resolutions`/`check-patch-pin`/`verify-patches` **全 EXIT=0 且只打一行 warning**。根因：`verify-patches.mjs:610-615` 把"已安装副本未打上补丁"降级成 warn（退出码只看 `failures`）；`:550-565` 把判据见证绑到 `.yarn/cache`（**纯派生数据**，删掉缓存条目就立刻 exit 1）；`check-patch-pin.mjs:282-290` 只比 `version`，而 pristine 与打过补丁的版本号相同。
2. **`ci.yml` 的 `on:` 触发器零判据**：删掉 `push:`（保留 `pull_request`）⇒ 三个守卫全 0，而 **tag→release→R2→公证整条发布链静默失效**（连 `ci-release-policy`、策展说明检查、tag 上的根守卫一起消失），引入它的 PR 自己仍全绿可合。
3. **被钉住的 CI 步骤只钉文本、不钉可执行性**：给步骤加 `if: false`（`run` 一字不改）⇒ **Go tests / Root guards 两步全绿**（整套 Go 测试与"守卫失败 ⇒ 必需 Gate 红"的链路可被静默摘除 = 第三轮 C-3 / PR#129 复发路径）；根因 `check-workflows.mjs:2151-2159`。
4. **afterPack 的四个验证接缝是默认参数**（electron-builder 只传一个参数 ⇒ 默认值就是生产接线）：任一改成空函数、甚至把整个静态门禁 `verify` 空转，**109/109 仍绿**。
5. **"全组 SKIP = 失败"不是组级不变量**：非 Linux 上 `--groups 6` 得 `PASS 0｜FAIL 0｜SKIP 1` + 「全部通过 ✅」+ EXIT=0（零断言）。
6. **`electron-shots.mjs` 的 8 条运行期断言零守卫覆盖**（把 `check(...)` 改成常量 `true` 守卫仍绿），且第 3 项断言引用已退役品牌夹具、**永不可能 PASS**。
7. **glitchtip 工具算出「期望 DSN ≠ 展示 DSN」却只 log**（`verify-glitchtip-ops-check.mjs:690-697`，仍打两条 OK + exit 0）。

**R4-D 的唯一 P1（跨端语义分叉，已 REPRODUCED）**：版本先后语义全仓有 **6 份实现**（Go 4：`util/semver.go`、`updatecheck:533`、`skillmanifest:380`、`registry:129`（已委托）；TS 2：`enterprise/version-compare.ts:41`、`desktop/updates.ts:935`），其中**客户端能力中心那份就是服务端刚废弃的旧 tokenizer**（`version-compare.ts:8-9` 还声称"对齐 `util.CompareSemVer`"）。实测两对分叉：`1.0.0-rc10` vs `-rc2` ⇒ Go **−1** / 客户端 **+1**（**把降级当升级**）；`1.0.0-rc1` vs `-rc.1` ⇒ Go **+1** / 客户端 **0**（漏更新）。

**R4-B/R4-C 的重点 P2**：`dirty`（本地已修改）不参与任何写面闸门（一次单击「更新」即整树覆盖用户改动）· 卸载"随包内置技能"在下次开机被静默装回（无墓碑）· 第三轮 A16 的判据与 pinned 上游相反（点号临时目录在 `localeCompare` 下**排在真目录之前** ⇒ 窗口期索引幽灵）· 连接器把"永久拒绝"当 transient 无限重发 · cron"应用关闭期间错过的触发点"完全不可观测 · 浏览器工具预算被内部 CDP 等待/池排队吃掉（31.2 s > 30 s）· 深链打开应用窗口**绕过打开闸门**（不清版本缓存 + 用旧版本覆盖平台版本头 + 不计打开次数）· 文件回收器"复检 claim → 上游 DELETE"非原子（删掉新上传者的对象而台账仍标有效）· 「管理面路由全部申报」判据是**前缀字面量**（`/api/server/ops/*` 等三种写法同时躲过 fall-open 守卫与镜像对拍）· `ModelDefaultParams` 缺 `ORDER BY`（同名多 provider 取参随堆序漂移 ⇒ 补估计费差两个数量级）· 账本/明细切分按配置的 retention 而非分区存在性（返回 **cost=0 的桶**）· 审计保留策略**没有周期执行者**。

**现场新增 P0（用户在生产实例上定位并给出证据链）：WASM 磁盘编译缓存超上限 ⇒ 发布面永久 503 且不自愈（自锁）**

- **现场证据**：`/readyz` = `503 {"ok":false,"reasons":["编译缓存超上限：578263173 > 536870912"]}`、`compile_cache_bytes/files = 578,263,173 / 31`；删缓存条目后立即恢复 200；未认证 `POST …/wasm/validate` 由 503 变 401。31 条条目 mtime **全早于容器启动** ⇒ 本进程从未回收。
- **三层根因（缺一不可）**：①**回收触发点与真正的写者不匹配** —— 磁盘编译缓存有两个写者：发布/校验期的编译子进程**与执行侧冷编译**（仓内 `runtime/cache_mode_test.go` 的 `wantDiskWrites: true` 就是判据，`runtime/config.go:143/392` 的注释也写明"回收的唯一实现是编译侧的 `compile.ReclaimCache`"），而 `ReclaimCache` 只在**编译作业之后**跑（`compile/compiler.go:700-711`，30 s 节流）⇒ "只服务、不发布"的时段缓存只涨不降；②**闸门自锁** —— `readyz.AllowPublish()`（`readyz/readyz.go:525-544`）只豁免"执行槽满载/内存不可读"，"编译缓存超上限"是阻塞项（`:431-435`）⇒ 超限 → publish/validate 503 → 不再产生编译作业 → **永不回收**；③**容量口径偏小且不可配** —— `limits.CompileCacheMaxBytes = 512<<20`（`limits.go:129-130`）是编译期常量，不在后台 11 个可配项里；单条均值 ≈17.8 MiB ⇒ 只装 ≈28 条。
- **为什么四轮审计都没发现（认账，写进判定口径）**：我们的 WASM 判据只问了"能不能逃逸 / 限额有没有真的强制 / 数据对不对"，**没有"活性/自愈"这一维** —— fail-closed 在我们口径里天然是"更安全"，于是"它恰好挡住了唯一的回收触发路径"这种**活锁**不在任何一条判据里；而"执行侧也写盘"与"回收只在编译后跑"这两个事实分散在**注释与测试**里，没有任何判据要求把三者按时间连起来推演"只读不写"的稳态；再加上审计全程**没有长跑/生产观测面**（所有"真机"验证止于单机探针与冻结门禁），这条只能靠生产面板与 mtime 才暴露。
- **处置**：已按 P0 派修（周期回收 `StartReclaimLoop` + `AllowPublish` 命中该理由时先同步回收再判 + **活锁类常设判据**："每个阻塞理由都必须登记自愈路径，未登记即红"），并要求独立复审与变异验证；容量口径可配（P1）与"宿主 cron 直接删文件"的 stopgap 退役同批处理。**第五轮起，判定口径新增第 6 条：每条 fail-closed 闸门都必须回答"被它挡住的操作之外，是否还有一条恢复路径"。**

**本轮的自我勘误**：R4-D 复核 `docs/AUDIT-2026-09-23-FULL.md` 自身，抓出 4 处不符（提交数 36→40/表内 37、线序数 `1 96` 未随提交增长、`verify-wasm-client-only.sh:361` 实为 504-513、§4 的"A-10 版本比较收编为唯一实现"与 6 份实现的事实矛盾）⇒ 已按事实校正并提交（`7e3f825926`）。

**第四轮的修复批（17 个提交）与冻结态门禁**

| 面 | 提交 |
|---|---|
| 门禁/CI/打包判据（R4-A） | `1216738a49`（补丁实效：判据见证实测移出 `.yarn/cache`，"一处未生效"必红）· `3def223354`（组级零断言不变量 + 两个文档守卫缩面判据）· `dc181ef931`（域名守卫根断言 / glitchtip DSN 判据 / 回归网自检）· `38bde0f904`（`[SK-13]` 触发面 + `[SK-14]` 被钉步骤可执行性）· `332d8ded96`（electron-shots 判据表外置 + 品牌断言渠道驱动）· `7c7c35d943`（afterPack 四接缝不可空转：显式表 + 单参数入口 + 6 条接线判据） |
| 客户端/宿主（R4-B） | `f97e8fd4bb`（随包同步：溯源版本 / `.skill-tmp/` 落点 / 卸载墓碑）· `f791928dac`（技能写面纳入 `dirty` + 卸载墓碑 + 状态码收敛）· `69e7f2568d`（连接器终态不重发 / cron 错过触发可观测 / 浏览器内部预算 / 深链打开走同一闸门 / 锁与 tmp 与双释放三处 P3） |
| 服务端（R4-C + R4-D-4） | `a580a098df`（回收器删除权换带世代号的 fencing 令牌 + 迁移 0081）· `834085bd4f`（取参确定序 / 账本按分区切分 / 审计批写如实报错）· `2997139edc`（命名空间级路由守卫 / 余额对账 fail-loud / 上游 client 单一构造点 / `internal/auditretention` 调度器） |
| 跨端契约与版本比较（R4-D） | `97d1c7fc4c` + `f5572deb78`（版本先后语义收敛为"1 份算法 + 1 份仓内共享语料 + 6 处对拍"，修前 2 对分叉 → 修后 0 对；另做 4000 对宽域 fuzz）· `27e475fc60`（trend 读源/归因口径纠偏 + 权限点改读 `rbac.go` + 4 张登记表）· `b360555fae`（安全头并集与技能名语法跨端对拍） |
| 现场 P0 | `909440eab4`（编译缓存周期回收 + `AllowPublish` 同步回收自愈 + **活锁类常设判据**：阻塞理由登记表 + 未登记即 fail-closed） |

**第四轮修复批的冻结态双门禁（提交 `2997139edc`）**：`corepack yarn check` **31/31、0 失败、0 跳过、298.8s、EXIT=0**；`make check` **EXIT=0**（gofmt 零命中、`go vet` 干净、webadmin **38 文件 / 638 用例**）；`go test -json` **pass 4037 / fail 0 / skip 4**（4 条全部是登记在案的 opt-in）；freeze A/B/C **1974 个文件逐文件 sha256 一致**（期间零写入）。另：`check-migration-range` 随 0081 落地同步了 6 处文档区间（含 `site/**` 仅数字），守卫实测 EXIT=0。

**本轮明确未修/接受（写在这里以免下次当新发现）**：R4-B-13（cron 同进程换代把在跑 run 记成 cancelled）——真修必须改写两条既有 P1/P2 断言（`audit-0923-cron-dispose-seal` 要求"封笔世代的迟到结算被拒绝且继任文档逐字节不变"）或改异步释放锁（风险更高），**保持原状并登记**（探针仍绿=确实仍开）；R4-A 的 SKIP-13 边界（release/publish job 仍无"不可跳过"判据）与 SKIP-14 边界（Go 测试包路径可被改窄）为**已认账边界**；编译缓存上限后台可配（P1）给了五处确切改动清单但**未做**。

### 7.39 第五轮审计（同日，四路独立）：**活性/自愈这一维确实藏着东西**

**方法**：与第四轮同形（四路只读、绑提交、注入只在 `git archive` 副本、每条给最小复现与 REPRODUCED/READ-ONLY 标注），但**换了角度**：R5-A 审"活性/自愈/运营可达性"（第四轮那条现场 P0 定义的新维度）、R5-B 审"跨层产品行为（用户视角）"、R5-C 审"发布与交付面（pre-release）"、R5-D 对"第四轮新增的判据"再做一层对抗。**上一批（第四轮）修复的独立复审同时给出结论：4 组主题、6 个门禁/打包提交、3 个服务端提交 + 现场 P0 全部"成立"**（`temp/verify-r4a-fixes/`、`temp/verify-r4b-fixes/`、`temp/verify-r4c-fixes/VERIFY.md` 共 3 份、约 1300 行，零"不成立"），并就"还能怎么绕过"给出 7+3 条边界。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R5-A** 活性 · 自愈 · 运营可达性 | 全部 fail-closed 闸门 / 调度器 / 保留策略 / 队列 / 锁 / 增长面 | 0 | **8** | 14 | 11 |
| **R5-B** 端到端产品行为（跨层） | 技能生命周期 / 能力中心与审批 / 应用 / cron 与连接器 / 权限可见性 | 0 | 0 | 3 | 5 |
| **R5-C** 发布与交付面 | tag→CI→Release→R2→客户端交付→升级回滚 + 铁律 0 机器防线 | 0 | **3** | 4 | 3 |
| **R5-D** 新守卫第三层对抗 | 第四轮新增/改动的全部判据 | 0 | **4** | 19 | 15 |
| **合计** | | **0** | **15** | **40** | **34** |

**R5-A 的 8 条 P1（这一路是第五轮的主战场，全部围绕"闸门关上后谁能打开它"）**

1. **用量账本永久少计金额**（真 PG 复现）：保留期**放大** + 启动补算把已 DROP 的月份**空重建** ⇒ 月报/用量中心永久少计（聚合 `0.0000` / 账本直读 `3.0000`）。R4-C-4 想防的正是这个场景，判据被自身重建路径反噬。
2. **保留清理整轮中止**：一个**错界老分区**让 `CleanupUsageRetention` 永久停摆（只能人工 DROP）。
3. **网关文件回收队头阻塞**：批次=最旧 500 + 失败即归还认领 ⇒ ≥500 条永久失败行占满每轮，更晚文件永不回收（上游配额单调泄漏）。
4. **回收者与水位可见性整体挂在编译子系统上**：编译子系统缺席时**执行侧照写** `_compile-cache`，而周期回收不启动、`/readyz` 自报 **0 字节** ⇒ 现场 P0 的另一半没修完。
5. **`/readyz` 文案教运维"整目录删除缓存不影响正确性"**，而执行侧 wazero 的 fileCache 启动时绑定分片目录、**不会重建** ⇒ 照文案做完，所有冷编译失败到重启（实测逐字错误串）。
6. **`usage` 明细保留清理没有周期执行者**（审计侧已由 R4-D-4 修好，usage 侧漏了）。
7. **OIDC 流程启动桶把"成功"也计入且无清账** ⇒ 每出口 IP 的 SSO 被**永久**压到 60/5min，纯合法流量即触发。
8. **`appproof.ReplayGuard.order` 实际无界**（清理阈值 `capacity/2` 在有消费头时永不触发；nonce 还在验签前就被消费）⇒ 员工 bearer 即可驱动内存增长。

**R5-B/R5-C/R5-D 的重点**：下架（`enabled=false`）在员工面**不可表达**（作者三个面全空、客户端零「下架」词汇，而下架期间作者仍能上传、管理员仍能批准）· 归属转移后员工面与真实归属**相反**（旧作者永久可见却续传 409、新归属人什么都看不到）· 已安装智能体下架后既不能更新也不能卸载 · cron `nextRunAt` 是绝对时刻 ⇒ 时区变更后**错点触发一次** · 「冻结」在员工侧是单向门 + 文案承诺不可达 · **tag 漏 `v` 前缀 = 静默零发布**（三平台白构建、交付面为零、CI 全绿）· tag 拓扑零判据（上一个 tag 在旁支 ⇒ 修复被静默丢掉）· **预发 tag 的发布说明零机器判据**（回退 PR 列表 = 历史泄露路径）· 渠道仓同一次 tag 被 `clone --depth 1 origin/main` **克隆 4 次不 pin** · **R5-D 的"点名式覆盖"**：第四轮的 `[SK-14]`、判据表、交付物侧硬判据、接缝身份等**本体都有效**，但只覆盖"当时点名的那几个对象" —— 换一个 job / 一条发布步骤 / 一份安装副本 / 一个扫描根即静默（含 `readyz` 登记表只解析单个文件 ⇒ 同包另一文件追加 reason 会让现场 P0 形态复发）。

**第五轮的修复批（22 个提交；每条都有变异验证，涉及守卫的另加"原形态可复现"对照）**：`8fc4245e36`（随包技能自动同步不再静默覆盖用户修改 + 禁用标记不再被误判 dirty，即复审 N1/N1b）· `2a1799fb5b`（OIDC 流程桶只计失败 + proof 重放表上界）· `c32cd5874d`（tag 漏 `v` / 旁支拓扑 / 预发缺说明三类"静默零发布"补判据）· `c8c6e2079a`（渠道仓一处解析全链复用）· `ceed030b3b`（保留清理不再自我阻塞 + 周期执行者）· `d5a33d6f41`（回收候选按尝试次数分层）· `8d82bf50a0`/`1c38f7dd69`/`9d6429d3df`/`0d137aadf3`（能力中心下架/归属呈现 + 冻结可解冻 + cron 时区重算 + `delisted` 透传）· `3fe4bbe6ce`/`bd0bf855a0`/`f7b7e26677`（运行期判定通道与自检自证网 + 交付物 job/发布链步骤登记式可执行性 + 能力级远端写入识别 + 作者面判据收窄到应用目录语境）· `56cbbdce95`（回收/水位脱离编译子系统 + 缓存目录自愈与运维文案 + `readyz` 登记表解析面扩整包）· `df967148f2`/`cf8e855d19`（下架与归属语义收敛到单一权威 `distribution.go` + 目录同步只自动停用永不自动启用）。另有报告回填 `b0851273f1`。

**第五轮暴露的两条"元教训"（写进判定口径）**：①**审计"上一轮刚加的判据"必须作为固定动作** —— R5-D 的 4 条 P1 全部属于这一类，而它们的**本体是有效的**，缺口 100% 在覆盖面（"点名式覆盖"）；②**"检测"与"计票/退出"必须走两条独立通道** —— 第四轮把检测手段解耦了，第五轮仍发现 2 处"检测报红但退出码为 0"（判据白写）。

**收敛判定更新**：第五轮 0 P0 / **15 P1** ⇒ **仍未达成"连续两轮零新增 P0/P1"**。截至本节的轮次计数：第一轮 6 P0+66 P1、第二轮 1+15、第三轮 0+19、第四轮 0+8（+现场 P0）、**第五轮 0+15**。"连续两轮干净"的窗口尚未出现，需要第六轮（在第五轮修复批的冻结态上重跑同一口径，含"上一轮新判据的覆盖面"与"活性/自愈"两维）。

### 7.4 收敛判定

**判定：未达成"连续两轮独立审计零新增 P0/P1"。** 第一轮 6 P0 + 66 P1、第二轮 1 P0 + 15 P1、第三轮 0 P0 + 19 P1、**第四轮 0 P0 + 8 P1**（R4-A 7 / R4-D 1；另 28 P2 + 31 P3），外加**一条生产现场发现的 P0**（编译缓存自锁，§7.38）—— 四轮都不是干净轮，按口径干净的一对必须顺延到第五、六轮。**第四轮的结构性意义**：它证明"第三轮的新增守卫自身"也需要被审计（R4-A 的 7 条 P1 有 5 条正是**第三轮刚修/刚加的判据**的覆盖面缺口），而"活锁/自愈"是一整类此前完全没有判据的缺陷。

**收口批之后的状态（2026-09-23 同日）**：第三轮的全部 P0/P1 与本轮新增的各条 P2/P3 都已修复、且每条都过了**另一名子代理**的独立复审（§7.37，含"复审发现 → 再修 → 再验"的两轮：如 A-4 的第三个消费面、打包修复自身引入的渠道文件进 asar、以及本批自己撞出的 `TestSkillDiscipline` 门禁红）。但**这不等于收敛**：按本报告口径，"连续两轮零新增 P0/P1"要求的是**新的独立审计轮次**（第四、五轮）在同一冻结态上都不再产出 P0/P1 —— 本轮做的是"第三轮发现项的闭环 + 复审"，**尚未跑第四轮**。因此本会话结束时的准确状态是：**待跑第四轮审计**（范围建议：R3-C 未覆盖的组 4/5/6/7 深水区、客户端技能库/能力中心的端到端行为、`internal/serverstore` 与网关计费的并发面、以及"本轮新增守卫自身"的对抗性审计）。

**第三轮新增 P1 的归属与本轮处置**

| 面 | 条数 | 处置 |
|---|---|---|
| R3-A 服务端核心 | 2（A-1 帧预算只修一条桥、A-2 `validate` 无归属校验） | 已派修复泳道（要求枚举全部 host→guest 返回路径；归属校验与既有 owner-only 404 同形且不泄露存在性；≥4 变异） |
| R3-B 客户端/宿主 | 1（B-2 cron `dispose()` 不封笔） | **已修** `eb981016cb`（flush → 封笔 → 放锁 硬顺序；8 用例修复前 4 红、6 变异全杀、包级 22 文件/203 用例 EXIT=0；审计方原探针复跑 `DISK LOST job-2 : false`） |
| R3-B3 cron | 1（同 B-2） | 同上；B-4（空白名）/B-5（DST 静默丢触发）已另派（B-5 定调"如实跳过 + 改注释 + 让跳过可观测"） |
| R3-C 门禁完整性 | 15（C-1/C-3/C-4/C-7 + CI-C1~C3 + P-1 + G-1/G-2/G-8 + W-1~W-5） | **全部已修**：CI 面 7 条 + 中等守卫 3 条 + 打包 P-1（`51e37828e0`）+ C-1/C-2/C-5/C-8/C-9（`8844d42963`/`898fecb98e`/`0b42da1088`/`c6be2b42bd`）+ W-1~W-5（`a910bf9f19`）及其 CI 接线（`70360f5a33`）；每条都有独立复审（§7.37） |

**同轮独立复核（修复方不得自证）**：**provider PUT 原子化（`0dd74681b7`）⇒ 总判"修复成立"**（`temp/verify-put-r3/VERIFY.md`，358 行：事务边界 `Begin→UpdateGatewayProviderTx→SyncProviderModelsTx→tx 读快照→AuditLogTx→Commit`、15 条 return 逐条核对、事务开始后 5 条错误分支**全部回滚**、事务内零出网；契约面动作名与明细串逐字未变、审计链可混排；新用例在父提交上**必红**且红在"provider 行 + 密钥已落库"；13 条自写边界用例修复态 13/13 绿、其中 4 条在父提交上红；包级 `llmgateway` ok 369.5s、`serverstore` ok 202.1s）。技能库两提交 ⇒ `4f49f31237` 成立、`920c62f02a` 部分成立（三个口子已派修）；provider PUT 原子化 ⇒ 独立复审进行中；connectors 死授权 ⇒ 用**审计方自己的探针**复跑得 `VERDICT: not reproduced`（修复前 REPRODUCED）。

**已落地的修复（第三轮窗口内）**：`7e7ac1c27d`（建流失败不再遗留回调服务器与定时器）、`4b8d808fa9`（设备码定义缺验证地址 fail-loud）、`28e2062e38`（死授权按账号记账）、`8f8e88c7aa`（真实适配器 `stop` 透传）、`eb981016cb`（cron 封笔）、`f4a9a7774b`（市场归档端点）、`0dd74681b7`（provider PUT 事务化）、`1305dcf450`（迁移区间守卫 fail-loud）、`d6a891f1b4`/`30b5c85c82`/`ca5a7c3e56`（文档与数字真值 + 新守卫）、`920c62f02a`（内容同一性采纳）、`4f49f31237`（随包同步闸门 + 渠道互斥）、`2f6eda18a1`（4 条根守卫 fail-loud：空扫描面/缺失输入不再静默通过；含 `check-patch-pin` 那条**从未执行过**的断言）、`322be5186d`（integration-tests 两条不可达断言改为有判别力 + 缺环境显式 `exit 77`）、`812f539923`（集成测试判据自检 + 假网关正反例接入门禁）、`d73a421bfe`（编排器 GUARDS 登记 `check:integration-tests`）、`8f07fcd1ff`（账户浮层补齐 ARIA 契约，一次 Esc 只关一层）、`aea28fbae1`（中等守卫三条假绿：零字节补丁/丢整段/glitchtip 自测不驱动 ssh 与容器判定；并自行发现并修掉「容器不可达只打 UNKNOWN 却 exit 0」这条同族 fail-open）、`ec0121f543`（webadmin 审计 sink 白名单补 `AuditLogTx`，修 provider PUT 事务化引入的跨面真红）、`579e8e6bc5`/`579b785923`/`89026689ba`/`ac9e7e2c60`/`0027bfef2f`（**R3-A 的 A-2/A-1/A-11/A-10/A-6+A-7**：A-2 预检补归属校验、非归属人**404 且与 owner-only 读面逐字节同形**、不再继承/回显他人配置；A-1 枚举并收敛"宿主→guest 全部返回路径"到**唯一写出口**（源码级守卫钉住）+ 三层桥（≤帧原样 / `db.query` 按**编码后**字节丢尾行并标 `Truncated` / 其余结构化错误），生产者侧 `SQLMaxResultBytes` 8 MiB → **172032** 与帧预算同源；A-11 省略 `enabled` 即保持现值（顺带把"不存在"从静默/500 修成 404）；A-10 版本比较**把 `wasmapp/registry` 委托给唯一实现**（`util.CompareSemVer`）并按 SemVer §11 纠正（认账 `1.0.0-rc10 < 1.0.0-rc2` 的行为变更）；**注意口径（第四轮 R4-D-1 复核）**：这只收编了 registry 一个调用点 —— 全仓实测仍有 **6 份**版本先后实现（Go 4：`util`/`updatecheck`/`skillmanifest`/registry；TS 2：`enterprise/version-compare.ts`、`desktop/updates.ts`），其中客户端那份**就是被废弃的旧 tokenizer** ⇒ 双端结论分叉（`rc10` vs `rc2`：Go −1 / 客户端 +1，会把降级当升级）。已作为第四轮 P1 派修（共享语料 + 跨端对拍），详见 §7.38。A-6/A-7 口径统一为"**保证可交付 168 KiB**、1 MiB 只是原始字节帧上限"并让跨端对拍真钉两个数；8 变异全红、32 包 `go test` EXIT=0、客户端 24 文件/311 用例绿）、`a910bf9f19`（**WASM 门禁面 W-1~W-5**：删除面/扫描面按**清单 + 结构指纹**判定（树移出扫描面 ⇒ 红）、route-parity 缺一端 fail-loud、桶上限**真源移入仓内 JSON**（`BUDGET=999` 之类 env 不再能把红翻绿）、判定脚本三段退出码（前置缺失 = 2 而不是通过）、**全组 SKIP 即失败**；五条都在隔离副本复现「修前假绿 → 修后必红」，另补了 `tests/` 目录洞；**`corepack yarn check` 31/31、0 失败、0 跳过（334.6s）**；W-4/W-5 的 CI 接线按拍板未动 `.github`，已另行派工）、`51e37828e0`（**打包泳道 P-1**：`REQUIRED_PACKAGED_RUNTIME_ENTRIES` 改为**反向 oracle**（从包声明的入口面 + 产物里真实的 `@picoaide/*` specifier 推导期望面，不看清单）+ **每包计数棘轮**（不读产物 ⇒ CI 干净检出同样成立）；并**顺带抓出并补齐 8 条此前不在任何一张表里的真实缺口** —— 其中 `dsh-browser/lib/guard.js` 缺失会导致打包版**启动期 `ERR_MODULE_NOT_FOUND`**；删一条清单条目的变异：修复前 `78 passed / EXIT=0`（假绿）→ 修复后 `24 failed / EXIT=1`；真 asar 的 afterPack 路径同样由红变绿；包级 97 文件/1106 用例 EXIT=0）、`048cc554de`/`ef4e1ba22c`（**W-4/W-5 接线**：`go test -json` 落盘 + `check-go-test-json.mjs --scope internal/wasmapp,internal/router --require <三条>`，与 Gate job 的 `WASM_GATE_REQUIRE_COVERED_PLATFORM=1 … --groups 6`；新增 `[SK-12]` 十项静态判据（含"锚点用文件名 `ci.yml` 而非内容"——内容锚点会随接线一起消失）+ `verify-ci-scripts` §1d 行为回归（范围外 skip 不影响结论、范围内 skip 必红、少一条关键用例必红）；10 个变异全红。**关键判断：W-4 不能按"整份报告零用例级 skip"接** —— 全仓 83 处 `t.Skip*`，其中 `serverstore` 的"本机时区无夏令时"在 UTC runner 上**必然 skip**，原样接会每次必红（假红的下场通常是判据被关掉），故改为"同一条判据 + 显式范围"；`--scope` 缺省行为不变（组 3 不受影响）且前缀不得带尾斜杠（`internal/router/` 会漏掉根包 65 个事件）。实测 scoped `go test` 4m29s EXIT=0、6454 事件、用例级 pass 1457；全量 `yarn check` **31/31、0 失败、0 跳过（342.9s）**）、`642858f92e`/`304c8f540b`/`7545fb0ac5`（**CI 门禁面 6 条**：docs-only 也跑根守卫且新增**结构上不可跳过**的 `gate-guards` job、gate 取全历史 + 守卫侧 base 解析重写（浅克隆 ⇒ EXIT=3 而不是假绿）、新增 `[SK-8]`/`[SK-9]`/`[SK-10]`/`[SK-11]` 静态策略、两道策展发布说明检查真跑；15 条注入中 **14 条在修复前是 GREEN（真漏）**，修复后全 RED；全量 `yarn check` **31/31 EXIT=0**）、`cd1f8971c4`（cron B-4/B-5：空名判据收敛到唯一真源 + DST 缺口可观测且**不改触发时刻**）、`fa49eb7f5b`（**独立复审在用户点名区打出的三个缺口全部收口**：随包同步与安装器共用 per-name 锁、采纳写溯源后复检同一性、标记读取加类型/体积闸门）。

**冻结态实测（两次：`ed30ce6baf` 与收口批末的 `52ea7fbf54`）**

第一次（第三轮窗口内，提交 `ed30ce6baf`）：`freeze-snapshot.sh` A→门禁→B→C **三份 1918 个文件逐文件 sha256 完全一致**；`corepack yarn check` **31 个任务 / 31 通过 / 0 失败 / 0 跳过，260.4s，EXIT=0**；`cd server && make check` **EXIT=0**（`gofmt -l` 零命中、`go vet` 无输出、Go 52 包 `ok`/0 `FAIL`、webadmin 37 文件 / 626 用例全通过）。附一条环境坑：`make check` 首跑红是**环境**问题——Makefile 直接调 PATH 上的 `go`（1.26.5），而 `server/go.mod` 要 ≥1.26.6，第一道 `go vet` 就报 `go.mod requires go >= 1.26.6`；把 1.26.6 工具链 bin **前置到 PATH**（而不是只 export `GO=`）后 EXIT=0。

第二次（**收口批全部落地后**，提交 `52ea7fbf54`，脚本 `temp/round3-2026-09-23/final-gate.sh`，日志 `final-*.log` / `final-go-test.json`）：

- **冻结合法性**：A（跑前）→ 双门禁 → B（跑后）→ C（全部测试后）**三份 1943 个文件逐文件 sha256 完全一致**，期间 HEAD 未变 ⇒ 结论绑定在该提交、零写入。
- **`corepack yarn check`：31 个任务 / 31 通过 / 0 失败 / 0 跳过，209.8s，EXIT=0**（`[DEGRADED]` 7 行，全是**显式**的按设计降级声明：portable 模式范围、未提供真实渠道仓的 dry-run SKIP 及其计数、submodule gitlink 不扫内容等）。**注意 `yarn check` 不跑 Go 测试** ⇒ Go 侧的结论必须来自下面这条。
- **`cd server && make check`：EXIT=0** —— `gofmt -l cmd internal demoapps` 零命中、`go vet` 无输出、**webadmin 37 文件 / 628 用例全通过** + 构建产物。
- **Go 用例级统计**（同一门禁之外**再单跑一遍** `go test ./internal/... ./cmd/... -count=1 -p 4 -timeout 25m -json`）：**pass 3979 / fail 0 / skip 4**，包级 52 `ok` / 0 `FAIL`。4 条跳过**逐条都是设计内的显式 opt-in**（`TestMigration0028AuditCleanupOldDB`、`TestSummarizeWasmAppOpensTrendUVAcrossDSTDay`、`TestZoneNameHelperProcess`、`TestExportArchiveForE2E`），仓库自带的 `scripts/wasm/check-go-test-json.mjs` 对登记过的 opt-in 跳过判"通过"；**没有一条属于本轮被修包的功能用例**。⇒ Go 侧的准确口径是"**FAIL=0，SKIP 4（全部登记在案）**"，**不是**"SKIP=0"。
- **两条口径勘误（都是本轮实测踩出来的，写给下一轮）**：
  1. **非 `-v`/`-json` 的 `go test` 日志根本不打印被跳过的用例** ⇒ 上面第一次实测写的"0 `--- SKIP`"**不能**由普通日志得出（旧写法是错的，本轮已改成用 `-json` 事件统计；这也是"绿 = FAIL=0 且 SKIP=0"这条口径在 Go 侧必须换量具的原因）。
  2. **绝不要把 `-json` 放进 `GOFLAGS`**（本轮第一次跑就是这么干的，结果 234 个假失败）：被测试自己 shell 出去的 `go`（定位模块根 `go list -m`、构建编译子进程 `go build`）会继承 `GOFLAGS` 并同样输出 JSON ⇒ `helpers_test.go` 解析失败、编译子进程"不存在"。`-json` 只能加在**外层 `go test` 的命令行**上。
- **仍未验证（≠ 通过）**：Windows/macOS 打包与 afterPack 的反向注入、渠道真打包（本机只打过 Linux `--dir` 与 official/合成渠道）、tag 发布链与 R2、真机图形 E2E、WASM 组 3 在 CI 上的真 PG 路径（脚本侧已在本机跑绿）、`electron-builder` 真渠道打包的 asar 条目清点（本机 `ELECTRON_CACHE` 无 44.4.3）。这些没有冻结态证据，不得写成"已验证"。

**判定口径（写给下一轮的执行者）**
1. **"绿" = FAIL=0 且 SKIP=0** —— 编排器在某包失败时会**级联跳过**依赖它的包，跳过等于没验证。
2. **提交态验证**只能"主树冻结 + `temp/round3-2026-09-23/freeze-snapshot.sh` 前后两份逐文件 sha256 比对"；软链式 `git worktree` 会串到主树在途产物（已实测），结论不可信。
3. **未验证项 ≠ 通过**：整仓 `yarn check` 全量、`server/Makefile` 全量、Windows/macOS 打包与 afterPack 的反向注入、渠道真打包、R3-C 的 WASM 组 3 真 PG 路径等，均**尚未在冻结态跑过**，不得写成"已验证"。
4. **冻结必须真的冻结**：`check:wasm-client-only` 的 **HEAD 绑定判据**会在并发会话提交时把整轮判红（本批实测一次：跑动过程中 HEAD 从 `d73a421bfe` 前进到 `bbba3db4ca`… 组内 15 项判据本身全 PASS）—— 这与"全量门禁必须在冻结态跑"是同一条纪律的两个侧面。
5. **认账项**：C-10（域名白名单可自注册 + 分支保护必需评审人数为 0）需在 GitHub 仓库设置侧处置（CODEOWNERS + `required_approving_review_count ≥ 1`），代码侧无法阻止有写权限者自放行。
6. **活性（第四轮新增，来自现场 P0）**：每条 fail-closed 闸门都必须回答"**被它挡住的操作之外，是否还有一条恢复路径**"。反例即 §7.38 的编译缓存自锁：闸门本身正确（超限不放行），但它挡住了唯一的回收触发点 ⇒ 系统进入不可自愈终态。判据形态 = "阻塞理由登记表 + 未登记即红"（理由 → 自愈路径或"需运维介入 + 可行动文案"）。
7. **覆盖面（第四轮新增）**：审计"本轮刚修的判据"与"刚加的守卫"是**独立审计对象**——R4-A 的 7 条 P1 里 5 条属于这一类；同时，任何"证据只在注释/测试里"的机制都可能长期不被判据覆盖（编译缓存那条就是），把它们提成判据是每轮固定动作。
