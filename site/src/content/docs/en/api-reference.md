---
title: API Reference
description: 'PicoAide Harness server HTTP API reference: auth, LLM gateway, bootstrap config, channel content and client delivery, marketplace and shared content, and admin endpoints.'
---

> This page is a public summary of the server HTTP interface. All endpoints follow the code (`server/internal/router` is the single source of truth). Failures return the unified error envelope `{"error":{"code":"ERR_CODE","message":"..."}}`; except for the product HTML surfaces (portal, Admin Console) and file downloads, every endpoint returns JSON.

**Namespaces**:

- `/api/server/*` — admin surface (webadmin / ops / audit; session + CSRF + RBAC)
- `/api/client/v2/*` — client employee surface (enterprise client and third-party integrations; Bearer)
- `/v1/*` — LLM gateway (OpenAI / Anthropic compatible; Bearer; official native variants without `/v1` also mounted)
- `/updates/client/*` — client installer downloads (root path, not an API: large files + `Range` semantics)

## Error codes

| code | HTTP | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Missing auth token |
| `AUTH_FAILED` | 401 | Invalid/expired token or bad credentials |
| `FORBIDDEN` | 403 | Insufficient permission (admin) |
| `NOT_FOUND` | 404 | Resource not found (including strict default-deny, where unauthorized means invisible) |
| `VALIDATION` | 400 | Parameter validation failed |
| `UPSTREAM` | 502 | Upstream LLM error |
| `RATE_LIMITED` | 429 | Rate limit triggered |
| `QUOTA_EXCEEDED` | 429 | Monthly token/money quota, department budget or balance insufficient (admins exempt) |
| `INTERNAL` | 500 | Internal error |

## Auth (employee surface)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/client/v2/auth/login` | Password login (local / LDAP): `{username, password}` → `{token}` |
| POST | `/api/client/v2/auth/logout` | Revoke the current token |
| GET | `/api/client/v2/auth/me` | Current user (incl. `role` / `permissions`) |
| GET | `/api/client/v2/auth/usage` | Usage overview: balance, today/yesterday/month/total tokens + cost, department budget chain |
| POST | `/api/client/v2/auth/password` | Employee self-service password change (local users; all tokens are revoked afterwards and the user must log in again) |
| GET | `/api/client/v2/auth/methods` | Login-method discovery (public) |
| GET | `/api/client/v2/auth/oidc/login` `/callback` (same for OpenID) | Browser authorization login; the provider is resolved from the auth configuration at request time, so saving takes effect immediately |

## LLM gateway (`/v1/*`, Bearer)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible chat proxy (stream optional) |
| POST | `/v1/embeddings` | Embeddings |
| POST | `/v1/completions` / `/v1/responses` | Native/compatible shapes |
| POST | `/v1/messages` | Anthropic Messages compatible (web_search server-side proxy) |
| GET | `/v1/models` | Available models (enabled providers only, including input modalities) |

> Official native variants without `/v1` are also mounted (use `base_url=server`); auth / rate limit / quota / metering match `/v1/chat/completions`.

## Bootstrap

| Method | Path | Notes |
|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | Post-login bundle: `{default_model, models, skills, web, connectors}` |

## Channel content and client delivery (public)

The client login page needs the brand and the installer before anyone has logged in, so this group requires no authentication:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/client/v2/channel` | Channel content: channel id, title, login-page/client names and taglines, accent color |
| GET/HEAD | `/api/client/v2/channel/logo` | Channel logo (light variant) |
| GET/HEAD | `/api/client/v2/channel/logo-dark` | Channel logo (dark variant) |
| GET/HEAD | `/api/client/v2/channel/favicon` | Channel favicon |
| GET | `/api/client/v2/updates/manifest` | Client version manifest: `{schema, channel_id, server:{version}, client:{version, assets}}`; returns a `client_unavailable` reason when it cannot provide an absolute https address |
| GET/HEAD | `/updates/client/<filename>` | Installer download (extension whitelist; `Range` resume; long cache) |
| GET | `/` `/portal` | Portal home (plain HTML, no scripts): brand + three-platform download entries |

> The client upgrades from this: the manifest `channel_id` must match the server, the installer address must be absolute https, and the download is verified against the SHA-256 in the manifest.

## Marketplace and shared content (employee surface)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/client/v2/marketplace/skills` | Skill catalog (grant-visible) |
| GET | `/api/client/v2/marketplace/skills/:name` `/:name/archive` | Skill detail / download a skill package |
| GET | `/api/client/v2/shared-skills` | Shared skills (approved + granted, plus your own uploads in any state) |
| POST | `/api/client/v2/shared-skills` | Upload a shared skill (base64 archive, ≤16MB, top-level `SKILL.md`), stored in DB |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | Download a shared skill package |
| GET | `/api/client/v2/agent-presets` | Shared agents (same two-gate model) |
| POST | `/api/client/v2/agent-presets` | Upload a shared agent (top-level `agent.cordis.yml`) |
| GET | `/api/client/v2/agent-presets/:name/archive` `/:name/:version/archive` | Download a shared agent package |
| GET | `/api/client/v2/capabilities?source=market\|org&type=&q=` | Capability Hub unified catalog: market + org merged |
| POST | `/api/client/v2/telemetry/skill-call` | Report a skill call (increments `calls`; rate limit configurable) |

> Shared-content visibility = **approved + granted** (user/department) two-gate model; admins always full access; unauthorized 404 without leaking existence.

## Admin (`/api/server/admin/*`, session + CSRF + RBAC)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/server/admin/login` | Admin login (`super_admin` / `auditor`; `user` → 403) |
| GET | `/me` `/logout` | Current admin / sign out |
| POST | `/me/password` | Change your own password (revokes all sessions) |
| GET/POST | `/me/mfa` `/me/mfa/enable` `/me/mfa/verify` `/me/mfa/disable` | Admin TOTP codes (view / enable / verify / disable) |
| GET/POST/PUT/DELETE | `/users` `/users/:id` | User CRUD (quota, role, status, reset password, reset MFA) |
| PUT | `/users/:id/department` | Set department membership (`group_ids` array, multi-department supported) |
| GET/POST/PUT/DELETE | `/departments` `/departments/:id` | Department tree and budgets |
| POST | `/users/:id/balance` | Employee balance adjustment (add / deduct / set, audited) |
| GET/PUT/POST | `/balance` `/balance/grant` | Balance gate and monthly grant configuration / manual grant (idempotent) |
| GET | `/users/:id/tokens`, POST `/tokens/:id/revoke` | View and revoke login tokens |
| GET | `/usage` `/usage/overview` `/usage/requests` | Usage summary / overview / detail (paged, 90-day window cap) |
| GET/POST/PUT/DELETE | `/report-subscriptions` `/:id` `/:id/test` | Usage report subscriptions and test push |
| GET | `/server-info` `/concurrency` `/audit` `/audit/settings` | Server info / model concurrency / audit log / audit retention policy |
| GET/PUT/POST | `/auth` `/auth/test` | Auth configuration and connectivity test (LDAP directory statistics / OIDC discovery document) |
| GET/POST/PUT/DELETE | `/providers` `/providers/:id` `/models` `/gateway` | Gateway providers, models (pricing / cache price / off-peak discount / input modalities), gateway config |
| GET | `/providers/:id/balance` `/channels` | Upstream account balance (where supported) / channel list |
| GET/POST/PUT/DELETE | `/skills` `/agents` and their archive and grant endpoints | Skill marketplace and agent catalog management |
| GET/POST | `/shared-skills/*` `/agent-presets/*` | Shared-content review (approve / reject / delete / quality / grants) |
| GET | `/capabilities/approvals` | Capability Hub unified approval queue (read-only; actions via domain endpoints) |
| PUT | `/apps/:kind/:app_id/owner` | Transfer capability ownership (owner) |
| GET/PUT | `/portal` | Portal page configuration (whether it is public, download URL overrides, description text) |
| GET/PUT | `/connectors` | Connector catalog management |

## Other

| Path | Notes |
|---|---|
| `/` `/portal` | Portal home (product HTML surface, plain HTML + CSS) |
| `/admin/` | webadmin SPA (embedded via go:embed) |
| `/healthz` | Health probe (JSON, DB ping; 503 = DB unavailable) |

> Endpoints and full field docs not listed here live in the repository at `server/docs/03-api-reference.md`.
