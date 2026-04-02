import type { OpenClawConfig } from "openclaw/plugin-sdk";

/**
 * Typed config resolver for the sideclaw channel plugin.
 *
 * The gateway token is NOT stored in config — the plugin reads it from the
 * running gateway context and pushes it to sideclaw over the pre-handshake.
 */

export type SideClawAccount = {
  accountId: string;
  enabled: boolean;
  /** true when sideClawUrl is set */
  configured: boolean;
  sideClawUrl: string;
  pairingToken?: string;
};

export function resolveAccount(cfg: OpenClawConfig, accountId?: string): SideClawAccount {
  if (accountId && accountId !== "sideclaw") {
    console.warn(`sideclaw: unexpected accountId "${accountId}", only "sideclaw" is supported`);
  }
  const sideclaw = cfg.channels?.sideclaw ?? {};
  const sideClawUrl = typeof sideclaw.sideClawUrl === "string" ? sideclaw.sideClawUrl.trim() : "ws://localhost:8000/openclaw/channel";

  return {
    accountId: "sideclaw",
    enabled: sideclaw.enabled === true,
    configured: sideClawUrl.length > 0,
    sideClawUrl,
    pairingToken: typeof sideclaw.pairingToken === "string" ? sideclaw.pairingToken || undefined : undefined,
  };
}

/**
 * Inspect account status without materializing secrets.
 * Used by the gateway dashboard and health checks.
 */
export function inspectAccount(cfg: OpenClawConfig, _accountId?: string | null): {
  enabled: boolean;
  configured: boolean;
  tokenStatus: "available" | "missing";
} {
  const sideclaw = cfg.channels?.sideclaw ?? {};
  const sideClawUrl = typeof sideclaw.sideClawUrl === "string" && sideclaw.sideClawUrl.trim().length > 0;
  const hasPairingToken = typeof sideclaw.pairingToken === "string" && sideclaw.pairingToken.length > 0;

  return {
    enabled: sideclaw.enabled === true,
    configured: sideClawUrl,
    tokenStatus: hasPairingToken ? "available" : "missing",
  };
}

/**
 * Resolve the gateway token from the running gateway config or environment.
 * The plugin pushes this to sideclaw so it can complete the standard handshake.
 */
export function resolveGatewayToken(cfg: OpenClawConfig): string {
  // Prefer environment variable, fall back to config
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envToken) return envToken;

  const token = cfg.gateway?.auth?.token;
  if (typeof token === "string" && token.length > 0) return token;

  throw new Error(
    "sideclaw: cannot resolve gateway token — set OPENCLAW_GATEWAY_TOKEN or configure gateway.auth.token",
  );
}

/**
 * Resolve the gateway's local WS URL for the loopback relay connection.
 * The plugin connects here and relays frames to/from sideclaw.
 */
export function resolveGatewayUrl(cfg: OpenClawConfig): string {
  const port = cfg.gateway?.port ?? 18789;
  return `ws://127.0.0.1:${port}`;
}
