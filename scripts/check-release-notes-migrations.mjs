#!/usr/bin/env node
/**
 * 发布说明判据：**迁移清单 + 章节归属**（2026-10-05；前者是 E-01/E-02 的防再犯判据，
 * 后者是 F8 的防再犯判据）。
 *
 * ## 它防的是什么（现场，不是设想）
 *
 * `docs/releases/v2.8.2-beta.2.md` 逐字写着「本版无新增迁移（服务端 schema 与上一版一致）」与
 * 「本版没有数据库迁移，所以回滚只需要换回上一版镜像」—— 而 `0082_report_subscription_retry.sql`
 * 恰恰是**那一版**引入的（`git diff --diff-filter=A v2.8.2-beta.1..v2.8.2-beta.2 -- …/migrations-pg`
 * 只有它一条）。同一区间的 `v2.8.2-beta.1.md` 则把两条迁移（`0080`/`0081`）写成一条，并且把
 * `0082` 的回滚说明（该迁移文件头部逐字要求先 `DELETE FROM schema_migrations WHERE version = 82;`
 * 再换镜像）写进了**不含 0082** 的那一版。
 *
 * 为什么没有守卫咬到：`docs/releases/**` 是 `scripts/check-migration-range.mjs` 的**记录面豁免**
 * （记录面文档不得跟着 `MAX` 走，否则等于篡改历史），所以"发布说明写错迁移"这件事在结构上
 * 落在所有既有守卫的判据面之外。本脚本只补这一条缝，不碰记录面豁免原则。
 *
 * ## 判据（五件，全部 fail-closed）
 *
 *   ① **声明的集合 == 实际新增的集合**（双向）：每份发布说明里有一行**机器可读锚点**
 *      （见 {@link ANCHOR_PATTERN}）声明本版引入的迁移文件；实际值由
 *      `git diff --name-status <上一 tag>..<本 tag> -- <迁移目录>` 现场算出。两向都判：
 *      漏报（实际有、声明无）与虚报（声明有、实际无）都红。
 *      判据面 = **`A` + `R` + `C`**（见 {@link classifyNameStatus}）：`loadMigrations` 按文件名
 *      前 4 位定版本号，所以区间内 `git mv 0083_x.sql 0084_y.sql` **真的会多执行一个版本**
 *      （2026-10-05 E-01 复审实测：旧实现只认 `A`，重命名形态判「声明与实际一致 ✅」）。
 *   ② **锚点必须存在且恰好一行**：缺锚点（或写成两行）⇒ **退出码 2**（前置失败，不是"没漂移"）——
 *      否则"删掉那一行"就成了新的绕过通道。
 *   ③ **正文散文不得与锚点矛盾**：只钉锚点的判据对"锚点正确、正文写错"（E-02 的**原始**形态：
 *      「本版只有一条**只加列**的迁移」而实际两条）完全没有牙。现补三条互不重叠的形态判据
 *      （否定式 / 计数式 / 回滚式，见 {@link proseFindings}）。
 *   ④ **本次发布的 tag 必须在链上**（tag 期）：`GITHUB_REF` 是 `refs/tags/<tag>` 时，
 *      `<tag>` 必须出现在 `RELEASE_CHAIN` 里 —— 否则这一版天然落在判据面之外。
 *   ⑤ **章节归属**（{@link SECTION_JUDGMENT_DOC}）：**双向**判据 —— 发布说明里的每一个二级
 *      章节，要么**在该 tag 的版本里就有**，要么必须逐条登记进 `POST_TAG_SECTIONS`（登记项要
 *      给出"改动由哪个提交落地"，且该提交必须**在该 tag 内**）；反过来，**tag 版里有、工作树里
 *      没有**的章节同样必须逐条登记（`MOVED_TAG_SECTIONS`：写明搬去哪一版或确属删除 + 理由，
 *      且"搬去哪一版"要在那一版的工作树里真的找得到 —— 对不上就是死条目）。
 *      另加三条结构判据：章节不得跨版本重复、
 *      中文序号必须连续、同一个审计轮次不得被两份发布说明同时登记。
 *
 * ## 它在哪儿跑（2026-10-05 接线；此前是**死判据**）
 *
 * `.github/workflows/ci.yml` 的 `gate` job 里、紧跟"策展说明检查"的那一步
 * `Release notes declare the migrations this tag introduces`：`if` 取自 `ci-release-policy.sh`
 * 的 `release_kind`（唯一真源，只在**发布 tag** 上执行），步骤体先用冻结启动器跑 `--self-test`
 * 再跑真判。**接线本身**由 `scripts/check-workflows.mjs` 的 `REGISTERED_RELEASE_STEPS`
 * （`[SK-15]`）钉住：步骤被删/改名、`if:` 被改、`continue-on-error` 被打开、或命令位不再真的
 * 执行本脚本 ⇒ 那条守卫直接红。
 *
 * 为什么不在 `yarn check` / 根守卫里跑 —— 两层理由，**第二层才是真障碍**：
 *   ① 判据的输入是**区间两端的 tag**，分支/PR 上没有语义（此时本脚本打印跳过理由并 exit 0，
 *      **不是** exit 2）；
 *   ② **真障碍**：链尾那一版的 tag 要到发版提交**之后**才存在。发布 PR 把新版本追加进
 *      `RELEASE_CHAIN` 时那个 tag 还没被创建 ⇒ 放在 PR 期的根守卫上等于必然"取不到 tag"。
 *      （2026-10-05 勘误：初版把理由写成"CI 各 job 的 `actions/checkout` 缺省 `fetch-depth: 1`
 *      且不取 tag"—— **对 `gate`/`gate-guards` 两个 job 不成立**，它们的 checkout 都是
 *      `fetch-depth: 0`，同 job 的 `ci-release-topology.sh` 就靠本地 `refs/tags/` 枚举。
 *      `--depth 1 --no-tags` 的检出确实会让本判据 exit 2，但那不是 CI 的实际形态。）
 *
 * ## 登记制（不是"扫到哪儿算哪儿"）
 *
 * `RELEASE_CHAIN` 是**手写**的 tag 链（每一版的"上一版"就是链上前一个元素，链首 = 基线）。
 * 任何**未登记**的 `docs/releases/v2.8.2-beta.*.md` 一律红：新增一版发布说明必须同时把它
 * 加进链里，否则新版本可以"天然"落在判据面外（这正是本条判据要防的形态）。
 *
 * 退出码：0 = 声明与实际一致（或"本次不是 tag"的显式跳过）；1 = 有漂移（漏报/虚报/自相矛盾/
 * 未登记的发布说明/发布的 tag 不在链上）；2 = **前置失败**（tag 取不到、锚点缺失或重复、
 * 链太短、git 不可用、扫描面为 0、`GITHUB_REF` 与 `GITHUB_REF_NAME` 不一致）——
 * 取不到输入时**绝不**打印"一致 ✅"。
 *
 *     node scripts/check-release-notes-migrations.mjs              # 判 + 打印真值表
 *     node scripts/check-release-notes-migrations.mjs --json       # 同上，输出机器可读结果
 *     node scripts/check-release-notes-migrations.mjs --self-test  # 只跑分类器/正文判据的固定样本
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 迁移目录（仓库相对 POSIX 路径）。 */
const MIGRATIONS_DIR = 'server/internal/serverstore/migrations-pg'

/** 发布说明目录（仓库相对）。 */
const RELEASES_DIR = 'docs/releases'

/**
 * 发布线：链首是**基线 tag**（不需要发布说明），其后每一项都必须有
 * `docs/releases/<tag>.md` 且带机器可读锚点。
 *
 * 新增一版（例如 `v2.8.2-beta.6`）时把它追加到链尾；漏加 ⇒ 退出码 1（未登记的发布说明）。
 */
const RELEASE_CHAIN = [
  'v2.8.1',
  'v2.8.2-beta.1',
  'v2.8.2-beta.2',
  'v2.8.2-beta.3',
  'v2.8.2-beta.4',
  'v2.8.2-beta.5',
  'v2.8.2-beta.6',
  'v2.8.2-beta.7',
  'v2.8.2',
  'v2.8.3-beta.1',
]

/** 未登记发布说明的判据面：本区间的文件名前缀（防"新版本天然落在判据外"）。 */
const UNREGISTERED_NOTE_PREFIX = 'v2.8.3-beta.'

/** `GITHUB_REF` 里 tag 引用的前缀 —— "本次是不是在发 tag"的**唯一**判据形态。 */
const TAG_REF_PREFIX = 'refs/tags/'

/**
 * 机器可读锚点的**唯一**形态（发布说明里恰好一行）：
 *
 *     - **迁移清单（机器可读锚点，供 `scripts/check-release-notes-migrations.mjs` 与 `git diff` 对拍）**：`0080_x.sql`、`0081_y.sql`
 *
 * 无迁移时写「无」。解析只认反引号里的 `<4 位数字>_<名字>.sql`；锚点行里既没有文件名、
 * 也没有「无」字 ⇒ 不可解析 ⇒ 退出码 2（不猜）。
 */
const ANCHOR_MARKER = '**迁移清单（机器可读锚点'
const ANCHOR_PATTERN = /^-\s+\*\*迁移清单（机器可读锚点[^*]*\*\*：(.+)$/u
const SQL_NAME_PATTERN = /`(\d{4}_[A-Za-z0-9_]+\.sql)`/gu

/**
 * ③ 正文散文判据之一：**否定式声明**。声明了迁移的那一版不得再说"本版无（新增）数据库迁移"。
 *
 * 边界（有意的窄面）：必须与「本版」同行，且「没有/无」与「迁移」都紧邻它 —— 发布说明的
 * 段落是按行折的，跨行的句子抓不到（宁可漏报，不要拿"任何地方出现过'无迁移'"去误伤
 * 描述历史事实的句子）。
 */
const NO_MIGRATION_CLAIM = /本版[^。；\n]{0,8}(没有|无)[^。；\n]{0,8}迁移/u

/**
 * ③ 正文散文判据之二：**计数式声明**（E-02 的原始形态就是它）。
 *
 * 形态：同一行里先有「本版」，随后 `[数字|中文数词] 条 … 迁移`；括号/全角括号/冒号不得
 * 出现在「条 → 迁移」之间（否则「（本版多一步，两步都要做）：本版引入了迁移」这种
 * 与条数无关的行会被误判成"2 条迁移"）。解析出的条数必须等于锚点声明的条数。
 */
const COUNT_CLAIM = /本版[^。；\n]{0,16}?([一二三四五六七八九十两0-9]+)\s*条[^。；\n（）()：]{0,12}?迁移/u

/**
 * ③ 正文散文判据之三：**回滚式声明**。锚点声明了迁移时，正文不得再写"回滚只需换回镜像"
 * （E-01 的原始形态：`v2.8.2-beta.2.md` §六 逐字如此，而该版引入了 `0082`）。
 *
 * 声明了"无迁移"的版本（锚点=无）写这句话是对的，所以本判据只在 `declared.length > 0` 时生效。
 */
const ROLLBACK_ONLY_CLAIM = /回滚[^。；\n]{0,24}(?:只需|只要|仅需|仅要)[^。；\n]{0,24}(?:换回|换到|换成|回退|切回)[^。；\n]{0,12}镜像/u

/** 中文数词 → 数字（只覆盖"几条迁移"这种量级；解析不出即不判，见 {@link claimCount}）。 */
const CN_NUMERALS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/**
 * ⑤ 章节归属判据的口径（一处写完，供文件头与本判据的报错文案共用）。
 *
 * 现场：`docs/releases/v2.8.2-beta.1.md` 在 tag 之后被追加了六个小节（§八–§十三），
 * 描述的是**第十至二十七轮**审计的修复 —— 而 `v2.8.2-beta.1` 的 tag 里根本没有那些改动
 * （`git tag --contains <round-10 提交>` 只给 beta.2 及之后）。于是"beta.1 的发布说明"里
 * 写着 beta.1 树里不存在的东西，客户与运维按它判断升级行为会读错。
 *
 * 这个形态此前没有任何守卫能咬到：`docs/releases/**` 是记录面豁免，迁移清单判据只看迁移，
 * 而"这一节属于哪一版"从来没有被表述成机器可判的关系。本判据把它变成：
 * **章节的归属 = 它在该 tag 的版本里存在，或者被逐条登记（且登记项能指到 tag 内的落地提交）**。
 *
 * 2026-10-04 FF-3（独立核验 `temp/audit-v282/verify/fresh-fixes.md`）：上面这条只是**单向**的
 * （只问"工作树比 tag 版多出来的章节"）。反方向 —— **tag 版有、工作树被删/改写** —— 当时
 * 零判据：隔离副本实测"删掉最后一节（序号仍连续）⇒ 守卫 EXIT=0"。现在由
 * {@link MOVED_TAG_SECTIONS} 补上这半边（判据说明见那里的注释）。
 */
const SECTION_JUDGMENT_DOC = '每个二级章节必须在 tag 版本里存在，或被登记为"tag 之后追加"；'
  + 'tag 版本里有、工作树里没有的章节必须逐条登记去向（或登记为删除并写明理由）'

/**
 * 章节归属判据的登记表 —— **唯一**允许"tag 之后追加的章节"的地方。
 *
 * 形状严格：`{ note, heading, rounds, landedBy, reason }`
 *   · `note`     = tag（与发布说明文件名同一串，不带 `.md`）；
 *   · `heading`  = **逐字**的二级标题行（含行首 `## `）；
 *   · `rounds`   = 该小节登记的审计轮次数组（必须能在 `heading` 里逐个数出来）；
 *   · `landedBy` = 该小节描述的改动**由哪些提交落地**（至少一个，git 可解析的 revision）；
 *   · `reason`   = 为什么这一节写在 tag 之后（自由文本，不得为空）。
 *
 * 为什么 `landedBy` 是必需的：没有它，登记表就只是人工声明 —— 把一个小节错放进旧版本只需要
 * 补一行登记。有了它，错放必须能在**旧 tag 里**指出一个"落地提交"，而错放的成因恰恰是那些
 * 改动**不在**旧 tag 里 ⇒ 登记项当场红（`git merge-base --is-ancestor <landedBy> <note>`）。
 * 它挡不住"故意指一个 tag 内的无关提交"，但把无声漂移变成了必须写下来、可被复核的声明。
 */
function rangeRounds(from, to) {
  const out = []
  for (let n = from; n <= to; n += 1) out.push(n)
  return out
}

const POST_TAG_SECTIONS = [
  {
    note: 'v2.8.2-beta.1',
    heading: '## 六、第九轮审计修复（同版本内继续收口）',
    rounds: [9],
    landedBy: ['f36a9711ae'],
    reason: '第九轮的修复就是 beta.1 的 tag 提交本身（f36a9711ae），只是这一节的文字写在 tag 之后',
  },
  {
    note: 'v2.8.2-beta.1',
    heading: '## 七、第九轮的行为变更登记（升级与运维视角）',
    rounds: [9],
    landedBy: ['f36a9711ae'],
    reason: '同上：登记的是 beta.1 tag 内已有的第九轮行为变更（四条）',
  },
  {
    note: 'v2.8.2-beta.2',
    heading: '## 六、第十至二十七轮审计的行为变更登记（升级与运维视角）',
    rounds: rangeRounds(10, 27),
    landedBy: [
      '3264137997', // 第十轮
      '12540e681c', // 第十一轮
      '1816718f32', // 第十二轮
      '7608b473c9', // 第十三/十四轮
      '44ffde8034', // 第十五轮
      '304a5efd4b', // 第十八轮
      '5a27ba3b3f', // 第十九轮
      'ba5e1d35c8', // 第二十至二十七轮的登记与收口（v2.8.2-beta.2 的发布提交）
    ],
    reason: 'F8 归属修正：这六个小节原先错写在 beta.1.md（那些轮次的改动不在 beta.1 内），按轮次搬回本版',
  },
]

/**
 * `MOVED_TAG_SECTIONS.movedTo` 的哨兵值：这一节是**被删除**的（不是搬去了别的版本）。
 * 用它就必须在 `reason` 里写清"为什么删得掉"。
 */
const TAG_SECTION_REMOVED = '<removed>'

/**
 * 反向（2026-10-04 FF-3）：「tag 版**有**、工作树**没有**」的二级章节 —— **必须逐条登记去向与理由**。
 *
 * ## 为什么补这半边
 *
 * `docs/releases/<tag>.md` 是 GitHub Release 正文的**唯一来源**
 * （`.github/workflows/ci.yml` 的 `gh release create/edit --notes-file`）。对**已发布** tag 的
 * 说明做删除/搬运，会让"仓库文件 vs 客户看到的 Release 正文"永久分叉 —— 而此前这条路径上
 * **一个判据都没有**：`lateSections` 只问"工作树比 tag 版**多**出来的章节有没有登记"。
 *
 * 独立核验（`temp/audit-v282/verify/fresh-fixes.md` FF-3）在隔离副本上实测：把
 * `docs/releases/v2.8.2-beta.2.md` 的**最后一节**整节删掉（序号仍连续）⇒ 守卫 **EXIT=0**；
 * 删中间节时会被"章节序号不连续"**顺带**咬到（那是版面判据，重排序号即可绕过 —— 而重排序号
 * 恰恰是搬运章节时的正常动作）。本批自己就动过这个形态（beta.1 的若干小节搬去 beta.2），
 * 当时靠人肉保证。
 *
 * ## 形状（与 `POST_TAG_SECTIONS` 同族）
 *
 *   · `note`     = tag（与发布说明文件名同一串，不带 `.md`）；
 *   · `heading`  = **逐字**的 tag 版二级标题行（含行首 `## `）。比对按 {@link sectionKey}
 *                  **去序号**：搬运/插入章节后章节号必须按版面重排，序号不是身份、正文才是；
 *   · `movedTo`  = 去向，二选一：
 *                  - 另一版发布说明的 tag：**必须**在 `RELEASE_CHAIN` 里，且那一版的**工作树**
 *                    里真的能按同一 {@link sectionKey} 找到这一节（找不到 ⇒ 死条目/去向写错 ⇒ 红）；
 *                  - {@link TAG_SECTION_REMOVED}：确属删除（`reason` 要写清为什么删得掉）。
 *   · `reason`   = 为什么这一节不在工作树里了（自由文本，至少 8 字符）。
 *
 * ## 双向对账（缺一不可）
 *
 *   · **没登记的**「tag 版有、工作树没有」⇒ 红（本判据的本体）；
 *   · **登记了但这一节并不满足那个形态**（它其实还在工作树里）⇒ 红（**死条目** ——
 *     否则登记表会积累成"看起来在管、其实什么都没管"的装饰）。
 *
 * ## 判据面（如实说明，避免被读成"覆盖得比实际多"）
 *
 *   · 输入 = `git show <tag>:<path>`（tag 版）与**工作树文件**（不是 HEAD / 不是索引）——
 *     所以"这两份发布说明在 HEAD 里还不存在（未跟踪）"这一形态照常判定（`git show` 取 tag 版，
 *     `readFileSync` 取工作树），既不会静默跳过，也不会因为"HEAD 没有这个文件"判死；
 *   · **只钉章节集合**（标题身份）。**章节正文被改写不在判据面内** —— 已发布 tag 的说明里
 *     改一句话、加一行锚点，本判据看不见（本仓当前就有这样的漂移：beta.1/beta.2 的口径修正、
 *     beta.3/.4/.5 的 +1 行机器可读锚点）。这是**已知边界**，不是"已覆盖"。
 */
const MOVED_TAG_SECTIONS = []

/** 二级标题行（只认 `## `；`###` 是章节内部的小节，不参与章节归属判定）。 */
const SECTION_LINE_PATTERN = /^## +(\S.*)$/u

/** 标题里的中文/阿拉伯序号：`## 三、…` / `## 12、…`。 */
const SECTION_ORDINAL_PATTERN = /^## +([一二三四五六七八九十百0-9]+)\s*[、.．]/u

/** 去掉标题序号的前缀（`## 七、附件与校验` → `附件与校验`）。 */
const SECTION_ORDINAL_PREFIX = /^## +[一二三四五六七八九十百0-9]+\s*[、.．]\s*/u

/**
 * 模板规定的**固定小节**：它们在每一版发布说明里都要出现，**按设计就会跨版本重名**
 * （本仓 beta.3/4/5 就有三处同名固定小节）。跨版本重复判据必须把它们排除，
 * 否则整片假红；序号化与否都不影响该排除。
 */
const FIXED_SECTION_KEYS = new Set([
  '已知限制（本版认账，未修）',
  '升级与回滚',
  '附件与校验',
  '访问模型变更（升级必读）',
])

/**
 * 章节的**身份** = 去掉序号后的标题正文。
 *
 * 为什么按"去序号"比对而不是逐字比对：章节号是**版面**（搬运/插入章节后必须重排），
 * 正文才是**身份**。逐字比对时，"把附件节从 §六 顺延成 §七"会被误判成"tag 之后追加的章节"——
 * 而它是同一节。反过来，把「第十轮的行为变更登记」挪进 beta.1 无论编成第几号，正文都对不上
 * beta.1 的 tag ⇒ 照常命中。
 * @param {string} heading - 二级标题行（应已 trim）。
 * @returns {string} 身份串。
 */
function sectionKey(heading) {
  return heading.replace(SECTION_ORDINAL_PREFIX, '').trim()
}

/**
 * 跨版本**合法重名**的章节标题登记表（2026-10-04，主控裁决后新增）。
 *
 * ## 它解决什么
 *
 * `crossNoteSectionFindings` 的判据③是"同一节标题不得出现在两版发布说明里"（搬运 ≠ 复制）。
 * 但**通用标题**（如「升级须知」「验证与门禁」）在相邻两版里重名是**正当**的 —— 每版都要告诉读者
 * 这一版怎么升级、验了什么。判据不能靠"把这类标题塞进 `FIXED_SECTION_KEYS`"来变绿：那是
 * **白名单式放宽**（`FIXED_SECTION_KEYS` 的语义是"模板规定的固定小节"，加错地方等于永久关掉
 * 这些标题的重复判定）。所以改成**显式登记 + 双向对账**：登记一条 = 公开声明"这个标题重名是
 * 正当的，理由如下"，并且必须在真实数据里**确实重名**（否则就是死条目 ⇒ 红）。
 *
 * ## 形状
 *
 *   · `key`    = **去序号后**的标题正文（{@link sectionKey}）——序号是版面、正文才是身份；
 *   · `reason` = 为什么这个标题在多个版本里重复是正当的（自由文本，至少 8 字符）。
 *
 * ## 双向对账（`legitRepeatedSectionFindings`，两条都红）
 *
 *   · **真实重复却没登记** ⇒ 红（由 `crossNoteSectionFindings` 报"同一节出现在两版"，
 *     报错文案里给出登记路径）；
 *   · **登记了却在任何两版里都对不上**（该标题在真实数据里出现 < 2 版）⇒ 红（死条目）；
 *   · 条目缺 `key`/`reason`、`key` 带序号前缀、同一条 `key` 登记两次 ⇒ 红。
 *
 * ## 判据面（如实）
 *
 * 输入面 = `sectionRows`（= `RELEASE_CHAIN[1..]` 各版**工作树**的二级标题；链首基线不参与，
 * 这是既有口径）；只看"带序号或带审计轮次"的二级标题，且排除 `FIXED_SECTION_KEYS`。
 * 当前真实重复集只有 `{升级须知, 验证与门禁}`（两版：v2.8.2-beta.1 / beta.2；
 * 复核探针 `temp/audit-v282/evidence/FF-A/ff3_repeat_probe.log`：把链首 v2.8.1 也算进来
 * 不会新增任何重复项）。
 */
const LEGIT_REPEATED_SECTION_KEYS = [
  {
    key: '升级须知',
    reason: '通用章节：每一版都必须告诉读者"这一版怎么升级、要不要停机、回滚怎么做"，'
      + '两版同名是正当的（内容各自写自己那一版；判据只看标题身份，不看正文）',
  },
  {
    key: '验证与门禁',
    reason: '通用章节：每一版都要交代"这一版验了什么、门禁跑没跑绿"，两版同名是正当的',
  },
]

/** 通用标题重复的登记表条数下限（ratchet：只许提高；防止"清空登记表"把红翻绿）。 */
const MIN_LEGIT_REPEATED_KEYS = 2

/** 标题里的审计轮次：`第N轮`、`第N至M轮`、`第N与M轮`、`第N、M轮`。 */
const ROUND_CLAUSE_PATTERN = /第([一二三四五六七八九十百0-9]+)((?:[至与、～~-][一二三四五六七八九十百0-9]+)*)轮/gu

/**
 * 取出正文里的二级标题（保持文件顺序）。
 *
 * **必须 trim**：`docs/releases/**` 是 LF 入库，但 Windows 检出（`core.autocrlf`）会给每行
 * 带上 `\r` —— 不 trim 的话"tag 版本 vs 工作树"的逐字比对会在 Windows CI 上整片假红。
 * @param {string} text - 发布说明正文。
 * @returns {string[]} 逐字（去首尾空白）的二级标题行。
 */
function levelTwoHeadings(text) {
  return text.split('\n').map(line => line.trim()).filter(line => SECTION_LINE_PATTERN.test(line))
}

/**
 * 中文/阿拉伯数词 → 整数（只用于章节序号；解析不出返回 `null`）。
 * @param {string} raw - 数词。
 * @returns {number|null} 数值。
 */
function sectionOrdinal(raw) {
  if (/^\d+$/u.test(raw)) return Number(raw)
  const value = claimCount(raw)
  return value
}

/**
 * 标题里声明的审计轮次集合（升序去重）。
 * @param {string} heading - 二级或三级标题行。
 * @returns {number[]} 轮次。
 */
function roundsInHeading(heading) {
  const found = new Set()
  for (const match of heading.matchAll(ROUND_CLAUSE_PATTERN)) {
    const start = sectionOrdinal(match[1])
    if (start === null) continue
    found.add(start)
    for (const tail of match[2].matchAll(/[至与、～~-]([一二三四五六七八九十百0-9]+)/gu)) {
      const end = sectionOrdinal(tail[1])
      if (end === null) continue
      const [lo, hi] = start <= end ? [start, end] : [end, start]
      for (let n = lo; n <= hi; n += 1) found.add(n)
    }
  }
  return [...found].sort((a, b) => a - b)
}

/**
 * 二级/三级标题行（`## ` 与 `### `）。
 * @param {string} text - 发布说明正文。
 * @returns {string[]} 标题行（去首尾空白、保持顺序）。
 */
function headingLines(text) {
  return text.split('\n').map(line => line.trim()).filter(line => /^#{2,3} +(\S.*)$/u.test(line))
}

/**
 * 跨版本的章节结构判据（**纯函数**）：三条互相独立的形态。
 *
 *   ① **章节不得跨版本重复**：判据面**只取"带序号的"或"带轮次的"二级标题**，且排除模板
 *      规定的**固定小节**（{@link FIXED_SECTION_KEYS}：`已知限制` / `升级与回滚` / `附件与校验`
 *      / `访问模型变更`）—— 它们按设计在每一版里都要出现，算进来会整片假红（本仓
 *      beta.3/4/5 就有三处同名固定小节）。比对按 {@link sectionKey}（去序号）做，
 *      所以"复制过去再改个号"也照样撞车。
 *   ② **中文序号必须连续**：带序号的二级章节必须依次是 一、二、三…（搬运/插入章节后忘了
 *      重排序号，读者就会看到"§五 后面直接是 §七"）。
 *   ③ **同一个审计轮次只能被一版登记**：轮次从**全部标题**（`##` 与 `###`）里数，
 *      并并入登记表声明的轮次。把某一轮的小节搬回旧版本时，这一条会与新版的那一节撞车。
 *
 * **接线（2026-10-04 主控裁决后修复）**：这三条判据读的是 `entry.note`，而 driver 曾经压的是
 * `tag` 字段 ⇒ `entry.note` 恒 `undefined`：报错文案变成 `undefined.md: …`、
 * `POST_TAG_SECTIONS` 按版本过滤恒为空、**判据①（跨版本重复）在生产里恒不触发** = 死判据
 * （自检传的是 `note`，所以自检绿、生产退化 —— 典型的"量具坏了"）。
 * 现在 driver 压 `note`，并且函数入口对缺 `note` 的行 **fail-loud**（不改回静默退化）。
 *
 * **合法重名（同一次裁决）**：「升级须知」「验证与门禁」这类**通用标题**在相邻两版重名是正当的，
 * 但它们**不在** `FIXED_SECTION_KEYS`（那张表的语义是"模板规定的固定小节"），
 * 所以走**显式登记表** {@link LEGIT_REPEATED_SECTION_KEYS}（带理由 + 双向对账），
 * 而不是把标题塞进 `FIXED_SECTION_KEYS` 放宽判据。
 *
 * @param {{note: string, workSections: string[], allHeadings: string[]}[]} notes - 各版本的章节面。
 * @param {object} [options] - `registry`：合法重名登记表（默认 {@link LEGIT_REPEATED_SECTION_KEYS}）。
 * @returns {string[]} 漂移描述。
 */
function crossNoteSectionFindings(notes, options = {}) {
  const findings = []
  const legitKeys = new Set((options.registry ?? LEGIT_REPEATED_SECTION_KEYS).map(entry => entry.key))
  const headingOwners = new Map()
  const roundOwners = new Map()

  for (const entry of notes) {
    // 接线 fail-loud：`note` 是这一族的**版本名唯一来源**（报错文案、`POST_TAG_SECTIONS` 过滤、
    // 重复判据的 owner 都读它）。缺它 ⇒ 判定"判据读不到输入"，而不是当作漂移、更不是静默跳过。
    if (typeof entry.note !== 'string' || entry.note.trim() === '') {
      findings.push('章节结构判据的输入缺 note（内部接线错误：每条 sectionRows 必须带 note）—— '
        + '这条不是"发布说明漂移"，而是判据读不到版本名，拒绝当作通过。')
      continue
    }
    for (const heading of entry.workSections) {
      const key = sectionKey(heading)
      if (FIXED_SECTION_KEYS.has(key)) continue
      const versionSpecific = SECTION_ORDINAL_PATTERN.test(heading) || roundsInHeading(heading).length > 0
      if (!versionSpecific) continue
      if (legitKeys.has(key)) continue // 合法重名：由 legitRepeatedSectionFindings 双向对账
      const owners = headingOwners.get(key) ?? []
      owners.push({ note: entry.note, heading })
      headingOwners.set(key, owners)
    }

    const ordinals = entry.workSections
      .map(heading => ({ heading, value: sectionOrdinal(SECTION_ORDINAL_PATTERN.exec(heading)?.[1] ?? '') }))
      .filter(item => item.value !== null)
    ordinals.forEach((item, index) => {
      if (item.value !== index + 1) {
        findings.push(`${entry.note}.md: 章节序号不连续 —— 第 ${index + 1} 个带序号的二级章节是`
          + `「${item.heading}」（序号 ${item.value}）。搬运/插入章节后必须重排序号。`)
      }
    })

    const rounds = new Set()
    for (const heading of entry.allHeadings) for (const n of roundsInHeading(heading)) rounds.add(n)
    for (const reg of POST_TAG_SECTIONS.filter(item => item.note === entry.note)) {
      for (const n of reg.rounds ?? []) rounds.add(n)
    }
    for (const n of rounds) {
      const owners = roundOwners.get(n) ?? new Set()
      owners.add(entry.note)
      roundOwners.set(n, owners)
    }
  }

  for (const [key, owners] of headingOwners) {
    const unique = [...new Set(owners.map(item => item.note))]
    if (unique.length > 1) {
      const sample = owners.map(item => `${item.note}「${item.heading}」`).join(' 与 ')
      findings.push(`章节「${key}」同时出现在 ${unique.join(' 与 ')} 的发布说明里（${sample}）—— `
        + '搬运 ≠ 复制：同一段内容只能登记在它真正属于的那一版。'
        + '确属**通用标题**（每版都该有的那种，例如「升级须知」）就把它的 `key` '
        + '逐条登记进 LEGIT_REPEATED_SECTION_KEYS 并写明理由（登记后会做双向对账：'
        + '登记了却不重名 ⇒ 死条目也红）；**不要**把它塞进 FIXED_SECTION_KEYS（那是放宽判据）。')
    }
  }
  for (const round of [...roundOwners.keys()].sort((a, b) => a - b)) {
    const unique = [...roundOwners.get(round)]
    if (unique.length > 1) {
      findings.push(`第 ${round} 轮被 ${unique.join(' 与 ')} 两份发布说明同时登记 —— `
        + '同一轮的修复只在一个版本里首次交付；跨版分批时请在标题里写清是第几批。')
    }
  }
  return findings
}

/**
 * 跨版本重名的**真实观测集**：`sectionKey → 出现过的版本（去重、保序）`，只收"带序号或带审计轮次、
 * 且不在 `FIXED_SECTION_KEYS` 里"的二级标题（与 `crossNoteSectionFindings` 的判据①同口径）。
 *
 * 单独抽出来是为了让"登记表 ↔ 真实数据"的双向对账与真值表打印**读同一份观测**，
 * 两处各算一遍迟早会不一致。
 *
 * @param {{note: string, workSections: string[]}[]} notes - 各版本的章节面。
 * @returns {Map<string, string[]>} 观测到的重名标题 → 版本列表（只含 ≥1 版；`length > 1` = 真重名）。
 */
function observedSectionKeyOwners(notes) {
  const owners = new Map()
  for (const entry of notes) {
    if (typeof entry.note !== 'string' || entry.note.trim() === '') continue
    for (const heading of entry.workSections ?? []) {
      const key = sectionKey(heading)
      if (FIXED_SECTION_KEYS.has(key)) continue
      const versionSpecific = SECTION_ORDINAL_PATTERN.test(heading) || roundsInHeading(heading).length > 0
      if (!versionSpecific) continue
      const list = owners.get(key) ?? []
      if (!list.includes(entry.note)) list.push(entry.note)
      owners.set(key, list)
    }
  }
  return owners
}

/**
 * {@link LEGIT_REPEATED_SECTION_KEYS} 的**登记面**对账（双向，缺一不可）。
 *
 * 判据面（三条，全部 fail-loud；"真实重复却没登记"那一向由 {@link crossNoteSectionFindings}
 * 报"同一节出现在两版"给出，两处不重复报同一条）：
 *   ① **死条目**：登记了，但该标题在真实数据里出现 < 2 版（"任何两版里都对不上"）⇒ 红；
 *   ② 条目形状：缺 `key` / `key` 带序号前缀（必须是 {@link sectionKey} 之后的正文）/ `reason` 太短 ⇒ 红；
 *   ③ 登记表自身：同一 `key` 登记两次、或条数低于 {@link MIN_LEGIT_REPEATED_KEYS} ⇒ 红
 *      （条数下限是 ratchet：清空登记表会让判据①对这些标题整体失效，同时又不算"登记"）。
 *
 * **没有输入时不得静默通过**：`notes` 为空 ⇒ 红（"判不了"不是"没问题"）。
 *
 * @param {{note: string, workSections: string[]}[]} notes - 各版本的章节面。
 * @param {object[]} [registry] - 登记表（默认 {@link LEGIT_REPEATED_SECTION_KEYS}）。
 * @returns {string[]} 漂移描述。
 */
function legitRepeatedSectionFindings(notes, registry = LEGIT_REPEATED_SECTION_KEYS) {
  const findings = []
  if (notes.length === 0) {
    return ['跨版本合法重名判据没有输入（0 个版本）—— 判不了不等于"没问题"，拒绝当作通过。']
  }
  const observed = observedSectionKeyOwners(notes)
  if (registry.length < MIN_LEGIT_REPEATED_KEYS) {
    findings.push(`LEGIT_REPEATED_SECTION_KEYS 低于下限：${registry.length} 条 < `
      + `${MIN_LEGIT_REPEATED_KEYS} 条（登记表被清空/裁剪后，"通用标题重名"会重新变成硬红或`
      + '被塞进 FIXED_SECTION_KEYS 静默放宽；确属不再需要的条目要在同一次 diff 里显式降低下限并说明原因）')
  }
  const seen = new Set()
  for (const entry of registry) {
    const where = `LEGIT_REPEATED_SECTION_KEYS 登记项「${String(entry.key)}」`
    if (typeof entry.key !== 'string' || entry.key.trim() === '') {
      findings.push(`${where}：缺 key（必须是去序号后的标题正文）`)
      continue
    }
    if (sectionKey(entry.key) !== entry.key.trim()) {
      findings.push(`${where}：key 带了序号前缀（必须是 {@link sectionKey} 之后的标题正文，`
        + `例如「升级须知」而不是「## 二、升级须知」）`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 8) {
      findings.push(`${where}：缺 reason（要写清"这个标题在多个版本里重复为什么是正当的"）`)
    }
    if (seen.has(entry.key)) {
      findings.push(`${where}：同一个 key 登记了两次（重复条目 = 悄悄扩大登记面的空间）`)
    }
    seen.add(entry.key)
    const owners = observed.get(entry.key)
    if (owners === undefined || owners.length < 2) {
      findings.push(`${where}：**死条目** —— 该标题在真实数据里只出现在 `
        + `${owners === undefined ? '0 版（根本没有这个标题）' : `1 版（${owners[0]}）`}；`
        + '合法重名登记的前提是"它真的重名"，否则登记表会积累成"看起来在管、其实什么都没管"的装饰。'
        + '删掉这一条。')
    }
  }
  return findings
}

/**
 * 「tag 之后追加的章节」= 工作树里有、该 tag 的版本里没有的二级标题（按 {@link sectionKey} 比对）。
 *
 * @param {string[]} tagSections - tag 版本的二级标题。
 * @param {string[]} workSections - 工作树的二级标题。
 * @returns {string[]} 追加的标题（保持工作树顺序）。
 */
function lateSections(tagSections, workSections) {
  const known = new Set(tagSections.map(sectionKey))
  return workSections.filter(heading => !known.has(sectionKey(heading)))
}

/**
 * 反方向（2026-10-04 FF-3）：**tag 版里有、工作树里没有**的二级标题（按 {@link sectionKey} 比对）。
 *
 * `lateSections` 的镜像。两个方向合起来才是"章节归属"的完整判据：多出来的要登记为
 * "tag 之后追加"，少掉的要登记去向（见 {@link MOVED_TAG_SECTIONS}）。
 *
 * @param {string[]} tagSections - tag 版本的二级标题。
 * @param {string[]} workSections - 工作树的二级标题。
 * @returns {string[]} tag 版里有、工作树里没有的标题（保持 tag 版顺序）。
 */
function missingTagSections(tagSections, workSections) {
  const known = new Set(workSections.map(sectionKey))
  return tagSections.filter(heading => !known.has(sectionKey(heading)))
}

/**
 * 章节归属的全部判定（**纯函数**，git 侧以 `isAncestor` 注入，便于自检）。
 *
 * @param {object} input - 输入。
 * @param {string} input.note - tag。
 * @param {string[]} input.tagSections - tag 版本的二级标题。
 * @param {string[]} input.workSections - 工作树的二级标题。
 * @param {object[]} input.registry - 登记项（默认 {@link POST_TAG_SECTIONS}）。
 * @param {object[]} [input.movedRegistry] - 反向登记项（默认 {@link MOVED_TAG_SECTIONS}）。
 * @param {Map<string, Set<string>>|null} [input.sectionsByNote] - 各版本**工作树**的章节身份集合
 *   （`note` → `Set<sectionKey>`），用于"搬去哪一版"的双向对账；省略时该向只判存在性。
 * @param {(commit: string) => boolean|null} input.isAncestor - 提交是否在 tag 内（`null` = 判不了）。
 * @returns {string[]} 漂移描述。
 */
function sectionFindings(input) {
  const { note, tagSections, workSections, isAncestor } = input
  const registry = input.registry ?? POST_TAG_SECTIONS
  const movedRegistry = input.movedRegistry ?? MOVED_TAG_SECTIONS
  const sectionsByNote = input.sectionsByNote ?? null
  const findings = []
  const late = lateSections(tagSections, workSections)
  const lateSet = new Set(late.map(sectionKey))
  const registered = registry.filter(entry => entry.note === note)

  for (const heading of late) {
    const entry = registered.find(item => sectionKey(item.heading) === sectionKey(heading))
    if (entry === undefined) {
      findings.push(`${note}.md: 章节「${heading}」**不在 ${note} 的 tag 版本里** —— `
        + '它是在打 tag 之后追加的。要么把它搬到它真正属于的那一版，要么在 '
        + 'POST_TAG_SECTIONS 里逐条登记（登记项要给出 tag 内的落地提交）。')
      continue
    }
    const claimed = roundsInHeading(heading)
    for (const round of entry.rounds ?? []) {
      if (!claimed.includes(round)) {
        findings.push(`${note}.md: 登记项 ${heading} 声明了第 ${round} 轮，但标题里数不出这个轮次 —— `
          + `登记与标题必须一致（标题里数到的是 ${claimed.length === 0 ? '（无）' : claimed.join('、')}）。`)
      }
    }
  }

  for (const entry of registered) {
    if (!lateSet.has(sectionKey(entry.heading))) {
      findings.push(`${note}.md: POST_TAG_SECTIONS 的死条目 —— 「${entry.heading}」并不在 `
        + `${note} 的 tag 之后追加的章节里（它要么已在该 tag 里，要么已被搬走）。删掉这一条。`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 8) {
      findings.push(`${note}.md: 登记项「${entry.heading}」缺 reason（要写清为什么这一节写在 tag 之后）。`)
    }
    const commits = entry.landedBy ?? []
    if (!Array.isArray(commits) || commits.length === 0) {
      findings.push(`${note}.md: 登记项「${entry.heading}」缺 landedBy（该小节描述的改动由哪个提交落地）。`)
    }
    for (const commit of commits) {
      const verdict = isAncestor(commit)
      if (verdict === null) {
        findings.push(`${note}.md: 登记项「${entry.heading}」的 landedBy=${commit} 判不了 `
          + '（git 不可用或该 revision 不存在）—— 取不到输入时不得当作通过。')
      } else if (verdict === false) {
        findings.push(`${note}.md: 登记项「${entry.heading}」的 landedBy=${commit} **不在 ${note} 内** —— `
          + '这一节描述的改动并不属于这一版（这正是"发布说明归属错位"的形态）。')
      }
    }
  }

  // ── 反方向（2026-10-04 FF-3）：tag 版**有**、工作树**没有**的章节 ⇒ 逐条登记去向/删除 ──
  const gone = missingTagSections(tagSections, workSections)
  const movedEntries = movedRegistry.filter(entry => entry.note === note)
  for (const heading of gone) {
    const entry = movedEntries.find(item => sectionKey(item.heading) === sectionKey(heading))
    if (entry === undefined) {
      findings.push(`${note}.md: tag 版里的章节「${heading}」在**工作树里没有了** —— `
        + '`docs/releases/<tag>.md` 是 GitHub Release 正文的唯一来源，已发布 tag 的说明被删除/改写'
        + '会让"仓库文件 vs 客户看到的正文"永久分叉。处置：把它改回 tag 版的样子（只允许追加），'
        + `搬去别的版本就登记进 MOVED_TAG_SECTIONS（写成 movedTo: '<那一版的 tag>'），`
        + `确属删除就登记 movedTo: '${TAG_SECTION_REMOVED}' 并在 reason 里写明为什么删得掉。`)
      continue
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 8) {
      findings.push(`${note}.md: 反向登记项「${entry.heading}」缺 reason`
        + '（要写清这一节为什么不在工作树里了）。')
    }
    if (typeof entry.movedTo !== 'string' || entry.movedTo.trim() === '') {
      findings.push(`${note}.md: 反向登记项「${entry.heading}」缺 movedTo（去向：另一版 tag 或 `
        + `\`${TAG_SECTION_REMOVED}\`）—— 只写"搬走了"而不写去哪，等于把这一节丢进黑洞。`)
      continue
    }
    if (entry.movedTo === TAG_SECTION_REMOVED) continue
    if (sectionsByNote !== null) {
      const target = sectionsByNote.get(entry.movedTo)
      if (target === undefined) {
        findings.push(`${note}.md: 反向登记项「${entry.heading}」的去向 ${entry.movedTo} `
          + '不在本次对拍的版本里（必须在 RELEASE_CHAIN 上，否则"搬走"就成了判据面之外的动作）。')
      } else if (!target.has(sectionKey(heading))) {
        findings.push(`${note}.md: 反向登记项「${entry.heading}」的去向对不上 —— `
          + `${entry.movedTo} 的工作树里没有这一节（按去序号后的标题身份比对）⇒ 死条目或去向写错。`)
      }
    }
  }
  for (const entry of movedEntries) {
    if (!gone.some(heading => sectionKey(heading) === sectionKey(entry.heading))) {
      findings.push(`${note}.md: MOVED_TAG_SECTIONS 的死条目 —— 「${entry.heading}」在 ${note} 里`
        + '并不满足"tag 版有、工作树没有"（它要么还在工作树里，要么 tag 版里本来就没有它）。'
        + '删掉这一条。')
    }
  }

  return findings
}

/** 脚本自身所在的仓库根（`import.meta.url` 相对推导，与 cwd 无关）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const selfTest = argv.includes('--self-test')
const unknown = argv.filter(argument => argument !== '--json' && argument !== '--self-test')

/** 前置失败（退出码 2）：不是"没漂移"，而是"这件事没判成"。 */
function precondition(message) {
  console.error(`check-release-notes-migrations: 前置失败 —— ${message}`)
  console.error('  （前置失败**不是**通过：取不到输入时不得宣称"声明与实际一致"。）')
  process.exit(2)
}

function git(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * 读某个 tag 里的文件内容（`git show <tag>:<path>`）。取不到返回 `null` ——
 * **调用方必须 fail-loud**（把 `null` 当成"文件是空的"会让章节归属判据静默全绿）。
 * @param {string} tag - tag 名。
 * @param {string} path - 仓库相对 POSIX 路径。
 * @returns {string|null} 文件内容（UTF-8）；取不到时 `null`。
 */
function gitShowFile(tag, path) {
  const result = git(['show', `${tag}:${path}`])
  return result.status === 0 ? result.stdout : null
}

/**
 * 某个 revision 是否是 `tag` 的祖先（`git merge-base --is-ancestor`）。
 * 三态：`true` / `false` / `null`（**判不了** —— revision 不存在、git 不可用、tag 取不到）。
 * 调用方必须把 `null` 当作"不得通过"，而不是"不是 false 就当 true"。
 * @param {string} tag - tag 名。
 * @param {string} commit - 待判定的 revision。
 * @returns {boolean|null} 判定结果。
 */
function isAncestorOf(tag, commit) {
  if (typeof commit !== 'string' || commit.trim() === '') return null
  const verify = git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
  if (verify.status !== 0) return null
  const result = git(['merge-base', '--is-ancestor', commit, tag])
  if (result.status === 0) return true
  if (result.status === 1) return false
  return null
}

/**
 * 解析一份发布说明里的声明集合。
 * @param {string} text - 发布说明正文。
 * @param {string} label - 用于报错的标签（一般传文件名）。
 * @returns {string[]} 声明引入的迁移文件名（升序、去重后）。
 */
function declaredMigrations(text, label) {
  const lines = text.split('\n')
  const markerLines = lines.filter(line => line.includes(ANCHOR_MARKER))
  if (markerLines.length === 0) {
    precondition(`${label} 里找不到机器可读锚点（${ANCHOR_MARKER}…），无法对拍 —— `
      + '补一行 `- **迁移清单（机器可读锚点…）**：…`（无迁移写「无」）')
  }
  if (markerLines.length > 1) {
    precondition(`${label} 里有 ${markerLines.length} 行机器可读锚点（只能有一行）`)
  }
  const match = ANCHOR_PATTERN.exec(markerLines[0].trim())
  if (match === null) {
    precondition(`${label} 的锚点行形态不合法：${markerLines[0].trim().slice(0, 120)}`)
  }
  const body = match[1]
  const names = [...body.matchAll(SQL_NAME_PATTERN)].map(item => item[1])
  if (names.length === 0 && !/无/u.test(body)) {
    precondition(`${label} 的锚点行既没有 \`NNNN_*.sql\` 也没有「无」：${body.slice(0, 120)}`)
  }
  if (names.length > 0 && /无/u.test(body)) {
    precondition(`${label} 的锚点行同时写了文件名与「无」：${body.slice(0, 120)}`)
  }
  return [...new Set(names)].sort()
}

/**
 * `git diff --name-status` 输出 → 「本区间引入的迁移」与「就地改写/删除」。
 *
 * **判据面 = `A` / `R` / `C` 的目标名**：
 *   · `A`（新增）：最普通的一类；
 *   · `R###`（重命名）：`git mv 0083_x.sql 0084_y.sql` 之后启动时会**多执行版本 84**
 *     （`loadMigrations` 按文件名前 4 位定版本号）⇒ 与 `A` 同等；
 *   · `C###`（复制）：新名字同样是一个新文件/新版本号 ⇒ 与 `A` 同等。
 * `M`（就地改写）/`D`（删除）/`T`（类型变化）**不改变"本版引入了哪几条迁移"**，只如实打印。
 *
 * @param {string} stdout - `git diff --name-status` 的输出。
 * @returns {{added: string[], touched: string[]}} 两个集合都按文件名升序。
 */
function classifyNameStatus(stdout) {
  const added = []
  const touched = []
  for (const line of String(stdout).split('\n')) {
    if (line.trim() === '') continue
    const [status, ...rest] = line.split('\t')
    // `R`/`C` 是三段（status + 源 + 目标）：取最后一个字段 = **目标名**（新文件）。
    const path = rest[rest.length - 1] ?? ''
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name === '') continue
    if (status.startsWith('A') || status.startsWith('R') || status.startsWith('C')) added.push(name)
    else touched.push(`${status} ${name}`)
  }
  return { added: added.sort(), touched: touched.sort() }
}

/**
 * 现场算出「上一 tag → 本 tag」之间引入的迁移文件。
 * @param {string} fromTag - 上一 tag。
 * @param {string} toTag - 本 tag。
 * @returns {{added: string[], touched: string[]}} added = 新增/重命名/复制（判据面）；
 *   touched = 改动/删除（只如实打印）。
 */
function actualMigrations(fromTag, toTag) {
  for (const tag of [fromTag, toTag]) {
    const exists = git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`])
    if (exists.status !== 0) {
      precondition(`取不到 tag ${tag}（本地没有这个引用）—— 本判据需要区间两端的 tag。`
        + '修法：在完整克隆上跑，或先 `git fetch --tags`。'
        + '（若你刚在发布 PR 里追加了链尾，这一条是**正常**的：那个 tag 要到发版提交之后才存在，'
        + '所以本判据只在 tag 期真跑 —— 见文件头"它在哪儿跑"。）')
    }
  }
  // `-M -C`：显式打开重命名/复制检测，**不依赖运行者的 `diff.renames` 配置**（默认配置下
  // 纯复制会报成 `A`，而 `diff.renames=copies` 时报成 `C100` ⇒ 同一区间两种 status，
  // 判据的取值域不能跟着配置漂）。
  const diff = git(['diff', '-M', '-C', '--name-status', `${fromTag}..${toTag}`, '--', MIGRATIONS_DIR])
  if (diff.status !== 0) {
    precondition(`git diff ${fromTag}..${toTag} 失败：${diff.stderr.trim() || `exit ${diff.status}`}`)
  }
  return classifyNameStatus(diff.stdout)
}

/**
 * 中文数词/阿拉伯数字 → 整数；解析不出返回 `null`（调用方**不判**，避免用猜出来的条数判红）。
 * @param {string} raw - 捕获到的数词。
 * @returns {number|null} 条数。
 */
function claimCount(raw) {
  if (/^\d+$/u.test(raw)) return Number(raw)
  if (raw.length === 1) return CN_NUMERALS[raw] ?? null
  const match = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(raw)
  if (match !== null) {
    const tens = match[1] === undefined ? 1 : (CN_NUMERALS[match[1]] ?? 0)
    const ones = match[2] === undefined ? 0 : (CN_NUMERALS[match[2]] ?? 0)
    return tens * 10 + ones
  }
  return null
}

/**
 * ③ 正文散文与锚点的一致性（三条互不重叠的形态判据）。
 *
 * 为什么要有这一条：只钉锚点时，**E-02 的原始形态**（锚点两条、正文写"只有一条"）判绿。
 * 判据清单与各自的理由：
 *   · **否定式**（`本版…无/没有…迁移`）：一旦锚点声明了迁移就自相矛盾 —— E-01 的
 *     `v2.8.2-beta.2.md:145` 原话；
 *   · **计数式**（`本版…<N> 条…迁移`）：条数必须等于锚点条数 —— E-02 的原话是
 *     「本版只有一条**只加列**的迁移」，它连迁移文件名都没写，只有数词能咬住；
 *   · **回滚式**（`回滚只需换回镜像`）：锚点声明了迁移时不得成立 —— E-01 的
 *     `v2.8.2-beta.2.md:210` 原话（真值：引入 `0082` 的版本回滚不是"只换镜像"）。
 * 三条都**只在能判定时**判：计数式解析不出数词就不判；否定式/回滚式在锚点为「无」时
 * 本来就是对的，不判。
 *
 * @param {string} text - 发布说明正文。
 * @param {string[]} declared - 锚点声明的迁移文件名。
 * @param {string} label - 报错标签（文件名）。
 * @returns {string[]} 漂移描述（空数组 = 一致）。
 */
function proseFindings(text, declared, label) {
  const findings = []
  const lines = text.split('\n')

  if (declared.length > 0) {
    const denial = lines.find(line => NO_MIGRATION_CLAIM.test(line))
    if (denial !== undefined) {
      findings.push(`${label}: 正文与锚点矛盾 —— 锚点声明了 ${declared.length} 条迁移，`
        + `正文却写「无迁移」：${denial.trim().slice(0, 120)}`)
    }
  }

  for (const line of lines) {
    const match = COUNT_CLAIM.exec(line)
    if (match === null) continue
    const count = claimCount(match[1])
    if (count === null || count === declared.length) continue
    findings.push(`${label}: 正文与锚点矛盾 —— 正文写「${match[0].trim()}」`
      + `（= ${count} 条），锚点声明了 ${declared.length} 条：${line.trim().slice(0, 120)}`)
  }

  if (declared.length > 0) {
    const rollback = lines.find(line => ROLLBACK_ONLY_CLAIM.test(line))
    if (rollback !== undefined) {
      findings.push(`${label}: 正文与锚点矛盾 —— 锚点声明了 ${declared.length} 条迁移，`
        + `正文却写「回滚只需换回镜像」：${rollback.trim().slice(0, 120)}`)
    }
  }

  return findings
}

/**
 * `--self-test`：对**纯函数**（分类器 + 三条正文判据）跑固定样本。任何一个样本不符即 exit 1。
 *
 * 为什么做成脚本自带而不是一个 spec：本判据不在 `yarn check` 里（理由见文件头），所以它的
 * 回归面必须是**它自己执行路径上的第一步** —— CI 那一步先跑 `--self-test` 再跑真判，
 * 自检失败即整步红（拆掉 `-M -C` 或拆掉某条正文判据都会在这里当场红）。
 * @returns {number} 进程退出码。
 */
/**
 * `--self-test` 的**样本数下限**（ratchet，只许提高）。
 *
 * 为什么要有它：回归网自身没有下限时，"把样本表掏空"是最省事的假绿 —— 掏空后仍然打印
 * `自检通过（N 条样本）`（N 变小但没人对账）。本仓同类守卫（`check-workflows.mjs` 的
 * `SELFTEST_MIN_SAMPLES`、`verify-check-workspaces.mjs` 的断言下限）都是这个形态。
 * 补样本时把它一起 +N。
 */
const MIN_SELF_TEST_SAMPLES = 60

function runSelfTest() {
  const results = []
  /**
   * @param {string} label - 样本名。
   * @param {unknown} actual - 实际值。
   * @param {unknown} wanted - 期望值。
   */
  function expect(label, actual, wanted) {
    const ok = JSON.stringify(actual) === JSON.stringify(wanted)
    results.push({ label, ok, actual, wanted })
  }

  const dir = `${MIGRATIONS_DIR}/`
  // ① 分类器：A / R / C 进判据面，M / D 只打印。
  expect('A → 引入',
    classifyNameStatus(`A\t${dir}0083_a.sql\n`).added, ['0083_a.sql'])
  expect('R100 → 引入（重命名后的新名字）',
    classifyNameStatus(`R100\t${dir}0083_a.sql\t${dir}0084_b.sql\n`).added, ['0084_b.sql'])
  expect('R087 → 引入（相似度不影响判定）',
    classifyNameStatus(`R087\t${dir}0083_a.sql\t${dir}0084_b.sql\n`).added, ['0084_b.sql'])
  expect('C100 → 引入（复制出的新名字）',
    classifyNameStatus(`C100\t${dir}0084_b.sql\t${dir}0085_c.sql\n`).added, ['0085_c.sql'])
  expect('M → 只打印',
    classifyNameStatus(`M\t${dir}0039_d.sql\n`), { added: [], touched: ['M 0039_d.sql'] })
  expect('D → 只打印',
    classifyNameStatus(`D\t${dir}0086_e.sql\n`), { added: [], touched: ['D 0086_e.sql'] })
  expect('混合：A + R + C + M 全在',
    classifyNameStatus([
      `M\t${dir}0039_d.sql`,
      `A\t${dir}0083_a.sql`,
      `R100\t${dir}0087_f.sql\t${dir}0088_g.sql`,
      `C100\t${dir}0088_g.sql\t${dir}0089_h.sql`,
    ].join('\n') + '\n').added, ['0083_a.sql', '0088_g.sql', '0089_h.sql'])

  // ③ 正文判据：三条形态各一个真阳性 + 一个真阴性（阴性的样本取自本仓已发布的说明）。
  const okTwo = [
    '- **迁移清单（机器可读锚点，供 `scripts/check-release-notes-migrations.mjs` 与 `git diff` 对拍）**：`0080_a.sql`、`0081_b.sql`',
    '- **数据库**：本版有**两条只加列**的迁移 —— `0080_a.sql` 与 `0081_b.sql`；回滚按 `docs/deploy/AI-DEPLOY.md` §7 的四步顺序。',
  ].join('\n')
  expect('正文：两条 == 锚点两条（阴性）', proseFindings(okTwo, ['0080_a.sql', '0081_b.sql'], 'x.md'), [])

  const e02 = okTwo.replace('本版有**两条只加列**的迁移', '本版只有一条**只加列**的迁移（`gateway_files` 的世代号字段）')
  expect('正文：E-02 原始形态（计数式，阳性）',
    proseFindings(e02, ['0080_a.sql', '0081_b.sql'], 'x.md').length, 1)

  const e01 = okTwo.replace('回滚按 `docs/deploy/AI-DEPLOY.md` §7 的四步顺序。',
    '∴ 回滚只需要换回上一版镜像。')
  expect('正文：E-01 原始形态（回滚式，阳性）',
    proseFindings(e01, ['0080_a.sql', '0081_b.sql'], 'x.md').length, 1)

  const e01Denial = okTwo.replace('本版有**两条只加列**的迁移 —— `0080_a.sql` 与 `0081_b.sql`；',
    '本版没有数据库迁移；')
  expect('正文：否定式（阳性）',
    proseFindings(e01Denial, ['0080_a.sql', '0081_b.sql'], 'x.md').length, 1)

  const noMigrations = [
    '- **迁移清单（机器可读锚点，供 `scripts/check-release-notes-migrations.mjs` 与 `git diff` 对拍）**：无',
    '> 本版**没有任何数据库迁移**，回滚仍然是"换回上一版镜像 tag"。',
    '- **回滚**：本版**没有任何数据库迁移**，也**不含数据改写** ⇒ 回滚只需换回上一版镜像。',
  ].join('\n')
  expect('正文：锚点为「无」时说"无迁移/只需换镜像"是对的（阴性）',
    proseFindings(noMigrations, [], 'x.md'), [])

  const unrelated = [
    '- **迁移清单（机器可读锚点，供 `scripts/check-release-notes-migrations.mjs` 与 `git diff` 对拍）**：`0082_c.sql`',
    '- **回滚（本版多一步，两步都要做）**：本版引入了迁移 `0082_c.sql`，所以回滚是：',
    '  ① 删登记行；② 换回旧镜像。',
    '- **迁移文件形状自检**：此前重复版本号会在第二次启动时静默跳过其中一条迁移。',
  ].join('\n')
  expect('正文：与条数无关的句子不得被误判（阴性）',
    proseFindings(unrelated, ['0082_c.sql'], 'x.md'), [])

  // ② 数词解析（解析不出必须返回 null —— 那是"不判"，不是"判 0"）。
  expect('数词：一条 → 1', claimCount('一'), 1)
  expect('数词：两条 → 2', claimCount('两'), 2)
  expect('数词：十二条 → 12', claimCount('十二'), 12)
  expect('数词：3 → 3', claimCount('3'), 3)
  expect('数词：解析不出 → null', claimCount('若干'), null)

  // ⑤ 轮次解析（章节归属判据的输入面；F8 的六个小节标题都要能被数出来）。
  expect('轮次：第七轮与第八轮 → [7,8]',
    roundsInHeading('## 四、第七轮与第八轮审计修复（同版本内继续收口）'), [7, 8])
  expect('轮次：第十至二十七轮 → 10..27',
    roundsInHeading('## 六、第十至二十七轮审计的行为变更登记（升级与运维视角）'), rangeRounds(10, 27))
  expect('轮次：第二十八至三十三轮 → 28..33',
    roundsInHeading('## 二、第二十八至三十三轮审计修复（用户可见的部分）'), rangeRounds(28, 33))
  expect('轮次：标题里没有轮次 → 空',
    roundsInHeading('## 一、这一版修了什么（按"用户会怎么碰到"排序）'), [])

  // ⑤ 章节归属：**样本就是 F8 修掉的那六个小节**（它们错写在 v2.8.2-beta.1.md 里，
  //    而 v2.8.2-beta.1 的 tag 里没有它们描述的第十至二十七轮改动）。
  const f8TagSections = ['## 一、这一版修了什么（按"用户会怎么碰到"排序）', '## 五、本版验证与仍未验证的边界']
  const f8Moved = [
    '## 八、第十轮的行为变更登记（客户端 · 与 §七 同口径）',
    '## 九、第十一轮的行为变更登记（服务端读数 · 客户端 · 门禁）',
    '## 十、第十二至十八轮的行为变更登记（服务端 · 客户端 · 门禁）',
    '## 十一、第二十轮的行为变更登记（客户端 · 服务端 · 运维）',
    '## 十二、第二十一至二十五轮审计批次的行为变更登记（客户端 · 服务端 · 运维 · 门禁）',
    '## 十三、第二十六至二十七轮审计批次的行为变更登记（客户端 · 服务端 · 运维 · 门禁）',
  ]
  expect('章节归属：F8 原始形态（六个 tag 后章节、一条登记都没有）逐节必红',
    sectionFindings({
      note: 'v2.8.2-beta.1',
      tagSections: f8TagSections,
      workSections: [...f8TagSections, ...f8Moved],
      registry: [],
      isAncestor: () => true,
    }).length, f8Moved.length)

  const f8Entry = {
    note: 'v2.8.2-beta.1',
    heading: f8Moved[0],
    rounds: [10],
    landedBy: ['deadbeef'],
    reason: '样本：这一节写在 tag 之后，但描述的改动在 tag 内',
  }
  expect('章节归属：登记在案 + landedBy 在该 tag 内 ⇒ 阴性（F8 修好之后的形态）',
    sectionFindings({
      note: 'v2.8.2-beta.1',
      tagSections: f8TagSections,
      workSections: [...f8TagSections, f8Moved[0]],
      registry: [f8Entry],
      isAncestor: () => true,
    }), [])
  expect('章节归属：登记在案但 landedBy **不在**该 tag 内 ⇒ 阳性（把第十轮写进 beta.1 的真形态）',
    sectionFindings({
      note: 'v2.8.2-beta.1',
      tagSections: f8TagSections,
      workSections: [...f8TagSections, f8Moved[0]],
      registry: [f8Entry],
      isAncestor: () => false,
    }).length, 1)
  expect('章节归属：landedBy 判不了（git 不可用 / revision 不存在）不得当作通过',
    sectionFindings({
      note: 'v2.8.2-beta.1',
      tagSections: f8TagSections,
      workSections: [...f8TagSections, f8Moved[0]],
      registry: [f8Entry],
      isAncestor: () => null,
    }).length, 1)
  expect('章节归属：登记项声明的轮次与标题数出来的不一致 ⇒ 阳性',
    sectionFindings({
      note: 'v2.8.2-beta.1',
      tagSections: f8TagSections,
      workSections: [...f8TagSections, f8Moved[0]],
      registry: [{ ...f8Entry, rounds: [11] }],
      isAncestor: () => true,
    }).length, 1)
  expect('章节归属：死条目（登记了，但这一节并不在 tag 之后追加的章节里）⇒ 阳性',
    sectionFindings({
      note: 'v2.8.2-beta.1',
      tagSections: f8TagSections,
      workSections: f8TagSections,
      registry: [f8Entry],
      isAncestor: () => true,
    }).length, 1)
  expect('章节归属：整节被顺延改号（§六→§七）不算"tag 后追加" ⇒ 阴性（序号是版面，正文才是身份）',
    lateSections(['## 六、附件与校验'], ['## 七、附件与校验']), [])
  expect('章节归属：正文对不上、只把号改掉 ⇒ 仍算"tag 后追加"（阳性）',
    lateSections(['## 一、甲'], ['## 二、乙']).length, 1)
  // 2026-10-04 FF-3：同一条合成输入现在**两个方向各出一条** ——
  // ① 正向：工作树多出来的「乙」没登记；② 反向：tag 版的「甲」在工作树里没了。
  expect('章节归属：正文对不上、只把号改掉 + 无登记 ⇒ 必红（两个方向各一条：多出的「乙」+ 丢掉的「甲」）',
    sectionFindings({
      note: 'v2.8.2-beta.1',
      tagSections: ['## 一、甲'],
      workSections: ['## 二、乙'],
      registry: [],
      isAncestor: () => true,
    }).length, 2)

  // ── 反向（FF-3）：`tag 版有、工作树没有` 的章节必须逐条登记去向/删除，登记不实也要红 ──
  const goneTagSections = ['## 一、甲', '## 二、乙']
  const goneWorkSections = ['## 一、甲'] // 「## 二、乙」在工作树里被删掉了
  const goneBase = {
    note: 'v2.8.2-beta.1',
    tagSections: goneTagSections,
    workSections: goneWorkSections,
    registry: [],
    isAncestor: () => true,
  }
  expect('章节归属（反向 FF-3）：tag 版有一节、工作树里没了、且未登记 ⇒ 必红（修前这一形态 EXIT=0）',
    sectionFindings(goneBase).length, 1)
  expect('章节归属（反向 FF-3）：同一节在工作树里仍在 ⇒ 阴性（不得把"没丢"判成丢）',
    sectionFindings({ ...goneBase, workSections: goneTagSections }).length, 0)
  expect('章节归属（反向 FF-3）：整节顺延改号（§二→§三）不算丢 ⇒ 阴性（序号是版面、正文才是身份）',
    sectionFindings({ ...goneBase, workSections: ['## 一、甲', '## 三、乙'] }).length, 0)
  expect('反向：登记为删除（movedTo=<removed>）+ 写明理由 ⇒ 阴性',
    sectionFindings({
      ...goneBase,
      movedRegistry: [{
        note: 'v2.8.2-beta.1',
        heading: '## 二、乙',
        movedTo: TAG_SECTION_REMOVED,
        reason: '样本：该节内容已并入上一节，删除是有意的',
      }],
    }), [])
  expect('反向：登记搬去另一版、且那一版的工作树里真有这一节 ⇒ 阴性（双向对账对上了）',
    sectionFindings({
      ...goneBase,
      movedRegistry: [{
        note: 'v2.8.2-beta.1',
        heading: '## 二、乙',
        movedTo: 'v2.8.2-beta.2',
        reason: '样本：按轮次归属搬回它真正属于的那一版',
      }],
      sectionsByNote: new Map([['v2.8.2-beta.2', new Set(['乙'])]]),
    }), [])
  expect('反向：登记搬去另一版，但那一版的工作树里**没有**这一节 ⇒ 必红（去向对不上）',
    sectionFindings({
      ...goneBase,
      movedRegistry: [{
        note: 'v2.8.2-beta.1',
        heading: '## 二、乙',
        movedTo: 'v2.8.2-beta.2',
        reason: '样本：去向写错了',
      }],
      sectionsByNote: new Map([['v2.8.2-beta.2', new Set(['丙'])]]),
    }).length, 1)
  expect('反向：去向不在本次对拍的版本里（不在 RELEASE_CHAIN）⇒ 必红',
    sectionFindings({
      ...goneBase,
      movedRegistry: [{
        note: 'v2.8.2-beta.1',
        heading: '## 二、乙',
        movedTo: 'v9.9.9',
        reason: '样本：去向指到链外',
      }],
      sectionsByNote: new Map([['v2.8.2-beta.2', new Set(['乙'])]]),
    }).length, 1)
  expect('反向：缺 movedTo ⇒ 必红（只写"搬走了"不写去哪）',
    sectionFindings({
      ...goneBase,
      movedRegistry: [{ note: 'v2.8.2-beta.1', heading: '## 二、乙', reason: '样本：没有去向字段' }],
    }).length, 1)
  expect('反向：缺 reason ⇒ 必红（搬走项必须逐条写理由）',
    sectionFindings({
      ...goneBase,
      movedRegistry: [{
        note: 'v2.8.2-beta.1', heading: '## 二、乙', movedTo: TAG_SECTION_REMOVED, reason: '短',
      }],
    }).length, 1)
  expect('反向：死条目（登记了"被搬走"，但这一节在工作树里其实还在）⇒ 必红',
    sectionFindings({
      ...goneBase,
      workSections: goneTagSections,
      movedRegistry: [{
        note: 'v2.8.2-beta.1',
        heading: '## 二、乙',
        movedTo: TAG_SECTION_REMOVED,
        reason: '样本：凭空预置的搬走登记',
      }],
    }).length, 1)
  expect('反向：登记项的 note 是别的版本 ⇒ 与本版无关，不得被算进本版（死条目按 note 过滤）',
    sectionFindings({
      ...goneBase,
      movedRegistry: [{
        note: 'v2.8.2-beta.2',
        heading: '## 二、乙',
        movedTo: TAG_SECTION_REMOVED,
        reason: '样本：别的版本的登记项',
      }],
    }).length, 1)

  // ⑤ 跨版本结构：重复 / 序号 / 轮次归属。
  const dupNotes = [
    { note: 'v2.8.2-beta.1', workSections: ['## 一、甲', '## 二、第九轮审计修复'], allHeadings: ['## 二、第九轮审计修复'] },
    { note: 'v2.8.2-beta.2', workSections: ['## 一、乙', '## 二、第九轮审计修复'], allHeadings: ['## 二、第九轮审计修复'] },
  ]
  expect('章节结构：同一节出现在两版 ⇒ 阳性（搬运 ≠ 复制）',
    crossNoteSectionFindings(dupNotes).filter(item => item.includes('同时出现在')).length, 1)
  expect('章节结构：同一轮被两版登记 ⇒ 阳性',
    crossNoteSectionFindings(dupNotes).filter(item => item.includes('同时登记')).length, 1)
  expect('章节结构：模板固定小节在每版重复出现 ⇒ 阴性（不得假红）',
    crossNoteSectionFindings([
      { note: 'v2.8.2-beta.4', workSections: ['## 已知限制（本版认账，未修）', '## 升级与回滚', '## 附件与校验'], allHeadings: [] },
      { note: 'v2.8.2-beta.5', workSections: ['## 已知限制（本版认账，未修）', '## 升级与回滚', '## 附件与校验'], allHeadings: [] },
    ]), [])
  expect('章节结构：固定小节两版都编上号也不撞车 ⇒ 阴性',
    crossNoteSectionFindings([
      { note: 'v2.8.2-beta.3', workSections: ['## 一、甲', '## 二、乙', '## 三、丙', '## 四、已知限制（本版认账，未修）'], allHeadings: [] },
      { note: 'v2.8.2-beta.6', workSections: ['## 一、丁', '## 二、戊', '## 三、己', '## 四、庚', '## 五、已知限制（本版认账，未修）'], allHeadings: [] },
    ]), [])
  expect('章节结构：序号连续 ⇒ 阴性',
    crossNoteSectionFindings([
      { note: 'x', workSections: ['## 一、甲', '## 二、乙', '## 附件与校验'], allHeadings: [] },
    ]), [])
  expect('章节结构：序号跳号 ⇒ 阳性（搬运后忘了重排）',
    crossNoteSectionFindings([
      { note: 'x', workSections: ['## 一、甲', '## 三、丙'], allHeadings: [] },
    ]).length, 1)

  // ⑤-b 接线（2026-10-04 主控裁决）：`note` 是这一族的版本名唯一来源，缺它必须 fail-loud
  //      —— 旧实现的形态正是"driver 压 tag、判据读 note"⇒ 三条判据在生产里静默退化。
  expect('章节结构接线：行里缺 note ⇒ fail-loud（不得静默跳过、不得报 undefined.md）',
    crossNoteSectionFindings([{ workSections: ['## 一、甲'], allHeadings: [] }])
      .filter(item => item.includes('缺 note')).length, 1)

  // ⑤-c 跨版本**合法重名**的登记表（LEGIT_REPEATED_SECTION_KEYS）：正反两侧的样本。
  const genericA = '升级须知'
  const genericB = '验证与门禁'
  const specific = '第十二轮审计修复'
  /** 两版各有一节**非通用**标题重名（正文不同）⇒ 必须红。 */
  const twoNotesSpecific = [
    { note: 'v9.9.9-beta.1', workSections: [`## 一、${specific}`], allHeadings: [] },
    { note: 'v9.9.9-beta.2', workSections: [`## 一、${specific}`], allHeadings: [] },
  ]
  /** 两版共享两个**通用**标题 + 各自另有一节独有标题（贴近真实仓：beta.1/beta.2 的形态）。 */
  const twoNotesGenerics = [
    {
      note: 'v9.9.9-beta.1',
      workSections: [`## 一、${genericA}`, `## 二、${genericB}`, '## 三、第一版独有'],
      allHeadings: [],
    },
    {
      note: 'v9.9.9-beta.2',
      workSections: [`## 一、${genericA}`, `## 二、${genericB}`, '## 三、第二版独有'],
      allHeadings: [],
    },
  ]
  const genericsRegistered = [
    { key: genericA, reason: '样本：通用标题，每一版都该有' },
    { key: genericB, reason: '样本：通用标题，每一版都该有' },
  ]
  expect('跨版本重复：**非通用**标题在两版重复 + 未登记 ⇒ 红（判据真的会触发）',
    crossNoteSectionFindings(twoNotesSpecific).length, 1)
  expect('跨版本重复：同一标题在**同一版里**出现两次不算跨版本重复 ⇒ 阴性（不得假红）',
    crossNoteSectionFindings([
      { note: 'x', workSections: ['## 一、甲', '## 二、甲'], allHeadings: [] },
    ]), [])
  expect('跨版本重复：通用标题重复 + **已登记** ⇒ 阴性（走登记表，不塞 FIXED_SECTION_KEYS）',
    crossNoteSectionFindings(twoNotesGenerics, { registry: genericsRegistered }), [])
  expect('跨版本重复：未登记的重复不得被登记表里**别的条目**顺带放过 ⇒ 红',
    crossNoteSectionFindings(twoNotesGenerics, {
      registry: [genericsRegistered[0], { key: '毫不相干的标题', reason: '样本：只登记了通用甲，通用乙仍未登记' }],
    }).filter(item => item.includes('同时出现在')).length, 1)

  // 登记面双向对账（legitRepeatedSectionFindings）。
  expect('合法重名登记面：真实重名 + 登记项齐备 ⇒ 阴性（正控，不得把登记过的判红）',
    legitRepeatedSectionFindings(twoNotesGenerics, genericsRegistered), [])
  expect('合法重名登记面：**死条目**（登记了却在任何两版里都对不上）⇒ 红',
    legitRepeatedSectionFindings(twoNotesGenerics, [
      genericsRegistered[0],
      { key: '从没重名过的标题', reason: '样本：凭空登记的合法重名' },
    ]).filter(item => item.includes('死条目')).length, 1)
  expect('合法重名登记面：缺 reason ⇒ 红',
    legitRepeatedSectionFindings(twoNotesGenerics, [
      { key: genericA, reason: '短' },
      genericsRegistered[1],
    ]).filter(item => item.includes('缺 reason')).length, 1)
  expect('合法重名登记面：key 带序号前缀 ⇒ 红（必须是去序号后的标题正文）',
    legitRepeatedSectionFindings(twoNotesGenerics, [
      { key: `## 二、${genericA}`, reason: '样本：key 写成了整行标题' },
      genericsRegistered[1],
    ]).filter(item => item.includes('序号前缀')).length, 1)
  expect('合法重名登记面：同一个 key 登记两次 ⇒ 红',
    legitRepeatedSectionFindings(twoNotesGenerics, [
      genericsRegistered[0],
      { key: genericA, reason: '样本：第二次登记同一个 key' },
    ]).filter(item => item.includes('登记了两次')).length, 1)
  expect('合法重名登记面：低于下限（登记表被清空/裁剪）⇒ 红（ratchet）',
    legitRepeatedSectionFindings(twoNotesGenerics, [genericsRegistered[0]])
      .filter(item => item.includes('低于下限')).length, 1)
  expect('合法重名登记面：**没有输入（0 个版本）⇒ 红**（判不了不等于没问题，不得静默通过）',
    legitRepeatedSectionFindings([], []).length, 1)

  // 样本数下限（ratchet）：放在最后一条，掏空样本表会在这里红。
  expect(`自检样本数不低于下限（${MIN_SELF_TEST_SAMPLES}）`, results.length >= MIN_SELF_TEST_SAMPLES, true)

  const failed = results.filter(item => !item.ok)
  for (const item of results) {
    console.log(`  ${item.ok ? '✅' : '❌'} ${item.label}`
      + (item.ok ? '' : `（实际 ${JSON.stringify(item.actual)}，期望 ${JSON.stringify(item.wanted)}）`))
  }
  if (failed.length > 0) {
    console.error(`check-release-notes-migrations: 自检 ${failed.length}/${results.length} 条不符 —— `
      + '判据本体（分类器 / 正文判据 / 章节归属判据）被改坏了。')
    return 1
  }
  console.log(`check-release-notes-migrations: 自检通过（${results.length} 条样本）✅`)
  return 0
}

if (unknown.length > 0) {
  precondition(`未知参数 ${unknown.join(' ')}（只接受 --json / --self-test）`)
}

// `--self-test` 只碰纯函数，不碰 git（可以在任何目录、任何克隆形态下跑）。
if (selfTest) {
  process.exit(runSelfTest())
}

/**
 * CI 语境的 tag 判据：**只看 `GITHUB_REF` 的形态**（`refs/tags/<tag>`），不看名字长得像不像 tag。
 *
 * 只给 `GITHUB_REF_NAME` 的场合本脚本**不**据此放宽（缺 `GITHUB_REF` 时按本地模式跑，
 * fail-closed）—— 本仓有过"只认 `GITHUB_REF_NAME` ⇒ 静默退化成非 tag"的教训。
 */
const ciRef = process.env.GITHUB_REF ?? ''
const hasCiRef = ciRef.length > 0
const ciTag = ciRef.startsWith(TAG_REF_PREFIX) ? ciRef.slice(TAG_REF_PREFIX.length) : null

if (hasCiRef && ciTag === null) {
  console.log(`check-release-notes-migrations: 跳过 —— GITHUB_REF=${ciRef} 不是 ${TAG_REF_PREFIX}*，`
    + '本判据对拍的是**发布 tag 的区间**，分支/PR 上没有可判对象。')
  console.log('  （这不是"通过"：它只说明本次没有对象可判；tag 上会真判，见文件头"它在哪儿跑"。）')
  process.exit(0)
}

if (ciTag !== null) {
  const ciRefName = process.env.GITHUB_REF_NAME ?? ''
  if (ciRefName.length > 0 && ciRefName !== ciTag) {
    precondition(`GITHUB_REF=${ciRef} 与 GITHUB_REF_NAME=${ciRefName} 不一致 —— `
      + '本判据以 `GITHUB_REF` 的形态为唯一判据；不一致说明环境形态不是本判据认的那种，'
      + '此时**不判**（而不是猜一个 tag 去判）。')
  }
}

if (!existsSync(join(REPO_ROOT, MIGRATIONS_DIR))) {
  precondition(`找不到迁移目录 ${MIGRATIONS_DIR}（root=${REPO_ROOT}）`)
}
if (RELEASE_CHAIN.length < 2) {
  precondition(`RELEASE_CHAIN 至少要有"基线 + 一版"两条（当前 ${RELEASE_CHAIN.length} 条）`)
}

const probe = git(['rev-parse', '--is-inside-work-tree'])
if (probe.status !== 0 || probe.stdout.trim() !== 'true') {
  precondition(`拿不到 git 工作树（root=${REPO_ROOT}）：${probe.stderr.trim() || 'git rev-parse 非零退出'}`)
}

const findings = []
const rows = []
const sectionRows = []

/**
 * 各版本**工作树**的章节身份集合（`note` → `Set<sectionKey>`）——反向登记项的"去向"对账用
 * （2026-10-04 FF-3）：`MOVED_TAG_SECTIONS` 说"这一节搬去了 <tag>"，就要在那一版的工作树里
 * 真的找得到它。这里先**独立读一遍**全部链上版本（不依赖主循环的推进顺序），所以"搬去链尾
 * 那一版"也能在本次运行里对账。读不到的版本给空集（缺文件的形态由主循环的 precondition 报）。
 */
const workSectionKeysByNote = new Map()
for (const tag of RELEASE_CHAIN) {
  const notePath = join(REPO_ROOT, RELEASES_DIR, `${tag}.md`)
  const headings = existsSync(notePath) ? levelTwoHeadings(readFileSync(notePath, 'utf8')) : []
  workSectionKeysByNote.set(tag, new Set(headings.map(sectionKey)))
}

// ④ tag 期：本次发布的 tag 必须在链上（否则这一版天然落在判据面之外 —— 那正是本判据要防的形态）。
if (ciTag !== null && !RELEASE_CHAIN.includes(ciTag)) {
  findings.push(`本次发布的 tag ${ciTag}（取自 GITHUB_REF=${ciRef}）不在 RELEASE_CHAIN 里 —— `
    + '发布 PR 必须把它追加到链尾，否则这一版没有"声明 ↔ 实际"的对拍。')
}

for (let index = 1; index < RELEASE_CHAIN.length; index += 1) {
  const fromTag = RELEASE_CHAIN[index - 1]
  const tag = RELEASE_CHAIN[index]
  const noteFile = `${tag}.md`
  const notePath = join(REPO_ROOT, RELEASES_DIR, noteFile)
  if (!existsSync(notePath)) {
    precondition(`链上登记了 ${tag}，但 ${RELEASES_DIR}/${noteFile} 不存在（发布面硬规则：正式与预发 tag 都必须有策展说明）`)
  }
  const text = readFileSync(notePath, 'utf8')
  const declared = declaredMigrations(text, noteFile)
  const { added, touched } = actualMigrations(fromTag, tag)

  const missing = added.filter(name => !declared.includes(name))
  const extra = declared.filter(name => !added.includes(name))
  if (missing.length > 0) {
    findings.push(`${noteFile}: 漏报 ${missing.length} 条 —— ${missing.join('、')}`
      + `（实际由 ${fromTag}..${tag} 引入，但锚点里没声明）`)
  }
  if (extra.length > 0) {
    findings.push(`${noteFile}: 虚报 ${extra.length} 条 —— ${extra.join('、')}`
      + `（锚点里声明了，但 ${fromTag}..${tag} 没有引入这些文件）`)
  }

  findings.push(...proseFindings(text, declared, noteFile))

  // ⑤ 章节归属（**双向**）：拿"该 tag 里的这一份发布说明"当基准 ——
  //   · 工作树里**多出来**的二级章节 = 打 tag 之后追加的 ⇒ 要么搬走，要么登记进 POST_TAG_SECTIONS
  //     （登记项要能指到该 tag 内的落地提交）；
  //   · 工作树里**少了**的二级章节 = 已发布说明被删除/改写 ⇒ 要么改回去，要么登记进
  //     MOVED_TAG_SECTIONS（写明去向或 `<removed>` + 理由）。反向那半是 2026-10-04 FF-3 补的。
  const tagText = gitShowFile(tag, `${RELEASES_DIR}/${noteFile}`)
  if (tagText === null) {
    precondition(`取不到 ${tag} 里的 ${RELEASES_DIR}/${noteFile}（tag 不存在，或这一份发布说明不在该 tag 里）—— `
      + '章节归属判据要拿它当"这一版原有的章节"的基准，取不到就不判（绝不当作通过）。')
  }
  const tagSections = levelTwoHeadings(tagText)
  const workSections = levelTwoHeadings(text)
  const late = lateSections(tagSections, workSections)
  const gone = missingTagSections(tagSections, workSections)
  // 字段名必须是 `note`（2026-10-04 主控裁决后修复）：`crossNoteSectionFindings` 与
  // `legitRepeatedSectionFindings` 都读 `entry.note`。旧实现压 `tag` ⇒ 跨版本重复判据在生产里
  // **恒不触发**（死判据），还会打印 `undefined.md:`；现在压 `note`，并且判据入口对缺 `note` 的行
  // fail-loud ⇒ 以后改字段名不会再静默退化。
  sectionRows.push({ note: tag, tagSections, workSections, allHeadings: headingLines(text) })
  findings.push(...sectionFindings({
    note: tag,
    tagSections,
    workSections,
    sectionsByNote: workSectionKeysByNote,
    isAncestor: commit => isAncestorOf(tag, commit),
  }))

  rows.push({
    tag,
    fromTag,
    declared,
    added,
    touched,
    lateSections: late,
    // 反向（FF-3）：tag 版有、工作树没有的章节 —— 逐版打印，便于人工复核登记项。
    missingTagSections: gone,
    tagSectionCount: tagSections.length,
    workSectionCount: workSections.length,
    ok: missing.length === 0 && extra.length === 0,
  })
}

// ⑤ 跨版本的章节结构（重复 / 序号 / 轮次归属）—— 需要看全部版本，放在循环之后。
// 判据①（跨版本重复）报"真实重复却没登记"；登记面自身的问题（死条目 / 形状 / 重复条目 / 下限）
// 由 legitRepeatedSectionFindings 报。两处共用同一份观测（observedSectionKeyOwners）。
findings.push(...crossNoteSectionFindings(sectionRows))
findings.push(...legitRepeatedSectionFindings(sectionRows))
/** 跨版本重名的观测面（`sectionKey → 版本列表`）——真值表逐条打印与双向对账共用这一份。 */
const repeatedSectionOwners = observedSectionKeyOwners(sectionRows)

// 未登记的发布说明（"新版本天然落在判据面外"的通道）：本区间前缀下，磁盘上有、链上没有 ⇒ 红。
const chainTags = new Set(RELEASE_CHAIN)
const onDisk = readdirSync(join(REPO_ROOT, RELEASES_DIR))
  .filter(name => name.startsWith(UNREGISTERED_NOTE_PREFIX) && name.endsWith('.md'))
  .map(name => name.slice(0, -3))
for (const tag of onDisk) {
  if (!chainTags.has(tag)) {
    findings.push(`${RELEASES_DIR}/${tag}.md 不在 RELEASE_CHAIN 里 —— 新增一版发布说明必须同时登记进链`
      + '（否则它天然落在本判据面之外）')
  }
}
if (rows.length === 0) {
  precondition('没有任何可对拍的区间（RELEASE_CHAIN 只解析出 0 个版本对）')
}

if (json) {
  console.log(JSON.stringify({
    verdict: findings.length === 0 ? 'PASS' : 'FAIL',
    gateRef: hasCiRef ? ciRef : null,
    compared: rows.length,
    rows,
    findings,
  }, null, 2))
} else {
  console.log(`check-release-notes-migrations: 逐版真值表（${RELEASES_DIR} ↔ git diff -M -C --name-status）`
    + (ciTag === null ? '' : `；本次 tag = ${ciTag}`))
  for (const row of rows) {
    const declared = row.declared.length === 0 ? '无' : row.declared.join('、')
    const added = row.added.length === 0 ? '无' : row.added.join('、')
    const late = row.lateSections ?? []
    console.log(`  ${row.ok ? '✅' : '❌'} ${row.tag}（相对 ${row.fromTag}）`)
    console.log(`      声明：${declared}`)
    console.log(`      实际：${added}`)
    const gone = row.missingTagSections ?? []
    console.log(`      章节：工作树 ${row.workSectionCount} 节（tag 版 ${row.tagSectionCount} 节）`
      + (late.length === 0 ? '，无 tag 之后追加的章节' : `；tag 之后追加 ${late.length} 节：${late.join('；')}`))
    console.log(`      反向：tag 版有、工作树没有 ${gone.length} 节`
      + (gone.length === 0 ? '（无删除/改写）' : `：${gone.join('；')}`))
    if (row.touched.length > 0) {
      console.log(`      另有就地改写/删除（不属"引入"，仅供参考）：${row.touched.join('；')}`)
    }
  }
  // 跨版本重名：**逐条打印**（登记表 ↔ 观测面），便于人工复核"哪些标题重名、登记了没有"。
  const repeatedKeys = [...repeatedSectionOwners.keys()]
    .filter(key => repeatedSectionOwners.get(key).length > 1)
    .sort()
  const registeredKeys = new Set(LEGIT_REPEATED_SECTION_KEYS.map(entry => entry.key))
  console.log(`  跨版本重名（判据①的观测面）：${repeatedKeys.length} 个标题出现在两版及以上`
    + `（登记表 ${LEGIT_REPEATED_SECTION_KEYS.length} 条，下限 ${MIN_LEGIT_REPEATED_KEYS}）`)
  for (const key of repeatedKeys) {
    const owners = repeatedSectionOwners.get(key)
    console.log(`      ${registeredKeys.has(key) ? '合法（已登记）' : '**未登记**'}：${key}`
      + ` ← ${owners.join('、')}`)
  }
}

if (findings.length > 0) {
  console.error('')
  for (const finding of findings) console.error(`check-release-notes-migrations: ${finding}`)
  console.error(`check-release-notes-migrations: ${findings.length} 条漂移 —— 发布说明的迁移清单与实际不符。`)
  process.exit(1)
}

console.log(`check-release-notes-migrations: 声明与实际一致（${rows.length} 个版本对，链首 ${RELEASE_CHAIN[0]}）✅`)
