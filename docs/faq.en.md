# PicoAide Harness FAQ

[中文](faq.md)

This page answers common questions about installation, supported platforms, the bundled runtime, and plugins in the current stable release. The [latest GitHub Release](https://github.com/picoaide/picoaide-harness/releases/latest) and [user guide](user-guide.en.md) define the shipped product scope.

## What is PicoAide Harness?

PicoAide Harness is an open-source DeepSeek Harness desktop client for Windows, macOS, and Linux. It packages the official Harness local Web UI, Host service, and plugin system into a native desktop application with a window, system tray, updates, and enterprise-grade administration.

## Is this an official DeepSeek product?

No. PicoAide Harness is an independent, community-maintained open-source project. It is not affiliated with or endorsed by DeepSeek. The name only describes its technical relationship with the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Which operating systems are supported?

Current release installers support Windows x64, macOS (universal DMG, both Apple Silicon and Intel), and Linux x64 (AppImage + deb). The desktop shell is fixed to the advanced presentation; Linux uses the standard system window frame (no platform-native Mica or hidden-inset chrome) while keeping the same advanced layout as macOS and Windows.

## Do I need to install Node.js, pnpm, or DSH?

No. The installer includes Electron, Node.js, pnpm, and pinned DSH dependencies. Ordinary users can install and launch directly, and Desktop does not modify the global system PATH or user shell configuration.

## Does the first launch download a runtime?

No separate Node.js or Harness core download is required. The installer is larger because it contains the runtime and pinned dependencies, trading download size for a more deterministic first launch and dependency set. Cloud models, update checks, and new-version downloads still require network access.

## Does PicoAide Harness modify official Harness?

No. The repository pins an unmodified official Harness checkout. The desktop shell adds Desktop-owned layout and native window presentation through plugins (fixed advanced presentation), without editing upstream source.

## Is data stored locally?

The Desktop Host, profiles, and DSH home live on the local machine. Whether content is sent to an external service depends on the model or tool providers the user configures; requests to cloud models still go to those providers.

## Can I install DSH plugins?

Yes. PicoAide Harness uses the official Harness plugin system. Run `dsh plugin --profile desktop add`, `remove`, or `update` from a system shell (the application runs the fixed `desktop` profile); restart Desktop after plugin changes.

## Does the Desktop profile automatically sync with an existing web profile?

No. The application runs a single fixed `desktop` profile; there is no `web` default and no profile switcher. Each profile has its own bundle and dependency composition; `dsh plugin --profile <name>` always selects one explicitly.

## How are updates installed?

Packaged applications check for stable releases in the background but never install silently. A newer version requires confirmation. macOS downloads and opens a DMG; Windows downloads and starts an NSIS installer (Linux launches do not download installers — AppImage/deb come from the release page). Network and download failures leave the current installation intact.

## Where can I download the app or report a problem?

Download from the [latest GitHub Release](https://github.com/picoaide/picoaide-harness/releases/latest). Check the [troubleshooting section](user-guide.en.md#troubleshooting) first. If the problem remains, open a [GitHub Issue](https://github.com/picoaide/picoaide-harness/issues/new/choose) with the operating system, app version, reproduction steps, and error details.
