---
title: FAQ
description: 'Answers to the questions people actually ask, grouped by topic: deployment and data, client and updates, models and keys, capabilities and connectors, open source and licensing — each with concrete behaviour and boundaries.'
---

This page is grouped by topic; the questions are phrased the way you would actually ask them, and the answers give **concrete behaviour and boundaries** (error codes, defaults, refusal conditions), with links to the full pages where needed.

## Deployment and data

### Does the client have to sign in first, and to which server?

Yes. **While signed out, the first page in the main window is the sign-in page**: enter the server address → choose a sign-in method (local account / LDAP / OIDC) → after a successful sign-in the same window switches to the app UI. Remote addresses must be `https` (`http` is allowed only for `localhost` / `127.0.0.1`), and a channel package with a built-in address pre-fills and skips that step.

Your account, the model catalogue, balance, Capability Hub content, and the connector catalogue all come from this server. For deployment shapes (containerised on the customer network, merged into an existing reverse proxy, single machine), see [Private Deployment](/en/deployment/).

### Who holds my data?

It splits in two, with a clear boundary:

- **On the employee machine**: sessions and message logs, workspace files, tool execution, sandbox state, voice audio, connector credentials. The data root has a single authoritative definition (`~/.picoaide-harness`, with `DSH_HOME` taking precedence and a different directory per channel); credential directories are `0700`, files `0600`, written atomically.
- **On the customer's own server**: accounts, model usage and cost, the balance ledger, content and authorization, audit events. The server does **not** touch employee files or session logs.

The vendor neither hosts a service nor relays your data. **Every path that leaves the machine is one you configure**: model requests go from the employee machine to your server, which forwards them to the upstream provider you chose, and connectors only reach the MCP endpoints you registered in the admin console. With a cloud model the content reaches that provider; with an intranet model it never leaves your network.

### How many certificates do I need, and which mode should I pick?

`TLS_MODE` has three choices: `internal` (Caddy's local CA signs itself; for intranet IPs, and clients must trust that CA on first connection), `auto` (public domain with automatic issuance; needs a direct A record and ports 80/443 — it fails behind a CDN), and `manual` (your enterprise certificate; supports IPs). See the certificate section of [Deployment overview](/en/deployment/) and [Container Deployment](/en/deployment/compose/).

### Will an upgrade lose data? How do I roll back?

An upgrade only swaps the image; all data lives in bind mounts under the deployment directory (`picoaide-data/`, `pg-data/`, `caddy-data/`, `certs/`). Rolling back means switching back to the previous image and running `docker compose up -d server` — but **database migrations are irreversible**: an older image cannot downgrade the schema, so you must back up before upgrading and confirm the backup is non-empty (`master.key` is unrecoverable, and without it the encrypted upstream keys in the database can never be decrypted).

Four hard rules: never run `docker compose down -v` or `volume prune`; never use the `latest` tag; always back up before upgrading; never overwrite an existing deployment directory with `.env`. The full flow is in [Upgrade, backup & rollback](/en/deployment/upgrade/).

### Can I merge it into an existing reverse proxy, or use an external PostgreSQL?

Yes. The deployment shapes include "run only `server + postgres` and mount it into an existing vhost", and a single binary with external PostgreSQL (including migrating from systemd). Note that container IPs and trusted-proxy settings must change together, otherwise client-IP attribution in audit logs and the login rate-limit buckets become wrong — see [Operations & troubleshooting](/en/deployment/operations/).

## Client and updates

### Where do I download the client installers?

Only two sources: **your enterprise server's portal page** (`https://<enterprise-domain>/`, a public page listing download entries for all three platforms) or the **official image package** (unpack the `client/` directory, see [Getting Started](/en/getting-started/)). The product has **no public download site**: there is a version contract between the client, the apps, and the server, and keeping installers inside the image makes "the client version follows the server version" a structural fact rather than a discipline.

### Do employees have to upgrade manually?

No. **Exactly one update source exists: the server the client signed in to** (`GET /api/client/v2/updates/manifest`). A packaged build checks 60 seconds after launch and then every 6 hours; checking and downloading are silent, the download is verified against the manifest's SHA-256 while streaming, and a failure installs nothing and keeps the current version. **So the right way to upgrade clients is to upgrade the server** — once the server is upgraded, the employee side picks up the new version on its next check.

### Why are the installers unsigned?

The Windows installer and the Linux AppImage are unsigned (macOS release builds are signed + notarized). Windows SmartScreen may warn about an "unknown publisher" — verify with the `SHA256SUMS` next to the image package before running. If macOS says the developer cannot be verified, you are probably using a pre-release package (signed only, not notarized).

### Does the app update by silently restarting?

No. Checking and downloading are silent, but **installation is always triggered by the user**: the Windows installer wizard, dragging the app into Applications on macOS, or replacing the AppImage on Linux (there is no silent self-install). The product does not do "silent restart-and-install" — the client holds local sessions and unsaved work, and a silent restart costs more than a few minutes' delay.

### Is closing the window the same as quitting?

No. Closing the window hides it to the tray and the local Harness service keeps running (scheduled jobs still fire). To really end the app and the local service, use **Quit** in the tray menu.

### What if the port is taken?

The local web port is randomly assigned by the OS by default (`dsh-desktop.port: 0`) and listens only on `127.0.0.1`. If a pinned port is taken, the local service cannot listen and the window cannot load: set the port back to `0` or another free port and restart the app (changing the port performs an orderly restart, never a hot swap).

### Can the client use a system proxy?

Not by default: system proxy settings, proxy environment variables, PAC files, and `--proxy-server` are all ignored. Only deployments where "an authenticated proxy is the sole route to the internet" should open the escape hatch — the channel field `desktop.allow_system_proxy`, or the **real process environment variable** `PICOAI_ALLOW_SYSTEM_PROXY=1` (setting it in the `.env` layer does not work). When enabled, the startup log prints `proxy system/<source>`; direct mode prints `proxy direct`.

### Can I install third-party DSH plugins in the client?

Yes, through the profile's **user patch layer**: edit `~/.picoaide-harness/cordis.patch.yml` (a different channel means a different data root), append one line in Loader patch syntax, and **restart the app** for it to take effect.

You **cannot** use `dsh plugin --profile desktop …`: the `desktop` profile is managed exclusively by the desktop application, so the CLI rejects it outright (`profile "desktop" is managed exclusively by the Electron application`), and the app exposes no terminal or profile switcher.

## Models and keys

### Where do upstream API keys live? Can the client see them?

**Only on the server**: encrypted with AES-GCM (ciphertext prefix `enc:v1:`), with the master key in a separate file `master.key` in the deployment directory (`0600`, never stored in the database). The client only ever holds its own session token and uses `<server>/v1` as its model endpoint; it never sees an upstream key.

### Can employees choose their own model or bring their own key?

No. The model catalogue, input modalities, prices, and discounts are configured centrally by administrators in the admin console; the client's model-settings surface is explicitly disabled and there is no local provider configuration. While signed out, the client has **no usable model route** — a direct consequence of "keys live only on the server", not a failure.

### What happens when the balance runs out?

The gateway returns `429 BALANCE_EXHAUSTED`: balance is the **only** billing gate (per user, deducted on consumption, reconcilable entry by entry). Administrator accounts are exempt, and an account that has never been funded simply does not render a balance row on the account page. An unpriced model is rejected with `429 MODEL_NOT_PRICED` unless an administrator explicitly allows it with the policy switch. Outside peak windows, a model's off-peak discount can apply.

### How long do employee tokens live, and what does a password change do?

Employee API tokens expire after **90 days** and the server stores **hashes only**. A password change, a permission downgrade, or disabling an account revokes every API token and admin session for that account in the same transaction; after a password reset the server requires a change at next sign-in (otherwise business APIs return `403 PASSWORD_CHANGE_REQUIRED`).

### An administrator forgot their password or MFA — now what?

Admin MFA (TOTP) has no recovery codes: the fallback is **another super-admin resetting it** (an administrator cannot reset their own), and the reset revokes all of that account's sessions. Admin sessions themselves have a 12-hour hard limit plus a 60-minute sliding idle timeout. See [Enterprise control plane](/en/admin/).

### I hit the login rate limit — what do I do?

Rate limiting counts **failures only** (a 5-minute sliding window, cleared on success): 10 per account and 60 per source IP. Wait out the window and retry; if the whole organisation cannot sign in, first check that the reverse proxy forwards the client IP correctly (see [Operations & troubleshooting](/en/deployment/operations/)).

## Capabilities and connectors

### Where does Capability Hub content come from, and who can install it?

Two orthogonal dimensions: content type (skill / agent) × source (Market / Org / Local). **Market** content is listed by administrators and requires per-user or per-department authorization before it is visible and installable. **Org** content is uploaded by employees and reviewed by administrators (approve / reject); after approval it **still** requires authorization — an "approval + authorization" two-gate model. **Local** content is your own and visible only on your machine. Quality markers are only "Official / Featured", set by an administrator during review.

### If I upload a skill, will others see it immediately?

No. An upload enters `pending`; after an administrator approves it, it still has to be authorized for specific people or departments before they can see or install it. Unauthorized content stays invisible. **Ownership belongs to the first publisher who claimed the name**: even if a later version is rejected or delisted, the name stays yours, which prevents squatting.

### Which connectors are supported, and how do I add one?

The external contract is a **single standard MCP config**: `type` (`streamableHttp` / `http` / `stdio`, inferred from `url` or `command` when omitted) plus `url`, or `command` / `args` / `env`, with a title and description. Unregistered keys produce an error rather than being ignored. The auth mode defaults to **auto**: it probes the endpoint — a 2xx means a public endpoint; a 401 follows `WWW-Authenticate` through RFC 9728 → RFC 8414 discovery plus dynamic client registration and PKCE; a declared credential form takes that path instead; with neither, no credentials are needed. A `stdio` connector asks for local confirmation on first run (command, arguments, and environment variables disclosed one by one), and process-bootstrap variables such as `PATH` / `NODE_OPTIONS` are never injected.

### Do connector tokens expire, and what happens then?

They do, but you usually do not have to care: tokens renew automatically (the SDK's 401 self-healing plus a background heartbeat that renews ahead of expiry), and rotated credentials are written atomically. Only when the authorization server revokes the grant does the connector row change to "needs re-authorization" with explicit wording; transient failures such as 5xx keep the old credentials and retry. Credentials are stored per (account + server address), so switching accounts or servers never reuses them.

### If I close the client, do scheduled jobs still run?

Closing the window does not matter (it only hides; the local service keeps running). **Triggers missed while the app is fully exited are skipped by default**, and you can enable "run the most recent missed trigger" in settings. Each run creates a new agent session (with the configured workspace, preset, and permissions); its details (trigger time, start/end, result, error, session) stay available, and you can also run one immediately. The model can operate jobs through tools such as `cron_create`, but a job it cannot see is reported as missing, and **a running job refuses deletion**.

### Is the built-in browser safe? Will the AI click around on its own?

Control changes hands only through **one button, in both directions**: "Take over" in the bottom-right corner acquires it, and the same capsule becomes "Hand back to AI" to return it. The mask's empty areas, the activity panel, and `Esc` **never** change control. Downloads default to a 100MB cap and are refused beyond it; every navigation, click, and download goes into the operation log; closing the window only hides it, and only the model's `browser_close` really destroys it.

### Does voice input send my audio to the cloud?

No. Recognition runs in a **local subprocess** (SenseVoiceSmall + Silero VAD), the audio never leaves the machine, it works offline, and there is no cloud fallback. Chinese, English, Japanese, Korean, and Cantonese are detected automatically. The model ships with the client by default (install and use, zero downloads) and only falls back to first-use download when a channel explicitly disables it. Transcriptions land only in the composer draft — they are **not written to the session and not sent automatically** — and one recording is capped at 120 seconds / 4MiB.

### Does the AI write its own memories?

No. Memory is **confirmation-first**: the AI files suggestions (through entries such as `memory_suggest`) into a pending queue, and nothing is written until you accept it. Of the five tracks (user profile / global facts / project key memory / project log / daily log), the project track is scoped by directory and git branch, and the main tracks and the archive can be moved in both directions.

### Do apps in the app centre need a public entry point or a certificate?

No. Employee-built WASM apps open only inside a **separate client window** (via a custom protocol), and the server's single entry point is `POST /api/client/v2/apps/wasm/:app_id/request` (forwarding execution with the employee token). So deployment needs **no** app subdomain, wildcard certificate, or extra port. The app's `picoaide.app.json` sets `access` to `public` / `login` / `whitelist` (default `login`), and the `whitelist` is read and enforced by **the app itself**; consents such as "allow the AI to read this app's data" are recorded per (user + server + app).

## Open source and licensing

### What is the relationship between PicoAide Harness and DeepSeek Harness?

It is built on a fixed version of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (currently pinned at `dsh-v0.2.0-rc.2`; the source of truth is `upstream.json` at the repository root). Upstream provides the core agent, plugin system, and Web UI; this project provides the desktop packaging, local service management, and the enterprise control plane. **The upstream source runs unchanged, without modifications** — only a small number of guarded patches are kept, and upgrades only follow the upstream version number.

### Is this an official DeepSeek product?

No. PicoAide Harness is an independent open-source community project (MIT License), with no affiliation to or endorsement from DeepSeek. DeepSeek is a trademark of DeepSeek AI.

### What is the licence? Can I use it commercially or build on it?

MIT License: you may use, modify, and distribute it freely (keeping the licence and copyright notice). Branding and copy go through **channel content**: name, tagline, welcome copy, logo, accent colour, and data root are injected into the image at build time, and different channels get independent installers and data roots. Changing the brand means rebuilding that channel's image rather than editing it online in the admin console. For packaging and extension details see [System architecture](/en/architecture/) and [Plugin Development](/en/plugin-development/).

### Where do I report problems?

Start with the troubleshooting section of [Desktop Client](/en/desktop/) and [Operations & troubleshooting](/en/deployment/operations/); if that does not resolve it, file a [GitHub Issue](https://github.com/picoaide/picoaide-harness/issues) with your OS, app version, reproduction steps, and error messages. If the app keeps crashing, use `--export-diagnostics` or "Export Diagnostics…" from the tray to produce a diagnostics archive (review it before sharing).

## Related

- [Welcome](/en/welcome/) — the three layers and the supported / unsupported list
- [Getting Started](/en/getting-started/) — from installer to first message
- [Product Philosophy](/en/philosophy/) — each design principle and what it costs
- [Private Deployment](/en/deployment/) — deployment, upgrades, and channel delivery
