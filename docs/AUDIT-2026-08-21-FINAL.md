# PicoAide Harness 企业版整体审计报告

> 审计日期：2026-08-21
> 审计方式：① 全量代码审计（Go 后端 + webadmin 前端 + Electron 客户端 + 9 个业务插件）② 真实客户端交互（Electron 43.4.0 + Xvfb :99 + CDP 驱动，登录 user001）
> 验证方式：真实登录、真实会话、真实数据（截图 19 张，见 `.audit/` 与 `.smoke/`）

---

## 一、总体评分与结论

| 维度 | 评分 | 结论 |
|------|------|------|
| 安全基线 | 4.5/5 | 无 SQL 注入/路径遍历/命令注入/XSS/CSRF 绕过；沙盒/IPC 防护扎实 |
| 代码质量 | 4.0/5 | 结构清晰；但存在计量绕过、无兜底崩溃等健壮性问题 |
| 易用性/UX | 3.5/5 | 功能完整但多个反人类设计（状态残留、无取消、无高亮） |
| **综合** | **3.8/5** | 架构优秀，但存在 P0 级流程缺失需修复 |

---

## 二、代码审计问题（84 条）
### 后端 Go（17 条：P0×0 / P1×2 / P2×8 / P3×7）

**P1（2）**
1. 流式计量绕过（`llmgateway/handler.go:342-417`）：网关从不注入 `stream_options.include_usage`，默认流式对话无用量 → token/金额配额与部门预算被绕过
2. KB 检索无界 DoS（`knowledge/chunk_index.go:400-436` + `mcp.go:47-50`）：候选 SQL 无 LIMIT，短词命中全库 chunk 载入内存

**P2（8）**：kb_search page 整数溢出 panic；skill 下载 TOCTOU 竞态+clone 无超时；禁用 LDAP admin 仍可完成管理登录；配额 check-then-record 竞态+三处 fail-open；上游 4xx 错误体透传；admin session cookie Secure 默认关；下架 404 消息泄露；用户名未校验

### webadmin 前端（32 条：P0×0 / P1×4 / P2×17 / P3×11）

**P1（4）**
1. 令牌时间戳 `slice(0,16)` 丢时区偏移（Users.tsx:49-51，UTC 服务器下差 8h）
2. 网关/知识库/商城提交按钮无 busy/disabled 双击重复创建（Gateway.tsx:139-169）
3. 登录 Enter 重复提交（Login.tsx:14-26）
4. 列表请求无 abort/序号快速翻页乱序覆盖（Users.tsx:101-117）

### Electron 客户端（19 条：P0×0 / P1×3 / P2×16）

**P1（3）**
1. 更新链供应链信任：硬编码 dshdesktop.cn 端点 + 仅魔数校验无签名 + redirect follow + --force-run
2. 渲染进程崩溃/加载失败仅日志无兜底 UI（白屏）
3. Renderer 会话缺 setPermissionRequestHandler（自动批准摄像头等）+ 无 CSP

### 业务插件（34 条：P0×3 / P1×11 / P2×20）

**P0（3）**
1. **dsh-connectors OAuth 授权流无超时且无法取消**：disconnect 不中止 in-flight 流程，授权流完成后会复活写回凭据；auth-submit HTTP 全程 await 授权流导致面板永久卡死
2. **dsh-memory-evolve 记忆文件写入无权限参数**（默认 0644 与 connectors 0600 纪律不一致）
3. **dsh-task 运行中任务无 cancel**；崩溃后带 sessionId 的 pending 执行永久 pending，阻塞一切编辑/删除/重跑

**P1 代表**：browser 遮罩错误显示；account-card 每 10s 网关请求；enterprise Linux safeStorage 下 session 永不持久化；cron ledger 损坏静默重置；browser fillCredentials 无目标 URL 绑定；browser open() cdp.attach 失败泄漏 WebContentsView；enterprise session 异步恢复竞态

---

## 三、真实 UI 交互发现（19 张截图）

### ✅ 已验证正常
- 登录/登出/重登（历史保留）
- 错误密码提示"账号或密码错误"
- 浏览器地址栏导航（输入 baidu → 成功导航）
- 浏览器接管/释放（释放后正常）
- 会话启动/工具调用/AI 回复（"帮我整理本周工作总结"）
- 记忆/技能/待办 tab（五轨记忆完整）
- 设置页插件分区

### ⚠️ UI 问题（已截图标注）
| # | 截图 | 问题 |
|---|------|------|
| 1 | 20-taskboard-clean.png | [P0] 任务看板"返回聊天"按钮 w=0/h=0 布局塌陷 |
| 2 | 26-connectors.png | [P0] 连接器"连接中…"无取消按钮（永久卡死）+ 状态残留 |
| 3 | 26-connectors.png | [P1] 两个连接器同时"连接中…"（无互斥） |
| 4 | 29-settings.png | [P1] 退出登录颜色不一致（红色 vs 灰色） |
| 5 | 23-cron.png | [P1] Cron 预选 chip 无选中高亮 |
| 6 | 24-skills.png | [P2] 技能卸载无确认/撤销 |
| 7 | 21-main-hero.png | [P2] hero 输入框"描述你想要构建的内容"无上下文说明 |
| 8 | 22-conversation.png | [P2] 消息流展示 Think 块（思考过程对用户噪音） |
| 9 | 31-login-page.png | [P2] 登录页服务端地址无预填 |
| 10 | 25-skills-after-uninstall.png | [P2] 卸载后技能行仍在（不消失） |

---

## 四、向用户确认的问题清单

### A. 核心设计问题（需确认修复方向）
1. **连接器 OAuth 无超时/取消**：用户点击"连接"后无法取消，只能等超时。要不要加"取消连接"按钮 + 明确超时时间（如 30s）？
2. **任务看板"返回聊天"按钮塌陷**：代码里是否已有修复计划？还是需要我提供具体 CSS 修复建议？
3. **会话 Think 块是否显示**：普通员工看到 AI 思考过程是噪音。要不要默认折叠/隐藏（高级用户可在设置打开）？
4. **登录页服务端地址**：企业版应该预填服务器地址（defaultServer 配置）？还是让用户每次输入？
5. **Cron 预设选中态**：点击"每天 09:00"后无高亮。是否要加选中态样式？

### B. 功能兜底问题（需确认是否存在预期行为）
6. **技能卸载**：是否需要二次确认？（用户可能误点）
7. **新建任务表单**：空标题点击"创建"无错误提示。要不要加必填校验 + 红色提示？
8. **销售易连接状态残留**：切换到其他页面再回来仍是"连接中…"。是否要在面板卸载时清理？
9. **会话重命名**：入口通过"会话操作"菜单（3 dots），可发现性低。要不要在会话行直接显示？
10. **工作区切换**：点击工作区按钮无反馈（菜单位于 hover），要不要加更明显的入口？

### C. 安全/计量问题（P1 级，需确认修复优先级）
11. **流式计量缺口**：token 用量计费可能被绕过。是否现在修？（影响企业成本）
12. **记忆文件权限 0644**：与 connectors 的 0600 不一致，多用户机器上可能被同机用户读取。是否统一为 0600？
13. **渲染进程崩溃无兜底 UI**：窗口白屏时用户无法恢复。要不要加"重新加载"按钮？

---

## 五、修复优先级建议

**立即修复（P0）**
1. 连接器 OAuth 超时/取消 + 状态互斥
2. 任务看板返回按钮布局
3. 记忆文件权限 0600
4. 任务 pending 阻塞（cancel + 超时清理）

**尽快修复（P1）**
5. 流式计量注入 `stream_options.include_usage`
6. KB 检索 LIMIT + 限流
7. 渲染进程崩溃兜底 UI
8. 登录页 defaultServer 预填
9. 退出登录颜色统一
10. Cron chip 选中态

**建议改进（P2）**
11. 技能卸载确认
12. 新建任务必填校验
13. 会话 Think 折叠
14. 连接器互斥管理

## 六、插件审计重点补充（34 条）

**P0（3）**：① 连接器 OAuth 授权流无超时/无法取消，disconnect 后授权流"复活"写回凭据（auth.ts:187-247）；② 记忆文件写入默认 0644 权限（store.js:780-783，与 connectors 0600 不一致）；③ 运行中任务无 cancel，崩溃后永久卡 doing（host-runner.ts:117-165）

**P1（11）**：浏览器遮罩错显（runtime.ts:250-257）、loadURL 未捕获拒绝、用量卡片 10s 轮询打网关（usage-service.ts:79-86）、Linux safeStorage basic_text 下 session 不持久化（session-service.ts:88-113）、启动时会话恢复竞态（session-service.ts:54-57）、技能归档无大小上限（auth-gate.ts:339-364）、cron ledger 损坏静默重置（host-ledger.ts:236-249）、凭据注入无 URL 绑定（tools.ts:642-659）、better-sidebar fs 读写无 cwd 约束（index.ts:234-257）、browser.probe SSRF（index.ts:409-451）、open() CDP attach 失败泄漏（runtime.ts:333-377）

**P2（20）**：tls.ts 死代码 TOFU、connect 无防重入、auth-submit 无类型校验、CLI 取消裸 "Aborted"、技能卸载无确认、技能目录加载失败无重试、归档下载 15s 超时偏紧、cron 30s 空转全量持久化、新建任务空标题静默、记忆写入无 fsync、withLock 重入键未规范化、提示注入扫描误伤、浏览器每按钮触发审批、导航守卫 URL 无法解析放行、fs.write tmp 竞态、sessionCwdOf 回退 cwd、renderHeaders 模板缺失静默、登出网关不可达静默、auth/state 竞态、用量刷新闭包旧 session

---

## 七、修复记录（2026-08-21 已完成，用户确认"全部按推荐"）

### 已完成修复（25 项）
**P0（4）**
- ✅ P0-1 连接器 OAuth 授权流：300s 整体超时 + 回调 server 中止 + `disconnect` 中止 + `cancel` 路由 + "取消连接"按钮 + connect 防重入（auth.ts/index.ts/ConnectorsSection.tsx/locales.ts）
- ✅ P0-2 记忆文件权限：全部 writeFileSync 改 0600 + fsync，mkdir 0700（store.js 6 处）
- ✅ P0-3 任务可取消：`cancel` action + "取消执行"按钮（带确认）+ `/stop` 中止会话 + 6h 老化判定（protocol/host-ledger/host-runner/host-service/TaskDetail/controller/locales）
- ✅ P0-4 任务看板返回按钮：验证为**假阳性**（隐藏面板 DOM 残留），加 flexShrink:0/minHeight 防御（styles.ts）

**P1（16）**
- ✅ P1-1 流式计量：`applyStreamUsageRequest` 注入 `stream_options.include_usage`（handler.go + 测试）
- ✅ P1-2 KB DoS：search/chunk SQL 加 LIMIT 1000 + words≤10 + query≤200 rune + 每用户 10/s 限流（search.go/chunk_index.go/mcp.go）
- ✅ P1-3 渲染崩溃兜底：reload 一次 + 失败显示错误页带"重新加载"（electron-runtime.ts）
- ✅ P1-4 Renderer 权限拒绝（setPermissionRequestHandler/CheckHandler）+ CSP 注入
- ✅ P1-5 webadmin 时间戳时区（Users.tsx fmtTime local timezone）
- ✅ P1-6 webadmin 按钮双击守卫（Gateway/Knowledge/Marketplace 6 文件，子代理）
- ✅ P1-7 webadmin 登录防重复提交（验证已防）
- ✅ P1-8 webadmin 列表请求序号防乱序（Users/Audit/Departments）
- ✅ P1-9 用量卡片普通 GET 只读缓存（index.ts）
- ✅ P1-10 Linux 无密钥环 session 降级 0600 明文 + warn（session-service.ts）
- ✅ P1-11 启动恢复竞态：isRestored() + RESTORING_HTML 过渡页
- ✅ P1-12 技能归档大小上限 16MB（auth-gate.ts）
- ✅ P1-13 cron ledger 损坏显式告警（CronJobTab + locales）
- ✅ P1-14 浏览器遮罩按控制态显示 + loadURL catch + open() 泄漏销毁
- ✅ P1-15 凭据注入审批显示目标 URL（tools.ts/runtime.ts）
- ✅ P1-16 better-sidebar fs 读写 cwd 约束 + probe 防重定向回环（isPrivateHostname）

**UX（4）**
- ✅ UX-1 退出登录颜色统一红色（AccountCard.tsx）
- ✅ UX-2 Cron 预设选中高亮（styles.ts/jobEditor + 验证通过）
- ✅ UX-3 技能卸载二次确认 + 加载失败重试按钮（SkillCenterPanel + locales）
- ✅ UX-4 新建任务空标题提示（NewTaskModal + locales）

**P2（2）**
- ✅ KB 分页整数溢出防护 ×2（search.go/pageChunkResults）
- ✅ 登录用户名/密码长度上限（handler.go）

### 验证结果
| 验证项 | 结果 |
|---|---|
| Go 测试（llmgateway/knowledge/serverauth） | 全绿 |
| webadmin tsc + vitest | exit 0 / 82 用例 |
| 插件 typecheck（connectors/enterprise/account-card/browser/cron/task/better-sidebar） | 全绿 |
| 插件 vitest（connectors29/enterprise30/cron53/browser47/task32/account-card） | 全绿 |
| 真实 UI 验证（重登录后） | 连接器"取消连接"✅、Cron 高亮✅ |
| 构建（6 插件 lib） | 成功 |

### 未实施（说明）
- **UX-6 Think 折叠**：需上游 ui-conversation 扩展点（deepseek-harness 只读禁用）；上游提供配置项后可做。CSS 折叠有类名后缀脆弱性（品牌机制已用同模式，但 Think 块是流式更新，风险更大），建议上游加配置。
- **P1-6 配额 fail-open**：设计决策（审计注明匹配 rate-limiter），未改。
- **P2-20 提示注入扫描误伤**：上游 vendor 行为，改 vendor 需同步上游，暂缓。
- **P2-27 浏览器每按钮审批**：安全与效率权衡，未改（保持安全）。
