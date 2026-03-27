/**
 * startAccount() — the long-lived task for the sideclaw channel.
 *
 * The gateway ChannelManager calls this and auto-restarts it with backoff
 * if it exits (WS close, abort, error).
 *
 * Flow:
 *   1. Open loopback WS to the gateway's own local port
 *   2. Buffer the connect.challenge from the gateway
 *   3. Dial sideclaw WS server
 *   4. Send pre-handshake frame (delivers gateway token)
 *   5. Forward the buffered challenge to sideclaw
 *   6. Manually relay the handshake (connect RPC → hello-ok)
 *   7. Switch to generic bidirectional frame relay
 *
 * The buffered handshake is critical: the gateway has a short timeout for
 * unauthenticated connections. By buffering the challenge before connecting
 * to sideclaw, we ensure the handshake completes before the timeout.
 */

import type { ChannelGatewayContext, OpenClawConfig, PluginLogger } from "openclaw/plugin-sdk";
import { resolveGatewayToken, resolveGatewayUrl } from "./config.js";
import type { SideClawAccount } from "./config.js";
import { handleWorkspaceRead } from "./workspace.js";
import type { RpcRequest, RpcResponse, WorkspaceReadParams } from "./types.js";

/** Schemes permitted for the sideclaw WebSocket URL. */
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
function formatWsError(ev: Event): string {
  // Node 22 WebSocket fires an ErrorEvent-shaped object but ErrorEvent is not a
  // global in Node, so use duck typing rather than instanceof.
  const parts: string[] = [];
  const msg = (ev as { message?: unknown }).message;
  if (typeof msg === "string" && msg) parts.push(msg);
  const err = (ev as { error?: unknown }).error;
  if (err) parts.push(String(err));
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
    throw new Error(`sideclaw: invalid ${label} URL: ${raw}`);
  }

  if (!ALLOWED_WS_SCHEMES.has(url.protocol)) {
    throw new Error(
      `sideclaw: ${label} URL must use ws:// or wss:// (got ${url.protocol})`,
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
    `sideclaw: sending token over plaintext ws:// to ${url.hostname} — ` +
    `use wss:// in production to protect credentials`,
  );
}

/**
 * Connect to a WS server with an abort signal.
 * Returns a WebSocket in OPEN state or throws.
 */
function connectWithAbort(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted before connect"));
      return;
    }

    const ws = new WebSocket(url);

    const onAbort = () => {
      ws.close();
      reject(new Error("aborted during connect"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(ws);
    }, { once: true });

    ws.addEventListener("error", (ev) => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`WebSocket connect error: ${formatWsError(ev)}`));
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

    const onMessage = (ev: MessageEvent) => {
      cleanup();
      resolve(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed while waiting for message"));
    };
    const onError = (ev: Event) => {
      cleanup();
      reject(new Error(`WebSocket error: ${ev}`));
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

/**
 * Relay frames bidirectionally between two WebSockets.
 *
 * Messages from `a` (sideclaw/bot-runner) heading to `b` (gateway) are
 * checked for `workspace.read` RPC requests. Matching requests are handled
 * locally using workspace info from the gateway config; everything else is
 * forwarded verbatim.
 *
 * @param cfg - Full gateway config (same object the original read-workspace plugin
 *              accesses as `ctx.config`). Contains `agents.defaults.workspace` and
 *              optionally `agents.list` for agent-specific overrides.
 * @param logger - Optional logger for workspace read operations
 */
function relayFrames(
  a: WebSocket,
  b: WebSocket,
  signal: AbortSignal,
  cfg: OpenClawConfig,
  logger?: PluginLogger,
): Promise<void> {
  // Extract workspace info from config — same path as the read-workspace plugin
  const agentsList = cfg.agents?.list ?? [];
  const defaultWorkspace = cfg.agents?.defaults?.workspace?.trim() || undefined;

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

    const aToB = (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);

      // Fast string check — only parse if the message might be a workspace.read request
      if (raw.includes('"workspace.read"')) {
        try {
          const frame = JSON.parse(raw) as RpcRequest;
          if (frame.type === "req" && frame.method === "workspace.read") {
            // Handle locally using workspace info from gateway config
            handleWorkspaceRead(agentsList, frame.params as WorkspaceReadParams, logger, defaultWorkspace)
              .then((result) => {
                const resp: RpcResponse = result.ok
                  ? { type: "res", id: frame.id, ok: true, payload: result.payload }
                  : { type: "res", id: frame.id, ok: false, error: { message: result.error } };
                try { a.send(JSON.stringify(resp)); } catch { done(); }
              })
              .catch((err) => {
                const resp: RpcResponse = {
                  type: "res", id: frame.id, ok: false,
                  error: { message: String(err) },
                };
                try { a.send(JSON.stringify(resp)); } catch { done(); }
              });
            return; // Don't forward to gateway
          }
        } catch {
          // JSON parse failed — fall through to normal relay
        }
      }

      try { b.send(ev.data); } catch { done(); }
    };

    const bToA = (ev: MessageEvent) => {
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
 * One connection attempt: buffer challenge, dial sideclaw, relay handshake, then relay frames.
 */
async function runSession(ctx: ChannelGatewayContext<SideClawAccount>): Promise<void> {
  const { sideClawUrl } = ctx.account;
  const gatewayToken = resolveGatewayToken(ctx.cfg);
  const pairingToken = ctx.account.pairingToken;
  if (!pairingToken) {
    throw new Error(
      "sideclaw: pairingToken is required — generate one from Settings > Gateway in the SideClaw web app",
    );
  }
  const identityToken = pairingToken;
  const gatewayUrl = resolveGatewayUrl(ctx.cfg);

  // Validate URLs before connecting
  const sideClawParsed = validateWsUrl(sideClawUrl, "sideClawUrl");
  validateWsUrl(gatewayUrl, "gatewayUrl");

  // Warn if sending token over plaintext to a remote host
  checkPlaintextToken(sideClawParsed, ctx.log);

  connectionStatus = { state: "connecting" };

  // 1. Connect to gateway FIRST — it sends connect.challenge immediately
  const gatewayWs = await connectWithAbort(gatewayUrl, ctx.abortSignal);

  // 2. Buffer the connect.challenge
  const challengeRaw = await waitForMessage(gatewayWs, ctx.abortSignal);

  // 3. Dial sideclaw
  const sideClawWs = await connectWithAbort(sideClawUrl, ctx.abortSignal);
  ctx.setStatus({ accountId: ctx.accountId, connected: false, lastError: null });

  // 4. Send pre-handshake — delivers identity token (pairing or gateway) for routing,
  //    plus the gateway token so sideclaw can sign the handshake correctly.
  sideClawWs.send(
    JSON.stringify({
      type: "pre-handshake",
      version: 1,
      token: identityToken,
      gatewayToken,
    }),
  );

  // 5. Forward the buffered challenge to sideclaw
  sideClawWs.send(challengeRaw);

  // 6. Relay the handshake manually:
  //    sideclaw sends connect RPC → forward to gateway
  const connectRaw = await waitForMessage(sideClawWs, ctx.abortSignal);
  gatewayWs.send(connectRaw);

  //    gateway sends hello-ok → forward to sideclaw
  const helloRaw = await waitForMessage(gatewayWs, ctx.abortSignal);
  sideClawWs.send(helloRaw);

  connectionStatus = { state: "connected" };
  ctx.setStatus({ accountId: ctx.accountId, connected: true });
  ctx.log?.info("sideclaw: handshake complete, ready");

  // 7. Switch to generic bidirectional frame relay
  //    All GatewaySession RPC calls flow through from here.
  await relayFrames(sideClawWs, gatewayWs, ctx.abortSignal, ctx.cfg, ctx.log);
}

/**
 * Long-lived task: run `runSession` in a retry loop.
 * On failure, logs the full error and waits RETRY_DELAY_MS before
 * reconnecting. The wait can be skipped early via `triggerReconnect`.
 */
export async function startAccount(ctx: ChannelGatewayContext<SideClawAccount>): Promise<void> {
  try {
    while (!ctx.abortSignal.aborted) {
      try {
        await runSession(ctx);
      } catch (err) {
        if (ctx.abortSignal.aborted) return;
        const msg = err instanceof Error ? `${err.message}${err.cause ? ` (cause: ${err.cause})` : ""}` : String(err);
        ctx.log?.error(`sideclaw: connection failed — ${msg}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
        ctx.setStatus({ accountId: ctx.accountId, connected: false, lastError: msg });
        const retryingAt = Date.now() + RETRY_DELAY_MS;
        connectionStatus = { state: "retrying", retryingAt, lastError: msg };
        ctx.log?.info(`sideclaw: retrying in ${RETRY_DELAY_MS / 1000}s (or use /sideclaw-reconnect to retry now)`);
        await waitForRetry(RETRY_DELAY_MS, ctx.abortSignal);
      }
    }
  } finally {
    connectionStatus = { state: "disconnected" };
  }
}
