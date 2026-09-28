# macOS「应用图标变成问号 + 打不开」诊断与包一致性硬化（2026-09-26）

- **来源**：同事反馈「macOS 下很小概率：应用图标变成问号，然后打不开」。
- **本机条件**：诊断在 Linux 上完成（无 macOS、无 Apple 工具链）⇒ **不能复现**、不能跑
  `codesign` / `spctl` / `stapler`。因此本文把结论分成三档：**源码级确定**（逐行读实现）、
  **本机已验证**（可跑、可拆、可复算）、**待现场确认**（需要受影响 Mac 的输出）。
- **产物**：`packages/host/desktop/scripts/mac-bundle-consistency.ts`（新判据）+
  三处接线 + `tests/mac-bundle-consistency.spec.ts`；取证清单见本文 §5。
- **本次没有改任何产品行为**：新增的都是"不许退化"的构建期/发布期判据。

## 1. 先把症状拆成两种互斥形态（判据与责任面都不同）

| 形态 | 现象 | 机制 |
| --- | --- | --- |
| **A. Dock 项丢失目标** | Dock 里那一格是带「?」的通用方块，双击无反应或弹「应用程序"X"无法打开」 | Dock 项记的是**路径引用**，目标不存在时显示「?」 |
| **B. 包内图标缺失/坏了** | Finder 里 `.app` 显示通用图标（应用**可能仍能启动**） | `CFBundleIconFile` 指不到真实 `.icns`，或 `.icns` 为空/坏 |

⚠️ 现场请先回答两问：**问号出现时应用是完全没启动过，还是启动后闪退/没窗口？** 以及
**它是从 DMG 卷里直接双击运行的，还是先拖进「应用程序」再运行？** —— 这两问决定往 A 还是 B 追。

## 2. 源码级确定的事实（决定责任面）

1. **macOS 上我们的更新器不安装任何东西**：`packages/host/desktop/src/electron-runtime.ts:680-694`
   的 darwin 分支只有 `shell.openPath(<dmg>)` + 一句「请用新版本替换『应用程序』里的 X」
   （文案在 `src/tray-locale.ts`），替换完全由用户在 Finder 完成；Windows 才 spawn NSIS 并退出。
   全 `src/` 没有任何 `ditto`/`rename`/`rm` 作用于已安装 bundle。
   ⇒ **「更新器非原子替换 ⇒ 半成品 bundle」这条假设不成立**（不存在该代码路径，也谈不上回滚）。
2. **mac Dock 图标是运行时覆盖的**：`electron-runtime.ts:784-788` 用
   `nativeImage.createFromPath(<asar 内 build/app-icon-mac.png>)` + `app.dock.setIcon()`
   覆盖系统图标；**空图即抛错走致命启动**（`src/fatal-boot.ts`），而该 PNG 在 afterPack
   必需清单里 ⇒ 它缺失时应用是"起不来 + 原生错误面"，**不是**"图标变问号"。
   ⇒ 由此得到一条现场判别式：**只有 Dock 坏 = 运行时/路径问题；Finder 里也坏 = 包或路径问题**。
3. **macOS 有 asar 启动期硬闸门**：electron-builder 会把 `sha256(asar 头部 JSON)` 写进
   `Info.plist` 的 `ElectronAsarIntegrity`，Electron 启动时校验；asar 被**后置改写** ⇒
   直接打不开（`header integrity doesn't match`）。我们的链路里 afterPack 在签名前且只读，
   **没有**后置改写。
4. **下载链本身可信**：完成件必须**同时**过 SHA-256（对服务端 `updates/manifest`）与容器魔数
   （DMG 尾部 `koly`），任一不符即删除；复用已下载件时以哈希为权威。
5. **改前没有任何判据看这两件事**：`Info.plist` 的图标键 ↔ 真实 `.icns` 从不对拍；
   `app.asar` 只验"条目存在"，**从不验内部布局**（条目 offset 表自洽性）。

## 3. 已排除 / 仍待现场确认

**已排除**（各自都有源码级或实测依据）：更新器非原子替换与缺少回滚（无此路径）；运行期改写自身
bundle（零处写 `Contents`/`resourcesPath`/`getAppPath`）；更新包截断（下载即校验）；图标转换失败
静默回落（上游 app-builder-lib 是抛错）。

**最吻合"低概率 + 只在 mac + 问号 + 打不开"四个特征的，是外部成因**（都需要现场输出才能定论）：

- **H1 从 DMG 卷内直接运行**：卷被弹出/重启后路径消失 ⇒ Dock「?」的教科书形态（Apple 官方帮助页同名）。
- **H2 App Translocation**：带 `com.apple.quarantine` 的应用被系统放到临时随机路径运行，退出即回收。
- **H3 拷贝/替换中断**留下的半成品 bundle。
- **H4 签名/公证/隔离属性**问题（`spctl` 拒绝、票据缺失、签名被改写）。
- **H5 LaunchServices 陈旧注册 / 同 appId 多份**（旧渠道包、`~/Downloads`、`~/.Trash` 里的副本）。

结论：**现有证据不足以判定该症状由我们的代码造成**；本轮做的是把"包自身是否自洽"变成硬判据
（下一节），并给出一页现场取证清单（§5）。

## 4. 本轮新增的包一致性判据（Linux 可跑，三处接线）

`packages/host/desktop/scripts/mac-bundle-consistency.ts`（**纯读取**，带文件系统注入接缝）：

- `CFBundleIconFile` ↔ 真实 `.icns`（存在、非空、`icns` 魔数）；`CFBundleIconName` ↔ `Assets.car`；
- `CFBundleExecutable` ↔ `Contents/MacOS/<name>`（存在且带可执行位）；
- `app.asar` **内部布局**：`fileSize == dataStart + Σ(packed 条目 size)`（铺满等式，delta 必须为 0）、
  0 重叠、0 越界；
- `sha256(asar 头部 JSON)` ↔ `Info.plist` 的 `ElectronAsarIntegrity`（macOS 启动期校验用的那份）；
- 二进制 plist / 结构异常一律 **fail-loud**（不静默跳过）。

接线三处（缺一处即有一条变异用例红）：`afterPack`（签名**之前**，`verify-packaged-runtime.ts`）、
mac DMG 冒烟（`verify-mac-smoke.ts`）、mac DMG 发布验证（`verify-mac-release.ts`）。

**判据与变异**：`tests/mac-bundle-consistency.spec.ts` 22 例 + 三处行为级用例（164 passed，EXIT=0）；
真实产物（111 927 459 B / 12 338 条目）实测铺满 `delta=0`、0 重叠、0 越界，头部摘要与
app-builder-lib 的 `hashHeader` 逐字节一致；负向对照（改坏 plist 摘要）被拒；**6/6 变异红**
（去 icns 魔数 / 去完整性比对 / 去铺满检查 / 去 afterPack 接线 / 去 smoke 接线 / 去 release 接线）。
> 方法学留痕：其中"去 afterPack 接线"第一轮是**绿的** —— 接线断言只查"文件里出现过函数名"，
> `import` 行就骗过了它（本仓登记的"存在性断言 = 假绿"）。已改成钉调用点 + 补行为级用例。

## 5. 现场取证清单（一页，整段可粘贴；全程只读）

把 `<X>` 换成 Finder 里显示的应用名、`<appId>` 换成 bundle id（渠道包形如 `com.<品牌>.harness`）。
**先回答 §1 的两问，再回帖下面各段的输出。**

```bash
APP="/Applications/<X>.app"
# A. 在不在、完整吗
ls -ld "$APP"; du -sh "$APP"; ls -l "$APP/Contents/Info.plist" "$APP/Contents/MacOS/"
ls -l "$APP/Contents/Resources/" | grep -i -E "icns|app\.asar"
# B. 图标键 ↔ 真实 .icns
plutil -p "$APP/Contents/Info.plist" | grep -i -E "icon|executable|identifier"
ICON=$(plutil -extract CFBundleIconFile raw "$APP/Contents/Info.plist"); echo "icon=$ICON"
ls -l "$APP/Contents/Resources/$ICON"; file "$APP/Contents/Resources/$ICON"
# C. 是不是从 DMG 卷里跑 / 卷还在不在（H1）
mount | grep -i /Volumes; ls -la /Volumes; mdfind -name "<X>.app" | head -20
defaults read com.apple.dock persistent-apps 2>/dev/null | grep -B3 -A8 "<X>" | head -40
# D. 签名/公证/隔离属性（H4）
codesign -dv --verbose=4 "$APP"; codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vv "$APP"; xcrun stapler validate "$APP"; xattr -l "$APP"
# E. 陈旧注册 / 多份同名（H5）
mdfind "kMDItemCFBundleIdentifier == '<appId>'"
lsregister -dump 2>/dev/null | grep -n -A8 "<appId>" | head -60
# F. 日志（信息量最大）
log show --last 2h --style compact --predicate 'process == "<X>"' | tail -40
log show --last 2h --style compact --predicate 'process == "syspolicyd" or process == "Finder" or process == "amfid"' | tail -60
tail -n 80 ~/Library/Application\ Support/<产品名>/logs/dsh-*.log
# H. 顺手（闭合待确认项：Electron 模板是否带 LSFileQuarantineEnabled）
plutil -p "$APP/Contents/Info.plist" | grep -i -E "quarantine|LSMinimumSystemVersion"; sw_vers; uname -m
```

要找的关键字：`Invalid package config`、`ASAR Integrity Violation`、`header integrity doesn't match`、
`AppTranslocation`、`code signature invalid`、`Library not loaded`、`killed`。

**修复动作（按可能性排序）**：① 重新下载 DMG → 对服务端 `updates/manifest` 校验 sha256 →
**拖进「应用程序」**（不要从 DMG 里直接运行）→ 必要时 `xattr -dr com.apple.quarantine`；
② Dock 里的问号项本身修不好（它的目标已不存在）—— 右键「从 Dock 移除」，再从 `/Applications`
重新拖入；③ 清掉 `~/Downloads`/`~/.Trash`/旧渠道包里的同名副本；
④ 仍打不开：把 §D 与 §F 的输出回帖（有 `codesign`/`spctl`/`stapler`/日志四样即可定性）。

## 6. 未闭环 / 待拍板

- **需要一次真实 Mac 的输出**才能把 §3 的 H1–H5 收敛到一条；本机**不能**替代。
- **产品决策（本轮未做）**：mac 的更新是"用户手工替换"，替换后**没有任何校验**。可选做法是
  下次启动比对 `app.getVersion()` 与"待安装版本"并在不一致时提示「更新未完成」——
  这属于产品行为变更，需拍板后单独实施。
- **可选加固（未做）**：把 asar 布局判据也接进 `yarn check`（必须"产物存在才判"，写成
  "永远跳过"就是新的假绿）；`check-workflows.mjs` 加静态策略「mac 发布链必须调用
  `verify-mac-release.ts`」；门户/清单侧目前只给 sha256，"服务端自算一遍 DMG 哈希"的口径可另立。
- **认账边界**：本轮判据覆盖"包自身自洽"，**不覆盖**"应用被放在哪、后来去了哪"（那三条外部
  成因由现场取证清单负责）。
