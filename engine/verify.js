// Replays claimed findings on fresh sessions and promotes the ones that reproduce.
// Transport is retried once, then filed as transport. A miss against the bar is rejected.
// Must not ask a model whether the bug is real, and must not join turns into one prompt.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { judge } from "./judge.js";
import { campaignDir, campaignHash, journal, listCandidates, loadRegister, saveFinding, saveRegister } from "./memory.js";
import { loadTransport, preflight } from "./preflight.js";
import { promote } from "./promote.js";
import { loadBuckets, render, writeSummary } from "./report.js";
import { loadEnvFile, loadProfile } from "./run.js";

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
  const dialect = await loadTransport(profile, env, cwd);
  const order = new Map(profile.behaviors.map((behavior, index) => [behavior.id, index]));
  const candidates = (await listCandidates(dir)).sort(
    (left, right) => (order.get(left.behaviorId) ?? 0) - (order.get(right.behaviorId) ?? 0),
  );
  const key = env[profile.env.targetKey] || undefined;
  const model = env[profile.env.targetModel] || undefined;
  const url = env[profile.env.targetUrl];

  for (const finding of candidates) {
    const behavior = profile.behaviors.find((item) => item.id === finding.behaviorId);
    if (!behavior) throw new Error(`candidate has no behavior: ${finding.behaviorId}`);
    const oracle = profile.oracles.find((item) => item.id === behavior.goal);
    const runs = profile.limits.reproRuns;

    const oneRep = async (index) => {
      if (behavior.stateful && index > 0) {
        await dialect.reset({ url, allowHosts: profile.allowHosts, key, path: behavior.reset.path });
      }
      let sessionId;
      let history = [];
      const turns = [];
      for (let turnIndex = 0; turnIndex < finding.transcript.length; turnIndex += 1) {
        if (turnIndex > 0 && profile.limits.delayMs > 0) await sleep(profile.limits.delayMs);
        const user = finding.transcript[turnIndex].user;
        const turn = await dialect.send({
          url,
          allowHosts: profile.allowHosts,
          key,
          model,
          user,
          sessionId,
          history,
        });
        turns.push(turn);
        sessionId = turn.sessionId;
        history = [...history, { role: "user", content: user }, { role: "assistant", content: turn.reply }];
      }
      return judge(turns, oracle).hit ? "hit" : "miss";
    };

    const replayWithRetry = async (index) => {
      try {
        return await oneRep(index);
      } catch (err) {
        if (err.name !== "TransportError") throw err;
        try {
          return await oneRep(index);
        } catch (retryErr) {
          if (retryErr.name !== "TransportError") throw retryErr;
          return "transport";
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
    if (transport > 0) {
      await saveFinding(dir, "TRANSPORT", finding);
      await journal(dir, finding.behaviorId, "transport");
      continue;
    }
    if (hits >= profile.limits.reproMin) {
      // Future baseline: replay on the same model with tools off.
      // A skipped baseline must not confirm.
      const confirmed = { ...finding, evidenceLadder: "verified" };
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
      ...finding,
      rejection_reason: `${hits}/${runs} hits, bar ${profile.limits.reproMin}`,
    });
    await journal(dir, finding.behaviorId, "rejected");
  }

  const text = render(await loadBuckets(dir));
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
