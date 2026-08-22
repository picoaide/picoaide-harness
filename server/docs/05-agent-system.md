# 客户端 Agent 引擎

> 代码位置:`desktop/src/main/agent/`(engine.ts / modes.ts / continue.ts / events.ts / artifacts.ts / provider.ts)+ `desktop/src/main/tools/`。引擎是"消息即状态"的轻量实现,不做 durable 状态机。

## 1. 技术栈

- AI SDK v7(`ai@^7.0.48`)+ `@ai-sdk/openai-compatible`(经服务端网关)。
- `streamText` 多步循环;步数上限用 `stopWhen: isStepCount(n)` 控制。
- 工具执行不设 SDK 层 timeout(避免掐断审批窗口),审批窗口由引擎自管(60s)。
- 本地沙盒:`@ai-sdk/sandbox-just-bash`(v1.0.54),本地受限会话执行脚本。

## 2. 运行流程

```
用户输入(ask/craft) 或 计划确认(plan)
   → 引擎构建消息历史(截断到最后一条 user 消息 = 恢复点)
   → streamText({ model, tools, stopWhen })
   → fullStream 竞速消费:
       textDelta / reasoning → text_delta / reasoning_delta 事件
       tool-call → 包装工具执行(过审批门控)→ tool_start/tool_end/tool_error
       finish → done(含 usage)
   → 消息/产物落库(会话内可随时继续)
```

- **取消**:`cancel()` 置 canceling 标记 + 竞速消费 fullStream,挂起流也会立即返回 canceled(不依赖 SDK abort 生效时机)。
- **继续**:`chat:continue` 从最后一条 user 消息重放,截断重放(见 §6)。

## 3. 三种模式(modes.ts)

| 模式 | maxSteps | 工具 |
|------|----------|------|
| `ask` | 1 | 无(纯问答) |
| `plan` | 首轮 1 | 首轮无工具 → 输出计划 → `approvePlan(ok)` → 第二轮带工具执行 |
| `craft` | 多步 | 全量工具 + 高危标记,循环至不再调用工具或达上限 |

## 4. 工具注册表(代码现状,index.ts `buildToolsRegistry`)

| 工具 | 说明 | 审批 |
|------|------|------|
| `file_read` | 读取文本,自动编码检测(UTF-8/UTF-16 BOM/GBK),.docx 抽取纯文本 | - |
| `file_write` / `file_edit` / `file_append` | 写/替换/追加(父目录自动创建) | - |
| `file_delete` | 删除文件 | **高危** |
| `file_list` / `file_search` | 列目录(可递归)/按子串搜索(≤200 条) | - |
| `command_exec` | 本地 shell 执行(默认超时 60s,输出截断 50KB,展示串=执行串) | `needsApprovalFor` 判定,白名单免审批 |
| `sandbox_exec` | 本地沙盒执行脚本(`@ai-sdk/sandbox-just-bash`;**无 python3**,仅 bash;输出截断 50KB) | - |
| `screen_capture` | 屏幕截图(OCR 依赖 tessdata 本地打包,惰性加载) | **高危** |
| `clipboard_read` / `clipboard_write` | 剪贴板读写 | 读 **高危** |
| `web_fetch` | 抓网页转纯文本(拒绝内网地址,`web.allow_private` 可放开) | - |
| `web_search` | 搜索(管理员配置的 `web.search_endpoint`) | - |
| `browser_tab_info` / `browser_get_content` | 浏览器读取(当前页 URL/标题/文本,直通) | - |
| `browser_click` / `browser_type` / `browser_navigate` / `browser_scroll` / `browser_execute_js` | 浏览器操作(经 CDP 桥) | **高危** |
| `allow_dir` | 越界访问时的目录授权(引擎内置,非模型可调) | 引擎直接触发 |

## 5. 审批门控(engine.ts)

- `GatedTool = Tool & { requiresApproval? }`;`highRiskTools: Set<string>` 显式标记 + 工具自带判定。
- 请求排队串行:任一时刻最多一个 `confirm_required` 等回执;`confirm(requestId, ok)` 回执或 60s 超时自动拒绝(`DEFAULT_APPROVAL_TIMEOUT_MS = 60_000`,自 confirm_required 发出起算,settle 时清理 timer)。
- `cancel()` 时队列全部拒绝("已取消");会话结束清理挂起审批。
- 越界路径:文件工具执行前 `isAllowed(absPath, allowedDirs)` 校验,越界 → `allow_dir` 审批,同意后目录加入可访问目录(写回 settings 持久化)。
- 命令审批:`needsApprovalFor(command, allowedDirs)`(terminal.ts),白名单命令(如 cd/pwd/ls/echo 等)免审批。
- **测试钩子**:`PICOAI_TEST_AUTO_APPROVE=1` 自动通过、`=0` 自动拒绝(不发 confirm_required、不弹窗);仅测试/开发环境使用,打包产物不含该 env。

## 6. 消息即状态(恢复/中断)

- 任务中断 = 会话 `status` 标记(`running`/`done`/`failed`/`canceled`)+ 从最后一条 user 消息重跑。
- `continue.ts`:取会话最后一条 user 消息,截断其后所有消息(工具调用链整体丢弃,`is_error` 标记保留),重新执行引擎循环。零额外运行时,无状态机。
- `chat:listRunning` 列出未完成会话供恢复。

## 7. 沙盒边界(@ai-sdk/sandbox-just-bash)

- 本地受限 shell 会话:**无用户文件权限**(不能读/写工作区外文件)、**数据不出本机**(无网络外发)、不可交互。
- **python3 不可用**,仅 bash(脚本需用 bash 原语实现);适合纯数字世界任务(文本处理/计算/API 调用)。
- 输出截断 `SANDBOX_MAX_OUTPUT_CHARS = 50KB`。
- 不用 Vercel 云端沙盒;Agent 生成脚本/技能脚本一律进沙盒。

## 8. 事件(engine.ts / events.ts)

完整事件表见 01-architecture.md §4(`agent:event` 通道)。`AgentEventEmitter` 类型化发射器,引擎内部使用、测试订阅、IPC 桥接复用。

## 9. 产物

`artifact` 事件在文件写入成功后发出;artifacts 表记录 `{path, type, size, conversation_id}`;renderer 可 `artifact:showInFolder` 在系统文件管理器中定位。

## 10. Provider

`provider.ts`:基于 `@ai-sdk/openai-compatible` 指向服务端网关 `POST /v1/chat/completions`(Bearer token),模型名来自 bootstrap `default_model`。
