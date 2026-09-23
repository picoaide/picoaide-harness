/** Fail-loud verification of the runtime entries sealed into Electron's app.asar. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { extractFile, listPackage } from '@electron/asar'
import AdmZip from 'adm-zip'
import { normalizeAsarEntry, toAsarEntryPath } from './asar-entry-path.ts'
import {
  FORBIDDEN_MACOS_NATIVE_ENTRIES,
  MACOS_ARM64_NATIVE_ENTRIES,
  resolveNativeEntry,
} from './mac-runtime.ts'

/** AfterPack fields consumed without importing Electron Builder's incomplete declaration graph. */
export interface PackagedRuntimeContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture (`4` is its stable universal enum value). */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
  /** Product metadata used to locate the macOS application bundle. */
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string
    }
    /** Launcher file name LinuxPackager pins (`dsh-plugin-desktop`); mac/win use `productFilename`. */
    readonly executableName?: string
  }
}

/** Exact archive entries required by the desktop launcher on every supported platform. */
export const REQUIRED_PACKAGED_RUNTIME_ENTRIES = [
  'package.json',
  'cordis.patch.yml',
  'lib/main.js',
  // Sandboxed preload (P0-6/D8):渲染进程未捕获错误经它转给主进程。缺了它,
  // 渲染进程采集会**静默**失效(窗口照常工作、错误一条都进不了 GlitchTip)——
  // 所以它必须在打包断言里逐条钉住。
  'lib/preload/renderer-error.cjs',
  'lib/client.js',
  'lib/index.js',
  'lib/profile.js',
  'lib/diagnostics.js',
  'lib/diagnostic-export-worker.js',
  'lib/update-checker.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-agent-presets.js',
  'lib/windows-pwsh-sandbox.js',
  'lib/windows-acl-runner.js',
  // P0-9(2026-09-20 升级审计):`lib/main.js` 静态 import 它(`assertRequiredRowsActive`)。
  // 它是独立 tsdown 入口(冒烟要 import 同一个真源)⇒ 打包产物里必须真的在,
  // 否则 Electron 主进程 import 期即 ERR_MODULE_NOT_FOUND(窗口都起不来)。
  // 这一条同时是 2026-09-20 那条教训的落地:「声明了的入口就必须构建,
  // 且 afterPack 清单必须覆盖真实 import」。
  'lib/startup-rows.js',
  // 同一条教训的补齐(2026-09-22 审计 R1/R2):这两个也由 `lib/main.js` 静态 import,
  // 且都是独立 tsdown 入口(出口策略探针 / profile 冒烟按文件名 import 构建产物)。
  // 名称一旦漂移,坏的是 import 期;`package.json` 的 `files: lib/**/*.js` 只是声明,
  // 这里才是**产物证据**。
  'lib/network-policy.js',
  'lib/document-lock-recovery.js',
  'build/app-icon.png',
  'build/app-icon-mac.png',
  // G-2（2026-09-23 审计）：`build/` 是**可枚举的构建期产物目录**，而清单此前只
  // 挑了其中 6 条 —— 删掉 `build/app-icon-mac.png` 这类条目**没有任何判据会红**
  // （其他用例 `it.each(清单)` 只证明"清单里的条目存在"，删条目=同时删用例）。
  // 现在由 `tests/verify-packaged-runtime.spec.ts` 的「清单必须覆盖可枚举产物
  // 目录」用例从磁盘枚举反推：目录里每个真实文件都必须在清单里
  // （`build/channel.json` 除外 —— 它只有渠道构建才产出，由
  // verify-channel-package.ts 负责）。这里把 brand-prepare 真实产出的多倍率托盘
  // 位图与 NSIS 安装文案补齐（2026-09-23 在真实 dist/linux-unpacked 的 app.asar
  // 上逐条核对过它们确实随包）。
  'build/tray-iconTemplate.png',
  'build/tray-iconTemplate@2x.png',
  'build/tray-icon-blue.png',
  'build/tray-icon-blue@1.25x.png',
  'build/tray-icon-blue@1.5x.png',
  'build/tray-icon-blue@2x.png',
  'build/assistedMessages.yml',
  // 品牌几何真源在包内的落点(`brand-prepare.mjs` 产出:官方构建 = brands/official/logo.svg
  // 的逐字节副本,渠道构建 = 该渠道自己的 mark)。被服务的 favicon 曾经是上游鱼(P0-2),
  // 这里同时断言"存在"与"内容不带上游特征"(见 assertBrandAssetSvg)。
  'build/web-brand/favicon.svg',
  // 官方兜底几何(P1-12):渠道 logo 被判定为不可信/损坏时,运行时回落到这一份
  // (src/brand-web-route.ts 候选链的最后一级,路径来自 src/index.ts)。少了它,
  // 打包态就没有兜底 —— 标签页直接回落到上游厂商图形。
  'build/web-brand/official.svg',
  'node_modules/@deepseek-ai/dsh/package.json',
  // Upstream 0.1.2: shipped presets moved from @deepseek-ai/dsh/config to
  // the agent-presets package root `presets/` directory.
  'node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml',
  'node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md',
  'node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  // G-2（2026-09-23 审计）：前端 dist 的**稳定名入口文档**必须随包。`index.html`
  // 之外的这两份是固定路径（不是内容哈希 chunk）—— 它们被 `/favicon.svg`、
  // `/manifest.webmanifest` 这类固定 URL 语义引用（桌面壳另用 brand-web-route 覆盖
  // 同名路由，文件本身仍是前端构建的一部分）。内容哈希 chunk 的名字随上游每次升级
  // 变化，**不**进本清单（进清单 = 每次升级都要改清单），它们由「归档里每个
  // lib/*.js 的 import 都必须在包里」那条产物驱动判据覆盖。
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  // 内置 COI 技能必须随包（P1，2026-09-16）：`dsh-memory-evolve` 启动时把包内
  // `skills/` 目录同步到用户技能库（`lib/coi/index.js` 的 PLUGIN_SKILLS_DIR，
  // `coiSyncSkills` 默认 true，用户开 COI 时执行）。2026-09-03 的瘦身提交
  // （70be3aa0db）把 `!**/node_modules/dsh-memory-evolve/skills/**` 和 src/tests/docs
  // 一起写进 `files`，于是产物里没有这个目录：同步对每个技能返回 `action:"missing"`，
  // 而同步路径只在成功时打日志 ⇒ 打包版"用户打开 COI 后内置技能一个都装不上"是静默的。
  // 修法=删掉那条排除；这里逐条钉住，别再排除（上游新增技能时先跑
  // tests/verify-packaged-runtime.spec.ts 的「清单覆盖源目录」用例，它会要求补齐）。
  'node_modules/dsh-memory-evolve/skills/kimi-cli-calling/SKILL.md',
  'node_modules/dsh-memory-evolve/skills/codex-cli-calling/SKILL.md',
  'node_modules/dsh-memory-evolve/skills/grok-cli-calling/SKILL.md',
  'node_modules/dsh-memory-evolve/skills/hermes-cli-calling/SKILL.md',
  'node_modules/dsh-memory-evolve/skills/memory-consolidate/SKILL.md',
  // 技能辅助文件（上游 v26091501 起技能按整目录同步，scripts/ 要跟着走）。
  'node_modules/dsh-memory-evolve/skills/memory-consolidate/scripts/scan_memory.mjs',
  // G-9（2026-09-20 升级审计）：`@deepseek-ai/dsh-sandbox-windows-acl`（**我们打补丁的包**）
  // 在 0.1.6-alpha.2 新增两处运行期静态 import，此前**没有任何清单覆盖**：
  //   lib/runner.js           → `@deepseek-ai/dsh-subprocess/control`（lib/control.js）
  //   lib/types-CutH1Lgc.js   → `@deepseek-ai/dsh-lazy-require`（lib/index.js）
  // 缺任一条 ⇒ 该插件模块加载失败，而 afterPack 的断言因为清单里没有这两个条目会**放行坏包**
  // （Windows 沙箱链路的报错只会出现在运行期）。判据见
  // tests/verify-packaged-runtime.spec.ts 的「补丁目标的静态子路径 import 必须在清单里」。
  'node_modules/@deepseek-ai/dsh-subprocess/package.json',
  'node_modules/@deepseek-ai/dsh-subprocess/lib/control.js',
  'node_modules/@deepseek-ai/dsh-lazy-require/package.json',
  'node_modules/@deepseek-ai/dsh-lazy-require/lib/index.js',
  // 平台内置技能（作者手册，2026-09-19 起叫 `app-builder`）**不在本清单里**，也不在包里：
  // 它的源目录已从本 vendored 包搬到服务端仓库的 `server/skills/app-builder/`，随服务端
  // 镜像发布、由员工在能力中心按需安装（`server/Dockerfile` 直接 COPY，客户端产物里
  // 没有它）。曾经在这里逐条钉住的 11 个条目（`skills/picoaide-app-builder/**`）随搬迁
  // 一并删除；`tests/verify-packaged-runtime.spec.ts` 的「清单必须覆盖 vendored 源目录
  // 每个文件、且不得留死条目」用例会自动要求这次同步 —— 源目录里没有它了，清单里也
  // 就不能再有它。要核对它随镜像分发，改看 scripts/ci-build-channel-images.sh 的
  // verify_image（镜像内断言 /opt/picoaide/skills/app-builder/SKILL.md）。
  //
  // 自有插件（@picoaide/*）必须随包（P2，2026-09-19）。它们**不在** `verify:closure` 的
  // 覆盖里：`scripts/runtime-closure.mjs:3` 的 `FIRST_PARTY_PREFIX = '@deepseek-ai/'` 只走
  // 上游包，而 desktop 的 `dependencies` 里有 7 个 `@picoaide` 包 —— 也就是说这 5 个包
  // （account-card / browser / cron / wasm-apps / wasm-apps-host）此前**没有任何门禁**保证
  // 它们进了 app.asar，只有 connectors / enterprise 在 REQUIRED_ASAR_EXPORTS 里被点名。
  // 同类事故已经发生过：`dsh-memory-evolve` 的 skills/ 被 `files` 排除规则静默丢出包
  // （2026-09-16 修复）。
  //
  // 路径形状依据（逐条落在磁盘上的真实产物上核对，2026-09-19）：
  //   - account-card / browser / cron 的这 5 条在 2026-09-16 打出的 v2.7.5-beta.1
  //     app.asar（`dist/linux-unpacked/resources/app.asar`）里逐条存在；
  //   - `@picoaide/dsh-wasm-apps` 建立（2026-09-18）与 `@picoaide/dsh-wasm-apps-host`
  //     建立（2026-09-19）都晚于那份产物 ⇒ 它们的条目**只**在磁盘上确认过
  //     （各自的 lib/ 产物 + package.json + cordis.patch.yml，与其余自有包的形状一致），
  //     **尚未经真实 app.asar 验证**：下一次打包后请复跑 verify-packaged-runtime
  //     （afterPack 会逐条断言）。wasm-apps-host 另有 `lib/electron-adapter.js`：
  //     它被 desktop `lib/main.js` 静态 import，缺它是**启动期**失败而非装配期。
  //   - 为什么这几条：`package.json` + `cordis.patch.yml` 是桌面 profile 在组装期用
  //     `createRequire(...).resolve('@picoaide/<pkg>/package.json')` 拼绝对路径读的两份
  //     （src/profile.ts），`lib/index.js` / `lib/client.js` / `lib/invariant.js` 是各包
  //     声明的入口；缺任何一条都表现为"那一行插件整块不装配"，且只在组装期可见。
  //   - 覆盖这几包的用例在 tests/verify-packaged-runtime.spec.ts 的
  //     「every @picoaide dependency is asserted」：新增自有插件依赖而不补清单即红。
  'node_modules/@picoaide/dsh-account-card/lib/index.js',
  'node_modules/@picoaide/dsh-account-card/lib/client.js',
  'node_modules/@picoaide/dsh-account-card/lib/invariant.js',
  'node_modules/@picoaide/dsh-account-card/package.json',
  'node_modules/@picoaide/dsh-account-card/cordis.patch.yml',
  'node_modules/@picoaide/dsh-browser/lib/index.js',
  'node_modules/@picoaide/dsh-browser/lib/client.js',
  'node_modules/@picoaide/dsh-browser/lib/invariant.js',
  // surface seam（§16.1）：`@picoaide/dsh-wasm-apps-host/lib/index.js` **值导入**
  // `BROWSER_SURFACE_SERVICE` 去取 browser 插件 provide 的 surface 注册表 —— 应用窗口
  // 就是经它注册成 `kind:'app'` 的（2026-09-21 审计 P0-1）。缺这个产物 ⇒ 打包版
  // 启动即 ERR_MODULE_NOT_FOUND（与 2026-09-20 的 app-proof 事故同一形态）。
  'node_modules/@picoaide/dsh-browser/lib/surface.js',
  // 同一条 seam 的另一半（2026-09-23 第三轮审计的反向 oracle 抓到）：应用窗口宿主
  // `lib/electron-adapter.js` 值导入 `@picoaide/dsh-browser/guard`（权限守卫 +
  // 应用 scheme 请求闸门），而 `electron-adapter.js` 被 desktop 的 `lib/main.js`
  // 静态 import ⇒ 这条掉出产物是**启动期** ERR_MODULE_NOT_FOUND（整个应用起不来），
  // 与上面 `surface.js` 完全同族。它此前不在三张表的任何一张里 —— 只有"清单必须覆盖
  // 产物的真实 specifier"这条反向判据能看见它。
  'node_modules/@picoaide/dsh-browser/lib/guard.js',
  'node_modules/@picoaide/dsh-browser/package.json',
  'node_modules/@picoaide/dsh-browser/cordis.patch.yml',
  'node_modules/@picoaide/dsh-cron/lib/index.js',
  'node_modules/@picoaide/dsh-cron/lib/client.js',
  'node_modules/@picoaide/dsh-cron/lib/invariant.js',
  'node_modules/@picoaide/dsh-cron/package.json',
  // 侧边栏底部「更多」行（2026-09-21 并道改造）：五个面板插件的底部条目都登记进它
  // 提供的 `picoFootMenu` 服务，`lib/client.js` 就是那个注册了**唯一**底部座位占用者
  // 的客户端 bundle。它**没有** `lib/invariant.js`（本包没有伴生不变量行），所以这里
  // 只列它真实声明的入口；`package.json` + `cordis.patch.yml` 仍是 profile 组装期
  // `createRequire(...).resolve('@picoaide/dsh-foot-menu/package.json')` 要读的两份。
  'node_modules/@picoaide/dsh-foot-menu/lib/index.js',
  'node_modules/@picoaide/dsh-foot-menu/lib/client.js',
  'node_modules/@picoaide/dsh-foot-menu/package.json',
  'node_modules/@picoaide/dsh-foot-menu/cordis.patch.yml',
  'node_modules/@picoaide/dsh-wasm-apps/lib/index.js',
  'node_modules/@picoaide/dsh-wasm-apps/lib/client.js',
  'node_modules/@picoaide/dsh-wasm-apps/lib/invariant.js',
  'node_modules/@picoaide/dsh-wasm-apps/package.json',
  'node_modules/@picoaide/dsh-wasm-apps/cordis.patch.yml',
  // 客户端专属 WASM 应用 origin（2026-09-19，契约 §2）：宿主插件（协议 handler +
  // 本机打开路由）。三条 lib 产物都是真实入口：`lib/index.js` 由 profile 行加载，
  // `lib/invariant.js` 是 Cordis 伴生行，`lib/electron-adapter.js` 被 desktop 的
  // `lib/main.js` 静态 import（协议特权注册 + 适配器实例），缺它 = 启动期
  // ERR_MODULE_NOT_FOUND（整个应用起不来，而不是某一行插件不装配）。
  'node_modules/@picoaide/dsh-wasm-apps-host/lib/index.js',
  'node_modules/@picoaide/dsh-wasm-apps-host/lib/invariant.js',
  'node_modules/@picoaide/dsh-wasm-apps-host/lib/electron-adapter.js',
  // 2026-09-20 补：`lib/main.js` 还**值导入** `…/app-proof`（安装密钥仓库）。
  // 此前该子路径既没被构建、也没进本清单 ⇒ 打包版启动报 ERR_MODULE_NOT_FOUND，
  // 而 afterPack 断言照样通过（清单不完整 = 门禁瞎）。同批补齐 tsdown 的 entry 列表。
  'node_modules/@picoaide/dsh-wasm-apps-host/lib/app-proof.js',
  'node_modules/@picoaide/dsh-wasm-apps-host/package.json',
  'node_modules/@picoaide/dsh-wasm-apps-host/cordis.patch.yml',
  // 宿主侧共享工具的**两个零依赖叶子包**（2026-09-20，构建环修复路线 A / A 扩展）。
  //
  // 为什么它们在产物里：desktop 的 `dependencies` 里有它们（`src/host-locale.ts` 与
  // `src/desktop-home.ts` 各是一行 re-export）⇒ `lib/host-locale.js`、
  // `lib/desktop-home.js`、`lib/main.js`、`scripts/*` 在运行期按包名解析它们；
  // browser / connectors 的 lib 同理（它们直接 import 叶子包）。缺任何一个都是
  // **启动期** ERR_MODULE_NOT_FOUND，与 wasm-apps-host 的 electron-adapter 同类。
  // 路径形状与其余自有包一致（`main`/`exports["."]` 都指向 `lib/index.js`）——
  // 它们**不是** Cordis 插件，所以没有 `cordis.patch.yml` / `lib/invariant.js` 条目。
  'node_modules/@picoaide/dsh-host-locale/lib/index.js',
  // 2026-09-23：`loopback.ts` 四份合一后，connectors / enterprise / browser / cron
  // 的 lib 都**运行期** import 这个**子路径**（tsdown 把 `dependencies` 当 external，
  // 所以各自的 `src/loopback.ts` re-export 不会被内联）。缺它就是**启动期**
  // ERR_MODULE_NOT_FOUND —— 正是本清单存在的理由，故逐条登记。
  'node_modules/@picoaide/dsh-host-locale/lib/loopback.js',
  'node_modules/@picoaide/dsh-host-locale/package.json',
  'node_modules/@picoaide/dsh-host-home/lib/index.js',
  'node_modules/@picoaide/dsh-host-home/package.json',
] as const

/** Physical entries that Electron cannot load from ASAR (native binaries). */
export const REQUIRED_UNPACKED_RUNTIME_ENTRIES = [
  // process.dlopen (native .node) and child_process.execFile (binaries) land here.
  // smartUnpack unpacks whole package dirs containing them.
  // P2-52: 路径必须与真实产物一致(2026-09-08 在 dist/linux-unpacked 上逐条核对)。
  // 原清单 7 条里 3 条不存在(koffi 少一层 linux_x64/、require-builtin 少
  // prebuilt/、node-pty 的 spawn-helper 只存在于 darwin prebuilds),
  // 而旧实现只要求「至少一项存在」→ afterPack 门禁空转。
  'node_modules/node-pty/prebuilds/linux-x64/pty.node',
  'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node',
  'node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node',
  'node_modules/node-addon-require-builtin-linux-x64-gnu/prebuilt/linux-x64-gnu-napi-v9.node',
  'node_modules/@vscode/ripgrep-linux-x64/bin/rg',
  // The landlock-run launcher is spawned (never dlopen'd) by the process
  // sandbox. Electron cannot spawn a virtual asar path (only execFile is
  // patched), so it must stay physical — the desktop asar-spawn rewrite
  // resolves the virtual path to this twin at spawn time.
  'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
  // rc.2 的会话写入走 @deepseek-ai/node-addon-system 的 flock(dlopen 平台包里的
  // system.node)。旧清单只列 landlock-run ⇒「启动器在、flock 模块缺」时家族断言
  // 仍然通过,而会话写入会退化成"写失败 + 不可读的内部错误"(P1-5/P2-15)。
  // linux 平台包同时带 glibc / musl 两个 libc 变体,两个都要在。
  'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
  'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node',
] as const

/**
 * Brand geometry staged by `brand-prepare.mjs` (official build: a byte copy of
 * `brands/official/logo.svg`; channel build: that channel's own mark, which is
 * a completely different drawing — a white-label mark has no `scale(1.25)`).
 */
export const PACKAGED_WEB_BRAND_FAVICON = 'build/web-brand/favicon.svg'

/**
 * Official brand geometry staged by `brand-prepare.mjs` on **every** build
 * (channel builds included).
 *
 * 运行时用它做候选链的最后一级:`src/index.ts` 的 `officialLogoPath` →
 * `build/web-brand/official.svg`(2026-09-12 审计 P1-12;旧值指向
 * `brands/official/logo.svg`,那个路径在 src/lib/app.asar 三套布局下都不存在,
 * 于是"渠道 logo 不可信时回落官方"是死代码)。
 */
export const PACKAGED_WEB_BRAND_OFFICIAL = 'build/web-brand/official.svg'

/** 随包分发的品牌几何(存在性 + 内容都要过门禁)。 */
export const PACKAGED_WEB_BRAND_ASSETS = [
  PACKAGED_WEB_BRAND_FAVICON,
  PACKAGED_WEB_BRAND_OFFICIAL,
] as const

/**
 * 包里**绝不允许出现**的条目形态（2026-09-22 泄漏修复的 afterPack 反向断言）。
 *
 * 背景：`build.files` 里曾经写着「仅根级 TypeScript」的两条排除（单星号写法），
 * 而 minimatch 的 `*` **不跨 `/`** —— 只匹配根级。加上 `lib/**` 把 `lib/` 内容
 * 平铺到 asar 根，于是 `lib/` 下的 sourcemap 与各包的源码目录一起进了发布包；
 * 那条 map 排除同理只匹配「某个目录的直属文件」，根级的 map 全部漏过。
 * 实测 11 个已发布的正式/预发包都带着：
 *   - 桌面包自身源码目录（76 个文件）+ 测试目录 + 构建脚本目录，其中含发布/公证脚本
 *   - 各 `@picoaide/dsh-*` 的源码目录（工作区依赖是 symlink，electron-builder 会
 *     **忽略子包自己的 `files` 字段**整体收编，`.spec.tsx` 也在内）
 *   - 33 个 sourcemap，`sourcesContent` 里内嵌**原始 TypeScript 源码**
 * 而 `webPreferences.devTools` 从没被覆写（Electron 默认可用）⇒ 客户开一次 DevTools
 * 就能把源码读出来。
 *
 * 这张表就是「下次别再犯」的判据：排除规则是**声明**，这里是**证据**。
 * 断言放在 afterPack ⇒ 坏包根本产不出来（不是靠人 review `files`）。
 */
export const FORBIDDEN_PACKAGED_ARCHIVE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // 桌面包自身源码（asar 根）。`lib/**` 平铺只搬 lib 的内容，src/tests 到不了这里。
  ['desktop sources (src/**)', /^src\//u],
  ['desktop tests (tests/**)', /^tests\//u],
  ['desktop build scripts (scripts/**)', /^scripts\//u],
  ['desktop root TypeScript config/sources', /^[^/]+\.(ts|tsx|mts|cts)$/u],
  // 工作区包源码：electron-builder 不遵守子包 `files`，必须在这里兜底。
  ['workspace package sources (@picoaide/*/src/**)', /^node_modules\/@picoaide\/[^/]+\/src\//u],
  ['workspace package tests (@picoaide/*/tests/**)', /^node_modules\/@picoaide\/[^/]+\/tests\//u],
  ['workspace package docs (@picoaide/*/docs/**)', /^node_modules\/@picoaide\/[^/]+\/docs\//u],
  // sourcemap 是**独立**泄漏面（`sourcesContent` = 原始 TS 源码），与上面的 .ts 分开判。
  ['sourcemaps', /\.map$/u],
  // 开发期产物。`.e2e-*` 是 E2E 的截图/缓存目录，实测每个 12~16 MiB。
  ['E2E artifacts (.e2e-*/**)', /^\.e2e-/u],
  ['real-env artifacts (.real-env-*/**)', /^\.real-env-/u],
  // 打包脚本的临时目录（曾经装着 156 MiB + 119 MiB 的 squashfs 试验件）。
  ['build temp directory (temp/**)', /^temp\//u],
  // 打包**工具**的中间产物。与上面几条不同：它曾经落在随包白名单条目 `build/`
  // 内部（`build/` 是**整目录复制**），所以"看着像开发期文件"却照样进包。
  // 2026-09-23 独立复审 N-1：渠道构建生成的 electron-builder 配置（含渠道
  // productName/appId/深链 scheme/产物名模板）就是这样进了 beta 与各品牌渠道的
  // asar —— 官方渠道不生成它，所以本机跑官方打包看不见。现在它生成在包根 `temp/`
  // （随包白名单之外）。这条是产物侧的第二道闸；输入侧第一道闸在
  // `pack-app-root.mjs` 的 `PACK_APP_ROOT_FORBIDDEN_ENTRIES`（暂存前 fail-loud）。
  ['channel builder config (build/channel-electron-builder.cjs)', /^build\/channel-electron-builder\.cjs$/u],
  ['previous build output (dist*/**)', /^dist[^/]*\//u],
]

/**
 * Fail the build when the packaged archive carries first-party sources, sourcemaps
 * or development artifacts.
 *
 * 只做**反例**判定（`entries` 是完整包内容）。正例方向由
 * {@link assertRuntimeAssetFamiliesSurvive} 单独负责 —— 两个方向拆开，
 * 单测才能在只喂一份精简条目集的情况下分别验证，而不会因为「缺正例」把反例
 * 用例也一起染红。
 * @param entries - normalized entry paths (forward slashes, no leading slash).
 * @param where - archive/root path for the error message.
 */
export function assertNoPackagedSourceLeaks(
  entries: Iterable<string>,
  where: string,
): void {
  const present = [...entries]
  const violations: string[] = []
  for (const [label, pattern] of FORBIDDEN_PACKAGED_ARCHIVE_PATTERNS) {
    const hits = present.filter(entry => pattern.test(entry))
    if (hits.length === 0) continue
    const sample = hits.slice(0, 5).join(', ')
    violations.push(`${label}: ${String(hits.length)} (e.g. ${sample})`)
  }
  if (violations.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged archive at ${where} leaks first-party sources or dev artifacts: `
      + violations.join('; '),
    )
  }
}

/**
 * 与 Electron / Node 版本无关的**稳定**路径锚。
 *
 * 只用固定前缀，不用"最新那个技能名"之类会随上游漂移的字面量 —— 漂移的锚会让
 * 门禁变成"改上游就要改断言"，而那正是它被绕过的方式（参考本项目已有的教训：
 * 判据要能被打坏，但锚点必须稳定）。
 */
export const RUNTIME_ASSET_FAMILIES: ReadonlyArray<RegExp> = [
  /^node_modules\/dsh-memory-evolve\/skills\/[^/]+\/SKILL\.md$/u,
  /^node_modules\/@deepseek-ai\/dsh-agent-presets\/presets\/cordis\/skills\/[^/]+\/SKILL\.md$/u,
]

/**
 * 正例侧：**内容级**运行期资产不得被排除规则整体抹掉。
 *
 * 为什么需要这一半：只钉「不得有源码 / sourcemap」的话，一条过宽的排除规则
 * （例如「排除全部 `.md`」）会把随包运行期内容一起删掉，而产物"没有任何泄漏"、
 * 反例门禁全绿 —— 这正是本项目已登记过的"假绿"形态（只钉一侧）。
 * 本轮**实测踩到**：一条「排除全部 .md」的过宽规则把随包技能 SKILL.md 一起排掉
 * （`dsh-memory-evolve/skills/<技能>/SKILL.md` 与 agent-presets 的 presets 技能树），
 * COI 技能同步会全部 `missing`。
 *
 * 与 `REQUIRED_PACKAGED_RUNTIME_ENTRIES` 的分工：那张表钉**具体文件存在**；
 * 这里钉**某个内容家族整体还在** —— 上游新增技能时前者要靠人补条目（已有
 * "清单必须覆盖源目录"用例驱动），后者当场就能发现"整类被排除规则干掉"。
 * @param entries - normalized entry paths (forward slashes, no leading slash).
 * @param where - archive/root path for the error message.
 */
export function assertRuntimeAssetFamiliesSurvive(
  entries: Iterable<string>,
  where: string,
): void {
  const present = [...entries]
  const missing = RUNTIME_ASSET_FAMILIES.filter(family => !present.some(entry => family.test(entry)))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged archive at ${where} has no surviving entries for runtime asset `
      + `families: ${missing.map(String).join(', ')} `
      + '(an over-broad exclusion rule removed content the runtime reads)',
    )
  }
}

/**
 * Upstream-only markers the packaged brand asset must never carry.
 *
 * `48.8354` is a coordinate of the upstream DeepSeek fish path shipped by
 * `@deepseek-ai/dsh-web-frontend/dist/favicon.svg`; the vendor names catch a
 * text-level fallback. Measured 2026-09-12: upstream favicon contains the fish
 * coordinate, `brands/official/logo.svg` contains neither.
 */
const FORBIDDEN_BRAND_MARKERS = [
  { pattern: /48\.8354/u, label: '上游鱼形路径坐标' },
  { pattern: /DeepSeek|deepseek-harness/iu, label: '上游厂商名' },
] as const

/**
 * Assert one packaged brand asset is an SVG document without upstream markers
 * (P0-2 的门禁半边:被服务的 favicon / PWA 图标曾经整体是上游品牌,而所有
 * Electron 界面都显示我方品牌 —— 品牌层在构建期失效时必须在打包时拦住)。
 * @param svg - 文件内容。
 * @param where - 错误信息里的位置(档案路径或物理路径)。
 * @returns Nothing; failure rejects with the offending marker.
 */
export function assertBrandAssetSvg(svg: string, where: string): void {
  if (!/<svg[\s/>]/u.test(svg)) {
    throw new Error(`dsh-plugin-desktop: packaged brand asset ${where} is not an SVG document`)
  }
  for (const { pattern, label } of FORBIDDEN_BRAND_MARKERS) {
    if (pattern.test(svg)) {
      throw new Error(
        `dsh-plugin-desktop: packaged brand asset ${where} carries ${label} (${String(pattern)}); `
        + 'the brand layer failed at build time (brand-prepare.mjs) and the upstream mark would ship',
      )
    }
  }
}

/** Prebuilt Node-API modules required when the Windows package skips native source rebuilds. */
export const REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES = [
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
] as const

/**
 * What the POSIX native addon must look like in a packaged tree.
 *
 * `@deepseek-ai/node-addon-system` publishes platform packages for darwin and
 * linux only — its optionalDependencies list has no win32 member, and its
 * `flock` entry throws on Windows by design. Windows session locking lives in
 * the persistence package itself (kernel32 named semaphores through koffi), so
 * a Windows package legitimately ships no family directory at all.
 */
export type NativeAddonRequirement = 'family-and-launcher' | 'family' | 'none'

/**
 * Resolve the native-addon requirement for one Electron platform.
 * @param electronPlatformName - Electron's `process.platform` value.
 * @returns the requirement the packaged tree must satisfy.
 */
export function nativeAddonRequirement(electronPlatformName: string): NativeAddonRequirement {
  if (electronPlatformName === 'linux') return 'family-and-launcher'
  if (electronPlatformName === 'darwin') return 'family'
  return 'none'
}

/**
 * Physical files every platform package of `@deepseek-ai/node-addon-system` must
 * ship. linux carries the spawned landlock launcher plus the dlopen'd flock
 * module in both libc flavours; darwin carries the dlopen'd module only (its
 * package has no `landlock-run`, which is a Linux-only launcher).
 */
const NATIVE_ADDON_PLATFORM_FILES: Record<string, readonly string[]> = {
  linux: ['bin/landlock-run', 'bin/glibc/system.node', 'bin/musl/system.node'],
  darwin: ['bin/system.node'],
}

/**
 * Resolve the `node-addon-system` platform packages a packaged tree must carry,
 * keyed by Electron Builder's arch enum (`0` ia32, `1` x64, `3` arm64,
 * `4` universal).
 *
 * P2-16: the family check used to accept "any platform package with a
 * landlock-run", which an x64 artifact satisfied through the linux-arm64 copy
 * that `supportedArchitectures` also installs (measured in
 * `dist/linux-unpacked`: both `node-addon-system-linux-x64` and
 * `-linux-arm64` are present). The flock module is dlopen'd, so the CPU has to
 * match or session writes fail at runtime.
 * @param electronPlatformName - Electron's `process.platform` value.
 * @param arch - Electron Builder target arch; undefined when the caller cannot know it.
 * @returns required package names; empty means "no arch-specific requirement"
 *   (legacy behaviour: any family member satisfies the family check).
 */
export function nativeAddonPlatformPackages(
  electronPlatformName: string,
  arch?: number,
): readonly string[] {
  const cpu = arch === 0 ? 'ia32' : arch === 1 ? 'x64' : arch === 3 ? 'arm64' : undefined
  if (electronPlatformName === 'linux') {
    // Upstream publishes linux-x64 / linux-arm64 only (optionalDependencies);
    // there is no linux-ia32 platform package.
    return cpu === 'x64' || cpu === 'arm64'
      ? [`@deepseek-ai/node-addon-system-linux-${cpu}`]
      : []
  }
  if (electronPlatformName === 'darwin') {
    // A universal bundle carries both slices, so both platform packages must
    // be physical; a single-arch build needs exactly its own.
    if (arch === 4) {
      return [
        '@deepseek-ai/node-addon-system-darwin-arm64',
        '@deepseek-ai/node-addon-system-darwin-x64',
      ]
    }
    return cpu === 'x64' || cpu === 'arm64'
      ? [`@deepseek-ai/node-addon-system-darwin-${cpu}`]
      : []
  }
  return []
}

/** CPU-specific runtime assets that must coexist in a universal macOS application. */
export const REQUIRED_MACOS_UNIVERSAL_ENTRIES = [
  ...MACOS_ARM64_NATIVE_ENTRIES.map(entry => entry.path),
] as const

/** x64 目标（含"调用方没给 arch"的历史形态，与本文件其余 arch 判据同口径）。 */
function targetIsX64(arch: number | undefined): boolean {
  return arch === undefined || arch === 1
}

/**
 * 一个「按平台/架构存在的原生包家族」（G-1，2026-09-23 审计）。
 *
 * 为什么需要它：`REQUIRED_UNPACKED_RUNTIME_ENTRIES` 混装了多个**只在特定平台/架构
 * 才存在**的原生包（`node-pty` 的 linux-x64 prebuild、`@img/sharp-linux-x64`、
 * `@koromix/koffi-linux-x64`、`@vscode/ripgrep-linux-x64`、
 * `node-addon-require-builtin-linux-x64-gnu`），而完整性与否的判据是
 * 「**整包目录存在**才逐条判」⇒ 整包被删（上游拆包/改名、`asarUnpack` glob 失效、
 * `supportedArchitectures` 变化 —— 0.1.5 的 `node-addon-landlock-run` →
 * `node-addon-system` 改名就是这个形态）时 afterPack **全部 PASS**：审计实测整包
 * 删掉上面五个家族后门禁依然全绿，唯一会发现的是运行期的 dlopen / execFile 失败。
 *
 * 现在每个家族都带**显式的适用性判据**：
 *   - `applies` 为真 ⇒ 家族内每一条都必须在产物里（整包目录不在 = 更直白的诊断）；
 *   - `applies` 为假 ⇒ 平台/架构确实不适用，缺席合法。
 * 「不适用」不再是"目录碰巧不在"这种隐式推断，而是一行可审阅的声明。
 */
export interface NativePlatformFamily {
  /** 家族名（报错信息用）。 */
  readonly id: string
  /** 家族所属包目录（相对 unpacked 根）：整包在此 ⇒ 全族资产都掉出产物。 */
  readonly packageDir: string
  /** 该家族在清单里登记的必需条目（相对 unpacked 根）。 */
  readonly entries: readonly string[]
  /** 这一族承载什么（报错时说明后果）。 */
  readonly purpose: string
  /** 该家族在当前平台/架构下是否**必须存在**。 */
  readonly applies: (electronPlatformName: string, arch: number | undefined) => boolean
}

/**
 * 原生包家族表（G-1）。
 *
 * 覆盖：`REQUIRED_UNPACKED_RUNTIME_ENTRIES` ∪ `REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES`
 * 里除 `@deepseek-ai/node-addon-system*` 之外的每一条 —— 后者有更严的架构感知断言
 * （见 {@link NATIVE_FAMILY_EXEMPT_ENTRIES} 与 `verifyPackagedRuntime` 里
 * `family-and-launcher` 那段）。两向完备性由
 * `tests/verify-packaged-runtime.spec.ts` 的「家族表覆盖清单每一条」用例钉住。
 */
export const NATIVE_PLATFORM_FAMILIES: readonly NativePlatformFamily[] = [
  {
    id: 'node-pty（linux-x64 prebuild）',
    packageDir: 'node_modules/node-pty',
    entries: ['node_modules/node-pty/prebuilds/linux-x64/pty.node'],
    purpose: '本机命令执行与终端托管走 node-pty 的 linux-x64 prebuild（subprocess-local）',
    applies: (platform, arch) => platform === 'linux' && targetIsX64(arch),
  },
  {
    id: '@img/sharp-linux-x64',
    packageDir: 'node_modules/@img/sharp-linux-x64',
    entries: ['node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node'],
    purpose: '托盘/应用图标的位图派生走 sharp（缺它品牌图与图标派生整类失败）',
    applies: (platform, arch) => platform === 'linux' && targetIsX64(arch),
  },
  {
    id: '@koromix/koffi-linux-x64',
    packageDir: 'node_modules/@koromix/koffi-linux-x64',
    entries: ['node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node'],
    purpose: 'koffi 承载本机调用（缺它相关原生调用在运行期才炸）',
    applies: (platform, arch) => platform === 'linux' && targetIsX64(arch),
  },
  {
    id: 'node-addon-require-builtin-linux-x64-gnu',
    packageDir: 'node_modules/node-addon-require-builtin-linux-x64-gnu',
    entries: ['node_modules/node-addon-require-builtin-linux-x64-gnu/prebuilt/linux-x64-gnu-napi-v9.node'],
    purpose: 'requireBuiltin 的 linux-x64 glibc 变体（缺它对应能力在运行期才炸）',
    applies: (platform, arch) => platform === 'linux' && targetIsX64(arch),
  },
  {
    id: '@vscode/ripgrep-linux-x64',
    packageDir: 'node_modules/@vscode/ripgrep-linux-x64',
    entries: ['node_modules/@vscode/ripgrep-linux-x64/bin/rg'],
    purpose: '文件搜索（glob/grep 工具）execFile 的物理二进制；它不可能从 asar 里执行',
    applies: (platform, arch) => platform === 'linux' && targetIsX64(arch),
  },
  {
    id: 'node-pty（win32-x64 prebuild）',
    packageDir: 'node_modules/node-pty',
    entries: REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
    purpose: 'Windows 的 ConPTY 原生面（pty.node / conpty* / OpenConsole.exe / conpty.dll）',
    applies: (platform, arch) => platform === 'win32' && targetIsX64(arch),
  },
]

/**
 * 不归家族表管的清单条目（每条写明由谁负责）—— 让"家族表覆盖清单"是**全等**
 * 而不是"至少覆盖一部分"：清单新增一条原生条目却没人分类 ⇒ 红。
 */
export const NATIVE_FAMILY_EXEMPT_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  [
    'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
    '架构感知的 node-addon-system 断言（nativeAddonPlatformPackages + family-and-launcher）',
  ],
  [
    'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
    '架构感知的 node-addon-system 断言（NATIVE_ADDON_PLATFORM_FILES）',
  ],
  [
    'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node',
    '架构感知的 node-addon-system 断言（NATIVE_ADDON_PLATFORM_FILES）',
  ],
]

/**
 * 逐家族断言「按平台存在的原生包」真的在产物里（G-1）。
 *
 * 与 `verifyPackagedRuntime` 里那条「包目录存在才逐条判」的过滤互补：那条对
 * **整包缺失**是静默的，而整包缺失恰是最可能的真实故障形态。这里按家族再判一次，
 * `applies` 为真时整包缺席即红。
 *
 * 不在本表的两类：`@deepseek-ai/node-addon-system*`（上面有更严的架构感知断言）、
 * darwin 的原生文件（它们以**绝对路径**进 `requiredPhysicalEntries`，本来就不受
 * "整包不存在跳过"影响，另由 verify-mac-smoke / verify-mac-release 覆盖）。
 * @param electronPlatformName - Electron's `process.platform` value.
 * @param arch - Electron Builder target arch（undefined = 老调用方/未声明）。
 * @param unpackedRoot - `app.asar.unpacked` 根。
 * @param exists - physical-file probe（生产 = `fs.existsSync`）。
 * @returns Nothing; failure rejects the package before signing.
 */
export function assertNativePlatformFamilies(
  electronPlatformName: string,
  arch: number | undefined,
  unpackedRoot: string,
  exists: FileProbe = existsSync,
): void {
  // 整棵 unpacked 树都不在时不动手：那种形态由「has no native unpacked entries」
  // 拦下（单测也用"注入探针 + 不存在的伪路径"跑正例，这里不能误报）。
  if (!exists(unpackedRoot)) return
  for (const family of NATIVE_PLATFORM_FAMILIES) {
    if (!family.applies(electronPlatformName, arch)) continue
    const missing = family.entries.filter(entry => !exists(join(unpackedRoot, entry)))
    if (missing.length === 0) continue
    const wholePackage = !exists(join(unpackedRoot, family.packageDir))
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} is missing the ${family.id} native family: `
      + `${missing.join(', ')}`
      + (wholePackage ? `（整包目录 ${family.packageDir} 不存在 —— 全族资产都掉出产物了）` : '')
      + ` — ${family.purpose}`,
    )
  }
}


/** Injectable archive listing seam used by focused tests. */
export type ArchiveLister = (archivePath: string, options: { isPack: boolean }) => readonly string[]

/** Injectable physical-file probe used by focused tests. */
export type FileProbe = (filename: string) => boolean

/** Inputs understood by the bundled diagnostics Worker. */
interface PackagedDiagnosticWorkerData {
  readonly logsDir: string
  readonly userDataDir: string
  readonly appVersion: string
  readonly maxEvidenceBytes: number
  readonly crashDumpsDir: string
}

/** Injectable packaged Worker launcher used by focused tests. */
export type PackagedDiagnosticWorkerLauncher = (
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
) => Promise<string>

/** Injectable smoke seam used to verify afterPack ordering. */
export type PackagedDiagnosticWorkerSmoke = (
  unpackedRoot: string,
  launch?: PackagedDiagnosticWorkerLauncher | undefined,
  asarPath?: string | undefined,
) => Promise<void>

/** Result posted by the bundled diagnostics Worker. */
type PackagedDiagnosticWorkerResult =
  | { readonly ok: true, readonly path: string }
  | { readonly ok: false, readonly error: string }

const PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS = 30_000

/** Start the physical packaged diagnostics Worker and wait for its terminal result. */
async function launchPackagedDiagnosticWorker(
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      name: 'dsh-packaged-diagnostic-smoke',
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker timed out after ${String(PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)}ms`,
      ))
    }, PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate()
      complete()
    }
    worker.once('message', (result: PackagedDiagnosticWorkerResult) => {
      if (result.ok) settle(() => resolve(result.path))
      else settle(() => reject(new Error(result.error)))
    })
    worker.once('error', cause => settle(() => reject(cause)))
    worker.once('exit', (code) => {
      settle(() => reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker exited with code ${String(code)}`,
      )))
    })
  })
}

/** Rebuild a minimal afterPack context from an unpackedRoot (smoke convenience). */
function contextForUnpackedRoot(unpackedRoot: string): PackagedRuntimeContext {
  const resources = dirname(unpackedRoot)
  let appOutDir: string
  let electronPlatformName: string
  if (resources.endsWith(join('Resources'))) {
    appOutDir = dirname(dirname(resources))
    electronPlatformName = 'darwin'
  } else if (resources.endsWith('resources')) {
    appOutDir = dirname(resources)
    electronPlatformName = 'win32'
  } else {
    appOutDir = dirname(resources)
    electronPlatformName = 'linux'
  }
  return { appOutDir, electronPlatformName, packager: { appInfo: { productFilename: '' } } }
}

/** Exercise the physical Worker emitted beside app.asar with a minimal archive. */
export async function smokePackagedDiagnosticWorker(
  unpackedRoot: string,
  launch: PackagedDiagnosticWorkerLauncher = launchPackagedDiagnosticWorker,
  asarPath?: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-diagnostics-'))
  // The worker lives inside app.asar now; extract it to a physical temp path so
  // the packaging machine's plain Node can run it (it has no asar fs patch).
  const archivePath = asarPath ?? resolvePackagedAsarPath(contextForUnpackedRoot(unpackedRoot))
  let workerTmp = join(root, 'lib', 'diagnostic-export-worker.js')
  try {
    // The worker imports shared chunks from lib/; extract the whole lib/ JS
    // surface into the temp dir so ESM resolution works.
    const libDir = join(root, 'lib')
    mkdirSync(libDir, { recursive: true })
    const entries = listPackage(archivePath, { isPack: false })
    for (const rawEntry of entries) {
      const entry = normalizeArchiveEntry(rawEntry)
      if (!entry.startsWith('lib/') || !entry.endsWith('.js')) continue
      const name = entry.slice('lib/'.length)
      // extractFile re-joins with the platform separator, so pass the exact
      // archive-relative spelling (rawEntry minus its leading separator) —
      // re-synthesizing with '/' would mismatch on Windows (`\lib\...`).
      writeFileSync(join(libDir, name), extractFile(archivePath, rawEntry.replace(/^[/\\]+/u, '')))
    }
    // The worker imports the third-party adm-zip package; extract its files too.
    for (const rawEntry of entries) {
      const entry = normalizeArchiveEntry(rawEntry)
      if (!entry.startsWith('node_modules/adm-zip/')) continue
      // listPackage yields directory entries too; skip extensionless paths
      // (extractFile fails on dirs).
      const baseName = entry.slice(entry.lastIndexOf('/') + 1)
      if (!baseName.includes('.')) continue
      const dest = join(root, entry)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, extractFile(archivePath, rawEntry.replace(/^[/\\]+/u, '')))
    }
    writeFileSync(workerTmp, extractFile(archivePath, 'lib/diagnostic-export-worker.js'))
  } catch (cause) {
    // Fallback: physical tree (the `asar: false` layout, or a development
    // tree). The worker resolves its shared chunk siblings from its own
    // directory, so launch the in-place physical file rather than copying a
    // single file into a temp tree that lacks the chunks.
    const physical = join(unpackedRoot, 'lib', 'diagnostic-export-worker.js')
    if (!existsSync(physical)) {
      throw new Error(
        `smoke: worker missing from asar and physical tree (${physical}); extraction failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    workerTmp = physical
  }
  const logsDir = join(root, 'logs')
  const userDataDir = join(root, 'user-data')
  const crashDumpsDir = join(root, 'Crashpad')
  mkdirSync(logsDir)
  mkdirSync(userDataDir)
  mkdirSync(join(crashDumpsDir, 'pending'), { recursive: true })
  writeFileSync(join(logsDir, 'dsh-2000-01-01.log'), 'packaged worker smoke\n')
  writeFileSync(join(crashDumpsDir, 'pending', 'packaged-smoke.dmp'), 'packaged crash dump smoke\n')
  try {
    const output = await launch(
      workerTmp,
      { logsDir, userDataDir, appVersion: 'packaged-smoke', maxEvidenceBytes: 1024, crashDumpsDir },
    )
    if (!existsSync(output)) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker produced no archive at ${output}`)
    }
    const crashEntry = 'crash-dumps/pending/packaged-smoke.dmp'
    if (new AdmZip(output).getEntry(crashEntry) === null) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker omitted ${crashEntry}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Resolve the platform-specific archive produced by Electron Builder.
 * @param context - completed application directory and target platform.
 * @returns absolute path to the packaged app.asar.
 */
export function resolvePackagedAsarPath(context: PackagedRuntimeContext): string {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar',
    )
  }
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') {
    return join(context.appOutDir, 'resources', 'app.asar')
  }
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/**
 * Resolve the physical dependency tree emitted beside app.asar.
 * @param context - completed application directory and target platform.
 * @returns absolute path to app.asar.unpacked.
 */
export function resolvePackagedUnpackedRoot(context: PackagedRuntimeContext): string {
  return `${resolvePackagedAsarPath(context)}.unpacked`
}

/**
 * Resolve the physical application root emitted when Electron Builder packs
 * with `asar: false` (a fallback layout kept for an `asar: false` build; every
 * current packaging path emits `app.asar`, so the archive checks are the ones
 * that run in practice).
 * @param context - completed application directory and target platform.
 * @returns absolute path to the unpacked application root.
 */
export function resolvePackagedAppRoot(context: PackagedRuntimeContext): string {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app',
    )
  }
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') {
    return join(context.appOutDir, 'resources', 'app')
  }
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/** Normalize the host-specific separators emitted by the ASAR reader. */
function normalizeArchiveEntry(entry: string): string {
  return normalizeAsarEntry(entry)
}

/**
 * Read one package-relative entry out of a packaged root.
 *
 * `app.asar` needs Electron's archive reader; the physical (`asar: false`)
 * layout is a real directory. The 4th parameter of {@link verifyPackagedRuntime}
 * lets tests inject this seam (it is the only place the gate reads package
 * *content* rather than listing entries).
 */
export type PackageEntryReader = (root: string, entry: string) => string

/**
 * Default entry reader (archive vs physical tree).
 *
 * `@electron/asar` v3 的 `getNode()` 按 `path.sep` 切分目录，所以传给它的归档内路径
 * 必须是**平台分隔符**形状：Windows 上传 `'/'` 分隔的常量会整串当成一个目录名，
 * 报 `"…" was not found in this archive`（2026-09-12 CI 实测：Linux 绿、Windows 红）。
 */
function readPackagedEntry(root: string, entry: string): string {
  return root.endsWith('.asar')
    ? extractFile(root, toAsarEntryPath(entry)).toString('utf8')
    : readFileSync(join(root, entry), 'utf8')
}

/**
 * Verify the packaged brand geometry by reading it back out of the package
 * (archive or physical tree) and asserting it is our SVG, not the upstream
 * mark (P0-2/P0-3)。两份都要:**被服务的 favicon** 与**官方兜底**(P1-12;
 * 兜底那份必须是官方几何 —— 它正是"渠道图形不可信"时的回落目标)。
 * @param read - reads one package-relative entry.
 * @param where - location prefix for error messages.
 * @returns Nothing; failure rejects an upstream/unreadable brand asset.
 */
function verifyWebBrandAssets(read: (entry: string) => string, where: string): void {
  for (const entry of PACKAGED_WEB_BRAND_ASSETS) {
    assertBrandAssetSvg(read(entry), `${where}:${entry}`)
  }
}

/**
 * 归档里**每个** `lib/**\/*.js` 的相对 `./x.js` import 都必须在包里。
 *
 * `REQUIRED_PACKAGED_RUNTIME_ENTRIES` 是人维护的清单，**会漏**（2026-09-22：
 * `lib/network-policy.js` 与 `lib/document-lock-recovery.js` 都静态 import 自
 * `lib/main.js`，清单里都没有）。这一条不看清单、直接对拍真实产物：import 期
 * `ERR_MODULE_NOT_FOUND` 会让窗口根本起不来（比 afterPack 里任何一条断言都更致命）。
 *
 * 覆盖面（2026-09-22 第 3 轮审计后收紧）：归档里**每个** `lib/**\/*.js` 的相对 `./x.js`
 * import 都要求目标条目存在（含内容哈希命名的 chunk，rolldown 已把 specifier 写成真实
 * 文件名）。已知边界：`../` 形式与非 `.js` 扩展名（`.cjs`/`.mjs`）不在判据内 —— 真实产物
 * 里 `../build/channel.json` 这类路径**存在但不属于 lib**，收进来会变假红；`require(`
 * 形式同样不入判据（本仓产物是纯 ESM）。覆盖面只到**桌面自身的 `lib/**`**：`@picoaide/*`
 * 插件包**包内**的内容哈希 chunk 不在本判据内（这里只登记它们的具名入口）。那一层的网是
 * `scripts/verify-profile-boot.mjs`（`yarn check` 内、真组合树 boot，缺 chunk 会抛）与
 * `e2e:client`（只在 Linux CI 跑）——**不要**把 `verify:closure` 当兜底：它只走 package.json
 * 的依赖/peer 图，实测对包内 chunk 零覆盖（第 6 轮审计）。物理布局分支（`asar: false`，桌面壳不使用）不做这条：那一分支用注入的
 * `exists` 探针驱动，不遍历目录。
 * @param present - 归档内全部条目（已归一化）。
 * @param readEntry - 按归档内路径读取条目文本。
 * @param where - 位置前缀（错误消息用）。
 */
function assertRelativeImportsPresent(
  present: ReadonlySet<string>,
  readEntry: (entry: string) => string,
  where: string,
): void {
  // 至少有一条可扫：`REQUIRED_PACKAGED_RUNTIME_ENTRIES` 里就有 `lib/main.js`（调用点先判它）。
  // 这里不再单独写"空集就抛"——那条前置断言结构上不可达（第 4 轮审计：变异成静默 return 后
  // 用例仍全绿），死判据不如没有。
  const libEntries = [...present].filter(entry => entry.startsWith('lib/') && entry.endsWith('.js'))
  for (const entry of libEntries) {
    const source = readEntry(entry)
    const base = posix.dirname(entry)
    const missing = new Set<string>()
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([^"']+\.js)["']/gu)) {
      const target = posix.normalize(posix.join(base, match[1]!))
      if (!present.has(target)) missing.add(target)
    }
    if (missing.size > 0) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${where} is missing modules imported by ${entry}: ${[...missing].join(', ')}`,
      )
    }
  }
}

/** `@picoaide/*` 在归档/产物里的条目前缀（三张清单表都用这个写法）。 */
const WORKSPACE_SCOPE_PREFIX = 'node_modules/@picoaide/'

/** 反向 oracle 的定位标签（错误消息前缀）。 */
const WORKSPACE_COVERAGE_LABEL = 'dsh-plugin-desktop: first-party workspace runtime surface'

/**
 * 自有 workspace 包 `package.json` 里本判据消费的字段。
 *
 * 只读**声明**，不读文件系统上的偶然内容：`exports` 决定子路径怎么落点，
 * `dsh.bundle.patch` 决定 profile 组装期要读哪份补丁，`dsh.client` 决定客户端
 * bundle 必须存在（上游 `dsh-client-modules` 见到 `dsh.client` 而没有
 * `exports["./client"]` 会直接抛错）。
 */
interface WorkspacePackageManifest {
  readonly main?: unknown
  /** `exports` 既可能是字符串（旧形态）也可能是键 → 目标的映射。 */
  readonly exports?: unknown
  readonly dsh?: { readonly bundle?: { readonly patch?: unknown }, readonly client?: unknown }
}

/**
 * `package.json` 的 `exports` 取键视图（字符串形态与非对象形态一律回空表）。
 * @param manifest - 目标包的 `package.json`。
 * @returns 键 → 原值的只读视图（非对象时为空表）。
 */
function workspaceExportMap(manifest: WorkspacePackageManifest): Record<string, unknown> {
  const value = manifest.exports
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** 一条"必须有"的条目 + 它是**哪条规则**推出来的（诊断用）。 */
interface WorkspaceRequiredEntry {
  readonly package: string
  readonly entry: string
  readonly reason: string
}

/** 反向 oracle 的一次普查结果。 */
export interface WorkspaceSurfaceCensus {
  /** 产物里真实随包的自有 workspace 包名（升序）。 */
  readonly packages: readonly string[]
  /** 全部必须有条目（升序）。 */
  readonly required: readonly WorkspaceRequiredEntry[]
  /** `<包名>` → 该包必须有条目数（供棘轮比对）。 */
  readonly perPackage: ReadonlyMap<string, readonly string[]>
  /** 从产物里解析出的 `@picoaide/*` specifier 条数（防空转的前置量）。 */
  readonly resolvedSpecifiers: number
}

/**
 * 每个自有 workspace 包在生效清单里的覆盖下限（**只允许上调**）。
 *
 * 为什么需要它（2026-09-23 第三轮审计 P-1）：`REQUIRED_PACKAGED_RUNTIME_ENTRIES`
 * 这类清单是"必需项判据"的**唯一来源** —— 从清单里删掉一条，等于同时删掉那条断言
 * （`it.each(清单)` 是自同义反复）。16 次单条删除里 9 次让 spec 78/78 全绿。反向
 * oracle（`assertRequiredEntriesCoverWorkspaceSurface`）负责"清单必须覆盖产物"，
 * 这里再钉一层**计数棘轮**：即使某条派生规则将来退化（例如 `exports` 改写、
 * import 换成运行期拼接），少一条也会在计数上立刻暴露，而不是安静地少一道门。
 *
 * `flattened` 数 `REQUIRED_PACKAGED_RUNTIME_ENTRIES`（扁平表），`effective` 数三张表
 * 的并集，`library` 数并集里的 `lib/**` 产物条目。三个数分别拦三种形态：删扁平表条目、
 * 删"只有另一张表覆盖"的条目（如 `cordis.patch.yml` 同时被 profile 锚点表覆盖）、
 * 以及删产物入口。新增自有插件包而不登记这里 = 红。
 */
export interface WorkspacePackageCoverageFloor {
  /** 包名（`@picoaide/` 之后的部分）。 */
  readonly package: string
  /** 扁平必需清单里该包的条目数下限。 */
  readonly flattened: number
  /** 生效清单（三张表并集）里该包的条目数下限。 */
  readonly effective: number
  /** 生效清单里该包 `lib/**` 产物条目的下限。 */
  readonly library: number
}

/**
 * 生效清单 = afterPack 实际断言的三张表的并集。
 *
 * 分开维护三张表是历史（扁平登记 / specifier+落点 / profile 锚点），但"必需项"这件事
 * 在运行期只有一个含义：这三张表里任何一条缺失都会拒包。反向 oracle 因此必须按并集
 * 判覆盖 —— 只按扁平表判会把 connectors / enterprise 这七个包误判成全无覆盖。
 * @returns 去重后的条目列表（顺序 = 三张表的声明顺序）。
 */
export function effectivePackagedRuntimeEntries(): string[] {
  return [...new Set([
    ...REQUIRED_PACKAGED_RUNTIME_ENTRIES,
    ...REQUIRED_ASAR_EXPORTS.map(required => required.archivePath),
    ...REQUIRED_PROFILE_PATCH_ANCHORS,
  ])]
}

/** 桌面包根（`scripts/` 的上一级）：反向 oracle 在这里读**产物**而不是归档列表。 */
function desktopProductRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * 每包计数棘轮的**当前值**（2026-09-23 实测，只允许上调）。
 *
 * 三个数分别拦三种"悄悄删一条"：删扁平表条目（`flattened`）、删已被另一张表覆盖的
 * 条目（`effective`，例如 `cordis.patch.yml` 同时被 profile 锚点表覆盖）、删产物入口
 * （`library`）。数值就是该包在对应集合里的**当前真实条目数**；上调随新增条目一起做，
 * 下调必须在同一次改动里给出理由并改这张表（低于下限时 `assertRequiredEntriesCoverWorkspaceSurface`
 * 会拒包）。
 */
export const REQUIRED_WORKSPACE_PACKAGE_COVERAGE: readonly WorkspacePackageCoverageFloor[] = [
  { package: 'dsh-account-card', flattened: 5, effective: 5, library: 3 },
  { package: 'dsh-browser', flattened: 7, effective: 7, library: 5 },
  // connectors / enterprise 的条目**全部**在 `REQUIRED_ASAR_EXPORTS`（specifier + 落点）里，
  // 扁平清单里一条都没有 ⇒ `flattened: 0` 是有意的，不是漏登记。
  { package: 'dsh-connectors', flattened: 0, effective: 7, library: 5 },
  // cron 的 `cordis.patch.yml` 只有 profile 锚点表覆盖（扁平清单 4 条 ⇒ 生效 5 条）。
  { package: 'dsh-cron', flattened: 4, effective: 5, library: 3 },
  // enterprise 在 `REQUIRED_ASAR_EXPORTS` 里有 13 条 + 锚点表的 `cordis.patch.yml`。
  { package: 'dsh-enterprise', flattened: 0, effective: 14, library: 12 },
  { package: 'dsh-foot-menu', flattened: 4, effective: 4, library: 2 },
  { package: 'dsh-host-home', flattened: 2, effective: 2, library: 1 },
  { package: 'dsh-host-locale', flattened: 3, effective: 3, library: 2 },
  { package: 'dsh-wasm-apps', flattened: 5, effective: 5, library: 3 },
  { package: 'dsh-wasm-apps-host', flattened: 6, effective: 6, library: 4 },
]

/**
 * 生效清单的总条数下限（只允许上调）—— 兜"整段删除"这类批量形态，
 * 以及 `@picoaide/*` 之外的条目（build/、lib/preload/、上游 node_modules）。
 */
export const REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR = 111

/**
 * 反向 oracle 至少要解析出的 `@picoaide/*` specifier 条数（只允许上调）。
 *
 * 实测：完整树 27 条；CI `gate` job 的干净检出（只有 `dsh-plugin-desktop` 的
 * `needs` 闭包先生成 `lib/`）21 条 —— 取 20 是为了让这条"防空转"的前置判据在两种
 * 树状态下都成立。**它不是删条目的保证**（那个由 `assertWorkspacePackageCoverage`
 * 的每包棘轮负责，与构建无关）。
 */
const MIN_RESOLVED_WORKSPACE_SPECIFIERS = 20

/**
 * 递归列出产物目录下的普通文件（相对路径，`/` 分隔）。
 *
 * 与测试夹具的 `listFilesRel` 有两处必须的差别：
 *  1. workspace 依赖在 `node_modules` 下是**符号链接**（`nodeLinker: node-modules`），
 *     `Dirent.isDirectory()` 对链接返回 false ⇒ 必须 stat 解引用，否则整个作用域
 *     目录被当成空目录、oracle 静默空转（这正是它要防的形态）；
 *  2. 不再下降进嵌套的 `node_modules`（那是依赖的依赖，不是本包产物面）。
 * @param root - 要枚举的目录。
 * @returns 相对 `root` 的文件路径（升序无关，调用方自己排序）。
 */
function listProductFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        let stats
        try {
          stats = statSync(absolute)
        } catch (cause) {
          throw new Error(
            `${WORKSPACE_COVERAGE_LABEL}: ${absolute} 是悬空符号链接（workspace 依赖未构建/被删？）`
            + '—— 反向 oracle 不能跳过它，否则判据会静默空转',
            { cause },
          )
        }
        isDirectory = stats.isDirectory()
        isFile = stats.isFile()
      }
      if (isDirectory) {
        if (entry.name === 'node_modules' && prefix !== '') continue
        walk(absolute, relative)
        continue
      }
      if (isFile) files.push(relative)
    }
  }
  walk(root, '')
  return files
}

/**
 * 把一个 `<包>/<子路径>` specifier 解析成包内相对落点。
 *
 * 顺序与 Node 一致：`exports[key]` 的 `default`/`import`/`require` → 包根再回落 `main`。
 * 通配子路径（`./src/*` 这类）返回 `undefined` —— 它们不是打包入口，要求登记会把这条
 * 判据变成假红源。
 * @param manifest - 目标包的 `package.json`。
 * @param subpath - 子路径（包根传空串）。
 * @returns 包内相对落点（已去掉 `./` 前缀），解析不到时为 `undefined`。
 */
function workspaceEntryTarget(manifest: WorkspacePackageManifest, subpath: string): string | undefined {
  const key = subpath === '' ? '.' : `./${subpath}`
  const record = workspaceExportMap(manifest)[key]
  const value = typeof record === 'string'
    ? record
    : (record !== null && typeof record === 'object'
        ? (record as Record<string, unknown>).default
          ?? (record as Record<string, unknown>).import
          ?? (record as Record<string, unknown>).require
        : undefined)
  const target = typeof value === 'string' ? value : (subpath === '' ? manifest.main : undefined)
  if (typeof target !== 'string') return undefined
  const relative = target.replace(/^\.\//u, '')
  return relative.includes('*') ? undefined : relative
}

/**
 * **反向 oracle**：清单必须覆盖产物，而不是清单自己说了算（2026-09-23 第三轮审计 P-1）。
 *
 * 与既有三条 oracle 的分工与差别：
 *  - `spec:206`（desktop `lib/*.js` 的 `@picoaide/*` 子路径）只看**桌面自身**的产物；
 *    插件包之间的 import（`wasm-apps-host → dsh-browser/surface` 这类）它看不见。
 *  - G-9 那张只看**上游补丁目标**的子路径 import。
 *  - G-2 的目录 oracle（`build/`、`lib/preload/`、前端 dist）要求"目录里每个文件都在清单里"，
 *    但它**结构上无法**覆盖 `node_modules/@picoaide/<pkg>/lib`：那里有内容哈希命名的 chunk
 *    （`host-routes-DZDVSIog.js`、`auth-7L36hEyX.js`），名字每次构建都变。
 *  - 2026-09-16 的 vendored 技能 oracle 只枚举 `dsh-memory-evolve/skills/**` 一个**源目录**。
 *
 * 因此这里换一种判据：不问"目录里有什么"，而问"**产物真实需要什么**"，来源有两条，
 * 都与清单无关：
 *  1. **包自己声明的入口面** —— `package.json`（`exports["."]`/`main`、`dsh.bundle.patch`、
 *     `dsh.client` ⇒ `exports["./client"]`、`exports["./invariant"]`）；
 *  2. **产物里真实的 `@picoaide/*` specifier** —— 桌面 `lib/**` 与每个自有包
 *     `lib/**` 的 JS 里出现的包 specifier，按目标包 `exports` 解析成落点。
 * 两条来源推出的每一条都必须在生效清单里。
 *
 * **与每包计数棘轮（`assertWorkspacePackageCoverage`）的分工**：
 *  - 这条是**产物驱动**的 —— 抓"产物多出一个清单没覆盖的入口"（新 import / 新包）与
 *    "清单条目的路径拼写被改坏"（派生出来的那条在清单里找不到）。
 *  - 棘轮是**清单驱动、构建无关**的 —— 抓"删掉任何一条条目"，且不依赖任何包是否已构建
 *    （CI 的 `gate` job 从干净检出跑根 `yarn check`，`dsh-plugin-desktop` 的 check 排在
 *    `enterprise`/`account-card`/`cron`/`wasm-apps` **之前**，那四个包的 `lib/` 在
 *    这一步根本不存在 ⇒ 产物驱动的那条此刻只能覆盖已构建的部分）。
 *
 * **为什么读磁盘产物而不是归档列表**：afterPack 本就跑在构建工作区里，磁盘 `lib/` +
 * `node_modules/@picoaide/` 就是被打进包的那份输入；读它同时让这条判据在 `vitest`
 * 里可判（不必真打包），也避免依赖各调用点注入的读缝（那些读缝在单测里是桩）。
 * "归档里真的在"由既有三条断言负责（扁平表 / `REQUIRED_ASAR_EXPORTS` / 锚点表），
 * 两者合起来才是闭环：**清单必须覆盖产物，产物必须覆盖清单**。
 * @param manifest - 生效清单（缺省 = 三张表的并集）。
 * @param productRoot - 产物根（缺省 = 桌面包根）。测试用它指到合成夹具。
 * @param floors - 每包下限表（缺省 = `REQUIRED_WORKSPACE_PACKAGE_COVERAGE`），只用于
 *   "随包但没登记"与"登记了却不存在"这两个结构判据。
 * @param minResolvedSpecifiers - specifier 空转下限（合成夹具按自己的规模传值）。
 * @returns 普查结果（供测试断言规模，避免"空转即通过"）。
 */
export function assertRequiredEntriesCoverWorkspaceSurface(
  manifest: readonly string[] = effectivePackagedRuntimeEntries(),
  productRoot: string = desktopProductRoot(),
  floors: readonly WorkspacePackageCoverageFloor[] = REQUIRED_WORKSPACE_PACKAGE_COVERAGE,
  minResolvedSpecifiers: number = MIN_RESOLVED_WORKSPACE_SPECIFIERS,
): WorkspaceSurfaceCensus {
  const census = collectWorkspaceSurface(productRoot)
  const known = new Set(manifest)

  const missing = census.required.filter(required => !known.has(required.entry))
  if (missing.length > 0) {
    throw new Error(
      `${WORKSPACE_COVERAGE_LABEL} at ${productRoot}: 产物真实需要的条目不在打包必需清单里 `
      + `（删掉清单里的一条 = 同时删掉那条断言，所以这里从产物反推）：\n`
      + missing.map(item => `  - ${item.entry}  [${item.reason}]`).join('\n'),
    )
  }

  const byPackage = new Map(floors.map(floor => [floor.package, floor]))
  const unregistered = census.packages.filter(name => !byPackage.has(name))
  if (unregistered.length > 0) {
    throw new Error(
      `${WORKSPACE_COVERAGE_LABEL}: 这些自有插件包随包但没在 REQUIRED_WORKSPACE_PACKAGE_COVERAGE 里登记下限：`
      + `${unregistered.join(', ')}（新增自有插件必须显式登记，否则"删一条"没有棘轮兜底）`,
    )
  }
  const dead = floors.filter(floor => !census.packages.includes(floor.package))
  if (dead.length > 0) {
    throw new Error(
      `${WORKSPACE_COVERAGE_LABEL}: REQUIRED_WORKSPACE_PACKAGE_COVERAGE 里有产物中不存在的包：`
      + `${dead.map(floor => floor.package).join(', ')}（包已删除/改名 ⇒ 同步这张表）`,
    )
  }
  if (census.resolvedSpecifiers < minResolvedSpecifiers) {
    throw new Error(
      `${WORKSPACE_COVERAGE_LABEL}: 只从产物里解析出 ${census.resolvedSpecifiers} 条 @picoaide/* specifier `
      + `（下限 ${minResolvedSpecifiers}）—— 产物没构建或判据已空转，不能当成通过`,
    )
  }
  return census
}

/**
 * **每包计数棘轮**：清单里每个自有 workspace 包的条目数不得低于登记的下限。
 *
 * 这条判据**不读产物、不做任何构建**，因此它在任何树状态下都成立 —— 包括 CI 的
 * `gate` job 从干净检出跑根 `yarn check`（desktop 的 check 排在 enterprise /
 * account-card / cron / wasm-apps 之前，那四个包的 `lib/` 那时还不存在）。它的职责就
 * 一条：**删掉清单里任何一条 = 立刻红**，而"删条目同时删掉断言"正是 P-1 的形态。
 *
 * 为什么按包分段而不是只钉总数：删 A 段一条、加 B 段一条会让总数不变（审计里
 * `browser/cordis.patch.yml` 那条被 profile 锚点表重复覆盖、删掉后总数只少一，
 * 而当时的全局下限留了余量 ⇒ 静默）。三个数各管一类：`flattened` 管扁平表条目、
 * `effective` 管"已被另一张表覆盖"的条目、`library` 管 `lib/` 产物入口。
 * @param manifest - 生效清单（缺省 = 三张表的并集）。
 * @param floors - 每包下限（缺省 = `REQUIRED_WORKSPACE_PACKAGE_COVERAGE`）。
 */
export function assertWorkspacePackageCoverage(
  manifest: readonly string[] = effectivePackagedRuntimeEntries(),
  floors: readonly WorkspacePackageCoverageFloor[] = REQUIRED_WORKSPACE_PACKAGE_COVERAGE,
): void {
  const flat = new Set<string>(REQUIRED_PACKAGED_RUNTIME_ENTRIES)
  const violations: string[] = []
  for (const floor of floors) {
    const prefix = `${WORKSPACE_SCOPE_PREFIX}${floor.package}/`
    const effective = manifest.filter(entry => entry.startsWith(prefix))
    const flattened = effective.filter(entry => flat.has(entry)).length
    const library = effective.filter(entry => entry.startsWith(`${prefix}lib/`)).length
    if (flattened < floor.flattened) {
      violations.push(`${floor.package}: 扁平清单 ${flattened} < 下限 ${floor.flattened}`)
    }
    if (effective.length < floor.effective) {
      violations.push(`${floor.package}: 生效清单 ${effective.length} < 下限 ${floor.effective}`)
    }
    if (library < floor.library) {
      violations.push(`${floor.package}: lib/ 产物 ${library} < 下限 ${floor.library}`)
    }
  }
  // 全局下限同样只允许上调：它兜"整段删除"这类批量形态与 @picoaide 之外的条目。
  if (manifest.length < REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR) {
    violations.push(
      `生效清单共 ${manifest.length} 条 < 下限 ${REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR}`,
    )
  }
  if (violations.length > 0) {
    throw new Error(
      `${WORKSPACE_COVERAGE_LABEL}: 覆盖计数低于棘轮下限（下限只允许上调；确要下调必须在同一次改动里`
      + `说明理由并改 REQUIRED_WORKSPACE_PACKAGE_COVERAGE）：\n  ${violations.join('\n  ')}`,
    )
  }
}

/**
 * 从产物推导"必须有"的自有 workspace 条目（反向 oracle 的普查步骤）。
 *
 * 导出它是为了让 `tests/verify-packaged-runtime.spec.ts` 能直接对合成产物夹具断言
 * 派生结果（而不是复制一份派生逻辑 —— 复制出来的那份会替假条目背书）。
 * @param productRoot - 产物根（桌面包根）。
 * @returns 普查结果。
 */
export function collectWorkspaceSurface(productRoot: string): WorkspaceSurfaceCensus {
  const scopeRoot = join(productRoot, 'node_modules', '@picoaide')
  if (!existsSync(scopeRoot)) {
    throw new Error(
      `${WORKSPACE_COVERAGE_LABEL}: 找不到 ${scopeRoot} —— workspace 依赖未安装或未构建，判据不能空转`,
    )
  }
  const packages = readdirSync(scopeRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => entry.name)
    .filter(name => existsSync(join(scopeRoot, name, 'package.json')))
    .sort()
  if (packages.length === 0) {
    throw new Error(`${WORKSPACE_COVERAGE_LABEL}: ${scopeRoot} 下没有任何自带 package.json 的包`)
  }

  const manifests = new Map<string, WorkspacePackageManifest>()
  for (const name of packages) {
    manifests.set(name, JSON.parse(readFileSync(join(scopeRoot, name, 'package.json'), 'utf8')) as WorkspacePackageManifest)
  }

  const required = new Map<string, WorkspaceRequiredEntry>()
  const add = (name: string, relative: string | undefined, reason: string): void => {
    if (relative === undefined) return
    const entry = `${WORKSPACE_SCOPE_PREFIX}${name}/${relative}`
    if (!required.has(entry)) required.set(entry, { package: name, entry, reason })
  }
  for (const name of packages) {
    const manifest = manifests.get(name)!
    add(name, 'package.json', '包 manifest（profile 组装期 createRequire().resolve 的落点）')
    add(name, workspaceEntryTarget(manifest, ''), 'package.json 的 exports["."]/main（插件行入口）')
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch === 'string') add(name, patch.replace(/^\.\//u, ''), 'dsh.bundle.patch（profile 组装期读取）')
    if (manifest.dsh?.client !== undefined) {
      // 上游 client-modules 见到 dsh.client 而没有 exports["./client"] 会**直接抛错**
      // （`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`）。
      add(name, workspaceEntryTarget(manifest, 'client'), 'dsh.client ⇒ exports["./client"]（客户端 bundle）')
    }
    if (workspaceExportMap(manifest)['./invariant'] !== undefined) {
      add(name, workspaceEntryTarget(manifest, 'invariant'), 'exports["./invariant"]（包自有不变量伴生入口）')
    }
  }

  const artifacts = [
    ...listProductFiles(join(productRoot, 'lib')).map(relative => `lib/${relative}`),
    ...listProductFiles(scopeRoot).map(relative => `${WORKSPACE_SCOPE_PREFIX}${relative}`),
  ].filter(entry => /\.(?:js|cjs|mjs)$/u.test(entry))

  const resolved = new Set<string>()
  for (const artifact of artifacts) {
    const absolute = join(productRoot, artifact)
    const source = readFileSync(absolute, 'utf8')
    // 刻意用"任何以 @picoaide/ 开头的字符串字面量"而不是精确的 import/require 语法：
    // `createRequire(...).resolve('@picoaide/x/package.json')` 这类**也是运行期依赖**
    // （profile 锚点就是这么解析的），而漏掉它等于放掉一整类。代价是文档字符串里提到
    // 的包名也会被要求登记 —— 这是**偏严**的方向，且解析不到落点/通配子路径会被跳过。
    for (const match of source.matchAll(/["'](@picoaide\/[^"']+)["']/gu)) {
      const specifier = match[1]!
      const [, name, subpath = ''] = /^@picoaide\/([^/]+)(?:\/(.*))?$/u.exec(specifier) ?? []
      if (name === undefined) continue
      const manifest = manifests.get(name)
      if (manifest === undefined) continue
      const target = workspaceEntryTarget(manifest, subpath)
      if (target === undefined) continue
      resolved.add(specifier)
      add(name, target, `产物里的真实 specifier ${specifier}（来自 ${artifact}）`)
    }
  }

  const entries = [...required.values()].sort((left, right) => left.entry.localeCompare(right.entry))
  const perPackage = new Map<string, readonly string[]>()
  for (const name of packages) {
    perPackage.set(name, entries.filter(item => item.package === name).map(item => item.entry))
  }
  return { packages, required: entries, perPackage, resolvedSpecifiers: resolved.size }
}

/**
 * 打包布局的**显式开关**（2026-09-23 第三轮审计 P-6）。
 *
 * 历史形态：`tryListArchive` 把**任何**异常都当成"没有 `app.asar` ⇒ 物理布局"，
 * 于是"`app.asar` 存在但损坏/截断"会掉进 `resources/app/` 那条分支，报出
 * "`resources/app` 缺文件"——而 asar 布局下这个目录**根本不该存在**，错误信息指向
 * 一个不存在的路径（历史同类坑：asar entry offset 错乱 ⇒ Electron 报随机某个 json
 * 的 `Invalid package config`）。真实原因被 `catch {}` 吞掉，排障要重走一遍弯路。
 *
 * 现在：归档缺失（ENOENT）只说明"这次构建**可能**用了 `asar: false`"，**不再**自动
 * 改走物理分支 —— 必须由本开关显式声明。默认（未设）= 归档必须存在且可列举。
 * 取值：`physical`（大小写/首尾空白不敏感）；**其它取值一律 fail-loud**（拼错的开关
 * 不能静默退回默认，那会让"我明明开了物理布局"变成一句空话）。
 */
export const PACKAGED_RUNTIME_LAYOUT_ENV = 'PACKAGED_RUNTIME_LAYOUT'

/**
 * 是否显式声明了物理布局（`PACKAGED_RUNTIME_LAYOUT=physical`）。
 * @param env - 环境变量来源（测试注入；生产是 `process.env`）。
 * @returns true = 这次验证对象是 `asar: false` 的物理树。
 * @throws 开关取值非法（不是 `physical` 也不是空）时 fail-loud。
 */
export function packagedRuntimeLayoutIsPhysical(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PACKAGED_RUNTIME_LAYOUT_ENV]
  if (raw === undefined || raw.trim() === '') return false
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'physical') return true
  throw new Error(
    `dsh-plugin-desktop: ${PACKAGED_RUNTIME_LAYOUT_ENV}=${JSON.stringify(raw)} is not a known layout — `
    + `only 'physical' (an asar:false resources/app tree) is accepted; leave it unset to require app.asar`,
  )
}

/** 归档**不存在**（ENOENT）与"归档存在但读不了"必须分开判：前者是布局信号，后者是坏产物。 */
function isMissingArchiveError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
}

/**
 * Try to list one archive.
 * @param archivePath - absolute `app.asar` path.
 * @param list - ASAR listing implementation.
 * @param readEntry - archive-entry reader used by the content assertions.
 * @returns 归档条目集；`undefined` = 归档**不存在**（唯一可读作"不是 asar 布局"的信号）。
 * @throws 归档存在但无法列举（截断/损坏/读不了）—— 必须点名真实原因，绝不静默改走物理分支。
 */
function tryListArchive(
  archivePath: string,
  list: ArchiveLister,
  readEntry: PackageEntryReader,
): ReadonlySet<string> | undefined {
  let entries: readonly string[]
  try {
    entries = list(archivePath, { isPack: false })
  } catch (cause) {
    if (isMissingArchiveError(cause)) return undefined
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${archivePath} is present but cannot be listed `
      + `(the archive is unreadable — likely corrupt or truncated): ${detail}`,
      { cause },
    )
  }
  const present = new Set(entries.map(normalizeArchiveEntry))
  const missing = REQUIRED_PACKAGED_RUNTIME_ENTRIES.filter(entry => !present.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${archivePath} is missing required ASAR entries: ${missing.join(', ')}`,
    )
  }
  // 反向 oracle（2026-09-23 第三轮审计 P-1）：**清单必须覆盖产物**。
  // 上面那条只证明"清单里的条目都在包里" —— 而清单是这条判据的唯一来源，删掉一条
  // 等于同时删掉那条断言（审计实测 16 次单条删除里 9 次全绿）。这两条一起兜：
  //   * 每包覆盖棘轮：构建无关，删掉任何一条即红（含"删条目 + 加假条目"抵消总数）；
  //   * 产物反向覆盖：产物里真实需要的入口（声明面 + `@picoaide/*` specifier）
  //     必须都在清单里 —— 抓"产物多出一个没被覆盖的入口"与"清单路径拼写被改坏"。
  assertWorkspacePackageCoverage()
  assertRequiredEntriesCoverWorkspaceSurface()
  // 反向断言（2026-09-22）：包里不得出现自有源码 / sourcemap / 开发期产物。
  // 放在这里而不是 `files` 里 —— `files` 是声明，这里是**证据**：任何一条排除规则
  // 写错（例如「仅根级」那种单星号写法）都会在这一步把坏包拦下来，而不是发到客户机上。
  assertNoPackagedSourceLeaks(present, archivePath)
  assertRuntimeAssetFamiliesSurvive(present, archivePath)
  // 归档里每个 lib/**/*.js 的相对 import 都在包里（清单会漏，产物不会说谎）。
  assertRelativeImportsPresent(present, entry => readEntry(archivePath, entry), archivePath)
  // 自有插件包的 profile 锚点（package.json + cordis.patch.yml）：缺任何一个，
  // `prepareDesktopProfile()` 里的 createRequire().resolve 就会抛错、应用起不来。
  assertProfilePatchAnchors(entry => present.has(entry), archivePath)
  return present
}

/**
 * Verify package exports resolve through the physical tree instead of the build workspace.
 * @param unpackedRoot - absolute path to app.asar.unpacked.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects missing exports and paths outside app.asar.unpacked.
 */
/** One required export specifier plus the archive path that answers it. */
export interface RequiredExport {
  readonly specifier: string
  readonly archivePath: string
}

/**
 * 自有（@picoaide/*）与桌面自身导出面的**生产门禁表**（specifier + 它在包内的落点）。
 *
 * 导出它（2026-09-19）是为了让 tests/verify-packaged-runtime.spec.ts 能**直接读真源**：
 * 复验实测，测试里那份本地拷贝（`REQUIRED_ASAR_EXPORT_PATHS`）此前既没有一致性守卫、
 * 又比这张表多一条早已不存在的 `dsh-connectors/lib/sales-easy.js` —— 往本地拷贝里补假条目
 * 就能让"每个 @picoaide 依赖都被断言"的覆盖性用例假绿。现在测试同时断言两张表逐字相等。
 */
export const REQUIRED_ASAR_EXPORTS: readonly RequiredExport[] = [
  // The desktop package is the application root (asar /lib, /package.json),
  // not a node_modules entry; its exports resolve from the archive root.
  { specifier: 'dsh-plugin-desktop', archivePath: 'lib/index.js' },
  { specifier: 'dsh-plugin-desktop/profile', archivePath: 'lib/profile.js' },
  { specifier: 'dsh-plugin-desktop/client', archivePath: 'lib/client.js' },
  { specifier: 'dsh-plugin-desktop/diagnostics', archivePath: 'lib/diagnostics.js' },
  { specifier: 'dsh-plugin-desktop/updates', archivePath: 'lib/updates.js' },
  { specifier: 'dsh-plugin-desktop/windows-agent-presets', archivePath: 'lib/windows-agent-presets.js' },
  { specifier: 'dsh-plugin-desktop/windows-pwsh-sandbox', archivePath: 'lib/windows-pwsh-sandbox.js' },
  // P0-6/D8(2026-09-16):渲染进程错误契约。preload 与宿主都用它做载荷校验/IPC 通道名;
  // 它掉出 asar ⇒ 渲染进程采集静默失效(窗口照常工作、错误一条都进不了 GlitchTip)。
  { specifier: 'dsh-plugin-desktop/renderer-error-contract', archivePath: 'lib/renderer-error-contract.js' },
  { specifier: '@deepseek-ai/dsh-base/package.json', archivePath: 'node_modules/@deepseek-ai/dsh-base/package.json' },
  { specifier: '@deepseek-ai/dsh-web-app/package.json', archivePath: 'node_modules/@deepseek-ai/dsh-web-app/package.json' },
  { specifier: '@picoaide/dsh-enterprise/session-service', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/session-service.js' },
  { specifier: '@picoaide/dsh-enterprise/auth-gate', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/auth-gate.js' },
  { specifier: '@picoaide/dsh-enterprise/gateway-model', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/gateway-model.js' },
  { specifier: '@picoaide/dsh-enterprise/bootstrap', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/bootstrap.js' },
  { specifier: '@picoaide/dsh-enterprise/client', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/client.js' },
  // P1-1(2026-09-16):error-reporting 静态 import `@sentry/node`(enterprise 的 tsdown 把它
  // 标为 external,运行时才解析)。这个模块一旦掉出 app.asar,Cordis 加载整个插件模块时
  // 失败且**零日志**(GlitchTip 采集静默整体失效)。存在性由这里钉住,真实加载由下面的
  // `smokePackagedErrorReporting` 在打包版 Electron 里证明 —— 两层缺一不可。
  { specifier: '@picoaide/dsh-enterprise/error-reporting', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/error-reporting.js' },
  // 同批补漏的三个兄弟导出:它们都已在 `exports` 里发布、lib/ 也有产物,只是此前没进清单
  // (清单是"允许失败"的唯一真源,少一条就少一道门)。
  { specifier: '@picoaide/dsh-enterprise/skill-telemetry', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/skill-telemetry.js' },
  { specifier: '@picoaide/dsh-enterprise/channel-sync', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/channel-sync.js' },
  { specifier: '@picoaide/dsh-enterprise/invariant', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/invariant.js' },
  // 2026-09-23（第三轮审计的反向 oracle）：下面 7 条都是**产物里真实存在、且被真实
  // specifier 引用**的入口，但此前不在任何一张表里 —— 也就是"删掉它们没有任何判据会红"。
  //   `@picoaide/dsh-enterprise`                 ← profile 行 `picoaide-enterprise` 的入口
  //   `@picoaide/dsh-enterprise/loopback`        ← account-card `lib/index.js` 值导入
  //   `@picoaide/dsh-enterprise/server-connector/auth` ← account-card `lib/index.js` 值导入
  //   `@picoaide/dsh-connectors`                 ← profile 行 `pico-connectors` 的入口
  //   `@picoaide/dsh-connectors/invariant`       ← 该包声明的 `./invariant` 伴生入口
  //   `@picoaide/dsh-connectors/store`           ← browser `lib/index.js` 值导入
  //   `@picoaide/dsh-connectors/user-scope`      ← browser `lib/index.js` 值导入
  // 判据是 `assertRequiredEntriesCoverWorkspaceSurface`（清单必须覆盖产物）。
  { specifier: '@picoaide/dsh-enterprise', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/index.js' },
  { specifier: '@picoaide/dsh-enterprise/loopback', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/loopback.js' },
  { specifier: '@picoaide/dsh-enterprise/server-connector/auth', archivePath: 'node_modules/@picoaide/dsh-enterprise/lib/server-connector/auth.js' },
  { specifier: '@picoaide/dsh-enterprise/package.json', archivePath: 'node_modules/@picoaide/dsh-enterprise/package.json' },
  { specifier: '@picoaide/dsh-connectors', archivePath: 'node_modules/@picoaide/dsh-connectors/lib/index.js' },
  { specifier: '@picoaide/dsh-connectors/invariant', archivePath: 'node_modules/@picoaide/dsh-connectors/lib/invariant.js' },
  { specifier: '@picoaide/dsh-connectors/store', archivePath: 'node_modules/@picoaide/dsh-connectors/lib/store.js' },
  { specifier: '@picoaide/dsh-connectors/user-scope', archivePath: 'node_modules/@picoaide/dsh-connectors/lib/user-scope.js' },
  { specifier: '@picoaide/dsh-connectors/client', archivePath: 'node_modules/@picoaide/dsh-connectors/lib/client.js' },
  { specifier: '@picoaide/dsh-connectors/package.json', archivePath: 'node_modules/@picoaide/dsh-connectors/package.json' },
]

/**
 * `src/profile.ts` 在**组装期**用 `createRequire(...).resolve('<包>/package.json')`
 * 定位每个自有插件包的 `cordis.patch.yml`（`patchPaths` 那一组常量）。这些解析
 * 发生在**包内**（asar 走 Electron 的 fs 补丁），因此这两类文件必须随包：
 *
 *  - `<包>/package.json`：`require.resolve` 的落点；
 *  - `<包>/cordis.patch.yml`：`dirname(...)` + 拼接后的实际读取路径。
 *
 * **为什么必须逐条钉住**：解析失败是 `createRequire().resolve()` 抛错 ⇒
 * `prepareDesktopProfile()` 直接失败 ⇒ **应用根本起不来**；而当时 `REQUIRED_ASAR_EXPORTS`
 * 只覆盖了 enterprise 与 connectors 的一部分（`dsh-cron`、`dsh-account-card`、
 * `dsh-foot-menu`、`dsh-wasm-apps`、`dsh-browser`、`dsh-wasm-apps-host`、
 * `dsh-memory-evolve` 一个都没覆盖）。2026-09-22 引入打包输入暂存层后这条尤其重要：
 * 暂存白名单一旦漏掉某个包，afterPack 必须当场拒包，而不是让客户端开不起来。
 *
 * 桌面自身的补丁不在表里：它由 `DESKTOP_PATCH_PATH` 指向 `lib/../cordis.patch.yml`
 * （已由 `REQUIRED_PACKAGED_RUNTIME_ENTRIES` 的 `cordis.patch.yml` 钉住）。
 */
export const REQUIRED_PROFILE_PATCH_ANCHORS: readonly string[] = [
  'node_modules/@picoaide/dsh-enterprise/package.json',
  'node_modules/@picoaide/dsh-enterprise/cordis.patch.yml',
  'node_modules/@picoaide/dsh-account-card/package.json',
  'node_modules/@picoaide/dsh-account-card/cordis.patch.yml',
  'node_modules/@picoaide/dsh-wasm-apps/package.json',
  'node_modules/@picoaide/dsh-wasm-apps/cordis.patch.yml',
  'node_modules/@picoaide/dsh-foot-menu/package.json',
  'node_modules/@picoaide/dsh-foot-menu/cordis.patch.yml',
  'node_modules/@picoaide/dsh-connectors/package.json',
  'node_modules/@picoaide/dsh-connectors/cordis.patch.yml',
  'node_modules/@picoaide/dsh-browser/package.json',
  'node_modules/@picoaide/dsh-browser/cordis.patch.yml',
  'node_modules/@picoaide/dsh-wasm-apps-host/package.json',
  'node_modules/@picoaide/dsh-wasm-apps-host/cordis.patch.yml',
  'node_modules/@picoaide/dsh-cron/package.json',
  'node_modules/@picoaide/dsh-cron/cordis.patch.yml',
  'node_modules/dsh-memory-evolve/package.json',
  'node_modules/dsh-memory-evolve/cordis.patch.yml',
]

/**
 * 逐条断言 profile 锚点在包内（asar 与物理两种布局共用同一张表）。
 *
 * 抽成函数是为了让两套布局用**同一份判据**：任一侧单独维护必然漂移，而漂移的
 * 那一侧就是"坏包放行"的那一侧（本项目已登记过的假绿形态）。
 * @param present - 包内是否存在该相对路径。
 * @param where - 归档/目录路径，用于报错定位。
 */
export function assertProfilePatchAnchors(
  present: (entry: string) => boolean,
  where: string,
): void {
  const missing = REQUIRED_PROFILE_PATCH_ANCHORS.filter(entry => !present(entry))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${where} is missing profile patch anchors: `
      + `${missing.join(', ')} (the desktop profile resolves these at boot; a missing one makes `
      + 'the application fail to start)',
    )
  }
}

/**
 * Verify package exports resolve inside app.asar (Electron's fs patch reads
 * them from the virtual archive; nothing needs to stay physical).
 * @param archivePath - resolved app.asar path.
 * @returns Nothing; failure rejects missing exports inside the archive.
 */
function verifyUnpackedPackageResolution(
  archivePath: string,
  asarEntries?: ReadonlySet<string>,
): void {
  const entries = asarEntries ?? new Set(listPackage(archivePath, { isPack: false }).map(normalizeArchiveEntry))
  for (const required of REQUIRED_ASAR_EXPORTS) {
    if (!entries.has(required.archivePath)) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${archivePath} is missing required package export ${required.specifier} (${required.archivePath})`,
      )
    }
  }
}

/**
 * Verify Electron Builder's completed application before signing begins.
 *
 * Two layouts are accepted: the packaged archive (`asar` true —
 * `resources/app.asar` with `app.asar.unpacked` holding native binaries) and
 * the physical tree (`asar: false` — `resources/app/`). **Every current
 * packaging path produces `app.asar`**, so the archive checks are the ones
 * that run in practice; the physical branch is an explicit opt-in
 * (`PACKAGED_RUNTIME_LAYOUT=physical`, 2026-09-23 P-6) rather than an
 * exception-driven fallback: an archive that exists but cannot be listed is a
 * broken artifact and must be reported as such, not mistaken for a physical
 * tree.
 * @param context - Electron Builder's afterPack context.
 * @param list - ASAR listing implementation.
 * @param exists - physical-file probe for the unpacked CLI dependency tree.
 * @param readEntry - archive-entry reader used for content assertions (brand asset).
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedRuntime(
  context: PackagedRuntimeContext,
  list: ArchiveLister = listPackage,
  exists: FileProbe = existsSync,
  readEntry: PackageEntryReader = readPackagedEntry,
): void {
  const asarPath = resolvePackagedAsarPath(context)
  if (packagedRuntimeLayoutIsPhysical()) {
    // Explicit opt-in (`asar: false` build): the runtime is a real file tree.
    verifyPhysicalRuntime(resolvePackagedAppRoot(context), exists, readEntry)
    return
  }
  const asarEntries = tryListArchive(asarPath, list, readEntry)
  if (asarEntries === undefined) {
    // 归档不存在是**唯一**能读作"不是 asar 布局"的信号，而且它也不再自动改走物理
    // 分支（2026-09-23 P-6）：要么补出 app.asar，要么显式声明物理布局。这条错误必须
    // 给出开关名，否则"缺归档"会被误诊成"物理树缺文件"。
    throw new Error(
      `dsh-plugin-desktop: packaged runtime has no app.asar at ${asarPath} — every packaging path produces one; `
      + `set ${PACKAGED_RUNTIME_LAYOUT_ENV}=physical only for an asar:false (resources/app) build`,
    )
  }
  const unpackedRoot = resolvePackagedUnpackedRoot(context)
  const requiredPhysicalEntries = context.electronPlatformName === 'win32'
    ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES]
    : context.electronPlatformName === 'darwin' && context.arch === 4
      ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...MACOS_ARM64_NATIVE_ENTRIES.map(entry => resolveNativeEntry(unpackedRoot, entry))]
      : REQUIRED_UNPACKED_RUNTIME_ENTRIES
  // Electron (asar-archives): only native binaries need to stay physical
  // (process.dlopen / child_process.execFile). Pure JS must live inside app.asar.
  const physicalEntries = requiredPhysicalEntries.filter(entry => exists(join(unpackedRoot, entry)))
  if (physicalEntries.length === 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} has no native unpacked entries`,
    )
  }
  // P2-52: 逐条断言——旧实现只判断「至少一项存在」,清单里写错或漏打的路径会被
  // 静默过滤掉(afterPack 门禁形同空转)。某原生包目录存在时,该包清单内每条必需
  // 文件都必须存在。
  //
  // G-1（2026-09-23 审计）:上面这条的「**整包目录不存在 ⇒ 跳过**」是假绿口子 ——
  // 整包删掉 `@img/sharp-linux-x64` / `@koromix/koffi-linux-x64` / `node-pty` /
  // `@vscode/ripgrep-linux-x64` / `node-addon-require-builtin-linux-x64-gnu` 后
  // afterPack 全部 PASS。缺席的合法性现在由**显式的家族适用性判据**决定
  // （NATIVE_PLATFORM_FAMILIES），不再由"目录碰巧不在"隐式推断。放在这条之前跑，
  // 好让"整包缺失"给出点名家族的诊断。
  assertNativePlatformFamilies(
    context.electronPlatformName,
    context.arch,
    unpackedRoot,
    exists,
  )
  const missingNativeEntries = requiredPhysicalEntries.filter((entry) => {
    if (!exists(join(unpackedRoot, unpackedPackageDir(entry)))) return false
    return !exists(join(unpackedRoot, entry))
  })
  if (missingNativeEntries.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} is missing required native unpacked entries: ${missingNativeEntries.join(', ')}`,
    )
  }
  // 2026-09-11: 上面那条按「包名 + 精确路径」判定,而整包不存在时会跳过 —— 0.1.5 把
  // `@deepseek-ai/node-addon-landlock-run*` 改名为 `.../node-addon-system*` 时,条目
  // 被当成"平台不适用"放过,门禁在沙箱启动器缺失的情况下依然全绿(运行期 ENOTDIR)。
  // 这里对**真实产物**再按家族前缀断言一次(真实 afterPack 的 unpackedRoot 一定存在于
  // 磁盘;单测用的是注入探针 + 不存在的伪路径,因此不受影响):目标平台的 node-addon-system
  // 平台包必须在,且 POSIX 侧必须带 landlock-run 启动器(它没有扩展名,只有显式
  // asarUnpack 规则能把它解包出来)。
  const addonRequirement = nativeAddonRequirement(context.electronPlatformName)
  if (addonRequirement !== 'none' && existsSync(unpackedRoot)) {
    const addonScope = join(unpackedRoot, 'node_modules', '@deepseek-ai')
    const family = existsSync(addonScope)
      ? readdirSync(addonScope).filter(name => name.startsWith('node-addon-system-'))
      : []
    if (family.length === 0) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} ships no @deepseek-ai/node-addon-system-* platform package `
        + '(the POSIX sandbox launcher and the flock module the session writer leases through)',
      )
    }
    // P2-16: 家族断言必须**按架构**匹配。上游 supportedArchitectures 会在安装树里
    // 同时放 x64 与 arm64 平台包(实测 x64 产物的 app.asar.unpacked 里
    // node-addon-system-linux-arm64 也在),所以"任意一个平台包里有 landlock-run"
    // 会被**另一个架构**的包满足;而 flock 是 dlopen 的,架构不匹配 = 会话写不了。
    // 注意 family 里是目录名(无 scope),期望值用完整包名,比较前剥掉 scope。
    const expectedPlatforms = nativeAddonPlatformPackages(context.electronPlatformName, context.arch)
    const expectedDirs = expectedPlatforms.map(name => name.replace(/^@[^/]+\//u, ''))
    const matched = expectedDirs.length === 0
      ? family
      : expectedDirs.filter(name => family.includes(name))
    if (expectedDirs.length > 0 && matched.length === 0) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} ships ${family.join(', ')} `
        + `but the ${context.electronPlatformName} target built for arch ${String(context.arch)} requires `
        + `${expectedDirs.join(' or ')} (the flock module the session writer leases through is dlopen'd, `
        + 'so the CPU must match)',
      )
    }
    if (matched.length !== expectedDirs.length) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} is missing `
        + `${expectedDirs.filter(name => !matched.includes(name)).join(', ')} `
        + '(a universal bundle carries both architecture slices)',
      )
    }
    // 每个匹配到的平台包都必须带齐自己的原生文件:flock 的 system.node(linux 双 libc
    // 变体 / darwin 单文件)与 linux 的 landlock-run 启动器。缺一个都可能在启动期或
    // 第一次写会话时才炸,而 afterPack 是最后一道能拦住它的门。
    const requiredPlatformFiles = NATIVE_ADDON_PLATFORM_FILES[context.electronPlatformName] ?? []
    const missingPlatformFiles = matched.flatMap(name => requiredPlatformFiles
      .filter(file => !existsSync(join(addonScope, name, file)))
      .map(file => `${name}/${file}`))
    if (missingPlatformFiles.length > 0) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} is missing required native files in the `
        + `@deepseek-ai/node-addon-system family: ${missingPlatformFiles.join(', ')} `
        + '(the flock module is what makes sessions writable; verify build.asarUnpack ships the platform package)',
      )
    }
    if (addonRequirement === 'family-and-launcher'
      && !matched.some(name => existsSync(join(addonScope, name, 'bin', 'landlock-run')))) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} has no physical landlock-run launcher `
        + `(checked ${family.join(', ')}); verify the build.asarUnpack glob names the current package family`,
      )
    }
  }
  const unpackedJs = listUnpackedUnsafeJs(unpackedRoot)
  if (unpackedJs.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} leaked JS into app.asar.unpacked: ${unpackedJs.join(', ')}`,
    )
  }
  if (context.electronPlatformName === 'darwin' && context.arch === 4) {
    const forbidden = FORBIDDEN_MACOS_NATIVE_ENTRIES
      .filter(entry => exists(join(unpackedRoot, entry)))
    if (forbidden.length > 0) {
      throw new Error(
        `dsh-plugin-desktop: universal macOS runtime at ${unpackedRoot} contains host-architecture build output: ${forbidden.join(', ')}`,
      )
    }
  }
  verifyUnpackedPackageResolution(asarPath, asarEntries)
  // 品牌静态素材:存在性由 REQUIRED_PACKAGED_RUNTIME_ENTRIES 保证,这里把内容读出来
  // 断言"是我方几何、不是上游鱼"(P0-2)。
  verifyWebBrandAssets(entry => readEntry(asarPath, entry), asarPath)
}

/**
 * Resolve the npm package directory an unpacked entry belongs to
 * (`node_modules/pkg/...` or `node_modules/@scope/pkg/...`). Used to decide
 * whether a missing native entry means "this package is not shipped on this
 * platform" (skip) or "the package is shipped but a required file is gone"
 * (fail loud).
 * @param entry - unpacked-relative entry path using forward slashes.
 * @returns The package directory path, or the entry itself when it is not
 *   under `node_modules` (so the entry is then always required).
 */
function unpackedPackageDir(entry: string): string {
  const parts = entry.split('/')
  if (parts[0] !== 'node_modules') return entry
  return parts[1]?.startsWith('@') === true
    ? `${parts[0]}/${parts[1]}/${parts[2] ?? ''}`
    : `${parts[0]}/${parts[1] ?? ''}`
}

/**
 * Verify a physical (non-archive) packaged runtime: every required entry and
 * package export must be a real file under the application root, and nothing
 * may resolve back into the build workspace (the `files` list is the only
 * allowlist; a missing entry here means the artifact was repacked outside
 * the sealed list).
 * @param appRoot - absolute path to the physical application root.
 * @param exists - physical-file probe.
 * @param readEntry - package-entry reader (brand asset content assertion).
 * @returns Nothing; failure rejects the package before signing.
 */
function verifyPhysicalRuntime(
  appRoot: string,
  exists: FileProbe,
  readEntry: PackageEntryReader,
): void {
  const missing = REQUIRED_PACKAGED_RUNTIME_ENTRIES.filter(entry => !exists(join(appRoot, entry)))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${appRoot} is missing required entries: ${missing.join(', ')}`,
    )
  }
  const missingExports = REQUIRED_ASAR_EXPORTS.filter(required => !exists(join(appRoot, required.archivePath)))
  if (missingExports.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${appRoot} is missing required package exports: ${missingExports.map(entry => entry.archivePath).join(', ')}`,
    )
  }
  // 注意：**物理布局不做** `assertNoPackagedSourceLeaks`。那条判据需要遍历真实目录，
  // 而这一分支的既有测试是用注入的 `exists` 探针 + 假路径（`/build/resources/app`）
  // 驱动的 —— 真去 readdir 会读不存在的目录、把「正例」用例染红。物理布局是桌面壳
  // 不使用的兜底形态（`asar: false` 才走到），真实泄漏面（asar）在 `tryListArchive`
  // 里逐条判。profile 锚点则两种布局都判（它们只需要 `exists`）。
  assertProfilePatchAnchors(entry => exists(join(appRoot, entry)), appRoot)
  verifyWebBrandAssets(entry => readEntry(appRoot, entry), appRoot)
}

/** Package names smartUnpack legitimately keeps physical (native binaries). */
const NATIVE_UNPACKED_PACKAGE_PREFIXES = [
  'node_modules/node-pty',
  'node_modules/@img',
  'node_modules/@koromix',
  'node_modules/@vscode',
  'node_modules/node-addon-require-builtin',
  'node_modules/@deepseek-ai/node-addon-system',
  'node_modules/koffi',
]

/**
 * Find .js/.map/.json files inside app.asar.unpacked that do NOT belong to a
 * native-module package (smartUnpack keeps those directories whole because
 * their package internals reference the binaries; that is the Electron
 * standard). Any other JS leaking to the physical tree is a regression.
 */
function listUnpackedUnsafeJs(unpackedRoot: string): string[] {
  const found: string[] = []
  const walk = (dir: string, relativeDir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const rel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (NATIVE_UNPACKED_PACKAGE_PREFIXES.some(prefix => rel === prefix
          || rel.startsWith(`${prefix}/`))) {
          continue
        }
        walk(path, rel)
      } else if (/\.([cm]?js|map)$/u.test(entry.name)
        || (/\.json$/u.test(entry.name) && entry.name !== 'package.json')) {
        found.push(rel)
      }
    }
  }
  walk(unpackedRoot, '')
  return found
}

/** Timeout for the packaged flock smoke (a hung Electron must not hang afterPack). */
export const PACKAGED_FLOCK_SMOKE_TIMEOUT_MS = 10_000

/**
 * 打包版运行时**实际**报出的 Electron 版本行（2026-09-23 第三轮审计 P-5）。
 *
 * 为什么需要它：清单里 6 处（4 个包 × dev/peer）pin 的是 `electron` 的**声明**，
 * 而构建出来的产物用哪个 Electron 只由安装树决定 —— 升级/降级 Electron 时
 * `afterPack` 对版本本身无感，两个已记录的不变量（Electron 43.4.0 的 `app.asar`
 * `{ bigint: true }` 语义会让 `skill-filesystem` 整类 provider 静默失效；45 起
 * `safeStorage` 同步 API 会炸）因此都没有前置判据。
 *
 * 做法：两个**已在打包版二进制里跑**的冒烟（flock / error-reporting）各打一行
 * `ELECTRON-VERSION:<process.versions.electron>`，宿主断言它等于本包
 * `devDependencies.electron`（不等则报错并打印两侧取值）。
 */
export const PACKAGED_ELECTRON_VERSION_MARKER = 'ELECTRON-VERSION:'

/**
 * 本包 pin 的 Electron 版本（`packages/host/desktop/package.json` 的
 * `devDependencies.electron`）—— 打包产物用的就是这一份。
 * @returns 精确版本字符串（如 `44.4.3`）。
 * @throws 声明值不是精确版本（range/别名会让"逐字比较"这条判据失效，必须 fail-loud）。
 */
export function declaredElectronVersion(): string {
  const manifestPath = join(desktopProductRoot(), 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly devDependencies?: Readonly<Record<string, unknown>>
  }
  const declared = manifest.devDependencies?.electron
  if (typeof declared !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(declared)) {
    throw new Error(
      `dsh-plugin-desktop: ${manifestPath} 的 devDependencies.electron 必须是**精确版本**`
      + `（收到 ${JSON.stringify(declared)}）—— 打包版 Electron 版本断言需要一个可逐字比较的声明值，`
      + 'range/别名/tag 会让它静默失效',
    )
  }
  return declared
}

/**
 * 断言某次打包后冒烟**真的跑在**本包声明的 Electron 上。
 * @param stdout - 冒烟子进程的 stdout。
 * @param smoke - 冒烟名（错误信息里点名是谁）。
 * @returns 冒烟报出的 Electron 版本。
 * @throws 缺版本行，或版本与 `devDependencies.electron` 不等（错误信息打印两侧取值）。
 */
export function assertPackagedElectronVersion(stdout: string, smoke: string): string {
  const expected = declaredElectronVersion()
  const reported = new RegExp(`${PACKAGED_ELECTRON_VERSION_MARKER}(\\S+)`, 'u').exec(stdout)?.[1]
  if (reported === undefined) {
    throw new Error(
      `dsh-plugin-desktop: ${smoke} did not report ${PACKAGED_ELECTRON_VERSION_MARKER}<version> `
      + `(expected ${expected}) — the embedded smoke script must print the Electron it actually ran on`,
    )
  }
  if (reported !== expected) {
    throw new Error(
      `dsh-plugin-desktop: ${smoke} ran on Electron ${reported} while package.json pins `
      + `devDependencies.electron ${expected} — the shipped runtime is not the version this build declares `
      + '(check the installed electron dist / a stale node_modules; the asar bigint semantics and the '
      + 'safeStorage API shape are version-dependent)',
    )
  }
  return reported
}

/** Success marker the embedded flock script prints; a silent exit 0 is a failure. */
const FLOCK_SMOKE_OK = 'FLOCK-SMOKE-OK'

/**
 * Embedded flock smoke script.
 *
 * Runs inside the **packaged** launcher with `ELECTRON_RUN_AS_NODE=1`: only
 * Electron's fs patch can read `app.asar`, so plain Node cannot load the module
 * out of the sealed archive (the audit that found P1-5 verified the same path by
 * hand). It resolves the flock entry the way the runtime does — through the
 * package's `exports` map — takes a real exclusive lock on a temp file, and then
 * proves the lock is real by failing to take it again from a second descriptor
 * (POSIX flock is per open-file-description, so contention must raise
 * EAGAIN/EWOULDBLOCK). It never touches `bin/landlock-run`.
 *
 * It also prints the Electron it is actually running on (`ELECTRON-VERSION:<v>`,
 * 2026-09-23 P-5): the host asserts that equals `devDependencies.electron`, so a
 * runtime built against an unexpected Electron fails the gate instead of being
 * discovered later by a version-specific behaviour (asar bigint semantics,
 * safeStorage API shape).
 */
const FLOCK_SMOKE_SCRIPT = `import { createRequire } from 'node:module'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const appRoot = process.argv[2]
process.stdout.write('${PACKAGED_ELECTRON_VERSION_MARKER}' + String(process.versions.electron) + '\\n')
const appRequire = createRequire(join(appRoot, 'package.json'))
const flockUrl = pathToFileURL(appRequire.resolve('@deepseek-ai/node-addon-system/flock')).href
const { tryLockExclusive } = await import(flockUrl)
const dir = mkdtempSync(join(tmpdir(), 'dsh-flock-smoke-'))
const lockFile = join(dir, 'session.lock')
writeFileSync(lockFile, '')
const fd = openSync(lockFile, 'r+')
const contender = openSync(lockFile, 'r+')
try {
  await tryLockExclusive(fd)
  let contended = false
  try {
    await tryLockExclusive(contender)
  } catch (error) {
    contended = error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK'
  }
  if (!contended) {
    throw new Error('a second descriptor acquired the same lock; the flock binding did not actually lock')
  }
  process.stdout.write('${FLOCK_SMOKE_OK}\\n')
} finally {
  closeSync(contender)
  closeSync(fd)
  rmSync(dir, { recursive: true, force: true })
}
`

/** Result shape of one flock smoke launcher invocation (injectable in tests). */
export interface FlockSmokeProcessResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: { readonly code?: string | undefined, readonly message?: string | undefined }
}

/** Injectable flock smoke launcher (tests). */
export type FlockSmokeLauncher = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => FlockSmokeProcessResult

/** Default launcher: the packaged Electron in Node mode, hard timeout. */
function runFlockSmokeProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): FlockSmokeProcessResult {
  const result = spawnSync(executable, [...args], {
    env,
    encoding: 'utf8',
    timeout: PACKAGED_FLOCK_SMOKE_TIMEOUT_MS,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined
      ? {}
      : { error: { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } }),
  }
}

/**
 * Resolve the packaged launcher candidates (first existing wins).
 * LinuxPackager names its launcher after the package (`dsh-plugin-desktop`);
 * macOS/Windows use the product filename inside the bundle / with `.exe`.
 * A directory scan is appended as a fallback so a renamed launcher (channel
 * build, future Electron Builder change) still resolves instead of failing the
 * gate for the wrong reason — the candidates are only used to *run* the
 * packaged Node runtime, so a wrong candidate fails loudly on spawn.
 * @param context - Electron Builder's afterPack context.
 * @returns candidate absolute paths, most specific first.
 */
export function resolvePackagedLauncherCandidates(context: PackagedRuntimeContext): string[] {
  const product = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    const macosDir = join(context.appOutDir, `${product}.app`, 'Contents', 'MacOS')
    const scanned = safeReaddir(macosDir).filter(name => !name.startsWith('.'))
    return [...new Set([join(macosDir, product), ...scanned.map(name => join(macosDir, name))])]
  }
  const executableName = typeof context.packager.executableName === 'string' && context.packager.executableName !== ''
    ? context.packager.executableName
    : undefined
  const names = [executableName, product].filter((name): name is string => name !== undefined)
  const suffix = context.electronPlatformName === 'win32' ? '.exe' : ''
  const named = [...new Set(names)].map(name => join(context.appOutDir, `${name}${suffix}`))
  if (context.electronPlatformName !== 'linux') return named
  const known = /^(?:chrome-sandbox|chrome_crashpad_handler|.*\.(?:so(?:\.\d+)*|pak|dat|bin|json|html|txt|png|yml))$/u
  const scanned = safeReaddir(context.appOutDir)
    .filter(name => !known.test(name))
    .map(name => join(context.appOutDir, name))
  return [...new Set([...named, ...scanned])]
}

/** List a directory defensively (packaging fixtures and absent bundles). */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Smoke the packaged flock path end to end: run the sealed application's Node
 * runtime, load `@deepseek-ai/node-addon-system/flock` from inside the package
 * and take a real lock on a temp file.
 *
 * P1-5: `verifyPackagedRuntime` only proves the *files* exist; a module that
 * dlopens the wrong libc variant, loses its `.node`, or silently degrades to
 * read-only would still pass. This is the executable half of "sessions stay
 * writable in the packaged app". Windows is skipped by design (flock is POSIX;
 * Windows session locking uses the persistence package's kernel32 semaphores).
 * @param context - Electron Builder's afterPack context.
 * @param launch - process launcher (tests inject a stub).
 * @returns Nothing; failure rejects with the captured process output.
 */
export function smokePackagedFlockLock(
  context: PackagedRuntimeContext,
  launch: FlockSmokeLauncher = runFlockSmokeProcess,
): void {
  if (context.electronPlatformName === 'win32') {
    console.log(
      'dsh-plugin-desktop: packaged flock smoke skipped on win32 '
      + '(POSIX flock; Windows session locking uses kernel32 named semaphores)',
    )
    return
  }
  if (nativeAddonRequirement(context.electronPlatformName) === 'none') {
    console.log(`dsh-plugin-desktop: packaged flock smoke skipped on ${context.electronPlatformName}`)
    return
  }
  const asarPath = resolvePackagedAsarPath(context)
  // Archive layout: the app root IS app.asar (only the Electron fs patch can read
  // it). Physical layout (asar: false): the real application directory.
  const appRoot = existsSync(asarPath) ? asarPath : resolvePackagedAppRoot(context)
  const candidates = resolvePackagedLauncherCandidates(context)
  const executable = candidates.find(candidate => existsSync(candidate))
  if (executable === undefined) {
    throw new Error(
      `dsh-plugin-desktop: packaged flock smoke cannot find the packaged launcher (tried ${candidates.join(', ')}); `
      + 'the afterPack context must carry packager.executableName / appInfo.productFilename',
    )
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-flock-smoke-'))
  try {
    const scriptPath = join(root, 'flock-smoke.mjs')
    writeFileSync(scriptPath, FLOCK_SMOKE_SCRIPT)
    const result = launch(executable, [scriptPath, appRoot], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    })
    if (result.error !== undefined) {
      const code = result.error.code ?? ''
      if (code === 'ETIMEDOUT' || code === 'ESRCH') {
        throw new Error(
          `dsh-plugin-desktop: packaged flock smoke timed out after ${String(PACKAGED_FLOCK_SMOKE_TIMEOUT_MS)}ms `
          + `(${executable}) — the packaged launcher did not finish loading flock`,
        )
      }
      throw new Error(
        `dsh-plugin-desktop: packaged flock smoke could not start ${executable} (${code}: ${String(result.error.message)})`,
      )
    }
    if (result.status !== 0) {
      throw new Error(
        `dsh-plugin-desktop: packaged flock smoke failed (exit ${String(result.status)}) — `
        + 'sessions would not be writable in this build (P2-15: it degrades to "write failed" with an unreadable internal error).\n'
        + `  launcher: ${executable}\n  app root: ${appRoot}\n`
        + `${result.stdout.trimEnd()}\n${result.stderr.trimEnd()}`,
      )
    }
    if (!result.stdout.includes(FLOCK_SMOKE_OK)) {
      throw new Error(
        'dsh-plugin-desktop: packaged flock smoke exited 0 without reporting '
        + `${FLOCK_SMOKE_OK} — the smoke script did not run to completion`,
      )
    }
    // P-5(2026-09-23):版本断言必须落在**真跑过的**冒烟上 —— 清单里的 6 处 pin 是声明，
    // 这一行才是"产物实际用的 Electron"的证据。
    assertPackagedElectronVersion(result.stdout, 'packaged flock smoke')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Timeout for the packaged error-reporting smoke (a hung Electron must not hang afterPack). */
export const PACKAGED_SENTRY_SMOKE_TIMEOUT_MS = 10_000

/** Success marker the embedded error-reporting script prints; a silent exit 0 is a failure. */
const SENTRY_SMOKE_OK = 'SENTRY-SMOKE-OK'

/**
 * Embedded error-reporting smoke script (P1-1).
 *
 * Runs inside the **packaged** launcher with `ELECTRON_RUN_AS_NODE=1`: only
 * Electron's fs patch can read `app.asar`, so plain Node cannot load the module
 * out of the sealed archive. It resolves `@sentry/node` the way the enterprise
 * `lib/error-reporting.js` static import does (through the app root's
 * `node_modules`), then dynamically imports the built error-reporting module and
 * asserts the Cordis plugin surface. If `@sentry/node` or the module itself
 * falls out of the package, the plugin module fails to load **with zero logs**
 * (the composition loads plugins lazily), which nothing else in the gate would
 * catch — the static entry list only proves a path exists, not that it loads.
 *
 * 同 flock 冒烟：它也会打一行 `ELECTRON-VERSION:<v>`（2026-09-23 P-5）。这个冒烟
 * **三个平台都跑**，所以它是版本断言在全平台上的落点。
 */
const SENTRY_SMOKE_SCRIPT = `import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const appRoot = process.argv[2]
process.stdout.write('${PACKAGED_ELECTRON_VERSION_MARKER}' + String(process.versions.electron) + '\\n')
const appRequire = createRequire(join(appRoot, 'package.json'))
// Static import target of the enterprise error-reporting module (external in its
// tsdown build, so this resolves at runtime, not at build time).
appRequire.resolve('@sentry/node')
const sentry = appRequire('@sentry/node')
if (typeof sentry.init !== 'function') {
  throw new Error('@sentry/node loaded from the package does not expose init()')
}
const reportingUrl = pathToFileURL(appRequire.resolve('@picoaide/dsh-enterprise/error-reporting')).href
const reporting = await import(reportingUrl)
for (const key of ['apply', 'initSentry', 'name']) {
  if (!(key in reporting)) {
    throw new Error('@picoaide/dsh-enterprise/error-reporting does not expose ' + key)
  }
}
process.stdout.write('${SENTRY_SMOKE_OK}\\n')
`

/** Result shape of one error-reporting smoke launcher invocation (injectable in tests). */
export interface SentrySmokeProcessResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: { readonly code?: string | undefined, readonly message?: string | undefined }
}

/** Injectable error-reporting smoke launcher (tests). */
export type SentrySmokeLauncher = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => SentrySmokeProcessResult

/** Default launcher: the packaged Electron in Node mode, hard timeout. */
function runSentrySmokeProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SentrySmokeProcessResult {
  const result = spawnSync(executable, [...args], {
    env,
    encoding: 'utf8',
    timeout: PACKAGED_SENTRY_SMOKE_TIMEOUT_MS,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined
      ? {}
      : { error: { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } }),
  }
}

/**
 * Smoke the packaged error-reporting path end to end: run the sealed
 * application's Node runtime, require `@sentry/node` from inside the package and
 * import the built `@picoaide/dsh-enterprise/error-reporting` entry.
 *
 * P1-1: `verifyPackagedRuntime` only proves the *files* exist; a module whose
 * static `@sentry/node` import no longer resolves would still pass the static
 * list while the whole plugin module throws at load time with zero logs.
 *
 * Unlike the flock smoke this runs on **every** platform: `@sentry/node` is pure
 * JS, so win32 has no excuse to skip, and a missing launcher is a hard failure
 * rather than a silent skip.
 * @param context - Electron Builder's afterPack context.
 * @param launch - process launcher (tests inject a stub).
 * @returns Nothing; failure rejects with the captured process output.
 */
export function smokePackagedErrorReporting(
  context: PackagedRuntimeContext,
  launch: SentrySmokeLauncher = runSentrySmokeProcess,
): void {
  const asarPath = resolvePackagedAsarPath(context)
  // Archive layout: the app root IS app.asar (only the Electron fs patch can read
  // it). Physical layout (asar: false): the real application directory.
  const appRoot = existsSync(asarPath) ? asarPath : resolvePackagedAppRoot(context)
  const candidates = resolvePackagedLauncherCandidates(context)
  const executable = candidates.find(candidate => existsSync(candidate))
  if (executable === undefined) {
    throw new Error(
      `dsh-plugin-desktop: packaged error-reporting smoke cannot find the packaged launcher (tried ${candidates.join(', ')}); `
      + 'the afterPack context must carry packager.executableName / appInfo.productFilename',
    )
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-sentry-smoke-'))
  try {
    const scriptPath = join(root, 'sentry-smoke.mjs')
    writeFileSync(scriptPath, SENTRY_SMOKE_SCRIPT)
    const result = launch(executable, [scriptPath, appRoot], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    })
    if (result.error !== undefined) {
      const code = result.error.code ?? ''
      if (code === 'ETIMEDOUT' || code === 'ESRCH') {
        throw new Error(
          `dsh-plugin-desktop: packaged error-reporting smoke timed out after ${String(PACKAGED_SENTRY_SMOKE_TIMEOUT_MS)}ms `
          + `(${executable}) — the packaged launcher did not finish loading @sentry/node`,
        )
      }
      throw new Error(
        `dsh-plugin-desktop: packaged error-reporting smoke could not start ${executable} (${code}: ${String(result.error.message)})`,
      )
    }
    if (result.status !== 0) {
      throw new Error(
        `dsh-plugin-desktop: packaged error-reporting smoke failed (exit ${String(result.status)}) — `
        + 'the enterprise error-reporting plugin would fail to load inside the packaged app with zero logs '
        + '(GlitchTip error collection would be silently dead).\n'
        + `  launcher: ${executable}\n  app root: ${appRoot}\n`
        + `${result.stdout.trimEnd()}\n${result.stderr.trimEnd()}`,
      )
    }
    if (!result.stdout.includes(SENTRY_SMOKE_OK)) {
      throw new Error(
        'dsh-plugin-desktop: packaged error-reporting smoke exited 0 without reporting '
        + `${SENTRY_SMOKE_OK} — the smoke script did not run to completion`,
      )
    }
    // P-5(2026-09-23):这个冒烟**三个平台都跑**，Electron 版本因此是全平台判据。
    assertPackagedElectronVersion(result.stdout, 'packaged error-reporting smoke')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * `afterPack` 的四个验证接缝（**唯一生产接线**）。
 *
 * 为什么是一张显式的表，而不是四个"可注入的缺省实现"：electron-builder 按**具名导出**
 * 解析本钩子（`app-builder-lib/out/util/resolve.js` 的
 * `resolveFunction(type, config.afterPack, "afterPack", root)`），并且只用一个参数调用它
 * （`app-builder-lib/out/packager.js` 的 `await emit("afterPack", context)`）。也就是说
 * 「缺省参数值」在生产上就是**唯一会跑的代码** —— 把它改成空函数＝把对应那一步验证删掉，
 * 而调用方（electron-builder）永远不会发现，也没有任何调用点守卫会红。
 *
 * 2026-09-23 第四轮审计 R4-A-9 记录的正是这个形态：旧实现把四个接缝写成
 * `verify: typeof verifyPackagedRuntime = verifyPackagedRuntime`（smoke/flockSmoke/
 * errorReportingSmoke 同形），四个缺省值逐个换成 `() => {}`（含把整个静态门禁换成空转）
 * 后 `tests/verify-packaged-runtime.spec.ts` 仍然 109/109 全绿。
 *
 * 现在的形状：生产路径**只有这张表**，`afterPack` 不再接受任何注入参数。
 *   * 要按步驱动真实现 ⇒ 用 {@link runAfterPackSeams}（显式给替身，用于单步判据）；
 *   * 要证明生产入口确实按序调用四项 ⇒ 临时 `vi.spyOn` 本表项再调 `afterPack(context)`。
 * 两条路径在 spec 的「生产接线不可空转（R4-A-9）」一组里都有对应判据，所以"把表项换成
 * 空函数"与"在 afterPack 里绕开这张表"都会红。
 */
export interface AfterPackSeams {
  /** 静态产物门禁：必需条目 / 泄漏表 / 反向 oracle / 品牌资产 / profile 锚点。 */
  readonly verify: typeof verifyPackagedRuntime
  /** 打包版诊断 Worker 冒烟（归档里真的能起来并产出诊断包）。 */
  readonly smoke: PackagedDiagnosticWorkerSmoke
  /** 打包版 flock 冒烟（会话可写；win32 按设计跳过）。 */
  readonly flockSmoke: (context: PackagedRuntimeContext) => void
  /** 打包版错误上报冒烟（`@sentry/node` 在包里真的能加载）。 */
  readonly errorReportingSmoke: (context: PackagedRuntimeContext) => void
}

/**
 * 生产接线的四个接缝（真实现，无缺省空壳）。
 *
 * 这是 `afterPack` **唯一**会使用的实现来源。测试可以临时替换本表的成员
 * （`vi.spyOn`）来观察生产入口的调用序列，但必须还原 —— 它同时是"生产接线"本身。
 */
export const AFTER_PACK_SEAMS: AfterPackSeams = {
  verify: verifyPackagedRuntime,
  smoke: smokePackagedDiagnosticWorker,
  flockSmoke: smokePackagedFlockLock,
  errorReportingSmoke: smokePackagedErrorReporting,
}

/**
 * 四步验证序列（顺序即生产顺序）。
 *
 * 导出是为了让单步判据能把**被测那一步取成真实现**（`AFTER_PACK_SEAMS[step]`）、其余
 * 步骤给替身：合成产物永远无法让静态门禁通过，所以第 2~4 步只能这样到达。
 * @param context - Electron Builder's afterPack context.
 * @param seams - 四个接缝的实现；生产传 {@link AFTER_PACK_SEAMS}。
 * @returns A promise that rejects when any step rejects.
 */
export async function runAfterPackSeams(
  context: PackagedRuntimeContext,
  seams: AfterPackSeams,
): Promise<void> {
  // 四步一律 `await`：接缝声明是同步的，但"把某一步包成 async 函数"会让**未 await 的
  // 拒绝变成 unhandled rejection、那一步静默放过**（R4-A-9 的真产物探针实测踩到过）。
  await seams.verify(context)
  const asarPath = resolvePackagedAsarPath(context)
  // Physical tree (asar: false): the worker smoke's extraction fallback reads
  // from the application root; the archive layout reads from app.asar.unpacked.
  const sourceRoot = existsSync(asarPath)
    ? resolvePackagedUnpackedRoot(context)
    : resolvePackagedAppRoot(context)
  await seams.smoke(sourceRoot, undefined, asarPath)
  await seams.flockSmoke(context)
  await seams.errorReportingSmoke(context)
}

/**
 * Run the static packaged-runtime check as Electron Builder's afterPack hook.
 *
 * **单参数是契约**：electron-builder 只传 context（具名导出 + 单参数 emit）。这里刻意
 * **不**加任何可注入的缺省实现 —— 那正是 R4-A-9 记录的空转形态（"缺省值即生产接线"）。
 * 要替换接缝请用 {@link runAfterPackSeams}，要观察生产序列请临时 spy
 * {@link AFTER_PACK_SEAMS}。
 * @param context - Electron Builder's afterPack context.
 * @returns A promise that rejects before signing when the runtime is incomplete.
 */
export async function afterPack(context: PackagedRuntimeContext): Promise<void> {
  await runAfterPackSeams(context, AFTER_PACK_SEAMS)
}
