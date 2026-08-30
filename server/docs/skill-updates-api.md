# Skill 版本检测与自动升级 API 使用说明

> 面向接入方客户端(picoaide-harness feat/enterprise 等)。服务端已上线
> `GET /api/client/v2/marketplace/skills/updates`,供客户端登录后检测技能新版本并自动升级。

## 1. 接口

```
GET /api/client/v2/marketplace/skills/updates?installed=<name>:<version>,<name>:<version>,...
Authorization: Bearer <token>
```

| 项 | 说明 |
|----|------|
| 鉴权 | Bearer token(员工/管理员登录 `POST /api/client/v2/auth/login` 获取) |
| `installed` | 客户端已安装技能的 `name:version` 列表,逗号分隔,URL 编码;≤100 项 |
| 幂等 | 纯读操作,无副作用,可任意频次调用 |

## 2. 请求示例

```http
GET /api/client/v2/marketplace/skills/updates?installed=data-extract:0.1.0,web-search:2.0.0
Authorization: Bearer eyJ...
```

## 3. 响应

```json
{
  "count": 1,
  "updates": [
    {
      "name": "data-extract",
      "version": "1.0.0",
      "description": "从表格、日志或非结构化文本中提取结构化数据,输出 CSV/JSON",
      "author": "picoaide-admin",
      "archive_url": "/api/client/v2/marketplace/skills/data-extract/archive"
    }
  ]
}
```

- `updates` 只包含**服务端版本与客户端上报版本不一致**且客户端有权限的技能
- `archive_url` 为相对路径,拼接服务端地址即得下载地址;直接下载该技能最新包
- 无更新时返回 `{"count":0,"updates":[]}`;`installed` 为空同样返回空

## 4. 自动升级流程(客户端侧)

```
登录成功
  └─> GET /api/client/v2/marketplace/skills/updates?installed=<本地已装版本列表>
        │
        ├─ count=0 ──> 无需升级
        │
        └─ count>0 ──> 对每个 update 项:
             ├─ 下载 GET <服务端地址> + archive_url
             ├─ 校验响应头 X-Skill-Version(应等于 update.version)
             ├─ 校验响应头 X-Skill-Checksum(SHA-256,防篡改/损坏)
             ├─ 解包替换本地技能目录
             └─ 更新本地已装版本记录
```

### harness 客户端调用方式

harness 的 `packages/host/enterprise` 已注册本地代理 `/api/pico/skills`(prefix),
`/api/pico/skills/updates?...` 会**自动透传**到网关 `/api/client/v2/marketplace/skills/updates`,
无需修改代理代码。客户端内直接:

```ts
// 与现有 SkillCenterSection 同款本地代理调用
const res = await fetch(`/api/pico/skills/updates?installed=${encodeURIComponent('data-extract:0.1.0')}`)
const data = await res.json() // { count, updates: [...] }
```

## 5. 权限与限制

| 规则 | 说明 |
|------|------|
| 未登录 | 401 `AUTH_REQUIRED` |
| 参数非法 | 400 `VALIDATION`(格式非 `name:version`、name 含非法字符、>100 项) |
| 权限 | 与管理目录一致:管理员可见全部已启用技能;普通员工仅可见被授权技能 |
| 下架技能 | 不返回(与目录 404 同隐私原则,不泄露存在性) |
| 版本语义 | 字符串比较;管理员在 webadmin 商城维护的 `version` 为权威 |

## 6. 相关接口

| 接口 | 用途 |
|------|------|
| `GET /api/client/v2/marketplace/skills` | 技能目录(全量,含 version) |
| `GET /api/client/v2/marketplace/skills/updates` | 版本检测(本接口) |
| `GET /api/client/v2/marketplace/skills/:name/archive` | 下载技能包(响应头 `X-Skill-Version` / `X-Skill-Checksum`) |
