---
title: Product Philosophy
description: 'Understand the design and operating principles behind PicoAide Harness: everything is a plugin, local-first, enterprise boundaries, the capability distribution trust model, confirmation-first, and AI guardrails.'
---

PicoAide Harness is not "a piece of software with lots of features" — it is the implementation of a **design philosophy with clear boundaries**. Once you understand the principles below, you can predict why almost every feature in the product looks the way it does.

## 0. What problem we solve

DeepSeek Harness's core is a composable agent harness. It works well from the command line and through the Web UI, and it lets developers combine models, tools, sessions, and workflows into their own runtime. For many users, though, the first run still means Node.js, profiles, dependency installation, ports, and process lifecycle.

PicoAide Harness does not aim to re-implement Harness; it puts the same runtime into an application that is easy to launch, easy to manage, and fits operating-system habits:

- The installer provides Electron, the Node runtime, and pinned DSH dependencies;
- The application owns the window, tray, single-instance lifecycle, quit, and local-service lifecycle;
- Users still use the official DSH profiles, plugins, sessions, and Web UI;
- Upstream Harness keeps owning the core semantics of agents, models, tools, sessions, and the Web client.

So PicoAide Harness is a **product entry point and runtime adapter layer** — not a replacement for the upstream project, and not a long-term fork of copied upstream source.

## 1. Everything is a plugin: the desktop itself is a plugin

This is the first principle of the entire product line.

DeepSeek Harness's core is a composable agent harness: agents, models, tools, sessions, and the Web UI are all composed through the Cordis plugin mechanism. Instead of rewriting from scratch, PicoAide Harness **treats the entire product as a plugin** too — the desktop shell (window, tray, updates, the fixed `desktop` profile) is itself a legitimate DSH plugin that runs through the same composition path as third-party plugins:

- The upstream DeepSeek Harness runs **unchanged at a fixed version** (currently pinned at `0.1.1-rc.2`); no product capability modifies the upstream source;
- Plugins from the official ecosystem can be installed and used directly;
- Our own business capabilities (Capability Hub, connectors, scheduled jobs, browser, enterprise login) are combined **on equal footing** with third-party plugins — they inject interfaces through the same slot mechanism and provide capabilities through the same service contract;
- Upgrades only follow the upstream version number and do not break local extensions.

**Operating principle: capabilities can be replaced, boundaries cannot be breached.** The public interfaces are explicit contracts (slots, services, subpath exports); private internals (window, tray, packager internals) are not opened to third parties. A stable boundary is easier to upgrade and debug than "everything can be accessed."

## 2. Local-first: data stays on your machine

By default the product keeps all sensitive data on your machine and makes "staying local" a trustworthy default:

- All profiles, sessions, settings, and credentials live under the product's own directory `~/.picoaide-harness` (with the `DSH_HOME` environment variable taking precedence), defined by a single authoritative source (`desktop-home`), eliminating drift from duplicated copies;
- The platform checks whether `DSH_HOME` falls inside critical system directories — **refusing to write session tokens where an attacker on the same machine could read them** (containing the local injection surface);
- Connector credentials are written **atomically** with `0600/0700` permissions (temp file + rename), guarding against symlinks, path escape, and oversized reads;
- Signing out triggers a `session-changed` event, and connector, browser, and scheduled-job sessions and tokens are **all cleared**, leaving nothing behind.

**Operating principle: local by default, sharing must be explicit.** Connector authorization, enterprise login, and cloud model calls are all actions explicitly initiated by a user or administrator; the product never quietly sends your local data elsewhere.

## 3. Enterprise capability boundaries: experience on the client, governance on the server

The desktop client owns the "experience" while the Go server owns "governance", dividing work through a clear protocol:

- **Server**: accounts (local / LDAP / OIDC), model gateway proxy, rate limiting, quotas, metering & billing, department budgets, skill and agent market, approvals, audit — every capability that "can be abused" lives on the server;
- **Client**: chat, workspaces, Capability Hub, connectors, scheduled jobs, browser — every "personal-facing" experience lives on the client;
- **Multi-user isolation is the default, not a feature**: connector credentials are stored per user scope, browser sessions are isolated per account, and scheduled jobs are isolated per account; the server issues Bearer tokens per user (hashed at rest, 90-day expiry, automatically revoked on password change / permission downgrade / disable).

**Operating principle: any decision that can be folded back to the server must never be self-certified on the client.** The client only displays the quotas, balance, and permission results the server provides (such as `429 QUOTA_EXCEEDED`); it grants no local exemptions.

## 4. Capability distribution: content type × source, dimensions always orthogonal

The product once had three parallel entry points — "Skill Store / Shared Skill Library / Shared Agent" — leading users to think "market skills" and "shared skills" were two ways of selling the same thing. In fact, the truly orthogonal dimensions are two:

| Dimension | Values |
|---|---|
| **Content type** | Skill (SKILL.md bundle) / Agent (agent preset bundle) |
| **Source** | Market (authorization model) / Org (approval + authorization two-gate model) / Local (your own creations) |

So the client has been unified behind a single **Capability Hub** entry point: the top tabs are only "Mine / Market", and the type filter (Skills/Agents), source badges (Market/Org/Local), and status badges (Installed / Official / Featured / In review / Rejected) are all **stacked filters**, not parallel channels.

There is also a hard rule in naming: **one vocabulary**. The word "Professional" has a single meaning across the product as a market-tier term (Free / Professional); the Org library quality markers use only "Official / Featured" — the two vocabularies never overlap.

**Operating principle: when two concepts can be expressed with one dimension, never introduce a second entry point; when dimensions are orthogonal, never use the same noun to carry two meanings.**

## 5. AI proposes, humans decide

Any write that would **actually change AI behavior** goes into a "pending confirmation queue" first and only takes effect once a user or administrator approves it:

- Memory writes (memory, todos, skill evolution) are proposed first, then confirmed;
- Scheduled jobs are created by humans (cron expression + prompt + permissions); a model can only operate through explicit tools (such as `cron_create`) within a user-visible interface;
- Developers uploading skills/agents to the Org library must be approved by an administrator before they become visible and installable;
- Browser downloads and AI browser takeover all require permission approval or a visible acceptance action.

**Operating principle: every autonomous AI action must have a "visible trace + an undoable exit."** The execution details (trigger time, start/end, result, error, corresponding session) are exactly that record.

## 6. Agents can act on the world, but with guardrails

An Agent is not just a "chat box" — it can operate the browser, call connectors, and run scheduled jobs. The guardrails are layered:

1. **Visibility**: during browser takeover the product shows an overlay page, and the operation log records every navigation, click, and download in real time;
2. **Reversibility**: browser takeover can be "stopped" at any time, multiple tabs can be closed, and scheduled jobs can be disabled/deleted;
3. **Boundaries**: downloads default to a 100MB cap, navigation policy is controlled, tools apply per session, and connector credentials are isolated per user;
4. **Audit**: critical server operations (authorization, approvals, pricing, quotas) all write audit logs, forming a complete loop with the client execution details.

## 7. Fixed advanced presentation: one integration, no switch

Desktop presentation has no user-switchable mode. The product runs the **advanced presentation** by default: it injects desktop-owned frames, layout, native materials, and drag regions without changing the upstream Web carrier. Linux has no platform-native materials (Mica/hidden-inset) and uses the standard system window frame, while keeping the same layout as macOS and Windows.

Startup-setting changes (such as the local Web port) take effect through an ordered restart, not hot-swapped in a running renderer. **Operating principle: advanced capability is the product's default shape rather than an option — the UI only shrinks and never grows cluttered between releases, and docs and screenshots must keep pace with each step of consolidation.**

## 8. Evolve rather than rewrite

The product evolves existing capabilities following "merge rather than add":

- Task board and scheduled jobs overlapped semantically → **merged into scheduled jobs** (the dsh-task plugin was removed entirely; cron actions were unified as agent actions);
- Three skill/Agent entry points → **unified into the Capability Hub**;
- CLI connectors and CLI tooling (such as dws) → **removed entirely**, replaced by two standard forms: "Skill Store (SKILL.md) + Connectors (MCP)".

**Operating principle: when two entry points serve the same thing, kill one rather than add a switch.** This ensures the product interface only shrinks, never grows more confusing, across versions; documentation and screenshots must keep up with each step of this convergence.

---

The eight principles above are not slogans but conventions you can verify line by line in the code. From the next chapter on, we'll walk through each product interface and operation within this framework.
