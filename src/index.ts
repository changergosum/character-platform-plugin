/**
 * Platform — OpenClaw channel plugin for real-time AI voice conversations.
 *
 * Connects an OpenClaw agent to the Platform voice platform, enabling the agent
 * to participate in live voice calls with embodied characters. The gateway
 * initiates the connection to Platform and maintains a persistent session
 * for RPC communication.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PlatformChannel } from "./channel.js";
import { triggerReconnect, getConnectionStatus } from "./monitor.js";
import { resolveAccount } from "./config.js";

export default function register(api: OpenClawPluginApi) {
  api.registerChannel({ plugin: PlatformChannel });

  api.registerCommand({
    name: "platform-pair",
    description: "Show instructions for pairing OpenClaw with Platform",
    handler: () => ({
      text: [
        "To pair OpenClaw with platform:",
        "",
        "1. Follow the setup instructions at https://platform.md",
        "2. Register an account on Platform and add OpenClaw as a connection",
        "3. Add OpenClaw and follow instructions to install pairing token in OpenClaw",
        "",
        "Once configured, restart the gateway and use /platform-status to verify the connection.",
      ].join("\n"),
    }),
  });

  api.registerCommand({
    name: "platform-reconnect",
    description: "Skip the retry delay and reconnect to Platform immediately",
    handler: () => {
      const triggered = triggerReconnect();
      return triggered
        ? { text: "platform: reconnecting now." }
        : { text: "platform: no pending retry — already connected or not running." };
    },
  });

  api.registerCommand({
    name: "platform-status",
    description: "Show Platform connection status and current configuration",
    handler: (ctx) => {
      const status = getConnectionStatus();
      const account = resolveAccount(ctx.config);

      const lines: string[] = ["**Platform Status**"];

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
      lines.push(`Platform URL: ${account.platformUrl || "(not set)"}`);
      lines.push(`Pairing token: ${account.platformKey ? "set" : "missing"}`);

      return { text: lines.join("\n") };
    },
  });

  api.logger.info("platform: channel registered");
}
