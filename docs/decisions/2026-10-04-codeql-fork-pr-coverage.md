# 决策：fork PR 上 CodeQL 不跑（覆盖为零）——风险登记与接受理由（2026-10-04）

> 触发这条决策的是 2026-10-04 回归审计的 **D-01**：跳过本身是有意的，问题在于文件注释把
> "覆盖缺口"写成了「覆盖由合并后的 push 分析保留」，读起来像"覆盖还在"。
> 修复轮第一版又把机制写成「`Analyze (…)` 是分支保护的**必需检查** ⇒ skipped 被记成成功」——
> **这一句与实时事实不符**（见下面「机制勘误」，2026-10-04 对抗验证纠出后按实时采样改写）。
> **结论不变**：fork PR 上 CodeQL 覆盖为零，只是被推迟到合并之后。

## 背景

`.github/workflows/codeql.yml` 的 `analyze` job 带 job 级条件：

```yaml
if: github.event_name != 'pull_request' || !github.event.pull_request.head.repo.fork
```

fork PR 的 `GITHUB_TOKEN` 只有只读权限，拿不到 `security-events: write` ⇒ SARIF 上传必然失败。
所以 fork PR 上**明确跳过**，而不是给 analyze 步骤加 `continue-on-error`（那会把真实失败
一起吞掉）。跳过这个动作本身是 2026-09-22 迁移到高级配置时就定下的（提交 `52d68689cb`）。

## 机制勘误（2026-10-04，实时 API 采样）

修复轮第一版写的是「`Analyze (…)` 是 master 分支保护的必需检查，而 GitHub 把 skipped 的
必需检查记成成功 ⇒ fork PR 可在零覆盖下合并」。**前半句不成立**，后半句于是也不适用：

| 采样（2026-10-04，两次） | 结果 |
|---|---|
| `gh api repos/picoaide/picoaide-harness/branches/master/protection --jq '.required_status_checks.contexts'` | `["Gate (tests + workspace build)","Go server","Desktop (Linux)","Desktop (Windows installer)","Desktop (macOS)"]` —— **5 条，不含任何 `Analyze (…)`** |
| `gh api repos/picoaide/picoaide-harness/rulesets` | `[]` |
| `gh api repos/picoaide/picoaide-harness/rules/branches/master` | `[]` |
| `gh api "repos/picoaide/picoaide-harness/commits/master/check-runs?per_page=100" --jq '.check_runs[].name'` | 4 个 `Analyze (...)` 会出现在 check-runs 里，但**不在**上面的必需集里 |

仓内反证：`docs/planning/2026-09-19-wasm-client-only-findings-ledger.md` 逐字写着
「CodeQL（非必需检查，不阻塞合并）」。

⇒ 正确表述：**`Analyze` 不在合入门槛里** —— 与分支保护无关，风险就是**覆盖缺口本身**。
"skipped 的必需检查记成成功"这条 GitHub 语义本身没错（本仓 `ci.yml` 的 `gate-guards`
注释记过它），但**本仓没有任何必需检查会被那条语义影响**，不要把它当成这条风险的机制。

## 风险（据实登记，不粉饰）

1. `analyze` 的 job 名是 `Analyze (<language>)`（矩阵 4 个语言分片）。fork PR 上这 4 个分片
   **全部被 job 级 `if` 跳过** ⇒ 该 PR 上**零 CodeQL 查询**；
2. fork PR 上真正跑的门禁（Gate / Go server / 三平台打包 —— 也就是全部 5 条必需检查）
   **不含任何 CodeQL 查询**："还有别的门禁"不能减轻这条风险；
3. 两条合起来 ⇒ **fork PR 可以在零 CodeQL 查询覆盖的情况下合并**。合并进 master 的那次
   `push` 才会分析它：覆盖不是"被保留"，只是被**推迟到合并之后**（告警出现时，代码已经进入主线）。
   注意这**不是**"合入门槛放行"造成的 —— CodeQL 本来就只挂在 push / PR / 定时三条触发面上，
   而 PR 面在 fork 上被有意关掉。

## 决策：维持现状（不给 fork 也跑），但让风险可见

- **触发面不变**：master 的 `push` + 所有 PR + 每周定时（与 GitHub 默认设置逐项对齐的口径不动）。
- **不改 job 条件**：真正想让 fork PR 有覆盖，只有两段式一条路 —— `pull_request` 段只做分析、
  把 SARIF 落 artifact，`workflow_run` 段用 base 仓的写权限上传。那是**另一笔成本**
  （fork PR 上跑完整 4 语言分析 + artifact 交接 + 第二段 workflow 的维护面），本次不承担。
- **接受理由（明确写下来，便于日后翻案）**：
  1. 本仓 fork 流量极低（**2026-10-04 采样：4 个 fork**；数字会变，**引用前重新采一次**，
     命令见文末），拿"完整分析 fork PR"换"合并前的 CodeQL 覆盖"在当前比例下不划算 ——
     这是**成本取舍**，不是"覆盖已经够了"；
  2. 合并后的 master 分析仍然覆盖同一份代码（同一 commit 进主线即被扫），
     所以最坏情形是**发现时机推迟**，不是永不发现；
  3. 反过来说，**没有**任何机制保证 fork PR 的代码在合并前被 CodeQL 看过 —— 这一点必须能被
     检索到，而不是只留在某个 workflow 的注释里（本文件就是那个落点）。

## 边界与残留（认账）

- fork PR 合并前零 CodeQL 查询；**`Analyze (…)` 不在 master 的必需检查里**（采样见上表）
  ⇒ 没有"把它从必需检查里摘掉"这种处置可做（修复轮第一版曾把它写成待办，属不实，已删）。
- **这一条靠什么承重（2026-10-04 定案）**：`scripts/check-workflows.mjs` 的 `REGISTERED_JOBS`
  逐字钉住本 job 的 `if:` 取值（"有人偷偷改这个条件"会被门禁抓住）；至于**注释与事实是否
  一致**，本仓**不做机械判据**，由本文件承重。理由（都是实测，出自 2026-10-04 对抗验证）：
  1. 曾写过一个候选判据「该 job 的注释块里必须出现字面词 `fork`」：它对**目标缺陷零杀伤**
     —— D-01 修复前的原句本身就含 "fork"（判据 `EXIT=0`），换一句含 `fork` 的假话也
     `EXIT=0`；
  2. 它会对**如实改写**报假红 —— 注释改成"外部贡献者提交的 PR：令牌只读，跳过分析…"这种
     不含 `fork` 的准确表述时判据 `EXIT=1`；
  3. 它还会把**注释措辞变成硬约束**（奖励"保留那个词"，而不是"说对事实"）。
  ⇒ 与其用一条只钉文本、不钉语义的判据制造假红与假安全感，不如把**风险、实时采样命令、
  接受理由**都写在本文件里，让每次改动都落在评审视野内（本仓对承重文本的一贯做法）。
  若日后确实需要机械判据，可用的形态是「**整段注释逐字登记**」（改措辞 = 登记值一起改、
  diff 可见）：它能咬住"注释被悄悄改小/删掉"，**咬不住**"注释还在但说的是假话"，
  且需要改 `scripts/check-workflows.mjs`（2026-10-04 修复轮该文件属别的泳道，未越界修改）。
- 与本站无关但容易混：docs-only 的 PR 上 `Gate` 被跳过是**另一个**决策
  （[只改文档时跳过全量 CI](2026-09-17-docs-only-ci-skip.md)），那条路径已有
  `gate-guards`（永不跳过）兜住文档面守卫；CodeQL 没有等价的"永不跳过"兜底。

## 复核方式（不需要 fork PR 也能做）

```bash
# 1) 条件与"跳过"这件事本身
grep -n "head.repo.fork" .github/workflows/codeql.yml
node scripts/check-workflows.mjs          # REGISTERED_JOBS 对 analyze 的 if: 逐字登记
# 2) 合入门槛里到底有没有 Analyze（2026-10-04 采样：5 条，不含 Analyze；数字会变，重新采）
export XDG_CACHE_HOME=$PWD/temp/gh-cache
gh api repos/picoaide/picoaide-harness/branches/master/protection --jq '.required_status_checks.contexts'
gh api repos/picoaide/picoaide-harness/rulesets
# 3) fork 流量（决定上面那条"成本取舍"是否仍然成立）
gh api repos/picoaide/picoaide-harness/forks --jq 'length'
```

**改这份文件或 `codeql.yml` 注释时的动作**：三处（`codeql.yml` 文件头、`codeql.yml` 的
job 注释、本文件）说的是同一件事，改一处就三处一起改；**不要**把 `Analyze` 写成必需检查。
