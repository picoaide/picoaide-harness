# 决策：渠道数据根（Harness home 与 userData）随渠道隔离

- 日期：2026-09-11
- 状态：已实施（master）
- 相关：`docs/planning/2026-09-10-channel-package-reference.md` §4.4、§5；
  `scripts/ci-channels.sh`、`packages/host/desktop/src/desktop-home.ts`、
  `desktop-channel.ts`、`desktop-user-data.ts`、`src/main.ts`

## 问题

渠道客户端（acme 等白标构建）与官方客户端共用**同一个**数据根：Harness home 是
编译期常量 `~/.picoaide-harness`（`desktop-home.ts` 的 `PRODUCT_DSH_HOME_DIR`），
用户明确报告"dsh_Home 这个目录没有随着渠道修改"。

后果（不是观感问题）：

1. **跨租户登录态**：`$DSH_HOME/session.json` 是登录 token，`.credentials.yaml`、
   `settings.yaml`（含服务端地址）、`sessions/` 全在同一目录。装了 acme 客户端的
   机器上，acme 客户端会直接恢复官方那台的会话，连上官方服务端。
2. **凭据/缓存互相覆盖**：连接器凭据按 `<dshHome>/users/<用户名>/connectors/` 分，
   **不按服务端分** —— 两边同名用户（`user001`）就撞在一起。
3. **并写损坏**：两个渠道同时运行写同一批文件（last-writer-wins）。
4. **白标泄漏**：路径、诊断包、错误信息里出现厂商名。

同类漏点（一并修）：

- Electron userData 之前只是**碰巧**随渠道（`app.setName(PRODUCT_NAME)`），而 beta
  渠道复用官方品牌 ⇒ 产品名与 official 逐字相同 ⇒ userData 与**单实例锁**和 official
  撞车（两个客户端互相顶掉启动）。`bin.ts` 的 npm 启动器路径还把 userData 目录名
  硬编码成 `PicoAide Harness`。
- `main.ts` 的 `app.setAppUserModelId('ai.deepseek.dsh.desktop')` 硬编码厂商 app id，
  与 electron-builder 写进快捷方式的渠道 app_id 不一致（Windows 通知身份对不上）。
- `packages/host/enterprise` 里四处自己拼 `~/.picoaide-harness` 兜底
  （`session-service.ts` / `skill-install.ts` / `agent-preset-install.ts` /
  `server-connector/tls.ts`），违反"数据目录权威源唯一"。

## 决策

1. **渠道包新增 `desktop.home_dir`**（`~` 下的单段目录名，`^\.[a-z0-9][a-z0-9-]{0,62}$`）。
   品牌渠道**必填**（CI 中止）；**beta 显式写 `.picoaide-harness`**（公共渠道刻意与
   official 共用数据根：beta 环境要经常跑测试，共用现成的登录态/设置更省事，CI 对
   公共渠道放行、只对品牌渠道禁用）；official 不需要（官方构建不随包分发渠道包）。
2. **派生唯一入口**：`desktop-home.ts` 的 `channelDshHomeDir(channelId, { homeDir, slug })`。
   取值链：显式值 → slug 小写（`Acme-Harness` → `.acme-harness`）→
   `.picoaide-harness-<channelId>`。**非官方渠道永不得到官方目录**（显式写官方目录、
   slug 等于官方 slug 都被忽略并退档）。
3. **官方渠道逐字节不变**：`~/.picoaide-harness`，无渠道包时走官方缺省；存量数据不搬。
4. **`$DSH_HOME` / 显式配置仍然优先**（e2e、便携安装、多 profile 依赖）。
5. **userData 也显式按渠道 setPath**（`desktopUserDataDirectoryName`）：官方 =
   产品名（不变）；**其余每个渠道 = `<产品名> (<渠道 id>)`**（2026-09-12 审计 P1-13
   修订，见文末"修订"节）。
6. **构建期与运行期同源**：`ChannelBuildContext.homeDir` 与随包 `channel.json` 由
   同一个函数解析，`verify-channel-package.ts` 用**运行期解析器**读随包配置做断言。
7. **不做迁移逻辑**：品牌渠道在本次之前没有正式发布（beta tag 只产 official/beta）。
   若将来发现某渠道已交付且数据落在旧目录，单独做一次性搬运，不得以"回落官方目录"兜底。

## 验证

- 单测（desktop / enterprise 全绿）：取值链、畸形值、**派生/回落路径不得撞官方目录**
  的穷举断言（显式声明则一律照办，含官方目录本身）、userData 消歧规则。
- `scripts/verify-ci-scripts.mjs`：新增 home_dir 缺失/畸形/品牌渠道写官方目录的
  fail-loud 用例，以及"公共渠道 beta 显式共用官方目录必须通过"的用例（全部通过）。
- 用**真实主进程代码**跑三个探针（Xvfb + 独立 HOME，`electron packages/host/desktop`）：
  - 假渠道 probe（`home_dir: .probe-harness`）→ `~/.probe-harness` ✓、
    `~/.config/Probe Harness` ✓、`~/.picoaide-harness` **未创建** ✓；
  - 官方（无渠道包）→ `~/.picoaide-harness` + `~/.config/PicoAide Harness`（不变）✓；
  - beta 式渠道（产品名与官方相同，显式 `home_dir: .picoaide-harness`）→ 数据根与
    官方相同 ✓，userData 为 `~/.config/PicoAide Harness (beta)`（日志/更新态/单实例锁
    不互相顶）✓。
- 真实渠道包（本地 `channels/acme`、`channels/beta`、`channels/example-brand`）走
  `scripts/ci-channels.sh` 校验通过（两者已补 `home_dir`）。

## 私有仓同步（已完成）

`picoaide/channels`（私有）已补齐 `desktop.home_dir`（2026-09-11，`main`）：

- **acme** → `.acme-harness`（与 slug 派生结果一致，将来即便漏配也不会换目录）；
- **beta** → **`.picoaide-harness`（显式与 official 共用）**：2026-09-11 当日修正 ——
  beta 环境要经常跑测试，共用现成的登录态/设置更省事；CI 对公共渠道（official/beta）
  放行官方目录，只对**品牌渠道**禁用。运行时仍保留"派生/回落路径不得撞官方目录"的
  兜底（防漏配），但**显式声明一律照办**；
- `official` 不写该字段（官方构建不随包分发渠道包，写了也不生效）；
- 该仓 README 的字段表补上 `defaults.*` / `desktop.*`（含 `home_dir` 的口径与
  "品牌渠道必填"的约束）。

验证：两个 tag 策略下 `ci-channels.sh` 均通过（正式 tag → 3/3 渠道，beta tag →
1/3）；用**真实 acme 渠道包**跑打包门禁 `verify-channel-package`（7/7）与真机探针
—— 数据落到 `~/.acme-harness` + `~/.config/Acme Harness`，`acmeai://` 的
SSO 回调通过桌面壳闸门并进入 token 预验证（探针期间临时清空 `defaults.server_url`
以免打到客户生产服务端，探测后已还原）。

保留的兜底：即使某个渠道忘了写，运行期与构建期也会由 `slug`/渠道 id 派生出
**只属于该渠道**的目录（绝不回落官方目录）；品牌渠道漏配仍会在 CI 阶段以中性信息
中止（不回显渠道名）—— 数据根写错的代价（跨租户共享登录态）远大于一次构建失败。

---

## 修订（2026-09-12）：beta 不再与 official 共用数据根

**结论**：`desktop.home_dir` 的**必填范围从"品牌渠道"扩到"除 official 之外的每个渠道"**；
`beta` 恢复为**独立数据根** `.picoaide-harness-beta`；CI 不再给 `official || beta` 开豁免。

**为什么推翻 2026-09-11 的"共用更省事"**：那次决定的隐含前提是"两条线跑同一份客户端"，
但 DSH 升级到 0.1.5-rc.2 之后这个前提不成立了：

- 正式线（官方 stable，pin `dsh-v0.1.2-rc.1`）会话格式 = **v0**；
  预发线（含 0.1.5-rc.2，pin `dsh-v0.1.5-rc.2`）会话格式 = **v3**；
- rc1 只认**无版本**文件名（`session.jsonl[.zstd]`），对 `session.vN.*` 世代**静默跳过**
  （`session-persistence-jsonl` 读路径 `continue`），迁移又是**副本式**（源 v0 保留、
  另发 v3）⇒ 同一台机器上两代客户端会各写一份：
  - 预发期间新建的会话（只有 v3）对正式客户端**永久不可见**；
  - 已经双边存在的会话，正式客户端继续往 v0 追加、预发客户端只认 v3
    ⇒ **历史分叉**，且两边都不报错；
- 两代客户端的 Electron userData 不同（`PicoAide Harness` vs `PicoAide Harness (beta)`）
  ⇒ **单实例锁挡不住**，两个进程可以同时活着写同一个数据根。

共用省下的是一次登录，代价是静默丢数据 —— 不划算，因此：

1. `scripts/ci-channels.sh`：`desktop.home_dir` 对所有非 `official` 渠道必填；任何渠道
   写成 `.picoaide-harness` 一律 fail-loud（错误信息不回显渠道名）。
2. `scripts/verify-ci-scripts.mjs`：三条新用例 —— beta 写官方目录必须失败、beta 写
   `.picoaide-harness-beta` 必须通过、beta 缺字段必须失败（原来的"beta 共用必须通过"
   用例已删除）。
3. `picoaide/channels`（私有）`channels/beta/channel.json`：`home_dir` →
   `.picoaide-harness-beta`，`meta.description` 同步说明原因。
4. **运维口径**：预发客户端升级后**不会**再看到正式客户端的登录态与历史会话（这是
   目的，不是回归）；需要在预发环境复用数据时，请手动从 `~/.picoaide-harness`
   复制到 `~/.picoaide-harness-beta`，且**不要**让两代客户端交替打开同一份拷贝。

---

## 修订（2026-09-12，二次）：beta 回到与 official 一致的数据根

**结论（用户定案）**：预发版是正式版的**前置验证**，登录态、设置与会话必须与正式版
延续 —— `picoaide/channels` 的 `channels/beta/channel.json` 把 `desktop.home_dir` 改回
`.picoaide-harness`；CI 规则同步改成"**beta 必须与官方一致**，品牌渠道仍不得写官方
目录"。上面那次"beta 独立数据根"的修订作废。

**触发它的真实事故（同日下午）**：已装 `v2.7.2-beta.1/beta.2` 的用户直接升级到
`beta.6` 后报"**所有对话都没了**"。原因不是跨版本，而是上面那条修订：

- 随包 `build/channel.json` 的 `desktop.home_dir` 在 beta.2 里是 `.picoaide-harness`
  （与官方共用），在 beta.3 起是 `.picoaide-harness-beta`（独立）—— 已用产物级证据确认
  （从两次 CI 的 `desktop-Linux` artifact 解出 AppImage → `app.asar` →
  `build/channel.json`：beta.2 = `.picoaide-harness`，beta.6 = `.picoaide-harness-beta`）；
- DSH home 里装的是**对话本身**：`sessions/`、`storages/`、`settings.yaml`、
  `.credentials.yaml`、`session.json`（企业登录 token）—— 换根 = 空会话列表 + 重新登录；
- 旧数据没被删（仍在 `~/.picoaide-harness`），但客户端**没有任何迁移**，发布说明也
  没写，所以对用户就是"数据丢了"。

**机制根因（比这次配置更值得记）**：`scripts/ci-channels.sh` 每次构建都
`git clone --depth 1` 私有渠道仓的 **origin/main（不 pin commit）**，所以同一个源码 tag
可以打出数据根不同的客户端，而升级是"换包即生效"、中间没有任何迁移。 beta.2 的构建在
`2026-09-12 11:11:54` 克隆渠道仓，改 `home_dir` 的 `5c6bde3` 是 `11:19:51` —— 相差 8 分钟，
同一批 tag 里就出现了两种数据根。

**新规则（唯一取值，显式且 fail-loud）**：

1. `scripts/ci-channels.sh`：`desktop.home_dir` 仍对所有非 `official` 渠道必填；`beta`
   必须**恰好**是 `.picoaide-harness`（写别的目录、含派生兜底 `.picoaide-harness-<渠道>`
   一律中止）；品牌渠道仍**不得**写 `.picoaide-harness`。两个方向都拦，防止再次静默漂移。
2. `scripts/verify-ci-scripts.mjs`：三条 beta 用例翻转 —— 写 `.picoaide-harness` 必须
   **通过**、写自己的目录必须**失败**、缺字段必须失败。
3. 运行期派生逻辑（`desktop-home.ts` 的 `channelDshHomeDir`）不变：显式声明一律采纳
   （本来就允许渠道声明官方目录），变的只是渠道包与构建期守卫。

**要认账的残留风险**：在正式线还是 v0 的窗口期（官方 stable ≤ v2.7.1 仍 pin
`dsh-v0.1.2-rc.1`），两代客户端共用同一数据根仍然是上面第一次修订描述的那个场景 ——
预发期新建的 v3 会话对正式客户端不可见、双边会话会被分别追加。缓解：正式线尽快升到
0.1.5-rc.2（`v2.7.2` 转正即闭合窗口）；窗口期内不要在同一台机器上交替使用正式版与
预发版客户端。

**数据口径（已经装过 beta.3~beta.6 的机器）**：换回后，那段时间写在
`~/.picoaide-harness-beta` 的会话在新客户端里看不到，需要人工合并一次：退出两个客户端
后把 `~/.picoaide-harness-beta/` 的内容并入 `~/.picoaide-harness/`（两代 pin 的上游同一
commit、会话格式同为 v3，直接拷即可；同名文件先备份）。只装过 beta.1/beta.2 的机器
什么都不用做 —— 它们本来就在官方目录里。

---

## 修订（2026-09-12，三次）：userData 目录名对**所有**非官方渠道消歧

**结论（2026-09-12 审计 P1-13）**：`desktopUserDataDirectoryName` 从"只在与官方产品名
重名时补 ` (渠道 id)`"改成"**非 official 一律补**"。原来的写法只挡住了与 **official**
的碰撞，两个**不同的**品牌渠道只要取同一个 `desktop.product_name`（例如同一客户的两个
环境 `acme` / `acme-staging`）仍会共用一个 userData：单实例锁互斥（后启动的客户端直接
退出 = "打不开"）+ 日志/更新状态/插件管理状态/下载共享。渠道 id 形状
（`^[a-z0-9][a-z0-9-]{0,31}$`）里没有括号，末尾的 ` (<id>)` 唯一可解码 ⇒
`(产品名, 渠道 id) → 目录名` 是单射，唯一性由**构造**保证而不是靠渠道作者不重名。
同批修：`desktop.product_name` 及其回落来源 `identity.display_name` 加**形状校验**
（`isSafeProductName`，与 `home_dir` / `app_id` 同口径），畸形值回落中性占位 ——
它此前是唯一没有形状校验的**路径型**字段，`"../evil"` 能把数据根挪出 `appData`。
构建期同款校验登记进 `scripts/ci-channels.sh`（fail-loud 在客户机器之前）。

**升级影响（认账，与上面两次修订同类）**：品牌渠道的 userData 目录名会变一次 ——
`~/.config/Acme Harness` → `~/.config/Acme Harness (acme)`。留在旧目录里的是
**日志、更新状态与已下载安装包（会重下）、插件管理状态、崩溃取证**，以及
**browser 插件的书签/历史/下载 ledger**（`browser-store/<user>`，
`packages/host/browser/src/index.ts:213`）—— 最后这一项是用户可见数据，
表现为"书签与历史空了"（数据仍在磁盘上，不删除）。
**会话与登录态不受影响**：它们在 Harness home（`desktop-home.ts`，本次未改），
所以不会重演 beta.3~beta.6 那次"所有对话都没了"。
**公共渠道不受影响**：official = 产品名、beta = `<产品名> (beta)`，两者逐字节不变。

**兼容方案（供决策，本次未实施 —— 本仓 §7"不做迁移逻辑"仍然有效）**：

1. **按现状接受**：依据是本文件 §7"品牌渠道在本次之前没有正式发布"，且公共渠道零
   影响。若某品牌渠道**确已交付**，按 §7 的口径做一次性人工搬运（退出客户端后把旧
   目录 `mv` 到新名字，浏览器书签/历史随之保留）。
2. **启动期一次性改名迁移**（若确认已有交付、且要求"升级后无感"）：在
   `main.ts` 的 `app.setPath('userData', …)` 之前，若**旧名字目录存在且新名字目录
   不存在**，`renameSync(旧, 新)`。注意它只在"旧目录还没有被别的渠道占用"时成立；
   发生碰撞的那一对渠道里，先启动者拿到数据、后启动者从空目录开始（数据不会丢，
   归属确定）。代价是运行期多一段只在首次启动生效的逻辑，且与 §7 的"不做迁移逻辑"
   相抵触 —— 由主控拍板。**不要**用"回落旧路径读取"作为兜底：那会让撞名的两个渠道
   继续共用同一个目录，等于把本条缺陷放回去。
