# Social Credit Game - Enhanced Amsterdam Edition

Multiplayer social credit simulation with WebSocket server + Babylon.js client.  
NPCs powered by ChatGPT with personality. Chat moderation with scoring system.

![Amsterdam Edition](https://img.shields.io/badge/Edition-Amsterdam-orange)
![Status](https://img.shields.io/badge/Status-Enhanced-brightgreen)
![Node](https://img.shields.io/badge/Node-%3E%3D16.0.0-green)

## 🎮 Features

### Core Gameplay
- **WASD/Arrow Movement** - Move your avatar (Shift = sprint)
- **3rd Person Camera** - Mouse orbit/zoom/pan camera controls
- **Social Credit System** - +10 polite / -50 inappropriate / -500 targeted abuse
- **Public & Private Chat** - Right-click avatars for private messages
- **Report System** - Identify bots vs real players

### Enhanced Amsterdam Scene
- **Detailed City** - Streets, sidewalks, canals, buildings, street lamps
- **Animated Canal Water** - Realistic water with waves and reflections
- **Dutch Bikes** - Scattered bikes on sidewalks (very Amsterdam!)
- **Day/Night Cycle** - Dynamic lighting changes throughout the day
- **Weather System** - Clear, cloudy, rain, fog with synced effects
- **PBR Materials** - Professional physically-based rendering
- **Post-Processing** - Bloom, FXAA, tone mapping

### AI & NPCs
- **6 AI NPCs** - Yara, Bram, Fatima, Mehmet, Anne, Jan
- **Unique Personalities** - Each NPC has distinct character traits
- **GPT-4 Powered** - Natural conversations in Dutch/English/German
- **Walking NPCs** - Realistic pathfinding and movement
- **Ambient Chatter** - NPCs occasionally speak about surroundings

### UI Enhancements
- **Minimap** - Top-right corner with player positions
- **Weather Display** - Current weather icon and time
- **Stats Panel** - Reports filed, accuracy, player count
- **Enhanced Chat** - Better styling, private message indicators
- **Mobile Responsive** - Works on phones and tablets

### Technical Features
- **Anti-Cheat** - Server-side movement validation
- **Rate Limiting** - Chat spam protection (5 msgs/10 sec)
- **Auto-Reconnect** - Graceful connection recovery
- **WebRTC Ready** - Voice chat signaling infrastructure
- **Performance Optimized** - Efficient rendering and networking

## 🚀 Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export OPENAI_API_KEY="your-openai-api-key"
export ADMIN_PASSWORD="your-admin-password"

# Optional: Enable NPC ambient chat
export NPC_AMBIENT=1

# Start server
npm start

# Open browser
open http://localhost:8080
```

### Deploy to Render

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin your-github-repo
   git push -u origin main
   ```

2. **Create Render Web Service**
   - Connect your GitHub repository
   - Build Command: `npm install`
   - Start Command: `npm start`

3. **Set Environment Variables** (in Render dashboard)
   ```
   OPENAI_API_KEY=your_openai_key_here
   ADMIN_PASSWORD=your_admin_password_here
   NPC_AMBIENT=1  (optional - enables ambient NPC chatter)
   ```

4. **Deploy!** 🎉

## 📋 File Structure

```
social-credit-enhanced/
├── package.json          # Dependencies
├── server.js            # Enhanced WebSocket server
├── README.md            # This file
├── .gitignore          # Git ignore rules
└── public/
    ├── index.html       # Enhanced UI
    ├── app-FIXED.js     # Complete Babylon.js client
    └── admin.html       # Admin panel for API key management
```

## 🎯 Controls

| Key | Action |
|-----|--------|
| **WASD** / **Arrow Keys** | Move avatar |
| **Shift** | Sprint |
| **Mouse Wheel** | Zoom camera |
| **Mouse Drag** | Rotate camera |
| **Middle Mouse Drag** | Pan camera |
| **Right-Click Avatar** | Open context menu |
| **Enter** | Send chat message |

## 💬 Chat Commands

- **Public Chat** - Type message and press Enter
- **Private Chat** - Right-click avatar → "Chat met [name]"
- **Report Player** - Right-click avatar → "Rapporteer [name]"
- **Back to Public** - Right-click anywhere → "Zet op Openbaar"

## 🏆 Scoring System

| Action | Points | Trigger |
|--------|--------|---------|
| **Polite Communication** | +10 | Using "please", "thank you", "dank je", etc. |
| **Inappropriate Language** | -50 | Flagged by OpenAI moderation |
| **Targeted Abuse** | -500 | Name abuse + harassment/violence |
| **Correct Report** | +50 | Successfully identify real player |
| **Wrong Report** | -30 | Incorrectly report NPC as player |

### The -500 Name Rule

Mentioning "Martin Vrijland" (or variants) in combination with:
- Harassment
- Threats
- Hate speech
- Violence

Results in immediate -500 points penalty.

## ⚙️ Admin Panel

Access at `/admin.html`

- Override OpenAI API key at runtime (without server restart)
- Protected by `ADMIN_PASSWORD` environment variable
- Changes are in-memory only (reset on server restart)

## 🔧 Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | Your OpenAI API key |
| `ADMIN_PASSWORD` | No | `admin123` | Admin panel password |
| `PORT` | No | `8080` | Server port |
| `NPC_AMBIENT` | No | `0` | Enable NPC ambient chat (1=on) |

### Server Features

- **Moderation**: Uses `omni-moderation-latest` model
- **NPC Conversations**: Uses `gpt-4o-mini` model
- **Max Chat Length**: 400 characters
- **Rate Limit**: 5 messages per 10 seconds per player
- **Movement Validation**: Max 10 units per update (anti-cheat)

## 🌐 Browser Support

- ✅ Chrome/Edge (Recommended)
- ✅ Firefox
- ✅ Safari
- ✅ Mobile browsers (with touch controls)

**Requirements:**
- WebGL 2.0 support
- WebSocket support
- Modern JavaScript (ES2020+)

## 🐛 Troubleshooting

### Scene Not Loading

1. **Open Browser Console** (F12)
2. **Check for errors** in console
3. **Common issues:**
   - WebGL not supported → Try different browser
   - Network errors → Check WebSocket connection
   - Water material failed → Will fallback to simple water

### Connection Issues

- Check `OPENAI_API_KEY` is set correctly
- Verify Render logs for server errors
- Ensure WebSocket connections are allowed

### Performance Issues

- Lower resolution in browser settings
- Close other tabs/applications
- Disable bloom in code (pipeline.bloomEnabled = false)

## 📊 Performance

**Recommended Specs:**
- CPU: Modern dual-core or better
- GPU: Integrated graphics or better
- RAM: 4GB minimum
- Network: Stable broadband connection

**Expected FPS:**
- Desktop (good GPU): 60 FPS
- Desktop (integrated): 30-45 FPS
- Mobile: 20-30 FPS

## 🛠️ Development

### Adding New NPCs

Edit `server.js`:

```javascript
const npcs = [
  { id: "npc_yourname", name: "YourName", x: 0, z: 0, memory: [], targetX: 0, targetZ: 0 },
  // ... existing NPCs
];
```

### Customizing Scoring

Edit moderation rules in `server.js`:

```javascript
const POLITE_RE = /\b(your|regex|here)\b/i;
```

### Changing Weather Frequency

Edit `server.js`:

```javascript
setInterval(updateWeather, 300000); // milliseconds (5 min default)
```

## 📝 License

MIT License - see package.json

## 👤 Author

Martin Vrijland

## 🙏 Acknowledgments

- Babylon.js for the 3D engine
- OpenAI for GPT and moderation APIs
- Khronos Group for glTF sample models

---

**Made with ❤️ in Amsterdam** 🇳🇱
