#!/usr/bin/env node
/**
 * blastdoor — a snapshot of the working tree, taken the moment before an agent
 * runs something destructive, and a way back.
 *
 * Zero dependencies. The hook never blocks and never fails a tool call.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, lstatSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import * as G from '../lib/git.mjs';
import { match } from '../lib/triggers.mjs';
import * as settings from '../lib/settings.mjs';
import { load as loadConfig } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'help';
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, fallback) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i === -1) return fallback;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c) => (s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const b = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);

// process.cwd() throws ENOENT if the directory it would return no longer
// exists — plausible here specifically, since a hook runs right before a
// command that might delete directories. Computed at module load, before
// hook()'s own try/catch exists, so an uncaught throw here would kill the
// whole process and fail the tool call it was invoked for — the one thing
// D-0002 says never happens (M-0004). payload.cwd, read once stdin arrives,
// is what hook() actually uses; this is only the fallback for everything
// else (requireRepo(), the error-log path).
let CWD;
try { CWD = process.cwd(); } catch { CWD = process.env.PWD || '.'; }

function requireRepo() {
  const root = G.repoRoot(CWD);
  if (!root) {
    console.error(`${red('blastdoor needs a git repository.')}`);
    console.error(dim('A snapshot here is a git commit that never touches your branch, your index or'));
    console.error(dim('your working tree. Outside a repository there is nothing to write it to.'));
    process.exit(1);
  }
  return root;
}

const ago = (date) => {
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// ------------------------------------------------------------------ hook

// Every non-Bash tool name either matcher covers — Write, Edit, MultiEdit,
// NotebookEdit (Claude Code) and apply_patch (Codex) — has no shell command
// to match a trigger against, and the overwrite itself is the risk
// (STATE.md: "an agent overwriting a file it misread is the more common
// disaster"), so every call snapshots first. Derived from the matchers
// themselves so this set can't drift from what the installed hook actually
// fires on.
const WRITE_TOOLS = new Set(
  [...settings.CLAUDE_MATCHER.split('|'), ...settings.CODEX_MATCHER.split('|')].filter((t) => t !== 'Bash'),
);

/**
 * Invoked before a Bash, Write, Edit, MultiEdit, NotebookEdit or apply_patch
 * tool call. Reads the hook payload on stdin and always exits 0: a safety net
 * that can fail someone's command is not a safety net (DECISIONS.md D-0002).
 */
async function hook() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    const cwd = payload.cwd || CWD;
    const root = G.repoRoot(cwd);
    if (!root) return;

    const config = loadConfig(root);
    const toolName = payload.tool_name;
    const hit = toolName === 'Bash'
      ? match(payload.tool_input && payload.tool_input.command, config.triggers)
      : WRITE_TOOLS.has(toolName)
        ? { name: toolName, clause: String((payload.tool_input && payload.tool_input.file_path) || '') }
        : null;
    if (!hit) return;

    const result = G.snapshot(root, {
      message: JSON.stringify({
        reason: hit.name,
        clause: hit.clause.slice(0, 300),
        session: payload.session_id || null,
      }),
      forceInclude: config.forceInclude,
    });

    if (!result.ok) return;
    const label = result.unchanged ? 'already had a snapshot of this exact tree' : `snapshot ${result.id}`;
    // PreToolUse writes plain stdout to the debug log, so the message has to
    // travel as JSON to be seen at all.
    process.stdout.write(JSON.stringify({
      systemMessage: `blastdoor: ${label} before "${hit.name}". Restore with: npx blastdoor restore ${result.id}`,
    }));
  } catch (err) {
    try {
      const root = G.repoRoot(CWD);
      if (root) {
        const dotBlastdoor = join(root, '.blastdoor');
        const log = join(dotBlastdoor, 'errors.log');
        // A malicious repository could plant this path as a symlink, or plant
        // .blastdoor itself as a symlinked directory — appendFileSync follows
        // symlinks like every other fs write either way, so check both (same
        // reasoning, and the same two-level check, as lib/settings.mjs's
        // writesThroughSymlink).
        const isSymlink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
        if (!isSymlink(log) && !isSymlink(dotBlastdoor)) {
          mkdirSync(dotBlastdoor, { recursive: true });
          appendFileSync(log, `${new Date().toISOString()} ${err.stack}\n`);
        }
      }
    } catch { /* a logging failure must not fail the tool call either */ }
  }
}

// --------------------------------------------------------------- commands

/**
 * How the hook will invoke this tool, and proof that the invocation works.
 *
 * Preference order: the project's own node_modules, then the absolute path of
 * whatever is running right now. An npx cache path is accepted but reported,
 * because that directory is temporary and the hook dies with it.
 */
// `"${path}"` only stays one shell token if `path` has no double quote,
// backtick, `$` or backslash — any of those breaks out of the quotes when a
// shell (execSync here, or Claude Code/Codex's own hook runner every time
// the hook fires afterward) interprets the written command. Neither
// process.execPath nor an npm install location is attacker-controlled in the
// usual sense, but a pathological one — someone's own project cloned into a
// directory named with one of these — would otherwise turn into standing
// code execution baked into .claude/settings.json (M-0009). Refuse instead.
const SHELL_UNSAFE = /["$`\\]/;
const unsafePath = (...paths) => paths.find((p) => SHELL_UNSAFE.test(p));

function resolveCommand(root) {
  const local = join(root, 'node_modules', '.bin', 'blastdoor');
  if (existsSync(local)) {
    return { command: '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/blastdoor hook', kind: 'local' };
  }
  const self = join(HERE, 'blastdoor.mjs');
  const bad = unsafePath(process.execPath, self);
  if (bad) return { command: null, kind: 'unsafe-path', unsafe: bad };
  const command = `"${process.execPath}" "${self}" hook`;
  return { command, kind: /[\\/]_npx[\\/]/.test(self) ? 'npx-cache' : 'absolute' };
}

// $CLAUDE_PROJECT_DIR in the 'local' command is set by Claude Code itself for
// every hook it runs — never by a plain shell. Without it here, verify()
// tries to run "/node_modules/.bin/blastdoor" (empty-string expansion) and
// always fails, reporting "Not armed" for a hook that works fine inside
// Claude Code (M-0005). Passing it in only for this check reproduces what
// Claude Code actually provides at runtime, without writing it into the
// command itself — a fixed value there would stop working the moment the
// project moved.
function verify(command, root, env = {}) {
  try {
    execSync(`${command} < /dev/null`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, env: { ...process.env, ...env } });
    return true;
  } catch {
    return false;
  }
}

/**
 * `--target` is validated in one place so `install` and `uninstall` reject the
 * same typos the same way — nothing but a silent fallback to the Claude path
 * used to happen on `uninstall --target codexx`.
 */
function resolveTarget() {
  const target = opt('target', 'claude');
  if (target !== 'claude' && target !== 'codex') {
    console.error(`${red('!')} unknown --target ${target} — use claude or codex`);
    process.exit(1);
  }
  return target;
}

/** The "created / replaced / kept N" note, from what `settings.install` reports. */
function describeInstall(r) {
  return r.created
    ? 'created'
    : r.replaced
      ? 'blastdoor hook updated, everything else kept'
      : `blastdoor hook added, ${r.kept} other PreToolUse ${r.kept === 1 ? 'hook' : 'hooks'} kept`;
}

function printInstalled(displayPath, r) {
  console.log('');
  console.log(`${green('+')} ${displayPath} ${dim(describeInstall(r))}`);
  console.log('');
}

/** `adviceLines` differ per target because the fix for a failed `verify()` differs. */
function printNotArmed(command, adviceLines) {
  console.log(`${red('Not armed.')} The hook is written, but running it right now failed:`);
  console.log(dim(`  ${command}`));
  for (const line of adviceLines) console.log(line);
  console.log('');
  process.exit(1);
}

function doInstall() {
  if (resolveTarget() === 'codex') return doInstallCodex();

  const root = requireRepo();
  const resolved = resolveCommand(root);
  if (resolved.kind === 'unsafe-path') {
    console.error(`${red('!')} ${resolved.unsafe} contains a character (", \`, $ or \\) that would`);
    console.error('break out of the quotes the hook command is wrapped in. Move the install');
    console.error('somewhere without one and try again — nothing was written.');
    process.exit(1);
  }
  // A command only belongs in the shared settings file when it will work for
  // everyone who clones the repository. An absolute path on this machine is
  // personal configuration, so it goes in the personal file (M-0001).
  const shared = resolved.kind === 'local';
  const path = join(root, '.claude', shared ? 'settings.json' : 'settings.local.json');
  const r = settings.install(path, resolved.command);
  if (!r.ok) {
    console.error(`${red('!')} ${r.error}`);
    process.exit(1);
  }

  printInstalled(relative(root, path) || path, r);

  if (!verify(resolved.command, root, resolved.kind === 'local' ? { CLAUDE_PROJECT_DIR: root } : {})) {
    printNotArmed(resolved.command, [
      'A hook pointing at something that will not run is worse than no hook — it',
      'looks armed. Install blastdoor into the project and run this again:',
      b('  npm install --save-dev blastdoor && npx blastdoor install'),
    ]);
  }

  if (!shared) {
    console.log(dim('Written to settings.local.json, not settings.json: the command is an absolute'));
    console.log(dim('path on this machine, and the shared file is for hooks that work for everyone.'));
    console.log(dim('Run `npm install --save-dev blastdoor` first if you want it committed.'));
    console.log('');
  }

  if (resolved.kind === 'npx-cache') {
    console.log(`${yellow('Armed, from a temporary npx directory.')} That path gets cleared eventually,`);
    console.log('and the day it does this hook stops saving anything without telling you. Run');
    console.log(`${b('npm install --save-dev blastdoor && npx blastdoor install')} to make it permanent.`);
  } else {
    console.log(`${b('Armed.')} Before the agent runs anything that deletes files, the working tree`);
    console.log('is committed to a ref under refs/blastdoor. Your branch, your index and your');
    console.log('working tree are never touched.');
  }

  console.log('');
  console.log(dim('  npx blastdoor list            what has been saved'));
  console.log(dim('  npx blastdoor restore <id>    put it back'));
  console.log('');
  console.log(`${yellow('One thing to know:')} a snapshot holds what git can see. Files in .gitignore —`);
  console.log(`.env above all — are not in it. Name them in blastdoor.config.json under`);
  console.log(`${b('forceInclude')} if you want them captured, knowing they land in git objects.`);
  console.log('');
}

/**
 * Codex requires every hook to be reviewed and trusted by hand, in its own
 * TUI, before it runs — there is no flag or config setting that pre-approves
 * one (DECISIONS.md). `install` cannot verify this the way it does for Claude
 * Code, so it does not claim to: it writes the hook and says plainly what is
 * still missing.
 *
 * The hook goes to `~/.codex/hooks.json`, not a repo-level one. Codex has no
 * equivalent of `$CLAUDE_PROJECT_DIR`, so a relative, portable command is not
 * possible here (M-0001) — an absolute path is personal configuration, and
 * the user-level file is where that belongs. One install protects every repo
 * opened with Codex, not just this one.
 */
function doInstallCodex() {
  // Not resolveCommand(root): its 'local' branch writes a $CLAUDE_PROJECT_DIR
  // reference that only Claude Code sets, and this hook has no project root
  // to prefer a local install against anyway — the file it writes to is
  // ~/.codex/hooks.json, not anything under this repo.
  const self = join(HERE, 'blastdoor.mjs');
  const bad = unsafePath(process.execPath, self);
  if (bad) {
    console.error(`${red('!')} ${bad} contains a character (", \`, $ or \\) that would break out`);
    console.error('of the quotes the hook command is wrapped in. Move the install somewhere');
    console.error('without one and try again — nothing was written.');
    process.exit(1);
  }
  const command = `"${process.execPath}" "${self}" hook`;
  const path = join(homedir(), '.codex', 'hooks.json');
  const r = settings.install(path, command, settings.CODEX_MATCHER);
  if (!r.ok) {
    console.error(`${red('!')} ${r.error}`);
    process.exit(1);
  }

  printInstalled(path, r);

  if (!verify(command, CWD)) {
    // Unlike the Claude Code path, this command is never a project-relative
    // node_modules path — it's always this exact script's own absolute path,
    // so "install blastdoor as a dependency and retry" cannot change the
    // outcome. Only Node or this file being broken can make verify() fail.
    printNotArmed(command, [
      'That command is this script\'s own path — Node has to be able to run it as-is.',
      `Confirm ${process.execPath} works and that the file above still exists, then`,
      'run this again.',
    ]);
  }

  console.log(`${yellow('Written, but not armed yet.')} Codex will not run a hook it has not reviewed —`);
  console.log('that review has to happen in Codex itself, once:');
  console.log('');
  console.log(b('  codex'));
  console.log(dim('  then run /hooks, find blastdoor, and trust it'));
  console.log('');
  console.log('Until you do, Codex skips the hook silently: nothing is blocked, but nothing');
  console.log('is snapshotted either, and nothing tells you that. This protects every repo');
  console.log('you open with Codex, not just this one, so it only needs doing once.');
  console.log('');
}

function doUninstall() {
  let paths;
  if (resolveTarget() === 'codex') {
    paths = [join(homedir(), '.codex', 'hooks.json')];
  } else {
    const root = requireRepo();
    paths = ['settings.json', 'settings.local.json'].map((n) => join(root, '.claude', n));
  }

  let removed = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const r = settings.uninstall(path);
    if (!r.ok) {
      console.error(`${red('!')} ${r.error}`);
      process.exit(1);
    }
    removed += r.removed;
  }
  console.log(removed ? `${green('-')} hook removed. Snapshots already taken are still there.` : 'no blastdoor hook was installed');
}

function doList() {
  requireRepo();
  const root = G.repoRoot(CWD);
  const all = G.list(root);
  if (!all.length) {
    console.log('\nNo snapshots yet.\n');
    console.log(dim('They are taken automatically before a destructive command once you run'));
    console.log(dim('`blastdoor install`, or by hand with `blastdoor snapshot`.\n'));
    return;
  }
  console.log('');
  for (const s of all) {
    console.log(`${b(s.id)}  ${dim(ago(s.at).padStart(8))}  ${s.meta.reason || 'manual'}`);
    if (s.meta.clause) console.log(`${' '.repeat(15)}${dim(s.meta.clause)}`);
  }
  console.log('');
  console.log(dim(`  ${all.length} snapshot${all.length === 1 ? '' : 's'}. npx blastdoor restore <id>, or diff <id> to look first.\n`));
}

function doDiff() {
  const root = requireRepo();
  const id = argv.filter((a) => !a.startsWith('-'))[1];
  const snap = id ? G.find(root, id) : G.latest(root);
  if (!snap) return console.error(`${red('!')} no such snapshot`);
  const r = G.tryGit(['diff', '--stat', snap.commit], { cwd: root });
  console.log('');
  console.log(r.ok && r.out ? r.out : dim('nothing has changed since that snapshot'));
  console.log('');
}

function doSnapshot() {
  const root = requireRepo();
  const config = loadConfig(root);
  const r = G.snapshot(root, {
    message: JSON.stringify({ reason: opt('message', 'manual') }),
    forceInclude: config.forceInclude,
  });
  if (!r.ok) return console.error(`${red('!')} ${r.error}`);
  console.log(r.unchanged ? dim(`nothing has changed since snapshot ${r.id}`) : `${green('+')} snapshot ${b(r.id)}`);
}

function doRestore() {
  const root = requireRepo();
  const id = argv.filter((a) => !a.startsWith('-'))[1];
  const snap = id ? G.find(root, id) : null;
  if (!snap) {
    console.error(`${red('!')} give me a snapshot id — \`npx blastdoor list\` has them`);
    process.exit(1);
  }

  const into = opt('into', null);
  if (into) {
    mkdirSync(into, { recursive: true });
    const tar = G.tryGit(['archive', snap.commit, '-o', join(into, 'blastdoor.tar')], { cwd: root });
    if (!tar.ok) return console.error(`${red('!')} ${tar.error}`);
    console.log(`${green('+')} ${join(into, 'blastdoor.tar')} ${dim('— extract it wherever you want; nothing here was touched')}`);
    return;
  }

  // Never restore without a way back from the restore itself — and that
  // means never restoring at all if this snapshot didn't actually happen
  // (M-0006). The old code took this comment's promise and then ignored
  // `before.ok`, running the destructive checkout regardless.
  const before = G.snapshot(root, { message: JSON.stringify({ reason: `before restoring ${snap.id}` }), forceInclude: loadConfig(root).forceInclude });
  if (!before.ok) {
    console.error(`${red('!')} could not snapshot the current state before restoring, so nothing was touched: ${before.error}`);
    process.exit(1);
  }

  // See G.restoreWorktree's own comment for the two approaches tried before
  // this one and what was wrong with each (M-0007) — in short: `checkout`
  // stages what it touches, and its replacement, `git restore --worktree`,
  // deletes files the snapshot doesn't know about instead of leaving them.
  const out = G.restoreWorktree(root, snap.commit);
  if (!out.ok) return console.error(`${red('!')} ${out.error}`);

  // It does not remove files that exist now and did not exist then, and this
  // tool will not remove them either — it says which they are.
  const known = new Set(G.filesIn(root, snap.commit));
  const nowR = G.tryGit(['ls-files', '--others', '--cached', '--exclude-standard'], { cwd: root });
  const extra = (nowR.ok && nowR.out ? nowR.out.split('\n') : []).filter((f) => f && !known.has(f));

  console.log('');
  console.log(`${green('restored')} the contents of snapshot ${b(snap.id)} ${dim(ago(snap.at))}`);
  if (before.ok && !before.unchanged) {
    console.log(dim(`the state you had a second ago is snapshot ${before.id} — restore that to undo this`));
  }
  if (extra.length) {
    console.log('');
    console.log(`${yellow(`${extra.length} file${extra.length === 1 ? '' : 's'} exist now and did not exist in that snapshot.`)}`);
    console.log(dim('They were left exactly where they are. blastdoor does not delete your files:'));
    for (const f of extra.slice(0, 20)) console.log(dim(`  ${f}`));
    if (extra.length > 20) console.log(dim(`  … and ${extra.length - 20} more`));
  }
  console.log('');
  console.log(dim('Your index and your current branch were not touched.'));
  console.log('');
}

function doPrune() {
  const root = requireRepo();
  const keep = Number(opt('keep', loadConfig(root).keep)) || 50;
  const all = G.list(root);
  const drop = all.slice(keep);
  for (const s of drop) G.tryGit(['update-ref', '-d', `${G.REF_PREFIX}/${s.id}`], { cwd: root });
  console.log(drop.length ? `${green('-')} ${drop.length} snapshot${drop.length === 1 ? '' : 's'} dropped, ${Math.min(all.length, keep)} kept` : dim(`nothing to prune (${all.length} kept, limit ${keep})`));
}

function help() {
  console.log(`blastdoor — the working tree, saved the moment before an agent destroys it

  npx blastdoor install          arm the hook in this repository, for Claude Code
  npx blastdoor install --target codex
                                 write the hook for Codex CLI — still needs
                                 trusting once, inside Codex itself (see output)
  npx blastdoor list             every snapshot, newest first
  npx blastdoor diff [id]        what changed since a snapshot
  npx blastdoor restore <id>     put those file contents back
  npx blastdoor restore <id> --into <dir>
                                 write it to a tar file instead, touching nothing
  npx blastdoor snapshot         take one by hand
  npx blastdoor prune --keep 50  drop the oldest
  npx blastdoor uninstall        remove the hook, keep the snapshots
  npx blastdoor uninstall --target codex

A snapshot is a git commit on a ref under refs/blastdoor. It is not on your
branch, it does not move HEAD, and it never touches your index or working
tree. It contains what git can see: files in .gitignore are not in it.
`);
}

const run = {
  hook,
  install: doInstall,
  uninstall: doUninstall,
  list: doList,
  ls: doList,
  diff: doDiff,
  show: doDiff,
  snapshot: doSnapshot,
  save: doSnapshot,
  restore: doRestore,
  prune: doPrune,
  help,
}[cmd] || help;

if (flag('version') || flag('v')) {
  console.log(JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version);
} else {
  await run();
}
