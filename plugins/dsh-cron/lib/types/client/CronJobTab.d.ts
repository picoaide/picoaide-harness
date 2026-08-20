import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import type { CronController } from './controller.ts';
export declare function CronJobTab({ controller, workspaces }: {
    controller: CronController;
    workspaces?: IWorkspaces;
}): JSX.Element;
