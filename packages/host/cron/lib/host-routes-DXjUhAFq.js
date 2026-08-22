import { CRON_API_PREFIX, parseActionEnvelope } from "./protocol.js";
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
* header, plus browser same-origin markers.
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
//#endregion
//#region src/host-routes.ts
const ACTION_LIMIT = 64 * 1024;
const HEARTBEAT_MS = 15e3;
function json(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
async function readBody(req, limit) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > limit) throw new Error("body-too-large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	return {
		raw,
		value: JSON.parse(raw)
	};
}
function makeCronRoutes(service) {
	const guard = (req, res) => {
		if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true;
		json(res, 403, {
			ok: false,
			error: "forbidden"
		});
		return false;
	};
	return [
		{
			kind: "exact",
			path: `${CRON_API_PREFIX}/state`,
			handler: (req, res) => {
				if (req.method !== "GET") return json(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				if (!guard(req, res)) return;
				json(res, 200, service.snapshot());
			}
		},
		{
			kind: "exact",
			path: `${CRON_API_PREFIX}/action`,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				if (!guard(req, res)) return;
				if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, {
					ok: false,
					error: "json-required"
				});
				try {
					const parsed = parseActionEnvelope((await readBody(req, ACTION_LIMIT)).value);
					if (parsed === void 0) return json(res, 400, {
						ok: false,
						error: "invalid-action"
					});
					json(res, 200, service.apply(parsed.requestId, parsed.action));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					json(res, message === "body-too-large" ? 413 : 400, {
						ok: false,
						error: message
					});
				}
			}
		},
		{
			kind: "exact",
			path: `${CRON_API_PREFIX}/events`,
			handler: (req, res) => {
				if (req.method !== "GET") {
					res.writeHead(405);
					res.end();
					return;
				}
				if (!guard(req, res)) return;
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					connection: "keep-alive"
				});
				const push = () => {
					const payload = service.eventPayload();
					res.write(`data: ${JSON.stringify(payload)}\n\n`);
				};
				const unsubscribe = service.subscribe(push);
				const heartbeat = setInterval(() => {
					res.write(": ping\n\n");
				}, HEARTBEAT_MS);
				const close = () => {
					clearInterval(heartbeat);
					unsubscribe();
				};
				req.once("close", close);
				res.once("close", close);
				push();
			}
		}
	];
}
//#endregion
export { makeCronRoutes as t };

//# sourceMappingURL=host-routes-DXjUhAFq.js.map