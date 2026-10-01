// Entry detection for npm link and direct node invocations.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { invokedDirectly } from "../engine/entry.js";

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("invokedDirectly is false when argv is not that module", () => {
  const cliUrl = pathToFileURL(resolve(repoRoot, "engine", "cli.js")).href;
  assert.equal(invokedDirectly(cliUrl), false);
});

test("a symlinked cli path still prints help", async (t) => {
  const root = resolve(tmpdir(), `audit-entry-${Date.now()}`);
  const linkDir = resolve(root, "node_modules", "audit-framework", "engine");
  await mkdir(linkDir, { recursive: true });
  const realCli = resolve(repoRoot, "engine", "cli.js");
  const linkCli = resolve(linkDir, "cli.js");
  try {
    await symlink(realCli, linkCli, "file");
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EINVAL" || err.code === "ENOENT") {
      t.skip(`symlink unavailable: ${err.code}`);
      return;
    }
    throw err;
  }
  const { stdout } = await exec(process.execPath, [linkCli, "help"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(stdout, /audit-framework/);
});
