# 审计：WASM 单帧上限判据被 guest 预算"洗白"（2026-09-19）

**结论速览**：`TestServe_ResponseFrameTooLarge` 在 master 上的失败**不是实现缺陷**，而是
**夹具缺陷**：夹具在写出帧头之前先物化 2 MiB 的 JSON 响应信封，光这一步就要烧 1.2–2.4 s
的 guest CPU（实测），而该用例的 guest 预算是**墙钟** 3 s ⇒ 机器一有负载，guest 先把预算
烧完、被预算时钟杀掉，宿主的单帧判据**一个字节都还没读到**，结论被洗成 `RUNTIME_TIMEOUT`。
宿主的判据本身完全正确（probe 实测：guest 只写 9 字节长度前缀、载荷一字节不写，也照样
`RUNTIME_OUTPUT_OVERRUN`）。**无产品行为变化，不需要 DEVIATIONS 登记。**

- 影响文件（3 个，均为测试面）：
  - `server/internal/wasmapp/runtime/testdata/guests/app/main.go`（夹具 `/bigframe` + 新 `writeOversizedFrame`）
  - `server/internal/wasmapp/runtime/serve_test.go`（该用例补"预算内被发现"断言 + 两条同族用例的计时窗口修正）
  - `server/internal/wasmapp/runtime/helpers_test.go`（**TestMain 包级预热**，修掉 §8 的"懒编译落在计时窗口内"）
- 未改任何生产代码（`abi` / `runtime` / `limits` / `apperr` 全部原样）。

---

## 1. 现象

```bash
cd server && GOCACHE=/data/picoaide-harness/temp/go-build GOMODCACHE=/data/picoaide-harness/temp/gomodcache \
  GOPATH=/data/picoaide-harness/temp/gopath \
  go test ./internal/wasmapp/runtime -run 'TestServe_ResponseFrameTooLarge' -count=1 -v
```

```
=== RUN   TestServe_ResponseFrameTooLarge
    serve_test.go:468: 期望错误码 RUNTIME_OUTPUT_OVERRUN，实际 RUNTIME_TIMEOUT（应用超过了 3s 的 guest 预算）
--- FAIL: TestServe_ResponseFrameTooLarge (27.76s)
```

（`:468` 是改前 `requireKill` 所在行；该用例当时还没有"预算内被发现"的耗时断言。）

**复现条件（实测澄清）**：本机空载单跑**会通过**（18.7 s，其中 ~17 s 是 guest 模块懒编译），
只有在 **CPU 有竞争**时才失败。本机 `nproc=4`、`load average ≈ 27`（同机并行跑 Rust Porter）：

```
# 空载：PASS
# 起 8 个 CPU spinner 后再跑同一条命令：
=== RUN   TestServe_ResponseFrameTooLarge
    serve_test.go:468: 期望错误码 RUNTIME_OUTPUT_OVERRUN，实际 RUNTIME_TIMEOUT（应用超过了 3s 的 guest 预算）
--- FAIL: TestServe_ResponseFrameTooLarge (25.42s)
```

⇒ 用户侧"稳定失败"= 那台机器长期处于这种负载下；这不是 flake，而是**判据与夹具成本之间的
余量只有 ~2×，被负载吃掉**。

## 2. 判定链条复核（宿主侧全对）

| 环节 | 位置 | 复核结果 |
|---|---|---|
| 单帧上限值 | `abi/abi.go:48` `MaxFrameBytes = limits.ProtocolLineMaxBytes` = **1 MiB**（`limits.go:246`） | 与 §4.6 一致 |
| 总输出上限值 | `limits.go:244` `AppResponseBodyMaxBytes` = **8 MiB** | **>** 单帧上限 ⇒ 2 MiB 帧**不会**先撞总量闸门；单帧判据是本案唯一该命中的判据 |
| 判据本体 | `abi/abi.go:113` `ReadFrame` → `:150-151` `if n > MaxFrameBytes { return ErrFrameTooLarge }` | 只读 **9 字节**（RS + 十进制长度 + `\n`）即可判定，**不读载荷** |
| 判据 → 错误码 | `runtime/runtime.go:418-421`（`errors.Is(err, abi.ErrFrameTooLarge)` ⇒ `out.fatal = killError(CodeRuntimeOutputOverrun, "协议帧超过单帧上限 …")`） | 分支存在且会执行 |
| fatal 优先级 | `runtime.go:316-321`（有 fatal ⇒ `cancelGuest`）、`:338` `fatal := out.fatal` 优先于 `classifyGuestError` | 成立 |
| guest 分支 | 夹具 `case "/bigframe"`（`main.go:124`）确实被命中（宿主最终读到 RS + 长度前缀即证） | 不是 404/default 路径 |

**`out.fatal` 为什么是 nil**：`pump` 是在**读端出错/管道关闭**那条 `err != nil` 分支返回的
（`runtime.go:423-426`），此时 `out.fatal == nil`、`out.response == nil`；`runtime.go:332`
的 `clockExpired`（`clock.expired()`，`clock.go:71` 的 `time.AfterFunc` 回调已触发）为真 ⇒
`errors.go:54` 给出 `RUNTIME_TIMEOUT`。**宿主根本没看到那一帧的任何字节**——不是判据被绕过。

## 3. 根因机制（改前实测）

夹具原实现（`main.go:124-127` 改前）：

```go
case "/bigframe":
	big := strings.Repeat("C", 2<<20)
	respond(200, map[string]any{"big": big})
```

`respond` 必须**先把整个载荷 marshal 出来**才能调用 `writeFrame`（`main.go:309` / `:266`：
`writeFrame` 先写帧头再写载荷 —— 顺序本身没错，错在**帧头之前**的物化成本）。临时探针
guest（已删）逐阶段计时，wasm 内实测：

| 阶段 | 耗时 |
|---|---|
| `strings.Repeat("C", 2<<20)`（分配 2 MiB） | 14–47 ms |
| 内层 `json.Marshal({"big": …})` | **876–1190 ms** |
| 外层信封 `json.Marshal`（body 是内层 JSON 的转义文本） | **1031–1240 ms** |
| **合计（帧头写出之前）** | **2.0–2.4 s** |

而 guest 预算是**墙钟**：`served by testRequest`（`helpers_test.go:163`
`InstanceLimits{GuestBudget: 3 * time.Second}`）→ `guestClock`（`clock.go:67`
`time.AfterFunc`）。于是两条路径赛跑：

| 场景 | 预算 | 实测耗时 | 结论 | `Metrics.CPUMs` | `PeakMemory` |
|---|---|---|---|---|---|
| 空载 | 3 s | 1413 ms | OVERRUN ✅ | 1412 | 16 MiB |
| 空载 | 10 s | 1523 ms | OVERRUN ✅ | 1522 | 16 MiB |
| 空载 | 30 s | 1751 ms | OVERRUN ✅ | 1750 | 16 MiB |
| **+8 spinner** | **3 s** | **3006 ms** | **TIMEOUT ❌** | 3006 | 13.9 MiB |
| +8 spinner | 10 s | 4027 ms | OVERRUN ✅ | 4026 | 16 MiB |
| +8 spinner | 30 s | 3161 ms | OVERRUN ✅ | 3160 | 16 MiB |

即：**判据是对的，触发它的成本（造帧）与预算同量级**；机器一慢，预算先到点。
（`PeakMemory` 也印证：13.9 MiB 那次死在"内存还没长到能装下整帧"的中途。）

**反证（判据只依赖长度前缀）**：让临时探针 guest **只写 9 字节帧头**（声明 2 MiB）、
**载荷一字节不写**就退出：

```
[probe] header-only: code=RUNTIME_OUTPUT_OVERRUN respSize=0 msg="协议帧超过单帧上限 1 MiB"
```

⇒ 宿主 `ReadFrame` 读到长度前缀即判超限；夹具根本不需要写出载荷，更不需要物化它。

## 4. 为什么其他用例没抓到

1. **`/flood`（`TestServe_OutputOverrun`，通过）**：直接 `os.Stdout.Write(2 MiB 'A')`，
   没有"造帧"成本（帧头概念都不存在），走的是 `ErrNotFrame → readLogLine tooLong`
   （`runtime.go:401-416`）这条**另一条判据**；实测 0.3–0.9 s，与它的 5 s 预算余量充足。
2. **`/spam`（总量上限，通过）**：写 8193 行 1 KiB 日志，实测 0.1–0.25 s，8 s 预算。
3. **本用例是三条"超限判据"里唯一没有"预算内被发现"断言的**（另两条有：
   改前 `serve_test.go:442-444` / `:455-457`，改后因注释/hoist 顺移到 `:446-448` / `:462-464`），
   所以夹具贵了 2 秒也没人拦。
4. **CI 跑的是整包**（`go test -p 1 ./...`），机器相对空闲、且 3 s 预算对空载的 1.4 s
   还有余量 ⇒ 长期无声通过；只有"单跑 + 有负载"才暴露。

## 5. 修法（最小、保留语义）

### 5.1 夹具：先写帧头，再分块流式写载荷（`testdata/guests/app/main.go:124-126` + 新增 `:335` `writeOversizedFrame`）

`writeOversizedFrame()` 写出的仍是**逐字节合法的响应信封**（长度前缀 = 实际载荷字节数 =
`2<<20`；`json.Unmarshal` 可解、`body` 可再解出内层 JSON —— 已用脚本对拍），只是不再
一次性物化：帧头 9 字节 → 头部 79 字节 → 64 KiB 分块 `'C'` → 尾部 5 字节。宿主读到长度
前缀就判超限并杀掉实例，后续写失败（管道被关）**是预期结局**，夹具静默返回。

### 5.2 用例：补上与两条同族判据一致的断言（`serve_test.go:464-498`，函数体 `:480-498`）

- 显式 `const budget = 3 * time.Second`（与另两条同款写法，数值与 `testRequest` 缺省一致）；
- **模块/运行时在计时窗口之外取好**（`appModule` 是包级懒编译，首次 ~10–20 s；放进计时
  窗口会让"-run 单跑"把编译时间算成 guest 耗时。包级修法见 §8）；
- 追加 `elapsed > budget ⇒ t.Fatalf("单帧超限应在预算内被发现")`。

断言只增不减：`requireKill(..., CodeRuntimeOutputOverrun)` 与 `"单帧上限"` 文案断言原样保留。

### 5.3 同族修正（同文件，2 行 × 2 处）

`TestServe_OutputOverrun`（`:435`）与 `TestServe_TotalOutputOverrun`（`:452`）把
`appModule(t)` 留在计时窗口内 ⇒ **单跑必红**（实测：19.6 s 编译被算成"超限耗时"，
`-count=2` 的第二跑才 0.72 s 绿）。已按同款修正（计时前取模块）；同类问题的**包级**
修法见 §8。

## 6. 验证证据（第一轮：只修夹具/断言，尚未引入 §8 的 TestMain 预热）

> §8 引入 TestMain 预热后，首跑的模块懒编译不再落进任何用例，实测耗时更短；
> **最终态数据以 §8.3 为准**。

**改前（8 spinner 下，用户命令原样）**：`FAIL … 实际 RUNTIME_TIMEOUT（应用超过了 3s 的 guest 预算）(25.42s)`

**改后**：

```
# 1) 目标用例 ×3（空载，同一进程内连跑）
=== RUN   TestServe_ResponseFrameTooLarge
--- PASS: TestServe_ResponseFrameTooLarge (17.95s)   # 首跑含模块懒编译
--- PASS: TestServe_ResponseFrameTooLarge (0.08s)
--- PASS: TestServe_ResponseFrameTooLarge (0.05s)
PASS  ok  … 18.162s

# 2) 目标用例 ×3（8 spinner 负载下）
--- PASS: TestServe_ResponseFrameTooLarge (17.65s)
--- PASS: TestServe_ResponseFrameTooLarge (0.13s)
--- PASS: TestServe_ResponseFrameTooLarge (0.14s)
PASS  ok  … 18.021s

# 3) 三条超限判据各自单跑（-run 单跑模式）
--- PASS: TestServe_OutputOverrun (15.28s)
--- PASS: TestServe_TotalOutputOverrun (13.06s)
--- PASS: TestServe_ResponseFrameTooLarge (12.59s)

# 4) 整包（探针文件删除前后各跑一次，均绿）
ok  github.com/picoaide/picoaide/internal/wasmapp/runtime  133.118s   # 含临时探针时
ok  github.com/picoaide/picoaide/internal/wasmapp/runtime   72.903s   # 探针删除后的最终态

# 4b) 最终态（探针已删）目标用例 ×3
--- PASS: TestServe_ResponseFrameTooLarge (8.52s)   # 首跑含模块懒编译
--- PASS: TestServe_ResponseFrameTooLarge (0.06s)
--- PASS: TestServe_ResponseFrameTooLarge (0.04s)

# 5) go vet ./internal/wasmapp/...  → 无输出（exit 0）
#    gofmt -l internal/wasmapp/     → 空
```

**判据触发耗时（改后，探针实测；探针文件已删）**：空载 44–114 ms、8 spinner 下 61–119 ms
（改前 1413–4027 ms），`PeakMemory` 16 MiB → **4 MiB**（不再物化整帧的旁证），
错误码与文案不变：`RUNTIME_OUTPUT_OVERRUN / "协议帧超过单帧上限 1 MiB"`。

## 7. 影响面

- **生产代码零改动**：`abi` / `runtime` / `limits` / `apperr` 行为一字未变；协议、错误码、
  文案、上限值全部不动 ⇒ 对外契约无变化。
- 只有测试面：`server/internal/wasmapp/runtime/{serve_test.go, helpers_test.go, testdata/guests/app/main.go}`。
- 用例变**更快**（判据触发从 1.4 s → ~50 ms）且不再依赖机器空闲。
- **Rust 移植提示（不构成 deviation）**：Rust 侧的等价夹具**必须**先写长度前缀、再流式写
  载荷；若照抄"先 `json.Marshal` 2 MiB 再写"，同一条用例会在负载下复现同一个 TIMEOUT。
  由于 Go 侧行为是正确的（判据、错误码、文案都在 Go 侧已核对），**无需在
  `server-rs/DEVIATIONS.md` 登记 A 类**。

## 8. 追加修复：惰性 guest 编译落在计时窗口内（2026-09-19 第二轮，用户拍板后实施）

### 8.1 改前实测（问题）

本包 `appModule(t)` 是**包级懒编译**（guest `go build` + wazero 对 3.4 MiB 模块的冷编译），
而多条"耗时必须接近预算"的断言把 `serveCompiled(t, sharedRuntime(t), appModule(t), req)`
**整行放在 `start := time.Now()` 之后** ⇒ 冷编译被算成 guest 耗时 ⇒ **`-run` 单跑必红**
（CI 只跑整包，被前面的用例预热过 ⇒ 缺陷长期不可见）。改前逐条单跑：

| 用例 | 改前单跑 | 断言/预算 |
|---|---|---|
| `TestServe_InfiniteLoopTimeout` | FAIL (13.2s) | `elapsed > budget+3s`（budget 0.7s） |
| `TestServe_HostCallOverBudgetIgnoringCtx` | FAIL (10.5s) | `elapsed > 1200ms` |
| `TestServe_ResponseThenLingerIsConclusive` | FAIL (8.8s) | `elapsed >= 500ms` |
| `TestServe_TimeoutWhileGuestBlockedOnRead` | FAIL (9.2s) | `elapsed > budget+3s` |
| `TestServe_CallerCancel` | FAIL (10.8s) | `elapsed > 3s` |
| `TestServe_OutputOverrun` / `TestServe_TotalOutputOverrun` | FAIL（§5.3 已修） | `elapsed > budget` |
| `TestServe_RawWasmInfiniteLoopTimeout` | PASS (0.55s) | 用手写 wasm，无懒编译 |

### 8.2 修法（结构不变量，而不是逐处打补丁）

`helpers_test.go` 新增 `warmUpGuestFixture()`，在 `TestMain` 里 **`m.Run()` 之前**付掉三笔
一次性开销：

1. guest 现场编译（`GOOS=wasip1 go build`，实测 **1.56 s**）；
2. wazero **冷编译** 3.4 MiB 模块（实测合计 ~15 s，慢机器/有负载时更长）；
3. **一次真实 `/ok` 请求**（首次实例化 + guest 侧 Go 运行时启动 + 页错误/分配器预热）——
   与 `TestServe_NanosleepDoesNotBurnCPU` 早就手写的那次预热同一口径（`nanosleep_test.go:28-30`）。

配套重构：把 `guestBinary(t, pkg)` / `sharedRuntime(t)` 拆出**无 `*testing.T`** 的
`guestBinaryBytes(pkg) ([]byte, error)` / `newSharedRuntime() (*Runtime, error)`
（`TestMain` 里没有 `*testing.T`，失败只能靠返回值 + `os.Exit(1)`；临时目录仍走
`os.MkdirTemp` + 既有 `sync.Once`，并发用例安全）。预热失败 **fail-loud**（`os.Exit(1)`），
不静默降级。

不变量写进了注释：**任何计时窗口里都不得包含一次性开销**；§5.2/§5.3 里那三处显式
hoist 保留（让用例本身不依赖预热顺序，双保险）。

**代价（认账）**：冷编译从"首个 guest 用例内部"移到 `TestMain`，**整包总时长不变**；
但**任何单跑**（包括 `-run '^$'` 与纯单测）现在都要先付这 ~16 s（其中 `go build` 1.56 s）。
换取的是"计时断言永远不含一次性开销"这条不变量在所有当前/未来用例上自动成立。
若不接受这个代价，可退回"逐处 hoist"（§5.2 口径），但新用例可能再次踩坑且 CI 看不见。

### 8.3 验证（空载 + 8 spinner 负载，逐条单跑 + 整包）

```
# 空载：9/9 PASS（耗时=断言实测值 / 上界）
TestServe_InfiniteLoopTimeout            706ms / 3.7s    PASS
TestServe_HostCallOverBudgetIgnoringCtx  284ms / 1200ms  PASS
TestServe_ResponseThenLingerIsConclusive  54ms / 500ms   PASS
TestServe_TimeoutWhileGuestBlockedOnRead 604ms / 3.6s    PASS
TestServe_CallerCancel                   PASS
TestServe_OutputOverrun                  0.42s / 5s      PASS
TestServe_TotalOutputOverrun             0.13s / 8s      PASS
TestServe_ResponseFrameTooLarge          0.07s / 3s      PASS
TestServe_NanosleepDoesNotBurnCPU        CPU 19ms / 上限 110ms  PASS

# 8 spinner 负载下：同样 9/9 PASS
TestServe_InfiniteLoopTimeout            701ms / 3.7s    PASS
TestServe_HostCallOverBudgetIgnoringCtx  293ms / 1200ms  PASS
TestServe_ResponseThenLingerIsConclusive  56ms / 500ms   PASS
TestServe_TimeoutWhileGuestBlockedOnRead 601ms / 3.6s    PASS
TestServe_CallerCancel                   PASS
TestServe_OutputOverrun                  0.66s / 5s      PASS
TestServe_TotalOutputOverrun             0.22s / 8s      PASS
TestServe_ResponseFrameTooLarge          0.20s / 3s      PASS
TestServe_NanosleepDoesNotBurnCPU        CPU 11ms / 上限 107ms  PASS

# 整包（8 spinner 负载下）
ok  github.com/picoaide/picoaide/internal/wasmapp/runtime  139.150s
```

**余量结论（用户要求的"额外判据"）**：负载下最紧的一条是
`TestServe_HostCallOverBudgetIgnoringCtx`（293ms vs 1200ms，**4.1×**），其余均 ≥6×，
`/bigframe` 现在 0.20s vs 3s（15×）。**没有发现别的"余量设计不足"用例** —— 唯一一条
确实设计不足的就是 `/bigframe`，已按"改夹具、不动断言"的口径修掉（§5.1）。负载下整包也稳。

### 8.4 移植提示

Rust 侧同样有"首次编译/首次实例化"开销：把 `OnceLock<CompiledModule>`（或等价物）的
预热放在测试框架的全局 setup 里，**不要留在任何 `Instant::now()` 计时窗口内**；
Rust 的时间断言同样要与"一次性开销"解耦。

## 9. 复现与回归命令（供后续复核）

```bash
cd server && export GOCACHE=/data/picoaide-harness/temp/go-build \
  GOMODCACHE=/data/picoaide-harness/temp/gomodcache GOPATH=/data/picoaide-harness/temp/gopath

# 判据必须命中（负载下同样稳定）
go test ./internal/wasmapp/runtime -run 'TestServe_ResponseFrameTooLarge' -count=3 -v
# 想人为造负载（复现改前失败）：for i in $(seq 1 8); do (while :; do :; done) & done

# 整包 + 静态检查
go test ./internal/wasmapp/runtime -count=1
go vet ./internal/wasmapp/... && gofmt -l internal/wasmapp/
```
