//#region src/index.ts
/**
* Product-default host locale. Matches the client dictionaries, whose
* module-level default is also Chinese (`setActiveLocale` falls back to `zh`
* for any unknown id).
*/
const DEFAULT_HOST_LOCALE = "zh";
/** Locale ids in preference order, for callers that need to enumerate them. */
const HOST_LOCALES = ["zh", "en"];
/**
* Narrow any runtime value to a shipped host locale, or `undefined` when the
* value names a language this product does not ship.
*
* Prefix matching keeps region subtags working (`zh-CN`/`en_US`); an
* unsupported id returns `undefined` (rather than the default) so
* {@link hostLocaleFrom} can keep looking at the request header.
* @param value - raw runtime or platform language tag.
* @returns the shipped locale, or undefined.
*/
function tryNormalizeHostLocale(value) {
	if (typeof value !== "string") return void 0;
	const primary = value.trim().toLowerCase().split(/[-_]/u)[0] ?? "";
	if (primary === "en") return "en";
	if (primary === "zh") return "zh";
}
/** Narrow any runtime value to a shipped host locale (defaults to zh). */
function normalizeHostLocale(value) {
	return tryNormalizeHostLocale(value) ?? "zh";
}
/**
* Resolve the host locale from the probed desktop runtime, then the request's
* `Accept-Language`, then {@link DEFAULT_HOST_LOCALE}.
*
* The runtime wins over the header on purpose: it carries the user's explicit
* in-app choice, which must beat anything the client advertises.
* @param runtime - probed `desktopRuntime`, or `undefined` when absent.
* @param acceptLanguage - raw `Accept-Language` request header, when there is a request.
* @returns the locale to render host copy in.
*/
function hostLocaleFrom(runtime, acceptLanguage) {
	const fromRuntime = tryNormalizeHostLocale(runtime?.locale);
	if (fromRuntime !== void 0) return fromRuntime;
	return preferredLocaleFromAcceptLanguage(acceptLanguage) ?? "zh";
}
/** Pick the copy for a locale (zh is the source, en mirrors the full set). */
function hostCopy(locale, zh, en) {
	return locale === "en" ? en : zh;
}
/**
* First supported locale named by an `Accept-Language` header.
*
* Parses the q-value order rather than trusting positional order, because
* clients emit `*` and zero-quality entries that must not win. Unsupported
* languages are skipped so a `ja,zh;q=0.8` client still gets Chinese.
* @param header - raw header value, possibly absent or malformed.
* @returns a supported locale, or `undefined` when the header names none.
*/
function preferredLocaleFromAcceptLanguage(header) {
	if (typeof header !== "string" || header.trim() === "") return void 0;
	const ranked = header.split(",").map((part, index) => {
		const [tag = "", ...params] = part.split(";");
		const quality = params.map((param) => param.trim()).filter((param) => param.startsWith("q=")).map((param) => Number.parseFloat(param.slice(2))).find((value) => Number.isFinite(value));
		return {
			tag: tag.trim().toLowerCase(),
			quality: quality ?? 1,
			index
		};
	}).filter((entry) => entry.tag !== "" && entry.quality > 0).sort((left, right) => right.quality - left.quality || left.index - right.index);
	for (const { tag } of ranked) {
		if (tag === "*") continue;
		if (tag === "zh" || tag.startsWith("zh-") || tag.startsWith("zh_")) return "zh";
		if (tag === "en" || tag.startsWith("en-") || tag.startsWith("en_")) return "en";
	}
}
/**
* Render one locale's variant of a bilingual template.
*
* The injected HTML pages carry their copy inline, so they are built per
* request from a `{ zh, en }` pair rather than substituted placeholder by
* placeholder. Keeping the pick here means every host surface resolves the
* locale the same way.
* @param locale - active host locale.
* @param variants - the two renderings.
* @returns the rendering for `locale`.
*/
function selectHostVariant(locale, variants) {
	return variants[locale];
}
//#endregion
export { DEFAULT_HOST_LOCALE, HOST_LOCALES, hostCopy, hostLocaleFrom, normalizeHostLocale, preferredLocaleFromAcceptLanguage, selectHostVariant, tryNormalizeHostLocale };

//# sourceMappingURL=index.js.map