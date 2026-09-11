# CI 与分支整体规划说明（2026-09-06）

> ⚠️ **部分内容已被后续变更取代（2026-09-10）**：服务端镜像**不再使用任何镜像仓库**
> （GHCR 已下线，`docker.yml` 与 `ghcr-cleanup.yml` 已删除）。现在 tag 时由
> `ci.yml` 的 `release` job 构建镜像 → 导出 `picoaide-server-<v>-amd64.zip` →
> 挂 GitHub Release（只对 beta/official）→ `publish-update-server` job 上传 R2
> `release.picoaide.com/<channel>/`。下文涉及 `docker.yml`/GHCR 的描述仅作历史记录。

> 维护者视角。设计决策溯源：[CI 流程重设计](decisions/2026-09-06-ci-pipeline-redesign.md)；问题清单：[审计报告](planning/2026-09-06-ci-pipeline-audit.md)。
> 一句话总结：**主分支常绿、功能走分支 + PR、每次提交都有可下载产物、构建只做一次（gate）、平台只负责打包、发布独立于日常门禁。**

---

## 1. 分支规划

### 1.1 模型：trunk-based + 任务分支（无长命 release 分支）

```
master（唯一常绿主干，合并即发布候选）
 ├── feat/xxx        功能分支（从 master 切出，PR 合回）
 ├── fix/xxx         修复分支（同上；也可直接发 PR）
 ├── docs/xxx        文档/官网分支（同上，管理员允许时直达 master）
 └── vX.Y.Z / vX.Y.Z-rc.N / vX.Y.Z-beta.N   ← 打 tag（不是分支）
```

| 分支 | 用途 | 触发 CI | 产物 | 备注 |
|---|---|---|---|---|
| `master` | 唯一主干，始终可发布 | push 全量 | 三平台 + server | 建议开启保护：必须 PR + 门禁绿（见 §1.3） |
| `feat/*` / `fix/*` / `docs/*` | 团队协作任务分支 | push 全量（每个人每提交都有门禁与产物） | 三平台 + server | PR 合入 master；不需要长期维护 |
| `v*` 标签 | 发布 | push 全量（mac 转签名路径） | 三平台 + server + **GitHub Release** | 只从 master 打；正式=`vX.Y.Z`，预发=`v*` 带 `-rc`/`-beta` 段 |

> **预发（beta/rc）也是完整发布，不是"只构建"**：`vX.Y.Z-beta.N` / `-rc.N` 同样要求 tag，同样过全量 CI + 三平台产物，并创建 **Pre-release（Releases 页面可见，带 Pre-release 徽章、资产可下载）**。与正式版的唯一区别是「推送面」：`releases/latest` 自动排除 Pre-release，客户端升级源（update-checker 读 latest）与正式用户都不会收推；镜像侧不打 `latest`/宽版本 tag，只留具体版本。**下载与可见性不受影响，正式用户"不更新"≠"不发布"。**

### 1.2 协作流程（每个成员）

1. 从 `master` 切分支：`git checkout -b feat/<功能名>`；
2. 开发 + 提交，推到远端后 **CI 立即全量运行**：门禁（gate + server）、三平台打包、E2E；
3. 打开 PR → `pr-summary` job 自动在 PR 内评论**本次提交的四类可下载产物**（安装包 + 服务端二进制），团队任何人都能直接下载安装/部署验证——**不必自己编译**；
4. 门禁全绿 + 至少 1 人 review 后 squash/merge 回 `master`；
5. 每次 push 到该分支都会刷新产物（旧 run 的 Artifacts 仍按 runs 留存，默认 90 天）。

### 1.3 建议的保护规则（当前未开启，事实见附录 A）

- `master` 开启 Branch Protection：**要求 PR** + 必填检查 `Gate (tests + workspace build)` / `Go server` / `Desktop (Linux)` / `Desktop (Windows installer)` / `Desktop (macOS)`；拒绝直推；
- tag 推送到 `v*` 直接发布（不需要 PR），由 `release` job 校验版本一致性兜底；
- fork PR 的门禁照常跑；仅 PR 评论（`pr-summary`）与发布类 secret 不提供。

---

## 2. CI 规划

### 2.1 触发矩阵

| 事件 | 触发范围 | 行为 |
|---|---|---|
| `pull_request` | 任意目标分支 | 全量门禁 + 三平台产物 + PR 评论 |
| `push`（任意分支，含 master） | 全部分支 | 全量门禁 + 三平台产物 |
| `push tag v*` | 标签 | 上述全部 + mac 签名/公证 + GitHub Release |
| `workflow_dispatch`（docker.yml） | 手动 | 服务端镜像构建推送 GHCR（版本号入参校验） |

- 并发：同一 ref 的新运行会取消旧运行（`concurrency: ci-${{ github.ref }}`，重推 tag 互斥防双发布）；
- 无 path 过滤：改任何文件都跑全量（产物面向全团队，简单优先）。

### 2.2 Job 结构

```
┌─ gate (ubuntu) ─────────────────────────────────────────────┐
│ yarn install → yarn check（全量门禁 + 一次构建，每包只编一次）│
│ → 上传 workspace-build（8 包 lib/** + desktop build/**）      │
└─────────────────────────────────────────────────────────────┘
┌─ server (ubuntu, 与 gate 并行) ─────────────────────────────┐
│ PG18 容器(500 连接) → gofmt → go vet → go test ./... -p1    │
│ → webadmin npm test(109) → make build-server(含 webadmin)   │
│ → 部署脚本语法检查 → 上传 picoaide-server-linux-amd64        │
└─────────────────────────────────────────────────────────────┘
        needs: gate（构建产物已就绪，平台只管打包）
┌─ desktop-linux   ├─ desktop-windows   └─ desktop-macos ─────┐
│ 恢复 workspace-build → 打包(+平台验证) → 上传安装包          │
│ linux 额外: e2e:client（13 断言）→ e2e-report                │
│ mac 正式 tag: 签名(--pack) + 公证(--notarize)；否则未签名冒烟│
└─────────────────────────────────────────────────────────────┘
┌─ release (仅 tag) ── needs 四 job ──────────────────────────┐
│ 下载 desktop-* 三平台包 → tag==版本校验 → SHA256SUMS         │
│ → gh release（docs/releases/<tag>.md 优先，否则自动生成）    │
└─────────────────────────────────────────────────────────────┘
┌─ pr-summary (仅 PR, 非 fork) ───────────────────────────────┐
│ 在 PR 评论本次产物入口（Artifacts 链接），重复推送自动刷新   │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 门禁内容（谁被测试）

**客户端（前端 + 桌面）**——`gate`：

- `check:layout`（workspace 拓扑/包管理器 pin 校验）；
- `dsh-plugin-desktop check`（build + typecheck 4 份 tsconfig + **452+ 测试** + verify:closure/loader/profile/licenses 无头冒烟）；
- `dsh-better-sidebar check`（build + typecheck + consumer-types 声明面检查）；
- 六业务包 check（connectors/enterprise/account-card/branding/browser/cron：build+typecheck+test）；
- `community-fabric`（文档一致性校验）；
- `desktop-linux` 内 **E2E**（mock 网关 + Xvfb + CDP 驱动打包应用，13 项断言：登录/侧栏/连接器/能力中心/设置/定时任务/聊天/高级模式/工作区/账号页）。

**服务端**——`server`：

- gofmt + go vet + `go test ./...`（PG_DSN_TEST 全量业务包，**-p1 串行**防连接池挤爆）；
- webadmin `npm test`（109 用例）；
- `make build-server`（webadmin 前端构建 + Go 静态编译，产物=server 二进制）；
- 部署脚本 `bash -n` + compose 语法校验（PG18 挂载点运行验证以 `RUN_PG18_MOUNT_CHECK=1` 显式开启）。

### 2.4 产物清单（每次提交）

| Artifact | 内容 | 消费方 |
|---|---|---|
| `desktop-Linux` | AppImage + deb | 团队下载安装 / release |
| `desktop-Windows-installer` | NSIS Setup.exe | 团队 / release |
| `desktop-macOS` | DMG（正式 tag=签名+公证版） | 团队 / release |
| `picoaide-server-linux-amd64` | Go 服务端二进制 | 团队部署 |
| `workspace-build` | 8 包 lib/ + 桌面构建产物 | 三平台 job（内部复用） |
| `e2e-report` | 客户端 E2E 报告 + 截图 | 失败排查（`if: always()` 留存） |

> 取用：PR 内的 `pr-summary` 评论 → 点击 Actions 运行页 → Artifacts。也可以 `gh run download <run-id> -n desktop-Linux`。

### 2.5 构建复用（消除重复编译）

- **一次构建**：所有编译发生在 `gate`（`yarn check` 内每包恰好一次），产物经 `workspace-build` 下发；
- **平台 job 只打包**：`dist:* --no-prebuild --no-gates`——跳过 `prebuildWorkspaceDeps`（8 包构建）与入口内嵌 check（门禁已在 gate）；打包后的平台验证不跳过（`verify-win-installer` / `verify-mac-smoke` / `verify-mac-release` / electron-builder `afterPack`）；
- **本地等价**：`yarn check` = gate；本地 `yarn dist:*` 默认走 prebuild + 内嵌 check（完整安全路径），与 CI 语义一致；
- **缓存**：`.yarn/cache` + electron/electron-builder 下载缓存三平台独立 key（`hashFiles('yarn.lock')`）；Go 用 setup-go 缓存；Docker 镜像用 `type=gha` buildx 缓存。

### 2.6 发布规划

- **客户端发布（正式与预发同一链路）**：`master` 上 bump 版本（root + desktop 两处 `package.json`，`scripts/version.mjs` 一键同步）→ 推 tag → CI 全量构建三平台 → `release` job 校验 tag==版本、生成 `SHA256SUMS.txt`（裸文件名，客户端升级源严格匹配）、创建 GitHub Release（`docs/releases/<tag>.md` 优先，缺失回退自动 changelog）。**Release job 幂等**：同 tag 重跑/重推时已存在 release → edit（标题/说明/Pre-release 标记）+ `--clobber` 刷新资产，不会 422；
- **正式版 `vX.Y.Z`**：GitHub Release（Latest 语义，推送给全部客户端）+ mac 签名与公证（pack/notarize 可重试、公证 submission 状态续等）+ 镜像 `latest + vX.Y.Z + vX.Y`；
- **预发 `vX.Y.Z-rc.N` / `-beta.N`**：**同样打 tag、同样出 GitHub Release 页面（Pre-release 徽章，资产可下载）**，只是：客户端升级源（`releases/latest`）与正式用户不收推；镜像只打 `vX.Y.Z-…` 具体 tag，不打 `latest`/宽版本 tag；
- **服务端镜像**：`docker.yml` 独立 workflow（同 tag 触发 + 手动 dispatch）：`ghcr.io/picoaide/picoaide-harness-server`，构建后真实启动验 `/healthz`（PG 容器）与 `--version` 注入、manifest 单 amd64 断言。镜像版本与 `version.mjs` 同源校验；
- **mac 预发签名（2026-09-06 已实施）**：预发 tag（beta/rc）走 **Developer ID 签名但不公证**（`--sign-only` → preflight 免公证元组，产物经 `dist:mac:dmg` 出 DMG + `verify-mac-release --unnotarized` 验证，跳过 spctl/stapler 两步）——Releases 页面可见、真机可装（首次打开右键绕过 Gatekeeper），免去每次 1-5 小时公证排队。正式 tag 维持完整签名+公证；非 tag 分支维持未签名冒烟。mac job 三态：**正式=签名+公证，预发=签名（不公证），PR/分支=未签名冒烟**。
- **品牌渠道客户端同样签名+公证（2026-09-11 修复）**：正式 tag（纯 `vX.Y.Z`）上渠道 DMG 与官方走同一条 `dist:mac:pack` + `dist:mac:notarize`（含 staple）链，逐渠道 3 次重试；预发 tag 的渠道列表只有 `beta`，维持只签名不公证。此前渠道借用预发那条 sign-only 路径，客户 Mac 上首次打开被 Gatekeeper 拦成「Apple 无法验证」——交付物不该要求客户手动放行。渠道公证与官方共享同一个 mac job 预算（`timeout-minutes: 360`，GitHub 托管上限），渠道数增长后需按序号矩阵拆 job。

### 2.7 运维与后续

- 运维 workflow：`ghcr-cleanup.yml`（手动删预发镜像 tag）、`notary-probe.yml`（Apple 公证诊断）；
- **边界（未纳入）**：CodeQL 安全审计、官网 site 构建、artifact 保留期（默认 90 天；如存储压力大可给各 Artifact 加 `retention-days`）、better-sidebar 的 plugin-mount E2E（其上游仓库 CI 职责）。

### 2.8 Workflow 命名规范（2026-09-06）

侧边栏展示的是每个 workflow 的 `name:` 字段（不是文件名），统一规则：

1. **动词短语**描述动作与对象，不用实现名词（如 "Server Docker image" 只说了产物 → "Publish server image"）；
2. **分类前缀**：运维/手动类加 `Ops · `，门禁与发布是主流程不加前缀；
3. **触发方式不写进名字**（原来 `(manual)` 后缀取消——侧边栏对 `workflow_dispatch` 本就有按钮，且发布类同样可手动触发，统一不标）；
4. **专名/缩写保持官方写法**：CI、GHCR、CodeQL。

| 文件 | name（侧边栏显示） | 类别 |
|---|---|---|
| `ci.yml` | `CI` | 门禁 + 三平台打包 + 发布（主流程） |
| `docker.yml` | `Publish server image` | 服务端镜像发布（GHCR） |
| `ghcr-cleanup.yml` | `Ops · GHCR cleanup` | 运维手动 |
| `notary-probe.yml` | `Ops · Notary probe` | 运维手动 |
| CodeQL（无文件） | `CodeQL` | GitHub Code security → **CodeQL default setup** 托管条目，命名不可改；如需纳入统一命名，改为仓库内自定义 workflow（`Security · CodeQL`） |

> 侧边栏出现 `CodeQL` 但仓库 `.github/workflows/` 中无对应文件 = 走的是 GitHub 的 **CodeQL default setup**（Settings → Code security 启用，工作流托管在 GitHub 侧）。它命名固定、无法像普通 workflow 一样改名——要么接受默认名，要么改成 advanced/自定义工作流（提交 `codeql.yml` 到仓库）以纳入这里的命名规划。

---

## 3. 常见操作

| 我想…… | 怎么做 |
|---|---|
| 拿某次提交的产物 | PR 评论里的 Actions 链接 → Artifacts；或 `gh run download` |
| 本地等价全量门禁 | `corepack yarn check`（+ server 侧 `cd server && make check`） |
| 发布新版本 | `corepack yarn version:set vX.Y.Z --push` 类流程（改双 package.json）→ 提交 → 打 tag → 推 tag |
| 手动构建某平台安装包 | `corepack yarn dist:linux`（等，默认全量安全路径）；CI 内已构建时传 `--no-prebuild` |
| 排查 PR 失败 | 看 gate（编译/测试）→ server（Go/webadmin）→ 平台 job（打包/E2E）；E2E 失败附报告与截图 |

---

## 附录 A：规划落地状态

| 项 | 现状（2026-09-06） |
|---|---|
| CI 结构 | ✅ 已实施（gate/server/三平台/release/pr-summary） |
| 重复编译 | ✅ R1-R6 已消除（打包脚本 `--no-prebuild`/`--no-gates`） |
| 每提交产物 | ✅ 每次 push/PR 四类产物 + PR 评论 |
| E2E 进 CI | ✅ linux job 接入 |
| server 门禁补齐 | ✅ gofmt + webadmin 109 测试 |
| 预发发布链路 | ✅ beta/rc = 打 tag + Pre-release（Release 页面可见、资产可下载）+ 客户端升级源排除；release job 幂等（已存在则更新，2026-09-06 修复） |
| mac 预发签名 | ✅ 预发 = Developer ID 签名（不公证，`--sign-only` + `dist:mac:dmg`）；正式 = 签名+公证（**含品牌渠道**，2026-09-11 修复）；PR/分支 = 未签名冒烟 |
| Workflow 命名规范 | ✅ 已实施（§2.8）：CI / Publish server image / Ops · GHCR cleanup / Ops · Notary probe；CodeQL 为 GitHub Default setup 托管条目（命名固定） |
| master 分支保护 | ⚠️ **未开启**（当前可直推；建议按 §1.3 开 PR+必填检查保护） |
| 常用 tag 规范 | ✅ 已有（`vX.Y.Z` 正式 / `-rc`/`-beta` 预发），`version.mjs` 强校验 |
| CodeQL / site / retention | ⏳ 规划中，未纳入 |
