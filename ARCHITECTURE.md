# Architecture

> How this project is built, and the reasoning that is too structural to live
> in a code comment. If a section here is longer than a screen, it probably
> wants to be a `DECISIONS.md` entry instead.

## Shape

```
bin/blastdoor.mjs   the CLI, and the hook entry point (`blastdoor hook`)
lib/git.mjs         every git call in the project
lib/triggers.mjs    what counts as destructive
lib/settings.mjs    writing the hook into .claude/settings.json
lib/config.mjs      blastdoor.config.json, with defaults
test/smoke.mjs      throwaway git repositories, real payloads, no framework
```

The interesting file is `lib/git.mjs`. Everything else is argument parsing and
text.

## Data

Snapshots are git objects in the repository being protected, under
`refs/blastdoor/<unix-ms>`. There is no database, no state directory, nothing
in the user's home. `git gc` leaves them alone because they are referenced.
Deleting `refs/blastdoor/*` deletes every snapshot and nothing else.

The commit message is a JSON object: the trigger that fired, the clause that
matched, and the session id from the hook payload. `list` parses it back.

`.blastdoor/errors.log` is written only when the hook itself throws. It is the
one place a failure is recorded, because the failure must never reach the
agent.

## Boundaries

- Only `lib/git.mjs` shells out. Nothing else in the project runs a subprocess,
  except `install`, which runs the hook command once to verify it.
- The snapshot path never reads or writes the user's index, working tree, HEAD
  or branch. `GIT_INDEX_FILE` points at a path that does not exist, and git
  builds a throwaway index there.
- Git identity is forced through environment variables. A repository with no
  configured `user.email` still gets snapshots.
- `hook()` catches everything and exits 0. There is no code path in it that can
  fail a tool call — that is the product, not a nicety.

## Conventions

- Node 18+, ESM, standard library only, in the tool and in the tests.
- Triggers are matched per clause: `npm test && rm -rf dist` is split on `&&`,
  `||`, `;` and newlines before matching, because a destructive clause buried
  in a compound command is still destructive.
- A new trigger comes with both cases in `test/smoke.mjs`: something that must
  fire it, and something close to it that must not.
- Output tells the user what was *not* done as plainly as what was. The restore
  output naming untouched files is the model for this.
- The record — this file, the logbook, code comments, commit messages — is
  written in English.
