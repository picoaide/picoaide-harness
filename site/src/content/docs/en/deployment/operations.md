---
title: Operations & troubleshooting
description: 'Day-to-day operations for the PicoAide Harness server: backups and restores, probes and logs, shared reverse proxies, migrating off a single binary, security essentials and how to diagnose common failures.'
---

This page is for a deployment that is **already running**: where the data is, how to back it up and
restore it, how to see the current state, and where to look when something breaks. For the first install
see [Container deployment](/en/deployment/compose/); for switching versions see
[Upgrade, backup & rollback](/en/deployment/upgrade/).

## What this page solves

Managing the days after "deployment complete": what day-to-day checks cover, what makes a backup valid,
how to join a shared reverse proxy, and the **criterion** (how to confirm this is the problem) plus the
**recovery** for every common failure.

**Prerequisites**: the server is running per [Container deployment](/en/deployment/compose/), with three
containers Up and `/healthz` returning 200. The commands below assume the deployment directory is
`/opt/picoaide` and the containers are `picoaide-server` / `picoaide-postgres`.

## Design trade-offs

**Why a backup is "pack a few directories".** All persistent data lives in bind mounts under the
deployment directory (see [Deployment overview](/en/deployment/)), so a backup needs no
database-specific export format and no downtime: packing `picoaide-data/` plus an online `pg_dump` is a
complete way back. Conversely, "is there a backup" can be **falsified directly on the filesystem**
(does the file exist, is it non-empty) without depending on any external service's state.

**Why `master.key` gets called out separately.** It is the **only** decryption root: once
`picoaide-data/master.key` is gone, every `enc:v1:` ciphertext in the database (upstream API keys) is
permanently undecryptable and has to be re-entered. So it is backed up with the application data *and*
kept separately for the long term.

**Why the state surface is split across two probes.** `/healthz` answers "can the execution plane serve
requests" (a failed DB ping returns 503); `/readyz` answers "are the resource levels and the publishing
plane still able to work" (memory profile and budget, compile-cache occupancy, write and publish
blockers). The reason for splitting them: **a healthy execution plane does not mean a usable publishing
plane** — for example, a full app-platform compile cache blocks new app releases while employees keep
using existing apps. Both probes are unauthenticated, so they can feed a load balancer or monitoring
directly.

**Why we do not fight for a shared reverse proxy's ports.** Ports 80/443 on a host are often already held
by another service (another site, error tracking), and that proxy already manages certificates and
multiple site blocks. The right move is to have this product's `server` container **join the existing
proxy's upstream** (publishing one internal address), not to stop someone else's proxy or to bind this
product's Caddy to 443 as well.

## Data and backup

| Directory | Content | Consequence of loss |
|---|---|---|
| `picoaide-data/` | Application data + **`master.key`** | Encrypted upstream keys in the database become **permanently undecryptable** |
| `pg-data/` | PostgreSQL 18 data | Accounts, usage, approvals and audit logs are all lost |
| `caddy-data/` `caddy-config/` | Caddy certificate store and configuration | `auto` mode has to re-issue |
| `certs/` | Manual certificates (`manual` mode) | Certificates must be placed again |

```bash
cd /opt/picoaide
TS=$(date +%Y%m%d-%H%M%S); OUT=deploy-backup; mkdir -p "$OUT"

docker exec picoaide-server sh -c 'tar czf - -C /data .' > "$OUT/picoaide-data-$TS.tar.gz"
docker exec picoaide-postgres pg_dump -U picoaide -Fc picoaide > "$OUT/pg-data-$TS.dump"
[ -d caddy-data ] && tar czf "$OUT/caddy-data-$TS.tar.gz" -C . caddy-data

[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! application data backup is empty"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! database backup is empty"
ls -lh "$OUT" | tail -5
```

**Criterion**: neither `[ -s … ]` prints `!!!`, and both files have a plausible size.
**What an empty backup means**: `pg_dump` failed while the shell still created the file — there is **no
database way back**, so do not treat it as "backup done". Fix `pg_dump` (container name, user
`picoaide`, database `picoaide`, free disk), redo it and verify again.

Restore steps live in the rollback section of [Upgrade, backup & rollback](/en/deployment/upgrade/): a
**same-generation** rollback only swaps the image; a **cross-generation** rollback must
**stop the service → restore the `pg_dump` → roll the image back → roll the clients back**. Restoring
`picoaide-data/` happens only when the application data was damaged (it loses everything written after
the upgrade and needs explicit consent).

**Moving to another machine**: copy the whole deployment directory (keep file permissions, especially
for `picoaide-data/` and `certs/`), then adjust `DOMAIN` / `PICOAI_PUBLIC_BASE_URL` and the certificate
mode in `.env`.

## Certificates and reverse proxy

How to choose a certificate mode (`internal` / `auto` / `manual`) is in
[Deployment overview](/en/deployment/). All three share one compose file; only `TLS_MODE` changes.

### The host already runs a reverse proxy

If 80/443 is already held by another service, **do not fight for the port and do not stop someone else's
proxy** — have this product's `server` container join the existing proxy's upstream:

```bash
cd /opt/picoaide
# 1) Bring up only server + postgres, without the caddy in this stack
cat > docker-compose.override.yml <<'EOF'
services:
  server:
    environment:
      # Mandatory behind a reverse proxy: without a safe https address the manifest refuses to emit download links
      PICOAI_PUBLIC_BASE_URL: ${PICOAI_PUBLIC_BASE_URL:-https://harness.example.com}
    ports:
      # Same address as the existing vhost's upstream (example: a shared Caddy using 172.20.0.1:8082)
      - "172.20.0.1:8082:8080"
EOF

# 2) Start only these two services (note: caddy is not listed)
docker compose up -d postgres server
```

`.env` must also point the **trusted proxy** at the address the shared proxy connects from (the default
only recognises the in-stack caddy at `172.28.0.2`; a host-level shared proxy is usually the docker
bridge gateway, e.g. `172.20.0.1`):

```bash
PICOAI_TRUSTED_PROXIES=172.20.0.1
```

The existing vhost **needs no changes** (the upstream address stays as it is):

```
harness.example.com {
    encode gzip zstd
    reverse_proxy 172.20.0.1:8082
}
```

**Criterion**: `docker compose ps` shows only `server` and `postgres` running; over the **real domain**
`/healthz` returns 200 and `/api/client/v2/updates/manifest` has `client.assets`. A wrong
`PICOAI_TRUSTED_PROXIES` shows up as the login rate limiter treating the whole organisation as one
source IP (changing only part of the network configuration silently breaks `X-Forwarded-For`); the
startup log prints a WARNING line in that case.

### Subnet and port conflicts

- Subnet conflict → change `NETWORK_SUBNET` and `CADDY_IP` / `SERVER_IP` / `PG_IP` in `.env` (all four
  together);
- Port conflict → change `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` in `.env` **and update the ports in the
  Caddyfile too**;
- A `picoaide-net` network already exists with a different subnet → stop and confirm; do not run
  `docker network rm` (it disconnects running containers).

## Migrating from a single binary (systemd) to containers

Early versions may run as a systemd unit with a single binary. The recommended order for moving to
containers on the same machine:

1. **Back up**: `pg_dump` plus packing the application data directory (including `master.key`);
2. **Import the old database into the new stack's bundled PostgreSQL**:
   `gunzip -c dump.sql.gz | docker exec -i picoaide-postgres psql -U picoaide -d picoaide`;
   **leave the old database untouched** (it is the database rollback anchor);
3. **Copy the application data** into `/opt/picoaide/picoaide-data/` (verify the hashes match);
4. Let the container listen on a **temporary port** first (e.g. `172.20.0.1:8085`) and verify each item:
   `/healthz`, `/api/client/v2/channel`, `/api/client/v2/updates/manifest`;
5. `systemctl stop` + `disable` the old service (**keep the unit and the binary** as the rollback
   anchor), move the container back to the original port and run `docker compose up -d server`;
6. Re-verify over the **real domain**: `/healthz`, `/admin/`, `/api/client/v2/channel`,
   `/api/client/v2/updates/manifest`, `/updates/client/<installer>` (a range request returns 206).

## Day-to-day checks

| What | Command | Healthy looks like |
|---|---|---|
| Container state | `docker compose ps` | Three containers Up, `picoaide-postgres` healthy |
| Execution plane | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"` | `{"ok":true,…}` |
| Resources and publishing plane | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/readyz"` | `ok` true; `mem_budget_ok` / `mem_budget_known` sane; `compile_cache_bytes` not at the ceiling |
| Version | `docker exec picoaide-server /app/picoaide-server --version` | equals `cat VERSION` |
| Channel | `docker exec picoaide-server cat /opt/picoaide/CHANNEL` | matches this stack's channel (see [Channels & white-label](/en/deployment/channels/)) |
| Background schedulers | `docker compose logs server \| grep 'scheduler status'` | one line at startup and one at shutdown: `name=… started=… runs=… errors=… last_error=…` |
| Database migrations | `docker compose logs server \| grep -i 'migrate:'` | one line before and after each migration; a `migrate: SLOW migration` line means this upgrade held locks for a long time |
| Disk | `df -h /opt` | enough headroom for one image archive plus one backup |

Operational knobs worth knowing (all in `.env`; run `docker compose up -d server` after editing):

| Variable | Purpose | When to touch it |
|---|---|---|
| `PICOAI_WASM_MEMORY_PROFILE` | App-platform memory profile (`default` / `small` / `large`) | A host with less than 4 GiB available memory must use `small`, otherwise the startup self-check refuses to start |
| `PICOAI_COMPILE_ISOLATION` | OS-level isolation for the app compile subprocess (`require` / `auto` / `off`) | Production should use `require`: refuse to start rather than silently degrade |
| `PICOAI_MIGRATION_LOCK_TIMEOUT_MS` / `PICOAI_MIGRATION_ADVISORY_TIMEOUT_MS` / `PICOAI_MIGRATION_SLOW_MS` | Bounded lock-wait budgets for migrations and the slow-migration warning threshold (milliseconds) | Raise them temporarily when the startup log shows a lock timeout and it is confirmed to be an operations-side long transaction (`pg_dump` / long query / idle in transaction) |
| `PICOAI_AUDIT_CHAIN_INTERVAL` | Audit hash-chain verification interval (Go duration, default `1h`) | It trades the tamper-visibility window against one full read-only table scan per round |
| `PICOAI_DB_MAX_OPEN_CONNS` | Database connection pool ceiling | Lower it for multi-instance deployments or a managed PostgreSQL with a tight quota |

Two hot-adjustable groups in the admin console (effective immediately, no restart):

- **Operations → App platform**: concurrency and queue limits, per-instance memory, the various time
  budgets (**changing per-instance memory requires a restart**);
- **Operations → Gateway files**: per-employee Files API usage and cleanup; the file retention ceiling
  comes from `gateway.file_expiry_days` (default 7 days) and expired files are reclaimed by a periodic
  sweeper;
- **Audit log** retention is configurable (default 180 days) and enforced by a periodic scheduler — not
  "cleaned once at startup".

## Criteria

Day-to-day operations only have to answer four questions, and each has a copy-pasteable criterion
(what failure looks like is in the next section):

| Question | Criterion | Command |
|---|---|---|
| Is the service usable? | `/healthz` returns 200 and all three containers are Up | `docker compose ps` + `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"` |
| Do resources and the publishing plane have headroom? | `/readyz` reports `ok`, the memory-profile verdict is sane, and the compile cache is not at its ceiling | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/readyz"` |
| Are the running version and channel correct? | `VERSION` == `--version`, and `/opt/picoaide/CHANNEL` == the `channel_id` from `/api/client/v2/channel` | `cat VERSION`, `docker exec picoaide-server /app/picoaide-server --version`, `curl -sk …/api/client/v2/channel` |
| Is there still a way back? | The most recent backup exists and is **not empty**, and disk headroom covers a new image plus one backup | `ls -lh deploy-backup \| tail -5` + `df -h /opt` |

**How it fails**: `/healthz` non-200, `/readyz` reporting publish blockers, a version or channel
mismatch between the two sources, an empty backup, or not enough disk for an upgrade — if any of these
holds, diagnose with the next section instead of waiting it out.

## Security essentials

| Surface | Mechanism |
|---|---|
| Upstream keys | Stored with AES-GCM (`enc:v1:`, master key file mode 0600); never in plaintext |
| Employee tokens | Stored hashed only, 90-day expiry; password change / demotion / disable revokes every token in the **same transaction** |
| Admin sessions | 12-hour hard cap plus a 60-minute idle sliding expiry; CSRF bound to the session |
| Login rate limiting | Failures only, 5-minute sliding window, cleared on success; account and source-IP dimensions are counted separately, and the source IP is resolved through the trusted-proxy boundary |
| Content visibility | Marketplace and shared content are "review + grant" double-gated; unauthorised access is always 404 and never leaks existence |
| Audit | Key operations are recorded with a tamper-resistant hash chain; retention is configurable |
| Client access | The sign-in page refuses non-HTTPS remote addresses; installers are verified against the manifest's SHA-256 while streaming |
| Probes | `/healthz` and `/readyz` need no authentication; the former returns 503 when the DB ping fails |
| Outbound proxy | Clients do **not** use the system proxy by default; enable it explicitly through the channel field or the real process environment variable |

## Boundaries and failure behaviour

| Symptom | Criterion (how to confirm) | Recovery |
|---|---|---|
| Containers keep restarting | `docker compose ps` shows a rising restart count; `docker compose logs --tail=100 server` | Two most common causes: the PostgreSQL password does not match `pg-data`; or available memory is below 4 GiB while the profile is `default` (the log says the startup self-check refused to start) ⇒ set `small` and recreate |
| healthz stays non-200 | `docker compose ps` to see whether postgres is healthy | The first start needs 1–2 minutes for migrations; if it still fails, read `logs postgres` and `logs server` |
| The container exits at startup with `SchemaMismatchError` | the log names the migration version | **Cross-generation rollback**: stop the service → restore the pre-upgrade `pg_dump` → roll the image back → roll clients back; the image alone is not enough |
| caddy fails to create: `not a directory` | `docker compose ps` shows no caddy | `TLS_MODE` is misspelled (the mount source `Caddyfile.<mode>` does not exist) |
| `docker compose up` reports a port in use | the error names the port | Change the ports in `.env` and in the Caddyfile; or join a shared reverse proxy (start only server + postgres) |
| Subnet conflict | an existing network uses the same subnet | Change `NETWORK_SUBNET` and the three fixed IPs; if `picoaide-net` exists with a different subnet, confirm before touching it |
| postgres exits immediately, the log mentions `OLD_DATABASES` / `unused mount` | log keywords | Old PG16-era data layout: migrate with PostgreSQL's dump/restore; do not experiment with the mount point |
| Certificate warnings / clients cannot connect | `internal` / `auto` mode only | `internal` needs Caddy's local CA distributed to employee machines; `auto` requires the domain to reach this host directly with 80/443 open (a CDN breaks it) |
| Employees see "always up to date" | The manifest contains `client_unavailable` | Set `PICOAI_PUBLIC_BASE_URL` and recreate the server (see [Client delivery & updates](/en/deployment/client-delivery/)) |
| "New version available" never appears | the startup log's `channel resolved: …` and `manifest channel "…" != …` | The three channel values disagree, or the endpoint is set to `off`; the server caches for 6 hours, so a delay right after a release is normal |
| Apps open but publishing a new version is refused | `/readyz`'s publish blockers and `actions` | Usually a full app-platform compile cache: clear the derived cache under `<deployment directory>/picoaide-data/_compile-cache/` (no restart needed) and retry the publish |
| The super admin **password** is forgotten | is there **another** super admin? | Yes: have them reset it in the admin console under users → reset password (that revokes all of the account's sessions and forces a password change on next sign-in). No: `--reset-mfa <user>` does **not** reset the password (it only clears MFA and revokes sessions), so with a single super admin and no password the only way is to rewrite that account's `users.password_hash` in the database (an Argon2id-encoded string, format in `server/internal/util/password.go`) and set `password_must_change` to 1, then sign in and change it immediately; **back up first** |
| Disk pressure | `df -h /opt`, `du -sh pg-data picoaide-data` | `pg-data/` keeps growing; first confirm there is room for "a new image plus one backup". **Do not** clean up with `docker volume prune` / `docker system prune --volumes` |

## Common commands

```bash
cd /opt/picoaide

docker compose ps                                  # container state
docker compose logs --tail=200 server              # server log
docker compose logs -f --tail=50 caddy             # Caddy log (certificate problems show up here)
docker exec picoaide-server sh -c 'ls -l /data'    # application data and master.key
docker exec picoaide-postgres psql -U picoaide -d picoaide -c '\dt' | head   # tables
docker exec picoaide-server /app/picoaide-server --version                    # running version

# health and distribution self-check
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/readyz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

**Never run** (they delete volumes and image layers):

```bash
docker compose down -v          # ✗
docker volume prune             # ✗
docker system prune --volumes   # ✗
```

## Related

- [Deployment overview](/en/deployment/) — container architecture, certificate modes and the four iron rules
- [Container deployment](/en/deployment/compose/) — first-time deployment and the self-check list
- [Upgrade, backup & rollback](/en/deployment/upgrade/) — the full backup and restore order
- [Client delivery & updates](/en/deployment/client-delivery/) — download URLs and client upgrades
- [Channels & white-label](/en/deployment/channels/) — channel consistency and data isolation
- [Air-gapped deployment](/en/deployment/offline/) — fetching packages and the update check without internet
