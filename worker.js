const GAME_ORIGIN = "https://kakrami.github.io";
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_PLAYERS = 5;
const MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "access-control-allow-origin": origin === GAME_ORIGIN ? origin : GAME_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function makeRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length],
  ).join("");
}

function normalizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
}

function safeClientId(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (url.pathname === "/health") {
      return json(request, {
        ok: true,
        service: "coin-dash-online",
        version: 2,
      });
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
          return json(request, { code }, 201);
        }
      }

      return json(request, { error: "Could not create a room." }, 503);
    }

    const roomMatch = url.pathname.match(
      /^\/rooms\/([A-Z2-9]{6})\/socket$/i,
    );
    if (roomMatch) {
      const code = normalizeRoomCode(roomMatch[1]);
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }

    if (url.pathname === "/turn" && request.method === "GET") {
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
        return json(request, { error: "TURN is not configured." }, 503);
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
        headers: {
          ...corsHeaders(request),
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    return json(request, { error: "Not found." }, 404);
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
        return json(request, { error: "Room already exists." }, 409);
      }

      const now = Date.now();
      await this.ctx.storage.put("createdAt", now);
      await this.ctx.storage.setAlarm(now + ROOM_LIFETIME_MS);
      return json(request, { ok: true }, 201);
    }

    const createdAt = await this.ctx.storage.get("createdAt");
    if (!createdAt) {
      return json(request, { error: "Room not found." }, 404);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json(request, { error: "WebSocket required." }, 426);
    }

    const role = url.searchParams.get("role") === "host" ? "host" : "player";
    const clientId = safeClientId(url.searchParams.get("client"));
    if (!clientId) {
      return json(request, { error: "Missing client ID." }, 400);
    }

    const sockets = this.ctx.getWebSockets();
    const members = sockets.map((socket) => ({
      socket,
      attachment: socket.deserializeAttachment() || {},
    }));

    const duplicate = members.find(
      ({ attachment }) => attachment.clientId === clientId,
    );
    if (duplicate) {
      duplicate.socket.serializeAttachment({
        ...duplicate.attachment,
        replaced: true,
      });
      try {
        duplicate.socket.close(4001, "Reconnected");
      } catch {
        // The old socket may already be closing.
      }
    }

    const liveMembers = members.filter(
      ({ attachment }) => attachment.clientId !== clientId,
    );
    const existingHost = liveMembers.find(
      ({ attachment }) => attachment.role === "host",
    );

    if (role === "host" && existingHost) {
      return json(request, { error: "Room already has a host." }, 409);
    }

    if (role === "player" && !existingHost) {
      return json(request, { error: "Host is not connected." }, 409);
    }

    const playerCount = liveMembers.filter(
      ({ attachment }) => attachment.role === "player",
    ).length;
    if (role === "player" && playerCount >= MAX_PLAYERS - 1) {
      return json(request, { error: "Room is full." }, 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const socketId = crypto.randomUUID();

    server.serializeAttachment({
      role,
      clientId,
      socketId,
      connectedAt: Date.now(),
      replaced: false,
    });
    this.ctx.acceptWebSocket(server);

    const visibleMembers = liveMembers.map(({ attachment }) => ({
      role: attachment.role || "player",
      clientId: attachment.clientId || "",
    }));

    server.send(
      JSON.stringify({
        type: "room-ready",
        role,
        clientId,
        members: visibleMembers,
      }),
    );

    this.sendToAll(
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
      socket.send(JSON.stringify({ type: "error", error: "Invalid message." }));
      return;
    }

    if (!payload || typeof payload !== "object") return;

    const sender = socket.deserializeAttachment() || {};
    const envelope = {
      ...payload,
      from: sender.clientId || "",
      fromRole: sender.role || "player",
    };

    const target = safeClientId(payload.to);
    if (target) {
      this.sendToClient(target, envelope, socket);
    } else {
      this.sendToAll(envelope, socket);
    }
  }

  webSocketClose(socket, code, reason) {
    const sender = socket.deserializeAttachment() || {};
    if (sender.replaced) return;

    this.sendToAll(
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

  async alarm() {
    if (this.ctx.getWebSockets().length) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_LIFETIME_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
  }

  sendToClient(clientId, payload, exceptSocket = null) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exceptSocket) continue;
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.clientId !== clientId) continue;
      try {
        socket.send(message);
      } catch {
        // Ignore a socket that closed between enumeration and send.
      }
    }
  }

  sendToAll(payload, exceptSocket = null) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exceptSocket) continue;
      try {
        socket.send(message);
      } catch {
        // Ignore a socket that closed between enumeration and send.
      }
    }
  }
}
