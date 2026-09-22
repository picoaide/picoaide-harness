# 客户端 Electron 升级与发布包源码泄漏修复（2026-09-22）

**范围**：`packages/host/desktop`（打包配置、打包脚本、窗口策略）+
`packages/host/{browser,enterprise,wasm-apps-host}` 的 Electron pin。
**上游 submodule 未动**。

---

## 一、结论速览

| 项 | 修复前 | 修复后 | 变化 |
|---|---|---|---|
| Electron | 43.4.0 | **44.4.3** | +1 主版本（含 Chromium 150→152） |
| `app.asar` 文件字节 | 444.28 MiB | **106.36 MiB** | **−76.1%** |
| `app.asar` 条目 | 13 518 | 12 336 | −1 182 |
| Linux AppImage | 437.3 MB | **160.0 MB** | **−63.4%** |
| Linux deb | 399.4 MB | **123.8 MB** | **−69.0%** |
| 自有源码 / sourcemap / 开发期产物条目 | 1 586 | **0** | 清零 |

精确字节（实测产物，`stat -c %s`）：

| 产物 | 字节 |
|---|---|
| `PicoAide-Harness-2.8.0-x86_64.AppImage`（44.4.3） | 159 968 984 |
| `PicoAide-Harness-2.8.0-amd64.deb`（44.4.3） | 123 817 904 |
| `app.asar`（44.4.3） | 111 528 184 |
| 对照 `PicoAide-Harness-2.7.5-beta.1-x86_64.AppImage`（43.4.0 旧配置） | 437 345 160 |
| 对照 `app.asar`（43.4.0 旧配置，从构建物读头） | 465 858 933 |

AppImage 的 −277 MB 拆分（同机、同脚本、同源码树三次实打）：

| 步骤 | AppImage | 该步贡献 |
|---|---|---|
| 43.4.0 + 旧打包配置（基线） | 437.3 MB | — |
| 43.4.0 + 打包修复 | 153.3 MB | **−284.0 MB** |
| 44.4.3 + 打包修复 | 160.0 MB | **+6.7 MB**（Electron 44 自身更大） |

⇒ **体积缩小几乎全部来自打包修复**；升到 Electron 44 让二进制**略涨 ~6.7 MB**。

---

## 二、打包泄漏：根因与本报告初版的差异

初版报告把根因写成「`!*.ts` 少了 `**/` 前缀」。复核后**这个判断不完整**，真正的
机制更基础：

> **electron-builder 26.15.3 不把 `build.files` 的模式应用在「应用根目录」内容上。**

证据（同一次构建的 `dist/builder-debug.yml`）：

- `nodeModuleFilePatterns` = 我们的 `build.files` 全量（含 `!src/**`、`!**/*.map`、
  `!temp/**`）⇒ 这些规则**对 `node_modules` 有效**，实测 `@picoaide/*/src` 因此清零；
- `firstOrDefaultFilePatterns` = 默认 `**/*` + electron-builder 内置排除
  （`!**/node_modules/**`、`!build{,/**/*}`、`!dist/*-unpacked{,/**/*}`、
  `!**/*.{…,d.ts,…}`）⇒ **应用根目录按这一份执行**，我们的排除规则一条都没进去。

所以 `src/`、`tests/`、`scripts/`、`temp/`、`.e2e-*`、`.real-env-*`、根级 `*.map`
全部照旧进包。**已验证的负结果（别重复试）**：

| 尝试 | 结果 |
|---|---|
| 给 `files` 补 `**/` 前缀（`!**/*.ts` 等） | 无效（规则本身就没被使用） |
| 删掉包顶层 `files` 字段（怀疑它遮蔽 `build.files`） | 无效 |
| `directories.app` 指向**符号链接**暂存目录 | 无效且更糟：链接被展开成 **8.3 GB** asar |
| 依赖 `dist` 输出目录默认被排除 | 无效（默认只排除 `*-unpacked`，见下文 §四） |

### 修复：打包输入暂存层（`scripts/pack-app-root.mjs`）

打包前把「运行期真正需要的文件」**完整复制**到 `<dist>/.pack-root/`，让
electron-builder 以它为 `directories.app`；打完删除。复制必须是真的复制（不是
符号链接）。白名单是**封闭**的：

```
lib/            # tsdown 产物 + 沙箱 preload
build/          # brand-prepare 派生的图标/托盘/web 品牌 + 随包 channel.json
cordis.patch.yml
package.json    # 去掉 build/devDependencies/scripts/peerDependencies/resolutions/files
```

sourcemap 在**进包之前**丢弃（`tsdown` 仍开 `sourcemap: true`，`lib/*.map` 对本地
排障有价值，只是不随包）——不靠打包后删除：`sourcesContent` 内嵌原始 TypeScript，
进过一次 asar 就等于泄露过。

四个打包脚本全部接线并 `try/finally` 清理：`package-dir.mjs`、`package-linux.mjs`、
`package-mac.ts`、`package-win.ts`、`release-mac.ts`（后三个把暂存函数做成可注入，
因为它们的用例用假路径驱动命令边界）。

### 附带发现（报告未提及，量级更大）

1. **`temp/` 里 263.18 MiB 的 squashfs 试验件进了包**：`temp/squash-gzip.squashfs`
   （149.22 MiB）与 `temp/squash-xz.squashfs`（113.95 MiB）是 2026-09-06 的
   AppImage 压缩实验遗留，因打包输入就是包目录而被整体收编。这是单项最大的泄漏。
2. **E2E 产物 45.5 MiB**：`.e2e-terminal`(16.4) + `.e2e-sidebar`(16.3) +
   `.e2e-foot-lane`(12.7) + 三类 `.real-env-*` 截图(~2.4)。
3. **`directories.output` 设成子目录会把老 dist 打进包**（报告 §4 已提，复现确认）：
   electron-builder 默认只排除 `<outDir>/*-unpacked`，**不排除输出目录本身**；
   实测用 `dist-ebtest` 时 asar 涨到 **3 527 MiB**（把 3.1 GB 的 `dist/` 历史产物
   连同本次输出一起收编）。现已显式 `!dist/**` 白名单化规避。

---

## 三、Electron 44.4.3 升级

- 版本面实测：npm `latest=44.4.3`、`beta=44.0.0-beta.6`、`alpha=45.0.0-alpha.10`；
  44 线稳定版 ≥ `44.2.0`，最新 `44.4.3`。
- pin 更新（4 个包 6 处）：`packages/host/desktop`（peer + dev）、
  `packages/host/browser`（peer + dev）、`packages/host/wasm-apps-host`（peer + dev）、
  `packages/host/enterprise`（dev）；`yarn.lock` 已随之更新。
- `tests/package.spec.ts` 的 Electron 断言改为**不写死版本号**：断言「精确 pin
  （非 range）」「peer == dev」「`yarn.lock` 里有该 pin」「主版本 ≥ 44」——
  避免"改了断言但漏改另一个字段"这类假绿。
- 上游基线本来就是 `^44.0.0`（`deepseek-harness/apps/desktop/package.json:50`），
  本次相当于把落下的一个大版本补上。

### breaking change 逐条核对（对我们的代码）

| 44 的变更 | 结论 | 依据 |
|---|---|---|
| calendar/contacts 权限改用系统提示 | 不踩 | 全仓零 `askForMediaAccess`/通讯录权限请求 |
| `clipboard` 移出渲染进程 + 按 W3C 重架构 | 不踩 | 渲染侧走 `navigator.clipboard` + 权限 handler（`APP_CLIPBOARD_PERMISSIONS`）；主进程侧用法不变 |
| 移除 32 位（win ia32 / linux armv7l）、Unity、macOS 12 | 不踩 | 交付面 = Linux x64 AppImage/deb、Windows x64 NSIS、macOS arm64 DMG |
| `net.request` 拒绝 `Sec-Fetch-Dest: document/frame/iframe/fencedframe` | 不踩 | `wasm-apps-host/src/electron-adapter.ts:205` 只发 API 请求（GET/POST + 显式头 + `redirect:'manual'`），从不带 `mode:'navigate'`，也无 iframe 导航 |
| Chromium 150→152 / V8 15.2 | 收益 | 安全回移与启动提速 |

`electronFuses`（`runAsNode` + `onlyLoadAppFromAsar`）在 44 依然有效：`afterPack`
的 `@electron/fuses` 步骤在真实产物上跑通（构建日志 `executing @electron/fuses`）。

### 45+ 的坑（本次**不改**，仅登记）

`safeStorage` 同步 API 在 45 弃用、46 移除，我们
`packages/host/wasm-apps-host/src/electron-adapter.ts` 用的是同步三件套
（`isEncryptionAvailable` / `encryptString` / `decryptString`）。**上 45 前必须先改异步**
（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）。

---

## 四、DevTools 策略（发布版关闭）

`webPreferences.devTools` 全仓从未覆写 ⇒ Electron 默认可用，客户机开一次 DevTools
即可读渲染层实现。现改为：`desktopWindowOptions(spec, icon, platform, app.isPackaged)`
→ `devTools: !packaged`（三个平台一致，开发态 `yarn dev` 保持可用）。

- 不破坏自动化：e2e 与真机探针走 `--remote-debugging-port` 的 **Chromium CDP**，
  不依赖 `webPreferences.devTools`；错误上报 preload 链路也不经过它。
- 判据：`tests/window-options.spec.ts` 的专作用例（打包态三平台全 false、
  开发态 true）；`tests/electron-runtime.spec.ts` 的替身 `isPackaged=false`，
  断言开发态为 true。

---

## 五、门禁（正反两侧都钉）

### 反例侧：`assertNoPackagedSourceLeaks`（afterPack）

`scripts/verify-packaged-runtime.ts` 新增禁止形态表，在 `tryListArchive` 里对**真实
asar 条目**逐条断言，命中即拒包（坏包产不出来，不靠人 review `files`）：

```
src/** · tests/** · scripts/** · 根级 *.ts|*.tsx
node_modules/@picoaide/*/{src,tests,docs}/**
*.map
.e2e-*/** · .real-env-*/** · temp/** · dist*/**
```

刻意**不**写成通用 `**/src/**`：第三方包把运行期代码放在 `src/` 下（`bowser`、
`debug`、`fontkit` 实测如此），粗排除会打断它们。

### 正例侧：`assertRuntimeAssetFamiliesSurvive`

只钉反例会漏掉"一刀切排除"——一条过宽的规则把随包内容删干净，产物"没有任何泄漏"、
反例门禁全绿。本轮**真实踩到**：`!**/*.md` 把
`dsh-memory-evolve/skills/*/SKILL.md` 与 `agent-presets/presets/**/SKILL.md` 一起排掉
（COI 技能同步会全部 `missing`），被既有的 `REQUIRED_PACKAGED_RUNTIME_ENTRIES`
当场拦下。正例锚用稳定前缀（技能 SKILL.md 家族），不用会随上游漂移的字面量。

### profile 锚点（本轮补的第三个方向）

`src/profile.ts` 在**组装期**用 `createRequire().resolve('<包>/package.json')` 定位每个
自有插件包的 `cordis.patch.yml`，解析发生在**包内**（asar 走 Electron fs 补丁）。
失败即 `prepareDesktopProfile()` 抛错 ⇒ **应用根本起不来**。而升级前
`REQUIRED_ASAR_EXPORTS` 只覆盖 enterprise 与 connectors 的一部分：`dsh-cron`、
`dsh-account-card`、`dsh-foot-menu`、`dsh-wasm-apps`、`dsh-browser`、
`dsh-wasm-apps-host`、`dsh-memory-evolve` **一个都没覆盖**。

现新增 `REQUIRED_PROFILE_PATCH_ANCHORS`（18 条 = 9 个包 × {package.json,
cordis.patch.yml}），在 asar 与物理两种布局里都断言；另有**对拍**用例直接从
`src/profile.ts` 的 `resolve('…/package.json')` 调用点推导期望集合（按"该包是否有
`cordis.patch.yml`"分流，上游 presets 包自然排除），新增自有插件时漏登记当场红。

### 接线守卫

辅助函数测得到 ≠ 被调用。`tests/pack-app-root.spec.ts` 读真源断言：五个打包脚本
都调用暂存层、都把 `staged.args` 传给 electron-builder、都用 `finally` 清理；
`tests/verify-packaged-runtime.spec.ts` 另断言 profile 锚点判据在**两套布局**里
都被真的调用（变异验证实测：删掉任一处调用，其余用例全绿）。

### 变异验证（全部实跑）

| 变异 | 结果 |
|---|---|
| 源码排除规则放宽成「任意包的 src」 | 红 3 条 |
| 删掉 sourcemap 规则 | 红 1 条 |
| 删掉 `temp/**` 规则 | 红 1 条 |
| 删掉 `.e2e` 规则 | 红 1 条 |
| 拆掉反例/正例判据的**接线** | 各红 1 条 |
| 把 `src` 加进暂存白名单 | 红 1 条 |
| 去掉 sourcemap 过滤 | 红 1 条 |
| 暂存时不删 `build` 字段 | 红 1 条 |
| 重跑不清旧暂存根 | 红 1 条 |
| 拆掉 `package-linux.mjs` 的接线 | 红 2 条 |
| 删掉 profile 锚点表中一条（cron patch） | 红 1 条（对拍） |
| 拆掉 profile 锚点的 asar 侧接线 | 红 1 条（接线守卫） |
| 拆掉 profile 锚点的物理侧接线 | 红 1 条（接线守卫） |

所有变异体均已还原并复算 sha256。

### 本轮修复过程中被门禁抓到的真实缺陷

1. `!**/*.md` 抹掉随包技能（既有 afterPack 清单抓到）—— 若只加排除规则不加正例断言，
   这条会静默出厂。
2. `stagePackAppRoot` 的「先清旧暂存根」在变异验证还原时**被误删**，新写的
   「重跑先清旧」用例当场变红抓回 —— 没有它，上一次打包的残留会被当输入收编
   （正是报告里 3 514.6 MB 产物的成因）。

---

## 六、测试口径与残留

- desktop 全套：**92 文件 / 975 通过 / 2 skipped**（含新增 `pack-app-root.spec.ts` 17 例、`verify-packaged-runtime.spec.ts` 新增 4 例 profile 锚点用例）。
- 真实产物验证：`node scripts/package-dir.mjs` 走完整管线（afterPack 在真实 asar 上跑），
  `node scripts/package-linux.mjs --no-prebuild` 出 AppImage + deb。
- 上表 AppImage 数字来自同机同脚本的**三次实打**（43.4.0 旧配置 / 43.4.0 新配置 /
  44.4.3 新配置），不是估算。

**残留 / 未做**：

1. **`node_modules/**` 仍是 128.83 MiB（占修复后 99.5%）**，其中上游包自带的
   `.ts`/`.d.ts`/README 有 ~13 MiB。**未动**：`!**/src/**` 会打断 `bowser`/`debug`/
   `fontkit` 这类"运行期代码就在 src/"的包，需要逐包判定，属独立课题。
2. **Windows / macOS 产物未在本机复打**（本机是 Linux）。三处打包脚本已同样接线，
   但 `verify-win-installer` / `verify-mac-smoke` 需要在对应平台跑过才算闭环。
3. **macOS 渠道包的公证链未复验**（与本次改动无关，但换 Electron 会重打所有包）。
4. `directories.output` 指向子目录时仍会把老 dist 收编 —— 现靠白名单化规避
   （暂存层只在白名单里放 `lib/build/cordis.patch.yml/package.json`），未去改
   electron-builder 行为。
5. `temp/` 下那两个 squashfs 试验件仍在工作树里（gitignored，275 MiB）。现在不会
   进包，**建议删掉**；但删完需要重跑一次 `yarn build`（它们在同一次构建里被读过）。
