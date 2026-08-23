//#region src/invariant.ts
const PACKAGE_NAME = "@picoaide/dsh-browser";
/** Cordis companion plugin name. */
const name = "pico-browser-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the embedded browser owns its view hierarchy and CDP
* sessions inside the plugin fiber, and registers ordinary Cordis tools
* (conflicting registrations already fail loud at load); it emits no
* cross-plugin mutable relation an invariant could check.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };

//# sourceMappingURL=invariant.js.map