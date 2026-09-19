-- 0073: WASM 应用平台「客户端专属」改造 —— 删除旧访问模型的会话表（W4 删除波次）。
--
-- ⚠️ 本迁移**必须在停机窗口内执行**：`DROP TABLE` 取 **ACCESS EXCLUSIVE** 锁，
-- 旧实例（还在跑子域/换票路径的进程）持有这些表的连接时，DROP 会一直等到
-- `lock_timeout` 到点并失败 —— 部署会挂在那里。正确顺序 = 先停旧实例、再升库。
-- 因此本文件开头显式设 `lock_timeout`：宁可**快速失败**，也不要无声地卡住部署。
--
-- 为什么这两张表可以整条删掉（而不是留表/留列）：
--   旧模型 = 员工用浏览器打开 `https://<app_id>.<应用基域>/`，平台用「一次性换票」
--   把主站登录态换成应用子域 Cookie。`employee_sessions`（员工浏览器会话）与
--   `app_sessions`（应用会话）就是那套模型的全部持久状态。
--   客户端专属模型（2026-09-19 定案，总纲 §8.4）下应用只在桌面客户端内以
--   `<渠道 app scheme>://<app_id>` 打开，身份由客户端持员工 bearer 注入 ⇒
--   平台上不再有应用会话，也没有换票。表留着只会让"读不到写入方"的旧行长期驻留。
--
-- ⚠️ 顺序**不可颠倒**、且**不加 CASCADE**：
--   * `app_sessions.employee_session_id` 有指向 `employee_sessions(id)` 的外键
--     （建表见 0070:68）⇒ 先删被引用方（employee_sessions）会因依赖而失败；
--   * 不加 CASCADE 是**有意的**：万一将来有别的表引用了它们，DROP 会**报错停下**
--     让人看见，而不是静默把别人的行一起删掉。`DROP TABLE` 自身就会带走该表的
--     索引与约束（那些是表的一部分，不需要 CASCADE）。
--
-- 幂等：`IF EXISTS`（第二次执行是 no-op，不报错、不改任何字节）；不触碰任何其它表。
-- 回滚：本迁移不可逆（会话数据按设计不再需要）。降级到旧二进制需要从备份恢复 ——
-- 这条已写进发布说明的回滚口径（总纲 §9 与 §17）。
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS app_sessions;
DROP TABLE IF EXISTS employee_sessions;
