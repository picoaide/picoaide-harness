---
title: Admin Console
description: 'PicoAide Harness Admin Console (webadmin) feature guide: users and departments, gateway and rate limiting, usage and billing, marketplace and capability center, audit and server info.'
---

The Admin Console (webadmin) is a single-page application embedded in the Go server, accessed via the browser at `/admin/`. It is responsible for **governance**: accounts, departments, the model gateway, metering and billing, marketplace and shared-content approvals, and audit. Employees never touch it — all governance decisions are made here.

> Sessions and security: admin login uses session + CSRF protection; login rate limiting (10 attempts / 5 minutes / key); a unified error envelope `{"error":{"code":"ERR_CODE","message":"..."}}`; health probe at `/healthz`.

## Navigation overview

| Menu | Path | Responsibility |
|---|---|---|
| Users | `/users` | Accounts, roles, status, quotas |
| Departments | `/departments` | Department tree, members, budgets |
| Gateway | `/gateway` | Upstream providers, default model, rate limiting, peak windows, login modes |
| Usage | `/usage` | Cost, request counts, token detail, charts |
| Marketplace · Skills | `/marketplace` | Marketplace skill management, tiering and grants |
| Capability Hub | `/capabilities` | Unified approval queue for shared skills/agents (Official/Featured marking, grants) |
| Audit | `/audit` | Full trace of key operations |
| Server Info | `/server-info` | Version, database driver, build info |

## Users

- **Create user**: username + password + whether admin (`is_admin`);
- **Status**: enabled / disabled — disabling **immediately revokes all API tokens for that user**, requiring the client to log in again (in the same transaction as the user update);
- **Delete**: double confirmation (makes clear it wipes all API tokens, usage records and group membership, and is not recoverable);
- **Quotas**: `quota_tokens` (monthly token cap: null = follow the global default, 0 = unlimited, >0 = monthly cap) and `quota_money` (monthly money cap, same semantics); the table shows the **resolved effective quota** (follow default = global value, admin = 0);
- **Departments and roles**: users belong to departments, and department budgets take effect along the ancestor chain;
- Login-mode related fields (local/LDAP/OIDC) are on the Gateway page.

## Departments

- Tree-shaped department structure; members belong to departments;
- **Department budget** (`groups.budget_money`): the department of membership + the full ancestor chain all take effect, and SUM(cost) within the budget counts toward department usage;
- Grant targets: marketplace/organization content can be granted to **users or departments** (NOCASE match).

## Gateway configuration

- **Upstream providers (providers)**: channel (channel selection, e.g. deepseek), name, base URL, API key (SecretInput show/hide toggle), model list (auto-synced after save or entered manually), enable switch;
- **Default model**: global selection (dropdown);
- **Rate limiting**: per-user rate-limiting policies;
- **Peak windows**: multiple peak windows (`usage.peak_windows`, Beijing time) with per-weekday selection + start/end times; outside peak windows the model's `offpeak_discount` is applied to pricing;
- **Model pricing**: per-model input/output unit price (CNY per M tokens, `input_price_per_1m` / `output_price_per_1m`), plus the **cache-hit input price** (`cache_input_price_per_1m`) and the **off-peak discount rate** (`offpeak_discount`, 0-1) — unpriced models are charged as 0; changing prices/discounts only affects costs incurred afterward (historical costs remain at the pricing recorded at the time);
- **Cache-hit billing**: input tokens that hit the cache are billed at the cache price; when no cache price is configured it falls back to the input price (DeepSeek cache price);
- **Peak/off-peak conversion**: outside the peak windows (idle periods) and when the model has an off-peak discount rate, cost = standard price × discount rate; during peak windows, cost = standard price. DeepSeek's current official policy (from 2026-08 onwards) = peak on Monday-Friday 09:00-12:00, 14:00-18:00; everything else (including weekends) is off-peak, and the off-peak price = peak price × 50%.
- **Login modes**: switch between `local` / `ldap` / `oidc` / `both` (local+ldap):
  - LDAP: `ldap_url`, `ldap_bind_dn`, `ldap_base_dn`, `ldap_user_filter` (e.g. `(uid=%s)`), `ldap_group_filter` (e.g. `(memberOf=cn=%s)`);
  - OIDC: `oidc_issuer`, `oidc_redirect_url` (e.g. `https://picoaide.example.com/api/client/v2/auth/oidc/callback`).

## Usage statistics

- **Stat cards**: total cost, request counts (chat/embedding categories), total tokens;
- **Dimensions**: by user / by model / by date; two measurement modes — cost (money) and tokens — switchable;
- **Charts**: bar chart (cost/tokens trend), pie chart (model distribution), drill-down (filter user → see their model composition);
- **Detail**: row-level cost, prompt/completion tokens, request counts; cache-hit billing is reflected in the detail (at the cache price);
- **Balance**: `GET /api/client/v2/auth/usage` employee self-service query — remaining quota (quota − used this month; unlimited = null), today/yesterday/month/cumulative tokens and cost, department budget chain.

## Marketplace · Skills (marketplace)

- Skill CRUD (list/edit/unlist/relist); skill sources are either a suggested list (bootstrap recommended list) or admin-entered (Git address, supporting http/https remote repositories);
- **Grant model**: the skill marketplace grants by user/department (GrantDialog); anything not granted is a 404 (strict default-deny, no existence leak); admin always has full access without writing to the grants table; grant changes are written to the audit log;
- **Tiering semantics reserved**: the marketplace-side tier terms "Free / Pro" are finalized (an isolated vocabulary from the organization library's "Official/Featured" quality marks); the tiering field in the current version lands in a later release alongside marketplace tiering evolution.

## Capability Hub (unified approval queue)

Shared skills (`shared_skills`) and shared agents (`agent_presets`) are approved here in a unified way:

- **Read-only queue**: aggregates both domains' pending/approved/rejected, listing author, version and status; operations go through the original domain endpoints (`/api/server/admin/shared-skills/...`, `/api/server/admin/agent-presets/...`);
- **Filtering**: status tabs (pending/approved/rejected/all) + type filter (skills/agents);
- **Approval actions**: approve / reject (reject requires a reason, shown to employees as "reason for rejection") / delete; **name conflicts**: when the name collides with a marketplace skill, a warning is shown and approve is blocked with 409 (you must first delete/rename the marketplace skill or reject the shared skill);
- **Quality marking**: `quality` = Official (`official`) / Featured (`featured`) — **only settable when approved**; automatically cleared on reject/pending; mutually exclusive;
- **Grant dialog**: reuses GrantDialog — even after approval, content must still be granted by user/department before it is visible and installable (**two-gate model**, same as the marketplace); admin always has full access;
- Audit action names such as `skill_approve` / `*_qualify`.

> Compatibility and history: the earlier standalone pages `/shared-skills` and `/agent-presets` routes are preserved; the navigation has been merged into "Capability Hub".

## Audit log

- Coverage: users, departments, quotas, gateway pricing, peak windows, marketplace CRUD, shared-content approvals and grants, quality marking, key changes and other key operations;
- Recorded content: operator, action name (e.g. `skill_approve`, `user_update`, `usage_peak_update`, `provider_update`), target, time, before/after value summary;
- Filtering: filter by action type/target/time range for a fully traceable history.

## Server Info

- Shows the current server version, database driver (PostgreSQL), build info; health-check status (`/healthz`) and a runtime environment summary.

## Deployment-related

The server runs as a single binary, or via Docker Compose (Caddy reverse proxy + fixed IP on a private subnet + non-root + bind mount data directory); the database is PostgreSQL (built-in or external instance, PG-only). See the [Private Deployment guide](./deployment).
