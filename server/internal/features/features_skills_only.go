//go:build skills && !apps

package features

// 编译期开关状态（skills/apps 面，只开技能）。见 features_skills_apps.go 的说明。
const (
	skillEnabled = true
	appEnabled   = false
)
