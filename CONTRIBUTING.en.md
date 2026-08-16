# Contributing

Thank you for wanting to contribute to DSH Desktop. This is a community project — whether you are a regular user, a plugin author, or a developer, there is a way to contribute that fits you.

## Regular users: use, report, and spread the word

- Report problems or odd behavior in an [issue](https://github.com/anywhere-labs/deepseek-harness-desktop/issues): include your operating system (macOS / Windows), application version, and reproduction steps.
- Feature ideas and improvement suggestions are welcome as issues too.
- Join the [community channels](README.en.md#community) (WeChat group, QQ group, Discord) and help other users.
- Write tutorials or experience posts, or help improve and translate the documentation.
- Suggest ecosystem projects for the [related links](README.en.md#friendly-links) section.

## Plugin authors: extend the ecosystem

DSH is built around plugins. If you write plugins, start with:

- [Plugin development](docs/plugin-development.en.md): how to write ordinary DSH plugins and Desktop plugins.
- [DSH plugin ecosystem manifesto](docs/plugin-ecosystem.en.md): our vision of an open, composable, sustainable ecosystem, and the three principles — composition first, declare clearly, compatibility first.

Plugins that follow the manifesto coexist better with other plugins and will be easier to discover and trust in the marketplace when it ships.

## Developers: contribute code

### Development environment

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn check   # full headless gate: build, typecheck, tests, and smokes
corepack yarn dev     # launch the application when a graphical session is available
```

### Repository boundaries (please read before starting)

- `deepseek-harness/` is the pinned upstream submodule. **Desktop development never edits files inside it**; upstream updates land through separate pin commits.
- Desktop code lives in `dsh-plugin-desktop/`; the outer repository is a Yarn workspace.
- Builds, typechecks, unit tests, and smoke checks must stay headless-safe.

### Commits and pull requests

- Use conventional commit messages (for example `fix(desktop): ...`, `docs: ...`).
- Run `yarn check` and keep it green before committing.
- Documentation changes should stay bilingual and update the `README.i18n.yaml` hash record.
- Describe the change, its motivation, and how it was verified in the PR; merge after CI passes.

## Code of conduct

Be kind and respectful, and stick to the topic. We want a community that welcomes newcomers.
