/**
 * **功能模块变体的构建期清单**（`temp/channel-variant.json`）—— 依赖裁剪的唯一开关的载体。
 *
 * ## 它在链路里的位置
 *
 * ```text
 * channel.json(features)                                   ← 私有仓，唯一真源
 *   └─ resolveChannelBuildContext()  → context.features / featuresVariant
 *        └─ prepareChannelPackaging()                          （scripts/channel-prepare.ts）
 *             └─ applyChannelVariant()  ── 写 ──▶ <desktop>/temp/channel-variant.json
 *                  ├─ pack-app-root.mjs stagePackAppRoot()   ← 按它裁 staging package.json
 *                  ├─ verify-packaged-runtime.ts             ← 按它裁三张必需表 + 缺席判据
 *                  └─ prebuild-workspace-deps.ts             ← 按它跳过被裁掉的包
 * ```
 *
 * ## 为什么是"清单文件"而不是"把参数传下去"
 *
 * 三个消费方分属**三个不同的进程/时机**：`stagePackAppRoot()` 在 electron-builder
 * 打包**之前**（同一个 Node 进程），`verify-packaged-runtime.ts` 在 **afterPack**
 * 钩子里（electron-builder 内部 require 的一个独立模块），`prebuild-workspace-deps.ts`
 * 在 `dist:*` 的最前面（可能与打包不是同一次调用 —— CI 的三平台 job 用
 * `--no-prebuild` 直接吃 gate 的产物）。把它们缝在一起的最小接口就是一个**落在
 * 已知可写通道上的 JSON 文件**：`<desktop>/temp/`（与
 * `channel-build.ts` 的 `defaultChannelBuilderConfigDir()` 同一处 —— 那个目录
 * 在 `PACK_APP_ROOT_EXCLUDED` 里，**绝不进包**）。
 *
 * ## 全开变体 = 零影响（逐字节）
 *
 * `manifestFor()` 在三个模块全开时返回 `undefined`，`applyChannelVariant()` 于是
 * **什么都不写**（并且**删掉**上一次变体构建留下的文件 —— 与 `stageChannelProfile()`
 * 对官方渠道删 `channel.json` 同一条纪律：残留比"没生效"更糟）。因此官方渠道与
 * "没写 features"的渠道，打包输入与改造前逐字节相同。先例：`prepareChannelBuilderOverrides()`
 * 对官方渠道返回 `[]`。
 *
 * @module dsh-plugin-desktop/scripts/channel-variant
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FEATURE_MODULE_NAMES,
  FEATURE_MODULE_SURFACES,
  blockedFeatureModules,
  closedFeatureModules,
  prunedFeatureBundles,
  prunedFeatureRows,
} from '../src/channel-features.ts'
import { FEATURE_MODULES } from './channel-constants.ts'

/** 变体清单的文件名（落点见 {@link defaultChannelVariantDir}）。 */
export const CHANNEL_VARIANT_MANIFEST_FILENAME = 'channel-variant.json'

/** 清单 schema 标识（形状变了下游必须当场拒，而不是按缺省值猜）。 */
export const CHANNEL_VARIANT_SCHEMA = 'picoaide.channel-variant.v1'

/**
 * 构建期需要的渠道上下文的**结构最小面**。
 *
 * 刻意不 import `channel-build.ts` 的 `ChannelBuildContext`：那个模块顶端 import
 * `../src/desktop-home.ts`（需要 `node_modules` 链接才能解析），而本模块的消费者里有
 * `pack-app-root.mjs` —— 它属于打包输入侧，越少依赖越好（2026-09-28 的三探针
 * tag 事故就是"常量模块意外依赖了包解析"）。`ChannelBuildContext` 结构上满足本接口。
 */
export interface ChannelVariantSource {
  /** 渠道 id（只用于报错定位，不进清单）。 */
  readonly channelId: string
  /** 规范化后的三键布尔表。 */
  readonly features: Readonly<Record<string, boolean>>
  /** 稳定变体标识（`channelFeaturesVariant()` 的结果）。 */
  readonly featuresVariant: string
  /** 是否官方渠道（官方渠道恒为全开，见 `assertChannelVariantSupported`）。 */
  readonly official: boolean
}

/**
 * 变体清单 —— **构建期依赖裁剪的唯一输入**。
 *
 * 只带"要摘掉什么"，不带"要怎么摘"：三个消费方各自把它折进自己的表（staging
 * `package.json` / 三张必需表 / prebuild 包表），折叠规则各只有一处。
 */
export interface ChannelVariantManifest {
  /** 形状标识（{@link CHANNEL_VARIANT_SCHEMA}）。 */
  readonly schema: string
  /** 变体标识（`skills,apps,connectors` / `apps` / `none` …）。 */
  readonly variant: string
  /** 关闭的模块名（顺序 = `FEATURE_MODULE_SURFACES` 的顺序）。 */
  readonly modules: readonly string[]
  /** 要从 staging `package.json` 的 `dependencies` 摘掉的包名。 */
  readonly packages: readonly string[]
  /** 要从 profile 的 bundle 层摘掉的包名（= `packages`，单列是为了让口径显式）。 */
  readonly bundles: readonly string[]
  /** 要从必需行清单摘掉的行 id。 */
  readonly rows: readonly string[]
  /** 对应的仓库相对目录（构建期输入表的键）。 */
  readonly directories: readonly string[]
}

/**
 * 变体清单的落点：桌面包根的 `temp/`。
 *
 * `temp/` 在 `pack-app-root.mjs` 的 `PACK_APP_ROOT_EXCLUDED` 里（开发期目录、
 * 被 gitignore 覆盖），与暂存根 `dist/.pack-root/` 没有包含关系 ⇒ 写在里面的任何
 * 东西都**不会**被暂存层收编进 asar。这是 `build/` 与 `temp/` 的分工：
 * `build/` 是随包渠道内容（整目录进 asar），`temp/` 是打包工具中间产物。
 * @returns 绝对路径。
 */
export function defaultChannelVariantDir(): string {
  // `scripts/` 的上一级 = 桌面包根。
  return channelVariantDirFor(dirname(dirname(fileURLToPath(import.meta.url))))
}

/**
 * 给定桌面包根，返回它的变体清单落点（`<packageRoot>/temp`）。
 *
 * 单独一个函数是为了让 `pack-app-root.mjs` 用它**入参里的那个包根**，而不是
 * `import.meta.url` 推出来的那一个 —— 暂存层在单测里用临时包根驱动，两者在
 * 那里不是同一个目录，"按模块自己的位置猜包根"会让测试静默读到生产清单。
 * @param packageRoot - 桌面包的绝对路径。
 * @returns 绝对路径。
 */
export function channelVariantDirFor(packageRoot: string): string {
  return join(resolve(packageRoot), 'temp')
}

/**
 * 从渠道上下文派生变体清单（**全开时返回 `undefined`**）。
 *
 * 这是"官方/全开变体零影响"的落点：三个模块全开 ⇒ 没有清单 ⇒ 三个消费方全部
 * 走原路径，一个字节都不变。
 * @param source - 渠道上下文（结构见 {@link ChannelVariantSource}）。
 * @returns 变体清单；全开时为 `undefined`。
 */
export function manifestFor(source: ChannelVariantSource): ChannelVariantManifest | undefined {
  const modules = closedFeatureModules(source.features)
  if (modules.length === 0) return undefined
  const closed = new Set(modules)
  return {
    schema: CHANNEL_VARIANT_SCHEMA,
    variant: source.featuresVariant,
    modules,
    packages: prunedFeatureBundles(source.features),
    bundles: prunedFeatureBundles(source.features),
    rows: prunedFeatureRows(source.features),
    directories: [
      ...new Set(FEATURE_MODULE_SURFACES
        .filter(surface => closed.has(surface.module))
        .flatMap(surface => [...surface.directories])),
    ],
  }
}

/**
 * 构建期闸门：**今天还裁剪不了的模块**（`blockedReason` 非空）被关掉时当场拒建。
 *
 * 为什么是拒绝而不是"照常构建、只是不裁"：不裁的产物看起来成功，客户拿到的却是
 * "声明关了、东西还在"的包；而**只裁一半**（摘依赖但不摘装配面）会让客户端启动即
 * ERR_MODULE_NOT_FOUND —— 两种都比一次点名的构建立即失败更贵。
 * @param source - 渠道上下文。
 * @throws 有模块被关闭、但该模块的裁剪面尚未就绪时（报模块名与原因）。
 */
export function assertChannelVariantSupported(source: ChannelVariantSource): void {
  const blocked = blockedFeatureModules(source.features)
  if (blocked.length === 0) return
  const detail = blocked.map(entry => `  - features.${entry.module}=false：${entry.reason}`).join('\n')
  throw new Error(
    `channel-variant: 本次构建声明关闭了 ${blocked.length} 个模块，但它们今天还不支持被真正裁出产物：\n`
    + `${detail}\n`
    + '修法二选一：① 先在 harness 里把那几处改成"模块不在时不接线"；'
    + '② 本次构建把该模块的 features 打开。**不要**用"照常构建"绕过 —— '
    + '那会交付一个"声明关了、代码还在"的包。',
  )
}

/**
 * 读变体清单（不存在 / 不是本 schema 时为 `undefined`）。
 *
 * 形状不认识时**不抛错**而是拒绝：`verify-packaged-runtime.ts` 的调用点在 afterPack，
 * 报错信息要留给"归档里真的缺东西"；而 schema 不认识时的正确行为是**不做任何裁剪**
 * （= 按全开清单判），于是坏清单会表现为"清单里的条目在归档里不存在"并当场拒包 —— 
 * 方向安全。（写入侧是唯一生产者，schema 漂移由 `tests/channel-variant.spec.ts` 钉住。）
 * @param dir - `temp/` 目录（缺省 {@link defaultChannelVariantDir}）。
 * @returns 清单；无文件 / 坏 JSON / schema 不符时为 `undefined`。
 */
export function readChannelVariantManifest(dir: string = defaultChannelVariantDir()): ChannelVariantManifest | undefined {
  const file = join(dir, CHANNEL_VARIANT_MANIFEST_FILENAME)
  if (!existsSync(file)) return undefined
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.schema !== CHANNEL_VARIANT_SCHEMA) return undefined
  const strings = (key: string): string[] | undefined => {
    const raw = record[key]
    if (!Array.isArray(raw) || raw.some(entry => typeof entry !== 'string')) return undefined
    return raw as string[]
  }
  const modules = strings('modules')
  const packages = strings('packages')
  const bundles = strings('bundles')
  const rows = strings('rows')
  const directories = strings('directories')
  const variant = record.variant
  if (modules === undefined || packages === undefined || bundles === undefined
    || rows === undefined || directories === undefined || typeof variant !== 'string') {
    return undefined
  }
  return { schema: CHANNEL_VARIANT_SCHEMA, variant, modules, packages, bundles, rows, directories }
}

/**
 * 清掉变体清单（**任何一次构建都先做**）。
 *
 * 与 `stageChannelProfile()` 对官方渠道删 `build/channel.json` 同一条纪律：
 * 上一次变体构建留下的清单若被全开构建继承，产物会**少掉模块却没有任何声明** ——
 * 比"没生效"更糟。
 * @param dir - `temp/` 目录（缺省 {@link defaultChannelVariantDir}）。
 */
export function clearChannelVariantManifest(dir: string = defaultChannelVariantDir()): void {
  rmSync(join(dir, CHANNEL_VARIANT_MANIFEST_FILENAME), { force: true })
}

/**
 * 打包前的变体就位（**唯一写入口**）—— `prepareChannelPackaging()` 的一步。
 *
 * 三个分支：
 *   - 有模块被关掉、且都支持裁剪 ⇒ 写清单，返回它；
 *   - 三个模块全开 ⇒ **删掉旧清单**、什么都不写（官方/全开变体逐字节等价于改造前）；
 *   - 有模块被关掉但今天裁不了 ⇒ {@link assertChannelVariantSupported} 抛错（不产出包）。
 * @param source - 渠道上下文。
 * @param dir - 落点（缺省 {@link defaultChannelVariantDir}；测试注入临时目录）。
 * @returns 写出的清单；全开时为 `undefined`。
 * @throws 声明关闭了尚不支持裁剪的模块时。
 */
export function applyChannelVariant(
  source: ChannelVariantSource,
  dir: string = defaultChannelVariantDir(),
): ChannelVariantManifest | undefined {
  const target = resolve(dir)
  // 先清：残留清单会被全开构建继承。
  clearChannelVariantManifest(target)
  // 声明面自检（**每次构建都判**，不只在单测里）：`src/channel-features.ts` 为了绕开
  // `tsconfig` 的 `rootDir: "src"` 约束逐字重列了模块名，与 `FEATURE_MODULES` 漂移
  // 时必须当场红 —— 否则新增一个模块而忘了登记摘除面，会表现成"声明关了、东西还在"。
  // 放在这里而不是只在测试里：这条判据守的是**构建**，构建期才是它唯一有价值的时刻。
  assertModuleSurfaceCoverage(FEATURE_MODULES)
  assertChannelVariantSupported(source)
  const manifest = manifestFor(source)
  if (manifest === undefined) return undefined
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, CHANNEL_VARIANT_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * 构建期自检：本模块认识的三个模块名与 `FEATURE_MODULES` **逐字同源**。
 *
 * 本文件是唯一同时能 import 两侧的地方（`src/channel-features.ts` 与
 * `scripts/channel-constants.ts`），所以这条判据挂在这里而不是散在测试里：
 * 少一个键（新增模块忘了登记摘除面）或多一个键（写了退役模块）都当场红。
 * @param featureModules - `channel-constants.ts` 的 `FEATURE_MODULES`。
 * @throws 两个清单的键集合或顺序不一致时。
 */
export function assertModuleSurfaceCoverage(featureModules: readonly string[]): void {
  const known = FEATURE_MODULE_NAMES
  if (known.length === featureModules.length && known.every((name, index) => name === featureModules[index])) {
    return
  }
  throw new Error(
    'channel-variant: src/channel-features.ts 的模块名与 scripts/channel-constants.ts 的 FEATURE_MODULES 漂移 —— '
    + `constants=[${featureModules.join(', ')}] channel-features=[${known.join(', ')}]`
    + '（新增模块时必须同时登记它的 packages / rows / directories；顺序也要一致，'
    + '`channelFeaturesVariant()` 按 constants 的顺序拼变体标识）',
  )
}
