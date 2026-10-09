---
title: Deployment overview
description: "Private deployment of PicoAide Harness: why the deliverable is a single image, why data may only live in bind mounts, how to choose a certificate mode, and the four iron rules."
---

PicoAide Harness is delivered **inside your own network**: one server runs the enterprise server,
employees install the desktop client on their own machines. Sessions, files and the sandbox stay on
the employee machine; accounts, the model gateway, metering and approvals stay on your server.
This page covers the deployment forms, the deliverable, and the design decisions that run through
every other page; the concrete steps live in [container deployment](/en/deployment/compose/) and
[upgrade, backup & rollback](/en/deployment/upgrade/).

> [`docs/deploy/AI-DEPLOY.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/deploy/AI-DEPLOY.md)
> in the repository is the **authoritative deployment guide** (first install / upgrade / rollback /
> troubleshooting) and can be handed to an AI agent as-is. This wiki is the same process written for
> humans; where the two disagree, the repository document and the code win.

## What this page answers

| Your question | Section |
|---|---|
| Which form fits our situation? | [Three deployment forms](#three-deployment-forms) |
| What exactly is the deliverable, where does it come from, how is it verified? | [The deliverable](#the-deliverable-one-image), [Where to get the image](#where-to-get-the-image) |
| What runs on the server, where does data live, can it be lost? | [Container architecture](#container-architecture), [Where data lives](#where-data-lives-bind-mounts) |
| Where do the HTTPS certificates come from? | [Certificate modes](#certificate-modes-choose-one-of-three) |
| Which operations are forbidden? | [Four iron rules](#four-iron-rules) |
| How do I know a deployment succeeded, and what does failure look like? | [Success criteria](#success-criteria), [Boundaries and failure behaviour](#boundaries-and-failure-behaviour) |

**Prerequisites**: a Linux x64 host that can run Docker, plus three facts already confirmed with the
user — the public address (`DOMAIN`), the certificate mode (`TLS_MODE`) and the initial admin
password. **Do not invent these three**: the address decides whether employees can connect at all,
and a wrong certificate mode makes clients fail to connect (see
[Boundaries and failure behaviour](#boundaries-and-failure-behaviour)).

## Three deployment forms

| Form | Fits | Description | Entry point |
|---|---|---|---|
| **Standalone desktop** | Trials / single-machine evaluation | Only the desktop client — it ships its own local Harness service, sandbox and bundled Node / pnpm / Python. It still needs **a server to sign in to**: the model catalogue, keys and grants all come from the server, and before sign-in the main window *is* the sign-in page | [Desktop client](/en/desktop/) |
| **Enterprise containers** (recommended) | A whole organisation | Three containers on an intranet server: `caddy + server + postgres`. Accounts, gateway, balance, approvals and audit all live on the server | [Container deployment](/en/deployment/compose/) |
| **Behind an existing reverse proxy / single binary** | Sites that already have one shared entry point | If 80/443 is already held by a shared Caddy/nginx, start only `server + postgres` and join the existing vhost; a single binary with an external PostgreSQL (including a migration away from systemd) is supported too | [Operations & troubleshooting](/en/deployment/operations/) |

All three forms use the **same client**: it always signs in to a server for its model catalogue and
configuration (that server can run on the very same machine — see the standalone form above).
In the enterprise form the client version is decided by the server
(see [Client delivery & updates](/en/deployment/client-delivery/)).

## Design trade-offs: why it works this way

These five points are constraints, not implementation details; changing them breaks deployment,
upgrade and rollback together.

**① The deliverable is exactly one container image.** The image already contains everything a
deployment needs (server binary, embedded admin console, installers for the three platforms, the
compose file, the Caddyfile templates, `.env.example`, channel content, built-in skills).
Why not an install script: a script drifts away from the image it installs, and "a script plus a
pile of internet dependencies" simply cannot run in an isolated customer machine room. One image
means one download, one checksum, one `docker load`; the version is bound to the content (the
`VERSION` file and `--version` can be cross-checked) and there is no "clone the repo to fetch
configuration" step at all.

**② No image registry is involved.** The server image is pushed to **no** registry (public or
private; GHCR was retired). Every channel has its own directory on the update server
(`<channel>/releases/<version>/`). Two reasons: a channel image carries **customer branding and a
bundled client**, so pushing a bespoke deliverable into a multi-tenant registry would expose
customer identity to third-party storage; and many customer environments forbid pulling from public
registries, so "fetch a zip over HTTPS" is the only distribution path that works everywhere.
The price is that the customer verifies the bytes, which is why every version directory carries
`SHA256SUMS` (see [Where to get the image](#where-to-get-the-image)).

**③ Data may only live in bind mounts, never in named volumes.** `picoaide-data/`, `pg-data/`,
`caddy-data/` and `certs/` are all **host directories** under the deployment directory (bind mounts).
Because a backup must be "pack one directory", an audit must be able to point at a host file, moving
to another machine is a directory copy, and named volumes live and die with Docker
(`docker compose down -v` and `docker volume prune` would take the data with them). With bind
mounts, destroying the database has to happen **explicitly** on the host filesystem — which is where
iron rule 1 comes from.

**④ Never use the `latest` tag.** The image tag is the rollback anchor: when something goes wrong the
only move is "point `SERVER_IMAGE` back at the previous version". `latest` cannot answer "which one
was the previous version", and it makes "is the running version the one I think it is" unprovable.
Always use a concrete version tag, and on a multi-stack host the **channel-specific** tag
(see [Upgrade, backup & rollback](/en/deployment/upgrade/)).

**⑤ Back up before upgrading, and verify the backup is not empty.** Database migrations are
**irreversible** (a new version moves the schema forward), so the only way back is the `pg_dump` and
the `picoaide-data/` snapshot taken before the upgrade. "The file exists" is not "the content is
valid": an empty file, a truncated tar and a failed `pg_dump` all leave a file behind, so the check
is `[ -s … ]` (non-empty), not `ls`. `picoaide-data/master.key` is the worst case — lose it and
every encrypted upstream API key (AES-GCM ciphertext) in the database is **permanently
undecryptable** and has to be re-entered.

## The deliverable: one image

```
deliverable = one container image
  ├─ server binary (with the admin console embedded)
  ├─ installers for the three platforms + CLIENT-RELEASE.json   ← employees download from here
  ├─ docker-compose.yml + Caddyfile.{internal,autocert,manual} + .env.example
  ├─ VERSION / CHANNEL                                          ← this deployment's version and channel
  ├─ channel/                                                   ← channel content (names / copy / marks / accent)
  └─ skills/                                                    ← built-in skills (installed on demand)
```

One command exports the deployment files into the deployment directory (the image's built-in
`PICOAI_UNPACK_STACK` entry point):

```sh
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out \
  picoaide-harness-server:<version>
ls -1 /opt/picoaide   # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
```

The export uses **replace semantics**: `docker-compose.yml`, `Caddyfile.*`, `.env.example`,
`client/` and `VERSION` are cleared and rewritten (otherwise `client/` would keep installers from two
versions and employees could download the old one). `.env`, `picoaide-data/`, `pg-data/`,
`caddy-data/` and `certs/` are **never touched**. The export needs no downtime and does not change
the running containers — it only writes files; switching versions happens when you edit `.env` and
run `docker compose up -d`.

## Where to get the image

```
https://release.picoaide.com/<channel>/latest.json                             ← version manifest (the server's update check reads it too)
https://release.picoaide.com/<channel>/releases/<version>/picoaide-server-<version>-amd64.zip
https://release.picoaide.com/<channel>/releases/<version>/SHA256SUMS           ← always verify after downloading
```

Key fields in `latest.json`:

| Field | Meaning |
|---|---|
| `schema` | Manifest structure version; currently `1` |
| `channel_id` | Which channel this manifest belongs to (the server compares it strictly, see [Channels & white-label](/en/deployment/channels/)) |
| `server.version` | Target version (without `v`, e.g. `<version>`) |
| `server.image_tag` | Image tag (with `v`, e.g. `v<version>`); the archive also carries the bare version tag and the channel tag `<channel-id>-<version>` (multi-stack hosts must use the channel tag) |
| `server.image_asset` | Download URL of the image archive |
| `client.version` | Client version shipped inside this image (same origin as the server) |
| `published_at` | When this version was published (UTC) |

- Each channel **keeps only the 3 most recent versions** on the update server; older ones come from
  the [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases) page (the public
  channels' history);
- GitHub Releases carry **only public channels** (official / pre-release) images and `SHA256SUMS`;
  branded channels are bespoke deliveries and never appear in a public release;
- For servers with no outbound internet, see [Air-gapped deployment](/en/deployment/offline/).

## Environment requirements

| Item | Requirement |
|---|---|
| Server | Linux x64; Docker ≥ 24 with Compose v2 (`docker compose`, not `docker-compose`), `openssl`, `curl`, `unzip` |
| Resources | ≥ 4 cores / 8 GB RAM / 50 GB free disk recommended (`pg-data/` keeps growing); a host with **less than ~4 GiB available memory must select the `small` profile explicitly**, otherwise the server's startup self-check refuses to start |
| Network | The server must reach `https://release.picoaide.com` (update check + image download); **employee machines need no internet at all** |
| Ports | Caddy takes host ports 80/443 (`CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`; changing them means editing the Caddyfile too) |
| Clients | Windows x64 / macOS (Apple silicon) / Linux x64; employee machines need no Node.js, pnpm or DSH |

## Container architecture

```
employee clients / browsers
      │ HTTPS (80/443)
      ▼
   Caddy 2 (reverse proxy + TLS termination, fixed IP 172.28.0.2)
      │ HTTP:8080 (compose-private network only)
      ▼
   Go server (the entrypoint fixes volume ownership as root, then drops to user picoaide; fixed IP 172.28.0.3)
      │
      ▼
   PostgreSQL 18 (bundled container, fixed IP 172.28.0.4, data in ./pg-data)
```

- A custom bridge network (default `172.28.0.0/24`, changeable via `NETWORK_SUBNET`) with container
  IPs declared in the compose file, so they survive container recreation and upgrades;
- **The server publishes no host port** (`expose: 8080` only), so all external traffic enters through
  Caddy;
- All three containers rotate their logs with `max-size: 50m` and `max-file: 3`.

## Where data lives: bind mounts

| Directory | Content | If it is lost |
|---|---|---|
| `picoaide-data/` | Application data + **`master.key`** | Every encrypted upstream key in the database becomes **permanently undecryptable** |
| `pg-data/` | PostgreSQL 18 data | Accounts, usage, approvals and audit are all gone |
| `caddy-data/` `caddy-config/` | Caddy certificate store and configuration | `auto` mode has to re-issue certificates |
| `certs/` | Manual certificates (`manual` mode) | Certificates must be placed again |
| `deploy-backup/` | Backup output | Only a backup directory; deleting it means having no way back |

`pg-data/` is mounted at `/var/lib/postgresql` inside the container (since PG 18 the data lives in the
`18/docker/` subdirectory). **Do not** change it to the old `/var/lib/postgresql/data`: the
entrypoint treats that as an "unused mount" and refuses to start.

## App access model: apps need no public entry point

Employee-built WASM apps open **only inside the desktop client**: the client opens a dedicated window
and loads a custom-protocol address `<channel app origin scheme>://<app_id>/` (the scheme comes from
the channel configuration; official and beta use `picoaide-app`). The client's protocol handler
forwards execution to the server's single entry point
`POST /api/client/v2/apps/wasm/:app_id/request` (with the employee's bearer token).

So the server needs **no** public surface for apps:

- no app-specific DNS record (`DOMAIN` is the only public name);
- no app-specific certificate (the three certificate modes below serve the main domain only);
- no extra Caddy site block. The pre-2026-09-19 "dedicated app domain + browser access" chain has
  been removed entirely, which is why all three prerequisites above are gone;
- **upgrades must keep server and client on the same version**: after the removal, old clients can no
  longer open apps. Clients take their package from this server, so make sure employee clients move
  to the matching version;
- **there is no downgrade path in this release**: the old and new access models cannot coexist, and
  the server cannot be put back on the old model.

## Certificate modes (choose one of three)

`TLS_MODE` in `.env` decides which Caddyfile template the compose file mounts:

| Mode | Template | Fits | Prerequisite |
|---|---|---|---|
| `internal` | `Caddyfile.internal` | **Pure intranet / no public domain** (most common) | None; on first connection the client must trust Caddy's local CA |
| `auto` | `Caddyfile.autocert` | A public domain that reaches this host **directly** | The domain's A record points at this host's public IP and 80/443 are open to the internet; **a CDN breaks it**, and IPs are not accepted |
| `manual` | `Caddyfile.manual` | The company already has a proper certificate (IPs supported) | Provide `certs/server.crt` + `certs/server.key` |

How to decide: the domain resolves publicly and can be reached directly → `auto`; otherwise →
`internal`. IP-only deployments always use `internal` or `manual`. All three share one compose file;
switching is just editing `TLS_MODE` and running `docker compose up -d`.

## Four iron rules

| # | Forbidden | Reason |
|---|---|---|
| 1 | **Never run** `docker compose down -v`, `docker volume prune` or `docker system prune --volumes` | Such commands delete volumes and image layers; even though the data lives in bind mounts, they show up next to "tidying up" and are the most common unrecoverable accident in the field |
| 2 | **Never use the `latest` tag** | Not reproducible and impossible to anchor a rollback to; always use a concrete version tag |
| 3 | **Always back up before an upgrade**, and confirm the backup is **not empty** | `picoaide-data/` (including `master.key`) plus a `pg_dump`; lose `master.key` and every encrypted upstream key in the database can never be decrypted again |
| 4 | **Never overwrite an existing deployment directory with `.env`** | An existing `.env` means the host is already deployed — that is an **upgrade**; follow the upgrade flow instead of reinstalling |

Also:

- Do not delete the old image before the health check passes — it is the rollback anchor;
- Do not change the fixed IPs or subnet in the compose file just to make the stack start (it will
  collide with existing containers);
- Database migrations are **irreversible**: rolling the image back cannot move the database back to
  the old schema; a cross-generation rollback must restore the database too.

## Success criteria

A first deployment counts as successful only when every row passes:

| # | Criterion | Command |
|---|---|---|
| 1 | All three containers Up (postgres healthy) | `docker compose ps` |
| 2 | The health probe returns 200 | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"` |
| 3 | Running version == target version | `docker exec picoaide-server /app/picoaide-server --version` |
| 4 | `master.key` exists | `ls -1 /opt/picoaide/picoaide-data/master.key` |
| 5 | The manifest has `client.assets` with **absolute https** URLs | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"` |
| 6 | The stack's channel matches the image | `docker exec picoaide-server cat /opt/picoaide/CHANNEL` equals `channel_id` from `GET /api/client/v2/channel` |

**How it fails**: row 2 still not 200 after 120 seconds, row 3 the wrong version, row 5 showing
`client_unavailable`, row 6 two different channels. If any of these holds, do **not** report
"deployment complete"; diagnose with [Boundaries and failure behaviour](#boundaries-and-failure-behaviour),
and during an upgrade go straight to [rollback](/en/deployment/upgrade/).

## Boundaries and failure behaviour

| Symptom | Criterion (how to confirm) | Action |
|---|---|---|
| The server is up but employees cannot connect | In `internal` mode the client reports an untrusted certificate | Expected: distribute Caddy's local CA to employee machines, or switch to `manual` with a corporate certificate |
| `auto` mode never obtains a certificate | Caddy logs show ACME validation failures | The domain must point **directly** at this host with 80/443 open; behind a CDN or with an IP only ⇒ use `manual` / `internal` |
| The caddy container fails to create: `not a directory` | `docker compose ps` shows no caddy | `TLS_MODE` is misspelled (only `internal` / `auto` / `manual` exist) |
| Containers keep restarting | `docker compose logs --tail=100 server` | Two common causes: the PostgreSQL password does not match `pg-data`; or available memory is below 4 GiB while the profile is still `default` (the log says the WASM platform self-check refused to start) ⇒ write `PICOAI_WASM_MEMORY_PROFILE=small` in `.env` |
| healthz stays non-200 | `docker compose ps` to see whether postgres is healthy | The first start runs every migration and takes 1–2 minutes; if it still fails, read the server log |
| `docker compose up` reports a port or subnet conflict | `ss -tlnp`, `docker network inspect` | Changing ports means editing the Caddyfile too; subnet conflicts need `NETWORK_SUBNET` plus the three fixed IPs; if `picoaide-net` already exists with a different subnet, **stop and confirm** instead of `docker network rm` |
| Employees see "always up to date" | The manifest contains `client_unavailable` | The server cannot produce an absolute https download URL: set `PICOAI_PUBLIC_BASE_URL=https://<domain>` and run `docker compose up -d server` |
| Apps will not open / report unavailable | The client version is older than the server | Apps open only in the desktop client and require matching versions: upgrade the client; an old client being unable to open apps is expected behaviour, not a fault |
| Ports 80/443 are taken by another service on the host | `ss -tlnp \| grep -E ':(80\|443)\b'` | Do not fight for the port: start only `server + postgres` behind the existing reverse proxy, see [Operations & troubleshooting](/en/deployment/operations/) |

**Acknowledged boundary**: the three forms differ in *where the server runs and how it is exposed* —
the server always exists and the client always signs in to it. A team with no Linux host at all, and no
intention of preparing one, can only evaluate the client against somebody else's deployment (or a
temporary server on a laptop); that usage has no accounts, no central metering and no central approval
or audit.

## Next steps

1. [Container deployment](/en/deployment/compose/) — the full first install, from fetching the image to the health check
2. [Upgrade, backup & rollback](/en/deployment/upgrade/) — version check, backup, image switch and rollback
3. [Client delivery & updates](/en/deployment/client-delivery/) — clients ship with the server; employees need no internet
4. [Channels & white-label](/en/deployment/channels/) — official / pre-release / bespoke channels
5. [Air-gapped deployment](/en/deployment/offline/) — fetching packages when the server cannot reach the internet
6. [Operations & troubleshooting](/en/deployment/operations/) — reverse proxies, certificates, restores and common faults
