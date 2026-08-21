# PicoAide(Next)架构设计文档

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

> 项目:picoaide-next(全新重写)
> 日期:2026-08-01
> 状态:设计定稿,待实施
> 上一代:picoaide(沙箱模式)已冻结,本仓库仅作参考,零代码迁移

---

## 0. 设计决策记录(ADR 摘要)

| # | 决策 | 结论 | 理由 |
|---|------|------|------|
| D1 | 产品形态 | 企业内网桌面 AI 办公智能体 | 沙箱模式能力受限(无法操作真实桌面);同类产品已验证桌面客户端 + 本地执行形态 |
| D2 | 与旧项目关系 | 全新仓库、全新重写,零继承 | 用户决策:干净起步,架构按新形态自由设计 |
| D3 | Agent 循环位置 | 客户端本地运行 | 操作本机文件/浏览器/屏幕必须在本地;会话/记忆本地存储,离线可用 |
| D4 | 旧沙箱模式 | 退役 | 服务端不再跑沙箱/picoagent |
| D5 | 客户端技术栈 | Electron + React + TypeScript | Electron 桌面壳成熟度远超 Wails(WebView 跨平台差异/调试/打包生态);React 聊天 UI 生态最丰富 |
| D6 | Agent 引擎 | Vercel AI SDK(`ai` + `@ai-sdk/openai-compatible`,TS) | 事实标准的 TS LLM/Agent 框架;streamText 流式输出一流;多步工具循环自管(不依赖易变的工作流运行时);provider baseURL 直连自研网关 |
| D7 | 服务端技术栈 | Go | 网关/认证/知识库重负载场景 Go 稳、部署单二进制 |
| D8 | 平台 | Windows / macOS / Linux 三平台并行 | Electron 原生跨平台,electron-builder 打包成熟 |
| D9 | 认证 | LDAP / OIDC / 本地账号(保留企业集成) | 私有化部署刚需 |
| D10 | LLM 调用路径 | 全走服务端 AI 网关代理 | 密钥不出服务端,按用户计量 |
| D11 | MCP 工具运行位置 | 客户端本地运行(商城下发配置/凭证) | 工具需要本地环境(如小红书插件本地 HTTP 服务) |
| D12 | Skill 形态 | 混合型(指令 + 可执行包) | 简单技能用指令,复杂技能带脚本 |
| D13 | 知识库 | 服务端全新实现,客户端经远程 MCP 查询 | 数据集中服务端,跨设备一致 |
| D14 | 会话/记忆存储 | 客户端本地 SQLite | 离线可用,敏感数据不出本机 |
| D15 | 沙盒执行 | `@ai-sdk/sandbox-just-bash` 本地受限会话运行 Agent 生成的不可信代码 | AI SDK 官方**本地** bash 沙盒,受限会话跑 untrusted 代码/脚本,数据不出本机、离线可用;不用 Vercel 云端沙盒(与"数据不出本机"定位冲突且需生产凭证);本地工具(文件/桌面)仍直连用户授权目录 |
| D16 | 服务端管理 | 极简 Web 管理页 | 用户管理/商城上架/用量统计需要界面 |
| D17 | 前端框架 | React + TypeScript(不用 Vue) | AI 聊天组件/流式渲染生态 React 最丰富,与 AI SDK 原生契合 |
| D18 | 仓库名 | picoaide-next | 与旧仓库 picoaide 区分 |
| D19 | 客户端本地存储 | better-sqlite3 | Node 生态最稳的同步 SQLite 驱动,主进程内使用;原生模块需 `@electron/rebuild` 匹配 Electron ABI |
| D20 | 客户端本地 MCP | 官方 @modelcontextprotocol/sdk(Client) | MCP 标准 TypeScript SDK,stdio + HTTP 双传输 |
| D21 | 客户端 OCR | tesseract.js | 纯 JS/WASM,三平台免系统依赖,惰性加载 |
| D22 | 长任务与恢复 | streamText 多步循环(自管步数上限)+ 消息落库 | 办公任务分钟级,失败主因是 LLM/工具错误而非进程崩溃;消息即状态——中断任务标记 `status=running`,恢复 = 从最后一条用户消息重跑历史,零额外运行时;高危审批经 AI SDK v7 原生 `toolApproval` 实现(2026-08-12 裁决:引擎主循环逐个 confirm_required → 等回执 → tool-approval-response;`ai` 版本锁定 package.json,升级须跑审批回归测试) |
| D23 | UI 组件 | shadcn/ui + Tailwind(客户端 renderer 与 webadmin 统一使用) | 官方 shadcn AI 组件已发布(替代 ai-elements 轨道);Vite + React 官方支持;复制粘贴式、样式全可控;聊天/表格/表单/弹窗组件开箱即用 |
| D24 | 网关接入 | 自研 Go 网关;AI SDK provider baseURL 直连 | 不用 Vercel AI Gateway 云服务;客户端零密钥,计量在服务端 |
| D25 | 浏览器操作 | 自研浏览器插件桥:客户端主进程**固定监听 127.0.0.1:54321**,Chrome/Edge 插件默认直连该端口,即装即用零配置 | 免 Playwright 系统依赖;插件以最小权限(MV3)桥接真实浏览器;仅回环地址;操作类工具审批兜底 |

---

## 1. 背景与动机

### 1.1 上一代问题

PicoAide(旧)是浏览器 Web UI + 服务端沙箱(overlayfs + netns)模式,存在四类根本问题:

1. **能力受限**:沙箱只能做纯数字世界任务(文本/代码/API),无法操作真实桌面——不能生成并直接交付 Office 文档、不能操作本机应用、不能屏幕识别/OCR、不能做 RPA 自动化。
2. **产物割裂**:Agent 产物在服务端沙箱,用户需手动下载,体验断裂。
3. **部署沉重**:每用户一个沙箱,资源开销大,单机承载低,运维复杂。
4. **形态落后**:主流已转向"桌面客户端 + 本地执行 + 云端网关",AI 直接操作用户电脑。

### 1.2 新项目目标

构建**企业内网桌面 AI 办公智能体**:

- **桌面客户端**:完整 Agent 在本机运行,直接操作文件/浏览器/屏幕,完成"整理文件、做表格、写方案、生成 PPT、信息检索"等实际办公任务
- **服务端网关**:自研轻量基础设施——AI 网关(统一 LLM 入口/密钥/计量)+ Skill 商城 + MCP 插件商城 + 知识库(远程 MCP)。**商城与知识库均为管理员授权制(2026-08-12 修订,严格默认):资源上架/创建后未授权用户一律不可见不可用(404 不泄露存在性),授权对象 = 用户或部门组**;不涉及任何收费扣费
- **员工零配置**:安装客户端 → 登录账号 → 直接可用。**所有功能配置(模型/上游密钥/技能/MCP 插件/凭证/知识库权限)均由管理员在服务端管理页配置**,登录时服务端下发启动配置(模型列表 + 默认模型 + 技能/MCP 建议清单),客户端无配置负担。**"零配置"=功能零配置;本机可访问目录为唯一本地设置**(安全边界,管理员无法替员工决定本机路径)。**MCP/Skill 为可选增强能力,未安装任何插件/技能也可正常完成全部基础任务**
- **私有化可部署**:服务端可部署企业内网,支持 LDAP/OIDC 对接

### 1.3 非目标(本期明确不做)

- 本地 OS 级沙箱隔离(用户自有电脑,风险自担)
- 多设备会话同步(会话/记忆只存本地)
- 移动端 App
- 商业化计费扣费(只做用量统计)
- 旧项目代码迁移(仅作参考,零继承)
- **客户端配置中心**:客户端不做模型/网关/插件等"功能配置"入口(仅保留本地安全边界:可访问目录,与建议安装管理),全部配置由管理员在服务端完成

---

## 2. 总体架构

### 2.1 架构图

```
┌─────────────── 桌面客户端 picoaide-desktop (Electron: main + renderer) ──────┐
│                                                                              │
│  React UI (renderer, 全新写)                                                  │
│  ├─ 登录页:服务器 URL/端口 + 用户名/密码                                     │
│  ├─ 主界面:会话列表 + 聊天区 + 右侧产物/可视化面板 + 底部状态栏               │
│  ├─ 交互模式:Ask(聊天) / Plan(先计划后执行) / Craft(Agent 执行)              │
│  └─ 设置页:仅本地安全边界(可访问目录)+ 建议安装管理(MCP 插件/技能)+ 账户/离线状态 │
│                                                                              │
│  Electron 主进程 (Node + TS)                                                 │
│  ├─ Agent 引擎:Vercel AI SDK(streamText + tools 多步循环 + 审批门控)          │
│  ├─ 本地工具:文件 / 终端 / 浏览器 / 屏幕截图 / OCR(tesseract.js) / 剪贴板     │
│  ├─ 浏览器插件桥:CDP WebSocket 服务(固定 127.0.0.1:54321,即装即用)               │
│  ├─ 本地 MCP 运行时:@modelcontextprotocol/sdk Client,本地 spawn(stdio)/直连(http)│
│  ├─ Skill 运行时:从商城下载,指令注入系统提示 + scripts 本地执行               │
│  ├─ 会话/记忆:better-sqlite3(WAL 模式)                                       │
│  └─ 服务端连接器:登录/token 管理、AI 网关客户端(SSE 流式)、远程 MCP 客户端    │
│                                                                              │
│  ◀── 浏览器插件(Chrome/Edge 扩展,经 CDP 连接本端口):tab 读取/点击/输入/导航   │
│       ↑ 纯本地 WebSocket 通道:客户端 ↔ 员工本机浏览器,不经服务端              │
│                                                                              │
└────────────────────────────┬─────────────────────────────────────────────────┘
                             │ HTTPS(WSS)
                             │ Bearer token
┌────────────────────────────▼─────────────────────────────────────────────────┐
│  服务端 picoaide-server (Go,私有化可部署)                                     │
│                                                                              │
│  ├─ 认证:LDAP / OIDC / 本地账号(全新实现,参考旧 authsource 设计)              │
│  ├─ AI 网关:OpenAI 兼容 /v1/chat/completions 代理                              │
│  │    上游:openai / deepseek / qwen / glm / openrouter / anthropic(二期)      │
│  │    密钥只存服务端,usage 计量表                                              │
│  ├─ Skill 商城:元数据 + Git 源 + 打包下载 API(建议清单)                        │
│  ├─ MCP 插件商城:mcp_servers 配置/凭证分发 API(建议清单,非授权)                │
│  ├─ 启动配置:模型列表 + 默认模型 + 技能/MCP 建议清单(登录时统一下发)           │
│  ├─ 知识库:全新实现(存储 + 全文/向量检索),暴露远程 MCP 工具                    │
│  └─ 极简 Web 管理页:用户、商城上架下架、用量统计、网关密钥配置(全部配置入口)    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流(一次完整 Craft 任务)

```
1. 用户启动客户端,输入服务端 URL + 用户名密码 → 服务端认证(LDAP/OIDC/本地) → 返回 token
2. 客户端拉取**启动配置**(管理员统一配置):模型列表 + 默认模型(网关)、技能建议清单(商城)、MCP 插件建议清单(商城)
3. 用户输入任务:"把桌面/文档里的 Word 汇总成 500 字汇报存回桌面"
4. 本地 Agent 引擎(Craft 模式)启动:
   a. 向服务端 AI 网关发流式 LLM 请求(OpenAI 协议)
   b. 服务端鉴权 → 计量 → 转发上游 LLM → SSE 流式回传客户端
   c. Agent 决策调用工具:
      - 本地工具:文件读/写/编辑、终端命令、浏览器搜索、浏览器操作(经本地插件桥)、屏幕截图/OCR
      - 云端工具:知识库(远程 MCP 直连 `/api/mcp/knowledge/message`)
      - 插件工具:本地 MCP 插件
   d. 高危操作(删除/外发)→ UI 弹窗确认 → 用户允许/拒绝
   e. 循环直到任务完成(步数上限保护)
5. 产物写入本地工作目录,会话/记忆写入本地 SQLite
6. 全程事件流推送到 React UI(打字机 + 工具调用状态 + 产物预览)
```

---

## 3. 客户端详细设计

### 3.1 技术栈与依赖

| 层 | 技术 | 版本建议 |
|----|------|----------|
| 桌面壳 | Electron | 最新稳定(主进程 Node + renderer) |
| 主进程语言 | TypeScript(Node) | Node 20+ 内置于 Electron |
| 构建/开发 | electron-vite(main/preload/renderer 一体化) | 最新 |
| Agent 引擎 | Vercel AI SDK(`ai` + `@ai-sdk/openai-compatible`) | 最新 |
| 长任务/审批 | streamText 多步循环(自管步数上限 20)+ 工具 execute 内审批门控 | 消息落库,中断标记 `running` 可重跑;审批 60s 超时拒绝 |
| 沙盒执行 | `@ai-sdk/sandbox-just-bash` | 本地受限会话,不可信代码/脚本,数据不出本机 |
| UI 组件 | shadcn/ui(复制粘贴式)+ Tailwind CSS | 聊天/工具卡片/确认弹窗/表格/表单/**图表(chart 基于 Recharts)**;客户端与 webadmin 统一 |
| 本地数据库 | better-sqlite3 | 最新(主进程同步 API;需 `@electron/rebuild` 匹配 ABI) |
| 前端 | React 18 + TypeScript + Vite(electron-vite) | 最新 |
| 本地 MCP | @modelcontextprotocol/sdk(Client) | 最新 |
| 截图 | Electron `desktopCapturer` + `nativeImage` | 内置,免依赖 |
| OCR | tesseract.js(纯 JS/WASM,中文 `chi_sim`,traineddata 本地打包) | 惰性加载 |
| 剪贴板 | Electron `clipboard` | 内置 |
| 浏览器控制 | 一期:web_fetch/web_search(HTTP)+ **浏览器插件桥(自研 CDP,固定 127.0.0.1:54321,即装即用)**;无需 Playwright 系统依赖 | 客户端启动即监听,插件安装即直连 |
| 文本编码 | iconv-lite(GBK/Big5 解码) | 随文件工具 |
| 测试 | Vitest(main + renderer) | 最新 |

**客户端架构模型(Electron 三进程):**

```
renderer (React UI) ──contextBridge──▶ preload ──ipcMain──▶ main (Node: 引擎/工具/DB/MCP)
                                                              │
                                                              ▼
                                                      服务端 (HTTPS)
```

#### 3.1.1 工程约定(UI 与复用)

1. **UI 组件一律使用 shadcn/ui,禁止自写 UI 组件**:任何界面元素(按钮/输入框/文本域/卡片/对话框/表格/图表/下拉/开关/提示等)必须来自 shadcn 组件(`components/ui/`,`npx shadcn add` 拉取);业务组件(ChatInput/Messages/ToolCalls/ConfirmModal/ArtifactsPanel 及 webadmin 页面)只做**组合与状态编排**,内部一律用 shadcn 原语,不写自定义样式组件、不写裸 `<button>` 等(样式走 Tailwind 工具类 + shadcn 主题变量)
2. **函数尽量复用,禁止复制粘贴**:同一逻辑只实现一次——
   - 客户端:工具公共逻辑(路径边界 `paths.ts`/`isAllowed`、审批门控、CDP/HTTP 转发、编码检测)抽共享模块;引擎/工具/连接器分层调用
   - 服务端:DAO(serverstore)统一数据访问,util 包统一工具函数(密码/加密/路径安全),公共中间件(鉴权/限流/CSRF)只写一遍挂多路由
   - 双端共享:涉及同语义逻辑(如 bootstrap 字段、JSON-RPC 协议、错误码)以文档契约为准,两端各实现一次转换层,不得内联重复逻辑
3. 判断标准:新增代码前先搜仓库是否已有等价函数/组件;重复 2 次即提取。

- **main 进程**:Agent 引擎、本地工具、better-sqlite3、MCP 运行时、网关客户端、token 存储(不在 renderer 持敏感数据)
- **renderer 进程**:纯 UI,经 preload 的 `window.picoaide.*` API 与 main 通信,流式事件经 ipc 推送
- **preload 脚本**:contextBridge 暴露白名单 API(登录/发消息/事件订阅/设置/确认),contextIsolation 开启

### 3.2 目录结构(仓库全景)

```
picoaide-next/
├── go.mod                        # 单 module:github.com/picoaide/picoaide(服务端)
├── Makefile                      # 构建/测试/打包
├── .github/workflows/ci.yml      # CI:go test + 客户端 test/typecheck/build + 三平台打包
├── cmd/server/main.go            # 服务端网关入口
├── internal/                     # 服务端 Go 代码
│   ├── serverauth/               # 认证(local/LDAP/OIDC/token/admin session)
│   │   ├── provider.go           # PasswordProvider / BrowserProvider 接口 + 注册表
│   │   ├── ldap.go               # LDAP(go-ldap v3,filter 转义;组映射写入 user_groups)
│   │   ├── oidc.go               # OIDC 授权码流(state 绑定 + PKCE)
│   │   ├── token.go              # api_tokens 颁发/校验(hash 存储,过期校验)
│   │   └── admin_session.go      # 管理页 session + CSRF
│   │                            # local 认证实现在 serverstore/users.go(AuthenticateLocal)
│   ├── llmgateway/               # AI 网关(服务端)
│   │   ├── handler.go            # /v1/chat/completions 代理 + 限流
│   │   ├── upstream.go           # 上游路由 + key 解密
│   │   └── models.go             # 模型列表(按组可见性过滤二期)
│   ├── bootstrap/                # 启动配置聚合(GET /api/config/bootstrap:模型+默认模型+建议清单)
│   ├── marketplace/              # 商城(服务端,企业内部分发渠道)
│   │   ├── skill_api.go          # Skill 商城 API(列表/详情/archive)
│   │   ├── skill_pack.go         # Git 源拉取 + tar.gz 打包(浅克隆限额/安全校验)
│   │   ├── mcp_api.go            # MCP 插件商城 API
│   │   └── credentials.go        # 凭证加密存储
│   ├── knowledge/                # 知识库(服务端,全新实现)
│   │   ├── store.go              # 文档/文件夹/标签/权限
│   │   ├── index.go              # 文本抽取 + FTS5 索引
│   │   ├── search.go             # 搜索(前缀查询 + LIKE 兜底)
│   │   ├── mcp.go                # 暴露为远程 MCP 工具
│   │   └── admin.go              # 管理端 API(上传/删除/授权)
│   ├── serverstore/              # 服务端 SQLite
│   │   ├── db.go                 # 打开(WAL)/迁移
│   │   ├── users.go / groups.go / settings.go
│   │   ├── tokens.go / usage.go / skills.go / mcp_servers.go
│   │   └── knowledge.go
│   └── util/                     # 通用工具
│       ├── password.go           # argon2id
│       ├── safe.go               # SafePathSegment 等
│       └── crypto.go             # AES-GCM 加密(凭证/密钥,master key 走 env/0600 文件)
├── desktop/                      # Electron 客户端(TypeScript monorepo 子包)
│   ├── package.json              # name: picoaide-desktop,electron-vite 构建
│   ├── electron-builder.yml      # 三平台打包配置(含 picoaide:// 协议注册/asarUnpack)
│   ├── electron.vite.config.ts   # main/preload/renderer 三段构建
│   ├── src/
│   │   ├── main/                 # 主进程(Node)
│   │   │   ├── index.ts          # app 生命周期、窗口创建、安全策略、协议注册
│   │   │   ├── ipc.ts            # ipcMain 路由注册(与 preload API 一一对应)
│   │   │   ├── cdp_server.ts     # 浏览器插件桥:CDP WebSocket 服务(固定 127.0.0.1:54321,无鉴权)
│   │   │   ├── agent/
│   │   │   │   ├── engine.ts     # AgentEngine:streamText 多步循环 + 审批门控
│   │   │   │   ├── provider.ts   # createOpenAICompatible({baseURL: 自研网关})
│   │   │   │   ├── modes.ts      # Ask / Plan / Craft 三模式
│   │   │   │   └── events.ts     # 流式事件模型(UI 协议)
│   │   │   ├── tools/            # 本地工具
│   │   │   │   ├── filesystem.ts # 文件读/写/编辑/追加/删除/列表/搜索(GBK 检测)
│   │   │   │   ├── terminal.ts   # 命令执行(超时/截断/进程组 kill/审批策略)
│   │   │   │   ├── paths.ts      # 可访问目录边界校验(shared)
│   │   │   │   ├── sandbox.ts    # 本地受限会话(@ai-sdk/sandbox-just-bash)
│   │   │   │   ├── web.ts        # web_fetch / web_search
│   │   │   │   ├── screen.ts     # desktopCapturer 截图
│   │   │   │   ├── ocr.ts        # tesseract.js 惰性加载(本地模型包)
│   │   │   │   └── clipboard.ts  # Electron clipboard
│   │   │   ├── mcp/              # 本地 MCP 插件运行时
│   │   │   │   ├── installer.ts  # 商城拉取/安装(风险弹窗)
│   │   │   │   ├── runner.ts     # stdio(http) Client 生命周期管理
│   │   │   │   └── adapter.ts    # MCP tools → AI SDK tool 适配(高危审批策略)
│   │   │   ├── skill/            # Skill 运行时
│   │   │   │   ├── installer.ts  # 下载/更新/卸载(路径安全校验;提示注入在 engine.ts 内实现)
│   │   │   │   └── loader.ts     # SKILL.md + metadata + scripts
│   │   │   ├── store/            # better-sqlite3 数据层
│   │   │   │   ├── db.ts         # 打开/迁移(WAL)
│   │   │   │   └── conversations.ts / messages.ts / artifacts.ts / settings.ts
│   │   │   ├── gateway/          # 服务端连接器(统一 session.fetch,证书校验生效)
│   │   │   │   ├── config.ts     # Session/BootstrapConfig 类型
│   │   │   │   ├── auth.ts       # 登录/token 存取(safeStorage)/登出
│   │   │   │   ├── bootstrap.ts  # 启动配置拉取(模型/默认模型/建议清单,零配置入口)
│   │   │   │   ├── tls.ts        # 证书 TOFU 指纹校验
│   │   │   │   ├── health.ts     # 离线检测轮询(区分 401/网络错误)
│   │   │   │   ├── remote_mcp.ts # 服务端远程 MCP(知识库)
│   │   │   │   └── marketplace.ts# 商城 API 客户端
│   │   │   └── paths.ts          # 数据目录定位(per-platform)
│   │   ├── preload/index.ts      # contextBridge 白名单 API
│   │   └── renderer/             # React UI
│   │       ├── src/
│   │       │   ├── App.tsx / main.tsx
│   │       │   ├── api/picoaide.ts        # preload API 封装
│   │       │   ├── components/            # ui/(shadcn)+ ChatInput/Messages/ToolCalls/Artifacts/ConfirmModal
│   │       │   ├── pages/                # Login/Main/Settings
│   │       │   └── stores/               # Zustand:chat/auth/connection
│   │       └── index.html
│   ├── tests/                   # E2E/冒烟预留(单测内嵌 src/**/*.test.ts)
│   └── resources/               # 图标/tesseract 模型/安装资源
├── browser-extension/            # 浏览器插件(Chrome MV3):manifest + service worker + content script + 设置页
├── webadmin/                     # 服务端管理页(独立小 React 应用)
│   └── src/                      # Login/Users/Gateway/Usage/Marketplace/Knowledge
├── Dockerfile                    # 服务端多阶段构建(amd64/arm64,多平台镜像)
├── docs/
├── scripts/                      # 打包脚本(NSIS/dmg/deb/AppImage)
└── data/                         # 服务端运行时数据(库/缓存,gitignore)
```

### 3.3 Agent 引擎(核心)

#### 3.3.1 引擎封装(主进程,TypeScript)

```ts
// desktop/src/main/agent/engine.ts
export class AgentEngine {
  private cfg: EngineConfig          // 模型/工作目录/工具开关
  private tools: Record<string, Tool>  // AI SDK tool 注册表(本地 + MCP + 远程 + 沙盒)
  private runs: Map<number, AbortController>  // 每 run 独立 aborter(多会话并发互不影响)

  constructor(cfg: EngineConfig, store: Store, deps: EngineDeps)
  // Ask/Plan/Craft 共用入口
  run(opts: { conversationId: number; content: string; mode: Mode }): Promise<RunHandle>
  cancel(): void                     // 中止当前 run,canceled 事件 + reject 全部挂起审批
  confirm(requestId: string, ok: boolean): void   // 审批流回执
}
```

Agent 骨架(streamText 多步循环,自管步数与审批,不依赖工作流运行时):

```ts
// desktop/src/main/agent/engine.ts — 骨架伪代码(AI SDK API 形状以 Task 2.3 探针实测为准)
import { streamText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'

const provider = createOpenAICompatible({
  name: 'gateway',
  baseURL: `${serverURL}/v1`,        // 自研 Go AI 网关
  apiKey: token,
})

// 高危工具审批门控(引擎层实现):
//   工具 execute 内:needsApproval → emit('confirm_required') → 挂起等待用户回执
//   confirm(requestId, ok)(60s 超时)→ 继续执行或抛拒绝错误回传 Agent
function gate<T>(fn: (input: T) => Promise<unknown>, meta: ApprovalMeta) { ... }

export class AgentEngine {
  // Craft:多步循环,步数上限 20
  async craft(convId: number) {
    const messages = store.messages.list(convId).map(toModelMessage)
    for (let step = 0; step < MAX_STEPS; step++) {
      const result = await streamText({ model, messages, system, tools: this.tools })
      for await (const delta of result.textStream) emit('text_delta', delta)   // 流式
      // 工具在 execute 内执行(含审批门控),完成后读最新一步 toolCalls/toolResults
      //   → emit('tool_start'/'tool_end'/'tool_error') + artifact 检测
      messages = appendStep(messages, result)   // assistant + tool 结果落库(messages 表)
      if (!hasToolCalls(result)) break          // 无工具调用 → 任务完成
    }
  }
  cancel(): void
  confirm(requestId: string, ok: boolean): void   // 审批回执(引擎内部 Promise map)
}
```

#### 3.3.1a 长任务与恢复(消息即状态)

- 办公任务分钟级,失败主因是 LLM/工具错误而非进程崩溃,故**不做状态机级 durable**,采用消息即状态:
  - **持久化**:每步(assistant 消息 + 工具结果)同步写入 `messages` 表;任务开始置 `conversations.status='running'`,结束置 `done`/`failed`
  - **恢复**:重启后扫描 `status IN ('running','executing')` 的会话 → UI 提示"有未完成任务,是否继续" → **重跑 = 截断到最后一条 user 消息**(其后的 assistant/tool 行不进入上下文,标记为历史,防止重复累积),重新发起多步循环;简单可靠,零额外运行时
  - **上下文窗口**:发送给 LLM 的历史最多取最近 50 条消息(超出部分仅存 DB 供 UI 查看,不发送),防长会话 token 膨胀
- **高危审批**:AI SDK v7 原生 `toolApproval`(2026-08-12 裁决:引擎主循环逐个 `confirm_required` → 等回执 → `tool-approval-response`;审批弹窗展示实际命令串/代码/URL,与执行串一致;`ai` 版本锁定 package.json,升级 SDK 必须跑审批回归测试)
- Ask 模式用轻量 `streamText`(无工具、单步);Craft/Plan 用多步循环
- **并发与取消**:每个 run 独立 `AbortController`(多会话并发互不影响);`cancel()` 中止当前 run 并 reject 所有挂起审批;事件流含 `canceled` 类型(见 3.3.3)

#### 3.3.1b 沙盒执行(本地受限会话)

- 不可信代码(Agent 生成的脚本、技能自带的 run.py 等)在**本地**受限会话运行(数据不出本机、离线可用):
  ```ts
  import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash'  // 以实际安装版本 API 为准
  const sandbox = createJustBashSandbox()
  const session = sandbox.createSession()
  const { stdout } = await session.run({ command: 'python3 script.py', timeoutSec: 60 })
  ```
- 用途:`sandbox_exec` 工具(替代/补充本地 terminal)、技能 scripts 执行、产物生成任务
- **边界**:沙盒内无用户文件访问权限;本地执行(非云端);仅时间/输出受限——**网络不受限**(故**敏感内容不进沙盒**、外发走审批门控);需要访问用户授权目录的操作仍走本地工具(文件/桌面/剪贴板)
- 不用 Vercel 云端沙盒:代码会上传第三方云端(与"敏感数据不出本机"冲突)、需生产凭证、离线不可用

#### 3.3.2 Provider(LLM 通道)

```ts
// desktop/src/main/agent/provider.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
// createOpenAICompatible({ name, baseURL: 服务端网关, apiKey: 登录 token })
```

- 客户端一律经网关,不持有上游密钥
- AI SDK 的 OpenAI 兼容 provider 直接对接服务端 `/v1/chat/completions`(streaming 原生支持,SSE 由 SDK 处理,无需手写解析)

#### 3.3.3 事件流(UI 协议)

```ts
// desktop/src/main/agent/events.ts — 主进程经 ipc 推送给 renderer(字段名与实施计划 §0.4.3 完全一致)
export type AgentEvent =
  | { type: 'text_delta'; data: string }
  | { type: 'reasoning_delta'; data: string }
  | { type: 'tool_start'; data: { id: string; name: string; input: unknown } }
  | { type: 'tool_end'; data: { id: string; name: string; output: unknown; duration_ms: number } }
  | { type: 'tool_error'; data: { id: string; name: string; error: string } }
  | { type: 'confirm_required'; data: { request_id: string; op: string; target: string; reason: string } }
  | { type: 'artifact'; data: { path: string; type: string; size: number } }
  | { type: 'done'; data: { usage?: { prompt_tokens: number; completion_tokens: number } } }
  | { type: 'canceled'; data: { reason: string } }
  | { type: 'error'; data: string }
```

renderer 经 preload 暴露的 `window.picoaide.onAgentEvent(cb)` 订阅(底层 ipcRenderer.on),打字机渲染 `text_delta`,工具卡片渲染 `tool_start/end`。cancel 后引擎发 `canceled` 事件并置 `status='failed'`。

#### 3.3.4 三模式

| 模式 | 行为 | 实现 |
|------|------|------|
| Ask | 纯聊天,不调工具 | `tools: {}`(不注册工具),纯 streamText 单步 |
| Plan | 第一轮禁用工具输出计划 → 用户确认 → 转 Craft | 同一会话,第二轮带 tools |
| Craft | 完整 Agent 循环 | 默认全量:tools + 多步循环(步数上限 20) |

### 3.4 本地工具

| 工具名 | 能力 | 安全约束 |
|--------|------|----------|
| file_read | 读取文本文件(编码自动检测:UTF-8/GBK/Big5) | 可访问目录内 |
| file_write / file_edit / file_append | 写/编辑/追加 | 可访问目录内 |
| file_delete | 删除文件 | **高危:审批流弹窗** |
| file_list / file_search | 列目录/搜索 | 可访问目录内 |
| command_exec | 执行命令(60s 默认超时,输出截断 50KB) | 命令审批策略(见下),审批后实际执行串 = 判定串,展示与执行一致 |
| sandbox_exec | 本地受限会话(@ai-sdk/sandbox-just-bash)运行不可信代码/脚本 | 无用户文件权限;时间/输出受限;网络不受限(不可信内容不进沙盒) |
| web_fetch / web_search | HTTP 抓取/搜索 | 大小(默认 5MB)/超时限制;HTML 去脚本转文本;**默认拒绝 loopback/私有/链路本地网段(SSRF 防护,可配置)** |
| screen_capture | 屏幕截图 → base64 | **高危:截屏含密码/OTP 等敏感信息,审批弹窗** |
| screen_ocr | 对截图 OCR | 惰性加载模型(本地打包) |
| clipboard_read / write | 剪贴板 | 读剪贴板属敏感,**读取前审批弹窗** |
| MCP 插件工具 / skill_exec | 商城插件/技能提供的工具 | 见 3.6/3.7:插件工具按风险启发式强制审批;脚本仅本地沙盒执行 |
| browser_tab_info / browser_get_content | 读取浏览器当前页(经插件桥) | 见 3.8:读取类直接可用;内容仅回本机 |
| browser_click / browser_type / browser_navigate / browser_scroll / browser_execute_js | 操作浏览器当前页 | **高危:审批弹窗**(操作类与 executeScript) |

**命令审批策略(防绕过设计)**:判定前**剥离/拒绝全部控制字符(含换行 `\n`、`\r`、`\0`)与裸 `$`(`$(`、`${` 已拒,裸 `$VAR` 也拒)**;含 shell 拼接字符(`;` `&&` `\|\|` `\|` 反引号 `>` `<`)或**首词不在安全白名单**(`ls,cat,pwd,mkdir,cp,mv,echo,head,tail,grep,wc,date,df,du,uname`——**不含 find**,其 `-exec/-delete` 可递归删除)或**路径参数经 realpath 解析后越出可访问目录**(`cat /etc/passwd`、`cat ~/.ssh/id_rsa`)→ 一律审批。**2026-08-12 加固**:他人 home 展开(`~user/...`)、长选项内嵌路径(`--opt=/path`、`--file=/etc/x`)同样一律审批;`pip install` 免审批为白名单外**已记录的例外**(仅限纯包名/白名单旗标参数,任意 URL/索引源/目录安装照常审批)。

**可访问目录模型**:默认 = 用户工作目录(每次对话独立子目录 `workspaces/<conv>/`,零配置开箱即用);客户端**唯一的本地配置项**是"可访问目录"追加列表(本地安全边界,管理员无法替员工决定本机路径,故保留客户端设置;默认不配也完全可用)。**首次越界引导**:工具访问可访问目录外的路径被拒时,弹窗"是否将 X 加入可访问目录?",员工确认后自动加入并重试(旗舰场景如"读桌面文件"一键授权,无需预先配置)。工具越界返回明确错误给 Agent 重试。

**高危操作确认协议(引擎层审批门控)**:

```
Agent 发起高危工具(注册表标记 needsApproval)
→ 引擎在工具 execute 内拦截(不执行):emit('confirm_required', {request_id, op, target, reason})
→ UI 弹窗(操作内容 + 目标路径 + 60s 倒计时,自弹窗可见起算)
→ 用户允许 → engine.confirm(request_id, true) → 继续执行该工具
→ 用户拒绝/超时 → confirm(request_id, false) → 工具抛拒绝错误回传 Agent(循环继续,Agent 可重试其他路径)
```

**并发与容错**:一步内多个高危工具并发 → ConfirmModal 按 `request_id` **串行排队**(一次一个弹窗);引擎对 `confirm_required` 事件**在主进程缓冲**,renderer 就绪后补发(防弹窗丢失);`cancel()` 或会话删除时 reject 全部挂起审批并清理 pending map;审批超时 `setTimeout` 随 confirm/超时/取消清理,防泄漏;引擎**不配置 AI SDK 工具执行超时**(或 ≥ 审批超时 + 余量),防审批窗口被掐断。

### 3.5 本地 SQLite

存储根目录:

- Linux:`~/.local/share/picoaide/`;**Portable 模式(仅 Windows/Linux)**:exe 同目录存在 `portable.txt` → 数据目录 = exe 同目录/data(不可写时回退系统目录),解压即用、数据随程序目录移动
- macOS:`~/Library/Application Support/picoaide/`(一律标准数据目录,不做 portable;dmg 拖入 Applications 即用)
- Windows:`%APPDATA%/picoaide/`;**Portable 模式**同上(数据在 exe 同目录/data)

文件布局:

```
picoaide/
├── picoaide.db          # 主库(WAL 模式)
├── config.json          # 服务端 URL/token(权限 0600)
├── workspaces/<conv-id>/   # 产物(无项目会话)
├── skills/<name>/       # 已安装技能
└── mcp/<plugin-id>/     # 已安装插件配置
```

**项目体系(迁移 0010)**:项目 = 命名工作目录;项目内会话 workspace = `<项目目录>/<会话id>/`(chat:new 时 mkdir,引擎工具 cwd/allowedDirs 以会话 workspace 为基准),无项目会话回退全局工作目录;删除项目仅解绑会话(project_id → NULL,移入"未分类"),不删任何文件。

表结构:

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now','localtime'))
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'ask',            -- ask | plan | craft
  status TEXT NOT NULL DEFAULT 'done',         -- running | done | failed(恢复重跑依据)
  model TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '',
  project_id INTEGER,                          -- 项目归属(删除项目置 NULL)
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                          -- user | assistant | tool
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '[]',       -- assistant 行:工具调用 JSON 数组
  tool_call_id TEXT NOT NULL DEFAULT '',       -- tool 行:与 assistant 的 tool_calls 配对
  tool_name TEXT NOT NULL DEFAULT '',          -- tool 行:工具名
  is_error INTEGER NOT NULL DEFAULT 0,         -- tool 行:执行失败(拒绝/超时/越界)
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_messages_conv ON messages(conversation_id);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file',           -- file|image|report|ppt|docx|xlsx|html
  size INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

> 任务状态即消息历史:恢复 = 截断到最后一条 user 消息重跑(见 3.3.1a),不需要额外状态表。工具调用/结果配对:assistant 行存 `tool_calls` JSON,tool 行以 `tool_call_id`+`tool_name` 配对,失败结果 `is_error=1` 且 content 为错误文本(AI SDK↔DB 双向转换在 Task 2.3 探针验证;**工具失败结果也回传 Agent**,让其重试其他路径)。`workspace` 存绝对路径(相对值按数据目录解析后落库),设置页改动只影响新会话。

### 3.6 本地 MCP 插件运行时

商城返回插件配置:

```json
{
  "id": 3,
  "name": "xiaohongshu",
  "transport": "http",                    // http | stdio
  "command": "npx",
  "args": ["-y", "mcp-server-xiaohongshu"],
  "url": "http://127.0.0.1:3000/mcp",
  "env": {"APP_ID": "<加密下发,客户端解密>"},
  "headers": {"Authorization": "Bearer ..."}
}
```

- `stdio`:本地 spawn,JSON-RPC over stdio,进程生命周期随客户端(崩溃自动重启 1 次为**未实现范围外**,2026-08-12 标记)
- `http`:客户端起 MCP client 直连 URL(本地服务或内网地址)
- MCP client → AI SDK `tool` 适配层(`adapter.ts`),工具暴露给 Agent;**插件工具按风险启发式强制审批**(名称/描述含 delete/remove/write/exec/shell/外发 等 → `needsApproval`),**启发式仅减噪,不作安全边界——真正的硬防线是安装时的风险弹窗**(展示插件名/作者/来源/命令/权限范围,员工知情后决定)
- **管理员授权制(2026-08-12 修订,原"建议安装制"作废)**:启动配置下发的"建议清单"即**已授权**插件;员工仅能安装被授权的插件,安装时从 `/api/marketplace/mcp/:id/config` 拉取配置与凭证(需登录,per-user 限流 + 下载审计;权限经 effective groups 解析);**凭证仅进程内存持有;客户端登录时重拉插件凭证(会话级缓存,不落盘),服务端下架后 config 端点拒绝拉取**
- **安装安全**:第三方插件安装前弹窗风险提示(硬防线,preview nonce 二次确认);stdio `command` 限白名单二进制(如 npx/node/python3/docker,绝对路径),`args` 拒绝 shell 元字符(**客户端运行时同样强制校验**)

### 3.7 Skill 运行时

技能包格式(商城分发,tar.gz):

```
skill-name-v1.2.3.tar.gz
├── SKILL.md            # 指令:行为/用法/边界(注入系统提示词)
├── metadata.yaml       # name/version/author/description/dependencies/entrypoint
├── scripts/            # 可执行部分
│   └── run.py|run.sh|run.go
└── tools/              # 可选:技能自带工具定义(JSON schema)
```

- 加载:SKILL.md → 注入系统提示;scripts → 注册为 `skill_exec <name>` 工具(**在本地受限会话执行**,仅超时+输出截断;需要用户文件的操作仍走本地工具)
- 更新:商城版本检测,手动更新;卸载:删目录 + 移除提示注入
- **管理员授权制(2026-08-12 修订)**:启动配置下发已授权技能清单,员工在设置页自行安装/卸载(未授权不可见,与管理页上架解耦)
- 来源信任:仅商城官方渠道;第三方 skill 首次安装弹窗提示风险
- 技能包自带 `tools/` 工具定义(JSON schema):**本期不实现,二期再注册**(loader 忽略该目录)

### 3.8 浏览器插件桥(CDP)

让 Agent 直接操作员工真实浏览器(读取当前页、点击、输入、导航)——**客户端主进程启动即监听固定端口 54321,浏览器插件直连该端口,即装即用、零配置**,无需 Playwright 等系统依赖。

> **定位:纯本地客户端功能,与服务端完全无关**——数据只在"客户端主进程 ↔ 员工本机浏览器"之间走 WebSocket 直连,不经服务端、不上云、离线可用;Agent 借此获得操作员工自己浏览器(已登录的企业系统、内网页面等)的能力。

```
Electron 主进程                       浏览器(Chrome/Edge)
┌───────────────────────┐  WebSocket  ┌────────────────────────┐
│ cdp_server.ts         │◄───────────►│ 插件 picoaide-bridge    │
│ 固定监听 127.0.0.1:54321│  JSON-RPC   │  (MV3 扩展,后台常连)    │
│ 无鉴权(仅回环地址)      │            │  tabs/activeTab/scripting│
└───────────────────────┘            └────────────────────────┘
```

**服务端(客户端主进程,`cdp_server.ts`)**:

- 应用启动时监听 **固定端口 `127.0.0.1:54321`**(仅绑定回环地址,不对外网开放);端口被占用时启动报错并提示(少见场景,先关占用程序或改设置页可配端口——改动端口后插件侧需同步,默认保持 54321)
- **无鉴权**:零配置优先;安全边界 = 仅回环地址 + 本机进程与客户端同信任级(风险见 §5/§9);操作类工具审批仍由引擎侧把关(见下)
- 协议:JSON-RPC 2.0 over WebSocket,最小 CDP 子集,方法:
  - `browser.tabInfo` → `{url, title}`(当前活动标签)
  - `browser.getContent` → 当前页可读文本(去 script/style)
  - `browser.click(selector)` / `browser.type(selector, text)` / `browser.navigate(url)` / `browser.scroll(direction)`
  - `browser.executeScript(code)`(高危)
- 响应统一 `{id, result | error}`;插件断线自动重连;客户端退出时关闭端口

**插件(`browser-extension/`,Chrome MV3)**:

- **零配置:插件默认直连 `ws://127.0.0.1:54321`,无任何设置页/配置项**,安装即用
- 后台 service worker 维持 WebSocket 连接(断线指数退避重连);content script 执行 DOM 操作(点击/输入/滚动/取内容)
- 权限:`tabs`/`activeTab`/`scripting`(最小集)
- 分发:企业内 `chrome://extensions` 开发者模式加载或组策略下发(README 说明);**用户只需:安装插件 + 打开客户端,即可让 Agent 操作浏览器**;未装插件时浏览器工具返回"插件未连接"明确错误

**工具注册(引擎侧,`browser_*`)**:

| 工具 | 能力 | 安全约束 |
|------|------|----------|
| browser_tab_info / browser_get_content | 读取当前页 URL/标题/文本 | 直接可用(内容仅回本机) |
| browser_click / browser_type / browser_navigate / browser_scroll | 操作当前页 | **高危:审批弹窗**(可能改变用户浏览状态/提交表单) |
| browser_execute_js | 在页面执行任意 JS | **高危:审批弹窗** |

- 审批沿用 3.4 引擎层门控(60s 超时拒绝);插件未连接 → 工具返回明确错误给 Agent 重试
- 读取到的页面内容经 Agent 上下文可能被 LLM 处理——与 web_fetch 同源风险,外发仍走 kb_upload 等审批口

---

## 4. 服务端详细设计

### 4.1 认证

#### 4.1.1 Provider 注册表(参考旧设计,全新实现)

```go
type UserInfo struct { Username, DisplayName, Email string; Groups []string }
type PasswordProvider interface {   // 密码认证:local / ldap
    Name() string
    Authenticate(username, password string) (UserInfo, error)
    Configure(cfg map[string]string) error
}
type BrowserProvider interface {    // 浏览器认证:oidc(与密码认证独立,不继承)
    Name() string
    AuthURL(state string) (string, error)
    HandleCallback(code, state string) (UserInfo, error)
    Configure(cfg map[string]string) error
}
```

- **local**:用户名密码,argon2id 哈希(SQLite users 表)
- **ldap**:go-ldap v3,绑定查询 + 组映射(用户名过 `EscapeFilter` 防注入)
- **oidc**:授权码流 + state 绑定 + PKCE(verifier 服务端存 session,重启失效可接受,注明);服务端回调 `/api/auth/oidc/callback` → **颁发正式 api_token(90 天,与登录 token 同构)** → 重定向 `picoaide://auth?token=...`(客户端注册自定义协议接收;**协议拉起由 OS 弹窗确认;URL 日志风险经此缓解,不缩短 token 时效**);客户端深链处理:解析 token → saveSession → 进入主界面——回调归属明确为服务端(修正旧"本地端口回调"设计)
- webadmin 的"绑定 LDAP 组"管理功能推迟二期(组映射仍用于认证,仅无管理界面)

#### 4.1.2 Token 认证(客户端)

```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256(token),不存明文
  name TEXT NOT NULL DEFAULT 'desktop',
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  expires_at DATETIME NOT NULL,         -- 默认签发 +90 天(§5 过期策略)
  last_used_at DATETIME,
  revoked INTEGER NOT NULL DEFAULT 0
);
```

- 登录:`POST /api/auth/login` → 服务端验证 → 返回 `{token, user}`(user 含 is_admin/status;资源可见性由服务端按用户/部门授权过滤)
- 后续请求:`Authorization: Bearer <token>`;`VerifyToken` 校验:存在 / 未吊销 / **未过期** / 关联用户有效
- 登录限流:10 次/5 分钟(按 IP+用户名;**有界**内存滑动窗口,条目过期清理,防内存膨胀)
- 超管引导:`--bootstrap-admin` 启动参数(env `PICOAI_ADMIN_PASSWORD` 设密码),首次启动无超管时创建;**不提供"首注册即超管"的注册端点**(存在抢先接管与 TOCTOU 风险)
- 服务端管理页另用 session cookie(HttpOnly + SameSite=Lax,可选 Secure)+ CSRF(HMAC 双窗口)

### 4.2 AI 网关

#### 4.2.1 端点

```
POST /v1/chat/completions        # OpenAI 兼容,支持 stream=true(SSE)
GET  /v1/models                  # 用户可见模型列表
GET  /api/config/bootstrap       # 启动配置(登录后拉取):模型列表 + 默认模型 + 技能建议 + MCP 建议
```

`bootstrap` 返回内容示例(字段名固定,客户端 `BootstrapConfig` 与之对齐):

```json
{
  "default_model": "deepseek-chat",
  "models": [{"id": "deepseek-chat", "display_name": "DeepSeek Chat"}],
  "skills": [{"name": "ppt-gen", "version": "1.2.0", "description": "..."}],
  "mcp": [{"id": 3, "name": "xiaohongshu", "description": "...", "recommended": true}],
  "web": {"allow_private": false, "search_endpoint": ""}
}
```

- `web.allow_private`(web_fetch 是否允许私有网段)与 `web.search_endpoint`(web_search 端点)由管理员配置,随 bootstrap 下发(webadmin 网关页可设)
- 默认模型由管理员在管理页网关页配置(**保存时校验 `default_model` 属于 enabled 的 provider/models,防误配导致全员 502**),随启动配置下发——**员工零选择、零配置**。客户端每次启动拉取 bootstrap(登录态期间),设置页提供"刷新"按钮,管理员改动后重启客户端或手动刷新生效。

#### 4.2.2 流程

```
客户端 → 网关(鉴权+限流+计量) → 上游路由 → 流式回传
```

网关侧 per-user 限流(令牌桶,默认 60 请求/分钟,可配置),防 token 泄露后被无限刷 LLM。

上游路由表(服务端 settings 配置):

| 上游 | 协议 | 实现 |
|------|------|------|
| openai / openrouter / qwen / glm / deepseek | OpenAI 兼容 | 直通转发(请求体/SSE 原样转) |
| anthropic | Anthropic Messages API | 请求/响应格式转换(二期) |

#### 4.2.3 计量

```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_usage_user_time ON usage(user_id, created_at);
```

- 流式场景:从 SSE 流末段 usage 字段取 token,会话结束落库
- 管理页:按用户/模型/时间聚合图表

#### 4.2.4 密钥管理

- 上游 key 存 `gateway_providers.api_key_enc`(展平 KV 仅为 settings 表,**密钥不落 settings**),AES-GCM 加密落盘
- master key 来自 `PICOAI_MASTER_KEY` 环境变量,未设置则首次启动生成 32 字节随机密钥写 `data/master.key`(权限 0600);**master key 不存数据库**(与密文同库则加密形同虚设)
- 管理页配置,超管可见(掩码展示)

### 4.3 Skill 商城

```
GET  /api/marketplace/skills                  # 列表(元数据)
GET  /api/marketplace/skills/:name            # 详情
GET  /api/marketplace/skills/:name/archive    # 下载 tar.gz 包
POST /api/admin/skills                        # 上架(Git 源 URL + metadata)
DELETE /api/admin/skills/:name                # 下架
PUT  /api/admin/skills/:name                  # 更新
```

- 存储:`skills` 表(名称/版本/描述/作者/Git 源/校验和/上架时间)
- 打包:服务端 clone Git 源(**浅克隆** + 仓库大小上限,如 >200MB 拒绝)→ 校验 metadata.yaml → tar.gz → 缓存目录 `data/skills-cache/`(构建新版本时清理旧包)
- 校验:包内文件名白名单(拒绝绝对路径/`..`/**symlink/hardlink 条目**),大小上限(默认 100MB);技能名过 `SafePathSegment`
- **授权制(2026-08-12 修订)**:`/api/marketplace/skills` 为已授权清单(未授权 404);archive 下载需登录且已授权

### 4.4 MCP 插件商城(管理员授权制)

```
GET  /api/marketplace/mcp                     # 已授权清单(客户端可见,仅 enabled,脱敏)
GET  /api/marketplace/mcp/:id/config          # 安装时拉取配置+凭证(需登录+已授权,加密传输)
POST /api/admin/mcp                           # 上架(transport/command/args/url/env/headers)
PUT/DELETE /api/admin/mcp/:id                 # 编辑/下架
```

- **无 grants 授权**:管理员只负责上架/配置/启停,员工自行决定是否安装(企业内可信环境,凭证按插件粒度在安装时下发)
- 凭证:env/headers 内敏感值 AES-GCM 加密;`/config` 需有效 token,且**仅 enabled 插件可拉取(下架后拒绝)**;**per-user 限流 + `mcp_config_downloads` 审计表**(user_id/mcp_id/时间,管理页可查批量导出行为)
- **凭证生命周期**:客户端凭证不落盘,每次启动在登录态下重拉;服务端轮换凭证后,客户端重启/刷新即生效

### 4.5 知识库(全新实现)

#### 4.5.1 存储与检索

- 文档/文件夹/权限/审计:SQLite(表结构参考旧 knowledge 域,全新实现;标签表本期不建)
- 全文检索:**SQLite FTS5**(unicode61,连续汉字为单 token,**前缀查询 `"词"*` + LIKE 兜底**;分词扩展二期评估——注意 modernc 纯 Go 驱动不支持 C 扩展加载,若需 jieba 类分词须换 CGO 驱动)
  - ✅ 已落地(2026-08):FTS5 **trigram** 索引(modernc 内置,免 CGO)+ 词长分流;中文子串命中;Go 侧加权 Jaccard 相关性打分(0.4 单字 + 0.6 二元组,标题 40%/正文 60%,正文窗口锚定首个命中位)
- 向量检索(二期可选):纯 Go 嵌入模型(m3e/bge-small 经 ONNX)或调用服务端网关 embedding API
  - ✅ 已落地(2026-08):网关 `/v1/embeddings` 代理 + 进程内 Embedder(渠道故障转移);`kb_chunk_embeddings`(L2 归一化 float32 BLOB)+ 暴力余弦扫描(上限 5 万块);混合 = 词法 top-100 ‖ 向量 top-100 → **RRF(k=60)融合**;无模型/上游失败自动降级纯词法
- 上传:管理页/API 导入(txt/md/docx/pdf → 文本抽取)

#### 4.5.2 远程 MCP 暴露

```
POST /api/mcp/knowledge/message    # JSON-RPC 请求/响应(一期)
GET  /api/mcp/knowledge/sse        # SSE(二期,若需流式)
```

工具集:`kb_search(query, page, page_size)`、`kb_read(doc_id)`、`kb_list(folder_id)`、`kb_upload(title, content, folder_id)`
权限:按用户 + 文件夹授权(参考旧 KBFolderUser/KBFolderGroup,全新实现);**kb_read 校验文档所属 folder 可访问,kb_upload 校验目标 folder 授权**,search 仅返回可访问 folder 内结果

### 4.6 服务端 SQLite 总表

```
users / groups / user_groups / settings(展平 KV)
api_tokens / usage
gateway_providers / models
skills / mcp_servers / mcp_config_downloads
admin_sessions
kb_folders / kb_documents / kb_folder_users / kb_folder_groups / kb_audit_logs
```

迁移:版本化迁移(参考旧 store/migrations 模式,全新实现),`schema_migrations` 表记录版本。

### 4.7 极简 Web 管理页

独立小 React 应用(`webadmin/`,**与客户端统一使用 shadcn/ui + Tailwind**,Table/Button/Dialog/Input 等现成组件),打包后由服务端静态服务:

| 页面 | 功能 |
|------|------|
| 登录/登出 | 超管账号(session cookie);登出删除 session |
| 用户 | 增删改查、禁用/删除(组管理二期) |
| 网关 | 上游 key 配置(加密)、模型列表管理、**默认模型设置(校验属于 enabled 模型,随启动配置下发)**、web 抓取私有网段开关 |
| 用量 | usage 聚合图表(按日/用户/模型) |
| Skill 商城管理 | 上架/下架/更新 |
| MCP 商城管理 | 插件上架/编辑/下架(无授权,员工自选安装)、**凭证下载审计** |
| 知识库 | 上传/删除文档、文件夹权限(阶段 4 完善) |

---

## 5. 安全设计

| 面 | 措施 |
|----|------|
| 密码 | argon2id(本地账号) |
| token | 只存 SHA-256 hash;支持吊销;**过期策略(默认 90 天,expires_at 校验)** |
| 上游密钥/插件凭证 | AES-GCM 加密落库;HTTPS 传输;管理页掩码;master key 走 env/0600 文件(不落库) |
| 客户端 token | Electron safeStorage(OS 密钥链)优先;**Windows 无密钥链时回退不落盘(每次启动重登)**,其余平台回退 config.json 0600 |
| 超管引导 | `--bootstrap-admin` 需 env `PICOAI_ADMIN_PASSWORD`(缺失则启动失败,不打印密码到日志) |
| master key | env `PICOAI_MASTER_KEY` 或 `data/master.key`(0600);**data 目录 0700**;轮换无(列为已知限制) |
| 高危操作 | 删除/截屏/剪贴板读取/命令审批/kb_upload/浏览器操作类工具 → UI 确认弹窗(60s 超时拒绝,自弹窗可见起算);弹窗展示**实际命令串/代码/URL**(与执行串一致);命令按"白名单+无拼接+路径边界"判定(拒绝控制字符/裸 `$`/find/`~user`/`--opt=/path`) |
| 浏览器插件桥 | 仅绑定回环地址 127.0.0.1:54321(不对外网开放);**无鉴权(零配置)——本机任意进程可连,与客户端同信任级(2026-08-12 裁决:信任模型=本机进程即员工本人,属设计内行为非安全边界,风险见 §9)**;插件未连接时工具明确报错 |
| 插件工具 | MCP 插件工具按风险启发式强制审批(动词表:delete/remove/write/exec/shell/http/post/put/send/upload/publish/push/sync/purge/clear/truncate/unlink/rm 等,大小写不敏感,**best-effort 仅减噪,安全边界=安装弹窗(preview nonce 二次确认)**);stdio 命令白名单客户端运行时强制校验 |
| 插件凭证 | 仅登录且已授权用户可拉取;per-user 限流 + 下载审计;仅 enabled 可拉;加密传输;客户端仅内存持有(登录重拉,会话级缓存) |
| 文件越界 | 可访问目录白名单(默认工作目录,realpath 校验) |
| Skill 包安全 | 文件名白名单/无 symlink/大小上限/浅克隆限额/第三方来源风险提示 |
| 登录爆破 | 10 次/5 分钟限流(有界窗口) |
| 网关滥用 | per-user 令牌桶限流 + 计量 |
| 管理端 | 超管 + session cookie(HttpOnly + SameSite=Lax)+ CSRF(HMAC,按小时滚动双窗口) |
| 传输 | 全链路 TLS(localhost 例外,登录页拒绝非 HTTPS 远程地址);自签证书 → 客户端 TOFU 指纹(首次弹窗信任并存储,后续不匹配拒绝) |
| LDAP | 用户名过滤转义(EscapeFilter)防注入 |
| 知识库 | FTS5 查询词转义(剥离引号/控制字符);kb_read/kb_upload 逐操作权限校验 |

---

## 6. 错误处理与边界

| 场景 | 处理 |
|------|------|
| 服务端不可达 | 客户端离线态,可浏览历史;新任务提示需联网;自动重连;**401 与网络错误区分:token 过期 → 提示重新登录** |
| 上游 LLM 失败 | 网关 502 + 错误体;客户端重试 1 次,失败展示错误 |
| 工具超时 | command 默认 60s;超时结果回传 Agent |
| 浏览器插件未连接 | browser_* 工具返回"插件未连接"明确错误,Agent 可重试或换 web_fetch |
| Agent 死循环 | 步数上限默认 20;超限提示"继续/停止"("继续"= 以当前消息上下文重新发起 run,步数重置) |
| 高危确认超时 | 默认拒绝(自弹窗可见起算;主进程缓冲事件,renderer 就绪补发;多弹窗串行排队) |
| 任务中断 | `status` 标记(running/executing),重启后提示"继续"(截断到最后 user 消息重跑);历史消息全部保留 |
| 用户取消 | 每 run 独立 AbortController;canceled 事件;status 置 failed;挂起审批全部拒绝 |
| 运行中会话被删除 | 删除前先 cancel 该会话任务;引擎落库对"会话不存在"容错(跳过并记日志) |
| MCP 插件崩溃 | 自动重启 1 次,再失败停用并提示 |
| 磁盘不足 | 产物写入失败 → UI 提示,不崩溃 |
| 会话删除 | 级联删 messages/artifacts,产物目录可选删除 |
| 服务端重启 | usage 落库不丢(流式会话开始先落待定行,结束回填;**启动时清理 1 小时前未回填的全零待定行**);token 有效期内不受影响 |

---

## 7. 测试策略

| 层 | 内容 | 工具 |
|----|------|------|
| 服务端单元 | 认证/token/网关转发/限流/计量/商城 API/知识库检索 | Go testing + httptest |
| 服务端集成 | 登录→拉技能→拉 MCP 配置→知识库查询全链路 | Go integration tests |
| 客户端单元 | localstore/工具/会话/MCP runner/skill loader | Vitest |
| 客户端集成 | 引擎 + mock Provider 的完整 Craft 流(含审批门控) | Vitest + mock model |
| UI 单测 | 组件渲染/状态(少量) | Vitest + Testing Library |
| E2E(阶段 4) | 打包后冒烟:登录→对话→工具→产物 | 冒烟脚本 + Playwright(Electron) |

每个非平凡逻辑模块必须带至少一个可运行测试(Go `_test.go` / TS `*.test.ts`),CI 跑 `make check`。

### 7.1 AI 全自动化测试(测试即代码)

**定位:AI 是测试生成者,CI 是执行者,全链路无人值守自动化。**

- **AI 生成测试**:每个任务完成实现后,由 AI 编码代理读取实现代码,自动生成/补全:单元测试(正常/边界/异常分支)、mock(模型/上游/IdP/进程)、E2E 脚本;生成后必须经"红-绿"验证(先看测试失败于未实现行为,再看实现后通过),禁止"为绿而绿"的测试
- **执行自动化**:所有测试进 CI(GitHub Actions)——job1 Go 全量、job2 desktop Vitest+typecheck+build、job3 webadmin build、阶段 4 追加三平台测试+打包矩阵(ubuntu/windows/macos runner 各跑本平台 npm test 与打包)
- **审批测试钩子**:引擎支持 env 钩子(`PICOAI_TEST_AUTO_APPROVE=1` 自动允许 / `=0` 自动拒绝),**仅测试/CI 构建启用,打包产物不含钩子路径**,E2E 无需人工点弹窗;单测仍直接测 `confirm(requestId, ok)` 全分支
- **浏览器插件 E2E**:Playwright 驱动真实 Chrome/Edge 加载 `browser-extension/`(MV3),连接真实客户端 CDP 端口,断言 tabInfo/getContent/click/navigate 全链路(CI 用 `xvfb-run` 无头)
- **自动化覆盖边界(保留人工)**:
  - 真实企业环境联调(真实 LDAP/OIDC 服务器、真实内网系统/页面)——CI 无法复现,阶段验收人工
  - 手感/视觉体验(真实窗口动画、滚动流畅度)——人工抽查
  - 其余全部(后端/主进程/renderer/插件/打包产物冒烟)自动

---

## 8. 实施阶段(共 4 阶段)

### 阶段 1 — 服务端网关(约 2-3 周)

1. 仓库骨架:go.mod、Makefile、目录、CI(GitHub Actions:go test + 客户端 test/typecheck/build + **服务端交叉编译验证 amd64/arm64**)
2. serverstore:迁移框架 + users/groups/settings/tokens/usage 表
3. serverauth:local + LDAP + OIDC + token 颁发/校验(过期)+ 超管引导(--bootstrap-admin)
4. llmgateway:OpenAI 兼容代理(openai 系直通)+ 限流 + 计量 + 模型列表
5. marketplace:skill 打包下载 + mcp 配置分发 + 凭证加密
6. knowledge:存储 + FTS5 检索(前缀查询 + LIKE 兜底)+ 远程 MCP(请求/响应式)
7. webadmin:管理端 API(session/CRUD/聚合)+ 登录/用户/用量/商城管理页

**验收**:curl 全链路:超管引导 → 登录拿 token → 网关流式对话 → 拉技能包 → 拉 MCP 配置 → 知识库查询,全部通过;`make test` 绿。

### 阶段 2 — 客户端骨架(约 2-3 周)

1. Electron 脚手架(electron-vite)+ React + 登录页
2. localstore:会话/设置表 + 迁移
3. agent 引擎:AI SDK 接入 + gateway provider + Ask 模式 + 探针验证(流式/多步/审批门控)
4. React 聊天 UI:消息流、打字机、会话列表
5. gateway 客户端:登录/token 持久化(safeStorage)/离线检测/TLS TOFU 指纹

**验收**:桌面端登录服务端,Ask 模式完成对话,会话持久化,重启恢复。

### 阶段 3 — 本地能力(约 3-4 周)

1. localtools:文件/终端/web/屏幕/OCR/剪贴板
2. Craft 模式全流程 + 产物面板 + 高危确认弹窗
3. Plan 模式
4. localskill:下载/注入/执行(本地沙盒)
5. localmcp:stdio + http 插件运行
6. 可访问目录设置页

**验收**:"汇总桌面 Word 成 500 字汇报存回桌面"完整跑通;安装调用一个小红书类 MCP 插件成功;高危删除有确认弹窗。

### 阶段 4 — 产品化(约 2-3 周)

1. 三平台打包(NSIS / dmg(**含 Apple Silicon arm64**)/ deb+AppImage;Windows/macOS 由 CI 矩阵产出)+ **服务端 Docker 镜像(`linux/amd64` + `linux/arm64`,ghcr.io 分发)** + **浏览器插件 zip 产物**
2. webadmin 用量/管理完善(含知识库页)
3. 文档全套(docs/)
4. 性能优化:OCR 惰性加载、流式渲染节流、SQLite WAL 检查点、消息分页
5. E2E 冒烟测试

**验收**:全新机器下载→安装→登录→完成真实办公任务;CI 一键出三平台客户端包 + 双架构服务端镜像 + 插件包。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| AI SDK 版本 API 变化(流式/多步/工具) | 高 | Task 2.3 探针先行验证;引擎多步循环与审批门控自管,不依赖易变 API(探针不过立即改设计) |
| 三平台本地工具差异(路径/OCR/权限) | 中 | 工具层 platform 抽象;CI 三平台构建;阶段 3 逐平台验证 |
| tesseract.js 中文模型下载/打包(chi_sim ~20-40MB) | 中 | traineddata 打包进安装包(resources/),langPath 本地加载,asarUnpack;惰性加载 |
| better-sqlite3 原生模块 ABI 不匹配 | 中 | `@electron/rebuild` postinstall;electron-builder 自动 rebuild |
| 全新重写周期长 | 高 | 严格按阶段验收推进;每阶段可独立发布验证 |
| 中文全文检索效果 | 中 | unicode61 + 前缀查询(`词*`)+ LIKE 兜底;二期引入分词/向量 |
| 服务端被内部滥用 | 中 | 限流(登录 + 网关双口)+ 计量 + 管理页监控 |
| 任意登录员工可拉取全部插件凭证(建议安装制固有) | 中 | 企业内可信环境;凭证按插件粒度最小化;per-user 限流 + 下载审计可追溯;二期可加组可见性 |
| 本地账号部署下无组映射(知识库组权限不可用) | 低 | 知识库以用户级授权兜底;组管理二期 |
| 浏览器插件依赖员工手动安装/企业分发 | 中 | 插件安装说明入 README;组策略下发;未装插件时工具明确降级(web_fetch 兜底) |
| CDP 端口无鉴权(零配置的代价):本机恶意进程可连端口操控浏览器 | 中 | 仅回环地址缩小暴露面;本机进程与客户端同信任级(能读文件者本就能作恶);操作类能力经插件最小权限实现;如安全要求高,升级路径=设置页启用 token(插件同步,默认关闭) |

---

## 10. 开放问题(实施中决策)

1. FTS5 中文分词最终确认(unicode61 前缀 vs trigram,实施时用真实数据验证)
2. 知识库向量检索是否二期引入(默认二期)
3. anthropic 上游转换一期还是二期(默认二期)
4. web_search 端点选型(可配置搜索 API,实施期定)
5. docx/pdf 文本抽取库选型(阶段 4 实现,默认 txt/md 先行)
6. 浏览器插件分发方式(开发者模式加载 vs 组策略;插件商店不上架)

---

## 11. 文档计划

| 文档 | 时机 |
|------|------|
| docs/01-architecture.md | 阶段 4(任务 4.3)集中编写,内容以实际代码为准 |
| docs/02-build-deploy.md | 同上 |
| docs/03-api-reference.md | 同上 |
| docs/04-auth.md | 同上 |
| docs/05-agent-system.md | 同上 |
| docs/06-database.md | 同上 |
| docs/07-marketplace.md | 同上 |
| docs/08-development.md | 同上 |
