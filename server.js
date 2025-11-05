// server.js – Enhanced WebSocket server + GPT NPCs + Weather + Voice signaling
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
// Admin: set runtime API key
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
// ------------- World State -------------
const players = new Map();
const npcs = [
  { id: "npc_yara", name: "Yara", x: -30, z: 10, memory: [], targetX: -30, targetZ: 10 },
  { id: "npc_bram", name: "Bram", x: 10, z: -25, memory: [], targetX: 10, targetZ: -25 },
  { id: "npc_fatima", name: "Fatima", x: 35, z: 15, memory: [], targetX: 35, targetZ: 15 },
  { id: "npc_mehmet", name: "Mehmet", x: -15, z: -20, memory: [], targetX: -15, targetZ: -20 },
  { id: "npc_anne", name: "Anne", x: 20, z: 30, memory: [], targetX: 20, targetZ: 30 },
  { id: "npc_jan", name: "Jan", x: -25, z: 25, memory: [], targetX: -25, targetZ: 25 }
];
// Weather state (synchronized to all clients)
let weatherState = {
  type: 'clear', // clear, cloudy, rain, fog
  intensity: 0,
  gameTime: 12.0 // 0-24 hours
};
function send(ws, obj){
  if (ws.readyState === 1) { // OPEN
    try {
      ws.send(JSON.stringify(obj));
    } catch(e) {
      console.error('[Send error]', e.message);
    }
  }
}
function broadcast(obj, exceptId=null){
  const msg = JSON.stringify(obj);
  players.forEach(p => {
    if (p.id !== exceptId && p.ws.readyState === 1) {
      try {
        p.ws.send(msg);
      } catch(e) {
        console.error('[Broadcast error]', e.message);
      }
    }
  });
}
const isNPC = id => npcs.some(n=>n.id===id);
const getNPC = id => npcs.find(n=>n.id===id);
// ------------- Moderation + scoring -------------
const VIP_RE = /\b(martin\s*vrijland|vrijland|m\.?\s*v(ri)?jland|m\/v|\bmv\b|owner\s+of\s+the\s+site)\b/i;
const POLITE_RE = /\b(please|thank\s*you|thanks|alstublieft|alsjeblieft|dank je|dankjewel|graag|gracias|danke)\b/i;
async function analyzeAndScore(text){
  let delta = 0, reason = null;
  try {
    const mod = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: text
    });
    const r = mod.results?.[0] || {};
    const cats = r.categories || {};
    // name rule only when abusive/violent/harassing
    if (VIP_RE.test(text) && (cats.harassment || cats.harassment_threats || cats.hate || cats.violence)) {
      return { delta: -500, reason: "Targeted abuse (name rule)" };
    }
    if (r.flagged) {
      delta -= 50;
      reason = "Inappropriate language";
    } else if (POLITE_RE.test(text)) {
      delta += 10;
      reason = "Polite communication";
    }
  } catch (e) {
    console.error("[Moderation]", e.message || e);
  }
  return { delta, reason };
}
// ------------- NPC (ChatGPT) with enhanced personality -------------
async function npcReply(npc, player, text){
  try{
    const personas = {
      Yara: "You are Yara, a friendly Amsterdam local who loves art and cycling. Reply in the user's language (Dutch/English/German). Be warm, brief (max 2 sentences), and occasionally mention local spots like Vondelpark.",
      Bram: "You are Bram, a pragmatic Amsterdammer who works in tech. Reply in the user's language. Be direct but friendly, brief (max 2 sentences).",
      Fatima: "You are Fatima, a warm cafe owner in Amsterdam. Reply in the user's language. Be welcoming and sometimes mention coffee or weather, brief (max 2 sentences).",
      Mehmet: "You are Mehmet, a thoughtful artist living in Amsterdam. Reply in the user's language. Be philosophical but concise (max 2 sentences).",
      Anne: "You are Anne, a cheerful student in Amsterdam who loves music. Reply in the user's language. Be enthusiastic but brief (max 2 sentences).",
      Jan: "You are Jan, a retired teacher in Amsterdam with dry humor. Reply in the user's language. Be witty but kind, brief (max 2 sentences)."
    };
    const persona = personas[npc.name] || `You are ${npc.name}, an Amsterdam local. Reply briefly in the user's language.`;
    npc.memory.push(`${player.username}: ${text}`);
    if (npc.memory.length > 8) npc.memory.shift();
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: persona },
        ...npc.memory.slice(-6).map(t => ({ role:"user", content: t })),
        { role: "user", content: `${player.username}: ${text}` }
      ],
      temperature: 0.7,
      max_tokens: 100
    });
    const content = resp.choices?.[0]?.message?.content?.trim() || "(...)";
    npc.memory.push(`${npc.name}: ${content}`);
    if (npc.memory.length > 8) npc.memory.shift();
    send(player.ws, {
      type: "chat",
      playerId: npc.id,
      username: npc.name,
      message: content,
      private: true,
      targetId: player.id
    });
  }catch(e){
    console.error("[NPC chat]", e.message || e);
    // Send fallback response
    send(player.ws, {
      type: "chat",
      playerId: npc.id,
      username: npc.name,
      message: "Interessant... vertel me meer.",
      private: true,
      targetId: player.id
    });
  }
}
// ------------- NPC Movement (Pathfinding) -------------
function updateNPCMovement() {
  npcs.forEach(npc => {
    // Every 10-30 seconds, pick a new target
    if (!npc.nextMoveTime || Date.now() > npc.nextMoveTime) {
      npc.targetX = (Math.random() - 0.5) * 80; // Stay within reasonable area
      npc.targetZ = (Math.random() - 0.5) * 80;
      npc.nextMoveTime = Date.now() + 10000 + Math.random() * 20000;
    }
    // Move towards target
    const dx = npc.targetX - npc.x;
    const dz = npc.targetZ - npc.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if (dist > 1) {
      const speed = 0.05 + Math.random() * 0.03; // Varied walking speed
      npc.x += (dx / dist) * speed;
      npc.z += (dz / dist) * speed;
    }
  });
  // Broadcast NPC positions
  broadcast({
    type: 'npc_update',
    npcs: npcs.map(n => ({ id: n.id, x: n.x, z: n.z }))
  });
}
setInterval(updateNPCMovement, 100);
// ------------- Weather System -------------
function updateWeather() {
  const weathers = ['clear', 'clear', 'clear', 'cloudy', 'rain', 'fog'];
  const newWeather = weathers[Math.floor(Math.random() * weathers.length)];
 
  weatherState.type = newWeather;
  weatherState.intensity = Math.random() * 0.5 + 0.5;
 
  console.log(`[Weather] Changed to ${newWeather} (intensity: ${weatherState.intensity.toFixed(2)})`);
 
  broadcast({
    type: 'weather_update',
    weather: weatherState.type,
    intensity: weatherState.intensity
  });
}
// Change weather every 5-15 minutes
setInterval(updateWeather, (300000 + Math.random() * 600000));
// ------------- Day/Night Cycle -------------
function updateDayNight() {
  weatherState.gameTime += 0.1; // Increment time
  if (weatherState.gameTime >= 24) weatherState.gameTime = 0;
 
  broadcast({
    type: 'time_update',
    gameTime: weatherState.gameTime
  });
}
setInterval(updateDayNight, 60000); // Update every minute
// ------------- WebSocket -------------
wss.on("connection", (ws, req)=>{
  let me = null;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[Connect] New connection from ${ip}`);
  ws.on("message", async raw=>{
    let data;
    try{ data = JSON.parse(raw); } catch { return; }
    if (data.type === "join"){
      const { playerId, username, x=0, z=0, avatar } = data;
      me = {
        id: playerId,
        username: (username||"Anon").slice(0,20),
        x, z,
        avatar: avatar || '🙂',
        ws,
        joinedAt: Date.now()
      };
      players.set(me.id, me);
      console.log(`[Join] ${me.username} (${me.id})`);
      // Send current state to new player
      send(ws, {
        type:"init",
        players: Array.from(players.values()).map(p=>({
          id:p.id,
          username:p.username,
          x:p.x,
          z:p.z,
          avatar:p.avatar
        })),
        npcs: npcs.map(n=>({ id:n.id, name:n.name, x:n.x, z:n.z })),
        weather: weatherState
      });
      // Announce join
      broadcast({
        type:"player_joined",
        player: {
          id: me.id,
          username: me.username,
          x: me.x,
          z: me.z,
          avatar: me.avatar
        }
      }, me.id);
    }
    else if (data.type === "move" && me){
      const newX = Number(data.x) || 0;
      const newZ = Number(data.z) || 0;
     
      // Anti-cheat: basic speed validation
      const dx = newX - me.x;
      const dz = newZ - me.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
     
      if (dist > 10) { // Too far, too fast
        console.warn(`[Cheat?] ${me.username} moved ${dist.toFixed(1)} units`);
        // Reset to last known position
        send(ws, { type: 'position_correction', x: me.x, z: me.z });
        return;
      }
      me.x = newX;
      me.z = newZ;
      broadcast({ type:"player_move", playerId: me.id, x: me.x, z: me.z }, me.id);
    }
    else if (data.type === "chat" && me){
      const text = String(data.message||"").trim().slice(0,400);
      if (!text) return;
      // Rate limiting: max 5 messages per 10 seconds
      if (!me.chatHistory) me.chatHistory = [];
      const now = Date.now();
      me.chatHistory = me.chatHistory.filter(t => now - t < 10000);
     
      if (me.chatHistory.length >= 5) {
        send(ws, {
          type: 'system',
          message: 'Te snel! Wacht even voor het volgende bericht.'
        });
        return;
      }
      me.chatHistory.push(now);
      // moderation / scoring
      const { delta, reason } = await analyzeAndScore(text);
      if (delta) send(ws, { type:"penalty", amount: delta, reason });
      // private or public?
      if (data.targetId){
        // target NPC?
        if (isNPC(data.targetId)){
          const npc = getNPC(data.targetId);
          send(ws, {
            type:"chat",
            playerId: me.id,
            username: me.username,
            message: text,
            private: true,
            targetId: npc.id
          });
          npcReply(npc, me, text);
        } else {
          // player -> player
          const other = players.get(data.targetId);
          if (other){
            send(other.ws, {
              type:"chat",
              playerId: me.id,
              username: me.username,
              message: text,
              private: true,
              targetId: other.id
            });
            send(ws, {
              type:"chat",
              playerId: me.id,
              username: me.username,
              message: text,
              private: true,
              targetId: other.id
            });
          }
        }
      } else {
        // public
        broadcast({
          type:"chat",
          playerId: me.id,
          username: me.username,
          message: text
        });
        send(ws, {
          type:"chat",
          playerId: me.id,
          username: me.username,
          message: text
        });
      }
    }
    else if (data.type === "report" && me){
      const reportedId = data.reportedId;
      const correct = players.has(reportedId);
      const reportedName = correct ?
        players.get(reportedId).username :
        (getNPC(reportedId)?.name || "unknown");
     
      console.log(`[Report] ${me.username} reported ${reportedName} (${correct ? 'correct' : 'wrong'})`);
     
      send(ws, { type: "report_result", correct, reportedName });
    }
    // Voice chat signaling (WebRTC)
    else if (data.type === "voice_offer" && me){
      const target = players.get(data.targetId);
      if (target) {
        send(target.ws, {
          type: "voice_offer",
          fromId: me.id,
          offer: data.offer
        });
      }
    }
    else if (data.type === "voice_answer" && me){
      const target = players.get(data.targetId);
      if (target) {
        send(target.ws, {
          type: "voice_answer",
          fromId: me.id,
          answer: data.answer
        });
      }
    }
    else if (data.type === "voice_ice" && me){
      const target = players.get(data.targetId);
      if (target) {
        send(target.ws, {
          type: "voice_ice",
          fromId: me.id,
          candidate: data.candidate
        });
      }
    }
    // Emotes
    else if (data.type === "emote" && me){
      broadcast({
        type: "emote",
        playerId: me.id,
        emote: data.emote // 'wave', 'point', 'thumbsup', 'thumbsdown'
      }, me.id);
    }
  });
  ws.on("close", ()=>{
    if (!me) return;
    console.log(`[Disconnect] ${me.username} (${me.id})`);
    players.delete(me.id);
    broadcast({ type:"player_left", playerId: me.id }, me.id);
  });
  ws.on("error", (err) => {
    console.error("[WS Error]", err.message);
  });
});
// Slow ambient NPC chatter
if (process.env.NPC_AMBIENT === "1"){
  setInterval(async ()=>{
    const npc = npcs[Math.floor(Math.random()*npcs.length)];
    const ambientLines = [
      "Mooi weer vandaag, hè?",
      "De grachten zijn zo rustig.",
      "Heb je de nieuwe expositie gezien?",
      "Typisch Amsterdam weer...",
      "Gezellig hier!",
      "Time for a coffee break.",
      "Beautiful city, isn't it?",
      "I love cycling around here."
    ];
   
    try{
      const r = await openai.chat.completions.create({
        model:"gpt-4o-mini",
        messages:[
          { role:"system", content:`You are ${npc.name}, an Amsterdam local. Say one short neutral line about the surroundings or weather. Max 10 words.` }
        ],
        max_tokens: 30,
        temperature: 0.7
      });
      const line = r.choices?.[0]?.message?.content?.trim() || ambientLines[Math.floor(Math.random()*ambientLines.length)];
      broadcast({ type:"chat", playerId: npc.id, username: npc.name, message: line });
    }catch{
      // Fallback to random line
      const line = ambientLines[Math.floor(Math.random()*ambientLines.length)];
      broadcast({ type:"chat", playerId: npc.id, username: npc.name, message: line });
    }
  }, 45000 + Math.floor(Math.random()*45000));
}
// Server stats logging
setInterval(() => {
  console.log(`[Stats] Players: ${players.size}, NPCs: ${npcs.length}, Weather: ${weatherState.type}, Time: ${weatherState.gameTime.toFixed(1)}h`);
}, 300000); // Every 5 minutes
server.listen(PORT, ()=> {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║ Social Credit Game - Enhanced Edition ║
║ Server running on port ${PORT} ║
║ Environment: ${process.env.NODE_ENV || 'development'} ║
╚══════════════════════════════════════════════════════════╝
  `);
});
// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] Closing server gracefully...');
  server.close(() => {
    console.log('[Shutdown] Server closed');
    process.exit(0);
  });
});
