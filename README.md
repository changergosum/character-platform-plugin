# @egoai/sideclaw

[![npm](https://img.shields.io/npm/v/@egoai/sideclaw)](https://www.npmjs.com/package/@egoai/sideclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An OpenClaw channel plugin that connects an OpenClaw agent to SideClaw for real-time AI voice conversations.

## Install

### From npm

```bash
openclaw plugins install @egoai/sideclaw
```

### From source

```bash
git clone https://github.com/egotv/sideclaw-plugin.git
cd sideclaw-plugin
npm install
openclaw plugins install .
```

## Configuration

Add the following to your `openclaw.json` under `channels.sideclaw`:

```jsonc
{
  "channels": {
    "sideclaw": {
      "enabled": true,
      "platformUrl": "ws://sideclaw-host:19999",
      "pairingToken": "sk_pair_YOUR_TOKEN_HERE"
    }
  }
}
```

Or use the CLI:

```bash
openclaw config set channels.sideclaw.enabled true
openclaw config set channels.sideclaw.platformUrl "ws://sideclaw-host:19999"
openclaw config set channels.sideclaw.pairingToken "sk_pair_YOUR_TOKEN_HERE"
```

### Config fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Enable or disable the channel |
| `platformUrl` | string | Yes | WebSocket URL of the SideClaw server (ws:// or wss://) |
| `pairingToken` | string | Yes | Pairing token generated from the SideClaw onboarding UI |

### Environment variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | Gateway authentication token. Takes priority over any value stored in config. |

## Commands

| Command | Description |
|---------|-------------|
| `/sideclaw-pair` | Show step-by-step pairing instructions (register on SideClaw, add OpenClaw, get pairing token) |
| `/sideclaw-status` | Show current connection state and configured values (`platformUrl`, `pairingToken` presence, `enabled`) |
| `/sideclaw-reconnect` | Skip the pending retry delay and reconnect immediately (no-op if already connected) |

## How It Works

OpenClaw gateways typically run on a user's local machine behind NAT, so SideClaw cannot reach the gateway directly. This plugin uses a reverse connection pattern: it dials out from the gateway to SideClaw rather than waiting to be dialed. On startup, the plugin connects to the local gateway WebSocket first and buffers the `connect.challenge` message before opening a second connection to SideClaw. The buffered challenge is forwarded to SideClaw immediately after the connection opens, which prevents the gateway from timing out while waiting for a handshake response. Once both sides complete the handshake, the plugin becomes a bidirectional frame relay for the lifetime of the session. If either side disconnects, the gateway's ChannelManager restarts `startAccount()` with backoff.

### Workspace file reading

The relay intercepts `workspace.read` RPC requests from the SideClaw server. Instead of forwarding these to the gateway (which can't serve files back over NAT), the relay reads files directly from the local filesystem using the workspace path from the gateway config (`agents.defaults.workspace`). A fast string pre-check avoids JSON parsing overhead on non-matching frames.

## Security

- **URL validation**: Only `ws://` and `wss://` URLs are accepted for `platformUrl`. Any other scheme is rejected to prevent SSRF.
- **Plaintext token warning**: If `pairingToken` is transmitted over an unencrypted `ws://` connection, the plugin logs a security warning. Use `wss://` in production.
- **Secret priority**: `OPENCLAW_GATEWAY_TOKEN` in the environment always takes precedence over the value in `openclaw.json`. Prefer environment variables for secrets rather than storing them in config files.

## Development

After cloning and installing (see "From source" above):

```bash
npm run type-check   # TypeScript check
npm test             # Run tests (vitest)
```

The package ships raw TypeScript with no runtime dependencies. TypeScript and vitest are the only dev-time requirements.

### File structure

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry — `register(api)` |
| `src/channel.ts` | ChannelPlugin shape — id, meta, capabilities, config |
| `src/monitor.ts` | `startAccount()` — buffered handshake + relay with `workspace.read` interception |
| `src/config.ts` | `SideClawAccount` type, `resolveGatewayToken/Url` |
| `src/types.ts` | RPC frame types (`RpcRequest`, `RpcResponse`, `WorkspaceReadParams`, `FileEntry`) |
| `src/workspace.ts` | Local workspace file reading — `handleWorkspaceRead()`, `resolveWorkspace()`, `collectFiles()` |
| `tests/workspace.test.ts` | Workspace module tests (file reading, path traversal, resolution) |
| `tests/intercept.test.ts` | RPC interception flow tests |

## License

MIT
