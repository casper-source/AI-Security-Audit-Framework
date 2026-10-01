// Runs one coverage pass: preflight, wake, orient, plan, attack, judge, reinforce.
// A transport failure stays open. A drafter failure is logged and does not hide.
// Must not confirm a finding or ask a model whether the bug is real.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { invokedDirectly } from "./entry.js";
import { setTimeout as sleep } from "node:timers/promises";
import { parse } from "yaml";
import { draft } from "./drafter.js";
import { assessTurn, judge } from "./judge.js";
import { adoptCampaign, journal, lesson, loadRegister, saveFinding, saveRegister } from "./memory.js";
import { nextBehavior } from "./planner.js";
import { loadTransport, preflight } from "./preflight.js";
import { banner, consoleWidth } from "./box.js";
import { loadBuckets, render, renderHtml, writeSummary } from "./report.js";
import { secondOpinion } from "./rubric.js";
import { appendAuditor, appendEpisode, appendTurn, closeConsoleTable, consoleTableRow, consoleTurn, openConsoleTable, readUsage } from "./turnlog.js";

// Parses KEY=value lines, skips blanks and # comments, and never overrides a key already set.
export function applyEnvText(text, env) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = (line.startsWith("export ") ? line.slice(7) : line).trim();
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    const value = stripInlineComment(body.slice(eq + 1).trim());
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function stripInlineComment(value) {
  const quote = value[0];
  const quoted = (quote === '"' || quote === "'") && value.length >= 2;
  if (quoted && value.at(-1) === quote) return value.slice(1, -1);
  if (quoted) {
    const close = value.indexOf(quote, 1);
    if (close > 0 && value.slice(close + 1).trim().startsWith("#")) return value.slice(1, close);
  }
  if (value.startsWith("#")) return "";
  const hash = value.search(/\s#/);
  return hash >= 0 ? value.slice(0, hash).trimEnd() : value;
}

export function loadEnvFile(cwd = process.cwd(), env = process.env) {
  let text = "";
  try {
    text = readFileSync(resolve(cwd, ".env"), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return applyEnvText(text, env);
}

// Accepts env, where TARGET names the folder, and an optional working directory.
// Loads and parses targets/<TARGET>/profile.yaml. Rejects a bad folder name, a missing file, or an empty document.
// Returns the profile object.
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

function scriptedTurns(behavior) {
  const planned = [];
  for (const seed of behavior.seeds) {
    planned.push({ user: seed.opening, source: "opening" });
    for (const follow of seed.followups) planned.push({ user: follow, source: "follow-up" });
  }
  return planned;
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

// Accepts the episode context: behavior, profile, env, transport, campaign dir, hash, model id, auditor, register, and logRow.
// Sends scripted turns, then asks the drafter while turns remain and the oracle has not hit. A hit before minTurns is kept. 
// Transport stays open. A miss exhausts the behavior. A finished hit is saved as claimed and may store a rubric disagreement.
// Returns { kind: "hit" | "held" | "miss" | "transport", item? }.
async function runEpisode(ctx) {
  const { behavior, profile, env, transport, dir, hash, modelId, auditor, register, logRow } = ctx;
  const oracle = profile.oracles.find((item) => item.id === behavior.goal);
  const planned = scriptedTurns(behavior);
  const turns = [];
  const sources = [];
  let sessionId;
  let history = [];
  let hit = null;
  let planIndex = 0;
  const limits = profile.limits;
  const key = env[profile.env.targetKey] || undefined;
  const model = env[profile.env.targetModel] || undefined;


  const logAuditor = async (kind, result, outcome) => {
    const at = new Date().toISOString();
    const ms = Number.isFinite(outcome?.ms) ? outcome.ms : null;
    const usage = outcome?.usage ?? { total: null, prompt: null, completion: null };
    logRow([
      at,
      behavior.id,
      "\u00b7",
      "auditor",
      result,
      ms == null ? "-" : String(ms),
      usage.total == null ? "-" : String(usage.total),
    ]);
    await appendAuditor(dir, behavior.id, { at, kind, ms, usage, result });
  };

  // Accepts the episode result and, on a hit, the 1-based turn that hit.
  // Appends the episode footer: result, session, model, and campaign hash.
  // Returns the append promise.
  const closeEpisode = (result, turnsToHit) =>
    appendEpisode(dir, behavior.id, {
      result,
      turnsToHit,
      sessionId,
      model: modelId,
      hash,
    });

  while (turns.length < limits.maxTurns) {
    let user;
    let source;
    if (planIndex < planned.length) {
      user = planned[planIndex].user;
      source = planned[planIndex].source;
      planIndex += 1;
    } else if (hit) {
      break;
    } else {
      let drafted;
      try {
        drafted = await draft({ behavior, transcript: turns.map(viewTurn), auditor });
      } catch (err) {
        drafted = { ok: false, reason: err.message || "auditor request failed" };
      }
      await logAuditor("draft", drafted.ok ? "draft ok" : `draft failed: ${drafted.reason}`, drafted);
      if (!drafted.ok) break;
      user = drafted.message;
      source = "draft";
    }
    if (turns.length > 0 && limits.delayMs > 0) await sleep(limits.delayMs);
    let turn;
    const started = Date.now();
    try {
      turn = await transport.send({
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
      const reason = typeof err.message === "string" && err.message.length > 0 ? err.message : "transport";
      logRow([new Date().toISOString(), behavior.id, "-", "-", reason, "-", "-"]);
      await closeEpisode("transport");
      await journal(dir, behavior.id, "transport");
      return {
        kind: "transport",
        item: {
          behaviorId: behavior.id,
          goal: behavior.goal,
          impact: behavior.impact,
          benign: behavior.benignOf === null,
          evidence: `still open: ${reason}`,
          foundAt: new Date().toISOString(),
        },
      };
    }
    const ms = Date.now() - started;
    const at = new Date().toISOString();
    const usage = readUsage(turn.oracle);
    turns.push({ ...turn, ms, tokens: usage.total });
    sources.push(source);
    sessionId = turn.sessionId;
    history = [...history, { role: "user", content: user }, { role: "assistant", content: turn.reply }];
    const current = assessTurn(turn, oracle, turns.length - 1);
    const judged = judge(turns, oracle);
    const outcome = current.hit ? "hit" : "held";
    logRow(consoleTurn({
      at,
      behaviorId: behavior.id,
      turn: turns.length,
      source,
      outcome,
      ms,
      total: usage.total,
    }));
    await appendTurn(dir, behavior.id, {
      at,
      source,
      ms,
      oracle: turn.oracle,
      user,
      reply: turn.reply,
      toolCalls: turn.toolCalls,
      hit: current.hit,
      pathMissing: current.pathMissing === true,
      oracleId: current.oracleId,
      matched: current.matched,
    });
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
      matched: hit.matched,
      ms: turns[hit.turnIndex].ms,
      tokens: turns[hit.turnIndex].tokens,
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
    if (opinion.available || opinion.reason) {
      const result = opinion.available ? `rubric ok violation=${opinion.violation}` : `rubric failed: ${opinion.reason}`;
      await logAuditor("rubric", result, opinion);
    }
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
    await closeEpisode("hit", hit.turnIndex + 1);
    await journal(dir, behavior.id, "hit");
    return { kind: "hit" };
  }
  if (hit) {
    await closeEpisode("hit", hit.turnIndex + 1);
    await journal(dir, behavior.id, "held");
    return { kind: "held" };
  }
  row.pulls += 1;
  row.status = "exhausted";
  await saveRegister(dir, register);
  await closeEpisode("miss");
  await journal(dir, behavior.id, "miss");
  await lesson(dir, {
    at: new Date().toISOString(),
    behaviorId: behavior.id,
    goal: behavior.goal,
    note: "No goal oracle hit before the episode ended.",
  });
  return { kind: "miss" };
}

// Accepts optional { env, cwd, fresh }. Defaults are .env in the working directory and process.cwd(). fresh archives the active campaign and starts a new folder.
// Checks the profile, then walks behaviors that are still open. A transport or held outcome is not pulled again in this pass. 
// Writes summary.html and prints the results table. Does not confirm a finding.
// Returns { ok: true, dir, hash, modelId }. A failed preflight throws the printed fatal error.
export async function main(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = await loadProfile(env, cwd);
  const checked = await preflight(profile, env, cwd);
  if (!checked.ok) throw fatal(checked.errors.join("; "));
  const placed = await adoptCampaign(profile, checked.modelId, cwd, { fresh: options.fresh === true });
  const hash = placed.hash;
  const dir = placed.dir;
  const register = await loadRegister(dir, profile.behaviors);
  const transport = await loadTransport(profile, env, cwd);
  const auditor = auditorConfig(profile, env);
  const targetModel = env[profile.env.targetModel] || "-";
  const auditorModel = auditor.model || "-";
  console.log(`target: ${targetModel}; auditor: ${auditorModel}`);
  const openTransport = [];
  const deferred = new Set();
  let episode = 0;
  let consoleWidths = null;
  let lastBehavior = null;
  // Accepts one console row as cell strings. The behavior id is the second cell.
  // Opens the turn-log table on the first row and draws a rule when the behavior changes.
  // Returns nothing.
  const logRow = (cells) => {
    if (!consoleWidths) {
      console.log(banner("TURN LOG"));
      console.log("");
      const opened = openConsoleTable(profile.behaviors.map((item) => item.id), consoleWidth());
      consoleWidths = opened.widths;
      for (const line of opened.lines) console.log(line);
    }
    const behavior = String(cells[1] ?? "");
    if (lastBehavior !== null && behavior !== lastBehavior) console.log(closeConsoleTable(consoleWidths));
    lastBehavior = behavior;
    console.log(consoleTableRow(consoleWidths, cells));
  };
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
      transport,
      dir,
      hash,
      modelId: checked.modelId,
      auditor,
      register,
      logRow,
    });
    if (outcome.kind === "transport" || outcome.kind === "held") deferred.add(behavior.id);
    if (outcome.kind === "transport") openTransport.push(outcome.item);
  }
  if (consoleWidths) {
    console.log(closeConsoleTable(consoleWidths));
    console.log("\n\n");
  }
  const buckets = await loadBuckets(dir, openTransport);
  await writeSummary(dir, renderHtml(buckets));
  console.log(banner("RESULTS"));
  console.log("");
  console.log(render(buckets, consoleWidth()));
  return { ok: true, dir, hash, modelId: checked.modelId };
}

if (invokedDirectly(import.meta.url)) {
  main().catch((err) => {
    if (!err.printed) console.error(err.message);
    process.exit(1);
  });
}
