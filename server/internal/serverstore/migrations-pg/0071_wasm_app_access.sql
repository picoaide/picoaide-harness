-- 0071: WASM 应用平台 —— 访问模式收敛为 `access` 三模式（2026-09-18 用户拍板）。
--
-- 变更来源：用户裁定「应用中心里无论是否公开的，或者没权限的都应该展示出来」
-- + 配置文件的权限支持「公开 / 登陆后使用（默认全员）/ 白名单用户」，并选定
-- ①收敛成 `access` 枚举、删掉 `visible`；②准入仍由应用判定（R24 不变）。
-- 设计基线 docs/planning/2026-09-17-wasm-app-platform.md 的 R25 / R38 / §4.2 /
-- §7.1 / §10.5 第 56c、56e 项已就地加 ⚠️ 勘误。
--
-- 两件事：
--   1) 删掉 apps.visible 列 —— 目录不再按可见性过滤（R38 作废）。
--      访问模式不再有独立投影列：要显示时从 config_json 现解（appcfg.AccessOfConfigJSON）。
--   2) 把**存量** config_json 里的旧 schema 就地改写成新 schema：
--        login_required=false                   ⇒ access="public"
--        login_required=true  + whitelist 非空   ⇒ access="whitelist"
--        login_required=true  + whitelist 空     ⇒ access="login"（"登录后全员"是合法模式）
--        login_required 缺失（旧缺省 true）       ⇒ 同上两条
--        visible                                ⇒ 一律丢弃（不再有语义）
--      与 appcfg.Parse 的兼容 shim **同一张映射表**（旧字段只是"读得到"的历史形态；
--      重新发布后写出的就是新 schema）。
--
-- 为什么连 app_releases.config_json 一起改写：它是每版不可变快照（§4.2「改配置 =
-- 发新版」），应用侧读的是随包资产、但运维面与导出会读这一列；两处口径分叉会让
-- "同一个版本在导出里是旧 schema、在新发布里是新 schema"这种状态无法解释。
-- 改写只动我们自己的两个键，其余键（purpose/owner/...）**逐字保留**。
--
-- 幂等可重放（IF EXISTS / 条件 UPDATE / DO $$ 自检），与既有迁移同风格：
--   * 已含 access 的行不会被再改（条件里排除）；
--   * 第二次重放时没有任何行命中条件 ⇒ 零副作用；
--   * 坏 JSON 行**跳过而不是炸库**（列类型是 TEXT，历史上手工写入过什么不可假设），
--     但自检段会对"仍是合法 JSON 对象却仍带旧键"的行 RAISE，fail-loud。

-- ⚠️ 本迁移**不得出现半角问号字符**：全仓 SQL 走 rewritePlaceholders（db.go），
-- 它把任何该字符（含注释里的）当占位符改写成 $N ⇒ 写成 JSONB 存在性运算符会变成
-- 语法错误。因此 JSONB 存在性一律用函数形式 jsonb_exists(col, 'key')。
--
-- ===== 1) 目录不再按可见性过滤：删列 =====
ALTER TABLE apps DROP COLUMN IF EXISTS visible;

-- ===== 2) 旧 schema → 新 schema 的改写（apps） =====
-- 条件三件套：
--   kind='wasm_app'          —— 技能/智能体行不碰（config_json 是 0069 才加的列，
--                               它们的值语义与本平台无关）；
--   config_json IS JSON OBJECT —— 坏 JSON 直接跳过（下面 DO 段会点名报告）；
--   非空且带旧键且**不带** access —— 幂等：已改写的行不再命中。
UPDATE apps
SET config_json = (
      (config_json::jsonb
        - 'login_required' - 'visible')
      || jsonb_build_object('access',
           CASE
             -- 只在旧值是**布尔**时按它映射：手工写入的畸形值按"缺省 true"处理
             -- （归一化掉旧键，不让一行脏数据卡住整个升级）。
             WHEN jsonb_typeof(config_json::jsonb -> 'login_required') = 'boolean'
                  AND (config_json::jsonb -> 'login_required')::boolean = false
               THEN 'public'
             WHEN jsonb_typeof(config_json::jsonb -> 'whitelist') = 'array'
                  AND jsonb_array_length(config_json::jsonb -> 'whitelist') > 0
               THEN 'whitelist'
             ELSE 'login'
           END)
    )::text
WHERE kind = 'wasm_app'
  AND config_json <> ''
  AND config_json IS JSON OBJECT
  AND NOT jsonb_exists(config_json::jsonb, 'access')
  AND (jsonb_exists(config_json::jsonb, 'login_required') OR jsonb_exists(config_json::jsonb, 'visible'));

-- ===== 3) 同一规则改写 app_releases.config_json（列存在才改） =====
-- 只改 wasm 应用的版本行（app_releases 有 (kind, app_id) 主键的一部分）。
DO $wasm_release_config_rewrite$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'app_releases' AND column_name = 'config_json') THEN
    UPDATE app_releases
    SET config_json = (
          (config_json::jsonb - 'login_required' - 'visible')
          || jsonb_build_object('access',
               CASE
                 WHEN jsonb_typeof(config_json::jsonb -> 'login_required') = 'boolean'
                      AND (config_json::jsonb -> 'login_required')::boolean = false
                   THEN 'public'
                 WHEN jsonb_typeof(config_json::jsonb -> 'whitelist') = 'array'
                      AND jsonb_array_length(config_json::jsonb -> 'whitelist') > 0
                   THEN 'whitelist'
                 ELSE 'login'
               END)
        )::text
    WHERE kind = 'wasm_app'
      AND config_json <> ''
      AND config_json IS JSON OBJECT
      AND NOT jsonb_exists(config_json::jsonb, 'access')
      AND (jsonb_exists(config_json::jsonb, 'login_required') OR jsonb_exists(config_json::jsonb, 'visible'));
  END IF;
END
$wasm_release_config_rewrite$;

-- ===== 4) 自检：旧列必须已消失，旧键必须已清零（fail-loud） =====
DO $wasm_access_selfcheck$
DECLARE
  stale_apps    BIGINT;
  stale_rels    BIGINT;
  bad_json_apps BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'apps' AND column_name = 'visible') THEN
    RAISE EXCEPTION '0071: apps.visible 仍然存在（DROP COLUMN 未生效）';
  END IF;

  -- ⚠️ 自检条件必须与上面 UPDATE 的幂等条件**逐条对齐**（独立审计 2026-09-18 P2-1）：
  -- 同时带 `access` 与旧键的行会被 UPDATE 有意跳过（已经是 canonical 形状，只剩一个
  -- 冗余旧键），自检若不带 `NOT jsonb_exists(...,'access')` 就会把它算成"未改写"并
  -- RAISE ⇒ **升级直接失败**（真 PG 复现过：事务回滚）。旧键的清零判据是
  -- "还有哪一行需要改写却仍带旧键"，不是"旧键出现过"。
  SELECT count(*) INTO stale_apps FROM apps
   WHERE kind = 'wasm_app' AND config_json <> '' AND config_json IS JSON OBJECT
     AND NOT jsonb_exists(config_json::jsonb, 'access')
     AND (jsonb_exists(config_json::jsonb, 'login_required') OR jsonb_exists(config_json::jsonb, 'visible'));
  SELECT count(*) INTO stale_rels FROM app_releases
   WHERE kind = 'wasm_app' AND config_json <> '' AND config_json IS JSON OBJECT
     AND NOT jsonb_exists(config_json::jsonb, 'access')
     AND (jsonb_exists(config_json::jsonb, 'login_required') OR jsonb_exists(config_json::jsonb, 'visible'));
  IF stale_apps > 0 OR stale_rels > 0 THEN
    RAISE EXCEPTION '0071: 仍存在旧 schema 的 config_json（apps=% rels=%）', stale_apps, stale_rels;
  END IF;

  -- 坏 JSON 不是本迁移的失败条件（跳过即可），但必须能一眼看见有多少行被跳过：
  -- 如果这个数不为零，说明库里有非本平台写入的 config_json，值得排查。
  SELECT count(*) INTO bad_json_apps FROM apps
   WHERE kind = 'wasm_app' AND config_json <> '' AND NOT (config_json IS JSON OBJECT);
  IF bad_json_apps > 0 THEN
    RAISE WARNING '0071: % 行 apps.config_json 不是合法 JSON 对象，已跳过改写', bad_json_apps;
  END IF;
END
$wasm_access_selfcheck$;
