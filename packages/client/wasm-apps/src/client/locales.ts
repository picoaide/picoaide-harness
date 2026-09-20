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
  'appCenter.backToChat': '返回聊天',
  'appCenter.publishSubtitle': '把写好的小工具发布到应用中心，同事点开就能用',
  'appCenter.notLoggedIn': '登录后可以查看应用中心',

  // ---- 未登录是可读的**状态**，不是崩溃（§19 Q4：闸门在宿主；客户端半边不持 bearer）----
  'appCenter.notLoggedInHint': '应用只在桌面客户端里打开：请先登录，登录后这里会自动显示你可用的应用',

  // ---- 可发现性（§19 Q1：搜索 = 名称/一句话/负责人；「我发布的」筛选；>20 条分批显示）----
  'appCenter.search': '搜索应用',
  'appCenter.searchPlaceholder': '搜索名称、一句话或负责人',
  'appCenter.ownedOnly': '我发布的',
  'appCenter.clearFilters': '清空筛选',
  // 筛选后一个都没命中：**不是**"平台里没有应用"（§19 Q2 的三种空态各自可辨）。
  'appCenter.noResults': '没有匹配的应用',
  'appCenter.noResultsHint': '换个关键词，或清掉「我发布的」筛选',
  // 空态 ③：可见的每一行都是下架（§19 Q2「全部下架（说明原因与联系负责人）」）。
  'appCenter.allDisabled': '这些应用都已下架',
  'appCenter.allDisabledHint': '下架后访问会返回 410 Gone（数据与链接都还在）。需要恢复请联系发布者或管理员。',
  'appCenter.showMore': '显示更多（还有 {n} 个）',

  // ---- 分享（F6：只有深链；§19 Q6：未注入渠道 scheme 时**不渲染**）----
  'appCenter.copyLink': '复制链接',
  'appCenter.copyLinkAria': '复制该应用的分享链接',
  'appCenter.copied': '链接已复制',
  'appCenter.copyFailed': '复制失败：请手动选中这条链接复制',
  // 分享入口不可用时**分档说明**（R2-X-1：证明问题与配置问题不能塌缩成一句）。
  'appCenter.shareUnavailableProof': '分享入口暂不可用：没能取得本机服务的操作凭据（本机服务/会话问题，不是渠道配置问题）',
  'appCenter.shareUnavailableConfig': '分享入口暂不可用：这个客户端还没配置应用地址（渠道配置问题，请联系管理员）',

  // ---- 详情页（F16 的消费端：打开次数来自 open 端点；不编造）----
  'appCenter.details': '详情',
  'appCenter.detailAria': '查看应用详情',
  'appCenter.backToCatalog': '返回列表',
  // 文案逐字取自设计总纲 §19 Q11（"今日已被打开 N 次"）。
  'appCenter.opensToday': '今日已被打开 {n} 次',
  // §19 Q11 同时要求把"为什么记"写出来（隐私说明）。
  'appCenter.privacyNote': '平台记录打开次数用于运营',

  // ---- 一次性引导卡（§7.2 冻结：应用是什么 / 怎么让 AI 做一个 / 怎么分享）----
  'appCenter.onboarding.title': '应用中心是什么',
  'appCenter.onboarding.what': '同事用 AI 做的小工具：点开就用，不用安装',
  'appCenter.onboarding.build': '在对话里描述你想要的工具，AI 会帮你做出来并发布到这里',
  'appCenter.onboarding.share': '用「复制链接」把应用发给同事，对方在自己的客户端里打开',
  'appCenter.onboarding.dismiss': '知道了',

  // 应用窗口的提示条（F12/§19 Q9/§5.1b：外链、下载反馈、软闸门横幅）**不在这里** ——
  // 审计裁定（台账 §F6/J12）那份 UI 归 L2 的 `packages/host/wasm-apps-host/src/app-window-copy.ts`，
  // 应用窗口 chrome 也由它渲染。本包删掉了先前的 `external-link.tsx`（零消费者），
  // 避免同一句冻结文案在两处各有一份实现。

  // ---- 应用 AI 前端桥（§21：仅对话、无工具、按用户×应用授权一次）----
  // R36：这一页的字典里**不许**出现额度/用量/余额/计费这些词（守卫用例逐字查），
  // 所以下面的说明刻意不用它们。
  'appCenter.ai.title': '应用 AI',
  'appCenter.ai.intro': '这个应用想用 AI 跟你对话。只发送本次对话内容；平台会按你的账号记录这次调用，应用之间互相看不到。',
  'appCenter.ai.toolsNote': '应用 AI 只有对话：没有工具、不能读写文件、不能使用连接器与记忆。',
  'appCenter.ai.allow': '允许',
  'appCenter.ai.deny': '不允许',
  'appCenter.ai.denied': '已拒绝：这个应用不能使用 AI。改主意就点「撤销授权」。',
  'appCenter.ai.revoke': '撤销授权',
  'appCenter.ai.revoked': '已撤销：下次调用会重新询问。',
  'appCenter.ai.consentFailed': '授权没能保存到本机，这次不能放行：请重启客户端后重试。',
  'appCenter.ai.placeholder': '给应用 AI 发一条消息',
  'appCenter.ai.send': '发送',
  'appCenter.ai.cancel': '停止',
  'appCenter.ai.pending': '正在回复…',
  'appCenter.ai.empty': '还没有对话',
  'appCenter.ai.you': '你',
  'appCenter.ai.assistant': '应用 AI',
  // 错误分层（§21.2）：五个信封 code 各自一句，另有两条客户端侧分类（网络/形状）。
  'appCenter.ai.error.denied': '应用 AI 被拒绝：这个应用没有获得使用 AI 的授权',
  'appCenter.ai.error.unavailable': '应用 AI 暂时不可用：请稍后重试，持续失败请联系管理员',
  'appCenter.ai.error.insufficient': 'AI 服务拒绝了这次调用：账号当前不可用，请联系管理员',
  'appCenter.ai.error.rateLimited': '调用太频繁：稍后再试',
  'appCenter.ai.error.cancelled': '已停止这一轮回复',
  'appCenter.ai.error.transport': '连不上本机 AI 桥：请重启客户端后重试',
  'appCenter.ai.error.protocol': '本机 AI 桥的响应与客户端预期不一致',

  // ---- 访问级别标识（目录条目上的徽标）----
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
  // ---- 标识唯一性查重（2026-09-20）----
  // 四态各自可辨：空闲 / 是你的（发新版）/ 被别人占了 / 名字本身不合法。
  // 「被别人占了」**不指明是谁**（平台口径：明确告知占用关系，不泄露是谁/什么内容）。
  'appCenter.availabilityChecking': '正在检查该标识是否可用…',
  'appCenter.availabilityFree': '这个标识可以用',
  'appCenter.availabilityYours': '这是你发布的应用，可以发新版本',
  'appCenter.availabilityTaken': '该标识已被占用，请换一个名字',
  'appCenter.availabilityTakenHint': '标识一经发布即永久占用：首个发布者一直持有，被下架或删除也不释放',
  'appCenter.availabilityInvalid': '这个标识不符合命名规则，请按提示修改',
  // 查重**没问成**（宿主/网络故障）：既不能说"可用"也不能说"被占用" ——
  // 说可用会放行一次注定失败的发布，说被占用会把一个合法的名字误杀。
  'appCenter.availabilityUnknown': '暂时无法确认该标识是否可用（不影响提交，提交时服务端会再判一次）',
  // 查重载荷认不出来（契约漂移）：与"查询失败"分开说，因为处置方式不同。
  'appCenter.availabilityShapeMismatch': '查重结果与客户端预期不一致，无法显示结论',
  'appCenter.availabilityShapeHint': '把这条交给平台维护者：通常意味着服务端刚改了查重字段名',
  'appCenter.version': '版本号',
  'appCenter.titleField': '标题',
  'appCenter.titleHint': '首版必填；它就是应用中心里显示的名字',
  'appCenter.changelog': '更新说明',
  'appCenter.config': '应用配置',

  // ---- 访问权限：写侧二选一（access 取代了 visible + login_required；匿名面已删除）----
  'appCenter.access': '访问权限',
  'appCenter.access.login': '登录后使用（默认全员）',
  'appCenter.access.whitelist': '仅白名单用户',
  'appCenter.access.loginHint': '登录后全员可用（默认）。平台只要求已登录，不限制到具体的人',
  'appCenter.access.whitelistHint': '只有名单内的账号能用。平台不比对名单、也不校验账号是否存在 —— 名单是给应用自己读的，由应用判定并返回自己的 403 页面显示本人账号',
  'appCenter.whitelist': '白名单（逗号分隔）',
  'appCenter.whitelistHint': '每行一个账号。名单只给应用自己读：平台不做任何比对',
  'appCenter.whitelistRequired': '选中「仅白名单用户」时必填',
  'appCenter.purpose': '用途',
  'appCenter.dataSensitivity': '数据敏感度',
  'appCenter.owner': '负责人',
  'appCenter.declarationsHint': '用途 / 数据敏感度 / 负责人为首版必填；之后的版本可以沿用',
  // ---- 窗口声明（F3/§6）：三项都可留空 = 不声明（不是"锁了缺省比例"）----
  'appCenter.windowRatio': '宽高比（如 16:9）',
  'appCenter.windowWidth': '宽度（像素）',
  'appCenter.windowHeight': '高度（像素）',
  'appCenter.windowHint': '可选：声明首次打开的窗口比例与尺寸（比例合法区间 0.25–4.0）。留空就用客户端缺省 1280×720，并且不锁比例。',
  'appCenter.windowRatioLabel': '窗口比例',
  'appCenter.windowSizeLabel': '窗口尺寸',
  'appCenter.invalidWindowRatio': '窗口宽高比不合法：用 16:9 这样的比例或小数（合法区间 0.25–4.0）',
  'appCenter.invalidWindowSize': '窗口尺寸必须是正整数的像素值',
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
  // 发布成功块的**分享深链**（2026-09-19，冻结契约 §4.5）：应用没有可贴进浏览器的
  // 地址，能发给同事的就是渠道深链 `<scheme>://app/<app_id>`。
  'appCenter.shareLink': '分享链接',
  // ---- "打开"失败的七种原因（各自可辨：未登录 / 应用不存在 / 协议未就绪 / …）----
  // 打开走本机路由 POST /api/pico/wasm-apps/open；每一种失败都要给出下一步，
  // 不能混成一句"打开失败"。
  'appCenter.openNotSignedIn': '打开失败：客户端尚未登录，请先登录再打开应用',
  'appCenter.openNotSignedInHint': '登录后重试；应用只在已登录的客户端里可用（不再有浏览器访问方式）',
  // §19 Q4 / §7.6：未登录时**记住这次打开**，登录完成后自动继续（不用再点一次）。
  'appCenter.openPendingLogin': '已记住这次打开：登录完成后会自动继续，不用再点一次',
  // ---- 异渠道深链的一次性 toast（§5.3/§19 Q5 **逐字**冻结）----
  'appCenter.toast.foreignDeepLink': '这个链接属于另一家企业的客户端，请让对方用你们客户端的『复制链接』重发',
  'appCenter.toast.dismiss': '关闭提示',
  // §5.2 的 `window` 字段：新开 vs 聚焦（拿到才说，拿不到不编）。
  'appCenter.openOpening': '正在打开…',
  'appCenter.openWindowOpened': '已打开',
  'appCenter.openWindowFocused': '已聚焦（这个应用已有一个窗口）',
  // 平台把「冻结」与「不存在」放进**同一个 404 + NOT_FOUND**（不泄露存在性），唯一
  // 区分凭据是 `platform_reason`。冻结是**只读快照**（数据仍然保留），文案必须与
  // "不存在"逐字可辨：说成"可能已被删除"会让用户去找发布者要一个还在的新应用。
  'appCenter.openAppFrozen': '打开失败：应用已被管理员停用（冻结）',
  'appCenter.openAppFrozenHint': '冻结是只读快照：数据仍然保留，但不能继续使用；如需恢复请联系平台管理员',
  'appCenter.openAppMissing': '打开失败：这个应用不存在（可能已被删除或改名）',
  'appCenter.openAppMissingHint': '刷新应用列表确认它还在；若确实已被删除，请向发布者索取新的应用',
  'appCenter.openProtocolNotReady': '打开失败：客户端内打开应用的能力还没就绪',
  'appCenter.openProtocolNotReadyHint': '稍后重试；若持续失败，请把客户端升级到与本服务端同版本后重启',
  // `proof-unavailable`（本页面根本不可能是宿主窗口）才是"一次请求都没发"；
  // 本机证明**被拒**（`proof-required`）是"请求发出去了、本机服务不认这枚令牌"。
  // 两者共用一句话会把"请求被拒"说成"没发请求"，用户与维护者都被指错方向。
  'appCenter.openProofUnavailable': '打开失败：本页面无法证明自己属于这个客户端窗口（因此没有发出任何请求）',
  'appCenter.openProofUnavailableHint': '请在桌面客户端窗口里打开应用中心，不要在其他页面或应用页里操作',
  // 本机证明闸拒绝了令牌（已自动重取一次并重放）。**不是**"没发请求"。
  'appCenter.openHostProofRejected': '打开失败：客户端本机服务拒绝了本次操作的本机凭据（已自动续期一次仍未通过）',
  'appCenter.openHostProofRejectedHint': '重启客户端后重试；持续失败请导出诊断包（这通常意味着本机服务异常）',
  // 平台（服务端）拒绝了这次打开：与本机凭据无关，别把用户支到"换个窗口试试"。
  'appCenter.openPlatformRefused': '打开失败：服务端拒绝了这次打开（客户端没能向服务端通过校验）',
  'appCenter.openPlatformRefusedHint': '重启客户端后重试；持续失败请确认客户端与服务端版本一致，并把详情交给平台维护者',
  // scheme 是渠道变量（CHN-2）：还没从宿主只读路由拿到时**不发请求**，给一条可读原因。
  'appCenter.openSchemeUnavailable': '打开失败：还没拿到这个客户端安装的应用地址（渠道参数未就绪）',
  'appCenter.openSchemeUnavailableHint': '重启客户端后重试；持续失败请把客户端升级到与本服务端同版本',
  // 本机持有性证明（§22.2 R2：请求头机制）。两种失败各自可辨：拿不到令牌 vs 令牌被拒。
  'appCenter.openHostProofUnavailable': '打开失败：没能向客户端本机服务取得本次操作的凭据（因此没有发出打开请求）',
  'appCenter.openHostProofUnavailableHint': '重启客户端后重试；若页面刚被刷新过，稍等片刻再点一次',
  'appCenter.openProofExpired': '打开失败：本机凭据已过期，客户端已自动续期一次仍未通过',
  'appCenter.openProofExpiredHint': '重启客户端后重试；持续失败请导出诊断包（这通常意味着本机服务异常）',
  'appCenter.openInvalidAppId': '打开失败：应用标识不合法（无法拼出客户端应用地址）',
  'appCenter.openInvalidAppIdHint': '刷新应用列表；若仍失败，请让发布者检查这个应用的标识',
  'appCenter.openHostUnreachable': '打开失败：连不上客户端本机服务',
  'appCenter.openHostUnreachableHint': '重启客户端后重试；持续失败请导出诊断包',
  'appCenter.openUnexpectedResponse': '打开失败：客户端本机服务的响应与预期不一致',
  'appCenter.openUnexpectedResponseHint': '把详情交给平台维护者；这通常意味着客户端与服务端版本不一致',
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
  'appCenter.invalidAccess': '请选择访问权限（登录后使用 / 仅白名单用户）',
  'appCenter.invalidWhitelistEmpty': '选中「仅白名单用户」时必须填至少一个账号，否则应用对所有人都不可用',
  'appCenter.invalidWhitelistTooMany': '白名单最多 2000 条',
  'appCenter.requiredTitle': '标题是首版必填项',
  'appCenter.requiredPurpose': '用途是首版必填项',
  'appCenter.requiredDataSensitivity': '数据敏感度是首版必填项',
  'appCenter.requiredOwner': '负责人是首版必填项',

  // ---- 版本历史与审核结论（R1-pm-3：审核开启后作者侧的结论出口）----
  // 为什么这一组是必需的：审核开启后，作者此前只看到发布那一刻的"待审核"，
  // 被拒也收不到任何结论（reason 写了没人读、版本号又永久占位）⇒ 只能盲升版本号重发。
  'appCenter.releases': '版本历史',
  'appCenter.releasesAria': '查看该应用的版本历史与审核结论',
  'appCenter.releasesLoading': '正在读取版本历史…',
  'appCenter.releasesEmpty': '还没有版本记录',
  'appCenter.releasesFailed': '版本历史读取失败',
  'appCenter.releasesShapeMismatch': '服务端返回的版本历史形状与客户端预期不一致',
  'appCenter.releaseStatus.approved': '已生效',
  'appCenter.releaseStatus.pending': '待审核',
  'appCenter.releaseStatus.rejected': '已拒绝',
  'appCenter.releaseCurrent': '线上',
  'appCenter.releaseReason': '拒绝理由',
  'appCenter.releaseReasonMissing': '管理员没有填写理由',
  // 「被拒后怎么办」：被拒版本的版本号**永久占位**、不能复用，唯一出路是升版本号重发。
  // 这句话必须与理由一起出现，否则作者只知道"没过"而不知道下一步做什么。
  'appCenter.releaseResubmitHint': '被拒后可以改好内容、用「更高的版本号」重新提交（例如 1.1.0 被拒 → 发 1.1.1）；被拒版本的版本号已永久占位，不能复用。',
  'appCenter.releasePendingHint': '待审核：线上仍是当前生效版本，审核通过后才会切换。',
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
  'appCenter.backToChat': 'Back to chat',
  'appCenter.publishSubtitle': 'Publish your tool to the App Center so colleagues can open it',
  'appCenter.notLoggedIn': 'Sign in to browse the App Center',
  'appCenter.notLoggedInHint': 'Apps open in the desktop client only: sign in first and the list appears here automatically',

  // ---- Discoverability (§19 Q1: search by name / one-liner / owner; "mine" filter) ----
  'appCenter.search': 'Search apps',
  'appCenter.searchPlaceholder': 'Search name, one-liner or owner',
  'appCenter.ownedOnly': 'Published by me',
  'appCenter.clearFilters': 'Clear filters',
  'appCenter.noResults': 'No matching apps',
  'appCenter.noResultsHint': 'Try another keyword, or clear the "Published by me" filter',
  'appCenter.allDisabled': 'All of these apps are offline',
  'appCenter.allDisabledHint': 'An offline app returns 410 Gone (data and link are kept). Ask the publisher or an administrator to bring it back online.',
  'appCenter.showMore': 'Show more ({n} left)',

  // ---- Sharing (F6: deep link only; §19 Q6: not rendered without a channel scheme) ----
  'appCenter.copyLink': 'Copy link',
  'appCenter.copyLinkAria': 'Copy this app share link',
  'appCenter.copied': 'Link copied',
  'appCenter.copyFailed': 'Copy failed: select the link and copy it manually',
  'appCenter.shareUnavailableProof': 'Sharing is unavailable: no local-service credential could be obtained (a local service / session problem, not a channel configuration problem)',
  'appCenter.shareUnavailableConfig': 'Sharing is unavailable: this client has no app origin address configured (a channel configuration problem — contact an administrator)',

  // ---- Detail view (F16 consumer: open counts come from the open endpoint) ----
  'appCenter.details': 'Details',
  'appCenter.detailAria': 'View app details',
  'appCenter.backToCatalog': 'Back to list',
  'appCenter.opensToday': 'Opened {n} times today',
  'appCenter.privacyNote': 'The platform records open counts for operations',

  // ---- One-time onboarding card (§7.2) ----
  'appCenter.onboarding.title': 'What the App Center is',
  'appCenter.onboarding.what': 'Small tools built by colleagues with AI: click to use, nothing to install',
  'appCenter.onboarding.build': 'Describe the tool you want in a chat; the AI builds and publishes it here',
  'appCenter.onboarding.share': 'Use "Copy link" to send an app to a colleague; they open it in their own client',
  'appCenter.onboarding.dismiss': 'Got it',

  // ---- App AI front-end bridge (§21: chat only, no tools, one consent per user×app) ----
  'appCenter.ai.title': 'App AI',
  'appCenter.ai.intro': 'This app wants to talk to you with AI. Only this conversation is sent; the platform records the call under your account and apps cannot see each other.',
  'appCenter.ai.toolsNote': 'App AI is chat only: no tools, no file access, no connectors and no memory.',
  'appCenter.ai.allow': 'Allow',
  'appCenter.ai.deny': 'Do not allow',
  'appCenter.ai.denied': 'Denied: this app cannot use AI. Use "Revoke consent" to change your mind.',
  'appCenter.ai.revoke': 'Revoke consent',
  'appCenter.ai.revoked': 'Revoked: the next call asks again.',
  'appCenter.ai.consentFailed': 'The consent could not be saved on this device, so it was not granted. Restart the client and try again.',
  'appCenter.ai.placeholder': 'Send a message to the app AI',
  'appCenter.ai.send': 'Send',
  'appCenter.ai.cancel': 'Stop',
  'appCenter.ai.pending': 'Replying…',
  'appCenter.ai.empty': 'No conversation yet',
  'appCenter.ai.you': 'You',
  'appCenter.ai.assistant': 'App AI',
  'appCenter.ai.error.denied': 'App AI refused: this app has no consent to use AI',
  'appCenter.ai.error.unavailable': 'App AI is unavailable right now: retry later, and contact an administrator if it persists',
  'appCenter.ai.error.insufficient': 'The AI service refused this call: the account is currently unavailable, contact an administrator',
  'appCenter.ai.error.rateLimited': 'Too many calls: try again later',
  'appCenter.ai.error.cancelled': 'This reply was stopped',
  'appCenter.ai.error.transport': 'Cannot reach the local AI bridge: restart the client and retry',
  'appCenter.ai.error.protocol': 'The local AI bridge answered in a shape this client does not understand',

  // ---- Access level badges (catalog rows) ----
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
  'appCenter.availabilityChecking': 'Checking whether this App ID is available…',
  'appCenter.availabilityFree': 'This App ID is available',
  'appCenter.availabilityYours': 'You published this app — you can release a new version',
  'appCenter.availabilityTaken': 'This App ID is already taken; please pick another name',
  'appCenter.availabilityTakenHint': 'An App ID is claimed permanently on first publish: it stays with its publisher even after unpublish or delete',
  'appCenter.availabilityInvalid': 'This App ID does not follow the naming rules — see the hint',
  'appCenter.availabilityUnknown': 'Could not confirm whether this App ID is available (you can still submit; the server checks again)',
  'appCenter.availabilityShapeMismatch': 'The availability result does not match what the client expects',
  'appCenter.availabilityShapeHint': 'Report this to the platform maintainer: the server likely renamed an availability field',
  'appCenter.version': 'Version',
  'appCenter.titleField': 'Title',
  'appCenter.titleHint': 'Required on the first release; this is the name shown in the App Center',
  'appCenter.changelog': 'Changelog',
  'appCenter.config': 'App config',

  // ---- Access: pick one of two (login | whitelist; `public` retired with I6) ----
  'appCenter.access': 'Access',
  'appCenter.access.login': 'Signed-in users (everyone by default)',
  'appCenter.access.whitelist': 'Whitelist only',
  'appCenter.access.loginHint': 'Everyone who is signed in can use it (default). The platform only requires a session; it does not restrict who',
  'appCenter.access.whitelistHint': 'Only accounts on the list may use it. The platform does NOT match the list or check that accounts exist — the app reads the list itself, decides, and returns its own 403 page showing the account',
  'appCenter.whitelist': 'Allow list (comma separated)',
  'appCenter.whitelistHint': 'One account per line. The list is for the app to read: the platform never matches it',
  'appCenter.whitelistRequired': 'Required when "Whitelist only" is selected',
  'appCenter.purpose': 'Purpose',
  'appCenter.dataSensitivity': 'Data sensitivity',
  'appCenter.owner': 'Responsible person',
  'appCenter.declarationsHint': 'Purpose / data sensitivity / responsible person are required on the first release; later versions may keep them',
  'appCenter.windowRatio': 'Aspect ratio (e.g. 16:9)',
  'appCenter.windowWidth': 'Width (px)',
  'appCenter.windowHeight': 'Height (px)',
  'appCenter.windowHint': 'Optional: declare the first-open window ratio and size (ratio must be 0.25–4.0). Leave empty for the client default 1280×720 with no locked ratio.',
  'appCenter.windowRatioLabel': 'Window ratio',
  'appCenter.windowSizeLabel': 'Window size',
  'appCenter.invalidWindowRatio': 'Window ratio is invalid: use a ratio such as 16:9 or a decimal (valid range 0.25–4.0)',
  'appCenter.invalidWindowSize': 'Window size must be a positive pixel value',
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
  // Share deep link of the publish success block (2026-09-19, contract §4.5): an app
  // has no browser-pasteable address; the shareable form is <scheme>://app/<app_id>.
  'appCenter.shareLink': 'Share link',
  // ---- The seven reasons "open" can fail (each one distinguishable) ----
  'appCenter.openNotSignedIn': 'Could not open: you are not signed in — sign in first',
  'appCenter.openNotSignedInHint': 'Sign in and retry; apps are available in a signed-in client only (there is no browser access any more)',
  'appCenter.openPendingLogin': 'This open was remembered: it continues automatically once you sign in — no need to click again',
  'appCenter.toast.foreignDeepLink': 'This link belongs to another company\'s client — ask the sender to use "Copy link" in your client and send it again',
  'appCenter.toast.dismiss': 'Dismiss',
  'appCenter.openOpening': 'Opening…',
  'appCenter.openWindowOpened': 'Opened',
  'appCenter.openWindowFocused': 'Focused (this app already had a window)',
  'appCenter.openAppFrozen': 'Could not open: an administrator has disabled (frozen) this app',
  'appCenter.openAppFrozenHint': 'A freeze is a read-only snapshot: the data is still kept, but the app cannot be used; contact your platform administrator to restore it',
  'appCenter.openAppMissing': 'Could not open: this app does not exist (it may have been deleted or renamed)',
  'appCenter.openAppMissingHint': 'Refresh the app list to confirm it is still there; if it was deleted, ask the publisher for the new app',
  'appCenter.openProtocolNotReady': 'Could not open: in-client app support is not ready yet',
  'appCenter.openProtocolNotReadyHint': 'Retry in a moment; if it keeps failing, update the client to the same version as this server and restart',
  'appCenter.openProofUnavailable': 'Could not open: this page cannot prove it belongs to the client window, so no request was sent',
  'appCenter.openProofUnavailableHint': 'Open the App Center inside the desktop client window, not from another page or an app page',
  'appCenter.openHostProofRejected': 'Could not open: the client\'s local service rejected this action\'s local credential (already renewed once, still refused)',
  'appCenter.openHostProofRejectedHint': 'Restart the client and retry; if it keeps failing, export a diagnostics bundle (this usually means the local service is unhealthy)',
  'appCenter.openPlatformRefused': 'Could not open: the server refused this open request (the client did not pass the server-side check)',
  'appCenter.openPlatformRefusedHint': 'Restart the client and retry; if it keeps failing, confirm the client and server versions match and hand the details to your platform maintainer',
  'appCenter.openSchemeUnavailable': 'Could not open: this client installation has not reported its app origin scheme yet',
  'appCenter.openSchemeUnavailableHint': 'Restart the client and retry; if it keeps failing, update the client to the same version as this server',
  'appCenter.openHostProofUnavailable': 'Could not open: no credential for this action could be obtained from the client\'s local service, so no open request was sent',
  'appCenter.openHostProofUnavailableHint': 'Restart the client and retry; if the page was just reloaded, wait a moment and click again',
  'appCenter.openProofExpired': 'Could not open: the local credential expired and the client\'s single automatic renewal was still not accepted',
  'appCenter.openProofExpiredHint': 'Restart the client and retry; export a diagnostics bundle if it persists (it usually means the local service is unhealthy)',
  'appCenter.openInvalidAppId': 'Could not open: the app id is not valid (no client app address can be built from it)',
  'appCenter.openInvalidAppIdHint': 'Refresh the app list; if it still fails, ask the publisher to check this app id',
  'appCenter.openHostUnreachable': 'Could not open: the client\'s local service is unreachable',
  'appCenter.openHostUnreachableHint': 'Restart the client and retry; if it keeps failing, export a diagnostics bundle',
  'appCenter.openUnexpectedResponse': 'Could not open: the client\'s local service answered in an unexpected shape',
  'appCenter.openUnexpectedResponseHint': 'Hand the details to the platform maintainers; it usually means the client and server versions differ',
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
  'appCenter.invalidAccess': 'Choose an access level (signed-in users / whitelist only)',
  'appCenter.invalidWhitelistEmpty': 'At least one account is required for "Whitelist only" — otherwise the app is unusable for everyone',
  'appCenter.invalidWhitelistTooMany': 'The allow list holds at most 2000 entries',
  'appCenter.requiredTitle': 'Title is required on the first release',
  'appCenter.requiredPurpose': 'Purpose is required on the first release',
  'appCenter.requiredDataSensitivity': 'Data sensitivity is required on the first release',
  'appCenter.requiredOwner': 'Responsible person is required on the first release',

  // ---- Version history and review verdicts (R1-pm-3) ----
  'appCenter.releases': 'Version history',
  'appCenter.releasesAria': 'View this app version history and review verdicts',
  'appCenter.releasesLoading': 'Loading version history…',
  'appCenter.releasesEmpty': 'No releases yet',
  'appCenter.releasesFailed': 'Failed to load the version history',
  'appCenter.releasesShapeMismatch': 'The version history does not match the shape this client expects',
  'appCenter.releaseStatus.approved': 'Live',
  'appCenter.releaseStatus.pending': 'Pending review',
  'appCenter.releaseStatus.rejected': 'Rejected',
  'appCenter.releaseCurrent': 'Live',
  'appCenter.releaseReason': 'Rejection reason',
  'appCenter.releaseReasonMissing': 'the reviewer left no reason',
  'appCenter.releaseResubmitHint': 'After a rejection, fix the content and resubmit with a HIGHER version number (e.g. 1.1.0 rejected → publish 1.1.1); a rejected version number stays reserved forever and cannot be reused.',
  'appCenter.releasePendingHint': 'Pending review: the live version is unchanged until the review passes.',
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

/**
 * Translate a key that carries a `{n}` placeholder (counts: open counts, remaining rows).
 *
 * 单一实现：每个调用点自己 `replace('{n}', …)` 迟早会漏掉一条（漏掉的那条会把
 * `{n}` 原样显示给用户）。数字用 `toLocaleString` 之外的最朴素形式，避免不同
 * locale 下同一句话出现两种数字格式。
 * @param key - dictionary key (must contain `{n}`).
 * @param n - non-negative count.
 * @returns localized copy with `{n}` replaced.
 */
export function tCount(key: AppCenterKey, n: number): string {
  return t(key).replace('{n}', String(n))
}
