# Decisions

> Architecture decisions, lightweight. One entry per choice that would be
> expensive to reverse, or that a future reader would otherwise second-guess.
>
> The point is not the decision — it is the *context*, so that when the context
> changes the decision can be revisited honestly. Newest first.
>
> Add entries with: `node .bitacora/cli.mjs new decision "Title" --tags area`

<!-- bitacora:entry
id: D-0006
date: 2026-09-21
tags: [design]
-->
### Install verifies the hook runs before saying it is armed

**Context.** The natural hook command is `npx blastdoor hook`. In a project that never
installed the package, that fails on every call — and PreToolUse hook failures
are not shown, so the repository looks armed while nothing is saved. That is
precisely the failure this whole tool exists to prevent, reproduced by its own
installer.

**Decision.** Install resolves a concrete command — the project's node_modules first, then
the absolute path of the running script — writes it, then executes it. If it
does not run, install prints "Not armed", says why, and exits non-zero. If the
path is inside an npx cache directory, it says so, because that directory is
temporary.

**Consequences.** "Armed" is a verified claim rather than a hopeful one. The cost is a slower
install, a hook command in settings.json that is an absolute path rather than
something readable, and a reinstall after moving the project.

<!-- bitacora:entry
id: D-0005
date: 2026-09-21
tags: [design]
-->
### Restore puts files back and never deletes any

**Context.** A restore that is not exact leaves the tree in a mixture of two moments.
Getting it exact means deleting files that exist now and did not exist in the
snapshot — which means a recovery tool deleting a user's files.

**Decision.** Restore writes the snapshot's file contents over the working tree, takes a
snapshot of what it is about to replace first, and then names every file that
exists now and was not in the snapshot — without touching any of them.

**Consequences.** Nothing is ever lost by running restore, including the state that was there a
second before, and the undo of the restore is another snapshot id. The cost is
that the result is not a pristine checkout, so the output has to be read rather
than trusted. `restore --into` gives a clean copy for when that matters.

<!-- bitacora:entry
id: D-0004
date: 2026-09-21
tags: [design]
-->
### The working tree, and nothing else

**Context.** A dropped table, a force-pushed branch and a deleted S3 bucket are disasters
too, and the trigger list could easily grow to cover all of them.

**Decision.** Triggers fire only on commands that destroy files in the working tree. `git
push --force` and `DROP TABLE` are deliberately absent from the list.

**Consequences.** Everything the tool catches, it can actually undo. A net that fires on a
dropped database would take a snapshot that restores nothing, and the person
would find that out at the worst possible moment. The cost is that blastdoor
has to say plainly what it does not cover, in the README and in its own output.

<!-- bitacora:entry
id: D-0003
date: 2026-09-21
tags: [design]
-->
### A snapshot is a git commit on a ref outside your branch

**Context.** The state to save is the working tree, including uncommitted and untracked
work. Copying files is slow and duplicates data. `git stash` touches the
working tree and the stash list, which are the user's. A commit on the current
branch rewrites the history someone is in the middle of.

**Decision.** The tree is written with a throwaway index — GIT_INDEX_FILE pointed at a path
that does not exist — then commit-tree, then a ref under refs/blastdoor. The
user's index, working tree, branch and HEAD are never read or written. Git
identity comes from environment variables, so a repository with no configured
user still gets snapshots.

**Consequences.** It is instant and deduplicated for free: git stores one copy of unchanged
content, and an identical tree is detected by hash and not stored twice.
Nothing in the user's git state moves. The cost is that a snapshot holds only
what git can see: files in .gitignore, .env above all, are not in it unless
they are named in forceInclude.

<!-- bitacora:entry
id: D-0002
date: 2026-09-21
tags: [design]
-->
### Never block, never fail a tool call

**Context.** A PreToolUse hook can deny a tool call. The obvious product is a guard that
refuses dangerous commands. Every developer who has fought a linter that was
right 80% of the time knows what happens next: it gets disabled, and then it
protects nothing.

**Decision.** blastdoor never denies anything and never returns a failing exit code. It takes
a snapshot and gets out of the way. Every path in the hook, including a
malformed payload, a repository it cannot read, and its own crash, ends in exit
0 — the error goes to .blastdoor/errors.log, never to the agent.

**Consequences.** There is no reason to turn it off, which is the only way a safety net is there
on the day it is needed. The cost is that it never prevents anything: the
destructive command always runs. This tool makes disasters reversible, it does
not make them impossible.
