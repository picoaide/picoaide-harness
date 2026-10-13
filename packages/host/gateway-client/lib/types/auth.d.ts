import type { Session } from './config.ts';
import { type HostLocale } from '@picoaide/dsh-host-locale';
export type AuthErrorKind = 'invalid_credentials' | 'auth_expired' | 'network' | 'server_error';
/**
 * 服务端"先改密"守卫的稳定错误码（`serverauth/handler.go` 对
 * `password_must_change` 用户白名单外的一切接口回 `403 {error:{code}}`）。
 *
 * 它**必须**在客户端被当成契约而不是一句文案：`fetchJSON` 会把它放进
 * `ApiError.code`，auth-gate 的代理层按码回 403 + 可操作路径（此前被压成
 * `502 {"error":"gateway error: …"}` ⇒ 码丢了、面板只剩一句被包了一层的文本，
 * 任何"把用户送回改密页"的分支都无从下手）。R15B-02，2026-09-25。
 */
export declare const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED";
/**
 * 该错误是不是"服务端要求先改密"。
 *
 * 判据只看码（不看 message）：服务端文案是中文散文、可随时改，而码是稳定契约
 * —— 与 `AccountSection` 从"嗅探中文原文"改为"读稳定码"是同一口径。
 * @param cause - 任意被捕获的值。
 * @returns true 表示必须先改密再重试。
 */
export declare function isPasswordChangeRequired(cause: unknown): boolean;
/**
 * 「先改密」应答里给界面的动作名（R15B-02）。
 *
 * 与 `code` 一样是**跨端契约**：面板/账号页据此把用户送到改密页，而不是各写各的
 * 文案匹配。客户端已有的那条路径是 `/change-password`（auth-gate 的精确路由，
 * 也是索引渲染在 `mustChangePassword` 时给出的页面）。
 */
export declare const PASSWORD_CHANGE_REQUIRED_ACTION = "change-password";
/**
 * User-facing message per auth failure kind (shown by the login page).
 *
 * 这些消息**用户可见**: 登录页把 `AuthError.message` 原样渲染出来, 所以按宿主
 * 语言取文案。语言由调用方**按请求**解析后传入(见 auth-gate.ts 的 hostLocale);
 * 缺省中文 = 历史行为(account-card 等不发语言的调用方行为不变)。
 * @param kind - 认证失败类别。
 * @param locale - 宿主语言。
 * @returns 该语言的用户可见文案。
 */
export declare function authErrorMessage(kind: AuthErrorKind, locale?: HostLocale): string;
export declare class AuthError extends Error {
    kind: AuthErrorKind;
    constructor(kind: AuthErrorKind, message?: string, locale?: HostLocale);
}
export declare class ApiError extends Error {
    code: string;
    /** 服务端原始 HTTP 状态码(2026-09-02 归属权:上传错误转发须透传,
     *  否则 VERSION_EXISTS=409 / APP_LOCKED=403 / NOT_FOUND=404 被压平成 422)。 */
    status?: number | undefined;
    constructor(code: string, message: string, 
    /** 服务端原始 HTTP 状态码(2026-09-02 归属权:上传错误转发须透传,
     *  否则 VERSION_EXISTS=409 / APP_LOCKED=403 / NOT_FOUND=404 被压平成 422)。 */
    status?: number | undefined);
}
/**
 * Normalize a user-entered server URL: trim whitespace and strip one or more
 * trailing slashes so `https://host/` and `https://host` behave identically.
 * The login page brands/methods probes and every gateway request go through
 * here — a trailing slash must never produce `//api/...` path segments.
 */
export declare function normalizeServerURL(input: string): string;
export declare function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
/**
 * Re-check that a server URL is allowed on every use (not only at login):
 * https, or http restricted to loopback hosts. Prevents a persisted session
 * from steering credentials or tokens at an arbitrary http:// target later.
 */
export declare function assertServerURLAllowed(serverURL: string): void;
/**
 * 登录网关。`locale` 只影响**本地生成**的用户可见文案(账号或密码错误等);
 * 服务端下发的消息原样透出(服务端文案不在 i18n 范围内)。
 * @param serverURL - 服务端地址(尾部斜杠会被归一)。
 * @param username - 账号。
 * @param password - 密码。
 * @param locale - 宿主语言(调用方按请求解析)。
 * @returns 已建立的会话。
 */
export declare function login(serverURL: string, username: string, password: string, locale?: HostLocale): Promise<Session>;
/**
 * 0057 员工自助改密(本地认证用户): 成功后服务端吊销该用户全部令牌(含当前),
 * 调用方必须清除本地会话并让用户重新登录。
 * 失败时抛出携带服务端中文消息的错误(原密码错误/外部用户/长度不足等)。
 */
export declare function changePassword(serverURL: string, token: string, oldPassword: string, newPassword: string): Promise<void>;
export declare function fetchJSON(serverURL: string, path: string, opts?: {
    token?: string;
    method?: string;
    body?: unknown;
    timeoutMs?: number;
    locale?: HostLocale;
}): Promise<any>;
