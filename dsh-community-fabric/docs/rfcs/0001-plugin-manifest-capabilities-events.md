# RFC 0001: A Unified DSH Plugin Contract — Manifest, Capabilities, and Events

English | [中文](0001-plugin-manifest-capabilities-events.zh.md)

| Field | Value |
| --- | --- |
| Status | Draft / request for comments |
| Target | Experimental v0.1 |
| Scope | Interoperability contract between plugins and Hosts |
| Reference implementation | DSH Community Fabric (not implemented) |
| Discussion | Issues, discussions, and pull requests editing this document |

## 0. Summary

Define a community-governed, statically analyzable interoperability standard for DSH plugins. A plugin declares its identity and capability requirements in a manifest; a Host publishes a machine-readable descriptor and uses negotiation plus a common lifecycle to decide whether and how to activate it.

The proposal borrows the manifest-and-capability idea from browser extensions and the stable lifecycle-hook idea from Forge/Fabric. It does not claim to provide browser-grade isolation, and it must not create a second plugin-loading ecosystem beside DSH and Cordis.

## 1. Draft boundary

This is a community discussion draft, not an official DeepSeek or DSH standard and not an API developers can use today.

Existing DSH plugins continue to use current package metadata, Cordis services, slots, and patches. Fabric begins as an interoperability layer assembled by Host integrations over a versioned DSH Adapter. It neither requires immediate upstream changes nor requires a Host to remove built-in or legacy extensions.

The words MUST, SHOULD, and MAY describe the strength of proposals. They do not create a stable compatibility promise until the RFC is accepted, schemas are published, and conformance tests exist.

## 2. Motivation

The community now has GUI, Web UI, TUI, launcher, modpack, and distribution projects. Growth exposes common problems:

- compatibility requirements cannot be inspected reliably before installation;
- extensions tied to loader details, internal functions, or source patches break when implementations change;
- different Hosts expose different paths for the same user need;
- multiple plugins can alter one behavior without declaration, ordering, or conflict rules;
- markets and launchers lack static compatibility metadata and fall back to hand-tested locked combinations.

This proposal concentrates upstream-specific change in the versioned DSH Adapter while Host integrations own product policy and UX. Governance and the plugin-facing contract are not versioned with one DSH release. When upstream behavior changes, an Adapter and Host must adapt, explicitly downgrade, or stop advertising a capability rather than pretending its old semantics still hold.

This is not absolute independence from upstream. If upstream no longer exposes the observation or operation required for a capability, that capability cannot honestly be implemented.

## 3. Goals

1. **Static declaration:** inspect identity, version, entrypoints, capability requirements, and declarative contributions without executing code.
2. **Compatibility negotiation:** reject missing required capabilities clearly and allow deterministic degradation for missing optional capabilities.
3. **One community contract:** one normative API and behavior model for each operation covered by the standard.
4. **Adapt existing ecosystems:** implement the contract on DSH, Cordis, or another native Host mechanism rather than creating a parallel loader.
5. **Verifiability:** publish schemas, fixtures, and headless conformance tests for manifests, Host Descriptors, negotiation, and lifecycle behavior.
6. **Lower user friction:** let markets and launchers distinguish compatible, incompatible, awaiting authorization, tested, and unknown combinations before installation.

## 4. Non-goals

- Requiring immediate adoption by DSH upstream.
- Standardizing the internal rendering technology of GUI, Web UI, or TUI Hosts.
- Building a package manager, market backend, ranking system, or account service in this RFC.
- Treating valid static metadata as a source-code security review.
- Promising that arbitrary rich UI runs unchanged on every Host.
- Standardizing a complete set of mutable `before-*` events in v0.1.
- Requiring Hosts to remove built-in, legacy, or non-standard extension paths; those paths simply do not participate in Fabric conformance claims.

## 5. Trust and execution modes

Capability handling has four separate stages:

1. **support:** the Host says it can provide a capability;
2. **request:** the plugin asks for it in its manifest;
3. **grant:** the user or policy authorizes it;
4. **enforcement:** isolation prevents the plugin from bypassing the grant.

The v0.1 reference adapter may use a **trusted in-process** mode. In this mode, capabilities support compatibility, consent, and auditing; they are not a security sandbox. The Host must say so prominently.

A future **isolated** mode needs a separate specification covering process or realm isolation, module controls, mediated IPC, resource limits, filesystem and network scopes, crash recovery, and platform differences. A Host without that evidence must not claim technical permission enforcement.

## 6. Version model

The following versions are distinct:

| Name | Meaning |
| --- | --- |
| `version` | The plugin's own SemVer version. |
| `manifestVersion` | The JSON document structure version. |
| `apiVersion` | The community Host API compatibility range requested by the plugin. |
| Capability/event version | The contract version for one capability or payload; v0.1 may temporarily tie it to the API version. |
| Host version | The product version of a GUI, Web UI, TUI, or launcher. |
| SDK version | The release version of types and tooling, not automatically the standard version. |

Breaking standard changes require a new incompatible API range. During `0.x`, experimental releases must state their own compatibility discipline instead of presenting `1.x` stability.

### 6.1 Terminology

- **Host product:** a GUI, Web UI, TUI, or launcher product that supports plugins.
- **Host-side runtime face:** the Node.js environment inside a Host product that executes a v0.1 plugin entrypoint.
- **Activation instance:** one bounded activation of one plugin entrypoint; lifecycle and resource ownership are scoped to it.
- **Adapter:** the implementation mapping Fabric capabilities to a concrete DSH/Cordis version.

v0.1 specifies only a Host-side Node.js entrypoint and its activation instance. Browser Client, native UI, isolated Worker, and other executable faces plus their communication protocols are later RFCs. TUI is a Host product in this document, not a runtime-face name.

## 7. Core model

```text
Manifest (plugin identity and requests)
    ↓
Host Descriptor (Host support and execution mode)
    ↓
Negotiation + Authorization
    ↓
Lifecycle + Events
    ↓
Capability-scoped Host API
```

### 7.1 Manifest

v0.1 uses static JSON and rejects dynamically generated JavaScript manifests. A real implementation requires a published JSON Schema, fixed location, path rules, and valid/invalid fixtures. This example is only a discussion shape:

```json
{
  "manifestVersion": "0.1.0",
  "id": "com.example.message-memory",
  "name": "Message Memory",
  "version": "1.2.0",
  "apiVersion": ">=0.1.0 <0.2.0",
  "entrypoints": {
    "host": "dist/host.js"
  },
  "capabilities": {
    "required": {
      "messages.observe": ">=0.1.0 <0.2.0",
      "commands": ">=0.1.0 <0.2.0",
      "storage.local": ">=0.1.0 <0.2.0"
    },
    "optional": {
      "ui.panel.basic": ">=0.1.0 <0.2.0"
    }
  },
  "contributes": {
    "commands": [
      { "id": "com.example.message-memory.show-last", "title": "Show Last Message" }
    ]
  }
}
```

The final schema must also define:

- plugin ID syntax, namespace ownership, and collision handling;
- entrypoints constrained to the package root, module format, and execution environment;
- whether Host, renderer, and worker entrypoints coexist and how they communicate;
- capability version ranges and sensitive scopes;
- renewed consent when an update adds capabilities;
- contribution ID namespaces and conflicts;
- the authority of fields duplicated in npm package metadata.

Before freezing the schema, the working group must decide whether to separate four declaration classes: `requires` for Host feature dependencies, `permissions` for user grants, `contributes` for declarative extensions, and `subscriptions` for event interests. Sharing one manifest does not make them the same security object.

Following the VS Code Contribution Point pattern, `contributes` describes metadata that a Host can discover before plugin code runs; it is not a capability, grant, runtime implementation, or activation trigger. After activation, plugin code may bind handlers or Providers only to IDs declared in the manifest. Tooling and conformance tests should report both declared-but-unbound and bound-but-undeclared entries.

The standard does not mandate a particular loader or source transformer. A Host locates entrypoints from the manifest and activates them through its native mechanism following the standard lifecycle. Fabric-managed plugins use this path; other Host extension paths are labeled non-standard.

A conforming Fabric entrypoint has no runtime dependency on DSH, Cordis, Desktop, or Adapter packages. Package inspection, dependency rules, and conformance fixtures enforce this supported boundary against accidental coupling; trusted in-process mode still cannot turn it into a malicious-code sandbox.

### 7.2 Host Descriptor

Every compatible Host publishes a machine-readable descriptor. This is also only a discussion shape:

```json
{
  "descriptorVersion": "0.1.0",
  "id": "org.example.dsh-webui",
  "version": "1.4.0",
  "apiVersions": ["0.1.0"],
  "execution": {
    "environment": "node",
    "trustMode": "trusted-in-process"
  },
  "capabilities": {
    "messages.observe": "0.1.0",
    "commands": "0.1.0",
    "storage.local": "0.1.0"
  },
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"]
}
```

Compatibility is primarily derived from API and capabilities, not ambiguous names such as `gui>=2.0`. Exceptional Host constraints use stable organization-namespaced IDs.

Markets distinguish at least:

- **declared compatible:** static negotiation passed;
- **awaiting authorization:** support exists but a sensitive grant is missing;
- **tested:** a named Host, system, plugin, and suite combination passed;
- **incompatible:** a required capability or API range cannot be met;
- **unknown:** evidence is insufficient.

Declared compatibility is neither test evidence nor a security review.

The default product experience should show but disable incompatible plugins and list missing capabilities. Hiding them makes a plugin appear to vanish when a user changes device or profile.

### 7.3 Capabilities

A capability is a versioned Host service contract. Candidate v0.1 namespaces are:

| Name | Purpose | v0.1 status |
| --- | --- | --- |
| `storage.local` | Host-managed plugin-private persistence. | v0.1 negotiated capability |
| `commands` | Bind handlers to commands declared in the manifest. | v0.1 negotiated capability |
| `messages.observe` | Observe immutable message events. | v0.1 negotiated capability |
| `sessions.read` | Read a versioned, redacted session view. | Later design |
| `ui.panel.basic` | A tiny, versioned declarative UI subset. | Later prototype |
| `sessions.actions`, `net.*`, `fs.*` | Session mutation, network, and file access. | Deferred |

Each capability defines methods, schemas, errors, cancellation, lifecycle, privacy, resource limits, and tests. Private extensions use organization namespaces such as `x-org.example.tui.keymap`.

Every contribution and Provider contract also defines cardinality, selector, priority, merge / first-result / pipeline / user-choice behavior, equal-priority tie-breaking, error isolation, timeout, duplicate registration, and hot replacement. Load order cannot become an undocumented conflict-resolution rule.

The “one standard method” rule applies inside the Fabric contract. It does not claim to stop trusted in-process code from importing Node.js APIs directly.

Declarative contributions never imply runtime access or a grant. Manifest command metadata is authoritative; a command contribution also requests `commands`, and plugin code only binds its handler by ID. Required APIs are present after negotiation. Optional APIs remain optional until an explicit capability check narrows them.

### 7.4 Lifecycle and events

Host product state and plugin activation are separate state machines. A Host normally moves through:

```text
starting → ready → stopping → stopped
```

While a Host is ready, each activation instance independently moves through:

```text
discover → validate → negotiate → authorize
→ activating → active → deactivating → disposed
```

Experimental v0.1 does not use demand activation. After discovery, negotiation, and authorization, a Host activates every selected plugin while assembling a runtime generation. Contributions describe discoverable features and subscriptions control event delivery; invoking a command, requesting a Provider, or matching a subscription never activates an inactive plugin. Future interceptors still need independent grants, ordering, and failure contracts.

A Host guarantees ordering for a normal activation and best-effort deactivation during normal shutdown, but cannot guarantee deactivation after a crash, power loss, or forced termination. Plugin cleanup is idempotent and recovery-aware. A plugin may activate and dispose repeatedly while the Host remains ready, including during HMR or profile recomposition.

Activation and deactivation are Host-invoked activation-instance hooks, not ordinary business events a plugin subscribes to itself. The same v0.1 Host-side entrypoint may activate repeatedly; the final lifecycle contract defines repeated activation, HMR, and provider replacement. Client or isolated-Worker scopes and cross-face communication belong to later RFCs.

v0.1 standardizes lifecycle plus one immutable `messages.observe` event. That event needs a payload schema, sensitive-field rules, ordering within a scope, concurrency, backpressure, error isolation, cancellation signals, and shutdown behavior.

Mutable or cancellable `before-*` events are deferred. A later RFC must define plugin order, priorities, merge behavior, cancellation continuation, timeout, errors, rollback, reentrancy, per-session ordering, cross-session concurrency, and privacy.

### 7.5 Host API

A future SDK may provide an experience like this, but package names and signatures are not frozen:

```ts
export default definePlugin((ctx) => {
  ctx.commands.handle('com.example.message-memory.show-last', async () => {
    const lastMessageId = await ctx.storage.local.get('lastMessageId')
    ctx.log.info('Last observed message', { lastMessageId })
  })

  ctx.messages.onReceived(async (message) => {
    await ctx.storage.local.set('lastMessageId', message.id)
  })

  return {
    deactivate() {
      // release resources owned by this activation
    },
  }
})
```

The context exposes only negotiated and granted standard capabilities. A missing required capability prevents activation. A missing optional capability has no API and requires an explicit degradation path.

In trusted in-process mode, this remains a supported contract facade rather than a JavaScript security boundary.

## 8. Host obligations

A compatible Host should:

1. read static manifests for Fabric-managed plugins without executing dynamic manifest code;
2. publish an honest Host Descriptor and stop advertising semantics it cannot preserve;
3. validate schemas, negotiate API/capabilities, and obtain required grants before executing plugin code;
4. explain missing required capabilities in user language and make optional degradation deterministic;
5. preserve normal lifecycle ordering and catch ordinary errors crossing standard callback/Promise boundaries; trusted in-process code cannot isolate `process.exit`, native crashes, or infinite loops;
6. publish its execution mode and never describe trusted in-process code as sandboxed;
7. run versioned conformance tests and publish the environment and result.

## 9. Relationship to DSH and Cordis

Fabric must not answer loader fragmentation by inventing another loader. A reference adapter maps the Fabric contract onto existing DSH/Cordis composition:

- the manifest provides static discovery and negotiation;
- the Host integration asks the versioned DSH Adapter to map granted capabilities to existing services, slots, routes, or events;
- native Cordis lifecycle retains ownership of real resource cleanup;
- a capability without an equivalent mapping is reported unsupported rather than approximated through private APIs;
- existing plugins may gain manifests through migration tools but do not become invalid merely because Fabric exists.

This proposal rejects source modification, monkey patching, and private-function hooks. Existing `cordis.patch.yml` files are DSH's official declarative profile-composition layers, not source patches; the Fabric adapter itself may enter a profile through a standard bundle patch.

The current `desktopProfiles` and `desktopPnpm` services in this repository are Desktop-specific Host contracts, not automatic cross-Host standards. Standardizing one of their use cases requires a separate capability RFC and evidence from multiple Hosts.

## 10. Markets, modpacks, and evidence

A market can index manifests and Host Descriptors to calculate compatibility before installation. Catalog inclusion is not review, endorsement, or security certification.

Modpacks remain first-class reproducible releases: they can lock standard, Host, plugin, platform, and test-suite versions. Locking does not replace SemVer contracts or compatibility windows.

A “tested” record binds standard/schema version, Host ID/version/platform, plugin ID/version, conformance suite version and commit, date, and outcome.

## 11. Minimal delivery path

Experimental v0.1 is complete only when the minimum Phase 0–2 contracts have specifications and tests. Phase numbers describe implementation order, not conflicting version scopes.

Its exact runtime surface is: baseline `host.info`, `log`, and lifecycle cancellation, plus negotiated `storage.local`, `commands`, and one immutable `messages.observe` event. Other names in this RFC are future candidates.

### Phase 0: standard foundations

- RFC 0000 for governance and status transitions;
- Manifest JSON Schema;
- Host Descriptor Schema;
- valid and invalid fixtures;
- a pure capability negotiator;
- a headless conformance harness skeleton.

### Phase 1: trusted reference adapter

- one explicit Node.js Host execution environment;
- discover, validate, negotiate, activate, and deactivate;
- only low-risk, non-mutating initial capabilities; sensitive read access still requires grants and redaction;

### Phase 2: events and a minimal contribution

- one immutable `messages.observe` event;
- `storage.local`;
- `commands` as the minimal declarative contribution and same-ID runtime binding;
- activation-scoped Disposable / AsyncDisposable, bounded drain, and repeated activation;
- failure, duplicate-ID, undeclared/unbound contribution, timeout, cancellation, and shutdown fixtures.
- after the complete v0.1 surface exists, interoperability evidence from at least two different Host products or integrations; they may share the same versioned DSH Adapter.

### Separate later RFCs

- mutable `before-*` events;
- Runtime Faces and the cross-face bridge;
- UI Contribution, Provider, Renderer, Rich View, conditions, and a minimal cross-Host UI IR;
- Project/Profile Trust and experimental-capability graduation;
- multi-scope storage and Secret capabilities;
- filesystem, network, and session-write permissions;
- isolated execution and mediated IPC;
- market compatibility labels and test-result interchange.

## 12. Governance requirements

Before this RFC becomes Accepted, RFC 0000 should define statuses, minimum public review, decision and appeal processes, capability/event naming registries, breaking changes, deprecation, errata, private security reporting, licensing, and the boundary between a community and official standard.

The reference implementation cannot define the standard by accident. Behavior belongs to the contract only when normative text, fixtures, and conformance tests describe it.

## 13. v0.1 acceptance and conformance evidence

Experimental v0.1 separates evidence into four classes:

1. **Schema validation:** public Manifest and Host Descriptor Schemas, complete SemVer rules, and valid/invalid fixtures.
2. **Host conformance:** required/optional negotiation, unknown versions, denied grants, activation order, best-effort shutdown, standard callback errors, and truthful execution mode.
3. **Plugin validation:** manifest/entrypoint consistency, declared-capability use, matching contribution declarations/bindings without ID conflicts, optional degradation, releasable synchronous/asynchronous resources after repeated activation, and understandable errors.
4. **Interop evidence:** two independent Host products or integrations and three example plugins complete the same scenarios as the standard-graduation evidence for v0.1. The Hosts may share a DSH Adapter, but their integration and descriptor evidence remain independent.

Because Events are in both the RFC title and v0.1 scope, at least one immutable observation event has a payload schema, privacy redaction, ordering within its scope, backpressure/timeout, error handling, shutdown semantics, and headless contract tests.

A Host may claim only that it passes the v0.1 Host conformance suite; a plugin may claim only that it passes v0.1 plugin validation. Neither claim means “safe plugin” or “officially certified.”

## 14. Open questions

1. What is the fixed manifest filename, and should it live beside or inside `package.json`?
2. How are publisher namespaces proven, transferred, and disputed?
3. Which Node.js version, module format, and entrypoint-loading boundary should v0.1 support?
4. Which fields, scopes, and redaction policy belong in the v0.1 `messages.observe` payload?
5. Do capability versions use independent SemVer or follow `apiVersion` during v0?
6. What evidence proves that `commands` behaves consistently across GUI, Web UI, and TUI Hosts?
7. Who publishes, stores, and revokes Host conformance results?
8. How should RFC review, merge rights, and dispute resolution be governed by the community?

## 15. Why now

Multiple Hosts, plugin authors, and distribution channels already exist. A static and testable interoperability contract is cheaper to establish now than after interfaces fragment further.

The reusable asset is not a loader. It is the declaration, negotiation, lifecycle, and verification method. Fabric should be a community-maintained adapter and experiment, not another unilateral parallel plugin system.

The next step is not automatic standardization after one week. It is to collect counterexamples publicly, finish governance plus schema fixtures, and validate the minimum contract with two Hosts and real plugins.
