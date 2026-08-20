import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
export interface WorkspaceOption {
    workspaceId: string;
    title: string;
}
/** Extract the workspace option list from the client feed. */
export declare function workspaceOptionsFrom(workspaces: IWorkspaces | undefined): WorkspaceOption[];
/** Subscribe to the workspaces feed; returns the latest option list. */
export declare function useWorkspaceOptions(workspaces: IWorkspaces | undefined): WorkspaceOption[];
