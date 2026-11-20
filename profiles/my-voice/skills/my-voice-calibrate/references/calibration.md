# Calibration inputs and commands

Run the scripts under this skill's `scripts/` with Python 3.10 or later. They require only the standard library. Pass explicit paths; neither script discovers a workspace or requires a project manifest. The host selects the resulting `SKILL.md` as local content. The scripts do not install it.

## Collect evidence

```sh
python3 scripts/collect.py --samples "$private/samples.json" \
  --all-available --language en --language pt-BR --output "$private/corpus.json"
```

- `--samples PATH` reads a JSON array. Each object has a unique string `id` and `text`, with optional `timestamp` (ISO 8601 with timezone), `language`, `genre`, `purpose`, `conversation_id`, and `origin` (object). `purpose` is `authored` (the default for provided samples) or `agent-interaction`. These labels are claims to check, not proof of authorship.
- Repeat `--local` for the local sources the user chose: `claude`, `codex`, `bb`, `cursor`, `opencode`. Without `--local`, the tool does not call any history reader. The local [coverage notes](local-sources.md) describe storage, authorship and format limits.
- Repeat `--report NAME=PATH` for selected reports supplied by a host adapter. Use an unused lowercase name with letters, digits or hyphens. A report has `schema_version: 1`, `source: NAME`, `status`, optional `reason`, and `messages`. Each message needs `id`, `text`, `conversation_id`, and a nonempty `origin` object. It may also include the sample metadata above. The collector retains the adapter's original reason in the private output, not in the console summary.
- Choose `--all-available` or a `--since`/`--until` pair. Bounds are inclusive/exclusive in UTC. An undated message cannot qualify for a bounded period and is reported, not given a guessed date.
- Repeat `--language` for the languages in scope. Tags compare case-insensitively by exact match. Known out-of-scope tags are excluded. Untagged messages remain unknown for human review, not detected or counted as evidence in a chosen language. Genres are supplied or reviewed separately, not inferred by the collector.

Output is a new JSON file with source reports, per-message provenance and language/genre counts. On POSIX it is created with mode `0600`. Keep the output and adapter files outside tracked and shared directories; use a private directory on every platform. Progress goes to stderr, and the stdout summary has source labels, statuses and counts, not text or adapter reasons.

| Status | Meaning |
|---|---|
| `ready` | The selected input was read within the documented coverage. It can contain zero matching messages. |
| `absent` | No selected local history was found. |
| `partial` | The report has a known coverage gap and may still contain usable messages. |
| `unavailable` | Read failed and the report has no readable messages. |
| `unsupported` | The input or format could not be interpreted and the report has no readable messages. |

Exit `0` means all selected sources were ready and at least one message matched. Exit `3` writes a corpus but flags restrictions or no matching evidence. Exit `2` rejects arguments or an output that cannot be created. None of these codes verifies authorship. A source that was not selected does not get a report.

## Review and save a profile

The target's parent directory must exist. For a new profile, prepare edits against the template. For an existing profile, prepare them against the exact current text. The edits file is an array of `{"before":"exact current span","after":"approved replacement"}` objects. Each `before` must match exactly once at the time its edit is applied. Use short, specific spans so unrelated material stays intact. An `after` value may use any language. Do not point the edit command at a corpus or use it to copy source excerpts wholesale.

```sh
python3 scripts/voice_profile.py review --profile "$profile" \
  --edits "$private/edits.json" --output "$private/proposal.json"
python3 scripts/voice_profile.py apply --profile "$profile" \
  --proposal "$private/proposal.json" --approved "$approved_revision"
```

Review does not write the profile. Show the exact edits and the SHA-256 `proposal_revision` for approval. Apply checks that revision, the target path and the original profile's contents before it writes. It refuses stale proposals and leaves manual changes intact. Concurrent applies are serialized by an exclusive sibling lock; avoid editing the file in a separate editor while apply is running. Only remove an abandoned lock after verifying that no apply is running. Apply changes the one explicit file, never supporting references.
