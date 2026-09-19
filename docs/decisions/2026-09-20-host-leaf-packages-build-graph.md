# 决策：抽出两个零依赖叶子包，切断构建期依赖环（2026-09-20）

## 背景：本分支新引入的真实构建环

WASM 应用「客户端专属」改造让 desktop 的 Electron 引导第一次**静态 import 了一个插件包**：

```
desktop ──静态 import──▶ @picoaide/dsh-wasm-apps-host ──静态 import──▶ @picoaide/dsh-browser/guard
   ▲                                                                          │
   └──────────── dsh-plugin-desktop/host-locale（browser 5 个文件 + connectors）┘
```

第一次断环（只抽 `host-locale`）后又露出第二段：`browser → @picoaide/dsh-connectors`（`typeof import(…)` 三处 + `tests/credential-site.spec.ts` 用真实 `ConnectorStore`），而 connectors 依赖 desktop 的 `desktop-home` ⇒ 四边环。

**后果（实测）**：不存在任何构建顺序能产出全部产物 —— **CI 必红**（PR #101 的 Gate：`src/main.ts` / `src/app-ai-runner.ts` 报 TS2307），而**本机因为 `lib/` 产物早已存在而看不出来**（典型的"本地绿、CI 红"）。

## 决定

把两个**零依赖**的共享模块从 desktop 抽成独立叶子包：

| 新包 | 源 | 消费方 |
| --- | --- | --- |
| `@picoaide/dsh-host-locale`（`packages/host/host-locale/`） | 原 `desktop/src/host-locale.ts`（逐字节迁移） | browser（5 文件）、connectors、desktop |
| `@picoaide/dsh-host-home`（`packages/host/host-home/`） | 原 `desktop/src/desktop-home.ts`（逐字节迁移） | connectors、desktop |

**兼容面保持不变**：`dsh-plugin-desktop/host-locale` 与 `dsh-plugin-desktop/desktop-home` 仍是**可用的 re-export**（各自带 re-export 判据 + 类型层与运行期两层变异验证），既有文档与外部引用无需改动。

**构建顺序（`prebuild-workspace-deps.ts` 与 `check-workspaces.mjs` 一致）**：
`两个叶子 → connectors → browser → wasm-apps-host → desktop → {enterprise, cron, account-card, …}`。

## 长期不变量（改这两块时必须遵守）

1. **叶子包必须零依赖**：`host-locale` / `host-home` 只允许 import Node 内置模块。它们一旦依赖别的 workspace 包，环会立刻回来。
2. **声明边必须等于实测边**。可复跑判据：`node temp/wasm-client-only/cycle-check.mjs`（扫各包 `src/**`+`tests/**` 的静态/动态/`require`/越界相对 import 得出实测边，断言「声明边无环 ∧ 实测边无环 ∧ 声明==实测」）。
   > 本次踩坑的根因就是这条不成立：调度表里那条 `browser → connectors` 被当成"虚假边"删掉，于是**调度器排得下、实际跑不通**。
3. **任何"壳 import 插件包"的新依赖都要重新验图**：desktop 静态 import 插件包是本分支新增的边，正是环的起点。
4. **验收口径**：清空构建产物后 `corepack yarn check` 必须**连续两次**全绿（0 失败、0 跳过），并额外跑一次 `DSH_PREBUILD=force` + `yarn check`。
   > ⚠️ 清产物时**不要**删 `packages/vendor/memory-evolve/lib` —— 它是**入库源码**（vendored 插件的 JS 直接写在 lib/），删了会连带 65 个文件；本仓已发生过一次。

## 影响面（本次同步登记的地方）

`scripts/check-workspaces.mjs`（PACKAGES / PATH_OWNERS / DEPENDENTS）、`packages/host/desktop/scripts/prebuild-workspace-deps.ts`、`scripts/verify-layout.mjs` 的 `packageNameTable`、`.github/workflows/ci.yml` 的 workspace 构建产物归档清单、`packages/host/desktop/scripts/verify-packaged-runtime.ts` 的必需条目、`yarn.lock`、`THIRD_PARTY_NOTICES.md`。

## 遗留（如实记录）

- **打包面**：两个叶子包必须真的进 `app.asar`（connectors 的 `desktop-home` 由"devDep 内联"变成运行期 import）。已由 `REQUIRED_PACKAGED_RUNTIME_ENTRIES` + licenses/notices 覆盖；本决策落地后另跑一次真实打包（`node scripts/package-dir.mjs`）验证 afterPack 逐条断言。
- `packages/host/enterprise`（5 处）与 `packages/host/cron`（1 处）仍走 desktop 的 re-export（不在环上，按需再切）。
- `packages/host/browser/package.json` 的 `devDependencies.dsh-plugin-desktop` 现已无使用（未删）。
