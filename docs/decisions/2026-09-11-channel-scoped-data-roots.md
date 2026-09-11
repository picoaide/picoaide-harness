# 决策：渠道数据根（Harness home 与 userData）随渠道隔离

- 日期：2026-09-11
- 状态：已实施（master）
- 相关：`docs/planning/2026-09-10-channel-package-reference.md` §4.4、§5；
  `scripts/ci-channels.sh`、`packages/host/desktop/src/desktop-home.ts`、
  `desktop-channel.ts`、`desktop-user-data.ts`、`src/main.ts`

## 问题

渠道客户端（moka 等白标构建）与官方客户端共用**同一个**数据根：Harness home 是
编译期常量 `~/.picoaide-harness`（`desktop-home.ts` 的 `PRODUCT_DSH_HOME_DIR`），
用户明确报告"dsh_Home 这个目录没有随着渠道修改"。

后果（不是观感问题）：

1. **跨租户登录态**：`$DSH_HOME/session.json` 是登录 token，`.credentials.yaml`、
   `settings.yaml`（含服务端地址）、`sessions/` 全在同一目录。装了 moka 客户端的
   机器上，moka 客户端会直接恢复官方那台的会话，连上官方服务端。
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
   品牌渠道**必填**（CI 中止）；beta 不强制（缺省派生出 `.picoaide-harness-beta`，
   已经与 official 分离），但建议显式给 —— 显式值不会因为将来改 `slug` 而挪动数据
   目录；official 不需要（官方构建不随包分发渠道包）。
2. **派生唯一入口**：`desktop-home.ts` 的 `channelDshHomeDir(channelId, { homeDir, slug })`。
   取值链：显式值 → slug 小写（`Moka-Harness` → `.moka-harness`）→
   `.picoaide-harness-<channelId>`。**非官方渠道永不得到官方目录**（显式写官方目录、
   slug 等于官方 slug 都被忽略并退档）。
3. **官方渠道逐字节不变**：`~/.picoaide-harness`，无渠道包时走官方缺省；存量数据不搬。
4. **`$DSH_HOME` / 显式配置仍然优先**（e2e、便携安装、多 profile 依赖）。
5. **userData 也显式按渠道 setPath**（`desktopUserDataDirectoryName`）：官方 =
   产品名（不变）；品牌渠道 = 产品名；与官方同名（beta）= `<产品名> (<渠道 id>)`。
6. **构建期与运行期同源**：`ChannelBuildContext.homeDir` 与随包 `channel.json` 由
   同一个函数解析，`verify-channel-package.ts` 用**运行期解析器**读随包配置做断言。
7. **不做迁移逻辑**：品牌渠道在本次之前没有正式发布（beta tag 只产 official/beta）。
   若将来发现某渠道已交付且数据落在旧目录，单独做一次性搬运，不得以"回落官方目录"兜底。

## 验证

- 单测（desktop 676 / enterprise 247 全绿）：取值链、畸形值、非官方渠道永不得到
  官方目录的穷举断言、userData 消歧规则。
- `scripts/verify-ci-scripts.mjs`：新增 home_dir 缺失/畸形/等于官方目录/ beta 共用官方
  目录的 fail-loud 用例（全部通过）。
- 用**真实主进程代码**跑三个探针（Xvfb + 独立 HOME，`electron packages/host/desktop`）：
  - 假渠道 probe（`home_dir: .probe-harness`）→ `~/.probe-harness` ✓、
    `~/.config/Probe Harness` ✓、`~/.picoaide-harness` **未创建** ✓；
  - 官方（无渠道包）→ `~/.picoaide-harness` + `~/.config/PicoAide Harness`（不变）✓；
  - beta 式渠道（产品名与官方相同）→ `~/.picoaide-harness-beta` +
    `~/.config/PicoAide Harness (beta)`（不再与 official 争单实例锁）✓。
- 真实渠道包（本地 `channels/moka`、`channels/beta`、`channels/example-brand`）走
  `scripts/ci-channels.sh` 校验通过（两者已补 `home_dir`）。

## 私有仓同步（已完成）

`picoaide/channels`（私有）已补齐 `desktop.home_dir`（2026-09-11，`main`）：

- **moka** → `.moka-harness`（与 slug 派生结果一致，将来即便漏配也不会换目录）；
- **beta** → `.picoaide-harness-beta`（复用官方品牌，但数据根与 official 分开：
  预发版本不再写进正式用户的数据目录，两者也不共用单实例锁）；
- `official` 不写该字段（官方构建不随包分发渠道包，写了也不生效）；
- 该仓 README 的字段表补上 `defaults.*` / `desktop.*`（含 `home_dir` 的口径与
  "品牌渠道必填"的约束）。

验证：两个 tag 策略下 `ci-channels.sh` 均通过（正式 tag → 3/3 渠道，beta tag →
1/3）；用**真实 moka 渠道包**跑打包门禁 `verify-channel-package`（7/7）与真机探针
—— 数据落到 `~/.moka-harness` + `~/.config/Moka Harness`，`mokahr-harness://` 的
SSO 回调通过桌面壳闸门并进入 token 预验证（探针期间临时清空 `defaults.server_url`
以免打到客户生产服务端，探测后已还原）。

保留的兜底：即使某个渠道忘了写，运行期与构建期也会由 `slug`/渠道 id 派生出
**只属于该渠道**的目录（绝不回落官方目录）；品牌渠道漏配仍会在 CI 阶段以中性信息
中止（不回显渠道名）—— 数据根写错的代价（跨租户共享登录态）远大于一次构建失败。
