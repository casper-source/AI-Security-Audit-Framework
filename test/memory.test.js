// Register hashing and the one-directory rule for status files.

import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptCampaign, campaignDir, campaignHash, listCandidates, listReplayable, saveFinding } from "../engine/memory.js";
import { applyEnvText } from "../engine/run.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("hash sorts object keys and keeps array order", () => {
  const left = { b: 1, a: [1, { d: 2, c: 3 }] };
  const right = { a: [1, { c: 3, d: 2 }], b: 1 };
  assert.equal(campaignHash(left, "model-a"), campaignHash(right, "model-a"));
  assert.notEqual(campaignHash(left, "model-a"), campaignHash(left, "model-b"));
  assert.equal(campaignHash(left, "model-a").length, 12);
  const base = { id: "demo", limits: { maxTurns: 4, reproRuns: 3, reproMin: 2, maxConcurrency: 1 } };
  const tuned = { id: "demo", limits: { maxTurns: 4, reproRuns: 50, reproMin: 40, maxConcurrency: 8 } };
  const longer = { id: "demo", limits: { maxTurns: 5, reproRuns: 3, reproMin: 2, maxConcurrency: 1 } };
  assert.equal(campaignHash(base, "model"), campaignHash(tuned, "model"));
  assert.notEqual(campaignHash(base, "model"), campaignHash(longer, "model"));
  assert.equal(base.limits.reproRuns, 3);
});

test("adopt renames a hash folder and stores the current hash", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "audit-adopt-"));
  const profile = { id: "adopt-fixture", limits: { maxTurns: 1, reproRuns: 9, reproMin: 4, maxConcurrency: 1 } };
  const old = campaignDir(profile.id, "aaaaaaaaaaaa", cwd);
  await mkdir(resolve(old, "regression"), { recursive: true });
  await writeFile(resolve(old, "register.json"), "{}\n");
  await writeFile(resolve(old, "regression", "one.json"), "{\"model\":\"model\"}\n");
  try {
    const placed = await adoptCampaign(profile, "model", cwd);
    assert.equal(placed.renamedFrom, "aaaaaaaaaaaa");
    assert.equal(placed.hash, campaignHash(profile, "model"));
    assert.match(basename(placed.dir), /^\d{4}-\d{2}-\d{2}-\d{6}/);
    await access(resolve(placed.dir, "register.json"));
    const saved = JSON.parse(await readFile(resolve(placed.dir, "campaign.json"), "utf8"));
    assert.equal(saved.hash, placed.hash);
    assert.equal(saved.model, "model");
    await assert.rejects(() => access(old));
    const again = await adoptCampaign(profile, "model", cwd);
    assert.equal(again.dir, placed.dir);
    assert.equal(again.renamedFrom, null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fresh archives the active campaign and starts another folder", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "audit-fresh-"));
  const profile = { id: "fresh-fixture", limits: { maxTurns: 1 } };
  try {
    const first = await adoptCampaign(profile, "model", cwd);
    await writeFile(resolve(first.dir, "register.json"), "{}\n");
    const lines = [];
    const write = console.log;
    console.log = (line) => lines.push(String(line));
    let second;
    try {
      second = await adoptCampaign(profile, "model", cwd, { fresh: true });
    } finally {
      console.log = write;
    }
    assert.notEqual(second.dir, first.dir);
    assert.equal(second.hash, first.hash);
    const archived = JSON.parse(await readFile(resolve(first.dir, "campaign.json"), "utf8"));
    assert.equal(archived.archived, true);
    await access(resolve(first.dir, "register.json"));
    const text = lines.join("\n");
    assert.match(text, /archived audit campaign/);
    assert.match(text, /started audit campaign/);
    const resumed = await adoptCampaign(profile, "model", cwd);
    assert.equal(resumed.dir, second.dir);
    const named = await adoptCampaign(profile, "model", cwd, { campaign: basename(first.dir) });
    assert.equal(named.dir, first.dir);
    await assert.rejects(() => adoptCampaign(profile, "model", cwd, { campaign: "missing-folder" }), /No campaign folder/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("adopt keeps a timestamp folder when the profile hash changes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "audit-keep-"));
  const profile = { id: "keep-fixture", limits: { maxTurns: 1 } };
  try {
    const first = await adoptCampaign(profile, "model", cwd);
    await writeFile(resolve(first.dir, "register.json"), "{}\n");
    const lines = [];
    const write = console.log;
    console.log = (line) => lines.push(String(line));
    let second;
    try {
      second = await adoptCampaign({ id: "keep-fixture", limits: { maxTurns: 2 } }, "model", cwd);
    } finally {
      console.log = write;
    }
    assert.equal(second.dir, first.dir);
    assert.equal(second.renamedFrom, null);
    assert.notEqual(second.hash, first.hash);
    const saved = JSON.parse(await readFile(resolve(second.dir, "campaign.json"), "utf8"));
    assert.equal(saved.hash, second.hash);
    assert.match(lines.join("\n"), /kept audit campaign/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("adopt does not give one model's campaign to another model", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "audit-model-"));
  const profile = { id: "model-fixture", limits: { maxTurns: 1 } };
  const old = campaignDir(profile.id, "aaaaaaaaaaaa", cwd);
  await mkdir(resolve(old, "regression"), { recursive: true });
  await writeFile(resolve(old, "register.json"), "{}\n");
  await writeFile(resolve(old, "regression", "one.json"), "{\"model\":\"model\"}\n");
  try {
    const placed = await adoptCampaign(profile, "other-model", cwd);
    assert.notEqual(placed.dir, old);
    await access(resolve(old, "register.json"));
    const saved = JSON.parse(await readFile(resolve(placed.dir, "campaign.json"), "utf8"));
    assert.equal(saved.model, "other-model");
    assert.match(basename(placed.dir), /^\d{4}-\d{2}-\d{2}-\d{6}/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("listReplayable returns confirmed and rejected transcripts", async () => {
  const dir = campaignDir("replay-fixture", "replaytest01", root);
  const transcript = [{ user: "hello", reply: "there" }];
  try {
    await saveFinding(dir, "CONFIRMED", {
      behaviorId: "kept",
      goal: "canary",
      evidenceLadder: "verified",
      transcript,
    });
    await saveFinding(dir, "REJECTED", {
      behaviorId: "missed",
      goal: "canary",
      evidenceLadder: "claimed",
      transcript,
      rejection_reason: "1/3 hits, bar 3",
    });
    const ids = (await listReplayable(dir)).map((row) => row.behaviorId).sort();
    assert.deepEqual(ids, ["kept", "missed"]);
  } finally {
    await rm(resolve(root, "campaigns", "replay-fixture"), { recursive: true, force: true });
  }
});

test("confirm keeps a disagreement copy and reject removes it", async () => {
  const dir = campaignDir("bucket-fixture", "memorytest01", root);
  const claimed = {
    behaviorId: "alpha",
    goal: "canary",
    impact: "HIGH",
    benign: false,
    evidence: "Reply on turn 1 contained the text oracle.",
    evidenceLadder: "claimed",
    foundAt: "2026-09-28T12:00:00.000Z",
    transcript: [],
  };
  try {
    await saveFinding(dir, "CANDIDATE", claimed);
    await saveFinding(dir, "DISAGREEMENT", { ...claimed, rationale: "no", rubricViolation: false });
    assert.equal((await listCandidates(dir)).length, 1);
    await saveFinding(dir, "CONFIRMED", { ...claimed, evidenceLadder: "verified" });
    await access(resolve(dir, "findings", "alpha.json"));
    await access(resolve(dir, "disagreements", "alpha.json"));
    await assert.rejects(() => access(resolve(dir, "rejected", "alpha.json")));
    const beta = { ...claimed, behaviorId: "beta" };
    await saveFinding(dir, "CANDIDATE", beta);
    await saveFinding(dir, "DISAGREEMENT", { ...beta, rationale: "no" });
    await saveFinding(dir, "REJECTED", { ...beta, rejection_reason: "1/3 hits, bar 3" });
    await assert.rejects(() => access(resolve(dir, "findings", "beta.json")));
    await assert.rejects(() => access(resolve(dir, "disagreements", "beta.json")));
    await access(resolve(dir, "rejected", "beta.json"));
    const gamma = { ...claimed, behaviorId: "gamma" };
    await saveFinding(dir, "CANDIDATE", gamma);
    await saveFinding(dir, "DISAGREEMENT", { ...gamma, rationale: "no" });
    await saveFinding(dir, "TRANSPORT", gamma);
    await assert.rejects(() => access(resolve(dir, "findings", "gamma.json")));
    await assert.rejects(() => access(resolve(dir, "disagreements", "gamma.json")));
    await access(resolve(dir, "transport", "gamma.json"));
    assert.equal((await listCandidates(dir)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env parser lets the shell win and strips one pair of quotes", () => {
  const env = { TARGET: "from-shell", TARGET_KEY: "" };
  applyEnvText(
    [
      "# comment",
      "",
      "TARGET=from-file",
      "export TARGET_URL=\"http://127.0.0.1:8787\"  # origin",
      "TARGET_KEY=from-file",
      "AUDITOR_MODEL='local-model'",
      "AUDITOR_URL=  # unset",
      "AUDITOR_KEY=\"keep # this\"",
    ].join("\n"),
    env,
  );
  assert.equal(env.TARGET, "from-shell");
  assert.equal(env.TARGET_KEY, "");
  assert.equal(env.TARGET_URL, "http://127.0.0.1:8787");
  assert.equal(env.AUDITOR_MODEL, "local-model");
  assert.equal(env.AUDITOR_URL, "");
  assert.equal(env.AUDITOR_KEY, "keep # this");
});
