import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { TaskKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Task plugin surface copy. */
        task: TaskKey;
    }
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
