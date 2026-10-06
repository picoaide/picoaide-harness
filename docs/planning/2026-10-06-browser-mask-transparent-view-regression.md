# 内置浏览器「蒙版/胶囊整层不渲染」定案：45.0.0-alpha.7 引擎的透明视图回归

- 日期：2026-10-06
- 触发：用户报告「内置浏览器打开网页后蒙版不见了；整窗都点不动（网页、标签栏、地址栏都没反应）；
  关掉浏览器窗口再从应用里打开也不会恢复」，附截图（窗口标题栏 + 工具栏 + 网页正常显示，全窗无任何
  AI 蒙版/胶囊/胶囊按钮）
- 性质：**只读定位 + 真机像素级复现**，未修改产品代码；本文是唯一交付物，探针与截图留在
  `temp/browser-shot/`（gitignored）
- 结论一句话：**客户端自 v2.8.2-beta.2 起 pin 的 Electron `45.0.0-alpha.7` 让「透明 WebContentsView
  叠在兄弟视图之上」这条能力失效** —— 蒙版视图拿到不透明背板（Linux/软件合成下实测：蒙版与页面之间
  被整层白色挡住；Windows 上的另一种表现就是"什么都没画、但照样吞掉全部点击"，即用户看到的形态）。

---

## 0. 现场判据（先排除"按钮太小"这一类旧结论）

对用户截图做像素判读（`temp/browser-shot/`，原始 1327×982）：

| 位置 | 期望（若蒙版层在画） | 实测 |
|---|---|---|
| 工具栏（标签条 + 地址栏） | 蒙版 scrim `rgba(10,12,16,0.08)` 会把它压到 ~(225,226,228) | **(244,245,247) / (255,255,255)** —— 原色，未被任何层覆盖 |
| 窗口底部中央（mask 态 pill 应在处） | 深色药丸「AI 正在操作 · 我来操作」 | 无（是网页的「发现」版块图） |
| 右下角（capsule 态 300×44 胶囊应在处） | 白底胶囊 + 橙色「交给 AI」 | 无（是网页天气卡）；全图搜 `#d97706` 与 `#2563eb` 均只命中网页自身像素 |

同时 **整窗点击都被吞掉** ⇒ 结论：覆盖层（overlay 视图）**在**、**满窗**、**在捕获输入**，但它
**什么都没画**。这与"控件太小/太靠角"是两类缺陷（2026-10-04 的 P1 已把胶囊放大到 300×44）。

## 1. 复现：生产形态的透明蒙版视图在 45-alpha 上不再透视

探针（`temp/browser-shot/probe-hidden2.mjs`，真 Electron + 真 `WebContentsView`，形态与
`packages/host/browser/src/electron-adapter.ts` 的 `createMaskView()` 逐字一致：`transparent: true`
+ `contextIsolation` + `sandbox` + `backgroundThrottling: false`；页面走本地 HTTP，蒙版页是
`body{background:transparent}` + `rgba(10,12,16,0.08)` scrim + 不透明 pill；被盖住的是红色 tab 视图）：

```
显示窗口 → 蒙版视图在最上，全窗 (0,0,900,640) → X11 抓整窗 → 数红色像素
```

| 引擎 | 有蒙版视图 | 无蒙版视图（对照） | 判读 |
|---|---|---|---|
| Electron 42.3.3 | 红 **220,36** 像素（scrim 叠在红页上） | 全红 | 透明合成 **正常** |
| **Electron 44.4.3**（v2.8.1 客户端） | 红 **484,215** 像素（红页透出，pill 可见） | 全红 | 透明合成 **正常** |
| **Electron 45.0.0-alpha.7**（v2.8.2-beta.2 起） | 红 **0** 像素；整窗 (236,236,236) | 全红 | **页面被整层挡死** |

- 45-alpha 上**不是**"页面视图坏了"：摘掉蒙版视图，红页照常渲染（492,300 红像素），
  **唯一致病因素是那张 `transparent: true` 的蒙版视图**；它的 scrim 现在合成在一块不透明背板上。
- 45-alpha 上的**加载全部正常**：`did-finish-load` 三个页面都到、`getURL()/isLoading()` 正常、
  `capturePage()` 非空、渲染进程未崩 ⇒ **不是"页面没加载/加载失败"**。
- 顺序无关：`show:false → show()`（生产 prewarm 路径）与一开始就显示，两种都坏。
- 空转开关无效：`--disable-gpu`、`--use-gl=angle --use-angle=swiftshader` 在**简单探针**上能"治好"，
  在**生产形态探针**上照样 0 红像素 ⇒ 不存在可靠的"加个开关绕过"。

→ **同一个探针、同一台机器、只换引擎**：44.4.3 好、45.0.0-alpha.7 坏。

## 2. 为什么我们会 pin 到这个 alpha（不是随手升的）

`node-addon-require-builtin`（DSH 0.1.7 起的包解析原生插件，我们的直接依赖
`packages/host/desktop/package.json:321`）把**受支持的 Electron 指纹硬编码在二进制里**
（`node-addon-require-builtin-linux-x64-gnu/prebuilt/*.node` 的字符串，0.1.6 与 0.1.7 两份都一样）：

| 表里的项 | V8 指纹 | 对应 Electron | 该版本的问题 |
|---|---|---|---|
| `electron-43` | `15.0.245.13` | **43.0.0 / 43.1.0**（43.4.0 是 15.0.245.28，不在表内） | 无 asar `bigint` 修复（技能 provider 整片消失，issue #130） |
| `electron-44` | `15.2.124.13` | **44.0.0** | 同上，无 asar `bigint` 修复 |
| `electron-45-alpha` | `15.4.80` | **45.0.0-alpha.4 ~ alpha.7** | **本文这条透明视图回归** |

其余版本一律在启动期被拒（`host preparation failed: … unsupported Electron runtime fingerprint`）。
我们 v2.8.1 用的 44.4.3（V8 `15.2.124.28`）、44.5.1 等**都不在表里**；45.0.0-alpha.8+ 的 V8 已经
升到 15.5.18 / 15.6.69，同样不在表里。

⇒ 今天**没有任何一个引擎同时满足**：(a) 插件指纹表、(b) asar `bigint` 修复、(c) 透明蒙版视图可用。

## 3. 影响面与用户可见形态

- 受影响客户端：**v2.8.2-beta.2 起的所有渠道客户端**（beta 线）—— 即内置浏览器那层 AI 蒙版/胶囊
  在引擎层就不可能正确渲染。
- 表现随合成后端而异（同一个根因）：
  - Linux/软件合成（本机实测）：蒙版视图**不透明**，页面被整层盖住（mask 态下整个窗口是一张灰白板，
    只剩 pill 可见）；
  - Windows（用户报告，本机无法复现该后端）：蒙版层**什么都没画**——页面与工具栏照常显示，但
    **全部点击被那张满窗视图吞掉**，于是「找不到控制按钮、也交还不了控制权」。
- 为什么"关窗重开"不管用：内置浏览器窗口的关闭是 **hide 而非 destroy**（2026-09-08 产品决定），
  蒙版视图活着；只有重启客户端才会重建窗口与视图。
- 内置浏览器是门户对外宣传的六项能力之一，且它承载唯一的人工接管/交还入口 ⇒ 按 P0 处置。

## 4. 修法选项（需拍板）

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| **A（推荐）** | 引擎回到 **44.0.0**（插件表内），并给 `@deepseek-ai/dsh-fs-local` 打**我们自己的补丁**容忍 Number 版 `Stats`（asar `bigint` 缺失的根因），把 afterPack 的那条门禁从"引擎 fs shim 返回 bigint"改写成**能力判据**："打包 asar 上文件系统技能 provider 真的列得出 preset 技能" | 稳定版引擎 + 蒙版恢复 + 技能恢复；损失 44.1–44.5 的安全修复；需重跑打包/三平台/E2E |
| B | 留在 45.0.0-alpha.4~7，**不再依赖"透明视图叠加"**：把蒙版改成独立透明子窗口（或把锁与 UI 拆到壳页） | 引擎仍是 alpha；子窗口会重开"抢焦点/层序"那一整类战场（2026-09-17 刚收口），工作量大 |
| C | 催上游（`node-addon-require-builtin`）出一个覆盖更新的稳定 Electron 的预编译件 | 真正的长期解，但不在我们手里；应先按 A 落地止血 |
| D | 回到 43.0.0/43.1.0（表内） | 引擎更旧，asar 问题同样在，且 43 线的其它回补更少 |

**无论选哪条，建议同时落地两条护栏**（本次能这么准地定性，靠的就是它们）：

1. **合成能力探针**（本次的 `probe-hidden2.mjs` 就是雏形）：真 Electron + **生产形态**的
   `createMaskView()` webPreferences，在一个兄弟视图上放可判色的页面，断言 scrim 之下**那层颜色透得出来**。
   现有全部判据（单测用 mock 适配器、`e2e:client` 不驱动内置浏览器窗口、2026-10-04 的视觉探针
   **没有带 `transparent: true`**）都看不见这条 ⇒ 引擎升级清单必须加它（`yarn package:dir` +
   打包版启动 + `e2e:client` 之外的第 4 步）。
2. **"看不见的蒙版绝不允许上锁"**（产品/代码侧的 fail-safe）：蒙版视图在 mask 态若**一帧都没画出来**
   （`capturePage()` 全透明 / 页面未完成加载），就不得继续占着满窗吞输入——应当退化成"不锁 + 在聊天侧
   给出可操作的接管/交还入口"，并把原因写进客户端日志。本次用户之所以彻底卡死，就是因为
   "在捕获输入的层"和"能看见的层"是同一个视图，而它坏了：**没有任何一条出口留给用户**。

## 5. 现场可用的临时动作

1. **重启客户端**（不是关浏览器窗口）：重建窗口与蒙版视图；若该机的合成路径只是偶发失效，蒙版会回来；
   即使不回来，也能把卡住的"用户持有控制权"状态复位，AI 侧恢复可用。
2. 需要继续用浏览器时，先只让 AI 驱动、不要点「我来操作」（重开的那次控制权交接之后 UI 可能又不可见）。
3. 需要取证时抓客户端日志里的 `[dsh-browser]` 行（`<userData>/logs/dsh-*.log`）：本文的复现预测
   **不会**出现 `overlay page failed to load`（页面是加载成功的，坏的是合成）。

## 6. 实施记录（2026-10-06，方案 A，同日落地）

| 改动 | 位置 |
|---|---|
| 引擎 pin `45.0.0-alpha.7` → **`44.0.0`**（4 个 manifest 的 peer+dev） | `packages/host/{desktop,browser,enterprise,wasm-apps-host}/package.json` |
| 新补丁：**消费侧**容忍引擎给的 Number `Stats` —— 权限掩码与 `*Ns` 时间戳各一个按形状取值的 helper（不动对象本身，因为 Number `Stats` 的 `isFile()`/`_checkModeProperty` 只认 Number 的 `mode`） | `patches/dsh-fs-local@0.2.0-rc.2.patch` + 根 `resolutions` 的 exact/`^` 两条 |
| afterPack 门禁从「引擎必须返回 BigIntStats」改成**能力判据**：在真 `app.asar` 上 stat / `listDir` / 读 `SKILL.md`，列举与产物反推的期望逐元素相等；引擎形态只打印（`ASAR-BIGINT-SMOKE-ENGINE`） | `packages/host/desktop/scripts/verify-packaged-runtime.ts` + `tests/verify-packaged-runtime.spec.ts` |
| pin 守卫注释与探针口径同步 | `packages/host/desktop/tests/package.spec.ts`、`scripts/asar-bigint-probe.mjs` |

> 第一版补丁把 Number `Stats` **原地改写成 bigint 语义**，被真机门禁当场否掉：`mode` 变 BigInt 后
> `Stats.prototype.isFile()` 内部 `_checkModeProperty` 抛 `Cannot mix BigInt and other types`
> （Number `Stats` 类用的是 Number 常量）。教训记在这里：**"补齐字段"不等于"换成另一个类"** ——
> 引擎给的 `Stats` 只要能用原型方法，就只补它缺的两处（掩码、`*Ns`）。

**验证（本机实测）**：

- 合成 A/B：同一探针，44.0.0 = 红页透出（490,170 红像素）、45.0.0-alpha.7 = 0 红像素；44.0.0 的
  V8 指纹 `15.2.124.13-electron.0` **正好命中**插件表里的 `electron-44` 项。
- 补丁门禁：`verify-patch-resolutions` / `check-patch-pin` / `verify-patches` 全绿（9 个补丁，
  fs-local 那段与 yarn 封存副本逐字节一致，安装副本已打）。
- 桌面包测试：`tests/verify-packaged-runtime.spec.ts` **137/137 通过**（含"用打包版 Electron 读真
  `app.asar`"那条）。
- **端到端（真打包）**：`yarn package:dir` → `EXIT=0`，afterPack 打印
  `packaged ASAR filesystem smoke OK in 142ms (4 preset skills, app root …/app.asar, ASAR-BIGINT-SMOKE-ENGINE bigint=false mask=threw:Cannot mix BigInt and other types…)`
  —— 即：**引擎仍然不返回 BigIntStats（形态如预期），而技能 provider 在真 asar 上 stat/列举/读取全部成功**。
  这正是本次改门禁要表达的语义。

**顺带发现（引擎回退后必须重测的一条判据）**：主窗口麦克风闸门是 **2026-09-30 在 45.0.0-alpha.7 上
实测**的（当时的结论：check 通道的 `details` **没有** `mediaType`，所以"缺 mediaType 必须放行"）。
在 **44.0.0** 上实测：check 通道**带** `mediaType`，一次音频请求会依次问 `video` / `audio` / `null` /
`null`，且 `request` 通道在无设备时压根到不了（直接 `NotFoundError`）。方向上闸门**更严**（多了
`video` 这一道），观察到麦克风路径照常继续；但"摄像头在**有设备**的机器上是否被 request 通道拒"
**本轮无法在本机复验**（容器无摄像头/麦克风），需要在真机（Windows/macOS 带摄像头）补一次
`navigator.mediaDevices.getUserMedia` 探针。

**仍未做（建议下一条）**：第 4 节的两条护栏还没进仓库（合成能力探针目前是 `temp/browser-shot/` 下的
一次性脚本；"隐形蒙版不上锁"的 fail-safe 未实现）。
