---
title: Deployment overview
description: 'PicoAide Harness enterprise private deployment overview: deliverables, distribution surfaces, container architecture, certificate modes and the data-safety rules.'
---

PicoAide Harness is delivered for the **enterprise intranet**: a single machine runs the server, employees install the client, and the data and keys all stay on the enterprise's own machines.
This page explains the deployment forms and the deliverables; see the other pages in this section for the actual steps.

> The repository's [`docs/deploy/AI-DEPLOY.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/deploy/AI-DEPLOY.md)
> is the **only authoritative deployment guide** (first deployment / upgrade / rollback / troubleshooting + the four data-safety rules), and can be handed straight to an AI agent to execute.
> This Wiki is the same process written for humans; if the two ever diverge, the repository document and the code win.

## Three deployment forms

| Form | Suitable for | Description | Entry point |
|---|---|---|---|
| **Standalone desktop** | Individuals / small teams | Install only the desktop client. The client ships a local Harness runtime and starts the service on the local machine; sessions and credentials stay on that machine, and no server is needed | [Desktop client](/en/desktop/) |
| **Containerized on an enterprise intranet** (recommended) | Everyone in the organization | An intranet server runs the three containers `caddy + server + postgres`; accounts, gateway, quotas, billing and approvals are centralized on the server | [Container deployment](/en/deployment/compose/) |
| **Merged into an existing reverse proxy / single binary** | Data centers that already have a unified entry point | When 80/443 are already taken by a shared Caddy/nginx, start only `server + postgres` and merge them into the existing vhost; a single binary + external PostgreSQL is also supported (including migrating from systemd) | [Operations & troubleshooting](/en/deployment/operations/) |

## Deliverables: one image + one guide

The server has **exactly one release artifact**: a container image. Everything needed for deployment is already inside the image — no repository clone, no fetching configuration from the internet, and no install scripts of any kind.

```
Deliverable = one container image
  ├─ server binary (with the embedded webadmin Admin Console)
  ├─ client installers for three platforms + CLIENT-RELEASE.json   ← employees download from here
  ├─ docker-compose.yml + Caddyfile.{internal,autocert,manual} + .env.example
  ├─ VERSION / CHANNEL                          ← this deployment's version and channel
  └─ channel/                                   ← branding and copy (channel content)
```

A single command exports the deployment files to the deployment directory (via the image's built-in `PICOAI_UNPACK_STACK` entry point):

```sh
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out \
  picoaide-harness-server:<version>
ls -1 /opt/picoaide   # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
```

Exporting uses **replace semantics**: `docker-compose.yml`, `Caddyfile.*`, `.env.example`, `client/` and `VERSION` are cleared before being written;
`.env`, `picoaide-data/`, `pg-data/`, `caddy-data/` and `certs/` are never touched.

## Where to get the image

**No image registry is involved** (GHCR has been retired). Images for every channel come from the update server, with one separate directory per channel:

```
https://release.picoaide.com/<channel>/latest.json                         ← version manifest (the server's upgrade check reads it too)
https://release.picoaide.com/<channel>/releases/<version>/picoaide-server-<version>-amd64.zip
https://release.picoaide.com/<channel>/releases/<version>/SHA256SUMS          ← always verify after downloading
```

Key fields of `latest.json`:

| Field | Meaning |
|---|---|
| `channel_id` | Which channel this manifest belongs to (the server enforces the comparison, see [Channels & white-label](/en/deployment/channels/)) |
| `server.version` | Target version (without `v`, e.g. `2.7.0`) |
| `server.image_tag` | Image tag (with `v`, e.g. `v2.7.0`); after import both the `2.7.0` and `v2.7.0` tags exist |
| `server.image_asset` | Download URL of the image archive |
| `client.version` | Client version released with this image version (same source as the server) |

- The update server **keeps only the 3 most recent versions**; earlier versions come from the GitHub Release (the complete historical archive for public channels);
- The GitHub Release **only publishes the image archives and `SHA256SUMS` of public channels** (official / pre-release); brand channels are custom customer deliveries and do not go through the public Release;
- For environments without internet access, see [Air-gapped deployment](/en/deployment/offline/).

## Environment requirements

| Item | Requirement |
|---|---|
| Server | Linux x64; Docker ≥ 24 and Compose v2 (`docker compose`, not `docker-compose`), `openssl`, `curl`, `unzip` |
| Resources | ≥ 4 cores / 8 GB RAM / 50 GB free disk recommended (`pg-data/` keeps growing) |
| Network | The server must be able to reach `https://release.picoaide.com` (update checks + image downloads); **employee computers need no internet access at all** |
| Ports | Caddy uses host ports 80/443 (changeable via `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`) |
| Client | Windows 10+ x64 / macOS 12+ (Apple silicon) / Linux x64; no Node.js, pnpm or DSH required |

## Container architecture

```
Employee clients / browsers
      │ HTTPS(80/443)
      ▼
   Caddy 2 (reverse proxy + TLS termination, fixed IP 172.28.0.2)
      │ HTTP:8080 (compose private subnet only)
      ▼
   Go server (non-root uid 10001, fixed IP 172.28.0.3)
      │
      ▼
   PostgreSQL 18 (built-in container, fixed IP 172.28.0.4, data ./pg-data)
```

- A custom bridge private subnet (default `172.28.0.0/24`, configurable via `NETWORK_SUBNET`); container IPs are declared fixed in compose and stay unchanged after rebuilds/upgrades;
- **The server does not map a host port**, so external traffic can only enter through Caddy (intranet isolation + reduced attack surface);
- **All persistent data uses `./` bind mounts, never named volumes**:

| Directory | Content | Notes |
|---|---|---|
| `picoaide-data/` | Application data + **`master.key`** | Losing it means the upstream keys encrypted in the database are **permanently undecryptable**; a backup is mandatory |
| `pg-data/` | Built-in PostgreSQL 18 data | Mounted at `/var/lib/postgresql` in the container (since PG18 the data lands in the `18/docker/` subdirectory) |
| `caddy-data/` `caddy-config/` | Caddy certificate store and configuration | Must be backed up in `auto` mode, otherwise certificates are re-issued |
| `certs/` | Manual certificates | `manual` mode only |
| `deploy-backup/` | Backup output | Written by the backup steps |

## Certificate modes (choose one of three)

`TLS_MODE` in `.env` decides which Caddyfile template is mounted:

| Mode | Template | Suitable for | Prerequisite |
|---|---|---|---|
| `internal` | `Caddyfile.internal` | **Pure intranet / no public domain** (most common) | None; on first connection the client must trust Caddy's local CA |
| `auto` | `Caddyfile.autocert` | A public domain that **connects directly** to this machine | The domain's A record points to the machine's public IP and 80/443 are open to the internet; **going through a CDN will fail**, and IPs are not accepted |
| `manual` | `Caddyfile.manual` | The enterprise already has a proper certificate (IPs supported) | Provide `certs/server.crt` + `certs/server.key` |

How to decide: the domain resolves to a public address and can be reached directly → `auto`; otherwise → `internal`. Deployments by IP always use `internal` or `manual`.

## Four iron rules (violating them causes unrecoverable data loss)

| # | Forbidden | Reason |
|---|---|---|
| 1 | **Never run** `docker compose down -v`, `docker volume prune` or `docker system prune --volumes` | `-v` / `prune` delete data volumes and image layers, taking the database and `master.key` with them; the data lives in bind-mounted directories, so `down` (without `-v`) does not delete it |
| 2 | **Never use the `latest` tag** | It is not reproducible and gives no rollback anchor; always use a concrete version such as `vX.Y.Z` |
| 3 | **Always back up before an upgrade**, and confirm the backup files are not empty | `picoaide-data` (including `master.key`) + `pg_dump`; if `master.key` is lost, every encrypted upstream key in the database can never be decrypted again |
| 4 | **Never overwrite an existing deployment directory with `.env`** | A `.env` already present in the deployment directory means it has been deployed before — that is an **upgrade** scenario, so follow the upgrade process instead of reinstalling |

Also: do not delete the old image before the health check passes (it is the rollback anchor); do not change the fixed IPs / subnet in compose just to get the service running;
database migrations are irreversible, so rolling back the image **cannot** downgrade the database to the old schema.

## Next steps

1. [Container deployment](/en/deployment/compose/) — the complete first deployment, from fetching the image to the health check
2. [Upgrade, backup & rollback](/en/deployment/upgrade/) — version check, backup, switching and rolling back
3. [Client delivery & updates](/en/deployment/client-delivery/) — clients ship with the server; employees need no internet access
4. [Channels & white-label](/en/deployment/channels/) — official / pre-release / enterprise-custom channels
5. [Air-gapped deployment](/en/deployment/offline/) — getting the package when the server has no internet access
6. [Operations & troubleshooting](/en/deployment/operations/) — reverse proxy, certificates, backup and restore, common failures
