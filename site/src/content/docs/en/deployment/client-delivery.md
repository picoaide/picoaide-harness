---
title: Client delivery & updates
description: 'Client installers ship inside the server image: employees download and auto-upgrade from their own enterprise server, with no internet access required.'
---

PicoAide Harness clients are **not released separately**: the installers for all three platforms are packaged
into the server image and served by the server itself.
Employee machines need no internet access at all, so the client version naturally follows the server version —
a state where "the client was upgraded but the server was not" is structurally impossible.

## Distribution chain

```
Official update server release.picoaide.com/<channel>/   ← server images only (administrators use it to upgrade the server)
        │ administrators pull the image and deploy
        ▼
Enterprise server (this project's deployment target)     ← the image already contains client installers for all three platforms
        │ employees open https://<enterprise domain>/ to download / the client checks for updates itself
        ▼
Employee machines (Windows / macOS / Linux)
```

## What the server provides

| Endpoint | Description |
|---|---|
| `GET /api/client/v2/updates/manifest` | Version manifest (public, no login required): the client version in this release, plus each platform's installer URL, SHA-256 and size |
| `GET /updates/client/<file name>` | Installer download; supports resumable download (Range), and the file name contains the version so it can be cached for a long time |
| `GET /`, `GET /portal` | Portal page: the company name and welcome message come from the channel configuration, listing download entries for all three platforms |

Manifest structure (example):

```json
{
  "schema": 1,
  "channel_id": "official",
  "server": { "version": "2.7.0" },
  "client": {
    "version": "2.7.0",
    "assets": {
      "win-x64":       { "url": "https://ai.example.com/updates/client/PicoAide-Harness-2.7.0-x64-Setup.exe", "sha256": "…", "size": 123456789 },
      "mac-universal": { "url": "https://ai.example.com/updates/client/PicoAide-Harness-2.7.0-mac.dmg",        "sha256": "…", "size": 123456789 },
      "linux-x64":     { "url": "https://ai.example.com/updates/client/PicoAide-Harness-2.7.0-x86_64.AppImage", "sha256": "…", "size": 123456789 }
    }
  }
}
```

The installer list comes from `CLIENT-RELEASE.json` inside the image and is refreshed along with image upgrades,
so **after a server upgrade the client packages are automatically replaced too**.

## Platforms and installers

| Platform | Installer | Description |
|---|---|---|
| Windows x64 | `.exe` (NSIS installer) | Unsigned; SmartScreen may warn about an "unknown publisher" |
| macOS (Apple silicon / arm64) | `.dmg` | Signed + notarized for official releases; signed only for pre-releases |
| Linux x64 | `.AppImage` | Grant execute permission and run it directly; the enterprise delivery surface **does not include deb** (deb is only produced by local builds) |

> The client depends on Electron, Node.js and a pinned DSH runtime, which makes the installers fairly large
> (about 150MB per platform) — that is because the runtime ships with the package, so employee machines
> do **not** need to install Node.js, pnpm or DSH.

## How the download URL is determined (the most common deployment pitfall)

The server derives "the absolute URL reachable by clients" in this priority order:

1. `PICOAI_PUBLIC_BASE_URL` (**once set, it is the sole authority**);
2. `X-Forwarded-Proto: https` declared by the reverse proxy;
3. the request itself arrives over direct TLS;
4. a loopback address (local development, where http is allowed).

When none of these is available, the manifest **deliberately refuses to emit** the `client` section and states the reason:

```json
{ "schema": 1, "channel_id": "official", "server": { "version": "2.7.0" },
  "client_unavailable": "server origin is not https; set PICOAI_PUBLIC_BASE_URL" }
```

Why it is designed this way: clients only accept **absolute https** download URLs (a manifest with non-https
URLs is discarded in full). If the server handed out an http link, the client would silently "always show up to
date" — better to state plainly that it is unavailable than to create a false impression.

**Post-deployment self-check** (especially important in an intranet environment using self-signed certificates
in `internal` mode):

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

- `client.assets` present with `https://…` addresses → all good;
- `client_unavailable` present → add `PICOAI_PUBLIC_BASE_URL=https://<domain>` to `.env`, then run
  `docker compose up -d server`.

## How the client auto-upgrades

- **There is exactly one update source**: the server it logs in to. The client does not contact the update
  server or GitHub, and does not need to know which channel it belongs to;
- **Check timing**: the first check runs 60 seconds after startup, then once every 6 hours; the tray menu and
  "Settings → About" offer a manual check;
- **Verification**: the manifest `schema` must be `1`, `channel_id` must match the server, the download URL
  must be absolute https, and the installer SHA-256 must match the manifest (verified as a stream); if any
  step fails, nothing is installed;
- **A failure does not damage the current version**: if a download is interrupted or verification fails, the
  installed version keeps working and the UI offers a retry;
- **Installation**: on Windows the installer runs, on macOS the DMG is opened for an over-install; on Linux the
  AppImage, once downloaded, prompts the user to replace the current file (AppImage has no silent self-install).

So **the correct way to upgrade a client is to upgrade the server** (see
[Upgrade, backup & rollback](/en/deployment/upgrade/)); employees need to do nothing, and the next check will
show the new version.

## How employees install and sign in

1. Open `https://<enterprise domain>/` (the portal page) or `https://<enterprise domain>/portal` and download the installer for your platform;
2. On first launch, enter the **server address** (that is, `https://<enterprise domain>`) and choose a login method (local / LDAP / OIDC, configured by the administrator);
3. Accounts are created by the administrator in the Admin Console, and quotas and balances are decided by the server (see [Admin Console](/en/admin/));
4. In `internal` mode (intranet self-signed), the first connection requires trusting this deployment's Caddy local CA;
   the login page and the client reject non-HTTPS remote addresses (TOFU).

For the standalone desktop form (not connected to a server), see [Desktop client](/en/desktop/);
for the branding and channel content of enterprise custom channels, see [Channels & white-label](/en/deployment/channels/).
