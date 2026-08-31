---
title: API Reference
description: 'PicoAide Harness server HTTP API reference: auth, LLM gateway, marketplace and shared content, Capability Hub, brand/portal, and admin endpoints.'
---

> This page is a public summary of the server HTTP interface. All endpoints follow the code (`server/internal/router` is the single source of truth). Errors use the unified envelope `{"error":{"code":"ERR_CODE","message":"..."}}`.

**Namespaces**:
- `/api/server/*` — admin surface (webadmin / ops / audit; session + CSRF + RBAC)
- `/api/client/v2/*` — client employee surface (enterprise client and third-party integrations; Bearer)
- `/v1/*` — LLM gateway (OpenAI / Anthropic compatible; Bearer; official native variants without `/v1` also mounted)

## Error codes

| code | HTTP | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Missing auth token |
| `AUTH_FAILED` | 401 | Invalid/expired token or bad credentials |
| `FORBIDDEN` | 403 | Insufficient permission (admin) |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION` | 400 | Parameter validation failed |
| `UPSTREAM` | 502 | Upstream LLM error |
| `RATE_LIMITED` | 429 | Rate limit triggered |
| `QUOTA_EXCEEDED` | 429 | Employee token/money quota or department budget exceeded (admins exempt) |
| `INTERNAL` | 500 | Internal error |

## Auth (employee surface)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/client/v2/auth/login` | Password login (local / LDAP): `{username, password}` → `{token}` |
| POST | `/api/client/v2/auth/logout` | Revoke the current token |
| GET | `/api/client/v2/auth/me` | Current user (incl. `role` / `permissions`) |
| GET | `/api/client/v2/auth/usage` | Usage overview: balance, today/yesterday/month/total tokens + cost, department budget chain |
| GET | `/api/client/v2/auth/methods` | Login-method discovery (public) |
| GET | `/api/client/v2/auth/:provider/login` `/callback` | OIDC / OpenID browser authorization (provider configured server-side) |

## LLM gateway (`/v1/*`, Bearer)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible chat proxy (stream optional) |
| POST | `/v1/embeddings` | Embeddings |
| POST | `/v1/completions` / `/v1/responses` | Native/compatible shapes |
| POST | `/v1/messages` | Anthropic Messages compatible (0043, web_search server-side proxy) |
| GET | `/v1/models` | Available models (enabled providers only) |

> Official native variants without `/v1` are also mounted (use `base_url=server`); auth / rate limit / quota / metering match `/v1/chat/completions`.

## Bootstrap

| Method | Path | Notes |
|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | Post-login bundle: `{default_model, models, skills, web, connectors}` |

## Brand and portal (public)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/client/v2/brand` | Login-page / client brand config (logo, name, welcome) |
| GET/HEAD | `/api/client/v2/brand/logo/:name` | Logo files (`login` / `client` / `favicon`) |
| GET | `/api/client/v2/portal` | Portal config (welcome + three-platform client download links) |

## Marketplace and shared content (employee surface)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/client/v2/marketplace/skills` | Skill catalog (grant-visible) |
| GET | `/api/client/v2/marketplace/skills/:name/archive` | Download a skill package (`X-Skill-Version` / `X-Skill-Checksum`) |
| GET | `/api/client/v2/shared-skills` | Shared skills (approved + granted, plus your own uploads in any state) |
| POST | `/api/client/v2/shared-skills` | Upload a shared skill (base64 archive, ≤16MB, top-level `SKILL.md`), stored in DB |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | Download a shared skill package |
| GET | `/api/client/v2/agent-presets` | Shared agents (same two-gate model) |
| POST | `/api/client/v2/agent-presets` | Upload a shared agent (top-level `agent.cordis.yml`) |
| GET | `/api/client/v2/agent-presets/:name/:version/archive` | Download a shared agent package |
| GET | `/api/client/v2/capabilities?source=market|org&type=&q=` | Capability Hub unified catalog: market + org merged |
| POST | `/api/client/v2/telemetry/skill-call` | Report a skill call (increments `calls`) |

> Shared-content visibility = **approved + granted** (user/department) two-gate model; admins always full access; unauthorized 404 without leaking existence.

## Admin (`/api/server/admin/*`, session + CSRF + RBAC)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/server/admin/login` | Admin login (`super_admin` / `auditor`; `user` → 403) |
| GET | `/api/server/admin/me` `/logout` | Current admin / sign out |
| GET/POST/PUT/DELETE | `/users` `/departments` | User and department CRUD (quotas, roles, department budgets) |
| GET | `/usage` `/server-info` `/audit` | Usage summary / server info / audit logs |
| GET/POST/PUT/DELETE | `/providers` `/models` `/gateway` | Gateway providers, models (pricing/cache price/off-peak discount), gateway config |
| GET/POST/PUT | `/skills` `/:name/archive` `/:name/grants` | Marketplace management (publish / upload archive / grants) |
| GET/POST | `/shared-skills/*` `/agent-presets/*` | Shared-content review (approve / reject / delete / quality / grants) |
| GET | `/capabilities/approvals` | Capability Hub unified approval queue (read-only; actions via domain endpoints) |
| GET/PUT | `/brand` `/portal` | Brand and portal config (logo upload, snapshot restore) |
| GET/PUT | `/connectors` | Connector catalog management |
| GET | `/channels` | Channel list |

## Other

| Path | Notes |
|---|---|
| `/`、`/portal` | Portal home (brand + client downloads; product HTML) |
| `/admin/` | webadmin SPA |
| `/healthz` | Health probe (JSON, DB ping; 503 = DB unavailable) |

> Endpoints and full field docs not listed here live in the repository at `server/docs/03-api-reference.md`.
