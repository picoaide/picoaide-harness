/**
 * 应用窗口崩溃恢复状态机的纯逻辑判据（R16B-19）。
 *
 * 这一组用例之所以存在：恢复是"容易写错又难验证"的那一半（单飞、至多一次自动重载、
 * 重试目标在重载前捕获、失败页按钮的可用性）。把它与 Electron 隔开（
 * `app-window-recovery.ts` 不 import electron）之后，那些时序规则可以在纯 Node 下
 * 逐条钉住；`electron-adapter.spec.ts` 那边只证"原生事件真的接到这台状态机上"。
 *
 * 变异验证：
 *  · 去掉 `fail()` 里的单飞（每次都新起一轮）⇒ ②红；
 *  · 把 `phase` 在重载成功后复位成 `'idle'`（"每次崩溃都自动重载"）⇒ ③红；
 *  · 把 `retryTarget` 改成在重载**之后**读取 ⇒ ④红；
 *  · 失败页不写 `retryTarget` / 不写 `disabled` ⇒ ⑤⑥红。
 */
import { describe, expect, it } from 'vitest'
import { createAppWindowRecovery, renderAppWindowFailurePage, type AppWindowFailure, type AppWindowRecoveryHost } from './app-window-recovery.ts'

/** 失败页文案（判据里用固定串，避免与语言解析耦合）。 */
const COPY = { heading: 'HALTED', body: 'BODY', retry: 'RETRY' }

/** 判据里的应用源 scheme。 */
const SCHEME = 'harness-app'

/**
 * 一份可脚本化的原生面替身。
 *
 * `currentUrl()` 按**真实适配器的契约**实现：当前文档是应用文档就用它，否则回落到
 * "最近一次请求的应用 URL"（失败页是 `data:` 文档，直接拿它当重试目标会让按钮失效）。
 */
function fakeHost(options: { url?: string, failLoads?: number, destroyed?: boolean } = {}): {
  host: AppWindowRecoveryHost
  loads: string[]
} {
  const loads: string[] = []
  /** 最近一次请求的**应用** URL（重试目标的回落值）。 */
  let appUrl = options.url ?? `${SCHEME}://demo/notes`
  /** 当前文档（失败页会把它换成 `data:`）。 */
  let documentUrl = appUrl
  let failLoads = options.failLoads ?? 0
  return {
    loads,
    host: {
      isDestroyed: () => options.destroyed === true,
      currentUrl: () => (documentUrl.startsWith(`${SCHEME}:`) ? documentUrl : appUrl),
      load: async (target) => {
        loads.push(target)
        // 应用 URL 的加载按脚本失败；失败页（`data:`）永远成功。
        if (failLoads > 0 && !target.startsWith('data:')) {
          failLoads -= 1
          throw new Error('ERR_CONNECTION_REFUSED')
        }
        documentUrl = target
        if (target.startsWith(`${SCHEME}:`)) appUrl = target
      },
    },
  }
}

/** 一次渲染进程崩溃事件。 */
const crash: AppWindowFailure = { kind: 'render-process-gone', reason: 'crashed' }

describe('单飞与重试额度', () => {
  it('①第一次崩溃：自动重载一次，状态 "坏→好"', async () => {
    const { host, loads } = fakeHost()
    const states: boolean[] = []
    const recovery = createAppWindowRecovery({ host, copy: () => COPY, onCrashStateChange: crashed => states.push(crashed) })

    expect(recovery.phase()).toBe('idle')
    expect(recovery.crashed()).toBe(false)

    await recovery.fail(crash)

    expect(loads).toEqual([`${SCHEME}://demo/notes`])
    expect(recovery.phase()).toBe('reloaded')
    // 崩溃立刻置真（模型面必须已经知道"它坏了"），重载成功再置假。
    expect(states).toEqual([true, false])
    expect(recovery.crashed()).toBe(false)
    expect(recovery.lastFailure()).toEqual(crash)
  })

  it('②恢复途中到达的事件加入同一轮（单飞）：导航次数不变、两个 promise 同时 settle', async () => {
    const { host, loads } = fakeHost()
    const warned: string[] = []
    const recovery = createAppWindowRecovery({ host, copy: () => COPY, warn: message => warned.push(message) })

    // 真机上渲染进程崩溃会**同时**派发进程级（render-process-gone）与导航级
    // （did-fail-load）两个事件 —— 不单飞时两次 `loadURL` 并发。
    const first = recovery.fail(crash)
    const second = recovery.fail({ kind: 'did-fail-load', reason: '-105: NAME_NOT_RESOLVED' })
    await Promise.all([first, second])

    expect(loads).toEqual([`${SCHEME}://demo/notes`])
    expect(recovery.phase()).toBe('reloaded')
    expect(warned.some(message => message.includes('joining'))).toBe(true)
  })

  it('③重载之后再次崩溃：不再自动重载，直接失败页（避免 reload↔crash 死循环）', async () => {
    const { host, loads } = fakeHost()
    const recovery = createAppWindowRecovery({ host, copy: () => COPY })

    await recovery.fail(crash)
    expect(loads).toHaveLength(1)

    await recovery.fail(crash)

    expect(recovery.phase()).toBe('failed')
    expect(loads).toHaveLength(2)
    expect(loads[0]).toBe(`${SCHEME}://demo/notes`)
    expect(loads[1]!.startsWith('data:text/html')).toBe(true)
    expect(recovery.crashed()).toBe(true)
  })

  it('④重试目标在重载**之前**捕获（并发事件不得改变本轮的目标）', async () => {
    const loads: string[] = []
    let appUrl = `${SCHEME}://demo/first`
    let release: (() => void) | undefined
    const recovery = createAppWindowRecovery({
      host: {
        isDestroyed: () => false,
        currentUrl: () => appUrl,
        load: async (target) => {
          loads.push(target)
          if (target.startsWith('data:')) return
          // 重载进行中：另一个事件源把"当前 URL"改掉（真实序列里这完全可能 ——
          // 第二次 open 会导航到别的路径）。
          appUrl = `${SCHEME}://demo/second`
          await new Promise<void>((resolve) => { release = resolve })
        },
      },
      copy: () => COPY,
    })

    // 本轮恢复被上面的 await 挂住：第二个事件必须**加入**它，而不是另起一次导航。
    const first = recovery.fail(crash)
    const second = recovery.fail({ kind: 'did-fail-load', reason: '-105: X' })
    release?.()
    await Promise.all([first, second])

    // 本轮只有一次导航，目标是**崩溃时**的 URL（不是被改掉后的那个）。
    expect(loads).toEqual([`${SCHEME}://demo/first`])
  })

  it('⑤重载失败 ⇒ 失败页带**可用**的重试按钮（指向崩溃前的应用 URL）', async () => {
    const { host, loads } = fakeHost({ failLoads: 1 })
    const recovery = createAppWindowRecovery({ host, copy: () => COPY })

    await recovery.fail(crash)

    expect(loads).toHaveLength(2)
    const page = decodeURIComponent(loads[1]!)
    expect(page).toContain(`${SCHEME}://demo/notes`)
    expect(page).toContain('id="retry"')
    expect(page).toContain('RETRY')
    expect(page).not.toContain('id="retry" disabled')
    expect(recovery.phase()).toBe('failed')
    expect(recovery.crashed()).toBe(true)
  })

  it('⑥没有可用目标（窗口还没拿到文档 URL）⇒ 失败页 + 禁用的按钮，且不尝试导航', async () => {
    const { host, loads } = fakeHost({ url: '' })
    const recovery = createAppWindowRecovery({ host, copy: () => COPY })

    await recovery.fail(crash)

    expect(loads).toHaveLength(1)
    expect(loads[0]!.startsWith('data:text/html')).toBe(true)
    expect(decodeURIComponent(loads[0]!)).toContain('id="retry" disabled')
  })

  it('⑦重试目标在失败页显示期间仍然记得住（第二次失败页的按钮不得变灰）', async () => {
    const { host, loads } = fakeHost()
    const recovery = createAppWindowRecovery({ host, copy: () => COPY })

    // 第一次崩溃 → 自动重载（成功）→ 第二次崩溃 → 失败页（当前文档已变成 data:）。
    await recovery.fail(crash)
    await recovery.fail(crash)
    expect(loads).toHaveLength(2)

    // 第三次崩溃（用户还没点重试）：失败页上的按钮必须**仍然可用** ——
    // 判据是按钮引用的目标，而不是"文档还有没有 URL"。
    await recovery.fail(crash)
    expect(loads).toHaveLength(3)
    const page = decodeURIComponent(loads[2]!)
    expect(page).toContain(`${SCHEME}://demo/notes`)
    expect(page).not.toContain('id="retry" disabled')
  })

  it('⑧窗口已销毁 ⇒ 一切恢复动作都是 no-op（不许给死窗口发导航）', async () => {
    const { host, loads } = fakeHost({ destroyed: true })
    const states: boolean[] = []
    const recovery = createAppWindowRecovery({ host, copy: () => COPY, onCrashStateChange: crashed => states.push(crashed) })

    await recovery.fail(crash)

    expect(loads).toEqual([])
    // 状态仍然翻转（窗口没了也是"坏了"，宿主会把它从模型面摘掉）。
    expect(states).toEqual([true])
  })
})

describe('状态上报与失败页渲染', () => {
  it('状态变化才上报（同值不重复），loaded() 是"窗口好了"的另一条入口', async () => {
    const { host } = fakeHost()
    const states: boolean[] = []
    const recovery = createAppWindowRecovery({ host, copy: () => COPY, onCrashStateChange: crashed => states.push(crashed) })

    recovery.loaded()
    expect(states).toEqual([])

    const pending = recovery.fail(crash)
    // 用户在失败页点了「重试」并成功：适配器在 `did-finish-load` 收到**应用文档**
    // 时报告（这是 `fail()` 之外唯一的"好了"入口）。
    recovery.loaded()
    expect(states).toEqual([true, false])
    await pending
  })

  it('失败页把重试目标安全地嵌进脚本（带 </script> 的 URL 不能逃出脚本块）', () => {
    const page = renderAppWindowFailurePage({
      copy: COPY,
      retryTarget: `${SCHEME}://demo/</script><script>window.pwned=1</script>`,
    })
    const html = decodeURIComponent(page)
    expect(page.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    // 脚本块里不能出现裸的 `</script>`（转义成 `\u003c`）。
    expect(html).not.toContain('</script><script>')
    expect(html).toContain('\\u003c/script')
    expect(html).toContain('id="retry"')
  })

  it('诊断出口收到"重载没完成"与"失败页也加载不出来"两类事件', async () => {
    const warned: string[] = []
    const loads: string[] = []
    const recovery = createAppWindowRecovery({
      host: {
        isDestroyed: () => false,
        currentUrl: () => `${SCHEME}://demo/`,
        load: async (target) => {
          loads.push(target)
          throw new Error('boom')
        },
      },
      copy: () => COPY,
      warn: message => warned.push(message),
    })

    await recovery.fail(crash)
    expect(loads).toHaveLength(2)
    expect(warned.some(message => message.includes('automatic reload'))).toBe(true)
    expect(warned.some(message => message.includes('failure page failed to load'))).toBe(true)
  })
})
