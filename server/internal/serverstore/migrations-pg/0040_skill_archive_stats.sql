-- 0040: 技能商城改为压缩包上传(归档直接存 DB)+ 下载/调用统计。
-- 背景(2026-08):
--   skills(git 模式)与 shared_skills(员工上传)此前都把归档放在磁盘缓存;
--   本迁移把归档列加入两张表(上传包不入磁盘),并新增下载/调用计数列。
--
-- 字段:
--   skills.source        'git'(老模式,克隆+打包) | 'upload'(压缩包上传,归档存 DB)
--   skills.archive       上传包的原始字节(仅 source='upload' 时非空)
--   skills.downloads     归档下载次数(GET /archive 成功即 +1)
--   skills.calls         技能被调用次数(客户端 telemetry 上报累加)
--   shared_skills.archive     员工上传的归档字节(DB 直存,不再落磁盘)
--   shared_skills.downloads   归档下载次数
--   shared_skills.calls       技能调用次数
--
-- 老数据:既有 skills 行默认 source='git',既有 shared_skills 行归档仍在磁盘,
--   下载/预览实现保留磁盘回退(只读),新上传一律写 DB。

ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'git';
ALTER TABLE skills ADD COLUMN archive BYTEA;
ALTER TABLE skills ADD COLUMN downloads BIGINT NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN calls BIGINT NOT NULL DEFAULT 0;

ALTER TABLE shared_skills ADD COLUMN archive BYTEA;
ALTER TABLE shared_skills ADD COLUMN downloads BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shared_skills ADD COLUMN calls BIGINT NOT NULL DEFAULT 0;
