/**
 * `direct-invocation.mjs` 的类型声明。
 *
 * 与 `pack-app-root.d.mts` 同款：`.mjs` 工具由 `.ts` 脚本 import，需要显式声明面，
 * 否则 `tsconfig.tests.json` 报 TS7016。
 */

/** 调用方的 `import.meta`（只需要 `url` 与可选的 `main` 两个字段）。 */
export interface InvocationMeta {
  /** 本模块的 URL（`import.meta.url`）。 */
  readonly url?: string
  /** Node 的"本模块是不是主模块"（`import.meta.main`；旧版本上可能没有）。 */
  readonly main?: boolean
}

/**
 * 取 realpath；路径不存在或读不到时回落到 `resolve()`。
 * @param path - 任意路径（可相对）。
 */
export declare function canonicalFilePath(path: string): string

/**
 * 本模块是否被当作 CLI 直接执行。
 * @param meta - 调用方的 `import.meta`。
 * @param argv1 - 入口路径；缺省取 `process.argv[1]`。
 * @throws 路径判据说"否"、而独立证据说"argv[1] 就是本文件"时。
 */
export declare function isDirectInvocation(meta: InvocationMeta, argv1?: string): boolean
