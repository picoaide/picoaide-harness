package api

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 本文件是审计 FW-E §6.4 登记的「**面外**」判据化（2026-10-04，修复代理 P2）：
//
//	`uploadCreate` / `uploadChunk` / `uploadAbort` **不做** `ClientBudgetHeader` 处理。
//
// # 判定：**设计如此**（不是漏做）
//
// 设计真源 `docs/planning/2026-09-17-wasm-app-platform.md`（§「发布链路的跨端预算头
// （`X-Pico-Client-Budget-Ms`，2026-10-04 审计 FW-2）」）逐字写着：
//
//	「**三条发布入口**（`validate` / `:app_id/releases` / `uploads/:id/complete`）都接受这个
//	 可选请求头，语义是"客户端在**这一跳**还会等多少毫秒"…分片链必须带它（`complete` 是唯一
//	 在服务端真编译的一跳，而客户端的 90 s 是**整条链**共用的），单发 `publish`/`validate`
//	 不需要（它们的客户端预算就是整份 90 s）。」
//
// 为什么这三条**不在**契约里（三条理由，按重要性）：
//
//  1. **没有可钳的"平台侧总预算"**：这份头存在的唯一目的是保证"平台给出结论的时刻
//     **严格早于**客户端放弃的时刻"（FW-2 的序关系）。开会话只写一份 `meta.json`、PUT 一片
//     只做一次有界写入、放弃会话只删目录 —— 三者都没有"编译 + 干跑"这类可以跑掉几十秒的阶段，
//     也就没有需要与客户端剩余额度对齐的东西。给它们挂一个 deadline 只会把"本来毫秒级
//     完成的写入"变成一条新的拒绝路径。
//  2. **拒绝只会伤害续传**：客户端在链尾（剩余额度不足传输余量）时最需要的是"把手上这片
//     PUT 出去、把 complete 交给**下一次调用**"；如果 PUT 也按声明额度拒绝，客户端连
//     断点续传的最后一步都做不成 —— 而这一跳本来不会越过它的出站预算。
//  3. **头是有意"可选"的**（三态回落，永不放大）：缺省/非法/越界一律回落平台默认预算。
//     对这三条入口，"回落"的等价物就是"什么都不做"。
//
// # 判据（两半，各自独立）
//
//   - **行为面**：带上"连传输余量都不够"的极小声明（`1000`）与三种非法/越界声明之后，
//     这三条入口的响应与**不带**这个头时同类（201 / 200 / 200 + `deleted:true`），
//     且会话**完全可用**（接着 PUT + complete 到 201）。反向标定：同一个头在 `complete`
//     上真的会被读成 0 预算 ⇒ 504（否则"忽略"可能只是因为整条链路都没读这个头）；
//   - **结构面**：三个 handler 的函数体里**不得**出现预算挂载/拒绝调用
//     （`h.publishBudgetFor` / `h.publishBudgetRefusal` / `h.publishBudgetCtx`）——
//     行为面看不见"只挂 deadline 不拒绝"这种半接线形态，结构面看得见。
//
// 变异验证（实跑见交付报告 temp/audit-v282/fixes/P2.md）：给 `uploadCreate` 接上
// `publishBudgetFor` + `publishBudgetRefusal`（= "顺手把预算面铺到分片链全部入口"）⇒
// ① 变 504 ⇒ 行为面红，同时结构面红。
func TestNonPublishUploadEntriesIgnoreClientBudgetHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const tinyBudget = "1000"
	// 非法/越界声明的四种形态（三态校验的覆盖面：非十进制、≤0、超上界、空白）。
	garbageBudgets := []string{"abc", "0", "999999999999", "   "}

	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	cfg := goodConfig()
	token := env.tokens["alice"]

	// ---- ① 开会话：极小声明 ⇒ 仍然 201 ----
	create := func(t *testing.T, app string, budget string) uploadCreated {
		t.Helper()
		body := map[string]any{
			"app_id": app, "version": "1.0.0",
			"total_bytes": int64(len(wasm)), "chunk_bytes": chunk,
		}
		var w *httptest.ResponseRecorder
		if budget == "" {
			w = env.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token, body)
		} else {
			w = env.reqWithBudget(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token, body, budget)
		}
		if w.Code != http.StatusCreated {
			t.Fatalf("开会话（声明 %q）= %d（%s），want 201 —— "+
				"`POST /uploads` 不在跨端预算契约里（设计真源逐字写着「三条发布入口」），"+
				"它本来就没有可钳的总预算；把它拒掉只会让客户端连断点续传的最后一步都做不成",
				budget, w.Code, w.Body.String())
		}
		out := uploadCreated{}
		env.decodeJSON(w, http.StatusCreated, &out)
		return out
	}
	sess := create(t, "budget-outside-app", tinyBudget)

	// ---- ② 分片 PUT：极小声明 ⇒ 仍然 200 ----
	w := env.rawReqWithBudget(http.MethodPut, uploadChunkPath(sess.UploadID, 0), token, parts[0], tinyBudget)
	if w.Code != http.StatusOK {
		t.Fatalf("上传第 0 片（声明 %q）= %d（%s），want 200 —— 分片 PUT 不在跨端预算契约里",
			tinyBudget, w.Code, w.Body.String())
	}

	// ---- ③ 放弃会话：极小声明 ⇒ 仍然 200 + JSON 信封 ----
	w = env.rawReqWithBudget(http.MethodDelete, uploadPath(sess.UploadID), token, nil, tinyBudget)
	if w.Code != http.StatusOK {
		t.Fatalf("放弃会话（声明 %q）= %d（%s），want 200", tinyBudget, w.Code, w.Body.String())
	}
	var deleted struct {
		UploadID string `json:"upload_id"`
		Deleted  bool   `json:"deleted"`
	}
	env.decodeJSON(w, http.StatusOK, &deleted)
	if !deleted.Deleted || deleted.UploadID != sess.UploadID {
		t.Fatalf("放弃会话的响应不对：%s（want {upload_id:%s, deleted:true}）", w.Body.String(), sess.UploadID)
	}

	// ---- ④ 非法/越界声明同样不影响这三条入口（三态回落，不是"非法即拒"）----
	for i, budget := range garbageBudgets {
		s := create(t, "budget-garbage-"+strconv.Itoa(i), budget)
		// 每建一个立刻放弃，避免撞"每用户 4 个并发会话"的上限（会话数本身不是本判据的对象）。
		abort := env.rawReqWithBudget(http.MethodDelete, uploadPath(s.UploadID), token, nil, budget)
		if abort.Code != http.StatusOK {
			t.Fatalf("放弃会话（声明 %q）= %d（%s），want 200", budget, abort.Code, abort.Body.String())
		}
	}

	// ---- ⑤ 反向标定：同一个头在 `complete` 上**真的**会被读成 0 预算 ----
	//
	// 没有这条，①②③④的"忽略"可能只是因为整条链路都没读这个头（判据空转）。
	sess2 := create(t, "budget-inside-app", "")
	for i, part := range parts {
		env.putChunk(token, sess2.UploadID, i, part)
	}
	refused := env.completeWithBudget(t, token, sess2.UploadID, tinyBudget, completeBody("面外标定", cfg), 0)
	if refused.Code != http.StatusGatewayTimeout {
		t.Fatalf("complete 上带极小声明 = %d（%s），want 504 —— "+
			"这条是**正向标定**：头在三入口（validate/publish/complete）上必须真的生效；"+
			"它不生效说明整条链路都没读这个头，本用例的其余断言就失去判别力",
			refused.Code, refused.Body.String())
	}

	// ---- ⑥ 用同一个会话走完：满额声明 ⇒ 201（前面所有的"忽略"都没破坏会话状态）----
	final := env.completeWithBudget(t, token, sess2.UploadID, "90000", completeBody("面外", cfg), 0)
	if final.Code != http.StatusCreated {
		t.Fatalf("满额声明的 complete = %d（%s），want 201", final.Code, final.Body.String())
	}

	// ---- ⑦ 结构面：三个 handler 的函数体不得出现预算挂载/拒绝调用 ----
	assertNoBudgetWiring(t, []string{"uploadCreate", "uploadChunk", "uploadAbort"},
		[]string{"h.publishBudgetFor", "h.publishBudgetRefusal", "h.publishBudgetCtx"})
}

// rawReqWithBudget 与 `rawReq` 同形，额外带 `ClientBudgetHeader`（分片体不是 JSON）。
func (e *testEnv) rawReqWithBudget(method, path, token string, body []byte, budget string) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if budget != "" {
		req.Header.Set(ClientBudgetHeader, budget)
	}
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

// assertNoBudgetWiring 是"这三个入口**不读**那个头"的**结构面**判据。
//
// 判据的取值域 = 三个 handler 的**本地调用闭包**（默认跟 3 层）：不只函数体里直接出现的
// 被调用者，还跟随**包内本地方法与包级函数**的转发 —— 因为"只挂 deadline、不拒绝"这种
// 半接线形态最常见的样子就是**多包一层**：
//
//	func (h *Handlers) uploadCreate(c *gin.Context) {
//	    h.mountBudgetOnly(c)        // ← 包装：内部只调 publishBudgetFor
//	    …
//	}
//
// 第一版只看函数体里的被调用者 ⇒ 这种形态 **PASS**（审计 V-P2P7 的 F-B，变异 V5 实测绕过）。
// 现在跟随本地调用（有界深度、带访问集合防环），并**在失败文案里打出调用路径**
// （`uploadCreate → h.mountBudgetOnly → h.publishBudgetFor`），便于定位是哪一层接上的。
//
// 认账的边界（写清楚，避免下一轮把它当"全覆盖"）：
//   - **不跟**方法链/包外调用（`h.uploads().Create`、`upload.New`）：那些是别的包，
//     本判据的扫描面是"本包内谁把预算面接进来"；
//   - **不跟**函数值/接口/闭包变量（`var mount = func(…)`、`h.cfg.mount(c)`）：
//     那要数据流分析，属独立课题（本包目前没有这种形态）；
//   - 改名的本地方法同样会被跟随（按名字解析，不按源码文本匹配）。
//
// 变异验证（实跑见交付报告「核验后收口」）：
//   - 在 `uploadCreate` 里调一个只挂 deadline 的本地包装方法 ⇒ 本判据红（第一版绿）；
//   - 直接把 `h.publishBudgetFor(c)` 写进 handler ⇒ 红（原有的直接形态）。
func assertNoBudgetWiring(t *testing.T, funcs []string, forbidden []string) {
	t.Helper()
	const rel = "upload.go"

	// ---- 1. 扫包目录下全部**非测试** .go，建"本地可解析的调用目标"表 ----
	//
	// 只收本包的文件：生产代码的接线就在本包里；跟到别的包去会把判据的面无限扩大，
	// 也会让"哪一层接上的"变得不可读。
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读包目录失败: %v（判据的扫描面缺失，拒绝静默通过）", err)
	}
	fset := token.NewFileSet()
	type localFunc struct {
		decl  *ast.FuncDecl
		calls []string
	}
	methods := map[string]localFunc{} // 方法名 → 声明（本包只有 *Handlers 一个接收者类型）
	plain := map[string]localFunc{}   // 包级函数名 → 声明
	for _, ent := range entries {
		name := ent.Name()
		if ent.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, perr := parser.ParseFile(fset, filepath.Join(".", name), nil, 0)
		if perr != nil {
			t.Fatalf("解析 %s 失败（判据的扫描面缺失，拒绝静默通过）: %v", name, perr)
		}
		for _, d := range file.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil || fn.Name == nil {
				continue
			}
			lf := localFunc{decl: fn, calls: calledFuns(t, fset, fn.Body)}
			if fn.Recv != nil && len(fn.Recv.List) > 0 {
				methods[fn.Name.Name] = lf
				continue
			}
			plain[fn.Name.Name] = lf
		}
	}
	if len(methods) == 0 || len(plain) == 0 {
		t.Fatalf("包内本地函数/方法表为空（methods=%d plain=%d）：判据的扫描面缺失，拒绝静默通过",
			len(methods), len(plain))
	}

	// ---- 2. 从每个 handler 出发做有界 BFS ----
	const maxFollowDepth = 3
	// resolve 把"被调用者文本"解析成本包内的声明（解析不出 = 不跟，见上面的边界）。
	resolve := func(call string) (localFunc, bool) {
		if strings.HasPrefix(call, "h.") && !strings.Contains(call[2:], ".") {
			lf, ok := methods[call[2:]]
			return lf, ok
		}
		if !strings.Contains(call, ".") {
			lf, ok := plain[call]
			return lf, ok
		}
		return localFunc{}, false
	}

	for _, entry := range funcs {
		root, ok := methods[entry]
		if !ok {
			t.Fatalf("%s 的 %s 不在本地方法表里（改名/删除？判据的扫描面缺失，拒绝静默通过）",
				rel, entry)
		}
		forbiddenSet := map[string]bool{}
		for _, f := range forbidden {
			forbiddenSet[f] = true
		}
		// BFS：节点 = 声明名；path 记录"从入口到这里的调用链"（失败文案用）。
		type node struct {
			lf    localFunc
			depth int
			path  string
		}
		visited := map[string]bool{entry: true}
		queue := []node{{lf: root, depth: 0, path: entry}}
		hits := map[string]string{} // forbidden 调用 → 调用链
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			for _, call := range cur.lf.calls {
				if forbiddenSet[call] {
					hits[call] = cur.path + " → " + call
					continue
				}
				if cur.depth >= maxFollowDepth {
					continue
				}
				next, ok := resolve(call)
				if !ok || visited[call] {
					continue
				}
				visited[call] = true
				queue = append(queue, node{lf: next, depth: cur.depth + 1, path: cur.path + " → " + call})
			}
		}
		for _, f := range forbidden {
			if path, hit := hits[f]; hit {
				t.Errorf("%s 的**本地调用闭包**里出现了 `%s`（调用链：%s）：这三条入口"+
					"（开会话 / 分片 PUT / 放弃会话）**不在**跨端预算契约里（设计真源 "+
					"docs/planning/2026-09-17-wasm-app-platform.md 逐字写着「三条发布入口」"+
					"= validate / :app_id/releases / uploads/:id/complete）。它们没有可钳的总预算，"+
					"拒绝只会让客户端在链尾做不成断点续传。\n"+
					"  注意：**经一层本地包装转发同样算接线**（审计 V-P2P7 的 F-B 就是这种绕过）。\n"+
					"  若这是有意的行为变更：请同步设计真源、本文件的行为面断言与发布说明。",
					entry, f, path)
			}
		}
	}
}
