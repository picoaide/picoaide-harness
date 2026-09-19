-- 0074: WASM 应用的访问模式 public → login（WASM「客户端专属」改造 · W4 删除波次）。
--
-- 来源：契约 §4.4（docs/planning/2026-09-19-wasm-client-only-design.md §9 的
-- `0074_wasm_access_public_to_login` 行，含三条事实订正）+ 数据与迁移复核 R1-DAT-2/3/4。
--
-- 为什么要有这条迁移（三条订正，缺一条都会做出错的版本）：
--
--   ① **不能用字面 REPLACE**：`REPLACE(config_json, '"access":"public"', …)`
--      只认紧凑形态，而库里真实存在 jsonb 形态（`{"access": "public", …}` 冒号后带空格，
--      jsonb 输出即此形）—— 字面替换对它是 0 命中，于是"迁移跑了、public 还在"，
--      升级后每一条验收都看起来执行过、实则什么都没改。因此判定与改写都走
--      **jsonb 往返**（`::jsonb` 解析 + `jsonb_set` 改写），形状差异由 jsonb 归一化吸收。
--
--   ② **运行期权威在磁盘资产，但读侧的 public 已经等同 login**：应用真正读的是
--      `<data_root>/apps/<app_id>/assets/<release_id>/picoaide.app.json`（磁盘资产），
--      而 `appcfg` 读侧早已把历史 public 映射成 login（`Config.AuthMode/RequiresLogin`）。
--      所以改写**磁盘**的真实意义不是"改权限"（权限早已不生效），而是让应用自己
--      `assets.read` 时**不再看到 public**、口径彻底退场 —— 否则应用可能照着配置里的
--      "匿名可用"自行实现一套匿名行为。DB 侧（本迁移）与磁盘侧（appseed 的
--      RewritePublicAccessAssets，A 方案）必须都做：只做一侧，另一边就是永久残留。
--
--   ③ **必须与 legacyAnonymous 的清理同批（W4）**：平台侧的匿名放行分支在 W4 删除，
--      本迁移把数据面同批收敛；时序颠倒会留下"数据说 public、代码已不认"或反过来的窗口。
--
-- 改写规则（与 0071 同款 jsonb 往返写法）：
--   apps / app_releases 中 kind='wasm_app' 且 `access` 恰为字符串 'public' 的行
--   ⇒ `jsonb_set(config_json::jsonb, '{access}', '"login"')`，**其余键逐字保留**
--     （jsonb_set 只替换那一个键，purpose/owner/whitelist/自定义键原样带出）。
--
-- 幂等（第二次执行命中 0 行、字节不变）：判定里带 `- 'access' = 'public'`，
-- 第一次执行后所有命中行都变成 login ⇒ 再跑没有任何行进入 SET。
--
-- 坏 JSON 行（列类型是 TEXT，历史上手工写入过什么不可假设）：**跳过而不是炸库**，
-- 由末尾 DO 段 RAISE WARNING 报出数量；自检只对"合法 JSON 对象且仍 public"的行 fail-loud。
--
-- ⚠️ 本迁移**不得出现半角问号字符**：全仓 SQL 走 rewritePlaceholders（db.go），
-- 它把任何该字符（含注释里的）当占位符改写成 $N ⇒ 写成 JSONB 存在性运算符会变成
-- 语法错误（0071 头注释里的同一条约束）。因此存在性一律用函数形式
-- jsonb_exists(col, 'key')，取值一律用 `->>`。

-- ===== 1) apps：public → login =====
UPDATE apps
SET config_json = jsonb_set(config_json::jsonb, '{access}', '"login"')::text
WHERE kind = 'wasm_app'
  AND config_json <> ''
  AND config_json IS JSON OBJECT
  AND jsonb_exists(config_json::jsonb, 'access')
  AND config_json::jsonb ->> 'access' = 'public';

-- ===== 2) 同一规则改写 app_releases.config_json（列存在才改） =====
-- 为什么连版本快照一起改：它是每版不可变快照，运维面/导出会读这一列；只改 apps
-- 会让"同一个版本在导出里是 public、在生效行里是 login"这种状态无法解释（0071 同一理由）。
DO $wasm_access_public_release_rewrite$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'app_releases' AND column_name = 'config_json') THEN
    UPDATE app_releases
    SET config_json = jsonb_set(config_json::jsonb, '{access}', '"login"')::text
    WHERE kind = 'wasm_app'
      AND config_json <> ''
      AND config_json IS JSON OBJECT
      AND jsonb_exists(config_json::jsonb, 'access')
      AND config_json::jsonb ->> 'access' = 'public';
  END IF;
END
$wasm_access_public_release_rewrite$;

-- ===== 3) 自检：public 必须清零（fail-loud）+ 坏 JSON 只告警 =====
-- 判据与上面 UPDATE 的 WHERE **逐条对齐**（0071 P2-1 的教训：自检条件与改写条件
-- 不一致会把合法行算成"未改写"并 RAISE，升级直接失败）。两者同谓词 ⇒ 本段只在
-- "改写没有真正生效"（迁移被截断/改写被触发器或权限静默吞掉/后续手工写回 public）
-- 时才炸，正是 fail-loud 想要的那一类。
DO $wasm_access_public_selfcheck$
DECLARE
  stale_apps    BIGINT;
  stale_rels    BIGINT;
  bad_json_apps BIGINT;
  bad_json_rels BIGINT;
BEGIN
  SELECT count(*) INTO stale_apps FROM apps
   WHERE kind = 'wasm_app'
     AND config_json <> ''
     AND config_json IS JSON OBJECT
     AND jsonb_exists(config_json::jsonb, 'access')
     AND config_json::jsonb ->> 'access' = 'public';
  IF stale_apps > 0 THEN
    RAISE EXCEPTION '0074: 仍有 % 行 wasm 应用的 access=public（改写未生效）', stale_apps;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'app_releases' AND column_name = 'config_json') THEN
    SELECT count(*) INTO stale_rels FROM app_releases
     WHERE kind = 'wasm_app'
       AND config_json <> ''
       AND config_json IS JSON OBJECT
       AND jsonb_exists(config_json::jsonb, 'access')
       AND config_json::jsonb ->> 'access' = 'public';
    IF stale_rels > 0 THEN
      RAISE EXCEPTION '0074: 仍有 % 行 wasm 版本快照的 access=public（改写未生效）', stale_rels;
    END IF;
  END IF;

  -- 坏 JSON 不是本迁移的失败条件（跳过即可），但必须能一眼看见被跳过了多少行：
  -- 这些行的 access 无法判定，值得排查（列是 TEXT，来源不可假设）。
  SELECT count(*) INTO bad_json_apps FROM apps
   WHERE kind = 'wasm_app' AND config_json <> '' AND NOT (config_json IS JSON OBJECT);
  IF bad_json_apps > 0 THEN
    RAISE WARNING '0074: % 行 apps.config_json 不是合法 JSON 对象，已跳过改写', bad_json_apps;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'app_releases' AND column_name = 'config_json') THEN
    SELECT count(*) INTO bad_json_rels FROM app_releases
     WHERE kind = 'wasm_app' AND config_json <> '' AND NOT (config_json IS JSON OBJECT);
    IF bad_json_rels > 0 THEN
      RAISE WARNING '0074: % 行 app_releases.config_json 不是合法 JSON 对象，已跳过改写', bad_json_rels;
    END IF;
  END IF;
END
$wasm_access_public_selfcheck$;
