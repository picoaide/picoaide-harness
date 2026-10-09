---
title: Enterprise control plane (Admin Console)
description: "The Admin Console's positioning, per-page responsibilities and design boundaries: server-side control plane, RBAC sidebar, authentication and credential lifecycle, tokens and sessions, model gateway billing, the audit hash chain and the authorization model."
---

The Admin Console is the **control plane of the enterprise server**, not part of the client: it ships inside the
server image and is opened in a browser at `/admin/`. Accounts, departments, login methods, the model gateway,
metering and billing, approvals and grants in the Capability Hub and App Center, the connector catalog, audit —
every governance decision is made here.

Nothing the employee sees (login page, client UI, portal) goes through the console, and the console serves no
employee-facing content. Administrators have exactly two ways in: open `/admin/` directly, or use the low-contrast
text link in the portal footer (the admin entry is deliberately kept off the first screen so employees do not land
on a login page they cannot use).

## Positioning: why it is a server-side control plane

| Design choice | Reason |
|---|---|
| Embedded in the server image (shipped with the binary, served at `/admin/`) | The console and the things it governs (database, gateway keys, billing ledger) live on the same machine inside the same process boundary, so there is no "client version does not match server capability" intermediate state |
| Out of employees' reach | Governance permission points are granted only to `super_admin` / `auditor`; a regular employee cannot even log in at `/admin/` (non-admin accounts are rejected), let alone reach any admin API |
| Sidebar rendered from the account's RBAC permission points | One console, different interfaces: `super_admin` sees everything, `auditor` gets three read-only pages. The frontend is experience only; the server's `RequirePermission` is the guard rail |
| Branding and copy are not edited here | Name, tagline, welcome text, mark and accent color come from **channel content injected at build time**; see [Channels & white-label](/en/deployment/channels/). Changing the brand = rebuilding the image, which keeps the content auditable and reproducible |

The console is a single-page application embedded in the binary with its own content security policy;
`/admin` redirects (302) to `/admin/`.

**Boundaries and failure behaviour**

- When the admin bundle was not built into the binary (for example running an unpackaged binary locally), `/admin/` returns the JSON envelope `404 NOT_FOUND` "webadmin not built" instead of a blank page.
- Every admin API error uses the unified envelope `{"error":{"code":"…","message":"…"}}`; the health probe is `/healthz`.
- The console writes no "appearance" configuration: it has no brand fields and no logo upload entry.

## Permissions and navigation

The sidebar has three sections; entries appear according to the permission points issued for the current account
(`super_admin` holds every point, `auditor` only the three read-only ones):

| Section | Page | Path | Responsibility | Read permission |
|---|---|---|---|---|
| Management | Users | `/users` | Accounts, roles, status, balance, reset password / reset MFA, login tokens | `user:read` |
| Management | Departments | `/departments` | Department tree, leaders, members (multi-department) | `dept:read` |
| Management | Auth | `/auth` | Local / LDAP / OIDC login configuration and directory sync | `auth:read` |
| Operations | Gateway | `/gateway` | Upstream providers, models and pricing, default model, rate limiting, peak windows, gateway guards | `gateway:read` |
| Operations | Gateway files | `/gateway-files` | Upstream Files ownership ledger: per-employee usage, search/sort and expiry cleanup | `gateway:read` |
| Operations | Error monitoring | `/error-monitoring` | Client error reporting switch and reporting status, error-tracking connector preset | `server-info:read` |
| Operations | Usage center | `/usage` | Overview, departments, members, models, request detail, balance, report subscriptions | `usage:read` and others, see below |
| Operations | Capability Hub | `/capabilities` | Four tabs: skills / agents / approvals / built-in | `market:read`, `capability:read` |
| Operations | App center | `/app-center` | Employee-built apps: publishing actions, release approval, operations board, limits | `capability:read` |
| Operations | Connectors | `/connectors` | Connector catalog definitions and delivery switch | `connector:read` |
| Operations | Server info | `/server-info` | Version and update notice, runtime and database, concurrency, audit chain verdict | `server-info:read` |
| Audit | Audit log | `/audit` | Trace of sensitive operations and the retention policy | `audit:read` |

Write permission points are per resource class: `user:write`, `dept:write`, `auth:write`, `gateway:write`,
`capability:write` (shared by the Capability Hub and the App Center), `connector:write`, `market:write` and
`audit:retention:write` (`super_admin` only, the audit retention policy). **Every admin route must declare a
permission point explicitly**; a route that declares none makes the server fail at startup.

`auditor` is a read-only role: it holds only `audit:read`, `usage:read` and `user:read`, its sidebar shows only
what it can read, and every write entry point (save, delete, approve, adjust) fails for it. The report subscription
list is deliberately **not** given to `auditor` — the push URL itself is a credential.

**Boundaries and failure behaviour**

- A missing permission point yields `403 FORBIDDEN` from the server; hiding the entry in the frontend is only experience (the server is the guard rail), so typing the URL directly does not expose data either.
- When the server issues **no permission set at all** (older version, faulty response), the frontend falls back to role checks without widening visibility: only `super_admin` gets everything, `auditor` only the audit section.
- A new page that forgets to declare permission points is **fail-closed** in the sidebar (visible to `super_admin` only) rather than silently opened to every administrator.
- When a read fails, the page **does not keep rendering the previous dataset** (which would pass an old filter result off as the current one); it shows the failure state and a retry entry.

## Authentication and credential lifecycle

Login methods are configured on the Auth page, and the employee plane and the admin plane are **not the same set**:

- **Employee plane**: local accounts / LDAP / OIDC (including the OpenID variant). Whichever methods are checked
  appear on the client login page; `local` is always enabled and can be hidden from the client with the
  "hide the local login entry on the client" switch.
- **Admin plane**: **local accounts only**, and only `super_admin` / `auditor` may log in. Directory accounts
  (LDAP/OIDC) never enter the console — SSO and LDAP serve the employee plane only.

### Login method configuration

| Method | Required fields | Notes |
|---|---|---|
| LDAP | server URL, bind DN, base DN | Plus the user filter (default `(uid=%s)`), the **username attribute** (default `uid`), the group filter and the group attribute (default `cn`) |
| OIDC / OpenID | issuer, client_id, secret, redirect URL | The redirect URL must be https or an http loopback |

- **The username attribute must match the directory's real attribute**: AD commonly uses `sAMAccountName`, some
  directories only carry `cn`/`mail`. When it is wrong, a single manual login may still succeed (login falls back
  to the typed username) while the **full sync skips every user** because the attribute cannot be read. An empty
  `username` in the test-connection user sample means exactly this.
- **Test connection**: LDAP returns directory statistics (matched users, groups and the first 5 user samples), so
  the filter can be confirmed before saving; leaving the password blank or entering `***` means "test with the saved
  password" and never fails merely because the field is empty. OIDC/OpenID fetches the discovery document to verify
  the issuer.
- **Secret retention**: stored secrets are never echoed back (they show a "configured" badge). Saving with a blank
  field keeps the current value; clearing requires the explicit action, which writes the ciphertext of an empty
  string over the stored secret.
- The same page configures the **minimum password length** for local accounts (10 by default, configurable 8–64),
  which applies to creating a user, resetting a password and self-service password changes alike.

### LDAP directory sync

Saving the configuration triggers one sync immediately, then a **full reconciliation every hour**:

- users present in the directory are created / updated automatically (display name, email, groups — groups are
  replaced wholesale);
- users that disappeared from the directory are **disabled automatically and all their tokens are revoked**
  (leavers are cut off immediately);
- a previously disabled account is **not** re-enabled merely because it reappears in the directory — the sync only
  ever disables, never enables; re-enabling is always an explicit admin action, and every account skipped in a round
  writes a `directory_enable_skipped` audit entry;
- a scan that returns **zero users refuses to run** (guards against a broken filter deactivating every external user).

OIDC syncs groups only **at login** (from the IdP `groups` claim), so group changes apply on the user's next login;
use LDAP when prompt offboarding matters.

### Administrator MFA (TOTP)

- **Enabling**: verify the main password first → receive the secret (shown as both a QR code and text) → enter a
  code to finish binding. On success every **other admin session for that account is revoked** (so a login that
  predates the change cannot bypass the second factor).
- **Disabling** requires **two factors**: the main password plus the current code. Disabling also revokes other sessions.
- Running the "enable" flow again while MFA is already on is refused (`409 MFA_ALREADY_ENABLED`): replacing the
  authenticator requires disabling first, so that a weaker gate (the main password alone) can never replace the
  stronger second factor.
- Codes are single-use (a replay within the same time step is rejected as wrong); the login challenge ticket has a
  validity window and an attempt cap.
- **There are no recovery codes.** The fallbacks are: another `super_admin` resets the account's MFA on the Users
  page (which also revokes all of that account's sessions), or operations resets it with the server CLI `--reset-mfa` mode.

### Passwords and revocation semantics

- The minimum password length is configured on the Auth page (10 by default, configurable from 8 to 64);
  a `super_admin` cannot reset its own MFA (disable it under "security settings" in the top-right account menu).
- **Resetting a password forces a change**: the account enters the `password_must_change` state and every business
  endpoint except changing the password, reading one's own identity and logging out returns
  `403 PASSWORD_CHANGE_REQUIRED` (the client gets no business data until the change is done).
- **Changing a password revokes credentials**: the password update and the deletion of the user's API tokens and
  admin sessions happen in **one transaction**, including the current session — so a password change means logging
  in again. Disabling a user revokes through the same path.
- **Deleting a user erases**: the same transaction removes the API tokens, usage detail plus daily/monthly rollups,
  balance ledger and grant records, admin sessions, department membership and user-level grants. The erased amount
  is recorded in the `user_delete` audit entry — under a "deletion means disappearance" semantic, money can only be
  traced through audit.
- Passwords for LDAP/OIDC users are managed by the enterprise IdP; the console offers no password change for them
  (the reset entry on the Users page applies to local accounts only).

**Boundaries and failure behaviour**

- **Saving is locked while the authentication configuration could not be loaded**: otherwise one failed read would
  submit an empty configuration as the new one, overwriting the existing login methods and stored secrets. The error
  message states this explicitly and offers "reload configuration".
- Saving the auth configuration triggers a directory sync immediately; a failed sync does not roll the configuration
  back, but it is reported on the page so the administrator can retry.
- Password verification is behind a concurrency gate (argon2 has a large memory cost); under load it returns
  `429 RATE_LIMITED` instead of queueing up.
- Failed logins always return `401 AUTH_FAILED` "wrong username or password, or not an administrator", never
  distinguishing "no such user" from "wrong password", nor "not an administrator".

## Tokens and sessions

The console manages two kinds of credential with completely different rules:

| | Employee API token | Admin console session |
|---|---|---|
| Storage | The database stores the **SHA-256 hash only**; the plaintext is returned once at issue time | Hash only (the session secret is not stored in plaintext) |
| Lifetime | Fixed **90 days** | **12-hour hard limit** + **60-minute idle sliding**, whichever expires first |
| Carrier | `Authorization: Bearer` | HttpOnly + SameSite=Lax session cookie (Secure decided by the deployment) |
| Forgery protection | — | A CSRF token bound to the session (HMAC); admin writes must carry it |
| Revocation | Individually revocable on the Users page; password change / disable / delete revoke all | Revoked by password change, MFA reset, and enabling or disabling MFA (the initiating session is kept) |

- Issuing a token also sweeps a bounded batch of expired token rows (using the expiry index): login frequency drives
  growth and login also drives reclamation.
- Login rate limiting **counts failures only** (5-minute sliding window, cleared on success): **10 per account**
  (the cap is adjustable through an environment variable) and **60 per source IP**. The per-account failure budget is
  **shared with client logins** — after 10 failed attempts on the client, the same account is blocked in the console too.
- The source IP is the "real client IP resolved through the trust boundary" (forwarded headers are honoured only when
  the request genuinely comes from a trusted reverse proxy); otherwise a reverse proxy collapses every request into
  one IP and 60 failures would lock out the whole organisation.
- The admin CSRF token lives as long as the session; after a page refresh it can be fetched from the "read own
  identity" endpoint without logging in again.

**Boundaries and failure behaviour**

- **A rejected credential is not a dependency failure**: a token that does not exist / was revoked / expired / whose
  user is missing / whose user is disabled yields `401` (the client clears its session); a database hiccup,
  connection-pool exhaustion or statement timeout yields `5xx` (the client keeps the token and retries). Collapsing
  the latter into 401 would turn one database hiccup into "every online employee is logged out", so the server
  classifies the two explicitly.
- After a session expires or is revoked, admin APIs return `401 AUTH_REQUIRED` and the frontend returns to the login
  page; a write without the CSRF token is refused.
- Exceeding a limit returns `429 RATE_LIMITED`; the MFA second step has its own IP and account failure buckets so
  codes cannot be brute-forced.

## Page responsibilities

### Management section

**Users `/users`** (read `user:read`, write `user:write`)

- List and search: substring search on the username (pure substring, `%` and `_` are not wildcards), showing role,
  status, departments, balance, this month's spend, creation time and last password change.
- Create user: username + password (the length floor is configured on the Auth page, 10 by default) + role
  (`super_admin` / `auditor` / `user`). The role is the single source of truth for permissions; role changes take
  effect immediately, are audited, and at least one administrator must always remain.
- Set departments: multi-select (checkbox tree) submitting department IDs; there is also a "clear all memberships" action.
- Enable / disable: disabling asks for confirmation and states that it immediately revokes all of that user's API
  tokens, so the client must log in again.
- Delete: double confirmation, stating that it also erases all API tokens, usage records (detail plus daily/monthly
  rollups), balance ledger, sessions and group membership, irreversibly.
- Reset password: set a new password for a local user; the reset revokes all of that user's sessions and the next
  login must change the password first. External-authentication users have their password managed by the IdP, so this
  entry does not apply to them.
- Reset MFA: disables that user's code and revokes all of their sessions; it cannot be done to yourself.
- Login tokens: a paged list of that user's tokens (name, created at, expires at, status: active / expired / revoked),
  each individually revocable.

**Departments `/departments`** (read `dept:read`, write `dept:write`)

- The department tree nests to any depth: create / edit a department (name, parent, leader, description), view
  members, delete a department.
- Deleting a department that still has references (members, sub-departments, grants) is refused; the references must
  be handled first.
- Organisational semantics: department tree → department leader → employees; **a grant to a department covers its
  sub-department members**, and a leader automatically inherits the grants of their department and its descendants.
- A user may belong to **multiple departments** (both local and directory accounts), and all memberships take effect.

**Auth `/auth`** (read `auth:read`, write `auth:write`) — see "Authentication and credential lifecycle" above.

### Operations section

**Gateway `/gateway`** (read `gateway:read`, write `gateway:write`)

- **Upstream providers**: channel-typed (pick a channel, e.g. deepseek) or manual; name, public base URL, API key
  (encrypted at rest, never echoed back), protocol (`openai` by default / `anthropic` / `both`, where `both` means
  one key serves both endpoint dialects) and an enable switch. A disabled provider no longer participates in model
  routing, but its models remain visible and editable here.
- **Models**: name, display name, owning provider, context window, default reasoning effort, **input modalities**
  (text only / text + images, which is what lets the client accept image uploads), input price, output price,
  cache-hit input price, off-peak discount rate and the concurrency target. "Sync now" pulls the model list from the
  upstream; syncing does **not** overwrite an input-modality choice an administrator made.
- **Default model**: the model used after a client logs in; it is delivered to employees with the startup
  configuration and can still be switched per user in the model selector.
- **Global settings**: per-user rate limit (requests per minute, 0 = unlimited), peak windows, unpriced-model policy,
  file retention limit, per-request file reference limit, request-body processing memory budget and detail retention months.
- **Peak windows**: multiple windows in Beijing time, with per-weekday activation and half-open `[start, end)`
  intervals; no window at all means standard pricing all day, and a blank or 1 discount rate means no peak/off-peak pricing.

**Gateway files `/gateway-files`** (read `gateway:read`; delete and bulk cleanup need `gateway:write`)

- The ownership ledger for the upstream Files API: file ID, owning employee, size, upload time, expiry time and
  status (active / expired).
- The upstream quota is **shared organisation-wide per API key**, so the question this page answers is "who is using
  it": aggregate usage per employee, sort by bytes or file count, search by file ID, or look at one employee's files.
- Single delete removes both the upstream file and the ledger row. Bulk cleanup requires a condition (active /
  expired, or a username first); **organisation-wide cleanup may only target expired files**, it takes at most 500
  rows per run and needs the word "confirm" typed in; it reports matched / deleted / failed counts.
- The server also reaps automatically every 5 minutes; the file retention limit is configured on the Gateway page
  (default 7 days, configurable 1–30 days) and expired files are deleted upstream by the server.

**Error monitoring `/error-monitoring`** (read `server-info:read`)

- Switch + DSN + reporting level (debug / info / warning / error, default error) + a startup pipeline heartbeat.
  This configuration is delivered with the client's startup configuration, so it applies automatically once an
  employee logs in — no manual connection by the user.
- Client reporting status: the initialisation result reported by the most recent 100 clients (success / failure with
  reason, DSN host, level, release) plus the last report time.
- "Send test event" verifies the pipeline directly and returns the HTTP status and event ID.
- Connector preset: pre-fills the service address and organisation for error-tracking connectors so the employee only
  supplies their own API token.

**Usage center `/usage`** (each sub-page has its own permission point)

| Sub-page | Path | What it covers | Permission |
|---|---|---|---|
| Overview | `/usage` | Upstream account balance (when the provider exposes it), this month / today / range cost and request counts, spend trend, top 10 models | `usage:read` |
| Departments | `/usage/depts` | Spend by department, member ranking, model breakdown | `dept:read` |
| Members | `/usage/members` | This month's spend per person, account balance, status; click through to a member's daily trend, model mix and recent requests | `user:read` |
| Models | `/usage/models` | Unit price, tokens, cost share, channel distribution; unpriced models are flagged | `usage:read` |
| Request log | `/usage/logs` | One metering record per model call (no conversation content), last 7 days by default and at most 90 | `usage:read` |
| Balance | `/usage/balance` | Grant policy and gate switch, single-user adjustments, ledger and reconciliation | `user:read` |
| Report subscriptions | `/usage/reports` | Monthly summary generated and pushed to an enterprise chat webhook | `report:read` |

- **Balance sub-page**: the top holds the grant policy (gate switch, per-person monthly amount, grant mode
  "add / cover") and "grant this month now"; each row supports "add to balance / deduct from balance / set to /
  clear", and the note is written into the ledger and the audit log. The ledger area shows type, amount,
  balance after, time and note. The page also shows the **number of accounts in arrears and the total debt** —
  streaming requests settle only after the body is delivered, so concurrent in-flight requests can push a small
  account negative, and this number is the only place it is visible in the console.
- **Report subscriptions**: subscription name, push URL (an enterprise chat bot webhook) and an enable switch;
  "test" pushes immediately, and the page shows the last push, the next retry, the period still owed and the latest
  error. The push URL is a credential and is **not echoed back** (it shows "configured").

**Capability Hub `/capabilities`** (read `market:read` / `capability:read`, write `capability:write` / `market:write`)

Four tabs:

1. **Skills**: the marketplace skill list (official blue badge / employee uploads); publishing (upload a `.zip`
   archive or connect a Git source), uploading a new version, unpublish / republish, editing display metadata,
   **normalisation** (rewriting the packaged `SKILL.md` to the publishing standard), grants, ownership transfer and
   the name lock list.
2. **Agents**: the organisation-side marketplace for agents, structured exactly like skills.
3. **Approvals**: the **unified approval queue** for employee-uploaded skills and agents, with status tabs
   (pending / approved / rejected / all) and a type filter; actions are approve / reject (a reason is required and is
   visible to the author) / delete; **quality marks** are official / featured (settable only while approved and
   mutually exclusive); archive content can be previewed before deciding.
4. **Built-in**: the read-only list of skills shipped inside the server image, including a per-entry reason for
   anything not indexed.

**App center `/app-center`** (read `capability:read`, write `capability:write`)

Three sub-pages:

1. **Apps**: the list of employee-built apps and the actions on them — publish / unpublish, freeze / unfreeze,
   transfer ownership (the responsible person), delete, access level; the drawer shows versions, the pending list,
   the database schema and data rows (read-only, for troubleshooting and compliance), runtime diagnostics and
   announcement templates. The **update-approval switch** is organisation-wide: once on, a newly published version
   waits in "pending" while the currently effective version keeps serving traffic.
2. **Operations board**: open counts (PV / UV), daily trend and aggregation by department, where the rule is
   "distinct users within the window" and the department is the one held at open time. Per-app AI usage appears
   alongside the open counts.
3. **Limits**: platform-level resource and time budgets (global concurrency, per-app concurrency and queue,
   per-user concurrency, per-instance memory cap, module cache and idle reclamation, application database read
   connections and page cache, plus the guest / dry-run / host-call / end-to-end wall clock / single SQL statement /
   compile budgets). The legal ranges are derived by the server from the ordering relationships between the items, so
   the range shown in the console is exactly the range the server will accept.

**Connectors `/connectors`** (read `connector:read`, write `connector:write`)

- What is maintained here is the **catalog definition** (delivered by the server and synced automatically once a
  client logs in); **credentials stay local to the client**, and the definition contains no secret.
- Form fields: id (immutable after creation; the client matches local credentials by it), name, description,
  transport (a streamable-http URL, or stdio with command plus args / env), static request headers, authentication
  mode (`auto` / `oauth` / `device` / `token` / `server-side`), the OAuth endpoints and clientId / scopes / timeouts.
- The definition JSON is generated live on the right; a standard MCP configuration (`type` + `url`, or
  `command`/`args`/`env`) can also be pasted in to import.
- Each row has an enable switch controlling whether that connector is delivered to clients with the catalog.

**Server info `/server-info`** (read `server-info:read`)

- Version and update notice, uptime, Go version, CPU / GOMAXPROCS / goroutine count, memory and disk usage, data
  directory, database engine with per-table row counts and the migration version.
- Model concurrency: per model, "current concurrency / 90-day peak / target" plus peak utilisation (the target is the
  model's concurrency target parameter) — the quantitative basis for requesting more capacity from the upstream vendor.
- The audit chain verdict (intact or not, where it broke, who verified it and how many times, and how fresh the
  verdict is).
- The cumulative balance-admission rejection count and the most recent rejection (who, on what basis, and how much
  money was missing).
- Health summaries for error monitoring, the OIDC flow and other runtime surfaces.

### Audit section

**Audit log `/audit`** (read `audit:read`; writing the retention policy needs `audit:retention:write`,
`super_admin` only)

- What is recorded: operator, action name, target and detail, time. Coverage includes user and department changes,
  role changes, token issue and revocation, balance adjustments and grants, gateway configuration and pricing, peak
  windows, skill and agent approvals / grants / quality marks, capability locks, connectors, app actions, directory
  sync actions, administrator MFA changes and audit retention changes.
- Filtering: action type, username, time range and paging; when a read fails the page **does not render the previous
  page's rows** (which would pass them off as this filter's result), and CSV export is available only when the
  current read succeeded.
- **Tamper-evident trail**: each entry carries `prev_hash` and its own `hash`, computed as
  `sha256(prev_hash | operator | action | detail | time)`, and writes are serialised so concurrent inserts cannot
  fork the chain. Changing any row breaks every later link. The server verifies the chain hourly and the verdict plus
  its freshness appear on the Server info page — **a stale verdict is never presented as a live one**.
- **Retention policy**: configurable from 1 to 3650 days, 180 by default. Saving runs one cleanup immediately, and a
  background scheduler runs a round every 6 hours.

### Boundaries and failure behaviour

Page by page (the server is the only guard rail; a disabled control in the frontend is experience only):

- **Users**: you cannot revoke your own administrator rights or disable yourself; deleting the last `super_admin` is
  refused (the check is serialised with a row lock under concurrency). Saving "set departments" is locked while the
  department tree could not be loaded — otherwise an empty membership would overwrite all of that user's departments.
- **Departments**: deleting a department that still has references (members, sub-departments, grants) is refused; the
  references must be handled first.
- **Auth**: saving is locked while the configuration could not be loaded; **when the username attribute does not
  match the real directory attribute, the full sync skips every user** (a single manual login may still succeed —
  the most easily misdiagnosed failure of the set).
- **Gateway / Gateway files**: an invalid value is `400 VALIDATION` and nothing is written; an unparseable stored
  peak-window value **refuses to save**; saving is locked while the global settings could not be loaded;
  organisation-wide bulk cleanup may target expired files only and must state a condition explicitly.
- **Error monitoring**: with the switch on and an empty DSN the client reports no error at all (flagged before
  saving); saving is locked while the configuration could not be loaded; when the client reporting status cannot be
  read the page shows "no data" instead of rendering it as "all normal".
- **Usage center**: a failed grant-policy read locks the write surface; a failed ledger read keeps no stale rows;
  a request refused by the balance gate **never appears in the usage detail** (it was not forwarded at all) and
  leaves traces only on the Server info page and in the logs.
- **Capability Hub / App center**: anything ungranted is a 404 for employees; "reject" and "delete" release the
  archive bytes irreversibly while "unpublish" is recoverable; an approval colliding with a marketplace name is
  blocked with `409`; approving a release of an unpublished app is refused with `409` and the app must be published first.
- **Connectors**: the id is immutable after creation (the client matches local credentials by it); a definition must
  parse as a JSON object or saving is refused.
- **Server info**: a field that cannot be read shows "unknown" rather than 0; when the update manifest's channel does
  not match this deployment it is treated as "check unavailable" and never shown as "already up to date"; a stale
  audit-chain verdict is flagged as stale.
- **Audit log**: a failed list read keeps no rows from the previous page; a failed retention read locks the save
  button; a retention value that is not an integer in 1–3650 is refused; `auditor` can see the log but not report
  subscriptions (the push URL itself is a credential).

## Model gateway and billing rules

### How usage and cost are computed

The cost of every model call is converted and stored **at record time**:

```
cost = (input tokens that missed the cache / 1e6 × input price
      + cache-hit input tokens / 1e6 × cache price
      + output tokens / 1e6 × output price) × peak/off-peak factor
```

- Prices are **CNY per million tokens**; when no cache price is configured it falls back to the input price.
- The **peak/off-peak factor** is decided at record time: inside a peak window (Beijing time, half-open interval) it
  is 1; outside the windows, when the model has an off-peak discount rate (0 < d < 1), it is d; with no windows or a
  rate of 1 it is always 1.
- Token counts are clamped to non-negative at the single billing entry point: a negative count reported upstream
  produces neither a negative cost nor a "downward cost correction" (which would inflate a balance out of thin air).
- **Price changes only affect costs incurred afterwards**: historical costs stay at the pricing recorded at the time.

### The balance is the only gate

The only allowance an employee has is the account balance (the three parallel quota mechanisms of the past are
retired). The gateway performs several admission layers **before forwarding**:

1. gate switch on, balance account activated, and the quantised balance ≤ 0 → `429 BALANCE_EXHAUSTED`;
2. **minimum billable amount**: using the server's own prompt estimation, work out what this call costs at the very
   least; if the balance cannot cover it, do not let the request through;
3. **learned floor**: any settlement that fails for insufficient balance raises that account's admission floor above
   its balance at the time (the failed settlement rolls back entirely, so the balance is unchanged and the floor does
   not clear itself);
4. **unpriced models are refused by default**: a model with a missing or non-positive input price returns
   `429 MODEL_NOT_PRICED`. That default has to exist — an unpriced model costs 0, which disables all three layers
   above at once. For genuinely free or internal models, switch the "unpriced model" policy to "allow" and only then
   is the cost counted as 0.

- **Administrators are exempt**, and employees whose balance account was never activated are not subject to the gate
  (so enabling the gate on an existing deployment does not block everybody).
- A refused request is **not forwarded upstream, incurs no cost and writes no ledger row**, so there is no
  "spent but unrecorded" intermediate state.
- Refusals leave three observable traces: the cumulative count and most recent rejection on the Server info page,
  structured logs (throttled per user, with a suppressed count), and a "floor raised" log line on the settlement side.

### Ledger and grants

- `balance_ledger` is an **append-only** ledger recorded in micro-units; the invariant is
  **account balance == sum of ledger amounts**, so every entry can be reconciled.
- Single-user adjustments (add / deduct / set / clear) and monthly grants both write ledger rows; manual actions also
  write audit entries.
- **Monthly grants**: configure the gate switch, the per-person monthly amount and the grant mode. "Add" tops up the
  existing balance; "cover" clears the remainder and manual top-ups and records the cleared difference as a `reset`
  ledger row (traceable). The idempotency anchor is **per user per month**, so new hires, missed grants and
  re-enabled employees are filled in by the next round automatically; granting is **decoupled** from the gate
  (anything above 0 is granted, while "block or not" is decided by the switch alone).

**Boundaries and failure behaviour**

- **A failed balance lookup fails closed**: if the balance configuration cannot be read, the request is refused
  rather than let through.
- When an unpriced model is refused, the gateway does **not** replace it with a generic balance error — the code and
  message must let an administrator locate the real fix ("give this model a price").
- Saving the gateway configuration validates the values (rate-limit range, non-negative prices, an off-peak discount
  in (0,1], the file retention range, peak-window JSON validity and so on); an invalid value is `400 VALIDATION` and
  nothing is written.
- **Unparseable peak-window configuration refuses to save**: when the stored value is not the shape this page
  understands, refusing beats silently clearing the billing rules.
- **Saving is locked while the global settings could not be loaded**: otherwise one failed read would submit empty
  values as the new configuration (typically clearing the default model and the peak windows).
- Upstream 4xx responses pass through only the error message and type/code, never the raw upstream body.

## Authorization model

The Capability Hub, shared content and the organisation-side marketplace all use one authorization semantic:

- **A grant targets a user or a department** (department names are case-insensitive). One resource can be granted to
  several users and several departments at once; saving the "department grants" **replaces the whole set** (user
  grants are unaffected) — it is an explicit decision, not an incremental append.
- **Effective groups** are the expanded set: the departments a user belongs to plus their **ancestor chain**
  (a grant to a parent department covers members of its children) plus the **subtree** of departments a user leads
  (leaders automatically inherit their department's and its descendants' grants) plus the implicit "everyone" group.
- **Two gates**: first the approval (the content itself becomes usable), then the grant (it becomes visible and
  installable for specific people). Both must pass before anything appears in an employee's catalog.
- **Administrators (`super_admin`) always see everything** and do not write to the grants table — console visibility
  is independent of grants.
- Name conflicts: when employee-uploaded content collides with a marketplace name, approval is blocked with `409`
  (the marketplace side must be handled or the upload rejected) instead of silently overwriting.
- **Capability locks**: an administrator can lock a name (skill or agent) so employees can no longer publish under
  it; the lock reason is visible to employees, and unlocking lets employees upload that name again.

**Boundaries and failure behaviour**

- **Anything ungranted is a 404, byte-for-byte identical to "does not exist"** (for an ungranted viewer, "unpublished"
  and "missing" are the same response too) — resource existence never leaks.
- When the grants table **cannot be read (dependency failure) the response is `500`**, never a 404: an employee who
  mistakes a database hiccup for "this skill is gone" treats it as a terminal state and stops retrying, and the
  employee, organisation and marketplace surfaces must agree.
- Grant changes (grant, revoke, whole-set replace) are all audited.
- The grant dialog **locks saving when the grant list failed to load** (an empty list would otherwise overwrite the
  existing grants), and when the resource changes the list must be reset synchronously during render so the previous
  resource's grants cannot linger.

## Why branding and copy are not edited in the console

Name, tagline, welcome text, mark, accent color, data root and deep-link scheme are **channel content**: they are
injected into the image from the channel package at build time and delivered read-only, and the client login page,
the client UI, the portal and the console sidebar all read that single source.

The reason for this design: branding is an auditable, reproducible build input rather than runtime-mutable state —
one image tag corresponds to one set of channel content, so "which brand was live" never depends on whatever a
database field happened to hold at the time. The console therefore has **no** entry point for editing brand or
portal copy online (the historical entry points were removed). Changing the brand means changing the channel package
and rebuilding the image; see [Channels & white-label](/en/deployment/channels/).

**Boundaries and failure behaviour**

- The console exposes no brand-related write API; reaching the old bookmarks lands on the 404 page.
- When channel content is missing, the client and server render the built-in default brand rather than failing to start.

## Troubleshooting quick reference

| Symptom | Where to look first |
|---|---|
| Employee model calls are refused (429 / 403) | Usage center "Request log" and "Balance"; the "most recent rejection" on Server info (who, on what basis, how much was missing); the unpriced-model policy and rate limiting on the Gateway page |
| Employee cannot log in | The enabled methods and directory configuration on the Auth page; roles other than `auditor`/`super_admin` cannot enter the console; rate limiting counts failures only and clears after 5 minutes |
| Directory sync created no users | Whether the username attribute matches the real directory attribute on the Auth page; whether `username` is empty in the test-connection samples |
| An employee cannot see a skill / agent / app | Status in the Capability Hub "Approvals" tab and the "Grants" dialog (ungranted = 404 on the employee side); whether the app was unpublished or frozen in the App Center |
| The client reports no errors | The Error monitoring page: whether the switch is on, whether the DSN is empty, the reporting level; the initialisation result and reason for the last 100 clients; use "Send test event" to verify the pipeline |
| The audit trail does not add up | The filters and retention days on the Audit log page; whether the chain verdict on Server info is fresh (a stale verdict does not describe the current state) |
| A console page is inaccessible or blank | The account's permission points (the sidebar renders from them, and a server 403 is the final word); whether `/admin/` returns "webadmin not built" |

## Related

- [Deployment and operations](/en/deployment/): images, upgrades and rollback, data directories and backups;
- [Channels & white-label](/en/deployment/channels/): the single source of branding and copy;
- [Architecture overview](/en/architecture/): the three-layer topology and data flow;
- [API reference](/en/api-reference/): the admin surface `/api/server/*`, the employee surface `/api/client/v2/*` and the model gateway `/v1/*`;
- [Desktop client](/en/desktop/): the capabilities and boundaries employees see;
- [FAQ](/en/faq/).
