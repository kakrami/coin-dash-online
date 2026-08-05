# Coin Dash Online — Authoritative Server v2.2.2

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.5.8. Do not create a new repository.

## Matching versions

- Client: Coin Dash v1.5.8
- Server: v2.2.2
- Multiplayer protocol 19
- Engine revision: `foundry-2026-08-05-r10`

Deploy the server before the matching client because Cryo Shard gameplay behavior changed in the authoritative engine.

## Production addresses

- Server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
- Health: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`
- Active rooms: `https://coin-dash-online.kiadesignenterprise.workers.dev/rooms`

Expected health values:

```json
{
  "protocol": 19,
  "version": 16,
  "engine": "foundry-2026-08-05-r10"
}
```

## v2.2.2 changes

- Cryo Shard is now a timed moving freeze field instead of a one-time pulse followed by a visual-only circle.
- Enemies are frozen whenever they enter the visible 225-radius field and thaw shortly after leaving it.
- Frozen enemies cannot deal contact damage.
- Freeze duration, radius, enemy state, and contact rules are server authoritative for multiplayer.
- Multiplayer protocol increased to 19 and engine revision increased to `foundry-2026-08-05-r10`.

## Existing room lifecycle behavior

- Active-room counts require a recent client heartbeat.
- Silent connections stop counting as active after 45 seconds.
- Empty rooms disappear from the public browser immediately and are deleted after two minutes.
- The owner reconnect grace period remains 60 seconds.

## Phone deployment

1. Upload the five files from `1_SERVER_REPO_UPLOAD` to the root of the existing server repository.
2. Keep the existing `package-lock.json` if present.
3. Commit to the production branch connected to Cloudflare.
4. Confirm the health endpoint shows protocol 19, version 16, and engine revision `foundry-2026-08-05-r10`.
5. Upload the matching client `index.html` to the GitHub Pages repository.
6. Close and reopen the game on every device.
