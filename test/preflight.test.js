// Unit coverage for preflight rejections and the demo profile contract.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContract, preflight } from "../engine/preflight.js";
import { loadProfile } from "../engine/run.js";
import { LINES, startMock } from "../targets/demo/mock-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function env(url) {
  return {
    TARGET: "demo",
    TARGET_URL: url,
    TARGET_KEY: "",
    TARGET_MODEL: "",
    AUDITOR_URL: "",
    AUDITOR_KEY: "",
    AUDITOR_MODEL: "",
  };
}

async function demoProfile() {
  return loadProfile({ TARGET: "demo" }, root);
}

test("preflight rejects a hint that contains the canary", { timeout: 2000 }, async () => {
  const profile = await demoProfile();
  profile.behaviors[0].seeds[0].hint = `leak ${LINES.canary}`;
  const result = await preflight(profile, env());
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /hint contains an oracle string/);
  assert.equal(result.modelId, null);
});

test("preflight rejects a missing benign partner", { timeout: 2000 }, async () => {
  const profile = await demoProfile();
  profile.behaviors[1].benignOf = "missing-partner";
  const result = await preflight(profile, env());
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /benign partner/);
});

test("preflight rejects a public hostname before opening a socket", { timeout: 2000 }, async () => {
  const profile = await demoProfile();
  const widened = structuredClone(profile);
  widened.allowHosts = ["example.com"];
  const shape = await preflight(widened, env());
  assert.match(shape.errors.join("\n"), /allowHosts/);

  const remote = await preflight(profile, env("http://example.com/chat"));
  assert.equal(remote.ok, false);
  assert.match(remote.errors.join("\n"), /host is not allowed: example.com/);

  const userinfo = await preflight(profile, env("http://user:pass@127.0.0.1:9/"));
  assert.match(userinfo.errors.join("\n"), /userinfo is not allowed/);

  const ipv6 = await preflight(profile, env("http://[::1]:9/"));
  assert.match(ipv6.errors.join("\n"), /host is not allowed/);
});

test("preflight rejects a remote auditor when the profile is local-only", { timeout: 2000 }, async () => {
  const profile = await demoProfile();
  const denied = await preflight(profile, {
    ...env("http://127.0.0.1:9"),
    AUDITOR_URL: "http://example.com/v1",
  });
  assert.match(denied.errors.join("\n"), /auditor host is not allowed/);
});

test("demo profile passes preflight and records the reported model", async () => {
  const mock = await startMock({ model: "preflight-ok" });
  try {
    const profile = await demoProfile();
    assert.equal(profile.behaviors[0].seeds[0].opening, LINES.readOpening);
    assert.equal(profile.behaviors[1].seeds[0].opening, LINES.leakOpening);
    assert.deepEqual(profile.behaviors[1].seeds[0].followups, [LINES.leakFollow]);
    assert.equal(profile.behaviors[2].seeds[0].opening, LINES.forbiddenOpening);
    assert.equal(profile.oracles.find((item) => item.id === "forbidden").equals, true);
    const result = await preflight(profile, env(mock.url));
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(result.modelId, "preflight-ok");
  } finally {
    await mock.close();
  }
});

test("a failed health check is one line and does not invent a model id", async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  try {
    const profile = await demoProfile();
    const result = await preflight(profile, env(`http://127.0.0.1:${port}`));
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^Target health check failed:/);
    assert.equal(result.modelId, null);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("assertContract reads flag paths and does not touch the network", () => {
  const profile = {
    oracles: [{ id: "forbidden", kind: "flag", path: "findings.forbiddenAction", equals: true }],
  };
  const present = assertContract({ oracle: { findings: { forbiddenAction: false } } }, profile);
  assert.equal(present.ok, true);
  const missing = assertContract({ oracle: { findings: {} } }, profile);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /findings\.forbiddenAction/);
});
