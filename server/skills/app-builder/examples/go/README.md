# 示例：团队共享便签（Go / wasm32-wasip1）

这是一个**可以直接编译发布**的最小真实应用，也是作者与 AI 的黄金路径样板：
拷走整个目录 → 改业务逻辑 → 上传。

## 文件

| 文件 | 作用 |
| --- | --- |
| `main.go` | 应用本体：读请求帧 → 调宿主 → 写响应；含白名单判定、建表/查询/写入、AI 摘要 |
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
node preview.mjs shared-notes.wasm --path /api/summary --method POST # 看 AI 摘要分支（预览里是固定文本）

# ③ 上传平台：先 validate（不占版本号），过了再 publish
```

预览脚本扮演宿主：它按 ABI 收发帧，用内存数据和固定文本应答 `db.*` / `ai.chat` /
`log` / `assets.read`。它验证的是**协议层**（帧读写、路由分支、名单判定、失败分支），
不是"线上行为"。

## 这个示例刻意演示的规则

- **每个请求都重新读身份**：实例每请求新建，全局变量存不住东西。
- **入口先读配置再判名单**：`assets.read("picoaide.app.json")` + `whitelist` 比对；
  无权限页**显示本人账号**，这是作者发现名单拼错的唯一途径。
- **建表只用 `db.define`**（幂等）；SQL 只有 `SELECT` / `INSERT` / `UPDATE` / `DELETE`，
  一次一条、值全部参数化；不碰平台的保留行号列。
- **AI 调用是阻塞的**：`ai.chat` 最长等 30 秒，页面上给了等待提示；
  余额不足（`AI_BALANCE_INSUFFICIENT`）时给一句人话，不显示金额、不重试。
- **stdout 只写协议帧**：日志走 `log` 宿主调用（预览里打到 stderr）。
- **不假设"读会阻塞"**：非阻塞 stdin 会返回 `EAGAIN`，示例里对读写都做了重试。

## 改成你自己的应用

1. 改 `picoaide.app.json`：`access`（`public` 匿名可用 / `login` 登录后全员 / `whitelist` 只给名单里的人）、
   `purpose`（标题）/ `whitelist`（账号名单）/ `owner`。
2. 改表结构：`defineSchema` 里的列（最多 16 列；一个应用最多 16 张表）。
   注意**没有自动迁移**：已经发布过的表要加字段，请用新表名并自己搬数据。
3. 改页面：`page()` 里就是 HTML（样式内联；外部 CDN、外链图片、外部字体一律加载不到）。
4. 重新编译 + 预览 + 上传新版本号（`x.y.z`，必须比线上大；失败不占版本号）。
