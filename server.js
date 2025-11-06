// ═══════════════════════════════════════════════════════════════════════════
// SOCIAL CREDIT GAME - ENHANCED SERVER
// Professional multiplayer server with advanced features
// ═══════════════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

// Configuration
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const NPC_AMBIENT = process.env.NPC_AMBIENT === '1';

const CONFIG = {
  CHAT_RATE_LIMIT: 5,
  CHAT_RATE_WINDOW: 10000,
  MAX_CHAT_LENGTH: 400,
  MAX_MOVE_DISTANCE: 10,
  NPC_UPDATE_INTERVAL: 100,
  NPC_THINK_INTERVAL: 5000,
  WEATHER_UPDATE_INTERVAL: 300000,
  MAZE_BOUNDS: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
};

// ═══════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const gameState = {
  players: new Map(),
  npcs: new Map(),
  chatHistory: [],
  weather: { type: 'clear', time: 12 },
  adminApiKey: null,
};

// Enhanced NPC personalities
const NPC_TEMPLATES = [
  {
    id: 'npc_yara',
    name: 'Yara',
    personality: 'Vriendelijke kunstenaar die graag praat over creativiteit en cultuur. Optimistisch en nieuwsgierig.',
    interests: ['kunst', 'muziek', 'cultuur', 'creativiteit'],
    x: -10,
    z: -10,
  },
  {
    id: 'npc_bram',
    name: 'Bram',
    personality: 'Tech-savvy developer die gepassioneerd is over programmeren en innovatie. Analytisch maar toegankelijk.',
    interests: ['technologie', 'programmeren', 'AI', 'gadgets'],
    x: 10,
    z: -10,
  },
  {
    id: 'npc_fatima',
    name: 'Fatima',
    personality: 'Wijze filosofe die diepgaande gesprekken waardeert. Bedachtzaam en empathisch.',
    interests: ['filosofie', 'ethiek', 'psychologie', 'literatuur'],
    x: -10,
    z: 10,
  },
  {
    id: 'npc_mehmet',
    name: 'Mehmet',
    personality: 'Energieke ondernemer met passie voor business en sport. Competitief maar eerlijk.',
    interests: ['business', 'sport', 'fitness', 'strategie'],
    x: 10,
    z: 10,
  },
  {
    id: 'npc_anne',
    name: 'Anne',
    personality: 'Zorgzame verpleegster die graag anderen helpt. Geduldig en warm.',
    interests: ['gezondheid', 'welzijn', 'natuur', 'koken'],
    x: 0,
    z: -15,
  },
  {
    id: 'npc_jan',
    name: 'Jan',
    personality: 'Stoere bouwvakker met gevoel voor humor. Praktisch en down-to-earth.',
    interests: ['vakmanschap', 'bouwen', 'voetbal', 'bier'],
    x: 0,
    z: 15,
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// SOCIAL CREDIT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

class SocialCreditSystem {
  static SCORES = {
    POLITE: 10,
    HELPFUL: 15,
    CREATIVE: 20,
    INAPPROPRIATE: -50,
    ABUSE: -500,
    CORRECT_REPORT: 50,
    WRONG_REPORT: -30,
    SPAM: -25,
  };

  static POLITE_WORDS = /\b(alstublieft|bedankt|dankjewel|dank je|graag gedaan|sorry|excuses|pardon|please|thank you|thanks|sorry)\b/i;
  static ABUSE_KEYWORDS = /\b(martin vrijland|martinvrijland|idioot|klootzak|kanker|kut|hoer|fascist|racist)\b/i;

  static calculateScore(text, context = {}) {
    let delta = 0;
    let reason = '';

    // Check for politeness
    if (this.POLITE_WORDS.test(text)) {
      delta += this.SCORES.POLITE;
      reason = 'Beleefde communicatie';
    }

    // Check for abuse
    if (this.ABUSE_KEYWORDS.test(text)) {
      delta += this.SCORES.ABUSE;
      reason = 'Ongepast taalgebruik';
    }

    // Check for spam (too many messages)
    if (context.isSpam) {
      delta += this.SCORES.SPAM;
      reason = 'Spam detectie';
    }

    return { delta, reason };
  }

  static async moderateWithOpenAI(text) {
    if (!OPENAI_API_KEY && !gameState.adminApiKey) {
      return { flagged: false, categories: {} };
    }

    try {
      const response = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gameState.adminApiKey || OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ input: text }),
      });

      const data = await response.json();
      return data.results[0];
    } catch (err) {
      console.error('Moderation error:', err);
      return { flagged: false, categories: {} };
    }
  }

  static handleReport(reporterId, targetId) {
    const reporter = gameState.players.get(reporterId);
    const target = gameState.players.get(targetId) || gameState.npcs.get(targetId);

    if (!reporter || !target) {
      return { success: false };
    }

    const isNPC = gameState.npcs.has(targetId);
    const correct = !isNPC; // Correct if reporting a real player

    const delta = correct ? this.SCORES.CORRECT_REPORT : this.SCORES.WRONG_REPORT;
    reporter.score += delta;

    return {
      success: true,
      correct: correct,
      delta: delta,
      targetName: target.name,
      targetType: isNPC ? 'NPC' : 'speler',
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NPC AI SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

class NPCManager {
  static initialize() {
    NPC_TEMPLATES.forEach(template => {
      const npc = {
        id: template.id,
        name: template.name,
        personality: template.personality,
        interests: template.interests,
        x: template.x,
        z: template.z,
        targetX: template.x,
        targetZ: template.z,
        memory: [],
        lastThink: Date.now(),
        lastMove: Date.now(),
        isMoving: false,
      };

      gameState.npcs.set(template.id, npc);
    });

    // Start NPC movement loop
    setInterval(() => this.updateNPCMovement(), CONFIG.NPC_UPDATE_INTERVAL);

    // Start NPC thinking loop
    if (NPC_AMBIENT) {
      setInterval(() => this.npcThink(), CONFIG.NPC_THINK_INTERVAL);
    }

    console.log(`✅ Initialized ${gameState.npcs.size} NPCs`);
  }

  static updateNPCMovement() {
    gameState.npcs.forEach(npc => {
      const dx = npc.targetX - npc.x;
      const dz = npc.targetZ - npc.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > 0.1) {
        const speed = 2.5 * (CONFIG.NPC_UPDATE_INTERVAL / 1000);
        const moveX = (dx / dist) * Math.min(speed, dist);
        const moveZ = (dz / dist) * Math.min(speed, dist);

        npc.x += moveX;
        npc.z += moveZ;
        npc.isMoving = true;

        // Broadcast update
        broadcast({
          type: 'npc_update',
          id: npc.id,
          x: Math.round(npc.x * 100) / 100,
          z: Math.round(npc.z * 100) / 100,
        });
      } else if (npc.isMoving) {
        npc.isMoving = false;
        // Pick new random target
        this.setRandomTarget(npc);
      }
    });
  }

  static setRandomTarget(npc) {
    const bounds = CONFIG.MAZE_BOUNDS;
    const margin = 10;

    npc.targetX = bounds.minX + margin + Math.random() * (bounds.maxX - bounds.minX - margin * 2);
    npc.targetZ = bounds.minZ + margin + Math.random() * (bounds.maxZ - bounds.minZ - margin * 2);
  }

  static async npcThink() {
    // Randomly select an NPC to speak
    const npcs = Array.from(gameState.npcs.values());
    if (npcs.length === 0) return;

    const npc = npcs[Math.floor(Math.random() * npcs.length)];
    const now = Date.now();

    // Don't speak too often
    if (now - npc.lastThink < CONFIG.NPC_THINK_INTERVAL) return;

    npc.lastThink = now;

    // Generate ambient chat
    const context = this.getAmbientContext();
    const message = await this.generateNPCResponse(npc, context, true);

    if (message) {
      broadcast({
        type: 'chat_message',
        from: npc.id,
        text: message,
        private: false,
      });
    }
  }

  static getAmbientContext() {
    const weather = gameState.weather;
    const playerCount = gameState.players.size;
    const time = weather.time;

    const contexts = [
      `Het is ${time}:00 uur en het weer is ${weather.type}.`,
      `Er zijn momenteel ${playerCount} spelers online.`,
      'De stad is rustig vandaag.',
      'Het doolhof is mysterieus.',
    ];

    return contexts[Math.floor(Math.random() * contexts.length)];
  }

  static async generateNPCResponse(npc, message, isAmbient = false) {
    if (!OPENAI_API_KEY && !gameState.adminApiKey) {
      // Fallback responses
      const fallbacks = [
        'Interessant!',
        'Daar moet ik even over nadenken.',
        'Ja, ik begrijp wat je bedoelt.',
        'Dat is een goed punt.',
      ];
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    try {
      const systemPrompt = isAmbient
        ? `Je bent ${npc.name}. ${npc.personality} Maak een korte observatie over de omgeving. Max 50 woorden. In het Nederlands.`
        : `Je bent ${npc.name}. ${npc.personality} Reageer natuurlijk op het bericht. Max 100 woorden. In het Nederlands of de taal van het bericht.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...npc.memory.slice(-5),
      ];

      if (!isAmbient) {
        messages.push({ role: 'user', content: message });
      } else {
        messages.push({ role: 'user', content: message });
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gameState.adminApiKey || OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: messages,
          max_tokens: 150,
          temperature: 0.8,
        }),
      });

      const data = await response.json();
      const reply = data.choices[0]?.message?.content || '';

      // Update memory
      npc.memory.push({ role: 'user', content: message });
      npc.memory.push({ role: 'assistant', content: reply });

      // Keep memory limited
      if (npc.memory.length > 20) {
        npc.memory = npc.memory.slice(-20);
      }

      return reply;
    } catch (err) {
      console.error('NPC response error:', err);
      return 'Sorry, ik kan nu niet reageren.';
    }
  }

  static async handleChatToNPC(npcId, message, senderId) {
    const npc = gameState.npcs.get(npcId);
    const player = gameState.players.get(senderId);

    if (!npc || !player) return;

    const response = await this.generateNPCResponse(npc, message, false);

    // Send back to player
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({
        type: 'chat_message',
        from: npcId,
        text: response,
        private: true,
      }));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAYER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

class PlayerManager {
  static addPlayer(ws, name) {
    const id = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const player = {
      id: id,
      name: name,
      x: Math.random() * 20 - 10,
      z: Math.random() * 20 - 10,
      score: 0,
      ws: ws,
      lastMove: Date.now(),
      chatTimes: [],
      reportsCorrect: 0,
      reportsWrong: 0,
    };

    gameState.players.set(id, player);
    ws.playerId = id;

    // Send init
    ws.send(JSON.stringify({
      type: 'init',
      id: id,
      name: name,
      x: player.x,
      z: player.z,
      score: player.score,
      players: Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        z: p.z,
      })),
      npcs: Array.from(gameState.npcs.values()).map(n => ({
        id: n.id,
        name: n.name,
        x: n.x,
        z: n.z,
      })),
    }));

    // Broadcast join
    broadcast({
      type: 'player_joined',
      id: id,
      name: name,
      x: player.x,
      z: player.z,
    }, id);

    this.broadcastStats();

    console.log(`✅ Player joined: ${name} (${id})`);
    return player;
  }

  static removePlayer(playerId) {
    const player = gameState.players.get(playerId);
    if (!player) return;

    gameState.players.delete(playerId);

    broadcast({
      type: 'player_left',
      id: playerId,
    });

    this.broadcastStats();

    console.log(`👋 Player left: ${player.name} (${playerId})`);
  }

  static handleMove(playerId, x, z) {
    const player = gameState.players.get(playerId);
    if (!player) return;

    // Anti-cheat: validate movement distance
    const dx = x - player.x;
    const dz = z - player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > CONFIG.MAX_MOVE_DISTANCE) {
      console.warn(`⚠️ Suspicious movement from ${player.name}: ${dist.toFixed(2)} units`);
      return;
    }

    // Validate bounds
    const bounds = CONFIG.MAZE_BOUNDS;
    x = Math.max(bounds.minX, Math.min(bounds.maxX, x));
    z = Math.max(bounds.minZ, Math.min(bounds.maxZ, z));

    player.x = x;
    player.z = z;
    player.lastMove = Date.now();

    // Broadcast movement
    broadcast({
      type: 'player_move',
      id: playerId,
      x: Math.round(x * 100) / 100,
      z: Math.round(z * 100) / 100,
    }, playerId);
  }

  static async handleChat(playerId, text, targetId) {
    const player = gameState.players.get(playerId);
    if (!player) return;

    // Rate limiting
    const now = Date.now();
    player.chatTimes = player.chatTimes.filter(t => now - t < CONFIG.CHAT_RATE_WINDOW);

    if (player.chatTimes.length >= CONFIG.CHAT_RATE_LIMIT) {
      player.ws.send(JSON.stringify({
        type: 'chat_message',
        from: 'system',
        text: '⚠️ Te veel berichten. Even wachten...',
        private: false,
      }));
      return;
    }

    player.chatTimes.push(now);

    // Validate length
    text = text.slice(0, CONFIG.MAX_CHAT_LENGTH);

    // Check moderation
    const moderation = await SocialCreditSystem.moderateWithOpenAI(text);
    const localScore = SocialCreditSystem.calculateScore(text, {
      isSpam: player.chatTimes.length === CONFIG.CHAT_RATE_LIMIT,
    });

    if (moderation.flagged || localScore.delta < 0) {
      player.score += localScore.delta;

      player.ws.send(JSON.stringify({
        type: 'score_update',
        score: player.score,
        delta: localScore.delta,
        reason: localScore.reason || 'Moderatie waarschuwing',
      }));
    } else if (localScore.delta > 0) {
      player.score += localScore.delta;

      player.ws.send(JSON.stringify({
        type: 'score_update',
        score: player.score,
        delta: localScore.delta,
        reason: localScore.reason,
      }));
    }

    // Handle NPC chat
    if (targetId && gameState.npcs.has(targetId)) {
      NPCManager.handleChatToNPC(targetId, text, playerId);
      return;
    }

    // Broadcast chat
    const isPrivate = !!targetId;

    if (isPrivate) {
      const target = gameState.players.get(targetId);
      if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({
          type: 'chat_message',
          from: playerId,
          text: text,
          private: true,
        }));
      }

      // Echo back to sender
      player.ws.send(JSON.stringify({
        type: 'chat_message',
        from: playerId,
        text: text,
        private: true,
      }));
    } else {
      broadcast({
        type: 'chat_message',
        from: playerId,
        text: text,
        private: false,
      });
    }
  }

  static handleReport(playerId, targetId) {
    const result = SocialCreditSystem.handleReport(playerId, targetId);

    if (!result.success) return;

    const player = gameState.players.get(playerId);
    if (!player) return;

    if (result.correct) {
      player.reportsCorrect++;
    } else {
      player.reportsWrong++;
    }

    player.ws.send(JSON.stringify({
      type: 'report_result',
      correct: result.correct,
      delta: result.delta,
      target: result.targetName,
      type: result.targetType,
    }));

    player.ws.send(JSON.stringify({
      type: 'score_update',
      score: player.score,
      delta: result.delta,
      reason: result.correct ? 'Correct rapport' : 'Fout rapport',
    }));
  }

  static broadcastStats() {
    broadcast({
      type: 'stats',
      playerCount: gameState.players.size,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEATHER SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

class WeatherSystem {
  static types = ['clear', 'cloudy', 'rain', 'fog'];

  static initialize() {
    this.updateWeather();
    setInterval(() => this.updateWeather(), CONFIG.WEATHER_UPDATE_INTERVAL);
  }

  static updateWeather() {
    gameState.weather.type = this.types[Math.floor(Math.random() * this.types.length)];
    gameState.weather.time = Math.floor(Math.random() * 24);

    broadcast({
      type: 'weather_update',
      weather: gameState.weather.type,
      time: gameState.weather.time,
    });

    console.log(`🌤️ Weather updated: ${gameState.weather.type} at ${gameState.weather.time}:00`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function broadcast(message, excludeId = null) {
  const data = JSON.stringify(message);

  gameState.players.forEach((player, id) => {
    if (id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER SETUP
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin endpoint
app.post('/admin/set-api-key', (req, res) => {
  const { password, apiKey } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  gameState.adminApiKey = apiKey;
  res.json({ success: true, message: 'API key updated' });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('🔌 New connection');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'join':
          PlayerManager.addPlayer(ws, msg.name || 'Player');
          break;

        case 'move':
          if (ws.playerId) {
            PlayerManager.handleMove(ws.playerId, msg.x, msg.z);
          }
          break;

        case 'chat':
          if (ws.playerId) {
            PlayerManager.handleChat(ws.playerId, msg.text, msg.target);
          }
          break;

        case 'report':
          if (ws.playerId) {
            PlayerManager.handleReport(ws.playerId, msg.targetId);
          }
          break;
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  ws.on('close', () => {
    if (ws.playerId) {
      PlayerManager.removePlayer(ws.playerId);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// Initialize systems
NPCManager.initialize();
WeatherSystem.initialize();

// Start server
server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🎮 SOCIAL CREDIT GAME - ENHANCED SERVER');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 NPCs initialized: ${gameState.npcs.size}`);
  console.log(`🌤️ Weather system: ${gameState.weather.type}`);
  console.log(`🔑 OpenAI API: ${OPENAI_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`🎙️ NPC ambient chat: ${NPC_AMBIENT ? 'Enabled' : 'Disabled'}`);
  console.log('═══════════════════════════════════════════════════════════');
});
