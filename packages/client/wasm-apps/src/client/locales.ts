/**
 * App Center copy (zh key source, en mirror).
 *
 * R36（§4.7）：这一页**不得**出现任何额度/用量/余额字段 —— 唯一的额度入口是
 * 桌面客户端本来的账号卡，应用中心只回答"有什么应用、谁负责、怎么打开"。
 * 因此这里的字典里连"用量/额度/balance/quota"这类词都不存在（守卫测试见
 * `app-center.spec.ts`：渲染结果里出现这些词即红）。
 *
 * 术语（2026-08-27 术语定案的同族）：中文「应用中心」/ 英文 `App Center`，
 * 与「能力中心」/`Capability Hub` 平行但**不是**同一个面（能力中心 = 技能与
 * 智能体；应用中心 = 员工自建的 WASM 应用）。
 *
 * @module @picoaide/dsh-wasm-apps/client/locales
 */

/** zh 是 key 真源；en 必须与它逐key 对齐（`locales.spec.ts` 钉住）。 */
export const zh = {
  'appCenter.title': '应用中心',
  'appCenter.subtitle': '同事做的小工具，点开就用',
  'appCenter.loading': '正在加载应用…',
  'appCenter.empty': '还没有可用的应用',
  'appCenter.emptyHint': '在对话里描述你想要的工具，AI 会帮你做出来并发布到这里',
  'appCenter.error': '加载失败',
  'appCenter.retry': '重试',
  // 目录行结构与客户端预期对不上（P2-10）：服务端下发了几行却一行都没解析出来。
  // 这条**不能**退化成空态 —— "还没有可用的应用"会把契约漂移说成"你没有应用"。
  'appCenter.catalogShapeMismatch': '应用列表的字段与客户端预期不一致，无法显示（不是"没有应用"）',
  'appCenter.catalogShapeHint': '把下方的原始数据交给平台维护者：这通常意味着服务端刚改了目录字段名',
  'appCenter.responsible': '负责人',
  'appCenter.open': '打开',
  'appCenter.openAria': '打开应用',
  'appCenter.close': '关闭',
  'appCenter.notLoggedIn': '登录后可以查看应用中心',

  // ---- 访问级别标识（目录条目上的徽标）----
  'appCenter.accessBadge.public': '公开',
  'appCenter.accessBadge.login': '登录后使用',
  'appCenter.accessBadge.whitelist': '仅白名单',
  'appCenter.disabled': '已下架',

  // ---- 发布（FIX-38：发布链路的员工入口）----
  'appCenter.publish': '发布',
  'appCenter.publishAria': '发布应用',
  'appCenter.publishTitle': '发布应用',
  'appCenter.publishHint': '选择本机编译好的 .wasm 文件，填好版本与配置后提交。大文件由平台自动分片续传，不必自己切。',
  'appCenter.back': '返回',
  'appCenter.file': '.wasm 文件',
  'appCenter.filePick': '选择文件',
  'appCenter.fileNone': '还没有选择文件',
  'appCenter.fileChosen': '已选择',
  'appCenter.appId': '应用标识（app_id）',
  'appCenter.appIdHint': '小写字母、数字与连字符；它就是应用域名标签',
  'appCenter.version': '版本号',
  'appCenter.titleField': '标题',
  'appCenter.titleHint': '首版必填；它就是应用中心里显示的名字',
  'appCenter.changelog': '更新说明',
  'appCenter.config': '应用配置',

  // ---- 访问权限：三选一（access 取代了 visible + login_required）----
  'appCenter.access': '访问权限',
  'appCenter.access.public': '公开（无需登录）',
  'appCenter.access.login': '登录后使用（默认全员）',
  'appCenter.access.whitelist': '仅白名单用户',
  'appCenter.access.publicHint': '匿名也能打开：平台不拦未登录访客，帧里的用户身份为空',
  'appCenter.access.loginHint': '登录后全员可用（默认）。平台只要求已登录，不限制到具体的人',
  'appCenter.access.whitelistHint': '只有名单内的账号能用。平台不比对名单、也不校验账号是否存在 —— 名单是给应用自己读的，由应用判定并返回自己的 403 页面显示本人账号',
  'appCenter.whitelist': '白名单（逗号分隔）',
  'appCenter.whitelistHint': '每行一个账号。名单只给应用自己读：平台不做任何比对',
  'appCenter.whitelistRequired': '选中「仅白名单用户」时必填',
  'appCenter.purpose': '用途',
  'appCenter.dataSensitivity': '数据敏感度',
  'appCenter.owner': '负责人',
  'appCenter.declarationsHint': '用途 / 数据敏感度 / 负责人为首版必填；之后的版本可以沿用',
  // 平台**没有** data_sensitivity 的默认值（appcfg.json 的 hints 原话）：界面必须
  // 把这件事说出来，而不是替作者填一个（P1-3 第二条）。
  'appCenter.dataSensitivityNoDefault': '数据敏感度没有平台默认值：需要你按实际情况声明（留空会被首版必填校验拒）',

  // ---- 「对已有应用发新版」的预填与访问范围改动确认（P1-3）----
  'appCenter.publishNewVersion': '发新版',
  'appCenter.publishNewVersionAria': '为该应用发布新版本',
  'appCenter.publishingExisting': '正在为已有应用发新版',
  'appCenter.currentVersion': '当前版本',
  'appCenter.currentAccess': '当前访问范围',
  'appCenter.accessChange': '访问范围将被修改',
  'appCenter.accessChangeConfirm': '我确认修改访问范围（会影响谁能打开这个应用）',
  'appCenter.accessChangeUnconfirmed': '你修改了访问范围：请先勾选"我确认修改访问范围"再提交',
  'appCenter.fileTooLarge': '文件超过平台上限 32 MiB（本地拦下，未上传）',
  'appCenter.submit': '提交发布',
  'appCenter.cancel': '取消',
  'appCenter.phaseReading': '正在读取文件…',
  'appCenter.phaseUploading': '上传中 / 编译中…',
  'appCenter.published': '发布成功',
  'appCenter.publishedLive': '已生效',
  'appCenter.publishedPending': '待审核（线上仍是旧版本）',
  // R1-uxc-1：应用**已下架**时发新版，版本落了库但访问仍是 410 Gone —— 成功块必须
  // 说清这一点（旧实现对这一行照样写"已生效"）。两条一起出现：状态 + 下一步。
  'appCenter.publishedDisabled': '版本已发布，但该应用处于已下架状态：访问仍然是 410 Gone，使用者打不开',
  'appCenter.publishedDisabledHint': '先在应用中心里上架该应用，访问才会恢复（链接不变）',

  // ---- 作者生命周期：上下架 / 删除 / 诊断（R1-pm-1：作者自服务的出口）----
  'appCenter.takeOffline': '下架',
  'appCenter.takeOfflineAria': '下架该应用',
  'appCenter.bringOnline': '上架',
  'appCenter.bringOnlineAria': '上架该应用',
  'appCenter.takeOfflineConfirm': '确认下架？所有访问者立刻收到 410 Gone。应用数据保留、链接不变，之后可以随时重新上架。',
  'appCenter.takeOfflineConfirmAction': '确认下架',
  'appCenter.deleteApp': '删除',
  'appCenter.deleteAria': '删除该应用',
  'appCenter.deleteConfirm': '确认删除？不可恢复。应用标识与版本号永久保留；数据保留期以服务端返回的说明为准。',
  'appCenter.deleteConfirmAction': '确认删除',
  'appCenter.confirmCancel': '取消',
  'appCenter.actionFailed': '操作失败',
  'appCenter.appDeleted': '应用已删除',
  'appCenter.appDeletedNote': '服务端说明',
  'appCenter.retentionDays': '数据保留天数',
  'appCenter.diagnostics': '诊断',
  'appCenter.diagnosticsAria': '查看该应用的最近失败诊断',
  'appCenter.diagnosticsLoading': '正在读取诊断…',
  'appCenter.diagnosticsWindow': '时间窗口（分钟）',
  'appCenter.diagnosticsCalls': '调用总数',
  'appCenter.diagnosticsFailed': '失败数',
  'appCenter.diagnosticsRecentFailures': '最近失败',
  'appCenter.diagnosticsNoFailures': '该时间窗口内没有失败记录',
  'appCenter.diagnosticsReasonCode': '原因码',
  'appCenter.diagnosticsOutcome': '结果',
  'appCenter.diagnosticsHints': '建议',
  // 下架应用不给可点的"发新版"（发完仍是 410，等于让作者白等一次上传）：
  // 按钮留着但禁用，并在**可见文本**里写清原因与出路（不靠 hover 提示）。
  'appCenter.publishNewDisabled': '该应用已下架：现在发新版不会恢复访问（仍是 410 Gone）。请先上架，再发新版。',
  // 生命周期端点的"响应形状对不上"（服务端改了契约）：三条各自的判据 + 一条共用指路。
  // 这些消息也会进 en 界面，所以必须走字典（发布块的同类中文是既有缺陷 R1-uxc-7，别扩散）。
  'appCenter.setPublishedShapeMismatch': '服务端返回的上下架结果里没有 enabled 字段（响应形状与客户端预期不一致）',
  'appCenter.deleteShapeMismatch': '服务端没有确认删除（响应里没有 deleted=true）',
  'appCenter.diagnosticsShapeMismatch': '服务端返回的诊断结果形状与客户端预期不一致',
  'appCenter.shapeMismatchHint': '把详情里的 response 交给平台维护者：这通常意味着服务端刚改了该端点的响应形状',
  'appCenter.entry': '入口',
  'appCenter.versionLabel': '版本',
  'appCenter.failed': '发布失败',
  'appCenter.errorCode': '错误码',
  'appCenter.errorDetails': '详情',
  'appCenter.errorHints': '建议',
  'appCenter.publishAgain': '继续发布',
  'appCenter.backToList': '返回应用列表',
  'appCenter.needFile': '请先选择 .wasm 文件',
  'appCenter.readFailed': '读取文件失败',

  // ---- 前端预校验文案（与服务端 registry/appcfg 的规则一一对应）----
  'appCenter.invalidAppIdRequired': 'app_id 必填',
  'appCenter.invalidAppIdLength': 'app_id 最长 63 个字符（它是应用的域名标签）',
  'appCenter.invalidAppIdShape': 'app_id 只能用小写字母、数字与单个连字符分隔（不能有连续连字符，也不能以连字符开头或结尾）',
  'appCenter.invalidAppIdNumeric': 'app_id 不能是纯数字（会被误认成 IP 地址），请加字母',
  'appCenter.invalidAppIdPunycode': 'app_id 不能以 xn-- 开头（punycode 前缀保留给国际化域名）',
  'appCenter.invalidVersionRequired': '版本号必填',
  'appCenter.invalidVersionShape': '版本号必须是 x.y.z 形态，例如 1.0.0（可带 -beta.1 这样的预发布后缀）',
  'appCenter.invalidAccess': '请选择访问权限（公开 / 登录后使用 / 仅白名单用户）',
  'appCenter.invalidWhitelistEmpty': '选中「仅白名单用户」时必须填至少一个账号，否则应用对所有人都不可用',
  'appCenter.invalidWhitelistTooMany': '白名单最多 2000 条',
  'appCenter.requiredTitle': '标题是首版必填项',
  'appCenter.requiredPurpose': '用途是首版必填项',
  'appCenter.requiredDataSensitivity': '数据敏感度是首版必填项',
  'appCenter.requiredOwner': '负责人是首版必填项',
} as const

/** English mirror of {@link zh}. */
export const en: Record<keyof typeof zh, string> = {
  'appCenter.title': 'App Center',
  'appCenter.subtitle': 'Small tools built by your colleagues — one click to use',
  'appCenter.loading': 'Loading apps…',
  'appCenter.empty': 'No apps yet',
  'appCenter.emptyHint': 'Describe the tool you want in a chat; the AI will build and publish it here',
  'appCenter.error': 'Failed to load',
  'appCenter.retry': 'Retry',
  'appCenter.catalogShapeMismatch': 'The app list does not match the fields this client expects, so it cannot be shown (this is NOT "no apps")',
  'appCenter.catalogShapeHint': 'Hand the raw data below to the platform maintainers: it usually means a catalog field was renamed server-side',
  'appCenter.responsible': 'Owner',
  'appCenter.open': 'Open',
  'appCenter.openAria': 'Open app',
  'appCenter.close': 'Close',
  'appCenter.notLoggedIn': 'Sign in to browse the App Center',

  // ---- Access level badges (catalog rows) ----
  'appCenter.accessBadge.public': 'Public',
  'appCenter.accessBadge.login': 'Signed-in',
  'appCenter.accessBadge.whitelist': 'Whitelist',
  'appCenter.disabled': 'Disabled',

  // ---- Publishing (FIX-38) ----
  'appCenter.publish': 'Publish',
  'appCenter.publishAria': 'Publish an app',
  'appCenter.publishTitle': 'Publish an app',
  'appCenter.publishHint': 'Pick the .wasm file you compiled locally, fill in the version and config, then submit. Large payloads are chunked and resumed by the platform.',
  'appCenter.back': 'Back',
  'appCenter.file': '.wasm file',
  'appCenter.filePick': 'Choose file',
  'appCenter.fileNone': 'No file selected',
  'appCenter.fileChosen': 'Selected',
  'appCenter.appId': 'App ID',
  'appCenter.appIdHint': 'lowercase letters, digits and dashes; it becomes the app hostname label',
  'appCenter.version': 'Version',
  'appCenter.titleField': 'Title',
  'appCenter.titleHint': 'Required on the first release; this is the name shown in the App Center',
  'appCenter.changelog': 'Changelog',
  'appCenter.config': 'App config',

  // ---- Access: pick one of three (access replaced visible + login_required) ----
  'appCenter.access': 'Access',
  'appCenter.access.public': 'Public (no sign-in)',
  'appCenter.access.login': 'Signed-in users (everyone by default)',
  'appCenter.access.whitelist': 'Whitelist only',
  'appCenter.access.publicHint': 'Anonymous visitors can open it: the platform does not block signed-out visitors and the frame carries no user identity',
  'appCenter.access.loginHint': 'Everyone who is signed in can use it (default). The platform only requires a session; it does not restrict who',
  'appCenter.access.whitelistHint': 'Only accounts on the list may use it. The platform does NOT match the list or check that accounts exist — the app reads the list itself, decides, and returns its own 403 page showing the account',
  'appCenter.whitelist': 'Allow list (comma separated)',
  'appCenter.whitelistHint': 'One account per line. The list is for the app to read: the platform never matches it',
  'appCenter.whitelistRequired': 'Required when "Whitelist only" is selected',
  'appCenter.purpose': 'Purpose',
  'appCenter.dataSensitivity': 'Data sensitivity',
  'appCenter.owner': 'Responsible person',
  'appCenter.declarationsHint': 'Purpose / data sensitivity / responsible person are required on the first release; later versions may keep them',
  'appCenter.dataSensitivityNoDefault': 'Data sensitivity has no platform default: declare it for your app (leaving it empty fails the first-release check)',

  // ---- Publishing a new version of an existing app (prefill + access change) ----
  'appCenter.publishNewVersion': 'New version',
  'appCenter.publishNewVersionAria': 'Publish a new version of this app',
  'appCenter.publishingExisting': 'Publishing a new version of an existing app',
  'appCenter.currentVersion': 'Current version',
  'appCenter.currentAccess': 'Current access',
  'appCenter.accessChange': 'Access will change',
  'appCenter.accessChangeConfirm': 'I confirm the access change (it decides who can open this app)',
  'appCenter.accessChangeUnconfirmed': 'You changed the access level: tick "I confirm the access change" before submitting',
  'appCenter.fileTooLarge': 'The file exceeds the platform limit of 32 MiB (rejected locally, nothing was uploaded)',
  'appCenter.submit': 'Submit',
  'appCenter.cancel': 'Cancel',
  'appCenter.phaseReading': 'Reading the file…',
  'appCenter.phaseUploading': 'Uploading / compiling…',
  'appCenter.published': 'Published',
  'appCenter.publishedLive': 'Live',
  'appCenter.publishedPending': 'Pending review (the live version is unchanged)',
  'appCenter.publishedDisabled': 'Version published, but this app is offline: it still returns 410 Gone and nobody can open it',
  'appCenter.publishedDisabledHint': 'Bring the app back online in the App Center first — then access is restored (the link never changes)',

  // ---- Author lifecycle: take offline / bring online, delete, diagnostics ----
  'appCenter.takeOffline': 'Take offline',
  'appCenter.takeOfflineAria': 'Take this app offline',
  'appCenter.bringOnline': 'Bring online',
  'appCenter.bringOnlineAria': 'Bring this app online',
  'appCenter.takeOfflineConfirm': 'Take this app offline? Every visitor immediately gets 410 Gone. App data is kept, the link never changes, and you can bring it back online at any time.',
  'appCenter.takeOfflineConfirmAction': 'Confirm take offline',
  'appCenter.deleteApp': 'Delete',
  'appCenter.deleteAria': 'Delete this app',
  'appCenter.deleteConfirm': 'Delete this app? This cannot be undone. The app ID and version numbers stay reserved forever; the data retention window follows the note the server returns.',
  'appCenter.deleteConfirmAction': 'Confirm delete',
  'appCenter.confirmCancel': 'Cancel',
  'appCenter.actionFailed': 'Action failed',
  'appCenter.appDeleted': 'App deleted',
  'appCenter.appDeletedNote': 'Server note',
  'appCenter.retentionDays': 'Data retention (days)',
  'appCenter.diagnostics': 'Diagnostics',
  'appCenter.diagnosticsAria': 'View recent failures for this app',
  'appCenter.diagnosticsLoading': 'Loading diagnostics…',
  'appCenter.diagnosticsWindow': 'Window (minutes)',
  'appCenter.diagnosticsCalls': 'Calls',
  'appCenter.diagnosticsFailed': 'Failed',
  'appCenter.diagnosticsRecentFailures': 'Recent failures',
  'appCenter.diagnosticsNoFailures': 'No failures in this window',
  'appCenter.diagnosticsReasonCode': 'Reason code',
  'appCenter.diagnosticsOutcome': 'Outcome',
  'appCenter.diagnosticsHints': 'Hints',
  'appCenter.publishNewDisabled': 'This app is offline: publishing a new version now does NOT restore access (it still returns 410 Gone). Bring it online first, then publish.',
  'appCenter.setPublishedShapeMismatch': 'The take offline / bring online response has no enabled field, so this client cannot tell the app state',
  'appCenter.deleteShapeMismatch': 'The server did not confirm the deletion (no deleted=true in the response)',
  'appCenter.diagnosticsShapeMismatch': 'The diagnostics response does not match the shape this client expects',
  'appCenter.shapeMismatchHint': 'Hand the response in the details to the platform maintainers: it usually means this endpoint changed its response shape',
  'appCenter.entry': 'Entry',
  'appCenter.versionLabel': 'Version',
  'appCenter.failed': 'Publish failed',
  'appCenter.errorCode': 'Code',
  'appCenter.errorDetails': 'Details',
  'appCenter.errorHints': 'Hints',
  'appCenter.publishAgain': 'Publish another',
  'appCenter.backToList': 'Back to apps',
  'appCenter.needFile': 'Choose a .wasm file first',
  'appCenter.readFailed': 'Reading the file failed',

  // ---- Local pre-validation copy (mirrors server registry/appcfg rules) ----
  'appCenter.invalidAppIdRequired': 'app_id is required',
  'appCenter.invalidAppIdLength': 'app_id is at most 63 characters (it is the app hostname label)',
  'appCenter.invalidAppIdShape': 'app_id allows lowercase letters, digits and single dashes only (no leading or trailing dash, no double dash)',
  'appCenter.invalidAppIdNumeric': 'app_id cannot be all digits (it would look like an IP address) — add a letter',
  'appCenter.invalidAppIdPunycode': 'app_id cannot start with xn-- (the punycode prefix is reserved for internationalized domain names)',
  'appCenter.invalidVersionRequired': 'Version is required',
  'appCenter.invalidVersionShape': 'Version must be x.y.z, for example 1.0.0 (a prerelease suffix such as -beta.1 is allowed)',
  'appCenter.invalidAccess': 'Choose an access level (public / signed-in users / whitelist only)',
  'appCenter.invalidWhitelistEmpty': 'At least one account is required for "Whitelist only" — otherwise the app is unusable for everyone',
  'appCenter.invalidWhitelistTooMany': 'The allow list holds at most 2000 entries',
  'appCenter.requiredTitle': 'Title is required on the first release',
  'appCenter.requiredPurpose': 'Purpose is required on the first release',
  'appCenter.requiredDataSensitivity': 'Data sensitivity is required on the first release',
  'appCenter.requiredOwner': 'Responsible person is required on the first release',
}

/** Dictionary key type (zh is authoritative). */
export type AppCenterKey = keyof typeof zh

/**
 * Active language for the module-level `t()`.
 *
 * The client half updates it from `ctx.locale` (see `client/index.ts`); the
 * upstream renderer re-renders every slot outlet when the locale revision
 * changes, so a module-level lookup is enough and no hook is needed
 * (same reasoning as the enterprise/account-card dictionaries).
 */
let active: 'zh' | 'en' = 'zh'

/**
 * Set the language used by {@link t}.
 * @param locale - active locale name (`zh` / `en`; anything else keeps `zh`).
 */
export function setActiveLocale(locale: string): void {
  active = locale === 'en' ? 'en' : 'zh'
}

/**
 * Translate an App Center key in the active language.
 * @param key - dictionary key.
 * @returns the localized copy.
 */
export function t(key: AppCenterKey): string {
  return active === 'en' ? en[key] : zh[key]
}
