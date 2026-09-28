/**
 * Guard for `patches/dsh-client-ui-sidebar-documentpreview@<pin>.patch`.
 *
 * 桌面宿主不提供 Office 转换：上游 `office-to-pdf` 行在 `cordis.patch.yml` 里
 * `disabled: true`（引擎会拉进仓库外 `@deepseek-ai/libreoffice-kit*` 平台包，且
 * macOS 侧嵌套 `LibreOfficeDev.app` 会打红签名），打包清单里也没有任何引擎条目。
 * 但上游客户端**无条件**为 doc/docx/xls/xlsx/ppt/pptx 注册渲染器 —— 一旦注册，
 * 打开这些文件只会「读 → 请 host 转换 → 失败」，用户看到的是
 * 「Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。」
 * 一句在桌面端**无法执行**的指引。
 *
 * 补丁摘掉 `apply()` 里那个**以 `config.office` 为实参**的调用，于是没有任何渲染器
 * 认领这些后缀，上游内置的空态接管（`ui-sidebar-documentpreview` 的
 * `TextPreview.tsx:210-226` 分支：`selected === undefined && unviewable`）——
 * 而 `document/unviewable.ts:10-28` 的 `UNVIEWABLE_BINARY_EXTENSIONS` 已含六个
 * Office 后缀，该分支**不读文件、不发请求**，只渲染 `data-textpreview-unsupported`
 * 加 `t('unsupportedFile')`（与 zip/mp4/odt 同一条路径）。
 *
 * 为什么必须钉住：升级上游后重切补丁遗漏、或 resolution 未命中时，yarn 是**静默忽略**
 * 的，行为会退化成那句误导提示而没有任何用例变红。补丁文件与 resolution 的成对完备性
 * 由 `verify-patch-resolutions` / `verify-patches` / `check-patch-pin` 覆盖，
 * 本用例只钉「这份产物里 Office 渲染器没有被接线」与「内置空态仍然在」。
 *
 * 变异验证：把那个 `(ctx, config.office)` 调用加回构建产物 ⇒ 第一条用例必须变红。
 *
 * ⚠️ **判据不得按构建器的 helper 序号（`apply$N`）钉**（2026-09-28，0.1.7-rc.2 升级实测）。
 * 打包器每个版本重新给这些内部函数编号，编号**随构建漂移**：同一个 `apply$1` 在 0.1.6
 * 是 Office，在 0.1.7 却是**纯客户端的 Excel 读取**（`apply$1(ctx, config.excel)`，不依赖
 * LibreOffice，是本产品**要保留**的功能）。本用例原先写
 * `expect(bundle.match(/apply\$1\(/gu)).toHaveLength(1)`：0.1.7 产物里 `apply$1` 有
 * "定义 + Excel 调用"两处，于是它变红；而更危险的方向是**假绿** —— 照旧按序号去摘
 * `apply$1`，会把 Excel 预览一起摘掉，这条用例反而照样通过。
 * 稳定判据只有一条：**不存在任何以 `config.office` 为实参的调用**；要数"函数只剩定义"，
 * 也必须先按**函数体内容**（它注册的 documentPreview id）认出是哪个标识符，再数它。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

/** 已安装（或已打补丁）的客户端 bundle 绝对路径。 */
function clientBundlePath(): string {
  const manifest = require.resolve('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/package.json')
  return join(dirname(manifest), 'lib', 'client.js')
}

const bundle = readFileSync(clientBundlePath(), 'utf8')

/** 本包注册的 Office / Excel 文档预览 id —— 识别"是哪个函数"的**内容**锚点。 */
const OFFICE_PREVIEW_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office'
const EXCEL_PREVIEW_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel'

/**
 * 按函数体里注册的 documentPreview id 反解出那个 apply 函数的标识符。
 *
 * 这是"不按 `apply$N` 序号钉"的落地：序号是打包器产物、随版本漂移；注册的 preview id
 * 是本包自己声明的常量，跟着语义走。
 * @param previewId - 该渲染器注册的 documentPreview id。
 * @returns 产物里那个 apply 函数的标识符（如 `apply$2`）。
 */
function applyIdentifierFor(previewId: string): string {
  const escaped = previewId.replaceAll('/', '\\/')
  const pattern = new RegExp(`function ([A-Za-z_$][\\w$]*)\\(ctx, [\\w$]+\\) \\{\\s*const id = "${escaped}";`, 'u')
  const match = pattern.exec(bundle)
  expect(
    match,
    `产物里找不到注册 ${previewId} 的 apply 函数 —— 上游改了形状，本守卫必须重写而不是静默放过`,
  ).not.toBeNull()
  return match![1]!
}

/** 数某个标识符在产物里出现几次「被调用/被定义」（`name(` 形态）。 */
function callSites(identifier: string): number {
  return bundle.match(new RegExp(`${identifier.replaceAll('$', '\\$')}\\(`, 'gu'))?.length ?? 0
}

describe('Office preview stays disabled in the desktop client (patch guard)', () => {
  it('does not register the Office renderer', () => {
    // 补丁是真的落在这份产物上（不是上游恰好改了形状）。
    expect(bundle).toContain('PicoAide: the desktop host ships no LibreOffice')
    // ① 唯一稳定的判据：不存在任何以 config.office 为实参的调用。
    expect(bundle).not.toMatch(/\(ctx, config\.office\)/u)
    // ② 由内容锚点认出 Office 那个函数，再要求它只剩定义（死代码）：重新接线会让计数回到 2。
    expect(callSites(applyIdentifierFor(OFFICE_PREVIEW_ID))).toBe(1)
  })

  it('keeps the Excel renderer wired（0.1.7 新增：纯客户端读取，不依赖 LibreOffice）', () => {
    // 反向控制：这条同时钉住"补丁没有误伤 Excel"。0.1.7 起的产物才有这个渲染器，
    // 更早的版本（产物里没有该 preview id）直接跳过。
    if (!bundle.includes(EXCEL_PREVIEW_ID)) return
    // 定义 + 调用 = 2 处；只摘 Office 的补丁必须保持这个数。
    expect(callSites(applyIdentifierFor(EXCEL_PREVIEW_ID))).toBe(2)
    expect(bundle).toMatch(/\(ctx, config\.excel\)/u)
  })

  it('keeps the built-in unsupported empty state that binary documents fall back to', () => {
    // 没有渲染器认领 doc/xls/ppt 之后，用户看到的就是这一条空态。
    expect(bundle).toContain('data-textpreview-unsupported')
    // 文案被钉住：上游改字（或补丁改成自研渲染器）都必须是一次有意识的决定。
    // 注意失败路径的「Office 预览不可用…」字典仍留在产物里（死函数体内），
    // 它是否可达只由第一条用例的"注册调用不存在"决定，不能靠字符串在不在来判断。
    expect(bundle).toContain('该格式文件暂时无法预览')
  })
})
