# 门禁判据的「定义权」：现状、可用收口与本仓的取舍（2026-09-25）

- 背景：第十三轮审计 D 泳道 §8（对抗证伪）与 CHARTER 的 P0-3。
- 结论一句话：**`on: pull_request` + 按 `(context 名, app_id)` 匹配必需检查 ⇒「判据的定义版本」
  就是「被审版本」**；本仓目前**没有任何结构性收口**；本文给出三级台阶、现行可用手段、
  以及**为什么本仓刻意不做整仓 `pull_request_target` 迁移**，最后是**待人工执行**的设置项。
- 本文不改任何仓库设置，也不改任何 workflow 的触发形态（那两件事都要人来拍）。

## 1. 机制（不是推测：官方文档逐字 + 本仓分支保护原始 JSON）

1. **用哪份 workflow 文件**：`pull_request` 事件跑的是 **PR merge commit 里的那份 workflow**
   （官方 Securely using `pull_request_target` 逐字："it runs the workflow file from the merge
   commit of the pull request"），其 `GITHUB_SHA` = merge commit、`GITHUB_REF` = `refs/pull/N/merge`。
   ⇒ **PR 改 `.github/workflows/ci.yml` 就是改"判据的定义版本"。**
2. **分支保护按什么匹配**：按 **(context 字符串, app_id)**。本仓 5 个必需 context 全部绑在
   `app_id = 15368`（`GitHub Actions` 这个 app，不是某个 workflow、也不是某个 job）。
3. ⇒ **保留 5 个 `jobs.<id>.name:` 字符串、把 job 体换成 `echo ok`，5 个必需检查全绿，
   而仓内每一条静态判据都跑在同一个可被替换的 workflow 里**（它们不会红）。
   代价比"运行期改写判据（R13-D-01）"和"换启动器（R13-D-02）"都**更低**：零技巧、零权限。
4. 现状字段（`gh api repos/<owner>/<repo>/branches/master/protection`，2026-09-25 取值）：
   `required_approving_review_count: 0`、`require_code_owner_reviews: false`、无 `CODEOWNERS`
   （本次已补，见 §4）、`rulesets: []`、`rules/branches/master: []`。

## 2. 三级台阶（谁被击穿）

| 台阶 | 被击穿的东西 | 收口件 | 状态 |
|---|---|---|---|
| R12 | 判据**本体**不被改写（install 期改写 `scripts/check-*.mjs`） | `check-install-integrity.mjs` 前置校验 + 执行体按 HEAD 恢复 + 凭据通道 | 第十二轮已修 |
| R13-A | 判据**执行**（同一 job 内仍有仓内执行点 / 换 `node` 启动器） | `--restore`、`check-guard-parser-integrity --require-clean`、**冻结启动器**（本轮）、`HEAD == $GITHUB_SHA` 平台锚（本轮）、远端对象库锚（本轮） | 本轮收口 |
| R13-B | 判据**还能不能被调用**、以及它是不是**被审提交自己定义**的 | 需要**平台侧**配置（本节 §3/§4）；代码侧只能"提高门槛" | **本仓未收口** |

**关键关系**：B 是 A 与 R12 的**前提**，不是替代 —— 只要承载判据的 job 本身可以被换掉，
A 与 R12 的收口都可以整体绕过。反过来，B 成立也不能替代 A（可信 workflow 里跑的仍是 PR 的
代码与 PR 的判据脚本）。

## 3. 现行可用的结构性收口（逐条核实过语义与代价）

| 手段 | 现行语义 | 本仓能否用 / 取舍 |
|---|---|---|
| **必需检查绑到「指定 app」** | 官方（Available rules for rulesets）：可以指定 status check 的**期望来源 app**；"If the status is set by any other person or integration, merging won't be allowed." | **最强的一条**，但要求有一个**非 GitHub Actions** 的 app（自建 GitHub App / 外部 CI）来发 check run。本仓是开源仓 + 自托管产品：多一台 CI + 一个 App + secrets 的运维成本是真实的。**未采用**，登记为可选终极形态。注意：本仓当前**已经**把 5 条必需检查绑到了 app —— 只不过绑的是 `15368 = GitHub Actions`，也就是 PR 自己能编程的那一个。 |
| **`pull_request_target` 定义的可信工作流** | 官方：workflow 与未指定 `ref` 的 `checkout` **取自默认分支**，因此"只有可信代码在跑"；其 `GITHUB_SHA` = 默认分支头 | **能，但本仓刻意不做整仓迁移**（§3.1）。若做：跑 PR 代码的 job 必须与判定/建 check run 的 job 分离（前者 `contents: read`、无 secrets），否则就是官方点名的 pwn-request 形态。 |
| **rulesets 的 required workflows** | **已 sunset**（2023-10-18 起 github.com 上不可用；现行文档里 "workflow" 出现 0 次） | **不可用**，不要再写进方案。仅 GHES 3.11+ 保留。 |
| **`workflow_run`** | 只看默认分支上的 workflow 定义 | 只能做**带外检测**（评论/关 PR），**不能**直接充当 PR 的必需检查（check run 落在默认分支提交上）；且官方明说不要把上游 run 的 artifact 当真值。 |
| **ruleset 的路径级必需审批**（`required_reviewers.file_patterns` + `minimum_approvals`） | 平台强制：匹配这些路径的 PR 必须拿到指定团队的 N 个审批 | **能，且是最便宜的一步**：对 `.github/**`、`scripts/**`、`patches/**`、`yarn.lock` 要求 ≥1 审批。代价：要建组织团队 + 配 ruleset（§4.2）。 |

### 3.1 为什么**不**把整仓迁移到 `pull_request_target`（本仓的取舍，写清楚）

1. **必需检查不会自动出现在 PR 上**：`pull_request_target` 的 check run 落在**默认分支提交**上 ⇒
   必须在可信 workflow 里用 Checks API 对 PR 的 head/merge SHA **自己创建同名 check run**。
   这是一段**新的、承重的**代码（写错 = 门禁静默失效或永久 pending），而它本身也只被评审看着。
2. **`ci.yml` 是 1500 行、9 个 job、几十个步骤**（三平台打包、mac 签名/公证、R2 发布、
   渠道构建）。整仓迁移意味着这些步骤的 `checkout` 语义、secrets 可用性、artifact 上传、
   `needs:` 拓扑**全部要重新论证一遍** —— 收益是"定义版本与被审版本分离"，代价是一次
   高风险重构，而重构期间的**门禁可靠性是下降的**。
3. **本仓的真实威胁模型是"协作者账号/被盗账号"**，不是"陌生 fork PR"：fork PR 本来就要
   维护者点一次 "Approve and run workflows"；有 write 权限的人才是零成本路径。而这条路径
   **`pull_request_target` 也挡不住**（他同样可以改分支保护之外的东西，见 §3 第一行的残留风险：
   非 fork 的 write 协作者的工作流同样以 `15368` 身份运行）。
4. **性价比更高的中间态**：`CODEOWNERS`（本次已加）+ 开 `require_code_owner_reviews`
   （或 ruleset 路径级审批）。它把"评审"从口号变成**平台强制**，成本是两次 `gh api` 调用。
5. 因此本轮的选择是：**做 1（人工闸门）+ 3（代码侧提高门槛）**，把 2/4 写成待人工决策项，
   不擅自改触发形态。

## 4. 待人工执行（**当前未闭环**，主控/仓库管理员执行）

以下命令都只读或只改**仓库设置**（不是代码）。执行前请确认 `gh` 有 `admin:repo` 权限；
本机 gh 需要 `XDG_CACHE_HOME` 指向工作区内的可写目录。

### 4.1 建团队并把 CODEOWNERS 的占位换成真实负责人

```bash
# 1) 建团队（组织管理员）
gh api -X POST orgs/<owner>/teams -f name=gate-owners -f privacy=closed
# 2) 加成员（把 <login> 换成真实账号）
gh api -X PUT orgs/<owner>/teams/gate-owners/memberships/<login> -f role=member
# 3) 建好之后，把 .github/CODEOWNERS 里的 @<owner>/gate-owners 换成真实团队
```

### 4.2 开启「按 CODEOWNERS 审批」与「至少 1 个审批」

```bash
# 形态 A：分支保护（影响 master 的全部 PR）
gh api -X PATCH repos/<owner>/<repo>/branches/master/protection/required_pull_request_reviews \
  -F required_approving_review_count=1 -F require_code_owner_reviews=true -F dismiss_stale_reviews=true
```

```bash
# 形态 B（推荐，只对判据面要求审批）：ruleset + 路径级 required_reviewers
cat > /tmp/gate-ruleset.json <<'JSON'
{
  "name": "gate-definition-authority",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/master"], "exclude": [] } },
  "rules": [
    { "type": "required_reviewers",
      "parameters": {
        "required_reviewers": [
          { "minimum_approvals": 1,
            "file_patterns": [".github/**", "scripts/**", "patches/**", "yarn.lock", "package.json", ".yarnrc.yml"] }
        ]
      } }
  ]
}
JSON
gh api -X POST repos/<owner>/<repo>/rulesets --input /tmp/gate-ruleset.json
```

**副作用（要知道）**：形态 A 会让**每一个** PR 都需要一个非作者的审批（含文档 PR）；
形态 B 只对匹配路径的 PR 生效，但 `required_reviewers` 的 `file_patterns` 是 fnmatch，
改路径结构时要同步维护。两者的共同点是：**审批人必须在平台侧真的有写权限**，否则
GitHub 视为"没有 code owner"。

### 4.3 （可选，终极形态）把必需检查的来源换成非 GitHub Actions 的 app

需要：一个装在本仓、带 `statuses:write` 的 GitHub App（或外部 CI），并且它**先**提交过同名
check run（官方要求"must have recently submitted a check run, and must be associated with a
pre-existing required status check"）。换完再把 `ci.yml` 里那 5 个 job 的 `name:` **改名**
（让 PR 侧再也产不出必需 context）。成本最高、结构最强，先不做。

## 5. 代码侧本轮做了什么（提高门槛，**不是**结构性收口）

1. **`.github/CODEOWNERS`**（新增）：把"判据面"写成可评审的清单（`.github/**`、`scripts/**`、
   `packages/*/*/scripts/**`、`.yarnrc.yml`、`package.json`、`yarn.lock`、`patches/**`、
   `packages/*/*/vitest.config.ts`）。**注意**：负责人是**占位团队**，团队不存在时本文件
   不产生任何强制（fail-safe，不会挡合并）—— 所以它是"待人工执行"的一半，不是闭环。
2. **平台锚**（R13-D-01）：`check-install-integrity.mjs` 断言 `git rev-parse HEAD == $GITHUB_SHA`
   （不等即退出码 2），该值进 `--json` 摘要与 VERDICT 行；CI 侧 `check-verdict-credential`
   用 `--expect github-sha "$GITHUB_SHA"` 把它逐字钉进通过凭据；`check-guard-parser-integrity.mjs`
   再把它从 `origin@$GITHUB_SHA` 取回（远端对象库锚）。
3. **冻结启动器**（R13-D-02）：判据 job 的第一个执行体把 `command -v node/bash/git` 的绝对路径
   与当时的 `$PATH` 写进步骤输出（runner 侧持有，后续仓内进程改不到），后续判据步只用冻结值；
   静态判据 `[SK-20]` + 行为探针 `scripts/check-frozen-launchers.mjs`（自带正控）。
4. **诚实边界**：以上都**不能**让"判据的定义版本 = 被审版本"成立。它们的作用是
   **让"保留 job 名换 body"这条路径在诚实 workflow 下不再足以伪造绿**（因为判据本体、
   启动器、平台锚三层都被钉住）—— 但只要 workflow 文件本身可以被替换，这三层就整体失效。
   要真正收口，必须做 §4 里的平台设置。

### 5.1 冻结启动器的**覆盖面**：哪些 job 有冻结点、哪些没有、残余攻击面是什么

**本节是 2026-09-25 第十四轮审计（lane B 的 B-06）之后补的第二条诚实边界 —— 原文只写了
"`yarn`/`corepack` 仍按活 PATH 解析"，没有写"哪些 job 根本没有冻结点"。不要把它读成"已完全收口"。**

`ci.yml` 里 `id: frozen-launchers` 只出现 **2** 次：`gate-guards`（第 2 步）与 `gate`（第 3 步）。
登记表 = `scripts/check-workflows.mjs` 的 `FROZEN_LAUNCHER_JOBS`（单一真源；行为探针 import 它）。

| job | 有冻结点 | 该 job 里的仓内执行点 | 当前判定 |
|---|---|---|---|
| `gate-guards` | ✅ | 5 个判据步（含行为探针本身） | 已收口：PATH 复位 + 逐判据步金丝雀 |
| `gate` | ✅ | 7 个判据步（含三条 tag-only 步与 `Full gate`） | 同上 |
| `changes` | ❌ | `git diff` 分类器（纯 shell + `$GITHUB_OUTPUT`） | 不跑判据、不产出交付物 ⇒ 只读影响分类结果 |
| `server` | ❌ | `npm ci`（`server/webadmin`）+ `go vet`/`go test`/`make build-server` | **真正的绕过点**：`needs: changes` 绕开 `gate-guards`，且 npm 侧安装面不在任何安装期判据里（R14-08，由另一条泳道收口） |
| `desktop-linux` / `-windows` / `-macos` | ❌ | `bash scripts/ci-*.sh`、`yarn workspace … dist:*` | 由 `needs → gate → gate-guards` 挡在后面；job 内仍是裸解释器 |
| `release` | ❌ | `bash scripts/ci-release-policy.sh`、裸 `node scripts/version.mjs`、**唯一的 R2 写入步** | "纵深为零"而非"已被绕开"：`needs` 挡在 `gate` **与** `server` 之后，且它**一次 install 都没有**、第一个仓内执行点是纯 `test -f` ⇒ 此前没有任何能写 `$GITHUB_PATH` 的仓内代码 |
| `pr-summary` | ❌ | PR 评论（fork PR 跳过） | 不跑判据、不产出交付物 |

**残余攻击面（如实记账）**：上面 5 个无冻结点的 job 里，同 job 内更早的步骤若能写
`$GITHUB_PATH`（唯一的现实入口是安装期钩子，见 R14-08），就能替换那些 job 里的裸解释器；
**没有任何判据读这条通道**。当前可接受是因为"交付通道"（`release`/`desktop-*`）被
`needs → gate → gate-guards` 挡着，而唯一绕开这条链的 `server` 不产出交付物 —— 这只是
**纵深**，不是收口。要真正收口得给这几个 job 也加冻结点（每个 job 两步 + 一处登记），
或把 npm 侧纳入安装期判据（R14-08）。

### 5.2 tag-only 三条判据步的执行覆盖（口径，2026-09-25 第十四轮 lane B 更正）

`gate` 里有三条**只在 tag 上才真正有用**的判据步：`Classify the release tag (single source of truth)`、
`Release topology (previous release tag is an ancestor; tag is on the mainline)`、
`Resolve the channel packages revision (once per run)`。

- **已被覆盖的一半**：`[SK-20]` 把它们算进 `gate` 的 7 个 PATH 复位判据步；行为探针
  `scripts/check-frozen-launchers.mjs` 的**逐判据步金丝雀**格子每个 PR 都会把这三条步骤体的
  **原字节**在 scratch 金丝雀仓里跑两遍（各自一次 + "只冻结解释器、不复位 PATH"的正控 B 一次），
  冻结输出缺席/为空时它们以 **127** 失败（`bash: 行 1: : 未找到命令`，配 `set -euo pipefail` ⇒ 红）。
- **没有被覆盖的一半**：**真 tag 参数组合** —— `GITHUB_REF_NAME` 是真 tag、
  `docs/releases/<tag>.md` 在位、`origin` 上真有那批 tag。探针只喂
  `GITHUB_REF=refs/heads/main` 这类非 tag 输入。
- ⇒ 正确表述是"**步体已被 canary 级行为探针覆盖；真 tag 参数组合是它第一次真跑**"。
  **不要**写成"从未在任何真实运行里执行过"（那是过头话：它们的步骤体确实每个 PR 都在跑）。
