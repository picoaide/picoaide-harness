package skillmanifest

// R21F-06（审计 2026-09-26，P2）的判据：技能/应用的**名字面**必须拒 Win32
// 保留设备名（`con` / `prn` / `aux` / `nul` / `com1`…）。
//
// ## 缺陷形态（判据要杀的东西）
//
// 修前 `IsAppID("con") == true` ⇒ 管理员可以登记并上架一个名为 `con` 的技能/应用
// （`POST /api/server/admin/skills/con/archive` 全链路 201），而**任何平台**的客户端
// 在安装期都会硬拒这个名字（Windows 上连目录都建不出来：Win32 设备名语义）——
// 又一次「审核通过 = 可安装」为假。与 R21F-04 修好的**归档条目面**完全同形
// （那次只收了条目面：`assets/aux.txt`、`nul`、`con/…`）。
//
// ## 判据（四条）
//
//	① **名字面**：22 个文档保留名全拒（含大写形态、带扩展名/尾随点空格形态 ——
//	   后者由形态规则兜住，两种口径都接受"拒"这个结论）；
//	② **写侧闸门**：`Parse`（包内 name）与 `NormalizeSkillMD`（管理端规范化重打包）
//	   两条真正的闸门函数都必须拒；**负控**（`console` / `com10` / `com0` / `lpt0` /
//	   `auxiliary` / `null` …）必须照旧通过 —— 没有负控，"把所有名字都拒掉"也能变绿；
//	③ **读侧不变**：同一个名为 `con` 的**存量**归档，读原语（`Validate` 之外的
//	   `ListContents` / `ExtractFileContent`，即列表/预览/下载路径用的那两个）
//	   必须逐字照旧工作；
//	④ **调用点表可执行**：全 server 生产源码里 `IsAppID` 的调用点集合必须**恰好等于**
//	   下面的登记表（多一个 = 先判定写/读，读侧一律不得收紧；少一个 = 名字面判据
//	   可能已从某条路径上脱落）。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-10/REPORT.md）
//
//   - `IsAppID` 去掉保留名判据（退回纯形态）⇒ ①② 红；
//   - 保留名判据只对**部分**名字生效（例如表里少 `aux`）⇒ ① 红；
//   - 把判据改成"拒一切含 'n' 的名字"（过度收紧）⇒ ① 的负控与 ② 的负控红；
//   - 在读原语（`ListContents`/`ExtractFileContent`）上挂保留名判据 ⇒ ③ 红；
//   - 新增一处名字面调用点（例如列表路径）⇒ ④ 红。

import (
	"archive/zip"
	"bytes"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/archiveutil"
)

// windowsReservedDeviceNamesNameFace 是**判据侧**的期望集合（22 项，按 Microsoft
// 文档）。它与 `archiveutil.windowsReservedDeviceNames` 的集合相等这件事由
// archiveutil 的跨端对拍判据（读客户端 TS 源码）钉住；这里只断言"名字面必须拒它们"，
// 不再复制实现逻辑。
var windowsReservedDeviceNamesNameFace = []string{
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
}

// titleCaseASCII 把首字母大写（只用于造 `Con` 这种形态；`strings.Title` 已废弃，
// 不想为一个测试形态引入 staticcheck 噪音）。
func titleCaseASCII(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// TestIsAppIDRejectsWindowsReservedDeviceNames 是①。
func TestIsAppIDRejectsWindowsReservedDeviceNames(t *testing.T) {
	for _, name := range windowsReservedDeviceNamesNameFace {
		if IsAppID(name) {
			t.Errorf("IsAppID(%q) = true：保留设备名在 Windows 上连目录都建不出来，"+
				"放它进库 = 审核通过但客户端装不上", name)
		}
		// 大小写 / 尾随点空格 / 扩展名形态：先由**复用来的谓词**自己咬住
		// （这条断言独立于形态正则，形态以后若放宽它仍然成立），
		// 再看 `IsAppID` 的最终结论 —— 两条口径都必须给出"拒"。
		for _, variant := range []string{strings.ToUpper(name), titleCaseASCII(name), name + ".", name + " ", name + ".txt"} {
			if !archiveutil.IsWindowsReservedDeviceNameSegment(variant) {
				t.Errorf("archiveutil.IsWindowsReservedDeviceNameSegment(%q) = false："+
					"复用来的谓词必须自己处理大小写/尾随点空格/扩展名（它是唯一一张表的所有者）", variant)
			}
			if IsAppID(variant) {
				t.Errorf("IsAppID(%q) = true：大小写/尾随点空格/扩展名形态同样落不了盘", variant)
			}
		}
	}
	// 负控：像但不是保留名的必须照旧通过（否则就是"把所有名字都拒掉"式的假绿）。
	for _, ok := range []string{
		"console", "printer", "auxiliary", "null", "nullable",
		"com0", "com10", "lpt0", "lpt10", "con-man", "prn-2", "com-1", "nul2", "conx",
	} {
		if !IsAppID(ok) {
			t.Errorf("IsAppID(%q) = false：它不是保留设备名（文档边界内），不得误杀", ok)
		}
	}
}

// TestWriteGatesRejectReservedDeviceName 是②：两条真正的闸门函数。
func TestWriteGatesRejectReservedDeviceName(t *testing.T) {
	for _, name := range []string{"con", "CON", "nul", "aux", "com1", "lpt9", "prn"} {
		// 闸门 1：包内 SKILL.md 的 name（上传/审核/内置技能自检共用）。
		md := goodMD(map[string]string{"name": name})
		_, err := Parse(entries(), md, name)
		assertCode(t, err, CodeInvalidAppID, "name")

		// 闸门 2：管理端"规范化"重打包（产出新版本，AppID 来自 DB 行）。
		if _, _, nerr := NormalizeSkillMD(md, NormalizeOptions{
			AppID: name, Version: "1.0.0", Author: "ops", Category: "通用",
		}); nerr == nil {
			t.Errorf("NormalizeSkillMD(AppID=%q) 未报错：存量/新增的保留名会经规范化路径产出新版本", name)
		} else {
			assertCode(t, nerr, CodeInvalidAppID, "name")
		}
	}
	// 负控：合法名字两条闸门都必须照旧放行。
	for _, name := range []string{"console", "com10", "auxiliary", "team-knowledge-wiki"} {
		md := goodMD(map[string]string{"name": name})
		if _, err := Parse(entries(), md, name); err != nil {
			t.Fatalf("Parse(name=%q) 意外失败: %v（误杀合法名字）", name, err)
		}
		if _, _, err := NormalizeSkillMD(md, NormalizeOptions{
			AppID: name, Version: "1.0.0", Author: "ops", Category: "通用",
		}); err != nil {
			t.Fatalf("NormalizeSkillMD(AppID=%q) 意外失败: %v（误杀合法名字）", name, err)
		}
	}
}

// legacyReservedNameArchive 造一个"存量"形态的归档 —— 两个面都命中保留名：
//   - **名字面**：应用名是 `con`（全仓唯一写侧闸门现在必须拒它）；
//   - **条目面**：含 `references/aux.md`（R21F-04 的形态；那次刻意**只**在
//     `Validate` 上判，读原语一律不加闸，存量旧行的预览/下载才不会被 422 打掉）。
//
// 用"两个面都命中的存量包"做样本，才能一次测到"写侧收紧、读侧一字不动"这条界线。
func legacyReservedNameArchive(t *testing.T) []byte {
	t.Helper()
	files := map[string]string{
		"SKILL.md":              goodMD(map[string]string{"name": "con"}),
		"references/notes.md":   "# 索引\n\n把常见问题的查询路径写在这里。\n",
		"references/aux.md":     "# 保留名条目\n\n存量包里可能已经存在这种名字的条目。\n",
		"references/second.md":  "# 第二份索引\n\n补充分类与检索关键词。\n",
		"references/third.md":   "# 第三份索引\n\n财务报销与差旅制度入口。\n",
		"references/fourth.md":  "# 第四份索引\n\n人事服务与商业保险入口。\n",
		"references/fifth.md":   "# 第五份索引\n\n行政与办公用品申请入口。\n",
		"references/sixth.md":   "# 第六份索引\n\nIT 服务与账号权限申请入口。\n",
		"references/seventh.md": "# 第七份索引\n\n合规与信息安全问答入口。\n",
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(files[name])); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestLegacyReservedNameArchiveIsStillReadable 是③：**读侧行为不变**。
//
// 同一个存量归档（应用名 `con` + 条目 `references/aux.md`）：
//   - 写侧：包内 name 校验必须拒；归档审核闸门（R21F-04）也必须拒；
//   - 读原语（`ListContents` / `ExtractFileContent` —— 列表、管理端预览与下载路径
//     用的就是它们）必须逐字照旧：条目清单里仍有 `references/aux.md`，
//     **连那个保留名条目本身的正文都读得出来**。
//
// 这条线不许越过：把保留名判据挂到读原语（或 `NormalizePath`）上，存量库里这类行的
// 列表/预览会从"可用"变成 422 —— 那是存量破坏，而它本来就只是"装不上"（不是读不到）。
func TestLegacyReservedNameArchiveIsStillReadable(t *testing.T) {
	archive := legacyReservedNameArchive(t)
	lim := archiveutil.DefaultLimits("SKILL.md")

	// **读侧先断言**（顺序有意）：本用例的核心主张是"读侧一字不动"，所以让它先失败。
	// 条目清单、SKILL.md 正文、**保留名条目本身**的正文都必须照旧可用。
	entries, skillMD, err := archiveutil.ListContents(archive, lim, MaxSkillMDBytes)
	if err != nil {
		t.Fatalf("ListContents 失败（读侧被收紧了：列表/预览/下载路径会 422）: %v", err)
	}
	if len(entries) != 9 {
		t.Fatalf("ListContents 条目数 = %d, want 9（读侧行为变了）: %v", len(entries), entries)
	}
	if !containsString(entries, "references/aux.md") {
		t.Fatalf("条目清单里丢了 references/aux.md（读侧行为变了）: %v", entries)
	}
	if !strings.Contains(skillMD, "name: con") {
		t.Fatalf("ListContents 没返回 SKILL.md 正文（读侧行为变了）: %q", skillMD)
	}
	content, size, found, binary, tooLarge, xerr := archiveutil.ExtractFileContent(archive, "references/aux.md", MaxSkillMDBytes)
	if xerr != nil || !found || binary || tooLarge {
		t.Fatalf("ExtractFileContent 读存量归档的保留名条目失败: err=%v found=%v binary=%v tooLarge=%v", xerr, found, binary, tooLarge)
	}
	if size == 0 || !strings.Contains(content, "存量包") {
		t.Fatalf("ExtractFileContent 内容为空或不对: size=%d content=%q", size, content)
	}

	// 写侧闸门 1：包内 name 校验（名字面）。
	if _, perr := Parse(entries, skillMD, "con"); perr == nil {
		t.Fatal("Parse(name=con) 未报错：写侧闸门没生效")
	}

	// 写侧闸门 2：归档条目面的审核闸门（R21F-04，本用例与它**有意耦合** ——
	// 样本要同时命中两个面，"写侧收紧、读侧不动"的对比才成立）。
	if _, verr := archiveutil.Validate(archive, lim); !errors.Is(verr, archiveutil.ErrReservedName) {
		t.Fatalf("Validate 对含 references/aux.md 的归档未判保留名（条目面闸门 R21F-04 被摘掉？）: %v", verr)
	}
}

// containsString 是判据侧的小工具（避免为一个断言引入 slices 依赖顺序问题）。
func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// appIDCallSites 是「调用点 → 写/读 → 是否收紧」的**可执行**版本（报告 §② 的表就是它）。
//
// 为什么必须可执行：本次收紧落在共享谓词 `IsAppID` 上 —— 收益是"一处收口、以后新增
// 路径自动被覆盖"，代价是**任何**调用点都会跟着变严。而"读侧路径不得收紧"这条约束
// （存量库里可能已经存在这类名字，读侧收紧会让列表/下载/加载突然失效）只靠注释守不住。
// 这张表把两侧都钉住：表内门禁被删/改名 ⇒ 红；出现表外调用点 ⇒ 红。
//
// 两条**既有行**上的收紧是本表里唯一需要解释的（不是新缺陷，但要知道代价）：
//   - `transferOwner`（既有 App 行的归属转移）：改名不存在的存量行不再能转移归属；
//   - `removeLock`（既有锁记录的解除）：存量锁不再能经 API 解除 —— 两者都只会让
//     "本来就装不上、也不该再被发布"的名字**冻结**，不会影响任何读面（列表/下载/加载
//     都不经 IsAppID）；详见报告 §②「存量影响论证」。
var appIDCallSites = []struct {
	File string // server 模块内相对路径（POSIX）
	Func string // 调用点所在的顶层函数
	Role string // 该调用点的角色（为什么收紧是安全的 / 有什么代价）
}{
	{"internal/sharedskills/routes.go", "upload", "写侧闸门：员工上传技能的第一道名字面检查"},
	{"internal/appstore/publish.go", "Publish", "写侧闸门：统一发布内核，三条上传路径共用"},
	{"internal/marketplace/admin.go", "createSkillAdmin", "写侧闸门：管理端登记市场技能"},
	{"internal/marketplace/agent_api.go", "createAgentAdmin", "写侧闸门：管理端登记市场智能体"},
	{"internal/sharedskills/routes.go", "setLock", "写侧闸门：管理员锁定能力名（预留一个待上架的名字）"},
	{"internal/skillmanifest/manifest.go", "Parse", "写侧闸门：包内 name（上传/审核/内置技能自检共用）"},
	{"internal/skillmanifest/normalize.go", "NormalizeSkillMD", "写侧闸门：管理端规范化重打包（产出新版本）"},
	{"internal/appstore/admin.go", "transferOwner", "写（既有行）：归属转移 —— 只冻结，不影响读面"},
	{"internal/sharedskills/routes.go", "removeLock", "写（既有行）：解除锁记录 —— 只冻结，不影响读面"},
	{"internal/wasmapp/skillseed/skillseed.go", "loadSkill", "随包内置技能的自举校验（内容随包；实测零命中）"},
}

// TestIsAppIDCallSitesAreWriteGatesOnly 是④。
func TestIsAppIDCallSitesAreWriteGatesOnly(t *testing.T) {
	root := skillmanifestModuleRoot(t)
	got := collectIsAppIDCallSites(t, root)

	want := make(map[string]string, len(appIDCallSites))
	for _, s := range appIDCallSites {
		if strings.TrimSpace(s.Role) == "" {
			t.Fatalf("登记表里 %s 的角色为空（表必须自解释写/读与代价）", s.File)
		}
		want[s.File+"|"+s.Func] = s.Role
	}
	seen := make(map[string]bool, len(got))
	for _, s := range got {
		key := s.File + "|" + s.Func
		if _, ok := want[key]; !ok {
			t.Errorf("出现表外的名字面判据调用点 %s（%s:%d）：先判定它是**写侧闸门**还是**读侧路径**，"+
				"读侧（列表/详情/下载/加载）一律不得收紧 —— 存量库里已存在的这类名字会突然失效；"+
				"确认后把该点补进 appIDCallSites 并写明角色与代价", key, s.File, s.Line)
			continue
		}
		seen[key] = true
	}
	for _, s := range appIDCallSites {
		if !seen[s.File+"|"+s.Func] {
			t.Errorf("登记的名字面闸门 %s（%s：%s）不再调用 IsAppID：判据可能已从这条路径上脱落"+
				"（删/改名都要同步本表）", s.File, s.Func, s.Role)
		}
	}
	// 表本身不能退化成"什么都收"：至少要有发布内核与包内 name 两道。
	for _, must := range []string{"internal/appstore/publish.go|Publish", "internal/skillmanifest/manifest.go|Parse"} {
		if _, ok := want[must]; !ok {
			t.Fatalf("登记表缺了 %s（名字面的关键闸门）", must)
		}
	}
}

type appIDCallSite struct {
	File string
	Func string
	Line int
}

// collectIsAppIDCallSites 用 AST 枚举 server 生产源码里的 `IsAppID(...)` 调用点
// （注释里的字样不算 —— 本仓的 marketplace 注释里就有 `skillmanifest.IsAppID)`）。
func collectIsAppIDCallSites(t *testing.T, moduleRoot string) []appIDCallSite {
	t.Helper()
	var out []appIDCallSite
	seen := map[string]bool{}
	for _, rel := range []string{"internal", "cmd"} {
		base := filepath.Join(moduleRoot, rel)
		werr := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fset := token.NewFileSet()
			file, perr := parser.ParseFile(fset, path, nil, 0)
			if perr != nil {
				t.Fatalf("解析 %s: %v", path, perr)
			}
			relPath, rerr := filepath.Rel(moduleRoot, path)
			if rerr != nil {
				t.Fatalf("相对路径 %s: %v", path, rerr)
			}
			relPath = filepath.ToSlash(relPath)
			for _, decl := range file.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok {
					continue
				}
				ast.Inspect(fd, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					name := ""
					switch fun := call.Fun.(type) {
					case *ast.Ident:
						name = fun.Name
					case *ast.SelectorExpr:
						name = fun.Sel.Name
					}
					if name != "IsAppID" {
						return true
					}
					key := relPath + "|" + fd.Name.Name
					if seen[key] {
						return true
					}
					seen[key] = true
					out = append(out, appIDCallSite{File: relPath, Func: fd.Name.Name, Line: fset.Position(call.Pos()).Line})
					return true
				})
			}
			return nil
		})
		if werr != nil {
			t.Fatalf("遍历 %s: %v", base, werr)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Line < out[j].Line
	})
	if len(out) == 0 {
		t.Fatal("一个调用点都没扫到：判据失效（路径推断错或谓词被删），必须红")
	}
	return out
}

// skillmanifestModuleRoot 返回 server/ 目录（测试工作目录恒为包目录）。
func skillmanifestModuleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("取工作目录: %v", err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", ".."))
	if _, serr := os.Stat(filepath.Join(root, "go.mod")); serr != nil {
		t.Fatalf("推断的模块根 %s 不含 go.mod: %v", root, serr)
	}
	return root
}
