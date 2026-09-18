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
  'appCenter.access.whitelistHint': '只有名单内的账号能用。平台**不比对名单**、也不校验账号是否存在 —— 名单是给应用自己读的，由应用判定并返回自己的 403 页面显示本人账号',
  'appCenter.whitelist': '白名单（逗号分隔）',
  'appCenter.whitelistHint': '每行一个账号。名单只给应用自己读：平台不做任何比对',
  'appCenter.whitelistRequired': '选中「仅白名单用户」时必填',
  'appCenter.purpose': '用途',
  'appCenter.dataSensitivity': '数据敏感度',
  'appCenter.owner': '负责人',
  'appCenter.declarationsHint': '用途 / 数据敏感度 / 负责人为**首版必填**；之后的版本可以沿用',
  'appCenter.submit': '提交发布',
  'appCenter.cancel': '取消',
  'appCenter.phaseReading': '正在读取文件…',
  'appCenter.phaseUploading': '上传中 / 编译中…',
  'appCenter.published': '发布成功',
  'appCenter.publishedLive': '已生效',
  'appCenter.publishedPending': '待审核（线上仍是旧版本）',
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
  'appCenter.submit': 'Submit',
  'appCenter.cancel': 'Cancel',
  'appCenter.phaseReading': 'Reading the file…',
  'appCenter.phaseUploading': 'Uploading / compiling…',
  'appCenter.published': 'Published',
  'appCenter.publishedLive': 'Live',
  'appCenter.publishedPending': 'Pending review (the live version is unchanged)',
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
