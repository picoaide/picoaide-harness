-- 0037: 共享资源质量标记(能力中心「组织库」官方/精选徽章)。
-- 与市场「免费/专业」分级词表隔离:「专业」一词全产品只作市场定价语义,
-- 组织库质量用 quality('' | 'official' | 'featured') 互斥标记。
-- 显示层仅对 approved 行生效;admin 可随时设置/清除(qualify 审计)。
ALTER TABLE shared_skills ADD COLUMN quality TEXT NOT NULL DEFAULT '' CHECK (quality IN ('', 'official', 'featured'));
ALTER TABLE agent_presets ADD COLUMN quality TEXT NOT NULL DEFAULT '' CHECK (quality IN ('', 'official', 'featured'));
