package serverstore

import (
	"errors"
	"testing"
)

func TestCapabilityLockLifecycle(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	// 预锁定一个尚不存在的名字(占名,防止员工抢占官方命名)。
	if err := LockCapability(db, CapabilityKindSkill, "org-official", "官方技能,仅管理员维护", "admin"); err != nil {
		t.Fatal(err)
	}
	l, err := GetCapabilityLock(db, CapabilityKindSkill, "org-official")
	if err != nil || l.Reason != "官方技能,仅管理员维护" || l.LockedBy != "admin" {
		t.Fatalf("lock = %+v err=%v", l, err)
	}
	// 幂等:重复锁定只更新理由与操作人。
	if err := LockCapability(db, CapabilityKindSkill, "org-official", "改了理由", "boss"); err != nil {
		t.Fatal(err)
	}
	l, _ = GetCapabilityLock(db, CapabilityKindSkill, "org-official")
	if l.Reason != "改了理由" || l.LockedBy != "boss" {
		t.Fatalf("relock = %+v", l)
	}
	// kind 隔离:同名的 agent 不受 skill 锁影响。
	if _, err := GetCapabilityLock(db, CapabilityKindAgent, "org-official"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("agent lock leak: %v", err)
	}
	list, err := ListCapabilityLocks(db)
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %v err=%v", list, err)
	}
	if err := UnlockCapability(db, CapabilityKindSkill, "org-official"); err != nil {
		t.Fatal(err)
	}
	if _, err := GetCapabilityLock(db, CapabilityKindSkill, "org-official"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unlock 后仍可查到: %v", err)
	}
	if err := UnlockCapability(db, CapabilityKindSkill, "org-official"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("重复解锁 = %v, want ErrNotFound", err)
	}
	if err := LockCapability(db, "bogus", "x", "", "admin"); err == nil {
		t.Fatal("非法 kind 必须拒绝")
	}
}
