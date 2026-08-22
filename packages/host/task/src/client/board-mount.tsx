/**
 * Main-area mounting for the task board.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the board takes over the center column at
 * the DOM level — the same pattern as upstream dsh-task-board: a container is
 * appended inside the center column (`[class*="centerCol"]`, legacy
 * `[data-pane="conversation"]`) as a trailing child React never manages.
 *
 * Visibility is driven by a global stylesheet rule scoped to the html
 * activation attribute — no JS display toggling. While the board is active,
 * the conversation content underneath is hidden (it stays mounted and
 * stateful); the `!important` is required because the dsh shell wraps the
 * conversation view in a node with an inline `display: contents`.
 */
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { TaskController } from './controller.ts'
import { TaskBoard } from './TaskBoard.tsx'
import { TASK_ACTIVE_ATTR } from './TaskTrigger.tsx'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'task'
const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

/** Close the task board (used by sibling panels, navigation, and the board header). */
export function closeTaskBoard(): void {
  document.documentElement.removeAttribute(TASK_ACTIVE_ATTR)
}

/** The injected board container (kept in the DOM, hidden when inactive). */
export const TASK_VIEW_SELECTOR = '[data-dsh-task-view]'

/** Global visibility rules (injected once per plugin activation). */
function visibilityStyle(): HTMLStyleElement {
  const style = document.createElement('style')
  style.dataset.dshTaskVisibility = ''
  // Base: the container starts hidden via a stylesheet rule (NOT an inline
  // style — an inline display:none would out-prioritize every non-important
  // rule below and the board could never show). While the board is active,
  // show the container and hide the conversation subtree. !important on the
  // hide side beats the shell's inline display:contents.
  style.textContent = [
    `[data-dsh-task-view] {`,
    `  display: none;`,
    `  height: 100%;`,
    `  width: 100%;`,
    `}`,
    `html[${TASK_ACTIVE_ATTR}] [data-pane='conversation'] > :not([data-dsh-task-view]),`,
    `html[${TASK_ACTIVE_ATTR}] [class*='centerCol'] > :not([data-dsh-task-view]) {`,
    `  display: none !important;`,
    `}`,
    `html[${TASK_ACTIVE_ATTR}] [data-dsh-task-view] {`,
    `  display: block;`,
    `}`,
  ].join('\n')
  return style
}

/**
 * Mount the board React tree into the center column and bind its visibility
 * to the html activation attribute.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountTaskBoard(controller: TaskController, workspaces?: IWorkspaces): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const style = visibilityStyle()
  document.head.appendChild(style)

  const ensure = (): void => {
    if (container !== undefined) return
    const column = document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR)
    if (column === null) return
    container = document.createElement('div')
    container.dataset.dshTaskView = ''
    container.dataset.dshPlugin = 'task'
    // No inline display here: visibility is owned by the injected
    // stylesheet rule (an inline style would defeat the show rule).
    column.appendChild(container)
    root = createRoot(container)
    root.render(createElement(TaskBoard, { controller, onClose: closeTaskBoard, ...(workspaces === undefined ? {} : { workspaces }) }))
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== PANEL_NAME) closeTaskBoard()
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!document.documentElement.hasAttribute(TASK_ACTIVE_ATTR)) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) closeTaskBoard()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)

  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    closeTaskBoard()
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
    style.remove()
  }
}
