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
| R4 | 2 个对抗复核代理（同上两片） | 见提交历史 |

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
- memory-evolve 的 resume 守卫失败分支 `#finish` 早退（任务停在 running）——pre-existing。

## 六、验证链

- `corepack yarn check`：16/16 任务通过（7 个根守卫 + desktop profile 冒烟 + 8 个 workspace 包），
  连跑三次绿（R1 修复后 / R2 修复后 / R3 修复后）。
- Go：`go test ./internal/capabilities/... ./internal/serverstore/...` 绿。
- 变异自证（回退修复即红）：credential-site（21→23 例）、shell-pages 空态、TOCTOU、分类三例、
  cron 跳日、desktop emit、诊断失败框、memory-evolve 三层守卫、7 个 `t()` 单遍语义。
- 对抗复核的独立证据：`temp/audit-r9*/**`（分片报告、差分探针、双树 A/B、产物重建对拍）。
