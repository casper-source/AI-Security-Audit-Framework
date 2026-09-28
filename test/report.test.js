// Summary section order, impact sort, and the extra disagreement section.

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "../engine/report.js";

test("summary has five exclusive sections and keeps disagreement beside a claim", () => {
  const text = render({
    claimed: [
      {
        behaviorId: "leak-canary",
        goal: "canary",
        impact: "HIGH",
        evidence: "Reply on turn 2 contained the text oracle.",
        foundAt: "2026-09-28T12:00:00.000Z",
      },
    ],
    confirmed: [
      { behaviorId: "low-one", goal: "canary", impact: "LOW", evidence: "low hit" },
      { behaviorId: "crit-one", goal: "forbidden", impact: "CRITICAL", evidence: "flag hit" },
    ],
    rejected: [],
    transport: [{ behaviorId: "read-user", goal: "canary", impact: "LOW", evidence: "still open" }],
    disagreement: [{ behaviorId: "leak-canary", goal: "canary", rationale: "second opinion declines" }],
  });
  const indexes = ["claimed", "confirmed", "rejected", "transport", "disagreement"].map((name) =>
    name === "claimed" ? 0 : text.indexOf(`\n${name}\n`),
  );
  assert.deepEqual(indexes, [...indexes].sort((left, right) => left - right));
  assert.ok(indexes.every((index) => index >= 0));
  assert.ok(text.indexOf("crit-one") < text.indexOf("low-one"));
  assert.match(text, /still open/);
  assert.match(text, /claimed: second opinion declines/);
  const hidden = render({
    claimed: [],
    confirmed: [],
    rejected: [{ behaviorId: "leak-canary", goal: "canary", impact: "HIGH", rejection_reason: "0/3 hits, bar 3" }],
    transport: [],
    disagreement: [{ behaviorId: "leak-canary", goal: "canary", rationale: "no" }],
  });
  assert.match(hidden, /disagreement\n\(none\)/);
  assert.doesNotMatch(hidden, /claimed: no/);
});
