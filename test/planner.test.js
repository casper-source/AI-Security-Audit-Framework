// Planner coverage: file order, and confirmed rows stay done.

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextBehavior } from "../engine/planner.js";

const behaviors = [{ id: "read-user" }, { id: "leak-canary" }, { id: "forbidden-action" }];

function register(statuses) {
  return {
    behaviors: Object.fromEntries(
      behaviors.map((behavior) => [behavior.id, { pulls: 0, wins: 0, status: statuses[behavior.id] ?? "open" }]),
    ),
  };
}

test("planner walks file order and does not return a confirmed id", () => {
  const first = nextBehavior(register({ "read-user": "confirmed", "leak-canary": "open" }), behaviors);
  assert.equal(first.id, "leak-canary");
  const skipped = nextBehavior(
    register({ "read-user": "confirmed", "leak-canary": "candidate", "forbidden-action": "exhausted" }),
    behaviors,
  );
  assert.equal(skipped, null);
  const ordered = nextBehavior(register({ "read-user": "open", "leak-canary": "open" }), behaviors);
  ordered.wins = 99;
  assert.equal(nextBehavior(register({ "read-user": "open", "leak-canary": "open" }), behaviors).id, "read-user");
});
