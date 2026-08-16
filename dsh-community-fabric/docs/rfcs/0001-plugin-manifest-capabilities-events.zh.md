# RFC 0001：DSH 统一插件 contract——Manifest、Capability 与事件模型

[English](0001-plugin-manifest-capabilities-events.md) | 中文

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft / 征求意见 |
| 目标版本 | 实验性 v0.1 |
| 范围 | 插件与 Host 的互操作 contract |
| 参考实现 | DSH Community Fabric（尚未实现） |
| 讨论方式 | issue、discussion 或修改本文档的 PR |

## 0. 一句话摘要

为 DSH 社区定义一套由社区治理、可被静态分析的插件互操作标准：插件通过 manifest 声明身份与能力需求，Host 通过机器可读描述、能力协商和统一生命周期决定是否以及如何激活插件。

它借鉴浏览器扩展“manifest + capability + 统一 API”的思路，也借鉴 Forge/Fabric 把扩展挂在稳定生命周期上的经验，但不会宣称已经具备浏览器级沙箱，也不会另造一套与现有 DSH/Cordis 平行的插件加载生态。

## 1. Draft 边界

这是一份社区讨论稿，不是 DeepSeek 或 DSH 官方标准，也不是当前可用的开发 API。

当前 DSH 插件继续通过已有 package manifest、Cordis service、slot 与 patch 组合。Fabric 的第一步是建立由 Host integration 装配、位于版本化 DSH Adapter 之上的互操作层，不要求上游立即修改，也不要求 Host 移除 legacy 或内置扩展。

本 RFC 使用“必须”“应该”“可以”表达提案强度，但在 RFC 被接受、schema 发布且一致性测试存在前，这些词不构成稳定兼容承诺。

## 2. 背景

社区正在形成 GUI、Web UI、TUI、启动器、组合包和不同分发渠道。增长带来了几类共同问题：

- **兼容信息缺失**：安装前无法可靠知道插件需要图形界面、会话读写、托盘或其他能力。
- **实现耦合**：直接依赖 loader、内部函数或源码 patch 的扩展容易随上游变化失效。
- **接口重复**：不同 Host 为同一需求提供不同路径，插件作者需要维护多套适配。
- **组合冲突**：多个插件修改同一行为时，缺少声明、顺序和冲突规则。
- **分发困难**：市场与启动器缺少可静态读取的兼容元数据，只能依赖人工组合和锁版本。

本提案把上游特有变化集中到版本化 DSH Adapter，产品策略与用户体验由 Host integration 负责。插件侧 contract 与治理不绑定某个 DSH 版本；上游变化时，Adapter 与 Host 负责适配、明确降级或拒载，不能伪装成仍支持原有语义。

这并不意味着标准可以完全不受上游影响。若上游不再暴露实现某项能力所需的观察点或操作点，对应 Host capability 就必须暂时下线。

## 3. 目标

1. **静态声明**：工具无需执行插件代码即可读取身份、版本、入口、能力需求与声明式贡献。
2. **兼容协商**：required capability 缺失时明确拒载；optional capability 缺失时允许可预测降级。
3. **统一 contract**：标准范围内的同一件事只有一个规范接口和一套行为语义。
4. **适配现有生态**：Host 可以在 DSH/Cordis 等原生机制之上实现 adapter，不新增必须并行维护的加载体系。
5. **可验证**：manifest、Host Descriptor、协商器和生命周期具备 schema、fixtures 与 headless 一致性测试。
6. **降低用户摩擦**：市场和启动器能在安装前展示兼容、不兼容、待授权、已实测和未知。

## 4. 非目标

- 不要求 DSH 上游立即采纳本提案。
- 不统一 GUI、Web UI 与 TUI 的内部渲染技术。
- 不在本 RFC 中实现包管理器、市场后台、排行榜或账号系统。
- 不把“静态声明通过”描述为代码安全审核。
- 不承诺任意复杂 UI 一份代码无损运行在所有 Host。
- 不在 v0.1 中定义可修改的全套 `before-*` 事件。
- 不要求 Host 删除内置、legacy 或非标准插件路径；这些路径只是不参与 Fabric 一致性声明。

## 5. 信任与执行档位

Capability 需要区分四件事：

1. **support**：Host 声明能够提供某项能力。
2. **request**：插件在 manifest 中申请该能力。
3. **grant**：用户或策略允许该插件使用它。
4. **enforcement**：Host 通过隔离和受控边界真正阻止绕过。

v0.1 的参考实现可以采用 **trusted in-process** 档位：插件作为受信任代码运行，capability 用于兼容、授权和审计，不构成安全沙箱。Host 必须显著声明这个事实。

未来的 **isolated** 档位必须另行规定进程或 realm 隔离、模块白名单、受控 IPC、资源限制、文件与网络 scope、崩溃恢复和平台差异。没有这些证据的 Host 不得声称权限被强制执行。

## 6. 版本模型

以下版本不能混为一个字段：

| 名称 | 含义 |
| --- | --- |
| `version` | 插件自己的 SemVer 版本。 |
| `manifestVersion` | manifest JSON 结构版本。 |
| `apiVersion` | 插件要求的社区 Host API 兼容范围。 |
| capability / event version | 某项能力或事件 payload 的 contract 版本；v0.1 可暂时跟随 API 版本。 |
| Host version | 某个 GUI、Web UI、TUI 或启动器自己的产品版本。 |
| SDK version | 类型与开发工具 package 的发布版本，不自动等于标准版本。 |

标准的 breaking change 必须进入新的不兼容 API 范围。v0 阶段若采用 `0.x`，仍按“minor 可能 breaking”的实验规则明确标注，不能对外伪装成稳定 `1.x`。

### 6.1 术语

- **Host product**：承载插件的 GUI、Web UI、TUI 或启动器产品。
- **Host-side runtime face**：Host product 中实际执行 v0.1 插件 entrypoint 的 Node.js 环境。
- **Activation instance**：某个插件 entrypoint 的一次有界激活；生命周期与资源 ownership 都以它为 scope。
- **Adapter**：把 Fabric capability 映射到具体 DSH/Cordis 版本的实现。

v0.1 只规范 Host-side Node.js entrypoint 与 activation instance。浏览器 Client、原生界面或隔离 Worker 等 executable face，以及它们之间的通信协议，留给后续 RFC。TUI 在本文中是 Host product，不是 runtime face 名称。

## 7. 核心模型

```text
Manifest（插件是谁、请求什么）
    ↓
Host Descriptor（Host 支持什么、以何种执行档位支持）
    ↓
Negotiation + Authorization（能否运行、用户是否授权）
    ↓
Lifecycle + Events（何时激活、能观察什么）
    ↓
Capability-scoped Host API（激活后如何调用）
```

### 7.1 Manifest

v0.1 选择静态 JSON，不支持运行 JavaScript 动态生成。正式实现前必须发布 JSON Schema、固定文件名、路径规则和合法/非法 fixtures。以下仅是讨论用草案：

```json
{
  "manifestVersion": "0.1.0",
  "id": "com.example.message-memory",
  "name": "Message Memory",
  "version": "1.2.0",
  "apiVersion": ">=0.1.0 <0.2.0",
  "entrypoints": {
    "host": "dist/host.js"
  },
  "capabilities": {
    "required": {
      "messages.observe": ">=0.1.0 <0.2.0",
      "commands": ">=0.1.0 <0.2.0",
      "storage.local": ">=0.1.0 <0.2.0"
    },
    "optional": {
      "ui.panel.basic": ">=0.1.0 <0.2.0"
    }
  },
  "contributes": {
    "commands": [
      { "id": "com.example.message-memory.show-last", "title": "Show Last Message" }
    ]
  }
}
```

正式 schema 还必须定义：

- `id` 的语法、命名空间所有权和冲突处理；
- entrypoint 必须位于 package 根目录内，以及其模块格式和执行环境；
- Host / renderer / worker 等多个 entrypoint 是否允许及其通信边界；
- capability 版本范围和敏感 scope；
- 插件更新新增 capability 时的重新确认；
- `contributes` ID 的命名空间与冲突规则；
- manifest 与 npm package metadata 重复字段的权威来源。

在 schema 冻结前，还需要决定是否把四类声明拆开：`requires` 表示 Host 功能依赖，`permissions` 表示用户授权范围，`contributes` 表示声明式扩展，`subscriptions` 表示事件订阅。它们不能仅因为都写在 manifest 中就被当成同一种安全对象。

标准不规定某一种 loader 或源码转换实现。Host 通过 manifest 找到 entrypoint，再用自己的原生机制按标准生命周期激活。Fabric-managed 插件必须走这条入口；Host 的其他扩展路径必须明确标为非标准。

符合标准的 Fabric entrypoint 运行时不依赖 DSH、Cordis、Desktop 或 Adapter package。Package inspection、依赖规则和 conformance fixtures 会阻止意外耦合；trusted in-process 模式仍不能把这条受支持边界变成恶意代码沙箱。

### 7.2 Host Descriptor

每个兼容 Host 必须发布机器可读描述。以下同样是讨论草案：

```json
{
  "descriptorVersion": "0.1.0",
  "id": "org.example.dsh-webui",
  "version": "1.4.0",
  "apiVersions": ["0.1.0"],
  "execution": {
    "environment": "node",
    "trustMode": "trusted-in-process"
  },
  "capabilities": {
    "messages.observe": "0.1.0",
    "commands": "0.1.0",
    "storage.local": "0.1.0"
  },
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"]
}
```

兼容判断优先依据 API 与 capability，而不是 `gui>=2.0` 这样的模糊产品名称。必须限制具体 Host 时，应使用稳定、带组织命名空间的 Host ID。

市场展示至少区分：

- **声明兼容**：静态协商通过；
- **等待授权**：Host 支持，但敏感能力未获用户授权；
- **已实测**：明确的 Host、系统、插件和测试套件组合通过；
- **不兼容**：required capability 或 API 范围无法满足；
- **未知**：信息不足。

声明兼容不等于实测，更不等于安全审核。

默认交互应展示但禁用不兼容插件，并列出缺少的 capability；直接隐藏会让跨设备或跨 profile 的插件看起来凭空消失。

### 7.3 Capability

Capability 是带版本的 Host service contract。v0.1 候选命名空间包括：

| 名称 | 目的 | v0.1 状态 |
| --- | --- | --- |
| `storage.local` | 插件私有、受 Host 管理的持久化。 | v0.1 协商 capability |
| `commands` | 为 manifest 中声明的命令绑定 handler。 | v0.1 协商 capability |
| `messages.observe` | 观察不可变的消息事件。 | v0.1 协商 capability |
| `sessions.read` | 读取经过版本化和裁剪的会话视图。 | 后续设计 |
| `ui.panel.basic` | 极小、版本化的声明式 UI 公共子集。 | 后续原型 |
| `sessions.actions`、`net.*`、`fs.*` | 修改会话、网络与文件能力。 | 暂缓 |

每项 capability 都必须单独规定方法、输入输出 schema、错误、取消、生命周期、隐私、资源限制和测试。私有扩展使用组织命名空间，例如 `x-org.example.tui.keymap`，不能使用容易冲突的短名称。

“标准接口唯一”只约束 Fabric contract：标准插件不能为同一项标准能力发明旁路。它不声称能够阻止 trusted in-process 代码直接使用 Node.js API。

声明式 contribution 不会隐含运行时访问或授权。Manifest 中的命令元数据是权威来源；命令 contribution 还要申请 `commands`，插件代码只按 ID 绑定 handler。Required API 在协商后一定存在；optional API 必须先经过显式 capability 检查与类型收窄。

### 7.4 Lifecycle 与事件

Host product 状态与插件 activation 是两套独立状态机。Host 通常经历：

```text
starting → ready → stopping → stopped
```

Host ready 后，每个 activation instance 独立经历：

```text
discover → validate → negotiate → authorize
→ activating → active → deactivating → disposed
```

Host 必须为正常 activation 保证顺序，并在正常关闭时 best-effort deactivate，但不能在进程崩溃、断电或强制终止时保证 `deactivate` 送达。Plugin 必须把清理设计为可重复，并假设下一次启动可能需要恢复残留状态。Host 保持 ready 时，同一插件也可能因 HMR 或 profile 重新组合而重复 activate/dispose。

`activate` / `deactivate` 是 Host 调用的 activation-instance hook，不是插件自行订阅的普通业务事件。v0.1 的同一个 Host-side entrypoint 可以被重复激活；正式 lifecycle contract 必须定义重复激活、HMR 与 provider 替换行为。Client 或 isolated Worker 等其他 face 的 scope 与跨 face 通信另写 RFC。

v0.1 首先规范生命周期和一个不可修改的 `messages.observe` 事件。这个事件必须定义 payload schema、敏感字段、同一 scope 内的顺序、并发、回压、错误隔离、取消信号和关闭行为。

可修改或取消的 `before-*` 事件暂不进入 v0.1。后续 RFC 必须先回答：

- 多插件执行顺序与优先级；
- 多次修改的合并方式；
- cancel 后是否继续调用；
- timeout、异常、回滚和重入；
- 每 session 的顺序与跨 session 并发；
- 隐私与敏感数据裁剪。

### 7.5 Host API

未来 SDK 可能提供类似下面的开发体验，但 package 名称和签名尚未冻结：

```ts
export default definePlugin((ctx) => {
  ctx.commands.handle('com.example.message-memory.show-last', async () => {
    const lastMessageId = await ctx.storage.local.get('lastMessageId')
    ctx.log.info('Last observed message', { lastMessageId })
  })

  ctx.messages.onReceived(async (message) => {
    await ctx.storage.local.set('lastMessageId', message.id)
  })

  return {
    deactivate() {
      // release resources owned by this activation
    },
  }
})
```

`ctx` 只暴露协商后获准的标准 capability。required 缺失时插件不会激活；optional 缺失时对应 API 不存在，插件必须走明确降级路径。

在 trusted in-process 档位中，这仍然只是受支持 contract facade，不是 JavaScript 安全边界。

## 8. Host 的义务

兼容 Host 应当：

1. 对 Fabric-managed 插件只读取静态 manifest，不执行动态 manifest 代码。
2. 发布真实的 Host Descriptor，不声明无法保持语义的 capability。
3. 在执行插件代码前完成 schema 校验、API 与 capability 协商和必要授权。
4. 对 required 缺失给出用户能理解的拒载原因，对 optional 缺失提供确定的降级结果。
5. 保证正常生命周期顺序，并捕获跨越标准 callback / Promise 边界的普通异常；trusted in-process 无法隔离 `process.exit`、native crash 或死循环。
6. 公开执行档位与限制，不能把 trusted in-process 描述成沙箱。
7. 运行与版本绑定的一致性测试，并发布测试环境和结果。

## 9. 与现有 DSH/Cordis 的关系

Fabric 不能通过重新发明 loader 来解决 loader 割裂。参考 adapter 应把 Fabric contract 映射到现有 DSH/Cordis composition：

- manifest 负责静态发现与协商；
- Host integration 通过版本化 DSH Adapter，把获准 capability 映射到已有 service、slot、route 或事件；
- 原生 Cordis lifecycle 继续拥有实际资源释放；
- 无法等价映射的能力必须报告不支持，不能偷偷使用内部接口近似；
- 现有插件可以通过迁移工具补 manifest，但不会因为 Fabric 出现而立即失效。

这里反对的是修改上游源码、猴子补丁和私有函数 hook。现有 `cordis.patch.yml` 是 DSH 官方的声明式 profile 组合层，不是源码 patch；Fabric adapter 本身也可能通过标准 bundle patch 进入现有 composition。

本仓库当前公开的 `desktopProfiles` 与 `desktopPnpm` 是 Desktop 特定 Host service，不会自动成为跨 Host 标准。若社区希望标准化其中某一用途，应另写 capability RFC，并由多个 Host 共同证明语义可移植。

## 10. 市场、组合包与兼容证据

市场可以索引 manifest 和 Host Descriptor，在安装前计算静态兼容性，但不能把目录收录描述为审核或安全认证。

组合包继续是一等公民：它可以锁定标准版本、Host 版本、插件版本、平台和测试结果。锁版本从“对抗不稳定”转化为可复现发行策略，但不能替代每个 contract 的 SemVer 与兼容窗口。

任何“已实测”记录都应绑定：

- 标准与 schema 版本；
- Host ID、版本、平台与架构；
- 插件 ID 与版本；
- 一致性测试套件版本和 commit；
- 测试时间与结果。

## 11. 最小落地路径

实验性 v0.1 只有在 Phase 0–2 的最小 contract 都有规范和测试后才完成；阶段编号表示实现顺序，不是三个相互矛盾的版本范围。

它的精确 runtime 范围是：基础 `host.info`、`log` 和生命周期取消，再加需要协商的 `storage.local`、`commands` 与一个不可修改的 `messages.observe` 事件。本文中的其他名称都是后续候选。

### Phase 0：标准基础

- RFC 0000：治理、状态与变更流程；
- manifest JSON Schema；
- Host Descriptor Schema；
- 合法/非法 fixtures；
- 纯函数 capability 协商器；
- headless 一致性测试骨架。

### Phase 1：受信任参考 adapter

- 只支持一个明确的 Node.js Host 执行环境；
- 实现 discover / validate / negotiate / activate / deactivate；
- 首批 capability 保持低风险且不修改业务状态；敏感只读数据仍需授权与裁剪；

### Phase 2：事件与最小贡献点

- 一个不可修改的 `messages.observe` 事件；
- `storage.local`；
- `commands` 作为最小声明式 contribution 与 runtime binding；
- 故障插件、timeout、取消和关闭 fixtures。
- 完整 v0.1 能力存在后，由至少两个不同 Host product 或 integration 提供互操作证据；它们可以共享同一个版本化 DSH Adapter。

### 后续独立 RFC

- 可修改的 `before-*` 事件；
- 最小跨 Host UI IR；
- 文件、网络与会话写入权限；
- 隔离执行与受控 IPC；
- 市场兼容标签与一致性结果交换格式。

## 12. 治理要求

在本 RFC 进入 Accepted 前，应先通过 RFC 0000 明确：

- Draft、Review、Accepted、Final、Deprecated、Superseded、Withdrawn、Rejected 等状态；
- 最短公开评审期、决策方式、异议与申诉；
- capability/event 命名登记；
- breaking change、弃用窗口与勘误；
- 安全问题的非公开披露渠道；
- 规范与参考实现许可证；
- “社区标准”与“官方标准”的表述边界。

参考实现不能反向决定规范。一个行为只有在规范文本、fixtures 和一致性测试中被定义，才属于标准 contract。

## 13. v0.1 验收与一致性证据

实验性 v0.1 把证据分成四类：

1. **Schema validation**：公开 Manifest / Host Descriptor Schema、完整 SemVer 规则，以及合法/非法 fixtures。
2. **Host conformance**：required / optional 协商、未知版本、授权拒绝、activation 顺序、best-effort 关闭、标准 callback 异常和真实执行档位。
3. **Plugin validation**：manifest 与 entrypoint 一致、只使用已声明 capability、optional 降级路径、资源可释放、错误可理解。
4. **Interop evidence**：两个独立 Host product 或 integration 与三个示例插件完成同一组场景，作为 v0.1 从 Draft 晋级的标准证据。两个 Host 可以共享 DSH Adapter，但 integration 与 descriptor 证据必须独立。

由于 Events 属于 RFC 标题与 v0.1 范围，至少一个不可变观察事件必须拥有 payload schema、隐私裁剪、scope 内顺序、回压/timeout、异常处理、关闭语义和 headless contract tests。

Host 只能声称“该 Host 通过 v0.1 Host conformance suite”；插件只能声称“该插件通过 v0.1 plugin validation”。两者都不能称为“安全插件”或“官方认证”。

## 14. 开放问题

1. manifest 固定文件名是什么？是否放在 package 根目录，还是嵌入 `package.json`？
2. 插件 ID 的发布者命名空间如何证明所有权并处理转移？
3. v0.1 应支持哪个 Node.js 版本、模块格式和 entrypoint 加载边界？
4. v0.1 `messages.observe` payload 应包含哪些字段、scope 与隐私裁剪规则？
5. capability 版本是独立 SemVer，还是在 v0 阶段跟随 `apiVersion`？
6. 需要什么证据才能证明 `commands` 在 GUI、Web UI 与 TUI Host 中语义一致？
7. Host 一致性结果由谁签发、保存和撤销？
8. RFC 评审期、merge 权限和争议解决如何由社区共同治理？

## 15. 为什么现在做

生态已经出现多个 Host、插件作者和分发渠道。此时建立静态、可测试的互操作 contract，比等接口进一步碎片化后再统一成本更低。

真正要复用的不是某个 loader，而是长期稳定的声明、协商、生命周期与验证方法。我们希望 Fabric 成为社区共同维护的适配层和实验场，而不是另一家单方面宣布的平行插件系统。

下一步不是“一周后自动成为标准”，而是公开收集反例、先完成治理 RFC 与 schema fixtures，再用两个 Host 和真实插件验证最小 contract。
