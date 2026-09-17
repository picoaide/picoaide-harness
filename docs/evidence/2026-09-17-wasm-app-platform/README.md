# WASM 应用平台 · 设计证据探针（2026-09-17）

这些探针是 `docs/planning/2026-09-17-wasm-app-platform.md` 里若干**设计判断的复跑载体**：探针本身就是证据，
不是产品代码、不接 CI、不随发布产物分发。每个目录都能独立复跑，输出应与下面的记录一致。

- 环境锚定：Go 1.26.5 · wazero **v1.12.0** · modernc.org/sqlite **v1.55.0**（`vacuum-into` 另在 v1.59.0 复核）· Linux/amd64 · 4 vCPU。
- 需要一份**已填充的 Go 模块缓存**（本仓 `temp/` 下的临时缓存被 `.gitignore` 忽略，不随仓库分发）：
  `GOMODCACHE=<任一已填充的模块缓存> GOPROXY=off go run .`
- 时间数字是虚拟机上的量级参考，**判据是 HIT/MISS 与条目名，不是毫秒数**。

---

## 1. `cache-key/` — 编译缓存的键敏感性（设计 §4.3.1）

**问题**：编译进程与执行进程的 `RuntimeConfig` 不一致时，`wazero.NewCompilationCacheWithDir` 的磁盘缓存还会命中吗？
**结论**：**只有 `WithCloseOnContextDone` 进键**（`runtime.go:261` → `wasm.Module.AssignModuleID` → `sha256(moduleID ‖ magic ‖ CPU features)`），
`WithMemoryLimitPages` **不进键**。配置不一致 = 发布期编译暖不到执行进程，且同一模块落两份条目。

```bash
# 配置 → 缓存条目的映射（每个变体一个空目录）
go run . <module.wasm> <cache-dir> plain   # 也接受 close | mem | both

# 空目录 → 冷编译 → 四种配置轮流读（HIT/MISS 自动标注）
go run . <module.wasm> <cache-dir>
```

实测（2.76 MB Go wasip1 模块；`both` = `close`+`mem`）：

```
$ go run . probe.wasm /tmp/ev-cache plain
module: probe.wasm (2756778 bytes, sha256 78022d1a…)
variant=plain first-compile=960ms
  entry 429b279e95ec4ea377a69f1d898a009dd519708848b884a830fb8c75d5aead58 (10062184 bytes)

$ go run . probe.wasm /tmp/ev-cache close  → entry 68689fd709b1cc5d82e14af5d9d4de6e57585013a024e09a48912ea314aeb96e (10512524 bytes)
$ go run . probe.wasm /tmp/ev-cache mem    → entry 429b279e95ec4ea377a69f1d898a009dd519708848b884a830fb8c75d5aead58 (10062184 bytes)
$ go run . probe.wasm /tmp/ev-cache both   → entry 68689fd709b1cc5d82e14af5d9d4de6e57585013a024e09a48912ea314aeb96e (10512524 bytes)

$ go run . probe.wasm /tmp/ev-cache-m
== empty cache dir matrix-plain ==
   reader=plain    948ms cold (entries=1)
   reader=close    948ms MISS (entries=2)      ← WithCloseOnContextDone 不一致 ⇒ 换键
   reader=mem       34ms HIT  (entries=2)      ← 只改内存上限 ⇒ 仍命中
   reader=both      34ms HIT  (entries=2)      ← 命中 close 刚写的那一份
== empty cache dir matrix-close ==   （其余三个目录逐行相同，不再重复）
   reader=plain    968ms cold (entries=1)
   reader=close    985ms MISS (entries=2)
   reader=mem       33ms HIT  (entries=2)
   reader=both      33ms HIT  (entries=2)
```

支撑：§4.3.1 a/b（两侧 `RuntimeConfig` 一致 + 键的可复用前提）、§15.2「编译缓存键敏感性 / 收益与体积」、§11 第 11 项。

## 2. `random-get/` — 默认随机源（设计 §4.3、§15.1 第 1 条）

**问题**：不注入随机源时，wazero 给 guest 的 `random_get` 是"全零"还是别的？
**结论**：是 `platform.NewFakeRandSource()` = `math/rand` **固定种子 42** 的伪随机——**三个独立 Runtime 的序列完全相同**，
时钟固定为 2022-01-01。比"全零"更隐蔽：作者本地看着"每次都在变"，线上每个用户拿到的"随机"值却相同。

```bash
bash run.sh      # 先以 GOOS=wasip1 编译 guest，再跑宿主对照
```

```
--- A) default ModuleConfig (no WithRandSource) ---
[runtime 1] random_get  -> dfd79b4d76429b61   second call -> 7a0c9f9f0d3ba55b   walltime -> 2022-01-01T00:00:00Z
[runtime 2] random_get  -> dfd79b4d76429b61   second call -> 7a0c9f9f0d3ba55b   walltime -> 2022-01-01T00:00:00Z
[runtime 3] random_get  -> dfd79b4d76429b61   second call -> 7a0c9f9f0d3ba55b   walltime -> 2022-01-01T00:00:00Z
--- B) WithRandSource(rand.Reader) + real clocks ---
[runtime 1] random_get  -> c551f11a8e0d9908   walltime -> 2026-09-17T08:46:04Z
[runtime 2] random_get  -> f80547d754a1e8df   walltime -> 2026-09-17T08:46:06Z
```

支撑：§4.3 随机源、§15.1 第 1 条；验收判据按 §10.2 第 21 项——**断言两次独立实例序列不同，而不是"非全零"**。

## 3. `vacuum-into/` — `VACUUM INTO` 与 `SQLITE_LIMIT_ATTACHED`（设计 §4.5、§15.1 第 5 条）

**问题**：`VACUUM INTO` 是"独立于 ATTACH 的任意文件写原语"，还是同样受 `SQLITE_LIMIT_ATTACHED` 约束？
**结论**：**同受约束**。`=0` 时 ATTACH 与 `VACUUM INTO` 一起被拒、目标文件不生成；去掉限额即可写文件。
⇒ 真正的闸门是"**每条连接重设 `LIMIT_ATTACHED=0`**"，语句白名单里禁 `VACUUM INTO` 是纵深（限制漏设时二者会同时复活）。

```bash
go run .
# 换驱动版本复核：go mod edit -require=modernc.org/sqlite@v1.59.0 && go mod tidy && go run .
```

```
modernc.org/sqlite embedded SQLite version: 3.53.3

[LIMIT_ATTACHED=-1] VACUUM INTO -> err=<nil> ; target exists=true (8192 bytes)
[LIMIT_ATTACHED=-1] ATTACH      -> err=<nil>

[LIMIT_ATTACHED=0] set (previous value 10, err=<nil>)
[LIMIT_ATTACHED=0] VACUUM INTO -> err=SQL logic error: too many attached databases - max 0 (1) ; target exists=false
[LIMIT_ATTACHED=0] ATTACH      -> err=SQL logic error: too many attached databases - max 0 (1)
```

v1.59.0（SQLite 3.53.4）逐行相同。

---

## 未入库的探针

§14/§15.2 仍引用一批**本地**探针（`temp/wasm-audit2-sql/` SQLite 限额语义、`temp/wasm-audit2-mem/` 内存与导入面、
`temp/wasm-redteam/` 签名/自定义段/内存声明、`temp/wasm-feas/` 三语言工具链与 Node WASI）。它们在作者工作区可复跑，
但 `temp/` 被 `.gitignore` 忽略 ⇒ 对任何 clone 都不可见。收敛入库的要求见设计 §11 第 23 项。
