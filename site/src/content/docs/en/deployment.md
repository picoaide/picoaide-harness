---
title: Private Deployment Guide
description: 'Understand PicoAide Harness deployment in an enterprise intranet: containerized server (PostgreSQL), LDAP/OIDC integration and operations.'
---

This article describes how PicoAide Harness is deployed in an enterprise intranet, from environment preparation to onboarding members.

## Deployment forms

| Form | Use case | Description |
|---|---|---|
| **Standalone desktop deployment** | Individuals / small teams | Employees install a desktop client; the client automatically starts a local Harness service and creates a default `desktop` profile; data stays on the local machine |
| **Enterprise intranet deployment** | Entire organization | Run the Go server + Admin Console (webadmin) on an intranet server; employees access it via the client or a browser; accounts, quotas, billing and approvals are centrally governed |

## Environment requirements

- **Desktop client**: Windows 10+ x64 / macOS 12+ (Apple silicon) / Linux x64 (AppImage + deb); no Node.js, pnpm or DSH required;
- **Server**: Linux x64 server; a single binary is enough to run (`picoaide-server`, gin), and Docker Compose containerization is also supported (Caddy reverse proxy, fixed IP on a private subnet, non-root uid 10001, data bind mount);
- **Database**: **built-in PostgreSQL 18** (a postgres:18-alpine container within Compose; the external-PG `DB_MODE=pg-external` form has been removed);


## Deployment methods

### Deployment guide (AI-executable)

The server ships as **a single container image** that already contains everything needed to deploy
(the compose file, Caddyfiles, and the client installers). Deployment and upgrades are driven by a
**guide document** — there are no install scripts:

```sh
# 1) Get the image (online) or download the image archive from the update server and docker load it
docker pull ghcr.io/picoaide/picoaide-harness-server:<version>
# 2) Unpack the deployment files into the deploy directory (they live inside the image)
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out \
  ghcr.io/picoaide/picoaide-harness-server:<version>
# 3) Follow the guide: write .env → docker compose up -d → verify the health endpoint
```

- Deployment guide:
  [`docs/deploy/AI-DEPLOY.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/deploy/AI-DEPLOY.md)
  — first deployment, upgrade, rollback, troubleshooting, and four data-safety rules; safe to hand to
  an AI agent;
- A single compose file (`docker-compose.yml` with caddy + server + postgres); three certificate modes
  (`internal` local CA / `auto` Let's Encrypt / `manual` enterprise certificate) selected via
  `TLS_MODE` in `.env`;
- **Data always lives in bind-mounted directories**: `picoaide-data/` (application data plus
  `master.key`) and `pg-data/` (the database). Upgrades replace the image only and never touch data;
- Back up before every upgrade: losing `master.key` makes every encrypted upstream key in the
  database **permanently unrecoverable**.

### Server upgrades

By default the server checks our update server for new versions (environment variable
`PICOAI_UPDATE_ENDPOINT`, default `https://release.picoaide.com/official/latest.json`); the webadmin
"Server info" page shows when an update is available. An administrator performs the upgrade by
following the deployment guide. After the server is upgraded, **employee clients upgrade along with
it**, because client installers ship inside the server image and clients fetch them from that same
server — so a "new client against an old server" mismatch cannot happen.

### Docker Compose architecture

```
Employee clients / browsers
      │ HTTPS(80/443)
      ▼
   Caddy 2 (reverse proxy + TLS termination, fixed IP 172.28.0.2)
      │ HTTP:8080 (compose private subnet only)
      ▼
   Go server (non-root uid 10001, exposes 8080, fixed IP 172.28.0.3)
      │
      ▼
   PostgreSQL 18 (built-in container, fixed IP 172.28.0.4, data ./pg-data)
```

- Custom private-subnet bridge (default `172.28.0.0/24`, configurable via `NETWORK_SUBNET`); fixed IPs stay unchanged across container rebuilds;
- The server does not map a host port, so external traffic can only enter through Caddy (intranet isolation + reduced attack surface);
- **All persistent data uses `./` bind mounts, not named volumes**: `picoaide-data/` (master.key + app data), `caddy-data/`, `caddy-config/`, `certs/` (manual certificates), `pg-data/` (PG mode, mounted at `/var/lib/postgresql` inside the container); backup = copy the deployment directory directly, or follow the deployment guide to package `picoaide-data/` plus a `pg_dump`.

### Images and versions

- Image: `ghcr.io/picoaide/picoaide-harness-server` (linux/amd64, with SBOM + provenance attestation);
- Tags: `latest` + `vX.Y.Z` + `vX.Y`; after pushing a version tag CI automatically builds and releases (injected via `--build-arg VERSION`, so `picoaide-server --version` matches the tag exactly);
- **Version-line note**: the server image belongs to the same product line as the desktop client and shares the same `v*` tag (e.g. `v2.4.x`, same source as the repo-root `package.json`); on tag push, CI runs `scripts/version.mjs check` to verify the image version matches the root `package.json`, so `picoaide-server --version` matches the tag exactly;
- No outbound internet in the intranet? Download the image archive from the update server (`releases/<version>/picoaide-server-<version>-amd64.zip`) and run `unzip -p archive image.tar | docker load`; build locally with `make docker-image`.

## Configure the gateway

After deployment, log in to the Admin Console at `/admin/` and go to the **Gateway configuration** page:

1. Add an **upstream provider**: channel (e.g. deepseek), base URL, API key, model list;
2. Set the **default model** and per-user **rate limiting**;
3. Configure **peak windows** (multiple Beijing-time windows + weekdays) and the model `offpeak_discount`;
4. Configure **model pricing** (input/output unit price, CNY per M tokens; leave empty = unpriced or billed at the input price); DeepSeek cache hits are billed at the cache price;
5. Set the **login mode**: local / LDAP / OIDC / both (LDAP and OIDC fields see [Admin Console](./admin)).

> Billing records pricing at the time of the call: changing prices/windows only affects costs incurred afterward; the quota chain (employee tokens → employee money → department budget, any one over-limit returns 429 `QUOTA_EXCEEDED`, admin exempt).

## Onboarding members

1. In **Users**, create a user (username + password + whether admin), or configure LDAP/OIDC to onboard through an external identity source;
2. Assign a department and budget; set the user quota (tokens / money) or follow the global default;
3. After employees log in to the client/browser, they can use chat, the Capability Hub, connectors, scheduled tasks and other capabilities;
4. Admins approve employee-uploaded skills/agents in the **Capability Hub** and grant them (by user/department) — only then is shared content visible and installable.

## Security and operations essentials

- **Secrets**: upstream provider keys are **encrypted at rest with AES-GCM** (`enc:v1:`, master key file, 0600), never stored in plaintext; API tokens store only a SHA-256 hash (90-day expiry), and changing the password / downgrading privileges / disabling automatically revokes all tokens (same transaction);
- **Admin side**: session 12h (hard TTL + 60-min idle sliding expiry) + CSRF (HMAC time window ±1h); login dual-bucket rate limiting (10 attempts / 5 minutes / key, no trust in X-Forwarded-For); unified error envelope; `/healthz` unauthenticated probe (DB ping, 503 = DB unavailable);
- **Certificates**: three modes — `manual` (enterprise CA / self-signed placeholder, supports IPs), `auto` (Let's Encrypt automatic renewal, direct-connect public domain only, with built-in direct-connect/IP validation), `internal` (Caddy local CA, works out of the box in the intranet); employee client logins reject non-HTTPS addresses (TOFU);
- **Backup and recovery**: the deployment guide's backup steps package the app data + **master.key** in one shot (if lost, encrypted keys are unrecoverable) + the Caddy certificate store (+ `pg_dump`); recovery = stop the service and unpack → `up -d`; upgrades recreate containers in sequence (brief downtime), downgrades are not guaranteed compatible;
- **Offline deployment**: fetch the image archive from the update server (or the GitHub Release attachment), then `unzip -p archive image.tar | docker load` and follow the deployment guide.

## Further reading

- [System Architecture](./architecture) — server layering, data flow, security design
- [API Reference](./api-reference) — health probe, auth, and gateway endpoints
- [Admin Console](./admin) — webadmin guide
- In-repo operational manual: [`docs/deploy/AI-DEPLOY.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/deploy/AI-DEPLOY.md) (deploy/upgrade/rollback/troubleshooting) and `server/docs/02-build-deploy.md` (build, systemd, CI)
