# PicoAide Harness repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

## Prerequisites and setup

- Use Node.js `^22.19.0` or `>=24.0.0` and the root Yarn `4.18.0` release through Corepack.
- Initialize the pinned upstream checkout with `git submodule update --init --recursive`.
- Install root dependencies with `corepack yarn install --immutable`.

## Build, run, and verify

- Start the desktop development workflow with `corepack yarn dev`.
- Build the desktop package with `corepack yarn build`.
- Run unit tests with `corepack yarn test`.
- Run type checking with `corepack yarn typecheck`.
- Run the complete headless gate with `corepack yarn check`.
- Run the client E2E automation with `corepack yarn workspace dsh-plugin-desktop e2e:client` (see GUI E2E below; works against a packaged build and Xvfb, produces `.e2e-report.md` + `.e2e-shots/`). Real-service verification uses `e2e:real` (`REAL_SERVER/REAL_USER/REAL_PASS` env; produces `.real-env-report.md` + `.real-env-shots/`).
- Run upstream operations through the root scripts, such as `corepack yarn upstream:build`.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- The outer repository is product-owned and independent of the former `anywhere-labs/dsh-desktop` (previously `anywhere-labs/deepseek-harness-desktop`) upstream: no `upstream` remote exists and no whole-tree merges are performed. Valuable upstream fixes are cherry-picked by commit when needed. Only the `deepseek-harness/` submodule pin is followed as an upstream sync.
- `packages/host/desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- On the enterprise feature branch, feature work must only edit `packages/host/enterprise/` and `server/`. No changes to other service packages or to `deepseek-harness/`; test adaptations in desktop-owned scripts are allowed. Product branding (productName, icons under `packages/host/desktop/build/`, window/notification copy) is desktop-owned and may be touched for brand changes, injected through profile composition config where possible.
- `community/fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).
- GUI end-to-end testing on a headless box: use the formal client E2E tool — `corepack yarn workspace dsh-plugin-desktop e2e:client` (`packages/host/desktop/scripts/e2e-client.mjs`). It brings up a mock gateway (`e2e-fixture-gateway.mjs`: `/api/auth/login`, `/api/config/bootstrap`, `/api/workspaces`, `/api/skills`, `/api/cron`, `/api/tasks`, `/api/models` on port 34567), launches the packaged app against Xvfb `:99` with a writable `HOME` (`HOME=/tmp/... XDG_CONFIG_HOME=... DSH_HOME=...` — `/root/.config` is read-only in the sandbox and this app ignores `--user-data-dir`, so the singleton lock fails unless HOME is redirected), drives it over CDP on `--remote-debugging-port=9223`, asserts every client surface (login, sidebar nav, connectors, skills, settings, cron panel, task board, chat input, advanced mode, workspace picker, account page), captures screenshots to `packages/host/desktop/.e2e-shots/`, and writes `packages/host/desktop/.e2e-report.md` (13 assertions; non-zero exit on failure, CI-able). It reuses an already-running CDP app instead of spawning a second instance. Manual CDP driving is still possible: `fetch('http://127.0.0.1:9223/json/list')` for the page target, WebSocket `Runtime.evaluate`. Kill app processes with `pkill -9 -f "dist/linux-unpacked/[d]sh-plugin-desktop"` (bracket trick — plain `pkill -f electron` matches the invoking shell and hangs it).
