import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import type { TaskRecord } from '../tasks.ts';
import type { TaskController } from './controller.ts';
/** The cron service face (spelled locally; runtime identity is the cordis service). */
export interface CronServiceFace {
    getSnapshot(): {
        jobs: Array<{
            id: string;
            name: string;
            cron: string;
            enabled: boolean;
            action: {
                kind: string;
                taskId?: string;
            };
        }>;
    };
    registerJob(registration: {
        id: string;
        name: string;
        cron: string;
        action: {
            kind: 'task';
            taskId: string;
        };
        enabled?: boolean;
    }): void;
    unregisterJob(id: string): void;
    subscribe(listener: () => void): () => void;
}
export declare function TaskDetail({ controller, task, cron, workspaces }: {
    controller: TaskController;
    task: TaskRecord;
    cron?: CronServiceFace;
    workspaces?: IWorkspaces;
}): JSX.Element;
