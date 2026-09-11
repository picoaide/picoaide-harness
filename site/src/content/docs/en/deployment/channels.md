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
| Client | Deep-link scheme (browser SSO callback), built-in server address, installer name and app ID |

This content applies at the same time to **the client login page, the client UI, the Admin Console sidebar and
the portal page** — configured in one place, consistent across the product.
When the server is unreachable or running an older version, the client shows branding from the copy shipped with
the package and does not fall back to the vendor mark.

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
