# Coin Dash Online — Authoritative Server v2.2.0

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.5.4. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.5.4
- Server: v2.2.0
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
  "version": 14,
  "engine": "foundry-2026-08-05-r9"
}
```

## v2.2.0 changes

- Adds a `RoomDirectory` Durable Object that maintains the public active-server list.
- `GET /rooms` returns active rooms, player counts, capacity, phase, level, difficulty, and whether the room can be joined.
- Rooms register and refresh themselves from authoritative lifecycle events and heartbeats.
- Empty, closed, and stale rooms are removed from the browser.
- The room owner reconnect grace period is increased from 7 seconds to 60 seconds.
- Deliberately leaving or closing a room still transfers or closes immediately.
- Multiplayer protocol 18 matches Coin Dash client v1.5.4.

## Cloudflare migration

`wrangler.jsonc` adds the `DIRECTORY` Durable Object binding and the `v2` migration for `RoomDirectory`. Upload the entire server folder so Cloudflare applies this migration.

## Phone deployment

1. Upload the five files from `1_SERVER_REPO_UPLOAD` to the root of the existing server repository.
2. Keep the existing `package-lock.json` if present.
3. Commit to the production branch connected to Cloudflare.
4. Confirm the health endpoint shows protocol 18, version 14, and engine revision `foundry-2026-08-05-r9`.
5. Upload the matching client `index.html` to the GitHub Pages repository.
6. Close and reopen the game on every device.
