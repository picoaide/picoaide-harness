---
title: Getting Started
description: 'Get started with PicoAide Harness in 10 minutes: getting the client, first launch, sign-in, and the four core entry points.'
---

## Choose your path

| You are | How to get the product |
|---|---|
| **Enterprise employee** | Ask your administrator for the enterprise access address, open `https://<enterprise-domain>/`, and download the installer for your platform (or copy the installer directly from a colleague) |
| **Enterprise administrator** | First deploy the server following [Private Deployment](/en/deployment/); client installers ship with the server image, and once deployment is done this server serves them to employees |
| **Want to try it first** | Client installers for the official channel are **inside the server image**: fetch the official image package and a single command exports the installers for all three platforms (see below) |

## Client installers

| Platform | Installer | Notes |
|---|---|---|
| Windows x64 | `.exe` (NSIS installer) | Unsigned; SmartScreen may warn about an "unknown publisher" |
| macOS (Apple silicon / arm64) | `.dmg` | Official releases are signed + notarized |
| Linux x64 | `.AppImage` | Grant execute permission, then run |

Client installers **ship with the server image** (rather than being posted on a standalone download site), so there are only two sources:

1. **Your enterprise server** (recommended): once deployment is done, open `https://<enterprise-domain>/` — the portal page lists download entries for all three platforms;
2. **The official image package** (trial / single machine): fetch the official image package from the update server or
   [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases), then unpack the installers:

```bash
VER=2.7.0        # use server.version from latest.json as the authority
# the official channel is `official`, the pre-release channel is `beta` — swap as needed
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS
unzip -p picoaide-server-${VER}-amd64.zip image.tar | docker load
mkdir -p ./picoaide-stack
docker run --rm -v "$PWD/picoaide-stack:/out" -e PICOAI_UNPACK_STACK=/out \
  picoaide-harness-server:${VER}
ls -1 ./picoaide-stack/client    # installers for all three platforms + CLIENT-RELEASE.json
```

For full instructions see [Container Deployment](/en/deployment/compose/) and [Offline Deployment](/en/deployment/offline/).

## First launch

- First launch creates a default `desktop` profile and starts the official DSH web interface locally;
- The installer already bundles Electron, Node.js, pnpm, and a pinned set of DSH dependencies — you do **not** need to install Node.js, pnpm, or DSH separately;
- Closing the window hides to the tray by default; choose **Quit** from the tray to exit the app and stop the local service.

## Local web port

Desktop lets the OS pick a random local web port by default (`dsh-desktop.port: 0`), avoiding collisions; the service listens only on `127.0.0.1`. If a UI plugin needs a stable origin (`localStorage` is isolated per origin), set a fixed port in settings:

```yaml
dsh-desktop:
  port: 43189
```

The port must be an integer from `0` to `65535`; changing it performs an orderly restart. If the fixed port is already taken, Desktop cannot start — free the port or set it back to `0` or another free port.

## Sign in

- **Enterprise (server mode)**: enter the server address (provided by your enterprise administrator, e.g. `https://ai.example.com`) and sign in with your account and password (local / LDAP / OIDC; the sign-in method is configured server-side); accounts are created by administrators in the Admin Console, and quota and balance are decided by the server;
- **The client's update source is exactly this server**: after signing in, the client periodically checks it for new versions (see [Client delivery & updates](/en/deployment/client-delivery/)); when not connected to a server it performs no outbound update checks at all;
- In `internal` (intranet self-signed) mode, the first connection requires trusting this deployment's local Caddy CA;
- Signing out clears all sessions (connectors, browser, scheduled-job tokens).

## Start using it: the four core entry points

1. **New session**: choose a workspace (project directory) to start chatting; the tools a model can call are gated by permission approvals;
2. **Capability Hub**: install market skills/agents (needs administrator authorization), and review your "Mine" local creations and their upload/approval status;
3. **Scheduled jobs**: hand high-frequency work to an Agent to run automatically on schedule (cron + prompt + workspace + permissions); execution details are always available;
4. **Connectors / Browser**: authorize via OAuth to connect MCP services such as Xiaoshouyi and Moka; let the Agent take over the browser to perform actions.

## What's next

- To understand the product's design principles, read [Product Philosophy](/en/philosophy/);
- To dive into each interface, read [Desktop Client](/en/desktop/);
- Enterprise administrators: read [Admin Console](/en/admin/) and [Private Deployment](/en/deployment/).
