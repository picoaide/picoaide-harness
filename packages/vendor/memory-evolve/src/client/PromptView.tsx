/**
 * dsh-memory-evolve — 提示词 tab（conversation.view 第四个 entry）。
 *
 * 提示词管理器：可复用的指令范式资产库 + 注入执行器。
 *   - 库：CRUD + 分类 + 标签 + 搜索筛选 + 复制 + 使用统计；来源以用户
 *     自写为主，内置程序员范式示例，另附 GitHub 范式库链接（用户自取）。
 *   - 注入：选中提示词 → 选择轮数 → 写注入轨（host 端），模型**下一轮**
 *     自动看到（一次性 = 1 轮；持续 N 轮 = 每对话回合递减，归零移除）；
 *     「注入中」浮层可随时提前移除。
 *
 * 数据来自 host 的 /memory-evolve/api/prompts 路由；样式在
 * prompt-styles.css（pm- 前缀，由 index.ts 注入）。
 *
 * i18n（2026-09-16）：本文件原先自带一份 118 键的 zh/en 私有字典（外加
 * 一处 `pick(zh, en)` 内联双语文案），经 clientLang 跟随界面语言，但
 * **绕开了注册字典**（ctx.locale）——等于第二份真源。现在全部文案并入
 * src/client/index.ts 的 zh/en（键前缀 'prompt.'），经 slot 注入的 t 在
 * 调用期取当前语言；键类型用 MemoryEvolveKey 收窄，漏键编译期即报。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TabGuideView } from './TabGuideView.tsx'
import type { MemoryEvolveKey } from './index.ts'

/** 提示词条目（与 host 端 PromptStore 一致）。 */
interface Prompt {
  id: string
  name: string
  /** 简介：一句话说明用途（AI 的 de_prompts 列表选词时看这里；列表摘要优先显示它） */
  description: string
  category: string
  tags: string[]
  content: string
  /** 启用状态：false = 禁用（不出现在 AI 的 de_prompts 列表、不能注入；GUI 仍可见可编辑） */
  enabled: boolean
  createdAt: number
  updatedAt: number
  usageCount: number
  lastUsedAt: number | null
}

/** 活跃注入条目（与 host 端 InjectionStore 一致）。roundsLeft=null 表示无限。 */
interface Injection {
  id: string
  sourcePromptId: string | null
  title: string
  content: string
  roundsLeft: number | null
  every: number
  countdown: number
  createdAt: number
}

/** GitHub 范式来源链接。 */
interface Source {
  name: string
  url: string
  desc: string
}

/** Locale-bound props（与 MemoryTabView 一致，宽类型 Translate）。 */
export interface PromptViewProps {
  t: Translate
}



/**
 * 本视图的字典键域名（'prompt.' 前缀；真源 = src/client/index.ts 的 zh/en）。
 *
 * 2026-09-16：此前这里是模块内的 `DICT = { zh, en }` 私有字典 + `pick(zh, en)`
 * 内联双语对 —— 现在只保留键，取值一律经注册字典的 t（调用期解析语言）。
 */
type DictKey = Extract<MemoryEvolveKey, `prompt.${string}`>

/**
 * 造一个「本视图键 → 当前语言文案」的查询函数。
 *
 * ⚠️ 必须每个组件各持一份（`const t = dict(props.t)`）：模块级常量/闭包在
 * 求值时早于插件 apply，那时 t 只能拿到默认语言，等于把界面语言钉死。
 *
 * ⚠️ `params` 必须透传：本视图目前用 `fillPlaceholders` 自己插值，所以收窄成
 * `(key) => t(key)` 暂时看不出问题；但同一个包装器在 CoIView 上已经因为丢参
 * 把 9 处文案渲染成 `{count}` 模板原文（2026-09-16 R9 审计 P1），这里保持同一
 * 形状以免重蹈。
 */
function dict(t: Translate): (key: DictKey, params?: Record<string, unknown>) => string {
  return (key, params) => t(key, params)
}

/** 统一错误文本。 */
function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message || 'unknown error'
}

/** 格式化时间为本地字符串。 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** 便捷 fetch：JSON 请求 + 统一错误抛出。 */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

/** 注入参数（次数/间隔）由用户自由输入任意整数，不再限定固定选项。 */

/**
 * 解析注入参数输入框文本 → 合法数字。
 *   rounds：空 = 0（无限）；必须 ≥0 整数。
 *   every：空 = 1（每回合）；必须 ≥0 整数（**0 = 只注入一次**，host 端
 *   会把次数覆盖为 1、出现一次即结束——用户"间隔 0"的直觉语义）。
 * host 端有同样的校验兜底，这里先拦一次给出友好文案。
 * @returns {{rounds: number, every: number}} 解析后的数字。
 */
function parseInjectNums(roundsText: string, everyText: string, say: (k: DictKey) => string): { rounds: number; every: number } {
  const rounds = roundsText.trim() === '' ? 0 : Number(roundsText)
  const every = everyText.trim() === '' ? 1 : Number(everyText)
  if (!Number.isInteger(rounds) || rounds < 0) throw new Error(say('prompt.roundsInvalid'))
  if (!Number.isInteger(every) || every < 0) throw new Error(say('prompt.everyInvalid'))
  return { rounds, every }
}

/** 注入效果即时预览：次数 × 间隔 → 实际行为，帮用户理解组合语义。 */
function EffectHint(props: {
  roundsText: string
  everyText: string
  say: (k: DictKey) => string
}): JSX.Element | null {
  const r = props.roundsText.trim() === '' ? 0 : Number(props.roundsText)
  const e = props.everyText.trim() === '' ? 1 : Number(props.everyText)
  if (!Number.isInteger(r) || r < 0 || !Number.isInteger(e) || e < 0) return null
  const D = props.say
  let text: string
  if (e === 0) {
    text = D('prompt.effectOnce') // 间隔 0 = 一次性（次数被覆盖为 1）
  } else if (r === 0) {
    text = e === 1 ? D('prompt.effectInfinite') : D('prompt.effectInfiniteCadence').replace('{n}',() => (String(e)))
  } else if (r === 1) {
    text = D('prompt.effectOnce')
  } else {
    text = e === 1 ? D('prompt.effectFinite').replace('{n}',() => (String(r))) : D('prompt.effectFiniteCadence').replace('{n}',() => (String(r))).replace('{m}',() => (String(e)))
  }
  return <div className="pm-effect-hint">{text}</div>
}

/** 注入次数/间隔数字输入框（type=number，任意整数；hint 展示语义说明）。 */
function NumInput(props: {
  label: string
  hint: string
  value: string
  min: number
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <label className="pm-field pm-num-field">
      <span className="pm-field-label">
        {props.label}
        <span className="pm-field-hint">{props.hint}</span>
      </span>
      <input
        type="number"
        className="pm-input pm-num-input"
        min={props.min}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  )
}

/**
 * 提示词 tab 组件。三栏信息架构：
 *   顶栏（搜索/筛选/注入中/新建/来源）→ 左分类树 → 中列表 → 右详情表单。
 * 操作成功（保存/删除/注入/移除）后重新拉取列表，保持数据一致。
 */
/**
 * Fill `{name}` placeholders in ONE pass.
 *
 * Chained `.replace('{a}', value).replace('{b}', value)` re-scans already
 * inserted values, so a user-provided title/hint containing `{b}` would be
 * silently rewritten. Values are data, never templates (2026-09-16 audit R4-F1).
 * @param text - template text.
 * @param values - placeholder values (missing keys stay literal).
 * @returns the filled text.
 */
function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/gu, (match, name: string) => (Object.hasOwn(values, name) ? values[name] : match))
}

export function PromptView(props: ConvViewProps & PromptViewProps): JSX.Element {
  const t = dict(props.t)
  // `params` 必须透传（与 dict() 同一条契约）：缺失会把 {name} 之类的模板原文
  // 直接渲染给用户（2026-09-16 R9/R2 审计）。
  const say = (key: DictKey, params?: Record<string, unknown>): string => t(key, params)

  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [injections, setInjections] = useState<Injection[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [categories, setCategories] = useState<string[]>([])
  /** 子视图：guide=本 Tab 指南；main=提示词库（默认）。 */
  const [view, setView] = useState<'guide' | 'main'>('main')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showInjections, setShowInjections] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 注入参数输入框文本（自由数字；'' 表示未输入，解析时回默认）。 */
  const [roundsText, setRoundsText] = useState('0') // 默认无限次
  const [everyText, setEveryText] = useState('1') // 默认每回合
  /** 自定义注入区是否展开（默认收起——普通用户用预设按钮即可）。 */
  const [customOpen, setCustomOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 分类管理：正在添加新分类（显示输入框）。 */
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  /** 分类管理：正在重命名的分类名（非 null = 行内编辑中）。 */
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 详情表单字段（选中或新建时填充；编辑直接改表单再保存）。
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [formCategory, setFormCategory] = useState('')
  const [tags, setTags] = useState('')
  const [content, setContent] = useState('')
  /** 启用状态（默认 true）；禁用后不出现在 AI 的 de_prompts 列表、不能注入 */
  const [enabled, setEnabled] = useState(true)

  // 浮层点击外部关闭。
  const overlayRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (overlayRef.current === null || overlayRef.current.contains(e.target as Node)) return
      setShowInjections(false)
      setShowSources(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const showError = useCallback((err: unknown): void => {
    setError(errText(err))
  }, [])
  const showNotice = useCallback((text: string): void => {
    setNotice(text)
    window.setTimeout(() => setNotice(null), 4000)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const [p, i, c] = await Promise.all([
        api<{ prompts: Prompt[] }>('/memory-evolve/api/prompts'),
        api<{ injections: Injection[] }>('/memory-evolve/api/prompts/injections'),
        api<{ categories: string[] }>('/memory-evolve/api/prompts/categories'),
      ])
      setPrompts(p.prompts)
      setInjections(i.injections)
      setCategories(c.categories)
    } catch (err) {
      showError(say('prompt.loadFailed').replace('{message}',() => (errText(err))))
    }
  }, [showError])

  useEffect(() => {
    void load()
    void api<{ sources: Source[] }>('/memory-evolve/api/prompts/sources')
      .then((data) => setSources(data.sources))
      .catch(() => { /* 来源链接是锦上添花，失败静默 */ })
  }, [load])

  // 分类树展示列表：受管分类 + 提示词中出现的其他分类（老数据兜底，防隐身）。
  const displayCategories = useMemo(() => {
    const promptCats = prompts.map((p) => p.category).filter((c) => c && c !== '未分类')
    return [...new Set([...categories, ...promptCats])].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [categories, prompts])

  /** 未分类条目数（分类树「未分类」视图用）。 */
  const uncategorizedCount = useMemo(
    () => prompts.filter((p) => p.category === '未分类').length,
    [prompts],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return prompts.filter((p) => {
      if (category !== '全部' && p.category !== category) return false
      if (!q) return true
      return p.name.toLowerCase().includes(q)
        || p.category.toLowerCase().includes(q)
        || p.tags.some((t) => t.toLowerCase().includes(q))
        || p.content.toLowerCase().includes(q)
    })
  }, [prompts, search, category])

  const selected = prompts.find((p) => p.id === selectedId) ?? null

  /** 选中一个提示词 → 填充表单（丢弃未保存的编辑）。 */
  const selectPrompt = (id: string): void => {
    const p = prompts.find((x) => x.id === id)
    if (!p) return
    setSelectedId(id)
    setCreating(false)
    setName(p.name)
    setDescription(p.description ?? '')
    setFormCategory(p.category === '未分类' ? '' : p.category)
    setTags(p.tags.join(', '))
    setContent(p.content)
    setEnabled(p.enabled !== false)
  }

  /** 进入新建模式：清空表单。 */
  const startCreate = (): void => {
    setSelectedId(null)
    setCreating(true)
    setName('')
    setDescription('')
    setFormCategory('')
    setTags('')
    setContent('')
    setEnabled(true)
    setError(null)
  }

  const savePrompt = async (): Promise<void> => {
    if (busy) return
    const body = {
      name,
      description,
      category: formCategory,
      tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      content,
      enabled,
    }
    setBusy(true)
    try {
      if (creating) {
        const created = await api<{ prompt: Prompt }>('/memory-evolve/api/prompts', { method: 'POST', body: JSON.stringify(body) })
        await load()
        setCreating(false)
        setSelectedId(created.prompt.id)
      } else if (selectedId !== null) {
        await api(`/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}`, { method: 'PUT', body: JSON.stringify(body) })
        await load()
      }
    } catch (err) {
      showError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const deletePrompt = async (): Promise<void> => {
    if (selectedId === null) return
    const text = say('prompt.deleteConfirm').replace('{name}',() => (selected?.name ?? ''))
    if (!window.confirm(text)) return
    try {
      await api(`/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}`, { method: 'DELETE' })
      setSelectedId(null)
      setCreating(false)
      await load()
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 注入成功后的统一收尾：提示 + 重拉 + 打开注入浮层 + 通知 Tab 红点刷新。 */
  const afterInjected = async (injection: Injection): Promise<void> => {
    // 注入成功提示：次数+间隔组合的**实际行为**（rounds=1 是一次性，
    // 不是每回合重复——避免"1 次，每回合"歧义），与 host 端 message 同构：
    //   次数：只注入一次 / 注入 N 次 / 持续注入（无限）
    //   节奏括号：every=0 无 /（每回合出现）/（每 N 回合出现）
    //   收尾：之后自动结束 / 用尽自动结束 / 直到手动停止
    const times = injection.roundsLeft === null
      ? say('prompt.injectInfiniteShort')
      : injection.roundsLeft === 1
        ? say('prompt.onceOnly')
        : say('prompt.injectRound').replace('{n}',() => (String(injection.roundsLeft)))
    // 节奏括号：every=0 或只注入一次（roundsLeft=1）时省略——一次性注入
    // 无需说明节奏，避免"只注入一次（每回合出现）"的矛盾感
    const cadence = injection.every === 0 || injection.roundsLeft === 1
      ? ''
      : (injection.every ?? 1) === 1
        ? say('prompt.everyTurnParen')
        : say('prompt.injectCadenceParen').replace('{n}',() => (String(injection.every)))
    const ending = injection.every === 0 || injection.roundsLeft === 1
      ? say('prompt.injectedOnceEnding')
      : injection.roundsLeft === null
        ? say('prompt.injectedInfiniteEnding')
        : say('prompt.injectedFiniteEnding')
    showNotice(fillPlaceholders(say('prompt.injected'), {
      name: injection.title, rounds: times, cadence, ending,
    }))
    await load()
    setShowInjections(true)
    window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
  }

  /** 注入选中提示词（次数/间隔来自自由数字输入框，自定义区用）。 */
  const injectPrompt = async (): Promise<void> => {
    if (selectedId === null) return
    let nums: { rounds: number; every: number }
    try {
      nums = parseInjectNums(roundsText, everyText, say)
    } catch (err) {
      showError(errText(err))
      return
    }
    try {
      const data = await api<{ injection: Injection }>(
        `/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}/inject`,
        { method: 'POST', body: JSON.stringify(nums) },
      )
      await afterInjected(data.injection)
    } catch (err) {
      showError(errText(err))
    }
  }

  /**
   * 预设注入（一键按钮，不读输入框）：覆盖最常见场景——「注入一次」
   * （rounds=1, every=0，下一轮出现一次即结束）与「持续注入」
   * （rounds=0, every=1，每回合出现直到手动停止）。普通用户无需理解
   * 次数×间隔的模型，点按钮即用。
   */
  const injectPreset = async (rounds: number, every: number): Promise<void> => {
    if (selectedId === null) return
    try {
      const data = await api<{ injection: Injection }>(
        `/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}/inject`,
        { method: 'POST', body: JSON.stringify({ rounds, every }) },
      )
      await afterInjected(data.injection)
    } catch (err) {
      showError(errText(err))
    }
  }

  /**
   * 立即注入（⚡ 按钮）：忽略次数/间隔输入框——host 端固定写一次性注入轨
   * （只注入一次）+ 对当前会话发 next-step 插话，**当前回合立即生效**
   * （会话空闲则马上唤醒）。steered=false 表示插话未送达（降级下一轮）。
   */
  const injectNow = async (promptId: string): Promise<void> => {
    try {
      const data = await api<{ injection: Injection; steered: boolean }>(
        `/memory-evolve/api/prompts/${encodeURIComponent(promptId)}/inject`,
        { method: 'POST', body: JSON.stringify({ immediate: true, sessionId: props.sessionId }) },
      )
      const name = data.injection.title
      showNotice(data.steered ? say('prompt.injectedNow').replace('{name}',() => (name)) : say('prompt.injectedNowFallback').replace('{name}',() => (name)))
      await load()
      setShowInjections(true)
      window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
    } catch (err) {
      showError(errText(err))
    }
  }

  /**
   * 临时注入（详情栏未选中提示词时）：内容直接注入，一步完成"自动入库 +
   * 注入生效"，解决"必须先把提示词存进库才能注入"的流程问题。
   *   1. 校验内容非空；参数：preset 预设（一键按钮）或输入框解析（自定义区）；
   *   2. POST /prompts 创建（分类留空 → host 自动归入「临时」；名称留空
   *      取内容首行前 20 字，保证注入轨与列表都有可读标题）；
   *   3. POST /:id/inject 注入（immediate=true 时立即注入）→ 选中新条目。
   * @param {object} [preset] - 预设参数（{rounds, every}）；缺省读输入框。
   * @param {boolean} [immediate] - true=立即注入（只注入一次，忽略次数/间隔）。
   */
  const quickInject = async (preset?: { rounds: number; every: number }, immediate = false): Promise<void> => {
    if (busy) return
    const text = content.trim()
    if (!text) {
      showError(say('prompt.contentRequired'))
      return
    }
    let nums: { rounds: number; every: number }
    if (preset !== undefined) {
      nums = preset // 一键按钮：不读输入框
    } else {
      try {
        nums = parseInjectNums(roundsText, everyText, say)
      } catch (err) {
        showError(errText(err))
        return
      }
    }
    setBusy(true)
    try {
      // 名称留空 → 取内容首个非空行前 20 字（截断 + 省略号标识）
      const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
      const promptName = name.trim() || (firstLine.length > 20 ? `${firstLine.slice(0, 20)}…` : firstLine) || say('prompt.untitledName')
      const created = await api<{ prompt: Prompt }>('/memory-evolve/api/prompts', {
        method: 'POST',
        body: JSON.stringify({
          name: promptName,
          description,
          category: formCategory.trim(),
          tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
          content: text,
          enabled,
        }),
      })
      // immediate=true：立即注入（只注入一次，忽略次数/间隔）
      const data = immediate
        ? await api<{ injection: Injection; steered: boolean }>(
          `/memory-evolve/api/prompts/${encodeURIComponent(created.prompt.id)}/inject`,
          { method: 'POST', body: JSON.stringify({ immediate: true, sessionId: props.sessionId }) },
        )
        : await api<{ injection: Injection }>(
          `/memory-evolve/api/prompts/${encodeURIComponent(created.prompt.id)}/inject`,
          { method: 'POST', body: JSON.stringify(nums) },
        )
      if (immediate) {
        const name = data.injection.title
        showNotice((data as { steered: boolean }).steered ? say('prompt.injectedNow').replace('{name}',() => (name)) : say('prompt.injectedNowFallback').replace('{name}',() => (name)))
      } else {
        await afterInjected(data.injection)
      }
      selectPrompt(created.prompt.id) // 回填表单：新建条目已选中，可改名/改分类
    } catch (err) {
      showError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const removeInjection = async (id: string): Promise<void> => {
    try {
      await api(`/memory-evolve/api/prompts/injections/${encodeURIComponent(id)}`, { method: 'DELETE' })
      showNotice(say('prompt.stoppedInjection'))
      await load()
      window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 该提示词当前是否有活跃注入（列表徽标 / 详情状态用）。 */
  const activeInjectionOf = (promptId: string): Injection | undefined =>
    injections.find((i) => i.sourcePromptId === promptId)

  /** 注入节奏文案（只注入一次 / 每回合 / 每 N 回合一次）。 */
  const cadenceLabel = (inj: Injection): string => {
    if (inj.every === 0) return say('prompt.onceOnly')
    return (inj.every ?? 1) === 1
      ? say('prompt.everyTurn')
      : say('prompt.injectCadence').replace('{n}',() => (String(inj.every)))
  }

  /** 剩余次数文案（null = 无限）。 */
  const remainingLabel = (inj: Injection): string =>
    inj.roundsLeft === null ? say('prompt.injectInfinite') : say('prompt.injectRound').replace('{n}',() => (String(inj.roundsLeft)))

  /** 添加分类（受管列表）。**幂等**：同名已存在时不报错，提示并选中已有分类。 */
  const addCategory = async (): Promise<void> => {
    const name = newCategoryName.trim()
    if (!name) return
    try {
      const data = await api<{ categories: string[]; alreadyExists: boolean }>('/memory-evolve/api/prompts/categories', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setCategories(data.categories)
      setCategory(name)
      setNewCategoryName('')
      setAddingCategory(false)
      if (data.alreadyExists) showNotice(say('prompt.categoryExists').replace('{name}',() => (name)))
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 重命名分类：受管列表替换 + 该分类下提示词同步改名。 */
  const renameCategory = async (from: string): Promise<void> => {
    const to = renameValue.trim()
    if (!to || to === from) {
      setRenamingCategory(null)
      setRenameValue('')
      return
    }
    try {
      const data = await api<{ categories: string[]; renamed: number }>(
        `/memory-evolve/api/prompts/categories/${encodeURIComponent(from)}`,
        { method: 'PUT', body: JSON.stringify({ name: to }) },
      )
      setCategories(data.categories)
      if (category === from) setCategory(to)
      setRenamingCategory(null)
      setRenameValue('')
      await load()
      const suffix = data.renamed > 0 ? say('prompt.categoryRenamedSuffix').replace('{count}',() => (String(data.renamed))) : ''
      showNotice(`${fillPlaceholders(say('prompt.categoryRenamed'), { from, to, renamed: '' })}${suffix}`)
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 删除分类：确认后调用 API（该分类下提示词自动移到未分类）。 */
  const removeCategory = async (name: string): Promise<void> => {
    const count = prompts.filter((p) => p.category === name).length
    const hint = count > 0 ? say('prompt.categoryMoved').replace('{count}',() => (String(count))) : ''
    const confirmText = fillPlaceholders(say('prompt.deleteCategoryConfirm'), { name, hint })
    if (!window.confirm(confirmText)) return
    try {
      const data = await api<{ removed: boolean; moved: number }>(
        `/memory-evolve/api/prompts/categories/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      const cats = await api<{ categories: string[] }>('/memory-evolve/api/prompts/categories')
      setCategories(cats.categories)
      if (category === name) setCategory('全部')
      await load()
      const moved = data.moved > 0 ? say('prompt.categoryMoved').replace('{count}',() => (String(data.moved))) : ''
      showNotice(`${say('prompt.categoryDeleted').replace('{name}',() => (name))}${moved}`)
    } catch (err) {
      showError(errText(err))
    }
  }

  const copyPrompt = async (): Promise<void> => {
    const text = selected?.content ?? ''
    try {
      await navigator.clipboard.writeText(text)
      showNotice(say('prompt.copied'))
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 列表摘要：优先显示简介（AI 选词看的字段）；简介为空回退内容首行。 */
  const summaryLine = (p: Prompt): string => {
    const desc = (p.description ?? '').trim()
    if (desc) return desc.length > 60 ? `${desc.slice(0, 60)}…` : desc
    const first = p.content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
    return first.length > 60 ? `${first.slice(0, 60)}…` : first
  }

  const selectedIsDirty = selected !== null && (
    name !== selected.name
    || description !== (selected.description ?? '')
    || (formCategory || '未分类') !== selected.category
    || tags !== selected.tags.join(', ')
    || content !== selected.content
    || enabled !== (selected.enabled !== false)
  )

  return (
    <div className="pm-root">
      {/* 子 tab 条：指南 / 提示词库（复用 mt- 样式，与其他 Tab 一致） */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'guide'}
          className={view === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('guide')}
        >
          {say('prompt.guide')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'main'}
          className={view === 'main' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('main')}
        >
          {say('prompt.library')}
        </button>
      </div>
      {view === 'guide' ? (
        // 提示词注入专属指南（本 Tab 功能详细介绍，文案见 DICT guide* 键）
        <TabGuideView sections={[
          { icon: '📌', title: say('prompt.guideIntro'), body: '' },
          { icon: '📚', title: say('prompt.guideLibTitle'), body: say('prompt.guideLibBody'), items: [say('prompt.guideLibItem1'), say('prompt.guideLibItem2'), say('prompt.guideLibItem3'), say('prompt.guideLibItem4'), say('prompt.guideLibItem5')] },
          { icon: '💉', title: say('prompt.guideInjectTitle'), body: say('prompt.guideInjectBody'), items: [say('prompt.guideInjectItem1'), say('prompt.guideInjectItem2'), say('prompt.guideInjectItem3'), say('prompt.guideInjectItem4')] },
          { icon: '🔴', title: say('prompt.guideTrackTitle'), body: say('prompt.guideTrackBody') },
          { icon: '⚙️', title: say('prompt.guideSwitchTitle'), body: say('prompt.guideSwitchBody') },
        ]} />
      ) : (
        <>
      {/* 顶栏：搜索 / 筛选 / 注入中 / 来源 / 新建 */}
      <div className="pm-toolbar">
        <input
          className="pm-search"
          placeholder={say('prompt.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="pm-select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          title={say('prompt.category')}
        >
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          type="button"
          className="pm-tool-btn"
          onClick={() => { setShowInjections(!showInjections); setShowSources(false) }}
          title={say('prompt.injectHint')}
        >
          {say('prompt.injecting')}{injections.length > 0 ? ` (${injections.length})` : ''}
        </button>
        <button
          type="button"
          className="pm-tool-btn"
          onClick={() => { setShowSources(!showSources); setShowInjections(false) }}
        >
          {say('prompt.sources')}
        </button>
        <button type="button" className="pm-primary-btn" onClick={startCreate}>{say('prompt.new')}</button>
      </div>

      {/* 顶栏消息（错误 / 提示） */}
      {(error !== null || notice !== null) && (
        <div className={`pm-banner ${error !== null ? 'pm-banner-error' : ''}`}>
          {error !== null ? error : notice}
          {error !== null && (
            <button type="button" className="pm-banner-close" onClick={() => setError(null)}>×</button>
          )}
        </div>
      )}

      {/* 注入中浮层 */}
      {showInjections && (
        <div className="pm-overlay" ref={overlayRef}>
          <div className="pm-overlay-title">{say('prompt.injecting')}</div>
          {injections.length === 0 && <div className="pm-overlay-empty">{say('prompt.noInjection')}</div>}
          {injections.map((inj) => (
            <div key={inj.id} className="pm-overlay-item">
              <div className="pm-overlay-item-main">
                <div className="pm-overlay-item-title">{say('prompt.quotedTitle').replace('{name}',() => (inj.title))}</div>
                <div className="pm-overlay-item-sub">
                  {remainingLabel(inj)} · {cadenceLabel(inj)}
                </div>
              </div>
              <button type="button" className="pm-danger-btn pm-overlay-remove" onClick={() => void removeInjection(inj.id)}>
                {say('prompt.removeInjection')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* GitHub 来源浮层 */}
      {showSources && (
        <div className="pm-overlay pm-overlay-wide" ref={overlayRef}>
          <div className="pm-overlay-title">{say('prompt.sources')}</div>
          <div className="pm-overlay-sub">{say('prompt.sourcesHint')}</div>
          {sources.map((s) => (
            <div key={s.url} className="pm-source-item">
              <a className="pm-source-link" href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
              <div className="pm-source-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      )}

      {/* 三栏主体 */}
      <div className="pm-body">
        {/* 左：分类树（受管分类 + 未分类兜底 + 添加/删除管理） */}
        <div className="pm-pane-cats">
          <button
            type="button"
            className={`pm-cat ${category === '全部' ? 'pm-cat-active' : ''}`}
            onClick={() => setCategory('全部')}
          >
            <span className="pm-cat-name">{say('prompt.all')}</span>
            <span className="pm-cat-count">{prompts.length}</span>
          </button>
          {displayCategories.map((c) => {
            const count = prompts.filter((p) => p.category === c).length
            if (renamingCategory === c) {
              // 行内重命名编辑
              return (
                <div key={c} className="pm-cat-row">
                  <input
                    className="pm-cat-add-input"
                    autoFocus
                    placeholder={say('prompt.renamePh')}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void renameCategory(c)
                      if (e.key === 'Escape') { setRenamingCategory(null); setRenameValue('') }
                    }}
                  />
                  <button type="button" className="pm-cat-add-ok" onClick={() => void renameCategory(c)}>✓</button>
                </div>
              )
            }
            return (
              <div key={c} className="pm-cat-row">
                <button
                  type="button"
                  className={`pm-cat ${category === c ? 'pm-cat-active' : ''}`}
                  onClick={() => setCategory(c)}
                >
                  <span className="pm-cat-name">{c}</span>
                  <span className="pm-cat-count">{count}</span>
                </button>
                <button
                  type="button"
                  className="pm-cat-del"
                  title={say('prompt.renameCategory')}
                  onClick={() => { setRenamingCategory(c); setRenameValue(c) }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="pm-cat-del"
                  title={say('prompt.deleteCategory')}
                  onClick={() => void removeCategory(c)}
                >
                  ×
                </button>
              </div>
            )
          })}
          {uncategorizedCount > 0 && (
            <button
              type="button"
              className={`pm-cat ${category === '未分类' ? 'pm-cat-active' : ''}`}
              onClick={() => setCategory('未分类')}
            >
              <span className="pm-cat-name">{say('prompt.uncategorized')}</span>
              <span className="pm-cat-count">{uncategorizedCount}</span>
            </button>
          )}
          {addingCategory ? (
            <div className="pm-cat-add">
              <input
                className="pm-cat-add-input"
                autoFocus
                placeholder={say('prompt.newCategoryPh')}
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addCategory()
                  if (e.key === 'Escape') { setAddingCategory(false); setNewCategoryName('') }
                }}
              />
              <button type="button" className="pm-cat-add-ok" onClick={() => void addCategory()}>✓</button>
            </div>
          ) : (
            <button type="button" className="pm-cat-add-btn" onClick={() => setAddingCategory(true)}>
              {say('prompt.plusGlyph')} {say('prompt.newCategory')}
            </button>
          )}
        </div>

        {/* 中：列表 */}
        <div className="pm-pane-list">
          {prompts.length === 0 && <div className="pm-pane-empty">{say('prompt.empty')}</div>}
          {prompts.length > 0 && filtered.length === 0 && <div className="pm-pane-empty">{say('prompt.noMatch')}</div>}
          {filtered.map((p) => {
            const active = activeInjectionOf(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={`pm-item ${selectedId === p.id && !creating ? 'pm-item-active' : ''} ${p.enabled === false ? 'pm-item-disabled' : ''}`}
                onClick={() => selectPrompt(p.id)}
              >
                <div className="pm-item-row1">
                  <span className="pm-item-name">{p.name}</span>
                  <span className="pm-item-badge">{p.category}</span>
                  {p.enabled === false && (
                    <span className="pm-item-badge pm-item-badge-off" title={say('prompt.disabledHint')}>
                      {say('prompt.enabledOff')}
                    </span>
                  )}
                  {active !== undefined && (
                    <span className="pm-item-badge pm-item-badge-active" title={say('prompt.injectHint')}>
                      {active.roundsLeft === null
                        ? say('prompt.injectingBadgeInfinite')
                        : say('prompt.injectingBadge').replace('{n}',() => (String(active.roundsLeft)))}
                    </span>
                  )}
                </div>
                <div className="pm-item-summary">{summaryLine(p)}</div>
                <div className="pm-item-row3">
                  <span className="pm-item-usage">
                    {say('prompt.usage').replace('{n}',() => (String(p.usageCount ?? 0)))}
                  </span>
                  <span className="pm-item-used">
                    {p.lastUsedAt !== null
                      ? say('prompt.lastUsed').replace('{time}',() => (formatTime(p.lastUsedAt)))
                      : say('prompt.neverUsed')}
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        {/* 右：详情表单 */}
        <div className="pm-pane-detail">
          {(selected === null && !creating) && (
            // 未选中提示词 → 「临时注入」快速表单：不建提示词也能直接注入
            // （自动入库 + 注入一步完成，分类留空归入「临时」）
            <div className="pm-form">
              <div className="pm-form-title">{say('prompt.quickTitle')}</div>
              <div className="pm-quick-sub">{say('prompt.quickDesc')}</div>
              <label className="pm-field">
                <span className="pm-field-label">{say('prompt.name')}</span>
                <input
                  className="pm-input"
                  placeholder={say('prompt.quickNamePh')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="pm-field">
                <span className="pm-field-label">{say('prompt.description')}</span>
                <input
                  className="pm-input"
                  placeholder={say('prompt.descriptionPh')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className="pm-field pm-field-grow">
                <span className="pm-field-label">{say('prompt.content')} *</span>
                <textarea
                  className="pm-textarea"
                  placeholder={say('prompt.contentPh')}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              <label className="pm-field">
                <span className="pm-field-label">{say('prompt.category')}</span>
                <input
                  className="pm-input"
                  list="pm-category-list"
                  placeholder={say('prompt.quickCategoryPh')}
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                />
                <datalist id="pm-category-list">
                  {displayCategories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              {/* 预设注入：一键「注入一次」/「持续注入」/「⚡ 立即注入」，
                  普通用户无需理解次数×间隔；「自定义」展开自由输入区 */}
              <div className="pm-actions">
                <button
                  type="button"
                  className="pm-primary-btn"
                  title={say('prompt.injectOnceBtnHint')}
                  onClick={() => void quickInject({ rounds: 1, every: 0 })}
                  disabled={busy}
                >
                  {busy ? say('prompt.saving') : say('prompt.injectOnceBtn')}
                </button>
                <button
                  type="button"
                  className="pm-tool-btn"
                  title={say('prompt.injectInfiniteBtnHint')}
                  onClick={() => void quickInject({ rounds: 0, every: 1 })}
                  disabled={busy}
                >
                  {say('prompt.injectInfiniteBtn')}
                </button>
                {/* 立即注入：当前回合立即生效（会话空闲则马上唤醒），只注入
                    一次——忽略次数/间隔两个数字（与「注入一次」的区别=生效
                    时机：下一轮 vs 立刻） */}
                <button
                  type="button"
                  className="pm-tool-btn"
                  title={say('prompt.injectNowBtnHint')}
                  onClick={() => void quickInject(undefined, true)}
                  disabled={busy}
                >
                  {say('prompt.injectNowBtn')}
                </button>
                <button
                  type="button"
                  className="pm-tool-btn"
                  title={say('prompt.customBtnHint')}
                  onClick={() => setCustomOpen(!customOpen)}
                >
                  {say('prompt.customBtn')}
                </button>
              </div>
              {customOpen && (
                <div className="pm-custom-zone">
                  <div className="pm-num-row">
                    <NumInput
                      label={say('prompt.rounds')}
                      hint={say('prompt.roundsHint')}
                      value={roundsText}
                      min={0}
                      onChange={setRoundsText}
                    />
                    <NumInput
                      label={say('prompt.cadence')}
                      hint={say('prompt.everyHint')}
                      value={everyText}
                      min={0}
                      onChange={setEveryText}
                    />
                  </div>
                  <EffectHint roundsText={roundsText} everyText={everyText} say={say} />
                  <div className="pm-actions">
                    <button type="button" className="pm-primary-btn" onClick={() => void quickInject()} disabled={busy}>
                      {busy ? say('prompt.saving') : say('prompt.inject')}
                    </button>
                    <button type="button" className="pm-tool-btn" onClick={() => setCustomOpen(false)}>
                      {say('prompt.collapseCustom')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {(selected !== null || creating) && (
            <div className="pm-form">
              <div className="pm-form-title">{creating ? say('prompt.formNew') : say('prompt.formEdit')}</div>
              <label className="pm-field">
                <span className="pm-field-label">{say('prompt.name')} *</span>
                <input
                  className="pm-input"
                  placeholder={say('prompt.namePh')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="pm-field">
                <span className="pm-field-label">{say('prompt.description')}</span>
                <input
                  className="pm-input"
                  placeholder={say('prompt.descriptionPh')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className="pm-field">
                <span className="pm-field-label">{say('prompt.category')}</span>
                <input
                  className="pm-input"
                  list="pm-category-list"
                  placeholder={say('prompt.categoryPh')}
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                />
                <datalist id="pm-category-list">
                  {displayCategories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <label className="pm-field">
                <span className="pm-field-label">{say('prompt.tags')}</span>
                <input
                  className="pm-input"
                  placeholder={say('prompt.tagsPh')}
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </label>
              <label className="pm-field pm-field-grow">
                <span className="pm-field-label">{say('prompt.content')} *</span>
                <textarea
                  className="pm-textarea"
                  placeholder={say('prompt.contentPh')}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              {/* 启用状态：禁用后不出现在 AI 的 de_prompts 列表、不能被 AI 注入
                  （GUI 仍可见可编辑，随时可重新启用） */}
              <label className="pm-field pm-enable-row">
                <span className="pm-field-label">
                  {say('prompt.enabled')}
                  <span className="pm-field-hint">{say('prompt.disabledHint')}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  className={`pm-toggle ${enabled ? 'pm-toggle-on' : ''}`}
                  onClick={() => setEnabled(!enabled)}
                >
                  {enabled ? say('prompt.enabledOn') : say('prompt.enabledOff')}
                </button>
              </label>
              <div className="pm-actions">
                {!creating && (() => {
                  const active = selected !== null ? activeInjectionOf(selected.id) : undefined
                  if (active !== undefined) {
                    // 注入中：显示状态 + 停止注入（已注入的提示词不可重复注入）
                    return (
                      <>
                        <span className="pm-inject-status">
                          {active.roundsLeft === null
                            ? say('prompt.injectingBadgeInfinite')
                            : say('prompt.injectingBadge').replace('{n}',() => (String(active.roundsLeft)))}
                          {' '}· {cadenceLabel(active)}
                        </span>
                        <button type="button" className="pm-danger-btn" onClick={() => void removeInjection(active.id)}>
                          {say('prompt.removeInjection')}
                        </button>
                      </>
                    )
                  }
                  return (
                    <>
                      {/* 预设注入：一键「注入一次」/「持续注入」（最常见的两种
                          场景）；「⚡ 立即注入」当前回合生效（只注入一次，忽略
                          次数/间隔）；「自定义」展开次数/间隔自由输入 */}
                      <button
                        type="button"
                        className="pm-primary-btn"
                        title={say('prompt.injectOnceBtnHint')}
                        onClick={() => void injectPreset(1, 0)}
                      >
                        {say('prompt.injectOnceBtn')}
                      </button>
                      <button
                        type="button"
                        className="pm-tool-btn"
                        title={say('prompt.injectInfiniteBtnHint')}
                        onClick={() => void injectPreset(0, 1)}
                      >
                        {say('prompt.injectInfiniteBtn')}
                      </button>
                      <button
                        type="button"
                        className="pm-tool-btn"
                        title={say('prompt.injectNowBtnHint')}
                        onClick={() => void injectNow(selected.id)}
                      >
                        {say('prompt.injectNowBtn')}
                      </button>
                      <button
                        type="button"
                        className="pm-tool-btn"
                        title={say('prompt.customBtnHint')}
                        onClick={() => setCustomOpen(!customOpen)}
                      >
                        {say('prompt.customBtn')}
                      </button>
                      {customOpen && (
                        <div className="pm-custom-zone pm-custom-zone-inline">
                          <div className="pm-inject-group">
                            <NumInput
                              label={say('prompt.rounds')}
                              hint={say('prompt.roundsHint')}
                              value={roundsText}
                              min={0}
                              onChange={setRoundsText}
                            />
                            <NumInput
                              label={say('prompt.cadence')}
                              hint={say('prompt.everyHint')}
                              value={everyText}
                              min={0}
                              onChange={setEveryText}
                            />
                            <button type="button" className="pm-primary-btn" onClick={() => void injectPrompt()}>
                              {say('prompt.inject')}
                            </button>
                            <button type="button" className="pm-tool-btn" onClick={() => setCustomOpen(false)}>
                              {say('prompt.collapseCustom')}
                            </button>
                          </div>
                          <EffectHint roundsText={roundsText} everyText={everyText} say={say} />
                        </div>
                      )}
                      <button type="button" className="pm-tool-btn" onClick={() => void copyPrompt()}>{say('prompt.copy')}</button>
                    </>
                  )
                })()}
                <button type="button" className="pm-tool-btn" onClick={() => void savePrompt()} disabled={busy}>
                  {busy ? say('prompt.saving') : say('prompt.save')}
                </button>
                {!creating && (
                  <button type="button" className="pm-danger-btn" onClick={() => void deletePrompt()}>
                    {say('prompt.delete')}
                  </button>
                )}
                {creating && (
                  <button type="button" className="pm-tool-btn" onClick={() => { setCreating(false); setSelectedId(null) }}>
                    {say('prompt.cancel')}
                  </button>
                )}
              </div>
              {!creating && selected !== null && selectedIsDirty && (
                <div className="pm-dirty-hint">{say('prompt.unsavedChanges')}</div>
              )}
            </div>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  )
}
