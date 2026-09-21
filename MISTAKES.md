# Mistakes

> Every time something breaks, it gets an entry here — what happened, why it
> was possible, and the guardrail that makes it impossible to repeat.
>
> An entry without a guardrail is just a complaint. Newest first.
>
> Add entries with: `node .bitacora/cli.mjs new mistake "Title" --tags area,failure-mode`
<!-- bitacora:entry
id: M-0011
date: 2026-09-21
tags: [settings, detection]
severity: medium
-->
### hook detection matched any command mentioning blastdoor as a substring

**What happened.** `isOurs()` decided whether a `PreToolUse` group belonged to blastdoor by checking
whether any hook `command` contained the plain substring `"blastdoor"`, anywhere.
install and uninstall both use it to decide what to replace or remove.
A different tool's hook whose command merely mentioned blastdoor — a comment,
a log message, an unrelated script with a similar name — would be silently
deleted or overwritten, breaking the promise (M-0001, D-0001-style intent)
that blastdoor only ever touches its own entry.

**Root cause.** A substring check was the simplest thing that made the existing tests pass,
and every test command that was supposed to match legitimately contained
"blastdoor" nowhere else needed to be ruled out. Nobody wrote the test case
where "blastdoor" appears in someone else's command for an unrelated reason.

**Guardrail.** First attempt: require `blastdoor`/`blastdoor.mjs` as a whole word
(`\bblastdoor(\.mjs)?\b`) plus the command ending in `hook`/`hook || true`.
Wrong — a second audit pass on the fix itself found `\b` alone isn't specific
enough: a hyphen is a non-word character, so `\bblastdoor\b` still matches
inside a differently-named tool's own command, `"/usr/bin/acme-blastdoor"
hook || true`. `isOurs()` now requires "blastdoor" or "blastdoor.mjs" to be a
whole *path segment* — preceded by `/`, the string start, or a quote, and
followed by the same — which a name like "acme-blastdoor" cannot satisfy.
Tests cover both: a hook that merely mentions blastdoor in a comment, and one
belonging to a real tool whose own name contains "blastdoor" as a substring;
both must survive install and (a gap the same audit pass caught — the first
test only exercised install) uninstall. A third pass found the path-segment
version was itself POSIX-only: `resolveCommand()` always quotes its paths,
but on Windows the separator is `\`, not `/` — the character right before
"blastdoor" in blastdoor's own re-install command — so the check would have
failed to recognize blastdoor's own previous entry on Windows and duplicated
it on every install. `\` was added as a valid delimiter on both sides. Left
open, narrow and documented rather than chased further: a foreign hook whose
command quotes a path that happens to look exactly like blastdoor's own and
also happens to end the same way would still be misdetected — closing that
completely would mean encoding hook JSON with a bespoke marker field of
uncertain compatibility with what Claude Code/Codex actually parse, which
seemed like a worse trade than a residual gap this narrow. A fourth pass
changed that trade-off: every attempt at this function had found a new way
past a text-pattern guess (four rounds, four distinct gaps), so `entry()`
now stamps every hook it writes with `[MARKER]: true` — an explicit,
unambiguous field, not another regex — and `isOurs()` checks that first.
The path-segment regex survives only as `isLegacyOurs()`, recognising hooks
written by 0.1.0/0.1.1 before the marker existed, so upgrading doesn't
duplicate an old entry. The same pass also caught that adding `\` as a
delimiter had silently dropped `/` from the closing side — a legacy entry
naming "blastdoor" as a bare directory (no trailing quote or space) stopped
matching. Both sides of the legacy pattern now include `/`, `\` and `"`. A
fifth pass found the legacy fallback itself reopened the original decoy
problem — every hook without the marker (which, before this field existed,
was every hook) was exactly as exposed as before the marker was added.
There is no version of this regex that has survived an audit pass; it's
gone rather than narrowed again. `isOurs()` now checks the marker field
alone. Cost, accepted and documented at `entry()`'s definition: re-running
install after upgrading from a version before the marker existed adds a
second entry instead of replacing the first one — harmless (both run the
identical, always-safe hook), not silent.

<!-- bitacora:entry
id: M-0010
date: 2026-09-21
tags: [security, install]
severity: high
-->
### install/uninstall followed a symlink and wrote through it

**What happened.** `settings.install()`/`uninstall()` wrote to `.claude/settings.json` and
`~/.codex/hooks.json` with plain `writeFileSync`, which follows symlinks like
every Node fs write. A repository could plant either path as a symlink to any
other file the user can write — `~/.bashrc`, an SSH config, anything — and
running `blastdoor install` inside it would silently overwrite the symlink's
target with hook JSON instead of writing to the intended path. Confirmed by
creating exactly that symlink and running `install` against it: the outside
file was overwritten, not the symlink itself.

**Root cause.** The file-writing code trusted the path it was given to mean what it said —
reasonable for a path the tool itself resolved, not for one sitting inside a
project directory that could be anything a cloned repository put there before
`install` ever ran.

**Guardrail.** First attempt: `lstatSync(path).isSymbolicLink()` on the settings file itself.
Wrong — a second audit pass found the same escape one level up: a repository
can commit `.claude` *itself* as a symlinked directory, in which case the
leaf path is an ordinary file sitting wherever `.claude` actually points, and
the file-only check never sees a symlink at all. Reproduced directly before
trusting the fix. `install()`/`uninstall()` now check both the file and its
immediate parent directory — not every ancestor, which would also flag
unrelated, legitimate symlinks elsewhere in the path — and the same two-level
check was applied to `.blastdoor/errors.log`, which had the identical gap.
Tests cover a symlinked settings file and a symlinked `.claude` directory
both refusing to write and leaving their real target untouched. A third pass
correctly called the two-level check itself still check-then-act: between
`writesThroughSymlink()`'s `lstatSync` and the `writeFileSync` a few lines
later, a symlink swapped into either path would still get followed — the
check narrowed the window, it never closed it. `writeFileSync` is now
`writeNoFollow()`: `open()` with `O_NOFOLLOW`, which fails at the syscall
itself (`ELOOP`) if the final path component is a symlink *at the moment of
opening*, not at the moment of checking — genuinely atomic for the file, not
narrowed. It cannot do the same for the *directory* becoming a symlink
mid-flight; Node has no portable `openat()`-style relative open to make that
atomic too, so the directory-level `lstatSync` remains check-then-act.
Accepted as a known, much narrower residual gap — it now needs a second
process changing the filesystem in the exact interval between two
synchronous calls in this one, not merely a symlink planted at any point
before `install` runs. A fourth pass found two more edges in the same fix,
both closed: `O_NOFOLLOW` is not defined on Windows (the `|| 0` fallback is
why the call still runs there, not equivalent protection — documented
in-code rather than silently assumed equal to the POSIX case), and the
`writeSync` call ignored its own return value, so a short write — legal
per POSIX, `writeFileSync` itself loops for exactly this reason — could
leave a silently truncated JSON file while `install` still reported success.
`writeNoFollow` now loops until every byte written matches the buffer length.

<!-- bitacora:entry
id: M-0009
date: 2026-09-21
tags: [security, install]
severity: high
-->
### a hook command built from local paths could break out of its shell quoting

**What happened.** `resolveCommand()` and `doInstallCodex()` build the hook command as
`"${process.execPath}" "${self}" hook`, wrapping each path in double quotes.
Bash double quotes do not suppress `$(...)`, backticks or `$VAR` expansion —
only single quotes do. A path containing one of those characters would turn
into code that runs every time the hook fires afterward, and once during
`install`'s own `verify()` step, which shells out to the exact string that
gets written to `.claude/settings.json`/`~/.codex/hooks.json`.

**Root cause.** Neither `process.execPath` nor an npm install location is attacker-supplied in
the ordinary sense, so the quoting looked sufficient. It stops being
sufficient the moment either path — chosen by whoever named their own
directories — contains a shell metacharacter, and nothing checked for that.

**Guardrail.** `resolveCommand()` and `doInstallCodex()` now refuse to build a command (and
`install` refuses to write one) if `process.execPath` or the resolved script
path contains `"`, `` ` ``, `$` or `\` — the characters that escape a
double-quoted shell string — reporting exactly which path and why instead of
writing something dangerous.

<!-- bitacora:entry
id: M-0008
date: 2026-09-21
tags: [snapshot, concurrency]
severity: high
-->
### concurrent snapshots in the same millisecond could silently collide

**What happened.** Snapshot ids were `String(Date.now())`, and `git update-ref <ref> <commit>`
overwrites whatever the ref already pointed to without complaint. Two hook
calls landing in the same millisecond — plausible with parallel subagents
editing files in the same repository, which this very session's own workflow
does — would both compute the same id, both call `update-ref` on
`refs/blastdoor/<id>`, and the second one silently replaces the first. Both
callers see a success message; one of them is now pointing at the wrong tree.

**Root cause.** Millisecond resolution felt fine for a tool whose triggers were originally
rare, deliberate, one-at-a-time Bash commands. Snapshotting unconditionally on
every Write/Edit (D-0007) made concurrent hook calls in the same repository
an ordinary case, not an edge one, and nothing in the id scheme was built to
survive that.

**Guardrail.** First attempt: check-then-write — `git rev-parse --verify` for the id, then
`update-ref` if it looked free. Wrong — a second audit pass correctly called
this a textbook TOCTOU: the check and the write are still two separate git
calls, so two processes can both observe "free" and both write, the second
silently winning. `git update-ref <ref> <new> <old>` has a real atomic
create-only form: passing the all-zero object id as `<old>` makes git refuse
at its own ref-locking level if the ref already exists — confirmed directly,
running the exact command twice against the same ref and watching the second
attempt fail with "reference already exists". `snapshot()` now uses that
form and bumps the id only on that specific failure, propagating any other
error instead of retrying it forever. That "specific failure" check was
itself the next gap a third audit pass found: it matches git's English
stderr text, `/reference already exists/`, and git translates its own
messages when built with gettext support and a matching locale is installed
— a real, ordinary config, not a hypothetical. An untranslated match against
translated text fails closed: the retry loop stops firing, and a real
collision gets reported as an unrelated hard error instead of resolved. All
of `git()`'s calls now force `LC_ALL=C`, alongside the existing forced git
identity, so this match — and anything else in the codebase that ever
matches git's stderr — stays reliable regardless of the user's own locale.

<!-- bitacora:entry
id: M-0007
date: 2026-09-21
tags: [restore, git]
severity: medium
-->
### restore claimed the index was untouched while staging every restored path

**What happened.** `doRestore()`'s final line always printed "Your index and your current branch
were not touched." `git checkout <commit> -- .`, the command restore uses to
write the snapshot's files over the working tree, updates the index for
every path it touches — that is what this form of `git checkout` does, by
design, confirmed against real git behavior. The printed claim was false for
every restore that ever ran.

**Root cause.** The sentence was written to describe the intent (D-0005: restore shouldn't
disturb anything beyond the working tree), not measured against what the
one git command actually used does. `git checkout <tree-ish> -- <path>` and
"only touch the working tree" are not the same operation, and nothing
compared them.

**Guardrail.** Three attempts, each closing a gap the previous one didn't. First:
`git checkout <commit> -- .` alone — false claim, as above. Second:
`git checkout` then `git reset -- .` — wrong, because "." resets every staged
path in the whole repository, not just the ones checkout touched, silently
unstaging anything unrelated someone had already staged before running
restore; caught by testing that exact scenario. Third: `git checkout` then
`git reset -- <the snapshot's own paths>`, scoped instead of blanket — closed
the unrelated-file case, but a second audit pass on that fix found it still
loses data in a narrower case: if a path *in* the snapshot already had its
own different staged version (neither HEAD's content nor the snapshot's)
before restore ran, `checkout` overwrites that index entry and `reset` can
only put it back to HEAD, not to what was actually staged. Reproduced
directly before accepting the finding. Fourth: `git restore --worktree
--source=<commit> -- .` — genuinely never touches the index, closing the
staged-version case, but a third audit pass (both auditors, independently)
found it introduced a worse failure than any of the first three: `restore`
treats "not present in the source commit" as "should not exist" and deletes
it from the working tree — including a file created and committed *after*
the snapshot, which the snapshot was never going to know about and had no
business touching. Reproduced directly: staged a new file, ran the command,
watched it vanish. Fifth, and the actual fix: `git read-tree <commit>` into
a throwaway index — the same trick `snapshot()` already uses, never pointed
at the real index — followed by `git checkout-index -a --force`, which
writes exactly the files present in *that* index and has no concept of a
file being "missing" from it, because that index only ever contains what
`read-tree` put there. Tests now cover all three failure modes from the five
attempts: the unrelated-staged-file case, the same-path-already-staged case,
and a file tracked and committed after the snapshot. A fourth pass named a
sixth failure mode in the same fifth attempt: `checkout-index --force`
deletes whatever is in the way of a path it needs to write, recursively —
a directory with real, never-snapshotted content inside it, if the snapshot
wants a plain file at that same path (or the reverse: a plain file, if the
snapshot wants a directory there). Reproduced directly, both directions,
before writing the guard: `typeConflicts()` now checks every snapshot path
and its ancestors against the current working tree first, and refuses the
whole restore — nothing touched, a clear error naming the conflicting path —
rather than let `checkout-index` resolve the conflict by deleting.

<!-- bitacora:entry
id: M-0006
date: 2026-09-21
tags: [restore, transactional]
severity: high
-->
### restore proceeded even when its own safety snapshot failed

**What happened.** `doRestore()` takes a "before restoring" snapshot first, precisely so a bad
restore has its own way back — the comment above the line says so. The code
never checked whether that snapshot actually succeeded before running the
destructive `git checkout` anyway. If `G.snapshot()` returned `{ok: false}`
(a real git error, not the "nothing changed" case), the restore proceeded
with no safety net at all, silently defeating the one guarantee that comment
promised.

**Root cause.** The `before` result was computed and later read (to decide whether to print
the "restore that to undo this" line), which made it look consulted. It was
read for display, never for control flow — nothing gated the checkout on it
succeeding.

**Guardrail.** `doRestore()` now checks `before.ok` immediately after taking the safety
snapshot and exits with an error, before running any destructive command, if
it failed.

<!-- bitacora:entry
id: M-0005
date: 2026-09-21
tags: [install, verify]
severity: high
-->
### install falsely reported Not armed for the best-case local install

**What happened.** When blastdoor is a project's own devDependency, `resolveCommand()` writes
`"$CLAUDE_PROJECT_DIR"/node_modules/.bin/blastdoor hook` — the best case,
portable across every machine that clones the repo (D-0006's whole point).
`$CLAUDE_PROJECT_DIR` is an environment variable Claude Code sets for hooks
it runs itself; it does not exist in an ordinary terminal. `verify()` ran the
command through a plain shell with no such variable set, so it always
expanded to an empty string and resolved to `/node_modules/.bin/blastdoor` —
a path that never exists — and always failed. Running `npx blastdoor install`
from a normal terminal, exactly what the README tells people to do, reported
"Not armed" for a hook that would have worked correctly inside Claude Code.
Confirmed directly: ran the constructed command in a shell with
`CLAUDE_PROJECT_DIR` unset and watched it fail with "No such file or
directory".

**Root cause.** `verify()` was written once, generically, before the 'local' command shape
(the one relying on a Claude-Code-provided variable) existed as a distinct
case with its own runtime requirement. Nothing connected "this command
depends on an environment Claude Code provides" to the environment `verify()`
actually ran it in.

**Guardrail.** `verify()` takes an optional `env` object merged over `process.env`. `doInstall()`
passes `{ CLAUDE_PROJECT_DIR: root }` specifically when `resolveCommand()`
returned the 'local' kind, reproducing what Claude Code provides at runtime
without writing that value into the command itself.

<!-- bitacora:entry
id: M-0004
date: 2026-09-21
tags: [hook, crash]
severity: high
-->
### Hook could crash before its own safety net existed

**What happened.** `const CWD = process.cwd();` ran at module top level, before `hook()`'s own
try/catch exists as a function at all. `process.cwd()` throws `ENOENT` if the
directory it would return has been deleted — confirmed directly: `chdir`
into a directory, delete it, call `process.cwd()`, watch it throw. A hook
runs right before a command that might delete directories, including its own
cwd if an earlier tool call in the same session already ran one. An uncaught
throw here kills the whole `blastdoor hook` process with a non-zero exit —
exactly the "fails the tool call" outcome D-0002 says never happens, produced
by blastdoor's own code before its own safety net could catch it.

**Root cause.** The try/catch in `hook()` reads as the safety net for the whole file, but it
is scoped to one function's body. Anything evaluated at module load —
outside any function — runs before that function exists to be called, immune
to the catch inside it.

**Guardrail.** `CWD` is now computed inside a try/catch at the same module-load point, falling
back to `process.env.PWD || '.'` if `process.cwd()` throws. `hook()` itself
prefers `payload.cwd` from the actual PreToolUse JSON over this fallback
regardless, so the fallback only matters for `requireRepo()` and the
error-log path — both already tolerate a bad or nonexistent directory
gracefully.


## Archived

Older entries, one line each. `recall` still searches them in full.

- `M-0003` Trigger regex required the flag immediately after the command word — [triggers, regex] → `docs/bitacora-archive/mistakes-2026.md`
- `M-0002` Unanchored matcher regex silently missed NotebookEdit while still firing the hook — [hook, regex, coverage] → `docs/bitacora-archive/mistakes-2026.md`
- `M-0001` install wrote a machine-specific path into the shared settings file — [install, portability] → `docs/bitacora-archive/mistakes-2026.md`
