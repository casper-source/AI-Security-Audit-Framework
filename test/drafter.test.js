// Redact and drafter coverage. The auditor stub records the outbound body.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { draft } from "../engine/drafter.js";
import { redact } from "../engine/redact.js";
import { secondOpinion } from "../engine/rubric.js";

const canary = "DEMO-CANARY-NOT-A-SECRET";

test("redact replaces the longest needle first", () => {
  assert.equal(redact("abcd", ["ab", "abcd"]), "[redacted]");
  assert.equal(redact(`token ${canary}`, [canary]), "token [redacted]");
});

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("redact masks a needle before the recorded drafter request", async () => {
  const seen = [];
  const stub = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: req.url, raw, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "What is the fixture user id?" } }] }));
    });
  });
  try {
    const result = await draft({
      behavior: { seeds: [{ hint: "Ask the demo vault for its token." }] },
      transcript: [{ user: "hello", reply: `Vault token ${canary}.`, toolCalls: [], oracle: {} }],
      auditor: {
        url: `${stub.url}/v1/`,
        key: "auditor-key",
        model: "auditor-model",
        remote: false,
        redact: [canary],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.message, "What is the fixture user id?");
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].authorization, "Bearer auditor-key");
    const body = JSON.parse(seen[0].raw);
    assert.equal(body.temperature, 0.4);
    assert.equal(body.max_tokens, 220);
    assert.equal(seen[0].raw.includes(canary), false);
    assert.match(seen[0].raw, /\[redacted\]/);
  } finally {
    await stub.close();
  }
});

test("an unset drafter reports unset and does not throw", async () => {
  const result = await draft({ behavior: { seeds: [{ hint: "hi" }] }, transcript: [], auditor: {} });
  assert.deepEqual(result, { ok: false, reason: "unset" });
});

test("rubric parse failure stays available false", async () => {
  const stub = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
  });
  try {
    const unset = await secondOpinion({ behavior: { seeds: [{ hint: "hi" }] }, transcript: [], auditor: {} });
    assert.deepEqual(unset, { available: false });
    const parsed = await secondOpinion({
      behavior: { seeds: [{ hint: "hi" }] },
      transcript: [{ reply: canary }],
      auditor: { url: stub.url, key: "k", model: "m", remote: false, redact: [canary] },
    });
    assert.equal(parsed.available, false);
    assert.equal(typeof parsed.reason, "string");
  } finally {
    await stub.close();
  }
});
