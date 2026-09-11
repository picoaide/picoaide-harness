---
title: Container deployment
description: 'First-time deployment of the PicoAide Harness server: fetching the image, exporting the deployment files, writing .env, starting up and health checking.'
---

This page gives the complete **first-time deployment** steps, all executed on the target server (example directory `/opt/picoaide`, referred to below as the deployment directory).
To upgrade an existing deployment, see [Upgrade, backup & rollback](/en/deployment/upgrade/).

## 0. Confirm three things first

| Variable | Meaning | Example |
|---|---|---|
| `DOMAIN` | The address employees use (domain or IP) | `ai.example.com` or `10.0.0.5` |
| `TLS_MODE` | Certificate mode: `internal` / `auto` / `manual` | Intranet IP → `internal` |
| `PICOAI_ADMIN_PASSWORD` | Initial super admin password (≥ 10 characters) | Generate a strong password on site |

We strongly recommend **also confirming** `PICOAI_PUBLIC_BASE_URL` (this server's absolute public https address):
the download URLs in the client update manifest must be absolute https, and when the server cannot derive a safe address it refuses to emit the `client` section by design
(`client_unavailable`); what users see is "the update check always says it is already up to date". Mandatory in reverse-proxy setups.

## 1. Check dependencies, resources and ports

```bash
docker --version && docker compose version
openssl version && curl --version | head -1
free -g | head -2 ; df -h /opt | tail -1
```

If Docker is not installed, install it the distribution's official way (`apt-get install -y docker.io docker-compose-plugin` or
`curl -fsSL https://get.docker.com | sh`).

compose uses the private subnet `172.28.0.0/24` (caddy=.2 / server=.3 / postgres=.4). Check for conflicts:

```bash
# Is the subnet already taken by another docker network?
docker network ls -q | while read -r n; do
  docker network inspect "$n" -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
done | grep -F 172.28.0.0

# Are 80/443 free?
ss -tlnp | grep -E ':(80|443)\b'
```

- Subnet conflict → change `NETWORK_SUBNET` and `CADDY_IP` / `SERVER_IP` / `PG_IP` in `.env`;
- Port already in use → change `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` in `.env`, **and update the ports in the Caddyfile at the same time**;
- A network named `picoaide-net` already exists with a different subnet → stop and confirm, and do **not** run `docker network rm` (it disconnects existing containers).

If 80/443 are taken by other services on the same machine (a shared reverse proxy), do not fight over the ports: see
[Operations & troubleshooting § The host already runs a reverse proxy](/en/deployment/operations/#the-host-already-runs-a-reverse-proxy).

## 2. Import the image

Read the version from the update server and download the image archive (this is the only source):

```bash
curl -fsS https://release.picoaide.com/official/latest.json | grep -E '"(version|image_tag)"'
VER=2.7.0            # ← use server.version from the manifest (without v)
curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS          # always verify successfully before importing
unzip -p /tmp/pa.zip image.tar | docker load
```

- After import the image is named `picoaide-harness-server:<VER>`, and an equivalent tag with the `v` prefix also exists: `picoaide-harness-server:v<VER>`;
- Replace `official` in the manifest URL with this deployment's channel id to fetch this channel's package (for brand channels this is the only distribution surface);
- If downloads are slow, parallel chunking helps (measured: 75–260 KB/s single-stream, about 5 minutes with 8 parallel streams); for the approach and pitfalls see the repository's
  [`docs/planning/2026-09-10-r2-update-server-runbook.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/planning/2026-09-10-r2-update-server-runbook.md) §11.

## 3. Export the deployment files

```bash
IMAGE=picoaide-harness-server
VER=2.7.0
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}
ls -1 /opt/picoaide        # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
ls -1 /opt/picoaide/client # CLIENT-RELEASE.json + installers for three platforms
```

`client/` holds the client installers released with this version (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`);
the server serves them itself, so no extra upload is needed.

Record the current version (both upgrades and troubleshooting compare against it):

```bash
cat /opt/picoaide/VERSION
docker run --rm --entrypoint /app/picoaide-server ${IMAGE}:${VER} --version
```

Both must equal the target version. Do not judge the version by the `docker images` IMAGE ID — the digest and the version number mean different things.

## 4. Generate secrets and write `.env`

```bash
cd /opt/picoaide
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PG_PASSWORD
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PICOAI_ADMIN_PASSWORD
```

**If `.env` already exists → stop**: this is an upgrade scenario, go to [Upgrade, backup & rollback](/en/deployment/upgrade/).

```bash
cd /opt/picoaide
cat > .env <<'EOF'
DOMAIN=ai.example.com
TLS_MODE=internal
ADMIN_USER=admin
PICOAI_ADMIN_PASSWORD=<the super admin password you just generated>
PG_PASSWORD=<the database password you just generated>
TZ=Asia/Shanghai
# Absolute public address: mandatory in reverse-proxy setups, otherwise the client update manifest refuses to emit download links
PICOAI_PUBLIC_BASE_URL=https://ai.example.com
EOF
chmod 600 .env
```

Only `DOMAIN`, `TLS_MODE`, `PICOAI_ADMIN_PASSWORD` and `PG_PASSWORD` are required; every other key has a default. Commonly used optional keys:

| Variable | Default | Description |
|---|---|---|
| `SERVER_IMAGE` | `picoaide-harness-server:latest` | Always write an explicit version tag for deployment and upgrades; `latest` is not reproducible |
| `PICOAI_PUBLIC_BASE_URL` | Derived from the request | Once set it is the **sole authority**; client download URLs must be absolute https |
| `PICOAI_TRUSTED_PROXIES` | `172.28.0.2` | Trusted reverse-proxy address; login rate limiting uses it to resolve the real client IP; change it when the subnet or the reverse proxy changes |
| `PICOAI_CHANNEL` | Empty (use the image's built-in channel) | **Just leave it empty**; if set it must match the channel inside the image, otherwise startup is refused |
| `PICOAI_UPDATE_ENDPOINT` | Empty = this channel's default directory | **Leaving it empty does not turn it off**; write `off` to disable update checks |
| `PICOAI_LOGIN_MAX_ATTEMPTS` | Server default | Raising it is recommended for test environments only, so that repeated logins do not lock out the admin account |
| `NETWORK_SUBNET` / `CADDY_IP` / `SERVER_IP` / `PG_IP` | `172.28.0.0/24` and `.2/.3/.4` | Change them all together when the subnet conflicts |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | `80` / `443` | Changing the ports requires updating the Caddyfile too |

> `PICOAI_ADMIN_PASSWORD` is only used on the **first startup** to create the super admin (idempotently skipped when an admin already exists);
> after the first successful login you can blank that line, so the plaintext does not stay in the file long-term.

### Only needed in `manual` mode: place the certificates

```bash
cd /opt/picoaide && mkdir -p certs
# If you have no proper certificate yet, generate a self-signed placeholder first (10 years, SAN = your domain/IP)
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=<DOMAIN>" -addext "subjectAltName=DNS:<DOMAIN>"
chmod 600 certs/server.key
```

If the enterprise has a proper PEM, simply overwrite these two files (the file names must stay the same). Skip this step in `internal` / `auto` modes.

## 5. Start up and health check

```bash
cd /opt/picoaide
docker compose up -d
docker compose ps        # picoaide-caddy / picoaide-server / picoaide-postgres should all be Up
```

The first startup runs all database migrations and creates the usage partitions; **this can take 1–2 minutes**; `up -d` returning does not mean the service is ready.

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

- `200` → continue to the next step; still not 200 after 120 seconds → treat it as a failure: fix it with `docker compose logs --tail=100` before continuing, and do **not** report "deployment complete" while the health check has not passed;
- When `CADDY_HTTPS_PORT` is not 443, replace the two occurrences of `443` above with the actual port.

### Deployment self-check list

```bash
cd /opt/picoaide
docker compose ps                                   # all three containers Up
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
ls -1 /opt/picoaide/picoaide-data/master.key        # master.key exists (must be kept long-term)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

The last command must show `client.assets` with `url` as **absolute https**; if `client_unavailable` appears, `PICOAI_PUBLIC_BASE_URL` is not configured, which shows up on the employee side as "the client's update check always says it is already up to date".

## 6. Hand over to employees

1. Tell employees the access address `https://$DOMAIN`; they just enter it on the client login page;
2. Employees can also open the portal page (`/` or `/portal`) directly to download the installers for the three platforms;
3. Administrators log in to `/admin/` and configure upstream providers, the default model, price limits and login methods on the **Gateway** page; see [Admin Console](/en/admin/) for details;
4. Before the first handover, **explicitly tell operations**: `picoaide-data/master.key` must be kept long-term and backed up separately.

For how clients fetch packages and how they upgrade along with the server, see [Client delivery & updates](/en/deployment/client-delivery/).
