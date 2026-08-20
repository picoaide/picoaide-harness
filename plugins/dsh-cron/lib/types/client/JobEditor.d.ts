import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import { type JobRecord } from '../jobs.ts';
import type { CronController } from './controller.ts';
export declare function JobEditor({ controller, job, workspaces, onClose }: {
    controller: CronController;
    job?: JobRecord;
    workspaces?: IWorkspaces;
    onClose: () => void;
}): JSX.Element;
