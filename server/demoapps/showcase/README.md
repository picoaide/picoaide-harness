# showcase —— 能力全集（手机竖屏演示 / 上线前自查）

把平台给 WASM 应用的**每一项能力都当场跑一遍**，并把真实结果（成功/失败、平台回的
`code` / `message` / `details` / `hints`、耗时微秒）显示在页面上。它同时是给客户看的
「能力全集」，也是应用上线前的自查工具 —— 页面上的时间线来自**本次请求真实发生过的
宿主调用**（`app.Traces()`），不是画出来的清单。

窗口比例在 `demos.json` 里声明为 `window.ratio = "9:19.5"`（≈0.4615），客户端会强制
锁定，所以前端按**窄屏竖屏**设计（设计基准宽 420px，单列，不做宽屏两栏）。

## 页面结构（一页滚动 + 顶部分段导航，12 屏）

| 屏 | 展示的能力 | 数据来源 |
| --- | --- | --- |
| 01 身份注入 | `user.id / username / display_name / dept / is_publisher`、`auth.mode/verified`、帧里的 headers 与「不含 Cookie」 | `GET /api/whoami`（全部来自请求帧，应用没有登录逻辑） |
| 02 访问模式 | `access` / `whitelist` / `purpose` / `data_sensitivity` / `owner`、`picoaide.app.json` 原文，以及 login 与 whitelist 的区别（**R24**：平台不比对名单） | 同上 + `assets.read("picoaide.app.json")` |
| 03 建表 | `db.define`（DDL 唯一入口、幂等、列配额与保留列 `_row_id` 的存在） | `POST /api/run` |
| 04 写入 + 查询 | `db.exec` 插一条、`db.query` 读回来，值一律 `?` 占位 | 同上 |
| 05 事务 | 「提交」「回滚」两个按钮各写两条，再用同一 marker 的行数证明**回滚真的没落库** | `POST /api/tx`（`mode=commit|rollback`） |
| 06 应用日志 | `log` 写一条、`accepted/dropped`、单条 ≤4 KiB / 每请求 ≤100 条 / 保留 7 天 | `POST /api/log`、`POST /api/run` |
| 07 包内资源 | `assets.read` 的 `content_type / size / encoding`（入口页 + 保留资源两种），并现场对比「宿主直出 `/static/*`」与「交给 wasm」 | `POST /api/run` + 页面直接 `fetch('/static/app.css')` |
| 08 被拒的样子 | 8 种**故意违规**（SQL 提保留列 / 别名 rowid / `WITH` / 多语句 / 直接 DDL / 事务里 `log` / 事务里 `db.define` / 嵌套事务），把平台回的 code+message+details+hints 原样渲染，并对比「文档预期」与「本次实际」 | `GET/POST /api/denied` |
| 09 客户端 AI | 页面直接 `POST /__picoaide/ai/chat`，按 SSE 解析 `delta` / `done` / `error` 三类帧增量渲染；六个错误码逐条给出可读处置 | 客户端 AI loop（wasm 里没有 AI） |
| 10 存储边界 | 应用库不随清缓存/切账号丢失；`localStorage`/`sessionStorage`/`IndexedDB` 可再生；`Cache Storage` 与 cookie 不可用 | 静态说明 |
| 11 历史证据 | 应用库里的真实数据（最近 20 行） | `GET /api/runs` |
| 12 能力时间线 | 本次请求 `app.Traces()`：方法 / 成功与否 / 备注 / 耗时微秒 + 汇总统计 | 每个响应里的 `traces` |

## 后端路由（`main.go`）

| 路由 | 说明 |
| --- | --- |
| `GET /`、`GET /index.html` | **先 `app.AccessAllowed()` 再给页面**；不通过返回应用自制的 403 页（显示本人账号、账号名、`access` 与名单内容） |
| `GET /api/whoami` | 身份 + 访问模式 + 配置原文 + 判定说明 + traces |
| `POST /api/run` | 3~7 全跑一遍（建表 → 直写 → 查询 → 事务提交 → 事务回滚 → 日志 → 两个 `assets.read` → 历史），返回每步结果与 traces |
| `POST /api/tx` | 只跑事务，`{"mode":"commit"｜"rollback"}` |
| `POST /api/log` | 只写一条日志，`{"message":"…"}`（可省） |
| `GET/POST /api/denied` | GET 返回 8 种违规形态清单（页面据此渲染按钮）；POST `{"kind":"…"}` 触发一次并把拒绝信封原样返回 |
| `GET /api/runs?limit=N` | 历史证据（≤50 行） |
| 其它 GET 路径 | 兜底：在 wasm 里 `assets.read` 一次（宿主直出没命中时才会走到）。**保留资源 `picoaide.app.json` 与 `__picoaide/*` 在这里被明确挡掉**，不会被当普通资源发出去 |

每一步的 `micros` 都是「这一步真实发生的宿主调用耗时之和」（`app.Traces()` 的片段），
页面上的数字可以和时间线逐条对上。

## 平台约束（本应用逐条照做，也是演示内容的一部分）

- 宿主能力只有 6 个原语 / ABI 9 个方法；**wasm 侧没有任何 AI**；
- SQL 只允许 `SELECT/INSERT/UPDATE/DELETE`，`db.query` 只跑 SELECT、`db.exec` 只跑增删改，
  不能有 `WITH` / `PRAGMA` / DDL / 多语句；建表只能走 `db.define`；
- 平台保留列 `_row_id`（以及 `rowid` / `_rowid_` / `oid`）**连提都不能提**；
- 值一律 `?` 占位（平台不替你参数化，注入没有平台侧防线）；
- 事务内只允许 `db.query` / `db.exec` 与两个出口（`log` / `assets.read` / `db.define` 必被拒）；
- `/static/*` 由宿主直出、不经过 wasm；入口 `/` 必须由 wasm 读包内 `index.html` 返回；
- 前端零外部依赖（无 CDN、无外链字体、无图片文件）；渲染一律 `textContent`，不拼 `innerHTML`。

## 本地构建与预览

```bash
cd server/demoapps/showcase
export GOCACHE=/data/picoaide-harness/temp/showcase-gocache GOMODCACHE=/root/go/pkg/mod GOPROXY=off
GOOS=wasip1 GOARCH=wasm go build -o /tmp/showcase.wasm .
node ../../skills/app-builder/scripts/pack-assets.mjs --in /tmp/showcase.wasm --out /tmp/showcase-packed.wasm \
  web/index.html=index.html web/app.css=static/app.css web/app.js=static/app.js

# 入口（走 wasm：先判名单再给页面）
node ../../skills/app-builder/examples/go/preview.mjs /tmp/showcase-packed.wasm \
  --config picoaide.app.json --path / --user zhangwei
# 宿主直出静态资源（不执行 wasm）
node ../../skills/app-builder/examples/go/preview.mjs /tmp/showcase-packed.wasm --path /static/app.css
# 身份与访问模式
node ../../skills/app-builder/examples/go/preview.mjs /tmp/showcase-packed.wasm \
  --config picoaide.app.json --path /api/whoami --user zhangwei
# 全套能力（注意：本地假宿主没有事务原语，见下）
node ../../skills/app-builder/examples/go/preview.mjs /tmp/showcase-packed.wasm \
  --config picoaide.app.json --path /api/run --method POST --user zhangwei
```

`server/scripts/build-demo-apps.sh` 与镜像里的 `Dockerfile` 走的是同一套步骤
（`demoapps/<app>/web/*` → `index.html` / `static/app.css` / `static/app.js` 三个自定义段）。

### 本目录里的 `picoaide.app.json`

它是**平台保留资源**，生产环境由 `appseed` 依 `demos.json` 写进版本资源目录；
本目录里的这一份**只服务本地预览**（预览工具要读它才能演示 `access` / `whitelist`）。

## 本地预览与真机的两处差异（不是应用的问题，但要认账）

1. **事务**：随技能分发的假宿主只应答 `db.define` / `db.query` / `db.exec` / `log` /
   `assets.read`，`tx_begin` 会回 `NOT_FOUND: 未知的宿主方法: tx_begin`。因此本地预览里
   两个事务步骤会显示为失败（页面会补一句诊断，说明本次没有发生提交或回滚）；平台宿主上
   这两步会真的提交与回滚。
2. **拒绝闸门**：假宿主的闸门比平台窄（只认它自己能解析的 SQL 形态）。8 种故意违规里，
   本地只有「`WITH`」「直接 DDL」会被它拒绝，其余会被它**放行**；页面用
   「与文档不一致」徽标如实标出来 —— 这正是自查工具该有的行为，上线前请以平台实测为准。

另外假宿主的请求帧里 `app_id` / `version` 是它自己写死的（`shared-notes` / `1.0.0`），
不代表线上取值。
