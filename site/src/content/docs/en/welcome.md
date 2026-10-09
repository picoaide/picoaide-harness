---
title: Welcome
description: 'What PicoAide Harness is, the three layers it is made of, which pages each role should read, and what the product does and does not support today.'
---

PicoAide Harness is an **enterprise-grade DeepSeek Harness all-in-one platform**: a desktop client, a local Harness service, and an enterprise server in three layers, with sessions and files staying on the employee machine and accounts and governance staying on the customer's own server. Everything in the product is a plugin.

This page is the site's entry point: see what each layer owns, which order to read in, and the boundary list that tells you whether the capability you need exists yet.

## The three layers

```text
Employee machine                            One machine on the customer network
──────────────────────────────              (a single container image)
Desktop client (Electron app)               Enterprise server
  native window / tray / updates              Caddy + Go server + PostgreSQL
Local Harness service · 127.0.0.1           auth / model gateway / metering
  sessions · files · workspace · sandbox    Capability Hub / approvals / connectors
                                            app centre / audit / client delivery

            └──────── HTTPS + Bearer token ────────▶
            ◀──────── installers and manifest ─────┘
```

| Layer | Where it runs | What it owns |
|---|---|---|
| **Desktop client** | Employee machine | Native window and tray, sign-in page and account, automatic updates, and every UI panel: chat, Capability Hub, connectors, scheduled jobs, built-in browser, voice input, five-track memory, app centre |
| **Local Harness service** | Employee machine, random port on `127.0.0.1` (can be pinned) | Runs the pinned upstream DeepSeek Harness: sessions and message logs, file access, workspaces, sandbox and approvals, tool execution |
| **Enterprise server** | One machine on the customer network (a single container image) | Accounts and authentication, model gateway and keys, metering/billing with the balance gate, Capability Hub and approvals, connector catalogue, app centre, audit, client delivery, portal page and admin console |

The path of one model request: the client signs in to the server → fetches the model catalogue (`/api/client/v2/config/bootstrap`) → requests go to the server's `/v1/chat/completions` → the server applies rate limiting and the balance gate → matches the model to an upstream provider → metering and balance deduction happen in one transaction. **Upstream API keys exist only on the server**; the client never sees them.

## The enterprise view: what this actually raises

What an enterprise ultimately buys is not "one person who is very productive with AI" but an
organisation that has moved up a level. This platform targets the last three steps:

| Water line | Typical symptoms | What the platform provides |
|---|---|---|
| Individual experimenting | People reach for outside tools, data leaves the company, spend is a black box | Clients are served by your own server; employees only reach your domain. Upstream keys stay on the server |
| Department pilots | Every team wires up its own stack, nothing can be reused next door | One gateway and one model catalogue (a new model is a config change, not a code change); Capability Hub grants to users or departments |
| Platform-wide reuse | Skills, agents and apps become searchable, approvable, reusable assets | [Capability Hub](/en/desktop/) (employee upload → admin approval → everyone reuses it, with clear ownership), five-track memory (project know-how kept per directory and branch), [App centre](/en/apps/) (small tools built by one team, opened by everyone) |
| Measurable AI-native | Management can see the water line: who uses AI, where, at what cost, and what got reused | [Usage centre](/en/admin/) (attributed by department, member and model, on a reconcilable ledger), the balance gate, and a hash-chained audit log |

The water line is **measured, not surveyed**: adoption comes from the usage centre, capture from the
assets in the Capability Hub and the app centre, governance from audit and balance — all on one server,
with one set of numbers. See [Security & compliance](/en/security/) for how it is implemented.

## Read by role

| Role | Start with | Then read | When something breaks |
|---|---|---|---|
| **Employee** | [Getting Started](/en/getting-started/) | [Desktop Client](/en/desktop/) (sessions, Capability Hub, connectors, scheduled jobs, browser, memory, app centre) | [FAQ](/en/faq/) |
| **Enterprise administrator** | [Getting Started](/en/getting-started/) → [Private Deployment](/en/deployment/) | [Container Deployment](/en/deployment/compose/) → [Admin Console](/en/admin/) → [Client delivery & updates](/en/deployment/client-delivery/) | [Operations & troubleshooting](/en/deployment/operations/) |
| **Operations** | [Private Deployment](/en/deployment/) | [Container Deployment](/en/deployment/compose/) → [Upgrade, backup & rollback](/en/deployment/upgrade/) → [Air-gapped deployment](/en/deployment/offline/) | [Operations & troubleshooting](/en/deployment/operations/) |
| **Developer** | [System architecture](/en/architecture/) | [Plugin Development](/en/plugin-development/) → [Plugin Ecosystem](/en/plugin-ecosystem/) → [API Reference](/en/api-reference/) | [Product Philosophy](/en/philosophy/) (read the trade-offs before changing anything) |

To understand why the product is shaped this way, read [Product Philosophy](/en/philosophy/) first; it lists each design principle together with its evidence in the repository.

## Glossary

The whole site uses the vocabulary below; individual pages do not invent their own.

| Chinese | English | Meaning |
|---|---|---|
| 桌面客户端 | desktop client | The Electron application — the layer employees face every day |
| 本地 Harness 服务 | local Harness service | The pinned upstream DSH runtime started by the client, listening only on `127.0.0.1` |
| 企业服务端 | enterprise server | The Go + PostgreSQL + Caddy container image |
| 管理后台 | admin console | The webadmin embedded in the server, at `/admin/` |
| 门户页 | portal | The server root `/`, where employees download the client |
| 能力中心 | Capability Hub | "Mine + Market" for skills and agents |
| 连接器 | connectors | The MCP connector framework |
| 定时任务 | scheduled jobs | The product's cron jobs (**not** upstream Schedule reminders) |
| 内置浏览器 | built-in browser | The separate browser window an Agent can drive |
| 应用中心 | app centre | Employee-built WASM apps |
| 渠道内容 | channel content | Branding and copy injected into the image at build time |

## What the product supports today

| Capability | Shape |
|---|---|
| Platforms | Windows x64 (NSIS installer), macOS Apple silicon (DMG), Linux x64 (AppImage) |
| Deployment | Containerised on the customer network (Caddy + server + postgres), or merged into an existing reverse proxy, or a single binary plus external PostgreSQL; air-gapped deployment supported |
| Client sign-in | Local accounts / LDAP / OIDC (browser authorization) as configured on the server; administrators may enable two-step verification (TOTP) |
| Sessions and tools | A session is bound to a workspace; three permission tiers (read-only / workspace-write / full access); writing files, running commands, and driving the browser are approved per call |
| Sandbox | Landlock on Linux, directory ACLs on Windows, Seatbelt on macOS |
| Capability distribution | Capability Hub: skills and agents, sourced from Market / Org / Local; uploads go through an approval + authorization "two-gate" model |
| External systems | Connectors: one standard MCP config (`type` + `url`, or `command`/`args`/`env`), OAuth authorization code + PKCE, automatic token renewal |
| Automation | Scheduled jobs: cron + prompt + workspace + agent preset + permissions, with execution history; triggers missed while the app is fully exited are skipped by default |
| Agent browser | Separate browser window, multiple tabs, control handed over by an explicit button, 100MB default download cap, operation log |
| Voice input | Recognition in a local subprocess (audio never leaves the machine, works offline), zh/en/ja/ko/yue auto-detected, capped at 120 seconds / 4MiB |
| Memory | Five tracks (user profile / global facts / project key memory / project log / daily log), written only after confirmation |
| Employee-built apps | App centre: WASM apps open in a separate client window; **the server needs no public entry point or certificate for them** |
| Client updates | Exactly one update source: the server the client signed in to; first check 60 seconds after launch, then every 6 hours; SHA-256 verified |
| Bundled runtimes | Node.js 24 / pnpm 11 / CPython 3.12 ship with the client and affect only subprocesses the app spawns |
| Channel white-labelling | Name, tagline, welcome copy, logo, accent colour, data root, and deep-link scheme are injected into the image at build time |

## What the product does not support (boundaries)

These are deliberate boundaries rather than "coming later"; they are listed here so you can judge feasibility before deploying.

| Boundary | What it means concretely |
|---|---|
| No hosted cloud edition | The product is not a SaaS. The server runs on the customer's own machine and installers ship inside the image, not through any image registry |
| The client never talks to a model vendor directly | Model catalogue, prices, and availability come from the server, and upstream keys live only there; the client has no local model configuration |
| No Linux deb on the enterprise delivery surface | Linux ships as an AppImage (a deb is only produced by local builds) |
| macOS is Apple silicon only | Only an arm64 DMG is produced; there is no Intel build |
| Windows and Linux installers are unsigned | macOS release builds are signed + notarized; Windows SmartScreen may warn about an "unknown publisher", so verify with `SHA256SUMS` |
| No silent restart-and-install | Checking and downloading happen silently in the background, but **installation is always triggered by the user** (Windows wizard / drag into Applications on macOS / manual replacement on Linux) |
| No system proxy by default | System proxy settings, proxy environment variables, PAC files, and launch flags are all ignored; only a channel field or a real process environment variable opens the escape hatch |
| A fixed `desktop` profile with no switcher | No profile selector and no terminal entry point; `dsh plugin --profile desktop …` is rejected by the CLI; third-party plugins go through the user patch layer and need a restart |
| No MFA for employees | Two-step verification (TOTP) protects admin console sign-in only; employee sign-in follows the local / LDAP / OIDC method configured on the server |
| Apps never face the public internet | Apps open only inside a client window: there is no app address a browser can reach, and no app subdomain or wildcard certificate |
| Memory and content writes do not take effect immediately | Writes that would change AI behaviour or become visible to others first enter a pending-confirmation / pending-approval queue |
| Branding is not edited in the admin console | Name, tagline, welcome copy, logo, and accent colour come from channel content injected at build time; changing the brand means rebuilding that channel's image |

## Upstream version

The upstream DeepSeek Harness runs **unchanged at a fixed version** (currently pinned at `dsh-v0.2.0-rc.2`; the source of truth is `upstream.json` at the repository root). There is no whole-tree fork — only a small set of patches, each with its own guard — and upgrades follow the upstream version number. Trade-offs and costs are in [Product Philosophy](/en/philosophy/).

## Related

- [Getting Started](/en/getting-started/) — from installer to first message
- [Product Philosophy](/en/philosophy/) — every design principle with its evidence in the repository
- [Desktop Client](/en/desktop/) — every surface an employee uses
- [Enterprise control plane](/en/admin/) — what administrators can do in the admin console
- [FAQ](/en/faq/) — questions and boundaries by topic
