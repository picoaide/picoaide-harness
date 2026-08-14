import {
  BrandWordmark, FishLogo, IconNewChatOutline16, IconPanelLeftOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from './contracts.ts'
import type { DesktopClientPlatform } from './environment.ts'

/** Private callbacks assembled by the advanced sidebar registration. */
export interface AdvancedSidebarInjected {
  /** Start or focus a blank session using the upstream workspace service. */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the desktop layout rail. */
  toggleSidebar: () => void
  /** Native platform controlling traffic-light/titlebar spacing. */
  platform: DesktopClientPlatform
}

/** Full advanced sidebar slot props. */
export type AdvancedSidebarProps = PropsRuntime<'sidebar'>
  & PropsRenderSlots<'sidebar.workspaces' | 'sidebar.settings' | 'sidebar.footer.action'>
  & PropsLocale<'desktop.sidebar'>
  & AdvancedSidebarInjected

/** Glass-backed sidebar chrome that preserves all upstream child slots. */
export function AdvancedSidebar({
  collapsed, startSession, toggleSidebar, platform, t, renderSlot,
}: AdvancedSidebarProps) {
  const wide = !collapsed
  return (
    <div className="dshDesktopSidebar" data-desktop-platform={platform} data-wide={wide || undefined}>
      <div className="dshDesktopLogoRow">
        {wide && (
          <button className="dshDesktopBrand dshDesktopNoDrag" type="button" onClick={() => { startSession() }} aria-label={t('session.new.label')}>
            <BrandWordmark />
          </button>
        )}
        <Tooltip label={wide ? t('toggle.collapse') : t('toggle.open')} delayMs={500}>
          <button className="dshDesktopIconButton dshDesktopNoDrag" type="button" onClick={toggleSidebar} aria-label={wide ? t('toggle.collapse') : t('toggle.open')}>
            {!wide && <FishLogo size={24} />}
            {wide && <IconPanelLeftOutline16 size={16} />}
          </button>
        </Tooltip>
      </div>
      <Tooltip label={t('session.new.label')} delayMs={500} disabled={wide}>
        <button className="dshDesktopNewSession dshDesktopNoDrag" type="button" onClick={() => { startSession() }} aria-label={t('session.new.label')}>
          <IconNewChatOutline16 size={wide ? 14 : 18} />
          {wide && <span>{t('session.new')}</span>}
        </button>
      </Tooltip>
      <div className="dshDesktopWorkspaceRegion">
        {renderSlot('sidebar.workspaces', {
          wide,
          expandSidebar: () => { if (!wide) toggleSidebar() },
        })}
      </div>
      <div className="dshDesktopSidebarFooter">
        <div>{renderSlot('sidebar.footer.action', { wide })}</div>
        <div>{renderSlot('sidebar.settings', { wide })}</div>
      </div>
    </div>
  )
}
