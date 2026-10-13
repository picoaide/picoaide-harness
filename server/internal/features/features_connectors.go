//go:build connectors

package features

// connectors 与 skills/apps **正交**（它不属于那两个面的任一组合），因此单独一对
// `connectors` / `!connectors` 文件；缺省（无标签）= 关闭。
const connectorEnabled = true
