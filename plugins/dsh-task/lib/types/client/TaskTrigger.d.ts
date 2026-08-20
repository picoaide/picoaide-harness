/**
 * Sidebar foot action opening the task board in the main area (registered
 * into `sidebar.footer.action`, ordered between the cron entry and the
 * connector center). Global: root scope, no session dependency.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** The html attribute this panel toggles. */
export declare const TASK_ACTIVE_ATTR = "data-dsh-task-active";
/**
 * Sidebar foot trigger for the task board.
 * @param props - sidebar column state from the foot slot owner.
 */
export declare function TaskTrigger(props: PropsRuntime<'sidebar.footer.action'>): JSX.Element;
