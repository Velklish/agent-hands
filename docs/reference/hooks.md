# Workspace command hooks

## From the CLI

Use the same JSON file with `hooks-plan`, `hooks-apply`, `hooks-inspect` and `hooks-recover`. Pass it with `--config FILE`. For one target, use the JavaScript example's `input` as JSON. For several targets, use a single `root` and a `selections` array with one entry per target. The [bundled example](../../examples/hooks.mjs) writes a complete batch file. Set `stateLocation` at the top level. Use `hooks-migrate --config FILE` with the destination selected to move existing state.

`hooks-plan` and `hooks-apply` report `changed` and `shifted`. The CLI derives native paths and ownership files from the root and selected harnesses. `hooks-inspect` reports pending targets and whether registration was involved. With no pending operation, it reports the count of owned and released callbacks per target, or `null` when a target has no receipt. Command strings, settings and owner identifiers are omitted from CLI output.

If inspection shows a pending operation, use `hooks-recover` with the same workspace root and original target selection. Include the original registration account if the operation used native registration. Recovery reports whether an operation was recovered. A transaction created with an external participant requires recovery through the JavaScript API and the original participant.

If the journal is missing but its pointer remains, `hooks-inspect --config FILE --evidence`
reports the protected target identifiers and their current digests. Verify each digest against
the state you intend to keep. Pass `hooks-recover --config FILE --reconcile PROOF.json` a proof
with the returned `operationId` and complete `evidence` array, and one `documents` decision per
target. A decision is `{target, action: "accept"}`, `{target, action: "release", owners}` or
`{target, action: "restore", hooks}`. Use ordinary recovery when the journal is still present.

## From JavaScript

Import the hook operations from `agent-hands`. Select `claude`, `codex` or `cursor`. OpenCode uses a plugin lifecycle and does not support this command-hook operation. Layout delivery does not enable hooks.

A single request or an entire batch can set `stateLocation: "agents"` to keep workspace hook
state in `.agents/agent-hands/hooks/`. Omit the option or set it to `"default"` to use
`.agent-hands/hooks/`. Use the same selection for planning, application, ownership and
registration inspection, and recovery. Native harness settings and the shared account lock,
journal and pointer stay at their usual paths.

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

## Move existing hook state

Stop hook writers for the workspace, then call
`migrateWorkspaceHookState({root, stateLocation: "agents", accountHome})`. The call moves the
confirmed receipts in a single directory rename under the workspace writer lock. Both
locations must be on the same filesystem. If any account-scoped operation may exist, supply
its original `accountHome`. The operation locks that account as well. Standalone projects
that have only used workspace transactions can omit `accountHome`.
Without it, migration can only check the workspace for pending work. A journal published
in an account before the workspace pointer exists is visible only with the original account.

The move refuses a pending journal or pointer, conflicting locations, or unrecognized state.
Recover pending work in the original location, using the original account where applicable,
before retrying. If a Claude plugin registration receipt exists, inspection must report
`current` there before it can be moved. Resolve any registry mismatch in the original location.

`{changed: false}` means there was no tree to move. A retry can clean up the empty previous
directory after an interrupted move. Planning and inspection only read the selected location.
They refuse a competing tree so they cannot mistake missing receipts for unowned hooks.
Pass an explicit workspace `root` to repository navigation after moving to `"agents"` if
you previously relied on discovery from `.agent-hands/`.

To roll back to v0.1.0, stop writers, recover pending work, then run the v0.1.1 migration
with `stateLocation: "default"` and the same account. Switch package versions only after
that succeeds, then use the v0.1.0 configuration without `stateLocation`. A v0.1.0 process
cannot discover the nested location, and switching versions alone does not reattach its receipts.

## Composing a transaction

`inspectWorkspaceHookOwnership({root,target})` returns `null` without a receipt; otherwise it returns confirmed `owners` and `released` identifiers. It verifies the receipt against the current document. Missing or ambiguous callbacks raise a conflict instead of reporting stale ownership as active.

`prepareWorkspaceHooks(input)` returns an opaque, single-use plan for `applyPreparedWorkspaceHooks(plan, participant)`. Use this when a separate writer must commit its own layout, links and manifest with the hook settings. The caller preflights its own resources before starting. The package checks its snapshots again under the writer lock before calling the participant.

The prepared plan's `registrations` lists the harness, requested version, known previous version and action (`install`, `update`, or `current`). After a successful apply, the result lists the confirmed status (`installed`, `updated`, or `current`). An empty list means the batch requested no registration.

- `participant.id` identifies an implementation that can reopen its durable state after process restart.
- `await stage(operationId)` checks the external preimages, saves enough state for rollback, then stages reversible changes. Keep the before-images until `finish`. The participant does not write native hook documents or registration records.
- Optional `await beforeCommit(operationId)` runs after native registration and hook writes, before the journal commits. Write the reversible marker or manifest here if it depends on native success. A rejection rolls back the protected documents and calls `finish` with `rollback`.
- `await finish(operationId, 'commit' | 'rollback')` completes the recorded decision. It must be idempotent and able to handle an interrupted stage, including a rollback before the first participant write.

The package journals the operation before staging and records the decision before calling `finish`. On restart, call `inspectWorkspaceHookOperation({root, accountHome?})`. Supply the account home if registration was possible: its journal can already exist before the project pointer is published. Account snapshots stay in the account's private transaction directory. If another project holds the account journal, inspection returns `pending: false` and `blockedBy: 'another-project'` without identifying that project. Resume recovery from the project where the transaction began. If pending, call `recoverWorkspaceHooks({root, targets, accountHome?}, participant)` with the recorded target selection and original participant. Include the original account home for registration and explicit account-scoped batches. Recovery refuses unknown file contents; it does not overwrite a concurrent edit. A missing journal or unrecognized partial native write requires reconciliation before retry. A participant with only in-memory undo cannot provide restart recovery.

For a lost journal with a verified surviving pointer, pass the complete proof as `reconcile`
in the batch recovery scope. If a participant was recorded, it must implement the read-only
`verifyReconciliation(operationId, proofSha256)` and verify its complete durable candidate,
including any final manifest or marker. Supply its evidence digest as `participantSha256`.
Participant reconciliation accepts the verified current state and finishes with `commit`.
For native registration, use `accept` and include the verified
`registration: {marketplace, plugin, version, fingerprint}`. Reconciliation refuses stale or
incomplete registration. It cannot reconstruct lost snapshots or replay native registration.

## Project preferences and registration

Use `inspectWorkspaceRegistration({root, accountHome, marketplace, plugin})` to verify the
project registration against its native registry and package receipt. A current result includes
project scope, installed version and confirmed fingerprint. A retained registration has a matching
project entry with no package receipt. A missing result means there is no matching project entry or
receipt. Mismatched evidence or an unfinished operation reports stale. Supply `expectedVersion`
and `expectedFingerprint` to check a known desired registration against verified evidence.

The Claude adapter can compose `preferences` with hook changes in the same settings document: `enableProjectServers`, `disabledSkills`, `enabledPlugins` and `localMarketplaces`. It tracks individual acquired entries and preserves unrelated values. When a requested preference differs from an unowned value, plan and apply return a `preference-conflict` diagnostic naming the preference field. Conflicting values and entry names are omitted. Omitting preferences leaves them alone; `{}` retires previously acquired entries. A legacy preferences claim applies only against the confirmed document snapshot.

Retiring preferences removes an empty dictionary only when the receipt proves the package created it and the previous settings bytes still match. Pre-existing dictionaries and containers with only legacy field-level evidence are preserved. When the package created the whole settings file and no values remain, retirement removes the file as well.

`registration` opts into native project plugin registration. Supply the marketplace and plugin names, workspace-local directory, expected version and payload fingerprint, absolute executable and account home. A separate `legacy: {fingerprint, version}` inside the registration request identifies an independently verified previous installation. Registration checks the physical project identity, source, installation path and registry neighbors. The caller must fingerprint the entire selected plugin payload and assign a distinct version to each payload in the native source metadata. A content-derived prerelease suffix can keep the base version stable. An unchanged fingerprint and version skip native registration. An update must prove that Claude recorded a different version at the expected install path. The pinned CLI can return success for a same-version update without changing the registry.

Native writes require the pinned arm64 Claude Code 2.1.311 executable on Linux or Darwin. Before the first write, the package checks its hash and verifies the reported `--version`. It refuses unsupported settings and uses bounded native calls. Omitting registration makes no native installation change; disabling command hooks does not uninstall a plugin. The transaction covers the named settings, registry and ownership documents; native executable caches are outside it.

If the workspace directory is a link to an independently verified bundle, supply its canonical absolute `expectedPhysicalDirectory` under `accountHome`. Only the final workspace path component may be a link. The participant may switch it during `stage`; the package checks the selected destination after staging and before and after each native command. Without an explicit pin the source must be a physical workspace directory.

On Darwin, first registration also accepts an absent settings file, `{}`, or a document containing only well-formed local marketplace and plugin enablement dictionaries. Other partial settings documents do not qualify under this rule.

On Linux, the complete five-field projection is supported for a verified project **update** only. First registration uses the minimal Linux settings form. Mixing `env` into the full projection is not supported.

Run `npm run test:hooks` for TypeScript declaration checks, independent adapter runs, fixture execution, restart tests and mutation probes. The offline fixture starts a real local process; its event dispatcher stands in for the harness. The opt-in Darwin probe runs the pinned native CLI with synthetic profiles and network and keychain access denied: `python3 test/adapters/claude/probes/registration-darwin.py /absolute/path/to/claude`. It checks project registration, not interactive event dispatch.
