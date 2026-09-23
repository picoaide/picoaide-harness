package appproof

// 客户端持有性证明（契约 §20/§23.1）的**机制判据**。
//
// 覆盖四组，每组都能被一处"改坏"单独点红（变异验证写在每条用例的注释里）：
//
//	① 密钥环：启动期生成、0600、每部署一份、轮换后旧密钥仍可验；
//	② 签发：安装签名（nonce/ts/公钥/注册表）—— 缺一不可；
//	③ 校验：绑定 (uid, bearer, install, serverURL, app, exp) —— 每一项各一条用例；
//	④ 一次性：nonce 与 jti 的去重与**有界**（容量满时丢最旧，不整批拒绝）。

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fixture 是一套签发材料（安装密钥 + 服务 + 请求）。
type fixture struct {
	t      *testing.T
	dir    string
	svc    *Service
	pub    ed25519.PublicKey
	priv   ed25519.PrivateKey
	now    time.Time
	userID int64
	bearer string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	svc, err := New(Options{DataRoot: dir, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成安装密钥: %v", err)
	}
	return &fixture{t: t, dir: dir, svc: svc, pub: pub, priv: priv, now: now,
		userID: 42, bearer: strings.Repeat("ab", 32)}
}

// req 造一个"客户端打到本平台"的请求（origin 决定 serverURL 绑定值）。
//
// origin 是**完整来源**（`http://example.com`）—— 与 `ServerURL(r)` 的返回值同形，
// 因为 proof 绑的就是它。
func (f *fixture) req(origin string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, origin+"/api/client/v2/apps/wasm/proof", nil)
	r.Host = strings.TrimPrefix(strings.TrimPrefix(origin, "http://"), "https://")
	return r
}

// signed 造一份合法的安装签名请求（各字段可逐个改坏）。
func (f *fixture) signed(installID, nonce string, ts int64, serverURL string) InstallRequest {
	return InstallRequest{
		InstallID: installID,
		PublicKey: base64.StdEncoding.EncodeToString(f.pub),
		Nonce:     nonce,
		TS:        ts,
		Signature: base64.StdEncoding.EncodeToString(
			ed25519.Sign(f.priv, InstallMessage(installID, nonce, ts, serverURL))),
	}
}

func (f *fixture) issue(serverURL, appID string) string {
	f.t.Helper()
	res, err := f.svc.Issue(f.req(serverURL), f.userID, f.bearer, appID,
		f.signed("install-aaaa-0001", "nonce-"+strconv.FormatInt(f.now.UnixNano(), 10), f.now.Unix(), serverURL))
	if err != nil {
		f.t.Fatalf("签发: %v", err)
	}
	return res.Proof
}

// ---- ① 密钥环 ----

func TestKeyRingIsPerDeploymentAnd0600(t *testing.T) {
	// 变异：把密钥写进源码常量/改成 0644 ⇒ 本用例红（它断言"文件存在且权限 0600"）。
	f := newFixture(t)
	path := filepath.Join(f.dir, KeyFileName)
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("签名密钥必须落在数据根（%s）: %v", path, err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("密钥文件权限 = %o, want 600（每部署一份、绝不编入镜像）", perm)
	}
	// 第二个部署（另一个数据根）必须拿到**不同的**密钥：证明"按部署生成"而不是共用常量。
	other, err := New(Options{DataRoot: t.TempDir(), Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatalf("第二个部署 New: %v", err)
	}
	if other.KID() == f.svc.KID() {
		t.Fatal("两个部署的 kid 相同 —— 密钥不是按部署生成的")
	}
}

func TestKeyRingSurvivesRestartAndRotates(t *testing.T) {
	f := newFixture(t)
	first := f.svc.KID()

	// 重启（同数据根）：必须复用同一把密钥，否则所有在手 proof 立刻失效。
	restarted, err := New(Options{DataRoot: f.dir, Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatalf("重启 New: %v", err)
	}
	if restarted.KID() != first {
		t.Fatalf("重启后 kid = %s, want %s（密钥必须持久化在数据根）", restarted.KID(), first)
	}

	// 轮换：新密钥签发，**旧密钥在 TTL 内仍可验**（契约 §23.1）。
	proof := f.issue("http://example.com", "demo")
	rotatedRing, err := restarted.ring.Rotate(f.dir, func() time.Time { return f.now.Add(time.Hour) })
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if rotatedRing.KID() == first {
		t.Fatal("轮换后 kid 未变")
	}
	if !rotatedRing.Verify(parseKID(t, proof), payloadOf(t, proof), sigOf(t, proof)) {
		t.Fatal("轮换后**旧密钥**必须仍在环里（TTL 内旧 proof 仍可验，契约 §23.1）")
	}
	// 轮换后新签发的 proof 用新密钥，旧环验不过（证明轮换真的换了材料）。
	fresh := &Service{ring: rotatedRing, installs: f.svc.installs, nonces: f.svc.nonces,
		jti: f.svc.jti, ttl: f.svc.ttl, skew: f.svc.skew, now: f.svc.now}
	newProof, ierr := fresh.Issue(f.req("http://example.com"), f.userID, f.bearer, "demo",
		f.signed("install-aaaa-0001", "nonce-after-rotate", f.now.Unix(), "http://example.com"))
	if ierr != nil {
		t.Fatalf("轮换后签发: %v", ierr)
	}
	if _, err := f.svc.Verify(f.req("http://example.com"), newProof.Proof, f.userID, f.bearer, "demo"); err == nil {
		t.Fatal("旧密钥环不应能验新密钥签发的 proof")
	}
}

// ---- ② 签发 ----

func TestIssueRequiresInstallSignatureAndRegistration(t *testing.T) {
	f := newFixture(t)
	host := "http://example.com"

	cases := []struct {
		name string
		mut  func(InstallRequest) InstallRequest
		want error
	}{
		{"缺 install_id", func(r InstallRequest) InstallRequest { r.InstallID = ""; return r }, ErrMalformed},
		{"install_id 太短", func(r InstallRequest) InstallRequest { r.InstallID = "short"; return r }, ErrMalformed},
		{"缺 nonce", func(r InstallRequest) InstallRequest { r.Nonce = ""; return r }, ErrMalformed},
		{"公钥非法", func(r InstallRequest) InstallRequest { r.PublicKey = "not-base64!!"; return r }, ErrMalformed},
		{"签名非法", func(r InstallRequest) InstallRequest { r.Signature = "zzz"; return r }, ErrMalformed},
		{"签名不符（换 appID 不影响签名，但改 install_id 会）", func(r InstallRequest) InstallRequest {
			r.InstallID = "install-bbbb-0002" // 签名仍是对旧 install_id 签的
			return r
		}, ErrMalformed},
		{"时间戳漂移超窗", func(r InstallRequest) InstallRequest { r.TS = f.now.Add(-time.Hour).Unix(); return r }, ErrExpired},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// nonce 每次唯一（否则第二条用例会因为"重放"而不是被测原因失败）。
			nonce := "n-" + strings.ReplaceAll(tc.name, " ", "_")
			base := f.signed("install-aaaa-0001", nonce, f.now.Unix(), host)
			_, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", tc.mut(base))
			if !errorsIs(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// TestIssueShapeFailuresCarryTheirOwnSentinel 是 AUD-3（2026-09-20 独立对抗审计）的
// **机制级**判据：签名缺失（空串/纯空白）与 `ts<=0` 必须各自归到正确的子类，
// 而不是落进"真验签不过"那一档。
//
// 现场：`service.go` 里
//
//	if req.TS <= 0 || strings.TrimSpace(req.Signature) == "" { return nil, ErrMalformed }
//	if raw := strings.TrimSpace(req.Signature); raw == "" { return nil, ErrSignatureMalformed }
//
// 第二行是**死代码**（第一行已经把空签名吃掉了）⇒ 空签名与 ts<=0 都走 default ⇒
// 对外 `reason=signature_invalid` + hint「请确认签名覆盖的是 appproof-install-v1 五段
// 消息」——把"没给签名/没给有效时间"两点误诊成"签名拼装错了"。
//
// 判据（三层，缺一不可）：
//  1. 子类正确：空/纯空白签名 ⇒ `ErrSignatureMalformed`；ts<=0 ⇒ `ErrTimestampMalformed`；
//  2. **大类不变**：两者都仍 `errors.Is(err, ErrMalformed)` 为真（外层码 401
//     `proof_mismatch` 与既有"按大类判"的调用方不受影响）；
//  3. **不串档**：签名缺失不得被判成时间戳问题，反之亦然；且不得是**裸** ErrMalformed
//     （那会退回"无法区分"的旧形态）。
//
// 变异验证：把这两个分支合并回上面的大条件 ⇒ 用例 1/3 红。
func TestIssueShapeFailuresCarryTheirOwnSentinel(t *testing.T) {
	f := newFixture(t)
	host := "http://example.com"

	cases := []struct {
		name string
		mut  func(InstallRequest) InstallRequest
		want error
	}{
		{"签名缺失（空串）", func(r InstallRequest) InstallRequest { r.Signature = ""; return r }, ErrSignatureMalformed},
		{"签名只有空白", func(r InstallRequest) InstallRequest { r.Signature = "  \t\n "; return r }, ErrSignatureMalformed},
		{"ts=0（签名本身合法）", func(r InstallRequest) InstallRequest { r.TS = 0; return r }, ErrTimestampMalformed},
		{"ts 为负", func(r InstallRequest) InstallRequest { r.TS = -1; return r }, ErrTimestampMalformed},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// nonce 每次唯一（否则第二条以后会因"重放"而不是被测原因失败）。
			base := f.signed("install-aaaa-0001", "n-shape-"+strconv.Itoa(i), f.now.Unix(), host)
			_, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", tc.mut(base))
			if err == nil {
				t.Fatalf("这条形态必须被拒（%s）", tc.name)
			}
			// ① 子类正确。
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want errors.Is(…, %v)", err, tc.want)
			}
			// ② 大类不变（外层码按大类映射）。
			if !errors.Is(err, ErrMalformed) {
				t.Fatalf("子类必须仍 Unwrap 到 ErrMalformed（外层码 401 proof_mismatch 不变）: %v", err)
			}
			// ③ 不串档、也不是裸 ErrMalformed。
			other := ErrTimestampMalformed
			if tc.want == ErrTimestampMalformed {
				other = ErrSignatureMalformed
			}
			if errors.Is(err, other) {
				t.Fatalf("归错档：%v 同时命中 %v", err, other)
			}
			if err == ErrMalformed {
				t.Fatalf("必须是可判别的子类，不能是裸 ErrMalformed（那就退回无法区分的旧形态）")
			}
		})
	}
}

func TestIssueNonceIsSingleUse(t *testing.T) {
	// 变异：把 nonces.Consume 去掉 ⇒ 本用例红（同一份签名可以无限重放）。
	f := newFixture(t)
	host := "http://example.com"
	req := f.signed("install-aaaa-0001", "nonce-once", f.now.Unix(), host)
	if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", req); err != nil {
		t.Fatalf("首次签发应成功: %v", err)
	}
	if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", req); !errorsIs(err, ErrReplayed) {
		t.Fatalf("重放 nonce 应 ErrReplayed，得到 %v", err)
	}
}

func TestInstallRegistryBindsUserAndInstall(t *testing.T) {
	f := newFixture(t)
	host := "http://example.com"

	// (user, install) 首次注册。
	if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo",
		f.signed("install-aaaa-0001", "n1", f.now.Unix(), host)); err != nil {
		t.Fatalf("首次注册: %v", err)
	}
	if got := f.svc.installs.Count(f.userID); got != 1 {
		t.Fatalf("注册表条目 = %d, want 1", got)
	}
	// 同值幂等：同一把钥匙再签一次通过（正常续签）。
	if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo",
		f.signed("install-aaaa-0001", "n2", f.now.Unix(), host)); err != nil {
		t.Fatalf("同公钥续签应通过: %v", err)
	}
	// 换钥匙（同 install_id、不同私钥）必须拒：静默重绑 = "最后写入者获胜"，
	// 那这个绑定就等于不存在。
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	otherPub := otherPriv.Public().(ed25519.PublicKey)
	r := InstallRequest{
		InstallID: "install-aaaa-0001",
		PublicKey: base64.StdEncoding.EncodeToString(otherPub),
		Nonce:     "n3",
		TS:        f.now.Unix(),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(otherPriv,
			InstallMessage("install-aaaa-0001", "n3", f.now.Unix(), host))),
	}
	if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", r); !errorsIs(err, ErrMismatch) {
		t.Fatalf("同 install_id 换钥匙应 ErrMismatch，得到 %v", err)
	}
	// 另一个用户用同一 install_id 是独立的绑定（注册表按 user 分组）。
	if _, err := f.svc.Issue(f.req(host), 43, f.bearer, "demo",
		f.signed("install-aaaa-0001", "n4", f.now.Unix(), host)); err != nil {
		t.Fatalf("另一用户注册同一 install_id 应独立成立: %v", err)
	}
	// 有界：单用户条目数不超过上限（这里只验证"能继续注册到上限"，不灌满 32 条）。
	if got := f.svc.installs.Count(f.userID); got != 1 {
		t.Fatalf("user 42 的条目 = %d, want 1（另一用户不得污染）", got)
	}
}

// ---- ③ 校验（绑定逐项）----

func TestVerifyBindingsEachRejected(t *testing.T) {
	f := newFixture(t)
	host := "http://example.com"
	proof := f.issue(host, "demo")

	ok, err := f.svc.Verify(f.req(host), proof, f.userID, f.bearer, "demo")
	if err != nil {
		t.Fatalf("合法 proof 应通过: %v", err)
	}
	if ok.App != "demo" || ok.UID != f.userID || ok.Exp <= f.now.Unix() {
		t.Fatalf("claims 不符: %+v", ok)
	}

	cases := []struct {
		name     string
		userID   int64
		bearer   string
		appID    string
		host     string
		wantKind error
	}{
		{"跨用户重放（R2S-2/N2）", f.userID + 1, f.bearer, "demo", host, ErrMismatch},
		{"换 bearer（登出后重登）", f.userID, strings.Repeat("cd", 32), "demo", host, ErrMismatch},
		{"跨应用重放（绑 app_id）", f.userID, f.bearer, "other", host, ErrMismatch},
		{"换服务端地址", f.userID, f.bearer, "demo", "http://another.example.com", ErrMismatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := f.svc.Verify(f.req(tc.host), proof, tc.userID, tc.bearer, tc.appID); !errorsIs(err, tc.wantKind) {
				t.Fatalf("err = %v, want %v", err, tc.wantKind)
			}
		})
	}

	// 过期：TTL 之后必须 ErrExpired（不是 mismatch —— 客户端的反应不同）。
	f.svc.now = func() time.Time { return f.now.Add(DefaultTTL + time.Second) }
	if _, err := f.svc.Verify(f.req(host), proof, f.userID, f.bearer, "demo"); !errorsIs(err, ErrExpired) {
		t.Fatalf("过期应 ErrExpired，得到 %v", err)
	}
	// 篡改：动 payload 一个字节 ⇒ 签名验不过 ⇒ ErrMalformed。
	tampered := proof[:len(proof)-4] + "AAAA"
	if _, err := f.svc.Verify(f.req(host), tampered, f.userID, f.bearer, "demo"); err == nil {
		t.Fatal("篡改后的 proof 必须被拒")
	}
}

// ---- ④ 一次性表与有界 ----

func TestReplayGuardIsBoundedAndFIFO(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	g := NewReplayGuard(4, time.Minute, func() time.Time { return now })

	for _, k := range []string{"a", "b", "c", "d"} {
		if !g.Consume(k) {
			t.Fatalf("%s 首次消费应通过", k)
		}
	}
	if g.Consume("a") {
		t.Fatal("a 已消费过，必须拒（重放）")
	}
	// 第 5 个键把最旧的 a 挤出去（有界 = 丢最旧，不是"满了拒绝"）。
	if !g.Consume("e") {
		t.Fatal("容量满时必须丢最旧并接受新键（否则峰值流量整批 401）")
	}
	if g.Len() != 4 {
		t.Fatalf("在册键数 = %d, want 4（有界）", g.Len())
	}
	if !g.Consume("a") {
		t.Fatal("被挤出的键在 TTL 内应可再次使用（LRU 的固有代价，契约已认账）")
	}
	// TTL 过后，所有键都应可再次使用（否则一次性表会变成永久黑名单）。
	now = now.Add(2 * time.Minute)
	if !g.Consume("b") {
		t.Fatal("TTL 过后旧键必须可再用（否则表会退化成永久拒绝）")
	}
}

func TestConsumeJTIIsPerProof(t *testing.T) {
	f := newFixture(t)
	c := &Claims{JTI: "jti-1"}
	if !f.svc.ConsumeJTI(c) {
		t.Fatal("首次消费 jti 应通过")
	}
	if f.svc.ConsumeJTI(c) {
		t.Fatal("同一 jti 第二次必须拒（非幂等请求的防重放）")
	}
	// nil / 空 jti 按"未被用过"（安全分支不在那里：jti 恒非空）。
	if !f.svc.ConsumeJTI(nil) || !f.svc.ConsumeJTI(&Claims{}) {
		t.Fatal("nil/空 jti 必须放行（不产生拒绝分支）")
	}
}

// R5-A-28 ①③：**低于旧阈值的速率**下 order 也必须被限制。
//
// 这是本条缺陷的原始形态：速率 < capacity/TTL 时 seen 永远被过期清扫压在容量之下
// ⇒ 旧实现里"推进 head"的截断循环永不触发 ⇒ 压缩判据（head > capacity）永不成立
// ⇒ order 按请求速率永久增长（1 键/秒 ≈ 15MB/天）。
//
// 场景（capacity=8、ttl=30s、虚拟时钟每键前进 10s）：seen 稳定在 4~5 条，
// 远小于 capacity；旧实现跑 64 个键后 OrderLen()==64（必红），新实现 ≤ 2*capacity。
func TestReplayGuardOrderStaysBoundedAtLowKeyRate(t *testing.T) {
	const capacity = 8
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	g := NewReplayGuard(capacity, 30*time.Second, func() time.Time { return now })

	const keys = 64 // 8 × capacity：远多于容量，但到达速率远低于 capacity/TTL
	for i := 0; i < keys; i++ {
		k := "k-" + strconv.Itoa(i)
		if !g.Consume(k) {
			t.Fatalf("第 %d 个不同键首次消费应通过", i)
		}
		// 每一步都断言（不只终态）：旧的"按需压缩"会在中途留下无界的切片。
		if n := g.OrderLen(); n > 2*capacity {
			t.Fatalf("第 %d 个键后 order 长度 = %d，超过上界 %d（低速率档位下 order 无界 = OOM 面）",
				i, n, 2*capacity)
		}
		now = now.Add(10 * time.Second)
	}
	// 两个量必须一起看：只断言 Len() 会得到"一切正常"的假绿
	// （低速率下 seen 本来就被清扫压在容量之下，而增长的是 order）。
	if n := g.Len(); n > capacity+1 {
		t.Fatalf("seen 在册键数 = %d, want <= %d", n, capacity+1)
	}
	if n := g.OrderLen(); n > 2*capacity {
		t.Fatalf("order 长度 = %d, want <= %d", n, 2*capacity)
	}
	// 有界不等于失效：TTL 内的键仍然必须判重放。
	if !g.Consume("replay-probe") {
		t.Fatal("新键首次消费应通过")
	}
	if g.Consume("replay-probe") {
		t.Fatal("同一键在 TTL 内第二次必须拒（重建不能把去重能力一起丢掉）")
	}
}

// R5-A-28 ②④：**未验签的请求不得改变任何内部状态**。
//
// 旧实现的 nonce 消费点在 ed25519.Verify **之前**（service.go:174），
// 于是任何持员工 bearer 的调用方只要每次换一个 nonce、签名随便填，
// 就能按请求速率往一次性表里灌键（叠加 order 无界 = 纯内存 OOM 面）。
//
// 本用例同时钉住两个后果：
//  1. 签名验不过的请求不增加 nonces 的任何量（Len / OrderLen 都不动）；
//  2. 攻击者**不能**用垃圾签名把合法客户端的 nonce 提前烧掉（DoS 面）：
//     先用同一个 nonce 打 5 次坏签名，随后合法签名必须仍然签发出 proof。
func TestIssueUnverifiedRequestDoesNotGrowReplayState(t *testing.T) {
	f := newFixture(t)
	host := "http://example.com"

	// 坏签名：形状合法（64 字节 Ed25519）、base64 合法，但不是用提交的公钥签的。
	_, otherPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const nonce = "nonce-unverified-probe"
	bad := f.signed("install-aaaa-0001", nonce, f.now.Unix(), host)
	bad.Signature = base64.StdEncoding.EncodeToString(
		ed25519.Sign(otherPriv, InstallMessage("install-aaaa-0001", nonce, f.now.Unix(), host)))

	for i := 0; i < 5; i++ {
		if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", bad); err == nil {
			t.Fatalf("第 %d 次坏签名签发必须失败", i+1)
		}
		if n := f.svc.nonces.Len(); n != 0 {
			t.Fatalf("未验签的请求不得进入一次性表：seen = %d, want 0", n)
		}
		if n := f.svc.nonces.OrderLen(); n != 0 {
			t.Fatalf("未验签的请求不得增长 order：len = %d, want 0", n)
		}
	}
	if n := f.svc.installs.Count(f.userID); n != 0 {
		t.Fatalf("未验签的请求不得写入安装注册表：条目 = %d, want 0", n)
	}

	// 合法签名（同一个 nonce）必须照常签发：坏签名没有把客户的 nonce 烧掉。
	good := f.signed("install-aaaa-0001", nonce, f.now.Unix(), host)
	if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", good); err != nil {
		t.Fatalf("合法签名必须仍可签发（坏签名不得消费 nonce）: %v", err)
	}
	// 而这一次成功签发**确实**消费了 nonce（一次性语义没有被挪走而失效）。
	if _, err := f.svc.Issue(f.req(host), f.userID, f.bearer, "demo", good); !errorsIs(err, ErrReplayed) {
		t.Fatalf("合法签发之后同一 nonce 必须 ErrReplayed，得到 %v", err)
	}
}

// parseKID / payloadOf / sigOf 拆一份 proof 的三段（轮换用例验证"旧密钥仍可验"）。
func parseKID(t *testing.T, token string) string {
	t.Helper()
	kid, _, _, err := parseToken(token)
	if err != nil {
		t.Fatalf("拆 proof: %v", err)
	}
	return kid
}

func payloadOf(t *testing.T, token string) []byte {
	t.Helper()
	_, payload, _, err := parseToken(token)
	if err != nil {
		t.Fatalf("拆 proof: %v", err)
	}
	return payload
}

func sigOf(t *testing.T, token string) []byte {
	t.Helper()
	_, _, sig, err := parseToken(token)
	if err != nil {
		t.Fatalf("拆 proof: %v", err)
	}
	return sig
}

// errorsIs 是 errors.Is 的本地包装（本文件的断言都写 want 值，读起来更直）。
func errorsIs(err, target error) bool {
	if err == nil || target == nil {
		return err == target
	}
	return strings.Contains(err.Error(), target.Error())
}
