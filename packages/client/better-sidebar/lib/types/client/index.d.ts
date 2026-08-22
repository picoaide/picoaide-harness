import type { Context } from '../context-types.ts';
import './layout.css';
/** Services required before mounting (provided by the client runtime; the
 *  locale service backs the sidebar's copy — see locales.ts). `modules` is
 *  read OPTIONALLY via ctx.get (it is provided by dsh-client-modules in the
 *  official DSH shell; a third-party host may not have it — the lazy chunk
 *  loader then falls back to its window-global probe). */
export declare const inject: string[];
/**
 * Error boundary over the sidebar tree (root scope): a render error in the
 * sidebar SHELL itself must never blank the page silently — the shared
 * RenderBoundary shows a dismissible error strip and logs the stack. The
 * per-tab scope (Sidebar.tsx) catches viewer/editor crashes first; this root
 * boundary stays as the last resort for Workbench/shell errors.
 */
/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions).
 */
export declare function apply(ctx: Context): void;
