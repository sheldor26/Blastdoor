# Mistakes

> Every time something breaks, it gets an entry here — what happened, why it
> was possible, and the guardrail that makes it impossible to repeat.
>
> An entry without a guardrail is just a complaint. Newest first.
>
> Add entries with: `node .bitacora/cli.mjs new mistake "Title" --tags area,failure-mode`
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

