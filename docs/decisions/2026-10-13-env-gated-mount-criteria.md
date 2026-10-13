# 环境受限 mount 判据的覆盖台账 + 本轮修复的归因与关闭口径

**状态**：已实施（**判据面的收紧 + 未覆盖认账**；账户里没有"已覆盖"的假账）
**日期**：2026-10-13
**相关**：[功能模块的 host 面归属](./2026-10-13-module-host-face-ownership.md)（P0-b：本轮的"夹具红"正是它的收尾项）、
[门禁的判定权归属](./2026-09-25-gate-definition-authority.md)、
`packages/host/enterprise/tests/helpers/env-gated-criteria.ts`（登记表本体）

---

## 1. 这一片做了什么（一句话）

承接 `c30721c1e3`（清扫的年龄钳位）与 `f31661f22c`（钳位的 fail-safe 半边 + 环境受限判据登记），
把独立审计（2026-10-13，1×P1 + 4×P2）的四条判据面缺口逐条收口：**登记表的对账面从"一个文件"
扩到整棵 `tests/`**、**把两个只在文本上钉住的消费点提成可执行函数**、**把"未覆盖"从含糊变成
写在仓里的台账**、**把不可复核的归因降级**。第五条（夹具红）同批修掉。

## 2. 覆盖台账：这三条判据在自动化里**一次都不执行**

| 判据 | 位置 | 前置 | CI（托管 runner，非 root）上的状态 |
| --- | --- | --- | --- |
| G1 换入自愈 | `tests/skill-library-anchor-escape.spec.ts` | `mount --bind` | **自跳**（打 `[env-gated:mount/SKIP]`） |
| G2 陈旧 staging 清扫 | 同上 | 同上 | **自跳** |
| K-08 跨设备成因点名 | `tests/audit-r20-skill-library.spec.ts` | 同上 | **自跳**（此前连登记都没有） |

**这是显式认账的未覆盖项，不是"忘了接"。** `.github/workflows/` 里没有任何 job 设
`PICOAI_MOUNT_TESTS`；`privilegedCommand` 是**跑法**而**不是执行者**。登记表能保证的只有一件事：
**自跳不可能被误读成通过**（可检索标记 + 真实原因 + 跑法 + 声明"必须提供"时硬红）。

### 为什么不给特权路径接一个 CI job

托管 runner 上"能不能拿到 `CAP_SYS_ADMIN`"（`sudo mount --bind` 还是
`setpriv --inh-caps=+sys_admin --reuid=<runner>`）**在开发机上无法实测**：本机是 root、
天然有该能力，只能做 **cap-drop 等价模拟**（`setpriv --bounding-set=-sys_admin --inh-caps=-all
--ambient-caps=-all`，与 CI 的非 root 形态同效）。把一个未经验证的特权步骤放进**每次 PR 都跑**
的 `gate` job，赌错就是**全仓门禁永久变红** —— 代价大于收益。这条判断**不是**"做不到"，是
"没验证过就不敢放进必需路径"，处置与边界写在这里而不是留在某次讨论里。

要接的话，形态已经在本机验证过（cap-drop 下三档全对，见 §3 变异矩阵），只剩"托管 runner 是否
真有该能力"这一个未知量。

### 真跑（有 `CAP_SYS_ADMIN` 的机器上，逐字可跑，本轮实测 27 passed / EXIT=0）

```bash
cd packages/host/enterprise
PICOAI_MOUNT_TESTS=required ./node_modules/.bin/vitest run \
  tests/skill-library-anchor-escape.spec.ts tests/audit-r20-skill-library.spec.ts \
  tests/env-gated-criteria.spec.ts
```

反向验证（等价 CI 形态，应当**硬红 3 条**）：

```bash
cd packages/host/enterprise
PICOAI_MOUNT_TESTS=required setpriv --bounding-set=-sys_admin --inh-caps=-all --ambient-caps=-all \
  ./node_modules/.bin/vitest run tests/env-gated-criteria.spec.ts \
  tests/skill-library-anchor-escape.spec.ts tests/audit-r20-skill-library.spec.ts
# ⇒ G1/G2/K-08 各 1 failed，消息含真实 stderr 与前置条件，EXIT=1
```

## 3. 登记表本轮的两处收紧

### 3.1 对账面：从"登记项指名的那个 spec"→ **整棵 `tests/`**（审计 P1）

旧口径取 `join(HERE, entry.spec)` 读文本，于是**同包第三条真 mount 判据**（K-08）既不在面内、
整块删掉也绿（审计变异 M6 实测 `3 passed EXIT=0`）。现在扫描面是 `tests/**/*.spec.ts` 递归全集，
判据四条：

1. 真跑 `mount --bind` 却没登记的 spec ⇒ 红；
2. 用了挂载闸门却没登记的 spec ⇒ 红（"闸门"与"登记"必须成对）；
3. 反向：登记项指名的 spec 必须**真的还在探针面上**（整块删判据 = 登记项过期 ⇒ 也红）；
4. 扫描面下限 `MINIMUM_SCANNED_SPECS`：跌到 50 个以下说明"没扫到文件"而不是"零命中"。

豁免只有 `REGISTRY_SELF_SPEC` 一个**具名常量**（登记表自己的量具），不再是隐式收窄。

K-08 同时改走 `judgeMountGate`（尊重 `PICOAI_MOUNT_TESTS`）并登记，`reasonToken` 钉的是
spec 侧的取证动作 `stderr`。

### 3.2 消费点：从"文本 `toContain`"→ **可执行函数**（审计 P2-2）

`hardFailure ⇒ 硬红`、`缺省 ⇒ 打覆盖声明` 这两行以前散在各 spec 里，判据侧只能数文本 ⇒
整段删掉门禁照样全绿（审计变异 M5/M7 实测 `13 passed EXIT=0`）。现在它们是
`consumeMountGate(verdict, attempt, context, log?)` 一处实现，被真实 spec 调用、也被行为夹具
判决；每个 spec 的 `judgeMountGate(` 与 `consumeMountGate(` 调用数都必须等于该 spec 的登记条数。

新增的第三档：探针失败却给不出**真实原因** ⇒ 也抛错（"跳过"不得退回静默那条路）。

### 3.3 变异矩阵（全部在 cap-drop 下跑 `tests/env-gated-criteria.spec.ts`，改完即复原）

| 变异 | 内容 | 结果 |
| --- | --- | --- |
| MUT-A | 新加一个**未登记**的真 mount 探针文件 | **RED**（扫描面①） |
| MUT-B | 整块删掉 K-08（= 审计 M6） | **RED**（用例名 + 反向探针面） |
| MUT-C | 消费点不再硬红（删 `throw`） | **RED**（行为夹具） |
| MUT-D | 消费点不再打覆盖声明（删 `log`） | **RED**（行为夹具） |
| MUT-E | spec 里多一处未登记的 `judgeMountGate` | **RED**（调用点计数） |
| MUT-F | spec 绕过 `consumeMountGate`（只判不消费） | **RED**（调用点计数） |
| MUT-G | 已登记用例名改名（= 审计 M8b） | **RED**（用例名） |

## 4. 归因更正：年龄钳位**不是**"那次 CI 红的成因"

`c30721c1e3` 的提交信息写了"满载 600 次里 115 次返回 0（19.2%）…另一轮 7.0%（28/400）"。
这两个数字**不可复现**：

- 独立复刻取 age 的时序（先 `now = Date.now()`、再 `lstat`）：空载 N=300、满载（8 burners/4 vCPU）
  N=300，**负年龄 0 次**；min gap ≈ 2.9ms、p50 ≈ 4.9ms —— 够不着"间隔 <1ms 且跨整毫秒"那个窗口；
- 反向对照：把钳位还原成旧实现 + 满载跑 40 次 ⇒ **40/40 通过**（日志恒 `age 0.0h`）；
- 也没有那次红的 CI 日志原件（作者自述 7 份日志里该判据的失败签名 0 命中）。

**准确的定位**：修掉一处**真实存在、但在两种环境下都未被观测到**的潜在不确定性；上限是
"该判据不再可能被时钟粒度翻转"。**不是**"修复了那次 CI 红" —— 那次红的真实成因仍未定，
仍未排查。

判据本身与这条归因无关：去钳位后两条边界用例**确定性**红（`1 failed | 9 passed`，
`removed = 0`、日志 `[]`），机制是真的。

## 5. 关闭口径：enterprise 全包（审计 P2-5）

审计实测全包 `222 failed | 861 passed | 1 skipped (1084)`、EXIT=1、664s。根因**不是**本轮修复：
`apply-full-composition.ts` 的假 ctx 没有 `ctx.inject`，而 P0-b 把宿主工具的注册挪进了
`ctx.inject(['tools'], …)`（`wasm-apps-host/src/app-routes.ts`）⇒ 装组合**当场**抛
`TypeError: ctx.inject is not a function`，三十个 spec 全部红在**夹具形状**上。

修法：夹具按**真 Cordis 语义**补上 `inject` —— `ctx.inject(deps, cb)` 在 cordis 里就是
`this.plugin({ inject: deps, apply: cb })`（**子插件 + inject 声明**），所以服务不齐时回调
**不跑**、也不抛。这不是测试替身：三个 `apply` 与 `registerAppRoutes` 都是产品代码本身。

连带暴露一条**写于 P0-b 之前**的断言（`wasm-app-tools.spec.ts`「tools 服务缺席时明确报错」）：
它假设"最小组合会走到 `registerWasmAppTools` 的缺服务分支"，而 `inject` 一旦按真语义实现，
那条路径就**不再由组合产生**。判据**一条没删**，改成两处取：组合侧断言"装得完、工具数 0、不抛"，
缺服务报错仍由**直接调用**导出的 `registerWasmAppTools` 判。

**关闭口径**：以**全包** `vitest run` 的退出码为准，不用子集运行。本轮实测见下。

## 6. 诚实边界

- 托管 runner 的真实 `CAP_SYS_ADMIN` / 时间戳粒度**未实测**（只有本机 4 vCPU 数据与 cap-drop
  等价模拟），因此"负年龄在 CI 上是否可达"没有定论。
- K-08 的跨设备判据依赖 `/dev/shm` 存在（Linux 标准）；非 Linux 上本文件同族判据的边界未测。
- `consumeMountGate` 的"无原因即抛错"是**有意的 fail-loud**：探针失败却拿不到原因时，宁可红
  也不静默自跳。
