-- 0068: 客户端错误上报(GlitchTip/Sentry 兼容)状态(2026-09-16)。
--
-- 背景:客户端按 bootstrap 下发的 `web.error_reporting_dsn` 初始化上报,
-- 但"服务端下发了 DSN" ≠ "客户端真的在报":DSN 非法、init 失败、开关关闭、
-- bootstrap 取不到配置时客户端一律**静默降级** —— 服务端把 DSN 发出去之后
-- 对上报链路的真实状态一无所知(现场事故:GlitchTip 项目始终为空,后台
-- 没有任何信号可查)。客户端因此计算一份状态
-- {state, reason, dsnHost, level, release} 并上报到
-- POST /api/client/v2/telemetry/error-reporting。
--
-- 本表按**用户一行**(PK user_id):语义是"该员工最新一次上报的状态",
-- 不做历史留存(表规模与 users 同级,后台上报状态页直接聚合)。
-- state 取值(客户端与服务端同一套白名单,服务端只落白名单内的值):
--   idle               尚未进入登录态/未初始化
--   disabled           服务端开关关闭或未配置 DSN
--   ready              已成功初始化 Sentry 并开始上报
--   failed             init/上报失败(reason 记原因)
--   config_unavailable bootstrap 拿不到上报配置
-- dsn_host 只存**裸主机名**(可带端口):整条 DSN 含公钥,绝不落库;
-- 管理端据此一眼看出"DSN 指向了 localhost"这类必然收不到事件的配置。
-- reason 面向排障,按 rune 截断 200 字(中文原因常见,不按字节截)。
-- 用户删除时级联清行(诊断数据不保留悬空用户)。
CREATE TABLE IF NOT EXISTS client_error_reporting_status (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT        NOT NULL,
  reason      TEXT        NOT NULL DEFAULT '',
  dsn_host    TEXT        NOT NULL DEFAULT '',
  level       TEXT        NOT NULL DEFAULT '',
  release     TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
