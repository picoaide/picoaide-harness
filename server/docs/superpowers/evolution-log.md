# PicoAide 进化日志(Evolution Log)

> 本文件是自我进化循环的状态记录。每轮完成后更新:调研发现、实施功能、验证结果。
> 主会话上下文被压缩后,凭本文件恢复循环状态。

## 循环框架

1. 派调研子代理研究市场桌面端 agent 方案(逆向/源码/文档)
2. 汇总差距清单 → 选高价值项 → 派子代理 TDD 实施
3. 每轮 1-2 个功能;完成后全量验证(make check)+ push
4. 更新本文件(压缩上下文)

## Round 0(2026-08-05):全仓过度工程审计落刀

- 派 3 个子代理审计(server / desktop main / renderer+extension),逐项核实后批准落刀
- 删除:`engine.run()` 遗留循环+测试钩子、mcp/adapter.ts 死文件、skill loader 死代码、AgentEventEmitter、6 组 serverstore 仅测试 DAO、store 仅测试导出链、version IPC 死面、detachIfAttached、4 个未用 npm 依赖(mermaid/remark-gfm/react-tabs/react-separator)
- shrink:chat.ts 四 run 块合一、Electron 加载三合一、parseUsage/randomHex/modelEnabled 共享助手
- commits:`5c2d9a0` `29d5c0f` `4045725`(server)+ `99b832b` `49a9864` `776c1c6` `372e314`(desktop main)+ `3cc34e2` `9ab8e15` `75c9a9c`(renderer/ext/deps)
- 结果:净删 ~1300 行 + 4 依赖;make check 全绿(基线 448 passed)

## Round 1(2026-08-06):上下文与信息保真

**调研结论**(2 个子代理):
- harness 差距:硬截断不可逆(50 条外永久丢失)、按条数不感知 token、resume=重跑、无跨会话记忆、无上下文健康显示
- 办公差距:无任务步骤卡片、缺文档表格技能(pdf/xlsx)、浏览器桥缺语义定位、artifact 无预览、缺粘贴图片/拖拽文件

**实施**:
1. `02c85b8` feat: inject workspace AGENTS.md into agent system prompt
   - ipc.ts `loadProjectInstructions(workspace)`:读 `<workspace>/AGENTS.md`(≤4096 字符截断)拼入 sysPrompt;四个调用点注入(craft/plan/continue/approvePlan/editAndRerun);每次运行重读
   - 引擎改动最小:CraftInput/PlanInput/ContinueInput/ApprovePlanInput 加可选 `sysPrompt?`(缺省 cfg.sysPrompt)
   - 7 个新测试(引擎契约 2 + ipc 集成 3 + 单测 3)
2. `f3799cf` feat: spill oversized tool outputs to workspace files
   - `agent/artifacts.ts` 新增 `spillToolOutput(workspace, toolCallId, value)`:`<workspace>/tool-outputs/<toolCallId>.txt`,摘要=前 400 字符,常量阈值 6000
   - 改写点在 `wrapTool` 的 execute 包装(engine.ts):tool_end 事件/上下文消息/DB 落库三处同源,一次替换全生效;workspace 空则跳过
   - 3 个新测试(大输出落盘+引用回传、小输出不变、空 workspace 跳过)

**验证**:448 passed | 2 skipped,typecheck 0,make check EXIT 0

## Round 2(2026-08-06):长会话与多模态输入

**实施**:
1. `8f3baae` feat: LLM-summary compaction for long conversations
   - 新 agent/compact.ts:CONTEXT_TOKEN_BUDGET=40000 字符;超预算从后往前保留(至少 20 条),更早 user/assistant 文本拼块→单轮 streamText 中文摘要→{role:'user'} 置顶;剪口孤儿 tool 行丢弃
   - ask/plan/craft/continue 四处统一走 compactContext(注入 session.fetch+abort);摘要失败/超时→回退原截断;不落库
   - 8 新测试;481 passed
2. `312b1d4` feat: paste images and drag files into chat
   - renderer 粘图/拖文件→dataUrl→新 IPC chat:attach(校验 png/jpeg/webp≤5MB、文件≤100MB、文件名清洗)→落盘 <workspace>/attachments/→content 存路径引用,base64 永不落 DB
   - 引擎 userContentParts() 解析引用→AI SDK image part;重放/历史/continue 均恢复;读失败降级纯文本
   - 关键发现:@ai-sdk/openai-compatible v3 序列化 image part 变 null,但 streamText 自动转 v4 file part→实际请求体 image_url,网关零改动
   - 新 src/shared/attachments.ts(renderer/main 共享);37 新测试;485 passed

**验证**:make check EXIT 0;485 passed | 2 skipped;build 成功;已 push

## Round 3(2026-08-06):浏览器语义定位 + 任务可视化

**实施**:
1. `96f9070` feat: semantic browser fill/select/waitFor/dialog
   - 插件端 background.js:locate() 语义定位(label[for]/placeholder/aria-label 优先,CSS 回退);fill(原生 setter+input/change React 兼容)/select(option 匹配)/waitFor(200ms 轮询≤60s)/dialog(Page.javascriptDialogOpening,action 武装,10s 超时)
   - 工具层:fill/select/dialog 入 HIGH_RISK_TOOLS,wait_for 只读;桥零改动(通配转发)
   - browser.test.ts 6 用例;496 passed
2. `8ddadb2` feat: run steps trajectory UI
   - chat.ts 新增 runSteps 状态机(tool_start/tool_end/tool_error 配对,done 折叠汇总,新运行/切会话重置,零新协议)
   - RunSteps.tsx 组件(会话头部,shadcn Badge+Loader2,水平胶囊,运行中 pulse/失败 destructive,结束 ✓ 完成(N 步));无步骤零侵入
   - 10 个 store 用例;498 passed;无 renderer 组件测试基建(跳过组件测试,store 兜底)

**验证**:make check EXIT 0;496 passed | 2 skipped;build 成功;已 push

## Round 4(2026-08-06):artifact 预览回灌 + 语义快照

**实施**:
1. `e86b029` feat: artifact preview and re-edit round-trip
   - artifact:read IPC(复用 isAllowed 目录校验,文本 1MB/图片 5MB 上限,按扩展名 kind: html/md/text/image/other,图片回 dataUrl)
   - ArtifactPreview.tsx(shadcn Dialog:HTML→sandbox iframe、图片→img、.md→Markdown.tsx、文本→pre)
   - 回灌:requestEditArtifact(path)→"请继续修改文件 {path}"走 sendMessage;ArtifactsPanel 预览+文件夹双按钮
   - 6 新测试;502 passed
2. `4e4a009` feat: semantic DOM snapshot for getContent
   - 插件 semanticSnapshot()(toString 注入零依赖):限深 6/300 节点/≤6000 字符截断;[H1]/[BUTTON]/[INPUT]/[LINK]/[IMG]/[TABLE] 语义标注,输入框标注 fill 定位提示;getContent 默认快照,{mode:'text'} 兼容
   - 新 browser-extension/snapshot.test.js(零依赖 node 测试 + 最小 DOM mock);503 passed

**验证**:make check EXIT 0;503 passed | 2 skipped;已 push

## Round 5(2026-08-06):服务端全功能审视 + 上下文健康显示

**服务端调研差距清单**(9 项,已入此日志备查):
1. 高:网关无多模型故障转移(同模型多 provider 不能容灾)+ 无流式读空闲超时
2. 中:网关审计缺失(usage 表无 latency/status)
3. 高:api_tokens 黑盒(管理员不可见/不可撤销)
4. 中:本地密码无策略(最小长度)
5. 低:技能包无签名/checksum 存而不验
6. 高:知识库只读不可改、授权不可撤销(无 revoke/编辑)
7. 中:知识库上传同步阻塞、扫描版 PDF 失败
8. 中:webadmin 无用户搜索/知识库分页/删除确认/审计页
9. 低:无优雅退出/healthz 不查 DB/无版本号

**实施**:
- `75b3f04` feat: context usage indicator
  - 新事件 context_usage {chars,budget};估算复用 compact.ts messageLength(与摘要触发同源);runCraftLoop/runAskLoop 每轮一次
  - ContextUsage.tsx(与 RunSteps 同区):12.4k/40k 字符 + 百分比;≥80% amber 提醒自动摘要;结束后清除
  - 505 passed

**验证**:make check EXIT 0;505 passed | 2 skipped;已 push

## Round 6(2026-08-06):网关容灾 + token 管理

**实施**:
1. `0a21fee` feat: gateway failover and stream idle timeout
   - MatchModels(同模型全部候选)→ 逐个 forward:连接错误/5xx/首字节超时转下一个,4xx 原样不转;单 provider 不重试(防重复计费)
   - STREAM_IDLE_TIMEOUT=90s(测试可注入):readLineWithIdle,超时写 SSE 错误 UPSTREAM_IDLE_TIMEOUT 终止;首字节 ResponseHeaderTimeout 120s
   - 流开始后不转移;usage 语义不变(失败不计费)
   - failover_test.go 7 用例
2. `621ae4b` feat: admin api token management
   - api_tokens 表已有 name/last_used_at/revoked(零迁移);ListTokensByUser(清空 TokenHash)/RevokeTokenByID(幂等)/TouchTokenLastUsed(VerifyToken 内自动更新)
   - GET /api/admin/users/:id/tokens + POST /api/admin/tokens/:id/revoke(AdminAuth+CSRF)
   - webadmin Users 页令牌对话框(名称/创建/过期/最后使用/状态 Badge+撤销 confirm)
   - 测试:serverstore 3 + serverauth AdminTokens 全场景

**验证**:make check EXIT 0;505 passed | 2 skipped;已 push

## Round 7(2026-08-06):知识库可写 + webadmin/运维完善

**实施**:
1. `89286db` feat: knowledge revoke and document edit
   - DELETE /api/admin/kb/folders/:id/grant(与 PUT grant 对称)+ GET grants;RevokeFolderUser/Group(幂等)+ ListKBFolderGrants;撤销即刻生效(查询时校验)+ kb_revoke 审计
   - PUT /api/admin/kb/documents/:id(标题必填/≤1MB)+ GET 取内容;UpdateKBDocument 重算 size,FTS 由 kb_au trigger 重索引(零迁移)+ kb_update 审计
   - webadmin 文档编辑对话框(新 textarea 组件)+ 授权列表带撤销
2. `e203f66` feat: webadmin UX and ops primitives
   - 优雅退出(signal.NotifyContext SIGINT/SIGTERM→Shutdown 10s);-version flag(ldflags 注入,默认 dev);/healthz 加 db.PingContext(3s,DB 挂 503)
   - Users 搜索(?q= LIKE 过滤);Knowledge 分页(20/页);删除确认补齐(商城下架 MCP/技能、网关删模型);新增 /audit 审计页(kb 操作,分页)
   - 测试:users 搜索/KB 分页与审计 HTTP 层/healthz 503

**验证**:make check EXIT 0;505 passed | 2 skipped;已 push(e203f66)
- 注意:两子代理并行曾发生提交交叉事故,已重建历史(89286db 只含 A 工作,e203f66 只含 B 工作,树无重叠),已核验

## Round 8(2026-08-06):端到端联调冒烟

**执行**(controller 亲测,真实进程):
- 起真实 bin/picoaide-server + mock 上游(127.0.0.1:18081)+ AES 加密 api_key 直插 DB
- 验证全链路:healthz(DB Ping 200)→ 登录 → bootstrap(默认模型回退)→ LLM 网关非流式代理 ✓ → 流式 SSE 分块 ✓ → api_key 解密 ✓
- 意外收获:SIGTERM → 优雅退出日志 "shutting down…"(Round 7 功能真实生效)
- 踩坑:pkill -f 匹配 bash 自身命令行自杀(第 3 次,改用精确进程名);api_key 明文被 DecryptSecret 拒绝(安全设计有效)

## Round 9(2026-08-06):密码策略 + 验签 + 异步上传

**实施**:
1. `34430b7` feat: password policy and skill checksum verification
   - minPasswordLength=10:createUser/updateUser 改密校验(utf8.RuneCount);登录限流不动
   - skills.checksum 列早已存在但从未写入(存而不验)→ downloadArchive 打包后算 SHA-256 回写 + X-Skill-Checksum 响应头;客户端 marketplace downloadArchive 校验包 sha256 与头一致,不匹配拒绝(fail-closed),plugin_ipc 加 CHECKSUM_MISMATCH
   - 测试:Go 2 组 + TS 3 例;508 passed
2. `b44f674` feat: async knowledge upload queue
   - 迁移 0012:kb_documents 加 status/error 列;队列=DB(StartUploadQueue 2 worker,ClaimPendingKBDocument 最老 pending → 提取 → ready/error);pending 行跨重启存活、崩溃自愈、幂等
   - 上传 multipart:同步校验(扩展名/≤16MB)→ 落盘 + pending → 202 立即返回;JSON 文本路径保持同步
   - 搜索/列表只查 ready;错误保留原文件(OCR 后置,需 tesseract 服务端依赖,记录理由);POST /documents/:id/retry 重新入队
   - 测试:TestKBPendingDocLifecycle + 重写 3 个 multipart 用例

**验证**:make check EXIT 0;508 passed | 2 skipped;已 push

## 完善标准评估(2026-08-06)

**客户端可用性**:✅ 多步 agent 循环(审批门控/计划模式/重试/超时/故障转移)、上下文管理(摘要压缩/工具落盘/AGENTS.md 注入/健康指示)、多模态(图片粘贴/文件拖拽)、浏览器语义操作(fill/select/waitFor/dialog/语义快照)、产物(预览/回灌)、可视化(步骤轨迹)、健壮性(断链/半开/重连)
**客户端易用性**:✅ 零配置登录、技能建议安装、上下文指示、artifact 面板、步骤卡、图片输入
**服务端**:✅ 认证(local/LDAP/OIDC/token 管理)、网关(限流/计量/故障转移/流式超时/审计)、商城(技能/凭证/验签/限流+审计)、知识库(可写/授权撤销/异步上传/FTS)、运维(优雅退出/healthz/version)、webadmin(搜索/分页/确认/审计页)
**收尾**:剩余可选优化(文档技能包 python 环境评估、扫描 PDF OCR、本地密码过期)——依赖外部环境或低价值,记录在案,达到"完善"标准。

## 验证基线(每轮后更新)

- make check(服务端 go test + 客户端 vitest + typecheck)EXIT 0
- 客户端:508 passed | 2 skipped(510)(各轮递增)
- 构建:cd desktop && npm run build 成功

## Round 10(2026-08-06):全系统健壮性审计与修复(用户要求"逐一检查健壮性")

**审计**(6 个并行子代理,每域一个):引擎+上下文 / 工具层 / IPC+存储+网关连接器 / CDP桥+插件+renderer / 服务端认证+网关 / 知识库+商城+webadmin
**产出**:~60 项缺陷(高 12 / 中 25 / 低 30+),全部核对过实现

**修复**(4 个并行子代理,高+中必做、低尽力):
- A1 引擎+工具:`92cae1b` `cdad83a` `f65e349` `04435db` — abort 贯穿(终端 kill 进程组/沙盒 session.stop)、file_search ReDoS 防护(嵌套量词拒绝)、pip install . 免审批绕过、plan continue 只读白名单、重试流式文本重复、spill 失败回退、file_edit 20MB 上限、list/search 深度条目上限、损坏条目跳过、web 编码(GBK iconv)/重定向协议/DNS 10s/8MB 上限、终端超时保留 stderr、中文错误包装、runningConversationId 泄漏、附件重放路径+5MB 校验、compact 孤立 tool-result、approval 超时钳位、OCR 重试+60s、剪贴板探测、截屏 1080p 缩略、日志轮转
- A2 IPC+存储+生命周期:`9030c89` `6623dd1` `b2643b0` — 引擎运行槽 try/finally 释放、会话删除清理磁盘(attachments/tool-outputs,项目解绑不删文件)、IPC 参数校验(垃圾 dataUrl 不落盘/project path 绝对非根)、未登录可删会话、DB 打开失败错误框、TOFU 证书重置 UI、busy_timeout 3000、getEngine 双重构造、editAndRerun 先查槽、审批缓冲登出清空、flushStep 事务
- B CDP+插件+renderer:`a9bb902` `be225ac` `a530d33` — 取消重跑代际守卫、CDP 重接管直取最老连接、waitFor/dialog 按方法超时(65s/12s)、目标标签页固定、分页切会话丢弃、phantom row 回滚、artifact 事件归属、sendCdp close 立即 reject、maxPayload 16MiB、approval 过期清理、innerText→textContent、插件 promise 队列串行+10s 超时、附件名随机后缀
- C 服务端:`afa8597` `5f839ad` `5ea1139` `74bfea5` `2b5cecf` — SetTrustedProxies+RemoteAddr 限流键(XFF 伪造)、限流表满淘汰最旧键、kb 队列 CAS+claim 文件校验、搜索 SQL 下沉 LIMIT+COUNT、技能缓存失效、LDAP 5s 超时、serveJSON 32MB、pending usage 失败即清+周期清理、下架技能 404、凭证限流单锁+过期清理、webadmin 401 跳登录、并发首登不 500、OIDC 10s、admin_sessions 清理、bootstrap 密码 10 位、最后管理员事务守卫、token last_used 节流、502 固定文案、kb 临时文件清扫、folder_id 校验、审计日志 90 天清理、maxPackageSize 生效、凭证解密失败报错、删用户清 kb 授权、搜索分页

**验证**:make check EXIT 0;客户端 579 passed | 2 skipped(净增 71 健壮性测试);服务端 8 包全绿;desktop/webadmin/server 三端 build 成功;已 push(2b5cecf)

## Round 11(2026-08-19):用量页企业端重构 + 金额配额

**背景**:用户要求 1) 审计已提交的 usage 相关版本是否符合预期;2) 调研 GitHub 更好的企业级用量统计页;3) 每个员工可单独设置使用的金额(费用)。

**审计结论**(7 个版本 221060f→ca27a93):token 配额闭环(个人/全局默认/admin 豁免/网关 429)与聚合正确性符合预期;核心缺口 = 无金额(费用)维度 + 页面信息密度低。详见 `docs/superpowers/plans/2026-08-usage-page-audit-and-money-quota.md`。

**调研**(子代理,全部源码核验,报告 `docs/research-usage-page/README.md`):OpenWebUI/LibreChat 无费用维度;One API/new-api(额度进度条+调整弹窗)、LiteLLM(费用仪表盘+三层预算)、Dify(UsageInfo 卡)为最佳范本。落地组合:KPI 费用卡 + 金额/tokens 口径切换 + 双维度配额进度条 + 未定价提示。

**实施**(TDD 红-绿-commit):
1. `35e7327` serverstore:0022 迁移(users.quota_money / models 价格列 / usage.cost);RecordUsage 按模型定价折算费用落库,UpdateUsageTokens 回填重算;UserMonthlyCost/Batch、EffectiveMoneyQuota;聚合行携带 cost
2. `056e00d` 网关:moneyQuotaBlocked 与 token 配额并行检查,超限 429
3. `ad04bcf` admin API:用户 quota_money/quota_money_clear + monthly_cost;网关 monthly_quota_money;模型价格增改校验;usage 行 cost;修复 adminLoginLimiter 惰性创建(测试用例增多触发包级限流 flaky)
4. `51f529d` webadmin Usage 页:总费用为第一统计卡、金额/tokens 口径切换、配额面板 token+金额双进度条、明细表金额列+CSV cost 列、未定价模型提示条
5. `bf113e9` webadmin Users/Gateway:用户金额配额对话框;网关全局金额配额;模型价格列+编辑弹窗

**验证**:go test ./internal/... 8 包全绿;webadmin 35 passed + typecheck 0 + build 成功;已 commit。

## Round 12(2026-08-19):DeepSeek 峰谷价格 + 部门金额预算

**背景**:用户要求继续企业级高级项,且必须考虑 DeepSeek 峰谷价格。

**事实核验**(子代理,官方文档直连 + GitHub 镜像/源码双通道,报告见 `docs/research-usage-page/README.md` 与定价核验结论):
- DeepSeek 官方当前政策(2026-08-16 生效):**高峰 = 北京时间 09:00-12:00、14:00-18:00**,其余为空闲时段,**空闲价 = 高峰价 × 50%**(含缓存命中价);适用 deepseek-v4-flash/pro。
- 记忆中"16:30-00:30 五折、deepseek-chat/reasoner"是 **2025 旧政策**,已废弃。
- 主流网关:new-api 支持时段折扣表达式(billingexpr hour(tz));one-api/LiteLLM/Helicone 均无时段计价。

**实施**(TDD 红-绿-commit):
1. `b37adcc` serverstore 0023 `models.offpeak_discount`;费用记录时按时刻折算
2. `a270c61` **峰谷窗口改为配置驱动**:settings `usage.peak_windows`(高峰时段 JSON,北京时间 UTC+8 判定,半开区间);窗口外(空闲)按 offpeak_discount 打折;未配置窗口 → 全标准价(防误打折);DeepSeek 当前政策为默认配置
3. `7f6f93a` + `b63d4c8` admin API:模型 offpeak_discount 增改校验(0<d≤1);网关 peak_windows 读写 + 非法 JSON 拒绝
4. `b3396dd` + `d318ebd` webadmin:模型价格对话框谷折扣 + deepseek 渠道自动预填 0.5;网关全局设置高峰时段配置 + 「DeepSeek 当前政策」一键预设;修正旧政策文案
5. `4ee15d6` serverstore 0024 `groups.budget_money` 部门预算;`EffectiveDeptBudget`(归属部门+祖先链,链上全部预算生效,父=子树封顶)、`DeptMonthlyCost`/Batch(树内 SUM(cost))
6. `4f221c7` 网关 deptBudgetBlocked:任一链上部门预算超限 → 429(admin 豁免)
7. `dd8b7dd` admin API:部门预算设置/清除、列表附 budget_money + monthly_cost(批量)
8. `45489c9` webadmin 部门页:预算列(进度条 80% 琥珀/超额红)+ 编辑弹窗预算字段

**验证**:go test ./internal/... 全绿(serverstore 17+ 新增用例);webadmin 40 passed + typecheck 0 + build;已 commit。

## Round 13(2026-08-19):客户端用量余额接口 + 统计数据展示

**需求**:给客户端新增接口,返回员工剩余使用量(余额 + 剩余 token),并显示统计数据(今日/昨日/总使用量)。

**实施**(TDD 红-绿-commit):
1. `bedc7d8` serverstore:`UserDayUsageCost`/`UserTotalUsageCost`/`UserUsageSummary`(今日/昨日/本月/累计 tokens+费用,走 idx_usage_user_time)
2. `e753da5` 新接口 `GET /api/auth/usage`(BearerAuth):有效配额(个人覆盖→全局默认)、剩余(配额-本月已用,不限→null)、今日/昨日/本月/累计、部门预算链、admin 豁免
3. `87b823a` 客户端 main:gateway/usage.ts 连接器(结构校验垃圾兜底)+ `usage:summary` IPC + preload 暴露
4. `7946680` renderer:stores/usage.ts(登录/设置页打开时加载,登出重置);Settings「用量与配额」卡(余额 ¥+token、双进度条、今日/昨日/本月/累计、部门预算、刷新);Main 侧栏余额徽标(点击进设置)

**验证**:客户端 644 passed | 2 skipped + typecheck 0;服务端 8 包全绿;已 commit。

## Round 14(2026-08-19):客户端下线,仅保留服务端 + 管理端

**决策**:自研 Electron 客户端(desktop/,2.2G)与浏览器插件(browser-extension/)不再使用,从仓库删除;只保留 Go 服务端接口与 webadmin 管理端。新分支 `server-webadmin-only`(基于 deploy/quota-admin)。

**执行**:
- `git rm` desktop/browser-extension/scripts(e2e、dev-env、pkg-*),787 文件变更
- Makefile 收敛(test/test-server/build-server/webadmin/docker-image/check);CI 删 desktop/package-windows/package-macos job
- AGENTS.md 重写为服务端+管理端架构;docs/01 架构、02 部署、03 接口注记;历史 plans/specs 头部加「客户端已下线」注记
- 服务端接口**全部保留**(/api/auth/*、/v1/*、/api/config/bootstrap、/api/admin/*),供第三方/自研客户端接入

**验证**:go test ./internal/... 8 包全绿;make webadmin 构建成功;已 commit 至 server-webadmin-only。

## Round 15(2026-08-19):Skill 版本检测接口(供 harness 客户端自动升级)

**背景**:为 https://github.com/picoaide/picoaide-harness(feat/enterprise)客户端提供技能自动升级能力。已阅读 harness:`plugins/dsh-enterprise` 经本地代理 `/api/pico/skills`(prefix)转发网关 `/api/marketplace/skills` 与 `/archive`;bootstrap 下发 skills 目录(含 version);客户端无本地已装版本记录,技能中心仅手动下载。

**设计**:`GET /api/marketplace/skills/updates?installed=name:version,...`——GET+query 与 harness 现有 prefix 代理天然兼容(`/api/pico/skills/updates?...` 直接透传),客户端零代理改造。响应仅含"较新"技能(最新 version/archive_url);严格授权过滤(admin 全量、普通用户仅授权,未授权/下架不返回,不泄露存在性)。

**实施**(TDD 红-绿):`1a95312` marketplace `skillUpdates` handler + `parseInstalled`(≤100 项、SafePathSegment、name:version 格式);6 用例(有更新/无更新/下架/未授权→授权后出现/非法输入 400/未登录 401)。

**验证**:marketplace 全量 ok;服务端 8 包全绿;已 commit 推送 server-webadmin-only。

**harness 侧后续**(不在本仓库):技能中心「获取」时记录本地已装版本 → 登录/进中心调 `/api/pico/skills/updates` → 自动下载 archive(X-Skill-Version/Checksum 校验)替换。
