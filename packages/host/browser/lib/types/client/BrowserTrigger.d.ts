import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/**
 * Sidebar foot action waking the dedicated browser window. The browser lives
 * in its own OS window (created on first agent open); the sidebar button
 * shows it again after a user close. The window itself carries the tab strip
 * and control buttons; no modal panel is rendered in the main window.
 * @param props - sidebar column state from the foot slot owner.
 */
export declare function BrowserTrigger(props: PropsRuntime<'sidebar.footer.action'>): import("react").JSX.Element;
