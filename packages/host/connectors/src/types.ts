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
type ConnectorAuthMode = 'oauth' | 'device' | 'token' | 'server-side'

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
/** Token form fields: labels + defaults for one credential input. */
interface TokenField {
  key: string
  label: string
  /** 'password' renders masked and is persisted as a secret. */
  type: 'text' | 'password'
  required?: boolean
  defaultValue?: string
}

/** Server-side flow: a fetch callback yields the token (managed by the backend). */
interface ServerSideAuthConfig {
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
type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'unauthorized' | 'error'

export interface ConnectorState {
  status: ConnectorStatus
  /** User-facing error when status is 'error'. */
  error?: string | undefined
  /** True once the user ever completed auth for this connector. */
  everConnected: boolean
  connectedAt?: number | undefined
}

/**
 * One stdio command inside a multi-server confirmation (audit R3, N1).
 *
 * A connector may declare several stdio servers; one answer approves all of
 * them, so the disclosure has to name each command and each key set rather
 * than the first one.
 */
export interface ConnectorMcpApprovalCommand {
  /** `mcp[].serverName` this command belongs to. */
  serverName: string
  /** Executable this server asks to run. */
  command: string
  /** Argument vector as this server declares it. */
  args: string[]
  /**
   * EVERY environment-variable name THIS server's child will (or may) receive
   * — see {@link ConnectorMcpApproval.envKeys} for the "may" part.
   */
  envKeys: string[]
}

/**
 * Local confirmation of a server-issued stdio command (FIX-02 P0): the first
 * spawn of a `(command, args, env)` fingerprint must be approved on this
 * machine. The request carries everything the user needs to judge it.
 */
export interface ConnectorMcpApproval {
  /** `sha256` of the spawn tuple; the key persisted once approved. */
  fingerprint: string
  /** Executable the definition asks to run (first pending server; see `commands`). */
  command: string
  /** Argument vector as the definition declares it (first pending server). */
  args: string[]
  /**
   * EVERY environment-variable name ANY covered child process will or may
   * receive — the definition's `mcp[].env`, the credential field names it
   * declares (even before a value is stored: a later value must not inject an
   * undisclosed name without a new prompt, audit R3 N2) and the framework's own
   * keys. Values are never shown here, but a name the user was not shown must
   * never be injected (residual A). This is the UNION over `commands`.
   */
  envKeys: string[]
  /** MCP server names this approval covers. */
  servers: string[]
  /**
   * Per-server detail of every command one answer approves (audit R3, N1):
   * the single-answer UI renders this instead of only the first server.
   * Optional so an already-serialized prompt stays readable.
   */
  commands?: ConnectorMcpApprovalCommand[]
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
  /** Present while a server-issued stdio command awaits local confirmation. */
  approval?: ConnectorMcpApproval
}
