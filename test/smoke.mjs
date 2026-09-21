/**
 * End to end, in throwaway git repositories. No framework.
 *
 * The hook is exercised the way Claude Code exercises it: a payload on stdin,
 * and the only things that matter are the exit code and what ends up on disk.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
ok('an ordinary command does not fire', match('ls -la') === null);
ok('the word rm in prose does not fire', match('echo "rm is a word"') === null);
ok('git push --force does not fire, it is out of scope', match('git push --force') === null);
ok('an extra trigger from config is honoured', Boolean(match('dropdb app', ['dropdb'])));

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

  const out = cli(dir, ['restore', id]);
  ok('restore puts the file contents back', readFileSync(join(dir, 'keep.txt'), 'utf8') === 'the good version\n');
  ok('restore does not delete a file made after the snapshot', existsSync(join(dir, 'written-after.txt')));
  ok('restore says which files it left alone', out.includes('written-after.txt'));
  ok('restore snapshots the state it is replacing', git(dir, 'for-each-ref', 'refs/blastdoor').split('\n').filter(Boolean).length === 2);
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
