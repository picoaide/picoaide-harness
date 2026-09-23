/**
 * 客户端入口：中列整页切换的装载器 + 四个面板共用的视觉语言。
 *
 * 消费方（定时任务 / 能力中心 / 连接器 / 应用中心）在 **client bundle** 里 import
 * 本入口即可 —— 它会被内联进各自的产物（不进 tsdown 的 `external`），React 仍由
 * 平台模块表提供。
 *
 * @module @picoaide/dsh-panel-surface/client
 */

export {
  PANEL_ACTIVATE_EVENT,
  PANEL_ACTIVE_ATTR,
  PANEL_SURFACE_ATTR,
  activePanelId,
  findCenterColumn,
  isPanelActive,
  isSidebarRowTarget,
  type PanelId,
} from '../index.ts'

export {
  hasInnerModal,
  mountPanelSurface,
  type PanelSurfaceApi,
  type PanelSurfaceHandle,
  type PanelSurfaceOptions,
} from './surface.tsx'

export {
  Card,
  Chip,
  EmptyState,
  IconTile,
  PANEL_GRID,
  PANEL_SEARCH,
  PANEL_TOOLBAR,
  PanelButton,
  PanelPage,
  PanelStats,
  SectionHeader,
  SegmentedControl,
  TONE_COLOR,
  type CardProps,
  type ChipProps,
  type EmptyStateProps,
  type PanelButtonProps,
  type PanelButtonSize,
  type PanelButtonVariant,
  type PanelPageProps,
  type PanelStatsProps,
  type PanelTone,
  type SectionHeaderProps,
  type SegmentedControlOption,
  type SegmentedControlProps,
} from './ui.tsx'

export * as icons from './icons.tsx'
