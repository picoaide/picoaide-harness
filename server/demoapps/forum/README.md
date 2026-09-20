# 内部小论坛（内置演示应用 · `demo-forum`）

一个**真的能用**的内部小工具：版块 / 主题 / 回帖，支持发帖、回帖、置顶、搜索、分页、
按时间排序，数据落在应用自己的库里（`db.define` 建的三张表）。窗口按**电脑屏幕比例
（16:9，基准 1280×720）**设计，是三段式宽屏桌面布局。

它演示的不是"能力清单"，而是**多表关系 + 事务写入 + 检索 + 分页**这四件真实应用里
天天要写的事。清单与窗口比例登记在 `../demos.json` 的 `demo-forum` 条目。

## 文件

| 文件 | 包内逻辑路径 | 说明 |
| --- | --- | --- |
| `main.go` | — | wasm 后端：路由、校验、SQL、事务，只回 JSON |
| `web/index.html` | `index.html` | 入口页（**由 wasm 读出来返回**，先判名单再给页面） |
| `web/app.css` | `static/app.css` | 样式：渐变 / 玻璃拟态 / 全部动效 / 深浅色 |
| `web/app.js` | `static/app.js` | 取数与渲染（vanilla JS，零依赖） |

`/static/*` 由**宿主按路径直出**，根本不经过 wasm；只有 `/` 与 `/api/*` 会走到应用。

## 数据模型

三张表都由 `db.define` 幂等创建；**没有自增主键可用**（平台保留列 `_row_id` 应用看不到
也不能提），所以业务主键由 `newID()` 自己生成（毫秒时间戳 + 3 字节随机后缀），排序一律
靠 `created_at` / `last_reply_at`。

| 表 | 列 |
| --- | --- |
| `forum_boards` | `id` / `name` / `description` / `sort` / `topic_count` / `created_at` |
| `forum_topics` | `id` / `board_id` / `title` / `body` / `author` / `author_display` / `pinned` / `reply_count` / `last_reply_at` / `created_at` |
| `forum_posts` | `id` / `topic_id` / `body` / `author` / `author_display` / `created_at` |

首次访问（`db.define` 返回 `created == true`）播种 3 个版块：综合讨论 / 技术交流 / 生活杂谈，
外加 3 条带回复的演示主题（空论坛的第一印象是"这东西还没做完"）。
**幂等判据就是那个 `created`**：表已存在时绝不重复播种。

时间列统一存 **UTC、定长到毫秒** 的字符串（`2006-01-02T15:04:05.000Z`），展示时才在前端转本地。
两个理由缺一不可：字符串比较排序要求**定长同偏移**；而 `time.RFC3339` 只到秒，同一秒内建的
主题会得到完全相同的值，`ORDER BY last_reply_at DESC` 会退化成任意顺序（实测踩到过）。
`time.RFC3339Nano` 也不能用 —— 它会裁掉尾随零，长度可变，字符串比较同样会错。

## API

全部返回 JSON；失败一律是平台口径的信封 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | 版块列表 + 当前身份 + 统计（主题数 / 回帖数 / 我的回帖数） |
| `GET` | `/api/topics?board=&q=&page=` | 置顶优先 → `last_reply_at` 倒序；每页 20，返回 `has_more` / `total` |
| `POST` | `/api/topics` | `{board_id,title,body}` → 201；**事务**里插主题 + 递增版块 `topic_count` |
| `GET` | `/api/topics/<id>` | 主题 + 全部回帖（按时间正序） |
| `POST` | `/api/topics/<id>/posts` | `{body}` → 201；**事务**里插回帖 + 更新 `reply_count` / `last_reply_at` |
| `POST` | `/api/topics/<id>/pin` | 切换置顶（`{id,pinned}`） |
| `DELETE` | `/api/topics/<id>` | **只允许作者本人或发布者**（`user.is_publisher`）；事务里连带删回帖 + 版块计数回退 |

**校验**（不合法一律 `400 VALIDATION`）：标题 1–120 字、正文 / 回帖 1–4000 字
（都按**字符**数，不是字节）、`board_id` 必须存在。

**分页**用「多取一行」判 `has_more`（比再跑一次 count 便宜，也让「取不到总数」时翻页照常可用）；
`total` 是一次 `COUNT(*)`，取不到时返回 `null` 且 `total_available: false`。

## UI

- **三段式桌面布局**：左侧版块导航 + 统计，中间主题列表，右侧主题详情 + 回帖。
- **动效**（CSS 为主，`app.js` 只负责加/去 class）：玻璃拟态与渐变、列表 stagger 进场、
  切版块/翻页的整列淡入淡出、新回帖滑入 + 高亮一次、置顶徽章呼吸、骨架屏 shimmer、
  空态内联 SVG 插画、按钮 `:active` 缩放、卡片 hover 抬升、模态框缩放 + 遮罩淡入。
- **深浅色**都跟 `prefers-color-scheme`（`:root` 变量 + 一套 dark 覆盖），不需要开关。
- **无障碍**：真 `<button>`、每个表单控件都有 `<label for>`、键盘可达（`/` 聚焦搜索、
  `Esc` 关模态框 / 返回列表、`⌘/Ctrl+Enter` 发回帖）、`:focus-visible` 明显、
  有 `aria-live` 播报区。
- **XSS**：所有用户内容一律 `textContent` 渲染，全文件没有一处 `innerHTML` 赋值。
- **减少动态效果**：`prefers-reduced-motion: reduce` 下动画与过渡全部关掉。

## 本地验证

```bash
cd server/demoapps/forum
export GOCACHE=/data/picoaide-harness/temp/forum-gocache GOMODCACHE=/root/go/pkg/mod GOPROXY=off

# 编译 + 打包（资源进 wasm 自定义段）
GOOS=wasip1 GOARCH=wasm go build -o /tmp/forum.wasm .
node ../../skills/app-builder/scripts/pack-assets.mjs --in /tmp/forum.wasm --out /tmp/forum-packed.wasm \
  web/index.html=index.html web/app.css=static/app.css web/app.js=static/app.js

# 技能自带的假宿主：静态直出 + 入口 + API
node ../../skills/app-builder/examples/go/preview.mjs /tmp/forum-packed.wasm --path / --user zhangwei
node ../../skills/app-builder/examples/go/preview.mjs /tmp/forum-packed.wasm --path /static/app.js
node ../../skills/app-builder/examples/go/preview.mjs /tmp/forum-packed.wasm --path /api/bootstrap --user zhangwei
node ../../skills/app-builder/examples/go/preview.mjs /tmp/forum-packed.wasm --path /api/topics --user zhangwei

# 静态检查
cd ../.. && GOOS=wasip1 GOARCH=wasm go vet ./demoapps/forum && gofmt -l demoapps/forum/
```

⚠️ **`preview.mjs` 的假宿主只认极窄的 SQL 子集**（单表裸列 `SELECT` + 单表 `INSERT` +
字面量 `UPDATE`），所以：

- 播种能完整跑通（版块的主题计数在播种时就是已知常量，**直接写进 INSERT**，不需要
  `SET topic_count = topic_count + 1` 这种相对更新）—— 所以 `/api/topics` 在预览里能直接
  看到那 3 条演示主题；
- `/api/bootstrap` 的**统计**在预览里取不到（宿主拒绝 `COUNT(*)`），应用如实把
  `stats` 置 `null`、`stats_available` 置 `false`（页面显示「—」）并记一条 warn 日志
  —— **不会**让整个首页 500；
- **事务 / 表达式 UPDATE / `DELETE` 在预览里完全不支持**，所以发帖、回帖、置顶、删除
  这些写路径**必须**换一个"底下是真 SQLite"的宿主才验得了。

本仓库的 `temp/forum-verify/`（gitignored，不入库）里有一组这样的验证器，改完应用可以复跑：

| 脚本 | 覆盖 |
| --- | --- |
| `forum-e2e.mjs <packed.wasm>` | 真实 SQLite 假宿主（照平台契约实现 `db.*` / 事务 / 保留列门禁），跑 72 条断言：发帖 → 回帖 → 置顶 → 搜索 → 分页 → 删除权限 → 级联删除 → 计数器一致性 → 名单准入 |
| `dom-smoke.mjs <web 目录>` | jsdom 真跑 `index.html` + `app.js`，42 条断言：首屏渲染、**XSS 防线**、模态框/搜索/回帖交互、错误提示条、无障碍 |
| `wasm-imports.mjs <app.wasm> <imports_gen.go>` | 把产物导入段与平台白名单逐条对拍（不在名单里 = 发布期 `IMPORT_NOT_ALLOWED`） |
| `shot.mjs <web 目录> <前缀>` | 用 Chromium CDP 按 **1280×720** 截图（浅色 / 深色 / 模态框） |

### 另一个只有跑起来才会撞到的坑：wasip1 的 stdin 是非阻塞的

`node:wasi` 把 stdin/stdout 设成非阻塞：应用写完一帧宿主调用后**立刻**去读响应，只要
宿主还没写完，`fd_read` 就返回 EAGAIN，在 Go 里表现为 `read /dev/stdin: Try again`
——症状是**第一个宿主调用必然失败**（请求帧本身读得到，因为宿主在 spawn 前就写了），
页面上看到的是一句莫名其妙的「应用配置读不到」。

平台宿主侧的管道本来就是阻塞的，所以 `main.go` 开头做了两件事把它拨回来：

```go
_ = syscall.SetNonblock(int(os.Stdin.Fd()), false)
_ = syscall.SetNonblock(int(os.Stdout.Fd()), false)
```

`fd_fdstat_set_flags` 在平台的导入白名单里，所以这一步不会让产物发不出去；在平台上是
幂等的空操作。**共享底座 `demoapp` 没有做这一步**，所以这一段写在应用自己的 `main` 里。

## 权限与准入

`../demos.json` 把 `demo-forum` 配成 `access: login`。入口 `/` 的第一件事仍是
`app.AccessAllowed()`：读自己的 `picoaide.app.json`（平台保留资源，宿主永不直出）并按
`access` 判定；不通过时返回自制的 403 页，**页面上显示本人账号** —— 名单拼错时这是唯一
能发现的途径。`/api/*` 走同一条判定，拒绝时给 `403 FORBIDDEN` 的 JSON 信封。

置顶不限制身份（内部论坛的公共操作）；**删除**限作者本人或应用发布者（`user.is_publisher`）。
