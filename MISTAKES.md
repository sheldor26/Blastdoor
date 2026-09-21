# Mistakes

> Every time something breaks, it gets an entry here — what happened, why it
> was possible, and the guardrail that makes it impossible to repeat.
>
> An entry without a guardrail is just a complaint. Newest first.
>
> Add entries with: `node .bitacora/cli.mjs new mistake "Title" --tags area,failure-mode`
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

