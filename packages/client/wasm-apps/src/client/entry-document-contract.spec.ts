/// <reference types="node" />
/**
 * **入口文档的三形态：作者手册 ↔ 实现的对拍**（R3-A A-5 的文档面收尾）。
 *
 * ## 这条闸要拦的缺陷类
 *
 * A-5 的缺陷是"实现与文档不一致"，而它能在仓库里活下来的原因很具体：**入口形态被写在
 * 四处，每一处都只钉自己的字面量**（`static.go` 规则 5 的注释、`references/abi.md` 的
 * 路由表、`SKILL.md` 的直出表、`docs/wasm-app-authoring.md` 的 §2.1b）。四处里三处写
 * 「`/`、`/index.html`、`<目录>/`」，实现只认 `index.html` ⇒ 页面放在子目录的应用，
 * 入口被宿主直出，应用自己的准入页（名单外用户应看到的 403 与本人账号）永远不被调用。
 *
 * 实现已按多数文档修正（`isEntryDocument`）。剩下的风险是**同一句话再次分叉**：
 * 有人改实现（比如只留根入口）或改文档（比如把那句里的 `<目录>/` 删掉），另一侧不动。
 * 本用例把手册那一句与实现那两行**对拍成集合相等**。
 *
 * ## 为什么这条用例住客户端包里
 *
 * `docs/**` 没有自己的测试面，而本包已经是"跨工件对拍"的所在地
 * （`appcfg-contract.spec.ts` 读服务端生成物、`shipped-bundle.spec.ts` 读随包产物）——
 * 加在这里才能被包级 `check`（build + 全量 vitest）真的跑到，而不是成为一条无人执行的
 * 约定。两侧任一缺席（文件改名/句子重写/函数搬走）**直接 throw**，不 skip。
 *
 * ⚠️ 覆盖范围只到 `docs/wasm-app-authoring.md`（本泳道可写面）。同一句话在
 * `server/skills/app-builder/references/abi.md` §8 仍是旧的两形态版本 —— 那属
 * `server/**` 泳道（且改 SKILL 资源要提版本号 + 登记摘要），本用例**故意不**把它纳入
 * 断言：跨泳道的红会把另一个泳道的 PR 打红，而修它的人改不到本文件。
 *
 * ---- 变异验证 ----
 *   - 把手册那一句改回 `（`/`、`/index.html`）` ⇒ 集合相等红（缺 `<目录>/`）；
 *   - 把 `static.go` 的 `isEntryDocument` 去掉 `strings.HasSuffix(rel, "/index.html")`
 *     ⇒ 同上红（实现只认根入口）；
 *   - 把两者的句型改得抠不出来 ⇒ "两侧都能抠出来"那一条红（不是静默通过）。
 *
 * @module @picoaide/dsh-wasm-apps/client/entry-document-contract.spec
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** 作者手册（本泳道可写面）。 */
export const ENTRY_DOC_REPO_PATH = 'docs/wasm-app-authoring.md'
/** 入口判据的实现（宿主静态服务）。 */
export const STATIC_GO_REPO_PATH = 'server/internal/wasmapp/appserver/static.go'

/**
 * 契约的**三形态**（顺序即阅读顺序）。
 *
 * 归一化后的稳定写法：根 `/`、显式根文档 `/index.html`、目录形态 `<dir>/`
 * （目录形态在实现里归一成 `<dir>/index.html`）。文档里的 `<目录>/` 与 `<dir>/`
 * 视为同一形态 —— 手册是中文写的，实现是英文标识符，归一化是这条对拍的前提。
 */
export const ENTRY_DOC_FORMS = ['/', '/index.html', '<dir>/'] as const

/** 目录形态的写法（尖括号占位符 + 斜杠收尾；`<目录>/` 与 `<dir>/` 都认）。 */
const SUBDIR_FORM = /^<[^<>/]+>\/$/u

/**
 * 读仓库内文件。**读不到就抛**（真源缺席必须是红的，不是 skip）。
 * @param relative - 仓库内相对路径。
 * @returns 文件全文。
 */
function readRepoFile(relative: string): string {
  try {
    return readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch (cause) {
    throw new Error(`${relative} 读不到（${cause instanceof Error ? cause.message : String(cause)}）：入口文档对拍的真源缺席`)
  }
}

/**
 * 把一处写法归一成 {@link ENTRY_DOC_FORMS} 里的形态。
 * @param raw - 原文片段（可含反引号与空白）。
 * @returns 归一化形态；认不出来返回 `null`。
 */
function normalizeEntryForm(raw: string): (typeof ENTRY_DOC_FORMS)[number] | null {
  // 只取片段里的第一个 token：文档会在形态后面补一句解释（如 ` —— 目录形态等价于 …`）。
  const token = raw.trim().split(/[\s—]+/u)[0]?.replace(/[`“”"]/gu, '') ?? ''
  if (token === '/') return '/'
  if (token === '/index.html') return '/index.html'
  if (SUBDIR_FORM.test(token)) return '<dir>/'
  return null
}

/**
 * 从手册里抠出"入口文档（…）"那一句枚举的形态。
 * @param source - 手册全文。
 * @returns 归一化形态集合；找不到那句话时返回 `null`（调用方据此红）。
 */
export function entryFormsFromDoc(source: string): string[] | null {
  const match = /入口文档（([^）]*)）/u.exec(source)
  if (match === null) return null
  const forms = match[1]!.split('、').map(normalizeEntryForm).filter((form): form is (typeof ENTRY_DOC_FORMS)[number] => form !== null)
  return forms.length === 0 ? null : [...new Set(forms)].sort()
}

/**
 * 从 `static.go` 抠出入口判据支持的三形态。
 *
 * 判据分散在两处（这是实现的事实，不是我的取舍）：
 *  - `staticLogicalPath` 负责**归一化**：根路径 → `index.html`（`rel = "index.html"`）、
 *    目录形态 → `<dir>/index.html`（`rel += "/index.html"`）；
 *  - `isEntryDocument` 负责**判定**：`rel == "index.html"` 或 `HasSuffix(rel, "/index.html")`。
 *
 * 前者的归一化只有在后者认它时才算"入口"，所以两个条件必须成对出现才算一个形态。
 * @param source - `static.go` 全文。
 * @returns 归一化形态集合；函数被搬走/改名时返回 `null`。
 */
export function entryFormsFromStaticGo(source: string): string[] | null {
  const nextFunc = (start: number): string => {
    const next = source.indexOf('\nfunc ', start)
    return source.slice(start, next < 0 ? undefined : next)
  }
  const logicalStart = source.indexOf('func staticLogicalPath(')
  const entryStart = source.indexOf('func isEntryDocument(')
  if (logicalStart < 0 || entryStart < 0) return null
  const logical = nextFunc(logicalStart).replace(/\/\/[^\n]*/gu, '')
  const entry = nextFunc(entryStart).replace(/\/\/[^\n]*/gu, '')
  const forms: string[] = []
  const rootIndex = /rel\s*=\s*"index\.html"/u.test(logical) && /rel\s*==\s*"index\.html"/u.test(entry)
  if (rootIndex) forms.push('/', '/index.html')
  if (/rel\s*\+=\s*"\/index\.html"/u.test(logical) && /HasSuffix\(rel,\s*"\/index\.html"\)/u.test(entry)) forms.push('<dir>/')
  return forms.length === 0 ? null : [...new Set(forms)].sort()
}

const doc = readRepoFile(ENTRY_DOC_REPO_PATH)
const staticGo = readRepoFile(STATIC_GO_REPO_PATH)
const docForms = entryFormsFromDoc(doc)
const implForms = entryFormsFromStaticGo(staticGo)

describe('入口文档三形态：作者手册 ↔ static.go 实现', () => {
  it('两侧都抠得出来（句型被改得认不出来 ⇒ 红，不是静默通过）', () => {
    expect(docForms, `${ENTRY_DOC_REPO_PATH} 里找不到「入口文档（…）」那一句枚举`).not.toBeNull()
    expect(implForms, `${STATIC_GO_REPO_PATH} 里找不到 staticLogicalPath / isEntryDocument 的判据`).not.toBeNull()
    expect(docForms).toContain('/')
    expect(implForms).toContain('<dir>/')
  })

  /**
   * 主判据：手册枚举的形态 == 实现支持的形态。
   *
   * A-5 修复前这条是红的：手册只列 `/`、`/index.html`，而实现（修正后）支持三形态；
   * 反过来把实现改回只认根入口，这条同样红。
   */
  it('手册枚举的入口形态与实现判据完全相等（三个形态，不多不少）', () => {
    expect(
      docForms,
      `${ENTRY_DOC_REPO_PATH} 枚举了 ${JSON.stringify(docForms)}，`
      + `而 ${STATIC_GO_REPO_PATH} 的 staticLogicalPath + isEntryDocument 支持 ${JSON.stringify(implForms)}。`
      + '两侧必须同时列全 `/`、`/index.html`、`<dir>/`：只保护根入口会让页面放在子目录的应用'
      + '把入口直出给宿主，应用自己的准入页（名单外用户应看到的 403）永远不被调用。',
    ).toEqual(implForms)
    expect(docForms).toEqual([...ENTRY_DOC_FORMS].sort())
  })

  it('这份对拍真的会红（对手册回退与实现回退两种改写自证）', () => {
    // ① 手册回退成旧的两形态写法（A-5 修复前的原文）。
    const reverted = doc.replace('入口文档（`/`、`/index.html`、`<目录>/`', '入口文档（`/`、`/index.html`')
    expect(reverted).not.toBe(doc)
    expect(entryFormsFromDoc(reverted)).toEqual(['/', '/index.html'].sort())
    expect(entryFormsFromDoc(reverted)).not.toEqual(implForms)

    // ② 实现回退：`isEntryDocument` 去掉目录形态那一条。
    const shrunk = staticGo.replace(' || strings.HasSuffix(rel, "/index.html")', '')
    expect(shrunk).not.toBe(staticGo)
    expect(entryFormsFromStaticGo(shrunk)).toEqual(['/', '/index.html'].sort())
    expect(entryFormsFromStaticGo(shrunk)).not.toEqual(docForms)
  })
})
