import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  // Files git ignores are not in a snapshot. Anything listed here is added by
  // force anyway. Empty on purpose: writing .env into git objects is a real
  // decision, so it is made by the person whose secrets they are.
  forceInclude: [],
  // Extra regular expressions, as strings, matched against each clause.
  triggers: [],
  // Snapshots kept by `prune`.
  keep: 50,
};

export function load(root) {
  const path = join(root, 'blastdoor.config.json');
  if (!existsSync(path)) return { ...DEFAULTS, path: null };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')), path };
  } catch {
    return { ...DEFAULTS, path, invalid: true };
  }
}
