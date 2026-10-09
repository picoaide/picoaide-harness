---
title: System Architecture
description: 'The three layers of PicoAide Harness — desktop client, local Harness service, enterprise server: responsibilities, assembly, model path, data layout, and extension points.'
---

PicoAide Harness is a three-layer system: **desktop client / local Harness service / enterprise server**. In one sentence: **the experience and the execution stay on the employee machine, the control plane and the keys stay on the server**. This page is written for two audiences — administrators and operators deciding whether and how to deploy, where the data lives, and how to diagnose incidents; and developers who need to know the contract boundaries. Every endpoint is listed in [API Reference](/en/api-reference/); deployment forms are in [Private Deployment](/en/deployment/).

## Design goals

Three goals determine this shape, and explain why it is not one of several simpler designs:

| Goal | Therefore | Therefore not |
|---|---|---|
| Upstream model keys never reach employee machines | Model calls are forwarded through the server gateway; keys are stored encrypted on the server | Clients calling the model vendor directly (the key would be distributed to every machine) |
| Employees work on **real project directories** | A local process owns the workspace, the filesystem, subprocesses and the kernel sandbox | A pure web/SaaS form (a browser has no real process and no real filesystem) |
| The enterprise can manage permissions, billing and audit centrally | Authentication, authorization, metering and approvals live in exactly one place | A pure local form (one configuration per person, no central governance) |

When all three hold at once, the only workable shape is "local execution + server-side control". The trade-offs already recorded in the repository are listed under [Explicit trade-offs](#explicit-trade-offs) at the end of this page.

## Overall shape

### Boundaries of the three layers

| Layer | Location | Process model | Responsibilities | Explicitly not responsible for |
|---|---|---|---|---|
| **Desktop client** | Employee machine | Electron multi-process (main / renderer, plus separate browser and app windows) | Native window and tray; chat, Capability Hub, connectors, scheduled jobs, built-in browser, voice input, memory, app centre; local update check and install; the approval UI | Does not hold upstream model keys; does not decide model availability or quota; does not decide who may see which content |
| **Local Harness service** | Employee machine (`127.0.0.1`, random port by default, can be pinned) | The upstream DSH host (Cordis plugin tree) running inside the Electron main process, exposing only loopback HTTP/WebSocket | Runs the **pinned** upstream DSH; carries sessions and context, workspaces and files, subprocesses and the kernel sandbox, tool execution and approvals | Does not call the model vendor directly (it goes through the server gateway); does not upload session content |
| **Enterprise server** | One machine in the customer network | A single Go binary (gin) + PostgreSQL, delivered as containers (`caddy` + `server` + `postgres`) | Authentication and RBAC, model gateway and metering, Capability Hub and approvals, connector catalogue, app centre, audit, client delivery, portal and Admin Console | Never touches employee files; never runs commands on employee machines; does not proxy session content |

### Structure diagram

```
┌─ Employee machine ───────────────────────────────────────────────────────────┐
│  Desktop client (Electron)                                                   │
│    ├─ main window ──► local Harness service (127.0.0.1, random or fixed port)│
│    ├─ app window (custom scheme scheme://<app_id>/)                          │
│    ├─ built-in browser window (separate partition)                           │
│    └─ tray / notifications / updates                                         │
│  Local Harness service                                                       │
│    ├─ pinned upstream DSH (Cordis plugin tree)                               │
│    ├─ sessions / context / workspace / files / subprocesses                  │
│    └─ kernel sandbox (Linux Landlock, Windows ACL, macOS Seatbelt)           │
└──────────────────────────────────────────────────────────────────────────────┘

  │  HTTPS + Bearer (employee API token: 90 days, stored hashed on the server)
  │  model traffic on /v1/*; product surface on /api/client/v2/*
  ▼

┌─ Enterprise server (one machine on the customer network, one image) ────┐
│  Go server (gin)                                                        │
│    ├─ auth: local / LDAP / OIDC + api_tokens + admin sessions           │
│    ├─ model gateway: /v1/* -> upstream provider (keys AES-GCM encrypted)│
│    ├─ metering: usage insert and balance deduction in one transaction   │
│    ├─ Capability Hub / connector catalogue / app centre / approvals     │
│    ├─ client delivery: update manifest + installer downloads            │
│    ├─ admin console (embedded SPA, /admin/) and portal (/ and /portal)  │
│    └─ audit (hash chain)                                                │
│  PostgreSQL (bundled container, external instance also accepted)        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data flow

1. **Sign in**: the client calls `POST /api/client/v2/auth/login` → an employee API token (90-day lifetime, the server stores only its hash). The token lands in `session.json` inside the local data directory.
2. **Bootstrap**: `GET /api/client/v2/config/bootstrap` returns the default model, the available model list, shared skills, the connector catalogue, the error-reporting configuration and the server version marker in one response. That response is the client's model catalogue.
3. **Create a session**: sessions are created **locally** and bound to one workspace directory (the absolute path goes into the session header as `cwd` and is persisted with the session). Session permissions are **pinned into the session log** at that moment from the current default preset; changing the default later does not affect existing sessions.
4. **Tool execution**: the model proposes a tool call → the local side applies the session's sandbox mode and approval policy → calls that need confirmation raise the approval UI → execution happens inside the sandbox on the employee machine. This step **never goes through the server**.
5. **Model call**: the client calls `POST /v1/chat/completions` (or `/v1/messages`, etc.) → server authentication → per-user in-flight gate → rate limit → balance gate → match the enabled upstream provider by model name → forward.
6. **Metering and charging**: after the upstream responds, the usage row and the balance deduction are written in the **same transaction**; the `balance_ledger` can be reconciled line by line.
7. **Self-service query**: `GET /api/client/v2/auth/usage` returns the account balance plus today/yesterday/this-month/total tokens and cost.
8. **Update check**: the client checks 60 seconds after start and then every 6 hours, asking the server it signed in to for `GET /api/client/v2/updates/manifest`.

### Who holds the keys, who makes the decisions

| Item | Where | Notes |
|---|---|---|
| Upstream model API key | **Server** | Stored AES-GCM encrypted (ciphertext prefix `enc:v1:`), master key in a separate file; never plaintext, never delivered to clients |
| Employee API token | Plaintext on the client, hash only on the server | 90-day lifetime; revoked in the same transaction on password change / privilege downgrade / disable |
| Admin session | Browser cookie, hash only on the server | 12-hour hard TTL + 60-minute idle sliding expiry; state-changing calls additionally require CSRF |
| Connector credentials | **Client, locally** | Stored per user scope (`0600`/`0700`, atomic writes, symlink-safe); the server delivers only connector **definitions**, never credentials, and never collects them back |
| Model availability and pricing | **Server** | Administrators configure providers, models and prices in the Admin Console; clients only consume the bootstrap list |
| Whether a call is allowed (quota) | **Server** | The balance is the single billing gate (see [Admin Console](/en/admin/)) |
| Who may see which content | **Server** | Marketplace/organization content uses a double gate (approved **and** granted); administrators always see everything |
| Whether a tool call runs | **Client** | Local sandbox mode + approval policy; the server is not involved in individual tool decisions |
| Whether an app can be published | **Both ends** | The client initiates and uploads; the server validates and compiles, and applies the admin review switch |

## Assembly

### Pinned upstream + plugin composition

Upstream DeepSeek Harness runs at a **fixed version** (currently pinned at `dsh-v0.2.0-rc.2`; `upstream.json` at the repository root is the source of truth). The repository keeps only a small set of **patches with regression tests** (`patches/`, each with a matching test) and does not modify upstream wholesale. The desktop shell is itself a **legitimate DSH plugin**: it neither invents a second renderer IPC plugin system nor exposes Electron APIs to the page; it inserts itself as one row in the upstream Cordis plugin tree.

So "what we add" and "what upstream provides" live on the same assembly surface and are expressed the same way:

| Category | Examples | Notes |
|---|---|---|
| **Upstream rows (unchanged)** | agent, session, tools, settings, webserver, sandbox, llm adapters | Pinned version, upstream semantics |
| **Rows we add** | `desktop-shell`, `desktop-diagnostics`, `desktop-updates`, `desktop-loop-notify`, `desktop-asar-fs`, `desktop-asar-guidance` | Inserted by the desktop layer's composition patch |
| **Bundle layers we add** | Nine owned packages: `@picoaide/dsh-enterprise`, `-account-card`, `-wasm-apps`, `-foot-menu`, `-wasm-apps-host`, `-connectors`, `-browser`, `-cron` and `dsh-memory-evolve`; plus upstream's experimental voice-input bundle | Each owned package carries one composition patch layer; together with the desktop package's own `cordis.patch.yml` (carried as the first entry of `@picoaide/dsh-enterprise`'s bundle list) that is ten layers, entering the profile as bundle layers in a fixed order |
| **Upstream rows we disable** | see the next section | Each has a concrete reason; these are not "we don't need it, so off" |

### Upstream rows we explicitly disable

| Row | Reason (summary) |
|---|---|
| `hmr` | The row requires an `appReady` service that only the CLI provides; the desktop host does not, so activating it makes the whole plugin tree fail at startup |
| `session-log-deepseek` | Would send session content, tool arguments and results, and workspace paths to the model vendor with every request — unacceptable for enterprise delivery |
| `session-telemetry-otel` | The same class of egress as the row above (by default it exports the full session prefix up to a user feedback event), differing only in trigger |
| `desktop-product-telemetry`, `product-analytics` | Their reporting endpoint defaults to a vendor-operated collector and events carry device and usage behaviour; also, one required environment variable is unset, so the row fails to construct at all |
| `deepseek-account`, `account-controller`, `llm-deepseek-account` | The "DeepSeek account sign-in" route; this product routes models through the enterprise gateway and serves accounts/balance from its own panels |
| `ui-sidebar-browser` | Renders external pages in an iframe, but the window CSP has no `frame-src`; falling back to `default-src` blanks it out. The desktop ships its own browser entry point |
| `ui-plugin-manager` | Occupies the `main` and sidebar panel slots, which is incompatible with how the four owned full-page panels take over |
| `office-to-pdf` | Pulls in npm packages outside this repository plus five platform engine packages that no packaging manifest covers; the macOS engine is an extension-less executable that would stay inside `app.asar` and never start |
| `fs-sandbox` | Replaced by the desktop's own filesystem backend (keeps the sandbox fence and adds asar-link unwinding) |
| `ui-layout` | The desktop advanced shell owns the root frame and the `layout` service itself; upstream forbids a second declaration of the same child slot |
| `ui-settings-plugins` | The desktop does not offer the upstream plugin settings tab (its plugin surface is the owned bundle enable/disable service) |
| `ui-settings-models` | The upstream model settings page lets users define custom providers; in this product the model catalogue is delivered by the gateway after sign-in only |
| `llm-deepseek` | **A replacement, not a retirement**: an owned gateway adapter row takes over the same provider route. The two rows must be paired — disabling without inserting leaves nothing registering that route and the model surface dies; inserting without disabling makes two adapters fight over one route |

On Windows there are additionally three **implementation swaps** (not plain disables): the directory picker becomes the desktop's browsing implementation, and `pwsh-sandbox` and `agent-preset-registry` are replaced by desktop-owned Windows implementations (the former because the platform lacks the required PTY).

The five owned bundle layers for connectors, the built-in browser, scheduled jobs, the app host and memory **disable no upstream rows at all** — they only add rows and slots.

### What "profile is fixed to `desktop`" means

- The product manages **exactly one profile**: there is no profile picker and no web default entry;
- Upstream reserves the name: the CLI rejects `dsh --profile desktop` and `dsh plugin --profile desktop` (it reports that the profile is managed exclusively by the Electron application);
- Third-party plugins therefore are **not installed through the CLI**; they are written into the user patch layer `~/.picoaide-harness/cordis.patch.yml` (the data root varies by channel, see [Channels & white-labelling](/en/deployment/channels/)). The launcher merges that layer on every start;
- **Plugin changes require a client restart** to enter the composition: the desktop's plugin surface is its own bundle enable/disable service (state under `plugin-management/` in the user data directory) and does not rely on upstream profile hot-reload;
- The local service listens on `127.0.0.1` only; the port is randomly assigned by default (to avoid conflicts) and can be pinned in settings when a stable origin is needed.

## Sessions and context

### Sessions bind a workspace

Every session is bound to one workspace directory: the absolute path goes into the session header (`cwd`) and is persisted with the session. Files outside the workspace are not writable by default — that is a fact enforced by the sandbox, not a hint. Sessions, files and workspaces all live locally; the server neither participates nor keeps a copy.

### Permissions are pinned inside the session

Session permissions are a **session-level fact** recorded in that session's own event log, not a global switch in settings:

- Permissions combine two independent knobs — the sandbox mode (`read-only` / `workspace-write` / `danger-full-access`) and the approval policy; the UI presents them as presets such as "read only / workspace write / full access";
- When a session is created, the current default preset is **written into** those two facts; changing the default afterwards only affects later sessions;
- Switching inside a session uses the `/permission` command or the composer's permission control, and **only appends an event** — the switch itself is a log fact and there is no side channel that mutates the state;
- So the impression "I changed the default permission, but a new session jumps back" usually comes from upstream **reusing an existing blank session in the same workspace**, and that session carries the older permission pinned when it was created. Switch inside the session instead of relying on a new session.

### Context and tool approval

Approval is not "the model asks for permission"; it is **a gate every risky tool call must pass**:

- The model may propose any tool call, but the permission check runs before execution;
- Calls that need confirmation raise a question to the user, with the call's arguments and the optional scope of the grant;
- When the approval policy is "auto-deny", actions that need approval are **denied** rather than allowed — the direction is fail-closed;
- Approval records stay on the local machine together with the session log; the server never sees them.

The **"the AI only proposes, a human approves"** design shows up in three places, and all three matter: tool calls need human approval; scheduled jobs are visible and manageable by the human (the model can create jobs, but enabling, disabling and deleting them are all visible and controllable in the UI); and app publishing needs human confirmation plus, depending on the admin switch, a reviewer. It is not a slogan — it is a mechanism enforced by permission presets, the approval policy and the approval UI together.

## Model path

```
Desktop client            Enterprise server                 Upstream vendor
  │                          │                                │
  │ POST /v1/chat/completions│                                │
  │ Authorization: Bearer ──►│ auth (server stores hash only)  │
  │                          │ per-user in-flight gate         │
  │                          │ rate limit                      │
  │                          │ balance gate (the only billing gate)
  │                          │ match enabled provider ────────►│
  │                          │ ◄──────────── streamed / plain ─│
  │ ◄──────── forwarded ─────│ usage write + balance deduction (one transaction)
```

- **Where the model list comes from**: `GET /api/client/v2/config/bootstrap`. It lists only models under **enabled** providers that are not marked as missing from the upstream catalogue, and it carries each model's input modalities (`input_modalities`) — that is how the client decides whether pasting an image is allowed. The Admin Console is the only place to configure it.
- **Where the keys are**: upstream API keys are stored AES-GCM encrypted on the server (ciphertext prefix `enc:v1:`, master key in a separate file or injected via environment variable). Clients hold only the employee token.
- **Which layer enforces limits and gates**: all of it is on the server gateway layer, in the order "authentication → per-user in-flight gate → rate limit → balance gate → upstream". The client does not evaluate quota (and its evaluation would not count).
- **The balance gate** (the only one): when the balance account is activated, the master switch is on, and the quantized balance is insufficient, the gateway returns `429 BALANCE_EXHAUSTED`; administrators are exempt; a failed balance lookup is fail-closed. Accounts that were never activated are neither charged nor blocked — which avoids the contradictory UI where the balance shows zero yet calls still work.
- **Unpriced models**: `429 MODEL_NOT_PRICED` by default, explicitly allowed by an administrator through a policy switch, rather than silently metered at zero.
- **Billing semantics**: `usage.cost` is priced at record time (later price changes only affect later requests), with the model's off-peak discount applied outside peak windows; the balance and the usage row are written in one transaction.

## Client delivery path

Client installers **ship with the server image** (inside the image at `/opt/picoaide/client/`) and are served by the server itself. The client therefore fetches packages from **the server it signed in to**: employee machines need no internet access, and the client version naturally follows the server version — "the client was upgraded but the server wasn't" is structurally impossible.

The manifest comes from `GET /api/client/v2/updates/manifest` and has the shape `{schema, channel_id, server:{version}, client:{version, assets}}`; assets are keyed by platform (`mac-universal` / `win-x64` / `linux-x64`) and each entry carries `url`, `sha256` and `size`. When no **absolute https** download address can be produced, the manifest explicitly reports why the client is unavailable instead of falling back to an http link.

The client checks every item below; failing any one means no install:

| Criterion | Behaviour on failure |
|---|---|
| `schema` must equal 1 | The whole manifest is treated as unusable |
| `channel_id` is required and must **exactly equal** the expected channel | Rejected (a branded client installing an official manifest would be "washed" into the official client, and vice versa) |
| The download address must be **absolute https** | Rejected |
| `sha256` must be 64 hex characters, verified as a stream while downloading | Rejected, and the downloaded bytes are deleted |
| Platform container magic (for example the DMG trailer identifier, or the AppImage ELF header) | Rejected |

Failure always **keeps the current version**: no install, no downgrade, no switch to another source. Checks and transfers each retry with bounds (3 attempts for the manifest, 5 for the installer, with deterministic jitter), interrupted transfers resume with `Range` instead of restarting from zero, and **installation is always explicitly triggered by the user** — the product does not do a silent restart-and-install. See [Client Delivery](/en/deployment/client-delivery/) for the full delivery and upgrade flow.

## Data and persistence

| Item | Fact |
|---|---|
| Database | PostgreSQL only. Containerized delivery embeds PG 18; the server binary also accepts an external instance (`-pg-dsn` is a required flag) |
| Migrations | `server/internal/serverstore/migrations-pg/`, file names shaped `NNNN_<description>.sql` (four-digit number + underscore), applied automatically at server start; the range is `0001–0084` (some numbers were dropped historically, hence contiguous gaps). **Migrations are one-way**: rolling back the image cannot roll the database back to the old structure, so back up before upgrading |
| Usage detail | Natively **partitioned by month** on `created_at` (`usage_YYYYMM`), retention configurable in months (default 6), expired partitions dropped with `DROP PARTITION`; deleting detail does not affect the ledgers |
| Usage ledgers | `usage_daily` (partitioned by year) and `usage_monthly` are **kept forever** and rebuilt idempotently from the detail, so expired detail never loses historical statistics |
| Audit | `audit_logs` carries a **hash chain**: each row's `hash = sha256(prev_hash \| username \| action \| detail \| created_at)` and `prev_hash` points at the previous row; writes are serialized with an advisory lock so concurrent inserts cannot read the same `prev_hash` and fork the chain. Retention is configurable, and pruning keeps the newest row of a deleted batch as an anchor so the chain still proves itself |
| `master.key` | The master key comes from the `PICOAI_MASTER_KEY` environment variable when set; otherwise a 32-byte random key is written to `master.key` in the data directory (mode `0600`). It is **never stored in the database** — which is exactly why the backup must include the data directory: lose `master.key` and the encrypted upstream keys in the database are unrecoverable |

## Extension points

The four extension paths solve **four different problems**; choosing the wrong one costs more than it saves:

| Path | What it is | Where it runs | Permission surface | Best for |
|---|---|---|---|---|
| **Plugin** (Cordis) | A code row inside the host process | Local client (the Cordis tree in the Electron main process) | Same as the host (fully trusted) | Capabilities that must touch sessions, tools, UI slots or local resources |
| **Connector** (MCP) | An MCP service of an external system | Remote (streamable HTTP) or a local subprocess (stdio) | Only the tools it declares | Bringing an existing system's capabilities into the agent; credentials stay local |
| **Skill** (`SKILL.md`) | Instructions, procedures and attached files | Read into session context | **Grants no additional permissions** | Teaching the model how to do something — no code required |
| **App** (WASM) | A sandboxed program authored by an employee | Executed by `wazero` on the server, displayed in a client window | The platform's closed capability table | Small tools that need state and a UI (data lives in the app's own database) |

How to choose: first ask "does it need executable code". **No** ⇒ a skill; **yes, and it integrates an external system** ⇒ a connector; **yes, and it is a small self-built app** ⇒ a WASM app; **yes, and it must touch host capabilities (UI slots, local files, subprocesses, the browser)** ⇒ a plugin. The four paths stack rather than exclude each other: a plugin can register connector definitions, and a skill can direct the model to use a connector or an app.

## Explicit trade-offs

All of the following are trade-offs recorded in the repository, not omissions:

| Trade-off | Evidence | Cost (acknowledged) |
|---|---|---|
| **Apps have no public hostname**: WASM apps open only in a dedicated desktop client window, and the server's only entry point is the employee-token `POST /api/client/v2/apps/wasm/:app_id/request` | `docs/decisions/2026-09-19-wasm-client-internal-origin.md` | Employees cannot open apps in a browser, and **server and client must be upgraded together** — an older client can no longer open apps. In exchange, apps need no DNS record, no certificate and no extra reverse-proxy site block |
| **The client uses no proxy by default**: system proxy, proxy environment variables, PAC/WPAD and `--proxy-server` are all ignored | `docs/decisions/2026-09-22-client-system-proxy-ban.md` | A deployment where only an authenticated proxy reaches the internet must explicitly open the escape hatch (a channel field or a real process environment variable), and that switch must ship **with the package** — it takes effect before anything the server could deliver |
| **No silent update install**: check and download are silent, installation is always user-triggered | `docs/decisions/2026-09-12-client-update-resilience.md` | Nothing upgrades unless the employee clicks; in exchange, "the app restarted without consent" cannot happen. For forced rollouts, push the installer with MDM/GPO/SCCM |
| **Not adopting upstream's update framework wholesale**: only its design (state machine, sidecar + `Range` resume, retryable classification) is borrowed, not its dependencies | Same as above (four reasons: the update source is the signed-in server; on macOS that framework only consumes ZIP + blockmap, conflicting with the notarized DMG; `Range` resume already comes from the server; and it would add a second runtime dependency pinned to upstream) | No differential download — every upgrade downloads the full installer |
| **No wholesale modification of upstream**: only a small number of patches with regression tests | `patches/`, `docs/decisions/` | Every upstream upgrade means re-cutting the patches and re-verifying each one; in exchange the product can follow upstream |
| **Channel content is not editable in the Admin Console**: names, taglines, welcome copy, marks and accent colours come from channel content baked at build time | See [Channels & white-labelling](/en/deployment/channels/) | Changing branding means rebuilding that channel's image; it cannot be edited online |
| **PostgreSQL only**; migrations are one-way | `server/AGENTS.md`, the migration filename-shape guard | Legacy schema conversion is the migration's own job (in-place conversion plus a fail-loud self-check); a rollback rolls back the image, not the structure |
| **The balance is the single billing gate**: employee token quota, money quota and department budgets were retired (columns and settings keys remain in the database but are no longer read or written) | `docs/planning/2026-09-11-balance-quota-consolidation.md` | The Admin Console no longer offers per-person caps — only balance adjustments |
| **Diagnostic fields promise no product behaviour**: `bootstrap.server_version` is provenance information with no client consumer; version checks use the update manifest | The field comment in `server/internal/bootstrap/bootstrap.go` and its matching test | "The server was upgraded, so the client should be told to upgrade" does not exist today — the comment must not read as if it does |

## Related

- [API Reference](/en/api-reference/) — every HTTP endpoint, authentication, and compatibility commitments
- [Desktop Client](/en/desktop/) — employee-facing features and workflows
- [Admin Console](/en/admin/) — webadmin pages and permission points
- [Private Deployment](/en/deployment/) — deliverables, certificates, backup and the four hard rules
- [Plugin Development](/en/plugin-development/) — assembling and contracting custom plugins
