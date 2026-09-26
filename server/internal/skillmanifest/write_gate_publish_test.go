// 名字面判据在**统一发布内核**上的那一半（R21F-06，审计 2026-09-26，P2）。
//
// 为什么需要**外部测试包**（`skillmanifest_test`）：`appstore` 依赖
// `skillmanifest`（它用 IsAppID 做闸门），同包内测试再 import `appstore` 就成环。
// 外部测试包正好是这个场景的合法形态，也让"发布内核确实经过名字面判据"这件事
// 由**真实调用**证明，而不是靠读注释。
//
// 覆盖的链路（四条上传路径共用的收口）：
//
//	员工上传技能  sharedskills.upload   ─┐
//	管理端上架    marketplace.createSkillAdmin ─┤
//	管理端智能体  marketplace.createAgentAdmin ─┼─▶ appstore.Publish ─▶ IsAppID
//	员工上传智能体 agentshare.upload     ─┘
//
// 传 `nil` DB 是**有意**的判据（与 reports 包 `GenerateMonthlyReportForPeriod(nil, …)`
// 同形）：闸门必须在**任何数据库动作之前**返回 —— 合法名字会走到落库并在这里 panic，
// 非法名字必须在此之前返回。这条同时钉住"校验在最前面"。
//
// 变异：`IsAppID` 去掉保留名判据（或把 Publish 的闸门挪到 DB 动作之后）⇒ 本用例红。
package skillmanifest_test

import (
	"errors"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

func TestPublishRejectsWindowsReservedDeviceNames(t *testing.T) {
	for _, name := range []string{"con", "PRN", "aux", "nul", "com1", "lpt9"} {
		_, err := appstore.Publish(nil, appstore.PublishRequest{
			Kind:         "skill",
			AppID:        name,
			Channel:      "market",
			Publisher:    "ops",
			AdminPublish: true,
			Manifest:     appstore.Manifest{Version: "1.0.0", Title: "t", Description: "d"},
			Checksum:     "deadbeef",
		})
		var ae *appstore.Error
		if !errors.As(err, &ae) {
			t.Fatalf("Publish(AppID=%q) 未在闸门处返回结构化错误: %v"+
				"（发布内核是三条上传路径的唯一收口，它放行 = 上架一个客户端装不上的技能）", name, err)
		}
		if ae.Code != skillmanifest.CodeInvalidAppID {
			t.Fatalf("Publish(AppID=%q) code = %s, want %s", name, ae.Code, skillmanifest.CodeInvalidAppID)
		}
		if ae.Status != http.StatusBadRequest {
			t.Fatalf("Publish(AppID=%q) status = %d, want %d", name, ae.Status, http.StatusBadRequest)
		}
	}
}
