// Coverage schedule for one profile. Owns which behavior runs next.
// Each behavior is a different test, once per target version, so file order
// is the algorithm. UCB1 would need the same arm pulled many times with
// comparable rewards; that formula is intentionally not implemented.
// Must not mark hits, write findings, or reorder the profile.

/**
 * @param {{ behaviors?: Record<string, { status?: string }> }} register
 * @param {{ id: string }[]} behaviors
 * @returns {{ id: string } | null}
 */
export function nextBehavior(register, behaviors) {
  const table = register?.behaviors ?? {};
  for (const behavior of behaviors ?? []) {
    const status = table[behavior.id]?.status ?? "open";
    // File order is the schedule. Only an open row is still unfinished.
    if (status === "open") return behavior;
  }
  return null;
}
