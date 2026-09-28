// Writes the regression artifact for one confirmed behavior.
// The turns stay an ordered array so a later run can replay them one by one.
// Must not collapse turns into one string, and must not emit a Promptfoo config.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * @param {string} dir
 * @param {{ behaviorId: string, profileId: string, hash: string, model: string, session: string, turns: string[], oracle: object }} spec
 */
export async function promote(dir, spec) {
  const body = {
    comment: "Replay these user turns with the dialect session mode and assert the oracle. Do not join them into one prompt.",
    profileId: spec.profileId,
    hash: spec.hash,
    model: spec.model,
    session: spec.session,
    turns: spec.turns,
    oracle: spec.oracle,
  };
  const folder = resolve(dir, "regression");
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, `${spec.behaviorId}.json`), `${JSON.stringify(body, null, 2)}\n`);
}
