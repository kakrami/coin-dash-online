# Coin Dash Online — Authoritative Server v2.0.5

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.4.6. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.4.6
- Server: v2.0.5
- Multiplayer protocol: 12
- Engine revision: `foundry-2026-08-04-r3`

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
  "protocol": 12,
  "version": 8,
  "engine": "foundry-2026-08-04-r3"
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
4. Open the health-check address and confirm protocol 12, version 8, and the matching engine revision before uploading the client.

## v2.0.5 fixes

- New runs now inherit each connected player's current dash and power action cursors.
- A carried action counter can no longer trigger a power automatically when a match or level begins.
- Invalid or neutral power slots are consumed safely instead of defaulting to the first power.
- Power events are processed monotonically and only explicit slot 0 or slot 1 events can activate a power.
- Coin positions and collected state are now included in the 30 Hz compact motion stream.
- Magnetized coins, bonus rings, moving lanes, and figure-eight bonus coins no longer depend on the 4 Hz full correction snapshot for visual movement.
- Full authoritative correction snapshots remain at 4 Hz while player, enemy, and coin motion remains at 30 Hz.

## Architecture

The `GameRoom` Durable Object owns the lobby, players, current owner, level, difficulty, movement, dash validation, powers, health, coins, enemies, bosses, hazards, scoring, transitions, chat, reconnection, and room persistence. The person selecting Host Online initially becomes room owner but is never the network host. Ownership can transfer to another connected player if the owner does not reconnect.

No WebRTC, SDP, ICE, peer DataChannels, or TURN endpoint is used.
