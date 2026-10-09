---
title: Client delivery & updates
description: 'Client installers ship inside the server image: employees download and auto-upgrade from their own enterprise server, with no internet access required.'
---

PicoAide Harness clients are **not released separately**: the installers for the three platforms are
packaged into the server image and served by the server itself. Employee machines need no internet
access at all, so the client version naturally follows the server version — a state where "the client
was upgraded but the server was not" is structurally impossible.

## What this page solves

Getting the client to employees, keeping it on the server's version, and being able to tell "the
distribution is broken" apart from "the client is broken". It covers: the distribution chain → the
endpoints the server exposes → the manifest and how download URLs are decided → installing and signing
in → how auto-upgrade works → criteria and failure behaviour.

**Prerequisites**:

| Prerequisite | Notes |
|---|---|
| The server is deployed and `/healthz` returns 200 | See [Container deployment](/en/deployment/compose/) |
| The server can produce an **absolute https** download URL for clients | Behind a reverse proxy, set `PICOAI_PUBLIC_BASE_URL`, otherwise the manifest refuses to emit the `client` section by design |
| Employee machines can reach the enterprise domain | That single address is all they need; no public internet |
| The employee client and the server are on the **same version** | Apps (WASM) open only inside the client and require matching versions |

> **"The server was upgraded but the client was not" is possible, and it makes apps unusable**: apps
> open only inside the desktop client and the browser access chain has been removed, so old clients
> cannot open apps. Clients fetch packages from this server — make sure employees accept the upgrade
> prompt instead of staying on an old version.

## Design trade-offs

**Why clients ship inside the image instead of being released separately.** Client and server share a
version contract (the gateway protocol, the app access model, the manifest structure). Putting both in
one deliverable makes "the client version follows the server version" a structural fact rather than a
discipline, and it solves two more things for free: employee machines need **zero internet**
(only the enterprise domain), and channel consistency holds (whichever channel the server belongs to,
its clients belong to as well — a "client channel differs from server channel" state cannot exist).

**Why download URLs must be absolute https, and why the server would rather emit nothing.** When the
client reads the manifest it cannot tell an `http` link apart from a link rewritten by a
man-in-the-middle, and a wrong installer is a persistent backdoor on that machine. So when the server
cannot derive a safe address it **refuses** to emit the `client` section and gives the reason
(`client_unavailable`) instead of handing out an http link the client will discard wholesale. Why the
latter is worse: after discarding a non-https manifest the client shows "already up to date" — silent,
unreported, and with no clue pointing at the configuration.

**Why there is exactly one update source, and why checks are silent.** The client only asks "the server
I signed in to": it does not contact the update server, does not contact GitHub, and does not need to
know which channel it belongs to. Checks and downloads happen in the background (bounded backoff,
resumable downloads), while **installation is always triggered by the user** — the product does not do
a "silent restart-and-install": the client holds local sessions and unsaved work, and a silent restart
costs far more than upgrading a few minutes later.

## Distribution chain

```
official update server release.picoaide.com/<channel>/   ← server images only (administrators upgrade the server)
        │ administrator fetches the image and deploys
        ▼
enterprise server (the target of this deployment)        ← the image already contains installers for the three platforms
        │ employees open https://<enterprise domain>/ to download, or the client checks for updates
        ▼
employee machines (Windows / macOS / Linux)
```

## What the server provides

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/client/v2/updates/manifest` | Public (no sign-in) | Version manifest: client version plus each platform's installer URL, SHA-256 and size |
| `GET /updates/client/<file name>` (and `HEAD`) | Public | Installer download; supports resume (Range/206) and can be cached for a long time since the name carries the version |
| `GET /`, `GET /portal` | Public | Portal page: the company name and welcome copy come from the channel configuration; lists the download entry points for the three platforms |

Both surfaces are public: an employee **has no session yet when installing**, so the manifest and the
installers must be reachable before sign-in. That is exactly why the installer directory is tightly
restricted (see [Criteria](#criteria)).

Manifest structure (example; URLs are assembled by the server from the request):

```json
{
  "schema": 1,
  "channel_id": "official",
  "server": { "version": "<version>" },
  "client": {
    "version": "<version>",
    "assets": {
      "win-x64":       { "url": "https://harness.example.com/updates/client/PicoAide-Harness-<version>-x64-Setup.exe", "sha256": "…", "size": 123456789 },
      "mac-universal": { "url": "https://harness.example.com/updates/client/PicoAide-Harness-<version>-mac.dmg",        "sha256": "…", "size": 123456789 },
      "linux-x64":     { "url": "https://harness.example.com/updates/client/PicoAide-Harness-<version>-x86_64.AppImage", "sha256": "…", "size": 123456789 }
    }
  }
}
```

The installer list comes from `CLIENT-RELEASE.json` inside the image and is refreshed together with the
image, so **after a server upgrade the client packages are automatically new** — nothing to upload or
publish separately.

## Platforms and installers

| Platform | Installer | Notes |
|---|---|---|
| Windows x64 | `.exe` (NSIS installer) | Unsigned; SmartScreen may warn about an unknown publisher |
| macOS (Apple silicon) | `.dmg` | Release builds are signed + notarised (the notarisation ticket is inside `Contents/CodeResources`); pre-release builds are signed only |
| Linux x64 | `.AppImage` | Make it executable and run it; enterprise delivery **excludes deb** |

> Installers are large (they ship the Electron runtime, a pinned upstream DSH runtime, and the
> Node.js / pnpm / CPython runtimes apps can use): employee machines need **no** Node.js, pnpm or DSH —
> everything is inside the package, and the bundled runtimes only affect subprocesses the client itself
> spawns.

## How the download URL is determined (the most common deployment pitfall)

The server derives the client-reachable absolute address in this order:

1. `PICOAI_PUBLIC_BASE_URL` (**when set, it is the only authority**);
2. the public address configured in the admin console (`settings: server.base_url`; an invalid value is
   ignored with a warning);
3. `X-Forwarded-Proto: https` declared by the reverse proxy;
4. this request arriving over TLS;
5. a loopback address (local development, http allowed).

If none applies — or the configured address is not an absolute http(s) URL **without credentials,
query or fragment** — the manifest **refuses** to emit the `client` section and states the reason:

```json
{ "schema": 1, "channel_id": "official", "server": { "version": "<version>" },
  "client_unavailable": "server origin is not https; set PICOAI_PUBLIC_BASE_URL" }
```

**Post-deployment self-check** (especially important on `internal` self-signed intranets):

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

- `client.assets` with `https://…` URLs → fine;
- `client_unavailable` → add `PICOAI_PUBLIC_BASE_URL=https://<domain>` to `.env` and run
  `docker compose up -d server`.

## How the client auto-upgrades

- **Exactly one update source**: the server it signed in to; with no server session the client makes
  **no outbound check at all**;
- **When it checks**: **60 seconds after startup**, then **once every 6 hours**; the tray menu and
  "Settings → About" offer a manual check;
- **Verification**: the manifest `schema` must be `1`, `channel_id` must match the server, the download
  URL must be absolute https, and the installer's SHA-256 must match the manifest (streamed
  verification, plus a file-magic check); if any step fails, nothing is installed;
- **A failure never breaks the current version**: an interrupted download or a failed checksum leaves
  the installed version running and the UI offers a retry; whatever was already downloaded is reused
  (resumable download);
- **Installation is user-triggered**: Windows runs the installer, macOS opens the DMG for an overwrite
  install, and Linux tells the user to replace the current file once the download finishes (an AppImage
  has no silent self-install).

So **the correct way to upgrade clients is to upgrade the server** (see
[Upgrade, backup & rollback](/en/deployment/upgrade/)); employees do nothing and see the new version on
the next check.

## How employees install and sign in

1. Open `https://<enterprise domain>/` (the portal) or `https://<enterprise domain>/portal` and download
   the installer for the platform;
2. On first launch enter the **server address** (`https://<enterprise domain>`) and pick a sign-in method
   (local / LDAP / OIDC, configured by the administrator); channel packages with a built-in server
   address pre-fill this step and skip it;
3. Accounts are created by the administrator in the admin console; balance and models are decided by the
   server (see [Admin console](/en/admin/));
4. In `internal` (self-signed intranet) mode the first connection needs this deployment's Caddy local CA
   to be trusted; the sign-in page and the client refuse non-HTTPS remote addresses.

> **Clients do not use the system proxy by default** (system proxy settings, proxy environment
> variables, PAC and command-line switches are all ignored). Only deployments that can reach the
> internet *solely* through a proxy need the escape hatch: the channel field
> `desktop.allow_system_proxy`, or the **real process environment variable**
> `PICOAI_ALLOW_SYSTEM_PROXY=1` (writing it into the `.env` layer does not work). With the hatch open
> the startup log prints `proxy system/<source>`; the default direct mode prints `proxy direct`.

The standalone desktop form (no server) is described in [Desktop client](/en/desktop/); branded channel
content is described in [Channels & white-label](/en/deployment/channels/).

## Criteria

| # | Criterion | How |
|---|---|---|
| 1 | The manifest is reachable and well-formed | `schema` is `1`, `channel_id` matches `/opt/picoaide/CHANNEL`, `server.version` is the running version |
| 2 | Download URLs are safe | `client.assets.*.url` is **absolute https**; `client_unavailable` is a failure — handle its stated reason |
| 3 | The installer downloads completely | fetch it and compare against the `sha256` and `size` in the manifest |
| 4 | Resume works | a request with `Range: bytes=0-99` returns **206** with a 100-byte body |
| 5 | The download surface exposes installers only | a request for a non-whitelisted extension such as `.json` returns a 404 JSON envelope; the response carries `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` |
| 6 | Client packages follow the image | after a server upgrade the manifest's `client.version` changes (see [Upgrade, backup & rollback](/en/deployment/upgrade/)) |

Copy-pasteable commands for criteria 3 and 4:

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
MANIFEST=$(curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest")
FILE=$(printf '%s' "$MANIFEST" | sed -n 's/.*"url": "https:\/\/[^"]*\/updates\/client\/\([^"]*\)".*/\1/p' | head -1)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" -o /tmp/client.pkg "https://$DOMAIN/updates/client/$FILE"
sha256sum /tmp/client.pkg
curl -sk -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/updates/client/$FILE"     # expect 206
```

**Two implicit criteria of the download surface** (do not relax them when changing code):

- **Only whitelisted extensions are served** (`.dmg` / `.exe` / `.appimage` / `.deb` / `.zip` /
  `.tar.gz` / `.msi` / `.pkg`), and only as **regular files** inside the asset directory (symlinks,
  directories and device files all return 404) — this route is unauthenticated, and the directory is
  populated by CI artefacts and `docker cp`, i.e. untrusted input;
- **The write deadline is derived from the file size** (a floor rate of 64 KiB/s, a minimum of 5 minutes
  and a maximum of 1 hour). Why not the global 5 minutes: installers are hundreds of MB, and a slow link
  (below ~525 KB/s) would be cut off at the global timeout with no way for employees to work around it.

## Boundaries and failure behaviour

| Symptom | Criterion | Recovery |
|---|---|---|
| Employees see "always up to date" | The manifest contains `client_unavailable` | Set `PICOAI_PUBLIC_BASE_URL=https://<domain>` and run `docker compose up -d server`; mandatory behind a reverse proxy |
| The portal shows no download entry point | The manifest has no `client` section **and no** `client_unavailable` | The image carries no client assets (`CLIENT-RELEASE.json` unreadable): make sure this is a released package, not a locally built image. The other cause is the admin setting `portal.public=false` (the portal is not public, so the root path redirects to the admin sign-in page) — clear that setting |
| A download dies midway | The client offers a retry | Expected: the file is large and links are slow; the client resumes over Range. Server-side the write deadline is max(5 minutes, size/64 KiB/s), capped at 1 hour |
| Download returns 404 | The body is a JSON `NOT_FOUND` envelope | The file name is not in the asset manifest, or its extension is not whitelisted; use the `file` value from the manifest instead of assembling a name by hand |
| Installer verification fails | The client UI reports a checksum failure | Corrupted transport or a half-cached file: download again; verify server-side with criterion 3 that the manifest's sha256 matches the bytes actually served |
| Employees are on an old version and apps will not open | Client version < server version | Apps open only inside the client and require matching versions: ask employees to upgrade; an old client failing to open apps is expected |
| The client cannot reach the server (internet only through a proxy) | The client log says `proxy direct` | Open the escape hatch: channel field `desktop.allow_system_proxy: true`, or the real process environment `PICOAI_ALLOW_SYSTEM_PROXY=1`, then restart the client |
| macOS says the developer cannot be verified | No notarisation ticket inside the package | Only **release** channel packages are notarised; pre-release packages are signed only. Point employees at the release build, or cut a proper release tag through the channel process |
| Two clients ended up installed on one machine | Two different application identifiers | Different channels are **separate applications** (application id, data root and single-instance lock are all channel-scoped); reinstalling the same channel overwrites, a different channel coexists (see [Channels & white-label](/en/deployment/channels/)) |

## Related

- [Deployment overview](/en/deployment/) — deliverable and container architecture
- [Container deployment](/en/deployment/compose/) — first-time deployment and the portal self-check
- [Upgrade, backup & rollback](/en/deployment/upgrade/) — upgrading the server is upgrading the client
- [Channels & white-label](/en/deployment/channels/) — branding and client data isolation
- [Air-gapped deployment](/en/deployment/offline/) — the boundary of the client's zero-internet dependency
- [Desktop client](/en/desktop/) — client capabilities and the standalone form
