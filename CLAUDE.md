# CLAUDE.md

## Ongoing -> documents -> decisions log flow

    ongoing/        your own raw draft, any format, local, not committed
    documents/      Claude writes <topic>.md from your ongoing draft, using
                    documents/_template.md -- ask before guessing anything
                    unclear
    decisions.md    one line per topic, Y-statement format: "In the context
                    of [use case], facing [concern], we decided [option] to
                    achieve [quality], accepting [downside]."

Staleness check: at session start, flag anything in ongoing/ untouched for
~7 days and ask if it's ready to promote.

## Commit workflow for agent sessions

Standing override of "always ask before committing" — local commits only.
Pushing/rewriting history is unchanged and still always needs confirmation.

- Commit locally without asking, as soon as a change is verified working
  (tests pass / manual check confirms it). Don't wait for session end.
  Only applies inside directories that are actual git repos.
- One commit per resolved problem, not per attempt. Fold failed tries and
  retries into a single clean commit for the working result.
- Commit message format — summary line uses a Conventional Commits prefix,
  body explains the why, not the diff:

  ```
  <type>: <short summary of what changed>

  Problem: <what was actually wrong — symptom, constraint, root cause>
  Fix: <what changed to address it>
  Why: <why this approach, if not obvious>
  ```

  `<type>` is one of: fix, feat, refactor, docs, chore, perf.

- Always ask first before: git push, force-push, git reset --hard / clean,
  amending an already-pushed commit, or touching a shared/live branch.
- Never commit secrets (.env, tokens, credentials) — stop and ask instead.
