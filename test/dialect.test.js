// Dialect wire coverage: session, history, retry, and the host gate.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { send as sendHistory } from "../dialects/chat-history.js";
import { send as sendSession } from "../dialects/chat-session.js";
import { LINES, startMock } from "../targets/demo/mock-server.js";

const allowHosts = ["localhost", "127.0.0.1"];

test("chat-session keeps the session id and retries 429 into a hit", async () => {
  const mock = await startMock({ model: "dialect-session" });
  try {
    mock.failChat(1, 429);
    const first = await sendSession({
      url: mock.url,
      allowHosts,
      key: "target-key",
      model: "requested-model",
      user: LINES.leakFollow,
    });
    assert.equal(first.oracle.model, "dialect-session");
    assert.match(first.reply, new RegExp(LINES.canary));
    assert.equal(first.toolCalls[0].name, "fixture-lookup");
    assert.equal(mock.requests[0].authorization, "Bearer target-key");
    assert.equal(mock.requests[1].body.model, "requested-model");
    assert.equal(mock.requests[1].body.session_id, undefined);
    const second = await sendSession({
      url: mock.url,
      allowHosts,
      user: LINES.readOpening,
      sessionId: first.sessionId,
    });
    assert.equal(mock.requests.at(-1).body.session_id, first.sessionId);
    assert.equal(second.reply.includes(LINES.canary), false);
    assert.ok(mock.sessionCount() >= 1);
  } finally {
    await mock.close();
  }
});

test("chat-history resends messages and ignores session id", async () => {
  const mock = await startMock({ model: "dialect-history" });
  try {
    const first = await sendHistory({
      url: mock.url,
      allowHosts,
      user: LINES.leakOpening,
      history: [],
      sessionId: "ignore-me",
    });
    assert.equal(first.reply.includes(LINES.canary), false);
    assert.equal(mock.requests[0].body.session_id, undefined);
    const second = await sendHistory({
      url: mock.url,
      allowHosts,
      user: LINES.leakFollow,
      sessionId: first.sessionId,
      history: [
        { role: "user", content: LINES.leakOpening },
        { role: "assistant", content: first.reply },
      ],
    });
    const body = mock.requests.at(-1).body;
    assert.equal(body.session_id, undefined);
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[2].content, LINES.leakFollow);
    assert.match(second.reply, new RegExp(LINES.canary));
  } finally {
    await mock.close();
  }
});

test("a public host is refused before a socket", { timeout: 2000 }, async () => {
  await assert.rejects(
    () => sendSession({ url: "http://example.com/chat", allowHosts, user: "hi" }),
    (err) => err.name === "TransportError" && /host is not allowed/.test(err.message),
  );
  await assert.rejects(
    () => sendSession({ url: "http://user:pass@127.0.0.1:9/", allowHosts, user: "hi" }),
    (err) => err.name === "TransportError" && /userinfo/.test(err.message),
  );
});

test("HTTP 500 and a broken 200 are not retried", async () => {
  const mock = await startMock({ model: "dialect-once" });
  try {
    mock.failChat(1, 500);
    await assert.rejects(
      () => sendSession({ url: mock.url, allowHosts, user: LINES.readOpening }),
      (err) => err.name === "TransportError",
    );
    assert.equal(mock.requests.length, 1);
    mock.breakNext();
    await assert.rejects(
      () => sendSession({ url: mock.url, allowHosts, user: LINES.readOpening }),
      (err) => err.name === "TransportError" && /broken envelope/.test(err.message),
    );
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test("redirects are not followed", { timeout: 3000 }, async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(302, { location: "http://example.com/landed" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      () => sendSession({ url: `http://127.0.0.1:${server.address().port}`, allowHosts, user: "hi" }),
      (err) => err.name === "TransportError",
    );
    assert.equal(hits, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("repeated 429 becomes TransportError", { timeout: 20_000 }, async () => {
  const mock = await startMock({ model: "dialect-exhaust" });
  try {
    mock.failAllChats(429);
    await assert.rejects(
      () => sendSession({ url: mock.url, allowHosts, user: LINES.readOpening }),
      (err) => err.name === "TransportError",
    );
    assert.equal(mock.requests.length, 6);
  } finally {
    await mock.close();
  }
});
