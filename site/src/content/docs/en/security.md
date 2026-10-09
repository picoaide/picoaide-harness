---
title: Security & compliance
description: "Keys, tokens and sessions, sandboxing, outbound traffic and audit: the security design and its acknowledged residual limits."
---

This page gathers the security design that is otherwise spread across the codebase into **one place**: every statement comes with a verifiable implementation detail (a field name, a file mode, an algorithm, a limit, an ordering), and the final section states honestly which **boundaries still exist** in the current implementation.

Audience: administrators and operators deciding whether this passes their security review, and maintainers auditing the implementation. Day-to-day key and token operations live in [Deployment](/en/deployment/) and the [Enterprise control plane](/en/admin/); the operational detail of sandboxing is in the [Desktop client](/en/desktop/); the app runtime boundaries are in the [App centre](/en/apps/).

## Trust boundaries and trade-offs

Start by writing down who is *not* trusted; the mechanisms below only make sense afterwards:

| Location | Trust assumption | What implements it |
|---|---|---|
| The employee machine | **Untrusted**: other processes of the same user on the same machine, and the employee themselves | Local write and session surfaces use a **proof of possession** (an `HttpOnly` + `SameSite=Strict` cookie only this application's own pages can obtain); a packaged build refuses debugging command-line switches; windows are created with `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` |
| Client ↔ server | The client is **untrusted**, including the `Origin` / `Host` it reports | An employee token (90 days, stored hashed only) plus a proof of possession for app requests; an app request's `host` is parsed from the URL path segment only and **never** reconstructed from a request header |
| Inside the server process | Trusted (it is our own code) | External input is still bounded: an app guest has WASI capabilities only, with hard memory and time caps |
| The upstream model provider | Outbound traffic only to the address an administrator configured (**private networks are allowed**; cloud-metadata and link-local addresses are always refused at dial time) | Upstream keys are held by the server alone and stored encrypted; outbound addresses have their own guard (see "Outbound traffic and trust boundaries") |

One trade-off runs through all of it: **deny by default, and make the failure direction explainable**. Refusing one legitimate operation with a next step is better than degrading silently — many places in this repository state exactly that as "fail-closed" (a failed balance lookup, an unreadable grant, an unavailable sandbox, a missing write proof).

## Keys and credentials

### Server keys and secrets

- Upstream API keys, MFA secrets and secret fields in settings are all stored **AES-GCM** encrypted, with the ciphertext prefix `enc:v1:` and the form `enc:v1:<base64(nonce‖ciphertext)>`; **every encryption uses a fresh random nonce**;
- The master key comes from the `PICOAI_MASTER_KEY` environment variable, otherwise from `master.key` in the data root: 32 random bytes, mode **0600**, created with `O_EXCL` so that a concurrent first start has exactly one winner (the loser re-reads), in a data directory of mode **0700**, and it is **never written into the database**;
- A ciphertext that cannot be decrypted (master key replaced, tampered value, foreign value) returns an error; it never degrades into "treat it as empty".

> Lose `master.key` and the encrypted upstream keys in the database are **unrecoverable**. That is exactly why [Upgrade, backup & rollback](/en/deployment/upgrade/) makes "the backup must include the data directory and must be non-empty" an iron rule.

### The server signing key

Opening an app and calling it require the client to present a **proof of possession**, signed by the server with an Ed25519 private key. That key is **generated per deployment at startup, stored in the data root (0600, atomic write) and never baked into the image** — the same trust boundary and the same backup rule as the master key.

### Client-side credentials

| Credential | Location and mode | Write path and boundaries |
|---|---|---|
| Connector credentials (OAuth tokens, static tokens) | `<data root>/users/<encoded account>/servers/<server hash>/connectors/`, directory **0700**, file **0600** | Atomic write (temp file + `fsync` + `rename`); the directory must be a **real** directory (a symlink is refused); one document ≤ 64 KiB (the same cap on the write and read paths); a read failure is classified as `unreadable` / `too-large` / `malformed` and is **fail-closed** — "cannot read" is never treated as "no credential", which would silently erase the access and refresh tokens |
| Employee session token | `<data root>/session.json`, mode **0600** | Encrypted with Electron `safeStorage` when a system keyring exists; **on Linux without a keyring it falls back to 0600 plaintext with a warning** (an acknowledged item, see the last section) |

Connector credentials are scoped by **account × server**: switching to another server is not treated as the same tenant, and credentials written by an older layout carry no server marker and are **not adopted** — the price is that the affected connectors need one fresh authorization (a deliberate fail-closed price; the alternative is cross-tenant secret replay).

### Directories and path escapes

- The server only reads and writes inside its own data directory; wherever **user input takes part in composing a path** (archive names, version numbers, …) it first passes `SafePathSegment` (non-empty, no separators, not `.` / `..`), backed by a name allow-list pattern as a second line of defence;
- The app runtime has **no host filesystem capability at all**: the argument to `assets.read` is an **in-package logical path**, and the host performs an exact key lookup in an in-memory map (no normalisation, no prefix matching, no wildcards);
- Where a directory must be walked (packaging, skill archives), the traversal root must be a **real directory** (a symlink is refused) and every access is anchored to `realpath` before a prefix comparison.

## Tokens and sessions

### Employee tokens

- 32 random bytes; only the **SHA-256 hash** is stored (the plaintext is returned to the client once, at issue time); default lifetime **90 days**; issuance first sweeps a bounded batch of expired rows (through the expiry index);
- The token is the only credential for `/api/client/v2/*` and `/v1/*`;
- **Password change, demotion and disabling update the user row and `DELETE` all of that user's `api_tokens` and `admin_sessions` inside one transaction** — the permission change and the invalidation of old credentials take effect atomically, leaving no standing login surface.

### Admin sessions

| Item | Value |
|---|---|
| Hard lifetime | **12 hours** |
| Idle sliding | invalid after **60 minutes** untouched; refreshed on every successful validation |
| Storage | only `secret_hash` is stored; never the plaintext session token |
| CSRF | an HMAC token with the same lifetime as the session (`HMAC(CSRFKey, "session:" + sessionID)`), compared in constant time |
| Auth chain | `AdminAuth` (session + CSRF) → `RequirePermission(permission)` → the business handler |

Administrators may opt into **MFA (TOTP)**; after a password reset the account enters a "must change password at next sign-in" state and the server blocks other endpoints with 403 `PASSWORD_CHANGE_REQUIRED`. Passwords are hashed with **argon2id** (`$argon2id$v=19$m=65536,t=3,p=2$…`) and the minimum length is **10** by default (configurable between 8 and 64).

### Login rate limiting

| Dimension | Budget (default) | Notes |
|---|---|---|
| Account | 10 attempts / 5 minutes | The `u:<username>` and `ip|username` keys share one budget; the client-facing and admin-facing logins share it too |
| Source IP | 60 attempts / 5 minutes | Login, the OIDC callback and OIDC flow start each have their own bucket |
| Counting rule | **failures only** | "Decide and record" happens in one critical section (success clears the key; a refusal is never recorded twice) |

Three details that are easy to get wrong:

- **The IP must be the real client IP resolved at the trust boundary.** Behind a reverse proxy, using the TCP peer address collapses every bucket onto the proxy's own IP — 60 failed logins from one unauthenticated party then lock **the whole organisation** out for the rest of the 5-minute window. `X-Forwarded-For` is honoured only when the TCP peer is loopback or an explicitly configured trusted proxy;
- **The decision key, the recording key and the clearing key must come from one construction point**: miss one of the three and the bucket never fills, so rate limiting fails **silently**;
- "Count failures only" must be atomic rather than "decide first, record after the failure" — the latter lets a concurrent burst straight through.

A newly saved **LDAP** configuration using a non-loopback plaintext `ldap://` URL is **refused by default** (the bind password would cross the network in clear); allowing it requires an explicit `PICOAI_LDAP_ALLOW_PLAINTEXT=1`, and every such save writes a log line.

## Sandbox and permissions

### The three tiers

The upstream model defaults to `read-only` (a fail-safe default); the product bundles it with an approval policy and presents "presets":

| Tier | File effects | Typical use |
|---|---|---|
| Read-only | no writes at all | Reading code, researching, reviewing |
| Workspace write (the default) | **only the session workspace** plus the platform temp directory; **reads are unrestricted** | Day-to-day code changes |
| Full access | no file-effect restriction | Installing dependencies, touching paths outside the workspace |

The writable surface comes from a single root-derivation function: `workspace root + /tmp + the platform temp directory`, all canonicalised with `realpath` before comparison. **Unrestricted reads are deliberate** (the AI must be able to read dependencies and system headers); read this boundary as a boundary on *writes*, not as a confidentiality boundary.

### Platform backends and failure direction

| Platform | Mechanism |
|---|---|
| Linux | `bwrap` first (namespaces + a mount allow-list), then the kernel **Landlock** |
| macOS | Seatbelt (the system `sandbox-exec`) |
| Windows | a restricted token plus directory **ACL**s (a capability write ACE and a Low mandatory label) |

- When no runner is usable the result is **`SANDBOX_UNAVAILABLE`; commands never run unconfined by silent degradation**;
- Every execution reports whether enforcement is `full` or `partial`, and distinguishes "policy denial" from "runner failure" signatures — conflating an unavailable or broken sandbox with an ordinary policy denial is the most common diagnostic error;
- "Workspace write" on Windows must first write a DACL on the **workspace root**; when that is impossible (the directory belongs to another account, a mapped drive, a non-NTFS volume, …) it is **fail-closed**: every command in that workspace fails to start, the error names the DACL and offers two ways out (use another directory, or switch that session to full access);
- Approval is **one-shot**: what is approved is this one call; there is no "always allow". Both a sandbox refusal and an approval refusal come back to the model as a tool error, so the model can see who refused and why.

## Outbound traffic and trust boundaries

### The client uses no system proxy by default

- The one effective measure is the **module-scope** startup switch `no-proxy-server`, appended before `app.whenReady()`: it covers the default session and **every partition created later** (built-in browser, app windows, platform outbound requests) and overrides a proxy passed explicitly on the host command line;
- Calling `setProxy({mode:'direct'})` on a single session is **not enough**: partitions still resolve to the proxy;
- The main-process Node stack is forced onto a direct dispatcher, and proxy environment variables are stripped from spawned children — and that stripping must happen **after** the layered `.env` is loaded, or `.env` puts them back;
- **Escape hatches** for deployments where the only route to the internet is a proxy: the channel field `desktop.allow_system_proxy: true`, or the real process environment variable `PICOAI_ALLOW_SYSTEM_PROXY=1`. Precedence is "real process environment > channel package > deny by default"; a switch written in the layered `.env` is structurally too late, and the startup log says it was ignored.

### Updates: a single source

- The client takes update information **only from the server it is signed in to** (`GET /api/client/v2/updates/manifest`); **not being signed in means there is no update source**, and no outbound check happens at all (that is not "the check failed");
- The manifest must pass structural validation (`schema` is 1, the channel id matches the server, the download URL is absolute https); the installer is streamed and checked against the manifest's **SHA-256**, then checked again against the platform container magic, and finally atomically renamed into place; if any step fails, nothing is installed and the current version stays;
- **Installation is always triggered explicitly by the user** (Windows launches the installer, macOS opens the disk image, Linux asks the user to replace the file) — the product does not do "silent restart-and-install";
- Client error reporting is **off by default**: the client initialises reporting only when the server explicitly enables it and supplies a DSN.

### Connector outbound traffic

A connector follows addresses handed to it by the previous hop (`WWW-Authenticate`, the authorization-server list, endpoints inside discovery documents), so the policy is not "check the URL once":

1. **Protocol**: `https`, or `http` **restricted to loopback**;
2. **Address**: a resolution landing in a private, link-local, cloud-metadata, multicast or reserved range is refused;
3. **Resolution must be verified**: a resolver error, a resolution deadline or an empty answer is refused exactly like a non-public address (reported separately, but never a pass);
4. **Pin the connection**: the verified addresses are handed to that connection and **no second resolution happens**, with no fallback to the system resolver — no pin means refusal;
5. **Redirects**: `redirect: 'manual'`, and every 3xx is refused (otherwise the authorization code and PKCE verifier are delivered to a host the initial-URL policy would have refused);
6. **The proxy route is decided in the same judgement as the address check**: under a proxy the local resolution result is no longer the criterion — an explicit choice, not a silent fallback; an unreadable proxy configuration is a refusal.

### Server outbound traffic

The server carries credentials to the upstream gateway (an administrator-configurable address), therefore:

- **Private networks are allowed** (a self-hosted LLM gateway on the corporate LAN is the main scenario);
- **Cloud-metadata and link-local addresses are always refused**, with known metadata hostnames as a second line of defence; the crucial part is **re-checking the resolution at dial time** — a static check at save time cannot stop DNS rebinding (public at save time, resolving to a metadata address at request time);
- "Policy refusal" and "resolution/connection failure" are **two typed errors** with opposite diagnostic directions, and neither disguises itself as the other.

## Authorization and audit

### Deny by default

- Marketplace and shared content (skills / agents) is a **review plus grant, two-gate** system: unreviewed, unpublished and ungranted all return **the same 404 as "does not exist"** (no existence leak);
- A grant subject is a **user** or a **department group** (group names case-insensitive; departments inherit through membership plus the ancestor chain, and managers additionally through the subtree); administrators are always full-scope and are not written into the grant table;
- An app belongs to an **individual**: a non-owner hitting an app endpoint gets a 404 that is byte-for-byte identical to "app does not exist", and a frozen app is treated the same way for non-owners;
- The admin surface does **not** fake 404s (insufficient permission returns 403) — that surface is for audit and operations, not an enumerable one.

### Two gates on the admin surface

1. Every `/api/server/admin/*` route **must** declare its permission through the shared registration function, and the registry is checked against the real route table by tests — closing off "a missing permission declaration means privilege escalation";
2. The request chain is fixed: `AdminAuth` (session + CSRF) → `RequirePermission` (the permission) → the business handler, with permissions assigned per role (super admin / auditor / ordinary user).

### Audit

- Each audit row's hash is `sha256(prev_hash | username | action | detail | created_at)`, with `prev_hash` pointing at the previous row — **rewriting any row breaks the chain**;
- Writes are serialised by a transaction plus an advisory lock (concurrent inserts that all read the same `prev_hash` would fork the chain into two);
- Chain verification has an **executor**: once at startup plus periodically, and the verdict carries a freshness stamp (older than two hours counts as stale, so the UI never presents an old verdict as current); after retention purging, the chain's start is the retained anchor, which does not affect verification;
- Retention defaults to **180 days**, configurable between 1 and 3650 days, and is executed by a periodic scheduler (saving the setting triggers one immediate run as well);
- Audit write failures are **observable**: an in-process counter plus the structured shape of the most recent failure, readable from the server-info surface — "silently dropping rows" is equivalent to having no audit at all.

## App runtime isolation (conclusion)

The isolation conclusion for the app platform is at the **capability-does-not-exist** level; it does not rely on filtering malicious input:

- The guest instantiates `wasi_snapshot_preview1` only, with **zero preopens** and no `args` / `env`;
- WASI preview1 has no `sock_open` / `sock_bind` / `sock_listen` / `sock_connect` and no spawn, so an app **cannot obtain a socket fd and cannot start a subprocess**;
- Host capabilities are **one closed method table** (eight methods); anything outside it is refused with the available list attached;
- Per-instance memory, guest time, host calls, per-statement SQL and the end-to-end wall clock all have hard caps.

The method table, the budgets and the failure behaviour are in the [App centre](/en/apps/), under "Runtime boundaries" and "Boundaries and failure behaviour".

## Acknowledged residuals

Everything below is a **real boundary of the current implementation**. It is written down so a reviewer can decide, against their own risk appetite, whether to stack additional measures — not to claim that "security is complete".

| # | Residual | Notes | Possible convergence |
|---|---|---|---|
| 1 | The Windows installer and the Linux AppImage are **unsigned** | SmartScreen may warn about an unknown publisher; macOS release builds are signed and notarised, while **pre-release builds are signed only** (no notarisation ticket) | Buy a code-signing certificate; do not ship pre-release builds as deliverables |
| 2 | macOS ships **Apple silicon (arm64) only** | There is no Intel installer | Add a second build line if needed (cost and signing chain both change) |
| 3 | The cost of the client **banning every proxy** by default | A deployment whose only route out is a proxy must enable an escape hatch explicitly; the built-in browser loses the proxy as well | A channel field or a real process environment variable (neither depends on server-pushed configuration) |
| 4 | "Workspace write" on Windows depends on the workspace root's **DACL being writable** | Without it the mode fails closed: every command in that workspace fails to start, and a human must fix the directory ownership or switch to full access | Use a directory created by this account on local NTFS as the workspace |
| 5 | The local write surface's **proof of possession depends on cookie confidentiality** | A packaged build refuses debugging switches (`--inspect*` is backstopped by a packaging-time fuse), but the structural premise "a same-machine, same-user process cannot read the cookie jar" is unchanged — closing it properly means making the write proof independent of cookie confidentiality, which is **not done** | Introduce a proof that does not rely on the cookie |
| 6 | Connector credentials are **not inherited across servers** | Credentials from the older layout carry no tenant marker, so the affected connectors need one fresh authorization | A deliberate fail-closed trade-off |
| 7 | The sandbox is **same-world** | It shares the host kernel and filesystem; upstream also registers three limits: Windows ACL enforcement is `partial` (hard links alias one file object, reads stay unconfined, and a directory another AppContainer tool protected with a package SID is unreadable), Landlock may be `partial` on older kernels, and macOS relies on the deprecated `sandbox-exec` (which cannot be replaced if Apple removes it) | Use a container or a remote executor when a strongly isolated environment is required |
| 8 | Compile-cache entries carry **no content signature** | The compile process has OS-level isolation and a 0700 cache directory, but a writer with the same uid as the host can still poison entries; closing it needs a separate uid, a read-only mount or an HMAC manifest on the deployment side | Deployment-side hardening (the server exposes the residual through an operator-facing accessor) |
| 9 | The app **retirement snapshot and hard-delete task are not implemented** | The export endpoint states "exportable during the retention window → hard-deleted after it", but that background task does not exist yet | A later release |
| 10 | On Linux without a system keyring, the client session token is stored as **0600 plaintext** | Installing gnome-keyring / kwallet switches it to `safeStorage` encryption; the client logs a warning when it degrades | Install a keyring on the deployment side |
| 11 | LDAP error-text redaction covers only **common encodings** | The directory service already has the plaintext password from the bind request and can echo it in any shape; redaction removes the verbatim, upper/lower-case, base64 and URL-encoded forms, but partial echoes and inserted separators can still slip through (control characters are escaped, so one error stays one line) | Never log peer error text at all (gives up diagnostic ability; not adopted) |

## Related

- [Desktop client](/en/desktop/) — permission tiers, approvals, windows and local data
- [App centre](/en/apps/) — the app runtime's capability surface and budgets
- [Enterprise control plane](/en/admin/) — users, authentication, MFA, audit and retention
- [Upgrade, backup & rollback](/en/deployment/upgrade/) — the master-key backup rule and rollback semantics
- [System architecture](/en/architecture/) — the three-layer topology and data flow
