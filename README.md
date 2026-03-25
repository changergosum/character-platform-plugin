# @egoai/sideclaw

[![npm](https://img.shields.io/npm/v/@egoai/sideclaw)](https://www.npmjs.com/package/@egoai/sideclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An OpenClaw channel plugin that connects an OpenClaw agent to SideClaw for real-time AI voice conversations.

## Install

```bash
npm install @egoai/sideclaw
```

Register the plugin with your OpenClaw gateway:

```bash
openclaw plugins install @egoai/sideclaw
```

## Configuration

Add the following to your `openclaw.json` under `channels.sideclaw`:

```jsonc
{
  "channels": {
    "sideclaw": {
      "enabled": true,
      "sideClawUrl": "ws://sideclaw-host:19999",
      "pairingToken": "sk_pair_YOUR_TOKEN_HERE"
    }
  }
}
```

Or use the CLI:

```bash
openclaw config set channels.sideclaw.enabled true
openclaw config set channels.sideclaw.sideClawUrl "ws://sideclaw-host:19999"
openclaw config set channels.sideclaw.pairingToken "sk_pair_YOUR_TOKEN_HERE"
```

### Config fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Enable or disable the channel |
| `sideClawUrl` | string | Yes | WebSocket URL of the SideClaw server (ws:// or wss://) |
| `pairingToken` | string | Yes | Pairing token generated from the SideClaw onboarding UI |

### Environment variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | Gateway authentication token. Takes priority over any value stored in config. |

## How It Works

OpenClaw gateways typically run on a user's local machine behind NAT, so SideClaw cannot reach the gateway directly. This plugin uses a reverse connection pattern: it dials out from the gateway to SideClaw rather than waiting to be dialed. On startup, the plugin connects to the local gateway WebSocket first and buffers the `connect.challenge` message before opening a second connection to SideClaw. The buffered challenge is forwarded to SideClaw immediately after the connection opens, which prevents the gateway from timing out while waiting for a handshake response. Once both sides complete the handshake, the plugin becomes a transparent bidirectional frame relay for the lifetime of the session. If either side disconnects, the gateway's ChannelManager restarts `startAccount()` with backoff.

## Security

- **URL validation**: Only `ws://` and `wss://` URLs are accepted for `sideClawUrl`. Any other scheme is rejected to prevent SSRF.
- **Plaintext token warning**: If `pairingToken` is transmitted over an unencrypted `ws://` connection, the plugin logs a security warning. Use `wss://` in production.
- **Secret priority**: `OPENCLAW_GATEWAY_TOKEN` in the environment always takes precedence over the value in `openclaw.json`. Prefer environment variables for secrets rather than storing them in config files.

## Development

```bash
git clone https://github.com/egotv/sideclaw-plugin.git
cd sideclaw-plugin
npm install
npm run type-check
```

The package ships raw TypeScript with no runtime dependencies. TypeScript is the only build-time requirement.

## License

MIT
