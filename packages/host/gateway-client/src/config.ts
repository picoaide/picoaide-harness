export interface Session {
  serverURL: string
  username: string
  token: string
  /** RBAC role from the server login response (v3b §4.4); undefined = 未返回. */
  role?: string
  /** 0057: 账号来源('local'|'external'); external=LDAP/OIDC 由 IdP 管理密码. */
  source?: string
  /** 0057: 是否可自助改密(本地认证且启用); 客户端据此渲染改密入口. */
  passwordChangeable?: boolean
  /** 0057: 管理员重置密码后强制改密; 为 true 时客户端进入强制改密页. */
  mustChangePassword?: boolean
}

export interface BootstrapModel {
  id: string
  display_name: string
  /** Server-configured provider defaults as JSON text (e.g. `{"max_output": N}`). */
  default_params?: string
  /** 0058: 模型接受的输入模态('text'/'image');缺失 = 仅 text(客户端 schema 缺省)。 */
  input_modalities?: string[]
}

export interface BootstrapConfig {
  default_model: string
  models: BootstrapModel[]
  skills: { name: string; version: string; description: string }[]
  /**
   * **服务端当前不下发这个字段**（R21-F-05，2026-09-23 核对）。
   *
   * 服务端 `internal/bootstrap/bootstrap.go` 的 `Response` 只有
   * `default_model` / `models` / `skills` / `web` / `connectors` / `server_version`，
   * 全仓（`packages/**` 的 src 与 tests）也**没有任何消费方** —— 而它此前是**必填**，
   * 于是一个从不存在的 MCP 目录在类型层面被写成"一定有"（读它的人会以为拿到的是
   * 空数组，而不是 undefined）。
   *
   * 处置＝**改承诺**（与 `TestServerVersionIsInformationalOnly` 同一先例）：按兄弟
   * 字段 `connectors?` 的形状标成**可选**并写明"服务端不下发"。判据在
   * `tests/bootstrap-mcp-not-delivered.spec.ts`（**读 Go 源码**断言 `Response` 里没有
   * `mcp` 字段、且本字段在 TS 侧是可选的 —— 谁把服务端字段加回来，用例变红并要求
   * 同步这一处）。选"标可选"而不是"删字段"的理由：`bootstrap.ts` 的 `EMPTY` 与一批
   * 既有夹具都按必填形状构造它，而删字段要连带改那些文件（`bootstrap.ts` 不在本泳道
   * 文件所有权内）；标可选已经把假承诺消灭干净。
   */
  mcp?: { id: number; name: string; description: string; recommended: boolean }[]
  /** 连接器目录(0042):服务端下发,客户端连接器中心显示/连接。 */
  connectors?: { id: string; name: string; description: string; auth_mode: string; definition: string }[]
  web: {
    error_reporting_dsn?: string
    error_reporting_enabled?: boolean
    error_reporting_level?: string
    /**
     * 正向心跳开关(2026-09-16,D4):true 时客户端每次进程启动发一条带
     * `picoaide.heartbeat` tag 的 info 事件,**只对该 tag 绕过**
     * `error_reporting_level` 阈值 —— 等级阈值语义未改变;默认 false(与今天一致)。
     * 用途:证明「客户端 → GlitchTip」这一跳活着(否则健康链路在后台也是一片空白)。
     */
    error_reporting_heartbeat?: boolean
    /** 服务端下发的默认思考强度(默认模型 reasoningEffort);缺省不覆盖用户设置 */
    default_thinking_level?: string
  }
}
