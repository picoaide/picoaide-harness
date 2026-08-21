# PicoAide 渠道包(Channel Pack)与自动模型同步设计

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

日期:2026-08-03
状态:已批准

## 背景

服务端 AI 网关目前要求管理员手动填 provider 的 base_url、模型名列表,无法自动发现渠道模型,也无法为特定渠道(如 DeepSeek 思考模式)注入专属请求参数。

目标:引入**内置预置渠道包**(每渠道一个独立文件),自动适配渠道;按**固定间隔自动轮询**渠道 `/models`,新增模型自动上架、消失模型自动下架;为 DeepSeek 渠道**强制启用思考模式(max)**并注入上下文/输出长度能力。

## 关键原则

1. **模型不硬编码**:渠道包文件只声明 `name`/`base_url`/能力预设/思考模式参数,**不写任何模型 id 列表**。模型 id 完全经 `/models` 从上游拉取,自动上架到 `models` 表,再经 `bootstrap` 下发给客户端。
2. **客户端走 OpenAI 兼容 API**:客户端已用 `@ai-sdk/openai-compatible`,`baseURL={serverURL}/v1`、`apiKey=用户token`,即客户端直接消费服务端网关的 OpenAI 兼容接口,无需任何渠道适配;服务端 `bootstrap.models` 列表即客户端可用模型。
3. 默认模型由管理员在 webadmin 选择(下拉来自自动上架后的 models 表),客户端无默认时回退首个。

## 范围

- 新增 `internal/llmgateway/channels/` 渠道包模块(先实现 deepseek,接口可扩展)
- 新增定时同步器(固定间隔,后台 goroutine)
- 网关转发前按渠道/模型注入请求参数(思考模式等)与删除不支持参数
- webadmin 网关页:provider 渠道下拉、模型能力展示、手动"立即同步"
- 不动现有商城/知识库/认证;不动客户端

## 架构

```
internal/llmgateway/
├── channels/
│   ├── channel.go        # Channel 接口 + 注册表 + 公共逻辑
│   ├── deepseek.go       # deepseek 渠道
│   └── channel_test.go   # 单测(mock fetch)
├── sync.go               # 定时同步器(注入 fetch 可测)
├── handler.go            # forward 前注入渠道请求参数
└── admin.go              # provider 渠道字段 + 手动同步端点
```

## Channel 接口

```go
type ModelInfo struct {
    ID          string
    DisplayName string
    ContextLen  int64 // 0 = 未知,用渠道预设兜底
    MaxOutput   int64
}

type Channel interface {
    Name() string     // "deepseek"
    BaseURL() string  // "https://api.deepseek.com"
    // GET /models,解析 OpenAI 兼容响应 data[];fetchFn 可注入便于测试
    FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error)
    // 渠道级请求体覆盖(如思考模式):返回 {overrides, removeKeys};
    // 转发时深合并 overrides 进请求体,并删除 removeKeys 中的键
    RequestOverrides(modelID string) (overrides map[string]any, removeKeys []string)
    // 渠道预设能力(上下文/输出长度),FetchModels 响应无值时的兜底
    DefaultModelCaps() (contextLen, maxOutput int64)
}
```

注册表:`channels.Get(name string) (Channel, bool)`;`channels.All() []string`(webadmin 下拉用)。

## DeepSeek 渠道(deepseek.go)

- `Name() = "deepseek"`,`BaseURL() = "https://api.deepseek.com"`
- `FetchModels`:`GET https://api.deepseek.com/models`,`Authorization: Bearer <apiKey>`,解析 `{data:[{id,...}]}`;display_name 取 id;ContextLen/MaxOutput 优先取响应中数字字段,否则 0(走预设兜底)
- **不硬编码模型**:渠道文件不含任何模型 id;deepseek 返回 `["deepseek-v4-flash","deepseek-v4-pro"]`(已实测),全部来自 `/models`
- `RequestOverrides`:返回 `overrides={"thinking":{"type":"enabled"}, "reasoning_effort":"max"}` 与 `removeKeys=["temperature","top_p","presence_penalty","frequency_penalty"]`(思考模式不支持,文档:设置不报错但不生效)
- `DefaultModelCaps`:`contextLen=1M(1048576)`,`maxOutput=384K(393216)`(deepseek 官方模型表;**已实测 `/models` 接口不返回长度字段,只能用预设**)

## 请求注入(handler.go forward 前)

1. `MatchModel` 解析出 provider → 渠道名(provider 新增 `channel` 字段)
2. 若渠道存在,解析原始 body JSON,深合并 `RequestOverrides(modelID)`,并删除 overrides 中标记不支持的键
3. 从模型 `default_params` 读取 `max_output`,若客户端未显式传 `max_tokens` 则注入为 `max_tokens`(`max_tokens` 在思考模式下受支持;`temperature` 等禁用参数由渠道 override 的 `removeKeys` 统一删除)。`context_length` 仅存于 `default_params` 供 webadmin 展示与后续能力提示,不注入请求体。

## 数据模型变更

`gateway_providers` 加列 `channel TEXT NOT NULL DEFAULT ''`:
- 迁移 `0010_channel.sql`:`ALTER TABLE gateway_providers ADD COLUMN channel TEXT NOT NULL DEFAULT ''`
- provider JSON 增加 `channel` 字段;创建时渠道下拉选择,自动填 base_url(管理员仍可改)

`models` 表复用 `default_params`(JSON)承载 `context_length`/`max_output`,无 schema 变更。**models 表由同步器从上游 `/models` 自动填充,不手工录入**;`bootstrap.models` 直接读 `models` 表下发给客户端,客户端经 OpenAI 兼容接口直用,无需任何客户端改动。

## 同步器(sync.go)

- 固定间隔:默认 1 小时,`main.go` 启动 `go SyncLoop(db, interval, fetchFn)`
- 每轮遍历 `enabled=1 AND api_key_enc!=''` 的 provider:
  1. `channels.Get(p.Channel)`;无渠道则跳过
  2. 解密 key → `FetchModels`
  3. 与 `models` 表 diff:
     - 新模型:INSERT(models, default_params 含 context_length/max_output)
     - 消失模型:DELETE;若为 `gateway.default_model`,重置为剩余首个模型 id
  4. 失败:log 后跳过该 provider,继续下一个
- `SyncOnce(db, fetchFn) ([]SyncResult, error)` 供手动端点与测试复用;`SyncLoop` 包一层定时器

## 默认模型回退

`bootstrap` 已有 `default_model` 不存在时回退首个模型(客户端 bootstrap.ts 也兜底)。同步删除默认模型后,`SyncOnce` 显式 `SetSetting("gateway.default_model", 剩余首个)`;若全部删空则置空串。

## webadmin 网关页

- provider 创建/编辑:新增"渠道"下拉(`channels.All()`),选中自动填 base_url(可改)
- 模型管理:每行展示 `context_length`/`max_output`(读 default_params,格式化如 "1M/384K")
- 新增"立即同步"按钮:POST `/api/admin/providers/:id/sync`,返回同步结果;页面右上全局同步按钮调用 `POST /api/admin/providers/sync-all`

## 新增/变更 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/channels` | GET | 预置渠道列表(name) |
| `/api/admin/providers/:id/sync` | POST | 手动同步该 provider 模型 |
| `/api/admin/providers/sync-all` | POST | 同步所有启用 provider |
| `/api/admin/providers` | POST/PUT | provider JSON 加 `channel` 字段 |

## 错误处理

- `FetchModels` 网络/鉴权失败 → 同步跳过该 provider,log 记录;手动同步返回错误信息给 webadmin
- 请求注入解析 body 失败 → 退回原样转发(不因注入失败阻塞请求)
- 同步删除模型时 DB 错误 → 事务内回滚,仅跳过该模型

## 测试

- `channel_test.go`:
  - `FetchModels` 解析 OpenAI 格式(含 data 数组、display_name、数字字段优先)
  - `RequestOverrides` 返回 thinking.enabled + reasoning_effort=max;removeKeys 含 4 个禁用参数
  - `DefaultModelCaps` = 1M/384K
- `sync_test.go`(注入 mock fetch):
  - 新模型上架:fetch 返回 2 模型 → 入库 2 条
  - 消失模型下架:先有 2 条 → fetch 返回 1 条 → 删 1 条
  - 删除默认模型时重置为剩余首个
  - fetch 失败跳过,不中断其他 provider
- `handler` 测试:deepseek 渠道转发时请求体含 thinking.enabled;temperature 被删

## 验收

1. webadmin 建 provider 选"deepseek" + 填 API Key → base_url 自动 `https://api.deepseek.com`
2. 点击"立即同步" → models 表出现 deepseek 模型,default_params 含 context_length=1048576/max_output=393216
3. 客户端对话走 deepseek → 服务端日志/抓包确认请求含 `thinking.type=enabled`、`reasoning_effort=max`,无 temperature
4. mock 渠道手动改模型列表后同步 → 消失模型下架、新模型上架
5. 全量 `go test ./...` 绿
