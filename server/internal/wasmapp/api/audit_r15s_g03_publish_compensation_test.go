package api

// R15C-G-03 的**端到端**判据：走真实发布链路（HTTP → 编译 → 落库），让发布在
// "版本行已经落库"之后失败，验证 publish.go 的 compensate 闭包（SoftDeleteWasmRelease）
// 把配额**还给用户**。
//
// 为什么必须在 api 层再测一遍（serverstore 那层已经测了 SoftDeleteWasmRelease）：
// 判据是"**一次发布失败的补偿软删之后，配额回到软删前的可用值**"，而那件事由
// 三段代码共同决定 —— 关闭闭包是否真的被调用、它调的是哪个 DAO、以及配额口径
// （CountUserArtifactBytes）是否把软删行算进去。任何一段退化，serverstore 的单测
// 都照样绿。
//
// 夹具手法：在 apps 表上装一个 BEFORE UPDATE OF config_json 触发器，只对本次新版本的
// 配置（含 r15s-comp-fail 标记）抛异常。commitRelease 的顺序是
//   E1 UpsertWasmApp（不含 config_json，不触发）→ E2 CreateWasmRelease（版本行已落库）
//   → F1 SetWasmAppConfig（触发 ⇒ 失败）→ compensate（软删刚建的版本行 + 回滚投影）
// 所以这一次失败**恰好**打在"版本行已存在"之后，与生产里的半成品形态逐字相同
// （补偿闭包的另一条调用路径，比如 SetWasmAppCurrentRelease 失败，走的是同一段）。

import (
	"context"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// installCompFailTrigger 让"带标记的新配置"在写 apps.config_json 时失败。
func installCompFailTrigger(t *testing.T, e *testEnv, appID, marker string) {
	t.Helper()
	if _, err := e.db.Exec(`CREATE OR REPLACE FUNCTION r15s_comp_fail() RETURNS trigger AS $$
		BEGIN
			IF NEW.app_id = '` + appID + `' AND NEW.config_json LIKE '%` + marker + `%' THEN
				RAISE EXCEPTION 'r15s: forced failure while saving app config';
			END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("建触发器函数: %v", err)
	}
	if _, err := e.db.Exec(`CREATE TRIGGER r15s_comp_fail_trg BEFORE UPDATE OF config_json ON apps
		FOR EACH ROW EXECUTE FUNCTION r15s_comp_fail()`); err != nil {
		t.Fatalf("建触发器: %v", err)
	}
	t.Cleanup(func() {
		_, _ = e.db.Exec(`DROP TRIGGER IF EXISTS r15s_comp_fail_trg ON apps`)
		_, _ = e.db.Exec(`DROP FUNCTION IF EXISTS r15s_comp_fail()`)
	})
}

func TestR15SG03FailedPublishCompensationRestoresQuotaEndToEnd(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	const appID = "r15s-comp-app"
	const user = "alice"
	guest := testGuestModule(t)

	// ① 先成功发布 v1.0.0（baseline 占用 = 这一版的字节）。
	e.publishOK(e.tokens[user], appID, "1.0.0", guest, goodConfig())
	baseline, err := serverstore.CountUserArtifactBytes(ctx, e.db, user)
	if err != nil {
		t.Fatalf("CountUserArtifactBytes: %v", err)
	}
	if baseline <= 0 {
		t.Fatalf("夹具失效：baseline=%d", baseline)
	}
	_, _, v1Size := e.releaseState(appID, "1.0.0")

	// ② 装触发器：v1.0.0 之后的一切"改应用配置"都失败（等于发布收尾失败）。
	const marker = "r15s-comp-fail"
	installCompFailTrigger(t, e, appID, marker)

	// ③ 连续三轮失败发布：每一轮的补偿软删都必须把配额还回来。
	for round, version := range []string{"2.0.0", "3.0.0", "4.0.0"} {
		cfg := goodConfig()
		cfg["purpose"] = "r15s-comp-fail 标记：本次发布的收尾必须失败"
		w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/releases", e.tokens[user],
			e.payload(appID, version, guest, cfg))
		eb := e.decodeErr(w, http.StatusInternalServerError)
		if eb.Error.Code != "INTERNAL" {
			t.Fatalf("第 %d 轮：code=%s，期望 INTERNAL（收尾失败）", round+1, eb.Error.Code)
		}
		t.Logf("第 %d 轮发布 %s 失败：%s / %s", round+1, version, eb.Error.Code, eb.Error.Message)

		// 判据 1：配额回到 baseline（补偿软删释放字节）。
		got, err := serverstore.CountUserArtifactBytes(ctx, e.db, user)
		if err != nil {
			t.Fatalf("CountUserArtifactBytes: %v", err)
		}
		if got != baseline {
			t.Fatalf("第 %d 轮：失败发布之后 used=%d，期望回到 baseline=%d —— 补偿软删没有释放字节，"+
				"每次发布失败都会永久吃掉配额（闸门在发布最前面、GC 只在发布成功之后跑 ⇒ 自锁）",
				round+1, got, baseline)
		}
		// 判据 2：闸门仍然放行（用户可以继续发布/重试）。
		if qerr := registry.CheckArtifactQuota(got, v1Size); qerr != nil {
			t.Fatalf("第 %d 轮之后闸门仍拦：%s", round+1, qerr.Message)
		}
		// 判据 3：版本号永久占位（行保留、字节释放），与 §4.1 一致。
		status, archiveEmpty, size := e.releaseState(appID, version)
		if !archiveEmpty || size != 0 {
			t.Errorf("第 %d 轮 %s：archive 未释放（empty=%v size=%d）", round+1, version, archiveEmpty, size)
		}
		if status == "" {
			t.Errorf("第 %d 轮 %s：版本行不该被删（版本号永久占位）", round+1, version)
		}
		var deleted bool
		if err := e.db.QueryRow(`SELECT deleted_at IS NOT NULL FROM app_releases
			WHERE kind = $1 AND app_id = $2 AND version = $3`,
			serverstore.AppKindWasmApp, appID, version).Scan(&deleted); err != nil {
			t.Fatalf("读 deleted_at: %v", err)
		}
		if !deleted {
			t.Errorf("第 %d 轮 %s：失败版本应处于软删状态（补偿路径的唯一动作）", round+1, version)
		}
	}

	// ④ 拆掉触发器之后，同一个应用还能正常发布（恢复路径可执行，且线上版本没被破坏）。
	if _, err := e.db.Exec(`DROP TRIGGER IF EXISTS r15s_comp_fail_trg ON apps`); err != nil {
		t.Fatalf("拆触发器: %v", err)
	}
	e.publishOK(e.tokens[user], appID, "5.0.0", guest, goodConfig())
	if _, _, size := e.releaseState(appID, "5.0.0"); size <= 0 {
		t.Errorf("恢复路径失效：v5.0.0 落库后 size=%d", size)
	}
}
