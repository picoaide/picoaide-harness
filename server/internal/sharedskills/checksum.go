package sharedskills

import (
	"crypto/sha256"
	"encoding/hex"
)

// ArchiveChecksum 返回归档下发时必须随响应发出的完整性校验和
// （`X-Skill-Checksum` / `X-Preset-Checksum` 头）—— **四个下载端点的唯一实现**
// （组织技能 / 市场技能 / 组织智能体档案 / 市场智能体档案），任何一处都不得各写一份
// （A2-02 与第二十二轮复审 V2-B1，P2）。
//
// 语义：库里的 checksum 列是 schema 的**默认可达态为空**
// （`migrations-pg/0034_shared_skills.sql` 与 `0032/0035_agent_presets*.sql` 都是
// `checksum TEXT NOT NULL DEFAULT ”`，`0054_apps_backfill.sql` 按原值回填），
// 所以空值必须**现算**（对归档字节做 sha256），绝不能把空串写进响应头。
//
// 为什么"各写一份"是缺陷（R18B-05 的交接项）：市场面
// `marketplace.serveSkillArchive` 早就有 `if sum == "" { sum = sha256Hex(payload) }`
// 兜底，而组织面 `sharedskills.download` 直接发 `s.Checksum` ⇒ 同一台服务端上
// "同一形状的行"两个渠道口径不同 —— 组织面发**空头**，而客户端自 R18B-05 起对
// "头存在但为空"是 fail-closed（技能面 `CHECKSUM_UNAVAILABLE`、智能体面
// `checksum mismatch; refused`）⇒ 那些行对**所有**员工永久装不上（市场面同形状行
// 因为服务端现算而正常，可自助路径只有"升版本号重发"）。
//
// 同一形态在**智能体档案**面又出现了一次（`agentshare.serveArchive` 与
// `marketplace.downloadAgentArchiveAdmin` 都直发 `p.Checksum` / `r.Checksum`），
// 那两个点现在也调这里 —— 见 `marketplace/agent_checksum_parity_test.go`。
//
// 判据：
//   - `marketplace/skill_checksum_parity_test.go` —— 技能面跨面同一性；
//   - `marketplace/agent_checksum_parity_test.go` —— 智能体档案面跨面同一性。
//
// 两条都用同一个库、同一份归档字节，同时打两个端点的下载路由（两边都清空
// checksum 列），断言两边的头都非空、彼此相等、且等于归档字节的 sha256。
func ArchiveChecksum(recorded string, payload []byte) string {
	if recorded != "" {
		return recorded
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
