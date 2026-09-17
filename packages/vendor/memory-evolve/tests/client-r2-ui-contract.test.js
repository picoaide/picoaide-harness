/**
 * ME-2 / ME-3 / ME-5 / ME-6 / ME-7（2026-09-17 二审）客户端契约回归。
 *
 * 这五条都住在 .tsx 组件里（node --test 不能渲染 React），所以断言做成
 * **静态契约**：src 源与入库产物 lib/client.js 必须同时具备修复后的写法、
 * 且不得残留修复前的写法。产物是真正发货的那份，只改 src 等于没修；只改
 * 产物会让下次重建回退——两个载体都必须钉。
 *
 * 每条断言都做了变异判别：把任一侧改回旧写法（或删掉新增入口），对应用例
 * 必红（修复过程中逐条实测过）。
 *
 *   ME-2 PromptView 新建+注入后用旧闭包 prompts 查找新 id ⇒ 静默 no-op、再点
 *        一次建出重复条目。修法：直接回填刚返回的条目对象。
 *   ME-3 宿主回 skillMessage:null（不是缺字段），客户端只判 !== undefined ⇒
 *        渲染出空绿条，用户看不到「已保存」。
 *   ME-5 guideOpen 无 setter ⇒ 宿主下发的 a.guide 永远渲染不出来（死 UI）。
 *   ME-6 defaultInputOpen 是列表位置派生的默认值，被 effect 当受控值回灌 ⇒
 *        新评审到达时用户正在读的输入快照自己折叠。
 *   ME-7 matchMedia 监听器闭包捕获旧 userToggled（依赖数组缺它）⇒ 一次窗口
 *        缩放把用户手动打开的面板收起。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
const PROMPT_VIEW = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'PromptView.tsx'), 'utf8')
const COI_VIEW = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'CoIView.tsx'), 'utf8')
const ADVISOR = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'advisor', 'AdvisorPanel.tsx'), 'utf8')
const COI_HOST = readFileSync(join(PACKAGE_ROOT, 'lib', 'coi', 'api.js'), 'utf8')

/** 两个载体（src 源 + 入库产物）上做同一组断言。 */
function eachCarrier() {
  return [
    ['lib/client.js', BUNDLE],
    ['src/client/PromptView.tsx', PROMPT_VIEW],
    ['src/client/CoIView.tsx', COI_VIEW],
    ['src/client/advisor/AdvisorPanel.tsx', ADVISOR],
  ]
}

test('ME-2：新建提示词的回填必须用刚返回的对象；selectPrompt(newId) 旧写法消失', () => {
  for (const [name, text] of eachCarrier()) {
    if (name !== 'lib/client.js' && !name.endsWith('PromptView.tsx')) continue
    assert.ok(text.includes('applyPromptDraft(created.prompt)'), `${name}: 新建回填未用返回对象`)
    assert.equal(
      text.includes('selectPrompt(created.prompt.id)'),
      false,
      `${name}: 仍用旧闭包里的 prompts 按新 id 查找（必然找不到）`,
    )
    assert.ok(text.includes('applyPromptDraft'), `${name}: 缺少表单回填函数`)
  }
})

test('ME-3：skillMessage 判据是「非空字符串」；宿主仍回 null（两端契约一起钉）', () => {
  // 宿主行为：技能名留空这条常见路径一路保持 null 并原样下发。
  assert.ok(COI_HOST.includes('let skillMessage = null'), '宿主仍以 null 表达「无附加消息」')
  for (const [name, text] of eachCarrier()) {
    if (name !== 'lib/client.js' && !name.endsWith('CoIView.tsx')) continue
    assert.ok(text.includes('typeof res.skillMessage === \'string\'') || text.includes('typeof res.skillMessage === "string"'), `${name}: 未按字符串判空`)
    assert.equal(
      text.includes('res.skillMessage !== undefined ? res.skillMessage'),
      false,
      `${name}: 仍把 null 当成有内容（会渲染空提示条）`,
    )
  }
})

test('ME-5：适配器卡片必须给 guide 一个开关（guideOpen 有 setter）', () => {
  for (const [name, text] of eachCarrier()) {
    if (name !== 'lib/client.js' && !name.endsWith('CoIView.tsx')) continue
    assert.ok(text.includes('setGuideOpen('), `${name}: guideOpen 仍无 setter（指南不可达）`)
    assert.ok(text.includes("t('coi.adapters.guide')") || text.includes('t("coi.adapters.guide")'), `${name}: 指南按钮未用既有字典键`)
    // 按钮必须只在确有 guide 时出现（否则内置/自定义适配器上都多一个空按钮）。
    assert.ok(/typeof a\.guide === ['"]string['"]/.test(text), `${name}: 指南按钮缺少 guide 存在性判据`)
  }
})

test('ME-6：defaultInputOpen 只取挂载初值，不得用 effect 回灌（否则新评审到达时折叠在读的卡）', () => {
  for (const [name, text] of eachCarrier()) {
    if (name !== 'lib/client.js' && !name.endsWith('AdvisorPanel.tsx')) continue
    const mountDefault = text.includes('useState(props.defaultInputOpen)')
      || text.includes('useState)(props.defaultInputOpen)') // esbuild 产物形态
    assert.ok(mountDefault, `${name}: 缺少挂载初值`)
    // 禁的是"把派生默认值当受控值回灌"这个**调用**，不是某种拼写：esbuild 会把
    // 源码形态编译成 `(0, import_reactN.useEffect)(…)`，旧正则只认 `useEffect((`
    // ⇒ 产物单独回退时门禁是空转（2026-09-17 三轮对抗复核 ME-6 残留）。
    const syncedDefault = /useEffect\)?\(\s*\(\)\s*=>\s*setInputOpen\(props\.defaultInputOpen\)\s*,\s*\[props\.defaultInputOpen\]\)/u
    assert.equal(
      syncedDefault.test(text),
      false,
      `${name}: 仍把派生默认值当受控值同步`,
    )
  }
})

test('ME-7：matchMedia 监听器的依赖数组必须带 userToggled（否则永远读旧值）', () => {
  for (const [name, text] of eachCarrier()) {
    if (name !== 'lib/client.js' && !name.endsWith('AdvisorPanel.tsx')) continue
    // 定位窄屏 effect 的收尾（removeEventListener + 依赖数组），两者必须相邻。
    const srcShape = /mediaQuery\.removeEventListener\('change', onMediaChange\)\s*\}, \[panelEnabled, userToggled\]\)/
    const bundleShape = /mediaQuery\.removeEventListener\("change", onMediaChange\);\s*\}, \[panelEnabled, userToggled\]\);/
    assert.ok(srcShape.test(text) || bundleShape.test(text), `${name}: 窄屏监听器依赖数组缺 userToggled`)
    assert.equal(
      /mediaQuery\.removeEventListener\((['"])change\1, onMediaChange\)\s*;?\s*\}, \[panelEnabled\]\)/.test(text),
      false,
      `${name}: 仍残留只依赖 panelEnabled 的旧写法`,
    )
  }
})
