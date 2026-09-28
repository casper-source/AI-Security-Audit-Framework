// Register hashing and the one-directory rule for status files.

import assert from "node:assert/strict";
import { test } from "node:test";
import { access, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { campaignDir, campaignHash, listCandidates, saveFinding } from "../engine/memory.js";
import { applyEnvText } from "../engine/run.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("hash sorts object keys and keeps array order", () => {
  const left = { b: 1, a: [1, { d: 2, c: 3 }] };
  const right = { a: [1, { c: 3, d: 2 }], b: 1 };
  assert.equal(campaignHash(left, "model-a"), campaignHash(right, "model-a"));
  assert.notEqual(campaignHash(left, "model-a"), campaignHash(left, "model-b"));
  assert.equal(campaignHash(left, "model-a").length, 12);
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
      "export TARGET_URL=\"http://127.0.0.1:8787\"",
      "TARGET_KEY=from-file",
      "AUDITOR_MODEL='local-model'",
    ].join("\n"),
    env,
  );
  assert.equal(env.TARGET, "from-shell");
  assert.equal(env.TARGET_KEY, "");
  assert.equal(env.TARGET_URL, "http://127.0.0.1:8787");
  assert.equal(env.AUDITOR_MODEL, "local-model");
});
