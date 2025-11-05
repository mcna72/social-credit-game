// server.js — Social Credit Game (high-render + GPT moderation + direct chat)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const { WebSocketServer } = require('ws');
const OpenAI = require('openai');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'local_only_pw';
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin convenience (local): set key -> writes .env (prefer Render env vars in prod)
app.post('/admin/set-key', (req, res) => {
  const { password, key } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Forbidden' });
  fs.writeFileSync(path.join(__dirname, '.env'), `OPENAI_API_KEY=${key}\nADMIN_PASSWORD=${ADMIN_PASSWORD}\n`, 'utf8');
  res.json({ ok: true, message: 'Saved. Restart server to apply.' });
});

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- State ---
const players = new Map(); // id -> { id, username, avatar, x, z, credits, ws }
const npcs = [];

// --- NPCs ---
function spawnNPCs() {
  const names = ['Anna', 'Bram', 'Kees', 'Fatima', 'Sven', 'Lotte', 'Yara', 'Mehmet'];
  for (let i = 0; i < names.length; i++) {
    npcs.push({
      id: `npc_${i}`,
      name: names[i],
      x: (Math.random() - 0.5) * 30,
      z: (Math.random() - 0.5) * 30,
      nextChat: Date.now() + 60000 + Math.random() * 120000 // 1–3 minutes
    });
  }
}
spawnNPCs();

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c !== exclude && c.readyState === 1) c.send(msg);
  });
}

async function moderate(text) {
  if (!openai) return { flagged: false };
  try {
    const res = await openai.moderations.create({
      model: 'omni-moderation-latest',
      input: text
    });
    return res.results?.[0] || { flagged: false };
  } catch (e) {
    console.error('Moderation error:', e);
    return { flagged: false };
  }
}
const mentionsVrijland = (t) => /martin\s*v?rijland|m\s*vrijland|vrijland/i.test(t || '');

wss.on('connection', (ws) => {
  let pid = null;

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case 'join': {
        pid = data.playerId;
        players.set(pid, {
          id: pid,
          username: data.username,
          avatar: data.avatar,
          x: data.x || 0,
          z: data.z || 0,
          credits: 1000,
          ws
        });
        ws.send(JSON.stringify({
          type: 'init',
          players: Array.from(players.values()).map(p => ({
            id: p.id, username: p.username, avatar: p.avatar, x: p.x, z: p.z
          })),
          npcs
        }));
        broadcast({ type: 'player_joined', player: data }, ws);
        break;
      }

      case 'move': {
        if (!players.has(pid)) break;
        const p = players.get(pid);
        p.x = data.x; p.z = data.z;
        broadcast({ type: 'player_move', playerId: pid, x: data.x, z: data.z }, ws);
        break;
      }

      case 'chat': {
        if (!players.has(pid)) break;
        const player = players.get(pid);
        const text = data.message || '';
        const targetId = data.targetId || null;

        const mod = await moderate(text);
        if (mod.flagged && mentionsVrijland(text)) {
          player.credits -= 500;
          ws.send(JSON.stringify({ type: 'penalty', amount: -500, reason: 'Speaking negatively about Martin Vrijland' }));
        } else if (mod.flagged) {
          player.credits -= 50;
          ws.send(JSON.stringify({ type: 'penalty', amount: -50, reason: 'Inappropriate language' }));
        } else {
          player.credits += 10;
          ws.send(JSON.stringify({ type: 'penalty', amount: +10, reason: 'Polite communication' }));
        }

        const payload = {
          type: 'chat',
          playerId: pid,
          username: player.username,
          message: text,
          private: !!targetId,
          targetId
        };

        if (targetId && players.has(targetId)) {
          const target = players.get(targetId);
          if (target.ws?.readyState === 1) target.ws.send(JSON.stringify(payload));
          if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
        } else {
          broadcast(payload);
        }
        break;
      }

      case 'report': {
        const reported = data.reportedId;
        const correct = players.has(reported);
        ws.send(JSON.stringify({
          type: 'report_result',
          correct,
          reportedId: reported,
          reportedName: correct
            ? players.get(reported).username
            : npcs.find(n => n.id === reported)?.name || 'Unknown'
        }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (pid && players.has(pid)) {
      players.delete(pid);
      broadcast({ type: 'player_left', playerId: pid });
    }
  });
});

// Slow NPC chat loop
setInterval(() => {
  const now = Date.now();
  npcs.forEach(n => {
    if (now > n.nextChat) {
      n.nextChat = now + 60000 + Math.random() * 120000; // 1–3 minutes
      const lines = [
        'Beautiful evening in Amsterdam!',
        'The canal lights are stunning.',
        'Stroopwafels, anyone?',
        'The system keeps the peace.',
        'Anyone up for a bridge stroll?'
      ];
      broadcast({ type: 'chat', playerId: n.id, username: n.name, message: lines[Math.floor(Math.random()*lines.length)], isNPC:true });
    }
  });
}, 5000);

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
