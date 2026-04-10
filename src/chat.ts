/**
 * Platform chat interface.
 *
 * Mirrors the Telegram channel pattern: each platform user gets a stable
 * session key derived from their user ID, and the plugin handles routing so
 * the caller doesn't need to know openclaw's internal key format.
 *
 * Session key format: agent:{agentId}:platform:direct:{userId}
 *
 * RPC methods exposed to the platform (intercepted in PLUGIN_HANDLERS):
 *   platform.chat.send    — send a message on behalf of a user
 *   platform.chat.history — fetch conversation history for a user
 *   platform.chat.abort   — abort an in-flight run for a user
 *   platform.chat.reset   — reset (clear) a user's session
 *   platform.session.resolve — return the computed session key
 */

import type { PluginLogger } from "openclaw/plugin-sdk";
import type {
  RpcRequest,
  RpcResponse,
  PlatformChatSendParams,
  PlatformChatHistoryParams,
  PlatformChatAbortParams,
  PlatformChatResetParams,
  PlatformSessionResolveParams,
} from "./types.js";

// ---------------------------------------------------------------------------
// Session key
// ---------------------------------------------------------------------------

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_TRAILING_DASH_RE = /^-+|-+$/g;

function normalizeId(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (VALID_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_TRAILING_DASH_RE, "")
      .slice(0, 64) || ""
  );
}

/**
 * Build the openclaw session key for a platform user.
 * Mirrors buildAgentPeerSessionKey with dmScope="per-channel-peer".
 *
 * Format: agent:{agentId}:platform:direct:{userId}
 */
export function buildPlatformSessionKey(
  agentId: string | null | undefined,
  userId: string,
): string {
  const agent = normalizeId(agentId) || "main";
  const user = normalizeId(userId) || "unknown";
  return `agent:${agent}:platform:direct:${user}`;
}

// ---------------------------------------------------------------------------
// Gateway forwarder type
// ---------------------------------------------------------------------------

/** Send an RPC request to the gateway and return its payload or throw on error. */
export type GatewayForwarder = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

export type ChatHandlerContext = {
  forwardToGateway: GatewayForwarder;
  logger?: PluginLogger;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(frame: RpcRequest, payload: unknown): RpcResponse {
  return { type: "res", id: frame.id, ok: true, payload };
}

function fail(frame: RpcRequest, message: string): RpcResponse {
  return { type: "res", id: frame.id, ok: false, error: { message } };
}

function requireString(params: Record<string, unknown>, key: string): string | null {
  const v = params[key];
  if (typeof v !== "string" || !v.trim()) return null;
  return v.trim();
}

// ---------------------------------------------------------------------------
// platform.chat.send
// ---------------------------------------------------------------------------

export async function handlePlatformChatSend(
  frame: RpcRequest,
  ctx: ChatHandlerContext,
): Promise<RpcResponse> {
  const p = frame.params as Partial<PlatformChatSendParams>;
  const userId = requireString(p as Record<string, unknown>, "userId");
  if (!userId) return fail(frame, "platform.chat.send: userId is required");
  const message = requireString(p as Record<string, unknown>, "message");
  if (!message) return fail(frame, "platform.chat.send: message is required");

  const sessionKey = buildPlatformSessionKey(p.agentId, userId);
  ctx.logger?.info(`platform: chat.send sessionKey=${sessionKey}`);

  const gatewayParams: Record<string, unknown> = {
    sessionKey,
    message,
  };
  if (p.thinking) gatewayParams.thinking = p.thinking;
  if (p.runId) gatewayParams.idempotencyKey = p.runId;
  else gatewayParams.idempotencyKey = `${Date.now()}`;

  try {
    const payload = await ctx.forwardToGateway("chat.send", gatewayParams);
    return ok(frame, payload);
  } catch (err) {
    return fail(frame, `platform.chat.send: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// platform.chat.history
// ---------------------------------------------------------------------------

export async function handlePlatformChatHistory(
  frame: RpcRequest,
  ctx: ChatHandlerContext,
): Promise<RpcResponse> {
  const p = frame.params as Partial<PlatformChatHistoryParams>;
  const userId = requireString(p as Record<string, unknown>, "userId");
  if (!userId) return fail(frame, "platform.chat.history: userId is required");

  const sessionKey = buildPlatformSessionKey(p.agentId, userId);
  ctx.logger?.info(`platform: chat.history sessionKey=${sessionKey}`);

  const gatewayParams: Record<string, unknown> = { sessionKey };
  if (typeof p.limit === "number") gatewayParams.limit = p.limit;

  try {
    const payload = await ctx.forwardToGateway("chat.history", gatewayParams);
    return ok(frame, payload);
  } catch (err) {
    return fail(frame, `platform.chat.history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// platform.chat.abort
// ---------------------------------------------------------------------------

export async function handlePlatformChatAbort(
  frame: RpcRequest,
  ctx: ChatHandlerContext,
): Promise<RpcResponse> {
  const p = frame.params as Partial<PlatformChatAbortParams>;
  const userId = requireString(p as Record<string, unknown>, "userId");
  if (!userId) return fail(frame, "platform.chat.abort: userId is required");

  const sessionKey = buildPlatformSessionKey(p.agentId, userId);
  ctx.logger?.info(`platform: chat.abort sessionKey=${sessionKey}`);

  const gatewayParams: Record<string, unknown> = { sessionKey };
  if (p.runId) gatewayParams.runId = p.runId;

  try {
    const payload = await ctx.forwardToGateway("chat.abort", gatewayParams);
    return ok(frame, payload);
  } catch (err) {
    return fail(frame, `platform.chat.abort: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// platform.chat.reset
// ---------------------------------------------------------------------------

export async function handlePlatformChatReset(
  frame: RpcRequest,
  ctx: ChatHandlerContext,
): Promise<RpcResponse> {
  const p = frame.params as Partial<PlatformChatResetParams>;
  const userId = requireString(p as Record<string, unknown>, "userId");
  if (!userId) return fail(frame, "platform.chat.reset: userId is required");

  const sessionKey = buildPlatformSessionKey(p.agentId, userId);
  ctx.logger?.info(`platform: chat.reset sessionKey=${sessionKey}`);

  try {
    const payload = await ctx.forwardToGateway("sessions.reset", {
      key: sessionKey,
      reason: "reset",
    });
    return ok(frame, payload);
  } catch (err) {
    return fail(frame, `platform.chat.reset: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// platform.session.resolve
// ---------------------------------------------------------------------------

export async function handlePlatformSessionResolve(
  frame: RpcRequest,
  _ctx: ChatHandlerContext,
): Promise<RpcResponse> {
  const p = frame.params as Partial<PlatformSessionResolveParams>;
  const userId = requireString(p as Record<string, unknown>, "userId");
  if (!userId) return fail(frame, "platform.session.resolve: userId is required");

  const sessionKey = buildPlatformSessionKey(p.agentId, userId);
  return ok(frame, { sessionKey });
}
