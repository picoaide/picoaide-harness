/**
 * Desktop client UI copy: zh is the key source, en mirrors the full key set
 * (the same pattern as the dsh-connectors / dsh-cron / dsh-enterprise locales).
 *
 * Scope: the desktop-owned client surfaces. Today that is the update badge and
 * its hover text — the other desktop client rows (advanced frame, loop-notify
 * bridge) render no copy of their own.
 *
 * 2026-09-16 i18n：更新徽标此前是**中英混排**——`label` 硬编码中文（`安装 2.7.5`）
 * 而同一对象的 `title` 是英文，所以任何语言下都有一半是错的。整组文案改为走字典。
 */
export const zh = {
  /** 徽标按钮文字：安装包已就绪时显示。 */
  'update.install': '安装 {version}',
  /** 徽标悬停：已下载，可安装。 */
  'update.installTitle': '版本 {version} 已下载 — 点击安装',
  /** 徽标悬停：正在下载。 */
  'update.downloadingTitle': '正在下载 {version}…',
  /** 徽标悬停：有新版本，点击检查。 */
  'update.availableTitle': '版本 {version} 可用 — 点击检查',
  /** 徽标悬停：重试等待中（第 N 次，倒计时）。 */
  'update.retryingIn': '正在重试下载（第 {attempt} 次），{seconds} 秒后继续…',
  /** 徽标悬停：正在下载（第 N 次）。 */
  'update.retryingNow': '正在下载（第 {attempt} 次）…',

  // 语音输入准备面（2026-09-29）。上游的准备卡片挂在插件管理页，我们禁用那行，
  // 所以这一面（对话框标题/状态/按钮）由桌面自己提供。
  /** 对话框标题。 */
  'voice.title': '语音输入',
  /** 对话框说明（做什么、音频去哪）。 */
  'voice.intro': '语音输入使用本机运行的识别模型：录音只在本机转写，音频不上传。首次使用需要先下载识别模型，之后可离线使用。',
  /** 数据边界说明。 */
  'voice.privacy': '模型与识别都在本机；转写结果只作为草稿插入输入框，不会自动发送。',
  /** speech Remote 不可达（bundle 未装配或还没挂载）。 */
  'voice.unavailable': '语音服务尚未就绪：语音插件未装配或正在启动。',
  /** catalog 里没有任何提供者。 */
  'voice.noProvider': '当前没有可用的语音识别提供者。',
  /** 本机没有可用的录音设备（上游会把这句话拼在"语音识别失败："后面）。 */
  'voice.noDevice': '未检测到麦克风设备。请检查系统声音设置里的输入设备；虚拟机或远程桌面需开启音频/麦克风重定向。',
  /** 未准备时的下载量与磁盘占用提示（`{download}` = 实际下载，`{disk}` = 上游预留建议）。 */
  'voice.estimate': '首次下载约 {download}（建议预留磁盘 {disk}；模型常驻磁盘，之后可离线使用）。',
  /** 主按钮：下载并启用。 */
  'voice.download': '下载并启用',
  /** 主按钮：失败后重试。 */
  'voice.retry': '重试下载',
  /** 次按钮：取消下载。 */
  'voice.cancel': '取消下载',
  /** 次按钮：关闭对话框。 */
  'voice.close': '关闭',
  /** 阶段：尚未准备。 */
  'voice.phase.unprepared': '尚未下载识别模型',
  /** 阶段：下载中。 */
  'voice.phase.downloading': '正在下载识别模型…',
  /** 阶段：校验中。 */
  'voice.phase.checking': '正在校验模型文件…',
  /** 阶段：加载中。 */
  'voice.phase.loading': '正在加载识别模型…',
  /** 阶段：唤醒中。 */
  'voice.phase.waking': '正在唤醒识别引擎…',
  /** 阶段：取消中。 */
  'voice.phase.cancelling': '正在取消下载…',
  /** 阶段：失败。 */
  'voice.phase.failed': '模型准备失败',
  /** 阶段：已取消。 */
  'voice.phase.cancelled': '下载已取消',
  /** 阶段：就绪（含 standby：模型在盘，首次录音自动唤醒）。 */
  'voice.phase.ready': '已就绪',
}

export const en: Record<keyof typeof zh, string> = {
  'update.install': 'Install {version}',
  'update.installTitle': 'Version {version} is downloaded — click to install',
  'update.downloadingTitle': 'Downloading {version}…',
  'update.availableTitle': 'Version {version} available — click to check',
  'update.retryingIn': 'Retrying download (attempt {attempt}) in {seconds}s…',
  'update.retryingNow': 'Downloading (attempt {attempt})…',
  'voice.title': 'Voice input',
  'voice.intro': 'Voice input runs a speech model on this machine: recordings are transcribed locally and audio is never uploaded. The first use downloads the recognition model once, after which it works offline.',
  'voice.privacy': 'The model and recognition stay on this machine. A transcript is inserted into the draft only — it is never sent automatically.',
  'voice.unavailable': 'Speech is not ready yet: the voice plugin is not installed or still starting.',
  'voice.noProvider': 'No speech recognition provider is available.',
  'voice.noDevice': 'No microphone device was found. Check the input devices in your system sound settings; virtual machines and remote desktops need audio/microphone redirection.',
  'voice.estimate': 'The first download is about {download} (reserve about {disk} on disk; the model stays on disk and then works offline).',
  'voice.download': 'Download and enable',
  'voice.retry': 'Retry download',
  'voice.cancel': 'Cancel download',
  'voice.close': 'Close',
  'voice.phase.unprepared': 'Recognition model is not downloaded yet',
  'voice.phase.downloading': 'Downloading the recognition model…',
  'voice.phase.checking': 'Verifying model files…',
  'voice.phase.loading': 'Loading the recognition model…',
  'voice.phase.waking': 'Waking the recognition engine…',
  'voice.phase.cancelling': 'Cancelling the download…',
  'voice.phase.failed': 'Model preparation failed',
  'voice.phase.cancelled': 'Download cancelled',
  'voice.phase.ready': 'Ready',
}

export type DesktopClientKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: DesktopClientKey, params?: Record<string, string>): string {
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
