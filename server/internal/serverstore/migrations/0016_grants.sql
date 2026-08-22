-- 0016: skill grants (admin-authorized usage, strict default).
-- Subjects are usernames or group names (grantee_type disambiguates);
-- groups are resolved via the groups/user_groups tables at query time,
-- so revoking a grant (or LDAP group membership) takes effect immediately.
-- Admins are implicitly allowed everywhere and never need a grant row.
CREATE TABLE skill_grants (
  skill_name TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
  grantee TEXT NOT NULL,
  PRIMARY KEY(skill_name, grantee_type, grantee)
);
