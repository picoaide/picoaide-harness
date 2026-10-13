//go:build apps && !skills

package features

// 编译期开关状态（skills/apps 面，只开应用）。见 features_skills_apps.go 的说明。
const (
	skillEnabled = false
	appEnabled   = true
)
