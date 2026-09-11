# 决策：渠道深链 scheme 的注入链（浏览器 SSO 回调）

- 日期：2026-09-11
- 状态：已实施（master）
- 相关：`docs/planning/2026-09-10-channel-package-reference.md` §5.1；
  `packages/host/desktop/src/electron-runtime.ts`、`main.ts`、`profile.ts`；
  `packages/host/enterprise/src/deep-link.ts`、`session-service.ts`

## 问题

渠道客户端（如 moka，scheme `mokahr-harness`）的**浏览器 SSO/OIDC 回调登录完全
不可用**：回调链接在桌面壳的严格闸门处被当成畸形链接丢掉，日志只有一行 warning。

真机复现（假渠道 `probe`，scheme `probeharness`，Xvfb + 独立 HOME，第二实例转发
深链）：

```
dsh-plugin-desktop: ignoring malformed deep link: probeharness://auth?token=****&server=https://example.com&user=probe
```

两个独立缺陷（缺一个都走不通）：

1. **桌面壳漏传 scheme**：`electron-runtime.ts` 的 `receiveDeepLink()` 调
   `parseDesktopDeepLink(url)` 没给第二个参数 → 用模块缺省 `picoaide`；
   `main.ts` 里明明已经算出了正确的 `DEEP_LINK_SCHEME`。渠道回调在闸门就被丢弃。
2. **企业插件读不到随包渠道内容**：`enterprise/src/deep-link.ts` 自己
   `readDesktopChannelProfile()`，而 `desktop-channel.ts` 的
   `new URL('../build/channel.json', import.meta.url)` 是相对**模块自身位置**算的。
   该模块被 tsdown **内联**进 enterprise 的 lib，路径变成
   `@picoaide/dsh-enterprise/build/channel.json` —— 打包产物里不存在（asar 里只有
   应用根的 `/build/`），于是永远 undefined → 回落官方 scheme，回调即使过了闸门
   也会被监听器丢掉。

根因是同一句话：**随包 `channel.json` 只有桌面包自己读得到**（它在应用根），
任何被内联到别的包里的副本都会指错路径，而失败方式是静默回落。

## 决策

1. **桌面壳是唯一真源、显式注入**：
   - `ElectronDesktopRuntime` 构造时接收 `deepLinkScheme`（第 4 个参数，
     `main.ts` 传 `DEEP_LINK_SCHEME`），`receiveDeepLink()` 用它做严格校验；
   - 企业插件不再读任何随包文件：`installDeepLinkListener(..., scheme)` 的 scheme
     由 `picoaide-session` 行的 config 提供，`profile.ts` 的
     `channelProfilePatches()` 在**组装期**注入（沿用品牌/默认域名/连接器名的既有
     注入模式）。
2. **跨包渠道内容的通用规则（写进文档）**：企业插件不得调用
   `readDesktopChannelProfile()`；需要渠道内容一律由桌面壳经行 config 注入。
   enterprise 里现在只 import desktop-channel 的**常量**（`DEFAULT_DEEP_LINK_SCHEME`），
   常量内联是安全的。
3. 缺省行为不变：没有渠道包时注入 `picoaide`，与 electron-builder 的 `protocols`
   和官方构建逐字节一致。

## 验证

- 单测：`tests/electron-runtime.spec.ts`（注入渠道 scheme 时深链通过、缺省时拒绝）、
  `tests/channel-profile-patches.spec.ts`（`picoaide-session` 行拿到
  `deepLinkScheme`，无配置时回落 `picoaide`）、
  `tests/deep-link-listener.spec.ts`（注入的渠道 scheme 被接受；不注入时同一链接
  被拒）—— desktop 45 / enterprise 19 全绿。
- 真机（同一探针，修复后）：

  ```
  [W] [session-service] pico-deep-link: token rejected by "https://example.com/": net::ERR_FAILED
  ```

  说明链接已过闸门、到达企业监听器、并进入 token 预验证环节（示例域名不可达而拒绝）
  —— 整条 SSO 回调链打通；修复前连第一步都进不去。
- 提示：桌面应用把 `ctx.logger` 的 warn 写进 `<userData>/logs/dsh-*.log`，只 grep
  stderr 会漏（本次排查踩过）。
