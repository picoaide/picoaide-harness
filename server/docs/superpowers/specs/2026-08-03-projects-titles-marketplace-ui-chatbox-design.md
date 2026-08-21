# 设计:PicoAide-Next 项目体系 + 自动标题 + 技能/MCP 入口 + ChatBox 增强

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

日期:2026-08-03
状态:已批准(经用户逐项确认)

## 1. 背景与问题

客户端(renderer)当前仅提供「新建会话 + 聊天」:

1. 会话标题永远显示"新会话",无自动生成。
2. Settings.tsx 已实现 MCP/Skill 建议清单 + 安装/卸载 + 可访问目录管理,但**没有任何入口**,用户看不到。
3. `conversations.workspace` 字段(绝对路径)存在但无 UI、无项目概念,引擎 cwd 全局固定,工具不落在项目目录。
4. ChatBox 为基础版(定高 textarea + 模式切换),缺少 Codex 式交互。

## 2. 目标

- 项目 = 命名工作目录 + 会话分组;引擎工具操作落在项目目录。
- 第一轮对话完成后由 LLM 自动生成会话标题(后台,不阻塞)。
- 设置页(Settings)接入入口,展示服务端下发的 MCP/Skill 建议清单。
- ChatBox 增强:/ 命令菜单、@ 提及(技能/会话/项目文件选择器)、自动增高、↑ 历史找回。
- **边界约束(用户明确要求)**:知识库/文档一律通过服务端远程 MCP 查询服务(`kb_search`/`kb_read`/`kb_list`),不做任何本地文档同步,客户端不缓存文档内容。

## 3. 数据模型(客户端 SQLite,迁移 0010)

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT ''
);
ALTER TABLE conversations ADD COLUMN project_id INTEGER;  -- 应用层维护,删除项目 → 置 NULL
```

- 项目内新会话:`workspace = <project.path>/<conv-id>/`(chat:new 时 mkdir,会话 id 唯一无冲突)。
- 无项目会话:workspace 保持空,引擎回退全局用户工作目录。
- 删除项目:仅解除会话关联(project_id → NULL,会话移入"未分类"),**不删任何文件**。

## 4. 主进程设计

### 4.1 store/projects.ts(新)

- `createProject(db, {name, path})` → id;path 唯一约束,重复抛错。
- `listProjects(db)` → `ProjectRow[]`(含 `conversation_count`)。
- `deleteProject(db, id)` → 会话 project_id 置 NULL。
- `setConversationProject(db, convId, projectId|null)` → 会话移项目。
- `getConversationWorkspace(convId)` → 会话 workspace;项目内会话 = `<project.path>/<conv-id>/`。

### 4.2 IPC 扩展(ipc.ts + preload)

- `project:list` → `ProjectRow[]`
- `project:create {name, path}` → id(**目录必须由用户手动选择**;默认值仅作对话框初始显示,不自动落库)
- `project:delete id`
- `conversation:moveProject {id, projectId|null}`
- `workspace:listFiles {path}` → 递归枚举可访问目录/项目目录下的文件(用于 @ 文件选择器,深度 ≤3 层,排除 node_modules/.git)
- `chat:new` 扩展 `{mode, projectId?}`:projectId 非空时创建 `<project.path>/<conv-id>/` 目录并写入 workspace

### 4.3 引擎工具注入项目目录

- `buildToolsRegistry(db, workspace?)`:workspace 非空时 cwd = workspace,allowedDirs = `resolveAllowedDirs(workspace, settings)`。
- `getTools` 签名扩展为 `getTools(workspace?)`;ipc.ts 三处调用点传 `conversation.workspace`。
- 无 workspace 会话行为不变(回退 `workspaceDir()`),现有测试不回归。

### 4.4 自动标题(agent/title.ts 新)

- 触发:chatAsk 引擎完成(done)后,若 `title==''` 且 ≥2 条消息 → **后台 fire-and-forget**(`void`,不 await、不阻塞 UI/对话)。
- 实现:`generateTitle(session, modelId, firstUserText)` → 调网关 `POST /v1/chat/completions`(gatewayFetch,默认模型,`max_tokens:40`,`temperature:0`,system「为以下用户消息生成 ≤20 字中文会话标题,只输出标题本身」),超时 15s。
- 失败兜底:截取首条用户消息前 20 字符;仍失败则静默放弃(标题留空,下次对话完成再试)。
- 写入 `setConversationTitle`;成功后 renderer 由 `loadConversations` 刷新。

## 5. renderer 设计

### 5.1 路由

App.tsx 加 `view: 'main' | 'settings'` state(Main 底部「设置」按钮切换;Settings 返回按钮回 Main)。不引入 react-router。Settings.tsx 现有 MCP/Skill 清单+安装代码零改造,只加返回入口。

### 5.2 Main.tsx 侧边栏重构

```
┌─────────────────────────────┐
│ [+ 新建会话]  [+ 新建项目]    │
├─────────────────────────────┤
│ ▸ 项目A(目录路径)            │
│    ▸ 会话1                   │
│    ▸ 会话2                   │
│ ▾ 项目B                     │
│    ▸ 会话3                   │
│ 未分类                       │
│    ▸ 会话4                   │
├─────────────────────────────┤
│ [设置]  [退出登录]            │
└─────────────────────────────┘
```

- 新建项目 Dialog:名称 Input + 工作目录 Input(只读,浏览按钮调 `dialog.showOpenDialog({properties:['openDirectory','createDirectory']})`);「创建」前必须已选目录。
- 项目行:点击折叠/展开,折叠状态存 settings 表(`project_collapsed` JSON),重启保留;hover 显示「删除」(ConfirmModal:确认后会话移未分类,不删文件)。
- 会话行 hover 菜单:「移动到项目…」→ 项目下拉选择(含未分类);workspace 不变(文件不搬,仅归属变化)。
- 新建会话按钮:若有 activeProject,在 activeProject 下建;否则建未分类会话。
- 底部「设置」按钮进入 Settings。

### 5.3 chat store 扩展

- state:`projects: ProjectRow[]`、`activeProjectId: number|null`、`collapsed: number[]`
- actions:`loadProjects`、`createProject`、`deleteProject`、`moveConversation`、`toggleProjectCollapsed`(持久化)
- `newConversation(projectId?)` 透传;对话完成后刷新 projects 的 conversation_count

### 5.4 ChatInput 增强

1. **/ 命令菜单**:输入 `/` 或 `/技能名` 时弹出 bootstrap skills 建议清单过滤列表;选择后填入 `使用技能 <name>:`(技能名在对话中由引擎 sysPrompt 注入指令,若未安装引擎会提示)。
2. **@ 提及**:输入 `@` 弹出三类来源选择器(分区块):
   - 已装技能(listInstalledSkills 经 IPC 暴露)
   - 项目 workspace 文件 / 可访问目录文件(`workspace:listFiles`)
   - 最近会话标题
   选择后插入 `@名称` 文本(提及语义当前由 LLM 理解,不做引用注入协议)。
3. **自动增高**:textarea 2→8 行自适应(原生 `onInput` 调 height,不引库)。
4. **↑ 历史找回**:按 ↑(空输入时)遍历本会话已发送消息(store 内 `sentHistory` 数组),重新填入编辑。

## 6. 测试计划(TDD 红-绿-commit)

| 模块 | 用例 |
|---|---|
| `store/projects.test.ts` | create/list/delete、重复 path 报错、删除置 NULL、workspace 解析 |
| `agent/title.test.ts` | mock 网关成功生成、失败截取兜底、空标题不触发、≤20 字 |
| `ipc.test.ts` 扩展 | chat:new 带 projectId → workspace 落库+目录创建;moveProject |
| `tools/paths.test.ts` 扩展 | resolveAllowedDirs 含 workspace |
| renderer `chat.test.ts` 扩展 | 项目分组、新建项目、折叠持久化 |

完成后跑 `make test-client` 全量回归(引擎 cwd 改动需确认现有 engine/ipc 测试不回归)。

## 7. 明确不做(后续项)

- 拖放文件上传到输入框
- @ 会话提及独立协议(仅文本插入)
- 项目重命名/归档/导出
- 本地文档同步(永久边界:文档查询一律走服务端 MCP)

## 8. 文档同步修订

- AGENTS.md §7:客户端 4 表 → 5 表;新增 IPC 契约;bootstrap 不变。
- 实施计划:追加本设计对应任务条目(编号延续现有 4.x 之后,或按执行顺序插入并在修订说明中标注)。
