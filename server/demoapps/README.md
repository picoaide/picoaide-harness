# 内置演示应用（demoapps）

随服务端镜像分发的 WASM 应用样例：**装完即用、可删除、删除后不再重建**。客户拿到平台后
不必先自己写一个应用，打开应用中心就能点开这几个。

## 这一层里有什么

| 目录 | 作用 |
| --- | --- |
| `internal/demoapp/` | **共享运行时底座**：请求帧读写、宿主能力（`db.*` / `log` / `assets.read`）的类型化包装、身份与名单准入、JSON/HTML 响应构造。三个演示应用都只用它，不各自抄一遍协议 |
| `showcase/` | **能力全集**（手机比例 `9:19.5`）：把平台给的每一项能力当场跑一遍并显示真实结果与错误信封 |
| `forum/` | **内部小论坛**（电脑比例 `16:9`）：版块 / 主题 / 回帖，多表 + 事务 + 检索 + 分页 |
| `board/` | **留言板**（电脑比例 `16:9`）：一张表、一次写入、一个列表；准入走**名单**，顺带演示 `whitelist` |
| `demos.json` | **清单**：逐条声明 `app_id` / 用哪份 wasm（`wasm`）/ 准入（`access`）/ 窗口（`window`）/ 用途声明。播种的**唯一真源** |

## 装配链（三个落点，缺一条演示就出不来）

```
demoapps/<app>/{main.go, web/}                 源码（前端资源在 web/）
        │  go build -o <app>.wasm          （GOOS=wasip1 GOARCH=wasm）
        ▼
   <app>.wasm  ── pack-assets.mjs ──►  <app>.wasm（前端资源进了自定义段）
        │                                     ↑ 宿主按路径直出 /static/*，入口 / 由 wasm 读 index.html 返回
        ▼
/opt/picoaide/demo-apps/  ← Dockerfile 的 demoassets 阶段产出（wasm + demos.json）
        │  服务端启动时 appseed 播种（**只落 apps/app_releases 行**：随包资源在制品字节里，
        │  运行期由宿主解析自定义段后常驻内存 —— 2026-09-20 起宿主盘不再有版本资源目录）
        ▼
   应用中心里的 demo-* 三个应用
```

- **前端与后端分离**：`web/index.html` + `web/app.css` + `web/app.js` 是纯静态资源（打包成
  `index.html` / `static/app.css` / `static/app.js` 三个自定义段）；`main.go` 只做 JSON API。
- **入口 `/` 必须由 wasm 处理**：非保留资源会被宿主**按路径直出**（`/static/*` 不经过 wasm），
  所以"先判名单再给页面"只有让 `/` 走应用才成立。
- **`picoaide.app.json` 是平台保留资源**，宿主永不直出。生产环境里它由平台按库内
  `config_json`（`appseed` 依 `demos.json` 折算写入）随资源集注入；本目录里每个应用各带一份
  同名文件，**只服务本地预览**（预览工具要读它才能演示 `access` / `whitelist`）。

## 本地构建与预览

```bash
# 编译 + 打包前端资源（产物 /tmp/demo-<app>-packed.wasm），与 Dockerfile 同一套步骤
bash server/scripts/build-demo-apps.sh            # 全部
bash server/scripts/build-demo-apps.sh forum      # 单个

# 假宿主跑一遍（按平台真实路由规则：/static/* 直出、/ 走 wasm、db.*/log/assets.read 有应答）
# 注意：假宿主直接从**制品里的自定义段**取资源，与生产一致（生产也是内存直出，不落盘）
node server/skills/app-builder/examples/go/preview.mjs /tmp/demo-forum-packed.wasm \
  --config server/demoapps/forum/picoaide.app.json --path / --user zhangwei
node server/skills/app-builder/examples/go/preview.mjs /tmp/demo-forum-packed.wasm \
  --config server/demoapps/forum/picoaide.app.json --path /api/bootstrap --user zhangwei
```

浏览器里看效果（真实的 HTTP + 真跑 wasm）：

```bash
node temp/demo-host.mjs --wasm /tmp/demo-forum-packed.wasm \
  --web server/demoapps/forum/web --port 18801 --user zhangwei
# 打开 http://127.0.0.1:18801/
```

## 写新演示的注意事项

- 每个演示至少要有 `web/index.html`、`web/app.css`、`web/app.js`（打包命令逐个列出，
  不用通配 —— 通配会把误放进来的文件一起塞进镜像）。
- 表结构走 `db.define`（平台不允许应用自己写 DDL）；SQL 只用 `SELECT/INSERT/UPDATE/DELETE`
  且**值一律用 `?` 占位**（平台不替你参数化）；**平台保留列 `_row_id` 不能出现在 SQL 或列名里**。
- 事务里只允许数据库读写；`log` / `assets.read` / `db.define` 放进事务会 `DB_DENIED`。
- 只有 6 个宿主原语，**没有文件、没有网络、没有 AI 宿主调用**；应用里的 AI 走前端
  `POST /__picoaide/ai/chat`（客户端 AI loop）。
- 静态资源总量 ≤4 MiB，别放二进制素材（图片/字体）；用内联 SVG + CSS。
- 加了新演示：`demos.json` 补一条（含 `wasm` 与 `window`），Dockerfile 的 `for app in …`
  与 `server/scripts/build-demo-apps.sh` 的 `ALL_APPS` 同步加名字 —— 三处不一致会出现
  "镜像里没有这份 wasm"的装配错误（`appseed` 会直接失败，不静默跳过）。
