---
title: Admin Console
description: 'PicoAide Harness Admin Console (webadmin) feature guide: users and departments, gateway and rate limiting, usage and billing, marketplace and Capability Hub, audit and server info.'
---

The Admin Console (webadmin) is a single-page application embedded in the Go server, accessed via the browser at `/admin/`. It is responsible for **governance**: accounts, departments, the model gateway, metering and billing, marketplace and shared-content approvals, and audit. Employees never touch it — all governance decisions are made here.

> Sessions and security: admin login uses session + CSRF protection; login rate limiting (10 attempts / 5 minutes / key); a unified error envelope `{"error":{"code":"ERR_CODE","message":"..."}}`; health probe at `/healthz`.

## Navigation overview

The sidebar is organized into three sections — Management / Operations / Audit — and entries appear according to the current account's RBAC permission points (`super_admin` sees everything; `auditor` only gets read-only views of the audit log, the usage center and the user list):

| Section | Menu | Path | Responsibility |
|---|---|---|---|
| Management | Users | `/users` | Accounts, roles, status, quotas, **balance**, reset password / reset MFA, login tokens |
| Management | Departments | `/departments` | Department tree, members (multi-department supported), budgets |
| Management | Auth | `/auth` | Local / LDAP / OIDC login-mode configuration |
| Operations | Gateway | `/gateway` | Upstream providers, default model, rate limiting, peak windows, model pricing and usage policy |
| Operations | Error monitoring | `/error-monitoring` | Client error reporting and the GlitchTip connector preset |
| Operations | Usage center | `/usage` | Overview, departments, members, models, detail, quotas & budgets, report subscriptions |
| Operations | Capability Hub | `/capabilities` | Three tabs — Skills / Agents / Approvals (Official/Featured marking, grants) |
| Operations | Connectors | `/connectors` | Connector catalog and delivery switches |
| Operations | Server info | `/server-info` | Version and update notice, database and migrations, model concurrency |
| Audit | Audit log | `/audit` | Full trace of key operations (including the retention policy) |

> **Branding and copy are not edited in the Admin Console**: the names, taglines, welcome text, marks and accent color of the client login page, the client UI, the Admin Console sidebar and the portal page all come from **channel content** (read-only configuration injected into the image at build time). Changing the brand = rebuilding the image for that channel; see [Channels & white-label](/en/deployment/channels/). An administrator's own security settings (change password, MFA setup) live in the account menu in the top-right corner, not on the pages above.

## Users

- **Create user**: username + password + role (`super_admin` / `auditor` / `user`); the RBAC role is the single source of truth (`is_admin` is a compatibility field);
- **Status**: enabled / disabled — disabling **immediately revokes all API tokens for that user**, requiring the client to log in again (in the same transaction as the user update);
- **Delete**: double confirmation (makes clear it wipes all API tokens, usage records and group membership, and is not recoverable);
- **Quotas**: `quota_tokens` (monthly token cap: null = follow the global default, 0 = unlimited, >0 = monthly cap) and `quota_money` (monthly money cap, same semantics); the table shows the **resolved effective quota** (follow default = global value, admin = 0);
- **Balance**: `balance_money` is a **stock amount** (CNY), orthogonal to the monthly quota. The in-row "Adjust balance / Top up" action supports add / deduct / set and writes an audit entry; the "Monthly balance grant" section at the top of the page configures the gate switch, the per-person monthly amount and the grant mode (add / cover), and can grant the current month immediately — with the gate on, an employee whose balance is ≤ 0 gets a 429 when calling AI (administrators are exempt); it is off by default, so that nobody is blocked the moment you upgrade;
- **Reset password / reset MFA**: an administrator can reset the password of a local user (the user is forced to change it at the next login) and reset the TOTP code; a `super_admin` cannot reset their own MFA — another super admin or the ops CLI has to do it;
- **Departments and roles**: users belong to departments (**multi-department supported**, see Departments), and department budgets take effect across **all** memberships + ancestor chains.

## Departments

- Tree-shaped department structure; members belong to departments;
- **Multi-department membership (2026-09)**: both local and LDAP/OIDC users may belong to **multiple departments** — the "Set department" dialog is a multi-select (checkbox tree) submitting a `group_ids` array; LDAP/OIDC groups come from the enterprise directory (LDAP full sync every hour; OIDC/OpenID from the IdP `groups` claim at login time), so a manually assigned local membership may be overridden by the directory;
- **Department budget** (`groups.budget_money`): **all** departments of membership + each ancestor chain take effect simultaneously (not "the highest"), `SUM(cost)` is computed in real time for the current month (Asia/Shanghai timezone, auto-reset on the 1st of each month); **any** overspent department blocks the user (gateway 429 `QUOTA_EXCEEDED`, fail-closed: lookup failure also denies); the page shows a live progress bar (% used, amber at 80%, red over budget) and "inherited from parent (¥x)" when a department has no budget of its own;
- Grant targets: marketplace/organization content can be granted to **users or departments** (NOCASE match); groups outside the department tree (e.g. LDAP authorization-only groups) do not participate in budgets.

## Authentication configuration

Login methods (local / LDAP / OIDC / OpenID) are configured on the "Auth `/auth`" page:

- **Enabled methods**: checkboxes select which methods appear on the client login page (local is always enabled; `hide_local` can hide the local entry on the client; the admin console always uses local accounts only);
- **Required fields**: LDAP = server_url + bind_dn + base_dn; OIDC/OpenID = issuer + client_id + redirect_url (redirect_url must be https or an http loopback);
- **Username field (`user_attr`)**: the directory attribute holding the login username — default `uid` (common on OpenLDAP); AD uses `sAMAccountName`; some enterprise directories only carry `cn`/`mail` (login name is `cn` in some directories), in which case you **must set `cn`**, otherwise bulk sync skips every user because it cannot read `uid` (a single login succeeds — login falls back to the typed username — but the full sync creates nobody); an empty `username` in the test-connection user sample means this field is misconfigured: enter the attribute that actually exists in the directory;
- **Test connection**: LDAP returns **directory statistics** — matched users, groups, and a sample of the first 5 users (username/display name/email/groups), so you can confirm the filter before saving; an empty or `***` password means "use the saved password" (testing never fails because the password field is blank); OIDC/OpenID fetches `/.well-known/openid-configuration` to verify the discovery document;
- **Password/secret retention**: configured secrets are never echoed back (they show a "configured" badge); saving with a blank field keeps the current value; type a new value to replace it; an explicit "clear saved password" button wipes it;
- **LDAP auto-sync**: saving the config triggers one sync immediately, then a **full reconciliation every hour** — users in the directory are auto-created/updated (display name/email/groups, group membership fully replaced), users missing from the directory are auto-disabled and their tokens revoked (leavers are cut off immediately), and previously disabled users reappear when they return to the directory; a 0-user scan is refused (guards against a broken filter deactivating all external users);
- **Hot config**: LDAP/OIDC settings take effect **without restarting the server** (providers are rebuilt from settings on each login);
- **OIDC/OpenID differences**: group sync happens only at login (from the IdP `groups` claim), so group changes take effect on the user's next login; LDAP has the hourly sync, OIDC does not (use LDAP if you need prompt offboarding).

## Gateway configuration

- **Upstream providers (providers)**: channel (channel selection, e.g. deepseek), name, base URL, API key (SecretInput show/hide toggle), model list (auto-synced after save or entered manually), enable switch;
- **Default model**: global selection (dropdown);
- **Rate limiting**: per-user rate-limiting policies;
- **Peak windows**: multiple peak windows (`usage.peak_windows`, Beijing time) with per-weekday selection + start/end times; outside peak windows the model's `offpeak_discount` is applied to pricing;
- **Model pricing**: per-model input/output unit price (CNY per M tokens, `input_price_per_1m` / `output_price_per_1m`), plus the **cache-hit input price** (`cache_input_price_per_1m`) and the **off-peak discount rate** (`offpeak_discount`, 0-1) — unpriced models are charged as 0; changing prices/discounts only affects costs incurred afterward (historical costs remain at the pricing recorded at the time);
- **Cache-hit billing**: input tokens that hit the cache are billed at the cache price; when no cache price is configured it falls back to the input price (DeepSeek cache price);
- **Peak/off-peak conversion**: outside the peak windows (idle periods) and when the model has an off-peak discount rate, cost = standard price × discount rate; during peak windows, cost = standard price. DeepSeek's current official policy (from 2026-08 onwards) = peak on Monday-Friday 09:00-12:00, 14:00-18:00; everything else (including weekends) is off-peak, and the off-peak price = peak price × 50%.
- **Login modes**: not configured on this page; login methods (local / LDAP / OIDC) live on the separate **Auth (`/auth`)** page.

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
- **Statistics**: download/call counts (skills include `calls`) are shown alongside the approval queue;
- Audit action names such as `skill_approve` / `*_qualify`.

> Compatibility and history: the earlier standalone `/shared-skills` and `/agent-presets` routes are not preserved; the navigation and routes were merged into "Capability Hub" (2026-09).

## Audit log

- Coverage: users, departments, quotas, gateway pricing, peak windows, marketplace CRUD, shared-content approvals and grants, quality marking, key changes and other key operations;
- Recorded content: operator, action name (e.g. `skill_approve`, `user_update`, `usage_peak_update`, `provider_update`), target, time, before/after value summary;
- Filtering: filter by action type/target/time range for a fully traceable history.

## Server Info

- Shows the current server version, database and migration versions, build info; health-check status (`/healthz`) and a runtime environment summary;
- Version update notice: the server automatically checks the update directory of **its own channel** (default `release.picoaide.com/<channel>/latest.json`; override with `PICOAI_UPDATE_ENDPOINT` or set it to `off` to disable) for the latest version; when a newer version exists, a banner appears at the top of the page (including the upgrade target image tag), and administrators follow the [upgrade procedure](/en/deployment/upgrade/). Check results are cached for 6 hours; when the manifest's channel does not match this deployment it is treated as "check unavailable" (rather than being shown as "already up to date");
- Model concurrency: per-model "current concurrency / 90-day peak / target". The target is configured in the model's `default_params.concurrency_target`; the UI shows peak utilization, highlighted in red when the target is reached — a quantitative basis for requesting capacity increases from the vendor. Current concurrency is a live in-memory snapshot (request start → end); peaks are sampled to the database every 15s (GREATEST accumulates, never rolls back).

## Deployment-related

The server is deployed as a container (one image = server + bundled PostgreSQL + Caddy + client installers); a single binary with an external PostgreSQL is also supported. Deployment, upgrades, backups, channels and troubleshooting are covered in the [Deployment](/en/deployment/) section; the database is PostgreSQL (PG-only).
