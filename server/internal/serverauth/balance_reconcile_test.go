package serverauth

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// R4-C-6（审计 2026-09-23，P3）：余额对账面在**查询失败**时双双回落 0，
// 把"读失败"显示成"余额 0 / 账已对平"。
//
// 缺陷形态（修复前）：
//
//	sum, _ := serverstore.BalanceLedgerSum(a.DB, id)     // 错误被丢弃 ⇒ sum=0
//	"balance_money": QuantizeMoney(u2BalanceMoney(a, id)) // 查询失败 ⇒ return 0
//
// 两个字段同时为 0 ⇒ 面板显示"ledger_sum 0 / balance_money 0"。对余额本就为 0 的
// 用户，"这次没读出来"与"账本与余额一致（都是 0）"在响应里**逐字节相同** ——
// 与仓库对"读失败必须 fail-loud"的既定纪律（审核开关、模型清单、webadmin 写面
// 闸门）相反。
//
// 判据：读失败必须返回错误（HTTP 500 + JSON 错误信封），绝不回落成 0/已对平。
//
// 为什么用注入读点而不是构造真库故障：真实 PG 上无法确定性构造"用户存在、但余额
// 查询失败"的形态（存在性检查与两次读走同一个库，库打停会让存在性检查先失败、
// 走另一条 500 分支）。注入点见 admin.go 的 balanceReaders / AdminAPI.balanceReaders。
//
// 变异验证：把 `reconcileUserBalance` 的两处 `return …, err` 改回 `return 0,…`（或
// 把 handler 的 rerr 分支删掉）⇒ 本文件的用例红。
func TestReconcileUserBalanceFailsLoudOnReadErrors(t *testing.T) {
	okUser := func(id int64) (*serverstore.User, error) {
		return &serverstore.User{ID: id, BalanceMoney: 12.5}, nil
	}
	okSum := func(id int64) (float64, error) { return 12.5, nil }
	boomUser := func(id int64) (*serverstore.User, error) { return nil, errors.New("db down") }
	boomSum := func(id int64) (float64, error) { return 0, errors.New("db down") }

	// ① 两处都成功：两个值都拿到（对平）。
	sum, bal, err := reconcileUserBalance(balanceReaders{user: okUser, sum: okSum}, 7)
	if err != nil || sum != 12.5 || bal != 12.5 {
		t.Fatalf("成功路径 = (%.2f, %.2f, %v), want (12.5, 12.5, nil)", sum, bal, err)
	}
	// ② 账本读失败：必须报错，且**不得**返回"看起来对平"的 0/0。
	sum, bal, err = reconcileUserBalance(balanceReaders{user: okUser, sum: boomSum}, 7)
	if err == nil {
		t.Fatalf("账本合计读失败却返回成功 (%.2f, %.2f) —— 读失败被显示成「余额 0/已对平」", sum, bal)
	}
	if !errors.Is(err, errReconcileLedgerRead) {
		t.Fatalf("err = %v, want errReconcileLedgerRead（文案要能区分是哪一个读点失败）", err)
	}
	// ③ 余额读失败：同上。
	sum, bal, err = reconcileUserBalance(balanceReaders{user: boomUser, sum: okSum}, 7)
	if err == nil {
		t.Fatalf("余额读失败却返回成功 (%.2f, %.2f)", sum, bal)
	}
	if !errors.Is(err, errReconcileUserRead) {
		t.Fatalf("err = %v, want errReconcileUserRead", err)
	}
	// ④ 真 0 与读不到必须可分：余额真的是 0 且读成功 ⇒ nil 错误 + 0。
	sum, bal, err = reconcileUserBalance(balanceReaders{
		user: func(int64) (*serverstore.User, error) { return &serverstore.User{}, nil },
		sum:  func(int64) (float64, error) { return 0, nil },
	}, 7)
	if err != nil || sum != 0 || bal != 0 {
		t.Fatalf("真 0 场景 = (%.2f, %.2f, %v), want (0, 0, nil)", sum, bal, err)
	}
}

// TestUserBalanceLedgerEndpointFailsLoudOnReadError 是同一判据的**端到端**形态：
// 读点失败时端点必须回 500 + 错误信封，而不是 200 + ledger_sum=0/balance_money=0
// （后者正是"0 / 已对平"的假象）。
func TestUserBalanceLedgerEndpointFailsLoudOnReadError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := mustDB(t)
	uid, err := createUserDB(db, "reconcile-emp", "pw123456", false)
	if err != nil {
		t.Fatal(err)
	}
	call := func(readers *balanceReaders) *httptest.ResponseRecorder {
		t.Helper()
		a := &AdminAPI{DB: db, balanceReaders: readers}
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/server/admin/users/1/balance/ledger", nil)
		c.Params = gin.Params{{Key: "id", Value: strconv.FormatInt(uid, 10)}}
		a.userBalanceLedger(c)
		return w
	}

	// 生产读点：真库 + 真用户 ⇒ 200，两个字段都读出来了（I1 成立时相等）。
	ok := call(nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("生产读点应 200，得到 %d %s", ok.Code, ok.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(ok.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, hasSum := body["ledger_sum"]; !hasSum {
		t.Fatalf("响应缺少 ledger_sum: %s", ok.Body.String())
	}

	// 注入账本读失败：必须 500 + 错误信封，且**不得**出现 ledger_sum=0 的 200。
	failLedger := balanceReaders{
		user: func(id int64) (*serverstore.User, error) { return serverstore.GetUserByID(db, id) },
		sum:  func(int64) (float64, error) { return 0, errors.New("relation \"balance_ledger\" does not exist") },
	}
	w := call(&failLedger)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("账本读失败应 500（fail-loud），得到 %d %s —— 回落 0 会让面板显示「已对平」", w.Code, w.Body.String())
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("错误响应必须是 JSON 信封: %s", w.Body.String())
	}
	if envelope.Error.Code != "INTERNAL" || envelope.Error.Message == "" {
		t.Fatalf("错误信封 = %+v，want code=INTERNAL 且 message 非空（文案要可行动）", envelope.Error)
	}
	if _, hasSum := body["ledger_sum"]; hasSum && w.Code == http.StatusOK {
		t.Fatalf("读失败路径不得返回对账字段")
	}

	// 注入余额读失败：同样必须 500（而不是 balance_money=0）。
	failBalance := balanceReaders{
		user: func(int64) (*serverstore.User, error) { return nil, errors.New("db down") },
		sum:  func(id int64) (float64, error) { return serverstore.BalanceLedgerSum(db, id) },
	}
	w = call(&failBalance)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("余额读失败应 500，得到 %d %s", w.Code, w.Body.String())
	}
}
