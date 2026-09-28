// Resend-history dialect. Each call posts the full user and assistant transcript.
// The body is { messages }. A session id on the options object is ignored.
// Must not redact the target request, follow redirects, or decide an oracle hit.

import { setTimeout as sleep } from "node:timers/promises";

const HEALTH_PATH = "/health";
const CHAT_PATH = "/chat";
const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [200, 400, 800, 1600, 3200];
const MAX_RETRIES = 5;
const DEFAULT_HOSTS = new Set(["localhost", "127.0.0.1"]);
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export class TransportError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TransportError";
    this.retryable = Boolean(options.retryable);
  }
}

function assertAllowedUrl(urlString, allowHosts) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new TransportError("invalid target url");
  }
  if (url.username || url.password) throw new TransportError("userinfo is not allowed");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TransportError("protocol is not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const narrowed = (allowHosts ?? []).map((item) => String(item).toLowerCase());
  if (host === "::1" || !DEFAULT_HOSTS.has(host) || !narrowed.includes(host)) {
    throw new TransportError(`host is not allowed: ${host}`);
  }
  return url;
}

function causedByConnection(err) {
  if (!err || typeof err !== "object") return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const code = err.code || err.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return Boolean(err.cause && err.cause !== err && causedByConnection(err.cause));
}

function redirectError(err) {
  const text = `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
  return /redirect/i.test(text);
}

async function once(endpoint, options) {
  const headers = {};
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  let body;
  if (options.emptyBody) body = "";
  else if (options.method !== "GET") {
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
  if (!response.ok) throw new TransportError(`HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new TransportError("broken envelope");
  }
}

async function targetRequest(options) {
  const origin = assertAllowedUrl(options.url, options.allowHosts);
  const endpoint = new URL(options.path, origin);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await once(endpoint, options);
    } catch (err) {
      if (redirectError(err)) throw new TransportError("redirects are not followed");
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

function parseTurn(payload, user) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.reply?.text !== "string") {
    throw new TransportError("broken envelope");
  }
  const toolCalls = Array.isArray(payload.tool_calls)
    ? payload.tool_calls.map((call) => ({
        name: typeof call?.name === "string" ? call.name : "",
        args: call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {},
      }))
    : [];
  return {
    user,
    reply: payload.reply.text,
    toolCalls,
    oracle: payload,
    sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
  };
}

/**
 * @param {{ url: string, allowHosts: string[], key?: string }} options
 * @returns {Promise<{ ok: true, model: string }>}
 */
export async function health(options) {
  const payload = await targetRequest({ ...options, method: "GET", path: HEALTH_PATH });
  if (!payload || payload.ok !== true || typeof payload.model !== "string" || payload.model.length === 0) {
    throw new TransportError("broken envelope");
  }
  return { ok: true, model: payload.model };
}

/**
 * @param {{ url: string, allowHosts: string[], key?: string, model?: string, user: string, history?: { role: string, content: string }[], sessionId?: string }} options
 */
export async function send(options) {
  const payload = {
    messages: [...(options.history ?? []), { role: "user", content: options.user }],
  };
  if (options.model) payload.model = options.model;
  const envelope = await targetRequest({
    url: options.url,
    allowHosts: options.allowHosts,
    key: options.key,
    method: "POST",
    path: CHAT_PATH,
    payload,
  });
  return parseTurn(envelope, options.user);
}

/**
 * @param {{ url: string, allowHosts: string[], key?: string, path: string }} options
 */
export async function reset(options) {
  await targetRequest({
    url: options.url,
    allowHosts: options.allowHosts,
    key: options.key,
    method: "POST",
    path: options.path,
    emptyBody: true,
  });
}
