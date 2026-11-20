# Workspace layout

## Repositories

The `repos/`, `external/`, and `sandbox/` directories can hold independent Git repositories. Use the workspace's configured locations rather than guessing from a repository name. If more than one checkout matches, use a qualified name or an explicit path. A repository URL identifies a remote; confirm the local destination before cloning.

Before editing, identify the exact checkout and current branch. Check its freshness against the intended upstream. Report ahead and behind counts when known, as well as a dirty tree or a failed fetch. A freshness check is not permission to switch branches, overwrite changes, or reconcile divergent branches. Keep changes and commits scoped to the repository that owns them.

For a manual check, run `git -C /path/to/checkout status --short --branch`, substituting the actual path. The ahead and behind counts compare against the current local upstream ref; they are not evidence of a successful fetch. Say if the ref is stale or no upstream is configured.

## Files and ownership

Edit the declared sources, not their generated copies. Regenerate the layout after changing a source. If generated output conflicts with a manual edit, inspect the conflict and preserve user-owned changes. Do not remove unrelated files to clear a conflict.

Keep personal notes, environment values, and voice profiles in local files chosen by the workspace owner. Do not commit secret values. An environment template documents names and purposes, not values. When it is generated, edit its declarations rather than the rendered template.

Check exact version pins when updating sources. An update notice is not permission to install a different version or modify the workspace.
