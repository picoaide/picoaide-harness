package sharedskills

import (
	"crypto/sha256"
	"encoding/hex"
)

// ArchiveChecksum 返回归档下发时必须随响应发出的完整性校验和
// （`X-Skill-Checksum` 头）—— **组织面与市场面唯一实现**，两个端点不得各写一份
// （A2-02，审计 2026-09-26，P2）。
//
// 语义：库里的 checksum 列是 schema 的**默认可达态为空**
// （`migrations-pg/0034_shared_skills.sql` 的 `checksum TEXT NOT NULL DEFAULT ”`，
// `0054_apps_backfill.sql` 按原值回填），所以空值必须**现算**（对归档字节做
// sha256），绝不能把空串写进响应头。
//
// 为什么"各写一份"是缺陷（R18B-05 的交接项，至今仍开）：市场面
// `marketplace.serveSkillArchive` 早就有 `if sum == "" { sum = sha256Hex(payload) }`
// 兜底，而组织面 `sharedskills.download` 直接发 `s.Checksum` ⇒ 同一台服务端上
// "同一形状的行"两个渠道口径不同 —— 组织面发**空头**，而客户端自 R18B-05 起对
// "头存在但为空"是 fail-closed（`CHECKSUM_UNAVAILABLE`、拒绝安装）⇒ 那些行对
// **所有**员工永久装不上（市场面同形状行因为服务端现算而正常，可自助路径只有
// "升版本号重发"）。
//
// 判据：`checksum_parity_test.go` 用同一个库、同一份归档字节，同时打两个端点的
// 下载路由（两边都清空 checksum 列），断言两边的 `X-Skill-Checksum` 都非空、
// 彼此相等、且等于归档字节的 sha256。
func ArchiveChecksum(recorded string, payload []byte) string {
	if recorded != "" {
		return recorded
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
