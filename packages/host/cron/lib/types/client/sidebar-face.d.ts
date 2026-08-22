/**
 * Local structural face of the dsh-better-sidebar tab service.
 *
 * Spelled here with the same shape as the real package (which registers
 * `ctx.betterSidebar` at runtime) so this package can consume the service
 * without depending on the sidebar package — the task-board family precedent
 * for sibling slots/services. The runtime identity is the cordis service
 * name 'betterSidebar'; consumers reach it via `ctx.get('betterSidebar')`.
 * Only the members this plugin uses are declared.
 */
/** A tab registration descriptor (subset of the real TabDescriptor). */
export interface BetterSidebarTabDescriptor {
    /** Stable tab-type id, namespaced (e.g. 'pico:cron'). */
    id: string;
    /** Tab title (locale-resolved at render time). */
    title: () => string;
    /** Sort order in the "+" menu (lower first). */
    order?: number;
    /** The tab body component (session scoped by the sidebar). */
    component: (props: {
        scope: {
            sessionId: string;
        };
    }) => unknown;
}
/** The service face this plugin consumes. */
export interface BetterSidebarService {
    registerTab(descriptor: BetterSidebarTabDescriptor): () => void;
}
