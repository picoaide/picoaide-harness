/**
 * 评审员持续会话上下文（第一轮优化 Q3 重构：用户拍板——完整上下文、无
 * 截断、可新建会话，评审员像普通 LLM 对话一样工作）。
 *
 * 每个被评审的主会话对应一条「评审员对话」：从第一条可见消息开始、永不
 * 截断的完整消息序列。实现上 llm.stream 无状态，因此"持续"通过**每次
 * 评审调用重放完整消息列表**达成（模型视角 = 完整连续对话；无截断，
 * 用户拍板：默认评审模型 1000k 上下文足够）。
 *
 * 消息角色与形态（评审员视角）：
 * - 主会话可见消息（user 输入 / agent 回复）→ role 'user'，文本带
 *   user / agent 角色标注（世界发生的事 = 她的输入流）；
 * - 评审员自己的输出（建议 / 回答，投递成功后回放）→ role 'assistant'
 *   （[nit] 建议 / [advisor] 回答——她说过的 = 她的输出流）；
 * - 用户指令 / 问题 → role 'user'（[advisor instruction] / ### User
 *   question 标记）。
 *
 * 与普通 LLM 对话的区别：评审员既在持续对话里，又通过投递层把建议
 * （steer/inject 通知）注入主会话——对话上下文负责"记得与连贯"，注入
 * 通道负责"反馈给用户"，两者经输出回放打通。（问答回答不注入主会话，
 * 2026-08-12 用户反馈：只在面板展示。）
 *
 * **持久化（2026-08-12 用户拍板）**：评审员会话写入磁盘（load/save
 * 注入），DSH 重启后自动恢复——**只有用户主动「新建评审会话」
 * （resetConversation / 面板按钮 / /advisor reset）才清空**。每次变更
 * 原子落盘（temp+rename 由调用方保证）。
 *
 * @module dsh-memory-evolve/advisor/conversation
 */

/**
 * 评审员持续会话上下文。
 *
 * @param {object} [options]
 * @param {() => { epoch?: number, messages?: Array<{role:string,text:string}> } | null} [options.load]
 *   - 持久化读取（重启恢复；返回 null=无历史）
 * @param {(epoch: number, messages: Array<{role:string,text:string}>) => void} [options.save]
 *   - 持久化写入（每次变更后调用；调用方保证原子写）
 */
export class AdvisorConversation {
  constructor(options = {}) {
    /** 消息序列（时间序）：{ role: 'user'|'assistant', text: string }。 */
    this.messages = []
    /** 新建会话代数（reset 自增；面板/记录用于区分"第几任评审员"）。 */
    this.epoch = 1
    this.loadFn = options.load ?? null
    this.saveFn = options.save ?? null
    this.loaded = false
    this.loadWarned = false
    /**
     * **基线读失败**（FIX-45③，2026-09-29）。
     *
     * 现场：`load()` 修前把读失败降级成"空会话"（一行 warn 之后照常继续），紧接着任意一次
     * `appendUser`/`reset` 就把 `{epoch:1,messages:[]}` **整文件回写** —— 评审员的整段历史
     * 与 epoch 一起没了。现在读失败只影响**内存**（评审不阻断），写面**拒写**。
     */
    this.loadFailed = false
    this.persistWarned = false
  }

  /** 当前消息条数。 */
  get length() {
    this.load()
    return this.messages.length
  }

  /** 惰性加载持久化状态（首次访问时；**读失败只降级内存**，写面由 {@link persist} 拒写）。 */
  load() {
    if (this.loaded) return
    this.loaded = true
    if (this.loadFn === null) return
    try {
      const data = this.loadFn()
      if (data !== null && typeof data === 'object') {
        if (Array.isArray(data.messages)) {
          this.messages = data.messages
            .filter((m) => m !== null && typeof m === 'object' && typeof m.text === 'string')
            .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text }))
        }
        if (Number.isInteger(data.epoch) && data.epoch > 0) this.epoch = data.epoch
      }
      this.loadFailed = false
    } catch (error) {
      // 加载失败：内存按空会话继续（评审不阻断），但**禁止回写**（见 persist）。
      this.loadFailed = true
      if (!this.loadWarned) {
        this.loadWarned = true
        console.warn?.('advisor: conversation load failed — refuse to overwrite history', { error })
      }
    }
  }

  /**
   * 追加一条「世界发生」的消息（主会话可见消息 / 指令 / 问题）。
   * @param {string} text - 带角色标注的文本（**user**: … / **agent**: … / 指令/问题原文）
   */
  appendUser(text) {
    this.load()
    this.messages.push({ role: 'user', text: String(text) })
    this.persist()
  }

  /**
   * 追加一条「评审员自己的输出」（投递成功后回放，她因此记得自己说过什么）。
   * @param {string} text - [severity] 建议 或 [advisor] 回答
   */
  appendAssistant(text) {
    this.load()
    this.messages.push({ role: 'assistant', text: String(text) })
    this.persist()
  }

  /**
   * 快照（供评审调用全量重放）。返回新数组——调用方不得原地修改。
   * @returns {Array<{role:string,text:string}>}
   */
  snapshot() {
    this.load()
    return this.messages.map((message) => ({ ...message }))
  }

  /**
   * 上下文占用统计（2026-08-12 用户反馈：面板显示已占用多少，便于决定
   * 是否新建评审会话）。字符数估算：中文 1 字≈1 token、英文约 4 字符
   * ≈1 token——展示用字符 K 做直观量级。
   * @returns {{ messageCount: number, charCount: number }}
   */
  stats() {
    this.load()
    let charCount = 0
    for (const message of this.messages) charCount += message.text.length
    return { messageCount: this.messages.length, charCount }
  }

  /**
   * 新建评审会话：清空上下文（代数自增）。guard 由调用方（runtime）一并清。
   * **评审会话约束（scopeText）一并清空**（通过 clearScope 标记让持久化
   * 层不合并旧文件里的 scopeText——2026-08-12 用户拍板四层级）。
   * @returns {number} 新代数
   */
  reset() {
    this.load()
    // FIX-45③：基线读失败时**拒绝**新建评审会话 —— 此时 `epoch` 是内存默认值 1，
    // 回写会把磁盘上的真实代数和历史一起换掉（不可逆）。整文件覆盖是显式结果，
    // 有基线不可读就必须抛给调用方（API 层映射成 400），而不是"静默重置 + 200"。
    if (this.loadFailed) {
      throw new Error('advisor: 评审会话基线不可读 —— 已拒绝新建评审会话'
        + '（以空基线回写会抹掉评审员历史与 epoch；请先恢复该文件的可读性）')
    }
    this.messages.length = 0
    this.epoch += 1
    this._clearScope = true
    this.persist()
    this._clearScope = false
    return this.epoch
  }

  /**
   * 原子持久化（saveFn 由调用方注入）。
   *
   * 三种结果现在分得开（FIX-45③）：
   *   · 没有写通道（`saveFn === null`）⇒ 无操作，返回 `false`；
   *   · **基线不可读** ⇒ **拒绝写入**（不落盘、可检索日志），返回 `false`
   *     —— 修前这里照常写，把"读失败"固化成一次整文件覆盖；
   *   · 写失败 ⇒ 仅告警一次（既有契约），返回 `false`。
   * @returns {boolean} 是否真的写成功。
   */
  persist() {
    if (this.saveFn === null) return false
    if (this.loadFailed) {
      if (!this.persistWarned) {
        this.persistWarned = true
        console.warn?.('advisor: conversation persist refused — baseline unreadable '
          + '(refuse to overwrite history)', { epoch: this.epoch, messages: this.messages.length })
      }
      return false
    }
    try {
      this.saveFn(this.epoch, this.messages, { clearScope: this._clearScope === true })
      return true
    } catch (error) {
      if (!this.loadWarned) {
        this.loadWarned = true
        console.warn?.('advisor: conversation persist failed', { error })
      }
      return false
    }
  }
}
