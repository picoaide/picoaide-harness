-- 0041: 共享 Agent 预设归档直存 DB(与技能 0040 对齐——所有上传不落盘)。
-- 背景(2026-08):shared_skills/skills 的归档已在 0040 直存 DB,但
--   agent_presets(共享 Agent 预设)的上传仍写磁盘缓存(archive 文件);
--   本迁移把归档列加入 agent_presets,上传/重提/下载/预览/删除全部走 DB。
--
-- 字段:
--   agent_presets.archive  上传的归档字节(直存 DB,不再落磁盘)
--   agent_presets.downloads 归档下载次数(GET /archive 成功即 +1)
--
-- 老数据:既有 agent_presets 行归档在磁盘,下载/预览保持磁盘回退(只读);
--   新上传一律写 DB(与 shared_skills 0040 的处理一致)。

ALTER TABLE agent_presets ADD COLUMN archive BYTEA;
ALTER TABLE agent_presets ADD COLUMN downloads BIGINT NOT NULL DEFAULT 0;
