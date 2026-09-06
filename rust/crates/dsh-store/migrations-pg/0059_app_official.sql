-- 0059: 能力中心「官方」机制(2026-09-04 定案)。
-- 官方 = App 级属性(apps.official=1),独立于 quality 质量标记:
--   * official=1 时 owner=''(无个人归属, 展示「官方」, 蓝标)
--   * 官方内容仅管理员可上传新版(appstore.Publish 检查)
--   * quality 的 'official' 值退役(只留 ''|featured),官方语义移交本列
-- 存量迁移:
--   1) 当前展示版本(最高 approved 且未软删)quality='official' 的 App → 转官方;
--   2) quality 列 official 值清空(历史版本也清——官方语义不再存在于质量维度)。
ALTER TABLE apps ADD COLUMN official SMALLINT NOT NULL DEFAULT 0;

UPDATE apps a SET official = 1, owner = ''
 WHERE EXISTS (SELECT 1 FROM app_releases r
               WHERE r.kind = a.kind AND r.app_id = a.app_id
                 AND r.status = 'approved' AND r.deleted_at IS NULL
                 AND r.quality = 'official');

UPDATE app_releases SET quality = '' WHERE quality = 'official';
