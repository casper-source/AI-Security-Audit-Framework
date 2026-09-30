// Append-only turn log for one behavior. Run and verify share this writer.
// The log is not read back. Cached, audio, and reasoning token fields are dropped.

import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fitWidths, paintRow, ruleLine } from "./box.js";

const chains = new Map();

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {object | undefined} body
 * @returns {{ total: number | null, prompt: number | null, completion: number | null }}
 */
export function readUsage(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") return { total: null, prompt: null, completion: null };
  return {
    total: finite(usage.total_tokens),
    prompt: finite(usage.prompt_tokens),
    completion: finite(usage.completion_tokens),
  };
}

function tokenLine(usage) {
  if (usage.total == null) return "tokens: -";
  let line = `tokens: ${usage.total}`;
  if (usage.prompt != null) line += ` prompt=${usage.prompt}`;
  if (usage.completion != null) line += ` completion=${usage.completion}`;
  return line;
}

function formatTools(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "(none)";
  return toolCalls
    .map((call) => `${call?.name ?? ""} ${JSON.stringify(call?.args ?? {})}`)
    .join("; ");
}

function judgeLine(entry) {
  if (entry.pathMissing) return "oracle path missing";
  if (entry.hit) return `hit ${entry.oracleId} ${entry.matched}`;
  return "held";
}

async function writeLine(dir, behaviorId, text) {
  const folder = resolve(dir, "logs");
  await mkdir(folder, { recursive: true });
  const file = resolve(folder, `${behaviorId}.md`);
  const previous = chains.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => appendFile(file, text));
  chains.set(file, current.then(() => undefined, () => undefined));
  return current;
}

/**
 * @param {string} dir
 * @param {string} behaviorId
 * @param {{ at: string, source: string, ms: number, oracle?: object, user: string, reply: string, toolCalls?: { name?: string, args?: object }[], hit?: boolean, pathMissing?: boolean, oracleId?: string, matched?: string }} entry
 */
export async function appendTurn(dir, behaviorId, entry) {
  const text = [
    `### ${entry.at}`,
    `source: ${entry.source}`,
    `ms: ${entry.ms}`,
    tokenLine(readUsage(entry.oracle)),
    `Question: ${entry.user}`,
    `Answer: ${entry.reply}`,
    `Tools: ${formatTools(entry.toolCalls)}`,
    `Judge: ${judgeLine(entry)}`,
    "",
    "",
  ].join("\n");
  await writeLine(dir, behaviorId, text);
}

/**
 * @param {string} dir
 * @param {string} behaviorId
 * @param {{ result: string, turnsToHit?: number, sessionId?: string | null, model: string, hash: string }} fields
 */
export async function appendEpisode(dir, behaviorId, fields) {
  const session = fields.sessionId || "-";
  const lines = [`episode ${behaviorId}`, `result=${fields.result}`];
  if (fields.result === "hit" && fields.turnsToHit) lines.push(`turnsToHit=${fields.turnsToHit}`);
  lines.push(`session=${session}`, `model=${fields.model}`, `hash=${fields.hash}`, "", "");
  await writeLine(dir, behaviorId, `${lines.join("\n")}\n`);
}

/**
 * @param {string} dir
 * @param {string} behaviorId
 * @param {{ rep: number, sessionId?: string | null, result: string, retried: boolean }} fields
 */
export async function appendReplay(dir, behaviorId, fields) {
  const session = fields.sessionId || "-";
  await writeLine(
    dir,
    behaviorId,
    `replay ${fields.rep} session=${session} result=${fields.result} retry=${fields.retried ? "yes" : "no"}\n\n`,
  );
}

const CONSOLE_HEADERS = ["time", "behavior", "turn", "source", "result", "ms", "tokens"];

/**
 * @param {string[]} behaviorIds
 * @param {number} [maxWidth]
 * @returns {{ widths: number[], lines: string[] }}
 */
export function openConsoleTable(behaviorIds, maxWidth) {
  const widestBehavior = (behaviorIds ?? []).reduce((max, id) => Math.max(max, String(id).length), 0);
  const preferred = [
    Math.max(CONSOLE_HEADERS[0].length, 24),
    Math.max(CONSOLE_HEADERS[1].length, widestBehavior),
    Math.max(CONSOLE_HEADERS[2].length, 4),
    Math.max(CONSOLE_HEADERS[3].length, "follow-up".length),
    Math.max(CONSOLE_HEADERS[4].length, "failed: unset".length, "transport".length),
    Math.max(CONSOLE_HEADERS[5].length, 6),
    Math.max(CONSOLE_HEADERS[6].length, 8),
  ];
  const floors = [24, preferred[1], 4, "follow-up".length, 12, 6, 6];
  const widths = fitWidths(preferred, maxWidth, floors, [1, 4]);
  const rule = ruleLine(widths);
  return { widths, lines: [rule, paintRow(CONSOLE_HEADERS, widths), rule] };
}

/**
 * @param {number[]} widths
 * @param {string[]} cells
 * @returns {string}
 */
export function consoleTableRow(widths, cells) {
  return paintRow(cells, widths);
}

/**
 * @param {number[]} widths
 * @returns {string}
 */
export function closeConsoleTable(widths) {
  return ruleLine(widths);
}

/**
 * @param {{ at: string, behaviorId: string, turn: number, source: string, outcome: string, ms: number, total: number | null }} entry
 * @returns {string[]}
 */
export function consoleTurn(entry) {
  const total = entry.total == null ? "-" : String(entry.total);
  return [entry.at, entry.behaviorId, String(entry.turn), entry.source, entry.outcome, String(entry.ms), total];
}
