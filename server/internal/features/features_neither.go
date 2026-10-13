//go:build !skills && !apps

package features

// 编译期开关状态（skills/apps 面，两个都关）。见 features_skills_apps.go 的说明。
const (
	skillEnabled = false
	appEnabled   = false
)
