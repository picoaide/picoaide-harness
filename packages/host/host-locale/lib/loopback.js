//#region src/loopback.ts
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/**
* Request-level trust fence: a loopback socket address AND a loopback Host
* header, plus browser same-origin markers. A bare curl from the same host
* passes the socket/Host checks; a cross-site browser request is refused.
*/
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/**
* Browser-signal tripwire, NOT an authority check: a bare curl sends neither
* header and is refused, but a curl with a forged Origin passes this too.
* The real boundary is the loopback socket + Host + origin-equality checks
* in isLoopbackRequest; do not rely on this marker alone.
*/
function browserSameOriginMarker(req) {
	return req.headers["sec-fetch-site"] === "same-origin" || typeof req.headers.origin === "string";
}
/** 拒绝响应的提示文案（`write-proof` 族的各处拷贝逐字一致）。 */
const WRITE_PROOF_HINT = "reopen the application window from its launch URL";
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
function requireWriteProof(req, deps) {
	if (req.method === "GET") return { ok: true };
	const warn = deps.warn ?? (() => {});
	const fence = deps.fence();
	if (fence === void 0 || typeof fence.requestRejection !== "function") {
		warn(`${deps.label}: connection service unavailable; refusing a local write (fail-closed)`);
		return {
			ok: false,
			status: 503,
			error: "browser session proof unavailable"
		};
	}
	let rejection;
	try {
		rejection = fence.requestRejection({ headers: req.headers });
	} catch (error) {
		warn(`${deps.label}: browser proof check failed (${error instanceof Error ? error.message : String(error)})`);
		rejection = 403;
	}
	if (rejection === void 0) return { ok: true };
	warn(`${deps.label}: refused a local write without browser proof (${String(rejection)})`);
	return {
		ok: false,
		status: 403,
		error: "browser session proof required"
	};
}
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
function acceptWriteProof(req, res, proof) {
	const outcome = requireWriteProof(req, proof ?? {
		fence: () => void 0,
		label: "local-route"
	});
	if (outcome.ok) return true;
	res.statusCode = outcome.status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify({
		error: outcome.error,
		hint: WRITE_PROOF_HINT
	}));
	return false;
}
//#endregion
export { WRITE_PROOF_HINT, acceptWriteProof, browserSameOriginMarker, isIPv4Loopback, isLoopbackAddress, isLoopbackHostname, isLoopbackRequest, requireWriteProof };

//# sourceMappingURL=loopback.js.map