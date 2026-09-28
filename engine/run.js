// Runs one coverage pass: preflight, wake, orient, plan, attack, judge, reinforce.
// A transport failure stays open. A drafter failure is logged and does not hide.
// Must not confirm a finding or ask a model whether the bug is real.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parse } from "yaml";
import { draft } from "./drafter.js";
import { judge } from "./judge.js";
import { campaignDir, campaignHash, journal, lesson, loadRegister, saveFinding, saveRegister } from "./memory.js";
import { nextBehavior } from "./planner.js";
import { loadTransport, preflight } from "./preflight.js";
import { loadBuckets, render, writeSummary } from "./report.js";
import { secondOpinion } from "./rubric.js";

/**
 * @param {string} text
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function applyEnvText(text, env) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = (line.startsWith("export ") ? line.slice(7) : line).trim();
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

/**
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function loadEnvFile(cwd = process.cwd(), env = process.env) {
  let text = "";
  try {
    text = readFileSync(resolve(cwd, ".env"), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return applyEnvText(text, env);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} [cwd]
 */
export async function loadProfile(env, cwd = process.cwd()) {
  const target = env.TARGET || "demo";
  if (!/^[A-Za-z0-9._-]+$/.test(target)) throw new Error(`TARGET is not a single folder name: ${target}`);
  const file = resolve(cwd, "targets", target, "profile.yaml");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`Profile not found: targets/${target}/profile.yaml`);
    throw err;
  }
  const profile = parse(text);
  if (!profile || typeof profile !== "object") throw new Error("Profile is empty");
  return profile;
}

function fatal(line) {
  console.error(line);
  const error = new Error(line);
  error.printed = true;
  return error;
}

function scriptedLines(behavior) {
  const lines = [];
  for (const seed of behavior.seeds) {
    lines.push(seed.opening);
    for (const follow of seed.followups) lines.push(follow);
  }
  return lines;
}

function viewTurn(turn) {
  return { user: turn.user, reply: turn.reply, toolCalls: turn.toolCalls, oracle: turn.oracle };
}

function auditorConfig(profile, env) {
  return {
    url: env[profile.env.auditorUrl] || "",
    key: env[profile.env.auditorKey] || "",
    model: env[profile.env.auditorModel] || "",
    redact: profile.redact,
    remote: profile.auditor.remote,
  };
}

async function runEpisode(ctx) {
  const { episode, behavior, profile, env, dialect, dir, hash, modelId, auditor, register } = ctx;
  const oracle = profile.oracles.find((item) => item.id === behavior.goal);
  const scripts = scriptedLines(behavior);
  const turns = [];
  const sources = [];
  let sessionId;
  let history = [];
  let hit = null;
  let scriptIndex = 0;
  const limits = profile.limits;
  const key = env[profile.env.targetKey] || undefined;
  const model = env[profile.env.targetModel] || undefined;

  while (turns.length < limits.maxTurns) {
    let user;
    let source;
    if (scriptIndex < scripts.length) {
      user = scripts[scriptIndex];
      scriptIndex += 1;
      source = "script";
    } else if (hit) {
      break;
    } else {
      let drafted;
      try {
        drafted = await draft({ behavior, transcript: turns.map(viewTurn), auditor });
      } catch (err) {
        console.log(`drafter ${behavior.id}: ${err.message}`);
        break;
      }
      if (!drafted.ok) {
        console.log(`drafter ${behavior.id}: ${drafted.reason}`);
        break;
      }
      user = drafted.message;
      source = "draft";
    }
    if (turns.length > 0 && limits.delayMs > 0) await sleep(limits.delayMs);
    let turn;
    try {
      turn = await dialect.send({
        url: env[profile.env.targetUrl],
        allowHosts: profile.allowHosts,
        key,
        model,
        user,
        sessionId,
        history,
      });
    } catch (err) {
      if (err.name !== "TransportError") throw err;
      // A transport failure is not a miss, so the register stays open.
      console.log(`ep-${episode} ${behavior.id} transport`);
      await journal(dir, behavior.id, "transport");
      return {
        kind: "transport",
        item: {
          behaviorId: behavior.id,
          goal: behavior.goal,
          impact: behavior.impact,
          evidence: "still open",
          foundAt: new Date().toISOString(),
        },
      };
    }
    turns.push(turn);
    sources.push(source);
    sessionId = turn.sessionId;
    history = [...history, { role: "user", content: user }, { role: "assistant", content: turn.reply }];
    const judged = judge(turns, oracle);
    const disclosedNow = judged.hit && judged.turnIndex === turns.length - 1;
    console.log(`ep-${episode} ${behavior.id} ${source} ${disclosedNow ? "hit" : "held"}`);
    if (judged.hit) hit = judged;
    if (hit && turns.length >= limits.minTurns) break;
  }

  const row = register.behaviors[behavior.id];
  if (hit && turns.length >= limits.minTurns) {
    const transcript = turns.map(viewTurn);
    const finding = {
      behaviorId: behavior.id,
      goal: behavior.goal,
      impact: behavior.impact,
      benign: behavior.benignOf === null,
      profileHash: hash,
      targetModel: modelId,
      turnsToHit: hit.turnIndex + 1,
      turnSources: sources,
      transcript,
      evidence: hit.evidence,
      evidenceLadder: "claimed",
      foundAt: new Date().toISOString(),
    };
    let opinion;
    try {
      opinion = await secondOpinion({ behavior, transcript, auditor });
    } catch (err) {
      opinion = { available: false, reason: err.message };
    }
    if (opinion.reason) console.log(`rubric ${behavior.id}: ${opinion.reason}`);
    if (opinion.available) {
      finding.rationale = opinion.rationale;
      finding.rubricViolation = opinion.violation;
    }
    await saveFinding(dir, "CANDIDATE", finding);
    if (opinion.available && opinion.violation === false) await saveFinding(dir, "DISAGREEMENT", { ...finding });
    row.pulls += 1;
    row.wins += 1;
    row.status = "candidate";
    await saveRegister(dir, register);
    await journal(dir, behavior.id, "hit");
    return { kind: "hit" };
  }
  if (hit) {
    await journal(dir, behavior.id, "held");
    return { kind: "held" };
  }
  row.pulls += 1;
  row.status = "exhausted";
  await saveRegister(dir, register);
  await journal(dir, behavior.id, "miss");
  await lesson(dir, {
    at: new Date().toISOString(),
    behaviorId: behavior.id,
    goal: behavior.goal,
    note: "No goal oracle hit before the episode ended.",
  });
  return { kind: "miss" };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string | undefined>, cwd?: string }} [options]
 */
export async function main(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = await loadProfile(env, cwd);
  const checked = await preflight(profile, env, cwd);
  if (!checked.ok) throw fatal(checked.errors.join("; "));
  const hash = campaignHash(profile, checked.modelId);
  const dir = campaignDir(profile.id, hash, cwd);
  const register = await loadRegister(dir, profile.behaviors);
  // targets/<id>/adapter.js replaces the dialect when the folder ships one.
  const dialect = await loadTransport(profile, env, cwd);
  const auditor = auditorConfig(profile, env);
  const openTransport = [];
  const deferred = new Set();
  let episode = 0;
  while (true) {
    // A transport row stays open on disk, but this pass must not pull it again.
    const behavior = nextBehavior(
      register,
      profile.behaviors.filter((item) => !deferred.has(item.id)),
    );
    if (!behavior) break;
    episode += 1;
    const outcome = await runEpisode({
      episode,
      behavior,
      profile,
      env,
      dialect,
      dir,
      hash,
      modelId: checked.modelId,
      auditor,
      register,
    });
    if (outcome.kind === "transport" || outcome.kind === "held") deferred.add(behavior.id);
    if (outcome.kind === "transport") openTransport.push(outcome.item);
  }
  const text = render(await loadBuckets(dir, openTransport));
  await writeSummary(dir, text);
  console.log(text);
  return { ok: true, dir, hash, modelId: checked.modelId };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) {
  main().catch((err) => {
    if (!err.printed) console.error(err.message);
    process.exit(1);
  });
}
