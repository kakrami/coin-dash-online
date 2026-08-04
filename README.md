# Coin Dash Online — Authoritative Server v2.0.1

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.4.2. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.4.2
- Server: v2.0.1
- Multiplayer protocol: 9

The client and server must be deployed together.

## Production addresses

- Authoritative server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
- Health check: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`

Expected health response:

```json
{
  "ok": true,
  "service": "coin-dash-online",
  "mode": "authoritative",
  "protocol": 9,
  "version": 4
}
```

## Repository files

```text
coin-dash-online/
├── worker.js
├── wrangler.jsonc
├── package.json
├── .gitignore
└── README.md
```

Keep an existing `package-lock.json` if the repository already has one.

## Phone deployment

1. Upload the five files above to the root of the existing `coin-dash-online` GitHub repository.
2. Commit directly to the production branch already connected to Cloudflare.
3. Wait for the Cloudflare build to show Success.
4. Open the health-check address and confirm protocol 9 before uploading the matching client.

## v2.0.1 fixes

- Replaced frame-dependent level changes with absolute timed phases.
- Added an explicit level-clear phase before loading the next level.
- Repaired countdown and level-intro recovery after a Durable Object wakes.
- Advances expired transitions whenever any player input, ping, or sync message arrives.
- Removed stale peer-host dash-sequence references from level resets.
- Preserves authoritative player slots, inputs, dash sequences, and special sequences between levels.

## Architecture

The `GameRoom` Durable Object owns the lobby, players, level, difficulty, movement, dash validation, powers, health, coins, enemies, bosses, hazards, scoring, transitions, chat, reconnection, and room persistence. The person selecting Host Online remains the lobby owner but is not the network host.

No WebRTC, SDP, ICE, peer DataChannels, or TURN endpoint is used.
