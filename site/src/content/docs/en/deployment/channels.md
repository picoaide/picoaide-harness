---
title: Channels & white-label
description: 'The PicoAide Harness channel mechanism: why channel content is built into the image, why channels never upgrade into one another, which deployment values must agree, and how to diagnose branding lost after an upgrade.'
---

The same code base can be delivered as multiple **channels**. A channel decides what a given
deliverable is called, what it looks like and where it upgrades from, and channels **never upgrade into
one another** — this is a correctness requirement, not a configuration option.

## What this page solves

Deciding "which channel is this stack, and can an upgrade silently turn it into another one", plus what
channel-related failures look like. It covers: the three channel types → where channel content lives and
which fields exist → the release matrix (which tags build which channels) → the values that must agree
on the deployment side → criteria → boundaries and failure behaviour (including diagnosing "branding
disappeared after an upgrade").

**Prerequisites**: channel content comes from the **private channel repository** (fetched at build time)
and is injected into the image. This documentation always uses placeholders (`<channel id>`, `<brand>`,
`harness.example.com`) — real channel identities never enter the public repository or this page.

## The three types of channel

| Channel | Purpose | Distribution surface |
|---|---|---|
| `official` | Official releases | Update server `release.picoaide.com/official/` + GitHub Release (complete historical archive) |
| `beta` | Pre-release (version tags containing `-beta` / `-rc` / `-alpha`) | Update server `release.picoaide.com/beta/` + GitHub Pre-release |
| `<channel id>` | Enterprise custom / white-label delivery | **Only** via the update server `release.picoaide.com/<channel id>/` (never in a public Release) |

Each channel has its own directory on the update server, with a structure identical to the official one:

```
<channel>/latest.json
<channel>/releases/<version>/picoaide-server-<version>-amd64.zip
<channel>/releases/<version>/SHA256SUMS
```

## Design trade-offs

**Why channel content is built into the image instead of uploaded at runtime.** Branding, copy, marks,
data root and deep-link scheme are all injected at build time
(`docker build --build-arg CHANNEL=<channel id>`), and the admin console deliberately offers **no**
editor for them. Two reasons: **auditability** — "which brand is this machine running" can be read out
of the image and compared byte for byte, rather than being a database row someone can edit; and
**immutability** — once channel fields can be rewritten at runtime, "washing a customised deployment
back to the official brand" is one mistaken edit away.

**Why channels never upgrade into one another (refuse at startup instead of falling back).** At startup
the server verifies "the channel inside the image == the process channel", and during update checks it
verifies "the manifest's `channel_id` == this deployment's channel". Any mismatch **refuses**: an
invalid `PICOAI_CHANNEL` refuses to start; content conflicting with the process channel refuses to
start; a mismatched manifest channel is reported as "update check unavailable" (not as "no new
version"). Why not fall back to `official`: a fallback would let a customised deployment accept the
official manifest, losing its branding and channel configuration after the upgrade, **with no error
anywhere**.

**Why one image archive carries identical tags in every channel (while the content differs).** Channel
differences live in the image **content** (`/opt/picoaide/channel/` and the baked channel marker), not
in the tag. That creates an operational constraint worth remembering: a second channel stack on the same
host overwrites identically named tags when it runs `docker load`, so every archive additionally carries
a channel-specific tag and a multi-stack host's `.env` must point at it
(see [Upgrade, backup & rollback](/en/deployment/upgrade/)).

## Where channel content lives

A channel is not a runtime configuration upload; it is injected at build time and frozen into the image:

```
image build --build-arg CHANNEL=<channel id>
        ├─ ENV PICOAI_CHANNEL=<channel id>   ← runtime channel identity
        ├─ /opt/picoaide/CHANNEL             ← authoritative declaration file (works even if the deployment sets nothing)
        └─ /opt/picoaide/channel/            ← channel content (names / copy / marks / accent colour)
```

Channel content includes:

| Category | Content |
|---|---|
| Identity | Display name, short name (sidebar), window title, tagline |
| Copy | Sign-in page and client welcome text, portal welcome text |
| Assets | Light and dark logos, favicon, accent colour |
| Client | Data root directory, built-in server address, installer name (slug), application id, deep-link scheme, app origin scheme |
| Optional | Whether the speech model ships with the client (`desktop.speech_bundle_model`, on by default; when on the installer grows by about +140–250 MiB), whether the system proxy may be used (`desktop.allow_system_proxy`) |

The same content drives the **client sign-in page, the client UI, the admin console sidebar and the
portal** — one configuration, consistent across the product. When the server is unreachable or older, the
client renders the **bundled copy** of the branding and never falls back to the vendor mark.

`desktop.app_origin_scheme` (the origin scheme for WASM apps, `<scheme>://<app_id>`) is **mandatory for
every channel**: missing / invalid / identical to the deep-link scheme / duplicated across channels ⇒
**the build stops and that channel produces no artefact** (no silent fallback). Branded channels must
also provide the logo and app icon: missing assets are caught by the packaging checks instead of
producing an installer that carries the vendor icon.

### Getting the speech model into a customer network (`desktop.speech_*`)

Speech input runs locally, and **the model weights ship with the client by default**
(`desktop.speech_bundle_model` defaults to `true`): the build puts the weights into the artefact and the
assembly step points the upstream configuration at them — **zero network, zero download**. Only a
channel that explicitly opts out (writing `false`) falls back to "download on first use", and that
download is **direct** (clients refuse to use any proxy by default), so in a network that reaches the
internet *only* through an authenticated proxy an opted-out channel stays stuck at preparation failure.

| Field | Purpose | Value |
|---|---|---|
| `desktop.speech_bundle_model` | **Ship the weights with the client** (on by default: works right after install, zero network, zero download) | Boolean, default `true`; write `false` to opt out. When on, the installer grows by about **+140–250 MiB** (the weights are about 230 MiB; the increase depends on how well the platform's package format compresses them) |
| `desktop.speech_model_dir` | A pre-placed model directory (**zero download**) | An absolute path, or a `{default, darwin, linux, win32}` platform map |
| `desktop.speech_vad_path` | A pre-placed Silero VAD file (still downloaded when only the model directory is pre-placed) | Same as above |
| `desktop.speech_model_origin` | An intranet mirror (HuggingFace-compatible, same model paths and file names) | Only a `http(s)://host[:port]` shape (**plain `http://` is accepted too**, matching the upstream configuration schema exactly); **no path allowed** |

A few semantics worth knowing:

- **Bundled weights take precedence over a pre-placed directory or mirror**: when both are configured the
  bundled payload wins (what is already on the machine beats a network configuration);
- **Pre-placed paths are not checksum-verified** (upstream only checks that the file exists), so version
  matching is the deployer's responsibility; a wrong path fails loudly with
  `Speech model verification failed` during preparation rather than degrading into "looks fine but
  transcribes nothing";
- **Configuring `modelOrigin` removes the public fallback**: an unavailable mirror means a failed
  download (an explicit source is an explicit intent);
- A malformed value (relative path, unknown platform key, a mirror URL with a path, the string `"true"`)
  makes the client **fall back to downloading**, but the **build-time** CI stops that channel — do not
  ship a misconfiguration to customer machines.

## Release matrix (which tags build which channels)

| Trigger | Channels built | Notes |
|---|---|---|
| Pre-release tag (contains a hyphen, e.g. `vX.Y.Z-beta.N`) | **`beta` only** | Branded channels' clients are **not** produced on a pre-release tag — branded packages can only come from a **release tag** (the workflow only has `pull_request` and `push` triggers, with **no** `workflow_dispatch` manual entry point) |
| Release tag (plain `vX.Y.Z`) | **All channels** (official + beta + every branded channel) | A branded channel's image and installers only appear in that channel's own update directory |
| Not a tag (PR / branch push) | `official` only | Used for gates and smoke tests, not as a deliverable |

⇒ **When adding or changing a branded channel field**: make the change in the channel repository and
**push** it, then wait for a **release tag**; otherwise customers keep receiving packages with the old
behaviour. Criterion: whether that channel's `latest.json` on the update server already points
`server.version` at the new release.

## Values the deployment side must keep consistent

| Value | Decided by | Notes |
|---|---|---|
| This deployment's channel | **The image** (`/opt/picoaide/CHANNEL`) | `.env`'s `PICOAI_CHANNEL` **may be left empty**; if set it must match the image |
| Update manifest address | `PICOAI_UPDATE_ENDPOINT`, empty = this channel's default directory | **Empty does not mean off**; write `off` to disable |
| The manifest's `channel_id` | The `latest.json` in that channel's directory | Must equal this deployment's channel |
| The image tag (multi-stack hosts) | The `<channel id>-<version>` tag in each archive | Each stack's `SERVER_IMAGE` must point at its own channel tag |

The server enforces this at startup and during update checks:

- An invalid `PICOAI_CHANNEL` → **refuses to start** (it never falls back to `official`);
- The image's channel conflicting with the process channel (typically because `.env` / compose overrode
  the image declaration) → **refuses to start**;
- A manifest `channel_id` that differs from this deployment → reported as "update check unavailable",
  not as "no new version"; channels never silently upgrade into one another.

> Upgrading from an older version: compose no longer hard-codes a channel. If `.env` still carries a
> hand-written `PICOAI_CHANNEL=official`, a branded deployment is judged inconsistent — delete that line.

## Criteria

```bash
cd /opt/picoaide
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)

# 1) the channel baked into the image (authoritative declaration)
docker exec picoaide-server cat /opt/picoaide/CHANNEL

# 2) the channel the server reports publicly
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/channel"

# 3) the update endpoint resolved at startup
docker compose logs --tail=200 server | grep -i 'channel resolved'

# 4) the channel in the manifest (the one clients verify too)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

| # | Criterion | Passing looks like | Failing looks like |
|---|---|---|---|
| 1 | The image channel is readable | `cat /opt/picoaide/CHANNEL` prints this stack's channel id | The file is missing ⇒ the image is not a released package |
| 2 | The public channel agrees | `/api/client/v2/channel`'s `channel_id` == criterion 1 | They differ ⇒ the channel was overridden and the container may already have refused to start |
| 3 | The update endpoint is right | the log's `channel resolved: … (update endpoint …)` points at this channel's directory | An empty endpoint ⇒ update checks were explicitly set to `off`; another channel's endpoint ⇒ the upgrade will be refused (never a silent cross-channel upgrade) |
| 4 | The manifest channel agrees | `channel_id` == criterion 1 | Mismatch ⇒ the server reports the update check as unavailable |

## Boundaries and failure behaviour

| Symptom | Criterion (how to confirm) | Recovery |
|---|---|---|
| "New version available" never appears | `docker compose logs server` prints `manifest channel "…" != this server's channel "…"` | The three channel values disagree: most often `PICOAI_CHANNEL` was changed without the endpoint (or the reverse); it may also be that the endpoint is set to `off`. The server caches for **6 hours**, so a delay right after a release is normal |
| The container exits at startup, printing an invalid channel configuration | the log names `PICOAI_CHANNEL` | That value (or the image's channel marker) is not a valid channel id: fix the spelling or remove the override — **never** count on a fallback |
| The container exits at startup, printing a channel mismatch | the log names the image channel and the process channel | `.env` / compose overrode the channel and it differs from the image content: remove the override or make it match the image |
| Branding changed after an upgrade / the portal shows vendor branding | `cat /opt/picoaide/CHANNEL` ≠ `/api/client/v2/channel`'s `channel_id` | Wrong channel image: point `.env` back at this channel's **channel tag** and recreate; verify the image id as described in [Upgrade, backup & rollback](/en/deployment/upgrade/) and do not keep upgrading from it |
| Customers received old-behaviour packages | That channel's `latest.json` still shows the old `server.version` | Branded channels are only produced on a **release tag**: wait for one, or confirm the channel repository change was pushed (CI fetches from the channel repository) |
| The client shows different branding from the server | The client's sign-in page / sidebar branding | The client's branding comes from the **bundled copy** (used when the server is unreachable or older): reinstall the client delivered with the server (see [Client delivery & updates](/en/deployment/client-delivery/)) |
| Two channel stacks on one host overwrite each other's branding | One stack's container image id points at another channel's image | Channel tag overwrite: redo the multi-stack section of [Upgrade, backup & rollback](/en/deployment/upgrade/) (`.env` must point at `<channel id>-<version>`) |

## Client data isolation (channels can coexist)

A channel-scoped client keeps its configuration, sessions, connector credentials and browser data in its
**own** data directory, so clients of different channels can live on the same machine without
interfering:

- Official channel: `~/.picoaide-harness`;
- Pre-release channel (`beta`): **shares the official release's data directory** — a pre-release is the
  release's own verification stage, so sign-in state, settings and sessions must carry over (this is
  deliberate: a separate directory would make pre-release users lose their existing sessions after
  upgrading);
- Branded channels: a channel-derived separate directory, which **must not** share the official one
  (the two clients may use different session-format generations, and sharing would silently fork the
  data);
- The application's user-data directory and the Windows application identity are channel-scoped too, so
  two clients never steal each other's single-instance lock.

Browser SSO callbacks use the channel's own deep-link scheme, so a sign-in callback never lands in
another channel's client.

## How client upgrades relate to channels

**Employee clients do not need to know which channel they belong to**: they only ask "the server I signed
in to", and the server's channel is structurally decided by its own image. So a "client channel differs
from server channel" state cannot exist, and no cross-channel upgrade can wash a deployment over.

Bespoke installers are delivered straight from the server's portal
(see [Client delivery & updates](/en/deployment/client-delivery/)); employee machines never need the
internet.

## Related

- [Deployment overview](/en/deployment/) — deliverable, certificate modes and the iron rules
- [Upgrade, backup & rollback](/en/deployment/upgrade/) — channel tags on multi-stack hosts
- [Client delivery & updates](/en/deployment/client-delivery/) — client branding and data roots
- [Operations & troubleshooting](/en/deployment/operations/) — logs and common faults
