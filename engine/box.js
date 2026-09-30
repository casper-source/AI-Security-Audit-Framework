// Bordered text tables. Cells wrap when the table would be wider than maxWidth.
// A missing maxWidth keeps one line per cell.

/**
 * @returns {number | undefined}
 */
export function consoleWidth() {
  if (!process.stdout.isTTY) return undefined;
  const width = process.stdout.columns;
  return Number.isInteger(width) && width >= 40 ? width : undefined;
}

/**
 * @param {string} title
 * @returns {string}
 */
export function banner(title) {
  const width = Math.max(title.length + 8, Math.min(consoleWidth() || 44, 56));
  const gap = Math.max(0, width - title.length);
  const left = Math.floor(gap / 2);
  const line = "=".repeat(width);
  return `${line}\n${" ".repeat(left)}${title}\n${line}`;
}

/**
 * Shrinks flexible columns first. Short columns stay at their text width until those hit the floor.
 * @param {number[]} preferred
 * @param {number | undefined} maxWidth
 * @param {number[]} [floors]
 * @param {number[]} [flex]
 * @returns {number[]}
 */
export function fitWidths(preferred, maxWidth, floors = [], flex = []) {
  const widths = preferred.map((width) => Math.max(1, width));
  if (!Number.isInteger(maxWidth) || maxWidth < 1) return widths;
  const limit = maxWidth - (3 * widths.length + 1);
  if (limit <= 0) return widths.map(() => 1);
  const floor = widths.map((width, index) => Math.max(1, Math.min(width, floors[index] ?? width)));
  const flexSet = new Set(flex);
  let used = widths.reduce((sum, width) => sum + width, 0);
  const shrink = (allow, minimums) => {
    while (used > limit) {
      let index = -1;
      let best = -1;
      for (let i = 0; i < widths.length; i += 1) {
        if (!allow(i) || widths[i] <= minimums[i] || widths[i] <= best) continue;
        best = widths[i];
        index = i;
      }
      if (index < 0) return false;
      widths[index] -= 1;
      used -= 1;
    }
    return true;
  };
  const flexLow = floor.map((value, index) => (flexSet.has(index) ? Math.min(value, 8) : value));
  const tight = widths.map((_, index) => (flexSet.has(index) ? 4 : Math.min(4, floor[index])));
  if (!shrink((index) => flexSet.has(index), floor)) {
    if (!shrink((index) => flexSet.has(index), flexLow)) {
      if (!shrink(() => true, tight)) shrink(() => true, widths.map(() => 1));
    }
  }
  return widths;
}

/**
 * @param {unknown} value
 * @param {number} width
 * @returns {string[]}
 */
export function wrapText(value, width) {
  const text = String(value ?? "");
  if (width < 1 || text.length <= width) return [text];
  const lines = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) lines.push(rest);
  return lines.length > 0 ? lines : [""];
}

/**
 * @param {number[]} widths
 * @returns {string}
 */
export function ruleLine(widths) {
  return `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
}

/**
 * @param {unknown[]} cells
 * @param {number[]} widths
 * @returns {string}
 */
export function paintRow(cells, widths) {
  const wrapped = cells.map((cell, index) => wrapText(cell, widths[index]));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));
  const lines = [];
  for (let line = 0; line < height; line += 1) {
    const parts = wrapped.map((cellLines, index) => ` ${(cellLines[line] ?? "").padEnd(widths[index])} `);
    lines.push(`|${parts.join("|")}|`);
  }
  return lines.join("\n");
}
