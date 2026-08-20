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
* isolated from the main application's cookies/storage.
*/
const BROWSER_PARTITION = "persist:agent-browser";
/** Lazy real adapter over Electron (imported only on first browser start). */
function createRealElectronAdapter() {
	const { WebContentsView, BrowserWindow, dialog } = __require("electron");
	const mainWindowGone = /* @__PURE__ */ new Set();
	const watched = /* @__PURE__ */ new Set();
	const watchMainWindow = (win) => {
		if (watched.has(win)) return;
		watched.add(win);
		win.on("closed", () => {
			for (const listener of [...mainWindowGone]) try {
				listener();
			} catch {}
		});
	};
	const resolveMainWindow = () => {
		const main = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
		if (main !== void 0) watchMainWindow(main);
		return main;
	};
	return {
		createView() {
			const view = new WebContentsView({ webPreferences: {
				partition: BROWSER_PARTITION,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true
			} });
			const wc = view.webContents;
			wc.setWindowOpenHandler(() => ({ action: "deny" }));
			return {
				partition: BROWSER_PARTITION,
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
				detach() {
					const win = resolveMainWindow();
					if (win !== void 0 && !win.isDestroyed()) win.contentView.removeChildView(view);
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
		getMainWindow() {
			return resolveMainWindow();
		},
		showSaveDialog: async (options) => {
			const result = await dialog.showSaveDialog(options);
			return {
				canceled: result.canceled,
				filePath: result.filePath
			};
		},
		onMainWindowGone(listener) {
			mainWindowGone.add(listener);
			return () => {
				mainWindowGone.delete(listener);
			};
		}
	};
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
/** Whether a click target looks like a form submission (approval-worthy). */
function isSubmitTarget(kind, text, selector) {
	const lower = `${kind} ${text} ${selector}`.toLowerCase();
	return kind === "button" || lower.includes("submit") || lower.includes("登录") || lower.includes("登陆") || lower.includes("sign in") || lower.includes("log in") || lower.includes("signin") || lower.includes("login");
}
/** Whether a type target is a password field (approval-worthy). */
function isPasswordTarget(selector) {
	const lower = selector.toLowerCase();
	return lower.includes("password") || lower.includes("passwd") || lower.includes("pwd");
}
/**
* Guard bundle bound to one plugin lifetime. Approval is injected so unit
* tests can decide without the Cordis approval service; the download and
* permission hooks are bound to the browser session by the runtime.
*/
var BrowserGuard = class {
	adapter;
	/** Ask the composed answerers about one sensitive action. */
	askApproval;
	constructor(adapter, askApproval = async () => "rejected") {
		this.adapter = adapter;
		this.askApproval = askApproval;
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
			const total = item.getTotalBytes();
			const filename = item.getFilename() || "download";
			if (total > 104857600) {
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
	/** Gate one sensitive action through the approval seam. */
	async requireApproval(request) {
		return await this.askApproval(request) === "allowed-once";
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
	/** Run `work` while holding the browser control; rejects under takeover. */
	async run(work) {
		if (this.taken) throw new Error("browser: the user is currently controlling the browser; ask them to release it");
		const prev = this.tail;
		let release;
		this.tail = new Promise((resolve) => {
			release = resolve;
		});
		await prev;
		if (this.taken) {
			release();
			throw new Error("browser: the user took over the browser");
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
	}
	release() {
		this.taken = false;
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
	ops = [];
	opSeq = 0;
	panel = { visible: false };
	guard;
	permissionsDisposers = [];
	downloadDisposers = [];
	windowGoneDisposer;
	disposed = false;
	constructor(adapter, options = {}, askApproval, credentials) {
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
		this.guard = new BrowserGuard(adapter, askApproval);
		this.windowGoneDisposer = adapter.onMainWindowGone(() => {
			for (const tab of this.tabs.values()) tab.view.detach();
			this.panel = { visible: false };
		});
	}
	options;
	/** Current panel visibility + placement (set by the client panel). */
	get panelState() {
		return this.panel;
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
	/** Id of the visible tab, or undefined when none is open. */
	currentTabId() {
		return this.visibleTabId;
	}
	/** Public tab state (throws for unknown ids). */
	tabState(id) {
		return this.tabStateInternal(id);
	}
	/** Route a sensitive-action approval through the guard. */
	async requireApproval(request) {
		return await this.guard.requireApproval(request);
	}
	/** Update the panel placement and re-layout the visible view. */
	setPanel(state) {
		this.panel = state;
		if (!state.visible) {
			for (const tab of this.tabs.values()) tab.view.setVisible(false);
			return;
		}
		const visible = this.visibleTab();
		if (visible !== void 0 && state.bounds !== void 0) {
			visible.view.setVisible(true);
			visible.view.setBounds(state.bounds);
		}
	}
	record(tool, tab, summary, failed = false) {
		this.ops.push({
			seq: ++this.opSeq,
			time: Date.now(),
			tool,
			tab,
			summary,
			failed
		});
		if (this.ops.length > OP_LOG_LIMIT) this.ops.shift();
	}
	visibleTab() {
		return this.visibleTabId === void 0 ? void 0 : this.tabs.get(this.visibleTabId);
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
	*/
	async open(url) {
		if (this.disposed) throw new Error("browser: runtime disposed");
		if (this.tabs.size >= this.options.maxTabs) throw new Error(`browser: tab limit reached (${this.options.maxTabs}); close a tab first`);
		const id = this.nextTabId++;
		const view = this.adapter.createView();
		const cdp = new CdpSession(view.webContents.cdp);
		await cdp.attach();
		const tab = {
			id,
			view,
			cdp,
			url: "",
			title: "",
			loading: false
		};
		this.tabs.set(id, tab);
		const win = this.adapter.getMainWindow();
		if (win === void 0) throw new Error("browser: no main window (the browser needs the desktop shell)");
		if (this.panel.visible && this.panel.bounds !== void 0) {
			view.attach(win, this.panel.bounds);
			view.setVisible(true);
		} else {
			view.attach(win, {
				x: 0,
				y: 0,
				width: 0,
				height: 0
			});
			view.setVisible(false);
		}
		this.visibleTabId = id;
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
		if (url !== void 0 && url !== "") await this.navigate(id, url, "domcontentloaded");
		this.updateTabState(tab);
		this.record("browser_open", id, url === void 0 || url === "" ? "new tab" : url);
		return this.tabState(id);
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
	/** Run one agent operation under the control mutex. */
	async withControl(_tool, tabId, work) {
		return await this.mutex.run(async () => {
			const tab = this.tab(tabId);
			const result = await work(tab);
			this.updateTabState(tab);
			return result;
		});
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
	* tick.
	*/
	async navigate(id, url, waitUntil = "domcontentloaded") {
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
				if (waitUntil === "domcontentloaded" && wc.isLoading() === false && wc.getURL() !== "") settle();
			});
		};
	}
	/** Extract the interactable-element snapshot of one tab. */
	async snapshot(id) {
		return await this.withControl("browser_get_snapshot", id, (tab) => extractSnapshot((m, p) => tab.cdp.send(m, p), this.options.snapshotLimit));
	}
	/** Extract page text (optionally scoped by selector). */
	async text(id, selector) {
		return await this.withControl("browser_get_text", id, (tab) => extractText((m, p) => tab.cdp.send(m, p), selector, this.options.textLimit));
	}
	/** Capture a JPEG screenshot of one tab. */
	async screenshot(id) {
		return await this.withControl("browser_screenshot", id, (tab) => captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality));
	}
	/** Navigate history. */
	async goBack(id) {
		await this.withControl("browser_go_back", id, async (tab) => {
			const wc = tab.view.webContents;
			if (wc.isDestroyed()) return;
			wc.goBack();
			await this.waitForLoad(wc, "domcontentloaded")(this.options.timeoutMs);
			this.updateTabState(tab);
		});
	}
	async goForward(id) {
		await this.withControl("browser_go_forward", id, async (tab) => {
			const wc = tab.view.webContents;
			if (wc.isDestroyed()) return;
			wc.goForward();
			await this.waitForLoad(wc, "domcontentloaded")(this.options.timeoutMs);
			this.updateTabState(tab);
		});
	}
	async reload(id) {
		await this.withControl("browser_reload", id, async (tab) => {
			const wc = tab.view.webContents;
			if (wc.isDestroyed()) return;
			wc.reload();
			await this.waitForLoad(wc, "domcontentloaded")(this.options.timeoutMs);
			this.updateTabState(tab);
		});
	}
	/** Switch the visible tab. */
	async switchTab(id) {
		const tab = this.tab(id);
		for (const other of this.tabs.values()) other.view.setVisible(other.id === id);
		this.visibleTabId = id;
		if (this.panel.visible && this.panel.bounds !== void 0) tab.view.setBounds(this.panel.bounds);
		this.record("browser_switch_tab", id, `switch to tab ${id}`);
	}
	/** Close a tab and destroy its view/CDP. */
	async closeTab(id) {
		const tab = this.tabs.get(id);
		if (tab === void 0) return;
		tab.cdp.detach();
		tab.view.detach();
		tab.view.destroy();
		this.tabs.delete(id);
		if (this.visibleTabId === id) {
			this.visibleTabId = [...this.tabs.keys()].at(-1);
			if (this.visibleTabId !== void 0) await this.switchTab(this.visibleTabId);
		}
		this.record("browser_close_tab", id, `close tab ${id}`);
	}
	/** Close the whole browser (all tabs). */
	async closeAll() {
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
	}
	/** User takeover / release. */
	setUserControl(active) {
		if (active) this.mutex.take();
		else this.mutex.release();
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
	async eval(id, expression) {
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
		});
	}
	/** Locate an element and return its viewport-center point for CDP input. */
	async locateElement(id, selector) {
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
		});
	}
	/** Dispatch a left-click at a viewport point. */
	async clickAt(id, point) {
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
		});
	}
	/** Focus an element and insert text (Unicode-safe); clears first when requested. */
	async typeInto(id, selector, text, clear = true) {
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
		});
	}
	/** Dispatch one keyboard key. */
	async pressKey(id, key) {
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
		});
	}
	/** Set a select's value and fire change/input. */
	async selectOption(id, selector, value) {
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
		});
	}
	/**
	* Fill the login form with stored connector credentials. The resolver looks
	* up the connector's credential fields (username/password); the form's first
	* text/email input receives the username and its password input the
	* password. Callers must route this through approval (credentials are
	* sensitive).
	*/
	async fillCredentials(id, connectorId) {
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
		});
	}
	/** Scroll the page by a delta (or the element into view). */
	async scroll(id, deltaY, selector) {
		await this.withControl("browser_scroll", id, async (tab) => {
			const expression = selector === void 0 || selector === "" ? `window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' }); 'ok'` : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not found'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`;
			await tab.cdp.send("Runtime.evaluate", {
				expression,
				returnByValue: true
			});
		});
	}
	/** Dispose everything (plugin teardown). */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.windowGoneDisposer();
		this.closeAll();
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
7. Filling a password field or submitting a form will ask the user for approval; do not work around that.
8. browser_eval executes JavaScript in the page; it is powerful and prompts for approval — prefer the other tools.
9. Do not navigate away from a page you were asked to inspect without saying so first.
10. Close tabs you no longer need with browser_close_tab.`;
/** Resolve `target` (snapshot number or CSS selector) to a selector. */
async function resolveTarget(runtime, tabId, target) {
	if (typeof target === "string") {
		if (target.trim() === "") throw new Error("target selector must not be empty");
		return target.trim();
	}
	if (!Number.isInteger(target) || target < 1) throw new Error("target number must be a positive integer");
	const snapshot = await runtime.snapshot(tabId);
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
			const tab = await runtime.open(url ?? void 0);
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
			const tab = await runtime.open(url ?? void 0);
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
			await runtime.navigate(tabId, url.trim(), waitUntil ?? "domcontentloaded");
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
			await runtime.reload(tabId);
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
			await runtime.goBack(tabId);
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
			await runtime.goForward(tabId);
			exec.signal.throwIfAborted();
			return { url: runtime.tabState(tabId).url };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_click",
		description: "Click an element, targeted by its snapshot number or a CSS selector. Submitting forms or clicking buttons prompts the user for approval.",
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
				description: "Set true when this click submits a form (triggers the approval prompt)."
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
			const { tab, target, submit } = args;
			const tabId = await tabOf(tab);
			const snapshot = await runtime.snapshot(tabId);
			const entry = typeof target === "number" ? snapshot.find((item) => item.index === target) : void 0;
			const selector = await resolveTarget(runtime, tabId, target);
			if (submit === true || entry !== void 0 && isSubmitTarget(entry.kind, entry.text, entry.selector)) {
				if (!await runtime.requireApproval({
					agent: exec.agent,
					toolName: "browser_click",
					callId: exec.callId,
					reason: `提交表单或点击按钮: ${entry?.text ?? selector}`,
					signal: exec.signal
				})) throw new Error("browser: form submission was not approved by the user");
			}
			const point = await runtime.locateElement(tabId, selector);
			await runtime.clickAt(tabId, point);
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_type",
		description: "Type text into an input (snapshot number or CSS selector). Filling a password field prompts the user for approval.",
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
			if (isPasswordTarget(selector)) {
				if (!await runtime.requireApproval({
					agent: exec.agent,
					toolName: "browser_type",
					callId: exec.callId,
					reason: "向密码字段输入内容",
					signal: exec.signal
				})) throw new Error("browser: password entry was not approved by the user");
			}
			await runtime.typeInto(tabId, selector, text, clear !== false);
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
			await runtime.pressKey(tabId, key);
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
			await runtime.selectOption(tabId, selector, value);
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
			await runtime.scroll(tabId, deltaY ?? 0, selector);
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
			const dataUrl = await runtime.screenshot(tabId);
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
			const elements = await runtime.snapshot(tabId);
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
			const text = await runtime.text(tabId, selector);
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
			await runtime.switchTab(tabId);
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
			await runtime.closeTab(args.tab);
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
			await runtime.closeAll();
			exec.signal.throwIfAborted();
			return { ok: true };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_eval",
		description: "Execute JavaScript in the page context and return the JSON result. Powerful — every call prompts the user for approval. Prefer the other tools.",
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
			if (!await runtime.requireApproval({
				agent: exec.agent,
				toolName: "browser_eval",
				callId: exec.callId,
				reason: `在页面中执行 JavaScript: ${expression.slice(0, 120)}`,
				signal: exec.signal
			})) throw new Error("browser: eval was not approved by the user");
			const result = await runtime.eval(tabId, expression);
			exec.signal.throwIfAborted();
			return { result: String(result) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "browser_fill_credentials",
		description: "Fill the login form with credentials stored for a connector (e.g. an enterprise account). Prompts the user for approval. Does not submit the form.",
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
			if (!await runtime.requireApproval({
				agent: exec.agent,
				toolName: "browser_fill_credentials",
				callId: exec.callId,
				reason: `向登录表单注入连接器凭据: ${connectorId}`,
				signal: exec.signal
			})) throw new Error("browser: credential injection was not approved by the user");
			const filled = await runtime.fillCredentials(tabId, connectorId.trim());
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
	const askApproval = async (request) => {
		const approval = ctx.get("approval");
		if (approval === void 0) return "rejected";
		return await approval.request({
			agent: request.agent,
			toolName: request.toolName,
			...request.callId !== void 0 ? { callId: request.callId } : {},
			reason: request.reason,
			...request.signal !== void 0 ? { signal: request.signal } : {}
		});
	};
	const credentialResolver = (() => {
		try {
			const { ConnectorStore } = createRequire(import.meta.url)("@picoaide/dsh-connectors/store");
			const store = new ConnectorStore();
			return async (connectorId) => {
				const credential = await store.readCredential(connectorId);
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
	const runtime = new BrowserRuntime(createRealElectronAdapter(), config, askApproval, credentialResolver);
	applyBrowserTools(ctx, runtime);
	ctx.effect(() => {
		const action = (req, res) => {
			const rawAction = decodeSegment(req.url?.split("/")[4]?.split("?")[0]);
			handleAction(rawAction, req, res).catch((error) => {
				json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			});
		};
		const handleAction = async (action, req, res) => {
			const raw = await readJson(req);
			const body = raw !== null && typeof raw === "object" ? raw : {};
			switch (action) {
				case "panel": {
					const visible = body.visible === true;
					const b = body.bounds;
					runtime.setPanel({
						visible,
						...visible && b !== null && typeof b === "object" ? { bounds: {
							x: numberOr(b.x, 0),
							y: numberOr(b.y, 0),
							width: Math.max(0, numberOr(b.width, 0)),
							height: Math.max(0, numberOr(b.height, 0))
						} } : {}
					});
					json(res, 200, { ok: true });
					return;
				}
				case "open": {
					const url = typeof body.url === "string" ? body.url : void 0;
					json(res, 200, { tab: await runtime.open(url) });
					return;
				}
				case "navigate": {
					const tab = numberOr(body.tab, 0);
					const url = typeof body.url === "string" ? body.url : "";
					if (tab <= 0) return json(res, 400, { error: "tab is required" });
					await runtime.navigate(tab, url);
					json(res, 200, { ok: true });
					return;
				}
				case "reload":
					await runtime.reload(tabOf(runtime, body));
					json(res, 200, { ok: true });
					return;
				case "back":
					await runtime.goBack(tabOf(runtime, body));
					json(res, 200, { ok: true });
					return;
				case "forward":
					await runtime.goForward(tabOf(runtime, body));
					json(res, 200, { ok: true });
					return;
				case "close-tab": {
					const tab = numberOr(body.tab, 0);
					if (tab <= 0) return json(res, 400, { error: "tab is required" });
					await runtime.closeTab(tab);
					json(res, 200, { ok: true });
					return;
				}
				case "close-all":
					await runtime.closeAll();
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
		const state = (_req, res) => {
			json(res, 200, {
				tabs: runtime.listTabs(),
				panel: runtime.panelState,
				controlled: runtime.controlled
			});
		};
		const ops = (_req, res) => {
			json(res, 200, { ops: runtime.opLog });
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