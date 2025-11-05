// server.js – backend for Social Credit Simulation (Amsterdam Edition)
// --------------------------------------------------------------
// • Serves the high-render Three.js front-end in /public
// • Hosts a WebSocket server for player + NPC sync
// • Performs chat moderation via OpenAI’s moderation endpoint
// --------------------------------------------------------------

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';

// === Setup ====================================================
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'local_only_pw';
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- Admin endpoint (local convenience) ------------------------
app.post('/admin/set-key', (req, res) => {
  const { password, key } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Forbidden' });
  fs.writeFileSync('.env', `OPENAI_API_KEY=${key}\nADMIN_PASSWORD=${ADMIN_PASSWORD}\n`);
  res.json({ ok: true, message: 'Saved. Restart server to apply.' });
});

// --- Serve index.html ------------------------------------------
app.get('/', (_, res) => res.sendFile(path.join(process.cwd(), 'public/index.html')));

// === WebSocket setup ==========================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const players = new Map();
const npcs = [];

// --- NPC generation --------------------------------------------
function spawnNPCs() {
  const names = ['Anna', 'Bram', 'Kees', 'Fatima', 'Sven', 'Lotte', 'Yara', 'Mehmet'];
  for (let i = 0; i < names.length; i++) {
    npcs.push({
      id: `npc_${i}`,
      name: names[i],
      x: (Math.random() - 0.5) * 30,
      z: (Math.random() - 0.5) * 30,
      avatar: `avatar_${i % 4}.glb`,
      nextChat: Date.now() + 60000 + Math.random() * 120000
    });
  }
}
spawnNPCs();

// --- Broadcast helper ------------------------------------------
function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c !== exclude && c.readyState === 1) c.send(msg);
  });
}

// --- Moderation ------------------------------------------------
async function moderate(text) {
  if (!openai) return { flagged: false };
  try {
    const res = await openai.moderations.create({
      model: 'omni-moderation-latest',
      input: text
    });
    return res.results[0];
  } catch (e) {
    console.error('Moderation error:', e);
    return { flagged: false };
  }
}
const mentionsVrijland = t => /martin\s*v?rijland|m\s*vrijland|vrijland/i.test(t);

// --- Connection handler ----------------------------------------
wss.on('connection', ws => {
  let pid = null;

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case 'join':
        pid = data.playerId;
        players.set(pid, {
          id: pid,
          username: data.username,
          avatar: data.avatar,
          x: data.x, z: data.z,
          credits: 1000,
          ws
        });
        // Send current state
        ws.send(JSON.stringify({
          type: 'init',
          players: Array.from(players.values()).map(p => ({
            id: p.id, username: p.username, avatar: p.avatar, x: p.x, z: p.z
          })),
          npcs
        }));
        broadcast({ type: 'player_joined', player: data }, ws);
        break;

      case 'move':
        if (!players.has(pid)) break;
        const p = players.get(pid);
        p.x = data.x; p.z = data.z;
        broadcast({ type: 'player_move', playerId: pid, x: data.x, z: data.z }, ws);
        break;

      case 'chat':
        if (!players.has(pid)) break;
        const player = players.get(pid);
        const txt = data.message || '';
        const targetId = data.targetId || null;

        const mod = await moderate(txt);
        if (mod.flagged && mentionsVrijland(txt)) {
          player.credits -= 500;
          ws.send(JSON.stringify({ type: 'penalty', amount: -500, reason: 'Speaking negatively about Martin Vrijland' }));
        } else if (mod.flagged) {
          player.credits -= 50;
          ws.send(JSON.stringify({ type: 'penalty', amount: -50, reason: 'Inappropriate language' }));
        } else {
          player.credits += 10;
        }

        const payload = {
          type: 'chat',
          playerId: pid,
          username: player.username,
          message: txt,
          private: !!targetId,
          targetId
        };
        if (targetId && players.has(targetId)) {
          const target = players.get(targetId);
          target.ws.send(JSON.stringify(payload));
          ws.send(JSON.stringify(payload));
        } else {
          broadcast(payload);
        }
        break;

      case 'report':
        const reported = data.reportedId;
        const correct = players.has(reported);
        ws.send(JSON.stringify({
          type: 'report_result',
          correct,
          reportedId: reported,
          reportedName: correct
            ? players.get(reported).username
            : npcs.find(n => n.id === reported)?.name
        }));
        break;
    }
  });

  ws.on('close', () => {
    if (pid && players.has(pid)) {
      players.delete(pid);
      broadcast({ type: 'player_left', playerId: pid });
    }
  });
});

// --- NPC loop --------------------------------------------------
setInterval(() => {
  const now = Date.now();
  npcs.forEach(n => {
    if (now > n.nextChat) {
      n.nextChat = now + 60000 + Math.random() * 120000;
      const lines = [
        'Beautiful evening in Amsterdam!',
        'Have you been by the canal market?',
        'I love the lights reflecting on the water.',
        'The credits system keeps things peaceful.',
        'Let’s grab a virtual stroopwafel.'
      ];
      broadcast({ type: 'chat', playerId: n.id, username: n.name, message: lines[Math.floor(Math.random()*lines.length)], isNPC:true });
    }
  });
}, 5000);

server.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
