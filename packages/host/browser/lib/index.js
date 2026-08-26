import { createRequire } from "node:module";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region \0rolldown/runtime.js
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
		if (a.byteLength !== b.byteLength) return false;
		const viewA = new Uint8Array(a);
		const viewB = new Uint8Array(b);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region node_modules/@deepseek-ai/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
const resolvers = {};
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region src/electron-adapter.ts
/**
* Persistent browser partition: login sessions survive app restarts and stay
* isolated from the main application's cookies/storage. The partition name is
* per-user (`persist:agent-browser-<encoded-user>`), so a user switch never
* exposes A's website logins to B. The username is hex-encoded with the same
* scheme as the connectors user scope (no separators, no dots).
*
* CROSS-PACKAGE CONSTRAINT (2026-08-22): this encoding intentionally mirrors
* `@picoaide/dsh-connectors` `encodeSegment` (user-scope.ts) byte-for-byte —
* the two are implemented separately because cross-package runtime imports
* are forbidden, but they must NEVER diverge (a divergence would let the
* browser partition name collide with, or shadow, a connectors user dir, or
* break the injective property). Keep the charset: A-Za-z0-9_- literal, all
* else `~<HEX>~`. `tests/partition.spec.ts` locks the examples.
*/
function encodePartitionSegment(segment) {
	let out = "";
	for (const char of segment) {
		const code = char.codePointAt(0);
		if (code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || char === "-" || char === "_") out += char;
		else out += `~${code.toString(16).toUpperCase()}~`;
	}
	return out.length === 0 ? "anonymous" : out;
}
/** Partition name for a logged-in (or anonymous) user. */
function browserPartitionFor(username) {
	return `persist:agent-browser-${encodePartitionSegment(username !== void 0 && username !== null && username.length > 0 ? username : "anonymous")}`;
}
/** Legacy fixed partition name (pre-user-scope); kept for tests/back-compat. */
const BROWSER_PARTITION = browserPartitionFor(null);
/** Default browser window size (DIP). */
const BROWSER_WINDOW_DEFAULT = {
	width: 1100,
	height: 780
};
/** Lazy real adapter over Electron (imported only on first browser start). */
function createRealElectronAdapter() {
	const { WebContentsView, BrowserWindow, dialog } = __require("electron");
	const createView = (partition = BROWSER_PARTITION) => {
		const view = new WebContentsView({ webPreferences: {
			partition,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		} });
		const wc = view.webContents;
		wc.setWindowOpenHandler(() => ({ action: "deny" }));
		return {
			partition,
			attach(win, bounds) {
				win.contentView.addChildView(view);
				view.setBounds(bounds);
			},
			setBounds(bounds) {
				view.setBounds(bounds);
			},
			setVisible(visible) {
				view.setVisible(visible);
			},
			detach() {},
			moveToTop(win) {
				try {
					win.contentView.removeChildView(view);
				} catch {}
				win.contentView.addChildView(view);
			},
			webContents: {
				cdp: wc.debugger,
				loadURL: (url) => wc.loadURL(url),
				goBack: () => wc.goBack(),
				goForward: () => wc.goForward(),
				reload: () => wc.reload(),
				capturePage: (rect) => wc.capturePage(rect),
				getURL: () => wc.getURL(),
				getTitle: () => wc.getTitle(),
				isLoading: () => wc.isLoading(),
				on: (event, listener) => {
					wc.on(event, listener);
				},
				removeListener: (event, listener) => {
					wc.removeListener(event, listener);
				},
				session: wc.session,
				setWindowOpenHandler: (handler) => {
					wc.setWindowOpenHandler((details) => handler(details));
				},
				close: () => wc.close(),
				isDestroyed: () => wc.isDestroyed()
			},
			destroy() {
				if (!view.webContents.isDestroyed()) view.webContents.close();
			}
		};
	};
	return {
		createView,
		createMaskView(partition = BROWSER_PARTITION) {
			const view = new WebContentsView({ webPreferences: {
				partition,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				transparent: true
			} });
			const wc = view.webContents;
			wc.setWindowOpenHandler(() => ({ action: "deny" }));
			return {
				partition,
				attach(win, bounds) {
					win.contentView.addChildView(view);
					view.setBounds(bounds);
				},
				setBounds(bounds) {
					view.setBounds(bounds);
				},
				setVisible(visible) {
					view.setVisible(visible);
				},
				detach() {},
				moveToTop(win) {
					try {
						win.contentView.removeChildView(view);
					} catch {}
					win.contentView.addChildView(view);
				},
				webContents: {
					cdp: wc.debugger,
					loadURL: (url) => wc.loadURL(url),
					goBack: () => wc.goBack(),
					goForward: () => wc.goForward(),
					reload: () => wc.reload(),
					capturePage: (rect) => wc.capturePage(rect),
					getURL: () => wc.getURL(),
					getTitle: () => wc.getTitle(),
					isLoading: () => wc.isLoading(),
					on: (event, listener) => {
						wc.on(event, listener);
					},
					removeListener: (event, listener) => {
						wc.removeListener(event, listener);
					},
					session: wc.session,
					setWindowOpenHandler: (handler) => {
						wc.setWindowOpenHandler((details) => handler(details));
					},
					close: () => wc.close(),
					isDestroyed: () => wc.isDestroyed()
				},
				destroy() {
					if (!view.webContents.isDestroyed()) view.webContents.close();
				}
			};
		},
		createBrowserWindow() {
			let allowClose = false;
			const win = new BrowserWindow({
				width: BROWSER_WINDOW_DEFAULT.width,
				height: BROWSER_WINDOW_DEFAULT.height,
				title: "PicoAide 浏览器",
				show: true,
				backgroundColor: "#f2f3f5",
				webPreferences: {
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true
				}
			});
			win.setMenuBarVisibility(false);
			win.on("close", (event) => {
				if (!allowClose) {
					event.preventDefault();
					win.hide();
				}
			});
			const resizeListeners = /* @__PURE__ */ new Set();
			win.on("resize", () => {
				for (const listener of resizeListeners) try {
					listener();
				} catch {}
			});
			const closedListeners = /* @__PURE__ */ new Set();
			win.on("closed", () => {
				for (const listener of closedListeners) try {
					listener();
				} catch {}
			});
			return {
				loadURL: (url) => win.loadURL(url),
				show: () => {
					if (win.isDestroyed()) return;
					win.show();
					win.focus();
				},
				hide: () => {
					if (win.isDestroyed()) return;
					win.hide();
				},
				focus: () => {
					if (win.isDestroyed()) return;
					win.focus();
				},
				isVisible: () => !win.isDestroyed() && win.isVisible(),
				isDestroyed: () => win.isDestroyed(),
				close: () => {
					if (win.isDestroyed()) return;
					allowClose = true;
					win.close();
				},
				setTitle: (title) => {
					if (win.isDestroyed()) return;
					win.setTitle(title);
				},
				getContentSize: () => {
					const [width, height] = win.getContentSize();
					return {
						width: width ?? 0,
						height: height ?? 0
					};
				},
				contentView: win.contentView,
				onResize(listener) {
					resizeListeners.add(listener);
					return () => {
						resizeListeners.delete(listener);
					};
				},
				onClosed(listener) {
					closedListeners.add(listener);
					return () => {
						closedListeners.delete(listener);
					};
				}
			};
		},
		showSaveDialog: async (options) => {
			const result = await dialog.showSaveDialog(options);
			return {
				canceled: result.canceled,
				filePath: result.filePath
			};
		}
	};
}
//#endregion
//#region src/loopback.ts
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/**
* Request-level trust fence: a loopback socket address AND a loopback Host
* header, plus browser same-origin markers. A bare curl from the same host
* passes the socket/Host checks; a cross-site browser request is refused.
*/
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/**
* Browser-signal tripwire, NOT an authority check: a bare curl sends neither
* header and is refused, but a curl with a forged Origin passes this too.
* The real boundary is the loopback socket + Host + origin-equality checks
* in isLoopbackRequest; do not rely on this marker alone.
*/
function browserSameOriginMarker(req) {
	return req.headers["sec-fetch-site"] === "same-origin" || typeof req.headers.origin === "string";
}
//#endregion
//#region src/cdp.ts
/** One established CDP session over a transport. */
var CdpSession = class {
	transport;
	listeners = /* @__PURE__ */ new Map();
	messageListener;
	closed = false;
	constructor(transport) {
		this.transport = transport;
		this.messageListener = (_event, method, params) => {
			const set = this.listeners.get(method);
			if (set === void 0) return;
			for (const handler of [...set]) try {
				handler(params);
			} catch {}
		};
	}
	/** Attach with the stable protocol version, failing loudly on double attach. */
	async attach() {
		if (this.transport.isAttached()) throw new Error("browser: CDP already attached");
		this.transport.attach("1.3");
		this.transport.on("message", this.messageListener);
		this.closed = false;
	}
	/** Send one CDP command; rejects when the session is closed or the command fails. */
	async send(method, params = {}) {
		if (this.closed) throw new Error(`browser: CDP session closed (${method})`);
		return await this.transport.sendCommand(method, params);
	}
	/** Subscribe to one CDP method; returns a disposer. */
	on(method, handler) {
		let set = this.listeners.get(method);
		if (set === void 0) {
			set = /* @__PURE__ */ new Set();
			this.listeners.set(method, set);
		}
		set.add(handler);
		return () => {
			set?.delete(handler);
		};
	}
	/** Detach idempotently and clear all subscriptions. */
	detach() {
		if (this.closed) return;
		this.closed = true;
		this.listeners.clear();
		this.transport.removeListener("message", this.messageListener);
		if (this.transport.isAttached()) try {
			this.transport.detach();
		} catch {}
	}
};
/** Schemes the embedded browser may navigate to. */
const ALLOWED_SCHEMES = /* @__PURE__ */ new Set([
	"http:",
	"https:",
	"about:"
]);
/** Maximum URL length accepted from the model (hostile-input bound). */
const MAX_URL_LENGTH = 8192;
/**
* Classify a navigation target under the deployment policy:
* - http(s) → `allow` (regular navigation does not prompt);
* - about:blank / about:srcdoc → `allow`;
* - everything else (`javascript:`, `data:`, `file:`, `chrome:`, …) → `deny`.
* `approve` is reserved for sensitive actions decided at tool level (form
* submission, password entry, eval).
*/
function classifyNavigation(rawUrl) {
	if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return "deny";
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return "allow";
	}
	if (!ALLOWED_SCHEMES.has(parsed.protocol)) return "deny";
	return "allow";
}
/**
* Guard bundle bound to one plugin lifetime. The download and permission
* hooks are bound to the browser session by the runtime. There is no
* approval seam: every browser action runs without a user prompt (product
* decision 2026-08-26).
*/
var BrowserGuard = class {
	adapter;
	constructor(adapter) {
		this.adapter = adapter;
	}
	/** Decide a navigation: `true` lets it proceed. */
	allowNavigation(rawUrl) {
		return classifyNavigation(rawUrl) === "allow";
	}
	/**
	* Install the download interception on a session: every download is either
	* routed to a user-chosen save path (bounded size) or cancelled. The user
	* participates through the native save dialog, so no approval prompt is
	* needed — but the outcome lands in the op log.
	*/
	installDownloadGuard(session, onDownload) {
		const listener = (_event, item) => {
			const filename = item.getFilename() || "download";
			let received = 0;
			let rejected = false;
			const onUpdated = () => {
				received = item.getReceivedBytes();
				if (received > 104857600 && !rejected) {
					rejected = true;
					item.cancel();
					onDownload(`download rejected (>100MB): ${filename}`);
				}
			};
			item.on?.("updated", onUpdated);
			if (item.getReceivedBytes() > 104857600) {
				rejected = true;
				item.cancel();
				onDownload(`download rejected (>100MB): ${filename}`);
				return;
			}
			(async () => {
				const result = await this.adapter.showSaveDialog({
					title: "Save download",
					defaultPath: filename
				});
				if (result.canceled || result.filePath === void 0 || result.filePath === "") {
					item.cancel();
					onDownload(`download cancelled by user: ${filename}`);
					return;
				}
				item.setSavePath(result.filePath);
				onDownload(`download saved to ${result.filePath}: ${filename}`);
			})().catch(() => {
				item.cancel();
			});
		};
		session.on("will-download", listener);
		return () => {
			session.removeListener("will-download", listener);
		};
	}
};
/** Default permission stance: everything is denied unless the user grants it. */
function installPermissionGuard(session) {
	session.setPermissionRequestHandler((_wc, _permission, callback) => {
		callback(false);
	});
	return () => {};
}
/** Cap on extracted text characters per call. */
const TEXT_LIMIT = 32 * 1024;
/**
* Probe script: collect interactable elements in DOM order. The page can see
* and influence this code, so it must (a) produce plain JSON only, (b) never
* touch anything outside the page, and (c) fail softly on every element.
*/
const SNAPSHOT_PROBE = `
(() => {
  const out = [];
  const seen = new Set();
  const MAX = 200;
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox' || t === 'radio') return 'input';
      return 'input';
    }
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (el.getAttribute && el.getAttribute('role') === 'button') return 'button';
    return null;
  };
  const textOf = (el) => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.value || '').slice(0, 80);
    }
    if (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) {
      return (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 80);
    }
    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, 80);
  };
  const selectorOf = (el) => {
    if (el.id) {
      const id = String(el.id);
      if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id)) return '#' + id;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 3) {
      const tag = node.tagName.toLowerCase();
      let nth = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) nth++; sib = sib.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visibleOf = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const walk = (root) => {
    if (out.length >= MAX) return;
    const nodes = root.querySelectorAll('a,button,input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])');
    for (const el of nodes) {
      if (out.length >= MAX) break;
      if (seen.has(el)) continue;
      seen.add(el);
      const kind = kindOf(el);
      if (!kind) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      out.push({
        kind,
        text: textOf(el),
        selector: selectorOf(el),
        visible: visibleOf(el),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      });
    }
  };
  walk(document.body || document.documentElement);
  return out;
})()
`;
/**
* Extract the interactable-element snapshot of the current page through the
* given CDP session. Bounded to `snapshotLimit` entries; each entry carries a
* stable `index` (1-based) that click/type/select target.
*/
async function extractSnapshot(send, snapshotLimit = 200) {
	const result = await send("Runtime.evaluate", {
		expression: SNAPSHOT_PROBE,
		returnByValue: true,
		awaitPromise: false
	});
	if (result.exceptionDetails !== void 0) throw new Error("browser: snapshot probe failed on this page");
	const raw = result.result?.value;
	if (!Array.isArray(raw)) return [];
	const limit = Math.max(1, Math.min(snapshotLimit, 200));
	const out = [];
	for (const entry of raw.slice(0, limit)) {
		if (typeof entry !== "object" || entry === null) continue;
		const { kind, text, selector, visible, disabled } = entry;
		if (typeof kind !== "string" || typeof selector !== "string") continue;
		out.push({
			index: out.length + 1,
			kind: [
				"link",
				"button",
				"input",
				"select",
				"textarea",
				"other"
			].includes(kind) ? kind : "other",
			text: typeof text === "string" ? text.slice(0, 80) : "",
			selector,
			visible: visible === true,
			disabled: disabled === true
		});
	}
	return out;
}
/** Extract visible text of the page (or of `selector` when given), bounded. */
async function extractText(send, selector, textLimit = TEXT_LIMIT) {
	const result = await send("Runtime.evaluate", {
		expression: selector === void 0 || selector.trim() === "" ? `(document.body ? document.body.innerText : '')` : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`,
		returnByValue: true,
		awaitPromise: false
	});
	if (result.exceptionDetails !== void 0) throw new Error("browser: text extraction failed on this page");
	const text = typeof result.result?.value === "string" ? result.result.value : "";
	const limit = Math.max(1, Math.min(textLimit, TEXT_LIMIT));
	return text.slice(0, limit);
}
//#endregion
//#region src/shots.ts
/** Default screenshot max width (CSS pixels). */
const SCREENSHOT_MAX_WIDTH = 1280;
/**
* Capture the visible page and return a JPEG data URL. The image is downscaled
* when wider than `maxWidth`; `quality` trades bytes against fidelity (both
* owned by the deployment, not the model).
*/
async function captureScreenshot(webContents, maxWidth = SCREENSHOT_MAX_WIDTH, quality = 70) {
	if (webContents.isDestroyed()) throw new Error("browser: tab was destroyed");
	const image = await webContents.capturePage();
	const { width } = image.getSize();
	const clampedQuality = Math.max(1, Math.min(100, quality));
	let out = image;
	if (width > maxWidth) out = image.resize({
		width: Math.max(1, maxWidth),
		quality: "good"
	});
	return `data:image/jpeg;base64,${out.toJPEG(clampedQuality).toString("base64")}`;
}
/** Op-log ring size. */
const OP_LOG_LIMIT = 200;
/** A promise-queue mutex that also honors user takeover. */
var ControlMutex = class {
	tail = Promise.resolve();
	taken = false;
	/** Resolved when the current takeover ends (recreated on each take). */
	released = Promise.resolve();
	releaseTaken;
	/**
	* Run `work` while holding the browser control. When the user takes over,
	* the call PAUSES (the whole agent loop blocks on this promise) until the
	* takeover is released; `signal` (the agent step's abort signal) exits the
	* wait when the agent is stopped or a tool deadline fires.
	*/
	async run(work, signal) {
		const prev = this.tail;
		let release;
		this.tail = new Promise((resolve) => {
			release = resolve;
		});
		await prev;
		while (this.taken) {
			if (signal !== void 0 && signal.aborted) {
				release();
				throw new Error("browser: agent was stopped while the user controlled the browser");
			}
			await new Promise((resolveWait) => {
				let done = false;
				const settle = () => {
					if (done) return;
					done = true;
					if (signal !== void 0) signal.removeEventListener("abort", onAbort);
					resolveWait();
				};
				const onAbort = () => settle();
				if (signal !== void 0) {
					if (signal.aborted) return settle();
					signal.addEventListener("abort", onAbort, { once: true });
				}
				this.released.then(settle);
			});
		}
		try {
			return await work();
		} finally {
			release();
		}
	}
	/** User takeover: block agent operations until released. */
	take() {
		this.taken = true;
		this.released = new Promise((resolve) => {
			this.releaseTaken = resolve;
		});
	}
	release() {
		if (!this.taken) return;
		this.taken = false;
		this.releaseTaken();
	}
	get controlled() {
		return this.taken;
	}
};
/**
* The embedded browser service. Constructed by the plugin with the real
* adapter; tests inject a mock adapter plus a fake approval asker.
*/
var BrowserRuntime = class {
	adapter;
	credentials;
	tabs = /* @__PURE__ */ new Map();
	nextTabId = 1;
	visibleTabId;
	mutex = new ControlMutex();
	/** Loopback origin serving the shell/mask pages (set by the plugin). */
	shellOrigin;
	ops = [];
	opSeq = 0;
	window = null;
	mask = null;
	guard;
	permissionsDisposers = [];
	downloadDisposers = [];
	windowResizeDisposer = null;
	windowClosedDisposer = null;
	disposed = false;
	/** Partition name used for newly created tab views (per-user). */
	partition;
	/** Whether an agent browser operation is currently in flight (mask status). */
	busy = false;
	/** The agent tool currently executing ('' when idle). */
	busyTool = "";
	constructor(adapter, options = {}, credentials, partition) {
		this.adapter = adapter;
		this.credentials = credentials;
		this.options = {
			maxTabs: options.maxTabs ?? 8,
			timeoutMs: options.timeoutMs ?? 3e4,
			loadTimeoutMs: options.loadTimeoutMs ?? 2e4,
			evalEnabled: options.evalEnabled ?? true,
			snapshotLimit: options.snapshotLimit ?? 200,
			textLimit: options.textLimit ?? 32 * 1024,
			screenshotMaxWidth: options.screenshotMaxWidth ?? 1280,
			screenshotQuality: options.screenshotQuality ?? 70
		};
		this.guard = new BrowserGuard(adapter);
		this.partition = partition ?? BROWSER_PARTITION;
	}
	/** Swap the partition used by NEW tab views (user switch). Existing tabs
	* keep their partition; callers close all tabs first. */
	setPartition(partition) {
		this.partition = partition;
	}
	options;
	/** Current browser window state (created + visible). */
	get windowState() {
		return {
			created: this.window !== null && !this.window.isDestroyed(),
			visible: this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
		};
	}
	/** Recent audit op log (newest first). */
	get opLog() {
		return [...this.ops].reverse();
	}
	/** Snapshot of all tabs. */
	listTabs() {
		return [...this.tabs.values()].map((tab) => ({
			id: tab.id,
			url: tab.url,
			title: tab.title,
			loading: tab.loading,
			visible: tab.id === this.visibleTabId
		}));
	}
	get controlled() {
		return this.mutex.controlled;
	}
	/** Whether an agent browser operation is running right now. */
	get isBusy() {
		return this.busy;
	}
	/** The agent tool currently executing ('' when idle). */
	get busyToolName() {
		return this.busyTool;
	}
	/** Latest completed agent operation (mask "recent activity" line). */
	get latestOp() {
		return this.ops.at(-1);
	}
	/** Id of the visible tab, or undefined when none is open. */
	currentTabId() {
		return this.visibleTabId;
	}
	/** Public tab state (throws for unknown ids). */
	tabState(id) {
		return this.tabStateInternal(id);
	}
	/** Content-area bounds below the shell toolbar (DIP). */
	contentBounds() {
		const size = this.window?.getContentSize() ?? {
			width: 0,
			height: 0
		};
		return {
			x: 0,
			y: 84,
			width: Math.max(0, size.width),
			height: Math.max(0, size.height - 84)
		};
	}
	/** Re-layout every tab view + the mask over the window content area. */
	relayout() {
		const bounds = this.contentBounds();
		for (const tab of this.tabs.values()) {
			tab.view.setBounds(bounds);
			tab.view.setVisible(tab.id === this.visibleTabId);
		}
		if (this.mask !== null) {
			this.mask.setBounds(bounds);
			if (this.window !== null && !this.window.isDestroyed()) this.mask.moveToTop(this.window);
			this.applyMaskVisibility();
		}
	}
	/**
	* Mask visibility policy: the AI-control overlay stays over the content
	* area whenever the agent holds control (i.e. the user has NOT taken
	* over). It is TRANSLUCENT (the mask view is created with `transparent:
	* true`, see electron-adapter.ts) so the user can see exactly what the AI
	* is doing, and it displays the in-flight tool + recent operations. When
	* the user takes over the overlay hides; releasing restores it.
	*/
	applyMaskVisibility() {
		if (this.mask === null) return;
		this.mask.setVisible(!this.mutex.controlled);
	}
	/**
	* Ensure the dedicated browser window exists and is shown. Creating the
	* window also loads the control-shell page and mounts the AI-control mask.
	* @param origin - the loopback webServer origin (e.g. `http://127.0.0.1:33407`)
	*   the shell/mask pages are served from; without it the window cannot load
	*   them (Electron needs absolute URLs).
	*/
	async ensureWindow(origin) {
		if (this.window !== null && !this.window.isDestroyed()) {
			this.window.show();
			return this.window;
		}
		const win = this.adapter.createBrowserWindow();
		this.window = win;
		const mask = this.adapter.createMaskView();
		this.mask = mask;
		mask.attach(win, this.contentBounds());
		if (origin !== void 0) {
			mask.webContents.loadURL(`${origin}/browser-mask`).catch((cause) => {
				mask.webContents.loadURL(`${origin}/browser-mask`).catch(() => {
					console.error("[dsh-browser] mask page failed to load", cause);
				});
			});
			win.loadURL(`${origin}/browser-shell`).catch((cause) => {
				win.loadURL(`${origin}/browser-shell`).catch(() => {
					console.error("[dsh-browser] shell page failed to load", cause);
				});
			});
		}
		this.applyMaskVisibility();
		this.windowResizeDisposer = win.onResize(() => {
			this.relayout();
		});
		this.windowClosedDisposer = win.onClosed(() => {
			for (const tab of this.tabs.values()) try {
				tab.cdp.detach();
				tab.view.destroy();
			} catch {}
			this.tabs.clear();
			this.visibleTabId = void 0;
			this.mask = null;
			this.windowResizeDisposer?.();
			this.windowClosedDisposer?.();
			this.windowResizeDisposer = null;
			this.windowClosedDisposer = null;
			this.window = null;
		});
		return win;
	}
	/** Set the loopback origin the shell/mask pages are served from. */
	setShellOrigin(origin) {
		this.shellOrigin = origin;
	}
	/** Show the browser window (wake from a user close; the sidebar trigger).
	* When the window has never been created (sidebar clicked before any agent
	* open), create it now — the shell loads with an empty tab strip and the
	* 「+」 button starts the first tab. */
	async showWindow() {
		if (this.window === null || this.window.isDestroyed()) {
			await this.ensureWindow(this.shellOrigin);
			this.relayout();
			return;
		}
		this.window.show();
		this.relayout();
	}
	/** Hide the browser window without destroying tabs (user close semantics). */
	hideWindow() {
		if (this.window === null || this.window.isDestroyed()) return;
		this.window.hide();
	}
	record(tool, tab, summary, failed = false) {
		this.ops.push({
			seq: ++this.opSeq,
			time: Date.now(),
			tool,
			tab,
			summary: maskBrowserSummary(summary),
			failed
		});
		if (this.ops.length > OP_LOG_LIMIT) this.ops.shift();
	}
	/** Resolve a tab by id; throws with a model-facing message. */
	tab(id) {
		const tab = this.tabs.get(id);
		if (tab === void 0) throw new Error(`browser: unknown tab ${id}`);
		return tab;
	}
	updateTabState(tab) {
		const wc = tab.view.webContents;
		if (wc.isDestroyed()) return;
		tab.url = wc.getURL();
		tab.title = wc.getTitle() || tab.url || "";
		tab.loading = wc.isLoading();
	}
	/**
	* Create a tab and optionally navigate it. The first tab becomes visible.
	* Runs under the control mutex so a user takeover also pauses tab opening
	* (and the agent's abort signal can cancel it while paused); the shell
	* toolbar's own `+` button passes `user=true` and bypasses the mutex.
	*/
	async open(url, signal, user = false) {
		const body = async () => {
			if (this.disposed) throw new Error("browser: runtime disposed");
			if (this.tabs.size >= this.options.maxTabs) throw new Error(`browser: tab limit reached (${this.options.maxTabs}); close a tab first`);
			const id = this.nextTabId++;
			const view = this.adapter.createView(this.partition);
			const cdp = new CdpSession(view.webContents.cdp);
			try {
				await cdp.attach();
			} catch (cause) {
				try {
					view.destroy();
				} catch {}
				throw cause;
			}
			const tab = {
				id,
				view,
				cdp,
				url: "",
				title: "",
				loading: false
			};
			this.tabs.set(id, tab);
			const win = await this.ensureWindow(this.shellOrigin);
			const bounds = this.contentBounds();
			view.attach(win, bounds);
			view.setVisible(true);
			this.visibleTabId = id;
			this.relayout();
			view.webContents.on("did-start-loading", () => {
				tab.loading = true;
			});
			view.webContents.on("did-stop-loading", () => {
				tab.loading = false;
				this.updateTabState(tab);
			});
			view.webContents.on("did-navigate", () => this.updateTabState(tab));
			view.webContents.on("page-title-updated", () => this.updateTabState(tab));
			const session = view.webContents.session;
			this.permissionsDisposers.push(installPermissionGuard(session));
			this.downloadDisposers.push(this.guard.installDownloadGuard(session, (summary) => {
				this.record("browser_download", id, summary);
			}));
			if (url !== void 0 && url !== "") try {
				await this.navigateInternal(id, url, "domcontentloaded");
			} catch (cause) {
				try {
					cdp.detach();
					view.destroy();
				} catch {}
				this.tabs.delete(id);
				if (this.visibleTabId === id) this.visibleTabId = void 0;
				throw cause;
			}
			this.updateTabState(tab);
			this.record("browser_open", id, url === void 0 || url === "" ? "new tab" : url);
			return this.tabState(id);
		};
		if (user) return await body();
		return await this.agentRun("browser_open", body, signal);
	}
	tabStateInternal(id) {
		const tab = this.tab(id);
		return {
			id: tab.id,
			url: tab.url,
			title: tab.title,
			loading: tab.loading,
			visible: tab.id === this.visibleTabId
		};
	}
	/** Run one agent operation under the control mutex. Passes the agent's
	* abort signal so a takeover pauses the loop until release (or the agent
	* stops). While the operation is in flight, `isBusy`/`busyToolName` expose
	* it to the mask overlay ("AI is currently doing X").
	*
	* `summary` (when given) is recorded in the op log on success so the
	* overlay's "recent activity" line shows what the agent actually did. */
	async withControl(tool, tabId, work, signal, summary) {
		return await this.agentRun(tool, async () => {
			const tab = this.tab(tabId);
			const result = await work(tab);
			this.updateTabState(tab);
			if (summary !== void 0) this.record(tool, tabId, summary);
			return result;
		}, signal);
	}
	/** Run `body` under the control mutex while flagging the in-flight agent
	* tool (mask status). The flag covers the whole wait incl. a user
	* takeover pause; it clears only when the operation truly finishes. */
	async agentRun(tool, body, signal) {
		this.busy = true;
		this.busyTool = tool;
		try {
			return await this.mutex.run(body, signal);
		} finally {
			this.busy = false;
			this.busyTool = "";
		}
	}
	/**
	* Navigate the tab to `url`, waiting per `waitUntil`.
	*
	* Electron's `loadURL` promise settles on `did-finish-load`, which pages
	* with long-lived connections (polls, SSE, analytics) can delay well past
	* the page being interactive. Racing it against `loadTimeoutMs` keeps the
	* tool call from dying on the cooperative 30s budget while the page is
	* already usable; once the load promise settles (or the race times out),
	* `domcontentloaded`/`load` are guaranteed satisfied (did-finish-load is
	* strictly after dom-ready) and only `networkidle` needs an extra quiet
	* tick. `user=true` (address bar) bypasses the takeover mutex.
	*/
	async navigate(id, url, waitUntil = "domcontentloaded", signal, user = false) {
		const body = async () => {
			await this.navigateInternal(id, url, waitUntil);
		};
		if (user) return await body();
		await this.agentRun("browser_navigate", body, signal);
	}
	/** Navigation body without mutex acquisition (used by open and navigate). */
	async navigateInternal(id, url, waitUntil) {
		if (!this.guard.allowNavigation(url)) throw new Error(`browser: navigation denied — ${url.slice(0, 200)}`);
		const tab = this.tab(id);
		const wc = tab.view.webContents;
		const started = Date.now();
		if (await Promise.race([wc.loadURL(url).then(() => "loaded", () => "failed"), sleep(this.options.loadTimeoutMs).then(() => "pending")]) === "failed") {
			if (!wc.isLoading() && wc.getURL() === "") throw new Error("browser: navigation failed to load");
		}
		if (waitUntil === "networkidle") {
			const budget = Math.max(0, this.options.timeoutMs - (Date.now() - started));
			await sleep(Math.min(NETWORK_IDLE_TICK_MS, budget));
		}
		this.updateTabState(tab);
		this.record("browser_navigate", id, `navigate: ${url.slice(0, 200)}`);
	}
	/** Cooperative wait for the page load milestone; never rejects on timeout. */
	waitForLoad(wc, waitUntil) {
		return async (budgetMs) => {
			const deadline = Date.now() + Math.max(0, budgetMs);
			await new Promise((resolve) => {
				let settled = false;
				const settle = () => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve();
				};
				const cleanup = () => {
					wc.removeListener("dom-ready", onDomReady);
					wc.removeListener("did-finish-load", onFinish);
					clearTimeout(timer);
				};
				const onDomReady = () => {
					if (waitUntil === "domcontentloaded") settle();
				};
				const onFinish = () => {
					if (waitUntil === "load") settle();
					if (waitUntil === "networkidle") setTimeout(settle, 800).unref?.();
				};
				wc.on("dom-ready", onDomReady);
				wc.on("did-finish-load", onFinish);
				const timer = setTimeout(settle, Math.max(0, deadline - Date.now()));
				timer.unref?.();
				if (waitUntil !== "domcontentloaded" && !wc.isLoading()) settle();
				if (waitUntil === "domcontentloaded" && wc.isLoading() === false) settle();
			});
		};
	}
	/** Extract the interactable-element snapshot of one tab. */
	async snapshot(id, signal) {
		const elements = await this.withControl("browser_get_snapshot", id, (tab) => extractSnapshot((m, p) => tab.cdp.send(m, p), this.options.snapshotLimit), signal);
		this.record("browser_get_snapshot", id, `snapshot: ${elements.length} elements`);
		return elements;
	}
	/** Extract page text (optionally scoped by selector). */
	async text(id, selector, signal) {
		const text = await this.withControl("browser_get_text", id, (tab) => extractText((m, p) => tab.cdp.send(m, p), selector, this.options.textLimit), signal);
		this.record("browser_get_text", id, selector === void 0 ? `page text: ${text.length} chars` : `element text: ${text.length} chars`);
		return text;
	}
	/** Capture a JPEG screenshot of one tab. */
	async screenshot(id, signal) {
		const data = await this.withControl("browser_screenshot", id, (tab) => captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality), signal);
		this.record("browser_screenshot", id, "screenshot captured");
		return data;
	}
	/** Navigate history (agent path: honors the control mutex + abort signal;
	* user path (shell toolbar): runs immediately, never blocked by takeover). */
	async goBack(id, signal, user = false) {
		const body = async (tab) => {
			const wc = tab.view.webContents;
			if (wc.isDestroyed()) return;
			wc.goBack();
			await this.waitForLoad(wc, "domcontentloaded")(this.options.timeoutMs);
			this.updateTabState(tab);
		};
		if (user) return await body(this.tab(id));
		await this.withControl("browser_go_back", id, body, signal);
		this.record("browser_go_back", id, "history back");
	}
	async goForward(id, signal, user = false) {
		const body = async (tab) => {
			const wc = tab.view.webContents;
			if (wc.isDestroyed()) return;
			wc.goForward();
			await this.waitForLoad(wc, "domcontentloaded")(this.options.timeoutMs);
			this.updateTabState(tab);
		};
		if (user) return await body(this.tab(id));
		await this.withControl("browser_go_forward", id, body, signal);
		this.record("browser_go_forward", id, "history forward");
	}
	async reload(id, signal, user = false) {
		const body = async (tab) => {
			const wc = tab.view.webContents;
			if (wc.isDestroyed()) return;
			wc.reload();
			await this.waitForLoad(wc, "domcontentloaded")(this.options.timeoutMs);
			this.updateTabState(tab);
		};
		if (user) return await body(this.tab(id));
		await this.withControl("browser_reload", id, body, signal);
		this.record("browser_reload", id, "page reloaded");
	}
	/** Switch the visible tab (user path: immediate; agent path: mutex). */
	async switchTab(id, user = false, signal) {
		const body = async () => {
			const tab = this.tab(id);
			for (const other of this.tabs.values()) other.view.setVisible(other.id === id);
			this.visibleTabId = id;
			tab.view.setBounds(this.contentBounds());
			this.record("browser_switch_tab", id, `switch to tab ${id}`);
		};
		if (user) return await body();
		return await this.agentRun("browser_switch_tab", body, signal);
	}
	/** Close a tab and destroy its view/CDP (user path: immediate; agent path: mutex). */
	async closeTab(id, user = false, signal) {
		const body = async () => {
			const tab = this.tabs.get(id);
			if (tab === void 0) return;
			tab.cdp.detach();
			tab.view.detach();
			tab.view.destroy();
			this.tabs.delete(id);
			if (this.visibleTabId === id) {
				this.visibleTabId = [...this.tabs.keys()].at(-1);
				if (this.visibleTabId !== void 0) await this.switchTab(this.visibleTabId, true);
			}
			this.record("browser_close_tab", id, `close tab ${id}`);
		};
		if (user) return await body();
		return await this.agentRun("browser_close_tab", body, signal);
	}
	/**
	* Close the whole browser (all tabs). The dedicated window stays alive
	* (hidden) so the user can wake it from the sidebar — only plugin teardown
	* truly destroys it. Tabs are dropped; the next `browser_open` recreates
	* them. `user=true` (shell 清除 / session switch) still bypasses the
	* mutex of the *queued* agents but takes the control lock first so an
	* in-flight agent operation (navigate/click/type on a tab being
	* destroyed) is paused until teardown finishes — no concurrent use of a
	* discarded tab (2026-08-22, multi-user isolation race).
	*/
	async closeAll(signal, user = false) {
		const body = async () => {
			for (const id of [...this.tabs.keys()]) {
				const tab = this.tabs.get(id);
				if (tab === void 0) continue;
				tab.cdp.detach();
				tab.view.detach();
				tab.view.destroy();
				this.tabs.delete(id);
			}
			this.visibleTabId = void 0;
			for (const dispose of this.permissionsDisposers) dispose();
			for (const dispose of this.downloadDisposers) dispose();
			this.permissionsDisposers.length = 0;
			this.downloadDisposers.length = 0;
			this.record("browser_close", 0, "close browser");
			this.hideWindow();
		};
		if (user) {
			this.mutex.take();
			try {
				return await body();
			} finally {
				this.mutex.release();
			}
		}
		return await this.agentRun("browser_close", body, signal);
	}
	/** User takeover / release: hides/shows the AI-control mask and pauses /
	* resumes the agent loop (in-flight tool calls wait on the mutex). */
	setUserControl(active) {
		if (active) {
			this.mutex.take();
			this.record("browser_takeover", 0, "user took over the browser");
		} else {
			this.mutex.release();
			this.record("browser_release", 0, "user released browser control");
		}
		this.relayout();
	}
	/** Clear the persistent partition data (cookies, storage, cache). */
	async clearData() {
		const seen = /* @__PURE__ */ new Set();
		for (const tab of this.tabs.values()) {
			const session = tab.view.webContents.session;
			if (seen.has(session)) continue;
			seen.add(session);
			await session.clearStorageData();
			await session.clearCache();
		}
		this.record("browser_clear_data", 0, "clear browsing data");
	}
	/** Evaluate page JS (eval-enabled deployments only). */
	async eval(id, expression, signal) {
		if (!this.options.evalEnabled) throw new Error("browser: browser_eval is disabled in this deployment");
		if (typeof expression !== "string" || expression.length === 0 || expression.length > 64 * 1024) throw new Error("browser: eval expression must be a non-empty string ≤ 64KB");
		return await this.withControl("browser_eval", id, async (tab) => {
			const result = await tab.cdp.send("Runtime.evaluate", {
				expression,
				returnByValue: true,
				awaitPromise: true,
				timeout: this.options.timeoutMs
			});
			if (result.exceptionDetails !== void 0) throw new Error("browser: page script failed");
			const value = result.result?.value;
			return (typeof value === "string" ? value : safeJson(value)).slice(0, this.options.textLimit);
		}, signal, `eval: ${expression.slice(0, 60)}`);
	}
	/** Locate an element and return its viewport-center point for CDP input. */
	async locateElement(id, selector, signal) {
		return await this.withControl("browser_locate", id, async (tab) => {
			const value = (await tab.cdp.send("Runtime.evaluate", {
				expression: `
          (() => {
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { error: 'element not found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            } catch (e) {
              return { error: String(e) };
            }
          })()
        `,
				returnByValue: true
			})).result?.value;
			if (value === void 0 || value.error !== void 0) throw new Error(`browser: cannot locate element ${selector}${value?.error !== void 0 ? ` (${value.error})` : ""}`);
			if (typeof value.x !== "number" || typeof value.y !== "number") throw new Error(`browser: cannot locate element ${selector}`);
			return {
				x: value.x,
				y: value.y
			};
		}, signal);
	}
	/** Dispatch a left-click at a viewport point. */
	async clickAt(id, point, signal) {
		await this.withControl("browser_click", id, async (tab) => {
			await tab.cdp.send("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: point.x,
				y: point.y,
				button: "left",
				clickCount: 1
			});
			await tab.cdp.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: point.x,
				y: point.y,
				button: "left",
				clickCount: 1
			});
		}, signal, `click at (${Math.round(point.x)}, ${Math.round(point.y)})`);
	}
	/** Focus an element and insert text (Unicode-safe); clears first when requested. */
	async typeInto(id, selector, text, clear = true, signal) {
		await this.withControl("browser_type", id, async (tab) => {
			await tab.cdp.send("Runtime.evaluate", {
				expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'element not found' };
            el.focus();
            ${clear ? "if (typeof el.select === \"function\") el.select();" : ""}
            return {};
          })()
        `,
				returnByValue: true
			});
			await tab.cdp.send("Input.insertText", { text });
		}, signal, `type into ${selector}`);
	}
	/** Dispatch one keyboard key. */
	async pressKey(id, key, signal) {
		await this.withControl("browser_press", id, async (tab) => {
			const code = KEY_CODES[key] ?? key;
			const vk = KEY_VK[key] ?? 0;
			await tab.cdp.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key,
				code,
				windowsVirtualKeyCode: vk,
				nativeVirtualKeyCode: vk
			});
			await tab.cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key,
				code,
				windowsVirtualKeyCode: vk,
				nativeVirtualKeyCode: vk
			});
		}, signal, `press ${key}`);
	}
	/** Set a select's value and fire change/input. */
	async selectOption(id, selector, value, signal) {
		await this.withControl("browser_select", id, async (tab) => {
			const result = await tab.cdp.send("Runtime.evaluate", {
				expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'element not found' };
            if (el.tagName !== 'SELECT') return { error: 'not a select element' };
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return {};
          })()
        `,
				returnByValue: true
			});
			if (result.result?.value !== void 0 && result.result.value.error !== void 0) throw new Error(`browser: select failed — ${result.result.value.error}`);
		}, signal, `select ${selector} = ${value.slice(0, 80)}`);
	}
	/**
	* Fill the login form with stored connector credentials. The resolver looks
	* up the connector's credential fields (username/password); the form's first
	* text/email input receives the username and its password input the
	* password. Callers must route this through approval (credentials are
	* sensitive).
	*/
	/** Current URL of a tab ('' when unknown) — used in approval prompts. */
	currentUrlOf(id) {
		const tab = this.tabs.get(id);
		if (tab === void 0) return "";
		return tab.url;
	}
	async fillCredentials(id, connectorId, signal) {
		if (this.credentials === void 0) throw new Error("browser: credential injection is not available in this deployment");
		const credential = await this.credentials(connectorId);
		if (credential === null) throw new Error(`browser: no stored credentials for connector ${JSON.stringify(connectorId)}`);
		return await this.withControl("browser_fill_credentials", id, async (tab) => {
			const value = (await tab.cdp.send("Runtime.evaluate", {
				expression: `
          (() => {
            const username = ${JSON.stringify(credential.username ?? "")};
            const password = ${JSON.stringify(credential.password ?? "")};
            const set = (el, value) => {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const inputs = [...document.querySelectorAll('input')];
            const userField = inputs.find((el) => {
              const t = (el.type || 'text').toLowerCase();
              const n = (el.name || el.id || '').toLowerCase();
              return (t === 'text' || t === 'email' || t === 'tel') && !n.includes('password')
                && (n.includes('user') || n.includes('name') || n.includes('account') || n.includes('email') || n.includes('phone') || n.includes('login'));
            }) || inputs.find((el) => { const t = (el.type || 'text').toLowerCase(); return t === 'email' || t === 'tel'; });
            const passField = inputs.find((el) => (el.type || '').toLowerCase() === 'password');
            let filled = 0;
            if (userField && username) { set(userField, username); filled++; }
            if (passField && password) { set(passField, password); filled++; }
            return { filled, username: Boolean(userField && username), password: Boolean(passField && password) };
          })()
        `,
				returnByValue: true
			})).result?.value;
			if (value === void 0 || (value.filled ?? 0) === 0) throw new Error("browser: no matching login form found on this page");
			return {
				username: value.username === true,
				password: value.password === true
			};
		}, signal, `fill credentials for ${connectorId}`);
	}
	/** Scroll the page by a delta (or the element into view). */
	async scroll(id, deltaY, selector, signal) {
		await this.withControl("browser_scroll", id, async (tab) => {
			const expression = selector === void 0 || selector === "" ? `window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' }); 'ok'` : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not found'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`;
			await tab.cdp.send("Runtime.evaluate", {
				expression,
				returnByValue: true
			});
		}, signal, selector === void 0 || selector === "" ? `scroll ${Math.round(deltaY)}px` : `scroll to ${selector}`);
	}
	/** Dispose everything (plugin teardown): destroy the window for real. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const tab of this.tabs.values()) try {
			tab.cdp.detach();
			tab.view.destroy();
		} catch {}
		this.tabs.clear();
		this.visibleTabId = void 0;
		this.windowResizeDisposer?.();
		this.windowClosedDisposer?.();
		if (this.window !== null && !this.window.isDestroyed()) this.window.close();
		this.window = null;
		this.mask = null;
	}
};
/** Extra quiet tick approximating network idle for `networkidle` waits. */
const NETWORK_IDLE_TICK_MS = 800;
/** Resolve after `ms` milliseconds. */
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, ms)).unref?.();
	});
}
/** Safe JSON rendering with a hard cap (never throws). */
function safeJson(value) {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return String(value);
	}
}
/** Common key → CDP `code`. */
const KEY_CODES = {
	Enter: "Enter",
	Tab: "Tab",
	Escape: "Escape",
	Backspace: "Backspace",
	Delete: "Delete",
	ArrowUp: "ArrowUp",
	ArrowDown: "ArrowDown",
	ArrowLeft: "ArrowLeft",
	ArrowRight: "ArrowRight",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
	" ": "Space"
};
/** Common key → Windows virtual key code. */
const KEY_VK = {
	Enter: 13,
	Tab: 9,
	Escape: 27,
	Backspace: 8,
	Delete: 46,
	ArrowUp: 38,
	ArrowDown: 40,
	ArrowLeft: 37,
	ArrowRight: 39,
	Home: 36,
	End: 35,
	PageUp: 33,
	PageDown: 34,
	" ": 32
};
const MASK = "****";
const SENSITIVE_QUERY_KEY = /(?:auth|code|credential|key|password|secret|signature|token)/iu;
/** Redact credential-shaped parts of a browser op-log summary (URLs and
* query parameters). Mirrors the desktop logger's mask-secrets semantics. */
function maskBrowserSummary(summary) {
	return summary.replace(/https?:\/\/[^\s<>"']+/giu, (raw) => {
		const trailing = /[),.;]+$/u.exec(raw)?.[0] ?? "";
		const value = trailing === "" ? raw : raw.slice(0, -trailing.length);
		try {
			const url = new URL(value);
			if (url.username !== "") url.username = MASK;
			if (url.password !== "") url.password = MASK;
			for (const name of url.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(name)) url.searchParams.set(name, MASK);
			return `${url.href}${trailing}`;
		} catch {
			return raw;
		}
	});
}
//#endregion
//#region src/tools.ts
/** Cooperative tool-call timeout budget for every browser tool (ms). */
const BROWSER_TOOL_TIMEOUT_MS = 3e4;
/** Valid waitUntil values for navigation tools. */
const WAIT_UNTILS = [
	"domcontentloaded",
	"load",
	"networkidle"
];
/** The tool guidance band shown to the model (after the 100-199 per-tool band). */
const BROWSER_GUIDANCE = `You have an embedded browser. Drive it like a human user:
1. Start with browser_open or browser_new_tab, then browser_navigate to a URL.
2. Before interacting, call browser_get_snapshot to list the numbered interactable elements (links, buttons, inputs, selects).
3. Target elements by their snapshot number (e.g. target: 12); you may pass a CSS selector instead when you know one.
4. After navigation or any action that changes the page, call browser_get_snapshot again — the page may have re-rendered and renumbered everything.
5. Take a browser_screenshot only when you need visual confirmation; prefer snapshots and text to save tokens.
6. browser_type fills the focused input; use browser_press for Enter/Tab/Escape.
7. Every browser action runs directly with no user-approval prompt — the user has already granted browser use (workspace permission); the browser window shows the live state.
8. browser_eval executes JavaScript in the page; it is powerful — prefer the other tools.
9. Do not navigate away from a page you were asked to inspect without saying so first.
10. Close tabs you no longer need with browser_close_tab.`;
/** Resolve `target` (snapshot number or CSS selector) to a selector. */
async function resolveTarget(runtime, tabId, target, signal) {
	if (typeof target === "string") {
		if (target.trim() === "") throw new Error("target selector must not be empty");
		return target.trim();
	}
	if (!Number.isInteger(target) || target < 1) throw new Error("target number must be a positive integer");
	const snapshot = await runtime.snapshot(tabId, signal);
	const entry = snapshot.find((item) => item.index === target);
	if (entry === void 0) throw new Error(`browser: no snapshot element ${target} — call browser_get_snapshot first (${snapshot.length} elements)`);
	return entry.selector;
}
/** Present a pending browser operation as a generic card. */
function present(title) {
	return (args) => ({
		card: "generic",
		kind: "other",
		title,
		rawInput: args
	});
}
/** Result meta projection helpers. */
function metaFrom(value) {
	return value;
}
/**
* Register the full browser tool suite.
* @param ctx - context whose `tools` and `systemPrompt` registries receive the
*   registrations; both are effect-scoped and unregister on plugin dispose.
* @param runtime - the embedded browser runtime (owns tabs, mutex, guards).
* @param attachments - whether `ctx.attachments` is available (screenshot
*   needs it); screenshots fail with a clear message otherwise.
*/
function applyBrowserTools(ctx, runtime) {
	ctx.systemPrompt.section({
		name: "tool:browser",
		order: 111,
		text: BROWSER_GUIDANCE
	});
	const tabOf = async (tab) => {
		if (tab !== void 0) return tab;
		const current = runtime.currentTabId();
		if (current === void 0) throw new Error("browser: no tab open — call browser_open first");
		return current;
	};
	ctx.tools.register(defineTool({
		name: "browser_open",
		description: "Open the embedded browser (creating the first tab) and optionally navigate to a URL. Use this as the first browser action.",
		parameters: { url: {
			type: "string",
			description: "Optional URL to open."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tab: { type: "integer" },
					url: { type: "string" },
					title: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatTabOpened(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Open browser"),
		async execute(args, exec) {
			const { url } = args;
			const tab = await runtime.open(url ?? void 0, exec.signal);
			exec.signal.throwIfAborted();
			return {
				tab: tab.id,
				url: tab.url,
				title: tab.title
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_new_tab",
		description: "Open a new tab (optionally navigating to a URL) and switch to it.",
		parameters: { url: {
			type: "string",
			description: "Optional URL to load in the new tab."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tab: { type: "integer" },
					url: { type: "string" },
					title: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatTabOpened(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("New browser tab"),
		async execute(args, exec) {
			const { url } = args;
			const tab = await runtime.open(url ?? void 0, exec.signal);
			exec.signal.throwIfAborted();
			return {
				tab: tab.id,
				url: tab.url,
				title: tab.title
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_navigate",
		description: "Navigate the tab to a URL. http/https only; other schemes are denied.",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			url: {
				type: "string",
				required: true,
				description: "The URL to navigate to."
			},
			waitUntil: {
				type: "string",
				enum: WAIT_UNTILS,
				description: "Load milestone to wait for (default domcontentloaded)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: { type: "string" },
					title: { type: "string" },
					loading: { type: "boolean" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatNavigation(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Navigate"),
		async execute(args, exec) {
			const { tab, url, waitUntil } = args;
			if (typeof url !== "string" || url.trim() === "") throw new Error("url must be a non-empty string");
			const tabId = await tabOf(tab);
			await runtime.navigate(tabId, url.trim(), waitUntil ?? "domcontentloaded", exec.signal);
			exec.signal.throwIfAborted();
			const state = runtime.tabState(tabId);
			return {
				url: state.url,
				title: state.title,
				loading: state.loading
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_reload",
		description: "Reload the current page of a tab.",
		parameters: { tab: {
			type: "integer",
			description: "Tab id (defaults to the visible tab)."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { url: { type: "string" } }
			},
			render: (_args, value) => [{
				type: "text",
				text: `Reloaded ${String(value.url ?? "")}`
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Reload page"),
		async execute(args, exec) {
			const tabId = await tabOf(args.tab);
			await runtime.reload(tabId, exec.signal);
			exec.signal.throwIfAborted();
			return { url: runtime.tabState(tabId).url };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_go_back",
		description: "Navigate back in the tab history.",
		parameters: { tab: {
			type: "integer",
			description: "Tab id (defaults to the visible tab)."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { url: { type: "string" } }
			},
			render: (_args, value) => [{
				type: "text",
				text: `Back to ${String(value.url ?? "")}`
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Go back"),
		async execute(args, exec) {
			const tabId = await tabOf(args.tab);
			await runtime.goBack(tabId, exec.signal);
			exec.signal.throwIfAborted();
			return { url: runtime.tabState(tabId).url };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_go_forward",
		description: "Navigate forward in the tab history.",
		parameters: { tab: {
			type: "integer",
			description: "Tab id (defaults to the visible tab)."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { url: { type: "string" } }
			},
			render: (_args, value) => [{
				type: "text",
				text: `Forward to ${String(value.url ?? "")}`
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Go forward"),
		async execute(args, exec) {
			const tabId = await tabOf(args.tab);
			await runtime.goForward(tabId, exec.signal);
			exec.signal.throwIfAborted();
			return { url: runtime.tabState(tabId).url };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_click",
		description: "Click an element, targeted by its snapshot number or a CSS selector. Runs without a user-approval prompt.",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			target: {
				oneOf: [{ type: "integer" }, { type: "string" }],
				required: true,
				description: "Snapshot element number or CSS selector."
			},
			submit: {
				type: "boolean",
				description: "Set true when this click submits a form (no prompt; kept for call compatibility)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { type: "boolean" } }
			},
			render: () => [{
				type: "text",
				text: "Clicked."
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Click"),
		async execute(args, exec) {
			const { tab, target } = args;
			const tabId = await tabOf(tab);
			const selector = await resolveTarget(runtime, tabId, target);
			const point = await runtime.locateElement(tabId, selector, exec.signal);
			await runtime.clickAt(tabId, point, exec.signal);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_type",
		description: "Type text into an input (snapshot number or CSS selector). Runs without a user-approval prompt.",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			target: {
				oneOf: [{ type: "integer" }, { type: "string" }],
				required: true,
				description: "Snapshot element number or CSS selector."
			},
			text: {
				type: "string",
				required: true,
				description: "The text to type (any Unicode)."
			},
			clear: {
				type: "boolean",
				description: "Clear the field before typing (default true)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { type: "boolean" } }
			},
			render: () => [{
				type: "text",
				text: "Typed."
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Type"),
		async execute(args, exec) {
			const { tab, target, text, clear } = args;
			if (typeof text !== "string" || text.length > 16 * 1024) throw new Error("text must be a string ≤ 16KB");
			const tabId = await tabOf(tab);
			const selector = await resolveTarget(runtime, tabId, target);
			await runtime.typeInto(tabId, selector, text, clear !== false, exec.signal);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_press",
		description: "Press a key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, space).",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			key: {
				type: "string",
				required: true,
				description: "The key to press."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { type: "boolean" } }
			},
			render: () => [{
				type: "text",
				text: "Key pressed."
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Press key"),
		async execute(args, exec) {
			const { tab, key } = args;
			if (typeof key !== "string" || key.length === 0) throw new Error("key must be a non-empty string");
			const tabId = await tabOf(tab);
			await runtime.pressKey(tabId, key, exec.signal);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_select",
		description: "Select an option in a dropdown (snapshot number or CSS selector).",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			target: {
				oneOf: [{ type: "integer" }, { type: "string" }],
				required: true,
				description: "Snapshot element number or CSS selector."
			},
			value: {
				type: "string",
				required: true,
				description: "The option value to select."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { type: "boolean" } }
			},
			render: () => [{
				type: "text",
				text: "Selected."
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Select option"),
		async execute(args, exec) {
			const { tab, target, value } = args;
			const tabId = await tabOf(tab);
			const selector = await resolveTarget(runtime, tabId, target);
			await runtime.selectOption(tabId, selector, value, exec.signal);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_scroll",
		description: "Scroll the page by a vertical delta, or bring a snapshot element into view.",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			deltaY: {
				type: "integer",
				description: "Vertical scroll amount in pixels (negative scrolls up)."
			},
			target: {
				oneOf: [{ type: "integer" }, { type: "string" }],
				description: "Snapshot element number or CSS selector to bring into view."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { type: "boolean" } }
			},
			render: () => [{
				type: "text",
				text: "Scrolled."
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Scroll"),
		async execute(args, exec) {
			const { tab, deltaY, target } = args;
			const tabId = await tabOf(tab);
			const selector = target === void 0 ? void 0 : await resolveTarget(runtime, tabId, target);
			await runtime.scroll(tabId, deltaY ?? 0, selector, exec.signal);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_screenshot",
		description: "Capture the visible page as a JPEG image (bounded width). Use sparingly — snapshots and text are cheaper.",
		parameters: { tab: {
			type: "integer",
			description: "Tab id (defaults to the visible tab)."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { image: {
					type: "object",
					additionalProperties: false,
					properties: {
						attachmentId: {
							type: "string",
							required: true
						},
						mediaType: {
							type: "string",
							required: true
						},
						bytes: {
							type: "integer",
							required: true
						},
						width: {
							type: "integer",
							required: true
						},
						height: {
							type: "integer",
							required: true
						}
					}
				} }
			},
			render: (_args, value) => {
				const image = value.image;
				return image === void 0 ? [{
					type: "text",
					text: "Screenshot failed."
				}] : [{
					type: "image",
					attachment: image
				}];
			},
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Screenshot"),
		async execute(args, exec) {
			const tabId = await tabOf(args.tab);
			const dataUrl = await runtime.screenshot(tabId, exec.signal);
			exec.signal.throwIfAborted();
			const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
			const data = Buffer.from(base64, "base64");
			const ref = (await ctx.attachments.saveImages([{
				data: new Uint8Array(data),
				mediaType: "image/jpeg",
				name: `browser-tab-${tabId}.jpg`
			}]))[0];
			if (ref === void 0) throw new Error("browser: screenshot could not be stored");
			return { image: ref };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_get_snapshot",
		description: "List the numbered interactable elements of the page (links, buttons, inputs, selects, textareas). The numbers are the targets for click/type/select/scroll.",
		parameters: { tab: {
			type: "integer",
			description: "Tab id (defaults to the visible tab)."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					elements: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								index: { type: "integer" },
								kind: { type: "string" },
								text: { type: "string" },
								selector: { type: "string" },
								visible: { type: "boolean" },
								disabled: { type: "boolean" }
							}
						}
					},
					url: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatSnapshot(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Page snapshot"),
		async execute(args, exec) {
			const tabId = await tabOf(args.tab);
			const elements = await runtime.snapshot(tabId, exec.signal);
			exec.signal.throwIfAborted();
			return {
				elements,
				url: runtime.tabState(tabId).url
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_get_text",
		description: "Extract the visible text of the page, or of one element (CSS selector). Bounded output.",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			selector: {
				type: "string",
				description: "Optional CSS selector; without it the whole page text is returned."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string" },
					truncated: { type: "boolean" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatText(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Page text"),
		async execute(args, exec) {
			const { tab, selector } = args;
			const tabId = await tabOf(tab);
			const text = await runtime.text(tabId, selector, exec.signal);
			exec.signal.throwIfAborted();
			return {
				text,
				truncated: text.length >= runtime.options.textLimit
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_list_tabs",
		description: "List all open tabs with their ids, URLs, titles, and which is visible.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { tabs: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "integer" },
							url: { type: "string" },
							title: { type: "string" },
							loading: { type: "boolean" },
							visible: { type: "boolean" }
						}
					}
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: formatTabs(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => true,
		presentCall: present("List tabs"),
		async execute() {
			return { tabs: runtime.listTabs() };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_switch_tab",
		description: "Switch the visible tab.",
		parameters: { tab: {
			type: "integer",
			required: true,
			description: "The tab id to show."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tab: { type: "integer" },
					url: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Switched to tab ${String(value.tab ?? "")}.`
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Switch tab"),
		async execute(args, exec) {
			const tabId = args.tab;
			await runtime.switchTab(tabId, false, exec.signal);
			exec.signal.throwIfAborted();
			return {
				tab: tabId,
				url: runtime.tabState(tabId).url
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_close_tab",
		description: "Close one tab and destroy its resources.",
		parameters: { tab: {
			type: "integer",
			required: true,
			description: "The tab id to close."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { type: "boolean" } }
			},
			render: () => [{
				type: "text",
				text: "Tab closed."
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Close tab"),
		async execute(args, exec) {
			await runtime.closeTab(args.tab, false, exec.signal);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_close",
		description: "Close the whole embedded browser and release all tabs.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: { type: "boolean" } }
			},
			render: () => [{
				type: "text",
				text: "Browser closed."
			}]
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Close browser"),
		async execute(_, exec) {
			await runtime.closeAll(exec.signal);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_eval",
		description: "Execute JavaScript in the page context and return the JSON result. Runs without a user-approval prompt (browser use is already granted); prefer the other tools when possible.",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			expression: {
				type: "string",
				required: true,
				description: "The JavaScript expression to evaluate (≤ 64KB)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { result: { type: "string" } }
			},
			render: (_args, value) => [{
				type: "text",
				text: formatEval(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Evaluate JS"),
		async execute(args, exec) {
			const { tab, expression } = args;
			const tabId = await tabOf(tab);
			const result = await runtime.eval(tabId, expression, exec.signal);
			exec.signal.throwIfAborted();
			return { result: String(result) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_fill_credentials",
		description: "Fill the login form with credentials stored for a connector (e.g. an enterprise account). Runs without a user-approval prompt. Does not submit the form.",
		parameters: {
			tab: {
				type: "integer",
				description: "Tab id (defaults to the visible tab)."
			},
			connectorId: {
				type: "string",
				required: true,
				description: "The connector id whose stored credentials to use."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					username: { type: "boolean" },
					password: { type: "boolean" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatCredentialFill(value)
			}],
			presentationMeta: (_args, value) => metaFrom(value)
		},
		timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		presentCall: present("Fill credentials"),
		async execute(args, exec) {
			const { tab, connectorId } = args;
			if (typeof connectorId !== "string" || connectorId.trim() === "") throw new Error("connectorId must be a non-empty string");
			const tabId = await tabOf(tab);
			const filled = await runtime.fillCredentials(tabId, connectorId.trim(), exec.signal);
			exec.signal.throwIfAborted();
			return filled;
		}
	}));
}
/** Format a credential-fill result for the model. */
function formatCredentialFill(value) {
	const v = value;
	const parts = [];
	if (v.username === true) parts.push("username");
	if (v.password === true) parts.push("password");
	return parts.length > 0 ? `Filled ${parts.join(" and ")} from stored credentials (not submitted).` : "Form fields filled (not submitted).";
}
/** Format a tab-open result for the model. */
function formatTabOpened(value) {
	const v = value;
	return `Opened tab ${String(v.tab ?? "")} — ${v.title !== "" ? `${String(v.title)} — ` : ""}${String(v.url ?? "")}`;
}
/** Format a navigation result. */
function formatNavigation(value) {
	const v = value;
	return `Navigated to ${String(v.url ?? "")}${v.title !== void 0 && v.title !== "" ? ` (${String(v.title)})` : ""}${v.loading === true ? " [loading]" : ""}`;
}
/** Format a snapshot for the model. */
function formatSnapshot(value) {
	const v = value;
	const elements = v.elements ?? [];
	if (elements.length === 0) return `No interactable elements found${v.url !== void 0 ? ` on ${String(v.url)}` : ""}.`;
	const lines = elements.map((e) => {
		const flags = `${e.visible ? "" : " (off-screen)"}${e.disabled ? " (disabled)" : ""}`;
		return `${e.index}: [${e.kind}] ${e.text || "(no text)"}${flags}`;
	});
	return `Interactable elements${v.url !== void 0 ? ` on ${String(v.url)}` : ""}:\n${lines.join("\n")}`;
}
/** Format page text. */
function formatText(value) {
	const v = value;
	const text = v.text ?? "";
	return text === "" ? "(no text)" : `${text}${v.truncated === true ? "\n…(truncated)" : ""}`;
}
/** Format the tab list. */
function formatTabs(value) {
	const tabs = value.tabs ?? [];
	if (tabs.length === 0) return "No tabs open.";
	return tabs.map((t) => `${t.id}: ${t.title || t.url}${t.visible ? " (visible)" : ""}${t.loading ? " [loading]" : ""}`).join("\n");
}
/** Format an eval result. */
function formatEval(value) {
	const v = value;
	return v.result === void 0 ? "(no result)" : String(v.result);
}
//#endregion
//#region src/shell-pages.ts
/**
* Local pages for the dedicated browser window: the control shell (toolbar +
* tab strip) and the AI-control mask (translucent overlay with the takeover
* button). Both are plain HTML served by the plugin's own loopback webServer
* routes and drive the browser through the same fenced API as the client UI.
*
* The mask is a full-content-area overlay shown while the agent controls the
* browser: it blocks direct interaction with the page and offers the single
* 「接管」 action. Taking over hides the mask and lets the user drive the
* page; releasing (from the shell toolbar) restores the mask and the agent
* resumes.
* @module @picoaide/dsh-browser
*/
/** The control-shell page: toolbar with tabs, address bar, and control
* buttons. Polls /api/pico/browser/state to stay in sync with the runtime. */
const BROWSER_SHELL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PicoAide 浏览器</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px system-ui, sans-serif; background: #f2f3f5; color: #1a1d24; }
  @media (prefers-color-scheme: dark) {
    body { background: #181a1f; color: #e6e6e6; }
    input { background: #23252b; color: #e6e6e6; border-color: #3a3d45; }
    .tab { background: #23252b; }
    .tab.active { background: #2e3138; }
  }
  #bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid rgba(128,128,128,.25); }
  #addrbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,.25); }
  #addr {
    flex: 1; min-width: 0; padding: 6px 10px; border-radius: 6px;
    border: 1px solid rgba(128,128,128,.4); background: #fff; color: inherit; font: inherit;
  }
  #addr:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
  #tabs { display: flex; align-items: center; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; }
  .tab { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; max-width: 140px; overflow: hidden; background: #e6e7ea; }
  .tab.active { background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.15); }
  .tab .x { margin-left: 4px; opacity: .6; cursor: pointer; padding: 0 2px; }
  .tab .x:hover { opacity: 1; }
  button { padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; cursor: pointer; font: inherit; }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
  #hint { font-size: 12px; color: #6b7280; margin-left: auto; }
  #notice { padding: 4px 10px; font-size: 12px; background: rgba(220,38,38,.12); color: #dc2626; display: none; }
  #notice.show { display: block; }
</style>
</head>
<body>
  <div id="bar">
    <div id="tabs"></div>
    <button id="newtab" title="新建标签页">+</button>
    <button id="back" title="后退">←</button>
    <button id="forward" title="前进">→</button>
    <button id="reload" title="刷新">⟳</button>
    <span id="hint"></span>
    <button id="takeover" title="接管/释放浏览器控制">接管</button>
    <button id="clear" title="清除浏览数据并关闭全部标签">清除</button>
    <button id="hide" title="隐藏窗口（不关闭）">隐藏</button>
  </div>
  <div id="addrbar">
    <input id="addr" type="text" placeholder="输入网址，回车访问（例如 https://example.com）" aria-label="地址栏" spellcheck="false" />
    <button id="go" title="访问地址">访问</button>
  </div>
  <div id="notice">用户接管中：AI 浏览器操作已暂停，释放后继续。</div>
<script>
  const $ = (id) => document.getElementById(id)
  let state = { tabs: [], controlled: false }
  const post = (action, body) =>
    fetch('/api/pico/browser/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then((r) => r.json()).catch(() => ({ ok: false }))
  const render = () => {
    const tabs = $('tabs')
    tabs.textContent = ''
    for (const tab of state.tabs) {
      const el = document.createElement('div')
      el.className = 'tab' + (tab.visible ? ' active' : '')
      el.title = tab.url
      el.textContent = (tab.title || tab.url || ('标签 ' + tab.id)).slice(0, 24) + (tab.loading ? '…' : '')
      el.addEventListener('click', () => post('switch-tab', { tab: tab.id }))
      const x = document.createElement('span')
      x.className = 'x'
      x.textContent = '×'
      x.addEventListener('click', (e) => { e.stopPropagation(); post('close-tab', { tab: tab.id }) })
      el.appendChild(x)
      tabs.appendChild(el)
    }
    const visible = state.tabs.find((t) => t.visible)
    $('back').disabled = !visible
    $('forward').disabled = !visible
    $('reload').disabled = !visible
    $('hint').textContent = visible ? (visible.title || visible.url || '') : ''
    // Address bar mirrors the visible tab (only when it is not focused, so
    // typing is never overwritten by the 1s poll).
    const addr = $('addr')
    if (document.activeElement !== addr) {
      addr.value = visible ? (visible.url || '') : ''
      addr.placeholder = visible ? '' : '输入网址，回车访问（例如 https://example.com）'
    }
    const to = $('takeover')
    if (state.controlled) {
      to.textContent = '释放接管'
      to.className = 'danger'
      $('notice').classList.add('show')
    } else {
      to.textContent = '接管'
      to.className = ''
      $('notice').classList.remove('show')
    }
  }
  const poll = () =>
    fetch('/api/pico/browser/state').then((r) => r.json()).then((next) => {
      state = next
      render()
    }).catch(() => {})
  $('newtab').addEventListener('click', () => post('open'))
  $('back').addEventListener('click', () => post('back'))
  $('forward').addEventListener('click', () => post('forward'))
  $('reload').addEventListener('click', () => post('reload'))
  // Address bar: navigate the VISIBLE tab. The user's own surface — the
  // runtime navigates immediately (the shell route passes user=true).
  const go = () => {
    const value = $('addr').value.trim()
    if (value === '') return
    const visible = state.tabs.find((t) => t.visible)
    if (visible === undefined) {
      // No tab yet: open one at the URL.
      post('open', { url: value }).then(() => poll())
    } else {
      post('navigate', { tab: visible.id, url: value }).then(() => poll())
    }
  }
  $('addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go() }
  })
  $('go').addEventListener('click', go)
  // Explicit target state (not a toggle): the poll lags up to 1s, so a
  // toggle based on stale state can repeat the same action forever
  // (e.g. clicking 接管 twice keeps active:true; clicking 释放接管 when the
  // poll still shows controlled:true sends active:true again).
  $('takeover').addEventListener('click', () => {
    const active = state.controlled === false
    post('takeover', { active }).then(() => poll())
  })
  $('clear').addEventListener('click', () => post('clear-data').then(() => post('close-all')))
  $('hide').addEventListener('click', () => post('hide'))
  poll()
  setInterval(poll, 1000)
<\/script>
</body>
</html>`;
/** The AI-control mask: translucent overlay + the takeover button.
*
* The mask is served as its own WebContentsView whose page paints a
* translucent scrim; the view itself is created with `webPreferences.transparent:
* true` (see electron-adapter.ts) so the rgba scrim blends with the TAB page
* beneath it instead of the view's opaque white canvas. It polls the loopback
* state to show what the agent is doing right now (in-flight tool + recent
* operations), so the user knows when to take over. */
const BROWSER_MASK_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    /* The scrim overlays the whole page; the status card sits at the BOTTOM
     * CENTER (not the middle) so the page content the AI is driving stays
     * visible behind the translucent overlay. */
    display: flex; align-items: flex-end; justify-content: center;
    padding: 0 0 18px 0;
    background: rgba(128, 128, 128, 0.28);
    font: 14px system-ui, sans-serif; color: #3a3f4a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: rgba(0, 0, 0, 0.38); color: #cfd3da; }
  }
  #card {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    padding: 22px 30px; border-radius: 16px; max-width: 520px; min-width: 320px;
    background: rgba(255, 255, 255, 0.9); box-shadow: 0 8px 30px rgba(0,0,0,.18);
  }
  @media (prefers-color-scheme: dark) {
    #card { background: rgba(30, 32, 38, 0.92); }
  }
  #hint { margin: 0; font-weight: 500; }
  #status { margin: 0; font-size: 13px; color: #4b5563; min-height: 1.4em; }
  @media (prefers-color-scheme: dark) {
    #status { color: #aeb4bd; }
  }
  #status .busy { color: #1d4ed8; font-weight: 600; }
  #ops .busy { color: #1d4ed8; font-weight: 500; }
  @media (prefers-color-scheme: dark) {
    #status .busy, #ops .busy { color: #7ba7ff; }
  }
  #ops { list-style: none; margin: 0; padding: 0; width: 100%; max-height: 132px; overflow-y: auto; }
  #ops li { display: flex; gap: 8px; font-size: 12px; color: #6b7280; align-items: baseline; }
  @media (prefers-color-scheme: dark) {
    #ops li { color: #9aa1ab; }
  }
  #ops .time { flex: none; font-variant-numeric: tabular-nums; }
  #ops .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button {
    padding: 9px 22px; border-radius: 8px; border: none;
    background: #2563eb; color: #fff; font-size: 14px; cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  .spinner {
    display: inline-block; width: 12px; height: 12px; margin-right: 6px;
    border: 2px solid #93c5fd; border-top-color: #2563eb; border-radius: 50%;
    vertical-align: -1px; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div id="card">
    <p id="hint">AI 正在控制浏览器</p>
    <p id="status">正在获取状态…</p>
    <ul id="ops"></ul>
    <button id="take">接管控制</button>
  </div>
<script>
  // Browser tool -> human label. Pure JS (no TS annotations): this inline
  // script is a string in TS source and is served verbatim to the page.
  const TOOL_LABELS = {
    'browser_open': '打开浏览器',
    'browser_new_tab': '新建标签页',
    'browser_navigate': '打开网页',
    'browser_reload': '刷新页面',
    'browser_go_back': '后退',
    'browser_go_forward': '前进',
    'browser_click': '点击',
    'browser_type': '输入文字',
    'browser_press': '按键',
    'browser_select': '选择下拉项',
    'browser_scroll': '滚动页面',
    'browser_screenshot': '截图',
    'browser_get_snapshot': '读取页面元素',
    'browser_get_text': '读取页面文字',
    'browser_list_tabs': '查看标签页',
    'browser_switch_tab': '切换标签页',
    'browser_close_tab': '关闭标签页',
    'browser_close': '关闭浏览器',
    'browser_eval': '执行脚本',
    'browser_fill_credentials': '填写登录表单',
    'browser_takeover': '接管',
    'browser_release': '释放接管',
    'browser_download': '下载文件',
    'browser_clear_data': '清除数据',
  }
  const label = (tool) => TOOL_LABELS[tool] || tool || '操作'
  const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
  const $ = (id) => document.getElementById(id)
  // Build the status line with DOM APIs only: op summaries can carry
  // model-provided URLs (never trust string concatenation into markup).
  const statusLine = (parts) => {
    const status = $('status')
    status.textContent = ''
    for (const part of parts) {
      if (typeof part === 'string') {
        status.appendChild(document.createTextNode(part))
      } else {
        const span = document.createElement('span')
        span.className = part.className || ''
        span.textContent = part.text
        status.appendChild(span)
      }
    }
  }
  const state = { busy: false, busyTool: '', latestOp: null, ops: [] }
  const render = () => {
    if (state.busy) {
      statusLine([
        { className: 'spinner', text: '' },
        '正在执行：',
        { className: 'busy', text: label(state.busyTool) },
      ])
    } else if (state.latestOp) {
      statusLine(['已空闲——最近操作：', { className: 'busy', text: label(state.latestOp.tool) }, ' ' + state.latestOp.summary])
    } else {
      statusLine(['等待 AI 开始操作…'])
    }
    const ops = $('ops')
    ops.textContent = ''
    for (const op of state.ops.slice(0, 3)) {
      const li = document.createElement('li')
      const t = document.createElement('span')
      t.className = 'time'
      t.textContent = fmt(op.time)
      const w = document.createElement('span')
      w.className = 'what'
      const tag = document.createElement('span')
      tag.className = 'busy'
      tag.textContent = label(op.tool)
      w.appendChild(tag)
      w.appendChild(document.createTextNode(' ' + op.summary))
      li.appendChild(t)
      li.appendChild(w)
      ops.appendChild(li)
    }
  }
  const poll = () => {
    Promise.all([
      fetch('/api/pico/browser/state').then((r) => r.json()).catch(() => null),
      fetch('/api/pico/browser/ops').then((r) => r.json()).catch(() => ({ ops: [] })),
    ]).then(([s, o]) => {
      if (s !== null) {
        state.busy = s.busy === true
        state.busyTool = s.busyTool || ''
        state.latestOp = s.latestOp || null
      }
      state.ops = Array.isArray(o && o.ops) ? o.ops : []
      render()
    }).catch(() => {})
  }
  $('take').addEventListener('click', () => {
    fetch('/api/pico/browser/takeover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: true }),
    }).then(() => {
      // The takeover hides the mask immediately; nothing else to refresh.
    }).catch(() => {})
  })
  poll()
  setInterval(poll, 700)
<\/script>
</body>
</html>`;
//#endregion
//#region src/index.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "pico-browser";
/** Services required by the embedded browser. */
const inject = [
	"webServer",
	"tools",
	"systemPrompt",
	"attachments"
];
const Config = Schema.object({
	maxTabs: Schema.number(),
	timeoutMs: Schema.number(),
	loadTimeoutMs: Schema.number(),
	evalEnabled: Schema.boolean(),
	snapshotLimit: Schema.number(),
	textLimit: Schema.number(),
	screenshotMaxWidth: Schema.number(),
	screenshotQuality: Schema.number()
});
/** Cap on browser API request bodies. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
function json(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
async function readJson(req) {
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		received += buffer.byteLength;
		if (received > MAX_REQUEST_BODY_BYTES) return null;
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}
function decodeSegment(segment) {
	if (segment === void 0) return null;
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}
/**
* Register the embedded browser plugin.
* @param ctx - Cordis context carrying the webServer, tools, systemPrompt and
*   attachments services.
* @param config - runtime caps and enablement.
*/
function apply(ctx, config = {}) {
	const currentUser = () => {
		try {
			return ctx.get("picoSession")?.getSession?.()?.username ?? null;
		} catch {
			return null;
		}
	};
	const credentialResolver = (() => {
		try {
			const { ConnectorStore } = createRequire(import.meta.url)("@picoaide/dsh-connectors/store");
			return async (connectorId) => {
				const credential = await new ConnectorStore({ username: currentUser() }).readCredential(connectorId);
				if (credential === null) return null;
				const fields = credential.fields ?? {};
				const username = typeof fields.username === "string" ? fields.username : void 0;
				const password = typeof fields.password === "string" ? fields.password : void 0;
				return {
					...username !== void 0 ? { username } : {},
					...password !== void 0 ? { password } : {}
				};
			};
		} catch {
			return;
		}
	})();
	const runtime = new BrowserRuntime(createRealElectronAdapter(), config, credentialResolver, browserPartitionFor(currentUser()));
	runtime.setShellOrigin(`http://127.0.0.1:${String(ctx.webServer.port)}`);
	ctx.on("pico/session-changed", (next) => {
		const username = next?.username ?? null;
		(async () => {
			await runtime.closeAll(void 0, true);
			runtime.setPartition(browserPartitionFor(username));
		})().catch((cause) => {
			ctx.logger?.error("pico-browser: session change handling failed", cause);
		});
	});
	applyBrowserTools(ctx, runtime);
	ctx.effect(() => {
		const guard = (req, res) => {
			if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true;
			json(res, 403, { error: "forbidden" });
			return false;
		};
		const action = (req, res) => {
			const rawAction = decodeSegment(req.url?.split("/")[4]?.split("?")[0]);
			handleAction(rawAction, req, res).catch((error) => {
				json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			});
		};
		const handleAction = async (action, req, res) => {
			if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
			if (!guard(req, res)) return;
			const raw = await readJson(req);
			const body = raw !== null && typeof raw === "object" ? raw : {};
			switch (action) {
				case "show":
					await runtime.showWindow();
					json(res, 200, { ok: true });
					return;
				case "hide":
					runtime.hideWindow();
					json(res, 200, { ok: true });
					return;
				case "open": {
					const url = typeof body.url === "string" ? body.url : void 0;
					json(res, 200, { tab: await runtime.open(url, void 0, true) });
					return;
				}
				case "navigate": {
					const tab = numberOr(body.tab, 0);
					const url = typeof body.url === "string" ? body.url : "";
					if (tab <= 0) return json(res, 400, { error: "tab is required" });
					await runtime.navigate(tab, url, "domcontentloaded", void 0, true);
					json(res, 200, { ok: true });
					return;
				}
				case "reload":
					await runtime.reload(tabOf(runtime, body), void 0, true);
					json(res, 200, { ok: true });
					return;
				case "back":
					await runtime.goBack(tabOf(runtime, body), void 0, true);
					json(res, 200, { ok: true });
					return;
				case "forward":
					await runtime.goForward(tabOf(runtime, body), void 0, true);
					json(res, 200, { ok: true });
					return;
				case "switch-tab": {
					const tab = numberOr(body.tab, 0);
					if (tab <= 0) return json(res, 400, { error: "tab is required" });
					await runtime.switchTab(tab, true);
					json(res, 200, { ok: true });
					return;
				}
				case "close-tab": {
					const tab = numberOr(body.tab, 0);
					if (tab <= 0) return json(res, 400, { error: "tab is required" });
					await runtime.closeTab(tab, true);
					json(res, 200, { ok: true });
					return;
				}
				case "close-all":
					await runtime.closeAll(void 0, true);
					json(res, 200, { ok: true });
					return;
				case "takeover":
					runtime.setUserControl(body.active === true);
					json(res, 200, { ok: true });
					return;
				case "clear-data":
					await runtime.clearData();
					json(res, 200, { ok: true });
					return;
				default: json(res, 404, { error: "not found" });
			}
		};
		const state = (req, res) => {
			if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
			if (!guard(req, res)) return;
			json(res, 200, {
				tabs: runtime.listTabs(),
				window: runtime.windowState,
				controlled: runtime.controlled,
				busy: runtime.isBusy,
				busyTool: runtime.busyToolName,
				latestOp: runtime.latestOp ?? null
			});
		};
		const ops = (req, res) => {
			if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
			if (!guard(req, res)) return;
			json(res, 200, { ops: runtime.opLog });
		};
		const html = (content) => (_req, res) => {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store"
			});
			res.end(content);
		};
		const disposers = [
			ctx.webServer.register({
				kind: "exact",
				path: "/api/pico/browser/state",
				handler: state
			}),
			ctx.webServer.register({
				kind: "exact",
				path: "/api/pico/browser/ops",
				handler: ops
			}),
			ctx.webServer.register({
				kind: "prefix",
				path: "/api/pico/browser",
				handler: action
			}),
			ctx.webServer.register({
				kind: "exact",
				path: "/browser-shell",
				handler: html(BROWSER_SHELL_HTML)
			}),
			ctx.webServer.register({
				kind: "exact",
				path: "/browser-mask",
				handler: html(BROWSER_MASK_HTML)
			})
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "pico browser: panel api");
	ctx.effect(() => {
		return () => {
			runtime.dispose();
		};
	}, "pico browser: teardown");
}
/** Read a number from a JSON field with a fallback. */
function numberOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/** Resolve the tab id from a body, defaulting to the visible tab. */
function tabOf(runtime, body) {
	const explicit = numberOr(body.tab, 0);
	if (explicit > 0) return explicit;
	const current = runtime.currentTabId();
	if (current === void 0) throw new Error("browser: no tab open");
	return current;
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map