# Changelog

## v2.5.2 (2026-08-31)

### 新增
- **按模型并发峰值统计**:网关内存 in-flight 计数(全部协议:chat/embeddings/FIM/messages/responses)+ 每 15s 采样落库(`model_concurrency_stats`,GREATEST 累计永不回退),服务器信息页「模型并发」卡片展示当前/90 天峰值/目标/峰值利用率(≥100% 标红)——扩容申请量化依据;目标在模型 `default_params.concurrency_target` 配置(如 flash 2500 / pro 500)
- **管理后台版本更新提示**:服务器信息页顶部横幅(服务端代理 GitHub Releases latest,严格 SemVer 比较,8s 超时,6h 缓存+并发合并,失败静默降级),附发行说明链接与 `./deploy.sh update` 指引;修复 server-info 版本号恒为 dev 的存量 bug(SetBuildVersion 与 --version 同源注入)
- **内置 PostgreSQL 升级到 18**(最新稳定大版本):compose/deploy.sh/.env.example/CI/文档全同步;18.6 全量测试+冒烟验证通过

### 部署
- 服务端镜像 `ghcr.io/picoaide/picoaide-harness-server` 随 tag 自动构建(v2.5.2/latest),内置 PG18

## v2.5.1 (2026-08-31)

### 修复
- 端可见更新体验:各平台(mac/win/linux)更新提示、进度与设置入口
- 连接器中心改用 `/api/client/v2/config/bootstrap`(命名空间迁移后旧路径 404,目录同步静默失败)
- `TestCleanupUsageRetention` 月末日期归一化(Normalize 到每月 1 号,消除月末 flake)

## v2.5.0 (2026-08-31)

### 修复
- 连接器中心改用 `/api/client/v2/config/bootstrap`(命名空间迁移后旧路径 404,目录同步静默失败)
- `TestCleanupUsageRetention` 月末日期归一化(Normalize 到每月 1 号,消除月末 flake)

### 测试验证
- 真实 DeepSeek API 全链路(登录→聊天→计费→配额)通过
- LDAP + Dex OIDC + 多角色共享技能审批闭环通过
- 全部 Go/TS 门禁通过

## Unreleased

### 部署
- `install-server.sh` 升级为 oh-my-zsh 式一键安装器:自动提权、按发行版(apt/dnf/yum/apk/zypper)自动安装缺失依赖(docker/compose/curl/jq/openssl/dns 工具,支持 `DOCKER_MIRROR` 镜像源)、tty 交互或环境变量配置、复用 `deploy.sh install` 完成部署
- 部署支持 PostgreSQL 后端(`DB_MODE=sqlite|pg|pg-external`):新增 `docker-compose.pg.yml`(内置 postgres 容器,固定 IP .4 + `./pg-data`)与 `docker-compose.pg-ext.yml`(外部实例),`deploy.sh` 全部子命令按 `.env` 的 `DB_MODE` 自动叠加 override
- 新增 `deploy.sh migrate [--dry-run]`:SQLite→PostgreSQL 数据迁移(复用 `cmd/migrate-sqlite-pg`,守护流程:预览→停服→清空目标表→迁移→切换 .env→重启);备份(backup)在 pg 模式产出 `pg_dump`,卸载 --volumes 含 `pg-data/`
- Docker 镜像同时打包 `migrate-sqlite-pg`;`migrate-sqlite-pg` 目标库为空时自动应用 `migrations-pg` schema(EnsureMigrated,幂等)

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
