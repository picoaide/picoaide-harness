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
 * 补丁摘掉 `apply()` 末尾的 `apply$1(ctx, config.office)` 调用，于是没有任何渲染器
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
 * 变异验证：把 `apply$1(ctx, config.office);` 加回构建产物 ⇒ 第一条用例必须变红。
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

describe('Office preview stays disabled in the desktop client (patch guard)', () => {
  it('does not register the Office renderer', () => {
    // 补丁是真的落在这份产物上（不是上游恰好改了形状）。
    expect(bundle).toContain('PicoAide: the desktop host ships no LibreOffice')
    // 注册调用必须不存在……
    expect(bundle).not.toContain('apply$1(ctx, config.office)')
    // ……且该函数只剩定义（死代码）：任何重新接线都会让计数回到 2。
    expect(bundle.match(/apply\$1\(/gu)).toHaveLength(1)
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
