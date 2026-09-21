/**
 * Every git call this tool makes. Nothing else in the project shells out.
 *
 * Two rules hold everywhere here:
 *   - never touch the user's index or working tree while taking a snapshot
 *   - never depend on the user having configured a git identity
 * Both are the difference between a safety net and one more thing that broke.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

export const REF_PREFIX = 'refs/blastdoor';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'blastdoor',
  GIT_AUTHOR_EMAIL: 'blastdoor@localhost',
  GIT_COMMITTER_NAME: 'blastdoor',
  GIT_COMMITTER_EMAIL: 'blastdoor@localhost',
  // Some of this file's own error handling matches English text in git's
  // stderr (the ref-collision retry below, matching "reference already
  // exists"). Git translates its messages when built with gettext support
  // and a matching locale is installed — a real config on plenty of
  // machines, not a hypothetical — and an untranslated match against
  // translated text fails closed: the retry never fires, and a real error
  // gets treated as one. Forcing C here is what makes that match reliable
  // instead of it happening to work on whichever machine wrote the code.
  LC_ALL: 'C',
};

export function git(args, { cwd, env = {}, input } = {}) {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...IDENTITY, ...env },
  }).trim();
}

export function tryGit(args, opts) {
  try {
    return { ok: true, out: git(args, opts) };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || '').toString().trim() };
  }
}

export function repoRoot(cwd) {
  const r = tryGit(['rev-parse', '--show-toplevel'], { cwd });
  return r.ok ? r.out : null;
}

export function headCommit(cwd) {
  const r = tryGit(['rev-parse', 'HEAD'], { cwd });
  return r.ok ? r.out : null;
}

/** The all-zero object id `update-ref`'s atomic create-only form expects as
 * "this ref must not already exist" — 40 zeros for a sha1 repository, 64 for
 * the (rare, opt-in) sha256 kind. Defaults to sha1 if the check itself fails;
 * every repository blastdoor is likely to meet is sha1, and a wrong-length
 * zero hash only makes update-ref refuse, which is still safe (M-0008).
 */
function zeroHashFor(cwd) {
  const r = tryGit(['rev-parse', '--show-object-format'], { cwd });
  return r.ok && r.out.trim() === 'sha256' ? '0'.repeat(64) : '0'.repeat(40);
}

/**
 * Commit the entire working tree to a ref, without going near the user's index.
 *
 * GIT_INDEX_FILE points at a path that does not exist yet, so `git add` builds
 * a throwaway index there. The user's staged changes, and their working tree,
 * are never read or written. Returns null when the tree is identical to the
 * previous snapshot — there is no point keeping two of the same thing.
 */
export function snapshot(cwd, { message, forceInclude = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'blastdoor-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };

  try {
    const added = tryGit(['add', '-A'], { cwd, env });
    if (!added.ok) return { ok: false, error: added.error };

    for (const path of forceInclude) {
      tryGit(['add', '-f', '--', path], { cwd, env });
    }

    const tree = tryGit(['write-tree'], { cwd, env });
    if (!tree.ok) return { ok: false, error: tree.error };

    const previous = latest(cwd);
    if (previous && previous.tree === tree.out) {
      return { ok: true, unchanged: true, id: previous.id };
    }

    const head = headCommit(cwd);
    const args = ['commit-tree', tree.out, '-m', message];
    if (head) args.push('-p', head);

    const commit = tryGit(args, { cwd, env });
    if (!commit.ok) return { ok: false, error: commit.error };

    // Date.now() is millisecond resolution; update-ref overwrites without
    // complaint if the ref already exists. Two hook processes racing in the
    // same repo — parallel subagents, both editing files in the same
    // millisecond — used to silently collide, with the second snapshot's ref
    // replacing the first's and both callers believing theirs was saved
    // (M-0008). A "does it already exist" check before writing still has a
    // gap between the check and the write that two racing processes can both
    // slip through — an external audit's second pass caught that the first
    // fix only looked atomic. `update-ref <ref> <new> <zero-hash>` is git's
    // own atomic create-only form: it fails at the ref-locking level, inside
    // git itself, if the ref already exists — no gap a second process can
    // land in. Bump and retry on that failure, same as before.
    const zeroHash = zeroHashFor(cwd);
    let id = Date.now();
    let ref;
    for (;;) {
      ref = tryGit(['update-ref', `${REF_PREFIX}/${id}`, commit.out, zeroHash], { cwd, env });
      if (ref.ok) break;
      // "reference already exists" is the one failure worth retrying past —
      // it means another process (or this repeated call) won the race for
      // this exact id, not that something is actually broken. Anything else
      // (permissions, a locked .git, disk full) is a real error and retrying
      // it forever would just hang instead of reporting it.
      if (!/reference already exists/.test(ref.error)) return { ok: false, error: ref.error };
      id += 1;
    }
    id = String(id);

    return { ok: true, id, commit: commit.out, tree: tree.out };
  } finally {
    // The throwaway index lives only for this call. Leaving it behind piles
    // up an empty temp directory per snapshot — now most edits in a session,
    // not just the rare destructive Bash command.
    rmSync(dir, { recursive: true, force: true });
  }
}

export function list(cwd) {
  const r = tryGit(
    ['for-each-ref', '--sort=-refname', '--format=%(refname:strip=2)%09%(objectname)%09%(tree)%09%(subject)', REF_PREFIX],
    { cwd },
  );
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').map((line) => {
    const [id, commit, tree, subject] = line.split('\t');
    let meta = {};
    try { meta = JSON.parse(subject); } catch { meta = { reason: subject }; }
    return { id, commit, tree, meta, at: new Date(Number(id)) };
  });
}

export const latest = (cwd) => list(cwd)[0] || null;

export const find = (cwd, id) =>
  list(cwd).find((s) => s.id === id || s.commit.startsWith(id)) || null;

/** Paths that differ between a snapshot and the working tree right now. */
export function changedSince(cwd, commit) {
  const r = tryGit(['diff', '--name-status', commit], { cwd });
  return r.ok && r.out ? r.out.split('\n') : [];
}

export function filesIn(cwd, commit) {
  const r = tryGit(['ls-tree', '-r', '--name-only', commit], { cwd });
  return r.ok && r.out ? r.out.split('\n') : [];
}

/**
 * A path the snapshot wants to write to is blocked by a working-tree entry
 * of the wrong kind — the snapshot has a file at a path that is currently a
 * directory (or vice versa, for some ancestor of the path). `checkout-index
 * --force` resolves that by deleting whatever is in the way, recursively if
 * it is a directory — including content the snapshot never saw and has no
 * copy of. Checked before anything destructive runs, not caught after.
 */
function typeConflicts(cwd, files) {
  const isDir = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
  const isNonDir = (p) => { try { return !lstatSync(p).isDirectory(); } catch { return false; } };
  const conflicts = new Set();
  for (const f of files) {
    const full = join(cwd, f);
    if (isDir(full)) { conflicts.add(f); continue; }
    for (let d = dirname(full); d !== cwd && d.length > cwd.length; d = dirname(d)) {
      if (isNonDir(d)) { conflicts.add(f); break; }
    }
  }
  return [...conflicts];
}

/**
 * Write a commit's files into the working tree, without touching the index
 * or removing anything the commit doesn't mention.
 *
 * Two other approaches were tried and both failed under audit:
 * `git checkout <commit> -- .` stages what it touches (M-0007). Its
 * replacement, `git restore --worktree --source=<commit> -- .`, does not
 * touch the index, but ties the working tree to the *current index's* file
 * list — a file added and staged after the snapshot, which the snapshot
 * knows nothing about, gets deleted from disk because `restore` treats
 * "missing from the source" as "should not exist". Confirmed directly:
 * staged a new file, ran the command, watched it disappear.
 *
 * `read-tree` into a throwaway index (the same trick `snapshot()` uses,
 * never pointed at the real index) followed by `checkout-index` writes
 * exactly the commit's files to disk and nothing else — it has no concept
 * of files missing from the index it's reading, because that index only
 * ever contains what `read-tree` put there. It still has a sharp edge
 * `typeConflicts` exists to catch: `--force` deletes whatever is in the way
 * of a path it needs to write, including a whole directory of content the
 * snapshot has no copy of, if the snapshot's own path is a file where that
 * directory currently sits (or the reverse). Confirmed directly, both
 * directions: an un-snapshotted directory's real content, and an
 * un-snapshotted plain file, both silently deleted by a restore that never
 * should have touched either.
 *
 * `typeConflicts` and the `checkout-index` call below are still two separate
 * steps — the same shape of gap already accepted for the symlink check in
 * lib/settings.mjs (M-0010): something would have to change what's on disk
 * at one of the snapshot's own paths in the brief window between the check
 * and the write, in this one synchronous process, for the conflict this
 * function exists to catch to slip through anyway. Closing it fully would
 * need an atomic "check the whole tree shape, then write" primitive neither
 * git nor Node's fs module expose. Accepted as a known, narrow residual gap
 * rather than chased with a token re-check that wouldn't actually close it.
 */
export function restoreWorktree(cwd, commit) {
  const files = filesIn(cwd, commit);
  const conflicts = typeConflicts(cwd, files);
  if (conflicts.length) {
    return {
      ok: false,
      error: `restoring would have to delete a file or directory the snapshot never saw, to make room for its own path at: ${conflicts.join(', ')}. Nothing was touched — resolve the conflict by hand (rename or remove the thing in the way) and try again.`,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'blastdoor-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    const read = tryGit(['read-tree', commit], { cwd, env });
    if (!read.ok) return { ok: false, error: read.error };
    const co = tryGit(['checkout-index', '-a', '--force'], { cwd, env });
    if (!co.ok) return { ok: false, error: co.error };
    return { ok: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
