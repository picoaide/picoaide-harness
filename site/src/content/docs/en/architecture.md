---
title: System Architecture
description: 'PicoAide Harness system architecture: client/server layering, the LLM gateway and metering, quota tiers, and security design.'
---

PicoAide Harness is a platform combining a **desktop client** and an **enterprise server**. This page is the architecture overview for administrators and integrators; the full endpoint list is in [API Reference](./api-reference), and public interfaces follow the actual code.

## Overall shape

```
Employee clients / third-party integrations ──HTTPS + Bearer token──▶
┌────────────────────────────────────────────────────────────┐
│ Go server (gin + PostgreSQL)                            │
│   ├─ Auth: local / LDAP / OIDC + api_tokens (90-day hashed)│
│   ├─ AI gateway: /v1/* proxy + per-user rate limit + usage │
│   ├─ Bootstrap: /api/client/v2/config/bootstrap            │
│   ├─ Marketplace & shared content (grant-based, two gates) │
│   └─ Admin webadmin (go:embed, /admin/)                    │
└────────────────────────────────────────────────────────────┘
```

- The **server** is the single control plane: upstream keys (AES-GCM), model pricing, quotas, grants, and approvals all live server-side;
- The **desktop client** owns the experience (chat, Capability Hub, connectors, scheduled jobs, browser) and connects through `/api/client/v2/*` and `/v1/*`;
- The **admin console** (webadmin) covers users, departments, gateway, usage, marketplace, Capability Hub, brand, and portal — employees never touch it.

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
- **Self-query**: `GET /api/client/v2/auth/usage` returns remaining quota (quota − month-to-date used; null = unlimited) plus today/yesterday/month/total tokens and costs, and the department budget chain.

## Security design

- Upstream keys AES-GCM (`enc:v1:`, master key file), never plaintext; API tokens stored as hashes only;
- **Strict deny by default**: unauthorized marketplace and shared content return 404 (no existence leak); grants are per user or department group (case-insensitive); admins always full-access without a table row; grant changes are audited;
- Password change / privilege downgrade / disable revokes all API tokens in the same transaction;
- Admin session 12h (hard TTL + 60-min idle sliding expiry) + CSRF; login rate limit (dual bucket: IP and account, 10 per 5 minutes);
- Unified error envelope `{"error":{"code":"ERR_CODE","message":"..."}}`; health probe `/healthz`;
- Integrator TLS: the login page/client rejects non-HTTPS remote addresses (TOFU implemented by the client).

## Database

- PostgreSQL only (built-in container or external instance), migrations `migrations-pg/` 0001–0048;
- usage detail partitioned by month (retention configurable, default 6 months); daily/monthly ledgers kept forever (10-year history never lost);
- Shared skill/agent archives stored directly in the DB; brand snapshots, audit hash chain (tamper-evident), RBAC roles.

## Further reading

- [API Reference](./api-reference) — all HTTP endpoints
- [Private Deployment](./deployment) — containerized deployment, backup/restore, offline install
- [Admin Console](./admin) — webadmin guide
