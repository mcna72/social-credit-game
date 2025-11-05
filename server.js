// server.js – WebSocket server + GPT NPCs + moderation + weather/time
import path from "path";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 8080;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
let openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let runtimeKey = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/admin/set-key", (req, res) => {
  const { password, apiKey } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!apiKey || typeof apiKey !== "string" || apiKey.length < 20) {
    return res.status(400).json({ ok: false, error: "Invalid key" });
  }
  runtimeKey = apiKey.trim();
  openai = new OpenAI({ apiKey: runtimeKey });
  console.log("[Admin] API key updated");
  res.json({ ok: true });
});

// ----------------- World -----------------
const players = new Map(); // id -> { id, username, x, z, avatar, ws, joinedAt }
const npcs = [
  { id: "npc_yara",   name: "Yara",   x: -30, z:  10, memory: [], targetX: -30, targetZ:  10 },
  { id: "npc_bram",   name: "Bram",   x:  10, z: -25, memory: [], targetX:  10, targetZ: -25 },
  { id: "npc_fatima", name: "Fatima", x:  35, z:  15, memory: [], targetX:  35, targetZ:  15 },
  { id: "npc_mehmet", name: "Mehmet", x: -15, z: -20, memory: [], targetX: -15, targetZ: -20 },
  { id: "npc_anne",   name: "Anne",   x:  20, z:  30, memory: [], targetX:  20, targetZ:  30 },
  { id: "npc_jan",    name: "Jan",    x: -25, z:  25, memory: [], targetX: -25, targetZ:  25 }
];

let weatherState = { type: "clear", intensity: 0.8, gameTime: 12.0 };

const send = (ws, obj) => {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
};

const broadcast = (obj, exceptId = null) => {
  const msg = JSON.stringify(obj);
  players.forEach(p => {
    if (p.id !== exceptId && p.ws.readyState === 1) {
      try { p.ws.send(msg); } catch {}
    }
  });
};

const isNPC  = id => npcs.some(n => n.id === id);
const getNPC = id => npcs.find(n => n.id === id);

// ----------------- Moderation & scoring -----------------
const VIP_RE     = /\b(martin\s*vrijland|vrijland|m\.?\s*v(ri)?jland|m\/v|\bmv\b|owner\s+of\s+the\s+site)\b/i;
const POLITE_RE  = /\b(please|thank\s*you|thanks|alstublieft|alsjeblieft|dank je|dankjewel|graag|gracias|danke)\b/i;

async function analyzeAndScore(text){
  let delta = 0, reason = null;
  try {
    const mod = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: text
    });
    const r = mod.results?.[0] || {};
    const cats = r.categories || {};
    if (VIP_RE.test(text) && (cats.harassment || cats.harassment_threats || cats.hate || cats.violence)) {
      return { delta: -500, reason: "Targeted abuse (name rule)" };
    }
    if (r.flagged) {
      delta -= 50; reason = "Inappropriate language";
    } else if (POLITE_RE.test(text)) {
      delta += 10; reason = "Polite communication";
    }
  } catch (e) { console.error("[Moderation]", e.message); }
  return { delta, reason };
}

// ----------------- NPC chat -----------------
async function npcReply(npc, player, text){
  try {
    const personas = {
      Yara:   "You are Yara, a friendly Amsterdam local who loves art & cycling. Answer briefly (max 2 sentences) in the player's language.",
      Bram:   "You are Bram, a pragmatic tech worker in Amsterdam. Short, direct replies (max 2 sentences) in user's language.",
      Fatima: "You are Fatima, a warm cafe owner in Amsterdam. Welcoming tone, short replies, user's language.",
      Mehmet: "You are Mehmet, a thoughtful artist in Amsterdam. Short, reflective replies in user's language.",
      Anne:   "You are Anne, a cheerful student in Amsterdam who loves music. Short, enthusiastic replies in user's language.",
      Jan:    "You are Jan, a retired teacher in Amsterdam with dry humor. Short witty replies in user's language."
    };
    const persona = personas[npc.name] || `You are ${npc.name}, an Amsterdam local. Reply briefly in user's language.`;

    npc.memory.push(`${player.username}: ${text}`);
    if (npc.memory.length > 8) npc.memory.shift();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: persona },
        ...npc.memory.slice(-6).map(t => ({ role: "user", content: t })),
        { role: "user", content: `${player.username}: ${text}` }
      ],
      temperature: 0.7,
      max_tokens: 90
    });

    const content = resp.choices?.[0]?.message?.content?.trim() || "Interessant… vertel meer.";
    npc.memory.push(`${npc.name}: ${content}`);
    if (npc.memory.length > 8) npc.memory.shift();

    send(player.ws, { type: "chat", playerId: npc.id, username: npc.name, message: content, private: true, targetId: player.id });
  } catch (e) {
    console.error("[NPC chat]", e.message);
    send(player.ws, { type:"chat", playerId:npc.id, username:npc.name, message:"Leuk! Vertel meer.", private:true, targetId: player.id });
  }
}

// ----------------- NPC movement -----------------
function updateNPCMovement(){
  npcs.forEach(npc => {
    if (!npc.nextMoveTime || Date.now() > npc.nextMoveTime) {
      npc.targetX = (Math.random() - 0.5) * 120;
      npc.targetZ = (Math.random() - 0.5) * 120;
      npc.nextMoveTime = Date.now() + 8000 + Math.random()*15000;
    }
    const dx = npc.targetX - npc.x;
    const dz = npc.targetZ - npc.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.5) {
      const speed = 0.06 + Math.random()*0.04;
      npc.x += (dx/dist) * speed;
      npc.z += (dz/dist) * speed;
    }
  });

  broadcast({ type: "npc_update", npcs: npcs.map(n => ({ id: n.id, x: n.x, z: n.z })) });
}
setInterval(updateNPCMovement, 120);

// ----------------- Weather & day/night -----------------
function updateWeather(){
  const types = ["clear","clear","cloudy","rain","fog"];
  weatherState.type = types[(Math.random()*types.length)|0];
  weatherState.intensity = 0.5 + Math.random()*0.6;
  broadcast({ type: "weather_update", weather: weatherState.type, intensity: weatherState.intensity });
}
setInterval(updateWeather, 5*60*1000);

function updateDayNight(){
  weatherState.gameTime += 0.1;
  if (weatherState.gameTime >= 24) weatherState.gameTime = 0;
  broadcast({ type: "time_update", gameTime: weatherState.gameTime });
}
setInterval(updateDayNight, 60*1000);

// ----------------- WebSocket -----------------
wss.on("connection", (ws, req) => {
  let me = null;
  ws.on("message", async raw => {
    let data; try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "join") {
      const { playerId, username, avatar='🙂', x=0, z=0 } = data;
      me = { id: playerId, username: String(username||"Anon").slice(0,20), x, z, avatar, ws, joinedAt: Date.now() };
      players.set(me.id, me);

      send(ws, {
        type: "init",
        players: [...players.values()].map(p => ({ id:p.id, username:p.username, x:p.x, z:p.z, avatar:p.avatar })),
        npcs: npcs.map(n => ({ id:n.id, name:n.name, x:n.x, z:n.z })),
        weather: weatherState
      });

      broadcast({ type: "player_joined", player: { id: me.id, username: me.username, x: me.x, z: me.z, avatar: me.avatar } }, me.id);
    }

    else if (data.type === "move" && me) {
      const nx = Number(data.x)||0, nz = Number(data.z)||0;
      const dist = Math.hypot(nx - me.x, nz - me.z);
      if (dist > 10) { send(ws, { type: "position_correction", x: me.x, z: me.z }); return; }
      me.x = nx; me.z = nz;
      broadcast({ type: "player_move", playerId: me.id, x: me.x, z: me.z }, me.id);
    }

    else if (data.type === "chat" && me) {
      const text = String(data.message||"").trim().slice(0,400);
      if (!text) return;

      if (!me.chatHistory) me.chatHistory = [];
      const now = Date.now();
      me.chatHistory = me.chatHistory.filter(t => now - t < 10_000);
      if (me.chatHistory.length >= 5) { send(ws, { type:"system", message:"Te snel! Even wachten." }); return; }
      me.chatHistory.push(now);

      const { delta, reason } = await analyzeAndScore(text);
      if (delta) send(ws, { type:"penalty", amount: delta, reason });

      if (data.targetId) {
        if (isNPC(data.targetId)) {
          const npc = getNPC(data.targetId);
          send(ws, { type:"chat", playerId: me.id, username: me.username, message: text, private: true, targetId: npc.id });
          npcReply(npc, me, text);
        } else {
          const other = players.get(data.targetId);
          if (other) {
            send(other.ws, { type:"chat", playerId: me.id, username: me.username, message: text, private: true, targetId: other.id });
            send(ws,        { type:"chat", playerId: me.id, username: me.username, message: text, private: true, targetId: other.id });
          }
        }
      } else {
        broadcast({ type:"chat", playerId: me.id, username: me.username, message: text });
        send(ws,      { type:"chat", playerId: me.id, username: me.username, message: text });
      }
    }

    else if (data.type === "report" && me) {
      const correct = players.has(data.reportedId);
      const reportedName = correct ? players.get(data.reportedId).username : (getNPC(data.reportedId)?.name || "unknown");
      send(ws, { type:"report_result", correct, reportedName });
    }
  });

  ws.on("close", () => {
    if (!me) return;
    players.delete(me.id);
    broadcast({ type:"player_left", playerId: me.id }, me.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
