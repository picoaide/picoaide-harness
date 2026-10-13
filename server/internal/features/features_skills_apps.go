//go:build skills && apps

package features

// 编译期开关状态（skills/apps 面）。本面四个文件互斥且穷尽
// （`skills && apps` / `skills && !apps` / `apps && !skills` / `!skills && !apps`），
// 任一组合下恰好有一个参与编译 —— 少一个文件就会"常量未定义"编译失败，不会静默取零值。
const (
	skillEnabled = true
	appEnabled   = true
)
