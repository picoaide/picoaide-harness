/**
 * 剪贴板复制的**唯一实现**（2026-09-19）。
 *
 * 为什么要有它：管理端有三处"复制一段长文本"的场景（连接器定义 JSON、
 * 应用公告模板、以及后续可能的深链），此前各处自己写
 * `await navigator.clipboard.writeText(...)`。那条路有两个真实坑：
 *   ① `navigator.clipboard` 只在**安全上下文**（https / localhost）存在，
 *      客户内网用 http 打开管理端时它是 `undefined` ⇒ 裸调用抛 TypeError，
 *      用户看到"复制失败"却不知道可以手动选；
 *   ② 即使存在，写权限也可能被浏览器拒绝（用户拒绝/无用户手势）⇒ 必须捕获。
 * 因此统一成"先试异步 API，失败回落 `document.execCommand('copy')`"，
 * 并**如实返回布尔值**（调用方据此给出"请手动复制"的提示，不假装成功）。
 */

/**
 * 复制文本到剪贴板。
 *
 * @returns 成功返回 true；两条路径都失败返回 false（调用方必须给出可操作提示）。
 */
export async function copyText(text: string): Promise<boolean> {
  // 路径一：异步剪贴板 API（安全上下文 + 有用户手势时可用）。
  try {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(text)
      return true
    }
  } catch {
    /* 落到路径二；不要在这里 return false —— http 场景下 execCommand 仍可能成功 */
  }

  // 路径二：旧 API（jsdom 与 http 内网页面都走这条）。必须自己造一个
  // 可选中的 textarea：execCommand 只对**当前选区**生效。
  try {
    if (typeof document === 'undefined') return false
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    // 固定在视口外，避免复制瞬间页面跳动（移动端会滚动到聚焦元素）。
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    document.body.removeChild(area)
    return ok === true
  } catch {
    return false
  }
}
