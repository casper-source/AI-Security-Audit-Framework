// Renders the five summary sections and writes summary.md.
// Claimed and confirmed are the two ladders inside findings/. Disagreement is extra.
// Must not change a finding, and must not treat disagreement as a status move.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readDirJson } from "./memory.js";

const IMPACT_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const SECTIONS = ["claimed", "confirmed", "rejected", "transport", "disagreement"];

/**
 * @param {string} dir
 * @param {object[]} [openTransport]
 */
export async function loadBuckets(dir, openTransport = []) {
  const findings = await readDirJson(resolve(dir, "findings"));
  const claimed = findings.filter((item) => item.evidenceLadder !== "verified");
  const confirmed = findings.filter((item) => item.evidenceLadder === "verified");
  const rejected = await readDirJson(resolve(dir, "rejected"));
  const transportFiles = await readDirJson(resolve(dir, "transport"));
  const disagreement = await readDirJson(resolve(dir, "disagreements"));
  const seen = new Set(
    [...claimed, ...confirmed, ...rejected, ...transportFiles].map((item) => item.behaviorId),
  );
  return {
    claimed,
    confirmed,
    rejected,
    transport: [...transportFiles, ...openTransport.filter((item) => !seen.has(item.behaviorId))],
    disagreement,
  };
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function byImpact(left, right) {
  const rank = (IMPACT_RANK[left.impact] ?? 9) - (IMPACT_RANK[right.impact] ?? 9);
  if (rank !== 0) return rank;
  return String(left.behaviorId).localeCompare(String(right.behaviorId));
}

function table(rows) {
  if (rows.length === 0) return "(none)";
  const header = ["behavior", "goal", "bucket", "evidence"];
  const body = rows.map((row) => [row.behaviorId, row.goal, row.bucket, oneLine(row.evidence)]);
  const widths = header.map((label, index) =>
    Math.max(label.length, ...body.map((line) => String(line[index] ?? "").length)),
  );
  const format = (columns) => columns.map((column, index) => String(column ?? "").padEnd(widths[index])).join("  ");
  return [format(header), ...body.map((line) => format(line))].join("\n");
}

/**
 * @param {{ claimed?: object[], confirmed?: object[], rejected?: object[], transport?: object[], disagreement?: object[] }} buckets
 * @returns {string}
 */
export function render(buckets) {
  const confirmedIds = new Set((buckets.confirmed ?? []).map((item) => item.behaviorId));
  const hidden = new Set([
    ...(buckets.rejected ?? []).map((item) => item.behaviorId),
    ...(buckets.transport ?? []).map((item) => item.behaviorId),
  ]);
  const rows = {
    claimed: (buckets.claimed ?? []).map((item) => ({
      behaviorId: item.behaviorId,
      goal: item.goal,
      bucket: "claimed",
      evidence: item.evidence,
      impact: item.impact,
      foundAt: item.foundAt,
    })),
    confirmed: (buckets.confirmed ?? []).map((item) => ({
      behaviorId: item.behaviorId,
      goal: item.goal,
      bucket: "confirmed",
      evidence: item.evidence,
      impact: item.impact,
    })),
    rejected: (buckets.rejected ?? []).map((item) => ({
      behaviorId: item.behaviorId,
      goal: item.goal,
      bucket: "rejected",
      evidence: item.rejection_reason || item.evidence,
      impact: item.impact,
    })),
    transport: (buckets.transport ?? []).map((item) => ({
      behaviorId: item.behaviorId,
      goal: item.goal,
      bucket: "transport",
      evidence: item.evidence,
      impact: item.impact,
    })),
    disagreement: [],
  };
  rows.claimed.sort((left, right) => String(left.foundAt ?? "").localeCompare(String(right.foundAt ?? "")));
  rows.confirmed.sort(byImpact);
  for (const item of buckets.disagreement ?? []) {
    if (hidden.has(item.behaviorId)) continue;
    const live = confirmedIds.has(item.behaviorId) ? "confirmed" : "claimed";
    rows.disagreement.push({
      behaviorId: item.behaviorId,
      goal: item.goal,
      bucket: "disagreement",
      evidence: `${live}: ${oneLine(item.rationale || item.evidence)}`,
    });
  }
  return SECTIONS.map((name) => `${name}\n${table(rows[name])}`).join("\n\n");
}

/**
 * @param {string} dir
 * @param {string} text
 */
export async function writeSummary(dir, text) {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "summary.md"), text.endsWith("\n") ? text : `${text}\n`);
}
