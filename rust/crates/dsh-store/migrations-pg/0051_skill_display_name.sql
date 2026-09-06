-- 0051: 市场技能展示名。
-- 需求(2026-09-01): 能力中心「市场」卡片一直显示目录名(如 team-knowledge-wiki),
--   而安装后又显示中文名——根因是 skills 表**没有展示名字段**,聚合面
--   (internal/capabilities) 只能回退成 name。组织共享库有 display_name,
--   市场域没有,这是两条链路唯一的元数据缺口。
-- 取值: 发布/规范化时从包内 SKILL.md 的 frontmatter `title` 写入(包内即真相);
--   为空时读侧回退 name,保持旧行为不变。
ALTER TABLE skills ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
