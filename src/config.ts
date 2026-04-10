import type { OpenClawConfig } from "openclaw/plugin-sdk";

/**
 * Typed config resolver for the platform channel plugin.
 *
 * The gateway token is NOT stored in config — the plugin reads it from the
 * running gateway context and pushes it to platform over the pre-handshake.
 */

export type PlatformAccount = {
  accountId: string;
  enabled: boolean;
  /** true when platformUrl is set */
  configured: boolean;
  platformUrl: string;
  pairingToken?: string;
};

export function resolveAccount(cfg: OpenClawConfig, accountId?: string): PlatformAccount {
  if (accountId && accountId !== "platform") {
    console.warn(`platform: unexpected accountId "${accountId}", only "platform" is supported`);
  }
  const platform = cfg.channels?.platform ?? {};
  const platformUrl = typeof platform.platformUrl === "string" ? platform.platformUrl.trim() : "ws://localhost:8000/openclaw/channel";

  return {
    accountId: "platform",
    enabled: platform.enabled === true,
    configured: platformUrl.length > 0,
    platformUrl,
    pairingToken: typeof platform.pairingToken === "string" ? platform.pairingToken || undefined : undefined,
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
  const platform = cfg.channels?.platform ?? {};
  const platformUrl = typeof platform.platformUrl === "string" && platform.platformUrl.trim().length > 0;
  const hasPairingToken = typeof platform.pairingToken === "string" && platform.pairingToken.length > 0;

  return {
    enabled: platform.enabled === true,
    configured: platformUrl,
    tokenStatus: hasPairingToken ? "available" : "missing",
  };
}

/**
 * Resolve the gateway token from the running gateway config or environment.
 * The plugin pushes this to platform so it can complete the standard handshake.
 */
export function resolveGatewayToken(cfg: OpenClawConfig): string {
  // Prefer environment variable, fall back to config
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envToken) return envToken;

  const token = cfg.gateway?.auth?.token;
  if (typeof token === "string" && token.length > 0) return token;

  throw new Error(
    "platform: cannot resolve gateway token — set OPENCLAW_GATEWAY_TOKEN or configure gateway.auth.token",
  );
}

/**
 * Resolve the gateway's local WS URL for the loopback relay connection.
 * The plugin connects here and relays frames to/from platform.
 */
export function resolveGatewayUrl(cfg: OpenClawConfig): string {
  const port = cfg.gateway?.port ?? 18789;
  return `ws://127.0.0.1:${port}`;
}
