window.__ModuleLoader__.load({
	id: "@picoaide/dsh-connectors",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
		//#endregion
		//#region node_modules/react/cjs/react.production.min.js
		/**
		* @license React
		* react.production.min.js
		*
		* Copyright (c) Facebook, Inc. and its affiliates.
		*
		* This source code is licensed under the MIT license found in the
		* LICENSE file in the root directory of this source tree.
		*/
		var require_react_production_min = /* @__PURE__ */ __commonJSMin(((exports) => {
			var l = Symbol.for("react.element");
			var n = Symbol.for("react.portal");
			var p = Symbol.for("react.fragment");
			var q = Symbol.for("react.strict_mode");
			var r = Symbol.for("react.profiler");
			var t = Symbol.for("react.provider");
			var u = Symbol.for("react.context");
			var v = Symbol.for("react.forward_ref");
			var w = Symbol.for("react.suspense");
			var x = Symbol.for("react.memo");
			var y = Symbol.for("react.lazy");
			var z = Symbol.iterator;
			function A(a) {
				if (null === a || "object" !== typeof a) return null;
				a = z && a[z] || a["@@iterator"];
				return "function" === typeof a ? a : null;
			}
			var B = {
				isMounted: function() {
					return !1;
				},
				enqueueForceUpdate: function() {},
				enqueueReplaceState: function() {},
				enqueueSetState: function() {}
			};
			var C = Object.assign;
			var D = {};
			function E(a, b, e) {
				this.props = a;
				this.context = b;
				this.refs = D;
				this.updater = e || B;
			}
			E.prototype.isReactComponent = {};
			E.prototype.setState = function(a, b) {
				if ("object" !== typeof a && "function" !== typeof a && null != a) throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");
				this.updater.enqueueSetState(this, a, b, "setState");
			};
			E.prototype.forceUpdate = function(a) {
				this.updater.enqueueForceUpdate(this, a, "forceUpdate");
			};
			function F() {}
			F.prototype = E.prototype;
			function G(a, b, e) {
				this.props = a;
				this.context = b;
				this.refs = D;
				this.updater = e || B;
			}
			var H = G.prototype = new F();
			H.constructor = G;
			C(H, E.prototype);
			H.isPureReactComponent = !0;
			var I = Array.isArray;
			var J = Object.prototype.hasOwnProperty;
			var K = { current: null };
			var L = {
				key: !0,
				ref: !0,
				__self: !0,
				__source: !0
			};
			function M(a, b, e) {
				var d, c = {}, k = null, h = null;
				if (null != b) for (d in void 0 !== b.ref && (h = b.ref), void 0 !== b.key && (k = "" + b.key), b) J.call(b, d) && !L.hasOwnProperty(d) && (c[d] = b[d]);
				var g = arguments.length - 2;
				if (1 === g) c.children = e;
				else if (1 < g) {
					for (var f = Array(g), m = 0; m < g; m++) f[m] = arguments[m + 2];
					c.children = f;
				}
				if (a && a.defaultProps) for (d in g = a.defaultProps, g) void 0 === c[d] && (c[d] = g[d]);
				return {
					$$typeof: l,
					type: a,
					key: k,
					ref: h,
					props: c,
					_owner: K.current
				};
			}
			function N(a, b) {
				return {
					$$typeof: l,
					type: a.type,
					key: b,
					ref: a.ref,
					props: a.props,
					_owner: a._owner
				};
			}
			function O(a) {
				return "object" === typeof a && null !== a && a.$$typeof === l;
			}
			function escape(a) {
				var b = {
					"=": "=0",
					":": "=2"
				};
				return "$" + a.replace(/[=:]/g, function(a) {
					return b[a];
				});
			}
			var P = /\/+/g;
			function Q(a, b) {
				return "object" === typeof a && null !== a && null != a.key ? escape("" + a.key) : b.toString(36);
			}
			function R(a, b, e, d, c) {
				var k = typeof a;
				if ("undefined" === k || "boolean" === k) a = null;
				var h = !1;
				if (null === a) h = !0;
				else switch (k) {
					case "string":
					case "number":
						h = !0;
						break;
					case "object": switch (a.$$typeof) {
						case l:
						case n: h = !0;
					}
				}
				if (h) return h = a, c = c(h), a = "" === d ? "." + Q(h, 0) : d, I(c) ? (e = "", null != a && (e = a.replace(P, "$&/") + "/"), R(c, b, e, "", function(a) {
					return a;
				})) : null != c && (O(c) && (c = N(c, e + (!c.key || h && h.key === c.key ? "" : ("" + c.key).replace(P, "$&/") + "/") + a)), b.push(c)), 1;
				h = 0;
				d = "" === d ? "." : d + ":";
				if (I(a)) for (var g = 0; g < a.length; g++) {
					k = a[g];
					var f = d + Q(k, g);
					h += R(k, b, e, f, c);
				}
				else if (f = A(a), "function" === typeof f) for (a = f.call(a), g = 0; !(k = a.next()).done;) k = k.value, f = d + Q(k, g++), h += R(k, b, e, f, c);
				else if ("object" === k) throw b = String(a), Error("Objects are not valid as a React child (found: " + ("[object Object]" === b ? "object with keys {" + Object.keys(a).join(", ") + "}" : b) + "). If you meant to render a collection of children, use an array instead.");
				return h;
			}
			function S(a, b, e) {
				if (null == a) return a;
				var d = [], c = 0;
				R(a, d, "", "", function(a) {
					return b.call(e, a, c++);
				});
				return d;
			}
			function T(a) {
				if (-1 === a._status) {
					var b = a._result;
					b = b();
					b.then(function(b) {
						if (0 === a._status || -1 === a._status) a._status = 1, a._result = b;
					}, function(b) {
						if (0 === a._status || -1 === a._status) a._status = 2, a._result = b;
					});
					-1 === a._status && (a._status = 0, a._result = b);
				}
				if (1 === a._status) return a._result.default;
				throw a._result;
			}
			var U = { current: null };
			var V = { transition: null };
			var W = {
				ReactCurrentDispatcher: U,
				ReactCurrentBatchConfig: V,
				ReactCurrentOwner: K
			};
			function X() {
				throw Error("act(...) is not supported in production builds of React.");
			}
			exports.Children = {
				map: S,
				forEach: function(a, b, e) {
					S(a, function() {
						b.apply(this, arguments);
					}, e);
				},
				count: function(a) {
					var b = 0;
					S(a, function() {
						b++;
					});
					return b;
				},
				toArray: function(a) {
					return S(a, function(a) {
						return a;
					}) || [];
				},
				only: function(a) {
					if (!O(a)) throw Error("React.Children.only expected to receive a single React element child.");
					return a;
				}
			};
			exports.Component = E;
			exports.Fragment = p;
			exports.Profiler = r;
			exports.PureComponent = G;
			exports.StrictMode = q;
			exports.Suspense = w;
			exports.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = W;
			exports.act = X;
			exports.cloneElement = function(a, b, e) {
				if (null === a || void 0 === a) throw Error("React.cloneElement(...): The argument must be a React element, but you passed " + a + ".");
				var d = C({}, a.props), c = a.key, k = a.ref, h = a._owner;
				if (null != b) {
					void 0 !== b.ref && (k = b.ref, h = K.current);
					void 0 !== b.key && (c = "" + b.key);
					if (a.type && a.type.defaultProps) var g = a.type.defaultProps;
					for (f in b) J.call(b, f) && !L.hasOwnProperty(f) && (d[f] = void 0 === b[f] && void 0 !== g ? g[f] : b[f]);
				}
				var f = arguments.length - 2;
				if (1 === f) d.children = e;
				else if (1 < f) {
					g = Array(f);
					for (var m = 0; m < f; m++) g[m] = arguments[m + 2];
					d.children = g;
				}
				return {
					$$typeof: l,
					type: a.type,
					key: c,
					ref: k,
					props: d,
					_owner: h
				};
			};
			exports.createContext = function(a) {
				a = {
					$$typeof: u,
					_currentValue: a,
					_currentValue2: a,
					_threadCount: 0,
					Provider: null,
					Consumer: null,
					_defaultValue: null,
					_globalName: null
				};
				a.Provider = {
					$$typeof: t,
					_context: a
				};
				return a.Consumer = a;
			};
			exports.createElement = M;
			exports.createFactory = function(a) {
				var b = M.bind(null, a);
				b.type = a;
				return b;
			};
			exports.createRef = function() {
				return { current: null };
			};
			exports.forwardRef = function(a) {
				return {
					$$typeof: v,
					render: a
				};
			};
			exports.isValidElement = O;
			exports.lazy = function(a) {
				return {
					$$typeof: y,
					_payload: {
						_status: -1,
						_result: a
					},
					_init: T
				};
			};
			exports.memo = function(a, b) {
				return {
					$$typeof: x,
					type: a,
					compare: void 0 === b ? null : b
				};
			};
			exports.startTransition = function(a) {
				var b = V.transition;
				V.transition = {};
				try {
					a();
				} finally {
					V.transition = b;
				}
			};
			exports.unstable_act = X;
			exports.useCallback = function(a, b) {
				return U.current.useCallback(a, b);
			};
			exports.useContext = function(a) {
				return U.current.useContext(a);
			};
			exports.useDebugValue = function() {};
			exports.useDeferredValue = function(a) {
				return U.current.useDeferredValue(a);
			};
			exports.useEffect = function(a, b) {
				return U.current.useEffect(a, b);
			};
			exports.useId = function() {
				return U.current.useId();
			};
			exports.useImperativeHandle = function(a, b, e) {
				return U.current.useImperativeHandle(a, b, e);
			};
			exports.useInsertionEffect = function(a, b) {
				return U.current.useInsertionEffect(a, b);
			};
			exports.useLayoutEffect = function(a, b) {
				return U.current.useLayoutEffect(a, b);
			};
			exports.useMemo = function(a, b) {
				return U.current.useMemo(a, b);
			};
			exports.useReducer = function(a, b, e) {
				return U.current.useReducer(a, b, e);
			};
			exports.useRef = function(a) {
				return U.current.useRef(a);
			};
			exports.useState = function(a) {
				return U.current.useState(a);
			};
			exports.useSyncExternalStore = function(a, b, e) {
				return U.current.useSyncExternalStore(a, b, e);
			};
			exports.useTransition = function() {
				return U.current.useTransition();
			};
			exports.version = "18.3.1";
		}));
		//#endregion
		//#region node_modules/react/cjs/react.development.js
		/**
		* @license React
		* react.development.js
		*
		* Copyright (c) Facebook, Inc. and its affiliates.
		*
		* This source code is licensed under the MIT license found in the
		* LICENSE file in the root directory of this source tree.
		*/
		var require_react_development = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			if (process.env.NODE_ENV !== "production") (function() {
				"use strict";
				if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart === "function") __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(/* @__PURE__ */ new Error());
				var ReactVersion = "18.3.1";
				var REACT_ELEMENT_TYPE = Symbol.for("react.element");
				var REACT_PORTAL_TYPE = Symbol.for("react.portal");
				var REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
				var REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode");
				var REACT_PROFILER_TYPE = Symbol.for("react.profiler");
				var REACT_PROVIDER_TYPE = Symbol.for("react.provider");
				var REACT_CONTEXT_TYPE = Symbol.for("react.context");
				var REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
				var REACT_SUSPENSE_TYPE = Symbol.for("react.suspense");
				var REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list");
				var REACT_MEMO_TYPE = Symbol.for("react.memo");
				var REACT_LAZY_TYPE = Symbol.for("react.lazy");
				var REACT_OFFSCREEN_TYPE = Symbol.for("react.offscreen");
				var MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
				var FAUX_ITERATOR_SYMBOL = "@@iterator";
				function getIteratorFn(maybeIterable) {
					if (maybeIterable === null || typeof maybeIterable !== "object") return null;
					var maybeIterator = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable[FAUX_ITERATOR_SYMBOL];
					if (typeof maybeIterator === "function") return maybeIterator;
					return null;
				}
				/**
				* Keeps track of the current dispatcher.
				*/
				var ReactCurrentDispatcher = { 
				/**
				* @internal
				* @type {ReactComponent}
				*/
current: null };
				/**
				* Keeps track of the current batch's configuration such as how long an update
				* should suspend for if it needs to.
				*/
				var ReactCurrentBatchConfig = { transition: null };
				var ReactCurrentActQueue = {
					current: null,
					isBatchingLegacy: false,
					didScheduleLegacyUpdate: false
				};
				/**
				* Keeps track of the current owner.
				*
				* The current owner is the component who should own any components that are
				* currently being constructed.
				*/
				var ReactCurrentOwner = { 
				/**
				* @internal
				* @type {ReactComponent}
				*/
current: null };
				var ReactDebugCurrentFrame = {};
				var currentExtraStackFrame = null;
				function setExtraStackFrame(stack) {
					currentExtraStackFrame = stack;
				}
				ReactDebugCurrentFrame.setExtraStackFrame = function(stack) {
					currentExtraStackFrame = stack;
				};
				ReactDebugCurrentFrame.getCurrentStack = null;
				ReactDebugCurrentFrame.getStackAddendum = function() {
					var stack = "";
					if (currentExtraStackFrame) stack += currentExtraStackFrame;
					var impl = ReactDebugCurrentFrame.getCurrentStack;
					if (impl) stack += impl() || "";
					return stack;
				};
				var enableScopeAPI = false;
				var enableCacheElement = false;
				var enableTransitionTracing = false;
				var enableLegacyHidden = false;
				var enableDebugTracing = false;
				var ReactSharedInternals = {
					ReactCurrentDispatcher,
					ReactCurrentBatchConfig,
					ReactCurrentOwner
				};
				ReactSharedInternals.ReactDebugCurrentFrame = ReactDebugCurrentFrame;
				ReactSharedInternals.ReactCurrentActQueue = ReactCurrentActQueue;
				function warn(format) {
					for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) args[_key - 1] = arguments[_key];
					printWarning("warn", format, args);
				}
				function error(format) {
					for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) args[_key2 - 1] = arguments[_key2];
					printWarning("error", format, args);
				}
				function printWarning(level, format, args) {
					var stack = ReactSharedInternals.ReactDebugCurrentFrame.getStackAddendum();
					if (stack !== "") {
						format += "%s";
						args = args.concat([stack]);
					}
					var argsWithFormat = args.map(function(item) {
						return String(item);
					});
					argsWithFormat.unshift("Warning: " + format);
					Function.prototype.apply.call(console[level], console, argsWithFormat);
				}
				var didWarnStateUpdateForUnmountedComponent = {};
				function warnNoop(publicInstance, callerName) {
					var _constructor = publicInstance.constructor;
					var componentName = _constructor && (_constructor.displayName || _constructor.name) || "ReactClass";
					var warningKey = componentName + "." + callerName;
					if (didWarnStateUpdateForUnmountedComponent[warningKey]) return;
					error("Can't call %s on a component that is not yet mounted. This is a no-op, but it might indicate a bug in your application. Instead, assign to `this.state` directly or define a `state = {};` class property with the desired state in the %s component.", callerName, componentName);
					didWarnStateUpdateForUnmountedComponent[warningKey] = true;
				}
				/**
				* This is the abstract API for an update queue.
				*/
				var ReactNoopUpdateQueue = {
					/**
					* Checks whether or not this composite component is mounted.
					* @param {ReactClass} publicInstance The instance we want to test.
					* @return {boolean} True if mounted, false otherwise.
					* @protected
					* @final
					*/
					isMounted: function(publicInstance) {
						return false;
					},
					/**
					* Forces an update. This should only be invoked when it is known with
					* certainty that we are **not** in a DOM transaction.
					*
					* You may want to call this when you know that some deeper aspect of the
					* component's state has changed but `setState` was not called.
					*
					* This will not invoke `shouldComponentUpdate`, but it will invoke
					* `componentWillUpdate` and `componentDidUpdate`.
					*
					* @param {ReactClass} publicInstance The instance that should rerender.
					* @param {?function} callback Called after component is updated.
					* @param {?string} callerName name of the calling function in the public API.
					* @internal
					*/
					enqueueForceUpdate: function(publicInstance, callback, callerName) {
						warnNoop(publicInstance, "forceUpdate");
					},
					/**
					* Replaces all of the state. Always use this or `setState` to mutate state.
					* You should treat `this.state` as immutable.
					*
					* There is no guarantee that `this.state` will be immediately updated, so
					* accessing `this.state` after calling this method may return the old value.
					*
					* @param {ReactClass} publicInstance The instance that should rerender.
					* @param {object} completeState Next state.
					* @param {?function} callback Called after component is updated.
					* @param {?string} callerName name of the calling function in the public API.
					* @internal
					*/
					enqueueReplaceState: function(publicInstance, completeState, callback, callerName) {
						warnNoop(publicInstance, "replaceState");
					},
					/**
					* Sets a subset of the state. This only exists because _pendingState is
					* internal. This provides a merging strategy that is not available to deep
					* properties which is confusing. TODO: Expose pendingState or don't use it
					* during the merge.
					*
					* @param {ReactClass} publicInstance The instance that should rerender.
					* @param {object} partialState Next partial state to be merged with state.
					* @param {?function} callback Called after component is updated.
					* @param {?string} Name of the calling function in the public API.
					* @internal
					*/
					enqueueSetState: function(publicInstance, partialState, callback, callerName) {
						warnNoop(publicInstance, "setState");
					}
				};
				var assign = Object.assign;
				var emptyObject = {};
				Object.freeze(emptyObject);
				/**
				* Base class helpers for the updating state of a component.
				*/
				function Component(props, context, updater) {
					this.props = props;
					this.context = context;
					this.refs = emptyObject;
					this.updater = updater || ReactNoopUpdateQueue;
				}
				Component.prototype.isReactComponent = {};
				/**
				* Sets a subset of the state. Always use this to mutate
				* state. You should treat `this.state` as immutable.
				*
				* There is no guarantee that `this.state` will be immediately updated, so
				* accessing `this.state` after calling this method may return the old value.
				*
				* There is no guarantee that calls to `setState` will run synchronously,
				* as they may eventually be batched together.  You can provide an optional
				* callback that will be executed when the call to setState is actually
				* completed.
				*
				* When a function is provided to setState, it will be called at some point in
				* the future (not synchronously). It will be called with the up to date
				* component arguments (state, props, context). These values can be different
				* from this.* because your function may be called after receiveProps but before
				* shouldComponentUpdate, and this new state, props, and context will not yet be
				* assigned to this.
				*
				* @param {object|function} partialState Next partial state or function to
				*        produce next partial state to be merged with current state.
				* @param {?function} callback Called after state is updated.
				* @final
				* @protected
				*/
				Component.prototype.setState = function(partialState, callback) {
					if (typeof partialState !== "object" && typeof partialState !== "function" && partialState != null) throw new Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");
					this.updater.enqueueSetState(this, partialState, callback, "setState");
				};
				/**
				* Forces an update. This should only be invoked when it is known with
				* certainty that we are **not** in a DOM transaction.
				*
				* You may want to call this when you know that some deeper aspect of the
				* component's state has changed but `setState` was not called.
				*
				* This will not invoke `shouldComponentUpdate`, but it will invoke
				* `componentWillUpdate` and `componentDidUpdate`.
				*
				* @param {?function} callback Called after update is complete.
				* @final
				* @protected
				*/
				Component.prototype.forceUpdate = function(callback) {
					this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
				};
				var deprecatedAPIs = {
					isMounted: ["isMounted", "Instead, make sure to clean up subscriptions and pending requests in componentWillUnmount to prevent memory leaks."],
					replaceState: ["replaceState", "Refactor your code to use setState instead (see https://github.com/facebook/react/issues/3236)."]
				};
				var defineDeprecationWarning = function(methodName, info) {
					Object.defineProperty(Component.prototype, methodName, { get: function() {
						warn("%s(...) is deprecated in plain JavaScript React classes. %s", info[0], info[1]);
					} });
				};
				for (var fnName in deprecatedAPIs) if (deprecatedAPIs.hasOwnProperty(fnName)) defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
				function ComponentDummy() {}
				ComponentDummy.prototype = Component.prototype;
				/**
				* Convenience component with default shallow equality check for sCU.
				*/
				function PureComponent(props, context, updater) {
					this.props = props;
					this.context = context;
					this.refs = emptyObject;
					this.updater = updater || ReactNoopUpdateQueue;
				}
				var pureComponentPrototype = PureComponent.prototype = new ComponentDummy();
				pureComponentPrototype.constructor = PureComponent;
				assign(pureComponentPrototype, Component.prototype);
				pureComponentPrototype.isPureReactComponent = true;
				function createRef() {
					var refObject = { current: null };
					Object.seal(refObject);
					return refObject;
				}
				var isArrayImpl = Array.isArray;
				function isArray(a) {
					return isArrayImpl(a);
				}
				function typeName(value) {
					return typeof Symbol === "function" && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
				}
				function willCoercionThrow(value) {
					try {
						testStringCoercion(value);
						return false;
					} catch (e) {
						return true;
					}
				}
				function testStringCoercion(value) {
					return "" + value;
				}
				function checkKeyStringCoercion(value) {
					if (willCoercionThrow(value)) {
						error("The provided key is an unsupported type %s. This value must be coerced to a string before before using it here.", typeName(value));
						return testStringCoercion(value);
					}
				}
				function getWrappedName(outerType, innerType, wrapperName) {
					var displayName = outerType.displayName;
					if (displayName) return displayName;
					var functionName = innerType.displayName || innerType.name || "";
					return functionName !== "" ? wrapperName + "(" + functionName + ")" : wrapperName;
				}
				function getContextName(type) {
					return type.displayName || "Context";
				}
				function getComponentNameFromType(type) {
					if (type == null) return null;
					if (typeof type.tag === "number") error("Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue.");
					if (typeof type === "function") return type.displayName || type.name || null;
					if (typeof type === "string") return type;
					switch (type) {
						case REACT_FRAGMENT_TYPE: return "Fragment";
						case REACT_PORTAL_TYPE: return "Portal";
						case REACT_PROFILER_TYPE: return "Profiler";
						case REACT_STRICT_MODE_TYPE: return "StrictMode";
						case REACT_SUSPENSE_TYPE: return "Suspense";
						case REACT_SUSPENSE_LIST_TYPE: return "SuspenseList";
					}
					if (typeof type === "object") switch (type.$$typeof) {
						case REACT_CONTEXT_TYPE: return getContextName(type) + ".Consumer";
						case REACT_PROVIDER_TYPE: return getContextName(type._context) + ".Provider";
						case REACT_FORWARD_REF_TYPE: return getWrappedName(type, type.render, "ForwardRef");
						case REACT_MEMO_TYPE:
							var outerName = type.displayName || null;
							if (outerName !== null) return outerName;
							return getComponentNameFromType(type.type) || "Memo";
						case REACT_LAZY_TYPE:
							var lazyComponent = type;
							var payload = lazyComponent._payload;
							var init = lazyComponent._init;
							try {
								return getComponentNameFromType(init(payload));
							} catch (x) {
								return null;
							}
					}
					return null;
				}
				var hasOwnProperty = Object.prototype.hasOwnProperty;
				var RESERVED_PROPS = {
					key: true,
					ref: true,
					__self: true,
					__source: true
				};
				var specialPropKeyWarningShown, specialPropRefWarningShown, didWarnAboutStringRefs = {};
				function hasValidRef(config) {
					if (hasOwnProperty.call(config, "ref")) {
						var getter = Object.getOwnPropertyDescriptor(config, "ref").get;
						if (getter && getter.isReactWarning) return false;
					}
					return config.ref !== void 0;
				}
				function hasValidKey(config) {
					if (hasOwnProperty.call(config, "key")) {
						var getter = Object.getOwnPropertyDescriptor(config, "key").get;
						if (getter && getter.isReactWarning) return false;
					}
					return config.key !== void 0;
				}
				function defineKeyPropWarningGetter(props, displayName) {
					var warnAboutAccessingKey = function() {
						if (!specialPropKeyWarningShown) {
							specialPropKeyWarningShown = true;
							error("%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://reactjs.org/link/special-props)", displayName);
						}
					};
					warnAboutAccessingKey.isReactWarning = true;
					Object.defineProperty(props, "key", {
						get: warnAboutAccessingKey,
						configurable: true
					});
				}
				function defineRefPropWarningGetter(props, displayName) {
					var warnAboutAccessingRef = function() {
						if (!specialPropRefWarningShown) {
							specialPropRefWarningShown = true;
							error("%s: `ref` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://reactjs.org/link/special-props)", displayName);
						}
					};
					warnAboutAccessingRef.isReactWarning = true;
					Object.defineProperty(props, "ref", {
						get: warnAboutAccessingRef,
						configurable: true
					});
				}
				function warnIfStringRefCannotBeAutoConverted(config) {
					if (typeof config.ref === "string" && ReactCurrentOwner.current && config.__self && ReactCurrentOwner.current.stateNode !== config.__self) {
						var componentName = getComponentNameFromType(ReactCurrentOwner.current.type);
						if (!didWarnAboutStringRefs[componentName]) {
							error("Component \"%s\" contains the string ref \"%s\". Support for string refs will be removed in a future major release. This case cannot be automatically converted to an arrow function. We ask you to manually fix this case by using useRef() or createRef() instead. Learn more about using refs safely here: https://reactjs.org/link/strict-mode-string-ref", componentName, config.ref);
							didWarnAboutStringRefs[componentName] = true;
						}
					}
				}
				/**
				* Factory method to create a new React element. This no longer adheres to
				* the class pattern, so do not use new to call it. Also, instanceof check
				* will not work. Instead test $$typeof field against Symbol.for('react.element') to check
				* if something is a React Element.
				*
				* @param {*} type
				* @param {*} props
				* @param {*} key
				* @param {string|object} ref
				* @param {*} owner
				* @param {*} self A *temporary* helper to detect places where `this` is
				* different from the `owner` when React.createElement is called, so that we
				* can warn. We want to get rid of owner and replace string `ref`s with arrow
				* functions, and as long as `this` and owner are the same, there will be no
				* change in behavior.
				* @param {*} source An annotation object (added by a transpiler or otherwise)
				* indicating filename, line number, and/or other information.
				* @internal
				*/
				var ReactElement = function(type, key, ref, self, source, owner, props) {
					var element = {
						$$typeof: REACT_ELEMENT_TYPE,
						type,
						key,
						ref,
						props,
						_owner: owner
					};
					element._store = {};
					Object.defineProperty(element._store, "validated", {
						configurable: false,
						enumerable: false,
						writable: true,
						value: false
					});
					Object.defineProperty(element, "_self", {
						configurable: false,
						enumerable: false,
						writable: false,
						value: self
					});
					Object.defineProperty(element, "_source", {
						configurable: false,
						enumerable: false,
						writable: false,
						value: source
					});
					if (Object.freeze) {
						Object.freeze(element.props);
						Object.freeze(element);
					}
					return element;
				};
				/**
				* Create and return a new ReactElement of the given type.
				* See https://reactjs.org/docs/react-api.html#createelement
				*/
				function createElement(type, config, children) {
					var propName;
					var props = {};
					var key = null;
					var ref = null;
					var self = null;
					var source = null;
					if (config != null) {
						if (hasValidRef(config)) {
							ref = config.ref;
							warnIfStringRefCannotBeAutoConverted(config);
						}
						if (hasValidKey(config)) {
							checkKeyStringCoercion(config.key);
							key = "" + config.key;
						}
						self = config.__self === void 0 ? null : config.__self;
						source = config.__source === void 0 ? null : config.__source;
						for (propName in config) if (hasOwnProperty.call(config, propName) && !RESERVED_PROPS.hasOwnProperty(propName)) props[propName] = config[propName];
					}
					var childrenLength = arguments.length - 2;
					if (childrenLength === 1) props.children = children;
					else if (childrenLength > 1) {
						var childArray = Array(childrenLength);
						for (var i = 0; i < childrenLength; i++) childArray[i] = arguments[i + 2];
						if (Object.freeze) Object.freeze(childArray);
						props.children = childArray;
					}
					if (type && type.defaultProps) {
						var defaultProps = type.defaultProps;
						for (propName in defaultProps) if (props[propName] === void 0) props[propName] = defaultProps[propName];
					}
					if (key || ref) {
						var displayName = typeof type === "function" ? type.displayName || type.name || "Unknown" : type;
						if (key) defineKeyPropWarningGetter(props, displayName);
						if (ref) defineRefPropWarningGetter(props, displayName);
					}
					return ReactElement(type, key, ref, self, source, ReactCurrentOwner.current, props);
				}
				function cloneAndReplaceKey(oldElement, newKey) {
					return ReactElement(oldElement.type, newKey, oldElement.ref, oldElement._self, oldElement._source, oldElement._owner, oldElement.props);
				}
				/**
				* Clone and return a new ReactElement using element as the starting point.
				* See https://reactjs.org/docs/react-api.html#cloneelement
				*/
				function cloneElement(element, config, children) {
					if (element === null || element === void 0) throw new Error("React.cloneElement(...): The argument must be a React element, but you passed " + element + ".");
					var propName;
					var props = assign({}, element.props);
					var key = element.key;
					var ref = element.ref;
					var self = element._self;
					var source = element._source;
					var owner = element._owner;
					if (config != null) {
						if (hasValidRef(config)) {
							ref = config.ref;
							owner = ReactCurrentOwner.current;
						}
						if (hasValidKey(config)) {
							checkKeyStringCoercion(config.key);
							key = "" + config.key;
						}
						var defaultProps;
						if (element.type && element.type.defaultProps) defaultProps = element.type.defaultProps;
						for (propName in config) if (hasOwnProperty.call(config, propName) && !RESERVED_PROPS.hasOwnProperty(propName)) if (config[propName] === void 0 && defaultProps !== void 0) props[propName] = defaultProps[propName];
						else props[propName] = config[propName];
					}
					var childrenLength = arguments.length - 2;
					if (childrenLength === 1) props.children = children;
					else if (childrenLength > 1) {
						var childArray = Array(childrenLength);
						for (var i = 0; i < childrenLength; i++) childArray[i] = arguments[i + 2];
						props.children = childArray;
					}
					return ReactElement(element.type, key, ref, self, source, owner, props);
				}
				/**
				* Verifies the object is a ReactElement.
				* See https://reactjs.org/docs/react-api.html#isvalidelement
				* @param {?object} object
				* @return {boolean} True if `object` is a ReactElement.
				* @final
				*/
				function isValidElement(object) {
					return typeof object === "object" && object !== null && object.$$typeof === REACT_ELEMENT_TYPE;
				}
				var SEPARATOR = ".";
				var SUBSEPARATOR = ":";
				/**
				* Escape and wrap key so it is safe to use as a reactid
				*
				* @param {string} key to be escaped.
				* @return {string} the escaped key.
				*/
				function escape(key) {
					var escapeRegex = /[=:]/g;
					var escaperLookup = {
						"=": "=0",
						":": "=2"
					};
					return "$" + key.replace(escapeRegex, function(match) {
						return escaperLookup[match];
					});
				}
				/**
				* TODO: Test that a single child and an array with one item have the same key
				* pattern.
				*/
				var didWarnAboutMaps = false;
				var userProvidedKeyEscapeRegex = /\/+/g;
				function escapeUserProvidedKey(text) {
					return text.replace(userProvidedKeyEscapeRegex, "$&/");
				}
				/**
				* Generate a key string that identifies a element within a set.
				*
				* @param {*} element A element that could contain a manual key.
				* @param {number} index Index that is used if a manual key is not provided.
				* @return {string}
				*/
				function getElementKey(element, index) {
					if (typeof element === "object" && element !== null && element.key != null) {
						checkKeyStringCoercion(element.key);
						return escape("" + element.key);
					}
					return index.toString(36);
				}
				function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
					var type = typeof children;
					if (type === "undefined" || type === "boolean") children = null;
					var invokeCallback = false;
					if (children === null) invokeCallback = true;
					else switch (type) {
						case "string":
						case "number":
							invokeCallback = true;
							break;
						case "object": switch (children.$$typeof) {
							case REACT_ELEMENT_TYPE:
							case REACT_PORTAL_TYPE: invokeCallback = true;
						}
					}
					if (invokeCallback) {
						var _child = children;
						var mappedChild = callback(_child);
						var childKey = nameSoFar === "" ? SEPARATOR + getElementKey(_child, 0) : nameSoFar;
						if (isArray(mappedChild)) {
							var escapedChildKey = "";
							if (childKey != null) escapedChildKey = escapeUserProvidedKey(childKey) + "/";
							mapIntoArray(mappedChild, array, escapedChildKey, "", function(c) {
								return c;
							});
						} else if (mappedChild != null) {
							if (isValidElement(mappedChild)) {
								if (mappedChild.key && (!_child || _child.key !== mappedChild.key)) checkKeyStringCoercion(mappedChild.key);
								mappedChild = cloneAndReplaceKey(mappedChild, escapedPrefix + (mappedChild.key && (!_child || _child.key !== mappedChild.key) ? escapeUserProvidedKey("" + mappedChild.key) + "/" : "") + childKey);
							}
							array.push(mappedChild);
						}
						return 1;
					}
					var child;
					var nextName;
					var subtreeCount = 0;
					var nextNamePrefix = nameSoFar === "" ? SEPARATOR : nameSoFar + SUBSEPARATOR;
					if (isArray(children)) for (var i = 0; i < children.length; i++) {
						child = children[i];
						nextName = nextNamePrefix + getElementKey(child, i);
						subtreeCount += mapIntoArray(child, array, escapedPrefix, nextName, callback);
					}
					else {
						var iteratorFn = getIteratorFn(children);
						if (typeof iteratorFn === "function") {
							var iterableChildren = children;
							if (iteratorFn === iterableChildren.entries) {
								if (!didWarnAboutMaps) warn("Using Maps as children is not supported. Use an array of keyed ReactElements instead.");
								didWarnAboutMaps = true;
							}
							var iterator = iteratorFn.call(iterableChildren);
							var step;
							var ii = 0;
							while (!(step = iterator.next()).done) {
								child = step.value;
								nextName = nextNamePrefix + getElementKey(child, ii++);
								subtreeCount += mapIntoArray(child, array, escapedPrefix, nextName, callback);
							}
						} else if (type === "object") {
							var childrenString = String(children);
							throw new Error("Objects are not valid as a React child (found: " + (childrenString === "[object Object]" ? "object with keys {" + Object.keys(children).join(", ") + "}" : childrenString) + "). If you meant to render a collection of children, use an array instead.");
						}
					}
					return subtreeCount;
				}
				/**
				* Maps children that are typically specified as `props.children`.
				*
				* See https://reactjs.org/docs/react-api.html#reactchildrenmap
				*
				* The provided mapFunction(child, index) will be called for each
				* leaf child.
				*
				* @param {?*} children Children tree container.
				* @param {function(*, int)} func The map function.
				* @param {*} context Context for mapFunction.
				* @return {object} Object containing the ordered map of results.
				*/
				function mapChildren(children, func, context) {
					if (children == null) return children;
					var result = [];
					var count = 0;
					mapIntoArray(children, result, "", "", function(child) {
						return func.call(context, child, count++);
					});
					return result;
				}
				/**
				* Count the number of children that are typically specified as
				* `props.children`.
				*
				* See https://reactjs.org/docs/react-api.html#reactchildrencount
				*
				* @param {?*} children Children tree container.
				* @return {number} The number of children.
				*/
				function countChildren(children) {
					var n = 0;
					mapChildren(children, function() {
						n++;
					});
					return n;
				}
				/**
				* Iterates through children that are typically specified as `props.children`.
				*
				* See https://reactjs.org/docs/react-api.html#reactchildrenforeach
				*
				* The provided forEachFunc(child, index) will be called for each
				* leaf child.
				*
				* @param {?*} children Children tree container.
				* @param {function(*, int)} forEachFunc
				* @param {*} forEachContext Context for forEachContext.
				*/
				function forEachChildren(children, forEachFunc, forEachContext) {
					mapChildren(children, function() {
						forEachFunc.apply(this, arguments);
					}, forEachContext);
				}
				/**
				* Flatten a children object (typically specified as `props.children`) and
				* return an array with appropriately re-keyed children.
				*
				* See https://reactjs.org/docs/react-api.html#reactchildrentoarray
				*/
				function toArray(children) {
					return mapChildren(children, function(child) {
						return child;
					}) || [];
				}
				/**
				* Returns the first child in a collection of children and verifies that there
				* is only one child in the collection.
				*
				* See https://reactjs.org/docs/react-api.html#reactchildrenonly
				*
				* The current implementation of this function assumes that a single child gets
				* passed without a wrapper, but the purpose of this helper function is to
				* abstract away the particular structure of children.
				*
				* @param {?object} children Child collection structure.
				* @return {ReactElement} The first and only `ReactElement` contained in the
				* structure.
				*/
				function onlyChild(children) {
					if (!isValidElement(children)) throw new Error("React.Children.only expected to receive a single React element child.");
					return children;
				}
				function createContext(defaultValue) {
					var context = {
						$$typeof: REACT_CONTEXT_TYPE,
						_currentValue: defaultValue,
						_currentValue2: defaultValue,
						_threadCount: 0,
						Provider: null,
						Consumer: null,
						_defaultValue: null,
						_globalName: null
					};
					context.Provider = {
						$$typeof: REACT_PROVIDER_TYPE,
						_context: context
					};
					var hasWarnedAboutUsingNestedContextConsumers = false;
					var hasWarnedAboutUsingConsumerProvider = false;
					var hasWarnedAboutDisplayNameOnConsumer = false;
					var Consumer = {
						$$typeof: REACT_CONTEXT_TYPE,
						_context: context
					};
					Object.defineProperties(Consumer, {
						Provider: {
							get: function() {
								if (!hasWarnedAboutUsingConsumerProvider) {
									hasWarnedAboutUsingConsumerProvider = true;
									error("Rendering <Context.Consumer.Provider> is not supported and will be removed in a future major release. Did you mean to render <Context.Provider> instead?");
								}
								return context.Provider;
							},
							set: function(_Provider) {
								context.Provider = _Provider;
							}
						},
						_currentValue: {
							get: function() {
								return context._currentValue;
							},
							set: function(_currentValue) {
								context._currentValue = _currentValue;
							}
						},
						_currentValue2: {
							get: function() {
								return context._currentValue2;
							},
							set: function(_currentValue2) {
								context._currentValue2 = _currentValue2;
							}
						},
						_threadCount: {
							get: function() {
								return context._threadCount;
							},
							set: function(_threadCount) {
								context._threadCount = _threadCount;
							}
						},
						Consumer: { get: function() {
							if (!hasWarnedAboutUsingNestedContextConsumers) {
								hasWarnedAboutUsingNestedContextConsumers = true;
								error("Rendering <Context.Consumer.Consumer> is not supported and will be removed in a future major release. Did you mean to render <Context.Consumer> instead?");
							}
							return context.Consumer;
						} },
						displayName: {
							get: function() {
								return context.displayName;
							},
							set: function(displayName) {
								if (!hasWarnedAboutDisplayNameOnConsumer) {
									warn("Setting `displayName` on Context.Consumer has no effect. You should set it directly on the context with Context.displayName = '%s'.", displayName);
									hasWarnedAboutDisplayNameOnConsumer = true;
								}
							}
						}
					});
					context.Consumer = Consumer;
					context._currentRenderer = null;
					context._currentRenderer2 = null;
					return context;
				}
				var Uninitialized = -1;
				var Pending = 0;
				var Resolved = 1;
				var Rejected = 2;
				function lazyInitializer(payload) {
					if (payload._status === Uninitialized) {
						var ctor = payload._result;
						var thenable = ctor();
						thenable.then(function(moduleObject) {
							if (payload._status === Pending || payload._status === Uninitialized) {
								var resolved = payload;
								resolved._status = Resolved;
								resolved._result = moduleObject;
							}
						}, function(error) {
							if (payload._status === Pending || payload._status === Uninitialized) {
								var rejected = payload;
								rejected._status = Rejected;
								rejected._result = error;
							}
						});
						if (payload._status === Uninitialized) {
							var pending = payload;
							pending._status = Pending;
							pending._result = thenable;
						}
					}
					if (payload._status === Resolved) {
						var moduleObject = payload._result;
						if (moduleObject === void 0) error("lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))\n\nDid you accidentally put curly braces around the import?", moduleObject);
						if (!("default" in moduleObject)) error("lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))", moduleObject);
						return moduleObject.default;
					} else throw payload._result;
				}
				function lazy(ctor) {
					var lazyType = {
						$$typeof: REACT_LAZY_TYPE,
						_payload: {
							_status: Uninitialized,
							_result: ctor
						},
						_init: lazyInitializer
					};
					var defaultProps;
					var propTypes;
					Object.defineProperties(lazyType, {
						defaultProps: {
							configurable: true,
							get: function() {
								return defaultProps;
							},
							set: function(newDefaultProps) {
								error("React.lazy(...): It is not supported to assign `defaultProps` to a lazy component import. Either specify them where the component is defined, or create a wrapping component around it.");
								defaultProps = newDefaultProps;
								Object.defineProperty(lazyType, "defaultProps", { enumerable: true });
							}
						},
						propTypes: {
							configurable: true,
							get: function() {
								return propTypes;
							},
							set: function(newPropTypes) {
								error("React.lazy(...): It is not supported to assign `propTypes` to a lazy component import. Either specify them where the component is defined, or create a wrapping component around it.");
								propTypes = newPropTypes;
								Object.defineProperty(lazyType, "propTypes", { enumerable: true });
							}
						}
					});
					return lazyType;
				}
				function forwardRef(render) {
					if (render != null && render.$$typeof === REACT_MEMO_TYPE) error("forwardRef requires a render function but received a `memo` component. Instead of forwardRef(memo(...)), use memo(forwardRef(...)).");
					else if (typeof render !== "function") error("forwardRef requires a render function but was given %s.", render === null ? "null" : typeof render);
					else if (render.length !== 0 && render.length !== 2) error("forwardRef render functions accept exactly two parameters: props and ref. %s", render.length === 1 ? "Did you forget to use the ref parameter?" : "Any additional parameter will be undefined.");
					if (render != null) {
						if (render.defaultProps != null || render.propTypes != null) error("forwardRef render functions do not support propTypes or defaultProps. Did you accidentally pass a React component?");
					}
					var elementType = {
						$$typeof: REACT_FORWARD_REF_TYPE,
						render
					};
					var ownName;
					Object.defineProperty(elementType, "displayName", {
						enumerable: false,
						configurable: true,
						get: function() {
							return ownName;
						},
						set: function(name) {
							ownName = name;
							if (!render.name && !render.displayName) render.displayName = name;
						}
					});
					return elementType;
				}
				var REACT_MODULE_REFERENCE = Symbol.for("react.module.reference");
				function isValidElementType(type) {
					if (typeof type === "string" || typeof type === "function") return true;
					if (type === REACT_FRAGMENT_TYPE || type === REACT_PROFILER_TYPE || enableDebugTracing || type === REACT_STRICT_MODE_TYPE || type === REACT_SUSPENSE_TYPE || type === REACT_SUSPENSE_LIST_TYPE || enableLegacyHidden || type === REACT_OFFSCREEN_TYPE || enableScopeAPI || enableCacheElement || enableTransitionTracing) return true;
					if (typeof type === "object" && type !== null) {
						if (type.$$typeof === REACT_LAZY_TYPE || type.$$typeof === REACT_MEMO_TYPE || type.$$typeof === REACT_PROVIDER_TYPE || type.$$typeof === REACT_CONTEXT_TYPE || type.$$typeof === REACT_FORWARD_REF_TYPE || type.$$typeof === REACT_MODULE_REFERENCE || type.getModuleId !== void 0) return true;
					}
					return false;
				}
				function memo(type, compare) {
					if (!isValidElementType(type)) error("memo: The first argument must be a component. Instead received: %s", type === null ? "null" : typeof type);
					var elementType = {
						$$typeof: REACT_MEMO_TYPE,
						type,
						compare: compare === void 0 ? null : compare
					};
					var ownName;
					Object.defineProperty(elementType, "displayName", {
						enumerable: false,
						configurable: true,
						get: function() {
							return ownName;
						},
						set: function(name) {
							ownName = name;
							if (!type.name && !type.displayName) type.displayName = name;
						}
					});
					return elementType;
				}
				function resolveDispatcher() {
					var dispatcher = ReactCurrentDispatcher.current;
					if (dispatcher === null) error("Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://reactjs.org/link/invalid-hook-call for tips about how to debug and fix this problem.");
					return dispatcher;
				}
				function useContext(Context) {
					var dispatcher = resolveDispatcher();
					if (Context._context !== void 0) {
						var realContext = Context._context;
						if (realContext.Consumer === Context) error("Calling useContext(Context.Consumer) is not supported, may cause bugs, and will be removed in a future major release. Did you mean to call useContext(Context) instead?");
						else if (realContext.Provider === Context) error("Calling useContext(Context.Provider) is not supported. Did you mean to call useContext(Context) instead?");
					}
					return dispatcher.useContext(Context);
				}
				function useState(initialState) {
					return resolveDispatcher().useState(initialState);
				}
				function useReducer(reducer, initialArg, init) {
					return resolveDispatcher().useReducer(reducer, initialArg, init);
				}
				function useRef(initialValue) {
					return resolveDispatcher().useRef(initialValue);
				}
				function useEffect(create, deps) {
					return resolveDispatcher().useEffect(create, deps);
				}
				function useInsertionEffect(create, deps) {
					return resolveDispatcher().useInsertionEffect(create, deps);
				}
				function useLayoutEffect(create, deps) {
					return resolveDispatcher().useLayoutEffect(create, deps);
				}
				function useCallback(callback, deps) {
					return resolveDispatcher().useCallback(callback, deps);
				}
				function useMemo(create, deps) {
					return resolveDispatcher().useMemo(create, deps);
				}
				function useImperativeHandle(ref, create, deps) {
					return resolveDispatcher().useImperativeHandle(ref, create, deps);
				}
				function useDebugValue(value, formatterFn) {
					return resolveDispatcher().useDebugValue(value, formatterFn);
				}
				function useTransition() {
					return resolveDispatcher().useTransition();
				}
				function useDeferredValue(value) {
					return resolveDispatcher().useDeferredValue(value);
				}
				function useId() {
					return resolveDispatcher().useId();
				}
				function useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
					return resolveDispatcher().useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
				}
				var disabledDepth = 0;
				var prevLog;
				var prevInfo;
				var prevWarn;
				var prevError;
				var prevGroup;
				var prevGroupCollapsed;
				var prevGroupEnd;
				function disabledLog() {}
				disabledLog.__reactDisabledLog = true;
				function disableLogs() {
					if (disabledDepth === 0) {
						prevLog = console.log;
						prevInfo = console.info;
						prevWarn = console.warn;
						prevError = console.error;
						prevGroup = console.group;
						prevGroupCollapsed = console.groupCollapsed;
						prevGroupEnd = console.groupEnd;
						var props = {
							configurable: true,
							enumerable: true,
							value: disabledLog,
							writable: true
						};
						Object.defineProperties(console, {
							info: props,
							log: props,
							warn: props,
							error: props,
							group: props,
							groupCollapsed: props,
							groupEnd: props
						});
					}
					disabledDepth++;
				}
				function reenableLogs() {
					disabledDepth--;
					if (disabledDepth === 0) {
						var props = {
							configurable: true,
							enumerable: true,
							writable: true
						};
						Object.defineProperties(console, {
							log: assign({}, props, { value: prevLog }),
							info: assign({}, props, { value: prevInfo }),
							warn: assign({}, props, { value: prevWarn }),
							error: assign({}, props, { value: prevError }),
							group: assign({}, props, { value: prevGroup }),
							groupCollapsed: assign({}, props, { value: prevGroupCollapsed }),
							groupEnd: assign({}, props, { value: prevGroupEnd })
						});
					}
					if (disabledDepth < 0) error("disabledDepth fell below zero. This is a bug in React. Please file an issue.");
				}
				var ReactCurrentDispatcher$1 = ReactSharedInternals.ReactCurrentDispatcher;
				var prefix;
				function describeBuiltInComponentFrame(name, source, ownerFn) {
					if (prefix === void 0) try {
						throw Error();
					} catch (x) {
						var match = x.stack.trim().match(/\n( *(at )?)/);
						prefix = match && match[1] || "";
					}
					return "\n" + prefix + name;
				}
				var reentry = false;
				var componentFrameCache = new (typeof WeakMap === "function" ? WeakMap : Map)();
				function describeNativeComponentFrame(fn, construct) {
					if (!fn || reentry) return "";
					var frame = componentFrameCache.get(fn);
					if (frame !== void 0) return frame;
					var control;
					reentry = true;
					var previousPrepareStackTrace = Error.prepareStackTrace;
					Error.prepareStackTrace = void 0;
					var previousDispatcher = ReactCurrentDispatcher$1.current;
					ReactCurrentDispatcher$1.current = null;
					disableLogs();
					try {
						if (construct) {
							var Fake = function() {
								throw Error();
							};
							Object.defineProperty(Fake.prototype, "props", { set: function() {
								throw Error();
							} });
							if (typeof Reflect === "object" && Reflect.construct) {
								try {
									Reflect.construct(Fake, []);
								} catch (x) {
									control = x;
								}
								Reflect.construct(fn, [], Fake);
							} else {
								try {
									Fake.call();
								} catch (x) {
									control = x;
								}
								fn.call(Fake.prototype);
							}
						} else {
							try {
								throw Error();
							} catch (x) {
								control = x;
							}
							fn();
						}
					} catch (sample) {
						if (sample && control && typeof sample.stack === "string") {
							var sampleLines = sample.stack.split("\n");
							var controlLines = control.stack.split("\n");
							var s = sampleLines.length - 1;
							var c = controlLines.length - 1;
							while (s >= 1 && c >= 0 && sampleLines[s] !== controlLines[c]) c--;
							for (; s >= 1 && c >= 0; s--, c--) if (sampleLines[s] !== controlLines[c]) {
								if (s !== 1 || c !== 1) do {
									s--;
									c--;
									if (c < 0 || sampleLines[s] !== controlLines[c]) {
										var _frame = "\n" + sampleLines[s].replace(" at new ", " at ");
										if (fn.displayName && _frame.includes("<anonymous>")) _frame = _frame.replace("<anonymous>", fn.displayName);
										if (typeof fn === "function") componentFrameCache.set(fn, _frame);
										return _frame;
									}
								} while (s >= 1 && c >= 0);
								break;
							}
						}
					} finally {
						reentry = false;
						ReactCurrentDispatcher$1.current = previousDispatcher;
						reenableLogs();
						Error.prepareStackTrace = previousPrepareStackTrace;
					}
					var name = fn ? fn.displayName || fn.name : "";
					var syntheticFrame = name ? describeBuiltInComponentFrame(name) : "";
					if (typeof fn === "function") componentFrameCache.set(fn, syntheticFrame);
					return syntheticFrame;
				}
				function describeFunctionComponentFrame(fn, source, ownerFn) {
					return describeNativeComponentFrame(fn, false);
				}
				function shouldConstruct(Component) {
					var prototype = Component.prototype;
					return !!(prototype && prototype.isReactComponent);
				}
				function describeUnknownElementTypeFrameInDEV(type, source, ownerFn) {
					if (type == null) return "";
					if (typeof type === "function") return describeNativeComponentFrame(type, shouldConstruct(type));
					if (typeof type === "string") return describeBuiltInComponentFrame(type);
					switch (type) {
						case REACT_SUSPENSE_TYPE: return describeBuiltInComponentFrame("Suspense");
						case REACT_SUSPENSE_LIST_TYPE: return describeBuiltInComponentFrame("SuspenseList");
					}
					if (typeof type === "object") switch (type.$$typeof) {
						case REACT_FORWARD_REF_TYPE: return describeFunctionComponentFrame(type.render);
						case REACT_MEMO_TYPE: return describeUnknownElementTypeFrameInDEV(type.type, source, ownerFn);
						case REACT_LAZY_TYPE:
							var lazyComponent = type;
							var payload = lazyComponent._payload;
							var init = lazyComponent._init;
							try {
								return describeUnknownElementTypeFrameInDEV(init(payload), source, ownerFn);
							} catch (x) {}
					}
					return "";
				}
				var loggedTypeFailures = {};
				var ReactDebugCurrentFrame$1 = ReactSharedInternals.ReactDebugCurrentFrame;
				function setCurrentlyValidatingElement(element) {
					if (element) {
						var owner = element._owner;
						var stack = describeUnknownElementTypeFrameInDEV(element.type, element._source, owner ? owner.type : null);
						ReactDebugCurrentFrame$1.setExtraStackFrame(stack);
					} else ReactDebugCurrentFrame$1.setExtraStackFrame(null);
				}
				function checkPropTypes(typeSpecs, values, location, componentName, element) {
					var has = Function.call.bind(hasOwnProperty);
					for (var typeSpecName in typeSpecs) if (has(typeSpecs, typeSpecName)) {
						var error$1 = void 0;
						try {
							if (typeof typeSpecs[typeSpecName] !== "function") {
								var err = Error((componentName || "React class") + ": " + location + " type `" + typeSpecName + "` is invalid; it must be a function, usually from the `prop-types` package, but received `" + typeof typeSpecs[typeSpecName] + "`.This often happens because of typos such as `PropTypes.function` instead of `PropTypes.func`.");
								err.name = "Invariant Violation";
								throw err;
							}
							error$1 = typeSpecs[typeSpecName](values, typeSpecName, componentName, location, null, "SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED");
						} catch (ex) {
							error$1 = ex;
						}
						if (error$1 && !(error$1 instanceof Error)) {
							setCurrentlyValidatingElement(element);
							error("%s: type specification of %s `%s` is invalid; the type checker function must return `null` or an `Error` but returned a %s. You may have forgotten to pass an argument to the type checker creator (arrayOf, instanceOf, objectOf, oneOf, oneOfType, and shape all require an argument).", componentName || "React class", location, typeSpecName, typeof error$1);
							setCurrentlyValidatingElement(null);
						}
						if (error$1 instanceof Error && !(error$1.message in loggedTypeFailures)) {
							loggedTypeFailures[error$1.message] = true;
							setCurrentlyValidatingElement(element);
							error("Failed %s type: %s", location, error$1.message);
							setCurrentlyValidatingElement(null);
						}
					}
				}
				function setCurrentlyValidatingElement$1(element) {
					if (element) {
						var owner = element._owner;
						setExtraStackFrame(describeUnknownElementTypeFrameInDEV(element.type, element._source, owner ? owner.type : null));
					} else setExtraStackFrame(null);
				}
				var propTypesMisspellWarningShown = false;
				function getDeclarationErrorAddendum() {
					if (ReactCurrentOwner.current) {
						var name = getComponentNameFromType(ReactCurrentOwner.current.type);
						if (name) return "\n\nCheck the render method of `" + name + "`.";
					}
					return "";
				}
				function getSourceInfoErrorAddendum(source) {
					if (source !== void 0) {
						var fileName = source.fileName.replace(/^.*[\\\/]/, "");
						var lineNumber = source.lineNumber;
						return "\n\nCheck your code at " + fileName + ":" + lineNumber + ".";
					}
					return "";
				}
				function getSourceInfoErrorAddendumForProps(elementProps) {
					if (elementProps !== null && elementProps !== void 0) return getSourceInfoErrorAddendum(elementProps.__source);
					return "";
				}
				/**
				* Warn if there's no key explicitly set on dynamic arrays of children or
				* object keys are not valid. This allows us to keep track of children between
				* updates.
				*/
				var ownerHasKeyUseWarning = {};
				function getCurrentComponentErrorInfo(parentType) {
					var info = getDeclarationErrorAddendum();
					if (!info) {
						var parentName = typeof parentType === "string" ? parentType : parentType.displayName || parentType.name;
						if (parentName) info = "\n\nCheck the top-level render call using <" + parentName + ">.";
					}
					return info;
				}
				/**
				* Warn if the element doesn't have an explicit key assigned to it.
				* This element is in an array. The array could grow and shrink or be
				* reordered. All children that haven't already been validated are required to
				* have a "key" property assigned to it. Error statuses are cached so a warning
				* will only be shown once.
				*
				* @internal
				* @param {ReactElement} element Element that requires a key.
				* @param {*} parentType element's parent's type.
				*/
				function validateExplicitKey(element, parentType) {
					if (!element._store || element._store.validated || element.key != null) return;
					element._store.validated = true;
					var currentComponentErrorInfo = getCurrentComponentErrorInfo(parentType);
					if (ownerHasKeyUseWarning[currentComponentErrorInfo]) return;
					ownerHasKeyUseWarning[currentComponentErrorInfo] = true;
					var childOwner = "";
					if (element && element._owner && element._owner !== ReactCurrentOwner.current) childOwner = " It was passed a child from " + getComponentNameFromType(element._owner.type) + ".";
					setCurrentlyValidatingElement$1(element);
					error("Each child in a list should have a unique \"key\" prop.%s%s See https://reactjs.org/link/warning-keys for more information.", currentComponentErrorInfo, childOwner);
					setCurrentlyValidatingElement$1(null);
				}
				/**
				* Ensure that every element either is passed in a static location, in an
				* array with an explicit keys property defined, or in an object literal
				* with valid key property.
				*
				* @internal
				* @param {ReactNode} node Statically passed child of any type.
				* @param {*} parentType node's parent's type.
				*/
				function validateChildKeys(node, parentType) {
					if (typeof node !== "object") return;
					if (isArray(node)) for (var i = 0; i < node.length; i++) {
						var child = node[i];
						if (isValidElement(child)) validateExplicitKey(child, parentType);
					}
					else if (isValidElement(node)) {
						if (node._store) node._store.validated = true;
					} else if (node) {
						var iteratorFn = getIteratorFn(node);
						if (typeof iteratorFn === "function") {
							if (iteratorFn !== node.entries) {
								var iterator = iteratorFn.call(node);
								var step;
								while (!(step = iterator.next()).done) if (isValidElement(step.value)) validateExplicitKey(step.value, parentType);
							}
						}
					}
				}
				/**
				* Given an element, validate that its props follow the propTypes definition,
				* provided by the type.
				*
				* @param {ReactElement} element
				*/
				function validatePropTypes(element) {
					var type = element.type;
					if (type === null || type === void 0 || typeof type === "string") return;
					var propTypes;
					if (typeof type === "function") propTypes = type.propTypes;
					else if (typeof type === "object" && (type.$$typeof === REACT_FORWARD_REF_TYPE || type.$$typeof === REACT_MEMO_TYPE)) propTypes = type.propTypes;
					else return;
					if (propTypes) {
						var name = getComponentNameFromType(type);
						checkPropTypes(propTypes, element.props, "prop", name, element);
					} else if (type.PropTypes !== void 0 && !propTypesMisspellWarningShown) {
						propTypesMisspellWarningShown = true;
						error("Component %s declared `PropTypes` instead of `propTypes`. Did you misspell the property assignment?", getComponentNameFromType(type) || "Unknown");
					}
					if (typeof type.getDefaultProps === "function" && !type.getDefaultProps.isReactClassApproved) error("getDefaultProps is only used on classic React.createClass definitions. Use a static property named `defaultProps` instead.");
				}
				/**
				* Given a fragment, validate that it can only be provided with fragment props
				* @param {ReactElement} fragment
				*/
				function validateFragmentProps(fragment) {
					var keys = Object.keys(fragment.props);
					for (var i = 0; i < keys.length; i++) {
						var key = keys[i];
						if (key !== "children" && key !== "key") {
							setCurrentlyValidatingElement$1(fragment);
							error("Invalid prop `%s` supplied to `React.Fragment`. React.Fragment can only have `key` and `children` props.", key);
							setCurrentlyValidatingElement$1(null);
							break;
						}
					}
					if (fragment.ref !== null) {
						setCurrentlyValidatingElement$1(fragment);
						error("Invalid attribute `ref` supplied to `React.Fragment`.");
						setCurrentlyValidatingElement$1(null);
					}
				}
				function createElementWithValidation(type, props, children) {
					var validType = isValidElementType(type);
					if (!validType) {
						var info = "";
						if (type === void 0 || typeof type === "object" && type !== null && Object.keys(type).length === 0) info += " You likely forgot to export your component from the file it's defined in, or you might have mixed up default and named imports.";
						var sourceInfo = getSourceInfoErrorAddendumForProps(props);
						if (sourceInfo) info += sourceInfo;
						else info += getDeclarationErrorAddendum();
						var typeString;
						if (type === null) typeString = "null";
						else if (isArray(type)) typeString = "array";
						else if (type !== void 0 && type.$$typeof === REACT_ELEMENT_TYPE) {
							typeString = "<" + (getComponentNameFromType(type.type) || "Unknown") + " />";
							info = " Did you accidentally export a JSX literal instead of a component?";
						} else typeString = typeof type;
						error("React.createElement: type is invalid -- expected a string (for built-in components) or a class/function (for composite components) but got: %s.%s", typeString, info);
					}
					var element = createElement.apply(this, arguments);
					if (element == null) return element;
					if (validType) for (var i = 2; i < arguments.length; i++) validateChildKeys(arguments[i], type);
					if (type === REACT_FRAGMENT_TYPE) validateFragmentProps(element);
					else validatePropTypes(element);
					return element;
				}
				var didWarnAboutDeprecatedCreateFactory = false;
				function createFactoryWithValidation(type) {
					var validatedFactory = createElementWithValidation.bind(null, type);
					validatedFactory.type = type;
					if (!didWarnAboutDeprecatedCreateFactory) {
						didWarnAboutDeprecatedCreateFactory = true;
						warn("React.createFactory() is deprecated and will be removed in a future major release. Consider using JSX or use React.createElement() directly instead.");
					}
					Object.defineProperty(validatedFactory, "type", {
						enumerable: false,
						get: function() {
							warn("Factory.type is deprecated. Access the class directly before passing it to createFactory.");
							Object.defineProperty(this, "type", { value: type });
							return type;
						}
					});
					return validatedFactory;
				}
				function cloneElementWithValidation(element, props, children) {
					var newElement = cloneElement.apply(this, arguments);
					for (var i = 2; i < arguments.length; i++) validateChildKeys(arguments[i], newElement.type);
					validatePropTypes(newElement);
					return newElement;
				}
				function startTransition(scope, options) {
					var prevTransition = ReactCurrentBatchConfig.transition;
					ReactCurrentBatchConfig.transition = {};
					var currentTransition = ReactCurrentBatchConfig.transition;
					ReactCurrentBatchConfig.transition._updatedFibers = /* @__PURE__ */ new Set();
					try {
						scope();
					} finally {
						ReactCurrentBatchConfig.transition = prevTransition;
						if (prevTransition === null && currentTransition._updatedFibers) {
							if (currentTransition._updatedFibers.size > 10) warn("Detected a large number of updates inside startTransition. If this is due to a subscription please re-write it to use React provided hooks. Otherwise concurrent mode guarantees are off the table.");
							currentTransition._updatedFibers.clear();
						}
					}
				}
				var didWarnAboutMessageChannel = false;
				var enqueueTaskImpl = null;
				function enqueueTask(task) {
					if (enqueueTaskImpl === null) try {
						var requireString = ("require" + Math.random()).slice(0, 7);
						enqueueTaskImpl = (module && module[requireString]).call(module, "timers").setImmediate;
					} catch (_err) {
						enqueueTaskImpl = function(callback) {
							if (didWarnAboutMessageChannel === false) {
								didWarnAboutMessageChannel = true;
								if (typeof MessageChannel === "undefined") error("This browser does not have a MessageChannel implementation, so enqueuing tasks via await act(async () => ...) will fail. Please file an issue at https://github.com/facebook/react/issues if you encounter this warning.");
							}
							var channel = new MessageChannel();
							channel.port1.onmessage = callback;
							channel.port2.postMessage(void 0);
						};
					}
					return enqueueTaskImpl(task);
				}
				var actScopeDepth = 0;
				var didWarnNoAwaitAct = false;
				function act(callback) {
					var prevActScopeDepth = actScopeDepth;
					actScopeDepth++;
					if (ReactCurrentActQueue.current === null) ReactCurrentActQueue.current = [];
					var prevIsBatchingLegacy = ReactCurrentActQueue.isBatchingLegacy;
					var result;
					try {
						ReactCurrentActQueue.isBatchingLegacy = true;
						result = callback();
						if (!prevIsBatchingLegacy && ReactCurrentActQueue.didScheduleLegacyUpdate) {
							var queue = ReactCurrentActQueue.current;
							if (queue !== null) {
								ReactCurrentActQueue.didScheduleLegacyUpdate = false;
								flushActQueue(queue);
							}
						}
					} catch (error) {
						popActScope(prevActScopeDepth);
						throw error;
					} finally {
						ReactCurrentActQueue.isBatchingLegacy = prevIsBatchingLegacy;
					}
					if (result !== null && typeof result === "object" && typeof result.then === "function") {
						var thenableResult = result;
						var wasAwaited = false;
						var thenable = { then: function(resolve, reject) {
							wasAwaited = true;
							thenableResult.then(function(returnValue) {
								popActScope(prevActScopeDepth);
								if (actScopeDepth === 0) recursivelyFlushAsyncActWork(returnValue, resolve, reject);
								else resolve(returnValue);
							}, function(error) {
								popActScope(prevActScopeDepth);
								reject(error);
							});
						} };
						if (!didWarnNoAwaitAct && typeof Promise !== "undefined") Promise.resolve().then(function() {}).then(function() {
							if (!wasAwaited) {
								didWarnNoAwaitAct = true;
								error("You called act(async () => ...) without await. This could lead to unexpected testing behaviour, interleaving multiple act calls and mixing their scopes. You should - await act(async () => ...);");
							}
						});
						return thenable;
					} else {
						var returnValue = result;
						popActScope(prevActScopeDepth);
						if (actScopeDepth === 0) {
							var _queue = ReactCurrentActQueue.current;
							if (_queue !== null) {
								flushActQueue(_queue);
								ReactCurrentActQueue.current = null;
							}
							return { then: function(resolve, reject) {
								if (ReactCurrentActQueue.current === null) {
									ReactCurrentActQueue.current = [];
									recursivelyFlushAsyncActWork(returnValue, resolve, reject);
								} else resolve(returnValue);
							} };
						} else return { then: function(resolve, reject) {
							resolve(returnValue);
						} };
					}
				}
				function popActScope(prevActScopeDepth) {
					if (prevActScopeDepth !== actScopeDepth - 1) error("You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. ");
					actScopeDepth = prevActScopeDepth;
				}
				function recursivelyFlushAsyncActWork(returnValue, resolve, reject) {
					var queue = ReactCurrentActQueue.current;
					if (queue !== null) try {
						flushActQueue(queue);
						enqueueTask(function() {
							if (queue.length === 0) {
								ReactCurrentActQueue.current = null;
								resolve(returnValue);
							} else recursivelyFlushAsyncActWork(returnValue, resolve, reject);
						});
					} catch (error) {
						reject(error);
					}
					else resolve(returnValue);
				}
				var isFlushing = false;
				function flushActQueue(queue) {
					if (!isFlushing) {
						isFlushing = true;
						var i = 0;
						try {
							for (; i < queue.length; i++) {
								var callback = queue[i];
								do
									callback = callback(true);
								while (callback !== null);
							}
							queue.length = 0;
						} catch (error) {
							queue = queue.slice(i + 1);
							throw error;
						} finally {
							isFlushing = false;
						}
					}
				}
				var createElement$1 = createElementWithValidation;
				var cloneElement$1 = cloneElementWithValidation;
				var createFactory = createFactoryWithValidation;
				exports.Children = {
					map: mapChildren,
					forEach: forEachChildren,
					count: countChildren,
					toArray,
					only: onlyChild
				};
				exports.Component = Component;
				exports.Fragment = REACT_FRAGMENT_TYPE;
				exports.Profiler = REACT_PROFILER_TYPE;
				exports.PureComponent = PureComponent;
				exports.StrictMode = REACT_STRICT_MODE_TYPE;
				exports.Suspense = REACT_SUSPENSE_TYPE;
				exports.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = ReactSharedInternals;
				exports.act = act;
				exports.cloneElement = cloneElement$1;
				exports.createContext = createContext;
				exports.createElement = createElement$1;
				exports.createFactory = createFactory;
				exports.createRef = createRef;
				exports.forwardRef = forwardRef;
				exports.isValidElement = isValidElement;
				exports.lazy = lazy;
				exports.memo = memo;
				exports.startTransition = startTransition;
				exports.unstable_act = act;
				exports.useCallback = useCallback;
				exports.useContext = useContext;
				exports.useDebugValue = useDebugValue;
				exports.useDeferredValue = useDeferredValue;
				exports.useEffect = useEffect;
				exports.useId = useId;
				exports.useImperativeHandle = useImperativeHandle;
				exports.useInsertionEffect = useInsertionEffect;
				exports.useLayoutEffect = useLayoutEffect;
				exports.useMemo = useMemo;
				exports.useReducer = useReducer;
				exports.useRef = useRef;
				exports.useState = useState;
				exports.useSyncExternalStore = useSyncExternalStore;
				exports.useTransition = useTransition;
				exports.version = ReactVersion;
				if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop === "function") __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(/* @__PURE__ */ new Error());
			})();
		}));
		//#endregion
		//#region node_modules/react/index.js
		var require_react = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			if (process.env.NODE_ENV === "production") module.exports = require_react_production_min();
			else module.exports = require_react_development();
		}));
		//#endregion
		//#region src/client/locales.ts
		var import_react = require_react();
		/**
		* Connectors client UI copy: zh is the key source, en mirrors the full key
		* set (the same pattern as dsh-cron/dsh-task locales).
		*/
		const zh = {
			"panel.title": "连接器",
			"panel.close": "关闭",
			"search.placeholder": "搜索连接器…",
			"filter.all": "全部",
			"filter.connected": "已连接",
			"filter.disconnected": "未连接",
			"filter.count": "{connected}/{total} 已连接",
			"empty.noMatch": "暂无匹配的连接器",
			"status.disconnected": "未连接",
			"status.connecting": "连接中…",
			"status.connected": "已连接",
			"status.unauthorized": "需要授权",
			"status.error": "连接失败",
			"action.connect": "连接",
			"action.disconnect": "断开",
			"action.submit": "提交",
			"action.connecting": "连接中…",
			"action.disconnecting": "断开中…",
			"action.cancel": "取消连接",
			"action.cancelling": "取消中…",
			"action.stop": "停止连接",
			"action.cancelHint": "连接进行中：点击停止并结束本次授权",
			"auth.verificationHint": "请打开以下地址并登录授权：",
			"auth.code": "授权码：{code}",
			"auth.authorizeOpened": "授权页已在浏览器中打开；若未弹出请点击：",
			"auth.authorizeLink": "点击打开授权页",
			"auth.waiting": "等待授权完成…",
			"auth.downloading": "正在下载命令行工具（仅首次连接需要），请稍候…"
		};
		const en = {
			"panel.title": "Connectors",
			"panel.close": "Close",
			"search.placeholder": "Search connectors…",
			"filter.all": "All",
			"filter.connected": "Connected",
			"filter.disconnected": "Disconnected",
			"filter.count": "{connected}/{total} connected",
			"empty.noMatch": "No matching connectors",
			"status.disconnected": "Not connected",
			"status.connecting": "Connecting…",
			"status.connected": "Connected",
			"status.unauthorized": "Authorization required",
			"status.error": "Connection failed",
			"action.connect": "Connect",
			"action.disconnect": "Disconnect",
			"action.submit": "Submit",
			"action.connecting": "Connecting…",
			"action.disconnecting": "Disconnecting…",
			"action.cancel": "Cancel connection",
			"action.cancelling": "Cancelling…",
			"action.stop": "Stop connection",
			"action.cancelHint": "Connection in progress: click to stop and cancel this authorization",
			"auth.verificationHint": "Open the following address to authorize:",
			"auth.code": "Authorization code: {code}",
			"auth.authorizeOpened": "The authorization page was opened; if not, click here:",
			"auth.authorizeLink": "Click to open the authorization page",
			"auth.waiting": "Waiting for authorization…",
			"auth.downloading": "Downloading the CLI tool (first connect only), please wait…"
		};
		/** Translate a key (zh key source; en mirrors the full key set). */
		function t(key, params) {
			let text = zh[key];
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value);
			return text;
		}
		/** Map raw connector/CLI errors to user-facing copy (P3-6). */
		function friendlyConnectorError(raw) {
			if (raw.includes("退出码")) return "登录命令失败：请确认已安装对应命令行工具并完成登录，然后重试";
			if (raw.includes("未找到命令")) return raw;
			if (raw.includes("下载")) return raw;
			if (raw.includes("ENOENT")) return "未找到登录命令：请先安装对应命令行工具";
			if (raw.includes("token") || raw.includes("授权") || raw.includes("登录")) return raw;
			return `连接失败：${raw}`;
		}
		//#endregion
		//#region node_modules/react/cjs/react-jsx-runtime.production.min.js
		/**
		* @license React
		* react-jsx-runtime.production.min.js
		*
		* Copyright (c) Facebook, Inc. and its affiliates.
		*
		* This source code is licensed under the MIT license found in the
		* LICENSE file in the root directory of this source tree.
		*/
		var require_react_jsx_runtime_production_min = /* @__PURE__ */ __commonJSMin(((exports) => {
			var f = require_react();
			var k = Symbol.for("react.element");
			var l = Symbol.for("react.fragment");
			var m = Object.prototype.hasOwnProperty;
			var n = f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner;
			var p = {
				key: !0,
				ref: !0,
				__self: !0,
				__source: !0
			};
			function q(c, a, g) {
				var b, d = {}, e = null, h = null;
				void 0 !== g && (e = "" + g);
				void 0 !== a.key && (e = "" + a.key);
				void 0 !== a.ref && (h = a.ref);
				for (b in a) m.call(a, b) && !p.hasOwnProperty(b) && (d[b] = a[b]);
				if (c && c.defaultProps) for (b in a = c.defaultProps, a) void 0 === d[b] && (d[b] = a[b]);
				return {
					$$typeof: k,
					type: c,
					key: e,
					ref: h,
					props: d,
					_owner: n.current
				};
			}
			exports.Fragment = l;
			exports.jsx = q;
			exports.jsxs = q;
		}));
		//#endregion
		//#region node_modules/react/cjs/react-jsx-runtime.development.js
		/**
		* @license React
		* react-jsx-runtime.development.js
		*
		* Copyright (c) Facebook, Inc. and its affiliates.
		*
		* This source code is licensed under the MIT license found in the
		* LICENSE file in the root directory of this source tree.
		*/
		var require_react_jsx_runtime_development = /* @__PURE__ */ __commonJSMin(((exports) => {
			if (process.env.NODE_ENV !== "production") (function() {
				"use strict";
				var React = require_react();
				var REACT_ELEMENT_TYPE = Symbol.for("react.element");
				var REACT_PORTAL_TYPE = Symbol.for("react.portal");
				var REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
				var REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode");
				var REACT_PROFILER_TYPE = Symbol.for("react.profiler");
				var REACT_PROVIDER_TYPE = Symbol.for("react.provider");
				var REACT_CONTEXT_TYPE = Symbol.for("react.context");
				var REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
				var REACT_SUSPENSE_TYPE = Symbol.for("react.suspense");
				var REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list");
				var REACT_MEMO_TYPE = Symbol.for("react.memo");
				var REACT_LAZY_TYPE = Symbol.for("react.lazy");
				var REACT_OFFSCREEN_TYPE = Symbol.for("react.offscreen");
				var MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
				var FAUX_ITERATOR_SYMBOL = "@@iterator";
				function getIteratorFn(maybeIterable) {
					if (maybeIterable === null || typeof maybeIterable !== "object") return null;
					var maybeIterator = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable[FAUX_ITERATOR_SYMBOL];
					if (typeof maybeIterator === "function") return maybeIterator;
					return null;
				}
				var ReactSharedInternals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
				function error(format) {
					for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) args[_key2 - 1] = arguments[_key2];
					printWarning("error", format, args);
				}
				function printWarning(level, format, args) {
					var stack = ReactSharedInternals.ReactDebugCurrentFrame.getStackAddendum();
					if (stack !== "") {
						format += "%s";
						args = args.concat([stack]);
					}
					var argsWithFormat = args.map(function(item) {
						return String(item);
					});
					argsWithFormat.unshift("Warning: " + format);
					Function.prototype.apply.call(console[level], console, argsWithFormat);
				}
				var enableScopeAPI = false;
				var enableCacheElement = false;
				var enableTransitionTracing = false;
				var enableLegacyHidden = false;
				var enableDebugTracing = false;
				var REACT_MODULE_REFERENCE = Symbol.for("react.module.reference");
				function isValidElementType(type) {
					if (typeof type === "string" || typeof type === "function") return true;
					if (type === REACT_FRAGMENT_TYPE || type === REACT_PROFILER_TYPE || enableDebugTracing || type === REACT_STRICT_MODE_TYPE || type === REACT_SUSPENSE_TYPE || type === REACT_SUSPENSE_LIST_TYPE || enableLegacyHidden || type === REACT_OFFSCREEN_TYPE || enableScopeAPI || enableCacheElement || enableTransitionTracing) return true;
					if (typeof type === "object" && type !== null) {
						if (type.$$typeof === REACT_LAZY_TYPE || type.$$typeof === REACT_MEMO_TYPE || type.$$typeof === REACT_PROVIDER_TYPE || type.$$typeof === REACT_CONTEXT_TYPE || type.$$typeof === REACT_FORWARD_REF_TYPE || type.$$typeof === REACT_MODULE_REFERENCE || type.getModuleId !== void 0) return true;
					}
					return false;
				}
				function getWrappedName(outerType, innerType, wrapperName) {
					var displayName = outerType.displayName;
					if (displayName) return displayName;
					var functionName = innerType.displayName || innerType.name || "";
					return functionName !== "" ? wrapperName + "(" + functionName + ")" : wrapperName;
				}
				function getContextName(type) {
					return type.displayName || "Context";
				}
				function getComponentNameFromType(type) {
					if (type == null) return null;
					if (typeof type.tag === "number") error("Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue.");
					if (typeof type === "function") return type.displayName || type.name || null;
					if (typeof type === "string") return type;
					switch (type) {
						case REACT_FRAGMENT_TYPE: return "Fragment";
						case REACT_PORTAL_TYPE: return "Portal";
						case REACT_PROFILER_TYPE: return "Profiler";
						case REACT_STRICT_MODE_TYPE: return "StrictMode";
						case REACT_SUSPENSE_TYPE: return "Suspense";
						case REACT_SUSPENSE_LIST_TYPE: return "SuspenseList";
					}
					if (typeof type === "object") switch (type.$$typeof) {
						case REACT_CONTEXT_TYPE: return getContextName(type) + ".Consumer";
						case REACT_PROVIDER_TYPE: return getContextName(type._context) + ".Provider";
						case REACT_FORWARD_REF_TYPE: return getWrappedName(type, type.render, "ForwardRef");
						case REACT_MEMO_TYPE:
							var outerName = type.displayName || null;
							if (outerName !== null) return outerName;
							return getComponentNameFromType(type.type) || "Memo";
						case REACT_LAZY_TYPE:
							var lazyComponent = type;
							var payload = lazyComponent._payload;
							var init = lazyComponent._init;
							try {
								return getComponentNameFromType(init(payload));
							} catch (x) {
								return null;
							}
					}
					return null;
				}
				var assign = Object.assign;
				var disabledDepth = 0;
				var prevLog;
				var prevInfo;
				var prevWarn;
				var prevError;
				var prevGroup;
				var prevGroupCollapsed;
				var prevGroupEnd;
				function disabledLog() {}
				disabledLog.__reactDisabledLog = true;
				function disableLogs() {
					if (disabledDepth === 0) {
						prevLog = console.log;
						prevInfo = console.info;
						prevWarn = console.warn;
						prevError = console.error;
						prevGroup = console.group;
						prevGroupCollapsed = console.groupCollapsed;
						prevGroupEnd = console.groupEnd;
						var props = {
							configurable: true,
							enumerable: true,
							value: disabledLog,
							writable: true
						};
						Object.defineProperties(console, {
							info: props,
							log: props,
							warn: props,
							error: props,
							group: props,
							groupCollapsed: props,
							groupEnd: props
						});
					}
					disabledDepth++;
				}
				function reenableLogs() {
					disabledDepth--;
					if (disabledDepth === 0) {
						var props = {
							configurable: true,
							enumerable: true,
							writable: true
						};
						Object.defineProperties(console, {
							log: assign({}, props, { value: prevLog }),
							info: assign({}, props, { value: prevInfo }),
							warn: assign({}, props, { value: prevWarn }),
							error: assign({}, props, { value: prevError }),
							group: assign({}, props, { value: prevGroup }),
							groupCollapsed: assign({}, props, { value: prevGroupCollapsed }),
							groupEnd: assign({}, props, { value: prevGroupEnd })
						});
					}
					if (disabledDepth < 0) error("disabledDepth fell below zero. This is a bug in React. Please file an issue.");
				}
				var ReactCurrentDispatcher = ReactSharedInternals.ReactCurrentDispatcher;
				var prefix;
				function describeBuiltInComponentFrame(name, source, ownerFn) {
					if (prefix === void 0) try {
						throw Error();
					} catch (x) {
						var match = x.stack.trim().match(/\n( *(at )?)/);
						prefix = match && match[1] || "";
					}
					return "\n" + prefix + name;
				}
				var reentry = false;
				var componentFrameCache = new (typeof WeakMap === "function" ? WeakMap : Map)();
				function describeNativeComponentFrame(fn, construct) {
					if (!fn || reentry) return "";
					var frame = componentFrameCache.get(fn);
					if (frame !== void 0) return frame;
					var control;
					reentry = true;
					var previousPrepareStackTrace = Error.prepareStackTrace;
					Error.prepareStackTrace = void 0;
					var previousDispatcher = ReactCurrentDispatcher.current;
					ReactCurrentDispatcher.current = null;
					disableLogs();
					try {
						if (construct) {
							var Fake = function() {
								throw Error();
							};
							Object.defineProperty(Fake.prototype, "props", { set: function() {
								throw Error();
							} });
							if (typeof Reflect === "object" && Reflect.construct) {
								try {
									Reflect.construct(Fake, []);
								} catch (x) {
									control = x;
								}
								Reflect.construct(fn, [], Fake);
							} else {
								try {
									Fake.call();
								} catch (x) {
									control = x;
								}
								fn.call(Fake.prototype);
							}
						} else {
							try {
								throw Error();
							} catch (x) {
								control = x;
							}
							fn();
						}
					} catch (sample) {
						if (sample && control && typeof sample.stack === "string") {
							var sampleLines = sample.stack.split("\n");
							var controlLines = control.stack.split("\n");
							var s = sampleLines.length - 1;
							var c = controlLines.length - 1;
							while (s >= 1 && c >= 0 && sampleLines[s] !== controlLines[c]) c--;
							for (; s >= 1 && c >= 0; s--, c--) if (sampleLines[s] !== controlLines[c]) {
								if (s !== 1 || c !== 1) do {
									s--;
									c--;
									if (c < 0 || sampleLines[s] !== controlLines[c]) {
										var _frame = "\n" + sampleLines[s].replace(" at new ", " at ");
										if (fn.displayName && _frame.includes("<anonymous>")) _frame = _frame.replace("<anonymous>", fn.displayName);
										if (typeof fn === "function") componentFrameCache.set(fn, _frame);
										return _frame;
									}
								} while (s >= 1 && c >= 0);
								break;
							}
						}
					} finally {
						reentry = false;
						ReactCurrentDispatcher.current = previousDispatcher;
						reenableLogs();
						Error.prepareStackTrace = previousPrepareStackTrace;
					}
					var name = fn ? fn.displayName || fn.name : "";
					var syntheticFrame = name ? describeBuiltInComponentFrame(name) : "";
					if (typeof fn === "function") componentFrameCache.set(fn, syntheticFrame);
					return syntheticFrame;
				}
				function describeFunctionComponentFrame(fn, source, ownerFn) {
					return describeNativeComponentFrame(fn, false);
				}
				function shouldConstruct(Component) {
					var prototype = Component.prototype;
					return !!(prototype && prototype.isReactComponent);
				}
				function describeUnknownElementTypeFrameInDEV(type, source, ownerFn) {
					if (type == null) return "";
					if (typeof type === "function") return describeNativeComponentFrame(type, shouldConstruct(type));
					if (typeof type === "string") return describeBuiltInComponentFrame(type);
					switch (type) {
						case REACT_SUSPENSE_TYPE: return describeBuiltInComponentFrame("Suspense");
						case REACT_SUSPENSE_LIST_TYPE: return describeBuiltInComponentFrame("SuspenseList");
					}
					if (typeof type === "object") switch (type.$$typeof) {
						case REACT_FORWARD_REF_TYPE: return describeFunctionComponentFrame(type.render);
						case REACT_MEMO_TYPE: return describeUnknownElementTypeFrameInDEV(type.type, source, ownerFn);
						case REACT_LAZY_TYPE:
							var lazyComponent = type;
							var payload = lazyComponent._payload;
							var init = lazyComponent._init;
							try {
								return describeUnknownElementTypeFrameInDEV(init(payload), source, ownerFn);
							} catch (x) {}
					}
					return "";
				}
				var hasOwnProperty = Object.prototype.hasOwnProperty;
				var loggedTypeFailures = {};
				var ReactDebugCurrentFrame = ReactSharedInternals.ReactDebugCurrentFrame;
				function setCurrentlyValidatingElement(element) {
					if (element) {
						var owner = element._owner;
						var stack = describeUnknownElementTypeFrameInDEV(element.type, element._source, owner ? owner.type : null);
						ReactDebugCurrentFrame.setExtraStackFrame(stack);
					} else ReactDebugCurrentFrame.setExtraStackFrame(null);
				}
				function checkPropTypes(typeSpecs, values, location, componentName, element) {
					var has = Function.call.bind(hasOwnProperty);
					for (var typeSpecName in typeSpecs) if (has(typeSpecs, typeSpecName)) {
						var error$1 = void 0;
						try {
							if (typeof typeSpecs[typeSpecName] !== "function") {
								var err = Error((componentName || "React class") + ": " + location + " type `" + typeSpecName + "` is invalid; it must be a function, usually from the `prop-types` package, but received `" + typeof typeSpecs[typeSpecName] + "`.This often happens because of typos such as `PropTypes.function` instead of `PropTypes.func`.");
								err.name = "Invariant Violation";
								throw err;
							}
							error$1 = typeSpecs[typeSpecName](values, typeSpecName, componentName, location, null, "SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED");
						} catch (ex) {
							error$1 = ex;
						}
						if (error$1 && !(error$1 instanceof Error)) {
							setCurrentlyValidatingElement(element);
							error("%s: type specification of %s `%s` is invalid; the type checker function must return `null` or an `Error` but returned a %s. You may have forgotten to pass an argument to the type checker creator (arrayOf, instanceOf, objectOf, oneOf, oneOfType, and shape all require an argument).", componentName || "React class", location, typeSpecName, typeof error$1);
							setCurrentlyValidatingElement(null);
						}
						if (error$1 instanceof Error && !(error$1.message in loggedTypeFailures)) {
							loggedTypeFailures[error$1.message] = true;
							setCurrentlyValidatingElement(element);
							error("Failed %s type: %s", location, error$1.message);
							setCurrentlyValidatingElement(null);
						}
					}
				}
				var isArrayImpl = Array.isArray;
				function isArray(a) {
					return isArrayImpl(a);
				}
				function typeName(value) {
					return typeof Symbol === "function" && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
				}
				function willCoercionThrow(value) {
					try {
						testStringCoercion(value);
						return false;
					} catch (e) {
						return true;
					}
				}
				function testStringCoercion(value) {
					return "" + value;
				}
				function checkKeyStringCoercion(value) {
					if (willCoercionThrow(value)) {
						error("The provided key is an unsupported type %s. This value must be coerced to a string before before using it here.", typeName(value));
						return testStringCoercion(value);
					}
				}
				var ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;
				var RESERVED_PROPS = {
					key: true,
					ref: true,
					__self: true,
					__source: true
				};
				var specialPropKeyWarningShown;
				var specialPropRefWarningShown;
				var didWarnAboutStringRefs = {};
				function hasValidRef(config) {
					if (hasOwnProperty.call(config, "ref")) {
						var getter = Object.getOwnPropertyDescriptor(config, "ref").get;
						if (getter && getter.isReactWarning) return false;
					}
					return config.ref !== void 0;
				}
				function hasValidKey(config) {
					if (hasOwnProperty.call(config, "key")) {
						var getter = Object.getOwnPropertyDescriptor(config, "key").get;
						if (getter && getter.isReactWarning) return false;
					}
					return config.key !== void 0;
				}
				function warnIfStringRefCannotBeAutoConverted(config, self) {
					if (typeof config.ref === "string" && ReactCurrentOwner.current && self && ReactCurrentOwner.current.stateNode !== self) {
						var componentName = getComponentNameFromType(ReactCurrentOwner.current.type);
						if (!didWarnAboutStringRefs[componentName]) {
							error("Component \"%s\" contains the string ref \"%s\". Support for string refs will be removed in a future major release. This case cannot be automatically converted to an arrow function. We ask you to manually fix this case by using useRef() or createRef() instead. Learn more about using refs safely here: https://reactjs.org/link/strict-mode-string-ref", getComponentNameFromType(ReactCurrentOwner.current.type), config.ref);
							didWarnAboutStringRefs[componentName] = true;
						}
					}
				}
				function defineKeyPropWarningGetter(props, displayName) {
					var warnAboutAccessingKey = function() {
						if (!specialPropKeyWarningShown) {
							specialPropKeyWarningShown = true;
							error("%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://reactjs.org/link/special-props)", displayName);
						}
					};
					warnAboutAccessingKey.isReactWarning = true;
					Object.defineProperty(props, "key", {
						get: warnAboutAccessingKey,
						configurable: true
					});
				}
				function defineRefPropWarningGetter(props, displayName) {
					var warnAboutAccessingRef = function() {
						if (!specialPropRefWarningShown) {
							specialPropRefWarningShown = true;
							error("%s: `ref` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://reactjs.org/link/special-props)", displayName);
						}
					};
					warnAboutAccessingRef.isReactWarning = true;
					Object.defineProperty(props, "ref", {
						get: warnAboutAccessingRef,
						configurable: true
					});
				}
				/**
				* Factory method to create a new React element. This no longer adheres to
				* the class pattern, so do not use new to call it. Also, instanceof check
				* will not work. Instead test $$typeof field against Symbol.for('react.element') to check
				* if something is a React Element.
				*
				* @param {*} type
				* @param {*} props
				* @param {*} key
				* @param {string|object} ref
				* @param {*} owner
				* @param {*} self A *temporary* helper to detect places where `this` is
				* different from the `owner` when React.createElement is called, so that we
				* can warn. We want to get rid of owner and replace string `ref`s with arrow
				* functions, and as long as `this` and owner are the same, there will be no
				* change in behavior.
				* @param {*} source An annotation object (added by a transpiler or otherwise)
				* indicating filename, line number, and/or other information.
				* @internal
				*/
				var ReactElement = function(type, key, ref, self, source, owner, props) {
					var element = {
						$$typeof: REACT_ELEMENT_TYPE,
						type,
						key,
						ref,
						props,
						_owner: owner
					};
					element._store = {};
					Object.defineProperty(element._store, "validated", {
						configurable: false,
						enumerable: false,
						writable: true,
						value: false
					});
					Object.defineProperty(element, "_self", {
						configurable: false,
						enumerable: false,
						writable: false,
						value: self
					});
					Object.defineProperty(element, "_source", {
						configurable: false,
						enumerable: false,
						writable: false,
						value: source
					});
					if (Object.freeze) {
						Object.freeze(element.props);
						Object.freeze(element);
					}
					return element;
				};
				/**
				* https://github.com/reactjs/rfcs/pull/107
				* @param {*} type
				* @param {object} props
				* @param {string} key
				*/
				function jsxDEV(type, config, maybeKey, source, self) {
					var propName;
					var props = {};
					var key = null;
					var ref = null;
					if (maybeKey !== void 0) {
						checkKeyStringCoercion(maybeKey);
						key = "" + maybeKey;
					}
					if (hasValidKey(config)) {
						checkKeyStringCoercion(config.key);
						key = "" + config.key;
					}
					if (hasValidRef(config)) {
						ref = config.ref;
						warnIfStringRefCannotBeAutoConverted(config, self);
					}
					for (propName in config) if (hasOwnProperty.call(config, propName) && !RESERVED_PROPS.hasOwnProperty(propName)) props[propName] = config[propName];
					if (type && type.defaultProps) {
						var defaultProps = type.defaultProps;
						for (propName in defaultProps) if (props[propName] === void 0) props[propName] = defaultProps[propName];
					}
					if (key || ref) {
						var displayName = typeof type === "function" ? type.displayName || type.name || "Unknown" : type;
						if (key) defineKeyPropWarningGetter(props, displayName);
						if (ref) defineRefPropWarningGetter(props, displayName);
					}
					return ReactElement(type, key, ref, self, source, ReactCurrentOwner.current, props);
				}
				var ReactCurrentOwner$1 = ReactSharedInternals.ReactCurrentOwner;
				var ReactDebugCurrentFrame$1 = ReactSharedInternals.ReactDebugCurrentFrame;
				function setCurrentlyValidatingElement$1(element) {
					if (element) {
						var owner = element._owner;
						var stack = describeUnknownElementTypeFrameInDEV(element.type, element._source, owner ? owner.type : null);
						ReactDebugCurrentFrame$1.setExtraStackFrame(stack);
					} else ReactDebugCurrentFrame$1.setExtraStackFrame(null);
				}
				var propTypesMisspellWarningShown = false;
				/**
				* Verifies the object is a ReactElement.
				* See https://reactjs.org/docs/react-api.html#isvalidelement
				* @param {?object} object
				* @return {boolean} True if `object` is a ReactElement.
				* @final
				*/
				function isValidElement(object) {
					return typeof object === "object" && object !== null && object.$$typeof === REACT_ELEMENT_TYPE;
				}
				function getDeclarationErrorAddendum() {
					if (ReactCurrentOwner$1.current) {
						var name = getComponentNameFromType(ReactCurrentOwner$1.current.type);
						if (name) return "\n\nCheck the render method of `" + name + "`.";
					}
					return "";
				}
				function getSourceInfoErrorAddendum(source) {
					if (source !== void 0) {
						var fileName = source.fileName.replace(/^.*[\\\/]/, "");
						var lineNumber = source.lineNumber;
						return "\n\nCheck your code at " + fileName + ":" + lineNumber + ".";
					}
					return "";
				}
				/**
				* Warn if there's no key explicitly set on dynamic arrays of children or
				* object keys are not valid. This allows us to keep track of children between
				* updates.
				*/
				var ownerHasKeyUseWarning = {};
				function getCurrentComponentErrorInfo(parentType) {
					var info = getDeclarationErrorAddendum();
					if (!info) {
						var parentName = typeof parentType === "string" ? parentType : parentType.displayName || parentType.name;
						if (parentName) info = "\n\nCheck the top-level render call using <" + parentName + ">.";
					}
					return info;
				}
				/**
				* Warn if the element doesn't have an explicit key assigned to it.
				* This element is in an array. The array could grow and shrink or be
				* reordered. All children that haven't already been validated are required to
				* have a "key" property assigned to it. Error statuses are cached so a warning
				* will only be shown once.
				*
				* @internal
				* @param {ReactElement} element Element that requires a key.
				* @param {*} parentType element's parent's type.
				*/
				function validateExplicitKey(element, parentType) {
					if (!element._store || element._store.validated || element.key != null) return;
					element._store.validated = true;
					var currentComponentErrorInfo = getCurrentComponentErrorInfo(parentType);
					if (ownerHasKeyUseWarning[currentComponentErrorInfo]) return;
					ownerHasKeyUseWarning[currentComponentErrorInfo] = true;
					var childOwner = "";
					if (element && element._owner && element._owner !== ReactCurrentOwner$1.current) childOwner = " It was passed a child from " + getComponentNameFromType(element._owner.type) + ".";
					setCurrentlyValidatingElement$1(element);
					error("Each child in a list should have a unique \"key\" prop.%s%s See https://reactjs.org/link/warning-keys for more information.", currentComponentErrorInfo, childOwner);
					setCurrentlyValidatingElement$1(null);
				}
				/**
				* Ensure that every element either is passed in a static location, in an
				* array with an explicit keys property defined, or in an object literal
				* with valid key property.
				*
				* @internal
				* @param {ReactNode} node Statically passed child of any type.
				* @param {*} parentType node's parent's type.
				*/
				function validateChildKeys(node, parentType) {
					if (typeof node !== "object") return;
					if (isArray(node)) for (var i = 0; i < node.length; i++) {
						var child = node[i];
						if (isValidElement(child)) validateExplicitKey(child, parentType);
					}
					else if (isValidElement(node)) {
						if (node._store) node._store.validated = true;
					} else if (node) {
						var iteratorFn = getIteratorFn(node);
						if (typeof iteratorFn === "function") {
							if (iteratorFn !== node.entries) {
								var iterator = iteratorFn.call(node);
								var step;
								while (!(step = iterator.next()).done) if (isValidElement(step.value)) validateExplicitKey(step.value, parentType);
							}
						}
					}
				}
				/**
				* Given an element, validate that its props follow the propTypes definition,
				* provided by the type.
				*
				* @param {ReactElement} element
				*/
				function validatePropTypes(element) {
					var type = element.type;
					if (type === null || type === void 0 || typeof type === "string") return;
					var propTypes;
					if (typeof type === "function") propTypes = type.propTypes;
					else if (typeof type === "object" && (type.$$typeof === REACT_FORWARD_REF_TYPE || type.$$typeof === REACT_MEMO_TYPE)) propTypes = type.propTypes;
					else return;
					if (propTypes) {
						var name = getComponentNameFromType(type);
						checkPropTypes(propTypes, element.props, "prop", name, element);
					} else if (type.PropTypes !== void 0 && !propTypesMisspellWarningShown) {
						propTypesMisspellWarningShown = true;
						error("Component %s declared `PropTypes` instead of `propTypes`. Did you misspell the property assignment?", getComponentNameFromType(type) || "Unknown");
					}
					if (typeof type.getDefaultProps === "function" && !type.getDefaultProps.isReactClassApproved) error("getDefaultProps is only used on classic React.createClass definitions. Use a static property named `defaultProps` instead.");
				}
				/**
				* Given a fragment, validate that it can only be provided with fragment props
				* @param {ReactElement} fragment
				*/
				function validateFragmentProps(fragment) {
					var keys = Object.keys(fragment.props);
					for (var i = 0; i < keys.length; i++) {
						var key = keys[i];
						if (key !== "children" && key !== "key") {
							setCurrentlyValidatingElement$1(fragment);
							error("Invalid prop `%s` supplied to `React.Fragment`. React.Fragment can only have `key` and `children` props.", key);
							setCurrentlyValidatingElement$1(null);
							break;
						}
					}
					if (fragment.ref !== null) {
						setCurrentlyValidatingElement$1(fragment);
						error("Invalid attribute `ref` supplied to `React.Fragment`.");
						setCurrentlyValidatingElement$1(null);
					}
				}
				var didWarnAboutKeySpread = {};
				function jsxWithValidation(type, props, key, isStaticChildren, source, self) {
					var validType = isValidElementType(type);
					if (!validType) {
						var info = "";
						if (type === void 0 || typeof type === "object" && type !== null && Object.keys(type).length === 0) info += " You likely forgot to export your component from the file it's defined in, or you might have mixed up default and named imports.";
						var sourceInfo = getSourceInfoErrorAddendum(source);
						if (sourceInfo) info += sourceInfo;
						else info += getDeclarationErrorAddendum();
						var typeString;
						if (type === null) typeString = "null";
						else if (isArray(type)) typeString = "array";
						else if (type !== void 0 && type.$$typeof === REACT_ELEMENT_TYPE) {
							typeString = "<" + (getComponentNameFromType(type.type) || "Unknown") + " />";
							info = " Did you accidentally export a JSX literal instead of a component?";
						} else typeString = typeof type;
						error("React.jsx: type is invalid -- expected a string (for built-in components) or a class/function (for composite components) but got: %s.%s", typeString, info);
					}
					var element = jsxDEV(type, props, key, source, self);
					if (element == null) return element;
					if (validType) {
						var children = props.children;
						if (children !== void 0) if (isStaticChildren) if (isArray(children)) {
							for (var i = 0; i < children.length; i++) validateChildKeys(children[i], type);
							if (Object.freeze) Object.freeze(children);
						} else error("React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead.");
						else validateChildKeys(children, type);
					}
					if (hasOwnProperty.call(props, "key")) {
						var componentName = getComponentNameFromType(type);
						var keys = Object.keys(props).filter(function(k) {
							return k !== "key";
						});
						var beforeExample = keys.length > 0 ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
						if (!didWarnAboutKeySpread[componentName + beforeExample]) {
							error("A props object containing a \"key\" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />", beforeExample, componentName, keys.length > 0 ? "{" + keys.join(": ..., ") + ": ...}" : "{}", componentName);
							didWarnAboutKeySpread[componentName + beforeExample] = true;
						}
					}
					if (type === REACT_FRAGMENT_TYPE) validateFragmentProps(element);
					else validatePropTypes(element);
					return element;
				}
				function jsxWithValidationStatic(type, props, key) {
					return jsxWithValidation(type, props, key, true);
				}
				function jsxWithValidationDynamic(type, props, key) {
					return jsxWithValidation(type, props, key, false);
				}
				var jsx = jsxWithValidationDynamic;
				var jsxs = jsxWithValidationStatic;
				exports.Fragment = REACT_FRAGMENT_TYPE;
				exports.jsx = jsx;
				exports.jsxs = jsxs;
			})();
		}));
		//#endregion
		//#region src/client/ConnectorsSection.tsx
		var import_jsx_runtime = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
			if (process.env.NODE_ENV === "production") module.exports = require_react_jsx_runtime_production_min();
			else module.exports = require_react_jsx_runtime_development();
		})))();
		const GRID = {
			display: "grid",
			gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
			gap: 12
		};
		const CARD = {
			display: "flex",
			flexDirection: "column",
			gap: 8,
			padding: "14px 16px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			minWidth: 0
		};
		const HEAD = {
			display: "flex",
			alignItems: "flex-start",
			justifyContent: "space-between",
			gap: 8
		};
		const TITLE$1 = {
			fontSize: 15,
			margin: 0,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const DESC = {
			fontSize: 13,
			margin: 0,
			color: "var(--dsw-alias-label-secondary)",
			display: "-webkit-box",
			WebkitLineClamp: 2,
			WebkitBoxOrient: "vertical",
			overflow: "hidden",
			minHeight: 36
		};
		const STATUS = {
			fontSize: 12,
			margin: 0,
			flex: "none",
			paddingTop: 2
		};
		const BUTTON = {
			padding: "6px 12px",
			borderRadius: 6,
			border: "none",
			fontSize: 13,
			cursor: "pointer",
			background: "#2563eb",
			color: "#fff"
		};
		const INPUT = {
			padding: "6px 10px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13
		};
		const LABEL$1 = {
			fontSize: 12,
			margin: 0,
			color: "var(--dsw-alias-label-caption)"
		};
		const TOOLBAR = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			marginBottom: 16
		};
		const FILTER_BUTTON = {
			padding: "5px 10px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			cursor: "pointer"
		};
		const FILTER_ACTIVE = {
			...FILTER_BUTTON,
			background: "var(--dsw-alias-bg-layer-3)",
			color: "var(--dsw-alias-label-primary)"
		};
		const statusText = {
			disconnected: t("status.disconnected"),
			connecting: t("status.connecting"),
			connected: t("status.connected"),
			unauthorized: t("status.unauthorized"),
			error: t("status.error")
		};
		const statusColor = {
			disconnected: "var(--dsw-alias-label-caption)",
			connecting: "var(--dsw-alias-state-warn-primary)",
			connected: "var(--dsw-alias-state-success-primary)",
			unauthorized: "var(--dsw-alias-state-warn-primary)",
			error: "var(--dsw-alias-state-error-primary)"
		};
		async function fetchJson(url, init) {
			const res = await fetch(url, init);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${String(res.status)}`);
			}
			return await res.json();
		}
		function ConnectorCard({ entry, onChanged }) {
			const [formValues, setFormValues] = (0, import_react.useState)({});
			const [error, setError] = (0, import_react.useState)(null);
			const [busy, setBusy] = (0, import_react.useState)(null);
			const openedUrl = (0, import_react.useRef)(null);
			const activePopup = (0, import_react.useRef)(null);
			(0, import_react.useEffect)(() => {
				if (entry.request?.authorizeUrl && openedUrl.current !== entry.request.authorizeUrl) {
					openedUrl.current = entry.request.authorizeUrl;
					const popup = window.open(entry.request.authorizeUrl, "_blank");
					activePopup.current = popup;
					if (popup) {
						const timer = window.setInterval(() => {
							if (popup.closed) {
								window.clearInterval(timer);
								activePopup.current = null;
								fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/cancel`, { method: "POST" }).then(() => onChanged()).catch(() => {});
							}
						}, 500);
						window.setTimeout(() => window.clearInterval(timer), 31e4);
					}
				}
			}, [
				entry.request?.authorizeUrl,
				entry.id,
				onChanged
			]);
			const connect = (0, import_react.useCallback)(async () => {
				if (busy !== null) return;
				setError(null);
				setBusy("connect");
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/connect`, { method: "POST" });
					if (entry.request?.fields && entry.request.fields.length > 0) setFormValues({});
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e));
				} finally {
					setBusy(null);
				}
			}, [
				busy,
				entry.id,
				entry.request?.fields,
				onChanged
			]);
			const submitForm = (0, import_react.useCallback)(async () => {
				if (busy !== null) return;
				setError(null);
				setBusy("submit");
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/auth-submit`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ fields: formValues })
					});
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e));
				} finally {
					setBusy(null);
				}
			}, [
				busy,
				entry.id,
				formValues,
				onChanged
			]);
			const disconnect = (0, import_react.useCallback)(async () => {
				if (busy !== null) return;
				setError(null);
				setBusy("disconnect");
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/disconnect`, { method: "POST" });
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e));
				} finally {
					setBusy(null);
				}
			}, [
				busy,
				entry.id,
				onChanged
			]);
			const cancel = (0, import_react.useCallback)(async () => {
				if (busy !== null) return;
				setError(null);
				setBusy("disconnect");
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/cancel`, { method: "POST" });
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e));
				} finally {
					setBusy(null);
				}
			}, [
				busy,
				entry.id,
				onChanged
			]);
			const polling = entry.status === "connecting" && (entry.request?.authorizeUrl || entry.request?.verificationUrl);
			const needsForm = entry.status === "connecting" && Boolean(entry.request?.fields?.length);
			const isConnected = entry.status === "connected";
			const downloading = entry.status === "connecting" && Boolean(entry.request?.message);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: CARD,
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: HEAD,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							style: TITLE$1,
							title: entry.name,
							children: entry.name
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							style: {
								...STATUS,
								color: statusColor[entry.status] ?? "#c9ccd3"
							},
							children: statusText[entry.status] ?? entry.status
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: DESC,
						children: entry.description
					}),
					entry.request?.verificationUrl && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4
						},
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								style: LABEL$1,
								children: t("auth.verificationHint")
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
								href: entry.request.verificationUrl,
								target: "_blank",
								rel: "noreferrer",
								style: {
									fontSize: 12,
									color: "var(--dsw-alias-state-business-primary)",
									wordBreak: "break-all"
								},
								children: t("auth.authorizeLink")
							}),
							entry.request.userCode && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								style: LABEL$1,
								children: t("auth.code", { code: entry.request.userCode })
							})
						]
					}),
					entry.request?.authorizeUrl && !entry.request.verificationUrl && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							style: LABEL$1,
							children: t("auth.authorizeOpened")
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							href: entry.request.authorizeUrl,
							target: "_blank",
							rel: "noreferrer",
							style: {
								fontSize: 12,
								color: "var(--dsw-alias-state-business-primary)",
								wordBreak: "break-all"
							},
							children: t("auth.authorizeLink")
						})]
					}),
					needsForm && entry.request?.fields && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 8
						},
						children: [entry.request.fields.map((field) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 4
							},
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
								style: LABEL$1,
								htmlFor: `${entry.id}-${field.key}`,
								children: [field.label, field.required ? " *" : ""]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								id: `${entry.id}-${field.key}`,
								style: INPUT,
								type: field.type === "password" ? "password" : "text",
								value: formValues[field.key] ?? "",
								onChange: (e) => setFormValues((v) => ({
									...v,
									[field.key]: e.target.value
								}))
							})]
						}, field.key)), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON,
							disabled: busy === "submit",
							onClick: () => {
								submitForm();
							},
							children: busy === "submit" ? t("action.connecting") : t("action.submit")
						})]
					}),
					downloading && entry.request?.message && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: LABEL$1,
						children: entry.request.message
					}),
					polling && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: LABEL$1,
						children: t("auth.waiting")
					}),
					entry.error && !isConnected && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: {
							...STATUS,
							color: statusColor.error
						},
						children: friendlyConnectorError(entry.error)
					}),
					error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: {
							...STATUS,
							color: statusColor.error
						},
						children: error
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							marginTop: "auto",
							paddingTop: 4
						},
						children: isConnected ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...BUTTON,
								background: "var(--dsw-alias-state-error-primary)"
							},
							disabled: busy === "disconnect",
							onClick: () => {
								disconnect();
							},
							children: busy === "disconnect" ? t("action.disconnecting") : t("action.disconnect")
						}) : entry.status === "connecting" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...BUTTON,
								background: "var(--dsw-alias-state-warn-primary)"
							},
							disabled: busy === "disconnect",
							onClick: () => {
								cancel();
							},
							title: t("action.cancelHint"),
							children: busy === "disconnect" ? t("action.cancelling") : t("action.stop")
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON,
							disabled: busy === "connect",
							onClick: () => {
								connect();
							},
							children: busy === "connect" ? t("action.connecting") : t("action.connect")
						})
					})
				]
			});
		}
		function ConnectorsList() {
			const [connectors, setConnectors] = (0, import_react.useState)(null);
			const [query, setQuery] = (0, import_react.useState)("");
			const [statusFilter, setStatusFilter] = (0, import_react.useState)("all");
			const refresh = (0, import_react.useCallback)(() => {
				fetchJson("/api/pico/connectors").then((data) => setConnectors(data.connectors)).catch(() => setConnectors([]));
			}, []);
			(0, import_react.useEffect)(() => {
				refresh();
				const timer = setInterval(() => {
					refresh();
				}, 2e3);
				return () => clearInterval(timer);
			}, [refresh]);
			const visible = (0, import_react.useMemo)(() => {
				if (!connectors) return [];
				const q = query.trim().toLowerCase();
				return connectors.filter((c) => {
					if (statusFilter === "connected" && c.status !== "connected") return false;
					if (statusFilter === "disconnected" && c.status === "connected") return false;
					if (!q) return true;
					return c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
				});
			}, [
				connectors,
				query,
				statusFilter
			]);
			const connectedCount = (0, import_react.useMemo)(() => (connectors ?? []).filter((c) => c.status === "connected").length, [connectors]);
			if (connectors === null) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				style: DESC,
				children: t("status.connecting")
			});
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: TOOLBAR,
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							style: {
								...INPUT,
								flex: 1,
								minWidth: 0
							},
							placeholder: t("search.placeholder"),
							value: query,
							onChange: (e) => setQuery(e.target.value)
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: statusFilter === "all" ? FILTER_ACTIVE : FILTER_BUTTON,
							onClick: () => setStatusFilter("all"),
							children: t("filter.all")
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: statusFilter === "connected" ? FILTER_ACTIVE : FILTER_BUTTON,
							onClick: () => setStatusFilter("connected"),
							children: t("filter.connected")
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: statusFilter === "disconnected" ? FILTER_ACTIVE : FILTER_BUTTON,
							onClick: () => setStatusFilter("disconnected"),
							children: t("filter.disconnected")
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							style: {
								...LABEL$1,
								flex: "none"
							},
							children: t("filter.count", {
								connected: String(connectedCount),
								total: String(connectors.length)
							})
						})
					]
				}),
				visible.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					style: DESC,
					children: t("empty.noMatch")
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					style: GRID,
					children: visible.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConnectorCard, {
						entry,
						onChanged: refresh
					}, entry.id))
				})
			] });
		}
		//#endregion
		//#region src/client/ConnectorPanel.tsx
		const OVERLAY = {
			position: "fixed",
			inset: 0,
			zIndex: 1e3,
			display: "flex",
			alignItems: "center",
			justifyContent: "center"
		};
		const MASK = {
			position: "absolute",
			inset: 0,
			background: "var(--dsw-alias-bg-mask-1)",
			backdropFilter: "var(--dsw-mask-blur)"
		};
		const PANEL = {
			position: "relative",
			zIndex: 1,
			display: "flex",
			flexDirection: "column",
			width: 900,
			maxWidth: "calc(100vw - 48px)",
			height: "min(680px, calc(100vh - 48px))",
			borderRadius: 24,
			overflow: "hidden",
			background: "var(--dsw-alias-bg-layer-2)",
			boxShadow: "var(--dsw-shadow-lv3)"
		};
		const HEADER = {
			flex: "none",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			height: 54,
			boxSizing: "border-box",
			padding: "14px 18px"
		};
		const TITLE = {
			margin: 0,
			fontSize: 16,
			lineHeight: "24px",
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const CLOSE = {
			border: "none",
			background: "transparent",
			cursor: "pointer",
			color: "var(--dsw-alias-label-caption)",
			fontSize: 13,
			padding: "4px 8px",
			borderRadius: 6
		};
		const BODY = {
			flex: 1,
			minHeight: 0,
			overflowY: "auto",
			padding: 24
		};
		/**
		* Connector center modal: the registered connectors with their auth flows
		* (the connectors plugin's client half renders the list).
		* @param props.onClose - close the modal.
		*/
		function ConnectorPanel({ onClose }) {
			const panelRef = (0, import_react.useRef)(null);
			(0, import_react.useEffect)(() => {
				const onKey = (e) => {
					if (e.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				panelRef.current?.focus();
				return () => {
					window.removeEventListener("keydown", onKey);
				};
			}, [onClose]);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: OVERLAY,
				role: "presentation",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					style: MASK,
					"aria-hidden": "true",
					onClick: onClose
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: PANEL,
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("panel.title"),
					tabIndex: -1,
					ref: panelRef,
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: HEADER,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
							style: TITLE,
							children: t("panel.title")
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: CLOSE,
							onClick: onClose,
							children: t("panel.close")
						})]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: BODY,
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConnectorsList, {})
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/ConnectorTrigger.tsx
		const TRIGGER_WIDE = {
			flex: "none",
			display: "flex",
			alignItems: "center",
			gap: 8,
			width: "calc(100% + 8px)",
			height: 34,
			margin: "4px -4px 4px",
			padding: "6px 2px 6px 10px",
			boxSizing: "border-box",
			border: "none",
			borderRadius: 12,
			background: "transparent",
			cursor: "pointer",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 14,
			lineHeight: "22px"
		};
		const TRIGGER_RAIL = {
			...TRIGGER_WIDE,
			width: 36,
			height: 36,
			margin: "8px 0 10px",
			justifyContent: "center",
			gap: 0,
			padding: 0,
			borderRadius: "50%"
		};
		const LABEL = {
			overflow: "hidden",
			whiteSpace: "nowrap"
		};
		/**
		* Sidebar foot action opening the connector center modal, stacked above the
		* Skill center and Settings triggers (registered into `sidebar.footer.action`).
		* @param props - sidebar column state from the foot slot owner.
		*/
		/** Cross-plugin panel activation event (shared with cron/task/enterprise/browser). */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "connector-center";
		/**
		* Sidebar foot action opening the connector center modal, stacked above the
		* Skill center and Settings triggers (registered into `sidebar.footer.action`).
		* Opening this panel evicts sibling panels via the shared activation event;
		* a sibling activation closes this panel.
		* @param props - sidebar column state from the foot slot owner.
		*/
		function ConnectorTrigger(props) {
			const [open, setOpen] = (0, import_react.useState)(false);
			(0, import_react.useEffect)(() => {
				const onOtherActivate = (event) => {
					if (event.detail !== PANEL_NAME) setOpen(false);
				};
				document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
				return () => {
					document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				};
			}, []);
			const openPanel = () => {
				if (open) return;
				setOpen(true);
				document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
			};
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "pico-connector-trigger",
				style: props.wide ? TRIGGER_WIDE : TRIGGER_RAIL,
				"aria-expanded": open,
				onClick: openPanel,
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", {
					width: props.wide ? 16 : 18,
					height: props.wide ? 16 : 18,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
						x: "2.5",
						y: "6.5",
						width: "8",
						height: "8",
						rx: "1.5",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
						d: "M6 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M6 10.5h2",
						stroke: "currentColor",
						strokeWidth: "1.3",
						strokeLinecap: "round"
					})]
				}), props.wide && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					style: LABEL,
					children: "连接器"
				})]
			}), open && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConnectorPanel, { onClose: () => {
				setOpen(false);
			} })] });
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Connectors client half: registers the connector center foot action in the
		* sidebar (its modal renders the connector list and drives the auth flows),
		* and registers one slash command per CONNECTED connector (`/<connector-id>`)
		* so the `/` menu only shows connectors you can act on. Picking an example
		* prompt sends it to the session — the model then calls the connector's
		* injected MCP tools.
		*/
		const name = "pico-connectors-client";
		const LOCALE_NS = "connectors";
		const inject = [
			"commandUi",
			"sessions",
			"slots",
			"locale"
		];
		const POLL_INTERVAL_MS = 3e3;
		function apply(ctx) {
			ctx.effect(() => {
				const off = ctx.locale.register(LOCALE_NS, {
					zh,
					en
				});
				return () => {
					off();
				};
			}, "connectors: client dictionaries");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".pico-connector-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }";
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, "connectors: trigger hover style");
			ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "connector-center",
				order: 0
			}, ConnectorTrigger)), "connectors: connector center foot action");
			const commandUi = ctx.get("commandUi");
			const sessions = ctx.get("sessions");
			const commandDisposers = /* @__PURE__ */ new Map();
			const syncCommands = (connectors) => {
				const connected = new Set(connectors.filter((c) => c.status === "connected").map((c) => c.id));
				for (const [id, dispose] of commandDisposers) if (!connected.has(id)) {
					dispose();
					commandDisposers.delete(id);
				}
				for (const connector of connectors) {
					if (connector.status !== "connected" || commandDisposers.has(connector.id)) continue;
					commandDisposers.set(connector.id, commandUi.register({
						name: connector.id,
						description: `${connector.name}（已连接）`,
						available: () => true,
						ui: {
							kind: "popupSelect",
							options: async () => {
								return [...(connector.examples ?? []).map((example, index) => ({
									id: `example-${index}`,
									label: example
								})), {
									id: "info",
									label: "查看连接器信息"
								}];
							},
							onSelect: async (option, session) => {
								const live = sessions.binding(session.sessionId)?.session;
								if (live === void 0) return;
								const text = option.id === "info" ? `${connector.name}（已连接）。模型可直接调用其注入工具（mcp__*），例如：${(connector.examples ?? []).join("、")}` : option.label;
								await live.prompt([{
									type: "text",
									text
								}], "queue");
							}
						}
					}));
				}
			};
			ctx.effect(() => {
				let cancelled = false;
				const poll = async () => {
					try {
						const res = await fetch("/api/pico/connectors");
						if (!res.ok) return;
						const data = await res.json();
						if (!cancelled) syncCommands(data.connectors ?? []);
					} catch {}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_INTERVAL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
					for (const dispose of commandDisposers.values()) dispose();
				};
			}, "pico-connectors-client: per-connector slash commands");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map