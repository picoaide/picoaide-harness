/**
 * 技能商店（能力中心）的**本机 API**（host 面）—— 2026-10-13（P0-b）自
 * `packages/host/enterprise/src/auth-gate.ts` 的四处路由块逐字搬出。
 *
 * 搬它的**唯一**目的：让"关掉技能商店 ⇒ 它的代码不进产物"在依赖图上成立。此前
 * 四条本机路由住在 `@picoaide/dsh-enterprise`（必需包）里，模块再怎么关，
 * 这一整块（1,088 行 = auth-gate 的 34.6%）照样进 app.asar。
 *
 * ## 行为零变化
 *
 * 路由路径、方法分发、状态码、错误码、文案键**逐字不变** —— 搬的只是"谁来注册"。
 * 围栏（回环 + 同源 + 持有性证明）、网关客户端、语言解析都不在这里重新实现：它们
 * 由 auth-gate 经 `ctx.provide('picoLocalRoutes', …)` 交出**同一批闭包**，
 * 本模块只做结构探测后调用（与 `wasm-apps-host/src/session.ts` 探测
 * `picoSession` 同形）。**不要**把任何围栏判定复制一份进来：那是第二真源，
 * 而这里判的是信任边界。
 *
 * @module @picoaide/dsh-capability-center/host/skill-routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostCopy, type HostLocale } from '@picoaide/dsh-host-locale'
import { ApiError, AuthError, fetchJSON, gatewayFetch, normalizeServerURL, PASSWORD_CHANGE_REQUIRED_CODE } from '@picoaide/dsh-gateway-client/auth'
import type { Session } from '@picoaide/dsh-gateway-client/config'
import { MAX_ARCHIVE_BYTES } from './archive-util.ts'
import {
  describeArchiveFailure,
  INSTALL_VERSION_FILE,
  installSkillArchive,
  isForeignServerProvenance,
  isInstalledSkillDirty,
  isStoreProvenance,
  listInstalledSkills,
  listLocalSkills,
  packSkill,
  readProvenance,
  resolveSkillsDir,
  uninstallSkill,
  validateRuntimeSkillName,
  validateSkillName,
  type SkillInstallLog,
} from './skill-install.ts'
import { runtimeSkillRoots, selectLiveWorkspacePaths, workspaceProjectRoots, type RuntimeSkillRoot } from './skill-runtime-roots.ts'
import {
  installPresetArchive,
  listInstalledPresets,
  listLocalPresets,
  mapLocalPresets,
  packPreset,
  resolvePresetsDir,
  uninstallPreset,
  validatePresetId,
} from './agent-preset-install.ts'

/** 上传 body 上限(审计 2026-08-25 P2-2):本地 upload body 实际只含元数据
 * (archive 由 pack 后经 fetchJSON 出站);24MB 与服务端 MaxBodyBytes 对齐,
 * 未来若改为经本地 body 转发归档亦兼容 —— 非 base64 膨胀的实际需求。 */
const UPLOAD_BODY_BYTES = 24 * 1024 * 1024

/**
 * 已装共享 Agent(preset)在磁盘上的版本号。
 *
 * 审计 2026-09-12 P1-6:能力中心的「更新到 vX」由客户端
 * `CapabilityCenterPanel.hasUpdateFor()` 决定,而它要求
 * `installedVersion !== undefined`。共享 Agent 侧的该字段此前**恒为
 * undefined**(`kind === 'skill' ? … : undefined`,注释却写着"取 '1.0.0'
 * 兜底"),于是本地已装 v1、远端已发布 v2 时也永不出现更新入口。
 *
 * 版本事实在磁盘上确实存在——`agent-preset-install.ts` 的安装器与技能走
 * 同一套落盘:`.picoaide/release.json`(provenance),旧安装回落
 * `.install-version` 标记。preset.yml 没有 version 字段,故没有第三层兜底:
 * 读不到就返回 undefined,让客户端保守判 false(宁可不提示,不可误报)。
 * @param presetDir - 一个已安装 preset 的目录。
 * @returns 版本号,或 undefined(未安装 / 无版本信息)。
 */
export async function readInstalledPresetVersion(presetDir: string): Promise<string | undefined> {
  const prov = await readProvenance(presetDir)
  if (prov !== undefined && prov.version !== '') return prov.version
  const marker = await readFile(join(presetDir, INSTALL_VERSION_FILE), 'utf8').then(s => s.trim()).catch(() => undefined)
  return marker !== undefined && marker !== '' ? marker : undefined
}

/**
 * 按 kind 选已装版本表(技能 / 共享 Agent)。
 * @param kind - 目录行的 kind('skill' | 'agent')。
 * @param name - 目录行名。
 * @param skillVersions - 技能版本表。
 * @param presetVersions - 共享 Agent 版本表。
 * @returns 已装版本,或 undefined(未知)。
 */
export function installedVersionFor(
  kind: string,
  name: string,
  skillVersions: ReadonlyMap<string, string | undefined>,
  presetVersions: ReadonlyMap<string, string | undefined>,
): string | undefined {
  return kind === 'skill' ? skillVersions.get(name) : presetVersions.get(name)
}

/**
 * 按 kind 选"本机那一份的来源"表（审计 2026-09-23 A2/A3）。
 *
 * 客户端用它决定"更新到 vX / 卸载"要不要先弹确认条：`store` = 能力中心装的，
 * 直接替换/删除；`local` = 本机自制（或缺溯源），必须先由用户确认，宿主也会
 * 在缺 `?overwrite=1` 时以 409 `LOCAL_CONTENT` 拒绝。
 * @param kind - 目录行的 kind('skill' | 'agent')。
 * @param name - 目录行名。
 * @param skillOrigins - 技能来源表。
 * @param presetOrigins - 共享 Agent 来源表。
 * @returns `'store'` / `'local'`，未知（未安装/读不到）为 undefined。
 */
export function installedOriginFor(
  kind: string,
  name: string,
  skillOrigins: ReadonlyMap<string, 'store' | 'local'>,
  presetOrigins: ReadonlyMap<string, 'store' | 'local'>,
): 'store' | 'local' | undefined {
  return kind === 'skill' ? skillOrigins.get(name) : presetOrigins.get(name)
}

/**
 * 解析本机路由里的一格 `decodeURIComponent`：**畸形百分号转义不再抛穿 handler**。
 *
 * 为什么必须兜住（第六轮审计 R6-B 的 P3，与 wasm-apps 的 FIX-40 同一条纪律）：
 * `decodeURIComponent('%zz')` 抛 `URIError`，而本模块的 handler 是 async 的 ——
 * 异常会一路抛到上游 webserver，被兜底成 `writeHead(400); res.end()`（**无 body**）。
 * 而本机 API 的错误口径是"一律 JSON 信封"（第一消费者是 AI 的 http 工具/脚本）：
 * 一个空 body 等于让它完全无法判断该改什么。
 *
 * 合法客户端不会构造这种路径（面板一律 `encodeURIComponent`），所以这条不是安全
 * 边界，而是**契约完整性**：四个上游 JSON 分支之外，宿主自己也要守同一条。
 * @param raw - 正则捕获到的原始段（未解码）。
 * @returns 解码结果；非法转义 ⇒ `null`（调用方回 400 具名信封）。
 */
export function decodePathSegment(raw: string | undefined): string | null {
  if (raw === undefined) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * 归档超限的响应文案（技能/智能体下载与上传路径可见，回到能力中心面板）。
 *
 * 上限值来自 `MAX_ARCHIVE_BYTES`，两种语言插同一个数 —— 只翻译措辞。
 * @param locale - 本次请求的语言。
 * @returns 该语言的提示文案（zh 与历史逐字一致）。
 */
export function archiveTooLargeError(locale: HostLocale): string {
  return hostCopy(
    locale,
    `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）`,
    `Archive too large (over ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB)`,
  )
}

/**
 * 本机**仍在使用**的工作区目录（R18B-01；R19A-S2-05/06/07 收窄 + 可诊断）。
 *
 * 来源是**宿主侧权威** `ctx.workspaceRegistry`（上游 workspace 包的服务，会话 cwd 的
 * 唯一登记处）—— 与 `wasm-apps.ts` 的 `readRoots` 同款做法：**结构类型 + 请求期解析**，
 * 不为它增加 import（服务缺席时退化成"没有项目根"，与旧行为一致）。
 *
 * 为什么不要一个第二份来源：技能库是**机器作用域**的（一个根服务全部会话），而运行时
 * 按**每个会话的 cwd** 决定 project 根 ⇒ 要判"装/卸是否真的生效"，就必须看到本机
 * 所有会话可能用到的项目根。客户端下发的 cwd 不作数（那是安全判据的输入，不能由
 * 被判定方提供）。
 *
 * R19A-S2-05/06：登记表本身**不等于**"运行时真的会扫描的项目根"（注册表是持久记录，
 * 目录删了也留着；一个从来没有会话的工作区谁也不会带 cwd 去访问它）。判据收口到
 * `skill-runtime-roots.ts` 的 `selectLiveWorkspacePaths`（目录仍在 + 有会话背书），
 * 这里只负责把**被跳过的登记项**与**宿主契约漂移**如实记进宿主日志：
 *   - 目录已不存在的登记项会经 `.git` 上溯把**祖先**当项目根（422 点名一个用户没
 *     打开过的项目路径）—— 现在跳过并留下一条可检索日志；
 *   - 注册表整个抛错时**零日志 + 判据静默消失**（项目根全部不见了，正是 R18B-01 修前
 *     的世界）—— 现在 fail-loud 记一条，说明"本次安装/卸载没有扫项目根"。
 * @param ctx - Host 上下文。
 * @returns 仍在使用的工作区目录（过滤掉空/非字符串取值；注册表未就绪/不可读时为空数组）。
 */
function registeredWorkspacePaths(ctx: Context): string[] {
  const registry = (ctx as unknown as {
    get?: (name: string) => unknown
  }).get?.('workspaceRegistry') as { list?: () => Array<{ path?: unknown, sessionIds?: unknown }> } | undefined
  let entries: Array<{ path?: unknown, sessionIds?: unknown }>
  try {
    entries = registry?.list?.() ?? []
  } catch (cause) {
    // 注册表把顺序与表的一致性校验做在 list() 里 ⇒ 它抛错通常意味着**库/记录不一致**，
    // 而不是"没有工作区"。旧实现把两者合并成"没有项目根"且**一条日志都不打**：
    // 判据静默退化成 R18B-01 修前的世界（项目里的同名技能把落点盖住也不会有人知道）。
    const message = cause instanceof Error ? cause.message : String(cause)
    ctx.logger?.warn?.(
      `[skill-install] the workspace registry could not be listed (${message}); this install/uninstall was checked `
      + 'WITHOUT project skill roots (a same-named skill in a project directory would go unreported)',
    )
    return []
  }
  const selection = selectLiveWorkspacePaths(entries)
  if (selection.sessionFieldAbsent) {
    ctx.logger?.warn?.(
      '[skill-install] the workspace registry entries carry no sessionIds field (host contract drift): project skill '
      + 'roots were NOT scanned for this install/uninstall — check the pinned upstream workspace service',
    )
  }
  // 每个被跳过的登记项一条日志（上限 5 条 + 一条汇总，避免陈旧记录刷爆日志）：
  // 排障要能看到"为什么这个项目的技能没有参与判定"。
  for (const skipped of selection.skipped.slice(0, 5)) {
    ctx.logger?.warn?.(
      `[skill-install] skipped the registered workspace ${skipped.path}: `
      + (skipped.reason === 'missing-dir'
        ? 'the directory no longer exists (a stale registration)'
        : 'no session is attached to it, so no session can use it as its working directory'),
    )
  }
  if (selection.skipped.length > 5) {
    ctx.logger?.warn?.(`[skill-install] skipped ${selection.skipped.length - 5} further registered workspace(s) on the same grounds`)
  }
  return [...selection.live]
}

/**
 * 技能安装/卸载路由用的**运行时根表**（R18B-01）。
 *
 * 在 `runtimeSkillRoots` 的 env 派生根表之上，把**已登记工作区**折成的项目根
 * （`<project>/.dsh/skills` rank 100、`<project>/.agents/skills` rank 200，
 * 都排在能力中心落点 400 之前）一并算进"已知根"：
 *   - **卸载**：删掉落点之后项目根那份会接管 ⇒ `listCrossRootSkillResidues` 如实报
 *     `RESIDUE`（此前根表里没有项目根，于是"卸载成功"只是界面上的说法）；
 *   - **安装**：项目根那份排在落点之前 ⇒ `listOutrankingSkillResidues` 报 `RESIDUE`
 *     （此前"装好了"同样是假象，而项目根在工作区里 = 沙箱可写根，随仓库克隆或
 *     agent 自写都能形成持久的系统提示词注入面）。
 *
 * 根表本身仍是**一份实现**（`skill-runtime-roots.ts` 的 `runtimeSkillRoots`）；
 * 这里只补"项目根从哪来"。
 * @param ctx - Host 上下文。
 * @param skillsDir - 能力中心管的技能库根。
 * @returns 运行时发现根（rank 升序）。
 */
function skillRuntimeRootsForHost(ctx: Context, skillsDir: string): RuntimeSkillRoot[] {
  return runtimeSkillRoots({ skillsDir, projectRoots: workspaceProjectRoots(registeredWorkspacePaths(ctx)) })
}

/**
 * 安装器日志出口（R18B-04）：接线到 Cordis logger。
 *
 * 桌面**唯一**会写 `<userData>/logs` 的通道是 `hostCtx.logger.exporter(fileExporter)`
 * （`packages/host/desktop/src/main.ts`），而诊断包只收 `<userData>/logs`；Windows GUI
 * 没有 stderr ⇒ 安装器的 `console.warn`（技能库清理/自愈/回滚失败的唯一痕迹）在生产
 * 彻底静默，"为什么这个技能/这个目录不见了"无从追溯。这里按调用注入 `ctx.logger`。
 * @param ctx - Host 上下文。
 * @returns 交给 `installSkillArchive` / `uninstallSkill` 的日志出口。
 */
function skillInstallLogForHost(ctx: Context): SkillInstallLog {
  return { warn: message => { ctx.logger?.warn?.(message) } }
}

/**
 * 本机路由共用的**围栏与出口**：由 `@picoaide/dsh-enterprise/auth-gate` 的
 * `apply()` 经服务 `picoLocalRoutes` 交出（唯一实现，见模块头注释）。
 *
 * 结构类型而非 import：指向 auth-gate 会闭合出
 * `desktop → wasm-apps-host → enterprise → desktop` 这个构建环，而这一批原语
 * 是**判定**（回环/同源/持有性证明/审计只读），复制一份就是第二真源。
 */
export interface HostLocalRouteFence {
  /** 回环 + 同源围栏（所有方法都要过）。 */
  guard(req: IncomingMessage, res: ServerResponse): boolean
  /** 写面持有性证明（GET 直接放行，非 GET 在 fence 缺席时 fail-closed 503）。 */
  requireWriteProof(req: IncomingMessage, res: ServerResponse): boolean
  /** §4.5 双保险：auditor 不得触发写面。 */
  writeGuard(): boolean
  /** 当前员工会话（令牌 + 服务端地址）。 */
  session(): Session | null
  /** 本地 JSON 响应。 */
  json(res: ServerResponse, code: number, body: unknown): void
  /** 本地请求体收集（带上限，超限抛错）。 */
  collectBody(req: IncomingMessage, limit: number): Promise<Buffer>
  /** 上游响应的流式读取（带上限，超限即 cancel 并抛错）。 */
  readBodyLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer>
  /** 宿主语言（本地文案按请求解析，禁止模块级冻结）。 */
  hostLocale(req?: IncomingMessage): HostLocale
  /** 网关失败分支（保留"先改密"的稳定码与可操作路径）。 */
  gatewayError(res: ServerResponse, cause: unknown): void
  /** 服务端要求先改密时的统一本地应答（R15B-02：带稳定码 + 不改会话 + 落标记）。 */
  passwordChangeRequired(res: ServerResponse, message: string): void
  /**
   * 只清"发起这次请求时的那一个会话"（R22-V1-N3：迟到的 401 不得清掉新登录）。
   * 直接转发 `clearSessionIfCurrent`，本包不自己持有会话服务。
   */
  clearSessionIfCurrent(token: string): void
}

/** 本模块交给 `ctx.webServer.register` 的一条路由（方法分发在 handler 内）。 */
export interface SkillRoute {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/**
 * 构造技能商店的四条本机路由（**不注册**，由调用方交给 webServer）。
 *
 * 拆分"构造"与"注册"是为了让判据能直接拿到路由对象 —— 与
 * `wasm-apps.ts` 的 `createWasmAppsRoute()` 同一形状。
 * @param ctx - Host 上下文（用 logger 与 picoSession）。
 * @param fence - 共用的围栏与出口（见 {@link HostLocalRouteFence}）。
 * @returns 四条 prefix 路由，顺序与搬出前一致。
 */
export function createSkillRoutes(ctx: Context, fence: HostLocalRouteFence): SkillRoute[] {
  const {
    guard, requireWriteProof, writeGuard, session, json,
    collectBody, readBodyLimited, hostLocale, gatewayError, passwordChangeRequired,
    clearSessionIfCurrent,
  } = fence
  const archiveTooLarge = (locale: HostLocale): string => archiveTooLargeError(locale)

  /**
   * 二进制/归档代理的网关失败分支（R15B-02 / R16B-08）。
   *
   * 这些路径直接用 `gatewayFetch` 拿 `Response`，不经过 `fetchJSON`，所以它们的
   * `!upstream.ok` 分支**没有**任何错误对象可判 —— 曾经一律回 `{error:'gateway error'}`。
   * 这里读一次错误信封（`clone()` 不消费原响应体）：
   *  - 命中"先改密"就与 `gatewayError` 走同一条出口；
   *  - **有信封就逐字透传**（状态 + 服务端原文 + 稳定码）；
   *  - 非 JSON / 空 body 才退回原兜底文案。
   *
   * R16B-08（2026-09-25）：修 R15B-02 时把"解析出来的信封只在改密那一支用、其余
   * 一律丢回 `'gateway error'`"当成"行为不变"，实际是把**已经拿到手的诊断信息丢掉**：
   * 能力中心那 6 条归档路径的失败于是只剩面板上那句「操作失败:gateway error」——
   * 状态码、稳定码、服务端原文全部消失，用户与支持都无法区分"令牌过期 / 没有权限 /
   * 版本不存在 / 服务端 500"。本仓既有口径是**业务信封原样透传**（`wasm-apps.ts` 的
   * `forwardAuthAware` 连字节都不重新序列化），这里照同一口径补上：`error` 放服务端
   * 原文（渲染层读的就是这个字符串字段），`code` 单列供分档。
   * @param res - 本地响应对象。
   * @param upstream - 网关响应。
   * @returns 已写出应答（调用方直接 return）。
   */
  const archiveUpstreamError = async (res: ServerResponse, upstream: Response): Promise<void> => {
    const envelope = await upstream.clone().json().catch(() => null) as { error?: { code?: string, message?: string } } | null
    const failure = envelope?.error
    if (failure?.code === PASSWORD_CHANGE_REQUIRED_CODE) {
      return passwordChangeRequired(res, failure.message ?? hostCopy(hostLocale(), '请先修改密码', 'Change your password first'))
    }
    if (typeof failure?.message === 'string' && failure.message.trim() !== '') {
      return json(res, upstream.status, {
        error: failure.message,
        ...(typeof failure.code === 'string' && failure.code !== '' ? { code: failure.code } : {}),
      })
    }
    // 非 JSON body（网关 HTML 错误页 / 空 body）：没有信封可透传，逐字保持原行为
    // —— 这一段正是既有回归里那条"非 JSON 对照"钉住的形态。
    json(res, upstream.status, { error: 'gateway error' })
  }
  const registrations: SkillRoute[] = [
      // Skill store proxy: /api/pico/skills (catalog), /archive (download),
      // and /install (verify + unpack into the user skill root), all
      // forwarded to the gateway. Method dispatch lives inside one handler:
      // the route table has no per-method matching.
    {
        kind: 'prefix', path: '/api/pico/skills',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname
          /**
           * **显式覆盖确认标记**（审计 2026-09-23 A2/A3/A15）。
           *
           * 面板在用户点过确认条之后才把 `?overwrite=1` 拼进 URL；宿主据此决定
           * 要不要拒绝"无确认的整树替换 / 删除本机内容"。契约（两端共用）：
           *  - 目标目录**不是**能力中心装的（无 provenance / 渠道非商店来源 /
           *    appId 对不上）⇒ 没有这个标记一律 409 `LOCAL_CONTENT`；
           *  - 目标目录是商店来源 ⇒ 不需要标记（正常更新/重装/卸载）。
           * ⚠️ 它与历史上的 `?force=1` **不是**一回事：那一个宿主从来没读过，
           * 是纯死面（R2-SK-5 记录在案）；这一个两端都必须读/写。
           */
          const overwrite = url.searchParams.get('overwrite') === '1'
          /**
           * **归属证明**这一个事实（2026-10 审计 C2-1；取值面 2026-10-04 收口）。
           *
           * 归属（`localOwnership`）是**本路由算不出来的**：技能库是机器作用域的
           * （`<DSH_HOME>/skills`，不按账号分目录），而"这一份算不算当前账号的"要靠
           * 聚合面那次 `/api/client/v2/capabilities?source=own` 的匹配（见
           * `/api/pico/capabilities` 里 `localOwnership` 的注释）—— 卸载是纯本地操作，
           * 不出网，所以由面板把那个事实带过来（与 `?overwrite=1` 同一条既有模式：
           * 面板给"宿主单独判不出的那个事实"）。
           *
           * **取值契约（三种，且只有三种）**：
           *  - `unknown` —— 面板明确报告"证明不了归属"（`localOwnership !== 'mine'`）⇒
           *    本次卸载**不写机器级墓碑**：删除照常生效，只是不再对"随包同步把所有
           *    账号都装回来"下永久判词（安全的失败模式）；
           *  - `mine` 与**缺省** —— 都表示"是当前账号的" ⇒ 照写墓碑。这两者**故意同义**，
           *    不是遗漏：`mine` 是本轮新加的可读写法，缺省是面板在 `localOwnership ===
           *    'mine'` 时与**旧客户端/工具面**共用的既有形态。"缺省 ⇒ 写墓碑"是
           *    R4-B-4（「卸载随包技能是持久终态」）的**已 spec 化承诺**，由
           *    `tests/skill-tombstone-ownership.spec.ts` 用例 ②/③ 与
           *    `tests/skill-overwrite-dirty.spec.ts` 的 R4-B-4 组钉住；
           *    **要把它翻成"缺省不写"必须先改产品口径**（那会反转上述承诺），
           *    不是本路由可以自行决定的事。
           *
           * **无法识别的取值必须 fail-loud**（400），不再静默当成缺省：静默接受拼错的
           * 提示（`?ownership=unkown`、大写、空串、未来版本的新值）会让调用方以为
           * "归属门生效了"，而宿主按最宽松的那一档执行 —— 一个拼写错误就静默变成
           * "写机器级墓碑"。只拒绝**非法值**：`mine`/`unknown`/缺省三种既有形态的
           * 语义一字未改。
           */
          const ownershipHint = url.searchParams.get('ownership')
          if (ownershipHint !== null && ownershipHint !== 'unknown' && ownershipHint !== 'mine') {
            return json(res, 400, {
              error: `unrecognized ownership hint: ${JSON.stringify(ownershipHint)} (want 'mine' or 'unknown')`,
              code: 'INVALID_OWNERSHIP',
            })
          }
          const localOwnership = ownershipHint === 'unknown' ? 'unknown' as const : undefined
          if (pathname === '/api/pico/skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/marketplace/skills', { token: s.token, locale: hostLocale(req) })
              // Augment the gateway catalog with the locally installed skill
              // names so the panel can render per-skill install state.
              const installed = await listInstalledSkills(resolveSkillsDir())
              json(res, 200, { ...data, installed })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // The session is no longer valid: clear it so the injected
                // tripwire reloads into the login page (M2).
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }
          // ---- 平台内置技能（随服务端镜像发布，客户端按需安装）----
          // 与市场/组织技能**共用同一条安装链路**（installSkillArchive：sha256
          // 对照 → 整树安全解包 → <dshHome>/skills），只换下载地址与来源标记。
          // 默认**不自动安装**：员工在能力中心点一次；清单里带 installed，界面
          // 据此显示「安装 / 已安装 / 更新到 vX」。
          if (pathname === '/api/pico/skills/builtin' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/skills/builtin', { token: s.token, locale: hostLocale(req) })
              const installed = await listInstalledSkills(resolveSkillsDir())
              json(res, 200, { ...data, installed })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              // 旧版服务端没有这条端点（404）：让面板把内置技能区整块隐藏，
              // 而不是显示一个空壳。原样透传状态码，不伪装成"没有内置技能"
              // （"伪装成空清单"会让运维永远查不出服务端少了这条路由）。
              if (cause instanceof ApiError && cause.status === 404) {
                return json(res, 404, { error: 'builtin skills unavailable' })
              }
              gatewayError(res, cause)
            }
            return
          }
          const builtinInstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/builtin\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (builtinInstallMatch !== null) {
            const name = decodePathSegment(builtinInstallMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/skills/builtin/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return await archiveUpstreamError(res, upstream)
              const length = Number(upstream.headers.get('content-length') ?? '0')
              if (length > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: 'archive too large' })
              }
              const archive = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (archive === null) return json(res, 413, { error: 'archive too large' })
              // 内置技能的这两个头不是可选项：内容是**我们自己的服务端**下发的，
              // 少了 checksum 就没有任何完整性凭据（skill-install 在没有该头时
              // 会静默跳过 sha256 对照），少了 version 就永远判不出「更新到 vX」。
              // 因此这里 fail-closed，而不是沿用市场通路那种"有就校验"的宽松口径。
              const checksum = upstream.headers.get('x-skill-checksum')
              const version = upstream.headers.get('x-skill-version')
              if (checksum === null || checksum === '' || version === null || version === '') {
                return json(res, 502, { error: 'builtin archive is missing its integrity headers; refused' })
              }
              const result = await installSkillArchive({
                name,
                archive,
                checksum,
                version,
                skillsDir: resolveSkillsDir(),
                // 溯源(D6)：标记为 builtin，与市场/组织区分开。
                channel: 'builtin',
                server: s.serverURL,
                // 覆盖本机同名自制内容必须由面板显式确认（审计 A2）。
                overwrite,
                // R18B-01：项目根（rank 100/200）排在落点（400）之前 —— 工作区里的
                // 同名技能会让"装好了"变成假象；R18B-04：清理/自愈日志走 ctx.logger。
                runtimeRoots: skillRuntimeRootsForHost(ctx, resolveSkillsDir()),
                log: skillInstallLogForHost(ctx),
                // R19B-09：拒绝文案按**本次请求**的语言取中英。
                locale: hostLocale(req),
              })
              json(res, 200, { ok: true, name: result.name, version: result.version })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              // 分类 + 脱敏 + 状态码的唯一实现（审计 A12/A13）：拒绝 422、
              // 需要确认 409、系统级错误 502 且文案里没有本机路径。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }
          // POST /api/pico/skills/builtin/:name/uninstall -> local removal.
          // 审计 2026-09-23 A6：内置技能此前**只能装不能卸**（没有这条路由），
          // 装完在「我的」里变成一张本地卡、只有「上传」按钮，产品内没有任何
          // 入口能移除它。与市场卸载同口径：本地删除 + 来源校验 + 显式确认。
          const builtinUninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/builtin\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (builtinUninstallMatch !== null) {
            const name = decodePathSegment(builtinUninstallMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            try {
              validateRuntimeSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              // Purely local operation — no gateway round-trip needed.
              await uninstallSkill(resolveSkillsDir(), name, {
                overwrite,
                serverURL: s.serverURL,
                localOwnership,
                runtimeRoots: skillRuntimeRootsForHost(ctx, resolveSkillsDir()),
                log: skillInstallLogForHost(ctx),
                // R19B-09：拒绝文案按**本次请求**的语言取中英。
                locale: hostLocale(req),
              })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodePathSegment(installMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/marketplace/skills/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return await archiveUpstreamError(res, upstream)
              const length = Number(upstream.headers.get('content-length') ?? '0')
              if (length > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: 'archive too large' })
              }
              // 审计 2026-08-25 P2-1:流式读取+上限(头可能被伪造/省略)。
              const archive = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (archive === null) return json(res, 413, { error: 'archive too large' })
              const checksum = upstream.headers.get('x-skill-checksum') ?? undefined
              const version = upstream.headers.get('x-skill-version') ?? undefined
              const result = await installSkillArchive({
                name,
                archive,
                checksum,
                version,
                skillsDir: resolveSkillsDir(),
                // 溯源(D6):记录渠道与来源服务端,客户端据此显示归属。
                channel: 'market',
                server: s.serverURL,
                // 覆盖本机同名自制内容必须由面板显式确认（审计 A2）。
                overwrite,
                // R18B-01 / R18B-04：见内置技能那条同类注释。
                runtimeRoots: skillRuntimeRootsForHost(ctx, resolveSkillsDir()),
                log: skillInstallLogForHost(ctx),
                // R19B-09：拒绝文案按**本次请求**的语言取中英。
                locale: hostLocale(req),
              })
              // 审计 2026-09-23 A11：**回传真实安装版本**。市场归档端点只按
              // "当前 approved 最高版"取（服务端不支持按版本安装），请求里带的
              // 版本号与真实落盘版本可能不同；面板据这里的 `version` 记账，而不是
              // 据"用户点的那一个版本"。
              json(res, 200, { ok: true, name: result.name, version: result.version })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              // 分类 + 脱敏 + 状态码的唯一实现（拒绝 422 / 需确认 409 / 系统级 502）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodePathSegment(uninstallMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            try {
              validateRuntimeSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              // Purely local operation — no gateway round-trip needed.
              // `overwrite` = 用户已确认删除本机自制内容（审计 A3）。
              await uninstallSkill(resolveSkillsDir(), name, {
                overwrite,
                serverURL: s.serverURL,
                localOwnership,
                // R18B-01：卸载的"成功"必须等于"运行时不再加载"——项目根（rank 100/200）
                // 也在已知根里；R18B-04：清理/自愈日志走 ctx.logger。
                runtimeRoots: skillRuntimeRootsForHost(ctx, resolveSkillsDir()),
                log: skillInstallLogForHost(ctx),
                // R19B-09：拒绝文案按**本次请求**的语言取中英。
                locale: hostLocale(req),
              })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }
          const archiveMatch = req.method === 'GET'
            ? /^\/api\/pico\/skills\/([^/]+)\/archive$/u.exec(pathname)
            : null
          if (archiveMatch === null) return json(res, 404, { error: 'not found' })
          const name = decodePathSegment(archiveMatch[1])
          if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
          // B8(2026-09-01):归档下载分支此前未校验 name——解码后的名字会
          // 原样拼进 Content-Disposition(如 %22 → `"` 产生畸形头)。与
          // install/uninstall 分支对齐,先验名再放行。
          try {
            validateSkillName(name)
          } catch (cause) {
            return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
          }
          try {
            const upstream = await gatewayFetch(
              `${normalizeServerURL(s.serverURL)}/api/client/v2/marketplace/skills/${encodeURIComponent(name)}/archive`,
              { headers: { Authorization: `Bearer ${s.token}` } },
            )
            if (!upstream.ok) return await archiveUpstreamError(res, upstream)
            // P1-12: bound the download like the install path — a huge or
            // anomalous archive must not be buffered into memory wholesale.
            const declared = upstream.headers.get('content-length')
            if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
            }
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
            }
            // Pass through the upstream integrity headers (M3): the server
            // signs archives with X-Skill-Checksum / X-Skill-Version.
            const headers: Record<string, string> = {
              'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
              'Content-Length': String(content.length),
            }
            const disposition = upstream.headers.get('content-disposition')
            headers['Content-Disposition'] = disposition ?? `attachment; filename="${name}.zip"`
            for (const key of ['x-skill-checksum', 'x-skill-version']) {
              const value = upstream.headers.get(key)
              if (value !== null) headers[key] = value
            }
            res.writeHead(200, headers)
            res.end(content)
          } catch (cause) {
            if (cause instanceof AuthError && cause.kind === 'auth_expired') {
              // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
              clearSessionIfCurrent(s.token)
              return json(res, 401, { error: 'auth expired' })
            }
            gatewayError(res, cause)
          }
        },
    },

      // Shared-agent proxy: /api/pico/agent-presets (list + upload + install
      // + uninstall + archive). Uploads pack a locally authored preset (the
      // 创造模式 roster's user root) and forward the archive to the gateway;
      // installs download an approved archive, verify it, and unpack it into
      // the same root so the upstream roster discovers it.
    {
        kind: 'prefix', path: '/api/pico/agent-presets',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const presetsDir = resolvePresetsDir()
          /**
           * 覆盖/删除本机自制内容的显式确认标记（审计 2026-09-23 N2）。
           *
           * 与技能侧**同一份契约**（`/api/pico/skills*`、`/api/pico/shared-skills*`）：
           * 面板只在用户点过确认条 / 卸载第二段确认之后才把 `?overwrite=1` 拼进 URL。
           * 此前这条路由**不读任何 query**，而 `installPresetArchive` 对已存在目录
           * 一律拒收 ⇒ 面板的「更新智能体」必然失败（`preset "x" already exists locally`），
           * 同名的覆盖确认整条是死面。
           */
          const overwrite = new URL(req.url ?? '/', 'http://localhost').searchParams.get('overwrite') === '1'

          // GET /api/pico/agent-presets -> gateway catalog + installed + local.
          if (pathname === '/api/pico/agent-presets' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/agent-presets', { token: s.token, locale: hostLocale(req) })
              const installed = await listInstalledPresets(presetsDir)
              const local = await mapLocalPresets(presetsDir, data.presets ?? [])
              json(res, 200, { ...data, installed, local })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }

          // POST /api/pico/agent-presets/upload { name } -> pack + gateway.
          if (pathname === '/api/pico/agent-presets/upload' && req.method === 'POST') {
            // 审计 2026-08-25 P2-2:body 上限(本地 body 仅元数据,24MB 兼容上限)。
            const raw = await collectBody(req, UPLOAD_BODY_BYTES).catch(() => null)
            if (raw === null) return json(res, 413, { error: 'body too large' })
            let body: { name?: unknown }
            try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            if (name === '') return json(res, 400, { error: 'missing name' })
            try {
              const packed = await packPreset(presetsDir, name)
              const gateway = await fetchJSON(s.serverURL, '/api/client/v2/agent-presets', {
                token: s.token,
                locale: hostLocale(req),
                method: 'POST',
                body: {
                  name: packed.name,
                  // Display title travels with the archive so the review
                  // board and the shared library show the friendly name
                  // (not the directory id).
                  ...packed.displayName === undefined ? {} : { display_name: packed.displayName },
                  ...packed.description === undefined ? {} : { description: packed.description },
                  archive: packed.archive.toString('base64'),
                },
                timeoutMs: 30000,
              })
              json(res, 200, { ok: true, preset: gateway.preset })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              if (cause instanceof ApiError) {
                // Gateway envelope: surface its human-readable message with
                // the code-appropriate status (NAME_TAKEN→409, PENDING_LIMIT→429).
                // 2026-09-02:透传服务端原始状态码(不再一律 422)——归属/锁定/
                // 版本冲突各有语义(409/403)。
                // 2026-09-23(第五轮 R5-B-1 跨泳道):**同时透传稳定错误码** ——
                // 状态码不是一个可判定的判据(409 同时是 NAME_TAKEN / VERSION_* /
                // CONFLICT / ARCHIVE_CLEARED / APP_DELISTED),面板按 code 才能把
                // 「已下架冻结」与「重名」分开说(见 uploadFailureText)。
                const status = cause.status ?? (cause.code === 'PENDING_LIMIT' ? 429
                  : cause.code === 'NAME_TAKEN' || cause.code.startsWith('VERSION_') ? 409
                    : cause.code === 'APP_LOCKED' ? 403
                      : cause.code === 'NOT_FOUND' ? 404
                        : 422)
                return json(res, status, { error: cause.message, code: cause.code })
              }
              // 打包/预检失败：分类 + 脱敏由 skill-install 统一给（拒绝 = 422，
              // 归档过大 = 413，系统级 = 502 且文案里不含本机路径）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }

          // POST /api/pico/agent-presets/:name/install -> download + verify + unpack.
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodePathSegment(installMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            try {
              validatePresetId(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/agent-presets/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return await archiveUpstreamError(res, upstream)
              const declared = upstream.headers.get('content-length')
              if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const checksum = upstream.headers.get('x-preset-checksum') ?? undefined
              const presetVersion = upstream.headers.get('x-preset-version') ?? undefined
              await installPresetArchive({
                name, archive: content, checksum, presetsDir,
                // 溯源(D6):与技能同构,记录版本/渠道/来源服务端。
                version: presetVersion, channel: 'org', server: s.serverURL,
                // 覆盖确认（审计 2026-09-23 N2）：与技能同一条 `?overwrite=1` 契约。
                overwrite,
              })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              // 分类 + 脱敏 + 状态码走**唯一实现**（审计 2026-09-23 A12：这里此前
              // 是裸分类 + 原文，系统级 errno 会把本机绝对路径透给 UI）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }

          // POST /api/pico/agent-presets/:name/uninstall -> local removal.
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodePathSegment(uninstallMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            try {
              // 与技能同口径（审计 A3/N2）：本机自制内容没有 `?overwrite=1` 一律拒收。
              // R19A-S2-04：来源判据同样带"当前会话的服务端"（缺地址 ⇒ 保守）。
              await uninstallPreset(presetsDir, name, { overwrite, serverURL: s.serverURL })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }

          // GET /api/pico/agent-presets/:name/archive -> passthrough download.
          const archiveMatch = req.method === 'GET'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/archive$/u.exec(pathname)
            : null
          if (archiveMatch === null) return json(res, 404, { error: 'not found' })
          const name = decodePathSegment(archiveMatch[1])
          if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
          // B8(2026-09-01):与 install/uninstall 对齐,归档下载分支先验名再拼
          // Content-Disposition(此前解码后的 quote 会产出畸形头)。
          try {
            validatePresetId(name)
          } catch (cause) {
            return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
          }
          try {
            const upstream = await gatewayFetch(
              `${normalizeServerURL(s.serverURL)}/api/client/v2/agent-presets/${encodeURIComponent(name)}/archive`,
              { headers: { Authorization: `Bearer ${s.token}` } },
            )
            if (!upstream.ok) return await archiveUpstreamError(res, upstream)
            const declared = upstream.headers.get('content-length')
            if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
            }
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
            }
            const headers: Record<string, string> = {
              'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
              'Content-Length': String(content.length),
            }
            const disposition = upstream.headers.get('content-disposition')
            headers['Content-Disposition'] = disposition ?? `attachment; filename="${name}.zip"`
            for (const key of ['x-preset-checksum', 'x-preset-version']) {
              const value = upstream.headers.get(key)
              if (value !== null) headers[key] = value
            }
            res.writeHead(200, headers)
            res.end(content)
          } catch (cause) {
            if (cause instanceof AuthError && cause.kind === 'auth_expired') {
              // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
              clearSessionIfCurrent(s.token)
              return json(res, 401, { error: 'auth expired' })
            }
            gatewayError(res, cause)
          }
        },
    },

      // Shared-skill proxy: /api/pico/shared-skills (list + upload + install
      // + uninstall). Lists the gateway's shared store (approved versions),
      // the local skill root (disk), and the installed set; uploads pack a
      // locally authored skill directory and forward it; installs download an
      // approved archive, verify it, and unpack it into the user skill root.
    {
        kind: 'prefix', path: '/api/pico/shared-skills',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const sharedUrl = new URL(req.url ?? '/', 'http://localhost')
          const pathname = sharedUrl.pathname
          // 显式覆盖确认标记：审计 A2/A3/A15 的两端契约，见 /api/pico/skills 分支的注释。
          const overwrite = sharedUrl.searchParams.get('overwrite') === '1'
          const skillsDir = resolveSkillsDir()

          if (pathname === '/api/pico/shared-skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/shared-skills', { token: s.token, locale: hostLocale(req) })
              const installed = await listInstalledSkills(skillsDir)
              const local = await listLocalSkills(skillsDir)
              json(res, 200, { ...data, installed, local })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }

          if (pathname === '/api/pico/shared-skills/upload' && req.method === 'POST') {
            // 审计 2026-08-25 P2-2:body 上限(本地 body 仅元数据,24MB 兼容上限)。
            const raw = await collectBody(req, UPLOAD_BODY_BYTES).catch(() => null)
            if (raw === null) return json(res, 413, { error: 'body too large' })
            let body: { name?: unknown; version?: unknown }
            try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            // 版本号不再由代理兜底 '1.0.0':以包内 SKILL.md 的 version 为准
            // (决策 2026-09-01「包内即真相」)。此前的硬编码让服务端永远只
            // 看到 1.0.0,「版本必须递增/不可复用」在链路上无从判断。
            const version = typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : undefined
            if (name === '') return json(res, 400, { error: 'missing name' })
            try {
              const packed = await packSkill(skillsDir, name, version, hostLocale(req))
              const gateway = await fetchJSON(s.serverURL, '/api/client/v2/shared-skills', {
                token: s.token,
                locale: hostLocale(req),
                method: 'POST',
                body: {
                  name: packed.name,
                  ...packed.displayName === undefined ? {} : { display_name: packed.displayName },
                  version: packed.version,
                  ...packed.description === undefined ? {} : { description: packed.description },
                  archive: packed.archive.toString('base64'),
                },
                timeoutMs: 30000,
              })
              json(res, 200, { ok: true, skill: gateway.skill })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              if (cause instanceof ApiError) {
                // 2026-09-02:透传服务端原始状态码(不再一律 422)——归属/锁定/
                // 版本冲突各有语义(409/403),客户端按状态码分别提示。
                // 2026-09-23(第五轮 R5-B-1 跨泳道):**同时透传稳定错误码** ——
                // 409 是多个码共用的状态,面板必须按 code 才能把「已下架冻结」
                // (APP_DELISTED)与「重名」(NAME_TAKEN)分开说,与 agent-presets
                // 那条上传代理逐字同形。
                const status = cause.status ?? (cause.code === 'PENDING_LIMIT' ? 429
                  : cause.code === 'NAME_TAKEN' || cause.code.startsWith('VERSION_') ? 409
                    : cause.code === 'APP_LOCKED' ? 403
                      : cause.code === 'NOT_FOUND' ? 404
                        : 422)
                return json(res, status, { error: cause.message, code: cause.code })
              }
              // 打包/预检失败：分类 + 脱敏由 skill-install 统一给（拒绝 = 422，
              // 归档过大 = 413，系统级 = 502 且文案里不含本机路径）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }

          // POST /api/pico/shared-skills/:name/:version/install -> download + verify + unpack.
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/shared-skills\/([^/]+)\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodePathSegment(installMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            const version = decodePathSegment(installMatch[2])
            if (version === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/shared-skills/${encodeURIComponent(name)}/${encodeURIComponent(version)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return await archiveUpstreamError(res, upstream)
              const declared = upstream.headers.get('content-length')
              if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const checksum = upstream.headers.get('x-skill-checksum') ?? undefined
              const ver = upstream.headers.get('x-skill-version') ?? version
              const result = await installSkillArchive({
                name,
                archive: content,
                checksum,
                skillsDir,
                version: ver,
                channel: 'org',
                server: s.serverURL,
                // 覆盖本机同名自制内容必须由面板显式确认（审计 A2）。
                overwrite,
                // R18B-01 / R18B-04：见内置技能那条同类注释。
                runtimeRoots: skillRuntimeRootsForHost(ctx, skillsDir),
                log: skillInstallLogForHost(ctx),
                // R19B-09：拒绝文案按**本次请求**的语言取中英。
                locale: hostLocale(req),
              })
              // 真实落盘版本以响应为准（审计 A11：请求里的版本可能被服务端忽略）。
              json(res, 200, { ok: true, name, version: result.version ?? ver })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
                clearSessionIfCurrent(s.token)
                return json(res, 401, { error: 'auth expired' })
              }
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }

          // POST /api/pico/shared-skills/:name/:version/uninstall -> local removal.
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/shared-skills\/([^/]+)\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodePathSegment(uninstallMatch[1])
            if (name === null) return json(res, 400, { error: 'invalid path encoding', code: 'INVALID_PATH' })
            // 名字先于安装器校验（R4-B-6）：另外三条写面
            // （`/api/pico/skills/:name/{install,uninstall}`、
            // `/api/pico/skills/builtin/:name/{install,uninstall}`）都在进安装器**之前**
            // 校验名字并回 400 —— 只有这一条把校验留给 `uninstallSkill`
            // 内部抛，于是同一个客户端面板对同一类输入看到 422 + code（走
            // `describeArchiveFailure` 的 typed 分支）。非法名是**请求有问题**，
            // 不是"内容有问题"：与三条兄弟分支对齐到 400（状态码语义唯一）。
            // R21-A1-04：三条**卸载**面的判据是 `validateRuntimeSkillName`
            // （与运行时/发现面同一条：只判 kebab 正则、**不设**写侧 64 字符上限），
            // 否则 >64 字符的技能"列得出、删不掉"。
            try {
              validateRuntimeSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              await uninstallSkill(skillsDir, name, {
                overwrite,
                serverURL: s.serverURL,
                // R18B-01：卸载的"成功"必须等于"运行时不再加载"——项目根（rank 100/200）
                // 也在已知根里；R18B-04：清理/自愈日志走 ctx.logger。
                runtimeRoots: skillRuntimeRootsForHost(ctx, skillsDir),
                log: skillInstallLogForHost(ctx),
                // R19B-09：拒绝文案按**本次请求**的语言取中英。
                locale: hostLocale(req),
              })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }

          return json(res, 404, { error: 'not found' })
        },
    },

      // Capability catalog proxy: /api/pico/capabilities (list).
      // Aggregates the gateway's unified catalog (market skills + org shared
      // skills + shared agents) and unions local-disk state: installed set,
      // installed version (best-effort from frontmatter/metadata), and the
      // locally authored rows (for the 「我的」 partition).
    {
        kind: 'prefix', path: '/api/pico/capabilities',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          if (pathname !== '/api/pico/capabilities' || req.method !== 'GET') {
            return json(res, 404, { error: 'not found' })
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const source = url.searchParams.get('source')
          if (source !== 'market' && source !== 'org' && source !== 'local') {
            return json(res, 400, { error: 'invalid source' })
          }
          try {
            const skillsDir = resolveSkillsDir()
            const presetsDir = resolvePresetsDir()
            // 本地创作分区的状态匹配:服务端 ?source=own 返回 author-own
            // 任意状态(含 pending/rejected + 拒因)——用 own 结果匹配本地
            // 上传行的 status/reason(2026-09-01 契约修复:此前匹配 org 而
            // org 仅含 approved,本地行状态徽章恒空)。
            const matchSource = source === 'local' ? 'own' : source
            const data = await fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=${encodeURIComponent(matchSource)}`, { token: s.token, locale: hostLocale(req) })
            const items = (data as { items?: Array<Record<string, unknown>> }).items ?? []
            const installedSkills = new Set(await listInstalledSkills(skillsDir))
            const installedPresets = new Set(await listInstalledPresets(presetsDir))
            const localSkills = await listLocalSkills(skillsDir)
            const localPresets = await listLocalPresets(presetsDir)
            // installedVersion:优先读安装器写的 .install-version 标记
            // (可靠);否则退回 SKILL.md frontmatter 的 version(best-effort)。
            const localSkillVersions = new Map<string, string | undefined>()
            /** 本机那一份的来源：'store'（能力中心装的）/'local'（用户自制）——审计 A2/A3。 */
            const skillOrigins = new Map<string, 'store' | 'local'>()
            const presetOrigins = new Map<string, 'store' | 'local'>()
            // 审计 2026-09-12 P1-6:共享 Agent 的已装版本此前**恒为 undefined**
            // (`kind === 'skill' ? localSkillVersions.get(name) : undefined`),而
            // 客户端 `hasUpdateFor()` 一见 undefined 就返回 false ⇒ 能力中心
            // 对共享 Agent 永远不显示「更新到 vX」。版本事实在磁盘上是有的:
            // agent-preset-install.ts 的安装器与技能一样写了
            // `.picoaide/release.json`(provenance),这里按 kind 选 map。
            const localPresetVersions = new Map<string, string | undefined>()
            // 溯源(D6):优先读 .picoaide/release.json(应用 ID/渠道/版本 +
            // 安装时内容哈希),回退旧 .install-version 标记;并重算当前内容
            // 哈希判定「是否被本地修改过」。
            const provenance = new Map<string, { appId: string, channel: string, version: string, dirty: boolean, originServer?: string }>()
            for (const r of localSkills) {
              const dir = join(skillsDir, r.name)
              const prov = await readProvenance(dir)
              // 来源判定（审计 A2/A3）：面板据 installedOrigin 决定"更新/卸载要不要确认"。
              // 与安装器/卸载器的判据同一份实现（isStoreProvenance）。
              skillOrigins.set(r.name, isStoreProvenance(prov, r.name, s.serverURL) ? 'store' : 'local')
              if (prov !== undefined) {
                // R4-B-3：dirty 的**唯一实现**在安装器里（isInstalledSkillDirty）——
                // 面板的徽章与宿主的覆盖/删除闸门必须消费同一份事实，否则会出现
                // "面板显示「已本地修改」、宿主放行整树覆盖"的两端漂移。
                const dirty = await isInstalledSkillDirty(dir, prov)
                // R17B-04：来源服务端与当前会话不同 ⇒ 把那一台透出给面板（徽章），
                // 归属判据本身已由 isStoreProvenance 的服务端维度接管（越权更新/删除
                // 会走 LOCAL_CONTENT 确认条）。判据比较只有一处实现，这里只搬事实。
                const foreignServer = isForeignServerProvenance(prov, s.serverURL) ? prov.server : undefined
                provenance.set(r.name, {
                  appId: prov.appId,
                  channel: prov.channel,
                  version: prov.version,
                  dirty,
                  ...foreignServer === undefined ? {} : { originServer: foreignServer },
                })
                localSkillVersions.set(r.name, prov.version !== '' ? prov.version : r.version)
                continue
              }
              const marker = join(dir, INSTALL_VERSION_FILE)
              const mv = await readFile(marker, 'utf8').then(s => s.trim()).catch(() => undefined)
              localSkillVersions.set(r.name, mv ?? r.version)
            }
            // 共享 Agent 同上:provenance(.picoaide/release.json)优先,回退
            // `.install-version`。preset.yml 没有 version 字段,所以没有
            // 「frontmatter 兜底」这一层——读不到就留 undefined,由客户端
            // hasUpdateFor 保守判 false(宁可不提示,不可误报)。
            for (const l of localPresets) {
              const dir = join(presetsDir, l.name)
              const v = await readInstalledPresetVersion(dir)
              if (v !== undefined) localPresetVersions.set(l.name, v)
              // 与技能同一份来源判据（共享 Agent 的 provenance 同格式）。
              presetOrigins.set(l.name, isStoreProvenance(await readProvenance(dir), l.name, s.serverURL) ? 'store' : 'local')
            }

            // 本地创作行(我的分区):磁盘上存在的技能/预设,带上传状态(若在
            // 服务端 catalog 里存在同名同 kind 的行,则取其 status——本机
            // 作者是自己的上传,服务端 ListVisible* 已含 author-own 任意状态)。
            const localRows: Array<Record<string, unknown>> = []
            for (const l of localSkills) {
              const match = items.find(i => (i as { kind?: string }).kind === 'skill' && (i as { name?: string }).name === l.name)
              const prov = provenance.get(l.name)
              localRows.push({
                kind: 'skill', source: 'local', name: l.name, displayName: l.displayName ?? l.name,
                // 运行时名 = SKILL.md 的 name(上游据它注册技能),与目录名不同时
                // 面板会显式提示,避免「装完才知道该 @ 什么」。
                runtimeName: l.displayName ?? l.name,
                version: prov?.version !== undefined && prov.version !== '' ? prov.version : (l.version ?? '1.0.0'),
                description: l.description ?? '', author: '',
                // 归属与本地改动(D6):面板据此显示「来自市场 · vX · 已本地修改」。
                // R17B-04：`originServer` 只在"来源服务端 ≠ 当前会话服务端"时下发 ——
                // 面板据此渲染「来自另一台服务端」徽章（判据比较在 isStoreProvenance /
                // isForeignServerProvenance 里，这里只透传事实）。
                ...prov === undefined ? {} : { originChannel: prov.channel, originAppId: prov.appId, dirty: prov.dirty },
                ...prov?.originServer === undefined ? {} : { originServer: prov.originServer },
                // 本机那一份的来源（审计 A2/A3）。builtin/plugin 的本地行靠它渲染「卸载」。
                installedOrigin: skillOrigins.get(l.name) ?? 'local',
                status: match !== undefined ? (match as { status?: string }).status : undefined,
                reason: match !== undefined ? (match as { reason?: string }).reason : undefined,
                versions: [], isLocal: true, uploadStatus: match !== undefined ? (match as { status?: string }).status : undefined,
                // 下架标记（第五轮审计 R5-B-1，2026-09-23 追加授权）：服务端在**作者自己的行**
                // 上下发权威字段 `delisted`（`capabilities.CapabilityItem.Delisted`，见
                // server/internal/capabilities/capabilities.go）。它必须与 status/reason 一起
                // 透传到本机行 —— 否则"下架"这个状态在面板上**永远看不到**：本机自制行没有
                // 商店溯源、服务端也不下发 `enabled`，客户端自己推不出来（这正是本条 finding
                // 作者面的成因）。无匹配行时不写这个键（未知 ≠ 未下架；JSON 序列化会丢掉
                // undefined，面板读到的是"服务端没说"）。
                delisted: match !== undefined && (match as { delisted?: unknown }).delisted === true ? true : undefined,
                // 归属判据（第六轮审计 R6-B-1）：**本机这一份算不算当前账号的**。
                // 技能库是机器作用域的（`<DSH_HOME>/skills`，不按账号分目录），同机换号
                // 被支持 ⇒ 磁盘上这一份可能是**别的账号**装的。宿主能证明的只有一件事：
                // 服务端 `?source=own`（author-own 任意状态）里有没有同名同 kind 的行 ——
                // 有 ⇒ 这个名字属于当前账号（`'mine'`）；没有 ⇒ 证明不了（`'unknown'`，
                // 既可能是别人装的、也可能是我装的别人的内容）。
                // ⚠️ 面板据此**禁止**对 `'unknown'` 的行给出"删除本机那一份"的动作
                // （见 CapabilityCenterPanel 的 `isDelistedItem` 第 3 条）—— 那是一个
                // 跨账号的破坏性动作。**不发 `'other'`**：没有任何事实能证明"是第三方装的"。
                localOwnership: match !== undefined ? 'mine' : 'unknown',
                // R17B-01：库根里的符号链接形态（运行时会加载，但打包/上传入口有意
                // 拒收）——面板据此不给「上传」按钮，改标"符号链接（只读）"。
                ...l.symlink === true ? { originSymlink: true } : {},
              })
            }
            for (const l of localPresets) {
              const match = items.find(i => (i as { kind?: string }).kind === 'agent' && (i as { name?: string }).name === l.name)
              const dir = join(presetsDir, l.name)
              const prov = await readProvenance(dir)
              // 与技能同一份 dirty 判据（唯一实现在安装器里，R4-B-3）。
              const dirty = await isInstalledSkillDirty(dir, prov)
              localRows.push({
                kind: 'agent', source: 'local', name: l.name, displayName: l.displayName ?? l.name,
                version: prov?.version !== undefined && prov.version !== '' ? prov.version : '1.0.0',
                description: l.description ?? '', author: '',
                ...prov === undefined ? {} : { originChannel: prov.channel, originAppId: prov.appId, dirty },
                installedOrigin: presetOrigins.get(l.name) ?? 'local',
                status: match !== undefined ? (match as { status?: string }).status : undefined,
                reason: match !== undefined ? (match as { reason?: string }).reason : undefined,
                versions: [], isLocal: true, uploadStatus: match !== undefined ? (match as { status?: string }).status : undefined,
                // 与技能面同一条透传（R5-B-1）：智能体预设的作者行同样带服务端下发的 delisted。
                delisted: match !== undefined && (match as { delisted?: unknown }).delisted === true ? true : undefined,
                // 与技能面同一条归属判据（R6-B-1，逐字同源）：预设目录同样是机器作用域的
                // （`<DSH_HOME>/.agent-presets`），证明不了归属就不允许面板给删除动作。
                localOwnership: match !== undefined ? 'mine' : 'unknown',
              })
            }

            if (source === 'local') {
              // 「我的」定案(2026-09-04):已安装(商店渠道/其他) + 本地制作。
              // 已安装商店行取自 market+org 目录(installed=true 的行),
              // originChannel/provenance 已在上游 enriched 计算。
              if (localRows.length > 0 || true) {
                // 审计 R21-A2-04：这两发此前是 `.catch(() => ({ items: [] }))` ——
                // 服务端读不到（5xx/网络/超时）时**静默丢掉**全部已装商店行与
                // "更新到 vX"徽章，而分区状态仍是 ok（界面把"服务端读不到"说成
                // "你没装过商店技能"）。现在只把**确定不存在**（404：旧版服务端/
                // 该来源未启用）当成空集，其余原样抛给下面的 gatewayError
                // （如实报错 + 面板可重试）。
                const storeCatalog = async (source: 'market' | 'org'): Promise<unknown> => {
                  try {
                    return await fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=${source}`, { token: s.token, locale: hostLocale(req) })
                  } catch (cause) {
                    if (cause instanceof ApiError && cause.status === 404) {
                      ctx.logger?.warn(`[pico] capabilities source=${source} is not available on this server (404); treated as empty`)
                      return { items: [] }
                    }
                    throw cause
                  }
                }
                const [mkt, org] = await Promise.all([storeCatalog('market'), storeCatalog('org')])
                const storeInstalled = [...(mkt as { items?: Array<Record<string, unknown>> }).items ?? [], ...(org as { items?: Array<Record<string, unknown>> }).items ?? []]
                  .filter((i) => {
                    const kind = (i as { kind?: string }).kind ?? ''
                    const name = (i as { name?: string }).name ?? ''
                    return kind === 'skill' ? installedSkills.has(name) : installedPresets.has(name)
                  })
                  .map((i) => ({
                    ...i,
                    source: (i as { source?: string }).source ?? 'market',
                    displayName: ((i as { display_name?: string }).display_name ?? i.name) as string,
                    installed: true,
                    // 审计 2026-09-12 P1-6:`?source=local` 的商店行此前**不带**
                    // installedVersion ⇒ 面板 hasUpdateFor 恒 false,「更新到 vX」
                    // 对已装共享 Agent 永不出现(与 enriched 分支同源修复)。
                    installedVersion: installedVersionFor(
                      (i as { kind?: string }).kind ?? '',
                      (i as { name?: string }).name ?? '',
                      localSkillVersions,
                      localPresetVersions,
                    ),
                    // 来源（审计 A2/A3）：与 enriched 分支同源（同一个 helper）。
                    installedOrigin: installedOriginFor(
                      (i as { kind?: string }).kind ?? '',
                      (i as { name?: string }).name ?? '',
                      skillOrigins,
                      presetOrigins,
                    ),
                    // 2026-09-02 归属权 + 第四轮 R4-B-14：`is_owner` **必须**在这里也透出。
                    // 面板的上传预检是 `clash.isOwner !== true ⇒ 直接提示「名称已被占用」、
                    // 不发请求`（CapabilityCenterPanel 的 upload()），而它扫的是当前
                    // `items`。市场分区取数失败/未回来时（applySectionRows 会丢掉旧的
                    // 非本地行），「我的」里只剩这一份**没有 isOwner** 的商店行 ⇒ 作者上传
                    // **自己的**技能被本地预检挡住。字段来自服务端
                    // `capabilities.CapabilityItem.IsOwner`（json: is_owner），两边同源。
                    isOwner: (i as { is_owner?: boolean }).is_owner ?? false,
                    // 0059 官方字段透传(与 enriched 同构)。
                    official: (i as { official?: boolean }).official ?? false,
                    downloads: Number((i as { downloads?: number }).downloads ?? 0),
                    calls: Number((i as { calls?: number }).calls ?? 0),
                    score: Number((i as { score?: number }).score ?? 0),
                  }))
                return json(res, 200, { items: [...storeInstalled, ...localRows] })
              }
              return json(res, 200, { items: localRows })
            }

            // 已装版本:best-effort。技能 = provenance/.install-version →
            // SKILL.md frontmatter;共享 Agent = provenance/.install-version
            // (preset.yml 无 version 字段,故无 frontmatter 兜底)。客户端
            // `hasUpdateFor()` 依赖这里的 installedVersion:undefined ⇒ 恒 false。
            const enriched = items.map(i => {
              const kind = i.kind as string
              const name = i.name as string
              const installed = kind === 'skill' ? installedSkills.has(name) : installedPresets.has(name)
              const installedVersion = installedVersionFor(kind, name, localSkillVersions, localPresetVersions)
              return {
                ...i,
                // 服务端为 snake_case(display_name 等),客户端读驼峰
                // displayName——统一在此映射,避免卡片标题恒等于 name、
                // 搜索/归并失效(2026-09-01 深挖)。
                displayName: (i as { display_name?: string; displayName?: string }).displayName
                  ?? (i as { display_name?: string }).display_name
                  ?? i.name,
                // 2026-09-02 归属权:is_owner 由服务端按 apps.owner 计算,
                // 客户端上传预检依赖它(「我的」与「他人」同名区分)。
                isOwner: (i as { is_owner?: boolean }).is_owner ?? false,
                // 0059 官方机制:蓝标 + 市场排序评分(score 由服务端计算)。
                official: (i as { official?: boolean }).official ?? false,
                downloads: Number((i as { downloads?: number }).downloads ?? 0),
                calls: Number((i as { calls?: number }).calls ?? 0),
                score: Number((i as { score?: number }).score ?? 0),
                installed,
                installedVersion,
                // 来源（审计 A2/A3）：只对"本机真的装了"的行给，未装时 undefined。
                installedOrigin: installed ? installedOriginFor(kind, name, skillOrigins, presetOrigins) : undefined,
                hasUpdate: false, // 客户端按 versions 与 installedVersion 计算
              }
            })
            json(res, 200, { items: enriched })
          } catch (cause) {
            if (cause instanceof AuthError && cause.kind === 'auth_expired') {
              // R22-V1-N3：只清"发起这次请求时的那一个会话"（迟到 401 不得清掉新登录）。
              clearSessionIfCurrent(s.token)
              return json(res, 401, { error: 'auth expired' })
            }
            gatewayError(res, cause)
          }
        },
    },
  ]
  return registrations
}
