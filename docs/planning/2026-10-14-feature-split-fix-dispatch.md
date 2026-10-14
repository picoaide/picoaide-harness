# 编译期功能拆分：四路收口派工单（2026-10-14）

> 用途：让**零上下文**的新会话直接开工。每条派工项都给出「位置（文件:行号）+ 修法 + 验收命令 + 退出码口径 + 变异反证」。
> 本文件是四路收口的**唯一真源**；与旧交接表冲突时以本文件为准（旧表的 SHA 已过期，见 §1 注）。

## 0. 口径与纪律

- **集成线**：`feat/p0-integration`（worktree `/data/picoaide-harness/temp/p0-integration/wt`），draft PR **#181**。
- **四路修复分支**在各自 worktree，**均已提交、均未 push**（不要 push；回收由集成线统一做）。
- **退出码口径**：本文件所有验收命令，未特别说明者都要求 **exit 0**；变异/反证项要求 **exit ≠ 0**（且必须是**新判据**变红，不是环境红）。
- **提交纪律**：`git commit -m "..." -- <只列本次改的路径>`（部分提交，防卷进他人暂存）；不 `stash`/`reset` 他人改动；不 push。
- **铁律 0**：任何文件正文与提交信息都不得出现渠道/客户身份与真实域名；改含 URL/域名的文件后跑 `node scripts/check-no-real-domains.mjs`（要求 exit 0）。
- **企业侧前置**：`packages/host/enterprise` 的 spec 依赖已构建的依赖包产物。跑 enterprise 套件前先 `yarn prebuild`（或 `DSH_PREBUILD=force yarn prebuild` 强制全量）。`account-card` 依赖 `enterprise`（其 tsdown `clean:true` 会清 `lib/`）⇒ 两者**必须串行**跑。

## 1. 现状（2026-10-14 06:20 实测，非引用旧交接表）

| 分支 | 实测 HEAD | worktree | 审计 | 本单剩余项 |
|---|---|---|---|---|
| `p1b-conditionalize` | `2740e7d596` | `temp/p1b-conditionalize/wt` | 1 轮 | D-01（P0 已修，待复验） |
| `fix-mount-flake` | `c734acf6d2` | `temp/fix-mount-flake/wt` | 3 轮 | D-06（两条 P1 已修，待复验） |
| `p2-client-variant-pack` | `4bb53be22a` → 审计后 `3fb81b4b5f` | `temp/p2-client-variant-pack/wt` | 2 轮 | D-07（**已修完并入，见 §4**） |
| `p3-webadmin-variant` | `b339675a7b` | `temp/p3-webadmin-variant/wt` | 3 轮 | D-04（P1）、D-05（P2×3） |

> **注（旧表已过期）**：旧交接表记的是 `p1b=2927feba899 / flake=c30721c1e3 / p3=18fca5f580`。这三路此后各又落了修复批（`2740e7d596` / `f31661f22c`+`c734acf6d2` / `db0b985e0e`+`b339675a7b`），因此旧表列的 P0/P1 里有相当一部分**已经修掉了**——本单只列实测仍未清的项。

### 1.1 两条基线红（"CI 全绿"的前置，不修则不可能全绿）

| ID | 现象 | 状态 |
|---|---|---|
| D-02 | `check-workspaces` 集成态红：`account-card` 仍按旧相对路径 import 已搬走的 capability-center | **未修** |
| D-03 | `check-workspaces` 集成态红：`enterprise` 222 条 `ctx.inject is not a function` 夹具失败 | 已在 `fix-mount-flake` 修好，**待集成后复验** |

## 2. 派工项

### D-01【P0，已修·待复验】p1b：`packages/` 侧读服务端真源的路径常量

- **背景**：Go 侧把 `internal/wasmapp/limits`→`internal/limits`、`internal/wasmapp/skillseed`→`internal/skillseed`，`packages/` 里读这些源码位置的判据当时没跟搬（P0）。
- **现状**：`2740e7d596` 已改 16 个 `packages/**` 文件；`grep -rn 'internal/wasmapp/limits\|internal/wasmapp/skillseed' packages/` 实测**零命中**。
- **待办**：**复验**（不是重修）。若复验红，按下面位置逐个把常量改到新家（保留"多候选前缀"机制，只换常量值）：
  - `packages/host/wasm-apps-host/src/{wasm-apps,ai-chat,app-protocol,builtin-skills}.ts`
  - `packages/host/capability-center/src/client/BuiltinSkillsStrip.tsx`
  - `packages/client/wasm-apps/src/client/appcfg-contract.ts:302`
  - `packages/host/enterprise/tests/{wasm-apps,wasm-app-tools,builtin-skills-go-e2e}.spec.ts`
- **验收**（在 `temp/p1b-conditionalize/wt`）：
  ```bash
  yarn prebuild
  yarn workspace @picoaide/dsh-wasm-apps-host test   # exit 0
  yarn workspace @picoaide/dsh-wasm-apps test        # exit 0
  yarn workspace @picoaide/dsh-enterprise test       # exit 0（依赖 D-03 的夹具修复）
  ```
- **反证**：把任一常量改回 `internal/wasmapp/limits` ⇒ 对应 spec 必须红（否则说明判据没真读那个常量）。

### D-02【基线红·必修】account-card 相对路径残留

- **位置**（`temp/p0-integration/wt`）：
  - `packages/client/account-card/tests/capability-delisted-badge.spec.tsx:41,42`
  - `packages/client/account-card/tests/r16b-capability-load-error.spec.tsx:32,33`
- **病灶**：`account-card` 已从 `packages/host/` 搬到 `packages/client/`，但 spec 里仍是 `'../../capability-center/src/client/...'` ⇒ 解析成 `packages/capability-center`（**不存在**）。真实位置是 `packages/host/capability-center`。
- **修法**：四处相对路径 `'../../capability-center/...'` → `'../../../host/capability-center/...'`（`tests/` → `account-card` → `client` → `packages`，故三段 `../`）。
  - 保持**源码级 import** 口径不变（这是刻意的跨包源码守卫，不要改成包名 import）。
- **验收**（在 `temp/p0-integration/wt`，串行）：
  ```bash
  yarn prebuild
  yarn workspace @picoaide/dsh-enterprise build     # 先（account-card 依赖它的产物）
  yarn workspace @picoaide/dsh-account-card check   # exit 0（build + vitest run）
  ```
- **反证**：改回旧路径 ⇒ `Cannot find module .../packages/capability-center/...`（exit ≠ 0）。

### D-03【基线红·已在 flake 修好】enterprise `ctx.inject` 夹具 222 条

- **根因**：`apply-full-composition` 的手写假 ctx 没有 `ctx.inject`，而模块行用 `ctx.inject(['tools'], cb)` 取可选服务 ⇒ 222 条 spec 红。
- **修复位置**（`temp/fix-mount-flake/wt`）：`packages/host/enterprise/tests/helpers/apply-full-composition.ts:66`（类型面）、`:98-104`（按真 Cordis 语义实现：服务齐了才跑回调、不抛）。
- **验收**（在 `temp/fix-mount-flake/wt`）：
  ```bash
  yarn prebuild
  yarn workspace @picoaide/dsh-enterprise test      # exit 0，failed = 0
  ```
- **集成注意**：本项**只能靠合入 `fix-mount-flake` 进入集成线**；合入后必须在 `p0-integration` 上再跑一次 `yarn check` 复验。

### D-04【P1·必修】p3：`judge()` 可被一行 `return []` 掏空且全套门禁不红

- **位置**（`temp/p3-webadmin-variant/wt`）：`server/webadmin/scripts/check-feature-chunks.mjs:288`（`judge`）、`:368`（唯一调用点）。
- **现场**：`judge` 是"变体 ⟺ 产物"的**唯一判定体**；实测把它改成 `return []`，同时真造一处泄漏（反引号 `import` ⇒ Apps chunk 进关闭变体产物），`npm run check:features` 仍打印 ✅5/5 且 exit 0。
- **修法**（按仓内既有先例的形态）：给 `judge` 加**合成样本自检**——
  - 至少 **1 正样本**（与变体一致的 dist 形状 ⇒ 期望空问题清单）+ **N 负样本**（每个负样本各注入一类偏差：缺哨兵 / 多哨兵 / 缺页 chunk / 多页 chunk / 空 dist / 缺核心页 chunk ⇒ 期望**非空**问题清单）；
  - 断言下界常量（形如 `SELFTEST_SAMPLES >= n`），并断言"负样本必须全部被检出"，任一不满足 ⇒ exit 2（判据自身失效，与"产物不符"的 exit 1 区分开）；
  - 若该脚本在 `scripts/check-root-guards.mjs` 的摘要表内，同批重登记 digest（`--print-digests` 复算，取提交后 HEAD 那份）。
- **验收**：
  ```bash
  cd server/webadmin && npm run check:features     # exit 0（正常态，5 次真构建）
  ```
- **反证（必须真跑）**：临时把 `judge` 改成 `return []` ⇒ `npm run check:features` 必须 **exit ≠ 0**（自检红）；恢复后复绿。只"看代码觉得对"不算。

### D-05【P2·认账或修】p3 三条口径缺口

- （a）`server/Makefile` 的 `check-fast` 未传 `FEATURES`（`check` 传了）⇒ 当 `GO_TAGS` 指向少模块变体时，同一条命令的两半变体不同。修法：给 `check-fast` 的两处 webadmin 调用补 `FEATURES=$(FEATURES)`。
- （b）`check-feature-chunks.mjs` 的源码图 `DYNAMIC_IMPORT_RE` 只认引号 ⇒ 反引号 `import(\`...\`)` 在源码图上看不见（产物判据仍兜得住）。二选一：扩正则覆盖反引号，或写进 `docs/decisions/` 的认账清单（含"为什么产物判据仍拦得住"）。
- （c）CSS 产物与变体无关（逐字节相同）这条事实也要进同一份认账清单。
- **验收**：`make -C server check-fast`（exit 0）；文档改动跑 `node scripts/check-doc-claims.mjs`（exit 0）。

### D-06【P1·已修·待复验】flake：未来时间戳判据 + env-gated 登记表

- **已修位置**（`temp/fix-mount-flake/wt`）：
  - `packages/host/enterprise/tests/helpers/env-gated-criteria.ts`（新增 K-08 登记项 + `consumeMountGate` + `REGISTRY_SELF_SPEC`）
  - `packages/host/enterprise/tests/env-gated-criteria.spec.ts`（对账面改为整仓 `packages/` 递归全扫 + 扫描面下限）
  - `packages/host/enterprise/tests/audit-r20-skill-library.spec.ts`（K-08 改走 `bindMount`）
  - 钳位 fail-safe 半边的判据（未来 mtime 在 24h 阈值下不得被清扫）在 `f31661f22c`
  - 决策文档 `docs/decisions/2026-10-13-env-gated-mount-criteria.md`
- **验收**：
  ```bash
  yarn prebuild
  yarn workspace @picoaide/dsh-enterprise test      # exit 0
  ```
- **反证（两条，二选一即可复现）**：
  - 把 `capability-center/src/host/skill-install.ts` 的 `Math.max(0, now - st.mtimeMs)` 改回 `now - st.mtimeMs` ⇒ 新的边界判据必须红；
  - 把 `env-gated-criteria.spec.ts` 的登记对账面缩回单个 spec ⇒ 必须红（防"缩面静默通过"）。

### D-07【P0·已修并入】p2：审计重放 + connectors 关不掉

- **位置**（`temp/p2-client-variant-pack/wt`，HEAD `4bb53be22a`）：第一轮审计未跑完，证据在 `temp/p2-client-variant-pack/audit-tmp/EVIDENCE.md` 与 `probe-*.mjs`。
- **待重放的怀疑清单**（逐条给"成立/不成立 + 证据"）：
  1. **connectors 关不掉（P0）**：browser 包对它有生产依赖 ⇒ 模块代码仍进 asar，`afterPack` 因此拒建。判据：真关 connectors 后 `assertFeatureModulePresence()` 的双侧缺席判据是否红、`afterPack` 是否拒建。
  2. **prebuild 的变体跳过读的是上一轮清单**（顺序 `prebuild`→`prepare`），且 `DSH_PREBUILD=force` 不覆盖。
  3. **缺席判据锚在 `temp/channel-variant.json` 而非随包声明** ⇒ 清单缺失即静默假绿。
- **验收**：审计结论 + 每条怀疑的**可复现命令与退出码**；修复后 `yarn workspace dsh-plugin-desktop check` exit 0。
- **纪律**：审计阶段只读（不改分支）；修复另起提交。

### D-08 合入顺序与"CI 全绿"判据

1. 先在 `temp/p0-integration/wt` 落 D-02（基线红 1，独立小提交）。
2. 依次合入四路（建议顺序：`p1b-conditionalize` → `fix-mount-flake` → `p3-webadmin-variant` → `p2-client-variant-pack`）：
   ```bash
   cd /data/picoaide-harness/temp/p0-integration/wt
   git merge --no-ff <branch>       # 冲突按"保留判据在案"原则解，禁止弱化断言
   ```
   - 每合一路后跑**受影响包**的 `yarn check:fast`（exit 0）。
3. 全量：
   ```bash
   yarn check                # exit 0（= CI gate job 同义）
   node scripts/check-root-guards.mjs          # exit 0（17 条守卫）
   node scripts/check-workflows.mjs            # exit 0
   node scripts/check-no-real-domains.mjs      # exit 0
   node scripts/check-doc-claims.mjs           # exit 0
   ```
4. **两条基线红清零**是"全绿"的硬前提：`check-workspaces` 若仍有 `enterprise` / `account-card` 红，CI 不可能绿。
5. 转正：PR #181 去掉 draft（**只在 1–4 全绿后**）。push 由人确认；不自动 push。

## 2.1 已验证记录（2026-10-14 06:2x–07:0x，集成线 `feat/p0-integration`）

前置：集成 worktree 的依赖与子模块需先补齐（两处都是**环境**而非代码问题，新会话照做即可）：

```bash
# 1) node_modules：worktree 自带的 ../.yarn/cache 只有 185 个包（不全）⇒ 需先播种完整离线镜像
cp -al /data/picoaide-harness/.yarn/cache/. <worktree>/.yarn/cache/      # 同盘硬链接，不占空间
# 2) yarn 的全局目录在 /root 下不可写 ⇒ 必须给一个可写的 HOME
cd <worktree> && HOME=/data/picoaide-harness/.yarn-home corepack yarn install --immutable   # exit 0
# 3) 子模块：worktree 默认未 init，且**不能**从 GitHub 拉 ⇒ 用本地检出克隆（并把 origin 改回权威 URL）
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=submodule.deepseek-harness.url \
  GIT_CONFIG_VALUE_0=/data/picoaide-harness/deepseek-harness \
  git -c protocol.file.allow=always submodule update --init --recursive
git -C deepseek-harness remote set-url origin https://github.com/deepseek-ai/deepseek-harness.git
```

> 第 3 步的 `set-url` **不是可选项**：本地克隆会让 `origin` 变成 `/data/...` 路径，`verify-layout` 会红在
> `deepseek-harness origin differs from upstream.json`（`check:layout` 与 `check:wasm-client-only` 因此双红，
> 与代码无关）。改回权威 URL 后 17 条根守卫全绿。

| 项 | 判据（命令） | 结果 |
|---|---|---|
| D-01a | `yarn workspace @picoaide/dsh-wasm-apps-host test` | ✅ exit 0，30 files / **394 passed** |
| D-01b | `yarn workspace @picoaide/dsh-wasm-apps test` | ✅ exit 0，27 files / **456 passed** |
| D-02 | `yarn workspace @picoaide/dsh-account-card check` | ✅ exit 0，14 files / **87 passed**（build 也过） |
| D-03/D-06 | `yarn workspace @picoaide/dsh-enterprise test` | ✅ exit 0，105 passed + 1 skipped / **1145 passed，0 failed**（222 条 ctx.inject 夹具红已消失） |
| D-01 反证 | 把 `appcfg-contract.ts:302` 的 `LIMITS_GO_REPO_PATH` 改回旧家 `server/internal/wasmapp/limits/limits.go` | ✅ **exit 1**（5 条 FAIL：limits.go 读不到 / app_id 形态 / 版本号形态 / 白名单上限 / .wasm 体积上限）；恢复后 exit 0（23 passed） |
| 根守卫 | `node scripts/check-root-guards.mjs` | ✅ **17/17 PASS**（修好子模块 origin 之后） |
| 域守卫 | `node scripts/check-no-real-domains.mjs` | ✅ exit 0（含 `origin/master..HEAD` 40 条提交信息零命中） |
| 合并预演 | `git merge-tree --write-tree feat/p0-integration <branch>` ×4 | ✅ **四路全部零冲突** |
| 路径常量普查 | `grep` 出全部 `'server/**'` 字面量逐个 `-e` 判断存在性 | ✅ 无第二个搬迁残留（3 个"不存在"的路径是 spec 里的合成负例夹具，如 `zz-lookalike.ts`） |

仍未在本机跑的（**留给 CI，不当作缺口**）：Go 侧 `make -C server check-tags` 变体矩阵（8 组合）与
`go test ./cmd/server` —— p1b 自家那一轮已给过 88 vs 209 命名空间、关闭态二进制可启动等证据，且
`.github/workflows/ci.yml:1007` 这一步现在就在 CI 里跑。

## 2.2 合入与复验记录（2026-10-14 06:5x–07:3x）

**已合入 `feat/p0-integration` 的三路**（各自 `git log <branch> --not HEAD` 均为 0 条）：

| 路 | 合入方式 | 复验结果 |
|---|---|---|
| D-01 `p1b-conditionalize` | `--no-ff` 合并（零冲突） | 见 §2.1（4 套件绿 + 变异反证） |
| D-06 `fix-mount-flake` | `--no-ff` 合并（零冲突） | 见 §2.1（enterprise 1145 passed，0 failed） |
| D-04/D-05 `p3-webadmin-variant` | 两次 `--no-ff`（**两个登记表冲突，见下**） | `make -C server webadmin-check-features` ⇒ **exit 0（5/5 变体）**；`make -C server webadmin-variant-tests` ⇒ **exit 0（4 个非缺省变体，791/791）** |

### 合并冲突与解法（登记表类冲突的正确解法）

`scripts/check-root-guards.mjs`（摘要表）与 `scripts/check-workflows.mjs`（判据步骤策略/词表/登记表）**两路都在同一个位置追加条目** ⇒ 冲突。解法=**并集**，且摘要必须**重算**：

1. `check-workflows.mjs`：两侧的策略对象/词表条目/`REQUIRED_CI_STEPS` 登记项**全部保留**（`ci-check-go-build-tags` + `ci-webadmin-variant-tests` + `ci-webadmin-check-features`），并随并集把下界常量 `SELFTEST_PINNED_STEP_COVERAGE_ASSERTIONS` 从 `1 + 14` 复算成 `1 + 15`。
2. `check-root-guards.mjs`：**不许取任何一侧的旧摘要**（合并后的脚本是并集，两边摘要都不对）。用 `node scripts/check-guard-parser-integrity.mjs --print-digests` 在**合并后的工作树**上重算 —— `check:workflows` 实测落到 `a2362e82…ff01`（既不是 p1b 的 `c2db38d1…`，也不是 p3 的 `ee0d0dfa…`），`check:ci-scripts` 与 p3 侧一致（p1b 没动那个脚本）。
3. 复验：`check-guard-parser-integrity` / `check-workflows` / `verify-ci-scripts` 三个自证守卫**各自 exit 0**，根守卫 17/17。

### 合并后**新发现并已修**的集成缺陷（本轮最大收获）

`server/webadmin/src/lib/capability-endpoints.spec.ts` 把 `server/internal/router/router.go` 当作"生产路由表"的唯一来源；而 p1b 把 skills/apps/connectors 的 **87 条** `AdminRoute` 声明搬进了按 build tag 分片的 `optional_{skills,apps,connectors}_on.go`。结果：`router.go` 里只剩 64 条基础面 ⇒ 该 spec **5 条锚点红**（"生产路由表缺少锚点 PUT /api/server/admin/shared-skills/:name/enabled" 等）。

- **影响面**：**默认 features 也红** ⇒ CI 的 server job `npm test` 必红（不是变体问题）；`make webadmin-variant-tests` 只是最先撞上它的那一步 ⇒ 这条是"四路各自绿、合起来红"的典型。
- **修法**：声明集改为 `router.go` + 三个 `_on.go`（推导链仍只从 `router.go` 取，避免误命中），并加**分片棘轮** —— `readdirSync` 发现自己没登记的 `optional_*_on.go` 即抛错（防"新模块的路由"再次静默掉出对拍面）。
- **反证**：把 `optional_skills_on.go` 里那条 `PUT /shared-skills/:name/enabled` 的**路径串**改成 `…-PROBE` ⇒ 该锚点当场红（exit 1）；恢复后 12/12 绿、`webadmin-variant-tests` 4/4 变体 791 用例绿。
  （注：先试过"把整行注释掉"，**变异无效** —— 该解析器是**纯文本正则**，注释里的 `AdminRoute(...)` 照样被匹配；变异必须动**可被解析的文本**。）

### D-07 `p2-client-variant-pack` 审计定案（需修后合入，修复轮进行中）

独立审计（只读，报告 `temp/p2-client-variant-pack/audit-tmp/R2-AUDIT.md`）三条怀疑**全部成立**，且都有真跑证据：

| # | 判定 | 证据（真跑） | 严重度 |
|---|---|---|---|
| S1 | `connectors` 关不掉：`packages/host/browser/package.json` 的生产依赖把整包带进 asar | 真跑 electron-builder `--dir` ⇒ **exit 1**「connectors 仍随包」；收集器证据 `dsh-browser → dsh-connectors` | **P0**（对该提交声称的能力；表现是 fail-loud，无坏包） |
| S2 | prebuild 的变体跳过读**上一轮**清单，且 `DSH_PREBUILD=force` 覆盖不了（`prebuild-workspace-deps.ts:599-602` 的 `continue` 排在 `!force` 之前） | 带 `force` 真跑整轮，`capability-center` 从未出现 `building (forced)` | P1 |
| S3 | 缺席判据的权威是**临时清单**（`verify-packaged-runtime.ts:2166/2265`），清单缺失 ⇒ 关闭臂整体消失 ⇒ **静默假绿** | 真实 asar（整包都在）+ 声明 false + 清单缺失 ⇒ 判据**全过** exit 0 | P1（假绿方向，最危险） |

另有三条 P2（物理布局死分支 / `currentChannelVariant()` 死导出 / `packages: []` 的摘抄面同义反复断言）与提交信息用例数漂移。**最小必修集**见报告 §"最小必修集"（4 条，含文件:行号）。

## 3. 已确认**不需要动**的项（避免下一会话重复劳动）

- p1b 的 `COMBOS` 矩阵已从 `packages/host/desktop/scripts/channel-constants.ts` **派生**（8 组合，`server/scripts/check-go-build-tags.mjs:153-174`），旧审计的"矩阵只有 5/8"已失效。
- p1b 的关闭态反向断言已升级为**登记级**（`cmd/server/routes_source_test.go` 键集合由 `features.AllModules()` 派生）+ **位置级**（`internal/router/optional_*_off_registration_test.go`）。
- p1b 的 `check-tags` 已真接进 CI：`.github/workflows/ci.yml:1007` `node scripts/check-go-build-tags.mjs --expect-cut`，且载荷被 `check-workflows.mjs` 的 `ci-check-go-build-tags` 策略钉住（`if: false` / 换命令 / 去掉 `--expect-cut` 三种形态都红）。`server/Makefile` 那句"CI 已单列一步"的说法已随该步落地而成真。
- p3 的 CI 步骤登记已完成（`b339675a7b`）：`server` job 已接 `make webadmin-variant-tests` + `make webadmin-check-features`（见 `server/AGENTS.md` 的 job 结构段）。

## 4. 收口记录（2026-10-14 08:0x，**四路已全部并入 + 转正**）

**终态**：`feat/p0-integration` = `a59d5fff7e`（四路 `git log <branch> --not HEAD` 均为 **0**），PR **#181 已转正**（`isDraft=false`，base `master`，MERGEABLE）。

### 4.1 本地全量门禁（集成态，逐条退出码 0）

| 面 | 命令 | 结果 |
|---|---|---|
| gate job | `yarn check` | **34/34 任务**（planned=34 executed=34） |
| 根守卫 | `check-root-guards.mjs` | **17/17** |
| 摘要自证 | `check-guard-parser-integrity.mjs`（CI 用 `--require-clean`） | 0（17 条守卫摘要一致） |
| 域守卫 | `check-no-real-domains.mjs` | 0 |
| server job | `gofmt` / `make -C server check-tags` / `go test ./internal/router/... ./cmd/server/...` | 0 / **8 组合全过** / 0 |
| server job | webadmin `npm test`（默认）/ `make webadmin-variant-tests` / `make webadmin-check-features` | **795 过** / **4 变体 791 过** / **5/5 变体** |

### 4.2 CI（GitHub Actions）

push 事件 run `38488267748` 与 PR 事件 run `38488275691` **全绿**：`Gate (root guards)` / `Gate (tests + workspace build)` / `Go server` / `Desktop (Linux|Windows installer|macOS)` / CodeQL 全部 pass。

### 4.3 三条"合起来才炸"的教训（都是本轮真踩到的）

1. **跨端对拍会因搬家静默缩面**：p1b 把 87 条 `AdminRoute` 声明搬进 `optional_*_on.go` 后，webadmin 的 `capability-endpoints.spec.ts`（只读 `router.go`）5 条锚点红，**默认 features 也红 ⇒ CI 的 `npm test` 必红**。四路各自绿、合起来红 —— 所以"每一路自己跑过全量门禁"不能替代**集成态**跑一次。修法：声明集 = 所有含 `AdminRoute(` 声明的文件（加剥注释 + 声明面棘轮）。
2. **`check-install-integrity` 不在 17 条根守卫里**：它是 `ci.yml` 里 **yarn 之前**那一步（"Judge execution bodies are pristine"）。本轮两次被它抓到（F2 新增 `tsconfig.tests.json`、p2 新增 `channel-variant.ts` 都未登记）—— **本地 `yarn check` 全绿不等于这一步绿**。改动面涉及任何"执行体"（包内 `scripts/*.ts`、`tsconfig*`、`vitest.config`、Makefile、npm 项目 manifest）后，必须单独跑一次 `node scripts/check-install-integrity.mjs`。
3. **摘要链是链式的**：`check-install-integrity.mjs` 的内容摘要登记在 `check-guard-parser-integrity.mjs`，后者又登记在 `check-root-guards.mjs`。改前者必须**同批**顺着链条改到 `check-root-guards.mjs`（取值用 `sha256sum <file>` 的工作树那份；`--print-digests` 在脏树时打印的是 HEAD 那份，会误导）。

### 4.4 本地跑 Go 的正确姿势（踩过坑）

`/root` 只读 ⇒ Go 写不了 `$HOME/go/pkg/sumdb`；`go.mod` 要 1.26.6 而系统 go 是 1.26.5 ⇒ 工具链切换会失败，**并且会伪装成源码编译错误**（曾误报 `undefined: ConnectorsAPI`、`[apps,connectors] go build 失败`）。正解：直接用模块缓存里已解包的 toolchain（`PATH=<GOMODCACHE>/golang.org/toolchain@v0.0.1-go1.26.6.linux-amd64/bin:$PATH` + `GOTOOLCHAIN=local`），见 `temp/fix-round-20261014/goenv.sh`。CI 用 `go-version-file: server/go.mod` 精确装 1.26.6，不受影响。

