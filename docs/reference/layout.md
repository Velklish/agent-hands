# Workspace resources

Import `planLayout`, `parseLayout`, `applyLayout` and `readLayoutState` from `agent-hands`.
`planLayout` accepts typed input. `parseLayout` validates the same shape from an unknown value
and produces an applicable plan; it does not deserialize a plan. Both take an absolute workspace
root, one selected harness and explicit lists of skills, agents, servers and rule files. They do not
discover a repository, read a workspace manifest, resolve versions or run a harness.

Planning reads selected sources and does not write the workspace. `files` previews generated
resources; for a shared JSON document it shows only the generated fragment, before merging.
The plan is an in-memory value; pass the exact returned object to `applyLayout`. Replan after a source change.
`requiredVars` names unresolved references from values, and may not be present. Supply environment
values only when they may be written into the resulting configuration. Do not log plans that contain secrets.

`resources` describes each prepared skill file, shared supporting file and subagent by logical owner.
Match a record's `path` to `files`, and use `relativePath` within that resource rather than parsing a
harness path. Shared files point to the corresponding `sharedDirs` input by zero-based `sourceIndex`.
If several sources supply the same shared file with identical bytes and mode, the first source owns
the preview record. Rules and MCP previews are not selected content resources.

By default a linked or special file in a source tree is an error. An integrating caller that already
warns and skips such supporting files can opt in with `supportingFiles: 'skip-nonregular'`. `notices`
names each skipped resource without opening it. A selected skill still needs a regular `SKILL.md`.

| Target | Skill and agent directories | Tool server document |
|---|---|---|
| Claude Code | `.claude/skills/`, `.claude/agents/` | `.mcp.json`, owned server keys |
| Cursor | `.cursor/skills/`, `.cursor/agents/` | `.cursor/mcp.json`, owned server keys |
| Codex | `.codex/skills/`, `.codex/agents/` | `.codex/config.toml`, whole file; refuses a foreign file |
| OpenCode | `.opencode/skills/`, `.opencode/agents/` | `opencode.json`, owned server keys |

The adapter for the selected target renders its own format. Rules are copied in order to
`.agents/rules/<target>/0001.md`, `.agents/rules/<target>/0002.md`, and so on. Select these files
explicitly in the session; applying a layout does not instruct a running agent to read them.

### Scoped planning and MCP policies

Set `scope: 'mcp'` to manage only the selected target's connection documents, leaving previously
owned resource files in place. Plan the shared `.mcp.json` with target `claude` even if you do not
select Claude Code resources. It does not change Claude Code's settings or register hooks.
Set `scope: 'resources'` to leave MCP documents and ownership alone. `rulesMode: 'select'`
returns the ordered `plan.rules` without reading or copying rule bodies. Use `{ path, optional: true }`
to omit a missing optional rule. The default copies the selected files.

Standalone defaults remain strict. Set `mcp.compatibility: 'report'` only when the caller can
report incomplete native rendering. `plan.diagnostics` and `LayoutResult.diagnostics` name
the target, path, issue and relevant server or field without its value. Malformed documents and
edited owned entries still refuse the operation. `LayoutMcpError.diagnostic` carries details
for refusals that can be presented by the caller. JSON targets retain JSON-compatible source
settings in report mode. Native adapters report fields they cannot represent. Codex refuses an
invalid timeout; OpenCode reports and omits a timeout that cannot be expressed exactly.

Use `mcp.placeholders: 'literal'` for definitions that are already prepared; specify
`placeholders` on an individual server entry to override the selection default. Literal definitions
are never substituted or converted to native environment references. Report mode can preserve
unresolved text while naming the affected field. Codex accepts single-line `comments` and can
check transport conflicts against an explicit absolute `transportReference` without writing it.

Use `mcp.mode: 'replace'` for a generated, whole-file-owned config and `mcp.emitEmpty` to create
it even when the selection is empty. The default reconciles individual keys where supported.
In key mode, `unowned: 'adopt-identical'` adopts equal entries and reports differing entries
without replacing them. `unowned: 'preserve'` never adopts existing entries. By default, only a
created, empty document may be removed. `removeEmpty: 'owned-keys'` also permits retiring a
flat document when removing verified keys is what empties it; `removeEmpty: 'keep'` retains it.
OpenCode's `resetInheritedAgents` is an explicit option for project agent resets in its nested
document; foreign resets are not adopted. Root MCP keys and inherited resets have separate ownership.

For ownership migration, `plan.mcpFingerprints` exposes native key hashes, not native records.
Compute legacy fingerprints from the previous source definitions, never by modifying the
current on-disk entry. Report mode allows a key that already exactly matches the newly planned
value to reconcile idempotently.

### Stage inside a caller transaction

`applyLayout(plan, previous, { stage })` performs preflight but does not write. The callback
receives `writes`, `removes`, next `state`, diagnostics and `assertCurrent()`. Call the guard
immediately before committing changes. Stage the returned paths once in the same transaction as
your other outputs and ownership records. Honor `secure` on writes and update the executable
mode when specified. The caller owns rollback and final commit in this mode. Omit the callback
to use the standalone transaction. Staged data and rendered previews can contain configuration
values; don't send them as diagnostics.

Save the returned `state` in trusted caller-controlled storage, separately for each root and target.
Decode it with `readLayoutState` and pass it back when updating or retiring a delivery. The library
does not read or write a state file. Matching output bytes do not prove ownership. If an unmanaged
file or key conflicts, or if an owned output changed since the previous application, the library
refuses the conflicting change. Apply an empty selection with its previous state to retire that
delivery. Files and ownership records from other targets are not part of that operation.
`readLayoutState` rejects unknown per-key MCP ownership paths and paths belonging to a different
target. Codex owns its whole configuration file and has no per-key MCP ownership.

On POSIX systems copied resources mirror the source's executable status. A change of executable
status counts as an update even when the bytes are unchanged. If a permission change fails,
application fails and rolls back instead of reporting success with the wrong permissions.

See [bundled instructions and example](../../assets/README.md) for a nonempty rule and skill selection.
Run `npm run test:layout` for the strict build, declaration consumer, native format fixtures and
adapter isolation checks. These tests do not launch agents or verify a harness's discovery on startup.
