---
title: Product Philosophy
description: 'Seven design principles together with their evidence in this repository: everything is a plugin, the control plane lives on the server, the client is bound to its server, deny by default, data stays on the customer machine, AI proposes and humans decide, and the upstream version is pinned — plus what each principle costs.'
---

PicoAide Harness is not "a pile of features" but a set of **design trade-offs with explicit boundaries**. This page states seven principles, gives **evidence you can check in this repository** for each of them (configuration keys, code paths, observable behaviour), and finishes with the **costs** of those trade-offs — a trade-off without a cost usually means it has not been thought through.

The test is simple: if a principle has no landing place in the code, it does not belong on this page.

## 1. Everything is a plugin: the desktop itself is a plugin

**Principle**: the whole product runs through the same Cordis plugin composition path as upstream — no second plugin system, no whole-tree fork.

**Evidence**

- Upstream sits at a fixed version in `deepseek-harness/` (a git submodule), and the source of truth is `upstream.json` at the repository root (`repository` / `commit` / `sourceVersion`).
- The desktop shell is an **ordinary plugin row**: `packages/host/desktop/cordis.patch.yml` declares `desktop-shell` (`dsh-plugin-desktop`) plus `desktop-diagnostics`, `desktop-updates`, `desktop-loop-notify`, and so on through `- insert:`. Enterprise capabilities are rows too: `packages/host/enterprise/cordis.patch.yml` declares `picoaide-enterprise`, `picoaide-session`, `picoaide-auth-gate`, and the rest.
- UI capabilities are injected through upstream's slot mechanism and service capabilities through service contracts; the only things the desktop exposes to third parties are explicit contracts such as `desktopRuntime.registerTrayItem` / `desktopActions` (`packages/host/desktop/docs/plugin-services.md`). The window, tray, and packager internals are **not** third-party API.
- Because the desktop shell is a plugin, "replace one upstream row" is a configuration-level operation: `packages/host/desktop/cordis.patch.yml` both disables rows we do not need (`disabled: true`) and overrides whole-row `config` values.

**Cost**

- Public contracts (slots, services, subpath exports) become a compatibility surface: changing them is changing an API, which requires a decision record and a guard.
- Changes to upstream defaults land directly in the product composition. Upgrades must re-check "which rows are now enabled by default and which defaults flipped" instead of assuming "we did not touch it, so we are unaffected" — the upgrade decisions under `docs/decisions/` exist for exactly that reason.

## 2. The control plane must live on the server

**Principle**: anything that "can be abused" — keys, model catalogue, metering and billing, content authorization, audit — is folded back to the server; the client only draws what the server decides.

**Evidence**

- The namespaces fix both sides: `server/internal/router/router.go` centrally declares `/api/server/*` (admin surface, `AdminAuth` + per-route RBAC declarations) and `/api/client/v2/*` (employee surface, Bearer), with `/v1/*` as the model gateway.
- Upstream keys exist only on the server: `server/internal/util/crypto.go` encrypts with AES-GCM (ciphertext prefix `enc:v1:`) and keeps the master key in a separate file `master.key` (`0600`, never stored in the database). The client only ever holds its own session token, and its model endpoint is `<server>/v1`.
- Metering and balance are hard gates: `server/internal/llmgateway/balance_gate.go` returns `429 BALANCE_EXHAUSTED` when the balance is insufficient (administrators are exempt; a settings read failure fails closed), an unpriced model is rejected with `429 MODEL_NOT_PRICED` unless an explicit policy switch allows it, and usage plus balance deduction happen in one transaction.
- Audit is tamper-evident: `server/internal/serverstore/audit.go` writes a hash chain with `prev_hash`, so editing any row breaks every subsequent link.
- Authorization is decided on the server and **does not leak existence**: unauthorized Market/Org content is a plain 404 (the classification tests in `server/internal/marketplace/` separate "dependency failure" from "does not exist", and the latter must stay an indistinguishable 404).
- The client has **no** local model configuration: in the enterprise composition `ui-settings-models` is `disabled: true`, the upstream `llm-deepseek` row is disabled and replaced by an in-house gateway provider row (`packages/host/enterprise/cordis.patch.yml`), and request headers are decided by the gateway token.

**Cost**

- No server, no model: while signed out the client has no usable model route. That is a direct consequence of "keys live only on the server", not a failure.
- The server becomes a layer you must operate: accounts, balance, and the model catalogue depend on it, so the customer owns its deployment, backup, and upgrades (see [Private Deployment](/en/deployment/)).
- Every clever idea on the client side must be suppressed: any local exemption, local pricing, or local authorization decision contradicts this principle.

## 3. The client trusts only the server it signed in to

**Principle**: the client has exactly one source of external information — the server it is currently signed in to. Channel identity is decided **structurally** by the server; the client carries no channel identity.

**Evidence**

- The update source is **session-derived**: `packages/host/desktop/src/updates.ts` listens for `pico/session-changed` and reads `serverURL` from the session; when `serverURL === null` (signed out) there is **no update source** and no outbound check is made. Switching servers invalidates in-flight checks and downloads wholesale (a session epoch counter), and an already-downloaded installer is withdrawn.
- Manifests and installers come from the same server: `GET /api/client/v2/updates/manifest` and `/updates/client/*` both live on the server (`server/internal/clientrelease/`); the client **does not visit the update server or GitHub**.
- Channel reconciliation is a hard criterion: the manifest's `channel_id` must exist and must be exactly equal to the channel id the server reports at `/api/client/v2/channel`; a mismatch makes the manifest invalid with no retry.
- The model path is bound to the session as well: `packages/host/enterprise/src/gateway-model.ts` sets `baseURL` to `${session.serverURL}/v1`, and the sign-in page, channel content, model catalogue, Capability Hub, and connector catalogue all come from this server.
- The binding also shows up in the **data plane**: connector credentials are scoped by (account + server address), so credentials from one server are never reused for another.

**Cost**

- There is no "download the client from the website" path: installers are served by the server ([Client delivery & updates](/en/deployment/client-delivery/)), which is also why a public channel image must carry `client/`.
- The client cannot be pointed at some other update source; changing where versions come from means changing servers. That is deliberate — it rules out a class of incidents where a client gets "washed" into another channel and loses its brand and data root.
- Switching servers or accounts swaps the entire context: in-flight state is discarded and the user signs in and re-authorizes connectors again.

## 4. Deny by default

**Principle**: every "just let it through" default is inverted — file effects, processes, outbound traffic, local write surfaces, and renderer permissions all deny by default, and allowing something requires a human or explicit configuration.

**Evidence**

- Permissions are **two knobs** (sandbox + approval) presented as presets; upstream `packages/interaction/permission-presets` ships only `workspace-write` (+ approval `ask`) and `danger-full-access` (+ approval `never`), and a new session defaults to the former. Approval is **per call** — there is no "always allow".
- The sandbox is implemented per platform: Landlock on Linux, directory ACLs on Windows, Seatbelt on macOS. On Windows, `workspace-write` must first write a DACL on the workspace root; if it cannot, the behaviour is **fail-closed** (every command in that workspace refuses to start), and the error says plainly that this is a directory DACL problem rather than a command syntax problem.
- Local write surfaces require **proof of possession**: `packages/host/desktop/src/write-proof.ts` validates upstream `connection`'s `dsh-auth-*` cookie on non-GET requests, answering 403 when the proof is insufficient and 503 when the mechanism is absent — never a pass.
- Connector outbound traffic fails closed: `packages/host/connectors/src/outbound.ts` allows https (or loopback http) only, refuses private / link-local / metadata addresses, pins `redirect: 'manual'` so a 3xx is refused instead of followed, and treats an unverifiable name resolution (failure, timeout, empty answer) exactly like a name that resolves into a non-public range; the verified addresses are handed to the connection so there is no second resolution (no TOCTOU).
- The renderer has no permissions by default: the main window's permission handler refuses everything except the clipboard for the top-level document of this installation's loopback origin (the built-in browser and app windows each manage their own permission surface).
- Outbound proxies are banned by default: `packages/host/desktop/src/network-policy.ts` ignores system proxy settings, proxy environment variables, PAC files, and `--proxy-server`; the only escape hatches are the channel field `desktop.allow_system_proxy` or the **real process environment variable** `PICOAI_ALLOW_SYSTEM_PROXY=1`.
- The server side denies by default too: unauthorized content is invisible (404 without leaking existence), every admin route must declare a permission point, and login rate limiting counts **failures only** (a success clears the counters).

**Cost**

- More friction: writing files, running commands, and driving the browser all ask for confirmation, and approvals carry no "remember this choice".
- Some environments need explicit configuration to work at all: Windows workspaces need the right DACL; networks where "only an authenticated proxy reaches the internet" must open the proxy escape hatch; and some edge cases **fail on purpose** (for example, an unverifiable DNS answer refuses a connector connection) instead of degrading to a pass.
- Troubleshooting must separate "refused" from "broken": refusals carry explicit codes and wording (`403` proof of possession, `429 BALANCE_EXHAUSTED`, connector refusal reasons), while failures are a different signal.

## 5. Data stays on the customer's own machines

**Principle**: the default location for sensitive data is the employee machine and the customer's own server. **The vendor is not in the data path.**

**Evidence**

- Local data has exactly one authoritative directory: `packages/host/desktop/src/desktop-home.ts` defines the Harness home (`~/.picoaide-harness`, with `DSH_HOME` taking precedence and a different directory per channel), under which sessions, settings, workspaces, and skills live; the platform checks whether it falls inside critical system directories and refuses to write session tokens where an attacker on the same machine could read them.
- Connector credentials live in a scope directory split by (account + server) (`packages/host/connectors/src/user-scope.ts`), with `0700` directories, `0600` files, and atomic writes that guard against symlinks and path escape.
- The local Harness service listens only on `127.0.0.1`; session content, workspace files, tool execution, sandbox state, and audio all stay on the employee machine.
- The server stores only what it must know: accounts, model usage and cost, the balance ledger, content and authorization, and audit events. It does **not** touch employee files or session logs.
- Model requests travel through the customer's own server to the upstream provider the customer configured: upstream API keys are encrypted on the customer's server, and the customer chooses where the content goes — the vendor neither hosts nor relays it.

**Cost**

- No cross-device sync: moving to another machine does not carry sessions and workspaces along (the direct cost of data sovereignty).
- Data on the employee machine is the customer's responsibility: a broken local disk is not backstopped by the server; see [Upgrade, backup & rollback](/en/deployment/upgrade/) for the server-side backup story.
- Using a cloud model requires the customer to provide egress and keys; in an air-gapped deployment, the customer also provides the model exit path.

## 6. AI proposes, humans decide

**Principle**: any write that would **actually change AI behaviour** or **become visible to others** first enters a pending-confirmation or pending-approval queue and only takes effect once a human or administrator approves it.

**Evidence**

- Tool calls are approved per call: writing files, running commands, driving the browser, and uploading all ask for confirmation, and an approval covers that call only. Both sandbox refusals and approval refusals return to the model as tool errors, so the model can see who refused and why.
- Capability distribution is an **approval + authorization two-gate model**: an uploaded skill or agent sits in `pending`, an administrator approves it, and it still has to be authorized for specific people before it becomes visible and installable. Unauthorized content stays invisible, and ownership belongs to the first publisher who claimed the name.
- Memory is confirmation-first: the vendored plugin `packages/vendor/memory-evolve` defaults to `reviewMode: 'suggest'` — the AI files suggestions through `memory_suggest` into the pending queue and only writes once the user accepts. Todos work the same way.
- Scheduled jobs are created by **humans** (cron + prompt + workspace + preset + permissions); the model can only act through explicit tools (`cron_create` / `cron_list` / `cron_set_enabled` / `cron_run` / `cron_remove`) within the set of jobs the user can see, a job it cannot see is reported as missing, and **a running job refuses deletion** (deleting would not cancel the live session, only lose its record).
- App-side authorization is explicit: the consent record that allows the AI to read an app's data is scoped by (user + server + app), and a missing scope fails closed rather than writing.
- Browser control only changes hands through **one button, in both directions**: "Take over" acquires it and "Hand back to AI" returns it; the mask's empty areas, the activity panel, and `Esc` never change it.

**Cost**

- One extra click: the AI cannot silently make itself smarter, because memory and skill evolution need user confirmation.
- Deliberate capability ceilings: the model cannot bypass approval to "do it first and ask later", nor expand its own behavioural inputs.
- "AI proposal" and "user intent" must stay distinguishable: approval cards, pending queues, and review states are that boundary and must remain visible in the UI.

## 7. The upstream version is pinned, not modified

**Principle**: the upstream DeepSeek Harness runs unchanged at a fixed version (currently pinned at `dsh-v0.2.0-rc.2`; the source of truth is `upstream.json` at the repository root). Product capabilities come from plugin composition plus a **small number of guarded patches**, never a whole-tree fork.

**Evidence**

- Upstream is a git submodule (`deepseek-harness/`) that is not edited on this branch; the upgrade entry point is `scripts/upgrade-upstream.mjs`.
- The patch set is small and individually registered: every file under `patches/` is named `<package>@<upstream version>.patch` and is watched by guards — `scripts/verify-patches.mjs` (did the patch actually apply), `scripts/check-patch-pin.mjs` (do patches and the pin agree), `scripts/verify-patch-resolutions.mjs` (are resolutions fully registered), and `scripts/patch-targets.mjs` (do the patch targets still exist).
- Every upstream upgrade leaves a decision record (under `docs/decisions/`) stating which patches must be re-cut, which upstream defaults must be explicitly disabled, and which behaviour changes need user-visible notes.
- Upstream defaults are **explicitly rewritten** rather than left alone: the enterprise composition disables upstream's model-settings row and local provider row, and the desktop composition turns off product analytics/telemetry rows and unneeded upstream rows, each pinned by a guard (for example `verify-profile-boot.mjs` cross-checks its `mustStayDisabled` list against `cordis.patch.yml` in both directions).

**Cost**

- An upgrade is a **work item**: patches must be re-cut (their targets are hash-named build artefacts), defaults must be re-checked one by one, and packaging plus runtime gates must be re-run.
- New upstream features cannot just be picked up casually: a capability either waits for an upgrade or is implemented as a plugin.
- Patches are long-term debt: each one carries a "why it must exist" guard, and when upstream merges the same fix the patch must be deleted rather than kept.

## 8. Deliberate trade-offs and their costs

The table below turns the seven principles into concrete trade-offs. The "cost" column is what this choice **does** cost — not a to-do list.

| Trade-off | What we chose | What it costs |
|---|---|---|
| Delivery shape | The client trusts only the server it signed in to, and installers ship with the image | No public download site; changing where versions come from means changing servers |
| Keys and billing | Upstream keys live only on the server (AES-GCM encrypted); balance is the only billing gate | No usable model while the server is unreachable, and the customer must run and operate a server |
| Data location | Sessions, files, sandbox, and audio stay on the employee machine | No cross-device sync, and a broken local disk is not backstopped by the server |
| Client size | Electron + the pinned DSH + Node/pnpm/Python runtimes ship inside the installer | Installers are hundreds of megabytes, buying "install and use, zero external dependencies" |
| Update method | Checks and downloads are silent, but **installation is always user-triggered** | Upgrades are one step slower than a silent restart-and-install, in exchange for not interrupting local unsaved work |
| Outbound policy | System proxies and proxy environment variables are ignored by default | Networks where only an authenticated proxy reaches the internet must open the escape hatch explicitly |
| Plugin management | A fixed `desktop` profile, with third-party plugins added through the user patch layer | No profile switcher and no terminal entry point, and changes only enter the Loader composition after a restart |
| Content and branding | Branding comes from channel content injected at build time, not from the admin console | Changing one sentence means rebuilding that channel's image |
| White-label isolation | Each channel gets its own app id, data root, and single-instance lock | Cross-channel installation is a **side-by-side** install rather than an upgrade, so one machine can end up with two clients |
| App shape | Apps open only inside a client window, and the server needs no public entry point or certificate for them | Apps cannot be shared as browser links; they open through deep links in the client |

The operational side of these trade-offs is in [Deployment overview](/en/deployment/), [Client delivery & updates](/en/deployment/client-delivery/), and [Channels & white-label](/en/deployment/channels/); the concrete UI behaviour behind each principle is in [Desktop Client](/en/desktop/) and [Enterprise control plane](/en/admin/).

## Related

- [Welcome](/en/welcome/) — the three layers and the supported / unsupported list
- [Getting Started](/en/getting-started/) — from installer to first message
- [System architecture](/en/architecture/) — start-up order, the Host/Client boundary, and packaging
- [FAQ](/en/faq/) — behaviour and boundaries by topic
