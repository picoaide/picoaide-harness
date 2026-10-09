---
title: Getting Started
description: 'From zero to usable: how each role obtains the client, what happens on first launch, how to sign in, the four core entry points, and the first-hour problems with their criteria.'
---

This page takes you from an empty machine to your first message: role-based paths, commands you can copy, and criteria you can check yourself. Every section ends with something you can verify; if you get stuck, read the "First-hour problems" section at the end of this page.

## Choose your path first

| You are | How to start | What to prepare first |
|---|---|---|
| **Enterprise employee** | Ask your administrator for the enterprise address, open `https://<enterprise-domain>/` and download the installer for your platform (or copy it from a colleague) | The account and password your administrator gives you; a **project directory** to use as a workspace |
| **Enterprise administrator** | Deploy the server first following [Private Deployment](/en/deployment/); client installers ship with the server image, and once deployed this server serves them to employees | The external address, the certificate mode, and the initial super-admin password (see the prerequisites in [Container Deployment](/en/deployment/compose/)) |
| **Want to try it first** | Client installers for the official channel live **inside the server image**: fetch the official image package, export the installers for all three platforms with one command (below), and run the server on your own machine | A Linux x64 machine that can run Docker, or a test server someone lets you sign in to |

## Where the client installers come from

| Platform | Installer | Notes |
|---|---|---|
| Windows x64 | `.exe` (NSIS installer) | Unsigned; SmartScreen may warn about an "unknown publisher" |
| macOS (Apple silicon / arm64) | `.dmg` | Release builds are signed + notarized; pre-release builds are signed only |
| Linux x64 | `.AppImage` | Grant execute permission, then run; the enterprise delivery surface has no deb |

Client installers **ship with the server image** (they are not posted on a standalone download site), so there are only two sources:

1. **Your enterprise server** (recommended): once deployed, open `https://<enterprise-domain>/` (the portal page) — it lists download entries for all three platforms;
2. **The official image package** (trial / single machine): fetch the official image package from the update server or [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases), then unpack the installers:

```bash
VER=<version>        # use server.version from latest.json as the authority
# the official channel is `official`, the pre-release channel is `beta` — swap as needed
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS
unzip -p "picoaide-server-${VER}-amd64.zip" image.tar | docker load
mkdir -p ./picoaide-stack
docker run --rm -v "$PWD/picoaide-stack:/out" -e PICOAI_UNPACK_STACK=/out \
  "picoaide-harness-server:${VER}"
ls -1 ./picoaide-stack/client    # installers for all three platforms + CLIENT-RELEASE.json
```

**Criteria**: `sha256sum -c` prints `OK` for every file, and `client/` contains the installers for all three platforms plus `CLIENT-RELEASE.json`. If `client/` is missing, you are not using a release package (locally built images carry no client assets).

Full instructions are in [Container Deployment](/en/deployment/compose/) and [Air-gapped Deployment](/en/deployment/offline/); the server-side criteria for installers and manifests are in [Client delivery & updates](/en/deployment/client-delivery/).

## What happens on first launch

1. The app takes a **single-instance lock** (launching it again only focuses the existing window; no second process appears);
2. The app creates (or reuses) the fixed `desktop` profile and starts the official DSH web interface **locally** on `127.0.0.1` — the port is randomly assigned by the OS by default, and it listens on loopback only;
3. The main window loads that local page. **While logged out, this page is the sign-in page**; after a successful sign-in the same window switches to the app UI, with no manual refresh;
4. Closing the window **is not quitting**: the window is hidden while the local service keeps running (scheduled jobs still fire). To really end the app and the local service, use **Quit** in the tray menu;
5. The installer already bundles Electron, Node.js, pnpm, and the pinned upstream DSH dependencies — you do **not** need to install Node.js, pnpm, or DSH separately, and the app does not modify the system-wide PATH or your shell config.

**Criteria**: the window shows the sign-in page, and the tray icon exists with a context menu containing "Open <product name>", "Export Diagnostics…", and "Quit".

## Signing in

The sign-in page has two steps: first the **server address**, then the sign-in methods the server decides to offer.

1. **Server address**: enter the address your administrator gave you (for example `https://harness.example.com`). **Remote addresses must be `https`**; `http` is allowed only for `localhost` / `127.0.0.1`, and a trailing slash is normalised away. When the channel package has a built-in server address, this step is pre-filled and skipped;
2. **Sign-in method**: decided by the server configuration — a local account (username + password), LDAP (directory account + password), or OIDC ("Sign in with browser": finish the authorization in the browser window that opens and this page continues automatically);
3. **`internal` (self-signed intranet) mode**: the first connection requires trusting this deployment's local Caddy CA, otherwise it stops at "Cannot reach the server";
4. After a successful sign-in the client pulls channel content, the model catalogue, and account information from this server; model availability, prices, discounts, and balance are all decided by the server.

When sign-in fails, the page shows the reason verbatim, so the wording alone tells you where to look:

| Message on the page | Meaning | What to do |
|---|---|---|
| Cannot reach the server — check the address and your network | Wrong address, no network path, or an untrusted certificate (`internal` mode without the Caddy CA) | Check the address and the certificate; trust the local CA first in `internal` mode |
| Network error — check the server address and try again | The request that probes sign-in methods failed (server restarting, reverse proxy 502, …) | Confirm `/healthz` on the server, then retry |
| Incorrect username or password | Wrong credentials (LDAP / OIDC end up here too) | Ask your administrator to check the account |
| Too many sign-in attempts — try again later | Login rate limiting (failures are counted per account and per source IP) | Wait out the 5-minute window and retry |
| This account is disabled — contact your administrator | The account was disabled | Contact your administrator |
| Change your password first (change-password page) | An administrator reset your password and the server requires a change before anything else | Set a new password on that page and continue |

> Signing out clears every session (connector, browser, and scheduled-job tokens included). To switch to another server or account, sign out from Settings and sign in again — the client **discards** all in-flight state belonging to the previous server.

## The local web port

The local Harness service listens only on `127.0.0.1`, and its port is randomly assigned by the OS by default (`dsh-desktop.port: 0`), which avoids collisions. If a UI plugin needs a stable origin (`localStorage` is isolated per origin), you can pin the port:

```yaml
dsh-desktop:
  port: 43189
```

The port must be an integer from `0` to `65535` (`0` = random). Changing it performs an orderly restart (the current runtime is fully disposed before Electron comes back); nothing is hot-swapped inside a running page.

**Boundary**: if the fixed port is already taken, the local service cannot listen and the window cannot load. Fix it by setting the port back to `0` or another free port, then restart the app.

## The four core entry points

Once signed in, these are the four entry points employees use every day:

1. **Sessions**: pick a workspace (project directory) when creating a session, then just chat. Tools the model may call are gated per call — writing files, running commands, and driving the browser all need your approval; the three tiers (read-only / workspace-write / full access) set how far the sandbox lets a tool go.
2. **Capability Hub**: install skills and agents from the Market or Org (authorization required), and review your "Mine" local creations and their upload/approval status. Install, update, and uninstall all come with confirmations and explicit refusal reasons — nothing is handled silently.
3. **Connectors**: bring external systems in as MCP. An administrator registers one standard MCP config (`type` + `url`, or `command`/`args`/`env`) in the admin console, and after one authorization the model can call its tools; OAuth tokens renew automatically.
4. **Scheduled jobs**: hand recurring work to an Agent (cron + prompt + workspace + agent preset + permissions); every run's session, result, and error stays available, and you can trigger one immediately.

The other always-on capabilities live in the same navigation: the **built-in browser** (an Agent can take over; control only changes hands through the button in the bottom-right corner), **voice input** (the microphone in the composer; recognised locally and usable offline), **five-track memory** (written only after confirmation, with the project track scoped to the directory and git branch), and the **app centre** (employee-built WASM apps open in a separate window).

## First-hour problems

| Symptom | What it means | What to do |
|---|---|---|
| You closed the window and the app "disappeared" | The process and tray icon are still there | Closing hides to the tray; restore from "Open <product name>" or end it from "Quit" |
| The app will not start, or the window stays blank | The pinned port is taken, or the local service did not come up | Set `dsh-desktop.port` back to `0` or another free port, then restart |
| Sign-in hangs on "Connecting…" | The server address is unreachable or the certificate is untrusted | Open `https://<enterprise-domain>/healthz` in a browser; in `internal` mode trust the local CA first |
| No model available after signing in | The server's model catalogue is empty, or your account has no balance | Ask your administrator to configure models and balance (models and keys live on the server) |
| "Check for Updates" appears to do nothing | You are not signed in (no update source), or the background check failed (which is silent) | While signed out the client performs **no outbound update checks**; once signed in, a manual check from the tray always shows a result |
| Windows warns about an "unknown publisher" | Installers are unsigned | Expected; verify with the `SHA256SUMS` in the same directory as the image package before running |
| macOS says the developer cannot be verified | The package carries no notarization ticket | Pre-release packages are signed only; use a release package |
| Double-clicking does nothing on Linux | The AppImage has no execute permission | `chmod +x`, then run it |
| The app keeps crashing on start | A crash was recorded, but the UI never gets a chance to show it | Run the installed binary with `--export-diagnostics` (it does not start the host and prints the diagnostics ZIP path), or use "Export Diagnostics…" from the tray |
| A plugin or preset does not show up | The app runs the fixed `desktop` profile, and changes only enter the Loader composition after a restart | Restart the app; third-party plugins go into `~/.picoaide-harness/cordis.patch.yml` (a different channel means a different data root) |

## Criteria for "it is installed and working"

| # | Criterion | How to check |
|---|---|---|
| 1 | The app runs | The tray menu works and the main window is not blank |
| 2 | Sign-in succeeds | The window switches to the app UI, and Settings → Account shows your account and the server address |
| 3 | A model is available | A new session can select a model (the catalogue comes from the server) |
| 4 | Sessions work | Pick a workspace, send a first message, and get a reply |
| 5 | Tools work | Ask the model to write a file or run a command: a confirmation card appears and approving runs it; a refusal reaches the model with its reason |

## Related

- [Welcome](/en/welcome/) — the three layers and the product boundaries
- [Desktop Client](/en/desktop/) — every surface in full, plus troubleshooting
- [FAQ](/en/faq/) — questions by topic
- [Private Deployment](/en/deployment/) — for administrators bringing the server up
- [Client delivery & updates](/en/deployment/client-delivery/) — how installers and update manifests are served
