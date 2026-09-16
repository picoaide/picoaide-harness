# v2.7.5-beta.2 → HEAD 回归审计与修复（2026-09-16，R9）

对象：`git diff v2.7.5-beta.2..HEAD`（25 个提交 = 1 个功能「客户端多语言补齐 #77」+ 24 个修复提交），
覆盖 `packages/host/{browser,connectors,cron,desktop,enterprise}`、`packages/client/{branding,account-card}`、
`packages/vendor/memory-evolve`、`server/internal/capabilities`、`scripts/check-workspaces.mjs`。

**为什么要做**：这 25 个提交本身是上一轮审计的产物（i18n 功能 + 一连串"收口"修复），
而修复自身也会引入回归。本轮的目标只有一个：**找出这段 diff 新引入的缺陷并修掉**。

审计方法（多代理流水线，四轮）：

| 轮次 | 代理 | 产出 |
| --- | --- | --- |
| R1 | 7 个只读分片代理（connectors / browser-core / browser-shell / enterprise+server+gate / i18n 机制 / cron / memory-evolve） | 16 项发现（P1×1、P2×9、P3×6） |
| R1 修复 | 主控 | 16 项全修 + 回归用例（含变异自证） |
| R2 | 4 个对抗复核代理（浏览器修复 / 连接器+桌面+企业 / 产物重建 / 新鲜眼光审 diff） | 13 项发现（P2×6、P3×7），全部落在**R1 的修复**上 |
| R2 修复 | 主控 | 13 项全修 |
| R3 | 2 个对抗复核代理（站点选值+cron 守卫 / 分类+桌面文案） | 4 项发现（P2×2、P3×2） |
| R3 修复 | 主控 | 4 项全修（含提交 `6278f37605`） |
| R4 | 2 个对抗复核代理（同上两片） | 6 项发现（P2×1、P3×5）：站点选值 4 项、cron 测试判别力 2 项 |
| R4 修复 | 主控 | 6 项全修（`66d83d0e1c`：顺序表重写 + `looksLikeHostText`） |
| R5 | 1 个对抗复核代理（站点选值） | 8 项发现（P2×3、P3×5）：`looksLikeHostText` 三处系统性漏洞 + 顺序表死分支 |
| R5 修复 | 主控 | 8 项全修（`f544ef7bed`：判据改「结构规则 + URL 解析回读一致性」、去死分支、cron 用例加固） |
| R6 | 1 个对抗复核代理（新判据） | 5 项发现（P2×2、P3×3）：IDNA 折叠绕过否表、数值/编码单标签被 WHATWG 改写 |
| R6 修复 | 主控 | 5 项全修（否表/TLD/示例域改判 IDNA 形态；数值与编码单标签拒绝；标签长度；补 5 组定点用例与文档同步） |
| R7 | 1 个对抗复核代理（收尾轮：新判据 + 是否应停止加固） | 4 项发现（P2×1 回归、P3×3 全 fail-closed）；**结论：修完那 1 处后应冻结判据** |
| R7 修复 | 主控 | 4 项全修（`localhost` 仅单标签放行；反斜杠/百分号/IDNA 句点同形字拒绝；ASCII 标签长度） |

---

## 一、P1

| # | 缺陷 | 引入 | 修复 | 回归测试 |
| --- | --- | --- | --- | --- |
| P1-1 | `CoIView` 的 `dict()` 包装器把 `params` 丢掉（`(key) => t(key)`），COI 调度 Tab **9 处**用户可见文案在任何语言下都渲染 `{count}`/`{value}`/`{minutes}` 模板原文；**入库产物 `lib/client.js` 同错**（用户实际拿到的那份） | `39692cac6e` | 包装器透传 `params`；src + 产物同步（产物经 esbuild 重建归一化对拍确认语义一致） | `tests/dict-params-passthrough.test.js`（3 层：src / 产物 / 调用点键存在；变异即红） |

## 二、P2

| # | 缺陷 | 引入 | 修复 |
| --- | --- | --- | --- |
| P2-1 | **站点绑定基准被非地址键劫持**：关键词表放宽成裸子串（`/uri/` 命中 `sec·URI·ty`），`SECURITY_TOKEN`/`siteName`/`website`/`callbackUrl` 里的任意裸词被归一成 origin 并顶掉真站点（`{SECURITY_TOKEN:'abc123def456', SITE_URL:'https://real'}` → `http://abc123def456`） | `a518f783b5` | 恢复 base 词边界判据；扩展拼法另立档位；选值分四遍（地址键显式 URL → 地址键"明确像主机"的裸值 → 其它键显式 URL → 地址键单标签猜测） |
| P2-2 | 连接器失败**分类**迁移漏包：RFC 8414 元数据里被出站策略拒绝的 authorize/token 端点落 `error`（base 是 `unauthorized`），英文界面还被套回通用兜底 | `39692cac6e` | 这两步走 `flowUrl()`（带稳定 code）；刷新路径解包 `cause` 保留「出站策略拒绝」语义 |
| P2-3 | `server-side` 定义缺 `fetchToken`（配置错误）被误判成「需要授权」，面板让用户去重新授权一个永不可能成功的连接器 | `39692cac6e` | 改回普通 Error（配置错误 ≠ 授权问题） |
| P2-4 | shell 页 `empty` 文案是唯一未转义的 HTML 汇点（i18n 把写死的 `<br/>` 搬进了译文表） | `39692cac6e` | 文案改 `\n` 分行 + 渲染器逐行转义后自己插 `<br/>`；`lang` 属性同步转义 |
| P2-5 | 语言切换到达不了**已打开**的浏览器窗口：两个 chrome 页按请求渲染、创建后不再请求，切语言后工具栏/胶囊/面板/查看器全停旧语言 | `39692cac6e` | 桌面在语言**真变化**时 emit `pico/locale-changed`；浏览器只 reload 两个 chrome 页（不碰标签页），全程异常围栏 |
| P2-6 | `capabilities` 里 `AppOfficialMap` 查询失败被吞：审批队列/能力中心把所有官方内容标成非官方（与事实相反的管理视图） | 部分（`9510ab058f` 只修了 skills 分支） | 三处一律 fail-loud 500（skills / agents / 能力中心） |
| P2-7 | 门禁假绿：`--concurrency <非数字>` ⇒ 0 个 worker，**7 个根守卫与 desktop check 一个都不跑**且 exit 0 | pre-existing（本轮修） | 非法值直接报错退出（实测用法错误 exit 2） |
| P2-8 | i18n 机制漏网：`branding` 的「关于」导航标签硬编码英文；`/` 索引渲染拿不到请求头 ⇒ 浏览器部署首屏恒中文而同浏览器 `/login` 是英文 | `39692cac6e` | 标签改 thunk + 字典键；`hostLocale` 增加「客户端设置偏好」一档（运行时之下、请求头之上） |
| P2-9 | 桌面原生面半个修复：Windows/macOS 安装对话框、检查更新三框、插件恢复框、启动通知、诊断导出失败框仍是硬编码英文，而同一流程的托盘项已中文化 | `39692cac6e` | 全部入 `tray-locale.ts` 表（zh/en） |
| P2-10 | 换码阶段**网络故障**被升级成 `auth-required`（base=error）⇒ 网络抖动把用户指向永远成功不了的"重新授权" | `39692cac6e` | 分类只对 `OutboundUrlBlockedError`/`OutboundTimeoutError` 升级 |
| P2-11 | 跳日（`Pacific/Apia` 2011-12-30 等）让 `lastRunAtMs` 的按日回退游标原地打转 ⇒ 调度器 tick 内同步死循环，`tickInFlight` 永不复位、全部定时任务停摆（8 年视野把可达窗口从 5 年放大） | 缺陷本体 pre-existing，`6c2ed4a0bb` 放大 | 回退步进加"不前进则退到绝对 24h"兜底：既终止又保留跳日之前的候选 |

## 三、P3（择要）

- 各包 `t()` / `hostT()` 的**逐参数 replaceAll**（跨参数二次替换）→ 统一单遍正则（7 个客户端字典 + 2 个宿主字典）。
- `runtime.ts` 自建 `TabPool` 未继承 locale provider；`reloadChromePages` 缺异常围栏。
- `shell-pages` 的 `failHttp.replace('{status}', String(status))` 字符串替换（值为数字，不可利用）→ 函数替换。
- TOCTOU 回归用例断言恒真（先做了一次合法注入，`some(...)` 在此之前已成立）→ 改为"拒绝调用不得**新增**注入命令"。
- `check-workspaces` 的 `process.exitCode = 2` 被 `process.exit(1)` 覆盖；zh 启动通知语序错；`PromptView.say` 与 6 处 translate 形参仍是收窄形态。
- memory-evolve 的 i18n 用例用 UTC 日期做期望（本地日期才是产品写入的键）⇒ 每天本地 00:00–08:00（UTC+8）门禁必红 → 改用 `todayStamp()`。

## 三·补、站点绑定选值的最终形状（R2→R5 五轮收敛）

`siteOriginFromFields` 的顺序表（顺序即优先级）：

| # | 候选 | 来源 |
| --- | --- | --- |
| 1 | base 地址键（词边界判据）上的显式 http(s) URL | base 逐字保留 |
| 2 | base 地址键上**文字形态就是主机**的裸值（点分域名 / IP / 回环私网） | 新增（E1） |
| 3 | 其余键上的显式 http(s) URL | base 原兜底，键序不变 |
| 4 | 扩展拼法键（camelCase / `hostname` / 连字符）上文字形态是主机的裸值 | 新增 |
| 5 | 全部地址形状键上的单标签裸值（`glitchtip`、`glitchtip:8000`） | 新增，最后 |

"文字形态就是主机"由 `looksLikeHostText` 判定，四层防御：
① 结构规则（无 scheme/空白/`@`、主机部分非空且无尾点/空标签、每级 ≤63、总长 ≤253）；
② **保留名否表与 TLD 判定在 IDNA 形态上跑**——只在原文上跑会被全角/零宽拼写
（`ｐｌａｃｅｈｏｌｄｅｒ.com` 折叠成 `placeholder.com`）绕过；
③ **URL 解析回读一致性**（`new URL('https://' + IDNA(文本)).hostname` 必须逐字等于 IDNA(文本)）
——挡住 WHATWG 的整数/十六进制/八进制 IPv4 重写（`134744072` → `8.8.8.8`、
`0x08080808` → `8.8.8.8`、`010.0.0.1` → `8.0.0.1`）与百分号编码（`010%2e0%2e0e1`）；
④ 单标签只接受"字母开头、非数值/十六进制、IDNA 不变形"的内网名，且排在最后一遍；
`localhost` 只在单标签形态放行（`localhost.com` 等 8 个真实注册域是占位符），
反斜杠截断 / `%` 编码 / IDNA 句点同形字（`。`/`．`/`｡`）与 ASCII 标签超长一律拒绝。
IDN 主机（`例子.中国` → `xn--fsqu00a.xn--fiqs8s`）与 `localhost` 仍然可用。

**为什么值得这么多轮**：这个函数是凭据注入的**信任基准**（BUG-03 闸门）。派生错一位，
要么把运维自己写的凭据注进记录里另一个主机，要么让真站点永久拒绝注入且拒绝文案把
模型指向一个不存在的主机。因此每一轮都用"base 差分 + 定例 + 变异"三条腿复核，
并把"与 base 的差异只有两类（新增可绑定 / 地址键更受信任）"作为硬不变量。

## 四、明确的两类行为变化（有意，已写进代码注释与用例）

1. **错误分类**：连接器连接失败改用稳定 code。与 base 的中文子串规则相比有两处**有意**不同（都是 `error` 而非 `unauthorized`）：
   换码网络故障；上游返回非 JSON / JSON `null`（base 只是因为 V8 文案里恰好含 `token` 字样而误判）。
2. **站点绑定**：地址形状键上的裸主机名现在可绑定（`app.example.com`、`10.0.0.5:8000`），
   且地址形状键优先于其它键；两个 base 地址键之间的取舍与 base **逐条一致**，
   没有任何记录从"可绑定"变成"不可绑定"（372.4 万组差分 `baseNonNull→null = 0`）。

## 五、已声明残留（本轮不做）

- `mcp-transport-fence` 的失败文案在 apply 期预热时被默认语言固定：失败是终态且罕见，
  完整修复要给围栏（安全关键）模块 ~12 个 throw 点加 locale-independent reason，
  风险大于收益；现状是"英文外层 + 中文内层"。
- `{base_url: <裸主机>, callbackUrl: <显式 URL>}` 仍会绑到 `callbackUrl` 的主机 ——
  与 base 相同（base 亦如此），要让"地址键裸主机"赢过"扩展档显式 URL"会偏离 base，
  属产品取舍。
- 能力中心的 `appOwnerMap` 吞错（缺 owner 而非报错）与 `listCapabilities` 的瞬时故障窗口未处理。
- 扩展拼法键（`serverUrl` 等）上的显式 URL **不**优先于其它键的显式 URL：`base` 的显式 URL
  取舍按"键名字典序"裁决，改它会静默改写既有绑定。需要优先时请用 `*_url`/`BASE_URL`
  这类 base 地址键，或用 `credentialSites` 显式声明。
- 单标签内网名（`glitchtip`）只在"记录里没有任何显式地址"时才作为最后兜底；此时
  `n/a`/`changeme` 之类的占位符已被否表挡住，但仍无法穷尽所有占位词。
- memory-evolve 的 resume 守卫失败分支 `#finish` 早退（任务停在 running）——pre-existing。

## 五·补、为什么在这里冻结（R7 的收尾判断）

`siteOriginFromFields` 是"从运维写的字段里猜站点"的启发式函数，R2→R7 六轮里每一轮加固
都被下一轮找到新的同形/编码反例；R7 的收尾复核给出的判断是：

- 修掉 `localhost` 那处回归后，**不再有 P2 及以上**：剩余只存在于"刻意构造的编码/同形
  垃圾值"（`%2e`、IDNA 句点、超长 UTF-8 标签）这一类，且全部 fail-closed（要么拒绝、
  要么退回 base 兜底），不产生"把凭据注入另一台真实可达主机"的路径；
- 继续加固的边际收益很小，而**回归风险已被实测兑现**（R7 的 P2 正是 R6 那一轮加固的
  副作用）；
- 因此判据冻结，残余风险交给消费侧：拒绝文案不再把低置信 origin 当作导航指令的唯一
  指引，需要确定绑定时用 `credentialSites` 显式声明（模块文档与拒绝文案都已这么写）。

**回归凭证**：`yarn check` 16/16 连跑四次绿；`tests/credential-site.spec.ts` 28 例
（含 R4/R5/R6/R7 四批共 76 组定点反例）；base 差分 120k 组 `baseNonNull→null = 0`；
强档键两两穷举 1,938,420 组与 base 逐条一致。

## 六、验证链

- `corepack yarn check`：16/16 任务通过（7 个根守卫 + desktop profile 冒烟 + 8 个 workspace 包），
  连跑三次绿（R1 修复后 / R2 修复后 / R3 修复后）。
- Go：`go test ./internal/capabilities/... ./internal/serverstore/...` 绿。
- 变异自证（回退修复即红）：credential-site（21→23 例）、shell-pages 空态、TOCTOU、分类三例、
  cron 跳日、desktop emit、诊断失败框、memory-evolve 三层守卫、7 个 `t()` 单遍语义。
- 对抗复核的独立证据：`temp/audit-r9*/**`（分片报告、差分探针、双树 A/B、产物重建对拍）。
