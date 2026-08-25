# 商城(技能 Skill)

> 技能商城为**建议安装制 + 授权制**:管理员上架并授权,客户端展示授权后的建议清单(bootstrap),员工安装。

## 1. 数据流

```
管理员(webadmin /api/admin/skills)  →  上架 + 授权(skill_grants)
员工客户端登录 → GET /api/config/bootstrap → skills[] 建议清单(授权可见)
员工安装 Skill → GET /api/marketplace/skills/:name/archive 下载技能包
客户端运行时    → Skill:指令注入 sysPrompt
```

## 2. 端点

- 员工(Bearer):`GET /api/marketplace/skills`、`GET /api/marketplace/skills/:name`、`GET /api/marketplace/skills/:name/archive`。
- 管理端(Admin):`/api/admin/skills`(CRUD,下架置 enabled=0)、`/api/admin/skills/:name/grants`(授权)。
- 统一聚合(Bearer):`GET /api/capabilities?source=market`(与共享技能/Agent 合并返回)。

完整请求/响应见 03-api-reference.md §6-7。

## 3. 技能包格式(skill_pack.go)

- 管理端上架时填 `git_url` + `git_ref`;服务端 clone 到 `data/skills-cache/`,校验仓库内元数据后构建归档 `cacheDir/<name>-<version>.tar.gz`(缓存命中直接返回)。
- 仓库内元数据(YAML):`name` / `version` / `author` / `description`;归档 version 必须与元数据一致,否则构建失败。
- 技能内容:Markdown 指令文件等(无独立执行环境);客户端安装后解析为指令注入系统提示词(`## Skills` 段),为 Agent 提供领域知识/流程/工具使用说明。

## 4. Skill 安装(desktop/src/main/skill/)

- 下载归档 → 校验 → 安装到本地技能目录;`listInstalledSkills` 输出指令块,`loadInstalledSkillInstruction` 拼入引擎系统提示词。
- 设置页可管理建议安装(安装/卸载/刷新清单)。

## 8. 安全边界

- 凭证不落盘(仅内存/启动重拉)——客户端主进程强制,见 AGENTS.md §3.6。
- stdio 命令白名单 + 参数元字符拒绝,防止插件配置注入 shell。
- 高危启发式 + 引擎审批门控双层兜底,不依赖任何 SDK 的审批 API。
- 拉取限流 30/h + 下载审计,缓解"任意登录员工拉全部凭证"风险。
