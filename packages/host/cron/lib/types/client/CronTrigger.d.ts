/**
 * Sidebar foot action opening the scheduled-job center in the main area
 * (registered into `sidebar.footer.action`, ordered before the connector
 * center). Global: root scope, no session dependency.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** The html attribute this panel toggles (sibling panels remove it). */
export declare const CRON_ACTIVE_ATTR = "data-dsh-cron-active";
/**
 * Sidebar foot trigger for the scheduled-job center.
 * @param props - sidebar column state from the foot slot owner.
 */
export declare function CronTrigger(props: PropsRuntime<'sidebar.footer.action'>): JSX.Element;
