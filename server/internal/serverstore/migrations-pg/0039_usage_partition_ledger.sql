-- 0039: usage 按月原生分区 + 日/月记账本。
-- 背景(PG-only 2026-08):
--   usage 是最高写入频次表(每次 LLM 调用 1 行),无清理策略数据无限累积;
--   200 员工 × 2 万次/月 ≈ 240 万行/年。明细保留 N 个月(默认 6,可配),
--   按月份 DROP PARTITION 秒删;明细删除不影响永久账本(usage_daily/monthly)。
--
-- 结构:
--   usage         主表 PARTITION BY RANGE (created_at),按月分区 usage_YYYYMM
--                 (PK 含 created_at;PG16 建索引自动传播到分区)
--   usage_daily   日账 PARTITION BY RANGE (day),按年分区 usage_daily_YYYY
--                 UNIQUE(user_id, model, day) —— 永久保留,由账本任务生成
--   usage_monthly 月账 普通表 UNIQUE(user_id, model, month) —— 永久保留,
--                 由日账聚合生成(最终兜底)
--
-- 账本生成: serverstore.RebuildUsageLedger(from,to) 从 usage 明细 UPSERT
--   日账/月账(幂等);每日任务 + 启动补算调用。保留策略:
--   CleanupUsageRetention(settings usage.retention_months,0=永久) DROP 过期分区。
--
-- 老库升级(2026-09-23 修,P0 崩溃循环):v2.4.0 的 0004 建的是**普通表**,该文件
--   后来被原地改写成 `PARTITION BY RANGE` 版本(与 0039 同在提交 8f8d09fe31),
--   而 schema_migrations 只记版本号、**没有校验和** ⇒ 由旧 0004 建库的存量库上,
--   本迁移原来的 `CREATE TABLE IF NOT EXISTS usage` 会静默跳过(表已存在),
--   紧接着的 `PARTITION OF usage` 直接报 `"usage" is not partitioned`:
--   事务回滚、版本号不落库、主进程 log.Fatalf ⇒ 每次启动重跑同一条迁移,
--   **崩溃循环且重试永不自愈**。
--   被改写前的注释还承诺"老库由 Go 侧 ensureUsagePartition 按月份迁入"——
--   那条路径**不存在**(partitions.go 只创建/校验**子分区**,不搬数据)。
--   因此形状转换由本迁移自己承担(§0),完整性由 §4 的 fail-loud 自检兜底。
--
-- 幂等:DDL 全部 IF NOT EXISTS 形态;§0 的唯一入口判据是 pg_class.relkind
--   ('p' 直接放行走原路径,'r' 才转换),重放安全。

-- ---- 0. 存量库形状检测与就地转换(普通表 'r' → 分区表 'p') ----
-- 转换在**同一迁移事务内**完成,任一步失败整条迁移回滚、库回到转换前。
-- 步骤与每一步的理由:
--   ① 老普通表改名 usage_legacy;
--   ② 让它名下的**索引与序列**改名 —— 索引/序列名是 schema 级唯一,不让位会让
--      新表的 PK 索引被 PG 自动改名成 usage_pkey1,并让下面
--      `CREATE INDEX IF NOT EXISTS idx_usage_*` 静默跳过(表已存在同名索引)⇒
--      分区大表少索引、无任何运行期报错(§4 有对应断言);
--   ③ 按本迁移的目标形状新建分区主表 usage;
--   ④ 为老数据涉及的**北京月**建月份分区:边界必须与运行期
--      ensureUsagePartition(beijing.go 口径:北京月 + 显式 +08 偏移)逐值一致,
--      否则运行期探测会把分区判成"错界"并让该月计量写入永久失败(503);
--   ⑤ 列集一致性检查后 INSERT ... SELECT 搬运**全部**行(老表多出的列 fail-loud;
--      目标列的缺失只拦不可缺省的三列,见 §0 ⑤ 的说明);
--   ⑥ 复位 id 序列:显式 id 插入不推进序列,不复位则应用侧下一批 INSERT 撞 23505。
DO $usage_legacy_to_partitioned$
DECLARE
  v_relkind "char";
  v_rows BIGINT;
  v_null_dates BIGINT;
  v_cols TEXT;
  v_col_bad TEXT;
  v_seq TEXT;
  v_rel TEXT;
  v_leaked BIGINT;
  r RECORD;
BEGIN
  SELECT c.relkind INTO v_relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'usage';
  -- NULL = 新库(没有 usage,下面按原路径 CREATE);'p' = 已是分区表(新库/已升级库)。
  IF v_relkind IS NULL OR v_relkind = 'p' THEN
    RETURN;
  END IF;
  IF v_relkind <> 'r' THEN
    RAISE EXCEPTION '0039: usage 的形状是 [%](既不是普通表 r 也不是分区表 p),无法自动转换;请人工核对后再升级', v_relkind;
  END IF;
  IF to_regclass('public.usage_legacy') IS NOT NULL THEN
    RAISE EXCEPTION '0039: 已存在 usage_legacy 表(上一次转换的残留?);请人工核对并清理后再升级';
  END IF;

  -- 旧 0004 的 created_at 是 `TIMESTAMPTZ DEFAULT now()`(**可空**),空值落不进
  -- RANGE 分区。不猜也不丢:点名计数,并在消息里给出可执行的修复 SQL。
  SELECT count(*), count(*) FILTER (WHERE created_at IS NULL) INTO v_rows, v_null_dates FROM usage;
  IF v_null_dates > 0 THEN
    RAISE EXCEPTION '0039: usage 有 % 行 created_at 为空(旧表该列可空),无法迁入按 created_at 分区的表;请先执行 UPDATE usage SET created_at = <明确时间> WHERE created_at IS NULL; 再重启升级', v_null_dates;
  END IF;

  -- ① 让位
  ALTER TABLE usage RENAME TO usage_legacy;

  -- ② 索引/序列让位(理由见文件头 ②)
  FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'usage_legacy' LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.indexname, left('legacy_' || r.indexname, 63));
  END LOOP;
  v_seq := pg_get_serial_sequence('public.usage_legacy', 'id');
  IF v_seq IS NOT NULL THEN
    EXECUTE format('ALTER SEQUENCE %s RENAME TO %I', v_seq, left('legacy_' || split_part(v_seq, '.', 2), 63));
  END IF;

  -- ③ 目标形状(必须与下面 §1 的 CREATE TABLE IF NOT EXISTS 逐列一致)
  CREATE TABLE usage (
    id BIGSERIAL NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    model TEXT NOT NULL,
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind TEXT NOT NULL DEFAULT 'chat',
    cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id, created_at)
  ) PARTITION BY RANGE (created_at);

  -- ④ 老数据涉及的北京月分区(边界口径见文件头 ④)
  FOR r IN
    SELECT DISTINCT date_trunc('month', (created_at AT TIME ZONE 'UTC') + interval '8 hours') AS mon
      FROM usage_legacy ORDER BY 1
  LOOP
    v_rel := 'usage_' || to_char(r.mon, 'YYYYMM');
    IF to_regclass('public.' || quote_ident(v_rel)) IS NOT NULL THEN
      RAISE EXCEPTION '0039: 已存在名为 % 的关系,与要新建的月份分区同名(残留对象?);请人工核对后再升级', v_rel;
    END IF;
    EXECUTE format('CREATE TABLE %I PARTITION OF usage FOR VALUES FROM (%L) TO (%L)',
                   v_rel,
                   to_char(r.mon, 'YYYY-MM-DD') || ' 00:00:00+08',
                   to_char(r.mon + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+08');
  END LOOP;

  -- ⑤ 列集一致性
  --   * 老表**多出**的列 ⇒ 转换会丢这些列的数据,拒绝静默丢弃(fail-loud);
  --   * 目标列**缺失** ⇒ 只拦不可缺省的三列(user_id/model/created_at):其余列
  --     (prompt_tokens/completion_tokens/kind/cost/cache_prompt_tokens)都带
  --     列缺省,缺列只说明该库没跑过给它们加列的迁移(0020/0022/0030)——
  --     用列缺省补齐与"当年跑过那条迁移"逐值等价(那几条迁移写的就是这些缺省值),
  --     因此不拦,只在 NOTICE 里点名。
  SELECT string_agg(req.column_name, ', ' ORDER BY req.column_name) INTO v_col_bad
    FROM (VALUES ('user_id'), ('model'), ('created_at')) AS req(column_name)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns l
                      WHERE l.table_schema = 'public' AND l.table_name = 'usage_legacy'
                        AND l.column_name = req.column_name);
  IF v_col_bad IS NOT NULL THEN
    RAISE EXCEPTION '0039: 存量 usage 缺关键列 [%] —— 无法自动转换(这三列没有可用的列缺省);请人工核对', v_col_bad;
  END IF;
  SELECT string_agg(l.column_name, ', ' ORDER BY l.column_name) INTO v_col_bad
    FROM information_schema.columns l
   WHERE l.table_schema = 'public' AND l.table_name = 'usage_legacy'
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns t
                      WHERE t.table_schema = 'public' AND t.table_name = 'usage'
                        AND t.column_name = l.column_name);
  IF v_col_bad IS NOT NULL THEN
    RAISE EXCEPTION '0039: 存量 usage 多出列 [%] —— 转换会丢掉这些列的数据,拒绝静默丢弃;请人工核对', v_col_bad;
  END IF;
  -- 只搬两边都有的列;缺失的目标列走列缺省(见上)
  SELECT string_agg(quote_ident(l.column_name), ', ' ORDER BY l.ordinal_position),
         string_agg(l.column_name, ', ' ORDER BY l.column_name) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM information_schema.columns t
            WHERE t.table_schema = 'public' AND t.table_name = 'usage'
              AND t.column_name = l.column_name))
    INTO v_cols, v_col_bad
    FROM information_schema.columns l
   WHERE l.table_schema = 'public' AND l.table_name = 'usage_legacy';
  EXECUTE format('INSERT INTO usage (%s) SELECT %s FROM usage_legacy', v_cols, v_cols);
  IF v_col_bad IS NOT NULL THEN
    RAISE NOTICE '0039: 存量 usage 缺列 [%],已按列缺省补齐(等价于该库补跑 0020/0022/0030)', v_col_bad;
  END IF;

  -- 校验搬运行数(§4 会在所有 DDL 之后再核对一次,并据此决定能否丢弃老表)
  SELECT count(*) INTO v_leaked FROM usage;
  IF v_leaked <> v_rows THEN
    RAISE EXCEPTION '0039: 搬运行数不符 —— 老表 % 行,新表 % 行;整条迁移回滚', v_rows, v_leaked;
  END IF;

  -- ⑥ 序列复位
  v_seq := pg_get_serial_sequence('public.usage', 'id');
  IF v_seq IS NOT NULL THEN
    PERFORM setval(v_seq, COALESCE((SELECT max(id) FROM usage_legacy), 0) + 1, false);
  END IF;
  RAISE NOTICE '0039: 存量普通表 usage 已就地转换为分区表(% 行待 §4 自检确认)', v_rows;
END
$usage_legacy_to_partitioned$;

-- ---- 1. usage 分区主表 ----
CREATE TABLE IF NOT EXISTS usage (
  id BIGSERIAL NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL DEFAULT 'chat',
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 当前月分区(写路径由 ensureUsagePartition 幂等创建后续月)
CREATE TABLE IF NOT EXISTS usage_202608 PARTITION OF usage
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- 主表索引(PG16 传播到已有/新建分区)
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON usage(model, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage(kind);
CREATE INDEX IF NOT EXISTS idx_usage_user_cost ON usage(user_id, cost);

-- ---- 2. usage_daily 日账(按年分区,永久) ----
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  day DATE NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model, day)
) PARTITION BY RANGE (day);
CREATE TABLE IF NOT EXISTS usage_daily_2026 PARTITION OF usage_daily
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);

-- ---- 3. usage_monthly 月账(普通表,永久) ----
CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  month DATE NOT NULL,  -- 月初(YYYY-MM-01)
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cache_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model, month)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_month ON usage_monthly(month);

-- ---- 4. 自检(fail-loud):形状 + 规范索引 + 搬运完整性 ----
-- 三条判据都必须在本迁移的**正常路径**上成立(新库、已升级库、刚转换的存量库),
-- 与 §0 的跳过条件是同一套判据 —— 否则"本该跳过"的库会被自检打红。
DO $usage_partition_selfcheck$
DECLARE
  v_shape TEXT;
  v_idx INTEGER;
  v_src BIGINT;
  v_dst BIGINT;
BEGIN
  -- 形状:usage/usage_daily 必须是分区表,usage_monthly 必须是普通表
  SELECT string_agg(c.relname || '=' || c.relkind::text, ', ' ORDER BY c.relname) INTO v_shape
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('usage', 'usage_daily', 'usage_monthly');
  IF v_shape IS DISTINCT FROM 'usage=p, usage_daily=p, usage_monthly=r' THEN
    RAISE EXCEPTION '0039: 自检失败 —— 表形状为 [%],期望 [usage=p, usage_daily=p, usage_monthly=r]', COALESCE(v_shape, '<空>');
  END IF;

  -- 规范索引名必须真的挂在新 usage 上:存量库的旧同名索引若没让位,
  -- CREATE INDEX IF NOT EXISTS 会静默跳过 —— 分区大表少一个索引是性能事故,
  -- 运行期没有任何报错可查。
  SELECT count(*) INTO v_idx FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'usage'
     AND indexname IN ('usage_pkey', 'idx_usage_user_time', 'idx_usage_time',
                       'idx_usage_model_time', 'idx_usage_kind', 'idx_usage_user_cost');
  IF v_idx <> 6 THEN
    RAISE EXCEPTION '0039: 自检失败 —— usage 上只有 %/6 个规范索引(存量库同名索引未让位会让 CREATE INDEX IF NOT EXISTS 静默跳过)', v_idx;
  END IF;

  -- 搬运完整性:老表此时仍在(§5 才 DROP),逐行数比对
  IF to_regclass('public.usage_legacy') IS NOT NULL THEN
    SELECT count(*) INTO v_src FROM usage_legacy;
    SELECT count(*) INTO v_dst FROM usage;
    IF v_src <> v_dst THEN
      RAISE EXCEPTION '0039: 自检失败 —— 存量 usage % 行,转换后 % 行(不得丢数据)', v_src, v_dst;
    END IF;
    RAISE NOTICE '0039: 存量普通表 usage 已就地转换为分区表,% 行全部迁入', v_dst;
  ELSE
    RAISE NOTICE '0039: usage 已是分区表(新库或已升级库),无需转换';
  END IF;
END
$usage_partition_selfcheck$;

-- ---- 5. 丢弃老表(只在 §4 自检全部通过之后) ----
-- 老表的行已逐值搬进分区表;这一步同时带走让位时改名的 legacy_* 索引与序列。
-- 有别的对象引用它时这里会报错停下(不做 CASCADE)—— 那属于需要人工确认的形态。
DROP TABLE IF EXISTS usage_legacy;
