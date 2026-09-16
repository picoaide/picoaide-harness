# macOS 菜单栏图标：模板图必须是 mark-only（2026-09-16）

状态：已实施（`packages/host/desktop`：托盘位图派生 + 门禁测试）

## 问题（用户 2026-09-16 反馈）

Mac 客户端菜单栏右侧**只有一个方块**（用户机器是暗色菜单栏，实测为白方块），看不出
品牌花括号 mark；客户端窗口本身正常、功能可用。用户原话："mac 的状态栏图标没有 …
是一个白色方块，应该是哪里没生效"。

## 现状取证

| 位置 | 事实 |
|---|---|
| `src/tray-icons.ts:27-31` | darwin 分支加载 `build/tray-iconTemplate.png` 并 `setTemplateImage(true)` |
| `scripts/generate-tray-icons.mjs`（改造前） | 6 个变体都是"把品牌 SVG 直接缩放"：**方块 + mark 铺满整张画布**，方块不透明 |
| 随包产物像素（16px） | 全透明像素 **0**、不透明 236、半透明 20 → alpha 遮罩就是一块实心圆角方块 |
| 真实产物核对 | beta 渠道 `2.7.5-beta.1` 的 mac DMG（`PicoAide-Harness-2.7.5-beta.1-mac.dmg`，sha256 与 manifest 一致）里 `app.asar` 的该文件与仓库产物**逐字节相同**；DMG 内 app 带 staple 票据、`Info.plist` 无 `LSUIElement` → **不是**打包/签名/权限问题 |
| Electron 文档 | 模板图由 **black + clear** 组成；系统只用 **alpha 通道**当遮罩、RGB 忽略，再按当前外观填成黑/白 |

结论：模板图这种用法**要求**"mark 不透明 + 背景透明"，而我们喂给它的是"整块不透明
的方块"。于是遮罩=整块方块：亮色菜单栏画成黑方块、暗色菜单栏画成白方块（用户看到的
就是后者），mark 在数学上不可能出现 —— 与 Windows/Linux 无关（那两个平台原样绘制位图，
黑底白 mark 一直是对的）。

同时确认了两个盲区（本次一并记账）：
- macOS 托盘**零运行时覆盖**：`verify-mac-smoke.ts` 只验 DMG 结构、从不启动 app；E2E 只在
  Linux Xvfb 跑（Xvfb 没有系统托盘，图标不可见也照样通过）。
- 托盘是在 `src/electron-runtime.ts:883-888` **等 `window.loadURL()` 成功之后**才创建的，
  所以"启动早期失败"在用户侧同样表现为"菜单栏里什么都没有"（与本次现象不同，但排查时
  要先分清：本次窗口是正常的）。

## 决策

1. **macOS 模板图 = 只留 mark**：派生时**整块删掉那个平坦填充的 `<rect>` 底板**，其余
   几何（mark 的路径/坐标/相对大小）一律不动，并把落墨处规整成**字面黑**（渠道 mark 可能
   是白/彩色；模板图规范是 black + clear）。
   - 仍然只从品牌 SVG 派生（`brands/official/logo.svg` / 渠道 `logo.svg`），没有新画法：
     只是少画一层底板。
2. **Windows/Linux 位图保持"方块 + mark"**，且**逐字节不变**（`tray-icon-blue*.png` 四个
   文件改造前后 sha256 完全一致，见下表）。
3. **方块之外没有任何 mark 的 logo 直接 fail-loud**：模板图会全透明 = 菜单栏里什么都
   没有，比打包失败更糟。报错点名"draw the brand mark in logo.svg"。
4. 渠道作者约束写进 `docs/planning/2026-09-10-channel-package-reference.md`（渠道 logo
   必须画出方块之外的 mark）。

## 实施

- `scripts/generate-tray-icons.mjs`：变体表新增 `template?: boolean`；`tileRect()` 一次取出
  "底板元素 + 它的颜色"（既是 Windows/Linux 的替换色来源，也是 macOS 要删掉的那一层）；
  新增 `renderTemplateIcon()`（删底板 → 缩放 → alpha 保留、RGB 归零 → 落盘）。
- `scripts/generate-tray-icons.d.mts`：同步签名（实现与声明同源）。

## 门禁（防退化）

| 用例 | 判据 |
|---|---|
| `tests/channel-prepare.spec.ts`「官方 logo 的 Windows/Linux 位图与旧行为逐字节一致」 | 蓝位图 16/32px 必须等于"源 SVG 直接缩放"的旧产物（改造只放宽输入约束，非模板产物不能变） |
| `tests/channel-prepare.spec.ts`「macOS 模板图只有 mark」 | 模板图 clear 占比 > 50%（旧产物实测 0%）、落墨像素 > 0、**非透明像素 RGB 必须全 0** |
| `tests/channel-prepare.spec.ts`「只有方块时 fail-loud」 | 纯方块 logo 必须抛错且报错含 mark |
| `tests/package.spec.ts`「随包托盘位图」 | 直接读 `build/` 产物（发出去的那份）：模板图 clear > inked 且无彩色墨点；蓝位图 clear < 20px、inked > 900 |

生成脚本的用例证明"怎么生成"，`package.spec.ts` 那条证明"**发出去的就是对的**"。

## 验证

- 逐字节回归：`tray-icon-blue.png`/`@1.25x`/`@1.5x`/`@2x` 四个文件改造前后 sha256 完全一致；
  两个 `tray-iconTemplate*` 如期变化（16px：clear 82%、32px：clear 86%，`rgbNonBlack=0`）。
- alpha 遮罩模拟（把 alpha 当遮罩、按菜单栏明暗填色）：亮色菜单栏得到黑色花括号、
  暗色菜单栏得到白色花括号，1:1 尺寸下可辨（32px 表示更实）。
- `yarn workspace dsh-plugin-desktop test`：75 文件 / 791 用例通过（2 skipped）。
- 门禁：`yarn check:fast`（含根守卫）。

## 残留（认账）

1. **真机验证要等下一个 tag**：已发出的 `2.7.5-beta.1` DMG 里是旧位图，本次修复只能由
   重新打包的客户端体现（Mac 用户装新包后才能看到花括号）。
2. **16px 的官方 mark 是亚像素笔画**（alpha 均值 ~105、无全不透明像素）：这是品牌几何在
   16px 下的诚实结果；Retina 走 `@2x`（32px）更实。若日后要更醒目的菜单栏字形，需要品牌
   侧提供"小尺寸优化"的 mark —— 当前规则不允许手绘新图形。
3. mac CI 仍**只验包结构**：菜单栏可见性没有自动化断言（可选的下一步是在 mac runner 上
   `screencapture` 菜单栏做像素断言，属独立议题）。
4. 渠道侧影响：mark 是**横版字标**的渠道（如 example-b）在菜单栏里只有那行字标、没有底板，
   16px 下可辨度低于方块方案 —— 需要方形 mark 才能改善（已在渠道交付记录里记为已知取舍）。
