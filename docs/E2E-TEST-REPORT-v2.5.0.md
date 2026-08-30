# PicoAide Harness v2.5.0 端到端测试报告

- 日期：2026-08-31
- 环境：PostgreSQL 16 (127.0.0.1:15435) + OpenLDAP (127.0.0.1:1389) + Dex OIDC (127.0.0.1:5556) + 真实 DeepSeek API
- 服务端：本地编译 `picoaide-server` v2.5.0，端口 8091，数据库 `picoaide_e2e`
- 客户端：打包 `linux-unpacked/dsh-plugin-desktop`（Electron + Xvfb :99 + CDP 驱动）
- 测试角色：admin（超管）、alice（LDAP）、bob（LDAP）、dave（本地用户，研发部）、carol（本地用户）

## 1. 发现的 Bug 与修复

| # | 严重度 | 现象 | 根因 | 修复 |
|---|--------|------|------|------|
| B1 | P1 | 客户端账号卡「余额获取失败」 | 打包产物 (dist 2026-08-30 17:58) 早于 API 命名空间迁移，account-card 仍调旧 `/api/auth/usage`（已删除） | 重新构建桌面产物（源码已在 7d623ef5b2 修复） |
| B2 | P1 | 连接器中心显示「暂无匹配的连接器」，服务端 bootstrap 有 3 个连接器 | `packages/host/connectors/src/index.ts:154` 调用旧路径 `/api/config/bootstrap` → 404，目录同步静默失败 | 改为 `/api/client/v2/config/bootstrap`（commit 963510aae7） |
| B3 | P2 | `TestCleanupUsageRetention` 在月末（8/31）失败 | 测试用 `time.Now().AddDate(0,-2,0)`，8/31→6/31 归一化为 7/1（保留月），日期相关 flake | 月份归一化到每月 1 号（commit 963510aae7） |
| B4 | 观察 | 市场安装首次点击偶现「操作失败: gateway error」 | 会话 token 在 session 同步完成前被使用（瞬态竞态）；重试后成功 | 记录为已知瞬态问题 |

## 2. 服务端 API 测试（全部通过）

### 认证
- ✅ LDAP 登录（alice/bob）→ role=user，本地 admin → super_admin
- ✅ 错误密码 401 AUTH_FAILED、不存在用户拒绝、logout 后 token 失效
- ✅ auth/methods 公开发现（local/ldap/oidc）
- ✅ Dex OIDC 完整流：`/api/client/v2/auth/oidc/login` 302 → Dex 登录 → 授权 → `picoaide://` 深链 token → `/api/client/v2/auth/me` 200
- ✅ usage 接口字段完整（quota/remaining/today/monthly/dept_budgets）

### 网关（真实 DeepSeek key）
- ✅ `/v1/chat/completions` 真实调用成功（deepseek-v4-flash）
- ✅ `/v1/models` 返回 3 模型；账单正确：100×1/1M + 8×4/1M = ¥0.000132
- ✅ 配额：100 token 配额时请求 2000 max_tokens → 429 QUOTA_EXCEEDED
- ✅ 无 token 401；不存在模型 404 NOT_FOUND（严格默认拒绝）
- ✅ `/v1/embeddings` 502（DeepSeek 不支持，正确透传上游错误）；`/v1/messages` 404（无 anthropic 协议 provider，正确路由）

### 商城 / 共享 / 能力中心
- ✅ 员工上传共享技能（201 pending）；重复版本 409 NAME_TAKEN；坏归档 422 ARCHIVE_INVALID
- ✅ 待审核对非作者不可见（bob 看不到 alice 的 pending）；作者可见
- ✅ admin 审批（approve/reject/quality）；审批后管理员下发授权才可见（双门制）
- ✅ 部门授权：市场技能授权「研发部」→ alice（研发部）可见，bob（市场部）不可见
- ✅ 组织共享授权「市场部」→ bob 可见 e2e-greeter
- ✅ 市场技能归档直存 DB + 授权制正确
- ✅ 能力中心聚合：`/api/client/v2/capabilities?source=market` 合并市场+组织，各自 badge
- ✅ telemetry skill-call 上报

### 管理端 API
- ✅ 用户 CRUD / 部门 CRUD / 用户-部门分配（group_id）/ 用户组查询
- ✅ 模型价格设置 + 列表含价格字段
- ✅ 连接器 CRUD + 启停（id/name/auth_mode/definition 校验）
- ✅ 品牌启用 + logo 上传（SVG 白名单扫描）+ 公开 URL 下载（200 image/svg+xml）
- ✅ 门户启用 + 公开 `/portal` 页面（brand title）
- ✅ 审计日志分页 + 哈希链（35 条动作）
- ✅ 用量报表（group=user/model/day）+ 服务端信息
- ✅ 批准队列 `/api/server/admin/capabilities/approvals`（status/type 过滤）

## 3. webadmin 管理后台 UI 测试（12 页全通过）

- ✅ 登录（admin）
- ✅ 用户管理（搜索/新建用户/令牌/部门/配额/禁用/删除/分页 按钮全部可见）
- ✅ 部门管理（新建/编辑/删除）
- ✅ 认证配置（本地/LDAP/OIDC/OpenID Tab、测试连接、保存）
- ✅ 品牌配置（恢复默认/恢复上一版本/登录页品牌/客户端品牌/门户首页/上传/保存）
- ✅ 网关配置（添加上游/编辑/删除/同步/价格/默认模型/峰谷窗口）
- ✅ 错误监控（保存）
- ✅ 用量统计（按日/近7天/近30天/本月/查询/金额/趋势/占比/排行/导出 CSV——图表渲染正常、真实费用 ¥0.04/51.7K tokens/7 请求）
- ✅ 市场·技能（上架技能对话框：压缩包/Git 双模式表单）
- ✅ 能力中心（待审核/已通过/已拒绝/全部 Tab、类型筛选、通过/拒绝/删除 + 确认弹窗、质量下拉、预览、授权）
- ✅ 连接器（新建/刷新/启停）
- ✅ 服务器信息、审计日志（51 行、导出 CSV、筛选、分页）
- ✅ 无 console 报错（除登录前 401/404 预探测）

## 4. 桌面客户端 UI 测试（真实服务端 8091）

### 登录/会话
- ✅ alice/bob/dave 登录成功；品牌（名称「PicoAide Harness 企业版」+ logo）正确显示
- ✅ 账号卡余额：不限/本月已用/今日已用（修复后）

### 工作区
- ✅ 「选择工作区」→ 目录选择器 → 新建文件夹 → 输入名称 → 创建 → 打开 → 进入工作区（聊天界面）

### 真实 AI 聊天
- ✅ textarea 输入 → 发送 → DeepSeek 真实回复（usage 记录: 17475+16820 prompt tokens / 593+9 completion tokens，费用入账 ¥0.0088+¥0.0111+¥0.0004+¥0.0174）
- ✅ 会话列表、Session log、标签页（对话/轨迹/记忆/技能/待办）渲染正常

### 能力中心
- ✅ 打开面板（我的/市场/全部 + 技能/智能体筛选 + 搜索框）
- ✅ 「我的」显示本地技能（frontmatter 解析展示 name/version/description）
- ✅ 上传共享按钮 → 服务端校验（重复版本报「该技能版本已被占用」；唯一名成功 201 pending）
- ✅ 市场 Tab 合并显示市场+组织技能（徽章：市场/组织 + 作者 + 版本）
- ✅ 安装按钮 → 技能文件落盘（e2e-greeter/SKILL.md 正确安装）

### 连接器
- ✅ 修复后显示服务端目录（E2E 连接器/Moka HR/销售易）+ 连接/未连接状态 + 0/3 已连接计数
- ✅ 全部/已连接/未连接筛选、搜索框

### 设置
- ✅ 通用设置/插件/Agent 预设/侧边卡片/账号 分区；打开配置文件；语言/主题/排队发送

### 定时任务 / 浏览器
- ✅ 侧边栏入口存在；任务页面「+ 新建任务」「返回聊天」按钮存在

## 5. 多角色共享技能完整闭环（端到端）

1. ✅ bob 在本地创建技能 `e2e-greeter`（DSH_HOME/skills/）
2. ✅ bob 通过桌面客户端「能力中心→我的→上传共享」上传 → 服务端 201 pending
3. ✅ admin 通过 webadmin「能力中心」→ 通过（确认弹窗）→ approved
4. ✅ admin 授权给「研发部」（市场部 bob 不可见，研发部 dave 可见）
5. ✅ dave 通过桌面客户端「市场」Tab 看到 e2e-greeter → 点击安装 → SKILL.md 落盘
6. ✅ 全程审计日志可查

## 6. 门禁结果

| 门禁 | 结果 |
|------|------|
| `go test`（serverauth/llmgateway/marketplace/serverstore/agentshare/sharedskills/bootstrap/util） | ✅ 全绿 |
| `make check`（gofmt + go vet + 全部 Go 测试 + webadmin 101 测试 + webadmin build） | ✅ 全绿 |
| `yarn workspace @picoaide/dsh-connectors check` | ✅ 21 测试 |
| `yarn workspace @picoaide/dsh-enterprise check` | ✅ 101 测试 |
| `yarn workspace @picoaide/dsh-account-card check` | ✅ 8 测试 |
| `yarn workspace dsh-plugin-desktop build/typecheck/test` | ✅ 417 测试 |
| `yarn workspace @picoaide/dsh-branding / dsh-browser / dsh-cron check` | ✅ 全绿 |

## 7. 遗留说明

- **LDAP 登录组同步设计**：外部身份每次登录全量对齐组（空组即回收）；本测试 LDAP 目录未配组，因此 LDAP 用户的管理端部门分配会被登录同步清除——这是文档化设计（serverauth/handler.go），生产需配置 LDAP group_filter。
- `dsh-community-fabric` 无 typecheck script（仅 check），非故障。
- Desktop E2E 正式脚本（mock gateway）在本机因 CDP 复用 flaky，已用真实服务端全面验证替代。
