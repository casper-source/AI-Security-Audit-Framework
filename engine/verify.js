// Replays claimed findings on fresh sessions and promotes the ones that reproduce.
// The console shows one row per finished repetition. The behavior log still stores every turn.
// Must not ask a model whether the bug is real, and must not join turns into one prompt.

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { assessTurn, judge } from "./judge.js";
import { adoptCampaign, journal, listReplayable, loadRegister, saveFinding, saveRegister } from "./memory.js";
import { loadTransport, preflight } from "./preflight.js";
import { promote } from "./promote.js";
import { banner, consoleWidth, fitWidths, paintRow, ruleLine } from "./box.js";
import { loadBuckets, render, renderHtml, writeSummary } from "./report.js";
import { loadEnvFile, loadProfile } from "./run.js";
import { appendReplay, appendTurn, readUsage } from "./turnlog.js";

function fatal(line) {
  console.error(line);
  const error = new Error(line);
  error.printed = true;
  return error;
}

function oracleDescriptor(oracle) {
  if (oracle.kind === "text") return { id: oracle.id, kind: oracle.kind, strings: [...oracle.strings] };
  return { id: oracle.id, kind: oracle.kind, path: oracle.path, equals: oracle.equals };
}

const VERIFY_HEADERS = ["index", "behavior", "result", "hits", "ms", "tokens"];

function openVerifyTable(behaviorIds, runs, maxWidth) {
  const widestBehavior = behaviorIds.reduce((max, id) => Math.max(max, String(id).length), 0);
  const runDigits = String(runs).length;
  const preferred = [
    Math.max(VERIFY_HEADERS[0].length, runDigits),
    Math.max(VERIFY_HEADERS[1].length, widestBehavior),
    Math.max(VERIFY_HEADERS[2].length, "transport".length),
    Math.max(VERIFY_HEADERS[3].length, runDigits),
    Math.max(VERIFY_HEADERS[4].length, 6),
    Math.max(VERIFY_HEADERS[5].length, 6),
  ];
  const widths = fitWidths(preferred, maxWidth, preferred, [1]);
  const rule = ruleLine(widths);
  return { widths, lines: [rule, paintRow(VERIFY_HEADERS, widths), rule] };
}

async function pool(count, limit, task) {
  const results = new Array(count);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    while (cursor < count) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Keeps profile order. An empty id list replays every saved transcript.
 * @param {{ behaviors: { id: string }[] }} profile
 * @param {object[]} replayable
 * @param {string[]} [ids]
 * @returns {{ ok: true, rows: object[] } | { ok: false, error: string }}
 */
export function selectReplayable(profile, replayable, ids = []) {
  const requested = [];
  for (const id of ids) {
    const name = String(id ?? "").trim();
    if (name && !requested.includes(name)) requested.push(name);
  }
  if (requested.length === 0) return { ok: true, rows: replayable };
  const known = new Set(profile.behaviors.map((behavior) => behavior.id));
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, error: `unknown behavior: ${unknown.join(", ")}` };
  const have = new Set(replayable.map((row) => row.behaviorId));
  const missing = requested.filter((id) => !have.has(id));
  if (missing.length > 0) return { ok: false, error: `no audit transcript for ${missing.join(", ")}` };
  const wanted = new Set(requested);
  return { ok: true, rows: replayable.filter((row) => wanted.has(row.behaviorId)) };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string | undefined>, cwd?: string, behaviors?: string[] }} [options]
 */
export async function main(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? loadEnvFile(cwd);
  const profile = await loadProfile(env, cwd);
  const checked = await preflight(profile, env, cwd);
  if (!checked.ok) throw fatal(checked.errors.join("; "));
  const placed = await adoptCampaign(profile, checked.modelId, cwd);
  const hash = placed.hash;
  const dir = placed.dir;
  const register = await loadRegister(dir, profile.behaviors);
  const dialect = await loadTransport(profile, env, cwd);
  const order = new Map(profile.behaviors.map((behavior, index) => [behavior.id, index]));
  const replayable = (await listReplayable(dir)).sort(
    (left, right) => (order.get(left.behaviorId) ?? 0) - (order.get(right.behaviorId) ?? 0),
  );
  const selected = selectReplayable(profile, replayable, options.behaviors);
  if (!selected.ok) throw fatal(selected.error);
  const candidates = selected.rows;
  const key = env[profile.env.targetKey] || undefined;
  const model = env[profile.env.targetModel] || undefined;
  const url = env[profile.env.targetUrl];
  const targetModel = model || "-";
  const auditorModel = env[profile.env.auditorModel] || "-";
  console.log(`target: ${targetModel}; auditor: ${auditorModel}`);
  console.log(`reproduction runs: ${profile.limits.reproRuns}, min hit to verify: ${profile.limits.reproMin}`);
  if ((options.behaviors ?? []).some((id) => String(id ?? "").trim())) {
    console.log(`behaviors: ${candidates.map((row) => row.behaviorId).join(", ")}`);
  }

  let verifyWidths = null;
  let lastBehavior = null;
  const logVerifyRow = (behaviorId, cells) => {
    if (lastBehavior !== null && behaviorId !== lastBehavior) console.log(ruleLine(verifyWidths));
    lastBehavior = behaviorId;
    console.log(paintRow(cells, verifyWidths));
  };
  console.log("");
  console.log(banner("VERIFY LOG"));
  console.log("");
  if (candidates.length === 0) {
    console.log("no candidates");
  } else {
    const opened = openVerifyTable(
      candidates.map((item) => item.behaviorId),
      profile.limits.reproRuns,
      consoleWidth(),
    );
    verifyWidths = opened.widths;
    for (const line of opened.lines) console.log(line);
  }

  for (const finding of candidates) {
    const behavior = profile.behaviors.find((item) => item.id === finding.behaviorId);
    if (!behavior) throw new Error(`candidate has no behavior: ${finding.behaviorId}`);
    const oracle = profile.oracles.find((item) => item.id === behavior.goal);
    const runs = profile.limits.reproRuns;

    const oneRep = async (index) => {
      let totalMs = 0;
      let totalTokens = 0;
      let sawTokens = false;
      try {
        if (behavior.stateful && index > 0) {
          const started = Date.now();
          await dialect.reset({ url, allowHosts: profile.allowHosts, key, path: behavior.reset.path });
          totalMs += Date.now() - started;
        }
        let sessionId;
        let history = [];
        const turns = [];
        for (let turnIndex = 0; turnIndex < finding.transcript.length; turnIndex += 1) {
          if (turnIndex > 0 && profile.limits.delayMs > 0) await sleep(profile.limits.delayMs);
          const user = finding.transcript[turnIndex].user;
          const started = Date.now();
          let turn;
          try {
            turn = await dialect.send({
              url,
              allowHosts: profile.allowHosts,
              key,
              model,
              user,
              sessionId,
              history,
            });
          } catch (err) {
            totalMs += Date.now() - started;
            throw err;
          }
          const ms = Date.now() - started;
          totalMs += ms;
          const usage = readUsage(turn.oracle);
          if (usage.total != null) {
            totalTokens += usage.total;
            sawTokens = true;
          }
          const at = new Date().toISOString();
          turns.push(turn);
          sessionId = turn.sessionId;
          history = [...history, { role: "user", content: user }, { role: "assistant", content: turn.reply }];
          const current = assessTurn(turn, oracle, turns.length - 1);
          await appendTurn(dir, finding.behaviorId, {
            at,
            source: finding.turnSources?.[turnIndex] ?? "opening",
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
        }
        return {
          status: judge(turns, oracle).hit ? "hit" : "miss",
          sessionId,
          ms: totalMs,
          tokens: sawTokens ? totalTokens : null,
        };
      } catch (err) {
        if (err && typeof err === "object") {
          err.verifyMs = totalMs;
          err.verifyTokens = sawTokens ? totalTokens : null;
        }
        throw err;
      }
    };

    const noteReplay = (index, result, sessionId, retried) =>
      appendReplay(dir, finding.behaviorId, {
        rep: index + 1,
        sessionId,
        result,
        retried,
      });

    const finished = new Map();
    let nextIndex = 0;
    let hitsSoFar = 0;
    const emit = (index, outcome) => {
      finished.set(index, outcome);
      while (finished.has(nextIndex)) {
        const item = finished.get(nextIndex);
        finished.delete(nextIndex);
        if (item.status === "hit") hitsSoFar += 1;
        logVerifyRow(finding.behaviorId, [
          String(nextIndex + 1),
          finding.behaviorId,
          item.status,
          String(hitsSoFar),
          String(item.ms),
          item.tokens == null ? "-" : String(item.tokens),
        ]);
        nextIndex += 1;
      }
    };

    const replayWithRetry = async (index) => {
      try {
        const done = await oneRep(index);
        await noteReplay(index, done.status, done.sessionId, false);
        const outcome = { status: done.status, ms: done.ms, tokens: done.tokens };
        emit(index, outcome);
        return outcome.status;
      } catch (err) {
        if (err.name !== "TransportError") throw err;
        try {
          const done = await oneRep(index);
          await noteReplay(index, done.status, done.sessionId, true);
          const outcome = { status: done.status, ms: done.ms, tokens: done.tokens };
          emit(index, outcome);
          return outcome.status;
        } catch (retryErr) {
          if (retryErr.name !== "TransportError") throw retryErr;
          await noteReplay(index, "transport", null, true);
          const outcome = {
            status: "transport",
            ms: Number.isFinite(retryErr.verifyMs) ? retryErr.verifyMs : 0,
            tokens: retryErr.verifyTokens ?? null,
          };
          emit(index, outcome);
          return outcome.status;
        }
      }
    };

    const outcomes = behavior.stateful
      ? await (async () => {
          const sequential = [];
          for (let index = 0; index < runs; index += 1) sequential.push(await replayWithRetry(index));
          return sequential;
        })()
      : await pool(runs, profile.limits.maxConcurrency, replayWithRetry);
    const hits = outcomes.filter((item) => item === "hit").length;
    const transport = outcomes.filter((item) => item === "transport").length;
    const scored = { ...finding, reproHits: hits, reproRuns: runs };
    if (transport > 0) {
      await saveFinding(dir, "TRANSPORT", scored);
      await releaseFinding(dir, register, finding.behaviorId);
      await journal(dir, finding.behaviorId, "transport");
      continue;
    }
    if (hits >= profile.limits.reproMin) {
      // Future baseline: replay on the same model with tools off.
      // A skipped baseline must not confirm.
      const confirmed = { ...scored, evidenceLadder: "verified" };
      await saveFinding(dir, "CONFIRMED", confirmed);
      await promote(dir, {
        behaviorId: finding.behaviorId,
        profileId: profile.id,
        hash,
        model: checked.modelId,
        session: profile.session,
        turns: finding.transcript.map((turn) => turn.user),
        oracle: oracleDescriptor(oracle),
      });
      register.behaviors[finding.behaviorId].status = "confirmed";
      await saveRegister(dir, register);
      await journal(dir, finding.behaviorId, "confirmed");
      continue;
    }
    // The schedule already recorded the hit. Exhausted is reserved for a miss.
    await saveFinding(dir, "REJECTED", {
      ...scored,
      rejection_reason: `${hits}/${runs} hits, bar ${profile.limits.reproMin}`,
    });
    await releaseFinding(dir, register, finding.behaviorId);
    await journal(dir, finding.behaviorId, "rejected");
  }

  if (verifyWidths) {
    console.log(ruleLine(verifyWidths));
    console.log("\n\n");
  }
  const buckets = await loadBuckets(dir);
  await writeSummary(dir, renderHtml(buckets));
  console.log(banner("RESULTS"));
  console.log("");
  console.log(render(buckets, consoleWidth(), { verify: true }));
  return { ok: true, dir, hash, modelId: checked.modelId };
}

async function releaseFinding(dir, register, behaviorId) {
  const row = register.behaviors[behaviorId];
  if (row?.status === "confirmed") {
    row.status = "candidate";
    await saveRegister(dir, register);
  }
  await rm(resolve(dir, "regression", `${behaviorId}.json`), { force: true });
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) {
  main({ behaviors: process.argv.slice(2) }).catch((err) => {
    if (!err.printed) console.error(err.message);
    process.exit(1);
  });
}
