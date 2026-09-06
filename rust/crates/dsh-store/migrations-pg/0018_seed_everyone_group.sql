-- 0018: seed the reserved implicit 全员 (everyone) group.
-- 全员 is the implicit "everyone" department: every user belongs to it and
-- grants to it cover all users (UserEffectiveGroups). CreateDepartment rejects
-- the name, so only the system can create this row; seeding here makes the
-- feature work on fresh installs (previously it only worked in tests that
-- inserted the row manually).
INSERT INTO groups (name)
SELECT '全员' WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = '全员');
