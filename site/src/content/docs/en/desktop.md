---
title: Desktop Client
description: 'Complete feature and usage guide for the PicoAide Harness desktop client: chat, Capability Hub, connectors, scheduled jobs, browser, memory, and auto-updates.'
---

The desktop client is the product surface employees use every day. It packages the official DeepSeek Harness local agent runtime into a native app: window, tray, auto-updates — **no need to install Node.js or run any commands**.

## Main Interface

- **Native window**: a standard desktop window, with its own frame in advanced mode, native material (macOS vibrancy / Windows Mica provided by the platform), and native draggable regions;
- **System tray**: closing the window hides it by default rather than quitting; the tray offers "Open window / Check for updates / Export diagnostics / Quit" (Profile is fixed to desktop, with no tray switcher and no DSH terminal item);
- **Local web port**: assigned randomly by the system by default (`dsh-desktop.port: 0`) to avoid port conflicts; the server only listens on `127.0.0.1`. If a UI plugin depends on a stable origin (localStorage is isolated per origin), you can fix a port in settings;
- **Single instance**: launching again focuses the existing instance.

### Profiles and Modes

| Concept | Description |
|---|---|
| **Profile** | A combination of a DSH bundle, dependencies, and patches; the product **runs the fixed `desktop` profile**, with no tray switcher and no profile selector. A custom configuration (patch) that deliberately redirects a persistence root follows that profile's own settings |
| **Advanced mode** | The product always uses advanced mode: it injects the desktop-owned frame, layout, and native material without changing the upstream Web carrier; Linux uses an ordinary system window frame (no Mica / hidden-inset) while the layout stays in advanced mode |

Restart the app after plugin changes so the new bundle enters the Loader composition.

## Chat and Agents

- **Session**: each session has independent context and can specify a workspace (project directory); session listing, search, and recovery are provided by the official Harness semantics;
- **Models**: the enterprise edition fetches the model list through the server gateway (`/api/client/v2/config/bootstrap`); model availability and quota are decided server-side;
- **Context management**: sessions can clear/rebuild context at any time; execution details and the message flow follow the official UI;
- **Permission approval**: when a model calls a risky tool (write files, run commands, operate the browser), it asks the user for confirmation under the upstream permission gate — this is the first gate of "AI only proposes".

## Capability Hub

A single sidebar entry, replacing the earlier "Skill Center + Shared Agent" parallel panels. It answers two questions: **"What content can I use?"** and **"Where does it come from?"**.

### Information Architecture

```
Capability Hub
├── Mine (local creations + upload status)
│     ├── Skills (local SKILL.md)          — Upload shared / Re-upload / View review status
│     └── Agents (local agent preset)      — Same as above
└── Market (grant-based marketplace + org shared library merged view)
      ├── Skills
      └── Agents
```

- The top tabs are only "Mine / Market", the two **source dimensions**; the "Org" source appears as a badge within the market view (source badge: Market / Org / Local);
- Type filter: All / Skills / Agents; plus a search box;
- Status badges: **Official / Featured** are marked by admins at approval time; **Installed / Update available (Update to vX) / In review / Rejected (with reason)** come from the shared library state machine;
- Multi-version merge: same-name (`{kind}:{name}` composite key) multiple versions merge into a single card; expand to see historical versions; same-name market and org content is merged by the server into one authoritative row (market takes priority);
- Partition-independent error state: one endpoint failing only affects the corresponding partition, which shows "Retry"; the others keep working.

### Key Operations

| Operation | Behavior |
|---|---|
| **Install** | Install a skill or agent package from the market/org; if a same-name item already exists locally, an **overwrite confirmation dialog** appears (decision: no `?force=1` assumption interface, client-side confirmation only) |
| **Update** | Shows "Update to vX" when an item is installed and a higher approved version exists; goes through the same install confirmation |
| **Uninstall** | Confirms, then uninstalls and removes the local directory |
| **Upload shared** | Package and upload a local skill/agent (`packSkill` / `packPreset`, archive-safety validation on both sides), which enters `pending` awaiting admin review; you can re-upload a new version |
| **View status** | The "Mine" partition shows the review status of your uploaded content (In review / Shared / Rejected + reason) |

### Distribution and Trust Model

- **Market (marketplace)**: curated by admins; visible and installable only after **authorization** per user/department; the tier word is Free / Pro (`price.tier`);
- **Org (shared library)**: employee uploads → `pending` → admin approve/reject (reject requires a reason) → **after approval, it still requires authorization (user or department) to be visible and installable** — the same "dual gate" as the marketplace; admins always see everything;
- **Local**: skills/agents you created yourself, visible only on this machine, no review.

## Connector Center

Connectors plug external systems into the Agent over **MCP (Model Context Protocol)**. Currently built in:

| Connector | Description |
|---|---|
| **SalesEasy NeoCRM** | Official streamable-HTTP MCP (`mcp.xiaoshouyi.com`), RFC 8414 OAuth (authorization code + PKCE + dynamic client registration); query customers/leads/opportunities/contacts, execute XOQL and metadata operations |
| **Moka HR** | Recruitment and HR all-in-one AI colleague: talent recommendations, recruitment updates, attendance & performance, approval todos; smart talent sourcing, interview analysis, and interviewer evaluation; OAuth + streamable-http |

- Authorization uses **OAuth authorization code + PKCE** (`offline_access` for a refresh token), with state validation and a 60s timeout against CSRF;
- Credentials are **encrypted and stored locally** under the user scope path (`0600/0700`, atomic write, anti-symlink); after a successful connection the tool **registers the MCP dynamically** via `ctx.plugin`, so the model can call its tools;
- Connector definitions are extensible (`options.connectors`); third parties can register their own MCP defs.

> Historical note: the early "CLI connectors" (dws/wecom-cli/lark-cli/beisen-cli, etc.) have been fully removed. CLI vendor capabilities are now distributed **as SKILL.md via the skill store**, and MCP capabilities go through the connector framework — this is the final "skills + MCP" two-standard-form architecture (2026-08-26 decision).

## Scheduled Jobs

The sidebar "Scheduled jobs" opens the task center. **The task board was merged into scheduled jobs in v2.3.0** — there's now only one kind of task: at the scheduled time, the Host process runs an **agent action**.

### Task Model

A task = cron expression + execution content + execution environment:

| Field | Description |
|---|---|
| Name | Custom |
| Cron expression | Minute-level precision; presets: Daily 09:00 / Hourly / Every 10 minutes / Monday 09:00 |
| Execution content (prompt) | The task description sent to the agent |
| Project (workspace) | Current project by default, or another workspace |
| Agent to run | Deployment preset by default, or chosen from agent presets |
| Permission | None / Read only / Workspace write / Full access |
| Enabled | Enable/disable as needed |

### Execution and Details

- Runs via the **Host process** at the scheduled time: it **still runs** after you close the window or the browser page (missed triggers during a full app quit are skipped by default; enable "catch up the most recent missed run" in settings);
- Each run **creates a new agent session** (with the specified workspace, preset, and permissions) and sends the task prompt to that session;
- Execution details: trigger time, start/end time, result (Succeeded / Failed / Cancelled), error message, and the **opened session** — you can jump straight from the details to that session to continue (session jump);
- Manual "Run now" is supported; jobs can be enabled/disabled/deleted;
- Models can call the `cron_create` / `cron_list` / `cron_set_enabled` / `cron_run` tools directly — but users can always see and manage these tasks in the UI (AI only proposes, humans decide).

### Settings

- Enable/disable the scheduler (disabling keeps the configured jobs);
- Whether to announce plugin capability to agents (declared in the system prompt so models can collaborate);
- Catch up missed triggers (off by default).

## Embedded Browser

The agent-driven embedded browser lives in a **separate browser window** (2026-08-20 window model):

- **Multiple tabs**: each tab is a WebContentsView with a persistent browser partition (stable session storage);
- **Address bar**: the toolbar provides a URL input for manual navigation, back/forward/reload, and closing tabs (fixed from the 2026-08-21 audit P0);
- **Control ownership**: only the "Take over" pill in the bottom-right corner can acquire control; once acquired, the same pill becomes "Hand back to AI" and hands it back. The blank area of the mask, the activity panel and `Esc` **never** change control ownership — avoiding "one casual click snatching the browser away from the AI";
- **Download control**: downloads default to a 100MB limit and are rejected over it; other downloads ask for a save location (user confirmation);
- **Operation log**: an op log records every navigation, click, and download for audit;
- **Close semantics**: the user closing the window only hides it; only the agent's `browser_close` actually destroys the window.

> The right Sidebar is the official `ui-sidebar-right` (a per-session dock: draggable, splittable, floatable tab panes, with a shipped guide page, workspace file tree and document preview). It is a **preview and files** surface — no code editing, interactive terminal or Git panel. The product browser is still reached from the "Browser" action at the bottom of the sidebar.

## Memory (Five-Track Memory)

Built into the product (vendored community plugin **dsh-memory-evolve**), this is **cross-session long-term memory**:

| Track | Content |
|---|---|
| User profile | The user's stable preferences and facts |
| Global facts | Environment/project facts (cross-project) |
| Project key memory | The current project's key long-term memory (**auto-injected into context, filtered by git branch**) |
| Project log | The current project's session logs (read on demand) |
| Daily log | Daily work logs (read on demand) |

- **Confirmation-first**: AI-proposed memories/todos/skills all enter the **pending-confirmation queue** first; they're only written once you adopt them (the AI won't change its own behavior inputs unilaterally);
- **Archivable**: main track ↔ archive file, bidirectional; low-frequency old items are archived so they're no longer injected, and can be restored anytime;
- **Cross-session continuity**: switch projects or resume after days and just ask the AI "check memory" — it retrieves memory to continue the context without you repeating yourself;
- The memory system also provides todos (life/work/project/daily tracks) and skill self-evolution (local mode, local storage).

## Settings and Account

- **Settings**: General (language/theme), scheduled jobs, connectors, browser, about & updates, and other sections;
- **Account page** (enterprise edition): current account, server address, quota/balance (from `/api/client/v2/auth/usage` — today's/month-to-date accumulated cost, remaining quota), sign out (signing out triggers session release; connector, browser, and scheduled job tokens are all cleared);
- **Upgrade badge**: a new-version notice appears at the top right of the session header (blue dot + version number); click to download, with progress shown during download; the tray menu syncs the upgrade status;
- **Diagnostics export**: tray "Export diagnostics…" generates a `diagnostics-*.zip` (version, profile, logs, env summary, sanitized before output).

## Update Mechanism

- **There is only one upgrade source**: the server the client is logged into (`GET /api/client/v2/updates/manifest`). The client never contacts an update server or GitHub, and does not need to know which channel it belongs to — the channel identity is decided structurally by the server;
- **When checks run**: the first check runs 60 seconds after startup, then once every 6 hours; the tray **Check for Updates…** and "Settings → About" allow a manual check (a manual check shows a result even when already up to date, and asks you to retry later when the check fails);
- **Verification**: the manifest `schema` must be `1`, `channel_id` must match the server, and the download address must be absolute https; the installer is verified with a **streaming SHA-256** check against the manifest; if any step fails, nothing is installed;
- **Platform assets**: Windows NSIS installer, macOS DMG (Apple silicon), Linux AppImage (`x86_64`). On Linux, the download is followed by `chmod +x` and a prompt asking the user to replace the current AppImage and restart (AppImage has no silent self-install);
- **Failure never breaks the installed version**: network errors, non-200 responses, invalid versions or verification failures all stay silent and the installed version keeps working; when the server explicitly says it cannot provide a download address (`client_unavailable`), the UI says so honestly instead of pretending to be "already up to date";
- **No update source when not connected to a server**: no outbound check is performed at all (standalone usage);
- **Unsigned note**: the Windows installer and the Linux AppImage are unsigned (macOS release builds are signed + notarized); Windows SmartScreen may warn about an "unknown publisher".

## Terminal and Plugin Management

The app runs the fixed `desktop` profile and has no "Open DSH terminal / Switch Profile / mode switch" tray entry.
Since upstream 0.1.5 that profile name is **reserved**: both `dsh --profile desktop` and
`dsh plugin --profile desktop` are rejected by the CLI (`profile "desktop" is managed exclusively
by the Electron application`). Third-party plugins are added through the profile's user patch layer
instead — append a row to `~/.picoaide-harness/cordis.patch.yml`, which the app merges on every boot:

```yaml
- insert:
    - id: my-plugin
      name: my-plugin-package
```

The app ships its own DSH dependencies and does not modify the system-wide PATH or shell config. After plugin changes, restart the app to enter the Loader composition.

## Troubleshooting

- **App only goes to the tray**: right-click the tray → "Export diagnostics…" → generates and opens `diagnostics-*.zip`;
- **App keeps crashing**: run the installed binary with the `--export-diagnostics` flag (Windows example: `& "$env:LOCALAPPDATA\Programs\PicoAide Harness\PicoAide Harness.exe" --export-diagnostics`); this command doesn't start the Host, and outputs the absolute path of the diagnostics ZIP; `dsh-desktop --export-diagnostics` works the same after an npm install of the launcher;
- **Diagnostic archive contents**: recent logs, local Crashpad `.dmp` files, the active-run marker, and `system-info.txt` (Desktop / Electron / Node / platform / architecture versions); logs mask recognized credentials, but local paths, workspace IDs, session IDs, and crash-time memory fragments may remain — review before public upload and route sensitive dumps through a trusted channel;
- **Port-fixed conflict**: set `dsh-desktop.port` back to `0` (random) or use a free port;
- **Window disappeared**: check the system tray first; closing the window is not quitting;
- **Plugin missing**: confirm the command targeted the intended profile (the app uses the fixed `desktop`) and restart the app;
- **No update notification**: background failures are silent; use the manual tray check to see the result;
- **Developer debugging**: the CDP debug port (9223) being occupied by a residual instance causes reuse of the wrong instance — `pkill` the old instance before troubleshooting (use the bracket trick to avoid killing the shell).
