# Workspace command hooks

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

For several targets, pass `{root, selections: [{target, enabled, hooks}, ...]}` to the same operations. The package plans every selected document before applying any of them. Confirmed history identifies each callback by its exact previous condition and value, not by its command alone. For migration, supply `legacy: {documentSha256, hooks, preferences?}` only after verifying the previous owner's receipt. The digest must match the complete document bytes, and each claimed callback must match one unique physical entry. Do not infer legacy ownership from a matching command.

## Composing a transaction

`prepareWorkspaceHooks(input)` returns an opaque, single-use plan for `applyPreparedWorkspaceHooks(plan, participant)`. Use this when a separate writer must commit its own layout, links and manifest with the hook settings. The caller preflights its own resources before starting. The package checks its snapshots again under the writer lock before calling the participant.

- `participant.id` identifies an implementation that can reopen its durable state after process restart.
- `await stage(operationId)` checks the external preimages, saves enough state for rollback, then stages reversible changes. Keep the before-images until `finish`. The participant does not write native hook documents or registration records.
- `await finish(operationId, 'commit' | 'rollback')` completes the recorded decision. It must be idempotent and able to handle an interrupted stage, including a rollback before the first participant write.

The package journals the operation before staging and records the decision before calling `finish`. On restart, call `inspectWorkspaceHookOperation({root, accountHome?})`. Supply the account home if registration was possible: its journal can already exist before the project pointer is published. Account snapshots stay in the account's private transaction directory. If pending, call `recoverWorkspaceHooks({root, targets, accountHome?}, participant)` with the recorded target selection and original participant. Include the original account home only for a registration transaction. Recovery refuses unknown file contents; it does not overwrite a concurrent edit. A missing journal or unrecognized partial native write requires reconciliation before retry. A participant with only in-memory undo cannot provide restart recovery.

## Project preferences and registration

The Claude adapter can compose `preferences` with hook changes in the same settings document: `enableProjectServers`, `disabledSkills`, `enabledPlugins` and `localMarketplaces`. It tracks individual acquired entries and preserves unrelated values. Omitting preferences leaves them alone; `{}` retires previously acquired entries. A legacy preferences claim applies only against the confirmed document snapshot.

`registration` opts into native project plugin registration. Supply the marketplace and plugin names, workspace-local directory, expected version and payload fingerprint, absolute executable and account home. A separate `legacy: {fingerprint, version}` inside the registration request identifies an independently verified previous installation. Registration checks the physical project identity, source, installation path and registry neighbors. It permits only the verified arm64 Claude Code 2.1.311 binary and bounded settings forms for Linux or Darwin. Unsupported forms refuse the native mutation. Omitting registration makes no native installation change; disabling command hooks does not uninstall a plugin. The transaction covers the named settings, registry and ownership documents; native executable caches are outside it.

Run `npm run test:hooks` for TypeScript declaration checks, independent adapter runs, fixture execution, restart tests and mutation probes. The offline fixture starts a real local process; its event dispatcher stands in for the harness. The opt-in Darwin probe runs the pinned native CLI with synthetic profiles and network and keychain access denied: `python3 test/adapters/claude/probes/registration-darwin.py /absolute/path/to/claude`. It checks project registration, not interactive event dispatch.
