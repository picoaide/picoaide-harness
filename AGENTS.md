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
- **Server API contract (see `server/AGENTS.md` §7 for details):** all Go API endpoints must return JSON (`application/json`; success via `c.JSON`, failure via the `{"error":{"code","message"}}` envelope through `serverauth.WriteError` — never `c.HTML`/`c.String`/body-less responses). API routes are declared centrally in `server/internal/router` (`/api/server/*` for the admin/management surface, `/api/client/v2/*` for the client/employee surface); legacy prefixes (`/api/*`, `/v1/*`, `/v2/api/*`, `/v2/v1/*`) are removed — do not add them back. Client (enterprise) calls `/api/client/v2/*`; webadmin calls `/api/server/admin/*` and public `/api/client/v2/brand`; keep both ends in sync when adding/changing endpoints.
- **Product logo is a single authority: `/logo.svg` (repo root).** Every logo or brand mark in any form (app/tray/window icons, favicons, sidebar/hero/chat brand marks, login page art, admin console art, site/branding assets, docs, OG/social images, and any fallback/placeholder artwork) **must be derived from `logo.svg` — never invented, never hand-drawn, never a text glyph** (no `P` letters, no custom shapes, no third-party marks such as the upstream DeepSeek fish).
  - `logo.svg` = black rounded square (1254×1254, corner radius 180, fill `#000000`) with a white brace/connector mark: two braces `M 334 409 …` / `M 920 409 …`, a connector line (435→817 at y=627, width 20), and two node circles (r=65) at (435,627) and (817,627), **all enlarged 1.25× around the canvas center** via `transform="translate(627 627) scale(1.25) translate(-627 -627)"`. This 1.25× scaling is part of the approved design — keep it in every derived SVG inline or file.
  - Dark-theme/negative variants flip the tile fill to white and the mark to black (**exactly** the relationship in `site/src/assets/logo-dark.svg` relative to `logo.svg`); the geometry must stay identical.
  - All other visuals (colors, accents, gradient) must not redesign the mark. When a surface cannot use the SVG (e.g. PNG bitmaps), derive it from `logo.svg` (sharp renders from the same source; see `packages/host/desktop/scripts/generate-tray-icons.mjs`) and never rasterize a different drawing.
  - Before adding any logo asset or brand mark: resolve `git diff` and confirm it traces to `logo.svg`; if a surface cannot, it should keep the previous official mark rather than a placeholder. Do not copy logo geometry from memory, from upstream packages, or from historical versions (the old version was a text `P` on a tile; it is retired and must not reappear anywhere, including fallbacks).
- `community/fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).
- GUI end-to-end testing on a headless box: use the formal client E2E tool — `corepack yarn workspace dsh-plugin-desktop e2e:client` (`packages/host/desktop/scripts/e2e-client.mjs`). It brings up a mock gateway (`e2e-fixture-gateway.mjs`: `/api/auth/login`, `/api/config/bootstrap`, `/api/workspaces`, `/api/skills`, `/api/cron`, `/api/tasks`, `/api/models` on port 34567), launches the packaged app against Xvfb `:99` with a writable `HOME` (`HOME=/tmp/... XDG_CONFIG_HOME=... DSH_HOME=...` — `/root/.config` is read-only in the sandbox and this app ignores `--user-data-dir`, so the singleton lock fails unless HOME is redirected), drives it over CDP on `--remote-debugging-port=9223`, asserts every client surface (login, sidebar nav, connectors, skills, settings, cron panel, task board, chat input, advanced mode, workspace picker, account page), captures screenshots to `packages/host/desktop/.e2e-shots/`, and writes `packages/host/desktop/.e2e-report.md` (13 assertions; non-zero exit on failure, CI-able). It reuses an already-running CDP app instead of spawning a second instance. Manual CDP driving is still possible: `fetch('http://127.0.0.1:9223/json/list')` for the page target, WebSocket `Runtime.evaluate`. Kill app processes with `pkill -9 -f "dist/linux-unpacked/[d]sh-plugin-desktop"` (bracket trick — plain `pkill -f electron` matches the invoking shell and hangs it).
