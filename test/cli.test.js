// Command list, campaign lookup, and the status table. No browser and no target socket.

import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs, parseFlags } from "../engine/args.js";
import { HELP, cleanCommand, formatStatus, listCampaigns, listSummaryCampaigns, locateCampaign, statusCommand, summaryCommand } from "../engine/cli.js";
import { selectReplayable } from "../engine/verify.js";
import { campaignDir, campaignHash } from "../engine/memory.js";

test("verify ids keep profile order and leave the rest out", () => {
  const profile = { behaviors: [{ id: "read-user" }, { id: "leak-canary" }, { id: "forbidden-action" }] };
  const rows = [
    { behaviorId: "read-user" },
    { behaviorId: "leak-canary" },
    { behaviorId: "forbidden-action" },
  ];
  assert.deepEqual(selectReplayable(profile, rows, []).rows.map((row) => row.behaviorId), ["read-user", "leak-canary", "forbidden-action"]);
  const picked = selectReplayable(profile, rows, ["forbidden-action", "read-user"]);
  assert.deepEqual(picked.rows.map((row) => row.behaviorId), ["read-user", "forbidden-action"]);
  assert.equal(selectReplayable(profile, rows, ["missing"]).ok, false);
  assert.equal(selectReplayable(profile, rows.filter((row) => row.behaviorId !== "read-user"), ["read-user"]).ok, false);
});

test("help names the daily npm commands", () => {
  for (const name of ["npm run check", "npm run audit", "npm run clean", "npm run verify", "npm run status", "npm run summary", "npm run logs", "npm run mock", "npm test", "--fresh", "--campaign"]) {
    assert.match(HELP, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("flags separate a campaign folder from behavior ids", () => {
  const parsed = parseArgs(["verify", "--campaign", "2026-10-01-171140", "recovery-key"]);
  assert.equal(parsed.name, "verify");
  assert.equal(parsed.campaign, "2026-10-01-171140");
  assert.deepEqual(parsed.behaviors, ["recovery-key"]);
  assert.equal(parseFlags(["--fresh"]).fresh, true);
  assert.throws(() => parseFlags(["--campaign"]), /needs a folder name/);
  assert.throws(() => parseFlags(["--other"]), /Unknown option/);
});

test("the newest local campaign is the one with the later summary", async () => {
  const root = resolve(tmpdir(), `audit-cli-${Date.now()}`);
  const older = campaignDir("cli-fixture", "aaaaaaaaaaaa", root);
  const newer = campaignDir("cli-fixture", "bbbbbbbbbbbb", root);
  await mkdir(older, { recursive: true });
  await mkdir(newer, { recursive: true });
  await writeFile(resolve(older, "summary.html"), "<p>old</p>\n");
  await writeFile(resolve(newer, "register.json"), "{}\n");
  const early = new Date("2026-09-01T00:00:00.000Z");
  const late = new Date("2026-09-02T00:00:00.000Z");
  await utimes(resolve(older, "summary.html"), early, early);
  await utimes(resolve(newer, "register.json"), late, late);
  const listed = await listCampaigns(root, "cli-fixture");
  assert.deepEqual(listed.map((item) => item.hash), ["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
});

test("status follows the profile order and leaves a missing behavior open", () => {
  const text = formatStatus(
    [{ id: "read-user" }, { id: "leak-canary" }],
    { behaviors: { "leak-canary": { status: "candidate", pulls: 1, wins: 1 } } },
  );
  const lines = text.split("\n").map((line) => line.trim());
  assert.match(lines[0], /^behavior\s+status\s+pulls\s+wins$/);
  assert.match(lines[1], /^read-user\s+open\s+0\s+0$/);
  assert.match(lines[2], /^leak-canary\s+candidate\s+1\s+1$/);
});

test("summary opens the most recently modified summary.html", async () => {
  const root = resolve(tmpdir(), `audit-cli-summary-${Date.now()}`);
  const profile = { id: "cli-fixture", behaviors: [{ id: "read-user" }] };
  const hash = campaignHash(profile, "live-model");
  const active = campaignDir(profile.id, hash, root);
  const other = campaignDir(profile.id, "2026-10-01-120000", root);
  await mkdir(active, { recursive: true });
  await mkdir(resolve(active, "logs"), { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(resolve(active, "summary.html"), "<p>active</p>\n");
  await writeFile(resolve(active, "register.json"), JSON.stringify({ behaviors: { "read-user": { status: "open", pulls: 0, wins: 0 } } }));
  await writeFile(resolve(other, "summary.html"), "<p>newer</p>\n");
  const early = new Date("2026-09-01T00:00:00.000Z");
  const late = new Date("2026-09-02T00:00:00.000Z");
  await utimes(resolve(active, "summary.html"), early, early);
  await utimes(resolve(other, "summary.html"), late, late);
  const checked = { ok: true, errors: [], modelId: "live-model" };
  const listed = await listSummaryCampaigns(root, profile.id);
  assert.equal(listed[0].dir, other);
  const opened = [];
  await summaryCommand({ cwd: root, profile, checked, open: async (file) => { opened.push(file); } });
  assert.deepEqual(opened, [resolve(other, "summary.html")]);
});

test("status still follows the active campaign for the live model", async () => {
  const root = resolve(tmpdir(), `audit-cli-live-${Date.now()}`);
  const profile = { id: "cli-fixture", behaviors: [{ id: "read-user" }] };
  const hash = campaignHash(profile, "live-model");
  const dir = campaignDir(profile.id, hash, root);
  const other = campaignDir(profile.id, "zzzzzzzzzzzz", root);
  await mkdir(dir, { recursive: true });
  await mkdir(resolve(dir, "logs"), { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(resolve(dir, "summary.html"), "<p>live</p>\n");
  await writeFile(resolve(dir, "register.json"), JSON.stringify({ behaviors: { "read-user": { status: "open", pulls: 0, wins: 0 } } }));
  await writeFile(resolve(other, "summary.html"), "<p>other</p>\n");
  const checked = { ok: true, errors: [], modelId: "live-model" };
  const found = await locateCampaign({ cwd: root, profile, checked });
  assert.equal(found.source, "health");
  assert.equal(found.hash, hash);
  assert.match(basename(found.dir), /^\d{4}-\d{2}-\d{2}-\d{6}/);
  assert.notEqual(found.dir, dir);
  const lines = [];
  const write = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await statusCommand({ cwd: root, profile, checked });
  } finally {
    console.log = write;
  }
  assert.match(lines[0], new RegExp(`cli-fixture  ${hash}  live-model`));
  assert.match(lines[1], /read-user\s+open\s+0\s+0/);
});

test("clean removes only the current target campaigns and does not run", async () => {
  const root = resolve(tmpdir(), `audit-cli-clean-${Date.now()}`);
  const target = campaignDir("cli-fixture", "aaaaaaaaaaaa", root);
  const other = campaignDir("other-fixture", "bbbbbbbbbbbb", root);
  await mkdir(target, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(resolve(target, "register.json"), "{}\n");
  await writeFile(resolve(other, "register.json"), "{}\n");
  const removed = await cleanCommand({
    cwd: root,
    profile: { id: "cli-fixture" },
  });
  assert.equal(removed.ok, true);
  await assert.rejects(() => access(target));
  await access(resolve(other, "register.json"));
});
