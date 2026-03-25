/**
 * SideClaw — OpenClaw channel plugin for real-time AI voice conversations.
 *
 * Connects an OpenClaw agent to the SideClaw voice platform, enabling the agent
 * to participate in live voice calls with embodied characters. The gateway
 * initiates the connection to SideClaw and maintains a persistent session
 * for RPC communication.
 */

import { sideClawChannel } from "./channel.js";

export default function register(api: any) {
  api.registerChannel({ plugin: sideClawChannel });
  api.logger.debug?.("sideclaw: channel registered");
}
