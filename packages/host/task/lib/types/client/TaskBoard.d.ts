import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import type { TaskController } from './controller.ts';
export declare function TaskBoard({ controller, onClose, workspaces }: {
    controller: TaskController;
    onClose?: () => void;
    workspaces?: IWorkspaces;
}): JSX.Element;
