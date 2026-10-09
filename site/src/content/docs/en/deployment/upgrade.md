---
title: Upgrade, backup & rollback
description: 'Upgrading the PicoAide Harness server: version check, backup and verification, switching images, post-upgrade criteria, and how same-generation and cross-generation rollbacks differ.'
---

An upgrade only replaces the image: `picoaide-data/`, `pg-data/`, `caddy-data/`, `certs/` and `.env`
are all left untouched. But **database migrations are irreversible**, so "back up and verify it is not
empty" and "verify three things afterwards" are part of the process, not optional.

## What this page solves

Moving a running deployment from version A to version B, and being able to go **back** if the move was
wrong. It runs through: version check → pre-upgrade checks → backup and verification → importing the
image → switching and restarting → post-upgrade verification → rollback.

**Prerequisites**:

| Prerequisite | Notes |
|---|---|
| The remote version is **higher** than the running version | Otherwise there is nothing to do (step 1 gives the criterion) |
| A backup is **mandatory**, and must be verified non-empty | The only way back is the `pg_dump` and the `picoaide-data/` snapshot taken before the upgrade |
| You know which channel this stack belongs to | On a multi-stack host the rollback anchor must be the channel-specific tag (see [Running multiple channel stacks on one server](#running-multiple-channel-stacks-on-one-server)) |
| You accept behavioural changes such as "administrators must sign in again" | See the behaviour-change list in step 2 and decide each item |

> **Server and client must be upgraded to the same version**: WASM apps open only inside the desktop
> client and the browser access chain has been removed — after a server upgrade, **old clients can no
> longer open apps**. Clients fetch packages from this server, so confirm employees' clients reach the
> matching version (see [Client delivery & updates](/en/deployment/client-delivery/)).

## Design trade-offs

**Why an upgrade only replaces the image.** All persistent state lives in bind-mounted directories and
in PostgreSQL; the image itself is **stateless**. An upgrade therefore reduces to one `docker load`,
one line changed in `SERVER_IMAGE`, and recreating the container. Refreshing the deployment files
(compose / Caddyfile / `.env.example`) is an optional second step and does not interact with the first.
This is also what makes "a rollback is just pointing back at the old image" true.

**Why `latest` is forbidden and why the rollback anchor must be pinned.** A rollback is "point
`SERVER_IMAGE` back at the previous version", so "the previous version" has to be a concrete reference
that still exists **on this host**. `latest` cannot answer that question, and a tag name alone is not
enough either: a second channel stack on the same machine overwrites identically named tags when it
runs `docker load` (channel differences live in the image content, not in the tag). A multi-stack host
therefore freezes the image that was **running before the upgrade** under a **channel tag**, and that
is the only safe anchor.

**Why a backup must be verified non-empty.** When a backup command fails (disk full, wrong container
name, insufficient `pg_dump` privileges) the shell still leaves a file behind — empty, a few KB, or a
truncated tar. If the upgrade then goes wrong, you discover the missing way back exactly when you need
it most. The criterion is therefore `[ -s … ]` (non-empty), not "the file exists". `picoaide-data/` is
the critical one: lose `master.key` and every encrypted upstream API key in the database is
**permanently undecryptable**.

**Why migrations are irreversible, and why a cross-generation rollback must restore the database.**
Migrations only move the schema forward; a new version may drop tables or rewrite existing data (for
example rewriting `access='public'` to `login`). Since 2026-09-25 the server does a **two-way**
migration reconciliation at startup: if `schema_migrations` contains a version the running binary does
not know, it **refuses to start** (`SchemaMismatchError`, naming the version and offering two concrete
actions). This is deliberate — silently skipping would make downgrades and dead entries permanently
invisible. The price is that a cross-generation rollback must follow **stop the service → restore the
`pg_dump` → then roll the image back**, and must never be "change `SERVER_IMAGE` and restart".

## Concepts and structure

The image archive carries three tag shapes (for version `${VER}`):

| Tag | Purpose | Caveat |
|---|---|---|
| `${IMAGE}:${VER}` | Bare version tag | **Identical** in every channel's archive ⇒ two stacks on one host overwrite each other |
| `${IMAGE}:v${VER}` | Equivalent `v`-prefixed tag | Same as above |
| `${IMAGE}:<channel-id>-${VER}` | **Channel tag** | Only this channel's archive writes it; multi-stack hosts must use it |

> Tag shape illustration (this is about the **shape**, not about a specific release): an archive carries
> both the bare form `2.7.0` and the `v`-prefixed form `v2.7.0`. Commands always write `${IMAGE}:${VER}` —
> never copy a concrete version number.

**Rollback anchor** = the image that was **running** at the moment before the upgrade, frozen under a
**channel tag** (`${IMAGE}:<channel-id>-<old version>`). Switching the container happens after `.env` is
edited, so the anchor must be taken *before* the new image is imported.

**The migration set** is what classifies a rollback: the same set of migrations visible to both binaries
means a **same-generation rollback** (image only); a database newer than the binary means a
**cross-generation rollback** (database included). The current migration range is `0001–0084`.

## Procedure

### 1. Check for a new version

```bash
# Latest remote version (authoritative: server.version in latest.json)
curl -fsS https://release.picoaide.com/official/latest.json \
  | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
cat /opt/picoaide/VERSION        # currently deployed version
docker exec picoaide-server /app/picoaide-server --version   # running version
```

The admin console's **server info** page also shows a "new version available" hint (including the
target image tag), because the server performs the update check itself.

- The check address comes from `PICOAI_UPDATE_ENDPOINT`; empty = this channel's default directory
  `release.picoaide.com/<channel>/latest.json`;
- The server caches the result for **6 hours**, so a delay right after a release is normal;
- If no new version ever appears, look at `channel resolved: …` and
  `manifest channel "official" != this server's channel "…"` in `docker compose logs server` — that is a
  channel configuration that is not self-consistent (see [Channels & white-label](/en/deployment/channels/)),
  not "there is no new version".

**Criterion**: the remote `server.version` is greater than the local `VERSION`. Remote ≤ current →
**no upgrade needed, stop here**.

### 2. Pre-upgrade checks

```bash
cd /opt/picoaide

# (a) PostgreSQL data layout check: the old layout (PG16 era) is refused on startup
[ -f pg-data/PG_VERSION ] && echo "!!! old PG16 layout, dump/restore migration required, stop the upgrade" || echo "PG layout OK"

# (b) free disk space (both the new image and the backup need room)
df -h /opt | tail -1
```

If `!!!` appears, **stop the upgrade** and migrate the data with PostgreSQL's official dump/restore
procedure first — the old `pg-data/` layout is incompatible with the new image and is not migrated
automatically.

**(c) Behaviour-change list** (decide each item before upgrading):

| Change | Why it matters |
|---|---|
| Existing admin sessions are invalidated (migration `0066`: session tokens are stored hashed) | **Administrators must sign in once more**; that is expected, not a fault |
| Irreversible migrations (`0073` drops tables, `0074` rewrites app configuration) | For version lines that introduced them, **a rollback is not just an image swap** — the database must roll back with it |
| The default gateway rate limit changed | The code default became "no rate limit", but **an already-stored `settings.gateway.rate_limit` is not overwritten** — an old database keeps the old limit. To lift it, set the value to `0` (or clear it) explicitly on the admin **gateway** page |
| App-platform memory profile | A host with less than 4 GiB available memory must set `PICOAI_WASM_MEMORY_PROFILE=small`, otherwise the container **restarts in a loop after the upgrade** (the startup self-check refuses to start) |
| Client behaviour changes (for example, no longer using the system proxy) | Only deployments that can reach the internet *solely* through a proxy need action: enable the escape hatch in the channel field or in the real process environment |
| App access model and the same-version requirement | Old clients cannot open apps after the upgrade; that is expected — make sure clients upgrade too |

**Criterion**: the PostgreSQL layout is OK, there is room for both the new image and a backup, and every
behaviour change has a decision.

### 3. Backup (cannot be skipped)

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
```

**Verify the backups are not empty** (otherwise the upgrade has no way back):

```bash
[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! application data backup is empty"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! database backup is empty"
```

**Criterion**: neither `[ -s … ]` prints `!!!`, and both files in `ls -lh` have a **plausible size**
(the dump grows with the data; a few dozen bytes means the database or user name was wrong).

**What an empty backup means**: `pg_dump` failed while the shell still created the file — there is **no
database way back**. Do not continue with an empty backup: fix `pg_dump` (container name, user
`picoaide`, database `picoaide`, free space), redo it and verify again.

### 4. Import the new image

```bash
VER=<version from step 1>
IMAGE=picoaide-harness-server

curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS
unzip -p /tmp/pa.zip image.tar | docker load
```

For servers with no outbound internet, see [Air-gapped deployment](/en/deployment/offline/).

**Criterion**: `sha256sum -c` prints `OK`. If verification fails, **do not** `docker load` — fetch the
package again over another path, or use the bypass procedure in
[Air-gapped deployment](/en/deployment/offline/).

### 5. Switch versions and restart

On a single-stack host:

```bash
cd /opt/picoaide
# Use server.image_tag from latest.json (authoritative, shaped like v<version>).
# The archive carries both the bare and the v-prefixed tag, so either starts; multi-stack hosts
# must use the channel tag (next section).
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${VER}|" .env
grep -q '^SERVER_IMAGE=' .env || echo "SERVER_IMAGE=${IMAGE}:${VER}" >> .env

# Optional but recommended: re-export the deployment files (replace semantics; .env and data untouched)
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}

docker compose up -d
```

- `docker compose up -d` recreates only the containers that changed; the data directories are bind
  mounts, so **data is unaffected**;
- Re-exporting uses **replace** semantics: `client/`, `VERSION`, `docker-compose.yml`, `Caddyfile.*`
  and `.env.example` are cleared before being written (otherwise `client/` keeps installers from two
  versions); `.env` and every data directory are left untouched;
- **When the host already runs a reverse proxy**: recreate only this product's containers
  (`docker compose up -d postgres server`) and leave the shared proxy alone
  (see [Operations & troubleshooting](/en/deployment/operations/)).

#### Running multiple channel stacks on one server

Channel differences live in the **image content** (branding, bundled client, the channel marker baked
into the image), **not in the tag**: every channel's archive carries the same bare and `v`-prefixed
version tags. So when a second channel's package is imported on the same host, the later `docker load`
**overwrites** those tags, and any stack running `docker compose up -d server` afterwards can be
recreated from **another channel's** image — wrong branding and wrong bundled installers, while that
stack's `.env` still looks perfectly correct.

Since `v2.8.2-beta.1` (2026-09-24) every channel archive **additionally** carries a channel tag
`${IMAGE}:<channel-id>-<version>`; all three tags point at the **new** image and `docker load`
restores them together, so **no tag has to be re-created by hand**. The correct order on a multi-stack
host is:

```bash
VER=<this version, without v>
OLD=<version before the upgrade, without v>
IMAGE=picoaide-harness-server
CHANNEL=<this stack's channel id>   # ← must match the channel marker baked into the image
STACK=/opt/picoaide                 # ← this stack's deployment directory
CT=picoaide-server                  # ← this stack's server container

# 0) Freeze the PRE-UPGRADE running image as the rollback anchor — the only legitimate use of
#    "the running container": right now it IS the old version, so it may only get an OLD channel tag.
#    ⚠ Do not name the variable GID/UID: they are read-only specials in zsh on some hosts.
docker exec "$CT" cat /opt/picoaide/CHANNEL        # first confirm this stack really runs this channel
ROLLBACK_IMAGE_ID="$(docker inspect "$CT" --format '{{.Image}}')"
docker tag "$ROLLBACK_IMAGE_ID" "${IMAGE}:${CHANNEL}-${OLD}"

# 1) Import this channel's package (each stack loads its own channel's package)
unzip -p /tmp/pa.zip image.tar | docker load

# 2) Read the id of the image you JUST imported: only via the channel tag
NEW_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${IMAGE}:${CHANNEL}-${VER}")"
test -n "$NEW_IMAGE_ID"
test "$NEW_IMAGE_ID" != "$ROLLBACK_IMAGE_ID"       # old and new must be two different images
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "${IMAGE}:${CHANNEL}-${VER}"                     # must equal ${VER}
docker run --rm --entrypoint cat "${IMAGE}:${CHANNEL}-${VER}" /opt/picoaide/CHANNEL   # == ${CHANNEL}

# 3) Point this stack's .env at the channel tag (never leave a bare `v<version>`)
cd "$STACK"
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${CHANNEL}-${VER}|" .env
grep -q '^SERVER_IMAGE=' .env || echo "SERVER_IMAGE=${IMAGE}:${CHANNEL}-${VER}" >> .env
docker compose up -d server

# 4) Assert that this stack really runs this channel's new version (all five must pass)
ENV_TAG="$(sed -n 's/^SERVER_IMAGE=//p' .env)"
test "$(docker image inspect --format '{{.Id}}' "$ENV_TAG")" = "$NEW_IMAGE_ID"   # .env's tag points at the new image
docker inspect "$CT" --format '{{.Image}}'         # == $NEW_IMAGE_ID ← the most important one
docker exec "$CT" /app/picoaide-server --version   # == target version (ask the binary, not the tag)
docker exec "$CT" cat /opt/picoaide/CHANNEL        # == $CHANNEL
curl -sk "https://<this stack's domain>/api/client/v2/channel" | head -c 300   # channel_id matches
```

> **Never take the id of "the running container" and stick the new version's channel tag on it.** The
> container switch happens in step 3, so `docker inspect "$CT"` in step 2 returns the **pre-upgrade**
> image's id. Tagging it as `${IMAGE}:${CHANNEL}-${VER}` renames the old image into "the new version's
> channel tag" and overwrites the correct tag the archive just restored; `.env` then points at that tag
> and `docker compose up -d` recreates from the same image id ⇒ **the upgrade silently does nothing**,
> while the tag and `.env` both claim the new version and the rollback anchor is poisoned. Nothing
> errors out; only the image-id / `--version` assertions in step 4 can detect it.

> **Bare tags cannot tell you which image you just imported**: they are identical across every channel
> archive, and a second stack's `docker load` overwrites them (after the overwrite
> `docker image inspect` does not fail, it just returns **another channel's** image id). Only
> `<channel-id>-<version>` is unique to one channel.

Old packages (archives without a channel tag, i.e. before 2026-09-24) can only fall back to the bare
tag: immediately after `docker load`, read the id with
`docker image inspect --format '{{.Id}}' ${IMAGE}:${VER}` and verify the baked channel on the spot
(`docker run --rm --entrypoint cat ${IMAGE}:${VER} /opt/picoaide/CHANNEL` must equal `${CHANNEL}`),
then tag it as the channel tag. A first deployment (no running container yet) has no step 0; steps 1–4
apply as-is.

### 6. Post-upgrade verification (all three must pass)

```bash
cd /opt/picoaide
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)

# (a) health check
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")
  [ "$code" = "200" ] && { echo "healthz OK"; break; }; sleep 3
done

# (b) running version == target version (authoritative: ask the binary, not the tag)
docker exec picoaide-server /app/picoaide-server --version

# (c) data still there (migrations applied)
docker exec picoaide-postgres psql -U picoaide -d picoaide -c 'select count(*) from users;'
```

Also spot-check the two client distribution links:

```bash
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" \
  "https://$DOMAIN/updates/client/<file name from the manifest>"
```

`client.version` in the manifest must change with this upgrade, and the installer must be downloadable
(a range request returns 206). Multi-stack hosts must also run the five assertions from step 4 of the
previous section.

**If any one fails → roll back (step 7), do not continue.**

### 7. Finishing up

```bash
cd /opt/picoaide
echo "$VER" > VERSION                       # update the local version record if step 5 did not re-export
docker compose ps                           # three containers Up
# Keep the old image for now (rollback anchor); clean it up after 1–2 days of stable operation:
# docker image rm picoaide-harness-server:<old version>
```

Clients see the new version on their next check and prompt employees (the update source is this server).

## Rollback

**First decide which class of migration the new version introduced**; the two cases are completely
different.

| Case | Criterion | Procedure |
|---|---|---|
| **Same generation** | The migration sets visible to both binaries are **identical** | The image alone can be swapped: the schema stays new, but the old binary does not reference the new columns |
| **Cross generation** | The database is **newer** than the binary (`schema_migrations` holds a version the binary does not know) | **The image alone is not enough**: since 2026-09-25 the binary refuses to start (`SchemaMismatchError`). Follow **stop the service → restore the pre-upgrade `pg_dump` → roll the image back → roll the clients back** |
| **A version line with irreversible migrations** | It introduced migrations such as `0073` (drops tables) or `0074` (rewrites stored configuration) | Same four steps; rolling back only the image makes an old binary without the two-way reconciliation return `42P01` (`undefined_table`) on every request — the service starts, the health check passes, and app-related requests fail at runtime with 500 |

> **Migrations that only add columns or tables have a lighter equivalent path**: delete that row from
> `schema_migrations` and the database and binary are "the same generation" again, so the image alone
> can be swapped — **no `pg_dump` restore, no loss of data written after the upgrade**. Two conditions
> apply: ① the migration is reversible (add-column / add-table only; migrations that drop tables or
> rewrite existing data do not qualify); ② you accept that the schema keeps the new columns. The
> command (use your own container / user / database names):
>
> ```bash
> docker exec -i <pg container> psql -U <db user> -d <db name> \
>   -c 'DELETE FROM schema_migrations WHERE version = <NNNN>;'
> ```
>
> **Neither path allows "change `SERVER_IMAGE` and restart".** Rolling forward again re-adds that row
> and refills its checksum.

```bash
cd /opt/picoaide
OLD=<version before the upgrade>
IMAGE=picoaide-harness-server
CHANNEL=<this stack's channel id>   # ← must match the channel marker baked into the image

# 1) Switch back to the old image — use the channel tag frozen in step 0 of the multi-stack section
#    (that tag IS the rollback anchor).
#    ⚠ Never write the bare `${IMAGE}:${OLD}`: on a multi-stack host another channel's `docker load`
#    may already have overwritten it, and compose's PICOAI_CHANNEL defaults to empty
#    ⇒ this stack comes up under another channel's branding, silently.
docker image inspect --format '{{.Id}} {{.RepoTags}}' "${IMAGE}:${CHANNEL}-${OLD}"   # the anchor must exist
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${CHANNEL}-${OLD}|" .env
docker compose up -d

# 2) Verify the old version is healthy (both version and channel)
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
docker exec picoaide-server /app/picoaide-server --version      # must equal OLD
docker exec picoaide-server cat /opt/picoaide/CHANNEL           # must equal $CHANNEL (catches a silent brand swap)
echo "$OLD" > VERSION

# 3) Restore application data only if it was damaged (loses data; explicit consent required)
# docker compose stop server
# tar xzf deploy-backup/picoaide-data-<TS>.tar.gz -C picoaide-data
# docker compose start server
#
# 4) Cross-generation rollback / version lines with irreversible migrations: this step is mandatory
#    (loses data; explicit consent required)
# docker compose stop server
# docker exec -i picoaide-postgres pg_restore -U picoaide -d picoaide --clean \
#   < deploy-backup/pg-data-<TS>.dump
# docker compose start server
```

**Rollback steps 3 and 4 lose everything written after the upgrade**; explicit consent is required.

## Criteria

| Criterion | How |
|---|---|
| The backup is valid | Neither `[ -s … ]` warns, and both files have a plausible size |
| The image is trustworthy | `sha256sum -c SHA256SUMS` prints `OK` |
| The running version is correct | `docker exec picoaide-server /app/picoaide-server --version` == target version |
| The channel is correct (mandatory on multi-stack hosts) | the container image id == the new image id; `/opt/picoaide/CHANNEL` == `${CHANNEL}`; `/api/client/v2/channel`'s `channel_id` matches |
| The service is usable | `/healthz` returns 200 |
| The data is there | `select count(*) from users;` returns a result; migrations are applied up to the current range |
| The client links work | the manifest's `client.version` changed; the installer downloads (206) |
| Finishing up is done | the `VERSION` file == the running version; the old image is still present (rollback anchor) |

## Boundaries and failure behaviour

| Symptom | Criterion | Recovery |
|---|---|---|
| Containers restart in a loop after the upgrade | the log shows `SchemaMismatchError` | **Cross-generation rollback**: follow the four steps in section 7 (stop → restore `pg_dump` → roll the image back → roll clients back) |
| Containers restart in a loop after the upgrade | the log says the WASM platform startup self-check refused to start | Less than 4 GiB available memory: write `PICOAI_WASM_MEMORY_PROFILE=small` in `.env`, then `docker compose up -d server` |
| `--version` disagrees with what `.env` claims | the binary reports something other than the target version | The container was not replaced: on multi-stack hosts redo the five assertions in step 5 (the key one is `docker inspect <container> --format '{{.Image}}'`) |
| Branding changed after the upgrade / the portal shows vendor branding | `/opt/picoaide/CHANNEL` ≠ `channel_id` from `/api/client/v2/channel` | Wrong channel image: point `.env` back at this channel's channel tag and recreate; do not keep upgrading from it |
| healthz stays non-200 | `docker compose ps` / `logs` | First confirm postgres is healthy and whether migrations are still running (1–2 minutes on a first start); otherwise roll back per section 7 |
| The backup is empty | `[ -s … ]` prints `!!!` | **Stop the upgrade**: fix `pg_dump` (container / user / database / disk) and redo the backup, then verify again |
| The old version starts after a rollback but requests return 500 | the log shows `42P01` (`undefined_table`) | This is "the image was rolled back but the database was not" (an old binary without the two-way reconciliation): stop the service → restore the pre-upgrade `pg_dump` → start again |
| The rollback anchor was overwritten | `docker image inspect`'s `RepoTags` point at another channel / do not exist | Re-`docker load` that channel's old package from the update server, freeze the channel tag, then roll back (the old package may already be outside the retention window — see [Air-gapped deployment](/en/deployment/offline/)) |
| Administrators are asked to sign in again after the upgrade | migration `0066` invalidates existing admin sessions | Expected; just sign in again |

## Upgrade checklist

- [ ] Remote version > current `VERSION`
- [ ] PostgreSQL layout check passed (no `pg-data/PG_VERSION`), disk headroom is sufficient
- [ ] Every behaviour change has a decision (rate limit default, memory profile, client behaviour, irreversible migrations)
- [ ] Backup completed and **not empty** (`picoaide-data/` + `pg_dump`)
- [ ] New image imported and `SHA256SUMS` verified
- [ ] On multi-stack hosts: the pre-upgrade image is frozen under an **old-version** channel tag
- [ ] `.env`'s `SERVER_IMAGE` points at the new version (the channel tag on multi-stack hosts)
- [ ] healthz 200 + `--version` == target version + data queryable
- [ ] `client.version` and installer download are correct
- [ ] Employees' clients are confirmed to reach the matching version (apps open only inside the client)
- [ ] The local `VERSION` file is updated; the old image is still present
- [ ] No command forbidden by the [iron rules](/en/deployment/) was executed

## Related

- [Deployment overview](/en/deployment/) — deliverable, certificate modes and the four iron rules
- [Container deployment](/en/deployment/compose/) — first-time deployment
- [Client delivery & updates](/en/deployment/client-delivery/) — how clients follow the server version
- [Channels & white-label](/en/deployment/channels/) — why channel tags are mandatory on multi-stack hosts
- [Air-gapped deployment](/en/deployment/offline/) — fetching packages and reworking the update check
- [Operations & troubleshooting](/en/deployment/operations/) — restores, logs and common faults
