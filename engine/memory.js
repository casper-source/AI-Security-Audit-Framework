// Campaign files for one profile hash. Owns paths, the register, and status moves.
// A hit, a rejection, and a transport failure each leave one status file.
// Must not copy a finding into a second status directory, and must not decide hits.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/**
 * @param {object} profile
 * @param {string} modelId
 * @returns {string}
 */
export function campaignHash(profile, modelId) {
  const body = profile && typeof profile === "object" ? { ...profile } : profile;
  if (body?.limits && typeof body.limits === "object") {
    body.limits = { ...body.limits };
    delete body.limits.reproRuns;
    delete body.limits.reproMin;
    delete body.limits.maxConcurrency;
  }
  const material = `${stableStringify(body)}\n${modelId}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

/**
 * @param {string} profileId
 * @param {string} hash
 * @param {string} [root]
 * @returns {string}
 */
export function campaignDir(profileId, hash, root = process.cwd()) {
  return resolve(root, "campaigns", profileId, hash);
}

/**
 * @param {string} dir
 * @param {{ id: string }[]} behaviors
 */
export async function loadRegister(dir, behaviors) {
  await mkdir(resolve(dir, "logs"), { recursive: true });
  const file = resolve(dir, "register.json");
  let data = { behaviors: {} };
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!data.behaviors || typeof data.behaviors !== "object") data.behaviors = {};
  for (const behavior of behaviors ?? []) {
    if (!data.behaviors[behavior.id]) {
      data.behaviors[behavior.id] = { pulls: 0, wins: 0, status: "open" };
    }
  }
  return data;
}

/**
 * @param {string} dir
 * @param {{ behaviors: object }} register
 */
export async function saveRegister(dir, register) {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "register.json"), `${JSON.stringify(register, null, 2)}\n`);
}

/**
 * @param {string} dir
 * @param {string} behaviorId
 * @param {string} event
 * @param {Date} [at]
 */
export async function journal(dir, behaviorId, event, at = new Date()) {
  await mkdir(dir, { recursive: true });
  await appendFile(resolve(dir, "journal.md"), `- ${at.toISOString()} ${behaviorId} ${event}\n`);
}

/**
 * @param {string} dir
 * @param {{ at: string, behaviorId: string, goal: string, note: string }} entry
 */
export async function lesson(dir, entry) {
  await mkdir(dir, { recursive: true });
  await appendFile(resolve(dir, "lessons.jsonl"), `${JSON.stringify(entry)}\n`);
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function remove(file) {
  await rm(file, { force: true });
}

/**
 * @param {string} dir
 * @param {"CANDIDATE" | "CONFIRMED" | "REJECTED" | "TRANSPORT" | "DISAGREEMENT"} status
 * @param {object} finding
 */
export async function saveFinding(dir, status, finding) {
  const id = finding.behaviorId;
  const findingsFile = resolve(dir, "findings", `${id}.json`);
  const rejectedFile = resolve(dir, "rejected", `${id}.json`);
  const transportFile = resolve(dir, "transport", `${id}.json`);
  const disagreementFile = resolve(dir, "disagreements", `${id}.json`);
  if (status === "CANDIDATE") {
    await writeJson(findingsFile, { ...finding, evidenceLadder: "claimed" });
    return;
  }
  if (status === "CONFIRMED") {
    await writeJson(findingsFile, { ...finding, evidenceLadder: "verified" });
    await remove(rejectedFile);
    await remove(transportFile);
    return;
  }
  if (status === "REJECTED") {
    await writeJson(rejectedFile, { ...finding, evidenceLadder: "claimed" });
    await remove(findingsFile);
    await remove(transportFile);
    await remove(disagreementFile);
    return;
  }
  if (status === "TRANSPORT") {
    await writeJson(transportFile, { ...finding, evidenceLadder: "claimed" });
    await remove(findingsFile);
    await remove(rejectedFile);
    await remove(disagreementFile);
    return;
  }
  if (status === "DISAGREEMENT") {
    await writeJson(disagreementFile, finding);
    return;
  }
  throw new Error(`unknown finding status: ${status}`);
}

/**
 * @param {string} dir
 * @returns {Promise<object[]>}
 */
export async function listCandidates(dir) {
  const rows = await readDirJson(resolve(dir, "findings"));
  return rows.filter((row) => row.evidenceLadder === "claimed");
}

/**
 * Saved audit transcripts. Confirmed, rejected, and transport rows are included so verify can be repeated.
 * @param {string} dir
 * @returns {Promise<object[]>}
 */
export async function listReplayable(dir) {
  const [findings, rejected, transport] = await Promise.all([
    readDirJson(resolve(dir, "findings")),
    readDirJson(resolve(dir, "rejected")),
    readDirJson(resolve(dir, "transport")),
  ]);
  const byId = new Map();
  for (const row of [...transport, ...rejected, ...findings]) {
    if (!row?.behaviorId || !Array.isArray(row.transcript) || row.transcript.length === 0) continue;
    byId.set(row.behaviorId, row);
  }
  return [...byId.values()];
}

async function campaignModel(dir) {
  const rows = await readDirJson(resolve(dir, "regression"));
  for (const row of rows) {
    if (typeof row.model === "string" && row.model) return row.model;
  }
  let names = [];
  try {
    names = await readdir(resolve(dir, "logs"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const text = await readFile(resolve(dir, "logs", name), "utf8");
    const found = text.match(/^model=(.+)$/m);
    if (found) return found[1].trim();
  }
  return null;
}

async function fileExists(file) {
  try {
    await readFile(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Keeps an older audit directory when reproduction limits were the only reason its hash changed.
 * @param {{ id: string }} profile
 * @param {string} modelId
 * @param {string} [cwd]
 * @returns {Promise<{ hash: string, dir: string, movedFrom: string | null }>}
 */
export async function adoptCampaign(profile, modelId, cwd = process.cwd()) {
  const hash = campaignHash(profile, modelId);
  const dir = campaignDir(profile.id, hash, cwd);
  if (await fileExists(resolve(dir, "register.json"))) return { hash, dir, movedFrom: null };
  const parent = resolve(cwd, "campaigns", profile.id);
  let names = [];
  try {
    names = await readdir(parent);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return { hash, dir, movedFrom: null };
  }
  const donors = [];
  for (const name of names) {
    if (name === hash || !/^[0-9a-f]{12}$/.test(name)) continue;
    const donor = resolve(parent, name);
    if (!(await fileExists(resolve(donor, "register.json")))) continue;
    if ((await campaignModel(donor)) !== modelId) continue;
    donors.push({ hash: name, dir: donor });
  }
  if (donors.length !== 1) return { hash, dir, movedFrom: null };
  await mkdir(dirname(dir), { recursive: true });
  try {
    await rename(donors[0].dir, dir);
  } catch (err) {
    console.log(`audit campaign ${donors[0].hash} is in use; using that folder`);
    return { hash: donors[0].hash, dir: donors[0].dir, movedFrom: null };
  }
  console.log(`moved audit campaign ${donors[0].hash} to ${hash}`);
  return { hash, dir, movedFrom: donors[0].hash };
}

/**
 * @param {string} dir
 * @returns {Promise<object[]>}
 */
export async function readDirJson(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    rows.push(JSON.parse(await readFile(resolve(dir, name), "utf8")));
  }
  return rows;
}
