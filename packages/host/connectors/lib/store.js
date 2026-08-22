import { userScopePath } from "./user-scope.js";
import { promises } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
//#region src/store.ts
/** Per-user connector credential store under the product home. */
const DIRECTORY_MODE = 448;
const FILE_MODE = 384;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
/**
* Connector ids come from marketplace-derived definitions, so they are
* validated before crossing into the filesystem (no separators, no dot
* segments, no NUL, bounded length).
*/
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
function assertConnectorId(id) {
	if (!CONNECTOR_ID_PATTERN.test(id)) throw new Error(`invalid connector id ${JSON.stringify(id)}`);
	return id;
}
/** Reject a symlinked or non-directory store root before touching it. */
async function ensurePrivateDirectory(dir) {
	await promises.mkdir(dir, {
		recursive: true,
		mode: DIRECTORY_MODE
	});
	const stat = await promises.lstat(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`connector store directory is not a real directory: ${dir}`);
	await promises.chmod(dir, DIRECTORY_MODE);
}
var ConnectorStore = class {
	dir;
	constructor(options = {}) {
		this.dir = options.baseDir ?? join(userScopePath(options.username), "connectors");
	}
	path(id) {
		const safe = assertConnectorId(id);
		const resolved = resolve(this.dir, `${safe}.json`);
		if (dirname(resolved) !== resolve(this.dir)) throw new Error(`connector path escaped the store directory: ${id}`);
		return resolved;
	}
	async readCredential(id) {
		const file = this.path(id);
		try {
			const stat = await promises.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES) return null;
			const content = await promises.readFile(file, "utf8");
			if (Buffer.byteLength(content, "utf8") > MAX_CREDENTIAL_BYTES) return null;
			const value = JSON.parse(content);
			if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
			if (typeof value.updatedAt !== "number") return null;
			return value;
		} catch {
			return null;
		}
	}
	async writeCredential(id, credential) {
		await ensurePrivateDirectory(this.dir);
		const file = this.path(id);
		const temporary = join(this.dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			const handle = await promises.open(temporary, "wx", FILE_MODE);
			try {
				await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await promises.chmod(temporary, FILE_MODE);
			await promises.rename(temporary, file);
		} finally {
			await promises.unlink(temporary).catch((cause) => {
				if (cause.code !== "ENOENT") throw cause;
			});
		}
	}
	async updateCredential(id, patch) {
		const next = {
			...await this.readCredential(id) ?? { updatedAt: 0 },
			...patch,
			updatedAt: Date.now()
		};
		await this.writeCredential(id, next);
		return next;
	}
	async clearCredential(id) {
		try {
			await promises.unlink(this.path(id));
		} catch (cause) {
			if (cause.code !== "ENOENT") throw cause;
		}
	}
	async hasCredential(id) {
		return await this.readCredential(id) !== null;
	}
};
//#endregion
export { ConnectorStore };

//# sourceMappingURL=store.js.map