# beta.11 P1 缺陷修复 拍板摘要（2026-09-08）

> 设计蓝图：`docs/planning/2026-09-08-beta11-p1-bypass-fix-design.md`
> 实施计划：`docs/planning/2026-09-08-beta11-p1-bypass-fix-implementation.md`
> 需求来源：`REQUEST.md`；审计来源：`docs/AUDIT-BETA11-CHANGES-2026-09-08.md`
> 工作仓库：`/mnt/md0/junhua_work/picoaide-harness`，分支 `fix/eval-policy-p1-bypasses`，基线 `b624840e62`

---

## 1. 背景

2026-09-08 对 beta.11 合入的 3 个改动做安全审计，发现 3 个 P1 缺陷，父代理已独立复现验证全部真实存在：

| 缺陷 | 位置 | 实测 |
|---|---|---|
| P1-1 browser_eval 构造函数链代码执行绕过 | `packages/host/browser/src/eval-policy.ts:163-180`、`214-248` | 5/5 变体放行，端到端执行返回 `1` |
| P1-2 `Reflect.construct` 解禁网络构造 | `eval-policy.ts:173-180` + `WRITE_APIS` 移除网络类 | 2/2 放行；`new WebSocket()` 仍被拒 |
| P1-3 memory-evolve `rmSync(to)` clobber 数据丢失 + EXDEV 回归 | `packages/vendor/memory-evolve/lib/skills.js:188-193` | 目标目录 `notes.md`+`sub/keep.txt` 被删除 |

## 2. 用户拍板决策

### 决策 1：修复范围
**3 个 P1 全修**（P1-1 / P1-2 / P1-3）。
- 用户原话摘录：选择「3 个 P1 全修（P1-1/P1-2/P1-3）」
- 排除：P2 关键项（脱敏正则、WRITE_APIS 缺项、测试假阳性）本轮不修，列为遗留。

### 决策 2：eval 修复策略
**拒绝 `constructor`/`prototype`/`__proto__` 链 + `Reflect.construct`/`apply`/`call`/`bind`。**
- 保留 beta.11 产品决策：`fetch`/`sendBeacon`/`postMessage` 等网络外发仍放行
- 保留合法读：`window.__NEXT_DATA__`、`data[key]`、`readText('#a')`、`localStorage.getItem('t')`
- 原则：deny-by-default 的延伸——**无法静态证明调用目标安全的调用一律拒绝**，但"证明"必须覆盖整条 base 链
- 用户原话摘录：选择「拒绝 constructor/prototype/__proto__ 链 + Reflect.construct/apply/call/bind」

### 决策 3：memory-evolve 修复策略
**merge 语义——目标非空时不清空，只覆盖同名文件。**
- 删除 fallback 里的 `rmSync(to, {recursive:true, force:true})`
- `cpSync(from, to, {recursive:true})` 本身是 merge 语义
- 保留 `existsSync(join(to,'SKILL.md'))` 预检；保留 EBUSY/EPERM/EACCES/EXDEV 降级可成功采纳
- 用户原话摘录：选择「merge 语义：目标非空时不清空，只覆盖同名文件」

## 3. agent 定案（D5-D10）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D5 | 是否补 `ENOTEMPTY` 进降级码表 | **补** | 同设备非空目标（无 SKILL.md）目前裸抛异常给前端，与"降级可用"目标冲突；补后走 merge 分支且不丢数据 |
| D6 | 黑名单"属性名制"还是"基对象制" | **属性名制（base-agnostic）** | `Reflect.get(obj,'constructor')` 与 `obj.constructor` 同源，按基对象判会被别名绕过 |
| D7 | 是否禁 `getPrototypeOf`/`getOwnPropertyDescriptor` | `getOwnPropertyDescriptor(s)` **禁**；`getPrototypeOf` **不禁** | `.value` 可直达 `Function`；`getPrototypeOf` 结果上的 `.constructor` 已被链式黑名单拦截，禁它属过度修复 |
| D8 | 是否禁箭头形参别名调用 | **禁** | `(f => f('alert(1)'))(setTimeout)` 实测洗白成功；与既有 `window[key]('x')` deny-by-default 同源 |
| D9 | 故障注入实现方式 | **子进程 + loader hook 替换 `node:fs`** | 测试进程内 monkey-patch 无效（ESM 具名导入绑定固定）；`mock.module` 对 builtin CJS 互操作失败 |
| D10 | 文档归类 | 设计/实施归 `docs/planning/`，拍板归 `docs/decisions/`，审计归 `docs/AUDIT-*.md` | 仓库既有约定 |

## 4. 验收标准

用户未对 `REQUEST.md` 的 AC1-AC7 提出修改 → **全部确认**。

| AC | 判定标准 |
|---|---|
| AC1 | P1-1 全部 5 变体必须被 `validateEvalExpression` 拒绝 |
| AC2 | `Reflect.construct(window['WebSocket'/'XMLHttpRequest'], …)` 必须被拒绝 |
| AC3 | 合法只读/网络表达式不得误伤（26 例合法集） |
| AC4 | merge 语义保留目标用户文件 + 四码降级仍能采纳 |
| AC5 | 对抗性矩阵 ≥16 例，且在修复前代码上必须失败 |
| AC6 | 故障注入测试断言"目标既有内容不变"，修复前失败 |
| AC7 | 全量回归：browser ≥168、memory-evolve skills/api 34 全绿，`yarn check` 通过 |

## 5. 门禁要求

- browser：`cd packages/host/browser && ./node_modules/.bin/vitest run` 全绿
- memory-evolve：`cd packages/vendor/memory-evolve && node --test tests/skills.test.js tests/api.test.js` 全绿
- 对抗性测试矩阵必须在**修复前代码上失败**（证明测试有效）
- 故障注入测试必须断言"目标既有内容不变"

## 6. 编码实施结果（agent-coder，2026-09-09）

| AC | 修复前 | 修复后 |
|---|---|---|
| AC1/AC2/AC5 | 新增 spec 16 failed / 29 passed | **45 passed** |
| AC3 | 全绿 | **全绿（26/26 合法集 0 误伤）** |
| AC4/AC6 | AC4 1 failed；AC6 5 failed / 0 passed | **40 passed / 0 failed（目标三文件）** |
| AC7 | browser 168 / memevolve 34 | **browser 213；memevolve 目标 40**；`yarn check` 预存环境失败（见实施计划"待确认"） |

## 7. 修复轮 3 追加定案（agent-coder，2026-09-09）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D11 | 常量折叠接在哪一层 | **接入 `memberName()`**（唯一名字解析入口），而非逐个判定点补丁 | NEW-P0 根因：折叠只接在 `propertyKeyName()` 与 `Reflect.get` 分支，导致同一成员链仅因键写法不同（`window['eval']` vs `window['ev'+'al']`）而判定相反 |
| D12 | 属性名复用连带拒绝是否算缺陷 | **不算，登记为设计内取舍**（清单见设计蓝图 §4.5.1） | 黑名单按属性名拦截（D6）的必然代价；9 类惯用法实测全拒，均有替代写法 |

> 连带拒绝清单的回归口径：清单内 9 类**变 ACCEPT 即视为安全回归**（黑名单被削弱）；合法集（AC3c/AC3d）**变 REJECT 即视为过度修复**。两侧都有测试守护。

