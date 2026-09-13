package appstore

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// R7 审计回归(agentshare-4 / marketplace-4)
//
// Publish 的「读归属/渠道/历史版本 → 写」跨三次独立 DB 往返,并发首次发布
// 同名时两个请求都能通过检查(复核实测 90% 命中),而且后写者会用无守卫的
// ON CONFLICT DO UPDATE 覆写赢家的 title/description(owner 有 COALESCE
// 守卫,title/description 没有)。
// ---------------------------------------------------------------------------

func raceReq(appID, version, publisher, title string) PublishRequest {
	r := req(appID, version, "sum-"+publisher+"-"+version, publisher)
	r.PendingCap = 0 // 不限:并发用例每轮都会留下一条 pending 行
	r.Manifest.Title = title
	return r
}

// TestConcurrentFirstPublishHasExactlyOneWinner: 同一新名字的并发首发布必须
// 只有一个赢家(另一个 409 NAME_TAKEN),且赢家的 title/归属不被败者覆写。
func TestConcurrentFirstPublishHasExactlyOneWinner(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	const rounds = 20
	bothAccepted := 0
	for i := 0; i < rounds; i++ {
		name := fmt.Sprintf("race-app-%d", i)
		reqs := []PublishRequest{
			raceReq(name, "1.0.0", "alice", "TITLE-BY-ALICE"),
			raceReq(name, "2.0.0", "bob", "TITLE-BY-BOB"),
		}
		errs := make([]error, len(reqs))
		var wg sync.WaitGroup
		for j := range reqs {
			wg.Add(1)
			go func(j int) {
				defer wg.Done()
				_, errs[j] = Publish(db, reqs[j])
			}(j)
		}
		wg.Wait()

		winners := 0
		for j, err := range errs {
			if err == nil {
				winners++
				continue
			}
			if code(t, err) != CodeNameTaken {
				t.Fatalf("round %d publisher %s: %v, want %s", i, reqs[j].Publisher, err, CodeNameTaken)
			}
		}
		if winners > 1 {
			bothAccepted++
			continue
		}
		// 唯一赢家:App 的 owner/title 与唯一版本都属于它。
		app, err := serverstore.GetApp(db, serverstore.AppKindSkill, name)
		if err != nil {
			t.Fatal(err)
		}
		rels, err := serverstore.ListReleases(db, serverstore.AppKindSkill, name)
		if err != nil {
			t.Fatal(err)
		}
		if len(rels) != 1 {
			t.Fatalf("round %d: releases = %d, want 1 (败者不得并入同名 App)", i, len(rels))
		}
		if rels[0].Publisher != app.Owner {
			t.Fatalf("round %d: owner=%q but the only release was published by %q", i, app.Owner, rels[0].Publisher)
		}
		wantTitle := "TITLE-BY-" + strings.ToUpper(app.Owner)
		if app.Title != wantTitle {
			t.Fatalf("round %d: title = %q, want %q (败者不得覆写赢家的展示名)", i, app.Title, wantTitle)
		}
	}
	if bothAccepted > 0 {
		t.Fatalf("两个发布者同时成功 %d/%d 轮:同名首发布必须恰好一个赢家", bothAccepted, rounds)
	}
}

// TestConcurrentPublishSameNameSameOwnerKeepsOwnership: 同一作者的并发发布
// 不会被锁误判成「他人占名」(仍按版本语义裁决),App 归属保持作者本人。
func TestConcurrentPublishSameNameSameOwnerKeepsOwnership(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := Publish(db, raceReq("self-race", "1.0.0", "alice", "T1")); err != nil {
		t.Fatal(err)
	}
	reqs := []PublishRequest{
		raceReq("self-race", "2.0.0", "alice", "T2"),
		raceReq("self-race", "3.0.0", "alice", "T3"),
	}
	errs := make([]error, len(reqs))
	var wg sync.WaitGroup
	for j := range reqs {
		wg.Add(1)
		go func(j int) {
			defer wg.Done()
			_, errs[j] = Publish(db, reqs[j])
		}(j)
	}
	wg.Wait()
	accepted := 0
	for j, err := range errs {
		if err == nil {
			accepted++
			continue
		}
		// 并发下版本递减的那次会被版本语义拒绝(合法的确定性裁决),
		// 但绝不能被当成「他人占名」。
		if c := code(t, err); c == CodeNameTaken || c == CodeOfficialLocked {
			t.Fatalf("同作者并发发布 v%s 被误判成归属冲突: %v", reqs[j].Manifest.Version, err)
		}
	}
	if accepted == 0 {
		t.Fatalf("同作者并发发布全部被拒: %v / %v", errs[0], errs[1])
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, "self-race")
	if err != nil || app.Owner != "alice" {
		t.Fatalf("app owner = %+v err=%v, want alice", app, err)
	}
	rels, err := serverstore.ListReleases(db, serverstore.AppKindSkill, "self-race")
	if err != nil || len(rels) < 2 {
		t.Fatalf("releases = %d err=%v, want >= 2", len(rels), err)
	}
}
