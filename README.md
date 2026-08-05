# Coin Dash Online — Authoritative Server v2.2.1

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.5.5. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.5.5
- Server: v2.2.1
- Multiplayer protocol 18
- Engine revision: `foundry-2026-08-05-r9`

Deploy the server first, then deploy the matching client.

## Production addresses

- Server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
- Health: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`
- Active rooms: `https://coin-dash-online.kiadesignenterprise.workers.dev/rooms`

Expected health values:

```json
{
  "protocol": 18,
  "version": 15,
  "engine": "foundry-2026-08-05-r9"
}
```

## v2.2.1 changes

- Active-room counts now require a recent client heartbeat instead of merely trusting an existing WebSocket object.
- Phone or browser connections that silently die stop counting as active after 45 seconds.
- Rooms with zero active players are immediately removed from the public server browser.
- Brand-new players cannot revive a room after every active participant has disappeared; only reserved participants may reconnect during the recovery window.
- An empty room receives a two-minute reconnect window, then its sockets, stored state, reservations, and directory entry are permanently deleted.
- Newly created rooms that never connect are also destroyed after the same two-minute window.
- The 60-second owner reconnect grace period remains unchanged.
- Multiplayer protocol 18 and engine revision `foundry-2026-08-05-r9` remain compatible with the previous client protocol.

## Cloudflare migration

`wrangler.jsonc` adds the `DIRECTORY` Durable Object binding and the `v2` migration for `RoomDirectory`. Upload the entire server folder so Cloudflare applies this migration.

## Phone deployment

1. Upload the five files from `1_SERVER_REPO_UPLOAD` to the root of the existing server repository.
2. Keep the existing `package-lock.json` if present.
3. Commit to the production branch connected to Cloudflare.
4. Confirm the health endpoint shows protocol 18, version 15, and engine revision `foundry-2026-08-05-r9`.
5. Upload the matching client `index.html` to the GitHub Pages repository.
6. Close and reopen the game on every device.
