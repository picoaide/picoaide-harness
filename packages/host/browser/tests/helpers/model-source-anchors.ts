/**
 * 模型面扫描的**正向锚点登记表 + 执行见证**（2026-10-05 最终核验 P15-P1 的 G3 收口）。
 *
 * ## 为什么需要它
 *
 * `tests/shell-pages-locale.spec.ts` 的「模型面零中文」守卫是**否定式**判据（找不到中文 ⇒ 绿），
 * 所以它有一个结构性弱点：**扫描面被吃掉时它照样绿**。锚点（"几处已知的模型面文案必须留在
 * 扫描面内 + 非空白字节量下限"）就是为这个弱点准备的正向对照。
 *
 * 最终核验（V-P15P1 §3.2）实测的缺口：锚点**确实承重**（把 `scanModelSource` 的 `code` 整体
 * 抹空 + 往 `tools.ts` 塞中文 ⇒ 零中文判据静默绿、锚点红），但**锚点自己没有任何判据钉着** ——
 * 把那一整块 `it` 删掉，本文件照旧 `EXIT=0 / 22 passed`。
 *
 * ## 这份登记表怎么把"锚点必须存在"变成可执行的判据
 *
 * 四层，缺一层就退化成"文件里出现过某字符串"那种可被注释满足的形态：
 *
 *  1. **逐条点名的登记表**（{@link MODEL_SURFACE_ANCHORS} + {@link REQUIRED_MODEL_SURFACE_ANCHOR_IDS}
 *     + {@link MODEL_SURFACE_ANCHOR_FLOOR}）：删掉任意一条锚点，`floor` 与"必需 id"两条当场红，
 *     并在报错里**点名**是哪一个 id。
 *  2. **执行见证**：守卫里的锚点 `it` 必须把每条判定经 {@link witnessModelSurfaceAnchor} 报出来
 *     —— 而且这次调用**写在 `expect(...)` 的实参位里**。两个方向都咬：
 *       · 删掉整个 `it` 块 / 加 `.skip` / 把 `expect` 掏空 ⇒ 这条调用一起消失 ⇒ 见证对账红；
 *       · 判定值为假时见证函数**自己抛错**（不依赖 `expect` 是否还在）⇒ "保留调用、掏空断言"也红。
 *  3. **判定函数不许被掏空**：对一份人为掏空的扫描面，判定必须**全部为假**（合成空扫描面，
 *     行为判据，不依赖源码文本）。
 *  4. **判定值的形态**：锚点块里 `witnessModelSurfaceAnchor(id, <判定值>)` 的判定值不得是
 *     字面量（`true` / `(true)` / `'yes'` …）—— 见守卫里"锚点判定的形态"那一格；它用同一份
 *     注释感知扫描器读**守卫自己的源码**，所以"注释里出现这个字符串"不算数。
 *
 * ## 能咬住什么 / 咬不住什么（写清楚，不装作全能）
 *
 * **咬得住**（实测见 `temp/audit-v282/evidence/P16/g3-matrix.log`）：删整块锚点 / 删一条锚点 /
 * `.skip` / 少判一条 / 判定函数掏空 / 判定值写死或写成 `(true)` —— 都会具名失败。
 *
 * **咬不住**（认账）：
 *  · 把整个 spec 文件删掉：那样这些判据也一起没了，本文件里没有任何判据能发现"文件不存在" ——
 *    它属于"守卫本体被删"这一类，超出单个 spec 的自证能力；
 *  · 把见证/形态判据自己也删掉（连同锚点一起）：与上一条同族 —— 判据不能证明"自己还在跑"；
 *  · 任意**表达式**形式的削弱（例如判定值写成 `judgment.ok || true`）：那是"改写守卫"，
 *    与直接删掉锚点同级，不在形态判据面内（形态判据只钉"最省事的写法：换成字面量"）；
 *  · 见证格依赖**同文件内的声明顺序**（锚点 `it` 在见证 `it` 之前）—— vitest 缺省按声明顺序
 *    串行执行同文件用例，本包未开 `sequence.shuffle`；若将来开启，见证格会以"一条都没见证到"
 *    的形式失败（响亮的假红，不是假绿）。
 *
 * @module @picoaide/dsh-browser/tests/helpers/model-source-anchors
 */

import type { ModelSourceScan } from './model-source-scan.ts'

/** 一条锚点的形状：`contains` = 内层文案必须留在扫描面内；`min-bytes` = 扫描面的体量下限。 */
export type ModelSurfaceAnchor =
  | {
    readonly id: string
    readonly kind: 'contains'
    /** 必须出现在 `SCAN.code` 里的子串（模型面文案，注释里的同名字串不算）。 */
    readonly needle: string
    /** 判据为什么存在（失败文案里原样带出来）。 */
    readonly why: string
  }
  | {
    readonly id: string
    readonly kind: 'min-bytes'
    /** `SCAN.code` 去掉空白后的字符数下限。 */
    readonly minBytes: number
    readonly why: string
  }

/**
 * 登记的锚点（逐条给 id，便于"必需项"与失败文案点名）。
 *
 * 前三条的 `needle` 是**模型面真实文案**（工具 description / 系统提示词里给模型看的句子），
 * 最后一条是体量下限（今天实测 ≈ 53.8k，下限留 45k 的余量；整段被吞会让它断崖式下跌）。
 */
export const MODEL_SURFACE_ANCHORS: readonly ModelSurfaceAnchor[] = [
  {
    id: 'no-model-side-counterpart',
    kind: 'contains',
    needle: 'NO model-side counterpart',
    why: '`browser_*` 工具里"这个动作在界面上没有对应控件"的提示语 —— 它只在模型面出现',
  },
  {
    id: 'control-with-user',
    kind: 'contains',
    needle: 'Control is now with the user',
    why: '用户接管浏览器时的模型面提示语（控制权状态三面可见的一半）',
  },
  {
    id: 'browser-takeover',
    kind: 'contains',
    needle: 'browser_takeover',
    why: '控制权工具名 —— 模型面文案与工具表的连接点',
  },
  {
    id: 'scan-surface-bytes',
    kind: 'min-bytes',
    minBytes: 45_000,
    why: '非空白非注释字节量下限：扫描器整段吞掉代码时它会断崖式下跌（比"零中文判绿"更早暴露"什么都看不见"）',
  },
]

/**
 * **逐条点名**的必需锚点 id（与 `check-workflows.mjs` 的 `SELFTEST_REQUIRED_SAMPLES` 同一手法）。
 *
 * 光有 {@link MODEL_SURFACE_ANCHOR_FLOOR} 只能发现"少了一些"，发现不了"少的是哪一条" ——
 * 这张表让删掉任意一条锚点时，失败文案直接点名。
 */
export const REQUIRED_MODEL_SURFACE_ANCHOR_IDS: readonly string[] = [
  'no-model-side-counterpart',
  'control-with-user',
  'browser-takeover',
  'scan-surface-bytes',
]

/** 登记表 / 执行见证的**条数地板**（ratchet：只能变多，见模块头）。 */
export const MODEL_SURFACE_ANCHOR_FLOOR = 4

/** 一条锚点的判定结果（`ok=false` 时 `detail` 说明缺了什么）。 */
export interface ModelSurfaceAnchorJudgment {
  /** 锚点 id（= 登记项 id）。 */
  readonly id: string
  /** 判定结果。 */
  readonly ok: boolean
  /** 给人看的判定说明（成功与失败都带，失败文案直接用它）。 */
  readonly detail: string
}

/**
 * 对一份扫描结果逐条判定登记表里的锚点。
 *
 * 这是**唯一**的判定实现：守卫的锚点 `it` 与见证对账格都调它（不各写一份，避免"两份实现
 * 各钉自己的字面量"那种假绿）。
 *
 * @param scan - `scanModelSource()` 的结果。
 * @returns 逐条判定（顺序 = 登记表顺序）。
 */
export function judgeModelSurfaceAnchors(scan: ModelSourceScan): ModelSurfaceAnchorJudgment[] {
  return MODEL_SURFACE_ANCHORS.map((anchor) => {
    if (anchor.kind === 'min-bytes') {
      const bytes = scan.code.replace(/\s/gu, '').length
      return {
        id: anchor.id,
        ok: bytes >= anchor.minBytes,
        detail: `[model-surface-anchor:${anchor.id}] 非空白非注释字节量 ${bytes} 必须 ≥ ${anchor.minBytes}`
          + `（${anchor.why}）`,
      }
    }
    return {
      id: anchor.id,
      ok: scan.code.includes(anchor.needle),
      detail: `[model-surface-anchor:${anchor.id}] 扫描面里必须留着 \`${anchor.needle}\`（${anchor.why}）`,
    }
  })
}

/** 见证账本：id → 判定值（只在本文件的进程内使用）。 */
const witnessed = new Map<string, boolean>()

/**
 * 记录一次锚点判定 —— **判定为假时自己抛错**。
 *
 * 设计要点（G3 的核心）：这次调用写在守卫 `it` 的 `expect(...)` 实参位里，于是
 *   ① `ok=false` ⇒ 这里直接抛错（不依赖 `expect` 还在不在 ⇒ "保留调用、掏空断言"照样红）；
 *   ② `expect` 被删掉 ⇒ 调用一起消失 ⇒ 见证对账格报"这条锚点没有被执行"。
 *
 * @param id - 锚点 id（必须是登记表里的条目）。
 * @param ok - 判定值（来自 {@link judgeModelSurfaceAnchors}）。
 * @param detail - 失败文案（守卫把 `judgment.detail` 传进来）。
 * @returns `ok` 原样返回（供 `expect(...).toBe(true)` 使用）。
 * @throws 判定为假时抛出（消息里带 id 与原因）。
 */
export function witnessModelSurfaceAnchor(id: string, ok: boolean, detail = ''): boolean {
  witnessed.set(id, ok)
  if (!ok) {
    throw new Error(`模型面扫描锚点判定为假（扫描面缩水）：${detail === '' ? id : detail}`)
  }
  return ok
}

/**
 * 本次进程里**真的被判过**的锚点（id → 判定值），按 id 排序。
 * @returns 见证到的条目（空数组 = 一条都没判过 ⇒ 锚点块被删 / 被 skip）。
 */
export function witnessedModelSurfaceAnchors(): Array<{ id: string; ok: boolean }> {
  return [...witnessed.entries()].map(([id, ok]) => ({ id, ok })).sort((a, b) => (a.id < b.id ? -1 : 1))
}
