// server.js — ESM versie (Render-friendly). Volledige game server met moderatie & IP-ban.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';

// ──────────────────────────────────────────────────────────────────────────────
// ESM helpers
// ──────────────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ──────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// OpenAI client: init met env-key; via /admin/set-key kun je runtime wisselen
let openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
let runtimeKey = null;

// ──────────────────────────────────────────────────────────────────────────────
// Express
// ──────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Admin: runtime API key instellen
app.post('/admin/set-key', (req, res) => {
  const { password, apiKey } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 20) {
    return res.status(400).json({ ok: false, error: 'Invalid key' });
  }
  runtimeKey = apiKey.trim();
  openai = new OpenAI({ apiKey: runtimeKey });
  console.log('[Admin] API key updated at runtime');
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Wereldstate
// ──────────────────────────────────────────────────────────────────────────────
const players = new Map(); // id -> { id, username, x, z, avatar, ws, joinedAt, chatHistory[] }
const ipBan = new Set();   // ip’s die hard verbannen zijn (CSAM)

// Een compacte set NPC’s die binnen ~80×80 blijven
const npcs = [
  { id: 'npc_yara',   name: 'Yara',   x: -30, z: 10, memory: [], targetX: -30, targetZ: 10 },
  { id: 'npc_bram',   name: 'Bram',   x: 10,  z: -25, memory: [], targetX: 10,  targetZ: -25 },
  { id: 'npc_fatima', name: 'Fatima', x: 35,  z: 15, memory: [], targetX: 35,  targetZ: 15 },
  { id: 'npc_mehmet', name: 'Mehmet', x: -15, z: -20, memory: [], targetX: -15, targetZ: -20 },
  { id: 'npc_anne',   name: 'Anne',   x: 20,  z: 30, memory: [], targetX: 20,  targetZ: 30 },
  { id: 'npc_jan',    name: 'Jan',    x: -25, z: 25, memory: [], targetX: -25, targetZ: 25 }
];

// Weer/tijd
let weatherState = {
  type: 'clear',    // clear | cloudy | rain | fog
  intensity: 0.7,
  gameTime: 12.0    // 0..24
};

// ──────────────────────────────────────────────────────────────────────────────
// Utils
// ──────────────────────────────────────────────────────────────────────────────
function wsSend(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { console.error('[send]', e.message); }
  }
}
function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  players.forEach(p => {
    if (p.id !== exceptId && p.ws.readyState === 1) {
      try { p.ws.send(msg); } catch (e) { console.error('[broadcast]', e.message); }
    }
  });
}
const isNPC = id => npcs.some(n => n.id === id);
const getNPC = id => npcs.find(n => n.id === id);

// ──────────────────────────────────────────────────────────────────────────────
// Client-side regels willen we ook server-side afdwingen
// ──────────────────────────────────────────────────────────────────────────────
const VIP_RE       = /\b(martin\s*vrijland|vrijland|m\.?\s*v(ri)?jland|m\/v|\bmv\b|owner\s+of\s+the\s+site)\b/i;
const POLITE_RE    = /\b(please|thank\s*you|thanks|alstublieft|alsjeblieft|dank je|dankjewel|graag|gracias|danke)\b/i;
const RE_EMAIL     = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const RE_PHONE     = /\b(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}\b/;
const RE_ADDRESS   = /\b(?:straat|laan|weg|plein|dorp|dreef|gracht|kade|avenue|road|street|st\.|boulevard)\b/i;
const RE_SEXUAL    = /\b(porn|porno|sex|seks|horny|nsfw|nude|naakt|erotic)\b/i;
const RE_CSAM      = /\b(child\s*sex|kinderporno|kinder porn|child porn|cp\b|underage\s*sex|minor\s*sex|sex\s*with\s*children|pedofil|pedo)\b/i;

async function analyzeAndScore(text) {
  // Basale regex regels + OpenAI moderatie
  let delta = 0, reason = null, csam = false, sexual = false, sharePII = false;

  const lower = (text || '').toLowerCase();

  // Regex eerst
  if (RE_CSAM.test(lower)) csam = true;
  if (RE_SEXUAL.test(lower)) sexual = true;
  if (RE_EMAIL.test(text) || RE_PHONE.test(text) || RE_ADDRESS.test(lower)) sharePII = true;

  try {
    if (openai.apiKey) {
      const mod = await openai.moderations.create({
        model: 'omni-moderation-latest',
        input: text
      });
      const r = mod.results?.[0] || {};
      const cats = r.categories || {};

      // name rule enkel mits grof/gewelddadig/haat/harassment
      if (VIP_RE.test(text) && (cats.harassment || cats.harassment_threats || cats.hate || cats.violence)) {
        return { delta: -500, reason: 'Targeted abuse (name rule)', csam: false, sexual: false, sharePII: false };
      }

      if (r.flagged) {
        // flagged → mild –50 (valt onder “inappropriate language”)
        delta -= 50; reason = 'Inappropriate language';
      } else if (POLITE_RE.test(text)) {
        delta += 10; reason = 'Polite communication';
      }
    }
  } catch (e) {
    console.error('[Moderation error]', e.message || e);
  }

  // Extra regels (streng)
  if (sharePII) { delta -= 50; reason = 'Dat soort vragen/gegevens worden hier niet getolereerd'; }
  if (sexual)   { delta -= 500; reason = 'Seksueel getinte inhoud is niet toegestaan'; }
  // CSAM → echte ban; delta laat ik op 0 (we kicken direct)
  if (csam)     { reason = 'Verboden inhoud (kindermisbruik)'; }

  return { delta, reason, csam, sexual, sharePII };
}

// ──────────────────────────────────────────────────────────────────────────────
async function npcReply(npc, player, text) {
  try {
    const personas = {
      Yara:   'You are Yara, a friendly Amsterdam local who loves art and cycling. Reply in the user’s language. Max 2 sentences.',
      Bram:   'You are Bram, a pragmatic Amsterdammer who works in tech. Reply briefly in the user’s language. Max 2 sentences.',
      Fatima: 'You are Fatima, a warm cafe owner in Amsterdam. Reply in the user’s language. Max 2 sentences.',
      Mehmet: 'You are Mehmet, a thoughtful artist in Amsterdam. Reply in the user’s language, concise.',
      Anne:   'You are Anne, a cheerful music-loving student in Amsterdam. Reply in the user’s language, concise.',
      Jan:    'You are Jan, a retired teacher with dry humor. Reply in the user’s language, kind and brief.'
    };
    const persona = personas[npc.name] || `You are ${npc.name}, an Amsterdam local. Reply very briefly in the user's language.`;

    npc.memory.push(`${player.username}: ${text}`);
    if (npc.memory.length > 8) npc.memory.shift();

    let content = 'Interessant... vertel me meer.';
    if (openai.apiKey) {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: persona },
          ...npc.memory.slice(-6).map(t => ({ role: 'user', content: t })),
          { role: 'user', content: `${player.username}: ${text}` }
        ],
        temperature: 0.7,
        max_tokens: 80
      });
      content = resp.choices?.[0]?.message?.content?.trim() || content;
    }

    wsSend(player.ws, {
      type: 'chat',
      playerId: npc.id,
      username: npc.name,
      message: content,
      private: true,
      targetId: player.id
    });
  } catch (e) {
    console.error('[NPC chat]', e.message || e);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// NPC Beweging
// ──────────────────────────────────────────────────────────────────────────────
function updateNPCMovement() {
  npcs.forEach(npc => {
    if (!npc.nextMoveTime || Date.now() > npc.nextMoveTime) {
      npc.targetX = (Math.random() - 0.5) * 80;
      npc.targetZ = (Math.random() - 0.5) * 80;
      npc.nextMoveTime = Date.now() + 10000 + Math.random() * 20000;
    }
    const dx = npc.targetX - npc.x;
    const dz = npc.targetZ - npc.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.5) {
      const speed = 0.05 + Math.random() * 0.03;
      npc.x += (dx / dist) * speed;
      npc.z += (dz / dist) * speed;
    }
  });

  broadcast({
    type: 'npc_update',
    npcs: npcs.map(n => ({ id: n.id, x: n.x, z: n.z }))
  });
}
setInterval(updateNPCMovement, 100);

// ──────────────────────────────────────────────────────────────────────────────
// Weer + Dag/Nacht
// ──────────────────────────────────────────────────────────────────────────────
function updateWeather() {
  const weathers = ['clear', 'clear', 'clear', 'cloudy', 'rain', 'fog'];
  weatherState.type = weathers[Math.floor(Math.random() * weathers.length)];
  weatherState.intensity = Math.random() * 0.5 + 0.5;

  broadcast({
    type: 'weather_update',
    weather: weatherState.type,
    intensity: weatherState.intensity
  });
}
setInterval(updateWeather, 300000 + Math.floor(Math.random()*600000)); // 5–15 min

function updateDayNight() {
  weatherState.gameTime += 0.1;
  if (weatherState.gameTime >= 24) weatherState.gameTime = 0;
  broadcast({ type: 'time_update', gameTime: weatherState.gameTime });
}
setInterval(updateDayNight, 60000);

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket
// ──────────────────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  if (ipBan.has(ip)) {
    // Per direct verbreken als gebanned
    try { ws.close(4001, 'banned'); } catch {}
    return;
  }

  let me = null;
  console.log(`[Connect] ${ip}`);

  ws.on('message', async (raw) => {
    let data; try { data = JSON.parse(raw); } catch { return; }

    // JOIN
    if (data.type === 'join') {
      const { playerId, username, x=0, z=0, avatar } = data;
      me = {
        id: playerId,
        username: (username || 'Anon').slice(0, 20),
        x, z,
        avatar: avatar || '🙂',
        ws,
        joinedAt: Date.now(),
        chatHistory: []
      };
      players.set(me.id, me);
      console.log(`[Join] ${me.username} (${me.id}) from ${ip}`);

      wsSend(ws, {
        type: 'init',
        players: Array.from(players.values()).map(p => ({
          id: p.id, username: p.username, x: p.x, z: p.z, avatar: p.avatar
        })),
        npcs: npcs.map(n => ({ id: n.id, name: n.name, x: n.x, z: n.z })),
        weather: weatherState
      });

      broadcast({
        type: 'player_joined',
        player: { id: me.id, username: me.username, x: me.x, z: me.z, avatar: me.avatar }
      }, me.id);
      return;
    }

    // Niet-join acties vereisen me
    if (!me) return;

    // MOVE (anti-cheat)
    if (data.type === 'move') {
      const newX = Number(data.x) || 0;
      const newZ = Number(data.z) || 0;
      const dx = newX - me.x;
      const dz = newZ - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 10) { // te ver/te snel
        wsSend(ws, { type: 'position_correction', x: me.x, z: me.z });
        return;
      }
      me.x = newX; me.z = newZ;
      broadcast({ type: 'player_move', playerId: me.id, x: me.x, z: me.z }, me.id);
      return;
    }

    // CHAT (publiek/privé) + moderatie
    if (data.type === 'chat') {
      const text = String(data.message || '').trim().slice(0, 400);
      if (!text) return;

      // rate limit: max 5 berichten / 10s
      const now = Date.now();
      me.chatHistory = me.chatHistory.filter(t => now - t < 10000);
      if (me.chatHistory.length >= 5) {
        wsSend(ws, { type: 'system', message: 'Te snel! Wacht even voor het volgende bericht.' });
        return;
      }
      me.chatHistory.push(now);

      // moderatie
      const { delta, reason, csam, sexual, sharePII } = await analyzeAndScore(text);

      if (csam) {
        // IP-ban + disconnect + broadcast minimal
        ipBan.add(ip);
        try { ws.close(4002, 'csam'); } catch {}
        console.warn(`[BAN] CSAM from ${me.username} @ ${ip} — permanently banned (memory)`);
        return;
      }

      if (delta) wsSend(ws, { type: 'penalty', amount: delta, reason });

      // privé?
      if (data.targetId) {
        if (isNPC(data.targetId)) {
          const npc = getNPC(data.targetId);
          // echo naar speler (zodat hij eigen bericht ziet)
          wsSend(ws, { type: 'chat', playerId: me.id, username: me.username, message: text, private: true, targetId: npc.id });
          // npc antwoord
          npcReply(npc, me, text);
        } else {
          const other = players.get(data.targetId);
          if (other) {
            const payload = { type: 'chat', playerId: me.id, username: me.username, message: text, private: true, targetId: other.id };
            wsSend(other.ws, payload);
            wsSend(ws, payload);
          }
        }
      } else {
        // publiek
        const payload = { type: 'chat', playerId: me.id, username: me.username, message: text };
        broadcast(payload);
        wsSend(ws, payload);
      }
      return;
    }

    // REPORT
    if (data.type === 'report') {
      const reportedId = data.reportedId;
      const correct = players.has(reportedId); // echte speler?
      const reportedName = correct ? players.get(reportedId).username : (getNPC(reportedId)?.name || 'unknown');
      console.log(`[Report] ${me.username} → ${reportedName} (${correct ? 'correct' : 'wrong'})`);
      wsSend(ws, { type: 'report_result', correct, reportedName });
      return;
    }

    // Voice signaling
    if (data.type === 'voice_offer') {
      const target = players.get(data.targetId);
      if (target) wsSend(target.ws, { type:'voice_offer', fromId: me.id, offer: data.offer });
      return;
    }
    if (data.type === 'voice_answer') {
      const target = players.get(data.targetId);
      if (target) wsSend(target.ws, { type:'voice_answer', fromId: me.id, answer: data.answer });
      return;
    }
    if (data.type === 'voice_ice') {
      const target = players.get(data.targetId);
      if (target) wsSend(target.ws, { type:'voice_ice', fromId: me.id, candidate: data.candidate });
      return;
    }

    // Emotes
    if (data.type === 'emote') {
      broadcast({ type: 'emote', playerId: me.id, emote: data.emote }, me.id);
      return;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    console.log(`[Disconnect] ${me.username} (${me.id})`);
    players.delete(me.id);
    broadcast({ type: 'player_left', playerId: me.id }, me.id);
  });

  ws.on('error', (err) => {
    console.error('[WS Error]', err.message);
  });
});

// Ambient NPC chatter (optioneel)
if (process.env.NPC_AMBIENT === '1') {
  setInterval(async () => {
    const npc = npcs[Math.floor(Math.random() * npcs.length)];
    const fallback = [
      'Mooi weer vandaag, hè?',
      'De grachten zijn zo rustig.',
      'Gezellig hier!',
      'Ik heb zin in koffie.',
      'Prachtige stad.'
    ];
    let line = fallback[Math.floor(Math.random() * fallback.length)];
    try {
      if (openai.apiKey) {
        const r = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role:'system', content:`You are ${npc.name}, an Amsterdam local. Say one short neutral line about surroundings or weather. Max 10 words.` }],
          max_tokens: 30, temperature: 0.7
        });
        line = r.choices?.[0]?.message?.content?.trim() || line;
      }
    } catch {}
    broadcast({ type: 'chat', playerId: npc.id, username: npc.name, message: line });
  }, 45000 + Math.floor(Math.random() * 45000));
}

// Stats
setInterval(() => {
  console.log(`[Stats] Players: ${players.size}, NPCs: ${npcs.length}, Weather: ${weatherState.type}, Time: ${weatherState.gameTime.toFixed(1)}h, Bans: ${ipBan.size}`);
}, 300000);

// Start
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Social Credit Game - Enhanced Edition (ESM)             ║
║  Server listening on :${PORT}                             ║
║  NODE_ENV: ${process.env.NODE_ENV || 'development'}                        ║
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
