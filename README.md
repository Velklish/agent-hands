# agent-hands

An independent project for managing agent workspace layouts and repository navigation.

## Current state

The `agent-hands` CLI and JavaScript API are not available from this checkout yet.
The standalone [personal voice profile tool](profiles/my-voice/README.md) is available
from source with Python 3.10 or newer. It can use supplied samples without reading local history.

## Development

Requires Node.js 26 or newer, npm and Git.

```sh
npm ci --registry=https://registry.npmjs.org
npx --no-install backslop lint
npx --no-install backslop status
npx --no-install backslop gates
```

Backslop is a development dependency pinned to its public GitHub `v1.0.0` tag,
downloaded over HTTPS. Its installation is locked in `package-lock.json`.
The tracker has no runtime dependencies. No global installation, personal settings,
agent adapters or hooks are required.

See [the documentation](docs/README.md) and [contributor workflow](AGENTS.md).
Future product distribution will use exact GitHub release tags; this foundation
does not assign a product version.

## License

[MIT](LICENSE), copyright Velklish.
