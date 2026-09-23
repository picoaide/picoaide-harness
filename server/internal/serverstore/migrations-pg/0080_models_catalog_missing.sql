-- 0080: models.catalog_missing —— 「上游目录缺失」标记（2026-09-23，审计 G-02/P1）。
--
-- 背景：渠道同步（llmgateway.SyncOnce，每小时一轮）拿到上游 /models 目录后调用
--   RemoveMissingProviderModels 清理"目录里不再出现"的模型行。上游目录**部分抖动**
--   （一次超时/降级/返回子集）时缺失的模型会被物理 DELETE，价格/缓存价/峰谷折扣/
--   default_params/input_modalities 一并消失；下一轮目录恢复时又以**新行**插回
--   （价格列为 NULL）⇒ 该模型**永久免费**，而且无日志、无审计。
--
-- 语义（三条，别自行放宽）：
--   1. 仍带运营方配置（价格/缓存价/峰谷折扣/default_params/input_modalities）的行
--      **绝不物理删除**：改为 catalog_missing = TRUE —— 行与定价保留、名字从
--      gateway_providers.models JSON 移除、路由与客户端目录按可用性过滤掉它；
--   2. 目录恢复（SyncProviderModel 命中同名行）时清标记、把名字加回 provider JSON，
--      价格不变 —— 抖动往返幂等，管理员配置零丢失；
--   3. 管理员显式删除（管理端删模型 / 手动清单剪枝 / 删除上游）仍走物理删除：
--      显式意图不受影响（catalog_missing 只承载"同步发现目录缺失"这一种原因）。
--
-- 幂等可重放（IF NOT EXISTS），与既有迁移同风格。
ALTER TABLE models ADD COLUMN IF NOT EXISTS catalog_missing BOOLEAN NOT NULL DEFAULT FALSE;

-- 自检（fail-loud）：列必须存在、类型与缺省与预期一致。
-- 为什么连 DEFAULT 也断言：省略该列的 INSERT 路径（老代码、外部脚本）依赖缺省
-- FALSE = 「在上游目录里」；缺省一旦不是 FALSE，所有新建模型都会被当成目录缺失
-- 而不可路由 —— 静默的"全部模型下架"，没有任何报错可查。
DO $models_catalog_missing_selfcheck$
DECLARE
  col_type TEXT;
  col_default TEXT;
  col_notnull BOOLEAN;
BEGIN
  SELECT data_type, COALESCE(column_default, ''), is_nullable = 'NO'
    INTO col_type, col_default, col_notnull
    FROM information_schema.columns
   WHERE table_name = 'models' AND column_name = 'catalog_missing';
  IF col_type IS NULL THEN
    RAISE EXCEPTION '0080: models.catalog_missing 未创建';
  END IF;
  IF col_type <> 'boolean' THEN
    RAISE EXCEPTION '0080: models.catalog_missing 类型应为 boolean，实际为 %', col_type;
  END IF;
  IF col_default NOT LIKE 'false%' THEN
    RAISE EXCEPTION '0080: models.catalog_missing 缺省应为 false，实际为 %', col_default;
  END IF;
  IF NOT col_notnull THEN
    RAISE EXCEPTION '0080: models.catalog_missing 应为 NOT NULL（false = 在上游目录里）';
  END IF;
END
$models_catalog_missing_selfcheck$;
