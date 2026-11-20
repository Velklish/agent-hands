# Workspace command hooks

## From the CLI

Use the same JSON file with `hooks-plan`, `hooks-apply`, `hooks-inspect` and `hooks-recover`. Pass it with `--config FILE`. For one target, use the JavaScript example's `input` as JSON. For several targets, use a single `root` and a `selections` array with one entry per target. The [bundled example](../../examples/hooks.mjs) writes a complete batch file.

`hooks-plan` and `hooks-apply` report `changed` and `shifted`. The CLI derives native paths and ownership files from the root and selected harnesses. `hooks-inspect` reports pending targets and whether registration was involved. With no pending operation, it reports the count of owned and released callbacks per target, or `null` when a target has no receipt. Command strings, settings and owner identifiers are omitted from CLI output.

If inspection shows a pending operation, use `hooks-recover` with the same workspace root and original target selection. Include the original registration account if the operation used native registration. Recovery reports whether an operation was recovered. A transaction created with an external participant requires recovery through the JavaScript API and the original participant.

## From JavaScript

Import the hook operations from `agent-hands`. Select `claude`, `codex` or `cursor`. OpenCode uses a plugin lifecycle and does not support this command-hook operation. Layout delivery does not enable hooks.

```js
import { applyWorkspaceHooks, planWorkspaceHooks } from 'agent-hands';
const input = {
  root: process.cwd(), target: 'claude', enabled: true,
  hooks: [{ owner: 'notice', event: 'SessionStart', matcher: 'startup|resume',
    command: 'node ./tools/session-notice.mjs', timeout: 4 }],
};
const preview = planWorkspaceHooks(input);
if (preview.changed) applyWorkspaceHooks(input);
```

`root` must be an existing absolute workspace directory. The event and matcher name a condition understood by the selected harness. Timeout is a positive integer in seconds. The adapter selects the native document, callback representation and ownership file. `planWorkspaceHooks` reads without writing or launching a command. `applyWorkspaceHooks` returns `{changed, shifted}`. A removal can shift callback indices and invalidate an approval maintained by the harness. The host decides when to run a registered command and which approvals are required.

`enabled: false` removes the selected target's confirmed callbacks. It leaves foreign and released callbacks in place. `release: ['notice']` relinquishes ownership without deleting a command; subsequent updates leave that owner alone. `restore` explicitly reconnects the selected desired definition. An edited or ambiguous owned callback otherwise stops application. `workspaceHookOutcome(owner, event, exitStatus)` reports the observed outcome of one invocation: zero succeeds; a nonzero or unavailable status fails. It neither runs nor retries the command.

For a change to ownership alone, set `mode: 'ownership'` and `enabled: true`. Pass
`release: ['notice'], hooks: []` to relinquish one owner while keeping the rest of the selection.
Pass `restore: ['notice'], hooks: [noticeDefinition]` with the confirmed definition to restore an
absent callback or reconnect one unchanged released callback. This mode requires a receipt and
refuses ambiguous matches. It leaves other owners and callbacks in place.

For several targets, pass `{root, selections: [{target, enabled, hooks}, ...]}` to the same operations. The package plans every selected document before applying any of them. Confirmed history identifies each callback by its exact previous condition and value, not by its command alone. For migration, supply `legacy: {documentSha256, hooks, preferences?}` only after verifying the previous owner's receipt. The digest must match the complete document bytes, and each claimed callback must match one unique physical entry. Do not infer legacy ownership from a matching command.

A batch can specify an absolute `accountHome` to use the same account lock as plugin registration. When a selection also requests registration, the two account paths must resolve to the same directory. Use the original account with inspection and recovery. A pending account-scoped batch without registration reports `accountScoped: true`.

## Composing a transaction

`inspectWorkspaceHookOwnership({root,target})` returns `null` without a receipt; otherwise it returns confirmed `owners` and `released` identifiers. It verifies the receipt against the current document. Missing or ambiguous callbacks raise a conflict instead of reporting stale ownership as active.

`prepareWorkspaceHooks(input)` returns an opaque, single-use plan for `applyPreparedWorkspaceHooks(plan, participant)`. Use this when a separate writer must commit its own layout, links and manifest with the hook settings. The caller preflights its own resources before starting. The package checks its snapshots again under the writer lock before calling the participant.

The prepared plan's `registrations` lists the harness, requested version, known previous version and action (`install`, `update`, or `current`). After a successful apply, the result lists the confirmed status (`installed`, `updated`, or `current`). An empty list means the batch requested no registration.

- `participant.id` identifies an implementation that can reopen its durable state after process restart.
- `await stage(operationId)` checks the external preimages, saves enough state for rollback, then stages reversible changes. Keep the before-images until `finish`. The participant does not write native hook documents or registration records.
- Optional `await beforeCommit(operationId)` runs after native registration and hook writes, before the journal commits. Write the reversible marker or manifest here if it depends on native success. A rejection rolls back the protected documents and calls `finish` with `rollback`.
- `await finish(operationId, 'commit' | 'rollback')` completes the recorded decision. It must be idempotent and able to handle an interrupted stage, including a rollback before the first participant write.

The package journals the operation before staging and records the decision before calling `finish`. On restart, call `inspectWorkspaceHookOperation({root, accountHome?})`. Supply the account home if registration was possible: its journal can already exist before the project pointer is published. Account snapshots stay in the account's private transaction directory. If another project holds the account journal, inspection returns `pending: false` and `blockedBy: 'another-project'` without identifying that project. Resume recovery from the project where the transaction began. If pending, call `recoverWorkspaceHooks({root, targets, accountHome?}, participant)` with the recorded target selection and original participant. Include the original account home only for a registration transaction. Recovery refuses unknown file contents; it does not overwrite a concurrent edit. A missing journal or unrecognized partial native write requires reconciliation before retry. A participant with only in-memory undo cannot provide restart recovery.

## Project preferences and registration

The Claude adapter can compose `preferences` with hook changes in the same settings document: `enableProjectServers`, `disabledSkills`, `enabledPlugins` and `localMarketplaces`. It tracks individual acquired entries and preserves unrelated values. When a requested preference differs from an unowned value, plan and apply return a `preference-conflict` diagnostic naming the preference field. Conflicting values and entry names are omitted. Omitting preferences leaves them alone; `{}` retires previously acquired entries. A legacy preferences claim applies only against the confirmed document snapshot.

Retiring preferences removes an empty dictionary only when the receipt proves the package created it and the previous settings bytes still match. Pre-existing dictionaries and containers with only legacy field-level evidence are preserved. When the package created the whole settings file and no values remain, retirement removes the file as well.

`registration` opts into native project plugin registration. Supply the marketplace and plugin names, workspace-local directory, expected version and payload fingerprint, absolute executable and account home. A separate `legacy: {fingerprint, version}` inside the registration request identifies an independently verified previous installation. Registration checks the physical project identity, source, installation path and registry neighbors. The caller must fingerprint the entire selected plugin payload and assign a distinct version to each payload in the native source metadata. A content-derived prerelease suffix can keep the base version stable. An unchanged fingerprint and version skip native registration. An update must prove that Claude recorded a different version at the expected install path. The pinned CLI can return success for a same-version update without changing the registry.

Native writes require the pinned arm64 Claude Code 2.1.311 executable on Linux or Darwin. Before the first write, the package checks its hash and verifies the reported `--version`. It refuses unsupported settings and uses bounded native calls. Omitting registration makes no native installation change; disabling command hooks does not uninstall a plugin. The transaction covers the named settings, registry and ownership documents; native executable caches are outside it.

If the workspace directory is a link to an independently verified bundle, supply its canonical absolute `expectedPhysicalDirectory` under `accountHome`. Only the final workspace path component may be a link. The participant may switch it during `stage`; the package checks the selected destination after staging and before and after each native command. Without an explicit pin the source must be a physical workspace directory.

On Darwin, first registration also accepts an absent settings file, `{}`, or a document containing only well-formed local marketplace and plugin enablement dictionaries. Other partial settings documents do not qualify under this rule.

On Linux, the complete five-field projection is supported for a verified project **update** only. First registration uses the minimal Linux settings form. Mixing `env` into the full projection is not supported.

Run `npm run test:hooks` for TypeScript declaration checks, independent adapter runs, fixture execution, restart tests and mutation probes. The offline fixture starts a real local process; its event dispatcher stands in for the harness. The opt-in Darwin probe runs the pinned native CLI with synthetic profiles and network and keychain access denied: `python3 test/adapters/claude/probes/registration-darwin.py /absolute/path/to/claude`. It checks project registration, not interactive event dispatch.
