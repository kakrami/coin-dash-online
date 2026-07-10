# Coin Dash Online

Cloudflare Worker and Durable Object signaling service for Coin Dash.

## Endpoints

- `GET /health`
- `POST /rooms`
- `GET /rooms/{ROOM_CODE}/socket`
- `GET /turn`

Add these Cloudflare Worker secrets before using TURN:

- `TURN_KEY_ID`
- `TURN_KEY_API_TOKEN`
