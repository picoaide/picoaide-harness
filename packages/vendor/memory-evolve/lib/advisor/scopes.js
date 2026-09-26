/**
 * 评审员约束存储（2026-08-12 用户拍板：四层级——系统提示词 / 项目约束 /
 * 会话约束 / 评审会话约束）。
 *
 * 本模块管理后三层（系统提示词在既有 config.advisorSystemPrompt）：
 *
 * - **全局约束**（global）：**所有项目、所有会话**都生效（2026-08-12
 *   用户拍板：与系统提示词区分——提示词一般不改，全局约束词是日常层）；
 * - **项目约束**（project）：按工作区 cwd 隔离，同一 cwd 的所有会话共享
 *   同一条（编辑保存即生效，重启/刷新保留）；
 * - **会话约束**（session）：按会话 id 隔离，本会话内一直有效（跨「新建
 *   评审会话」保留）；
 * - **评审会话约束**（conversation）：绑定评审会话（epoch）——存于
 *   conversation 持久化文件（{ epoch, messages, scopeText }），**新建
 *   评审会话（resetConversation）即清空**。
 *
 * 存储位置（<dataDir>/advisor/）：
 * - global-scope.json：{ text }（全局约束，所有项目/会话共享）
 * - project-scopes.json：{ [cwd]: text }
 * - session-scopes/<safeId>.json：{ text }
 * - conversations/<safeId>.json：{ epoch, messages, scopeText }
 *
 * 纯类（fs 由注入的 storage 提供以支持测试）；原子写由调用方保证。
 * **路径约定：内部全部使用相对 dataDir 的路径**（'project-scopes.json'、
 * 'session-scopes/x.json'、conversationFileOf 返回 'conversations/x.json'），
 * 由调用方在 readFile/writeFile/writeConversation 闭包里拼前缀。
 *
 * @module dsh-memory-evolve/advisor/scopes
 */

/** 单条约束文本上限（多行，可同时放多条指令）。 */
export const SCOPE_MAX_CHARS = 4_000

/**
 * @param {object} options
 * @param {(path: string, data: string) => void} options.writeFile - 原子写（相对 dataDir 路径；temp+rename 由调用方保证）
 * @param {(path: string) => string} options.readFile - 读取（相对 dataDir 路径；不存在返回 ''）
 * @param {(sessionId: string) => string} options.conversationFileOf - 评审会话文件路径（与 conversation 共用）
 * @param {(path: string, data: string) => void} options.writeConversation - 评审会话文件原子写
 */
export class ScopeStore {
  /** 全局约束文本（undefined=未加载；所有项目/会话共享）。 */
  globalText = undefined
  /** cwd → 项目约束文本。 */
  projectScopes = new Map()
  /** sessionId → 会话约束文本。 */
  sessionScopes = new Map()
  /**
   * 相对路径 → 最近一次**读失败**的原因（FIX-45③，2026-09-29）。
   *
   * 为什么需要它：本类全是 read-modify-write（`setProject` 合并整文件 map、
   * `setConversation` 合并 conversation 文件）。读失败若被降级成"空基线"，
   * 写路径就会以空基线**覆盖整文件** —— 抹掉别的项目的约束、评审员的整段历史。
   * 所以：读失败 ⇒ 记一条标记；对应的 `set*` **fail-closed 拒写**并抛出可读原因。
   * 标记在该路径**重新读成功**时清除（瞬时故障自愈，不留永久禁写）。
   * @type {Map<string, string>}
   */
  loadErrors = new Map()
  writeFile
  readFile
  conversationFileOf
  writeConversation

  constructor(options) {
    this.writeFile = options.writeFile
    this.readFile = options.readFile
    this.conversationFileOf = options.conversationFileOf
    this.writeConversation = options.writeConversation
  }

  /** 校验并规整约束文本（trim；空=清除该层）。 */
  static normalize(text) {
    const trimmed = String(text ?? '').trim()
    if (trimmed.length > SCOPE_MAX_CHARS) {
      throw new Error(`约束文本超长（上限 ${SCOPE_MAX_CHARS} 字符）`)
    }
    return trimmed
  }

  /**
   * 读一个基线文件并解析（FIX-45③ 的唯一读入口）。
   *
   * 形态与 `lib/skills.js`（AB2-04）/`lib/coi/index.js` 的 `loadRuntime` 同源：
   * **只有"文件不存在"才算没有基线**，其余一律抛错（调用方据此拒写）。
   * 注入的 `readFile` 已经把 ENOENT 归一成 `''`（见 advisor/index.js 的注释），
   * 所以这里 `''` = 不存在**或**该层被显式清空（`setGlobal`/`setSession` 清空时写 `''`）。
   * @param {string} rel - 相对 dataDir 的路径。
   * @returns {*} 解析后的基线；不存在返回 `undefined`。
   */
  readBaseline(rel) {
    let raw
    try {
      raw = this.readFile(rel)
    } catch (error) {
      // 注入的 reader 通常已把 ENOENT 归一成 `''`；这里再认一次 ENOENT 是**纵深**：
      // 换一个没归一化的 reader 也不能把"不存在"误判成"读失败"（否则首次使用会被拒写）。
      if (error?.code === 'ENOENT') return undefined
      throw new Error(`读失败 ${rel}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (raw === '') return undefined
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new Error(`内容不可解析 ${rel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 写前闸门：该路径最近一次读失败过就**拒绝写入**（fail-closed）。
   * @param {string} rel - 相对 dataDir 的路径。
   * @param {string} label - 人读的层名（如「项目约束」）。
   */
  assertBaselineWritable(rel, label) {
    const reason = this.loadErrors.get(rel)
    if (reason === undefined) return
    throw new Error(`advisor: ${label}基线不可读（${rel}）—— 已拒绝写入：${reason}`
      + '（以空基线回写会抹掉其它项目/会话的内容；请先恢复该文件的可读性）')
  }

  /**
   * 记一次读失败（**不缓存**空值 ⇒ 下次访问重试；写路径按 {@link assertBaselineWritable} 拒写）。
   * @param {string} rel - 相对 dataDir 的路径。
   * @param {string} label - 人读的层名。
   * @param {*} error - 原始错误。
   * @param {object} logger - 日志（`warn`）。
   * @param {object} detail - 附加字段（cwd / sessionId）。
   */
  noteLoadFailure(rel, label, error, logger, detail = {}) {
    this.loadErrors.set(rel, error instanceof Error ? error.message : String(error))
    logger.warn?.(`advisor: ${label} load failed — refuse to overwrite baseline`, { ...detail, rel, error })
  }

  // ---- 全局约束（所有项目/会话共享，2026-08-12 用户拍板） ----

  /** 读取全局约束（惰性加载文件）。 */
  globalOf(logger = console) {
    if (this.globalText === undefined) {
      let text = ''
      try {
        const parsed = this.readBaseline('global-scope.json')
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
          text = parsed.text
        }
        this.loadErrors.delete('global-scope.json')
      } catch (error) {
        this.noteLoadFailure('global-scope.json', 'global scope', error, logger)
        return ''
      }
      this.globalText = text
    }
    return this.globalText
  }

  /** 保存全局约束（空文本=清除）。 */
  setGlobal(text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    this.globalOf(logger) // 确保已加载
    this.assertBaselineWritable('global-scope.json', '全局约束')
    this.globalText = normalized
    if (normalized === '') {
      this.writeFile('global-scope.json', '')
    } else {
      this.writeFile('global-scope.json', JSON.stringify({ text: normalized }))
    }
    return normalized
  }

  // ---- 项目约束（按 cwd 隔离，项目内会话共享） ----

  /** 读取项目约束（惰性加载整文件 map）。 */
  projectOf(cwd, logger = console) {
    if (!this.projectScopes.has(cwd)) {
      let text = ''
      try {
        const parsed = this.readBaseline('project-scopes.json')
        if (parsed !== null && typeof parsed === 'object') {
          // **FIX-45③b**（与 ③ 同一处 read-modify-write，独立于"读失败"那一格）：
          // `setProject` 是「合并内存 map → 整文件回写」，而修前这里**只把当前 cwd 这一条
          // 装进内存** ⇒ 只要在 A 里保存一次，B/C 的约束就被从盘上删掉（**正常读成功时也发生**）。
          // 现在按文件语义一次性装载整张 map；已在内存里的条目不覆盖（内存可能更新）。
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && !this.projectScopes.has(key)) {
              this.projectScopes.set(key, value)
            }
          }
          text = typeof parsed[cwd] === 'string' ? parsed[cwd] : ''
        }
        this.loadErrors.delete('project-scopes.json')
      } catch (error) {
        // 不缓存空值：下次访问重试（瞬时 EACCES 自愈），写路径期间按标记拒写。
        this.noteLoadFailure('project-scopes.json', 'project scope', error, logger, { cwd })
        return ''
      }
      this.projectScopes.set(cwd, text)
    }
    return this.projectScopes.get(cwd) ?? ''
  }

  /** 保存项目约束（空文本=清除）。 */
  setProject(cwd, text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    this.projectOf(cwd, logger) // 确保已加载
    this.assertBaselineWritable('project-scopes.json', '项目约束')
    this.projectScopes.set(cwd, normalized)
    // 合并写整文件（map 持久化）
    const merged = {}
    for (const [key, value] of this.projectScopes) {
      if (value !== '') merged[key] = value
    }
    this.writeFile('project-scopes.json', JSON.stringify(merged))
    return normalized
  }

  // ---- 会话约束（按会话隔离，跨新建评审会话保留） ----

  /** 读取会话约束（惰性加载文件）。 */
  sessionOf(sessionId, logger = console) {
    if (!this.sessionScopes.has(sessionId)) {
      const rel = `session-scopes/${safeId(sessionId)}.json`
      let text = ''
      try {
        const parsed = this.readBaseline(rel)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
          text = parsed.text
        }
        this.loadErrors.delete(rel)
      } catch (error) {
        this.noteLoadFailure(rel, 'session scope', error, logger, { sessionId })
        return ''
      }
      this.sessionScopes.set(sessionId, text)
    }
    return this.sessionScopes.get(sessionId) ?? ''
  }

  /** 保存会话约束（空文本=清除）。 */
  setSession(sessionId, text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    this.sessionOf(sessionId, logger) // 确保已加载
    const rel = `session-scopes/${safeId(sessionId)}.json`
    this.assertBaselineWritable(rel, '会话约束')
    this.sessionScopes.set(sessionId, normalized)
    if (normalized === '') {
      this.writeFile(rel, '')
    } else {
      this.writeFile(rel, JSON.stringify({ text: normalized }))
    }
    return normalized
  }

  /** 会话销毁：清理内存缓存（磁盘文件保留供追溯，可重写覆盖）。 */
  disposeSession(sessionId) {
    this.sessionScopes.delete(sessionId)
    this.loadErrors.delete(`session-scopes/${safeId(sessionId)}.json`)
  }

  // ---- 评审会话约束（绑定 conversation 文件，新建评审会话即清空） ----

  /**
   * 读取评审会话约束（与 conversation 共用同一持久化文件——reset 时
   * conversation.reset 会一并清空）。读取失败仍返回 ''（**读**面不阻断评审），
   * 但记下标记 ⇒ `setConversation` 拒写。
   */
  conversationOf(sessionId, logger = console) {
    const rel = this.conversationFileOf(sessionId)
    try {
      const parsed = this.readBaseline(rel)
      this.loadErrors.delete(rel)
      return parsed !== null && typeof parsed === 'object' && typeof parsed.scopeText === 'string'
        ? parsed.scopeText
        : ''
    } catch (error) {
      this.noteLoadFailure(rel, 'conversation scope', error, logger, { sessionId })
      return ''
    }
  }

  /** 保存评审会话约束（写入 conversation 文件——需保留 messages/epoch）。 */
  setConversation(sessionId, text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    const rel = this.conversationFileOf(sessionId)
    // **基线读失败 ⇒ 拒写**（FIX-45③）：修前这里 readFile 被注入的 reader 吞成 ''，
    // 于是 `{epoch:1,messages:[]}` 覆盖整文件 —— 评审员的历史消息与 epoch 一起没了。
    // 写失败仍是"仅告警"（既有契约）；两种结果现在分得开。
    let parsed
    try {
      parsed = this.readBaseline(rel)
      this.loadErrors.delete(rel)
    } catch (error) {
      this.noteLoadFailure(rel, 'conversation', error, logger, { sessionId })
      this.assertBaselineWritable(rel, '评审会话') // 一定抛（标记刚写入）
      return normalized // 不可达；仅为让静态读者看到"读失败不落盘"
    }
    const data = parsed !== null && typeof parsed === 'object'
      ? { ...parsed, scopeText: normalized }
      : { epoch: 1, messages: [], scopeText: normalized }
    try {
      this.writeConversation(rel, JSON.stringify(data))
    } catch (error) {
      logger.warn?.('advisor: conversation scope save failed', { sessionId, error })
    }
    return normalized
  }
}

/** 会话 id 安全化为文件名（防路径穿越）。 */
function safeId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
}
