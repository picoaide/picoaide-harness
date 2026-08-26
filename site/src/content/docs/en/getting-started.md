---
title: Getting Started
description: 'Get started with PicoAide Harness in 10 minutes: download, first launch, sign in, and the four core entry points.'
---

## Install the client

Download the installer for your platform from [GitHub Releases](https://github.com/picoaide/picoaide-harness/releases/latest):

| Platform | How to install |
|---|---|
| Windows x64 | Run the NSIS installer (`PicoAide-Harness-<v>-x64-Setup.exe`) |
| macOS (Apple silicon) | Open the DMG and drag PicoAide Harness into Applications |
| Linux x64 | Grant execute permission and run the AppImage (`-x86_64.AppImage`); a deb is also provided |

> **Recommended before installing**: every Release ships a `SHA256SUMS.txt`. The Windows/Linux installers are published by CI automatically and are **not yet signed**; SmartScreen may warn about an "unknown publisher" — download and verify the SHA-256 digest from Releases before running.

## First launch

- First launch creates a default `desktop` profile and starts the official DSH web interface locally;
- The installer already bundles Electron, Node.js, pnpm, and a pinned set of DSH dependencies — you do **not** need to install Node.js, pnpm, or DSH separately;
- Closing the window hides to the tray by default; choose **Quit** from the tray to exit the app and stop the local service.

## Sign in

- **Enterprise (server mode)**: enter the server address and sign in with your account; accounts are created by administrators in the admin console (local / LDAP / OIDC), and quotas and credits are decided by the server;
- **Standalone mode**: use local models and capabilities without signing in;
- Signing out clears all sessions (connectors, browser, scheduled-job tokens).

## Start using it: the four core entry points

1. **New session**: choose a workspace (project directory) to start chatting; the tools a model can call are gated by permission approvals;
2. **Capability Hub**: install market skills/agents (needs administrator authorization), and review your "Mine" local creations and their upload/approval status;
3. **Scheduled jobs**: hand high-frequency work to an Agent to run automatically on schedule (cron + prompt + workspace + permissions); execution details are always available;
4. **Connectors / Browser**: authorize via OAuth to connect MCP services such as Xiaoshouyi and Moka; let the Agent take over the browser to perform actions.

## What's next

- To understand the product's design principles, read [Product Philosophy](./philosophy);
- To dive into each interface, read [Desktop Client](./desktop);
- Enterprise administrators: read [Admin Console](./admin) and [Private Deployment](./deployment).
