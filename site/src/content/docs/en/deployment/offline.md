---
title: Offline deployment
description: 'How to deploy and upgrade PicoAide Harness when the server or employee machines cannot reach the internet.'
---

The product's main form is enterprise intranet deployment, so "does it work offline" breaks down into two
separate questions:

| Who | Needs internet? | Description |
|---|---|---|
| **Employee machines** | **Not at all** | Both client installers and update packages are delivered by the enterprise server (see [Client delivery & updates](/en/deployment/client-delivery/)) |
| **Server** | Only for "checking for updates + downloading images" | Reaching `release.picoaide.com` is enough; in a fully isolated environment, fetch packages via the bypass on this page |

## Employee side: zero internet dependency

The server image already carries the client installers for all three platforms and serves them once deployment
is complete. Employees only need to reach the enterprise domain — not the update server, GitHub or any public address.

## Server side: how to fetch images in a fully isolated environment

On **any machine with internet access**, download the image archive and the checksum file, then carry them into the intranet:

```bash
# 1) Read the version (authoritative fields: server.version / server.image_tag)
curl -fsS https://release.picoaide.com/<channel>/latest.json

# 2) Download the image archive and the checksum file
VER=2.7.0
curl -fL -o picoaide-server-${VER}-amd64.zip \
  "https://release.picoaide.com/<channel>/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/<channel>/releases/${VER}/SHA256SUMS"

# 3) After copying into the intranet, verify and import
sha256sum -c SHA256SUMS
unzip -p picoaide-server-${VER}-amd64.zip image.tar | docker load
```

- The update server **keeps only the 3 most recent versions** per channel; earlier versions come from the
  [GitHub Release](https://github.com/picoaide/picoaide-harness/releases) (the complete historical archive for
  public channels, with the same asset names `picoaide-server-<version>-amd64.zip` + `SHA256SUMS`);
- For slow cross-border downloads, use parallel chunking (measured: 75–260 KB/s single stream, about 2 MB/s with
  8 parallel streams): for the method and pitfalls see
  [`docs/planning/2026-09-10-r2-update-server-runbook.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/planning/2026-09-10-r2-update-server-runbook.md) §11
  in the repository. Some Range requests are ignored by the CDN and return the whole file; the checksum is
  still the final arbiter;
- Verify `SHA256SUMS` before running `docker load` — there is no second acquisition channel inside the
  intranet, so a corrupt package means repeating the whole process.

After importing, the deployment steps are exactly the same as online; see [Container deployment](/en/deployment/compose/).

## Disabling or reworking update checks

By default the server checks for updates in this channel's default directory (`release.picoaide.com/<channel>/latest.json`):

```bash
# Disable update checks (for a pure intranet where no outbound request is wanted)
PICOAI_UPDATE_ENDPOINT=off
```

- **Leaving it empty does not turn it off**: empty = use this channel's default directory; to disable it you
  must explicitly write `off` / `none` / `-` / `disabled`;
- If the intranet has its own static file service, you can also mirror the image archives and `latest.json` into
  the intranet and point `PICOAI_UPDATE_ENDPOINT` at the intranet address (`latest.json`'s `channel_id` must
  match this deployment's channel, otherwise it is treated as "update check unavailable");
- Once disabled, the webadmin "Server info" page no longer shows new-version notifications, and upgrades are
  performed manually by operations following the [upgrade procedure](/en/deployment/upgrade/).

## Offline upgrade cadence

A fully isolated deployment has no "new version notification", so the version anchor relies on two manual checks:

```bash
cat /opt/picoaide/VERSION                                     # currently deployed version
docker exec picoaide-server /app/picoaide-server --version     # running version
```

Both should equal the target version written during the last upgrade. When upgrading, follow
[Upgrade, backup & rollback](/en/deployment/upgrade/); the only difference is that the image source in step 4
becomes "the zip carried in from outside".

## Intranet certificates and client trust

In `internal` mode, certificates are issued by Caddy's local CA; the connection is encrypted, but the client has
to trust that CA on first connect:

- If the intranet has an enterprise CA, use `manual` mode with a proper certificate and clients need no extra steps;
- With `internal` mode, distribute the Caddy root certificate to employee machines for import into their trust store;
- In either mode, the client login page rejects non-HTTPS remote addresses (TOFU verification).

Post-deployment self-check (no DNS dependency; resolves directly to the local machine):

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

The second one must show `client.assets` with absolute https addresses — in intranet reverse-proxy/certificate
setups, `PICOAI_PUBLIC_BASE_URL` is the value most easily left unconfigured, and the symptom is that employee
clients "always say they are up to date".
