---
title: System Architecture
description: 'PicoAide Harness system architecture: client/server layering, the LLM gateway and metering, quota tiers, and security design.'
---

PicoAide Harness is a platform combining a **desktop client** and an **enterprise server**. This page is the architecture overview for administrators and integrators; the full endpoint list is in [API Reference](/en/api-reference/), and public interfaces follow the actual code.

## Overall shape

```
Employee clients / third-party integrations ──HTTPS + Bearer token──▶
┌────────────────────────────────────────────────────────────┐
│ Go server (gin + PostgreSQL)                                │
│   ├─ Auth: local / LDAP / OIDC + api_tokens (90-day hashed)  │
│   ├─ AI gateway: /v1/* proxy + per-user rate limit + usage metering (cost/peak-off-peak)│
│   ├─ Bootstrap: /api/client/v2/config/bootstrap              │
│   ├─ Marketplace & sharing: skill marketplace / shared skills / shared agents (grant-based, two gates)│
│   ├─ Channel content: /api/client/v2/channel (brand/copy, injected with the image)│
│   ├─ Client delivery: /api/client/v2/updates/manifest + /updates/client/*│
│   └─ Admin webadmin (embedded via go:embed, /admin/) + public portal (/)│
└────────────────────────────────────────────────────────────┘
```

- The **server** is the single control plane: upstream keys (AES-GCM encrypted), model pricing, quotas, grants, and approvals all live server-side;
- The **desktop client** owns the experience (chat, Capability Hub, connectors, scheduled jobs, browser) and connects through `/api/client/v2/*` and `/v1/*`;
  client installers and update packages are **delivered by the server** (they ship with the server image), so the client version naturally follows the server version;
- The **Admin Console** (webadmin) covers users, departments, authentication, gateway, usage, Capability Hub, connectors, audit, and server information — employees never touch it;
- **Brand and copy** (client sign-in page, client UI, Admin Console sidebar, portal page) come from **channel content**:
  a read-only configuration baked into the image at build time, and the Admin Console offers no online editing entry point.

## Data flow

1. **Sign in**: `POST /api/client/v2/auth/login` → Bearer token (90 days); `GET /api/client/v2/config/bootstrap` fetches the default model, suggestions, and connector catalog.
2. **LLM call**: `POST /v1/chat/completions` (stream optional) → server rate limit → quota check (token / money / department budget; over any limit returns 429 `QUOTA_EXCEEDED`) → route to the upstream provider by model → metering writes usage (including cost, priced at record time with peak/off-peak discounting).
3. **Admin config**: sign in at `/admin/` → users/departments/gateway/model prices/peak windows/quotas/budgets/marketplace/shared approvals (all via `/api/server/admin/*`, session + CSRF + RBAC, audited into audit_logs).

## Metering, billing, and quotas

- **Cost**: `usage.cost` = input × input_price/1e6 + output × output_price/1e6 (cache hits use `cache_input_price_per_1m`); outside peak windows (configurable, Beijing time) × model `offpeak_discount`. Changing prices or windows only affects future costs (priced at record time).
- **Quota chain** (429 on any exceeded limit; admins exempt):
  1. Employee token quota (`quota_tokens`: NULL = global default, 0 = unlimited);
  2. Employee money quota (`quota_money`);
  3. Department budget (`budget_money`; owned department + ancestor chain all apply; tree SUM(cost)).
- **Self-query**: `GET /api/client/v2/auth/usage` returns the balance (quota − month-to-date used; unlimited = null) plus today/yesterday/month/total tokens and costs, and the department budget chain.
- **Stored balance (optional gate)**: `users.balance_money` is a stored amount (in CNY) orthogonal to the monthly quota; once the gate is enabled, calls with a balance ≤ 0 get a 429 at the gateway, and spending is deducted at micro-unit precision **in the same transaction** as the usage write; administrators can adjust it manually, and it can also be granted automatically per Beijing month (idempotent across instances/restarts).

## Security design

- Upstream keys AES-GCM (`enc:v1:`, master key file), never plaintext; API tokens stored as hashes only;
- **Strict deny by default**: unauthorized marketplace and shared content return 404 (no existence leak); grants are per user or department group (case-insensitive); admins always full-access without a table row; grant changes are audited;
- Password change / privilege downgrade / disable revokes all API tokens in the same transaction;
- Admin session 12h (hard TTL + 60-min idle sliding expiry) + CSRF; login rate limit (dual bucket: IP and account, 10 per 5 minutes);
- Unified error envelope `{"error":{"code":"ERR_CODE","message":"..."}}`; health probe `/healthz`;
- Integrator TLS: the login page/client rejects non-HTTPS remote addresses (TOFU implemented by the client).

## Database

- PostgreSQL only (PG-only; the deployment form is the container built into compose, and the binary also accepts an external instance via `-pg-dsn`),
  with migrations under `migrations-pg/` (numbered 0001–0061; some numbers were dropped historically, hence the gaps);
- usage details are natively partitioned by month (retention configurable in months, default 6), while the daily/monthly ledgers are kept forever (10 years of historical statistics never lost);
- Shared skill / agent archives are stored directly in the DB; audit hash chain (tamper-evident), RBAC roles, balance-grant idempotency anchor.

> The database schema is migrated automatically when the server starts; before upgrading, back up first as described in [Upgrade, backup & rollback](/en/deployment/upgrade/).

## Further reading

- [API Reference](/en/api-reference/) — all HTTP endpoints
- [Private Deployment](/en/deployment/) — containerized deployment, backup/restore, offline install
- [Admin Console](/en/admin/) — webadmin guide
