---
title: Operations & troubleshooting
description: 'Day-to-day operations for the PicoAide Harness server: data backup, certificates and reverse proxy, migrating from a single binary, security essentials and common failures.'
---

## Data and backup

All persistent data lives in `./` bind mounts inside the deployment directory; **named volumes are not used** —
a backup is simply these directories packaged up:

| Directory | Content | Consequence of loss |
|---|---|---|
| `picoaide-data/` | Application data + **`master.key`** | Encrypted upstream keys in the database become **permanently undecryptable** |
| `pg-data/` | PostgreSQL 18 data | Accounts, usage, approvals and audit logs are all lost |
| `caddy-data/` `caddy-config/` | Caddy certificate store and configuration | `auto` mode has to re-issue |
| `certs/` | Manual certificates | Needed only in `manual` mode |

```bash
cd /opt/picoaide
TS=$(date +%Y%m%d-%H%M%S); OUT=deploy-backup; mkdir -p "$OUT"

docker exec picoaide-server sh -c 'tar czf - -C /data .' > "$OUT/picoaide-data-$TS.tar.gz"
docker exec picoaide-postgres pg_dump -U picoaide -Fc picoaide > "$OUT/pg-data-$TS.dump"
[ -d caddy-data ] && tar czf "$OUT/caddy-data-$TS.tar.gz" -C . caddy-data

[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! application data backup is empty"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! database backup is empty"
```

- **`master.key` must be kept separately for the long term** (it is also inside `picoaide-data/`) — do not rely
  on the database backup alone;
- For restore steps see [Upgrade, backup & rollback](/en/deployment/upgrade/) § Rollback;
- When migrating to a new machine, the whole deployment directory can be copied over directly (mind the file permissions).

## Certificates and reverse proxy

For how to choose the certificate mode (`internal` / `auto` / `manual`), see
[Deployment overview](/en/deployment/) § Certificate mode.
All three modes share the same compose file; only `TLS_MODE` in `.env` changes.

### The host already runs a reverse proxy

If 80/443 is already taken by another service (typically: the machine hosts other sites behind a shared
Caddy / nginx), **do not fight over the ports and do not stop the other reverse proxy** — instead make this
product's `server` container join the existing reverse proxy's upstreams:

```bash
cd /opt/picoaide
# 1) Bring up only server + postgres, without the caddy in this stack
cat > docker-compose.override.yml <<'EOF'
services:
  server:
    environment:
      # Mandatory in reverse-proxy setups: without an https address the client manifest refuses to emit download links
      PICOAI_PUBLIC_BASE_URL: ${PICOAI_PUBLIC_BASE_URL:-https://ai.example.com}
    ports:
      # Match the existing vhost's upstream (example: a shared Caddy configured with 172.20.0.1:8082)
      - "172.20.0.1:8082:8080"
EOF

# 2) Start only these two services (note: do not list caddy)
docker compose up -d postgres server
```

In `.env`, also change the **trusted proxy** to the address the shared reverse proxy connects from (by default
only the in-stack caddy at `172.28.0.2` is trusted; a host-level shared reverse proxy is usually the docker
bridge gateway, such as `172.20.0.1`):

```bash
PICOAI_TRUSTED_PROXIES=172.20.0.1
```

The existing vhost **needs no changes** (keep the upstream address as it is):

```
picoaide-harness.example.cn {
    encode gzip zstd
    reverse_proxy 172.20.0.1:8082
}
```

### Subnet and port conflicts

- Subnet conflict → change `NETWORK_SUBNET` and `CADDY_IP` / `SERVER_IP` / `PG_IP` in `.env`;
- Port conflict → change `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` in `.env`, **and update the ports in the Caddyfile accordingly**;
- The `picoaide-net` network already exists with a different subnet → stop and confirm, and do **not** run
  `docker network rm` (it disconnects existing containers).

## Migrating from a single binary (systemd) to containers

Earlier versions may run as systemd + a single binary. The recommended order for switching the same machine to
a container deployment:

1. **Back up**: `pg_dump` + package the application data directory (including `master.key`) — see "Data and backup" above;
2. **Import the old database into the new stack's built-in PG**:
   `gunzip -c dump.sql.gz | docker exec -i picoaide-postgres psql -U picoaide -d picoaide`;
   **leave the old database container untouched** (it is the rollback anchor for the database);
3. Copy the **application data** into `/opt/picoaide/picoaide-data/` (verify the hashes match; if `master.key`
   is lost, every encrypted upstream key in the database becomes permanently undecryptable);
4. First have the container listen on a **temporary port** (e.g. `172.20.0.1:8085`) and verify item by item:
   `/healthz`, `/api/client/v2/channel`, `/api/client/v2/updates/manifest`;
5. `systemctl stop` + `disable` the old service (**keep the unit and the binary** as the rollback anchor), point
   the container back to the original port and run `docker compose up -d server`;
6. Re-verify through the **real domain**: `/healthz`, `/admin/`, `/api/client/v2/channel`,
   `/api/client/v2/updates/manifest`, `/updates/client/<installer>` (a Range request returns 206).

## Security essentials

| Area | Mechanism |
|---|---|
| Upstream keys | Stored encrypted with AES-GCM (`enc:v1:`, master key file 0600), never in plaintext |
| Employee tokens | Only a SHA-256 hash is stored, with a 90-day expiry; password change / privilege downgrade / disabling revokes all tokens **in the same transaction** |
| Admin sessions | 12-hour hard limit + 60-minute idle sliding expiry; CSRF bound to the session (HMAC time window) |
| Login rate limiting | Dual bucket (by account and by source), 10 attempts / 5 minutes; `PICOAI_TRUSTED_PROXIES` determines how the source IP is derived |
| Content visibility | Marketplace and shared content use a two-gate model (review + grant); anything unauthorized returns 404 and never leaks existence |
| Audit | Key operations — users / departments / quotas / pricing / approvals / grants / balances — are recorded end to end, with a hash chain for tamper resistance |
| Client access | The login page and the client reject non-HTTPS remote addresses (TOFU); installer SHA-256 verification |
| Health probe | `/healthz` requires no authentication; a failed DB ping returns 503 |

## Troubleshooting

| Symptom | Investigation |
|---|---|
| Container restarts repeatedly | `docker compose logs --tail=100 server`; most often the PG password does not match `pg-data` |
| healthz never returns 200 | Use `docker compose ps` to see whether postgres is healthy; the first startup migration takes 1–2 minutes |
| The caddy container fails to be created, reporting `not a directory` | The mount source `Caddyfile.<mode>` does not exist: check the spelling of `TLS_MODE` in `.env` |
| postgres exits immediately at startup, with `OLD_DATABASES` / `unused mount` in the logs | Old data layout from the PG16 era; follow the [pre-upgrade checks](/en/deployment/upgrade/) to do a dump/restore migration |
| `docker compose up` reports a port already in use | Change `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` in `.env` and update the Caddyfile accordingly |
| Reports a subnet conflict | Change `NETWORK_SUBNET` and the three fixed IPs in `.env` |
| Certificate warnings / clients cannot connect | `internal` mode requires trusting the Caddy local CA; for `auto` mode, confirm the domain connects directly to this machine and port 80 is open to the public internet |
| Employee clients "always say they are up to date" | `client_unavailable` appears in the manifest: configure `PICOAI_PUBLIC_BASE_URL` |
| webadmin "new version found" does not appear | The three channel values are not consistent (see [Channels & white-label](/en/deployment/channels/#troubleshooting)); the server caches for 6 hours |
| Forgot the super admin password | Reset it with another super_admin in the Admin Console; or run `docker exec picoaide-server /app/picoaide-server --reset-mfa <user>` |

## Common commands

```bash
cd /opt/picoaide

docker compose ps                                  # status of the three containers
docker compose logs --tail=200 server              # server logs
docker compose logs -f --tail=50 caddy             # Caddy logs (look here for certificate problems)
docker exec picoaide-server sh -c 'ls -l /data'    # application data and master.key
docker exec picoaide-postgres psql -U picoaide -d picoaide -c '\dt' | head   # database tables
docker exec picoaide-server /app/picoaide-server --version                    # running version

# Health check and client distribution self-check
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

**Never run** (these delete data volumes and image layers, taking the database and `master.key` with them):

```bash
docker compose down -v          # ✗
docker volume prune             # ✗
docker system prune --volumes   # ✗
```

