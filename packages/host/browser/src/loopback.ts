/**
 * Loopback trust fence for the browser host's local API routes: socket address,
 * Host header, and browser same-origin markers. The socket address is
 * authoritative and X-Forwarded-For is never trusted.
 *
 * 2026-09-23：实现已收敛到 `@picoaide/dsh-host-locale/loopback`（本文件原先与
 * connectors 那份只差 `isIPv4Loopback` / `isLoopbackAddress` / `isLoopbackHostname`
 * 三个 `export` 关键字）。收敛后导出面**更宽**（三个内部谓词也可用）——对既有调用方
 * （`src/index.ts`、`src/guard.ts`、`src/credential-site.ts`、`src/runtime.ts`）是纯增量，
 * 不破坏任何 import。
 */
export * from '@picoaide/dsh-host-locale/loopback'
