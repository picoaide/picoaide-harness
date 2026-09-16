# 无限画板 · 前端一期（canvas-grok）

数据走宿主 API（`/memory-evolve/api/canvas` + rev 乐观锁；2026-08-14 起「只走后端」，本目录里已无前端降级读盘路径）。主会话负责把本目录接到 `src/client/index.ts` 并构建 `lib/client.js`。

## 实现了什么

- 无限画布：拖空白 / 空格+拖 平移；滚轮以指针为中心缩放；卡片标题栏拖拽摆放
- 性能底座：世界层 `translate3d + scale` 合成、视口虚拟化、scale&lt;0.36 LOD 降级为图标、图片用占位渐变（无真实解码）
- 6 类卡片：文件夹 / Markdown / 纯文本 / 图片 / 音视频 / 文件
- 三层归属 + 视角筛选（会话 / 项目 / 全局）+ 卡片归属徽标
- 三种上板：路径（标「未验证」）/ 便签 / 搜索上板（真实本地搜索：本机全部 / 当前项目；2026-08-14 起改为点「搜索」按钮或回车才执行，避免输入即搜误触发）
- 画板内搜索：按标题/类型/路径过滤，命中闪烁并跳转
- 操作：预览（轻量模拟 / 重量占位）、复制 ID·标题·路径·引用串 `[canvas:id] 标题`、移除确认
- AI 投放：中央虚线投放区 +「AI 放置」标记（「跳到最近 AI 便签」按钮已于 2026-08-14 删除，用户反馈无用；lastAiNodeId 字段保留兼容）

## 接入

```ts
import { registerCanvasTab } from './canvas-grok/index.ts'

// 在 apply(ctx) 里：
const disposeCanvas = registerCanvasTab(ctx, { t })
// 插件卸载时调用 disposeCanvas()
```

签名：

```ts
function registerCanvasTab(
  ctx: CanvasTabHost,          // 只需 ctx.slots.inject / register
  opts: { t: Translate },
): () => void                  // disposer
```

槽位：`conversation.view` / `id: canvas-hub` / `order: 80` / `label` 默认取字典键 `canvas.tab.label`（i18n，2026-09-16；此前是模块级 `'画板'` 字面量，切语言不跟随）。

## 已知限制

- 不读真实本地文件，路径一律「未验证」；预览是占位色块/正文
- 模拟搜索是内置 8 条清单，不是 `memory_evolve_search_local_files`
- 不做 de_canvas、流转、分组嵌套、全屏、文件夹内嵌浏览、terminal/web 节点
- 当前会话 / 项目身份写死为演示值，未接 `ConvViewProps` / sessions
- Tab 尚未挂进 `src/client/index.ts`（按规格由主会话接入）

## 文件清单

| 文件 | 职责 |
|---|---|
| `index.ts` | `registerCanvasTab` + 样式注入 |
| `CanvasView.tsx` | Tab 壳：工具条 / 状态 / 持久化 |
| `CanvasBoard.tsx` | 画布引擎：平移缩放 / 虚拟化 |
| `CanvasCard.tsx` | 单卡 + LOD |
| `CanvasDialogs.tsx` | 上板 / 预览 / 移除浮层 |
| `types.ts` | 数据模型 |
| `constants.ts` | 尺寸、LOD、类型字典键（`TYPE_LABEL_KEYS`）、搜索匹配词表 |
| `helpers.ts` | 视角可见性、引用串、几何 |
| `store.ts` | 防抖保存（localStorage 快照写入） |
| `styles.css` | `cg-` 前缀样式 |
