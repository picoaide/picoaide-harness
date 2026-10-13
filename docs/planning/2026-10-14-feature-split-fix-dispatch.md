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
| `p2-client-variant-pack` | `4bb53be22a` | `temp/p2-client-variant-pack/wt` | **未完成** | D-07（重放审计 + P0） |
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

### D-07【P0·必修】p2：审计重放 + connectors 关不掉

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

## 3. 已确认**不需要动**的项（避免下一会话重复劳动）

- p1b 的 `COMBOS` 矩阵已从 `packages/host/desktop/scripts/channel-constants.ts` **派生**（8 组合，`server/scripts/check-go-build-tags.mjs:153-174`），旧审计的"矩阵只有 5/8"已失效。
- p1b 的关闭态反向断言已升级为**登记级**（`cmd/server/routes_source_test.go` 键集合由 `features.AllModules()` 派生）+ **位置级**（`internal/router/optional_*_off_registration_test.go`）。
- p1b 的 `check-tags` 已真接进 CI：`.github/workflows/ci.yml:1007` `node scripts/check-go-build-tags.mjs --expect-cut`，且载荷被 `check-workflows.mjs` 的 `ci-check-go-build-tags` 策略钉住（`if: false` / 换命令 / 去掉 `--expect-cut` 三种形态都红）。`server/Makefile` 那句"CI 已单列一步"的说法已随该步落地而成真。
- p3 的 CI 步骤登记已完成（`b339675a7b`）：`server` job 已接 `make webadmin-variant-tests` + `make webadmin-check-features`（见 `server/AGENTS.md` 的 job 结构段）。
