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

### 7.39b 第五轮修复批的第二段：复审缺口 5 条 + CodeQL 面清零（同日，2026-09-24）

**为什么有第二段**：§7.39 的 22 个提交落地后，第五轮的**独立复审**（`temp/verify-r4a-fixes/`、`temp/verify-r4b-fixes/`、
`temp/verify-r4c-fixes/`、`temp/verify-r5a-fixes/`、`temp/verify-r5b-fixes/FINDINGS-lane-{b,n}.md`）在"结论全部成立"之外
又给出 5 条**边界**（N2-X1 组调度可整块静默停用、D-1 运行期判定包装可键序变形逃逸、B-N1 计数不看 `enabled`、
B-N2 徽章只有源码字符串判据、B-N3 市场归属第二表达式）。这一段就是它们的闭环，外加 CodeQL 面板清零。

**修复提交（4 个，全部带变异验证）**

| 提交 | 内容 | 关键证据 |
|---|---|---|
| `cb83fdeb78` | 组级台账对账（`GROUPS_SELECTED` ↔ 绑定文件 `group <n>` 台账行四条违规即具名 fail）+ `--self-check` 合成样本 + 接线结构判据；`electron-shots` 的 `--self-check` 与运行期**共用同一批解构绑定** | 原形态复现：摘掉接线 + 组 8 短路 ⇒ 旧漏洞形态回来（`PASS 0｜FAIL 0｜SKIP 0` + 全部通过 ✅ + EXIT=0）而同刻 `--self-check` EXIT=1 具名；真树 `--portable` EXIT=0、`--groups 6`（真 Electron + xvfb）EXIT=0 |
| `5869bc8481` | `telemetry` 计数面在 `u.IsAdmin` **之前**加 `!dist.Delivered()` 闸门（判据唯一实现 `serverstore.Distribution.Delivered()`）；能力中心市场技能/智能体的 `is_owner` 改走 `skillDists/agentDists.Of(id).OwnedBy(viewer)`；新增**真挂载** jsdom spec（`account-card/tests/capability-delisted-badge.spec.tsx`） | 下架后三种角色（含 admin）上报仍 200 但 calls 不增、重新上架立刻恢复；变异：删闸门 ⇒ 红、admin 早退挪回闸门前 ⇒ 红；徽章 spec 三条变异（`{null}`/摘说明段/`isDelistedItem` 恒 false）全红 |
| `1f47ed08a9` | 消 CodeQL 新告警两条：组 8 扫描根通配**逐段转义**（旧写法只转义 `.`，`+ ? ( ) [ ] { } \| ^ $` 原样进正则 ⇒ 通配里的元字符会让判据静默变成另一个模式）；BR-1 回归断言改**解析 URL 再比 hostname** | 组 8 实跑 EXIT=0（扫描 899 个文件、7 条 PASS）；该 spec 8/8；归因变异（去 `browser_navigate` 作用域复检 + 中和同族断言）后唯一失败的就是本断言（`expected [ 'prev-account.example' ] to not include 'prev-account.example'`），变异已还原（`runtime.ts` sha256 `1ffbdf2a…`） |
| `66fcc18e10` | 消**历史遗留**告警 `js/bad-code-sanitization` @ `e2e-foot-lane.mjs:366`（alert #106，2026-09-21 起就在 master 上）：locator 常量化 + label 走数据槽位 `globalThis.__footLaneNeedle` | 本地 CodeQL 2.26.2 单文件库复现：修前 results=1（含完整流 `JSON.stringify@187 → 模板@187 → byText('更多')@366`）→ 修后 0；行为等价对拍 13/13（两版 helper 源码行在 `vm` 模拟的 `Runtime.evaluate` 下驱动同一份假 DOM，6 个 label 选中下标修前=修后，不可见/尾空格孪生都不被选中） |

**CodeQL 面的口径（本轮新增，写给下一轮）**：PR 上新报 4 条告警（`js/incomplete-sanitization` ×1、`js/incomplete-url-substring-sanitization` ×1、
`py/clear-text-logging-sensitive-data` ×2）。前两条**改代码**消掉；后两条经**本地 CodeQL 复现**确认流向是"打印判据函数的诊断字符串列表"
（来源是判据里的 `obj.get('token')`，即 `SensitiveGetCall`），凭据变量本身从不进 `print`，且该文件只在本地/CI 手工集成场景运行、
凭据是 `integration-tests/README.md` 登记的本地容器夹具 ⇒ 按"仅用于测试"关闭并留档（留言写明理由）。**加上 `66fcc18e10`，
仓库 CodeQL open 告警从 1 条清零到 0 条**；PR 的 `CodeQL` 聚合检查由 fail 转 pass。
顺带记下这条规则的形状（以后同类告警照此判）：`js/bad-code-sanitization` 的 **source = `JSON.stringify(...)` 调用本身**，
**sink = 字符串拼接根里"在前面"的常量叶匹配 `eval\(|new Function\(|\(.*\)( )?=>` 的那个操作数** —— 所以
`(() => { … ${JSON.stringify(x)} … })()` 这种形态**必然**命中（`(() =>` 自己就匹配 `( )=>`），
"改成返回求值函数""内联到调用点"都修不掉，只有让 JSON 字面量不再落进函数形状的拼接里。

**同期的两件工程事实**：①与 `origin/master` 的 #138（asar bigint 冒烟 / 更新退避 / issue #130/#128）合并（`df2e145c3c`），
冲突三处按"两侧语义都留"解决（afterPack 接缝表变**五项**并加"第 5 项必须来自生产表"的身份断言 `682920da46`，版本比较委托与更新倒计时共存）；
②`Gate (tests + workspace build)` 在前几次运行上各红过一个**互不相同**的用例（`connectors` 的 token 过期恢复、`browser` 的 locale 复用），
本地（含 6 倍 CPU 压载）反复跑全绿、`gh run rerun --failed` 后即绿 ⇒ 判定为**跨包非确定性 flake**（诊断用的临时 `--full-output` 与
TEMP-DIAG 代码**已全部回退**，工作树零残留）；合并后同一提交的 Gate 两次运行均绿（4m49s / 5m03s）。

### 7.40 第六轮审计（2026-09-24，四路独立）：**"一个平台的绿"与"上一轮修复自身"**

**方法**：与第五轮同形（四路只读、绑提交、注入只在 `git archive` 副本、每条给最小复现与 `REPRODUCED`/`READ-ONLY` 标注），
基线 `5869bc8481` / `66fcc18e10`；四条泳道按"服务端核心 / 客户端与宿主 / 门禁与发布链 / 跨模块一致性与上轮新判据对抗"切分，
并要求每路先读 §3/§7.3/§7.37–§7.39b 与既有认账项、**不得把已知项当新发现**。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R6-A** 服务端核心 | 保留策略 / 调度器装配 / 迁移 runner / OIDC 桶 / readyz / 计费与审计链 | 0 | **2** | 2 | 4 |
| **R6-B** 客户端与宿主（跨层） | 能力中心呈现与动作 / 连接器凭据 / 冻结与解冻 / webadmin 审批 | 0 | **2** | 2 | 3 |
| **R6-C** 门禁 · CI · 发布链 · 打包 | 全部根守卫 + workflow 策略 + 发布脚本 + Makefile/文档口径 | 0 | **3** | 2 | 4 |
| **R6-D** 跨模块一致性 + 上轮判据对抗 | 三端契约对拍 / 文档真值 / 分布判据消费面 / 活性 | 0 | 0 | 2 | 2 |
| **合计** | | **0** | **7** | **8** | **13** |

**七条 P1（第六轮的主战场）**

1. **保留清理仍是整轮 all-or-nothing**（`serverstore/usage_ledger.go:452-460`/`:513-515`）：任一 `usage_<YYYYMM>` 关系 `DROP` 失败即
   `return`，而 Orphans 循环在分区循环之前 ⇒ 每个周期在同一处中止 ⇒ **保留策略永久停摆**。真 PG 两种形态：同名**视图**占名（`42809`）、
   别的对象**依赖**该分区（`2BP01`）—— 与故障无关的到期分区都留在盘上；删掉视图后同一次调用清掉 6 个。第五轮 R5-A-9 只修了
   "形态异常不阻断"，**没修"操作失败阻断其余月份"**。
2. **`reports`/`balance` 两个调度器装配零判据**（`cmd/server/main.go:296`/`:299`）：三个兄弟都有接缝 + 判据，这两个是裸调用；
   变异摘掉 `.Start(ctx)` 后 `go test ./cmd/server/` **全绿**（对照：摘掉 usage 保留那行必红）。`balance` 调度器是**唯一自动发放路径**，
   死掉 ⇒ `balance.enabled=true` 时全员 429 `BALANCE_EXHAUSTED` 且零可观测。
3. **「已下架」推断没有归属维度 ⇒ 跨账号破坏性动作**（`packages/host/enterprise/src/client/CapabilityCenterPanel.tsx:506-512`/`:549-576`）：
   技能库是**机器作用域**（`<DSH_HOME>/skills`），同机换号受支持 ⇒ 另一账号装过的商店技能被判"已被管理员下架"，并给出**删除本机那一份**的
   可达动作。第五轮之前这一格是「上传」（点了必 409、无副作用）⇒ **上一轮的修复把"误判"变成了"有后果"**（本轮"审计上轮修复自身"的直接战果）。
4. **连接器凭据只有账号维度、没有服务端（租户）维度**（`packages/host/connectors/src/store.ts:130` + `user-scope.ts:77-84` + `index.ts:1918-1952`）：
   同账号换服务端后，上一租户的密钥会被交给新租户的同名 connector id（手工 token 直接泄露；OAuth 仅在两个租户 AS 不同时被 SDK `issuer` 挡住）。
   对照：浏览器分区与 wasm 缓存**已经**按 `serverPartitionHash` 作用域化。
5. **`advisory: true` 是无判据的红→绿开关**（`scripts/check-workspaces.mjs:35`）：任何守卫标成 advisory 后，`yarn check`（必需 Gate）与
   `check-root-guards.mjs` 都不再因它失败，而"下限"判据只查"在表里"；A/B 实测 `advisory=no → EXIT 1` / `advisory=yes → EXIT 0`。
6. **"守卫失败 ⇒ Gate 红"的唯一链路是裸子串判据**（`scripts/check-workflows.mjs:1035-1038` + `ci.yml:183`）：给 `if:` 加一个合取项
   （`&& github.event_name != 'pull_request'` 之类）即永不执行，而 `check-workflows` 仍 EXIT=0（`if: false` 同形反倒会被 SK-14 咬住 ⇒
   检测手段存在、写法被放过）⇒ docs-only PR 可在根守卫全红时绿合并。
7. **发布脚本的两处完整性校验零回归覆盖**（`scripts/ci-publish-update-server.sh:226`/`:263`）：删掉 SHA256SUMS 对象校验或写指针前复检，
   `verify-ci-scripts` 仍 EXIT=0，而成功行仍宣称"上传后大小/哈希完整性校验"——`SHA256SUMS` 正是客户对拍用的那一份。

**P2/P3 重点**：迁移 runner 无文件形状自检（重复版本号 ⇒ 首启报错、**第二次启动静默漏掉一条迁移**；文件名不合规 ⇒ 静默跳过）·
OIDC 流程桶把"自身在途配额满"的 429 也计入失败预算（NAT 出口自锁 5 分钟）· 冻结行的"解冻入口"只在同一次目录加载内可达且三面文案矛盾 ·
市场渠道**没有作者面**（归属可经 `PUT /apps/:kind/:app_id/owner` 落到普通员工，而"我的"只取 org 渠道）· `readyz` 执行槽判据仍用编译期
`GlobalInstances` 而非生效 `max_instances`（复核 2026-09-21 的旧项，**两轮未修**）· `ReleaseReapClaim` 缺世代谓词 ·
`apps.enabled` 仍有 3 处就地表达式（当前与 `Delivered()` 等价，属下一漂移点）· `overdrawn_*` 零 UI 消费者 ·
`auth-gate.ts` 12 处 `decodeURIComponent` 无护栏 · `wasm-apps.ts` 路由表重复列 `availability`。

**发布链自己撞出来的 P0 级事实（与审计并行发现）**：`Desktop (macOS)` 与 `Desktop (Windows installer)` 两个 job 在**每一个** head 上都红，
报 `packaged runtime … is missing required ASAR entries: build/assistedMessages.yml`，而 Linux 绿。根因（读 app-builder-lib `fileMatcher.js`
+ 用 electron-builder 自身 `getMainFileMatchers` 做 A/B 探针确认）：全局 `build.files` 是**含正向模式**的清单，而 `build.linux.files`
（40 条全 `!`）被 `unshift` 成 `matchers[0]`，命中 `containsOnlyIgnore()` ⇒ Linux 应用根**回退成 `**/*`** 整目录收编，
**掩盖**了全局清单里漏列的 `build/assistedMessages.yml`；mac/win 走全局正向清单 ⇒ 静默丢件，直到 afterPack 才拒包。
⇒ **教训（写进判定口径）**：「一个平台绿」不能当作"清单正确"的证据，凡"平台专属配置覆盖全局配置"的开关都要有**跨平台静态判据**。

**第六轮的修复批（21 个提交，全部带变异验证与"修前形态可复现"对照）**

| 面 | 提交 | 内容 |
|---|---|---|
| 打包 | `9689f689f9` | mac/win 清单补 `build/assistedMessages.yml` + "必需项必须被 `build.files` 正向模式匹配"的静态判据 |
| 凭据 | `7770663e15` | 连接器凭据/审批台账按（账号, 服务端）隔离；历史未分域凭据 fail-closed（不读字节、不采纳、文件逐字节保留） |
| 客户端 | `71f79a514d` | 下架判据加归属维度（`localOwnership: mine/unknown`）+ auth-gate 解码守卫 + 改密错误码 + wasm-apps 路由表单条化 |
| 客户端 | `9088c6675f` | 归属缺省归一化为 `unknown`（证明不了就不出卸载）+ 两条钉子用例 |
| 服务端·保留清理 | `45ffba5124` → `6aab6f3080` | 逐关系错误隔离 + relkind 分流 + 每轮摘要；随后按**关系形态**分流：表形态先"相邻月并入 + 补账"再删，父表/带子关系跳过，错界分区"补账 + 不删 + fail-loud" |
| 服务端·调度器 | `f28a3e9b74` | reports/balance 装配接缝 + 运行可观测出口（启动/关停状态行） |
| 服务端·迁移 | `ae6fe836ab` | 迁移文件形状自检 fail-loud（每次启动都判） |
| 服务端·认证 | `ed553fc5da` | OIDC 容量拒绝走独立通道、不再吃失败预算（真实失败仍限流） |
| 服务端·可见性 | `3baafe9d54` `b5a4415bfc` `927606558f` `d86453eea4` | readyz 用生效上限；冻结行对归属人可见 + 三面文案统一；市场渠道补作者面；逐行归属判据的用例缺口补齐 |
| 门禁 | `1842fcb85e` `984028bd82` `4ec6e0efc6` `d5d28a640d` `1dbf037165` `245eb051bf` | advisory 登记制（含到期日格式，两条通道各自独立复核）；`needs-result` 逐字 + 步骤体必须真能失败；workflow 文件双向登记；Go 扫描面与 CI 同源；R2 三对象完整性校验 + 按对象名注入；electron-shots 调用点判据 |
| 发布链 | `0a46570b7b` | go-test 报告判定补"环境条件型 skip"档（消除 bwrap 用例造成的常红，用 companion 判据保住牙齿） |
| 跨泳道收口 | `c1f43561ce` | 登记 `oidc_flow_capacity` 审计标签；目录冻结归属例外的两端对拍断言 |

**第六轮复审发现项的去向**：V1 的 8 条边界 → 2 条 P1（孤儿/错界分区的金额丢失）已修 + 补判据（`45ffba5124`/`6aab6f3080`），
1 条判据缺口已补（`d86453eea4`），其余 5 条（状态行只覆盖 2/5 调度器、迁移自检是整集拒绝、容量计数暂无生产消费者、
清理未加咨询锁、§7 测试面）作为认账残余；V2 的 5 条边界 → 3 条已修（`9088c6675f`/`d5d28a640d`/`1dbf037165` + `245eb051bf`），
2 条（本机 builtin/plugin 行不受归属约束、测试面低危项）作为认账残余。**"错界尾段做不到并入后再删"**这一条按报告允许的
"补账 + 不删 + fail-loud"落地：钱不丢，但保留策略对该关系停摆、需人工修布局 —— 这条要在下一轮复核时继续盯。

**收敛判定更新**：第六轮 0 P0 / **7 P1** ⇒ **仍未达成"连续两轮零新增 P0/P1"**。逐轮计数：第一轮 6 P0+66 P1、第二轮 1+15、
第三轮 0+19、第四轮 0+8（+现场 P0）、第五轮 0+15、**第六轮 0+7**。P1 数量在下降（15→7），但**尚未出现干净轮**，
"连续两轮干净"的窗口需要第七轮（在同一冻结态上重跑同一口径）。第六轮新增的两条元教训：
①**跨平台/跨配置覆盖**（平台专属配置覆盖全局配置 ⇒ 一个平台的绿掩盖另一平台的静默丢件）；
②**上一轮修复自身的回归面**（R6-B-1 的破坏性动作是第五轮修复引入的，与第三、四、五轮同款 —— 这条已连续三轮被验证为最高价值的审计角度）。

**第七轮（同日）**：0 P0 / **4 P1** ⇒ 仍未收敛。逐轮计数更新为：第一轮 6 P0+66 P1、第二轮 1+15、第三轮 0+19、第四轮 0+8（+现场 P0）、第五轮 0+15、第六轮 0+7、**第七轮 0+4**。P1 数量继续下降（15→7→4），但**四条里三条是上一轮修复自身的回归面**，说明「修完之后再独立审一遍」这个动作不可省；按口径，「连续两轮干净」需要第八轮（在同一冻结态上重跑同一口径），且第八轮必须把「第七轮修复自身」列为固定审计对象。

**第六轮修复批的独立复审（两名独立代理，修复方不得自证）**

- **V1（服务端，`temp/verify-r6-server/VERIFY.md`）**：8 个提交逐条判定 —— **7 条成立**（保留清理逐关系隔离、调度器装配接缝、
  迁移形状自检、OIDC 容量拒绝分流、readyz 生效上限、冻结行归属例外、跨泳道收口），**1 条部分成立**（市场作者面：修复本体正确，
  但"去掉逐行 `OwnedBy`"的变异在既有用例下**存活** —— 非归属人夹具都拥有 0 个应用 ⇒ 前置闸门短路、逐行判据一次都没执行；
  复审的探针还实证了它会**真的扩面**），并给出 8 条新边界，其中 **2 条已实证为静默金额丢失**（正是 R6-A 自认"未构造探针"的两条）：
  ①孤儿关系（含 `relkind='p'` 的分区父表）被直接 DROP ⇒ 绕过补账、账本行数与真分区对照不一致（0 vs 1）；
  ②错界分区被 DROP ⇒ 相邻北京月前 8 小时在聚合里永久少计（`11.00 → 1.00`）。
- **V2（客户端/门禁/打包，`temp/verify-r6-client-infra/VERIFY.md`）**：6 个提交**全部成立**、零虚报、未发现"把断言改弱"
  （27 条实跑变异 + 2 条原审计探针反向复跑：连接器凭据隔离 5/5 变异红、父提交 A/B 3 条红；打包清单判据在父提交上必红；
  R2 三对象与 workflow 双向登记各 4–5 类变异全红），并给出 5 条边界：`mergeItems` 的 `localOwnership` 缺省方向无判据、
  `ADVISORY_REGISTRY.expiresOn` 不校验格式（乱字符串可绕过"到期即失效"）、`needs-result` 不钉"步骤体真的能失败"、
  本机 builtin/plugin 行仍不受归属约束（既有行为）、两条低危测试面。
  ⇒ 两条 P1 边界 + 三条判据边界已派修复泳道；其余作为**认账残余**登记（不为绿写空转断言）。

**发布链自身撞出来的两条"常红"（与审计并行发现，均已修）**

1. **macOS/Windows 打包必红**：`build.files` 正向清单漏 `build/assistedMessages.yml`，而 `build.linux.files`（全 `!`）
   让 Linux 应用根回退 `**/*` ⇒ **Linux 的绿掩盖了 mac/win 的静默丢件**。修 `9689f689f9`（补条目 + "必需项必须被正向清单
   匹配"的静态判据），并用 electron-builder 自身 `getMainFileMatchers` 做 A/B 探针复现"修前 mac/win DROPPED、linux KEEP"；
   **CI 上 macOS 与 Windows 两个 job 随后真绿**（本机跑不了这两个平台）。
2. **`Go server` job 每轮必红（我们自己的守卫造成的）**：`scripts/wasm/check-go-test-json.mjs` 的"范围内零用例级 skip"
   规则把 `internal/wasmapp/compile` 里 **5 条需要 bwrap 的端到端用例**判死 —— GitHub runner 上没有可用 bwrap ⇒
   它们每次都 skip（失败 run 的 artifact 实测：pass 4131 / fail 0 / skip 14，其中范围内就是这 5 条）。修 `0a46570b7b`：
   新增**环境条件型**登记档，每条必须给 `requires`（缺的能力）+ `companion`（同能力面的形状判据）+ `reason`，
   且**只有 companion 在同一份报告里真的 pass 才接受该 skip** —— 于是"整包静默跳过"这类形态依旧会被抓住
   （三条反向对照：companion 不 pass / 登记项改名 / 范围内多一条未登记 skip，全部 exit 1；本机有 bwrap 时它们真跑并 pass，
   判定仍 exit 0，不制造新的"本机反而红"）。

**判定口径（本轮新增，写给下一轮）**
1. **"一个平台绿"不是"清单正确"**：凡"平台专属配置覆盖全局配置"的开关（这里：`build.<platform>.files` 覆盖 `build.files`），
   都必须配一条**跨平台静态判据**，否则被覆盖的那一侧会静默丢件直到 afterPack 才报错。
2. **守卫接线要问"这台机器上它必然跳过吗"**：把"零 skip"套到一个**在 CI 环境里必然拿不到能力**的用例集合上，等于制造常红，
   而常红的终点通常是整条判据被关掉；正确做法是**登记 + 可证伪的伴随判据**，不是放宽主规则、也不是删用例。
3. **审计"上一轮修复自身"连续三轮都是最高价值的入口**（第三轮 5/7、第五轮 R5-D 4 条、第六轮 R6-B-1 的破坏性动作）。

### 7.40b 发布前最后一段：三条"只有真跑 CI 才会暴露"的问题（2026-09-24）

第六轮修复批合并进 master 之后，tag 流水线在**第一步**就红，暴露了三类此前所有本地门禁都测不到的问题。它们不是审计发现的，
而是"把版本真的发出去"这个动作发现的 —— 记在这里，作为下一轮审计的入口。

1. **渠道仓凭据失效 ⇒ 流水线静默 128**：`scripts/ci-channels.sh` 的 `--resolve-only` 把 `git ls-remote` 的 stderr 丢进
   `/dev/null`，`set -e` 又在赋值处直接终止脚本 ⇒ CI 日志里只剩一行 `exit code 128`，人写的那句"检查 CHANNELS_REPO_TOKEN 与网络"
   **永远不会执行**。本机用无效 token 复现出**完全相同的 128**，才反推出是凭据问题（原 PAT 在 16:54 还工作、19:58 已失效）。
   修：捕获 git 的 stderr、**脱敏后**（`x-access-token:<redacted>@`）打进日志，并按症状分类（凭据被拒 / 网络或 5xx / SSH 主机键 /
   未分类）；同时给凭据形态补上**只读 deploy key（SSH）**一档（组织内私有仓读取的推荐形态：不过期、只对那一个仓），
   优先级 `CI_CHANNELS_URL` > `CHANNELS_REPO_SSH_KEY` > `CHANNELS_REPO_TOKEN`。
2. **连接器真机集成用例在 CI 上约 50% 红（本地 12/12 绿）**：`tests/audit-e2e-real-server.spec.ts` 的
   `recovers mid-session from a server-side token expiry by refreshing`，报 `SdkHttpError: Server returned 401 after re-authentication`。
   读 pinned SDK 的实现后定位：`StreamableHTTPClientTransport._send` 在 401 时走**文档化的 `authProvider.onUnauthorized()` 钩子**
   然后**只重试一次**；我们没实现该钩子 ⇒ 走 SDK 自己的 `refreshAuthorization`（模块级函数，**不在**我们的 per-id 单飞里），
   并发 401 会各自刷一次 ⇒ 启用轮换复用检测的授权服务器吊销授权、其中一个 client 的重试仍带旧令牌。
   修：实现 `onUnauthorized` —— **强制**走我们的单飞刷新（`expiresAt` 还在未来也要刷：401 是"必须刷新"的信号，不是看时钟），
   成功后 `adopt` 进 provider 的活视图；失败/无材料只记日志、不抛穿（保持 SDK 既有错误码）；回归判据=并发两次 401
   恰好一次 `refresh_token` 授权且 `revokedRefreshReuse === 0`。
3. **"零用例级 skip"的判据在 CI 上必然误红**：`scripts/wasm/check-go-test-json.mjs` 按 `--scope internal/wasmapp,...` 判"范围内
   任何用例级 skip 即失败"，而 `internal/wasmapp/compile` 有 5 条**需要 bwrap** 的端到端用例，GitHub runner 上没有可用 bwrap
   ⇒ 它们每次都 skip（失败 run 的 artifact 实测：pass 4131 / fail 0 / skip 14，范围内正是这 5 条）⇒ `Go server` job 从接线起
   每轮必红，而 `go test` 本身 fail=0。修：新增**环境条件型**登记档，每条必须给 `requires` + `companion`（同能力面的形状判据，
   不需要该能力）+ `reason`，且**只有 companion 在同一份报告里真的 pass 才接受该 skip** —— 于是"整包静默跳过"仍会被抓住
   （三条反向对照：companion 不 pass / 登记项改名 / 范围内多一条未登记 skip，全部 exit 1；本机有 bwrap 时它们真跑并 pass，
   判定仍 exit 0，不制造新的"本机反而红"）。

**判定口径（本轮新增）**
1. **"本地跑不出来"不等于"不是缺陷"**：这三条里有两条**只**在 CI 的时序/环境上出现（连接器并发 401、runner 无 bwrap）。
   发布链路上的问题必须**在真实流水线上验证**，本地绿不能替代；反过来，能在本地复现的形态（无效 token ⇒ 同一个 128）
   要当成"把 CI 现象搬到本地"的证据来用。
2. **守卫接线要问"这台机器上它必然跳过吗 / 它必然满足吗"**：把"零 skip"套到一个在 CI 环境里必然拿不到能力的用例集合上，
   等于制造常红，而常红的终点通常是整条判据被关掉。正确做法是**登记 + 可证伪的伴随判据**。
3. **静默的失败信息本身就是缺陷**：`2>/dev/null` + `set -e` 的组合把"凭据失效"变成"exit code 128"，让一次发布会诊花掉
   数小时。凡是"外部命令失败即中止"的分支，都必须把**脱敏后的**原始错误打进日志并给出可行动的处置分类。

### 7.41 第七轮审计（2026-09-24，四路独立）：**上一轮修复自身的回归面，四条 P1 里三条属于它**

**方法**：与第六轮同形（四路只读、绑提交 `03d55a777e`、注入只在 `git archive` 副本、每条给最小复现与 `REPRODUCED`/`READ-ONLY` 标注），
但把重心放在**上一轮刚改过的地方**：服务端保留清理的形态分流、连接器 401 续期的新接缝、发布链的凭据链、以及上一轮新增判据的覆盖面。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R7-A** 服务端核心 | 保留清理形态分流 / 调度器可观测 / 迁移形状 / OIDC 容量 / 审计与计费不变量 | 0 | **1** | 1 | 3 |
| **R7-B** 客户端与宿主 | 连接器 transport 面（生产形态！）/ 凭据作用域 / 能力中心归属 / cron/浏览器/wasm/i18n | 0 | **1** | 2 | 3 |
| **R7-C** 门禁 · CI · 发布链 · 打包 | 环境条件型 skip 档 / advisory 两通道 / needs-result 步骤体 / 渠道仓凭据链 / R2 三对象 | 0 | **1** | 3 | 4 |
| **R7-D** 跨模块一致性 + 新改动对抗 | 三端字段对拍 / 文档真值 / 对三处新改动的"最省事绕过" | 0 | **1** | 3 | 5 |
| **合计** | | **0** | **4** | **9** | **15** |

**四条 P1（三条是上一轮修复的回归面）**

1. **多级分区下孙辈叶子被判成孤儿 ⇒ 账本翻倍 + 活分区被删 + 该月写入永久失效**（R7-A，金额类）：
   `usage_ledger.go` 的 `attachedToUsage()` 只看**直接父**，`usage → usage_<YYYY> → usage_<YYYYMM>` 里孙辈叶子的直接父是 `usage_<YYYY>`
   ⇒ 落进 Orphans 桶；而孤儿补账走 `usage ∪ 孤儿` 的 **UNION ALL**（`SELECT FROM usage` 已含该子树）⇒ 同一行算两遍（探针：账本 `25.0` vs 控制组 `12.5`），
   随后又把它 **DROP**（它仍挂在 `usage` 上）⇒ 善后 `ensureUsagePartition` 报 `42P17 would overlap partition` ⇒ 该月今后每次 RecordUsage 503。
   **上一轮把"纯丢失"改成了"多计 + 仍然 DROP"**。附带 P2：孙辈叶子明细对聚合永久不可见（`present` 只认直接叶子）。
2. **连接器 401 续期在"生产传输形态"下不生效**（R7-B，已 REPRODUCED）：`renderHeaders` 把 `Authorization: Bearer <当前令牌>` **烘焙**进
   `requestInit.headers`，SDK 的 `_commonHeaders()` 先写 provider 活令牌、**再 spread `_init.headers`** ⇒ 烘焙头胜出 ⇒ 401 触发的续期**成功了**，
   但那次重试仍发旧令牌 ⇒ `401 after re-authentication`，第一次工具调用必失败，旧传输层要等同账号重注册才自愈。
   **门禁为什么没抓到**：上一批的 401 回归全部经 `openClient()` 构造，**从不传 `requestInit`** ⇒ **判据形态 ≠ 生产形态**（典型假绿）。
3. **保留下来的"唯一链路"仍可被一个字面量绕过**（R7-C）：`check-workflows.mjs` 的"步骤体必须真能失败"判据只认 `exit 0` 与裸 `exit`，
   `exit 00`（+ 死代码 `exit 1`）即可让"根守卫失败 ⇒ 必需 Gate 红"这条唯一链路被静默摘除，而 `check-workflows` 仍 EXIT=0。
4. **新加的"推荐的"SSH deploy key 形态在真实流水线上必然失败**（R7-D）：`--resolve-only` 用 `2>&1` 把 git 的 stderr 并进被 `awk` 解析的流，
   而空的 `known_hosts` + `StrictHostKeyChecking=accept-new` ⇒ openssh 首次连接**必然**往 stderr 打 `Warning: Permanently added …` ⇒ `REV=Warning:`
   ⇒ 判红在「渠道仓 pin 形状非法(值不回显)」——**完全指不到病根**，而这是刚推荐给用户的形态 ⇒ 发布 tag 零交付；`verify-ci-scripts` 对该形态零覆盖。

**P2 重点**：`check-go-test-json.mjs` 的三条登记完整性检查被 `if (caseSkips.length > 0)` 包住（零 skip 时全不执行、打印"通过 ✅"）、
`companion` 不绑包不绑能力（一条恒过的 companion 可为任意包背书）· `--allow-advisory` 在 CI 侧零判据（自称"check-workflows 会钉住"，实际只钉"步骤在跑"）·
连接器作用域哈希不归一大写/显式端口（同一服务端裂成两个作用域、连带切浏览器分区）· `TokenRefresher.force` 会被在飞的"时钟快路径"吞掉并回报 `ok`
（强制刷新零请求、hook adopt 旧死令牌、零日志）· AGENTS.md 门禁数字漂移（"三个根守卫"/"8 个包" vs 真值 15/13–14，无守卫覆盖）·
`site/.../deployment/channels.md` 仍写"CI 从渠道仓 origin/main 拉取"。

**判定口径（本轮新增，写进下一轮）**
1. **"判据形态 ≠ 生产形态"是本轮最贵的假绿**（P1-2）：回归用例必须走**产品真实调用形状**（这里：带 `requestInit.headers` 的传输），
   否则"修好了"只是修好了测试。凡是"修一个链路"的改动，回归必须覆盖该链路**在生产里的构造方式**。
2. **"上一轮修复自身的回归面"连续四轮都是最高价值入口**（第三轮 5/7、第五轮 R5-D 4 条、第六轮 R6-B-1、第七轮 4 条 P1 里 3 条）——
   每轮必须把"上一轮改过的函数/判据"列为**固定审计对象**，且要求给出"上一轮是变好了还是变坏了"的**前后对照**（本轮 P1-1 就是"纯丢失 → 多计 + 仍删"）。
3. **"推荐给用户的形态"必须先在真实环境跑通**（P1-4）：把一个只在"有 stderr 噪声就崩"的路径作为推荐方案，等于把发布风险交给用户；
   任何新增凭据/接入形态都要有"真实远端 + 真实噪声"的回归（假 ssh/git 单测不够，至少要有一条把 stderr 噪声喂进解析流的用例）。

**第七轮的修复批**（15 个文件；PR #142 → squash 合入 master `3d4306dded`，分支上逐文件落地的提交为 `ed1b80eed7`…`d21112c0d3`；每条都带"修前形态可复现 / 修后必绿"对照与变异验证）

| 发现 | 修复点（分支提交） | 判据与变异验证 |
|---|---|---|
| **P1-1** 多级分区判归属 | `server/internal/serverstore/usage_ledger.go`（`106f2593a9`）+ 新用例 `audit_r7a_retention_multilevel_test.go`（`718ec951cf`） | `attachedToUsage()` 改按 `pg_partition_root` 判**传递根**（`Partition ∧ Root=="usage"`，`LEFT JOIN pg_class root`）；新增 `assertDetachedFromUsage` 预检**fail-loud、绝不 DROP**；深后代只补账不 DETACH/DROP（`SKIP descendant partition …`，`extraSources=nil`）；聚合 `present` 传递化。**变异**：退回 `Parent=="usage"` ⇒ 两条 Multilevel 用例红（账本 `25.0000` want `12.5000`、聚合 `0.0000` want `9.7500`、`dropped detached relation usage_202607`），且第二道锁下**零金额污染、不 DROP** |
| **P1-2** 连接器生产形态续期 | `packages/host/connectors/src/index.ts`（`cc5da35e4a`）、`src/mcp-oauth-provider.ts`（`bc1011e7bb`）；回归 `audit-r7b-production-shape.spec.ts`（`1368d6183b`）、`audit-e2e-real-server.spec.ts`（`cfbe9d0e7b`）、`helpers/real-mcp-oauth-server.ts`（`4ba6a00981`）、`token-refresh.spec.ts`（`a64d1732d2`） | `renderTransportHeaders(server, credential, providerSuppliesAuthorization)` 在 provider 供令牌时**大小写不敏感地删掉烘焙的 `Authorization`**；`inflight` 改 `InflightRefresh{force,beyondClock,run}` **链式**（非并行）复用。生产形态已收编为回归（`openClient()` 带 `requestInit`）。**变异 4/4 红**：m1 不删烘焙头 ⇒ 独立端到端探针逐字复现 `Server returned 401 after re-authentication` + `deadAfterLive=1`（修复态 `0`）、m2 force 不参与复用 ⇒ 零 grant、m3/m4 ⇒ 同一单次 refresh token 出示两次 |
| **P1-3** 门禁单链路绕过 | `scripts/check-workflows.mjs`（`d2264a2d6a`） | 步骤体退出码**数值归一**（`exit 00`/`0x0`/`256`/`+0`/`"0"`/`$((0))` 一律按 0 判定）+ 可达性下限；新增 **SK-16** 禁止 workflow 可执行文本出现 `--allow-advisory`（含 step/job `env:`）；样本 u22–u28 / v1–v4 并进 `SELFTEST_EXPECTED_POLICIES` |
| **P1-4** 发布链 SSH 形态 | `scripts/ci-channels.sh`（`ed1b80eed7`）、`scripts/verify-ci-scripts.mjs`（`0f09e68261`） | `--resolve-only` **只从 stdout 取 revision**（stderr 单列、TOFU `Warning: Permanently added …` 降为 notice、git stderr 脱敏后分类回显）；临时资源改 `TEMP_PATHS` 注册表 + **单一 EXIT trap 在注册发生的 shell 里执行**（子 shell 注册曾让私钥滞留 runner）。假 `ssh`/假 `git` 正反用例 33 条 + TMPDIR 空检查 |
| **P2** 环境条件型 skip | `scripts/wasm/check-go-test-json.mjs`（`1353ab89de`） | 登记完整性检查**移出** `if (caseSkips.length > 0)`；companion **绑包**（`companionPackage`/`companionWhy`）；内建自检 s1–s9；`--scope` 未命中恢复 exit 2 |
| **P2** advisory 通道 | `scripts/check-root-guards.mjs`（`43aaccc4ac`） | 独立 `parseAdvisoryRegistry` + `isAdvisoryExpiresOn`（正则 + `Date.parse` + UTC 往返校验）；advisory 默认阻断，不再能用一条开关静音 |

**第七轮修复的独立复审**：V1（服务端 + 连接器，`temp/verify-r7-fixes/V1-server-connectors.md`）判 **P1-1、P1-2 均成立**——
自建 7 条探针 + 4 条变异全中（`internal/serverstore` 整包 EXIT=0 / 143.4s；connectors 47 文件 / 397 用例绿；
父提交上用例必红且与审计描述逐字一致）。V1 另登记 7 条新边界，已作为**第八轮的固定审计对象**：
①深层后代**永久不回收**且无 metric/readyz/管理面（每 6h 重复 SKIP）；②月名中间父表致每轮 `fold-adjacent` 失败（管理端存保留期会 500）；
③保留期内的孤儿对聚合与账本都不可见；④`rebuildLedgerForRetention:931` 附近的死代码；⑤空令牌 + `publicMcp` 窗口下声明头未删；
⑥删头按**名字** ⇒ OAuth 连接器声明的非 Bearer `Authorization`（ApiKey 形态）修后被删 = **行为变更，需产品面判定**；
⑦补丁的 `requestInit` 半**无静态判据**。

**V2（门禁 / 发布链，`temp/verify-r7-fixes/V2-gates-release.md`，375 行）**：9 条判据里 **7 条成立、1 条不成立、1 条部分成立**（全部变异在 `git archive` 副本内完成、每次变异后复核 sha256 一致；主树未改）——
- 成立：`exit 00` 类**数值归一**覆盖全部 20 个等价形态（父提交上同一变异 EXIT=0 = bug 复现）；`check-go-test-json` 的三条登记检查**脱离 skip 闸门**（真零 skip 的三份合成报告：修复树 EXIT=1 / 父提交全 EXIT=0）与 **companion 绑包**（别包 pass ⇒ 必红并点名）；`--resolve-only` 的 **stdout/stderr 分流**在真实 git 协议 + 真实 TOFU 告警下正确（父提交 `03d55a777e` 同形态 EXIT=1「pin 形状非法」= R7-D P1-1 复现）；TOFU 过滤**不吞真错误**（`Permission denied`/`Host key verification failed` 原样保留且分类正确）；临时资源在成功/失败/SIGTERM/SIGINT 下**零残留**（中间版本 `ccf64da3b9` 的子 shell 登记**真的漏过私钥**，`1a9fbe1aa7` 修掉）；脱敏三种形态（原始 userinfo / git 自剥 / 双 `@`）**零泄漏**、私钥本体 0 次出现。
- **不成立（可用静音路径，P1 ⇒ 已开修复泳道）**：F1a-② 的「步骤体必须有非零出口」判据可被 **13/15 种写法**绕过（`case …) exit 0 ;;` 两式、`time`/`command`/`builtin` 前缀、`\exit`、`exi\`+续行断词等 **7 种连注释都没认账**；根因 = `scanExitInvocations` 的边界集 `(?:^|[;&|({])` 不含 `)`、只认 `then|do|else`、按 `\n` 切语句 ⇒ 该步真 bash 退出码恒 0 而 `check-workflows` EXIT=0，「根守卫失败 ⇒ 必需 Gate 红」这条**唯一链路**可被静默摘除。
- **部分成立（可用静音路径，P1 ⇒ 已开修复泳道）**：**workflow 顶层 `env:` 完全不读** ⇒ `env: {ROOT_GUARD_FLAGS: --allow-advisory}` + `run: … $ROOT_GUARD_FLAGS` 时 `check-workflows` EXIT=0，而 argv 替身实测守卫**真收到**该旗标、干净探针实测它把已登记 advisory 守卫的失败从 EXIT=1 翻成 **EXIT=0**（**无需任何混淆**）；同族次要项：`$GITHUB_ENV` 注入与拆分字面量 `--allow-""advisory`。
- V2 另登记 11 条加固项/固有限制（含 SIGKILL 下私钥必留 = 任何 trap 都做不到、`rev` 未锚定 `$2=="HEAD"` 当前不可达、`403` 归网络桶等），并认账未验证项（未跑真 GitHub Actions、未在真 runner 上带 deploy key 跑 tag、F2 证据为合成报告）。
- **对照口径教训**：F3 的"修前对照"必须取 `03d55a777e`（与修复 HEAD 是**兄弟**线，merge-base `6e964b9323`）；取 `ccf64da3b9^`（= `69bb5b8760`）会**假绿**（那个提交本来就没这个 bug）。

**同轮认账未修**：P2-a 连接器作用域哈希不归一大写/显式端口（跨 `connectors`/`browser`/`wasm-apps-host` 三包公式 + 迁移成本 = 全部连接器需重新授权，
属产品决策，未做）。

### 7.42 第八轮审计（2026-09-24，四路独立）：**判据的两份口径 + 生产所有权装配**

**方法**：绑提交 `3d4306dded`（= 第七轮修复 squash 合入后的 master，CI 同内容全绿），代码副本 `temp/r8/tree`（`git archive`），
四路只读、注入/变异只在副本内；每路必须给可复跑探针与变异证据。范围包含**第七轮修复自身的回归面**（固定动作，连续第五轮生效）。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R8-A** 服务端核心 | 多级分区判归属的回归面（12 条探针 / 6 组变异）/ 保留清理并发 / 账本自愈窗口 / 写路径 503 | 0 | 0 | 5 | 4 |
| **R8-B** 客户端与宿主 | 连接器 401 续期（**生产所有权装配**）/ 声明头 / 产物守卫 | 0 | **1** | 2 | 0 |
| **R8-C** 门禁 · 发布链 | 第 7 轮门禁修复对抗 / 静默放过扫描 / 发布链真实性 | 0 | **2** | 6 | 4 |
| **R8-D** 跨模块证伪 | 三处修复的端到端对抗 + 独立复现他人 P1 + **门禁绕过的第二轮**（`gates-findings.md` / `replay2.sh`） | 0 | **5** | 7 | 12 |
| **合计（首发）** | | **0** | **8** | **20** | **21** |
| 另：第七轮修复的**独立复审**（V1/V2，见 §7.41 末段） | | 0 | **2** | — | — |

**十条 P1（第八轮 8 条 + 修复复审 2 条）**

1. **连接器 401 续期被自己的重注册掐断**（R8-B，P1，**确定性复现**）：续期成功后 `onRefreshed` 发
   `pico/connector-credentials-changed` ⇒ 对整条连接器**全量重注册** ⇒ `retire()` 关掉**正在重试的那条活传输**，
   而 SDK 只在同一条传输上重试一次 ⇒ 用户这次调用以 `ERR:Connection closed` 失败（探针实测 dispose 落在 t+21ms / t+36ms，
   两种端点形态都中；多 server 连接器一次续期 dispose 两条活传输）。**续期本身完全正确**（1 grant、reuse=0）—— 死的只是这次调用。
   **为什么现有回归看不见**：`audit-r7b-production-shape.spec.ts` 与 `openClient()` 都是**测试自建传输**，harness 的假 fiber
   **不持有传输** ⇒ `retire()` 的 dispose 空转（用例名却写着"同一条活着的传输自己就恢复正常"）。
   **这是"生产所有权装配"缺失导致的假绿，与第七轮 P1-2 的"判据形态 ≠ 生产形态"是同一族**（连续两轮同一根因家族）。
2. **把根守卫命令注释掉即可零执行**（R8-C + R8-D 独立复现，P1）：`ci.yml` 的 `gate-guards` 里把
   `node scripts/check-root-guards.mjs` 前加 `#`（并改成块标量 + `set -euo pipefail`）⇒ 根守卫**零执行**、`gate-guards` 恒绿、
   必需 Gate 恒绿、`check-workflows` **EXIT=0**；SK-14 的覆盖统计从「5 个被钉步骤」静默降到 4，**没有覆盖下限**。
   根因 = **两份口径**：`root-guard-runner` 的 `match` 读**去注释文本**，而 [SK-9]② 的存在性命中读**原始 `run` 文本**。
3. **收尾 `exit 1` 改成注释即可摘除唯一链路**（R8-C + R8-D 独立复现，P1）：`ci.yml:188` 的 `# exit 1` 让
   SK-9③（raw 文本）满足、`root-guard-link`（executable 文本）不再命中 ⇒ **门禁 EXIT=0 且该步真实退出码 0**；
   **整行删掉会被抓（EXIT=1），只有注释形态同时骗过两条判据**。
4. **步骤体"必须有非零出口"可被 13/15 种写法绕过**（V2 复审，P1）：`case …) exit 0 ;;` 两式、`time`/`command`/`builtin` 前缀、
   `\exit`、`exi\`+续行断词等 **7 种连注释都没认账**；根因 = `scanExitInvocations` 边界集 `(?:^|[;&|({])` 不含 `)`、
   只认 `then|do|else`、按 `\n` 切语句。
5. **workflow 顶层 `env:` 完全不读**（V2 复审，P1，**无需任何混淆**）：`env: {ROOT_GUARD_FLAGS: --allow-advisory}` +
   `run: … $ROOT_GUARD_FLAGS` ⇒ `check-workflows` EXIT=0，而 argv 替身实测守卫**真收到**该旗标、干净探针实测它把已登记
   advisory 守卫的失败从 EXIT=1 翻成 **EXIT=0**；同族：`$GITHUB_ENV` 注入与拆分字面量 `--allow-""advisory`。
6. **被钉步骤加 `--list` 即变永久绿灯空转**（R8-D-21，P1）：`node scripts/check-root-guards.mjs --list` 只打印清单**恒退 0**
   ⇒ "永不跳过"的 `gate-guards` 一步不跑也 success，必需 Gate 仍绿；反向对照：同一个 `--list` 加在 `yarn check` 上**会**被 [SK-8] 咬住
   ⇒ 缺的只是**守卫运行步自己的 argv 钉子**。
7. **`exit 1` 换成函数定义即可摘除链路**（R8-D-18，P1）：`report_guards() { echo "guards ok"; exit 1; }` ⇒ `check-workflows` **EXIT=0**
   （轨迹剥离正则 `/[\s;}]+$/` 把证明"exit 在函数体内"的 `; }` 吃掉，而函数定义本身退出 0）。
8. **加 `shell: python` + `sys.exit(0)` 即可绕过**（R8-D-19，P1）：SK-14 对非 POSIX shell **直接跳过**，且没有任何判据
   钉住被钉步骤的 shell。
9. **`check-root-guards.mjs` 的 GUARDS 只校验 `name` 不校验 `args`**（R8-D-22，P1）：`:273` 用 `package.json` 校验名字，
   `:186` 直接 `spawn('corepack', ['yarn', ...guard.args])` ⇒ 把 16 条 args 全改成 `['--version']`，输出仍是
   "16 个根守卫：16 通过"（实测 **EXIT=0 / 2.1s / 零守卫执行**）。
10. **`--require` 没有包绑定**（R8-D-23，P2 但同族）：`casePassPackages.has(name)` 只认裸用例名 ⇒ 关键用例在**别的包**里 pass
    也报"全部 pass ✅"（第 7 轮把 companion 绑了包，`--require` 漏了）。

**共同根因（本轮最重要的结构性结论）**：门禁内部存在**多份文本口径** —— 原始 `run` 文本 / 去注释后的可执行文本 / 按 shell 分类的块 ——
**各判据只看其中一份**；而被钉步骤**没有覆盖下限、没有 argv 钉子、没有 shell 钉子**。第 7 轮把"退出码的数值形态"咬死了
（20 个等价形态全红），但"换一种写法让命令/参数/解释器/收尾语句在执行视角下等价变形"这**整类**都过得去，
后果与第 7 轮修掉的那条**一模一样**（"根守卫失败 ⇒ 必需 Gate 红"被摘除）。⇒ 判据必须建立在**执行视角**上
（能被谁执行、收到什么 argv、用什么解释器、这一步是否真的可能失败），而不是建立在文本形态上。

**P2 重点（20 条中最需要处置的）**
- **凭据原文进公开日志**（R8-D-9，按铁律 0 的代价模型实为最高一档）：`redact_secrets` 的正则 `[^/[:space:]]*` **跨不过 `/`**，
  基本认证密码含 `/` 时原文进日志，而日志**主动宣称**"已脱敏；token 不会回显"（假声明比没声明更糟）；
  且 **`git clone` 路径完全没有过滤**，而 `ci.yml` 的四个**生产**调用点走的正是它 ⇒ 第七轮的门禁只补在它修过的那半边。
- **当月写入 503**（R8-A-1，收紧 V1 §4.4 的严重级）：多级布局覆盖**当前月** ⇒ 每次 `RecordUsage*` 失败 ⇒ 网关
  **503 METERING_FAILED**（fail-closed、不交付）且**无自愈** —— 不是"历史数据冻结"，是**当月对话全不可用**。
- **并发清理把良性 `42P01` 记成失败**（R8-A-2 / R8-D-1）：重叠清理轮次把"已被别人 DROP 的关系"记成失败 ⇒
  `CleanupUsageRetention` 返回非 nil ⇒ 管理端保存保留期**偶发 500**，而同一函数内的 `retentionLedgerWindow` 把
  `!probe.Exists` 当良性 ⇒ **判据不自洽**。
- **单个异常月中止整窗口账本自愈**（R8-A-5 / R8-D-2）：`ensureLedgerRelations` 首个错误即 return ⇒ 健康月也不补，只有一行日志。
- **月名中间父表**（R8-A-4）：每轮 `fold-adjacent` 失败 ⇒ 该库保留期永远保存不下（每次 500）。
- **声明形态非 Bearer 的 `Authorization` 被按名删除**（R8-B-1，第七轮行为变更）：webadmin 该区块 key placeholder
  字面就是 `Authorization`、两端校验都不拦 ⇒ 保存成功、运行时静默 401。
- **单飞只有进程内一份**（R8-D-5）：同一进程第二个 owner 立即复现 refresh token 复用（真授权服务器随即吊销授权）。
- **作用域哈希仍不归一**（R8-D-6，第七轮已认账的 P2-a）：`https://HARNESS.example.com` 与显式 `:443` 各裂一个新作用域。
- 门禁面：退出码归一的词法层仍有 5 族反例（`"exit" 0` / `\exit 0` / `command|builtin exit 0` / `eval` / **here-doc 终止词伪装成收尾 `exit 1`**）；
  `check-go-test-json` 内建自检**无完整性下限**（`selfTest(){return []}` 经全量 `verify-ci-scripts` 仍 EXIT=0）、`--scope` 未命中必须 exit 2 的契约零判据；
  **正式 tag 的渠道集可静默缩小**（删一个渠道目录 ⇒ `channels selected: 1 of 1`、EXIT=0）；同版本重发 × immutable 长缓存无 purge/无"已存在"判据。
- 发布链：`CI_CHANNELS_PIN` 的 40-hex 是**行匹配**（多行值可过）；`CI_CHANNELS_URL=" "` 遮蔽可用的 deploy key 且不打凭据形态；
  私钥在 `chmod` 前是 0644；未知 `assets.*` 键名原样进公开日志；403/404 症状误判。

**判定口径（本轮新增，写进下一轮）**
1. **同一个事实的两份口径必然分叉**（P1-2/P1-3）：`raw 文本` 与 `去注释文本` 各做一半判据 ⇒ 注释一行的绕过同时骗过两条。
   **识别判据与能力判据必须同源**：判"某步骤存在"要用**可执行**文本，"某链路真实退出码非零"要用**语义/结构**判定
   （从 `needs.<job>.result` 出发，而不是从 `exit` 字面量出发）。
2. **回归必须按"生产所有权"装配**（P1-1）：测试自建传输 ⇒ `dispose` 空转 ⇒ 用例名描述的行为在生产里不成立。
   凡"某对象被谁持有/谁负责关闭"的链路，回归必须让**生产里的持有者**持有它。
3. **脱敏必须覆盖全部调用路径与全部字符**（P2）：只在被修过的那条路径上加脱敏 = 把风险推到生产真正走的那条；
   正则要按"能跨过任意 userinfo 字符"写，且**日志里不得声明做不到的保证**。
4. **判据的严重级要按"用户面后果"定，不是按触发前提**：V1 把"多级布局"记成"冻结历史数据"，实测同一条路径**也覆盖当月** ⇒ 当月对话全不可用。
5. **门禁要有覆盖下限**（P2）：`策略 id 命中数` 必须"等于登记数"，少一个即红 —— 否则"步骤还在但能力没了"永远看得见却测不到。

**第八轮的修复批（PR #143，分支 `fix/round8-batch`）与两份独立复审**

修复按五条泳道并行（连接器 / 服务端保留期 / `check-workflows` / `check-root-guards`+`check-go-test-json` / 渠道仓脚本），每条都带"修前可复现 → 修后必绿/必红"对照与变异矩阵；集成后在本机跑：整仓根守卫 **16/16**、connectors **46 文件 / 404 用例**、desktop 产物守卫 24 例 + `tsc`、服务端真 PG 四包（`pass=1456 fail=0 skip=8`）。

**独立复审 V3-A（客户端/宿主）**：R8-B-2 **成立**（生产所有权装配下基线稳定复现 `Connection closed`、修复后 http/stdio 混合与旁路对照全绿）、R8-B-3 **成立**（亲手变异产物守卫必红）、R8-B-1 **部分成立**；另发现 **2 条本轮修复引入的用户可见回归 + 1 条修复不完整**：

- **N6（P2）**：注册期 OAuth 发现失败时那条 http 传输没有 provider、只有注册期烘焙的 bearer；把凭据变更事件窄化成"只重注册 stdio"后**没有任何路径重建它** ⇒ 令牌轮换后持续 401，而行状态仍是 `connected`（面板提示指不到病根）。
- **N1（P2）**：`renderHeaders` 把**任意头名**的空值都记进 `baked`，新规则于是把 `X-Probe-Key: ''` 这类**声明**也删了（webadmin 该区块 value placeholder 逐字写「留空自动填 Bearer <token>」，key 自由输入 ⇒ 可达；实测基线 `connected` → 修复后 `error`）。
- **N2（P2，非本轮引入）**：小写 `authorization` 声明在线上被 SDK 以 **append** 语义合成 `Bearer …, ApiKey …` ⇒ 401，而新 warn 写"声明值优先"是假事实、交付说明里的小写断言无证据。

**二次修复（`eea98cda12`）**：重建集合改为「stdio ∪ **没有 provider 的 http 传输**」（provider 在手的 http 仍完全不重建 ⇒ R8-B-2 不退化）；`baked` 收窄为"授权槽里框架合成的那一枚"；声明名大小写**归一**；warn 去重键补 `store.dir`（账号+部署）。**验收用审计方自己的探针**（`v3a-r8b2b-refresh-residual.spec.ts`）做三态对照：`origin/master` 通过（基线本来如此）/ 第一轮态失败（`liveHasProvider=false`、wire 末段 401）/ 本轮通过（`liveHasProvider=true`、wire 末段 200），连跑 5 次稳定；另加 REVERSE CONTROL 证明窄化未被回退。变异 7 条全红。

**独立复审 V3-B（门禁 + 服务端）**：门禁 **4/4 成立**（自建 **24 条**绕过形态：修复版全部非零且点名判据，其中 **17 条**在父提交上 EXIT=0；8 条拆判据变异 7 条决定性全红；凭据脱敏在"URL 尾部与 git fatal 行仍在日志里"的前置条件下零回显），服务端 **3 条成立 + 2 条部分成立** —— 后两条不是修复本体问题，而是"网关 503→200"与"管理端 500→200"这两段**端到端判据不在交付树里**（修复方自述的临时探针未进补丁）。已补为正式回归用例（`b1073149f0`，`server/internal/llmgateway/audit_r8a_retention_delivery_test.go`：HTTP 200 真交付 / 自愈后**第二次对话仍 200** / SSE 收到 `[DONE]` / 管理端保存保留期 200 且 `EffectiveRetentionMonths` 真为 2）；变异 `m11` 还暴露出"去掉子树保留判据 ⇒ PUT 回 200 但保留期内子分区已被 DROP"这类**静默删数据**，现在有判据。V3-B 另报两条 P3（`check-go-test-json` 自检下限无第二层看守、`CI_CHANNELS_PIN` 归一化放行多行值）——后者已收口（`eea98cda12`：改为在**原始值**上先拒换行/回车，三形态修前 EXIT=0 或误诊、修后全部点名，变异 3 条全红）。

**本轮的方法学增量**：修复引入的回归**同样落在"修复自己的收缩面"上**（N6 就是"窄化重注册集合"的副作用），因此**每轮修复之后必须再跑一次面向"修复面"的复审**，且复审的判据必须是**审计方自己的探针**（这次 N6 的验收就是审计方探针的三态对照，而不是修复方新写的用例）。

### 7.43 第九轮审计（2026-09-24，四路独立）：**"执行视角"再往前一步 = 进程环境层；以及"修复把偶然保护拿掉"**

**方法**：绑提交 `06331a4884`（= 第八轮修复批合入后的 master），四路只读、变异只在 `git archive` 副本内；本轮固定覆盖"上一轮刚改过的函数/判据"（连续第六轮成立的最有价值入口）。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R9-A** 客户端与宿主 | 第八轮连接器修复的回归面（重注册集合/来源记账/大小写归一/warn 作用域） | 0 | 0 | 3 | 2 |
| **R9-B** 门禁 · CI · 发布链 | 第八轮门禁重写的假红与剩余绕过 / 发布链真实性 | 0 | **5** | 1 | 13 |
| **R9-C** 服务端 | 建分区新路径 / 良性归类 / 无条件聚合 / 子树保留 / readyz / 并发 | 0 | **1** | 2 | 2 |
| **R9-D** 跨模块证伪 | 三处修复的端到端对抗 + 独立复核 + 行为变更清单 | **1** | **8** | 9 | 6 |
| **合计（去重后）** | | **1** | **9** | **13** | **22** |

**一条 P0（服务端，可由受支持的运维动作触发）**：管理员执行 `ALTER TABLE usage DETACH PARTITION usage_<YYYY>` 之后，子树里仍在保留期内的**同名孤儿叶子**会被 `probeUsagePartition` **按名字命中** ⇒ 判"根不是期望父表" ⇒ **当月每一次对话 503 `METERING_FAILED`**，而三轮清理 `err=nil / skipped=0 / failures=0`、`/readyz` 报健康 ⇒ 完全静默，只能人工 DROP 才能恢复。**父提交同样复现 ⇒ 不是第八轮回归**，但它是第八轮刚修的 R8-A-1（"当月全不可用"）的**孪生未闭面**。

**九条 P1（去重后）——按根因归三类**

1. **"修复把偶然保护拿掉"**（R9-D-01 = R9-C-3，两路独立命中）：第八轮新增的「子树仍在保留期」闸门是**读—判定—删非原子**的；判定通过后**已提交**的计量行被 `DROP TABLE` 级联删除（明细与账本双失），窗口实测 13–43 ms（自然命中 5/5）。**父提交反而没丢**：R8-A-1 未修时 `fold` 会先失败、不执行 DROP —— 那份保护是**偶然**的，第八轮修好 A-1 后责任转移到有窗口的新闸门。修法：`BEGIN; LOCK TABLE … IN ACCESS EXCLUSIVE MODE; 复检; DETACH; DROP; COMMIT;`。
2. **"声明边界 ≠ 有效边界"**（R9-C-1，第八轮回归）：`scanUsagePartitions` 只按**声明边界**判"窗口已被后代覆盖"，而 PG 的有效约束是"声明边界 ∩ 全部祖先边界"（`CREATE … PARTITION OF` 与 `ATTACH` 都不校验包含性）⇒ 声明 `[06,08)` 挂在 `[01,07)` 下时 7 月无分区可用，而 ensure 判"已覆盖"返回 nil ⇒ 该月每次计量写入 503，日志还断言假事实 `already covered … reusing it`；base 树同形态写入成功。
3. **"执行视角再往前一步 = 进程环境层"**（R9-D-02 与 R9-B 的门禁族）：第八轮把判据从文本搬到 argv/shell/步骤体是对的，但**环境层不在判据面内** —— `NODE_OPTIONS`（含**无需任何新增文件**的 `--import=data:…` 形态）、`BASH_ENV`、`NODE_PATH`、`LD_PRELOAD` 共 6 支形态让 `check-workflows` EXIT=0，而真跑实测根守卫 job 打印「16 通过 / 0 失败」并 EXIT=0（其守卫实际在失败）。
4. 另外 6 条 P1 全在门禁面（R9-B 独立发现）：守卫运行步**只被"文本里出现脚本路径"识别**（`:` / `test -f` / `echo` 三形态让 16 个根守卫零执行而 gate-guards 恒绿）；唯一链路步 `trap "$A" EXIT` 让真 bash 退出码恒 0；`shell: bash -c 'exit 0' {0}` 加在**全量门禁步**上让整条 `yarn check` 零执行；发布链 `require` 是子串匹配（R2 上传步 echo 化 ⇒ 零上传而门禁绿）；`package.json` 守卫脚本体只验形态不验指向（把正在失败的守卫换成另一个脚本后仍报 `✓`）。

**P2/P3 重点**：R9-A 三条（声明 `Authorization` 解析为空时遮蔽 provider 活令牌、provider-less + 声明了别的头导致默认 bearer 不注入、重建仍会掐断飞行中调用）+ R9-D 的连接器"provider-backed http 上其它注册期烘焙头永不刷新 ⇒ 一次轮换后**永久 401**"（**父提交自愈、第八轮变永久**）；服务端良性归类只覆盖 5 个窗口中的 2 个（并发清理一轮 4/4 路非 nil ⇒ 管理端保存保留期仍偶发 500）；`/readyz.usage_retention.configured_months` 在失败轮次读作 0 而 0 的 API 语义是"永不删除"；门禁的 3 条**新引入假红**（子 shell 收尾 `( exit 1 )`、argv 钉子把 `2>&1` 当参数、`[SK-16]` 子串匹配误伤说明文本与 `--allow-advisory-strict`）。

**本轮方法学增量**
1. **"上一轮刚改过的地方"连续第六轮是最高价值入口**，而且本轮出现了它的**新子类**："上一轮的修复把原本偶然成立的性质拿掉，改由一个**有窗口**的新判据承担"（R9-D-01/R9-C-1 都是）。⇒ 每轮复审必须对被替换掉的旧行为问一句：**它当时是判据，还是巧合？**2. **判据面的推进方向是清楚的**：文本 → 语义 → 执行视角 → **进程环境**。每加一层，都要把上一层的"等价变形"清单重新过一遍（本轮 6 支环境层形态就是第八轮 argv/shell 钉子的"再上一层"）。
3. **假 CLI/假 aws 会掩盖真实命令行契约**：Release job 的 `--body "fileb://…"` 在现代 AWS CLI 上直接 ParamValidation 失败，而仓库里的**假 aws 主动做了 `#fileb://` 兼容** ⇒ 单测永远绿、真发布必红（见 §7.44）。**假实现必须与真实现同形 —— 连"拒绝"也要同形。**

**第九轮的修复批（PR #144，分支 `fix/round9-batch`）**

五条泳道并行（发布链 / 连接器 / 门禁 / 服务端保留期与写路径 / 服务端良性归类）；集成后在本机：整仓根守卫 **16/16**、connectors **47 文件 / 413 用例**、桌面产物守卫 + `tsc` 绿、真 PG 四包（`serverstore` / `cmd/server` / `usageretention` / `llmgateway`）全绿。要点：

- **发布链**：`--body` 改纯绝对路径 + 假 aws 与真 CLI **同形拒绝**（`file://`/`fileb://` 一律 exit 252 + 同一条报文）+ 静态判据禁止前缀 + **上传前 1 字节探测**（put → 大小/SHA256 校验 → 删除），把形态/端点/校验和失败挡在 500MB 上传之前。变异矩阵 M1–M6 全红且**未修复的 base 树跑自己的门禁是 EXIT 0**（正是"mock 掩盖契约"的实证）。
- **连接器**：`Authorization` 空解析不再算"自带凭据"（并入"留空自动填 bearer"同一规则）；provider-backed http 的其它注册期烘焙头改为**每请求视图**（不重建传输 ⇒ R8-B-2 不退化，`rotations=5 configs=1 disposed=0`）；provider-less 的默认注入闸门从"整条记录为空"改为"授权槽未被非空声明占用"；`retire()` 前按端点等**非 GET 在途请求**归零（有界 5s，超时留日志后照常重建）。变异 8/8 红。
- **门禁**：新增 **[SK-17] 进程环境层**判据（被钉单元 × 三层 `env:` × `$GITHUB_ENV`/`$GITHUB_PATH`；禁 `NODE_OPTIONS`/`NODE_PATH`/`BASH_ENV`/`ENV`/`SHELLOPTS`/`BASHOPTS`/`PROMPT_COMMAND`/`PATH`/`BASH_FUNC_*`/`LD_PRELOAD`/`LD_AUDIT`，22 个合法 env 键零误伤）；守卫运行步与发布链步骤改**命令位**判据；`trap` 动态动作 fail-closed；`shell:` **整串**登记（`bash -c 'exit 0' {0}` 红）；守卫脚本**逐字登记**（+ 第二份独立登记表）。三条第八轮假红复绿（子 shell 收尾、argv 先剥重定向、SK-16 整词）。变异矩阵 21/21 + 判据自身变异 7/7。
- **服务端（保留期竞态）**：DETACH+DROP 收进一个事务，临界区 = `LOCK TABLE ONLY usage ACCESS EXCLUSIVE` → `LOCK TABLE <rel> ACCESS EXCLUSIVE`（PG 递归锁子树）→ **持锁复检** → DETACH → DROP → COMMIT；`lock_timeout=5s` 拿不到锁即 fail-loud 全回滚；复检谓词改成语义等价的 sargable 形式（20 万行子树 33.8ms → 0.6ms）。良性判据收成**唯一出口** `usageFailureIsBenignRace`（判据 = catalog 事实"关系此刻已不存在"，**42P01 但关系还在必须 fail-loud**），W5 用 `usageReclaimNotAttached` 结构化收口（良性且不 DROP）。修前 4 路并发 3 次跑分别 8/20、3/20、4/20 路非 nil ⇒ 修后 0/20、0/20、0/20。
- **服务端（当月写路径）**：同名孤儿在**单事务**里 DETACH+ATTACH 领回 `usage`（用其自身声明边界）⇒ 当月写入恢复且 DETACH 前的明细重新可见；领不回（分区父表/跨 schema/边界不可读或不覆盖/overlap）则结构化 fail-loud + 可执行 SQL + `/readyz.usage_retention.write_blocked_*`。`scanUsagePartitions`/`partitionReadyErr` 改用**有效边界（声明 ∩ 全部祖先）**；c6（假覆盖）现在建出顶层月分区并写入成功，c11（真被祖先截断）fail-loud 并点名祖先链。
- **认账未修**：R9-D-04（日账按年分片）、R9-D-06（深层后代永不回收，第八轮既有取舍）、R9-D-08（relations 计数口径）、R9-B 的 P2/P3 残余（`check-go-test-json` 自检下限仍是自报计数、`CI_CHANNELS_PIN` 归一化边界、同版本重发 × immutable 无 purge 判据等）、以及"为把 W3/W4 做成确定性判据而新增的**仅测试**注入点 `cleanupDetachedStepHook`"这一取舍需评审确认。

### 7.44 第九轮暴露的发布链阻断：`--body fileb://` 与现代 AWS CLI 不再兼容

tag `v2.8.2-beta.1` 的 Release job 在「上传版本资产」失败：`aws: [ERROR]: An error occurred (ParamValidation): Error parsing parameter '--body': Blob values must be a path to a file.`。根因是 `scripts/ci-publish-update-server.sh` 的三处 `--body "fileb://${file}"`：**用 AWS CLI 2.37.1 本地实测，`fileb://` 与 `file://` 两种前缀都被拒，纯路径正常**（相对/绝对都一样）。这条代码路径是第六/七轮新写的（v2.8.1 之前用 `aws s3 cp`），**本次 tag 是它第一次在真实发布上跑**；仓库里的假 aws 又做了 `body="${body#fileb://}"` 的宽容处理 ⇒ 单测永远绿。修复方向：改用纯绝对路径 + 假 aws 与真 CLI **同形拒绝** + 静态判据禁止这两个前缀；并要求"上传前先做一次极小对象的探测上传与校验"，把"CLI 形态/端点/校验和读回"这类失败挡在 500MB 上传之前。



### 7.45 第十轮审计（2026-09-24，四路独立 + 主控自审）：**判据面的下一层 = "执行体由谁提供"**

**方法**：绑提交 `f325817ae8`（= 第九轮修复批 `f36a9711ae` + 发布说明 PR #145 之后的 master），四路只读、变异只在 `git archive` 副本内；本轮固定覆盖"上一轮刚改过的函数/判据"，并要求回答 CHARTER 提出的核心命题：**"进程环境"之后还有没有下一层**。四路分工 = 服务端 / 客户端与宿主 / 门禁·CI·发布链（对抗性）/ 跨模块证伪（红队）；另由主控独立取证三条（下称 M-1 ~ M-3）。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R10-A** 服务端 | 保留期回收（孤儿路径/attached 路径/良性判据/锁超时） | 0 | 1 | 3 | 3 |
| **R10-B** 客户端与宿主 | 第九轮连接器修复的回归面（空 Authorization / 每请求头视图 / 授权槽闸门 / retire 等待）+ 技能随包同步 | 0 | 1 | 2 | 3 |
| **R10-C** 门禁·CI·发布链 | SK-17 的下一层 / 命令位判据 / 编排器与发布链判据面（含两条子泳道） | 0 | **6** | 8 | 10 |
| **R10-D** 跨模块证伪 | 真 PG / 真 HTTP MCP / 真 AWS CLI / 真 bash 执行语义的端到端对抗 | 0 | **2** | 2 | 3 |
| **合计（去重后）** | | **0** | **10** | **13** | **19** |

**第九轮修复的总判：方向成立、覆盖面不成立。** 真装配下打不坏的四条（发布链 `--body` 纯路径 + 假 CLI 同形拒绝 + 上传前探测；当月写路径同名孤儿单事务领回；连接器每请求头视图；attached 路径锁 → 持锁复检 → DETACH → DROP 的原子性与 55P03 全回滚）都被红队用真 CLI / 真 PG / 真 HTTP 独立复核确认；**被打坏或打坏一半的三条**与四条"判据面缺口"构成本轮 10 条 P1。

**十条 P1 —— 按根因归四类**

1. **"执行体的来路"（5 条，全部在门禁面；这是本轮对核心命题的答案）**。第九轮把判据从 argv 推进到**进程环境**，但它枚举的是**环境变量名**（黑名单 10 键 + 1 前缀）。本轮实测到五类**workflow 文本里那一行命令一个字都没改、而判据读不到真正被执行的东西**的通道：
   - **`COREPACK_HOME`**（R10-C-01）：指向一个含假 `v1/yarn/4.18.0/yarn.js`（内容 `process.exit(0)`）的目录，经 `$GITHUB_ENV` 注入"永不跳过"的根守卫 job ⇒ **端到端实跑**：`check-root-guards.mjs` 打印「16 个根守卫：16 通过、0 失败」**EXIT=0**，同一棵树诚实运行是「7 通过 9 失败」**EXIT=1**。机理：根守卫逐条 `spawn('corepack', ['yarn','run',…])`，而 `packageManager: yarn@4.18.0` **无 hash** ⇒ corepack 不校验缓存内容。
   - **`jobs.<id>.container.env`**（R10-C-02 = M-2）：Actions 的**第四层** `env:`（`grep -n container scripts/check-workflows.mjs` = 0 命中）。同键写 job 级 `env:` → EXIT=1，写 `container.env` → **EXIT=0**，而**通过行仍打印"三层 `env:` … 均已检查"**（假保证）。
   - **本地 composite action**（R10-C-03 = M-3）：`uses: ./.github/actions/<name>` 的 action 文件不在扫描面（判据扫 `.github/workflows/` 平铺 readdir），其 `run:` 里写 `NODE_OPTIONS` 进 `$GITHUB_ENV` → **EXIT=0**，且该步**被算进"被钉住的判定单元"**（单元数 10→11）—— 判据登记了一个它从不读其内容的执行体。
   - **被替换的 `yaml` 解析器**（R10-C-17）：`check-workflows.mjs` / `verify-ci-scripts.mjs` / `verify-inventories.mjs` 共用 `node_modules/yaml`；换成"只对 ≥20 KB 文档剔除被拒键名、自检样本原样保留"的补丁副本 ⇒ **判据 EXIT=0 且打印 `OK`**（对照 EXIT=1）。**判据自己的输入解释器也在判据面之外** —— 这是"判据面"递归的下一层。
   - **步骤体里的 shell 赋值**（R10-D-03）：`[SK-17]` 只判 YAML 三层 `env:` 与**前置步骤**写的 `$GITHUB_ENV`；在**被钉步骤自己的步骤体**里写一行 `export NODE_OPTIONS=…` → 判据 EXIT=0，而真执行下真守卫打印「1 项未通过」却 **EXIT=0**（`check-root-guards.mjs` 把 `process.env` 原样透传给 16 个守卫）；`BASH_ENV` 钩子形态让整步**零执行**而 EXIT=0。
2. **"第九轮只把同族两条路径中的一条收口"（2 条，服务端保留期）**。
   - **孤儿路径**（R10-A-01）：attached 路径已收进「锁 → 持锁复检 → DETACH → DROP → COMMIT」并有 `usageReclaimNotAttached` 良性分支，**孤儿路径两样都没有**（判据 `:1199` → `DROP TABLE IF EXISTS` `:1227` 之间无锁无复检）。窗口内另一执行者把该关系**重新挂回 `usage`**（生产路径 `partitions.go` 的同名孤儿 DETACH+ATTACH 领回）⇒ ①永久账本被 `usage ∪ rel` 算两遍（探针实测 cost **25.0000**，应为 12.5000）②已回到 `usage` 树下的**活分区被静默 DROP**，而整轮 `err=nil failures=0 skipped=0`。
   - **叶子窗口**（R10-D-01）：`reclaimUsagePartitionAtomically` 的持锁复检被 `if !shape.leafTable()` 门住，而**叶子月分区正是产品实际使用的布局**；`retentionBackfill` 又在临界区**之外** ⇒ `backfill → DROP` 之间提交的行被级联删除且未进账本。真 PG 3 轮：`SILENT_LOSS=5.00/6.00/4.00`，每轮 `failures=0 skipped=0`。**父提交同样丢** ⇒ 不是第九轮引入的回归，而是 §7.43「不会再出现『判无 → 并发提交 → 再删』」这句**只对非叶子成立**（对叶子，旧实现的"保护"根本不存在 ⇒ 方法论里那一问的答案是"**不是被判据替换掉的巧合，而是从未有过**"）。
   共同根因：**"判定 → 动作"之间必须无窗口，而收口只做了同族两处中的一处**。配套 P2：轮首快照 × 本轮自己的领回 ⇒ 自愈成功被记成失败（`llmgateway/admin.go` 回 500「保留清理失败」）；`lock_timeout=5s` 只罩 reclaim 事务 ⇒ 前半轮可被任一月分区的 `ACCESS EXCLUSIVE` 无界挂住（含管理端那次**同步**调用）；保护"账本不许翻倍"的 `assertDetachedFromUsage` **本身零判据覆盖**（掏空后 serverstore 全量 170s 只有审计方新探针红）。
3. **"判据问的是『解析结果是不是空串』，而不是『有没有携带凭据』"（1 条，连接器）**。`renderHeaders` 的判据是 `resolved === ''`（R10-B-01）：`Authorization: 'Bearer ${FIELD}'`（字段未填/拼错）渲染成 `'Bearer '`、以及纯空白 `'   '` / `'Bearer   '`，**都被当成"管理员自带凭据"顶掉 provider 的活令牌** ⇒ 实测 `lastWireBearer="Bearer"`、握手 401、重试再 401、行状态仍 `connected`。这正是第九轮 R9A-1 要消灭的故障形态 —— **同族修复未闭合，不是新回归**。配套 P2：头名归一化只落在授权槽（`{'x-probe-key':'A','X-Probe-Key':''}` ⇒ 线上 `x-probe-key: "A, Bearer at-…"`，逗号拼接无人能解析）；技能上传包跟随技能根符号链接把**根外**文件打进归档（实测含 `secret.txt`）。
4. **"红，但不可诊断"（2 条，门禁的诊断面）**。`check-root-guards.mjs` 的输出摘要只有「头 20 + 省略 + 尾 20」、**没有判定行扫描** ⇒ 守卫失败的判定行落中段时出现 **0 次**（runner EXIT=1）；`check-workspaces.mjs` 的 150 行判定预算会被含 `×` 的进度噪声吃满、判定行也可能落在尾窗之外 ⇒ 真 `AssertionError` 丢失。两条合起来正是"CI 红了但日志里没有失败详情"这一已登记缺陷形态的**两份口径**（`gate-guards` 恰好是 docs-only 的唯一防线）。

**P2/P3 重点**：门禁的 `defaults.run.working-directory` 与 YAML merge key（`<<: *anchor`）让三层 `env:` 全隐形；"守卫脚本逐字登记"实为**路径级**（内容掏空与同名符号链接替换都打 `✓`）；`DEPENDENTS` 与 `needs` 两张表语义脱钩（本地 `--changed` 假阴性）；`verify-check-workspaces.mjs` 对截断/`--full-output`/失败标题**零覆盖**；`--body` 判据的扫描面只覆盖 `scripts/*.sh`（workflow 内**包装函数**调用的等价上传 EXIT=0）且取值正则**大小写敏感**（`FILEB://` 等 5 形态 0 命中，而真 CLI 同样拒绝 ⇒ 假绿）；探测对象 `s3 rm` 失败时残留 `.probe-*`（5 字节）且发布 EXIT=0；`/readyz` 的 `write_blocked_action` 对非表形态给出**不可执行**的 DDL（4/10 形态）；`last_round_at` 语义变更与新字段 `configured_months_known`、以及"计量写路径现在会发 DDL 并取 `usage` ACCESS EXCLUSIVE"这条用户可见行为变更**发布说明与审计报告都未登记**；主控另记一条**门禁可信度**事实：master 的 Gate 存在"**同一棵树一红一绿**"的假红（`f36a9711ae` 的 master push run 红在 `packages/host/desktop/tests/updates.spec.ts` 的一个 `vi.waitFor` 断言上，同 commit 的 tag run 全绿；该仓库 59 处 `vi.waitFor` **零处**显式给预算，全是 vitest 缺省的 1s），且那次 master 红 run **没有被 rerun**，tag 就是在"master 红着"的状态下打出来并全绿发布的。

**本轮方法学增量**
1. **判据面的推进方向补最后一层：文本 → 语义 → 执行视角 → 进程环境 →「执行体（与判据自己的输入）由谁提供」。** 第五层的判据形态是**白名单式**的：不枚举"哪些变量会改行为"，而要求"被钉单元要执行的每一个执行体（解释器、容器、`uses:` 目标、脚本文件内容、解析器）都必须能被判据看到并可对拍"。
2. **"同族两条路径只收口一条"是比"修复引入回归"更常见的失败形态。** 本轮的 2 条服务端 P1 与 1 条连接器 P1 全是它（`cleanupDetached*` vs `reclaim*`、attached 的良性分支 vs 孤儿、授权槽 vs 其它头名）。⇒ 每轮修完一处必须问：**这条判据的同族路径还有几条？逐条点名。**
3. **判据的通过行本身是一条断言，它的文案必须由枚举结果生成。** `[SK-17]` 打印"三层 `env:` … 均已检查"而代码里只有三层枚举 ⇒ 日志成了**假保证**（比沉默更糟）。凡"覆盖面声明"都要与代码里的枚举同源。
4. **黑名单必然有下一层，白名单才有底**：第九轮已统计出"22 个合法 env 键零误伤"，那份清单就是白名单的现成语料 —— 把它从"排除项"改成"允许项"即可一次性关闭 `COREPACK_HOME`/`LD_LIBRARY_PATH`/`HOME`/`XDG_CACHE_HOME`/`GIT_CONFIG_GLOBAL`/`PYTHONSTARTUP` 这一整族。

**第十轮的修复批（六条泳道并行，按 pathspec 提交于分支 `fix/round10-batch`）**

| 泳道 | 面 | 收口内容 |
|---|---|---|
| **F1** | 门禁·执行体 | 被钉单元的 env 判据**黑名单 → 白名单**（22 键登记表 + fail-closed 大小写/空白归一）；四层 `env:` 补 `container.env`；**通过行由枚举结果生成**（层登记表唯一真源 + 双向对账）；`.github/actions/**` 全树按同一键表判 + 被钉单元 `uses:` 登记制（本地必须可解析、否则逐字登记）；新守卫 `check-guard-parser-integrity.mjs`（不依赖 yaml，对解析器文件集摘要对拍）；被钉步骤体内 `export`/前缀赋值入判据 + 运行器**清洗子进程环境**并加固退出（实测更正：`process.exit(1)` 也会被 `--import` 的退出钩子改写成 0，必须先 `removeAllListeners('exit')`） |
| **F2** | 编排器·可诊断性 | 判定行扫描抽成**唯一实现**（行首锚定 + 噪声不占预算 + 未锚到即 fail-loud + `--full-output` 真绕过）；失败块带**真实退出码/信号**；advisory 不再计入"通过"；`needs ↔ DEPENDENTS` 双向对拍（补齐 4 条缺失反向边）；守卫脚本**内容摘要**进判据（符号链接一律红）；`verify-check-workspaces` 覆盖从 266 条断言 / 14 场景增到 **409 条 / 26 个** |
| **F3** | 发布链 | `--body` 判据面扩到 workflow `run:` 块 + 判定改 **fail-closed**（只放行字面量绝对路径与可解析赋值链）；探测对象删除后必须 `head-object` **404**（失败即 fail-loud）+ EXIT trap 收口；缓存头改**逐对象**断言；假 aws 参数校验层与真 CLI 2.37.1 **逐字同形**（含 24 行真×假对拍）；裸 `s3 ls` 走脱敏库且失败可见 |
| **F4** | 服务端保留期 | 孤儿路径与 attached 路径**同形**收口（一个事务：锁 `usage` → 锁关系 → 持锁复检**归属** → **持锁补账** → DROP → COMMIT；归属已变 ⇒ 良性 deferred）；**补账移进 reclaim 临界区**（叶子窗口关闭）；锁超时按 SQLSTATE 分类为"延后"（进 `unreclaimed`、不记失败）+ 轮级 short-circuit；前半轮全部读写加等锁上界（含 `plan_cache_mode=force_custom_plan` 修掉"第 6 次执行走通用计划 ⇒ 锁全部分区"）；`failed_relations` 进机器可读面、`write_blocked_*` 只收布局错误（瞬时错误单列 `write_error_*`）、父判据改 **oid**、`write_blocked_action` 按 relkind 给可执行 DDL |
| **F5** | 客户端与宿主 | 授权槽判据从"是不是空串"改成"**有没有携带凭据**"（唯一判定点；"方案词但无参数"收窄到**登记的 11 个已知认证方案**白名单 —— 主控复核时发现首版把"任意单个 token"都判成无凭据，会让 `Authorization: <opaque>` 这类合法声明被静默抹掉，属**同型反向回归**，已回退为白名单式）；头名按 HTTP 语义归一（线上每头名一条）；技能打包对技能根与逐项落点做 `lstat`/`realpath` 断言（符号链接**拒收** fail-loud）；死字段清理、原型链判据改 `Object.hasOwn`、在途记账改票据 + 预算到期归还 |
| **F6** | 测试预算·发布说明 | 63 处等待型断言（`vi.waitFor` + `expect.poll`）全部显式引用集中预算表（逐处一行"现象"理由）+ 包级 `testTimeout: 30_000` + **AST 静态判据**（显式预算/引用集中表/≥现象下限/**等待条件不得钉死墙钟现算字段**/用例预算 ≥ 内部等待预算）；第九轮四条用户可见行为变更补进 `docs/releases/v2.8.2-beta.1.md` §七 |

**集成冻结态实测**：整仓 `corepack yarn check` **32/32 通过、0 失败、0 跳过，EXIT=0（216.8s）**；`cd server && make check` **EXIT=0**（`gofmt -l` 零命中、`go vet` 无输出、**Go 55 个包 `ok` / 0 `FAIL`**、webadmin **39 文件 / 643 用例**通过）；根守卫 **17/17**；`verify-check-workspaces` **409 条断言 / 26 场景**；`verify-ci-scripts` OK（含真 CLI 同形拒绝与逐对象断言）；`check-no-real-domains` / `check-no-leftover-mutants` / `check-migration-range` / `check-doc-claims` 全部 EXIT=0。审计方原探针逐条复跑转绿：`TestR10AOrphanReattachedInsideCleanupWindow`（账本 12.5000 而非 25.0000）、`TestR10D_T1_LeafWindow`（三轮 `SILENT_LOSS=0.00`）、`TestR10D_T2`（`hung=false elapsed=5.183s`）、连接器 `r10b-findings` 6/6 + 线上头 22/22 + 技能符号链接 5/5。

**修复批自己暴露的三条工程事实（写给下一轮）**
1. **"登记内容摘要"会形成一个跨泳道的收口点**：`check-guard-parser-integrity.mjs` 把 17 个守卫脚本的 sha256 登记在 `check-root-guards.mjs` 里，任何守卫脚本被改动都会让两条判据同时红（设计意图）。⇒ 多泳道并行改守卫时，**摘要必须在所有写者停下之后统一重算一次**（本批用 `refresh-digests.mjs` 三趟跑，规避"写自身导致差一版"）。
2. **`trap ... EXIT` 是覆盖语义**：共享脱敏库 `ci-brand-mask.sh` 也装 EXIT trap（清理含品牌串的临时文件），F3 第一版的清理 trap **从未执行过**；正确形态 = 登记渠道后安装 + `trap -p EXIT` 捕获当时的 trap 并在自己收尾里回放。**任何往这些脚本里加 EXIT trap 的改动都要照此办。**
3. **同族"修复"可能造出反向回归**：F5 首版把授权槽的"无凭据"判据写成"任意单个 RFC 7230 token"，于是 `Authorization: <opaque>` 这类合法声明会被判成无凭据而被框架 bearer 顶掉/删除 —— 与它要治的病同型、方向相反。⇒ 判据的**白名单**必须只含"确实不携带凭据"的形态（已知方案词），**不在清单里的一律按有凭据处理**。这条与第九轮方法学是同一条：**判据问的问题要问对**（"有没有凭据"≠"像不像方案词"）。

**第十轮的三条独立复审（"每条修复由另一名子代理复审 + 变异验证"）**

| 复审 | 对象 | 判定 | 新发现 |
|---|---|---|---|
| **V1** 门禁·CI·发布链 | F1/F2/F3（85 条日志 + 6 个自写探针 + `HEAD`/`BASE` 双副本对照） | F1 的 5 条与 F3 的 9 条**逐条经独立变异证明为真**；F2 的 8 条里 **7 条成立**、**C-08 不成立** | **1 P1 + 4 P3** |
| **V2** 服务端保留期 | F4（自写变异器 + 真 PG 2M 行分区） | **金额正确性成立、可用性代价不成立** | **1 P1 + 2 P2 + 2 P3** |
| **V3** 客户端·宿主·桌面 | F5/F6（真端点记录头 / 真 zip / 真 SDK 传输 / 真 vitest + 负载对照） | 六条方向**全部成立**，未发现修复引入的用户可见回归；M-1 的两类假红被独立复现 | **2 P2 + 8 P3** |

**复审打回的三条 P1（都已修，见下"第二波"）**

1. **C-08 从未接线（V1）**：`check-root-guards.mjs` 的 `summarize()` 与父提交**逐字节相同**、`grep -c formatFailureReport` = **0** —— F2 已把"判定行扫描 + 有界输出"抽成共享的唯一实现并自证，但 F1 侧从未采纳 ⇒ **根守卫（docs-only PR 的唯一防线）失败时判定行 0 次进日志**。这是**派工与集成的漏洞**：接口交付了，没人负责接线，主控也没在集成时逐条核对"声称已完成"。
2. **ANSI 让判定行全灭（主控在集成期从真实 CI 日志发现，两份复审都没列）**：PR #146 的失败 job 里编排器打印「本次输出里**一条锚定判定行都没有匹配到**」，而同一份输出里确实有 ` FAIL  tests/…` —— CI 的 vitest 输出带 ANSI（`\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m`），而锚定判据要求**行首**（仅空白之后）就是判定词；本地无 TTY ⇒ 无 ANSI ⇒ **判据"本地绿、CI 瞎"**，且它直接让每一次 CI 失败都变得不可诊断。
3. **服务端把窗口关闭的代价转成了秒级停顿（V2）**：把补账移进临界区后，`usage`（父表）的 AEX 从 57ms 涨到 **2.5s（空载逐语句 @2M 行）/ 10.9–22.0s（有并发写入）**，**并发计量 `INSERT INTO usage` 被挡同一时长**（PG 慢语句日志坐实 18866ms，`errs=0` ⇒ 不是 503 而是整段停顿）；且 20s 是**每语句**预算而补账已吃到 94%（实测持锁 22.02s > 20s）⇒ 一旦超时被归类为"延后"，该月**永久静默不回收**；`ownerChanged := assertDetachedFromUsage(...) != nil` 把"复检自身报错"当成"归属已变"⇒ 真失败被当良性吞掉。

**由 CI 实证暴露的既有真 bug（P1，非第十轮回归）**：`2c7088aabd` 的**同一 commit 两次 CI 一红一绿**，失败用例是第九轮的 R9-D-1（"重试带旧声明头 ⇒ 第二次 401 ⇒ 现场每次失败再烧一枚 refresh grant"）。G4 泳道用 `BASE`/`HEAD` 双语料对拍证明**两棵树同因同率（整套件 3 路并发下各 1/21 ≈ 4.8%）**、竞态源头**逐字节相同** ⇒ 既有竞态，被本轮的 CI 实证**暴露**（本轮对 connectors 的改动在该路径上行为等价）。机制：活头记录（围栏装进实例 `_requestInit.headers` 的那个对象）的原地更新**只从** `pico/connector-credentials-changed` 监听器进入，而它是 `void handOffLiveHeaders(...)` fire-and-forget、函数体第一件事是 `await store.readCredential(def.id)`；pinned SDK 的 401 自愈在续期 promise 落地后 **3–4ms** 就重读该记录（`_send` 递归里重新 `await this._commonHeaders()`）⇒ **这次磁盘读只要被推迟 ≥1ms，重试就重放被冻死的头**（判别性探针：给交接注入 0ms ⇒ 1×401；**≥1ms ⇒ 2×401 且实测重试头为旧值**）。**关键否证**：整体变慢**不会**翻红（pbkdf2 占满 libuv 线程池把交接推迟 319–1866ms 仍 1×401，因为重试排在同一个 FIFO 队列之后）⇒ 这是"**只推迟交接侧**"的差分停顿型竞态，也正是"本地怎么压都绿、CI 偶红"的原因；窗口（3–4ms）比一次 HTTP 路由往返回还窄，**测试侧确定性等待够不着它** ⇒ 只能修产品侧。

**第二波修复（G1–G4，与第一波同一分支同一 PR）**

| 泳道 | 收口内容 |
|---|---|
| **G1** 门禁 | C-08 **接线**（`import { formatFailureReport }`，本地 `summarize()` 整段删除；顶层代码搬进 `main()` + 入口判定，保证被 import 时零副作用）+ **运行级判据**（真 runner + 真编排器，marker 埋 200 行噪声后 ⇒ 判定行必须出现 ≥1 次）；**ANSI 归一**（`stripAnsiSequences` 覆盖 CSI/OSC/裸 ESC，**打印仍用原行**、短输出逐字原样）；判定形态补 go `--- FAIL:`/`panic:`/eslint `12:5 error`/`--reporter=json` + **混合场景有界兜底**；新增 **[SK-18]**（被钉 job/步骤的 `working-directory` 逐字登记制）与 **[SK-19]**（`<<` YAML 合并键 fail-closed）；把 w14 拆成"镜像登记"与"容器 env 键白名单"两个样本（审计原始变异由 EXIT=0 变 EXIT=1）；`COREPACK_HOME` 清洗的**离线代价**写进启动证据与失败文案 |
| **G2** 客户端·桌面 | 桌面预算静态判据的三条假绿通道（换匹配器钉死墙钟值 / 非 spec helper / `vi['waitFor']` 元素访问）全部收口，时钟钉死改"取值形态"判据 + 显式豁免注释；`${FIELD}` 模板查表改 `Object.hasOwn`（`${constructor}`/`${toString}` 曾让线上发出 `function Object() { [native code] }`）；在途记账的剪枝作用域从 **URL 收到传输实例**（同端点另一条传输的票据不再被误剪）；`it.each`/`it.skipIf`/数值形态预算进判据面；`MCP_TOOL_CALL_TIMEOUT_MS` 收成一处具名常量；包级 `testTimeout` 口径唯一化并认账代价；发布说明补 §八 |
| **G3** 服务端 | 临界区拆**三段式**：预补账（池上无锁）→ **冻结段**（`usage` AEX + `rel` AEX，只做 DETACH）→ **结算段**（`usage` AS + `rel` AEX：持锁复检归属 → 聚合 → DROP → COMMIT）。父表 AEX 从 **9.0–13.8s 收到 6–19ms**，并发计量写入最长耗时从 **9.0–14.1s 收到 0.32–0.58s**，而金额窗口仍关闭（冻结点 = DETACH 提交；再领回要 `rel` 的 AEX，被结算段挡住）；预算改为**按行数推导**（`base 15s + 20µs/行`，下限 30s/上限 180s）+ 结算段 ctx 总上界；"延后"改**有界**（同一关系连续 5 轮延后升级为可见告警）；`/readyz` 新增 `deferred_streak`/`max_deferred_streak`/`deferred_relations`/`last_deferred_at`/`deferred_stalled`/`stalled_relations`（键序与尾 `\n` 契约未动）；归属复检改**三态**（`unknown` 一律 fail-loud，只有 `attached` 才走良性 deferred）；N5 在 `f325817ae8` 与 HEAD 双语料对拍判"既有" |
| **G4** 连接器竞态 | 在 `TokenRefresher` 的 `onRefreshed(id, tokens, persisted)` 里用**刚落盘的凭据同步**调 `refreshLiveHeaders` —— 交接路径上**零 await**，SDK 的 401 重试不可能再读到已被存储层抛弃的那一代；异步监听器保留兜底（重放同一次渲染是幂等的），不会把偶发变必然 |

**第二波冻结态实测**：整仓 `corepack yarn check` **32/32 通过 / 0 失败 / 0 跳过，EXIT=0**（`verify-check-workspaces` 从 409 断言 / 26 场景增到 **460 断言 / 30 场景**）；`cd server && make check` **EXIT=0**（**Go 55 包 ok / 0 FAIL**、webadmin **643 用例**）；connectors **52 文件 / 448 用例**；desktop **102 文件 / 1221 通过 + 3 跳过**；R9-D-1 修复后在 4 路并发 ×6 轮下 **24/24 绿**；`check-workflows` / `check-root-guards`（17/17）/ `check-guard-parser-integrity` / `verify-ci-scripts` / `check-no-leftover-mutants` 全 EXIT=0。

**第二波的三条独立复审（W1/W2/W3）与第三波修复**

| 复审 | 对象 | 判定 | 新发现 |
|---|---|---|---|
| **W1** 门禁 | G1（C-08 接线 / ANSI / SK-18 / SK-19 / 自检拆样） | 第二波两条 P1 **成立且判据承重**（无虚报）：真 runner + 真编排器下 marker 埋 200 行噪声后**可见**、换回本地截断即 0 次；彩色与去色判定行集合 9=9；import 零副作用；SK-18 例外不过宽、SK-19 不误伤锚点 | **1 P2 + 5 P3** |
| **W2** 客户端·桌面 | G4 竞态修法 + G2 | G4 修法**成立**：把 ≥1ms 延迟注入**生产 store 读**（单变量 `nosync` 只删那两行）⇒ 修复态 1×401 + 新头 + 调用成功，`nosync`/`parent`/`base` 在 ≥1ms **全部 2×401 + 旧头重放**；反例①（persisted 更旧）②（乱序）③（announced 过期）**打不坏** | **2 P2 + 3 P3** |
| **W3** 服务端 | G3 两段式 | **三条承重性质全部独立复现**：金额窗口六类边界**全部关闭**（DETACH 后裸 INSERT 23514；写路径 `stale detached table` fail-loud；两次聚合以结算段 UPSERT 为准，账本 17.0 不多不少；两轮连跑恰好 10.0）、父表 AEX **24ms**（自测；G3 的 6–19ms 与之同量级）、预补账是有效保险丝（DROP 失败时报表仍 ≥ 应有值） | **1 P2 + 8 P3** |

**第三波修复（H1/H2/H3）**：门禁面 6 条全修（顶层 `defaults.run.working-directory` 进登记制、顶层 `defaults` 纳入 SK-19、离线指引改成实测可执行的 `corepack install -g yarn@4.18.0` 并加文本级自检、C1（`0x9b`）CSI 整条剥离、判定形态补 11 类行首前缀**并把"栈内形态一律锚定"写进契约**、SK-18 登记作用域边界写进注释），23/23 变异全红；客户端面 4 条全修（`fields: null` 归一 + 同步刷活头包 try/catch（异常不再穿出 `onRefreshed` 断掉 `ctx.emit` 与 stdio 重注册）、独占证明与记账键**共用唯一实现** `mcpActivityKey`（判定/记账同源）、桌面判据三条假绿通道收口、理由注释口径与文字对齐）；服务端面先把 G3 提交后补的**未提交增量**核验为承重（`pg_partition_tree` 叶子字节求和，删掉即三条判据同时红），再修 W3-1（P2：**总预算 ctx 到点被记成真失败** ⇒ 并入延后分类）+ W3-2/3/4/5/8（到期月写失败可见面、单调的"最早未回收月"、`deferred_stalled` 只数**调度轮次**（避免"连点 5 次保存"造成分钟级假告警）、字段语义与文档对齐、结算段 AS 锚点对并发轮次的影响写进注释）。

**测量方法学（W3 提供，写给下一轮）**：`pg_locks` 轮询口径有 **10–19ms 量化下界**（轮询查询自身耗时，高负载下被拖到秒级）⇒ 用它量"毫秒级 AEX"只能当**上界**，G3 的 6–19ms 恰好落在这个地板上；而"让竞争者去抢 AEX"的口径**不可用** —— 实测它自己制造锁队列护航（基线量出 133ms 等待、把纯聚合饿死 31s），测量装置成为故障源。可靠做法 = **冻结段逐语句直接计时**，或用**受害者延迟分解**（W3 实测：残余 1.3s 停顿不是锁 —— 只跑池上聚合、完全没有父表 AEX 也会造成 2.8s 停顿）。

**合并与流水线（2026-09-24）**：第十轮三波修复经 PR #146 以 squash 合并为 master **`3264137997`**；PR 流水线与同 commit 的 push 流水线在重跑后**全绿**（Gate 根守卫 / Gate 测试与构建 / Go server / 三平台 Desktop / CodeQL）。**一条要记住的操作事实**：PR run 上两个 Desktop job 曾因「渠道仓 SSH 凭据被拒（`git@github.com: Permission denied (publickey)`）」而红，而**同一 commit 的 push run 全绿**；约半小时后用同一把私钥本地 `git clone` 该私有仓**成功**（部署密钥 `read_only=true`、`enabled=true` 仍在，指纹一致）⇒ 判定为**瞬时故障**，`gh run rerun --failed` 即绿。**教训**：遇到"同 commit 一红一绿"时，先分清是**代码/测试竞态**还是**凭据/网络瞬时故障** —— 本轮的连接器竞态（§7.45 上文）与这条凭据瞬断就是同一现象的两个不同根因，判据是"换个 run 是否绿"与"本地用同一凭据能否复现"。

**第十轮认账未修**（顺延，不重复计数）：R9-D-04（日账按年分片）、R9-D-06（深层后代永不回收）、R9-D-08（`relations` 计数语义）、`check-go-test-json` 自检下限仍是自报计数、同版本重发 × immutable 缓存无 purge 判据、`--scope` 子串语义、`cleanupDetachedStepHook`（仅测试注入点，R10-A-03 之后其必要性下降，待评审）、F2 的 C-16（`--changed` 零包仍 EXIT=0，已加显式告警）、F4 的裁决项（"子树仍持有保留期内行"这道前置闸门保留为**只对非叶子** —— V2 独立复验该裁决**正确**）；**第三波新认账**：`[DETACH, DROP]` 之间同名关系短暂成孤儿表（G3 §7 已认账，只影响落后一个保留期的迟到写入，产品写路径结构上不可达；彻底消除需"停车父表"），CSI 第三种引导（UTF-8 `0xC2 0x9B`）不做（注释与实现一致声明），"未登记判定形态"仍有 20/10 行**有界兜底**（兜底段不在判定段，故不构成保证），桌面调用图只覆盖 `tests/**` 内同文件与相对导入，`fields: null` 需手改/外部工具写凭据文件（低概率但已修）。

### 7.46 第十一轮审计（2026-09-25，四路独立）：**判据面的下一层是"执行体的入口"；以及"上一轮关闭的窗口仍在同族的另一条路径上"**

**方法**：绑提交 `3264137997`（= 第十轮三波修复合并后的 master），四路只读、变异只在 `git archive` 副本内；固定覆盖"上一轮刚改过的地方"，并要求回答"执行体由谁提供"这一层之后**还有没有下一层**。四路 = 服务端 / 客户端与宿主 / 门禁·CI·发布链（含两条子泳道）/ 跨模块证伪。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R11-A** 服务端 | 两段式回收的窗口/预算/有界性/readyz 面 | 0 | 1 | 3 | 2 |
| **R11-B** 客户端与宿主 | 连接器六信号源偏序、桌面 AST 判据、打包面 | 0 | 1 | 1 | 2 |
| **R11-C** 门禁·CI·发布链 | 执行体入口 / 白名单 / 判据自身（含 C2/C3 子泳道） | **1** | **4** | 8 | 12 |
| **R11-D** 跨模块证伪 | 真 PG / 真 CLI / 真 bash 的端到端对抗 + 四条独立复核 | 0 | 1 | 3 | 3 |
| **合计（去重后）** | | **1** | **6** | **15** | **20** |

**那条 P0：执行体的"入口"仍是开着的。** 第十轮把判据面推进到"执行体由谁提供"（解释器/容器/`uses:` 内容/判据依赖的解析器/步骤体内的 shell 赋值），但**入口本身**没管：`.yarnrc.yml` 里加一个 yarn 插件（实现 `wrapScriptExecution`，往每个被 spawn 的脚本环境塞 `NODE_OPTIONS`/`BASH_ENV`）——注入发生在 **yarn 进程内部**，在根守卫的环境清洗**之后**。实测：workflow 一字未改的前提下，`corepack yarn check` **EXIT 1→0**（通过行是"32 通过、0 失败、0 跳过"），"永不跳过"的 `check-root-guards` 从 `3 通过/14 失败`(EXIT=1) 变成 `17 通过/0 失败`(**EXIT=0**)；`yarnPath` 换掉 yarn 本身同理（`.gitignore` 里已有 `!.yarn/plugins` 反向规则 ⇒ 该文件**可提交**）。⇒ 判据面推进的下一层不是"还有什么注入点"，而是**"谁来启动判据"**：只要判据是被一个"可以被仓库内文件改写的启动器"拉起来的，前面所有层的加固都可以被一次绕过。

**六条 P1（去重后）**
1. **门禁入口**（上条，P0 与其孪生的 `yarnPath` 通道合为一条修复面）。
2. **install 期代码执行**：根 `package.json` 的 `postinstall` 在 `enableScripts: false` 下**仍然执行**（YN0007 实测），而 CI 的 `yarn install --immutable` 排在根守卫**之前** ⇒ install 期即可改写守卫脚本**并顺手改掉内容摘要登记值**（端到端实测：内容判据由 EXIT=1 翻回 EXIT=0）——**判据自己维护的登记值，不能成为判据的唯一锚**。
3. **环境清洗只覆盖两个 runner 中的一个**：`check-workspaces.mjs` 仍用 `{...process.env}` ⇒ 同一条 `NODE_OPTIONS` 注入在 `yarn check` 路径仍 EXIT 1→0（第十轮只改了 `check-root-guards.mjs`）。**"同族路径只收口一条"在第十一轮再次出现**。
4. **`with:` 输入完全不在判据面**：`uses:` 只登记 action 名，8/8 条 `with:` 变异 EXIT=0（`checkout` 的 `repository`/`ref`/`token`/`sparse-checkout`、`setup-node` 的 `node-version:8`、`cache` 的 `path`/`key`）——同一步的 `fetch-depth` 反而有专门判据。
5. **发布正文来源未受约束**：`--notes "$(git log -1 --format=%B)"` 让公开 Release 正文来自**未评审文本**，而 `check-workflows` 与 `verify-ci-scripts` **都 EXIT=0**（公开仓的正文一旦发布不可撤回，这是与铁律 0 同一量级的面）。
6. **两处"上一轮关闭的窗口仍在同族路径上"**：
   - **服务端**：第十轮把补账移进临界区关闭了"叶子窗口"，但**补账窗口本身是在冻结之前算定的**（结算段不重算）⇒ 被回收关系的声明边界宽于名义月且**覆盖当月**、扫描时当月尚无行时，`[窗口算定, 冻结]` 之间提交的当月计量行**既不进账本又被 DROP**：探针 `SILENT_LOSS=7.0000`，而该轮 `cleared=5/skipped=0/failures=0`、`/readyz` 全绿 ⇒ **§7.45 里"金额窗口六类边界全部关闭"这句话不成立**（V2/W3 的两轮独立复核都只覆盖了它们构造的那六类边界）。
   - **客户端**：第十轮 G4 用"`onRefreshed` 里零 await 刷活头"关掉了**带外刷新**的竞态，但**注册期**没有对应追赶（`adoptLatestRefresh` 只喂 provider、不喂活头记录）⇒ 刷新落在注册窗口时声明式自动填 bearer 的头停在被替换的令牌上，2×401、注册失败，而 `restoreAll` 仍写 `connected`（真端点记录）。

**修复批（四条泳道，PR #147）**：门禁执行体（守卫**不经 yarn** 启动 + `.yarnrc.yml`/生命周期钩子进登记制 + 摘要**锚到 git 对象** + 清洗收敛为唯一实现）、workflow 判据面（`with:` 白名单登记 + `runs-on` 登记 + `.github/actions/**` 只判被引用的 + **发布正文必须可证明来自 `docs/releases/<tag>.md`** + `--body` 三条绕过 + 指针 `copy-object` 原子替换 + 判定行按 CR 分段 + `VERDICT_LINE` 分支登记与样本下限）、客户端（`pendingLiveHeaders` 第二记录来源 + `refreshLiveHeaders` 单一判定/sweep；`fields` 值形态归一；等待预算契约扩到五包；AST 判据堵 4 条绕法/纠 3 条误红）、服务端（**补账窗口改在持锁区间内按关系实际 min/max 重算** ⇒ `SILENT_LOSS` 7.0 → **0.0**；统一 `search_path` 使判据与动作看同一个对象；冻结段 ctx 版 COMMIT 有界；`write_blocked_other_months` 可自愈；节奏闸门对齐调度周期；新增 `reclaim_stalled` 使"长期没回收"重启后仍可判）。

**集成冻结态实测**：整仓 `corepack yarn check` **32/32 通过 / 0 失败 / 0 跳过，EXIT=0**；`cd server && make check` **EXIT=0**（Go **55 包 ok / 0 FAIL**、webadmin **643 用例**）；审计方原载荷逐条由绿转红（`.yarnrc.yml` 插件与 `yarnPath`、install 期改写守卫 + 改登记值、两个 runner 的 `NODE_OPTIONS` 直注、8 条 `with:`、`runs-on`、`--notes "$(git log …)"`、`gh api` 写正文、`--body` 三绕过、指针残件覆盖、`\r` 判定行、10 条零判据分支）；三条第十轮承重性质复跑未回退（金额窗口六类边界 / 父表 AEX 亚秒级 `max=6ms` / 预补账保险丝）。

**本轮方法学增量**
1. **判据面的推进序列补最后一格：文本 → 语义 → 执行视角 → 进程环境 → 执行体的来路 → 执行体的入口（"谁来启动判据"）。** 前五层都在回答"被执行的东西是什么"，第六层问的是"**谁把它拉起来**"——只要启动器本身可由仓内文件改写（yarn 的 `yarnPath`/`plugins`、package manager 的生命周期钩子），前五层可以被一次绕过。
2. **"判据自己维护的登记值不能是判据的唯一锚"**：内容摘要的更新通道必须是一条**判据自己改不动**的路径（本批把它锚到 git 对象），否则"改脚本 + 改登记值"是一个两步自洽的操作。
3. **"上一轮关闭的窗口，要问它是不是只关在同族的一条路径上"**：本轮两条 P1（服务端窗口的算定时机、客户端注册期的追赶）都是这条。判据形态 = **把"窗口关闭"这句话拆成"哪一条路径、哪个时间区间、由谁持锁"三问，逐路径点名**（第十轮的"六类边界全部关闭"是因为它的边界集合来自同一个构造思路，漏掉了"声明边界宽于名义月 + 当月尚无行"这一族）。
4. **测量方法与判据集合的盲区同源**：`pg_locks` 轮询有 10–19ms 量化下界、"让竞争者抢锁"的装置会自己成为故障源（第十轮 W3 已记录）；本轮补一条——**"边界集合"本身也有盲区**：审计方构造的六类边界全部通过，不等于"窗口全关"，必须再问"还有哪一类边界没被构造"。

### 7.47 第十二轮审计（2026-09-25，四路独立）：**"判据的本体"与"判据的启动"之间还有一条缝；以及"判据被自己的语料蒙中"**

**方法**：绑提交 `12540e681c`（= 第十一轮修复合并后的 master），四路只读、变异只在 `git archive` 副本内；固定覆盖"上一轮刚改过的地方"。四路 = 服务端 / 客户端与宿主 / 门禁·CI·发布链（对抗性）/ 跨模块证伪。

| 路 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R12-A** 服务端 | 补账窗口的新边界集合 / `search_path` 全族 / 有界性 / `reclaim_stalled` 语义 | 0 | **4** | 2 | 1 |
| **R12-B** 客户端与宿主 | 活头记录链 / `fields` 归一 / 发现面契约 / 打包面 | 0 | 0 | 1 | 3 |
| **R12-C** 门禁·CI·发布链 | 执行体入口 / 判定权 / 凭据可信度 / 判据自身 | **2** | 2 | 3 | 1 |
| **R12-D** 跨模块证伪 | 真 yarn / 真 PG / 真 CI 输出形态的端到端对抗 + 四条独立复核 | **1** | 1 | 3 | 1 |
| **合计（去重后）** | | **2** | **7** | **8** | **6** |

**两条 P0（同一个主题的两面：判据的"本体"与"启动"之间还有一条缝）**
1. **判据本体会在 install 期被改写**（R12-D-01）：`.github/workflows/ci.yml` 的 `yarn install --immutable` 会让 `.yarnrc.yml` 的 `plugins:` **顶层模块代码在 yarn 启动期执行**（真 yarn 4.18.0：`yarn --version` 就会执行）。该插件把 **11 个 `scripts/check-*.mjs`（2 万行）改写成 22 行"打印通过凭据 + `process.exit(0)`"**，于是 ci.yml 一字未改，三个逐字提取的判定块**全部 EXIT=0** 并打出"17/17 通过""32/32 通过""锚定严格"。**第十一轮"执行体入口闭合"的声明因此不成立**（不是回归，是没闭合）。放大点：**锚定判据自己就在被锚定的集合里** —— 只改 `check-root-guards.mjs` 会被 `--require-clean` 抓住，**同时**改 `check-guard-parser-integrity.mjs` 就 EXIT=0（自证）。
2. **workflow/job 级 `defaults.run.shell` 不在判据面**（R12-C-P0-1）：第十一轮只做了**步骤级** `shell:` 的整串判据；在 ci.yml 顶层加一块 `defaults: {run: {shell: …}}` 即可接管 4 个被钉 `run` 步（它们都没有步骤级 `shell:`），包装后 STEP EXIT=0、日志里只有伪造凭据，而**逐字**的两条断言跑在伪造日志上全 PASS。

**七条 P1**
1. **工作区包的 `postinstall` 是未登记的 install 期执行通道**（R12-D-02）：登记判据只读根 manifest；真 yarn 在 `enableScripts: false` 下照样执行工作区钩子（同一判据：根钩子 EXIT=1、工作区钩子 EXIT=0）。**又是"同族只收口一条"。**
2. **`--require-clean` 步不在被钉步骤表里**（R12-C-P1-1/D-04）：删该步 / 去掉旗标 / `if: false` / 改成 docs-only 条件 —— 四种变异 `check-workflows` **全 EXIT=0**（唯一"工作树↔HEAD"硬判据可被静默降级为本地告警）。
3. **两条通过凭据的断言块本身没有静态判据**（R12-C-P1-2）：删块 / 换注释 / `exit 1`→`true` / 步骤体里 `grep() { return 0; }` / 断言前向 tee 目标追加伪造行 —— **全部 EXIT=0**。
4. **`reclaim_stalled` 度量的是"月龄"而不是"停摆时长"**（R12-A-P1-01）：单轮 5s 锁竞争（下一轮自愈）就置真；而**按设计跳过**的形态（`subtree-retained`/`descendant`/`non-table`）与宽/嵌套/多级布局**两轮后仍为真** ⇒ 长期/永久假告警。
5. **`search_path` 只收口了 3 个调用点**（R12-A-P1-02）：流式结算 / `SetUsageProvider` / `DeleteUsage` / `CleanupPendingUsage`（连带余额扣费）仍走 `search_path` ⇒ shadow schema 在场时**结算把 shadow 行改成 900/300、真实 pending 永不清理**（有计费后果）。
6. **物化视图占名让该月永不回收**（R12-A-P1-03）：`LOCK TABLE <matview> … ACCESS EXCLUSIVE` 直接 42809 ⇒ 每轮 `failures=1`（管理端保存保留期 500）+ 告警位永久真；而 R11 的注释与用例都声称覆盖"视图/物化视图"。
7. **错界分区让"相邻月并入"永久失败**（R12-A-P1-04）：UTC 自然月边界 + 错界尾段行 ⇒ 两轮都 `42P17`、关系仍在、整轮返回非 nil，与代码里 R5-A-9 的明文承诺冲突（金额守恒、fail-loud）。

**一条"判据被自己的语料蒙中"的 P2（master 因此真红过）**：round-10 的 master push run `36016811100` 的根守卫 job 红在 `check:ci-scripts`，**根因不是负载**：①假 aws 的故障注入按**对象键范围**无条件生效 ⇒ 注入落在**上传阶段**的读回校验而不是"删除后的缺席检查"（错归因）；②生产脚本用**裸 `grep -q '404'`** 判"对象已消失"，而 aws 的失败信息会回显对象键，键 = `.probe-${RANDOM}${RANDOM}-$$` ⇒ **数字里凑巧出现 `404` 时，"端点不可达"被判成"对象已消失"**。实测概率 = P(键含 `404`) = **1.048%**（200 万次模拟）/ **1.0%**（400 次真链路，4 次失败，4 个键逐条含 `404`）；master 那次失败的键 `.probe-2133517404-18012` 正含 `404`。⇒ "12 次 1 红"是小样本读数，机制是确定的。

**修复批（四条泳道，PR #148）**：**M1**（注入按**调用点**：`FAKE_AWS_HEAD_ERROR_CALLPOINT=absent|present|any`，缺省 absent；生产判据改 `grep -qE '\((404|NoSuchKey)\)[[:space:]]+when calling the HeadObject operation'`；断言失败回显**失败段 + 完整 stderr + 假 aws 调用序列**；30 次计数 0 失败）、**N1**（五层：①新建 `scripts/check-install-integrity.mjs` 作为两个 job 的**第一个执行体**（早于任何 yarn/corepack，只用 `node:*` + `git`，输入全部取自 **git 对象**，校验 13 条判据执行体 + 16 个 manifest + `.yarnrc.yml` 禁键 + `.yarn/plugins|releases` 为空 + 全 manifest 无未登记 install 期钩子）；②每个判据步的探针**自己 `git show HEAD:` 取出、先比对再按 HEAD 恢复**（切断"自指"）；③摘要对拍**锚到 git 对象**（严格面=HEAD 字节、本地=工作树字节）；④工作区钩子登记制；⑤凭据从"流属性"抬成"步骤独占目录（`mkdir -m 700` + 随机名）+ 一次性 nonce + stdout/stderr 分开 + 本步检查器合成"）、**N2**（服务端六条：`reclaim_stalled` 拆成"真受阻账"（`reclaim_blocked_*`）与"按设计跳过"（`needs_manual_months`）；`search_path` 收成唯一实现并覆盖**全族**调用点；结算段按 **relkind** 分流取锁（matview 不取锁）；错界分区改"跳过 + 结构化登记 + 长期可观测"（金额不丢、整轮不再非 nil）；月初首写的建分区 DDL 改**有界 + 可观测**（`lock_timeout` + 退避 + 30s 预算 + `/readyz` 的 `write_ddl_lock_*`）；`write_blocked_other_months` 的自愈集合补上孤儿桶）、**N3**（发现面契约扩到**全部 13 个带 test 脚本的包**并加派生真源与双向对拍；扫描扩展名从 vitest `defaultInclude` **推导**；补 `already in use` 重试路径的端到端用例；发布说明补第十一轮行为变更 §九）。

**集成冻结态实测**：整仓 `corepack yarn check` **32/32 通过 / 0 失败 / 0 跳过，EXIT=0**（含 `VERDICT PASS planned=32 executed=32`）；`cd server && make check` **EXIT=0**（Go **55 包 ok / 0 FAIL**、webadmin 用例通过）；红队原载荷改前/改后 EXIT：三个 verbatim 判定块 **0 → 1**、工作区钩子 **0 → 1**、顶层 `defaults.run.shell` **0 → 1**、`if:false`/删 `--require-clean` **0 → 1**、断言块五种拆法全 **1**；`verify-ci-scripts.mjs` 30 次 0 失败（修复前 400 次 4 失败）。

**本轮方法学增量**
1. **判据面的推进序列再补一格：…… → 执行体的入口 →「判据的本体与启动之间的缝」。** 第十一轮把"谁来启动判据"收口到"守卫不经 yarn、入口进登记制"，但**判据脚本本身仍在工作树里**，而 install 期有代码执行 ⇒ 可以在判据启动前把它们换掉。收口形态 = **"判据的执行体从 git 对象取出（并先比对再恢复）"**，而不是"相信工作树里那份"。
2. **锚定集合不能包含锚定者自己**：内容摘要登记只要把"锚"也放进被锚的集合里，就退化成自证（同时改两份 ⇒ 绿）。规则：**锚必须来自判据改不动的地方**（git 对象、平台侧产物）。
3. **判据被自己的语料蒙中**（本轮新登记的假绿/假红形态）：`grep -q '404'` 判"对象已消失"，而失败信息会回显一个**随机对象键** ⇒ 1% 的键里恰好含 `404` 就"通过"。规则：**判据匹配失败信息时，必须匹配"工具自己的结构化措辞"而不是裸数字/裸词**（本例：`(404|NoSuchKey) when calling the HeadObject operation`），并且**失败回显要给足证据**（失败段 + 完整 stderr + 调用序列），否则下一次仍会错归因。
4. **"边界集合"的盲区再证一次**：R12-A 用 **10 类全新边界**（含 dblink 注入的"窗口重算后–DROP 前"真并发提交、跨年到未来日期、matview/index/sequence 占名）证明**金额侧全关**；而同批边界里有 3 类暴露的是**保留策略永久停摆**（不是金额丢失）⇒ "金额守恒"与"策略能推进"必须**分别**判。

### 7.4 收敛判定

**第八轮结论（2026-09-24）**：第八轮首发 **0 P0 / 8 P1**（1 条连接器续期被自注册掐断 + 7 条门禁可被"执行视角等价变形"绕过：两颗注释绕过、`--list` 空转、函数定义/`shell: python`/拼接旗标、GUARDS 的 args 无人校验），加上第七轮修复的独立复审新增 **2 P1**（步骤体非零出口可绕、workflow 顶层 `env:` 不读），以及**修复后复审**再发现的 **2 条用户可见回归（N6/N1）+ 1 条修复不完整（N2）** ⇒ **仍不是干净轮**；按口径"连续两轮零新增 P0/P1"需要第八、第九轮都干净，因此**必须再跑第九轮**（在第八轮修复批的冻结态上，固定覆盖"上一轮改过的函数/判据"）。第八轮的 8 条 P1 与复审发现的回归**已全部修复**（PR #143：`1e6f3bda1b` 主批 / `b1073149f0` 端到端判据补齐 / `eea98cda12` 二次收口），并按"审计方探针三态对照"验收。**结构性观察**：第八轮的 P1 全部落在"**上一轮刚改过的地方**"或"**上一轮没覆盖到的同族路径**"上（连接器重注册链路、`check-workflows` 的多份文本口径、`redact_secrets` 只补了被修过的那半边、GUARDS 表只校验了名字），这条"上一轮修复面是最高价值入口"的规律**连续五轮成立**；本轮更进一步证明：**门禁判据若建立在文本形态而不是执行视角上，加固只会把绕过推向相邻形态**（第 7 轮修数值退出码 → 第 8 轮出现 argv/解释器/函数包装/参数拼接四种等价变形）。

**判定：未达成"连续两轮独立审计零新增 P0/P1"。** 第一轮 6 P0 + 66 P1、第二轮 1 P0 + 15 P1、第三轮 0 P0 + 19 P1、**第四轮 0 P0 + 8 P1**（R4-A 7 / R4-D 1；另 28 P2 + 31 P3），外加**一条生产现场发现的 P0**（编译缓存自锁，§7.38）—— 四轮都不是干净轮，按口径干净的一对必须顺延到第五、六轮。**第四轮的结构性意义**：它证明"第三轮的新增守卫自身"也需要被审计（R4-A 的 7 条 P1 有 5 条正是**第三轮刚修/刚加的判据**的覆盖面缺口），而"活锁/自愈"是一整类此前完全没有判据的缺陷。

**收敛判定更新（第七轮后，2026-09-24）**：第七轮 0 P0 / **4 P1**（其中 **3 条是第六轮修复自身的回归面**）⇒ 仍未达成"连续两轮零新增 P0/P1"。逐轮计数追加：第六轮 0+7、**第七轮 0+4**；第七轮修复批的独立复审又在其**自身修复面上**新增 **2 条 P1**（V2 的 F1a-② 与 F1b 两条静音路径，见 §7.41 末段）⇒ 按同一口径本轮实际为 **0 P0 / 6 P1**。第七轮修复批已 squash 合入 master `3d4306dded`（PR #142），V1 独立复审判定 P1-1/P1-2 成立。**第八轮已在同一提交（`3d4306dded`）上开跑**，四路分工：服务端核心与第 7 轮服务端修复的回归面 / 客户端宿主与连接器修复的回归面 / 门禁与发布链对抗 / 跨模块证伪；V1 登记的 7 条新边界、V2 的 2 条静音路径与同轮认账未修项（作用域哈希归一）列为该轮**固定审计对象**。按本报告口径，"连续两轮零新增 P0/P1"要求第八、第九轮都不再产出 P0/P1。

**发布侧阻塞（非代码缺陷，2026-09-24）**：tag 流水线的「渠道仓 pin」步（`gate` 第 6 步，仅 tag 触发）需要读私有渠道仓的凭据。三条路径中：`CHANNELS_REPO_TOKEN` 指向的令牌在 CI 内被判 `remote: Repository not found.`（同一令牌在本机可读该仓 ⇒ 需要区分"仓库级 secret 未生效/被同名组织级 secret 遮蔽/令牌作用域"）。**SSH deploy key 路径在 GitHub 组织策略下当前不可用**（`POST /repos/{owner}/{repo}/keys` 返回 422 `Deploy keys are disabled for this repository`，属组织/企业级策略开关），该路径的代码形态本身已由第七轮修复（`ed1b80eed7`）。因此**在凭据打通之前，任何 tag 的发布链都会在 gate 第 6 步红灯**（这一条是 fail-loud，不会静默产出空渠道——判据见 `scripts/ci-channels.sh` 与 `scripts/verify-ci-scripts.mjs`）。

**收口批之后的状态（2026-09-23 同日）**：第三轮的全部 P0/P1 与本轮新增的各条 P2/P3 都已修复、且每条都过了**另一名子代理**的独立复审（§7.37，含"复审发现 → 再修 → 再验"的两轮：如 A-4 的第三个消费面、打包修复自身引入的渠道文件进 asar、以及本批自己撞出的 `TestSkillDiscipline` 门禁红）。但**这不等于收敛**：按本报告口径，"连续两轮零新增 P0/P1"要求的是**新的独立审计轮次**在同一冻结态上都不再产出 P0/P1 —— 本轮做的是"第三轮发现项的闭环 + 复审"。**该段落的后续（2026-09-24 补记）**：第四、第五轮随后都已跑过，且**都不是干净轮**（第四轮 0 P0 + 8 P1 + 一条现场 P0；第五轮 0 P0 + 15 P1，见 §7.38/§7.39），两轮的修复批又各自经过**另一名子代理**的独立复审并闭环（§7.37/§7.39/§7.39b）。因此当前准确状态是：**待跑第六轮**（范围见 §7.39 末段与 `temp/round6-2026-09-23/PROMPTS.md`：服务端核心、客户端与宿主、门禁/发布链、跨模块一致性 + 上一轮新判据的覆盖面 + 活性/自愈两维）。

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

**第十轮结论（2026-09-24）**：第十轮首发 **0 P0 / 10 P1**（去重后）—— 门禁面 7 条（"执行体由谁提供"5 条 + "红但不可诊断"2 条）、服务端 2 条（保留期回收的同族两条路径各自留着窗口）、连接器 1 条（授权槽判据问的是"是不是空串"而不是"有没有凭据"），另 13 条 P2 / 19 条 P3，并附主控独立取证的一条 master Gate 假红（同一棵树一红一绿）⇒ **仍不是干净轮**；按口径"连续两轮零新增 P0/P1"必须顺延到第十一轮。**第十轮的结构性意义**：它给出了判据面推进的**最后一层**——第九轮把判据推进到"进程环境"是对的，但环境变量是**黑名单**枚举，而黑名单必然有下一层；第十轮实测的五条通道（`COREPACK_HOME` 换解释器 / `container.env` 第四层 / `uses:` 的执行体内容 / 判据自己依赖的 `yaml` 解析器 / 被钉步骤**步骤体内**的 shell 赋值）共同的特征是**"workflow 文本里那一行命令一个字都没改，而判据读不到真正被执行的东西"**。同时它再次验证了连续七轮成立的那条规律（"上一轮刚改过的地方是最高价值入口"），并给出它的第三个子类：**"同族两条路径只收口了一条"**（第九轮修了 attached 路径的持锁复检、孤儿路径没有；修了授权槽的"空声明"、其它头名没有），以及一条**日志层的假保证**（通过行声明"三层均已检查"，而代码里就只有三层枚举）。

**第十三轮结论（2026-09-25）**：第十三轮首发 **5 P0 / 9 P1**（去重后，见 §7.48）⇒ **仍未达成"连续两轮零新增 P0/P1"**。逐轮计数追加：第十一轮 1+6、第十二轮 2+7、**第十三轮 5+9**。**第十三轮的结构性意义**：它把判据面从"判据读什么"推进到**"哪一份字节在跑、以及这份字节由谁定义"** —— 三条门禁 P0 的共性是**判据没有撒谎，但判据不是那个该跑的判据**（本地 git 对象库与被审对象同域可写；启动器来自活 PATH；workflow 取自 PR merge ref）。其中第三条是**平台性质**（本仓代码侧只能提高门槛），前两条已在第十三轮修复批里做了结构性收口（平台锚 `HEAD == $GITHUB_SHA` + 远端对象库锚 + 冻结启动器 + 执行体全集双向登记）。另一条贯穿性的规律第七次成立：**"同族只收口一条"**（覆盖面只认 `scripts/check-*.mjs`；`search_path` 只收写面；`pendingLiveHeaders` 只收后半窗口；integration-tests 的判据纪律只加在一条腿上；webadmin 只对"权限点"做了双向对账）。

**第十三轮修复后的复审（同日）**：修复批经 **三路独立验证**（V13-A 门禁面 / V13-B 客户端+服务端 / V13-C 外设面）逐条判定，**4 条 P0 无一被打破**（应用 AI 跨账号那条在修复前树上被自写探针复现、修复后消失；C-01 载荷与 integration-tests 掏空攻击同样"修前假绿 → 修后必红"），但复审又打回 **5 条"只闭一半 / 新暴露"** 的项（冻结 PATH 未导出到判据步、执行体同类物仍在集合外、`search_path` 第三条路径、技能卸载跨根、doc-claims 打印路径与登记制判别力），已由 **GH1/GH2/GH3 三条补充泳道**闭环且各自带"修前假绿复现 + 修后必红"双证据。**这本身构成第十三轮的第二层**：按本报告口径，"连续两轮干净"必须在**补充修复之后的冻结态**上重跑一遍 —— 即第十四轮。

---

### 7.48 第十三轮审计（2026-09-25，七路独立）：判据的"执行"与"定义"

**方法**：绑提交 `1816718f32`（= `origin/master` 合并 PR #148 后的头；四路审计对象 `b5dab30565` 的树与它逐字节相同）。七路 = A 服务端 / B 客户端技能库 / C 门禁·构建链·CI / D 对抗证伪（含主控追加的定向攻击面 §8）/ E 客户端其余面 / F 外设面（integration-tests + webadmin + 站点 + 文档 + fabric）/ V1 对第十二轮门禁修复的独立验证。全部只读；变异只在 `git archive` 副本内做，逐条 `trap` + `timeout` + 还原后复算 sha256。**本轮不是干净轮**：新增 **5 条 P0**（去重后：D-01 / D-02 / D-§8 / B·E 应用 AI 跨账号 / F-01）与 **9 条 P1**（去重后：判据执行体覆盖面 / 空 `user-invocable` / 已安装集合 ≠ 运行时集合 / 发现面判据输入源 / 官网硬数字判据的自我陈述 / integration-tests 接线与新增登记 / webadmin 路由/审计 sink 登记族 / `search_path` **读面**未收口 / `pendingLiveHeaders` 更早窗口）。另有两路**独立验证**（V1 门禁面、V2 服务端+客户端面）对第十二轮修复批逐条判定。

| 来源 | 覆盖 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| **R13-A** 服务端 | 补账/分区/搜索路径/限额/审计 | 0 | 0 | 3 | 2 |
| **R13-B** 客户端技能库 | 应用 AI 隐藏会话 / 技能清单 / 安装集合 / 落点 | **1** | 2 | 3 | 3 |
| **R13-C** 门禁·构建链·CI | 判据语料 / 输入源 / 凭据 argv / 门禁 job 形态 | 0 | 1 | 2 | 2 |
| **R13-D** 对抗证伪（含 §8 定向面） | 平台锚 / 启动器 / 覆盖面 / 时间日历面 / workflow 变异电池 | **3** | 1 | 1 | 1 |
| **R13-E** 客户端其余面 | 等待预算契约 / 发现面 / 输入源 / 内存作用域 | 0 | 2 | 2 | 1 |
| **R13-F** 外设面 | integration-tests / webadmin / 站点 / 文档 / fabric | **1** | 3 | 8 | 9 |
| **合计（去重后）** | | **4** | **4** | ~19 | ~18 |
| **V1** 对第十二轮的独立判定 | 门禁面 16 项 | CLOSED 12 / PARTIAL 2 / NOT-CLOSED 2 / REGRESSION 0 | | | |
| **V2** 服务端第十二轮的独立判定 | 10 项逐条（见 `temp/r13/V2/REPORT.md` §0） | 见报告（1 条 PARTIAL 被证伪为 NOT-CLOSED） | | | |

**四条 P0**

1. **锚定物可被同 job 的仓内执行点改写（R13-D-01）**：载荷改写判据执行体**并 `git commit`** ⇒ `git show HEAD:` 与工作树**自洽**，`--restore` / `--require-clean` / 摘要登记**全部失效**；实测 Full gate **EXIT=0** 且打印**真凭据**（`planned=32 executed=32`），**一条测试没跑**。`HEAD != $GITHUB_SHA`，而全仓**没有判据比对这两个值**。
2. **启动器可被替换（R13-D-02）**：**不碰 git、不改任何被跟踪文件**，只把假 `node` 目录写进 `$GITHUB_PATH`（写在 `.sh` 里 ⇒ YAML 静态判据看不见）⇒ 探针 / 编排器 / **凭据检查器**三次 `node` 调用全被替换，假 node 按 `--nonce-file` 自己回显凭据，`EXIT=0`、工作树干净。
3. **判据的「定义版本」= 被审版本（R13-D-§8）**：`on: pull_request` 用 **PR merge ref 的 workflow 文件**；分支保护按 **(context 名, app_id=15368=GitHub Actions)** 匹配 ⇒ **保留 5 个 `name:`、把 job 体换成 `echo ok`**，5 个必需检查全绿而**仓内没有一条判据会红**。现状：`required_approving_review_count: 0`、`require_code_owner_reviews: false`、无 `CODEOWNERS`、`rulesets=[]`。
4. **应用 AI 隐藏会话跨账号复用（B-P0-1 / E-P1-04）**：`app-ai-runner.ts:214` 的 `live` 与磁盘会话只按 `app:<app_id>` 建键（`wasm-apps-host/src/ai-chat.ts:60-62`），`main.ts:543` 进程级 provide 一次、**无 `pico/session-changed` 释放**；真 agent-loop 探针实测：A 账号用过某 app 的 AI → 登出 → B 账号登录 → B 对**同一 app_id** 发一轮，**请求体的对话消息逐字为 `[A 的 user 消息, A 的 assistant 回复, B 的 user 消息]`**；而"同意使用应用 AI"的授权本身是按账号的（`ai-authorization.ts:53` 的 `aiConsentKey = userId\0appId`）。反向：B 取消会 `dropAgent` 掉 A 的活体会话。

5. **integration-tests 的运行期判据可被整体掏空而门禁 EXIT=0（R13-F-01）**：`integration-tests/dex/dex-sso-test.py` 与 `integration-tests/openldap/ldap-rbac-brand-test.py` 的运行期判据（**14/17 条**）换成恒真 `check(name, [], '')` 后，`--self-test` 仍报 **24/24、29/29**，`scripts/check-integration-tests.mjs` 照打「2 个契约脚本判据自检通过」且 **`REAL_GATE_EXIT=0`**。根因：第 4–6 轮把「判据表 + 逐条正负例 + 运行期逐条引用 + 端到端变异」这套纪律**只加在 `electron-shots` 一条腿**上（该面共 **3 条腿 / 26 条运行期判据**）。⇒ 又一次「**同族只收口一条**」，且这次收口的是**判据纪律本身**。另：该端到端面在 CI 语境下 **0 执行**（`ci.yml` 对 integration/dex/openldap 的命中数为 0），因此它连"跑过"都不成立。

**九条 P1**

1. **判据执行体的覆盖面只认 `scripts/check-*.mjs`（R13-D-03 / C-01 / V1 §4.1，三路独立复现）**：把 `scripts/wasm/check-deletion-surface.mjs` 换成恒绿空壳 ⇒ 真错误状态（`server/internal/wasmapp/` 下新增未登记包）由 `group 2 pass=2 fail=1 / EXIT=1` 变成 `pass=3 fail=0 / EXIT=0`，而 `check-install-integrity` 打 `VERDICT PASS judge-bodies=13`、`check-guard-parser-integrity --require-clean` 打 OK。集外同类物至少 9 类。
2. **空的 `user-invocable:` 三关全绿而运行时丢弃整份技能（B-P1-1）**：客户端预检与服务端 `skillmanifest` 都把 `null` 当"未声明"跳过，安装器只复核 name/description；而上游 `frontmatterBoolean` 对 `null` **throw** ⇒ 整份技能被丢弃。上传 201 → 审核通过 → 装上 → **模型永远看不到，全链路零报错**。
3. **企业侧「已安装技能」集合 ≠ 运行时加载集合（B-P1-2）**：`listInstalledSkills` 只认「非点号目录 + 目录名 kebab + 有 SKILL.md」，上游按 **frontmatter 名** 认**全部直接子目录**。差集里的幽灵目录**在上游赢下注册表**（模型读到旧备份内容），而界面说"已是最新"、`uninstallSkill` 返回成功 ⇒ **「卸载成功而模型照旧能用」**。
4. **发现面契约的判据输入源 ≠ 生产形态（E-P1-01）**：判据用裸 `vitest list --filesOnly`，生产跑 `scripts.test`。把 `test` 改成 `vitest run tests`（配置一字未改）⇒ 判据 **40/40 全绿**，生产只跑 1 文件 / 4 用例，另 7 个文件静默掉出门禁；`-c <另一配置>` / `--exclude` 同样。
5. **`check:doc-claims` 的自我陈述比覆盖面宽（F-04）**：把官网「保留最近 3 个版本」改成 5（真源 `scripts/ci-publish-update-server.sh:273` 的 `KEEP=3`）、「60 秒 / 6 小时」改成 30 秒 / 1 小时（真源 `packages/host/desktop/src/updates.ts:136-137`）后，守卫仍 **EXIT=0 并打印「文档数字与真源一致 ✅」** —— **通过行比覆盖面宽**是最隐蔽的一类假绿（判据自己说它判了）。
6. **integration-tests 的接线与新增登记（F-02 / F-03）**：`run-all.sh` 对两个 `.py` **零接线判据**；新增一个 integration test（"必然 77"或恒真用例）**全绿**，只有**删除**才红 ⇒ 登记制只做了单向的一半。
7. **webadmin「路由 / 审计动作 sink」两族没有双向对拍（F-P2-1/P2-2）**：只加一条 `<Route path="/probe-unregistered">` ⇒ 全量 **644 用例 EXIT=0**；新审计动作经**参数传入**的本地包装写出 ⇒ `Audit.test.tsx` **EXIT=0**（正对照直接挂已登记 sink 则红）—— 同一仓里"权限点"做了双向对拍，这两族没做。
8. **`search_path` **读面**未收口（V12-2 第 2 项，PARTIAL ⇒ 有计费后果）**：第十二轮把写/结算/删除/清理/余额/计量六条写路径收口到 `public`（3 → **14 个调用点**），但**定价读 `ModelPricesForProvider` 与报表读**在 shadow schema 在场时仍读 shadow —— 真 PG 实测结算把 shadow 价目（1000）算进 public 行。**同族只收口了一条**（读面），且这些函数不在机械守卫的扫描面内。
9. **`pendingLiveHeaders` 的更早窗口没有追赶（V12-2 第 7 项，PARTIAL）**：追赶（`adoptLatestRefresh`）本身承重，但「`registerMcp` 入口读凭据 → 记录渲染」这段**更早窗口**未变异时就红：死令牌上线一次、多花一次 refresh 兑换、一次多余 401（靠 SDK 401 自愈兜住）。**同一条链上只收口了后半个窗口。**

**V2 对第十二轮服务端/客户端修复的独立判定（10 项）**

| # | 被验项 | 判定 |
|---|---|---|
| 1 | `reclaim_stalled` = 真停摆还是月龄 | CLOSED（+1 残留：停摆位只由**最早**受阻月推导 ⇒ 更晚月的持续真失败会被更早月一次新延后掩盖） |
| 2 | `usageSearchPathPin` 统一 `search_path` | **PARTIAL**（写面 6/6 全绿；**读面未收口** ⇒ 见 P1-8） |
| 3 | `write_blocked_other_months` 自愈 + `reclaim_blocked_*` | CLOSED（真写路径三段） |
| 4 | `write_ddl_lock_*` 与 `LOCK TABLE` 对 matview 42809 | CLOSED（LOCK 矩阵 r/p/v 可锁、m/i/S/f 全 42809；清理只对 r/p/v/m 取锁 ⇒ 无同族残留） |
| 5 | `fold-adjacent` 错界分区 42P17 | CLOSED（按"跳过 + 结构化登记"取向；金额守恒） |
| 6 | 两阶段 reclaim 窗口在持锁区间内 | CLOSED（交错行 17.00 = 10 + 7，拆掉即 `SILENT_LOSS=7.0`）；`usageReclaimFreezeBudgetMS` **一变量两语义仍在**（实测 `statement_timeout="1234ms"`） |
| 7 | `pendingLiveHeaders` 注册期追赶 | CLOSED（追赶）/ **PARTIAL**（更早窗口 ⇒ 见 P1-9） |
| 8 | `fields` 归一 / `mcpActivityKey` / `onRefreshed` 零 await / 方案词表 | `fields` CLOSED；`mcpActivityKey` CLOSED 但**承重面只有一条用例**、尾斜杠 `/mcp` vs `/mcp/` 不归一且无判据；`onRefreshed` **PARTIAL**（真 await 红；等价的 `setTimeout(0)` 延后时 connectors 全量 465 用例全绿）；词表 **PARTIAL**（删 `bearer` 红、加假词红、**删 `ssws` 零红**） |
| 9 | `r12b-already-in-use-retry.spec.ts` 真行为还是假绿 | CLOSED（删接线必红；5 条判据逐级恒真化后失败点依次后移 ⇒ 非假绿） |
| 10 | 发现面契约 | CLOSED（8 类负例全红） |

**V2 的回归判定**：`go test ./... -count=1 -p 2 -timeout 1800s` = **EXIT=0（55 包 0 FAIL）**；**新引入回归 0 条**（第十二轮客户端只改测试/文档 ⇒ 上表第 8 项的缺口是**继承缺口**而非回归）。环境提醒：全量测试在"并发跑探针 + 变异 + 两条 vitest"下 `llmgateway` 从 327s 涨到 **1726s**（距 1800s 超时仅 74s）⇒ 跑服务端全量判据前必须先停掉并发重型测试。

**V1 对第十二轮门禁修复的独立判定（16 项）**

| 判定 | 条数 | 项 |
|---|---|---|
| **CLOSED** | 12 | R12-D-01 主攻击面（13 条判据执行体 / `.yarnrc.yml` 禁键 / `.yarn/plugins\|releases` 空 / 工作区 postinstall / 符号链接 / 新增未登记执行体 / `--restore`）；CI 侧凭据形态（`planned=0`、半行、stderr、ANSI、CR 分段、两行、`planned≠executed`、退出码≠0、零输出）；`guards=0`；弱 `--pattern`；`defaults.run.shell`（workflow 级与含 `-c` 的 job 级）；被钉步骤 `if/continue-on-error/working-directory/runs-on/shell`；发布正文三条绕过；前置校验步骤顺序；`2>&1 \| tee` 旧形态；固定 `/tmp` 路径旧形态；断言块被删；`exit()` 函数遮蔽；YAML 合并键；新增未登记 workflow；判定行 CR 分段；`patch:` 协议新增补丁；404 判据（新旧形态 + 真 CLI 报文 + 30/30 回归）；`check-root-guards.mjs` 的 3 处 digest 改动 |
| **PARTIAL** | 2 | ①覆盖面只到 `scripts/check-*.mjs` 一族（=本轮 P1-1）；②`VERDICT_LINE` 的 `witness` **不是独立见证**（pattern 与样本、witness 同文件同表 ⇒ **三处同文件编辑即 EXIT=0**） |
| **NOT-CLOSED** | 2 | ①**`endUninterruptably` 形态的修复在本树中不存在**（全树 `grep` 零命中，含全部审计报告）⇒ 第十一/十二轮报告里的这条**自述不实**（详见下）；②`check-install-integrity` 对 `packages/*/*/{tests,scripts}/**` 的改写**完全无判据**（302 个 spec + 50 个执行体，实测两个独立判据都 PASS） |
| **REGRESSION** | 0 | 未发现本批引入的回归 |

**`endUninterruptably` 更正（V1 NOT-CLOSED ①，本轮如实更正）**

第十一/十二轮报告把 `endUninterruptably` 写成"已实施的修复"。V1 逐条复核：**全树（`scripts/`、`.github/`、`temp/` 含全部审计报告）`grep` 零命中，`git log -S` 亦无** —— 该项在本树中**没有对应物**（既不是"已闭合"也不是"未修"，而是**无对应物**）。真实的退出路径加固现状在别处，写清楚是：

- **`scripts/check-root-guards.mjs` 真正在做的事**是**运行器侧**的三条：① 每个守卫以**真子进程**运行、退出码**不可被 `NODE_OPTIONS=--import` 之类的退出钩子改写**（钩子同时覆写 `process.exit` 与 `process.reallyExit` 时，运行器仍以"每个登记的守卫都真的跑过 + 没有一条失败"为条件打印通过凭据）；② 交给守卫子进程的环境经过**清洗**（危险族键不传递）；③ 被判进程"拒绝运行"或"零守卫"时**打印不出**通过凭据。
- 换句话说：本仓的收口是"**判定权上移 + 凭据必须由本步的检查器合成**"，不是"让某个函数不可中断地结束"。凡引用 `endUninterruptably` 的表述一律以本条为准。

**tag-only 判据步的口径（第十四轮 lane B 复核，2026-09-25 就地登记）**

第十四轮 lane B 复核 `gate` 里三条"只在 tag 上才有意义"的判据步（`Classify the release tag` /
`Release topology` / `Resolve the channel packages revision`）时，顺带核对了一句流传中的说法
——"这三条**从未在任何真实运行里执行过**"。**核对结果：这句话不在本报告里**（本节、全文与
`temp/r13/**` 的报告 `grep` 零命中，`git log --all -S` 亦无），它只作为"不该这么写"的引文
出现在 lane B 的 `REPORT.md` 里。为免它日后被当作本报告的口径引用，**正确表述写在这里**：

- **已被覆盖**：`[SK-20]` 把这三条算进 `gate` 的 7 个 PATH 复位判据步；行为探针
  `scripts/check-frozen-launchers.mjs` 的逐判据步金丝雀格子**每个 PR** 都把这三条步骤体的
  **原字节**跑两遍（各自一次 + "只冻结解释器、不复位 PATH"的正控 B 一次），且冻结输出缺席时
  以 127 失败（fail-loud，lane B 实测）。
- **未被覆盖**：**真 tag 参数组合**（`GITHUB_REF_NAME` 是真 tag、`docs/releases/<tag>.md` 在位、
  `origin` 上真有那批 tag）。
- ⇒ 正确口径：**"步体已被 canary 级行为探针覆盖；真 tag 参数组合是它第一次真跑"**。
  完整记账见 `docs/decisions/2026-09-25-gate-definition-authority.md` §5.2（同处 §5.1 记
  "哪些 job 有冻结点、哪些没有、残余攻击面是什么"）。

**D-§8.5 的诚实边界（整段原文引用）**

> **在没有结构性收口的前提下，本仓"门禁绿"能承诺什么、不能承诺什么。**
>
> **能承诺**：①在**同一份被审提交**内，已登记的判据执行体（`scripts/check-*.mjs` + 三个入口 + 15 个工作区 manifest）与 `HEAD` 逐字节一致，且"没有未登记的 install 期钩子 / `.yarnrc.yml` 禁键 / `.yarn/plugins|releases` 为空"；②在**该提交自己定义的 workflow**里，被钉步骤的 argv/shell/env/工作目录/`with:`/`runs-on` 与登记值一致，凭据由本步的检查器回显本次 nonce；③**若**这些 job 真的被调用且 `HEAD == $GITHUB_SHA`，那么"32 个包的门禁任务真的跑过"这句话在该提交内成立。
>
> **不能承诺**：①**不能承诺这些 job 真的被调用过**——`.github/workflows/ci.yml` 与被钉 job 的 `name:` 都在被审提交里，`pull_request` 事件使用 **PR merge ref 的 workflow 文件**，而分支保护按 **(context 名, app_id=15368=GitHub Actions)** 匹配；保留 5 个 `name:`、把 job 体换成 `echo ok`，5 个必需 context 全部 success，而**没有任何一条本仓判据会因此变红**（本仓全部静态判据都在同一个可被替换的 workflow 里）。②**不能承诺 `HEAD` 是平台的那个提交**——R13-D-01 证明"锚到 git 对象"不等于"锚到平台值"，`HEAD` 与工作区同域可写，且 `$GITHUB_SHA` 在 4 条锚定判据里只有 WASM 门禁用了。③**不能承诺"第一道探针之后判据没被动过"**——R13-D-02 用 `$GITHUB_PATH` 换掉 `node` 启动器即可，静态判据只读 YAML 文本、看不见 `.sh` 里的操作。④**不能承诺"评审兜住了"**——`required_approving_review_count: 0`、`require_code_owner_reviews: false`、仓库无 `CODEOWNERS`：平台的审批要求是"零"，所以"唯一区分机制是评审"目前**只是流程约定**，没有平台强制。⑤因此，**"门禁绿"当前的准确含义是"在一个诚实的 workflow 定义与一个未被改写的 checkout 下，本仓自带的判据都通过"**；它**不等于**"这些判据在本次 PR 上被调用过"，也**不等于**"有一个独立于本 PR 的第三方确认过这件事"。
>
> **要把它变成可承诺，需要平台上的一次配置改动（不是代码改动）**：`required_approving_review_count ≥ 1` + `CODEOWNERS` 覆盖 `.github/**`（或 ruleset 的 `required_reviewers.file_patterns`），以及/或者把必需 context 的来源换成 PR 改不到的 app 或 `pull_request_target` 定义的可信工作流（详见 §8.3）。

**本轮方法学增量：判据面的台阶再上一级 = 「判据的执行」与「判据的定义」**

前十轮的推进脉络是"判据读什么"：命令文本（SK-7 系列）→ argv/shell/步骤体（第八、九轮）→ **进程环境层与"执行体由谁提供"**（第十、十一轮）→ **"判据的本体"与"判据的启动"之间的缝**（第十二轮）。第十三轮把它明确拆成**两个不同的环节**，并各给出结构性收口：

- **「判据的执行」**：判据确实跑了，且跑的是**平台那个提交定义的**判据 —— 收口 = ①平台锚（`HEAD == $GITHUB_SHA`，本轮 D-01）+ ②**冻结启动器**（`node/bash/git` 的绝对路径进步骤输出，后续判据步只用冻结值，本轮 D-02）+ ③判据执行体的**执行体全集**双向登记（本轮 D-03）。三者的共同点：**收口的是"哪一份字节在跑"**，而不是"那一行命令怎么写"。
- **「判据的定义」**：判据还能不能被调用、以及它是不是**被审提交自己定义**的 —— 这是**平台侧**的问题（`pull_request` 用 merge ref 的 workflow、必需检查按 (context, app_id) 匹配），代码侧只能**提高门槛**（`CODEOWNERS` + 静态钉法），**不能**收口。本轮把它写成 `docs/decisions/2026-09-25-gate-definition-authority.md`，并把三条可用的平台收口与"为什么本仓刻意不做整仓 `pull_request_target` 迁移"逐条写清 —— 结论是：**在平台设置改完之前，"能承诺"的那三条（§8.5 上半段）必须加上"若 job 真的被调用"这个前提**。

同轮还有两条**独立**的方法学复现，都是旧形态的新实例：④**同族只收口一条**（覆盖面只认 `scripts/check-*.mjs`；`--restore` 的覆盖集只到 entryPaths 那 20 条）；⑤**"判据的输入源"与"生产形态"不一致**（E-P1-01：裸 `vitest list` vs `scripts.test`；B-P1-1：判据把 `null` 当"未声明"而运行时 throw）。

**第十三轮修复批（PR #149；三条提交：`36f9910b63` 主批 → `f0c13a09f5` / `6899874589` 首跑 CI 暴露的两处 → `53d28c34f7` 复审补充）**

- **门禁执行面（GA + GH1）**：①平台锚 —— `check-install-integrity` 断言 `HEAD == $GITHUB_SHA`（不等 / CI 上缺席 ⇒ 退出码 2），值进 VERDICT 与 `--json`；`check-guard-parser-integrity` 增加**远端对象库锚**（`fetch --depth 1 origin $GITHUB_SHA` 后 `cat-file` 复算摘要）并**如实降级其效力表述**（"另一个域上的独立确认"，"字节不符"分支只有合成 `expected` 能触发，新增一次网络依赖 = fail-closed）。②**冻结启动器**：两个判据 job 的首个执行体把 `command -v node/bash/git` 的绝对路径写进步骤输出，判据步只用 runner 侧展开值；新增 `check-frozen-launchers.mjs`（静态判据 + **逐 job/逐判据步**的行为探针 + 正控）。③**GH1 补的第二半**：第一版只冻结了解释器，**脚本体里的裸 `node` 仍走活 PATH**（V13-A 实测 `ci.yml` 从未 `export PATH="${{ …outputs.path }}"`，wasm 门禁 group 2 由 `fail=1/EXIT=1` 被翻成 `fail=0/EXIT=0`）⇒ 新增第二个冻结点 `frozen-toolchain`（冻结 PATH + **白名单**合成，白名单外新增目录当场红）、**11 个判据步**在任何仓内命令之前导出、`[SK-20]` 补三条静态判据（形态两端锚定 / 顺序 / 外部命令登记制）。④**执行体全集**从"目录形状"改为"**执行点推导**"（workflow `run:` 命令位 / manifest scripts / `check-integration-tests.mjs` 的 spawn 面 / 包内 `vitest`+`tsdown.config.ts`）：96 → **130 条** + `EXECUTION_POINT_REGISTRY` 34 条双向登记（V13-A 点名的五类逐条落地；语料 `tests/**` 仍单列）。⑤`--restore` 覆盖集 = 全集；`VERDICT_LINE` 的独立见证迁到 `verify-check-workspaces.mjs`（29 条 + 负控 + 注册自检）；`.yarnrc.yml` 六种等价写法逐条红；`YARN_YARN_PATH` 按入口族收口；`--since` 参数通道整体移除；`gate-guards` 的 `permissions` 登记制 `[SK-21]`。
- **客户端/服务端（GB + GC + GD + GE + GH3）**：应用 AI 隐藏会话 id 加**账号作用域**（`app:<app_id>#<账号[@服务端哈希]>`，形状真源 `app-session-id.json` 由 Go `//go:embed` 与 TS 共读）+ `pico/session-changed` 释放（订阅收口到零依赖叶子包 `@picoaide/dsh-host-locale/session-events`）+ 服务端归因改按会话 id 前缀派生；空 `user-invocable:` 两侧判非法并与 pinned 上游**行为对拍**（Go 切上游 `frontmatterBoolean` 函数体派生字面量集合，TS 真跑上游注册表 24 条语料）；「已安装技能」集合收敛到运行时同一判据 + **跨根残留判 `RESIDUE`**（根表单一真源 + 真跑上游注册表判定）；`isSafeDshHome` 与 cwd 闸门共用唯一谓词；技能用量去重键加作用域 + LRU；发现面契约按 `scripts.test` 真实 argv 取见证 + 形态登记制 + 包枚举改为 `workspaces` 派生（**事实面 = `packages/` 递归 ∪ glob 展开**，覆盖 `community/*`）；计时器上界移到抖动之后；`refreshable` 键作用域化并入 `teardownAll`；`pendingLiveHeaders` 的**更早窗口**追赶（入口世代号无 await 重放）；`search_path` **读面**收口 + **第三条路径**（`internal/llmgateway` 4 处 + 又扫出 3 类，共 7 处；`audit_logs` 纳入并 pin，另披露 3 张 known-uncovered）与守卫文件面扩到整个 `server/`（68 包 / 42 表双向登记）；停摆位改为"任一受阻月" + 反向判据；`usageReclaimFreezeBudgetMS` 拆成单语句/段两个具名量 + 序关系不变量；权限点集合双向对账（前向 + 反向 + 危害同构三层）；启动账本窗口归一到月初（唯一实现 + 248 组合表驱动）；迁移集合双向对账（反向差集 fail-loud）。
- **外设面（GF + GH2）**：`integration-tests` 三条腿统一到同一套判据纪律（判据表外置 `contractkit.py` + 逐条正负例 + 两个自证 + 变异锚点 + 守卫四层覆盖）；接线/新增登记双向；`check:doc-claims` 的真源改为**解析代码**、通过行按覆盖项反解断言、**断言钉在真实打印路径**（跑一次真脚本读真 stdout）；登记制的**判别力下限**（`minJudgments` 逐数相等 + SKIP 原因码闭集双向）；`run-all.sh` 解析正则不再吃换行；webadmin 路由/审计 sink（Go 调用图闭包到不动点）/随包技能目录三方双向；锁面板"成功才解锁 + 渲染期归零"。
- **首跑 CI 暴露的两处（不属于本轮发现，属"修复自身的问题"）**：①`check-frozen-launchers.mjs` 用命令行参数动态构造 RegExp ⇒ **CodeQL 两条 high（`js/regex-injection`）**，改为字面量正则 + 字符串比较；②webadmin 的"归因三段锚点"用例**无条件读 pinned 上游 submodule**，而 `Go server` job **不检 submodule** ⇒ 必需检查被打红，改为"冻结件 + 在场时逐字对拍 + 明确记录判定来源"（`upstream-anchor-freeze.ts`）。
- **集成判据**：整仓 `corepack yarn check` **32/32 通过 / 0 失败 / 0 跳过**（`VERDICT PASS planned=32 executed=32`）；`node scripts/check-install-integrity.mjs`（`GITHUB_SHA` 在场）= `judge-bodies=130 execution-points=64`；`check-guard-parser-integrity` / `check-workflows` / `check-frozen-launchers`（jobs=2 steps=11 probes=12）/ `check-integration-tests` / `check-doc-claims` / `verify-check-workspaces`（断言 494 / 场景 30 / 自检 11/11）全 EXIT=0；webadmin 42 文件 / 668 用例全绿（**含无 submodule 的形态**——那正是 `Go server` job 的实况）；Go 侧 54/55 包绿（`internal/serverstore` 在 `-p 2` 下因模板库克隆饥饿撞 1800s 包级超时、**零用例级失败**，隔离复跑 `ok 396s`）。

**第十三轮的两路独立验证（V13-A 门禁面 / V13-B 客户端+服务端 / V13-C 外设面）**

| 路 | 判定 | 关键结论 |
|---|---|---|
| **V13-A** | 平台锚 / `--restore` / 独立见证 / `.yarnrc.yml` 六形态 / `[SK-21]` / CODEOWNERS+决策文档 = **CLOSED**；执行体全集 = C-01 类 CLOSED、同类物 PARTIAL；远端锚与冻结启动器 = **PARTIAL** | 明确回答：**D-01 未被打破**（C-01 载荷 pre-fix 是 `judge-bodies=13/EXIT=0` 的假绿，post-fix 未提交 EXIT=1 / 已提交 EXIT=2）；**D-02 被部分打破**（R1：`ci.yml` 从未导出冻结 PATH ⇒ 脚本体裸 `node` 仍走活 PATH，已由 GH1 补）；未推送提交上的远端锚红 = fail-closed 设计意图，本地开发 EXIT=0 不受影响 |
| **V13-B** | P0 **未被打破**（原缺陷在修复前树用**自写探针**复现、修复后消失，两条变异红）；P1：6 条 CLOSED、**GE-1 与 GC-2 PARTIAL**、另发现 GD-2 / GD-5 两条半闭 | GE-1 的第三条路径与 GC-2 的跨根缺口已由 GH3 补齐（`search_path` 扩到整个 `server/` + 跨根 `RESIDUE`）；GD-2 的扫描面已由主控修（事实面并入 `workspaces` glob 展开，实测给 `community/*` 加 `test` 脚本即红）；GD-5（`refreshable` 作用域键半）**认账保留**（无确定性见证） |
| **V13-C** | F-01 **未被打破**（修前 14/17 条掏空仍 EXIT=0 复现；修后等价掏空 EXIT=1 且逐条具名；7 个弱攻击全红）；F-02 CLOSED；**F-03 / F-04 PARTIAL**；F-P2 四条全 CLOSED | F-03（登记齐但恒 SKIP）与 F-04（断言钉在变量而非打印路径）已由 GH2 补齐并按"修前假绿复现 + 修后必红"双向验收；端到端在 CI 内 0 执行属实，已把 `static-only` 提到**凭据行**与 **step 描述**并加"命中数 == 登记值"对拍（0↔1 都红） |

**本轮未闭环（认账，不当作已修）**：①**平台设置**（`require_code_owner_reviews` / `required_approving_review_count` / ruleset 路径级审批）仍需仓库管理员执行，`CODEOWNERS` 的负责人是**占位团队**（不产生强制）；②免密 sudo 下同 job 任意代码理论上仍可替换主机侧路径 —— 只收了 `$GITHUB_PATH` 这条低成本通道，`yarn`/`corepack` 仍按活 PATH 解析；③白名单**内部**的替换与外部命令二进制不在判据面；④`server`/`desktop-*`/`release` job 仍无冻结点（探针只记 note）；⑤`packages/*/*/tests/**`（302 spec，语料面）仍不在锚定面；⑥`integration-tests` 端到端在 CI 内 0 执行（真机 job 属需拍板项）；⑦`dex/config.yaml` 夹具内容与 `integration-tests/README.md` 的散文数字无判据；⑧技能卸载对**项目根**（`<project>/.dsh/skills`、`<project>/.agents/skills`）不在已知根内（卸载路由不带 cwd）；⑨`GetBalanceSummary` 的 `SUM(users.balance_money)` 在 shadow schema 下仍是静默错数字；⑩`internal/llmgateway` 的 `app-proof.inFlight` 只按 appId（后果=跨服务端一次 401，非内容泄漏）；⑪`refreshable` 作用域键半全仓零见证；⑫V13-B 的两条小勘误已就地改正（`beijing.go` 的溢出日清单交给判据语料、`upstream-anchor-freeze` 的来源记录顺序）。
