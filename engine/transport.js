// Shared target HTTP. Owns the host check, redirect refusal, and the retry loop.
// A 429, a 502, a timeout, or a connection failure is retried up to five times. The caller passes the timeout.
// Must not choose a path, parse a product envelope, or decide an oracle hit.

import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 10_000;
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
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export class TransportError extends Error {
  /**
   * @param {string} message
   * @param {{ retryable?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "TransportError";
    this.retryable = Boolean(options.retryable);
  }
}

/**
 * @param {string} urlString
 * @param {string[]} allowHosts
 * @returns {URL}
 */
export function assertAllowedUrl(urlString, allowHosts) {
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

/**
 * @param {{ url: string, allowHosts: string[], key?: string, method: string, path: string, payload?: object, emptyBody?: boolean, timeoutMs?: number }} options
 */
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
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
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

/**
 * @param {{ url: string, allowHosts: string[], key?: string, method: string, path: string, payload?: object, emptyBody?: boolean, timeoutMs?: number }} options
 */
export async function request(options) {
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
