// Validates a profile before any campaign file is written.
// Schema and host checks finish before a socket. Health runs only after that.
// Must not widen the host allowlist, and must not decide whether an oracle hit.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as chatHistory from "../dialects/chat-history.js";
import * as chatSession from "../dialects/chat-session.js";
import { readPath } from "./judge.js";

const DIALECTS = {
  "chat-session": chatSession,
  "chat-history": chatHistory,
};
const PAIRS = new Set(["chat-session/server-session", "chat-history/resend-history"]);
const HOSTS = new Set(["localhost", "127.0.0.1"]);
const IMPACTS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const ENV_ROLES = ["targetUrl", "targetKey", "targetModel", "auditorUrl", "auditorKey", "auditorModel"];
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function hostOf(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "invalid URL" };
  }
  if (parsed.username || parsed.password) return { error: "userinfo is not allowed" };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "protocol is not allowed" };
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1" || !HOSTS.has(host)) return { error: `host is not allowed: ${host}` };
  return { host };
}

function containsNeedle(text, needles) {
  const hay = String(text).toLowerCase();
  return (needles ?? []).find((needle) => needle && hay.includes(String(needle).toLowerCase()));
}

function validateShape(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return ["profile must be an object"];
  if (typeof profile.id !== "string" || !ID_PATTERN.test(profile.id)) errors.push("id must be a lowercase slug");
  if (!PAIRS.has(`${profile.dialect}/${profile.session}`)) errors.push("dialect/session pair is not allowed");
  if (!Array.isArray(profile.allowHosts) || profile.allowHosts.length === 0) {
    errors.push("allowHosts must be a non-empty subset of localhost and 127.0.0.1");
  } else if (profile.allowHosts.some((host) => !HOSTS.has(String(host).toLowerCase()))) {
    errors.push("allowHosts must be a non-empty subset of localhost and 127.0.0.1");
  }
  if (!profile.auditor || typeof profile.auditor.remote !== "boolean") errors.push("auditor.remote must be a boolean");
  if (!profile.env || typeof profile.env !== "object") {
    errors.push("env roles are required");
  } else {
    for (const role of ENV_ROLES) {
      if (typeof profile.env[role] !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.env[role])) {
        errors.push(`env.${role} must name an environment variable`);
      }
    }
  }
  const limits = profile.limits ?? {};
  for (const key of ["maxTurns", "minTurns", "delayMs", "reproRuns", "reproMin", "maxConcurrency"]) {
    const minimum = key === "delayMs" ? 0 : 1;
    if (!Number.isInteger(limits[key]) || limits[key] < minimum) errors.push(`limits.${key} must be an integer >= ${minimum}`);
  }
  if (Number.isInteger(limits.minTurns) && Number.isInteger(limits.maxTurns) && limits.minTurns > limits.maxTurns) {
    errors.push("limits.minTurns must be <= maxTurns");
  }
  if (Number.isInteger(limits.reproMin) && Number.isInteger(limits.reproRuns) && limits.reproMin > limits.reproRuns) {
    errors.push("limits.reproMin must be <= reproRuns");
  }
  if (!Array.isArray(profile.redact) || profile.redact.some((item) => typeof item !== "string")) {
    errors.push("redact must be a list of strings");
  }
  errors.push(...validateOracles(profile.oracles));
  errors.push(...validateBehaviors(profile));
  return errors;
}

function validateOracles(oracles) {
  const errors = [];
  if (!Array.isArray(oracles) || oracles.length === 0) return ["oracles must be a non-empty list"];
  const seen = new Set();
  for (const oracle of oracles) {
    if (!oracle || typeof oracle.id !== "string" || !ID_PATTERN.test(oracle.id)) {
      errors.push("oracle id must be a lowercase slug");
      continue;
    }
    if (seen.has(oracle.id)) errors.push(`duplicate oracle id: ${oracle.id}`);
    seen.add(oracle.id);
    if (oracle.kind === "text") {
      if (!Array.isArray(oracle.strings) || oracle.strings.length === 0 || oracle.strings.some((item) => typeof item !== "string" || item.length === 0)) {
        errors.push(`oracle ${oracle.id} needs non-empty strings`);
      }
    } else if (oracle.kind === "flag") {
      if (typeof oracle.path !== "string" || oracle.path.length === 0) errors.push(`oracle ${oracle.id} needs a path`);
      if (!Object.hasOwn(oracle, "equals")) errors.push(`oracle ${oracle.id} needs equals`);
    } else {
      errors.push(`oracle ${oracle.id} kind is not text or flag`);
    }
  }
  return errors;
}

function validateBehaviors(profile) {
  const errors = [];
  const behaviors = profile.behaviors;
  if (!Array.isArray(behaviors) || behaviors.length === 0) return ["behaviors must be a non-empty list"];
  const oracleIds = new Set((profile.oracles ?? []).map((oracle) => oracle?.id));
  const byId = new Map();
  for (const behavior of behaviors) {
    if (!behavior || typeof behavior.id !== "string" || !ID_PATTERN.test(behavior.id)) {
      errors.push("behavior id must be a lowercase slug");
      continue;
    }
    if (byId.has(behavior.id)) errors.push(`duplicate behavior id: ${behavior.id}`);
    byId.set(behavior.id, behavior);
    if (typeof behavior.family !== "string" || behavior.family.length === 0) errors.push(`behavior ${behavior.id} needs a family`);
    if (typeof behavior.title !== "string" || behavior.title.length === 0) errors.push(`behavior ${behavior.id} needs a title`);
    if (!oracleIds.has(behavior.goal)) errors.push(`behavior ${behavior.id} goal has no oracle`);
    if (!IMPACTS.has(behavior.impact)) errors.push(`behavior ${behavior.id} impact is not allowed`);
    if (typeof behavior.stateful !== "boolean") errors.push(`behavior ${behavior.id} stateful must be a boolean`);
    if (behavior.stateful === true) {
      if (!behavior.reset || behavior.reset.method !== "POST" || typeof behavior.reset.path !== "string" || !behavior.reset.path.startsWith("/")) {
        errors.push(`behavior ${behavior.id} is stateful and names no reset`);
      }
    } else if (behavior.stateful === false && behavior.reset !== undefined) {
      errors.push(`behavior ${behavior.id} is read-only and must omit reset`);
    }
    if (!Array.isArray(behavior.seeds) || behavior.seeds.length === 0) {
      errors.push(`behavior ${behavior.id} needs a seed`);
    } else {
      for (const seed of behavior.seeds) errors.push(...validateSeed(behavior.id, seed));
    }
  }
  for (const behavior of behaviors) {
    if (!behavior || !Object.hasOwn(behavior, "benignOf")) {
      errors.push(`behavior ${behavior?.id ?? "?"} benignOf is required`);
      continue;
    }
    if (behavior.benignOf === null) continue;
    const partner = byId.get(behavior.benignOf);
    if (typeof behavior.benignOf !== "string" || !partner || partner.benignOf !== null || partner.id === behavior.id) {
      errors.push(`behavior ${behavior.id} benignOf does not name a benign partner`);
    }
  }
  errors.push(...validateLeak(profile));
  return errors;
}

function validateSeed(behaviorId, seed) {
  const errors = [];
  if (!seed || typeof seed !== "object") return [`behavior ${behaviorId} seed is not an object`];
  if (typeof seed.opening !== "string" || seed.opening.length === 0) errors.push(`behavior ${behaviorId} opening is required`);
  if (!Array.isArray(seed.followups) || seed.followups.some((item) => typeof item !== "string")) {
    errors.push(`behavior ${behaviorId} followups must be a list of strings`);
  }
  if (typeof seed.hint !== "string") errors.push(`behavior ${behaviorId} hint is required`);
  return errors;
}

function validateLeak(profile) {
  const errors = [];
  const oracleStrings = [];
  for (const oracle of profile.oracles ?? []) {
    if (oracle?.kind === "text") oracleStrings.push(...(oracle.strings ?? []));
  }
  const redactStrings = Array.isArray(profile.redact) ? profile.redact : [];
  for (const behavior of profile.behaviors ?? []) {
    for (const seed of behavior?.seeds ?? []) {
      const fields = [
        ["hint", seed?.hint],
        ["opening", seed?.opening],
        ...(Array.isArray(seed?.followups) ? seed.followups.map((item) => ["followup", item]) : []),
      ];
      for (const [label, text] of fields) {
        if (typeof text !== "string") continue;
        if (containsNeedle(text, oracleStrings)) errors.push(`behavior ${behavior.id} ${label} contains an oracle string`);
        else if (containsNeedle(text, redactStrings)) errors.push(`behavior ${behavior.id} ${label} contains a redact string`);
      }
    }
  }
  return errors;
}

/**
 * Uses targets/<TARGET>/adapter.js when that file exists. Otherwise the profile dialect.
 * @param {object} profile
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} [cwd]
 */
export async function loadTransport(profile, env, cwd = process.cwd()) {
  const target = env?.TARGET || "demo";
  if (!/^[A-Za-z0-9._-]+$/.test(target)) return DIALECTS[profile.dialect];
  const adapterFile = resolve(cwd, "targets", target, "adapter.js");
  try {
    await access(adapterFile);
  } catch (err) {
    if (err.code === "ENOENT") return DIALECTS[profile.dialect];
    throw err;
  }
  return import(pathToFileURL(adapterFile).href);
}

/**
 * @param {object} profile
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} [cwd]
 * @returns {Promise<{ ok: boolean, errors: string[], modelId: string | null }>}
 */
export async function preflight(profile, env, cwd = process.cwd()) {
  const errors = validateShape(profile);
  if (errors.length > 0) return { ok: false, errors, modelId: null };
  const targetUrl = env?.[profile.env.targetUrl];
  const urlErrors = [];
  if (!targetUrl) {
    urlErrors.push("target URL is unset");
  } else {
    const target = hostOf(targetUrl);
    if (target.error) urlErrors.push(target.error);
    else if (!(profile.allowHosts ?? []).map((host) => String(host).toLowerCase()).includes(target.host)) {
      urlErrors.push(`host is not allowed: ${target.host}`);
    }
  }
  const auditorUrl = env?.[profile.env.auditorUrl];
  if (auditorUrl && profile.auditor.remote === false) {
    const auditor = hostOf(auditorUrl);
    if (auditor.error === "userinfo is not allowed" || auditor.error === "invalid URL" || auditor.error === "protocol is not allowed") {
      urlErrors.push(auditor.error === "host is not allowed" ? auditor.error : `auditor ${auditor.error}`);
    } else if (auditor.error) urlErrors.push(auditor.error.replace("host is not allowed", "auditor host is not allowed"));
  }
  if (urlErrors.length > 0) return { ok: false, errors: urlErrors, modelId: null };
  const dialect = await loadTransport(profile, env, cwd);
  try {
    const health = await dialect.health({
      url: targetUrl,
      allowHosts: profile.allowHosts,
      key: env[profile.env.targetKey] || undefined,
    });
    if (!health || typeof health.model !== "string" || health.model.length === 0) {
      return { ok: false, errors: ["Target health check failed: model id missing"], modelId: null };
    }
    return { ok: true, errors: [], modelId: health.model };
  } catch (err) {
    return { ok: false, errors: [`Target health check failed: ${err.message}`], modelId: null };
  }
}

/**
 * @param {{ oracle?: object }} sampleTurn
 * @param {{ oracles?: { kind?: string, path?: string }[] }} profile
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function assertContract(sampleTurn, profile) {
  const errors = [];
  for (const oracle of profile?.oracles ?? []) {
    if (oracle?.kind !== "flag") continue;
    if (!readPath(sampleTurn?.oracle, oracle.path).ok) errors.push(`flag path is not readable: ${oracle.path}`);
  }
  return { ok: errors.length === 0, errors };
}
