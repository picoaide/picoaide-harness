/**
 * advisor 提示词的语言分派（2026-09-16）。
 *
 * 缺陷形态：三段提示词（默认系统提示词 / 固定角色前缀 / 问答追加段）此前
 * **只有中文**，正文里还硬编码「建议用中文输出」「直接以中文回答用户的问题」。
 * 而评审员的 note 是**以用户指令形式注入主 Agent 会话**的（角色前缀的机制
 * 约束）：英文界面下于是出现"英文会话里冒出中文用户指令"，中英混排直接进主对话。
 *
 * 修复口径：按宿主 locale 分派（zh 用原文一字不改，en 用等价英文）；
 * 取值一律走函数，**不得**再导出模块级字符串常量（那会在加载期把语言钉死）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advisorRolePrefix,
  buildAdvisorSystemPrompt,
  defaultAdvisorSystemPrompt,
  qaSystemPromptSuffix,
} from '../lib/advisor/prompt.js'
import { setLocale } from '../lib/i18n.js'

test('zh：与原文逐字一致（中文是默认路径，不许被翻译改动）', () => {
  setLocale('zh')
  assert.match(defaultAdvisorSystemPrompt(), /你是一个独立的会话评审员/)
  assert.match(defaultAdvisorSystemPrompt(), /建议用中文输出。/)
  assert.match(advisorRolePrefix(), /你是会话评审员 Advisor/)
  assert.match(qaSystemPromptSuffix(), /直接以中文回答用户的问题/)
})

test('en：面向模型的指令切成英文，且英文列不残留中文', () => {
  setLocale('en')
  const system = defaultAdvisorSystemPrompt()
  const role = advisorRolePrefix()
  const qa = qaSystemPromptSuffix()
  assert.match(system, /Write your suggestion in English\./)
  assert.match(role, /You are the session reviewer Advisor/)
  assert.match(qa, /answer the user's question directly/)
  // 角色包裹标记是**输入协议的固定字面量**（lib/advisor/visible-surface.js 的
  // ROLE_MARKERS，与界面语言无关），英文提示词必须按原样引用，否则模型认不出
  // 谁在说话。因此先剥掉这四对标记，再断言"没有中文散文残留"。
  const PROTOCOL_TAGS = [
    '<用户对Agent说>', '</用户对Agent说>',
    '<Agent对用户说>', '</Agent对用户说>',
    '<用户对评审员指令>', '</用户对评审员指令>',
    '<用户对评审员提问>', '</用户对评审员提问>',
  ]
  const stripProtocolTags = (text) => PROTOCOL_TAGS.reduce((acc, tag) => acc.split(tag).join(' '), text)
  for (const [name, text] of [['default', system], ['role', role], ['qa', qa]]) {
    assert.doesNotMatch(
      stripProtocolTags(text),
      /[\u4e00-\u9fff]/u,
      `${name} 英文文案不得含中文散文：${stripProtocolTags(text).slice(0, 120)}`,
    )
  }
  // 反向：协议标记必须仍在（少了它模型分不清角色）
  assert.match(system, /<用户对Agent说>/)
  setLocale('zh')
})

test('en：note 的口吻约束（以用户指令形式注入）必须仍然写明', () => {
  setLocale('en')
  assert.match(advisorRolePrefix(), /in the form of a user instruction/)
  assert.match(advisorRolePrefix(), /never contain words that reveal your identity/)
  setLocale('zh')
})

test('语言可**切换**（取值是调用期解析，不是加载期钉死）', () => {
  setLocale('zh')
  const zh = defaultAdvisorSystemPrompt()
  setLocale('en')
  const en = defaultAdvisorSystemPrompt()
  setLocale('zh')
  assert.notEqual(zh, en)
  assert.match(zh, /建议用中文输出/)
  assert.match(en, /in English/)
})

test('locale 取值非法时回落中文（不抛错、不返回空）', () => {
  setLocale('ja')
  assert.match(defaultAdvisorSystemPrompt(), /建议用中文输出/)
  setLocale('zh')
})

test('分层拼接仍然生效（系统词 + 四层约束）', () => {
  setLocale('zh')
  const built = buildAdvisorSystemPrompt({
    system: defaultAdvisorSystemPrompt(),
    global: '全局要求',
    project: '项目要求',
  })
  assert.match(built, /### 全局约束/)
  assert.match(built, /### 项目约束/)
  assert.match(built, /全局要求/)
  assert.match(built, /项目要求/)
})

test('不再导出模块级字符串常量（防语言被加载期钉死）', async () => {
  const promptModule = await import('../lib/advisor/prompt.js')
  for (const legacy of ['DEFAULT_ADVISOR_SYSTEM_PROMPT', 'ADVISOR_ROLE_PREFIX', 'QA_SYSTEM_PROMPT_SUFFIX']) {
    assert.equal(
      legacy in promptModule,
      false,
      `${legacy} 不得作为模块级常量导出——消费方必须调用同名函数`,
    )
  }
})
