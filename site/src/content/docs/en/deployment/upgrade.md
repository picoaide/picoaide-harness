---
title: Upgrade, backup & rollback
description: 'Upgrading the PicoAide Harness server: version check, backup, switching images, upgrade verification and rollback steps.'
---

An upgrade only replaces the image: `picoaide-data/`, `pg-data/`, `caddy-data/`, `certs/` and `.env` are all left untouched.
But **database migrations are irreversible**, so backup and verification are part of the process, not optional.

## 1. Check for a new version

```bash
# Latest remote version (authoritative: server.version in latest.json)
curl -fsS https://release.picoaide.com/official/latest.json \
  | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
cat /opt/picoaide/VERSION        # currently deployed version
```

You can also just look at the webadmin **Server info** page: the server checks for updates itself and shows "new version found" (including the target image tag for the upgrade).

- The check address comes from `PICOAI_UPDATE_ENDPOINT`; empty = this channel's default directory `release.picoaide.com/<channel>/latest.json`;
- The server keeps a **6-hour cache**, so waiting right after a release is normal latency;
- If "a new version never shows up", first look at `channel resolved: …` and
  `manifest channel "official" != this server's channel "…"` in `docker compose logs server` — that is a channel configuration that is not self-consistent (see [Channels & white-label](/en/deployment/channels/)),
  not "there is no new version".

Remote version ≤ current version → done.

## 2. Pre-upgrade checks

```bash
cd /opt/picoaide

# (a) PG data layout check: the old layout (PG16 era) is refused on startup
[ -f pg-data/PG_VERSION ] && echo "!!! legacy PG16 layout, run a dump/restore migration first, stop the upgrade" || echo "PG layout OK"

# (b) free disk space (both the new image and the backup need room)
df -h /opt | tail -1
```

When `!!!` appears, **stop the upgrade** and first migrate the data with PostgreSQL's official dump/restore procedure (the old `pg-data/` directory layout is incompatible with the new image and
will not be migrated automatically).

## 3. Backup (cannot be skipped)

```bash
cd /opt/picoaide
TS=$(date +%Y%m%d-%H%M%S); OUT=deploy-backup; mkdir -p "$OUT"

# Application data (including master.key)
docker exec picoaide-server sh -c 'tar czf - -C /data .' > "$OUT/picoaide-data-$TS.tar.gz"

# Database (custom format, safe while online)
docker exec picoaide-postgres pg_dump -U picoaide -Fc picoaide > "$OUT/pg-data-$TS.dump"

# auto mode: additionally back up the certificate store
[ -d caddy-data ] && tar czf "$OUT/caddy-data-$TS.tar.gz" -C . caddy-data

ls -lh "$OUT" | tail -5

# Verify the backups are not empty (otherwise the upgrade has no way back)
[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! application data backup is empty"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! database backup is empty"
```

> Once `picoaide-data/master.key` is lost, every encrypted upstream key in the database (gateway API keys and so on) is **permanently undecryptable**.
> That file must be kept long-term and backed up separately.

## 4. Import the new image

```bash
VER=<version obtained in step 1>
IMAGE=picoaide-harness-server
curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS
unzip -p /tmp/pa.zip image.tar | docker load
```

For environments without internet access, see [Air-gapped deployment](/en/deployment/offline/).

## 5. Switch versions and restart

```bash
cd /opt/picoaide
# Use server.image_tag from latest.json (authoritative, e.g. v2.7.0);
# the image carries both tags (2.7.0 and v2.7.0), so either one starts fine
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${VER}|" .env
grep -q '^SERVER_IMAGE=' .env || echo "SERVER_IMAGE=${IMAGE}:${VER}" >> .env

# Optional but recommended: re-export the deployment files (replace semantics; .env / data directories untouched)
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}

docker compose up -d
```

- `docker compose up -d` only recreates the containers that changed; the data directories are bind mounts, so **the data is unaffected**;
- Re-exporting the deployment files uses **replace** semantics: `client/`, `VERSION`, `docker-compose.yml`, `Caddyfile.*` and `.env.example`
  are cleared before being written (otherwise `client/` would keep installers from two versions at once); `.env` and all data directories are never touched;
- **When the host already has a reverse proxy** (see [Operations & troubleshooting § The host already runs a reverse proxy](/en/deployment/operations/#the-host-already-runs-a-reverse-proxy)): recreate only this product's containers with
  `docker compose up -d postgres server`, and do not drag the shared reverse proxy into it.

## 6. Post-upgrade verification (all three must pass)

```bash
cd /opt/picoaide
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)

# (a) health check
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")
  [ "$code" = "200" ] && { echo "healthz OK"; break; }; sleep 3
done

# (b) running version == target version (authoritative check)
docker exec picoaide-server /app/picoaide-server --version

# (c) data still there (migrations applied)
docker exec picoaide-postgres psql -U picoaide -d picoaide -c 'select count(*) from users;'
```

It is also worth spot-checking the two client distribution chains:

```bash
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" \
  "https://$DOMAIN/updates/client/<file name from the manifest>"
```

The manifest's `client.version` should change with this upgrade, and the installer should be downloadable (a resumed download returns 206).

**If any item fails → perform the rollback in step 7; do not continue.**

## 7. Rollback

Prerequisite: check whether the new version introduced database migrations. If it did, the database schema is still the new one after rolling back the image and the server may error out —
in that case the correct move is to **fix forward** (release a fixed version) or **restore the database backup** (which loses data created after the upgrade).

```bash
cd /opt/picoaide
OLD=<version before the upgrade>
IMAGE=picoaide-harness-server

# 1) switch back to the old image
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${OLD}|" .env
docker compose up -d

# 2) verify the old version is healthy
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
docker exec picoaide-server /app/picoaide-server --version      # should equal OLD
echo "$OLD" > VERSION

# 3) restore only if the application data was damaged (loses data; explicit consent required)
# docker compose stop server
# tar xzf deploy-backup/picoaide-data-<TS>.tar.gz -C picoaide-data
# docker compose start server

# 4) restore only if the database was damaged (loses data; explicit consent required)
# docker compose stop server
# docker exec -i picoaide-postgres pg_restore -U picoaide -d picoaide --clean \
#   < deploy-backup/pg-data-<TS>.dump
# docker compose start server
```

**Rollback steps 3) / 4) lose the data created after the upgrade**, so explicit consent is required before running them.

## 8. Finishing up

```bash
cd /opt/picoaide
echo "$VER" > VERSION          # if you did not re-export in step 5, update it manually here
docker compose ps              # all three containers Up
# keep the old image for now (rollback anchor); clean it up after 1–2 days of stable operation:
# docker image rm picoaide-harness-server:<old version>
```

Employee clients need no per-machine work: they fetch packages from **this server**, so their next update check sees the new version (see [Client delivery & updates](/en/deployment/client-delivery/)).

## Upgrade checklist

- [ ] Remote version > current `VERSION`
- [ ] PG layout check passed (no `pg-data/PG_VERSION`)
- [ ] Backup completed and **not empty**
- [ ] New image imported and `SHA256SUMS` verified
- [ ] `SERVER_IMAGE` in `.env` points to the new version
- [ ] healthz 200 + `--version` == target version + data queryable
- [ ] `client.version` and installer downloads work
- [ ] The local `VERSION` file has been updated
- [ ] None of the commands forbidden by the [iron rules](/en/deployment/#four-iron-rules-violating-them-causes-unrecoverable-data-loss) was run
