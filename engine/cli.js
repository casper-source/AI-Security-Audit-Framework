// User-facing commands. Each one calls one engine file or opens one campaign path.
// Status and summary do not send turns. A live health check picks the campaign hash.
// Must not confirm a finding, and must not put a secret on the command line.

import { spawn } from "node:child_process";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { adoptCampaign } from "./memory.js";
import { preflight } from "./preflight.js";
import { loadEnvFile, loadProfile } from "./run.js";

export const HELP = `audit-framework

  npm run check     Profile and health check. Sends no turns.
  npm run audit     Coverage pass. Writes claimed findings.
  npm run clean     Delete this target's campaigns, then run the coverage pass.
  npm run verify    Replay the audit findings. Optional ids limit which behaviors run.
  npm run status    Register for this target. Sends no turns.
  npm run summary   Open summary.html in the browser.
  npm run logs      Open the turn-log folder.
  npm run mock      Demo target on 127.0.0.1:8787.
  npm test          Test suite.

node engine/cli.js accepts check, run, clean, verify, status, summary, and logs.
`;

/**
 * @param {string} file
 * @returns {Promise<void>}
 */
export function openPath(file) {
  const child = process.platform === "win32"
    ? spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore", windowsHide: true })
    : process.platform === "darwin"
      ? spawn("open", [file], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [file], { detached: true, stdio: "ignore" });
  child.unref();
  return Promise.resolve();
}

/**
 * @param {string} root
 * @param {string} profileId
 * @returns {Promise<{ hash: string, dir: string, mtime: number }[]>}
 */
export async function listCampaigns(root, profileId) {
  const base = resolve(root, "campaigns", profileId);
  let names;
  try {
    names = await readdir(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const found = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(base, entry.name);
    let mtime = 0;
    for (const name of ["summary.html", "register.json"]) {
      try {
        const info = await stat(resolve(dir, name));
        if (info.mtimeMs > mtime) mtime = info.mtimeMs;
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    if (mtime > 0) found.push({ hash: entry.name, dir, mtime });
  }
  found.sort((left, right) => right.mtime - left.mtime || left.hash.localeCompare(right.hash));
  return found;
}

/**
 * @param {{ id: string }[]} behaviors
 * @param {{ behaviors?: Record<string, { status?: string, pulls?: number, wins?: number }> }} register
 * @returns {string}
 */
export function formatStatus(behaviors, register) {
  const rows = behaviors.map((behavior) => {
    const row = register.behaviors?.[behavior.id] ?? {};
    return [behavior.id, row.status ?? "open", String(row.pulls ?? 0), String(row.wins ?? 0)];
  });
  const header = ["behavior", "status", "pulls", "wins"];
  const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index].length)));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: object, checked?: { ok: boolean, errors: string[], modelId: string | null } }} [options]
 */
export async function locateCampaign(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = options.profile ?? await loadProfile(env, cwd);
  const checked = options.checked ?? await preflight(profile, env, cwd);
  const local = await listCampaigns(cwd, profile.id);
  if (checked.ok) {
    const placed = await adoptCampaign(profile, checked.modelId, cwd);
    return { profile, checked, hash: placed.hash, dir: placed.dir, source: "health", local };
  }
  const newest = local[0] ?? null;
  return { profile, checked, hash: newest?.hash ?? null, dir: newest?.dir ?? null, source: "newest", local };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function healthNote(found) {
  if (found.source !== "newest") return;
  console.error(`Target health check failed: ${found.checked.errors.join("; ")}`);
  console.error("Using the newest local campaign.");
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: object, checked?: { ok: boolean, errors: string[], modelId: string | null }, open?: (file: string) => Promise<void> }} [options]
 */
export async function summaryCommand(options = {}) {
  const found = await locateCampaign(options);
  if (!found.dir) throw new Error(`No campaign for ${found.profile.id}. npm run audit`);
  const file = resolve(found.dir, "summary.html");
  if (!(await exists(file))) throw new Error(`No summary.html for ${found.profile.id} ${found.hash}. npm run audit`);
  healthNote(found);
  console.log(file);
  await (options.open ?? openPath)(file);
  return { ok: true, file };
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: object, checked?: { ok: boolean, errors: string[], modelId: string | null }, open?: (file: string) => Promise<void> }} [options]
 */
export async function logsCommand(options = {}) {
  const found = await locateCampaign(options);
  if (!found.dir) throw new Error(`No campaign for ${found.profile.id}. npm run audit`);
  const dir = resolve(found.dir, "logs");
  if (!(await exists(dir))) throw new Error(`No logs for ${found.profile.id} ${found.hash}. npm run audit`);
  healthNote(found);
  console.log(dir);
  await (options.open ?? openPath)(dir);
  return { ok: true, dir };
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: object, checked?: { ok: boolean, errors: string[], modelId: string | null } }} [options]
 */
export async function statusCommand(options = {}) {
  const found = await locateCampaign(options);
  if (!found.dir) throw new Error(`No campaign for ${found.profile.id}. npm run audit`);
  const file = resolve(found.dir, "register.json");
  if (!(await exists(file))) throw new Error(`No register for ${found.profile.id} ${found.hash}. npm run audit`);
  const register = JSON.parse(await readFile(file, "utf8"));
  healthNote(found);
  const model = found.checked.ok ? found.checked.modelId : "-";
  console.log(`${found.profile.id}  ${found.hash}  ${model}`);
  console.log(formatStatus(found.profile.behaviors ?? [], register));
  return { ok: true, dir: found.dir };
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: object, checked?: { ok: boolean, errors: string[], modelId: string | null } }} [options]
 */
export async function checkCommand(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = options.profile ?? await loadProfile(env, cwd);
  const checked = options.checked ?? await preflight(profile, env, cwd);
  if (!checked.ok) throw Object.assign(new Error(checked.errors.join("; ")), { printed: false });
  const placed = await adoptCampaign(profile, checked.modelId, cwd);
  const hash = placed.hash;
  const dir = placed.dir;
  console.log(`${profile.id}  ${checked.modelId}`);
  console.log(hash);
  console.log(dir);
  return { ok: true, hash, dir, modelId: checked.modelId };
}

/**
 * @param {string} root
 * @param {string} profileId
 * @returns {Promise<string>}
 */
export async function removeCampaigns(root, profileId) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(profileId ?? ""))) {
    throw new Error(`Profile id is not a single folder name: ${profileId}`);
  }
  const dir = resolve(root, "campaigns", profileId);
  await rm(dir, { recursive: true, force: true });
  return dir;
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: { id: string }, run?: (options: object) => Promise<unknown> }} [options]
 */
export async function cleanCommand(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = options.profile ?? await loadProfile(env, cwd);
  const dir = await removeCampaigns(cwd, profile.id);
  console.log(`Removed ${dir}`);
  if (options.run) return options.run(options);
  const { main } = await import("./run.js");
  return main(options);
}

/**
 * @param {string} name
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, open?: (file: string) => Promise<void> }} [options]
 */
export async function dispatch(name, options = {}) {
  if (name === "check") return checkCommand(options);
  if (name === "run") {
    const { main } = await import("./run.js");
    return main(options);
  }
  if (name === "clean") return cleanCommand(options);
  if (name === "verify") {
    const { main } = await import("./verify.js");
    return main(options);
  }
  if (name === "status") return statusCommand(options);
  if (name === "summary") return summaryCommand(options);
  if (name === "logs") return logsCommand(options);
  throw new Error(`Unknown command: ${name || "(none)"}\n${HELP}`);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) {
  const name = process.argv[2];
  if (!name || name === "help" || name === "--help") {
    console.log(HELP);
  } else {
    dispatch(name, { behaviors: process.argv.slice(3) }).catch((err) => {
      if (!err.printed) console.error(err.message);
      process.exitCode = 1;
    });
  }
}
