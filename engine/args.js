// Command-line flags for the audit program. Owns --fresh and --campaign.
// Unknown flags throw. The remaining words are behavior ids.
// Must not read a profile, open a campaign, or send a turn.

/**
 * @param {string[]} argv
 * @returns {{ fresh: boolean, campaign: string | null, behaviors: string[] }}
 */
export function parseFlags(argv) {
  let fresh = false;
  let campaign = null;
  const behaviors = [];
  const args = argv ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fresh") {
      fresh = true;
      continue;
    }
    if (arg === "--campaign") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--campaign needs a folder name");
      campaign = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    behaviors.push(arg);
  }
  return { fresh, campaign, behaviors };
}

/**
 * @param {string[]} argv
 * @returns {{ name: string | undefined, fresh: boolean, campaign: string | null, behaviors: string[] }}
 */
export function parseArgs(argv) {
  const [name, ...rest] = argv ?? [];
  return { name, ...parseFlags(rest) };
}
