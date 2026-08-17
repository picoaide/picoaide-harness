# DSH Desktop repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- On the enterprise feature branch, feature work must only edit `plugins/dsh-enterprise/` and `server/`. No changes to other service packages or to `deepseek-harness/`; test adaptations in desktop-owned scripts are allowed. Product branding (productName, icons under `dsh-plugin-desktop/build/`, window/notification copy) is desktop-owned and may be touched for brand changes, injected through profile composition config where possible.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).
- GUI end-to-end testing on a headless box: drive the real Electron app over CDP. Launch `setsid env DISPLAY=:99 ./dsh-plugin-desktop/node_modules/.bin/electron --no-sandbox --remote-debugging-port=9222 dsh-plugin-desktop/lib/main.js </dev/null >/tmp/opencode/app.log 2>&1 &` against the existing `Xvfb :99`, then drive the renderer with a minimal CDP script (`fetch('http://127.0.0.1:9222/json/list')` for the page target, WebSocket `Runtime.evaluate`). Login needs a mock gateway (`/api/auth/login`, `/api/config/bootstrap`, `/api/marketplace/skills`) on a fixed port; sessions do not survive restart. Kill with `pkill -9 -f "dsh-plugin-[d]esktop/lib/main"` plus `type=[g]pu` (bracket trick — plain `pkill -f electron` matches the invoking shell and hangs it).
