/**
 * End to end, in throwaway git repositories. No framework.
 *
 * The hook is exercised the way Claude Code exercises it: a payload on stdin,
 * and the only things that matter are the exit code and what ends up on disk.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'blastdoor.mjs');

let passed = 0;
const failures = [];
const temps = [];
const ok = (label, cond) => { if (cond) passed++; else failures.push(label); };

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

const cli = (cwd, args, input, env) => {
  const r = execFileSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });
  return r;
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'blastdoor-test-'));
  temps.push(dir);
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'keep.txt'), 'original\n');
  writeFileSync(join(dir, '.gitignore'), 'secret.env\n');
  writeFileSync(join(dir, 'secret.env'), 'TOKEN=1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}

const payload = (cwd, command) => JSON.stringify({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, session_id: 's1',
  tool_input: { command },
});

const writePayload = (cwd, toolName, filePath) => JSON.stringify({
  hook_event_name: 'PreToolUse', tool_name: toolName, cwd, session_id: 's1',
  tool_input: { file_path: filePath },
});

// --- triggers --------------------------------------------------------------

const { match } = await import('../lib/triggers.mjs');
ok('rm -rf fires', match('rm -rf dist')?.name === 'rm -r');
ok('a trigger inside a compound command fires', Boolean(match('npm test && rm -rf node_modules')));
ok('git reset --hard fires', Boolean(match('git reset --hard HEAD~2')));
ok('git clean -fd fires', Boolean(match('git clean -fd')));
ok('git checkout . fires', Boolean(match('git checkout .')));
ok('git checkout -- . fires', Boolean(match('git checkout -- .')));
ok('an ordinary command does not fire', match('ls -la') === null);
ok('the word rm in prose does not fire', match('echo "rm is a word"') === null);
ok('git push --force does not fire, it is out of scope', match('git push --force') === null);
ok('an extra trigger from config is honoured', Boolean(match('dropdb app', ['dropdb'])));

// A flag after the target, not immediately after the command word, is still
// valid shell syntax and still destructive (M-0003).
ok('rm with the flag after the path fires', match('rm ruta/al/directorio -rf')?.name === 'rm -r');
ok('git checkout with the flag after the ref fires', Boolean(match('git checkout HEAD -f')));
ok('a filename that merely ends in -rf does not fire', match('rm somefile-rf') === null);
ok('a branch named feature-f does not fire', match('git checkout feature-f') === null);
// Combined short flags (-qf) are valid shell syntax `rm`/`mv` already handle;
// `git checkout` didn't, until a third audit pass caught it too (M-0003, third pass).
ok('git checkout -qf HEAD fires (combined short flags)', Boolean(match('git checkout -qf HEAD')));
// The combined-flag pattern above is unbounded in length unless capped — a
// branch genuinely named "-feature" (unusual, but valid) is 7 letters after
// the dash and contains an 'f', so an uncapped version matched it as if it
// were a flag cluster. A fourth audit pass caught it (M-0003, fourth pass).
ok('a branch named -feature does not fire', match('git checkout -- -feature') === null);
ok('git checkout -feature does not fire either', match('git checkout -feature') === null);

// --- config validation -------------------------------------------------------

{
  const dir = repo();
  const { load } = await import('../lib/config.mjs');
  writeFileSync(join(dir, 'blastdoor.config.json'), JSON.stringify({ triggers: null, forceInclude: null }));
  const config = load(dir);
  // Valid JSON, wrong shape — {"triggers": null} used to crash deep inside
  // match()/snapshot() instead of here, silently taking no more snapshots
  // for the rest of the session (a config.mjs-level check on M-0002's class
  // of bug).
  ok('a config with the wrong field types falls back to defaults instead of crashing later', Array.isArray(config.triggers) && Array.isArray(config.forceInclude));
  ok('a config with the wrong field types is flagged invalid', config.invalid === true);
}

// --- settings.mjs: symlinks and hook detection --------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'blastdoor-settings-'));
  temps.push(dir);
  const s = await import('../lib/settings.mjs');

  mkdirSync(join(dir, '.claude'), { recursive: true });
  const outside = join(dir, 'outside-target.json');
  writeFileSync(outside, '{}');
  const { symlinkSync } = await import('node:fs');
  const symlinkPath = join(dir, '.claude', 'settings.local.json');
  symlinkSync(outside, symlinkPath);

  const r = s.install(symlinkPath, '/some/path hook');
  ok('install refuses to write through a symlink', r.ok === false);
  ok('install does not touch the symlink\'s target', readFileSync(outside, 'utf8') === '{}');

  const ru = s.uninstall(symlinkPath);
  ok('uninstall refuses to write through a symlink too', ru.ok === false);

  // Checking only the leaf isn't enough — a repository can commit `.claude`
  // itself as a symlinked directory, which makes every ordinary-looking file
  // under it actually live somewhere else entirely (M-0010, second pass).
  const dir2 = mkdtempSync(join(tmpdir(), 'blastdoor-settings-'));
  temps.push(dir2);
  const outside2 = join(dir2, 'real-outside');
  mkdirSync(outside2, { recursive: true });
  writeFileSync(join(outside2, 'settings.json'), '{}');
  symlinkSync(outside2, join(dir2, '.claude'));
  const r2 = s.install(join(dir2, '.claude', 'settings.json'), '/some/path hook');
  ok('install refuses to write when the directory itself is a symlink', r2.ok === false);
  ok('install does not touch the symlinked directory\'s target', readFileSync(join(outside2, 'settings.json'), 'utf8') === '{}');

  // A hook belonging to a different tool that merely mentions "blastdoor" —
  // in a comment, or a differently-named tool — must survive install/uninstall.
  const other = join(dir, '.claude', 'other-settings.json');
  writeFileSync(other, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "not blastdoor, just mentions blastdoor in a string" && ./some-other-tool.sh' }] }] },
  }));
  s.install(other, '/abs/path/blastdoor.mjs hook');
  const written = JSON.parse(readFileSync(other, 'utf8'));
  ok('a hook that only mentions blastdoor in passing is not mistaken for blastdoor\'s own', written.hooks.PreToolUse.some((g) => g.hooks[0].command.includes('some-other-tool.sh')));
  ok('blastdoor\'s own hook was still added alongside it', written.hooks.PreToolUse.some((g) => g.hooks[0].command.includes('blastdoor.mjs')));
  s.uninstall(other);
  const afterUninstall = JSON.parse(readFileSync(other, 'utf8'));
  ok('uninstall removes only blastdoor\'s own hook, not the unrelated one sharing its group list', afterUninstall.hooks.PreToolUse.some((g) => g.hooks[0].command.includes('some-other-tool.sh')) && !JSON.stringify(afterUninstall).includes('blastdoor.mjs'));

  // \b alone isn't specific enough: a hyphen is a non-word character, so
  // \bblastdoor\b still matches inside an unrelated tool's own name. Four
  // rounds of narrowing the text-pattern check each found a new way past it
  // (M-0011); a fifth pass replaced it with the marker field below instead
  // of narrowing it again, so this now survives by construction rather than
  // by a regex holding up.
  const thirdParty = join(dir, '.claude', 'third-party.json');
  writeFileSync(thirdParty, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"/usr/bin/acme-blastdoor" hook || true' }] }] },
  }));
  s.install(thirdParty, '/abs/path/blastdoor.mjs hook');
  const withThirdParty = JSON.parse(readFileSync(thirdParty, 'utf8'));
  ok('a differently-named tool whose own name contains "blastdoor" is not mistaken for blastdoor\'s own', withThirdParty.hooks.PreToolUse.some((g) => g.hooks[0].command.includes('acme-blastdoor')));

  // Every hook entry() writes carries an explicit marker field now (M-0011,
  // fifth pass) — isOurs() checks that, not the command text.
  const own = withThirdParty.hooks.PreToolUse.find((g) => g.hooks[0].command.includes('blastdoor.mjs'));
  ok('blastdoor\'s own entry carries the marker field', own.hooks[0][s.MARKER] === true);

  // A pre-marker entry (from 0.1.0/0.1.1, or a hand-written command echoing
  // a blastdoor-looking string) is no longer recognised at all — a fifth
  // audit pass found the regex fallback that used to cover this reopened
  // the exact decoy problem the marker exists to close. Duplicating on
  // upgrade is the accepted cost, documented at entry()'s definition; a
  // second copy of the identical, always-safe hook is not itself a bug.
  const unmarked = join(dir, '.claude', 'pre-marker.json');
  writeFileSync(unmarked, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"/abs/path/blastdoor.mjs" hook || true' }] }] },
  }));
  s.install(unmarked, '/abs/path/blastdoor.mjs hook');
  const unmarkedWritten = JSON.parse(readFileSync(unmarked, 'utf8'));
  ok('a pre-marker entry is not recognised as blastdoor\'s own, and gets a second, marked entry alongside it', unmarkedWritten.hooks.PreToolUse.filter((g) => g.hooks[0].command.includes('blastdoor.mjs')).length === 2);
}

// --- the hook --------------------------------------------------------------

{
  const dir = repo();
  writeFileSync(join(dir, 'keep.txt'), 'edited but not committed\n');
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');

  const out = cli(dir, ['hook'], payload(dir, 'rm -rf src'));
  ok('the hook returns JSON so the message is actually seen', out.trim().startsWith('{') && JSON.parse(out).systemMessage.includes('blastdoor'));

  const refs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/blastdoor');
  ok('a destructive command produces a snapshot', refs.includes('refs/blastdoor/'));

  const id = refs.split('/').pop();
  const files = git(dir, 'ls-tree', '-r', '--name-only', `refs/blastdoor/${id}`).split('\n');
  ok('the snapshot holds uncommitted work', git(dir, 'show', `refs/blastdoor/${id}:keep.txt`) === 'edited but not committed');
  ok('the snapshot holds untracked files', files.includes('new.txt'));
  ok('the snapshot leaves gitignored files out', !files.includes('secret.env'));

  ok('the branch did not move', git(dir, 'log', '--oneline', '-1').includes('first'));
  ok('the index was not touched', git(dir, 'status', '--porcelain').includes('?? new.txt'));

  const quiet = cli(dir, ['hook'], payload(dir, 'ls -la'));
  ok('an ordinary command writes nothing and takes no snapshot', quiet.trim() === '');

  cli(dir, ['hook'], payload(dir, 'rm -rf other'));
  const count = git(dir, 'for-each-ref', 'refs/blastdoor').split('\n').filter(Boolean).length;
  ok('an identical tree is not snapshotted twice', count === 1);
}

// --- Write, Edit, MultiEdit snapshot unconditionally ------------------------

{
  const dir = repo();
  writeFileSync(join(dir, 'keep.txt'), 'about to be overwritten\n');

  const out = cli(dir, ['hook'], writePayload(dir, 'Write', join(dir, 'keep.txt')));
  ok('a Write call produces a snapshot', out.trim().startsWith('{') && JSON.parse(out).systemMessage.includes('blastdoor'));

  const refs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/blastdoor');
  ok('the snapshot is on a blastdoor ref', refs.includes('refs/blastdoor/'));
  const id = refs.split('/').pop();
  ok('the snapshot holds the pre-write content', git(dir, 'show', `refs/blastdoor/${id}:keep.txt`) === 'about to be overwritten');

  writeFileSync(join(dir, 'keep.txt'), 'overwritten\n');
  const editOut = cli(dir, ['hook'], writePayload(dir, 'Edit', join(dir, 'keep.txt')));
  ok('an Edit call produces a snapshot too', JSON.parse(editOut).systemMessage.includes('blastdoor'));

  writeFileSync(join(dir, 'keep.txt'), 'edited again\n');
  const multiOut = cli(dir, ['hook'], writePayload(dir, 'MultiEdit', join(dir, 'keep.txt')));
  ok('a MultiEdit call produces a snapshot too', JSON.parse(multiOut).systemMessage.includes('blastdoor'));

  const readOut = cli(dir, ['hook'], writePayload(dir, 'Read', join(dir, 'keep.txt')));
  ok('a Read call writes nothing and takes no snapshot', readOut.trim() === '');

  const patchOut = cli(dir, ['hook'], writePayload(dir, 'apply_patch', join(dir, 'keep.txt')));
  ok('Codex apply_patch produces a snapshot too', JSON.parse(patchOut).systemMessage.includes('blastdoor'));

  writeFileSync(join(dir, 'nb.ipynb'), '{"cells": []}\n');
  const notebookOut = cli(dir, ['hook'], writePayload(dir, 'NotebookEdit', join(dir, 'nb.ipynb')));
  ok('NotebookEdit produces a snapshot too, not just a wasted hook run', JSON.parse(notebookOut).systemMessage.includes('blastdoor'));

  const beforeTemp = readdirSync(tmpdir()).filter((f) => f.startsWith('blastdoor-')).length;
  cli(dir, ['hook'], writePayload(dir, 'Write', join(dir, 'keep.txt')));
  const afterTemp = readdirSync(tmpdir()).filter((f) => f.startsWith('blastdoor-')).length;
  ok('snapshot does not leak its throwaway index directory', afterTemp === beforeTemp);
}

// --- --target validation ----------------------------------------------------

{
  const dir = repo();
  let threw = false;
  try { cli(dir, ['install', '--target', 'bogus']); } catch { threw = true; }
  ok('install rejects an unrecognised --target', threw);

  threw = false;
  try { cli(dir, ['uninstall', '--target', 'bogus']); } catch { threw = true; }
  ok('uninstall rejects an unrecognised --target the same way install does', threw);
}

// --- install --target codex -------------------------------------------------

{
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), 'blastdoor-home-'));
  temps.push(home);
  const env = { HOME: home };

  const out = cli(dir, ['install', '--target', 'codex'], undefined, env);
  ok('install --target codex says it still needs trusting', out.includes('not armed yet') && out.includes('/hooks'));

  const codexPath = join(home, '.codex', 'hooks.json');
  ok('the hook goes to the user-level Codex hooks file', existsSync(codexPath));
  const written = JSON.parse(readFileSync(codexPath, 'utf8'));
  const group = written.hooks.PreToolUse.find((g) => JSON.stringify(g).includes('blastdoor'));
  ok('the Codex matcher covers Bash and apply_patch', group.matcher === 'Bash|apply_patch');

  cli(dir, ['install', '--target', 'codex'], undefined, env);
  const twice = JSON.parse(readFileSync(codexPath, 'utf8'));
  ok('installing twice does not duplicate the Codex hook', twice.hooks.PreToolUse.filter((g) => JSON.stringify(g).includes('blastdoor')).length === 1);

  cli(dir, ['uninstall', '--target', 'codex'], undefined, env);
  const gone = JSON.parse(readFileSync(codexPath, 'utf8'));
  ok('uninstall --target codex removes its hook', !JSON.stringify(gone).includes('blastdoor'));
}

// --- the hook never blocks -------------------------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'blastdoor-nogit-'));
  temps.push(dir);
  let threw = false;
  try { cli(dir, ['hook'], payload(dir, 'rm -rf x')); } catch { threw = true; }
  ok('outside a git repository the hook exits cleanly', !threw);

  const bad = repo();
  let threw2 = false;
  try { cli(bad, ['hook'], 'this is not json'); } catch { threw2 = true; }
  ok('a malformed payload never fails the tool call', !threw2);
}

// --- restore ---------------------------------------------------------------

{
  const dir = repo();
  writeFileSync(join(dir, 'keep.txt'), 'the good version\n');
  cli(dir, ['hook'], payload(dir, 'rm -rf src'));
  const id = git(dir, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/blastdoor').trim();

  writeFileSync(join(dir, 'keep.txt'), 'destroyed\n');
  writeFileSync(join(dir, 'written-after.txt'), 'made later\n');
  writeFileSync(join(dir, 'unrelated-staged.txt'), 'staged before restore, unrelated to it\n');
  git(dir, 'add', 'unrelated-staged.txt');

  const out = cli(dir, ['restore', id]);
  ok('restore puts the file contents back', readFileSync(join(dir, 'keep.txt'), 'utf8') === 'the good version\n');
  ok('restore does not delete a file made after the snapshot', existsSync(join(dir, 'written-after.txt')));
  ok('restore says which files it left alone', out.includes('written-after.txt'));
  ok('restore snapshots the state it is replacing', git(dir, 'for-each-ref', 'refs/blastdoor').split('\n').filter(Boolean).length === 2);
  // `git checkout <commit> -- .` stages what it touches; restore's own output
  // says the index wasn't touched, so it has to actually not be (M-0007).
  // --cached diffs against the index, so any output means something is staged.
  ok('restore leaves keep.txt off the index, matching its own claim', git(dir, 'diff', '--cached', '--name-only').split('\n').indexOf('keep.txt') === -1);
  ok('a file staged before restore, unrelated to it, is still staged after', git(dir, 'diff', '--cached', '--name-only').split('\n').includes('unrelated-staged.txt'));
}

// The harder case: a path that IS part of the snapshot already has its own,
// different staged version when restore runs — neither HEAD's content nor
// the snapshot's. `git checkout <commit> -- .` followed by `git reset` can
// only put the index back to HEAD, losing that staged version. Only
// `git restore --worktree` never touches the index at all, for any path
// (M-0007, second pass).
{
  const dir = repo();
  writeFileSync(join(dir, 'keep.txt'), 'the good version\n');
  cli(dir, ['hook'], payload(dir, 'rm -rf src'));
  const id = git(dir, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/blastdoor').trim();

  writeFileSync(join(dir, 'keep.txt'), 'staged before restore, neither HEAD nor the snapshot\n');
  git(dir, 'add', 'keep.txt');

  cli(dir, ['restore', id]);
  ok('restore updates the working tree even when the path was already staged', readFileSync(join(dir, 'keep.txt'), 'utf8') === 'the good version\n');
  ok('restore leaves that pre-existing staged version on the index, untouched', git(dir, 'show', ':keep.txt') === 'staged before restore, neither HEAD nor the snapshot');
}

// `git restore --worktree --source=<commit> -- .` was tried as the fix for
// the case above and introduced a worse bug: it treats "missing from the
// source commit" as "should not exist" and deletes it from the working tree
// — even a file the snapshot has never heard of, committed after the
// snapshot was taken. Only `read-tree` into a throwaway index +
// `checkout-index` writes exactly a commit's files and nothing else
// (M-0007, third pass).
{
  const dir = repo();
  cli(dir, ['hook'], payload(dir, 'rm -rf src'));
  const id = git(dir, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/blastdoor').trim();

  writeFileSync(join(dir, 'tracked-after.txt'), 'committed after the snapshot\n');
  git(dir, 'add', 'tracked-after.txt');
  git(dir, 'commit', '-qm', 'add tracked-after');

  cli(dir, ['restore', id]);
  ok('restore does not delete a tracked file the snapshot never knew about', existsSync(join(dir, 'tracked-after.txt')));
  ok('restore leaves that file\'s content exactly as it was', readFileSync(join(dir, 'tracked-after.txt'), 'utf8') === 'committed after the snapshot\n');
}

// `checkout-index --force` deletes whatever is in the way of a path it needs
// to write — recursively, if that's a directory — including content the
// snapshot never saw. Two directions, both real, both caught by a fourth
// audit pass and reproduced directly before trusting the fix (M-0007,
// fourth pass).
{
  const dir = repo();
  writeFileSync(join(dir, 'foo'), 'foo as a file\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'foo as a file');
  cli(dir, ['hook'], payload(dir, 'rm -rf src'));
  const id = git(dir, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/blastdoor').split('\n')[0].trim();

  // foo becomes a directory with real, never-snapshotted content in it
  rmSync(join(dir, 'foo'), { force: true });
  mkdirSync(join(dir, 'foo'));
  writeFileSync(join(dir, 'foo', 'bar.txt'), 'never snapshotted, must survive\n');

  cli(dir, ['restore', id]);
  ok('restore refuses instead of deleting a directory the snapshot never saw', existsSync(join(dir, 'foo', 'bar.txt')));
  ok('the content in that directory survives untouched', readFileSync(join(dir, 'foo', 'bar.txt'), 'utf8') === 'never snapshotted, must survive\n');
}

{
  const dir = repo();
  mkdirSync(join(dir, 'foo'));
  writeFileSync(join(dir, 'foo', 'bar.txt'), 'foo/bar.txt tracked in the snapshot\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'foo as a directory');
  cli(dir, ['hook'], payload(dir, 'rm -rf src'));
  const id = git(dir, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/blastdoor').split('\n')[0].trim();

  // foo becomes a plain file with real, never-snapshotted content
  rmSync(join(dir, 'foo'), { recursive: true, force: true });
  writeFileSync(join(dir, 'foo'), 'never snapshotted, must survive\n');

  cli(dir, ['restore', id]);
  ok('restore refuses instead of deleting a file the snapshot never saw', existsSync(join(dir, 'foo')) && !lstatSync(join(dir, 'foo')).isDirectory());
  ok('that file\'s content survives untouched', readFileSync(join(dir, 'foo'), 'utf8') === 'never snapshotted, must survive\n');
}

// --- git ref collisions ------------------------------------------------------

{
  const dir = repo();
  const { git: rawGit } = await import('../lib/git.mjs');
  // Force the id Date.now() would produce right now to already be taken, the
  // way two hook calls in the same millisecond would collide (M-0008).
  const claimed = String(Date.now());
  rawGit(['update-ref', `refs/blastdoor/${claimed}`, git(dir, 'rev-parse', 'HEAD')], { cwd: dir });
  writeFileSync(join(dir, 'keep.txt'), 'a real snapshot, not the placeholder\n');
  const out = cli(dir, ['hook'], payload(dir, 'rm -rf x'));
  const newId = JSON.parse(out).systemMessage.match(/restore (\d+)/)[1];
  ok('a colliding id is not reused', newId !== claimed);
  ok('the new snapshot holds the real tree, not the placeholder ref it collided with', git(dir, 'show', `refs/blastdoor/${newId}:keep.txt`) === 'a real snapshot, not the placeholder');
}

// --- install: the local (node_modules) case actually verifies -------------

{
  const dir = repo();
  const localBin = join(dir, 'node_modules', '.bin', 'blastdoor');
  mkdirSync(dirname(localBin), { recursive: true });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(BIN, localBin);

  // $CLAUDE_PROJECT_DIR is something Claude Code sets for hooks it runs
  // itself — not present in this test process's own environment. install has
  // to verify the 'local' command as if it were (M-0005), not fail because
  // this plain `node test/smoke.mjs` run doesn't have it either.
  const out = cli(dir, ['install']);
  ok('the local install case reports Armed, not Not armed', out.includes('Armed.') && !out.includes('Not armed'));
  const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  ok('the local command uses $CLAUDE_PROJECT_DIR, portable to every machine', JSON.stringify(written).includes('$CLAUDE_PROJECT_DIR'));
}

// --- install ---------------------------------------------------------------

{
  const dir = repo();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2));

  cli(dir, ['install']);
  const sharedFile = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  ok('an absolute path never lands in the shared settings file', !JSON.stringify(sharedFile).includes('blastdoor'));
  ok('the shared settings file is left exactly as it was', sharedFile.permissions.allow[0] === 'Bash(npm test)' && sharedFile.hooks.PreToolUse.length === 1);

  const localPath = join(dir, '.claude', 'settings.local.json');
  ok('the hook goes to the personal settings file instead', existsSync(localPath));
  const local = JSON.parse(readFileSync(localPath, 'utf8'));
  ok('install adds its own hook', local.hooks.PreToolUse.some((g) => JSON.stringify(g).includes('blastdoor')));

  cli(dir, ['install']);
  const twice = JSON.parse(readFileSync(localPath, 'utf8'));
  ok('installing twice does not duplicate the hook', twice.hooks.PreToolUse.filter((g) => JSON.stringify(g).includes('blastdoor')).length === 1);

  cli(dir, ['uninstall']);
  const gone = JSON.parse(readFileSync(localPath, 'utf8'));
  ok('uninstall removes its hook', !JSON.stringify(gone).includes('blastdoor'));
}

// --- install refuses to claim it is armed when it is not --------------------

{
  const dir = repo();
  cli(dir, ['install']);
  const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  const command = written.hooks.PreToolUse.find((g) => JSON.stringify(g).includes('blastdoor')).hooks[0].command;
  ok('the hook command is not a bare npx call', !/^npx\s/.test(command));
  ok('the hook command ends in a clause that cannot fail the tool call', command.trim().endsWith('|| true'));

  // The command the installer wrote must actually run, with no stdin.
  let ran = true;
  try {
    execFileSync('bash', ['-c', command], { cwd: dir, input: '', encoding: 'utf8' });
  } catch { ran = false; }
  ok('the command the installer wrote actually runs', ran);
}

for (const d of temps) rmSync(d, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
