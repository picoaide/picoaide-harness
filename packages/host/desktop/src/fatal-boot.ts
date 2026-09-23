/**
 * 致命启动失败的**用户可见出口**（B-02，2026-09-23 审计 P1）。
 *
 * 缺陷形态（审计原文）：`src/main.ts` 的致命 `catch` 只做
 * `electronLogger.errorCause(cause)` + `shutdown.request(1)`，而 `src/startup-rows.ts`
 * 的模块注释却**自称**"这里抛出的错误会走桌面自己的致命路径
 * （`electronLogger.errorCause` + 恢复对话框）"—— **注释与实现不一致**：
 * 打包 GUI（Windows 双击 / macOS 启动台）既没有 stderr 接收方、也没有窗口，
 * 于是"必要行没激活""数据根不可写""YAML 解析失败"这类故障表现为
 * **双击之后什么都没有**。
 *
 * 本模块只做一件事：把那次失败变成一个**原生错误面**，并给出三个出口
 * （打开日志 / 重试 / 退出）。它与 Electron 的具体实例解耦（`FatalBootSurface`
 * 注入），因此行为可以在 vitest 里逐条钉住，而不是只能靠读源码。
 *
 * 两条硬约束（都是"静默"的反面）：
 *  1. 富对话框（`showMessageBoxSync`）失败时必须退回 `showErrorBox` —— 后者是
 *     Electron 里最可靠的错误面（不需要 ready、不需要父窗口）。两者都失败
 *     （纯无头宿主）才放弃，并把原因交给调用方写 stderr。
 *  2. **绝不**因为"弹不出来"而改变退出语义：调用方无论如何都以非零码退出
 *     （或按用户选择重启），不会变成 0 码静默退出。
 *
 * @module dsh-plugin-desktop/fatal-boot
 */

/**
 * 用户在致命启动对话框里选择的**终局**出口。
 *
 * 「打开日志」不是终局：它打开目录后重新弹出同一个对话框（用户看完日志可以直接
 * 重试），因此不会出现在返回值里。
 */
export type FatalBootChoice = 'retry' | 'quit'

/** 致命启动对话框的全部文案（由 `tray-locale.ts` 按当前语言给出）。 */
export interface FatalBootDialogCopy {
  /** 原生对话框标题（任务栏/窗口管理器可见）。 */
  readonly title: string
  /** 首行结论（"<产品名> 无法启动"）。 */
  readonly message: string
  /** 详情：失败原因 + 日志目录 + 下一步建议。 */
  readonly detail: string
  /** 「打开日志」按钮文案。 */
  readonly openLogs: string
  /** 「重试」按钮文案。 */
  readonly retry: string
  /** 「退出」按钮文案。 */
  readonly quit: string
}

/** `dialog.showMessageBoxSync` 选项里本模块用到的字段。 */
export interface FatalBootDialogOptions {
  readonly type: 'error'
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: string[]
  readonly defaultId: number
  readonly cancelId: number
  readonly noLink: true
}

/** 原生面（Electron `dialog`/`shell` 的最小投影，测试里注入替身）。 */
export interface FatalBootSurface {
  /** 富对话框，返回被点按钮的下标（同步变体：致命路径上不允许再有 await 顺序问题）。 */
  showMessageBoxSync(options: FatalBootDialogOptions): number
  /** 最可靠的兜底错误面（富对话框不可用时）。 */
  showErrorBox(title: string, content: string): void
  /** 用系统默认程序打开日志目录（Electron `shell.openPath`，`''` 表示成功）。 */
  openPath(path: string): Promise<string>
}

/**
 * 对话框选项（按钮顺序 = 返回值语义的唯一真源）。
 *
 * 顺序：0 = 打开日志（平台默认按钮）、1 = 重试、2 = 退出（Esc/关闭窗口）。
 * 「打开日志」放在默认位是刻意的：致命启动失败的第一动作是**取证**，
 * 而"重试"在没有改任何东西之前只会再失败一次。
 * @param copy - localized dialog copy.
 * @returns options for `dialog.showMessageBoxSync`.
 */
export function fatalBootDialogOptions(copy: FatalBootDialogCopy): FatalBootDialogOptions {
  return {
    type: 'error',
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: [copy.openLogs, copy.retry, copy.quit],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
}

/** 「打开日志」最多重开几轮对话框，避免"打开日志"永远失败时把用户困在循环里。 */
const MAX_OPEN_LOGS_ROUNDS = 10

/**
 * 弹一次致命启动错误面并返回用户的出口。
 *
 * 「打开日志」打开目录后**重新弹出**同一个对话框（用户看完日志可以直接重试），
 * 最多 `MAX_OPEN_LOGS_ROUNDS` 轮。任何原生面异常都不得冒泡：致命路径上再抛一次
 * 只会把"用户什么都没看到"变成"用户什么都没看到 + 没有日志"。
 * @param surface - native dialog/shell projection.
 * @param input - localized copy, log directory, and optional diagnostic sink.
 * @returns `'retry'`（调用方重启进程）或 `'quit'`（非零码退出）。
 */
export async function reportFatalBootFailure(
  surface: FatalBootSurface,
  input: {
    readonly copy: FatalBootDialogCopy
    /** 日志目录（`<userData>/logs`）：用户取证的第一现场。 */
    readonly logDirectory: string
    /** 原生面失败时的诊断出口（调用方接 stderr / 日志文件）。 */
    readonly log?: (message: string) => void
  },
): Promise<FatalBootChoice> {
  const options = fatalBootDialogOptions(input.copy)
  for (let round = 0; round < MAX_OPEN_LOGS_ROUNDS; round += 1) {
    let response: number
    try {
      response = surface.showMessageBoxSync(options)
    } catch (cause) {
      input.log?.(`dsh-plugin-desktop: fatal startup dialog unavailable: ${describe(cause)}`)
      // 富对话框不可用（无 GUI/无 ready）时退回最可靠的错误面，仍然让用户看到。
      try {
        surface.showErrorBox(options.title, `${options.message}\n\n${options.detail}`)
      } catch (fallbackCause) {
        input.log?.(`dsh-plugin-desktop: fatal startup error box unavailable: ${describe(fallbackCause)}`)
      }
      return 'quit'
    }
    if (response === 1) return 'retry'
    if (response !== 0) return 'quit'
    try {
      const failure = await surface.openPath(input.logDirectory)
      if (failure !== '') input.log?.(`dsh-plugin-desktop: could not open the log directory: ${failure}`)
    } catch (cause) {
      input.log?.(`dsh-plugin-desktop: could not open the log directory: ${describe(cause)}`)
    }
    // 打开日志后重新询问：用户可能已经拿到需要的信息，直接点重试或退出。
  }
  return 'quit'
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
