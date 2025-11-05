// server.js - WebSocket server for multiplayer Social Credit Game
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080; // Use Render's PORT or fallback to 8080

// Create HTTP server to serve the game file
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading game');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected players
const players = new Map();
const npcs = [];

// Generate NPCs
function generateNPCs() {
    const avatarOptions = ['👨', '👩', '🧑', '👴', '👵', '👦', '👧', '🧔', '👱‍♀️', '👱‍♂️'];
    const names = ['Alex_Murphy', 'Sarah_Chen', 'Mohammed_Ali', 'Emma_Johnson', 'Carlos_Garcia', 'Yuki_Tanaka', 'Olga_Ivanova', 'James_Smith'];
    
    for (let i = 0; i < 8; i++) {
        npcs.push({
            id: `npc_${i}`,
            name: names[i],
            avatar: avatarOptions[Math.floor(Math.random() * avatarOptions.length)],
            x: (Math.random() - 0.5) * 30,
            z: (Math.random() - 0.5) * 30,
            isNPC: true,
            velocityX: 0,
            velocityZ: 0
        });
    }
}

generateNPCs();

// NPC movement and chat
setInterval(() => {
    npcs.forEach(npc => {
        // Random movement
        if (Math.random() < 0.1) {
            npc.velocityX = (Math.random() - 0.5) * 0.05;
            npc.velocityZ = (Math.random() - 0.5) * 0.05;
        }
        
        npc.x += npc.velocityX;
        npc.z += npc.velocityZ;
        
        // Keep in bounds
        npc.x = Math.max(-20, Math.min(20, npc.x));
        npc.z = Math.max(-20, Math.min(20, npc.z));
        
        // Random chat
        if (Math.random() < 0.01) {
            const messages = [
                'Hello everyone!',
                'Nice weather today.',
                'How is everyone doing?',
                'This place looks great.',
                'Anyone want to chat?',
                'The system works perfectly.',
                'I love following the rules.',
                'Credits are important!'
            ];
            const message = messages[Math.floor(Math.random() * messages.length)];
            
            // Broadcast NPC message
            broadcast({
                type: 'chat',
                playerId: npc.id,
                username: npc.name,
                message: message,
                isNPC: true
            });
        }
    });
    
    // Broadcast NPC positions
    broadcast({
        type: 'npc_update',
        npcs: npcs.map(npc => ({
            id: npc.id,
            name: npc.name,
            avatar: npc.avatar,
            x: npc.x,
            z: npc.z
        }))
    });
}, 100);

function broadcast(data, exclude = null) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    let playerId = null;
    
    console.log('New client connected');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'join':
                    playerId = data.playerId;
                    players.set(playerId, {
                        id: playerId,
                        username: data.username,
                        avatar: data.avatar,
                        x: data.x,
                        z: data.z,
                        credits: 1000,
                        ws: ws
                    });
                    
                    // Send current state to new player
                    ws.send(JSON.stringify({
                        type: 'init',
                        players: Array.from(players.values()).map(p => ({
                            id: p.id,
                            username: p.username,
                            avatar: p.avatar,
                            x: p.x,
                            z: p.z
                        })),
                        npcs: npcs.map(npc => ({
                            id: npc.id,
                            name: npc.name,
                            avatar: npc.avatar,
                            x: npc.x,
                            z: npc.z
                        }))
                    }));
                    
                    // Notify others
                    broadcast({
                        type: 'player_joined',
                        player: {
                            id: playerId,
                            username: data.username,
                            avatar: data.avatar,
                            x: data.x,
                            z: data.z
                        }
                    }, ws);
                    
                    console.log(`Player joined: ${data.username} (${playerId})`);
                    break;
                    
                case 'move':
                    if (players.has(playerId)) {
                        const player = players.get(playerId);
                        player.x = data.x;
                        player.z = data.z;
                        
                        // Broadcast movement
                        broadcast({
                            type: 'player_move',
                            playerId: playerId,
                            x: data.x,
                            z: data.z
                        }, ws);
                    }
                    break;
                    
                case 'chat':
                    if (players.has(playerId)) {
                        const player = players.get(playerId);
                        
                        // Broadcast chat message
                        broadcast({
                            type: 'chat',
                            playerId: playerId,
                            username: player.username,
                            message: data.message,
                            isNPC: false
                        });
                    }
                    break;
                    
                case 'report':
                    // Check if reported entity is real player or NPC
                    const isRealPlayer = players.has(data.reportedId);
                    const isCorrect = isRealPlayer;
                    
                    ws.send(JSON.stringify({
                        type: 'report_result',
                        correct: isCorrect,
                        reportedId: data.reportedId,
                        reportedName: isRealPlayer ? 
                            players.get(data.reportedId).username : 
                            npcs.find(npc => npc.id === data.reportedId)?.name
                    }));
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
    
    ws.on('close', () => {
        if (playerId && players.has(playerId)) {
            const player = players.get(playerId);
            console.log(`Player disconnected: ${player.username} (${playerId})`);
            players.delete(playerId);
            
            // Notify others
            broadcast({
                type: 'player_left',
                playerId: playerId
            });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Social Credit Game server running on http://localhost:${PORT}`);
    console.log(`WebSocket server ready for connections`);
});
