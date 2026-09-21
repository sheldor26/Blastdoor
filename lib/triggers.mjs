/**
 * What counts as destructive.
 *
 * Scope is deliberately narrow: commands that destroy files in the working
 * tree. A dropped database table and a force-pushed branch are also disasters,
 * and a snapshot of the working tree does nothing for either, so they are not
 * here. Claiming otherwise would make the net feel wider than it is, which is
 * worse than a narrow net (DECISIONS.md D-0003).
 */

// Flags don't have to sit immediately after the command word — `rm dir -rf`
// and `git checkout HEAD -f` are both valid shells syntax and both real
// triggers. Patterns below allow whole tokens in between, but require the
// flag itself to be its own whitespace-delimited token (`\s+` right before
// it) so a path or branch name that merely ends in `-rf`/`-f` — a real
// token, just not a flag — doesn't match (M-0003).
export const BUILT_IN = [
  { name: 'rm -r', pattern: /\brm\b(?:\s+\S+)*?\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/ },
  { name: 'rm -f', pattern: /\brm\b(?:\s+\S+)*?\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)\b/ },
  { name: 'git reset --hard', pattern: /\bgit\s+reset\b[^&|;]*--hard\b/ },
  { name: 'git checkout over the working tree', pattern: /\bgit\s+checkout\b(?:\s+\S+)*?\s+(--\s+\.\s*$|\.\s*$|-[a-zA-Z]{0,3}f[a-zA-Z]{0,3}\b|--force\b)/ },
  { name: 'git restore over the working tree', pattern: /\bgit\s+restore\b[^&|;]*(\s\.\s*$|--worktree\b|--staged\b[^&|;]*\s\.\s*$)/ },
  { name: 'git clean', pattern: /\bgit\s+clean\b[^&|;]*-[a-zA-Z]*[fdx]/ },
  { name: 'git stash drop or clear', pattern: /\bgit\s+stash\s+(drop|clear)\b/ },
  { name: 'git branch -D', pattern: /\bgit\s+branch\s+(-D\b|-d\s+-f\b|--delete\s+--force\b)/ },
  { name: 'find -delete', pattern: /\bfind\b[^&|;]*\s(-delete\b|-exec\s+rm\b)/ },
  { name: 'xargs rm', pattern: /\|\s*xargs\s+(-\S+\s+)*rm\b/ },
  { name: 'truncate', pattern: /\btruncate\s+(-s|--size)\s*0\b/ },
  { name: 'shred', pattern: /\bshred\b/ },
  { name: 'mv onto an existing path with force', pattern: /\bmv\b(?:\s+\S+)*?\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)\b/ },
];

/**
 * The first trigger a command matches, or null.
 *
 * Every clause of a compound command is tested on its own, because
 * `npm test && rm -rf dist` is as destructive as `rm -rf dist`.
 */
export function match(command, extra = []) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const triggers = [...BUILT_IN, ...extra.map(compile).filter(Boolean)];
  for (const clause of command.split(/&&|\|\||;|\n/)) {
    for (const trigger of triggers) {
      if (trigger.pattern.test(clause)) {
        return { name: trigger.name, clause: clause.trim() };
      }
    }
  }
  return null;
}

function compile(entry) {
  try {
    if (typeof entry === 'string') return { name: entry, pattern: new RegExp(entry) };
    if (entry && entry.pattern) return { name: entry.name || entry.pattern, pattern: new RegExp(entry.pattern) };
  } catch {
    return null;
  }
  return null;
}
