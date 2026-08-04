# Coin Dash Online — Authoritative Server v2.0.2

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.4.3. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.4.3
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
  "version": 5
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

## v2.0.2 fixes

- Online menus and chat are local overlays and never pause the authoritative match.
- Older clients that still send pause or resume messages cannot pause the room.
- Lobby level and difficulty edits preserve connected players’ Ready status.
- Removed the redundant full-state setup event for ordinary lobby setting changes.
- Restored active persisted matches as unpaused after a Worker wake.

## Architecture

The `GameRoom` Durable Object owns the lobby, players, level, difficulty, movement, dash validation, powers, health, coins, enemies, bosses, hazards, scoring, transitions, chat, reconnection, and room persistence. The person selecting Host Online remains the lobby owner but is not the network host.

No WebRTC, SDP, ICE, peer DataChannels, or TURN endpoint is used.
