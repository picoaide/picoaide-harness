/**
 * Loopback trust fence for the enterprise local API routes: socket address,
 * Host header, and browser same-origin markers. Mirrors the cron/task fence
 * (`packages/host/cron/src/loopback.ts`) — the socket address is authoritative
 * and X-Forwarded-For is never trusted. Every local route must pass
 * `isLoopbackRequest` before serving; state-changing endpoints additionally
 * require an explicit HTTP method (see the route handlers).
 *
 * 2026-09-23：实现已收敛到 `@picoaide/dsh-host-locale/loopback`（原先 connectors ≡
 * enterprise 逐字节相同，browser 只差 3 个 `export` 关键字，cron 只差注释 —— 四份
 * 独立实现意味着「一处收紧、其余三处不跟」，对信任边界这是不对称的代价）。本文件
 * 保留为**同名 re-export**：`src/index.ts` / `tests/loopback.spec.ts` 的相对 import
 * 与导出面都不变。**改判定请只改叶子包那份。**
 */
export * from '@picoaide/dsh-host-locale/loopback'
