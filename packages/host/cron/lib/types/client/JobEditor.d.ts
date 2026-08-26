import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import { type JobRecord } from '../jobs.ts';
import type { CronController } from './controller.ts';
export declare function JobEditor({ controller, job, workspaces, api, onClose }: {
    controller: CronController;
    job?: JobRecord;
    workspaces?: IWorkspaces;
    api?: ConnectionHandle['api'];
    onClose: () => void;
}): JSX.Element;
