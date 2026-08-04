# Coin Dash Online — Authoritative Server v2.0.0

This is the existing `coin-dash-online` Cloudflare Worker repository converted from WebRTC signaling into the authoritative multiplayer server for Coin Dash v1.4.0.

## Production addresses

- Game client: your existing GitHub Pages site under `https://kakrami.github.io/...`
- Authoritative server: `https://coin-dash-online.kiadesignenterprise.workers.dev`
- Health check: `https://coin-dash-online.kiadesignenterprise.workers.dev/health`

## Repository files

```text
coin-dash-online/
├── worker.js
├── wrangler.jsonc
├── package.json
├── .gitignore
└── README.md
```

Do not create another repository. Replace the matching files in the existing `coin-dash-online` repository. Keep an existing `package-lock.json` if the repository already has one; `npm install` will update it.

## What changed

The Durable Object `GameRoom` now owns:

- room creation and five stable player slots
- lobby owner, level, difficulty, readiness, and chat
- authoritative player movement and dash validation
- both special powers and cooldowns
- health, damage, coins, pickups, enemies, bosses, hazards, and bonus timers
- 60 Hz fixed-step game simulation
- 30 Hz compact motion packets
- 10 Hz authoritative correction snapshots
- reconnection with the same browser-session player ID
- persisted room state and automatic room expiration

The browser that presses Host remains the lobby owner, but it is no longer the game server.

## Protocol compatibility

The server and client use protocol `8`.

- Coin Dash v1.4.0 connects to this server.
- Older protocol-7 clients are intentionally rejected.
- Deploy when no match is active because a Worker deployment disconnects existing WebSockets.

## First deployment

Open PowerShell in the existing `coin-dash-online` repository:

```powershell
npm install
npx wrangler login
npm run deploy
```

`npx wrangler login` opens a browser only when Wrangler is not already authenticated.

Verify deployment:

```powershell
Invoke-RestMethod https://coin-dash-online.kiadesignenterprise.workers.dev/health
```

Expected result:

```text
ok       : True
service  : coin-dash-online
mode     : authoritative
protocol : 8
version  : 3
```

Do not publish the v1.4.0 client until this health check reports protocol 8.

## Local test

Terminal 1, from this server repository:

```powershell
npm install
npm run dev
```

Wrangler normally listens at `http://127.0.0.1:8787`.

Terminal 2, from the folder containing the v1.4.0 `index.html`:

```powershell
python -m http.server 8000
```

Open this exact address in two separate browser windows or devices on the same computer:

```text
http://127.0.0.1:8000
```

The v1.4.0 client automatically uses the local Worker when its hostname is `localhost` or `127.0.0.1`; the published GitHub Pages copy automatically uses the production Worker.

Recommended local flow:

1. Window A selects Host Online.
2. Window B selects Join Online and enters the room code.
3. Window B selects Ready.
4. Window A starts Level 1.
5. Move and dash on both clients.
6. Test Cryo Freeze and Star Surge.
7. Disconnect Window B, reopen it in the same browser session, and join the same room again.
8. Confirm it returns to the same player slot.

## Publish the client

After the server health check succeeds:

1. Extract `index.html` from `coin_dash_inferno_foundry_v1.4.0.zip`.
2. Replace the existing `index.html` in the existing GitHub Pages repository.
3. Commit and push to the branch already configured in **Settings → Pages**.
4. Wait for the existing Pages deployment to finish.
5. Hard-refresh every test device so no protocol-7 page remains cached.

## Origin restriction

`wrangler.jsonc` currently permits the GitHub Pages origin:

```text
https://kakrami.github.io
```

The browser origin contains only the scheme and hostname, not the repository path, so this covers a Pages address such as `https://kakrami.github.io/coin-dash/`.

To use a custom domain later, set `GAME_ORIGIN` to a comma-separated list:

```json
"GAME_ORIGIN": "https://kakrami.github.io,https://game.example.com"
```

Then redeploy.

## TURN and old signaling settings

The authoritative version does not use:

- WebRTC peer connections
- SDP offers or answers
- ICE candidates
- Cloudflare TURN credentials
- the old `/turn` endpoint

Existing `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets can remain temporarily without affecting the server. After v1.4.0 is confirmed working, they may be deleted from Cloudflare because `worker.js` no longer reads them.

## Monitoring

Stream production logs:

```powershell
npm run tail
```

Cloudflare dashboard path:

```text
Workers & Pages → coin-dash-online → Logs
```

Useful checks:

```powershell
Invoke-RestMethod https://coin-dash-online.kiadesignenterprise.workers.dev/health
```

A normal server should report `mode: authoritative` and `protocol: 8`.

## Rollback

Keep copies of the current production files before deployment.

To roll back:

1. Restore the previous `worker.js`, `wrangler.jsonc`, `package.json`, and README in `coin-dash-online`.
2. Run `npm install` and `npm run deploy`.
3. Restore the previous GitHub Pages `index.html`.
4. Hard-refresh test devices.

The old client and old Worker must be restored together because protocol 7 and protocol 8 are intentionally incompatible.
