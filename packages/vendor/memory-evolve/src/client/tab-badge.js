/**
 * 带红点计数的会话 Tab 条目生命周期（ME-1，2026-09-17 二审修复）。
 *
 * 缺陷形态：计数变化时 `dispose + 重新 register`。上游 `conversation.view`
 * 列表槽的条目按**条目对象身份**做 React key（ui-renderer/scoped-slots.tsx
 * 的 `entryKeyOf` 是 WeakMap 序号，注册一次一个号），重注册 = 换 key ⇒
 * 当前正在显示的视图整棵重挂（`renderSlot('conversation.view', …, { only:
 * active.id })` 只渲染激活 Tab，重挂的正是用户正在用的那棵）：敲到一半的
 * 任务 prompt、选中的任务与日志面板、搜索词/页码、刚打开的浮层全部归零。
 *
 * 修法：条目只注册一次；label 是 thunk（上游 `resolveSlotLabel` 每次读取时
 * 求值，不是注册时快照），计数由 thunk 现读；计数变化只调用 `poke()` 触发
 * 一次 `conversation.view` 账本通知，让上游 refreshViews 重读 label ——
 * 条目身份不变 ⇒ React key 不变 ⇒ 子树不重挂。
 */

/** 计数归一：非有限数/负数一律按 0（红点语义只有「无/有 N 条」）。 */
function normalizeCount(next) {
  return typeof next === 'number' && Number.isFinite(next) && next > 0 ? Math.trunc(next) : 0
}

/**
 * @param {(getCount: () => number) => (() => void)} register
 *   注册条目并返回 disposer；label thunk 里通过 getCount() 现读计数。
 * @param {() => void} poke 计数变化时的「刷新 label」通知（见 index.ts 的
 *   pokeTabLabels：账本写入是上游唯一的重读触发点）。
 */
export function createBadgeTab(register, poke) {
  let disposer
  let count = 0
  return {
    /** 注册条目（幂等：已注册即 no-op —— 绝不 dispose 重来）。 */
    mount() {
      if (disposer !== undefined) return
      disposer = register(() => count)
    },
    /** 更新红点计数：值没变不做事；变化只 poke，不重注册。 */
    setCount(next) {
      const value = normalizeCount(next)
      if (value === count) return
      count = value
      if (disposer !== undefined) poke()
    },
    count: () => count,
    mounted: () => disposer !== undefined,
    dispose() {
      const dispose = disposer
      disposer = undefined
      dispose?.()
    },
  }
}
