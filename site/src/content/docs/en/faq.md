---
title: FAQ
description: 'Frequently asked questions about PicoAide Harness: its relationship with DeepSeek Harness, where data lives, the CLI architecture evolution, signing and update security, and more.'
---

## What is the relationship between PicoAide Harness and DeepSeek Harness?

PicoAide Harness is built on a fixed version of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (currently pinned at `0.1.2-rc.1`). Upstream provides the core agent, plugin system, and Web UI; this project provides the desktop packaging, local service management, and enterprise-grade console. **The upstream source runs unchanged, without modifications** — upgrades only follow the version number and don't break local extensions.

## Is this an official DeepSeek product?

No. PicoAide Harness is an independent open-source community project (MIT License), with no affiliation to or endorsement from DeepSeek. DeepSeek is a trademark of DeepSeek AI.

## Where is my data stored?

By default everything is on your machine: all profiles, sessions, settings, and connector credentials live under `~/.picoaide-harness` (with the `DSH_HOME` environment variable taking precedence). Credentials are written atomically with `0600/0700` permissions, guarding against symlinks and path escape. **Whether content is sent externally depends on the model or tool provider you configure** — when using a cloud model, the corresponding requests are still sent to that provider.

## Do I need to install Node.js, pnpm, or DSH?

No. The installer already bundles Electron, Node.js, pnpm, and a pinned set of DSH dependencies. Ordinary users can download, install, and launch it directly; the app does not modify the system-wide PATH or shell config.

## Does the first launch download a runtime?

No separate Node.js or Harness core download is required. The installer is larger precisely because the runtime and pinned dependencies are already inside, trading download size for a more deterministic first launch and version set. Cloud models, update checks, and new-version downloads still need network access.

## Which operating systems are supported?

Windows x64 (NSIS installer), macOS (Apple silicon / arm64, DMG), and Linux x64 (AppImage).
The enterprise delivery surface does not include the Linux deb (the deb is only produced by local builds).

## Why are the installers unsigned?

The Windows installer and the Linux AppImage are **not yet signed** (official macOS releases are signed + notarized).
Windows SmartScreen may warn about an "unknown publisher" — when asking your administrator for the installer, verify the SHA-256 digest at the same time before running it.

## How does the app update?

**The update source is the server the client signs in to** (`GET /api/client/v2/updates/manifest`): the first check runs 60 seconds after launch and then once every 6 hours; you can also check manually from the tray and from Settings → About. The SHA-256 in the manifest is verified while streaming the download, and a failed check means no install; a failed download/install does not break the current version. **So the correct way to upgrade clients is to upgrade the server** — after the server is upgraded, the client packages automatically follow, with no action needed on the employee side. When not connected to a server, the client performs no outbound update checks.

Upgrade method: Windows uses the installer, macOS opens the DMG and installs over the existing app, and on Linux the AppImage is replaced by the user once the download finishes (AppImage has no silent self-install).

## Why are there only two connectors?

The product follows two standard forms — "Skills + MCP" (the final architecture as of 2026-08-26): **vendor CLI capabilities are distributed as SKILL.md via the Skill Store, and MCP capabilities go through the connector framework**. The early CLI connectors (vendor CLIs such as DingTalk, Feishu, WeCom, Beisen) were removed entirely; the built-in MCP connectors are now **Xiaoshouyi NeoCRM** and **Moka HR Agent**. Connector definitions are extensible, and third parties can register their own MCP def.

## Why was CLI tooling removed?

The "CLI as skill" approach (which auto-installed commands like dws/wecom-cli) had cross-platform distribution, security, and operational complexity problems. The change: vendor capabilities are distributed as **SKILL.md uploaded to the Skill Store → approval → authorization**, and the model reads the skill and follows its guidance; MCP-type capabilities go through connectors. Both standard forms are auditable, approvable, and uninstallable.

## Where did the task board go?

The task board and scheduled jobs overlapped semantically, and it was **merged into scheduled jobs in v2.3.0** (the dsh-task plugin was removed entirely). The scheduled-jobs center now handles it all: cron expression + prompt + workspace + agent preset + permissions, with execution details (session/result/error) always available, plus manual run-now and session jump.

## Can I install DSH plugins?

Yes. From a system shell, run `dsh plugin --profile desktop add <plugin>` / `remove` / `update` (the app runs the fixed desktop profile, with no terminal/Profile-switch tray entry); specify one explicitly with `--profile <name>`. The app must be restarted after plugin changes.

## Do the Desktop profile and an existing web profile sync automatically?

The app runs the fixed `desktop` profile; there is no `web` profile default and no switcher.

## Where do I download and report issues?

Client installers **ship with the server image** and are not posted on a standalone download site:

- Enterprise employees: download from your enterprise server's portal page (`https://<enterprise-domain>/`), or simply ask your administrator;
- Want to try it first: fetch the official image package and export the `client/` directory to get the installers for all three platforms — see [Getting Started](/en/getting-started/).

For how to deploy and upgrade the server, see [Private Deployment](/en/deployment/). If you run into a problem, first read the troubleshooting section of [Desktop Client](/en/desktop/); if it's still unresolved, file a [GitHub Issue](https://github.com/picoaide/picoaide-harness/issues) and include your OS, app version, reproduction steps, and error messages.
