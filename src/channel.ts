/**
 * ChannelPlugin definition for sideclaw.
 *
 * Per the OpenClaw SDK spec, only `id` and `setup` are required.
 * Additional adapters (security, pairing, threading, outbound) are
 * opt-in and not needed for a transparent relay channel.
 */

import type { ChannelGatewayContext, ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveAccount, inspectAccount, type SideClawAccount } from "./config.js";
import { startAccount } from "./monitor.js";

export const sideClawChannel: ChannelPlugin = {
  id: "sideclaw",

  meta: {
    id: "sideclaw",
    label: "SideClaw",
    selectionLabel: "SideClaw",
    docsPath: "/channels/sideclaw",
    blurb: "Connect OpenClaw to SideClaw for real-time AI voice conversations with embodied agents.",
    aliases: ["sideclaw"],
  },

  capabilities: {
    chatTypes: ["direct"] as const,
  },

  config: {
    listAccountIds(cfg: OpenClawConfig): string[] {
      const sideclaw = cfg?.channels?.sideclaw;
      if (!sideclaw?.enabled) return [];
      return ["sideclaw"];
    },

    resolveAccount(cfg: OpenClawConfig, accountId?: string | null): SideClawAccount {
      return resolveAccount(cfg, accountId ?? undefined);
    },

    inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
      return inspectAccount(cfg, accountId);
    },
  },

  gateway: {
    async startAccount(ctx: ChannelGatewayContext<SideClawAccount>): Promise<void> {
      await startAccount(ctx);
    },
  },
};
