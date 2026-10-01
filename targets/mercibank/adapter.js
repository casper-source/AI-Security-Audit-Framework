// Wire for the local lab agent. One new user message per call, session id after the first reply.
// The response body is the oracle object. Reply text and tool calls are extracted here.
// Must not follow redirects, widen the host allowlist, or decide an oracle hit.

import { TransportError, request } from "../../engine/transport.js";

const HEALTH_PATH = "/health";
const CHAT_PATH = "/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = "merci-assistant";

/**
 * @param {{ url: string, allowHosts: string[], key?: string }} options
 */
export async function health(options) {
  const payload = await request({ ...options, method: "GET", path: HEALTH_PATH, timeoutMs: TIMEOUT_MS });
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
    timeoutMs: TIMEOUT_MS,
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
