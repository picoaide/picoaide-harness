/**
 * Browser client UI copy: zh is the key source, en mirrors the full key set.
 */
export declare const zh: {
    'panel.title': string;
    'panel.close': string;
    'panel.closeTab': string;
    'panel.tab': string;
    'panel.loading': string;
    'panel.newTab': string;
    'panel.back': string;
    'panel.forward': string;
    'panel.reload': string;
    'panel.addressPlaceholder': string;
    'panel.go': string;
    'panel.takeover': string;
    'panel.release': string;
    'panel.takeoverTitle': string;
    'panel.clear': string;
    'panel.clearTitle': string;
    'panel.controlledNotice': string;
};
export declare const en: Record<keyof typeof zh, string>;
export type BrowserKey = keyof typeof zh;
/** Translate a key (zh key source; en mirrors the full key set). */
export declare function t(key: BrowserKey): string;
