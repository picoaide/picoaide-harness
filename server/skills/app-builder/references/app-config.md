# 字段规格（应用配置文件 + 发布载荷）

本文件由 `go generate ./internal/wasmapp/limits` 生成，不要手改；单一真源是 `server/internal/wasmapp/appcfg/appcfgspec.go`。

上限数字与单位不在本文件里重复：一律见 `references/limits.md`（同一生成器产出）。
改字段 = 改平台的 `appcfgspec.go` 并重新生成，**不要手改本文件**。

## 1. 应用配置文件 `picoaide.app.json`

随发布一起提交（不计入 wasm 体积上限），发布期被抽到资源目录，
应用用 `assets.read("picoaide.app.json")` 读它。
顶层字段集合是封闭的：多一个未知字段即拒。

| 字段 | 类型 | 必填 | 缺省 | 取值 / 上限 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `access` | enum | 否 | `login` | `public` / `login` / `whitelist` | 访问模式。public=允许匿名（未登录时帧内 user 为 null）；login=要求登录，登录后全员可用（**缺省**）；whitelist=要求登录 + 名单准入（**平台不比对名单**，由应用自己读 whitelist 判定） |
| `whitelist` | string[] | `access="whitelist"` 时 | `[]` | ≤ 2000 | 准入名单——**给应用自己读的名单**（平台不比对、也不校验账号是否存在）：access="whitelist" 时至少要有一个账号，否则拒绝发布 |
| `purpose` | string | 首次发布 | — | — | 一句话用途：应用中心与页面标题用（首次发布必填，之后的版本可沿用） |
| `data_sensitivity` | string | 首次发布 | — | — | 数据敏感度声明（如 internal）：用于事后追责与合规审查（首次发布必填，之后的版本可沿用） |
| `owner` | string | 首次发布 | — | — | 负责人声明（应用出问题找谁）：**不是平台归属** —— 平台归属取自登录态、不可伪造（首次发布必填，之后的版本可沿用） |

字段提示：

- `access`
  - 写漏了按 login 处理：缺省只会'要求登录'，不会意外变成匿名可达
  - **更新版本**时省略本字段 = **沿用上一版生效值**（不是回落 login）：纯代码更新不会改写线上访问级别
  - 要真的改访问级别就**显式**写出来（显式 `"login"` 才算改成登录后全员可用）；显式空串不是合法取值，会被拒
  - 应用中心**不按它过滤**：所有应用都列出来，条目里给出访问级别（供使用者判断该不该点）
  - 改 access = 发一个新版本（运行期改不了）
- `whitelist`
  - 每个条目是一个账号（登录名 login），如 ["zhangwei", "lisi"]
  - **更新版本**时省略本字段 = 沿用上一版的名单；显式给 `[]` 才是“清空名单”（access 仍是 whitelist 时会被拒）
  - 应用入口第一件事就该读它并比对；无权限页必须显示本人账号（作者发现拼错的唯一途径）
  - 含空串即拒（不要用空行占位）；条目数上限见 references/limits.md
- `purpose`
  - 写清楚「这个应用解决什么问题」，使用者据此决定要不要打开
- `data_sensitivity`
  - 平台**没有**这个字段的默认值：不要指望界面或平台替你填（留空会被首版必填校验拒）
  - **更新版本**时省略本字段 = 沿用上一版；显式给空串才会把它清空（那不是“没填”，是“填了空”）
  - 它不改变任何运行时行为，只用于声明与追责
- `owner`
  - 它与应用中心的'负责人'显示同源；平台不拿它做任何权限判断

## 2. 发布载荷（`validate` / `publish` 的请求体）

`POST /api/client/v2/apps/wasm/validate` 与 `POST /api/client/v2/apps/wasm/:app_id/releases` 共用同一份载荷。

| 字段 | 类型 | 必填 | 缺省 | 取值 / 上限 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `app_id` | string | 是 | — | ≤ 63 | 应用标识 = 域名标签（`<app_id>.<应用基域>`）：小写字母/数字/连字符，不超过 63 个字符，不得纯数字、不得以 xn-- 开头、不得是保留字；**不能改名** |
| `version` | string | 是 | — | — | 严格递增的 `x.y.z`（可带 `-prerelease`）：**失败的发布不占号**，已落行的版本永久占用 |
| `title` | string | 首次发布 | — | — | 应用中心显示名称（可中文）：**首次发布必填**，之后的版本可省略（沿用上一版） |
| `changelog` | string | 非首版 | — | — | 本版改动说明：**非首版必填**（空即拒，422 MISSING_FIELD） |
| `wasm_base64` | string | 是 | — | ≤ 33554432 | wasm 模块的 base64 编码（`GOOS=wasip1 GOARCH=wasm` 的产物）：解码后不超过 32 MiB；**平台不做构建**，本地编译后上传 |
| `config` | object | 是 | — | ≤ 65536 | 应用配置文件的内容（即 `picoaide.app.json` 的对象形态）：字段见 `config_fields` |

字段提示：

- `app_id`
  - 也可以由路径 `/apps/wasm/:app_id/releases` 给出；两边都给时必须一致
  - 显示名（可中文）用 title，不要塞进 app_id
- `version`
  - 编译/干跑失败后可以直接重发同一个版本号；已落行的版本换号重发
- `title`
  - app_id 是域名标签不能中文；人看的名字写在这里
- `changelog`
  - 首版可以省略（首版本身就是'新建'）
- `wasm_base64`
  - 载荷较大时改走分片上传 + 续传（片大小上限见 references/limits.md）
  - 导入面只允许 `wasi_snapshot_preview1`；组件模型（wasm32-*-component）产物直接拒
- `config`
  - 平台存的是**解析并归一化之后**的配置（名单去空白/去重、access 缺省落定）
  - **更新版本**时 config 里**缺席**的字段沿用上一版生效值（access/whitelist/purpose/data_sensitivity/owner 逐字段各自沿用）；显式给值——包括显式空串——以提交为准
  - 首版没有可沿用的上一版：缺席的 `access` 按缺省 `login` 落定
  - 改任何一项都要发新版本（§10.5 第 56f 项）

## 3. 三条最容易搞错的语义

- **`access` 缺省是 `login`**（要求登录）：写漏了不会意外变成匿名可达。
- **准入由应用自己判**：平台只把 `access` 与身份注入帧，**不比对名单**；
  名单在 `picoaide.app.json` 里，应用入口第一件事就该读它。
- **改配置 = 发新版**：运行期改不了；`access="whitelist"` 且名单为空会被拒发布。
