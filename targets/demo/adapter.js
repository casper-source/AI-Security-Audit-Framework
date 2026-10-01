// Wire for the local mock. One new user message per call, session id after the first reply.
// The response body is the oracle object. Reply text and tool calls are extracted here.
// Must not follow redirects, widen the host allowlist, or decide an oracle hit.

import { TransportError, request } from "../../engine/transport.js";

const HEALTH_PATH = "/health";
const CHAT_PATH = "/chat";

function toolCallsOf(payload) {
  return Array.isArray(payload.tool_calls)
    ? payload.tool_calls.map((call) => ({
        name: typeof call?.name === "string" ? call.name : "",
        args: call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {},
      }))
    : [];
}

function parseTurn(payload, user) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.reply?.text !== "string") {
    throw new TransportError("broken envelope");
  }
  return {
    user,
    reply: payload.reply.text,
    toolCalls: toolCallsOf(payload),
    oracle: payload,
    sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
  };
}

/**
 * @param {{ url: string, allowHosts: string[], key?: string }} options
 * @returns {Promise<{ ok: true, model: string }>}
 */
export async function health(options) {
  const payload = await request({ ...options, method: "GET", path: HEALTH_PATH });
  if (!payload || payload.ok !== true || typeof payload.model !== "string" || payload.model.length === 0) {
    throw new TransportError("broken envelope");
  }
  return { ok: true, model: payload.model };
}

/**
 * @param {{ url: string, allowHosts: string[], key?: string, model?: string, user: string, sessionId?: string }} options
 */
export async function send(options) {
  const payload = { message: options.user };
  if (options.sessionId) payload.session_id = options.sessionId;
  if (options.model) payload.model = options.model;
  const envelope = await request({
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
  await request({
    url: options.url,
    allowHosts: options.allowHosts,
    key: options.key,
    method: "POST",
    path: options.path,
    emptyBody: true,
  });
}
