/**
 * Writing the hook into a PreToolUse hooks file — .claude/settings.json or
 * Codex's hooks.json — without trampling what is there.
 *
 * The file belongs to the project, not to this tool: it is read, the one entry
 * this tool owns is replaced, and everything else is written back untouched.
 * Both harnesses use the same { hooks: { PreToolUse: [...] } } shape, so one
 * read/install/uninstall serves both — only the matcher and the path differ.
 */

import { readFileSync, existsSync, mkdirSync, lstatSync, openSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';

export const MARKER = 'blastdoor';
// NotebookEdit is a distinct tool name from Edit in Claude Code — Claude Code
// matches this pattern as an unanchored regex against tool_name, so leaving
// NotebookEdit out would still make the hook fire on it (it contains "Edit")
// while nothing recognised the tool name and no snapshot was taken. Listed
// explicitly so the two agree.
export const CLAUDE_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit';
// Codex reports every file edit as tool_name "apply_patch", regardless of
// what the model called it — see DECISIONS.md.
export const CODEX_MATCHER = 'Bash|apply_patch';

/**
 * The command the hook runs.
 *
 * `npx blastdoor` is not written here on purpose. A hook pointing at a package
 * that is not installed fails silently on every call, and the repository looks
 * armed while nothing is being saved — which is the exact failure this whole
 * tool exists to prevent. The path is resolved at install time and verified
 * before install claims anything.
 *
 * The `[MARKER]: true` field is not part of any schema Claude Code or Codex
 * define — it rides along as an extra property on the hook object, there so
 * `isOurs()` can recognise this exact entry with certainty instead of
 * guessing from the command string. Four rounds of external audit found four
 * different real ways to fool a text-pattern guess (a hyphen, a Windows path
 * separator, a decoy string quoting a path that looks like blastdoor's own,
 * a JSON-embedded backslash), and a fifth pass found that a *legacy* regex
 * fallback for pre-marker installs (kept so upgrading from 0.1.0/0.1.1
 * wouldn't duplicate the hook) reopened the exact same decoy problem for
 * every hook that didn't yet carry the marker — which was every hook, since
 * nothing had ever shipped the field before that pass. There is no version
 * of this regex that has survived an audit pass yet, so this one is gone
 * rather than narrowed a fifth time (M-0011). The cost is real and accepted:
 * re-running install after upgrading from 0.1.0/0.1.1, before this field
 * existed, adds a second entry instead of replacing the first — harmless
 * (both run the identical safe hook; `snapshot()` already dedupes identical
 * trees) but not silent. Both harnesses parse hook objects permissively
 * (already true of `timeoutSec`-vs-`timeout` and `statusMessage` across the
 * two schemas), so an unrecognised property is expected to be ignored, not
 * rejected.
 */
export function entry(command, matcher = CLAUDE_MATCHER) {
  return {
    matcher,
    hooks: [{ type: 'command', command: `${command} || true`, timeout: 30, [MARKER]: true }],
  };
}

const isOurs = (group) =>
  Array.isArray(group && group.hooks) &&
  group.hooks.some((h) => h && h[MARKER] === true);

// .claude/settings.json and ~/.codex/hooks.json live wherever the project or
// the user put them — a malicious repository could plant one as a symlink to
// any other writable file (~/.bashrc, an SSH config, anything), and Node's
// fs functions follow symlinks by default. Checking only the file itself
// isn't enough either: a repository can just as easily commit `.claude`
// *itself* as a symlinked directory, in which case the leaf path
// (`.claude/settings.json`) is an ordinary file — sitting wherever `.claude`
// actually points. Caught the same way M-0011's second pass was: an external
// audit found the gap, reproduced it (a symlinked `.claude/` really does
// redirect a write outside the repo), and this checks the one directory
// level blastdoor itself controls — `.claude` or `~/.codex` — not every
// ancestor, which would also flag unrelated, legitimate symlinks a system or
// a user's own setup might have elsewhere in the path (M-0010).
const isSymlink = (path) => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};
const writesThroughSymlink = (path) => isSymlink(path) || isSymlink(dirname(path));

// The check above and the write below are still two separate calls — a
// third audit pass called that a TOCTOU gap in its own right, correctly: a
// symlink swapped in between them would still get followed. O_NOFOLLOW closes
// that specific gap for the file itself atomically on POSIX — the open()
// syscall fails with ELOOP if the final path component is a symlink at the
// moment of opening, not at the moment of checking. It cannot do the same
// for the *directory* becoming a symlink mid-flight; Node has no portable
// openat()-style relative open to make that atomic too. What's left there is
// a narrower race than before — a second process changing the filesystem in
// the exact gap between two synchronous calls in this one — not the
// original "was ever a symlink at any point before this ran". Node does not
// define O_NOFOLLOW on Windows at all (the `|| 0` below is why this still
// runs there, not a no-op fallback with the same effect) — on Windows this
// function is exactly as protective as the lstat-then-write check it
// replaced, no more, since the OS gives Node nothing more atomic to ask for.
function writeNoFollow(path, content) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = openSync(path, flags, 0o644);
  } catch (err) {
    throw err.code === 'ELOOP' ? new Error(`${path} became a symlink while writing — refusing to write through it`) : err;
  }
  try {
    // writeSync can perform a short write — POSIX allows write() to return
    // fewer bytes than asked for, and Node's own writeFileSync loops for
    // exactly this reason. This didn't, the first time it was written: a
    // fourth audit pass caught that a short write here would leave a
    // silently truncated JSON file with install still reporting success.
    const buf = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written);
  } finally {
    closeSync(fd);
  }
}

export function read(path) {
  if (!existsSync(path)) return { settings: {}, existed: false };
  const text = readFileSync(path, 'utf8');
  try {
    return { settings: JSON.parse(text), existed: true };
  } catch (err) {
    return { settings: null, existed: true, error: err.message };
  }
}

export function install(path, command, matcher = CLAUDE_MATCHER) {
  if (writesThroughSymlink(path)) return { ok: false, error: `${path} (or its directory) is a symlink — refusing to write through it to whatever it points at` };

  const { settings, existed, error } = read(path);
  if (settings === null) return { ok: false, error: `${path} is not valid JSON (${error}) — fix it first, it is your file` };

  settings.hooks = settings.hooks || {};
  const groups = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  const others = groups.filter((g) => !isOurs(g));
  settings.hooks.PreToolUse = [...others, entry(command, matcher)];

  mkdirSync(dirname(path), { recursive: true });
  try {
    writeNoFollow(path, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, replaced: others.length !== groups.length, created: !existed, kept: others.length };
}

export function uninstall(path) {
  if (writesThroughSymlink(path)) return { ok: false, error: `${path} (or its directory) is a symlink — refusing to write through it to whatever it points at`, removed: 0 };

  const { settings } = read(path);
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks.PreToolUse)) {
    return { ok: true, removed: 0 };
  }
  const before = settings.hooks.PreToolUse.length;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((g) => !isOurs(g));
  if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  try {
    writeNoFollow(path, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    return { ok: false, error: err.message, removed: 0 };
  }
  return { ok: true, removed: before - (settings.hooks?.PreToolUse?.length || 0) };
}
