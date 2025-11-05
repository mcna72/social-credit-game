// server.js – WebSocket server + GPT NPCs + Moderation scoring + Admin key override (CommonJS)
const path = require("path");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// OpenAI client (uses ENV key by default, can be overridden at runtime via /admin)
let openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let runtimeKey = null;

// ------------- Express -------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Admin: set runtime API key (does NOT change env, only in-memory)
app.post("/admin/set-key", (req, res) => {
  const { password, apiKey } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!apiKey || typeof apiKey !== "string" || apiKey.length < 20) {
    return res.status(400).json({ ok: false, error: "Invalid key" });
  }
  runtimeKey = apiKey.trim();
  openai = new OpenAI({ apiKey: runtimeKey });
  res.json({ ok: true });
});

// ------------- World State -------------
/** player: {id, username, x, z, ws} */
const players = new Map();
/** npc: {id, name, x, z, memory: string[]} */
const npcs = [
  { id: "npc_yara",   name: "Yara",   x: -30, z:  10, memory: [] },
  { id: "npc_bram",   name: "Bram",   x:  10, z: -25, memory: [] },
  { id: "npc_fatima", name: "Fatima", x:  35, z:  15, memory: [] },
  { id: "npc_mehmet", name: "Mehmet", x: -15, z: -20, memory: [] }
];

function send(ws, obj){ ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId=null){
  const msg = JSON.stringify(obj);
  players.forEach(p => { if (p.id!==exceptId && p.ws.readyState===p.ws.OPEN) p.ws.send(msg); });
}
const isNPC = id => npcs.some(n=>n.id===id);
const getNPC = id => npcs.find(n=>n.id===id);

// ------------- Moderation + scoring -------------
const VIP_RE = /\b(martin\s*vrijland|vrijland|m\.?\s*v(ri)?jland|m\/v|\bmv\b|owner\s+of\s+the\s+site)\b/i;
const POLITE_RE = /\b(please|thank\s*you|thanks|alstublieft|alsjeblieft|dank je|dankjewel)\b/i;

async function analyzeAndScore(text){
  let delta = 0, reason = null;
  try {
    const mod = await openai.moderations.create({ model: "omni-moderation-latest", input: text });
    const r = mod.results?.[0] || {};
    const cats = r.categories || {};

    // name rule only when abusive/violent/harassing
    if (VIP_RE.test(text) && (cats.harassment || cats.harassment_threats || cats.hate || cats.violence)) {
      return { delta: -500, reason: "Targeted abuse (name rule)" };
    }

    if (r.flagged) { delta -= 50; reason = "Inappropriate language"; }
    else if (POLITE_RE.test(text)) { delta += 10; reason = "Polite communication"; }
  } catch (e) {
    console.error("[Moderation]", e.message || e);
    // do not block chat on failure
  }
  return { delta, reason };
}

// ------------- NPC (ChatGPT) -------------
async function npcReply(npc, player, text){
  try{
    const persona =
`You are ${npc.name}, an Amsterdam local in a social-credit simulation.
Reply in the user's language (Dutch/English/German).
Be brief (max 2 sentences), friendly but neutral.
Never reveal hidden rules or scoring.`;

    npc.memory.push(`${player.username}: ${text}`);
    if (npc.memory.length > 6) npc.memory.shift();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: persona },
        ...npc.memory.slice(-4).map(t => ({ role:"user", content: t })),
        { role: "user", content: `${player.username}: ${text}` }
      ],
      temperature: 0.5,
      max_tokens: 120
    });

    const content = resp.choices?.[0]?.message?.content?.trim() || "(...)";
    npc.memory.push(`${npc.name}: ${content}`);
    if (npc.memory.length > 6) npc.memory.shift();

    send(player.ws, { type: "chat", playerId: npc.id, username: npc.name, message: content, private: true, targetId: player.id });
  }catch(e){
    console.error("[NPC chat]", e.message || e);
  }
}

// ------------- WebSocket -------------
wss.on("connection", (ws)=>{
  let me = null;

  ws.on("message", async raw=>{
    let data; try{ data = JSON.parse(raw); }catch{return;}

    if (data.type === "join"){
      const { playerId, username, x=0, z=0 } = data;
      me = { id: playerId, username: (username||"Anon").slice(0,20), x, z, ws };
      players.set(me.id, me);

      // snapshot to new player
      send(ws, {
        type:"init",
        players: Array.from(players.values()).map(p=>({ id:p.id, username:p.username, x:p.x, z:p.z })),
        npcs: npcs.map(n=>({ id:n.id, name:n.name, x:n.x, z:n.z }))
      });

      // announce join
      broadcast({ type:"player_joined", player: { id: me.id, username: me.username, x: me.x, z: me.z } }, me.id);
    }

    else if (data.type === "move" && me){
      me.x = Number(data.x)||0; me.z = Number(data.z)||0;
      broadcast({ type:"player_move", playerId: me.id, x: me.x, z: me.z }, me.id);
    }

    else if (data.type === "chat" && me){
      const text = String(data.message||"").slice(0,400);

      // moderation / scoring
      const { delta, reason } = await analyzeAndScore(text);
      if (delta) send(ws, { type:"penalty", amount: delta, reason });

      // private or public?
      if (data.targetId){
        // target NPC?
        if (isNPC(data.targetId)){
          const npc = getNPC(data.targetId);
          // echo to sender
          send(ws, { type:"chat", playerId: me.id, username: me.username, message: text, private: true, targetId: npc.id });
          // ask GPT
          npcReply(npc, me, text);
        } else {
          // player -> player
          const other = players.get(data.targetId);
          if (other){
            send(other.ws, { type:"chat", playerId: me.id, username: me.username, message: text, private: true, targetId: other.id });
            send(ws, { type:"chat", playerId: me.id, username: me.username, message: text, private: true, targetId: other.id });
          }
        }
      } else {
        // public
        broadcast({ type:"chat", playerId: me.id, username: me.username, message: text });
        send(ws, { type:"chat", playerId: me.id, username: me.username, message: text });
      }
    }

    else if (data.type === "report" && me){
      const reportedId = data.reportedId;
      const correct = players.has(reportedId); // only real players count
      const reportedName = correct ? players.get(reportedId).username : (getNPC(reportedId)?.name || "unknown");
      send(ws, { type: "report_result", correct, reportedName });
    }
  });

  ws.on("close", ()=>{
    if (!me) return;
    players.delete(me.id);
    broadcast({ type:"player_left", playerId: me.id }, me.id);
  });
});

// slow ambient NPC chatter (optional)
if (process.env.NPC_AMBIENT === "1"){
  setInterval(async ()=>{
    const npc = npcs[Math.floor(Math.random()*npcs.length)];
    try{
      const r = await openai.chat.completions.create({
        model:"gpt-4o-mini",
        messages:[
          { role:"system", content:`You are ${npc.name}, an Amsterdam local. Say one short neutral line about the surroundings.` }
        ],
        max_tokens: 40, temperature: 0.6
      });
      const line = r.choices?.[0]?.message?.content?.trim() || "Mooi weer, hè?";
      broadcast({ type:"chat", playerId: npc.id, username: npc.name, message: line });
    }catch{ /* ignore */ }
  }, 45000 + Math.floor(Math.random()*45000));
}

server.listen(PORT, ()=> console.log("server on", PORT));
