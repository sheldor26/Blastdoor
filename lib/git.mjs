/**
 * Every git call this tool makes. Nothing else in the project shells out.
 *
 * Two rules hold everywhere here:
 *   - never touch the user's index or working tree while taking a snapshot
 *   - never depend on the user having configured a git identity
 * Both are the difference between a safety net and one more thing that broke.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const REF_PREFIX = 'refs/blastdoor';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'blastdoor',
  GIT_AUTHOR_EMAIL: 'blastdoor@localhost',
  GIT_COMMITTER_NAME: 'blastdoor',
  GIT_COMMITTER_EMAIL: 'blastdoor@localhost',
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

    const id = String(Date.now());
    const ref = tryGit(['update-ref', `${REF_PREFIX}/${id}`, commit.out], { cwd, env });
    if (!ref.ok) return { ok: false, error: ref.error };

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
