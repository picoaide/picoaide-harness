# 客户端 UI 缺陷排查与修复（2026-09-21）

用户报的现象只有一句：**「能力中心不能往下翻页」**。顺着这一条把四个中列整页面板与其余自研
客户端 UI 过了一遍，下面是实测结论、已修项与仍未修项。

排查方式：真机（打包版 Electron + Xvfb + mock 网关 + CDP）量 DOM 几何与滚动行为，配合三个
只读审计代理分头读代码（应用中心/发布表单/数据面板/AI 面板、定时任务/连接器/面板外壳、
内置浏览器壳层），每条结论都由主控复核后才动手。

---

## 一、P0：四个整页面板全部不能滚动（用户报的那条）

### 现象与实测数据

探针：`temp/ui-scroll-probe.mjs`（打开面板 → 往正文注入 2600px 超高内容 → 量 clientHeight /
scrollHeight / scrollTop / 是否被容器裁掉）。

修复前（打包版实测，四个面板同形）：

| 面板 | 容器高 | 面板根高 | `.pico-scroll` clientHeight | 能滚 |
| --- | --- | --- | --- | --- |
| 定时任务 / 能力中心 / 连接器 / 应用中心 | 813px | **2714px** | 2652px（=内容高） | ❌ scrollTop 无效 |

修复后同一探针：`rootH = 813 = containerH`，`.pico-scroll` clientHeight 694–751，注入超高内容
后 `scrollHeight > clientHeight` 且 `scrollTop` 真的生效，四个面板全部 PASS。

### 根因

高度链断在**面板根包装层**（各插件自己的 div：`.pico-capability` / `.pico-connectors` /
`.pico-app-center` / cron 的 `div[data-dsh-plugin="cron"]`）：

```
[data-dsh-panel-surface]  height:100%   ← 有界（813px）
└─ .pico-capability      height:auto    ← 断点：无高度声明
   └─ PanelPage          height:100%    ← 百分比在"包含块高度 auto"时按 auto 解析 ⇒ 退化成内容高
      └─ .pico-scroll    flex:1;min-height:0;overflow:auto  ← 拿到的是内容高度 ⇒ 永不溢出、永不滚动
```

内容因此一路向下长，被容器（或中列祖先）裁掉 —— 用户看到的就是"翻不到下面"。
`{ height:100% }` 只有在祖先**逐层有界**时才成立，而中间那层是插件自己写的，
2026-09-20 四个面板统一到中列整页时漏掉了它（此前它们是 `position:fixed` 模态，有自己的
max-height，所以看不出问题）。

### 修法（共享样式表，单一权威）

`packages/client/panel-surface/src/client/stylesheet.ts`：

```css
[data-dsh-panel-surface] { display:none; position:relative; overflow:hidden; height:100%; width:100%; min-width:0; }
html[data-dsh-panel-active] [data-dsh-panel-surface] > * { height:100%; min-height:0; }
```

写在共享样式表里而不是四个面板各改一处：面板根由插件提供，`> *` 兜住全部现有面板与任何
未来的第三方面板。容器加 `overflow:hidden` 是配套的 —— 溢出必须由面板自己的滚动区消化，
不许压到侧边栏上。

### 判据

- 单测：`packages/client/panel-surface/tests/panel-surface.spec.tsx`（钉规则下发；jsdom 无排版
  引擎，量不了滚动，这一点在用例注释里写明）。
- **真能力判据**：`scripts/e2e-client.mjs` 的面板循环里新增「面板正文可滚动（内容超出时能翻到
  底）」—— 真机注入超高内容后断言 `scrollHeight > clientHeight` 且 `scrollTop` 生效且不裁切。
  存在性断言与样式表字符串断言都抓不到这条（前者在故障态下同样成立）。

---

## 二、同批修掉的其它真实缺陷

### 面板外壳（`packages/client/panel-surface`）

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| `activate()` 先写激活属性再广播 | 从面板 A 切到 B 时 A 的 `close()` 因"当前激活的不是我"提前返回 ⇒ 不渲染 null、**不派发 `onVisibilityChange(false)`**（靠 MutationObserver 顺带卸载，可见性回调永久失效） | 先广播、后写属性；补单测（回退即红） |
| 入场动画用 `transform` | 运行中的 transform 让容器成为内部 `position:fixed` 遮罩的包含块，又被 `overflow:hidden` 裁切 ⇒ 打开面板后 180ms 内开编辑器，遮罩只铺面板区域 | 动画改成只动 `opacity` |

### 能力中心（`packages/host/enterprise/src/client/CapabilityCenterPanel.tsx`）

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| 面板自己注册 document 级 Esc（且弹层也注册） | 详情弹层里按 Esc **把整个面板关掉**（同一 target 上的监听器不受 `stopPropagation` 影响，面板的注册更早）；实测复现：`dialogClosed=true / panelActive=null` | 删掉面板那段，Esc 唯一权威 = 装载器（检测到 `[role=dialog][aria-modal=true]` 时让位）+ 弹层自己的处理 |
| 死代码：Tab 焦点陷阱（`panelRef` 从未挂到元素） | 声称有陷阱、实际没有；整页面板也不该把 Tab 圈死 | 删除并在注释里说明 |
| 动作结果条/覆盖确认条渲染在滚动区顶部 | 列表滚到下方时点「安装/上传共享」，失败后界面零变化（错误条在视口上方），用户以为按钮坏了 | 结果条出现即 `scrollIntoView({block:'nearest'})` |
| 一个动作在飞时其它卡片按钮可点但被静默吞掉 | 慢安装期间表现为"死按钮"（无禁用、无提示） | 全局 `inFlight` 参与 `disabled` |
| 弹层 `aria-modal=true` 却无焦点约束、关闭不回填焦点 | Tab 走到遮罩后的侧边栏控件（焦点环不可见、回车可激活）；关闭后焦点掉到 body | 弹层内 Tab 环 + 关闭时把焦点还给打开它的按钮 |

### 应用中心 / 发布表单 / 数据面板（`packages/client/wasm-apps/src/client/`）

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| 面板自己再注册一份 document Esc | 搜索框里按 Esc（本意清空）关掉整个面板；发布表单填一半/上传中按 Esc 表单与已选文件全丢、无二次确认 | 删除该 effect（Esc 归装载器） |
| 提交前查重窗口内按钮不置灰 | 双击 = 两次 32MiB 上传 + 两次 publish；后到的 409 把已成功的界面改写"名称已被占用"；取消只 abort 最后一次 | 重入闸 + `busy`/`abortRef` 提到查重之前（查重期间取消也能取消整条链路） |
| file input 不清 value | 选了超限/读取失败的文件后重选**同一个**文件，浏览器不再派发 change ⇒ 毫无反应 | 处理完 `input.value = ''` |
| 其它卡片动作在飞时按钮仍可点 | 同能力中心 | `inFlight` 参与 disabled |
| 确认块 `role=group`、无 Esc、焦点不回填 | 键盘用户没有"取消确认"的路（Esc 直接关面板）、取消后焦点掉到 body | `role=alertdialog aria-modal=true` + 自己接 Esc 取消 + 焦点还给触发按钮（补两条 jsdom 用例，双向变异均红） |
| 诊断/版本历史迟到响应回写 | 点开→立刻收起→几百毫秒后面板自己又冒出来 | 每资源序号，只有最后一次请求的结论可落地 |
| 登录后自动继续打开失败完全静默 | 提示消失、窗不开、什么都不说 | 复用错误块信封渲染 |
| pending-open 轮询不校验 TTL | 过期仍每 5s 永久轮询、>5 分钟后登录仍自动开窗（与 `open-intent.ts` 冻结的 5 分钟不符） | 轮询内按 `OPEN_INTENT_TTL_MS` 判过期即清 |
| AI 面板身份未就绪时「允许」静默 no-op | 授权按 用户×应用 记，userId 为空串时读写都早退 ⇒ 点了没反应、说明卡不动 | 置灰 + 「正在确认登录身份」说明（身份到达后自动可用） |
| 表头分隔线硬编码 `rgba(127,127,127,.35)` | 暗色下与其它分隔线不一致（`check-theme-tokens` 只查 `var()`，抓不到） | 改 `var(--dsw-alias-border-l2)` |

### 定时任务（`packages/host/cron/src/client/`）

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| JobEditor 缺 `aria-modal` | 编辑器里按 Esc 连整个面板一起关（草稿全丢）；装载器与拖拽区让位规则都不命中 | 加 `aria-modal=true` + 编辑态 `aria-label` 用「编辑任务」 |
| 客户端只判 cron 语法，宿主还要求"有可达的下次触发" | `0 0 30 2 *` 过校验 → 保存后弹窗已关、任务没建、只在列表顶部留一句 `cron action failed: 400` | 与宿主同口径（`nextRunAtMs` 必须有值）+ 专用文案 |
| 传输层只用状态码造错误串 | 宿主回的 `{error,hint}`（调度已停用／权限名未知／写面证明失败）全丢，界面只有 `cron action failed: 400` | 解析失败信封，拼 error + hint |
| 设置卡三个开关是无名复选框；未 ready 时按默认值渲染且可点 | 读屏念"未命名复选框"；慢启动瞬间拨动写的是"默认值语义"的结果 | `id`/`htmlFor` 关联 + 未 ready 禁用并显示"正在读取" |
| `scope.set()` 的 promise 被 `void` 掉 | 保存失败静默弹回旧值 + 一条未处理 rejection | 捕获并在卡内显示失败原因（注入面加 `getError`） |
| 卡片底部五个动作不折行 | 窄列（268px 网格 / 右侧栏）把"删除"挤出卡片右侧，要横向滚动 | `flexWrap:'wrap'` |

> **为什么这条 E2E 一直没抓到（2026-09-21 用户补图后定位）**：定时任务**不在 mock 网关的目录
> 数据里** —— 它住在本机 Host 账本 `$DSH_HOME/cron/ledger.json`，而 E2E/探针每次都用全新
> HOME ⇒ 面板永远空态、卡片根本没渲染过，动作行的布局自然零覆盖。现已两头补齐：
> `scripts/e2e-client.mjs` 在启动前种 5 条任务进本机账本，并新增「定时任务卡片动作行不溢出
> 卡片（900px 窄窗）」判据（量每个按钮与所属卡片的边界，`outside` 必须为空）；
> `temp/ui-scroll-probe.mjs` 扫 1280/1000/900/800/720/640 六档宽度，并带**阴性对照**
> （运行时把动作行改回 `nowrap` ⇒ 5 个「删除」全部被判为越界、`hOverflow=true`），
> 证明这条判据在故障态下确实会红。
| 字段标签是裸 `<span>` | 六个输入框在读屏里全无名 | `<label htmlFor>` + `id`；另加初始焦点与 Tab 环 |
| 中文文案 `执行内容编辑后不可修改` 语义不通 | 用户读不懂为何不能改 | 改「任务创建后不可修改」 |

### 连接器（`packages/host/connectors/src/client/ConnectorsSection.tsx`）

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| 预填 effect 依赖每 2 秒轮询新产生的数组引用 | 用户清空服务端预填的默认值后，2 秒内它自己回来，无法提交留空表单 | 按"一轮连接只预填一次"（字段指纹去重），离开 connecting 即忘记 |

### 内置浏览器壳层（`packages/host/browser`，独立泳道）

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| 蒙版下 Enter/空格被文档级吞掉当「我来操作」 | AI 操作中按空格（想翻页）⇒ 不翻页、当前工具调用被 `window-controlled` 中止、控制权静默转移 | 只有焦点**真的在**可见的 `#pill-take` 上才响应（键盘可达性不退化：Tab 首站仍是它） |
| 空态文案指向 ＋，而空闲态蒙版铺满整窗且 inert | 首次使用点 ＋ 毫无反应 = 死路 | 文案改指「我来操作」（不动蒙版形状/控制权语义） |
| 活动面板 bounds 从 y=0 起 | 面板盖住工具栏右侧的 ＋（新建标签）与 ⋮（更多），必须先关面板 | 面板从工具条下沿（66px）开始 |
| Ctrl+L 要按两次 | 第一次只把原生焦点还给 shell 文档（`activeElement` 仍是 body） | 宿主在 `focusPage()` 同一闸门内补发 `focus-addr` 信号，shell 页据此把光标放进地址栏 |
| 中文界面显示英文原文与裸工具 id | 活动面板出现 `browser_window_open …`；`navigate: …` 等 summary 恒英文 | 补三个工具标签、兜底改通用文案、四类 summary 走 `hostCopy`（按调用求值，无模块级冻结） |
| 标签条不可键盘操作、每次刷新整表重建 | 键盘只能靠 Ctrl+Tab/Ctrl+W；刷新一次焦点就掉回 body | 标签 `role=tab` + `tabindex` + Enter/空格；关闭键改真 `<button>` 且 `:focus-visible` 可见；`renderTabs()` 加内容签名短路 |
| 胶囊态 overlay 只有 172×34，失败 toast 被裁 | 交还控制权失败（403/503/网络）时零提示 | 有提示时临时放大 overlay 矩形（同锚点，仍走唯一 `applyOverlay()`），四条归还路径 + 6s 兜底 |

---

## 三、仍未修（已确认，按优先级）

1. **`login.logo_url_dark` 客户端全链路无人消费**：`channel-content.ts` 会产出、
   `auth-gate.ts` 的契约里也有 `logoDarkURL`，但登录页与侧边栏只读 `logo_url` ⇒ 渠道配了暗色
   logo 在客户端不生效（服务端门户已用 `<picture><source media="(prefers-color-scheme:dark)">`
   实现了同款二选一，两端不一致）。修法：登录页按 `prefers-color-scheme`、客户端按
   `body[data-ds-dark-theme]` 二选一。
2. **能力中心 30s 市场轮询整批覆盖本地行**：只对 `loadAll` 有序号守卫，安装完成前后落地的旧
   响应可让卡片短暂退回「安装」态（≤30s 自愈）。
3. **连接器预填修复缺组件级判据**：该包没有 jsdom 组件测试基建，本次只在产品代码侧修，回归
   需要后续补 harness。
4. **内置浏览器壳层的认账残留**（有意划界，非漏项）：`focus-addr` 目前"用户持控制权时任何一次
   回到 capsule"都会发（点面板/查看器/菜单关闭也算；要精确区分 Ctrl+L 需改 `index.ts` 的按键
   路由）；click/type/eval 等其余 op summary 仍是英文；真机观感复验（toast 矩形、胶囊放大）
   未做。
5. **能力中心详情弹层的"版本安装"结果只在弹层外可见**：`detail` 是打开时的快照，弹层自身只
   有 busy 布尔；成功/失败横幅在遮罩后的滚动区。属于信息架构问题，未动。


---

## 四、验证结果（本次实跑）

| 验证 | 结果 |
| --- | --- |
| `corepack yarn check`（整仓 28 个任务：build + typecheck + test + 9 个根守卫） | **28/28 通过**（日志 `temp/check-2026-09-21-ui.log`） |
| 真机探针 `temp/ui-scroll-probe.mjs`（打包版 + Xvfb + mock 网关 + CDP） | 四面板滚动 PASS；能力中心弹层 Esc PASS（`dialogClosed=true / panelActive=capability`）；720×560 窄窗无横向溢出、返回按钮可见 |
| 客户端 E2E `corepack yarn workspace dsh-plugin-desktop e2e:client` | **全部通过**，含新增的「面板正文可滚动（内容超出时能翻到底）」×3 与既有 25 项（日志 `temp/e2e-2026-09-21.log`） |
| 变异验证 | panel-surface 的可见性回调用例、app-center 的 Esc/确认块两条用例、browser 壳层 20 条 —— 均实测"改回旧实现即红、还原即绿" |
| 根守卫 | `check-no-real-domains` / `check-no-leftover-mutants` / `check-theme-tokens` 零命中 |

## 五、复现与验证入口

```bash
# 1) 真机滚动/Esc/窄窗探针（打包版 + Xvfb + mock 网关）
Xvfb :99 -screen 0 1440x900x24 &
DISPLAY=:99 node temp/ui-scroll-probe.mjs --port 9232

# 2) 客户端 E2E（含新增的"面板正文可滚动"能力断言）
corepack yarn workspace dsh-plugin-desktop e2e:client

# 3) 包级门禁
corepack yarn workspace @picoaide/dsh-panel-surface test
corepack yarn workspace @picoaide/dsh-cron test
corepack yarn workspace @picoaide/dsh-connectors test
corepack yarn workspace @picoaide/dsh-enterprise test
```

打包踩坑（值得记）：`electron-builder --dir` 在**工作区里存在悬空符号链接**时会报
`ENOENT: … stat '/tmp/scoped_dirXXXX/SingletonSocket'`（指向随机路径、完全指不到病根）。
这些悬空链接来自"把 Electron 的 HOME/XDG 重定向到仓库内的临时目录"的 e2e/探针运行
（Chromium 在 userData 里留 `SingletonSocket` 软链，`/tmp` 一被清理就成了悬空）。
判据：`find packages -xtype l -not -path "*/node_modules/*"` 必须为空。
