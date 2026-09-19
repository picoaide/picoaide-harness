# 导入面白名单（`wasi_snapshot_preview1`）

> **本文件是生成产物，不要手改**（改了平台行为不会变，只会让门禁变红）。
>
> 重新生成：`cd server && go run ./cmd/picoaide-wasm-imports-gen`
> 比对模式（门禁，不一致即非零退出）：`cd server && go run ./cmd/picoaide-wasm-imports-gen -check`
>
> 平台侧真源：`server/internal/wasmapp/wasmmod/imports_gen.go`（同一生成器的另一份产物）。

## 这张表是什么

发布预检会逐条校验 wasm 的**导入段**：只有下表里的 (模块, 符号, 类型) 才放行。
不在表里的符号 → 422 `IMPORT_NOT_ALLOWED`；符号在表里但类型不符 → 422 `IMPORT_SIGNATURE_MISMATCH`。
错误信封的 `details.symbol` 点名**第一个**出问题的导入（形如 `wasi_snapshot_preview1.path_open`），
`details.expected` / `details.actual` 给出类型差异，`hints` 给出通用改法。

表里只有一个模块名：`wasi_snapshot_preview1`（`wasm32-wasip1` 的 WASI 预览 1）。
`env.*` / `js.*` / `wasi_unstable` / 组件模型命名空间一律不放行。

⚠️ 这里列的是 **WASI 导入**，不是平台能力：`db.*` / `ai.chat` / `log` / `assets.read`
走的是 stdin/stdout 上的 JSON-RPC，根本不经过导入段（见 `references/abi.md`）。

## 为什么这是「保守超集」

白名单的语义是「**Go 的 `wasip1` 运行时可能发出的全部 WASI 导入**」，不是「参考实现恰好用到的那些」：
它由多个参考程序的真编译产物取**并集**生成（逐份条数记在 `imports_gen.go` 头部）。原因：

- **少一条 = 功能缺陷。** 一行 `os.Stat` 会引入 `path_filestat_get`，`html/template` 的
  `Execute`（渲染页面）会引入 `sock_accept` / `sock_shutdown`，`(*os.File).ReadAt` /
  `WriteAt` 会引入 `fd_pread` / `fd_pwrite`。名单窄了，**合法应用会在发布预检被拒** ——
  而它在本机编译、自测都是好的（审计实测过的功能缺陷，不是理论风险）。
- **多一条 ≠ 放开红线**，因为两条红线都不由这张表保证：
  - **读不到宿主文件**：运行期**零 preopen** —— 没有任何预打开目录时，`path_open` /
    `fd_readdir` 这类调用拿不到可用的描述符（失败，不是「没有实现」）；
  - **出不了网**：预览 1 里没有 `sock_open` / `sock_bind` / `sock_listen` / `sock_connect`，
    自造不出 socket 描述符；表里的 `sock_accept` / `sock_shutdown` 是 Go 运行时自己发起的
    等待与收尾调用，同样拿不到监听描述符。

所以「表里有 `path_open`」不等于「能读文件」，「表里有 `sock_accept`」不等于「能联网」：
真正被拒的是**能造出描述符的那几个符号**与非 `wasi_snapshot_preview1` 的模块。

## 撞到 `IMPORT_NOT_ALLOWED` 怎么办

1. **先看它点名了哪个符号**：`details.symbol`（连同 `details.name` / `details.signature`）就是第一个
   不被放行的导入。失败的发布**不占版本号**，改完重发即可。
2. **对照本表**：
   - 表里没有这个符号 → 它属于平台刻意不放行的一类：不要引入依赖它的库或运行时
     （例如需要 socket 的网络客户端），平台能力一律走 stdin/stdout 上的 JSON-RPC
     （`db.*` / `ai.chat` / `log` / `assets.read`）；
   - 表里有、但报的是 `IMPORT_SIGNATURE_MISMATCH` → 类型不符：按 `references/abi.md` §2 的
     读帧/写帧样板重写，并确认编译目标是 `wasm32-wasip1`（Go：`GOOS=wasip1 GOARCH=wasm`）。
3. **不要自己往名单里加符号**：`imports_gen.go` 与本文档都是生成产物，手写即门禁红；
   扩面必须改参考程序并重跑生成器。
4. **如果它是「合法 Go 代码必然会发出」的符号**（例如某个标准库路径带来的新导入）：那是平台的
   覆盖面缺陷，不是你写错了 —— 把最小复现（一小段能编译的 Go 代码 + 报错里的 `details.symbol`）
   交给平台管理员，由他们扩面后重新生成这一份文档。

## 符号与签名

签名格式：形参类型短名串 + "_" + 结果类型短名串（i32/i64/f32/f64/v128/funcref/externref；例：fd_write(i32,i32,i32,i32)->i32 = "i32i32i32i32_i32"；无结果如 "i32_"；无参无结果 "_"）

| 模块 | 符号 | 种类 | 签名 | 为什么放行 |
| --- | --- | --- | --- | --- |
| `wasi_snapshot_preview1` | `args_get` | func | `i32i32_i32` | Go 运行时启动时读命令行参数（平台不传 args，读到的是空） |
| `wasi_snapshot_preview1` | `args_sizes_get` | func | `i32i32_i32` | 同上：参数长度的查询（Go 运行时启动路径的一部分） |
| `wasi_snapshot_preview1` | `clock_time_get` | func | `i32i64i32_i32` | `time.Now` 等时间读取（平台注入真实墙钟） |
| `wasi_snapshot_preview1` | `environ_get` | func | `i32i32_i32` | Go 运行时启动时读环境变量（平台不传 env，读到的是空） |
| `wasi_snapshot_preview1` | `environ_sizes_get` | func | `i32i32_i32` | 同上：环境变量长度的查询（Go 运行时启动路径的一部分） |
| `wasi_snapshot_preview1` | `fd_close` | func | `i32_i32` | 关闭描述符（defer f.Close() 的收尾） |
| `wasi_snapshot_preview1` | `fd_fdstat_get` | func | `i32i32_i32` | 取描述符状态（os 包在 `Fd()` / 终端判断路径上会问） |
| `wasi_snapshot_preview1` | `fd_fdstat_set_flags` | func | `i32i32_i32` | 设置描述符标志（Go 运行时给非阻塞 IO 用的那一手） |
| `wasi_snapshot_preview1` | `fd_filestat_get` | func | `i32i32_i32` | `(*os.File).Stat`（对已有描述符取状态） |
| `wasi_snapshot_preview1` | `fd_filestat_set_size` | func | `i32i64_i32` | `(*os.File).Truncate` |
| `wasi_snapshot_preview1` | `fd_pread` | func | `i32i32i32i64i32_i32` | `(*os.File).ReadAt`（`html/template` 的部分渲染路径会用到） |
| `wasi_snapshot_preview1` | `fd_prestat_dir_name` | func | `i32i32i32_i32` | 同上：取预打开目录的名字 |
| `wasi_snapshot_preview1` | `fd_prestat_get` | func | `i32i32_i32` | 枚举预打开目录（零 preopen ⇒ 一个都枚举不到） |
| `wasi_snapshot_preview1` | `fd_pwrite` | func | `i32i32i32i64i32_i32` | `(*os.File).WriteAt` |
| `wasi_snapshot_preview1` | `fd_read` | func | `i32i32i32i32_i32` | 从 stdin 读请求帧（帧协议的硬要求：不读 stdin 就收不到任何请求） |
| `wasi_snapshot_preview1` | `fd_readdir` | func | `i32i32i32i64i32_i32` | `os.ReadDir` / `filepath.WalkDir` / `RemoveAll` 的遍历 |
| `wasi_snapshot_preview1` | `fd_seek` | func | `i32i64i32i32_i32` | `(*os.File).Seek` |
| `wasi_snapshot_preview1` | `fd_sync` | func | `i32_i32` | `(*os.File).Sync` |
| `wasi_snapshot_preview1` | `fd_write` | func | `i32i32i32i32_i32` | 把响应帧写到 stdout |
| `wasi_snapshot_preview1` | `path_create_directory` | func | `i32i32i32_i32` | `os.Mkdir` / `os.MkdirAll` |
| `wasi_snapshot_preview1` | `path_filestat_get` | func | `i32i32i32i32i32_i32` | `os.Stat` / `os.Lstat`、`MkdirAll` 的逐级检查 |
| `wasi_snapshot_preview1` | `path_filestat_set_times` | func | `i32i32i32i32i64i64i32_i32` | `os.Chtimes` / `os.Chtimes` 系的写时间戳 |
| `wasi_snapshot_preview1` | `path_open` | func | `i32i32i32i32i32i64i64i32i32_i32` | `os.Open` / `os.Create` / `os.OpenFile`（零 preopen 下失败，不是「没有实现」） |
| `wasi_snapshot_preview1` | `path_readlink` | func | `i32i32i32i32i32i32_i32` | `os.Readlink` / `filepath.EvalSymlinks` |
| `wasi_snapshot_preview1` | `path_remove_directory` | func | `i32i32i32_i32` | `os.Remove` / `os.RemoveAll` 删目录的那一步 |
| `wasi_snapshot_preview1` | `path_rename` | func | `i32i32i32i32i32i32_i32` | `os.Rename`（安装型/临时文件的常见写法） |
| `wasi_snapshot_preview1` | `path_symlink` | func | `i32i32i32i32i32_i32` | `os.Symlink`（连同下面的 readlink 都是 os 包文件面的一部分） |
| `wasi_snapshot_preview1` | `path_unlink_file` | func | `i32i32i32_i32` | `os.Remove` / `os.RemoveAll` |
| `wasi_snapshot_preview1` | `poll_oneoff` | func | `i32i32i32i32_i32` | `time.Sleep` / 定时等待（Go wasip1 用它实现睡眠） |
| `wasi_snapshot_preview1` | `proc_exit` | func | `i32_` | guest 退出（Go 运行时的致命错误与正常收尾都会走它） |
| `wasi_snapshot_preview1` | `random_get` | func | `i32i32_i32` | `crypto/rand` / `math/rand` 的随机源（平台注入真实随机源） |
| `wasi_snapshot_preview1` | `sched_yield` | func | `_i32` | 调度让出（Go 运行时在自旋/等待路径上发出） |
| `wasi_snapshot_preview1` | `sock_accept` | func | `i32i32i32_i32` | `html/template` / `text/template` 的 `Execute`（渲染页面）会带出它；它只能从**已监听**的描述符接连接，而平台里没有任何途径造出这种描述符 |
| `wasi_snapshot_preview1` | `sock_shutdown` | func | `i32i32_i32` | 模板渲染路径的收尾调用；描述符不存在 ⇒ 直接失败，不构成出站途径 |

本次生成：并集 34 (module, name, kind, signature)，符号、签名与说明均出自同一生成器。
