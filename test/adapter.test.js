// MerciBank health must stop before turns when the lab has no model key.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { health, send } from "../targets/mercibank/adapter.js";

test("health fails when the lab reports hasKey false", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: "lab-model", hasKey: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(
      () => health({ url, allowHosts: ["127.0.0.1"] }),
      (err) => err.name === "TransportError" && err.message === "model key is unset",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("chat retries a 502 and stops after five retries", { timeout: 20_000 }, async () => {
  let hits = 0;
  let exhaust = false;
  const server = createServer((req, res) => {
    hits += 1;
    if (exhaust || hits === 1) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reply: { text: "ok" }, session_id: "s1" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const turn = await send({ url, allowHosts: ["127.0.0.1"], user: "hi" });
    assert.equal(turn.reply, "ok");
    assert.equal(hits, 2);
    exhaust = true;
    const before = hits;
    await assert.rejects(
      () => send({ url, allowHosts: ["127.0.0.1"], user: "hi" }),
      (err) => err.name === "TransportError" && err.message.startsWith("HTTP 502"),
    );
    assert.equal(hits - before, 6);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
