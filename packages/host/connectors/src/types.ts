/**
 * Connector definition protocol (mirrors WorkBuddy's connector marketplace
 * entries: connectors.json manifest + mcp.json / token.json / cli.json).
 *
 * A connector declares how to authenticate against a third-party service and
 * how to spawn an MCP server that speaks for it once connected. The framework
 * (index.ts) owns the auth orchestration, token persistence and MCP
 * registration; connector packages only ship definitions.
 */

/** Authentication modes (决策 2026-08-25:CLI 已移除——CLI 即 skill)。 */
export type ConnectorAuthMode = 'oauth' | 'device' | 'token' | 'server-side'

/** OAuth authorization-code flow (supports RFC 8414 discovery + RFC 7591 dynamic registration + PKCE). */
export interface OAuthAuthConfig {
  /** Base authorize URL; `{redirect_uri}` and `{client_id}` get substituted. */
  authorizeUrl: string
  /** Base token URL for exchanging the code. */
  tokenUrl: string
  clientId: string
  scopes?: string
  redirectUri: string
  /** RFC 7591 dynamic client registration endpoint (clientId then becomes optional). */
  registrationEndpoint?: string
  /** Use PKCE S256 (required by RFC 8414 servers). */
  pkce?: boolean
  /** Public client (no client secret at the token endpoint). */
  publicClient?: boolean
  /**
   * MCP OAuth discovery (spec 2025-06-18): the MCP endpoint URL itself. At
   * connect time the framework probes it — a 2xx means the server is public
   * (connected without credentials); a 401 triggers RFC 8414 metadata
   * discovery at `{url}/.well-known/oauth-authorization-server` (fallback:
   * host root) to derive authorize/token/registration endpoints.
   */
  discoveryUrl?: string
}

/** Device-code (clawId-style) flow: show a verification URL + user code, poll. */
export interface DeviceAuthConfig {
  /** URL where the user enters the code. */
  verificationUrl: string
  /** How often to poll for completion. */
  pollIntervalMs: number
  /** How long to keep polling before giving up. */
  pollTimeoutMs: number
}

/** Token form flow: ask the user for static fields (API key, access token...). */
export interface TokenField {
  key: string
  label: string
  /** 'password' renders masked and is persisted as a secret. */
  type: 'text' | 'password'
  required?: boolean
  defaultValue?: string
}

/** Server-side flow: a fetch callback yields the token (managed by the backend). */
export interface ServerSideAuthConfig {
  /** Placeholder; the token fetch is injected by the framework owner. */
  fetchToken: () => Promise<string>
}

/** MCP server registered for a connected connector. */
export interface ConnectorMcp {
  /** Namespace for `mcp__<serverName>__<tool>` public tool names. */
  serverName: string
  /** Transport: spawn a stdio server or connect to a streamable HTTP endpoint. */
  transport?: 'stdio' | 'streamable-http'
  /** MCP server executable (stdio transport). */
  command?: string
  args?: string[]
  /** Streamable HTTP endpoint URL. */
  url?: string
  /** Extra env merged on top of the child env (stdio). */
  env?: Record<string, string>
  /**
   * Static request headers (streamable-http). Values containing `${FIELD}`
   * are rendered from the stored credential fields; an empty `Authorization`
   * is filled with the stored access token as `Bearer <token>`.
   */
  headers?: Record<string, string>
}

export interface ConnectorDef {
  /** Stable unique id, e.g. 'example-crm'. */
  id: string
  name: string
  description: string
  /** Optional local icon path. */
  icon?: string
  authMode: ConnectorAuthMode
  auth?: OAuthAuthConfig | DeviceAuthConfig | ServerSideAuthConfig
  /** Token form fields when authMode is 'token'. */
  tokenFields?: TokenField[]
  /** Pre-connect settings the user must fill before auth starts (e.g. OAuth client id). */
  settings?: TokenField[]
  /** Example prompts shown in the UI once connected. */
  examples?: string[]
  mcp: ConnectorMcp[]
}

/** Connection lifecycle state (mirrors WorkBuddy's status machine). */
export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'unauthorized' | 'error'

export interface ConnectorState {
  status: ConnectorStatus
  /** User-facing error when status is 'error'. */
  error?: string | undefined
  /** True once the user ever completed auth for this connector. */
  everConnected: boolean
  connectedAt?: number | undefined
}

/** Runtime callbacks the UI observes. */
export interface ConnectorAuthRequest {
  connectorId: string
  /** Device-code or CLI flow: where the user should go to authorize. */
  verificationUrl?: string
  /** Device-code or CLI flow: the code the user enters. */
  userCode?: string
  /** OAuth flow: the authorize URL to open. */
  authorizeUrl?: string
  /** Token flow: the fields to render. */
  fields?: TokenField[]
  /** Transient progress text (e.g. "正在下载命令行工具…") while connecting. */
  message?: string
}
