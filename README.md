# Coin Dash Online — Authoritative Server v2.0.8

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.5.0. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.5.0
- Server: v2.0.8
- Multiplayer protocol 15
- Engine revision: `foundry-2026-08-04-r6`

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
  "protocol": 15,
  "version": 11,
  "engine": "foundry-2026-08-04-r6"
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
4. Open the health-check address and confirm protocol 15, version 11, and the matching engine revision before uploading the client.

## v2.0.8 changes

- Multiplayer protocol 15 matches Coin Dash client v1.5.0.
- Players now start with only Star Surge, the six-second invincibility power.
- The former default Cryo Freeze slot is no longer assigned or accepted as a player super.
- Power pickups respawn after a randomized 8–14 second delay.
- Each respawn rerolls to a different pickup type from the one collected.
- Respawn timing and pickup type remain authoritative for every connected player.
- All 15 stages use standard level numbering. The timed coin stages are Levels 5, 10, and 15.
- Dash collision feedback remains separate from real damage state, so dash impacts do not create damage blinking.

## Architecture

The `GameRoom` Durable Object owns the lobby, players, current owner, level, difficulty, movement, dash validation, powers, health, coins, enemies, bosses, hazards, scoring, transitions, chat, reconnection, and room persistence. The person selecting Host Online initially becomes room owner but is never the network host. Ownership can transfer to another connected player if the owner does not reconnect.

No WebRTC, SDP, ICE, peer DataChannels, or TURN endpoint is used.


## Level progression

All stages use standard level numbering. Levels 5, 10, and 15 are timed coin stages placed directly in the 15-level progression. They are not labeled separately in the client.
