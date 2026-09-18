package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/hostcap"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// 本文件是 §6.2 的**同步发布链路**（R30）与 §4.2 的预检（validate）。
//
// 两件事在这里同时定死：**顺序**与**失败时的回滚**。
//
// 顺序（选它的理由见"为什么把全部文件系统工作放在落库之前"）：
//
//	A 纯校验      identity → app_id → 体积 → 静态(导入/导出/段表/体积) → appcfg
//	B 编译        临时文件 → Compiler.Compile（真编译，60 s 预算）
//	C 抽取        ExtractCustomSections → 写进 **staging 目录**（仍未落库）
//	D 干跑        合成帧 Instantiate → _start → 响应帧（2 s 预算）
//	E 占名落行    UpsertWasmApp → 复读归属 → CreateWasmRelease（拿到 release_id）
//	F 原子改名    staging → assets/<release_id>（同一父目录，单次 rename）
//	G 投影        SetWasmAppConfig → （非待审时）SetWasmAppCurrentRelease
//	H 收尾        审计 → 版本 GC（保留 3 版，顺带清掉被回收版本的资源目录）
//
// **为什么把全部文件系统工作放在落库之前**：R18 的判据是"失败的发布不占版本号"。
// 磁盘写失败（满、权限、只读挂载）是这条链路上**最可能**的失败，把它排在落库之前
// 意味着这类失败留下一行都没有；反之（先落行再抽资产）就必须靠删行来补偿，
// 而删行一旦也失败，就会留下"版本号被一个失败版本永久占用"的状态。
//
// 落库之后只剩一次同父目录的 rename（同文件系统、原子）与两次 UPDATE。它们真失败时
// 走 compensate()：删目录 + 软删刚建的 release 行 + 恢复原来的 current_release_id，
// 并把错误如实回给调用方（含"该版本号已占位"的提示）。**不硬删行**：本包不做数据
// 访问（DAO 在 serverstore），而"软删行仍在 ⇒ 版本号仍占位"是平台既有语义（§4.1）。

// uploadPayload 是上传载荷（§4.2/R21）。
//
// 端点同构：validate 不要求 version/changelog，publish 要求（`:app_id` 也可以由
// 路径给出；body 里给了就必须与路径一致）。
type uploadPayload struct {
	AppID      string          `json:"app_id"`
	Version    string          `json:"version"`
	Title      string          `json:"title"`
	Changelog  string          `json:"changelog"`
	WasmBase64 string          `json:"wasm_base64"`
	Config     json.RawMessage `json:"config"`
}

// staged 是一次预检/发布链路的**中间产物**（全部在落库之前得到）。
type staged struct {
	appID string
	// wasm 是解码后的模块字节。落库（CreateWasmRelease）之后调用方把它置 nil：
	// 段已抽到磁盘、编译已进缓存，再留一份 32 MiB 的副本没有任何用处
	// （§4.2"抽完立即释放原始字节"）。
	wasm []byte
	// sections 是抽出的自定义段（总量 ≤ limits.SectionTotalMaxBytes，内存里持有
	// 它是安全的；真正要释放的是 wasm 本体）。
	sections map[string][]byte
	// skipped 是"看起来不是资源"的段名（工具链元数据等），只报告不失败。
	skipped []string

	config     appcfg.Config
	configJSON []byte

	checksum  string
	wasmBytes int64
	compile   *compile.Result
}

// toolchainSections 是**工具链自带的自定义段**名（不当作静态资源抽取）。
//
// 依据是实测而不是猜测：Go 的 wasip1 产物固定带三个自定义段（`go:buildid` /
// `producers` / `name`；本机实测 refapp.wasm 分别 114 B / 71 B / 73 043 B）。
// 其中 `name` 是符号名表（73 KiB！），`producers` 是产线元数据 —— 把它们写进
// assets 只会浪费配额并让作者困惑（`assets.read("name")` 读到一坨符号表）。
//
// 设计 §4.2 说的"抽出失败 = 发布失败"指的是**抽取/写盘动作失败**，不是"模块里存在
// 非资源段"——否则任何 Go 模块都无法发布（`go:buildid` 含 `:`，不满足 assets 的
// 逻辑路径规则）。判据与分流见 splitAssetSections。
var toolchainSections = map[string]struct{}{
	"name":                {},
	"producers":           {},
	"target_features":     {},
	"dylink":              {},
	"dylink.0":            {},
	"linking":             {},
	"sourceMappingURL":    {},
	"external_debug_info": {},
}

// prepare 跑完 A–D（**零副作用**：不写库、不写最终目录，只写临时文件与 staging）。
//
// appID 与 wasm 由调用方给出（调用方已经完成身份/归属/版本/体积预检）：
// `publish` 传 base64 解码结果、`upload complete` 传分片拼装结果 —— **同一个 prepare**，
// 这是"分片上传不复制发布逻辑"的落点。
//
// needConfig=false 时允许载荷不带 config（validate 的早期用法：AI 还没写配置文件
// 就能先验证"能不能编译、能不能跑"）；publish 一律 needConfig=true（§10.5 第 56b 项
// 明写"配置文件缺失 ⇒ 拒发布"）。
func (h *Handlers) prepare(c *gin.Context, appID string, wasm []byte, rawConfig json.RawMessage, version string, needConfig, requireDeclarations bool) (*staged, *apperr.Error) {
	st := &staged{appID: appID, wasm: wasm, wasmBytes: int64(len(wasm))}
	sum := sha256.Sum256(wasm)
	st.checksum = hex.EncodeToString(sum[:])

	// A2 应用配置文件（§4.2/R25/R26/§10.5 第 56b–56f 项）。
	if len(rawConfig) == 0 || string(rawConfig) == "null" {
		if needConfig {
			return nil, apperr.New(apperr.CodeAppConfigBad, "缺少应用配置文件 config").
				WithDetail("field", "config").
				WithHint("publish 必须随包提交 config：{" + strings.Join(appcfg.FieldNames(appcfg.ConfigFields()), ", ") + "}").
				WithHint("字段规格（含首次发布必填项）见 skill 的 references/app-config.md，由 appcfgspec.go 生成").
				WithHint("改任何一项都要发新版（§10.5 第 56f 项）")
		}
	} else {
		cfg, cerr := appcfg.Parse(rawConfig)
		if cerr != nil {
			return nil, cerr
		}
		if verr := cfg.Validate(requireDeclarations); verr != nil {
			return nil, verr
		}
		// 平台侧的权威副本 = **解析并归一化之后**的配置（whitelist 去重/去空白、
		// access 的缺省落定；旧 schema 的 login_required/visible 在这里被映射掉，
		// 因此重新发布后写出的就是新 schema）。写原始字节会让应用读到的名单与平台校验过的
		// 名单出现看不见的差异（§4.2：「应用用 assets.read("picoaide.app.json") 读」）。
		canon, merr := json.Marshal(cfg)
		if merr != nil {
			return nil, internalErr("应用配置序列化失败", merr)
		}
		st.config, st.configJSON = cfg, canon
	}

	// A3 静态校验（体积 + 导入面 + 导出面 + 段表 + 自定义段总量）。
	if _, verr := h.opt.Compiler.ValidateWasm(wasm); verr != nil {
		return nil, verr
	}
	// B 真编译（临时文件 → 编译子进程 → 磁盘缓存）。
	res, cerr := h.compileModule(c, appID, wasm)
	if cerr != nil {
		return nil, cerr
	}
	st.compile = res

	// C 抽取自定义段（只解析，不落盘 —— 落盘在 writeStaging）。
	sections, xerr := h.opt.Compiler.ExtractCustomSections(wasm)
	if xerr != nil {
		return nil, xerr
	}
	st.sections, st.skipped = splitAssetSections(sections)

	// D 合成帧干跑（§4.2：编译通过 ≠ 能跑）。
	if derr := h.dryRun(c, appID, version, wasm, st.config); derr != nil {
		return nil, derr
	}
	return st, nil
}

// compileModule 把模块落临时文件后交给编译器（§6.2 第 ⑤ 步）。
//
// 临时文件放在 `<data_root>/apps/_tmp/`：编译子进程会被 bwrap 只读挂载**模块所在
// 目录**（isolate_linux.go），放数据根下既保证同一文件系统（创建/删除都快），
// 也避免把 `os.TempDir()` 暴露给编译进程。`_tmp` 不是合法 app_id（规则要求首字符
// 是字母或数字），所以不会与任何应用目录撞名。
func (h *Handlers) compileModule(c *gin.Context, appID string, wasm []byte) (*compile.Result, *apperr.Error) {
	dir := filepath.Join(h.opt.DataRoot, limits.AppsDirName, "_tmp")
	if err := os.MkdirAll(dir, os.FileMode(limits.DataDirMode)); err != nil {
		return nil, internalErr("上传临时目录不可用", err)
	}
	f, err := os.CreateTemp(dir, "upload-*.wasm")
	if err != nil {
		return nil, internalErr("上传临时文件创建失败", err)
	}
	name := f.Name()
	// 无论成功失败都删：磁盘上不该留下"未发布的制品"。
	defer func() { _ = os.Remove(name) }()
	if _, err := f.Write(wasm); err != nil {
		_ = f.Close()
		return nil, internalErr("上传临时文件写入失败", err)
	}
	if err := f.Close(); err != nil {
		return nil, internalErr("上传临时文件关闭失败", err)
	}
	ctx, cancel := budgetCtx(c.Request.Context(), limits.CompileTimeout)
	defer cancel()
	res, cerr := h.opt.Compiler.Compile(ctx, name)
	if cerr != nil {
		return nil, cerr
	}
	return res, nil
}

// splitAssetSections 把自定义段分成「静态资源」与「非资源段（忽略并报告）」。
//
// 判据（两条都要满足才算资源）：
//   - 段名不是工具链元数据（toolchainSections，实测依据见其注释）；
//   - 段名是**包内逻辑路径**（写盘时 assets.Write 会做完整校验：相对、`/` 分隔、
//     无 `..`；这里只做预判以便把"元数据"分流出去）。
//
// `picoaide.app.json` 是平台独占名（配置文件由宿主写入），模块里的同名段直接忽略 ——
// 否则资产的"拒绝覆盖"会先占位，导致配置写不进去。
func splitAssetSections(in map[string][]byte) (kept map[string][]byte, skipped []string) {
	kept = make(map[string][]byte, len(in))
	for name, data := range in {
		if _, isToolchain := toolchainSections[name]; isToolchain {
			skipped = append(skipped, name)
			continue
		}
		if name == limits.AppConfigFileName {
			skipped = append(skipped, name)
			continue
		}
		if !isLogicalAssetPath(name) {
			skipped = append(skipped, name)
			continue
		}
		kept[name] = data
	}
	sort.Strings(skipped)
	return kept, skipped
}

// isLogicalAssetPath 是 assets 逻辑路径规则的**本地预判**（纯字符串、不做 IO）。
func isLogicalAssetPath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\:") {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".", "..":
			return false
		}
	}
	return true
}

// dryRun 用合成帧跑一次真实实例化（§4.2：「一次真实编译 + 合成帧干跑」，2 s 预算）。
//
// 判据只有一条：应用**能实例化、能读请求帧、能写出合法响应帧**。它不校验业务逻辑
// （合成帧是匿名 `GET /`，宿主能力面为空 ⇒ 任何 db/ai/assets 调用都会拿到"能力
// 不可用"，应用应当容忍；容忍不了说明它在启动路径上硬依赖这些能力）。
func (h *Handlers) dryRun(c *gin.Context, appID, version string, wasm []byte, cfg appcfg.Config) *apperr.Error {
	// 干跑与执行进程共用同一份磁盘编译缓存 ⇒ 这里命中的就是发布期编译过的那一条
	// （§4.3.1-a：两侧 RuntimeConfig 必须一致，由 runtime/compile 各自的自检保证）。
	rt, err := runtime.New(c.Request.Context(), runtime.Options{DataRoot: h.cacheRoot()})
	if err != nil {
		return internalErr("执行侧运行时装配失败", err).WithHint("这是平台装配问题，请联系平台管理员")
	}
	defer func() { _ = rt.Close(context.WithoutCancel(c.Request.Context())) }()

	// 预算分层（**不要**把整段干跑压进 DryRunBudget）：
	//   - 外层 ctx 覆盖"执行侧装载模块"，与编译同预算（limits.CompileTimeout）——
	//     首次装载 3.6 MiB 模块在冷缓存下要 1–2 s，把它算进 2 s 的干跑预算会让
	//     Serve 一开始就贴在超时边缘（实测：请求帧写入直接 context deadline exceeded，
	//     错误表现成 MODULE_KILLED，读者会误以为是应用的问题）；
	//   - guest 执行预算由 InstanceLimits.GuestBudget 单独给 limits.DryRunBudget，
	//     那才是 §4.2 的"2 s 预算跑 Instantiate → _start → 响应帧"。
	ctx, cancel := budgetCtx(c.Request.Context(), limits.CompileTimeout)
	defer cancel()

	mod, cerr := rt.CompileModule(ctx, wasm)
	if cerr != nil {
		return apperr.New(apperr.CodeValidateFailed, "模块无法被运行时装载").
			WithCause(cerr).
			WithDetail("phase", "dry_run").
			WithHint("平台侧静态校验已通过，但 wazero 无法装载：通常是编译目标不对").
			WithHint("编译目标必须是 wasm32-wasip1（Go: GOOS=wasip1 GOARCH=wasm）")
	}
	env := abi.Request{
		ABI:     abi.ABIVersion,
		AppID:   appID,
		Version: version,
		Auth:    abi.AuthInfo{Mode: cfg.AuthMode()},
		Method:  http.MethodGet,
		Path:    "/",
		Query:   map[string]string{},
		Headers: map[string]string{},
	}
	// 能力面为空：hostcap 的 abi.ping 探针仍可应答（干跑专用），其余方法一律
	// "能力不可用" —— 干跑绝不因为"应用想写库"而放行任何宿主能力。
	caps := &hostcap.Capabilities{AppID: appID, Version: version}
	res, serr := rt.Serve(ctx, mod, runtime.Request{
		Envelope: env,
		Funcs:    caps,
		Budgets:  runtime.InstanceLimits{GuestBudget: limits.DryRunBudget},
	})
	if serr != nil {
		return internalErr("干跑装配错误", serr)
	}
	if res == nil {
		return apperr.New(apperr.CodeRuntimeNoResponse, "干跑没有拿到结论")
	}
	if !res.OK() {
		kill := res.KillReason
		if kill == nil {
			kill = apperr.New(apperr.CodeRuntimeNoResponse, "干跑失败但没有任何错误码（平台缺陷）")
		}
		return kill.
			WithDetail("phase", "dry_run").
			WithDetail("guest_exit_code", res.Metrics.GuestExitCode).
			WithDetail("stderr_tail", clipForDetail(res.Metrics.StderrTail)).
			WithHint("干跑用的是匿名 GET / 的合成帧、宿主能力面为空：应用应当在没有 db/ai/assets 的情况下也能应答")
	}
	return nil
}

// clipForDetail 把诊断文本裁到错误明细里能放下的长度（数值来源 = limits）。
func clipForDetail(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "(空)"
	}
	if len(s) > limits.StderrTailBytes {
		return s[:limits.StderrTailBytes]
	}
	return s
}

// ---------------------------------------------------------------------------
// validate：POST /apps/wasm/validate
// ---------------------------------------------------------------------------

func (h *Handlers) validate(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	// 发布闸门也罩住预检（§4.9 的"低水位拒绝发布"）。
	//
	// **判断**（审计 P1-1 让我们把这条写清）：validate 不落盘、不占执行槽、不写审计，
	// 但它**真的编译** —— 占的是同一个单进程串行编译池（队列 64）、写同一份编译缓存。
	// 而闸门要挡的三个条件（磁盘低水位 / 缓存超上限 / 编译队列满）里，前两个恰恰是
	// "再来一次编译会让情况更糟"：预检会把缓存写得更满、把磁盘用得更少。
	// 只闸 publish 会留下一条"用 validate 继续消耗编译资源"的旁路，而闸门口径本来就是
	// "现在能不能安全地接一次编译"。因此两者同闸；错误文案与 /readyz 明细一致。
	if rerr := h.publishGate(); rerr != nil {
		writeErr(c, rerr)
		return
	}
	// 身份（§8 身份语义：publisher 必须是发起操作的员工）。
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	// 上传频率闸门（§4.3）：validate 与 publish **合计** 30 次/小时。
	if after, rerr := h.acquireUpload(u); rerr != nil {
		writeErrWithRetry(c, rerr, after)
		return
	}
	defer h.opt.Compiler.ReleaseUpload(u.ID) // 必须在 defer：失败路径也要释放并发占位

	p, berr := bindJSONLimited[uploadPayload](c, limits.UploadBodyMaxBytes, "validate")
	if berr != nil {
		writeErr(c, berr)
		return
	}
	appID, aerr := h.creationAppID(c, p.AppID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	// 首版判定是**只读**查询：决定 purpose/data_sensitivity/owner 是否必填。
	// validate 不做任何写入（§4.2：不落版本号、不进审计）。
	first, verr := h.isFirstRelease(c.Request.Context(), appID)
	if verr != nil {
		writeErr(c, verr)
		return
	}
	// 解码位置与重构前逐字一致（在 creationAppID 与首版判定之后）：错误优先级是
	// 既有用例锁住的行为，reorder 会让"既越权又畸形"的请求换一个错误码。
	wasm, derr := decodeWasmBase64(p.WasmBase64)
	if derr != nil {
		writeErr(c, derr)
		return
	}
	st, perr := h.prepare(c, appID, wasm, p.Config, releaseVersion(p.Version), false, first)
	if perr != nil {
		writeErr(c, perr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"validation": h.validationJSON(st, first)})
}

// isFirstRelease 报告该应用当前是否**没有任何版本行**（含被拒/软删的版本）。
func (h *Handlers) isFirstRelease(ctx context.Context, appID string) (bool, *apperr.Error) {
	history, err := serverstore.ListWasmReleases(ctx, h.opt.DB, appID, true)
	if err != nil {
		return false, internalErr("查询失败", err)
	}
	return len(history) == 0, nil
}

// validationJSON 是预检结果（第一消费者是 AI：字段名要能直接被它读懂）。
func (h *Handlers) validationJSON(st *staged, firstRelease bool) gin.H {
	out := gin.H{
		"app_id":         st.appID,
		"ok":             true,
		"wasm_bytes":     st.wasmBytes,
		"checksum":       st.checksum,
		"imports":        symbolsJSON(st.compile.Imports),
		"exports":        symbolsJSON(st.compile.Exports),
		"custom_bytes":   st.compile.CustomBytes,
		"assets":         sortedKeys(st.sections),
		"first_release":  firstRelease,
		"dry_run":        "ok",
		"compile_ms":     st.compile.CompileMS,
		"compile_cached": st.compile.Cached,
	}
	if len(st.skipped) > 0 {
		out["ignored_sections"] = st.skipped
		out["ignored_sections_reason"] = "这些自定义段不是包内逻辑路径（或属工具链元数据），不会被抽成静态资源"
	}
	if st.configJSON != nil {
		out["config"] = json.RawMessage(st.configJSON)
	} else {
		out["config"] = nil
		out["config_checked"] = false
	}
	return out
}

// symbolsJSON 把导入/导出符号渲染成稳定的数组（顺序即段内顺序）。
func symbolsJSON(syms []compile.Symbol) []gin.H {
	out := make([]gin.H, 0, len(syms))
	for _, s := range syms {
		out = append(out, gin.H{"module": s.Module, "name": s.Name, "kind": s.Kind, "signature": s.Signature})
	}
	return out
}

// ---------------------------------------------------------------------------
// publish：POST /apps/wasm/:app_id/releases
// ---------------------------------------------------------------------------

// publishInput 是一次发布的**已解析输入**。
//
// 两条上传路径共用 publishFromBytes：base64 直传（publish）与分片拼装（upload
// complete）。区别只在"字节从哪来"与"身份/版本从哪来"，其余（归属、版本规则、
// 配额、编译、抽取、干跑、落库、审计、GC）**只有一份实现**。
type publishInput struct {
	appID     string
	version   string
	title     string
	changelog string
	config    json.RawMessage
	// sizeHint 是制品配额预检用的体积：base64 路径用 `len(base64)*3/4` 估算
	// （与既有行为逐字一致），分片路径用会话声明的确切 total_bytes。
	sizeHint int64
	// wasm 惰性提供模块字节。
	//
	// 为什么是函数而不是 []byte：**保持既有错误优先级**。原来 decodeWasmBase64 在
	// prepare 内部、也就是排在"归属 → 版本 → changelog → 配额"之后；提前解码会让
	// 一个既越权又畸形 base64 的请求从 409 变成 400（既有用例锁着这个顺序）。
	// 分片路径直接返回已拼装的字节（组装早在锁内完成）。
	wasm func() ([]byte, *apperr.Error)
}

func (h *Handlers) publish(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	// 发布前的 fail-closed 水位闸门（§4.9）——**在实际工作之前**：
	// 磁盘余量 / 编译缓存 / 编译队列 / 编译子系统可用性任一不达标 ⇒ 503，不落行、不审计。
	if rerr := h.publishGate(); rerr != nil {
		writeErr(c, rerr)
		return
	}
	u, uerr := h.currentUser(c)
	if uerr != nil {
		writeErr(c, uerr)
		return
	}
	if after, rerr := h.acquireUpload(u); rerr != nil {
		// 限流/并发占位被拒：**不写审计**（否则一个循环重试的客户端就能刷爆审计表；
		// §4.9 的高频项本就要与业务审计分开）。
		writeErrWithRetry(c, rerr, after)
		return
	}
	defer h.opt.Compiler.ReleaseUpload(u.ID) // 必须在 defer：失败路径也要释放并发占位

	p, berr := bindJSONLimited[uploadPayload](c, limits.UploadBodyMaxBytes, "publish")
	if berr != nil {
		writeErr(c, berr)
		return
	}
	appID, aerr := h.creationAppID(c, p.AppID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	body, perr := h.publishFromBytes(c, u, publishInput{
		appID:     appID,
		version:   releaseVersion(p.Version),
		title:     p.Title,
		changelog: p.Changelog,
		config:    p.Config,
		sizeHint:  int64(len(p.WasmBase64)) * 3 / 4,
		wasm:      func() ([]byte, *apperr.Error) { return decodeWasmBase64(p.WasmBase64) },
	})
	if perr != nil {
		writeErr(c, perr)
		return
	}
	c.Data(http.StatusCreated, jsonContentType, body)
}

// publishFromBytes 是**发布的唯一实现**（§6.2 的同步链路），返回已序列化的 201 体。
//
// 顺序与本文件头部注释里的 A–H 逐条对应；调用方（publish / upload complete）已经
// 完成的三件事：装配自检（requireReady）、发布水位闸门、上传频率闸门。
//
// 返回 `[]byte` 而不是直接写响应：分片路径要把这一份**逐字缓存**起来做幂等重放
// （重复 complete 回放同一个 201 体），而"先序列化再写"与 gin 的 c.JSON 逐字节等价。
func (h *Handlers) publishFromBytes(c *gin.Context, u *serverstore.User, in publishInput) ([]byte, *apperr.Error) {
	appID := in.appID
	version := in.version

	// ---- 只读前置检查：全部失败都**不落行** ----
	existing, hist, lerr := h.loadForPublish(c.Request.Context(), appID)
	if lerr != nil {
		return nil, lerr
	}
	if oerr := h.checkOwner(u, appID, existing); oerr != nil {
		h.auditDenied(u, appID, version, oerr)
		return nil, oerr
	}
	// 顺序有意：**先判"已退役"再判"已冻结"**。删除会同时写下 frozen_at（R37 的
	// 保留期锚点），若先判冻结，一个已删除的应用会对作者报"请先解冻" —— 而解冻
	// 救不了它（标识已永久占位）。语义正确的答案是 404 已退役。
	if existing != nil && existing.DeletedAt != nil {
		e := apperr.New(apperr.CodeNotFound, "应用已退役（已删除）").
			WithHint("已删除的应用标识与版本号永久占位，不能复用；请新建应用")
		h.auditDenied(u, appID, version, e)
		return nil, e
	}
	if existing != nil && existing.FrozenAt != nil {
		e := apperr.New(apperr.CodeAppFrozen, "应用已冻结，不能发布新版本").
			WithHint("冻结是 R37 退役流程的第一步：请先解冻（同一端点带 {\"frozen\":false}），或新建应用")
		h.auditDenied(u, appID, version, e)
		return nil, e
	}
	if verr := registry.ValidateVersion(version); verr != nil {
		h.auditDenied(u, appID, version, verr)
		return nil, verr
	}
	if verr := registry.MustBeNewer(version, newestVersion(hist)); verr != nil {
		h.auditDenied(u, appID, version, verr)
		return nil, verr
	}
	if verr := registry.ValidateChangelog(in.changelog, len(hist) == 0); verr != nil {
		h.auditDenied(u, appID, version, verr)
		return nil, verr
	}
	// ---- 制品配额（§5.3：每用户 1 GiB，含全部版本）----
	used, qerr := h.artifactUsed(c.Request.Context(), u.Username)
	if qerr != nil {
		return nil, internalErr("查询失败", qerr)
	}
	if qerr := registry.CheckArtifactQuota(used, in.sizeHint); qerr != nil {
		h.auditDenied(u, appID, version, qerr)
		return nil, qerr
	}

	// ---- 模块字节（两条路径在这里汇合；解码失败与 prepare 内部的失败同口径）----
	wasm, derr := in.wasm()
	if derr != nil {
		h.auditFailed(u, appID, version, derr)
		return nil, derr
	}

	// ---- A–D：预检 + 编译 + 抽取 + 干跑（失败 ⇒ 不落行，R18）----
	st, perr := h.prepare(c, appID, wasm, in.config, version, true, len(hist) == 0)
	if perr != nil {
		h.auditFailed(u, appID, version, perr)
		return nil, perr
	}

	title := strings.TrimSpace(in.title)
	if title == "" && existing != nil {
		title = existing.Title
	}
	if title == "" {
		e := apperr.New(apperr.CodeMissingField, "首次发布必须填写 title").
			WithDetail("field", "title").
			WithHint("title 是应用中心显示的名称（可中文）；app_id 是域名标签，不能中文")
		h.auditFailed(u, appID, version, e)
		return nil, e
	}

	// ---- C→落库：先把资源写进 staging（仍在库外）----
	stage, serr := h.writeStaging(st)
	if serr != nil {
		h.auditFailed(u, appID, version, serr)
		return nil, serr
	}
	// staging 的清理责任：成功路径由 rename 消费掉；失败路径在这里兜底。
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(stage.dir)
		}
	}()

	review := h.reviewRequired()
	status := serverstore.ReleaseStatusApproved
	if review {
		status = serverstore.ReleaseStatusPending
	}
	enabled := true // 新建应用即上架；已存在时 UpsertWasmApp 不改这一列（§8 上下架独立）
	if existing != nil {
		enabled = existing.Enabled
	}

	rel, cerr := h.commitRelease(c, st, stage, commitInput{
		appID:          appID,
		version:        version,
		title:          title,
		changelog:      in.changelog,
		status:         status,
		publisher:      u.Username,
		enabled:        enabled,
		existing:       existing,
		currentVersion: currentVersionOf(existing, hist),
	})
	if cerr != nil {
		h.auditFailed(u, appID, version, cerr)
		return nil, cerr
	}
	committed = true
	st.wasm = nil // §4.2：落库后立即释放内存里的模块字节

	// ---- H 收尾：审计 + 版本 GC ----
	h.auditApp(appID, u.Username, "wasm_app_release",
		auditDetail(appID, title, fmt.Sprintf("v%s %s checksum=%s size=%d", version, rel.Status, st.checksum, st.wasmBytes)))
	// 访问模式变更写审计：动作名从 wasm_app_visibility_change 改为
	// wasm_app_access_change（2026-09-18 收敛为 access 三模式；旧动作名不再产生）。
	// 旧值从既有 config_json 现解（解析失败回落 login）。
	if existing != nil {
		if prev := appcfg.AccessOfConfigJSON(existing.ConfigJSON); prev != st.config.Access {
			h.auditApp(appID, u.Username, "wasm_app_access_change",
				auditDetail(appID, title, fmt.Sprintf("access %s → %s（随 v%s 生效）", prev, st.config.Access, version)))
		}
	}
	if review {
		h.auditApp(appID, u.Username, "wasm_app_release_pending",
			auditDetail(appID, title, fmt.Sprintf("v%s 进待审队列，线上仍为旧版本（R17）", version)))
	}
	pruned := h.prune(detachCtx(c), appID)

	raw, merr := json.Marshal(gin.H{
		"app": gin.H{
			"app_id":      appID,
			"title":       title,
			"description": st.config.Purpose,
			"enabled":     enabled,
			"owner":       rel.Owner,
			"version":     rel.CurrentVersion,
			"entry_url":   h.appOrigin(c, appID),
		},
		"release": gin.H{
			"id":               rel.ID,
			"version":          version,
			"status":           rel.Status,
			"current":          rel.Current,
			"checksum":         st.checksum,
			"size":             st.wasmBytes,
			"assets":           sortedKeys(st.sections),
			"ignored_sections": st.skipped,
			"compile_ms":       st.compile.CompileMS,
			"compile_cached":   st.compile.Cached,
		},
		"review_required": review,
		"pruned_releases": pruned,
	})
	if merr != nil {
		// 版本已经生效：序列化失败只可能是平台缺陷（gin.H 里全是可编码类型）。
		return nil, internalErr("发布响应序列化失败（版本已生效）", merr)
	}
	return raw, nil
}

// releaseOutcome 是 commitRelease 的结果（响应与审计都用它）。
type releaseOutcome struct {
	ID      int64
	Status  string
	Current bool
	Owner   string
	// CurrentVersion 是"本次发布之后线上生效的版本"（待审时 = 旧版本）。
	CurrentVersion string
}

type commitInput struct {
	appID          string
	version        string
	title          string
	changelog      string
	status         string
	publisher      string
	enabled        bool
	existing       *serverstore.WasmApp
	currentVersion string
}

// commitRelease 执行落库到生效的全部写入，并在**任何一步失败时补偿**。
//
// 补偿口径：删掉已经改好名的资源目录 + 软删刚建的 release 行 + 把
// current_release_id 恢复成原来的值（仅当这一次改过它）。
//
// 补偿本身失败只影响"版本号被占用"这一后果，不会让应用指向半个版本 —— 因此不把
// 补偿失败升级成 panic，只把**原始错误**回给调用方（它才是可行动的）。
func (h *Handlers) commitRelease(c *gin.Context, st *staged, stage *stagingDir, in commitInput) (*releaseOutcome, *apperr.Error) {
	ctx := c.Request.Context()
	out := &releaseOutcome{Status: in.status, CurrentVersion: in.currentVersion}
	if in.existing != nil {
		out.Owner = in.existing.Owner
	}

	// E1 占名（owner 首占且不可改写：DAO 的 COALESCE 保证）。
	if err := serverstore.UpsertWasmApp(ctx, h.opt.DB, serverstore.WasmApp{
		AppID: in.appID, Title: in.title, Description: st.config.Purpose,
		Owner: in.publisher, Channel: serverstore.AppChannelWasm, Enabled: in.enabled,
		Purpose: st.config.Purpose, DataSensitivity: st.config.DataSensitivity,
		ConfigJSON: string(st.configJSON),
	}); err != nil {
		return nil, internalErr("应用元数据保存失败", err)
	}
	// E1.5 归属的**并发兜底**：owner 首占由 DAO 的 COALESCE 保证，但"读归属 → 写"
	// 之间仍有窗口（appstore.Publish 用事务级咨询锁关掉了它；本包走 wasm DAO 没有
	// 那把锁）。落库后复读一次：赢家不是我且我不是管理员 ⇒ 这是一次并发抢占，
	// 立刻拒绝（此时**还没有**建版本行，所以不占版本号）。
	//
	// 残留：抢占失败者这一次的 UpsertWasmApp 可能覆写赢家的 title/description
	// （DAO 的冲突分支对这两列没有守卫）。已列入交付说明的残留项 —— 彻底修法是把
	// 发布收敛到 appstore.Publish 的事务级咨询锁内核（需要 serverstore 暴露 tx 版 DAO）。
	if app, err := serverstore.GetWasmApp(ctx, h.opt.DB, in.appID); err == nil {
		out.Owner = app.Owner
		if app.Owner != in.publisher && !h.isAdmin(c) {
			return nil, apperr.New(apperr.CodeNameTaken, "名称已被占用，无法上传：请更换名称或联系管理员").
				WithDetail("app_id", in.appID).
				WithHint("发布即占名：首个成功发布者永久占有该标识（R6/§4.1）")
		}
	} else if !errors.Is(err, serverstore.ErrNotFound) {
		return nil, internalErr("查询失败", err)
	}

	// E2 版本行（拿到 release_id；唯一约束冲突 = 版本号已占位，§4.1）。
	//
	// assets_dir 列**留空**（不是漏写）：目录名就是 release_id（§4.2 的布局
	// `<data_root>/apps/<app_id>/assets/<release_id>/`），而 release_id 只有 INSERT
	// 之后才知道 —— 本包不做数据访问（DAO 在 serverstore），没有"插入后回填某一列"
	// 的入口，硬凑只能靠预测 id。执行侧对空值的口径是**回落到 release.id**
	// （appserver.releaseAssetID），与 §4.2 的布局逐字一致，因此这里留空是安全的。
	relID, err := serverstore.CreateWasmRelease(ctx, h.opt.DB, serverstore.WasmRelease{
		AppID: in.appID, Version: in.version, Title: in.title,
		Description: st.config.Purpose, Changelog: in.changelog,
		Publisher: in.publisher, Checksum: st.checksum, Wasm: st.wasm,
		Status: in.status, ConfigJSON: string(st.configJSON),
	})
	if err != nil {
		switch {
		case errors.Is(err, serverstore.ErrDuplicate):
			return nil, apperr.Newf(apperr.CodeNameTaken, "版本 %s 已存在", in.version).
				WithDetail("version", in.version).
				WithHint("版本号一经落行永久占位（含被拒与软删的版本，§4.1）；请升版本号重试")
		case errors.Is(err, serverstore.ErrNotFound):
			return nil, apperr.New(apperr.CodeNotFound, "应用不存在").WithCause(err)
		default:
			return nil, internalErr("版本保存失败", err)
		}
	}
	out.ID = relID

	// 补偿闭包：从这里开始任何失败都要把"半成品"回收掉。
	//
	// 三件事，缺一件都会留下不一致的状态：
	//  1. 删掉已改名的资源目录（否则盘上留着没人引用的资源）；
	//  2. 软删刚建的 release 行（版本号仍占位 —— 见文件头"不硬删行"的理由）；
	//  3. 把 apps 上的**投影**恢复原样：current_release_id 与 config_json
	//     （config 是 apps.purpose/data_sensitivity 与访问模式的来源，不回滚会让
	//     目录可见性反映一个并没有生效的版本）。
	cleanupCtx := context.WithoutCancel(ctx)
	compensate := func() {
		_ = os.RemoveAll(stage.finalDir)
		_ = serverstore.SoftDeleteWasmRelease(cleanupCtx, h.opt.DB, relID)
		if in.existing == nil {
			return
		}
		if in.existing.CurrentReleaseID > 0 {
			_ = serverstore.SetWasmAppCurrentRelease(cleanupCtx, h.opt.DB, in.appID, in.existing.CurrentReleaseID)
		}
		if in.existing.ConfigJSON != "" {
			_ = serverstore.SetWasmAppConfig(cleanupCtx, h.opt.DB, in.appID,
				in.existing.ConfigJSON, in.existing.Purpose, in.existing.DataSensitivity)
		}
	}

	// F 原子改名：staging → assets/<release_id>（同一父目录，单次 rename）。
	// 放在"置为生效版本"之前：否则会有一个窗口让应用指向一个资源目录还不存在的版本。
	stage.finalDir = filepath.Join(filepath.Dir(stage.dir), strconv.FormatInt(relID, 10))
	if err := os.Rename(stage.dir, stage.finalDir); err != nil {
		compensate()
		return nil, internalErr("资源目录落位失败（本次版本号已占位，请升版本号重发）", err).
			WithDetail("version", in.version).
			WithHint("这是平台侧的文件系统错误；请把这条诊断反馈给平台管理员")
	}

	// G1 应用配置投影（config_json/purpose/data_sensitivity；访问模式由 config_json 现解）。
	if err := serverstore.SetWasmAppConfig(ctx, h.opt.DB, in.appID,
		string(st.configJSON), st.config.Purpose, st.config.DataSensitivity); err != nil {
		compensate()
		return nil, internalErr("应用配置保存失败（本次版本号已占位，请升版本号重发）", err).
			WithDetail("version", in.version)
	}
	// G2 生效版本：仅"非待审"时指向新版本。
	// 审核开启时**不动** current_release_id ⇒ 线上仍旧版本（R17：不中断使用）。
	if in.status == serverstore.ReleaseStatusApproved {
		if err := serverstore.SetWasmAppCurrentRelease(ctx, h.opt.DB, in.appID, relID); err != nil {
			compensate()
			return nil, internalErr("生效版本切换失败（本次版本号已占位，请升版本号重发）", err).
				WithDetail("version", in.version)
		}
		out.Current = true
		out.CurrentVersion = in.version
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// staging 目录
// ---------------------------------------------------------------------------

// stagingDir 是一次发布使用的**临时资源目录**（落库前写入，落库后改名）。
type stagingDir struct {
	dir      string
	finalDir string
	files    []string
}

// writeStaging 把抽出的段与应用配置文件写进 `<data_root>/apps/<app_id>/assets/<staging>/`。
//
// 为什么用 staging（而**不是**"先落库拿 id 再写最终目录"）：见文件头注释 —— 一切
// 文件系统写入都发生在落库之前，写盘失败就不留任何库行，R18 因此是结构性的而不是
// 靠补偿维持的。改名是同父目录的单次 rename（同一文件系统 ⇒ 原子、几乎不失败）。
func (h *Handlers) writeStaging(st *staged) (*stagingDir, *apperr.Error) {
	parent := filepath.Join(h.opt.DataRoot, limits.AppsDirName, st.appID, assets.AssetsDirName)
	if err := os.MkdirAll(parent, os.FileMode(limits.DataDirMode)); err != nil {
		return nil, internalErr("资源根目录创建失败", err)
	}
	// 目录名必须满足 assets 的 releaseIDPattern（`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，
	// 不得以点开头）—— MkdirTemp 的前缀本身满足，随机后缀是字母数字。
	tmp, err := os.MkdirTemp(parent, "staging-")
	if err != nil {
		return nil, internalErr("资源暂存目录创建失败", err)
	}
	if err := os.Chmod(tmp, os.FileMode(limits.DataDirMode)); err != nil {
		_ = os.RemoveAll(tmp)
		return nil, internalErr("资源暂存目录权限设置失败", err)
	}
	stage := &stagingDir{dir: tmp}
	// staging 的名字必须能被 assets.Open 接受（它同时校验 app_id 与 release_id 规则）。
	store, aerr := assets.Open(h.opt.DataRoot, st.appID, filepath.Base(tmp))
	if aerr != nil {
		_ = os.RemoveAll(tmp)
		return nil, aerr
	}
	// 段 → 资源文件（顺序固定，报错稳定）。
	for _, name := range sortedKeys(st.sections) {
		if werr := store.Write(name, st.sections[name]); werr != nil {
			_ = os.RemoveAll(tmp)
			return nil, werr.
				WithDetail("section", name).
				WithHint("自定义段名必须是包内逻辑路径（如 index.html、static/app.js）：相对、以 / 分隔、不含 .. 与冒号")
		}
		stage.files = append(stage.files, name)
	}
	// 应用配置文件（§4.2：随资源一起抽出，应用用 assets.read("picoaide.app.json") 读）。
	// 它由宿主写入 ⇒ 平台侧是唯一权威副本（模块里的同名段已在 splitAssetSections 忽略）。
	if st.configJSON != nil {
		if werr := store.Write(limits.AppConfigFileName, st.configJSON); werr != nil {
			_ = os.RemoveAll(tmp)
			return nil, werr
		}
		stage.files = append(stage.files, limits.AppConfigFileName)
	}
	return stage, nil
}

// prune 做版本 GC（§5.3：保留最近 3 个曾生效版本）并清理被回收版本的资源目录。
//
// 资源目录的删除必须在这里做：PruneWasmReleases 只负责"数据行"（其包注释明确
// "本文件只做数据访问"），不会碰文件系统；没有这一步，被 GC 的版本会留下永久占盘的
// 资源目录（配额按 BYTEA 算，磁盘却还在涨）。目录名就是 release id（§4.2 的布局）。
func (h *Handlers) prune(ctx context.Context, appID string) []int64 {
	pruned, err := serverstore.PruneWasmReleases(ctx, h.opt.DB, appID, limits.RetainedVersions)
	if err != nil {
		// GC 失败不影响本次发布的结果（新版本已经生效），但它必须可见：
		// 记一条审计，运维面能查到。
		h.auditApp(appID, "", "wasm_app_prune_failed", auditDetail(appID, "", "版本 GC 失败: "+err.Error()))
		return nil
	}
	for _, id := range pruned {
		dir := filepath.Join(h.opt.DataRoot, limits.AppsDirName, appID, assets.AssetsDirName, fmt.Sprint(id))
		if rerr := os.RemoveAll(dir); rerr != nil {
			h.auditApp(appID, "", "wasm_app_prune_failed",
				auditDetail(appID, "", fmt.Sprintf("资源目录清理失败 release=%d: %v", id, rerr)))
		}
	}
	return pruned
}

// detachCtx 返回一个**不随请求取消**的上下文，用于"响应已经决定之后"的收尾动作
// （GC / 资源清理）：客户端提前断开不应该让收尾半途而废。
func detachCtx(c *gin.Context) context.Context {
	return context.WithoutCancel(c.Request.Context())
}

// ---------------------------------------------------------------------------
// 闸门与归属
// ---------------------------------------------------------------------------

// acquireUpload 施加上传频率闸门（§4.3：每用户 30 次/小时 + 同时 1 次编译中）。
//
// 返回错误时**调用方不得**调用 ReleaseUpload（占位根本没拿到）；成功时调用方必须
// `defer Compiler.ReleaseUpload(u.ID)` —— 测试钉死"失败路径也释放"，否则一次编译
// 失败就会把这个用户永久卡在"同时 1 次编译中"上。
func (h *Handlers) acquireUpload(u *serverstore.User) (time.Duration, *apperr.Error) {
	ok, retryAfter := h.opt.Compiler.AllowUpload(u.ID, h.now())
	if ok {
		return 0, nil
	}
	if retryAfter < time.Second {
		// 下限 1 s：回 "0" 会让客户端立刻重试，把限流变成自旋。
		retryAfter = time.Second
	}
	e := apperr.Newf(apperr.CodeRateLimited,
		"上传过于频繁：validate 与 publish 合计每用户每小时 %d 次，且同时只能有 1 次编译中的上传",
		limits.UploadRatePerHour).
		WithDetail("limit_per_hour", limits.UploadRatePerHour).
		WithDetail("retry_after_seconds", int(retryAfter.Seconds())).
		WithHint("限流只按用户计数、**不**因失败返还：试错次数本身就是限流对象")
	return retryAfter, e
}

// isAdmin 是平台兜底判定（§8/R23：super_admin 可接管处置任何应用）。
func (h *Handlers) isAdmin(c *gin.Context) bool {
	return isSuperAdmin(serverauthCurrentUser(c))
}

// checkOwner 是归属检查（§10.5 第 60 项 / R6）。
//
// 语义与 appstore.Publish **逐字一致**（同码 409 NAME_TAKEN、同文案"名称已被占用，
// 无法上传：请更换名称或联系管理员"、管理员放行）——两条上传路径对同一个越权请求
// 必须给出同样的结论，否则客户端要写两套提示。空 owner 的历史行一律视同占名。
func (h *Handlers) checkOwner(u *serverstore.User, appID string, existing *serverstore.WasmApp) *apperr.Error {
	if existing == nil || existing.Owner == u.Username || isSuperAdmin(u) {
		return nil
	}
	return apperr.New(apperr.CodeNameTaken, "名称已被占用，无法上传：请更换名称或联系管理员").
		WithDetail("app_id", appID).
		WithHint("发布即占名：首个成功发布者永久占有该标识，被拒/软删也不释放（R6/§4.1）").
		WithHint("需要接管他人应用时，请管理员在管理面转移归属（§11 第 17 项）")
}

// isSuperAdmin 报告该用户是否是平台管理员（R23 兜底接管）。
func isSuperAdmin(u *serverstore.User) bool {
	return u != nil && u.Role == serverstore.RoleSuperAdmin
}

// loadForPublish 读取应用与全部历史版本（含软删：版本号永久占位）。
func (h *Handlers) loadForPublish(ctx context.Context, appID string) (*serverstore.WasmApp, []serverstore.WasmRelease, *apperr.Error) {
	app, err := serverstore.GetWasmApp(ctx, h.opt.DB, appID)
	if err != nil && !errors.Is(err, serverstore.ErrNotFound) {
		return nil, nil, internalErr("查询失败", err)
	}
	hist, herr := serverstore.ListWasmReleases(ctx, h.opt.DB, appID, true)
	if herr != nil {
		return nil, nil, internalErr("查询失败", herr)
	}
	return app, hist, nil
}

// newestVersion 返回历史版本中的最高版本（空 = 尚无版本）。
func newestVersion(hist []serverstore.WasmRelease) string {
	newest := ""
	for _, r := range hist {
		if newest == "" || registry.CompareVersions(r.Version, newest) > 0 {
			newest = r.Version
		}
	}
	return newest
}

// currentVersionOf 返回当前生效版本的版本号（待审期间 = 旧版本；无 = 空）。
func currentVersionOf(app *serverstore.WasmApp, hist []serverstore.WasmRelease) string {
	if app == nil || app.CurrentReleaseID <= 0 {
		return ""
	}
	for _, r := range hist {
		if r.ID == app.CurrentReleaseID {
			return r.Version
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// 审计助手（失败/被拒两条路径都要留痕，§4.9）
// ---------------------------------------------------------------------------

func (h *Handlers) auditDenied(u *serverstore.User, appID, version string, e *apperr.Error) {
	h.auditApp(appID, u.Username, "wasm_app_release_denied",
		auditDetail(appID, "", fmt.Sprintf("v%s 被拒 code=%s: %s", version, e.Code, e.Message)))
}

func (h *Handlers) auditFailed(u *serverstore.User, appID, version string, e *apperr.Error) {
	h.auditApp(appID, u.Username, "wasm_app_release_failed",
		auditDetail(appID, "", fmt.Sprintf("v%s 失败 code=%s: %s", version, e.Code, e.Message)))
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
