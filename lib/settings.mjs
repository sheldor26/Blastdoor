/**
 * Writing the hook into a PreToolUse hooks file — .claude/settings.json or
 * Codex's hooks.json — without trampling what is there.
 *
 * The file belongs to the project, not to this tool: it is read, the one entry
 * this tool owns is replaced, and everything else is written back untouched.
 * Both harnesses use the same { hooks: { PreToolUse: [...] } } shape, so one
 * read/install/uninstall serves both — only the matcher and the path differ.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
 */
export function entry(command, matcher = CLAUDE_MATCHER) {
  return {
    matcher,
    hooks: [{ type: 'command', command: `${command} || true`, timeout: 30 }],
  };
}

const isOurs = (group) =>
  Array.isArray(group && group.hooks) &&
  group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER));

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
  const { settings, existed, error } = read(path);
  if (settings === null) return { ok: false, error: `${path} is not valid JSON (${error}) — fix it first, it is your file` };

  settings.hooks = settings.hooks || {};
  const groups = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  const others = groups.filter((g) => !isOurs(g));
  settings.hooks.PreToolUse = [...others, entry(command, matcher)];

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, replaced: others.length !== groups.length, created: !existed, kept: others.length };
}

export function uninstall(path) {
  const { settings } = read(path);
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks.PreToolUse)) {
    return { ok: true, removed: 0 };
  }
  const before = settings.hooks.PreToolUse.length;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((g) => !isOurs(g));
  if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, removed: before - (settings.hooks?.PreToolUse?.length || 0) };
}
