import { promises } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
//#region src/archive.ts
/**
* Minimal, dependency-free archive extractor for the connector CLI downloader.
*
* Supports the two archive families the pinned CLIs ship as: POSIX tar
* (optionally gzip-compressed, with GNU long-name and PAX headers) and ZIP
* (store + deflate). Only regular files and directories are materialized:
*
* - path traversal (`../`, absolute paths, backslashes, NUL) is rejected;
* - symlinks / hardlinks are never created (a crafted archive must not be
*   able to write outside the extraction root through link semantics);
* - total and per-entry byte budgets bound decompression bombs.
*
* These guarantees matter because archives arrive from the network; even
* though every archive is sha256-pinned before extraction, extraction itself
* must not be a write primitive outside the target directory.
*/
const DEFAULT_LIMITS = {
	maxTotalBytes: 80 * 1024 * 1024,
	maxEntryBytes: 64 * 1024 * 1024
};
const TAR_BLOCK = 512;
/** Reject unsafe entry names before they reach the filesystem. */
function assertSafeName(name) {
	if (name.length === 0) throw new Error("archive entry with empty name");
	if (name.includes("\0") || name.includes("\\")) throw new Error(`unsafe archive entry name: ${JSON.stringify(name)}`);
	const normalized = name.replace(/\/+/g, "/");
	if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`unsafe archive entry name: ${JSON.stringify(name)}`);
	return normalized;
}
function parseOctal(text) {
	const value = Number.parseInt(text.trim(), 8);
	return Number.isFinite(value) ? value : 0;
}
/** Octal size field, with GNU base-256 fallback (high bit set). */
function parseSize(field) {
	if (field.length === 0) return 0;
	if ((field[0] & 128) !== 0) {
		let value = field[0] & 127;
		for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
		return value;
	}
	return parseOctal(field.toString("latin1"));
}
/**
* Parse a (possibly gzipped) tar buffer into entries. Handles GNU long-name
* headers (`L`), PAX extended headers (`x`/`g`), and the ustar `prefix`
* field. Symlinks/hardlinks/special files are skipped (never extracted).
*/
function readTarEntries(buffer, limits = DEFAULT_LIMITS) {
	const entries = [];
	let offset = 0;
	let pendingLongName;
	let total = 0;
	const takeBlock = () => {
		if (offset + TAR_BLOCK > buffer.length) return null;
		const block = buffer.subarray(offset, offset + TAR_BLOCK);
		offset += TAR_BLOCK;
		return block;
	};
	while (offset < buffer.length) {
		const header = takeBlock();
		if (!header) break;
		if (header.every((byte) => byte === 0)) break;
		const typeflag = String.fromCharCode(header[156] ?? 0);
		const size = parseSize(header.subarray(124, 136));
		if (size < 0 || !Number.isSafeInteger(size)) throw new Error("invalid tar entry size");
		let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
		const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
		if (prefix) name = `${prefix}/${name}`;
		if (typeflag === "L") {
			pendingLongName = takeData(size).toString("utf8").replace(/\0.*$/s, "");
			continue;
		}
		if (typeflag === "x" || typeflag === "g") {
			const data = takeData(size);
			for (const line of data.toString("utf8").split("\n")) {
				const match = /^\d+ path=(.*)$/u.exec(line);
				if (match && typeflag === "x") pendingLongName = match[1];
			}
			continue;
		}
		if (pendingLongName !== void 0) {
			name = pendingLongName;
			pendingLongName = void 0;
		}
		const safe = assertSafeName(name);
		if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
			const data = takeData(size);
			total += data.length;
			if (total > limits.maxTotalBytes) throw new Error("archive exceeds total size limit");
			if (data.length > limits.maxEntryBytes) throw new Error("archive entry exceeds size limit");
			entries.push({
				name: safe,
				data
			});
		} else if (typeflag === "5") {
			entries.push({
				name: safe.replace(/\/+$/, ""),
				data: Buffer.alloc(0)
			});
			skipData(size);
		} else skipData(size);
	}
	return entries;
	function takeData(size) {
		if (offset + size > buffer.length) throw new Error("truncated tar archive");
		const data = buffer.subarray(offset, offset + size);
		offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
		return data;
	}
	function skipData(size) {
		if (offset + size > buffer.length) throw new Error("truncated tar archive");
		offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
	}
}
/** Parse a ZIP buffer into entries (store + deflate, UTF-8 names). */
function readZipEntries(buffer, limits = DEFAULT_LIMITS) {
	const EOCD = 101010256;
	let eocd = -1;
	const tail = Math.min(buffer.length, 65557);
	for (let i = buffer.length - 22; i >= buffer.length - tail; i -= 1) if (buffer.readUInt32LE(i) === EOCD) {
		eocd = i;
		break;
	}
	if (eocd < 0) throw new Error("invalid zip archive: no end-of-central-directory record");
	const totalEntries = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	const entries = [];
	let total = 0;
	for (let i = 0; i < totalEntries; i += 1) {
		if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 33639248) throw new Error("invalid zip archive: bad central directory entry");
		const method = buffer.readUInt16LE(cursor + 10);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const externalAttrs = buffer.readUInt32LE(cursor + 38);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		cursor += 46 + nameLength + extraLength + commentLength;
		const safe = assertSafeName(name);
		const unixType = externalAttrs >>> 16 & 61440;
		if (unixType === 40960) continue;
		if (safe.endsWith("/") || unixType === 16384) {
			entries.push({
				name: safe.replace(/\/+$/, ""),
				data: Buffer.alloc(0)
			});
			continue;
		}
		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 67324752) throw new Error("invalid zip archive: bad local file header");
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		if (dataStart + compressedSize > buffer.length) throw new Error("truncated zip archive");
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		let data;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = inflateRawSync(raw);
		else throw new Error(`unsupported zip compression method ${method}`);
		total += data.length;
		if (total > limits.maxTotalBytes) throw new Error("archive exceeds total size limit");
		if (data.length > limits.maxEntryBytes) throw new Error("archive entry exceeds size limit");
		entries.push({
			name: safe,
			data
		});
	}
	return entries;
}
/** Parse an archive buffer (gzip/tar/zip) into entries. */
function readArchiveEntries(buffer, limits = DEFAULT_LIMITS) {
	if (buffer.length >= 2 && buffer[0] === 31 && buffer[1] === 139) return readTarEntries(gunzipSync(buffer), limits);
	if (buffer.length >= 4 && buffer.readUInt32LE(0) === 67324752) return readZipEntries(buffer, limits);
	if (buffer.length >= 262 && buffer.toString("latin1", 257, 262) === "ustar") return readTarEntries(buffer, limits);
	throw new Error("不支持的压缩格式");
}
/** Materialize entries under `destDir`; returns the materialized relative paths. */
async function extractEntries(entries, destDir) {
	const root = resolve(destDir);
	await promises.mkdir(root, { recursive: true });
	const written = [];
	for (const entry of entries) {
		const target = resolve(root, entry.name);
		if (target !== root && !target.startsWith(root + sep)) throw new Error(`archive entry escapes extraction root: ${entry.name}`);
		if (entry.data.length === 0) {
			await promises.mkdir(target, { recursive: true });
			continue;
		}
		await promises.mkdir(dirname(target), { recursive: true });
		await promises.writeFile(target, entry.data, { mode: 493 });
		written.push(entry.name);
	}
	return written;
}
/** One-shot: parse + materialize an archive buffer. */
async function extractArchive(buffer, destDir, limits) {
	return extractEntries(readArchiveEntries(buffer, limits), destDir);
}
/** Pick one entry by exact normalized name. */
function findEntry(entries, name) {
	return entries.find((entry) => entry.name === name);
}
//#endregion
export { extractArchive, extractEntries, findEntry, readArchiveEntries, readTarEntries, readZipEntries };

//# sourceMappingURL=archive.js.map