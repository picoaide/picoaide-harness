---
title: Desktop Client
description: "The desktop client's place in the product, its design boundaries and its operating paths: three layers, sessions and permissions, Capability Hub, connectors, scheduled jobs, browser, voice, memory, app centre, updates and outbound policy."
---

The desktop client is the layer employees live in. It is an Electron app that packages a **pinned** upstream
DeepSeek Harness runtime behind a native shell: window, tray, auto-updates, login page — **with no need to
install Node.js and nothing to run on the command line**.

It is also the product's **main entrance**: the Capability Hub, connectors, scheduled jobs, the built-in
browser, voice input, five-track memory and the app centre all live in this client as panels, not as web pages.

## What this layer is responsible for

| Layer | Runs on | Responsible for | Explicitly not responsible for |
|---|---|---|---|
| **Desktop client** | The employee's machine (Electron app) | Native window and tray, login page and account, auto-updates, and every user-facing panel (chat, Capability Hub, connectors, scheduled jobs, browser, voice, memory, app centre) | It makes no model calls and keeps no accounts; it does not decide which content an employee may see |
| **Local Harness service** | The employee's machine, on a random `127.0.0.1` port (pinnable) | Runs the pinned upstream DSH: sessions and message logs, file access, workspaces, sandbox and approvals, tool execution | It makes no outbound decisions beyond the model request; it holds no accounts, roles or balance |
| **Enterprise server** | One machine inside the customer network (a container image) | Authentication and accounts, model gateway and metering, Capability Hub and approvals, connector catalogue, app centre, audit, client distribution, portal and admin console | It never touches files or session logs on the employee's machine |

That split decides every boundary in this document:

- **What stays on the machine**: sessions, workspace files, tool execution, sandbox state and voice audio all
  live on the employee's machine. The server only sees accounts, model usage and audit events.
- **What the server controls**: the model catalogue (which models exist), balance and quota, Capability Hub
  content and grants, the connector catalogue and the app catalogue. The client only renders them.
- **How a model request travels**: sign in → fetch the model list (`/api/client/v2/config/bootstrap`) → the
  request goes to the **server's** `/v1/chat/completions` → the server applies rate limiting and the balance
  gate → matches an upstream provider for that model → metering and balance deduction happen in one
  transaction. **The upstream API key exists only on the server**; the client never sees it.

## Main window and tray

### Window

- **A native window with a sandboxed renderer**: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The renderer only loads pages from the loopback origin — there is no Electron IPC bridge
  and no raw Electron API in it.
- **Local web port**: `0` by default (assigned randomly by the system, so ports never clash); a fixed port
  from `0` to `65535` can be configured. The service only listens on `127.0.0.1`.
- **A port change means one orderly restart**: the current Cordis tree is fully disposed first and Electron
  is relaunched. Root slots, native material and Loader rows are never hot-swapped inside a live renderer
  generation.
- **Single instance**: launching again focuses the existing instance instead of starting a second process.
- **Closing is not quitting**: closing the window only hides it and the Host tree keeps running (scheduled
  jobs still fire). Quitting goes through the tray's Quit item, the system quit, or `SIGINT`/`SIGTERM` — an
  orderly disposal is requested first, and a five-second deadline or a repeated request forces the exit.

### Tray

The tray menu is assembled from **ordered contribution points** and always reads: Open product → tools group
→ Profile group → status group → Quit.

| Group | Item | Behaviour |
|---|---|---|
| Top level | Open &lt;product name&gt; | Shows and focuses the main window |
| Tools (`tools`, order 20) | Export diagnostics… | Creates and reveals `diagnostics-*.zip` |
| Profile (`profiles`) | — | The product registers **nothing** here: no profile switcher, no "open DSH terminal", no mode switch |
| Status (`status`, order 10) | Check for updates / Update available vX / Downloading vX / Install update vX | One row whose label tracks the state; the "Install update" submenu only appears once an installer really downloaded and verified |
| Top level | Quit | Requests orderly disposal, then exits |

### Logs and diagnostics

- Logs are written under `logs/` in Electron's user-data directory: `dsh-YYYY-MM-DD.log` plus
  `dsh-YYYY-MM-DD.error.log` (warnings and errors only). One file is capped at **10 MiB**, the whole
  directory at **200 MiB**, and files older than **seven days** are removed at startup. Directories are
  `0700`, files `0600`.
- **Export diagnostics…** (tray → tools group) first shows a native dialog explaining the privacy boundary.
  On confirmation it writes `diagnostics-<timestamp>-<uuid>.zip` into the sibling `diagnostics/` directory
  and reveals it in the system file manager. Bundled evidence is capped at **50 MiB** (logs and Crashpad
  `.dmp` files share that budget) and includes `system-info.txt` (Desktop / Electron / Node / platform /
  architecture versions).
- **Recognised credentials are masked**, but local paths, workspace IDs, session IDs, prompts and tool
  output can still be present — review the archive yourself before uploading it anywhere.
- **When the app crashes on start**: run the installed binary with `--export-diagnostics`. It does not start
  the Host and prints the absolute path of the diagnostics ZIP.
- **Deep links**: `<scheme>://app/<app id>` opens an app, `<scheme>://auth?...` handles a login callback. The
  scheme comes from the channel content shipped with the build (see the channels section of the deployment
  docs).

## Profile and advanced mode

| Concept | Description |
|---|---|
| **Profile** | A combination of DSH bundles, dependencies and patches. The product **always runs the `desktop` profile**: there is no switcher in the tray and no selector in the app. Upstream reserves that name for the Electron app: both `dsh --profile desktop` and `dsh plugin --profile desktop` are rejected by the CLI (`profile "desktop" is managed exclusively by the Electron application`) |
| **Presentation mode** | Fixed to `advanced`. The `dsh-desktop.mode` setting is still accepted for backward compatibility, but always reads back as `advanced` |
| **What advanced mode does** | Without changing the upstream web carrier it disables the official `ui-layout` row, keeps the official `ui-sidebar` and `ui-conversation` rows, and has the desktop package own the `layout` service and the root slot — responsible only for **frame geometry and native material**: macOS uses a transparent hidden-inset title bar with native sidebar vibrancy, Windows uses a hidden title bar with Mica, Linux uses the **standard system frame** (no Mica, same advanced layout) |
| **Restart boundary** | Adding or removing a profile bundle, changing the port, or editing the user patch layer all need an app restart; the app never hot-swaps root slots inside a live renderer generation |

## Sessions and workspaces

- **A session is an independent context plus a workspace (a project directory)**. The workspace decides the
  sandbox's writable scope, which project track the memory belongs to, and which project-level skills the
  model can use. Listing, search and recovery follow the official Harness semantics.
- **The model catalogue is delivered by the server.** The client points at `<server>/v1` as its model
  endpoint; whether a model is available, whether it accepts images, its price and its off-peak discount are
  all configured in the admin console. There is no local model configuration.
- **Permission is a per-session fact, not a global switch.** When a session is created, the then-current
  default preset is **pinned into that session's log**. Changing the default afterwards only affects sessions
  created **later**. To change the tier of a session you are already in, use the permission control next to
  the composer or the in-session command — do not rely on "create a new session", because a blank session in
  the same workspace may be reused, and that reuse does not look at permissions.

## Permission tiers and tool approval

Upstream's permission model is **two knobs**: the sandbox mode and the approval policy. The product presents
them bundled as presets.

### The three sandbox tiers

| Tier (sandbox mode) | What can be written | Typical use |
|---|---|---|
| `read-only` | Nothing | Reading code, research, review |
| `workspace-write` | **Only the session workspace** plus a private per-session temporary directory; **reads are unrestricted** | Everyday code changes (the default tier) |
| `danger-full-access` | No file-effect constraint is applied | Installing dependencies, touching paths outside the workspace |

The default preset table has two entries: `workspace-write` (= `workspace-write` sandbox + `ask` approval)
and `danger-full-access` (= `danger-full-access` sandbox + `never` approval). `custom` and `auto` are
reserved names meaning "the knob values match no preset" and "derived by the review integration"
respectively. The default preset for a new session is `workspace-write`.

The platform mechanism differs: Linux uses the kernel's Landlock plus process supervision, Windows uses
directory ACLs and a restricted token, macOS uses Seatbelt.

### Approval

- With the `ask` policy, a model call to a risky tool (writing files, running commands, driving the browser,
  uploading) asks you first. This is the first gate of "the AI proposes, the human decides".
- Approval is **one-shot**: what is approved is this one call. There is no "always allow".
- Both sandbox refusals and approval refusals come back to the model as tool errors, so it can see who
  refused and why.

### The precondition for Workspace write on Windows

On Windows, `workspace-write` first has to write a DACL on the **workspace root** (a capability write ACE
plus a Low mandatory label). Writing a DACL requires the caller to **own the directory or hold WRITE_DAC**;
without it the client **fails closed**:

- The symptom is that **every command in that workspace fails to start** (even a read-only directory listing,
  because the grant happens before the command runs), and each one has to be escalated to Full access;
- The error says plainly that this is about the directory's DACL, not about the code or the command;
- Three ways out: ① switch to a directory created by this same account in a normal (non-elevated) window on a
  **local NTFS** volume; ② have an administrator run `takeown /F "<dir>" /R /D Y` followed by
  `icacls "<dir>" /grant "<user>:(OI)(CI)F"`, then **restart the client**; ③ switch that session to Full
  access.
- The Read only and Full access tiers **do not go through** this step, so they never hit the error. On network
  drives, mapped drives and exFAT/FAT32 volumes, options ① and ② do not work.

## Capability Hub

A single sidebar entry that answers two questions: **what content can I use**, and **where does it come from**.

```text
Capability Hub
├── Mine      local creations + upload status (skills / agents)
└── Market    merged view of the grant-based marketplace and the org shared library (skills / agents)
```

- The top tabs are only the two **source** dimensions (Mine / Market); "Org" appears as a **source badge**
  inside the market view (source badges: Market / Org / Local). There is also a type filter (All / Skills /
  Agents) and a search box.
- **Multi-version merge**: same-name content is merged into one card under a `{kind}:{name}` composite key,
  expandable to its historical versions. When the marketplace and the org library hold the same name, the
  server merges them into one authoritative row (marketplace wins).
- **Quality badges**: `official` and `featured` are set by an administrator at approval time and are mutually
  exclusive. Employees cannot upload a new version of official content (the button is disabled).
- **Status badges**: installed / update available to vX / in review / rejected (with the reason).
- **Per-partition error state**: one failing endpoint only affects its own partition, which shows a Retry
  action while the others keep working.

| Operation | Behaviour and refusal conditions |
|---|---|
| Install | Installs a skill or agent package from the marketplace or the org library; a same-name local item triggers an **overwrite confirmation**. If the local same-name content has been modified, the host answers `409 LOCAL_CONTENT` |
| Update | Shows "Update to vX" when a higher approved version exists; goes through the same install confirmation |
| Uninstall | Confirms, then uninstalls. **Two cases are refused**: ① the same name still exists in a higher-priority skill root (project or user) ⇒ `422 RESIDUE`, deal with that copy first; ② the local content has been modified ⇒ `409 LOCAL_CONTENT`, deleted only after an explicit overwrite |
| Upload shared | Packages and uploads a local skill or agent (archive-safety validation runs on **both** the client and the server), which enters `pending` for admin review; a new version can be re-uploaded. The server answers `409 NAME_TAKEN` when the name is taken |
| View status | The "Mine" partition shows the review status of your own uploads (in review / shared / rejected + reason) |

**Distribution and trust model** — both sources use the same "dual gate":

- **Marketplace**: curated by administrators, then **granted** per user or department before it becomes
  visible and installable. The only tier words are Free and Pro (`price.tier`).
- **Org library**: an employee uploads → `pending` → an administrator approves or rejects (rejection
  requires a reason) → **approval alone is not enough**: a grant is still required before the item is visible
  and installable. Administrators always see everything.
- **Local**: skills and agents you wrote yourself, visible only on this machine, with no review.

## Connector Center

Connectors plug external systems in over **MCP (Model Context Protocol)**. The external contract is reduced
to **one standard MCP configuration plus a title and description** — a transport and an endpoint are enough:

```json
{ "mcpServers": { "example-mcp": { "type": "streamableHttp", "url": "https://mcp.example.com/mcp" } } }
```

- `type` accepts `streamableHttp` / `http` / `stdio` (omitted: inferred from `url` or `command`); `stdio`
  uses `command` / `args` / `env`. **`type: "sse"` is explicitly unsupported.**
- **Unknown keys are an error**, never silently ignored — a missing letter is not treated as a default.

### Auth mode: auto by default

`authMode` defaults to `auto`, decided first-match-wins:

1. Declared credential fields (`tokenFields`) ⇒ **static token** (request headers reference `${field}`);
2. Otherwise, a streamable-http endpoint ⇒ **OAuth** (the discovery URL defaults to that endpoint itself, or
   `auth.discoveryUrl` names one explicitly). At connect time the endpoint is probed: 2xx means a public
   endpoint; a 401 follows the `WWW-Authenticate` declaration through RFC 9728 → RFC 8414 discovery +
   dynamic client registration + a PKCE loopback callback;
3. Neither ⇒ **no credential at all**.

### What is refused

| Case | Result |
|---|---|
| Declaring process-bootstrap variables (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `PYTHONPATH`, `BASH_ENV`, …) | Refused. The `DSH_` / `ELECTRON_` / `PICOAIDE_` / `GIT_CONFIG_KEY_` / `GIT_CONFIG_VALUE_` **prefixes** are refused as whole families |
| The command-hook family (`GIT_SSH_COMMAND`, `GIT_ASKPASS`, `BROWSER`, `LESSOPEN`, `PERL5OPT`, `JAVA_TOOL_OPTIONS`, …) | Refused: the name looks like configuration, but the value is a command template that gets **executed** |
| Selectors such as `PAGER` / `EDITOR` / `GIT_EDITOR` | Allowed, but the **value** passes a shape gate: a single program-name shape only (no whitespace, no shell metacharacters), and the basename may not be an interpreter such as `sh` or `python` |
| An outbound target resolving to a private, reserved, loopback or cloud-metadata address | Not sent. A failed resolution always **fails closed** (codes `resolution-failed` / `resolution-timeout` / `resolution-empty`) |
| A local `stdio` connector's first run | Requires **local confirmation**: the command, arguments and environment variables are disclosed to you one by one |

### Credentials and refresh

- Credentials live under a directory **scoped per account and per server address**
  (`<data root>/users/<account>/connectors`): directory `0700`, files `0600`, atomic writes, symlinks
  refused.
- Refresh has three triggers: the MCP SDK's own 401 self-healing, a background heartbeat (60 seconds before
  expiry), and the manual refresh button in the panel. **A connector has exactly one refresh owner at a
  time**, so a single-use refresh token is never presented twice and the authorization is never revoked as
  a replay.
- Failure semantics: a dead grant (`invalid_grant` / `invalid_client`) turns the row into "needs
  re-authorization" with explicit copy; a 5xx is treated as transient and keeps the old credential; **no
  path ever opens a browser for you in the background**.
- There are five row states: disconnected / connecting / connected / unauthorized / error.

The connector panel is a set of loopback routes: `GET /api/pico/connectors` lists, and
`/api/pico/connectors/<id>/<action>` runs `connect` / `cancel` / `auth-submit` / `state` / `disconnect` /
`approve` / `deny` / `refresh`. **Every action except state polling requires a proof of possession**; without
it the handler is never entered.

## Scheduled jobs

The sidebar's "Scheduled jobs" opens the job centre. The task board was merged into it, so **there is now
exactly one kind of job**: at the scheduled time the Host process runs an agent action.

### Job model

| Field | Description |
|---|---|
| Name | Required; whitespace-only counts as missing (the UI and the model surface use the same judgement) |
| Cron expression | Five fields, minute precision; presets: daily 09:00 / hourly / every 10 minutes / Monday 09:00 |
| Content (prompt) | The task description sent to the agent. **It is data, not a command line** — the action is a closed union with no `command` or `shell` field |
| Workspace | Defaults to the current workspace, or pins another one |
| Agent preset | Defaults to the composition default, or names one; the permission field must name a preset that actually exists in this composition, and a typo is rejected at creation time |
| Permission | Pinned into the session this run creates |
| Enabled | Can be toggled at any time |

### Execution

- The **Host process** fires it: it **still runs** after you close the window or the browser page.
- Every trigger **creates a new agent session** (with the pinned workspace, preset and permission) and sends
  the prompt to it.
- Each execution record carries: trigger time, session id, prompt, start and end time, result (succeeded /
  failed / cancelled) and the error text. You can jump straight from the details to that session.
- **Missed triggers are skipped by default.** Triggers missed while the app was fully quit, or while the job's
  account was signed out, are not replayed unless you explicitly enable "catch up the most recent missed
  run" in settings — and even then only the **most recent** one.
- **A wall-clock time that does not exist because of a daylight-saving jump does not fire either** (for
  example when the clock jumps from 02:00 straight to 03:00 and 02:30 never happens). The skip is recorded
  and shown on the job panel.

### Model tool surface

Models can call five tools: `cron_create` / `cron_list` / `cron_set_enabled` / `cron_run` / `cron_remove`.
Their boundaries match the UI:

- **Owner filtering**: a job the current account cannot see is reported to the model as non-existent (it
  never leaks that the job exists);
- **Deleting a running job is refused** — deletion does not cancel the running session, so the client refuses
  rather than leaving an execution with no record;
- Users can always see and manage these jobs in the UI: the AI proposes, the human decides.

### Settings

- Enable or disable the scheduler (disabling keeps the configured jobs);
- Whether to announce the plugin's capability to the model (default **on**: it declares its capabilities and
  limits in the system prompt);
- Catch up missed triggers (default **off**).

## Built-in browser

The agent-driven browser is a **separate OS window**, not an iframe inside the main window.

- **Multiple tabs**: each tab is a `WebContentsView` running in a **per-user persistent partition**
  (`persist:agent-browser-<user>`), so its session storage and login state stay isolated from the main
  window. The tab cap is **16**.
- **Address bar**: the toolbar offers a URL input, back / forward / reload and closing tabs.
- **Created hidden**: the window is created hidden and only shown by a user action; it also **never brings
  itself to the foreground** — every focus-grabbing action first passes a gate requiring the window to be
  visible, not minimised and focused.

### Control ownership: one button, both directions

This is the interaction most easily mis-designed in this layer, so it is written down as a rule:

- **Only the "Take over" pill in the bottom-right corner can acquire control**; once acquired the **same
  pill** becomes "Hand back to AI" and returns it.
- The blank area of the mask, the activity panel and `Esc` **never** change control ownership — avoiding
  "one casual click snatching the browser away from the AI".
- While the user holds control, a model call to a browser tool gets an explicit refusal:
  "the user is operating the browser (Take over) — click Hand back to AI in the browser window and retry",
  and `browser_list_tabs` honestly reports the state in its `control` field:
  `controlled` / `busy` / `busyTool` / `awaitingRelease` / `awaitingReleaseTool`. The sidebar entry also
  lights up, because the hand-back button only exists in the browser window and a user who has returned to
  the chat window would otherwise get no signal at all.
- Control **never outlives the window**: closing the browser, destroying the window, or switching session or
  partition all reset control and the notices.

### Budget ordering (a hard constraint, not tuning)

Browser tools register a cooperative budget, and upstream's timeout policy **replaces the whole result** when
it expires — so every internal wait must be **substantially shorter** than it. Otherwise the model only ever
sees a generic `tool call timed out`, and the real reason (the user holds control, the pool is full, the page
has not loaded) never reaches it.

| Quantity | Value |
|---|---|
| `browser_*` tool budget | 30 seconds |
| User-gate wait | 10 seconds (reserving 20 seconds for the work that follows once the gate opens) |
| `browser_wait_for` condition wait cap | 40 seconds (registered deadline = 10 + 40 + 5 seconds of margin) |
| Waiting for a free tab slot before opening | 5 seconds (on expiry it raises the actionable "tab limit reached, close one first") |
| Navigation load race cap | 14 seconds (= 30 − 10 − 5 − 1; expiry only means "this call stops waiting", the page keeps loading in the background) |
| Work time kept while queued behind another operation | ≥ 1 second |
| Per-frame index wait / settle wait | 500 ms + 150 ms |

### Tool surface

**31** tools in total, grouped by purpose:

| Group | Tools |
|---|---|
| Tabs and navigation | `browser_open` `browser_navigate` `browser_reload` `browser_go_back` `browser_go_forward` `browser_list_tabs` `browser_switch_tab` `browser_close_tab` |
| Interaction | `browser_click` `browser_type` `browser_select` `browser_press` `browser_scroll` `browser_fill_form` `browser_upload_file` |
| Reading | `browser_get_snapshot` `browser_get_text` `browser_screenshot` `browser_wait_for` |
| Scripting | `browser_eval` |
| Bookmarks and history | `browser_bookmarks_add` `browser_bookmarks_list` `browser_bookmarks_remove` `browser_history_search` |
| Downloads | `browser_download` `browser_downloads_list` `browser_downloads_remove` |
| Control and credentials | `browser_takeover` `browser_fill_credentials` `browser_credentials_list` |
| Cleanup | `browser_clear_data` |

### Limits and on-disk state

| Item | Value |
|---|---|
| Single download cap | **100 MiB**; anything larger is refused outright. Other downloads ask for a save location first |
| Snapshot element count | 200 |
| Single text read | 32 KiB |
| Text per element in a snapshot | 80 characters |
| History entries / window | 5000 entries / 90 days |
| Bookmark count | 500 |
| Download record count | 200 |
| Download directory | `<data root>/downloads` |

The operation log records every navigation, click and download for audit. URLs written to disk are redacted
for sensitive query keys, while **page content and any cleartext credential you typed never enter that
log** — operations that need credentials go through the dedicated credential tools.

**Close semantics**: the user closing the window only **hides** it; only the agent's `browser_close` actually
destroys it.

## Voice input

The microphone button at the right of the composer turns **speech** into text in the composer, **enabled by
default**.

- **Recognised on the machine**: SenseVoiceSmall (whole-utterance, non-streaming) plus Silero VAD
  (segmentation) run in a **local child process** of the client. **Audio never leaves the machine** — no
  cloud recognition service and no cloud fallback, so it works offline.
- **Where the model comes from**: shipped **with the client** by default (the weights are inside the
  installer, so voice works right after install, with zero network). Only a channel that explicitly opts out
  (`desktop.speech_bundle_model: false`) falls back to downloading the int8 model (about 228 MB) on first use
  into `<data root>/speech-to-text/sensevoice`; clicking the microphone then opens a preparation surface
  (phase / progress / failure reason, cancellable and retryable).
- **Networks that only reach the internet through an authenticated proxy**: both the model download and the
  recognition child process go **direct** (see the outbound policy below), so such deployments should
  pre-place the model or point at an internal mirror in the channel package
  (`desktop.speech_model_dir` / `desktop.speech_vad_path` / `desktop.speech_model_origin`).
- **Permission**: the first recording asks the system for the microphone, and only plain-audio requests from
  **this app's main window main frame** are granted (the built-in browser and app windows have their own
  permission surfaces and are unaffected). On macOS the system prompt comes first.
- **Languages**: Chinese / English / Japanese / Korean / Cantonese, detected automatically.
- **Boundaries**: the transcript only lands in the composer (edit it before sending); it **writes no session
  event and sends nothing automatically**. One recording is capped at **120 seconds** and **4 MiB**.

## Five-track memory

Cross-session long-term memory, built into the product (vendored community plugin `dsh-memory-evolve`):

| Track | Content | On disk |
|---|---|---|
| User profile | Your stable preferences and facts | `USER.md` |
| Global facts | Environment / tooling / convention facts that span projects | `MEMORY.md` |
| Project key memory | The current project's key long-term memory, **auto-injected into context, filterable by git branch** | `projects/<project>/KEY.md` |
| Project log | The current project's session log, read on demand | `projects/<project>/MEMORY.md` |
| Daily log | A per-day work log, read on demand | `daily/YYYY-MM-DD.md` |

- **Confirmation-first**: key memories, todos and skills proposed by the AI all enter a **pending queue**
  first and are only written once you adopt them. Writes that would really change the AI's behaviour inputs
  are your decision.
- **Archiving**: main track ↔ archive file, bidirectional. Archived entries are **no longer injected into
  context** and can be moved back at any time. Archive files sit beside the main tracks:
  `MEMORY-archive.md`, `USER-archive.md`, `projects/<project>/KEY-archive.md`.
- **Isolation**: project tracks are keyed by the **session working directory**, and key memory can further be
  limited to a **git branch**. When you switch projects or resume after a few days, just ask the AI to
  "check memory" and it picks up the context.
- **Boundaries**: key memory needs a session with a working directory (without one, writes are refused);
  writes go through an atomic "temporary file + rename" path and refuse symlinks pointing outside the store —
  hard requirements once a memory directory might also be a shared folder.
- Besides memory, this plugin also provides four-track todos (life / work / project / daily) and skill
  self-evolution. Most of its extra capabilities are off by default; turn them on in the plugin's settings
  page when you need them.

## App centre

**WASM apps** written by employees: server-executed mini-apps opened in their own client window.

- **Why they are client-only**: an app window is a separate native window in the client, loaded over a
  **custom protocol** `<scheme>://<app id>`, and every outbound request the page makes is enveloped by the
  client and forwarded to the platform. Therefore **the server needs no public entry point or certificate for
  apps**, and there is no "app subdomain" layer at all.
- **How it opens**: the client's local route `POST /api/pico/wasm-apps/open`; on the platform the single entry
  point is `POST /api/client/v2/apps/wasm/:app_id/request`, forwarded with the employee token.
- **Window isolation**: app windows run in a **per-user partition**; navigation, sub-frame navigation and 302
  redirects **share exactly one origin criterion** — cross-app and external destinations are always refused,
  same-app destinations pass.
- **Reserved surface**: the `/__picoaide/` prefix inside an app page is a host-reserved namespace. Today
  **only** `/__picoaide/ai/chat` exists (handled locally by the client and never forwarded to the platform);
  everything else is a 404.

### Access modes

The `access` field of an app's `picoaide.app.json` decides who can open it:

| Value | Meaning |
|---|---|
| `public` | Reachable anonymously |
| `login` (default) | Sign-in required |
| `whitelist` | Name-list based; the list is capped at 2000, and **it must not be empty when `access` is `whitelist`**, otherwise the release is refused |

The platform **only injects the identity and the access mode into the frame**; the list comparison is done by
**the app itself**, reading its own configuration. The platform never makes that decision for it.

### Data and AI

- Every app has its own database; the author can inspect the schema and rows **read-only** from the app
  centre.
- "Allow the AI to read this app's data" is a **separate authorization** keyed by
  **user ⊕ server address ⊕ app**: switching account or server asks again, and authorization records from an
  older version are treated as **not authorized**, so one re-authorization is needed after an upgrade.
- Inside the app panel the request body is capped at **1 MiB**, the response body at **1 MiB**, request headers
  at 24, a single header value at 8 KiB, and one request at 75 seconds.

## The client is bound to the server it signs in to

This is one of the core designs of this layer: **every external source of information the client has is the
server it is currently signed in to**.

### Installers and the upgrade manifest both come from that server

- The client only asks `GET /api/client/v2/updates/manifest` for the manifest, and fetches the installer from
  **the same server** under `/updates/client/*`. It **never contacts a distribution server or GitHub, and
  does not need to know which channel it belongs to**.
- Channel identity is decided **structurally** by the server: whichever channel's content is in the image is
  the channel whose manifest and installers the server hands out. The client carries no channel identity, so
  a **version mismatch** of the "the client took another channel's manifest and washed itself into that
  channel" kind cannot happen — and that is the most severe class of incident there is (lost branding, a
  swapped data root, and sessions that look like they all disappeared).
- The client still performs one **cross-check**: the manifest's `channel_id` must be present, and once the
  server's own `/api/client/v2/channel` reports a channel id the two must be **exactly equal**. A mismatch
  makes the manifest invalid and is never retried — a misconfigured image shows up immediately instead of
  being silently accepted.

### The same server decides everything else

The model catalogue and input modalities, Capability Hub content and grants, the connector catalogue, the app
catalogue, accounts and balance, and audit — all come from this server. Changing server or account means
changing that whole context, so the client **discards outright** the in-flight state belonging to the previous
server:

- In-flight checks and installer downloads are invalidated immediately (not even recorded as a "failure"
  against the new server);
- An installer that finished downloading and was waiting to install is withdrawn;
- **Ownership is re-checked right before the installer is handed to the platform installer** (the current
  source's manifest + that version's SHA-256 + the platform container magic). If the re-check fails the
  ready-to-install state is withdrawn, and a binary of unknown origin is never handed to the installer.
  Failing to install anything is lighter than installing the wrong thing.

### When no server is connected

There is **no update source**, and therefore **no outbound check of any kind** — in standalone use the client
sends no update request at all. That is not a "failed check", it is "nothing to ask yet", and the UI copy
keeps it distinct from a network error.

## Settings and account

- **Settings**: the namespace is the **entry id** inside the profile (language, theme, scheduled jobs,
  connectors, browser, the voice preparation surface, about & updates — one row each). Upstream has retired
  the old monolithic `settings.yaml` document: it is imported once at boot and then renamed.
- **Account page**: the current account, the server address, and balance and usage (from
  `/api/client/v2/auth/usage`: `balance_money` / `balance_enabled` / `balance_monthly` / `balance_mode`, this
  month's and today's usage and cost, and whether the account is an administrator). **An account that has
  never been credited does not render a balance row** (`balance_activated` is false). The only money an
  employee can spend is the **account balance**.
- **Changing your password**:
  - Only **local accounts** show the inline password form; LDAP / OIDC users have their password managed by
    the enterprise IdP and see a note instead;
  - The new password must be at least **10** characters and must differ from the old one;
  - On success the server **revokes every token for that account**, the local session is cleared and you sign
    in again;
  - After an administrator resets a password they can force a change at next sign-in; the server then blocks
    other requests with `403 PASSWORD_CHANGE_REQUIRED`.
- **Signing out**: `POST /api/pico/auth/logout`. After signing out the update source disappears (see the
  previous section) and every panel re-resolves against the new session identity.

## Update mechanism

### When checks run

- A packaged build checks **60 seconds** after startup and then every **6 hours**.
- The tray's "Check for Updates…" and "Settings → About" run a manual check. **A manual check reports a
  result even when you are already up to date**, and honestly asks you to retry when the check fails, instead
  of going silent.

### Bounded retries for checks and transfers

| Operation | Default backoff | Attempts | Jitter |
|---|---|---|---|
| Manifest check (background) | 2 / 8 / 20 seconds | 3 | Yes (deterministic 0.25, so clients do not all retry in the same millisecond) |
| Installer transfer | 2 / 8 / 20 / 30 / 30 seconds | 5 | Yes |
| Manifest check (**manual**) | — | 1 | Making the user stare at "checking for updates…" for ninety seconds is worse than telling them "it failed, click again" |

Only **transient** failures are retried: a request that throws, 5xx/408, an empty response, an oversized
response, a checksum mismatch (= a truncated file), and a connection dropped mid-resume. **Not retried**: 4xx,
"the server has no asset for this platform", "the installer format is wrong", user cancellation, and a
manifest structure or channel mismatch (retrying cannot change the answer). During backoff the UI shows
"attempt n/N / retrying in N seconds", and the countdown is computed from an **absolute deadline**, so it
actually counts down.

### Verification

The manifest is a security boundary; any structural mismatch makes it invalid outright:

- `schema` must be **1**; `channel_id` must be present and (once the server has reported its own value)
  exactly equal;
- The download address must be **absolute https**;
- `sha256` must be 64 lowercase hexadecimal characters, and the installer is verified against it
  **streamingly**;
- Before the file is accepted, the platform container magic is checked too (macOS DMG trailer `koly`, the
  Windows PE header, Linux AppImage `AI\x02` at offset 8). One installer is capped at **1 GiB**.

If any step fails, nothing is installed and the current version keeps running.

### Download and install

- **Silent background download**: a discovered version starts transferring immediately with no dialog at
  all. Transfers **resume** (unfinished bytes stay in `.partial` next to a sidecar recording the source URL,
  SHA-256, bytes received and validators), so a retry never wastes what was already downloaded.
- **Transfers are bounded**: **60 seconds** without any byte progress counts as stalled (treated as a
  retryable network failure, keeping the resume chain), plus an attempt-level absolute budget that catches a
  peer that keeps trickling but never finishes.
- **A completed installer is reusable**: the state lives in `state.json` (`downloadedVersion` /
  `downloadedPath`, capped at 4 KiB, mode `0600`). After a restart or a source change the completed file on
  disk is first verified against the manifest SHA-256 and the container magic; on a hit it goes straight to
  ready-to-install without a second download request.
- **Installation is always triggered explicitly by the user** (tray "Install update" / the header badge /
  Settings → About). The product **never does a silent restart-and-install**. Per platform:
  - Windows: launches the downloaded NSIS installer, then requests an orderly exit;
  - macOS: opens the downloaded DMG and tells you to replace the old app in Applications;
  - Linux: `chmod +x` and a prompt to replace the current AppImage (an AppImage has no silent self-install).

### What failure looks like

Every `lastError` category has its own copy, and **different causes are never flattened into one
"network unreachable"**:

| Category | Meaning |
|---|---|
| `network` | Network unreachable (the retry budget is exhausted) |
| `not-signed-in` | Not signed in yet, so there is no server to ask |
| `server-unavailable` | The server is reachable but cannot offer a safe download address (no public https address configured) |
| `release-missing` | The manifest has no installer for this platform |
| `checksum-mismatch` / `invalid-artifact` | Verification disagreed / the installer format is wrong |
| `storage` | A permanent local failure (disk full, permissions, read-only mount) — retrying cannot succeed |
| `unsupported` | This platform has no installer convention |

### Platform assets and signing

Only **three** platforms are published: the Windows x64 NSIS installer, the macOS Apple-silicon DMG, and the
Linux x64 AppImage (the enterprise delivery surface has no deb).

- **macOS release builds are signed and notarized**;
- **The Windows installer and the Linux AppImage are unsigned** — Windows SmartScreen may warn about an
  "unknown publisher";
- The update path verifies the **integrity of the download container**, not the publisher's identity. The
  enterprise channel for silent deployment is MDM / GPO / SCCM pushing the installer directly; no client code
  change is needed.

## Plugin management and bundled runtimes

The app always runs the `desktop` profile, and the tray has **no** "open DSH terminal / switch profile / mode
switch" entry; the CLI also refuses to manage that profile. Third-party plugins are added through the
profile's **user patch layer**: edit `cordis.patch.yml` under the data root and append a row in Loader patch
syntax (the app merges that layer on every boot):

```yaml
- insert:
    - id: my-plugin
      name: my-plugin-package
```

Plugin changes need an **app restart** to enter the Loader composition. The data root differs per channel
(see the channels section of the deployment docs).

### Bundled runtimes

The client ships three runtimes, all under the app's `resources/runtimes/` and **never inside the asar**:

| Runtime | Purpose |
|---|---|
| Node.js 24 (LTS) | The agent writing and running JS; also the host that runs pnpm for `plugin_manager` |
| pnpm 11 | The package manager behind upstream's "package a capability as a bundle, then install it with `plugin_manager`" path |
| CPython 3.12 | The agent writing and running Python; ships with pip |

There is one rule, and it matters: at startup the app prepends `<resources>/runtimes/bin` to **its own**
PATH. This affects only child processes the app spawns (the agent's shell commands, MCP stdio servers, the
pnpm used to package plugins) and **leaves the system environment untouched**. Python's `pip install` target
and `.pyc` cache are redirected into the app data root, so nothing is written into the installation
directory. The agent can therefore write code and run `node` / `python3` directly, and upstream's bundle
install path no longer fails for want of a package manager.

Installing dependencies from a registry needs network access; **a local bundle inside the workspace still
works offline**.

## Outbound policy: no system proxy by default

The client **refuses to use any proxy by default**: whether the host has a system proxy configured, proxy
environment variables, PAC/WPAD auto-discovery, or an explicit `--proxy-server`, the client always connects
directly.

| Layer | Switch | Meaning |
|---|---|---|
| Real process environment | `PICOAI_ALLOW_SYSTEM_PROXY=1` | Allows the host proxy; an explicit `0` / `false` also takes effect (it is a two-way switch) |
| Channel package | `desktop.allow_system_proxy: true` | Allows it (strict boolean `true` only) |
| Default | — | Denied |

The order is first-match-wins (environment variable > channel package > deny by default). **A switch written
into the data root's `.env` layer is structurally too late**: the Chromium switch has to be appended before
`app.whenReady()`, while the `.env` layer is only loaded inside `start()`. In that case the startup log says
plainly that it was ignored instead of failing silently.

Coverage and cost:

- One startup switch covers the **default session and every later partition** (the built-in browser, app
  windows) and overrides an explicit `--proxy-server` from the host. Setting an individual session to direct
  is not enough — partitions would still go through the proxy.
- The main process's Node stack connects directly by default; if the host explicitly sets
  `NODE_USE_ENV_PROXY`, the global dispatcher is swapped for a direct agent.
- The agent's child processes (`curl` / `git` / MCP stdio) derive their environment from the parent, so proxy
  names are **explicitly removed**.
- **Cost (accepted deliberately)**: the built-in browser loses the system proxy too. Office networks where
  the internet is reachable **only** through a proxy must turn on one of the escapes above.
- **Out of reach**: L3/TUN, transparent proxies, VPNs and egress appliances.

## Troubleshooting

- **The window disappeared**: check the system tray first — closing the window is not quitting.
- **The app keeps crashing on start**: run the installed binary with `--export-diagnostics` (see "Main window
  and tray"); it does not start the Host and prints the absolute path of the diagnostics ZIP.
- **A plugin did not show up**: confirm the patch is in the **current channel's data root**, then restart the
  app.
- **No update notification**: background failures are silent; use the tray's "Check for Updates…" to see the
  real verdict, which distinguishes "already up to date", "no server to ask" and "the server cannot offer a
  download address".
- **A download seems stuck**: 60 seconds without byte progress counts as stalled and is retried; seeing
  "attempt n/N / retrying in N seconds" means it is in backoff.
- **A fixed port clashes**: set the port back to `0` (random) or pick a free one. Changing the port triggers
  one orderly restart.
- **Workspace write reports a directory permission error (Windows)**: see the three ways out under
  "Permission tiers and tool approval".
- **Browser tools keep timing out**: look at the bottom-right of the browser window first — if the user holds
  control, the model receives an explicit "hand control back" rather than a timeout. Confirm the control
  state before investigating the page itself.
- **Developer debugging**: the debug port (9223) being occupied by a residual instance causes reuse of the
  wrong instance — clear the old instance before troubleshooting (use the bracket trick so the shell invoking
  the command is not killed too).

## Related

- [Quick start](/en/getting-started/): from receiving a server address to sending the first message.
- [System architecture](/en/architecture/): the processes, data and interface boundaries of the three layers.
- [Enterprise control plane](/en/admin/): the **server-side** configuration behind models, quota, Capability
  Hub approvals, the connector catalogue and the app centre.
- [Client delivery and upgrade](/en/deployment/client-delivery/): how the server hands out installers and the
  upgrade manifest.
- [Channels and white-label](/en/deployment/channels/): how the data root, deep-link scheme, names and assets
  are decided per build.
- [Deployment overview](/en/deployment/): images, certificates, backup and rollback.
- [App centre](/en/apps/): configuration contract, publish chain, runtime boundaries and failure behaviour for employee-built apps.
- [Security & compliance](/en/security/): implementation details and acknowledged limits for keys, tokens, sandboxes, egress and audit.
- [Plugin development](/en/plugin-development/): writing a plugin and installing it into the client.
- [API reference](/en/api-reference/): the server endpoints the client calls.
- [FAQ](/en/faq/).
