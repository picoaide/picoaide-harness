import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
export interface TaskSettings {
    enabled?: boolean;
    announceToAgent?: boolean;
}
type TaskSettingsSnapshot = SettingsScopeSnapshot<TaskSettings>;
/** The registration-side face the card's slot entry injects. */
export interface TaskSettingsCardFace {
    getSnapshot(): TaskSettingsSnapshot;
    subscribe(listener: () => void): () => void;
    set: (field: keyof TaskSettings, value: boolean) => void;
}
export declare class TaskSettingsCardController {
    private readonly scope;
    constructor(scope: SettingsScope<TaskSettings>);
    getSnapshot(): TaskSettingsSnapshot;
    subscribe(listener: () => void): () => void;
    set(field: keyof TaskSettings, value: boolean): void;
    inject(): TaskSettingsCardFace;
}
export declare function TaskSettingsCard(props: PropsRuntime<'settings.plugin.item'> & TaskSettingsCardFace): JSX.Element;
export {};
