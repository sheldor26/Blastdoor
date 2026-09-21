<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" width="72" height="72" alt="blastdoor">
</picture>

# blastdoor

[![npm version](https://img.shields.io/npm/v/blastdoor.svg)](https://www.npmjs.com/package/blastdoor)

An agent runs `git reset --hard` on two hours of uncommitted work. Or `rm -rf`
with a variable that turned out to be empty. Or `git clean -fd` in the wrong
directory. It happened to Amazon: a thirteen-hour outage when an agent deleted
and recreated an environment.

blastdoor commits your whole working tree to a hidden git ref **the moment
before** that command runs, and gives you one command to put it back.

```bash
npm install --save-dev blastdoor
npx blastdoor install
```

That is the whole setup. There is nothing to sign up for and nothing to run.

## What happens

```
$ npx blastdoor list

1789957102334     2m ago  git reset --hard
               git reset --hard HEAD~3
1789956940112    41m ago  rm -r
               rm -rf node_modules/.cache

$ npx blastdoor restore 1789957102334

restored the contents of snapshot 1789957102334 2m ago
the state you had a second ago is snapshot 1789957140880 — restore that to undo this
```

## It never blocks anything

blastdoor does not refuse commands, does not ask you to confirm, and cannot
fail a tool call. It takes a snapshot and gets out of the way — including when
it crashes, when the payload is malformed, and when there is no git repository.
Every path exits zero.

This is on purpose. A guard that is right 80% of the time gets disabled, and
then it protects nothing on the day it was needed. The trade is explicit:
**blastdoor never prevents the destructive command. It makes it reversible.**

## What a snapshot is

A git commit on a ref under `refs/blastdoor`. Not on your branch, not in your
stash, not in a directory somewhere.

The tree is built with a throwaway index — `GIT_INDEX_FILE` pointed at a path
that does not exist — so **your index, your working tree, your branch and HEAD
are never read or written**. Uncommitted changes and untracked files are both
captured. Identical trees are not stored twice. Git identity is forced through
environment variables, so a repository with no configured `user.email` still
gets snapshots.

To remove every trace: `git for-each-ref --format='%(refname)' refs/blastdoor | xargs -n1 git update-ref -d`.

## What it does not cover

- **Files git cannot see.** Anything in `.gitignore` is not in a snapshot —
  `.env` above all. Name those paths under `forceInclude` in
  `blastdoor.config.json` if you want them captured, knowing they end up in git
  objects.
- **Anything that is not the working tree.** A dropped table, a force-pushed
  branch, a deleted bucket. Those triggers are deliberately absent: a snapshot
  of your files restores none of them, and a net that fires where it cannot
  help is worse than one that says where it stops.
- **Commands it cannot recognise.** Triggers are patterns over the shell
  command. `rm -rf "$DIR"` fires; a command assembled at runtime from a
  variable does not. This will never be complete.

## Triggers

`rm -r`, `rm -f`, `git reset --hard`, `git checkout` over the working tree,
`git restore` over the working tree, `git clean -f`, `git stash drop|clear`,
`git branch -D`, `find -delete`, `find -exec rm`, `xargs rm`, `truncate -s 0`,
`shred`, `mv -f`.

Each clause of a compound command is tested on its own, so
`npm test && rm -rf dist` fires. Add your own in `blastdoor.config.json`:

```json
{
  "triggers": ["\\bterraform\\s+destroy\\b"],
  "forceInclude": [".env"],
  "keep": 50
}
```

## Commands

```
npx blastdoor install          arm the hook in this repository, for Claude Code
npx blastdoor install --target codex
                               write the hook for Codex CLI (see below — one
                               extra step, inside Codex itself)
npx blastdoor list             every snapshot, newest first
npx blastdoor diff [id]        what changed since a snapshot
npx blastdoor restore <id>     put those file contents back
npx blastdoor restore <id> --into <dir>
                               write it to a tar file instead, touching nothing
npx blastdoor snapshot         take one by hand
npx blastdoor prune --keep 50  drop the oldest
npx blastdoor uninstall        remove the hook, keep the snapshots
```

`restore` never deletes a file. It writes the snapshot's contents over the
working tree, snapshots what it is replacing first, and then names every file
that exists now and did not exist then — leaving all of them exactly where they
are. Use `--into` when you want a clean copy instead of a merge.

## install checks its own work

The obvious hook command is `npx blastdoor hook`. In a project that never
installed the package it fails on every call — and failed `PreToolUse` hooks
are not surfaced, so the repository looks armed while nothing is being saved.
That is the exact failure this tool exists to prevent, so `install` resolves a
concrete path, writes it, runs it, and prints **Not armed** with the reason if
it did not work.

## Codex CLI

`npx blastdoor install --target codex` writes the hook to the user-level
`~/.codex/hooks.json` — one install protects every repository you open with
Codex, not just the one you ran it in. Codex requires every hook to be
reviewed and trusted by hand before it runs anything, and there is no flag or
setting that pre-approves one, so there is one extra step:

```
codex
```

then `/hooks`, find blastdoor, and trust it. Until that happens Codex skips
the hook silently — nothing is blocked, but nothing is snapshotted either, and
nothing says so. `install` cannot verify this step the way it does for Claude
Code, so it does not claim to; it tells you plainly that it is still missing.

## Requirements

Node 18 or newer, and a git repository. No dependencies.

## License

MIT
