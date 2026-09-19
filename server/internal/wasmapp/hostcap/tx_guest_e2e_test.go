// Package hostcap_test 放的是**guest 级**端到端回归：真编译参考实现（refapp）为
// wasip1 模块、真跑 wazero 运行时、真开应用 SQLite 库（appdb）。
//
// 为什么要单列这一层（模块 H 审计 P0-1 的核心教训）：`db.tx` 的缺陷之所以长期隐形，
// 正是因为此前只有 Dispatch 层的测试 —— Dispatch 层看到的是"事务内调用被拒"，
// 而参考样例又把事务体写成零 SQL，两边都自洽。guest 级用例把整条链路串起来：
// 应用真的 begin → db.exec → db.query → commit，宿主真的落盘，读回的行真的在库里。
//
// 依赖方向说明：本包（hostcap）不被 runtime / appdb 引用，所以测试侧 import 它们
// 不构成环；用具名外部测试包（hostcap_test）进一步保证"只用公开能力面"。
package hostcap_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/hostcap"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// ===== 夹具 =====

var (
	refappOnce sync.Once
	refappWasm []byte
	refappErr  error
)

// refappModule 现场把参考实现编译成 wasip1 模块（整包复用一次）。
//
// 不入库任何二进制：判据必须是"当前源码"编出来的 guest（改了 refapp 的事务演示，
// 本用例立刻跟着变），否则样例与回归会各说各话。
func refappModule(t *testing.T) []byte {
	t.Helper()
	refappOnce.Do(func() {
		out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
		if err != nil {
			refappErr = err
			return
		}
		root := strings.TrimSpace(string(out))
		dir, err := os.MkdirTemp("", "picoaide-hostcap-guest-")
		if err != nil {
			refappErr = err
			return
		}
		bin := filepath.Join(dir, "refapp.wasm")
		cmd := exec.Command("go", "build", "-o", bin, "./internal/wasmapp/refapp")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			refappErr = err
			_ = b
			return
		}
		refappWasm, refappErr = os.ReadFile(bin)
	})
	if refappErr != nil {
		t.Fatalf("编译 wasip1 参考实现失败（需要本机 Go 支持 wasip1）: %v", refappErr)
	}
	return refappWasm
}

// stubAssets 提供一份"存在 picoaide.app.json"的包内资源面。
type stubAssets struct{}

func (stubAssets) Read(p string) (string, []byte, error) {
	if p != "picoaide.app.json" {
		return "", nil, os.ErrNotExist
	}
	return "application/json", []byte(`{"login_required":true}`), nil
}

func (stubAssets) List() []string { return []string{"picoaide.app.json"} }

type stubSink struct{ lines []string }

func (s *stubSink) Log(level, message string) { s.lines = append(s.lines, level+":"+message) }
func (s *stubSink) Dropped() int              { return 0 }

// hostCallRecord 是 refapp 响应体里的 host_calls 条目（应用侧看到的形态）。
type hostCallRecord struct {
	Method string            `json:"method"`
	OK     bool              `json:"ok"`
	Result json.RawMessage   `json:"result"`
	Error  *abi.RPCErrorBody `json:"error"`
}

type guestSummary struct {
	ABI       string           `json:"abi"`
	AppID     string           `json:"app_id"`
	HostCalls []hostCallRecord `json:"host_calls"`
}

// ===== 用例 =====

// TestGuestTxBodyReadWriteEndToEnd 是 FIX-1 的 guest 级证据：
// 参考实现（真 wasm）在事务内 db.exec + db.query 必须成功，且
//   - 事务内读到的行**包含本事务未提交的写**（同一条连接上的一致视图）；
//   - tx_commit 之后行真的落盘；tx_rollback 的那一行真的不在库里。
//
// 变异验证：把 db.query/db.exec 从 abi.TxAllowedWhileInTx 的允许集里去掉
// （缺陷原状）⇒ 两条事务内调用变成 DB_DENIED/host_call_in_tx、库里没有行 ⇒ 本用例红。
func TestGuestTxBodyReadWriteEndToEnd(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	const appID = "tx-demo"

	db, err := appdb.Open(ctx, appdb.Options{DataRoot: root, AppID: appID})
	if err != nil {
		t.Fatalf("打开应用库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	sink := &stubSink{}
	caps := &hostcap.Capabilities{
		AppID:   appID,
		Version: "1.0.0",
		User:    &abi.User{ID: 7, Username: "zhangwei", DisplayName: "张伟", Dept: "研发部"},
		DB:      db,
		Assets:  stubAssets{},
		Logs:    sink,
	}

	rt, err := runtime.New(ctx, runtime.Options{DataRoot: root})
	if err != nil {
		t.Fatalf("装配运行时失败: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(ctx) })

	mod, err := rt.CompileModule(ctx, refappModule(t))
	if err != nil {
		t.Fatalf("编译 guest 失败: %v", err)
	}
	res, serr := rt.Serve(ctx, mod, runtime.Request{
		Envelope: abi.Request{
			ABI:     abi.ABIVersion,
			AppID:   appID,
			Version: "1.0.0",
			Auth:    abi.AuthInfo{Mode: abi.AuthModeLogin, Verified: true},
			User:    caps.User,
			Method:  "POST",
			Path:    "/",
			Query:   map[string]string{},
			Headers: map[string]string{},
		},
		Funcs: caps,
	})
	if serr != nil {
		t.Fatalf("guest 执行失败（连跑都没跑起来）: %v", serr)
	}
	if !res.OK() {
		t.Fatalf("guest 未给出成功响应: %v", res.KillReason)
	}
	if res.Response.Status != 200 {
		t.Fatalf("guest 响应 status = %d（body=%s）", res.Response.Status, res.Response.Body)
	}

	var summary guestSummary
	if err := json.Unmarshal([]byte(res.Response.Body), &summary); err != nil {
		t.Fatalf("响应体不是 summary JSON: %v（body=%s）", err, res.Response.Body)
	}
	if summary.ABI != abi.ABIVersion || summary.AppID != appID {
		t.Fatalf("响应体没有回显身份: %+v", summary)
	}

	// 1) 每一条宿主调用都必须成功 —— 这就是"事务内 SQL 可用"的 guest 级证据。
	//    （缺陷原状下，事务内的 db.exec / db.query 会是 DB_DENIED/host_call_in_tx。）
	for _, rec := range summary.HostCalls {
		if !rec.OK || rec.Error != nil {
			t.Fatalf("guest 的宿主调用 %s 失败: %+v（事务内只允许数据库读写）", rec.Method, rec.Error)
		}
	}

	// 2) 按事务切分调用序列：tx#1 的事务体必须是 exec+query，tx#2 的事务体必须含 exec。
	type txBody struct {
		commit bool
		calls  []hostCallRecord
	}
	var txBodies []txBody
	for _, rec := range summary.HostCalls {
		switch rec.Method {
		case abi.MethodTxBegin:
			txBodies = append(txBodies, txBody{})
		case abi.MethodTxCommit:
			txBodies[len(txBodies)-1].commit = true
		case abi.MethodTxRollback:
			// commit 保持 false
		default:
			if len(txBodies) > 0 {
				txBodies[len(txBodies)-1].calls = append(txBodies[len(txBodies)-1].calls, rec)
			}
		}
	}
	if len(txBodies) != 2 {
		t.Fatalf("参考实现应当演示两个事务，实际 %d", len(txBodies))
	}
	if !txBodies[0].commit {
		t.Fatal("tx#1 应当是 begin → 写 → 读 → commit")
	}
	var inTxMethods []string
	for _, rec := range txBodies[0].calls {
		inTxMethods = append(inTxMethods, rec.Method)
	}
	if strings.Join(inTxMethods, ",") != abi.MethodDBExec+","+abi.MethodDBQuery {
		t.Fatalf("tx#1 的事务体 = %v, want [db.exec db.query]", inTxMethods)
	}
	if len(txBodies[1].calls) == 0 || txBodies[1].calls[0].Method != abi.MethodDBExec || txBodies[1].commit {
		t.Fatalf("tx#2 应当是 begin → exec → rollback，实际 %+v", txBodies[1])
	}

	// 3) 事务内 db.query 真的看到了**本事务未提交**的写（appdb 的事务内查询走事务连接）。
	var qr abi.QueryResult
	if err := json.Unmarshal(txBodies[0].calls[1].Result, &qr); err != nil {
		t.Fatalf("事务内 db.query 的结果不是 QueryResult: %v（raw=%s）", err, txBodies[0].calls[1].Result)
	}
	if len(qr.Rows) != 1 || len(qr.Rows[0]) != 1 || qr.Rows[0][0] != "第一条" {
		t.Fatalf("事务内读到的行 = %+v, want [[第一条]]（同连接一致视图）", qr.Rows)
	}

	// 4) 真实落盘证据：commit 的行在库里；rollback 的行不在库里。
	after, err := db.Query(ctx, abi.SQLParams{SQL: "SELECT title FROM notes"})
	if err != nil {
		t.Fatalf("事务结束后查询失败: %v", err)
	}
	var titles []string
	for _, row := range after.Rows {
		if len(row) > 0 {
			titles = append(titles, row[0].(string))
		}
	}
	if strings.Join(titles, ",") != "第一条" {
		t.Fatalf("库里的行 = %v, want 只有 [第一条]（rollback 的那条必须不在）", titles)
	}

	// 5) 事务外的能力照常：log 恰好一次（事务内它会被拒，所以"恰好一次"同时也是
	//    "参考实现没有把它放进事务体"的证据）。
	if len(sink.lines) != 1 {
		t.Fatalf("log 落 sink 条数 = %d, want 1（%v）", len(sink.lines), sink.lines)
	}
}
