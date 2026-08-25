-- 0036: 共享 skill/agent 授权制(审核通过后仍需管理员授权才可见可装)。
-- 与商城 skill_grants(0016) 同模型:资源授权给 user 或 @group,admin 恒全量;
-- 授权对象 = 资源 name(同名多版本共享一个授权);作者自己上传的始终可见。
CREATE TABLE shared_skill_grants (
  skill_name TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
  grantee TEXT NOT NULL,
  PRIMARY KEY(skill_name, grantee_type, grantee)
);
CREATE TABLE agent_preset_grants (
  preset_name TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
  grantee TEXT NOT NULL,
  PRIMARY KEY(preset_name, grantee_type, grantee)
);
