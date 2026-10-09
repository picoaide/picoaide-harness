---
title: App centre
description: The execution path, picoaide.app.json contract, publishing lifecycle and runtime boundaries of employee-built WASM apps.
---

The app centre is where employees build **their own small tools**: an employee describes what they need in a conversation, the AI writes a WASI application with the built-in app-builder skill and compiles it to `.wasm` locally, and the employee fills in a form to publish it; colleagues open it in a **dedicated window of the desktop client**.

This page covers **the design and the boundaries of that platform** — why it has this shape, what the configuration contract looks like, when a request is refused, and what failure looks like. For the click-by-click walkthrough see [Desktop client](/en/desktop/); for the admin-side actions see [Enterprise control plane](/en/admin/).

## Design goals and form

The problem is "let non-engineers build tools for themselves" **without widening the company's network and certificate surface**.

| Question | This platform's answer |
|---|---|
| How is an app reached | Only inside the desktop client, in a **dedicated app window** loading a custom-protocol address `<app source scheme>://<app_id>/…` |
| What must the server provide | **Nothing extra**: no public entry point, no DNS record, no certificate. The server exposes one internal API endpoint |
| Where do front-end assets live | Inside the `.wasm` file (custom sections); the platform serves them from memory at runtime |
| Where does data live | One SQLite database per app, stored under the server data directory |
| Who may use it | Anyone signed in, subject to `access`; the allow-list check is performed by **the app itself** |

**Where the shape came from (a deleted path)**: the early design gave every app its own subdomain plus browser access and a one-time ticket exchange. That path needed a wildcard domain, a wildcard certificate and reverse-proxy configuration, and its ticket/session-fixation surface was hard to converge — so it was **deleted outright**, not disabled by default and not kept behind a switch: the app base-domain endpoint, the ticket exchange, the anonymous surface and the server-side `ai.chat` capability no longer exist.

The cost is stated plainly: **there is no URL you can paste into a browser**. Sharing an app uses a channel deep link (`<channel deep link scheme>://app/<app_id>`) that the other person opens in their own client; **no browser can reach an app address directly**.

## Concepts

The rest of this page reuses these terms:

| Term | Meaning |
|---|---|
| App | Identified by `app_id`; that id is the host segment of the app address and is **occupied permanently** once published — it cannot be renamed |
| Release | One published artefact, with a strictly increasing `x.y.z` version (an optional `-prerelease` suffix is allowed) |
| Live release | The release the catalogue and access actually use; only a release that **passed review** becomes the live one |
| Publisher / ownership | `apps.owner`: the **first successful publisher**, taken from the login session and not forgeable; rejection or deletion does not release it |
| Responsible person | The `owner` field in the configuration — a "who to ask" declaration, **not** platform ownership, and it takes no part in any permission decision |
| App database | One SQLite database per app (path form `<data_root>/apps/<app_id>/app.db`) |
| Bundled assets | Static files carried in `.wasm` custom sections (`index.html`, `static/app.css`, …); the section name is the in-package logical path |

## Execution path

**Opening** (this happens every time "Open" is clicked):

1. The employee opens an app in the app centre; the client calls its **local** open route (the panel itself holds no employee token);
2. The host verifies once against `POST /api/client/v2/apps/wasm/:app_id/open`, which also records the day's open count;
3. On success the client opens a **dedicated window** loading `<app source scheme>://<app_id>/<path>`. If a window already exists, it is focused instead;
4. The app version in the response (`X-PicoAide-App-Version`) is the only source of the client's content cache key; when the version changes, every cached entry for that app under the current session scope is dropped.

**Every request inside the window** (the page's own `fetch`, link clicks, form submits):

```
app page fetch('/notes?page=2')
        │  Chromium hands the custom-protocol URL to the protocol handler the client registered
        ▼
the protocol handler builds a request envelope (method / path / query / host / allow-listed headers / base64 body)
        │  POST /api/client/v2/apps/wasm/<app_id>/request
        │  headers: Authorization: Bearer <employee token> + X-Pico-App-Proof: <proof of possession>
        ▼
server: authentication → admission → static asset or wazero execution → response envelope
        │  {"status":200,"headers":{…},"body":"<base64>","truncated":false}
        ▼
the protocol handler turns it back into a response the page can read
```

Three invariants (breaking any of them is a security defect):

- the envelope's `host` **only accepts** `<app source scheme>://<app_id>`; the `app_id` comes from the URL host segment and is **never** parsed back out of the `Host` header;
- request body ≤ 1 MiB, envelope ≤ `1 MiB × 4/3 + 64 KiB`;
- `Set-Cookie` is dropped entirely (a custom protocol has no cookie semantics); hop-by-hop headers and `Content-Length` are removed.

**Reserved surface**: `/__picoaide` and everything under it belongs to the host. Today only the app AI bridge `POST /__picoaide/ai/chat` exists, and it is handled **locally by the protocol handler, never forwarded to the platform**; every other `/__picoaide/*` path returns 404 and is never treated as an app route.

**The server and the client must be upgraded together**: the app address is injected at assembly time from the channel package (`desktop.app_origin_scheme`, required, must differ from the deep-link scheme, must not be a reserved scheme such as `http`), and the envelope and protocol headers are a shared contract between the two ends. An old client hitting a new server (or the reverse) **fails to open and says the client and the server must be upgraded to the same version** rather than degrading silently. The price is "upgrade both ends together"; the benefit is that the protocol has exactly one shape.

**Three failure reasons stay distinguishable** (the platform does not collapse them into "open failed"): app missing → 404; taken offline → 410 Gone (data and links survive); frozen → 404 carrying `platform_reason=app_frozen` (the copy says "disabled by an administrator", word-for-word different from "does not exist").

## The `picoaide.app.json` contract

The configuration file is always called `picoaide.app.json` (published as an object in the `config` field). **The single source of truth is the server** — `server/internal/wasmapp/appcfg/appcfg.json` (schema `picoaide-app-config/1`); the client mirrors the same field specification and is checked against it. The in-frame protocol version is `picoaide-app/1`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `access` | enum | no | `login` (the default) or `whitelist`; **those are the only two values** |
| `whitelist` | `string[]` | required when `access=whitelist` | Up to 2000 entries; **the platform does not compare it** and does not check that accounts exist |
| `purpose` | string | first release | One-line purpose, used by the app centre and the page title |
| `data_sensitivity` | string | first release | Data-sensitivity declaration (for example `internal`); **the platform has no default** — it exists for declaration and accountability only |
| `owner` | string | first release | Responsible-person declaration, shown as "Responsible" in the app centre |
| `sensitive_columns` | `string[]` | no | **Extra** column names to mask (beyond the default heuristics): at most 100 entries, each ≤ 64 bytes |
| `window.ratio` | string | no | Enforced aspect ratio (`"16:9"` or a float), valid range 0.25–4.0 |
| `window.width` / `window.height` | positive integer | no | Initial window size, default 1280×720 |

Rules that are easy to get wrong:

- **`access` only has `login` and `whitelist`.** A historical `"public"` is **still executed as `login` on the read side** (existing apps do not break), but a new release may not write it again (422). The platform **has no anonymous surface** — an app is only usable inside a signed-in client.
- **The allow-list decision belongs to the app**: the platform injects identity and access mode into the frame and **does not compare the list or validate accounts** (doing so would turn the endpoint into an account-enumeration oracle). A "no permission" page must display the caller's own account — that is the only way an author notices a typo in the list.
- **On a new release, omitted fields inherit the previous live value** (`access` / `whitelist` / `purpose` / `data_sensitivity` / `owner` / `sensitive_columns` each inherit independently); an explicit value — **including an explicit empty string** — wins. A code-only update never rewrites the live access level by accident; to really change it, write it explicitly.
- **Any configuration change requires a new release**: `access` cannot be changed at runtime, and the stored configuration is the parsed, normalised form (whitespace trimmed, duplicates removed, `access` default resolved).
- The configuration is capped at 64 KiB; unknown sub-keys under `window` are rejected rather than silently ignored.
- Publishing fields: `app_id` ≤ 63 characters, lower-case letters/digits/hyphens, not all digits, not starting with `xn--`, not a reserved word; `title` is required on the first release; `changelog` is **required on every non-first release** (empty is rejected).

## Publishing and lifecycle

### Development and upload path

- **Development**: the employee describes what they need in a conversation, and the built-in app-builder skill owns the design (data model, pages, permissions, error handling); the artefact shape is fixed at "static front end (bundled assets) + a wasm JSON back end", never HTML assembled inside wasm;
- **The platform does not build anything**: the artefact is compiled on the author's machine before upload (the import surface accepts `wasi_snapshot_preview1` only, and component-model output is refused outright);
- **The AI tool surface is the author's entry point**: `wasm_app_list` (check whether an id is taken and what the current version is), `wasm_app_validate` (pre-check: static validation + a real compile + a dry run; **occupies no version number and writes no audit entry**, so it can be called repeatedly), `wasm_app_publish` (publish), and the read-back surface `wasm_app_schema` / `wasm_app_diagnostics` / `wasm_app_rows`;
- **Two upload sizes**: `.wasm` ≤ 32 MiB (request body after base64 ≤ 48 MiB). Above the per-chunk cap (8 MiB) it automatically becomes **chunked with resume**: open a session → PUT chunk by chunk → query which chunks arrived → complete (`POST /uploads`, `PUT /uploads/:id/chunks/:index`, `GET /uploads/:id`, `POST /uploads/:id/complete`, `DELETE /uploads/:id`); 64 KiB–8 MiB per chunk, at most 1024 chunks, a 30-minute session, four concurrent sessions and a 48 MiB in-flight disk quota per user, and 30 uploads per hour (pre-check plus publish combined);
- **Budget hand-off**: the whole upload chain on the client shares a 90-second budget, and on the "complete" hop it tells the platform **how long that hop will really wait** through the `X-Pico-Client-Budget-Ms` request header; the platform narrows its own budget accordingly (**it may only shrink it, never widen it**) — so the platform's structured error always arrives before the client gives up, instead of the employee seeing nothing but "network error".

### The publishing pipeline

Publishing is one **synchronous** call with a fixed order (and fixed compensation on failure):

| Stage | What happens | Key constraint |
|---|---|---|
| A Validation | identity → size → static checks (imports/exports/sections/size) → config check | On an update, missing fields are first inherited from the previous live config |
| B Compile | a real compile in a compile subprocess | One compile budget, operator-tunable, 60 s by default |
| C Extraction | custom sections → in-memory asset set, each logical path validated | Reserved prefixes and duplicate sections are refused; one file and the total are capped at 4 MiB |
| D Dry run | synthesised frame → `Instantiate` → `_start` → response frame | Compiling is not running (a mismatched export signature compiles cleanly) |
| E Claim and write rows | write the app row and the release row, obtain the release id | **This is the first write**; nothing was written before it |
| F Projection | only an `approved` release is projected onto the app row | A pending release can never rewrite the catalogue early (not the title, description or config) |
| G Finalise | audit → release GC | The most recent live releases are kept; older ones are soft-deleted |

Two deliberate properties:

- **The whole pipeline only writes to the database.** The only file-system trace is the compile temp file (each path is removed with `defer`). So a failed publish does not consume a version number: the failure either happens before the first write (no row at all) or the compensation closure soft-deletes the row it just created — **a soft-deleted row still occupies the version number**.
- **Version numbers are occupied permanently**: an already-committed version must be republished under a new number; a compile or dry-run failure may simply retry the same number.

### Review

There is a publish-review switch on the admin side (setting key `wasm.review_required`, off by default).

- With the switch on, a new release is stored as **pending**: the release exists and the version number is taken, but **the live version is still the old one** (only approved releases count as live);
- The author sees the verdict and the rejection reason in their own release history — that is the only author-facing outlet for a review verdict;
- If the switch **cannot be read**, publishing fails with **503 and writes nothing** (strict read). A lenient read would turn one settings read failure into "an unreviewed release goes live silently".

### Publish, unpublish, freeze, retire

| Action | Who | Effect | Reversible |
|---|---|---|---|
| Publish / unpublish | publisher and admins | Unpublish → access returns 410 Gone (data kept, links unchanged) | Yes (publishing again restores it) |
| Freeze / unfreeze | publisher and admins | Freeze = stop serving (always 404) **and unpublish at the same time**; unfreezing does **not** publish it again | Yes (after unfreezing, publish it again) |
| Delete (retire) | publisher and admins | The row is soft-deleted; the id and version numbers are **occupied permanently** and never reused | No |
| Transfer ownership | admins only | Rewrites `apps.owner`, for staff moves and offboarding | — |

Two semantics that are easy to misread:

- **Publishing claims the name**: `app_id` is held permanently by the first successful publisher; rejection, unpublish and deletion do not release it. Publishing someone else's id returns 409 `NAME_TAKEN` (admins are exempt).
- **A frozen row is visible only to its owner**: for everyone else a frozen app is byte-for-byte identical to "does not exist" (no existence leak); for the publisher it stays visible in the app centre (marked "frozen"), because otherwise "unfreeze" would have no entry point anywhere in the employee-facing product.

### What an author can and cannot see

| Visible to the author | Notes |
|---|---|
| The catalogue and their own rows | Every app (including unpublished ones, marked "unpublished" with opening disabled); their own rows carry the publisher view |
| Release history | The release list and review verdicts for their own apps (including rejection reasons); the response contains no artefact bytes |
| Diagnostics | Call counts, failure counts, recent failures, reason codes and suggestions for a time window, with a retention note |
| Schema | Tables, columns, row counts and size of the app database |
| Data browsing | Rows of the app database, **masked by default** (heuristics plus the author's `sensitive_columns`); explicitly showing raw values writes an audit entry |
| Export | A control-plane metadata snapshot (app row + release rows + config) as JSON |

| **Not** visible to the author (stated honestly) | Why |
|---|---|
| **Asset content** and **app database content** in the export | The export carries control-plane metadata only; the database holds business data that may contain personal information, which is a separate admin operation |
| An app log table | The app's `log` output goes to the server's stdout; there is no queryable log table, and diagnostics only expose failed call events |
| Other people's apps (including frozen rows) | Byte-for-byte identical to "does not exist"; no existence leak |
| Other colleagues' usage detail | The catalogue exposes the day's open counts (PV/UV) only; no quota or usage field ever appears |
| The review switch | The switch lives in the admin console; an author only sees the state of their own releases |

Two authorization boundaries around data:

- **The in-app AI is conversation only**: `/__picoaide/ai/chat` is handled locally by the host and sends this conversation's content only; it has no tools, cannot read or write files, and cannot use connectors or memory. Authorization is recorded per "account × server × app" and can be revoked at any time.
- **AI reading the app database is off by default**: the data tools can read that app's data only after the author explicitly grants it in the app centre (masked columns only, and every call writes an audit entry); revoking it restores the default immediately (further calls are refused).

## Runtime boundaries

### Guest side: WASI only

- The only permitted import module is `wasi_snapshot_preview1`; `env.*` / `js.*` are rejected; component-model output (`wasm32-*-component`) is rejected outright;
- At runtime only the WASI host module is instantiated; there are **no preopens at all** (no host directory is mounted) and no `args` / `env` are passed;
- WASI preview1 **does export** `sock_accept` / `sock_recv` / `sock_send` / `sock_shutdown`, but it does **not** export `sock_open` / `sock_bind` / `sock_listen` / `sock_connect` — the only sources of a new fd are a preopen and `sock_accept`, and neither is reachable, so **an app cannot obtain a socket fd and cannot reach the network**;
- Every request instantiates a fresh module instance; only the compiled artefact is cached. The random source, clock and sleep are real implementations (not wazero's deterministic defaults).

### Host capabilities: one closed method table

An app may call exactly eight host methods; anything else is refused (`HOST_METHOD_UNKNOWN`, and the error lists what is available):

| Primitive | Methods |
|---|---|
| Define tables | `db.define` |
| Query / write | `db.query` / `db.exec` |
| Transactions | `tx_begin` / `tx_commit` / `tx_rollback` |
| Logging | `log` |
| Read bundled assets | `assets.read` (the parameter is an **in-package logical path**, not a host path) |

> The server **no longer offers** an AI capability such as `ai.chat`. To use a model, an app goes "front-end JS calls `/__picoaide/ai/chat` → the result is posted back into wasm and stored"; an old app is refused at **publish validation** (`IMPORT_NOT_ALLOWED` plus a migration hint) rather than failing silently.

### Budgets (compile-time defaults)

| Item | Default | Notes |
|---|---|---|
| Linear memory per instance | 64 MiB | A hard cap; exceeding it fails the instance |
| Guest execution | 30 s | The timer **pauses** during a host call ("waiting for the database" does not count) |
| Host-call fallback | 10 s | The fallback budget for `db.*` / `log` / `assets.read`; **must be strictly greater** than the per-statement budget |
| Per SQL statement | 5 s | On expiry the statement is rolled back and the database handle is marked poisoned |
| End-to-end wall clock | 60 s | **Includes queueing**; on expiry the request is refused |
| Response body | 168 KiB guaranteed / 1 MiB per frame | 168 KiB is the "fits whatever the content looks like" guarantee; low-escape content measures around 625 KB but is not promised |
| App request body | 1 MiB | The envelope carries its own cap; the server still wraps `MaxBytesReader` to catch lying lengths |
| Bundled assets total | 4 MiB per release | A single logical path ≤ 256 B, a single segment ≤ 255 B |

### The app database (one SQLite file per app)

- Size cap **100 MB** (fixed by the platform, no user knob), page size 4 KiB;
- Table and column names match `^[a-z][a-z0-9_]{0,30}$`; at most 16 tables per app and 16 columns per table; column types are a closed set (`text` / `int` / `real` / `bool` / `datetime`);
- The statement allow-list is `SELECT` / `INSERT` / `UPDATE` / `DELETE` only (**all DDL is refused**; tables are created with `db.define`);
- `_row_id` is a platform-reserved column — mentioning it is refused; `ATTACH` is denied at the engine level (`SQLITE_LIMIT_ATTACHED = 0`);
- Results are truncated (at most 5000 rows, about 172 KB) with a `truncated` flag — **that is a paging signal, not an error**;
- Concurrent reads under WAL: four read-only connections per app by default (configurable 1–16), while writes stay serialised behind a single writer.

## Operator-tunable limits

Concurrency, memory and time budgets are all adjustable on the admin console's **App centre → Limits** sub-page (admin API `GET|PUT /api/server/admin/wasm-apps/limits`). The **single model** lives in the server's `applimits` package, and its field names match the console form word for word.

| Field | Range | Default | Effective |
|---|---|---|---|
| `max_instances` | 1–256 | 32 | immediately |
| `app_running` | 1–`max_instances` | 4 | immediately |
| `app_queue` | 1–4096 | 32 | immediately |
| `user_global_running` | 1–`max_instances` | 4 | immediately |
| `user_per_app_running` | 1–`max_instances` | 1 | immediately |
| `user_per_app_queued` | 1–4096 | 4 | immediately |
| `instance_memory_mb` | 16–1024 | 64 | **requires a server restart** |
| `module_cache_mb` | 8–4096 | 128 | immediately |
| `module_cache_idle_min` | 1–1440 | 10 | immediately |
| `appdb_idle_min` | 1–1440 | 3 | immediately |
| `appdb_cache_kib` | 128–65536 | 1024 | next new app-database handle |
| `app_db_readers` | 1–16 | 4 | next new app-database handle |
| `guest_budget_seconds` | 5–120 | 30 | immediately |
| `dry_run_budget_seconds` | 1–120 | 30 | immediately |
| `host_call_budget_seconds` | 5–120 | 10 | immediately |
| `request_wall_clock_seconds` | 6–300 | 60 | immediately |
| `sql_statement_budget_seconds` | 4–119 | 5 | next new app-database handle |
| `compile_timeout_seconds` | 1–60 | 60 | immediately |

Several of these are hard checks at save time, not advice:

- The time budgets have **ordering relations**: `wall > guest ≥ host_call > sql > sqlite busy_timeout`, on top of independent caps (guest ≤ 120 s, compile ≤ 60 s). The ranges shown in the form are the **reachable** ranges, not the base ranges — the console never leads an administrator into a cell that must be rejected.
- Saving is **fail-loud**: out-of-range values, missing fields, unknown fields, or a four-way memory accounting (instance pool + compile peak + upload peak + cache residency) above 70% of available memory all reject the save and name the field.
- **`instance_memory_mb` is the only entry that needs a restart**: it lives in the runtime's immutable configuration. Everything else is pushed immediately; the three "next new app-database handle" entries neither block the save nor require a restart.
- Precedence: **saved console value > deployment memory profile (environment variable) > compile-time default**. At startup, a saved setting above the watermark is **rolled back to the profile with a warning** instead of refusing to start (so one bad setting cannot lock the server out).

## Boundaries and failure behaviour

### A two-layer error model

Client failures come in two layers; when debugging, first establish which one you are looking at:

| Layer | Code | When |
|---|---|---|
| Transport (outer HTTP + platform envelope) | `401 AUTH_REQUIRED` / `AUTH_FAILED` | Missing token / invalid, expired or revoked token |
| | `401 proof_required` / `proof_expired` / `proof_mismatch` / `proof_replayed` | Proof of possession missing, expired, not bound correctly, or replayed |
| | `403 FORBIDDEN` | Auditor accounts |
| | `400 VALIDATION` | Envelope shape, host shape, header allow-list, invalid path/query |
| | `413 BODY_TOO_LARGE` | Envelope or app request body above the cap |
| | `503` | The publish surface is shut down (for example the compile cache is over its cap, the compile queue is full, or the compile subsystem is unavailable) |
| App pipeline (inner envelope `status`) | 404 / 410 | App missing, unregistered, soft-deleted, frozen / unpublished |
| | 403 | Cross-origin write |
| | 502 / 504 | Runtime produced no response / timed out |
| | 500 `RUNTIME_OUTPUT_OVERRUN` | Output above the cap |

**Why the two layers are kept apart**: the app's **own** 404 (page not found) and "app does not exist" are the same number but call for opposite fixes — an outer 404 means change the `app_id`, an inner 404 means change the app's routing. Merging them leaves guessing as the only debugging method.

### Common rejection codes (app side)

| Code | Meaning |
|---|---|
| `IMPORT_NOT_ALLOWED` | Imported something other than `wasi_snapshot_preview1` (including an old app's `ai.chat`) |
| `SECTION_MALFORMED` / `SECTION_OVERRIDE_OVERSIZE` | Invalid section table / custom sections above 4 MiB in total |
| `ASSET_EXISTS` | Duplicate asset section name |
| `APP_CONFIG_INVALID` | Invalid configuration field (for example `window.ratio` out of range) |
| `MISSING_FIELD` | First release missing `purpose` / `data_sensitivity` / `owner`, or a later release missing `changelog` |
| `NAME_TAKEN` | The id is taken by someone else (admins are exempt) |
| `APP_FROZEN` | The app is frozen and cannot accept a new release |
| `HOST_METHOD_UNKNOWN` | Called a method that is not in the host method table |
| `HOST_CALL_OVER_BUDGET` / `DB_DENIED` | Host call over budget / SQL refused (including statement timeout) |
| `RUNTIME_TIMEOUT` / `RUNTIME_OUTPUT_OVERRUN` | Guest timed out / output above the cap |

### Boundaries registered by the platform (acknowledged)

The following are **current, real boundaries**, not a bug list; they are written down so a deployment can decide whether to stack additional measures on top.

- **Deleting an app soft-deletes it and keeps the name occupied for ever**: after deletion the id and version numbers are never reused and the row stays in the database (the catalogue does not list it);
- **The retirement snapshot and the hard-delete task are not implemented**: the export endpoint documents "exportable during the retention window → hard-deleted after it", but the periodic snapshot and the hard delete belong to a background task that is **not implemented today**;
- **Compiling and executing share one data root**: the compile process runs under OS-level isolation (`bwrap` plus a read allow-list and its own network namespace), the cache directory is mode 0700, and the executing process opens it read-only; **cache entries carry no content signature**, so a writer with the same uid as the host can still poison them — closing that properly needs a separate uid, a read-only mount or an HMAC manifest (deployment side);
- **Historical settings rows left behind by the deletion wave**: legacy configuration items such as the app base domain are still in the database but are **no longer read**.

## Related

- [Desktop client](/en/desktop/) — the app window, permission tiers and local capabilities
- [Enterprise control plane](/en/admin/) — the app centre admin page: review, freeze, ownership transfer, limits
- [Security & compliance](/en/security/) — the full picture of keys, tokens, sandboxing and outbound traffic
- [System architecture](/en/architecture/) — the three-layer topology and API namespaces
- [Container deployment](/en/deployment/compose/) — server data directories and memory profiles
