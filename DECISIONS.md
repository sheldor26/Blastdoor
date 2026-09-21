# Decisions

> Architecture decisions, lightweight. One entry per choice that would be
> expensive to reverse, or that a future reader would otherwise second-guess.
>
> The point is not the decision — it is the *context*, so that when the context
> changes the decision can be revisited honestly. Newest first.
>
> Add entries with: `node .bitacora/cli.mjs new decision "Title" --tags area`

<!-- bitacora:entry
id: D-0008
date: 2026-09-21
tags: [hook, codex, scope]
-->
### Codex CLI support writes the hook but cannot verify it is armed

**Context.** Codex CLI has its own `PreToolUse` hooks, in the same `{ hooks: { PreToolUse:
[...] } }` shape Claude Code uses, confirmed by reading its binary's embedded
schema strings and by two independent write-ups (agenticcontrolplane.com,
learn.chatgpt.com). But every hook there needs to be reviewed and trusted by
hand, once, inside Codex's own `/hooks` TUI — there is no flag or config
setting that pre-approves one; `--dangerously-bypass-hook-trust` exists but is
per-invocation and explicitly named dangerous. Verified directly: a hook
written to `hooks.json` and never trusted was silently skipped by a real
`codex exec` run — the file-write tool call it should have snapshotted
completed with no snapshot taken and no error shown. D-0006 established that
`install` only claims "armed" after proving the hook runs; that proof does not
exist for Codex and cannot be manufactured without either a real TUI session
or the dangerous bypass flag, which `install` has no business reaching for
on someone's behalf.

**Decision.** `blastdoor install --target codex` writes the hook to `~/.codex/hooks.json` —
user-level, not a repo-level file, because Codex has no equivalent of
`$CLAUDE_PROJECT_DIR` to make a relative command portable, and an absolute
path is personal configuration (M-0001). It still verifies the command itself
runs. But it never prints "Armed." — it says plainly that Codex will skip the
hook silently until the user runs `/hooks` and trusts it themselves, and that
until then nothing is blocked and nothing is snapshotted, with no signal
either way.

**Consequences.** This is honest about a gap `install` cannot close, at the cost of a worse
first-run experience than Claude Code's — one manual step, undiscoverable
without reading the install output. The upside of the user-level path: trusting
it once protects every repository opened with Codex, not just the one `install`
ran in. Unverified: whether Codex's hook-trust UX changes in a way that adds a
non-interactive path (worth re-checking before publishing), and whether the
`apply_patch` matcher and stdin payload shape hold across Codex CLI versions —
this was checked on 0.153.4 only.

<!-- bitacora:entry
id: D-0007
date: 2026-09-21
tags: [hook, scope]
-->
### Snapshot Write, Edit and MultiEdit unconditionally, not by trigger match

**Context.** The trigger list in `lib/triggers.mjs` exists because a shell command needs a
pattern to tell a destructive one from an ordinary one. `Write`, `Edit` and
`MultiEdit` carry no command string at all — the payload is a file path and new
content. There was a real question whether `PreToolUse` even fires on these
tools: anthropics/claude-code#91574 reads, on a first pass, like it does not.
Reading the full thread and reproducing it directly (a throwaway repo, a
canary hook, a fresh `claude -p` session) showed the bug is narrower — a
specific "deny" JSON shape gets silently ignored on some builds — and does not
touch a hook that only takes a side effect and always exits 0, which is all
blastdoor ever does.

**Decision.** `Write`, `Edit` and `MultiEdit` snapshot on every call, unconditionally. There
is no trigger to match because there is nothing to distinguish: any write can
be the one that overwrites a file the agent misread, and the cost of a
snapshot is a git object, not a blocked call. `Bash` keeps trigger matching —
most Bash commands are not destructive, and matching still earns its keep
there.

**Consequences.** This makes the more common disaster (STATE.md: "an agent overwriting a file it
misread") reversible, closing the gap `Next` item 3 used to name. It also
means every edit in a session produces a ref under `refs/blastdoor`, not just
the rare destructive one — `prune` matters more now than it did with `Bash`
alone. Unverified: whether `PreToolUse` on `Write|Edit|MultiEdit` is reliable
across Claude Code versions and platforms beyond the one build this was tested
on (STATE.md "Next" item 2 — a week of real sessions — covers this too).

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
