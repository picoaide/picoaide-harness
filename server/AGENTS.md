# AGENTS.md — PicoAide-Next

> 本文件是给 AI 编码代理的项目级指令。先读它,再读 `docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md`(架构设计)与 `docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md`(实施计划,任务级 TDD 步骤)。代码与文档冲突时以本文 + 设计文档为准,并同步修订计划。
>
> **2026-08-19 变更**:自研 Electron 客户端(desktop/)与浏览器插件(browser-extension/)已下线删除。仓库只保留**服务端接口 + webadmin 管理端**;员工/第三方客户端经保留的 HTTP 接口(`/api/auth/*`、`/v1/*`、`/api/config/bootstrap`)接入。

## 1. 项目是什么(一句话)

**企业内网 AI 办公智能体的服务端与管理系统**:Go 服务端提供认证、LLM 网关(密钥不出服务端、按用户计量计费)、技能商城与全部管理接口;webadmin 管理端(shadcn SPA,内嵌进服务端二进制)负责用户/网关/用量/商城/部门预算等全部配置。

## 2. 第一性原理(设计为什么是这样,改设计前先过一遍)

1. **服务端是唯一控制面**——密钥只存服务端(AES-GCM + master key 文件);所有功能配置(模型/上游密钥/技能/凭证/配额/价格)由管理员在 webadmin 完成;登录后 `GET /api/config/bootstrap` 统一下发(默认模型+建议清单)。
2. **严格默认拒绝**——商城资源上架后**未授权用户一律不可见不可用**(404 不泄露存在性);授权对象 = 用户或部门组(@组名约定,组名大小写不敏感);admin 恒全量不落表;授权变更必审计(audit_logs);改密/降权/禁用自动吊销全部 API token。
3. **部门(组)即金字塔组织架构**(迁移 0017)——`groups` 含 parent_id/leader_id:部门树任意层级、部门主管、员工**单部门归属**(`PUT /api/admin/users/:id/department`);权限继承:`UserEffectiveGroups` = 归属部门+祖先链(授权给部门覆盖子部门成员)+ 主管部门子树(主管向上继承)+ 隐式「全员」组(全员为保留名,禁建/删/改名);部门改名级联授权表(NOCASE)、删除须无成员/子部门/授权引用;LDAP 登录全量同步组(空组即回收)。
4. **计量即金钱**——usage 表记录每次 LLM 调用的 token 与费用(`cost`,记录时按模型定价与峰谷窗口折算,0022/0023);配额体系三层:员工 token 配额、员工金额配额、部门预算(0024,归属链全部生效);任一超限网关 429 `QUOTA_EXCEEDED`(admin 豁免)。价格/峰谷窗口管理员可配置,改价只影响之后产生的费用。
5. **无状态优先**——服务端接口保持无状态(Bearer token / 管理端 session);历史遗留的客户端引擎概念(审批门控/CDP/本地沙盒)随客户端下线,不再演进。

## 3. 不可违背的工程原则

1. **UI 组件一律使用 shadcn/ui,禁止自写 UI 组件**:webadmin 全部来自 `components/ui/`(不足时 `npx shadcn@latest add <name>` 拉取)。业务组件只做**组合与状态编排**。
2. **函数尽量复用,禁止复制粘贴**:新增代码前先搜仓库是否已有等价函数;同一逻辑只实现一次,重复 2 次即提取共享模块(serverstore DAO、util 包、公共中间件)。
3. **TDD 红-绿-commit**:每个任务先写测试(红)→ 实现(绿)→ commit;每个非平凡逻辑模块必须有可运行测试(Go `_test.go` / TS `*.test.ts`)。
4. **每任务结束必须 commit**,提交信息 `feat:|fix:|test:|docs:|chore:` 单行 ≤72 字符。
5. **安全边界不得绕过**:凭证 AES-GCM 加密、API token 只存哈希、TOFU 证书校验(客户端接入方)、限流/审计——一律不许为省事而移除。
6. **管理端 HTTP 走 `/api/admin/*`(session + CSRF)**:错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`。

## 4. 架构总览

```
第三方客户端 / 员工接入 ──HTTPS/Bearer token──▶ Go 服务端
  ├─ 认证:local/LDAP/OIDC + api_tokens(90天过期)+ /api/auth/me|usage
  ├─ AI 网关:/v1/chat/completions|embeddings|models + per-user 限流 + usage 计量(费用/峰谷)
  ├─ bootstrap:/api/config/bootstrap(默认模型+建议清单)
  ├─ 商城:/api/marketplace/*(skills 建议清单 + 授权制)
  ├─ 审计:/api/admin/audit(用户/部门/技能等敏感操作留痕)
  └─ 管理端 webadmin(go:embed 内嵌,/admin/):用户/网关/用量/商城/部门 —— 全部配置入口
```

## 5. 技术栈

- **服务端**:Go 1.24+、gin、modernc.org/sqlite(含 FTS5)、argon2id、AES-GCM、go-ldap/v3、coreos/go-oidc/v3、go-git
- **webadmin**:Vite + React + shadcn/ui + react-router-dom(VChart 图表)

## 6. 目录结构

```
cmd/server/            # 服务端入口(--bootstrap-admin 等)
internal/              # serverauth/llmgateway/marketplace/serverstore/util/bootstrap
webadmin/              # 管理端(Vite React + shadcn,dist 内嵌进服务端二进制)
docs/superpowers/      # 架构设计 + 实施计划(权威文档)
scripts/               # install-server.sh(生产一键部署)+ mock-upstream.go(假上游)
data/                  # 服务端运行时数据(0700,gitignore)
```

## 7. 关键契约(两端必须一致)

- **REST 错误**:`{"error":{"code":"ERR_CODE","message":"..."}}`;`AUTH_REQUIRED`/`AUTH_FAILED`/`FORBIDDEN`(管理端)/`NOT_FOUND`/`VALIDATION`/`UPSTREAM`/`RATE_LIMITED`/`INTERNAL`(健康探针与 404 NoRoute 同信封)
- **bootstrap**:`{default_model, models, skills, web}`(接入方对 skills/web 缺省值兜底)
- **员工用量接口**:`GET /api/auth/usage` → `{quota_tokens, quota_money, remaining_tokens/money(不限=null), today/yesterday/monthly/total usage+cost, dept_budgets[]}`(余额与统计展示数据源)
- **DB**:服务端 20+ 表(迁移 0001-0027,0007 废弃;0016 skill_grants、0017 departments、0018 全员 seed、0019 groups NOCASE 唯一、0020 usage.kind、0021 users.quota_tokens、0022 金额配额 users.quota_money + models 价格列 + usage.cost、0023 models.offpeak_discount 峰谷折扣 + settings usage.peak_windows(北京高峰窗口)、0024 groups.budget_money 部门预算、0028 知识库/MCP 下线清理 + audit_logs 独立)
- **审计契约**:`GET /api/admin/audit?page=&size=&action=&username=`(用户/部门/技能/令牌等敏感操作留痕,90 天保留)
- **费用/配额口径**:cost 记录时按 输入×input_price/1e6 + 输出×output_price/1e6,高峰窗口(settings `usage.peak_windows`,北京时间)外 × `offpeak_discount`;配额链 = 员工 token → 员工金额 → 部门预算(归属+祖先,树内 SUM(cost));剩余 = 配额 − 本月已用(不限=null)

## 8. 常用命令

```bash
make test              # go test ./... -count=1(服务端全量)
make test-server       # 服务端各域测试
make webadmin          # cd webadmin && npm run build(产物内嵌进服务端二进制)
make build-server      # make webadmin + go build -o bin/picoaide-server
make docker-image      # 服务端 Docker 镜像
make check             # gofmt + go vet + test-server + webadmin 测试与构建
PICOAI_ADMIN_PASSWORD=x bin/picoaide-server -addr :8080 -data ./data --bootstrap-admin admin
bash scripts/mock-upstream.go 起假上游  # 无外网/无 key 环境验证网关
bash scripts/install-server.sh         # 生产一键部署(oh-my-zsh 式单命令,自动装依赖;域名/账号/密码,见 docs/02-build-deploy.md)
# 数据库后端: -db-driver sqlite|pg -pg-dsn <DSN>(pg 迁移 DDL 见 internal/serverstore/migrations-pg/);
#   sqlite→pg 数据迁移: ./deploy.sh migrate(容器化)或 go run ./cmd/migrate-sqlite-pg ...
```

## 9. 文档与实施

- 架构设计:docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md(ADR、安全设计、错误边界)
- 实施计划:docs/superpowers/plans/2026-08-01-picoaide-next-full-implementation.md(阶段 1 服务端网关仍有效;阶段 2/3 客户端相关已下线)
- 部署:docs/02-build-deploy.md(服务端构建、systemd 裸二进制 + Caddy、install-server.sh)
