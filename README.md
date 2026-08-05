# Coin Dash Online — Authoritative Server v2.3.1

This is the existing `coin-dash-online` Cloudflare Worker repository for Coin Dash v1.6.1. Do not create a new repository.

## Matching versions

• Client: Coin Dash v1.6.1
• Server: v2.3.1
• Multiplayer protocol: 20
• Engine revision: `foundry-2026-08-05-r12`

Deploy the server before the matching client.

## Production addresses

• Server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
• Health: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`
• Active rooms: `https://coin-dash-online.kiadesignenterprise.workers.dev/rooms`

Expected health values:

```json
{
  "protocol": 20,
  "version": 19,
  "engine": "foundry-2026-08-05-r12"
}
```

## v2.3.1 changes

• Bonus levels create no pickup items.
• Restored bonus-level game state removes legacy pickup items before it is served to players.
• Multiplayer protocol remains 20 because the synchronized state format is unchanged.

## Phone deployment

1. Upload the files from `1_SERVER_REPO_UPLOAD` to the root of the existing server repository.
2. Keep the existing `package-lock.json` if present.
3. Commit to the production branch connected to Cloudflare.
4. Confirm the health endpoint shows protocol 20, version 19, and engine revision `foundry-2026-08-05-r12`.
5. Upload the matching client `index.html` to the GitHub Pages repository.
6. Close and reopen the game on every device.
