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
2. **LLM call**: `POST /v1/chat/completions` (stream optional) → server rate limit → **balance gate** (when enabled and the account balance is ≤ 0 → 429 `BALANCE_EXHAUSTED`; the token quota, money quota and department budget were retired on 2026-09-11) → route to the upstream provider by model → metering writes usage (including cost, priced at record time with peak/off-peak discounting) and deducts the balance in the **same transaction**.
3. **Admin config**: sign in at `/admin/` → users/departments/gateway/model prices/peak windows/balance and monthly grants/marketplace/shared approvals (all via `/api/server/admin/*`, session + CSRF + RBAC, audited into audit_logs).

## Metering, billing, and quotas

- **Cost**: `usage.cost` = input × input_price/1e6 + output × output_price/1e6 (cache hits use `cache_input_price_per_1m`); outside peak windows (configurable, Beijing time) × model `offpeak_discount`. Changing prices or windows only affects future costs (priced at record time).
- **The single spending gate (consolidated 2026-09-11)**: `settings balance.enabled = true` **and** the employee's balance account is activated **and** the quantized balance is ≤ 0 ⇒ the gateway returns 429 `BALANCE_EXHAUSTED` (admins exempt; a failed balance lookup is fail-closed). Accounts that were never activated are neither charged nor blocked.
  The employee token quota (`quota_tokens`), employee money quota (`quota_money`) and department budget (`budget_money`) were **retired**: the columns and settings keys remain in the database but are no longer read or written, and the Admin Console neither ships nor displays them.
- **Self-query**: `GET /api/client/v2/auth/usage` returns the **account balance** (`balance_money` / `balance_activated` / `balance_enabled` / `balance_monthly` / `balance_mode`) plus today/yesterday/month/total tokens and costs; the quota and remaining-amount fields are gone.
- **Stored balance**: `users.balance_money` is the only money an employee can spend; spending is deducted at micro-unit precision **in the same transaction** as the usage write, and the `balance_ledger` is reconcilable line by line. Administrators can adjust it manually, and it can also be granted automatically per Beijing month (idempotent across instances/restarts).

## Security design

- Upstream keys AES-GCM (`enc:v1:`, master key file), never plaintext; API tokens stored as hashes only;
- **Strict deny by default**: unauthorized marketplace and shared content return 404 (no existence leak); grants are per user or department group (case-insensitive); admins always full-access without a table row; grant changes are audited;
- Password change / privilege downgrade / disable revokes all API tokens in the same transaction;
- Admin session 12h (hard TTL + 60-min idle sliding expiry) + CSRF; login rate limiting counts **failures only** (5-minute sliding window, cleared for that key on success): 10 per account key (`u:<username>` and `ip|username` share one budget, shared by the client and admin faces) and 60 per source IP (the real client IP as resolved through the trusted-proxy boundary, so it does not collapse into a single proxy IP behind a reverse proxy);
- Unified error envelope `{"error":{"code":"ERR_CODE","message":"..."}}`; health probe `/healthz`;
- Integrator TLS: the login page/client rejects non-HTTPS remote addresses (TOFU implemented by the client).

## Database

- PostgreSQL only (PG-only; the deployment form is the container built into compose, and the binary also accepts an external instance via `-pg-dsn`),
  with migrations under `migrations-pg/` (numbered 0001–0081; some numbers were dropped historically, hence the gaps);
- usage details are natively partitioned by month (retention configurable in months, default 6), while the daily/monthly ledgers are kept forever (10 years of historical statistics never lost);
- Shared skill / agent archives are stored directly in the DB; audit hash chain (tamper-evident), RBAC roles, balance-grant idempotency anchor.

> The database schema is migrated automatically when the server starts; before upgrading, back up first as described in [Upgrade, backup & rollback](/en/deployment/upgrade/).

## Further reading

- [API Reference](/en/api-reference/) — all HTTP endpoints
- [Private Deployment](/en/deployment/) — containerized deployment, backup/restore, offline install
- [Admin Console](/en/admin/) — webadmin guide
