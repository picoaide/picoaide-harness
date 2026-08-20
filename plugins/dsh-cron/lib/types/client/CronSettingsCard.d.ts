import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
export interface CronSettings {
    enabled?: boolean;
    announceToAgent?: boolean;
    catchUpMissed?: boolean;
}
type CronSettingsSnapshot = SettingsScopeSnapshot<CronSettings>;
/** The registration-side face the card's slot entry injects (plain data + callbacks). */
export interface CronSettingsCardFace {
    getSnapshot(): CronSettingsSnapshot;
    subscribe(listener: () => void): () => void;
    set: (field: keyof CronSettings, value: boolean) => void;
}
export declare class CronSettingsCardController {
    private readonly scope;
    constructor(scope: SettingsScope<CronSettings>);
    getSnapshot(): CronSettingsSnapshot;
    subscribe(listener: () => void): () => void;
    set(field: keyof CronSettings, value: boolean): void;
    inject(): CronSettingsCardFace;
}
export declare function CronSettingsCard(props: PropsRuntime<'settings.plugin.item'> & CronSettingsCardFace): JSX.Element;
export {};
