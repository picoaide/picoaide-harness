# 示例：团队共享便签（Go / wasm32-wasip1）

这是一个**可以直接编译发布**的最小真实应用，也是作者与 AI 的黄金路径样板：
拷走整个目录 → 改业务逻辑 → 上传。发布后它**只在桌面客户端内打开**
（客户端「应用中心」点开，或点开深链 `<渠道 scheme>://app/<app_id>`）——
应用没有浏览器地址，也没有应用域名/证书。

## 文件

| 文件 | 作用 |
| --- | --- |
| `main.go` | 应用本体：读请求帧 → 调宿主 → 写响应；含白名单判定、建表/查询/写入 |
| `picoaide.app.json` | 随包配置（`access` / `whitelist` / `purpose` / `data_sensitivity` / `owner`；字段规格见 `references/app-config.md`） |
| `go.mod` | 独立模块（示例不依赖平台内部包，作者拿到的就是这一份） |
| `preview.mjs` | 本地假宿主：用 Node 自带的 `node:wasi` 把应用跑起来（零外部依赖） |

## 三步跑起来

```bash
# ① 编译（不要在 $HOME 下建缓存目录：把状态放在当前工作区里）
export GOCACHE="$PWD/.gocache" GOMODCACHE="$PWD/.gomodcache" GOPATH="$PWD/.gopath" TMPDIR="$PWD/.tmp"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOPATH" "$TMPDIR"
GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .

# ② 本地预览（Node 24+ 自带 node:wasi）
node preview.mjs shared-notes.wasm                                  # 首页
node preview.mjs shared-notes.wasm --method POST --path /api/notes --body 'body=hello'
node preview.mjs shared-notes.wasm --user someone-else              # 看无权限页

# ③ 上传平台：先 validate（不占版本号），过了再 publish
```

预览脚本扮演宿主：它按 ABI 收发帧，用内存数据应答 `db.*` / `log` / `assets.read`
（**它不提供 AI**：平台在 wasm 侧没有 AI 能力，见下面的说明）。
它验证的是**协议层**（帧读写、路由分支、名单判定、失败分支），不是"线上行为"。

## 这个示例刻意演示的规则

- **每个请求都重新读身份**：实例每请求新建，全局变量存不住东西。
- **入口先读配置再判名单**：`assets.read("picoaide.app.json")` + `whitelist` 比对；
  无权限页**显示本人账号**，这是作者发现名单拼错的唯一途径。
- **建表只用 `db.define`**（幂等）；SQL 只有 `SELECT` / `INSERT` / `UPDATE` / `DELETE`，
  一次一条、值全部参数化；不碰平台的保留行号列。
- **AI 不在 wasm 里**：应用前端经 `POST /__picoaide/ai/chat` 调客户端 AI（流式），
  结果再回传 wasm 落库；本示例的 wasm 侧不含 AI。
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
3. 改页面：`page()` 里就是 HTML（样式内联；外部 CDN、外链图片、外部字体一律加载不到）。
4. 重新编译 + 预览 + 上传新版本号（`x.y.z`，必须比线上大；失败不占版本号）。
