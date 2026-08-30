# 认证体系

## 1. 概览

```
员工客户端(桌面)                管理员(webadmin)
   │ Bearer api_token              │ Cookie session + CSRF
   ▼                               ▼
POST /api/client/v2/auth/login          POST /api/server/admin/login
```

- 员工:密码(local/LDAP)或 OIDC 浏览器登录 → 签发 `api_token`,客户端持 token 调全部员工端点。
- 管理员:任一 `is_admin=1` 用户经 `POST /api/server/admin/login` 建立 session(24h),写操作带 `X-CSRF-Token`。
- 密钥只在服务端:LLM 上游密钥 AES-GCM 加密落库,客户端只持 token。

## 2. 认证模式(auth.mode)

由服务端 `settings` 表配置(webadmin 管理页修改),支持三种密码模式 + 可选 OIDC:

| 值 | 行为 |
|----|------|
| `local`(默认) | 本地用户表校验(argon2id) |
| `ldap` | 仅 LDAP 绑定校验(用户不存在时自动创建本地记录) |
| `both` | 先 local 后 ldap 逐个尝试 |

### settings 键名(serverauth/config.go)

```
auth.mode = local | ldap | both        # 密码模式
ldap.server_url / ldap.bind_dn / ldap.bind_password
ldap.base_dn / ldap.user_filter / ldap.group_filter / ldap.group_attr
oidc.issuer / oidc.client_id / oidc.client_secret / oidc.redirect_url
```

LDAP/OIDC 配置无效时对应 provider 不注册(启动即降级为 local,不会崩)。

## 3. Token 生命周期(api_tokens)

| 项 | 值 |
|----|----|
| 生命周期 | **90 天**(`TokenTTL = 90 * 24 * time.Hour`) |
| 存储 | `sha256(token)` 哈希(`token_hash` 唯一列),明文不落库 |
| 签发 | `POST /api/client/v2/auth/login` 成功 → `IssueToken`(32 随机字节,Base64URL) |
| 吊销 | `POST /api/client/v2/auth/logout`;`revoked=1` 后立即失效(表结构保留行) |
| 校验 | `BearerAuth` 中间件:查哈希 → 校验 revoked → 校验 expires_at → 取用户 |
| 其他 | `last_used_at` 记录使用时间;可多 token 并存(默认 name='desktop') |

## 4. 管理端 session + CSRF

- 登录:`POST /api/server/admin/login`,成功设置 Cookie `picoaide_session`(HttpOnly、SameSite=Lax、MaxAge=24h),session id 为随机值,存 `admin_sessions` 表。
- 会话 TTL:`AdminSessionTTL = 24h`。
- **CSRF**:session 携带随机 `csrf_key`;登录响应返回 `X-CSRF-Token`(基于 csrf_key + 时间窗 HMAC,窗口 1h,±1 窗口容差)。所有写请求须带 `X-CSRF-Token` 头,`AdminAuth` 校验;读请求(GET)仅校验 cookie。
- 登出:`POST /api/server/admin/logout` 删除 session 行。

## 5. 超管引导(--bootstrap-admin)

```bash
PICOAI_ADMIN_PASSWORD=x bin/picoaide-server -data ./data --bootstrap-admin admin
```

- 仅在**没有任何管理员**时创建该用户(密码来自 `PICOAI_ADMIN_PASSWORD`,缺失则启动失败)。
- 若用户名已存在但非管理员 → 启动失败(防提权)。
- 首次启动后,后续启动该用户已存在,不再重复创建(重复传参无害)。

## 6. 限流

| 位置 | 机制 | 默认 |
|------|------|------|
| 登录 `POST /api/client/v2/auth/login` | 内存计数器(按 IP+用户名,失败累计,成功/时间窗重置) | - |
| 管理登录 `POST /api/server/admin/login` | 同上(独立计数器) | - |
| 网关 `/v1/chat/completions` | per-user 令牌桶(`gateway.rate_limit`,settings 可调,桶上限 10000) | 60/min |

超限返回 `429 RATE_LIMITED`。

## 7. 用户模型

`users` 表字段:`username`(唯一)、`display_name`、`email`、`password_hash`(argon2id)、`source`(local/ldap/oidc)、`is_admin`、`status`(1=启用)。LDAP/OIDC 首次登录的用户自动创建本地记录(source 标记来源),停用(`status=0`)后所有 token 即刻失效。
