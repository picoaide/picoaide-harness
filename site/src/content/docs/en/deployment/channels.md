---
title: Channels & white-label
description: 'The PicoAide Harness channel mechanism: branding content, isolation checks and upgrade safety for official, pre-release and enterprise custom channels.'
---

The same code base can be delivered as multiple **channels**. A channel decides what a given installer is
called, what it looks like and where it upgrades from, and channels **never upgrade into one another** — this is
a correctness requirement, not a configuration option.

## The three types of channel

| Channel | Purpose | Distribution surface |
|---|---|---|
| `official` | Official releases | Update server `release.picoaide.com/official/` + GitHub Release (complete historical archive) |
| `beta` | Pre-release (version tags containing `-beta` / `-rc` / `-alpha`) | Update server `release.picoaide.com/beta/` + GitHub Pre-release |
| `<brand-id>` | Enterprise custom / white-label delivery | **Only** via the update server `release.picoaide.com/<brand-id>/` (not published to public Releases or build artifacts) |

Each channel has its own directory on the update server, with a structure identical to the official one:

```
<channel>/latest.json
<channel>/releases/<version>/picoaide-server-<version>-amd64.zip
<channel>/releases/<version>/SHA256SUMS
```

## Channel content travels with the image

A channel is not a runtime-uploaded configuration; it is **injected at build time** and baked into the image:

```
image build --build-arg CHANNEL=<channel>
        ├─ ENV PICOAI_CHANNEL=<channel>     ← runtime channel identity
        ├─ /opt/picoaide/CHANNEL            ← authoritative declaration file
        └─ /opt/picoaide/channel/           ← channel content (name / copy / marks / accent color)
```

Channel content includes:

| Category | Content |
|---|---|
| Marks | Display name, short name (sidebar), title, tagline |
| Copy | Login page and client welcome messages, portal welcome message |
| Assets | Light/dark logo pair, favicon, accent color |
| Client | Deep-link scheme (browser SSO callback), **app-origin scheme (`desktop.app_origin_scheme`, the WASM app origin — required for every channel)**, data-root directory, built-in server address, installer name and app ID |

> **`desktop.app_origin_scheme` is a required field added on 2026-09-19** (including `official` / `beta`;
> the official and prerelease channels use `picoaide-app`): it decides the origin of a WASM app inside
> the client (`<scheme>://<app_id>`). **A missing / invalid field, the same value as the deep-link scheme,
> or a value duplicated across channels aborts the CI build ⇒ that channel produces no artifacts**
> (there is no silent fallback). Add the field in the channels repo, **push it, then tag** (CI pulls from
> the channels repo's `origin/main`). Rules and consequences: channel package reference §4.4b.

This content applies at the same time to **the client login page, the client UI, the Admin Console sidebar and
the portal page** — configured in one place, consistent across the product.
When the server is unreachable or running an older version, the client shows branding from the copy shipped with
the package and does not fall back to the vendor mark.

### Getting the speech model into a customer network (`desktop.speech_*`, since 2026-09-29)

Voice input recognizes speech on the machine, and **the model weights ship inside the client by default**
(`desktop.speech_bundle_model` defaults to `true`): the build packs the int8 weights into the product and the
desktop assembly points the upstream config items at them (`modelDirectory` / `vadModelPath`) — **zero network,
zero download**. Only a channel that explicitly opts out (writes `false`) falls back to "download on first use",
and that download goes **direct** (the client forbids proxies by default), so in a network where only an
authenticated proxy reaches the internet an opted-out channel never gets past preparation. Of the four fields
below, `speech_bundle_model` picks the path; the other three apply only **after** opting out (the bundled payload
wins over a channel-configured directory or mirror — turn bundling off to override it):

| Field | Effect | Value |
|---|---|---|
| `desktop.speech_bundle_model` | **Ship the weights with the client** (**on by default**: every channel's installer carries the model, so voice works right after install with zero network) | Boolean; default `true`. Set `false` to opt out (back to "download on first use"). When on, the installer grows by about **+140–250 MiB** (the weights are about 230MiB; the increase depends on how well the platform's package format compresses them) |
| `desktop.speech_model_dir` | Pre-placed model directory (**zero download**) | An absolute path, or `{default, darwin, linux, win32}` (one config serves all three platforms) |
| `desktop.speech_vad_path` | Pre-placed Silero VAD file (1.8MB; still downloaded when only the model directory is pre-placed) | Same as above |
| `desktop.speech_model_origin` | Internal mirror (HuggingFace-compatible; model paths and file names unchanged) | `http(s)://host[:port]` only (plain **`http://` is accepted too** — the shape matches the upstream Config schema verbatim) — **no path** |

What you must know:

- **`speech_bundle_model` is a build-time switch that defaults to on**: the build pulls the weights into the
  artifact (sizes and sha256 verified against the upstream manifest), and the client points the plugin's own
  `modelDirectory`/`vadModelPath` at the copy inside the client directory — the official config path, with no
  "release on first run" step and no extra 230MiB in the data root. A build that cannot fetch the weights
  **fails** rather than shipping a package that only pretends to carry them.
- **A bundled payload wins over pre-placed/mirror configuration** (what is installed locally beats network config).
- **Pre-placed files are not hash-verified** (upstream only checks that they exist), so version matching is the
  deployment's responsibility; a wrong file shows up as an explicit `Speech model verification failed` rather than
  a silent downgrade.
- **Configuring `modelOrigin` removes the public fallback**: a mirror that is down means the download fails.
- A malformed value (relative path, unknown platform key, mirror with a path, the string `"true"`) falls back to
  downloading in the client, but **CI stops that channel at build time**.

## Release matrix (which tags build which channels)

| Trigger | Channels built | Notes |
|---|---|---|
| Prerelease tag (`vX.Y.Z-beta.N` / `-rc` / `-alpha`, contains a hyphen) | **`beta` only** | Branded channels' clients are **not** produced on prerelease tags — a branded package can only be produced by a **stable tag** (the workflow has just `pull_request` and `push`; there is **no** `workflow_dispatch` manual entry point) |
| Stable tag (plain `vX.Y.Z`) | **All channels** (official + beta + every branded channel) | A branded channel's image and installers appear only in that channel's own update directory |
| Non-tag (PR / branch push) | `official` only | For gates and smoke tests, not a deliverable |

⇒ **When adding or changing a field for a branded channel (e.g. `app_origin_scheme`)**: change it in the
channels repo, **push**, then wait for a **stable tag** (prerelease tags do not build branded channels);
otherwise customers keep receiving packages with the old behaviour.

> The release workflow has **no** `workflow_dispatch`: the `on:` block of `.github/workflows/ci.yml` carries
> only `pull_request` and `push`. Claiming a manual entry point that does not exist just leads to a workflow
> that never appears (or runs the default branch), so this page states the fact — wait for a stable tag.

## Branded channels' assets are **required** (not an optional fallback)

A branded channel (anything other than `official` / `beta`) must ship both assets below, and `assets.logo` in
`channel.json` must point at the `logo.svg` one:

| Asset | Used for | What breaks without it |
|---|---|---|
| `logo.svg` + `assets.logo` in `channel.json` | Tray bitmaps, the bundled `web-brand/favicon.svg`, the in-package inline logo (login page while the server is unreachable) | Without `assets.logo` the package has no inline logo and the login page falls back to the **vendor mark**; declaring another file name gives the login page and the tray **two different brands** |
| `app-icon.png` (1024×1024, 16-bit RGBA, embedded ICC) | Installer / Dock / taskbar / window icon | Without it the icons fall back to the **vendor icon** (with no signal on the deliverable) |

Both are enforced **at build time** (the field checks in `scripts/ci-channels.sh` plus `brand-prepare` during
packaging), because the white-label gate re-derives assets with the same rules and compares — when both sides
fall back to the official assets it is comparing a value with itself and structurally cannot see this.
`official` / `beta` are exempt: their brand *is* the vendor's, so falling back to the official assets is
expected there and is recorded with a searchable log line.

## Three values the deployment side must keep consistent

| Value | Decided by | Description |
|---|---|---|
| This deployment's channel | **Carried by the image** (`/opt/picoaide/CHANNEL`) | `PICOAI_CHANNEL` in `.env` **may simply be left empty**; if set, it must match the image |
| Update manifest address | `PICOAI_UPDATE_ENDPOINT`; empty = this channel's default directory | **Empty does not mean disabled**; to disable it, explicitly write `off` |
| `channel_id` in the manifest | `latest.json` in the corresponding directory on the update server | Must be the same as this deployment's channel |

The server enforces these checks at startup and when checking for updates:

- Invalid `PICOAI_CHANNEL` → **refuses to start** (it does not fall back to `official`: a fallback would let a
  custom deployment accept the official manifest and wash its branding away);
- The channel inside the image differs from the channel of the process (typically because `.env`/compose
  overrode the image declaration) → **refuses to start**;
- The manifest `channel_id` differs from this deployment → treated as "update check unavailable" rather than
  "no new version", so that it is visible and can be fixed; upgrades never silently cross channels.

> Note for deployments upgraded from older versions: the compose default **no longer hard-codes a channel**.
> If `PICOAI_CHANNEL=official` was left in `.env` by hand, a custom-channel deployment will be judged
> inconsistent — just delete that line.

### The image tag is a fourth value on multi-stack hosts

Channel differences live in the **image contents**, not in the tag: every channel's archive carries
the same `picoaide-harness-server:v<version>`. On a host running two channel stacks, the later
`docker load` overwrites that tag, so `docker compose up -d server` on either stack can rebuild it
from the **other** channel's image (branding and bundled installers wrong, while `.env` looks
perfectly correct). Each archive therefore also carries a channel-scoped tag
`picoaide-harness-server:<channel-id>-<version>`; point each stack's `SERVER_IMAGE` at its own
channel tag. Steps and the post-change verification are in
[Upgrade, backup and rollback](/en/deployment/upgrade/).


## Troubleshooting

| Symptom | Cause |
|---|---|
| "New version found" never appears | The three channel values are inconsistent (most commonly: `PICOAI_CHANNEL` was changed but the endpoint was not, or vice versa); `docker compose logs server` prints `manifest channel "official" != this server's channel "…"`; it may also be that `PICOAI_UPDATE_ENDPOINT` was explicitly set to `off` |
| The container exits immediately at startup, printing that the channel configuration is invalid | `PICOAI_CHANNEL` (or the in-image channel marker) is not a valid channel id; fix the spelling or remove the override |
| The container exits immediately at startup, printing that the channels are inconsistent | The channel overridden by `.env`/compose differs from the image content; remove the override or set it to match the image |
| Branding is gone after an upgrade | This should not happen on the normal path (two startup checks + the manifest channel comparison). If it does, someone manually pointed at the wrong image/manifest: stop the upgrade immediately and investigate |

## Client data isolation (channels can coexist)

A channel-specific client stores its configuration, sessions, connector credentials and browser data in **its
own** data directory, so clients of different channels can be installed on the same machine without affecting
each other (the official channel keeps its existing directory and behavior unchanged):

- Official channel: `~/.picoaide-harness`;
- Custom channels: a separate directory derived from the channel (never mixed with the official directory);
- The application's user data directory and the Windows application identity are likewise channel-specific, so
  that two clients do not fight over each other's single-instance lock.

Browser SSO callbacks use the channel's own deep-link scheme, so a login callback never crosses over to a client
of another channel.

## How client upgrades relate to channels

**An employee client does not need to know which channel it belongs to**: it only asks the server it logs in to,
and that server's channel is structurally determined by its own image. So there is no state in which "the client
channel differs from the server channel", and no possibility of being shuffled across channels by an upgrade.

Enterprise custom installers are delivered directly by the server portal (see
[Client delivery & updates](/en/deployment/client-delivery/)), and employee machines need no internet access at
any point.
