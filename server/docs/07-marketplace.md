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
- 管理端(Admin):`/api/server/admin/skills`(CRUD,下架置 enabled=0)、`/api/server/admin/skills/:name/grants`(授权);管理后台入口为「能力中心 → 市场技能」Tab(2026-09-02 起与组织共享合并为单入口,旧 `/marketplace` 重定向)。
- 统一聚合(Bearer):`GET /api/client/v2/capabilities?source=market`(与共享技能/Agent 合并返回)。

完整请求/响应见 03-api-reference.md §6-7。

## 3. 技能包格式(skill_pack.go)

- **上传模式(推荐,0040)**:管理端「上传新版」提交 `.zip`,归档直接存 `skills.archive`(DB 行),`source='upload'`;下载不再走磁盘 clone/打包。
- **归档上传(唯一入口,0052)**:上架时上传 zip,服务端严格校验包内 SKILL.md 后直存 DB(git 源模式已移除)。
- 仓库内元数据(YAML):`name` / `version` / `author` / `description`;归档 version 必须与元数据一致,否则构建失败。
- 技能内容:Markdown 指令文件等(无独立执行环境);客户端安装后解析为指令注入系统提示词(`## Skills` 段),为 Agent 提供领域知识/流程/工具使用说明。
- **格式兼容**:服务端校验/预览/下载按魔数嗅探——zip 为新格式(推荐),gzipped tar(旧归档/旧库行)仍可上传、审核与安装;下载响应头(Content-Type/文件名)跟随实际格式。
- **下载/调用统计(0040)**:`GET /archive` 成功即 `downloads+1`;客户端 `POST /api/client/v2/telemetry/skill-call` 上报技能调用(模型 `skill` 工具成功 / 用户 `/name` 手势注入),服务端按 shared_skills(name+version)或 market(name)累加 `calls`。

## 4. Skill 安装(桌面客户端侧)

- 客户端下载归档 → 校验 → 安装到本地技能目录;安装后作为指令注入系统提示词。
- 能力中心「我的 / 市场」分区管理建议安装(安装/卸载/刷新/更新),见仓库根 `docs/user-guide.md` 与 `packages/host/enterprise`。

## 5. 归属(owner)与同名互斥(2026-09 统一模型)

市场与组织技能共用统一 App 模型(`apps`/`app_releases`,迁移 0053):一个 `(kind, app_id)` 只属于一个渠道,技能与智能体以 kind 区分允许同名。**归属权**(2026-09-02 补强)约束「谁能发布」:

| 场景 | 结果 |
|---|---|
| 员工发布他人归属的 App(任意状态,含空 owner 的历史行) | 409 NAME_TAKEN「名称已被占用,无法上传:请更换名称或联系管理员」(明确告知占用关系,不泄露是谁/什么内容) |
| 员工发布被锁定名(预锁定可占名) | 403 APP_LOCKED + 原样回显理由 |
| 员工发布同名另一渠道(市场↔组织) | 409 NAME_TAKEN |
| 管理员发布任意名字 | 通过(跳过锁定与归属检查,发布即 approved) |
| 任何人、重复版本/降版本/内容未变 | 409 VERSION_EXISTS / VERSION_NOT_INCREASING / CONTENT_UNCHANGED |

- **归属人 = `apps.owner`**:首个成功占名的发布者(登录态,不可伪造);**pending 即占名**,被拒/软删后仍占位(与「版本号一经使用永久占位」同一防抢占精神);`UpsertApp` 保证 owner 一经写入不被任何后续发布改写。
- **归属只约束「谁能续传新版本」**,与授权(谁能看/装)、锁定、渠道、质量、上下架**正交**。
- **归属转移(管理员指定)**:`PUT /api/server/admin/apps/:kind/:app_id/owner` body `{owner}`(须为存在用户;同归属幂等成功不写审计);转移后旧归属者发布 404、新归属者获得续传权(版本仍须递增);审计动作 `app_owner_transfer`(明细含新旧值)。webadmin 能力中心审批页「归属」列 + 转移弹窗。
- 客户端能力中心上传前本地预检(`is_owner` 字段):同名且非本人 → 直接提示「名称已被占用」;服务端 409 NAME_TAKEN 仍是权威(他人待审行不可见时兜底)。



- 服务端:归档校验(≤16MB/解包 ≤64MB/条目 ≤10000、拒绝越界/symlink、必须含顶层 `SKILL.md`/`agent.cordis.yml`)、授权制可见性(未授权 404)、下载/调用计数(0040)、上传与安装双侧 `assertArchiveSafe`。
- 网关上游密钥 AES-GCM 加密存储,客户端只持登录 token。
- 员工面端点 Bearer 鉴权;管理面 RBAC(0046)+ 审计哈希链(0048)。
