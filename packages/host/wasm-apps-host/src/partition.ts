/**
 * 内置浏览器分区名的镜像实现（协议 handler 必须注册在**每个**分区上）。
 *
 * 跨包约束（与 `packages/host/browser/src/electron-adapter.ts` 的同名函数逐字
 * 一致）：分区名 = `persist:agent-browser-<encoded-user>`，编码表 = `A-Za-z0-9_-`
 * 原样、其余字符 `~<HEX>~`。`@picoaide/dsh-browser` **没有导出**这个辅助函数
 * （它的 exports 只有 `.`/`./client`/`./invariant`），而本包不允许反向依赖它
 * （构建顺序 + 它是 C4 的白名单），所以只能在这里再写一份 —— 与 browser 镜像
 * connectors 的 `encodeSegment` 是同一个取舍：
 *
 *   > 两份实现必须**永不发散**：发散的后果是协议 handler 注册在一个没人用的
 *   > 分区上，应用页面直接 `ERR_UNKNOWN_URL_SCHEME`（空白页）。
 *
 * `src/partition.spec.ts` 把形状（含 browser `tests/partition.spec.ts` 的全部
 * 例值）钉死；部署侧若真的需要另一种命名，用插件 config 的 `partition` 覆盖，
 * 不要去改这里的推导。
 *
 * @module @picoaide/dsh-wasm-apps-host/partition
 */

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
 * 某个员工（或缺省匿名）的内置浏览器分区名。
 * @param username - 当前登录用户名；null/undefined/空串 = 未登录。
 * @returns Electron partition 名（`persist:` 前缀 = 持久化）。
 */
export function browserPartitionFor(username: string | null | undefined): string {
  const key = username !== undefined && username !== null && username.length > 0 ? username : 'anonymous'
  return `persist:agent-browser-${encodePartitionSegment(key)}`
}
