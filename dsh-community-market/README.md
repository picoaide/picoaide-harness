# DSH Community Market

[中文说明](README.zh.md)

DSH Community Market is the plugin-market shell for [DSH Desktop](../README.en.md). It helps people discover community plugins and, on Desktop, install or remove the small set of npm packages that pass the Market Host's checks.

> **Current status: private integration-testing MVP.** The package has loadable Host and Client entries, persisted user-owned source records, a constrained HTTPS client, standard and DSH 1024Store adapters, an official **Plugin market** tab under **Settings > Plugins**, a sidebar launcher, and Host-managed install and receipt-backed uninstall flows. This is not a claim that listed or installable plugin code is safe.

## What we are building

The current interface has four views:

1. **Discover** shows all normalized listings loaded from the selected source. Details and repository links are read-only here.
2. **Installable** is a fail-closed local candidate list derived from the complete index. It requires reviewed provider verification with a `repository_backlink`, an exact stable npm version, and a canonical repository, and excludes blocked packages plus packages already present in the active profile or its Market receipts. Building this list does not query npm for every package.
3. **Installed** shows only receipts created by this Market for the active profile. It does not infer installation from the catalog.
4. **Sources** selects and manages catalog sources. Exactly one source is browsed at a time.

Choosing **Install** asks the Host to verify that one candidate against the official npm registry, including identity, repository, integrity, runtime, lifecycle scripts, DSH bundle evidence, and the active profile. Only a successful preview produces a confirmation for the exact package. The Host repeats mutable checks immediately before execution. A successful profile change requires a Desktop restart. The market is a shell around existing DSH capabilities; it does not invent a second plugin format, package manager, profile store, or privileged installer.

## Catalog sources

The market has no default catalog. People may save several sources, but browse exactly one selected source at a time. They may switch the selection or add a source that implements the published catalog contract. Switching source starts a fresh browsing session: the visible list, search, category selection, and pagination are reset. Every source is isolated behind an adapter, and the market UI sees only the same validated, normalized data model.

A conforming source publishes a [`catalog-source` manifest](docs/schemas/catalog-source.schema.json), and its `/v1/plugins` endpoint returns the [`catalog-provider-page` schema](docs/schemas/catalog-provider-page.schema.json). A source may provide `media.icon`; Desktop validates and proxies it before display. Sources without an icon remain valid and receive a local fallback. A conforming standard source needs no custom Market code.

Before presenting a selected source, the Host builds one complete, validated local index. A standard source is scanned through its declared cursor and page limits; the reviewed 1024Store adapter reads its full registry once and normalizes it in Schema-bounded chunks. Search, multi-category OR filtering, category choices, and pagination then run against that complete local index without refetching the provider for each interaction. Every visible page contains at most 50 items, and the category choices cover all categories in the index rather than only pages already shown. **Installable** is a fail-closed structural subset of the same index; authoritative npm verification begins only when the user previews one candidate.

The Host reuses a completed index until its cache expires (currently five minutes by default). When optional index metadata is returned, `scannedAt` identifies the completed scan, `expiresAt` its cache deadline, optional `providerRevision` the source revision observed consistently across the scan, and `cacheStatus` whether the response was freshly scanned or reused. An explicit refresh replaces the index and bypasses the underlying catalog-response cache; it is not merely a repaint of the current 50 items.

[DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) is one of the catalog providers currently cooperating with this project. The market ships a reviewed local adapter for its public API, but the cooperation does not make it enabled by default, preferred in sorting, a fallback when no source is selected, or an endorsement of its listings. That project independently maintains its discovery, validation, website, API, and the separately published `dsh-1024store` plugin. DSH Community Market is not a fork, repackaging, or official client of that plugin.

All catalog data is remote and untrusted. A listing means only that a provider supplied metadata; it does **not** mean that Anywhere Labs reviewed, recommends, or guarantees the plugin.

## Safety promise

- Background browsing never installs a package or executes repository code.
- Installation starts only after an explicit user action and confirmation.
- **Installable** is a Host-produced, fail-closed structural candidate set, not a renderer guess or proof that npm was checked. A candidate needs reviewed provider verification with `repository_backlink`, an exact stable npm target, and a canonical repository, and must not already be installed, receipted, or locally blocked. Preview performs the first authoritative official-registry check for that one package; execution repeats mutable checks.
- The MVP accepts exact stable npm versions only. It does not install GitHub URLs, mutable ranges or tags, deprecated packages, packages whose target manifest defines `preinstall`, `install`, `postinstall`, or `prepare`, or packages incompatible with the bundled DSH rc.7 or Node.js runtime.
- Provider-supplied command strings, install snippets, and repository install instructions are never executed. The renderer submits source/item or receipt identifiers, not a package-manager command.
- The confirmation shows the exact npm package and version plus the active profile. Plugin changes use the existing Desktop-managed DSH plugin service and run one operation at a time.
- Uninstall is available only for a valid Market receipt in the active profile. Because the receipt is local, a plugin remains removable if its catalog source is later disabled, deleted, or offline.
- The first release will not include accounts, telemetry, silent installs, automatic plugin updates, or a catalog backend.

These checks establish package identity and a narrow compatibility boundary; they do **not** review the plugin or its dependency tree for malicious or unsafe behavior. Installed plugins run as local code with the user's permissions. Read [Install and uninstall](docs/install-and-uninstall.md) and [Security](SECURITY.md) before testing or reviewing package operations.

## Documentation

- [Market shell design](docs/market-shell.md): product boundary, architecture, profiles, failure behavior, and delivery phases.
- [Install and uninstall](docs/install-and-uninstall.md): the four views, user workflow, Host verification, receipts, supported targets, and developer integration boundary.
- [Catalog provider contract](docs/catalog-provider-contract.md): source manifests, query parameters, wire and normalized JSON, selected-source behavior, and the implementation handoff.
- [Catalog adapter guide](docs/catalog-adapter-guide.md): the direct standard-source path, the reviewed adapter path for an existing API, and a mapping template.
- [Security](SECURITY.md): trust model, reporting, and non-negotiable installation rules.
- [Desktop plugin services](../dsh-plugin-desktop/docs/plugin-services.md): the `desktopProfiles` and `desktopPnpm` contracts used by Market package operations.
- [DSH plugin development](../docs/plugin-development.en.md): the shared plugin model used by ordinary DSH and Desktop.

## Delivery plan

- **Phase 0 — complete:** package ownership, documentation, trust boundary, and headless checks.
- **Phase 1 — implemented for integration testing:** source selection, user-added conforming sources, one-source-at-a-time browsing, search, plugin details, and loading/empty/error states.
- **Phase 2 — implemented for integration testing:** exact stable npm installation into the active profile and receipt-backed uninstall through the managed Desktop service.
- **Later:** updates, richer recovery, broader compatibility evidence, and release review.

Catalog collection, submission review, accounts, rankings, and hosting remain the responsibility of catalog providers rather than this package.

## License and attribution

Package code and documentation are licensed under the [MIT License](LICENSE). No DSH 1024Store code, artwork, or catalog snapshot is bundled in this scaffold. Its public catalog metadata is published under CC0-1.0; the source and provenance remain documented by the [upstream catalog project](https://github.com/imsai-sh/awesome-deepseek-harness-plugins).
