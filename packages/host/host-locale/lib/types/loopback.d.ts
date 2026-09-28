/**
 * Loopback trust fence for the host-side local API routes: socket address,
 * Host header, and browser same-origin markers. The socket address is
 * authoritative and X-Forwarded-For is never trusted. Every local route must
 * pass `isLoopbackRequest` before serving; state-changing endpoints
 * additionally require an explicit HTTP method (see the route handlers).
 *
 * 2026-09-23：本文件是**唯一实现**。此前 `packages/host/{connectors,enterprise,
 * browser,cron}/src/loopback.ts` 各持一份（connectors ≡ enterprise 逐字节相同，
 * browser 只差 3 个 `export` 关键字，cron 只差注释），四份互为独立实现意味着
 * 「一处收紧、其余三处不跟」——对信任边界，这种漂移是不对称的。四个包现在各自
 * 保留 `src/loopback.ts` 作为**同名 re-export**（对外子路径与导出面不变；
 * `@picoaide/dsh-enterprise/loopback` 是 `packages/client/account-card` 在消费的
 * 外部契约）。改判定请只改本文件。
 *
 * 出处署名：设计移植自 dsh-web-ui `shared/host`（Apache-2.0）。
 *
 * ## 本模块的两级（2026-09-27 FIX-42② 起）
 *
 * 本地路由的信任边界是**两级**，第二级在下面（`ConnectionTrustFence` /
 * `acceptWriteProof`）：
 *
 *  1. {@link isLoopbackRequest} + {@link browserSameOriginMarker}：回环 socket、
 *     回环 Host、浏览器同源标记。它回答"这一发是不是本机 + 看起来像不像浏览器页面"，
 *     而上面的注释已经自述其边界 —— **伪造 Origin 的 curl 也过得了**。
 *  2. **持有性证明**：`dsh-auth-<authority>`（HttpOnly + SameSite=Strict + HMAC，
 *     只能由本进程服务、经 launch token 换票的页面持有，直接复用上游 `connection`
 *     服务的 `requestRejection()`）。只有它回答"这一发是不是**那个**页面"。
 *
 * 第二级此前在 desktop / cron / connectors / browser / enterprise-auth-gate /
 * wasm-apps-host 六处各有一份同形拷贝。这里放的是**规范实现**（零依赖叶子：只
 * import `node:http` 的**类型**，与 `loopback` 入口同一口径），消费方经各自
 * `src/loopback.ts` 的同名 re-export 取用 —— `packages/client/account-card` 因此
 * 不需要新增任何依赖边（它已经在消费 `@picoaide/dsh-enterprise/loopback`），
 * 也不可能复用 desktop 那份（`dsh-plugin-desktop` 在 `scripts/check-workspaces.mjs`
 * 里声明了 `needs: ['@picoaide/dsh-account-card']`，反向 import 会成环）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export declare function isIPv4Loopback(v4: string): boolean;
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export declare function isLoopbackAddress(address: string | undefined): boolean;
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export declare function isLoopbackHostname(hostname: string): boolean;
/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. A bare curl from the same host
 * passes the socket/Host checks; a cross-site browser request is refused.
 */
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
/**
 * Browser-signal tripwire, NOT an authority check: a bare curl sends neither
 * header and is refused, but a curl with a forged Origin passes this too.
 * The real boundary is the loopback socket + Host + origin-equality checks
 * in isLoopbackRequest; do not rely on this marker alone.
 */
export declare function browserSameOriginMarker(req: IncomingMessage): boolean;
/**
 * 上游 `connection` 服务（BrowserAuth 持有性检查）在本地路由里需要的**最小结构**。
 *
 * 刻意不 `import type {} from '@deepseek-ai/dsh-client-connection'`：那会给本叶子包
 * 增加一条依赖边（违反"零依赖"不变量），而这里只需要一个方法。结构类型 + 运行时
 * 存在性判断已足够，并且能在服务缺席时明确 fail-closed。
 */
export interface ConnectionTrustFence {
    /**
     * Connection 的 Host/Origin 围栏 + BrowserAuth cookie 校验。
     * @param request - 只用到 headers(Host / Cookie)。
     * @returns 401/403 表示拒绝；undefined 表示通过。
     */
    requestRejection(request: {
        headers: IncomingMessage['headers'];
    }): 401 | 403 | undefined;
}
/** 持有性证明的依赖：fence 来源 + 诊断前缀。 */
export interface WriteProofDeps {
    /** 证明来源（`ctx.get('connection')`）；每请求求值，服务可能晚于路由注册出现。 */
    fence: () => ConnectionTrustFence | undefined;
    /** 诊断前缀（插件名），用于日志。 */
    label: string;
    /** 拒绝原因写入插件日志；缺省丢弃。 */
    warn?: (message: string) => void;
}
/** 证明闸结论：`ok` 为 false 时给出拒绝状态码与机器可读错误码。 */
export type WriteProofOutcome = {
    ok: true;
} | {
    ok: false;
    status: 403 | 503;
    error: 'browser session proof required' | 'browser session proof unavailable';
};
/** 拒绝响应的提示文案（`write-proof` 族的各处拷贝逐字一致）。 */
export declare const WRITE_PROOF_HINT = "reopen the application window from its launch URL";
/**
 * 写面持有性证明闸：GET 读面豁免，其余方法必须持本进程签发的 BrowserAuth cookie。
 *
 * **消费型 GET 不在豁免面内**（那是本仓已登记的绕过链：`exact` 路由优先于 `/api`
 * prefix，而 cookie 围栏只装在 prefix 通道上）：调用方要用非 GET 的**方法视图**
 * 复用本闸（先例 `packages/host/desktop/src/loop-notify-route.ts` 的
 * `acceptConsumingProof`），不要另写一份判定。
 * @param req - 进入证明闸的请求（只读 method 与 headers）。
 * @param deps - fence 来源与诊断前缀。
 * @returns 通过，或 403（证明不足）/ 503（证明机制缺席）的拒绝结论。
 */
export declare function requireWriteProof(req: IncomingMessage, deps: WriteProofDeps): WriteProofOutcome;
/**
 * 写面证明闸 + 拒绝响应：拿不到证明时写出 403/503 并返回 false。
 *
 * 每个写路由自己调用本函数（而不是由注册方统一包装），因此任何调用者——包括直接
 * 调用 handler 的代码——都无法绕过证明；`proof` 未接线（undefined）按证明机制缺席
 * fail-closed，不退回各路由自己的 Origin 检查。
 * @param req - 进入证明闸的请求。
 * @param res - 拒绝时写出的响应。
 * @param proof - 证明依赖；缺省/未接线 ⇒ 503。
 * @returns 请求持有证明、可以继续时为 true。
 */
export declare function acceptWriteProof(req: IncomingMessage, res: ServerResponse, proof: WriteProofDeps | undefined): boolean;
