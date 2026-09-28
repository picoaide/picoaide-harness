/**
 * 出口策略真机探针的 **Electron 侧**（由 `proxy-policy-probe.mjs` 启动，不要手工跑）。
 *
 * 两条硬约束（2026-09-22 实测踩到）：
 *  1. `import { app } from 'electron'` 必须是**静态**导入：ESM main 里 ready 在模块求值
 *     **完成之后**才发，顶层 `await app.whenReady()` 会与之死锁（症状：进程永远不 ready，
 *     只打出模块求值前的那一行）。
 *  2. `applySystemProxyPolicy` 必须在**模块作用域同步**调用（晚于 ready 就静默无效）。
 */
import { app, session } from 'electron'
import {
  applySystemProxyPolicy,
  enforceDirectNodeTransport,
  resolveSystemProxyPolicy,
  stripProxyEnvironment,
} from '../lib/network-policy.js'

const TARGET = 'http://probe.invalid/hello'
const skipSwitch = process.env.PROBE_SKIP_SWITCH === '1'
const decision = resolveSystemProxyPolicy(process.env, undefined)
if (!skipSwitch) applySystemProxyPolicy(app.commandLine, decision)
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const out = { mode: skipSwitch ? 'control' : 'applied', decision }
  // Node 侧：判定必须用**删除前**的环境，删除后 NODE_USE_ENV_PROXY 才消失。
  out.transport = skipSwitch ? 'skipped' : await enforceDirectNodeTransport(process.env)
  out.cleared = skipSwitch ? [] : stripProxyEnvironment(process.env)

  const defaults = session.defaultSession
  const partition = session.fromPartition('persist:proxy-probe')
  // `resolveProxy` 的**首次**读数没有判别力（2026-09-26 复审 B-2）：Chromium 还没解析代理
  // 配置时它返回初始化的 DIRECT 默认值 —— 把开关改名成 Chromium 不认的名字后，这里**仍然**
  // 读回 DIRECT。所以请求前的那次读数只留作诊断，判据用请求**之后**的那一次。
  out.resolveDefaultBefore = await defaults.resolveProxy(TARGET)
  out.resolvePartitionBefore = await partition.resolveProxy(TARGET)
  for (const [label, target] of [['http', defaults], ['partition', partition]]) {
    try {
      const response = await target.fetch(TARGET)
      out[label] = { status: response.status, body: await response.text() }
    } catch (error) {
      out[label] = { error: String(error?.message ?? error) }
    }
  }
  // 至少一次真实请求之后：Chromium 已经解析过代理配置，读数才代表这条 session 的实际出口。
  out.resolveDefault = await defaults.resolveProxy(TARGET)
  out.resolvePartition = await partition.resolveProxy(TARGET)
  try {
    const response = await fetch(TARGET)
    out.nodeFetch = { status: response.status, body: await response.text() }
  } catch (error) {
    out.nodeFetch = { error: String(error?.message ?? error), cause: String(error?.cause?.code ?? '') }
  }
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(out)}\n`)
  app.exit(0)
})
