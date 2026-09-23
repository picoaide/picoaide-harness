/**
 * Loopback trust fence for the enterprise local API routes: socket address,
 * Host header, and browser same-origin markers. Mirrors the cron/task fence
 * (`packages/host/cron/src/loopback.ts`) — the socket address is authoritative
 * and X-Forwarded-For is never trusted. Every local route must pass
 * `isLoopbackRequest` before serving; state-changing endpoints additionally
 * require an explicit HTTP method (see the route handlers).
 *
 * 2026-09-23：实现已收敛到 `@picoaide/dsh-host-locale/loopback`（本文件与 connectors
 * 那份原先逐字节相同）。**本文件是外部契约**：`packages/client/account-card/src/index.ts`
 * 直接 `import … from '@picoaide/dsh-enterprise/loopback'` ⇒ `package.json` 的
 * `./loopback` 子路径与 tsdown 的 `loopback` 入口都必须保留，只是内容变成 re-export。
 */
export * from '@picoaide/dsh-host-locale/loopback'
