/**
 * Capability-center client UI copy: zh is the key source, en mirrors the full
 * key set (the same pattern as the enterprise / dsh-cron locales). The
 * dictionary is registered into the shared locale registry under the
 * capability namespace; `t()` resolves the zh key source directly so the panel
 * components stay dependency-free.
 *
 * 2026-10-13:逐字搬自 `@picoaide/dsh-enterprise` 的 `src/client/locales.ts`
 * （能力中心客户端面整包搬出）。**键路径与取值一字未改** —— 变的只是注册的命名
 * 空间（`enterprise` → `capability`）与字典的归属包；面板用的是模块级 `t()`
 * （zh 源直接查表），所以渲染出来的文案与搬前逐字相同。
 */
export const zh = {
  'capability.title': '能力中心',
  'capability.backToChat': '返回聊天',
  'capability.close': '关闭',
  'capability.detail': '详情',
  'capability.detailDescription': '说明',
  'capability.detailNoDescription': '（这一条没有填写说明）',
  'capability.subtitle': '技能与智能体：装一个，在对话里输入 / 就能调用',
  // 来源分区
  'capability.tabMine': '我的',
  'capability.tabMarket': '市场',
  // 类型筛选
  'capability.filterAll': '全部',
  'capability.filterSkill': '技能',
  'capability.filterAgent': '智能体',
  'capability.searchPlaceholder': '搜索技能/智能体…',
  // 徽章
  'capability.typeSkill': '技能',
  'capability.typeAgent': '智能体',
  'capability.sourceMarket': '市场',
  'capability.sourceOrg': '组织',
  'capability.sourceBuiltin': '平台内置',
  // 随客户端内置：随包插件同步进技能库的技能（跨泳道契约 S2），不是用户作品。
  'capability.sourcePlugin': '随客户端内置',
  'capability.sourceLocal': '自制',
  'capability.sourceOther': '其他安装',
  'capability.officialLocked': '官方内容仅管理员可更新',
  // 内置技能区（随服务端镜像发布、客户端按需安装）
  'capability.builtinInstall': '安装',
  'capability.builtinRetry': '重试',
  // R21 FIX-7 ②：内置技能**清单**读失败（5xx/网络）——此前 hook 进了错误态但面板不渲染，
  // 界面上与"平台没有内置技能"同形。文案必须是字典键（本文件是唯一文案真源）。
  'capability.builtinLoadFailed': '内置技能清单读取失败：{error}',
  'capability.builtinBadge': '平台内置',
  'capability.dirty': '已本地修改',
  'capability.originOtherServer': '来自另一台服务端',
  'capability.originSymlink': '符号链接（不支持上传）',
  'capability.runtimeName': '调用名',
  'capability.pending': '审核中',
  'capability.approved': '已共享',
  'capability.rejected': '未通过',
  'capability.official': '官方',
  'capability.featured': '精选',
  'capability.installed': '已安装',
  // 下架 / 归属两态（R5-B-1 / R5-B-2）。形态照应用中心那一套（中性「已下架」胶囊 +
  // 一句"为什么 + 还能做什么"的说明），不另创一套文案。
  'capability.delisted': '已下架',
  'capability.delistedHint': '该条目已不在能力中心目录中：可能已被管理员下架、已转交给他人，或你的授权已被撤回。本机这一份仍可使用，但不能再更新或上传新版本；若是被下架，内容在下架期间冻结（上传与审核一律被拒），要等重新上架后才能发新版。',
  // 下架期间上传被服务端拒绝（409 APP_DELISTED）时的用户可见文案。与
  // `capability.delistedHint` 同一语义，但这一条说的是"你刚点的那个动作为什么没成"。
  'capability.delistedFrozen': '该内容已下架，新版本已被拒绝：下架期间内容冻结（上传与审核一律被拒），请先联系管理员重新上架，再发新版。',
  'capability.transferred': '已转交',
  'capability.transferredHint': '这条内容已转交给其他负责人，你不再有发布权；如需继续维护请联系管理员。',
  'capability.updateTo': '更新到 v{version}',
  'capability.viewVersions': '{count} 个版本',
  // 动作与分区空态
  'capability.install': '安装',
  'capability.uninstall': '卸载',
  'capability.uninstalling': '卸载中…',
  'capability.confirmUninstall': '确认卸载',
  'capability.cancel': '取消',
  'capability.upload': '上传共享',
  'capability.reupload': '重新上传',
  'capability.awaitingReview': '等待审核',
  'capability.rejectReason': '未通过原因：{reason}',
  'capability.emptyMine': '暂无本地内容',
  'capability.emptyMarket': '市场暂无可用内容',
  'capability.emptyFilter': '该类型暂无内容',
  'capability.loading': '加载中…',
  'capability.retry': '重试',
  'capability.loadError': '加载失败',
  // R16B-26：失败面塌缩（与 R16B-08 同族）——只回一句「加载失败」时
  // 401/403/404/5xx/形状漂移全不可区分。带 cause 的文案单独一键，
  // 让"用户可读"与"排障可读"同时成立。
  'capability.loadErrorDetail': '加载失败：{error}',
  'capability.failed': '操作失败：{error}',
  'capability.nameTaken': '名称已被占用:「{name}」已存在于能力中心,请更换名称或联系管理员',
  'capability.installedName': '已安装 {name}',
  'capability.uninstalledName': '已卸载 {name}',
  'capability.uploadedName': '已上传 {name}，等待审核',
  'capability.conflictConfirm': '已存在同名内容「{name}」，安装将覆盖本地目录。确定继续？',
  'capability.forceInstall': '覆盖安装',
  // 本机自制同名（审计 A2/A3/A15）：措辞必须让用户看出"这份是你自己写的"。
  'capability.conflictConfirmLocal': '本机存在同名自制技能「{name}」（不是能力中心安装的），安装会覆盖它、你写的内容会丢失。确定继续？',
  'capability.forceInstallLocal': '仍要覆盖',
  // 商店来源但**被本地修改过**（第四轮审计 R4-B-3）：卡片上的「已本地修改」徽章必须
  // 配一句后果提示 —— 否则用户点下去才知道自己改过的正文与自加的文件被整树替换了。
  'capability.conflictConfirmDirty': '技能「{name}」已被本地修改（改过正文或加过自己的文件），更新会整目录替换、这些改动会丢失。确定继续？',
  'capability.forceInstallDirty': '仍要更新',
  // 卸载确认（R19B-07）：宿主的两条 `RESIDUE` 判据在**删除之前**判，命中就 422 且
  // **一个字都不删**（同根用户自建影子 / 项目·用户·内置等其它技能根里的同名条目）。
  // 所以这里只能说"会删掉本机这一份"，并把它可能被拒绝、以及被拒后先做什么讲清楚 ——
  // 修前写的是"会连同你自己的文件一起移除"，那是一句**无条件承诺**。
  'capability.confirmUninstallLocal': '「{name}」是本机自制技能（不是能力中心安装的）：删除会移除本机这一份（你自己的文件）；若同名技能还存在于项目/用户/内置等其它技能根，卸载会被拒绝、本地内容不会被删除，请先处理那一份再重试。',
  'capability.deleteLocal': '仍要删除',
  // 商店装来但被本地修改过（R4-B-3）：删除同样会带走用户的改动，措辞不能说成"自制"。
  'capability.confirmUninstallDirty': '技能「{name}」已被本地修改（改过正文或加过自己的文件）：删除会移除本机这一份与这些改动；若同名技能还存在于项目/用户/内置等其它技能根，卸载会被拒绝、本地内容不会被删除，请先处理那一份再重试。',
  // 市场技能的归档端点只按当前 approved 最高版取（审计 A11）：不给"按版本安装"的假入口。
  'capability.marketLatestOnly': '市场技能只能安装当前最新版。',
  // 站级闸（审计 C-03）：`install()` 对"有动作在飞"静默 return ⇒ 按钮必须禁用并说明原因，
  // 而不是点了没反应。
  'capability.busyHint': '有另一个安装/卸载正在进行，完成后再试。',
}

export const en: Record<keyof typeof zh, string> = {
  'capability.title': 'Capability Hub',
  'capability.backToChat': 'Back to chat',
  'capability.close': 'Close',
  'capability.detail': 'Details',
  'capability.detailDescription': 'Description',
  'capability.detailNoDescription': '(no description provided)',
  'capability.subtitle': 'Skills and agents — install one, then type / in chat to use it',
  'capability.tabMine': 'Mine',
  'capability.tabMarket': 'Market',
  'capability.filterAll': 'All',
  'capability.filterSkill': 'Skills',
  'capability.filterAgent': 'Agents',
  'capability.searchPlaceholder': 'Search skills/agents…',
  'capability.typeSkill': 'Skill',
  'capability.typeAgent': 'Agent',
  'capability.sourceMarket': 'Market',
  'capability.sourceOrg': 'Org',
  'capability.sourceBuiltin': 'Built-in',
  'capability.sourcePlugin': 'Bundled',
  'capability.sourceLocal': 'Local',
  'capability.sourceOther': 'Other install',
  'capability.officialLocked': 'Official content: updates by admin only',
  'capability.builtinInstall': 'Install',
  'capability.builtinRetry': 'Retry',
  'capability.builtinLoadFailed': 'Failed to load the built-in skill list: {error}',
  'capability.builtinBadge': 'Built-in',
  'capability.dirty': 'Locally modified',
  'capability.originOtherServer': 'From another server',
  'capability.originSymlink': 'Symbolic link (upload unsupported)',
  'capability.runtimeName': 'Invoke as',
  'capability.pending': 'In review',
  'capability.approved': 'Shared',
  'capability.rejected': 'Rejected',
  'capability.official': 'Official',
  'capability.featured': 'Featured',
  'capability.installed': 'Installed',
  'capability.delisted': 'Delisted',
  'capability.delistedHint': 'This item is no longer in the Capability Hub catalog: it may have been delisted by an administrator, transferred to someone else, or your access may have been revoked. The copy on this machine still works, but it can no longer be updated or re-uploaded; if it was delisted, its content stays frozen (uploads and approvals are refused) until an administrator relists it.',
  'capability.delistedFrozen': 'This item is delisted, so the new version was refused: while delisted its content is frozen (uploads and approvals are rejected). Ask an administrator to relist it first, then publish the new version.',
  'capability.transferred': 'Transferred',
  'capability.transferredHint': 'This item has been transferred to another owner, so you no longer have publishing rights; contact your administrator to keep maintaining it.',
  'capability.updateTo': 'Update to v{version}',
  'capability.viewVersions': '{count} versions',
  'capability.install': 'Install',
  'capability.uninstall': 'Uninstall',
  'capability.uninstalling': 'Uninstalling…',
  'capability.confirmUninstall': 'Confirm uninstall',
  'capability.cancel': 'Cancel',
  'capability.upload': 'Upload',
  'capability.reupload': 'Re-upload',
  'capability.awaitingReview': 'Awaiting review',
  'capability.rejectReason': 'Rejection reason: {reason}',
  'capability.emptyMine': 'Nothing local yet',
  'capability.emptyMarket': 'Nothing in the market yet',
  'capability.emptyFilter': 'Nothing of this type',
  'capability.loading': 'Loading…',
  'capability.retry': 'Retry',
  'capability.loadError': 'Failed to load',
  'capability.loadErrorDetail': 'Failed to load: {error}',
  'capability.failed': 'Action failed: {error}',
  'capability.nameTaken': 'Name already taken: "{name}" already exists in the Capability Hub. Choose another name or contact your administrator.',
  'capability.installedName': 'Installed {name}',
  'capability.uninstalledName': 'Uninstalled {name}',
  'capability.uploadedName': 'Uploaded {name}; awaiting review',
  'capability.conflictConfirm': 'A "{name}" already exists locally; installing will overwrite it. Continue?',
  'capability.forceInstall': 'Overwrite install',
  // Locally authored same-name content (audit A2/A3/A15): the wording must make clear
  // that this copy is the user's own work, not something the Capability Hub installed.
  'capability.conflictConfirmLocal': 'A locally authored skill "{name}" exists on this machine (it was not installed from the Capability Hub). Installing will overwrite it and your own content will be lost. Continue?',
  'capability.forceInstallLocal': 'Overwrite anyway',
  // Store content that was edited locally (round-4 audit R4-B-3): the "Locally modified"
  // badge needs a matching consequence sentence, otherwise the first signal the user gets
  // is their own edits disappearing.
  'capability.conflictConfirmDirty': 'The skill "{name}" has local modifications (edited text or files you added). Updating replaces the whole directory and discards those changes. Continue?',
  'capability.forceInstallDirty': 'Update anyway',
  // Uninstall confirmation (R19B-07): both `RESIDUE` checks run *before* anything is
  // deleted, so a same-named copy in another skill root (or a user-created shadow in the
  // same root) means 422 and nothing local is deleted. The copy used to promise removal
  // unconditionally; it must now state the refusal and what to do first.
  'capability.confirmUninstallLocal': '"{name}" is a locally authored skill on this machine (not installed from the Capability Hub): deleting it removes this local copy and your own files; if the same name is still loaded from another skill root (project, user or bundled), the uninstall is refused and nothing local is deleted — handle that copy first, then uninstall again.',
  'capability.deleteLocal': 'Delete anyway',
  // Store content edited locally (R4-B-3): deleting takes those edits with it, and the
  // wording must not claim this copy is locally authored (it came from the Hub).
  'capability.confirmUninstallDirty': 'The skill "{name}" has local modifications (edited text or files you added): deleting it removes this local copy and those changes; if the same name is still loaded from another skill root (project, user or bundled), the uninstall is refused and nothing local is deleted — handle that copy first, then uninstall again.',
  // The marketplace archive endpoint only serves the current highest approved version (audit A11).
  'capability.marketLatestOnly': 'Marketplace skills install the current latest version only.',
  // Station-wide gate (audit C-03): `install()` silently returns while another action is in
  // flight, so the button must be disabled with a reason instead of doing nothing on click.
  'capability.busyHint': 'Another install or uninstall is in progress; try again when it finishes.',
}

export type CapabilityKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: CapabilityKey, params?: Record<string, string>): string {
  let text: string = (activeLocale === 'en' ? en[key] : zh[key]) as string
  if (params !== undefined) {
    // ONE pass over the template: a chained `replaceAll` per parameter re-scans
    // the values it just inserted, so a value carrying another key's `{name}`
    // token would be rewritten (2026-09-16 R9 audit; same shape as
    // `manifest-precheck`'s `fill`).
    text = text.replace(/\{(\w+)\}/gu, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
  }
  return text
}
