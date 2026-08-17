/**
 * Connector definition protocol (mirrors WorkBuddy's connector marketplace
 * entries: connectors.json manifest + mcp.json / token.json / cli.json).
 *
 * A connector declares how to authenticate against a third-party service and
 * how to spawn an MCP server that speaks for it once connected. The framework
 * (index.ts) owns the auth orchestration, token persistence and MCP
 * registration; connector packages only ship definitions.
 */
/** Authentication modes, matching WorkBuddy's auth modes. */
export type ConnectorAuthMode = 'oauth' | 'device' | 'token' | 'cli' | 'server-side';
/** OAuth authorization-code flow (supports RFC 8414 discovery + RFC 7591 dynamic registration + PKCE). */
export interface OAuthAuthConfig {
    /** Base authorize URL; `{redirect_uri}` and `{client_id}` get substituted. */
    authorizeUrl: string;
    /** Base token URL for exchanging the code. */
    tokenUrl: string;
    clientId: string;
    scopes?: string;
    redirectUri: string;
    /** RFC 7591 dynamic client registration endpoint (clientId then becomes optional). */
    registrationEndpoint?: string;
    /** Use PKCE S256 (required by RFC 8414 servers). */
    pkce?: boolean;
    /** Public client (no client secret at the token endpoint). */
    publicClient?: boolean;
}
/** Device-code (clawId-style) flow: show a verification URL + user code, poll. */
export interface DeviceAuthConfig {
    /** URL where the user enters the code. */
    verificationUrl: string;
    /** How often to poll for completion. */
    pollIntervalMs: number;
    /** How long to keep polling before giving up. */
    pollTimeoutMs: number;
}
/** Token form flow: ask the user for static fields (API key, access token...). */
export interface TokenField {
    key: string;
    label: string;
    /** 'password' renders masked and is persisted as a secret. */
    type: 'text' | 'password';
    required?: boolean;
    defaultValue?: string;
}
/** CLI flow: run a command that performs interactive auth (login), then poll a status command. */
export interface CliAuthConfig {
    /** Login command executable (e.g. 'dws', 'neocrm'). */
    command: string;
    args: string[];
    /** Env for the login command. */
    env?: Record<string, string>;
    /**
     * Device-flow parsing (mirrors WorkBuddy's cli.json authDeviceFlow): the
     * login command prints a verification URL and a user code, then keeps
     * polling until the user authorizes and exits (exit 0 = success). The
     * parsed URL/code are pushed to the UI through onRequest.
     */
    deviceFlow?: {
        /** Regex extracting the verification URL (first capture group, else the whole match). */
        uriPattern: string;
        /** Regex extracting the user code (first capture group, else the whole match). */
        codePattern?: string;
    };
    /** Keep the login process running until it exits naturally (device flow); default true when deviceFlow is set. */
    authWaitForExit?: boolean;
    /** Do not auto-open the verification URL (the UI shows it). */
    suppressBrowser?: boolean;
    /** Timeout for the whole auth process (ms). */
    timeoutMs?: number;
    /** Status check. `command` run with these args should exit 0 when connected and non-zero while the user is still authorizing. */
    statusCommand?: string;
    statusArgs?: string[];
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
}
/** Server-side flow: a fetch callback yields the token (managed by the backend). */
export interface ServerSideAuthConfig {
    /** Placeholder; the token fetch is injected by the framework owner. */
    fetchToken: () => Promise<string>;
}
/** MCP server registered for a connected connector. */
export interface ConnectorMcp {
    /** Namespace for `mcp__<serverName>__<tool>` public tool names. */
    serverName: string;
    /** Transport: spawn a stdio server or connect to a streamable HTTP endpoint. */
    transport?: 'stdio' | 'streamable-http';
    /** MCP server executable (stdio transport). */
    command?: string;
    args?: string[];
    /** Streamable HTTP endpoint URL. */
    url?: string;
    /**
     * Dynamic URL: command run after auth completes whose stdout yields the
     * endpoint URL (e.g. `dws mcp url get <mcpId>`). Takes precedence over `url`.
     */
    urlCommand?: string[];
    /** Extra env merged on top of the child env (stdio). */
    env?: Record<string, string>;
}
export interface ConnectorDef {
    /** Stable unique id, e.g. 'sales-easy'. */
    id: string;
    name: string;
    description: string;
    /** Optional local icon path. */
    icon?: string;
    authMode: ConnectorAuthMode;
    auth?: OAuthAuthConfig | DeviceAuthConfig | CliAuthConfig | ServerSideAuthConfig;
    /** Token form fields when authMode is 'token'. */
    tokenFields?: TokenField[];
    /** Pre-connect settings the user must fill before auth starts (e.g. OAuth client id). */
    settings?: TokenField[];
    /** Example prompts shown in the UI once connected. */
    examples?: string[];
    mcp: ConnectorMcp[];
}
/** Connection lifecycle state (mirrors WorkBuddy's status machine). */
export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'unauthorized' | 'error';
export interface ConnectorState {
    status: ConnectorStatus;
    /** User-facing error when status is 'error'. */
    error?: string | undefined;
    /** True once the user ever completed auth for this connector. */
    everConnected: boolean;
    connectedAt?: number | undefined;
}
/** Runtime callbacks the UI observes. */
export interface ConnectorAuthRequest {
    connectorId: string;
    /** Device-code or CLI flow: where the user should go to authorize. */
    verificationUrl?: string;
    /** Device-code or CLI flow: the code the user enters. */
    userCode?: string;
    /** OAuth flow: the authorize URL to open. */
    authorizeUrl?: string;
    /** Token flow: the fields to render. */
    fields?: TokenField[];
}
