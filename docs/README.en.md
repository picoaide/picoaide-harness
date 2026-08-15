# DSH Desktop Documentation

[中文文档](README.md)

This directory is the product and developer documentation index for DSH Desktop. The root [`README.en.md`](../README.en.md) is the short product entry point; these pages explain why the project exists, how to use it, and how to build plugins for it.

## Read by goal

| Audience | Document | Covers |
| --- | --- | --- |
| New users | [User guide](user-guide.en.md) | Installation, profiles, modes, terminal, plugins, and updates |
| Project context | [Why Desktop](why-desktop.en.md) | The boundary with upstream Harness and the case for plugins |
| Plugin authors | [Plugin development](plugin-development.en.md) | Ordinary DSH plugins, Desktop services, compatibility, and lifecycle |
| Architecture/maintainers | [Architecture](architecture.en.md) | Electron, Host, loopback Web, profiles, and packaging |
| Desktop service reference | [`dsh-plugin-desktop/docs/plugin-services.md`](../dsh-plugin-desktop/docs/plugin-services.md) | Stable `desktopProfiles` and `desktopPnpm` contracts with TypeScript examples |
| Package reference | [`dsh-plugin-desktop/README.md`](../dsh-plugin-desktop/README.md) | Detailed build, runtime, release, and limitation notes |

## How the README files are organized

The outer repository has two formal product READMEs plus one legacy compatibility entry:

- [`README.md`](../README.md): the Chinese product entry point.
- [`README.en.md`](../README.en.md): the English product entry point with the same product scope.
- [`README.zh.md`](../README.zh.md): a legacy Chinese-path compatibility page with no independent content.

`README.i18n.yaml` records the bilingual blob hashes for those two formal entry points; it is not a user guide. `dsh-plugin-desktop/README.md` and `dsh-plugin-desktop/README.zh.md` ship with the npm package and are the more technical package reference. `dsh-plugin-desktop/docs/` contains stable API contracts rather than marketing copy. `.agents/notes/implemented/` contains dated maintainer decision records and does not replace user documentation.

`deepseek-harness/` is the pinned upstream submodule. Its README and `docs/` belong to the upstream project, not to the Desktop product, and are excluded from the outer documentation inventory.

## Status convention

These pages distinguish shipped behavior, platform limits, and roadmap items. Compatibility mode keeps the upstream default Web client; advanced mode installs the Desktop-owned layout and native materials. The plugin marketplace, mobile remote control, and Channels remain separate roadmap items and are not implied to be part of the current installer.
