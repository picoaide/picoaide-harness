# CI 流程重设计（2026-09-06）

> 前置调查报告：`docs/planning/2026-09-06-ci-pipeline-audit.md`（重复编译矩阵 R1-R8、门禁缺口 G1-G10）。
> 本决策文档记录重设计的目标、决策点与实施结果。实施后验收：`package.spec/package-win.spec/package-mac.spec/release-mac.spec` 共 34 测试绿；根 `yarn check` 新语义本地验证绿。

---

## 1. 目标

用户需求：整体 CI 重新设计，支持 **master 之外的分支团队协作**；**每个人提交的代码都能拿到编译产物**；**客户端与服务端都被测试**。

审计基线（关键事实）：

| 问题 | 事实 |
|---|---|
| R1 | 根 `check` 中 desktop build × 2（显式 + desktop check 内含） |
| R2 | `dist:linux` 前置 3 包 build 与 `package-linux.mjs` 内 `prebuildWorkspaceDeps`（8 包）叠加 |
| R3/R4 | win/mac 打包入口内 `check:win-package`（再 build 3 包）/`check:mac-package`（根 check 全量）叠在 prebuild 之上 |
| R5/R6 | `release-mac --pack` 内嵌根 check 全量；`--notarize` 无条件再 prebuild 8 包（复用产物时纯浪费） |
| G1/G2 | CI server job 不跑 gofmt、不跑 webadmin 测试（106 用例） |
| G3/G4 | `e2e:client` 从未进 CI；better-sidebar 无任何 check |
| 结构性 | 三平台 5 步 setup 复制粘贴；check 面三平台不一致（win 只 12 个测试文件）；tag push 触发全量 |

## 2. 决策

### D1. 门禁一次，平台只管打包：gate job + 三平台 job（needs: gate）
- 新增 `gate`（ubuntu）：`yarn install` → **根 `yarn check`（新语义，每包只构建一次）** → 上传 `workspace-build` artifact（8 个包的 `lib/**` + desktop 的 `build/**`，即 electron-builder 打包入口所需的全部产物）。
- `desktop-linux/win/macos` 全部 `needs: gate`：下载 `workspace-build`，恢复到仓库树，**只做平台专属打包 + 平台验证 + E2E**。
- **`server` 与 `gate` 无任何依赖、同时启动并行编译**（server 不用客户端产物：Go 工具链/PG 容器/webadmin 都是独立路径）；三平台打包与 server 完成窗口重叠，server 不占总时长关键路径（2026-09-06 实测：既并行编排也在运行期重叠，两 job 同秒启动）。
- 收益：同一代码三平台不再平行重复编译（审计的跨 job 重复）；平台 job 从「门禁 + 打包」收敛为「打包 + 验证」。
- 代价：平台 job 与 gate 串行，单次 PR 总时长 ≈ gate + 平台最长 job（实测 7.5 分钟：gate 2.9 + 平台 4.5；server 4.9 被完全掩盖）。

### D2. 根 `check` 语义重排（R1 消除，每包只构建一次）
新顺序：`check:layout` → **`desktop check`**（build+typecheck+test+verify:closure/loader/profile/licenses，一次构建产出 desktop `lib/`+`lib/types/`——其余包 tsc 依赖）→ `better-sidebar check` → connectors/enterprise/account-card/branding/browser/cron 各 `check` → `community-fabric check`。
- 删除原先开头的显式 `desktop build`（R1）；
- `better-sidebar` 纳入门禁（G4）：其 package.json 新增 `check = build + typecheck + test + check:consumer-types`（test:mount 是其上游仓库的挂载 E2E，依赖外部 DSH CLI，不进本仓库门禁）。
- 本地 `yarn check` 与 CI gate 入口完全同义（消除「两套跑法」）。

### D3. 打包脚本改为「构建后打包」：`--no-prebuild` / `--no-gates`
给 `package-linux.mjs`、`package-win.ts`、`package-mac.ts`、`release-mac.ts` 加 CLI 开关，**默认行为不变**（本地 `yarn dist:*` = prebuild + 内部 check + 打包 + 验证，与现状一致）；CI 传开关复用 gate 产物：

| 开关 | 语义 | 消除 |
|---|---|---|
| `--no-prebuild` | 跳过 `prebuildWorkspaceDeps`（8 包构建） | R2/R3/R4/R5/R6 的重复 build |
| `--no-gates` | 跳过打包入口内嵌的 check（win: `check:win-package`；mac smoke: `check:mac-package`=根 check 全量；mac release: packMacApp 内根 check） | R3/R4/R5 |

- 打包后的平台验证**不**在跳过范围：`verify-win-installer`、`verify-mac-smoke`、`verify-mac-release`（含签名/公证后验证）、electron-builder `afterPack`（`verify-packaged-runtime`）照常执行。
- `check:win-package` 改为「构建后平台检查」（去掉 3 包 build；`package.spec.ts` 断言随语义更新）——本地 `dist:win` 的 prebuild 与 CI gate 都已先构建，语义成立。
- `prebuild-workspace-deps.ts` 增加 CLI 入口（`yarn workspace dsh-plugin-desktop prebuild` / 根 `yarn prebuild`），方便手动复用。

### D4. server 门禁补齐（G1/G2）
`server` job 增加：`gofmt -l cmd internal` 检查步骤、`webadmin npm test`（106 用例）。保留既有：手动 PG 18 容器（max_connections=500）、`go test ./... -count=1 -p 1`（串行）、`make build-server`（= webadmin build + go build）、部署脚本语法检查。
- 注：CI 仍以步骤化（而非 `make check`）为主，因 CI 需要 `go test ./...` 全包口径、`-p 1` 串行与 PG 服务协同，`Makefile check` 保留为本地入口。

### D5. 客户端 E2E 接入（G3）
`desktop-linux` job 在 `dist:linux` 后运行 `e2e:client`（mock gateway + Xvfb :99 + CDP，13 项断言），上传 `.e2e-report.md` + `.e2e-shots/`（`e2e-report` artifact，`if: always()` 失败也留证据）。

### D6. 每个提交的产物 + PR 评论（用户核心需求）
- 触发保持 `pull_request` + `push`（全分支，含 tags），每次运行的 Artifacts：`desktop-Linux`（AppImage+deb）、`desktop-Windows-installer`（NSIS）、`desktop-macOS`（DMG）、`picoaide-server-linux-amd64`、`workspace-build`、`e2e-report`。
- 新增 `pr-summary` job（`needs` 三平台+server，`pull-requests: write`）：在 PR 上发布/刷新一条带标记的产物汇总评论（Actions 运行页 Artifacts 链接），fork PR（token 只读）跳过。
- 多分支协作语义：任意分支 push → 完整门禁 + 产物；分支间互不干扰（concurrency 按 ref 互斥、产物按 run 隔离、缓存按 yarn.lock 共享）。

### D7. 发布路径基本保留（最小风险）
- tag 触发同 workflow：mac 正式分支（pack `--no-prebuild --no-gates` + notarize `--no-prebuild`）→ release job（needs 四 job，`download-artifact pattern: desktop-*` 只取三平台安装包，不把 gateway 的 `workspace-build` 混入发布面）。版本校验/裸文件名 SHA256SUMS/notes 优先/Pre-release 语义均未改动。
- `docker.yml`（GHCR 镜像）保持独立 workflow 不动。

### D8. 未纳入（显式边界）
- CodeQL、官网 site 构建、artifact 保留期策略（默认 90 天，如团队存储压力大可对各 artifact 加 `retention-days`）列为后续。
- better-sidebar 的 `test:mount`（其上游仓库的 plugin-mount CI）不在本仓库运行（需外部 DSH CLI 与 Playwright 浏览器）。

### D9. 预发（beta/rc）也是完整发布（2026-09-06 补充）
- 语义：`vX.Y.Z-beta.N` / `-rc.N` = 打 tag + 全量 CI + **GitHub Releases 页面可见（Pre-release 徽章、资产可下载）**；与正式版唯一区别是推送面（`releases/latest` 与客户端升级源排除 prerelease；镜像不打 latest/宽版本 tag）。
- `release` job 幂等化：同 tag 重跑/重推时 release 已存在 → `gh release edit`（标题/说明/Pre-release 标记）+ `gh release upload --clobber`（刷新为本次构建资产），不再 422。
- **mac 预发签名（用户拍板：只签名不公证）**：预发 tag 走 `dist:mac:pack --sign-only`（preflight 新增 `notarizationOptional`，无公证凭据时报告 `'none'` 而非失败）+ 新增 `dist:mac:dmg`（`buildMacDmgWithoutNotarization`：`--prepackaged` 出 DMG + `verify-mac-release --unnotarized` 验证，跳过 spctl/stapler）。正式 tag = 签名+公证（不变）；PR/分支 = 未签名冒烟（不变）。mac job 条件改为：上传 `mac-release/*.dmg` 面向全部 tag（预发不再走 smoke）。

## 3. 实施清单

| 文件 | 改动 |
|---|---|
| `.github/workflows/ci.yml` | 重写为 gate/server/desktop-linux/desktop-windows/desktop-macos/release/pr-summary |
| `package.json`（根） | `check` 重排（desktop check 最先）；新增 `prebuild` |
| `packages/host/desktop/package.json` | `dist:linux` 聚焦打包；`check:win-package` 去 build；新增 `prebuild` |
| `packages/host/desktop/scripts/prebuild-workspace-deps.ts` | CLI 入口 |
| `packages/host/desktop/scripts/package-linux.mjs` | `--no-prebuild` |
| `packages/host/desktop/scripts/package-win.ts` | `--no-prebuild` / `--no-gates`（skipGates 默认 false） |
| `packages/host/desktop/scripts/package-mac.ts` | 同上 |
| `packages/host/desktop/scripts/release-mac.ts` | 同上（packMacApp 增加 skipGates） |
| `packages/client/better-sidebar/package.json` | 新增 `check` |
| `packages/host/desktop/tests/package.spec.ts` | `check:win-package` 断言随 D3 更新 |
| `AGENTS.md` | CI 语义说明 |

## 4. 验证

- `tests/package.spec.ts / package-win.spec.ts / package-mac.spec.ts / release-mac.spec.ts`：34/34 绿（默认开关行为与 CI 断言）。
- `yarn workspace dsh-plugin-desktop dist:mac-smoke --no-prebuild`：flag 转发到脚本成功（直接命中平台检查，跳过 prebuild）。
- `node packages/host/desktop/scripts/release-mac.ts --pack --no-prebuild --no-gates`：解析正确（跳过 prebuild/check，进入平台检查）。
- `yarn workspace dsh-better-sidebar check`：绿。**注意**：其 vendored 副本不含 `tests/`（上游仓库才有），`test: vitest run` 必然「No test files found」——这是它此前从未进根 check 的真实原因；故 `check` 不含 test（见 §3 实施清单）。
- 根 `yarn check`（新语义）：全绿 rc=0（desktop 全量 + better-sidebar + 六包 + fabric）。
- `dist:linux --no-prebuild`（模拟 CI 平台 job 的「gate 产物 → 纯打包」链路）：成功产出 `PicoAide-Harness-2.6.7-beta.1-x86_64.AppImage` 与 `-amd64.deb`（afterPack `verify-packaged-runtime` 在内通过）。注：本地沙箱 `/root/.cache` 只读导致首次打包失败，需 `ELECTRON_BUILDER_CACHE` 指向可写目录；CI runner 无此问题。
- `e2e:client`（新打包产物上，Xvfb :99 + mock gateway + CDP）：**全部通过**（13 项断言，`.e2e-report.md` + `.e2e-shots/` 产出）。
- webadmin `npm test`（CI server job 新增步骤）：109/109 绿；`gofmt -l cmd internal` 本地通过。
- 完整 CI 真实运行（win/mac 打包、mac 签名、PR 评论）待 push 后观察——本分支实施验证不推进远程。
