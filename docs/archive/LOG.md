# Closed task journal

One line per task: number with slug, closing date, outcome, body revision, and title. The revision names the commit `show N` reads the body from, which may include edits made after closure. The body is not in the tree — the definition and the result live in git, and `npx --no-install backslop show N` retrieves them. Lines are appended at the end: a single fold adds the task and its batch entries, a bulk fold orders top-level tasks by closing date, equal dates by number. Each batch's minor entries follow its line in numeric order.

An `—` outcome means that `result.md` did not name one. An `—` commit means that the body is in no revision the line could name. After `npx --no-install backslop fold N` it is only in the message of the fold commit, so commit the draft, and `show` finds it by the task section in a commit message, then by the `AH-N:` subject. After a bulk fold the body was not in history: it is in the draft if `--embed-missing` was given, and otherwise it is lost.

- <a id="ah-1"></a>`AH-1-project-foundation` · 2026-11-20 · completed · — · Establish the project foundation
