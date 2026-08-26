//#region src/cli-manifest.ts
/** Map a Node platform/arch pair to the manifest naming scheme. */
function cliPlatformKey(platform, arch) {
	switch (`${platform}-${arch}`) {
		case "darwin-x64": return "darwin-x64";
		case "darwin-arm64": return "darwin-arm64";
		case "linux-x64": return "linux-x64";
		case "linux-arm64": return "linux-arm64";
		case "win32-x64": return "win32-x64";
		case "win32-arm64": return "win32-arm64";
		default: return null;
	}
}
/** sha256 of dws platform archives, from dingtalk-workspace-cli@1.0.59 `assets/checksums.txt`. */
const DWS_CHECKSUMS = {
	"dws-linux-amd64.tar.gz": "be1eb9a1f8fc5048e578b5b0bde212fc90baca0f289236c7c333d824bd869cf3",
	"dws-linux-arm64.tar.gz": "5bfe9ac7d1798b028f0fad579bbdffec5898e2fb16ee36f5766ab58e208abd50",
	"dws-windows-amd64.zip": "5393a0d5e00c70b58833c60610ad3a772926ca5e4eb38c360928e3d2552451bc",
	"dws-windows-arm64.zip": "8c1a8eaa527a56197fd1a26d21b0f6c8b8b0e2270d1ad4c1d97519f4cab0f094",
	"dws-darwin-amd64.tar.gz": "fd14b0b1a1475891fb243bf6453857a1044ab5a40bcf7dc1c7c795f57e5b03ba",
	"dws-darwin-arm64.tar.gz": "61135a2a9286204ce060847e653c63c1e9784a0fa631bb7e0563b90628762a35"
};
const DWS_PLATFORM_ASSET = {
	"darwin-x64": "dws-darwin-amd64.tar.gz",
	"darwin-arm64": "dws-darwin-arm64.tar.gz",
	"linux-x64": "dws-linux-amd64.tar.gz",
	"linux-arm64": "dws-linux-arm64.tar.gz",
	"win32-x64": "dws-windows-amd64.zip",
	"win32-arm64": "dws-windows-arm64.zip"
};
/** sha256 of beisen platform archives, from beisen-cli@1.0.5 `checksums.txt`. */
const BEISEN_CHECKSUMS = {
	"beisen-cli-v1.0.5-linux-amd64.tar.gz": "60c14546901dac928ffb278f4ff54803634d360cd21a1814c87b213ac8918277",
	"beisen-cli-v1.0.5-linux-arm64.tar.gz": "035539a6a62a82b4ad260e4321320239562d461d77cd70cf2a20ebe223f74d66",
	"beisen-cli-v1.0.5-windows-amd64.zip": "55bb67e429fd1f22b7299846d6f9d0698dcaad4e339c892c76e09965b97fa80d",
	"beisen-cli-v1.0.5-windows-arm64.zip": "d1543df15296cab6b640d7a528c6597271e8b4be9fd309e983e91c1065ccace2",
	"beisen-cli-v1.0.5-darwin-amd64.tar.gz": "db623686476cc7273fa40126c89002a35a4b2e2d93e102195e6b65a1e851df7b",
	"beisen-cli-v1.0.5-darwin-arm64.tar.gz": "1a909801814be54f581bcc737bff62189c340f4eac97b3fb7ad52398765d7a71"
};
const BEISEN_PLATFORM_URL = {
	"darwin-x64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-darwin-amd64.tar.gz",
	"darwin-arm64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-darwin-arm64.tar.gz",
	"linux-x64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-linux-amd64.tar.gz",
	"linux-arm64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-linux-arm64.tar.gz",
	"win32-x64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-windows-amd64.zip",
	"win32-arm64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-windows-arm64.zip"
};
/**
* dingtalk-workspace-cli ships every platform binary inside its npm tarball
* (`assets/dws-<platform>-<arch>.tar.gz|zip`); the `dws` launcher script and
* its skills installer are intentionally NOT used (see README of the package:
* `dws skill setup` installs agent skills on demand and is a separate,
* opt-in workflow — the connector auth/MCP path only needs the binary).
*/
const DWS_MANIFEST = {
	command: "dws",
	version: "1.0.59",
	binaryName: "dws",
	displayName: "钉钉 dws（DingTalk Workspace CLI）",
	license: "Apache-2.0",
	source: {
		kind: "npm-package",
		packageName: "dingtalk-workspace-cli",
		packageVersion: "1.0.59",
		asset: (platform) => DWS_PLATFORM_ASSET[platform] ?? null,
		innerPath: (asset) => `package/assets/${asset}`,
		checksums: DWS_CHECKSUMS,
		registries: [process.env.PICOAIDE_CONNECTORS_NPM_MIRROR?.trim() || "https://registry.npmmirror.com", "https://registry.npmjs.org"]
	}
};
/**
* beisen-cli's npm package downloads the native binary at install time from
* the vendor CDN; the connector runtime does the same fetch itself, pinned to
* the checksums published in the package's `checksums.txt`.
* NOTE: the package declares `UNLICENSED` — redistributing the fetched binary
* follows the enterprise agreement with Beisen; see THIRD_PARTY_NOTICES.md.
*/
const BEISEN_MANIFEST = {
	command: "beisen-cli",
	version: "1.0.5",
	binaryName: "beisen-cli",
	displayName: "北森 beisen-cli（北森AI · HR专家）",
	license: "UNLICENSED",
	source: {
		kind: "direct",
		url: (platform) => BEISEN_PLATFORM_URL[platform] ?? null,
		checksums: BEISEN_CHECKSUMS
	}
};
/**
* lark-cli (飞书 CLI) ships native binaries as GitHub release assets mirrored
* at `registry.npmmirror.com/-/binary/lark-cli/v<version>/<archive>`. The npm
* package (@larksuite/cli) is only a JS wrapper whose postinstall downloads
* the same binary — the connector runtime fetches the archive directly,
* pinned to the vendor's published checksums, from the CN-friendly npmmirror
* binary endpoint (GitHub release as fallback).
*/
const LARK_CHECKSUMS = {
	"lark-cli-1.0.89-darwin-amd64.tar.gz": "1991736631266a2fa852664562260a2c2665bc9b1cbee35fadb4f6e40958656f",
	"lark-cli-1.0.89-darwin-arm64.tar.gz": "62417d641a2a15fddec9bac0c70f939570d5e2f3fa1410703b93f3284d02d044",
	"lark-cli-1.0.89-linux-amd64.tar.gz": "a07a603d29ed58e8b5b0d7395cae10dfabed2b860be31b7134f8bf39705e7cff",
	"lark-cli-1.0.89-linux-arm64.tar.gz": "9bff1d415e761e431aa12e01b1609c6ab8f84f1d30824fe5182c2c702e8b456b",
	"lark-cli-1.0.89-windows-amd64.zip": "c9587545f0d0f140d0f04b0ae51ad660e7557ef324a4061eddaf2b5159b3e3ec",
	"lark-cli-1.0.89-windows-arm64.zip": "52026a520a7292b4469e7d8ec1b89662b4fc847de1463ddf254d93074dbdbfdb"
};
const LARK_PLATFORM_ASSET = {
	"darwin-x64": "lark-cli-1.0.89-darwin-amd64.tar.gz",
	"darwin-arm64": "lark-cli-1.0.89-darwin-arm64.tar.gz",
	"linux-x64": "lark-cli-1.0.89-linux-amd64.tar.gz",
	"linux-arm64": "lark-cli-1.0.89-linux-arm64.tar.gz",
	"win32-x64": "lark-cli-1.0.89-windows-amd64.zip",
	"win32-arm64": "lark-cli-1.0.89-windows-arm64.zip"
};
const LARK_MIRROR_BASE = "https://registry.npmmirror.com/-/binary/lark-cli/v1.0.89";
const LARK_MANIFEST = {
	command: "lark-cli",
	version: "1.0.89",
	binaryName: "lark-cli",
	displayName: "飞书 lark-cli（Lark CLI）",
	license: "MIT",
	source: {
		kind: "direct",
		url: (platform) => {
			const asset = LARK_PLATFORM_ASSET[platform] ?? null;
			if (!asset) return null;
			return `${process.env.PICOAIDE_LARK_MIRROR_URL?.trim() || LARK_MIRROR_BASE}/${asset}`;
		},
		checksums: LARK_CHECKSUMS
	}
};
/**
* wecom-cli (企业微信 CLI) ships one native binary per platform as a package:
* `@wecom/cli-<platform>-<arch>` — the tarball is a bare platform package
* holding `package/bin/wecom-cli` (or `.exe` on win32). Because the package
* name differs per platform, the connector runtime fetches each platform
* tarball directly from the CN-friendly npmmirror (tarball URL pattern
* `@wecom/cli-<platform>/-/cli-<platform>-1.1.0.tgz`), pinned to the
* published sha256, and extracts the bare binary from `package/bin/`.
* Windows arm64 has no published package (win32-x64 only); that platform
* falls back to the npm-install hint until a binary is published.
*/
const WECOM_PLATFORM_TARBALL = {
	"darwin-x64": "@wecom/cli-darwin-x64/-/cli-darwin-x64-1.1.0.tgz",
	"darwin-arm64": "@wecom/cli-darwin-arm64/-/cli-darwin-arm64-1.1.0.tgz",
	"linux-x64": "@wecom/cli-linux-x64/-/cli-linux-x64-1.1.0.tgz",
	"linux-arm64": "@wecom/cli-linux-arm64/-/cli-linux-arm64-1.1.0.tgz",
	"win32-x64": "@wecom/cli-win32-x64/-/cli-win32-x64-1.1.0.tgz",
	"win32-arm64": ""
};
const WECOM_CHECKSUMS = {
	"cli-darwin-arm64-1.1.0.tgz": "abaa9734561b6c45459bdc831afff29f2b3011d1d63045ea88253848e1320aee",
	"cli-darwin-x64-1.1.0.tgz": "bfb65abaed9d30531e098c2bcac99128fd6fd2dc11fb3aa3c88124bc4e0bf9b9",
	"cli-linux-arm64-1.1.0.tgz": "af0c82da430f25dde50398113eec032241152af1acc7e3178d385c2930ee3519",
	"cli-linux-x64-1.1.0.tgz": "8da74fecd9b89a92876e72d663dad5e436c771c91bb051d99b2eb63a1d889516",
	"cli-win32-x64-1.1.0.tgz": "1e7f24cccdc9d61706a717f8765e114663b3911e11b1e22814dea855ae77d313"
};
const WECOM_MIRROR_BASE = process.env.PICOAIDE_CONNECTORS_NPM_MIRROR?.trim() || "https://registry.npmmirror.com";
const WECOM_MANIFEST = {
	command: "wecom-cli",
	version: "1.1.0",
	binaryName: "wecom-cli",
	displayName: "企业微信 wecom-cli（WeCom CLI）",
	license: "UNLICENSED",
	source: {
		kind: "direct",
		url: (platform) => {
			const tarball = WECOM_PLATFORM_TARBALL[platform];
			if (!tarball) return null;
			return `${WECOM_MIRROR_BASE}/${tarball}`;
		},
		checksums: WECOM_CHECKSUMS
	}
};
/** Built-in manifests keyed by command name. */
const CLI_MANIFESTS = /* @__PURE__ */ new Map([
	[DWS_MANIFEST.command, DWS_MANIFEST],
	[BEISEN_MANIFEST.command, BEISEN_MANIFEST],
	[LARK_MANIFEST.command, LARK_MANIFEST],
	[WECOM_MANIFEST.command, WECOM_MANIFEST]
]);
//#endregion
export { CLI_MANIFESTS, cliPlatformKey };

//# sourceMappingURL=cli-manifest.js.map