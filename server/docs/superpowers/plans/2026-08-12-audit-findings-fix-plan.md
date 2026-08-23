# 全项目审计发现与修复计划(2026-08-12)

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

> **执行状态(2026-08-12 晚)**:批次 1-5 全部执行完毕,commit 序列见 `git log`(约 50 个 commit,`fix:`/`feat:`/`docs:`/`test:` 前缀)。`make check` 全绿(服务端 go test + 客户端 633 用例 + typecheck)。手工冒烟清单见下。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-08-12 六路并行审计发现的全部 90 个问题(高危 6 / 中危 ~40 / 低危 ~45),按安全边界 → 数据正确性 → 权限体系 → 资源健壮性 → UI/契约/文档 五批执行。每任务 TDD 红-绿-commit;所有安全边界类修复必须附回归测试证明绕过已封死。

**Architecture:** 不改动整体架构。安全类修复集中在:客户端命令门控(`tools/terminal.ts`)、审批展示(`agent/engine.ts`)、正则防护(`tools/filesystem.ts`)、MCP 命令白名单(`mcp/integration.ts`);权限类修复集中在服务端 `serverstore`(全员组 seed、NOCASE 统一、effective groups);契约类以修订 AGENTS.md + 设计文档为准(保留 SDK 审批)。

**Tech Stack:** Go 1.24 / TypeScript / Vitest(无新依赖)

**设计文档:** docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md(修订见批次 5)

---

## 0. 决策记录(2026-08-12,用户已拍板)

| # | 议题 | 裁决 |
|---|---|---|
| D1 | 审批门控用 AI SDK v7 原生 `toolApproval`,违背 AGENTS §2.4「不依赖任何 SDK 的审批 API」 | **保留 SDK 审批**;修订 AGENTS.md/设计文档记录该决策 + `package.json` 锁定 `ai` 版本 + 每次升级必须跑审批相关测试 |
| D2 | CDP 桥 127.0.0.1:54321 无鉴权,任意本地进程可驱动浏览器 | **保留为设计信任边界**(本机 = 员工本人);修订文档写明真实边界,删除「引擎审批门控兜底」的错误注释;后续版本可做 capability token |
| D3 | 文件工具在主进程同步执行,FIFO 可挂起整机 | 保留;在 `file_read`/`file_list` 跳过非常规文件(`st.isFile()`)作为缓解 |
| D4 | `pip install` 免审批(白名单外) | 保留(办公高频);修订 spec §3.4 契约明确记录该例外 |
| D5 | 商城/知识库为授权制,spec §4.4 仍写「建议安装制」 | 修订 spec(AGENTS.md §2.7 为准) |

---

## 1. 问题总览(90 项)

严重度:C=critical H=high M=medium L=low;类别:bug / design / security / contract / doc。批次列对应 §2-§6。

### 1.1 服务端(37)

| ID | 位置 | 严重度 | 类别 | 描述 | 批次 |
|---|---|---|---|---|---|
| S1 | `serverauth/admin.go:343-355` | H | bug | 给 LDAP/OIDC 用户设密码 → `Source=local` → 永久踢出 IdP 登录 | 3 |
| S2 | `llmgateway/handler.go:99-135` | H | bug | failover 时渠道 override 按首个 provider 改写请求体,后续 provider 收到污染参数 | 2 |
| S3 | `serverstore/gateway.go:122-138` | H | bug | 模型名重复 → `UNIQUE` 冲突 → provider 半同步 + 500 | 4 |
| S4 | `serverauth/admin.go:107` | M | design | admin 登录绕过 auth.mode,ldap-only 下过期本地管理员仍可登录 | 3 |
| S5 | `serverstore/departments.go:74` | M | bug | 全员组无 seed、不可创建,却为授权必需 → 全员授权功能失效 | 3 |
| S6 | `llmgateway/channels/deepseek.go:28-33` | M | design | deepseek override 无条件作用于所有模型(reasoner 400、采样参数被弃) | 4 |
| S7 | `serverauth/oidc.go:61` | M | bug | OIDC discovery 无超时,IdP 挂起阻塞启动 | 4 |
| S8 | `llmgateway/admin.go:45-59` | M | design | 同步上游 /models 在 admin 请求内,最长 120s | 4 |
| S9 | `serverauth/admin.go:117-125` | M | design | 反代后 cookie 无 Secure(仅看 `c.Request.TLS`) | 4 |
| S10 | `cmd/server/main.go:152` | M | bug | http.Server 无任何 timeout(slowloris) | 4 |
| S11 | `serverauth/ldap.go:110` | M | bug | LDAP 用户名大小写 → 重复账号/授权分裂 | 3 |
| S12 | `serverauth/ratelimit.go:44-84` | M | design | 登录限流每次尝试 O(n) 全表清扫(CPU DoS) | 4 |
| S13 | `serverstore/departments.go:160-162` | M | bug | DeleteDepartment 授权计数 BINARY 比较,大小写变体授权可孤儿化/复活 | 3 |
| S14 | `llmgateway/routes.go:18` | M | bug | 非流式 120s 全量 timeout 截断长生成 | 4 |
| S15 | `serverauth/handler.go:97-100` | M | design | OIDC 无 login-CSRF 绑定(state 不绑浏览器) | 3 |
| S16 | `llmgateway/handler.go:347-362` | M | bug | 流 idle-timeout 不清 pending usage 行,计量虚增 1 小时 | 4 |
| S17 | `llmgateway/admin.go:182-270` | M | design | provider 无法禁用/清空 key(enabled 列不可写) | 4 |
| S18 | `llmgateway/channels/channel.go:66` | M | bug | 模型同步 `io.ReadAll` 无上限 | 4 |
| S19 | `llmgateway/embedding.go:113-204` | M | bug | 4xx 不 failover;0-token 行被误删;每请求新建 client+重复 MatchModels | 4 |
| S20 | `llmgateway/admin.go:272-369` | M | design | 删默认模型/provider 后 `gateway.default_model` 悬空 | 4 |
| S21 | `serverstore/db.go:21-33` | M | bug | `PRAGMA foreign_keys` 仅作用于单连接(已实测 16 连接池 1 条 FK 违规成功) | 3 |
| S22 | `serverstore/departments.go:97-177` | M | bug | UpdateDepartment 空名破坏级联;DeleteDepartment 非事务 TOCTOU | 3 |
| S23 | `serverstore/knowledge.go:234-241` | M | design | GrantFolderGroup 用 GetOrCreateGroup → 拼错即建幽灵部门 + 绕过全员保留名 | 3 |
| S24 | `marketplace/admin.go:90-187` | M | design | 单授权端点不校验组存在性(拼错静默永不生效) | 3 |
| S25 | `knowledge/admin.go:560-590` | H | bug | deleteFolder 不查子文件夹 → 删除后子文件夹悬挂 | 3 |
| S26 | `knowledge/lexical.go:108-114` | M | bug | contentWindow 锚点按单 rune 匹配,拉丁长文深命中得 0 分 | 5 |
| S27 | `marketplace/skill_api.go:327` | H | bug | getMCPConfig 用平铺 UserGroups 而非 effective groups → 子部门/主管/全员授权拉不到配置 | 3 |
| S28 | `knowledge/admin.go:201-205` | M | bug | JSON 上传不校验 folder_id → 孤儿文档 | 3 |
| S29 | `knowledge/mcp.go:143-150` | M | bug | admin kb_search 回退路径走授权过滤而非 SearchAll | 5 |
| S30 | `serverauth/handler.go:180-211` | L | bug | provisionUser 竞态窗口 nil 解引用 panic | 5 |
| S31 | `util/password.go:36-58` | L | bug | 空 hash 任何密码可验证;mem/iter/par 无上限 | 5 |
| S32 | `util/crypto.go:29-49` | L | bug | EnsureMasterKey 读-写 TOCTOU(双进程首启) | 5 |
| S33 | `serverauth/handler.go:73-79` | L | bug | Bearer 大小写敏感(违反 RFC6750) | 5 |
| S34 | `serverauth/admin.go:157-474` | L | bug | 用户列表 page 溢出;usage from/to 解析错误被忽略;聚合返回数字 ID 而非用户名;createUser 不校验 status | 5 |
| S35 | `llmgateway/handler.go:285-313` | M | design | 上游响应头未过滤(Set-Cookie 落到客户端) | 4 |
| S36 | `llmgateway/handler.go:175-235` | M | bug | max_tokens/max_completion_tokens 冲突;JSON 经 float64 回环丢精度;base URL 仅支持裸 /v1 | 4 |
| S37 | `cmd/server/main.go:148` | L | contract | NoRoute 返回纯文本 404,非错误信封 | 5 |

### 1.2 客户端主进程(33)

| ID | 位置 | 严重度 | 类别 | 描述 | 批次 |
|---|---|---|---|---|---|
| D1 | `tools/terminal.ts:155-213` | C | security | **审批绕过(实测)**:`~root/...` 他人 home 展开、`--opt=/path`、`X=/path` 跳过路径校验,可无审批读写 allowedDirs 之外 | 1 |
| D2 | `agent/engine.ts:1009-1019` | H | security | 审批弹窗不显示实际命令/代码(`(command, timeoutSec)` 摘要),盲批 | 1 |
| D3 | `tools/filesystem.ts:220-390` | H | bug | ReDoS:`(a\|aa)+$` 类歧义回溯通过检查,主进程同步匹配 1MB 冻结整机 | 1 |
| D4 | `ipc.ts:424-447` | H | bug | 他会话运行时 editAndRerun 先删消息后抛错(数据丢失);不校验 messageId 归属 | 2 |
| D5 | `index.ts:249-287` | H | bug | 每条消息重建工具注册表 → MCP stdio 子进程泄漏 + 重拉插件凭证(10 条消息耗尽 30次/时限额) | 4 |
| D6 | `ipc.ts:310` | H | bug | moveProject 不更新 workspace 列 → 安全边界漂移到旧项目;deleteProject 同理留悬空 | 2 |
| D7 | `gateway/tls.ts:95-103` | H | security | TOFU 首次信任无用户确认;`trusting_cert` 状态被 renderer 丢弃;证书轮换卡死登录页无恢复入口 | 4 |
| D8 | `mcp/integration.ts:49-59` | M | security | stdio MCP 命令/args 无白名单与元字符校验(违背 spec §3.6) | 1 |
| D9 | `plugin_ipc.ts:187-237` | M | security | 风险确认 `confirmed:true` 可被任意 renderer 代码跳过(二次确认门是软的) | 1 |
| D10 | `cdp_server.ts:1-8,118-128` | M | design | CDP 桥无鉴权转发 browser.*(见决策 D2,文档修订) | 5 |
| D11 | `tools/web.ts:212-219` | M | bug | web_search 走全局 fetch,绕过 TOFU/证书校验 | 1 |
| D12 | `session_cache.ts:64-79` | M | design | 恢复会话跳过 validateServerURL(HTTP 远程地址可被持久化利用) | 1 |
| D13 | `agent/engine.ts:856-874` | M | design | 边界引导把文件路径(非目录)存入 allowed_dirs | 2 |
| D14 | `agent/attachments.ts:22-26` | M | bug | 附件边界检查不解析符号链接 | 1 |
| D15 | `agent/engine.ts:984-986` | M | bug | 文本内任意绝对路径被误判为 artifact;Windows 路径不识别 | 5 |
| D16 | `store/messages.ts:29-45` | M | bug | appendMessage 不更新 conversations.updated_at,侧栏排序失真 | 2 |
| D17 | `ipc.ts:313-348` | M | bug | chat:attach 批量文件后置校验失败留下半写文件 | 2 |
| D18 | `gateway/auth.ts:44-49` | M | security | gatewayFetch 静默回退全局 fetch,绕过 TOFU | 1 |
| D19 | `mcp/integration.ts:28-30` | M | bug | MCP 工具名冲突静默覆盖 | 4 |
| D20 | `ipc.ts:636-643` | M | security | 无 IPC senderFrame 校验,特权通道任意 renderer 代码可达 | 1 |
| D21 | `plugin_ipc.ts:153-163` | M | security | settings:allowedDirs 接受 `/` 与驱动器根(整个文件系统) | 1 |
| D22 | `skill/integration.ts:9-13` | M | design | SKILL.md 注入系统提示无大小上限(AGENTS.md 有 4096 上限) | 4 |
| D23 | `agent/engine.ts:904-905` | L | bug | confirm_required.tool_call_id 是 approvalId 而非 toolCallId,renderer 关联失效 | 5 |
| D24 | `agent/engine.ts:763-764` | L | bug | 错误路径 pendingQueue 条目泄漏 | 5 |
| D25 | `tools/paths.ts:28-44` | L | bug | macOS 大小写不敏感文件系统未处理;isAllowed 检查-使用 TOCTOU | 5 |
| D26 | `tools/filesystem.ts` | L | design | 同步 fs,FIFO/设备文件挂起主进程(决策 D3 缓解) | 5 |
| D27 | `tools/terminal.ts:111` | L | bug | 取消的命令以退出码 1 呈现,与真实失败混淆 | 2 |
| D28 | `tools/filesystem.ts:254` | L | bug | file_write 忽略既有编码(GBK 文件被 UTF-8 覆盖) | 2 |
| D29 | `tools/web.ts:146-158` | L | bug | webFetch 外部信号已中止时不生效,跑满自身超时 | 5 |
| D30 | `cdp_server.ts:43,126` | L | bug | pending 按请求 id 键控,跨客户端 id 碰撞 | 5 |
| D31 | `tools/screen.ts:24-26` | L | bug | screen_capture 仅主屏 | 5 |
| D32 | `ipc.ts:471-478` | L | bug | chat:delete 清理失败中止删除(用户删不掉会话) | 5 |
| D33 | `ipc.ts:301-305` | L | bug | project:create 接受 `C:\` 驱动器根 | 1 |

### 1.3 渲染层 + 扩展 + webadmin(27)

| ID | 位置 | 严重度 | 类别 | 描述 | 批次 |
|---|---|---|---|---|---|
| U1 | `renderer/stores/chat.ts:456-462` | M | bug | 事件代际守卫丢弃首事件 canceled/error → 3s 假转圈 | 5 |
| U2 | `renderer/stores/chat.ts:332` | M | bug | sendMessage 隐式建会话不带 projectId → 落未分类 | 5 |
| U3 | `renderer/pages/Main.tsx:212-226` | M | bug | star/archive 后不刷新列表 | 5 |
| U4 | `renderer/stores/chat.ts:354-363` | L | design | continueConversation 不重置 streaming;interrupted 先清后失败即丢 | 5 |
| U5 | `renderer/stores/approvals.ts:27-33` | L | bug | confirm_required 不按 request_id 去重 | 5 |
| U6 | `renderer/components/ContextUsage.tsx:14-15` | L | bug | budget=0 除零 → NaN 宽度 | 5 |
| U7 | `renderer/stores/chat.ts:341` | L | bug | 乐观消息 Date.now() 作 id,可能撞真实行 | 5 |
| U8 | `renderer/pages/Main.tsx:69,116,153` | L | bug | 死状态 showUncategorized/activeProject;改名可置空 | 5 |
| U9 | `renderer` 7 处裸 button/textarea/自写 modal | L | design | 违反 shadcn-only 原则(AGENTS §3.1) | 5 |
| U10 | `renderer/components/ChatInput.tsx:88` | L | bug | 绝对路径触发「无可用技能」误导提示 | 5 |
| U11 | `renderer/components/SearchDialog.tsx:28-48` | L | bug | 搜索无去抖;卸载后 setBusy | 5 |
| U12 | `renderer/pages/Settings.tsx:62-66` | L | bug | pickAccent 无错误处理 | 5 |
| U13 | `renderer/stores/approvals.ts:13` vs `engine.ts:881` | L | design | 60s 倒计时两端独立,不随配置同步 | 5 |
| U14 | `renderer/stores/chat.ts:520-536` | L | design | SDK 审批路径无 tool_start,待批卡片死代码 | 5 |
| E1 | `browser-extension/background.js:213` | H | security | **password 输入框 value 进语义快照 → LLM** | 1 |
| E2 | `browser-extension/background.js:107-121` | M | bug | onDetach 不清理 attachedTabId → 后续命令全失败 | 5 |
| E3 | `browser-extension/manifest.json:6-15` | L | design | scripting/activeTab 未用;无 minimum_chrome_version | 5 |
| E4 | `browser-extension/background.js:290` | L | bug | el.id 未 CSS.escape,选择器注入 | 5 |
| W1 | `webadmin/pages/Usage.tsx:25-39` | M | bug | 日期筛选 stale closure,查询静默用旧值 | 5 |
| W2 | `webadmin/pages/Knowledge.tsx:385-390` | M | bug | 授权弹窗先开后加载 → 旧数据整组覆盖新文件夹(破坏性) | 5 |
| W3 | `webadmin/pages/Gateway.tsx:254` | M | design | 上游 API key 明文展示(违背密钥不出服务端姿态) | 5 |
| W4 | `webadmin` 9 处 `window.confirm` | L | design | 违反 shadcn-only 原则 | 5 |
| W5 | `webadmin/pages/Departments.tsx:160` | L | bug | 父部门候选含后代(服务端有守卫,UX 差) | 5 |
| W6 | `webadmin` 授权按名字键控 + 组名 UNIQUE 大小写敏感 | L | bug | 大小写变体组在 UI 合并为一个复选框 | 3 |
| W7 | `webadmin/lib/api.ts:36-40` | L | bug | 401 重定向硬编码 /admin/ | 5 |
| W8 | `webadmin/pages/Knowledge.tsx:475-478` | L | bug | 搜索结果 content/score 无守卫 | 5 |
| W9 | `webadmin/pages/Users.tsx:108-128` | L | bug | 切换/删除无 busy 守卫,双击重复请求 | 5 |
| W10 | `webadmin/pages/Gateway.tsx:376-383` | L | bug | 未选 provider 提交 provider_id=0 | 5 |

### 1.4 契约 / 文档(16)

| ID | 位置 | 严重度 | 类别 | 描述 | 批次 |
|---|---|---|---|---|---|
| C1 | `llmgateway/handler.go:350` | L | contract | `UPSTREAM_IDLE_TIMEOUT` 不在错误码契约 | 5 |
| C2 | `/healthz`、NoRoute 非 2xx 非信封 | L | contract | 见 S37 | 5 |
| C3 | `marketplace/suggested.go:43` | L | design | recommended 恒 true,字段无信息量(加开关或删字段) | 5 |
| C4 | `agent/events.ts` vs 文档 | L | doc | conversationId/tool_call_id/context_usage 未入文档 | 5 |
| C5 | AGENTS.md §7 | L | doc | 服务端迁移编号 0001-0016 过时(实际 0001-0017);客户端 starred/archived/status 扩展未记录 | 5 |
| C6 | `serverauth/admin.go:46` | M | contract | 遗留 `PUT /users/:id/groups` 多部门端点与单部门契约冲突 | 3 |
| C7 | `groups.go:18-36` | M | security | GetOrCreateGroup 可绕过全员保留名、拼错建幽灵部门 | 3 |
| C8 | `departments.go:73-91` | L | bug | CreateDepartment 不校验 leader_id | 3 |
| C9 | `paths.ts:32-44` | L | bug | portable 已存在但只读的 data 目录不回退系统目录 | 4 |
| C10 | 双份 validateServerURL/subtreeOf/词法管线/编码检测×3/技能授权过滤/分页 | L | design | 违反 §3.2 不复刻原则 | 5 |
| C11 | spec §3.6/§5 | M | security | TOFU「首次弹窗信任」未实现(见 D7);stdio 白名单未实现(见 D8) | 1/4 |
| C12 | spec §3.4 | M | contract | `pip install` 免审批未记录(决策 D4 补文档) | 5 |
| C13 | spec §4.4/§3.6 | L | doc | 仍写「建议安装制(非授权)」,与授权制实现冲突 | 5 |
| C14 | spec §3.6/§6 | L | doc | MCP 崩溃自动重启 1 次未实现(标记范围外) | 5 |
| C15 | `ipc.ts:601-604` | M | security | Session(含 token)经 3 条通道到 renderer,违背「renderer 永不持有」 | 4 |
| C16 | `index.ts:541-543` | L | bug | OIDC 深链重复 emit auth:logged-in | 5 |

---

## 2. 批次 1:安全边界(B1.1-B1.10)

> 目标:封死命令门控绕过与盲批;MCP/插件/附件/IPC 的信任边界加固。每任务先写失败测试(证明绕过可行),再修,再 commit。

### Task B1.1:`needsApprovalFor` 封死 `~user` 与 `--opt=path` 绕过

**Files:** `desktop/src/main/tools/terminal.ts`;测试 `terminal.test.ts`

- [ ] Step 1(红):新增用例:``cat ~root/.ssh/id_rsa``、`cp --target-directory=/etc/cron.d x.sh`、`grep --file=/etc/shadow x`、`mv x.sh --target-directory=/tmp`、`FOO=/etc x` → 均必须返回 `true`(需审批)。现有实现实测返回 false。
- [ ] Step 2(绿):
  1. `expandHome` 仅展开字面 `~`/`~/`;任何匹配 `~[^/\s]*` 的 token 直接判定需审批(非本人 home 展开)。
  2. 删除 `arg.includes('=')` 的整 token 跳过规则;改为:对 whitelist 命令的每个 token,先剥离首 token 的 `KEY=value` 前缀(环境变量赋值)后,剩余部分若含 `--opt=/abs`、`--opt=~/...`、`--opt=../...` 形式则提取 `=` 后的值走同一 `isAllowed` 判定;`=` 后是相对名(如 `x=y`)不判。
  3. 保留 `-` 开头选项跳过(选项名本身),但选项值经 `=` 内嵌时按上述规则判定。
- [ ] Step 3:全量 `npx vitest run src/main/tools/terminal.test.ts` PASS。
- [ ] Step 4:commit:`fix: block ~user and --opt=path approval-gate bypasses`

### Task B1.2:审批弹窗显示实际命令/代码

**Files:** `desktop/src/main/agent/engine.ts`(`approvalTarget`)、`desktop/src/renderer/src/components/ConfirmModal.tsx`、`events.ts`

- [ ] Step 1(红):engine 测试:构造 command_exec/browser_execute_js/browser_navigate 的 confirm_required 事件,断言 `target` 含实际命令串/代码/URL(而非 `(command, timeoutSec)` 摘要);`kb_upload` 类保持摘要。
- [ ] Step 2(绿):`approvalTarget` 对 `command_exec` 返回命令串、`browser_execute_js` 返回代码、`browser_fill/select/navigate` 返回选择器+值/URL,统一 500 字符截断(带 `…` 标记);ConfirmModal 对长 target 加 `max-h` 滚动展示。
- [ ] Step 3:测试 PASS;renderer typecheck。
- [ ] Step 4:commit:`feat: show actual command/code in approval dialog`

### Task B1.3:ReDoS 防护:拦截歧义回溯模式

**Files:** `desktop/src/main/tools/filesystem.ts`;`filesystem.test.ts`

- [ ] Step 1(红):新增用例:`(a|aa)+$`、`(ab|a)+$`、`(a?b)+$`、`(a*)*b` → `file_search` 必须拒绝(返回错误),不得执行。
- [ ] Step 2(绿):扩展 `NESTED_QUANTIFIER_RE` 逻辑:任何 `(...)+`/`(...)*` 且组内含 `|` 或嵌套量词的模式一律拒绝;另外对 `file_read` 内容匹配加单次匹配上限(内容 >64KB 时拒绝 regex 搜索,提示用字面量搜索)。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: reject ambiguous-backtracking regexes in file_search`

### Task B1.4:扩展快照密码字段脱敏

**Files:** `browser-extension/background.js`

- [ ] Step 1(红):无单测基建(手工验证记录);在代码 review 中确认值捕获正则 `^(text|search|email|password|number|tel|url|date|time)$`。
- [ ] Step 2(绿):从值捕获集合中删除 `password`;`type=hidden` 一并排除;密码框输出 `[password input omitted]` 占位。
- [ ] Step 3:手工冒烟:登录页 `browser.getContent` 快照不含密码值。
- [ ] Step 4:commit:`fix(extension): omit password field values from tab snapshots`

### Task B1.5:MCP stdio 命令白名单 + args 元字符校验

**Files:** `desktop/src/main/mcp/integration.ts`;`integration.test.ts`

- [ ] Step 1(红):用例:命令 `rm`/相对路径 `./evil.sh`/带 `;` `|` `` ` `` `$()` 的 args → `createMcpToolsClient` 抛错;`npx`/`node`/`python3`/绝对路径 bin 通过。
- [ ] Step 2(绿):实现 spec §3.6 白名单:`npx/node/python3/docker` 或绝对路径且 `isAbsolute`;args 逐项拒绝 shell 元字符(经现有 `needsApprovalFor` 同源判定或独立正则);错误信息说明未通过白名单。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`feat: enforce stdio command whitelist for MCP plugins`

### Task B1.6:插件风险确认 nonce(防软确认绕过)

**Files:** `desktop/src/main/plugin_ipc.ts`;`plugin_ipc.test.ts`

- [ ] Step 1(红):用例:未先调用预览(confirmed:false)直接 `confirmed:true` 安装 → 拒绝;确认后二次确认 → 成功。
- [ ] Step 2(绿):main 维护 per-session Set(插件 id 维度):预览调用(confirmed:false)时写入 nonce;安装调用时校验 nonce 存在并消费;进程重启/会话重建后失效。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: require preview nonce before confirmed plugin install`

### Task B1.7:allowedDirs 根路径拒绝 + IPC sender 校验

**Files:** `desktop/src/main/plugin_ipc.ts:153-163`、`desktop/src/main/ipc.ts:636-643`

- [ ] Step 1(红):用例:allowedDirs 提交 `/`、`C:\` → 拒绝(400 语义);`project:create` 提交 `C:\` → 拒绝。
- [ ] Step 2(绿):`normalizeAllowedDir` 增加根路径判定(win32 驱动器根 + POSIX `/`);`registerIpcHandlers` 统一包装:校验 `event.senderFrame.url` 为应用自身 origin(`file://` 或 dev server URL),不符直接拒绝;`project:create` 增加驱动器根检查。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: reject filesystem roots for allowedDirs/projects; validate IPC sender origin`

### Task B1.8:gatewayFetch 拒绝静默回退 + 恢复会话 URL 校验 + 附件符号链接

**Files:** `desktop/src/main/gateway/auth.ts:44-49`、`session_cache.ts`、`agent/attachments.ts`

- [ ] Step 1(红):用例:无 `session.defaultSession.fetch` 环境注入自定义 fetch → 生产路径抛错(测试路径允许注入);`establishSession` 对远程 `http://` 抛错;附件符号链接指向 allowedDirs 外 → 拒绝。
- [ ] Step 2(绿):
  1. `gatewayFetch`:fallback 仅当显式注入 fetch 存在时使用,否则 throw(不再静默 global fetch)。
  2. `establishSession` 内调用 `validateServerURL`(远程须 HTTPS)。
  3. `attachments.ts` 改用 `tools/paths.ts` 的 `isAllowed`/realpath 检查。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: harden gatewayFetch fallback, session restore, attachment symlinks`

### Task B1.9:web_search 走 TOFU fetch

**Files:** `desktop/src/main/tools/web.ts:212-219`、`index.ts`

- [ ] Step 1(红):用例:createWebTools 可注入 fetch;默认 search fetch 与注入一致(证明经 gatewayFetch)。
- [ ] Step 2(绿):`createWebTools` 增加可选 fetch 参数,index.ts 传 `gatewayFetch`;`web_fetch`(任意公网)保持默认 fetch。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: route web_search through TOFU-pinned gatewayFetch`

### Task B1.10:文档决策 D1/D2 修订(随批次 1 收尾)

**Files:** `AGENTS.md`、`docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md`

- [ ] Step 1:AGENTS §2.4 增加:「审批经 AI SDK v7 原生 toolApproval 实现(2026-08-12 决策,替代引擎自管门控);`ai` 版本在 package.json 锁定,升级必须跑 `engine.test.ts` 审批用例;弹窗展示实际命令串(见 §7)」。
- [ ] Step 2:spec §3.3.1a 同步;CDP 桥信任边界写入 spec §3.8(cdp_server.ts 头注释同步删除错误断言)。
- [ ] Step 3:commit:`docs: record SDK-approval and CDP trust-boundary decisions`

---

## 3. 批次 2:数据正确性(B2.1-B2.8)

### Task B2.1:editAndRerun 前置 busy 检查 + 归属校验

**Files:** `desktop/src/main/ipc.ts:424-447`;`ipc.test.ts`

- [ ] Step 1(红):用例:会话 B 运行时对会话 A editAndRerun → 直接拒绝且消息/会话数据零变更;messageId 不属于该会话 → 拒绝。
- [ ] Step 2(绿):handler 开头检查 `e.runningConversation !== null`(任一会话在跑即拒绝,先于任何 DB 写);查询 message 归属 `conversationId` 校验。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: guard editAndRerun against cross-conversation data loss`

### Task B2.2:failover override 按候选重算

**Files:** `internal/llmgateway/handler.go:99-135`;`handler_test.go`

- [ ] Step 1(红):用例:双 provider(渠道 deepseek + 无渠道)首败二成,断言第二个 provider 收到的 body 不含 deepseek 注入参数、不含首个 provider 的 max_tokens 注入。
- [ ] Step 2(绿):failover 循环内对每个候选从原始 body 深拷贝出发重算 channel override 与 `default_params` 注入;`applyMaxTokensDefault` 同时检查 `max_completion_tokens`。
- [ ] Step 3:`make test-server` PASS。
- [ ] Step 4:commit:`fix: recompute channel overrides per failover candidate`

### Task B2.3:moveProject/deleteProject 重推导 workspace

**Files:** `desktop/src/main/ipc.ts:310`、`store/projects.ts`;`ipc.test.ts`

- [ ] Step 1(红):修正现有固化 bug 的测试(ipc.test.ts:301-307):moveProject 后断言 workspace 更新为新项目目录(移出项目 → 空);deleteProject 后断言解绑会话 workspace 置空。
- [ ] Step 2(绿):moveProject:查项目 → `workspaceFor(project.path, id)`+mkdir → 同事务更新 project_id+workspace;置 null 时 workspace=''。deleteProject:解绑时 workspace=''。`chat:delete` 清理根集合相应调整。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: re-derive conversation workspace on project move/delete`

### Task B2.4:appendMessage 更新 updated_at

**Files:** `desktop/src/main/store/messages.ts`;`store.test.ts`

- [ ] Step 1(红):用例:appendMessage 后 listConversations 该会话升至首位。
- [ ] Step 2(绿):appendMessage 同事务更新 conversations.updated_at(与 status 变更路径共用)。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: bump conversation updated_at on message append`

### Task B2.5:空标题兜底 + 标题 rune 截断 + file_write 保编码 + aborted 退出码

**Files:** `desktop/src/main/index.ts:438-450`、`agent/title.ts`、`tools/filesystem.ts:254`、`tools/terminal.ts:111`

- [ ] Step 1(红):用例:generateTitle 返回空串 → 标题为截取首条用户消息;标题含 emoji 截断不产生半个代理对;file_write 覆盖 GBK 文件 → 写回 GBK;run 中止时退出码为 124/130 而非 1。
- [ ] Step 2(绿):`title = modelTitle || fallbackTitle(...)`;`Array.from(text).slice(0,20).join('')`;file_write 对已存在文件先 `detectEncoding` 再 `encodeForWrite`;terminal close 时 `aborted ? (timedOut ? 124 : 130) : (code ?? 1)`。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: title fallback, rune-safe truncation, write encoding, abort exit code`

### Task B2.6:chat:attach 先校验后落盘

**Files:** `desktop/src/main/ipc.ts:313-348`;`ipc.test.ts`

- [ ] Step 1(红):用例:批量 2 文件,第 2 个超 100MB/类型非法 → 第 1 个也不落盘。
- [ ] Step 2(绿):把 mime 校验与 100MB 检查上移到首个循环;全部通过后才进写循环。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: validate all attachments before writing any`

### Task B2.7:边界引导只存目录(非文件路径)

**Files:** `desktop/src/main/agent/engine.ts:856-874`

- [ ] Step 1(红):用例:isBoundaryError 给出文件路径 → addAllowedDir 存其 dirname。
- [ ] Step 2(绿):目标路径若是文件(带扩展/存在且非目录)取其 dirname;确认文案同步说明放行的目录。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: boundary guide adds parent dir, not file path`

### Task B2.8:模型同步去重 + 默认模型悬空清理(服务端)

**Files:** `internal/serverstore/gateway.go:122-138`、`internal/llmgateway/admin.go:272-369`

- [ ] Step 1(红):用例:重复模型名提交 → 幂等无 500;删除默认模型/provider 后 `gateway.default_model` 置空。
- [ ] Step 2(绿):SyncProviderModels 前按 name 去重;deleteModel/deleteProvider 内复用/提取重置 default_model 的辅助函数。
- [ ] Step 3:`make test-server` PASS。
- [ ] Step 4:commit:`fix: dedupe model names on sync; clear stale default model`

---

## 4. 批次 3:权限体系(B3.1-B3.8)

> 全部服务端,统一由 `make test-server` 验收。核心:全员组落地、effective groups 一致化、NOCASE 统一、守卫事务化。

### Task B3.1:全员组 seed(迁移 0018)+ 保留名全路径守卫

**Files:** `internal/serverstore/migrations/0018_seed_everyone_group.sql`(新)、`departments.go`、`groups.go`

- [ ] Step 1(红):用例:新库迁移后 `UserEffectiveGroups` 含全员(每个用户);`GetOrCreateGroup('全员')` 拒绝;`PUT /users/:id/groups` 提交全员拒绝。
- [ ] Step 2(绿):迁移 INSERT 全员组(id=0?否——用正常自增 id,parent 0);`GetOrCreateGroup` 开头拒绝 `EveryoneGroupName`;`CreateDepartment` 保留名守卫已有,补 `setUserGroups` 路径。
- [ ] Step 3:全量 server 测试 PASS。
- [ ] Step 4:commit:`feat: seed reserved 全员 group; guard reserved name everywhere`

### Task B3.2:getMCPConfig 用 effective groups

**Files:** `internal/marketplace/skill_api.go:327`

- [ ] Step 1(红):用例:授权给祖先部门的子部门用户 / 部门主管 / 全员授权 → `GET /mcp/:id/config` 200;无授权仍 404。
- [ ] Step 2(绿):`serverstore.UserGroups` → `serverstore.UserEffectiveGroups`(与 `viewer()` 一致,可复用)。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: resolve MCP config pull with effective groups`

### Task B3.3:NOCASE 守卫统一 + 组唯一约束

**Files:** `internal/serverstore/departments.go:160-162`、`knowledge.go:252`、迁移 `0019_groups_nocase_unique.sql`(新)

- [ ] Step 1(红):用例:大小写变体授权后 DeleteDepartment 必须报引用存在;`RevokeFolderGroup` 大小写不敏感生效;重复创建 `Sales`/`sales` 拒绝。
- [ ] Step 2(绿):delete guard 与 revoke 比较加 `COLLATE NOCASE`;迁移重建 groups 表约束为 `name TEXT COLLATE NOCASE UNIQUE`(同步 `GetOrCreateGroup`/`CreateDepartment` 依赖);`UpdateDepartment` store 层补空名/保留名校验;CreateDepartment 补 leader_id 校验;DeleteDepartment 包事务。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: NOCASE-consistent grant guards and group uniqueness`

### Task B3.4:单授权端点组存在性校验

**Files:** `internal/marketplace/admin.go:90-187`、`internal/knowledge/admin.go:360-383`、`serverstore/knowledge.go:234-241`

- [ ] Step 1(红):用例:拼错/不存在的部门名授权 → VALIDATION 错误不落库;KB 文件夹组授权同。
- [ ] Step 2(绿):单授权端点先 `GetGroupByName(NOCASE)` 存在性校验(与 replace 端点一致);`GrantFolderGroup` 改用存在性校验而非 `GetOrCreateGroup`。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: validate group existence in single-grant endpoints`

### Task B3.5:移除遗留多部门端点 + admin 登录走 auth.mode + LDAP 用户名规范化

**Files:** `internal/serverauth/admin.go:46,107`、`ldap.go:110`

- [ ] Step 1(红):用例:ldap-only 模式本地管理员登录被拒;LDAP 大小写变体登录复用同一账号。
- [ ] Step 2(绿):删除 `PUT /users/:id/groups` 注册(保留 GET);admin 登录经 `ConfigureProviders` 提供方校验(ldap-only 拒绝 local);LDAP 用户名取目录条目 `uid` 属性值规范化。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: drop legacy multi-group endpoint; align admin login and LDAP username`

### Task B3.6:LDAP/OIDC 用户设密语义修复

**Files:** `internal/serverauth/admin.go:343-355`、`handler.go:209-211`

- [ ] Step 1(红):用例:外部用户设密后仍可经 IdP 登录;密码仅作本地补充凭证。
- [ ] Step 2(绿):外部用户设密不再改写 `Source`;本地密码列独立存储,`provisionUser` 守卫按 Source 原值判定(外部用户本地密码仅影响 admin 登录路径)。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: admin-set password no longer detaches IdP users`

### Task B3.7:deleteFolder 子文件夹守卫 + 事务 + JSON 上传 folder_id 校验

**Files:** `internal/knowledge/admin.go:201-205,560-590`

- [ ] Step 1(红):用例:含子文件夹的 folder 删除 → 拒绝;JSON 上传不存在的 folder_id → VALIDATION。
- [ ] Step 2(绿):guard 增加 `kb_folders WHERE parent_id=?` 计数;检查+删除包事务;JSON 路径与 multipart 同源校验 folder_id 存在(0=root)。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: block folder delete with children; validate JSON upload folder`

### Task B3.8:FK pragma 入 DSN + OIDC login-CSRF

**Files:** `internal/serverstore/db.go:21-33`、`serverauth/oidc.go:172-184`

- [ ] Step 1(红):用例:并发 16 连接 FK 违规全部被拒(现有实测 1 条成功);OIDC 无绑定 cookie 的 state 回拨 → 拒绝。
- [ ] Step 2(绿):DSN 追加 `&_pragma=foreign_keys(ON)`;OIDC login 签发 `SameSite=Lax` 的一次性 state cookie,回调校验 state 与 cookie 一致后消费。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: per-connection FK pragma; bind OIDC state to login cookie`

---

## 5. 批次 4:资源与健壮性(B4.1-B4.12)

### Task B4.1:MCP 工具注册表缓存 + 关闭旧客户端

**Files:** `desktop/src/main/index.ts:249-287`、`mcp/integration.ts`

- [ ] Step 1(红):用例:同会话连续两次 `getTools` 只 create 一次 client(计数器);registry 重建时旧 client 被 close。
- [ ] Step 2(绿):按会话/工作区缓存 registry;超期或会话切换时显式 close 旧 client;`buildToolsRegistry` 增加生命周期管理。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: cache MCP tool registry; close superseded clients`

### Task B4.2:MCP 凭证会话级缓存

**Files:** `desktop/src/main/index.ts`(refreshPluginCredentials 调用点)

- [ ] Step 1(红):用例:同会话 10 条消息只触发一次 config 拉取。
- [ ] Step 2(绿):凭证刷新移至登录/refreshBootstrap/深链事件;每条消息注册表构建复用内存 Map(现 installer 已维护,接好即可)。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: refresh MCP credentials once per session, not per message`

### Task B4.3:http.Server timeouts

**Files:** `cmd/server/main.go:152`

- [ ] Step 1(绿,配置类无单测):`ReadHeaderTimeout:10s, ReadTimeout:60s, WriteTimeout:300s(SSE 流), IdleTimeout:120s`。
- [ ] Step 2:commit:`fix: add http.Server timeouts`

### Task B4.4:登录限流器定时清扫

**Files:** `internal/serverauth/ratelimit.go:44-84`

- [ ] Step 1(红):用例:填满后单次 allow 为 O(1) 摊销(计数清扫触发次数)。
- [ ] Step 2(绿):清扫改定时器(如每 60s)或概率触发(1/64);满员时驱逐最旧条目。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: amortize login limiter sweep`

### Task B4.5:OIDC discovery 超时 + 模型同步异步化 + ReadAll 上限

**Files:** `internal/serverauth/oidc.go:61`、`llmgateway/admin.go:45-59`、`channels/channel.go:66`

- [ ] Step 1(红):用例:不可达 IdP 下 Configure 在 10s 内返回并标记 OIDC 不可用;`syncProviderNow` 改后台执行(测试仅验证不阻塞响应);模型同步 body 上限 1MB。
- [ ] Step 2(绿):discovery 用 `context.WithTimeout(10s)` + 带超时的 http.Client;创建/更新 provider 后同步放 goroutine,接口先返回 + 状态可查;`io.LimitReader(1MB)`。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: OIDC discovery timeout; async provider sync; cap model body`

### Task B4.6:网关 header 白名单 + 非流式长请求超时 + 限流满员策略

**Files:** `internal/llmgateway/handler.go:285-313,447-458`、`routes.go:18`

- [ ] Step 1(红):用例:上游 Set-Cookie 不透传;非流式 180s 生成不截断(用可注入的响应头超时)。
- [ ] Step 2(绿):`serveJSON`/`serveStream` 仅透传白名单头(Content-Type、Retry-After、X-Request-Id);client 改 `ResponseHeaderTimeout:120s` + body 独立 deadline(或 10min);限流桶满员时驱逐最旧(与登录限流器一致)。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: whitelist upstream headers; fix non-stream timeout; evict on bucket full`

### Task B4.7:usage 待定行 idle-timeout 清理 + embedding 计量标记

**Files:** `internal/llmgateway/handler.go:347-362`、`embedding.go:204`

- [ ] Step 1(红):用例:idle 超时后 pending 行被删;embedding 0-token 行不被 CleanupPendingUsage 清除。
- [ ] Step 2(绿):idle-timeout 分支走与 client-gone 相同清理;embedding 行打 `stream=0` 或 usage 非空标记,cleanup 仅删 stream pending。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: clean pending usage on idle timeout; keep embedding rows`

### Task B4.8:TOFU 首信确认 + 登录页证书恢复入口

**Files:** `desktop/src/main/gateway/tls.ts:95-103`、`index.ts:324-337`、`renderer/pages/Login.tsx`、`renderer/src/App.tsx:21-25`、`stores/connection.ts`

- [ ] Step 1(红):用例:未知指纹 → 事件含指纹且不自动信任,`confirmTrust()` 后方可用;`cert_mismatch` 状态渲染于登录页。
- [ ] Step 2(绿):`onUnknownFingerprint` 改为 pending:发 `connection:status {status:'trusting_cert', fingerprint}` 并等待新 IPC `tls:confirmTrust`;App.tsx 不再丢弃 trusting_cert;Login.tsx 订阅 connection store 显示指纹 + 「信任并连接」/cert_mismatch 时显示「重置已信任证书」(未登录可用)。
- [ ] Step 3:测试 + 手工冒烟(自签证书轮换)。
- [ ] Step 4:commit:`feat: require user consent on first TLS trust; login-page cert recovery`

### Task B4.9:portable 可写探测 + config.json 原子写 + Session token 不进 renderer

**Files:** `desktop/src/main/paths.ts:32-44`、`gateway/config.ts:31-34`、`ipc.ts:599-604`、`index.ts:378`、`renderer/stores/auth.ts`、`preload/index.ts`

- [ ] Step 1(红):用例:已存在只读 data 目录 → 回退系统目录;auth:login 返回值不含 token 字段;`auth:logged-in` 载荷无 token。
- [ ] Step 2(绿):portable 选择前探测可写(临时文件创建/删除);config.json 写临时文件+rename;跨桥 Session 载荷 strip token(renderer store 类型同步移除)。
- [ ] Step 3:测试 + typecheck PASS。
- [ ] Step 4:commit:`fix: portable writability probe, atomic config write, token-free renderer`

### Task B4.10:skill 安装单次下载 + SKILL.md 大小上限

**Files:** `desktop/src/main/plugin_ipc.ts:187-199`、`skill/installer.ts`、`skill/integration.ts:9-13`

- [ ] Step 1(红):用例:预览+安装只下载一次(缓存命中);>4096 字符 SKILL.md 注入被截断带标记。
- [ ] Step 2(绿):预览阶段缓存校验后的 archive buffer,安装阶段用缓存(TOCTOU 消除);integration 注入截断 4096 字符。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`fix: cache skill archive between preview and install; cap SKILL.md`

### Task B4.11:provider 禁用开关 + deepseek override 模型感知

**Files:** `internal/llmgateway/admin.go:182-270`、`channels/deepseek.go`

- [ ] Step 1(红):用例:PUT 携带 `enabled:false` → 路由不再选该 provider;deepseek-reasoner 不加 reasoning_effort。
- [ ] Step 2(绿):providerReq 增加 `enabled` 字段(更新路径可写);deepseek override 对 `deepseek-reasoner`(或含 reasoner 名)返回 no-op。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`feat: provider enable toggle; model-aware deepseek overrides`

### Task B4.12:secure cookie 配置 + usage 聚合用户名 + 登录 429 语义

**Files:** `internal/serverauth/admin.go:117-125`、`serverstore/usage.go:59-61`、`desktop/src/main/gateway/auth.ts:61-62`

- [ ] Step 1(红):用例:配置 secure 后 cookie 带 Secure;聚合标签为用户名;429 → 专用 AuthError('rate_limited')。
- [ ] Step 2(绿):新增 `server.secure_cookies` 配置(默认自动,反代时显式开启);usage 聚合 JOIN users 取 username(fallback id);客户端 429 映射「登录尝试过于频繁」。
- [ ] Step 3:测试 PASS。
- [ ] Step 4:commit:`feat: secure-cookie config; username in usage labels; 429 login UX`

---

## 6. 批次 5:UI / 契约 / 文档 / 服务端低危(B5.1-B5.14)

> 本批多为小修与文档同步,允许合并 commit(每 3-5 项一 commit),但每项仍需测试或 typecheck 佐证。

### Task B5.1:webadmin 三处 bug

**Files:** `webadmin/src/pages/Usage.tsx:25-39`、`Knowledge.tsx:385-390`、`Gateway.tsx:254`

- [ ] `load` deps 补 `from,to`;Knowledge 授权弹窗改为 `await loadGrants` 后再打开(对齐 Marketplace);Gateway API key 改掩码展示(服务端返回 `masked_api_key` 或前端脱敏+显式查看)。
- [ ] 验证:`npm run build` + 手工(筛选日期后查询、两次打开不同文件夹授权弹窗)。
- [ ] commit:`fix(webadmin): usage date filter, grant dialog race, mask API keys`

### Task B5.2:renderer 核心修复(U1-U4、U13)

**Files:** `renderer/stores/chat.ts`、`pages/Main.tsx`

- [ ] 事件代际守卫:每 run 记录「已收到事件」标志,首事件为 done/canceled/error 时不丢弃(或按 runToken 归位);sendMessage 隐式建会话带 `projectId: get().activeProjectId`;star/archive 后调 `loadConversations()`;continueConversation 后置重置 streaming、成功后才清 interrupted;确认倒计时 payload 带引擎超时。
- [ ] commit:`fix: renderer run-token guard, project on auto-create, star refresh, continue reset`

### Task B5.3:renderer 小修(U5-U12)

**Files:** `stores/approvals.ts`、`components/ContextUsage.tsx`、`components/ChatInput.tsx`、`components/SearchDialog.tsx`、`pages/Settings.tsx`、`pages/Main.tsx`、`stores/chat.ts`

- [ ] request_id 去重;budget>0 守卫;`/` 路径不触发技能提示;搜索 200ms 去抖 + canceled 守卫;accent catch+toast;乐观 id 用 `-Date.now()`;改名空值回退「未命名会话」;清理死状态 showUncategorized/activeProject。
- [ ] commit:`fix: renderer polish (dedupe, debounce, guards, dead state)`

### Task B5.4:扩展修复(E2-E4)

**Files:** `browser-extension/background.js`、`manifest.json`

- [ ] `chrome.debugger.onDetach` → 清理 attachedTabId;manifest 删除 `scripting`/`activeTab`,加 `minimum_chrome_version: "116"`;`CSS.escape(el.id)`。
- [ ] 手工验证:点击调试 infobar 取消后命令恢复(或 SW 重启)。
- [ ] commit:`fix(extension): onDetach cleanup, least-privilege manifest, selector escape`

### Task B5.5:bootstrap 缺字段默认值 + 插件清单健壮性

**Files:** `desktop/src/main/gateway/bootstrap.ts`、`renderer/pages/Settings.tsx:268-269,311-312`

- [ ] validateBootstrap 补默认:`skills/mcp → []`、`web → {allow_private:false, search_endpoint:''}`;Settings 相应空态渲染。MCP 安装扫描 `Number.isInteger` 校验 + config id 与目录一致。`chat:rename` 200 字符上限。
- [ ] commit:`fix: normalize bootstrap fields; harden plugin list scan; cap rename`

### Task B5.6:错误码契约统一(C1/C2/S37)

**Files:** `internal/llmgateway/handler.go:350`、`cmd/server/main.go:141,148`、`internal/bootstrap/bootstrap.go:46`

- [ ] `UPSTREAM_IDLE_TIMEOUT` → `UPSTREAM`(message 说明 idle);NoRoute 与 `/healthz` 返回标准信封(健康检查保持 503 状态码)。
- [ ] 测试:现有 handler 测试断言新错误码。
- [ ] commit:`fix: unify error envelope and codes with contract`

### Task B5.7:代码去重(C10 + S29 + D15)

**Files:** `desktop/src/shared/validateServerURL.ts`(新)、`desktop/src/main/tools/encoding.ts`(新)、`internal/serverstore/effective.go`、`internal/knowledge/search.go` vs `chunk_index.go`

- [ ] validateServerURL 单实现(session_cache 与 renderer api 复用);编码检测单模块(filesystem/terminal/web 复用);`subtreeOf` 与 `subtreeGroupIDs` 合并;admin kb_search 回退用 `SearchAll`;maybeEmitArtifact 仅从结构化结果提取(或补 Windows 路径支持)。
- [ ] commit:`refactor: dedupe shared helpers; admin kb_search fallback; artifact extraction`

### Task B5.8:服务端低危批量修(S30-S34、S36 剩余、S18 收尾)

**Files:** `serverauth/handler.go,admin.go`、`util/password.go,crypto.go`、`llmgateway/handler.go,upstream.go`、`bootstrap_admin.go`、`llmgateway/embedding.go`

- [ ] provisionUser nil 守卫;VerifyPassword 空 hash 拒绝 + 参数上限;EnsureMasterKey `O_EXCL`;Bearer `EqualFold`;createUser status∈{0,1};usage from/to 解析失败 400;用户列表 page clamp;`max_tokens` 与 `max_completion_tokens` 双键;body 走 `json.Number`;`DecryptSecret` 默认报错(未接线即失败);bootstrap-admin 单步创建;updateUser 事务化(先验证后吊销);embedding 复用 client/embedder;`kb_read` chunk_ids 上限 100;UTF-8 rune 截断。
- [ ] `make test-server` PASS。
- [ ] commit:`fix: server low-severity hardening batch`

### Task B5.9:知识库低危修复(S26、L 系列、D15 遗留)

**Files:** `internal/knowledge/lexical.go`、`mcp.go`、`chunk_index.go`、`admin.go`、`serverstore/knowledge*.go`

- [ ] 拉丁深命中锚点改 unigram 子串定位;`IN ()` 空集早退;`kb_read`/`kb_list` 过滤非 ready 文档;kb_upload 标题上限;kb_list 父 id 不外泄;RetryKBDocument 限 error/pending;GetChunksByIDs 排序对齐注释;下架资源消息统一(404 不泄露);updateDoc 死分支修复;embedding 失败跳档策略;total 语义文档化;retryDoc 补审计。
- [ ] `make test-server` PASS。
- [ ] commit:`fix: knowledge low-severity batch`

### Task B5.10:shadcn 原则清理(A-8、W4)与 webadmin 小修(W5-W10)

**Files:** renderer 7 处 + `webadmin/src/pages/*`、`webadmin/src/lib/api.ts`

- [ ] 裸 button/textarea → shadcn Button/Textarea;自写 modal → shadcn Dialog(对齐 ConfirmDialog);webadmin `window.confirm` → 移植 shadcn ConfirmDialog;部门父候选排除后代;授权复选框按组 id 键控;401 重定向用 router base;Knowledge 搜索命中守卫;Users 页 busy 守卫;Gateway provider 必选校验。
- [ ] `npm run build`(desktop + webadmin)+ 手工冒烟。
- [ ] commit:`fix: shadcn compliance; webadmin polish`

### Task B5.11:文档同步(AGENTS.md + spec + 计划)

**Files:** `AGENTS.md`、`docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md`、`docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md`

- [ ] AGENTS §7:迁移 0001-0017、客户端 starred/archived/status 扩展、事件协议含 conversationId/tool_call_id/context_usage;§2.4 SDK 审批决策(D1);§2.8 单部门端点唯一、全员 seed 说明;§7 错误码确认(无 UPSTREAM_IDLE_TIMEOUT)。
- [ ] spec:§3.4 pip 例外(D4);§3.6 stdio 白名单已实现、MCP 自动重启标范围外(C14);§3.8 CDP 信任边界(D2);§4.4/§3.6 商城授权制(C13);§5 TOFU 首信确认(B4.8);§3.3.3 事件协议补充。
- [ ] commit:`docs: sync contracts with audit decisions and 0017-0019 migrations`

### Task B5.12:recommended 字段决策 + 杂项(C3、C16、L 系剩余、D30-D33 部分)

**Files:** `internal/marketplace/suggested.go`、`desktop/src/main/index.ts:541-543`、`cdp_server.ts`、`ipc.ts:450-471`

- [ ] recommended:与用户确认后决定——加 `recommended` 列于 mcp_servers(管理员可配)或两端删字段;OIDC 深链去重 emit;CDP pending 键改 `(ws,id)`;chat:messagesPaged NaN 守卫;chat:delete 清理失败不中止删除;window bounds 恢复按显示器 clamp。
- [ ] commit:`fix: dedupe OIDC emit, CDP pending keying, delete cleanup, misc`

### Task B5.13:全量回归 + 手工冒烟

- [ ] `make check`(服务端 test + 客户端 test + typecheck + lint)。
- [ ] 手工场景:① 审批弹窗显示完整命令;② `cat ~root/x` 与 `cp --target-directory=/tmp x` 触发审批;③ 全员授权后子部门用户可见可用;④ 证书轮换后登录页可重置并重新信任;⑤ 扩展密码框不出现在快照;⑥ webadmin 日期筛选生效;⑦ 移动会话到项目后新消息写入新目录。
- [ ] commit:`chore: post-audit regression and smoke pass`

### Task B5.14:收尾

- [ ] 更新本计划勾选状态;`git log --oneline -20` 检查 commit 信息符合规范。
- [ ] 遗留项明确列出(进入 CHANGELOG 或下期):D2 capability token、MCP 自动重启、多显示器全屏捕获(D31)、agent 级 sandbox 隔离增强。

---

## 7. 验收清单

| 批次 | 命令 | 关键断言 |
|---|---|---|
| 1 | `cd desktop && npm test && npm run typecheck` | 绕过用例全部 PASS(原为红) |
| 2 | `cd desktop && npm test` + `make test-server` | editAndRerun 零变更;failover body 无污染;workspace 随项目迁移 |
| 3 | `make test-server` | 全员 seed;effective groups 统一;NOCASE 守卫;FK 全连接生效 |
| 4 | `make test-server` + `cd desktop && npm test` | 超时/限流/TOFU/portable/凭证缓存用例 PASS |
| 5 | `make check` + 两前端 `npm run build` | 错误码契约;文档与代码一致;shadcn 合规 |

**Definition of done:** 每批任务全部 commit 且 commit message 符合 `feat:|fix:|test:|docs:|chore:` ≤72 字符;`make check` 绿;手工冒烟清单(B5.13)通过;本计划所有 checkbox 勾选。

---

## 8. 执行记录与遗留项(2026-08-12 执行完毕)

### 已执行批次(commit 概览)

| 批次 | 主题 | 关键 commit |
|---|---|---|
| 1 | 安全边界 | `fix: block ~user and --opt=path approval-gate bypasses`、`feat: show actual command/code in approval dialog`、`fix: reject ambiguous-backtracking regexes`、`fix(extension): omit password field values`、`feat: enforce stdio command whitelist`、`fix: require preview nonce`、`fix: reject filesystem roots`、`fix: harden gatewayFetch fallback`、`feat: require user consent on first TLS trust` |
| 2 | 数据正确性 | `fix: guard editAndRerun`、`fix: recompute channel overrides per failover candidate`、`fix: re-derive conversation workspace`、`fix: bump conversation updated_at`、`fix: validate all attachments before writing any` |
| 3 | 权限体系 | `feat: seed reserved 全员 group`(迁移 0018)、`fix: resolve MCP config pull with effective groups`、`fix: NOCASE-consistent grant guards`(迁移 0019)、`fix: validate group existence in single-grant endpoints`、`fix: drop legacy multi-group endpoint`、`fix: admin-set password no longer detaches IdP users`、`fix: per-connection FK pragma; bind OIDC state` |
| 4 | 资源健壮性 | `fix: cache MCP registry per session`、`fix: add http.Server timeouts`、`fix: amortize login limiter sweep`、`fix: OIDC discovery timeout`、`fix: whitelist upstream headers`、`fix: clean pending usage on idle timeout`(迁移 0020)、`feat: require user consent on first TLS trust`、`feat: provider enable toggle` |
| 5 | UI/契约/文档 | webadmin 三处修复、renderer 两批修复、扩展修复、bootstrap 规范化、错误信封统一、validateServerURL 去重、服务端低危批量、知识库低危批量、AGENTS.md + spec 同步 |

### 遗留项(明确推迟,建议下期)

1. **window.confirm → shadcn Dialog**(webadmin 9 处):交互一致性与 AGENTS §3.1 合规,功能无碍,推迟
2. **编码检测三份拷贝**(filesystem/terminal/web)→ 提取 `tools/encoding.ts`:语义差异多(强制编码/BOM/charset),低风险重构,推迟
3. **词法检索管线两份拷贝**(search.go vs chunk_index.go)→ 合并:改动面大且 doc-level 已是遗留回退路径,推迟
4. **`subtreeOf`/`subtreeGroupIDs`**:一个内存树一个 DB 查询,数据结构不同,合并收益低,保留
5. **MCP 崩溃自动重启 1 次**:spec §3.6 标记为未实现(范围外),文档已同步
6. **多显示器 screen_capture 全屏**:当前仅主屏,spec 未承诺多屏,保留
7. **recommended 字段硬编码 true**:建议加 `mcp_servers.recommended` 列 + 管理开关(需迁移 0021),推迟
8. **CDP capability token 升级路径**:信任边界已文档化(裁决 D2),后续版本可做

### 手工冒烟清单(B5.13)

- [ ] 审批弹窗显示完整命令串(而非 `(command, timeoutSec)` 摘要)
- [ ] `cat ~root/x` 与 `cp --target-directory=/tmp x` 触发审批
- [ ] 全员授权后子部门用户/主管可见可用(kb_search/kb_read/marketplace config)
- [ ] 证书轮换后登录页可重置并重新信任(展示指纹)
- [ ] 扩展密码框不出现在语义快照
- [ ] webadmin 日期筛选生效(改日期后点查询)
- [ ] 移动会话到项目后新消息/附件写入新项目目录
- [ ] 首信 TLS:登录页展示指纹 → 信任并连接 → 重试成功
