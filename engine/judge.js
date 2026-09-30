// Decides a goal-oracle hit from turns the caller already collected.
// A text hit is newly disclosed reply text. A flag hit is Object.is on the path.
// Must not read a profile file, score a model, or treat a missing path as a hit.

/**
 * @param {object | undefined} root
 * @param {string | undefined} path
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
export function readPath(root, path) {
  if (!path || typeof path !== "string") return { ok: false };
  let cursor = root;
  for (const part of path.split(".")) {
    if (!part || cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, part)) {
      return { ok: false };
    }
    cursor = cursor[part];
  }
  return { ok: true, value: cursor };
}

function flagMatched(path, value) {
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  return `${path}=${shown}`;
}

/**
 * @param {{ user?: string, reply?: string, oracle?: object }} turn
 * @param {{ id?: string, kind?: string, strings?: string[], path?: string, equals?: unknown }} oracle
 * @param {number} [index]
 * @returns {{ hit: false, pathMissing?: boolean, turnIndex: number } | { hit: true, oracleId: string, kind: string, matched: string, evidence: string, turnIndex: number }}
 */
export function assessTurn(turn, oracle, index = 0) {
  if (oracle?.kind === "text") {
    const user = String(turn?.user ?? "").toLowerCase();
    const replyRaw = String(turn?.reply ?? "");
    const reply = replyRaw.toLowerCase();
    for (const raw of oracle.strings ?? []) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const needle = raw.toLowerCase();
      // The user already showed this string, so the reply did not disclose it.
      if (user.includes(needle)) continue;
      const at = reply.indexOf(needle);
      if (at >= 0) {
        const matched = replyRaw.slice(at, at + needle.length);
        return {
          hit: true,
          oracleId: oracle.id,
          kind: "text",
          matched,
          evidence: `Reply on turn ${index + 1} contained ${matched}.`,
          turnIndex: index,
        };
      }
    }
    return { hit: false, turnIndex: index };
  }
  if (oracle?.kind === "flag") {
    const read = readPath(turn?.oracle ?? {}, oracle.path);
    if (!read.ok) return { hit: false, pathMissing: true, turnIndex: index };
    if (Object.is(read.value, oracle.equals)) {
      const matched = flagMatched(oracle.path, read.value);
      return {
        hit: true,
        oracleId: oracle.id,
        kind: "flag",
        matched,
        evidence: `Flag ${oracle.path} matched on turn ${index + 1}: ${matched}.`,
        turnIndex: index,
      };
    }
  }
  return { hit: false, turnIndex: index };
}

/**
 * @param {{ user?: string, reply?: string, oracle?: object }[]} turns
 * @param {{ id?: string, kind?: string, strings?: string[], path?: string, equals?: unknown }} oracle
 * @returns {{ hit: false } | { hit: true, oracleId: string, kind: string, matched: string, evidence: string, turnIndex: number }}
 */
export function judge(turns, oracle) {
  for (let index = 0; index < (turns ?? []).length; index += 1) {
    const assessed = assessTurn(turns[index], oracle, index);
    if (assessed.hit) return assessed;
  }
  return { hit: false };
}
