// Summary section order, impact sort, and the extra disagreement section.

import assert from "node:assert/strict";
import { test } from "node:test";
import { render, renderHtml } from "../engine/report.js";

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
  assert.match(text, /behavior\s+\|\s+goal\s+\|\s+impact\s+\|\s+evidence\s+\|\s+benign\s+\|\s+turn\s+\|\s+source\s+\|\s+matched\s+\|\s+ms\s+\|\s+tokens/);
  assert.match(text, /crit-one\s+\|\s+forbidden\s+\|\s+CRITICAL\s+\|/);
  assert.match(text, /still open\s+\|\s+-\s+\|\s+-\s+\|\s+-\s+\|\s+-\s+\|\s+-\s+\|\s+-/);
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

test("a narrow results table wraps evidence inside the cell", () => {
  const evidence = "Reply on turn 2 contained a fairly long oracle value that should wrap.";
  const text = render({
    claimed: [{
      behaviorId: "leak-canary",
      goal: "canary",
      impact: "HIGH",
      evidence,
      foundAt: "2026-09-28T12:00:00.000Z",
      benign: false,
      turnsToHit: 2,
      turnSources: ["opening", "follow-up"],
      matched: "ORACLE-VALUE",
      ms: 12,
      tokens: 10,
    }],
    confirmed: [],
    rejected: [],
    transport: [],
    disagreement: [],
  }, 120);
  const ruled = text.split("\n").filter((line) => line.startsWith("+") || line.startsWith("|"));
  assert.ok(ruled.every((line) => line.length <= 120));
  assert.ok(ruled.some((line) => line.includes("follow-up")));
  const reply = ruled.findIndex((line) => line.includes("Reply on turn"));
  const tail = ruled.findIndex((line) => line.includes("should wrap."));
  assert.ok(reply >= 0 && tail > reply);
});

test("html summary keeps the five sections and escapes evidence", () => {
  const html = renderHtml({
    claimed: [{ behaviorId: "leak-canary", goal: "canary", impact: "HIGH", evidence: "saw <tag>", foundAt: "2026-09-28T12:00:00.000Z" }],
    confirmed: [
      { behaviorId: "low-one", goal: "canary", impact: "LOW", evidence: "low hit" },
      { behaviorId: "crit-one", goal: "forbidden", impact: "CRITICAL", evidence: "flag hit" },
    ],
    rejected: [],
    transport: [],
    disagreement: [{ behaviorId: "leak-canary", goal: "canary", rationale: "second opinion declines" }],
  });
  const indexes = ["claimed", "confirmed", "rejected", "transport", "disagreement"].map((name) => html.indexOf(`id="${name}"`));
  assert.deepEqual(indexes, [...indexes].sort((left, right) => left - right));
  assert.ok(html.indexOf("crit-one") < html.indexOf("low-one"));
  assert.match(html, /claimed: second opinion declines/);
  assert.match(html, /saw &lt;tag&gt;/);
  assert.equal(html.includes("<tag>"), false);
  assert.match(html, /<th class="sortable" data-sort="index" tabindex="0">index<\/th>/);
  assert.match(html, /<th class="sortable" data-sort="impact" tabindex="0">impact<\/th>/);
  assert.match(html, /<tr data-index="1" data-impact="CRITICAL"><td>1<\/td>/);
  assert.match(html, /<tr data-index="2" data-impact="LOW"><td>2<\/td>/);
  assert.match(html, /CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3/);
  assert.doesNotMatch(html, /<th>bucket<\/th>/);
  const consoleText = render({
    claimed: [{ behaviorId: "leak-canary", goal: "canary", impact: "HIGH", evidence: "saw tag", foundAt: "2026-09-28T12:00:00.000Z" }],
    confirmed: [],
    rejected: [],
    transport: [],
    disagreement: [],
  });
  assert.match(consoleText, /behavior\s+\|\s+goal\s+\|\s+impact/);
  assert.doesNotMatch(consoleText, /\|\s+index\s+\|/);
});
