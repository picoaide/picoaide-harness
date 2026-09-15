/**
 * 2026-09-15 全量审计实测的 `eval-policy` 双向失真回归。
 *
 * 审计现场（两个方向同时错）：
 * - **误杀**：`document.body.innerText.replace(/\s+/g,' ')` 被按名字拒绝——
 *   它其实是 `String.prototype.replace`（纯函数，不碰页面状态），而
 *   `WRITE_APIS` 只按成员名匹配，`replace` 在表里（为了挡 `location.replace`）。
 * - **漏放**：`Reflect.apply(localStorage['set'+'Item'], localStorage, ['k','v'])`
 *   真的写进了 storage。名字匹配既没看见 `setItem`（计算属性名是非字面量 ⇒
 *   被当成"数据访问"放过），也没看见调用关系（`Reflect.apply` 不在表里）。
 *
 * 修复口径是**接收者感知**而不是加白名单：
 * - 只有接收者可证明是字符串时才豁免 `replace`（纯函数）；
 * - `[1,2,3].push(4)`、`[1].sort()` 这类**原地改动**不在豁免范围（它们不是纯
 *   函数，既有回归断言也要求保持被拒）；
 * - 计算属性名先做**常量折叠**（`'set'+'Item'` ⇒ `setItem`）；
 * - `Reflect.construct` ≡ `new` ⇒ 一律拒绝；`Reflect.apply`/`Reflect.get` 按目标
 *   函数对象做同一判定，目标无法静态解析时 fail-closed。
 */
import { describe, expect, it } from 'vitest'
import { validateEvalExpression } from '../src/eval-policy.ts'
import { BrowserError } from '../src/errors.ts'

/** 断言表达式被拒，并返回错误（便于断言文案里点名了哪个 API）。 */
function rejection(expression: string): BrowserError {
  let thrown: unknown
  try {
    validateEvalExpression(expression)
  } catch (error) {
    thrown = error
  }
  expect(thrown, `expected a policy rejection for: ${expression}`).toBeInstanceOf(BrowserError)
  expect((thrown as BrowserError).code).toBe('eval-policy')
  return thrown as BrowserError
}

function accepted(expression: string): void {
  expect(() => validateEvalExpression(expression), expression).not.toThrow()
}

describe('2026-09-15 P2：接收者感知（误杀方向）', () => {
  it('审计实测表达式现在通过：document.body.innerText.replace(/\\s+/g,\' \')', () => {
    accepted(`document.body.innerText.replace(/\\s+/g,' ')`)
  })

  it('其它可证明是字符串的接收者同样通过（不改变语义）', () => {
    for (const expression of [
      `'a-b'.replace('-', '+')`,
      `readText('#x').trim().replace(/\\s+/g, ' ')`,
      `document.title.replace('x', 'y')`,
      `location.href.replace('#a', '')`,
      `String(x).replace('a', 'b')`,
      `el.value.replace(/\\s/g, '')`,
      `[...document.querySelectorAll('a')].map(a => a.textContent).join('|')`,
    ]) accepted(expression)
  })

  it('证明不了接收者就维持旧的名字拒绝（fail-closed，不放松）', () => {
    for (const expression of [
      `x.replace(/a/g, 'b')`,
      `alias.replace('/evil')`,
      `document.querySelector('a').replace('x', 'y')`,
      `foo['re'+'place']('/evil')`,
    ]) rejection(expression)
  })

  it('原地改动的数组方法照旧被拒（不是纯函数，也是既有契约）', () => {
    for (const expression of [
      `[1,2,3].push(4)`,
      `document.title && [1].sort()`,
      `[...document.querySelectorAll('a')].sort()`,
      `arr.fill(0)`,
      `arr.splice(0, 1)`,
    ]) rejection(expression)
  })

  it('导航/存储/脚本执行照旧被拒（收紧方向逐条不动）', () => {
    for (const expression of [
      `location.replace('https://evil.example')`,
      `history.replaceState(null, '', '/x')`,
      `localStorage.setItem('a', 'b')`,
      `sessionStorage.setItem('a', 'b')`,
      `document.write('<h1>x</h1>')`,
      `window.open('https://evil.example')`,
      `location.assign('https://evil.example')`,
      `history.pushState(null, '', '/x')`,
      `document.querySelector('form').submit()`,
      `document.querySelector('a').click()`,
      `alert(1)`,
      `eval('1')`,
      `Function('return 1')()`,
      // 读取 cookie 本身不是写（旧口径也放行）；赋值归 AssignmentExpression 拒
      `document.cookie = 'a=1'`,
    ]) rejection(expression)
  })
})

describe('2026-09-15 P2：Reflect 不得成为写 API 的替代入口', () => {
  it('审计实测泄漏路径被拒：Reflect.apply(localStorage[\'set\'+\'Item\'], …)', () => {
    const error = rejection(`Reflect.apply(localStorage['set'+'Item'], localStorage, ['k','v'])`)
    expect(error.message).toMatch(/setItem/u)
  })

  it('常量拼接的计算属性名先被折叠，再走同一判定', () => {
    for (const expression of [
      `localStorage['set'+'Item']('a', 'b')`,
      `localStorage['set' + 'Item']`,
      `localStorage[\`set\` + \`Item\`]`,
      `Reflect.apply(localStorage['set'+'Item'], localStorage, ['k','v'])`,
      `document['wr' + 'ite']('x')`,
      `location['re' + 'place']('/evil')`,
    ]) rejection(expression)
  })

  it('Reflect.construct ≡ new ⇒ 调用与取值两条路径都拒绝', () => {
    rejection(`Reflect.construct(Function, ['return 1'])`)
    rejection(`Reflect.construct.call(null, Date, [])`)
    rejection(`Reflect['con'+'struct'](Date, [])`)
  })

  it('Reflect.apply 的目标必须是静态可解析的纯函数', () => {
    accepted(`Reflect.apply(Math.max, null, [1,2,3])`)
    accepted(`Reflect.apply(JSON.parse, null, ['{}'])`)
    for (const expression of [
      `Reflect.apply(someFn, null, [1,2,3])`,
      `Reflect.apply(localStorage.setItem, localStorage, ['k','v'])`,
      `Reflect.apply(window.fetch, null, ['https://x'])`,
      `Reflect.apply(document.querySelector('a').click, null, [])`,
    ]) rejection(expression)
  })

  it('Reflect.get 的键折叠出写 API 名字 ⇒ 拒绝；动态键 ⇒ 拒绝', () => {
    rejection(`Reflect.get(localStorage, 'set' + 'Item')`)
    rejection(`Reflect.get(localStorage, key)`)
    accepted(`Reflect.get(obj, 'title')`)
  })

  it('普通读取与既有网络放行不受影响（不误杀）', () => {
    for (const expression of [
      `localStorage.getItem('t')`,
      `JSON.parse('{}')`,
      `window.__NEXT_DATA__`,
      `({a:1})['a']`,
      `[1,2,3][0]`,
      `document.querySelectorAll('a').length`,
      `window['fetch']('https://example.com')`,
      `fetch('https://example.com')`,
      `(x => x * 2)(21)`,
    ]) accepted(expression)
  })
})
