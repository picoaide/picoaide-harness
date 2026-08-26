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
export interface ArchiveEntry {
    /** Normalized relative path inside the archive (always `/`-free, no `..`). */
    name: string;
    data: Buffer;
}
export interface ExtractLimits {
    /** Total uncompressed bytes across all entries. */
    maxTotalBytes: number;
    /** Bytes of a single entry. */
    maxEntryBytes: number;
}
/**
 * Parse a (possibly gzipped) tar buffer into entries. Handles GNU long-name
 * headers (`L`), PAX extended headers (`x`/`g`), and the ustar `prefix`
 * field. Symlinks/hardlinks/special files are skipped (never extracted).
 */
export declare function readTarEntries(buffer: Buffer, limits?: ExtractLimits): ArchiveEntry[];
/** Parse a ZIP buffer into entries (store + deflate, UTF-8 names). */
export declare function readZipEntries(buffer: Buffer, limits?: ExtractLimits): ArchiveEntry[];
/** Parse an archive buffer (gzip/tar/zip) into entries. */
export declare function readArchiveEntries(buffer: Buffer, limits?: ExtractLimits): ArchiveEntry[];
/** Materialize entries under `destDir`; returns the materialized relative paths. */
export declare function extractEntries(entries: ArchiveEntry[], destDir: string): Promise<string[]>;
/** One-shot: parse + materialize an archive buffer. */
export declare function extractArchive(buffer: Buffer, destDir: string, limits?: ExtractLimits): Promise<string[]>;
/** Pick one entry by exact normalized name. */
export declare function findEntry(entries: ArchiveEntry[], name: string): ArchiveEntry | undefined;
