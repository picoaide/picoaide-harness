---
title: Container deployment
description: 'First-time deployment of the PicoAide Harness enterprise server: environment checks, importing the image, exporting deployment files, writing .env, starting up, and the criteria for each step.'
---

This page is the complete **first-time deployment** procedure, all executed on the target server
(example directory `/opt/picoaide`, called the **deployment directory** below). Every step comes with
**criteria** (how you know that step succeeded) and with what to do when it fails.
To upgrade an existing deployment, do not use this page — use
[Upgrade, backup & rollback](/en/deployment/upgrade/).

## What this page solves

Turning "an empty Linux server" into "an enterprise server employees can download a client from and
sign in to". It covers: environment and port checks → importing the image → exporting the deployment
files → writing `.env` → starting up → health check → handing over to employees.

**Prerequisites** (do not continue if any of them is missing):

| Prerequisite | Why it must be settled before deployment |
|---|---|
| A **confirmed** public address (domain or IP) | It decides how TLS is issued, what download URL the client manifest carries, and what employees type into the sign-in page |
| A **confirmed** certificate mode (`internal` / `auto` / `manual`) | The wrong mode is not a warning: clients simply cannot connect (see [Boundaries and failure behaviour](#boundaries-and-failure-behaviour)) |
| An initial admin password (≥ 10 characters) | Used only on the very first start to create the super admin; skipped idempotently when one exists |
| Docker ≥ 24 + Compose v2, `openssl`, `curl`, `unzip` | The deployment procedure itself depends on them |

> **If the deployment directory already contains `.env`: stop immediately.** That means the host has
> been deployed before and what you want is an upgrade, not a reinstall — overwriting it with
> `.env.example` throws away `SERVER_IMAGE`, `PICOAI_PUBLIC_BASE_URL` and every other on-site setting.

## Design trade-offs

**Why a single-file compose.** `docker-compose.yml` declares caddy, server and postgres in one file
with no external references (no `include`, no extra env files, no override template). The inputs to
"deploy" are therefore just two things: one `.env` and one image; there is no surface where "the
compose file in the repository" and "the compose file on the host" can drift apart. When the host
already runs a reverse proxy you stack a `docker-compose.override.yml` on top (see
[Operations & troubleshooting](/en/deployment/operations/)) instead of editing the main file.

**Why container IPs are fixed in compose.** The trusted-proxy relationship between Caddy and the
server, the client-IP attribution in audit records, and "an upgrade only recreates one container" all
depend on knowing who is where. The fixed IPs live in the same compose file, and a subnet conflict is
resolved by changing all of them together (`NETWORK_SUBNET` plus `CADDY_IP` / `SERVER_IP` / `PG_IP`).
Changing only half of them silently breaks `X-Forwarded-For` and collapses the login rate-limit
buckets into one bucket for the whole organisation.

**Why data must live in bind mounts.** See the design trade-offs in
[Deployment overview](/en/deployment/): a backup is "pack a directory", moving to another machine is
copying a directory, the data's location can be pointed at, and the lifetime of named volumes is tied
to Docker, where `down -v` and `prune` take the data with them.

**Why the server publishes no host port.** All external traffic enters through Caddy, so there is
exactly one answer to "what is the public entry point", exactly one TLS configuration, and the server
never has to deal with 80/443 or certificates itself. In reverse-proxy setups this is opened
explicitly once (the override publishes it on an address the shared proxy can reach) rather than by
default.

## Concepts and structure

The deployment directory ends up looking like this:

```
/opt/picoaide/                 ← deployment directory (DEPLOY_DIR below)
  docker-compose.yml           ┐
  Caddyfile.internal           │ exported from the image (replace semantics)
  Caddyfile.autocert           │
  Caddyfile.manual             │
  .env.example                 ┘
  .env                         ← you create it, mode 600
  certs/server.crt|server.key  ← needed in manual mode
  picoaide-data/               ← application data + master.key (must be backed up)
  pg-data/                     ← PostgreSQL data
  caddy-data/ caddy-config/    ← Caddy state (must be backed up in auto mode)
  deploy-backup/               ← backup output
  client/                      ← client installers (served by the server itself)
  VERSION                      ← currently deployed version (the upgrade comparison anchor)
```

Three mandatory variables (**confirm them with the user; do not invent them**):

| Variable | Meaning | Example |
|---|---|---|
| `DOMAIN` | The address employees use (domain or IP) | `harness.example.com` or `10.0.0.5` |
| `TLS_MODE` | Certificate mode: `internal` / `auto` / `manual` | Intranet IP → `internal` |
| `PICOAI_ADMIN_PASSWORD` | Initial super admin password (≥ 10 characters) | Generate a strong password on site |

Plus two that are strongly recommended:

| Variable | Why |
|---|---|
| `PICOAI_PUBLIC_BASE_URL` | This server's absolute public https address. Download URLs in the client update manifest must be absolute https, and when the server cannot derive a safe address it **refuses to emit** the `client` section by design (`client_unavailable`) — users then see "the update check always says it is already up to date". Mandatory in reverse-proxy setups |
| `PICOAI_WASM_MEMORY_PROFILE` | The app-platform memory profile. A host with less than 4 GiB available memory must select `small`, otherwise the startup self-check refuses to start (the container restarts in a loop) |

## Procedure

### 0. Check dependencies, resources and ports

```bash
docker --version && docker compose version
openssl version && curl --version | head -1
free -g | head -2 ; df -h /opt | tail -1
```

If Docker is missing, install it the distribution's official way
(`apt-get install -y docker.io docker-compose-plugin`, or `curl -fsSL https://get.docker.com | sh`) —
**never** with a script from this project.

The compose file uses the private subnet `172.28.0.0/24` (caddy=.2 / server=.3 / postgres=.4).
Check for conflicts:

```bash
# Is the subnet already taken by another docker network?
docker network ls -q | while read -r n; do
  docker network inspect "$n" -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
done | grep -F 172.28.0.0

# Are 80/443 free?
ss -tlnp | grep -E ':(80|443)\b'
```

- Subnet conflict → change `NETWORK_SUBNET` **and** `CADDY_IP` / `SERVER_IP` / `PG_IP` in `.env`
  (**all four together**);
- Port in use → change `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` in `.env` **and update the ports in the
  Caddyfile as well**;
- A network named `picoaide-net` already exists with a different subnet → **stop and ask the user**;
  do not run `docker network rm` (it disconnects running containers).

**Criteria**: `free -g` shows at least 4 GiB available (otherwise plan for the `small` profile); if the
port check printed something, 80/443 are taken and the previous bullet applies.

### 1. Import the image

The only source is the update server (no image registry is involved):

```bash
# Read the version from the manifest first (authoritative fields: server.version / server.image_tag)
curl -fsS https://release.picoaide.com/official/latest.json | grep -E '"(version|image_tag)"'
VER=<version>         # ← use server.version from the manifest (without v)
curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS          # must pass before importing
unzip -p /tmp/pa.zip image.tar | docker load
```

- After import the image is `picoaide-harness-server:<version>`, and the equivalent `v`-prefixed tag
  `v<version>` exists as well;
- Replace `official` in the URL with this deployment's channel id to fetch that channel's package
  (for branded channels this is the only distribution surface);
- If `unzip` is missing, install it (`apt-get install -y unzip`), or use Python:
  `python3 -c 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extract("image.tar")' /tmp/pa.zip`
  followed by `docker load -i image.tar`;
- If the download is slow (cross-border), parallel chunking helps: a single stream measured
  75–260 KB/s, eight parallel streams about 2 MB/s. Some Range requests are ignored by the CDN and
  return the whole file — **the checksum remains the final criterion**.

**Criteria**: `sha256sum -c SHA256SUMS` prints `OK`, and `docker image ls picoaide-harness-server`
shows the target version tag. If verification fails, **do not** continue — inside the intranet there is
no second source to fall back on.

### 2. Export the deployment files

```bash
IMAGE=picoaide-harness-server
VER=<version>
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}
ls -1 /opt/picoaide        # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
ls -1 /opt/picoaide/client # CLIENT-RELEASE.json + installers for the three platforms
```

`client/` holds the client installers released with this version (Windows `.exe`, macOS `.dmg`,
Linux `.AppImage`); the server serves them itself, so **nothing has to be uploaded**. The export uses
replace semantics: `client/` and `VERSION` are cleared before being written.

Record the version (both upgrades and troubleshooting compare against it):

```bash
cat /opt/picoaide/VERSION
docker run --rm --entrypoint /app/picoaide-server ${IMAGE}:${VER} --version
```

**Criteria**: `ls -1 /opt/picoaide` shows the files listed above, and **both** the `VERSION` file and
the `--version` output equal the target version. Do not judge the version from `docker images` —
digests and version numbers mean different things.

### 3. Generate secrets and write `.env`

```bash
cd /opt/picoaide
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PG_PASSWORD
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PICOAI_ADMIN_PASSWORD
```

**Record the generated passwords for the user as well** (do not leave them only in the terminal). Then:

```bash
cd /opt/picoaide
cat > .env <<'EOF'
DOMAIN=<confirmed domain or IP>
TLS_MODE=<internal|auto|manual>
ADMIN_USER=admin
PICOAI_ADMIN_PASSWORD=<generated admin password>
PG_PASSWORD=<generated database password>
TZ=Asia/Shanghai
# Absolute public address: mandatory behind a reverse proxy, otherwise the client manifest refuses to emit download links
PICOAI_PUBLIC_BASE_URL=https://<confirmed domain>
# Hosts with less than 4 GiB available memory must select small
# PICOAI_WASM_MEMORY_PROFILE=small
EOF
chmod 600 .env
```

Only `DOMAIN`, `TLS_MODE`, `PICOAI_ADMIN_PASSWORD` and `PG_PASSWORD` are mandatory; every other key
has a default. Common optional keys:

| Variable | Default | Notes |
|---|---|---|
| `SERVER_IMAGE` | `picoaide-harness-server:latest` | **Always write an explicit version tag**; `latest` is not reproducible and cannot anchor a rollback |
| `PICOAI_PUBLIC_BASE_URL` | derived from the request | When set it is the **only authority**; client download URLs must be absolute https |
| `PICOAI_TRUSTED_PROXIES` | derived from `CADDY_IP` | Trusted proxy addresses; login/MFA/OIDC rate limits resolve the real client IP from them. Only set explicitly when the proxy changes |
| `PICOAI_CHANNEL` | empty (use the image's channel) | **Leave it empty**; if set it must match the channel inside the image or the server refuses to start |
| `PICOAI_UPDATE_ENDPOINT` | empty = this channel's default directory | **Empty does not mean off**; write `off` to disable update checks |
| `PICOAI_LOGIN_MAX_ATTEMPTS` | server default | Test environments only — otherwise repeated sign-ins can lock the admin account |
| `NETWORK_SUBNET` / `CADDY_IP` / `SERVER_IP` / `PG_IP` | `172.28.0.0/24` and `.2/.3/.4` | Change them together when the subnet conflicts |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | `80` / `443` | Changing them means editing the Caddyfile too |
| `PICOAI_COMPILE_ISOLATION` | `auto` | OS-level isolation for the app compile subprocess; production should use `require` (refuse to start when isolation is unavailable) |

> `PICOAI_ADMIN_PASSWORD` is used only on the **first start** to create the super admin (idempotently
> skipped once `admin` exists); after the first successful sign-in you can blank the line to stop
> keeping a plaintext credential in the file.

**Criteria**: `ls -l .env` shows mode `-rw-------` (600), and `grep -c '^DOMAIN=' .env` returns 1.
Double-check that `TLS_MODE` is one of the three values — a typo shows up as the caddy container
failing to create.

#### Only needed in `manual` mode: place the certificates

```bash
cd /opt/picoaide && mkdir -p certs
# With no proper certificate yet, generate a self-signed placeholder (10 years, SAN = your domain/IP)
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=<DOMAIN>" -addext "subjectAltName=DNS:<DOMAIN>"
chmod 600 certs/server.key
```

With a proper corporate PEM, overwrite both files (the names must match) and run
`docker compose restart caddy`. `internal` / `auto` mode **skips this step** (Caddy manages its own
certificates).

### 4. Start up and health check

```bash
cd /opt/picoaide
docker compose up -d
docker compose ps        # expect picoaide-caddy / picoaide-server / picoaide-postgres all Up
```

The first start runs every database migration (currently `0001–0084`) and creates the usage
partitions; it **can take 1–2 minutes**. `up -d` returning does not mean the service is ready — the
health check is mandatory:

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")
  echo "attempt ${i}: HTTP $code"
  [ "$code" = "200" ] && break
  sleep 3
done
```

**Criteria**: a `200` within 40 attempts. Still non-200 after 120 seconds → **treat it as a failure**:
locate the cause with `docker compose logs --tail=100 server`, then start over. **Do not** report
"deployment complete" before the health check passes.
If `CADDY_HTTPS_PORT` is not 443, replace both `443` occurrences with the real port.

### 5. Deployment self-check

```bash
cd /opt/picoaide
docker compose ps                                   # three containers Up
docker exec picoaide-server /app/picoaide-server --version   # == target version
ls -1 /opt/picoaide/picoaide-data/master.key        # master.key exists (keep it forever)
docker exec picoaide-server cat /opt/picoaide/CHANNEL        # this stack's channel
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/channel"
```

The last two must show `client.assets` with **absolute https** URLs; `client_unavailable` means
`PICOAI_PUBLIC_BASE_URL` is not set. The `channel_id` from `/api/client/v2/channel` must equal
`/opt/picoaide/CHANNEL`.

### 6. Hand over to employees

1. Give employees the address `https://$DOMAIN`; they enter it on the client's sign-in page;
2. They can also open the portal (`/` or `/portal`) and download the installers for the three platforms;
3. Administrators sign in to `/admin/` and configure upstream providers, the default model, pricing and
   sign-in methods on the **gateway** page — see [Admin console](/en/admin/);
4. Tell operations explicitly: `picoaide-data/master.key` must be kept forever and backed up separately.

## Criteria summary

| # | Criterion | How |
|---|---|---|
| 1 | Image available and version correct | `docker run --rm --entrypoint /app/picoaide-server <image> --version` == target version |
| 2 | Deployment files complete | `/opt/picoaide` holds compose, the three Caddyfiles, `.env.example`, `VERSION`, `client/` |
| 3 | `.env` in place and not world-readable | mode `600`, `TLS_MODE` is one of the three values, `SERVER_IMAGE` is a concrete version |
| 4 | Three containers Up | `docker compose ps` |
| 5 | Probe returns 200 | `/healthz` returns 200 |
| 6 | Data directories in place | `picoaide-data/master.key` exists; `pg-data/` is non-empty |
| 7 | Client distribution consistent | the manifest has `client.assets` with absolute https URLs |
| 8 | Channel consistent | `/opt/picoaide/CHANNEL` == `channel_id` from `/api/client/v2/channel` |

## Boundaries and failure behaviour

| Symptom | Criterion | Recovery |
|---|---|---|
| `.env` already exists | `ls /opt/picoaide/.env` | **Stop** and go to [Upgrade, backup & rollback](/en/deployment/upgrade/); overwriting `.env` discards on-site settings |
| `docker compose up` reports a port in use | the error names 80 or 443 | Change `CADDY_HTTP_PORT`/`CADDY_HTTPS_PORT` **and the Caddyfile**; or join a shared reverse proxy |
| Subnet conflict | `docker network ls` already shows the same subnet | Change `NETWORK_SUBNET` and the three fixed IPs; if `picoaide-net` exists with a different subnet, confirm before touching it |
| caddy fails to create: `not a directory` | `docker compose ps` shows no caddy | `TLS_MODE` is misspelled (the mount source `Caddyfile.<mode>` does not exist) |
| postgres exits immediately | the log mentions `OLD_DATABASES` / `unused mount` | Old PG16-era data layout: migrate with PostgreSQL's dump/restore first, then deploy |
| The server restarts in a loop | the log says the WASM platform self-check refused to start | Less than 4 GiB available memory: write `PICOAI_WASM_MEMORY_PROFILE=small` in `.env`, then `docker compose up -d server` |
| healthz still non-200 after 2 minutes | `docker compose ps` shows postgres not healthy | Read `docker compose logs --tail=100 postgres` first (password not matching `pg-data` is the most common), then the server log |
| `client_unavailable` in the manifest | that field is present | Set `PICOAI_PUBLIC_BASE_URL=https://<domain>`, then `docker compose up -d server` |
| First client connection reports an untrusted certificate | `internal` mode only | Distribute Caddy's local CA to employee machines, or switch to `manual` |
| Channel mismatch | `/opt/picoaide/CHANNEL` ≠ `channel_id` from `/api/client/v2/channel` | The container refuses to start: check whether `.env` still carries `PICOAI_CHANNEL=official` (branded deployments must delete that line) |

## Related

- [Deployment overview](/en/deployment/) — forms, deliverable, certificate modes and the four iron rules
- [Upgrade, backup & rollback](/en/deployment/upgrade/) — the next step for an existing deployment
- [Client delivery & updates](/en/deployment/client-delivery/) — how employees get the client
- [Channels & white-label](/en/deployment/channels/) — channel content and channel isolation
- [Air-gapped deployment](/en/deployment/offline/) — fetching packages without internet access
- [Operations & troubleshooting](/en/deployment/operations/) — shared reverse proxies, restores and common faults
