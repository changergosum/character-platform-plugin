/**
 * SideClaw — OpenClaw channel plugin for real-time AI voice conversations.
 *
 * Connects an OpenClaw agent to the SideClaw voice platform, enabling the agent
 * to participate in live voice calls with embodied characters. The gateway
 * initiates the connection to SideClaw and maintains a persistent session
 * for RPC communication.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sideClawChannel } from "./channel.js";
import { triggerReconnect, getConnectionStatus } from "./monitor.js";
import { resolveAccount } from "./config.js";

export default function register(api: OpenClawPluginApi) {
  api.registerChannel({ plugin: sideClawChannel });

  api.registerCommand({
    name: "sideclaw-pair",
    description: "Show instructions for pairing OpenClaw with SideClaw",
    handler: () => ({
      text: [
        "To pair OpenClaw with SideClaw:",
        "",
        "1. Follow the setup instructions at https://sideclaw.md",
        "2. Register an account on SideClaw and add OpenClaw as a connection",
        "3. Add OpenClaw and follow instructions to install pairing token in OpenClaw",
        "",
        "Once configured, restart the gateway and use /sideclaw-status to verify the connection.",
      ].join("\n"),
    }),
  });

  api.registerCommand({
    name: "sideclaw-reconnect",
    description: "Skip the retry delay and reconnect to SideClaw immediately",
    handler: () => {
      const triggered = triggerReconnect();
      return triggered
        ? { text: "Sideclaw: reconnecting now." }
        : { text: "Sideclaw: no pending retry — already connected or not running." };
    },
  });

  api.registerCommand({
    name: "sideclaw-status",
    description: "Show SideClaw connection status and current configuration",
    handler: (ctx) => {
      const status = getConnectionStatus();
      const account = resolveAccount(ctx.config);

      const lines: string[] = ["**SideClaw Status**"];

      // Connection state
      switch (status.state) {
        case "connected":
          lines.push("Connection: connected");
          break;
        case "connecting":
          lines.push("Connection: connecting…");
          break;
        case "retrying": {
          const secsLeft = Math.max(0, Math.round((status.retryingAt - Date.now()) / 1000));
          lines.push(`Connection: retrying in ${secsLeft}s`);
          lines.push(`Last error: ${status.lastError}`);
          break;
        }
        case "disconnected":
          lines.push("Connection: disconnected");
          break;
      }

      // Config
      lines.push("");
      lines.push("**Config**");
      lines.push(`Enabled: ${account.enabled}`);
      lines.push(`SideClaw URL: ${account.sideClawUrl || "(not set)"}`);
      lines.push(`Pairing token: ${account.pairingToken ? "set" : "missing"}`);

      return { text: lines.join("\n") };
    },
  });

  api.logger.info("sideclaw: channel registered");
}
