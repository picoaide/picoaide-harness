# PicoAide Harness Documentation

[中文文档](README.md)

This directory is the documentation entry for PicoAide Harness. **User documentation has moved to the official wiki** ([Desktop Client](https://www.picoaide.com/en/docs/desktop/) · [Product Philosophy](https://www.picoaide.com/en/docs/philosophy/) · [FAQ](https://www.picoaide.com/en/docs/faq/)); this directory keeps maintainer-oriented material. Want to contribute? See [CONTRIBUTING](../CONTRIBUTING.en.md).

## Read by goal

Ordinary users should start at the official wiki ([Getting Started](https://www.picoaide.com/en/docs/getting-started/)) and do not need the developer docs.

### User content (single source: official wiki)

| Content | Wiki page |
| --- | --- |
| Install / usage / troubleshooting | [Desktop Client](https://www.picoaide.com/en/docs/desktop/) · [Getting Started](https://www.picoaide.com/en/docs/getting-started/) |
| FAQ | [FAQ](https://www.picoaide.com/en/docs/faq/) |
| Product positioning and design philosophy | [Product Philosophy](https://www.picoaide.com/en/docs/philosophy/) |
| Plugin development / ecosystem | [Plugin Development](https://www.picoaide.com/en/docs/plugin-development/) · [Plugin Ecosystem](https://www.picoaide.com/en/docs/plugin-ecosystem/) |
| System architecture / API | [System Architecture](https://www.picoaide.com/en/docs/architecture/) · [API Reference](https://www.picoaide.com/en/docs/api-reference/) |

> The corresponding in-repo files (`user-guide*`, `faq*`, `why-desktop*`, `plugin-ecosystem*`, `plugin-development*`) are now pointer pages to the wiki and no longer maintain independent content.

### Developer and maintainer documentation (in repo)

| Document | Covers |
| --- | --- |
| [Plugin ecosystem manifesto](plugin-ecosystem.en.md) | Points at the wiki plugin-ecosystem page |
| [Plugin development](plugin-development.en.md) | Points at the wiki plugin-development page |
| [Community Fabric Draft](../community/fabric/README.md) | Community interoperability drafts spanning manifest/capability foundations, Runtime/Presentation, service composition, and provenance diagnostics |
| [Fabric community-feedback disposition](../community/fabric/docs/research/community-issue-23-review.md) | Which Issue #23 proposals were adopted, split into focused RFCs, deferred, or kept out of portable core |
| [Fabric framework and plugin-needs research](../community/fabric/docs/research/mature-plugin-frameworks.md) | Mature Koishi, Chrome, and VS Code patterns plus requirements observed in real DSH plugins |
| [VS Code extension-model research](../community/fabric/docs/research/vscode-extension-model.md) | Implemented declaration, Provider, UI, placement, and lifecycle patterns, with concrete constraints for the Fabric RFC |

| [Architecture](architecture.en.md) | Electron, Host, loopback Web, the fixed profile, and packaging (maintainer view) |
| [Desktop service reference](../packages/host/desktop/docs/plugin-services.md) | Stable `desktopRuntime` and `desktopActions` contracts with TypeScript examples |
| [Package reference](../packages/host/desktop/README.md) | Detailed build, runtime, release, and limitation notes |
| [Server API full reference](../server/docs/03-api-reference.md) | All HTTP endpoints (the wiki publishes only the public summary) |

## README division of labor

The outer repository has two formal product READMEs plus one legacy compatibility entry:

- [`README.md`](../README.md): the Chinese product entry.
- [`README.en.md`](../README.en.md): the English product entry, same scope as the Chinese one.
- [`README.zh.md`](../README.zh.md): a legacy Chinese-path compatibility page with no independent content.

`README.i18n.yaml` records only the bilingual hashes of these two formal entries; it is not a user guide. `dsh-plugin-desktop/README.md` and `dsh-plugin-desktop/README.zh.md` are package-level references published with the npm package; they are more technical than the root README. `dsh-plugin-desktop/docs/` is a stable API contract, not marketing copy. `.agents/notes/implemented/` holds dated maintainer decision records — useful for reconstructing trade-offs, but not a substitute for user documentation.

`deepseek-harness/` is the pinned official upstream submodule. Its own README and `docs/` belong to the upstream project, are not Desktop documentation, and are not counted in this repository's product documentation.

## Status convention

These pages distinguish shipped behavior, platform limits, and roadmap items. The desktop shell is fixed to the advanced presentation: the Desktop-owned layout and native materials are always installed (Linux uses the standard system window frame). The community market remains at the documentation stage (see [`community/fabric`](../community/fabric/README.md)), with no usable page or installer; mobile remote control and Channels also remain separate roadmap items and are not implied to be part of the current installer.
