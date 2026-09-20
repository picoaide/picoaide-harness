import { ConnectorsList } from './ConnectorsSection.tsx'
import { PanelPage, icons } from '@picoaide/dsh-panel-surface/client'
import { t } from './locales.ts'

/**
 * 连接器中心：已注册的连接器 + 各自的授权流程（宿主路由负责真正的 OAuth /
 * 设备码 / 令牌表单交互，客户端这一半只渲染列表与流程状态）。
 *
 * 2026-09-20 起它是**中列整页**（此前是 `position:fixed` 模态浮层）—— 与定时任务、
 * 能力中心、应用中心同一套切换语义；外壳（返回出口 / 标题 / 滚动）走共享
 * `PanelPage`，焦点陷阱与 Esc 处理都由装载器负责。
 * @param props.onClose - 返回会话区。
 */
export function ConnectorPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="pico-connectors" data-role="connectors-page">
      <PanelPage
        icon={<icons.IconPlug size={16} />}
        title={t('panel.title')}
        subtitle={t('panel.subtitle')}
        backLabel={t('panel.backToChat')}
        onClose={onClose}
        width={1180}
      >
        <ConnectorsList />
      </PanelPage>
    </div>
  )
}
