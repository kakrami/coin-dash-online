const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "cache-control": "no-store",
};

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_PLAYERS = 5;
const MAX_MESSAGE_BYTES = 64 * 1024;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function makeRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join("");
}

function normalizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "coin-dash-online" });
    }

    if (url.pathname === "/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = makeRoomCode();
        const id = env.ROOMS.idFromName(code);
        const room = env.ROOMS.get(id);
        const created = await room.fetch("https://room.internal/create", {
          method: "POST",
        });

        if (created.status === 201) {
          return json({ code }, 201);
        }
      }

      return json({ error: "Could not create a room. Try again." }, 503);
    }

    const roomMatch = url.pathname.match(/^\/rooms\/([A-Z2-9]{6})\/socket$/i);
    if (roomMatch) {
      const code = normalizeRoomCode(roomMatch[1]);
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }

    if (url.pathname === "/turn" && request.method === "GET") {
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
        return json({ error: "TURN secrets are not configured." }, 503);
      }

      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 3600 }),
        },
      );

      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: JSON_HEADERS,
      });
    }

    return json({ error: "Not found." }, 404);
  },
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/create" && request.method === "POST") {
      const createdAt = await this.ctx.storage.get("createdAt");
      if (createdAt) {
        return json({ error: "Room already exists." }, 409);
      }

      await this.ctx.storage.put("createdAt", Date.now());
      return json({ ok: true }, 201);
    }

    const createdAt = await this.ctx.storage.get("createdAt");
    if (!createdAt) {
      return json({ error: "Room not found." }, 404);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket required." }, 426);
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      return json({ error: "Room is full." }, 409);
    }

    const role = url.searchParams.get("role") === "host" ? "host" : "player";
    const clientId =
      String(url.searchParams.get("client") || crypto.randomUUID()).slice(0, 80);

    if (role === "host") {
      const hostExists = sockets.some((socket) => {
        const attachment = socket.deserializeAttachment();
        return attachment?.role === "host";
      });

      if (hostExists) {
        return json({ error: "This room already has a host." }, 409);
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({
      role,
      clientId,
      connectedAt: Date.now(),
    });

    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: "room-ready",
        role,
        clientId,
        peers: sockets.length,
      }),
    );

    this.broadcast(
      {
        type: "peer-joined",
        role,
        clientId,
      },
      server,
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== "string") {
      socket.close(1003, "Text messages only");
      return;
    }

    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Invalid JSON." }));
      return;
    }

    if (!payload || typeof payload !== "object") {
      return;
    }

    const sender = socket.deserializeAttachment() || {};
    this.broadcast(
      {
        ...payload,
        from: sender.clientId || "",
        fromRole: sender.role || "player",
      },
      socket,
    );
  }

  webSocketClose(socket, code, reason) {
    const sender = socket.deserializeAttachment() || {};
    this.broadcast(
      {
        type: "peer-left",
        clientId: sender.clientId || "",
        role: sender.role || "player",
        code,
        reason,
      },
      socket,
    );
  }

  webSocketError(socket) {
    try {
      socket.close(1011, "WebSocket error");
    } catch {
      // Socket may already be closed.
    }
  }

  broadcast(payload, exceptSocket = null) {
    const message = JSON.stringify(payload);

    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exceptSocket) continue;

      try {
        socket.send(message);
      } catch {
        // Ignore sockets that closed between enumeration and send.
      }
    }
  }
}
