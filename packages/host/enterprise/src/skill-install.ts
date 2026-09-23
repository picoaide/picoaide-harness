/**
 * Skill archive installation: download-side verification and safe unpacking
 * into the user skill root (`<dshHome>/skills/<name>`), which the upstream
 * `@deepseek-ai/dsh-skill-filesystem` provider watches and auto-discovers.
 *
 * Security posture (matches the connector-store review):
 * - archive bytes are bounded (`MAX_ARCHIVE_BYTES`) before any unpacking;
 * - the unpacked tree is bounded (`MAX_UNPACKED_BYTES`) via a dry-run
 *   listing pass;
 * - every tar entry path must stay inside the staging directory: absolute
 *   paths, `..` segments, and symbolic/hard links are rejected;
 * - when the gateway supplies `x-skill-checksum` (sha256 hex), the archive
 *   must match it or installation is refused;
 * - the staged tree is moved into place with a same-filesystem rename after
 *   the SKILL.md check, and an existing target directory is replaced only
 *   after the new tree is fully verified.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { assertArchiveSafe, archiveFormat, extractTar, extractZip, MAX_ARCHIVE_BYTES } from './archive-util.ts'
import { precheckSkillPackage } from './manifest-precheck.ts'
import { DEFAULT_HOST_LOCALE, hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'

/**
 * 运行时技能名规则 —— **单一真源指向上游**：
 * `deepseek-harness/packages/skill/skill/src/index.ts` 的 `SKILL_NAME`（导出为
 * `isSkillName`）。它不是"我们选的规则"，而是运行时**真正用它决定加载与否**的
 * 那一条：frontmatter `name` 不匹配的 SKILL.md 会被 `skill-filesystem` 静默忽略
 * （`ignored: invalid skill name`），界面上却什么都看不出来。
 *
 * 独立审计 2026-09-23 A1 实测的形态：安装器此前用 `[a-z0-9][a-z0-9._-]{0,63}`
 * （只保证"是一个安全的目录段"），于是 `my.skill` / `my_skill` / `alpha--beta`
 * 全都**安装成功但永远加载不到**。安装器是这条链上最宽的一道门，必须与运行时
 * 逐字一致 —— 谁要放宽它，先改运行时。
 *
 * 变异验证：把它改回 `[a-z0-9][a-z0-9._-]{0,63}` ⇒
 * `skill-install.spec.ts` 的「名字规则与上游 isSkillName 逐字一致」必红。
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * 目录段长度上限（64）。上游正则本身不限长，但目录名要落到用户家目录里，
 * 与服务端应用 ID 的上限（`skillmanifest` 的 maxAppId=64）保持一致。
 */
export const MAX_SKILL_NAME_LENGTH = 64

/** 是否是运行时可加载的技能名（目录名与 frontmatter name 都用它）。 */
export function isLoadableSkillName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(name)
}

/** Validate a skill name for use as a single directory segment. */
export function validateSkillName(name: string): string {
  if (!isLoadableSkillName(name)) {
    throw new ArchiveInstallRefusal('NAME_INVALID', `invalid skill name ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * 安装器自己的**拒绝类**错误：文案已经面向用户、且**不含本机路径**，
 * 因此 {@link describeArchiveFailure} 原样透出，不做脱敏（脱敏会吃掉
 * `SKILL.md`/`checksum` 这类可判定的关键词）。
 *
 * `code` 是稳定错误码（路由据此决定 HTTP 状态，客户端据此决定要不要弹确认条）。
 */
export class ArchiveInstallRefusal extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ArchiveInstallRefusal'
    this.code = code
  }
}

/** 结果与 HTTP 信封一一对应：路由不再自己写 `/checksum|archive|…/` 正则。 */
export interface ArchiveFailureDescription {
  /** HTTP 状态码（409=需要用户确认覆盖/删除本机内容,422=拒绝,404=未安装,413=过大,502=系统级失败）。 */
  status: number
  /** 给用户看的文案（系统级错误已脱敏）。 */
  message: string
  /** 稳定错误码（有则透出到响应体）。 */
  code?: string | undefined
  /** 是否是"归档/参数不合规"这一类客户端错误。 */
  refusal: boolean
}

/**
 * 兜底分类用的关键词（老路径上仍有**非** {@link ArchiveInstallRefusal} 的拒绝：
 * `archive-util` 的条目校验、以及历史调用点）。它们全是客户端错误，不能因为
 * "不是typed"就被当成上游 502。
 */
const REFUSAL_HINT = /checksum|archive|SKILL\.md|skill name|link entry|too large|traversal|empty path|frontmatter|duplicate entry|not installed|local content/u

/** 系统级 errno → 一句人话（保留原因、去掉路径，审计 2026-09-23 A12）。 */
const ERRNO_HINT: Record<string, string> = {
  EACCES: 'permission denied',
  EBUSY: 'the file is in use by another process',
  EEXIST: 'the path already exists',
  EISDIR: 'expected a file but found a directory',
  EMFILE: 'too many open files',
  ENOENT: 'path not found',
  ENOSPC: 'no space left on device',
  ENOTDIR: 'expected a directory but found a file',
  ENOTEMPTY: 'target directory not empty (a concurrent install/uninstall may be running)',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
}

/**
 * 脱敏：把本机绝对路径换成 `…/<basename>`。
 *
 * 审计 2026-09-23 A12 实测的形态：安装失败时界面直接显示
 * `ENOTEMPTY: directory not empty, rename '/home/<user>/.picoaide-harness/skills/…'`
 * —— 家目录/用户名连同内部 staging 结构一起透出。保留 errno 与原因，只去掉路径。
 * @param raw - 原始错误文案。
 * @returns 可安全展示的文案（≤300 字符）。
 */
export function sanitizeArchiveErrorText(raw: string): string {
  const errno = /^([A-Z][A-Z0-9]+):/u.exec(raw)?.[1]
  const hint = errno === undefined ? undefined : ERRNO_HINT[errno]
  if (errno !== undefined && hint !== undefined) return `${errno}: ${hint}`
  const text = raw
    // 带引号的路径是 Node 错误文案的普遍形态。
    .replace(/(['"`])((?:[A-Za-z]:)?[\\/][^'"`\n]*)\1/gu, (_match, quote: string, path: string) => `${quote}…/${basename(path)}${quote}`)
    // 其余裸绝对路径 token。
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'",;:)\]]+[\\/])*([^\s'",;:)\]]+)/gu, (_match, base: string) => `…/${base}`)
  return text.length > 300 ? `${text.slice(0, 297)}…` : text
}

/**
 * 把归档安装/卸载的失败翻译成 HTTP 信封（分类 + 脱敏 + 状态码）。
 *
 * **唯一实现**：技能（`/api/pico/skills*`、`/api/pico/shared-skills*`）与共享智能体
 * （`/api/pico/agent-presets*`）四条写面共用它。抽出来的理由：这三件事此前散在
 * auth-gate 的四处 `isRefusal ? 422 : 502` 正则里，任一处漏改就会出现"同一个拒绝
 * 在这里 422、在那里 502"；而独立复审 2026-09-23 **A12** 实测智能体路径仍是旧写法
 * （裸分类 + 原文）⇒ 系统级错误（如
 * `ENOTDIR: not a directory, mkdir '/home/<user>/.picoaide-harness/agent-presets'`）
 * 会把**本机绝对路径**透给 UI。
 * @param cause - the thrown value.
 * @returns status / message / code / refusal。
 */
export function describeArchiveFailure(cause: unknown): ArchiveFailureDescription {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const typed = cause instanceof ArchiveInstallRefusal ? cause : undefined
  if (typed?.code === 'NOT_INSTALLED') return { status: 404, message: raw, code: typed.code, refusal: true }
  if (typed?.code === 'LOCAL_CONTENT') return { status: 409, message: raw, code: typed.code, refusal: true }
  if (typed?.code === 'ARCHIVE_TOO_LARGE') return { status: 413, message: raw, code: typed.code, refusal: true }
  if (typed !== undefined || REFUSAL_HINT.test(raw)) {
    return {
      status: 422,
      message: raw,
      ...typed === undefined ? {} : { code: typed.code },
      refusal: true,
    }
  }
  return { status: 502, message: sanitizeArchiveErrorText(raw), refusal: false }
}

/**
 * 安装器私有临时区（staging 与"换入前的旧目录"都放这里）。
 *
 * 三条硬要求（独立审计 2026-09-23 A7/A12）：
 *  1. **以 `.` 开头**、且**不以技能名开头** —— 上游 `skill-filesystem` 的
 *     `discoverRoot` 只看技能库的**直接子目录**里有没有 `SKILL.md`，不排除点号目录。
 *     旧实现把备份放在 `<skills>/.<name>.backup-<pid>-<ts>`：目录根上就有真
 *     frontmatter，于是**卸载后运行时仍然加载得到那份技能**（"卸载不生效"）。
 *  2. **必须还是直接子目录之下的第二层**（`.skill-tmp/install-*`）：运行时只认
 *     直接子目录，因此 `install-XXX/unpacked/SKILL.md` 永远不会被发现；
 *     `listInstalledSkills` 同样只列直接子目录 ⇒ 备份残留既不会被当技能、也不会
 *     被列成"已安装"。
 *  3. 与技能库**同一文件系统** ⇒ `rename()` 仍然是原子的（staging 因此在
 *     `skillsDir` 之内，而不是 os.tmpdir()）。
 */
export const SKILL_TEMP_DIR = '.skill-tmp'

/** 安装器写入的版本标记文件（安装器独占面：打包与安装两端都要净化它）。 */
export const INSTALL_VERSION_FILE = '.install-version'

/** 陈旧 staging 的保留时长：超过它才允许清扫（正在安装的那一份不会被误删）。 */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000

/** 回滚失败时旧内容的保留前缀 —— 清扫器**不碰**它（宁可留垃圾，不可删用户内容）。 */
const ORPHAN_PREFIX = 'orphan-'

/**
 * per-name 互斥（审计 A7）：同一技能目录的 install/uninstall 必须串行。
 *
 * 面板只有一个 `inFlight` 槽，多窗口/重试/脚本都能绕过它；两个 install 交错会
 * 留下孤儿备份目录，install+uninstall 交错则可能"两边都回 200 但技能还在"。
 * 锁按 (skillsDir, name) 取，键里不含路径分隔歧义。
 */
const skillLocks = new Map<string, Promise<void>>()

/**
 * Run `task` while holding the per-(skillsDir, name) lock.
 * @param skillsDir - the skill root.
 * @param name - the skill directory name.
 * @param task - the critical section.
 * @returns whatever `task` resolves to.
 */
export async function withSkillLock<T>(skillsDir: string, name: string, task: () => Promise<T>): Promise<T> {
  const key = `${skillsDir}\u0000${name}`
  const previous = skillLocks.get(key) ?? Promise.resolve()
  // 前一个持锁者失败也要放行（否则一次失败会把该名字永久锁死）。
  const run = previous.then(() => undefined, () => undefined).then(task)
  const tail = run.then(() => undefined, () => undefined)
  skillLocks.set(key, tail)
  void tail.then(() => { if (skillLocks.get(key) === tail) skillLocks.delete(key) })
  return await run
}

/** Result of a successful install. */
export interface SkillInstallResult {
  /** The skill name installed (validated, directory segment). */
  name: string
  /** Version reported by the gateway (`x-skill-version`), when supplied. */
  version?: string | undefined
  /** The user skill root the skill was installed under. */
  skillsDir: string
  /** The final installed directory. */
  targetDir: string
}

export interface InstallSkillArchiveOptions {
  /** Validated skill name. */
  name: string
  /** Raw archive bytes (gzipped tar or zip). */
  archive: Buffer
  /** Optional sha256 hex from the gateway (`x-skill-checksum`); mismatch refuses. */
  checksum?: string | undefined
  /** The user skill root (e.g. `<dshHome>/skills`). */
  skillsDir: string
  /** Optional gateway-reported version (`x-skill-version`), passed through. */
  version?: string | undefined
  /** 分发渠道(写入溯源标记;缺省 market)。 */
  channel?: SkillProvenanceChannel | undefined
  /** 来源服务端地址(写入溯源标记)。 */
  server?: string | undefined
  /**
   * 用户已在界面上确认"覆盖本机同名内容"（审计 A2/A3 的显式覆盖标记）。
   *
   * 目标目录存在、而它**不是**能力中心装的（没有 provenance / 渠道不是商店来源 /
   * appId 对不上）时，视为用户自制内容：没有这个标记一律拒绝（409
   * `LOCAL_CONTENT`），绝不静默整树替换。
   */
  overwrite?: boolean | undefined
  /** staging 清扫阈值(ms)；缺省 24h。测试用它钉住"陈旧目录会被清掉"。 */
  staleTempMaxAgeMs?: number | undefined
}

/**
 * Verify and install one skill archive.
 *
 * @throws Error with a user-facing message on any refusal; never leaves a
 * partial install behind (the staging directory is removed on failure).
 */
export async function installSkillArchive(options: InstallSkillArchiveOptions): Promise<SkillInstallResult> {
  const { name, skillsDir } = options
  // 名字先于锁校验（非法名不参与排队）。
  validateSkillName(name)
  return await withSkillLock(skillsDir, name, () => runInstallSkillArchive(options))
}

/** {@link installSkillArchive} 的临界区（调用方必须已持有 per-name 锁）。 */
async function runInstallSkillArchive(options: InstallSkillArchiveOptions): Promise<SkillInstallResult> {
  const { name, archive, checksum, skillsDir, version, server, overwrite } = options
  const channel = options.channel ?? 'market'

  if (archive.byteLength === 0) throw new ArchiveInstallRefusal('ARCHIVE_EMPTY', 'empty archive')
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ArchiveInstallRefusal('ARCHIVE_TOO_LARGE', `archive too large (${archive.byteLength} bytes)`)
  }
  if (checksum !== undefined) {
    const actual = createHash('sha256').update(archive).digest('hex')
    if (actual !== checksum.toLowerCase()) {
      throw new ArchiveInstallRefusal('CHECKSUM_MISMATCH', 'archive checksum mismatch; refused')
    }
  }

  // 陈旧 staging 清扫（审计 A12）：SIGKILL/断电会留下 `.install-*`（旧布局）或
  // `.skill-tmp/install-*`（新布局），此前没有任何清扫者，会一直堆积
  // （每个最多 16MiB 原始 + 64MiB 解包）。只清"超过阈值"的，正在跑的那一份不受影响。
  await sweepStaleSkillTemps(skillsDir, options.staleTempMaxAgeMs)

  // 同名覆盖守卫（审计 A2/A3 + W4 P1-2）：本机自制内容，以及**换渠道覆盖**
  // （目标那份来自另一条商店渠道，如随包插件同步写下的 `plugin`）都必须由用户
  // 显式确认（面板确认条 → `?overwrite=1`）；缺确认一律 409 `LOCAL_CONTENT`。
  const targetDir = join(skillsDir, name)
  const existingOrigin = await classifyInstalledSkill(targetDir, name)
  if (existingOrigin !== undefined && overwrite !== true) {
    const existingChannel = existingOrigin === 'store' ? (await readProvenance(targetDir))?.channel : undefined
    if (requiresOverwriteConfirmation(existingOrigin, existingChannel, channel)) {
      throw new ArchiveInstallRefusal(
        'LOCAL_CONTENT',
        describeOverwriteRefusal(name, existingOrigin, existingChannel, channel),
      )
    }
  }

  // Stage under the skill root so the final rename stays on one filesystem.
  await mkdir(skillsDir, { recursive: true, mode: 0o700 })
  const tempRoot = join(skillsDir, SKILL_TEMP_DIR)
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(tempRoot, 'install-'))

  try {
    const format = archiveFormat(archive)
    if (format === null) throw new ArchiveInstallRefusal('ARCHIVE_UNSUPPORTED', 'unsupported archive format')

    // Pass 1: reject unsafe entries and bound the unpacked size without
    // extracting (zip via AdmZip in-memory scan; tar.gz via node-tar listing).
    // Violations are collected (throwing inside onentry does not terminate
    // the tar stream) and abort the offending entry; the stream still runs
    // to completion, then the first violation is thrown.
    await assertArchiveSafe(archive)

    // Pass 2: extract into the staging directory.
    const unpackRoot = join(staging, 'unpacked')
    await mkdir(unpackRoot, { recursive: true })
    if (format === 'zip') {
      await extractZip(archive, unpackRoot)
    } else {
      const archiveFile = join(staging, 'archive.tar.gz')
      await writeFile(archiveFile, archive, { mode: 0o600 })
      // 审计 A8：tar 通道与 zip 通道必须用同一套权限口径（剥掉 0o7000）。
      await extractTar(archiveFile, unpackRoot)
    }

    // The archive must carry a top-level SKILL.md (directory bundle or flat).
    await stat(join(unpackRoot, 'SKILL.md')).catch(() => {
      throw new ArchiveInstallRefusal('SKILL_MD_MISSING', 'archive has no SKILL.md at its root')
    })

    // The upstream skill-filesystem parser requires YAML frontmatter
    // (name + description) on SKILL.md; gateway archives keep the metadata
    // in a separate metadata.yaml instead. Synthesize the frontmatter from
    // metadata.yaml when SKILL.md lacks it, so installed skills are
    // discovered — and carry the gateway-reported version so hasUpdate can
    // compare against the installed copy. Archives that already carry
    // frontmatter are untouched (installer-only archives still get a version
    // injected here only when they lacked any frontmatter; full-control
    // archives keep their own metadata).
    await synthesizeSkillFrontmatter(unpackRoot, name, version)
    // 审计 A1：**装得上就必须加载得到** —— 按运行时的同一份规则复核最终
    // frontmatter（缺 name/description、非 kebab、name 与技能 ID 不一致都在此拒绝）。
    await assertLoadableSkillMetadata(unpackRoot, name)
    // 审计 A13：安装器自有标记文件是**安装器独占面**。归档自带同名文件时忽略它
    // （否则能力中心/遥测会把归档伪造的版本当成真版本）。
    await rmInstallerOwnedMarkers(unpackRoot)

    // Replace an existing installation only with a fully verified tree.
    // 审计 2026-08-25 P2-4:此前直接 rm(targetDir)+rename——两步之间 crash
    // 窗口会让已装技能目录整个消失。改为「rename 旧 → backup,rename 新 →
    // target,成功后删 backup」;失败时回滚旧目录。
    const backupDir = join(staging, 'backup')
    try {
      await rename(targetDir, backupDir).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause // 不存在 = 首次安装
      })
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    try {
      await rename(unpackRoot, targetDir)
    } catch (cause) {
      // 回滚:把旧目录还原,不留半安装状态。回滚失败时旧内容**绝不能删**:
      // 移出 install-* 清扫面(orphan- 前缀)并留一条日志。
      const restored = await rename(backupDir, targetDir).then(() => true).catch(() => false)
      if (!restored) {
        const orphan = join(tempRoot, `${ORPHAN_PREFIX}${Date.now()}-${name}`)
        await rename(backupDir, orphan)
          .then(() => { console.warn(`[skill-install] rollback failed for "${name}"; previous content kept in ${SKILL_TEMP_DIR}/${basename(orphan)}`) })
          .catch(() => { console.warn(`[skill-install] rollback failed for "${name}"`) })
      }
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    await rm(backupDir, { recursive: true, force: true }).catch((cause: unknown) => {
      // 尽力而为,但不再静默:残留会占空间(运行时看不到它)。
      console.warn(`[skill-install] could not remove the backup of "${name}": ${cause instanceof Error ? cause.message : String(cause)}`)
    })

    // 版本标记:安装在技能目录内写 .install-version(仅当版本已知),
    // host 代理读取它作为 installedVersion(hasUpdate 比较基准)。
    // 不碰 SKILL.md 内容(保留上游/用户归档原样)。
    if (version !== undefined && version !== '') {
      await writeFile(join(targetDir, INSTALL_VERSION_FILE), version, { mode: 0o600 }).catch(() => { /* 非致命 */ })
    }
    // 溯源标记(决策 2026-09-01 D6):记录应用 ID/版本/渠道/来源服务端与
    // 安装时的内容哈希,客户端据此判定归属与「是否被本地修改过」。
    // 写失败不致命——溯源是展示能力,不影响技能可用性。
    await writeProvenance(targetDir, {
      appId: name,
      version: version ?? '',
      channel,
      ...server === undefined ? {} : { server },
      archiveChecksum: await computeSkillContentHash(targetDir),
      installedAt: new Date().toISOString(),
    }).catch(() => { /* 非致命 */ })

    return { name, version, skillsDir, targetDir }
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    // 临时区是安装器的私有目录：本次安装没留下任何东西时顺手摘掉它（非空则
    // rmdir 失败 = 有别的 staging/orphan 在用，保持原样 —— 不做递归删除）。
    await rmdir(tempRoot).catch(() => {})
  }
}

/**
 * 清扫陈旧安装临时目录（审计 A12/A7）。
 *
 * 只删超过 `maxAgeMs`（缺省 24h）的条目，因此正在进行的安装不受影响；
 * `orphan-`（回滚失败时保留的旧内容）**永不清理**。全程 best-effort：清扫
 * 失败绝不能让安装本身失败。
 * @param skillsDir - the user skill root.
 * @param maxAgeMs - age threshold in ms.
 * @returns 清掉的目录数（诊断/测试用）。
 */
export async function sweepStaleSkillTemps(skillsDir: string, maxAgeMs: number = STALE_TEMP_MS): Promise<number> {
  const now = Date.now()
  let removed = 0
  const stale = async (path: string): Promise<boolean> => {
    const st = await lstat(path).catch(() => undefined)
    if (st === undefined) return false
    return now - st.mtimeMs >= maxAgeMs
  }
  const drop = async (path: string): Promise<void> => {
    await rm(path, { recursive: true, force: true }).then(() => { removed++ }).catch(() => {})
  }
  // 当前布局：<skills>/.skill-tmp/install-*
  const tempRoot = join(skillsDir, SKILL_TEMP_DIR)
  for (const entry of await readdir(tempRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.name.startsWith('install-')) continue
    const path = join(tempRoot, entry.name)
    if (await stale(path)) await drop(path)
  }
  // 旧布局(≤2.8.1)：staging/备份直接建在技能库根，名字形如 `.install-<name>-XXXXXX`
  // 与 `.<name>.backup-<pid>-<ts>`。旧备份的**根上就有 SKILL.md**，运行时会把整份
  // 技能重复加载（A7 实测："卸载后技能仍然可用"）⇒ 升级后第一次安装顺手清掉。
  for (const entry of await readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    const isLegacyStaging = entry.name.startsWith('.install-')
    const isLegacyBackup = /^\..+\.backup-\d+-\d+$/u.test(entry.name)
    if (!isLegacyStaging && !isLegacyBackup) continue
    const path = join(skillsDir, entry.name)
    if (await stale(path)) await drop(path)
  }
  return removed
}

/**
 * 判断 `<skillsDir>/<name>` 里那一份东西是"能力中心装的"还是"用户自己放的"
 * （审计 A2/A3 的唯一来源判据）。
 *
 * `store` 的条件见 {@link isStoreProvenance}；任何一条不成立都按 `local`
 * （用户内容）处理 —— 宁可多问一次，不可静默覆盖/删除。
 * @param skillDir - the candidate skill directory.
 * @param name - the expected skill id (directory name).
 * @returns `'store'` / `'local'`；目标不存在时 `undefined`。
 */
export async function classifyInstalledSkill(skillDir: string, name: string): Promise<InstalledSkillOrigin | undefined> {
  try {
    await lstat(skillDir)
  } catch {
    return undefined
  }
  const prov = await readProvenance(skillDir)
  return isStoreProvenance(prov, name) ? 'store' : 'local'
}

/**
 * 溯源标记是否表示"这份内容由能力中心/平台装进来的"（分类的**唯一谓词**）。
 *
 * 三个条件必须同时成立：标记可读 + 渠道是商店来源 + appId 与目录名一致。
 * {@link classifyInstalledSkill} 与能力中心聚合面共用它，避免"两处各判一次"漂移。
 * @param prov - the provenance marker (undefined when absent).
 * @param name - the expected skill id (directory name).
 * @returns 商店来源为 true，其余（含标记缺失）为 false。
 */
export function isStoreProvenance(prov: SkillProvenance | undefined, name: string): boolean {
  return prov !== undefined && isStoreChannel(prov.channel) && prov.appId === name
}

/**
 * 覆盖一个**已存在**的同名技能目录时，是否必须由用户显式确认（审计 W4 P1-2，2026-09-23）。
 *
 * 判据把"来源"拆成两件不同的事（此前混在一起 ⇒ 静默覆盖 + 归属错）：
 *  - {@link isStoreProvenance} 回答"这份内容是不是用户手写的"（决定卸载/更新要不要
 *    当成用户数据对待）；
 *  - 本函数回答"这次覆盖会不会**换渠道**"。目标是商店来源、但渠道与本次安装的渠道
 *    不同（market ↔ org ↔ builtin ↔ plugin）时，整树替换会把这份技能从一条渠道搬到
 *    另一条：内容来源变了、而调用方按"商店来源 ⇒ 直接更新"放行，用户零感知。实测
 *    （W4 probe10）：市场安装无确认覆盖随包插件技能 → 下次开机插件同步又换回插件版
 *    （插件侧现在也会拒收，见 `skills-sync.js` 的来源闸门），两边互相覆盖。
 *
 * 因此：目标不存在 → 不需要确认；用户自制 → 需要确认；商店来源但渠道不同 → 需要确认；
 * 商店来源且渠道相同 → 正常更新（安装器自己的升级路径）。
 *
 * @param existingOrigin - {@link classifyInstalledSkill} 的结果（`undefined` = 目标不存在）。
 * @param existingChannel - 目标那一份的 provenance 渠道（仅商店来源时有值）。
 * @param incomingChannel - 本次安装写入的渠道。
 * @returns 需要用户显式确认（面板确认条 / `?overwrite=1`）为 true。
 */
export function requiresOverwriteConfirmation(
  existingOrigin: InstalledSkillOrigin | undefined,
  existingChannel: string | undefined,
  incomingChannel: SkillProvenanceChannel,
): boolean {
  if (existingOrigin === undefined) return false
  if (existingOrigin === 'local') return true
  return existingChannel !== incomingChannel
}

/**
 * 覆盖被拒时的用户可读原因（两种成因共用 `LOCAL_CONTENT` 这一个拒绝码：
 * 面板对 409 的处理是同一条确认条，见 `CapabilityCenterPanel` 的 `performInstall`）。
 * @param name - the skill id.
 * @param existingOrigin - 目标那一份的来源分类。
 * @param existingChannel - 目标那一份的 provenance 渠道。
 * @param incomingChannel - 本次安装写入的渠道。
 * @returns 英文（对外文案语言与其它拒绝一致）说明。
 */
function describeOverwriteRefusal(
  name: string,
  existingOrigin: InstalledSkillOrigin,
  existingChannel: string | undefined,
  incomingChannel: SkillProvenanceChannel,
): string {
  if (existingOrigin === 'local') {
    return `a skill named "${name}" already exists locally but was not installed by the Capability Hub; `
      + 'installing would replace it (including your own files) — confirm the overwrite to continue'
  }
  return `a skill named "${name}" is installed from the "${String(existingChannel)}" channel; installing the `
    + `"${incomingChannel}" version would move it to another channel and replace its content — `
    + 'confirm the overwrite to continue'
}

/** 本机那一份技能/智能体的来源：商店（能力中心装的）或本机自制。 */
export type InstalledSkillOrigin = 'store' | 'local'

/**
 * 复核最终 SKILL.md 的 frontmatter 是否能被运行时加载（审计 A1）。
 *
 * 上游 `skill-filesystem` 的判据逐条对齐：frontmatter 必须是合法 YAML 映射、
 * `name`/`description` 必填、`name` 必须匹配运行时正则。额外加一条**一致性**：
 * `name` 必须等于技能 ID（目录名），否则能力中心的"已装/卸载/遥测"全按目录名
 * 记账，而模型侧看到的是另一个名字（`@` 谁都不对）。
 * @param dir - the unpacked skill directory.
 * @param name - the skill id being installed.
 * @throws ArchiveInstallRefusal with a user-readable reason.
 */
export async function assertLoadableSkillMetadata(dir: string, name: string): Promise<void> {
  const meta = await readSkillFrontmatter(join(dir, 'SKILL.md'))
  const fmName = metaString(meta.name)
  const fmDescription = metaString(meta.description)
  if (fmName === undefined || fmDescription === undefined) {
    throw new ArchiveInstallRefusal(
      'FRONTMATTER_INVALID',
      'SKILL.md must carry YAML frontmatter with a non-empty name and description; '
      + 'without them the runtime ignores the skill (it would install but never load)',
    )
  }
  if (!isLoadableSkillName(fmName)) {
    throw new ArchiveInstallRefusal(
      'NAME_INVALID',
      `SKILL.md name ${JSON.stringify(fmName)} is not a loadable skill name `
      + '(lowercase kebab-case such as my-skill is required); the runtime would ignore this skill',
    )
  }
  if (fmName !== name) {
    throw new ArchiveInstallRefusal(
      'FRONTMATTER_INVALID',
      `SKILL.md name ${JSON.stringify(fmName)} must equal the skill id ${JSON.stringify(name)}`,
    )
  }
}

/** 删掉归档自带的安装器独占标记（审计 A13）。 */
async function rmInstallerOwnedMarkers(dir: string): Promise<void> {
  await rm(join(dir, PROVENANCE_DIR), { recursive: true, force: true }).catch(() => { /* 不存在即无事 */ })
  await rm(join(dir, INSTALL_VERSION_FILE), { force: true }).catch(() => { /* 不存在即无事 */ })
}

/**
 * Ensure `SKILL.md` under `dir` carries YAML frontmatter with `name`,
 * `description`, and (when known) `version` (the upstream parser ignores
 * skills without name/description; `version` lets hasUpdate compare reliably
 * against the installed copy). Reads a sibling `metadata.yaml` (gateway
 * format: `name`/`description`/`version` keys) and prepends `---`-delimited
 * frontmatter when the file has none.
 *
 * 审计 2026-09-23 A1：合成出来的 `name` **恒等于技能 ID（目录名）**。旧实现直接抄
 * `metadata.yaml` 的 `name`（任意字符串，含中文展示名），于是合成的 frontmatter
 * 让运行时判 `invalid skill name "Epsilon 技能"` 静默忽略整份技能。展示名不丢：
 * 它与技能 ID 不一致时写进 `title`。
 */
export async function synthesizeSkillFrontmatter(dir: string, fallbackName: string, version?: string): Promise<void> {
  const skillMdPath = join(dir, 'SKILL.md')
  const raw = await readFile(skillMdPath, 'utf8')
  // 已有 frontmatter 一律不动(上游/用户归档的元数据保持原样;版本由
  // 安装器写入独立标记文件 .install-version,见 installSkillArchive)。
  if (raw.trimStart().startsWith('---')) return

  let meta: { name?: unknown; description?: unknown; version?: unknown } = {}
  try {
    const metaRaw = await readFile(join(dir, 'metadata.yaml'), 'utf8')
    const parsed = parseYaml(metaRaw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as { name?: unknown; description?: unknown; version?: unknown }
    }
  } catch {
    // No (or unreadable) metadata.yaml: fall back to the archive name.
  }

  const metaName = typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : undefined
  const name = fallbackName
  const description = typeof meta.description === 'string' && meta.description !== ''
    ? meta.description
    : `${fallbackName} skill`
  const metaVersion = typeof meta.version === 'string' && meta.version !== '' ? meta.version : undefined
  const versionValue = version ?? metaVersion
  const frontmatter = stringifyYaml({
    name,
    description,
    ...metaName === undefined || metaName === fallbackName ? {} : { title: metaName },
    ...versionValue === undefined ? {} : { version: versionValue },
  }).trimEnd()
  await writeFile(skillMdPath, `---\n${frontmatter}\n---\n${raw}`)
}

/**
 * Resolve the user skill root from the environment (product home default).
 *
 * 2026-09-11:缺省值走共享的 `dshHomeSafe()`(数据目录唯一权威) —— 数据根随渠道,
 * 自己抄一份 `~/.picoaide-harness` 会在改渠道目录时漏掉,技能就落回官方目录。
 */
export function resolveSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  // 审计 2026-08-25 P2-3:DSH_HOME 不得指向系统关键目录(同机注入面)。
  return join(dshHomeSafe({ env }), 'skills')
}

/**
 * List installed skills: directories under the skill root that carry a
 * SKILL.md — the exact layout `installSkillArchive` produces and the
 * upstream `@deepseek-ai/dsh-skill-filesystem` provider discovers. A missing
 * or unreadable root yields an empty list.
 *
 * 只列**运行时真的能加载**的那些（点号开头 / 非 kebab 名字一律不算），因此：
 *  - 安装器自己的 `.skill-tmp`（staging/备份）不会被列成"已安装技能"（审计 A7）；
 *  - 旧版本留下的 `.install-*`、`.<name>.backup-*` 同理（同样不会被运行时加载，
 *    但要靠 {@link sweepStaleSkillTemps} 清掉，见 A12）。
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @returns installed skill directory names, sorted.
 */
export async function listInstalledSkills(skillsDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // 点号开头 = 安装器/插件的私有目录（staging、备份、.system 等），永远不是技能。
    if (entry.name.startsWith('.')) continue
    if (!isLoadableSkillName(entry.name)) continue
    try {
      await stat(join(skillsDir, entry.name, 'SKILL.md'))
      result.push(entry.name)
    } catch {
      // Directory without a SKILL.md — not a skill (or mid-write); skip.
    }
  }
  return result.sort((a, b) => a.localeCompare(b))
}

/**
 * Uninstall one skill: remove `<skillsDir>/<name>` after verifying it really
 * is an installed skill (valid name + SKILL.md present). Everything else is
 * refused, so this API can never delete an arbitrary directory.
 *
 * 审计 2026-09-23 A3：**来源感知** —— 目标目录里的那一份若不是能力中心装的
 * （没有溯源标记 / 渠道不是商店来源 / appId 对不上），视为用户自制内容，
 * 没有 `overwrite` 显式确认一律拒绝（409 `LOCAL_CONTENT`）。旧实现的判据只有
 * "名字合法 + 有 SKILL.md"，于是市场里存在同名条目时，**用户在技能库里手写的
 * 同名技能（连同笔记/脚本）被一键删除**。
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @param name - the skill directory name (single safe segment).
 * @param options - `overwrite: true` = 用户已确认删除本机自制内容。
 * @returns the removed directory path.
 * @throws Error when the name is invalid, the skill is not installed, or local content needs confirmation.
 */
export async function uninstallSkill(
  skillsDir: string,
  name: string,
  options: { overwrite?: boolean | undefined } = {},
): Promise<string> {
  validateSkillName(name)
  return await withSkillLock(skillsDir, name, async () => {
    const target = join(skillsDir, name)
    try {
      await stat(join(target, 'SKILL.md'))
    } catch {
      throw new ArchiveInstallRefusal('NOT_INSTALLED', `skill "${name}" is not installed`)
    }
    const origin = await classifyInstalledSkill(target, name)
    if (origin === 'local' && options.overwrite !== true) {
      throw new ArchiveInstallRefusal(
        'LOCAL_CONTENT',
        `the skill directory "${name}" was not installed by the Capability Hub; `
        + 'deleting it removes your own files — confirm the deletion to continue',
      )
    }
    await rm(target, { recursive: true, force: true })
    return target
  })
}

/** 安装器写入的溯源目录名(服务端拒绝归档自带同名目录)。 */
export const PROVENANCE_DIR = '.picoaide'

/**
 * 分发渠道（跨泳道契约 S2 ↔ S1 写死）：
 *  - `market` 市场（服务端 marketplace 表）
 *  - `org` 组织共享库（shared-skills）
 *  - `builtin` 平台内置（随服务端镜像发布，客户端按需安装）
 *  - `plugin` **随客户端内置**（随包插件开机同步进技能库的技能，如 dsh-memory-evolve）
 *
 * 这四个是"商店来源"：内容由平台/客户端写成，覆盖与删除都不需要额外确认。
 * 任何其它取值（含读不出来的）都按"用户自制"处理。
 */
export type SkillProvenanceChannel = 'market' | 'org' | 'builtin' | 'plugin'

/**
 * 商店来源渠道（判据："这份内容不是用户手写的"）。
 *
 * ⚠️ 这个集合**只**回答"是不是用户内容"（卸载/更新按它决定要不要当用户数据对待）。
 * 它**不**表示"可以直接被另一条渠道覆盖" —— 覆盖时的渠道互斥由
 * {@link requiresOverwriteConfirmation} 单独判定（审计 W4 P1-2：此前把 `plugin`
 * 放进这个集合就顺带获得了"无需确认即可被市场覆盖"的待遇，于是市场安装静默吃掉
 * 随包插件技能、内容与徽章归属错位）。
 */
export const STORE_PROVENANCE_CHANNELS: readonly SkillProvenanceChannel[] = ['market', 'org', 'builtin', 'plugin']

/** 渠道是否属于商店来源（类型收窄）。 */
export function isStoreChannel(channel: unknown): channel is SkillProvenanceChannel {
  return typeof channel === 'string' && (STORE_PROVENANCE_CHANNELS as readonly string[]).includes(channel)
}

/** 安装来源溯源:客户端据此判断「这份技能是市场上的哪个应用的哪个版本」。 */
export interface SkillProvenance {
  /** 市场/组织库中的应用 ID(= 技能目录名 = frontmatter name)。 */
  appId: string
  /** 安装时的版本号。 */
  version: string
  /** 分发渠道(见 {@link SkillProvenanceChannel})；未知取值原样保留并按"非商店来源"处理。 */
  channel: SkillProvenanceChannel | (string & {})
  /** 来源服务端(多环境时区分)。 */
  server?: string | undefined
  /** 安装时归档的 sha256(本地改动检测的基准)。 */
  archiveChecksum?: string | undefined
  /** 安装时间(ISO)。 */
  installedAt: string
}

/**
 * Write the provenance marker into an installed skill directory.
 * 取代旧的 `.install-version` 单值文件:除版本外还记录应用 ID、渠道、
 * 来源服务端与归档校验和,使客户端能可靠回答「装的是市场哪个技能」。
 */
export async function writeProvenance(skillDir: string, info: SkillProvenance): Promise<void> {
  const dir = join(skillDir, PROVENANCE_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'release.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Read the provenance marker; undefined when absent or unreadable.
 *
 * 未知渠道**不再回落成 `market`**（跨泳道契约 S2）：回落会把"我们不知道这是哪
 * 来的"伪装成"这是市场装的"，进而在覆盖/删除判定里被当成商店内容（正是审计
 * A2/A3 的数据丢失面）。现在未知渠道原样返回字符串（`channel` 之外的类型仍按
 * 原文透出，由 {@link isStoreChannel} 判定为非商店来源）。
 */
export async function readProvenance(skillDir: string): Promise<SkillProvenance | undefined> {
  try {
    const raw = await readFile(join(skillDir, PROVENANCE_DIR, 'release.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SkillProvenance>
    if (typeof parsed.appId !== 'string' || typeof parsed.version !== 'string') return undefined
    return {
      appId: parsed.appId,
      version: parsed.version,
      // 'plugin'（随客户端内置）必须原样保留 —— 回落成 'market' 会让面板显示错的
      // 来源徽章，也会把"随包内容"与"市场内容"混为一谈。
      channel: typeof parsed.channel === 'string' ? parsed.channel : '',
      server: typeof parsed.server === 'string' ? parsed.server : undefined,
      archiveChecksum: typeof parsed.archiveChecksum === 'string' ? parsed.archiveChecksum : undefined,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Compute a stable content hash of an installed skill directory, excluding
 * the installer-owned provenance directory. 与安装时记录的归档校验和不同源,
 * 因此只用于「与上次计算相比是否变化」——首次安装时由 writeProvenance
 * 记录当时的内容哈希,之后据此判定本地是否被改动过。
 */
export async function computeSkillContentHash(skillDir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (prefix === '' && entry.name === PROVENANCE_DIR) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`)
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        hash.update(`F:${rel}:`)
        hash.update(await readFile(join(dir, entry.name)))
        hash.update('\n')
      }
    }
  }
  await walk(skillDir, '')
  return hash.digest('hex')
}

/** One locally authored skill row (name + display metadata from frontmatter). */
export interface LocalSkillRow {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  version?: string | undefined
}

/** Extract a trimmed string from an unknown YAML value ('' → undefined). */
function metaString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Enumerate locally authored skills (SKILL.md directories under the root)
 * with their frontmatter display metadata: what the upstream filesystem
 * provider discovers. Metadata is best-effort (unreadable frontmatter
 * degrades to the id — presentation, not capability).
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @returns rows sorted by name.
 */
export async function listLocalSkills(skillsDir: string): Promise<LocalSkillRow[]> {
  const names = await listInstalledSkills(skillsDir)
  const rows: LocalSkillRow[] = []
  for (const name of names) {
    const meta = await readSkillFrontmatter(join(skillsDir, name, 'SKILL.md'))
    const displayName = metaString(meta.name)
    const description = metaString(meta.description)
    const version = metaString(meta.version)
    rows.push({
      name,
      ...displayName === undefined ? {} : { displayName },
      ...description === undefined ? {} : { description },
      ...version === undefined ? {} : { version },
    })
  }
  return rows
}

/** Parse the YAML frontmatter of a SKILL.md (best-effort). */
async function readSkillFrontmatter(skillMdPath: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(skillMdPath, 'utf8')
  } catch {
    return {}
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)
  if (match === null) return {}
  try {
    const parsed = parseYaml(match[1]!) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Unparsable frontmatter: degrade to id (presentation only).
  }
  return {}
}

/** Result of packing one local skill for upload. */
export interface SkillPackResult {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  version: string
  checksum: string
  archive: Buffer
}

/**
 * Pack a locally authored skill's WHOLE directory into a zip whose entries
 * are the directory's contents (the archive root IS the skill directory).
 * Symlinks are refused by the safety scan, so an archive can never smuggle a
 * reference outside the skill.
 *
 * 版本号取自包内 `SKILL.md` 的 frontmatter `version`(决策 2026-09-01
 * 「包内即真相」)。此前这里的默认值 '1.0.0' 让每次上传都声称是 1.0.0——
 * 服务端因此永远看到同一个版本号,「本地与线上版本一致就拒绝」无从判断。
 * @param skillsDir - the skill root (`<dshHome>/skills`).
 * @param name - the skill directory name.
 * @param version - 可选覆盖;缺省时用包内 frontmatter 的 version。
 * @param locale - 宿主语言(调用方按请求解析后传入;缺省中文,与历史行为一致)。
 * @returns the archive plus metadata, or throws with a user-facing message.
 */
export async function packSkill(
  skillsDir: string, name: string, version?: string, locale: HostLocale = DEFAULT_HOST_LOCALE,
): Promise<SkillPackResult> {
  validateSkillName(name)
  const dir = join(skillsDir, name)
  await stat(join(dir, 'SKILL.md')).catch(() => {
    throw new Error(`skill "${name}" has no SKILL.md`)
  })
  const meta = await readSkillFrontmatter(join(dir, 'SKILL.md'))
  const packVersion = version ?? metaString(meta.version)
  if (packVersion === undefined) {
    // 用户可见(经 auth-gate 的 { error } 回到能力中心面板), 故按宿主语言取。
    throw new Error(hostCopy(
      locale,
      `技能 "${name}" 的 SKILL.md 缺少 version 字段:请写明版本号(如 version: 1.0.0)后再上传`,
      `Skill "${name}" has no version field in SKILL.md: add a version (for example version: 1.0.0) and upload again`,
    ))
  }

  const zip = new AdmZip()
  await addDirToZip(zip, dir, dir, '')
  const archive = zip.toBuffer()
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`skill archive too large (${archive.byteLength} bytes)`)
  }
  await assertArchiveSafe(archive)
  // 发布前本地预检(决策 §5.5):与服务端同一套规则的前 7 步,错误码一致。
  // 在这里失败就不发请求——用户不必等一次网络往返才知道包不合规。
  const raw = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const entryNames = zip.getEntries().map((e) => e.entryName)
  const issues = precheckSkillPackage(raw, name, entryNames, locale)
  if (issues.length > 0) {
    const first = issues[0]!
    const more = issues.length > 1
      ? hostCopy(locale, `（另有 ${issues.length - 1} 项问题）`, ` (${issues.length - 1} more issues)`)
      : ''
    throw new Error(`${first.code}: ${first.message}${more}`)
  }
  const checksum = createHash('sha256').update(archive).digest('hex')
  const displayName = metaString(meta.name)
  const description = metaString(meta.description)
  return {
    name,
    ...displayName === undefined ? {} : { displayName },
    ...description === undefined ? {} : { description },
    version: packVersion,
    checksum,
    archive,
  }
}

/** Recursively add a directory tree into an AdmZip (relative entry names). */
async function addDirToZip(zip: AdmZip, root: string, dir: string, relPrefix: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    // 安装器自有文件**不是技能内容**，重新上传时必须排除（审计 2026-09-23 A13）：
    //  - `.picoaide/`：溯源目录，服务端以 PROVENANCE_FORBIDDEN 拒绝（伪造归属防护）；
    //  - `.install-version`：安装器写的版本标记，此前会被打进上传包流出去。
    if (relPrefix === '' && (entry.name === PROVENANCE_DIR || entry.name === INSTALL_VERSION_FILE)) continue
    // 拒绝符号链接:打包时即失败(安装侧同样拒绝)。
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink refused in package: ${rel}`)
    }
    if (entry.isDirectory()) {
      zip.addFile(`${rel}/`, Buffer.alloc(0), '', 0o755)
      await addDirToZip(zip, root, abs, rel)
    } else if (entry.isFile()) {
      const data = await readFile(abs)
      const st = await stat(abs)
      zip.addFile(rel, data, '', st.mode & 0o777)
    }
  }
}
