# PicoAide Harness repository rules

## 铁律 0（最高优先级）：渠道与客户身份**永不进本仓**

**本仓是公开仓**（GitHub `picoaide/picoaide-harness`）。渠道 / 客户身份属**私有仓** `picoaide/channels`，
本仓只保留占位符。

**禁止出现**（任何位置、任何形态）：

- 渠道 id、渠道显示名 / 短名 / 产品名、客户或 OEM 品牌名（含其中英文写法、拼音、缩写）；
- 客户自有或被投递环境的**真实域名、主机名、IP、目录名、容器名、镜像 tag、`.env` 取值**；
- 上面的名字出现在**示例、夹具、断言、注释、脚本默认值、文档正文、表格、代码块、URL** 里。

**这一条同样适用于 git 提交信息（subject 与 body）与 GitHub 的 PR / Release 文案** ——
提交信息是公开且可检索的，泄露面与文件正文完全相同。写提交信息时用中性表述：
「某客户渠道」「第二个渠道栈」「渠道 A」；需要具体身份时指向私有仓，不写名字。

**唯一允许的写法**：占位符（`harness.example.com`）、环境变量（`{$DOMAIN}`、`REAL_SERVER`）、
角色化表述（「品牌渠道」「客户渠道」「同机第二栈」）。

**自检（改任何含渠道/域名/URL 的文件或写提交信息之前，先跑）**：

```bash
node scripts/check-no-real-domains.mjs          # 域名/主机名判据（白名单式，未登记即失败）
git log -1 --format=%B | grep -inE '<渠道名1>|<渠道名2>'   # 提交信息自查（渠道名清单见私有仓）
```

**为什么放在第 0 条**：这条一旦违反，泄露是不可逆的（公开仓的提交历史会被镜像与索引，
清理需要改写历史 + 强推 + 通知所有克隆）。代价 >> 任何功能收益，所以它是所有规则里唯一
"**先问再写**"的一条：**拿不准某个名字算不算渠道身份时，按"算"处理**。


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
- Run the complete headless gate with `corepack yarn check`（2026-09-10 重构为 `scripts/check-workspaces.mjs`：**受构建依赖约束的并行编排**，不再是 10 个包串行 `&&`——阶段 1 跑 `dsh-plugin-desktop check` + 三个根守卫，阶段 2 按依赖图调度其余包：`enterprise`/`connectors`/`cron` 的 tsc 依赖 desktop 的 `lib/types`，`account-card` 依赖 `enterprise`（其 tsdown `clean:true` 会清 `lib/`，并发读取会踩空 → 必须串行），`browser` 依赖 `connectors`；依赖失败的包直接跳过并说明原因，不产生级联噪音。并发默认 `min(4, CPU)`，`CHECK_CONCURRENCY` 可覆盖。`yarn check:fast` = 只跑本次改动影响的包（`git status`/`git diff` 映射到包，顶层文件改动自动升格为全量）。本地 `yarn check` 与 CI gate job 完全同义。`yarn prebuild` = `prebuildWorkspaceDeps` 一键构建全部 8 个 workspace 包，**已增量**：某包产物不早于其输入（`src/`、包配置、依赖包产物）即跳过重建，`DSH_PREBUILD=force` 强制全量。门禁提速实测与设计见 docs/decisions/2026-09-10-verification-speedup.md）。
- Run the client E2E automation with `corepack yarn workspace dsh-plugin-desktop e2e:client` (see GUI E2E below; works against a packaged build and Xvfb, produces `.e2e-report.md` + `.e2e-shots/`). Real-service verification uses `e2e:real` (`REAL_SERVER/REAL_USER/REAL_PASS` env; produces `.real-env-report.md` + `.real-env-shots/`). Two focused behavioural probes cover surfaces `e2e:client` only asserts structurally, both against a packaged build + Xvfb + the same mock gateway: `e2e:sidebar`（官方右侧栏：展开/面板渲染/分栏/标题栏保留带，`.e2e-sidebar/`）与 `e2e:terminal`（0.1.6 新增的终端：点「新建终端」→ xterm 表面 → 真敲 `echo` 断言回显，`.e2e-terminal/`）。两者都不在 `yarn check` 内（需要打包产物与显示器），改动右栏/终端后手动跑。
- Run upstream operations through the root scripts, such as `corepack yarn upstream:build`.

### CI (2026-09-06 重设计，见 docs/decisions/2026-09-06-ci-pipeline-redesign.md)

- 触发 = `pull_request` + `push`（全分支含 tag）。**每个提交都产出可下载产物**（Artifacts）：`desktop-Linux`（AppImage+deb）、`desktop-Windows-installer`（NSIS）、`desktop-macOS`（DMG）、`picoaide-server-linux-amd64`；PR 由 `pr-summary` job 评论汇总入口（fork PR 跳过）。
- **镜像分发（2026-09-10 起）**：不经任何镜像仓库（GHCR 已下线，`docker.yml`/`ghcr-cleanup.yml` 已删）。tag 时 `release` job 从源码构建镜像（打进三平台客户端资产 + 私有渠道仓的渠道内容）→ `docker save | zip` 成 `picoaide-server-<v>-amd64.zip` → **同一个 job 内**先上传更新服务器 R2（`scripts/ci-publish-update-server.sh`，写 `release.picoaide.com/<channel>/releases/<v>/` 并清理到最近 3 个版本；`publish-update-server` 是 job 里的**一步**，不是独立 job）→ 再挂 GitHub Release（**只对 beta/official**，品牌渠道不公开）。客户侧只从 R2 自己的渠道目录取镜像。上传后对**三个对象**（镜像 zip、`SHA256SUMS`、`latest.json` 指针）逐个做"大小 + SHA256"完整性对拍，任一不符即失败且不写指针；判据在 `scripts/verify-ci-scripts.mjs`（假 aws 支持按对象名注入故障）。
- job 结构：`changes`（docs-only 分类器）→ `gate-guards`（**永不跳过**的根守卫 job：docs-only 的 PR 也跑 `scripts/check-root-guards.mjs`）∥ `gate`（ubuntu：`yarn check` 全量门禁 + 一次构建，上传 `workspace-build` = 8 包 `lib/**` + desktop `build/**`；tag 上还跑 tag 形态 / 基线拓扑 / 渠道仓 pin 三条判据与策展说明检查）→ `server`（并行：PG 18 容器 + gofmt + go vet + `go test -p 1` + webadmin `npm test` + `make build-server`）→ `desktop-linux/win/macos`（`needs: gate`，下载 `workspace-build` 恢复后**只做打包 + 平台验证**，其中 linux 追加 `e2e:client`）→ tag 时 `release`（needs `gate` + 三个 desktop job：构建各渠道镜像 → 导出 zip → 上传 R2 → `gh release create`）。
- **发布面硬规则（2026-09-11 定案，2026-09-23 更新口径）**：Release **名 = tag 本身**（`PicoAide Harness v…` 前缀会被 Releases 页左侧列表截断成 `…v2.6…`，同页版本号全不可见）；**正式 tag 与预发 tag 都必须**有策展发布说明 `docs/releases/<tag>.md` —— 三道同口径的检查（`gate` 第一步 / `release` job 首步 / `gh release create` 之前），缺失即失败，**`--generate-notes` 回退已删除**（自动变更日志的正文来自提交信息与 PR 标题/正文，那两处不在 `check-no-real-domains` 的判据面内，历史上正是这条路径把真实域名/IP 带进了公开 Release 正文）。模板与写作口径 `docs/releases/TEMPLATE.md`。tag 发布链另有三条判据：tag 形态唯一真源 `scripts/ci-release-policy.sh`（未知后缀当场红）、基线拓扑 `scripts/ci-release-topology.sh`（上一个 tag 不在主线即红）、渠道仓检出 pin（`gate` 解析一次 `channels_rev`，四个调用点以 `CI_CHANNELS_PIN` 复用并硬校验）。
- 打包脚本开关（消除重复编译）：`--no-prebuild`（跳过 `prebuildWorkspaceDeps` 8 包构建）、`--no-gates`（跳过入口内嵌 check：win `check:win-package` / mac smoke 根 check / mac release pack 内根 check）。默认（本地 `yarn dist:*`）= prebuild + 内嵌 check + 打包 + 验证，行为不变。打包后的平台验证（`verify-win-installer` / `verify-mac-smoke` / `verify-mac-release` / `afterPack`）**不在跳过范围**。
- `check:win-package` 是「构建后」平台检查（不含 build；产物由 prebuild 或 CI gate 提供）。

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- The outer repository is product-owned and independent of the former `anywhere-labs/dsh-desktop` (previously `anywhere-labs/deepseek-harness-desktop`) upstream: no `upstream` remote exists and no whole-tree merges are performed. Valuable upstream fixes are cherry-picked by commit when needed. Only the `deepseek-harness/` submodule pin is followed as an upstream sync.
- `packages/host/desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- On the enterprise feature branch, feature work must only edit `packages/host/enterprise/` and `server/`. No changes to other service packages or to `deepseek-harness/`; test adaptations in desktop-owned scripts are allowed. Product branding (productName, icons, window/notification copy) is desktop-owned and may be touched for brand changes, injected through profile composition config where possible.
- **Server API contract (see `server/AGENTS.md` §7 for details):** all Go API endpoints must return JSON (`application/json`; success via `c.JSON`, failure via the `{"error":{"code","message"}}` envelope through `serverauth.WriteError` — never `c.HTML`/`c.String`/body-less responses). API routes are declared centrally in `server/internal/router` (`/api/server/*` for the admin/management surface, `/api/client/v2/*` for the client/employee surface); legacy prefixes (`/api/*`, `/v1/*`, `/v2/api/*`, `/v2/v1/*`) are removed — do not add them back. Client (enterprise) calls `/api/client/v2/*`; webadmin calls `/api/server/admin/*` and public `/api/client/v2/channel`; keep both ends in sync when adding/changing endpoints.
- **Brand mark assets are a single authority: the `brands/official/` folder** (channel-scoped folders live at `brands/<channel-id>/`). 2026-09-10 起**对外文案与渠道差异不再来自代码或 webadmin，而来自私有仓 `picoaide/channels` 的渠道配置**（`channels/<channel-id>/channel.json`：名称/标语/欢迎语/主题色 + logo 素材；构建时注入镜像）。`brands/official/logo.svg` 仍是**几何真源**：渠道目录里的 logo 必须由它派生（CI 复制），本文件下述几何规则对所有渠道同样适用。 Every logo or brand mark in any form (app/tray/window icons, favicons, sidebar/hero/chat brand marks, login page art, admin console art, site/branding assets, docs, OG/social images, and any fallback/placeholder artwork) **must be derived from `brands/official/logo.svg` — never invented, never hand-drawn, never a text glyph** (no `P` letters, no custom shapes, no third-party marks such as the upstream DeepSeek fish).
  - `brands/official/logo.svg` = black rounded square (1254×1254, corner radius 180, fill `#000000`) with a white brace/connector mark: two braces `M 334 409 …` / `M 920 409 …`, a connector line (435→817 at y=627, width 20), and two node circles (r=65) at (435,627) and (817,627), **all enlarged 1.25× around the canvas center** via `transform="translate(627 627) scale(1.25) translate(-627 -627)"`. This 1.25× scaling is part of the approved design — keep it in every derived SVG inline or file.
  - The pair is **mandatory dual-color**: `brands/official/logo-dark.svg` flips the tile fill to white and the mark to black (**exactly** the relationship of `brands/official/logo-dark.svg` relative to `logo.svg`); the geometry must stay identical. Light/daily surfaces use `logo.svg`; dark/night surfaces use `logo-dark.svg` — never invent a third chromatic variant.
  - All other visuals (colors, accents, gradient) must not redesign the mark. When a surface cannot use the SVG (e.g. PNG bitmaps), derive it from the brand folder (sharp renders from the same source; see `packages/host/desktop/scripts/generate-tray-icons.mjs` and `packages/host/desktop/scripts/brand-prepare.mjs`) and never rasterize a different drawing.
  - Before adding any logo asset or brand mark: resolve `git diff` and confirm it traces to `brands/official/logo.svg`; if a surface cannot, it should keep the previous official mark rather than a placeholder. Do not copy logo geometry from memory, from upstream packages, or from historical versions (the old version was a text `P` on a tile; it is retired and must not reappear anywhere, including fallbacks).
- **Real customer / deployment domains and hostnames must never appear in this repository**（客户自有域名、被投递/测试环境的真实主机名；示例写法一律用保留命名空间 `*.example.com`）。本仓**公开**（GitHub `picoaide/picoaide-harness`），真实域名会同时暴露客户身份与其基础设施命名。
  - 禁止位置：文档与设计/规划稿（含代码块、JSON 示例、`server_url` 字段、部署示例）、测试夹具与断言、脚本默认值、注释。
  - 允许写法：占位符域名（`harness.example.com`）、环境变量（`{$DOMAIN}`、`REAL_SERVER`）。脚本若需默认值，留空或指向 `example.com`，让调用方必须显式传入。
  - 渠道/客户身份属于**私有仓** `picoaide/channels`；本仓只保留占位符。真实域名只允许出现在部署机上的 `.env` 与运维脚本，不进版本库。
  - 自检口径：改动含域名/URL 的文件后跑 `node scripts/check-no-real-domains.mjs`（白名单式前向守卫：URL host / 裸主机名 / 提交信息三个判据，未登记的 host 一律失败）必须为空；**提交信息同样适用**（提交信息也是公开的）。
- `community/fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).
- GUI end-to-end testing on a headless box: use the formal client E2E tool — `corepack yarn workspace dsh-plugin-desktop e2e:client` (`packages/host/desktop/scripts/e2e-client.mjs`). It brings up a mock gateway (`e2e-fixture-gateway.mjs`, port 34567 — real route table, verified 2026-09-08: `/api/client/v2/auth/login|methods|me|usage`, `/api/client/v2/config/bootstrap`, `/api/client/v2/agent-presets`, `/api/client/v2/shared-skills`, any `/api/*skill*`, `/api/workspaces|workspace|pico/workspaces`, `/api/sessions*`|`/api/conversations`, `/api/cron|jobs`, `/api/admin*|pico*`, other `/api/*` → `{ok:true}` fallback; there is no `/api/tasks` or `/api/models` branch), launches the packaged app against Xvfb `:99` with a writable `HOME` (`HOME=/tmp/... XDG_CONFIG_HOME=... DSH_HOME=...` — `/root/.config` is read-only in the sandbox and this app ignores `--user-data-dir`, so the singleton lock fails unless HOME is redirected), drives it over CDP on `--remote-debugging-port=9223`, asserts every client surface (login, sidebar nav, connectors, skills, settings, cron panel, task board, chat input, advanced mode, workspace picker, account page), captures screenshots to `packages/host/desktop/.e2e-shots/`, and writes `packages/host/desktop/.e2e-report.md` (25 assertions, 含「错误监控链路真实激活（客户端 → GlitchTip 兼容摄取端点）」—— 断言 mock 网关的 Sentry 摄取账本计数严格大于登录前基线，`error_reporting_enabled` 关掉即红 —— 与「渲染进程未捕获错误真实进链路」—— 在页面主世界真抛一个未捕获错误，断言摄取账本里出现带 `picoaide.process=renderer` tag 且消息含本次一次性 marker 的事件（监听装错世界即红）；非零 exit on failure, CI-able). It reuses an already-running CDP app instead of spawning a second instance. Manual CDP driving is still possible: `fetch('http://127.0.0.1:9223/json/list')` for the page target, WebSocket `Runtime.evaluate`. Kill app processes with `pkill -9 -f "dist/linux-unpacked/[d]sh-plugin-desktop"` (bracket trick — plain `pkill -f electron` matches the invoking shell and hangs it).
