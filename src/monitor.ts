/**
 * startAccount() — the long-lived task for the platform channel.
 *
 * The gateway ChannelManager calls this and auto-restarts it with backoff
 * if it exits (WS close, abort, error).
 *
 * Flow:
 *   1. Open loopback WS to the gateway's own local port
 *   2. Buffer the connect.challenge from the gateway
 *   3. Dial platform WS server
 *   4. Send pre-handshake frame (delivers gateway token)
 *   5. Forward the buffered challenge to platform
 *   6. Manually relay the handshake (connect RPC → hello-ok)
 *   7. Switch to generic bidirectional frame relay
 *
 * The buffered handshake is critical: the gateway has a short timeout for
 * unauthenticated connections. By buffering the challenge before connecting
 * to platform, we ensure the handshake completes before the timeout.
 */

import type { ChannelGatewayContext, OpenClawConfig, PluginLogger } from "openclaw/plugin-sdk";
import { resolveGatewayToken, resolveGatewayUrl } from "./config.js";
import type { PlatformAccount } from "./config.js";
import { handleWorkspaceLs, handleWorkspaceRead, handleWorkspaceWrite } from "./workspace.js";
import type { RpcRequest, RpcResponse, WorkspaceLsParams, WorkspaceReadParams, WorkspaceWriteParams } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket, type MessageEvent as UndiciMessageEvent, type CloseEvent as UndiciCloseEvent, type ErrorEvent as UndiciErrorEvent } from 'undici';

/** Schemes permitted for the platform WebSocket URL. */
const ALLOWED_WS_SCHEMES = new Set(["ws:", "wss:"]);

/** Loopback addresses where plaintext ws:// is acceptable. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Delay between automatic reconnect attempts. */
const RETRY_DELAY_MS = 60_000;

/**
 * Callback that skips the current retry delay and reconnects immediately.
 * Non-null only while a retry wait is in progress.
 */
let pendingReconnect: (() => void) | null = null;

export type ConnectionStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "retrying"; retryingAt: number; lastError: string };

let connectionStatus: ConnectionStatus = { state: "disconnected" };

export function getConnectionStatus(): ConnectionStatus {
  return connectionStatus;
}

/**
 * Skip the pending retry delay and reconnect immediately.
 * Returns true if a retry was in progress.
 */
export function triggerReconnect(): boolean {
  if (!pendingReconnect) return false;
  pendingReconnect();
  return true;
}

/** Extract a human-readable detail string from a WebSocket error event. */
function formatWsError(ev: UndiciErrorEvent): string {
  const parts: string[] = [];
  if (typeof ev.message === "string" && ev.message) parts.push(ev.message);
  if (ev.error) parts.push(String(ev.error));
  return parts.length ? parts.join(" — ") : `type=${ev.type}`;
}

/**
 * Wait up to `delayMs` before resolving, but resolve early if:
 *   - `signal` is aborted (silently exits retry loop), or
 *   - the account's reconnect trigger is invoked.
 */
function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingReconnect = null;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    const onAbort = () => done();
    pendingReconnect = done;
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Validate and parse a WebSocket URL.
 * Rejects non-ws(s) schemes to prevent SSRF against HTTP/internal services.
 */
export function validateWsUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`platform: invalid ${label} URL: ${raw}`);
  }

  if (!ALLOWED_WS_SCHEMES.has(url.protocol)) {
    throw new Error(
      `platform: ${label} URL must use ws:// or wss:// (got ${url.protocol})`,
    );
  }

  return url;
}

/**
 * Warn if a token is about to be sent over a plaintext connection
 * to a non-loopback host.
 */
export function checkPlaintextToken(url: URL, logger?: PluginLogger): void {
  if (url.protocol === "wss:") return; // encrypted — fine
  if (LOOPBACK_HOSTS.has(url.hostname)) return; // local dev — acceptable

  logger?.warn?.(
    `platform: sending token over plaintext ws:// to ${url.hostname} — ` +
    `use wss:// in production to protect credentials`,
  );
}

/** Format a WebSocket CloseEvent into a human-readable reason string. */
function formatCloseEvent(ev: UndiciCloseEvent): string {
  return ev.reason ? `${ev.code}: ${ev.reason}` : `code ${ev.code}`;
}

/**
 * Connect to a WS server with an abort signal.
 * Returns a WebSocket in OPEN state or throws.
 * If the server closes the connection before or immediately after open,
 * rejects with the close code and reason from the server.
 */
function connectWithAbort(url: string, signal: AbortSignal, timeoutMs = 10_000): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted before connect"));
      return;
    }

    const ws = new WebSocket(url);
    let opened = false;

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      ws.close();
      settle(() => reject(new Error(`WebSocket connect timeout after ${timeoutMs}ms (${url})`)));
    }, timeoutMs);

    const onAbort = () => {
      ws.close();
      settle(() => reject(new Error("aborted during connect")));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      opened = true;
      settle(() => resolve(ws));
    }, { once: true });

    ws.addEventListener("error", (ev) => {
      settle(() => reject(new Error(`WebSocket connect error: ${formatWsError(ev)}`)));
    }, { once: true });

    // Capture server-sent close reasons (e.g. service restarting) that arrive
    // before the open event. If open already fired, waitForMessage handles it.
    ws.addEventListener("close", (ev) => {
      if (opened) return;
      settle(() => reject(new Error(`WebSocket closed during connect (${formatCloseEvent(ev)})`)));
    }, { once: true });
  });
}

/**
 * Wait for the next message from a WebSocket.
 * Rejects on close, error, abort, or timeout.
 */
function waitForMessage(
  ws: WebSocket,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };

    const onMessage = (ev: UndiciMessageEvent) => {
      cleanup();
      resolve(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    const onClose = (ev: UndiciCloseEvent) => {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for message (${formatCloseEvent(ev)})`));
    };
    const onError = (ev: UndiciErrorEvent) => {
      cleanup();
      reject(new Error(`WebSocket error: ${formatWsError(ev)}`));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };

    ws.addEventListener("message", onMessage, { once: true });
    ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolve the openclaw.json config path. */
function resolveConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".openclaw", "openclaw.json");
}

/**
 * Re-read the agents list from the on-disk config file.
 * Falls back to the in-memory config if the file read fails.
 */
async function freshAgentsConfig(
  fallbackCfg: OpenClawConfig,
  logger?: PluginLogger,
): Promise<{ agents: Array<{ id: string; workspace?: string }>; defaultWorkspace?: string }> {
  try {
    const raw = await fs.readFile(resolveConfigPath(), "utf8");
    const diskCfg = JSON.parse(raw) as OpenClawConfig;
    return {
      agents: diskCfg.agents?.list ?? [],
      defaultWorkspace: diskCfg.agents?.defaults?.workspace?.trim() || undefined,
    };
  } catch (err) {
    logger?.warn?.(`sideclaw: failed to re-read config from disk, using in-memory snapshot: ${err}`);
    return {
      agents: fallbackCfg.agents?.list ?? [],
      defaultWorkspace: fallbackCfg.agents?.defaults?.workspace?.trim() || undefined,
    };
  }
}

/** Context passed to every plugin RPC handler. */
type PluginRpcContext = {
  cfg: OpenClawConfig;
  logger?: PluginLogger;
};

/** A handler for a plugin-intercepted RPC method. Returns a ready-to-send RpcResponse. */
type PluginRpcHandler = (frame: RpcRequest, ctx: PluginRpcContext) => Promise<RpcResponse>;

function makeHandler<P>(
  fn: (
    agents: Array<{ id: string; workspace?: string }>,
    params: P,
    logger?: PluginLogger,
    defaultWorkspace?: string,
  ) => Promise<{ ok: true; payload: unknown } | { ok: false; error: string }>,
): PluginRpcHandler {
  return async (frame, ctx) => {
    const { agents: agentsList, defaultWorkspace } = await freshAgentsConfig(ctx.cfg, ctx.logger);
    const result = await fn(agentsList, frame.params as P, ctx.logger, defaultWorkspace);
    return result.ok
      ? { type: "res", id: frame.id, ok: true, payload: result.payload }
      : { type: "res", id: frame.id, ok: false, error: { message: result.error } };
  };
}

/**
 * Plugin-intercepted RPC methods.
 * Add entries here to handle new methods locally without forwarding to the gateway.
 */
const PLUGIN_HANDLERS: Record<string, PluginRpcHandler> = {
  "workspace.read": makeHandler<WorkspaceReadParams>(handleWorkspaceRead),
  "workspace.write": makeHandler<WorkspaceWriteParams>(handleWorkspaceWrite),
  "workspace.ls": makeHandler<WorkspaceLsParams>(handleWorkspaceLs),
};

/**
 * Relay frames bidirectionally between two WebSockets.
 *
 * Messages from `a` (platform/bot-runner) heading to `b` (gateway) are
 * logged and checked against PLUGIN_HANDLERS. Matching methods are handled
 * locally; everything else is forwarded verbatim.
 *
 * @param cfg - Full gateway config. Contains `agents.defaults.workspace` and
 *              optionally `agents.list` for agent-specific overrides.
 * @param logger - Optional logger for request logging and handler operations.
 */
function relayFrames(
  a: WebSocket,
  b: WebSocket,
  signal: AbortSignal,
  cfg: OpenClawConfig,
  logger?: PluginLogger,
): Promise<void> {
  const pluginCtx: PluginRpcContext = {
    cfg,
    logger,
  };

  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      a.removeEventListener("message", aToB);
      b.removeEventListener("message", bToA);
      a.removeEventListener("close", onClose);
      b.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      try { a.close(); } catch { /* already closed */ }
      try { b.close(); } catch { /* already closed */ }
      resolve();
    };

    const aToB = (ev: UndiciMessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);

      try {
        const frame = JSON.parse(raw) as RpcRequest;
        if (frame.type === "req") {
          logger?.info(`platform: rpc request id=${frame.id} method=${frame.method}`);
          const handler = PLUGIN_HANDLERS[frame.method];
          if (handler) {
            handler(frame, pluginCtx)
              .then((resp) => {
                try { a.send(JSON.stringify(resp)); } catch { done(); }
              })
              .catch((err) => {
                const resp: RpcResponse = {
                  type: "res", id: frame.id, ok: false,
                  error: { message: String(err) },
                };
                try { a.send(JSON.stringify(resp)); } catch { done(); }
              });
            return; // intercepted — don't forward to gateway
          }
        }  else if (frame.type === "error") {
          const frame = JSON.parse(raw) as { type?: unknown; message?: unknown };
          logger?.error(`platform: gateway error — ${frame.message ?? "(no message)"}`);
          return;
        }

      } catch { /* not a parseable RPC — fall through */ }
      try { b.send(ev.data); } catch { done(); }
    };

    const bToA = (ev: UndiciMessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);

      // Intercept plugin-handled RPCs from the gateway (e.g. workspace.write
      // triggered by the backend's install endpoint). Responses go back to the
      // gateway (b), not to sideclaw.
      try {
        const frame = JSON.parse(raw) as RpcRequest;
        if (frame.type === "req") {
          const handler = PLUGIN_HANDLERS[frame.method];
          if (handler) {
            logger?.info(`sideclaw: intercepted gateway rpc id=${frame.id} method=${frame.method}`);
            handler(frame, pluginCtx)
              .then((resp) => {
                try { b.send(JSON.stringify(resp)); } catch { done(); }
              })
              .catch((err) => {
                const resp: RpcResponse = {
                  type: "res", id: frame.id, ok: false,
                  error: { message: String(err) },
                };
                try { b.send(JSON.stringify(resp)); } catch { done(); }
              });
            return; // intercepted — don't forward to sideclaw
          }
        }
      } catch { /* not a parseable RPC — fall through */ }

      try { a.send(ev.data); } catch { done(); }
    };
    const onClose = () => done();
    const onAbort = () => done();

    a.addEventListener("message", aToB);
    b.addEventListener("message", bToA);
    a.addEventListener("close", onClose, { once: true });
    b.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One connection attempt: buffer challenge, dial platform, relay handshake, then relay frames.
 */
async function runSession(ctx: ChannelGatewayContext<PlatformAccount>): Promise<void> {
  const { platformUrl } = ctx.account;
  const gatewayToken = resolveGatewayToken(ctx.cfg);
  const pairingToken = ctx.account.pairingToken;
  if (!pairingToken) {
    throw new Error(
      "platform: pairingToken is required — generate one from Settings > Gateway in the Platform web app",
    );
  }
  const identityToken = pairingToken;
  const gatewayUrl = resolveGatewayUrl(ctx.cfg);

  // Validate URLs before connecting
  const platformParsed = validateWsUrl(platformUrl, "platformUrl");
  validateWsUrl(gatewayUrl, "gatewayUrl");

  // Warn if sending token over plaintext to a remote host
  checkPlaintextToken(platformParsed, ctx.log);

  connectionStatus = { state: "connecting" };

  // 1. Connect to gateway FIRST — it sends connect.challenge immediately
  ctx.log?.info("platform: [1] connecting to gateway");
  const gatewayWs = await connectWithAbort(gatewayUrl, ctx.abortSignal);
  ctx.log?.info("platform: [1] gateway connected");

  // 2. Buffer the connect.challenge
  ctx.log?.info("platform: [2] waiting for connect.challenge from gateway");
  const challengeRaw = await waitForMessage(gatewayWs, ctx.abortSignal);
  ctx.log?.info("platform: [2] challenge buffered");

  // 3. Dial platform
  // TODO: to prevent some malicious skill from changing config to connect
  // to their platform and taking control of our user's OpenClaw we should validate
  // the TLS certificate of the platformUrl server is owned by us.
  ctx.log?.info(`platform: [3] dialing platform at ${platformUrl}`);
  const platformWs = await connectWithAbort(platformUrl, ctx.abortSignal);
  ctx.log?.info("platform: [3] platform connected");
  ctx.setStatus({ accountId: ctx.accountId, connected: false, lastError: null });

  // 4. Send pre-handshake — delivers identity token (pairing or gateway) for routing,
  //    plus the gateway token so platform can sign the handshake correctly.
  ctx.log?.info("platform: [4] sending pre-handshake");
  platformWs.send(
    JSON.stringify({
      type: "pre-handshake",
      version: 1,
      token: identityToken,
      gatewayToken,
    }),
  );

  // 5. Forward the buffered challenge to platform
  ctx.log?.info("platform: [5] forwarding challenge to platform");
  platformWs.send(challengeRaw);

  // 6. Relay the handshake manually:
  //    platform sends connect RPC → forward to gateway
  ctx.log?.info("platform: [6a] waiting for connect RPC from platform");
  const connectRaw = await waitForMessage(platformWs, ctx.abortSignal);
  ctx.log?.info("platform: [6a] forwarding connect RPC to gateway");
  gatewayWs.send(connectRaw);

  //    gateway sends hello-ok → forward to platform
  ctx.log?.info("platform: [6b] waiting for hello-ok from gateway");
  const helloRaw = await waitForMessage(gatewayWs, ctx.abortSignal);
  ctx.log?.info("platform: [6b] forwarding hello-ok to platform");
  platformWs.send(helloRaw);

  connectionStatus = { state: "connected" };
  ctx.setStatus({ accountId: ctx.accountId, connected: true });
  ctx.log?.info("platform: handshake complete, ready");

  // 7. Switch to generic bidirectional frame relay
  //    All GatewaySession RPC calls flow through from here.
  ctx.log?.info("platform: [7] entering relay loop");
  await relayFrames(platformWs, gatewayWs, ctx.abortSignal, ctx.cfg, ctx.log);
}

/**
 * Long-lived task: run `runSession` in a retry loop.
 * On failure, logs the full error and waits RETRY_DELAY_MS before
 * reconnecting. The wait can be skipped early via `triggerReconnect`.
 */
export async function startAccount(ctx: ChannelGatewayContext<PlatformAccount>): Promise<void> {
  try {
    while (!ctx.abortSignal.aborted) {
      let lastError: string | null = null;
      try {
        await runSession(ctx);
        ctx.log?.info("platform: session ended, reconnecting in " + RETRY_DELAY_MS / 1000 + "s");
      } catch (err) {
        if (ctx.abortSignal.aborted) return;
        const msg = err instanceof Error ? `${err.message}${err.cause ? ` (cause: ${err.cause})` : ""}` : String(err);
        ctx.log?.error(`platform: connection failed — ${msg}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
        ctx.setStatus({ accountId: ctx.accountId, connected: false, lastError: msg });
        lastError = msg;
        ctx.log?.info(`platform: retrying in ${RETRY_DELAY_MS / 1000}s (or use /platform-reconnect to retry now)`);
      }
      if (ctx.abortSignal.aborted) return;
      const retryingAt = Date.now() + RETRY_DELAY_MS;
      connectionStatus = { state: "retrying", retryingAt, lastError: lastError ?? "disconnected" };
      await waitForRetry(RETRY_DELAY_MS, ctx.abortSignal);
    }
  } finally {
    connectionStatus = { state: "disconnected" };
  }
}
