// Campaign files for one profile. Owns paths, the register, and status moves.
// The folder name is the local date and time the audit started. campaign.json stores the hash.
// Must not copy a finding into a second status directory, and must not decide hits.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
 * @param {string} name
 * @param {string} [root]
 * @returns {string}
 */
export function campaignDir(profileId, name, root = process.cwd()) {
  return resolve(root, "campaigns", profileId, name);
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
  try {
    const data = JSON.parse(await readFile(resolve(dir, "campaign.json"), "utf8"));
    if (typeof data.model === "string" && data.model) return data.model;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
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

const HASH_NAME = /^[0-9a-f]{12}$/;

function stampFrom(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function campaignFile(dir) {
  try {
    return JSON.parse(await readFile(resolve(dir, "campaign.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function storedHash(data, name) {
  if (typeof data?.hash === "string" && HASH_NAME.test(data.hash)) return data.hash;
  return HASH_NAME.test(name) ? name : null;
}

async function writeCampaign(dir, hash, model) {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "campaign.json"), `${JSON.stringify({ hash, model }, null, 2)}\n`);
}

async function uniqueName(parent, base) {
  let name = base;
  let suffix = 0;
  while (await exists(resolve(parent, name))) {
    suffix += 1;
    name = `${base}-${String(suffix).padStart(2, "0")}`;
  }
  return name;
}

async function createStampedDir(parent) {
  await mkdir(parent, { recursive: true });
  const base = stampFrom(new Date());
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const name = suffix === 0 ? base : `${base}-${String(suffix).padStart(2, "0")}`;
    const dir = resolve(parent, name);
    try {
      await mkdir(dir);
      return { name, dir };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Error("campaign folder name is taken");
}

async function renameHashFolder(parent, name, dir) {
  if (!HASH_NAME.test(name)) return { name, dir, renamedFrom: null };
  let when = new Date();
  try {
    when = (await stat(resolve(dir, "register.json"))).mtime;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const next = await uniqueName(parent, stampFrom(when));
  const dest = resolve(parent, next);
  try {
    await rename(dir, dest);
  } catch {
    console.log(`audit campaign ${name} is in use; using that folder`);
    return { name, dir, renamedFrom: null };
  }
  console.log(`renamed audit campaign ${name} to ${next}`);
  return { name: next, dir: dest, renamedFrom: name };
}

async function listCampaignRows(parent) {
  let names = [];
  try {
    names = await readdir(parent);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const rows = [];
  for (const name of names) {
    const dir = resolve(parent, name);
    let info;
    try {
      info = await stat(dir);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (!info.isDirectory()) continue;
    const hasRegister = await exists(resolve(dir, "register.json"));
    const data = await campaignFile(dir);
    if (!hasRegister && !data) continue;
    const model = typeof data?.model === "string" && data.model ? data.model : await campaignModel(dir);
    rows.push({
      name,
      dir,
      hash: storedHash(data, name),
      model,
      hasRegister,
      archived: data?.archived === true,
    });
  }
  return rows;
}

function chooseActive(rows, hash, modelId) {
  const matches = rows
    .filter((row) => !row.archived && row.hash === hash)
    .sort((left, right) => right.name.localeCompare(left.name));
  if (matches.length > 0) return matches[0];
  const donors = rows.filter((row) => !row.archived && row.hasRegister && row.model === modelId);
  return donors.length === 1 ? donors[0] : null;
}

async function archiveCampaign(row) {
  const data = await campaignFile(row.dir);
  const body = {
    hash: storedHash(data, row.name) || row.hash,
    model: typeof data?.model === "string" && data.model ? data.model : row.model,
    archived: true,
  };
  await writeFile(resolve(row.dir, "campaign.json"), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`archived audit campaign ${row.name}`);
}

/**
 * Opens the campaign for this profile and health model. The folder name is a local timestamp.
 * Archived folders are skipped unless options.campaign names one. options.fresh archives the active folder and starts another.
 * A 12-hex folder name is renamed to a timestamp. Returns { hash, dir, renamedFrom }.
 * @param {{ id: string }} profile
 * @param {string} modelId
 * @param {string} [cwd]
 * @param {{ fresh?: boolean, campaign?: string }} [options]
 * @returns {Promise<{ hash: string, dir: string, renamedFrom: string | null }>}
 */
export async function adoptCampaign(profile, modelId, cwd = process.cwd(), options = {}) {
  const hash = campaignHash(profile, modelId);
  const parent = resolve(cwd, "campaigns", profile.id);
  const rows = await listCampaignRows(parent);
  if (options.campaign) {
    const name = String(options.campaign);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`campaign folder name is not allowed: ${name}`);
    const row = rows.find((item) => item.name === name);
    if (!row) throw new Error(`No campaign folder ${name}`);
    return { hash: row.hash || hash, dir: row.dir, renamedFrom: null };
  }
  if (options.fresh) {
    const current = chooseActive(rows, hash, modelId);
    if (current) await archiveCampaign(current);
    const created = await createStampedDir(parent);
    await writeCampaign(created.dir, hash, modelId);
    console.log(`started audit campaign ${created.name}`);
    return { hash, dir: created.dir, renamedFrom: null };
  }
  const chosen = chooseActive(rows, hash, modelId);
  if (!chosen) {
    const created = await createStampedDir(parent);
    await writeCampaign(created.dir, hash, modelId);
    return { hash, dir: created.dir, renamedFrom: null };
  }
  const placed = await renameHashFolder(parent, chosen.name, chosen.dir);
  await writeCampaign(placed.dir, hash, modelId);
  if (chosen.hash !== hash && !placed.renamedFrom) console.log(`kept audit campaign ${placed.name}`);
  return { hash, dir: placed.dir, renamedFrom: placed.renamedFrom };
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
