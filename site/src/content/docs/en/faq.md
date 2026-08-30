---
title: FAQ
description: 'Frequently asked questions about PicoAide Harness: its relationship with DeepSeek Harness, where data lives, the CLI architecture evolution, signing and update security, and more.'
---

## What is the relationship between PicoAide Harness and DeepSeek Harness?

PicoAide Harness is built on a fixed version of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (currently pinned at `0.1.1-rc.2`). Upstream provides the core agent, plugin system, and Web UI; this project provides the desktop packaging, local service management, and enterprise-grade console. **The upstream source runs unchanged, without modifications** — upgrades only follow the version number and don't break local extensions.

## Is this an official DeepSeek product?

No. PicoAide Harness is an independent open-source community project (MIT License), with no affiliation to or endorsement from DeepSeek. DeepSeek is a trademark of DeepSeek AI.

## Where is my data stored?

By default everything is on your machine: all profiles, sessions, settings, and connector credentials live under `~/.picoaide-harness` (with the `DSH_HOME` environment variable taking precedence). Credentials are written atomically with `0600/0700` permissions, guarding against symlinks and path escape. **Whether content is sent externally depends on the model or tool provider you configure** — when using a cloud model, the corresponding requests are still sent to that provider.

## Do I need to install Node.js, pnpm, or DSH?

No. The installer already bundles Electron, Node.js, pnpm, and a pinned set of DSH dependencies. Ordinary users can download, install, and launch it directly; the app does not modify the system-wide PATH or shell config (the `dsh`/`pnpm`/`node` inside a terminal are private shims that only apply to that terminal process).

## Which operating systems are supported?

Windows x64, macOS (universal DMG, compatible with Apple silicon and Intel), and Linux x64 (AppImage + deb).

## Why are the installers unsigned?

The CI-published Windows and Linux installers are **not yet signed** (the official macOS release is signed/notarized). Windows SmartScreen may warn about an "unknown publisher" — download `SHA256SUMS.txt` from Releases and verify it before running; the same applies on Linux.

## How does the app update?

In the background it checks GitHub Releases (`releases/latest`); when a new version is found it asks for confirmation before downloading. It downloads the installer and verifies the **SHA-256 digest** (tolerating a `./` prefix), and refuses to install on a failed check. A failed download/install does not break the current version. There is an upgrade badge at the top right of the session header, and the tray menu mirrors the update status.

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

Download installers from [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases/latest). If you run into a problem, first read the troubleshooting section of [Desktop Client](./desktop); if it's still unresolved, file a [GitHub Issue](https://github.com/picoaide/picoaide-harness/issues) and include your OS, app version, reproduction steps, and error messages.
