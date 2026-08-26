import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import type { CronController } from './controller.ts';
export declare function CronJobTab({ controller, workspaces, api, openSession }: {
    controller: CronController;
    workspaces?: IWorkspaces;
    api?: ConnectionHandle['api'];
    openSession?: (sessionId: string) => void;
}): JSX.Element;
