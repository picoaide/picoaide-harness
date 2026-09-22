# 决策：网关协议组装期钉死 + 孤儿写锁启动回收（2026-09-22）

**状态**：已实施（随下个客户端版本发布）
**影响面**：`packages/host/enterprise/cordis.patch.yml`（一行组装期 config）、
`packages/host/desktop/src/document-lock-recovery.ts`（新）+ `src/main.ts` 接线 +
`scripts/verify-packaged-runtime.ts` 的打包必需条目
**实证**：`packages/host/desktop/tests/{document-lock-recovery,llm-gateway-protocol-pin}.spec.ts`
+ `scripts/verify-profile-boot.mjs` 的真组合树能力判据；现场取证包为本地临时目录（gitignored，不进仓）

## 1. 现场事故（根因链）

2026-09-22 客户机：**打开客户端对话即"认证失败"**，每个模型请求都返回
`401 {"error":{"code":"AUTH_REQUIRED","message":"缺少认证令牌"}}`，重新登录无效。

三层根因，缺一不可：

1. **协议层**：客户端被自动升级到 0.1.6 线（新版系统提示词可判：`ralph` 段落消失、
   交付物文案换代、GUI 端口变化）。上游 0.1.6 给 `llm-deepseek` 新增 `protocol`，
   **缺省值是 `messages`**；该协议路径（`protocols/messages/adapter.ts`）只发
   `x-api-key`、**不发 `Authorization`**，而我们的网关 `/v1/*` 挂在 `serverauth.BearerAuth`
   下、`bearerToken()` 只认 `Authorization: Bearer …` ⇒ 每个模型请求必然 401。
2. **配置层**：数据根 `settings.yaml` 的 `llm-deepseek` 段是旧版（0.1.5 线，无
   `protocol` 概念）写的，只有 `baseURL/apiKeyEnv/models/reasoningEffort` —— 没有
   `protocol`。旧版客户端永远走 chat-completions，所以这个键从来没被写过。
3. **为什么没被修好**：唯一会在运行期写 `protocol: chat-completions` 的是
   `gateway-model.sync`，它走 **settings 落盘**；而数据根里躺着一个 **0 字节孤儿锁
   `settings.yaml.lock`**。上游 `dsh-atomic-write` 的 `withFileLock` **故意不删别人的
   锁**（`orphan recovery is an operator action`），于是此后每一次 settings 写入都等
   2s 后以 `timed out waiting for the writer lock` 失败，异常又被各插件的 `.catch`
   吞进日志 ⇒ "本该修好链路的那一行"永远写不进去。
   佐证：`settings.yaml` mtime 停在事故发生前一天；`.credentials.yaml`（另一把锁）
   照常被改写 ⇒ 只有 settings 被锁死。

判定要点（可复用）：`缺少认证令牌` 只出自 `serverauth` 的 `BearerAuth`（请求**没有**
`Authorization` 头）；token 失效是 `AUTH_FAILED`「令牌无效或已过期」，本地解析不到
key 是 `MISSING_CREDENTIAL` —— 三种形状互斥，不要混判。

## 2. 决策

### 2.1 网关协议在**组装期**钉死（不再依赖运行期写入）

`packages/host/enterprise/cordis.patch.yml` 给 `llm-deepseek` 行加：

```yaml
- id: llm-deepseek
  config:
    protocol: chat-completions
```

settings 的解析顺序是 schema 缺省 → **组装 base** → user 层，缺这个键的 user 层不会
覆盖组装值（`settings.installSection(ctx, NS, Config, config, …)` 把行 config 当 base）。
所以这一层**不经过任何落盘**：即使 settings 再次写不进去、即使运行期同步整条失效，
模型请求依旧带 `Authorization: Bearer`。三条边界（判据 `llm-gateway-protocol-pin.spec.ts`
+ 能力判据 `scripts/verify-profile-boot.mjs`）：

- **现场形态**已验证（真实 `FileSettingsProvider` 读磁盘上的 `settings.yaml`，与运行期
  `ctx.settings` 同一条解析路径）：settings 里已有一段**没有 `protocol`** 的
  `llm-deepseek` 时，解析值仍是 `chat-completions`，且该段的
  `baseURL/apiKeyEnv/models/reasoningEffort` 一字未丢；反向对照（摘掉 pin）解析回
  `messages`。真组合树里的同一条能力判据在 `scripts/verify-profile-boot.mjs`。
- **逃生门是有意的**：更晚的层（`$DSH_HOME/cordis.patch.yml`）仍可覆盖协议。但 patch 的
  `config` 是**整键替换**：覆盖这一行 config 的补丁**必须重述 `protocol: chat-completions`**
  ——只写 `models` 会把 pin 一起换掉、静默回落 `messages`（用例已把这条口径写死，pin 所在
  的 `cordis.patch.yml` 也有同样的注释）。兜底是运行期 `gateway-model.sync`：它每次会话
  变更都把 `protocol` 写进 **user 层**（user 层优先于 base）。所以"覆盖该行 config"要真的
  复现 401，需要同时满足"settings 落盘失败"——正是本次事故的组合。
- **逃生门只在"未登录"时持久**：一旦有会话，`gateway-model.sync` 会用 user 层的
  `chat-completions` 盖回 home patch 的值（user 层永远压 base）。也就是说 home patch 适合
  "换网关协议/换端点"的一次性救援与离线场景，**不适合**当作登录态下长期生效的开关 ——
  要长期改协议得同时改渠道/组合层（这属产品决策，不在本次范围）。
- **前提是"base 行自己没有 config"**：patch 的 `config` 是**整键替换**，所以用例对
  组装结果做**深等**并单独断言 base 行为空 —— 上游哪天给这行加了 config，用例会红，
  提醒把 pin 改成合并写法而不是替换。

### 2.2 启动期回收**孤儿写锁**（让"静默变只读"不再永久）

`packages/host/desktop/src/document-lock-recovery.ts`：主进程在
`requestSingleInstanceLock()` 之后、`prepareDesktopProfile`/`boot` **之前**，对
`<home>/settings.yaml.lock` 与 `<home>/.credentials.yaml.lock` 做一次判定。

**每条删除判据都自带证据，不依赖"同一数据根只有一个实例"**——那个前提是错的：
渠道包可以共用数据根（beta 渠道的 `home_dir` 就是官方目录 `.picoaide-harness`），
而 Electron 单实例锁在**按渠道分流**的 userData 里，两个渠道的客户端可以同时跑在
同一数据根上。

| 情形 | 判据 | 动作 |
|------|------|------|
| 锁里记的就是**本进程** PID | 本函数在任何写入者之前调用，本进程还没写过锁 ⇒ 只可能是上一轮的同号 PID（PID 复用）。这是**证明** | 删 |
| 锁里的 PID 探测为**已不存在**（`ESRCH`） | 只有 `ESRCH` 算证据；`EPERM`＝活着，其它错误码（`ERR_OUT_OF_RANGE`…）＝未知。**没有 PID 上界短路**（Windows PID 是 32 位空间） | 删 |
| 没有可用属主（0 字节/空白/记为 0）**且** mtime 已超过 `NO_OWNER_LOCK_MIN_AGE_MS`（45s，与 cron 的 `STALE_LOCK_AGE_MS` 同口径） | 活着的写者"已建锁、还没写 PID"的窗口是微秒级；超过门槛仍是 0 字节 ⇒ 写入失败/进程死掉留下的孤儿。未来 mtime 按"太新"处理 | 删 |
| 锁**读不出来**（EACCES/EIO/超大文件…） | 可能是别人按更严权限建的**活锁**："读不出"≠"没有属主" | 保留 + 上报 |
| 内容不是十进制 PID | 上游若换格式，"不认识"≠"没有属主" | 保留 + 上报 |
| 路径上是目录/符号链接等非普通文件 | 需要人看 | 保留 + 上报 |
| 属主 PID 存活 / 存活状态未知 | 不替人删活锁 | 保留 + 上报（附 PID） |
| 判定与删除之间文件被换掉（复检 `dev`/`ino`/`size`/`mtimeMs` **并与判定时读到的内容逐字节比较**） | 防 TOCTOU 删掉另一个写者刚落的新锁。锁内容是 `String(pid)+'\n'`，同数量级的 PID 天然同长度，而时间戳步进（实测 4ms）粗于判定窗口、ext4 又会立即复用 inode ⇒ 只有内容比较认得出来（第 4 轮审计用真实第二进程复现 18/20 漏检，遂加） | 保留 + 上报 |
| 删除本身失败（权限/只读文件系统/Windows 占用） | — | 保留 + 上报 |

另外两条工程细节：mtime 落在 `Date` 值域之外（归档恢复/坏时间戳）只让日志少一个字段，
**不影响裁决**；`session.lock` 等其它锁**不在候选集**（它是会话租约、故意常驻磁盘）。

风险与代价（认账）：

- 回收是**启动卫生**，失败只上报，绝不阻断启动；任何一条候选的异常都被收进报告。
- 年龄门槛的代价：**崩溃后立刻重启**的那一次运行不会回收刚留下的 0 字节锁（settings
  仍写不进去）；但模型链路已由 §2.1 的组装期 pin 兜住，下一次启动（>45s）即回收。
- 残余不自愈：属主 PID 被**另一个活进程**复用（只告警，需人工删）、锁文件读不出来
  （只告警）。两者都留了可检索日志（`reclaimed…` / `held by live pid…` / `left … in place (reason)`）。
- **保证范围**：PID 存活探测（`process.kill(pid, 0)`）的结论只在**同一台机器、同一个 PID
  命名空间**内成立。容器/绑定挂载共享数据根、或网络家目录由另一台机器写锁的部署里，
  活属主的 PID 在本地可能不存在 ⇒ 会被判成 `ESRCH`（`owner-is-this-process` 那条"证明"
  同理：另一个命名空间里同号的活属主不会被探测到）。这类部署形态不在本模块的保证范围内
  （代码注释与本条同步写明）。
- **只有日志、没有 UI 信号**（认账）：回收/保留/太新的结论都只进 `electronLogger.error`
  （stderr + `<userData>/logs/dsh-*.log`），用户界面不提示。启动路径上弹通知属产品决策
  （`runtime.updates.notify` 是现成的先例），本次不做；排查时按模块头给的三种可检索文案
  （`reclaimed…` / `held by live pid…` / `left … in place (reason)`）查日志。
- **复检自身的 µs 级窗口**（认账，未构造出可达攻击）：`lstat` 与随后的读取之间理论上仍可
  被换一次文件；`isFile()` 复验挡住了符号链接/FIFO 等非普通文件，而能在该窗口里换上一个
  **内容完全相同**的普通文件本身不构成危害。更硬的做法是 `O_NOFOLLOW|O_NONBLOCK` 打开后
  `fstat` 比对再从该 fd 读，本次不做（跨平台分支成本大于收益）。

### 2.3 不做的事（边界）

- **不**改服务端接受 `x-api-key`：网关契约是 Bearer-only；`web-search-deepseek` 自己
  就同时发两个头（`provider.ts:228-231`），说明这是上游单个适配器的窄口子，客户端说对
  协议即可。放开第二个凭据头是契约/安全决策，应单独立项。
- **不**扩大锁回收候选集：`<home>/llm-deepseek/files-v3.json.lock`、
  `<profile>/package.json.lock` 也都会孤儿，但它们的失败是**响亮**的（附件上传报错、
  插件管理报错），不是"静默只读"。本模块只覆盖**静默**那一类；需要时按同一判据加一行候选。
  注：`profiles/node_modules.lock` 由 `healProfilesModuleFallback` 使用，锁取不到会直接
  抛 ⇒ 启动期 fail-loud，同样不在本模块范围内。

## 3. 门禁（防退化）

| 判据 | 位置 | 变异（应当变红） |
|------|------|------------------|
| 组装后的 `llm-deepseek` 行 config **深等** `{protocol: chat-completions}`（真 bundle + 真 patch 链）；无"补丁打空"告警 | `tests/llm-gateway-protocol-pin.spec.ts` | 删掉那条 patch → 三条**正向**用例红（两条 reverse control 本就该绿，这是设计） |
| **现场形态**：真实 `FileSettingsProvider` 读磁盘 `settings.yaml` 里**没有 `protocol`** 的段 ⇒ 仍是 chat-completions 且其它字段保留；同一条用例的另一半证明**显式** protocol 仍能覆盖（逃生门双向可证） | 同上 | 摘掉 pin → 同一份现场 settings 解析回 `messages`（另有独立 reverse control 用例） |
| 上游 schema 缺省确实是 `messages`（这层 pin 为什么必需） | 同上 | 上游改缺省值 → 红，提醒重看 pin |
| home patch 覆盖该行 config 的**整键替换**口径（只写 `models` 会丢 pin ⇒ `messages`；重述 protocol 则保住） | 同上 | 覆盖语义变了（例如改成深合并）→ 红，提醒重看这条口径 |
| 回收判据逐条：0 字节（老/新）、空白、PID 0、自身 PID、已死 PID（注入 + **真实** ESRCH）、活 PID、存活未知、巨数 PID、不可读/超大（读之前设体积闸门 + **闸门值 4096 字面量判据**）、恰好等于闸门、未知格式、目录、符号链接、判定期间消失、TOCTOU 换锁（不同长度 + **同 inode/同 size/同 mtimeMs 只差内容**）、mtime 越界、`inspect-failed`、删除失败（注入）、删除时已被别人删掉（注入）、幂等、不碰 `session.lock`、年龄门槛**量级**（字面量 45_000 与 61s/30s 两侧） | `tests/document-lock-recovery.spec.ts` | 任一条判据放宽或收紧 → 对应用例红 |
| 存活探测的 **errno→三态映射** 本身（`ESRCH`→gone、`EPERM`→alive、其它/缺失→unknown，大小写不同不算同一码） | 同上（`classifyOwnerProbeError`） | 把 `EPERM` 或兜底映射成 `gone` → 红（真 `EPERM` 需要非特权进程，纯函数判据在任何环境都有牙） |
| **年龄门槛与 cron 同口径**：直接读 `packages/host/cron/src/host-ledger.ts` 的 `STALE_LOCK_AGE_MS` 对拍（剥行注释 + 锚 `^const … = …$` + 恰好一处声明） | 同上 | 任一侧改值/改名/换成表达式 → 红（判据不容忍注释诱饵，也不容忍真值漂移被注释掩盖） |
| 接线顺序：回收必须在 `requestSingleInstanceLock()` 之后、`prepareDesktopProfile` 之前，且失败不阻断启动 | 同上（读 `main.ts`） | 挪到 `boot()` 之后 → 红 |
| **能力**：新建的 0 字节锁必须保留；拨老后 ⇒ settings 写缝超时失败；回收后 ⇒ 同一写缝成功；活锁保留 | `scripts/verify-profile-boot.mjs`（`yarn check` 内，真组合树 + 构建产物） | 去掉年龄门槛 / 去掉回收 / 把活锁也删 → 红 |
| **能力**：真组合树里 settings 带**现场形态**的 `llm-deepseek` 段（无 protocol）时，解析值仍是 chat-completions 且该段其它字段保留 | 同上（`ctx.settings.get` 读的就是适配器读的那份值） | patch 被静默跳过/被替换 → 红 |
| 打包产物必须含 `lib/document-lock-recovery.js` 与 `lib/network-policy.js`（`lib/main.js` 静态 import 的两个独立 tsdown 入口） | `scripts/verify-packaged-runtime.ts` 的 `REQUIRED_PACKAGED_RUNTIME_ENTRIES`（afterPack 逐条断言） | 入口改名/漏构建 → 打包门禁红（否则 import 期 `ERR_MODULE_NOT_FOUND`，窗口都起不来） |
| **产物自证**：归档里**桌面自身每个** `lib/**/*.js` 的相对 `./x.js` import 都必须在归档内（含内容哈希 chunk；chunk 引用 chunk 也判） | `scripts/verify-packaged-runtime.ts` 的 `assertRelativeImportsPresent`（asar 布局） | 去掉某个 chunk / 把判据退回"只查 main.js" → 对应用例红（已知边界：`../`、`.cjs`/`.mjs`、`require(` 不入判据；物理布局分支不跑，注释已写明） |
| **覆盖面**：`@picoaide/*` 插件包**包内** chunk 不在 afterPack 判据内，兜它的是 `scripts/verify-profile-boot.mjs`（`yarn check` 内、真组合树 boot，缺 chunk 会抛）与 `e2e:client`（只在 Linux CI 跑） | 同上注释 + 两条 spine 判据 | 删插件包内 chunk → 冒烟红（`verify:closure` **不是**兜底：它只走 package.json 依赖/peer 图） |
| **复检的内容比较**：注入 `readFile` 返回与判定时不同的字节 ⇒ 必须拒绝删除（与文件系统/inode 复用/时间戳精度无关）；读取次数判据钉"stat 与类型守卫都在读之前" | `tests/document-lock-recovery.spec.ts`（`re-checks content…` / `short-circuits on the stat comparison…` / `never reads a swapped-in symlink…` / `compares the re-read bytes…`） | 去掉内容比较 / 把读提到 stat 之前 / 绕过 `readFile` 接缝 → **任何文件系统**都红；"把 `isFile()` 守卫挪到读之后"只在**复用 inode** 的文件系统（ext4，CI 的形态）上红 |

## 4. 升级注意

- 上游若把 `protocol` 缺省改成 chat-completions，`llm-gateway-protocol-pin.spec.ts` 会红：
  那是"这层 pin 还需要吗"的复核信号，不要顺手删用例。
- 上游若把 messages 适配器改成也发 `Authorization`，本 pin 仍无害（chat-completions 是
  我们网关的兼容路径）。
- 上游若改锁文件格式（非十进制 PID），回收会**保留并上报**而不是误删；届时应把新格式
  解析加进 `document-lock-recovery.ts` 并补用例。
- 上游若改 `withFileLock` 的建锁序列（例如先写 PID 再原子改名），年龄门槛可以放宽，
  但**不要**在没有新证据的情况下去掉它。
