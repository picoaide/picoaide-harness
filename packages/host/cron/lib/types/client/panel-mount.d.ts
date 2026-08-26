import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import type { CronController } from './controller.ts';
/** Close the cron center (used by sibling panels and navigation). */
export declare function closeCronPanel(): void;
/** The injected panel container (kept in the DOM, hidden when inactive). */
export declare const CRON_VIEW_SELECTOR = "[data-dsh-cron-view]";
/**
 * Mount the cron center React tree into the center column and bind its
 * visibility to the html activation attribute.
 * @returns disposer unmounting the tree and restoring the column.
 */
export declare function mountCronPanel(controller: CronController, workspaces?: IWorkspaces, api?: ConnectionHandle['api']): () => void;
