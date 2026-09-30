// Wire for the local lab agent. One new user message per call, session id after the first reply.
// The response body is the oracle object. Reply text and tool calls are extracted here.
// Must not follow redirects, widen the host allowlist, or decide an oracle hit.

import { setTimeout as sleep } from "node:timers/promises";
import { TransportError, assertAllowedUrl } from "../../dialects/chat-session.js";

const HEALTH_PATH = "/health";
const CHAT_PATH = "/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const BACKOFF_MS = [200, 400, 800, 1600, 3200];
const MAX_RETRIES = 5;
const DEFAULT_MODEL = "merci-assistant";

function httpFailure(status, text) {
  let detail = "";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error?.message === "string" && parsed.error.message.length > 0) detail = `: ${parsed.error.message}`;
  } catch {
    detail = "";
  }
  return `HTTP ${status}${detail}`;
}

function causedByConnection(err) {
  if (!err || typeof err !== "object") return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const code = err.code || err.cause?.code;
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EAI_AGAIN" || code === "ETIMEDOUT" || Boolean(err.cause && err.cause !== err && causedByConnection(err.cause));
}

async function once(endpoint, options) {
  const headers = {};
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  let body;
  if (options.method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.payload ?? {});
  }
  const response = await fetch(endpoint, {
    method: options.method,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers,
    body,
  });
  if (response.status === 429) throw new TransportError("HTTP 429", { retryable: true });
  const text = await response.text();
  if (response.status === 502) throw new TransportError(httpFailure(response.status, text), { retryable: true });
  if (!response.ok) throw new TransportError(httpFailure(response.status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new TransportError("broken envelope");
  }
}

async function request(options) {
  const origin = assertAllowedUrl(options.url, options.allowHosts);
  const endpoint = new URL(options.path, origin);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await once(endpoint, options);
    } catch (err) {
      const retryable = err.name === "TransportError" ? Boolean(err.retryable) : causedByConnection(err);
      if (!retryable || attempt === MAX_RETRIES) {
        if (err.name === "TransportError") throw err;
        throw new TransportError(err.message || "transport failure");
      }
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw new TransportError("transport failure");
}

/**
 * @param {{ url: string, allowHosts: string[], key?: string }} options
 */
export async function health(options) {
  const payload = await request({ ...options, method: "GET", path: HEALTH_PATH });
  if (!payload || payload.ok !== true || typeof payload.model !== "string" || payload.model.length === 0) {
    throw new TransportError("broken envelope");
  }
  if (payload.hasKey === false) throw new TransportError("model key is unset");
  return { ok: true, model: payload.model };
}

/**
 * @param {{ url: string, allowHosts: string[], key?: string, model?: string, user: string, sessionId?: string }} options
 */
export async function send(options) {
  const payload = {
    model: options.model || DEFAULT_MODEL,
    messages: [{ role: "user", content: options.user }],
  };
  if (options.sessionId) payload.session_id = options.sessionId;
  const envelope = await request({
    url: options.url,
    allowHosts: options.allowHosts,
    key: options.key,
    method: "POST",
    path: CHAT_PATH,
    payload,
  });
  if (typeof envelope?.reply?.text !== "string") throw new TransportError("broken envelope");
  const toolCalls = Array.isArray(envelope.tool_calls)
    ? envelope.tool_calls.map((call) => ({
        name: typeof call?.name === "string" ? call.name : "",
        args: call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {},
      }))
    : [];
  return {
    user: options.user,
    reply: envelope.reply.text,
    toolCalls,
    oracle: envelope,
    sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
  };
}

/**
 * Fresh sessions are new ids. This target has no reset route.
 * @param {{ url: string, allowHosts: string[], key?: string, path: string }} _options
 */
export async function reset(_options) {
  return;
}
