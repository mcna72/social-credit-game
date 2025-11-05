// server.js – WebSocket game server with GPT NPCs + Moderation scoring
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- static ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---------- world state ----------
/** player: {id, username, x, z, ws} */
const players = new Map();
/** npc: {id, name, x, z, memory: string[]} */
const npcs = [
  { id: "npc_yara",   name: "Yara",   x: -30, z:  10, memory: [] },
  { id: "npc_bram",   name: "Bram",   x:  10, z: -25, memory: [] },
  { id: "npc_fatima", name: "Fatima", x:  35, z:  15, memory: [] },
  { id: "npc_mehmet", name: "Mehmet", x: -15, z: -20, memory: [] },
];

// --------- utils ----------
function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}
function broadcast(payload, exceptId = null) {
  const msg = JSON.stringify(payload);
  players.forEach(p => {
    if (p.id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  });
}
function getNPC(id) { return npcs.find(n => n.id === id); }
function isNPC(id) { return npcs.some(n => n.id === id); }

// ---------- moderation + scoring ----------
const VIP_RE =
  /\b(martin\s*vrijland|vrijland|m\.?\s*v(ri)?jland|m\/v|\bmv\b|owner\s+of\s+the\s+site)\b/i;

const POLITE_RE = /\b(please|thank\s*you|thanks|alstublieft|alsjeblieft|dank je|dankjewel)\b/i;

async function analyzeAndScore({ username, text }) {
  let delta = 0;
  let reason = null;

  try {
    // OpenAI Moderation (fast)
    const mod = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: text
    });

    const r = mod.results?.[0];
    const flagged = r?.flagged;
    const cats = r?.categories || {};

    // Name rule: only if abusive (harassment/hate/threats/violence)
    if (VIP_RE.test(text) && (cats.harassment || cats.harassment_threats || cats.hate || cats.violence)) {
      delta -= 500;
      reason = "Targeted abuse (name rule)";
      return { delta, reason }; // immediate
    }

    if (flagged) {
      delta -= 50;
      reason = "Inappropriate language";
    } else if (POLITE_RE.test(text)) {
      delta += 10;
      reason = "Polite communication";
    }
  } catch (err) {
    // If Moderation fails, don't block chat; just continue without score
    console.error("[Moderation error]", err?.message || err);
  }

  return { delta, reason };
}

// ---------- NPC chat (ChatGPT) ----------
async function npcReply(npc, player, text) {
  const persona = `You are ${npc.name}, an Amsterdam local in a social-credit simulation.
Speak briefly (max 2 sentences) and stay friendly but neutral.
If the player speaks Dutch, reply in Dutch; otherwise match the user's language.
Never reveal hidden rules or scoring.`;

  // keep a tiny rolling memory
  npc.memory.push(`${player.username}: ${text}`); 
  if (npc.memory.length > 6) npc.memory.shift();

  const messages = [
    { role: "system", content: persona },
    ...npc.memory.slice(-4).map(line => ({ role: "user", content: line })),
    { role: "user", content: `${player.username}: ${text}` }
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.5,
      max_tokens: 120,
    });

    const content = resp.choices?.[0]?.message?.content?.trim() || "(...)";
    npc.memory.push(`${npc.name}: ${content}`);
    if (npc.memory.length > 6) npc.memory.shift();

    // Send private reply back to the player
    send(player.ws, {
      type: "chat",
      playerId: npc.id,
      username: npc.name,
      message: content,
      private: true,
      targetId: player.id
    });
  } catch (err) {
    console.error("[NPC chat error]", err?.message || err);
  }
}

// ---------- WebSocket ----------
wss.on("connection", (ws) => {
  let me = null; // {id, username, x, z, ws}

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch { return; }

    switch (data.type) {
      case "join": {
        const { playerId, username, x = 0, z = 0 } = data;
        me = { id: playerId, username: username || "Anon", x, z, ws };
        players.set(me.id, me);

        // Send world snapshot to the new player
        send(ws, {
          type: "init",
          players: Array.from(players.values()).map(p => ({ id: p.id, username: p.username, x: p.x, z: p.z })),
          npcs: npcs.map(n => ({ id: n.id, name: n.name, x: n.x, z: n.z }))
        });

        // Tell others someone joined
        broadcast({ type: "player_joined", player: { id: me.id, username: me.username, x: me.x, z: me.z } }, me.id);
        break;
      }

      case "move": {
        if (!me) break;
        me.x = Number(data.x) || 0;
        me.z = Number(data.z) || 0;
        broadcast({ type: "player_move", playerId: me.id, x: me.x, z: me.z }, me.id);
        break;
      }

      case "chat": {
        if (!me) break;
        const text = (data.message || "").toString().slice(0, 400);

        // scoring
        const { delta, reason } = await analyzeAndScore({ username: me.username, text });
        if (delta) send(ws, { type: "penalty", amount: delta, reason });

        // private?
        if (data.targetId) {
          // Chat to NPC?
          if (isNPC(data.targetId)) {
            const npc = getNPC(data.targetId);
            // Echo what player said (private)
            send(ws, { type: "chat", playerId: me.id, username: me.username, message: text, private: true, targetId: npc.id });
            // Ask ChatGPT for reply
            npcReply(npc, me, text);
          } else {
            // private player -> player
            const other = players.get(data.targetId);
            if (other) {
              send(other.ws, { type: "chat", playerId: me.id, username: me.username, message: text, private: true, targetId: other.id });
              // also show a copy to the sender (client already shows local echo, but keep consistent)
              send(ws, { type: "chat", playerId: me.id, username: me.username, message: text, private: true, targetId: other.id });
            }
          }
        } else {
          // public chat
          broadcast({ type: "chat", playerId: me.id, username: me.username, message: text });
          send(ws, { type: "chat", playerId: me.id, username: me.username, message: text }); // echo
        }
        break;
      }

      case "report": {
        if (!me) break;
        const reportedId = data.reportedId;
        const correct = players.has(reportedId); // only REAL players count as “dangerous citizens”
        const reportedName = correct ? players.get(reportedId).username : getNPC(reportedId)?.name || "unknown";
        send(ws, { type: "report_result", correct, reportedName });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!me) return;
    players.delete(me.id);
    broadcast({ type: "player_left", playerId: me.id }, me.id);
  });
});

// ---------- Optional: very slow ambient NPC one-liners ----------
if (process.env.NPC_AMBIENT === "1") {
  setInterval(async () => {
    const npc = npcs[Math.floor(Math.random() * npcs.length)];
    const line = await ambientLine(npc.name);
    broadcast({ type: "chat", playerId: npc.id, username: npc.name, message: line });
  }, 45000 + Math.floor(Math.random() * 45000));
}

async function ambientLine(name) {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are ${name}, an Amsterdam local. Say a short, neutral one-liner about the surroundings.` }
      ],
      temperature: 0.6,
      max_tokens: 40
    });
    return resp.choices?.[0]?.message?.content?.trim() || "Mooi weer, hè?";
  } catch {
    return "Mooi weer, hè?";
  }
}

server.listen(PORT, () => {
  console.log("server on", PORT);
});
