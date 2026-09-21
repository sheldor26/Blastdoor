# MISTAKES — 2026

> Archived by bitacora. Still searchable with "recall".

<!-- bitacora:entry
id: M-0001
date: 2026-09-21
tags: [install, portability]
severity: high
-->
### install wrote a machine-specific path into the shared settings file

**What happened.** The installer resolved the hook to an absolute path on this machine and wrote
it into .claude/settings.json — the file that gets committed and cloned.
Anyone else opening the repository would get a PreToolUse hook pointing at a
directory that does not exist on their computer. Caught by running whatloads
against this repository minutes after the installer was written, and by reading
its output rather than trusting the zero findings.

**Root cause.** Two correct decisions collided. Resolving a concrete path instead of a bare
npx call was right, because an unresolvable hook fails silently. Writing the
hook into settings.json was right for a portable command. Nothing connected the
two: the code chose the path and the destination independently, so the moment
the path stopped being portable the destination was wrong.

**Guardrail.** The destination is derived from the command, in one expression: a command is
written to the shared settings.json only when it resolves inside the project
(node_modules/.bin), and to settings.local.json otherwise. A test asserts that
an absolute path never appears in the shared file. The general rule this
follows: whether configuration is shared is a property of the configuration,
never a separate choice made beside it.

<!-- bitacora:entry
id: M-0002
date: 2026-09-21
tags: [hook, regex, coverage]
severity: medium
-->
### Unanchored matcher regex silently missed NotebookEdit while still firing the hook

**What happened.** `CLAUDE_MATCHER` was `'Bash|Write|Edit|MultiEdit'`. Claude Code tests a hook's
matcher as an unanchored regex against the tool name, so `'Edit'` also matches
inside `'NotebookEdit'` — the hook fired on every notebook edit, spawning a
process for nothing, because `WRITE_TOOLS` (a separately hand-written `Set` in
`bin/blastdoor.mjs`) did not include `'NotebookEdit'` and produced no hit. The
exact disaster D-0007 says this diff closes — an agent overwriting a file it
misread — was left uncovered for notebooks, with no signal anything was wrong.
Caught by a code-review pass across 8 independent finder angles, not by the 44
tests already in place, none of which exercised a tool name Claude Code itself
treats as distinct.

**Root cause.** Two facts about "which tool names blastdoor snapshots for" were kept in two
places that don't check each other: the regex string in `lib/settings.mjs`
(what makes the hook fire) and the `Set` in `bin/blastdoor.mjs` (what the hook
does once fired). Widening one without the other produces exactly this gap,
and nothing short of reading Claude Code's own matching semantics would have
surfaced it — a plain string-equality mental model of "matcher" hides that it
is actually `RegExp.prototype.test()`.

**Guardrail.** `WRITE_TOOLS` in `bin/blastdoor.mjs` is now derived from `CLAUDE_MATCHER` and
`CODEX_MATCHER` themselves (`matcher.split('|')`) instead of hand-listed, so
the two can no longer drift — extending a matcher automatically extends what
the hook acts on. `NotebookEdit` was added to `CLAUDE_MATCHER` explicitly
rather than left to accidental substring matching. A test asserts a
`NotebookEdit` payload produces a snapshot.

<!-- bitacora:entry
id: M-0003
date: 2026-09-21
tags: [triggers, regex]
severity: high
-->
### Trigger regex required the flag immediately after the command word

**What happened.** `rm -r`, `rm -f`, `mv onto an existing path with force` and
`git checkout over the working tree` all required their flag to sit
immediately after the command word. `rm ruta/al/directorio -rf` and
`git checkout HEAD -f` — both ordinary, valid shell syntax, both as
destructive as the adjacent-flag form — matched none of them. Confirmed
directly against `match()`: both returned `null`. An agent using either
order left the user with no snapshot before a real destructive command,
silently, since the hook never reports what it did *not* match.

**Root cause.** The patterns were written against the common case (`rm -rf path`) and never
tested against the equally common, equally valid reordering. `git clean`'s
pattern already tolerated the flag appearing anywhere in the clause; the
others didn't follow the same shape.

**Guardrail.** The four patterns now allow whole tokens between the command word and the flag,
while still requiring the flag to be its own whitespace-delimited token —
not a suffix of an unrelated word or path. Tested both directions: `rm
ruta/al/directorio -rf` and `git checkout HEAD -f` now fire, while `rm
somefile-rf` and `git checkout feature-f` (a file or branch that merely ends
in the flag's letters) still do not. The `git checkout` pattern's first
version introduced its own regression while fixing this one: moving the
`\b` boundary outside the alternation group, applied uniformly to every
alternative, broke the two that end in `.` rather than a letter — `.` is a
non-word character, so a `\b` asserted right after `\.\s*$` (already at
end-of-string) can never hold, and `git checkout .` silently stopped firing
entirely. An external audit's second pass caught it; the pattern now keeps
`\b` scoped to only the two alternatives that need it (`-f\b`, `--force\b`).
Both `git checkout .` and `git checkout -- .` are now covered by tests —
neither was, the first time this pattern was written. A third pass found one
more gap in the same pattern: `-f\b`/`--force\b` only matched a lone flag,
the same adjacency-shaped mistake this whole entry started from, one level
down — `git checkout -qf HEAD` (quiet + force, combined, exactly the shell
syntax `rm`/`mv` already tolerate) didn't fire. The flag alternative is now
`-[a-zA-Z]*f[a-zA-Z]*\b`, matching the same shape the other three patterns
already used. Tested against combined flags in both orders (`-qf`, `-fq`)
and against `git checkout -q main`, which must still not fire. A fourth pass
found that fix unbounded: `-[a-zA-Z]*f[a-zA-Z]*` matches any dash-prefixed
word containing an 'f', so a branch genuinely named `-feature` false-fired.
Capped to `-[a-zA-Z]{0,3}f[a-zA-Z]{0,3}\b` — real flag clusters are short;
`-feature` no longer matches, `-qf`/`-fq` still do.

