// server.js
// Main server: serves client, admin form, websockets, NPCs, and moderation hooks.
// IMPORTANT: Keep your OPENAI_API_KEY in environment variables, not in code.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { OpenAIApi, Configuration } = require('openai');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme_local_only';

// Setup OpenAI client if key exists
let openai = null;
if (process.env.OPENAI_API_KEY) {
  const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
  openai = new OpenAIApi(configuration);
} else {
  console.warn('OPENAI_API_KEY not set. Moderation disabled until you set it.');
}

// Express app to serve files and admin endpoint
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '/')));

// Admin page (simple form)
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Endpoint to set API key (writes to .env). PROTECT this route in production!
app.post('/admin/set-key', (req, res) => {
  const { password, key } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  // Write to .env (local convenience). In production prefer Render/GitHub env vars.
  const content = `OPENAI_API_KEY=${key}\nADMIN_PASSWORD=${ADMIN_PASSWORD}\n`;
  fs.writeFileSync(path.join(__dirname, '.env'), content, { encoding: 'utf8' });
  res.json({ ok: true, message: 'Key saved. Restart server to apply.' });
});

// Fallback serving index.html
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Game state
const players = new Map(); // playerId -> { id, username, avatar, x, z, credits, ws }
const npcs = [];

// Create NPCs
function generateNPCs() {
  const avatarOptions = ['👨', '👩', '🧑', '👴', '👵', '👦', '👧', '🧔', '👱‍♀️', '👱‍♂️'];
  const names = ['Chen_Wei', 'Liu_Fang', 'Wang_Ming', 'Zhang_Li', 'Zhao_Yun', 'Wu_Jing', 'Zhou_Hua', 'Xu_Mei'];
  for (let i = 0; i < names.length; i++) {
    const npc = {
      id: `npc_${i}`,
      name: names[i],
      avatar: avatarOptions[Math.floor(Math.random() * avatarOptions.length)],
      x: (Math.random() - 0.5) * 30,
      z: (Math.random() - 0.5) * 30,
      isNPC: true,
      nextChatTimeout: null
    };
    npcs.push(npc);
  }
}
generateNPCs();

// Broadcast helper
function broadcast(data, excludeWs = null) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Schedule NPC chats (very slow, configurable)
function scheduleNpcChat(npc) {
  // much slower: each NPC speaks between 60 and 180 seconds (configurable)
  const minMs = 60 * 1000;   // 60s
  const maxMs = 180 * 1000;  // 180s
  const delay = minMs + Math.random() * (maxMs - minMs);

  npc.nextChatTimeout = setTimeout(() => {
    const messages = [
      'Hello everyone!',
      'Nice weather today.',
      'How is everyone doing?',
      'This place looks great.',
      'Anyone want to chat?',
      'The system works perfectly.',
      'Credits are important!',
      'Following the rules is best.'
    ];
    const message = messages[Math.floor(Math.random() * messages.length)];
    broadcast({
      type: 'chat',
      playerId: npc.id,
      username: npc.name,
      message: message,
      isNPC: true
    });

    scheduleNpcChat(npc);
  }, delay);
}

// Start scheduling for all NPCs
npcs.forEach(npc => scheduleNpcChat(npc));

// Simple moderation helper using OpenAI Moderation endpoint
async function moderateMessage(text) {
  if (!openai) {
    return { flagged: false, categories: {} };
  }
  try {
    // This uses the moderation endpoint. The exact return shape may vary by SDK version.
    const response = await openai.createModeration({ model: 'omni-moderation-latest', input: text });
    const result = response.data.results?.[0] || {};
    return {
      flagged: !!result.flagged,
      categories: result.categories || {},
      category_scores: result.category_scores || {}
    };
  } catch (e) {
    console.error('Moderation error:', e);
    return { flagged: false, categories: {} };
  }
}

// Helper: check if text mentions Martin Vrijland (approx matches)
function mentionsVrijland(text) {
  return /martin\s*v?rijland|m\s*vrijland|vrijland/i.test(text);
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw);

      switch (data.type) {
        case 'join':
          playerId = data.playerId;
          players.set(playerId, {
            id: playerId,
            username: data.username,
            avatar: data.avatar,
            x: data.x || 0,
            z: data.z || 0,
            credits: 1000,
            ws
          });

          // Send init with all players + npcs
          ws.send(JSON.stringify({
            type: 'init',
            players: Array.from(players.values()).map(p => ({
              id: p.id, username: p.username, avatar: p.avatar, x: p.x, z: p.z
            })),
            npcs: npcs.map(n => ({ id: n.id, name: n.name, avatar: n.avatar, x: n.x, z: n.z }))
          }));

          // Notify others
          broadcast({ type: 'player_joined', player: { id: playerId, username: data.username, avatar: data.avatar, x: data.x, z: data.z } }, ws);
          break;

        case 'move':
          if (!playerId) break;
          if (players.has(playerId)) {
            const p = players.get(playerId);
            p.x = data.x; p.z = data.z;
            broadcast({ type: 'player_move', playerId, x: p.x, z: p.z }, ws);
          }
          break;

        case 'chat':
          if (!playerId) break;
          if (!players.has(playerId)) break;
          const player = players.get(playerId);

          // If targetId is present, it's a private message
          const targetId = data.targetId || null;
          const text = data.message || '';

          // First, moderate the message server-side (semantic)
          const mod = await moderateMessage(text);

          // If message mentions "Martin Vrijland" and is flagged as toxic -> heavy penalty
          if (mentionsVrijland(text) && mod.flagged) {
            player.credits -= 500;
            try {
              player.ws.send(JSON.stringify({ type: 'penalty', amount: -500, reason: 'Speaking negatively about Martin Vrijland' }));
            } catch (e) {}
          } else if (mod.flagged) {
            // Generic flagged content
            player.credits -= 50;
            try {
              player.ws.send(JSON.stringify({ type: 'penalty', amount: -50, reason: 'Inappropriate language (moderation)' }));
            } catch (e) {}
          } else {
            // polite message gives +10
            player.credits += 10;
          }

          // Deliver message: private or public
          const chatPayload = {
            type: 'chat',
            playerId: player.id,
            username: player.username,
            message: text,
            private: !!targetId,
            targetId: targetId || null
          };

          if (targetId && players.has(targetId)) {
            // send only to target and sender
            const target = players.get(targetId);
            if (target.ws && target.ws.readyState === WebSocket.OPEN) target.ws.send(JSON.stringify(chatPayload));
            if (player.ws && player.ws.readyState === WebSocket.OPEN) player.ws.send(JSON.stringify(chatPayload));
          } else {
            // broadcast publicly
            broadcast(chatPayload);
          }
          break;

        case 'report':
          // Example: evaluate report; reward/deduct accordingly
          const reportedId = data.reportedId;
          const isRealPlayer = players.has(reportedId);
          ws.send(JSON.stringify({
            type: 'report_result',
            correct: isRealPlayer,
            reportedId,
            reportedName: isRealPlayer ? players.get(reportedId).username : (npcs.find(n => n.id === reportedId)?.name || 'Unknown')
          }));
          break;
      }
    } catch (err) {
      console.error('Error parsing message', err);
    }
  });

  ws.on('close', () => {
    if (playerId && players.has(playerId)) {
      players.delete(playerId);
      broadcast({ type: 'player_left', playerId });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (port ${PORT})`);
});
