# Repository navigation

## Find or inspect an existing checkout

Create a navigator with `createNavigation({ root, cwd, routeHost })` from `agent-hands`. Pass an existing `root`, or let the navigator find the nearest `.agent-hands/` marker from `cwd`. A Git checkout alone is not a workspace marker. `ensureWorkspaceDirs(root)` creates `repos/`, `external/` and `sandbox/`; discovery does not create them.

- `repos/` mirrors repository namespaces. `external/` receives flat destinations from URL routes, but lookup also finds existing nested checkouts. `sandbox/` is not searched: use a disk path to refresh a Git checkout there.
- A short name searches existing clones first. Names match on tokens, and equal best matches return candidates instead of picking one. A caller-supplied `search` callback may resolve a local miss. Without it, a local miss says nothing about the existence of a remote repository.
- A qualified name prefers an existing namespace checkout. If the namespace does not identify an existing checkout, a valid existing disk path in the requested zone may still match. For example, `external/tool` finds the `external/` checkout even when called from inside `repos/`; it does not fall back to a checkout in `repos/`. Prefix a relative path with `./` or use an absolute path to select disk interpretation directly. A checkout under the reserved `repos/external/` path cannot hide a checkout in `external/`.
- `resolve(target)` describes the destination; `repoPath(target)` requires an existing Git checkout root. Both are read-only by default. `scan()` reads only locally available refs, status and contact timestamps. It does not fetch, update the index or change checkouts. An unreadable status or missing comparison ref is distinct from a clean checkout or a zero commit count.
- A custom CLI can use `resolve(target, { allowGroup: true })` to handle a group itself. Use `source`, `kind` and `disk` to explain how an argument resolved. `NavigationError.problem` reports known refusal reasons and `candidates` lists tied matches. Supply `personal` to annotate local candidates and `onCollision` to report reserved namespace directories.
- `scan(namespaces)` limits inspection to the selected namespace paths. `localStatus(absolutePath)` inspects one checkout root without a workspace. The `issue` and `aheadIssue` fields carry diagnostic codes and details for use in another language. `countZone` summarizes the resulting rows.

## Clone or update explicitly

`routeHost(authority)` returns `{ zone: 'repos', gitlab: true }` for a GitLab namespace, `{ zone: 'external' }` for a flat destination, or no value for an unsupported authority. Authorities are case-insensitive and include explicit ports. A GitLab project page such as `https://git.example.test/org/project/-/tree/main` maps to the repository transport URL without changing its scheme or authority. Group addresses are recognized but not treated as repository clone requests.

`clone(target)` creates the resolved destination. `repoPath(target, { clone: true })` may create a missing checkout. Supply `namespaceUrl(namespace)` to clone a namespace into `repos/` without an explicit URL. A missing checkout in `external/` needs an explicit URL; the navigator does not guess its source. Traversal, symlink destinations and occupied directories are rejected. An occupied clone addressed by URL must have exactly one readable origin matching that URL, compared before Git applies `insteadOf` transport rewrites.

`fresh(target)` fetches and attempts a fast-forward of the default branch. It does not switch the checkout, advance a branch after a failed fetch or overwrite uncommitted files or divergent commits. A subgroup or ordinary directory inside a workspace zone cannot refresh the enclosing workspace repository. A real checkout in `sandbox/` or outside the workspace can be refreshed by path. Pass `{ fresh: true }` to `repoPath` to explicitly request an update with the lookup. The low-level `freshenRepo(path, { observeOnly: true })` is **not** read-only: it fetches remote tracking refs, but leaves local branches, tags, the checkout and `FETCH_HEAD` alone.

Use `locateCheckout(diskPath)` to validate and announce the Git root before calling `freshenRepo` with explicit authentication or a deadline. Use `verifyOrigin(path, url)` to check an existing destination before acting on a URL. Its `allowMissing` option accepts only a confirmed absence of origin; a mismatch, ambiguous origin or unreadable configuration still fails.

## Command and transport interfaces

`runRepositoryCommand(options, command, args, io)` accepts `clone`, `path`, `fresh` and `zone`. It returns an exit code. `path` and `clone` write one absolute path on success; optional `path` freshness diagnostics go to standard error. `fresh` and `zone` write JSON. Command errors return exit 1 with diagnostics on standard error, not a path on standard output.

`gitLabClient(host, { token, request })` is optional. The caller supplies the host and any token. Requests remain under `/api/v4/` on that origin, use a timeout and do not follow redirects. Pagination rejects malformed responses or invalid next pages rather than returning partial results. Use `GitLabError.problem.code` to distinguish failures. Low-level Git operations accept an explicit authentication policy; the library does not choose credentials.

Use `projectNamespace(row)` to validate a GitLab result before treating it as a namespace. `pickProjects(query, rows)` ranks results from a project search. For repositories that need no workspace routing, use `gitClone`, `gitCloneSha`, `gitLsRemoteTags` and `fetchRepositoryRef` with an explicit source or checkout. `repoHead` requires a checkout root; `gitToplevel` finds the enclosing Git root. `readDefaultBranch` reads the local origin refs without fetching.

The offline tests use local Git repositories, explicit host policies and replacement transports. After `npm test`, run `node test/git/mutation-probes.mjs` to verify that removing each destination-identity or update guard makes its focused test fail.
