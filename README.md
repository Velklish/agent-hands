# agent-hands

An independent project for managing agent workspace layouts and repository navigation.

## Current state

The repository navigation library can find, inspect, clone and update checkouts.
Lookup is read-only unless the caller explicitly requests a clone or an update.
The installable CLI and package entry points are not available yet.
See [repository navigation](docs/reference/repository-navigation.md) for the library contract.

The standalone [voice profile tool](profiles/my-voice/README.md) requires Python 3.10 or newer and supports supplied samples and optional local history.
The JavaScript library plans and applies explicitly selected workspace resources.
See the [layout contract](docs/reference/layout.md) and the [working example](assets/README.md).
This does not provide a layout command or publish a release.

## Development

Requires Node.js 26 or newer, npm and Git.

```sh
npm ci --registry=https://registry.npmjs.org
npm run typecheck
npm test
node test/git/mutation-probes.mjs
npm run test:layout
npx --no-install backslop lint
npx --no-install backslop status
npx --no-install backslop gates
```

Backslop is a development dependency pinned to its public GitHub `v1.0.0` tag,
downloaded over HTTPS. Its installation is locked in `package-lock.json`.
No global installation, personal settings, external harness binaries or hooks are required by the layout tests.

See [the documentation](docs/README.md) and [contributor workflow](AGENTS.md).
Future product distribution will use exact GitHub release tags; this foundation
does not assign a product version.

## License

[MIT](LICENSE), copyright Velklish.
