# 决策：全部编译产物进 Electron asar 虚拟文件系统（仅原生模块物理）

日期：2026-08-22　分支：feat/enterprise　状态：已定案，待实施

## 目标
把 electron-builder 的 `asarUnpack` 从当前的 `node_modules/**`（全量物理解包，app.asar.unpacked ≈ 435MB）收窄为**仅原生模块**，使全部纯 JS 依赖进入 `app.asar`（虚拟单文件）。应用根 `lib/` 已在 asar 内（`package.json main: lib/main.js` 从 asar 虚拟路径加载，运行正常）。

## 已实测约束（2026-08-22 实验）
1. **asar 内 require 可行**：Electron 主进程、`ELECTRON_RUN_AS_NODE` 子进程、`worker_threads` 均能从 `app.asar/node_modules/<pkg>` 加载 JS（含 bare import）。
2. **原生模块必须物理**：`.node` / `.dll` / `.exe`（node-pty、koffi、sharp/@img、@vscode/ripgrep）只能从真实文件系统加载——这是 Electron 硬限制。
3. **profile 软链不可指向 asar 内部**：`healProfilesModuleFallback` 在 `$DSH_HOME/profiles/node_modules` 建软链，目标若在 asar 内则 Node 目录 walk 解析失败。若保留该软链机制需改造 `module-resolution.ts` 的 resolver hook；当前 profile 即 `desktop`（固定），软链目标是应用树物理位置——需评估是否受影响。
4. **pnpm 已移除**：终端/插件管理链删除（commit a5c4db1），无生命周期脚本约束，pnpm 不进包。
5. **契约墙**：`scripts/verify-packaged-runtime.ts` 的 `REQUIRED_UNPACKED_RUNTIME_ENTRIES`（列 `node_modules/pnpm/bin/pnpm.mjs`、各插件 lib 物理路径）需同步收窄为**仅原生条目**。

## 改造范围
- `packages/host/desktop/package.json`：`asarUnpack` 从 `["package.json","cordis.patch.yml","build/**","lib/**","node_modules/**"]` 改为仅原生模块 glob；`build.files` 相应调整。
- `packages/host/desktop/scripts/verify-packaged-runtime.ts`：`REQUIRED_PACKAGED_RUNTIME_ENTRIES` / `REQUIRED_UNPACKED_RUNTIME_ENTRIES` / `REQUIRED_UNPACKED_PACKAGE_SPECIFIERS` 收敛为原生条目（保留 `@deepseek-ai/dsh` agent presets 等非 JS 资源？——agent presets 是 YAML/SKILL.md 资源，物理/虚拟均可读，验证实测）。
- 对应单测（`verify-packaged-runtime.spec.ts`）与 README「打包」段、THIRD_PARTY_NOTICES（若依赖图变化）。
- 验证：`yarn package:dir` → 实测打包 → CDP 启动 + `e2e:client` 全绿 + `yarn check` 全绿。

## 验收（2026-08-22 完成）
1. ✅ `app.asar` 286MB（全部 JS 依赖+应用代码进虚拟文件系统）；`app.asar.unpacked` 54MB/35 文件（仅原生二进制）。
2. ✅ 修复关键适配：
   - asarUnpack 文件级精确解包（仅 .node/.dll/.exe/.so/.dylib/bin/rg/spawn-helper）+ `asar:{smartUnpack:false}`
   - `module-resolution.ts`：profile walk + 桌面树(asar) fallback 双路径（Loader 解析 asar 内包）
   - `profile.ts`：INSTALL_ANCHOR/shippedPresetRoot 去掉 unpackedAsarPath（从 asar 直接读）
   - 删除 `packaged-runtime-path.ts`（无调用方）
   - `verify-packaged-runtime.ts`：契约改为「全部 JS 进 asar + 仅原生二进制物理解包 + 无 JS 泄漏检查 + smoke 从 asar 提取 worker」
3. ✅ verify-loader/verify-profile/verify-packaged-runtime/profile.spec 全通过。
4. ⚠️ GUI 实际启动验证受沙箱限制（Electron GUI 进程被 sandbox 反复 SIGKILL）；headless Loader/Profile smoke 已覆盖组合正确性。
