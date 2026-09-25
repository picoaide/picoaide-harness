-- 0082: 月报订阅的「待补期号 + 失败重试退避」（R19A-S1-06/S1-07，审计 2026-09-25，P2）。
--
-- 为什么需要这三列（两件事用同一个真相：**这一轮该投哪一期、什么时候该再试**）：
--
--   ① 跨月丢期。R18C-03（上一轮）让 `MarkReportRun` 失败时**不再推进 last_run_at`
--      （这是对的：否则失败的那一期在本月内永不重投），但"该投哪一期"只能由
--      `last_run_at` 反推"当前月的上一月" ⇒ 失败一旦跨过月界，**被跨过的那一期静默
--      丢失**（实测：9/30 失败的那一期是 8 月，10/1 直接投 9 月、期号从 08 跳到 09），
--      而 webadmin 对管理员的承诺是"按小时重试同一期（成功才更新上次推送）"。
--      单靠一个时间戳表达不了"待补期号" ⇒ 加 `pending_period`。
--
--   ② 重试没有退避。同一次修复把失败路径放开成"每 tick 一次"：永久坏的 webhook
--      （地址写错、机器人被删）在真实部署里 = 24 次/天/实例、≈720 次/月的真实出站
--      请求。退避需要记住"连续失败了几次"与"下次最早何时再试" ⇒ 加 `fail_streak`
--      与 `next_attempt_at`。
--
-- 三列都带缺省值，存量行语义**逐字不变**：
--   pending_period = ''（⇒ 按"当前月的上一期"投递，与修前相同）、
--   fail_streak = 0 / next_attempt_at NULL（⇒ 立即可投，不引入冷启动延迟）。
--
-- 回滚口径：这三列只被 `internal/reports` 的投递策略读取。回滚到旧二进制时旧代码
-- 不读它们（DDL 是纯加列，回滚**不需要**恢复库）；确认不再需要时执行
--   ALTER TABLE report_subscriptions DROP COLUMN pending_period, DROP COLUMN fail_streak,
--   DROP COLUMN next_attempt_at;
-- 即可回到修前状态（代价：进行中的补投期号与退避计数丢失）。
ALTER TABLE report_subscriptions ADD COLUMN IF NOT EXISTS pending_period TEXT NOT NULL DEFAULT '';
ALTER TABLE report_subscriptions ADD COLUMN IF NOT EXISTS fail_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_subscriptions ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
