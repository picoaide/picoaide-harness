-- 0052: 移除市场技能的 git 源模式。
-- 背景(2026-09-01): 「包内即真相」要求发布时就能对归档做严格校验,而 git 模式
--   在创建时没有归档可校验(元数据靠管理员手填),既绕过校验,又导致「创建时填
--   了版本 → 首次上传同版本归档被递增校验挡死」的缺陷。
-- 现状核实: 生产库仅存的 git 行是端到端测试残留,无真实技能依赖该模式。
-- 结论: 归档上传成为唯一入口,source/git_url/git_ref 三列一并移除。
ALTER TABLE skills DROP COLUMN IF EXISTS git_url;
ALTER TABLE skills DROP COLUMN IF EXISTS git_ref;
ALTER TABLE skills DROP COLUMN IF EXISTS source;
