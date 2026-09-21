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
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const config = { ...DEFAULTS, ...parsed, path };
    // Valid JSON with the wrong shape — {"triggers": null} — used to crash
    // deep inside match()/snapshot() instead of here. The hook's outer
    // try/catch still keeps that from failing the tool call (D-0002), but it
    // silently stopped snapshotting anything for the rest of the session,
    // with the only trace being a line in .blastdoor/errors.log.
    if (!Array.isArray(config.triggers) || !Array.isArray(config.forceInclude)) {
      return { ...DEFAULTS, path, invalid: true };
    }
    return config;
  } catch {
    return { ...DEFAULTS, path, invalid: true };
  }
}
