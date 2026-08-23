# Changelog

## Unreleased

### 修复
- 客户端渲染层启用 `@tailwindcss/vite` 插件:此前 CSS 未编译、界面无样式
- 所有服务端 HTTP 统一走 `session.defaultSession.fetch`(TOFU 生效):LLM 网关请求与 MCP HTTP 传输此前绕过证书校验

## v0.4.0 — PicoAide Desktop 0.4.0

### 服务端网关(阶段 1)
- 认证:本地账号(argon2id)/LDAP(组映射)/OIDC(PKCE + state)/api_token(90 天、哈希存储、可吊销);`--bootstrap-admin` 超管引导(密码经 `PICOAI_ADMIN_PASSWORD`,缺失拒绝启动);登录限流(10 次/5 分钟,有界窗口)
- AI 网关:OpenAI 兼容 `/v1/chat/completions` 代理(流式 SSE 透传、上游 5xx 重试 1 次)、per-user 令牌桶限流(默认 60/min 可配)、usage 计量(流式待定行 + 回填 + 启动清理)
- 商城:Skill 商城(Git 浅克隆打包 tar.gz,路径/符号链接/大小校验)+ MCP 插件商城(建议安装制,凭证 AES-GCM 加密,per-user 限流 + 下载审计)
- 知识库:SQLite FTS5(unicode61 前缀查询 + LIKE 兜底,权限按用户/组/全局)、远程 MCP(kb_search/read/list/upload,逐操作权限校验 + 审计)
- 启动配置:`GET /api/config/bootstrap` 统一下发默认模型 + 模型列表 + 技能/MCP 建议清单 + web 配置(员工零配置)
- 管理端:session cookie + CSRF(HMAC 双窗口)、用户/网关/用量/商城/知识库管理 API + webadmin 五页(shadcn/ui,含用量柱状图)

### 客户端骨架(阶段 2)
- Electron + React + shadcn/ui + zustand;登录页(HTTPS 校验/OIDC 深链 `picoaide://auth?token=`)/主界面(会话列表 + 聊天 + 打字机)/离线检测与自动重连(区分 401 过期)
- better-sqlite3 本地四表(WAL);Vercel AI SDK v7 引擎探针(streamText + 审批门控);网关客户端(safeStorage token 持久化/TOFU 指纹校验/session.defaultSession.fetch)

### 本地能力(阶段 3)
- 本地工具:文件(编码自动检测 GBK/UTF-16/docx 抽取)、终端(白名单 + 拼接/控制字符/裸 `$` 审批判定)、沙盒(just-bash 本地受限会话)、屏幕截图 + OCR(本地语言包)、剪贴板、web_fetch/web_search(SSRF 防护 + 大小/超时限制)
- Craft 模式多步循环(步数上限 20)+ 高危审批门控(60s 超时拒绝、串行队列、cancel 全拒、`PICOAI_TEST_AUTO_APPROVE` 测试钩子)+ 越界引导一键授权
- Plan 模式(先计划后执行);产物面板 + 中断恢复(消息即状态,截断到最后一条 user 消息重跑)
- Skill 运行时(SKILL.md 注入系统提示 + tar 安全校验 + 沙盒执行);MCP 插件运行时(stdio/http、命令白名单、崩溃自动重启 1 次、高危启发式审批、凭证仅内存每次启动重拉)
- 浏览器插件桥:客户端固定监听 127.0.0.1:54321,Chrome MV3 插件零配置直连(读取类直通,操作类审批)

### 产品化(阶段 4)
- 三平台打包(electron-builder:deb/AppImage/nsis/dmg,`picoaide://` 协议注册,asarUnpack)
- 管理页知识库(上传 txt/md/docx/pdf + 授权 + 搜索预览);全量文档 docs/01-08
- 性能:流式 rAF 合帧 + useDeferredValue、WAL 自动检查点、消息分页(最近 100 + 加载更早)
- E2E 冒烟:服务端 curl 全链路、客户端 xvfb 启动冒烟、浏览器插件 Playwright E2E

## v0.3.0 — local capabilities milestone
## v0.2.0 — client skeleton milestone
## v0.1.0 — server gateway milestone
