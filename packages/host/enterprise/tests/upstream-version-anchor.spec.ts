/**
 * C2-4（2026-10 审计，文档面）：上游**版本锚点**必须等于事实值，且不得写死后失效。
 *
 * 缺陷形态：`76508389df` 只把依赖版本从 `0.1.7-rc.2` 提到 `0.2.0-rc.2`，注释里的锚点没跟
 * ⇒ 「下一次升级时按注释去 `0.1.7-rc.2` 复核会看错树」，而 `ENDPOINT_MISMATCH` 这类
 * fail-closed 行为的"上游依据"指向了旧版本（同批还有一处锚点已经**变成假话**：
 * `agent-preset-install.spec.ts` 关于 persona 提升布局的 0.1.6-alpha.2 结论在 0.2.0-rc.2
 * 已不成立 —— 包现在又落回桌面包顶层）。
 *
 * 判据（**自派生**，不写死期望值）：从 enterprise 的 `package.json` 声明 + 实际安装的
 * 上游 `package.json` 取出版本（两者必须一致），再断言每个锚点文件里都带着
 * `<该版本> 复核` 这一标记。
 *  - 升降上游版本却漏改注释 ⇒ 红（正是 C2-4 的成因）；
 *  - 删掉锚点/复核标记 ⇒ 红（登记表不得静默消失）。
 *
 * 锚点指向的**行为**另有能力级判据（本文件不重复，此处只钉"锚点与事实同源"）：
 *  - `gateway-model.spec.ts`：真上游 schema 对 `protocol` 仍抛错（0.1.7 线的修法为何作废）；
 *  - `gateway-llm-auth-header.spec.ts`：令牌真的以 `Authorization: Bearer` 上模型请求
 *    （`resolveAuth` 那条注册面仍在被使用）；
 *  - `skill-channel-parity.spec.ts` / `channel-prepare` 那一族：与版本无关的跨包落点对拍。
 *
 * 变异（逐条实跑见 `temp/audit-v282/fixes/C2-P2-batch.md`）：把 `cordis.patch.yml` 的
 * 复核标记改回 `0.1.7-rc.2` ⇒ 红；删掉 `gateway-llm.ts` 的复核标记 ⇒ 红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

/** 声明版本（enterprise 自己写下的"我们要哪一版上游"）。 */
const declared = (JSON.parse(read('../package.json')) as {
  dependencies: Record<string, string>
}).dependencies['@deepseek-ai/dsh-llm-deepseek']
/** 实际安装版本（部署根解析到的那一份；注释里的"复核版本"必须指它）。 */
const installed = (JSON.parse(read('../node_modules/@deepseek-ai/dsh-llm-deepseek/package.json')) as {
  version: string
}).version

/**
 * 锚点文件表：每一处锚点句里都必须带 `<实际版本> 复核`。
 * `claim` 只用于**报错可读**（说明这一处锚点钉的是什么结论）；
 * `needle(version)` 是**该处锚点句本身**（逐字），用它钉住"具体那一句"——
 * 只判"文件里出现过当前版本"会让"另一处标记还在"掩盖这一处被改回旧版本。
 */
const ANCHORS: ReadonlyArray<{ file: string, claim: string, needle: (version: string) => string }> = [
  {
    file: '../src/gateway-llm.ts',
    claim: '网关 provider 注册面（protocol 已删 / resolveAuth 决定请求头）',
    needle: v => `**0.1.7-rc.2 引入、${v} 复核仍成立**：\`protocol\` **被删除**`,
  },
  {
    file: '../cordis.patch.yml',
    claim: '组装期禁用上游 llm-deepseek 行 + 插入自研行的依据',
    needle: v => `**0.1.7-rc.2 引入、${v} 复核仍成立** —— \`protocol\` 已从`,
  },
  {
    file: '../src/client/index.ts',
    claim: '首屏 hero 的 CSS 类（titleGroup / previewBadge）',
    needle: v => `改名为 \\\`titleGroup\\\`（**${v} 复核**：`,
  },
  {
    file: './gateway-model.spec.ts',
    claim: '写进网关行的键必须能被该行 schema 吃下',
    needle: v => `DSH 0.1.7-rc.2 引入、**${v} 复核仍成立**`,
  },
  {
    file: './agent-preset-install.spec.ts',
    claim: 'persona 的解析路径与提升布局无关',
    needle: v => `**${v} 复核仍在**`,
  },
]

describe('C2-4：上游版本锚点与事实同源', () => {
  it('声明版本与安装版本一致（两者不一致时，"锚点该指哪一版"本身就不成立）', () => {
    expect(declared, 'enterprise 未声明 @deepseek-ai/dsh-llm-deepseek').toBeTruthy()
    expect(declared).toBe(installed)
  })

  it.each(ANCHORS)('$file 的锚点句带着「$claim」的当前版本复核标记', ({ file, claim, needle }) => {
    const source = read(file)
    expect(source, `${file} 里的锚点句没有跟进到实际安装版本 ${installed}（${claim}）`)
      .toContain(needle(installed))
  })

  it('锚点表不是空的（防止"零个锚点"这种恒真通过）', () => {
    expect(ANCHORS.length).toBeGreaterThanOrEqual(5)
  })
})
