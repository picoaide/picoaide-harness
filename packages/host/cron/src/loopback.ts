/**
 * Loopback trust fence for the cron API routes: socket address, Host header,
 * and browser same-origin markers. Ported from dsh-web-ui shared/host
 * (Apache-2.0); the socket address is authoritative and X-Forwarded-For is
 * never trusted.
 *
 * 2026-09-23：实现已收敛到 `@picoaide/dsh-host-locale/loopback`（本文件原先与
 * connectors 那份只差注释，代码零差异）。上游出处（dsh-web-ui shared/host,
 * Apache-2.0）的署名随实现留在叶子包的文件头里。本文件保留为**同名 re-export**：
 * `src/host-routes.ts` 的相对 import 与 `tests/loopback.spec.ts` 都不变。
 */
export * from '@picoaide/dsh-host-locale/loopback'
