/**
 * Connectors client UI copy: zh is the key source, en mirrors the full key
 * set (the same pattern as dsh-cron/dsh-task locales).
 */
export declare const zh: {
    'panel.title': string;
    'panel.close': string;
    'search.placeholder': string;
    'filter.all': string;
    'filter.connected': string;
    'filter.disconnected': string;
    'filter.count': string;
    'empty.noMatch': string;
    'status.disconnected': string;
    'status.connecting': string;
    'status.connected': string;
    'status.unauthorized': string;
    'status.error': string;
    'action.connect': string;
    'action.disconnect': string;
    'action.submit': string;
    'action.connecting': string;
    'action.disconnecting': string;
    'auth.verificationHint': string;
    'auth.code': string;
    'auth.authorizeOpened': string;
    'auth.waiting': string;
    'auth.downloading': string;
};
export declare const en: Record<keyof typeof zh, string>;
export type ConnectorsKey = keyof typeof zh;
/** Translate a key (zh key source; en mirrors the full key set). */
export declare function t(key: ConnectorsKey, params?: Record<string, string>): string;
/** Map raw connector/CLI errors to user-facing copy (P3-6). */
export declare function friendlyConnectorError(raw: string): string;
