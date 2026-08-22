# PicoAide-Next

企业内网桌面 AI 办公智能体:员工安装 Electron 客户端,登录企业内网 Go 服务端后**零配置**直接使用。AI Agent 在客户端本地运行,可操作本机文件/终端/浏览器(经本地 CDP 插件桥)/屏幕;LLM 调用统一经服务端网关(密钥不出服务端、按用户计量)。

## 功能

- **本地 Agent 引擎**:AI SDK v7 streamText 多步循环,Ask / Plan / Craft 三模式
- **本地工具**:文件读写(编码自动检测/.docx)/ 终端命令 / 受限沙盒 / 屏幕截图+OCR / 剪贴板 / 网页抓取与搜索
- **浏览器操作**:Chrome/Edge 插件直连本地 `127.0.0.1:54321`,零配置
- **高危操作人确认**:删除/截屏/剪贴板读/命令/浏览器操作等引擎层审批门控(60s 超时拒绝)
- **企业能力**:LDAP/OIDC 登录、AI 网关代理与用量计量、技能商城(建议安装制)
- **密钥不出服务端**:LLM 上游密钥 AES-GCM 加密只存服务端,客户端只持登录 token
- **消息即状态**:任务中断可随时从最后一条消息恢复,会话/历史本地 SQLite

## 快速开始

### 0. 服务端一键安装(Ubuntu,推荐)

一条命令自动完成:检查并安装依赖(docker/compose/curl/jq,缺失自动装)、生成自签名证书、配置 Caddy HTTPS、生成 docker-compose.yml、启动服务。

```bash
curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-next/master/scripts/install-server.sh | sudo bash
```

运行时会交互询问**域名**;也可非交互指定:

```bash
# 指定域名 + 自定义管理员密码
curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-next/master/scripts/install-server.sh | sudo DOMAIN=picoaide.example.com ADMIN_PASS=your-strong-password bash
```

脚本会展示:管理后台/员工登录地址、管理员账号与**随机生成的密码**(记住它)、数据目录、证书类型与**替换证书的路径/方法**。

- 证书为**自签名**(Caddy 生成);替换正式证书:编辑 `<部署目录>/Caddyfile`,删除 `tls internal` 行(自动申请 Let's Encrypt)或改用 `tls /path/your-cert.pem /path/your-key.pem`,然后 `docker compose restart caddy`。
- 部署目录默认 `/data/picoaide-next`(可用 `INSTALL_DIR` 覆盖)。
- 目录已存在且有文件时,脚本会提示是否重新安装(停止容器、检查 80/443 端口、清空目录)。

### 1. 服务端(Go 1.24+)

```bash
make build-server
PICOAI_ADMIN_PASSWORD=admin123 bin/picoaide-server -addr :8080 -data ./data --bootstrap-admin admin
```

- `--bootstrap-admin` + `PICOAI_ADMIN_PASSWORD` 首次创建超管;`PICOAI_MASTER_KEY` 可显式指定加密主密钥(不设则自动生成于 data 目录,请备份)。
- 管理页:`http://localhost:8080/admin/`(用户/网关/用量/商城)。
- 无外网环境可 `bash scripts/mock-upstream.go` 起假上游联调网关。

### 2. 客户端(Electron)

```bash
cd desktop
npm ci && npm run dev        # 开发运行
npm run build                # 产物 desktop/out/
make pkg-linux               # 安装包(三平台见 Makefile)
```

安装后输入服务端地址(HTTPS)与账号登录即用。浏览器操作能力需加载 `browser-extension/` 插件(开发者模式或组策略)。

### 3. 快速验收

```bash
# 登录取 token → 拉 bootstrap → 调网关
TOKEN=$(curl -s -XPOST localhost:8080/api/auth/login -d '{"username":"admin","password":"admin123"}' | ...)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/config/bootstrap
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/models
```

## 文档

| 文档 | 内容 |
|------|------|
| [docs/01-architecture.md](docs/01-architecture.md) | 系统架构/进程模型/数据流/事件协议/安全设计 |
| [docs/02-build-deploy.md](docs/02-build-deploy.md) | 构建/部署/安装/CI |
| [docs/03-api-reference.md](docs/03-api-reference.md) | 全部 HTTP 端点/IPC/CDP 协议 |
| [docs/04-auth.md](docs/04-auth.md) | 认证体系(local/LDAP/OIDC/token/管理端 CSRF) |
| [docs/05-agent-system.md](docs/05-agent-system.md) | Agent 引擎/工具注册表/审批门控/沙盒 |
| [docs/06-database.md](docs/06-database.md) | 服务端 17 表 + 客户端 4 表 |
| [docs/07-marketplace.md](docs/07-marketplace.md) | 技能商城/授权/插件运行时 |
| [docs/08-development.md](docs/08-development.md) | 开发指南/TDD/契约 |

## 截图

> 截图占位:桌面客户端主界面(对话 + 工具状态 + 审批弹窗)、服务端管理页(网关配置/用量)。

## License

内部项目。
