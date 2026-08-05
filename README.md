# Coin Dash Online — Authoritative Server v2.2.3

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.5.9. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.5.9
- Server: v2.2.3
- Multiplayer protocol 20
- Engine revision: `foundry-2026-08-05-r11`

Deploy the server before the matching client because player spawn placement changed in the authoritative engine.

## Production addresses

- Server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
- Health: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`
- Active rooms: `https://coin-dash-online.kiadesignenterprise.workers.dev/rooms`

Expected health values:

```json
{
  "protocol": 20,
  "version": 17,
  "engine": "foundry-2026-08-05-r11"
}
```

## v2.2.3 changes

- Replaced fixed player coordinates with a deterministic level-aware spawn resolver.
- Spawn positions are checked against walls, forced-movement hazards, damaging hazards, enemy start zones, arena borders, and other players.
- New mid-game players use the same safe spawn resolver.
- Every countdown-to-play transition clears residual velocity, dash, recoil, and trail state without clearing currently held movement input.
- Starting or returning to a run neutralizes stale network movement while preserving input sequence counters.
- Multiplayer protocol increased to 20 and engine revision increased to `foundry-2026-08-05-r11`.

## Existing room lifecycle behavior

- Active-room counts require a recent client heartbeat.
- Silent connections stop counting as active after 45 seconds.
- Empty rooms disappear from the public browser immediately and are deleted after two minutes.
- The owner reconnect grace period remains 60 seconds.

## Phone deployment

1. Upload the five files from `1_SERVER_REPO_UPLOAD` to the root of the existing server repository.
2. Keep the existing `package-lock.json` if present.
3. Commit to the production branch connected to Cloudflare.
4. Confirm the health endpoint shows protocol 20, version 17, and engine revision `foundry-2026-08-05-r11`.
5. Upload the matching client `index.html` to the GitHub Pages repository.
6. Close and reopen the game on every device.
