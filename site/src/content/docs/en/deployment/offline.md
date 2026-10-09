---
title: Air-gapped deployment
description: 'Deploying and upgrading PicoAide Harness when the server or employee machines cannot reach the internet: bypass fetching, verification, internal mirrors and the semantics of the update check switch.'
---

The product's main form is enterprise intranet deployment, so "does it work offline" breaks down into
two separate questions: the **employee side already has zero internet dependency**, and the **server side
has exactly one external dependency** (the update check and fetching images). This page explains that
boundary and the bypass procedure for fully isolated environments.

## What this page solves

Three questions: do employee machines really need the internet? Can a server with no outbound access
still be deployed and upgraded? Should the update check be disabled or repointed? It covers: the
internet-dependency boundary → bypass fetching (with its verification criteria) → internal mirrors and
the update-check switch → version anchors and upgrade cadence when isolated → intranet certificate
trust → criteria → failure behaviour.

**Prerequisites**:

| Prerequisite | Notes |
|---|---|
| One **internet-connected** staging machine | It only needs to download the image archive and `SHA256SUMS` once, then carry them inside |
| The target host can run Docker and `docker load` | Importing an image needs no internet |
| This deployment's channel id is known | The fetch directory and the manifest's `channel_id` must match it |

## The internet-dependency boundary

| Who | Needs internet? | Notes |
|---|---|---|
| **Employee machines** | **Not at all** | Client installers and update packages are delivered by the enterprise server (see [Client delivery & updates](/en/deployment/client-delivery/)) |
| **The enterprise server** | Only for "checking for updates + downloading images" | Reaching `release.picoaide.com` is enough; in a fully isolated environment use the bypass on this page |
| The deployed runtime | No | The server depends on no external service; upstream models are configured by administrators on the gateway page |

## Design trade-offs

**Why the image is not stored in a registry.** See [Deployment overview](/en/deployment/): the deliverable
is one zip plus one `SHA256SUMS`, hosted over HTTPS in per-channel directories. That way a **fully
isolated** machine room needs **one out-of-band transfer** (USB stick / jump host) per deployment or
upgrade, instead of opening a registry port on that machine or configuring an image proxy.

**Why "empty ≠ off" for the update check.** An empty `PICOAI_UPDATE_ENDPOINT` means "use this channel's
default directory"; only an explicit `off` / `none` / `-` / `disabled` disables it. Reading "empty" as
"off" would silently remove upgrade notifications from **every** default deployment; reading "off" as
"empty" would make a pure intranet machine send outbound requests. Both misreadings have real costs, so
the semantics have to be explicit.

**Why only 3 versions are kept.** Each channel **keeps only the 3 most recent versions** on the update
server: image archives are large (hundreds of MB up to the GB range, since they contain installers for
the three platforms), and the retention policy keeps the rollback anchors (the previous one and the one
before that) fetchable without letting storage and distribution costs grow without bound. Older versions
come from the [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases) page (the public
channels' complete archive).

## Procedure

### 1. Fetch and verify on an internet-connected machine

```bash
# 1) Read the version (authoritative fields: server.version / server.image_tag)
curl -fsS https://release.picoaide.com/<channel>/latest.json

# 2) Download the image archive and the checksum file
VER=<version>         # ← use server.version from the manifest (without v)
curl -fL -o picoaide-server-${VER}-amd64.zip \
  "https://release.picoaide.com/<channel>/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/<channel>/releases/${VER}/SHA256SUMS"

# 3) Verify (once here, and again after carrying it inside)
sha256sum -c SHA256SUMS
```

**Criterion**: `sha256sum -c` prints `OK`; the zip size does not matter — `SHA256SUMS` is authoritative.
`<channel>` must match this deployment's channel; a package from the wrong channel is refused by the
startup check after import (see [Channels & white-label](/en/deployment/channels/)).

If a cross-border download is slow, parallel chunking helps: a single stream measured 75–260 KB/s and
eight parallel streams about 2 MB/s. Some Range requests are ignored by the CDN and return the whole
file — **the checksum remains the final criterion**, so never skip verification because "the chunked
download succeeded".

### 2. Carry it inside and import

```bash
# Copy to the target host (scp shown; a USB stick or jump host works the same way)
scp picoaide-server-${VER}-amd64.zip SHA256SUMS <user>@<target host>:/tmp/

# On the target host: verify first, then import
ssh <user>@<target host>
cd /tmp && sha256sum -c SHA256SUMS
unzip -p picoaide-server-${VER}-amd64.zip image.tar | docker load
```

If the host has no `unzip`, the Python standard library replaces it:

```bash
python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract("image.tar")' \
  picoaide-server-${VER}-amd64.zip
docker load -i image.tar
```

After import the deployment steps are identical to the online case: see
[Container deployment](/en/deployment/compose/). The upgrade flow is in
[Upgrade, backup & rollback](/en/deployment/upgrade/); the only difference is that step 4's image comes
from the archive carried in.

**Criterion**: `docker run --rm --entrypoint /app/picoaide-server picoaide-harness-server:<version> --version`
prints `<version>`. Do not judge the version from `docker images`.

### 3. Disable or rework the update check

```bash
# Disable update checks (for a pure intranet that must not make outbound requests)
PICOAI_UPDATE_ENDPOINT=off
```

- **Empty does not mean off**: empty = this channel's default directory; disabling requires an explicit
  `off` / `none` / `-` / `disabled`;
- If the intranet runs its own static file service, the image archives and `latest.json` can be mirrored
  inside and `PICOAI_UPDATE_ENDPOINT` pointed at the internal address — that `latest.json`'s
  `channel_id` must match this deployment's channel, otherwise the check is reported as unavailable
  (deliberate: rather say "unavailable" than silently upgrade across channels);
- Once disabled, the admin console's server info page no longer shows new-version hints, and operations
  upgrades by hand following the [upgrade flow](/en/deployment/upgrade/).

**Criterion**: `docker compose logs --tail=200 server | grep -i 'channel resolved'` — an empty endpoint
means update checks are off, an internal address means it was repointed to an internal mirror. Both are
fine, but **know which one you chose**.

### 4. Upgrade cadence and version anchors when isolated

A fully isolated deployment has no "new version available" hint, so version anchors come from comparing
two places by hand:

```bash
cat /opt/picoaide/VERSION                                     # currently deployed version
docker exec picoaide-server /app/picoaide-server --version    # running version
```

Both should equal the target version written during the last upgrade. If they differ, the last upgrade
only changed one of the two — **find out why before the next upgrade** (see the criteria table in
[Upgrade, backup & rollback](/en/deployment/upgrade/)). Also record which old image tags this host keeps
(the rollback anchors): fetching an old package again in an isolated environment means another
out-of-band transfer.

### 5. Intranet certificates and client trust

`internal` mode issues certificates from Caddy's local CA; the link is encrypted, but the client has to
trust that CA on first connection:

- With an internal enterprise CA, use `manual` mode with a proper certificate and clients need nothing
  extra;
- With `internal` mode, distribute Caddy's root certificate to employee machines;
- Either way, the client's sign-in page refuses non-HTTPS remote addresses.

Post-deployment self-check (no DNS needed; it resolves to the local host):

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

The second must show `client.assets` with absolute https URLs — a reverse proxy or certificate setup
without `PICOAI_PUBLIC_BASE_URL` is the most common miss here, and its symptom is employees seeing
"always up to date". Note that this is a different thing from the update check: **clients fetch packages
from this server** (this criterion) while **the server checks the update server for new versions**
(step 3).

## Criteria

| # | Criterion | How |
|---|---|---|
| 1 | The package is intact | `sha256sum -c SHA256SUMS` prints `OK` (once on the connected machine, once on the target) |
| 2 | The image is usable | `<image> --version` == target version |
| 3 | The deployment is usable | `/healthz` returns 200 and the manifest has `client.assets` with absolute https URLs |
| 4 | The update-check semantics are explicit | the endpoint in the startup log's `channel resolved: …` matches your choice (empty = off / an internal address = a mirror) |
| 5 | The version anchors agree | the `VERSION` file == the `--version` output |
| 6 | Employees need no internet | confirm on an employee machine that the enterprise domain alone is enough to download and sign in |

## Boundaries and failure behaviour

| Symptom | Criterion | Recovery |
|---|---|---|
| The target version is past the retention window (404) | the download returns 404 | Each channel **keeps only the 3 most recent versions**: take it from GitHub Releases (public channels only), or roll back to an old image tag kept on this host |
| Re-publishing the same version still serves the old bytes | the downloaded sha256 does not match the new `SHA256SUMS` | The zip and `SHA256SUMS` under `<channel>/releases/<version>/` are **immutable long-cache** objects: after overwriting the same version, the edge may still serve the old bytes. Either publish under a new version number, or add a cache-busting parameter and verify again |
| The internal mirror's manifest is reported as "update check unavailable" | the log shows `manifest channel "…" != this server's channel "…"` | The internal `latest.json`'s `channel_id` must match this deployment's channel — this check exists to prevent cross-channel upgrades; do not bypass it |
| A pure intranet machine still makes outbound requests | packet capture / firewall logs | `PICOAI_UPDATE_ENDPOINT` was left empty instead of `off`: empty means the default public directory |
| The first client connection reports an untrusted certificate | `internal` mode only | Expected: distribute Caddy's local CA to employee machines, or switch to `manual` with a corporate certificate |
| The container exits right after importing the image | the log says "channel mismatch" or "invalid channel configuration" | Wrong channel package: fetch this channel's package instead (see [Channels & white-label](/en/deployment/channels/)) |
| A rollback is needed but no old image can be found | `docker image ls` shows no old version tag | Retention only covers the update server: isolated deployments must **keep old image tags on the host**, or carry the old package in beforehand |

## Related

- [Deployment overview](/en/deployment/) — deliverable and image sources
- [Container deployment](/en/deployment/compose/) — the steps after importing the image
- [Upgrade, backup & rollback](/en/deployment/upgrade/) — offline upgrades and rollback order
- [Client delivery & updates](/en/deployment/client-delivery/) — why the employee side needs no internet
- [Channels & white-label](/en/deployment/channels/) — channel directories and channel verification
