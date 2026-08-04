# Coin Dash Online — Authoritative Server v2.0.3

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.4.4. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.4.4
- Server: v2.0.3
- Multiplayer protocol: 10
- Engine revision: `foundry-2026-08-04-r1`

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
  "protocol": 10,
  "version": 6,
  "engine": "foundry-2026-08-04-r1"
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
4. Open the health-check address and confirm protocol 10, version 6, and the matching engine revision before uploading the client.

## v2.0.3 fixes

- Input packet, dash, and special-power sequences reset safely for each WebSocket connection generation, so a reloaded player can move immediately.
- Added authoritative `startLevel` support for Change Level, Play Again, Next Bonus, and result-screen level selection.
- Added room-owner migration after a short reconnect grace period.
- Owner readiness checks follow the current owner instead of assuming Player 1 is always the owner.
- Disconnected players are excluded from enemy targeting, hazards, completion checks, and public connected state.
- Fire patches are sent once as sequenced reliable events instead of being repeated in every motion packet.
- Full correction snapshots were reduced to 4 Hz while compact motion remains 30 Hz.
- Added per-socket and per-room limits for input, sync, chat, ping, and control messages.
- Removed obsolete host-era readiness and fire-delivery assumptions.
- Client and server verify the same engine revision before a session is accepted.

## Architecture

The `GameRoom` Durable Object owns the lobby, players, current owner, level, difficulty, movement, dash validation, powers, health, coins, enemies, bosses, hazards, scoring, transitions, chat, reconnection, and room persistence. The person selecting Host Online initially becomes room owner but is never the network host. Ownership can transfer to another connected player if the owner does not reconnect.

No WebRTC, SDP, ICE, peer DataChannels, or TURN endpoint is used.
