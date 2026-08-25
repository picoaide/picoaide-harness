-- 0033: 共享 Agent 审核拒绝理由(管理员 reject 时记录,作者可见,重提时清空)。
ALTER TABLE agent_presets ADD COLUMN reason TEXT NOT NULL DEFAULT '';
