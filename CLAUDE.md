# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run type-check    # TypeScript type checking (tsc --noEmit)
```

No build step — the package ships raw TypeScript source. The OpenClaw host framework handles TS execution at runtime.

## Architecture

This is `@egoai/sideclaw`, an OpenClaw channel plugin that connects an OpenClaw agent to SideClaw for real-time AI voice conversations via WebSocket relay.

### Plugin registration flow

`src/index.ts` exports a `register(api)` function called by the OpenClaw gateway. It registers `sideClawChannel` (defined in `src/channel.ts`) which implements the OpenClaw ChannelPlugin interface with config resolution and a `gateway.startAccount` entry point.

### Core pattern: buffered reverse WebSocket relay

The gateway runs behind NAT, so SideClaw can't reach it. Instead, the plugin dials out:

1. Connect to local gateway WebSocket (loopback, port 18789 default)
2. Buffer the `connect.challenge` message from gateway
3. Dial SideClaw's WebSocket server
4. Send pre-handshake frame (identity token + gateway token)
5. Forward buffered challenge to SideClaw
6. Relay handshake messages (connect RPC / hello-ok)
7. Switch to transparent bidirectional frame relay

This lives in `src/monitor.ts:startAccount()`. The gateway's ChannelManager auto-restarts it with backoff on disconnect.

### Config resolution

`src/config.ts` resolves typed `SideClawAccount` from raw OpenClaw config. Gateway token comes from `OPENCLAW_GATEWAY_TOKEN` env var (preferred) or `gateway.auth.token` in config. Secrets are never exposed through `inspectAccount()`.

### Security measures

- `validateWsUrl()` rejects non-ws/wss schemes (SSRF prevention)
- `checkPlaintextToken()` warns when tokens traverse unencrypted remote connections
- Loopback addresses (127.0.0.1, localhost, [::1]) are exempt from plaintext warnings

## Key conventions

- ESM-only (`"type": "module"` in package.json)
- Import paths use `.js` extensions (standard ESM TypeScript convention)
- Zero runtime dependencies — only TypeScript as a dev dependency
- Plugin manifest in `openclaw.plugin.json` defines config schema and UI hints
