// Detects whether a module is the Node entry point, including npm link shims on Windows.
// Compares real paths so argv[1] and import.meta.url may differ when one is a symlink.
// Must not run commands or read campaign data.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @param {string} moduleUrl import.meta.url */
export function invokedDirectly(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const loaded = realpathSync(fileURLToPath(moduleUrl));
    const invoked = realpathSync(resolve(entry));
    return loaded === invoked;
  } catch {
    return moduleUrl === pathToFileURL(resolve(entry)).href;
  }
}
