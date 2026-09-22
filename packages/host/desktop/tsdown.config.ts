import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-plugin-desktop'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      'module-resolution': 'src/module-resolution.ts',
      'asar-spawn': 'src/asar-spawn.ts',
      'asar-file-system': 'src/asar-file-system.ts',
      'asar-guidance': 'src/asar-guidance.ts',
      'desktop-home': 'src/desktop-home.ts',
      'host-locale': 'src/host-locale.ts',
      'desktop-channel': 'src/desktop-channel.ts',
      // 出口策略（2026-09-22）：main.ts 用它接线，`scripts/proxy-policy-probe.mjs` 用
      // **构建产物**跑真机判据（同一个真源，探针里不另抄开关名）。
      'network-policy': 'src/network-policy.ts',
      // 孤儿写锁回收（2026-09-22）：main.ts 接线；`scripts/verify-profile-boot.mjs`
      // 用**构建产物**在真组合树上跑能力判据（孤儿锁在 ⇒ settings 写缝超时失败；
      // 回收后 ⇒ 同一写缝成功）—— 与探针共用一个真源。
      'document-lock-recovery': 'src/document-lock-recovery.ts',
      profile: 'src/profile.ts',
      'desktop-plugins': 'src/desktop-plugins.ts',
      diagnostics: 'src/diagnostics.ts',
      // P0-6/D8:渲染进程错误契约(preload + 宿主 + 打包断言都引用它)。
      'renderer-error-contract': 'src/renderer-error-contract.ts',
      'diagnostic-export-worker': 'src/diagnostic-export-worker.ts',
      runtime: 'src/runtime.ts',
      'electron-runtime': 'src/electron-runtime.ts',
      'update-checker': 'src/update-checker.ts',
      'update-download': 'src/update-download.ts',
      updates: 'src/updates.ts',
      'loop-notify': 'src/loop-notify.ts',
      'loop-notify-route': 'src/loop-notify-route.ts',
      'loop-notify-contract': 'src/loop-notify-contract.ts',
      // P0-9(2026-09-20 升级审计):必需行清单与激活断言既被 src/main.ts 引用,
      // 也被 scripts/verify-profile-boot.mjs 引用(后者是**唯一**真正挂载完整个
      // 桌面组合树的地方)。作为独立入口产出,冒烟 import 的就是同一个真源 ——
      // 不能在冒烟里另抄一份清单(两份必然漂移,而漂移的清单正是这次要修的形态)。
      'startup-rows': 'src/startup-rows.ts',
      'windows-agent-presets': 'src/windows-agent-presets.ts',
      'windows-pwsh-sandbox': 'src/windows-pwsh-sandbox.ts',
      'windows-acl-runner': 'src/windows-acl-runner.ts',
      main: 'src/main.ts',
    },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
  },
  {
    // Sandboxed preload (P0-6/D8): `sandbox: true` 下 Electron 不支持 ESM
    // preload,而本包 `"type": "module"` 会把 .js 当 ESM —— 所以必须显式输出
    // .cjs。入口路径也要与 window-options.ts 里的解析一致。
    name: `${PACKAGE_NAME}/preload`,
    entry: { 'preload/renderer-error': 'src/preload/renderer-error.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    external: ['electron'],
    outputOptions: {
      entryFileNames: 'preload/renderer-error.cjs',
    },
  },
  {
    name: `${PACKAGE_NAME}/bin`,
    entry: { bin: 'src/bin.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      banner: '#!/usr/bin/env node',
    },
  },
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.ts' },
    tsconfig: 'tsconfig.client.json',
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    external: [
      ...PLATFORM_MODULES,
      ...PRELOADED_CLIENT_EXTERNALS,
    ],
    // tsdown external matching is a specifier prefix; the platform table
    // entries ('react', 'react-dom', 'react/jsx-runtime') are exact strings,
    // so match the same prefixes tsdown would. Non-platform values inline.
    noExternal: (id: string) => id.startsWith('@deepseek-ai/') || id === 'react' || id.startsWith('react/') || id === 'react-dom' || id.startsWith('react-dom/') ? undefined : true,
    // Inlined libraries (react/react-dom read process.env.NODE_ENV in their
    // dev branches) need the substitution at build time, exactly like the
    // upstream clientBundle preset — otherwise the browser bundle throws
    // "process is not defined" at factory execution.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
