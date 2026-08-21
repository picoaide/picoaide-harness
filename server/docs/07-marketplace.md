# 商城(Skill / MCP 插件)

> 商城是**建议安装制,不是授权制**:管理员上架/配置,客户端展示建议清单(bootstrap),员工自装。无 grants 授权表;凭证可被任意登录员工拉取,靠限流 + 审计兜底(企业内可信环境)。

## 1. 数据流

```
管理员(webadmin /api/admin/skills|mcp)  →  上架 + 配置(凭证加密落库)
员工客户端登录 → GET /api/config/bootstrap → skills[] + mcp[] 建议清单
员工安装 Skill → GET /api/marketplace/skills/:name/archive 下载技能包
员工安装 MCP   → GET /api/marketplace/mcp/:id/config 拉配置(限流 30/h + 审计)
客户端运行时    → Skill:指令注入 sysPrompt;MCP:本地运行时注册工具
```

## 2. 端点

- 员工(Bearer):`GET /api/marketplace/skills`、`GET /api/marketplace/skills/:name`、`GET /api/marketplace/skills/:name/archive`、`GET /api/marketplace/mcp`、`GET /api/marketplace/mcp/:id/config`。
- 管理端(Admin):`/api/admin/skills`(CRUD,下架置 enabled=0)、`/api/admin/mcp`(CRUD)、`GET /api/admin/mcp-downloads`(审计)。

完整请求/响应见 03-api-reference.md §6-7。

## 3. 凭证加密

- 服务端持有 master key:`PICOAI_MASTER_KEY` 环境变量,或首次启动生成写入 `data/`(0700)。
- 密文格式 `enc:v1:` + base64(nonce + ciphertext),AES-GCM(util/crypto.go)。
- 加密对象:网关上游 `api_key_enc`、MCP 插件 `env` 中敏感值。客户端拉取配置时服务端解密下发,客户端**内存持有、不落盘**(重启重拉)。

## 4. 限流 + 审计

- `GET /api/marketplace/mcp/:id/config`:per-user 计数窗口,**30 次/小时**(商城包 NewAPI 默认);超限 429。
- 每次拉取写 `mcp_config_downloads`(user_id, mcp_id, created_at),管理员在 webadmin 可查,防批量导出追责。

## 5. 技能包格式(skill_pack.go)

- 管理端上架时填 `git_url` + `git_ref`;服务端 clone 到 `data/skills-cache/`,校验仓库内元数据后构建归档 `cacheDir/<name>-<version>.tar.gz`(缓存命中直接返回)。
- 仓库内元数据(YAML):`name` / `version` / `author` / `description`;归档 version 必须与元数据一致,否则构建失败。
- 技能内容:Markdown 指令文件等(无独立执行环境);客户端安装后解析为指令注入系统提示词(`## Skills` 段),为 Agent 提供领域知识/流程/工具使用说明。

## 6. MCP 插件运行时(desktop/src/main/mcp/)

### 连接(runner.ts)
- `transport: 'stdio' | 'http'`。
- stdio:`command` + `args` 校验——命令白名单(`validateStdioCommand`),参数含 shell 元字符直接拒绝(`validateArgs`);失败即安装不可用。
- http:`url` 必须合法 URL,走 Streamable HTTP 传输。
- 生命周期:连接失败/崩溃自动**重启 1 次**(`MAX_RESTARTS = 1`),再失败标记 disabled,不再拉起;`restartCount()` 可查。
- 每次会话启动时连接、`listTools` 注册工具,工具名 `<plugin>_<tool>`(非法字符替换为 `_`)。

### 高危启发式(adapter.ts `isHighRiskTool`)
- 工具**名称**含高危动词(contains 匹配,兼容 `delete_record` 这类下划线名)→ 高危;名称未命中时,查**描述**词边界命中。
- 高危动词集合覆盖:删除/移除/执行/上传/清空/重置等语义(delete/remove/exec/upload/clear/reset 等)。
- 命中 → 该工具进引擎审批门控(60s 确认);未命中 → 直通。
- JSON Schema → zod 轻量转换(支持 string/number/integer/boolean/array/object/null/enum + required,其余回退 unknown)。

### 凭证
- 安装记录 `installedMcpList` 存本地(名称/插件 ID 等,不含凭证);`env` 凭证仅内存,启动重拉。

## 7. Skill 安装(desktop/src/main/skill/)

- 下载归档 → 校验 → 安装到本地技能目录;`listInstalledSkills` 输出指令块,`loadInstalledSkillInstruction` 拼入引擎系统提示词。
- 设置页可管理建议安装(安装/卸载/刷新清单)。

## 8. 安全边界

- 凭证不落盘(仅内存/启动重拉)——客户端主进程强制,见 AGENTS.md §3.6。
- stdio 命令白名单 + 参数元字符拒绝,防止插件配置注入 shell。
- 高危启发式 + 引擎审批门控双层兜底,不依赖任何 SDK 的审批 API。
- 拉取限流 30/h + 下载审计,缓解"任意登录员工拉全部凭证"风险。
