import { type TaskKey } from './locales.ts';
export declare const PERMISSION_OPTIONS: ReadonlyArray<{
    value: string;
    label: TaskKey;
}>;
export declare function PermissionPicker({ value, onChange }: {
    value: string;
    onChange: (permission: string) => void;
}): JSX.Element;
