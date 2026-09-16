/**
 * dsh-memory-evolve — client entry.
 *
 * Registers three session tabs ('conversation.view') — the ONLY
 * memory-management surface (the former settings-panel section was
 * removed):
 *   - 记忆 tab（memory-files）：记忆文件 + 记忆专属指南 + 待确认记忆建议
 *   - 技能 tab（skills-hub）：待确认技能建议 + 技能管理（SkillsBrowser）
 *   - 待办 tab（todos-hub）：待确认待办建议 + 四轨待办（TodoView）
 * plus the optional COI 调度 / 提示词 / 无限画板 tabs, all backed by
 * the node half's /memory-evolve/api routes. Each tab label carries a
 * red-dot pending count (🔴 记忆 (N) / 🔴 技能 (N) / 🔴 待办 (N)) while
 * suggestions/skills/todos await confirmation, refreshed by polling the
 * badge endpoint and re-registering through the deferral handle's
 * refresh().
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row lives in ui-conversation.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryTabView } from './MemoryTabView.tsx'
import { SkillsTabView } from './SkillsTabView.tsx'
import { TodosTabView } from './TodosTabView.tsx'
import { SettingsTabView } from './SettingsTabView.tsx'
import { ModelsTabView } from './ModelsTabView.tsx'
import { UiSettingsTabView } from './UiSettingsView.tsx'
import { CoIView } from './CoIView.tsx'
import { HeaderActions } from './HeaderActions.tsx'
import { AdvisorHost } from './advisor/AdvisorPanel.tsx'
import { ADVISOR_CONNECTION_RESET_EVENT } from './advisor/advisor-store.ts'
import { BroadcastView } from './BroadcastView.tsx'
import { PromptView } from './PromptView.tsx'
import { BookmarksView } from './BookmarksView.tsx'
import { SyncView } from './SyncView.tsx'
import { createBookmarkInjector } from './bookmark-injector.tsx'
import { registerCanvasTab } from './canvas-grok/index.ts'
import { createSessionFilter } from './session-filter.ts'
import { createWideBubble, createWideChat } from './wide-chat.ts'
import { createContextMeterWarn } from './context-meter-warn.ts'
import { createMermaidRenderer } from './mermaid-render.ts'
import { FEATURES_EVENT, readFeatures } from './ui-settings-features.ts'
import styles from './styles.css'
import coiStyles from './coi-styles.css'
import promptStyles from './prompt-styles.css'
import broadcastStyles from './broadcast-styles.css'
import skillBrowserStyles from './skills-browser/styles.css'
import uiSettingsStyles from './ui-settings-styles.css'
import mermaidStyles from './mermaid-render.css'
import bookmarkStyles from './bookmark-styles.css'
import advisorStyles from './advisor/advisor-styles.css'
import mobileCss from './mobile.css'
import { createInputSheetEnhance } from './mobile-input-sheet'
import { createNotificationBell } from './notification-bell.tsx'
import { createTodoTabLifecycle, RUNTIME_CONFIG_CHANGED } from './todo-tab-lifecycle.js'
import notificationStyles from './notification-styles.css'
import { setClientLocaleResolver } from '../../lib/i18n.js'

/** Locale namespace owned by this plugin. */
const NS = 'memory-evolve'

/**
 * 当前 locale 翻译函数的**模块级镜像**（apply 期写入、卸载时清空）。
 *
 * 用途只有一个：模块级导出面（`dshMobile.enhance` —— 由 dsh-android-edapp
 * 在素材化时调用）在**模块求值期**就已定型，那时 apply 还没跑，拿不到
 * apply 内的 t。因此这里存一份"调用期可读"的引用（与 lib/i18n.js 的
 * setClientLocaleResolver 同一模式）；未 apply 时回落到返回键名本身。
 */
let activeTranslate: Translate | null = null

/** Dictionary key set for the memory-evolve namespace. */
export type MemoryEvolveKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'memory-evolve': MemoryEvolveKey
  }
}

/** Simplified-Chinese dictionary (key-set source of truth). */
export const zh = {
  'tab.label': '技能管理器',
  'tab.label.alt': '技能管理器',
  'header.title': '技能管理器',
  'header.subtitle': '管理全部技能 · 自定义目录 · 禁用/启用 · 查看与编辑',
  'search.placeholder': '搜索技能名称、描述或适用场景…',
  'search.empty': '没有匹配的技能',
  'filter.all': '全部',
  'status.enabled': '可用',
  'disable': '禁用',
  'enable': '启用',
  'disabled.badge': '已禁用',
  'disabled.hint': '已禁用：不会出现在模型的技能目录中',
  'protected.badge': '系统',
  'protected.hint': '系统技能（project 来源），不可禁用',
  'toggle.failed': '操作失败：{message}',
  'manage.dirs': '管理自定义技能目录',
  'dirs.title': '自定义技能目录',
  'dirs.help': '添加包含技能的目录（支持 <目录>/<技能>/SKILL.md 或 <目录>/<技能>.md 布局）。目录永久保存在插件 state.json，重启后自动加载；与已有技能根目录重叠的路径会被拒绝。',
  'dirs.placeholder': '输入绝对路径，如 ~/.hermes/skills/…',
  'dirs.add': '添加',
  'dirs.remove': '移除',
  'dirs.empty': '还没有自定义目录',
  'dirs.missing': '目录不存在',
  'pager.prev': '上一页',
  'pager.next': '下一页',
  'pager.page': '{page} / {total} 页',
  'skills.count': '{count} 个技能',
  'roots.count': '{count} 个目录',
  'pane.skills': '技能',
  'pane.files': '文件',
  'pane.editor': '编辑',
  'no.skill.selected': '从左侧选择一个技能开始浏览',
  'no.root': '该技能没有可浏览的本地目录',
  'no.entries': '空目录',
  'no.file': '选择一个文本文件查看或编辑',
  'not.text': '不是文本文件，无法预览',
  'too.large': '文件超过读取上限（512 KiB）',
  'read.failed': '读取失败：{message}',
  'write.failed': '保存失败：{message}',
  'save': '保存',
  'saving': '保存中…',
  'saved': '已保存',
  'edit': '编辑',
  'cancel': '取消',
  'discard': '放弃',
  'dirty.hint': '有未保存的修改',
  'readonly': '只读',
  'bytes': '{size} B',
  'kib': '{size} KiB',
  'mib': '{size} MiB',
  'dir.up': '上级目录',
  'open.folder': '打开目录',
  'source.badge': '{source}',
  'invocable': '可调用',
  'when.to.use': '适用场景',
  'description': '描述',
  'resource.directory': '目录',
  'resource.url': '链接',
  'resource.opaque': '资源',
  'refresh': '刷新',
  'loading.skills': '正在加载技能…',
  'loading.dir': '加载中…',
  'tree.collapse': '折叠',
  'tree.expand': '展开',
  'path': '路径',
  'root.label': '目录',
  'editor.placeholder': '在左侧文件树中选择一个文本文件开始编辑。',
  'status.ready': '就绪',
  'status.skill': '技能',
  'status.file': '文件',
  'status.unsaved': '未保存',
  'status.saved': '已保存',
  'confirm.discard.title': '放弃未保存的修改？',
  'confirm.discard.body': '你对 {name} 的修改尚未保存，切换文件将丢失这些修改。',
  'confirm.discard.ok': '放弃修改',
  'mtime.label': '修改于 {time}',
  'open.in.new.tab': '在新标签页打开',
  'preview': '预览',
  'memoryTab.label': '记忆',
  'memoryTab.label.pending': '🔴 记忆 ({count})',
  'skillsTab.label': '技能',
  'skillsTab.label.pending': '🔴 技能 ({count})',
  'todosTab.label': '待办',
  'todosTab.label.pending': '🔴 待办 ({count})',
  'coiTab.label': 'COI调度',
  'coiTab.label.pending': '🔴 COI调度 ({count})',
  'broadcastTab.label': '会话广播',
  'broadcast.tab.guide': '指南',
  'broadcast.tab.messages': '消息',
  'broadcast.tab.rooms': '房间',
  'broadcast.tab.settings': '设置',
  'broadcast.settings.wsCoord.title': '工作区协调（ws-coord）',
  'broadcast.settings.wsCoord.desc': '同工作区多会话并行时的资源占用协调——声明要改的文件（de_ws_declare）、写后自动登记占用、写前冲突检测（软模式警告 / 硬拦截可切换）、de_ws_status 查看"谁在跑、在干什么"。以下开关只控制本子功能；「会话广播」大开关在「Memory Evolve 设置」→「配置」里。',
  'broadcast.settings.wsCoord.enabled': '启用工作区协调',
  'broadcast.settings.wsCoord.enabled.hint': '注册 de_ws_declare / de_ws_status / de_ws_release 工具 + 写前冲突检测事件监听 + 活动感知快照段。依赖「会话广播」大开关（广播关闭时本功能不可用）。默认关闭',
  'broadcast.settings.wsCoord.snapshot': '活动快照段',
  'broadcast.settings.wsCoord.snapshot.hint': '工作区活跃会话 ≥2 时，每回合快照注入一行【工作区活动】（带当前时间，含各会话在做什么）；0~1 个会话时零开销',
  'broadcast.settings.wsCoord.enforce': '硬拦截模式',
  'broadcast.settings.wsCoord.enforce.hint': '默认关（软模式：先信任 AI，冲突只警告不拦截）；打开后升级为硬拦截——写入他人占用中的文件会被工具层直接拒绝（deny），AI 看到拒绝原因自主调整',
  'broadcast.guide.intro.title': '会话广播是什么',
  'broadcast.guide.intro.body': '会话广播 = DSH 会话之间的消息通道：给其他会话发消息（AI 用 de_broadcast send 发送），对方下次生成前快照自动出现「会话广播」提示；消息按收件箱管理——主题 + 简介，全员已读后自动删除。',
  'broadcast.guide.send.title': '怎么发消息',
  'broadcast.guide.send.body': '直接对 AI 说「给 XX 会话发广播…」即可（默认一对一，收件人 = 对方的会话 ID）：',
  'broadcast.guide.send.item1': '一对一：指定接收方会话 ID（把「复制会话 ID」的结果发给对方，对方 AI 就能给你发）；',
  'broadcast.guide.send.item2': '房间：多人聊天室，跨工作目录，成员都能看到（发送给 room:<房间id>）；',
  'broadcast.guide.send.item3': '项目：该工作目录内所有会话可见（发送给 project:/绝对路径）。',
  'broadcast.guide.inbox.title': '收件箱（消息页）',
  'broadcast.guide.inbox.body': '消息列表默认只看未读的非房间消息（已读自动隐藏；房间消息进对应房间查看）：',
  'broadcast.guide.inbox.item1': '筛选：未读 / 全部 / 已读；搜索主题、发件人、内容；分页 20 条 / 页；',
  'broadcast.guide.inbox.item2': '点「展开全文」看完整内容；红色「删除」= 超管删除（对所有人不可见）；',
  'broadcast.guide.inbox.item3': '一对一消息全部接收方已读后自动删除（已消费，不占列表）。',
  'broadcast.guide.room.title': '房间页：多人协作聊天室',
  'broadcast.guide.room.body': '房间 = 多人协作聊天室：',
  'broadcast.guide.room.item1': '展开房间看成员在线状态：🟢 running = 正在生成（可等它 / 它回合内可见），⚪ idle / unknown = 已结束回合或未记录（不要傻等）；',
  'broadcast.guide.room.item2': '房间消息与收件箱同款筛选 / 搜索 / 分页；创建者可踢人、解散房间（触发系统通知）；',
  'broadcast.guide.room.item3': '已解散房间保留记录可追溯，成员不能再加入 / 发消息。',
  'broadcast.guide.alias.title': '会话别名：一眼认出是谁',
  'broadcast.guide.alias.body': '给会话设置友好名（≤10 字）——快照、列表、消息里都显示别名（短 ID），一眼认出是谁：',
  'broadcast.guide.alias.item1': '顶部「我的会话」行：复制会话 ID / 复制别名，把结果发给对方就能开聊；',
  'broadcast.guide.alias.item2': '会话页右上角 ⧉ 复制会话ID / ✎ 别名 按钮也可设置。',
  'broadcast.guide.switch.title': '开关',
  'broadcast.guide.switch.body': '会话广播默认关闭：在「Memory Evolve 设置」Tab 的「配置」里打开「会话广播」开关，刷新后本 Tab 出现。',
  'broadcast.guide.wscoord.title': '工作区协调：多人并行不打架',
  'broadcast.guide.wscoord.body': '同一项目多个会话并行改代码时，用「设置」页的工作区协调避免互相覆盖：',
  'broadcast.guide.wscoord.item1': '开工前让 AI「声明一下我要改哪些文件」（de_ws_declare）——其他人（及其 AI）能看到谁在改什么；',
  'broadcast.guide.wscoord.item2': '写前冲突检测：软模式先警告（默认）；可切硬拦截——写入他人占用中的文件会被直接拒绝；',
  'broadcast.guide.wscoord.item3': '「活动」概览（de_ws_status）随时看谁在跑、在干什么；开关在「设置」页（依赖「会话广播」大开关）。',
  'broadcast.mySessionId': '我的会话 ID',
  'broadcast.copyId': '复制',
  'broadcast.copied': '已复制',
  'broadcast.loading': '加载中…',
  'broadcast.refresh': '刷新',
  'broadcast.messages.empty': '（暂无消息）',
  'broadcast.messages.sender': '来自',
  'broadcast.messages.to': '收件人',
  'broadcast.messages.direct': '私信',
  'broadcast.messages.room': '房间',
  'broadcast.messages.project': '项目',
  'broadcast.messages.unread': '未读',
  'broadcast.messages.long': '长内容',
  'broadcast.message.expand': '展开全文',
  'broadcast.message.collapse': '收起',
  'broadcast.message.delete': '删除',
  'broadcast.message.deleteConfirm': '删除这条消息？（超管操作，消息对所有人不可见）\n\n{subject}',
  'broadcast.message.deleted': '已删除',
  'broadcast.copyAlias': '复制别名',
  'broadcast.msg.unread': '未读',
  'broadcast.msg.read': '已读',
  'broadcast.filter.unread': '未读',
  'broadcast.filter.all': '全部',
  'broadcast.filter.read': '已读',
  'broadcast.searchPh': '搜索主题/发件人/内容…',
  'broadcast.pagePrev': '上一页',
  'broadcast.pageNext': '下一页',
  'broadcast.pageInfo': '{page}/{total} 页',
  'broadcast.room.detail': '详情',
  'broadcast.room.messages': '房间消息',
  'broadcast.room.messages.empty': '（暂无房间消息）',
  'broadcast.messages.roomInRooms': '房间消息请在「房间」页进入对应房间查看',
  'broadcast.rooms.empty': '（暂无房间）',
  'broadcast.roomSearchPh': '搜索房间名…',
  'broadcast.roomStatus.all': '全部',
  'broadcast.roomStatus.active': '活跃',
  'broadcast.roomStatus.dissolved': '已解散',
  'broadcast.roomDays.0': '全部时间',
  'broadcast.roomDays.7': '最近7天',
  'broadcast.roomDays.30': '最近30天',
  'broadcast.room.status.active': '活跃',
  'broadcast.room.status.idle': '空闲',
  'broadcast.room.status.dissolved': '已解散',
  'broadcast.room.online': '{online}/{total} 在线',
  'broadcast.room.members': '成员',
  'broadcast.room.kick': '踢出',
  'broadcast.room.kickConfirm': '踢出成员 {member}？（将发送系统通知，该会话失去房间访问）',
  'broadcast.room.dissolve': '解散',
  'broadcast.room.dissolveConfirm': '解散房间「{name}」？（软删除：记录保留可追溯，成员收到系统通知，之后无法加入/发消息）',
  'broadcast.room.dissolved': '已解散',
  'broadcast.room.copyId': '复制房间 id',
  'broadcast.room.lastActive': '最后活动',
  'broadcast.room.created': '创建于',
  'broadcast.room.presence.unknown': 'unknown · 无活动记录',
  'header.copySessionId': '⧉ 复制会话ID',
  'header.copySessionId.done': '✓ 已复制',
  'header.copySessionId.title': '复制当前会话 ID（发给其他会话：告诉对方 AI 你的会话 ID，让它用 de_broadcast 给你发广播）',
  'header.setAlias': '✎ 别名',
  'header.setAlias.title': '设置会话别名（≤10 字）——快照/广播面板/消息中显示为你的友好名称',
  'header.setAlias.placeholder': '输入别名（≤10 字）',
  'header.setAlias.save': '保存',
  'header.setAlias.clear': '清除',
  'header.setAlias.saved': '别名已保存',
  'header.setAlias.cleared': '别名已清除',
  'advisor.header.toggle': '会话评审',
  'advisor.header.toggle.title': '打开或折叠会话评审悬浮面板',
  'promptTab.label': '提示词',
  'promptTab.label.active': '🔴 提示词 ({count})',
  'settingsTab.label': 'Memory Evolve 设置',
  'settingsTab.label.pending': '🔴 Memory Evolve 设置',
  'settingsTab.feature.guide': '指南',
  'settingsTab.feature.config': '配置',
  'settingsTab.feature.version': '版本',
  // —— 版本检测与更新（一期）——
  'version.current': '当前版本',
  'version.latest': '最新版本',
  'version.statusLabel': '状态',
  'version.status.latest': '已是最新',
  'version.status.outdated': '有新版本',
  'version.status.no-release': '暂无发布版本',
  'version.status.unsupported': '不支持自动检测',
  'version.status.unknown': '未知',
  'version.loading': '检查中…',
  'version.lastError': '上次检测失败',
  'version.checkTime': '上次检查',
  'version.checking': '检查中…',
  'version.checkNow': '检查更新',
  'version.updating': '更新中…',
  'version.updateNow': '更新到 {tag}',
  'version.restart.title': '等待重启',
  'version.restart.hint': '新版本代码已写入磁盘，请先重启 dsh web，再刷新浏览器（仅刷新页面不会加载新代码）。',
  'version.releaseNotes': '发布说明',
  'version.unsupported.hint': '当前安装方式不支持自动检测（需要 git clone 安装）。请用 `git clone git@github.com:csyangwen/dsh-memory-evolve.git` 重新安装后使用。',
  // 状态说明码（服务端只下发 noteCode，文案在前端映射，CodeX 复审 P2-4）。
  'version.note.no-release': '远端仓库暂无发布版本（v0.x.y tag）。',
  'version.note.outdated': '检测到新版本，可在下方点击更新（更新需重启 dsh web 生效）。',
  'version.note.latest-exact': '本地已是最新发布版本。',
  'version.note.latest-contained': '本地已包含发布版本（开发轨领先或已同步）。',
  'version.note.unsupported': '插件目录不是 git 仓库或 git 不可用。',
  // 更新/检测错误码文案（CodeX 复审 P1-5/P2-4：错误统一字典映射）。
  'version.error.bad-request': '请求参数错误：{message}',
  'version.error.dirty': '更新被拒绝：{message}',
  'version.error.busy': '更新被拒绝：{message}',
  'version.error.target-changed': '目标版本已变化：{message}',
  'version.error.untrusted': '更新被拒绝：{message}',
  'version.error.unsupported': '不支持自动检测：{message}',
  'version.error.error': '更新失败：{message}',
  'version.error.network': '网络请求失败：{message}',
  'version.error.unknown': '未知错误',
  'memoryTab.feature.guide': '指南',
  'memoryTab.feature.suggestions': '待确认记忆建议',
  'skillsTab.feature.guide': '指南',
  'skillsTab.feature.skills': '待确认技能建议',
  'skillsTab.feature.skillBrowser': '技能管理',
  'todosTab.feature.guide': '指南',
  'todosTab.feature.todoSuggestions': '待确认待办管理',
  'todosTab.feature.todo': '待办',
  // 模型设置 Tab（models-hub）：表格展示 DSH 供应商/模型 + 每模型
  // 启用/备注/可用思考等级配置（对应 de_models 工具的 Web 数据面）：
  'modelsTab.label': '模型设置',
  'modelsTab.feature.models': '模型设置',
  'modelsTab.feature.guide': '指南',
  'modelsTab.guide.what.title': '模型设置是什么',
  'modelsTab.guide.what.body': '以表格形式一览 DSH 的全部供应商与模型，并为每个模型维护插件侧配置（启用状态、备注、思考等级）——所有配置归属本插件（models.json），不修改 DSH 配置、不与其他插件耦合：',
  'modelsTab.guide.what.item1': '表格列：启用开关、供应商（含 DSH 激活状态）、模型（名称 + ID）、上下文 / 输出容量、思考等级、图片输入标记（🖼）、备注；支持搜索与「显示思考等级」切换；',
  'modelsTab.guide.what.item2': '每模型可设置：启用 / 禁用（插件口径的可用性标记，不改变 DSH 实际路由）、备注、是否支持思考、可用思考等级、推荐思考等级、自定义等级；',
  'modelsTab.guide.what.item3': '配置写入即持久化（<memoryDir>/models.json），重启不丢。',
  'modelsTab.guide.config.title': '每模型配置项',
  'modelsTab.guide.config.body': '展开一行（「配置等级」）即可编辑思考相关配置：',
  'modelsTab.guide.config.item1': '启用 / 禁用：决定 de_models 工具默认列出的可用模型（默认全部启用）；',
  'modelsTab.guide.config.item2': '支持思考：关闭后该模型不允许思考（仅 off 等级可用）；',
  'modelsTab.guide.config.item3': '推荐思考等级：默认「自动」跟随模型自身推荐，可手动指定任一可用等级；',
  'modelsTab.guide.config.item4': '可用思考等级：勾选哪些等级允许使用（默认全部）；可添加自定义等级（如 ultra），移除自定义等级；',
  'modelsTab.guide.config.item5': '图片输入能力：模型显式声明支持图片输入时显示「🖼 图片输入」标记（来自 DSH 模型能力元数据，只读展示）；未声明 = 未知，不显示。',
  'modelsTab.guide.tool.title': 'de_models 工具（给 AI 用）',
  'modelsTab.guide.tool.body': '本模块同时注册 de_models 工具，AI 可以直接查询当前可用模型（接口）清单：',
  'modelsTab.guide.tool.item1': '默认只返回「启用」的模型（all=true 查看全部含禁用），可按供应商过滤；',
  'modelsTab.guide.tool.item2': '每个模型返回：是否启用、DSH 是否激活、是否支持图片输入（supportsImage：true / false / null=未知）、是否支持思考、可用思考等级（含推荐与自定义）、备注。',
  'modelsTab.guide.switch.title': '开关',
  'modelsTab.guide.switch.body': '模型设置默认开启；可在「Memory Evolve 设置」Tab 的「配置」里独立关闭（与其他模块同款开关）——关闭后本 Tab 与 de_models 工具隐藏，配置数据保留。',
  'modelsTab.searchPh': '搜索供应商、模型或备注…',
  'modelsTab.showReasoning': '显示思考等级',
  'modelsTab.refresh': '刷新',
  'modelsTab.loading': '加载中…',
  'modelsTab.count': '共 {total} 个模型 · {enabled} 个启用',
  'modelsTab.loadFailed': '加载失败：{message}',
  'modelsTab.empty': '（暂无模型）',
  'modelsTab.enabled': '启用',
  'modelsTab.enable': '启用',
  'modelsTab.disable': '禁用',
  'modelsTab.provider': '供应商',
  'modelsTab.model': '模型',
  'modelsTab.capacity': '上下文/输出',
  'modelsTab.reasoning': '思考等级',
  'modelsTab.note': '备注',
  'modelsTab.notePh': '输入备注…',
  'modelsTab.dormant': '未激活',
  'modelsTab.thinking': '支持思考',
  'modelsTab.thinkingHint': '关闭后该模型不允许思考（仅 off 等级可用）',
  'modelsTab.thinkingOff': '不支持思考',
  'modelsTab.supportsImage': '🖼 图片输入',
  'modelsTab.supportsImageHint': '该模型显式声明支持图片输入（来自 DSH 模型能力元数据 inputModalities）',
  'modelsTab.recommendedLevel': '推荐思考等级',
  'modelsTab.recommendedAuto': '自动（跟随模型推荐）',
  'modelsTab.levelsNone': '全部禁用',
  'modelsTab.editLevels': '配置等级',
  'modelsTab.closeEditor': '收起',
  'modelsTab.editorTitle': '可用思考等级（勾选 = 允许该等级；推荐来自模型能力）',
  'modelsTab.recommended': '推荐',
  'modelsTab.addLevel': '添加',
  'modelsTab.removeLevel': '移除',
  'modelsTab.levelIdPh': '等级 ID（如 ultra）',
  'modelsTab.levelNamePh': '显示名（如 Ultra）',
  'modelsTab.save': '保存',
  'modelsTab.saving': '保存中…',
  'modelsTab.cancel': '取消',
  // Web UI 设置 Tab（ui-settings-hub）：「综合」= 各功能独立小开关（用户
  // 拍板：功能未定型前不精确分类，统一收「综合」）；「指南」= 精简简介
  // （用户拍板：不细讲每个小功能怎么用）。真正的功能注入是全局 DOM 增强
  // （session-filter.ts / wide-chat.ts），开关经事件广播由 apply 同步，
  // 不依赖本 Tab 打开。
  'uiSettingsTab.label': 'Web UI 设置',
  'uiSettingsTab.feature.mixed': '综合',
  'uiSettingsTab.feature.guide': '指南',
  'uiSettingsTab.features.title': '功能开关',
  'uiSettingsTab.features.help': '每个功能都有独立的小开关，**默认全部关闭**、由你主动开启，改动即时生效（功能未定型前统一收在「综合」，后续再分类）。',
  'uiSettingsTab.guide.what.title': 'Web UI 设置是什么',
  'uiSettingsTab.guide.what.body': '给 DSH web 界面做样式级小功能——不改框架源码，纯客户端注入（CSS + DOM 增强），随 DSH 更新不掉功能；后期扩展（主题更换等）都收进本模块。',
  'uiSettingsTab.guide.switch.title': '开关',
  'uiSettingsTab.guide.switch.body': '模块开关在「Memory Evolve 设置」Tab 的「配置」里（默认关闭）；本 Tab「综合」里是各功能的独立小开关（默认也全部关闭，由你主动开启）。',
  'uiSettingsTab.guide.features.title': '功能介绍',
  'uiSettingsTab.guide.features.body': '每个功能在「综合」页有独立小开关，开启后即时生效：',
  'uiSettingsTab.guide.features.item1': '会话筛选：左侧会话列表只显示进行中的会话，纯空闲的折叠隐藏，可一键切回全部；',
  'uiSettingsTab.guide.features.item2': '对话区加宽：中间对话区域从约一半宽度扩大到约 95%，长消息看着更舒服；',
  'uiSettingsTab.guide.features.item3': '消息气泡加宽：用户消息框从默认 525px 上限扩大到约 80% 宽（配合上一条效果更明显）；',
  'uiSettingsTab.guide.features.item4': '上下文占用提醒：输入框圆环 ≥30% 变黄、≥40% 变红，提醒你该打书签 / 开新会话了；',
  'uiSettingsTab.guide.features.item5': 'Mermaid 图表渲染：消息里的 mermaid 代码块自动渲染成图表，渲染失败自动退回代码块。',
  // 功能开关行文案（「综合」子 tab 渲染）。
  'uiSettings.feature.sessionFilter': '会话筛选',
  'uiSettings.feature.sessionFilter.hint': '左侧会话列表只显示进行中的会话（纯 idle 折叠，可一键切回全部）；开启后才出现筛选条',
  'uiSettings.feature.wideChat': '对话区加宽',
  'uiSettings.feature.wideChat.hint': '把中间的对话历史/输入框区域从约一半宽度扩大到右侧约 95%（与上方 Tab 导航条对齐）',
  'uiSettings.feature.wideBubble': '消息气泡加宽',
  'uiSettings.feature.wideBubble.hint': '用户提交后的消息框从默认上限 525px 扩大到占中间内容框约 80%（配合「对话区加宽」效果更明显）',
  'uiSettings.feature.contextWarn': '上下文占用提醒',
  'uiSettings.feature.contextWarn.hint': '输入框右下侧的上下文使用量圆环：占用超过 30% 变黄、超过 40% 变红提醒，低于阈值恢复原色',
  'uiSettings.feature.mermaidRender': 'Mermaid 图表渲染',
  'uiSettings.feature.mermaidRender.hint': '把消息里的 mermaid 代码块渲染成图表（DSH 界面本身不渲染 mermaid）；首次见到图时才加载渲染引擎，PC 与手机端同时生效，渲染失败自动退回代码块',
  // 筛选条按钮文案（session-filter.ts 注入 DOM 用）。
  'uiSettings.filter.on': '仅进行中',
  'uiSettings.filter.off': '全部',
  'uiSettings.running.label': '{count} 运行中',
  'uiSettings.ungrouped': '未分组',
  // 会话书签（独立子模块，bookmarkEnabled 默认关）：
  'syncTab.label': '记忆同步',
  'syncTab.loading': '加载中…',
  'syncTab.loadFailed': '状态加载失败：{message}',
  'syncTab.tab.project': '本项目',
  'syncTab.tab.global': '全局记忆',
  'syncTab.tab.remote': '共享记忆库',
  'syncTab.section.project': '本项目记忆（KEY + 项目日志 + 归档 + 项目待办）',
  'syncTab.section.global': '全局记忆（设备级，与项目无关）',
  'syncTab.section.remote': '共享记忆库（设备级配置）',
  'syncTab.project.mode.off': '不启用（纯本地）',
  'syncTab.project.mode.off.desc': '项目记忆只留在本机，不建仓库、不生成身份证，也不与任何远端对账',
  'syncTab.project.mode.main': 'A 模式：主代码仓库（零配置）',
  'syncTab.project.mode.main.desc': '项目记忆放进代码仓库的专属分支（不污染代码）。**代码仓库公开 = 记忆也公开**',
  'syncTab.project.mode.shared': 'B 模式：共享记忆仓库',
  'syncTab.project.mode.shared.desc': '项目记忆放进共享记忆仓库的专属分支，记忆与代码彻底隔离',
  'syncTab.project.mode.shared.needRemote': '共享记忆库未启用——已切换到「共享记忆库」，请先启用并保存仓库地址',
  'syncTab.status.title': '当前记忆远端',
  'syncTab.status.disabled': '未启用——打开上方「本项目同步」开关开始',
  'syncTab.status.notInit': '已启用，但当前项目尚未初始化——点上方 A/B 模式完成初始化',
  'syncTab.status.remoteKind': '记忆远端：{kind}',
  'syncTab.status.remoteKindMain': '主代码仓库',
  'syncTab.status.remoteKindShared': '共享记忆仓库',
  'syncTab.status.remoteKindNone': '未挂载',
  'syncTab.status.originUrl': '远端地址：{url}',
  'syncTab.status.branch': '远端分支：{branch}',
  'syncTab.status.counts': '未推送 {pending} 条 · 落后远端 {behind} 个提交 · 冲突 {conflicts} 条',
  'syncTab.status.migrate': '发现旧记忆目录：{dir}——点「开始同步」会自动迁移',
  'syncTab.global.title': '全局记忆',
  'syncTab.global.uncommitted': '未推送 {n} 个轨（工作树变更 + 已提交未推送）',
  'syncTab.global.trackMemory': '全局记忆（MEMORY.md）',
  'syncTab.global.trackUser': '用户档案（USER.md）',
  'syncTab.global.trackDaily': '每日日志（daily/*.md）',
  'syncTab.global.trackTodo': '待办：生活/工作/每日（TODOS-*.md）',
  'syncTab.global.hint': '全局记忆（用户档案/每日日志/待办）不属于任何项目，所有项目共用这一套开关；推送永远需你显式点击',
  'syncTab.global.sync': '拉取合并',
  'syncTab.global.push': '推送',
  'syncTab.global.notInit': '共享记忆库未启用——全局记忆不可用，请到「共享记忆库」页启用并保存地址',
  'syncTab.remote.desc': '这是全设备的统一记忆库：项目 B 模式与全局记忆（用户档案/每日日志/待办）都引用它，启用并保存地址一次即可。',
  'syncTab.remote.mode.off': '不启用',
  'syncTab.remote.mode.off.desc': '项目 B 模式与全局记忆均不可用；已同步的数据与地址保留',
  'syncTab.remote.mode.on': '启用',
  'syncTab.remote.mode.on.desc': '项目 B 模式与全局记忆可用；先保存仓库地址',
  'syncTab.remote.disable': '停用共享记忆库',
  'syncTab.remote.current': '当前共享记忆库：{url}',
  'syncTab.remote.placeholder': '粘贴共享记忆仓库地址（如 ssh://git@.../dsh-memories.git）',
  'syncTab.remote.save': '启用并保存',
  'syncTab.remote.modify': '修改并保存',
  'syncTab.remote.switchHint': '停用只关掉共享记忆库（项目 B 与全局记忆不可用），已同步数据与地址保留，可随时重新启用。',
  'syncTab.actions.sync': '拉取合并',
  'syncTab.actions.push': '推送',
  'syncTab.actions.nothingToSync': '没有可同步的内容——先启用本项目或全局轨',
  'syncTab.conflicts.title': '待处理冲突（{count} 条——两台设备改了同一条记忆）',
  'syncTab.conflicts.titleGlobal': '全局{track}：待处理冲突（{count} 条——两台设备改了同一条记忆）',
  'syncTab.conflicts.base': '共同版本',
  'syncTab.conflicts.ours': '本机版本',
  'syncTab.conflicts.theirs': '远端版本',
  'syncTab.conflicts.oursBtn': '采用本机',
  'syncTab.conflicts.theirsBtn': '采用远端',
  'syncTab.conflicts.bothBtn': '两者都要',
  'syncTab.footnote': '写记忆照常实时落盘（完全不碰 Git）；同步是攒一批合一次。冲突标记永不落盘，解决后自动提交。',
  'bookmarkTab.label': '书签',
  'bookmark.tab.list': '列表',
  'bookmark.tab.guide': '指南',
  'bookmark.list.title': '本会话书签',
  'bookmark.list.help': '点击书签跳转到对应轮次；轮尾 ☆ 打星、★ 已打星（可改名/删除）；列表可搜索、可从此轮创建分支（中间轮的官方分支按钮同样已被 Memory Evolve 接管）。',
  'bookmark.refresh': '刷新',
  'bookmark.loading': '加载中…',
  'bookmark.empty': '（暂无书签——在对话轮尾点 ☆ 打星）',
  'bookmark.defaultLabel': '轮次 {n}',
  'bookmark.turn': '轮次 {n}',
  'bookmark.prompt.create': '书签名称（可改）：',
  'bookmark.prompt.rename': '新名称：',
  'bookmark.confirm.delete': '删除书签「{label}」？',
  'bookmark.noSession': '无法确定当前会话（请刷新页面后重试）',
  'bookmark.search.placeholder': '搜索书签…',
  'bookmark.search.empty': '（没有匹配的书签）',
  'bookmark.star.title.off': '☆ 打书签（Memory Evolve 会话书签）',
  'bookmark.star.title.on': '★ 已打书签：{label}（Memory Evolve，点击改名/删除）',
  'bookmark.menu.rename': '改名',
  'bookmark.menu.delete': '删除',
  'bookmark.action.jump': '跳转',
  'bookmark.action.fork': '分支',
  'bookmark.action.rename': '改名',
  'bookmark.action.delete': '删除',
  'bookmark.fork.title': '由此轮创建分支（Memory Evolve 增强）',
  'bookmark.fork.confirm': '官方仅支持从最后一条消息创建分支。是否仍要从这一轮（{n}）创建分支？（Memory Evolve 增强）',
  'bookmark.fork.working': '正在创建分支会话…',
  'bookmark.fork.ok': '已创建新会话 {id}（可在左侧会话列表查看）',
  'bookmark.jump.hint': '点击跳转到该轮',
  'bookmark.jumping': '正在定位…',
  'bookmark.jump.ok': '已定位到「{label}」',
  'bookmark.jump.notFound': '未找到「{label}」对应消息（可能已被压缩/不在当前历史窗口）',
  'bookmark.jump.noChat': '找不到「对话」Tab，无法跳转',
  'bookmark.renamed': '已改名',
  'bookmark.deleted': '已删除',
  'bookmark.error': '失败：{message}',
  'bookmark.guide.what.title': '会话书签是什么',
  'bookmark.guide.what.body': '给对话的每一轮打上星标，之后从列表一键跳回那一轮；也能从任意一轮直接创建官方分支会话——从中间某个决策点「另起一条线」。数据存在插件侧边文件（不碰官方会话日志）；中间轮的官方分支按钮已被本插件接管（点击弹确认后走官方 fork 通道）。',
  'bookmark.guide.star.title': '怎么打星',
  'bookmark.guide.star.body': '每个已完成轮尾有 ☆ 按钮：点一下取名（默认「轮次 N」）即打星；★ 表示已打星，再点可改名或删除。小图标不干扰 Copy / Branch。',
  'bookmark.guide.list.title': '列表与跳转',
  'bookmark.guide.list.body': '本 Tab 列出当前会话全部书签（标签、轮次、时间、摘要）。点击跳转：自动切回「对话」Tab 定位到那一轮；若目标在未加载的历史窗口，会先拉更早消息再定位。',
  'bookmark.guide.switch.title': '开关',
  'bookmark.guide.switch.body': '默认关闭；在「Memory Evolve 设置」→「配置」打开「会话书签」。关闭后星标与本 Tab 隐藏，已存书签文件保留。',
  'panel.guide.bookmark.title': '会话书签',
  'panel.guide.bookmark.desc': '给每轮打星标记，列表一键跳回，并支持从任意轮创建官方分支（含接管官方中间轮分支按钮）。独立开关，默认关。',
  'panel.config.bookmarkEnabled': '会话书签',
  'panel.config.bookmarkEnabled.hint': '启用会话书签：每个已完成轮尾出现 ☆ 星标按钮 + 「书签」Tab 列表与跳转；支持从任意轮创建官方分支（列表「分支」按钮，或直接点官方分支按钮——中间轮会被接管并弹确认）。数据存在 <memoryDir>/session-bookmarks.json（按会话隔离，按轮 seq 定位）。**独立子模块**（默认关闭，纯 UI + 宿主 API，不注册 AI 工具）；关闭时星标与 Tab 隐藏，数据文件保留。',
  'panel.config.todoEnabled': '待办功能',
  'panel.config.todoEnabled.hint': '启用 dtodo 工具、待办 Tab 和到期提醒。关闭后立即隐藏 Tab、停止待办写入；现有待办数据和同步轨保持不变。',
  // 以下键保留兼容（旧 memory tab 合并布局的遗留，新 UI 不再引用）：
  'memoryTab.feature.config': '配置',
  'memoryTab.feature.todoSuggestions': '待确认待办建议',
  'memoryTab.feature.skills': '待确认技能建议',
  'memoryTab.feature.skillBrowser': '技能管理',
  'memoryTab.feature.todo': '待办',
  // 记忆 Tab 专属指南（「指南」子 Tab，详细介绍记忆功能本身）：
  'memoryTab.guide.tracks.title': '五轨记忆：AI 的长期工作记忆',
  'memoryTab.guide.tracks.body': '记忆按「该给谁看」分成五层，注入范围随层级收窄、互不污染——该注入的自动注入，不该占上下文的按需读取：',
  'memoryTab.guide.tracks.item1': '用户档案（user）：你是谁——偏好、习惯、沟通方式。每个会话都注入，不用重复介绍；',
  'memoryTab.guide.tracks.item2': '长期记忆（memory）：全局事实——环境、工具、通用惯例。每个会话都注入；',
  'memoryTab.guide.tracks.item3': '项目关键记忆（key）：当前项目的约定、决策、架构、踩坑。只注入当前项目会话，并按 git 分支过滤——不同分支各用各的约定；',
  'memoryTab.guide.tracks.item4': '项目日志（project）：当前项目的进展流水。不注入，AI 需要时按需读取，历史可追溯；',
  'memoryTab.guide.tracks.item5': '今日日志（daily）：按天记录的当天进展。不注入，AI 需要时读取——相当于每天的「工作日报」。',
  'memoryTab.guide.files.title': '文件页签：直接看记忆原文',
  'memoryTab.guide.files.body': '本 Tab 直接预览 AGENTS.md（全局规则）与全部记忆文件。文件页签是只读的——修改请让 AI 用 memory 工具、或在本页操作，避免手动破坏 § 分隔格式导致记忆解析错乱：',
  'memoryTab.guide.files.item1': '美观视图：每条记忆以卡片展示（时间 / 分支 / 标签徽标 + 正文），可搜索过滤，也可切换纯文本视图看原文；',
  'memoryTab.guide.files.item2': 'KEY 页签可手动添加长期项目事实（可同时指定对哪些 git 分支生效），保存后下一轮自动注入；',
  'memoryTab.guide.files.item3': '每条记忆可编辑（写入需确认）、删除（按完整条目精确匹配，杜绝误删）、归档 / 移回主记忆。',
  'memoryTab.guide.branch.title': 'git 分支感知：不同分支，不同约定',
  'memoryTab.guide.branch.body': '同一项目不同分支的约定可能完全不同（如 main 用一套规范、dev 用另一套），项目级记忆全程感知当前分支：',
  'memoryTab.guide.branch.item1': 'key 条目可带分支范围标记（无标记 = 全部分支可见）；注入时只注入「无标记」+「覆盖当前分支」的条目；',
  'memoryTab.guide.branch.item2': '日志条目自动带来源分支标记（[git 分支名]），跨分支回顾不会张冠李戴。',
  'memoryTab.guide.maintain.title': '编辑与维护：记忆的日常打理',
  'memoryTab.guide.maintain.body': '记忆的维护操作都在本 Tab 完成：',
  'memoryTab.guide.maintain.item1': '编辑正文：只改内容，时间戳 / 分支 / 标签由程序维护；',
  'memoryTab.guide.maintain.item2': '删除：按完整条目精确匹配（不会误删包含关系的长条目），删除不可恢复；',
  'memoryTab.guide.maintain.item3': '归档 / 移回：低频记忆移出主轨不再注入、保留备查，需要时可随时移回。',
  'memoryTab.guide.suggestions.title': '待确认记忆建议：AI 只提议，你拍板',
  'memoryTab.guide.suggestions.body': '后台审查自动提炼「值得记住的信息」，先进待确认队列——AI 不会擅自往记忆里写东西：',
  'memoryTab.guide.suggestions.item1': '采纳：可先修改文本、可选目标轨（长期记忆 / 用户档案 / 项目关键记忆），写入后随快照注入；',
  'memoryTab.guide.suggestions.item2': '归档：不注入、仅保留备查，需要时可移回主记忆；拒绝：直接丢弃。',
  'memoryTab.guide.confirm.title': '确认制：为什么必须你点头',
  'memoryTab.guide.confirm.body': '记忆写入会真实改变 AI 的行为——写进去就进入上下文、影响后续所有回复。所以一律先经你确认，这是记忆进化的把关环节：你说了算。',
  // 技能 Tab 专属指南（「指南」子 Tab，详细介绍技能功能本身）：
  'skillsTab.guide.what.title': '技能是什么：给 AI 的方法论手册',
  'skillsTab.guide.what.body': '技能 = 一份给 AI 看的方法论文档（SKILL.md：name + description + 操作步骤）。它会注入每个会话的系统提示词——AI 遇到同类任务，直接按你的流程执行，不用重新摸索：',
  'skillsTab.guide.what.item1': '技能库默认在 ~/.agents/skills（每个技能一个目录）；',
  'skillsTab.guide.what.item2': 'DSH 还会扫描项目技能、内置技能与自定义目录——全部在本 Tab 可见、可管理。',
  'skillsTab.guide.how.title': '技能怎么沉淀',
  'skillsTab.guide.how.body': '把「踩过的坑、好用的流程」固化成技能，主要有两条路：',
  'skillsTab.guide.how.item1': '后台审查自动创建：AI 发现反复出现的经验会创建新技能，先进「待确认技能建议」，你采纳后移入技能库；',
  'skillsTab.guide.how.item2': 'skill_manage 工具：直接对 AI 说「把这个流程存成技能」，它创建 / 更新技能；',
  'skillsTab.guide.how.item3': '创建保持克制：只建「多次踩坑、难度大、后续复用」的技能——技能会注入每个会话，影响上下文。',
  'skillsTab.guide.pending.title': '待确认技能建议',
  'skillsTab.guide.pending.body': '审查自动创建的新技能在这里等你确认：',
  'skillsTab.guide.pending.item1': '采纳：移入技能库（~/.agents/skills），随系统提示词注入，所有会话立即可用；',
  'skillsTab.guide.pending.item2': '拒绝：丢弃该技能。',
  'skillsTab.guide.manager.title': '技能管理：浏览、编辑、自定义目录',
  'skillsTab.guide.manager.body': '完整技能管理器（三栏：技能列表 / 目录树 / 文件查看编辑）：',
  'skillsTab.guide.manager.item1': '全部技能按来源分层展示（用户 user-* / 自定义 custom / 内置 bundled / 项目 project-*），可搜索与筛选；',
  'skillsTab.guide.manager.item2': '自定义技能目录：添加 / 移除任意技能目录（<目录>/<技能>/SKILL.md 或 <目录>/<技能>.md 布局）；',
  'skillsTab.guide.manager.item3': '文件浏览与编辑：目录树 + 文本查看 / 编辑（限技能目录范围内，越界 / 二进制 / 超大文件会被拒绝）；',
  'skillsTab.guide.manager.item4': '禁用列表与自定义目录持久保存，重启后自动恢复。',
  'skillsTab.guide.disable.title': '禁用 / 启用：把不想要的技能藏起来',
  'skillsTab.guide.disable.body': '一键禁用可以把技能从模型的技能目录中移除（模型不再看到、skill 工具拒绝加载）：',
  'skillsTab.guide.disable.item1': '可随时重新启用，选择持久保存；',
  'skillsTab.guide.disable.item2': '系统技能（project 来源）结构性不可禁用。',
  'skillsTab.guide.dirs.title': '自定义技能目录',
  'skillsTab.guide.dirs.body': '在「技能管理」里直接添加 / 移除你自己的技能目录（如 ~/.hermes/skills），与已有技能根重叠的路径会被拒绝；永久保存、重启后自动加载。',
  'skillsTab.guide.restraint.title': '创建纪律：克制才有效',
  'skillsTab.guide.restraint.body': '技能会注入每个会话的系统提示词、影响上下文与缓存——创建必须克制：',
  'skillsTab.guide.restraint.item1': '只创建「多次尝试仍难解决、难度大、后续可能多次复用」的技能；',
  'skillsTab.guide.restraint.item2': '一次性、简单任务不创建技能。',
  // 待办 Tab 专属指南（「指南」子 Tab，详细介绍待办功能本身）：
  'todosTab.guide.tracks.title': '四轨待办：事情各归其位',
  'todosTab.guide.tracks.body': '待办按目标分四轨，与记忆系统同构：',
  'todosTab.guide.tracks.item1': '生活（life）：个人琐事；',
  'todosTab.guide.tracks.item2': '工作（work）：跨项目的正事；',
  'todosTab.guide.tracks.item3': '本项目（project）：当前工作目录的待办——换个目录就看不到，按 cwd 隔离；',
  'todosTab.guide.tracks.item4': '今日（daily）：按天分文件的每日待办，可回看过往（按日期分组）。',
  'todosTab.guide.add.title': '怎么添加待办',
  'todosTab.guide.add.body': '两种方式，任选其一：',
  'todosTab.guide.add.item1': '直接对 AI 说「记住 / 我要做 X」（可指明 工作 / 生活 / 这个项目 / 今天），AI 自动归入对应轨；',
  'todosTab.guide.add.item2': '在本 Tab 输入框手动添加（可选四象限与截止日期）。',
  'todosTab.guide.pending.title': '待确认待办：AI 不能擅自给你派活',
  'todosTab.guide.pending.body': 'AI 自建的待办先进待确认队列，你确认后才生效：',
  'todosTab.guide.pending.item1': '采纳：写入对应待办轨（待办永远是待办，不会变成记忆）；',
  'todosTab.guide.pending.item2': '归档：保留备查；拒绝：丢弃。',
  'todosTab.guide.attrs.title': '状态与属性',
  'todosTab.guide.attrs.body': '每条待办带完整元数据，方便跟踪：',
  'todosTab.guide.attrs.item1': '四象限（重要 × 紧急）、截止日期、可选分类；',
  'todosTab.guide.attrs.item2': '状态：待办 / 进行中 / 已完成（自动盖完成时间）/ 受阻 / 已取消；',
  'todosTab.guide.attrs.item3': '列表 / 看板两种视图：列表按轨分页签 + 状态 / 象限筛选；看板按四象限四宫格展示；每条可完成 / 恢复、行内编辑、删除（确认）。',
  'todosTab.guide.view.title': '智能视图：只看需要关注的',
  'todosTab.guide.view.body': '默认只显示需要关注的（逾期 / 今日到期 / 当前项目 / 重要紧急，最多 8 条），避免刷屏：',
  'todosTab.guide.view.item1': '过往每日待办按需读取——点「过往」页签才查询历史；',
  'todosTab.guide.view.item2': '「显示已过期」勾选后才展示过期的遗留（默认隐藏，不增加负担）。',
  'todosTab.guide.remind.title': '到期提醒：AI 替你盯着',
  'todosTab.guide.remind.body': 'AI 每轮收尾自动检查待办到期情况，有到期未完成项就在回复末尾提醒你——不用自己记着盯。',
  'todo.track.life': '生活',
  'todo.track.all': '全部',
  'todo.track': '待办轨',
  'todo.track.work': '工作',
  'todo.track.project': '本项目',
  'todo.track.daily': '今日',
  'todo.track.past': '过往',
  'todo.projectHint': '当前会话无工作目录，项目待办不可用（只有 生活/工作/今日）。',
  'todo.help': '四轨待办：生活=个人琐事；工作=跨项目的正事；本项目=当前工作目录的待办（换个目录看不到）；今日=今天要做的（按天分文件）。每日的过往待办（今天之前）默认不读取——点「过往」页签或勾选「显示已过期」才会查询历史（已过期的遗留默认隐藏，勾选后全部显示）。添加：输入内容，可选四象限（重要×紧急）与截止日期，点「添加」；或直接对我说“帮我加个待办，是工作上的/生活中的/这个项目的/今天要的”——我会按类别写入对应轨。',
  'todo.showExpired': '显示已过期',
  'todo.pastHint': '过往待办大多是已过期的遗留，默认已隐藏；勾选「显示已过期」即可查看。',
  'todo.addPlaceholder': '输入待办内容（可多行），选择象限/截止后添加…',
  'todo.add': '添加',
  'todo.added': '已添加待办',
  'todo.done': '完成',
  'todo.undone': '恢复',
  'todo.edit': '编辑',
  'todo.save': '保存',
  'todo.cancel': '取消',
  'todo.updated': '已更新',
  'todo.deleted': '已删除',
  'todo.deleteConfirm': '确定删除这条待办？删除后不可恢复。\n\n{snippet}',
  'todo.due': '截止',
  'todo.overdue': '逾期',
  'todo.all': '全部',
  'todo.filterStatus': '状态',
  'todo.filterQuadrant': '象限',
  'todo.status.active': '未完成',
  'todo.status.pending': '待办',
  'todo.status.doing': '进行中',
  'todo.status.done': '已完成',
  'todo.status.blocked': '受阻',
  'todo.status.cancelled': '已取消',
  'todo.quadrant': '四象限',
  'todo.quadrant.none': '未分类',
  'todo.quadrant.q1': '重要紧急',
  'todo.quadrant.q2': '重要不紧急',
  'todo.quadrant.q3': '紧急不重要',
  'todo.quadrant.q4': '不重要不紧急',
  'todo.empty': '（暂无待办，添加一条吧）',
  // 列表 / 四象限看板视图切换
  'todo.view.mode': '视图',
  'todo.view.list': '列表',
  'todo.view.board': '看板',
  'todo.board.empty': '此象限暂无待办',
  'todo.board.cycleStatus': '点击切换状态',
  'memoryTab.cwd': '当前会话工作目录',
  'memoryTab.loading': '加载中…',
  'memoryTab.warning': '以下文件为 § 分隔的结构化记忆，用系统工具打开后请谨慎编辑，随意修改可能破坏格式、导致记忆读取错乱。',
  'memoryTab.readonly': '只读',
  'memoryTab.open': '打开文件',
  'memoryTab.opened': '已用系统工具打开',
  'memoryTab.empty': '（文件不存在或为空）',
  'memoryTab.noCwd': '（当前会话无工作目录，无法定位项目记忆）',
  'memoryTab.truncated': '（内容过长，已截断显示）',
  'memoryTab.pagePrev': '上一页',
  'memoryTab.pageNext': '下一页',
  'memoryTab.pageInfo': '第 {page}/{total} 页 · 共 {count} 条',
  'memoryTab.viewPretty': '美观视图',
  'memoryTab.viewRaw': '纯文本视图',
  'memoryTab.searchPlaceholder': '搜索内容、时间或标签…',
  'memoryTab.noResults': '没有匹配的条目，换个关键词试试。',
  'memoryTab.projectTag': '项目标签',
  'memoryTab.entryCount': '{count} 条',
  'memoryTab.keyAddHelp': '手动添加一条长期有效的项目事实（约定/决策/架构/踩坑），保存后写入 KEY.md，下一轮自动注入上下文。',
  'memoryTab.keyAddPlaceholder': '输入一条项目重要记忆，例如：本项目约定使用 pnpm workspaces…',
  'memoryTab.keyAdd': '保存',
  'memoryTab.keyAdded': '已写入项目关键记忆，下一轮将注入上下文',
  'memoryTab.memoryAddPlaceholder': '输入一条想长期记住的全局事实/惯例/环境，例如：公司内部 Nexus 仓库地址…',
  'memoryTab.userAddPlaceholder': '输入一条用户偏好/习惯/沟通方式，例如：回复默认用中文…',
  'memoryTab.memoryUserAddHelp': '手动写入非项目级长期记忆（全局事实 / 用户档案），日期自动盖戳，下一轮全局注入生效。',
  'memoryTab.memoryAdd': '保存',
  'memoryTab.memoryUserAdded': '已写入，下一轮起全局注入生效',
  'memoryTab.delete': '删除',
  'memoryTab.deleteConfirm': '确定删除这条记忆？删除后不可恢复。\n\n{snippet}',
  'memoryTab.deleted': '已删除该条目',
  'memoryTab.edit': '编辑',
  'memoryTab.save': '保存',
  'memoryTab.cancel': '取消',
  'memoryTab.updated': '已更新该条目',
  'memoryTab.editHint': '只能修改内容：时间戳与分支等标记由程序维护，不能改动；分隔符 § 不可输入。',
  'memoryTab.editConfirm': '这条记忆保存后会立即注入会话上下文（进入后续模型的提示词），确定保存？\n\n{snippet}',
  'memoryTab.archive': '归档',
  'memoryTab.archiveConfirm': '归档这条记忆？将从主记忆移入归档文件，不再注入会话；需要时可随时移回。\n\n{snippet}',
  'memoryTab.archived': '已归档（不再注入，可随时移回）',
  'memoryTab.promote': '移回主记忆',
  'memoryTab.promoted': '已移回主记忆（重新注入会话）',
  'memoryTab.keyScope': '分支范围',
  'memoryTab.keyScopeLabel': '分支',
  'memoryTab.keyScopeAll': '全部',
  'memoryTab.keyScopeAllHint': '全部 = 所有分支可见',
  'memoryTab.keyScopeAllWeight': '（勾选后清空分支选择）',
  'memoryTab.keyScopeHint': '点击修改分支范围',
  'memoryTab.keyScopeSaved': '分支范围已更新',
  'memoryTab.keyScopeSave': '保存',
  'memoryTab.keyScopeCancel': '取消',
  'memoryTab.keyBranchInfo': '当前分支：{branch}，仅注入无标记或含该分支的条目',
  'memoryTab.gitBranch': '该条记录所属的 git 分支',
  'memoryTab.dshOnly': '仅DSH',
  'memoryTab.dshOnlyHint': '该条目只注入 DSH 自身会话；注入外部执行器（COI 任务）时自动跳过——用于存放只对 DSH 有意义的纪律/规则/架构类事实',
  'memoryTab.dshOnlyOn': '仅DSH',
  'memoryTab.dshOnlyOff': '取消仅DSH',
  'memoryTab.dshOnlySet': '已标记为仅 DSH 适用（外部执行器注入时跳过）',
  'memoryTab.dshOnlyRemoved': '已取消仅 DSH 标记（外部执行器可见）',
  'memoryTab.dshOnlyToggleHint': '切换「仅 DSH」标记：该条目只注入 DSH 自身，不注入外部执行器（COI）',
  'memoryTab.dshOnlyAdd': '仅 DSH 适用（不注入外部执行器）',
  'memoryTab.desc.project': '项目日志：每回合收尾自动记录本回合进展；不注入上下文，模型按需读取。',
  'memoryTab.desc.key': '项目关键记忆：长期约定/决策/踩坑，自动注入当前项目会话；按重要性写入，可手动添加或删除。',
  'memoryTab.desc.daily': '今日日志：按天分文件的流水记录，程序自动标注项目标签；不注入上下文，模型按需读取。',
  'memoryTab.desc.user': '用户档案：用户偏好与习惯，注入所有会话；写入需审查建议并经确认。',
  'memoryTab.desc.memory': '长期记忆：全局环境与项目事实，注入所有会话；写入需审查建议并经确认。',
  'memoryTab.desc.archive-user': '归档用户：不够格进主记忆的用户事实，不注入任何会话；可移回主记忆或删除。',
  'memoryTab.desc.archive-memory': '归档记忆：不够格进主记忆的全局事实，不注入任何会话；可移回主记忆或删除。',
  'memoryTab.desc.archive-key': '项目关键记忆归档：不够格进主记忆（或需暂停注入）的项目事实，不注入任何会话；可移回主记忆或删除。',
  'memoryTab.desc.agents': '全局规则：跨会话生效的用户规则（AGENTS.md），随系统提示词注入。',
  'panel.suggestions.title': '待确认记忆建议',
  'panel.suggestions.empty': '没有待确认的建议。',
  'panel.suggestions.help': '后台审查产出的全局记忆建议：采纳后写入记忆文件并随快照注入；归档保留备查（不注入）；拒绝丢弃。',
  'panel.todoSuggestions.title': '待确认待办建议',
  'panel.todoSuggestions.empty': '没有待确认的待办建议。',
  'panel.todoSuggestions.help': '后台审查产出的待办建议：采纳后写入对应待办轨（待办不能变成记忆）；归档保留备查；拒绝丢弃。',
  'panel.guide.title': '使用指南',
  'panel.guide.intro': 'memory-evolve 是「记忆与自我进化」能力集合：让 AI 把对话沉淀为长期记忆、待办和技能——越用越懂你，跨会话不丢上下文。下面按模块介绍能做什么、怎么用。',
  'panel.guide.memory.title': '记忆读写（memory 工具）',
  'panel.guide.memory.desc': '五轨记忆：长期记忆（全局）、用户档案、项目关键记忆（自动注入，且按 git 分支过滤——只有当前分支相关的关键记忆进入 AI 上下文）、项目日志、今日日志。怎么用：正常对话即可——AI 每回合自动把进展写进日志；发现重要事实就说「记一下：这个项目的部署端口是 8080」；换项目 / 隔天继续时直接问 AI「查一下记忆」，它无缝衔接，不用你复述。',
  'panel.guide.review.title': '记忆审查（自动进化）',
  'panel.guide.review.desc': '每隔 N 轮（默认 10 轮，配置里可改）AI 自动回顾会话、提炼值得记住的信息，提交到「待确认记忆建议」由你确认后生效——AI 不会擅自往记忆里写东西。偶尔去「记忆」Tab 的待确认队列里采纳或拒绝即可。',
  'panel.guide.todo.title': '待办管理（dtodo）',
  'panel.guide.todo.desc': '对 AI 说「记住 / 我要做 X」即落成结构化待办（自动分 生活 / 工作 / 项目 / 每日，可设重要紧急与截止日期），到期 AI 会在回复末尾提醒你；AI 自建的待办先进「待确认待办建议」等你确认。管理界面在「待办」Tab。',
  'panel.guide.skill.title': '技能沉淀（skill_manage）',
  'panel.guide.skill.desc': '反复踩坑的方法论可固化为技能，同类任务下次直接按流程执行。对 AI 说「把这个流程存成技能」即可；创建保持克制，只建高复用价值的。技能库可在「技能」Tab 里浏览、搜索并一键启用 / 禁用。',
  'panel.guide.search.title': '本地搜索（memory_evolve_search_local_files）',
  'panel.guide.search.desc': '记忆里没有、要找本地资料时，对 AI 说「搜一下本机有没有 XX」——按文件名找（默认只搜文档扩展名，可显式全类型）；「哪个文档里提过 XX」则是按内容搜，直接返回命中文件和片段。四档模式在「配置」里选：文件名 + 内容 / 仅文件名 / 仅内容 / 关闭。默认关闭：工具对模型完全不可见，打开才生效。',
  'panel.guide.coi.title': 'COI 调度（de_coi）',
  'panel.guide.coi.desc': '把任务派给外部 CLI 代理（kimi / codex / grok / hermes 等）：统一调度不卡主进程、实时看进度、会话自动分层管理可一键恢复、跨 COI 接力、任务结果留档并沉淀到记忆。说「派给 kimi / codex 做 XX」即可，或打开「COI 调度」Tab 手动发起。默认禁用：在「配置」里打开「COI 调度」开关（工具即时生效，Tab 刷新后出现）。',
  'panel.guide.prompt.title': '提示词管理器（Prompt Manager）',
  'panel.guide.prompt.desc': '把常用的工作范式固化成提示词资产：选中一条即可注入——写入后模型下一轮自动看到、不打断回复；支持一次性、持续 N 轮、每 M 回合提醒一次（次数 / 间隔可输入任意数字，按对话回合计数自动过期），「注入中」可随时停止；也支持临时注入：不建提示词直接输入内容注入，自动存入库中。默认禁用：在「配置」里打开「提示词管理器」开关，Tab 刷新后出现。',
  'panel.guide.models.title': '模型设置（de_models）',
  'panel.guide.models.desc': '「模型设置」Tab + de_models 工具：表格一览 DSH 现有供应商与模型，给每个模型设置「插件侧」的启用状态、备注、是否支持思考与可用 / 推荐思考等级（可勾选等级白名单、添加自定义等级）——这些配置只对本插件有用（决定 de_models 查询口径与 Tab 展示），不修改、也不影响 DSH 自身的模型设置（DSH 的模型配置仍以官方「设置 → 模型」为准）。默认禁用：在「配置」里打开「模型设置」开关后，Tab 刷新出现、de_models 工具生效。',
  'panel.guide.advisor.title': '会话评审（Advisor）',
  'panel.guide.advisor.desc': '给每个会话挂一个独立评审员——它只观察你在界面上看到的对话（不含思考 / 工具调用），每轮实时评审，需要时以「用户指令」的形式提醒你（info / nit / concern / blocker 四级；info 默认仅记录；对话流中以折叠行 [severity] 显示，方便你认出哪些话是评审员说的）。评审员是持续会话——记住全部历史、永不截断；面板里可新建评审会话（重头开始）、直接提问、设置四层级约束（系统提示词 / 项目约束 / 会话约束 / 本次评审会话约束，越局部越优先）。默认关闭：先在「配置」打开总闸，再在会话页悬浮面板里为本会话手动启用；评审模型缺省继承当前会话模型，可单独配置。',
  'panel.guide.broadcast.title': '会话广播（de_broadcast）',
  'panel.guide.broadcast.desc': 'DSH 会话之间传递消息：复制本会话 ID（会话头部「⧉ 复制会话ID」按钮）发给另一个会话，让它的 AI 用 de_broadcast send 把内容发给你——接收方快照定点注入未读提示（只有接收者看得到，其他会话无感知），AI 用 list / read 查看全文处理（全员已读自动删除）；超长内容自动落文件。房间（聊天室）支持多人协作、可跨工作目录；项目群可发给整个目录。默认关闭：在「配置」里打开「会话广播」开关。',
  'panel.guide.session.title': '会话搜索（de_session_search）',
  'panel.guide.session.desc': '让 AI 搜索「其他 AI 工具的历史会话」（当前支持 Codex）——「之前 Codex 里做过 XX」直接问 AI，它按关键词搜出命中会话 + 消息摘要（snippet）+ 上下文窗口；可用 cwd 限定项目、sort / limit / window 控制结果规模；零常驻状态——无索引、无缓存，每次调用实时只读扫描。默认关闭：在「配置」里打开「会话搜索」开关。',
  'panel.guide.sessionOrch.title': '会话编排（de_session）',
  'panel.guide.sessionOrch.desc': '让 AI 程序化创建 / 唤醒 DSH 会话——spawn 新建标准会话（与手动打开完全同构：系统提示词 / 工具 / 记忆快照 / 持久化，出现在左侧会话列表可接管），创建后立即自动开跑；wake 唤醒已有会话派活（忙则排队）；status / list 查状态。协作纪律：AI 不会自动唤醒任何会话——由你有意识地指挥。默认关闭：在「配置」里打开「会话编排」开关；建议配合「会话广播」房间使用。',
  'panel.guide.uiSettings.title': 'Web UI 设置',
  'panel.guide.uiSettings.desc': '给 DSH web 界面加样式级小功能（纯客户端注入，不改框架）：各功能的独立小开关在「Web UI 设置」Tab 的「综合」里——会话筛选（左侧列表只显示进行中）、对话区加宽、消息气泡加宽、上下文占用提醒、Mermaid 图表渲染。默认关闭。',
  'panel.guide.canvas.title': '无限画板',
  'panel.guide.canvas.desc': '把散落在各处的文件 / 图片 / 音频集中到一块无限画布上（对话页「画板」Tab）——路径 / 便签 / 搜索一键上板（本地路径引用，不拷贝）、卡片内直接预览、可复制引用串丢给 AI 让它按 id 取素材；AI 也能用 de_canvas 往画板放便签（不注入上下文，需要时主动查）。默认关闭：在「配置」里打开「无限画板」开关。',
  'panel.guide.sync.title': '记忆同步（跨设备）',
  'panel.guide.sync.desc': '让项目记忆跨设备一致——办公室和家里的电脑共享同一份项目关键记忆 / 日志 / 归档 / 项目待办。在「记忆同步」Tab 打开「本项目同步」并点「开始同步」：默认用你的代码仓库的专属分支，零配置；也可填一个共享记忆仓库地址，一个仓库装所有项目的记忆（全局记忆也能同步）。另一台电脑打开项目自动认亲、拉取即可继续用。模块开关在「配置」里；同步永远由你手动触发，没开同步的项目不受影响。',
  'panel.guide.confirm.title': '确认制（为什么 AI 不能直接写）',
  'panel.guide.confirm.desc': 'AI 自建的记忆、待办、技能都先进待确认队列，等你确认才生效。因为这些写入会真实改变 AI 的行为：记忆会进入上下文、待办是给你派的活、技能会改变 AI 的能力库——如果 AI 擅自写入，可能把它的误判当事实沉淀、或自作主张给你派活。你是最终把关者：AI 只提议，你决定。',
  'panel.guide.best.title': '怎么用得最好',
  'panel.guide.best.1': '跨会话衔接：项目约定 / 进展直接说「查一下记忆」，AI 从项目日志与关键记忆里接续，不重复交代。',
  'panel.guide.best.2': '口头即记：想到什么就说「记住这个 / 这个要跟进」，AI 自动分类沉淀；隔几天回来说一句就能接上。',
  'panel.guide.best.3': '定期确认：偶尔看看「待确认记忆建议」「待确认待办建议」，采纳或拒绝——这是记忆进化的确认环节。',
  'panel.guide.best.4': '多设备同步：办公室和家里都干活？打开「记忆同步」，两台电脑共享同一份项目记忆，重要结论不用讲两遍。',
  'panel.guide.loop': '闭环：聊 → 记 → 审查 → 沉淀 → 执行。这套机制就是 AI 的长期工作记忆。',
  'panel.suggestions.approve': '采纳',
  'panel.suggestions.archive': '归档',
  'panel.suggestions.archiveHint': '归档：不注入会话，仅保留备查，需要时可移回主记忆',
  'panel.suggestions.editHint': '采纳前可修改文本，修改后的内容将写入记忆。',
  'panel.suggestions.reject': '拒绝',
  'panel.suggestions.approveAll': '全部采纳',
  'panel.suggestions.rejectAll': '全部拒绝',
  'panel.suggestions.hits': '已建议 {count} 次',
  'panel.suggestions.hitsHint': '该内容在多轮审查中反复出现，值得认真确认',
  'panel.suggestions.target.memory': '长期记忆',
  'panel.suggestions.target.user': '用户档案',
  'panel.suggestions.target.key': '项目关键记忆',
  'panel.suggestions.targetHint': '采纳时写入的轨：默认=AI 推荐的分类；可改为更合适的（记忆/用户档案/项目关键记忆都会立即注入上下文）',
  'panel.suggestions.projectHint': '这条建议来自该项目的工作目录：{path}',
  'panel.suggestions.done': '操作完成：{text}',
  'panel.archive.title': '已归档记忆',
  'panel.archive.empty': '暂无归档条目',
  'panel.archive.help': '归档的建议不会注入会话，仅在此保留备查——需要时可「移回主记忆」（写入对应记忆文件）或「删除」。',
  'panel.archive.promote': '移回主记忆',
  'panel.archive.delete': '删除',
  'panel.archive.promoted': '已移回主记忆',
  'panel.archive.deleted': '已删除归档条目',
  'panel.skills.title': '待确认技能建议',
  'panel.skills.help': '后台审查产出的新技能，采纳后移入技能库（~/.agents/skills）并随系统提示词注入。',
  'panel.skills.empty': '没有待确认的技能建议。',
  'panel.skills.pending': '待采纳',
  'panel.skills.approve': '采纳',
  'panel.skills.reject': '拒绝',
  'panel.skills.done': '已{op}技能',
  'panel.config.title': '配置',
  'panel.config.help': '修改立即生效并持久化（覆盖 config.yaml 的对应项）。',
  'panel.config.reviewEnabled': '后台审查',
  'panel.config.reviewEnabled.hint': '自动回顾会话并沉淀经验；关闭后 memory/skill 工具与记忆快照仍可用，只是不再自动审查',
  'panel.config.reviewInterval': '审查间隔（回合）',
  'panel.config.reviewInterval.hint': '每 N 个用户回合自动审查一次',
  'panel.config.skillReviewEnabled': '技能自动沉淀',
  'panel.config.skillReviewEnabled.hint': '关（默认）：审查创建的新技能进入待确认队列，采纳后才进入技能库；开：审查直接创建技能，无需确认（技能注入所有会话，请谨慎开启）',
  'panel.config.perTurnWriteGuard': '记忆写入看门狗',
  'panel.config.perTurnWriteGuard.hint': '关（默认）：根源是模型的指令遵循能力，强模型用不上；开：连续多轮未写 daily/project 记忆时快照置顶提醒（写入即消），盯住长会话是否漏做每轮收尾写记忆',
  'panel.config.writeGuardThreshold': '看门狗触发阈值（轮）',
  'panel.config.writeGuardThreshold.hint': '连续 N 轮未写入任何 daily/project 记忆即提醒（>=1；2 = 容忍漏 1 轮、第 2 轮起提醒）',
  'panel.config.perTurnProjectWrites': '每回合写入项目记忆',
  'panel.config.perTurnProjectWrites.hint': '要求模型每个回合结束前主动检查并记录项目相关新事实（关键决策/进展/踩坑）；关闭后项目记忆仅按需读取。⚠️ 依赖 LLM 指令遵循，弱遵循的模型不一定会执行',
  'panel.config.perTurnDailyWrites': '每回合写入每日日志',
  'panel.config.perTurnDailyWrites.hint': '要求模型每个回合结束前主动检查并记录当天进展；关闭后每日日志仅按需读取。⚠️ 依赖 LLM 指令遵循，弱遵循的模型不一定会执行',
  'panel.config.perTurnKeyWrites': '每回合检查项目关键记忆',
  'panel.config.perTurnKeyWrites.hint': '要求模型每个回合结束前判断是否出现重要项目事实（长期约定/决策/架构/踩坑），有则写入 target=key（自动注入上下文），没有就跳过；关闭后 key 仅保留手动添加与读取。⚠️ 依赖 LLM 指令遵循',
  'panel.config.keyBranchFilter': 'key 轨分支过滤',
  'panel.config.keyBranchFilter.hint': '开启（默认）时，key 轨条目按**当前 git 分支**过滤：无分支标记的条目对所有分支可见，带 [branch:x] 标记的只在该分支可见——系统提示词注入、expand、list 三处同一规则。关掉后三处都不再过滤（诊断用；会让别的分支的条目也出现在列表里）',
  'panel.config.keyProgressiveDisclosure': 'key 轨渐进式披露',
  'panel.config.keyProgressiveDisclosure.hint': '控制 key 轨记忆的注入方式：auto = 小数据量全量注入、大数据量摘要注入；off = 始终全量注入（默认）；on = 始终摘要注入（节省 token）',
  'panel.config.keyProgressiveDisclosure.auto': '自动',
  'panel.config.keyProgressiveDisclosure.off': '关闭（始终全量，默认）',
  'panel.config.keyProgressiveDisclosure.on': '开启（始终摘要）',
  'panel.config.keyFullInjectThreshold': '全量注入条目数阈值',
  'panel.config.keyFullInjectThreshold.hint': 'auto 模式下，条目数 ≤ 此值时全量注入（默认 3）',
  'panel.config.keyFullInjectCharLimit': '全量注入字符数阈值',
  'panel.config.keyFullInjectCharLimit.hint': 'auto 模式下，总字符数 ≤ 此值时全量注入（默认 1500）',
  'panel.config.coiEnabled': 'COI 调度',
  'panel.config.coiEnabled.hint': '启用 de_coi_* 工具与「COI 调度」Tab：统一调度 kimi/codex/grok/hermes 等 CLI 代理（默认禁用——本插件的本职是记忆/待办/技能，调度是按需增强；关闭时工具与 Tab 完全不可见）',
  'panel.config.searchDocsEnabled': '本地文件搜索工具',
  'panel.config.searchDocsEnabled.hint': '让模型在本机所有磁盘/目录中搜索文件。**四档模式**：都启用 = 文件名 + 内容检索都可用；仅文件名 = content/contentQuery 参数被忽略（不读任何文件内容，适合内容检索用别的实现的人）；仅内容 = 每次调用都做内容匹配（query 视为内容关键词）；关闭 = 工具对模型完全不可见。内容检索：contentQuery="关键词" 即搜"哪个文档里提过 XX"（rg 全文匹配，返回命中片段）。默认关闭',
  'panel.config.searchDocsMode.all': '都启用（文件名 + 内容）',
  'panel.config.searchDocsMode.filename': '仅文件名搜索',
  'panel.config.searchDocsMode.content': '仅内容搜索',
  'panel.config.searchDocsMode.off': '关闭（工具不可见）',
  'panel.config.advisorEnabled': '会话评审（Advisor）',
  'panel.config.advisorEnabled.hint': '会话评审模块总闸：开启后**每个会话仍默认关闭**——需在悬浮面板里用状态条开关为本会话手动启用（评审消耗额外模型调用，按需开启；手动开过的会话刷新/重启后保持）。总闸关闭时评审停止、会话评审入口（会话头部按钮/悬浮面板）全部隐藏，模块整体不可用；重新开启后立即恢复',
  'panel.config.broadcastEnabled': '会话广播',
  'panel.config.broadcastEnabled.hint': '启用会话广播（de_broadcast）：DSH 会话间消息传递——快照「会话广播」未读提示（收件箱式列出 id+主题+发送者+时间）+ de_broadcast 工具（send/list/read，read 即消费、全读后自动删除、8KB 落文件、30 天清理）+ 会话广播管理面板 Tab。**独立于 COI 调度**（默认关闭，可单独开启）；关闭时以上全部不可见；「你的会话 ID」常驻快照段不受影响；会话头部「⧉ 复制会话ID」「✎ 别名」按钮属「会话编排」模块（面板顶部另有复制入口）',
  'panel.config.notifyEnabled': '通知模块',
  'panel.config.notifyEnabled.hint': '启用通知模块（de_notify）：AI 完成任务后主动发通知给你——de_notify 手动工具（随时可发、无频率限制，channels 含 feishu/qq/weixin/wecom/web）+ COI 任务完成自动通知（coiNotifyChannels 选渠道）。web 渠道=发到本网页右上角站内通知铃铛：落盘 + 未读数字徽标 + 弹窗查看「哪个会话发来什么通知」+ 点击跳转到该会话。独立模块，默认关闭；IM 渠道依赖对应渠道插件（dsh-feishu 等，未装如实报渠道不可用），web 渠道由本插件内置零依赖；关闭时工具不注册、铃铛消失、COI 自动通知静默跳过',
  'notify.title': '通知',
  'notify.bellAria': '站内通知',
  'notify.empty': '暂无未读通知',
  'notify.loading': '加载中…',
  'notify.readAll': '全部已读',
  'notify.system': '系统',
  'notify.jump': '跳转到会话',
  'notify.delete': '删除',
  'notify.viewDetail': '查看详情',
  'notify.close': '关闭',
  'notify.markRead': '已读',
  'panel.config.syncEnabled': '记忆同步',
  'panel.config.syncEnabled.hint': '**模块开关**：启用「记忆同步」模块——对话页出现「记忆同步」Tab、/memory_sync 命令可用。**注意：这只是模块启用，不等于任何项目开始同步**——每个项目由「记忆同步」Tab 里的「本项目同步」开关单独启用（默认关；未启用的项目保持纯本地状态，不建 Git 仓库、不生成身份证）。同步机制：项目记忆（KEY + 项目日志 + 归档 + 项目待办）经 Git 对账到记忆远端——不填地址默认用你的主代码仓库（专属分支，零配置）；填共享记忆仓库地址 = 一个私有仓库装所有项目的记忆（全局记忆二期也只能用它同步）。push 永远需你显式触发',
  'panel.config.sessionSearchEnabled': '会话搜索',
  'panel.config.sessionSearchEnabled.hint': '启用 de_session_search：让模型搜索本机其他 AI 工具的历史会话（当前支持 Codex：~/.codex/sessions 与 archived_sessions 的明文 JSONL——rg 预筛后毫秒级；DSH 会话暂不支持）。大小写不敏感的字面匹配，只搜用户/助手消息；支持 cwd 项目过滤、relevance/newest/oldest 排序、limit/window 控制规模。**独立子模块**（默认关闭，可单独开启，与 COI 调度/广播无关）；零常驻状态：无索引、无缓存，每次调用实时只读扫描，不修改任何会话文件；关闭时工具对模型完全不可见',
  'panel.config.canvasEnabled': '无限画板',
  'panel.config.canvasEnabled.hint': '**模块开关**：启用「无限画板」——对话页出现「画板」Tab + de_canvas 工具（AI 可查画板、按 id 读内容、往画板中央区放便签）。本地路径引用、单板+视角筛选（会话/项目/全局 + 归属徽标）、AI 双向拉取式（画板内容不注入上下文，需要时主动查）。**独立子模块**（默认关闭）：存储 <memoryDir>/canvas/boards.json（整板原子写 + rev 乐观锁防多会话覆盖）；关闭时 Tab 与工具完全不可见，数据文件保留',
  'panel.config.sessionEnabled': '会话编排',
  'panel.config.sessionEnabled.hint': '启用会话编排（de_session）：让 AI **程序化创建/唤醒 DSH 会话**——spawn 新建标准会话（与手动打开完全同构：系统提示词/工具/记忆快照/持久化，出现在左侧会话列表可接管），prompt=完整提示词（角色/任务自由组合的长文本），创建后立即自动开跑，可选 cwd/加入广播房间/覆盖模型；wake 唤醒已有会话（等价替用户发消息，对方 AI 自动醒来处理，进程重启后自动恢复）；status/list 查状态；**会话头部「⧉ 复制会话ID」「✎ 别名」按钮随本开关**（会话身份功能，曾误挂在广播下）。**独立子模块**（默认关闭；依赖 DSH agents 服务，仅同进程会话可唤醒；关闭时工具对模型不可见）',
  'panel.config.promptsEnabled': '提示词管理器',
  'panel.config.promptsEnabled.hint': '启用「提示词」Tab：提示词库（用户自写范式 + 内置示例）+ 注入轨（一次性/持续 N 轮/每 M 回合一次，次数与间隔可输入任意数字——写入后模型下一轮自动看到，回合递减自动过期，可随时停止；不建提示词也能临时注入，自动入库归入「临时」分类）。默认关闭；关闭时快照段/事件监听/API 全部卸载，Tab 刷新后隐藏',
  'panel.config.modelsEnabled': '模型设置',
  'panel.config.modelsEnabled.hint': '启用「模型设置」Tab + de_models 工具：表格展示 DSH 供应商/模型，给每个模型设置启用状态、备注、是否支持思考、可用/推荐思考等级（可加自定义等级）；de_models 供 AI 查询可用模型清单。**默认关闭**（注册即占模型工具列表，需要时再开）；⚠️ 本模块的配置**只对插件自身有用，不修改也不影响 DSH 的模型设置**（DSH 侧仍以官方「设置 → 模型」为准）。关闭时 Tab 与工具隐藏、API 拒绝访问，配置数据保留',
  'panel.config.uiSettingsEnabled': 'Web UI 设置',
  'panel.config.uiSettingsEnabled.hint': '启用「Web UI 设置」模块：左侧会话列表顶部出现筛选条，默认只显示进行中的会话（正在生成/等审批/等回答/有子代理在跑/出错/已完成未查看——纯 idle 的折叠隐藏），可一键切回全部；纯客户端样式增强（CSS + DOM 注入，不改 DSH 框架）；筛选偏好记在浏览器本地。**默认关闭**；关闭时筛选条与注入样式全部移除',
  'panel.config.save': '保存配置',
  'panel.reveal.title': '打开文件',
  'panel.reveal.help': '用系统工具打开记忆目录与记忆文件。⚠️ 随意编辑可能破坏 § 分隔格式、导致记忆读取错乱，请谨慎修改。',
  'panel.reveal.memoryDir': '记忆目录',
  'panel.reveal.memoryFile': '全局记忆',
  'panel.reveal.userFile': '用户档案',
  'panel.reveal.archiveMemoryFile': '归档记忆',
  'panel.reveal.archiveUserFile': '归档用户',
  'panel.reveal.dailyDir': '每日日志目录',
  'panel.reveal.dailyFile': '今日日志',
  'panel.reveal.projectsDir': '项目记忆目录',
  'panel.reveal.skillDir': '技能目录',
  'panel.reveal.agentsFile': '全局规则 (AGENTS.md)',
  'panel.config.saved': '配置已保存。新启用/关闭的模块需刷新页面后生效',
  'panel.config.failed': '操作失败：{message}',
  'panel.loading': '加载中…',
  // COI 调度 tab（CoIView 私有字典迁入，2026-09-16 i18n）
  'coi.tab': 'CLI调度',
  'coi.guide': '指南',
  'coi.guide.title': 'COI 调度使用指南',
  'coi.guide.intro': 'COI 调度 = 把任务派给外部 AI 代理（kimi / codex / grok / hermes 等）的「外援调度台」：后台异步执行、不卡当前会话；实时看进度和日志；会话分层管理、可一键恢复继续；任务还能跨代理接力；结果自动留档并沉淀到记忆。默认关闭——在「Memory Evolve 设置」Tab 的「配置」里打开「COI 调度」开关。',
  'coi.guide.use.title': '怎么发起任务',
  'coi.guide.use.desc': '三种入口，任选其一：',
  'coi.guide.use.ai': '对 AI 说：',
  'coi.guide.use.aiDesc': '直接说「派给 kimi 做 XX / 让 codex 修复测试」——AI 用 de_coi_dispatch 工具发起，后台异步跑，完成后结果摘要自动写进项目日志和今日日志。',
  'coi.guide.use.slash': '终端命令：',
  'coi.guide.use.slashDesc': '/de_coi run "任务" --coi kimi（查看全部子命令：/de_coi help）。',
  'coi.guide.use.tab': '本 Tab：',
  'coi.guide.use.tabDesc': '「任务」页填适配器、任务内容、层级，可选恢复会话 / 任务模板 / 接力引用；还能勾选「注入 DSH 记忆」让外援带上你的项目约定，或附加上下文文本、带图分析；点发起，进度与输出实时可见。',
  'coi.guide.scope.title': '会话分层（谁能看到）',
  'coi.guide.scope.desc': '任务与会话按层级归属，决定谁能看到、能否恢复：',
  'coi.guide.scope.temp': '仅发起它的那个会话可见，一次性任务（测试适配器用这个）。',
  'coi.guide.scope.session': '仅发起它的那个会话可见，会话内可恢复。',
  'coi.guide.scope.project': '该项目（相同工作目录）的所有会话可见，可挂 git 分支。',
  'coi.guide.scope.global': '所有会话可见，长期保留。',
  'coi.guide.skill.title': '适配器与技能',
  'coi.guide.skill.desc': '每个适配器对应一个技能（AI 的使用指南，注入模型上下文）：内置四家开箱即用；自定义 CLI 可在「适配器」页添加（含普通命令 plain-cli），填技能名与内容后 AI 即学会调用它。技能可在「技能管理」Tab 禁用，可在适配器页「技能」按钮编辑。',
  'coi.guide.tips.title': '最佳实践',
  'coi.guide.tips.1': '分工：前端→kimi，复杂后端→codex，快速任务→grok。',
  'coi.guide.tips.2': '接力链：codex 写代码 → kimi review（发起时选「接力引用」）。',
  'coi.guide.tips.3': '重要会话记得备注（会话页点备注），恢复时按名字找。',
  'coi.guide.tips.4': '任务结束可推送通知（配置页填通知命令，如 hermes send 推微信）。',
  'coi.guide.tips.5': '派活时勾选「注入 DSH 记忆」，外援会带着你的全局规则、用户偏好与本项目关键记忆干活（按分支过滤，与 DSH 注入同规则）；派活也能带图——截图直接发给外援分析（codex / kimi / hermes 支持读图，zcode 纯文本会明确拒绝）。',
  'coi.guide.loop': '闭环：派任务 → 实时看进度 → 拿结果留档 → 摘要沉淀记忆 → 会话可恢复再接力。',
  'coi.tasks': '任务',
  'coi.sessions': '会话',
  'coi.adapters': '适配器',
  'coi.templates': '模板',
  'coi.stats': '统计',
  'coi.config': '配置',
  'coi.loading': '加载中…',
  'coi.refresh': '刷新',
  'coi.all': '全部',
  'coi.none': '（无）',
  'coi.launch.title': '发起任务',
  'coi.launch.expand': '展开',
  'coi.launch.collapse': '收起',
  'coi.launch.adapter': '适配器',
  'coi.launch.prompt': '任务内容',
  'coi.launch.promptPh': '例如：修复 tests/store.test.js 中失败的用例并验证',
  'coi.launch.scope': '范围',
  'coi.launch.session': '恢复会话',
  'coi.launch.sessionNone': '（新会话）',
  'coi.launch.sessionEmpty': '（当前适配器暂无会话）',
  'coi.launch.template': '模板',
  'coi.launch.templateNone': '（不用模板）',
  'coi.launch.ref': '接力引用',
  'coi.launch.refNone': '（不引用）',
  'coi.launch.submit': '发起',
  'coi.launch.injectTracks': '注入 DSH 记忆（可选）',
  'coi.launch.injectTracksHint': '自主选择要带给 COI 的记忆轨（与层级 scope 无关，任何层级都可注入）：长期记忆=全局事实、用户档案=你的偏好、项目关键记忆=本工作区项目按分支过滤（不含 AGENTS.md）。内容会发给外部 COI 服务，注意隐私；留空=不注入',
  'coi.launch.ctxText': '附加上下文文本（可选）',
  'coi.launch.ctxTextPh': '自己拼接的上下文：如项目进展、相关日志要点…（超 32KB 自动写文件并把路径告诉 COI）',
  'coi.launch.needPrompt': '任务内容不能为空',
  'coi.launch.ok': '已发起',
  'coi.tasks.empty': '暂无任务',
  'coi.tasks.selectHint': '点击左侧任务查看详情与输出',
  'coi.tasks.kill': '终止',
  'coi.tasks.confirmKill': '确认终止该任务？',
  'coi.tasks.killed': '已终止',
  'coi.tasks.retry': '重试',
  'coi.tasks.retried': '已重新发起',
  'coi.tasks.copy': '复制',
  'coi.tasks.copied': '已复制',
  'coi.tasks.copyFail': '复制失败',
  'coi.tasks.log': '输出日志',
  'coi.tasks.logEmpty': '（暂无输出）',
  'coi.tasks.logFull': '放大',
  'coi.tasks.prompt': '任务内容',
  'coi.tasks.searchPh': '搜索任务（内容/任务 id）…',
  'coi.tasks.pager.prev': '上一页',
  'coi.tasks.pager.next': '下一页',
  'coi.tasks.pager.total': '共',
  'coi.tasks.delete': '删除',
  'coi.tasks.confirmDelete': '删除该任务？将移除任务记录与输出留档（已沉淀到记忆的摘要不受影响；被接力引用的任务删除后，新接力会提示任务不存在）。\n\n{id}',
  'coi.tasks.status': '状态',
  'coi.tasks.adapter': '适配器',
  'coi.tasks.scope': '范围',
  'coi.tasks.branch': '分支',
  'coi.tasks.sessionId': '会话 ID',
  'coi.tasks.created': '创建时间',
  'coi.tasks.duration': '耗时',
  'coi.tasks.lastOutput': '最后输出',
  'coi.tasks.exitCode': '退出码',
  'coi.tasks.error': '错误',
  'coi.sessions.filterScope': '范围过滤',
  'coi.sessions.searchPh': '搜索…',
  'coi.sessions.note': '备注',
  'coi.sessions.save': '保存',
  'coi.sessions.delete': '删除',
  'coi.sessions.confirmDelete': '确认删除该会话记录？',
  'coi.sessions.empty': '暂无会话',
  'coi.sessions.locked': '有任务占用中',
  'coi.sessions.lastSeen': '最近活跃',
  'coi.adapters.guide': '指南',
  'coi.adapters.test': '测试',
  'coi.adapters.testOk': '测试任务已发起',
  'coi.adapters.skill': '技能',
  'coi.adapters.skillHint': '该适配器的使用指南所在技能：它是同步注入的真实有效技能（来源=用户技能库，注入每个会话的系统提示词），AI 每次会话都能看到；禁用请到「技能管理」Tab',
  'coi.adapters.skillBtn': '技能',
  'coi.adapters.editSkillTitle': '编辑技能（AI 使用指南）',
  'coi.adapters.editSkillHint': '技能 = AI 的使用指南：本技能已同步注入用户技能库（~/.agents/skills），每个会话的系统提示词里都能看到它，AI 据此正确调用本适配器。在这里编辑即更新 SKILL.md；插件重启时内置版本未变不会覆盖你的编辑；禁用入口在「技能管理」Tab。',
  'coi.adapters.saveSkill': '保存',
  'coi.adapters.skillSaved': '技能已保存',
  'coi.adapters.skillName': '技能名（可选）',
  'coi.adapters.skillNamePh': '如 my-cli-skill（该技能的 SKILL.md 将注入 AI 上下文，AI 据此学会调用此 CLI）',
  'coi.adapters.useCase': '适用场景',
  'coi.adapters.useCasePh': '告诉 AI 什么任务适合用这个 CLI，如：复杂后端逻辑/测试修复…',
  'coi.adapters.useCaseEmpty': '（未填写适用场景）',
  'coi.adapters.editUseCase': '编辑场景',
  'coi.adapters.saveUseCase': '保存',
  'coi.adapters.skillContent': '技能内容（SKILL.md）',
  'coi.adapters.skillContentPh': '# 技能正文\n\n告诉 AI 如何调用这个 CLI：命令格式、参数、会话恢复方式、注意事项…（frontmatter 的 name/description 会自动补全）',
  'coi.adapters.skillContentHint': '留空 = 只关联技能名（技能文件需另外创建，可添加后到「技能」按钮里编辑）；填写 = 技能不存在时自动创建',
  'coi.cancel': '取消',
  'coi.saving': '保存中…',
  'coi.adapters.addTitle': '添加自定义适配器',
  'coi.adapters.name': '名称',
  'coi.adapters.type': '类型',
  'coi.adapters.binary': '可执行文件',
  'coi.adapters.args': '参数',
  'coi.adapters.argsPh': '逗号分隔，如：-p, {task}',
  'coi.adapters.add': '添加',
  'coi.adapters.delete': '删除',
  'coi.adapters.enable': '启用',
  'coi.adapters.disable': '禁用',
  'coi.adapters.disabledHint': '已禁用：AI 调度此适配器会被拒绝并提示换用其他可用项',
  'coi.adapters.confirmDelete': '确认删除该自定义适配器？',
  'coi.adapters.builtin': '内置',
  'coi.adapters.custom': '自定义',
  'coi.adapters.resumeSection': '会话恢复配置（ai-cli 必填）',
  'coi.adapters.resumeSectionHint': 'ai-cli 类型必须有指定会话恢复能力；没有恢复能力的 CLI 请选 plain-cli 类型',
  'coi.adapters.resumeKind': '恢复方式',
  'coi.adapters.resumeKindFlag': 'flag 模式（恢复参数插在基础参数前）',
  'coi.adapters.resumeKindArgs': 'args 模式（完整恢复命令）',
  'coi.adapters.resumeFlag': '恢复 flag',
  'coi.adapters.resumeFlagPh': '如 -S / -r / --resume',
  'coi.adapters.resumeArg': '会话参数',
  'coi.adapters.resumeArgPh': '含 {sessionId} 占位符，如 {sessionId}',
  'coi.adapters.resumeArgs': '恢复命令参数',
  'coi.adapters.resumeArgsPh': '逗号分隔，含 {sessionId}（及可选 {task}），如 exec, resume, {sessionId}, {task}',
  'coi.adapters.continueFlag': '最近会话恢复 flag（可选）',
  'coi.adapters.continueFlagPh': '如 -c；留空 = 不支持"最近会话"恢复',
  'coi.adapters.extractSection': '会话 ID 自动提取（可选）',
  'coi.adapters.extractSource': '输出流',
  'coi.adapters.extractRegex': '提取正则',
  'coi.adapters.extractRegexPh': '捕获组 1 为会话 ID，如 To resume this session: kimi -r (session_\\S+)',
  'coi.adapters.resumeMissing': 'ai-cli 类型必须填写会话恢复配置（resume）',
  'coi.templates.addTitle': '添加模板',
  'coi.templates.name': '名称',
  'coi.templates.prompt': '任务内容',
  'coi.templates.adapterOpt': '适配器（可选）',
  'coi.templates.idOpt': 'ID（可选，不填自动）',
  'coi.templates.add': '添加',
  'coi.templates.delete': '删除',
  'coi.templates.confirmDelete': '确认删除该模板？',
  'coi.templates.builtinKeep': '内置模板不可删除',
  'coi.templates.empty': '暂无模板',
  'coi.stats.total': '总任务数',
  'coi.stats.count': '任务数',
  'coi.stats.hours': '累计时长',
  'coi.stats.byStatus': '状态分布',
  'coi.stats.empty': '暂无统计数据',
  'coi.config.notify': '通知命令',
  'coi.config.notifyHint': '任务结束时执行；占位符：{taskId} {coi} {status} {summary}',
  'coi.config.retention': '任务保留天数',
  'coi.config.timeout': '任务超时',
  'coi.config.timeoutHours': '小时',
  'coi.config.timeoutMinutes': '分钟',
  'coi.config.timeoutHint': '超时仅作兜底防线（AI 任务可能数小时无输出属正常）；留空 = 不修改',
  'coi.config.timeoutBad': '超时格式不正确',
  'coi.config.save': '保存',
  'coi.config.saved': '已保存',
  'coi.scope.temporary': '临时',
  'coi.scope.session': '会话',
  'coi.scope.project': '项目',
  'coi.scope.global': '全局',
  // 提示词 tab（PromptView 私有字典迁入，2026-09-16 i18n）
  'prompt.guide': '指南',
  'prompt.library': '提示词库',
  'prompt.guideIntro': '提示词注入 = 「指令范式资产库 + 一键注入」：把常用工作范式（代码审查 / 调试 / PRD / 测试等）固化成提示词，选中即注入——模型下一轮自动看到、不打断回复，等于给 AI 下发操作手册。',
  'prompt.guideLibTitle': '提示词库：你的范式资产',
  'prompt.guideLibBody': '可复用的指令范式资产，来源以用户自写为主：',
  'prompt.guideLibItem1': '新建 / 编辑 / 删除：名称 + 简介 + 分类 + 标签 + 正文（Markdown），新建时分类留空自动归入「临时」；',
  'prompt.guideLibItem2': '分类管理：内置分类 + 自定义添加 / 重命名 / 删除（删除时该分类下提示词自动移到未分类）；',
  'prompt.guideLibItem3': '搜索（名称 / 分类 / 标签 / 内容）+ 复制到剪贴板 + 使用统计；',
  'prompt.guideLibItem4': '内置 13 条来自 GitHub 真实提示词资产的冷启动示例（SpecRoute / Claude-Code-Promts-Skills），并附范式库链接供自取；',
  'prompt.guideLibItem5': '启用状态：禁用后 AI 的提示词工具（de_prompts）看不到、也不能注入——GUI 仍可编辑，随时可重新启用；AI 可查询列表（按 ID 取详情）并选择合适提示词注入当前会话，或用作子会话 / 子代理 / CLI 任务提示词。',
  'prompt.guideInjectTitle': '注入机制：次数 × 间隔',
  'prompt.guideInjectBody': '选中提示词配置「次数 × 间隔」即注入（次数 / 间隔可输入任意数字）：',
  'prompt.guideInjectItem1': '次数：一次性（1 轮）/ 有限 N 次 / 无限（0 = 持续注入直到手动停止）；',
  'prompt.guideInjectItem2': '间隔：每回合（1）/ 每 M 回合出现 1 次（如「每 3 回合提醒一次」）；',
  'prompt.guideInjectItem3': '写后即时注入、不打断回复：内容写入注入轨，模型下一轮生成时自动看到；',
  'prompt.guideInjectItem4': '正文支持 {{date}} / {{time}} 变量，注入时自动展开（适合带日期的日报模板）；',
  'prompt.guideInjectItem5': '临时注入：不建提示词也能注入——详情栏直接输入内容点「注入」，自动存入提示词库（分类留空归入「临时」），一次操作同时入库并生效。',
  'prompt.guideTrackTitle': '注入状态：随时可见、可停',
  'prompt.guideTrackBody': '每个提示词有明确状态（未注入 / 注入中·剩 N 次 / 持续注入中），可随时停止；「注入中」浮层实时展示；会话页 Tab 栏有活跃注入时显示红点 🔴。',
  'prompt.guideSwitchTitle': '开关',
  'prompt.guideSwitchBody': '提示词管理器默认关闭：在「Memory Evolve 设置」Tab 的「配置」里打开「提示词管理器」开关，刷新后本 Tab 出现。',
  'prompt.search': '搜索名称、分类、标签或内容…',
  'prompt.new': '新建提示词',
  'prompt.all': '全部',
  'prompt.uncategorized': '未分类',
  'prompt.inject': '注入',
  'prompt.injectRound': '注入 {n} 次',
  'prompt.injectInfinite': '无限次（持续注入）',
  'prompt.injectCadence': '每 {n} 回合一次',
  'prompt.everyTurn': '每回合',
  'prompt.injectHint': '写入注入轨，模型下一轮自动看到；次数按对话回合消耗（可间隔注入），无限次则持续到手动停止',
  'prompt.injecting': '注入中',
  'prompt.injectingBadge': '注入中·剩{n}次',
  'prompt.injectingBadgeInfinite': '注入中·持续',
  'prompt.injectingIdle': '未注入',
  'prompt.noInjection': '还没有注入中的提示词',
  'prompt.removeInjection': '停止注入',
  'prompt.stoppedInjection': '已停止注入',
  'prompt.copy': '复制',
  'prompt.copied': '已复制到剪贴板',
  'prompt.save': '保存',
  'prompt.saving': '保存中…',
  'prompt.cancel': '取消',
  'prompt.delete': '删除',
  'prompt.deleteConfirm': '确定删除「{name}」？删除后不可恢复，其活跃注入会一并移除。',
  'prompt.sources': 'GitHub 范式库来源',
  'prompt.sourcesHint': '以下仓库有大量高质量提示词/规范（用户自取，不做自动导入）：',
  'prompt.empty': '还没有提示词。点「新建提示词」开始，或从右侧来源链接获取灵感。',
  'prompt.noMatch': '没有匹配的提示词',
  'prompt.formNew': '新建提示词',
  'prompt.formEdit': '编辑提示词',
  'prompt.name': '名称',
  'prompt.namePh': '如：代码审查（Code Review）',
  'prompt.description': '简介',
  'prompt.descriptionPh': '一句话说明这个提示词的用途（AI 选择提示词时看这里）',
  'prompt.enabled': '启用状态',
  'prompt.enabledOn': '已启用',
  'prompt.enabledOff': '已禁用',
  'prompt.disabledHint': '禁用后不出现在 AI 的提示词列表，也不能被 AI 注入；可在本页重新启用',
  'prompt.category': '分类',
  'prompt.categoryPh': '如：开发流程（留空自动归入「临时」）',
  'prompt.tags': '标签',
  'prompt.tagsPh': '逗号分隔，如：review, 质量',
  'prompt.content': '内容',
  'prompt.contentPh': '在这里编写提示词正文…\n支持 {{date}}、{{time}} 变量，注入时自动展开。',
  'prompt.usage': '已注入 {n} 次',
  'prompt.lastUsed': '最近注入：{time}',
  'prompt.neverUsed': '从未注入过',
  'prompt.rounds': '次数',
  'prompt.cadence': '间隔',
  'prompt.roundsHint': '0=无限；1=只注入一次',
  'prompt.everyHint': '0=只注入一次；1=每回合；N=每 N 回合一次',
  'prompt.onceOnly': '只注入一次',
  'prompt.effectOnce': '一次性：下一轮出现一次后自动结束',
  'prompt.effectInfinite': '无限次：每回合出现，持续到手动停止',
  'prompt.effectInfiniteCadence': '无限次：每 {n} 回合出现一次，持续到手动停止',
  'prompt.effectFinite': '共 {n} 次：每回合出现，用尽自动结束',
  'prompt.effectFiniteCadence': '共 {n} 次：每 {m} 回合出现一次，用尽自动结束',
  'prompt.roundsInvalid': '次数必须是 ≥0 的整数（0 = 无限次）',
  'prompt.everyInvalid': '间隔必须是 ≥0 的整数（0 = 只注入一次）',
  'prompt.injectOnceBtn': '注入一次',
  'prompt.injectOnceBtnHint': '只注入一次：下一轮出现后自动结束',
  'prompt.injectInfiniteBtn': '持续注入',
  'prompt.injectInfiniteBtnHint': '每回合出现，直到手动停止',
  'prompt.customBtn': '自定义',
  'prompt.customBtnHint': '自由设置次数与间隔',
  'prompt.injectNowBtn': '⚡ 立即注入',
  'prompt.injectNowBtnHint': '立刻生效一次（当前回合/马上唤醒），只注入一次，不受次数与间隔影响',
  'prompt.injectedNow': '已立即注入「{name}」：当前回合生效，仅此一次（不受次数/间隔影响）',
  'prompt.injectedNowFallback': '已立即注入「{name}」（插话未送达，将在下一轮生效）',
  'prompt.collapseCustom': '收起',
  'prompt.quickTitle': '临时注入',
  'prompt.quickDesc': '不建提示词也能注入：直接输入内容点「注入一次」，会自动存入提示词库（分类留空归入「临时」），一次操作同时入库并生效。',
  'prompt.quickNamePh': '名称（可选，留空取内容首行）',
  'prompt.quickCategoryPh': '分类（可选，留空归入「临时」）',
  'prompt.contentRequired': '内容不能为空',
  'prompt.error': '{message}',
  'prompt.loadFailed': '加载失败：{message}',
  'prompt.injected': '已注入「{name}」：{rounds}{cadence}，模型下一轮生效{ending}',
  'prompt.injectedOnceEnding': '，之后自动结束',
  'prompt.injectedFiniteEnding': '，用尽自动结束',
  'prompt.injectedInfiniteEnding': '，直到手动停止',
  'prompt.injectInfiniteShort': '持续注入',
  'prompt.everyTurnParen': '（每回合出现）',
  'prompt.injectCadenceParen': '（每 {n} 回合出现）',
  'prompt.removed': '已移除注入',
  'prompt.reload': '刷新',
  'prompt.newCategory': '新分类',
  'prompt.newCategoryPh': '输入分类名，回车确认',
  'prompt.deleteCategory': '删除分类',
  'prompt.renameCategory': '重命名分类',
  'prompt.renamePh': '输入新分类名，回车确认',
  'prompt.categoryRemoved': '已删除分类「{name}」{moved}',
  'prompt.categoryDeleted': '已删除分类「{name}」',
  'prompt.categoryMoved': '，{count} 条提示词已移到未分类',
  'prompt.categoryExists': '分类「{name}」已存在，已为你选中',
  'prompt.categoryRenamed': '已重命名「{from}」→「{to}」{renamed}',
  'prompt.categoryRenamedSuffix': '，{count} 条提示词已同步',
  'prompt.unsavedChanges': '有未保存的修改',
  // 无限画板 / 会话评审 / 移动端补充文案（2026-09-16 i18n）
  'canvas.tab.label': '画板',
  'canvas.toolbar.view': '视角',
  'canvas.toolbar.viewFilter': '视角筛选',
  'canvas.view.session': '本会话',
  'canvas.view.project': '本项目',
  'canvas.view.global': '所有项目',
  'canvas.search.placeholder': '搜索画板节点…',
  'canvas.action.path': '路径上板',
  'canvas.action.note': '便签',
  'canvas.action.catalog': '搜索上板',
  'canvas.action.resetView': '复位视角',
  'canvas.action.pin': '上板',
  'canvas.action.cancel': '取消',
  'canvas.action.close': '关闭',
  'canvas.action.search': '搜索',
  'canvas.action.remove': '移除',
  'canvas.action.migrate': '迁移',
  'canvas.action.openDefault': '用默认应用打开',
  'canvas.meta.count': '{visible}/{total} 张',
  'canvas.meta.hits': ' · 命中 {count}',
  'canvas.sync.conflict': ' · ⚠️ 冲突，请刷新',
  'canvas.sync.saving': ' · 保存中',
  'canvas.sync.offline': ' · 未连接后端',
  'canvas.sync.synced': ' · 已同步',
  'canvas.sync.localOnly': ' · 仅本地保存',
  'canvas.node.unnamed': '未命名',
  'canvas.node.unverified': '未验证',
  'canvas.scope.global': '全局',
  'canvas.scope.currentSession': '当前会话',
  'canvas.scope.otherSession': '其他会话',
  'canvas.scope.session': '会话',
  'canvas.note.defaultName': '便签',
  'canvas.save.markdownText': 'Markdown 文本',
  'canvas.save.downloaded': '已下载到浏览器默认下载目录',
  'canvas.content.truncated': '…（内容过长，已截断）',
  'canvas.error.conflict': '画板已被其他会话修改，请刷新页面加载最新内容',
  'canvas.error.unreachable': '网络错误（宿主不可达）',
  'canvas.error.http': '请求失败',
  'canvas.error.unknown': '未知错误',
  'canvas.toast.pinned': '已上板：{title}',
  'canvas.toast.notePinned': '便签已上板',
  'canvas.toast.noPath': '没有可复制的路径',
  'canvas.toast.copiedId': '已复制 ID',
  'canvas.toast.copiedTitle': '已复制标题',
  'canvas.toast.copiedPath': '已复制路径',
  'canvas.toast.copiedRef': '已复制引用串',
  'canvas.toast.copyFailed': '复制失败',
  'canvas.toast.noLocalPath': '该节点没有本地路径可打开',
  'canvas.toast.opened': '已用默认应用打开：{title}',
  'canvas.toast.openedFolder': '已在文件管理器中打开所在文件夹：{title}',
  'canvas.toast.openFailed': '打开失败：{message}',
  'canvas.toast.noContent': '该节点没有可保存的内容',
  'canvas.toast.saved': '已保存：{title}',
  'canvas.toast.savedWith': '已保存：{title}（{message}）',
  'canvas.toast.saveFailed': '保存失败：{message}',
  'canvas.toast.migrateOffline': '画板未连接后端，无法迁移归属',
  'canvas.toast.migrateConflict': '画板已被其他会话修改，请刷新后重试',
  'canvas.toast.migrateFailed': '迁移失败：{message}',
  'canvas.toast.migrated': '归属已迁移',
  'canvas.toast.jumping': '正在跳转到会话：{name}',
  'canvas.toast.removed': '已从画板移除',
  'canvas.type.folder': '文件夹',
  'canvas.type.markdown': 'Markdown',
  'canvas.type.plainText': '纯文本',
  'canvas.type.image': '图片',
  'canvas.type.media': '音视频',
  'canvas.type.file': '文件',
  'canvas.board.aiZone': 'AI 便签区 · AI 新放的便签落在这里，可拖走',
  'canvas.board.hint': '拖空白处平移 · 空格+拖 也可平移 · 滚轮缩放（中心为指针）· 缩放 {percent}%',
  'canvas.board.lod': ' · 远看简化模式',
  'canvas.board.viewport': ' · 视口 {visible}/{total}',
  'canvas.card.aiPlaced': 'AI 放置',
  'canvas.card.unverified': '未验证',
  'canvas.card.preview': '预览',
  'canvas.card.save': '保存',
  'canvas.card.saveTitle': '保存内容到本机文件',
  'canvas.card.open': '打开',
  'canvas.card.openTitle': '用系统默认应用打开',
  'canvas.card.openFolder': '所在文件夹',
  'canvas.card.openFolderTitle': '在系统文件管理器中打开该文件所在的文件夹（Finder / 资源管理器）',
  'canvas.card.migrate': '归属',
  'canvas.card.migrateTitle': '迁移节点归属（本会话/本项目/所有项目可见）',
  'canvas.card.jump': '跳转',
  'canvas.card.jumpTitle': '跳转到该节点所属会话',
  'canvas.card.copyId': '复制 ID',
  'canvas.card.copyTitle': '复制标题',
  'canvas.card.copyPath': '复制路径',
  'canvas.card.copyRef': '引用',
  'canvas.card.remove': '移除',
  'canvas.card.resizeAria': '拖动调整卡片大小',
  'canvas.card.resizeTitle': '拖动调整大小',
  'canvas.card.editorMarkdown': '写一段 Markdown…',
  'canvas.card.editorPlain': '写一段纯文本…',
  'canvas.card.imagePreview': '图片预览',
  'canvas.card.audio': '音频',
  'canvas.card.video': '视频',
  'canvas.card.folderNoBrowse': ' · 暂不支持内嵌浏览',
  'canvas.dialog.path.title': '路径上板',
  'canvas.dialog.path.desc': '粘贴本地路径即可生成卡片。暂不校验文件是否存在，卡片会标「未验证」。',
  'canvas.dialog.path.label': '本地路径',
  'canvas.dialog.path.detected': '将识别为：{glyph} {label}',
  'canvas.dialog.note.title': '便签上板',
  'canvas.dialog.note.aria': '新建便签',
  'canvas.dialog.note.desc': '内容存在画板里，不指向任何文件。',
  'canvas.dialog.note.defaultTitle': '未命名便签',
  'canvas.dialog.field.title': '标题',
  'canvas.dialog.field.type': '类型',
  'canvas.dialog.field.content': '内容',
  'canvas.dialog.catalog.title': '搜索上板',
  'canvas.dialog.catalog.desc': '搜索本机文件，选中即上板。',
  'canvas.dialog.catalog.keyword': '关键字',
  'canvas.dialog.catalog.placeholder': '合同 / 设计稿 / 录音…',
  'canvas.dialog.catalog.scopeAria': '搜索范围',
  'canvas.dialog.catalog.scopeLocal': '本机全部',
  'canvas.dialog.catalog.scopeProject': '当前项目',
  'canvas.dialog.catalog.searching': '搜索中…',
  'canvas.dialog.catalog.error': '本地搜索不可用',
  'canvas.dialog.catalog.noMatch': '没有匹配的文件',
  'canvas.dialog.catalog.prompt': '输入关键字搜索本机文件',
  'canvas.dialog.preview.aria': '预览',
  'canvas.dialog.preview.noteOnly': '画板内便签',
  'canvas.dialog.preview.unverified': ' · 路径未验证',
  'canvas.dialog.preview.empty': '（空内容）',
  'canvas.dialog.preview.enableImage': '启用画板模块后可预览真实图片',
  'canvas.dialog.preview.enableMedia': '启用画板模块后可播放真实文件',
  'canvas.dialog.preview.unsupported': '此类素材暂不在浏览器内渲染（Word / PDF / 文件夹等）。',
  'canvas.dialog.remove.aria': '确认移除',
  'canvas.dialog.remove.title': '从画板移除？',
  'canvas.dialog.remove.body': '将移除「{title}」。只从画板拿掉，不删除源文件。',
  'canvas.dialog.remove.bodyWithPath': '将移除「{title}」。只从画板拿掉，不删除源文件（{path}）。',
  'canvas.dialog.migrate.title': '迁移归属',
  'canvas.dialog.migrate.body': '「{title}」将移动到：',
  'canvas.dialog.migrate.sessionDesc': '归当前会话（在别的会话打开画板看不到它，除非切「所有项目」）',
  'canvas.dialog.migrate.projectDesc': '项目级：当前项目内所有会话都能看到',
  'canvas.dialog.migrate.globalLabel': '所有项目可见',
  'canvas.dialog.migrate.globalDesc': '全局：任何会话、任何视角都能看到',
  'advisor.level.conversation': '本次评审会话约束',
  'advisor.level.session': '本会话约束',
  'advisor.level.project': '本项目约束',
  'advisor.level.global': '全局约束',
  'advisor.status.disabled': '已停用',
  'advisor.status.idle': '空闲',
  'advisor.status.reviewing': '评审中',
  'advisor.status.paused': '已暂停',
  'advisor.status.halted': '已终止',
  'advisor.severity.info': 'info · 记录',
  'advisor.severity.nit': 'nit · 建议',
  'advisor.severity.concern': 'concern · 关注',
  'advisor.severity.blocker': 'blocker · 阻断',
  'advisor.severity.answer': '回答',
  'advisor.outcome.delivered': '已送达',
  'advisor.outcome.recorded': '已记录',
  'advisor.outcome.answered': '已回答',
  'advisor.outcome.suppressed': '已抑制',
  'advisor.outcome.noNote': '无建议',
  'advisor.outcome.dropped': '已丢弃',
  'advisor.outcome.failed': '评审失败',
  'advisor.outcome.cancelled': '已取消',
  'advisor.ago.none': '暂无活动',
  'advisor.ago.justNow': '刚刚',
  'advisor.ago.seconds': '{count} 秒前',
  'advisor.ago.minutes': '{count} 分钟前',
  'advisor.ago.hours': '{count} 小时前',
  'advisor.workspace.unknown': '工作空间未知',
  'advisor.workspace.unknownShort': '未知',
  'advisor.header.toggle.titleOff': 'Advisor 面板显示已关闭；点击可打开设置',
  'advisor.capsule.aria': '展开会话评审面板',
  'advisor.capsule.title': '展开会话评审面板（按住可沿右边缘上下拖动）',
  'advisor.unread.aria': '{count} 条未读评审',
  'advisor.panel.aria': '会话评审悬浮面板',
  'advisor.panel.title': '会话评审',
  'advisor.panel.collapse': '折叠',
  'advisor.panel.collapseAria': '折叠 Advisor 面板',
  'advisor.statusStrip.aria': 'Advisor 运行状态',
  'advisor.switch.title': '仅切换当前会话；不会修改全局默认开关',
  'advisor.switch.on': '本会话已启用',
  'advisor.switch.off': '本会话未启用',
  'advisor.model.unresolved': '模型未解析',
  'advisor.gate.failed': '模型门禁未通过：{reason}',
  'advisor.gate.configIncomplete': 'provider/model 必须同时填写或同时留空',
  'advisor.gate.modelUnavailable': '当前会话模型不可用',
  'advisor.notice.dismiss': '关闭提示',
  'advisor.tabs.aria': '评审数据视图',
  'advisor.tab.scopes': '约束',
  'advisor.tab.live': '实时',
  'advisor.tab.history': '记录',
  'advisor.tab.settings': '设置',
  'advisor.live.aria': '实时评审流',
  'advisor.live.emptyEnabled': '暂无评审活动。新的评审会在这里实时出现。',
  'advisor.live.emptyDisabled': '未启用：可使用上方会话开关，或在下方设置中开启 Advisor。',
  'advisor.live.backToLatest': '回到最新',
  'advisor.instructions.aria': 'Advisor 指令区',
  'advisor.instructions.placeholder': '给会话评审发指令…（Enter 发送，Shift+Enter 换行）',
  'advisor.instructions.send': '发送',
  'advisor.instructions.hint': '评审建议按严重度实时送达（nit/concern/blocker 走 steer，info 默认仅记录）；指令框提问会立即触发 Advisor 回答并注入会话流。',
  'advisor.conversation.statsTitle': '评审员持续会话已占用的上下文（字符数估算，中文 1 字≈1 token；对比模型上下文窗口判断是否新建评审会话）',
  'advisor.conversation.epoch': '评审会话 #{epoch}',
  'advisor.conversation.label': '评审会话',
  'advisor.conversation.contextCount': '上下文 {count} 条',
  'advisor.conversation.reset': '新建评审会话',
  'advisor.conversation.resetConfirm': '新建评审会话将清空评审员的全部上下文与记忆（评审员从零开始）。\n确认后可在第一条指令中告知背景信息。',
  'advisor.conversation.resetTitle': '清空评审员持续会话（上下文+记忆），从零开始；适合换任务/控制上下文长度',
  'advisor.pending.toggle': '待消费指令 ({count})',
  'advisor.pending.empty': '暂无待消费指令',
  'advisor.pending.consuming': '消费中',
  'advisor.pending.waiting': '待消费',
  'advisor.pending.clear': '清空待消费指令',
  'advisor.action.retry': '重试',
  'advisor.action.save': '保存',
  'advisor.action.saving': '保存中…',
  'advisor.history.aria': '历史评审记录',
  'advisor.history.sessionFilter': '会话筛选',
  'advisor.history.sessionCurrent': '当前会话',
  'advisor.history.sessionAll': '全部会话',
  'advisor.history.severityFilter': '严重度筛选',
  'advisor.history.severityAll': '全部严重度',
  'advisor.history.severityAnswer': '回答',
  'advisor.history.timeFilter': '时间筛选',
  'advisor.history.timeAll': '全部时间',
  'advisor.history.time24h': '最近 24 小时',
  'advisor.history.time7d': '最近 7 天',
  'advisor.history.time30d': '最近 30 天',
  'advisor.history.workspacePlaceholder': '工作空间（可选）',
  'advisor.history.workspaceFilter': '工作空间筛选',
  'advisor.history.query': '查询',
  'advisor.history.empty': '当前筛选下暂无评审记录。',
  'advisor.history.loadMore': '加载更多',
  'advisor.loading.events': '正在连接 Advisor 实时流…',
  'advisor.loading.records': '正在加载历史记录…',
  'advisor.loading.scopes': '正在加载约束…',
  'advisor.loading.settings': '正在加载设置…',
  'advisor.loading.short': '加载中…',
  'advisor.error.statusLoad': '状态加载失败：{message}',
  'advisor.error.eventsLoad': '实时流加载失败：{message}',
  'advisor.error.recordsLoad': '历史加载失败：{message}',
  'advisor.error.scopesLoad': '约束加载失败：{message}',
  'advisor.error.scopesSave': '约束保存失败：{message}',
  'advisor.error.configLoad': '设置加载失败：{message}',
  'advisor.error.rebuildFailed': '实时游标已过期，历史重建失败：{message}',
  'advisor.error.noDetail': '操作失败（无错误详情）',
  'advisor.notice.reconnected': '连接已恢复，正在重新同步 Advisor 事件…',
  'advisor.notice.instructionSent': '指令已发送，Advisor 正在回答（回答会直接注入会话流）',
  'advisor.notice.conversationReset': '已新建评审会话（#{epoch}）——可在第一条指令中告知评审员背景信息',
  'advisor.notice.instructionsCleared': '已清空 {count} 条待消费指令',
  'advisor.notice.sessionEnabled': '本会话 Advisor 已启用',
  'advisor.notice.sessionDisabled': '本会话 Advisor 已停用',
  'advisor.notice.configSaved': 'Advisor 设置已保存并生效',
  'advisor.notice.scopeSaved': '{level}已保存，下次评审立即生效',
  'advisor.card.aria': '会话评审 {reviewId}',
  'advisor.card.instructions': '执行指令 ×{count}',
  'advisor.card.sessionEpoch': '会话 #{epoch}',
  'advisor.card.qa': ' · 问答',
  'advisor.card.thisRound': ' · 本轮 {count} 条',
  'advisor.card.collapse': '收起 ▴',
  'advisor.card.expand': '展开 ▾',
  'advisor.card.noInputSnapshot': '历史终态记录不包含输入快照',
  'advisor.card.reviewing': '评审中…',
  'advisor.card.suppressedNote': '已抑制：此条建议被闸门拦截（去重 / 空泛抑制 / 每轮一条），未注入主会话',
  'advisor.card.retryable': '（可重试）',
  'advisor.card.errorSep': '：',
  'advisor.delivery.steer': '已送达 ✓',
  'advisor.delivery.inject': '已注入 ✓',
  'advisor.scopes.aria': '评审员约束',
  'advisor.scopes.boundaryError': '约束区域渲染出错：{message}（详见浏览器控制台）',
  'advisor.scopes.hint': '四层级约束拼接进评审员系统提示词（冲突时越局部越优先）；保存后立即生效。',
  'advisor.scopes.conversationLabel': '{level}（随「新建评审会话」清空）',
  'advisor.scopes.conversationPlaceholder': '只对本次评审会话生效…（可多行，多条指令一次写）',
  'advisor.scopes.sessionLabel': '{level}（本会话一直有效）',
  'advisor.scopes.sessionPlaceholder': '只对本会话生效…',
  'advisor.scopes.projectLabel': '{level}（工作区 {workspace} 的所有会话共享）',
  'advisor.scopes.projectPlaceholder': '对本项目所有会话生效…',
  'advisor.scopes.globalLabel': '{level}（所有项目、所有会话都生效）',
  'advisor.scopes.globalPlaceholder': '对所有项目所有会话生效…（如：评审意见一律用中文、不要重复已提过的建议）',
  'advisor.context.chars': '{count} 字',
  'advisor.settings.title': '会话评审设置',
  'advisor.settings.masterSwitchHint': '模块总闸（启用/停用）在「Memory Evolve 设置」Tab 的配置区控制',
  'advisor.settings.showCapsule': '显示悬浮胶囊按钮',
  'advisor.settings.infoInjectTitle': 'info 是最低等级建议：默认只记录不注入会话；开启后以注入（非打断）方式送达',
  'advisor.settings.infoInject': 'info 级建议也注入会话',
  'advisor.settings.provider': '供应商（Provider）',
  'advisor.settings.model': '模型（Model）',
  'advisor.settings.inheritPlaceholder': '留空则继承会话',
  'advisor.settings.systemPrompt': '评审系统提示词',
  'advisor.settings.promptBuiltin': '（使用内置默认提示词，编辑后保存即为自定义）',
  'advisor.settings.promptCustom': '（自定义）',
  'advisor.settings.promptPlaceholder': '留空使用内置评审提示词',
  'advisor.settings.restore': '恢复默认提示词',
  'advisor.settings.restoreTitle': '恢复为内置默认提示词（保存后立即生效，输入框显示最新内置默认）',
  'advisor.settings.overrideHint': '全局默认开关不会清除当前会话 override；会话级启停请使用上方状态条。',
  'advisor.settings.save': '保存设置',
  'advisor.settings.providerModelPair': 'provider 与 model 必须同时填写，或同时留空以继承会话模型。',
  'mobile.moreActions': '更多操作',
  // COI/提示词迁移补齐键（2026-09-16 i18n）
  'coi.status.queued': '排队中',
  'coi.status.running': '运行中',
  'coi.status.completed': '已完成',
  'coi.status.failed': '失败',
  'coi.status.killed': '已终止',
  'coi.status.interrupted': '中断',
  'coi.ago.justNow': '刚刚',
  'coi.ago.seconds': '{count} 秒前',
  'coi.ago.minutes': '{count} 分钟前',
  'coi.ago.hours': '{count} 小时前',
  'coi.sep.colon': '：',
  'coi.sep.paren': '（{value}）',
  'coi.error.noDetail': '操作失败（无错误详情）',
  'coi.tasks.deleteFailed': '删除失败',
  'coi.tasks.deleted': '已删除',
  'coi.adapters.saveFailed': '保存失败',
  'coi.adapters.opFailed': '操作失败',
  'coi.adapters.readFailed': '读取失败',
  'coi.adapters.avgMs': '⏱ 均耗时 {minutes} 分钟',
  'coi.adapters.avgMsTitle': '历史 completed 任务的平均耗时（de_coi_adapters 同源）',
  'prompt.untitledName': '未命名提示词',
  'prompt.deleteCategoryConfirm': '确定删除分类「{name}」？{hint}',
  'prompt.quotedTitle': '「{name}」',
  'prompt.plusGlyph': '＋',
  // mermaid 渲染器 / 版本页补漏（2026-09-16 i18n）
  'mermaid.renderFailed': '⚠ mermaid 渲染失败，已保留代码（可复制修正）',
  'mermaid.renderFailedDetail': '⚠ mermaid 渲染失败：{detail}，已保留代码（可复制修正）',
  'mermaid.download': '下载',
  'mermaid.downloadTitle': '下载此图为 SVG（矢量，可无损缩放）',
  'version.sep.colon': '：',
}

/** English dictionary (same key set). */
export const en: Record<MemoryEvolveKey, string> = {
  'tab.label': 'Skill Manager',
  'tab.label.alt': 'Skill Manager',
  'header.title': 'Skill Manager',
  'header.subtitle': 'Manage every skill · custom dirs · enable/disable · view & edit',
  'search.placeholder': 'Search skills by name, description, or when-to-use…',
  'search.empty': 'No matching skills',
  'filter.all': 'All',
  'status.enabled': 'Enabled',
  'disable': 'Disable',
  'enable': 'Enable',
  'disabled.badge': 'Disabled',
  'disabled.hint': 'Disabled: excluded from the model skill catalog',
  'protected.badge': 'System',
  'protected.hint': 'System skill (project source) — cannot be disabled',
  'toggle.failed': 'Toggle failed: {message}',
  'manage.dirs': 'Manage custom skill directories',
  'dirs.title': 'Custom Skill Directories',
  'dirs.help': 'Add directories containing skills (<dir>/<skill>/SKILL.md or <dir>/<skill>.md layouts). Directories persist in the plugin state.json and reload automatically after restart; paths overlapping an existing skill root are rejected.',
  'dirs.placeholder': 'Absolute path, e.g. ~/.hermes/skills/…',
  'dirs.add': 'Add',
  'dirs.remove': 'Remove',
  'dirs.empty': 'No custom directories yet',
  'dirs.missing': 'Directory missing',
  'pager.prev': 'Prev',
  'pager.next': 'Next',
  'pager.page': 'Page {page} / {total}',
  'skills.count': '{count} skills',
  'roots.count': '{count} roots',
  'pane.skills': 'Skills',
  'pane.files': 'Files',
  'pane.editor': 'Editor',
  'no.skill.selected': 'Select a skill on the left to start browsing',
  'no.root': 'This skill has no browsable local directory',
  'no.entries': 'Empty directory',
  'no.file': 'Select a text file to view or edit',
  'not.text': 'Not a text file — cannot preview',
  'too.large': 'File exceeds the 512 KiB read cap',
  'read.failed': 'Read failed: {message}',
  'write.failed': 'Save failed: {message}',
  'save': 'Save',
  'saving': 'Saving…',
  'saved': 'Saved',
  'edit': 'Edit',
  'cancel': 'Cancel',
  'discard': 'Discard',
  'dirty.hint': 'Unsaved changes',
  'readonly': 'Read-only',
  'bytes': '{size} B',
  'kib': '{size} KiB',
  'mib': '{size} MiB',
  'dir.up': 'Parent directory',
  'open.folder': 'Open directory',
  'source.badge': '{source}',
  'invocable': 'Invocable',
  'when.to.use': 'When to use',
  'description': 'Description',
  'resource.directory': 'Directory',
  'resource.url': 'Link',
  'resource.opaque': 'Resource',
  'refresh': 'Refresh',
  'loading.skills': 'Loading skills…',
  'loading.dir': 'Loading…',
  'tree.collapse': 'Collapse',
  'tree.expand': 'Expand',
  'path': 'Path',
  'root.label': 'Root',
  'editor.placeholder': 'Select a text file in the tree on the left to start editing.',
  'status.ready': 'Ready',
  'status.skill': 'Skill',
  'status.file': 'File',
  'status.unsaved': 'Unsaved',
  'status.saved': 'Saved',
  'confirm.discard.title': 'Discard unsaved changes?',
  'confirm.discard.body': 'Your changes to {name} are not saved. Switching files will lose them.',
  'confirm.discard.ok': 'Discard changes',
  'mtime.label': 'Modified {time}',
  'open.in.new.tab': 'Open in new tab',
  'preview': 'Preview',
  'memoryTab.label': 'Memory',
  'memoryTab.label.pending': '🔴 Memory ({count})',
  'skillsTab.label': 'Skills',
  'skillsTab.label.pending': '🔴 Skills ({count})',
  'todosTab.label': 'Todos',
  'todosTab.label.pending': '🔴 Todos ({count})',
  'coiTab.label': 'COI Dispatch',
  'coiTab.label.pending': '🔴 COI Dispatch ({count})',
  'broadcastTab.label': 'Broadcast',
  'broadcast.tab.guide': 'Guide',
  'broadcast.tab.messages': 'Messages',
  'broadcast.tab.rooms': 'Rooms',
  'broadcast.tab.settings': 'Settings',
  'broadcast.settings.wsCoord.title': 'Workspace coordination (ws-coord)',
  'broadcast.settings.wsCoord.desc': 'Resource-occupancy coordination for parallel sessions in one workspace — declare files you will modify (de_ws_declare), auto-register writes, write-conflict detection (soft warning / hard block switchable), and de_ws_status to see "who is running and what they are doing". These switches only control this sub-feature; the "Session broadcast" master switch lives under Memory Evolve Settings → Config.',
  'broadcast.settings.wsCoord.enabled': 'Enable workspace coordination',
  'broadcast.settings.wsCoord.enabled.hint': 'Registers de_ws_declare / de_ws_status / de_ws_release tools + write-conflict detection listeners + the activity snapshot section. Depends on the "Session broadcast" master switch (unavailable while broadcast is off). Off by default',
  'broadcast.settings.wsCoord.snapshot': 'Activity snapshot section',
  'broadcast.settings.wsCoord.snapshot.hint': 'When ≥2 sessions are active in the workspace, inject one [Workspace activity] line into the per-turn snapshot (with the current time and what each session is doing); zero cost with 0-1 active sessions',
  'broadcast.settings.wsCoord.enforce': 'Hard-block mode',
  'broadcast.settings.wsCoord.enforce.hint': 'Off by default (soft mode: trust the AI — conflicts warn but never block); when on, writes to files occupied by other sessions are denied at the tool layer (deny), and the AI sees the reason and adjusts on its own',
  'broadcast.guide.intro.title': 'What is Session Broadcast',
  'broadcast.guide.intro.body': 'Session broadcast = a message channel between DSH sessions: send messages to other sessions (the AI sends them via the de_broadcast send tool) and the receiver sees a "Session broadcast" notice in its next snapshot. Messages are managed like an inbox — subject + summary, auto-deleted once every recipient has read them.',
  'broadcast.guide.send.title': 'How to send',
  'broadcast.guide.send.body': 'Just tell the AI "broadcast to session XX…" (default is one-to-one; the recipient is the other session ID):',
  'broadcast.guide.send.item1': 'One-to-one: give the recipient session ID (send them your "copy session ID" result and their AI can reply to you);',
  'broadcast.guide.send.item2': 'Rooms: multi-member chat rooms that work across working directories — everyone in the room sees the message (send to room:<room-id>);',
  'broadcast.guide.send.item3': 'Project: visible to every session under that working directory (send to project:/absolute-path).',
  'broadcast.guide.inbox.title': 'Inbox (Messages tab)',
  'broadcast.guide.inbox.body': 'The list shows only unread non-room messages by default (read ones are hidden; room messages live inside the room):',
  'broadcast.guide.inbox.item1': 'Filter: unread / all / read; search subject, sender, content; paged 20 per page;',
  'broadcast.guide.inbox.item2': 'Click "expand" for the full text; the red "delete" is an admin delete (hidden from everyone);',
  'broadcast.guide.inbox.item3': 'One-to-one messages are auto-deleted once every recipient has read them (consumed, out of the list).',
  'broadcast.guide.room.title': 'Rooms tab: multi-member chat rooms',
  'broadcast.guide.room.body': 'Rooms = multi-member collaboration chat rooms:',
  'broadcast.guide.room.item1': 'Expand a room to see member presence: 🟢 running = generating right now (you can wait; it sees messages within its turn), ⚪ idle / unknown = turn over or unknown (do not just wait);',
  'broadcast.guide.room.item2': 'Room messages share the inbox filters / search / paging; the creator can kick members and dissolve the room (system notices are sent);',
  'broadcast.guide.room.item3': 'Dissolved rooms keep their records for traceability; members can no longer join or post.',
  'broadcast.guide.alias.title': 'Session aliases: recognize a session at a glance',
  'broadcast.guide.alias.body': 'Give a session a friendly name (≤10 chars) — shown in snapshots, lists and messages as an alias (short ID):',
  'broadcast.guide.alias.item1': 'The "My session" row on top: copy session ID / copy alias, then send it to the other side to start chatting;',
  'broadcast.guide.alias.item2': 'The ⧉ copy-session-ID / ✎ alias buttons at the top right of a session also work.',
  'broadcast.guide.switch.title': 'Switch',
  'broadcast.guide.switch.body': 'Session broadcast is off by default: enable "Session broadcast" under "Config" in the "Memory Evolve Settings" tab, then refresh to reveal this tab.',
  'broadcast.guide.wscoord.title': 'Workspace coordination: parallel work without collisions',
  'broadcast.guide.wscoord.body': 'When several sessions edit the same project in parallel, use the workspace coordination in the "Settings" page to avoid overwriting each other:',
  'broadcast.guide.wscoord.item1': 'Before starting, have the AI "declare which files you will change" (de_ws_declare) — others (and their AIs) can see who is editing what;',
  'broadcast.guide.wscoord.item2': 'Write-time conflict detection: soft mode warns first (default); hard mode can be enabled — writes into files claimed by others are rejected outright;',
  'broadcast.guide.wscoord.item3': 'The "activity" overview (de_ws_status) shows who is running and what they are doing; the switch lives in the Settings page (requires the Session broadcast master switch).',
  'broadcast.mySessionId': 'My session ID',
  'broadcast.copyId': 'Copy',
  'broadcast.copied': 'Copied',
  'broadcast.loading': 'Loading…',
  'broadcast.refresh': 'Refresh',
  'broadcast.messages.empty': '(no messages)',
  'broadcast.messages.sender': 'From',
  'broadcast.messages.to': 'To',
  'broadcast.messages.direct': 'direct',
  'broadcast.messages.room': 'room',
  'broadcast.messages.project': 'project',
  'broadcast.messages.unread': 'unread',
  'broadcast.messages.long': 'long',
  'broadcast.message.expand': 'Expand',
  'broadcast.message.collapse': 'Collapse',
  'broadcast.message.delete': 'Delete',
  'broadcast.message.deleteConfirm': 'Delete this message? (admin action, invisible to everyone)\n\n{subject}',
  'broadcast.message.deleted': 'Deleted',
  'broadcast.copyAlias': 'Copy alias',
  'broadcast.msg.unread': 'unread',
  'broadcast.msg.read': 'read',
  'broadcast.filter.unread': 'Unread',
  'broadcast.filter.all': 'All',
  'broadcast.filter.read': 'Read',
  'broadcast.searchPh': 'Search subject/sender/content…',
  'broadcast.pagePrev': 'Prev',
  'broadcast.pageNext': 'Next',
  'broadcast.pageInfo': 'Page {page}/{total}',
  'broadcast.room.detail': 'Details',
  'broadcast.room.messages': 'Room messages',
  'broadcast.room.messages.empty': '(no room messages)',
  'broadcast.messages.roomInRooms': 'Room messages live inside their room — open it from the Rooms view',
  'broadcast.rooms.empty': '(no rooms)',
  'broadcast.roomSearchPh': 'Search room name…',
  'broadcast.roomStatus.all': 'All',
  'broadcast.roomStatus.active': 'Active',
  'broadcast.roomStatus.dissolved': 'Dissolved',
  'broadcast.roomDays.0': 'Any time',
  'broadcast.roomDays.7': 'Last 7 days',
  'broadcast.roomDays.30': 'Last 30 days',
  'broadcast.room.status.active': 'active',
  'broadcast.room.status.idle': 'idle',
  'broadcast.room.status.dissolved': 'dissolved',
  'broadcast.room.online': '{online}/{total} online',
  'broadcast.room.members': 'Members',
  'broadcast.room.kick': 'Kick',
  'broadcast.room.kickConfirm': 'Kick member {member}? (a system notice is sent; the session loses room access)',
  'broadcast.room.dissolve': 'Dissolve',
  'broadcast.room.dissolveConfirm': 'Dissolve room "{name}"? (soft delete: record kept for traceability, members get a system notice, no further joins/messages)',
  'broadcast.room.dissolved': 'dissolved',
  'broadcast.room.copyId': 'Copy room id',
  'broadcast.room.lastActive': 'Last active',
  'broadcast.room.created': 'Created',
  'broadcast.room.presence.unknown': 'unknown · no activity recorded',
  'header.copySessionId': '⧉ Copy session ID',
  'header.copySessionId.done': '✓ Copied',
  'header.copySessionId.title': 'Copy this session\'s ID (send it to another session: tell its AI your session ID so it can broadcast to you via de_broadcast)',
  'header.setAlias': '✎ Alias',
  'header.setAlias.title': 'Set a session alias (≤10 chars) — shown as your friendly name in the snapshot / broadcast panel / messages',
  'header.setAlias.placeholder': 'alias (≤10 chars)',
  'header.setAlias.save': 'Save',
  'header.setAlias.clear': 'Clear',
  'header.setAlias.saved': 'Alias saved',
  'header.setAlias.cleared': 'Alias cleared',
  'advisor.header.toggle': 'Session Review',
  'advisor.header.toggle.title': 'Open or collapse the Advisor review panel',
  'promptTab.label': 'Prompts',
  'promptTab.label.active': '🔴 Prompts ({count})',
  'settingsTab.label': 'Memory Evolve Settings',
  'settingsTab.label.pending': '🔴 Memory Evolve Settings',
  'settingsTab.feature.guide': 'Guide',
  'settingsTab.feature.config': 'Config',
  'settingsTab.feature.version': 'Version',
  // —— version check & update (phase 1) ——
  'version.current': 'Current version',
  'version.latest': 'Latest version',
  'version.statusLabel': 'Status',
  'version.status.latest': 'Up to date',
  'version.status.outdated': 'Update available',
  'version.status.no-release': 'No releases yet',
  'version.status.unsupported': 'Auto-check unsupported',
  'version.status.unknown': 'Unknown',
  'version.loading': 'Checking…',
  'version.lastError': 'Last check failed',
  'version.checkTime': 'Last checked',
  'version.checking': 'Checking…',
  'version.checkNow': 'Check for updates',
  'version.updating': 'Updating…',
  'version.updateNow': 'Update to {tag}',
  'version.restart.title': 'Restart required',
  'version.restart.hint': 'New code is on disk. Restart dsh web first, then refresh the browser (a page refresh alone will not load the new code).',
  'version.releaseNotes': 'Release notes',
  'version.unsupported.hint': 'Auto-check requires a git clone install. Reinstall with `git clone git@github.com:csyangwen/dsh-memory-evolve.git` to enable it.',
  // status note codes (server sends codes only; text lives here).
  'version.note.no-release': 'No release tags (v0.x.y) on the remote yet.',
  'version.note.outdated': 'A new version is available — update below (restart dsh web afterwards).',
  'version.note.latest-exact': 'You are on the latest release.',
  'version.note.latest-contained': 'Your checkout already contains the latest release (dev-track ahead or synced).',
  'version.note.unsupported': 'Plugin dir is not a git repository or git is unavailable.',
  // error codes (P1-5 / P2-4: dictionary-mapped errors).
  'version.error.bad-request': 'Bad request: {message}',
  'version.error.dirty': 'Update rejected: {message}',
  'version.error.busy': 'Update rejected: {message}',
  'version.error.target-changed': 'Target version changed: {message}',
  'version.error.untrusted': 'Update rejected: {message}',
  'version.error.unsupported': 'Auto-check unsupported: {message}',
  'version.error.error': 'Update failed: {message}',
  'version.error.network': 'Network request failed: {message}',
  'version.error.unknown': 'Unknown error',
  'memoryTab.feature.guide': 'Guide',
  'memoryTab.feature.suggestions': 'Memory suggestions',
  'skillsTab.feature.guide': 'Guide',
  'skillsTab.feature.skills': 'Skill suggestions',
  'skillsTab.feature.skillBrowser': 'Skill manager',
  'todosTab.feature.guide': 'Guide',
  'todosTab.feature.todoSuggestions': 'Todo suggestions',
  'todosTab.feature.todo': 'Todos',
  'modelsTab.label': 'Model Settings',
  'modelsTab.feature.models': 'Model Settings',
  'modelsTab.feature.guide': 'Guide',
  'modelsTab.guide.what.title': 'What is Model Settings',
  'modelsTab.guide.what.body': 'A table view of every DSH provider and model, with per-model plugin-side settings (enabled state, note, reasoning levels). All settings belong to this plugin (models.json) — DSH configuration is never touched and nothing couples to other plugins:',
  'modelsTab.guide.what.item1': 'Columns: enabled switch, provider (with DSH activation state), model (name + ID), context / output capacity, reasoning levels, image-input marker (🖼), note; search and a "show reasoning levels" toggle;',
  'modelsTab.guide.what.item2': 'Per model: enable / disable (a plugin-side availability flag — DSH routing is untouched), note, thinking support, allowed reasoning levels, recommended level, custom levels;',
  'modelsTab.guide.what.item3': 'Settings persist immediately (<memoryDir>/models.json) across restarts.',
  'modelsTab.guide.config.title': 'Per-model settings',
  'modelsTab.guide.config.body': 'Expand a row ("configure levels") to edit reasoning settings:',
  'modelsTab.guide.config.item1': 'Enable / disable: decides which models the de_models tool lists by default (all enabled by default);',
  'modelsTab.guide.config.item2': 'Thinking support: when off the model cannot reason (only the off level remains);',
  'modelsTab.guide.config.item3': 'Recommended level: "auto" follows the model own recommendation by default; you can pin any available level;',
  'modelsTab.guide.config.item4': 'Allowed levels: tick which levels may be used (all by default); custom levels (e.g. ultra) can be added / removed;',
  'modelsTab.guide.config.item5': 'Image input: models explicitly declaring image support show the "🖼 image input" marker (from DSH model capability metadata, read-only); undeclared = unknown, no marker.',
  'modelsTab.guide.tool.title': 'de_models tool (for the AI)',
  'modelsTab.guide.tool.body': 'This module also registers the de_models tool so the AI can query the available model (endpoint) list:',
  'modelsTab.guide.tool.item1': 'Only "enabled" models are returned by default (all=true shows everything incl. disabled), filterable by provider;',
  'modelsTab.guide.tool.item2': 'Each model reports: enabled, DSH-activated, image input support (supportsImage: true / false / null=unknown), thinking support, allowed reasoning levels (incl. recommended and custom), note.',
  'modelsTab.guide.switch.title': 'Switch',
  'modelsTab.guide.switch.body': 'Model Settings are on by default; they can be turned off independently under "Config" in the "Memory Evolve Settings" tab like other modules — the tab and the de_models tool hide, settings data is kept.',
  'modelsTab.searchPh': 'Search provider, model, or note…',
  'modelsTab.showReasoning': 'Show reasoning levels',
  'modelsTab.refresh': 'Refresh',
  'modelsTab.loading': 'Loading…',
  'modelsTab.count': '{total} models · {enabled} enabled',
  'modelsTab.loadFailed': 'Load failed: {message}',
  'modelsTab.empty': '(No models)',
  'modelsTab.enabled': 'Enabled',
  'modelsTab.enable': 'Enable',
  'modelsTab.disable': 'Disable',
  'modelsTab.provider': 'Provider',
  'modelsTab.model': 'Model',
  'modelsTab.capacity': 'Context/Output',
  'modelsTab.reasoning': 'Reasoning',
  'modelsTab.note': 'Note',
  'modelsTab.notePh': 'Add a note…',
  'modelsTab.dormant': 'Inactive',
  'modelsTab.thinking': 'Support thinking',
  'modelsTab.thinkingHint': 'When off, this model cannot reason (only the off level stays available)',
  'modelsTab.thinkingOff': 'Thinking off',
  'modelsTab.supportsImage': '🖼 Image input',
  'modelsTab.supportsImageHint': 'This model explicitly declares image input support (from DSH model capability metadata inputModalities)',
  'modelsTab.recommendedLevel': 'Recommended level',
  'modelsTab.recommendedAuto': 'Auto (follow model recommendation)',
  'modelsTab.levelsNone': 'All disabled',
  'modelsTab.editLevels': 'Configure levels',
  'modelsTab.closeEditor': 'Collapse',
  'modelsTab.editorTitle': 'Available reasoning levels (check = allowed; recommended comes from the model)',
  'modelsTab.recommended': 'Recommended',
  'modelsTab.addLevel': 'Add',
  'modelsTab.removeLevel': 'Remove',
  'modelsTab.levelIdPh': 'Level ID (e.g. ultra)',
  'modelsTab.levelNamePh': 'Display name (e.g. Ultra)',
  'modelsTab.save': 'Save',
  'modelsTab.saving': 'Saving…',
  'modelsTab.cancel': 'Cancel',
  // DSH UI Settings tab (ui-settings-hub): module intro (guide sub-tab) +
  // future extension seat (themes etc.). The real feature (session filter)
  // is a global DOM enhancement independent of this tab; the feature
  // switches (uiSettings.feature.*) are consumed by the "General" sub-tab
  // and broadcast via event for apply() to sync DOM injection.
  'uiSettingsTab.label': 'Web UI Settings',
  'uiSettingsTab.feature.mixed': 'General',
  'uiSettingsTab.feature.guide': 'Guide',
  'uiSettingsTab.features.title': 'Feature switches',
  'uiSettingsTab.features.help': 'Every feature has its own small switch, **all off by default** — you turn them on deliberately; changes apply immediately (features stay under "General" until they mature and get their own categories).',
  'uiSettingsTab.guide.what.title': 'What is Web UI Settings',
  'uiSettingsTab.guide.what.body': 'Style-level tweaks for the DSH web GUI — no framework source changes, pure client-side injection (CSS + DOM enhancement) that survives DSH updates; future extensions (themes etc.) all land in this module.',
  'uiSettingsTab.guide.switch.title': 'Switches',
  'uiSettingsTab.guide.switch.body': 'The module switch lives under "Config" in the "Memory Evolve Settings" tab (off by default); the per-feature switches live in the "General" sub-tab — also all off by default, turned on deliberately.',
  'uiSettingsTab.guide.features.title': 'Features',
  'uiSettingsTab.guide.features.body': 'Each feature has an independent switch in the "General" page; it takes effect immediately:',
  'uiSettingsTab.guide.features.item1': 'Session filter: the left session list shows only active sessions; purely idle ones collapse, one click switches back to all;',
  'uiSettingsTab.guide.features.item2': 'Wide conversation: the middle transcript area widens from about half to about 95%, more comfortable for long messages;',
  'uiSettingsTab.guide.features.item3': 'Wide bubbles: the user message bubble grows from its 525px cap to about 80% width (pairs best with the wide conversation);',
  'uiSettingsTab.guide.features.item4': 'Context warning: the context ring turns yellow above 30% and red above 40% — a nudge to bookmark or start a fresh session;',
  'uiSettingsTab.guide.features.item5': 'Mermaid rendering: mermaid code blocks in messages render into diagrams; on failure they fall back to plain code blocks.',
  // Feature-switch row labels (rendered by the "General" sub-tab).
  'uiSettings.feature.sessionFilter': 'Session filter',
  'uiSettings.feature.sessionFilter.hint': 'The left session list shows only active sessions (purely idle ones collapse; one click switches back to all); the filter bar appears only while this is on',
  'uiSettings.feature.wideChat': 'Wide conversation area',
  'uiSettings.feature.wideChat.hint': 'Widen the conversation transcript/input area from roughly half to about 95% of the right pane (aligned with the tabs bar above)',
  'uiSettings.feature.wideBubble': 'Wide message bubble',
  'uiSettings.feature.wideBubble.hint': 'Widen the user message bubble from its 525px cap to about 80% of the content column (pairs well with "Wide conversation area")',
  'uiSettings.feature.contextWarn': 'Context usage warning',
  'uiSettings.feature.contextWarn.hint': 'The context-usage ring beside the input box turns yellow above 30% occupancy and red above 40%; back to its default color below the threshold',
  'uiSettings.feature.mermaidRender': 'Mermaid diagram rendering',
  'uiSettings.feature.mermaidRender.hint': 'Render mermaid code blocks in messages as diagrams (DSH itself does not render mermaid); the engine loads lazily on first diagram, works on PC and mobile alike, and falls back to the code block on failure',
  // Filter-bar button labels (consumed by session-filter.ts injected DOM).
  'uiSettings.filter.on': 'Running only',
  'uiSettings.filter.off': 'All',
  'uiSettings.running.label': '{count} running',
  'uiSettings.ungrouped': 'Ungrouped',
  // Session bookmarks (independent submodule, bookmarkEnabled off by default):
  'syncTab.label': 'Memory Sync',
  'syncTab.loading': 'Loading…',
  'syncTab.loadFailed': 'Failed to load status: {message}',
  'syncTab.tab.project': 'This project',
  'syncTab.tab.global': 'Global memory',
  'syncTab.tab.remote': 'Shared memory repo',
  'syncTab.section.project': 'Project memory (KEY + project log + archive + project todos)',
  'syncTab.section.global': 'Global memory (device-level, project-independent)',
  'syncTab.section.remote': 'Shared memory repo (device-level config)',
  'syncTab.project.mode.off': 'Disabled (local only)',
  'syncTab.project.mode.off.desc': 'Project memory stays on this machine: no repo, no entry IDs, no reconciliation with any remote',
  'syncTab.project.mode.main': 'Mode A: main code repo (zero config)',
  'syncTab.project.mode.main.desc': 'Project memory lives in a dedicated branch of your code repo (never touches your code). **A public code repo means public memory**',
  'syncTab.project.mode.shared': 'Mode B: shared memory repo',
  'syncTab.project.mode.shared.desc': 'Project memory lives in a dedicated branch of the shared memory repo, fully isolated from your code',
  'syncTab.project.mode.shared.needRemote': 'Shared memory repo is not enabled — switched to "Shared memory repo", please enable and save the URL first',
  'syncTab.status.title': 'Current memory remote',
  'syncTab.status.disabled': 'Disabled — enable sync for this project above to begin',
  'syncTab.status.notInit': 'Enabled, but this project is not initialized yet — pick Mode A or B above to initialize',
  'syncTab.status.remoteKind': 'Memory remote: {kind}',
  'syncTab.status.remoteKindMain': 'main code repo',
  'syncTab.status.remoteKindShared': 'shared memory repo',
  'syncTab.status.remoteKindNone': 'not mounted',
  'syncTab.status.originUrl': 'Remote URL: {url}',
  'syncTab.status.branch': 'Remote branch: {branch}',
  'syncTab.status.counts': '{pending} not pushed · {behind} behind · {conflicts} conflicts',
  'syncTab.status.migrate': 'Legacy memory dir found: {dir} — "Start sync" will migrate it',
  'syncTab.global.title': 'Global memory',
  'syncTab.global.uncommitted': '{n} tracks not pushed (uncommitted + unpushed commits)',
  'syncTab.global.trackMemory': 'Global memory (MEMORY.md)',
  'syncTab.global.trackUser': 'User profile (USER.md)',
  'syncTab.global.trackDaily': 'Daily logs (daily/*.md)',
  'syncTab.global.trackTodo': 'Todos: life/work/daily (TODOS-*.md)',
  'syncTab.global.hint': 'Global memory (user profile / daily logs / todos) belongs to no single project — all projects share this one set of switches; push always requires your explicit click',
  'syncTab.global.sync': 'Fetch & merge',
  'syncTab.global.push': 'Push',
  'syncTab.global.notInit': 'Shared memory repo is not enabled — global memory is unavailable; enable and save the URL on the "Shared memory repo" page first',
  'syncTab.remote.desc': 'One shared memory repo for the whole device: project Mode B and global memory (user profile / daily logs / todos) both reference it — enable and save the URL once.',
  'syncTab.remote.placeholder': 'Paste a shared memory repo URL (e.g. ssh://git@.../dsh-memories.git)',
  'syncTab.remote.save': 'Enable & save',
  'syncTab.remote.modify': 'Modify & save',
  'syncTab.remote.current': 'Current shared memory repo: {url}',
  'syncTab.remote.mode.off': 'Disabled',
  'syncTab.remote.mode.off.desc': 'Project Mode B and global memory unavailable; synced data and the URL are kept',
  'syncTab.remote.mode.on': 'Enabled',
  'syncTab.remote.mode.on.desc': 'Project Mode B and global memory available; save the repo URL first',
  'syncTab.remote.disable': 'Disable shared memory repo',
  'syncTab.remote.switchHint': 'Disabling turns off the shared memory repo (project Mode B and global memory become unavailable); synced data and the URL are kept, re-enable anytime.',
  'syncTab.actions.sync': 'Fetch & merge',
  'syncTab.actions.push': 'Push',
  'syncTab.actions.nothingToSync': 'Nothing to sync — enable this project or a global track first',
  'syncTab.conflicts.title': 'Conflicts ({count} — both devices edited the same entry)',
  'syncTab.conflicts.titleGlobal': 'Global {track}: {count} pending conflicts (both devices edited the same entry)',
  'syncTab.conflicts.base': 'Base',
  'syncTab.conflicts.ours': 'Ours',
  'syncTab.conflicts.theirs': 'Theirs',
  'syncTab.conflicts.oursBtn': 'Use ours',
  'syncTab.conflicts.theirsBtn': 'Use theirs',
  'syncTab.conflicts.bothBtn': 'Keep both',
  'syncTab.footnote': 'Writing memory stays real-time local (no Git touched); sync batches up. Conflict markers never hit disk; resolving auto-commits.',
  'bookmarkTab.label': 'Bookmarks',
  'bookmark.tab.list': 'List',
  'bookmark.tab.guide': 'Guide',
  'bookmark.list.title': 'Session bookmarks',
  'bookmark.list.help': 'Click a bookmark to jump to that turn; star ☆ at each turn tail to bookmark, ★ when bookmarked (rename/delete); searchable list; fork from any turn (official mid-turn branch buttons are taken over by Memory Evolve).',
  'bookmark.refresh': 'Refresh',
  'bookmark.loading': 'Loading…',
  'bookmark.empty': '(No bookmarks yet — click ☆ at a turn tail)',
  'bookmark.defaultLabel': 'Turn {n}',
  'bookmark.turn': 'Turn {n}',
  'bookmark.prompt.create': 'Bookmark name (editable):',
  'bookmark.prompt.rename': 'New name:',
  'bookmark.confirm.delete': 'Delete bookmark "{label}"?',
  'bookmark.noSession': 'Cannot determine the current session (refresh the page and retry)',
  'bookmark.search.placeholder': 'Search bookmarks…',
  'bookmark.search.empty': '(No matching bookmarks)',
  'bookmark.star.title.off': '☆ Bookmark this turn (Memory Evolve session bookmarks)',
  'bookmark.star.title.on': '★ Bookmarked: {label} (Memory Evolve — click to rename/delete)',
  'bookmark.menu.rename': 'Rename',
  'bookmark.menu.delete': 'Delete',
  'bookmark.action.jump': 'Jump',
  'bookmark.action.fork': 'Fork',
  'bookmark.action.rename': 'Rename',
  'bookmark.action.delete': 'Delete',
  'bookmark.fork.title': 'Fork from this turn (Memory Evolve enhancement)',
  'bookmark.fork.confirm': 'Officially you can only fork from the last message. Fork from this turn ({n}) anyway? (Memory Evolve enhancement)',
  'bookmark.fork.working': 'Creating fork session…',
  'bookmark.fork.ok': 'New session created: {id} (see the session list on the left)',
  'bookmark.jump.hint': 'Click to jump to this turn',
  'bookmark.jumping': 'Locating…',
  'bookmark.jump.ok': 'Jumped to "{label}"',
  'bookmark.jump.notFound': 'Could not find the message for "{label}" (may be compacted or outside the loaded window)',
  'bookmark.jump.noChat': 'Chat tab not found — cannot jump',
  'bookmark.renamed': 'Renamed',
  'bookmark.deleted': 'Deleted',
  'bookmark.error': 'Failed: {message}',
  'bookmark.guide.what.title': 'What are session bookmarks',
  'bookmark.guide.what.body': 'Star any completed turn, then jump back to it from the list in one click; you can also fork an official branch session from any turn — start a new line from a mid-way decision point. Data lives in a plugin sidecar (official session logs are never touched); the official mid-turn branch buttons are taken over by this plugin (a confirm dialog, then the official fork path).',
  'bookmark.guide.star.title': 'How to star',
  'bookmark.guide.star.body': 'Every completed turn has a ☆ button at its tail: click it, name it (default "Turn N") and it is bookmarked; ★ means bookmarked — click again to rename or delete. The small icon does not crowd Copy / Branch.',
  'bookmark.guide.list.title': 'List and jump',
  'bookmark.guide.list.body': 'This tab lists every bookmark of the current session (label, turn, time, summary). Click to jump: it switches back to the Chat tab and scrolls to that turn; if the target lies outside the loaded history window it fetches older messages first.',
  'bookmark.guide.switch.title': 'Switch',
  'bookmark.guide.switch.body': 'Off by default; enable "Session bookmarks" under Memory Evolve Settings → Config. When off, stars and this tab hide; the sidecar file is kept.',
  'panel.guide.bookmark.title': 'Session bookmarks',
  'panel.guide.bookmark.desc': 'Star any turn and jump back from the list; fork official branch sessions from any turn (including taking over official mid-turn branch buttons). Independent switch, off by default.',
  'panel.config.bookmarkEnabled': 'Session bookmarks',
  'panel.config.bookmarkEnabled.hint': 'Enable session bookmarks: a ☆ star on each completed turn tail + a Bookmarks tab for the list and jump; fork official branch sessions from any turn (list "Fork" button, or click the official branch button — mid-turn buttons are taken over with a confirm dialog). Data lives in <memoryDir>/session-bookmarks.json (per-session, keyed by turn seq). **Independent submodule** (off by default; pure UI + host API, no AI tools); when off, stars and the tab hide, the data file is kept.',
  'panel.config.todoEnabled': 'Todos',
  'panel.config.todoEnabled.hint': 'Enable the dtodo tool, Todos tab, and due reminders. When off, the tab hides immediately and todo writes stop; existing data and the sync track stay intact.',
  // Legacy keys kept for compatibility (old merged memory-tab layout).
  'memoryTab.feature.config': 'Config',
  'memoryTab.feature.todoSuggestions': 'Todo suggestions',
  'memoryTab.feature.skills': 'Skill suggestions',
  'memoryTab.feature.skillBrowser': 'Skill manager',
  'memoryTab.feature.todo': 'Todos',
  // Memory-tab guide (the "Guide" sub-tab: detailed intro of the memory feature itself).
  'memoryTab.guide.tracks.title': 'Five memory tracks: the AI long-term working memory',
  'memoryTab.guide.tracks.body': 'Memory is organized in five tiers by "who should see it"; injection scope narrows by tier and tiers never pollute each other — what should be injected is auto-injected, the rest is read on demand:',
  'memoryTab.guide.tracks.item1': 'User profile (user): who you are — preferences, habits, communication style. Injected into every session, so you never re-introduce yourself;',
  'memoryTab.guide.tracks.item2': 'Long-term memory (memory): global facts — environment, tools, general conventions. Injected into every session;',
  'memoryTab.guide.tracks.item3': 'Key project facts (key): conventions, decisions, architecture, pitfalls of the current project. Injected only into this project sessions, filtered by git branch — each branch keeps its own conventions;',
  'memoryTab.guide.tracks.item4': 'Project log (project): the running record of this project. Never injected; the AI reads it on demand, history is traceable;',
  'memoryTab.guide.tracks.item5': 'Daily log (daily): per-day progress notes. Never injected; read on demand — like a daily work report.',
  'memoryTab.guide.files.title': 'File tabs: read the memory files directly',
  'memoryTab.guide.files.body': 'This tab previews AGENTS.md (global rules) and every memory file. File tabs are read-only — edit through the memory tool or via the actions in this tab, to avoid breaking the §-delimited format:',
  'memoryTab.guide.files.item1': 'Beauty view: each entry is a card (time / branch / tag badges + content), searchable and filterable; a plain-text view shows the raw text;',
  'memoryTab.guide.files.item2': 'The KEY tab lets you manually add long-term project facts (optionally scoped to certain git branches); they are injected next turn after saving;',
  'memoryTab.guide.files.item3': 'Every entry can be edited (writes need confirmation), deleted (exact full-entry match, no accidental deletions), archived / restored to the main track.',
  'memoryTab.guide.branch.title': 'Git branch awareness: different branches, different conventions',
  'memoryTab.guide.branch.body': 'Different branches of the same project can carry completely different conventions; project-level memory tracks the current branch end to end:',
  'memoryTab.guide.branch.item1': 'Key entries can carry a branch-scope marker (no marker = visible on all branches); injection only includes "no marker" + "covers the current branch";',
  'memoryTab.guide.branch.item2': 'Log entries are automatically tagged with their source branch ([git branch name]), so cross-branch reviews never mix things up.',
  'memoryTab.guide.maintain.title': 'Edit & maintain: day-to-day care of the memory',
  'memoryTab.guide.maintain.body': 'All memory maintenance happens right here:',
  'memoryTab.guide.maintain.item1': 'Edit the body only — timestamps / branch / tags are maintained by the program;',
  'memoryTab.guide.maintain.item2': 'Delete: exact full-entry matching (long entries that contain others are never accidentally removed); deletion is irreversible;',
  'memoryTab.guide.maintain.item3': 'Archive / restore: move low-frequency entries out of the main track (kept for reference, no injection), restore them anytime.',
  'memoryTab.guide.suggestions.title': 'Memory suggestions: the AI proposes, you decide',
  'memoryTab.guide.suggestions.body': 'The background review distills "what is worth remembering" into a pending queue — the AI never writes into the memory on its own:',
  'memoryTab.guide.suggestions.item1': 'Approve: optionally edit the text first and pick the target track (long-term memory / user profile / key project facts); it is injected with the next snapshot;',
  'memoryTab.guide.suggestions.item2': 'Archive: no injection, kept for reference, restorable; Reject: discard.',
  'memoryTab.guide.confirm.title': 'The confirmation system: why your approval is required',
  'memoryTab.guide.confirm.body': 'Memory writes genuinely change the AI behavior — once written they enter the context and affect every later reply. So everything goes through your confirmation first: that is the gate of memory evolution. You are in charge.',
  // Skills-tab guide (the "Guide" sub-tab: detailed intro of the skill feature itself).
  'skillsTab.guide.what.title': 'What a skill is: a methodology manual for the AI',
  'skillsTab.guide.what.body': 'A skill = a methodology document for the AI (SKILL.md: name + description + steps). It is injected into every session system prompt — next time the AI meets the same kind of task it follows your process instead of re-inventing it:',
  'skillsTab.guide.what.item1': 'The skill library lives at ~/.agents/skills by default (one directory per skill);',
  'skillsTab.guide.what.item2': 'DSH also scans project skills, bundled skills and custom directories — all visible and manageable in this tab.',
  'skillsTab.guide.how.title': 'How skills form',
  'skillsTab.guide.how.body': 'Methodologies learned the hard way are solidified into skills through two main paths:',
  'skillsTab.guide.how.item1': 'Background review: when the AI notices a recurring pattern it creates a skill, which lands in "skill suggestions" — after your approval it moves into the library;',
  'skillsTab.guide.how.item2': 'The skill_manage tool: just tell the AI "save this process as a skill" and it creates / updates one;',
  'skillsTab.guide.how.item3': 'Create sparingly: only "recurring, hard-won, reusable" skills — every skill is injected into every session and affects the context.',
  'skillsTab.guide.pending.title': 'Skill suggestions',
  'skillsTab.guide.pending.body': 'Review-created skills wait for your confirmation here:',
  'skillsTab.guide.pending.item1': 'Approve: moved into the skill library (~/.agents/skills), injected with the system prompt, immediately usable in every session;',
  'skillsTab.guide.pending.item2': 'Reject: discard the skill.',
  'skillsTab.guide.manager.title': 'Skill manager: browse, edit, custom directories',
  'skillsTab.guide.manager.body': 'The full skill manager (three panes: skill list / directory tree / file view-edit):',
  'skillsTab.guide.manager.item1': 'All skills are grouped by source (user user-* / custom / bundled / project project-*), searchable and filterable;',
  'skillsTab.guide.manager.item2': 'Custom skill directories: add / remove any skill directory (<dir>/<skill>/SKILL.md or <dir>/<skill>.md layout);',
  'skillsTab.guide.manager.item3': 'File browsing & editing: directory tree + text view / edit (scoped to skill directories; out-of-bounds, binary and oversized files are rejected);',
  'skillsTab.guide.manager.item4': 'Disabled-list and custom directories persist across restarts.',
  'skillsTab.guide.disable.title': 'Disable / enable: hide skills you do not want',
  'skillsTab.guide.disable.body': 'One click removes a skill from the model skill catalog (the model no longer sees it and the skill tool refuses to load it):',
  'skillsTab.guide.disable.item1': 'Re-enable anytime; the choice persists;',
  'skillsTab.guide.disable.item2': 'System skills (project source) cannot be disabled by design.',
  'skillsTab.guide.dirs.title': 'Custom skill directories',
  'skillsTab.guide.dirs.body': 'Add / remove your own skill directories in "Skill manager" (e.g. ~/.hermes/skills); paths overlapping an existing skill root are rejected; persisted and reloaded after restart.',
  'skillsTab.guide.restraint.title': 'Creation discipline: restraint is what makes skills effective',
  'skillsTab.guide.restraint.body': 'Skills are injected into every session system prompt and affect context and cache — create sparingly:',
  'skillsTab.guide.restraint.item1': 'Only create skills for "hard, recurring problems you will meet again";',
  'skillsTab.guide.restraint.item2': 'Never create a skill for a one-off or trivial task.',
  // Todos-tab guide (the "Guide" sub-tab: detailed intro of the todo feature itself).
  'todosTab.guide.tracks.title': 'Four todo tracks: everything in its place',
  'todosTab.guide.tracks.body': 'Todos are filed by target, isomorphic to the memory system:',
  'todosTab.guide.tracks.item1': 'Life (life): personal errands;',
  'todosTab.guide.tracks.item2': 'Work (work): cross-project business;',
  'todosTab.guide.tracks.item3': 'This project (project): todos of the current working directory — invisible from other directories, isolated by cwd;',
  'todosTab.guide.tracks.item4': 'Today (daily): per-day todo files, with past days reviewable (grouped by date).',
  'todosTab.guide.add.title': 'How to add',
  'todosTab.guide.add.body': 'Two ways, pick either:',
  'todosTab.guide.add.item1': 'Tell the AI "remember / I need to do X" (optionally say work / life / this project / today) and it files the todo into the right track;',
  'todosTab.guide.add.item2': 'Add manually in this tab input (quadrant and due date optional).',
  'todosTab.guide.pending.title': 'Todo suggestions: the AI cannot assign you work on its own',
  'todosTab.guide.pending.body': 'AI-proposed todos enter a pending queue first, effective only after your confirmation:',
  'todosTab.guide.pending.item1': 'Approve: written into the target track (a todo stays a todo, never becomes memory);',
  'todosTab.guide.pending.item2': 'Archive: kept for reference; Reject: discard.',
  'todosTab.guide.attrs.title': 'Status & attributes',
  'todosTab.guide.attrs.body': 'Every todo carries full metadata to track:',
  'todosTab.guide.attrs.item1': 'Quadrant (important × urgent), due date, optional category;',
  'todosTab.guide.attrs.item2': 'Status: pending / doing / done (completion time stamped) / blocked / cancelled;',
  'todosTab.guide.attrs.item3': 'List / board views: list tabs by track with status / quadrant filters; board shows a 2×2 quadrant grid; each item can be done / restored, inline-edited, deleted (with confirm).',
  'todosTab.guide.view.title': 'Smart view: only what needs attention',
  'todosTab.guide.view.body': 'By default only items needing attention are shown (overdue / due today / current project / important-urgent, max 8) to avoid noise:',
  'todosTab.guide.view.item1': 'Past daily todos are read on demand — open the "past" tab to query history;',
  'todosTab.guide.view.item2': 'Check "show expired" to reveal overdue leftovers (hidden by default).',
  'todosTab.guide.remind.title': 'Due reminders: the AI keeps watch for you',
  'todosTab.guide.remind.body': 'The AI checks todos at the end of every turn and reminds you of overdue / due items in its reply — you never have to keep track yourself.',
  'todo.track.life': 'Life',
  'todo.track.all': 'All',
  'todo.track': 'Track',
  'todo.track.work': 'Work',
  'todo.track.project': 'This project',
  'todo.track.daily': 'Today',
  'todo.track.past': 'Past',
  'todo.projectHint': 'No working directory for this session — project todos unavailable (life/work/today only).',
  'todo.help': 'Four tracks: Life=personal errands; Work=cross-project tasks; This project=the current working directory\'s todos (invisible from other dirs); Today=today\'s tasks (one file per day). Past daily todos (earlier days) are not loaded by default — open the “Past” tab or tick “Show expired” to query history (expired leftovers stay hidden until then). To add: type content, optionally pick a quadrant (important × urgent) and a due date, then hit Add — or just tell me “add a todo, it\'s for work/life/this project/today” and I will file it in the right track.',
  'todo.showExpired': 'Show expired',
  'todo.pastHint': 'Past daily todos are mostly expired leftovers and are hidden by default; tick “Show expired” to view them.',
  'todo.addPlaceholder': 'Type a todo (multi-line ok), pick quadrant/due, add…',
  'todo.add': 'Add',
  'todo.added': 'Todo added',
  'todo.done': 'Done',
  'todo.undone': 'Restore',
  'todo.edit': 'Edit',
  'todo.save': 'Save',
  'todo.cancel': 'Cancel',
  'todo.updated': 'Updated',
  'todo.deleted': 'Deleted',
  'todo.deleteConfirm': 'Delete this todo? This cannot be undone.\n\n{snippet}',
  'todo.due': 'Due',
  'todo.overdue': 'Overdue',
  'todo.all': 'All',
  'todo.filterStatus': 'Status',
  'todo.filterQuadrant': 'Quadrant',
  'todo.status.active': 'Active',
  'todo.status.pending': 'Pending',
  'todo.status.doing': 'Doing',
  'todo.status.done': 'Done',
  'todo.status.blocked': 'Blocked',
  'todo.status.cancelled': 'Cancelled',
  'todo.quadrant': 'Quadrant',
  'todo.quadrant.none': 'Unclassified',
  'todo.quadrant.q1': 'Important & urgent',
  'todo.quadrant.q2': 'Important, not urgent',
  'todo.quadrant.q3': 'Urgent, not important',
  'todo.quadrant.q4': 'Neither',
  'todo.empty': '(No todos yet — add one)',
  // List / Eisenhower board view switch
  'todo.view.mode': 'View',
  'todo.view.list': 'List',
  'todo.view.board': 'Board',
  'todo.board.empty': 'No todos in this quadrant',
  'todo.board.cycleStatus': 'Click to cycle status',
  'memoryTab.cwd': 'Session working directory',
  'memoryTab.loading': 'Loading…',
  'memoryTab.warning': 'These files are §-delimited structured memory. If you open them with a system tool, edit with caution — careless changes can break the format and corrupt memory reads.',
  'memoryTab.readonly': 'Read-only',
  'memoryTab.open': 'Open file',
  'memoryTab.opened': 'Opened with the system tool',
  'memoryTab.empty': '(missing or empty)',
  'memoryTab.noCwd': '(no working directory for this session — project memory unavailable)',
  'memoryTab.truncated': '(content truncated for display)',
  'memoryTab.pagePrev': 'Previous',
  'memoryTab.pageNext': 'Next',
  'memoryTab.pageInfo': 'Page {page}/{total} · {count} entries',
  'memoryTab.viewPretty': 'Pretty view',
  'memoryTab.viewRaw': 'Raw text',
  'memoryTab.searchPlaceholder': 'Search content, time or tag…',
  'memoryTab.noResults': 'No matching entries — try another keyword.',
  'memoryTab.projectTag': 'Project tag',
  'memoryTab.entryCount': '{count} entries',
  'memoryTab.keyAddHelp': 'Manually add a durable project fact (convention/decision/architecture/pitfall); it is written to KEY.md and injected into the context from the next turn on.',
  'memoryTab.keyAddPlaceholder': 'Type a key project fact, e.g. this project uses pnpm workspaces…',
  'memoryTab.keyAdd': 'Save',
  'memoryTab.keyAdded': 'Key fact saved — it will be injected from the next turn',
  'memoryTab.memoryAddPlaceholder': 'Type a durable global fact/convention/environment note, e.g. internal Nexus registry…',
  'memoryTab.userAddPlaceholder': 'Type a user preference/habit/communication note, e.g. Chinese replies by default…',
  'memoryTab.memoryUserAddHelp': 'Manual non-project long-term memory write (global fact / user profile); the date is stamped automatically and it injects globally from the next turn.',
  'memoryTab.memoryAdd': 'Save',
  'memoryTab.memoryUserAdded': 'Saved — it will inject globally from the next turn',
  'memoryTab.delete': 'Delete',
  'memoryTab.deleteConfirm': 'Delete this memory entry? This cannot be undone.\n\n{snippet}',
  'memoryTab.deleted': 'Entry deleted',
  'memoryTab.edit': 'Edit',
  'memoryTab.save': 'Save',
  'memoryTab.cancel': 'Cancel',
  'memoryTab.updated': 'Entry updated',
  'memoryTab.editHint': 'Content only: timestamps and branch tags are program-maintained and cannot be changed; the § delimiter cannot be typed.',
  'memoryTab.editConfirm': 'This entry is injected into the session context (the model\'s prompt) right after saving. Save anyway?\n\n{snippet}',
  'memoryTab.archive': 'Archive',
  'memoryTab.archiveConfirm': 'Archive this entry? It leaves the main memory (no longer injected) and can be promoted back any time.\n\n{snippet}',
  'memoryTab.archived': 'Archived (no longer injected; can be promoted back)',
  'memoryTab.promote': 'Promote to memory',
  'memoryTab.promoted': 'Promoted back into the main memory',
  'memoryTab.keyScope': 'Branch scope',
  'memoryTab.keyScopeLabel': 'Branch',
  'memoryTab.keyScopeAll': 'All branches',
  'memoryTab.keyScopeAllHint': 'All branches = visible everywhere',
  'memoryTab.keyScopeAllWeight': '(checking it clears branch picks)',
  'memoryTab.keyScopeHint': 'Click to change the branch scope',
  'memoryTab.keyScopeSaved': 'Branch scope updated',
  'memoryTab.keyScopeSave': 'Save',
  'memoryTab.keyScopeCancel': 'Cancel',
  'memoryTab.keyBranchInfo': 'current branch: {branch} — only untagged entries or entries covering this branch are injected',
  'memoryTab.gitBranch': 'The git branch this record belongs to',
  'memoryTab.dshOnly': 'DSH-only',
  'memoryTab.dshOnlyHint': 'This entry is injected into DSH sessions only; external executors (COI tasks) skip it — for DSH-specific discipline/rules/architecture facts',
  'memoryTab.dshOnlyOn': 'DSH-only',
  'memoryTab.dshOnlyOff': 'Unmark DSH-only',
  'memoryTab.dshOnlySet': 'Marked DSH-only (skipped when injecting into external executors)',
  'memoryTab.dshOnlyRemoved': 'DSH-only mark removed (visible to external executors)',
  'memoryTab.dshOnlyToggleHint': 'Toggle the DSH-only mark: the entry reaches DSH sessions only, external executors (COI) skip it',
  'memoryTab.dshOnlyAdd': 'DSH-only (do not inject into external executors)',
  'memoryTab.desc.project': 'Project log: auto-recorded per turn; never injected, read on demand by the model.',
  'memoryTab.desc.key': 'Key project facts: conventions/decisions/pitfalls, injected into this project\'s sessions; written when important, addable/deletable manually.',
  'memoryTab.desc.daily': 'Daily log: per-day progress records with program-tagged project labels; never injected, read on demand.',
  'memoryTab.desc.user': 'User profile: preferences and habits, injected into every session; writes need review + confirmation.',
  'memoryTab.desc.memory': 'Long-term memory: global environment/project facts, injected into every session; writes need review + confirmation.',
  'memoryTab.desc.archive-user': 'Archived user facts: not good enough for the main track, never injected; can be promoted back or deleted.',
  'memoryTab.desc.archive-memory': 'Archived memory facts: not good enough for the main track, never injected; can be promoted back or deleted.',
  'memoryTab.desc.archive-key': 'Archived key project facts: not good enough for the main track (or paused from injection), never injected; can be promoted back or deleted.',
  'memoryTab.desc.agents': 'Global rules: cross-session user rules (AGENTS.md), injected with the system prompt.',
  'panel.suggestions.title': 'Pending memory suggestions',
  'panel.suggestions.empty': 'No pending suggestions.',
  'panel.suggestions.help': 'Global-track suggestions produced by the background review: approve writes them into the memory files (injected with the snapshot); archive keeps them aside (never injected); reject drops them.',
  'panel.todoSuggestions.title': 'Pending todo suggestions',
  'panel.todoSuggestions.empty': 'No pending todo suggestions.',
  'panel.todoSuggestions.help': 'Todo suggestions from the background review: approve writes into the matching todo track (a todo stays a todo); archive keeps aside; reject drops.',
  'panel.guide.title': 'Guide',
  'panel.guide.intro': 'memory-evolve is a "memory & self-evolution" toolkit: it turns conversations into durable memory, todos and skills — the AI gets to know you better over time and never loses context across sessions. Here is what each module does and how to use it.',
  'panel.guide.memory.title': 'Memory read/write (memory tool)',
  'panel.guide.memory.desc': 'Five tracks: global memory, user profile, key project facts (auto-injected and git-branch aware — only facts relevant to the current branch reach the context), project log, daily log. How to use: just chat — the AI logs progress every turn; for important facts say "remember: the deploy port is 8080"; when resuming days later ask "check the memory" and it picks up seamlessly.',
  'panel.guide.review.title': 'Memory review (self-evolution)',
  'panel.guide.review.desc': 'Every N turns (10 by default, configurable) the AI reviews the conversation and distills what is worth remembering into suggestions for your confirmation — it never writes into the memory on its own. Just approve or reject in the Memory tab queue from time to time.',
  'panel.guide.todo.title': 'Todo management (dtodo)',
  'panel.guide.todo.desc': 'Say "remember / I need to do X" and it becomes a structured todo (auto-filed into life / work / project / daily, with important-urgent flags and due dates); the AI reminds you of due items at the end of its replies. AI-proposed todos land in a pending queue first. Manage everything in the Todos tab.',
  'panel.guide.skill.title': 'Skill accumulation (skill_manage)',
  'panel.guide.skill.desc': 'Methodologies learned the hard way can be solidified into skills; next time the same kind of task follows the process. Just say "save this process as a skill"; keep creation restrained and high-value. Browse, search and enable / disable skills in the Skills tab.',
  'panel.guide.search.title': 'Local file search (memory_evolve_search_local_files)',
  'panel.guide.search.desc': 'When the memory has no answer and you need local material, tell the AI "search the machine for XX" — by filename (documents only by default, all types on request); "which document mentioned XX" searches file content and returns hits with snippets. Four modes under "Config": filename + content / filename only / content only / off. Off by default — the tool is invisible to the model until enabled.',
  'panel.guide.coi.title': 'COI dispatch (de_coi)',
  'panel.guide.coi.desc': 'Dispatch tasks to external CLI agents (kimi / codex / grok / hermes…): unified scheduling without blocking, live progress, layered sessions with one-click resume, cross-COI chaining, results archived and distilled into memory. Say "dispatch XX to kimi / codex" or use the COI Dispatch tab. Off by default: enable "COI dispatch" under Config.',
  'panel.guide.prompt.title': 'Prompt manager',
  'panel.guide.prompt.desc': 'Turn recurring working patterns into prompt assets: pick one and inject — the model sees it next turn without interrupting the reply; supports one-shot, N turns, or every-M-turns reminders (numbers freely editable, auto-expiring by turn count), stoppable anytime; ad-hoc injection works without creating a prompt first. Off by default: enable "Prompt manager" under Config.',
  'panel.guide.models.title': 'Model settings (de_models)',
  'panel.guide.models.desc': 'The "Model settings" tab + de_models tool: a table of DSH providers and models with plugin-side per-model settings (enabled, note, thinking support, allowed / recommended reasoning levels incl. custom levels) — these settings only affect this plugin (de_models queries and tab display); DSH own model settings stay untouched. Off by default: enable "Model settings" under Config.',
  'panel.guide.advisor.title': 'Session review (Advisor)',
  'panel.guide.advisor.desc': `Attach an independent reviewer to every session — it only observes what you see in the UI (no thinking / tool calls), reviews each turn in real time and nudges you as "user instructions" when needed (info / nit / concern / blocker; info is record-only by default; in the chat flow these appear as collapsed [severity] lines so you can tell them apart). It works as a persistent session — full context, never truncated; the panel supports starting a fresh reviewer, asking it directly, and four levels of constraints (system prompt / project / session / reviewer-session, most-local wins). Off by default: open the master switch under Config, then enable per session in the floating panel; the reviewer model inherits the session model by default and can be set separately.`,
  'panel.guide.broadcast.title': 'Session broadcast (de_broadcast)',
  'panel.guide.broadcast.desc': 'Message passing between DSH sessions: copy your session ID (⧉ button in the session header), send it to another session and let its AI use de_broadcast send to reach you — the receiver snapshot gets a targeted unread notice (visible only to the receiver), the AI reads the full text via list / read, auto-deleted once everyone has read it; very long content is stored to a file. Rooms support multi-member collaboration across working directories; project groups reach a whole directory. Off by default: enable "Session broadcast" under Config.',
  'panel.guide.session.title': 'Session search (de_session_search)',
  'panel.guide.session.desc': 'Let the AI search the history of other AI tools (Codex currently) — "when did we do XX in Codex" just works: keyword hits with message snippets and context windows; scope by cwd, control scale with sort / limit / window; zero resident state — no index, no cache, read-only live scans. Off by default: enable "Session search" under Config.',
  'panel.guide.sessionOrch.title': 'Session orchestration (de_session)',
  'panel.guide.sessionOrch.desc': 'Let the AI create / wake DSH sessions programmatically — spawn builds a standard session (fully isomorphic to a manual one: system prompt / tools / memory snapshot / persistence, listed on the left and adoptable) that starts running immediately; wake resumes an existing session with a task (queued if busy); status / list report state. Discipline: the AI never bulk-wakes sessions — you stay in command. Off by default: enable "Session orchestration" under Config; pairs well with broadcast rooms.',
  'panel.guide.uiSettings.title': 'Web UI Settings',
  'panel.guide.uiSettings.desc': 'Style-level tweaks for the DSH web GUI (pure client-side injection): independent switches in the "Web UI Settings" tab "General" page — session filter (left list shows only active), wide conversation area, wide message bubbles, context-usage warning, Mermaid rendering. Off by default.',
  'panel.guide.canvas.title': 'Infinite canvas',
  'panel.guide.canvas.desc': 'Collect scattered files / images / audio onto one infinite canvas (the "Canvas" tab) — board by path / note / search (local path references, no copying), preview in-card, copy a reference string and give it to the AI to fetch by id; the AI can also drop notes via de_canvas (nothing is injected — it queries on demand). Off by default: enable "Infinite canvas" under Config.',
  'panel.guide.sync.title': 'Memory sync (cross-device)',
  'panel.guide.sync.desc': 'Keep project memory consistent across devices — share the same key facts / logs / archives / project todos between office and home machines. In the "Memory sync" tab enable "sync this project" and click start: by default it uses a dedicated branch of your code repo (zero config); or fill in a shared memory repo — one repo for all projects (global tracks too). Another machine recognizes the project automatically and pulls to continue. The module switch lives under Config; sync is always triggered by you, and projects with sync off are unaffected.',
  'panel.guide.confirm.title': 'The confirmation system (why the AI cannot write directly)',
  'panel.guide.confirm.desc': 'AI-proposed memory, todos and skills all enter a pending queue and take effect only after your confirmation. These writes genuinely change AI behavior: memory enters the context, todos are work assigned to you, skills alter the AI capability set — unchecked writes could canonize mistakes or assign you work unprompted. You are the final gate: the AI proposes, you decide.',
  'panel.guide.best.title': 'Tips for the best experience',
  'panel.guide.best.1': 'Session continuity: say "check the memory" and the AI picks up project conventions and progress from the logs — no need to repeat yourself.',
  'panel.guide.best.2': 'Capture on the fly: say "remember this / follow up on this" and the AI files it automatically; a word days later resumes the thread.',
  'panel.guide.best.3': 'Review periodically: glance at the memory / todo suggestion queues and approve or reject — that is the confirmation loop of memory evolution.',
  'panel.guide.best.4': 'Multi-device sync: work from office and home? Enable "Memory sync" and both machines share the same project memory — important conclusions never need repeating.',
  'panel.guide.loop': 'The loop: chat → record → review → distill → execute. This mechanism is the AI long-term working memory.',
  'panel.suggestions.approve': 'Approve',
  'panel.suggestions.archive': 'Archive',
  'panel.suggestions.archiveHint': 'Archive: kept out of the injected memory, can be promoted back later',
  'panel.suggestions.editHint': 'You may edit the text before approving; the edited text is what gets written.',
  'panel.suggestions.reject': 'Reject',
  'panel.suggestions.approveAll': 'Approve all',
  'panel.suggestions.rejectAll': 'Reject all',
  'panel.suggestions.hits': 'Suggested {count}×',
  'panel.suggestions.hitsHint': 'This fact resurfaced across several reviews — worth a careful look',
  'panel.suggestions.target.memory': 'Memory',
  'panel.suggestions.target.user': 'User profile',
  'panel.suggestions.target.key': 'Project key facts',
  'panel.suggestions.targetHint': 'Track to write on approve: defaults to the AI-recommended one; re-classify if it fits better (memory/user/key are injected into the prompt immediately)',
  'panel.suggestions.projectHint': 'This suggestion comes from the working directory: {path}',
  'panel.suggestions.done': 'Done: {text}',
  'panel.archive.title': 'Archived memory',
  'panel.archive.empty': 'No archived entries.',
  'panel.archive.help': 'Archived suggestions are never injected; they stay here for later — promote them back into the memory files when they matter, or delete them.',
  'panel.archive.promote': 'Promote to memory',
  'panel.archive.delete': 'Delete',
  'panel.archive.promoted': 'Promoted to memory',
  'panel.archive.deleted': 'Archived entry deleted',
  'panel.skills.title': 'Pending skill suggestions',
  'panel.skills.help': 'New skills produced by background review; approving moves them into the skill library (~/.agents/skills) where they are injected into system prompts.',
  'panel.skills.empty': 'No pending skill suggestions.',
  'panel.skills.pending': 'Pending',
  'panel.skills.approve': 'Approve',
  'panel.skills.reject': 'Reject',
  'panel.skills.done': 'Skill {op}',
  'panel.config.title': 'Config',
  'panel.config.help': 'Changes apply immediately and persist (overriding the config.yaml entries).',
  'panel.config.reviewEnabled': 'Background review',
  'panel.config.reviewEnabled.hint': 'Automatically review sessions and harvest experience; when off, the memory/skill tools and the snapshot still work — only the automatic review stops',
  'panel.config.reviewInterval': 'Review interval (turns)',
  'panel.config.reviewInterval.hint': 'One automatic review per N user turns',
  'panel.config.skillReviewEnabled': 'Skill auto-harvest',
  'panel.config.skillReviewEnabled.hint': 'Off (default): new skills from review go to the pending queue and only install when approved; On: review creates skills directly without confirmation (skills are injected into every session — enable with care)',
  'panel.config.perTurnWriteGuard': 'Memory write watchdog',
  'panel.config.perTurnWriteGuard.hint': 'Off (default): the root cause is model instruction-following — strong models do not need it. On: after consecutive turns without a daily/project write, the snapshot pins a catch-up warning (clears once written)',
  'panel.config.writeGuardThreshold': 'Watchdog threshold (turns)',
  'panel.config.writeGuardThreshold.hint': 'Warn after N consecutive turns without ANY daily/project write (>=1; 2 = tolerates 1 missed turn, warns from the 2nd)',
  'panel.config.perTurnProjectWrites': 'Per-turn project writes',
  'panel.config.perTurnProjectWrites.hint': 'Require the model to check at the end of every turn and record project-related facts (decisions/progress/pitfalls); when off, project memory is read on demand only. ⚠️ Relies on LLM instruction following — weaker models may not comply',
  'panel.config.perTurnDailyWrites': 'Per-turn daily writes',
  'panel.config.perTurnDailyWrites.hint': 'Require the model to check at the end of every turn and record the day\'s progress; when off, the daily log is read on demand only. ⚠️ Relies on LLM instruction following — weaker models may not comply',
  'panel.config.perTurnKeyWrites': 'Per-turn key-fact check',
  'panel.config.perTurnKeyWrites.hint': 'Require the model to judge at the end of every turn whether an important project fact emerged (long-lived convention/decision/architecture/pitfall); if so, write it to target=key (injected into the context), otherwise skip. When off, key facts are only added manually or read. ⚠️ Relies on LLM instruction following',
  'panel.config.keyBranchFilter': 'Key-track branch filter',
  'panel.config.keyBranchFilter.hint': 'When on (default), key-track entries are filtered by the **current git branch**: untagged entries are visible everywhere, entries tagged [branch:x] only on that branch — the same rule for snapshot injection, expand and list. Turn it off to disable filtering in all three (diagnostics; other branches\' entries will then show up in the list)',
  'panel.config.keyProgressiveDisclosure': 'Key-track progressive disclosure',
  'panel.config.keyProgressiveDisclosure.hint': 'Control how key-track memories are injected: auto = full injection for small data, summary injection for large data; off = always full injection (default); on = always summary injection (saves tokens)',
  'panel.config.keyProgressiveDisclosure.auto': 'Auto',
  'panel.config.keyProgressiveDisclosure.off': 'Off (always full, default)',
  'panel.config.keyProgressiveDisclosure.on': 'On (always summary)',
  'panel.config.keyFullInjectThreshold': 'Full-injection entry-count threshold',
  'panel.config.keyFullInjectThreshold.hint': 'In auto mode, full injection when entry count ≤ this value (default 3)',
  'panel.config.keyFullInjectCharLimit': 'Full-injection character limit',
  'panel.config.keyFullInjectCharLimit.hint': 'In auto mode, full injection when total characters ≤ this value (default 1500)',
  'panel.config.coiEnabled': 'COI dispatch',
  'panel.config.coiEnabled.hint': 'Enable the de_coi_* tools and the CLI Dispatch tab: unified dispatch of CLI agents (kimi/codex/grok/hermes…). Off by default — this plugin\'s core is memory/todos/skills, dispatch is an on-demand add-on; when off, the tools and the tab are completely invisible',
  'panel.config.searchDocsEnabled': 'Local file search tool',
  'panel.config.searchDocsEnabled.hint': 'Lets the model search files across all local disks/directories. **Four modes**: all = name + content search; filename only = content/contentQuery parameters are ignored (never reads file contents — for people who use their own content-search implementation); content only = every call does content matching (query acts as the content keyword); off = the tool is completely invisible to the model. Content search: contentQuery="keyword" answers "which document mentions XX" (rg full-text match, returns hit snippets). Off by default',
  'panel.config.searchDocsMode.all': 'All (name + content)',
  'panel.config.searchDocsMode.filename': 'Filename only',
  'panel.config.searchDocsMode.content': 'Content only',
  'panel.config.searchDocsMode.off': 'Off (tool invisible)',
  'panel.config.advisorEnabled': 'Session review (Advisor)',
  'panel.config.advisorEnabled.hint': 'Master switch for the session-review module. With the switch on, every session still starts OFF — enable reviewing per session from the panel\'s session switch (reviews consume extra model calls, turn them on only where needed; enabled sessions keep their choice across refreshes/restarts). With the switch off, reviewing stops and all review UI (header toggle / floating panel) is hidden; turn it back on to restore the module instantly',
  'panel.config.broadcastEnabled': 'Session broadcast',
  'panel.config.broadcastEnabled.hint': 'Enable session broadcast (de_broadcast): inter-session messaging — the "Session broadcast" unread hint in the snapshot (inbox-style rows: id+subject+sender+time) + the de_broadcast tool (send/list/read; read consumes and auto-deletes once all recipients read; >8KB spills to a file; 30-day cleanup) + the broadcast management panel tab. **Independent of COI dispatch** (off by default, can be enabled alone); when off, all of the above are invisible; the persistent "Your session ID" snapshot section is unaffected; the header "⧉ Copy session ID" / "✎ alias" buttons belong to "Session orchestration" (the panel top also has a copy entry)',
  'panel.config.notifyEnabled': 'Notifications',
  'panel.config.notifyEnabled.hint': 'Enable the notification module (de_notify): the AI proactively notifies you when a task is done — the de_notify manual tool (send anytime, no frequency limit; channels include feishu/qq/weixin/wecom/web) + automatic COI completion notify (pick channels via coiNotifyChannels). The web channel delivers to an in-app notification bell at the top-right: persisted + unread badge + a popover showing "which session sent what" + click to jump to that session. Independent module, off by default; IM channels require the matching channel plugin (dsh-feishu etc., missing ones reported honestly), the web channel is built in with zero deps; when off, the tool is not registered, the bell disappears, and COI auto-notify silently skips',
  'notify.title': 'Notifications',
  'notify.bellAria': 'In-app notifications',
  'notify.empty': 'No unread notifications',
  'notify.loading': 'Loading…',
  'notify.readAll': 'Mark all read',
  'notify.system': 'System',
  'notify.jump': 'Jump to session',
  'notify.delete': 'Delete',
  'notify.viewDetail': 'View details',
  'notify.close': 'Close',
  'notify.markRead': 'Mark read',
  'panel.config.syncEnabled': 'Memory sync',
  'panel.config.syncEnabled.hint': '**Module switch**: enables the Memory Sync module — the Memory Sync tab appears in conversations and /memory_sync works. **Note: this does NOT start syncing any project** — each project is opted in separately via the "Sync this project" switch in the Memory Sync tab (off by default; never-opted-in projects keep their pure-local state: no Git repo, no entry IDs). Sync moves project memory (KEY + project log + archive + project todos) over Git to one memory remote — leave the URL empty to use your main code repo by default (dedicated branch, zero config); paste a shared memory repo URL to use one private repo for all projects (global memory, phase 2, can only sync through it). Push always requires your explicit trigger',
  'panel.config.sessionSearchEnabled': 'Session search',
  'panel.config.sessionSearchEnabled.hint': 'Enable de_session_search: lets the model search historical sessions of other local AI tools (Codex for now: plain JSONL under ~/.codex/sessions and archived_sessions — rg prefilter keeps it millisecond-fast; DSH sessions not supported yet). Case-insensitive literal matching over user/assistant messages only; supports cwd project filter, relevance/newest/oldest sorting, and limit/window result control. **Independent submodule** (off by default, can be enabled alone — unrelated to COI dispatch/broadcast); zero resident state: no index, no cache, every call scans read-only in real time and never modifies session files; when off the tool is completely invisible to the model',
  'panel.config.canvasEnabled': 'Infinite canvas',
  'panel.config.canvasEnabled.hint': '**Module switch**: enables the Infinite Canvas — a Canvas tab in conversations + the de_canvas tool (the model can list the board, read nodes by id, and drop notes into the board\'s center zone). Local path references, single-board with perspective filters (session/project/global + ownership badges), pull-based AI access (board content is never injected into context; query it on demand). **Independent submodule** (off by default): stored at <memoryDir>/canvas/boards.json (whole-board atomic writes + rev optimistic lock to prevent cross-session overwrites); when off the tab and tool are completely invisible, data files are kept',
  'panel.config.sessionEnabled': 'Session orchestration',
  'panel.config.sessionEnabled.hint': 'Enable session orchestration (de_session): lets AI **programmatically create/wake DSH sessions** — spawn creates a standard session (identical to one opened manually: system prompt/tools/memory snapshot/persistence, appears in the left session list and can be taken over), prompt = the full instruction text (role/task freely composed), it starts running immediately; optional cwd / join a broadcast room / model override; wake wakes an existing session (equivalent to sending a message on its behalf — its AI wakes up and processes it, auto-resumed after process restart); status/list inspect state; the header **"⧉ Copy session ID" / "✎ alias" buttons follow this switch** (session-identity features, previously mis-housed under broadcast). **Independent submodule** (off by default; depends on the DSH agents service, only same-process sessions can be woken; when off the tool is invisible to the model)',
  'panel.config.promptsEnabled': 'Prompt manager',
  'panel.config.promptsEnabled.hint': 'Enable the Prompts tab: a prompt library (user-written paradigms + built-in examples) plus an injection track (once / N consecutive turns / every M turns — count and cadence accept any integers; injected content is visible to the model next turn, expires automatically by turn counting, and can be stopped anytime; quick inject works without saving a prompt first, auto-saved to the Temp category). Off by default; when off the snapshot section, event listener and API are fully uninstalled and the tab hides after refresh',
  'panel.config.modelsEnabled': 'Model Settings',
  'panel.config.modelsEnabled.hint': 'Enable the "Model Settings" tab + de_models tool: a table of DSH providers/models with per-model settings (enabled, note, thinking support, allowed/recommended reasoning levels, custom levels); de_models lets the AI query the available model list. **Off by default** (registering takes a slot in the model tool list; turn it on when needed). ⚠️ These settings **only affect this plugin and never modify or affect DSH\'s own model settings** (DSH side stays as the official "Settings → Models" says). When off the tab and tool hide and the API refuses access, settings data is kept',
  'panel.config.uiSettingsEnabled': 'Web UI Settings',
  'panel.config.uiSettingsEnabled.hint': 'Enable the "Web UI Settings" module: a filter bar appears above the left session list, showing only active sessions by default (generating / awaiting approval / awaiting answer / subagents running / error / finished-but-unviewed — purely idle ones collapse away), one click switches back to all; pure client-side styling (CSS + DOM injection, no DSH framework changes); the filter preference is remembered in the browser. **Off by default**; when off, the filter bar and injected styles are fully removed',
  'panel.config.save': 'Save config',
  'panel.reveal.title': 'Open files',
  'panel.reveal.help': 'Open the memory directories and files with your system tools. ⚠️ Careless edits can break the §-delimited format and corrupt memory reads — edit with caution.',
  'panel.reveal.memoryDir': 'Memory dir',
  'panel.reveal.memoryFile': 'Global memory',
  'panel.reveal.userFile': 'User profile',
  'panel.reveal.archiveMemoryFile': 'Archived memory',
  'panel.reveal.archiveUserFile': 'Archived user',
  'panel.reveal.dailyDir': 'Daily log dir',
  'panel.reveal.dailyFile': 'Today log',
  'panel.reveal.projectsDir': 'Project memory dir',
  'panel.reveal.skillDir': 'Skills dir',
  'panel.reveal.agentsFile': 'Global rules (AGENTS.md)',
  'panel.config.saved': 'Config saved. Refresh the page for newly enabled/disabled modules to take effect',
  'panel.config.failed': 'Failed: {message}',
  'panel.loading': 'Loading…',
  // COI 调度 tab（CoIView 私有字典迁入，2026-09-16 i18n）
  'coi.tab': 'CLI Dispatch',
  'coi.guide': 'Guide',
  'coi.guide.title': 'COI Dispatch Guide',
  'coi.guide.intro': 'COI Dispatch = the "external helper console" for handing tasks to external AI agents (kimi / codex / grok / hermes…): tasks run in the background without blocking your session; progress and logs are live; sessions are tiered and resumable in one click; tasks can chain across agents; results are archived and distilled into memory. Off by default — enable "COI dispatch" under Config in the Memory Evolve Settings tab.',
  'coi.guide.use.title': 'How to launch a task',
  'coi.guide.use.desc': 'Three entries, pick any:',
  'coi.guide.use.ai': 'Tell the AI:',
  'coi.guide.use.aiDesc': 'Say "dispatch XX to kimi / have codex fix the tests" — the AI launches it via de_coi_dispatch, it runs in the background, and on completion the summary is automatically written into the project log and daily log.',
  'coi.guide.use.slash': 'Terminal command:',
  'coi.guide.use.slashDesc': '/de_coi run "task" --coi kimi (see all subcommands: /de_coi help).',
  'coi.guide.use.tab': 'This tab:',
  'coi.guide.use.tabDesc': 'In the Tasks page fill in the adapter, prompt and scope; optionally resume a session / use a template / chain a reference task; you can also tick "inject DSH memory" so the helper carries your project conventions, attach context text or images; hit launch and watch progress and output live.',
  'coi.guide.scope.title': 'Session tiers (who can see)',
  'coi.guide.scope.desc': 'Tasks and sessions belong to a tier, which decides who can see and resume them:',
  'coi.guide.scope.temp': 'Visible only to the launching session; one-off (use for testing an adapter).',
  'coi.guide.scope.session': 'Visible only to the launching session; resumable within it.',
  'coi.guide.scope.project': 'Visible to all sessions of the project (same working directory); can carry a git branch.',
  'coi.guide.scope.global': 'Visible to every session; kept long-term.',
  'coi.guide.skill.title': 'Adapters & skills',
  'coi.guide.skill.desc': 'Every adapter maps to a skill (the AI usage guide, injected into the model context): the four built-ins work out of the box; custom CLIs can be added in the Adapters page (plain-cli included) — fill the skill name and content and the AI learns to drive it. Skills can be disabled in the Skill Manager tab and edited via the Skill button on the adapter page.',
  'coi.guide.tips.title': 'Best practices',
  'coi.guide.tips.1': 'Division of labor: frontend→kimi, complex backend→codex, quick tasks→grok.',
  'coi.guide.tips.2': 'Chaining: codex writes code → kimi reviews (pick "reference task" when launching).',
  'coi.guide.tips.3': 'Note important sessions (the note button in the sessions page) so you can find them by name when resuming.',
  'coi.guide.tips.4': 'Tasks can push a notification on completion (set the notify command in the config page, e.g. hermes send to WeChat).',
  'coi.guide.tips.5': 'Tick "inject DSH memory" when dispatching and the helper works with your global rules, profile and this project key facts (branch-filtered, same rules as DSH injection); tasks can also carry images — send a screenshot for analysis (codex / kimi / hermes read images; zcode is text-only and will refuse clearly).',
  'coi.guide.loop': 'The loop: dispatch → watch progress live → archive the result → distill the summary into memory → resume and chain the session.',
  'coi.tasks': 'Tasks',
  'coi.sessions': 'Sessions',
  'coi.adapters': 'Adapters',
  'coi.templates': 'Templates',
  'coi.stats': 'Stats',
  'coi.config': 'Config',
  'coi.loading': 'Loading…',
  'coi.refresh': 'Refresh',
  'coi.all': 'All',
  'coi.none': '(none)',
  'coi.launch.title': 'Launch task',
  'coi.launch.expand': 'Expand',
  'coi.launch.collapse': 'Collapse',
  'coi.launch.adapter': 'Adapter',
  'coi.launch.prompt': 'Prompt',
  'coi.launch.promptPh': 'e.g. fix the failing cases in tests/store.test.js and verify',
  'coi.launch.scope': 'Scope',
  'coi.launch.session': 'Resume session',
  'coi.launch.sessionNone': '(new session)',
  'coi.launch.sessionEmpty': '(no sessions for this adapter)',
  'coi.launch.template': 'Template',
  'coi.launch.templateNone': '(no template)',
  'coi.launch.ref': 'Relay ref',
  'coi.launch.refNone': '(none)',
  'coi.launch.submit': 'Launch',
  'coi.launch.injectTracks': 'Inject DSH memory (optional)',
  'coi.launch.injectTracksHint': 'Pick which memory tracks to hand to the COI (independent of scope — any tier can inject): long-term memory=global facts, user profile=your preferences, project key=this workspace\'s key facts (branch-filtered; no AGENTS.md). Content is sent to external COI services — mind privacy; empty = no injection',
  'coi.launch.ctxText': 'Extra context text (optional)',
  'coi.launch.ctxTextPh': 'Your own context: project progress, log highlights… (over 32KB it is written to a file and the path is given to the COI)',
  'coi.launch.needPrompt': 'Prompt must not be empty',
  'coi.launch.ok': 'Launched',
  'coi.tasks.empty': 'No tasks yet',
  'coi.tasks.selectHint': 'Click a task on the left to view details and output',
  'coi.tasks.kill': 'Kill',
  'coi.tasks.confirmKill': 'Kill this task?',
  'coi.tasks.killed': 'Killed',
  'coi.tasks.retry': 'Retry',
  'coi.tasks.retried': 'Re-launched',
  'coi.tasks.copy': 'Copy',
  'coi.tasks.copied': 'Copied',
  'coi.tasks.copyFail': 'Copy failed',
  'coi.tasks.log': 'Output log',
  'coi.tasks.logEmpty': '(no output yet)',
  'coi.tasks.logFull': 'Expand',
  'coi.tasks.prompt': 'Task prompt',
  'coi.tasks.searchPh': 'Search tasks (content / task id)…',
  'coi.tasks.pager.prev': 'Prev',
  'coi.tasks.pager.next': 'Next',
  'coi.tasks.pager.total': 'of',
  'coi.tasks.delete': 'Delete',
  'coi.tasks.confirmDelete': 'Delete this task? Its record and output archive will be removed (memory summaries are unaffected; relay references to it will fail afterwards).\n\n{id}',
  'coi.tasks.status': 'Status',
  'coi.tasks.adapter': 'Adapter',
  'coi.tasks.scope': 'Scope',
  'coi.tasks.branch': 'Branch',
  'coi.tasks.sessionId': 'Session ID',
  'coi.tasks.created': 'Created',
  'coi.tasks.duration': 'Duration',
  'coi.tasks.lastOutput': 'Last output',
  'coi.tasks.exitCode': 'Exit code',
  'coi.tasks.error': 'Error',
  'coi.sessions.filterScope': 'Scope filter',
  'coi.sessions.searchPh': 'Search…',
  'coi.sessions.note': 'Note',
  'coi.sessions.save': 'Save',
  'coi.sessions.delete': 'Delete',
  'coi.sessions.confirmDelete': 'Delete this session record?',
  'coi.sessions.empty': 'No sessions',
  'coi.sessions.locked': 'Occupied by a task',
  'coi.sessions.lastSeen': 'Last seen',
  'coi.adapters.guide': 'Guide',
  'coi.adapters.test': 'Test',
  'coi.adapters.testOk': 'Test task launched',
  'coi.adapters.skill': 'Skill',
  'coi.adapters.skillHint': 'The skill holding this adapter\'s usage guide: a real injected skill (source = user skill library, injected into every session\'s system prompt); disable it via the Skill Manager tab',
  'coi.adapters.skillBtn': 'Skill',
  'coi.adapters.editSkillTitle': 'Edit skill (AI usage guide)',
  'coi.adapters.editSkillHint': 'The skill IS the AI usage guide: it is synced into the user skill library (~/.agents/skills) and injected into every session\'s system prompt, so the AI knows how to drive this adapter. Editing here updates that SKILL.md; plugin restarts will not overwrite your edits while the built-in version is unchanged; disable it via the Skill Manager tab.',
  'coi.adapters.saveSkill': 'Save',
  'coi.adapters.skillSaved': 'Skill saved',
  'coi.adapters.skillName': 'Skill name (optional)',
  'coi.adapters.skillNamePh': 'e.g. my-cli-skill (that SKILL.md will be injected into the AI context so the AI learns how to use this CLI)',
  'coi.adapters.useCase': 'Use case',
  'coi.adapters.useCasePh': 'Tell the AI which tasks suit this CLI, e.g. complex backend logic / test fixes…',
  'coi.adapters.useCaseEmpty': '(no use case set)',
  'coi.adapters.editUseCase': 'Edit',
  'coi.adapters.saveUseCase': 'Save',
  'coi.adapters.skillContent': 'Skill content (SKILL.md)',
  'coi.adapters.skillContentPh': '# Skill body\n\nTell the AI how to drive this CLI: command format, args, session resume, caveats… (frontmatter name/description are auto-completed)',
  'coi.adapters.skillContentHint': 'Leave empty = link the skill name only (create the file later via the Skill button); filled = the skill is auto-created when missing',
  'coi.cancel': 'Cancel',
  'coi.saving': 'Saving…',
  'coi.adapters.addTitle': 'Add custom adapter',
  'coi.adapters.name': 'Name',
  'coi.adapters.type': 'Type',
  'coi.adapters.binary': 'Binary',
  'coi.adapters.args': 'Args',
  'coi.adapters.argsPh': 'comma separated, e.g.: -p, {task}',
  'coi.adapters.add': 'Add',
  'coi.adapters.delete': 'Delete',
  'coi.adapters.enable': 'Enable',
  'coi.adapters.disable': 'Disable',
  'coi.adapters.disabledHint': 'Disabled: dispatching to this adapter is rejected with a hint to use another one',
  'coi.adapters.confirmDelete': 'Delete this custom adapter?',
  'coi.adapters.builtin': 'builtin',
  'coi.adapters.custom': 'custom',
  'coi.adapters.resumeSection': 'Session resume (required for ai-cli)',
  'coi.adapters.resumeSectionHint': 'ai-cli must support resuming a named session; CLIs without resume support should use plain-cli',
  'coi.adapters.resumeKind': 'Resume mode',
  'coi.adapters.resumeKindFlag': 'flag mode (resume flag + arg prepended to base args)',
  'coi.adapters.resumeKindArgs': 'args mode (full resume command)',
  'coi.adapters.resumeFlag': 'Resume flag',
  'coi.adapters.resumeFlagPh': 'e.g. -S / -r / --resume',
  'coi.adapters.resumeArg': 'Session arg',
  'coi.adapters.resumeArgPh': 'with {sessionId} placeholder, e.g. {sessionId}',
  'coi.adapters.resumeArgs': 'Resume command args',
  'coi.adapters.resumeArgsPh': 'comma separated, with {sessionId} (and optional {task}), e.g. exec, resume, {sessionId}, {task}',
  'coi.adapters.continueFlag': 'Continue-last flag (optional)',
  'coi.adapters.continueFlagPh': 'e.g. -c; leave empty = no “continue last session” support',
  'coi.adapters.extractSection': 'Auto session-ID extraction (optional)',
  'coi.adapters.extractSource': 'Output stream',
  'coi.adapters.extractRegex': 'Extract regex',
  'coi.adapters.extractRegexPh': 'capture group 1 = session ID, e.g. To resume this session: kimi -r (session_\\S+)',
  'coi.adapters.resumeMissing': 'ai-cli requires a session resume config',
  'coi.templates.addTitle': 'Add template',
  'coi.templates.name': 'Name',
  'coi.templates.prompt': 'Prompt',
  'coi.templates.adapterOpt': 'Adapter (optional)',
  'coi.templates.idOpt': 'ID (optional, auto if empty)',
  'coi.templates.add': 'Add',
  'coi.templates.delete': 'Delete',
  'coi.templates.confirmDelete': 'Delete this template?',
  'coi.templates.builtinKeep': 'Builtin templates cannot be deleted',
  'coi.templates.empty': 'No templates',
  'coi.stats.total': 'Total tasks',
  'coi.stats.count': 'Tasks',
  'coi.stats.hours': 'Total time',
  'coi.stats.byStatus': 'By status',
  'coi.stats.empty': 'No stats yet',
  'coi.config.notify': 'Notify command',
  'coi.config.notifyHint': 'Runs when a task finishes; placeholders: {taskId} {coi} {status} {summary}',
  'coi.config.retention': 'Retention days',
  'coi.config.timeout': 'Task timeout',
  'coi.config.timeoutHours': 'hours',
  'coi.config.timeoutMinutes': 'minutes',
  'coi.config.timeoutHint': 'Timeout is a safety net only (AI agents may stay quiet for hours); leave empty to keep current',
  'coi.config.timeoutBad': 'Bad timeout format',
  'coi.config.save': 'Save',
  'coi.config.saved': 'Saved',
  'coi.scope.temporary': 'temporary',
  'coi.scope.session': 'session',
  'coi.scope.project': 'project',
  'coi.scope.global': 'global',
  // 提示词 tab（PromptView 私有字典迁入，2026-09-16 i18n）
  'prompt.guide': 'Guide',
  'prompt.library': 'Prompt library',
  'prompt.guideIntro': 'Prompt injection = an "instruction-pattern asset library + one-click injection": turn recurring working paradigms (code review / debugging / PRD / testing…) into prompts, then inject one with a click — the model sees it next turn without interrupting the reply, like handing the AI an operating manual.',
  'prompt.guideLibTitle': 'Prompt library: your pattern assets',
  'prompt.guideLibBody': 'Reusable instruction patterns, mostly user-written:',
  'prompt.guideLibItem1': 'Create / edit / delete: name + description + category + tags + body (Markdown); a new prompt with an empty category goes to Temp automatically;',
  'prompt.guideLibItem2': 'Categories: built-in ones plus custom add / rename / delete (prompts in a deleted category move to Uncategorized);',
  'prompt.guideLibItem3': 'Search (name / category / tags / content) + copy to clipboard + usage stats;',
  'prompt.guideLibItem4': '13 cold-start examples from real GitHub prompt assets (SpecRoute / Claude-Code-Promts-Skills) plus links to public pattern libraries;',
  'prompt.guideLibItem5': 'Enabled state: disabled prompts are hidden from the AI prompt tool (de_prompts) and cannot be injected by AI — still editable here, re-enable anytime; the AI can list prompts (fetch details by ID) and inject the right one into the current session, or use it as a sub-session / subagent / CLI task prompt.',
  'prompt.guideInjectTitle': 'Injection mechanics: rounds × cadence',
  'prompt.guideInjectBody': 'Pick a prompt, set "rounds × cadence" and inject (both numbers freely editable):',
  'prompt.guideInjectItem1': 'Rounds: one-shot (1) / finite N / infinite (0 = keep injecting until stopped);',
  'prompt.guideInjectItem2': 'Cadence: every turn (1) / once every M turns (e.g. "remind every 3 turns");',
  'prompt.guideInjectItem3': 'Injected without interrupting: content goes to the injection track and the model sees it next turn;',
  'prompt.guideInjectItem4': 'The body supports {{date}} / {{time}} variables, expanded at injection time (handy for dated templates);',
  'prompt.guideInjectItem5': 'Ad-hoc injection: inject without creating a prompt first — type content in the detail bar and click inject; it is auto-saved to the library (empty category → Temp) and takes effect in one step.',
  'prompt.guideTrackTitle': 'Injection status: visible and stoppable',
  'prompt.guideTrackBody': 'Every prompt has a clear status (idle / injecting·N left / injecting forever) and can be stopped anytime; the "injecting" overlay shows it live; the session tab bar shows a red dot 🔴 while any injection is active.',
  'prompt.guideSwitchTitle': 'Switch',
  'prompt.guideSwitchBody': 'The prompt manager is off by default: enable "Prompt manager" under Config in the Memory Evolve Settings tab, then refresh to reveal this tab.',
  'prompt.search': 'Search name, category, tags or content…',
  'prompt.new': 'New prompt',
  'prompt.all': 'All',
  'prompt.uncategorized': 'Uncategorized',
  'prompt.inject': 'Inject',
  'prompt.injectRound': 'Inject {n} times',
  'prompt.injectInfinite': 'Unlimited (until stopped)',
  'prompt.injectCadence': 'every {n} turns',
  'prompt.everyTurn': 'every turn',
  'prompt.injectHint': 'Writes to the injection track — visible to the model next turn; countdown consumes per conversation turn (interval injection supported); unlimited runs until stopped manually',
  'prompt.injecting': 'Injecting',
  'prompt.injectingBadge': 'injecting·{n} left',
  'prompt.injectingBadgeInfinite': 'injecting·ongoing',
  'prompt.injectingIdle': 'not injected',
  'prompt.noInjection': 'Nothing is being injected right now',
  'prompt.removeInjection': 'Stop',
  'prompt.stoppedInjection': 'Injection stopped',
  'prompt.copy': 'Copy',
  'prompt.copied': 'Copied to clipboard',
  'prompt.save': 'Save',
  'prompt.saving': 'Saving…',
  'prompt.cancel': 'Cancel',
  'prompt.delete': 'Delete',
  'prompt.deleteConfirm': 'Delete "{name}"? This cannot be undone and removes its active injections too.',
  'prompt.sources': 'GitHub prompt sources',
  'prompt.sourcesHint': 'These repos host high-quality prompts/specs (browse yourself — no auto import):',
  'prompt.empty': 'No prompts yet. Click "New prompt" to start, or grab ideas from the source links.',
  'prompt.noMatch': 'No matching prompts',
  'prompt.formNew': 'New prompt',
  'prompt.formEdit': 'Edit prompt',
  'prompt.name': 'Name',
  'prompt.namePh': 'e.g. Code Review',
  'prompt.description': 'Description',
  'prompt.descriptionPh': 'One line about what this prompt does (AI reads this when picking a prompt)',
  'prompt.enabled': 'Enabled',
  'prompt.enabledOn': 'Enabled',
  'prompt.enabledOff': 'Disabled',
  'prompt.disabledHint': 'Disabled prompts are hidden from AI lists and cannot be injected by AI; re-enable here anytime',
  'prompt.category': 'Category',
  'prompt.categoryPh': 'e.g. workflow (empty = Temp category)',
  'prompt.tags': 'Tags',
  'prompt.tagsPh': 'Comma-separated, e.g. review, quality',
  'prompt.content': 'Content',
  'prompt.contentPh': 'Write the prompt body here…\n{{date}} and {{time}} variables expand on inject.',
  'prompt.usage': 'Injected {n} times',
  'prompt.lastUsed': 'Last injected: {time}',
  'prompt.neverUsed': 'Never injected',
  'prompt.rounds': 'Count',
  'prompt.cadence': 'Cadence',
  'prompt.roundsHint': '0=unlimited; 1=once only',
  'prompt.everyHint': '0=once only; 1=every turn; N=every N turns',
  'prompt.onceOnly': 'once only',
  'prompt.effectOnce': 'Once: appears next turn, then auto-ends',
  'prompt.effectInfinite': 'Unlimited: every turn, until stopped',
  'prompt.effectInfiniteCadence': 'Unlimited: once every {n} turns, until stopped',
  'prompt.effectFinite': '{n} times: every turn, auto-ends when spent',
  'prompt.effectFiniteCadence': '{n} times: once every {m} turns, auto-ends when spent',
  'prompt.roundsInvalid': 'Count must be an integer ≥ 0 (0 = unlimited)',
  'prompt.everyInvalid': 'Cadence must be an integer ≥ 0 (0 = once only)',
  'prompt.injectOnceBtn': 'Inject once',
  'prompt.injectOnceBtnHint': 'Once only: appears next turn, then auto-ends',
  'prompt.injectInfiniteBtn': 'Keep injecting',
  'prompt.injectInfiniteBtnHint': 'Every turn, until stopped',
  'prompt.customBtn': 'Custom',
  'prompt.customBtnHint': 'Free-form count and cadence',
  'prompt.injectNowBtn': '⚡ Inject now',
  'prompt.injectNowBtnHint': 'Takes effect immediately (this turn / wakes the session), once only — ignores count and cadence',
  'prompt.injectedNow': 'Injected "{name}" now: effective this turn, once only (ignores count/cadence)',
  'prompt.injectedNowFallback': 'Injected "{name}" now (steer not delivered — will take effect next turn)',
  'prompt.collapseCustom': 'Collapse',
  'prompt.quickTitle': 'Quick inject',
  'prompt.quickDesc': 'Inject without saving a prompt first: type content and hit "Inject once" — it is auto-saved to the library (empty category goes to Temp) in one step.',
  'prompt.quickNamePh': 'Name (optional; defaults to first content line)',
  'prompt.quickCategoryPh': 'Category (optional; empty = Temp)',
  'prompt.contentRequired': 'Content is required',
  'prompt.error': '{message}',
  'prompt.loadFailed': 'Load failed: {message}',
  'prompt.injected': 'Injected "{name}": {rounds}{cadence} — visible next turn{ending}',
  'prompt.injectedOnceEnding': ', then auto-ends',
  'prompt.injectedFiniteEnding': ', auto-ends when spent',
  'prompt.injectedInfiniteEnding': ', until stopped',
  'prompt.injectInfiniteShort': 'Keep injecting',
  'prompt.everyTurnParen': ' (every turn)',
  'prompt.injectCadenceParen': ' (every {n} turns)',
  'prompt.removed': 'Injection removed',
  'prompt.reload': 'Reload',
  'prompt.newCategory': 'New category',
  'prompt.newCategoryPh': 'Type a category name, Enter to confirm',
  'prompt.deleteCategory': 'Delete category',
  'prompt.renameCategory': 'Rename category',
  'prompt.renamePh': 'Type a new name, Enter to confirm',
  'prompt.categoryRemoved': 'Category "{name}" deleted{moved}',
  'prompt.categoryDeleted': 'Category "{name}" deleted',
  'prompt.categoryMoved': ', {count} prompts moved to Uncategorized',
  'prompt.categoryExists': 'Category "{name}" already exists — selected',
  'prompt.categoryRenamed': 'Renamed "{from}" → "{to}"{renamed}',
  'prompt.categoryRenamedSuffix': ', {count} prompts updated',
  'prompt.unsavedChanges': 'Unsaved changes',
  // 无限画板 / 会话评审 / 移动端补充文案（2026-09-16 i18n）
  'canvas.tab.label': 'Canvas',
  'canvas.toolbar.view': 'View',
  'canvas.toolbar.viewFilter': 'View filter',
  'canvas.view.session': 'This session',
  'canvas.view.project': 'This project',
  'canvas.view.global': 'All projects',
  'canvas.search.placeholder': 'Search canvas nodes…',
  'canvas.action.path': 'Pin by path',
  'canvas.action.note': 'Note',
  'canvas.action.catalog': 'Search & pin',
  'canvas.action.resetView': 'Reset view',
  'canvas.action.pin': 'Pin',
  'canvas.action.cancel': 'Cancel',
  'canvas.action.close': 'Close',
  'canvas.action.search': 'Search',
  'canvas.action.remove': 'Remove',
  'canvas.action.migrate': 'Migrate',
  'canvas.action.openDefault': 'Open with default app',
  'canvas.meta.count': '{visible}/{total} cards',
  'canvas.meta.hits': ' · {count} hits',
  'canvas.sync.conflict': ' · ⚠️ Conflict — refresh',
  'canvas.sync.saving': ' · Saving',
  'canvas.sync.offline': ' · Backend offline',
  'canvas.sync.synced': ' · Synced',
  'canvas.sync.localOnly': ' · Local only',
  'canvas.node.unnamed': 'Untitled',
  'canvas.node.unverified': 'Unverified',
  'canvas.scope.global': 'Global',
  'canvas.scope.currentSession': 'This session',
  'canvas.scope.otherSession': 'Other session',
  'canvas.scope.session': 'Session',
  'canvas.note.defaultName': 'Note',
  'canvas.save.markdownText': 'Markdown text',
  'canvas.save.downloaded': 'Downloaded to the browser default download folder',
  'canvas.content.truncated': '… (content too long, truncated)',
  'canvas.error.conflict': 'The board was changed by another session. Refresh the page to load the latest content.',
  'canvas.error.unreachable': 'Network error (host unreachable)',
  'canvas.error.http': 'Request failed',
  'canvas.error.unknown': 'Unknown error',
  'canvas.toast.pinned': 'Pinned: {title}',
  'canvas.toast.notePinned': 'Note pinned',
  'canvas.toast.noPath': 'No path to copy',
  'canvas.toast.copiedId': 'ID copied',
  'canvas.toast.copiedTitle': 'Title copied',
  'canvas.toast.copiedPath': 'Path copied',
  'canvas.toast.copiedRef': 'Reference copied',
  'canvas.toast.copyFailed': 'Copy failed',
  'canvas.toast.noLocalPath': 'This node has no local path to open',
  'canvas.toast.opened': 'Opened with the default app: {title}',
  'canvas.toast.openedFolder': 'Opened the containing folder: {title}',
  'canvas.toast.openFailed': 'Open failed: {message}',
  'canvas.toast.noContent': 'This node has no content to save',
  'canvas.toast.saved': 'Saved: {title}',
  'canvas.toast.savedWith': 'Saved: {title} ({message})',
  'canvas.toast.saveFailed': 'Save failed: {message}',
  'canvas.toast.migrateOffline': 'The canvas backend is offline — ownership cannot be moved',
  'canvas.toast.migrateConflict': 'The board was changed by another session. Refresh and retry.',
  'canvas.toast.migrateFailed': 'Move failed: {message}',
  'canvas.toast.migrated': 'Ownership moved',
  'canvas.toast.jumping': 'Jumping to session: {name}',
  'canvas.toast.removed': 'Removed from the canvas',
  'canvas.type.folder': 'Folder',
  'canvas.type.markdown': 'Markdown',
  'canvas.type.plainText': 'Plain text',
  'canvas.type.image': 'Image',
  'canvas.type.media': 'Audio / video',
  'canvas.type.file': 'File',
  'canvas.board.aiZone': 'AI note zone · Notes added by AI land here; drag them anywhere',
  'canvas.board.hint': 'Drag empty space to pan · Space+drag also pans · Scroll to zoom (at pointer) · Zoom {percent}%',
  'canvas.board.lod': ' · Simplified zoomed-out view',
  'canvas.board.viewport': ' · Viewport {visible}/{total}',
  'canvas.card.aiPlaced': 'AI placed',
  'canvas.card.unverified': 'Unverified',
  'canvas.card.preview': 'Preview',
  'canvas.card.save': 'Save',
  'canvas.card.saveTitle': 'Save content to a local file',
  'canvas.card.open': 'Open',
  'canvas.card.openTitle': 'Open with the system default app',
  'canvas.card.openFolder': 'Folder',
  'canvas.card.openFolderTitle': 'Open the containing folder in the system file manager (Finder / Explorer)',
  'canvas.card.migrate': 'Owner',
  'canvas.card.migrateTitle': 'Move this node (this session / this project / all projects)',
  'canvas.card.jump': 'Jump',
  'canvas.card.jumpTitle': 'Jump to the session that owns this node',
  'canvas.card.copyId': 'Copy ID',
  'canvas.card.copyTitle': 'Copy title',
  'canvas.card.copyPath': 'Copy path',
  'canvas.card.copyRef': 'Reference',
  'canvas.card.remove': 'Remove',
  'canvas.card.resizeAria': 'Drag to resize the card',
  'canvas.card.resizeTitle': 'Drag to resize',
  'canvas.card.editorMarkdown': 'Write Markdown…',
  'canvas.card.editorPlain': 'Write plain text…',
  'canvas.card.imagePreview': 'Image preview',
  'canvas.card.audio': 'Audio',
  'canvas.card.video': 'Video',
  'canvas.card.folderNoBrowse': ' · Inline browsing is not supported yet',
  'canvas.dialog.path.title': 'Pin by path',
  'canvas.dialog.path.desc': 'Paste a local path to create a card. Existence is not verified, so the card is marked "Unverified".',
  'canvas.dialog.path.label': 'Local path',
  'canvas.dialog.path.detected': 'Detected as: {glyph} {label}',
  'canvas.dialog.note.title': 'Pin a note',
  'canvas.dialog.note.aria': 'New note',
  'canvas.dialog.note.desc': 'The content lives on the canvas and points to no file.',
  'canvas.dialog.note.defaultTitle': 'Untitled note',
  'canvas.dialog.field.title': 'Title',
  'canvas.dialog.field.type': 'Type',
  'canvas.dialog.field.content': 'Content',
  'canvas.dialog.catalog.title': 'Search & pin',
  'canvas.dialog.catalog.desc': 'Search local files and pin one with a click.',
  'canvas.dialog.catalog.keyword': 'Keyword',
  'canvas.dialog.catalog.placeholder': 'contract / mockup / recording…',
  'canvas.dialog.catalog.scopeAria': 'Search scope',
  'canvas.dialog.catalog.scopeLocal': 'Whole machine',
  'canvas.dialog.catalog.scopeProject': 'Current project',
  'canvas.dialog.catalog.searching': 'Searching…',
  'canvas.dialog.catalog.error': 'Local search is unavailable',
  'canvas.dialog.catalog.noMatch': 'No matching files',
  'canvas.dialog.catalog.prompt': 'Type a keyword to search local files',
  'canvas.dialog.preview.aria': 'Preview',
  'canvas.dialog.preview.noteOnly': 'Canvas note',
  'canvas.dialog.preview.unverified': ' · Path unverified',
  'canvas.dialog.preview.empty': '(empty)',
  'canvas.dialog.preview.enableImage': 'Enable the canvas module to preview the real image',
  'canvas.dialog.preview.enableMedia': 'Enable the canvas module to play the real file',
  'canvas.dialog.preview.unsupported': 'This kind of item is not rendered in the browser yet (Word / PDF / folders, etc.).',
  'canvas.dialog.remove.aria': 'Confirm removal',
  'canvas.dialog.remove.title': 'Remove from the canvas?',
  'canvas.dialog.remove.body': 'Remove "{title}" from the canvas. The source file is not deleted.',
  'canvas.dialog.remove.bodyWithPath': 'Remove "{title}" from the canvas. The source file is not deleted ({path}).',
  'canvas.dialog.migrate.title': 'Move ownership',
  'canvas.dialog.migrate.body': 'Move "{title}" to:',
  'canvas.dialog.migrate.sessionDesc': 'Owned by this session (invisible from other sessions unless you switch to "All projects")',
  'canvas.dialog.migrate.projectDesc': 'Project level: visible to every session in this project',
  'canvas.dialog.migrate.globalLabel': 'Visible to all projects',
  'canvas.dialog.migrate.globalDesc': 'Global: visible from any session and any view',
  'advisor.level.conversation': 'This review conversation',
  'advisor.level.session': 'This session',
  'advisor.level.project': 'This project',
  'advisor.level.global': 'Global',
  'advisor.status.disabled': 'Disabled',
  'advisor.status.idle': 'Idle',
  'advisor.status.reviewing': 'Reviewing',
  'advisor.status.paused': 'Paused',
  'advisor.status.halted': 'Halted',
  'advisor.severity.info': 'info · note',
  'advisor.severity.nit': 'nit · suggestion',
  'advisor.severity.concern': 'concern · watch',
  'advisor.severity.blocker': 'blocker · blocking',
  'advisor.severity.answer': 'answer',
  'advisor.outcome.delivered': 'Delivered',
  'advisor.outcome.recorded': 'Recorded',
  'advisor.outcome.answered': 'Answered',
  'advisor.outcome.suppressed': 'Suppressed',
  'advisor.outcome.noNote': 'No note',
  'advisor.outcome.dropped': 'Dropped',
  'advisor.outcome.failed': 'Review failed',
  'advisor.outcome.cancelled': 'Cancelled',
  'advisor.ago.none': 'No activity yet',
  'advisor.ago.justNow': 'Just now',
  'advisor.ago.seconds': '{count}s ago',
  'advisor.ago.minutes': '{count}m ago',
  'advisor.ago.hours': '{count}h ago',
  'advisor.workspace.unknown': 'Unknown workspace',
  'advisor.workspace.unknownShort': 'unknown',
  'advisor.header.toggle.titleOff': 'The Advisor panel is hidden; click to open settings',
  'advisor.capsule.aria': 'Open the session review panel',
  'advisor.capsule.title': 'Open the session review panel (press and drag along the right edge to move it)',
  'advisor.unread.aria': '{count} unread reviews',
  'advisor.panel.aria': 'Session review floating panel',
  'advisor.panel.title': 'Session review',
  'advisor.panel.collapse': 'Collapse',
  'advisor.panel.collapseAria': 'Collapse the Advisor panel',
  'advisor.statusStrip.aria': 'Advisor runtime status',
  'advisor.switch.title': 'Toggles this session only; the global default switch is unchanged',
  'advisor.switch.on': 'Enabled in this session',
  'advisor.switch.off': 'Not enabled in this session',
  'advisor.model.unresolved': 'Model unresolved',
  'advisor.gate.failed': 'Model gate failed: {reason}',
  'advisor.gate.configIncomplete': 'provider and model must be set together or left empty together',
  'advisor.gate.modelUnavailable': 'the current session model is unavailable',
  'advisor.notice.dismiss': 'Dismiss the notice',
  'advisor.tabs.aria': 'Review data views',
  'advisor.tab.scopes': 'Scopes',
  'advisor.tab.live': 'Live',
  'advisor.tab.history': 'History',
  'advisor.tab.settings': 'Settings',
  'advisor.live.aria': 'Live review stream',
  'advisor.live.emptyEnabled': 'No review activity yet. New reviews appear here in real time.',
  'advisor.live.emptyDisabled': 'Not enabled: use the session switch above, or enable Advisor in Settings below.',
  'advisor.live.backToLatest': 'Back to latest',
  'advisor.instructions.aria': 'Advisor instructions',
  'advisor.instructions.placeholder': 'Send the reviewer an instruction… (Enter to send, Shift+Enter for a new line)',
  'advisor.instructions.send': 'Send',
  'advisor.instructions.hint': 'Review notes are delivered in real time by severity (nit/concern/blocker steer the session; info is only recorded by default). A question in the instruction box triggers an Advisor answer that is injected into the conversation.',
  'advisor.conversation.statsTitle': 'Context used by the reviewer conversation (estimated characters; about 1 token per CJK character). Compare with the model context window to decide whether to start a new review conversation.',
  'advisor.conversation.epoch': 'Review conversation #{epoch}',
  'advisor.conversation.label': 'Review conversation',
  'advisor.conversation.contextCount': '{count} context items',
  'advisor.conversation.reset': 'New review conversation',
  'advisor.conversation.resetConfirm': 'Starting a new review conversation clears the reviewer\'s entire context and memory (it starts from scratch).\nYou can give it background in the first instruction.',
  'advisor.conversation.resetTitle': 'Clear the reviewer conversation (context + memory) and start from scratch; useful when switching tasks or capping context length',
  'advisor.pending.toggle': 'Pending instructions ({count})',
  'advisor.pending.empty': 'No pending instructions',
  'advisor.pending.consuming': 'Consuming',
  'advisor.pending.waiting': 'Pending',
  'advisor.pending.clear': 'Clear pending instructions',
  'advisor.action.retry': 'Retry',
  'advisor.action.save': 'Save',
  'advisor.action.saving': 'Saving…',
  'advisor.history.aria': 'Review history',
  'advisor.history.sessionFilter': 'Session filter',
  'advisor.history.sessionCurrent': 'Current session',
  'advisor.history.sessionAll': 'All sessions',
  'advisor.history.severityFilter': 'Severity filter',
  'advisor.history.severityAll': 'All severities',
  'advisor.history.severityAnswer': 'Answer',
  'advisor.history.timeFilter': 'Time filter',
  'advisor.history.timeAll': 'All time',
  'advisor.history.time24h': 'Last 24 hours',
  'advisor.history.time7d': 'Last 7 days',
  'advisor.history.time30d': 'Last 30 days',
  'advisor.history.workspacePlaceholder': 'Workspace (optional)',
  'advisor.history.workspaceFilter': 'Workspace filter',
  'advisor.history.query': 'Query',
  'advisor.history.empty': 'No review records match the current filters.',
  'advisor.history.loadMore': 'Load more',
  'advisor.loading.events': 'Connecting to the Advisor live stream…',
  'advisor.loading.records': 'Loading history…',
  'advisor.loading.scopes': 'Loading scopes…',
  'advisor.loading.settings': 'Loading settings…',
  'advisor.loading.short': 'Loading…',
  'advisor.error.statusLoad': 'Failed to load status: {message}',
  'advisor.error.eventsLoad': 'Failed to load the live stream: {message}',
  'advisor.error.recordsLoad': 'Failed to load history: {message}',
  'advisor.error.scopesLoad': 'Failed to load scopes: {message}',
  'advisor.error.scopesSave': 'Failed to save scopes: {message}',
  'advisor.error.configLoad': 'Failed to load settings: {message}',
  'advisor.error.rebuildFailed': 'The live cursor expired and rebuilding history failed: {message}',
  'advisor.error.noDetail': 'Operation failed (no error details)',
  'advisor.notice.reconnected': 'Connection restored — resyncing Advisor events…',
  'advisor.notice.instructionSent': 'Instruction sent — the Advisor is answering (the answer is injected into the conversation)',
  'advisor.notice.conversationReset': 'Started a new review conversation (#{epoch}) — you can give the reviewer background in the first instruction',
  'advisor.notice.instructionsCleared': 'Cleared {count} pending instructions',
  'advisor.notice.sessionEnabled': 'Advisor is enabled in this session',
  'advisor.notice.sessionDisabled': 'Advisor is disabled in this session',
  'advisor.notice.configSaved': 'Advisor settings saved and applied',
  'advisor.notice.scopeSaved': 'Saved {level}; it takes effect on the next review',
  'advisor.card.aria': 'Session review {reviewId}',
  'advisor.card.instructions': 'Instructions run ×{count}',
  'advisor.card.sessionEpoch': 'Session #{epoch}',
  'advisor.card.qa': ' · Q&A',
  'advisor.card.thisRound': ' · {count} this round',
  'advisor.card.collapse': 'Collapse ▴',
  'advisor.card.expand': 'Expand ▾',
  'advisor.card.noInputSnapshot': 'Historical records do not include the input snapshot',
  'advisor.card.reviewing': 'Reviewing…',
  'advisor.card.suppressedNote': 'Suppressed: the gate blocked this note (duplicate / too vague / one per turn); it was not injected into the main conversation',
  'advisor.card.retryable': '(retryable)',
  'advisor.card.errorSep': ': ',
  'advisor.delivery.steer': 'Delivered ✓',
  'advisor.delivery.inject': 'Injected ✓',
  'advisor.scopes.aria': 'Reviewer scopes',
  'advisor.scopes.boundaryError': 'The scopes area failed to render: {message} (see the browser console)',
  'advisor.scopes.hint': 'The four scope levels are appended to the reviewer system prompt (the more local level wins on conflict) and take effect immediately after saving.',
  'advisor.scopes.conversationLabel': '{level} (cleared by "New review conversation")',
  'advisor.scopes.conversationPlaceholder': 'Applies to this review conversation only… (multi-line; several instructions at once are fine)',
  'advisor.scopes.sessionLabel': '{level} (valid for this session)',
  'advisor.scopes.sessionPlaceholder': 'Applies to this session only…',
  'advisor.scopes.projectLabel': '{level} (shared by every session in workspace {workspace})',
  'advisor.scopes.projectPlaceholder': 'Applies to every session in this project…',
  'advisor.scopes.globalLabel': '{level} (applies to all projects and sessions)',
  'advisor.scopes.globalPlaceholder': 'Applies to all projects and sessions… (e.g. always answer in Chinese; do not repeat notes already raised)',
  'advisor.context.chars': '{count} chars',
  'advisor.settings.title': 'Session review settings',
  'advisor.settings.masterSwitchHint': 'The module master switch lives in the Config area of the "Memory Evolve Settings" tab',
  'advisor.settings.showCapsule': 'Show the floating capsule button',
  'advisor.settings.infoInjectTitle': 'info is the lowest severity: recorded only by default; when enabled it is injected (without interrupting)',
  'advisor.settings.infoInject': 'Also inject info-level notes',
  'advisor.settings.provider': 'Provider',
  'advisor.settings.model': 'Model',
  'advisor.settings.inheritPlaceholder': 'Empty inherits the session',
  'advisor.settings.systemPrompt': 'Reviewer system prompt',
  'advisor.settings.promptBuiltin': '(using the built-in default prompt; edit and save to customize)',
  'advisor.settings.promptCustom': '(custom)',
  'advisor.settings.promptPlaceholder': 'Empty uses the built-in reviewer prompt',
  'advisor.settings.restore': 'Restore default prompt',
  'advisor.settings.restoreTitle': 'Restore the built-in default prompt (applied immediately after saving; the box then shows the latest built-in default)',
  'advisor.settings.overrideHint': 'The global default does not clear this session\'s override; use the status strip above to toggle this session.',
  'advisor.settings.save': 'Save settings',
  'advisor.settings.providerModelPair': 'provider and model must both be filled in, or both left empty to inherit the session model.',
  'mobile.moreActions': 'More actions',
  // COI/提示词迁移补齐键（2026-09-16 i18n）
  'coi.status.queued': 'Queued',
  'coi.status.running': 'Running',
  'coi.status.completed': 'Completed',
  'coi.status.failed': 'Failed',
  'coi.status.killed': 'Killed',
  'coi.status.interrupted': 'Interrupted',
  'coi.ago.justNow': 'just now',
  'coi.ago.seconds': '{count}s ago',
  'coi.ago.minutes': '{count}m ago',
  'coi.ago.hours': '{count}h ago',
  'coi.sep.colon': ': ',
  'coi.sep.paren': ' ({value})',
  'coi.error.noDetail': 'Operation failed (no error details)',
  'coi.tasks.deleteFailed': 'Delete failed',
  'coi.tasks.deleted': 'Deleted',
  'coi.adapters.saveFailed': 'Save failed',
  'coi.adapters.opFailed': 'Operation failed',
  'coi.adapters.readFailed': 'Read failed',
  'coi.adapters.avgMs': '⏱ avg {minutes} min',
  'coi.adapters.avgMsTitle': 'Average duration of completed tasks (same source as de_coi_adapters)',
  'prompt.untitledName': 'Untitled prompt',
  'prompt.deleteCategoryConfirm': 'Delete the category "{name}"? {hint}',
  'prompt.quotedTitle': '"{name}"',
  'prompt.plusGlyph': '+',
  // mermaid 渲染器 / 版本页补漏（2026-09-16 i18n）
  'mermaid.renderFailed': '⚠ mermaid render failed, code kept',
  'mermaid.renderFailedDetail': '⚠ mermaid render failed: {detail}, code kept',
  'mermaid.download': 'SVG',
  'mermaid.downloadTitle': 'Download diagram as SVG',
  'version.sep.colon': ': ',
}

/** Badge poll interval (ms). */
const BADGE_POLL_MS = 30_000

/**
 * The plugin entry: register locale and stylesheet, then the session memory
 * tab (default ON) with a red-dot pending count on its label. The former
 * settings-panel section (MemoryPanel) is gone — the tab now hosts the
 * suggestion/skill queues and the runtime config as sub-tabs. 'conversation'
 * is an ordering edge for the session memory tab (its 'conversation.view'
 * slot is declared by ui-conversation).
 * @param ctx - the client plugin context (`slots`, `locale` injected).
 */
/**
 * 移动端适配声明（dsh-android-edapp 适配协议路径 B —— 协议唯一真源字段）。
 *
 * ## 协议用途
 * dsh-android-edapp（手机适配插件）二期定义了"适配协议"（ADAPTER PROTOCOL
 * v1，文档：dsh-android-edapp/docs/ADAPTER-PROTOCOL.md）：第三方插件在自己
 * 的 ./client 导出面上声明 `dshMobile` 字段，dsh-android-edapp 会在启动时
 * 扫描 `ctx.modules.loadCache`、并在本插件素材化（页面加载/首次用到 UI）时
 * 增量发现，自动把 css 原样包裹进 `@media (max-width: 767px)` 注入页面。
 * 字段名 `dshMobile` 是协议唯一真源，**不要改名**；导出面异常/字段缺失会
 * 被静默跳过，不影响插件本体。
 *
 * ## 为什么放在导出面而不是 apply() 里注入
 * 协议约定由 dsh-android-edapp 统一负责发现与注入（含注入/清理生命周期、
 * 与通用兜底层的加载顺序），插件自身不再手动往 <head> 里塞移动端样式。
 * 2026-08-09 用户拍板：memory-evolve 的 9+1 个 Tab 手机适配（约 330 行，
 * 原为 dsh-android-edapp 的 src/client/mobile-tabs.css）整体迁回本插件，
 * 适配跟着插件走——升级改自己即可；dsh-android-edapp 只留外壳 + 通用兜底
 * + 适配管理器。
 *
 * ## css 编写纪律（详见 src/client/mobile.css 文件头）
 * 不写 @media（统一由 dsh-android-edapp 包裹）；选择器一律带
 * `html[data-dsh-mobile]` 前缀；只覆盖布局/尺寸不改颜色；与通用兜底层
 * （mobile-fallback.css）方向相反的规则必须加 !important 表明意图。
 */
export const dshMobile = {
  /** 移动端 CSS 片段（字符串，构建时经 esbuild --loader:.css=text 原样内联）。 */
  css: mobileCss,
  /** 移动端 DOM 增强：输入栏上拉弹窗（注入「⋯」入口按钮 + 切换
   *  data-dsh-mobile-sheet 属性，mobile.css 据此把 .tools + 模型选择
   *  显示为 fixed 底栏；常驻保留发送/圆环/⋯）。协议约定：移动模式
   *  激活时调用一次，返回 dispose。 */
  enhance: (): (() => void) => createInputSheetEnhance(activeTranslate ?? ((key: string) => key)),
}

export const inject = ['slots', 'locale', 'conversation', 'sessions']

/**
 * Client plugin body: register the session memory tab when the host switch
 * is on (default ON; flipping it in the tab's runtime-config sub-tab takes
 * effect after a page reload).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS) as unknown as Translate

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory-evolve: dictionaries')

  // 模块级导出面（dshMobile.enhance）的调用期翻译镜像：见 activeTranslate 注释。
  ctx.effect(() => {
    activeTranslate = t
    return () => { activeTranslate = null }
  }, 'memory-evolve: module-scope translate mirror')

  // S4（2026-09-16）：把**当前界面语言**交给宿主模块侧的私有字典解析器。
  // 随包客户端里有几处自带 zh/en 双语的私有字典（CoIView / PromptView /
  // BroadcastView / AdvisorPanel / MemoryQueueView / TodoView / SyncView），
  // 它们此前读 `navigator.language`（= 操作系统语言、模块加载期求值一次）⇒
  // 用户在设置里切语言时那些界面不跟随。这里注册一个**调用期**解析器
  // （读 locale 快照，语言一变即生效）。
  ctx.effect(() => {
    setClientLocaleResolver(() => {
      const active = ctx.locale.getSnapshot().active
      return active === 'zh' || active === 'en' ? active : undefined
    })
    return () => setClientLocaleResolver(null)
  }, 'memory-evolve: private-dictionary locale resolver')

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-memory-evolve-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.memoryEvolveCss = '1'
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: stylesheet')

  // Skill-browser styles (merged from the standalone dsh-skill-browser
  // plugin): sb- prefixed, injected alongside the panel styles.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-skill-browser-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.skillBrowserCss = '1'
    tag.textContent = skillBrowserStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: skill browser stylesheet')

  // COI 调度样式（coi- 前缀，独立注入）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-coi-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.coiCss = '1'
    tag.textContent = coiStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: coi stylesheet')

  // 会话广播样式（bb- 前缀，独立注入）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-broadcast-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.broadcastCss = '1'
    tag.textContent = broadcastStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: broadcast stylesheet')

  // 提示词样式（pm- 前缀，独立注入）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-prompt-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.promptCss = '1'
    tag.textContent = promptStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: prompt stylesheet')

  // Web UI 设置样式（ui- 前缀，独立注入）。样式本身无副作用：过滤规则
  // 依赖 html[data-dsh-ui-filter] 属性（session-filter.ts 激活后才设置），
  // 无属性时不生效——因此样式常驻注入（与其他模块样式同款），真正的开关
  // 控制在下方：探测 /api/ui-settings/state 成功才激活筛选与注册 Tab。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-ui-settings-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.uiSettingsCss = '1'
    tag.textContent = uiSettingsStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: ui-settings stylesheet')

  // Mermaid 图表渲染样式（me-mermaid- 前缀，独立注入）。样式本身无副作用
  // （.me-mermaid-wrap 只在渲染器替换代码块后出现），常驻注入与 ui-settings
  // 同款；真正的开关控制在下方：探测 /api/ui-settings/state 成功后按
  // mermaidRender 功能开关启停观察器。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-me-mermaid-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.meMermaidCss = '1'
    tag.textContent = mermaidStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: mermaid stylesheet')

  // 会话书签样式（bm- 前缀，独立注入）。样式常驻无副作用；真正开关控制
  // 在下方：探测 /api/bookmarks/state 成功才注册 turnTail 星标与「书签」Tab。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-bookmark-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.bookmarkCss = '1'
    tag.textContent = bookmarkStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: bookmark stylesheet')

  // Advisor 悬浮面板样式（advisor- 前缀）：面板本体 portal 到 body，故样式
  // 必须由客户端入口常驻注入，不能依赖某个 conversation.view Tab 的生命周期。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-advisor-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.advisorCss = '1'
    tag.textContent = advisorStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: advisor stylesheet')

  // web 站内通知铃铛样式（me-notify- 前缀）：铃铛 portal 到 body，样式须由
  // 客户端入口常驻注入（与 advisor 悬浮面板同款，不依赖 Tab 生命周期）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-notify-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.notifyCss = '1'
    tag.textContent = notificationStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: notification stylesheet')

  // web 站内通知铃铛（全局右上角）：探测宿主端 /api/notifications/unread 成功
  // 才挂载（notifyEnabled 开启时 API 才挂载，关闭时 404 → 铃铛不注入）。
  // 「跳转到会话」经 DSH client 的 sessions 服务 ctx.sessions.open(sessionId)
  // 切换（2026-08-13 调研：官方唯一切换入口，ui-workspace 同款路径）。
  let notifyBellCancelled = false
  let disposeNotifyBell: (() => void) | undefined
  void fetch('/memory-evolve/api/notifications/unread')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      if (notifyBellCancelled) return
      disposeNotifyBell = createNotificationBell({
        openSession: (sessionId) => { ctx.sessions.open(sessionId) },
        t,
      }).dispose
    })
    .catch(() => { /* 通知模块未启用：铃铛保持隐藏 */ })
  ctx.effect(() => () => {
    notifyBellCancelled = true
    disposeNotifyBell?.()
  }, 'memory-evolve: notification bell')

  // 会话页顶部 Tab 顺序（2026-08-11 用户拍板：记忆 技能 待办 COI调度 会话广播
  // 提示词 无限画板 记忆同步 模型设置 书签 Web UI设置 Memory Evolve设置；order
  // 按 10 步进，留插入余量）：
  //   10 记忆 / 20 技能 / 30 待办 / 40 COI调度 / 50 会话广播 / 60 提示词 /
  //   80 无限画板 / 80 记忆同步 / 90 模型设置 / 100 书签 / 110 Web UI设置 /
  //   120 Memory Evolve 设置
  // 每个 label 携带各自的待确认红点计数（记忆=记忆建议数、技能=技能建议数、
  // 待办=待办建议数），badge 变化时重新注册触发 label 重求值。
  let tabCancelled = false
  let memoryBadgeCount = 0
  // 版本检测红点（0/1）：有新发布版本时设置 Tab label 显示 🔴。
  // 与 count 类 badge 独立——由 /api/badge 的 update 字段驱动。
  let updateBadgeCount = 0
  let skillsBadgeCount = 0
  let todosBadgeCount = 0
  let disposeMemoryTab: (() => void) | undefined
  let disposeSkillsTab: (() => void) | undefined

  const registerMemoryTab = (): void => {
    disposeMemoryTab?.()
    disposeMemoryTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'memory-files',
        order: 10,
        label: () => (memoryBadgeCount > 0 ? t('memoryTab.label.pending', { count: memoryBadgeCount }) : t('memoryTab.label')),
      }, (props) => MemoryTabView({ ...props, t })))
  }
  const registerSkillsTab = (): void => {
    disposeSkillsTab?.()
    disposeSkillsTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'skills-hub',
        order: 20,
        label: () => (skillsBadgeCount > 0 ? t('skillsTab.label.pending', { count: skillsBadgeCount }) : t('skillsTab.label')),
      }, (props) => SkillsTabView({ ...props, t })))
  }
  // 待办 Tab 生命周期（todoEnabled 运行时开关）：默认启用；配置面板保存后
  // 经 RUNTIME_CONFIG_CHANGED 事件即时隐藏/恢复，无需刷新页面。
  const todoTabLifecycle = createTodoTabLifecycle(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'todos-hub',
      order: 30,
      label: () => (todosBadgeCount > 0 ? t('todosTab.label.pending', { count: todosBadgeCount }) : t('todosTab.label')),
    }, (props) => TodosTabView({ ...props, t }))))
  const onRuntimeConfigChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ todoEnabled?: boolean }>).detail
    todoTabLifecycle.setEnabled(detail?.todoEnabled !== false)
  }
  window.addEventListener(RUNTIME_CONFIG_CHANGED, onRuntimeConfigChanged)
  ctx.effect(() => () => window.removeEventListener(RUNTIME_CONFIG_CHANGED, onRuntimeConfigChanged), 'memory-evolve: todo tab runtime listener')
  // 设置 Tab（Memory Evolve 设置，order 120 放最后）：整体指南 + 配置 + 版本。
  // 红点：检测到新发布版本时 label 变 🔴 变体（updateBadgeCount 驱动，重注册
  // 生效；无红点时注册一次即可，badge 变化才重注册）。
  let disposeSettingsTab: (() => void) | undefined
  const registerSettingsTab = (): void => {
    disposeSettingsTab?.()
    disposeSettingsTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'settings-hub',
        order: 120,
        label: () => (updateBadgeCount > 0 ? t('settingsTab.label.pending') : t('settingsTab.label')),
      }, (props) => SettingsTabView({ ...props, t })))
  }
  // 模型设置 Tab（order 90，书签之后）：表格展示 DSH 供应商/模型 +
  // 每模型启用/备注/思考等级配置（de_models 工具的 Web 数据面）。
  // 与其他模块同款独立开关 modelsEnabled（默认开）：开关在「设置」Tab 的
  // 「配置」里切换，开启后刷新页面出现；关闭时 Tab 完全不可见（host 的
  // /api/models 路由在模块关闭时返回"未启用"）。
  let disposeModelsTab: (() => void) | undefined
  const registerModelsTab = (): void => {
    disposeModelsTab?.()
    disposeModelsTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'models-hub',
        order: 90,
        label: () => t('modelsTab.label'),
      }, (props) => ModelsTabView({ ...props, t })))
  }
  // 记忆同步 Tab（order 80）：跟随 syncEnabled 运行时开关
  // （开启后刷新页面出现，关闭时完全不可见）。
  let disposeSyncTab: (() => void) | undefined
  const registerSyncTab = (): void => {
    disposeSyncTab?.()
    disposeSyncTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'memory-sync-hub',
        order: 80,
        label: () => t('syncTab.label'),
      }, (props) => SyncView({ ...props, t })))
  }
  const pollBadge = (): void => {
    // 三个 tab 未注册前不轮询（registerMemoryTab 是探测成功的标志）。
    if (tabCancelled || disposeMemoryTab === undefined) return
    void fetch('/memory-evolve/api/badge')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { suggestions?: number; skills?: number; todoSuggestions?: number; update?: number }) => {
        const suggestions = data.suggestions ?? 0
        const skills = data.skills ?? 0
        const todoSuggestions = data.todoSuggestions ?? 0
        // 版本红点独立处理（不参与 count 语义；badge 只读缓存，绝不触发 git）。
        const update = data.update ?? 0
        if (update !== updateBadgeCount) {
          updateBadgeCount = update
          registerSettingsTab()
        }
        if (suggestions !== memoryBadgeCount) {
          memoryBadgeCount = suggestions
          registerMemoryTab()
        }
        if (skills !== skillsBadgeCount) {
          skillsBadgeCount = skills
          registerSkillsTab()
        }
        if (todoSuggestions !== todosBadgeCount) {
          todosBadgeCount = todoSuggestions
          todoTabLifecycle.refresh()
        }
      })
      .catch(() => { /* badge is best-effort; the tab still works */ })
  }

  void fetch('/memory-evolve/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { config?: { memoryTabEnabled?: boolean; modelsEnabled?: boolean } }) => {
      // 模型设置 tab：跟随 modelsEnabled 运行时开关（默认开，与其他模块
      // 同款独立开关，在「设置」Tab 的「配置」里切换；开启后刷新页面出现）。
      if (!tabCancelled && data.config?.modelsEnabled === true && disposeModelsTab === undefined) {
        registerModelsTab()
      }
      // 记忆同步 tab：跟随 syncEnabled 运行时开关（默认关，设置面板/命令
      // setup 打开后刷新页面出现）
      if (!tabCancelled && data.config?.syncEnabled === true && disposeSyncTab === undefined) {
        registerSyncTab()
      }
      // memoryTabEnabled is a read-only field of /api/config (default true;
      // only config.yaml can turn it off — deliberately NOT a runtime key,
      // since switching it off from inside the tab would hide the tab itself).
      if (tabCancelled || data.config?.memoryTabEnabled !== true) return
      // 四个核心 tab 一起注册：记忆 / 技能 / 待办 / 设置（顺序 10/20/30/120）。
      // 待办 Tab 额外受 todoEnabled 运行时开关控制（默认开；关闭时隐藏）。
      registerMemoryTab()
      registerSkillsTab()
      todoTabLifecycle.setEnabled(data.config?.todoEnabled !== false)
      registerSettingsTab()
      pollBadge()
      const timer = setInterval(pollBadge, BADGE_POLL_MS)
      ctx.effect(() => () => clearInterval(timer), 'memory-evolve: memory tab badge poller')
      // 版本检测：进入 Web UI 时触发一次惰性检测（24h 缓存内不跑 git）。
      // 完成后直接同步 updateBadgeCount + 重注册（等 30s 轮询太慢）；
      // badge-change 监听也已注册，后续 VersionTabView 的操作会走事件通道。
      void fetch('/memory-evolve/api/update/status')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((data: { ok?: boolean; status?: string }) => {
          if (tabCancelled) return
          const hasUpdate = data?.status === 'outdated' ? 1 : 0
          if (hasUpdate !== updateBadgeCount) {
            updateBadgeCount = hasUpdate
            registerSettingsTab()
          }
        })
        .catch(() => { /* best-effort：检测失败保持无红点，版本子 Tab 可手动重试 */ })
      // The tab's own queue actions (approve/archive/reject skills too) fire
      // this event after a mutation — re-poll immediately so the red-dot
      // label updates without waiting for the next 30s poll.
      const onTabChanged = (): void => pollBadge()
      window.addEventListener('dsh-memory-evolve:badge-change', onTabChanged)
      ctx.effect(() => () => window.removeEventListener('dsh-memory-evolve:badge-change', onTabChanged), 'memory-evolve: memory tab badge listener')
    })
    .catch(() => { /* the tab is optional; a failure just leaves it hidden */ })
  ctx.effect(() => () => {
    tabCancelled = true
    disposeMemoryTab?.()
    disposeSkillsTab?.()
    todoTabLifecycle.dispose()
    disposeSettingsTab?.()
  }, 'memory-evolve: memory tabs')

  // 记忆同步 Tab 的清理（注册本身在 /api/config 探测成功后进行；
  // registerSyncTab 重注册时已先卸旧槽，这里补上插件卸载路径——
  // 稳定版复审 P1-2：缺它会导致插件卸载/热重载后同步 Tab 槽位残留）。
  ctx.effect(() => () => {
    disposeSyncTab?.()
  }, 'memory-evolve: sync tab')

  // 模型设置 Tab 的清理（注册本身在 /api/config 探测成功后进行——
  // 与其他模块同款独立开关 modelsEnabled）。
  ctx.effect(() => () => {
    disposeModelsTab?.()
  }, 'memory-evolve: models tab')

  // COI 调度 Tab（conversation.view 第二个 slot）：探测 host 端 COI API
  // 存在才注册（coiEnabled=false 时 API 404，Tab 自动隐藏）。label 带红点
  // 计数：有运行中/排队中任务（按当前会话可见性）时显示「🔴 COI调度 (N)」
  // ——30s 轮询任务列表 + 监听 badge-change 事件（派发任务后即时刷新）；
  // 计数变化时重新注册触发 label 重求值（与记忆/技能/待办 Tab 同机制）。
  let coiCancelled = false
  let disposeCoiTab: (() => void) | undefined
  let coiRunningCount = 0
  /** 当前会话 id：由 COI Tab 渲染时缓存（任务可见性按会话过滤的依据）。 */
  let currentCoiSessionId: string | undefined

  const registerCoiTab = (): void => {
    disposeCoiTab?.()
    disposeCoiTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'coi-hub',
        order: 40,
        label: () => (coiRunningCount > 0 ? t('coiTab.label.pending', { count: coiRunningCount }) : t('coiTab.label')),
      }, (props) => {
        currentCoiSessionId = (props as { sessionId?: string }).sessionId
        return CoIView({ ...props, t })
      }))
  }

  const pollCoiRunning = (): void => {
    if (coiCancelled || disposeCoiTab === undefined) return
    // 带会话视角查询（与任务列表同规则：temporary/session=本会话、project=本
    // 工作区、global=全显）；limit 放宽到 200，运行中任务不可能超此量。
    const q = currentCoiSessionId !== undefined
      ? `?limit=200&sessionId=${encodeURIComponent(currentCoiSessionId)}`
      : '?limit=200'
    void fetch(`/memory-evolve/api/coi/tasks${q}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { tasks?: Array<{ status?: string }> }) => {
        const running = (data.tasks ?? []).filter((t) => t.status === 'running' || t.status === 'queued').length
        if (running !== coiRunningCount) {
          coiRunningCount = running
          registerCoiTab()
        }
      })
      .catch(() => { /* 红点是尽力而为；Tab 本身不受影响 */ })
  }

  void fetch('/memory-evolve/api/coi/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      if (coiCancelled) return
      registerCoiTab()
      pollCoiRunning()
      const coiTimer = setInterval(pollCoiRunning, BADGE_POLL_MS)
      ctx.effect(() => () => clearInterval(coiTimer), 'memory-evolve: coi tab badge poller')
      // 派发任务/任务状态变化后（CoIView 触发 badge-change）立即重查红点。
      const onCoiBadgeChange = (): void => pollCoiRunning()
      window.addEventListener('dsh-memory-evolve:badge-change', onCoiBadgeChange)
      ctx.effect(() => () => window.removeEventListener('dsh-memory-evolve:badge-change', onCoiBadgeChange), 'memory-evolve: coi tab badge listener')
    })
    .catch(() => { /* COI 未启用：Tab 保持隐藏 */ })
  ctx.effect(() => () => {
    coiCancelled = true
    disposeCoiTab?.()
  }, 'memory-evolve: coi tab')

  // Advisor 只占 strict-session header.actions：同一组件渲染 header toggle，
  // 并 createPortal(document.body) 挂悬浮面板；不得注册 conversation.view Tab。
  // dispose 注册（稳定版复审 P1-1）：插件卸载/热重载时必须移除槽位，
  // 否则 AdvisorHost 卸载后 store 的轮询失去 UI 但仍持续打 /events。
  let disposeAdvisor: (() => void) | undefined
  disposeAdvisor = ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'advisor-review-panel',
      order: 30,
    }, (props) => AdvisorHost({ ...props, t })))
  ctx.effect(() => () => {
    disposeAdvisor?.()
  }, 'memory-evolve: advisor panel')

  // DSH 重连会让 host 的内存 ring/连接代次发生变化；转成浏览器事件后，
  // 每个 session store 都会取消旧请求、清空 after 游标并立即重新同步。
  ctx.effect(() => ctx.on('connection/reset', () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(ADVISOR_CONNECTION_RESET_EVENT))
  }), 'memory-evolve: advisor connection reset')

  // 会话身份配套：会话头部「⧉ 复制会话 ID」「✎ 别名」按钮——**属于会话
  // 编排/身份**（用户拍板 2026-08-09：不是广播的功能，从 broadcastEnabled
  // 迁移到 sessionEnabled）。用户把当前会话 ID/别名复制给另一个会话，
  // 对方 AI 用 de_broadcast 广播或 de_session 编排；广播面板顶部另有
  // 「我的会话 ID 复制」，只开广播不开会话编排时复制能力仍可用。
  let sessionHeaderCancelled = false
  let disposeCopyId: (() => void) | undefined
  void fetch('/memory-evolve/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { config?: { sessionEnabled?: boolean } }) => {
      if (sessionHeaderCancelled || data.config?.sessionEnabled !== true) return
      // 头部 actions 是 strict-session slot：entry 组件自动收到 sessionId。
      disposeCopyId = ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'copy-session-id',
          order: 0,
        }, (props) => HeaderActions({ ...props, t })))
    })
    .catch(() => { /* 会话编排未启用：头部按钮保持隐藏 */ })
  ctx.effect(() => () => {
    sessionHeaderCancelled = true
    disposeCopyId?.()
  }, 'memory-evolve: session header buttons')

  // 会话广播管理 Tab（conversation.view）：跟随 broadcastEnabled——探测
  // /memory-evolve/api/broadcast 存在才注册（未启用时 API 404，Tab 隐藏）。
  let broadcastTabCancelled = false
  let disposeBroadcastTab: (() => void) | undefined
  void fetch('/memory-evolve/api/broadcast/messages')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      if (broadcastTabCancelled) return
      disposeBroadcastTab = ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'broadcast-hub',
          order: 50,
          label: () => t('broadcastTab.label'),
        }, (props) => BroadcastView({ ...props, t })))
    })
    .catch(() => { /* 广播未启用：Tab 保持隐藏 */ })
  ctx.effect(() => () => {
    broadcastTabCancelled = true
    disposeBroadcastTab?.()
  }, 'memory-evolve: broadcast tab')

  // Web UI 设置模块（dsh-ui-settings）：**独立子模块**。探测宿主端
  // /api/ui-settings/state（uiSettingsEnabled 开关，默认关）——成功才：
  //  Web UI 设置模块（dsh-ui-settings）：**独立子模块**。探测宿主端
  //  /api/ui-settings/state（uiSettingsEnabled 开关，默认关）——成功才：
  //   1. 激活各功能（全局 DOM 增强，不依赖任何 Tab 打开）：
  //      - 会话筛选（session-filter.ts：筛选条 + MutationObserver 保活 +
  //        localStorage 偏好，默认只显示进行中的会话）；
  //      - 对话区加宽（wide-chat.ts：--dsh-chat-content-width 变量覆盖）；
  //      每个功能有**独立小开关**（「综合」子 tab，localStorage + 事件
  //      广播）：初始按 readFeatures() 应用，FEATURES_EVENT 时即时同步；
  //   2. 注册「Web UI 设置」Tab（conversation.view，综合/指南界面）。
  //  模块关闭（端点 404）时全部不注入；清理 effect 一并卸载。
  let uiSettingsCancelled = false
  let disposeUiSettingsTab: (() => void) | undefined
  let disposeSessionFilter: (() => void) | undefined
  let disposeWideChat: (() => void) | undefined
  let disposeWideBubble: (() => void) | undefined
  let disposeContextMeterWarn: (() => void) | undefined
  let disposeMermaidRender: (() => void) | undefined
  void fetch('/memory-evolve/api/ui-settings/state')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { enabled?: boolean }) => {
      if (uiSettingsCancelled || data.enabled !== true) return
      // 1. 创建各功能控制器（先创建、后按开关状态 setEnabled）。
      const sessionFilter = createSessionFilter({
        barTitle: t('uiSettings.feature.sessionFilter'),
        on: t('uiSettings.filter.on'),
        off: t('uiSettings.filter.off'),
        runningLabel: t('uiSettings.running.label'),
        ungroupedLabel: t('uiSettings.ungrouped'),
      })
      disposeSessionFilter = sessionFilter.dispose
      const wideChat = createWideChat()
      disposeWideChat = wideChat.dispose
      const wideBubble = createWideBubble()
      disposeWideBubble = wideBubble.dispose
      const contextMeterWarn = createContextMeterWarn()
      disposeContextMeterWarn = contextMeterWarn.dispose
      // i18n：渲染失败提示/下载按钮文案经注册字典（t 在调用期解析语言）。
      const mermaidRenderer = createMermaidRenderer(t)
      disposeMermaidRender = mermaidRenderer.dispose
      // 按「综合」子 tab 的独立开关应用初始状态。
      const features = readFeatures()
      sessionFilter.setEnabled(features.sessionFilter)
      wideChat.setEnabled(features.wideChat)
      wideBubble.setEnabled(features.wideBubble)
      contextMeterWarn.setEnabled(features.contextWarn)
      mermaidRenderer.setEnabled(features.mermaidRender)
      // 开关变更事件（UiSettingsTabView 切换后广播）→ 即时同步注入。
      const onFeaturesChanged = (event: Event): void => {
        const next = (event as CustomEvent<ReturnType<typeof readFeatures>>).detail
        if (next === undefined) return
        sessionFilter.setEnabled(next.sessionFilter)
        wideChat.setEnabled(next.wideChat)
        wideBubble.setEnabled(next.wideBubble)
        contextMeterWarn.setEnabled(next.contextWarn)
        mermaidRenderer.setEnabled(next.mermaidRender)
      }
      window.addEventListener(FEATURES_EVENT, onFeaturesChanged)
      ctx.effect(() => () => window.removeEventListener(FEATURES_EVENT, onFeaturesChanged), 'memory-evolve: ui-settings features listener')
      // 2. 注册「Web UI 设置」Tab。
      disposeUiSettingsTab = ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'ui-settings-hub',
          order: 110,
          label: () => t('uiSettingsTab.label'),
        }, (props) => UiSettingsTabView({ ...props, t })))
    })
    .catch(() => { /* Web UI 设置未启用：不注入任何东西 */ })
  ctx.effect(() => () => {
    uiSettingsCancelled = true
    disposeUiSettingsTab?.()
    disposeSessionFilter?.()
    disposeWideChat?.()
    disposeWideBubble?.()
    disposeContextMeterWarn?.()
    disposeMermaidRender?.()
  }, 'memory-evolve: ui-settings tab')

  // 提示词 Tab（conversation.view 第四个 entry）：提示词管理器。跟随 host
  // API 探测注册（prompts 模块为插件常驻能力，无独立开关）。label 带红点
  // 计数：有活跃注入时显示「🔴 提示词 (N)」——30s 轮询注入轨 + 监听
  // badge-change 事件（注入/停止后 PromptView 即时触发）刷新。
  let promptCancelled = false
  let disposePromptTab: (() => void) | undefined
  let promptBadgeCount = 0
  const registerPromptTab = (): void => {
    disposePromptTab?.()
    disposePromptTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'prompt-hub',
        order: 60,
        label: () => promptBadgeCount > 0
          ? t('promptTab.label.active', { count: promptBadgeCount })
          : t('promptTab.label'),
      }, (props) => PromptView({ ...props, t })))
  }
  const pollPromptBadge = (): void => {
    if (promptCancelled || disposePromptTab === undefined) return
    void fetch('/memory-evolve/api/prompts/injections')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { injections?: unknown[] }) => {
        const count = data.injections?.length ?? 0
        if (count !== promptBadgeCount) {
          promptBadgeCount = count
          registerPromptTab()
        }
      })
      .catch(() => { /* badge is best-effort; the tab still works */ })
  }
  void fetch('/memory-evolve/api/prompts/sources')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      if (promptCancelled) return
      registerPromptTab()
      pollPromptBadge()
      const promptBadgeTimer = setInterval(pollPromptBadge, BADGE_POLL_MS)
      ctx.effect(() => () => clearInterval(promptBadgeTimer), 'memory-evolve: prompt tab badge poller')
      const onPromptBadgeChange = (): void => pollPromptBadge()
      window.addEventListener('dsh-memory-evolve:badge-change', onPromptBadgeChange)
      ctx.effect(() => () => window.removeEventListener('dsh-memory-evolve:badge-change', onPromptBadgeChange), 'memory-evolve: prompt tab badge listener')
    })
    .catch(() => { /* host 端不可用：Tab 保持隐藏 */ })
  ctx.effect(() => () => {
    promptCancelled = true
    disposePromptTab?.()
  }, 'memory-evolve: prompt tab')

  // 会话书签（session bookmarks）：**独立子模块**。探测宿主端
  // /api/bookmarks/state（bookmarkEnabled 开关，默认关）——成功才：
  //   1. 星标按钮 DOM 注入器（B 方案，用户拍板：**不占** conversation.chat.
  //      turnTail chain 槽——该槽与官方 produced-files 行互斥（first-wins），
  //      占用会把官方"生成的文件"行挤掉；改为 MutationObserver 把星标
  //      "贴"到轮尾操作区旁，官方行保留，两者共存）；
  //   2. 会话 id 捕获器（conversation.session.header.actions list 槽的隐藏
  //      entry：strict-session slot 自动带 sessionId，渲染 null 零 UI，只
  //      把当前会话 id 写入模块变量供注入器读取——DOM 注入拿不到 id）；
  //   3. 注册「书签」Tab（conversation.view，列表 + 跳转 + 指南）。
  // 关闭时端点 404，客户端全部不注入。
  let bookmarkCancelled = false
  let disposeBookmarkTab: (() => void) | undefined
  let disposeBookmarkCapture: (() => void) | undefined
  let disposeBookmarkInjector: (() => void) | undefined
  let currentBookmarkSessionId = '' // 由捕获器写入，注入器点击时读取
  let bookmarkInjectorStarted = false // 防重复创建（捕获器可能多次渲染）
  void fetch('/memory-evolve/api/bookmarks/state')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { enabled?: boolean }) => {
      if (bookmarkCancelled || data.enabled !== true) return
      // 1. 会话 id 捕获器（header.actions 是 list 槽，可与官方/插件其他按钮共存）。
      disposeBookmarkCapture = ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'bookmark-session-catcher',
          order: 100, // 末尾：隐藏 entry，零 UI
        }, (props) => {
          // strict-session slot：props 自带 sessionId。
          const sid = (props as { sessionId?: string }).sessionId
          if (typeof sid === 'string' && sid !== '') currentBookmarkSessionId = sid
          // 捕获到 id 后启动注入器（懒启动，保证 getSessionId 有值可读）。
          if (!bookmarkInjectorStarted) {
            bookmarkInjectorStarted = true
            disposeBookmarkInjector = createBookmarkInjector(
              () => currentBookmarkSessionId,
              { t },
            ).dispose
          }
          return null // 不渲染任何 UI
        }))
      // 2. 「书签」Tab（order 100：模型设置 90 之后、Web UI 设置 110 之前）。
      disposeBookmarkTab = ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'bookmarks-hub',
          order: 100,
          label: () => t('bookmarkTab.label'),
        }, (props) => BookmarksView({ ...props, t })))
    })
    .catch(() => { /* 书签未启用：不注入任何东西 */ })
  ctx.effect(() => () => {
    bookmarkCancelled = true
    disposeBookmarkInjector?.()
    disposeBookmarkCapture?.()
    disposeBookmarkTab?.()
  }, 'memory-evolve: bookmarks')

  // 无限画板（canvas-hub）：前端一期 Grok 实现（2026-08-13 用户拍板选版）。
  // cg- 前缀。注册参数 id: canvas-hub / label: 画板 / order: 80（正式值）。
  // ctx 断言为 CanvasTabHost：cordis Context 类型缺 slots（项目既有类型
  // 环境问题，全部 slots 调用同源），运行时由客户端运行时注入。
  // openSession（2026-08-14）：footer「跳转」按钮跳转归属会话——
  // 与 web 通知铃铛同款路径 ctx.sessions.open(sessionId)（官方唯一
  // 切换入口）。
  // ⚠️ 2026-08-14 修复：Tab 注册必须跟随 canvasEnabled 开关（与书签
  // 同款探测模式）——曾无条件注册，开关关闭时 Tab 还在（只剩后端
  // 同步被关），用户预期「关=整个画板不可见」；现在探测
  // /api/canvas/state（开关开启才有 200 {enabled:true}），关闭时
  // 端点 404，Tab 完全不注入。
  let canvasCancelled = false
  let disposeCanvasTab: (() => void) | undefined
  void fetch('/memory-evolve/api/canvas/state')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { enabled?: boolean }) => {
      if (canvasCancelled || data.enabled !== true) return
      disposeCanvasTab = registerCanvasTab(
        ctx as unknown as import('./canvas-grok/index.ts').CanvasTabHost,
        { t, openSession: (sessionId) => { ctx.sessions.open(sessionId) } },
      )
    })
    .catch(() => { /* 画板未启用：不注入任何东西 */ })
  ctx.effect(() => () => {
    canvasCancelled = true
    disposeCanvasTab?.()
  }, 'memory-evolve: canvas-tab')
}
