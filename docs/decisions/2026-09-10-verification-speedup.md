# 2026-09-10 验证门禁提速（本地 + CI）

## 背景

开发循环里 `corepack yarn check`（JS 门禁）与 `cd server && make check`（服务端门禁）合计要等 **~10.5 分钟**，
且大量时间是"一个核在跑、其余三个闲着"以及"同一份产物被重复构建"。目标是**在不降低任何一门检查覆盖面的前提下**把等待压到一个量级以内。

所有数字都是 2026-09-10 在 4 核 / 11GB 开发机上实测（PG 18 容器 `pg-test`，`PG_DSN_TEST` 指向 `picoaide_test`）。

## 诊断（改造前）

### 服务端 Go：绝对大头

| 场景 | 耗时 |
| --- | --- |
| `go test ./internal/... ./cmd/... -count=1 -p 1`（CI 用的串行模式） | **431.2s** |
| 同上，`-p 4` | 283.4s |
| webadmin `npm test` + `npm run build` | 21.7s + 16.6s |

根因不是测试逻辑慢，而是**每个 DB 用例都在重放整个迁移史**：628 个用例里有 355 个 ≥1s；`NewTestDB` 共 99 处调用点，
每处都 `CREATE DATABASE` → 跑 52 个迁移（每条一个事务）→ 再建 24 个 usage 分区，固定开销 **~1.5s/用例**
（例如 `TestUploadValidation` 这种纯校验用例也要 3.04s）。三个重包 serverstore / llmgateway / serverauth 分别
189.6s / 174.8s / 160.2s，其中绝大多数是这套建库成本。

### JS/TS：结构性重复劳动

| 项目 | 耗时 | 问题 |
| --- | --- | --- |
| `dsh-plugin-desktop` `verify:profile` | **50.7s** | 内含 `prebuildWorkspaceDeps()`，把 desktop + 其余 7 个包**重新构建一遍**（~40s），而本轮 `check` 刚刚构建过 |
| 7 个插件包 `check`（串行） | 合计 ~74.5s | 串行单核；且每包 `check = build && typecheck && test` 中 `typecheck` 与 `build` 用的是**同一个 tsconfig**（只差 `--noEmit`）→ 白跑一遍 tsc |
| `dsh-plugin-desktop` `typecheck` | 14.0s | 4 个 tsc，其中 `tsconfig.json` / `tsconfig.client.json` 两遍已被同轮 `build` 覆盖 |
| 根 `check` | 串行 `&&` 10 个包 | 没有依赖建模，纯排队 |
| 每次 `yarn …` 调用 | ~0.4s 启动 | 全门禁约 40 次调用 |

## 改造

### 1) 测试库改为「模板库克隆」（`server/internal/serverstore/dbtest.go`）

- 模板库名 = `picoaide_tmpl_<sha256(迁移内容 + 分区窗口)前12位>`，缓存在同一个 PG 实例里。
  迁移改动或跨月（分区窗口右移）会自动换名，旧模板不会被误用。
- 首次构建模板用 `pg_advisory_lock` 串行化（跨包 `-p N` 也只建一次），建好后 **必须在释放锁前断开模板库连接**
  （否则并发 `CREATE DATABASE … TEMPLATE` 会报 `source database is being accessed`）。
- 之后每个用例 = `CREATE DATABASE picoaide_test_<rand> TEMPLATE <模板>`，文件级克隆 ~0.1s。
- 任何一环失败（无权限、克隆失败、`testMigrationHook` 替换了迁移集合）**自动回落到原来的「空库 + 全量迁移」路径**，
  测试语义不变；模板构建失败会删掉半成品，避免后来的进程克隆到不完整 schema。
- `ensureTestPartitions` 与新加的 `testPartitionWindow()` 共用同一窗口定义，防止"模板库分区"与"实际需要的分区"漂移。
- `newFreshDB`（迁移测试要的真空库）不受影响。

### 2) JS 门禁并行编排（新增 `scripts/check-workspaces.mjs`）

`yarn check` 改为调用该编排器，语义不变（跑的仍是每个包自己的 `check`）：

- 阶段 1：`dsh-plugin-desktop check` + 三个根守卫并行。desktop 内部的 `verify:profile` 会按需构建其余插件包，
  此刻不跑那些包自己的 `check`，避免和 profile 冒烟争抢同一份 `lib/`。
- 阶段 2：**依赖感知调度**（不是简单分组）。实测得到的构建依赖：
  `enterprise`/`connectors`/`cron` 的 tsc 读 desktop 的 `lib/types`；`account-card` 读 `enterprise`；
  `browser` 读 `connectors`。这些边**必须串行**——`enterprise` 的 tsdown 是 `clean: true`，
  并发读取它的包会在那个窗口里报 `TS7016 Could not find a declaration file`（第一版并行就踩到了）。
- 依赖失败的包直接标记 `⊘ 跳过(依赖未通过: …)`，不再产生成串的级联报错。
- 并发默认 `min(4, CPU)`，`CHECK_CONCURRENCY` 可覆盖；`--only a,b` 跑子集；`--list` 打印依赖图。
- `yarn check:fast` = `--changed`：把 `git diff` + 未跟踪文件映射到包（顶层文件改动自动升格为全量），
  只跑受影响的包及其反向依赖（desktop 改动会带上 enterprise/account-card/branding）。

### 3) 预构建增量化（`packages/host/desktop/scripts/prebuild-workspace-deps.ts`）

每个包构建前先判定：**最旧产物的 mtime ≥ 全部输入的最新 mtime**（输入 = `src/` 递归、`package.json`/`tsconfig*`/`tsdown.config.*`、
desktop 另加 `brands/`、以及依赖包的 `lib/` 产物）→ 否则重建。判定偏保守（缺失/更旧一律重建），
fresh checkout 与 CI 行为与改造前完全一致；`DSH_PREBUILD=force` 强制全量。

### 4) 去掉重复的 tsc

`build` 用的 `tsc --emitDeclarationOnly` 与 `typecheck` 的 `tsc --noEmit` 是同一份 tsconfig、同一批文件，
**诊断完全等价**（已用注入错误的探针实测：同 3 条错误、同样含 `TS6133`）。因此：

- 6 个插件包：`check = build && test`（`typecheck` 脚本保留给单独使用）；
- desktop：新增 `typecheck:tests`，`check = build && typecheck:tests && test && verify:*`
  （tests/tests.client 两个配置确实是 `build` 覆盖不到的，保留）。

### 5) 服务端快速门禁（`server/Makefile`）

- `test-server` 显式带 `-p $(TEST_PARALLEL)`（默认 4；CI 自己的 `-p 1` 是为了容器 `max_connections`，与性能无关）。
- 新增 `test-server-fast`（不带 `-count=1`）与 `check-fast`（= gofmt + vet + fast test + webadmin 单测，**不跑** webadmin 构建）。
  发布/提交前仍以 `make check` 为准。

## 实测结果

### 服务端

| 场景 | 改造前 | 改造后 | 倍数 |
| --- | --- | --- | --- |
| `go test … -count=1 -p 1`（CI 模式） | 431.2s | **121.7s** | 3.5× |
| `go test … -count=1 -p 4` | 283.4s | **116.7s** | 2.4× |
| 同上，源码无改动（Go 结果缓存命中 22/22 包） | — | **0.3s** | — |
| `make check`（含 webadmin 测试 + 构建） | ~322s | **121.9s** | 2.6× |
| `make check-fast`（新增，无改动） | — | **15.6s**（其中 Go ~1s，其余是 webadmin vitest 14.6s） | — |
| 抽样单包 appstore | 22.7s | 2.9s | 7.9× |
| serverstore / llmgateway / serverauth | 189.6 / 174.8 / 160.2s | 26.3 / 24.6 / 37.6s | 7.2× / 7.1× / 4.3× |

> 注：Go 的测试结果缓存对**环境变量敏感**——`PG_DSN_TEST` 设与不设是两个缓存键。快速循环请保持同一套 env。

### JS

| 场景 | 改造前 | 改造后 |
| --- | --- | --- |
| `dsh-plugin-desktop verify:profile` | 50.7s | **15.1s** |
| 8 个插件包 `check`（原串行 74.5s） | 74.5s | **36.4s**（并发 4 + 依赖串行） |
| `prebuildWorkspaceDeps`（产物全新时） | ~40s | **0.08s** |
| 根 `check`（desktop 阶段 ~45s + 阶段 2 ~36s） | ~165s | **~80s** |

> `yarn check` 总时长为分段实测之和：desktop 阶段 = build 5.2s + typecheck:tests ~9.4s + vitest 10.7s + verify 四连 ~18.6s。

## 验证

- Go：`make check` 全绿（gofmt + vet + 全量测试 + webadmin 测试与构建），全量跑**新增 0 个残留测试库**（模板库 10MB 常驻，测试库逐个 DROP）。
- JS：阶段 2 八包 `--only` 全绿；desktop `build` / `verify:profile` / `verify:closure` / `verify:loader` / `verify:licenses` 全绿；
  失败路径实测（desktop 失败 → 5 个下游包 `⊘ 跳过`，独立包照常跑完）。
- 覆盖面未减少：唯一被删掉的检查是"与 build 同配置、同文件的第二遍 tsc"，已用错误注入证明等价。

## 遗留 / 后续可选

- `packages/vendor/memory-evolve` 有 `test` 脚本，但**不在** `yarn check` 链里（改造前后一致，未擅自扩大门禁范围）。
- `dsh-better-sidebar` 的 `check` 不含 `vitest`（其 `tests/` 只有 1 个文件，同样维持原样）。
- tsc 增量缓存（`--incremental --tsBuildInfoFile`）实测能把重复 typecheck 压到 ~2×，但**产物被删而 buildinfo 仍热时会漏产**
  （实测：删掉 `lib/types` 后带热 buildinfo 的 tsc 不再产出 `.d.ts`）——若引入，必须让每个 `clean`/`rm -rf lib` 同时清掉缓存目录，
  本轮未启用。
- 9 个历史遗留测试库（`picoaide_test_<rand>`）来自更早被中断的测试进程，可在 PG 里手工清理。
