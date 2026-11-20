# Local source coverage

Local session messages are candidates for interpreting assistant communication preferences. A user role or provider identity does not prove human authorship. No collector infers a language or a writing genre.

| Selection | Read surface | Coverage |
|---|---|---|
| `claude` | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `projects/*/*.jsonl` | Top-level human candidate text; excludes side chains, tool results and system-origin records. |
| `codex` | `codex app-server --stdio` in `$CODEX_HOME` and `~/.codex`; JSONL fallback under `sessions` and `archived_sessions` | Active and archived threads, paginated turns and items; local files alone may not contain complete paginated history. Only history read methods are called after initialization. The executable may use its own local runtime. |
| `bb` | Installed `bb thread list` and `bb thread messages` | Active and archived threads, paginated events, accepted user-initiated requests; excludes requests from other threads and service events. |
| `cursor` | `~/.cursor/chats/**/store.db` and Cursor IDE's `User/globalStorage/state.vscdb` | Current reachable CLI turns and referenced IDE bubbles, including supported legacy inline bubbles. Excludes drafts, hidden records and simulated or delegated requests. |
| `opencode` | `$XDG_DATA_HOME` or `~/.local/share`, `opencode/opencode.db` | `session_v2` and `session_message` root-session user records; excludes child sessions and synthetic records. |

Cursor IDE discovery checks the standard application-data location for macOS, Linux or Windows, plus `VSCODE_PORTABLE` and `VSCODE_APPDATA`. A custom IDE launch directory may not be discovered. SQLite opens read-only with query-only mode; the collector does not copy databases or change their permissions.

Recognized mixed interface envelopes, shell output and service instructions are excluded. Review ambiguous passages rather than trying to recover a human fragment from a mixed envelope. Identical text with different IDs is not automatically a duplicate. If both `bb` and `codex` are selected, provider identities reconcile exact one-to-one duplicates after collection; unresolved overlap is partial, not proof of a duplicate.

Use `--exclude-codex-originator MARKER` with `--local codex` if your host tags additional automated threads. Repeat the option as needed. The case-insensitive substring matches the Codex originator field before messages are read from either the history API or JSONL fallback.

Missing linked messages, unsupported formats and interrupted pages can leave partial evidence. A successful read covers the formats and records described here, not deleted history or every possible version. Tests use artificial inputs and mocked read APIs, not installed-account probes.
