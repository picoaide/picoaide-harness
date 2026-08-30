# 商城(技能 Skill)

> 技能商城为**建议安装制 + 授权制**:管理员上架并授权,客户端展示授权后的建议清单(bootstrap),员工安装。

## 1. 数据流

```
管理员(webadmin /api/server/admin/skills)  →  上架 + 授权(skill_grants)
员工客户端登录 → GET /api/client/v2/config/bootstrap → skills[] 建议清单(授权可见)
员工安装 Skill → GET /api/client/v2/marketplace/skills/:name/archive 下载技能包
客户端运行时    → Skill:指令注入 sysPrompt
```

## 2. 端点

- 员工(Bearer):`GET /api/client/v2/marketplace/skills`、`GET /api/client/v2/marketplace/skills/:name`、`GET /api/client/v2/marketplace/skills/:name/archive`。
- 管理端(Admin):`/api/server/admin/skills`(CRUD,下架置 enabled=0)、`/api/server/admin/skills/:name/grants`(授权)。
- 统一聚合(Bearer):`GET /api/client/v2/capabilities?source=market`(与共享技能/Agent 合并返回)。

完整请求/响应见 03-api-reference.md §6-7。

## 3. 技能包格式(skill_pack.go)

- **上传模式(推荐,0040)**:管理端「上传新版」提交 `.tar.gz`,归档直接存 `skills.archive`(DB 行),`source='upload'`;下载不再走磁盘 clone/打包。
- **Git 模式(兼容)**:上架时填 `git_url` + `git_ref`;服务端 clone 到 `data/skills-cache/`,校验仓库内元数据后构建归档 `cacheDir/<name>-<version>.tar.gz`(缓存命中直接返回)。
- 仓库内元数据(YAML):`name` / `version` / `author` / `description`;归档 version 必须与元数据一致,否则构建失败。
- 技能内容:Markdown 指令文件等(无独立执行环境);客户端安装后解析为指令注入系统提示词(`## Skills` 段),为 Agent 提供领域知识/流程/工具使用说明。
- **下载/调用统计(0040)**:`GET /archive` 成功即 `downloads+1`;客户端 `POST /api/client/v2/telemetry/skill-call` 上报技能调用(模型 `skill` 工具成功 / 用户 `/name` 手势注入),服务端按 shared_skills(name+version)或 market(name)累加 `calls`。

## 4. Skill 安装(桌面客户端侧)

- 客户端下载归档 → 校验 → 安装到本地技能目录;安装后作为指令注入系统提示词。
- 能力中心「我的 / 市场」分区管理建议安装(安装/卸载/刷新/更新),见仓库根 `docs/user-guide.md` 与 `packages/host/enterprise`。

## 8. 安全边界

- 服务端:归档校验(≤16MB/解包 ≤64MB/条目 ≤10000、拒绝越界/symlink、必须含顶层 `SKILL.md`/`agent.cordis.yml`)、授权制可见性(未授权 404)、下载/调用计数(0040)、上传与安装双侧 `assertArchiveSafe`。
- 网关上游密钥 AES-GCM 加密存储,客户端只持登录 token。
- 员工面端点 Bearer 鉴权;管理面 RBAC(0046)+ 审计哈希链(0048)。
