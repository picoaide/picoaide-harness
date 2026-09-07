# 内置 AI 浏览器：重新设计蓝图 v4（文字设计图 · 会话分组隔离 + AI 优先工具面 + 简洁大气 UI/UX）

- 日期：2026-09-07
- 状态：规划（仅设计，未实施）
- 范围：`packages/host/browser`（@picoaide/dsh-browser）产品形态、交互、工具能力面、会话分组权限隔离、UI/UX 设计规格；不涉及上游 deepseek-harness
- 演进记录：v1 = 视觉/布局重构；v2 = 「面向 AI 的浏览器」工具能力面 + 健壮性；v3 = 会话分组 + 权限隔离（并行制等 7 决策）；**v4 = 全量 UI/UX 审计重建（简洁大气：内容优先、状态克制、AI 状态单点凸显），架构与工具面结论全部保留**。v4 为当前唯一权威设计。

---

## 0. 拍板决策摘要（v3 的 7 项 + v4 精简）

| # | 决策点 | 拍板结果 | 对架构的影响 |
|---|---|---|---|
| 1 | 多会话驱动模型 | **并行制**：各会话可同时后台驱动自己的组 | 互斥从「全局一把锁」改为「每会话组一把锁，组间并行」；窗口内容区有「前台组」概念；后台组页面照常运行（关闭 backgroundThrottling） |
| 2 | 用户手动标签归属 | **归当前前台会话组**（用户操作=帮前台会话干活） | 无「用户私有组」；用户操作记录到当前前台组的 op log，AI 可见可续做 |
| 3 | 子代理归属 | **继承发起会话组** | 经 `session.meta.parentSession` 血统映射，子代理与父会话共组共锁 |
| 4 | 会话结束后的组 | **保留 24h + 可手动关闭**；重新打开同会话恢复现场 | 组生命周期 = 活跃 → 归档(24h) → 回收；重开自动重建标签集 |
| 5 | 用户接管范围 | **整窗接管**（暂停所有会话的浏览器动作） | 全局「用户闸」叠加在组锁之上；释放后各会话从动作边界继续 |
| 6 | 数据隔离维度 | **共享 + 会话标注** | 书签/下载共享；历史带 session 来源字段；凭证仍 per-user partition |
| 7 | 并发配额 | **上限 + 等待**：活跃组 ≤4、组内标签 ≤8、全局标签 ≤16，超限排队 | 新增组/标签等待队列 + 等待超时错误码；企业可配 |

---

## 1. 术语表（先定词，防歧义）

**双向约定：内部技术词负责精确；UI 文案负责自然——界面永远不出现技术词。**

| 术语（内部） | 定义 | UI 文案（唯一允许的说法） |
|---|---|---|
| **会话（Session）** | DSH agent 会话，身份 = `SessionId`（工具上下文 `exec.agent.id` 即此值）。浏览器分组的单元 | 「会话 A」 |
| **会话组（Group）** | 一个会话拥有的标签页集合 + 一套独立互斥锁。组 = 会话的一对一映射（子代理映射到父会话组除外） | 「这个会话的标签页」/「会话 A 的标签页」 |
| **组密钥（GroupKey）** | 标识组的 SessionId（解析规则见 §3）。子代理的组密钥 = 其顶层父会话 id | （不出现） |
| **前台组（Foreground Group）** | 窗口内容区当前显示的组，仅一个。由用户在 TabStrip/活动面板手动切换；AI 工具调用不影响前台归属 | 「正在查看的会话」 |
| **组内激活标签（Active Tab）** | 每个组自己的「当前标签」；工具默认目标。各组独立 | （不出现） |
| **操作中（Driving）** | 该会话此刻有浏览器工具在执行（组锁被持有） | 「AI 操作中」（状态点=品牌色呼吸） |
| **等待中（Waiting）** | 该会话有工具在排队（被组锁、全局闸或配额队列挡住） | 「等待中：…原因」（中性文字） |
| **接管（Takeover）** | 用户接管：所有组暂停，唯一例外是人自己的操作；释放后继续 | 按钮「我来操作」；接管后按钮变「交给 AI」 |
| **已暂停（Suspended）** | 用户接管期间所有会话处于暂停 | 「AI 已暂停」（琥珀静态） |
| 归档组（Archived） | 会话结束后保留的组（24h），只读可查看，不可被 AI 驱动。**归档瞬间销毁 view 仅留 URL 元数据**（已确认 #2）；查看 = 重新加载页面 | 「已结束的会话」 |
| **活动面板（Panel）** | 右侧浮层：会话切换器 + 动作时间线 + 操作权按钮 | 「AI 活动」（面板标题） |

---

## 2. 分组模型

### 2.1 核心数据结构

```
GroupRegistry（进程内单例）
├─ groups: Map<GroupKey, Group>
├─ subagentIndex: Map<SessionId, GroupKey>     // 子代理→顶层父会话映射（血统表）
└─ quota: { maxGroups:4, maxTabsPerGroup:8, maxTabsTotal:16, waitTimeoutMs:60000 }

Group
├─ key: GroupKey（顶层 SessionId）
├─ label: string（会话标题，取不到时「会话 <id 短码>」；用户可重命名）
├─ status: 'active' | 'archived'           // 归档 = 会话已结束，仅保留
├─ createdAt / lastActiveAt
├─ tabs: Map<tabId, BrowserTab>            // 每个 tab 绑定 GroupKey
├─ activeTabId
├─ mutex: GroupMutex                       // 组内串行锁（见 §4.2）
└─ queue: 组内等待队列（标签配额等待）
```

### 2.2 组属性（组头 UI 展示的全部来源）

- 组名（会话标题/短码/用户重命名）
- 状态点（仅 5 种渲染状态，与 §13.2 三色制一致）：`空闲`（中性灰）· `操作中`（品牌色呼吸）· `等待中`（中性灰点 + 组头 hover 或活动面板文字说明，不占颜色通道）· `已暂停`（琥珀）· `归档`（深灰静态）
- 是否前台组（组名旁 6px 蓝点 + 该组标签条底色微亮）
- 标签数仅在组头 hover 菜单中显示（`n/8`），不常驻
- 来源徽章：组内标签来源不标注（人机共享组的协作语义），动作标注在活动面板时间线

### 2.3 显式规则（防乱写，全部为硬性规定）

1. 一个会话最多一个组；一个组只属于一个会话（子代理归父组）。
2. 组不可被 AI 创建/删除——首次 `browser_open` 自动创建，会话结束自动归档。用户可手动关闭组（组内全部标签关闭）。
3. 组内标签 id 全局唯一（沿用 1 起递增），但**工具解析 tab 时先校验归属**（见 §6）。
4. 归档组：AI 工具一律拒绝（错误码 `group-archived`）；用户可查看、可手动关闭、可从「已结束的会话」入口重新激活。
5. 前台组切换只由用户触发；AI 工具调用不改变前台组。
6. **组内最后一个标签关闭 → 组删除**（会话可再 open 重建；已确认 #8）；归档组内的最后标签关闭 → 组直接回收。

---

## 3. 会话 → 组解析规则（权限隔离的根基）

### 3.1 解析函数 `resolveGroupKey(agentId: SessionId): GroupKey`

1. 查 `subagentIndex`：命中 → 返回映射的父组密钥（子代理继承）。
2. 会话元数据 `meta.parentSession` 存在（从 session 创建事件捕获，见 3.2）→ 递归向上到无 parent 的顶层会话，登记 subagentIndex，返回该顶层 id。
3. 否则（普通会话/无血统信息）→ 返回 agentId 自身；首次出现时建组。

### 3.2 血统表维护

- 监听上游会话创建事件（`session/created`，事件名以实现期为准）读取 `meta.parentSession` + `origin:'subagent'`，写入 subagentIndex。
- 血统表不是权威：**兜底策略**是「无映射即独立成组」——子代理若拿不到血统也不会越权（顶多是多一组），安全性只增不减。
- 血统表随组回收清理；会话销毁事件（若可得）同步清理。

### 3.3 用户操作归属（决策 #2）

- 用户的标签/浏览操作（shell 的 `+`、地址栏、标签操作、接管）一律作用于**当前前台组**；用户操作记录 op log 的 actor = `user`，AI 可见（组内共享轨迹）。
- 无前台会话组时：用户动作**自动激活一个最近会话组**（按 lastActiveAt 排序，跳过归档组）；当真无任何组时创建**未绑定组**（组名「我的」，不绑定会话、AI 不可见、不占 AI 配额，窗口内上限 1 个）——仅作兜底，用户隐私语义与决策 #2 一致（用户主动切到未绑定组浏览 = 对自己可见、对 AI 不可见，这是协作制的合法例外）。

---

## 4. 并行驱动状态机（本版核心机制）

### 4.1 与 v1「全局互斥」的差异

| 维度 | v1（现状 ControlMutex） | v3（并行制） |
|---|---|---|
| 锁粒度 | 全局一把 | 每 Group 一把（GroupMutex） |
| 组间并行 | 不允许 | **允许**：A 组导航的同时 B 组可点击 |
| 组内顺序 | — | 严格串行（同一会话的工具按调用序执行） |
| 用户接管 | 全局互斥暂停 | 全局「用户闸」：所有组锁的运行点暂停在工具边界（见 4.4） |
| 前台概念 | 无（一个窗口一个可见 tab） | 前台组 = 窗口内容区归属；后台组照常执行 |

### 4.2 GroupMutex（组内串行）

- 每 Group 一个 promise-queue（复用 v1 `ControlMutex.run()` 的实现，去掉全局 taken，改造为接受「全局闸」检查）。
- 组内调用顺序 = agent 工具调用顺序（agent 本身串行），队列保持 FIFO 即可。
- 读类工具（list_tabs/get_snapshot/get_text/screenshot/wait_for）也在组内串行执行——v3 决策：**保持简单**，不为读操作开并行（记录顺序与日志一致，收益小）。

### 4.3 组状态（8 态，UI 状态点一一对应）

```
[不存在] ──browser_open──▶ [创建] ──工具执行──▶ [操作中]
                              │                    │
                          [空闲] ◀──工具完成──────┘
  操作中/空闲 ──其他会话占配额排队──▶ [等待中]
  任意组 ──用户接管──▶ [已暂停] ──释放──▶ 回到操作中/空闲/等待中
  会话结束保留 ──▶ [归档]（24h）──超时/手动关闭──▶ [不存在]
  [归档] ──重新打开同会话(恢复现场)──▶ [活跃-空闲]
```

- 状态转换全部由 runtime 事件驱动（同一时钟线），驱动状态 = per-group busy/busyTool/latestOp（替换 v1 的全局 busy 字段）。

### 4.4 用户闸（整窗接管，决策 #5）

- 全局 `windowControlled: boolean`。`takeover` 置 true 时：
  - 每个组的**下一个工具调用**在组锁入口等待（等价 v1 语义，推广到所有组）；
  - **在途工具不打断**（单次 CDP 操作原子化，不可安全中断；被接管后完成并在 op log 标 `⏸ 被用户接管`）；
  - 新工具排队至 `release`；排队中的工具在 op log / 活动面板显示「用户控制中，等待释放」。
- `release` 后全部组从各自队列恢复，不改变组的执行顺序。
- 用户自己的操作（shell UI）永远放行（与 v1 一致：user=true 绕过）。

### 4.5 AI 可见性（并行制的核心补偿，v4 表达）

- **全局唯一 AI 指示**：窗口右下角悬浮胶囊。文案（按已确认决策 #17-4/3）：空闲时浅灰静态「AI」；有会话操作时「● AI 操作中 · 会话A」；多会话时「● 2 个会话操作中」；被接管时「● 已暂停」（琥珀）。呼吸动画全窗口只此一处，避免多点闪烁；胶囊常驻不隐藏（也是活动面板的唯一常驻入口）。
- **活动面板 = 会话切换器（横排胶囊）+ 单一动作时间线**：顶部胶囊逐个会话（点 = 呼吸、灰 = 空闲、其余中性）；选中会话后下方是该会话的动作时间线（语义化条目 + 状态）。用户点胶囊即切换「正在看哪个会话」，无重复状态卡。
- 后台会话在操作时：其胶囊出现呼吸点 + 切换器右端提示「N 个会话正在操作」——点击即查看，无需理解「前台/后台」概念。
- **AI 侧不做「我的组在前台吗」感知**：工具照常执行（并行制语义）；所有会话对用户可见，AI 只见自己组（§6）。

---

## 5. 窗口呈现模型（v4：单窗口 + 两行极简 chrome + 右侧浮层活动面板）

### 5.1 设计审计结论（v3 UI 的问题清单 → v4 对策）

| v3 问题 | 后果 | v4 对策 |
|---|---|---|
| 三行 chrome（TabStrip+Omnibox+状态条 ≈ 96px） | 内容区被砍，浏览器窗口气场像管理后台 | **两行**：TabStrip 30px + Omnibox 36px；删除独立状态条（信息并入活动面板） |
| 组头胶囊塞 5 个元素（状态点+会话名+标签数+折叠+关闭） | 可读性差，一行视觉噪音 | 组头只留「会话名」+ 状态点；标签数/折叠/关闭收进组头 hover 菜单 |
| 活动面板每会话一张卡 + 「切到前台」按钮 ×N | 把内部调度器画给用户，技术噪音 | 活动面板 = 顶部「会话切换器」横排胶囊 + **单一动作时间线**；无重复卡片 |
| 5 种状态色（灰/蓝/琥珀/橙/…） | 颜色语义过载，记不住 | **克制的三色**：中性灰（默认）· 品牌色（AI 正在动作）· 琥珀（用户已接管）；其余全部中性 |
| AI 徽章塞进地址栏 | 地址栏是输入区，混入状态指示 = 噪音 | **全局唯一 AI 指示**：窗口右下角悬浮胶囊（呼吸动画只在此出现），点击展开活动面板 |
| 「关闭组」直露组头 | 误触即关闭整组标签 | 收进组头 hover 菜单 + 二次确认 |
| AI 活动标签整圈描边 | 视觉过重 | 仅 favicon 处 6px 品牌色圆点（克制） |
| 状态条与活动面板信息重复 | 双重提示 | 只保留活动面板一种表达 |
| 字符符号当图标（⟳ ← → ×） | 简陋感来源 | Lucide 线性 SVG，stroke 1.5px，16/18px 两档 token |

### 5.2 窗口布局（线框）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ┌会话A───────┐                                                             │
│ ◌Doc ⨯  ◌论坛 ⨯ │ ┌会话B─────┐   ◌盘古 ⨯        ← TabStrip 30px（会话/标签/＋）
│ └ 正在查看(蓝点)┘│ └ 会话B ──┘                   段标题=会话名+状态点
├────────────────────────────────────────────────────────────────────────────┤
│ [◀][▶][⟳] │ 🔒 https://… │ ☆ │ ⋮ │     ← Omnibox 36px（导航+地址+收藏+菜单）
│                                                                            │
│              WebContentsView（正在查看的会话的当前标签；内容优先）          │
│                                                                            │
│                                                  ┌─────────────────┐       │
│                                                  │ ●AI 操作中·会话A│       │
│                                                  └─────────────────┘       │
│                                         右下角悬浮 AI 指示（唯一呼吸点）       │
└────────────────────────────────────────────────────────────────────────────┘
```

**活动面板（点击 AI 指示展开）**——右侧浮层滑出（320px，不挤压内容区，无遮罩）：

```
┌ AI 活动 ──────────────────────┐
│ [◉会话A] [◉会话B] [◉会话C]      │ ← 会话切换器（横排胶囊：点=该会话操作中/呼吸）
├───────────────────────────────┤
│ ● 正在点击「下一页」            │ ← 当前会话 动作时间线（语义化动作，可滚动）
│ ✓ 导航到 example.com 产品页     │
│ ✓ 用凭证「GitHub」填写表单      │
│ ── AI 已暂停：你正在操作 ──     │
│                               │
│ [我来操作]   (接管态=琥珀条)    │ ← 固定底部；接管后变为 [交给 AI]
└───────────────────────────────┘
```

### 5.3 结构规则（v3 不变项 + v4 细化）

- 窗口只有 1 个；内容区永远显示前台组的激活标签 view；后台组 `setVisible(false)` 照常执行（`backgroundThrottling=false`）。
- 组切换：点击组头 / 活动面板会话胶囊 / Ctrl+Tab 轮换；前台组 = 组头蓝点 + 标签条底色微亮。
- **AI 开组/开标签不抢前台**：`browser_open` 只建组，窗口如已显示其他组则不切换前台（前台归用户）；窗口未打开时则创建并显示窗口（默认前台 = 新组，因为此时无其他组）。
- chrome 高：TabStrip 30 + Omnibox 36 = 66px；活动面板折叠时内容区 0 占位。
- 空态：无任何组 → 内容区居中启动卡「打开浏览器，AI 将在你的会话中自动创建标签组」（简洁插画 + 一行说明）；组内无标签 → 组内引导卡「为该会话打开第一个页面」。

### 5.4 用户语言（降技术感）

- UI 不出现「前台组/后台组/组密钥/标签组」等术语；组切入口文案 = 会话名；活动面板胶囊 = 会话名 + 状态点。
- 提示一律自然语言：「会话 A 正在操作浏览器」「还有 2 个会话在操作」「等待标签配额…」。

---

## 6. 工具层权限隔离（硬性矩阵）

### 6.1 总原则

1. 每个工具 execute 第一步：`const groupKey = resolveGroupKey(exec.agent?.id)`；`exec.agent` 缺失（非 agent 上下文）→ 工具拒绝（错误码 `no-session`，防匿名调用）。
2. **工具只看得到本组**：list/snapshot/操作默认目标 = 本组；任何跨组 tab 引用 → `foreign-tab` 错误（**不携带目标组任何信息**，避免把其他会话存在性/标题泄露给模型）。
3. 组权限矩阵（每工具 × tab 归属校验）：

| 工具 | tab 参数解析 | 越界行为 |
|---|---|---|
| open / navigate / reload / back / forward / close_tab / switch_tab | 显式 tab ∈ 本组，否则 `foreign-tab`；缺省 = 本组激活标签 | 拒绝 |
| click / type / press / select / scroll / upload_file / fill_form | 同上 | 拒绝 |
| fill_credentials | 同上 + 凭证仅限当前用户（partition 已隔离） | 拒绝 |
| wait_for / get_snapshot / get_text / screenshot | 同上（读操作组内串行） | 拒绝 |
| eval | 同上 + **只读表达式校验**（见 §7.3-9；校验失败 `eval-policy`）+ 企业可禁（policy） | 拒绝 |
| list_tabs | 无参；**只返回本组标签** | — |
| download | 无 tab 参数（对本组激活标签所在页生效）+ 下载目录白名单（DSH_HOME/downloads + 当前会话工作区，可配） | 拒绝非白名单路径 |
| downloads_list / downloads_remove | 无 tab 参数（用户会话级数据，见 §8） | — |
| bookmarks_* / history_search / credentials_list | 见 §8（数据共享 + 会话标注） | — |
| takeover / release | 整窗语义（任意会话可调） | — |
| clear_data | 带 `scope: 'group' \| 'all-data'`（默认 group=清本组）| — |

4. 兜底：GroupRegistry 找不到组 → `group-not-found`（提示先 browser_open）。归档组 → `group-archived`。

### 6.2 错误码扩展（在 v2 taxonomy 上追加）

| 错误码 | 含义 | AI 可恢复动作 |
|---|---|---|
| `no-session` | 工具调用无 agent 身份 | 无法自行恢复 |
| `foreign-tab` | tab 不属于本会话组 | 重新 list_tabs（只看到本组） |
| `group-not-found` | 本会话无浏览器组 | browser_open 建组 |
| `group-archived` | 组已归档（会话结束） | 无（用户恢复会话） |
| `group-quota` | 配额满，等待超时（默认 60s） | 稍后重试 / 关闭其他标签 |
| `window-controlled` | 用户接管中 | 等待用户释放 |
| `eval-policy` | eval 表达式未过只读校验（含赋值/副作用 API） | 改用只读辅助函数或 get_snapshot/get_text |
| `policy` | 企业禁用了该工具（如 evalEnabled=false） | 无法自行恢复 |

---

## 7. 工具面 v4（权威清单：现状 20 工具 → 18 保留 + 14 新增/升级 = 32）

> 事实修正（2026-09-07 审计）：现状 @picoaide/dsh-browser 实际注册 **20 个工具**（open/new_tab/navigate/reload/go_back/go_forward/click/type/press/select/scroll/screenshot/get_snapshot/get_text/list_tabs/switch_tab/close_tab/close/eval/fill_credentials）；`takeover/release/clear_data` 是 **shell HTTP 动作**（非工具），`download` 由下载守卫自动处理（非工具）。本设计把这 4 个升级/新增为 AI 工具，其余按减法审计。此前文档「现状 24 个」为误计。

### 7.1 工具全集（最终 32 个，按 6 组）

| 组 | 工具 | 说明（AI 视角一句话） |
|---|---|---|
| **导航 Navigate**(8) | open / navigate / reload / back / forward / list_tabs / switch_tab / close_tab | 打开与浏览标签页（open 无参 = 空白标签，吸收原 new_tab） |
| **交互 Interact**(7) | click / type / press / select / scroll / fill_form / upload_file | 操作页面元素与表单 |
| **读取 Read**(5) | get_snapshot / get_text / screenshot / wait_for / eval | 感知页面（列表单/读正文/看图/等待条件/只读表达式） |
| **记忆 Memory**(4) | bookmarks_add / bookmarks_list / bookmarks_remove / history_search | 持久工作集与轨迹回溯 |
| **产物 Artifacts**(3) | download / downloads_list / downloads_remove | 触发下载（程序化路径）/ 监督与取路径 / 清理 |
| **控制 Control**(5) | takeover / release / fill_credentials / clear_data / credentials_list | 人机权柄、凭证与隐私（credentials_list 只读账号名） |

### 7.2 减法与升级审计记录（2026-09-07）

**构成**：18 保留（20 现状 − new_tab并入 open − close 删除）+ 11 新增工具 + 3 个 shell 动作升级为工具（takeover/release/clear_data）+ download 守卫升级为工具 = **32**。

**用户决策（不可再议）：`browser_eval` 保留**——必须能读取页面非显式参数（SSR 内联数据 `window.__NEXT_DATA__`、全局状态、隐藏字段、script JSON、dataset、localStorage、canvas/performance 等 snapshot 与文本抽取覆盖不到的信息）。**保留形态 = 受限只读 eval**（见 §7.3-9），绝不做「任意 JS 执行」；企业仍可整体禁用。

**移除/合并的 3 个（非必要）**：

| 工具 | 判据 |
|---|---|
| browser_close（现有工具） | 组生命周期系统管理（归档 24h + LRU + 用户关闭）；AI 无「关窗口」任务场景；close_tab 已覆盖 |
| browser_new_tab（现有工具） | 并入 browser_open（open 无参 = 空白标签；标签创建单一入口） |
| browser_get_page_info（v2 曾提议） | 与 get_snapshot 重叠（标题/url 已由 open/navigate 返回；页头信息并入 snapshot 返回） |

**保留但明确边界的（预设疑问的答复）**：

- `fill_form` vs `type`：表单整体 vs 单元素输入，心智不同，不合并。
- `get_snapshot` vs `get_text`：列可点元素 vs 读正文，心智不同，不合并成 mode 参数（参数歧义大于省工具数）。
- back/forward 不合并（浏览器原生心智）；bookmarks 三件套不合并成 action 参数（与全库「一工具一动作」命名一致，便于检权/审计/路由）。

### 7.3 工具面 v4 语义修订（继承 v3 全部修订 + 精简修正）

1. `browser_open`：建组（第一个组）+ 新标签导航；**组配额满 → 排队等待（60s）后报 `group-quota`**。
2. `browser_close`：**已删除**（组生命周期负责）。
3. 所有工具默认 `tab` = 本组激活标签（不再是「窗口可视标签」）。
4. `clear_data` 默认只清本组站点数据（scope 参数）；`all-data` 需用户 shell 二次确认，工具面拒绝跨用户但允许清自己全部。
5. `list_tabs` 返回增加组上下文：`{ group: { key, label, status, tabs, activeTab, foreground } }`。
6. `takeover/release` 语义 = 整窗（§4.4）。
7. `get_snapshot` 返回页头信息（title/url）+ 可交互元素表（吸收 get_page_info 能力）。
8. `download` 全程序化保存（无对话框，§11.6）；`downloads_list({ wait? })` 可等完成并返回保存路径。
9. **`browser_eval`（受限只读，用户拍板保留）**：
   - 参数：`{ tab?, expression, frame? }`；`expression` 必须是**单表达式**（无语句、无声明、无赋值）。
   - **AST 白名单校验**（解析于 host 侧，拒绝即 `eval-policy` 并说明原因）：禁止赋值/更新表达式、禁止变量与函数声明、禁止 `new`、禁止写入类与副作用类 API（fetch/XMLHttpRequest/sendBeacon/localStorage|sessionStorage.setItem/document.write/cookie 赋值/form.submit()/window.open/alert/confirm/prompt/print 等）；允许读取类调用（属性访问、getComputedStyle/getBoundingClientRect/getAttribute/dataset/JSON.parse + 只读辅助函数）。
   - **注入只读辅助函数**：`readText(sel)`、`readAttr(sel, name)`、`readJson(sel)`（解析 script type=application/json）、`readVar('a.b.c')`（全局变量 JSON 序列化路径读取）。
   - **frame 参数（已确认）**：整数序号，0 = 主 frame，与 get_snapshot 的 iframe 标注同源；负值/越界报 `not-found`；**允许 `document.cookie` 读取，结果脱敏**。
   - 结果：JSON 序列化，**上限 8KB / 深度 ≤ 6**；敏感值脱敏（token/session/cookie 模式）后才出工具与入审计。
   - 审计：expression 全文入 op log（代码非机密）；结果只存摘要 + 脱敏值。
   - 企业策略：`evalEnabled` 可整体禁用（错误码 `policy`）；**本轮只做只读**，写入模式（若未来需要）另行 P2 评审。

---

## 8. 数据层（共享 + 会话标注，决策 #6）

### 8.1 各 store 的字段设计

| store | 字段 | 隔离/共享 |
|---|---|---|
| 历史 | `{ seq, time, url, title, actor: 'ai'\|'user', session?: GroupKey, group }` | 共享可查；`history_search({ session? })` 可按会话过滤；工具默认不传 session=全量（AI 任务需要全局轨迹） |
| 书签 | `{ id, url, title, createdAt, actor, session? }` | **共享**（工作集）；`bookmarks_add` 默认标注当前会话；不分会话私有 |
| 下载 | `{ id, url, path, size, status, actor, session? }` | 共享；文件在用户 downloads/ 分区内 |
| 会话现场（组清单） | `{ groupKey, label, savedAt, tabs: [{url,title,active,scroll?}], activeTabId }` | **按组私有**（已确认：#1 组清单轻量持久化，随三 store 落盘；重启恢复为「已结束的会话」，重开会话按 URL 集重建） |
| 凭证 | 连接器 store（现有） | per-user（partition 已隔离），不变 |

### 8.2 明确边界

- 历史/书签/下载的会话标注用于「来源可追溯 + UI 可按会话过滤」，**不用于访问控制**（共享）。
- 会话快照是唯一按组私有的数据（防止 A 会话把 B 的现场恢复出来——违反分组隔离精神）。
- `clear_data({scope})`：group = 清本组历史/缓存（cookies 属用户 partition，不按组清；全量清=现有语义）。

---

## 9. 配额与排队（决策 #7）

| 配额 | 默认 | 企业可配 | 超限行为 |
|---|---|---|---|
| 活跃组数 | 4 | ✅ | 新会话 `browser_open` 进入全局等待队列；超 60s 报 `group-quota` |
| 组内标签 | 8 | ✅ | `open` 进入组内队列；超 60s 报 `group-quota` |
| 全局标签 | 16 | ✅ | 同上（两道上限取先到者） |
| 等待超时 | 60s | ✅ | 报错 + 提示「可稍后重试或清理标签」 |

- 队列顺序 = FIFO（按调用到达）；用户接管时配额队列同样挂起（全局闸）。
- 归档组不占活跃配额；**未绑定组（「我的」兜底组）也不占 AI 配额、窗口内上限 1 个**（已确认 #7）。
- 活动面板对等待中的调用可见（组状态 = 等待中，展示「等待标签配额」原因）。

---

## 10. 组生命周期（决策 #4）

```
活跃组（会话运行中）
  │ 会话结束（侦测：会话关闭事件；兜底：session/clear 或用户切换）
  ▼
归档组「已结束的会话」（24h 保留；归档瞬间销毁 view 仅留 URL 元数据。AI 工具全部拒绝 group-archived；用户可查看=重新加载）
  ├─ 重新打开该会话（同 SessionId） → 组恢复 active；按组清单 URL 集重建标签（激活/滚动尽力恢复）
  ├─ 用户手动关闭组 → 元数据删除
  └─ 24h 未活跃 → 定时器回收（后台任务，回收前 5 分钟活动面板提示「即将回收」）
```

- 会话结束侦测优先级：① 会话关闭/删除事件（实现期确认事件名，P1 接入）；② 兜底 = `lastActiveAt` + 24h LRU 定时回收（P0 先上，不依赖事件）。
- **组清单持久化（已确认 #1）**：每组标签 URL 集 + 激活标签 + 时间戳随三 store 落盘；应用重启后恢复为「已结束的会话」（归档态），重开会话按 URL 集重建——不再是 P2 评估项，随 P1 store 实现。

---

## 11. 健壮性设计（v2 §5 全部保留 + 并行制新增）

### 11.1 基础错误分类表（统一 taxonomy，所有工具共用）

| 错误码 | 触发 | AI 可自动恢复？ |
|---|---|---|
| `network` | DNS/连接/证书失败 | 可重试 1 次（限导航类） |
| `timeout` | 超时预算耗尽 | 提示改用 wait_for 或 get_snapshot |
| `not-found` | 元素/字段不存在 | 不重试；提示 get_snapshot 重新定位 |
| `navigation-blocked` | guard 拒绝（非 http/https/恶意域名） | 不重试；解释原因 |
| `auth-expired` | 登录态失效（访问业务页被重定向到登录页） | 提示 fill_credentials / credentials_list |
| `interrupted` | 被用户接管打断 | 记录在时间线，等待释放后续跑 |
（政策/隔离类错误码见 §6.2）

保留：wait_for、操作后反馈、auth-expired 检测、view 崩溃重建、下载/上传程序化（消灭 showSaveDialog 卡死）、三个本地 store（书签/历史/下载，append-only JSONL+索引+敏感参数剥离；会话现场由组生命周期承担）、iframe 穿透、资源预算。

新增（并行制特有）：

1. **backgroundThrottling = false**（后台组页面节流，头号坑）。
2. **组间 CDP 并发安全**：不同 webContents 的 CDP 会话天然隔离；共享部分 = shell 状态推送（单写多读，事件总线串行化）。
3. **前台切换的可见性竞态**：switch 时「隐藏旧组 view → 显示新组 view」原子操作（同一 JS 同步帧内），避免两个 view 同帧叠加。
4. **配额队列可取消**：工具 abort（agent stop）时从队列移除，不留死条目。
5. **组内工具超时与组锁释放**：异常路径 finally 释放（沿用 v1 模式）；组锁挂起不可永久占用。
6. **并发测试**：双会话并行驱动（A 导航 × B 点击）断言错误率 0、互不干扰（§14）。

---

## 12. 现有代码改造点映射（实施指引）

| 文件 | 改造 |
|---|---|
| `src/runtime.ts` | `tabs: Map<number, BrowserTab>` → `groups: Map<GroupKey, Group>`；`ControlMutex` → `Group` 内嵌 `GroupMutex` + 全局用户闸；`busy/busyTool/latestOp` → per-group；opLog 条目加 `session/actor` |
| `src/index.ts` | HTTP API 增改：`/state` 返回 `groups[]`（而非 tabs+全局 busy）；`switch-tab` 加 `group` 参数（shell 用）；`open/navigate/...` 的 shell 路由绑定「前台组」；新增 `switch-group` 路由 |
| `src/tools.ts` | 每个工具 execute 首行 `resolveGroupKey(exec.agent?.id)`；tab 归属校验（§6 矩阵）；`clear_data` 加 scope；`list_tabs` 返回组上下文；按 §7.1 清单注册 32 工具（新增 11：wait_for/fill_form/upload_file/bookmarks×3/history_search/downloads×2/credentials_list，get_snapshot 吸收页头信息，eval 改造为只读表达式 §7.3-9） |
| `src/tools/resolve.ts`（新） | 会话→组解析 + 血统表 |
| `src/registry.ts`（新） | GroupRegistry：组/配额/队列/生命周期 |
| `src/store/`（新） | 书签/历史/下载/会话快照四 store（v2 设计） |
| `src/shell-pages.ts` | 重写为 v4 两行 chrome（分组 TabStrip + Omnibox）+ 右下角 AI 指示 + 活动面板浮层 + 空态；删除遮罩页（v1 决定） |
| `src/electron-adapter.ts` | createView 加 `backgroundThrottling:false`；webContents 事件 `render-process-gone` 上报；下载 handler 程序化（v2）；删除 createMaskView 链路 |
| `tests/*` | 新增：resolve.spec（血统/解析/归组）、registry.spec（配额/排队/生命周期）、permission.spec（foreign-tab/archived/group-not-found）、parallel.spec（双会话并行互不干扰） |

---

## 13. UI/UX 设计规格 v4（视觉系统 · 组件 · 状态 · 动效 · 无障碍）

风格基准：**Minimalism & Swiss Style**（简洁、留白、几何、功能性、单 accent、无装饰、subtle hover 200ms）——匹配专业工具气质与本产品「面向 AI 的专业浏览器」定位。

### 13.1 视觉系统（设计 token）

| 类别 | Token | 取值原则 |
|---|---|---|
| 色板 | `--surface`（背景）/ `--surface-raised`（标签/卡片）/ `--surface-hover` / `--text` / `--text-muted` / `--border` | **全部引用产品 dsw token**（`--dsw-*`），明暗各一套；唯一例外 = 品牌 accent（brand 提供）；禁止裸 hex |
| 语义色 | `accent`（品牌/AI 活动）· `warning`（琥珀，仅用户接管态）· `danger`（红，仅破坏性确认按钮）· `success`（绿，仅动作成功勾点） | 各只出现于第 13.3 定义的位置 |
| 字体 | system-ui；基准 13px；会话名/组名 600；正文 400；时间数字 `tabular-nums` | 无外嵌字体（离线可用） |
| 间距 | 4/8/12/16/24 五档节奏 | 8px 为基础网格 |
| 圆角 | 6（控件）/ 8（地址栏）/ 12（活动面板浮层卡片） | 一致、克制 |
| 图标 | Lucide 线性 SVG；stroke 1.5px；16px（标签内/次级）/ 18px（工具栏）两档 | 禁 emoji / 禁字符符号（⟳←→× 全部换成图标） |
| 阴影 | 仅活动面板浮层 1 层 `0 4px 24px rgba(0,0,0,.12)` | 其余表面用 1px border 区分，不用投影 |
| 描边 | 1px `--border`；前台组标签条 accent 下划线 2px | 无渐变、无发光 |

### 13.2 状态语义（严格三色 + 中性）

| 状态 | 视觉 | 出现位置（仅此） |
|---|---|---|
| 空闲 | 中性灰 | 组头点、会话胶囊、AI 指示（浅灰静态「AI」） |
| AI 操作中 | **品牌色 + 呼吸**（opacity 1↔0.55，2.4s） | ① 右下角 AI 指示胶囊（**全局唯一呼吸点**）② 操作中的会话胶囊 ③ favicon 处 6px 圆点（该会话正在操作的标签） |
| 你已接管（AI 暂停） | **琥珀**（静态，不呼吸） | AI 指示胶囊变「● 已暂停」+ 活动面板琥珀条 |
| 动作结果 | 成功 ✓ 绿 / 失败 ✗ 红（仅时间线条目图标） | 活动面板动作时间线 |
| 破坏性 | 红（仅确认按钮） | 关闭标签页 / 清除数据弹窗 |

**硬规则**：其余所有元素一律中性；不新增状态色；「等待中/排队中等」用中性文字表达（如「等待标签配额」），不占用颜色通道。

### 13.3 组件规格

| 组件 | 规格 |
|---|---|
| 标签页 | 高 26px；favicon 16 + 标题 ≤18 字 + ✕（hover 才现）；圆角 6；hover `--surface-hover`；活跃 = `--surface-raised` + 底部 2px accent；AI 操作中 = favicon 右侧 6px 蓝点；宽度自适应 max 180 截断 |
| 会话段标题（组头） | 高 22px；[状态点 8px][会话名 ≤14 字 600 字重]；hover 出 `⋯`（菜单：查看此会话/折叠/重命名/关闭标签页…）；正在查看 = 会话名旁 6px 蓝点 + 该段标签条底色微亮 |
| TabStrip | 30px 行高；会话段之间 1px `--border` 分隔 + 8px 组间隙；尾端 ＋ 按钮（28×28） |
| Omnibox | 高 36px；[◀][▶][⟳] 图标组 28×28（无历史禁用 opacity .4 + tooltip 原因）｜ 地址栏圆角 8（聚焦 ring 2px accent，off-2px）| ☆ | ⋮（菜单） |
| AI 指示胶囊 | 右下角 16px 边距悬浮，**常驻**：`AI`（空闲，浅灰静态）/ `● AI 操作中 · 会话A`（呼吸）/ `● 2 个会话操作中`（呼吸）/ `● 已暂停`（琥珀）；**hover 出现「⏸ 我来操作」快捷按钮**；点击展开活动面板（见已确认决策 #17-3/4/5） |
| 活动面板 | 右侧浮层 320px；圆角 12 左；阴影 1 层；顶部会话切换器（横排胶囊 ≤5 个，溢出滚动）；中部动作时间线（条目 = 时间 tabular-nums + 图标 + 语义句 + 状态点，可点击展开详情）；底部固定 [我来操作]（接管态琥珀）/ [交给 AI] 与关闭 × |
| 菜单（⋮ / ⋯） | 圆角 8；item 高 32px；破坏性 item 红色 + 弹窗确认；键盘可达 |
| 空态 | 图标 40px 灰 + 一行 14px 说明 + 一个主按钮 |

### 13.4 动效

- 所有过渡 150–200ms ease-out；仅 4 种动画：AI 指示呼吸（2.4s）、面板滑出（200ms，带 ease-out）、加载指示（旋转）、操作权切换（颜色渐变 200ms）。
- `prefers-reduced-motion`：全部禁用（呼吸→静态点亮、面板无滑动）。

### 13.5 无障碍（硬性）

- 对比度 ≥4.5:1（正文）/ ≥3:1（图标与非文本）；明暗各验收一遍。
- 键盘：Ctrl+L 地址栏 / Ctrl+T / Ctrl+W / Ctrl+R / Alt+←→ / Ctrl+Tab 切换会话 / Ctrl+Shift+A 活动面板 / Esc 关闭浮层或交给 AI；Tab 顺序 = 视觉顺序；focus ring 全控件可见。
- 图标按钮 aria-label（tooltip 同文案）；状态点语义 = `aria-live="polite"`（仅 AI 指示与「你已接管」态）。
- 语义色不能是唯一通道：状态 = 点 + 文字 +（呼吸）三通道。

### 13.6 明暗主题

- 跟随系统（`prefers-color-scheme`）+ 设置项可锁定；两套全走 token 映射，禁止条件样式手写色值。
- 暗色专项：表面阶层用明度差（`#17181c / #1f2126 / #26282e` 层级），文字 `#e6e7ea / #a6a9b0`，边界 `#34363d`；对照 pro-rules「dark mode contrast parity」逐项验收。

---

## 14. 测试矩阵（防回归，进 CI）

| 层 | 用例 |
|---|---|
| 单元-解析 | 会话首次调用建组；子代理血统→父组；血统缺失→独立组；无 agent 身份→no-session |
| 单元-权限 | 跨组 tab → foreign-tab；list 只见本组；归档组 → group-archived；无组 → group-not-found |
| 单元-eval | 只读表达式通过；赋值/声明/new/副作用 API → eval-policy；辅助函数可用；结果超限截断；敏感值脱敏；evalEnabled=false → policy |
| 单元-配额 | 4 组上限排队；组内 8 / 全局 16 上限；FIFO；超时错误；abort 出队 |
| 单元-生命周期 | 会话结束→归档；24h 回收；手动关闭；重开恢复 |
| 单元-状态机 | 组内串行；组间并行；用户闸全暂停；释放恢复；在途不打断 |
| 集成 | 双会话并行驱动（A 导航同时 B 点击）零错误零干扰；后台组页面 JS 不节流（定时器断言） |
| E2E | 窗口分组渲染；组切换前台；活动面板会话切换器 + 动作时间线；用户操作归前台组 |
| 既有 | runtime/guard/cdp/snapshot/shots/partition 全绿 |

---

## 15. 分阶段计划（v3 修订）

### P0 —— 分组骨架 + 外壳重构 + 健壮性基线

- GroupRegistry + 会话解析（血统表第一版：无事件时独立组兜底）+ 组锁/用户闸 + 配额队列
- tools：全部现有工具接组权限矩阵 + 错误码；list_tabs 组上下文；clear_data 加 scope；takeover/release/clear_data 从 shell 动作升级为工具
- 单 shell：v4 两行 chrome（分组 TabStrip + Omnibox）+ 右下角 AI 指示 + 活动面板浮层（会话切换器 + 动作时间线）+ 空态；删遮罩；dsw token 化视觉系统；语义模板；推送替代轮询
- 下载程序化（守卫改造，消灭卡死）；backgroundThrottling=off；wait_for + get_snapshot 页头信息 + **eval 只读化（AST 校验/辅助函数/脱敏，§7.3-9）**
- 验收：双会话并行 CI 用例绿；跨组调用打不穿；UI 分组渲染正确；eval 只读校验用例绿（赋值/副作用拒绝，读 SSR 数据成功）

### P1 —— 记忆/产物工具组 + 数据层 + 生命周期完善

- 新增 11 工具（wait_for/fill_form/upload_file/bookmarks×3/history_search/downloads×2/credentials_list）+ 三 store（书签/历史/下载；会话现场由组生命周期承担）+ 历史/下载按会话标注
- 会话结束事件侦测（血统表升级）+ 归档 24h 回收 + 「重开恢复现场」联动
- 查看器 UI（书签/历史/下载）+ 组重命名 + 快捷键全量
- 验收：AI 跨会话复用书签/下载；现场恢复；生命周期全用例绿

### P2 —— 智能增强

- AI 计划预览；跨标签上下文；企业策略矩阵（工具级禁用 + UI 提示）；工具组动态激活

---

## 16. 开放问题（实现期前置验证，不阻塞设计）

1. `session/created` 与会话关闭事件的**确切事件名/payload**（血统表与归档侦测依赖；P0 用 LRU 兜底，不阻塞）。
2. `ToolRunContext.agent` 在子代理工具调用中是否为**子代理自身的 SessionId**（预计是；映射靠 §3.2 血统表）。
3. 会话标题字段（sessions store 的 title 字段名；兜底短码）。
4. `backgroundThrottling` 关闭对资源占用影响（4 组 × 8 标签上限内实测内存/CPU，配自动回收策略）。

---

## 17. 审计决策定案（2026-09-07，9 项全部按推荐确认）

> 以下 9 项已由用户确认（「按照你的推荐来」），为定案；正文如有述及以上述为准。

| # | 已确认决定 |
|---|---|
| 1 | **组现场持久化**：组清单做轻量持久化（每组标签 URL 集 + 激活标签 + 时间戳，随书签/历史/下载三 store 一并落盘）；重启后恢复为「已结束的会话」（归档态）；「重新打开同会话」时按持久化的 URL 集重建激活标签 |
| 2 | **归档资源策略**：会话结束归档瞬间销毁全部 view 仅留 URL 元数据；用户查看归档会话 = 重新加载页面（AI 仍被拒）；24h 后清元数据 |
| 3 | **胶囊文案**：「● AI 操作中 · 会话A」；多会话时「● N 个会话操作中」；点击直达活动面板 |
| 4 | **AI 指示胶囊常驻**：空闲时浅灰静态「AI」，点击始终可开活动面板（面板也是能力查看器） |
| 5 | **接管入口三处同一语义**：胶囊 hover「⏸ 我来操作」快捷按钮 + 活动面板底部主按钮 + Esc 交给 AI |
| 6 | **eval frame 参数**：整数序号（0 = 主 frame，与 get_snapshot 的 iframe 标注同源）；允许 `document.cookie` 读取，结果脱敏 |
| 7 | **未绑定组（「我的」兜底组）**：不占 AI 配额、窗口内上限 1 个、是「正在查看」候选、AI 不可见 |
| 8 | **最后标签关闭**：组删除（会话可再 open 重建）；归档会话内的最后标签关闭 → 直接回收 |
| 9 | **归档会话入口**：活动面板列出「已结束的会话」（标记 + 查看 / 关闭 / 恢复）；「重新打开同会话」= 用户在客户端会话列表重开，浏览器侧监听 session 激活事件自动接管恢复 |

**文案定案（用户拍板：不用「驾驶 / 驾驶舱」等技术腔）**：
- 「驾驶舱」→ **「活动面板」**（标题「AI 活动」）；「驾驶中」→ **「操作中」**；「AI 驾驶中」→ **「AI 操作中 · 会话A」**
- 接管按钮 → **「我来操作」** / 接管后 **「交给 AI」**；归档组 → **「已结束的会话」**；前台/后台组 → **「正在查看的会话」**（界面禁词表见 §1 术语表「UI 文案」列）

---

## 18. 实施记录（2026-09-07 完成）

- **已交付（全部落地）**：
  - 分组骨架：`registry.ts`（GroupRegistry：组状态机/组内串行锁/全局用户闸/配额 FIFO 队列带超时+可取消/生命周期/ledger 持久化）、`resolve.ts`（SessionLineage 血统表）、`errors.ts`（错误码体系）
  - 工具面 32 个：`tools.ts` 全量重写（组权限矩阵/语义模板/企业 toolGroups 策略）；eval 受限只读（`eval-policy.ts`：vendored acorn AST 校验+4 个只读辅助函数+结果脱敏截断）
  - 数据层：`store.ts`（书签/历史/下载 JSONL + 组清单 ledger + 敏感 URL 剥离 + 保留策略）
  - 健壮性：下载程序化（无对话框+冲突改名+大小上限+记录）、backgroundThrottling=false、wait_for、操作后变化摘要、页面崩溃重建、frame 级 eval、`render-process-gone` 恢复
  - v4 shell：两行 chrome + 分组 TabStrip + 右下角 AI 指示胶囊（常驻/呼吸/接管快捷）+ 活动面板浮层（会话切换器+动作时间线+我来操作/交给 AI）+ ⋮ 菜单与书签/历史/下载查看器 + 空态 + SSE 推送 + 键盘快捷键；遮罩页删除
  - 会话生命周期：归档（view 销毁留元数据）/24h 回收/重开恢复/最后标签关组/未绑定组
- **测试**：10 文件 186 用例全绿（runtime 34 / registry 29 / eval-policy 51 / store 21 / resolve 13 / 既有 38）
- **真机验证**（https://picoaide-next.kq0575.cn/ user001）：
  - UI E2E 18/18（temp/browser-v4-e2e.mjs，截图 temp/browser-v4-shots/）：登录/窗口/建标签/导航/双标签/切换/按钮态/AI 指示/活动面板/接管-释放/菜单/历史-书签-下载查看器/关标签/分组段/快捷键/隐藏-重开
  - AI 驱动 E2E 通过（temp/browser-v4-ai-e2e.mjs，截图 temp/browser-v4-ai-shots/）：真实 agent 调用 browser_open → browser_navigate → browser_get_text 闭环，面板实时呈现
- **实施中修复的真实缺陷**（均有测试锁定）：①registry 配额队列释放后不 pump 等待者+waitTimeoutMs 未接线；②archiveFor 经 destroyTab 抹掉归档元数据；③shell ⋮ 菜单打开即被 document click 关闭（stopPropagation）；④busyGroup 把前台组误判为「AI 操作中」；⑤真机环境工作区注册表预填（客户端无工作区时无法创建会话，属测试环境约束）
