# 留言板（内置演示应用 · `demo-board`）

**最小可用形态**的样板：一张表、一次写入、一个列表，外加一份名单准入。
窗口按**电脑屏幕比例**（16:9，基准 1280×720）设计 —— 客户端按 `demoapps/demos.json`
里的 `window.ratio` 锁定比例，所以界面按宽屏桌面写，不按手机竖屏写。

它要回答的问题不是"平台能做什么"，而是"**一个能用的应用至少需要平台给什么**"：

| 需要什么 | 平台给什么 | 本应用怎么用 |
| --- | --- | --- |
| 一份数据 | `db.define` / `db.query` / `db.exec` | 一张 `board_notes` 表，主键应用自己生成 |
| 谁在操作 | 请求帧里的 `user{id,username,display_name,dept,is_publisher}` | 作者/部门直接落库，不做登录 |
| 谁能进来 | `access` 模式 + 应用自己的 `picoaide.app.json` | `access=whitelist`，名单由**应用**比对（R24） |
| 一块界面 | 入口 `/` 走 wasm，`/static/*` 由宿主直出 | `index.html` 由 wasm 读，CSS/JS 走 `/static/*` |

## 文件

```
main.go              入口 + 四个 API + 名单判定 + 自制 403 页（唯一后端文件）
web/index.html       页面骨架（模板里只有一个空 <template>，用户数据全靠 textContent 填）
web/app.css          全部样式（纯 CSS 渐变/玻璃拟态，无图片、无外链字体）
web/app.js           页面脚本（vanilla JS，零依赖：计数、发布、删除、FLIP、骨架屏、轮询）
picoaide.app.json    随包配置（access/whitelist/owner…）：平台侧由 appseed 依 demos.json 播种，
                     本目录这份只给本地预览读（见 demoapps/README.md）
```

前端资源由 `server/skills/app-builder/scripts/pack-assets.mjs` 打进 wasm 的自定义段：
`web/index.html → index.html`、`web/app.css → static/app.css`、`web/app.js → static/app.js`。

## 数据模型

```sql
board_notes(
  id             text,  -- 业务主键：毫秒时间戳(36 进制) + 4 字节随机后缀
  body           text,  -- 正文 1–500 字（按字符算，服务端 TrimSpace 后校验）
  author         text,  -- 平台账号
  author_display text,  -- 展示名（缺失回落账号）
  created_at     int,   -- 毫秒时间戳，列表按它倒序
  dept           text   -- 部门（帧里给什么存什么）
)
```

* **没有自增主键**：平台保留列（`_row_id` 之类）应用看不到也不能提，键只能自己生成。
* **首次访问建表 + 播种**：`/` 与每个 API 都会先 `ensureSchema()`；只有
  `db.define` 返回 `created == true`（**这次请求真的建了表**）且表里没有数据时，
  才写入 3 条欢迎留言（作者是应用自己 `board`）。表已存在、或已有数据 ⇒ 一个字节都不写。
* 已知取舍：两个**同时**发生的首次请求可能各播一次（应用层没有跨请求锁）。首次访问是
  一个人的一次页面加载，实际撞不上；要做到严丝合缝得用 `db.tx` 把"查空 + 写入"包起来，
  而演示要的是最小形态。本应用**一次事务都没开**（`db.tx` 的能力见 `showcase`）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/me` | 身份 + 配置摘要：`user` / `config{access,owner,whitelist_count,purpose,data_sensitivity}` / `limits` |
| `GET` | `/api/notes?limit=<n>` | 按 `created_at` 倒序；缺省 100，`limit>200` 收敛到 200；非数字或 ≤0 → 400 |
| `POST` | `/api/notes` | 体 `{"body":"…"}`；正文 1–500 字，空/超长/非 JSON → 400 `VALIDATION`；成功 201 并回完整对象 |
| `DELETE` | `/api/notes/<id>` | **只有作者本人或应用发布者**；他人 403 `FORBIDDEN`，不存在 404，成功 200 |

* 失败一律是平台口径的信封 `{"error":{"code","message"}}`；宿主调用失败（如 `DB_DENIED`）
  也走同一个信封，并把**平台给的能力码与提示原样带出来**（不压成一句"操作失败"）。
* 权限判定的顺序不可反：先 `SELECT author … WHERE id = ?` 判权力，判过了才 `DELETE`
  —— 先删再判等于把别人的删掉了才发现不该删。
* 值一律 `?` 占位放进 args（平台**不替你参数化**）。

## 准入（`access = whitelist`）

平台只把模式（`auth.mode`）与身份注入帧，**名单比对由应用读自己的 `picoaide.app.json`
完成**。本应用的实现：

* `/` 里 `ok, reason, cfg := app.AccessAllowed()`；不通过 ⇒ **自制 403 页**（不是平台页）；
  通过才 `app.EntryHTML()` 把 `index.html` 给出去。
* 所有 `/api/*` 同样先过闸：名单外返回 403 JSON 信封（不泄露路径存在性）。
* 403 页必须显示四样东西：`reason`、**本人账号**、当前名单的**全部账号**、应用负责人
  （`cfg.Owner`）。这是作者发现"名单拼错了"的唯一途径。
* 比对口径（底座 `AccessAllowed()` 的语义）：**忽略大小写与首尾空格**——所以这两样不会
  把人挡住；会挡住人的是**多余空格**与**拼错**。403 页对这两种情形直接点破
  （"← 和你的账号只差空格" / "← 和你的账号只差 1 个字符（拼错了？）"，编辑距离 ≤2 才提示）。

## 界面

* 宽屏两列瀑布流（`columns:2`，窄屏自动单列）+ 顶部品牌条 + 居中输入区。
* 动效全部真做了：渐层极光背景缓慢漂移、新留言滑入 + 高亮脉冲、删除**折叠消失**
  （height 过渡）后其余卡片 **FLIP** 补位、列表错落进场、骨架屏微光、空态内联 SVG 插画
  呼吸、按钮 `:active` 缩放、字数接近上限时计数条变琥珀/超标变红并呼吸。
* `prefers-reduced-motion: reduce` 下**全部关掉**（CSS 总闸 + 脚本里跳过 FLIP/折叠）。
* 深浅色都走 `prefers-color-scheme` + CSS 变量，不做 JS 切换。
* 无障碍：真 `<button>`/`<label>`、`aria-live="polite"` 播报新留言/删除/失败、
  焦点可见（`:focus-visible`）、删除是"点两次确认"而不是弹窗。
* 安全：**用户数据只用 `textContent` 渲染**（脚本里连一个 HTML 字符串都没有，
  静态结构在 `<template>` 里克隆）；页面不引用任何外部资源（无 CDN、无外链字体、无图片）。

## 本地跑

本目录自带一份 `picoaide.app.json`（**只服务本地预览**：生产环境里这份配置由 `appseed`
依 `demos.json` 写进版本资源目录，见 `demoapps/README.md`）。

```bash
# ① 官方本地链路：编译 + 打包前端资源 → temp/demo-build/board-packed.wasm
bash server/scripts/build-demo-apps.sh board

# ② 假宿主跑一遍（按平台真实路由：/static/* 直出、/ 走 wasm、db.*/log/assets.read 有应答）
node server/skills/app-builder/examples/go/preview.mjs temp/demo-build/board-packed.wasm \
  --config server/demoapps/board/picoaide.app.json --path / --user zhangwei
node server/skills/app-builder/examples/go/preview.mjs temp/demo-build/board-packed.wasm \
  --config server/demoapps/board/picoaide.app.json --path /api/me --user zhangwei
node server/skills/app-builder/examples/go/preview.mjs temp/demo-build/board-packed.wasm \
  --config server/demoapps/board/picoaide.app.json --path /api/notes --method POST \
  --body '{"body":"第一条留言"}' --user zhangwei
# 换一个不在名单里的账号看 403 页
node server/skills/app-builder/examples/go/preview.mjs temp/demo-build/board-packed.wasm \
  --config server/demoapps/board/picoaide.app.json --path / --user zhanwei

# ③ 浏览器里看效果（真 HTTP + 真跑 wasm）
node temp/demo-host.mjs --wasm temp/demo-build/board-packed.wasm \
  --web server/demoapps/board/web --port 18801 --user zhangwei     # → http://127.0.0.1:18801/
```

### 预览宿主（`preview.mjs`）覆盖不到的地方

它是**协议层**假宿主，不是数据库，因此：

* `db.exec` 只实现 `INSERT INTO … VALUES (?,…)`，`db.query` 只实现
  `SELECT <列…> FROM <表> [ORDER BY created_at DESC] [LIMIT ?]`。所以
  **`DELETE /api/notes/<id>` 在预览里走不通**（先查作者的那条 SELECT 会被当成
  `LIMIT <id>` ⇒ 查不到 ⇒ 404），这是预览的限制，不是接口的问题。
* 每个请求都是**全新的内存库**（数据不跨调用保留），页面里发一条再刷新就没了；
  它也不解析查询串，所以 `?limit=` 在预览里恒为缺省值。
* 想看 DELETE 的权限矩阵 / `limit` 解析 / 播种幂等，需要把假宿主补上
  "按 id 过滤的 SELECT + DELETE"并让状态跨请求保留 —— 本次验证用的就是这样一个
  扩展宿主的探针（`temp/board-probe/ext-host.mjs`，**不进仓库**）。
