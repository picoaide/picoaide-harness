/**
 * Type convergence for the advanced desktop frame.
 *
 * rc.2's `ui-layout` owns the root slot vocabulary (`sidebar` / `main` /
 * `rightbar` / `shell.overlay`), the `ctx.layout` contract, and the
 * `usePanelInfo` root standard source. The advanced profile keeps that row
 * disabled and this shell is the registrant, so the declarations are imported
 * rather than restated: a second `SlotMap` or `Context.layout` declaration
 * either collides with upstream (TS2717 wherever `skipLibCheck` is off) or
 * silently drifts from the contract the shipped client plugins register
 * against — the 0.1.2 → 0.1.5 rename (`conversation` → `main`, `details` →
 * `rightbar`) is exactly that drift, and it fails at runtime with no error.
 */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
