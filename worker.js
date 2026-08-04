const GAME_ORIGIN = "https://kakrami.github.io";
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_PLAYERS = 5;
const MAX_MESSAGE_BYTES = 32 * 1024;
const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;
const DISCONNECTED_SLOT_TTL_MS = 2 * 60 * 1000;
const PROTOCOL_VERSION = 8;
const SIMULATION_STEP_MS = 1000 / 60;
const MOTION_INTERVAL_MS = 1000 / 30;
const STATE_INTERVAL_MS = 1000 / 10;
const PERSIST_INTERVAL_MS = 10_000;
const MAX_CATCHUP_STEPS = 6;

function allowedOrigins(env) {
  const configured = String(env.GAME_ORIGIN || GAME_ORIGIN)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...configured, "http://localhost:8787", "http://127.0.0.1:8787", "http://localhost:8000", "http://127.0.0.1:8000"]);
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).has(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || GAME_ORIGIN;
  const allow = originAllowed(request, env) ? origin : String(env.GAME_ORIGIN || GAME_ORIGIN).split(",")[0].trim();
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "content-type": "application/json; charset=utf-8",
    },
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

function safeClientId(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80);
}

function safeText(value, max = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function parseJson(message) {
  if (typeof message !== "string") return null;
  try {
    const value = JSON.parse(message);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!originAllowed(request, env)) {
      return json(request, env, { error: "Origin not allowed." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/health") {
      return json(request, env, {
        ok: true,
        service: "coin-dash-online",
        mode: "authoritative",
        protocol: PROTOCOL_VERSION,
        version: 3,
      });
    }

    if (url.pathname === "/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = makeRoomCode();
        const id = env.ROOMS.idFromName(code);
        const room = env.ROOMS.get(id);
        const created = await room.fetch("https://room.internal/create", { method: "POST" });
        if (created.status === 201) {
          return json(request, env, { code, protocol: PROTOCOL_VERSION, mode: "authoritative" }, 201);
        }
      }
      return json(request, env, { error: "Could not create a room." }, 503);
    }

    const roomMatch = url.pathname.match(/^\/rooms\/([A-Z2-9]{6})\/socket$/i);
    if (roomMatch) {
      const code = normalizeRoomCode(roomMatch[1]);
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }

    return json(request, env, { error: "Not found." }, 404);
  },
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.meta = null;
    this.engine = createGameEngine({
      event: (kind) => this.onEngineEvent(kind),
      sfx: (message) => this.broadcast(message),
    });
    this.chat = [];
    this.loopTimer = null;
    this.loopGeneration = 0;
    this.lastTickAt = 0;
    this.accumulator = 0;
    this.lastMotionAt = 0;
    this.lastStateAt = 0;
    this.lastPersistAt = 0;
    this.initialized = false;
    this.loading = this.ctx.blockConcurrencyWhile(async () => {
      await this.load();
      this.initialized = true;
    });
  }

  async load() {
    const stored = await this.ctx.storage.get(["meta", "game", "epoch", "chat"]);
    this.meta = stored.get("meta") || null;
    this.chat = Array.isArray(stored.get("chat")) ? stored.get("chat").slice(-30) : [];
    if (!this.meta) return;

    const liveIds = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (Number.isInteger(attachment.id)) liveIds.add(attachment.id);
    }

    const roster = [];
    for (let id = 0; id < MAX_PLAYERS; id += 1) {
      roster.push({ id, connected: liveIds.has(id) });
    }

    const game = stored.get("game");
    if (game) this.engine.restore(game, roster, stored.get("epoch") || 1);
    else {
      this.engine.setSettings(this.meta.difficulty, this.meta.level);
      for (const row of roster) if (row.connected) this.engine.setConnectedPlayer(row.id, true);
    }

    if (this.engine.game.phase !== "menu" && !this.engine.game.over && liveIds.size) this.startLoop();
  }

  async fetch(request) {
    await this.loading;
    const url = new URL(request.url);

    if (url.pathname === "/create" && request.method === "POST") {
      if (this.meta) return json(request, this.env, { error: "Room already exists." }, 409);
      const now = Date.now();
      this.meta = {
        createdAt: now,
        ownerClient: "",
        level: 1,
        difficulty: "normal",
        ready: { 0: true },
        slots: {},
      };
      await this.persist(true);
      await this.ctx.storage.setAlarm(now + ROOM_LIFETIME_MS);
      return json(request, this.env, { ok: true }, 201);
    }

    if (!this.meta) return json(request, this.env, { error: "Room not found." }, 404);
    if (!originAllowed(request, this.env)) return json(request, this.env, { error: "Origin not allowed." }, 403);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json(request, this.env, { error: "WebSocket required." }, 426);
    }

    this.reapExpiredSlots();
    const requestedRole = url.searchParams.get("role") === "host" ? "host" : "player";
    const clientId = safeClientId(url.searchParams.get("client"));
    if (!clientId) return json(request, this.env, { error: "Missing client ID." }, 400);

    let id;
    if (requestedRole === "host") {
      if (this.meta.ownerClient && this.meta.ownerClient !== clientId) {
        return json(request, this.env, { error: "Room already has an owner." }, 409);
      }
      this.meta.ownerClient = clientId;
      id = 0;
    } else {
      const existing = this.meta.slots[clientId];
      if (existing && Number.isInteger(existing.id)) id = existing.id;
      else {
        const used = new Set(Object.values(this.meta.slots).map((slot) => slot.id));
        for (let candidate = 1; candidate < MAX_PLAYERS; candidate += 1) {
          if (!used.has(candidate)) {
            id = candidate;
            break;
          }
        }
        if (!Number.isInteger(id)) return json(request, this.env, { error: "Room is full." }, 409);
        this.meta.slots[clientId] = { id, lastSeen: Date.now() };
      }
    }

    for (const oldSocket of this.ctx.getWebSockets()) {
      const attachment = oldSocket.deserializeAttachment() || {};
      if (attachment.clientId !== clientId) continue;
      oldSocket.serializeAttachment({ ...attachment, replaced: true });
      try {
        oldSocket.close(4001, "Reconnected");
      } catch {}
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment = {
      id,
      role: id === 0 ? "host" : "player",
      clientId,
      connectedAt: Date.now(),
      replaced: false,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    this.engine.setConnectedPlayer(id, true);
    if (id === 0) this.meta.ready[0] = true;
    else if (this.meta.ready[id] !== true) this.meta.ready[id] = false;
    if (this.meta.slots[clientId]) this.meta.slots[clientId].lastSeen = Date.now();

    this.send(server, {
      t: "welcome",
      pv: PROTOCOL_VERSION,
      id,
      owner: id === 0,
      epoch: this.engine.epoch(),
      eventSeq: 0,
      g: this.engine.fullState(),
      lobby: this.lobbyPacket(),
      chat: this.chat,
    });
    this.broadcast({
      t: "notice",
      tone: "success",
      text: id === 0 ? "ROOM OWNER CONNECTED" : `P${id + 1} CONNECTED`,
    }, server);
    this.broadcastLobby();
    this.schedulePersist();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    await this.loading;
    if (!this.meta) {
      try { socket.close(4004, "Room closed"); } catch {}
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "Text messages only");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }

    const payload = parseJson(message);
    if (!payload) {
      this.send(socket, { t: "error", error: "Invalid message." });
      return;
    }

    const member = socket.deserializeAttachment() || {};
    const id = Number.isInteger(member.id) ? member.id : -1;
    if (id < 0) return;

    if (payload.t === "ping") {
      this.send(socket, { t: "pong", at: Number(payload.at) || Date.now(), serverAt: Date.now() });
      return;
    }

    if (payload.pv !== PROTOCOL_VERSION) {
      this.send(socket, { t: "versionError", expected: PROTOCOL_VERSION, received: Number(payload.pv) || 0 });
      return;
    }

    switch (payload.t) {
      case "input":
        this.engine.setInput(id, payload.v, payload.seq);
        break;
      case "ready":
        if (id > 0 && this.engine.game.phase === "menu") {
          this.meta.ready[id] = !!payload.ready;
          this.broadcastLobby();
          this.schedulePersist();
        }
        break;
      case "settings":
        if (id === 0 && this.engine.game.phase === "menu") {
          const settings = this.engine.setSettings(payload.difficulty, payload.level);
          this.meta.difficulty = settings.difficulty;
          this.meta.level = settings.level;
          for (const key of Object.keys(this.meta.ready)) if (Number(key) > 0) this.meta.ready[key] = false;
          this.broadcastLobby();
          this.broadcastEvent("setup");
          this.schedulePersist();
        }
        break;
      case "start":
        if (id === 0 && this.engine.game.phase === "menu") {
          const waiting = this.connectedPlayerIds().filter((playerId) => playerId > 0 && !this.meta.ready[playerId]);
          if (waiting.length) {
            this.send(socket, { t: "notice", tone: "pending", text: `WAITING FOR ${waiting.map((playerId) => `P${playerId + 1}`).join(", ")}` });
            break;
          }
          this.engine.startRun(this.meta.difficulty, this.meta.level);
          this.startLoop();
          this.schedulePersist(true);
        }
        break;
      case "pause":
        if (id === 0) this.engine.pauseRun();
        break;
      case "resume":
        if (id === 0) {
          this.engine.resumeRun();
          this.startLoop();
        }
        break;
      case "restart":
        if (id === 0) {
          this.engine.restartRun();
          this.startLoop();
        }
        break;
      case "lobby":
        if (id === 0) {
          this.engine.returnToLobby(this.meta.difficulty, this.meta.level);
          for (const key of Object.keys(this.meta.ready)) if (Number(key) > 0) this.meta.ready[key] = false;
          this.stopLoop();
          this.broadcastLobby();
          this.schedulePersist(true);
        }
        break;
      case "sync":
        this.sendWelcomeState(socket, id);
        break;
      case "chat":
        this.handleChat(socket, id, payload.text);
        break;
      case "closeRoom":
        if (id === 0) {
          this.broadcast({ t: "roomClosed", reason: "The room owner closed the game." });
          this.stopLoop();
          for (const connectedSocket of this.ctx.getWebSockets()) {
            try { connectedSocket.close(1000, "Room closed"); } catch {}
          }
          await this.ctx.storage.deleteAll();
          this.meta = null;
        }
        break;
      case "leave":
        this.releaseClient(member.clientId, id);
        try {
          socket.close(1000, "Left room");
        } catch {}
        break;
      default:
        this.send(socket, { t: "error", error: "Unsupported message." });
    }
  }

  async webSocketClose(socket, code, reason) {
    await this.loading;
    if (!this.meta) return;
    const member = socket.deserializeAttachment() || {};
    if (member.replaced) return;
    const id = Number.isInteger(member.id) ? member.id : -1;
    if (id < 0) return;

    const stillConnected = this.ctx.getWebSockets().some((candidate) => {
      if (candidate === socket) return false;
      const attachment = candidate.deserializeAttachment() || {};
      return attachment.id === id && !attachment.replaced;
    });
    if (stillConnected) return;

    this.engine.removePlayer(id);
    if (id > 0) this.meta.ready[id] = false;
    if (member.clientId && this.meta.slots[member.clientId]) this.meta.slots[member.clientId].lastSeen = Date.now();
    this.broadcast({ t: "notice", tone: "error", text: id === 0 ? "ROOM OWNER DISCONNECTED" : `P${id + 1} DISCONNECTED` }, socket);
    this.broadcastLobby();
    this.schedulePersist(true);
    if (!this.ctx.getWebSockets().length) this.stopLoop();
  }

  webSocketError(socket) {
    try {
      socket.close(1011, "WebSocket error");
    } catch {}
  }

  async alarm() {
    await this.loading;
    if (this.ctx.getWebSockets().length) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_LIFETIME_MS);
      return;
    }
    this.stopLoop();
    await this.ctx.storage.deleteAll();
    this.meta = null;
  }

  connectedPlayerIds() {
    const ids = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (Number.isInteger(attachment.id) && !attachment.replaced) ids.add(attachment.id);
    }
    return [...ids].sort((a, b) => a - b);
  }

  lobbyPacket() {
    const connected = new Set(this.connectedPlayerIds());
    const members = [];
    for (let id = 0; id < MAX_PLAYERS; id += 1) {
      const reserved = id === 0 ? !!this.meta.ownerClient : Object.values(this.meta.slots).some((slot) => slot.id === id);
      members.push({
        id,
        connected: connected.has(id),
        reserved,
        ready: id === 0 ? true : !!this.meta.ready[id],
        owner: id === 0,
      });
    }
    return {
      t: "lobbyState",
      pv: PROTOCOL_VERSION,
      level: this.meta.level,
      difficulty: this.meta.difficulty,
      ready: members.map((member) => [member.id, member.ready ? 1 : 0]),
      members,
    };
  }

  broadcastLobby() {
    this.broadcast(this.lobbyPacket());
  }

  sendWelcomeState(socket, id) {
    this.send(socket, {
      t: "welcome",
      pv: PROTOCOL_VERSION,
      id,
      owner: id === 0,
      epoch: this.engine.epoch(),
      eventSeq: 0,
      g: this.engine.fullState(),
      lobby: this.lobbyPacket(),
      chat: this.chat,
    });
  }

  handleChat(socket, id, value) {
    const text = safeText(value);
    if (!text) return;
    const now = Date.now();
    const message = { t: "chat", id: crypto.randomUUID(), playerId: id, text, time: now };
    this.chat.push(message);
    if (this.chat.length > 30) this.chat.splice(0, this.chat.length - 30);
    this.broadcast(message);
    this.schedulePersist();
  }

  releaseClient(clientId, id) {
    if (id > 0 && clientId && this.meta.slots[clientId]) delete this.meta.slots[clientId];
    if (id > 0) delete this.meta.ready[id];
    this.engine.removePlayer(id);
    this.schedulePersist(true);
  }

  reapExpiredSlots() {
    const now = Date.now();
    const connectedClients = new Set(this.ctx.getWebSockets().map((socket) => (socket.deserializeAttachment() || {}).clientId).filter(Boolean));
    for (const [clientId, slot] of Object.entries(this.meta.slots)) {
      if (connectedClients.has(clientId)) continue;
      if (now - Number(slot.lastSeen || 0) > DISCONNECTED_SLOT_TTL_MS) {
        delete this.meta.ready[slot.id];
        delete this.meta.slots[clientId];
      }
    }
  }

  onEngineEvent(kind) {
    if (!this.initialized) return;
    this.broadcastEvent(kind);
    if (["run", "resume", "level", "go"].includes(kind)) this.startLoop();
    if (["pause", "end", "setup"].includes(kind)) this.stopLoop();
    this.schedulePersist(true);
  }

  broadcastEvent(kind) {
    this.broadcast({
      t: "event",
      pv: PROTOCOL_VERSION,
      epoch: this.engine.epoch(),
      seq: Date.now(),
      kind,
      g: this.engine.fullState(),
    });
  }

  startLoop() {
    if (this.loopTimer || this.engine.game.phase === "menu" || this.engine.game.over || this.engine.game.paused) return;
    const generation = ++this.loopGeneration;
    this.lastTickAt = performance.now();
    this.accumulator = 0;
    const pump = () => {
      if (generation !== this.loopGeneration) return;
      const now = performance.now();
      let elapsed = Math.max(0, Math.min(250, now - this.lastTickAt));
      this.lastTickAt = now;
      this.accumulator = Math.min(SIMULATION_STEP_MS * MAX_CATCHUP_STEPS, this.accumulator + elapsed);
      let steps = 0;
      while (this.accumulator >= SIMULATION_STEP_MS && steps < MAX_CATCHUP_STEPS) {
        this.engine.tick(SIMULATION_STEP_MS / 1000);
        this.accumulator -= SIMULATION_STEP_MS;
        steps += 1;
      }

      if (now - this.lastMotionAt >= MOTION_INTERVAL_MS) {
        this.lastMotionAt = now;
        this.broadcast(this.engine.compactMotionState());
      }
      if (now - this.lastStateAt >= STATE_INTERVAL_MS) {
        this.lastStateAt = now;
        this.broadcast({
          t: "state",
          pv: PROTOCOL_VERSION,
          epoch: this.engine.epoch(),
          seq: this.engine.nextStateSeq(),
          g: this.engine.fullState(),
        });
      }
      if (now - this.lastPersistAt >= PERSIST_INTERVAL_MS) {
        this.schedulePersist();
      }

      if (this.engine.game.phase === "menu" || this.engine.game.over || this.engine.game.paused || !this.ctx.getWebSockets().length) {
        this.stopLoop();
        return;
      }
      this.loopTimer = setTimeout(pump, 4);
    };
    this.loopTimer = setTimeout(pump, 0);
  }

  stopLoop() {
    this.loopGeneration += 1;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = null;
    this.accumulator = 0;
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(payload, exceptSocket = null) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exceptSocket) continue;
      try {
        socket.send(message);
      } catch {}
    }
  }

  schedulePersist(immediate = false) {
    const now = Date.now();
    if (!immediate && now - this.lastPersistAt < 1000) return;
    this.lastPersistAt = now;
    this.ctx.waitUntil(this.persist());
  }

  async persist() {
    if (!this.meta) return;
    await this.ctx.storage.put({
      meta: this.meta,
      game: this.engine.fullState(),
      epoch: this.engine.epoch(),
      chat: this.chat.slice(-30),
    });
  }
}
function createGameEngine(callbacks){
callbacks=callbacks||{};
const W=960,H=540;
const ROOM_JOINERS=4;
const DIFFICULTIES={
  easy:{label:'Easy',hint:'2 slower drones',enemyCount:2,enemySpeed:48,enemyAccel:22,enemyStart:54,invulnerability:2.6,stun:.95},
  normal:{label:'Normal',hint:'3 balanced drones',enemyCount:3,enemySpeed:58,enemyAccel:34,enemyStart:70,invulnerability:2.15,stun:.75},
  hard:{label:'Hard',hint:'4 faster drones',enemyCount:4,enemySpeed:76,enemyAccel:52,enemyStart:88,invulnerability:1.75,stun:.55}
};
const POWER_DEFS={
  shield:{label:'Aegis Prism',short:'Shield',color:'#35d9ff',shape:'shield'},
  magnet:{label:'Flux Orb',short:'Magnet',color:'#d86cff',shape:'magnet'},
  boost:{label:'Inferno Core',short:'Boost',color:'#ff6a1f',shape:'bolt'},
  freeze:{label:'Cryo Shard',short:'Freeze',color:'#6af4ff',shape:'cube'},
  repair:{label:'Nanite Bloom',short:'Repair',color:'#61ff88',shape:'cross'}
};
const NOVA_RADIUS=300;
const STARTING_SUPER_TYPES=['timestop','phase'];
const SUPER_DEFS={
  nova:{label:'Blast Hammer',color:'#ff5a1f',cooldown:14,style:'combat',radius:NOVA_RADIUS,tool:'hammer'},
  phase:{label:'Star Surge',color:'#ffd84d',cooldown:18,style:'survival',tool:'star'},
  timestop:{label:'Cryo Freeze',color:'#6af4ff',cooldown:20,style:'collect',tool:'ice'}
};
const POWER_TIMERS={magnet:8,boost:7,phase:6,freeze:1.35,timestop:7};
const CRYO_RADIUS=225,CRYO_LOCK=4.4,WARDEN_CRYO_LOCK=1.9,QUENCH_SLOW=.58,DASH_ENEMY_GRACE=.14,SHIELD_BREAK_GRACE=1.05;
const ENEMY_DEFS={
  hunter:{label:'Ember Hound',color:'#ff3e24',light:'#ffbe75',dark:'#351008',radius:14,speed:1,accel:1},
  scout:{label:'Spark Wasp',color:'#29dcff',light:'#d5fbff',dark:'#06333c',radius:10,speed:1.34,accel:1.12},
  charger:{label:'Furnace Ram',color:'#ff8b1f',light:'#ffe0a0',dark:'#442006',radius:15,speed:.82,accel:.76},
  sentinel:{label:'Arc Sentry',color:'#b969ff',light:'#f0d5ff',dark:'#28103c',radius:16,speed:.92,accel:.9},
  brute:{label:'Forge Golem',color:'#ff352e',light:'#ffc08b',dark:'#3d0b07',radius:20,speed:.62,accel:.72},
  warden:{label:'Inferno Warden',color:'#ff3218',light:'#ffe08a',dark:'#3b0904',radius:34,speed:.72,accel:.82}
};

const FIRE_STYLES={
  forge:{outer:'#b91f0d',mid:'#ff6d12',inner:'#ffd24d',core:'#fff8cf',glow:'#ff4a12',smoke:'#4b3830',spark:'#ffd15a',soot:.5},
  gas:{outer:'#134bbd',mid:'#148cff',inner:'#4edcff',core:'#f2ffff',glow:'#177dff',smoke:'#829aa4',spark:'#9ff5ff',soot:.08},
  acetylene:{outer:'#163eae',mid:'#1689ff',inner:'#7cecff',core:'#ffffff',glow:'#1c7eff',smoke:'#8ba5ae',spark:'#d9ffff',soot:.05},
  oil:{outer:'#941707',mid:'#ed3a09',inner:'#ffb018',core:'#fff0a2',glow:'#ff3b0a',smoke:'#30292a',spark:'#ffc13b',soot:.9},
  copper:{outer:'#00775f',mid:'#00c99b',inner:'#4ff1c4',core:'#eafff9',glow:'#00b98c',smoke:'#667f79',spark:'#9fffe7',soot:.12},
  potassium:{outer:'#5821ad',mid:'#8d42e8',inner:'#d188ff',core:'#fff0ff',glow:'#8843ed',smoke:'#7b6d82',spark:'#e9b4ff',soot:.1},
  inferno:{outer:'#760d06',mid:'#e2250c',inner:'#ff7414',core:'#ffe6a0',glow:'#ff2810',smoke:'#271f20',spark:'#ff8f25',soot:.85},
  slag:{outer:'#6d0d08',mid:'#d5220c',inner:'#ff7c16',core:'#ffd86b',glow:'#ef2710',smoke:'#2a2221',spark:'#ff9b28',soot:.95},
  drive:{outer:'#ff6c16',mid:'#178dff',inner:'#55dfff',core:'#ffffff',glow:'#1b8fff',smoke:'#7896a0',spark:'#b9f7ff',soot:.04},
  burn:{outer:'#861107',mid:'#e6380c',inner:'#ffad22',core:'#fff0a0',glow:'#f1370d',smoke:'#302728',spark:'#ffc343',soot:.82},
  ember:{outer:'#8d1408',mid:'#ed4210',inner:'#ff9b22',core:'#ffe59a',glow:'#f04410',smoke:'#49332c',spark:'#ffb43a',soot:.45}
};
const BORDER_WALLS=[r(0,0,W,24),r(0,H-24,W,24),r(0,0,24,H),r(W-24,0,24,H)];
const LEVELS=[
  {
    name:'Crossroads',gimmick:'Learn the arena',accent:'#49c7ff',depth:8,floorA:'#13203b',floorB:'#1c315a',glow:'#49c7ff12',speed:1,enemyBonus:0,
    walls:[r(170,118,110,36),r(380,90,42,120),r(610,124,150,32),r(145,345,150,36),r(470,330,40,120),r(675,340,105,36)],
    coins:[[145,90],[335,78],[550,85],[815,86],[90,210],[300,220],[660,225],[875,240],[108,330],[320,315],[615,315],[860,340],[230,455],[430,455],[635,455],[805,455]],
    enemies:[[520,86],[760,275],[535,470],[835,120],[330,270],[820,440]],
    enemyTypes:['hunter','scout','hunter','scout','hunter','charger'],
    powers:[['shield',335,270],['magnet',805,270]],exit:[892,270]
  },
  {
    name:'Switchback',gimmick:'Tight turns and ambushes',accent:'#58ffd0',depth:9,floorA:'#13263a',floorB:'#1b4256',glow:'#58ffd012',speed:1.05,enemyBonus:0,
    walls:[r(190,60,36,165),r(190,285,36,195),r(365,120,205,34),r(365,386,205,34),r(720,60,36,165),r(720,285,36,195),r(470,220,36,105)],
    coins:[[110,80],[290,80],[460,75],[650,80],[845,90],[100,250],[290,250],[410,250],[610,250],[845,250],[105,455],[300,455],[455,465],[635,455],[850,455],[625,330],[320,330]],
    enemies:[[300,160],[610,160],[300,370],[620,370],[840,150],[840,390]],
    enemyTypes:['charger','hunter','scout','charger','hunter','scout'],
    powers:[['boost',610,270],['freeze',320,270]],exit:[875,270]
  },
  {
    name:'Four Corners',gimmick:'Guarded central vault',accent:'#c77dff',depth:10,floorA:'#251b3e',floorB:'#47306b',glow:'#c77dff14',speed:1.1,enemyBonus:1,
    walls:[r(350,135,260,34),r(350,371,260,34),r(350,169,34,80),r(350,291,34,80),r(576,169,34,80),r(576,291,34,80),r(120,250,130,34),r(710,250,130,34)],
    coins:[[100,80],[250,80],[430,85],[530,85],[710,80],[860,80],[95,180],[270,200],[430,270],[530,270],[690,200],[865,180],[95,360],[270,340],[430,320],[530,320],[690,340],[865,360],[160,455],[360,455],[600,455],[800,455]],
    enemies:[[280,150],[680,150],[280,390],[680,390],[470,235],[490,330]],
    enemyTypes:['sentinel','charger','hunter','scout','sentinel','brute'],
    powers:[['repair',480,215],['magnet',480,90],['shield',480,455]],exit:[480,270]
  },
  {
    name:'Zigzag',gimmick:'Fast alternating lanes',accent:'#ff9f1c',depth:11,floorA:'#2b1d20',floorB:'#633534',glow:'#ff9f1c12',speed:1.16,enemyBonus:1,
    walls:[r(170,90,230,34),r(365,124,35,120),r(170,244,230,34),r(170,278,35,170),r(205,414,230,34),r(560,90,230,34),r(560,124,35,120),r(560,244,230,34),r(755,278,35,170),r(525,414,230,34)],
    coins:[[100,80],[470,80],[860,80],[100,170],[280,170],[470,170],[680,170],[860,170],[100,330],[280,330],[470,330],[680,330],[860,330],[100,455],[470,460],[860,455],[470,260],[480,390]],
    enemies:[[470,150],[470,350],[110,270],[850,360],[300,475],[660,475]],
    enemyTypes:['charger','scout','sentinel','brute','charger','scout'],
    powers:[['boost',470,150],['freeze',470,270],['shield',470,390]],exit:[875,270]
  },
  {
    name:'The Vault',gimmick:'Break into the inner chamber',accent:'#80ff72',depth:12,floorA:'#18231a',floorB:'#37523b',glow:'#80ff7214',speed:1.24,enemyBonus:2,
    walls:[r(250,90,460,34),r(250,416,460,34),r(250,124,34,115),r(250,301,34,115),r(676,124,34,115),r(676,301,34,115),r(390,205,180,34),r(390,301,180,34),r(390,239,34,62),r(536,239,34,62),r(80,180,100,34),r(780,326,100,34)],
    coins:[[100,80],[190,80],[770,80],[860,80],[90,270],[190,270],[770,270],[870,270],[100,460],[190,460],[770,460],[860,460],[330,160],[480,160],[630,160],[330,270],[630,270],[330,380],[480,380],[630,380]],
    enemies:[[330,160],[630,160],[330,380],[630,380],[170,380],[790,160]],
    enemyTypes:['brute','charger','sentinel','scout','hunter','charger'],
    powers:[['repair',480,145],['freeze',480,395],['boost',745,270],['shield',215,270]],exit:[330,335]
  },
  {
    name:'Neon Causeway',gimmick:'Time the laser gates',accent:'#ff4fd8',depth:13,floorA:'#17132e',floorB:'#3b1f59',glow:'#ff4fd818',speed:1.28,enemyBonus:2,
    walls:[r(160,88,34,130),r(160,322,34,130),r(330,160,34,220),r(500,88,34,130),r(500,322,34,130),r(670,160,34,220),r(820,88,34,130),r(820,322,34,130)],
    coins:[[90,80],[250,80],[420,80],[590,80],[760,80],[890,80],[95,270],[245,270],[415,270],[585,270],[755,270],[890,270],[90,460],[250,460],[420,460],[590,460],[760,460],[890,460]],
    enemies:[[260,180],[430,350],[590,180],[760,350],[875,160],[110,380],[470,270]],
    enemyTypes:['scout','charger','sentinel','scout','hunter','charger','brute'],
    powers:[['shield',245,150],['boost',585,390],['repair',890,390]],
    hazards:[
      {type:'laser',x1:194,y1:270,x2:330,y2:270,period:3.2,on:1.45,phase:0,color:'#ff4fd8'},
      {type:'laser',x1:534,y1:270,x2:670,y2:270,period:3.2,on:1.45,phase:1.05,color:'#ff4fd8'},
      {type:'laser',x1:704,y1:270,x2:820,y2:270,period:3.2,on:1.45,phase:2.1,color:'#ff4fd8'}
    ],exit:[900,270]
  },
  {
    name:'Reactor Rings',gimmick:'Cross the rotating energy arms',accent:'#58e8ff',depth:14,floorA:'#10232b',floorB:'#1c5260',glow:'#58e8ff18',speed:1.32,enemyBonus:2,
    walls:[r(170,100,150,30),r(640,100,150,30),r(170,410,150,30),r(640,410,150,30),r(250,220,115,30),r(595,220,115,30),r(250,290,115,30),r(595,290,115,30)],
    coins:[[95,80],[245,80],[480,80],[715,80],[865,80],[100,190],[250,190],[480,170],[710,190],[860,190],[95,350],[250,350],[480,370],[710,350],[865,350],[95,460],[245,460],[480,460],[715,460],[865,460]],
    enemies:[[170,270],[790,270],[480,130],[480,410],[350,270],[610,270],[835,420]],
    enemyTypes:['charger','charger','sentinel','sentinel','scout','brute','hunter'],
    powers:[['freeze',480,270],['shield',95,270],['magnet',865,270]],
    hazards:[
      {type:'spinner',x:480,y:270,radius:170,arms:2,speed:.72,phase:0,color:'#58e8ff'},
      {type:'pulse',x:480,y:270,maxRadius:205,period:4.2,phase:1.1,color:'#9df5ff'}
    ],exit:[480,270]
  },
  {
    name:'Gravity Garden',gimmick:'Use the gravity wells',accent:'#b26cff',depth:15,floorA:'#1d1630',floorB:'#442c68',glow:'#b26cff1c',speed:1.36,enemyBonus:3,
    walls:[r(235,70,34,150),r(235,320,34,150),r(455,140,50,110),r(455,290,50,110),r(690,70,34,150),r(690,320,34,150),r(350,245,100,30),r(510,245,100,30)],
    coins:[[90,80],[180,80],[350,90],[610,90],[780,80],[875,80],[100,210],[330,190],[480,100],[630,190],[860,210],[95,330],[330,350],[480,440],[630,350],[865,330],[90,460],[180,460],[350,450],[610,450],[780,460],[875,460]],
    enemies:[[160,270],[800,270],[360,160],[600,380],[560,430],[830,100],[130,430]],
    enemyTypes:['scout','scout','charger','charger','brute','sentinel','hunter'],
    powers:[['boost',480,90],['shield',480,450],['repair',90,270]],
    hazards:[
      {type:'gravity',x:365,y:270,radius:145,strength:115,color:'#b26cff'},
      {type:'gravity',x:595,y:270,radius:145,strength:-95,color:'#60d8ff'}
    ],exit:[875,270]
  },
  {
    name:'Foundry Flow',gimmick:'Ride the conveyor lanes',accent:'#ff7b3d',depth:16,floorA:'#2b1712',floorB:'#69321e',glow:'#ff7b3d1a',speed:1.4,enemyBonus:3,
    walls:[r(170,90,620,28),r(170,422,620,28),r(300,190,360,28),r(300,322,360,28),r(120,220,110,28),r(730,292,110,28)],
    coins:[[90,75],[250,75],[480,75],[710,75],[870,75],[100,160],[260,160],[480,160],[700,160],[860,160],[100,270],[260,270],[480,270],[700,270],[860,270],[100,380],[260,380],[480,380],[700,380],[860,380],[90,465],[250,465],[480,465],[710,465],[870,465]],
    enemies:[[200,150],[760,390],[350,270],[610,270],[480,145],[480,395],[850,120]],
    enemyTypes:['charger','charger','brute','sentinel','scout','scout','hunter'],
    powers:[['magnet',480,270],['freeze',100,270],['repair',860,270]],
    hazards:[
      {type:'conveyor',x:170,y:120,w:620,h:60,dx:1,dy:0,strength:105,color:'#ff7b3d'},
      {type:'conveyor',x:170,y:360,w:620,h:60,dx:-1,dy:0,strength:105,color:'#ff7b3d'},
      {type:'conveyor',x:240,y:218,w:480,h:104,dx:0,dy:1,strength:82,color:'#ffc05a'},
      {type:'pulse',x:480,y:270,maxRadius:185,period:3.8,phase:.4,color:'#ffb05a'}
    ],exit:[895,270]
  },
  {
    name:'Sky Citadel',gimmick:'Survive the final gauntlet',accent:'#ffe36b',depth:18,floorA:'#172337',floorB:'#375777',glow:'#ffe36b18',speed:1.47,enemyBonus:3,
    walls:[r(160,85,180,30),r(620,85,180,30),r(160,425,180,30),r(620,425,180,30),r(280,180,30,180),r(650,180,30,180),r(420,135,120,30),r(420,375,120,30),r(390,240,65,60),r(505,240,65,60)],
    coins:[[90,80],[250,80],[480,80],[710,80],[870,80],[95,180],[230,180],[480,190],[730,180],[865,180],[95,270],[230,270],[365,270],[595,270],[730,270],[865,270],[95,360],[230,360],[480,350],[730,360],[865,360],[90,460],[250,460],[480,460],[710,460],[870,460]],
    enemies:[[180,270],[780,270],[350,140],[610,400],[480,210],[480,330],[860,100]],
    enemyTypes:['brute','brute','charger','charger','sentinel','scout','hunter'],
    powers:[['shield',95,270],['freeze',865,270],['boost',480,95],['repair',480,445]],
    hazards:[
      {type:'spinner',x:480,y:270,radius:215,arms:3,speed:.58,phase:.3,color:'#ffe36b'},
      {type:'laser',x1:310,y1:180,x2:650,y2:180,period:3.5,on:1.25,phase:0,color:'#ff5c82'},
      {type:'laser',x1:310,y1:360,x2:650,y2:360,period:3.5,on:1.25,phase:1.75,color:'#ff5c82'},
      {type:'gravity',x:480,y:270,radius:125,strength:82,color:'#8ee6ff'},
      {type:'pulse',x:480,y:270,maxRadius:230,period:4.6,phase:1.2,color:'#ffffff'}
    ],exit:[480,270]
  },
  {
    name:'Foundry Throne',gimmick:'Defeat the Inferno Warden',accent:'#ffcf4a',depth:20,floorA:'#170503',floorB:'#5b1308',glow:'#ff421f2b',speed:1.52,enemyBonus:0,boss:true,bossKind:'warden',
    walls:[r(205,82,62,92),r(205,366,62,92),r(693,82,62,92),r(693,366,62,92),r(345,72,270,24),r(345,444,270,24)],
    coins:[],
    enemies:[[480,270]],enemyTypes:['warden'],
    powers:[['repair',118,270],['shield',842,270],['freeze',480,120],['boost',480,420]],
    hazards:[
      {type:'flame',x:30,y:125,angle:0,length:125,width:30,period:4.2,on:1.25,phase:.2,color:'#ed2b10',fuel:'inferno'},
      {type:'flame',x:930,y:415,angle:Math.PI,length:125,width:30,period:4.2,on:1.25,phase:2.3,color:'#168cff',fuel:'acetylene'}
    ],exit:[480,270]
  },
  {
    name:'Event Horizon',gimmick:'Defeat the Void Kraken',accent:'#8e7dff',depth:22,floorA:'#0b1328',floorB:'#1a2448',glow:'#7d69ff24',speed:1.58,enemyBonus:0,boss:true,bossKind:'kraken',
    walls:[r(210,78,114,24),r(636,78,114,24),r(210,438,114,24),r(636,438,114,24),r(222,185,34,170),r(704,185,34,170),r(405,116,150,20),r(405,404,150,20)],
    coins:[],
    enemies:[[480,270]],enemyTypes:['warden'],
    powers:[['repair',104,270],['shield',856,270],['freeze',480,102],['boost',480,438]],
    hazards:[
      {type:'gravity',x:244,y:270,radius:112,strength:72,color:'#8f7cff'},
      {type:'gravity',x:716,y:270,radius:112,strength:72,color:'#5fe7ff'},
      {type:'pulse',x:480,y:270,maxRadius:212,period:4.8,phase:1.35,color:'#c8c0ff'}
    ],exit:[480,270]
  }
];
const FOUNDRY_LEVEL_THEME=[
  {name:'Intake Yard',gimmick:'Warm up the forge',accent:'#ff8a24',floorA:'#140a06',floorB:'#3a190c',glow:'#ff5a201f'},
  {name:'Pipe Maze',gimmick:'Thread the service lanes',accent:'#ffb12b',floorA:'#120b07',floorB:'#382313',glow:'#ff9d201d'},
  {name:'Crucible Vault',gimmick:'Breach the guarded core',accent:'#c96cff',floorA:'#130a18',floorB:'#35143d',glow:'#ba5cff1d'},
  {name:'Blast Channels',gimmick:'Cross the furnace lanes',accent:'#ff6129',floorA:'#160805',floorB:'#45150b',glow:'#ff3e1f22'},
  {name:'Iron Core',gimmick:'Break into the smelter',accent:'#ff9d2d',floorA:'#120b07',floorB:'#3c2514',glow:'#ff8a241e'},
  {name:'Arc Causeway',gimmick:'Time the plasma gates',accent:'#ff4fcb',floorA:'#110916',floorB:'#32132e',glow:'#ff4fcb1e'},
  {name:'Turbine Ring',gimmick:'Cross the reactor arms',accent:'#35d9ff',floorA:'#071217',floorB:'#12353d',glow:'#35d9ff1e'},
  {name:'Pressure Wells',gimmick:'Ride the pressure fields',accent:'#a86cff',floorA:'#100b16',floorB:'#2c193e',glow:'#a86cff20'},
  {name:'Smelter Run',gimmick:'Use the moving foundry lanes',accent:'#ff6a24',floorA:'#170906',floorB:'#46180d',glow:'#ff5a201f'},
  {name:'Furnace Zero',gimmick:'Survive the final heat cycle',accent:'#ff3d1f',floorA:'#170604',floorB:'#4c0f09',glow:'#ff311f24'},
  {name:'Foundry Throne',gimmick:'Defeat the Inferno Warden',accent:'#ffcf4a',floorA:'#180503',floorB:'#5c1308',glow:'#ff421f2c'}
];
FOUNDRY_LEVEL_THEME.forEach((theme,index)=>Object.assign(LEVELS[index],theme));
function addFoundryHazard(level,hazard){LEVELS[level-1].hazards=LEVELS[level-1].hazards||[];LEVELS[level-1].hazards.push(hazard)}
addFoundryHazard(4,{type:'flame',x:30,y:174,angle:0,length:140,width:30,period:4,on:1.45,phase:.25,color:'#168cff',fuel:'gas'});
addFoundryHazard(4,{type:'flame',x:930,y:350,angle:Math.PI,length:140,width:30,period:4,on:1.45,phase:2.25,color:'#ff8b16',fuel:'oil'});
addFoundryHazard(5,{type:'flame',x:285,y:270,angle:0,length:95,width:34,period:4.4,on:1.5,phase:.8,color:'#ff7018',fuel:'forge'});
addFoundryHazard(5,{type:'flame',x:675,y:270,angle:Math.PI,length:95,width:34,period:4.4,on:1.5,phase:3,color:'#ff7018',fuel:'forge'});
addFoundryHazard(9,{type:'flame',x:235,y:270,angle:0,length:135,width:32,period:3.7,on:1.4,phase:.2,color:'#00c99b',fuel:'copper'});
addFoundryHazard(9,{type:'flame',x:725,y:270,angle:Math.PI,length:135,width:32,period:3.7,on:1.4,phase:2.05,color:'#9b4df2',fuel:'potassium'});
addFoundryHazard(10,{type:'flame',x:30,y:150,angle:0,length:175,width:36,period:3.3,on:1.35,phase:.1,color:'#ed2b10',fuel:'inferno'});
addFoundryHazard(10,{type:'flame',x:930,y:390,angle:Math.PI,length:175,width:36,period:3.3,on:1.35,phase:1.75,color:'#168cff',fuel:'acetylene'});
const CAMPAIGN_LEVEL_COUNT=LEVELS.length;
LEVELS.push(
  {
    name:'Coin Cyclone',gimmick:'Chase three rotating coin rings',accent:'#ffd45d',depth:10,floorA:'#201807',floorB:'#574314',glow:'#ffd45d1d',speed:1,enemyBonus:0,bonus:true,bonusKind:'orbit',bonusTime:45,bonusRespawn:.8,
    walls:[r(438,228,84,84),r(175,100,72,30),r(713,100,72,30),r(175,410,72,30),r(713,410,72,30)],
    coins:[],enemies:[],enemyTypes:[],powers:[['magnet',480,92],['boost',480,448]],hazards:[],exit:[480,270]
  },
  {
    name:'Mint Express',gimmick:'Race opposite-moving conveyor streams',accent:'#64ffd2',depth:11,floorA:'#071c19',floorB:'#16483f',glow:'#64ffd21c',speed:1,enemyBonus:0,bonus:true,bonusKind:'lanes',bonusTime:50,bonusRespawn:.72,
    walls:[r(210,176,105,24),r(645,176,105,24),r(210,340,105,24),r(645,340,105,24)],
    coins:[],enemies:[],enemyTypes:[],powers:[['boost',90,270],['magnet',870,270]],
    hazards:[
      {type:'conveyor',x:52,y:90,w:856,h:68,dx:1,dy:0,strength:92,color:'#64ffd2'},
      {type:'conveyor',x:52,y:176,w:856,h:68,dx:-1,dy:0,strength:92,color:'#ffcf5a'},
      {type:'conveyor',x:52,y:296,w:856,h:68,dx:1,dy:0,strength:92,color:'#64ffd2'},
      {type:'conveyor',x:52,y:382,w:856,h:68,dx:-1,dy:0,strength:92,color:'#ffcf5a'}
    ],exit:[480,270]
  },
  {
    name:'Gravity Jackpot',gimmick:'Ride twin gravity wells through a figure eight',accent:'#c58cff',depth:12,floorA:'#130b24',floorB:'#3e2268',glow:'#c58cff22',speed:1,enemyBonus:0,bonus:true,bonusKind:'figure8',bonusTime:55,bonusRespawn:.9,
    walls:[r(446,92,68,52),r(446,396,68,52),r(190,244,70,52),r(700,244,70,52)],
    coins:[],enemies:[],enemyTypes:[],powers:[['magnet',480,270],['boost',480,178]],
    hazards:[
      {type:'gravity',x:310,y:270,radius:150,strength:82,color:'#c58cff'},
      {type:'gravity',x:650,y:270,radius:150,strength:-72,color:'#61e8ff'}
    ],exit:[480,270]
  }
);
const BONUS_LEVEL_COUNT=LEVELS.length-CAMPAIGN_LEVEL_COUNT;
function isBonusLevel(level=game&&game.level){return!!levelConfig(level).bonus}
function normalizeLevel(v){return clamp(Math.round(num(v,1)),1,LEVELS.length)}
function levelConfig(v){let map=LEVELS[normalizeLevel(v)-1];if(!map.hazards)map.hazards=[];return map}
function levelWalls(v=game&&game.level){return BORDER_WALLS.concat(levelConfig(v).walls)}
function normalizeDifficulty(v){return Object.prototype.hasOwnProperty.call(DIFFICULTIES,v)?v:'normal'}
function difficultyConfig(v){return DIFFICULTIES[normalizeDifficulty(v)]}
function r(x,y,w,h){return{x,y,w,h}}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function hypot(x,y){return Math.hypot(x,y)}
function num(v,d=0){v=Number(v);return Number.isFinite(v)?v:d}
function inputSafe(v){let x=num(v&&v.x),y=num(v&&v.y),l=hypot(x,y);if(l>1){x/=l;y/=l}
  let dashX=num(v&&v.dashX,x),dashY=num(v&&v.dashY,y),dl=hypot(dashX,dashY);
  if(dl>.001){dashX/=dl;dashY/=dl}else{dashX=x;dashY=y}
  let superSlot=Math.round(num(v&&v.superSlot,-1));if(superSlot!==0&&superSlot!==1)superSlot=-1;
  return{x,y,dash:!!(v&&v.dash),super:!!(v&&v.super)&&superSlot>=0,superSlot,dashSeq:Math.max(0,Math.round(num(v&&v.dashSeq,0))),superSeq:Math.max(0,Math.round(num(v&&v.superSeq,0))),dashX,dashY}}

const PROTOCOL_VERSION=8;
function normalizeEpoch(value){return Math.max(1,Math.round(num(value,1)))}
const remoteInputs=new Map();
const pendingRemoteDashes=new Map();
const net={role:'host',roster:new Map(),stateEpoch:1,eventSeq:0,motionSeq:0,stateSeq:0,fireSeq:0,pendingFireEvents:[]};
let selectedDifficulty='normal',selectedLevel=1,game=null,navSearchBudget=0;
const navGridCache=new Map();
const NAV_CELL=10,NAV_MARGIN=0,NAV_DIRS=[[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.414],[-1,1,1.414],[1,-1,1.414],[-1,-1,1.414]];
const NAV_SEARCHES_PER_TICK=2;
const POWER_PICKUP_RADIUS=30,POWER_PICKUP_Y_OFFSET=12;
const ENEMY_TYPE_KEYS=['hunter','scout','charger','sentinel','brute','warden'];
const ENEMY_MODE_KEYS=['chase','windup','charge','orbit','dart','return','beamWindup','beam','slamWindup','slam','bossChase','bossChargeWindup','bossCharge','bossSlamWindup','bossSlam','bossRingWindup','bossArmWindup','bossArmStrike','bossInkWindup','bossInkBurst','bossRecover','bossDefeated'];
const SUPER_TYPE_KEYS=['','nova','phase','timestop'];

function visualNowMs(){return performance.now()}
function gameSound(type,source=null,options={}){
  if(!callbacks.sfx)return;
  callbacks.sfx({t:'sfx',k:String(type||''),x:source&&Number.isFinite(source.x)?Math.round(source.x*10):null,y:source&&Number.isFinite(source.y)?Math.round(source.y*10):null,target:Number.isInteger(options.targetId)?options.targetId:null,skip:Number.isInteger(options.skipId)?options.skipId:null});
}
function beep(type,options={}){gameSound(type,null,options)}
function emit(kind){if(callbacks.event)callbacks.event(kind)}
function advanceStateEpoch(){pendingRemoteDashes.clear();net.stateEpoch=normalizeEpoch(net.stateEpoch+1);net.eventSeq=0;net.motionSeq=0;net.stateSeq=0;net.pendingFireEvents.length=0;net.fireSeq=0}
function remoteControl(id){let row=remoteInputs.get(id);if(!row||performance.now()-row.at>500)return inputSafe({dashSeq:row&&row.value?row.value.dashSeq:0,superSeq:row&&row.value?row.value.superSeq:0});return inputSafe(row.value)}
function control(p){return remoteControl(p.id)}
function neutralizeRemoteInput(id){let old=remoteInputs.get(id),dashSeq=old&&old.value?old.value.dashSeq:0,superSeq=old&&old.value?old.value.superSeq:0,seq=old?old.seq:0;remoteInputs.set(id,{value:inputSafe({dashSeq,superSeq}),seq,at:0})}
function recentFireRows(){let now=performance.now();net.pendingFireEvents=net.pendingFireEvents.filter(item=>item&&num(item.expires,now+1)>now);return net.pendingFireEvents.map(item=>Array.isArray(item)?item:item.row).filter(Array.isArray)}

function sanitizeSuperSlots(v){
  let source=Array.isArray(v)?v:[];
  return STARTING_SUPER_TYPES.map((defaultType,i)=>{
    let slot=source[i]&&typeof source[i]==='object'?source[i]:{};
    let type=STARTING_SUPER_TYPES.includes(slot.type)?slot.type:defaultType;
    return{type,cooldown:clamp(num(slot.cooldown),0,SUPER_DEFS[type].cooldown)};
  });
}
function sanitizeSuperBuild(v){
  v=v&&typeof v==='object'?v:{};
  return{combat:Math.max(0,num(v.combat)),collect:Math.max(0,num(v.collect)),survival:Math.max(0,num(v.survival))};
}
function isGoodNum(v){return typeof v==='number'&&Number.isFinite(v)}
function repairGameState(target=game){
  if(!target||!Array.isArray(target.players))return;
  target.difficulty=normalizeDifficulty(target.difficulty);
  target.nextDifficulty=normalizeDifficulty(target.nextDifficulty||target.difficulty);
  target.level=normalizeLevel(target.level);
  target.startLevel=normalizeLevel(target.startLevel||target.level);
  target.nextLevel=normalizeLevel(target.nextLevel||target.startLevel);
  target.maxLevel=LEVELS.length;
  target.levelName=levelConfig(target.level).name;target.levelHint=levelConfig(target.level).gimmick||'';
  target.timeStop=clamp(num(target.timeStop),0,8);
  target.inkSeq=Math.max(0,Math.round(num(target.inkSeq)));
  target.hazardTime=Math.max(0,num(target.hazardTime,target.time));
  if(target.superFx&&typeof target.superFx==='object'){target.superFx={type:SUPER_DEFS[target.superFx.type]?target.superFx.type:'nova',x:num(target.superFx.x,W/2),y:num(target.superFx.y,H/2),time:clamp(num(target.superFx.time),0,2)}}else target.superFx=null;
  if(!Array.isArray(target.firePatches))target.firePatches=[];
  target.firePatches=target.firePatches.filter(f=>f&&isGoodNum(f.x)&&isGoodNum(f.y)&&num(f.life)>0).map(f=>({id:Math.max(0,Math.round(num(f.id))),x:clamp(num(f.x),24,W-24),y:clamp(num(f.y),24,H-24),r:clamp(num(f.r,20),8,40),life:clamp(num(f.life),0,4),maxLife:clamp(num(f.maxLife,f.life),.2,4),owner:Math.round(num(f.owner,-1)),dangerous:!!f.dangerous,phase:num(f.phase)})).slice(-90);
  if(!Array.isArray(target.inkSplats))target.inkSplats=[];
  target.inkSplats=target.inkSplats.filter(s=>s&&isGoodNum(s.x)&&isGoodNum(s.y)&&num(s.life)>0).map(s=>({id:Math.max(0,Math.round(num(s.id))),x:clamp(num(s.x),-80,W+80),y:clamp(num(s.y),-80,H+80),r:clamp(num(s.r,54),24,110),life:clamp(num(s.life),0,6),maxLife:clamp(num(s.maxLife,s.life),.5,6),phase:num(s.phase),tone:clamp(Math.round(num(s.tone)),0,2)})).slice(-12);
  if(!Array.isArray(target.powerups))target.powerups=[];
  target.powerups=target.powerups.filter(x=>x&&POWER_DEFS[x.type]&&isGoodNum(x.x)&&isGoodNum(x.y)).map(x=>({...x,r:clamp(num(x.r,12),7,18),taken:!!x.taken,pulse:num(x.pulse)}));
  if(!Array.isArray(target.enemies))target.enemies=[];
  for(const e of target.enemies){
    e.type=ENEMY_DEFS[e.type]?e.type:'hunter';let def=ENEMY_DEFS[e.type];
    e.x=clamp(num(e.x,480),24+def.radius,W-24-def.radius);e.y=clamp(num(e.y,270),24+def.radius,H-24-def.radius);
    e.vx=num(e.vx);e.vy=num(e.vy);e.r=clamp(num(e.r,def.radius),8,50);e.stun=clamp(num(e.stun),0,3);e.cryo=clamp(num(e.cryo),0,CRYO_LOCK);
    e.homeX=num(e.homeX,e.x);e.homeY=num(e.homeY,e.y);e.phase=num(e.phase);e.cooldown=clamp(num(e.cooldown),0,8);e.aiTimer=clamp(num(e.aiTimer),0,3);
    e.aimX=num(e.aimX,1);e.aimY=num(e.aimY);let al=hypot(e.aimX,e.aimY);if(al>.001){e.aimX/=al;e.aimY/=al}else{e.aimX=1;e.aimY=0}
    e.mode=['chase','windup','charge','orbit','dart','return','beamWindup','beam','slamWindup','slam','bossChase','bossChargeWindup','bossCharge','bossSlamWindup','bossSlam','bossRingWindup','bossArmWindup','bossArmStrike','bossInkWindup','bossInkBurst','bossRecover','bossDefeated'].includes(e.mode)?e.mode:(e.type==='warden'?'bossChase':'chase');
    e.pulseRadius=clamp(num(e.pulseRadius),0,180);e.attackHits=Array.isArray(e.attackHits)?e.attackHits.map(x=>Math.max(0,Math.round(num(x)))).slice(0,8):[];
    e.armor=e.type==='brute'?clamp(Math.round(num(e.armor,1)),0,1):0;e.armorTimer=clamp(num(e.armorTimer),0,6);e.scoreCd=clamp(num(e.scoreCd),0,4);e.burn=clamp(num(e.burn),0,4);e.fireCd=clamp(num(e.fireCd),0,2);
    e.maxHp=e.type==='warden'?Math.max(1,Math.round(num(e.maxHp,bossMaxHp(target.difficulty)))):1;e.hp=e.type==='warden'?clamp(Math.round(num(e.hp,e.maxHp)),0,e.maxHp):1;e.hitInvuln=clamp(num(e.hitInvuln),0,2);e.bossStage=clamp(Math.round(num(e.bossStage,1)),1,3);e.attackCycle=Math.max(0,Math.round(num(e.attackCycle)));e.defeated=e.type==='warden'&&!!e.defeated;e.deathTimer=clamp(num(e.deathTimer),0,3);e.bossTrailCd=clamp(num(e.bossTrailCd),0,.3);e.armTargetX=clamp(num(e.armTargetX,e.x),24,W-24);e.armTargetY=clamp(num(e.armTargetY,e.y),24,H-24);e.armProgress=clamp(num(e.armProgress),0,1);e.armLength=clamp(num(e.armLength),0,330);e.inkCharge=clamp(num(e.inkCharge),0,1);
  }
  for(const p of target.players){
    p.id=Math.max(0,Math.round(num(p.id,0)));
    p.r=clamp(num(p.r,15),6,30);
    p.x=clamp(num(p.x,spawnPoint(p.id).x),p.r+24,W-p.r-24);
    p.y=clamp(num(p.y,spawnPoint(p.id).y),p.r+24,H-p.r-24);
    p.vx=num(p.vx);p.vy=num(p.vy);
    p.dx=num(p.dx,1);p.dy=num(p.dy,0);
    let dl=hypot(p.dx,p.dy);if(dl>.001){p.dx/=dl;p.dy/=dl}else{p.dx=1;p.dy=0}
    p.faceX=num(p.faceX,p.dx);p.faceY=num(p.faceY,p.dy);
    p.dt=clamp(num(p.dt),0,.25);p.cd=clamp(num(p.cd),0,1);
    p.dashHit=clamp(num(p.dashHit),0,.5);p.inv=clamp(num(p.inv),0,3);p.hitTime=clamp(num(p.hitTime),0,.35);p.hitVX=clamp(num(p.hitVX),-320,320);p.hitVY=clamp(num(p.hitVY),-320,320);
    p.lastDashSeq=Math.max(0,Math.round(num(p.lastDashSeq,0)));p.lastSuperSeq=Math.max(0,Math.round(num(p.lastSuperSeq,0)));
    p.maxHp=5;
    p.hp=clamp(Math.round(num(p.hp,p.maxHp)),0,p.maxHp);p.score=Math.max(0,Math.round(num(p.score,0)));p.shield=clamp(Math.round(num(p.shield)),0,1);p.magnet=clamp(num(p.magnet),0,12);p.boost=clamp(num(p.boost),0,12);
    p.superSlots=sanitizeSuperSlots(p.superSlots);
    p.superMeter=clamp(num(p.superMeter),0,100);p.superBuild=sanitizeSuperBuild(p.superBuild);p.superPassive=clamp(num(p.superPassive),0,3);p.phase=clamp(num(p.phase),0,8);p.freezeAura=clamp(num(p.freezeAura),0,POWER_TIMERS.freeze);p.timeStopAura=clamp(num(p.timeStopAura),0,POWER_TIMERS.timestop);p.fireTrailCd=clamp(num(p.fireTrailCd),0,.25);
    p.alive=p.alive!==false&&p.hp>0;
    p.connected=p.connected!==false;
    if(p.control!=='remote')p.control='local';
    if(!Array.isArray(p.trail))p.trail=[];
    p.trail=p.trail.filter(t=>isGoodNum(t.x)&&isGoodNum(t.y)).slice(-12);
  }
}
function spawnPoint(id){let spots=[[92,92],[122,112],[92,148],[150,92],[150,148],[116,188]];let s=spots[id%spots.length],row=Math.floor(id/spots.length);return{x:s[0]+row*18,y:s[1]+row*14}}
function createPlayerState(id,x,y,control='local',connected=true,lastDashSeq=0,lastSuperSeq=0){
  return{id,x,y,vx:0,vy:0,r:15,maxHp:5,hp:5,score:0,alive:true,connected,control,cd:0,dt:0,dx:1,dy:0,faceX:1,faceY:0,inv:0,shield:0,magnet:0,boost:0,phase:0,freezeAura:0,timeStopAura:0,fireTrailCd:0,superSlots:sanitizeSuperSlots([]),superMeter:0,superBuild:sanitizeSuperBuild({}),superPassive:0,bob:Math.random()*9,trail:[],dashHit:0,hitTime:0,hitVX:0,hitVY:0,lastDashSeq:Math.max(0,Math.round(num(lastDashSeq))),lastSuperSeq:Math.max(0,Math.round(num(lastSuperSeq))),superHeld:false};
}
function resetPlayerState(p,id,control,lastDashSeq=0,connected=true,lastSuperSeq=0){
  let spawn=spawnPoint(id);return Object.assign(p,createPlayerState(id,spawn.x,spawn.y,control,connected,lastDashSeq,lastSuperSeq));
}
function player(id,x,y,control='local',connected=true){return createPlayerState(id,x,y,control,connected)}
function bossMaxHp(difficulty=selectedDifficulty){return difficulty==='easy'?10:difficulty==='hard'?18:14}
function bossMetaForLevel(level=game.level){
  let map=levelConfig(normalizeLevel(level)),kind=map.bossKind||'warden';
  if(kind==='kraken')return{kind:'kraken',name:'Void Kraken',color:'#8f7cff',light:'#ddd6ff',dark:'#110d27',core:'#7df1ff',style:'potassium'};
  return{kind:'warden',name:'Inferno Warden',color:'#ff3218',light:'#ffe08a',dark:'#3b0904',core:'#ffb347',style:'inferno'};
}
function enemy(x,y,startSpeed=70,type='hunter',difficulty=selectedDifficulty){let a=Math.random()*6.28,def=ENEMY_DEFS[type]||ENEMY_DEFS.hunter,mode=type==='scout'?'orbit':type==='sentinel'?'return':type==='warden'?'bossChase':'chase',maxHp=type==='warden'?bossMaxHp(normalizeDifficulty(difficulty)):1;
return{x,y,homeX:x,homeY:y,vx:type==='warden'?0:Math.cos(a)*startSpeed,vy:type==='warden'?0:Math.sin(a)*startSpeed,r:def.radius,type:ENEMY_DEFS[type]?type:'hunter',stun:0,cryo:0,phase:Math.random()*6.28,cooldown:type==='warden'?1.8:1.2+Math.random()*1.8,aiTimer:0,mode,aimX:1,aimY:0,pulseRadius:0,attackHits:[],armor:type==='brute'?1:0,armorTimer:0,scoreCd:0,burn:0,fireCd:0,navPath:[],navIndex:0,navTimer:0,navTargetX:x,navTargetY:y,navProgressX:x,navProgressY:y,navStuck:0,maxHp,hp:maxHp,hitInvuln:0,bossStage:1,attackCycle:0,defeated:false,deathTimer:0,bossTrailCd:0,armTargetX:x,armTargetY:y,armProgress:0,armLength:0,inkCharge:0}}
function powerup(type,x,y,i=0){return{type,x,y,r:13,taken:false,pulse:i*.7}}
function playerTouchesPower(p,item){let dx=p.x-item.x,dy=p.y-(item.y-POWER_PICKUP_Y_OFFSET),reach=p.r+POWER_PICKUP_RADIUS;return dx*dx+dy*dy<=reach*reach}
function levelPowerSpecs(level){return(levelConfig(level).powers||[]).map(p=>[p[0],p[1],p[2]])}
function makeBonusCoins(map){
  let coins=[];
  if(map.bonusKind==='orbit'){
    let rings=[{radius:94,count:8,speed:1.05,scaleY:.82},{radius:174,count:10,speed:-.72,scaleY:.7},{radius:270,count:12,speed:.5,scaleY:.58}];
    rings.forEach((ring,ringIndex)=>{for(let i=0;i<ring.count;i++){let phase=i*Math.PI*2/ring.count+ringIndex*.27;coins.push({x:480,y:270,r:i%7===0?11:9,taken:false,pulse:coins.length*.3,bonusMotion:'orbit',phase,orbitRadius:ring.radius,orbitSpeed:ring.speed,orbitScaleY:ring.scaleY,jackpot:i%7===0,value:i%7===0?3:1,respawnAt:0})}});
  }else if(map.bonusKind==='lanes'){
    let lanes=[124,210,330,416];
    lanes.forEach((laneY,lane)=>{for(let i=0;i<7;i++){let jackpot=(i===3&&lane%2===0);coins.push({x:90+i*130,y:laneY,r:jackpot?11:9,taken:false,pulse:coins.length*.3,bonusMotion:'lane',laneY,laneOffset:i/7,laneDirection:lane%2? -1:1,laneSpeed:76+lane*8,jackpot,value:jackpot?3:1,respawnAt:0})}});
  }else{
    for(let i=0;i<30;i++){let track=i%3,phase=i*Math.PI*2/30+track*.42,jackpot=i%10===0;coins.push({x:480,y:270,r:jackpot?11:9,taken:false,pulse:i*.3,bonusMotion:'figure8',phase,track,trackSpeed:.62+track*.11,jackpot,value:jackpot?3:1,respawnAt:0})}
  }
  updateBonusCoinPositionsFor(coins,map,0);
  return coins;
}
function updateBonusCoinPositionsFor(coins,map,time){
  if(!map||!map.bonus)return;
  for(const coin of coins||[]){
    if(coin.bonusMotion==='orbit'){
      let a=num(coin.phase)+time*num(coin.orbitSpeed);coin.x=480+Math.cos(a)*num(coin.orbitRadius);coin.y=270+Math.sin(a)*num(coin.orbitRadius)*num(coin.orbitScaleY,.7);
    }else if(coin.bonusMotion==='lane'){
      let span=820,raw=(num(coin.laneOffset)*span+time*num(coin.laneSpeed)*num(coin.laneDirection,1));coin.x=70+((raw%span)+span)%span;coin.y=num(coin.laneY)+Math.sin(time*1.7+num(coin.pulse)) * 5;
    }else if(coin.bonusMotion==='figure8'){
      let a=time*num(coin.trackSpeed)+num(coin.phase),spread=1-num(coin.track)*.13;coin.x=480+Math.sin(a)*330*spread;coin.y=270+Math.sin(a*2+num(coin.track)*.75)*150*spread;
    }
  }
}
function updateBonusCoinField(){
  let map=levelConfig(game.level);if(!map.bonus)return;
  updateBonusCoinPositionsFor(game.coins,map,game.hazardTime);
  if(net.role==='client')return;
  for(const coin of game.coins){if(coin.taken&&num(coin.respawnAt)>0&&game.time>=coin.respawnAt){coin.taken=false;coin.respawnAt=0;coin.pulse+=.73}}
}
function makeLevelObjects(level,difficulty){
  let map=levelConfig(level),cfg=difficultyConfig(difficulty),count=Math.min(map.enemies.length,cfg.enemyCount+map.enemyBonus);
  let enemies=map.enemies.slice(0,count).map((p,i)=>enemy(p[0],p[1],cfg.enemyStart*map.speed,map.enemyTypes[i]||'hunter',difficulty));
  return{
    coins:map.bonus?makeBonusCoins(map):map.coins.map((p,i)=>({x:p[0],y:p[1],r:9,taken:false,pulse:i*.3,value:1})),
    enemies,
    powerups:levelPowerSpecs(level).map((p,i)=>powerup(p[0],p[1],p[2],i)),
    exit:{x:map.exit[0],y:map.exit[1],r:28}
  };
}
function makeGame(difficulty=selectedDifficulty,startLevel=selectedLevel){
  difficulty=normalizeDifficulty(difficulty);let level=normalizeLevel(startLevel),parts=makeLevelObjects(level,difficulty),s=spawnPoint(0);
  return{players:[player(0,s.x,s.y,'local',true)],coins:parts.coins,enemies:parts.enemies,powerups:parts.powerups,firePatches:[],inkSplats:[],inkSeq:0,difficulty,nextDifficulty:difficulty,level,startLevel:level,nextLevel:level,maxLevel:LEVELS.length,levelName:levelConfig(level).name,levelHint:levelConfig(level).gimmick||'',phase:'menu',count:0,time:0,hazardTime:0,over:false,won:false,paused:false,exit:parts.exit,shake:0,timeStop:0,superFx:null,total:parts.coins.length};
}
function resetPlayersForLevel(){
  for(const p of game.players){
    let score=p.score,id=p.id,control=p.control,connected=p.connected!==false,lastDash=id?remoteDashSeq(id):0,lastSuper=id?remoteSuperSeq(id):0;
    let superSlots=sanitizeSuperSlots(p.superSlots),superMeter=clamp(num(p.superMeter),0,100),superBuild=sanitizeSuperBuild(p.superBuild),superPassive=clamp(num(p.superPassive),0,3);
    resetPlayerState(p,id,control,lastDash,connected,lastSuper);p.score=score;
    p.superSlots=superSlots;p.superMeter=superMeter;p.superBuild=superBuild;p.superPassive=superPassive;
  }
}
function circleRect(o,b){
  let nearestX=clamp(o.x,b.x,b.x+b.w),nearestY=clamp(o.y,b.y,b.y+b.h),dx=o.x-nearestX,dy=o.y-nearestY,d=hypot(dx,dy),nx=0,ny=0,push=0;
  if(d>=o.r)return false;
  if(d>.0001){nx=dx/d;ny=dy/d;push=o.r-d}
  else{
    let left=o.x-b.x,right=b.x+b.w-o.x,top=o.y-b.y,bottom=b.y+b.h-o.y,minEdge=Math.min(left,right,top,bottom);
    if(minEdge===left){nx=-1;push=o.r+left}
    else if(minEdge===right){nx=1;push=o.r+right}
    else if(minEdge===top){ny=-1;push=o.r+top}
    else{ny=1;push=o.r+bottom}
  }
  o.x+=nx*push;o.y+=ny*push;
  let inward=num(o.vx)*nx+num(o.vy)*ny;
  if(inward<0){o.vx-=inward*1.25*nx;o.vy-=inward*1.25*ny}
  return true
}
function collideWorld(o){let hit=false;for(const w of levelWalls())if(circleRect(o,w))hit=true;
let ox=o.x,oy=o.y;o.x=clamp(o.x,o.r+24,W-o.r-24);o.y=clamp(o.y,o.r+24,H-o.r-24);return hit||o.x!==ox||o.y!==oy}
function playerMoveSpeed(p){return p.boost>0?224:178}
function playerDashSpeed(p){return p.boost>0?650:520}
function playerDashCooldown(p){return p.boost>0?.27:.45}
function startDash(p,c){
  if(!p||!p.alive)return false;
  c=inputSafe(c);let l=hypot(c.x,c.y);if(l<.001)return false;c.x/=l;c.y/=l;
  if(!Array.isArray(p.trail))p.trail=[];
  p.hitTime=0;p.hitVX=0;p.hitVY=0;p.dt=p.boost>0?.25:.2;
  p.cd=playerDashCooldown(p);p.dx=c.x;p.dy=c.y;p.dashHit=p.dt+DASH_ENEMY_GRACE;
  game.shake=Math.max(num(game.shake),.045);
  p.trail.push({x:num(p.x),y:num(p.y),dx:p.dx,dy:p.dy,at:performance.now(),life:420,ring:true,flame:p.boost>0});
  p.trail=p.trail.slice(-16);
  try{gameSound('dash',p,{skipId:p.id})}catch(error){console.warn('Dash audio failed',error)}
  return true;
}
function acceptRemoteDash(id,seq,x,y){
  if(net.role!=='host')return false;
  id=clamp(Math.round(num(id)),0,ROOM_JOINERS);seq=Math.max(0,Math.round(num(seq)));
  let p=game&&Array.isArray(game.players)?game.players.find(player=>player.id===id):null;
  let queued=pendingRemoteDashes.get(id);
  if(!p||!seq||seq<=Math.max(Math.round(num(p.lastDashSeq)),queued?queued.seq:0))return false;
  let direction=inputSafe({x,y,dashX:x,dashY:y});
  pendingRemoteDashes.set(id,{seq,x:direction.dashX,y:direction.dashY});
  return true;
}
function processRemoteDash(p){
  let action=pendingRemoteDashes.get(p.id);if(!action)return false;
  pendingRemoteDashes.delete(p.id);
  if(action.seq<=Math.max(0,Math.round(num(p.lastDashSeq))))return false;
  p.lastDashSeq=action.seq;
  let dx=num(action.x),dy=num(action.y),length=hypot(dx,dy);
  if(length<.001){dx=num(p.faceX,1);dy=num(p.faceY);length=hypot(dx,dy)}
  if(game.phase!=='play'||game.paused||game.over||!p.alive||p.cd>0||length<.001)return false;
  return startDash(p,{x:dx/length,y:dy/length});
}
function forgeSuper(p){
  p.superSlots=sanitizeSuperSlots(p.superSlots);
  let reduced=false;
  for(const slot of p.superSlots){
    if(slot.cooldown>0){slot.cooldown=Math.max(0,slot.cooldown-8);reduced=true}
  }
  if(!reduced)p.shield=1;
  gameSound('superReady',p,{targetId:p.id});
  p.superMeter=0;p.superBuild=sanitizeSuperBuild({});
}
function gainSuperEnergy(p,amount,style='survival'){
  if(!p||!p.alive)return;
  style=['combat','collect','survival'].includes(style)?style:'survival';
  p.superMeter=clamp(num(p.superMeter)+amount,0,100);
  p.superBuild=sanitizeSuperBuild(p.superBuild);p.superBuild[style]+=amount;
  if(p.superMeter>=100)forgeSuper(p);
}
function cryoShatter(p){
  let ranked=game.enemies.map(e=>({e,d:hypot(e.x-p.x,e.y-p.y)})).sort((a,b)=>a.d-b.d);
  let targets=ranked.filter(item=>item.d<=CRYO_RADIUS);
  if(!targets.length&&ranked[0]&&ranked[0].d<=CRYO_RADIUS*1.7)targets=[ranked[0]];
  for(const item of targets){
    let e=item.e,falloff=clamp(1-item.d/(CRYO_RADIUS*1.15),.45,1);
    let duration=e.type==='warden'?WARDEN_CRYO_LOCK*(.82+falloff*.18):CRYO_LOCK*(.86+falloff*.14);
    e.cryo=Math.max(num(e.cryo),duration);
    e.stun=0;
    e.vx*=.08;e.vy*=.08;
    if(e.type==='brute'&&e.armor>0){e.armor=0;e.armorTimer=3.6}
  }
  p.freezeAura=POWER_TIMERS.freeze;
  game.shake=Math.max(game.shake,.09);
  return targets.length;
}
function applyPower(p,type){
  if(type==='shield')p.shield=1;
  else if(type==='magnet')p.magnet=Math.max(p.magnet,8);
  else if(type==='boost')p.boost=Math.max(p.boost,7);
  else if(type==='freeze'){cryoShatter(p);gameSound('freeze',p);return}
  else if(type==='repair'){if(p.hp<p.maxHp)p.hp=Math.min(p.maxHp,p.hp+2);else p.shield=1}
  gameSound(type==='shield'?'shieldPickup':type,p);
}
function activateSuper(p,slotIndex=0){
  if(!p||!p.alive)return false;
  p.superSlots=sanitizeSuperSlots(p.superSlots);
  slotIndex=slotIndex===1?1:0;
  let slot=p.superSlots[slotIndex],def=SUPER_DEFS[slot.type];
  if(!def||slot.cooldown>0)return false;
  let type=slot.type;
  slot.cooldown=def.cooldown;
  if(type==='nova'){
    game.superFx={type,x:p.x,y:p.y,time:1.05,radius:NOVA_RADIUS};
    for(const e of game.enemies){
      let dx=e.x-p.x,dy=e.y-p.y,d=hypot(dx,dy)||1;
      if(d>NOVA_RADIUS)continue;
      let power=clamp(1-d/NOVA_RADIUS,.2,1);
      if(e.type==='warden'){if(damageBoss(e,p,2,dx/d,dy/d)&&!e.defeated)beginBossRecovery(e,e.bossStage,.18);continue}
      e.stun=Math.max(e.stun,1.4+power*1.2);
      e.vx=dx/d*390*power;e.vy=dy/d*390*power;
      if(e.type==='brute'){e.armor=0;e.armorTimer=4}
    }
    for(const coin of game.coins)if(!coin.taken&&hypot(coin.x-p.x,coin.y-p.y)<=NOVA_RADIUS)collectCoin(p,coin);
    game.shake=.20;
  }else if(type==='phase'){
    game.superFx={type,x:p.x,y:p.y,time:.7};
    p.phase=6;p.inv=Math.max(p.inv,6);
  }else if(type==='timestop'){
    game.superFx={type,x:p.x,y:p.y,time:1.15};
    game.timeStop=Math.max(game.timeStop,POWER_TIMERS.timestop);
    p.timeStopAura=POWER_TIMERS.timestop;
    game.firePatches=[];
    for(const e of game.enemies){
      e.burn=0;e.fireCd=Math.max(e.fireCd,.6);e.vx*=.45;e.vy*=.45;
    }
  }
  gameSound(type==='timestop'?'superIce':type==='phase'?'superStar':'super',p);
  return true;
}
function collectCoin(p,coin){if(coin.taken)return;coin.taken=true;let value=Math.max(1,Math.round(num(coin.value,1)));p.score+=value;if(isBonusLevel())coin.respawnAt=game.time+num(levelConfig(game.level).bonusRespawn,.85)*(coin.jackpot?2.2:1);gainSuperEnergy(p,Math.min(12,6*value),'collect');gameSound('coin',coin);if(coin.jackpot)beep('superReady',{bus:'game',gain:.38})}
function collectPower(p,item){if(item.taken)return;item.taken=true;applyPower(p,item.type);gainSuperEnergy(p,12,'survival')}
function dashSmash(p,e){
  p.dashHit=Math.max(p.dashHit,DASH_ENEMY_GRACE+.04);
  if(e.type==='warden'){let hit=damageBoss(e,p,1,p.dx,p.dy);if(hit){if(!e.defeated)beginBossRecovery(e,e.bossStage,.1);e.vx=p.dx*58;e.vy=p.dy*58;p.trail.push({x:e.x,y:e.y,dx:p.dx,dy:p.dy,at:performance.now(),life:420,hit:true});}return}
  if(e.stun>.18)return;e.navPath=[];e.navIndex=0;e.navTimer=0;
  if(e.type==='brute'&&e.armor>0){e.armor=0;e.armorTimer=3.2;e.stun=.22;e.vx=p.dx*115;e.vy=p.dy*115}
  else{
    let mult=e.type==='brute'?.55:e.type==='scout'?1.35:1;
    e.stun=difficultyConfig(game.difficulty).stun*(e.type==='brute'?.72:1);
    e.vx=p.dx*270*mult;e.vy=p.dy*270*mult;
    if(e.scoreCd<=0){p.score++;e.scoreCd=2.4}
  }
  if(e.type==='charger'){e.mode='chase';e.cooldown=2.2;e.aiTimer=0}
  if(e.type==='sentinel'){e.mode='return';e.cooldown=1.8;e.aiTimer=0;e.attackHits=[]}
  if(e.type==='brute'){e.mode='chase';e.cooldown=2.2;e.aiTimer=0;e.pulseRadius=0;e.attackHits=[]}
  if(e.type==='scout'){e.mode='orbit';e.cooldown=1.1;e.aiTimer=0}
	p.dashHit=Math.max(p.dashHit,DASH_ENEMY_GRACE+.04);game.shake=.10;gainSuperEnergy(p,22,'combat');
	p.trail.push({x:e.x,y:e.y,dx:p.dx,dy:p.dy,at:performance.now(),life:360,hit:true});gameSound('enemyHit',e)}
function steerEnemy(e,dx,dy,amount,dt,maxSpeed){let l=hypot(dx,dy)||1,ux=dx/l,uy=dy/l;let along=e.vx*ux+e.vy*uy,sideX=e.vx-ux*along,sideY=e.vy-uy*along,damp=clamp(dt*5.5,0,.38);e.vx-=sideX*damp;e.vy-=sideY*damp;e.vx+=ux*amount*dt;e.vy+=uy*amount*dt;let s=hypot(e.vx,e.vy);if(s>maxSpeed){e.vx=e.vx/s*maxSpeed;e.vy=e.vy/s*maxSpeed}}
function enemyNavRadius(e){let r=num(e&&e.r,14);if(e&&e.type==='warden')return r+6;return r+Math.max(.75,3-(r-10)*.3)}
function navPointBlocked(x,y,radius){
  let margin=radius+NAV_MARGIN;
  if(x<24+margin||x>W-24-margin||y<24+margin||y>H-24-margin)return true;
  for(const w of levelConfig(game.level).walls){
    let px=clamp(x,w.x,w.x+w.w),py=clamp(y,w.y,w.y+w.h),dx=x-px,dy=y-py;
    if(dx*dx+dy*dy<margin*margin)return true;
  }
  return false;
}
function navSegmentClear(x1,y1,x2,y2,radius){
  let dx=x2-x1,dy=y2-y1,d=hypot(dx,dy),steps=Math.max(1,Math.ceil(d/(NAV_CELL*.5)));
  for(let i=0;i<=steps;i++){let t=i/steps;if(navPointBlocked(x1+dx*t,y1+dy*t,radius))return false}
  return true;
}
function navigationGrid(radius){
  let bucket=Math.ceil(radius),key=game.level+':'+bucket,cached=navGridCache.get(key);
  if(cached)return cached;
  let cols=Math.floor(W/NAV_CELL)+1,rows=Math.floor(H/NAV_CELL)+1,count=cols*rows,free=new Uint8Array(count);
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){
    let x=gx*NAV_CELL,y=gy*NAV_CELL;
    free[gy*cols+gx]=navPointBlocked(x,y,bucket)?0:1;
  }
  cached={cols,rows,free,radius:bucket,gScore:new Float32Array(count),came:new Int32Array(count),closed:new Uint8Array(count),heapIndex:[],heapScore:[],heapSize:0,popIndex:-1};
  navGridCache.set(key,cached);return cached;
}
function nearestFreeNavNode(grid,x,y){
  let gx=clamp(Math.round(x/NAV_CELL),0,grid.cols-1),gy=clamp(Math.round(y/NAV_CELL),0,grid.rows-1);
  for(let ring=0;ring<14;ring++){
    for(let oy=-ring;oy<=ring;oy++)for(let ox=-ring;ox<=ring;ox++){
      if(Math.max(Math.abs(ox),Math.abs(oy))!==ring)continue;
      let nx=gx+ox,ny=gy+oy;if(nx<0||ny<0||nx>=grid.cols||ny>=grid.rows)continue;
      let index=ny*grid.cols+nx;if(grid.free[index])return index;
    }
  }
  return -1;
}
function navHeapReset(work){work.heapSize=0}
function navHeapPush(work,index,score){
  let i=work.heapSize++;
  while(i>0){let parent=(i-1)>>1;if(work.heapScore[parent]<=score)break;work.heapIndex[i]=work.heapIndex[parent];work.heapScore[i]=work.heapScore[parent];i=parent}
  work.heapIndex[i]=index;work.heapScore[i]=score;
}
function navHeapPop(work){
  if(!work.heapSize)return-1;
  let root=work.heapIndex[0],lastIndex=work.heapIndex[--work.heapSize],lastScore=work.heapScore[work.heapSize];
  if(work.heapSize){let i=0;while(true){let left=i*2+1,right=left+1;if(left>=work.heapSize)break;let child=right<work.heapSize&&work.heapScore[right]<work.heapScore[left]?right:left;if(work.heapScore[child]>=lastScore)break;work.heapIndex[i]=work.heapIndex[child];work.heapScore[i]=work.heapScore[child];i=child}work.heapIndex[i]=lastIndex;work.heapScore[i]=lastScore}
  return root;
}
function planEnemyPath(e,targetX,targetY){
  let radius=enemyNavRadius(e),grid=navigationGrid(radius),start=nearestFreeNavNode(grid,e.x,e.y),goal=nearestFreeNavNode(grid,targetX,targetY);
  if(start<0||goal<0)return[];
  if(start===goal)return[{x:targetX,y:targetY}];
  let gScore=grid.gScore,came=grid.came,closed=grid.closed;
  gScore.fill(Infinity);came.fill(-1);closed.fill(0);navHeapReset(grid);gScore[start]=0;
  let goalX=goal%grid.cols,goalY=Math.floor(goal/grid.cols);
  navHeapPush(grid,start,Math.hypot(goalX-start%grid.cols,goalY-Math.floor(start/grid.cols)));
  while(grid.heapSize){
    let current=navHeapPop(grid);if(current<0||closed[current])continue;
    if(current===goal){
      let nodes=[];for(let cursor=goal;cursor>=0&&cursor!==start;cursor=came[cursor])nodes.push(cursor);nodes.reverse();
      let path=nodes.map(index=>({x:(index%grid.cols)*NAV_CELL,y:Math.floor(index/grid.cols)*NAV_CELL}));
      if(path.length&&navSegmentClear(path[path.length-1].x,path[path.length-1].y,targetX,targetY,radius))path[path.length-1]={x:targetX,y:targetY};
      return path;
    }
    closed[current]=1;
    let cx0=current%grid.cols,cy0=Math.floor(current/grid.cols);
    for(const [ox,oy,cost] of NAV_DIRS){
      let nx=cx0+ox,ny=cy0+oy;if(nx<0||ny<0||nx>=grid.cols||ny>=grid.rows)continue;
      let neighbor=ny*grid.cols+nx;if(!grid.free[neighbor]||closed[neighbor])continue;
      if(ox&&oy){let a=cy0*grid.cols+nx,b=ny*grid.cols+cx0;if(!grid.free[a]||!grid.free[b])continue}
      let tentative=gScore[current]+cost;if(tentative>=gScore[neighbor])continue;
      came[neighbor]=current;gScore[neighbor]=tentative;
      navHeapPush(grid,neighbor,tentative+Math.hypot(goalX-nx,goalY-ny));
    }
  }
  return[];
}
function enemyNavGoal(e,targetX,targetY,dt){
  let radius=enemyNavRadius(e);e.navTimer=Math.max(0,num(e.navTimer)-dt);e.navStuck=num(e.navStuck)+dt;
  if(e.navStuck>=.65){
    let moved=hypot(e.x-num(e.navProgressX,e.x),e.y-num(e.navProgressY,e.y));
    if(moved<3&&hypot(e.vx,e.vy)>4){e.navPath=[];e.navIndex=0;e.navTimer=0;e.vx*=.35;e.vy*=.35}
    e.navProgressX=e.x;e.navProgressY=e.y;e.navStuck=0;
  }
  if(navSegmentClear(e.x,e.y,targetX,targetY,radius)){
    e.navPath=[];e.navIndex=0;e.navTargetX=targetX;e.navTargetY=targetY;return{x:targetX,y:targetY};
  }
  let targetMoved=hypot(targetX-num(e.navTargetX,targetX),targetY-num(e.navTargetY,targetY))>NAV_CELL*3;
  let needsPath=!Array.isArray(e.navPath)||e.navTimer<=0||targetMoved||e.navIndex>=e.navPath.length;
  if(needsPath&&navSearchBudget>0){
    navSearchBudget--;e.navPath=planEnemyPath(e,targetX,targetY);e.navIndex=0;e.navTimer=e.type==='warden'?.24:.32;e.navTargetX=targetX;e.navTargetY=targetY;
  }else if(needsPath&&(!Array.isArray(e.navPath)||e.navIndex>=e.navPath.length))return{x:e.x,y:e.y};
  while(e.navPath&&e.navIndex<e.navPath.length-1){
    let next=e.navPath[e.navIndex+1];
    if(!navSegmentClear(e.x,e.y,next.x,next.y,radius))break;
    e.navIndex++;
  }
  let point=e.navPath&&e.navPath[e.navIndex];
  if(point&&hypot(point.x-e.x,point.y-e.y)<NAV_CELL*1.2){e.navIndex++;point=e.navPath[e.navIndex]}
  return point||{x:targetX,y:targetY};
}
function steerEnemyTo(e,targetX,targetY,amount,dt,maxSpeed){
  let goal=enemyNavGoal(e,targetX,targetY,dt);
  steerEnemy(e,goal.x-e.x,goal.y-e.y,amount,dt,maxSpeed);
}
function moveEnemyWithWalls(e,dt){
  let hit=false,dx=e.vx*dt,dy=e.vy*dt;
  e.x+=dx;if(collideWorld(e)){hit=true;e.vx=0}
  e.y+=dy;if(collideWorld(e)){hit=true;e.vy=0}
  if(hit){e.navTimer=0;e.navPath=[];e.navIndex=0;e.navStuck=0;e.navProgressX=e.x;e.navProgressY=e.y}
  return hit;
}
function pointSegmentDistance(px,py,x1,y1,x2,y2){
  let dx=x2-x1,dy=y2-y1,l2=dx*dx+dy*dy;
  if(!l2)return hypot(px-x1,py-y1);
  let t=clamp(((px-x1)*dx+(py-y1)*dy)/l2,0,1),qx=x1+t*dx,qy=y1+t*dy;
  return hypot(px-qx,py-qy);
}
function playerContactBumpSound(p,source){
  if(!p)return;let now=performance.now();if(now-num(p._contactBumpSoundAt)<240)return;p._contactBumpSoundAt=now;
  gameSound('bump',source||p,{targetId:Number.isInteger(p.id)?p.id:null});
}
function applyPlayerRecoil(p,sourceX,sourceY,push=28){
  if(!p)return;
  let dx=p.x-num(sourceX,p.x-p.faceX),dy=p.y-num(sourceY,p.y-p.faceY),d=hypot(dx,dy);
  if(d<.001){dx=num(p.faceX,1);dy=num(p.faceY);d=hypot(dx,dy)||1}
  let impulse=clamp(num(push,28)*5,120,280),duration=clamp(.13+num(push,28)/500,.17,.24);
  p.hitVX=dx/d*impulse;p.hitVY=dy/d*impulse;p.hitTime=Math.max(num(p.hitTime),duration);
}
function enemyHitPlayer(p,e,push=28){
  if(!p||!p.alive)return false;
  if(p.phase>0||p.dt>0||p.dashHit>0)return false;
  if(p.inv>0){playerContactBumpSound(p,e);return false;}
  let d=hypot(p.x-e.x,p.y-e.y)||1;
  if(p.shield>0){
    p.shield=0;p.inv=SHIELD_BREAK_GRACE;e.vx=-((p.x-e.x)/d)*150;e.vy=-((p.y-e.y)/d)*150;
    gainSuperEnergy(p,16,'survival');gameSound('shieldBreak',p);
  }else{
    p.hp--;p.inv=difficultyConfig(game.difficulty).invulnerability;gameSound('playerHit',p);
  }
  game.shake=.13;
  applyPlayerRecoil(p,e.x,e.y,push);
  if(p.hp<=0)p.alive=false;
  return true;
}
function bossRecoveryDuration(stage){return stage<=1?1.45:stage===2?1.2:1.0}
function bossReengageDelay(stage){return stage<=1?1.05:stage===2?.86:.68}
function beginBossRecovery(e,stage=e.bossStage,extra=0){
  if(!e||e.defeated)return;
  stage=clamp(Math.round(num(stage,1)),1,3);
  let recovery=bossRecoveryDuration(stage)+Math.max(0,num(extra));
  e.mode='bossRecover';e.aiTimer=Math.max(num(e.aiTimer),recovery);e.cooldown=Math.max(num(e.cooldown),recovery+bossReengageDelay(stage));
  e.pulseRadius=0;e.attackHits=[];e.navPath=[];e.navIndex=0;e.navTimer=0;e.vx*=.18;e.vy*=.18;
}
function damageBoss(e,p,amount=1,forceX=0,forceY=0){
  if(!e||e.type!=='warden'||e.defeated||e.hitInvuln>0)return false;
  e.hp=Math.max(0,Math.round(num(e.hp,e.maxHp))-Math.max(1,Math.round(amount)));
  e.hitInvuln=.46;e.stun=Math.max(e.stun,.14);e.vx+=forceX*42;e.vy+=forceY*42;
  game.shake=Math.max(game.shake,.18);
  if(p){p.score+=Math.max(1,Math.round(amount))*3;gainSuperEnergy(p,18,'combat')}
  if(e.hp<=0){e.hp=0;e.defeated=true;e.mode='bossDefeated';e.deathTimer=2.05;e.vx=e.vy=0;e.pulseRadius=0;e.attackHits=[];game.firePatches=[];gameSound('bossDefeat',e)}
  else gameSound('bossHit',e);
  return true;
}
function bossAngleDistance(a,b){return Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)))}
function spawnBossFireCrown(e,target,stage,outer=false){
  let aim=Math.atan2((target?target.y:e.y)-e.y,(target?target.x:e.x+1)-e.x),opposite=aim+Math.PI;
  let count=outer?18:12+stage*2,radius=outer?146:82+stage*10,gap=outer?.5:.56;
  for(let i=0;i<count;i++){
    let a=i*Math.PI*2/count;
    if(bossAngleDistance(a,aim)<gap||bossAngleDistance(a,opposite)<gap)continue;
    addFirePatch(e.x+Math.cos(a)*radius,e.y+Math.sin(a)*radius,-1,true,outer?18:20,outer?1.8:1.7);
  }
}
function setBossChargeAim(e,target){
  let radius=enemyNavRadius(e),tx=target.x,ty=target.y;
  if(!navSegmentClear(e.x,e.y,tx,ty,radius)){
    let found=null,path=Array.isArray(e.navPath)?e.navPath:[];
    for(let i=Math.max(0,e.navIndex||0);i<Math.min(path.length,(e.navIndex||0)+12);i++){
      let point=path[i],distance=hypot(point.x-e.x,point.y-e.y);
      if(distance<42)continue;
      if(distance>270||!navSegmentClear(e.x,e.y,point.x,point.y,radius))break;
      found=point;
    }
    if(!found)return false;tx=found.x;ty=found.y;
  }
  let dx=tx-e.x,dy=ty-e.y,d=hypot(dx,dy);if(d<36)return false;
  e.aimX=dx/d;e.aimY=dy/d;return true;
}
function applyKrakenGravity(e,dt,strength=120,range=220,swirl=0){
  for(const p of game.players){
    if(!p.alive)continue;
    let dx=e.x-p.x,dy=e.y-p.y,d=hypot(dx,dy)||1;
    if(d>range||d<6)continue;
    let falloff=1-d/range,pull=Math.max(0,strength)*falloff*dt,px=dx/d,py=dy/d;
    p.vx+=px*pull;p.vy+=py*pull;
    if(swirl){p.vx+=-py*swirl*falloff*dt;p.vy+=px*swirl*falloff*dt}
  }
}
function hitKrakenArm(e,stage){
  let reach=Math.max(0,num(e.armLength)),x1=e.x+num(e.aimX,1)*18,y1=e.y+num(e.aimY)*18,x2=e.x+num(e.aimX,1)*reach,y2=e.y+num(e.aimY)*reach,width=15+stage*2;
  for(const p of game.players){
    if(!p.alive||e.attackHits.includes(p.id))continue;
    if(pointSegmentDistance(p.x,p.y,x1,y1,x2,y2)<=p.r+width){e.attackHits.push(p.id);enemyHitPlayer(p,e,48+stage*4)}
  }
}
function spawnKrakenInk(target,stage){
  if(!Array.isArray(game.inkSplats))game.inkSplats=[];
  game.inkSeq=Math.max(0,Math.round(num(game.inkSeq)));
  let baseX=target?target.x:W/2,baseY=target?target.y:H/2,count=3+stage;
  for(let i=0;i<count;i++){
    let a=Math.random()*Math.PI*2,distance=i===0?18:45+Math.random()*155;
    let x=clamp(baseX+Math.cos(a)*distance,34,W-34),y=clamp(baseY+Math.sin(a)*distance,42,H-42);
    let life=3.5+Math.random()*1.25,r=48+Math.random()*28+stage*3;
    game.inkSplats.push({id:++game.inkSeq,x,y,r,life,maxLife:life,phase:Math.random()*Math.PI*2,tone:i%3});
  }
  game.inkSplats=game.inkSplats.slice(-10);
}
function updateInkSplats(dt){
  if(!Array.isArray(game.inkSplats))game.inkSplats=[];
  for(let i=game.inkSplats.length-1;i>=0;i--){let s=game.inkSplats[i];s.life=Math.max(0,num(s.life)-dt);if(!s.life)game.inkSplats.splice(i,1)}
}
function updateBoss(e,dt,cfg,map,machineScale){
  let meta=bossMetaForLevel(game.level),kraken=meta.kind==='kraken';
  if(e.defeated){e.deathTimer=Math.max(0,e.deathTimer-dt);e.phase+=dt*(kraken?1.05:.8);e.armProgress=0;e.armLength=0;e.inkCharge=0;return}
  let target=nearestAlive(e);if(!target)return;
  let ratio=e.maxHp?e.hp/e.maxHp:1,stage=ratio<=.34?3:ratio<=.67?2:1;
  if(stage!==e.bossStage){e.bossStage=stage;beginBossRecovery(e,stage,kraken?.26:.18);if(kraken)spawnBossFireCrown(e,target,stage,stage>=2);game.shake=.22;gameSound('bossPhase',e,{force:true})}
  let base=cfg.enemySpeed*map.speed*(.88+stage*.14)*(kraken?1.08:1)*machineScale,accel=cfg.enemyAccel*map.speed*(1.08+stage*.14)*(kraken?1.15:1)*machineScale;
  e.cooldown=Math.max(0,e.cooldown-dt*machineScale);e.bossTrailCd=Math.max(0,e.bossTrailCd-dt*machineScale);
  e.armProgress=clamp(num(e.armProgress),0,1);e.armLength=Math.max(0,num(e.armLength));e.inkCharge=clamp(num(e.inkCharge),0,1);

  if(e.mode==='bossArmWindup'){
    let duration=.58-stage*.04,dx=target.x-e.x,dy=target.y-e.y,d=hypot(dx,dy)||1;
    e.aimX=dx/d;e.aimY=dy/d;e.armTargetX=target.x;e.armTargetY=target.y;e.armLength=clamp(d+28,100,292+stage*8);
    e.aiTimer-=dt*machineScale;e.vx*=Math.max(0,1-dt*14);e.vy*=Math.max(0,1-dt*14);
    e.armProgress=.08+.08*Math.sin(visualNowMs()/52);
    if(e.aiTimer<=0){e.mode='bossArmStrike';e.aiTimer=.34;e.attackHits=[];e.armProgress=0;gameSound('charge',e)}
    return;
  }
  if(e.mode==='bossArmStrike'){
    let duration=.34,progress=1-clamp(num(e.aiTimer)/duration,0,1);
    e.aiTimer-=dt*machineScale;e.vx=e.vy=0;e.armProgress=Math.sin(Math.PI*clamp(progress,0,1));
    let fullReach=clamp(hypot(num(e.armTargetX,e.x)-e.x,num(e.armTargetY,e.y)-e.y)+34,105,300+stage*8);
    e.armLength=fullReach*e.armProgress;
    if(e.armProgress>.3)hitKrakenArm(e,stage);
    if(e.aiTimer<=0){e.armProgress=0;e.armLength=0;beginBossRecovery(e,stage,.06)}
    return;
  }
  if(e.mode==='bossInkWindup'){
    let duration=.72-stage*.04;
    e.aiTimer-=dt*machineScale;e.vx*=Math.max(0,1-dt*13);e.vy*=Math.max(0,1-dt*13);
    e.inkCharge=clamp(1-num(e.aiTimer)/duration,0,1);
    if(kraken)applyKrakenGravity(e,dt*machineScale,95+stage*12,180+stage*14,22+stage*4);
    if(e.aiTimer<=0){spawnKrakenInk(target,stage);e.mode='bossInkBurst';e.aiTimer=.34;e.inkCharge=1;game.shake=Math.max(game.shake,.18);gameSound('slam',e)}
    return;
  }
  if(e.mode==='bossInkBurst'){
    e.aiTimer-=dt*machineScale;e.vx=e.vy=0;e.inkCharge=clamp(e.aiTimer/.34,0,1);
    if(e.aiTimer<=0){e.inkCharge=0;beginBossRecovery(e,stage,.08)}
    return;
  }
  if(e.mode==='bossChargeWindup'){
    if(kraken)applyKrakenGravity(e,dt*machineScale,170+stage*28,240+stage*18,20+stage*5);
    e.aiTimer-=dt*machineScale;e.vx*=Math.max(0,1-dt*12);e.vy*=Math.max(0,1-dt*12);
    if(e.aiTimer<=0){e.mode='bossCharge';e.aiTimer=.62+stage*.08;e.vx=e.aimX*base*(3.7+stage*.35);e.vy=e.aimY*base*(3.7+stage*.35);gameSound('charge',e)}
    return;
  }
  if(e.mode==='bossCharge'){
    e.aiTimer-=dt*machineScale;
    if(e.bossTrailCd<=0){addFirePatch(e.x-e.aimX*(e.r+8),e.y-e.aimY*(e.r+8),-1,true,18+stage,kraken?1.4:1.25);e.bossTrailCd=kraken?.09:.12}
    let hit=moveEnemyWithWalls(e,dt*machineScale);
    if(hit||e.aiTimer<=0){if(stage>=2)spawnBossFireCrown(e,nearestAlive(e)||target,stage,kraken&&stage===3);beginBossRecovery(e,stage,kraken?.08:0)}
    return;
  }
  if(e.mode==='bossSlamWindup'){
    if(kraken)applyKrakenGravity(e,dt*machineScale,130+stage*20,210+stage*16,12+stage*4);
    e.aiTimer-=dt*machineScale;e.vx*=Math.max(0,1-dt*12);e.vy*=Math.max(0,1-dt*12);
    if(e.aiTimer<=0){e.mode='bossSlam';e.aiTimer=.72;e.pulseRadius=0;e.attackHits=[];gameSound('slam',e)}
    return;
  }
  if(e.mode==='bossSlam'){
    if(kraken)applyKrakenGravity(e,dt*machineScale,95+stage*16,190+stage*16,0);
    e.aiTimer-=dt*machineScale;let prev=e.pulseRadius,maxRadius=145+stage*18;e.pulseRadius=Math.min(maxRadius,e.pulseRadius+(270+stage*55)*dt*machineScale);
    for(const p of game.players){
      if(!p.alive||e.attackHits.includes(p.id))continue;
      let d=hypot(p.x-e.x,p.y-e.y);
      if(d<=e.pulseRadius+p.r&&d>=Math.max(0,prev-p.r-12)){e.attackHits.push(p.id);enemyHitPlayer(p,e,52)}
    }
    if(e.aiTimer<=0||e.pulseRadius>=maxRadius)beginBossRecovery(e,stage,kraken?.08:0)
    return;
  }
  if(e.mode==='bossRingWindup'){
    if(kraken)applyKrakenGravity(e,dt*machineScale,210+stage*32,265+stage*22,44+stage*8);
    e.aiTimer-=dt*machineScale;e.vx*=Math.max(0,1-dt*14);e.vy*=Math.max(0,1-dt*14);
    if(e.aiTimer<=0){spawnBossFireCrown(e,target,stage,kraken||stage===3);if(stage===3||kraken)spawnBossFireCrown(e,target,stage,true);beginBossRecovery(e,stage,kraken?.08:0);gameSound('slam',e)}
    return;
  }
  if(e.mode==='bossRecover'){
    e.aiTimer-=dt*machineScale;e.vx*=Math.max(0,1-dt*9);e.vy*=Math.max(0,1-dt*9);e.armProgress=0;e.armLength=0;e.inkCharge=0;
    if(e.aiTimer<=0){e.aiTimer=0;e.mode='bossChase'}
    return;
  }

  let dx=target.x-e.x,dy=target.y-e.y,d=hypot(dx,dy)||1,side=e.attackCycle%2?1:-1;
  let approach=clamp((d-(kraken?90:120))/(kraken?160:180),kraken?.1:.18,1),orbitRadius=(kraken?94:76)+stage*(kraken?11:9);
  let orbitAngle=Math.atan2(dy,dx)+side*((kraken?1.28:1.05)+.16*Math.sin(e.phase*.7));
  let orbitX=target.x+Math.cos(orbitAngle)*orbitRadius,orbitY=target.y+Math.sin(orbitAngle)*orbitRadius;
  let chaseX=target.x*approach+orbitX*(1-approach),chaseY=target.y*approach+orbitY*(1-approach);
  let surge=d>270?(kraken?1.28:1.18):d>190?(kraken?1.14:1.08):1;
  steerEnemyTo(e,chaseX,chaseY,accel*surge,dt*machineScale,base*surge);
  moveEnemyWithWalls(e,dt*machineScale);
  if(kraken&&d<210)applyKrakenGravity(e,dt*machineScale,42+stage*8,175+stage*14,10);
  if(e.cooldown<=0){
    dx=target.x-e.x;dy=target.y-e.y;d=hypot(dx,dy)||1;
    let chargeReady=setBossChargeAim(e,target),started=false;
    if(!chargeReady){e.aimX=dx/d;e.aimY=dy/d}
    if(kraken){
      e.attackCycle=(e.attackCycle+1)%5;let choice=e.attackCycle;
      if((choice===0||choice===3)&&d<310){
        e.mode='bossArmWindup';e.aiTimer=.58-stage*.04;e.armTargetX=target.x;e.armTargetY=target.y;e.armLength=clamp(d+28,100,292+stage*8);e.armProgress=0;e.vx=e.vy=0;started=true;
      }else if(choice===1){
        e.mode='bossInkWindup';e.aiTimer=.72-stage*.04;e.inkCharge=0;e.vx=e.vy=0;started=true;
      }else if(d>300&&chargeReady){
        e.mode='bossChargeWindup';e.aiTimer=.68-stage*.07;started=true;
      }else if(d<172){
        e.mode='bossSlamWindup';e.aiTimer=.66-stage*.04;e.vx=e.vy=0;started=true;
      }else if(d<286){
        e.mode='bossRingWindup';e.aiTimer=.74-stage*.05;e.vx=e.vy=0;started=true;
      }else if(chargeReady){
        e.mode='bossChargeWindup';e.aiTimer=.68-stage*.07;started=true;
      }else{
        e.mode='bossInkWindup';e.aiTimer=.72-stage*.04;e.inkCharge=0;e.vx=e.vy=0;started=true;
      }
      e.cooldown=started?1.02-stage*.12:.24;
    }else{
      e.attackCycle=(e.attackCycle+1)%3;
      if(d>300){
        if(chargeReady&&e.attackCycle!==1){e.mode='bossChargeWindup';e.aiTimer=.74-stage*.07;started=true}
      }else if(d>110&&chargeReady&&(e.attackCycle===0||stage===3&&e.attackCycle===2)){
        e.mode='bossChargeWindup';e.aiTimer=.74-stage*.07;started=true;
      }else if(d<172&&e.attackCycle!==2){
        e.mode='bossSlamWindup';e.aiTimer=.72-stage*.04;e.vx=e.vy=0;started=true;
      }else if(d<286){
        e.mode='bossRingWindup';e.aiTimer=.82-stage*.05;e.vx=e.vy=0;started=true;
      }else if(chargeReady){
        e.mode='bossChargeWindup';e.aiTimer=.74-stage*.07;started=true;
      }
      e.cooldown=started?1.35-stage*.14:.24;
    }
  }
}
function updateEnemy(e,dt,cfg,map){
  let quenched=game.timeStop>0,machineScale=quenched?QUENCH_SLOW:1;
  e.phase+=dt*machineScale;e.scoreCd=Math.max(0,e.scoreCd-dt);e.hitInvuln=Math.max(0,num(e.hitInvuln)-dt);
  e.cryo=Math.max(0,num(e.cryo)-dt);
  e.burn=quenched?0:Math.max(0,num(e.burn)-dt);
  e.fireCd=Math.max(0,num(e.fireCd)-dt*machineScale);
  if(e.type==='brute'&&e.armor===0){e.armorTimer=Math.max(0,e.armorTimer-dt*machineScale);if(!e.armorTimer)e.armor=1}
  if(e.type==='warden'&&e.defeated){updateBoss(e,dt,cfg,map,machineScale);return}
  if(e.cryo>0){
    e.stun=0;
    e.vx*=Math.max(0,1-dt*12);e.vy*=Math.max(0,1-dt*12);
    return;
  }
  if(quenched){
    e.vx*=Math.max(0,1-dt*1.8);e.vy*=Math.max(0,1-dt*1.8);
  }
  if(e.stun>0){e.stun=Math.max(0,e.stun-dt);moveEnemyWithWalls(e,dt*machineScale);e.vx*=Math.max(0,1-dt*2.6);e.vy*=Math.max(0,1-dt*2.6);return}

  if(e.type==='warden'){updateBoss(e,dt,cfg,map,machineScale);return}
  let def=ENEMY_DEFS[e.type]||ENEMY_DEFS.hunter,target=nearestAlive(e),heatSlow=e.burn>0?.72:1,base=cfg.enemySpeed*map.speed*def.speed*heatSlow*machineScale,accel=cfg.enemyAccel*map.speed*def.accel*heatSlow*machineScale;

  if(e.type==='charger'){
    if(e.mode==='windup'){
      e.aiTimer-=dt;e.vx*=Math.max(0,1-dt*10);e.vy*=Math.max(0,1-dt*10);
      if(e.aiTimer<=0){e.mode='charge';e.aiTimer=.5;e.vx=e.aimX*base*4.1;e.vy=e.aimY*base*4.1;gameSound('charge',e)}
    }else if(e.mode==='charge'){
      e.aiTimer-=dt;let hit=collideWorldMove(e,dt);
      if(hit||e.aiTimer<=0){e.mode='chase';e.cooldown=2.1+Math.random()*1.2;e.vx*=.35;e.vy*=.35}
      return;
    }else{
      e.cooldown=Math.max(0,e.cooldown-dt);
      if(target){
        let dx=target.x-e.x,dy=target.y-e.y,d=hypot(dx,dy);
        steerEnemyTo(e,target.x,target.y,accel*.75,dt,base*.78);
        if(e.cooldown<=0&&d<330&&navSegmentClear(e.x,e.y,target.x,target.y,e.r)){e.mode='windup';e.aiTimer=.68;e.aimX=dx/(d||1);e.aimY=dy/(d||1)}
      }
    }
  }else if(e.type==='scout'){
    e.cooldown=Math.max(0,e.cooldown-dt);
    if(e.mode==='dart'){
      e.aiTimer-=dt;
      let hit=collideWorldMove(e,dt);
      if(hit||e.aiTimer<=0){e.mode='orbit';e.cooldown=1.25+Math.random()*.9;e.vx*=.45;e.vy*=.45}
      return;
    }
    if(target){
      let dx=target.x-e.x,dy=target.y-e.y,d=hypot(dx,dy)||1,side=Math.sin(e.phase*.9)>0?1:-1;
      if(e.cooldown<=0&&d<245&&navSegmentClear(e.x,e.y,target.x,target.y,enemyNavRadius(e))){
        let tx=-dy/d*side,ty=dx/d*side;
        e.aimX=dx/d*.62+tx*.78;e.aimY=dy/d*.62+ty*.78;
        let l=hypot(e.aimX,e.aimY)||1;e.aimX/=l;e.aimY/=l;
        e.mode='dart';e.aiTimer=.36;e.vx=e.aimX*base*2.75;e.vy=e.aimY*base*2.75;
        gameSound('scout',e);
        return;
      }
      let desiredRadius=105,ux=(e.x-target.x)/d,uy=(e.y-target.y)/d,tx=-uy*side,ty=ux*side;
      let goalX=target.x+ux*desiredRadius+tx*62,goalY=target.y+uy*desiredRadius+ty*62;
      steerEnemyTo(e,goalX,goalY,accel*1.35,dt,base);
    }
  }else if(e.type==='sentinel'){
    e.cooldown=Math.max(0,e.cooldown-dt);
    if(e.mode==='beamWindup'){
      e.aiTimer-=dt;e.vx*=Math.max(0,1-dt*12);e.vy*=Math.max(0,1-dt*12);
      if(e.aiTimer<=0){e.mode='beam';e.aiTimer=.3;e.attackHits=[];gameSound('beam',e)}
    }else if(e.mode==='beam'){
      e.aiTimer-=dt;e.vx=e.vy=0;
      let x2=e.x+e.aimX*300,y2=e.y+e.aimY*300;
      for(const p of game.players){
        if(!p.alive||e.attackHits.includes(p.id))continue;
        if(pointSegmentDistance(p.x,p.y,e.x,e.y,x2,y2)<p.r+9){
          e.attackHits.push(p.id);enemyHitPlayer(p,e,34);
        }
      }
      if(e.aiTimer<=0){e.mode='return';e.cooldown=2.7+Math.random()*.8}
      return;
    }else if(target){
      let dx=target.x-e.x,dy=target.y-e.y,d=hypot(dx,dy)||1;
      let clearShot=navSegmentClear(e.x,e.y,target.x,target.y,enemyNavRadius(e));
      if(e.cooldown<=0&&d<315&&clearShot){
        e.mode='beamWindup';e.aiTimer=.72;e.aimX=dx/d;e.aimY=dy/d;e.vx=e.vy=0;
      }else{
        let side=Math.sin(e.phase*.47)>=0?1:-1;
        let standOff=clearShot?215:165;
        let goalX=target.x-dx/d*standOff-dy/d*side*36;
        let goalY=target.y-dy/d*standOff+dx/d*side*36;
        steerEnemyTo(e,goalX,goalY,accel,dt,base*.9);
      }
    }
  }else if(e.type==='brute'){
    e.cooldown=Math.max(0,e.cooldown-dt);
    if(e.mode==='slamWindup'){
      e.aiTimer-=dt;e.vx*=Math.max(0,1-dt*12);e.vy*=Math.max(0,1-dt*12);
      if(e.aiTimer<=0){e.mode='slam';e.aiTimer=.5;e.pulseRadius=0;e.attackHits=[];spawnFireRing(e.x,e.y,9,82,true);gameSound('slam',e)}
    }else if(e.mode==='slam'){
      e.aiTimer-=dt;let prev=e.pulseRadius;e.pulseRadius=Math.min(130,e.pulseRadius+300*dt);
      for(const p of game.players){
        if(!p.alive||e.attackHits.includes(p.id))continue;
        let d=hypot(p.x-e.x,p.y-e.y);
        if(d<=e.pulseRadius+p.r&&d>=Math.max(0,prev-p.r-10)){
          e.attackHits.push(p.id);enemyHitPlayer(p,e,46);
        }
      }
      if(e.aiTimer<=0||e.pulseRadius>=130){e.mode='chase';e.cooldown=3+Math.random()*.9;e.pulseRadius=0}
      return;
    }else if(target){
      let dx=target.x-e.x,dy=target.y-e.y,d=hypot(dx,dy);
      if(e.cooldown<=0&&d<135){e.mode='slamWindup';e.aiTimer=.72;e.vx=e.vy=0}
      else steerEnemyTo(e,target.x,target.y,accel*.8,dt,base);
    }
  }else if(target){
    let dx=target.x-e.x,dy=target.y-e.y,d=hypot(dx,dy),rush=d<155?1.22:1;
    steerEnemyTo(e,target.x,target.y,accel*rush,dt,base*rush);
  }

  moveEnemyWithWalls(e,dt);
}
function collideWorldMove(e,dt){return moveEnemyWithWalls(e,dt)}
function addFirePatch(x,y,owner=-1,dangerous=false,radius=21,life=1.9){
  if(game.timeStop>0)return;
  if(!game.firePatches)game.firePatches=[];
  x=clamp(num(x),28,W-28);y=clamp(num(y),28,H-28);if(navPointBlocked(x,y,4))return;
  let patch={id:++net.fireSeq,x,y,r:radius,life,maxLife:life,owner,dangerous,phase:Math.random()*6.28};
  game.firePatches.push(patch);if(game.firePatches.length>90)game.firePatches.splice(0,game.firePatches.length-90);
  if(net.role==='host'){
    let row=[patch.id,Math.round(x*10),Math.round(y*10),Math.round(radius*10),Math.round(life*100),owner,dangerous?1:0,Math.round(patch.phase*100)];
    net.pendingFireEvents.push({row,expires:performance.now()+850});
    if(net.pendingFireEvents.length>180)net.pendingFireEvents.splice(0,net.pendingFireEvents.length-180);
  }
}
function spawnFireRing(x,y,count=8,radius=76,dangerous=true){
  for(let i=0;i<count;i++){let a=i*Math.PI*2/count;addFirePatch(x+Math.cos(a)*radius,y+Math.sin(a)*radius,-1,dangerous,20,1.65)}
}
function updateFirePatches(dt){
  if(!Array.isArray(game.firePatches))game.firePatches=[];
  for(let i=game.firePatches.length-1;i>=0;i--){
    let f=game.firePatches[i];f.life-=dt;
    if(f.life<=0){game.firePatches.splice(i,1);continue}
    if(f.dangerous){
      for(const p of game.players)if(p.alive&&hypot(p.x-f.x,p.y-f.y)<p.r+f.r*.7)environmentHitPlayer(p,f.x,f.y,24);
    }else{
      for(const e of game.enemies){
        if(e.defeated||e.fireCd>0||hypot(e.x-f.x,e.y-f.y)>=e.r+f.r*.72)continue;
        let dx=e.x-f.x,dy=e.y-f.y,d=hypot(dx,dy)||1;
        e.burn=Math.max(e.burn,2.4);e.fireCd=.48;e.stun=Math.max(e.stun,e.type==='warden'?.04:.12);
        e.vx+=dx/d*(e.type==='warden'?12:55);e.vy+=dy/d*(e.type==='warden'?12:55);
      }
    }
  }
}
function flameCycleState(h,t=game.hazardTime){
  let period=Math.max(.25,num(h.period,4)),on=clamp(num(h.on,1.45),.05,period),elapsed=((t+num(h.phase))%period+period)%period;
  let off=Math.max(0,period-on),warningLead=Math.min(.9,Math.max(.45,off*.38)),active=elapsed<on;
  let warning=!active&&off>.05&&elapsed>=period-warningLead;
  return{period,on,elapsed,active,warning,warningLead,warningProgress:warning?clamp((elapsed-(period-warningLead))/warningLead,0,1):0};
}
function flameActive(h,t=game.hazardTime){return flameCycleState(h,t).active}
function flameEnd(h){let angle=num(h.angle),length=num(h.length,130);return{x:h.x+Math.cos(angle)*length,y:h.y+Math.sin(angle)*length}}
function environmentHitPlayer(p,x,y,push){
  if(!p||!p.alive||p.inv>0||p.phase>0||game.timeStop>0)return false;
  let dx=p.x-x,dy=p.y-y,d=hypot(dx,dy)||1;
  if(p.shield>0){
    p.shield=0;p.inv=SHIELD_BREAK_GRACE;gainSuperEnergy(p,16,'survival');gameSound('shieldBreak',p);
  }else{
    p.hp--;p.inv=difficultyConfig(game.difficulty).invulnerability;
    gameSound('playerHit',p);
  }
  applyPlayerRecoil(p,x,y,push);game.shake=.11;
  if(p.hp<=0)p.alive=false;
  return true;
}
function laserActive(h,t=game.hazardTime){return ((t+num(h.phase))%num(h.period,3))<num(h.on,1.4)}
function updateHazardsForPlayer(p,dt,map){
  if(game.timeStop>0)return;
  for(const h of map.hazards||[]){
    if(h.type==='conveyor'){
      if(p.x>h.x&&p.x<h.x+h.w&&p.y>h.y&&p.y<h.y+h.h){
        p.x+=num(h.dx)*num(h.strength,80)*dt;p.y+=num(h.dy)*num(h.strength,80)*dt;collideWorld(p);
      }
    }else if(h.type==='gravity'){
      let dx=h.x-p.x,dy=h.y-p.y,d=hypot(dx,dy);
      if(d<num(h.radius,130)&&d>1){
        let falloff=1-d/h.radius,force=num(h.strength,100)*falloff;
        p.x+=dx/d*force*dt;p.y+=dy/d*force*dt;collideWorld(p);
        if(d<25)environmentHitPlayer(p,h.x,h.y,36);
      }
    }else if(h.type==='laser'&&laserActive(h)){
      if(pointSegmentDistance(p.x,p.y,h.x1,h.y1,h.x2,h.y2)<p.r+6){
        environmentHitPlayer(p,(h.x1+h.x2)/2,(h.y1+h.y2)/2,34);
      }
    }else if(h.type==='spinner'){
      let arms=Math.max(1,Math.round(num(h.arms,2))),angle=game.hazardTime*num(h.speed,.6)+num(h.phase);
      for(let i=0;i<arms;i++){
        let a=angle+i*Math.PI*2/arms,x2=h.x+Math.cos(a)*h.radius,y2=h.y+Math.sin(a)*h.radius;
        if(pointSegmentDistance(p.x,p.y,h.x,h.y,x2,y2)<p.r+7){
          environmentHitPlayer(p,h.x,h.y,38);break;
        }
      }
    }else if(h.type==='pulse'){
      let period=num(h.period,4),progress=((game.hazardTime+num(h.phase))%period)/period,radius=progress*num(h.maxRadius,180),d=hypot(p.x-h.x,p.y-h.y);
      if(Math.abs(d-radius)<p.r+7)environmentHitPlayer(p,h.x,h.y,32);
    }else if(h.type==='flame'&&flameActive(h)){
      let end=flameEnd(h);
      if(pointSegmentDistance(p.x,p.y,h.x,h.y,end.x,end.y)<p.r+num(h.width,30)*.42){
        environmentHitPlayer(p,h.x,h.y,38);
      }
    }
  }
}
function nearestAlive(e){let best=null,bd=1e9;
for(const p of game.players)if(p.alive){let d=hypot(p.x-e.x,p.y-e.y);
if(d<bd){bd=d;
best=p}}return best}
function valueIndex(list,value){let i=list.indexOf(value);return i<0?0:i}
function quantize(value,scale=10){return Math.round(num(value)*scale)}
function publicPlayerState(p){
  return{id:p.id,x:p.x,y:p.y,vx:p.vx,vy:p.vy,r:p.r,maxHp:5,hp:p.hp,score:p.score,alive:p.alive,connected:p.id===0?true:(net.roster.get(p.id)?.connected!==false),cd:p.cd,dt:p.dt,dx:p.dx,dy:p.dy,faceX:p.faceX,faceY:p.faceY,inv:p.inv,shield:p.shield,magnet:p.magnet,boost:p.boost,phase:p.phase,freezeAura:p.freezeAura,timeStopAura:p.timeStopAura,fireTrailCd:p.fireTrailCd,superSlots:sanitizeSuperSlots(p.superSlots),superMeter:p.superMeter,superPassive:p.superPassive,bob:p.bob,dashHit:p.dashHit,hitTime:p.hitTime,hitVX:p.hitVX,hitVY:p.hitVY,lastDashSeq:p.lastDashSeq,lastSuperSeq:p.lastSuperSeq,superBuild:sanitizeSuperBuild(p.superBuild),trail:[]};
}
function publicEnemyState(e){return{x:e.x,y:e.y,vx:e.vx,vy:e.vy,r:e.r,type:e.type,stun:e.stun,cryo:e.cryo,phase:e.phase,cooldown:e.cooldown,aiTimer:e.aiTimer,mode:e.mode,aimX:e.aimX,aimY:e.aimY,pulseRadius:e.pulseRadius,armor:e.armor,armorTimer:e.armorTimer,burn:e.burn,maxHp:e.maxHp,hp:e.hp,hitInvuln:e.hitInvuln,bossStage:e.bossStage,attackCycle:e.attackCycle,defeated:e.defeated,deathTimer:e.deathTimer,armTargetX:e.armTargetX,armTargetY:e.armTargetY,armProgress:e.armProgress,armLength:e.armLength,inkCharge:e.inkCharge}}
function publicGameState(){
  return{difficulty:game.difficulty,nextDifficulty:game.nextDifficulty,level:game.level,startLevel:game.startLevel,nextLevel:game.nextLevel,maxLevel:game.maxLevel,levelName:game.levelName,levelHint:game.levelHint,phase:game.phase,count:game.count,time:game.time,hazardTime:game.hazardTime,over:game.over,won:game.won,paused:game.paused,exit:{...game.exit},shake:game.shake,timeStop:game.timeStop,superFx:game.superFx?{...game.superFx}:null,total:game.total,players:game.players.map(publicPlayerState),enemies:game.enemies.map(publicEnemyState),coins:game.coins.map(c=>({...c})),powerups:game.powerups.map(x=>({...x})),firePatches:(game.firePatches||[]).map(f=>({...f})),inkSplats:(game.inkSplats||[]).map(s=>({...s})),inkSeq:Math.max(0,Math.round(num(game.inkSeq)))};
}

function loadLevel(level){
  level=normalizeLevel(level);advanceStateEpoch();let parts=makeLevelObjects(level,game.difficulty);
  game.level=level;game.maxLevel=LEVELS.length;game.levelName=levelConfig(level).name;game.levelHint=levelConfig(level).gimmick||'';game.coins=parts.coins;game.enemies=parts.enemies;game.powerups=parts.powerups;game.firePatches=[];game.inkSplats=[];game.inkSeq=0;game.exit=parts.exit;game.total=parts.coins.length;game.phase='level';game.count=2.4;game.paused=false;game.over=false;game.won=false;game.shake=0;game.timeStop=0;game.superFx=null;game.time=0;game.hazardTime=0;
  resetPlayersForLevel();for(const id of remoteInputs.keys())neutralizeRemoteInput(id);emit('level');
}
function completeLevel(){
  for(const p of game.players)if(p.connected!==false)gainSuperEnergy(p,24,'survival');
  let map=levelConfig(game.level);if(map.bonus)end(true);else if(game.level<CAMPAIGN_LEVEL_COUNT)loadLevel(game.level+1);else end(true);
}
function end(won){game.over=true;game.won=!!won;game.phase='over';game.paused=true;emit('end')}
function setConnectedPlayer(id,connected=true){
  id=clamp(Math.round(num(id)),0,ROOM_JOINERS);let p=game.players.find(x=>x.id===id);
  net.roster.set(id,{id,connected:!!connected});
  if(!p){let s=spawnPoint(id);p=player(id,s.x,s.y,'remote',!!connected);game.players.push(p);game.players.sort((a,b)=>a.id-b.id)}
  p.control='remote';p.connected=!!connected;if(!connected){p.vx=0;p.vy=0;p.dt=0;neutralizeRemoteInput(id)}
  else if(!p.alive&&game.phase==='menu')resetPlayerState(p,id,'remote',0,true,0);
  repairGameState();return p;
}
function removePlayer(id){return setConnectedPlayer(id,false)}
function setInput(id,value,seq=0){
  id=clamp(Math.round(num(id)),0,ROOM_JOINERS);let old=remoteInputs.get(id);seq=Math.max(0,Math.round(num(seq)));
  if(old&&seq&&seq<=old.seq)return false;let safe=inputSafe(value);remoteInputs.set(id,{value:safe,seq,at:performance.now()});
  if(safe.dashSeq)acceptRemoteDash(id,safe.dashSeq,safe.dashX,safe.dashY);return true;
}
function startRun(difficulty='normal',level=1){
  selectedDifficulty=normalizeDifficulty(difficulty);selectedLevel=normalizeLevel(level);advanceStateEpoch();
  let connected=[...net.roster.entries()].filter(([,m])=>m.connected).map(([id])=>id);if(!connected.includes(0))connected.unshift(0);
  game=makeGame(selectedDifficulty,selectedLevel);game.players=[];
  for(const id of connected){let s=spawnPoint(id);game.players.push(player(id,s.x,s.y,'remote',true))}
  game.players.sort((a,b)=>a.id-b.id);game.phase='count';game.count=3;game.paused=false;game.over=false;game.won=false;emit('run');return publicGameState();
}
function returnToLobby(difficulty=game.difficulty,level=game.level){
  selectedDifficulty=normalizeDifficulty(difficulty);selectedLevel=normalizeLevel(level);advanceStateEpoch();
  let connected=[...net.roster.entries()].filter(([,m])=>m.connected).map(([id])=>id);if(!connected.includes(0))connected.unshift(0);
  game=makeGame(selectedDifficulty,selectedLevel);game.players=[];for(const id of connected){let s=spawnPoint(id);game.players.push(player(id,s.x,s.y,'remote',true))}game.players.sort((a,b)=>a.id-b.id);game.phase='menu';emit('setup');return publicGameState();
}
function restartRun(){return startRun(game.difficulty,game.level)}
function pauseRun(){if(game.phase!=='menu'&&!game.over){game.paused=true;emit('pause')}}
function resumeRun(){if(game.phase!=='menu'&&!game.over){game.paused=false;emit('resume')}}

function tick(dt){
  dt=clamp(num(dt),0,.05);if(!game||game.over)return;
  if(game.phase==='menu'||game.paused)return;
  if(game.phase==='count'||game.phase==='level'){game.count=Math.max(0,game.count-dt);if(!game.count){game.phase='play';emit('go')}return}
  game.time+=dt;game.hazardTime+=game.timeStop>0?0:dt;updateBonusCoinField();navSearchBudget=NAV_SEARCHES_PER_TICK;
  for(const p of game.players){
    p.bob+=dt*7;p.inv=Math.max(0,p.inv-dt);p.magnet=Math.max(0,p.magnet-dt);p.boost=Math.max(0,p.boost-dt);p.phase=Math.max(0,p.phase-dt);p.freezeAura=Math.max(0,num(p.freezeAura)-dt);p.timeStopAura=Math.max(0,num(p.timeStopAura)-dt);p.fireTrailCd=Math.max(0,num(p.fireTrailCd)-dt);p.hitTime=Math.max(0,num(p.hitTime)-dt);if(!p.hitTime){p.hitVX=0;p.hitVY=0}p.superSlots=sanitizeSuperSlots(p.superSlots);for(const slot of p.superSlots)slot.cooldown=Math.max(0,slot.cooldown-dt);p.cd=Math.max(0,p.cd-dt);p.dt=Math.max(0,p.dt-dt);p.trail=p.trail.filter(t=>performance.now()-t.at<(t.life||280)).slice(-16);p.dashHit=Math.max(0,p.dashHit-dt);
    if(!p.alive||p.connected===false)continue;let c=control(p),sp=playerMoveSpeed(p);if(c.x||c.y||p.dt>0){p.superPassive+=dt;if(p.superPassive>=2){let ticks=Math.floor(p.superPassive/2);p.superPassive-=ticks*2;gainSuperEnergy(p,ticks,'survival')}}if(c.x||c.y){p.faceX=c.x;p.faceY=c.y}
    if(c.dashSeq>p.lastDashSeq)acceptRemoteDash(p.id,c.dashSeq,c.dashX,c.dashY);processRemoteDash(p);if(c.superSeq&&c.superSeq!==p.lastSuperSeq){p.lastSuperSeq=c.superSeq;activateSuper(p,c.superSlot)}
    let recoiling=p.hitTime>0&&p.dt<=0;if(p.dt>0){let dashSpeed=playerDashSpeed(p);p.vx=p.dx*dashSpeed;p.vy=p.dy*dashSpeed;let trailNow=performance.now();if(trailNow-num(p._lastTrailAt,0)>=28){p._lastTrailAt=trailNow;p.trail.push({x:p.x,y:p.y,dx:p.dx,dy:p.dy,at:trailNow,life:280,flame:p.boost>0})}}else{let controlScale=recoiling?.22:1;p.vx=c.x*sp*controlScale+(recoiling?num(p.hitVX):0);p.vy=c.y*sp*controlScale+(recoiling?num(p.hitVY):0)}
    p.x+=p.vx*dt;p.y+=p.vy*dt;let wallContact=collideWorld(p);p._wallContact=wallContact;if(recoiling){let decay=Math.exp(-dt*10.5);p.hitVX*=decay;p.hitVY*=decay;if(wallContact){p.hitVX*=.18;p.hitVY*=.18}}
    if(p.boost>0&&hypot(p.vx,p.vy)>45&&p.fireTrailCd<=0){let l=hypot(p.vx,p.vy)||1,ux=p.vx/l,uy=p.vy/l;addFirePatch(p.x-ux*(p.r+8),p.y-uy*(p.r+8),p.id,false,p.dt>0?24:19,p.dt>0?2.15:1.65);p.fireTrailCd=p.dt>0?.07:.12}
    updateHazardsForPlayer(p,dt,levelConfig(game.level));for(const coin of game.coins)if(!coin.taken&&hypot(p.x-coin.x,p.y-coin.y)<p.r+coin.r+4)collectCoin(p,coin);for(const item of game.powerups)if(!item.taken&&playerTouchesPower(p,item))collectPower(p,item);for(const e of game.enemies){if(e.defeated)continue;let d=hypot(p.x-e.x,p.y-e.y);if(d<p.r+e.r){if(p.dt>0)dashSmash(p,e);else enemyHitPlayer(p,e,e.type==='warden'?54:e.type==='brute'?40:28)}}
  }
  for(const coin of game.coins)if(!coin.taken){let best=null,bd=190;for(const p of game.players)if(p.alive&&p.connected!==false&&p.magnet>0){let d=hypot(p.x-coin.x,p.y-coin.y);if(d<bd){bd=d;best=p}}if(best){let dx=best.x-coin.x,dy=best.y-coin.y,l=hypot(dx,dy)||1,s=Math.min(310,120+(190-l)*1.2);coin.x+=dx/l*s*dt;coin.y+=dy/l*s*dt;if(l<best.r+coin.r+4)collectCoin(best,coin)}}
  updateFirePatches(dt);updateInkSplats(dt);game.timeStop=Math.max(0,game.timeStop-dt);if(game.superFx){game.superFx.time=Math.max(0,game.superFx.time-dt);if(!game.superFx.time)game.superFx=null}
  let cfg=difficultyConfig(game.difficulty),map=levelConfig(game.level);for(const e of game.enemies)updateEnemy(e,dt,cfg,map);
  let taken=game.coins.filter(c=>c.taken).length,boss=game.enemies.find(e=>e.type==='warden');if(!game.players.some(p=>p.alive&&p.connected!==false))end(false);else if(map.bonus){if(game.time>=num(map.bonusTime,45))end(true)}else if(map.boss){if(boss&&boss.defeated&&boss.deathTimer<=0)completeLevel()}else if(taken===game.total&&game.players.some(p=>p.alive&&p.connected!==false&&hypot(p.x-game.exit.x,p.y-game.exit.y)<p.r+game.exit.r))completeLevel();game.shake=Math.max(0,game.shake-dt);
}
function compactMotionState(){return{t:'motion',pv:PROTOCOL_VERSION,epoch:net.stateEpoch,seq:++net.motionSeq,ts:Math.round(performance.now()),p:game.players.map(p=>[p.id,quantize(p.x),quantize(p.y),quantize(p.vx),quantize(p.vy),quantize(p.dt,100),quantize(p.dx,100),quantize(p.dy,100),quantize(p.faceX,100),quantize(p.faceY,100),quantize(p.bob,100),quantize(p.inv,100),quantize(p.dashHit,100),Math.max(0,Math.round(num(p.lastDashSeq,0))),quantize(p.hitTime,100)]),e:game.enemies.map(e=>[quantize(e.x),quantize(e.y),quantize(e.vx),quantize(e.vy),quantize(e.phase,100),valueIndex(ENEMY_MODE_KEYS,e.mode),quantize(e.aimX,100),quantize(e.aimY,100),quantize(e.pulseRadius),quantize(e.burn,100),quantize(e.stun,100),quantize(e.armProgress,100),quantize(e.armLength),quantize(e.armTargetX),quantize(e.armTargetY),quantize(e.inkCharge,100)]),a:recentFireRows()}}
function fullState(){repairGameState();return publicGameState()}
function setSettings(difficulty,level){selectedDifficulty=normalizeDifficulty(difficulty);selectedLevel=normalizeLevel(level);game.nextDifficulty=selectedDifficulty;game.nextLevel=selectedLevel;if(game.phase==='menu'){game.difficulty=selectedDifficulty;game.level=selectedLevel;game.startLevel=selectedLevel;game.levelName=levelConfig(selectedLevel).name;game.levelHint=levelConfig(selectedLevel).gimmick||''}return{difficulty:selectedDifficulty,level:selectedLevel}}
function restore(state,roster=[],savedEpoch=1){
  if(state&&typeof state==='object'){game=typeof structuredClone==='function'?structuredClone(state):JSON.parse(JSON.stringify(state));repairGameState();selectedDifficulty=normalizeDifficulty(game.nextDifficulty||game.difficulty);selectedLevel=normalizeLevel(game.nextLevel||game.level)}
  net.roster.clear();for(const row of roster||[]){let id=clamp(Math.round(num(row&&row.id)),0,ROOM_JOINERS),connected=!!(row&&row.connected);net.roster.set(id,{id,connected});let p=game.players.find(x=>x.id===id);if(p){p.control='remote';p.connected=connected}}
  net.stateEpoch=normalizeEpoch(savedEpoch);net.eventSeq=0;net.motionSeq=0;net.stateSeq=0;return fullState();
}
function epoch(){return net.stateEpoch}
function nextStateSeq(){return++net.stateSeq}

selectedDifficulty='normal';selectedLevel=1;game=makeGame(selectedDifficulty,selectedLevel);game.players[0].control='remote';net.roster.set(0,{id:0,connected:true});
return{tick,setInput,setConnectedPlayer,removePlayer,startRun,restartRun,returnToLobby,pauseRun,resumeRun,setSettings,restore,fullState,compactMotionState,epoch,nextStateSeq,get game(){return game},get protocol(){return PROTOCOL_VERSION}};
}
