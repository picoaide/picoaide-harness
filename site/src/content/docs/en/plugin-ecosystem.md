---
title: Plugin Ecosystem
description: 'The DSH plugin ecosystem manifesto: an open, composable, sustainable community vision and its three principles; PicoAide Harness is its first practitioner.'
---

The DSH plugin ecosystem is growing quickly. The more plugins there are, the more their ability to work together matters — if every plugin assumes or overrides another plugin's internals, installing a few plugins starts to conflict and the ecosystem fragments. This is nobody's fault; it is what happens when shared conventions are missing.

## Our vision

We want to build an **open, composable, sustainable** DSH plugin ecosystem:

- **Open**: any author can participate; official, desktop, and third-party plugins compose equally on the same platform.
- **Composable**: plugins extend under the same conventions and keep working together when installed side by side.
- **Sustainable**: upgrades stay backward-compatible so the ecosystem can evolve long-term without being rewritten.

## The three principles we advocate

1. **Composition first**: compose capabilities through official slots, services, and patches; do not assume or override another plugin's internals.
2. **Declare clearly**: state the services and slots you depend on; do not rely on runtime coincidences.
3. **Compatibility first**: keep upgrades backward-compatible so existing compositions do not break.

## The desktop shell is the first example

PicoAide Harness is the first practitioner: the desktop shell itself is an ordinary DSH plugin on the same composition path as official and third-party plugins, with no special privileges. We do not fork upstream source into a fixed shell; instead, "desktop" becomes an equal citizen of the plugin ecosystem.

## A living document, built with the community

This manifesto is not a one-way rule — it is a **living document** that updates with ecosystem practice and accepts community discussion and revision. Any author can propose changes through issues, discussions, or PRs.

## Plugin marketplace: making conventions rewarding

Once the plugin marketplace is live, plugins following this manifesto will be easier to discover, install, and trust. We want "developing to the standard" to benefit every author rather than become an extra burden.

## From manifesto to testable contracts

[DSH Community Fabric](https://github.com/picoaide/picoaide-harness/tree/master/community/fabric) is turning this vision into publicly discussable drafts for Manifest, Capability, Host Descriptor, and events. It is currently documentation only — not a released standard or runtime; current plugins keep using the existing DSH/Cordis interfaces.

Fabric's capabilities are first used for compatibility judgment, user confirmation, and audit — never to disguise same-process JavaScript as a security sandbox. Only a Host with real isolation evidence may claim that permissions are technically enforced.

The community market remains at the documentation stage with no usable page or installer. Directory inclusion only means a package follows the directory rules; it is not a security review or recommendation.

## How to participate

- Read [Plugin Development](./plugin-development) to learn how to write plugins.
- Read and comment on [Community Fabric RFC 0001](https://github.com/picoaide/picoaide-harness/tree/master/community/fabric/docs/rfcs).
- See [Desktop Client](./desktop) for installing and managing plugins.
- Raise your opinions through issues and discussions.
