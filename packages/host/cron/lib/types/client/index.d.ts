import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { CronKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Cron plugin surface copy. */
        cron: CronKey;
    }
}
import { type BrowserCronService } from './browser-service.ts';
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Browser cron face provided by the cron plugin's client half. */
        picoCronService: BrowserCronService;
    }
}
export declare function apply(ctx: ClientContext): void;
