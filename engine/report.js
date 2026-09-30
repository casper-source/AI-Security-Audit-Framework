// Renders the five summary sections and writes summary.html.
// Claimed and confirmed are the two ladders inside findings/. Disagreement is extra.
// Must not change a finding, and must not treat disagreement as a status move.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fitWidths, paintRow, ruleLine } from "./box.js";
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

function hitColumns(item) {
  const turn = Number.isInteger(item.turnsToHit) && item.turnsToHit > 0 ? String(item.turnsToHit) : "-";
  return {
    benign: typeof item.benign === "boolean" ? String(item.benign) : "-",
    turn,
    source: turn === "-" ? "-" : String(item.turnSources?.[item.turnsToHit - 1] ?? "-"),
    matched: item.matched == null || item.matched === "" ? "-" : oneLine(item.matched),
    ms: item.ms == null ? "-" : String(item.ms),
    tokens: item.tokens == null ? "-" : String(item.tokens),
  };
}

function impactLabel(item) {
  return typeof item.impact === "string" && item.impact.length > 0 ? item.impact : "-";
}

function tableCells(row) {
  const hit = hitColumns(row);
  return [row.behaviorId, row.goal, impactLabel(row), oneLine(row.evidence), hit.benign, hit.turn, hit.source, hit.matched, hit.ms, hit.tokens];
}

function table(rows, maxWidth) {
  if (rows.length === 0) return "(none)";
  const header = ["behavior", "goal", "impact", "evidence", "benign", "turn", "source", "matched", "ms", "tokens"];
  const body = rows.map((row) => tableCells(row));
  const preferred = header.map((label, index) =>
    Math.max(label.length, ...body.map((line) => String(line[index] ?? "").length)),
  );
  const flex = header.map((label, index) => (label === "evidence" || label === "matched" ? index : -1)).filter((index) => index >= 0);
  const floors = preferred.map((width, index) => (flex.includes(index) ? Math.min(width, index === flex[0] ? 28 : 16) : width));
  const widths = fitWidths(preferred, maxWidth, floors, flex);
  const rule = ruleLine(widths);
  return [rule, paintRow(header, widths), rule, ...body.map((line) => paintRow(line, widths)), rule].join("\n");
}

function sectionRows(buckets) {
  const confirmedIds = new Set((buckets.confirmed ?? []).map((item) => item.behaviorId));
  const hidden = new Set([
    ...(buckets.rejected ?? []).map((item) => item.behaviorId),
    ...(buckets.transport ?? []).map((item) => item.behaviorId),
  ]);
  const rows = {
    claimed: (buckets.claimed ?? []).map((item) => ({ ...item })),
    confirmed: (buckets.confirmed ?? []).map((item) => ({ ...item })),
    rejected: (buckets.rejected ?? []).map((item) => ({
      ...item,
      evidence: item.rejection_reason || item.evidence,
    })),
    transport: (buckets.transport ?? []).map((item) => ({ ...item })),
    disagreement: [],
  };
  rows.claimed.sort((left, right) => String(left.foundAt ?? "").localeCompare(String(right.foundAt ?? "")));
  rows.confirmed.sort(byImpact);
  for (const item of buckets.disagreement ?? []) {
    if (hidden.has(item.behaviorId)) continue;
    const live = confirmedIds.has(item.behaviorId) ? "confirmed" : "claimed";
    rows.disagreement.push({
      ...item,
      evidence: `${live}: ${oneLine(item.rationale || item.evidence)}`,
    });
  }
  return rows;
}

/**
 * @param {{ claimed?: object[], confirmed?: object[], rejected?: object[], transport?: object[], disagreement?: object[] }} buckets
 * @param {number} [maxWidth]
 * @returns {string}
 */
export function render(buckets, maxWidth) {
  const rows = sectionRows(buckets);
  return SECTIONS.map((name) => `${name}\n${table(rows[name], maxWidth)}`).join("\n\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlTable(rows) {
  if (rows.length === 0) return `<p class="empty">(none)</p>`;
  const header = ["behavior", "goal", "impact", "evidence", "benign", "turn", "source", "matched", "ms", "tokens"];
  const head = [
    `<th class="sortable" data-sort="index" tabindex="0">index</th>`,
    ...header.map((label) => label === "impact"
      ? `<th class="sortable" data-sort="impact" tabindex="0">${label}</th>`
      : `<th>${label}</th>`),
  ].join("");
  const body = rows.map((row, position) => {
    const impact = impactLabel(row);
    const cells = tableCells(row).map((value, index) => {
      const text = escapeHtml(value);
      if (header[index] === "impact" && text !== "-") return `<td class="impact ${escapeHtml(text)}">${text}</td>`;
      return `<td>${text}</td>`;
    });
    return `<tr data-index="${position + 1}" data-impact="${escapeHtml(impact)}"><td>${position + 1}</td>${cells.join("")}</tr>`;
  }).join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

const SORT_SCRIPT = `<script>
document.querySelectorAll("th.sortable").forEach((header) => {
  const sort = () => {
    const table = header.closest("table");
    const body = table.tBodies[0];
    const key = header.dataset.sort;
    const ranks = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const next = key === "impact"
      ? (header.dataset.dir === "high" ? "low" : "high")
      : (header.dataset.dir === "asc" ? "desc" : "asc");
    table.querySelectorAll("th.sortable").forEach((other) => { other.dataset.dir = ""; });
    header.dataset.dir = next;
    const rows = Array.from(body.rows);
    rows.sort((left, right) => {
      const leftIndex = Number(left.dataset.index);
      const rightIndex = Number(right.dataset.index);
      if (key === "index") return next === "asc" ? leftIndex - rightIndex : rightIndex - leftIndex;
      const leftRank = Object.prototype.hasOwnProperty.call(ranks, left.dataset.impact) ? ranks[left.dataset.impact] : null;
      const rightRank = Object.prototype.hasOwnProperty.call(ranks, right.dataset.impact) ? ranks[right.dataset.impact] : null;
      if ((leftRank === null) !== (rightRank === null)) return leftRank === null ? 1 : -1;
      if (leftRank === null) return leftIndex - rightIndex;
      const delta = next === "high" ? leftRank - rightRank : rightRank - leftRank;
      return delta === 0 ? leftIndex - rightIndex : delta;
    });
    rows.forEach((row) => body.appendChild(row));
  };
  header.addEventListener("click", sort);
  header.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      sort();
    }
  });
});
</script>`;

/**
 * @param {{ claimed?: object[], confirmed?: object[], rejected?: object[], transport?: object[], disagreement?: object[] }} buckets
 * @returns {string}
 */
export function renderHtml(buckets) {
  const rows = sectionRows(buckets);
  const sections = SECTIONS.map((name) => `<section id="${name}"><h2>${name}</h2>\n${htmlTable(rows[name])}</section>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Audit summary</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; margin: 28px; color: #1c1c1c; background: #f4f2ec; }
  h1 { font-size: 1.5rem; margin: 0 0 1.4rem; }
  section { margin: 0 0 1.8rem; }
  h2 { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 0.45rem; color: #3f3c36; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #e3dfd4; }
  th { font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase; color: #5e594f; }
  th.sortable { cursor: pointer; }
  th.sortable:hover { color: #1c1c1c; }
  th[data-dir="high"]::after,
  th[data-dir="asc"]::after { content: " \\25B2"; }
  th[data-dir="low"]::after,
  th[data-dir="desc"]::after { content: " \\25BC"; }
  .empty { color: #6d685e; margin: 0; }
  .impact { font-weight: 650; }
  .CRITICAL { color: #8d1d18; }
  .HIGH { color: #9a4d12; }
  .MEDIUM { color: #6d5a12; }
  .LOW { color: #2d5a32; }
</style>
</head>
<body>
<h1>Audit summary</h1>
${sections}
${SORT_SCRIPT}
</body>
</html>
`;
}

/**
 * @param {string} dir
 * @param {string} html
 */
export async function writeSummary(dir, html) {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "summary.html"), html.endsWith("\n") ? html : `${html}\n`);
  await rm(resolve(dir, "summary.md"), { force: true });
}
