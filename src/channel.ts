/**
 * ChannelPlugin definition for platform.
 *
 * Per the OpenClaw SDK spec, only `id` and `setup` are required.
 * Additional adapters (security, pairing, threading, outbound) are
 * opt-in and not needed for a transparent relay channel.
 */

import type { ChannelGatewayContext, ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveAccount, inspectAccount, type PlatformAccount } from "./config.js";
import { startAccount } from "./monitor.js";

export const PlatformChannel: ChannelPlugin = {
  id: "platform",

  meta: {
    id: "platform",
    label: "platform",
    selectionLabel: "platform",
    docsPath: "/channels/platform",
    blurb: "Connect OpenClaw to character platform.",
    aliases: ["platform"],
  },

  capabilities: {
    chatTypes: ["direct"] as const,
  },

  config: {
    listAccountIds(cfg: OpenClawConfig): string[] {
      const platform = cfg?.channels?.platform;
      if (!platform?.enabled) return [];
      return ["platform"];
    },

    resolveAccount(cfg: OpenClawConfig, accountId?: string | null): PlatformAccount {
      return resolveAccount(cfg, accountId ?? undefined);
    },

    inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
      return inspectAccount(cfg, accountId);
    },
  },

  gateway: {
    async startAccount(ctx: ChannelGatewayContext<PlatformAccount>): Promise<void> {
      await startAccount(ctx);
    },
  },
};
