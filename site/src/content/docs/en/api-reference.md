---
title: API Reference
description: 'The PicoAide Harness server HTTP API: namespaces, authentication and sessions, endpoint tables by function, the error envelope, and version/compatibility commitments.'
---

This page is the public reference for the server HTTP API. **The code is the single source of truth** — every path, method and authentication middleware is declared in one place, `server/internal/router/router.go`; where this page and that file disagree, the code wins.

Except for the product HTML surfaces (the portal at `/` and `/portal`, the Admin Console at `/admin/*`) and file downloads (installers, archives, channel assets), every endpoint returns JSON; failures always use the error envelope `{"error":{"code":"...","message":"..."}}`.

## Namespace overview

| Namespace | Purpose | Authentication |
|---|---|---|
| `/api/client/v2/*` | Employee surface: desktop client and third-party integrations | Bearer token (a few endpoints are public; see the tables) |
| `/api/server/admin/*` | Admin surface: Admin Console, operations and audit | Admin session cookie + CSRF + an RBAC permission point |
| `/v1/*` | Model gateway: OpenAI-compatible, Anthropic-compatible, and the Files API | Bearer token + per-user in-flight gate |
| `/updates/client/*` | Installer downloads (root path, not an API: large files with `Range` semantics) | Public |
| `/healthz`, `/readyz` | Health probes | Public |

Both business namespaces enforce a **1 MiB request body limit** (including the unauthenticated login endpoints). A few routes are explicitly exempt and apply their own limits inside the handler: archive uploads, WASM app uploads, a single chunk of the chunked upload, and the app request envelope.

The gateway is additionally mounted **without the `/v1` prefix** as the vendor-native form (`base_url` set to the server address itself): `/chat/completions`, `/completions`, `/responses`, `/messages`, `/embeddings`, `/models`, `/files*`. Authentication, rate limiting, gates and metering are identical to the `/v1` forms.

## Authentication and sessions

### Employee surface: Bearer token

| Item | Semantics |
|---|---|
| How to obtain | `POST /api/client/v2/auth/login` (local / LDAP username and password), or a browser authorization flow (OIDC / OpenID) which the client exchanges |
| How to send | Header `Authorization: Bearer <token>` |
| Lifetime | 90 days; the server stores **only the hash**, and sweeps expired rows when issuing |
| Revocation | Logout revokes the current token; password change / privilege downgrade / disable revoke all of that user's tokens in the **same transaction**; an administrator can also revoke individual tokens in the Admin Console |
| Forced password change | After an administrator resets a password, every business endpoint except password change, `/auth/me` and logout returns `403 PASSWORD_CHANGE_REQUIRED` |
| Invalid token vs server trouble | A rejected credential → `401 AUTH_FAILED` (the client clears its session and deletes the local token); an unavailable dependency (storage failure, connection pool exhaustion, statement timeout) → `500 INTERNAL` (the client keeps the token and retries). The distinction is deliberate: reporting a PG hiccup as 401 would sign every online employee out |

### Admin surface: session cookie + CSRF

| Item | Semantics |
|---|---|
| How to obtain | `POST /api/server/admin/login`; accounts with TOTP enabled get `mfa_required` and call `POST /api/server/admin/login/mfa` as the second step |
| How to send | An HttpOnly cookie (`SameSite=Lax`; `Secure` depends on the deployment protocol) |
| Lifetime | **12-hour hard TTL** + **60-minute idle sliding expiry**; the server stores only a hash of the session secret |
| CSRF | **Every non-GET/HEAD request** must carry `X-CSRF-Token`; a failed check returns `403 CSRF_EXPIRED` (a dedicated code, so the front end refreshes the token and retries once instead of showing it as "no permission") |
| RBAC | Each admin endpoint declares one permission point (`user:read`, `gateway:write`, …). Role `super_admin` has everything, `auditor` has a read-only subset, `user` has no admin access at all. Enforcement is server-side; hiding menu entries is only cosmetics |

### Error envelope and codes

A failure response is always:

```json
{ "error": { "code": "AUTH_FAILED", "message": "invalid or expired token" } }
```

| code | HTTP | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Missing authentication token / not signed in |
| `AUTH_FAILED` | 401 | Invalid or expired token / wrong credentials |
| `CSRF_EXPIRED` | 403 | CSRF check failed (non-GET on the admin surface) |
| `FORBIDDEN` | 403 | Insufficient permission (admin RBAC or role restriction) |
| `PASSWORD_CHANGE_REQUIRED` | 403 | In the forced-password-change state; business endpoints are blocked |
| `NOT_FOUND` | 404 | Resource does not exist (including strict deny-by-default for unauthorized content, which does not leak existence) |
| `VALIDATION` | 400 | Parameter validation failed |
| `RATE_LIMITED` | 429 | Rate limited, or over the per-user in-flight cap |
| `BALANCE_EXHAUSTED` | 429 | The balance gate refused, for one of three reasons: quantized balance ≤ 0, balance at or below the **learned floor** from the last settlement that failed for lack of funds while the balance did not grow, or balance below this request's **minimum charge**; it also fails closed when the balance settings cannot be read (administrators are exempt) |
| `MODEL_NOT_PRICED` | 429 | The model cannot be priced (both input and output price empty or ≤ 0, or the minimum charge quantizes to zero); an administrator can allow it with a policy switch |
| `UPSTREAM` | 502 | Upstream model error |
| `INTERNAL` | 500 | Internal error (including a temporarily unavailable dependency) |

> Unmatched routes under the `/api/` and `/v1/` prefixes (including 405) always return JSON `NOT_FOUND`; they never fall back to HTML or an empty response. API requests with a trailing slash return 404 rather than a redirect.

## Endpoints

Meaning of the "Authentication" column: **Public** = no authentication; **Bearer** = employee token; **Session** = admin session + CSRF + the listed permission point.

### Authentication (employee surface)

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| POST | `/api/client/v2/auth/login` | Public | Password sign-in (local / LDAP). Request `{username, password}`; response `{token, user, must_change_password}` |
| POST | `/api/client/v2/auth/logout` | Bearer | Revokes the current token; responds `{ok:true}` |
| GET | `/api/client/v2/auth/me` | Bearer | Current user: `{user:{id, username, display_name, email, role, permissions, status, source, password_changeable, password_must_change, mfa_enabled, balance_money, balance_activated}}` |
| POST | `/api/client/v2/auth/password` | Bearer | Self-service password change (local accounts only). **All tokens are revoked** afterwards, so the client must sign in again |
| GET | `/api/client/v2/auth/methods` | Public | Sign-in method discovery: `{methods:[{name, configured, browser, hidden}]}`. `configured` reflects the **runtime** provider registry, not merely the presence of a configuration key |
| GET | `/api/client/v2/auth/oidc/login`, `/api/client/v2/auth/oidc/callback` | Public | Browser authorization sign-in; the provider is resolved **per request** from the current auth configuration, so saving takes effect immediately |
| GET | `/api/client/v2/auth/openid/login`, `/api/client/v2/auth/openid/callback` | Public | Same, under the other namespace |

### Bootstrap and usage

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | Bearer | One-shot post-login payload: `{default_model, models[], skills[], web{}, connectors[], server_version}`. `models[]` contains only usable models under enabled providers and carries `input_modalities`; `connectors[]` are connector **definitions** (`{id, name, description, auth_mode, definition}`) with no credential values |
| GET | `/api/client/v2/auth/usage` | Bearer | Employee usage summary: `balance_money`, `balance_activated`, `balance_enabled`, `balance_monthly`, `balance_mode`, plus `today_*` / `yesterday_*` / `monthly_*` / `total_*` tokens and cost |

> There are **no session endpoints** on the server: sessions, context and approvals all live locally in the client (see [System Architecture](/en/architecture/)).

### Channel content and client delivery (public)

The sign-in page needs branding and installers **before** anyone is signed in, so this group needs no authentication.

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/client/v2/channel` | Public | Channel content: channel id, title, sign-in/client names and taglines, accent colour |
| GET / HEAD | `/api/client/v2/channel/logo` | Public | Channel logo (light variant); 404 with a JSON envelope when unset |
| GET / HEAD | `/api/client/v2/channel/logo-dark` | Public | Channel logo (dark variant); 404 when unset |
| GET / HEAD | `/api/client/v2/channel/favicon` | Public | Channel favicon; 404 when unset |
| GET | `/api/client/v2/updates/manifest` | Public | Client version manifest: `{schema:1, channel_id, server:{version}, client:{version, assets}}`; assets are keyed `mac-universal` / `win-x64` / `linux-x64`, each `{url, sha256, size}`. When no absolute https address can be produced it returns a `client_unavailable` reason. Responds `Cache-Control: no-store` |
| GET / HEAD | `/updates/client/<filename>` | Public | Installer download: extension allowlist, only regular files inside the asset directory, explicit `Content-Type` + `Content-Disposition: attachment` + `nosniff`, `Range` resume, long cache. This route alone relaxes the write deadline so slow links can finish |

### Capability Hub: skills and agents

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/client/v2/marketplace/skills` | Bearer | Marketplace skill catalogue (visible per grant) |
| GET | `/api/client/v2/marketplace/skills/:name` | Bearer | Marketplace skill detail |
| GET | `/api/client/v2/marketplace/skills/:name/archive` | Bearer | Download a marketplace skill package; response headers `X-Skill-Checksum` / `X-Skill-Version` let the client verify integrity |
| GET | `/api/client/v2/skills/builtin` | Bearer | Built-in platform skills (shipped with the server image; the client installs them on demand) |
| GET | `/api/client/v2/skills/builtin/:name/archive` | Bearer | Download a built-in skill package |
| GET | `/api/client/v2/shared-skills` | Bearer | Organization shared skills: approved and granted content, plus everything you uploaded with its status |
| POST | `/api/client/v2/shared-skills` | Bearer | Upload a shared skill (base64 archive with a top-level `SKILL.md`); it enters review |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | Bearer | Download a shared skill package |
| GET | `/api/client/v2/agent-presets` | Bearer | Organization shared agents (same visibility rules as shared skills) |
| POST | `/api/client/v2/agent-presets` | Bearer | Upload a shared agent (with a top-level `agent.cordis.yml`) |
| GET | `/api/client/v2/agent-presets/:name/archive`, `/api/client/v2/agent-presets/:name/:version/archive` | Bearer | Download a shared agent package (latest / specific version) |
| GET | `/api/client/v2/capabilities` | Bearer | Unified Capability Hub catalogue; query parameters `source=own\|market\|org`, `type=`, `q=`. Marketplace and organization rows merge into one authoritative row (marketplace wins) |
| POST | `/api/client/v2/telemetry/skill-call` | Bearer | Report a skill invocation (counter, rate limit configurable) |
| POST | `/api/client/v2/telemetry/error-reporting` | Bearer | The client reports the outcome of its own error-reporting setup; unknown states are accepted silently and not stored |

> Shared content uses a **double gate**: approved **and** granted (grants target a user or a department). Unauthorized content is always 404 and does not leak existence; administrators always see everything.

### Connectors

The employee surface receives connector **definitions** through bootstrap; credentials are collected and encrypted locally by the client per user scope, and the server neither receives nor delivers credential values. Creating, editing and enabling connectors all happen on the admin surface.

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | Bearer | The single source of the connector catalogue (see `connectors[]` above) |

### App centre (WASM apps, employee surface)

Apps open only inside the desktop client: the client wraps requests to `<app origin scheme>://<app_id>/…` in an envelope and sends it to the single entry point.

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/client/v2/apps/wasm/catalog` | Bearer | App catalogue: filters only "not deleted / not frozen / has an effective version" and delivers `access` and `enabled` (unlisted apps stay visible but are marked) |
| POST | `/api/client/v2/apps/wasm/validate` | Bearer | Validate a `.wasm` artifact (no publish, no version reservation, no upload quota consumed) and return a structured verdict |
| POST | `/api/client/v2/apps/wasm/:app_id/releases` | Bearer | Publish a new version (single-shot path); it goes live or becomes pending according to the admin review switch |
| POST | `/api/client/v2/apps/wasm/uploads` | Bearer | Chunked upload: open a session and return an `upload_id` |
| PUT | `/api/client/v2/apps/wasm/uploads/:upload_id/chunks/:index` | Bearer | Upload chunk `index` (`application/octet-stream`, per-chunk cap) |
| GET | `/api/client/v2/apps/wasm/uploads/:upload_id` | Bearer | Resume query: which chunks have been received |
| POST | `/api/client/v2/apps/wasm/uploads/:upload_id/complete` | Bearer | Assemble and run the publish path; the client may declare its budget for this hop in a request header, and the platform may only shrink it, never enlarge it |
| DELETE | `/api/client/v2/apps/wasm/uploads/:upload_id` | Bearer | Abandon the upload and reclaim disk |
| POST | `/api/client/v2/apps/wasm/:app_id/request` | Bearer | **The single entry point for app execution**: the app request envelope is decoded and executed here, with identity injected by the client |
| POST | `/api/client/v2/apps/wasm/proof` | Bearer | Issue a proof of possession binding "which employee + which token + which app" |
| POST | `/api/client/v2/apps/wasm/:app_id/open` | Bearer | Open validation and counting; response header `X-PicoAide-App-Version` is the sole source of the client's content cache key |
| GET | `/api/client/v2/apps/wasm/:app_id/availability` | Bearer | Identifier availability pre-check (read-only: no compile, no version reservation) |
| GET | `/api/client/v2/apps/wasm/:app_id/releases` | Bearer | The publisher's own version history and review verdicts (including rejection reasons). Non-publishers always get 404, byte-identical to "app does not exist" |
| POST | `/api/client/v2/apps/wasm/:app_id/publish`, `/api/client/v2/apps/wasm/:app_id/unpublish` | Bearer | List / unlist (by the publisher) |
| POST | `/api/client/v2/apps/wasm/:app_id/freeze` | Bearer | Freeze |
| GET | `/api/client/v2/apps/wasm/:app_id/diagnostics` | Bearer | Runtime diagnostics (publisher only) |
| GET | `/api/client/v2/apps/wasm/:app_id/schema` | Bearer | The app database's tables, columns, row counts and size (no row values) |
| GET | `/api/client/v2/apps/wasm/:app_id/rows` | Bearer | Read-only row browsing of the app database (publisher only; masked by default, and fetching raw values writes a different audit action) |
| GET | `/api/client/v2/apps/wasm/:app_id/export` | Bearer | Export the app |
| DELETE | `/api/client/v2/apps/wasm/:app_id` | Bearer | Delete the app |

### Admin surface: authentication and sessions

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| POST | `/api/server/admin/login` | Public | Administrator sign-in. Response `{csrf_token, user, must_change_password}`; with TOTP enabled it returns `{mfa_required:true, mfa_ticket}` |
| POST | `/api/server/admin/login/mfa` | Public | Second factor step: `{mfa_ticket, code}` |
| GET | `/api/server/admin/auth/methods` | Public | Sign-in method discovery; uses the **same** decision as the employee surface, so one server never tells two stories |
| GET | `/api/server/admin/me` | Session | Current administrator plus the current session's CSRF token (so a page refresh can continue without signing in again) |
| POST | `/api/server/admin/logout` | Session | Sign out |
| POST | `/api/server/admin/me/password` | Session | Change your own password (old password + TOTP code; success revokes all sessions) |
| GET | `/api/server/admin/me/mfa` | Session | Your own MFA state |
| POST | `/api/server/admin/me/mfa/enable`, `/me/mfa/verify`, `/me/mfa/disable` | Session | Enable / verify / disable TOTP; disabling requires both the master password and a valid code |

### Admin surface: users and departments

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/server/admin/users` | Session + `user:read` | User list (role, status, balance, password-change and MFA markers) |
| POST | `/api/server/admin/users` | Session + `user:write` | Create a user |
| PUT | `/api/server/admin/users/:id` | Session + `user:write` | Update a user (role, status, display name, email, password reset). Quota fields in the body were retired and are ignored |
| DELETE | `/api/server/admin/users/:id` | Session + `user:write` | Delete a user |
| PUT | `/api/server/admin/users/:id/mfa` | Session + `user:write` | Reset someone else's MFA (not your own; revokes all their sessions) |
| GET | `/api/server/admin/users/:id/groups` | Session + `user:read` | The user's departments |
| PUT | `/api/server/admin/users/:id/department` | Session + `dept:write` | Set department membership (`group_ids` array; multiple departments supported) |
| GET | `/api/server/admin/departments` | Session + `dept:read` | Department tree |
| POST | `/api/server/admin/departments` | Session + `dept:write` | Create a department |
| PUT | `/api/server/admin/departments/:id` | Session + `dept:write` | Update a department |
| DELETE | `/api/server/admin/departments/:id` | Session + `dept:write` | Delete a department |
| GET | `/api/server/admin/users/:id/tokens` | Session + `user:read` | That user's sign-in tokens |
| POST | `/api/server/admin/tokens/:id/revoke` | Session + `user:write` | Revoke a specific token |

### Admin surface: balance and usage

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| POST | `/api/server/admin/users/:id/balance` | Session + `user:write` | Adjust an employee's balance (add / subtract / set); audited |
| GET | `/api/server/admin/users/:id/balance/ledger` | Session + `user:read` | That user's balance ledger |
| GET | `/api/server/admin/balance` | Session + `user:read` | Balance gate and monthly grant configuration |
| PUT | `/api/server/admin/balance` | Session + `user:write` | Update balance configuration |
| POST | `/api/server/admin/balance/grant` | Session + `user:write` | Trigger a grant manually (idempotent across instances and restarts) |
| GET | `/api/server/admin/usage` | Session + `usage:read` | Usage summary |
| GET | `/api/server/admin/usage/overview` | Session + `usage:read` | Usage centre overview (daily trend, departments, members, models) |
| GET | `/api/server/admin/usage/requests` | Session + `usage:read` | Request-level detail (paginated, bounded window) |
| GET | `/api/server/admin/report-subscriptions` | Session + `report:read` | Usage report subscriptions. **The list contains webhook credentials**, so it uses a dedicated permission point and read-only auditors do not get it by default |
| POST | `/api/server/admin/report-subscriptions` | Session + `report:write` | Create a subscription |
| PUT / DELETE | `/api/server/admin/report-subscriptions/:id` | Session + `report:write` | Update / delete a subscription |
| POST | `/api/server/admin/report-subscriptions/:id/test` | Session + `report:write` | Send a test push |

### Admin surface: authentication configuration

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/server/admin/auth` | Session + `auth:read` | Authentication configuration (sensitive fields masked) |
| PUT | `/api/server/admin/auth` | Session + `auth:write` | Save authentication configuration (including client secret). Takes effect immediately, no restart |
| POST | `/api/server/admin/auth/test` | Session + `auth:write` | Connectivity test (LDAP directory statistics / OIDC discovery document) |

### Admin surface: gateway and models

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/server/admin/providers` | Session + `gateway:read` | Upstream provider list |
| POST | `/api/server/admin/providers` | Session + `gateway:write` | Create a provider (API key stored encrypted) |
| PUT / DELETE | `/api/server/admin/providers/:id` | Session + `gateway:write` | Update / delete a provider |
| GET | `/api/server/admin/providers/:id/balance` | Session + `gateway:read` | Upstream account balance (when the vendor supports it) |
| POST | `/api/server/admin/providers/:id/sync`, `/api/server/admin/providers/sync-all` | Session + `gateway:write` | Sync the model catalogue from upstream (disable instead of delete, so pricing survives) |
| GET | `/api/server/admin/models` | Session + `gateway:read` | Model list (pricing, cache price, off-peak discount, input modalities) |
| POST | `/api/server/admin/models` | Session + `gateway:write` | Create a model |
| PUT / DELETE | `/api/server/admin/models/:id` | Session + `gateway:write` | Update / delete a model |
| GET | `/api/server/admin/gateway` | Session + `gateway:read` | Gateway configuration (default model, rate limits, peak windows, usage policy, unpriced-model policy) |
| PUT | `/api/server/admin/gateway` | Session + `gateway:write` | Update gateway configuration; price and window changes only affect costs recorded afterwards |
| GET | `/api/server/admin/gateway/files` | Session + `gateway:read` | Files API ownership ledger: usage per employee, search and sort |
| GET | `/api/server/admin/gateway/files/summary` | Session + `gateway:read` | Ledger summary |
| DELETE | `/api/server/admin/gateway/files/:file_id` | Session + `gateway:write` | Delete a single upstream file |
| POST | `/api/server/admin/gateway/files/purge` | Session + `gateway:write` | Bulk cleanup |
| POST | `/api/server/admin/gateway/error-reporting/test` | Session + `gateway:write` | The server sends one test event (to verify the error-tracking path) |
| GET | `/api/server/admin/gateway/error-reporting/clients` | Session + `gateway:read` | Aggregated client reporting state (N enabled / M failed) |
| GET | `/api/server/admin/channels` | Session + `gateway:read` | Channel list (read-only diagnostics; channel content is injected at build time and cannot be edited online) |
| GET | `/api/server/admin/concurrency` | Session + `gateway:read` | Per-model concurrency: current, historical peak, target |

### Admin surface: Capability Hub and approvals

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/server/admin/capabilities/approvals` | Session + `capability:read` | Unified Capability Hub approval queue (read-only; actions go through each domain's own endpoints) |
| GET | `/api/server/admin/skills` | Session + `market:read` | Marketplace skill list |
| POST | `/api/server/admin/skills` | Session + `market:write` | Create a marketplace skill |
| POST | `/api/server/admin/skills/:name/archive` | Session + `market:write` | Upload a skill archive (new version) |
| GET | `/api/server/admin/skills/:name/archive` | Session + `market:read` | Download a skill archive |
| PUT / DELETE | `/api/server/admin/skills/:name` | Session + `market:write` | Update / delete a marketplace skill |
| POST | `/api/server/admin/skills/:name/enable` | Session + `market:write` | List / unlist |
| POST | `/api/server/admin/skills/:name/normalize` | Session + `market:write` | Normalize a skill archive |
| GET | `/api/server/admin/skills/:name/preview`, `/skills/:name/file` | Session + `market:read` | Preview / read one file's content |
| GET | `/api/server/admin/skills/builtin` | Session + `capability:read` | Built-in platform skills (read-only diagnostics; the path sits beside `/skills/:name` and the static segment wins) |
| GET / PUT | `/api/server/admin/skills/:name/grants` | Session + `market:read` / `market:write` | List / replace all grants |
| PUT / DELETE | `/api/server/admin/skills/:name/grant` | Session + `market:write` | Add / remove one grant |
| GET | `/api/server/admin/agents` | Session + `market:read` | Marketplace agent list |
| POST | `/api/server/admin/agents` | Session + `market:write` | Create a marketplace agent |
| POST | `/api/server/admin/agents/:name/archive` | Session + `market:write` | Upload an agent archive |
| GET | `/api/server/admin/agents/:name/archive` | Session + `market:read` | Download an agent archive |
| PUT / DELETE | `/api/server/admin/agents/:name` | Session + `market:write` | Update / delete |
| POST | `/api/server/admin/agents/:name/enable` | Session + `market:write` | List / unlist |
| GET | `/api/server/admin/agents/:name/preview`, `/agents/:name/file` | Session + `market:read` | Preview / read file content |
| GET / PUT | `/api/server/admin/agents/:name/grants` | Session + `market:read` / `market:write` | List / replace all grants |
| PUT / DELETE | `/api/server/admin/agents/:name/grant` | Session + `market:write` | Add / remove one grant |
| GET | `/api/server/admin/shared-skills` | Session + `capability:read` | All organization shared skills (including pending) |
| GET | `/api/server/admin/shared-skills/:name/:version/archive`, `/preview`, `/file` | Session + `capability:read` | Download / preview / read file |
| POST | `/api/server/admin/shared-skills/:name/:version/approve`, `/reject` | Session + `capability:write` | Approve / reject (rejection requires a reason) |
| DELETE | `/api/server/admin/shared-skills/:name/:version` | Session + `capability:write` | Delete one version |
| PUT | `/api/server/admin/shared-skills/:name/:version/quality` | Session + `capability:write` | Set the quality badge (official / featured) |
| PUT | `/api/server/admin/shared-skills/:name/enabled` | Session + `capability:write` | List / unlist an organization shared skill |
| GET / PUT | `/api/server/admin/shared-skills/:name/grants` | Session + `capability:read` / `capability:write` | List / replace all grants |
| PUT / DELETE | `/api/server/admin/shared-skills/:name/grant` | Session + `capability:write` | Add / remove one grant |
| GET | `/api/server/admin/agent-presets` | Session + `capability:read` | All organization shared agents |
| GET | `/api/server/admin/agent-presets/:name/archive`, `/:name/preview`, `/:name/:version/archive`, `/:name/:version/preview`, `/:name/:version/file` | Session + `capability:read` | Download / preview / read file |
| POST | `/api/server/admin/agent-presets/:name/approve`, `/reject`, `/:name/:version/approve`, `/:name/:version/reject` | Session + `capability:write` | Approve / reject |
| DELETE | `/api/server/admin/agent-presets/:name`, `/:name/:version` | Session + `capability:write` | Delete an agent / one version |
| PUT | `/api/server/admin/agent-presets/:name/:version/quality` | Session + `capability:write` | Set the quality badge |
| PUT | `/api/server/admin/agent-presets/:name/enabled` | Session + `capability:write` | List / unlist an organization shared agent |
| GET / PUT | `/api/server/admin/agent-presets/:name/grants` | Session + `capability:read` / `capability:write` | List / replace all grants |
| PUT / DELETE | `/api/server/admin/agent-presets/:name/grant` | Session + `capability:write` | Add / remove one grant |
| GET | `/api/server/admin/capability-locks` | Session + `capability:read` | Capability lock list (names only administrators may publish; names that do not exist yet can be pre-locked) |
| PUT / DELETE | `/api/server/admin/capability-locks/:kind/:name` | Session + `capability:write` | Add / remove a lock |
| PUT | `/api/server/admin/apps/:kind/:app_id/owner` | Session + `capability:write` | Transfer capability ownership. Ownership is app-level and version-independent, hence the `apps` base path |

### Admin surface: connectors, portal and server information

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/server/admin/connectors` | Session + `connector:read` | Connector catalogue (definition, auth mode, enabled state) |
| GET | `/api/server/admin/connectors/:id` | Session + `connector:read` | A single connector |
| POST | `/api/server/admin/connectors` | Session + `connector:write` | Create. The server normalizes input into a canonical definition on the write path (including credential-field shape validation) |
| PUT / DELETE | `/api/server/admin/connectors/:id` | Session + `connector:write` | Update / delete |
| PUT | `/api/server/admin/connectors/:id/enabled` | Session + `connector:write` | Delivery switch |
| GET | `/api/server/admin/portal` | Session + `portal:read` | Portal configuration (public or not, download-URL overrides, note text). **Brand names and copy are not here** — they come from channel content |
| PUT | `/api/server/admin/portal` | Session + `portal:write` | Update portal configuration |
| GET | `/api/server/admin/server-info` | Session + `server-info:read` | Server information: version and update hints, database and migrations, model concurrency, error-monitoring configuration |

### Admin surface: audit

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/server/admin/audit` | Session + `audit:read` | Audit log (hash chain, tamper-evident) |
| GET | `/api/server/admin/audit/settings` | Session + `audit:read` | Audit retention policy |
| PUT | `/api/server/admin/audit/settings` | Session + `audit:retention:write` | Change the retention policy (super admin only) |

### Admin surface: app platform (WASM)

Mounted under `/api/server/admin/wasm-apps`. Read endpoints use `capability:read`, write endpoints use `capability:write`.

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| GET | `/api/server/admin/wasm-apps` | Session + `capability:read` | App list |
| POST | `/api/server/admin/wasm-apps/:app_id/publish`, `/unpublish` | Session + `capability:write` | List / unlist as an administrator (symmetric with the publisher's own listing) |
| POST | `/api/server/admin/wasm-apps/:app_id/freeze` | Session + `capability:write` | Freeze |
| PUT | `/api/server/admin/wasm-apps/:app_id/owner` | Session + `capability:write` | Transfer ownership |
| GET | `/api/server/admin/wasm-apps/:app_id/releases` | Session + `capability:read` | That app's versions and review queue |
| POST | `/api/server/admin/wasm-apps/:app_id/releases/:version/approve`, `/reject` | Session + `capability:write` | Approve or reject a version |
| PUT | `/api/server/admin/wasm-apps/review` | Session + `capability:write` | Master switch for publish review |
| GET / PUT | `/api/server/admin/wasm-apps/limits` | Session + `capability:read` / `capability:write` | Platform limits (concurrency, instance memory, time budgets). Most take effect immediately; instance memory needs a restart |
| GET | `/api/server/admin/wasm-apps/runtime` | Session + `capability:read` | Platform-wide runtime watermarks: compile queue and cache, execution slots, dropped call-event counters, free disk |
| GET | `/api/server/admin/wasm-apps/:app_id/diagnostics` | Session + `capability:read` | App diagnostics (an administrator troubleshooting exit) |
| GET | `/api/server/admin/wasm-apps/:app_id/schema`, `/rows` | Session + `capability:read` | App database schema and row browsing (same implementation as the employee surface; the differences are authentication and whose account lands in the audit log) |
| GET | `/api/server/admin/wasm-apps/:app_id/opens` | Session + `capability:read` | App open counts (long-lived daily rollups plus detail) |
| GET | `/api/server/admin/wasm-apps/opens/summary` | Session + `capability:read` | Operations dashboard summary (a static segment, more specific than `/:app_id/opens`, so it matches first) |
| GET | `/api/server/admin/wasm-apps/:app_id/ai-usage` | Session + `capability:read` | Per-app AI usage |

### Model gateway (`/v1/*`)

| Method | Path | Authentication | Purpose and key fields |
|---|---|---|---|
| POST | `/v1/chat/completions` | Bearer + in-flight gate | OpenAI-compatible chat (`stream` optional) |
| POST | `/v1/embeddings` | Bearer + in-flight gate | Embeddings |
| POST | `/v1/completions` | Bearer + in-flight gate | Completions |
| POST | `/v1/responses` | Bearer + in-flight gate | Compatible form (usage parsing accepts both field namings) |
| POST | `/v1/messages` | Bearer + in-flight gate | Anthropic Messages compatible |
| GET | `/v1/models` | Bearer + in-flight gate | Available models (only enabled providers, catalogue entries not missing, with input modalities) |
| POST | `/v1/files` | Bearer + in-flight gate | Upload a file, returns a `file_id` |
| GET | `/v1/files` | Bearer + in-flight gate | List files |
| GET | `/v1/files/:file_id` | Bearer + in-flight gate | Retrieve file metadata |
| DELETE | `/v1/files/:file_id` | Bearer + in-flight gate | Delete a file |

> `Authorization: Bearer` is the only authentication method. The native variants without the `/v1` prefix (`/chat/completions`, `/completions`, `/responses`, `/messages`, `/embeddings`, `/models`, `/files*`) are mounted as well and behave identically.

### Portal and health probes

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| GET | `/`, `/portal` | Public | Portal home: channel branding plus download entries for the three platforms (plain HTML, no scripts) |
| GET | `/admin/` | Public (the page itself then requires sign-in) | Admin Console SPA (build output embedded in the server binary) |
| GET | `/healthz` | Public | Health probe: JSON with database connectivity; 503 when the database is unavailable |
| GET | `/readyz` | Public | Readiness probe: beyond health it reports free disk, execution and compile queue watermarks, and the retention-cleanup facts. Because the endpoint is unauthenticated it returns short phrases only; detail goes to the server log |

## Version and compatibility commitments

**Stable contract** (safe to depend on):

- The namespace split: `/api/client/v2/*` is the employee surface, `/api/server/admin/*` is the admin surface, `/v1/*` is the model gateway;
- Authentication mechanics and token semantics (where Bearer goes, the admin CSRF header name `X-CSRF-Token`);
- The error envelope `{"error":{"code","message"}}` and the code set in the table above;
- The update manifest's `schema` / `channel_id` / `assets[].url|sha256|size` shape — it is the upgrade contract between the client and the update server;
- The OpenAI / Anthropic compatible forms under `/v1/*`.

**May change**:

- Request and response fields of admin endpoints. The Admin Console ships **in the same version** as the server and evolves with it; third parties integrating directly with the admin surface must align by version;
- Added fields are backward compatible (clients ignore unknown fields); changing the meaning of an existing field is a behaviour change and is recorded in the release notes;
- `bootstrap.server_version` is a **diagnostic/provenance** field with no client consumer today — it is not the source of any version-mismatch prompt (version checks use the update manifest).

**Retired — do not use**:

- The old namespaces `/api/*` (historical admin and employee routes), `/v2/api/*` and `/v2/v1/*`. Today's `/v1/*` is the model gateway, not the old admin surface;
- The employee browser session and one-time ticket exchange: `/login`, `/logout` and `/app-ticket` were removed wholesale together with "apps open only inside the desktop client";
- The old branding and portal endpoints `/api/client/v2/brand` and `/api/client/v2/portal`: branding and portal content now come from `/api/client/v2/channel` and the portal HTML;
- Employee-side token quota, money quota and department budget request fields: the balance is the single billing gate, and those fields in a request body are ignored.

**Known not implemented** (differences from the vendor's model API documentation; integrating per that documentation will fail):

- The `/beta` prefix (prefix continuation and FIM) is not implemented;
- Anthropic-compatible `/anthropic/v1/*` and `x-api-key` authentication are not implemented (`/v1/messages` uses Bearer);
- `GET /user/balance` (key holder's view) is not implemented; only the admin `providers/:id/balance` exists;
- A vendor 429 means "account-level concurrency cap", while this product's 429 means insufficient balance or a local rate limit — different semantics.

> API requests with a trailing slash return 404 JSON rather than a 307 redirect: predictable semantics, consistent with how the body limit is applied.

## Related

- [System Architecture](/en/architecture/) — the three layers, assembly, data layout and extension points
- [Admin Console](/en/admin/) — the pages corresponding to these admin endpoints
- [Desktop Client](/en/desktop/) — employee-facing features and when these endpoints are called
- [Private Deployment](/en/deployment/) — ports, certificates and reverse-proxy notes
