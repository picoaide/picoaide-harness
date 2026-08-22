import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
import type { TaskController } from './controller.ts';
export declare function NewTaskModal({ controller, workspaces, onClose }: {
    controller: TaskController;
    workspaces?: IWorkspaces;
    onClose: () => void;
}): JSX.Element;
