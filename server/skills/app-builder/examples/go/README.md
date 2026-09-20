# 示例：团队共享便签（Go wasm 后端 + 静态前端）

这是一个**可以直接编译发布**的最小真实应用，也是作者与 AI 的黄金路径样板：
拷走整个目录 → 改业务逻辑 → 打包 → 上传。发布后它**只在桌面客户端内打开**
（客户端「应用中心」点开，或点开深链 `<渠道 scheme>://app/<app_id>`）——
应用没有浏览器地址，也没有应用域名/证书。

形态是**前后端分离**：静态前端（随包资源，宿主按路径直出）＋ wasm 后端（只回 JSON）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `main.go` | wasm 后端：读请求帧 → 判准入 → 调宿主 → 回 JSON；入口页由它读了 `index.html` 再返回 |
| `web/index.html` | 页面结构（只放结构，脚本外链 `/static/app.js`） |
| `web/app.css` | 样式（包内，外部 CDN 加载不到） |
| `web/app.js` | 取数与渲染、三态切换、客户端 AI loop 调用 |
| `picoaide.app.json` | 随包配置（`access` / `whitelist` / `purpose` / `data_sensitivity` / `owner`；字段规格见 `references/app-config.md`） |
| `go.mod` | 独立模块（示例不依赖平台内部包，作者拿到的就是这一份） |
| `preview.mjs` | 本地假宿主：用 Node 自带的 `node:wasi` + `node:sqlite` 把应用跑起来（零外部依赖；数据落本地库，`--dump-tables` 可看） |

## 四步跑起来

```bash
# ① 编译（不要在 $HOME 下建缓存目录：把状态放在当前工作区里）
export GOCACHE="$PWD/.gocache" GOMODCACHE="$PWD/.gomodcache" GOPATH="$PWD/.gopath" TMPDIR="$PWD/.tmp"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOPATH" "$TMPDIR"
GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .

# ② 把前端资源打进 wasm 的自定义段（段名 = 包内逻辑路径）
mkdir -p dist
node ../../scripts/pack-assets.mjs --in shared-notes.wasm --out dist/shared-notes-packed.wasm \
  web/index.html=index.html web/app.css=static/app.css web/app.js=static/app.js

# ③ 本地预览（Node 24+ 自带 node:wasi；入口走 wasm，静态资源由假宿主直出）
node preview.mjs dist/shared-notes-packed.wasm --path / --user zhangwei
node preview.mjs dist/shared-notes-packed.wasm --path /static/app.js       # 宿主直出，不跑 wasm
node preview.mjs dist/shared-notes-packed.wasm --path /api/notes --method POST --body '{"body":"hello"}'
node preview.mjs dist/shared-notes-packed.wasm --user someone-else         # 看无权限页
node preview.mjs dist/shared-notes-packed.wasm --dump-tables               # 看本地库的表/列/行数
node preview.mjs --selftest                                                # 自检：本地库语义与平台同向（8 条）

# ④ 上传平台：先 wasm_app_validate（不占版本号），过了再 wasm_app_publish
```

`../../scripts/pack-assets.mjs` 的路径按"技能目录里的 `examples/go/`"算；如果你已经把
`examples/go/` 拷到别处，用技能目录下的绝对路径（`<技能目录>/scripts/pack-assets.mjs`）。

预览脚本扮演宿主：它按 ABI 收发帧，用内存数据应答 `db.*` / `log` / `assets.read`，
并**按宿主规则直出包内静态资源**（规则见 `references/abi.md` §3.7）。
它验证的是**协议层**（帧读写、路由分支、名单判定、静态资源直出、失败分支），
**它不提供 AI**：应用里的 AI 走页面里的客户端 AI loop，由客户端本地处理。

## 这个示例刻意演示的规则

- **前后端分离**：`web/` 是页面，`main.go` 只回 JSON；入口 `/` 由 wasm 答（它要先判名单），
  `/static/*` 由宿主直出（不执行 wasm）。
- **每个请求都重新读身份**：实例每请求新建，全局变量存不住东西。
- **入口先读配置再判名单**：`assets.read("picoaide.app.json")` + `whitelist` 比对；
  无权限页**显示本人账号**，这是作者发现名单拼错的唯一途径。
- **建表只用 `db.define`**（幂等）；SQL 只有 `SELECT` / `INSERT` / `UPDATE` / `DELETE`，
  一次一条、值全部参数化；**不碰平台保留列 `_row_id` 及其别名 `rowid`/`_rowid_`/`oid`**。
- **AI 不在 wasm 里**：页面经 `POST /__picoaide/ai/chat` 调客户端 AI loop（流式），
  结果再回传 `/api/summaries` 落库；本示例的 wasm 侧不含 AI。提示词由 wasm 拼好并截断
  （`/api/ai-prompt`），因为桥对单条消息有 16 KiB 上限。
- **失败一律 JSON 信封**：`{"error":{"code","message"}}`，页面把 `message` 显示给人、
  `code` 进 `console.error`。
- **三态齐全**：加载中 / 空 / 失败，三个元素由 `app.js` 切换（少一个就是白屏 bug）。
- **只用 `textContent` 渲染用户数据**（不拼 `innerHTML`）。
- **stdout 只写协议帧**：日志走 `log` 宿主调用（预览里打到 stderr）。
- **不假设"读会阻塞"**：非阻塞 stdin 会返回 `EAGAIN`，示例里对读写都做了重试。
- **状态只进应用库**：示例不用 cookie（自定义协议下 `document.cookie` 恒为空、
  `Set-Cookie` 不落盘），要存东西就用 `db.define` / `db.exec` / `db.query`。

## 改成你自己的应用

1. 改 `picoaide.app.json`：`access`（写侧只有 `login` 登录后全员 / `whitelist` 只给名单里的人；
   历史 `public` 读取侧按 `login` 处理、新版本不要再写）、
   `purpose`（标题）/ `whitelist`（账号名单）/ `owner`。
2. 改表结构：`defineSchema` 里的列（最多 16 列；一个应用最多 16 张表）。
   注意**没有自动迁移**：已经发布过的表要加字段，请用新表名并自己搬数据。
3. 改接口：`run()` 里的 `switch` 分支（**`/api/*` 一律回 JSON**）。
4. 改页面：`web/index.html` + `web/app.css` + `web/app.js`（引用资源用绝对路径）。
5. 重新编译 → 打包 → 预览 → 上传新版本号（`x.y.z`，必须比线上大；失败不占版本号）。
