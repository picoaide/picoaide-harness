-- 0019: groups.name uniqueness becomes case-insensitive.
-- The whole permission system treats group names as NOCASE (lookups, grant
-- resolution, rename cascade), but the UNIQUE constraint was BINARY — "Sales"
-- and "sales" could coexist, breaking checkbox UIs and NOCASE lookups that
-- pick an arbitrary row. Rebuild the table with COLLATE NOCASE UNIQUE.
CREATE TABLE groups_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  parent_id INTEGER DEFAULT 0,
  leader_id INTEGER DEFAULT 0,
  description TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
INSERT INTO groups_new (id, name, parent_id, leader_id, description, created_at)
  SELECT id, name, parent_id, leader_id, description, created_at FROM groups;
DROP TABLE groups;
ALTER TABLE groups_new RENAME TO groups;
CREATE INDEX idx_groups_parent ON groups(parent_id);
