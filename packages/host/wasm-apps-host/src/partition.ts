/**
 * 内置浏览器分区名的镜像实现（协议 handler 必须注册在**每个**分区上）。
 *
 * 跨包约束（与 `packages/host/browser/src/electron-adapter.ts:285` 的同名函数逐字
 * 一致）：分区名 =
 *
 *     persist:agent-browser-<encoded-user>[@<server-hash>]
 *
 * 编码表 = `A-Za-z0-9_-` 原样、其余字符 `~<HEX>~`；`<server-hash>` = 服务端地址的
 * sha256 前 32 位 hex（本文件的 {@link serverPartitionHash}）。
 *
 * **服务端哈希是 §7.2 冻结条款**（设计总纲 2026-09-19 §7.2 / R2S-8：
 * `persist:agent-browser-<user>@<server-hash>`）：分区是 `persist:` 的，同一台机器上
 * 切换服务端地址（本仓部署拓扑里测试/正式并存，真实可触发）会让新旧租户**共用同一个
 * 持久分区** —— 同名应用 origin（`<scheme>://<app_id>`）的 localStorage/IndexedDB
 * 于是跨租户串味。2026-09-21 审计 P1-10 证据②。未登录（匿名）没有租户可隔离，
 * 因此**不带**哈希（与 browser 包的启动分区逐字相同）。
 *
 * `@picoaide/dsh-browser` **没有导出**这个辅助函数（它的 exports 只有
 * `.`/`./client`/`./invariant`/`./guard`/`./surface`），而本包不允许反向依赖它
 * （构建顺序 + 它是 C4 的白名单），所以只能在这里再写一份 —— 与 browser 镜像
 * connectors 的 `encodeSegment` 是同一个取舍：
 *
 *   > 两份实现必须**永不发散**：发散的后果是协议 handler 注册在一个没人用的
 *   > 分区上，应用页面直接 `ERR_UNKNOWN_URL_SCHEME`（空白页）。
 *
 * 因此**browser 侧必须同批改成同一份公式**（含 `@<server-hash>` 后缀与同一个哈希
 * 口径）；找到 `browserPartitionFor` 的**一处**定义改成与本文件同形，并让
 * `packages/host/browser/src/index.ts` 把当前会话的服务端地址哈希传进去。
 * 最好的终局是把这份实现从 `@picoaide/dsh-browser/surface` 导出来，删掉本镜像
 * （台账 TST-14「分区名跨包镜像无对拍」的根治）。
 *
 * `src/partition.spec.ts` 把形状（含 browser `tests/partition.spec.ts` 的全部例值 +
 * 哈希后缀）钉死；部署侧若真的需要另一种命名，用插件 config 的 `partition` 覆盖，
 * 不要去改这里的推导。
 *
 * @module @picoaide/dsh-wasm-apps-host/partition
 */

import { createHash } from 'node:crypto'

/**
 * 编码分区名里的一个段（与 browser/connectors 的编码表逐字一致）。
 * @param segment - 原始用户名（或空）。
 * @returns 可安全放进分区名的串；空输入回落 `anonymous`。
 */
export function encodePartitionSegment(segment: string): string {
  let out = ''
  for (const char of segment) {
    const code = char.codePointAt(0)!
    if ((code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || char === '-' || char === '_') {
      out += char
    } else {
      out += `~${code.toString(16).toUpperCase()}~`
    }
  }
  return out.length === 0 ? 'anonymous' : out
}

/**
 * 服务端地址 → 分区名后缀（sha256 前 32 位 hex）。
 *
 * 口径与 `cache.ts` 的 session-scope **同族**（`sha256(值) hex 前 32 位`），但先做
 * 归一化：去首尾空白 + 去尾斜杠 —— 分区名是**磁盘目录名**，`https://a.example` 与
 * `https://a.example/` 必须落在同一个分区里（否则一次地址写成带斜杠就换一个空分区，
 * 用户看到的是"应用里的存储突然没了"）。
 *
 * 返回 `undefined`（未登录 / 空地址）⇒ 调用方**不带**哈希后缀。
 * @param serverURL - 当前会话的服务端地址。
 * @returns 32 位 hex 摘要，或 undefined。
 */
export function serverPartitionHash(serverURL: string | null | undefined): string | undefined {
  if (typeof serverURL !== 'string') return undefined
  let value = serverURL.trim()
  while (value.endsWith('/')) value = value.slice(0, -1)
  if (value === '') return undefined
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/**
 * 某个员工（或缺省匿名）的内置浏览器分区名。
 * @param username - 当前登录用户名；null/undefined/空串 = 未登录。
 * @param serverHash - {@link serverPartitionHash} 的结果；未登录/取不到时缺省。
 * @returns Electron partition 名（`persist:` 前缀 = 持久化）。
 */
export function browserPartitionFor(username: string | null | undefined, serverHash?: string | undefined): string {
  const key = username !== undefined && username !== null && username.length > 0 ? username : 'anonymous'
  const base = `persist:agent-browser-${encodePartitionSegment(key)}`
  // 匿名（未登录）没有租户可隔离 ⇒ 保持不带后缀（与 browser 包的启动分区逐字相同）。
  const suffix = key === 'anonymous' ? undefined : serverHash
  return suffix === undefined || suffix === '' ? base : `${base}@${suffix}`
}
