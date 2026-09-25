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
	"github.com/picoaide/picoaide/internal/wasmapp/wasmmod"
)

// 本文件是 §6.2 的**同步发布链路**（R30）与 §4.2 的预检（validate）。
//
// 两件事在这里同时定死：**顺序**与**失败时的补偿**。
//
// 顺序（2026-09-20 起整条链路只写数据库，见下）：
//
//	A 纯校验      identity → app_id → 体积 → 静态(导入/导出/段表/体积) → appcfg
//	             （appcfg 一步在**更新发布**时会先把缺席字段从上一版生效配置继承过来）
//	B 编译        临时文件 → Compiler.Compile（真编译，60 s 预算）
//	C 抽取分流    ExtractCustomSectionsWithCounts → assets.SplitSections（**纯内存**）
//	             → 保留前缀拒 → 重名段拒（ASSET_EXISTS）→ 逐条逻辑路径完整校验 +
//	             单文件/总量上限（与运行期 assets.Build 同一份判据）
//	D 干跑        合成帧 Instantiate → _start → 响应帧（2 s 预算）
//	E 占名落行    UpsertWasmApp → 复读归属 → CreateWasmRelease（拿到 release_id）
//	F 投影        （仅 approved 时）SetWasmAppConfig + SetWasmAppCurrentRelease
//	G 收尾        审计 → 版本 GC（**数据行**，保留 3 版）
//
// ⚠️ 随包资源**不落盘**（2026-09-20 定案，决策文档
// `docs/decisions/2026-09-20-wasm-assets-in-memory.md`）：自定义段在本进程里被解析成
// 内存资源集（运行期由 appserver 用 `assets.Build` 构造并直出），磁盘上只留各应用自己的
// `app.db`。因此原先的 "C 抽取落盘 / F 原子改名 / GC 顺带删资源目录" 三步连同 staging
// 目录与补偿里的删目录一起消失 —— **本文件不再出现任何"按版本落盘"的路径**
// （`<data_root>/apps/<app_id>/assets/<release_id>/` 这个布局作废）。
//
// ⚠️ 投影有**两条**写路径，两条都必须被 `status == approved` 罩住：
//   - F1/F2（SetWasmAppConfig + SetWasmAppCurrentRelease）；
//   - E1 的 UPSERT（首版落行 / 已有应用的更新都走它），罩住的列 =
//     config_json/purpose/data_sensitivity（首版待审时它们曾照写，让"没被任何人批准过的
//     配置"成了后续版本的继承基线，审计 §1.2）**以及 title/description**（2026-09-19
//     第二轮审计 §1.1：这两列漏在守卫外，而目录门面直接读它们 ⇒ 待审版本能立刻把
//     已上线应用改名成"IT 密码重置"，仿冒不需要过审）。
//
// 理由（R1-pm-9 / R2-1）：apps 行是**目录对全员下发的投影**（access 徽标/负责人/当前版本/标题/描述），
// 也是"上一版生效配置"的显示面。待审版本没有生效，投影就必须一字不动 —— 否则作者提交
// 一个"改成 public"的待审版本，全公司先看到"公开"徽标，点进去却仍被要求登录（审核只剩
// "卡制品"，配置展示不受控），而且下一版会拿这个未审核的 public 当缺省。待审版本被
// **拒绝**时同样不能留下未生效的投影；两条审核路径的收口见 admin.go 的
// recomputeProjection。继承基线的真源已经是版本行（inheritBase 走
// LatestApprovedWasmReleaseMeta），投影列因此只是显示面 —— 但显示面同样不能提前变。
//
// **为什么现在是"零磁盘副作用"**：R18 的判据是"失败的发布不占版本号"。原实现把
// 全部抽段落盘排在落库之前，好让写盘失败不留库行 —— 但那只是把风险挪了个位置，且
// 落库后还要靠 rename + 补偿维持一致。现在整条链路**只写数据库**，唯一的文件系统
// 痕迹是编译用的临时文件（`<data_root>/apps/_tmp/upload-*.wasm`，每条路径都 defer
// 删除）⇒ 任何失败要么发生在第一次 INSERT 之前（一行都不留），要么由 compensate()
// 把那一行软删掉（版本号仍占位，见下）。
//
// 落库之后只剩两次 UPDATE。它们真失败时走 compensate()：软删刚建的 release 行 +
// 把 current_release_id 与 config 投影恢复成原来的值，并把错误如实回给调用方
// （含"该版本号已占位"的提示）。**不硬删行**：本包不做数据访问（DAO 在 serverstore），
// 而"软删行仍在 ⇒ 版本号仍占位"是平台既有语义（§4.1）。

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
	// 段已在内存里解析成 sections、编译已进缓存，再留一份 32 MiB 的副本没有任何
	// 用处（§4.2"抽完立即释放原始字节"）。
	wasm []byte
	// sections 是抽出的**静态资源**（已分流、已逐条校验、总量 ≤
	// limits.SectionTotalMaxBytes）。它是内存资源集的原料：落库后由运行期
	// `assets.Build` 用「库里这份 wasm 的自定义段 + 库内 config_json」构造，本字段
	// 只服务于本次请求的响应/诊断（`release.assets`）。
	sections map[string][]byte
	// skipped 是"看起来不是资源"的段名（工具链元数据 / 平台独占名等），只报告不失败。
	skipped []string

	config     appcfg.Config
	configJSON []byte

	checksum  string
	wasmBytes int64
	compile   *compile.Result
}

// prepare 跑完 A–D（**零磁盘副作用**：不写库、不落盘；唯一的文件系统痕迹是 B 步的
// 编译临时文件，函数返回前已删除）。
//
// appID 与 wasm 由调用方给出（调用方已经完成身份/归属/版本/体积预检）：
// `publish` 传 base64 解码结果、`upload complete` 传分片拼装结果 —— **同一个 prepare**，
// 这是"分片上传不复制发布逻辑"的落点。
//
// needConfig=false 时允许载荷不带 config（validate 的早期用法：AI 还没写配置文件
// 就能先验证"能不能编译、能不能跑"）；publish 一律 needConfig=true（§10.5 第 56b 项
// 明写"配置文件缺失 ⇒ 拒发布"）。
//
// prevConfigJSON 是**更新发布**的继承基线（最新 approved 版本的 config_json，见
// inheritBase）：非空时提交里缺席的字段沿用它的值（R1-pm-10/R1-uxc-8），空串 =
// 首版语义（缺省仍按 schema）。publish 传 inheritBase 的结果、validate 传
// inheritBaseForApp 的结果（同一份基线）—— 预检与发布必须对同一份载荷给出同一个
// 结论，否则 AI 会看到"预检通过、发布被拒"。基线不可用时调用方**在进来之前**就已
// 拒绝（两个入口都先过 inheritBase*），因此这里的 byte 一定可用。
func (h *Handlers) prepare(c *gin.Context, appID string, wasm []byte, rawConfig json.RawMessage, version string, needConfig, requireDeclarations bool, prevConfigJSON string) (*staged, *apperr.Error) {
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
		// 更新发布时**先合并再解析**：缺席字段沿用上一版生效值，显式给值以提交为准。
		// 首版（基线为空）走的就是 Parse —— "缺省 = login" 的既有语义不回归。
		cfg, cerr := appcfg.ParseUpdate(rawConfig, prevConfigJSON)
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

	// C 抽取自定义段（只解析，**不落盘**：资源不再有磁盘形态）。
	//
	// 走 wasmmod 的 WithCounts 形态而不是 `Compiler.ExtractCustomSections`：后者是同一份
	// 解析能力的薄包装，只返回段内容 —— 而"同一个资源名出现了几次"是发布期必须判的
	// 事实（重名段在解析层只取第一个、其余静默丢弃，见 C3 的重名闸门）。
	// 错误映射与那个包装逐字一致（apperr.From）。
	sections, sectionCounts, xerr := wasmmod.ExtractCustomSectionsWithCounts(wasm)
	if xerr != nil {
		return nil, apperr.From(xerr)
	}
	// C2 保留前缀闸门（§21.2 规则②，R2-X-3）：应用**不得**占用 `__picoaide/` 前缀。
	//
	// 为什么必须在发布期拒（而不是像工具链段那样"忽略并报告"）：那个前缀由**宿主**
	// 本地处理（规则①：`path` 以 `__picoaide/` 开头的请求绝不转发平台），随包资源里
	// 出现同名路径时，应用以为自己的路由生效了 —— 实际请求被宿主截走，症状是
	// "本地开发好的接口，发布后 404/拿到宿主的响应"，而平台侧没有任何报错。
	// 静默忽略等于把这个谜题留给作者。
	if aerr := checkReservedPathPrefix(sections); aerr != nil {
		return nil, aerr
	}
	// C3 分流（段 → 静态资源 / 忽略并报告）与**发布期**的完整校验。
	//
	// 分流策略只有一份实现（assets.SplitSections，判据与运行期、与打包脚本同源）；
	// 这里的校验是运行期 assets.Build 的**前置副本**：不通过的错误必须发生在落库之前
	// （否则非法资源名会先占掉一个版本号），且要指到具体哪个段（details.section）。
	st.sections, st.skipped = assets.SplitSections(sections)
	// 重名闸门只罩**保留下来的资源段**：工具链元数据（`name`/`producers`/…）与平台
	// 独占的 `picoaide.app.json` 本来就可能重复出现或被忽略，对它们报错没有意义。
	if aerr := checkDuplicateSections(st.sections, sectionCounts); aerr != nil {
		return nil, aerr
	}
	if aerr := checkPublishAssets(st.sections, st.configJSON); aerr != nil {
		return nil, aerr
	}

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

// reservedPathPrefix 是**平台保留**的路径前缀（§21.2 规则②）。
//
// 契约原文（§21.2 保留路径，冻结）：
//
//	①协议 handler 对 `path` 以 `__picoaide/` 开头的请求**本地处理、绝不转发平台**；
//	②应用**不得**定义同前缀路由（发布校验拒绝）；③其余 `__picoaide/*` 一律 404。
//
// 服务端能静态看到的唯一"路由面"是随包资源（自定义段）的名字（应用的真实路由写在
// wasm 里，平台不做反编译）⇒ 这里拒的是**资源路径**占用保留前缀。应用内部若自己
// 处理 `__picoaide/…`，请求在宿主层就被截走（规则①③），平台看不到也管不着；
// 这条闸门保证的是"作者不会以为随包资源能提供该前缀的响应"。
const reservedPathPrefix = "__picoaide/"

// checkReservedPathPrefix 拒绝占用平台保留前缀的随包资源（§21.2 规则②）。
//
// 错误码取既有的 `ASSET_DENIED`（"资源路径被拒"）：它就是这个语义，且已在
// assets 包用于越界/非法段；新增一个码要同步契约与文档，而这里不需要。
// 提示里点名 §21.2，让作者知道该走宿主桥（`__picoaide/ai/chat`）而不是自己实现。
func checkReservedPathPrefix(sections map[string][]byte) *apperr.Error {
	var offenders []string
	for name := range sections {
		if strings.HasPrefix(name, reservedPathPrefix) {
			offenders = append(offenders, name)
		}
	}
	if len(offenders) == 0 {
		return nil
	}
	sort.Strings(offenders)
	return apperr.New(apperr.CodeAssetDenied, "随包资源占用了平台保留路径前缀 "+reservedPathPrefix).
		WithDetail("reason", "reserved_path_prefix").
		WithDetail("prefix", reservedPathPrefix).
		WithDetail("paths", offenders).
		WithHint("`" + reservedPathPrefix + "` 由宿主保留（§21.2）：这类请求由客户端本地处理、绝不转发平台").
		WithHint("应用侧要调模型请用宿主桥 `" + reservedPathPrefix + "ai/chat`（前端 fetch，结果回传 wasm 落库）")
}

// checkDuplicateSections 拒绝"同一个包内路径出现了两次"的自定义段（`ASSET_EXISTS`，409）。
//
// 为什么必须有这条闸门：随包资源的键就是段名，而重名段在**解析层是静默的** ——
// `wasmmod.Parse` 只把第一个同名段收进 `CustomSections`，其余的丢掉、不报错。作者的
// 两种常见形态都会撞上它：
//
//   - 打包脚本里两个源文件写了同一个 `DEST`（页面显示的是先打进模块的那一份）；
//   - 手工往模块里追加段时重复追加（例如"改了一下 index.html 又追加了一次"）。
//
// 两种情况下作者都会对着一个"内容不对"的页面反复怀疑浏览器缓存，而平台侧一声不响。
// `ASSET_EXISTS` 的语义正好是"这个资源名已经被占了一次"（它原来是磁盘版
// `assets.Store.Write` 的"拒绝覆盖"用的码；磁盘版删除后，这里是它唯一的触发点）。
//
// 判据只罩 `kept`（真正会成为资源的段）：工具链元数据段（`name`/`producers`/…）与
// 平台独占的 `picoaide.app.json` 本来就可能重复出现或被忽略，对它们报错没有意义。
func checkDuplicateSections(kept map[string][]byte, counts map[string]int) *apperr.Error {
	var dup []string
	dupCounts := make(map[string]int)
	for name := range kept {
		if n := counts[name]; n > 1 {
			dup = append(dup, name)
			dupCounts[name] = n
		}
	}
	if len(dup) == 0 {
		return nil
	}
	sort.Strings(dup)
	return apperr.New(apperr.CodeAssetExists, "同一个资源名在自定义段里出现了多次").
		WithDetail("reason", "duplicate_section").
		WithDetail("paths", dup).
		WithDetail("counts", dupCounts).
		WithHint("同一个包内路径只能有一个自定义段；用 `scripts/pack-assets.mjs` 打包时不要给两个源文件写同一个 DEST").
		WithHint("改资源内容 = 发一个新版本（重名不是「后者覆盖前者」，而是整份被平台拒）")
}

// checkPublishAssets 在**发布期**对随包资源做两道完整校验（判据与运行期
// `assets.Build` 同源，是它的前置副本）。
//
// 为什么运行期已经判过还要在这里判一次：
//   - **失败要发生在落库之前**：否则一个非法资源名会先占掉一个版本号，作者只能升
//     版本号重发（R18 的代价）。运行期报错发生在那之后，救不了版本号；
//   - **错误要能指到具体哪个段**（`details.section`）：运行期是交付路径，它给出的
//     `details.path` 到不了作者发起的那次请求。
//
// 两道判据：
//
//  1. 每个资源名过 `assets.ValidateLogicalPath`（唯一的完整实现：相对、`/` 分隔、
//     无 `..`/`:`/控制字符、单段 ≤ MaxSegmentBytes、整条 ≤ MaxPathBytes）。
//     分流用的 `assets.IsLogicalAssetPath` 只是**纯字符串预判**，不做长度校验 ——
//     超长段名会走到这里才被拒。错误码沿用 `ASSET_DENIED`（与 assets 包同一个语义）。
//  2. 单文件与总量 ≤ `limits.SectionTotalMaxBytes`。总量口径与 `assets.Build` 逐字
//     一致 = 全部资源之和，**再加平台注入的 `picoaide.app.json`**（它也是资源集里的
//     一条，配置同样占额度）。
func checkPublishAssets(kept map[string][]byte, cfgJSON []byte) *apperr.Error {
	var total int64
	for _, name := range sortedKeys(kept) {
		if _, perr := assets.ValidateLogicalPath(name); perr != nil {
			return perr.
				WithDetail("section", name).
				WithHint("自定义段名就是**包内逻辑路径**（如 index.html、static/app.js）：相对、以 `/` 分隔、不含 `..` 与冒号").
				WithHint("段名长度上限：单段 " + strconv.Itoa(assets.MaxSegmentBytes) + " 字节、整条 " + strconv.Itoa(assets.MaxPathBytes) + " 字节")
		}
		size := int64(len(kept[name]))
		if size > limits.SectionTotalMaxBytes {
			return assetOversize(name, size)
		}
		total += size
	}
	if len(cfgJSON) > 0 {
		if size := int64(len(cfgJSON)); size > limits.SectionTotalMaxBytes {
			return assetOversize(limits.AppConfigFileName, size)
		}
		total += int64(len(cfgJSON))
	}
	if total > limits.SectionTotalMaxBytes {
		return apperr.New(apperr.CodeAssetOversize, "随包资源总量超过上限").
			WithDetail("total", total).
			WithDetail("max", limits.SectionTotalMaxBytes).
			WithHint("随包资源来自 wasm 自定义段，段总量上限与单文件上限同源（§4.2）")
	}
	return nil
}

// assetOversize 是"单条资源超过上限"的错误（`details.section` 指到具体段名；
// 同时带 `details.path`，与 assets 包同一码的既有明细口径一致）。
func assetOversize(section string, size int64) *apperr.Error {
	return apperr.New(apperr.CodeAssetOversize, "随包资源超过单文件上限").
		WithDetail("section", section).
		WithDetail("path", section).
		WithDetail("size", size).
		WithDetail("max", limits.SectionTotalMaxBytes).
		WithHint("单文件与段总量同源 limits.SectionTotalMaxBytes（§4.2）")
}

// dryRun 用合成帧跑一次真实实例化（§4.2：「一次真实编译 + 合成帧干跑」，2 s 预算）。
//
// 判据只有一条：应用**能实例化、能读请求帧、能写出合法响应帧**。它不校验业务逻辑
// （合成帧是匿名 `GET /`，宿主能力面为空 ⇒ 任何 db/ai/assets 调用都会拿到"能力
// 不可用"，应用应当容忍；容忍不了说明它在启动路径上硬依赖这些能力）。
func (h *Handlers) dryRun(c *gin.Context, appID, version string, wasm []byte, cfg appcfg.Config) *apperr.Error {
	// 干跑与执行进程共用同一份磁盘编译缓存 ⇒ 这里命中的就是发布期编译过的那一条
	// （§4.3.1-a：两侧 RuntimeConfig 必须一致，由 runtime/compile 各自的自检保证）。
	//
	// ⚠️ 单实例内存上限必须取**运行时生效值**（R1-rt-7 + R5）：这条路径原先只传
	// DataRoot，于是回落编译期 64 MiB（runtime.New 的 MemoryPages=0 分支）——控制台把
	// instance_memory_mb 调小 ⇒ 干跑在 64 MiB 下放行线上跑不起来的应用；调大 ⇒ 误拒。
	// 干跑存在的理由正是"编译通过 ≠ 能跑"，用错上限就把它变成了摆设。
	//
	// ⚠️ 为什么是 effectiveMemoryPages 而不是 instanceMemoryPages（R5，2026-09-19）：
	// 单实例上限住在 wazero 的 RuntimeConfig 里，**改了要重启才生效** —— 在"刚保存、
	// 还没重启"的窗口里，`Options.Limits()`（已保存值）与运行时真正在跑的上限可以差出
	// 几十上百 MiB（实测：已保存 32 MiB / 实际按 128 MiB 跑）。干跑要回答的是"这次运行
	// 到底能不能跑起来"，所以取生效值；已保存值只有"运行时钩子没接线"时才兜底
	// （见 read.go 的 effectiveMemoryPages：运行时优先、已保存值兜底，只有这一份实现）。
	rt, err := runtime.New(c.Request.Context(), runtime.Options{
		DataRoot:    h.cacheRoot(),
		MemoryPages: h.effectiveMemoryPages(),
	})
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

// instanceMemoryPages 返回**已保存**的单实例线性内存页数（装配侧注入的 applimits 闭包；
// 未注入 —— 最小装配/单测 —— 时返回 0，让 runtime.New 回落编译期默认）。
//
// 为什么走闭包而不是让 api 包自己读设置：解析优先级（控制台设置 > 部署档位 > 编译期默认）
// 与运行期下发都住在装配侧（cmd/server 的 wasmLimitsHolder），api 只负责"取当前值"。
//
// ⚠️ 这是"控制台配了多少"，**不是"这次运行按多少跑"**（R5）：单实例上限要重启才生效，
// 两者的窗口差可以到几十上百 MiB。因此：
//   - 诊断 hints 与**发布干跑**（要回答"现在能不能跑起来"）⇒ 必须走
//     `effectiveMemoryPages()`（运行时优先，见 read.go）—— 本函数只是它的兜底；
//   - 控制台 limits 视图与"待重启"判定（要回答"你配了多少"）⇒ 用本函数/Limits。
//
// 别在调用点直接用它来跑 guest：那正是 R5 的缺陷形态（干跑按一个并不生效的上限给结论）。
func (h *Handlers) instanceMemoryPages() uint32 {
	if h.opt.Limits == nil {
		return 0
	}
	return h.opt.Limits().InstanceMemoryPages()
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
	// 归属校验，且必须在**任何实际工作之前**（2026-09-23 审计 A-2，P1）。
	//
	// 预检会读该应用**当前生效版本**的 config_json 作为继承基线
	//（`inheritBaseForApp`），并把合并结果原样回显在 `validation.config`
	//（`validationJSON`）—— 缺了这一句，任意已登录员工用一个只带 app_id 的最简载荷
	// 就能换回他人应用的 `whitelist` 名单 / `purpose` / `data_sensitivity` / `owner` /
	// `sensitive_columns`，外加一个 `first_release` 存在性 oracle。
	//
	// 位置有意：在 `isFirstRelease`/`decodeWasmBase64`/`inheritBaseForApp`/`prepare`
	// 之前 —— 非归属人不触发任何配置读取、不进编译池、不落任何行。
	existing, oerr := h.checkValidateOwner(c.Request.Context(), u, appID)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	// 终态闸门（冻结 / 退役）：**与 publish 共用同一个 `publishBlockOf`**（R3-A A-4 的
	// 第三个消费面）。
	//
	// 缺陷形态（复审 F1）：availability 与 publish 已经同源，唯独预检没接上，于是
	// 冻结/退役的应用预检回 200 `ok:true, dry_run:"ok"`、真发布回 403 `APP_FROZEN` /
	// 404 `NOT_FOUND` —— 正是 A-4 要消灭的"预检说可以、发布被拒"，而 AI 的第一动作
	// 就是先预检（见下方 inheritBaseForApp 的注释）。第三个面没接上等于把同一个分叉
	// 换了个入口留下。
	//
	// 位置有意：在归属校验之后、`isFirstRelease`/解码/编译/干跑**之前** —— 终态应用
	// 不该消耗**编译资源**，错误也必须与 publish **逐字节同形**（同一个 `*apperr.Error`，
	// 连 hints 一致）。
	//
	// ⚠️ 本闸门**不**省额度：`acquireUpload`（validate/publish 合计 30 次/小时的额度）
	// 在本函数更上面、本闸门**之前** ⇒ 终态预检今天照样占一次额度。判据
	// `TestValidateTerminalAppsNeverReachCompile` 也只钉到"不触发真编译"这一层；
	// 要改成"不占额度"是行为变更，必须先把 `acquireUpload` 挪到闸门之后并同步改判据。
	//
	// 边界：`enabled=false`（下架）**不是**终态，`publishBlockOf` 对它返回 nil
	// —— 预检与发布都不拦，这是 R37 的三态语义，不要"顺手"把下架也拦掉。
	if blocked := publishBlockOf(existing); blocked != nil {
		writeErr(c, blocked.Err)
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
	// 继承基线要在预检里先解出来：基线不可用时预检也必须给出与发布**同一个**结论
	// （否则 AI 会看到"预检通过、发布被拒"）。
	base, berr := h.inheritBaseForApp(c.Request.Context(), appID)
	if berr != nil {
		writeErr(c, berr)
		return
	}
	st, perr := h.prepare(c, appID, wasm, p.Config, releaseVersion(p.Version), false, first, base)
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
	// 终态闸门（冻结 / 退役）：判据抽在 publishBlockOf 里，**与 availability 共用**
	// （R3-A A-4）—— 两个面各写一份就会出现"预查说可以、发布被拒"。
	if blocked := publishBlockOf(existing); blocked != nil {
		h.auditDenied(u, appID, version, blocked.Err)
		return nil, blocked.Err
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
	//
	// 恢复路径（R15C-G-03，2026-09-25）：这条闸门是 fail-closed 的，所以它必须
	// 回答"被挡住之后用户还能做什么"。今天有两条真实出路，且都有判据：
	//   ① 删除不再使用的应用（DELETE /apps/wasm/:app_id → SoftDeleteWasmApp
	//      释放该应用名下全部版本的字节）；
	//   ② 平台管理员代为清理（super_admin 可删任意应用）。
	// 报错文案（registry.CheckArtifactQuota）与这两条逐字对应，不得再写"删除版本"
	// 或"联系管理员扩容"（前者没有端点、后者没有配置项）。
	//
	// ⚠️ 已知残留（R15C-G-06，P3，阅读级）：这里是 check-then-act —— 读用量与
	// commitRelease 的落库之间没有串行化，同一用户并发发布可小幅超配额
	// （上界 = 并发发布数 × 单次制品上限）。它不产生错误终态（只是配额软一点），
	// 且失败发布的字节今天会被补偿软删退回；要彻底关掉需要按**发布者**串行化
	// （会话级 advisory lock 或把闸门挪进落库事务），留待排期。
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
	//
	// 继承基线 = **最新 approved 版本**的配置（inheritBase；不是 apps.config_json
	// 投影列，也不是"最后一次提交"）。提交里缺席的 access/whitelist/purpose/
	// data_sensitivity/owner 沿用那一版（R1-pm-10/R1-uxc-8），显式给值以提交为准 ——
	// 这是"给这个应用发个小修复"不会静默改写线上访问级别的唯一落点。
	// 基线不可用（生效版本的 config_json 是坏行）⇒ 拒绝发布，不猜（见 inheritBase）。
	base, berr := h.inheritBase(c.Request.Context(), existing)
	if berr != nil {
		h.auditFailed(u, appID, version, berr)
		return nil, berr
	}
	st, perr := h.prepare(c, appID, wasm, in.config, version, true, len(hist) == 0, base)
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

	// ---- E0 快照新鲜度：任何写入之前的"读—改"冲突检测 ----
	//
	// 现场（审计第三轮 B 区 CONFIRMED，2026-09-19）：`existing` 是本次请求开头
	// （loadForPublish）读到的 apps 行快照，而**写回投影**在 commitRelease 里 ——
	// 中间隔着真编译 + 干跑 + 段解析（秒级窗口）。窗口里落库的任何一次并发写都会被这一次的
	// 陈旧快照覆盖。最典型的是**并发 approve**：
	//
	//	① 发布读到 apps = {title:"报销助手", current_release_id:R1}；
	//	② 管理员批准 v1.1.0 ⇒ apps = {title:"工资条查询", current_release_id:R2}
	//	   （R2 的版本行 title="工资条查询"）——投影随审批切走；
	//	③ 发布继续走：E1 的 UPSERT 把①的陈旧 title/description 写回 ⇒
	//	   apps = {title:"报销助手", current_release_id:R2}
	//	   ⇒ 目录显示"报销助手"、生效版本却是 R2（标题"工资条查询"）：**目录与生效
	//	     版本不一致**的终态，而且没有任何路径会自己修回来（E1 只在发布时写，
	//	     下一次审核才可能覆盖）。
	//
	// E1.5 的 owner 复读只认"抢占"那一种形态（owner 变了才拒），覆盖不到这条。这里在
	// **任何写入之前**复读一次 apps 行并逐字段比对快照：不一致 ⇒ fail-loud 让作者重试。
	// 此刻还没有建版本行、也没有任何落盘 ⇒ 版本号没被占用，重试是干净的。
	//
	// 残留（要认账）：复读与 commitRelease 的第一次写之间仍有微秒级窗口 —— 彻底关掉它
	// 需要把"校验 + 写投影"做成一条带条件的 UPDATE（serverstore 目前没有这种 DAO）。
	// 现有的两道防线把窗口从"秒级"压到"微秒级"：①这里的复读；②后面一律以**复读值**
	// 为投影/补偿基线（即便真撞上，写回的也是刚刚读到的值，而不是编译前的陈旧值）。
	if existing != nil {
		fresh, ferr := serverstore.GetWasmApp(c.Request.Context(), h.opt.DB, appID)
		if ferr != nil {
			return nil, internalErr("查询失败", ferr)
		}
		if field := staleAppField(existing, fresh); field != "" {
			e := apperr.New(apperr.CodeValidation,
				"应用状态在本次发布期间被其他操作改变了，本次发布已中止（未占用版本号）").
				WithDetail("app_id", appID).
				WithDetail("version", version).
				WithDetail("changed_field", field).
				WithHint("请重试发布：本次没有写入任何行或资源；并发审批/上下架/冻结/改名/再次发布都会触发这条")
			// 409（不是 400）：参数没写错，是时序冲突 —— 与"拒绝后不能再通过"同码同状态。
			e.HTTP = http.StatusConflict
			h.auditFailed(u, appID, version, e)
			return nil, e
		}
		// 投影与补偿一律以**复读值**为基线（见上面的"残留"：微秒级窗口里写回的也必须
		// 是刚刚读到的值，不能是编译前的陈旧值）。
		existing = fresh
	}

	// ---- E：落库（从这里开始才有写入；此前一行都没有，也没有任何落盘）----
	//
	// 审核开关必须用**严格**读法（R3-A A-3）：读失败 ⇒ 503 + 不落行。
	// 用展示面的宽松读法会把一次 settings 读故障变成"静默放行未审核版本"
	// （fail-open），那正是本条缺陷的原始形态。
	review, rerr := h.publishReviewRequired()
	if rerr != nil {
		return nil, rerr
	}
	status := serverstore.ReleaseStatusApproved
	if review {
		status = serverstore.ReleaseStatusPending
	}
	enabled := true // 新建应用即上架；已存在时 UpsertWasmApp 不改这一列（§8 上下架独立）
	if existing != nil {
		enabled = existing.Enabled
	}

	rel, cerr := h.commitRelease(c, st, commitInput{
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
	st.wasm = nil // §4.2：落库后立即释放内存里的模块字节

	// ---- G 收尾：审计 + 版本 GC（数据行）----
	h.auditApp(appID, u.Username, "wasm_app_release",
		auditDetail(appID, title, fmt.Sprintf("v%s %s checksum=%s size=%d", version, rel.Status, st.checksum, st.wasmBytes)))
	// 访问模式变更写审计：动作名从 wasm_app_visibility_change 改为
	// wasm_app_access_change（2026-09-18 收敛为 access 三模式；旧动作名不再产生）。
	// 旧值从**继承基线**（= 最新 approved 版本的配置，就是本次沿用/对比的那一份）
	// 现解，而不是 apps.config_json 投影列：投影可能停在脏值上（历史上待审版本也
	// 写过它），而"变更前的线上访问级别"只有一个真源（见 inheritBase）。基线为空
	// （没有生效版本）时回落 login —— 与缺省一致。
	//
	// ⚠️ 明细里的"生效"必须与真相一致（R1-pm-9 的同一条纪律）：待审版本的提交
	// **没有**生效（投影与生效版本都不动），把它写成"随 vX 生效"会让运维面把一次
	// 提交读成一次已生效的访问级别变更。
	if existing != nil {
		if prev := appcfg.AccessOfConfigJSON(base); prev != st.config.Access {
			effect := fmt.Sprintf("随 v%s 生效", version)
			if review {
				effect = fmt.Sprintf("随 v%s 提交（待审，尚未生效）", version)
			}
			h.auditApp(appID, u.Username, "wasm_app_access_change",
				auditDetail(appID, title, fmt.Sprintf("access %s → %s（%s）", prev, st.config.Access, effect)))
		}
	}
	if review {
		h.auditApp(appID, u.Username, "wasm_app_release_pending",
			auditDetail(appID, title, fmt.Sprintf("v%s 进待审队列，线上仍为旧版本（R17）", version)))
	}
	pruned := h.prune(detachCtx(c), appID)

	app := gin.H{
		"app_id":      appID,
		"title":       title,
		"description": st.config.Purpose,
		"enabled":     enabled,
		"owner":       rel.Owner,
		"version":     rel.CurrentVersion,
	}
	// ⚠️ `entry_url` 已随 W4 从两侧删除（总纲 §8.4 / §5.2 冻结契约）：应用只在桌面客户端内
	// 以 `<渠道 app scheme>://<app_id>` 打开，服务端**不再下发任何入口链接**。
	// 能发给同事的唯一形态是客户端侧生成的渠道深链（见 packages/client/wasm-apps）。
	raw, merr := json.Marshal(gin.H{
		"app": app,
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
// 补偿口径（2026-09-20 起只有数据库半边）：软删刚建的 release 行 + 把
// current_release_id / config 投影恢复成原来的值（仅当这一次改过它们）。资源目录
// 已经不存在，"删目录"这一步随磁盘布局一起删除。
//
// 补偿本身失败只影响"版本号被占用"这一后果，不会让应用指向半个版本 —— 因此不把
// 补偿失败升级成 panic，只把**原始错误**回给调用方（它才是可行动的）。
func (h *Handlers) commitRelease(c *gin.Context, st *staged, in commitInput) (*releaseOutcome, *apperr.Error) {
	ctx := c.Request.Context()
	out := &releaseOutcome{Status: in.status, CurrentVersion: in.currentVersion}
	if in.existing != nil {
		out.Owner = in.existing.Owner
	}

	// E1 占名（owner 首占且不可改写：DAO 的 COALESCE 保证）。
	//
	// **投影列只在"已生效"时随 E1 落行**（与 F1 同一条纪律，R1-pm-9 + R2-1）：
	// 待审版本没有经过任何人批准，写进 apps 行会让它成为下一版的**继承基线**
	// （2026-09-19 审计 §1.2 —— 首版待审时 E1 的 INSERT 分支曾照写，F1 守卫只挡住了
	// 半条路），也会**立刻改写全组织可见的目录门面**（2026-09-19 第二轮审计 §1.1 ——
	// title/description 是同一次 UPSERT 里唯一没被守卫罩住的两列，而员工面目录直接
	// 读它们：作者发一个待审版本就能把已上线应用改名成"IT 密码重置"并写诱导描述，
	// 点进去执行的却仍是已审核的旧代码 ⇒ 仿冒不需要过审）。
	//
	// 三条分支的口径（read.go 的目录/详情/导出都是"读 apps 行"）：
	//   - **approved**：投影 = 本次版本（title/description + 配置三列，与 F1 同源同版）；
	//   - **待审 + 已存在应用**：投影**一字不动** —— 显式传 in.existing 的**现值**
	//     （title/description/config_json/purpose/data_sensitivity 五列全都传现值，
	//     见下面的 Finding 6 说明）；
	//   - **首版待审**：apps 行还没有任何生效版本，显示面用 **app_id 占位**（不是待审
	//     标题：未审核内容不进投影列；也不是空串：目录/详情/导出读的就是这一列，
	//     read.go 对空值没有 title 兜底 ⇒ 空标题会先出现在管理面与导出里）。目录此时
	//     不列它（read.go 的目录条件要求 current_release_id > 0）。
	// 首版待审的空配置不是缺陷：read.go 对空 config_json 的兜底是 access 回落 login、
	// 负责人回落 apps.owner。approve/reject 时由 admin.go 的审核分支按**最新 approved
	// 版本**重算全部投影列（配置三列 + title/description）。
	//
	// 残留（要认账）：首版待审期间再发新版若省略 title，继承源是 apps 行的占位
	// （app_id）而不是上一份草稿标题 ⇒ 作者需重填一次。宁可让作者多打一次，也不让
	// "没人批准过的标题"成为下一版的缺省（与继承基线同一条纪律）。
	//
	// Finding 6（审计第三轮 B 区）：待审分支给 UpsertWasmApp 传的三个配置列此前是
	// **空串**，靠 DAO 的冲突分支"恰好不写这三列"才实现"配置一字不动" —— 这个不变量
	// 没有任何守卫，谁改一下 DAO 的列集就会静默改写全组织的访问级别/用途。现在像
	// title/description 一样**显式传现值**：不变量搬进 api 层（与实现无关地成立），
	// 同时下方有契约级用例钉住"待审路径不改这三列"。
	//
	// 空标题的历史行（apps.title = ''，0071 之前的残渣）：待审路径写回空串会让目录/
	// 详情/导出继续顶着空标题（read.go 对空 title 没有兜底）。这里统一按首版待审的
	// 占位口径补成 app_id —— 空串不是可接受的终态，"占位"至少能被识别成非真实标题。
	projConfig, projPurpose, projSensitivity := "", "", ""
	projTitle, projDescription := in.appID, ""
	switch {
	case in.status == serverstore.ReleaseStatusApproved:
		projConfig, projPurpose, projSensitivity = string(st.configJSON), st.config.Purpose, st.config.DataSensitivity
		projTitle, projDescription = in.title, st.config.Purpose
	case in.existing != nil:
		projConfig, projPurpose, projSensitivity = in.existing.ConfigJSON, in.existing.Purpose, in.existing.DataSensitivity
		projTitle, projDescription = in.existing.Title, in.existing.Description
		if strings.TrimSpace(projTitle) == "" {
			projTitle = in.appID
		}
	}
	// E1 归属投影：**官方应用的归属恒为空**（R3-A A-9）。
	//
	// 与 appstore.Publish:261-264 的 official 分支同形（同一条不变量在两个面上
	// 必须只有一种写法）：官方内容的归属就是"官方"，管理员发版不得把它改写成
	// 发布者个人 —— `official=1 ∧ owner≠''` 是 SetAppOfficial 显式拒绝的状态，
	// 造出来会让员工端把官方条目当"某个人的应用"（is_owner 为真而发布仍被拒）。
	//
	// 为什么这里显式分支（DAO 的 UpsertWasmApp 也有同款守卫）：不变量必须在
	// **调用方也成立**，与 DAO 的列集/条件分支改动无关（同 appstore.Publish 的
	// "刻意显式传现值"纪律）。DAO 那一层防的是"未来的调用者写错"。
	owner := in.publisher
	if in.existing != nil && in.existing.Official == 1 {
		owner = ""
	}
	if err := serverstore.UpsertWasmApp(ctx, h.opt.DB, serverstore.WasmApp{
		AppID: in.appID, Title: projTitle, Description: projDescription,
		Owner: owner, Channel: serverstore.AppChannelWasm, Enabled: in.enabled,
		Purpose: projPurpose, DataSensitivity: projSensitivity,
		ConfigJSON: projConfig,
	}); err != nil {
		return nil, internalErr("应用元数据保存失败", err)
	}
	// E1.5 归属的**并发兜底**：owner 首占由 DAO 的 COALESCE 保证，但"读归属 → 写"
	// 之间仍有窗口（appstore.Publish 用事务级咨询锁关掉了它；本包走 wasm DAO 没有
	// 那把锁）。落库后复读一次：赢家不是我且我不是管理员 ⇒ 这是一次并发抢占，
	// 立刻拒绝（此时**还没有**建版本行，所以不占版本号）。
	//
	// 注意这条**只管抢占那一种形态**（owner 变了才拒）。其他并发写（审批把投影切走、
	// 上下架、冻结…）由 publishFromBytes 的 E0 快照新鲜度检测兜住 —— 那一条在任何写入
	// 之前就 fail-loud，所以这里的"覆写赢家 title/description"窗口已被收敛到微秒级：
	// 触发这条时写回的 title/description 是 E0 复读到的**赢家值**（不是编译前的快照），
	// 而 owner 抢占失败者不会带走别人的显示面。
	//
	// 残留：彻底消除"校验与写入之间的窗口"需要把发布收敛到 appstore.Publish 的事务级
	// 咨询锁内核（需要 serverstore 暴露 tx 版 DAO）；当前的窗口量与后果见 E0 段。
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
	// assets_dir 列**留空**：它是"资源抽取到磁盘"时代的遗留列（2026-09-20 起随包资源
	// 从 wasm 自定义段在内存里构造，磁盘上没有按版本的资源目录）。本包不做数据访问
	// （DAO 在 serverstore），也就没有"插入后回填某一列"的入口；列留空即"没有磁盘资源"。
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
	// 两件事，缺一件都会留下不一致的状态：
	//  1. 软删刚建的 release 行（版本号仍占位 —— 见文件头"不硬删行"的理由）；
	//  2. 把 apps 上的**投影**恢复原样：current_release_id 与 config_json
	//     （config 是 apps.purpose/data_sensitivity 与访问模式的来源，不回滚会让
	//     目录可见性反映一个并没有生效的版本）。只有 approved 路径会写这两列
	//     （F1 的守卫），待审路径下这两条 UPDATE 是幂等兜底。
	//
	// 磁盘上没有需要对账的东西：随包资源只存在于本次请求的内存里（此刻已被丢弃），
	// 库里的 wasm 字节才是唯一权威副本（下一版/回滚都从它重建资源集）。
	cleanupCtx := context.WithoutCancel(ctx)
	compensate := func() {
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

	// F1 应用配置投影（config_json/purpose/data_sensitivity；访问模式由 config_json 现解）。
	//
	// **只有已生效（approved）的版本才写投影**（R1-pm-9，此前是无条件执行）：
	// apps 行是目录对**全员**下发的投影（access 徽标 / 负责人 / 用途），待审版本
	// 没有生效 ⇒ 投影必须一字不动。否则作者提交一个"改成 public"的待审版本后，
	// 全公司先看到"公开"徽标、点进去却仍被要求登录 —— 审核就只剩"卡制品"。
	// 待审版本**永不**写投影：拒绝它时目录配置本来就是"上一次 approved"的值，
	// 不需要任何回滚（这也是"不写"比"写了再回滚"更稳的原因）。通过审核时由
	// admin.go 的 adminReview 分支把投影按**最新 approved 版本**重算一遍
	//（SetWasmAppCurrentRelease + SetWasmAppConfig，同一份 config_json 同源同版）。
	if in.status == serverstore.ReleaseStatusApproved {
		if err := serverstore.SetWasmAppConfig(ctx, h.opt.DB, in.appID,
			string(st.configJSON), st.config.Purpose, st.config.DataSensitivity); err != nil {
			compensate()
			return nil, internalErr("应用配置保存失败（本次版本号已占位，请升版本号重发）", err).
				WithDetail("version", in.version)
		}
	}
	// F2 生效版本：仅"非待审"时指向新版本。
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

// prune 做版本 GC（§5.3：保留最近 3 个曾生效版本）。
//
// 只做**数据行** GC：随包资源不再是磁盘目录（2026-09-20 起内存直出，见文件头），
// 所以原先"顺带删除被回收版本的资源目录"那一段连同它的审计分支一起删除 ——
// 磁盘上没有属于版本的东西可删。被 GC 版本的 wasm 字节随数据行一起消失。
func (h *Handlers) prune(ctx context.Context, appID string) []int64 {
	pruned, err := serverstore.PruneWasmReleases(ctx, h.opt.DB, appID, limits.RetainedVersions)
	if err != nil {
		// GC 失败不影响本次发布的结果（新版本已经生效），但它必须可见：
		// 记一条审计，运维面能查到。
		h.auditApp(appID, "", "wasm_app_prune_failed", auditDetail(appID, "", "版本 GC 失败: "+err.Error()))
		return nil
	}
	return pruned
}

// detachCtx 返回一个**不随请求取消**的上下文，用于"响应已经决定之后"的收尾动作
// （版本 GC）：客户端提前断开不应该让收尾半途而废。
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

// publishBlock 描述"这个应用**为什么**不能再接收新版本"（nil = 可以发）。
//
// 两个消费方**必须**共用同一份判定，否则"预查说可以、发布被拒"的契约分叉会立刻
// 回来（R3-A A-4）：
//   - `publishFromBytes` 直接把它回给调用方（403 APP_FROZEN / 404 NOT_FOUND）；
//   - `availability` 回 `can_publish=false` + 同一个错误的 code/message/hints
//     （连文案都逐字相同 —— 客户端因此只需要一套渲染分支）。
type publishBlock struct {
	// Reason 是 availability 面的**稳定判词**（终态各自可辨，不并成 taken/yours）。
	Reason string
	// Err 是共用的结构化错误。
	Err *apperr.Error
}

// publishBlockOf 是"这个应用现在还能不能发新版"的**唯一判据**。
//
// 顺序有意：**先判"已退役"再判"已冻结"**。删除会同时写下 frozen_at（R37 的保留期
// 锚点），若先判冻结，一个已删除的应用会对作者报"请先解冻" —— 而解冻救不了它
// （标识已永久占位）。语义正确的答案是 404 已退役。
func publishBlockOf(app *serverstore.WasmApp) *publishBlock {
	if app == nil {
		return nil
	}
	if app.DeletedAt != nil {
		return &publishBlock{Reason: "retired", Err: apperr.New(apperr.CodeNotFound, "应用已退役（已删除）").
			WithHint("已删除的应用标识与版本号永久占位，不能复用；请新建应用")}
	}
	if app.FrozenAt != nil {
		return &publishBlock{Reason: "frozen", Err: apperr.New(apperr.CodeAppFrozen, "应用已冻结，不能发布新版本").
			WithHint("冻结是 R37 退役流程的第一步：请先解冻（同一端点带 {\"frozen\":false}），或新建应用")}
	}
	return nil
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

// checkValidateOwner 是**预检**（validate）的归属检查：非归属人一律 404。
//
// 为什么不能直接复用 checkOwner（publish 的 409）：那条 409 的语义是"名称已被占用，
// 请换名字"，它必须回显（作者要知道下一步做什么），而且它**不携带任何配置内容**。
// 预检不同 —— 它的响应体里有该应用的生效配置（继承基线回显），一旦放行，"响应的内容"
// 本身就是泄露，所以拒绝必须走**只读管理面**的口径（`ownedApp`/`notFoundApp`）：
// 不存在与不属于你是**同一个响应**（同一个构造函数、同一份文案、同一份 details/hints），
// 外人无法用响应差异探测归属。参见 `release.go` 的 notFoundApp 与 `read.go` 目录面对
// 同一份数据（whitelist/purpose 只给发布者）的口径。
//
// 空闲标识（没有 apps 行 = 首版）放行：validate 的**主要**用途就是"发布前先验证一个
// 新标识能不能发"（§4.2 的预检），这里不是管理动作、也没有任何他人数据可读。
// 存在性本身不是新增泄露：`/apps/wasm/availability/:app_id`（200 + reason=taken）与
// publish 的 409 都已经公开"这个标识被占了"；本函数要关掉的是**存在性之外**的东西
// （配置内容与 first_release 版本数 oracle）。
//
// 返回值是**读到的应用行**（不存在时 nil）：调用方（validate）要在同一个快照上跑
// `publishBlockOf` 的终态闸门 —— 再查一次不仅多一次往返，还会让"归属校验通过"与
// "终态判定"落在两个不同的读点（两读之间被冻结/删除就成了新的分叉窗口）。
func (h *Handlers) checkValidateOwner(ctx context.Context, u *serverstore.User, appID string) (*serverstore.WasmApp, *apperr.Error) {
	app, err := serverstore.GetWasmApp(ctx, h.opt.DB, appID)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			return nil, nil
		}
		return nil, internalErr("查询失败", err)
	}
	if app.Owner == u.Username || isSuperAdmin(u) {
		return app, nil
	}
	return nil, notFoundApp(appID)
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

// staleAppField 比较两份 apps 行快照，返回第一处不同的字段名（空串 = 未变）。
//
// 用途：发布链路在**任何写入之前**用它判断"读快照 → 写投影"之间有没有别的写者
// （并发 approve / 上下架 / 冻结 / 改名 / 再次发布）插进来 —— 那会让本次发布把陈旧
// 的 title/description 写回投影，留下"目录与生效版本不一致"的终态（见 publishFromBytes
// 的 E0 段）。
//
// 比较口径是"会影响本次写回结果或补偿基线的列"，并且**逐字段比较而不是只看
// updated_at**：错误信息里要能指出变的是哪一个字段（"谁动了这个应用"是作者唯一能
// 行动的信息）。updated_at 放在最后：任何写入都会推进它 ⇒ 连"值没变但确实被人写过"
// 也挡得住（宁可让作者重试一次，也不写回一个来历不明的快照）。
func staleAppField(snap, fresh *serverstore.WasmApp) string {
	switch {
	case fresh == nil:
		// 快照在、行没了：只可能被真删（软删会留行）⇒ 一律按冲突处理。
		return "deleted"
	case snap.Title != fresh.Title:
		return "title"
	case snap.Description != fresh.Description:
		return "description"
	case snap.Owner != fresh.Owner:
		return "owner"
	case snap.Enabled != fresh.Enabled:
		return "enabled"
	case snap.ConfigJSON != fresh.ConfigJSON:
		return "config_json"
	case snap.Purpose != fresh.Purpose:
		return "purpose"
	case snap.DataSensitivity != fresh.DataSensitivity:
		return "data_sensitivity"
	case snap.CurrentReleaseID != fresh.CurrentReleaseID:
		return "current_release_id"
	case !sameTimePtr(snap.FrozenAt, fresh.FrozenAt):
		return "frozen_at"
	case !sameTimePtr(snap.DeletedAt, fresh.DeletedAt):
		return "deleted_at"
	case !snap.UpdatedAt.Equal(fresh.UpdatedAt):
		return "updated_at"
	}
	return ""
}

// sameTimePtr 比较两个可空时间戳（nil 与 nil 相等，nil 与非 nil 不等）。
func sameTimePtr(a, b *time.Time) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	}
	return a.Equal(*b)
}

// inheritBase 返回**更新发布**的字段继承基线 = 最新 approved 版本的 `config_json`
// （语义与判据见 appcfg.ParseUpdate）。空串 = 没有基线（首版）。
//
// 真源是**版本行**（app_releases）里最新 approved 的那一版，**不是** `apps.config_json`
// 投影列：后者是显示面，待审版本也曾被写进去（2026-09-19 审计 §1.2）—— 拿它当基线
// 等于让一个没人批准过的配置成为后续版本的默认值。这里与交付面（appserver 的
// LatestApprovedWasmReleaseMeta）、审批面（admin.go 重算投影用同一个入口）**同源**：
// 继承基线永远是"线上正在交付的那一版"。
//
// 基线不可用（非空但解析不了）⇒ **拒绝发布**（appcfg.UnusableBaselineError）：
// 此时按缺省回落 login 对白名单应用是放宽，而"静默放宽"在作者侧零信号。
func (h *Handlers) inheritBase(ctx context.Context, existing *serverstore.WasmApp) (string, *apperr.Error) {
	if existing == nil {
		return "", nil
	}
	return h.inheritBaseForApp(ctx, existing.AppID)
}

// inheritBaseForApp 是 inheritBase 的"按 app_id 现查"形态（validate 用：预检与发布
// 必须对同一份载荷给出同一个结论，否则 AI 会看到"预检通过、发布被拒"）。
func (h *Handlers) inheritBaseForApp(ctx context.Context, appID string) (string, *apperr.Error) {
	latest, err := serverstore.LatestApprovedWasmReleaseMeta(ctx, h.opt.DB, appID)
	switch {
	case errors.Is(err, serverstore.ErrNotFound):
		// 没有任何已通过版本（首版，或全部被拒/被回收）：没有可继承的基线，
		// 缺省按 schema 走（access 落 login）。这不是错误 —— 首版语义不回归。
		return "", nil
	case err != nil:
		// 读失败**不**降级成"没有基线"：那会把一次数据库故障翻译成一次访问级别的
		// 静默回落，正是本次要消灭的形态。如实报平台侧错误。
		return "", internalErr("查询生效版本失败", err)
	}
	if appcfg.BaselineStateOf(latest.ConfigJSON) != appcfg.BaselineUnusable {
		return latest.ConfigJSON, nil
	}
	// 点名坏的是哪一版：错误文案是作者/管理员唯一的线索（§8：第一消费者是 AI，
	// 丢掉可操作性等于让它自己猜）。
	return "", appcfg.UnusableBaselineError().
		WithDetail("baseline_version", latest.Version).
		WithHint(fmt.Sprintf("已生效版本 v%s 的配置行读不出来：修好它（app_releases.config_json），"+
			"或先审批一个配置完整的历史待审版本，之后即可正常发布", latest.Version))
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
