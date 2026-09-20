# `pack-assets.mjs` —— 把静态资源编进 wasm（官方打包器）

平台支持把 HTML / CSS / JS / 图片 / 字体等文件**编进 wasm 模块**，作为随包静态资源：
发布后它们随版本一起进内存资源集（**不落盘**）：应用自己用 `assets.read("index.html")` 读，
任何能打开应用的人也能直接 `GET /index.html` 拿到（非保留资源会被直出，这是静态响应能被
缓存的原因）。

这件事需要往 wasm 的**自定义段**里写字节：段名 = 包内逻辑路径，段长度前缀是 LEB128，
而且**必须包含段名的长度前缀与段名本身**。这一条最容易踩（手写漏了它，平台回
`SECTION_MALFORMED`，错误只指向文件里的某个偏移）。本目录的脚本就是官方实现：

```bash
# 1) 先按 publishing.md 的固定步骤编译（GOOS=wasip1 GOARCH=wasm）
# 2) 再把资源追加进一个**新文件**（绝不就地覆盖输入）
node pack-assets.mjs --in shared-notes.wasm --out dist/shared-notes-packed.wasm \
  web/index.html=index.html \
  web/app.css=static/app.css \
  web/logo.png=static/logo.png
```

- `--in`：已编译好的 wasm。脚本不碰它的任何既有字节，只在末尾追加自定义段。
- `SRC=DEST`：`SRC` 是磁盘上的文件，`DEST` 是**包内逻辑路径**（也就是段名）。
  可以重复；也可以写成 `--asset SRC=DEST`。想把整个目录塞进去就逐个文件写清楚。
- `--out`：**必填**，必须是一个新路径 —— 脚本拒绝与 `--in` 同一个文件（原模块要留着继续编译/
  重打包；顺带一提，`go build -o 已存在文件` 不会截断旧文件、会留尾部垃圾，编译产物也别就地覆盖）。

成功时它会打印每个段的字节数与「自定义段总量 / 上限」。

## 不能这样加的

- **`picoaide.app.json` 是平台保留资源**：它由平台在发布期写入（内容 = 你随包提交的
  `config`），模块里的同名段会被平台忽略。脚本直接拒 —— 要放名单就写进 `config` 的
  `whitelist`，**不要**放进这种会被直出的非保留资源。
- **工具链元数据段名**（`name` / `producers` / `go:buildid` …）：平台按元数据分流，
  不会成为资源。脚本直接拒，避免"明明加了却悄悄没有"。
- **改资源内容 = 发新版本**：路径就是段名，发布期抽取只写一次；想覆盖同名资源请发新版。

## 规则（与平台同源）

- 路径是**相对**的、以 `/` 分隔、不含 `..` 与 `:`；整条路径不超过 256 字节、单段不超过 255 字节。
- 自定义段总量不超过 4 MiB（口径 = 各段负载之和，含段名的长度前缀与段名；Go 产物自带的
  `name` 段也计入）。
- 模块本身不超过 32 MiB；超限的报错码是 `SECTION_OVERRIDE_OVERSIZE` / `WASM_TOO_LARGE`。
- 脚本零外部依赖：只用 Node 内置模块（企业环境常常离线，别指望 `npm install`）。

## 它凭什么可信

平台侧的解析、路径规则、总量口径都在服务端实现里，脚本是它们的**同源复刻**（脚本头部
注释逐个写明了对应的 Go 符号与文件）。仓库里的门禁用平台自己的解析器断言脚本的产出：

```bash
cd server && go test ./internal/wasmapp/wasmmod -run PackAssets -v
```

断言的是行为而不是文本：真编译一个 Go wasm → 真跑脚本 → `wasmmod.Validate` 必须接受、
`ExtractCustomSections` 必须按路径取到**逐字节一致**的内容、保留资源必须被拒、
非法输入必须报错可读。
