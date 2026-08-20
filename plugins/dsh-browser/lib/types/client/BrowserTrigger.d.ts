import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/**
 * Sidebar foot action opening the embedded browser modal. Opening this panel
 * evicts sibling panels via the shared activation event; a sibling activation
 * closes this panel.
 * @param props - sidebar column state from the foot slot owner.
 */
export declare function BrowserTrigger(props: PropsRuntime<'sidebar.footer.action'>): import("react").JSX.Element;
