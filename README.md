# Coin Dash Online — Authoritative Server v2.3.0

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.6.0. Do not create a new repository.

## Matching versions

• Client: Coin Dash v1.6.0
• Server: v2.3.0
• Multiplayer protocol: 20
• Engine revision: `foundry-2026-08-05-r11`

Deploy the server before the matching client.

## Production addresses

• Server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
• Health: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`
• Active rooms: `https://coin-dash-online.kiadesignenterprise.workers.dev/rooms`

Expected health values:

```json
{
  "protocol": 20,
  "version": 18,
  "engine": "foundry-2026-08-05-r11"
}
```

## v2.3.0 changes

• Room connectivity is based on accepted server WebSockets rather than recent browser heartbeat messages.
• Minimizing or backgrounding the host page no longer removes the room or blocks new joins.
• Durable Object alarms refresh the public room directory every 25 seconds while a room has connected players.
• The active room directory keeps records for up to two minutes between server refreshes.
• Rooms with no connected sockets are removed immediately and deleted after two minutes.
• Rooms with connected clients but no messages for 30 minutes are closed as inactive.
• Owner migration starts only after the owner WebSocket actually disconnects.
• The client retries active room requests and preserves the last successful list during transient failures.
• Returning to the foreground immediately pings, synchronizes, or reconnects the multiplayer session.

## Phone deployment

1. Upload the files from `1_SERVER_REPO_UPLOAD` to the root of the existing server repository.
2. Keep the existing `package-lock.json` if present.
3. Commit to the production branch connected to Cloudflare.
4. Confirm the health endpoint shows protocol 20, version 18, and engine revision `foundry-2026-08-05-r11`.
5. Upload the matching client `index.html` to the GitHub Pages repository.
6. Close and reopen the game on every device.
