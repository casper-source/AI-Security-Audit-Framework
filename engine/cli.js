#!/usr/bin/env node
// User-facing commands. Each one calls one engine file or opens one campaign path.
// Status and summary do not send turns. A live health check picks the campaign hash.
// Must not confirm a finding, and must not put a secret on the command line.

import { spawn } from "node:child_process";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "./args.js";
import { invokedDirectly } from "./entry.js";
import { adoptCampaign } from "./memory.js";
import { preflight } from "./preflight.js";
import { loadEnvFile, loadProfile } from "./run.js";

export const HELP = `audit-framework

  audit check                         Profile and health check. Sends no turns.
  audit run                           Coverage pass. Resumes the active campaign.
  audit run --fresh                   Archive the active campaign and start a new folder.
  audit clean                         Delete this target's campaign folders. Does not run.
  audit verify [id ...]               Replay the active campaign. Optional ids limit behaviors.
  audit verify --campaign <folder>    Replay that folder, including an archived one.
  audit status [--campaign <folder>]  Register. Sends no turns.
  audit summary [--campaign <folder>] Open summary.html.
  audit logs [--campaign <folder>]    Open the turn-log folder.

  npm run check      Same as audit check.
  npm run audit      Same as audit run. npm run audit -- --fresh starts a new folder.
  npm run clean      Same as audit clean.
  npm run verify     Same as audit verify. npm run verify -- --campaign <folder> <id>
  npm run status     Register for this target. Sends no turns.
  npm run summary    Open summary.html in the browser.
  npm run logs       Open the turn-log folder.
  npm run mock       Demo target on 127.0.0.1:8787.
  npm test           Test suite.

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
    if (mtime === 0) continue;
    let hash = entry.name;
    try {
      const data = JSON.parse(await readFile(resolve(dir, "campaign.json"), "utf8"));
      if (typeof data.hash === "string" && data.hash) hash = data.hash;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    found.push({ hash, dir, mtime });
  }
  found.sort((left, right) => right.mtime - left.mtime || left.hash.localeCompare(right.hash));
  return found;
}

/**
 * @param {string} root
 * @param {string} profileId
 * @returns {Promise<{ hash: string, dir: string, mtime: number }[]>}
 */
export async function listSummaryCampaigns(root, profileId) {
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
    let mtime;
    try {
      mtime = (await stat(resolve(dir, "summary.html"))).mtimeMs;
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    let hash = entry.name;
    try {
      const data = JSON.parse(await readFile(resolve(dir, "campaign.json"), "utf8"));
      if (typeof data.hash === "string" && data.hash) hash = data.hash;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    found.push({ hash, dir, mtime });
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
  if (options.campaign || checked.ok) {
    const placed = await adoptCampaign(profile, checked.modelId || "", cwd, { campaign: options.campaign || undefined });
    const source = options.campaign ? "named" : "health";
    return { profile, checked, hash: placed.hash, dir: placed.dir, source, local };
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
  console.error("Using the most recently updated summary.html.");
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: object, checked?: { ok: boolean, errors: string[], modelId: string | null }, campaign?: string }} [options]
 */
async function locateSummaryCampaign(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = options.profile ?? await loadProfile(env, cwd);
  const checked = options.checked ?? await preflight(profile, env, cwd);
  if (options.campaign) {
    const placed = await adoptCampaign(profile, checked.modelId || "", cwd, { campaign: options.campaign });
    return { profile, checked, hash: placed.hash, dir: placed.dir, source: "named" };
  }
  const local = await listSummaryCampaigns(cwd, profile.id);
  const newest = local[0] ?? null;
  return {
    profile,
    checked,
    hash: newest?.hash ?? null,
    dir: newest?.dir ?? null,
    source: newest && !checked.ok ? "newest" : "summary",
    local,
  };
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: object, checked?: { ok: boolean, errors: string[], modelId: string | null }, open?: (file: string) => Promise<void> }} [options]
 */
export async function summaryCommand(options = {}) {
  const found = await locateSummaryCampaign(options);
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
 * Deletes this target's campaign folders and does not start a run.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, profile?: { id: string } }} [options]
 */
export async function cleanCommand(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = options.profile ?? await loadProfile(env, cwd);
  const dir = await removeCampaigns(cwd, profile.id);
  console.log(`Removed ${dir}`);
  return { ok: true, dir };
}

/**
 * @param {string} name
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv | Record<string, string | undefined>, open?: (file: string) => Promise<void> }} [options]
 */
export async function dispatch(name, options = {}) {
  if (options.fresh && name !== "run") throw new Error("--fresh is only valid for run");
  const named = name === "verify" || name === "status" || name === "summary" || name === "logs";
  if (options.campaign && !named) throw new Error("--campaign is only valid for verify, status, summary, and logs");
  if ((options.behaviors ?? []).length > 0 && name !== "verify") throw new Error(`unexpected argument: ${options.behaviors[0]}`);
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

if (invokedDirectly(import.meta.url)) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!parsed?.name || parsed.name === "help" || parsed.name === "--help") {
    console.log(HELP);
  } else {
    dispatch(parsed.name, { fresh: parsed.fresh, campaign: parsed.campaign, behaviors: parsed.behaviors }).catch((err) => {
      if (!err.printed) console.error(err.message);
      process.exitCode = 1;
    });
  }
}
