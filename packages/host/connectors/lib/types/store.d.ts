/** Per-user connector credential store under the product home. */
export interface ConnectorCredential {
    /** OAuth access token. */
    accessToken?: string;
    /** OAuth refresh token. */
    refreshToken?: string;
    /** OAuth client info (client id/secret) when the provider issues its own. */
    clientId?: string;
    clientSecret?: string;
    /** Token-form field values (password fields stored as-is; plaintext on disk is the price of the lazy design). */
    fields?: Record<string, string>;
    updatedAt: number;
}
export interface ConnectorStoreOptions {
    /** Override the base directory (tests). */
    baseDir?: string;
    /** The logged-in username; per-user scoping when omitted/missing. */
    username?: string | null;
}
export declare class ConnectorStore {
    private readonly dir;
    constructor(options?: ConnectorStoreOptions);
    private path;
    readCredential(id: string): Promise<ConnectorCredential | null>;
    writeCredential(id: string, credential: ConnectorCredential): Promise<void>;
    updateCredential(id: string, patch: Partial<ConnectorCredential>): Promise<ConnectorCredential>;
    clearCredential(id: string): Promise<void>;
    hasCredential(id: string): Promise<boolean>;
}
