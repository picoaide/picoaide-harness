package skillseed

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// 本文件守 R1-pm-8 的**第二半**：内容变了，version 必须跟着变。
//
// 现场（独立审计 R1-pm-8 / SK-2）：`references/limits.md` 的内容真的改了（`app_concurrency`
// 从"恒为 1（串行）"改成默认 4 并发、新增 `app_db_readers` / `app_db_busy_timeout`），
// 而 `SKILL.md` 的 `version` 从 beta.1 起一直是 `1.0.0` ⇒ 服务端清单与本机已装版本
// **都是 1.0.0**，客户端 `builtinAction()` 永远返回"已安装"，判不出有更新 ——
// 平台修正过的作者手册永远到不了已安装的员工手上（配合"更新入口是死代码"就是永久静默陈旧）。
//
// 判据：把整个技能目录（相对路径 + 逐字节内容，按路径排序，**目录条目也计入**）摘要成
// sha256；**每个摘要只允许对应一个 version**。于是四种破坏都会红：
//   - 改内容不提版本 ⇒ 摘要查不到 ⇒ TestBuiltinSkillVersionTracksContent 红；
//   - 提了版本不登记 ⇒ 摘要登记的仍是旧版本 ⇒ 红；
//   - 复用旧版本号（改内容 + 把新摘要也标成 1.0.0）⇒ "一个 version 只能有一个摘要" 红；
//   - **加/删一个空目录**（不新增任何文件）⇒ 摘要变 ⇒ 红（R2-SK-4：PackDir 为每个
//     目录产出 tar 条目，下发字节确实变了）。
//
// 登记表**只增不减**：它同时是"这个版本交付了什么内容"的对账依据。
//
// 变异验证（实跑过，勿删）：
//   - 改 `references/imports.md` 里任意一个字节（不动 SKILL.md 的 version）⇒ 红；
//   - 把 SKILL.md 的 version 从 1.1.0 改成 1.0.0（内容不动）⇒ 红（摘要登记的是 1.1.0）；
//   - 给某条摘要补一个已用过的 version ⇒ 反向断言红。
//
// ⚠️ 本表是**整目录**摘要：`references/limits.md` 是 limits 生成器的产物，它的内容由
// `cmd/picoaide-limits-gen` 决定 —— 改 limits 的真源（limitsspec.go）并重跑生成器后，
// 这里会红，那不是误报：交付给员工的手册变了，版本就该提。

// seededSkillDigests 是「内置技能内容摘要 → SKILL.md 的 version」登记表。
//
// 登记的是**要交付出去的那一份内容**（本分支合并后的状态）。尚未提交、也没下发过的
// 中间态可以就地替换（同一版本只留一条），已提交/已发布的条目只增不减。
var seededSkillDigests = map[string]string{
	// 2.0.0 = 九阶段「陪小白把设计做完」手册（三轮设计访谈 + 五角色评审与追问话术）
	//   + 前后端分离示例（静态前端 web/* 经 pack-assets 打进 wasm 自定义段 + wasm 只做
	//   JSON API）+ 应用内 AI 改「客户端 AI loop」口径修正（六错误码、撤销入口在应用
	//   详情页、归因尚未接通、老应用运行期才失败）+ 平台保留列 `_row_id` 全规则。
	//   2026-09-20，18 个文件一起变（L5 泳道）。
	// 2026-09-20（同一版本、尚未下发 ⇒ 就地替换，同一版本只留一条）：把技能的展示名
	// 与作者改成**渠道中性** —— title 去掉厂商名、author=平台内置。产品按渠道白标，
	// 技能标题里写死厂商名会让渠道客户看到别的牌子。运行时名 `app-builder`（服务端
	// 目录名 + 客户端常量 `APP_BUILDER_SKILL` 的绑定）与 `x-abi-version` 不动。
	//
	// 2026-09-20 **再次就地替换**（同一条 2.0.0）：登记后又补了 `references/design-interview.md`
	// 与 `examples/go/web/*`（前后端分离示例的前端三件套）⇒ 整目录摘要变了。2.0.0 **从未随
	// 任何 tag 下发**（上一个已发布的内置技能版本是 1.4.0），所以按本表的就地替换规则改写这
	// 一条，而不是为一个没出过门的内容提版本号。
	"08c409b0547aed5b0448575ac38dcd1f52bbb0cb8546e72782b2f0db5b26517e": "2.0.0",

	// 2.1.0 = **同一份手册的"资源不落盘"口径订正**（2026-09-20，随
	// `<data_root>/apps/<app_id>/assets/<release_id>/` 抽取目录一起作废）：
	//   - `references/abi.md` §3.7：随包资源改为"wasm 自定义段，运行期由宿主解析后常驻
	//     内存"，可见性/直出规则同步；`ASSET_EXISTS` 的含义由"抽取时目标已存在"改成
	//     "同一个包内路径在自定义段里出现了两次"（平台直接拒，不再静默取第一个）；
	//   - `references/publishing.md` §3：`picoaide.app.json` 的落点改为"随资源集一起
	//     进内存"；
	//   - `scripts/README.md`：打包脚本产出物的去向改为内存资源集。
	//
	// 为什么必须提版本（而不是就地改 2.0.0）：2.0.0 **已随 v2.7.6-beta.7 下发**，
	// 已安装的员工靠 version 判「有更新」；就地改写会让"内容变了但版本没变"，那正是
	// 本表存在的理由（R1-pm-8）。权威口径见 docs/decisions/2026-09-20-wasm-assets-in-memory.md。
	"61daec2dac9a2badc6901ad2ffa8f1cbbe569d7dfe9f876864b5d0231d81fecc": "2.1.0",

	// 1.2.0 = 本分支的完整技能交付内容（14 个文件）：
	//   - references/imports.md（导入面白名单，R1-pm-18）+ abi/SKILL 指路；
	//   - SKILL 黄金路径第 5 步的导入面自查指引（R1-pm-8 的第二半：内容变 ⇒ 版本必须跟着变）；
	//   - scripts/pack-assets.mjs + scripts/README.md（自定义段打包脚本，R1-e2e-6，同分支并行改动）。
	//
	// 2026-09-19（R2-SK-4）：摘要口径加入**目录条目**（含空目录）后重算，内容本身未变、
	// 交付字节未变 ⇒ 版本没有变，就地替换那一条（同一版本只留一条摘要）。
	//
	// 1.1.0 的历史摘要**保留**（登记表只增不减：它同时是"这个版本交付了什么内容"
	// 的对账依据）。注意：1.1.0 从未随任何 tag 下发过 —— 它记录的是本分支早期的中间态。
	"4cfa5c266e3eaa50ec944b3b7632827e76592a13a52d79274cc433e5475a0f91": "1.1.0",
	// 2026-09-19（W1，appcfg 侧生成物重生成）：`references/app-config.md` 随
	// `appcfgspec.go` 的收敛（access 只列可写取值 login|whitelist，R1-DAT-8/UX-13）
	// 重新生成 ⇒ 交付内容变了 ⇒ SKILL.md 的 version 已由本分支提到 1.2.0，这里登记
	// 对应的新摘要。**W4 的第二次重生成（limits 侧）会再次改变摘要**：那时必须
	// 再提一级版本并登记新摘要（DAT-7 把那次登记分配给 W4），不要在本条上就地改写。
	// 1.2.0 = W1（appcfg 侧生成物重生成 + `window.*` 子字段）的交付内容。
	// ⚠️ 同一版本只留一条摘要：下面是 1.2.0 的那一份，**不要就地改写**。
	"9a6c37f4287542f38e30e5291c764aa50ad29ca97e3404b22fbe3e2acb5dfc96": "1.2.0",

	// 1.3.0 = **W4 的第二次重生成**（L7，2026-09-20）的交付内容，三处一起变：
	//   ① `references/limits.md`：删掉服务端宿主 AI / 匿名限流 / 换票 / 应用会话 /
	//      员工浏览器表单的数值行，新增 §21.2 的 AI 桥形状（64 条 / 单条 16 KiB）；
	//   ② `references/imports.md`：导入面说明里的宿主能力清单不再含 AI（`db.* / log /
	//      assets.read`），来源是 `cmd/picoaide-wasm-imports-gen` 的重生成；
	//   ③ `references/app-config.md`：`app_id` 的措辞不再写"域名标签 `<app_id>.<应用基域>`"
	//      （应用只在客户端内以 `<渠道 app 源 scheme>://<app_id>` 打开）。
	// 为什么必须提版本：交付给员工的手册字节变了，已安装的客户端靠 version 判「有更新」
	//（R1-pm-8）。W4-11 把这次登记分配给 W4，且明确**不得**在 1.2.0 上就地改写。
	"fd832c3efbd22a212bc07f39093f63c949998aa85334cd988e2cdf5323994f56": "1.3.0",
	// 1.4.0 = 示例预览宿主（`examples/go/preview.mjs`）改为按 `db.define` 登记的表名分派
	//（此前任何 `db.query` 都当 notes、`db.exec` 只认 `INSERT INTO notes` ⇒ 作者照抄示例、
	// 一用第二张表（AI 总结 summaries）就在预览里 DB_DENIED）。示例文件属技能内容 ⇒ 摘要随之变。
	"c2232f8835d891e1fe3c335cf2101925d84c4fd4d6331e53849d27b2f7d95aa6": "1.4.0",

	// 2.2.0 = **作者数据面**（2026-09-21）：应用作者可以在产品里查自己应用的数据了，
	// 手册必须跟着讲清三件事 —— 有哪些入口（工具 `wasm_app_schema` /
	// `wasm_app_diagnostics` / `wasm_app_rows` + 客户端「详情 → 数据」）、默认脱敏口径
	//（敏感列显示星号，原值只能由人在面板里显式查看并单独记审计；工具面没有 `unmask`）、
	// 以及"这不是导出接口"的边界。
	//   - `SKILL.md`：参考文件索引补"数据查看"；
	//   - `references/publishing.md`：端点表补 `rows`，工具表补三条只读工具；
	//   - `references/diagnostics.md`：**订正两处与实现不符的承诺** ——
	//     ① 应用 `log` 并没有"7 天保留"（只进服务端运维日志，平台没有日志查询接口）；
	//     ② `db_rows`/`db_bytes` 此前"只写不读"，现在真的出现在单条失败记录里；
	//     并补 §4 数据面（schema/rows 的用法、脱敏、分页语义）。
	// 为什么要提版本：这三个文件都随镜像下发给员工（R1-pm-8：内容变 ⇒ 版本必须变，
	// 已安装的客户端靠它判「有更新」）。
	"8d650d1ec1203f52fe7efd52de20d0d6c632445dffe180a46ef002093c6a494f": "2.2.0",

	// 2.3.0 = **本地预览换成真 SQLite**（2026-09-21）：`examples/go/preview.mjs` 此前是
	// "内存桩 + 三个正则解析 SQL"——作者在本地永远验不到"写一条→读列表"，也看不到自己
	// 写进去的数据（那正是"作者不能检查自己的 SQL 数据"在**开发期**的那一半）。
	// 现在它用 Node 内置 `node:sqlite`：数据落 `<产物目录>/.preview/<名字>.db`（跨调用保留、
	// 可用任何 SQLite 工具打开），语义与线上同向（单语句、query 只读、保留列 `_row_id`
	// 不可见/不可提、列类型枚举与 limits 一致），并新增 `--dump-tables` / `--fresh` /
	// `--db` / `--data-dir` / `--selftest`（8 条自检，Go 侧也有门禁跑它）。
	//   - `SKILL.md`：第 6 阶段的自测命令与两条使用要点；
	//   - `examples/go/README.md`：预览一节的说明与命令。
	"404574e29b69ad73b05bb974683e3092b2b8538c89a4d6108b1ec8ba806515fa": "2.3.0",

	// 2.4.0 = **工具链段（`.debug_*`）口径三处对齐 + 段序判据与平台同判**（2026-09-21 审计修复批）：
	//   - `scripts/pack-assets.mjs`：段表判据此前只做"纯 id 升序"，会把 TinyGo/LLVM 的
	//     **规范 DataCount 位置**（Element 之后、Code 之前）误拒；现在与 `wasmmod/parse.go`
	//     逐条同判（重复优先 → DataCount 特例 → 严格递增），并补上 Tag(13) 的拒绝文案。
	//   - `examples/go/preview.mjs`：**此前没有 `.debug_` 前缀规则** ⇒ 本地预览把几 MB 的
	//     DWARF 当应用资源直出（"本地能打开、线上 404"），且段总量预算两侧给出两个数。
	//     现在与 `assets.ToolchainSectionPrefixes` 同源，并由
	//     `assets.TestPreviewScriptSharesToolchainSectionPolicy` 双向对拍。
	//   - 段总量预算口径在两侧统一为"只计会计入资源集的段"（`.debug_*` 不计入，
	//     但非 `.debug_*` 段超 4 MiB 仍照拒）。
	"fcef001e48222b32acd8fd85154aaf5b5cb207867c36b1fc811c089d2809a7c2": "2.4.0",

	// 2.5.0 = **作者声明敏感列**（`sensitive_columns`，§5.9 第 8 点后半，2026-09-21）：
	// 默认脱敏是**列名启发式**，覆盖不到每个业务词汇 ⇒ 给作者一条声明通道（加法：
	// 声明的列一定脱敏，启发式照旧）。两处生成物随之变：
	//   - `references/app-config.md`：`picoaide.app.json` 的字段表多一行
	//     `sensitive_columns`（去重/上限/缺席即不参与的口径都写在字段提示里）；
	//   - `references/limits.md`：新增两条上限（声明条目数 100、单条列名 64 字节）。
	// 为什么必须提版本：这两份都是随镜像下发给员工的手册，已安装的客户端靠 version 判
	//「有更新」（R1-pm-8：内容变 ⇒ 版本必须跟着变）。
	"42dba768233467eaa28226e36ee8050981be784c35b04ae7dfb658c115213b01": "2.5.0",

	// 2.6.0 = **文档与代码真值对齐**（2026-09-23，第二轮审计 SKD-1/2/3/4/9 + SKD-5 第二张表）：
	// 四处技能叙述与实现相反/过时，且同技能内另有一份文件写的是对的（自相矛盾）：
	//   - `references/abi.md` §3.6：`log` 的"保留 7 天"是**调用事件**的属性，应用日志只进
	//     服务端运维日志、平台无查询接口也不承诺保留期（`appserver/hostenv.go` 的
	//     `wasm-app[<app_id>]` 行；`limits.CallEventRetentionDays` 管的是调用事件）；
	//   - `references/abi.md` §7：`FORBIDDEN` 与"发布者/冻结"无关（全包只有跨源写与审计
	//     账号两个发射点）；非发布者是 **404 `NOT_FOUND`**（不泄露存在性），冻结是
	//     **403 `APP_FROZEN`**；`APP_FROZEN` / `VALIDATE_FAILED` 两个真会发的码补进 §7.1；
	//   - `references/abi.md` §3.3/§7 + `references/diagnostics.md`：`DB_LIMIT(507)` **只**
	//     表示库写满（`appdb/appdb.go` 的 mapStmtError 注释口径）；行数/字节超限只置
	//     `QueryResult.Truncated` 不报错，语句超时是 403 `DB_DENIED` +
	//     `details.reason=statement_timeout`；
	//   - `references/publishing.md`：冻结/导出的"只读快照（90 天）→ 真删"**未实现**
	//     （`wasmapp/api/release.go` 与 `read.go` 自述"真删任务当前未实现"，`DELETE` 只软删）；
	//   - `references/abi.md` 的 `NAME_TAKEN` hints：标识由首个发布者**永久占有**（同名即同一
	//     应用），与同文件 `publishing.md` 的正确口径对齐；
	//   - `references/limits.md`（生成物）：`sql_max_rows` 的 Note 由"超出即截断并报错"改成
	//     "只截断并置 QueryResult.Truncated，不报错" —— 真源在 `limits/limitsspec.go`，
	//     本条目由 `go generate ./internal/wasmapp/limits` 产出（不是手改生成物）；
	//   - `SKILL.md` 的「并发与队列」段：补明 4096/256 两个上界来自
	//     `internal/wasmapp/applimits/applimits.go`（**不在** limits 表里，数值门禁不覆盖
	//     这张手写表），并去掉重复的"运维可在控制台改"。
	// 为什么必须提版本：整份技能是随镜像下发给员工的作者手册，已安装的客户端靠 version 判
	//「有更新」（R1-pm-8：内容变 ⇒ 版本必须跟着变）。
	"d90b4d151fe38f558b7fca6b328105f4a55776a902af0d6ae07576336f08271d": "2.6.0",

	// 2.7.0 = **单帧可交付口径的统一**（2026-09-23 R3-A 审计 A-1/A-6/A-7，P1+P2）：
	// 同一条"结果必须装进一个 1 MiB 协议帧"的约束在三处写成了互相矛盾的数字，
	// 本轮统一到**一份推导**（真源 `limits/limits.go` 的
	// `MaxDeliverablePayloadBytes = (ProtocolLineMaxBytes − FrameEnvelopeReserveBytes) /
	// MaxJSONEscapeExpansion` = 172032 B ≈ 168 KiB）：
	//   - `references/abi.md` §4：响应体由"8 MiB"改成"**保证可交付** 168 KiB；单帧上限
	//     1 MiB 是原始字节数，低转义内容实测 ~625 KB 但不是承诺"——顺带解掉同段
	//     "只写一帧"与"8 MiB"的自相矛盾；
	//   - `references/abi.md` §3.3：`db.query` 返回上限由 5000 行 / 8 MiB 改成
	//     5000 行 / 168 KiB（超出仍只截断 + `truncated:true`）；
	//   - `references/abi.md` §3.1：请求体那一行补明"整帧（含 JSON 转义）不得超 1 MiB，
	//     超了是 413 `BODY_TOO_LARGE`、应用收不到请求"；
	//   - `references/abi.md` §7：`DB_LIMIT` 的"单行超过 8 MiB"改成 168 KiB，并新增
	//     `RESULT_TOO_LARGE`（宿主结果装不进一帧的兜底码，本轮新增）；
	//   - `references/limits.md`（生成物，真源 `limits/limitsspec.go`）：
	//     `sql_max_result_bytes` 8388608 → 172032；
	//   - `references/app-config.md`（生成物）：随 appcfg 生成器一并重写（内容未变，
	//     但生成器一次写全部产物，摘要仍随之变化）。
	// 为什么必须提版本：整份技能是随镜像下发给员工的作者手册，已安装的客户端靠 version 判
	//「有更新」（R1-pm-8：内容变 ⇒ 版本必须跟着变）。
	"bd4a7c2a7e195f670119ca3cd29388ee3326323e0ac0a9874f4e23c7fb58807e": "2.7.0",
}

// TestBuiltinSkillVersionTracksContent 断言当前技能内容的摘要已在登记表里，且登记的
// 版本与 SKILL.md 写的一致（并反向断言"一个版本只对应一次内容交付"）。
func TestBuiltinSkillVersionTracksContent(t *testing.T) {
	digest, files := skillContentDigest(t, repoSkillDir)
	version := skillFrontmatterVersion(t, filepath.Join(repoSkillDir, SkillFile))
	if files < 10 {
		t.Fatalf("只摘要到 %d 个文件（技能目录被搬走或变空？）", files)
	}
	want, ok := seededSkillDigests[digest]
	if !ok {
		t.Fatalf("内置技能内容变了，但 seededSkillDigests 里没有这个摘要（R1-pm-8）：\n"+
			"  内容摘要 = %s（%d 个文件）\n"+
			"  当前 SKILL.md 的 version = %s\n"+
			"  修复：①把 SKILL.md 的 version 提一级 —— 内容变就必须提，已安装的员工靠它判「有更新」；\n"+
			"        ②把 %q: %q 加进本文件的 seededSkillDigests。",
			digest, files, version, digest, "<新版本>")
	}
	if want != version {
		t.Fatalf("内容摘要 %s 登记的是 version %s，而 SKILL.md 写的是 %s（提了版本但忘了同步登记表？）",
			digest, want, version)
	}
	// 反向断言：一个 version 只能对应一个内容摘要（否则"提版本"可以被绕过：
	// 改内容 + 把新摘要也标成同一个版本号）。
	byVersion := map[string]string{}
	for d, v := range seededSkillDigests {
		if prev, dup := byVersion[v]; dup {
			t.Fatalf("version %s 对应了多个内容摘要（%s 与 %s）—— 版本号必须唯一标识一次内容交付", v, prev, d)
		}
		byVersion[v] = d
	}
}

// TestSeededSkillVersionMatchesManifestGate 只是把"版本号字面量只有一处"这件事钉住：
// 其它用例里的 seededSkillVersion 必须与 SKILL.md 一致（避免提版本时漏改断言）。
func TestSeededSkillVersionMatchesManifestGate(t *testing.T) {
	if got := skillFrontmatterVersion(t, filepath.Join(repoSkillDir, SkillFile)); got != seededSkillVersion {
		t.Fatalf("SKILL.md 的 version = %s，而测试常量 seededSkillVersion = %s —— 两处必须一起改",
			got, seededSkillVersion)
	}
}

// skillContentDigest 把技能目录摘要成确定性 sha256（相对路径 + 逐字节内容，按路径排序）。
//
// 刻意**不**看 mtime / 文件模式 / 目录项顺序：同一份内容在任意机器上都是同一个摘要
// （否则登记表会变成"每台机器一份"的噪音）。
//
// 口径（R2-SK-4）：**目录也进摘要**（含空目录）—— `PackDir` 为每个目录产出 tar
// 条目（`items = append(items, item{name: clean + "/", dir: true, …})`），所以哪怕
// 只加一个空目录，下发的 archive sha256/size（客户端 `X-Skill-Checksum` 对拍的那两个
// 值）都会变。此前只收 `d.Type().IsRegular()`，于是"下发字节变了、版本门禁仍绿"。
// 返回 (摘要, 参与摘要的**普通文件**数)。
func skillContentDigest(t *testing.T, dir string) (string, int) {
	t.Helper()
	var entries []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil // 包根自身不入摘要（PackDir 也不为它产出条目）
		}
		rel, rerr := filepath.Rel(dir, path)
		if rerr != nil {
			return rerr
		}
		relSlash := filepath.ToSlash(rel)
		switch {
		case d.IsDir():
			entries = append(entries, "D:"+relSlash)
		case d.Type().IsRegular():
			entries = append(entries, "F:"+relSlash)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s: %v", dir, err)
	}
	sort.Strings(entries)

	h := sha256.New()
	files := 0
	for _, e := range entries {
		if kind, rel, ok := strings.Cut(e, ":"); ok && kind == "D" {
			// 目录只记路径：空目录与"目录本身"同样是下发字节的一部分。
			fmt.Fprintf(h, "D:%s\n", rel)
			continue
		}
		_, rel, _ := strings.Cut(e, ":")
		content, rerr := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if rerr != nil {
			t.Fatalf("读 %s: %v", rel, rerr)
		}
		// 路径与长度都进摘要：改名/改内容/换行差异都会变。
		fmt.Fprintf(h, "F:%s:%d\n", rel, len(content))
		h.Write(content)
		h.Write([]byte{'\n'})
		files++
	}
	return hex.EncodeToString(h.Sum(nil)), files
}

// R2-SK-4：目录摘要必须覆盖**空目录**。
//
// PackDir 为每个目录产出 tar 条目，所以"只加一个空目录、不加任何文件"同样改变下发
// 的字节（archive sha256/size、客户端下载时的 X-Skill-Checksum 都会变）；摘要若只收
// 普通文件，这种变化就完全不可见，版本门禁照绿。
//
// 变异验证（实跑过）：把 skillContentDigest 的目录分支删掉（回到只收
// `d.Type().IsRegular()` 的旧形态）⇒ 本用例在"空目录没进摘要"那条必红。
func TestSkillContentDigestCoversEmptyDirectories(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, SkillFile), []byte("---\nname: x\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mkdir := func(rel string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	mkdir("references")
	before, beforeFiles := skillContentDigest(t, dir)
	beforeArchive, _, err := PackDir(dir)
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}

	// 只加一个空目录：一个文件都不新增。
	mkdir("references/zz-empty")
	after, afterFiles := skillContentDigest(t, dir)
	afterArchive, _, err := PackDir(dir)
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}

	// 前置：PackDir 确实为目录产出条目（否则"空目录进摘要"就无从谈起）。
	if bytes.Equal(beforeArchive, afterArchive) {
		t.Fatal("前置失败：加一个空目录后下发归档必须变（PackDir 为每个目录产出条目）")
	}
	if afterFiles != beforeFiles {
		t.Fatalf("空目录不得增加普通文件数：%d → %d", beforeFiles, afterFiles)
	}
	if before == after {
		t.Fatalf("空目录没进摘要：下发归档已变（len %d → %d）而版本门禁仍绿 —— R2-SK-4 的缺口",
			len(beforeArchive), len(afterArchive))
	}
	// 反向对照：同一份内容（含空目录）重复计算必须稳定（摘要确定性）。
	again, _ := skillContentDigest(t, dir)
	if again != after {
		t.Fatalf("摘要必须确定性：%s vs %s", after, again)
	}
}

// frontmatterVersionRe 抠 frontmatter 里的 version 行（只认文件开头的 `---` 块）。
var frontmatterVersionRe = regexp.MustCompile(`(?m)^version:[ \t]*(\S+)[ \t]*$`)

// skillFrontmatterVersion 读 SKILL.md frontmatter 的 version（读不到即 Fatal：
// skillmanifest.Parse 也会因此把整条技能丢掉）。
func skillFrontmatterVersion(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s: %v", path, err)
	}
	text := string(raw)
	if !strings.HasPrefix(text, "---\n") {
		t.Fatalf("%s 必须以 frontmatter 开头", path)
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		t.Fatalf("%s 的 frontmatter 没有结束行", path)
	}
	m := frontmatterVersionRe.FindStringSubmatch(text[:4+end])
	if m == nil {
		t.Fatalf("%s 的 frontmatter 缺 version（内置技能会被静默丢弃）", path)
	}
	return m[1]
}
