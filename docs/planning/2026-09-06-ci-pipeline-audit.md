# CI 流水线审计报告（2026-09-06）

> 目标：为「重新设计 CI 流程」提供事实基线。本次只调查、不改动。
> 结论速览：当前 CI 功能上是全绿的（每平台 job 5-8 分钟），但**同一逻辑构建在单个 CI 运行内重复 2~4 次**；门禁面三平台不一致；若干检查（gofmt、webadmin 测试、E2E、官网构建）完全缺失；结构上由 4 个 workflow + 6 个入口拼凑而成，无设计文档。

---

## 1. 现状总览

### 1.1 Workflow 清单（`.github/workflows/`，4 个文件）

| Workflow | 触发 | 职责 | Job |
|---|---|---|---|
| `ci.yml` | `pull_request` + `push`（**无分支/tag/path 过滤**） | 门禁 + 三平台打包 + GitHub Release | server / desktop-linux / desktop-windows / desktop-macos / release |
| `docker.yml` | `push tags v*` + `workflow_dispatch` | 服务端镜像构建推送 GHCR + 运行验证 | build（一次 docker build + 两种 Verify） |
| `ghcr-cleanup.yml` | `workflow_dispatch` | 手动删除预发布镜像 tag | cleanup |
| `notary-probe.yml` | `workflow_dispatch` | 手动查 Apple 公证历史（OS 诊断） | probe |

没有：CodeQL（本地审计而非 CI）、官网 site 构建、`e2e:client`（AGENTS.md 标注 CI-able 但从未接入）、依赖漏洞扫描（yarn audit / go vuln）。

### 1.2 构建入口（6 个，互相嵌套）

1. 根 `yarn check`（`package.json`）：layout → **desktop build** → 7 个包各自 `check` → **desktop check**（= desktop build + typecheck + test + verify:closure/loader/profile/licenses）
2. 各包 `check` = `build && typecheck && test`（enterprise/connectors/browser/cron/account-card/branding 六包完全同构）
3. desktop `dist:linux` = **enterprise build + account-card build + desktop build** + `package-linux.mjs`（内部又 `prebuildWorkspaceDeps`）
4. desktop `dist:win` → `package-win.ts`：**`prebuildWorkspaceDeps`** → `check:win-package`（= desktop/enterprise/account-card build + typecheck + 12 个测试文件 + verify:closure）→ electron-builder → 验证
5. desktop `dist:mac-smoke` → `package-mac.ts`：**`prebuildWorkspaceDeps`** → `check:mac-package`（= `yarn run -T check`，即**根 check 全量**）→ electron-builder → 验证
6. desktop `dist:mac:pack` / `dist:mac:notarize` → `release-mac.ts`：入口不定阶段地执行 **`prebuildWorkspaceDeps`**；`packMacApp` 内部再跑**根 `yarn run check` 全量**；`--notarize` 阶段再跑一次 `prebuildWorkspaceDeps`

`prebuildWorkspaceDeps`（`scripts/prebuild-workspace-deps.ts`）一次构建 **8 个包**：desktop、enterprise、account-card、branding、cron、connectors、browser、better-sidebar。（memory-evolve 的 lib/ 入库，不入此列。）

> 根因第一句：`check` 语义 =「build + typecheck + test」，而每个打包脚本又自含 `prebuildWorkspaceDeps` + 内部 check —— **三层构建嵌套**，且层与层之间构建的是同一批包、同样的编译命令。

---

## 2. 重复编译矩阵（核心事实）

### 2.1 重复点逐一列举

| # | 位置 | 重复内容 | 性质 |
|---|---|---|---|
| R1 | 根 `check`：`yarn workspace dsh-plugin-desktop build` **与** 末尾 `yarn workspace dsh-plugin-desktop check`（其第一步就是 build） | desktop build ×2 | 同脚本内直接重复（前者很可能是为后续包提供 desktop 类型而加的早期后缀，未随 check 合并而删除） |
| R2 | `dist:linux`：package.json 脚本前置 `enterprise build + account-card build + desktop build`，`package-linux.mjs` 内 `prebuildWorkspaceDeps`（含同三包） | enterprise/account-card/desktop build ×2 | 脚本与脚本内层重复（注释自称「因 dist:linux 前置 build 才碰巧完整」——其实是双层 build 叠加） |
| R3 | `dist:win`：`prebuildWorkspaceDeps`（8 包）之后 `check:win-package` 又 build desktop/enterprise/account-card | 三包 ×2 | 同一入口内连续两层构建 |
| R4 | `dist:mac-smoke`：`prebuildWorkspaceDeps`（8 包）之后 `check:mac-package` = 根 check（desktop build ×2 等） | desktop ×3（prebuild 1 + 根 check 2）、其余 ×2 | 同一入口内连续两层构建 |
| R5 | `release-mac.ts --pack`：入口 `prebuildWorkspaceDeps`（8 包）→ `packMacApp` 内根 `yarn run check`（desktop build ×2 等） | desktop ×3、enterprise/account-card ×2 | 同上 |
| R6 | `release-mac.ts --notarize`：**入口仍然无条件 `prebuildWorkspaceDeps`（8 包全量）**，而该阶段用 `--prepackaged` 复用 pack 阶段产物，完全不需要任何 build | 8 包 build ×1 完全浪费 | 拆分模式（pack/notarize）本意是「产物复用、阶段可重试」，但 CLI 入口把 prebuild 放在了拆分逻辑之外 |
| R7 | 三平台 job 的 `yarn install` 之后各跑一套全量/半全量 check（linux 根 check、mac 根 check、win check:win-package），随后各自打包又全量 build | 跨 job 的平行重复（3 台机器重复编译同一代码） | Linux/mac 的 check 是全平台无关内容（typecheck/test/verify），放平台 job 里纯属「每平台重跑一遍门禁」 |
| R8 | `on: push` 无过滤 → **tag push 触发 ci.yml 全量**（server + 三平台打包，MAC 5.5h 窗口） | 与 PR 已跑过的门禁完全重复（除 mac 签名外） | 发布语义与门禁语义混在一个 workflow |

### 2.2 单个 job 内各包 build 次数（按脚本源码逐层累加）

| Job | desktop | enterprise | account-card | branding/cron/connectors/browser | better-sidebar |
|---|---|---|---|---|---|
| **desktop-linux**（yarn check + dist:linux） | **4**（R1×2 + R2×2） | **3**（check 1 + R2×2） | **3** | **2** | 1 |
| **desktop-windows**（dist:win） | **2**（R3） | **2**（R3） | **2**（R3） | 1 | 1 |
| **desktop-macos 非正式**（dist:mac-smoke） | **3**（R4） | **2** | **2** | **2** | 1 |
| **desktop-macos 正式**（pack + notarize） | **4**（R5×3 + R6） | **3**（R5×2 + R6） | **3** | **2** | **2**（R6） |
| **server** | — | — | — | — | — |

> server job 无重复编译：`go test` 与 `make build-server` 共享 Go 增量缓存；webadmin `npm run build` 只跑一次。`docker.yml` 单次 docker build 也无重复。
> **结论：重复全部集中在桌面侧；最典型是 desktop-linux 的 desktop 包被编译 4 次、mac 正式发布同一 commit desktop 包编译 4 次。**

### 2.3 实测运行时长（master push，2026-09-06，`gh run view 34000438966`）

| Job | 总时长 | 关键步骤 |
|---|---|---|
| Go server | 8.6 分 | `go test ./... -p 1`（串行）7 分 05 秒 ← 绝对大头 |
| Desktop (Linux) | 5.8 分 | `yarn check` 2 分 01 秒；`dist:linux` 2 分 51 秒（已含 R2 的双倍构建） |
| Desktop (Windows) | 4.6 分 | `dist:win` 3 分 26 秒 |
| Desktop (macOS) | 3.4 分 | smoke 分支：check 全量 + 打包 + 验证 2 分 37 秒 |

> 当前 CI 机器强（18 核档）+ yarn/Go 缓存命中，重复编译的**绝对时间不算失控**；但 PR 冷缓存、或重新设计后要加 E2E 时，这个结构的浪费会直接放大。重复的真正代价是：① 每平台 3 台机器重复编译同一份代码（Runner 时间 × 多平台）；② 构建产物相互覆盖/时序耦合（如 `dist:linux` 前置 build 与 `package-linux.mjs` 内 prebuild 谁先谁后、产物新鲜度依赖顺序）；③ 排查「为什么 Windows 上没跑 X 测试」全要靠读脚本。

---

## 3. 门禁覆盖缺口（与「乱」并列的第二类问题）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | server job **不跑 `gofmt`** | `ci.yml` server job 只有 `go vet` + `go test`；`server/Makefile check` 才有 `gofmt -l cmd internal`（CI 未调用 `make check`） | 格式违规零拦截 |
| G2 | server job **不跑 `webadmin` 测试**（106 个用例）与 fork 安全 | `ci.yml` 只 `npm ci` 然后 `make build-server`（内部 `npm run build` 含 tsc -b，但**没有 `npm test`**）；`make check` 有 `npm test` | webadmin 单元测试只在本地/手工跑，CI 全绿 ≠ 前端测试通过 |
| G3 | `e2e:client`（13 断言、AGENTS.md 明确 CI-able）**从未进 CI** | 4 个 workflow 无 e2e 字样 | 客户端 UI 回归零拦截 |
| G4 | **better-sidebar 无任何 check/test**（只有打包时 build） | 根 `check` 未列之；仅在 `prebuildWorkspaceDeps` 中被构建 | 唯一无测试覆盖的自研插件 |
| G5 | **官网 site 构建无 CI** | workflows 无 site job；记忆记载 wiki 改动需手工 `astro build` | 官网 30 页可被默默破坏 |
| G6 | **平台门禁面不一致**：linux 跑根 check；mac 跑根 check（经 `check:mac-package`）；win 只跑 `check:win-package`（desktop 12 个测试文件子集 + 三包 build） | 见 §1.2 入口 4/5 | 同一 PR 在 win 平台上 6 个包无 typecheck/test；「跨平台失败」先发生在打包阶段而非门禁 |
| G7 | `server` job 产物 `picoaide-server-linux-amd64` 在 CI 内**无消费者** | release job 只下载 AppImage/exe/dmg/SHA256SUMS.txt；部署走 docker 镜像 | 上传即归档，缺失失败校验意义（artifact 本身没问题，但属「无下游」）
| G8 | `docker.yml` 与 `ci.yml server` 维护两套 PG 启动脚本（docker run + pg_isready + SELECT 1 轮询） | ci.yml:41-52 / docker.yml:185-201 | 复制粘贴维护，后续改一处忘一处（历史上已因此多次修补） |
| G9 | 无 CodeQL | 4 workflows 无 | 安全审计依赖本地人工（项目有 codeql skill 但非 CI） |
| G10 | `on: push` 无 `paths` 过滤 | — | 改 docs/wiki 也触发三平台打包 |

---

## 4. 结构性问题（「为什么乱」的根因）

1. **`check` 与 `build` 的语义耦合**：每个包 `check` = build+typecheck+test 一把梭。导致「任何需要产物的场景」都退化为全量 check；而打包需要产物又自己 build——两者互相不信任又互相依赖，于是叠加。
2. **产物新鲜度约定不存在**：谁先构建、谁消费哪一版产物没有契约（`dist:linux` 若删掉前置 build，`prebuildWorkspaceDeps` 兜底；若删掉 prebuild，后果同——所以两个都留着，双倍耗时）。
3. **打包脚本职责越界**：`package-*.ts/mjs` 本应是「把已构建产物装进安装包」，实际承担了 prebuild + 全量 check + 打包 + 验证四件事；`release-mac.ts` 的 `--pack/--notarize` 拆分只把「构建」拆了出去，`prebuildWorkspaceDeps` 却被遗忘在拆分之外（R6）。
4. **平台 job 复制粘贴**：三平台 5 个步骤（checkout/setup-node/corepack/cache/install）完全相同，check 面却相互不一致——复制时改一处、漏一处，正是 G6 的来源。
5. **CI 是补丁式成长的**：git log 全是 `fix(ci): ...`（PG 服务连接数、mac 双分支合并、公证凭据传递、版本校验……），每个修复都留一个长注释；而 `docs/` 下没有任何 CI 设计文档。功能的可用性靠注释缝补，结构没有演进。
6. **两套「怎么跑测试」的入口并存**：`server/Makefile check`（gofmt+vet+枚举包 test+webadmin test+build）与 `ci.yml` server job（vet + `go test ./...` + build-server + 部署脚本检查）——语义接近但内容不同，且均未引用对方（G1/G2 的直接来源）。

---

## 5. 重设计方向（供下一轮细化，不实施）

目标形态（理念：**门禁一次、平台只管打包**）：

1. **拆分 `check` 语义**：每包提供 `typecheck` / `test` / `build` 三个原子命令与 `check` = 三者组合（现状已如此），根 `check` 改为无 build 的门禁（typecheck + test + verify:* + layout），**删除根 check 内的显式 desktop build**（R1 即平）。
2. **打包脚本不再内嵌构建**：`prebuildWorkspaceDeps` 保持为「独立入口脚本/命令」，由 CI 显式调用一次（或由 `dist:*` 脚本第一步调用）；`package-*.ts/mjs` 收敛为「构建完成后的纯打包+验证」。`dist:linux` 的前置 build（R2）与脚本内 prebuild（R2）二选一。
3. **`release-mac.ts` 拆分逻辑前置**：`--notarize` 不再 prebuild（R6 直接消失）；`--pack` 内不再跑根 check（check 由 CI 的门禁 job 负责，R5 减半）。
4. **平台 job 结构统一**：
   - `gate`（ubuntu）：install + 全部包 typecheck/test/build 一次 + layout + verify:closure/loader/profile/licenses + **e2e:client**（+ 可选 webadmin/Go 侧合并）；
   - `desktop-linux/win/macos`：`needs: gate`，只做 install + **本平台专属打包/签名/验证**（依赖 prebuild 或复用 gate 构建产物——后者需要 workspace 缓存/artifact 方案，可作为第二阶段）。
5. **server 门禁统一走 `make check` 或与 Makefile 对齐**：补 gofmt + webadmin `npm test`（G1/G2）；保留 `go test ./... -p 1` 的串行策略（PG 连接池实测教训）。
6. **触发器收窄**：`push` 只对 `branches: [master, feat/*]` 之类主分支；tag 不触发门禁全量（用单独 `release.yml` 承载 mac 签名 + release，`needs` 复用构建产物或重跑必要的打包 job）；路径过滤 `paths`（G10）。
7. **运维/诊断 workflow 保留**（ghcr-cleanup/notary-probe 是合理的 ops 工具），但移入 `docs/ops` 说明或独立 naming 前缀。
8. **补缺**：better-sidebar 挂 test/typecheck（G4）、site 构建 job（G5）、CodeQL（G9）。

> 验证基线：本次审计不改动任何运行逻辑；重新设计必须保持现有约束——① tag==双处 package.json 版本校验（version.mjs）；② mac 双分支单 job 防 Release skip；③ GHCR source label 关联；④ PG 连接数 500 与串行测试；⑤ 平台产物命名与 SHA256SUMS 裸文件名契约。
