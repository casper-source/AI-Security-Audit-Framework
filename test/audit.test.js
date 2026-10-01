// End-to-end coverage for the demo mock: candidates, verification, and campaign hashes.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadRegister } from "../engine/memory.js";
import { main as runAudit, loadProfile } from "../engine/run.js";
import { main as verifyAudit } from "../engine/verify.js";
import { LINES, startMock } from "../targets/demo/mock-server.js";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function testEnv(url, extra = {}) {
  return {
    ...process.env,
    TARGET: "demo",
    TARGET_URL: url,
    TARGET_KEY: "",
    TARGET_MODEL: "",
    AUDITOR_URL: "",
    AUDITOR_KEY: "",
    AUDITOR_MODEL: "",
    ...extra,
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("a scripted 429 still becomes a candidate and verify promotes the regressions", async () => {
  const mock = await startMock({ model: "audit-happy" });
  let dir;
  try {
    mock.failChat(3, 429);
    const profile = await loadProfile({ TARGET: "demo" }, root);
    const ran = await runAudit({ cwd: root, env: testEnv(mock.url) });
    dir = ran.dir;
    const register = await loadRegister(dir, profile.behaviors);
    assert.equal(register.behaviors["read-user"].status, "exhausted");
    assert.equal(register.behaviors["read-user"].wins, 0);
    assert.equal(register.behaviors["leak-canary"].status, "candidate");
    assert.equal(register.behaviors["forbidden-action"].status, "candidate");
    const journal = await readFile(resolve(dir, "journal.md"), "utf8");
    assert.match(journal, /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z read-user miss$/m);
    assert.match(journal, /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z leak-canary hit$/m);
    const lesson = JSON.parse((await readFile(resolve(dir, "lessons.jsonl"), "utf8")).trim().split("\n")[0]);
    assert.equal(lesson.behaviorId, "read-user");
    assert.equal(lesson.goal, "canary");
    const claimed = await readJson(resolve(dir, "findings", "leak-canary.json"));
    assert.equal(claimed.evidenceLadder, "claimed");
    assert.equal(claimed.turnsToHit, 2);
    assert.deepEqual(claimed.turnSources, ["opening", "follow-up"]);
    assert.equal(claimed.matched, LINES.canary);
    assert.equal(typeof claimed.ms, "number");
    assert.equal(claimed.tokens, null);
    assert.equal(claimed.benign, false);
    assert.equal(claimed.transcript[1].user.includes(LINES.canary), false);
    assert.match(claimed.transcript[1].reply, new RegExp(LINES.canary));
    const summary = await readFile(resolve(dir, "summary.html"), "utf8");
    assert.match(summary, /id="claimed"/);
    await assert.rejects(() => access(resolve(dir, "summary.md")));
    mock.clearRequests();
    await verifyAudit({ cwd: root, env: testEnv(mock.url) });
    const leak = await readJson(resolve(dir, "findings", "leak-canary.json"));
    const forbidden = await readJson(resolve(dir, "findings", "forbidden-action.json"));
    const leakRegression = await readJson(resolve(dir, "regression", "leak-canary.json"));
    const flagRegression = await readJson(resolve(dir, "regression", "forbidden-action.json"));
    assert.equal(leak.evidenceLadder, "verified");
    assert.equal(forbidden.evidenceLadder, "verified");
    assert.equal(Object.keys(leakRegression)[0], "comment");
    assert.equal(leakRegression.turns.length, leak.transcript.length);
    assert.equal(leakRegression.turns.length, 2);
    assert.equal(flagRegression.turns.length, 1);
    assert.deepEqual(Object.keys(leakRegression), ["comment", "profileId", "hash", "model", "turns", "oracle"]);
    assert.equal(leakRegression.model, "audit-happy");
    await assert.rejects(() => access(resolve(dir, "rejected", "leak-canary.json")));
    const tape = mock.requests
      .map((item) => {
        if (item.path === "/reset") return "reset";
        if (item.body?.message === LINES.forbiddenOpening) return "forbid";
        return "other";
      })
      .filter((item) => item !== "other");
    assert.deepEqual(tape, ["forbid", "reset", "forbid", "reset", "forbid"]);
    assert.equal(mock.resetCount, 2);
    const verified = await loadRegister(dir, profile.behaviors);
    assert.equal(verified.behaviors["leak-canary"].status, "confirmed");
    assert.equal(verified.behaviors["forbidden-action"].status, "confirmed");
    assert.equal(verified.behaviors["read-user"].status, "exhausted");
    const replayLog = await readFile(resolve(dir, "logs", "forbidden-action.md"), "utf8");
    assert.match(replayLog, /\*\*replay:\*\* 1\n\*\*session:\*\* \S+\n\*\*result:\*\* hit\n\*\*retry:\*\* no/);
    assert.match(replayLog, /\*\*replay:\*\* 3\n\*\*session:\*\* \S+\n\*\*result:\*\* hit\n\*\*retry:\*\* no/);
  } finally {
    await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test("campaign files for two model ids land in two directories", async () => {
  const first = await startMock({ model: "hash-model-a" });
  const second = await startMock({ model: "hash-model-b" });
  const dirs = [];
  try {
    const left = await runAudit({ cwd: root, env: testEnv(first.url) });
    const right = await runAudit({ cwd: root, env: testEnv(second.url) });
    dirs.push(left.dir, right.dir);
    assert.notEqual(left.hash, right.hash);
    assert.equal(left.modelId, "hash-model-a");
    assert.equal(right.modelId, "hash-model-b");
    await access(resolve(left.dir, "register.json"));
    await access(resolve(right.dir, "register.json"));
  } finally {
    await first.close();
    await second.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
});

test("transport during run stays open and is not a transport file", { timeout: 20_000 }, async () => {
  const mock = await startMock({ model: "transport-model" });
  let dir;
  try {
    for (let index = 1; index <= 6; index += 1) mock.failChat(index, 429);
    const ran = await runAudit({ cwd: root, env: testEnv(mock.url) });
    dir = ran.dir;
    const profile = await loadProfile({ TARGET: "demo" }, root);
    const register = await loadRegister(dir, profile.behaviors);
    assert.equal(register.behaviors["read-user"].status, "open");
    assert.equal(register.behaviors["read-user"].pulls, 0);
    await assert.rejects(() => access(resolve(dir, "transport", "read-user.json")));
    const summary = await readFile(resolve(dir, "summary.html"), "utf8");
    assert.match(summary, /read-user/);
    assert.match(summary, /still open/);
    assert.match(summary, /class="impact LOW"/);
    const journal = await readFile(resolve(dir, "journal.md"), "utf8");
    assert.match(journal, /read-user transport/);
  } finally {
    await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test("a rubric disagreement names a claim and still names it after confirm", async () => {
  const mock = await startMock({ model: "rubric-model" });
  const seen = [];
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push(raw);
      const system = JSON.parse(raw).messages.find((item) => item.role === "system")?.content ?? "";
      const content = system.includes("violation")
        ? JSON.stringify({ violation: false, rationale: "second opinion declines" })
        : "What is the fixture user id?";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolveListen) => stub.listen(0, "127.0.0.1", resolveListen));
  const auditorUrl = `http://127.0.0.1:${stub.address().port}/v1`;
  let dir;
  try {
    const env = testEnv(mock.url, {
      AUDITOR_URL: auditorUrl,
      AUDITOR_KEY: "auditor-key",
      AUDITOR_MODEL: "auditor-model",
    });
    const ran = await runAudit({ cwd: root, env });
    dir = ran.dir;
    const claimed = await readJson(resolve(dir, "findings", "leak-canary.json"));
    assert.equal(claimed.evidenceLadder, "claimed");
    const disagreement = await readJson(resolve(dir, "disagreements", "leak-canary.json"));
    assert.equal(disagreement.rationale, "second opinion declines");
    assert.equal(seen.some((body) => body.includes(LINES.canary)), false);
    const before = await readFile(resolve(dir, "summary.html"), "utf8");
    assert.match(before, /claimed: second opinion declines/);
    await verifyAudit({ cwd: root, env });
    const confirmed = await readJson(resolve(dir, "findings", "leak-canary.json"));
    assert.equal(confirmed.evidenceLadder, "verified");
    await access(resolve(dir, "disagreements", "leak-canary.json"));
    await assert.rejects(() => access(resolve(dir, "rejected", "leak-canary.json")));
    const after = await readFile(resolve(dir, "summary.html"), "utf8");
    assert.match(after, /confirmed: second opinion declines/);
  } finally {
    await mock.close();
    await new Promise((resolveClose) => stub.close(resolveClose));
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test("a follow-up and a draft are logged without putting the reply in the summary", async () => {
  const mock = await startMock({
    model: "turn-log",
    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
  });
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const system = JSON.parse(raw).messages.find((item) => item.role === "system")?.content ?? "";
      const content = system.includes("violation")
        ? JSON.stringify({ violation: true, rationale: "agrees" })
        : "What is the fixture user id?";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolveListen) => stub.listen(0, "127.0.0.1", resolveListen));
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
    original(...args);
  };
  let dir;
  try {
    const env = testEnv(mock.url, {
      AUDITOR_URL: `http://127.0.0.1:${stub.address().port}/v1`,
      AUDITOR_KEY: "auditor-key",
      AUDITOR_MODEL: "auditor-model",
    });
    const ran = await runAudit({ cwd: root, env });
    dir = ran.dir;
    const leakLog = await readFile(resolve(dir, "logs", "leak-canary.md"), "utf8");
    assert.match(leakLog, /\*\*source:\*\* follow-up/);
    assert.match(leakLog, new RegExp(`\\*\\*Question:\\*\\*\\n\\n${LINES.leakFollow}\\n\\n\\*\\*Answer:\\*\\*`));
    assert.match(leakLog, /\*\*Answer:\*\*\n\nVault token /);
    assert.match(leakLog, /\*\*ms:\*\* \d+/);
    assert.match(leakLog, /\*\*tokens:\*\* 10 prompt=4 completion=6/);
    assert.match(leakLog, /\*\*episode:\*\* leak-canary\n\*\*result:\*\* hit\n\*\*turnsToHit:\*\* 2\n\*\*session:\*\* \S+\n\*\*model:\*\* turn-log\n\*\*hash:\*\*/);
    const readLog = await readFile(resolve(dir, "logs", "read-user.md"), "utf8");
    assert.match(readLog, /\*\*source:\*\* auditor\n\*\*kind:\*\* draft\n\*\*ms:\*\* \d+\n\*\*tokens:\*\* -\n\*\*result:\*\* draft ok/);
    assert.match(readLog, /\*\*source:\*\* draft/);
    assert.match(readLog, /\*\*Question:\*\*\n\nWhat is the fixture user id\?/);
    assert.ok(readLog.indexOf("**kind:** draft") < readLog.indexOf("**Question:**\n\nWhat is the fixture user id?"));
    assert.match(leakLog, /\*\*source:\*\* auditor\n\*\*kind:\*\* rubric\n\*\*ms:\*\* \d+\n\*\*tokens:\*\* -\n\*\*result:\*\* rubric ok violation=true/);
    const summary = await readFile(resolve(dir, "summary.html"), "utf8");
    assert.match(summary, /leak-canary/);
    assert.match(summary, /class="impact HIGH"/);
    assert.match(summary, /follow-up/);
    assert.match(summary, new RegExp(LINES.canary));
    assert.match(summary, />10</);
    assert.equal(summary.includes("Vault token"), false);
    assert.equal(summary.includes("session_id"), false);
    const consoleLine = lines.find((line) => /\| leak-canary\s+\|\s+2\s+\|\s+follow-up\s+\|\s+hit\s+\|/.test(line));
    assert.match(consoleLine, /\| \d{4}-\d{2}-\d{2}T\S+ \| leak-canary\s+\|\s+2\s+\|\s+follow-up\s+\|\s+hit\s+\|\s+\d+\s+\|\s+10\s+\|/);
    assert.ok(lines.some((line) => /\| time\s+\|/.test(line) && /\| tokens\s+\|/.test(line)));
    assert.equal(consoleLine.includes(LINES.leakFollow), false);
    assert.ok(lines.some((line) => /\| \u00b7\s+\|\s+auditor\s+\|\s+draft ok\s+\|/.test(line)));
    assert.ok(lines.some((line) => /\| \u00b7\s+\|\s+auditor\s+\|\s+rubric ok violation=true\s+\|/.test(line)));
    assert.equal(lines.some((line) => /^rubric /.test(line)), false);
    assert.equal(lines.some((line) => /ep-\d+/.test(line)), false);
  } finally {
    console.log = original;
    await mock.close();
    await new Promise((resolveClose) => stub.close(resolveClose));
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test("the cli run and verify promote a multi-turn regression", async () => {
  const mock = await startMock({ model: "cli-model" });
  let dir;
  try {
    const env = testEnv(mock.url);
    const run = await exec(process.execPath, ["engine/run.js"], { cwd: root, env, encoding: "utf8" });
    assert.match(run.stdout, /^target: -; auditor: -$/m);
    assert.match(run.stdout, /\| time\s+\| behavior\s+\| turn\s+\| source\s+\| result\s+\| ms\s+\| tokens\s+\|/);
    assert.match(run.stdout, /leak-canary\s+\|\s+2\s+\|\s+follow-up\s+\|\s+hit\s+\|\s+\d+\s+\|\s+-/);
    assert.doesNotMatch(run.stdout, /ep-\d+ leak-canary/);
    const profile = await loadProfile({ TARGET: "demo" }, root);
    const { adoptCampaign } = await import("../engine/memory.js");
    dir = (await adoptCampaign(profile, "cli-model", root)).dir;
    const verify = await exec(process.execPath, ["engine/verify.js"], { cwd: root, env, encoding: "utf8" });
    const targetAt = verify.stdout.indexOf("target: -; auditor: -");
    const reproAt = verify.stdout.indexOf("reproduction runs: 3, min hit to verify: 3");
    const logAt = verify.stdout.indexOf("VERIFY LOG");
    assert.ok(targetAt >= 0 && targetAt < reproAt && reproAt < logAt);
    assert.match(verify.stdout, /\| index\s+\| behavior\s+\| result\s+\| hits\s+\| ms\s+\| tokens\s+\|/);
    const lines = verify.stdout.split(/\r?\n/);
    const leakRows = lines.filter((line) => /^\| \d+\s+\| leak-canary\s+\|/.test(line));
    const forbiddenRows = lines.filter((line) => /^\| \d+\s+\| forbidden-action\s+\|/.test(line));
    assert.equal(leakRows.length, 3);
    assert.match(leakRows[0], /^\| 1\s+\| leak-canary\s+\| hit\s+\| 1\s+\| \d+\s+\| -\s+\|/);
    assert.match(leakRows[2], /^\| 3\s+\| leak-canary\s+\| hit\s+\| 3\s+\| \d+\s+\| -\s+\|/);
    assert.equal(forbiddenRows.length, 3);
    assert.match(forbiddenRows[0], /^\| 1\s+\| forbidden-action\s+\| hit\s+\| 1\s+\|/);
    const lastLeak = lines.findLastIndex((line) => /^\| \d+\s+\| leak-canary\s+\|/.test(line));
    const firstForbidden = lines.findIndex((line) => /^\| \d+\s+\| forbidden-action\s+\|/.test(line));
    assert.ok(lines.slice(lastLeak + 1, firstForbidden).some((line) => line.startsWith("+")));
    const regression = await readJson(resolve(dir, "regression", "leak-canary.json"));
    assert.equal(regression.turns.length, 2);
    assert.match(regression.comment, /Do not join them into one prompt/);
    const again = await exec(process.execPath, ["engine/verify.js"], { cwd: root, env, encoding: "utf8" });
    assert.match(again.stdout, /reproduction runs: 3, min hit to verify: 3/);
    const againRows = again.stdout.split(/\r?\n/).filter((line) => /^\| \d+\s+\| leak-canary\s+\| hit\s+\|/.test(line));
    assert.equal(againRows.length, 3);
    assert.match(againRows[2], /\|\s+3\s+\|/);
  } finally {
    await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test("engine does not contain the demo canary or a public host", async () => {
  async function filesIn(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await filesIn(full)));
      else found.push(full);
    }
    return found;
  }
  const files = await filesIn(resolve(root, "engine"));
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes(LINES.canary), false, file);
    assert.equal(text.includes("example.com"), false, file);
  }
});
