# State

updated: 2026-09-21

> A snapshot of where this project is right now — the file a new session reads
> first. It answers "what exists, what is half-done, what is next".
>
> It is not a diary. When this file starts telling stories, the stories belong
> in the logbook. `doctor` enforces that with a line budget.

## Shipped

- The hook: a `PreToolUse` handler on `Bash|Write|Edit|MultiEdit` that commits
  the whole working tree — uncommitted and untracked included — to a ref under
  `refs/blastdoor` before the call runs, then reports the snapshot id back to
  the session as JSON. `Bash` commands are matched against a trigger list;
  `Write`, `Edit` and `MultiEdit` snapshot unconditionally, since the overwrite
  itself is the risk, not a specific command shape. Every path in it exits 0.
- Snapshots taken with a throwaway index, so the user's index, working tree,
  branch and HEAD are never touched, and with a forced git identity, so a
  repository with no configured user still works.
- Identical trees are not stored twice.
- Thirteen built-in triggers, matched per clause of a compound command, plus
  extra patterns from `blastdoor.config.json`.
- `install` resolves a concrete command, writes it into `.claude/settings.json`
  keeping everything it does not own, then runs it and refuses to say "armed"
  if it did not work.
- `install --target codex` writes the same hook (matcher `Bash|apply_patch`,
  since Codex reports every file edit as `apply_patch`) to the user-level
  `~/.codex/hooks.json` — protects every repo opened with Codex, not just one.
  Codex requires every hook to be reviewed and trusted by hand in its own
  `/hooks` TUI, with no non-interactive way to pre-approve one, so install
  cannot say "armed" here the way it does for Claude Code (D-0008) — it says
  what is written and what step is still missing.
- `list`, `diff`, `snapshot`, `restore`, `restore --into`, `prune`,
  `uninstall` (both take `--target codex`).
- Restore snapshots the state it is replacing and never deletes a file.
- 44 assertions in `test/smoke.mjs`, in throwaway git repositories, driving the
  hook with real payload shapes for both harnesses.

## In flight

- Nothing half-written.

## Next

1. README, then publish 0.1.0. The name is free on npm and so is `blast-door`,
   checked both ways after M-0001 in whatloads.
2. Use it for a week on real sessions before telling anyone it works. The only
   evidence it fires correctly today is a test suite written by the same person
   who wrote the triggers.
3. Re-check the Codex integration against a newer CLI version before
   publishing — checked against 0.153.4 only (D-0008), and hook trust UX is
   the kind of thing that could grow a non-interactive path.

## Known rough edges

- Files in `.gitignore` are not in a snapshot. `.env` is the case that will
  bite someone. `forceInclude` exists, it is empty by default, and the install
  output says so out loud — but the default is still the surprising one.
- The trigger list is regular expressions over a shell command. `rm -rf "$DIR"`
  fires; a destructive command built at runtime from a variable does not. This
  will never be complete, and the README has to say that rather than imply a
  guarantee.
- `restore` leaves files created after the snapshot in place and names them.
  That is deliberate, but it means the result is not a pristine checkout and
  the output has to actually be read.
- Snapshots accumulate in the repository. `prune` exists but nothing calls it
  automatically, so a long-lived repository grows refs quietly.
