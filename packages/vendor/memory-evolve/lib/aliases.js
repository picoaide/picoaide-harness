/**
 * 会话别名仓库（aliases.json）— 会话的友好名称。
 *
 * 会话 ID（session-xxx）对用户不友好：广播面板/快照里满屏长 ID。别名
 * 是**会话的全局属性**（不只广播用——快照「你的会话」段的其他消费者
 * 也需要），独立存储于 <memoryDir>/aliases.json：
 *   { sessionId: 别名 }（最多 10 字，允许重复——ID 才是唯一标识）
 *
 * 显示策略（别名优先）：有别名显示「别名」，无别名回退短 ID；完整 ID
 * 悬停/括号可见（AI 发消息仍需要 ID）。
 * 修改 = 覆盖；清空/删除 = 移除别名。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translate, getLocale, MISC2_DICT } from './i18n.js'
import { writeFileAtomicSafeAt } from './sync/filesets.js'

/** Translate through MISC2_DICT in the active host locale. */
const alt = (key, params) => translate(MISC2_DICT, key, params, getLocale())

/** 别名长度上限（10 个字符，中文友好）。 */
export const ALIAS_MAX_LEN = 10

/**
 * 读取别名字典（live-read：快照/面板每次读文件，写入即时生效）。
 * @param {string} dir - memoryDir。
 * @returns {Record<string, string>} { sessionId: 别名 }
 */
export function readAliases(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {} // 文件缺失/损坏：空表
  }
}

export class AliasStore {
  /**
   * @param {string} dir - memoryDir（aliases.json 所在目录）。
   */
  constructor(dir) {
    this.file = join(dir, 'aliases.json')
    this.aliases = readAliases(dir)
  }

  #save() {
    // FIX-27（2026-09-13）：改走**自锚定安全原子写**（tmp 落点同样断言 +
    // O_EXCL 按 fd 写入 + rename 前后复检）——预置同名符号链接即写穿到目录外，
    // 曾被静默当成"写成功"。
    writeFileAtomicSafeAt(this.file, JSON.stringify(this.aliases, null, 2) + '\n')
  }

  /** 取别名；无返回 undefined。 */
  get(sessionId) {
    return this.aliases[sessionId]
  }

  /**
   * 设置别名（覆盖；空串/纯空格 = 清除）。
   * 落盘被拒（悬空链接/越界/预置同名条目）如实返回 `{ok:false}` 并回滚内存态——
   * 第一轮把拒绝直接抛出 `set()`，调用方（HTTP/命令面）只能拿到 500 且原因不可读。
   * @param {string} sessionId
   * @param {string} name
   * @returns {{ok:boolean, message:string}}
   */
  set(sessionId, name) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return { ok: false, message: alt('alias.needsSid') }
    const text = String(name ?? '').trim()
    if (text === '') {
      // 清空 = 移除别名
      if (this.aliases[sid] !== undefined) {
        const previous = this.aliases[sid]
        delete this.aliases[sid]
        try {
          this.#save()
        } catch (error) {
          this.aliases[sid] = previous
          return { ok: false, message: alt('alias.saveFail', { detail: error?.message ?? String(error) }) }
        }
      }
      return { ok: true, message: alt('alias.cleared') }
    }
    if (text.length > ALIAS_MAX_LEN) {
      return { ok: false, message: alt('alias.tooLong', { max: ALIAS_MAX_LEN, len: text.length }) }
    }
    const previous = this.aliases[sid]
    this.aliases[sid] = text
    try {
      this.#save()
    } catch (error) {
      if (previous === undefined) delete this.aliases[sid]
      else this.aliases[sid] = previous
      return { ok: false, message: alt('alias.saveFail', { detail: error?.message ?? String(error) }) }
    }
    return { ok: true, message: alt('alias.set', { alias: text }) }
  }

  /** 清除别名。 */
  remove(sessionId) {
    return this.set(sessionId, '')
  }

  /** 全部别名（面板一次拉取渲染）。 */
  all() {
    return { ...this.aliases }
  }
}
