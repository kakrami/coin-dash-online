# Coin Dash Online — Authoritative Server v2.1.0

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.5.3. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.5.3
- Server: v2.1.0
- Multiplayer protocol 17
- Engine revision: `foundry-2026-08-05-r8`

The client and server must be deployed together. Deploy the server first.

## Production addresses

- Authoritative server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
- Health check: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`

Expected health response:

```json
{
  "ok": true,
  "service": "coin-dash-online",
  "mode": "authoritative",
  "protocol": 17,
  "version": 13,
  "engine": "foundry-2026-08-05-r8"
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
4. Open the health-check address and confirm protocol 17, version 13, and engine revision `foundry-2026-08-05-r8`.
5. Upload the matching client `index.html` to the GitHub Pages repository.
6. Close and reopen the game on every device.

## v2.1.0 changes

- Player identity is now separate from the reusable numeric player slot.
- A new participant always receives a clean authoritative player state instead of inheriting a previous occupant's health, death state, score, powers, or action cursors.
- Explicitly released and expired player slots now remove their old avatar and input state from the authoritative engine.
- Leave events are terminal: their later socket-close callback cannot recreate the discarded avatar, and a departing host is excluded from ownership migration.
- Reconnecting players keep their reserved state while genuinely new players are initialized at a valid spawn with temporary protection.
- The client clears stale menu, keyboard, pointer, and action state during the join handshake and immediately confirms input ownership with the server.
- Multiplayer protocol 17 matches Coin Dash client v1.5.3.

## Architecture

The `GameRoom` Durable Object owns the lobby, players, current owner, level, difficulty, movement, dash validation, powers, health, coins, enemies, bosses, hazards, scoring, transitions, chat, reconnection, and room persistence. The person selecting Host Online initially becomes room owner but is never the network host. Ownership can transfer to another connected player if the owner does not reconnect.

No WebRTC, SDP, ICE, peer DataChannels, or TURN endpoint is used.

## Level progression

All stages use standard level numbering. Levels 5, 10, and 15 are timed coin stages placed directly in the 15-level progression. They are not labeled separately in the client.
