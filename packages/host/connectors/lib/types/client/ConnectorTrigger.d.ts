import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/**
 * Sidebar foot action opening the connector center modal, stacked above the
 * Skill center and Settings triggers (registered into `sidebar.footer.action`).
 * Opening this panel evicts sibling panels via the shared activation event;
 * a sibling activation closes this panel.
 * @param props - sidebar column state from the foot slot owner.
 */
export declare function ConnectorTrigger(props: PropsRuntime<'sidebar.footer.action'>): import("react").JSX.Element;
