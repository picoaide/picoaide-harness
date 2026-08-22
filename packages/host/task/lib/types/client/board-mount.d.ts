import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import type { TaskController } from './controller.ts';
/** Close the task board (used by sibling panels, navigation, and the board header). */
export declare function closeTaskBoard(): void;
/** The injected board container (kept in the DOM, hidden when inactive). */
export declare const TASK_VIEW_SELECTOR = "[data-dsh-task-view]";
/**
 * Mount the board React tree into the center column and bind its visibility
 * to the html activation attribute.
 * @returns disposer unmounting the tree and restoring the column.
 */
export declare function mountTaskBoard(controller: TaskController, workspaces?: IWorkspaces): () => void;
