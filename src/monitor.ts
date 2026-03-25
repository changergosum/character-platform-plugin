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

import { resolveGatewayToken, resolveGatewayUrl } from "./config.js";

/** Schemes permitted for the sideclaw WebSocket URL. */
const ALLOWED_WS_SCHEMES = new Set(["ws:", "wss:"]);

/** Loopback addresses where plaintext ws:// is acceptable. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
export function checkPlaintextToken(url: URL, logger?: any): void {
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
      reject(new Error(`WebSocket connect error: ${ev}`));
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
 * Resolves when either side closes or the abort signal fires.
 */
function relayFrames(
  a: WebSocket,
  b: WebSocket,
  signal: AbortSignal,
): Promise<void> {
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
 * Long-lived task: buffer challenge, dial sideclaw, relay handshake, then relay frames.
 */
export async function startAccount(ctx: any): Promise<void> {
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
  checkPlaintextToken(sideClawParsed, ctx.logger);

  // 1. Connect to gateway FIRST — it sends connect.challenge immediately
  const gatewayWs = await connectWithAbort(gatewayUrl, ctx.abortSignal);

  // 2. Buffer the connect.challenge
  const challengeRaw = await waitForMessage(gatewayWs, ctx.abortSignal);

  // 3. Dial sideclaw
  const sideClawWs = await connectWithAbort(sideClawUrl, ctx.abortSignal);
  ctx.setStatus({ connected: false, lastError: undefined });

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

  ctx.setStatus({ connected: true });
  ctx.logger?.info?.("sideclaw: handshake complete, ready");

  // 7. Switch to generic bidirectional frame relay
  //    All GatewaySession RPC calls flow through from here.
  await relayFrames(sideClawWs, gatewayWs, ctx.abortSignal);
}
