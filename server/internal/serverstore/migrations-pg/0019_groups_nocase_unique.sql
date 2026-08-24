-- 0019: groups.name uniqueness becomes case-insensitive.
-- The whole permission system treats group names as NOCASE (lookups, grant
-- resolution, rename cascade), but the UNIQUE constraint was BINARY — "Sales"
-- and "sales" could coexist, breaking checkbox UIs and NOCASE lookups that
-- pick an arbitrary row. PG 无 COLLATE NOCASE,改用函数唯一索引 LOWER(name)
-- 实现大小写不敏感唯一,无需 create-new-copy 重建(0017 已补全其余列);
-- idx_groups_parent 已由 0017 建立,此处不重建。
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_name_key;
CREATE UNIQUE INDEX idx_groups_name_nocase ON groups (LOWER(name));
