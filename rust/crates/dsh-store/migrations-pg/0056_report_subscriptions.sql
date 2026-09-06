-- 0056: 月度报表订阅(2026-09 P1 用量中心)。
-- 周期生成上月用量汇总并推送到企业 webhook(钉钉/企微/飞书自定义机器人等)。
CREATE TABLE report_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  hook_url    TEXT NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
