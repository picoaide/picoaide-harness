# DSH Community Market

[中文说明](README.zh.md)

DSH Community Market is the plugin-market shell for [DSH Desktop](../README.en.md). It helps people discover community plugins and understand what they do. Installation remains a later, separately reviewed phase.

> **Current status: read-only market MVP development.** The package now has loadable Host and Client entries, persisted user-owned source records, a constrained HTTPS client, standard and DSH 1024Store adapters, an official **Plugin market** tab under **Settings > Plugins**, and a sidebar launcher that opens the same market surface. The package remains private and has no installer.

## What we are building

The first usable version should make a small, understandable journey possible:

1. Browse and search a community catalog.
2. Open a plugin page with its description, source repository, and trust warning.
3. Choose **Install** and confirm the exact plugin and active profile.
4. Let Desktop run the existing managed DSH plugin command.
5. Prompt the user to restart Desktop when the profile change is complete.

The market is a shell around existing DSH capabilities. It does not invent a second plugin format, package manager, profile store, or privileged installer.

## Catalog sources

The market has no default catalog. People may save several sources, but browse exactly one selected source at a time. They may switch the selection or add a source that implements the published catalog contract. Switching source starts a fresh browsing session: the visible list, search, category selection, and pagination are reset. Every source is isolated behind an adapter, and the market UI sees only the same validated, normalized data model.

A conforming source publishes a [`catalog-source` manifest](docs/schemas/catalog-source.schema.json), and its `/v1/plugins` endpoint returns the [`catalog-provider-page` schema](docs/schemas/catalog-provider-page.schema.json). A source may provide `media.icon`; Desktop validates and proxies it before display. Sources without an icon remain valid and receive a local fallback. A conforming standard source needs no custom Market code.

For a standard source that declares `limit`, the current UI requests 50 listings by default and uses the same default for **Load more**. This is not a global provider limit: the standard contract permits page sizes through the manifest's `maxLimit`, up to the Schema safety maximum of 100. If the source does not declare `limit`, Desktop omits it and respects the manifest's `defaultLimit`. The reviewed 1024Store adapter is different: it downloads that provider's registry and exposes fixed local pages of 50. Selecting several categories matches any selected category. The category choices shown in the Market grow from the listings already loaded, so they are not a promise of every category held by a provider. A standard source that does not declare category support simply receives no category filter.

[DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) is one of the catalog providers currently cooperating with this project. The market ships a reviewed local adapter for its public API, but the cooperation does not make it enabled by default, preferred in sorting, a fallback when no source is selected, or an endorsement of its listings. That project independently maintains its discovery, validation, website, API, and the separately published `dsh-1024store` plugin. DSH Community Market is not a fork, repackaging, or official client of that plugin.

All catalog data is remote and untrusted. A listing means only that a provider supplied metadata; it does **not** mean that Anywhere Labs reviewed, recommends, or guarantees the plugin.

## Safety promise

- Background browsing never installs a package or executes repository code.
- Installation starts only after an explicit user action and confirmation.
- The market will independently resolve and pin an install target from a validated package or repository identity; it will never execute a command string returned by a catalog.
- The confirmation will show the exact source and active profile.
- Plugin changes will use the existing Desktop-managed DSH plugin service and run one operation at a time.
- The first release will not include accounts, telemetry, silent installs, automatic plugin updates, or a catalog backend.

Plugins run as local code with the user's permissions and may run package lifecycle scripts during installation. Read [Security](SECURITY.md) before implementing or reviewing installation behavior.

## Documentation

- [Market shell design](docs/market-shell.md): product boundary, architecture, profiles, failure behavior, and delivery phases.
- [Catalog provider contract](docs/catalog-provider-contract.md): source manifests, query parameters, wire and normalized JSON, selected-source behavior, and the implementation handoff.
- [Catalog adapter guide](docs/catalog-adapter-guide.md): the direct standard-source path, the reviewed adapter path for an existing API, and a mapping template.
- [Security](SECURITY.md): trust model, reporting, and non-negotiable installation rules.
- [Desktop plugin services](../dsh-plugin-desktop/docs/plugin-services.md): the existing `desktopProfiles` and `desktopPnpm` contracts the future implementation will consume.
- [DSH plugin development](../docs/plugin-development.en.md): the shared plugin model used by ordinary DSH and Desktop.

## Delivery plan

- **Phase 0 — complete:** package ownership, documentation, trust boundary, and headless checks.
- **Phase 1 — in development:** source selection, user-added conforming sources, one-source-at-a-time read-only browsing, search, plugin details, and loading/empty/error states.
- **Phase 2:** explicit installation into the active profile through the managed Desktop service.
- **Later:** uninstall, update, recovery, and richer verification signals.

Catalog collection, submission review, accounts, rankings, and hosting remain the responsibility of catalog providers rather than this package.

## License and attribution

Package code and documentation are licensed under the [MIT License](LICENSE). No DSH 1024Store code, artwork, or catalog snapshot is bundled in this scaffold. Its public catalog metadata is published under CC0-1.0; the source and provenance remain documented by the [upstream catalog project](https://github.com/imsai-sh/awesome-deepseek-harness-plugins).
