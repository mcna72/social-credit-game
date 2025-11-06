// ═══════════════════════════════════════════════════════════════════════════
// SOCIAL CREDIT GAME - ULTRA ENHANCED VERSION
// Professional multiplayer 3D game with Babylon.js
// Enhanced beyond ChatGPT suggestions with production-ready features
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  SERVER_URL: window.location.origin.replace(/^http/, 'ws'),
  PLAYER_RADIUS: 0.45,
  PLAYER_HEIGHT: 1.75,
  MOVE_SPEED: 4.0,
  SPRINT_SPEED: 7.0,
  COLLISION_ITERATIONS: 3,
  MAX_RENDER_DISTANCE: 100,
  LOD_DISTANCE_HIGH: 30,
  LOD_DISTANCE_MED: 60,
};

// ═══════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const state = {
  ws: null,
  scene: null,
  engine: null,
  camera: null,
  player: null,
  entities: new Map(),
  myId: null,
  inputState: { w: false, a: false, s: false, d: false, shift: false },
  chatTarget: null,
  lastMoveTime: 0,
  lastChatTime: 0,
  score: 0,
  username: '',
  stats: { reportsCorrect: 0, reportsWrong: 0, totalPlayers: 0 },
  achievements: [],
  activeQuests: [],
};

const colliders = {
  walls: [],
  mazeBounds: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
  spatialGrid: new Map(),
  gridSize: 10,
};

const ui = {
  chatBox: null,
  chatInput: null,
  chatSendBtn: null,
  scoreDisplay: null,
  statsPanel: null,
  contextMenu: null,
  mChat: null,
  mReport: null,
  mClear: null,
  notificationContainer: null,
  minimapCanvas: null,
  achievementPanel: null,
  questPanel: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// ADVANCED COLLISION SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

class CollisionSystem {
  static circleAABBOverlap(x, z, r, box) {
    const cx = Math.max(box.min.x, Math.min(x, box.max.x));
    const cz = Math.max(box.min.z, Math.min(z, box.max.z));
    const dx = x - cx;
    const dz = z - cz;
    return (dx * dx + dz * dz) < (r * r);
  }

  static resolveCircleAABB(x, z, r, box) {
    const cx = Math.max(box.min.x, Math.min(x, box.max.x));
    const cz = Math.max(box.min.z, Math.min(z, box.max.z));
    let dx = x - cx;
    let dz = z - cz;
    let len2 = dx * dx + dz * dz;

    if (len2 === 0) {
      const leftPen = (x - box.min.x);
      const rightPen = (box.max.x - x);
      const topPen = (z - box.min.z);
      const bottomPen = (box.max.z - z);
      const minPen = Math.min(leftPen, rightPen, topPen, bottomPen);
      
      if (minPen === leftPen) x = box.min.x - r;
      else if (minPen === rightPen) x = box.max.x + r;
      else if (minPen === topPen) z = box.min.z - r;
      else z = box.max.z + r;
      
      return { x, z };
    }

    const len = Math.sqrt(len2);
    const pen = r - len;
    
    if (pen > 0) {
      dx /= len;
      dz /= len;
      x += dx * pen;
      z += dz * pen;
    }
    
    return { x, z };
  }

  static keepInsideBounds(x, z, r, bounds) {
    if (x - r < bounds.minX) x = bounds.minX + r;
    if (x + r > bounds.maxX) x = bounds.maxX - r;
    if (z - r < bounds.minZ) z = bounds.minZ + r;
    if (z + r > bounds.maxZ) z = bounds.maxZ - r;
    return { x, z };
  }

  static solveCollisions(nextX, nextZ) {
    let p = this.keepInsideBounds(nextX, nextZ, CONFIG.PLAYER_RADIUS, colliders.mazeBounds);

    for (let pass = 0; pass < CONFIG.COLLISION_ITERATIONS; pass++) {
      const nearbyWalls = this.getSpatialGridWalls(p.x, p.z);
      
      for (const box of nearbyWalls) {
        if (this.circleAABBOverlap(p.x, p.z, CONFIG.PLAYER_RADIUS, box)) {
          p = this.resolveCircleAABB(p.x, p.z, CONFIG.PLAYER_RADIUS, box);
        }
      }
      
      p = this.keepInsideBounds(p.x, p.z, CONFIG.PLAYER_RADIUS, colliders.mazeBounds);
    }
    
    return p;
  }

  static addWallCollider(mesh) {
    mesh.computeWorldMatrix(true);
    const box = new BABYLON.BoundingBox(mesh.getBoundingInfo().minimum, mesh.getBoundingInfo().maximum);
    colliders.walls.push(box);
    
    // Add to spatial grid
    const gridX = Math.floor(box.minimumWorld.x / colliders.gridSize);
    const gridZ = Math.floor(box.minimumWorld.z / colliders.gridSize);
    const key = `${gridX},${gridZ}`;
    
    if (!colliders.spatialGrid.has(key)) {
      colliders.spatialGrid.set(key, []);
    }
    colliders.spatialGrid.get(key).push(box);
  }

  static getSpatialGridWalls(x, z) {
    const gridX = Math.floor(x / colliders.gridSize);
    const gridZ = Math.floor(z / colliders.gridSize);
    let walls = [];
    
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = `${gridX + dx},${gridZ + dz}`;
        if (colliders.spatialGrid.has(key)) {
          walls = walls.concat(colliders.spatialGrid.get(key));
        }
      }
    }
    
    return walls;
  }

  static recomputeMazeBounds() {
    if (!colliders.walls.length) return;
    
    const all = colliders.walls.reduce((acc, b) => {
      return {
        minX: Math.min(acc.minX, b.minimumWorld.x),
        maxX: Math.max(acc.maxX, b.maximumWorld.x),
        minZ: Math.min(acc.minZ, b.minimumWorld.z),
        maxZ: Math.max(acc.maxZ, b.maximumWorld.z),
      };
    }, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
    
    colliders.mazeBounds = all;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VISUAL EFFECTS & PARTICLE SYSTEMS
// ═══════════════════════════════════════════════════════════════════════════

class VisualEffects {
  static createAmbientParticles(scene) {
    const particleSystem = new BABYLON.ParticleSystem("ambient", 200, scene);
    particleSystem.particleTexture = new BABYLON.Texture("https://assets.babylonjs.com/textures/flare.png", scene);
    
    particleSystem.emitter = new BABYLON.Vector3(0, 5, 0);
    particleSystem.minEmitBox = new BABYLON.Vector3(-50, 0, -50);
    particleSystem.maxEmitBox = new BABYLON.Vector3(50, 0, 50);
    
    particleSystem.color1 = new BABYLON.Color4(0.8, 0.9, 1.0, 0.3);
    particleSystem.color2 = new BABYLON.Color4(0.6, 0.7, 0.9, 0.2);
    particleSystem.colorDead = new BABYLON.Color4(0, 0, 0, 0);
    
    particleSystem.minSize = 0.1;
    particleSystem.maxSize = 0.3;
    particleSystem.minLifeTime = 3;
    particleSystem.maxLifeTime = 6;
    particleSystem.emitRate = 20;
    
    particleSystem.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    particleSystem.gravity = new BABYLON.Vector3(0, -0.1, 0);
    particleSystem.direction1 = new BABYLON.Vector3(-0.2, 0.5, -0.2);
    particleSystem.direction2 = new BABYLON.Vector3(0.2, 0.8, 0.2);
    
    particleSystem.minAngularSpeed = 0;
    particleSystem.maxAngularSpeed = Math.PI;
    particleSystem.minEmitPower = 0.5;
    particleSystem.maxEmitPower = 1;
    particleSystem.updateSpeed = 0.01;
    
    particleSystem.start();
    return particleSystem;
  }

  static createPlayerTrail(entity, scene) {
    const trail = new BABYLON.TrailMesh("trail", entity.node, scene, 0.1, 30, true);
    const sourceMat = new BABYLON.StandardMaterial("trailMat", scene);
    sourceMat.emissiveColor = new BABYLON.Color3(0.4, 0.6, 1);
    sourceMat.alpha = 0.3;
    trail.material = sourceMat;
    return trail;
  }

  static createNametagGlow(nametag, scene) {
    const glow = new BABYLON.GlowLayer("glow", scene);
    glow.intensity = 0.5;
    return glow;
  }

  static createTeleportEffect(position, scene) {
    const particles = new BABYLON.ParticleSystem("teleport", 100, scene);
    particles.particleTexture = new BABYLON.Texture("https://assets.babylonjs.com/textures/flare.png", scene);
    
    particles.emitter = position;
    particles.minEmitBox = new BABYLON.Vector3(-0.5, 0, -0.5);
    particles.maxEmitBox = new BABYLON.Vector3(0.5, 2, 0.5);
    
    particles.color1 = new BABYLON.Color4(0.2, 0.8, 1.0, 1);
    particles.color2 = new BABYLON.Color4(0.4, 0.6, 1.0, 1);
    particles.colorDead = new BABYLON.Color4(0, 0, 0, 0);
    
    particles.minSize = 0.1;
    particles.maxSize = 0.5;
    particles.minLifeTime = 0.3;
    particles.maxLifeTime = 0.8;
    particles.emitRate = 200;
    
    particles.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    particles.gravity = new BABYLON.Vector3(0, 5, 0);
    
    particles.start();
    setTimeout(() => {
      particles.stop();
      setTimeout(() => particles.dispose(), 1000);
    }, 200);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED UI SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

class UIManager {
  static initializeUI() {
    this.createModernHUD();
    this.createNotificationSystem();
    this.createMinimap();
    this.createAchievementPanel();
    this.createQuestPanel();
    this.setupContextMenu();
  }

  static createModernHUD() {
    const hudContainer = document.createElement('div');
    hudContainer.id = 'modern-hud';
    hudContainer.innerHTML = `
      <style>
        #modern-hud {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          z-index: 100;
        }
        
        .hud-panel {
          background: rgba(10, 15, 30, 0.85);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(100, 150, 255, 0.3);
          border-radius: 12px;
          padding: 15px;
          pointer-events: auto;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        
        .hud-top-left {
          position: absolute;
          top: 20px;
          left: 20px;
          min-width: 250px;
        }
        
        .hud-top-right {
          position: absolute;
          top: 20px;
          right: 20px;
          min-width: 200px;
        }
        
        .hud-bottom {
          position: absolute;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          min-width: 400px;
        }
        
        .score-display {
          font-size: 32px;
          font-weight: bold;
          color: #4CAF50;
          text-shadow: 0 0 10px rgba(76, 175, 80, 0.5);
          margin-bottom: 10px;
        }
        
        .score-negative {
          color: #f44336;
          text-shadow: 0 0 10px rgba(244, 67, 54, 0.5);
        }
        
        .stat-row {
          display: flex;
          justify-content: space-between;
          padding: 5px 0;
          color: #e0e0e0;
          font-size: 14px;
        }
        
        .stat-label {
          color: #90caf9;
        }
        
        .chat-container {
          max-height: 300px;
          overflow-y: auto;
          margin-bottom: 10px;
        }
        
        .chat-message {
          padding: 8px;
          margin: 4px 0;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.05);
          color: #e0e0e0;
          font-size: 13px;
          animation: slideIn 0.3s ease;
        }
        
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .chat-private {
          background: rgba(156, 39, 176, 0.2);
          border-left: 3px solid #9C27B0;
        }
        
        .chat-system {
          background: rgba(33, 150, 243, 0.2);
          border-left: 3px solid #2196F3;
          font-style: italic;
        }
        
        .chat-input-wrapper {
          display: flex;
          gap: 8px;
        }
        
        .chat-input {
          flex: 1;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(100, 150, 255, 0.3);
          border-radius: 6px;
          padding: 10px;
          color: white;
          font-size: 14px;
        }
        
        .chat-input:focus {
          outline: none;
          border-color: rgba(100, 150, 255, 0.6);
          box-shadow: 0 0 10px rgba(100, 150, 255, 0.2);
        }
        
        .chat-send-btn {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border: none;
          border-radius: 6px;
          padding: 10px 20px;
          color: white;
          font-weight: bold;
          cursor: pointer;
          transition: transform 0.2s;
        }
        
        .chat-send-btn:hover {
          transform: scale(1.05);
        }
        
        .minimap-container {
          width: 200px;
          height: 200px;
          border: 2px solid rgba(100, 150, 255, 0.5);
          border-radius: 8px;
          overflow: hidden;
        }
        
        .notification {
          background: rgba(10, 15, 30, 0.95);
          border-left: 4px solid #4CAF50;
          padding: 15px;
          margin: 10px;
          border-radius: 8px;
          animation: slideInRight 0.5s ease;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        }
        
        @keyframes slideInRight {
          from {
            opacity: 0;
            transform: translateX(100px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        
        .notification-success { border-left-color: #4CAF50; }
        .notification-error { border-left-color: #f44336; }
        .notification-info { border-left-color: #2196F3; }
        .notification-warning { border-left-color: #ff9800; }
      </style>
      
      <div class="hud-top-left hud-panel">
        <div class="score-display" id="score-display">
          🏆 Social Credit: <span id="score-value">0</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Reports Correct:</span>
          <span id="reports-correct">0</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Reports Wrong:</span>
          <span id="reports-wrong">0</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Accuracy:</span>
          <span id="accuracy">100%</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Players Online:</span>
          <span id="player-count">1</span>
        </div>
      </div>
      
      <div class="hud-top-right hud-panel">
        <div class="minimap-container">
          <canvas id="minimap-canvas" width="200" height="200"></canvas>
        </div>
      </div>
      
      <div class="hud-bottom hud-panel">
        <div class="chat-container" id="chat-box"></div>
        <div class="chat-input-wrapper">
          <input type="text" class="chat-input" id="chat-input" placeholder="Type message..." maxlength="400">
          <button class="chat-send-btn" id="chat-send-btn">Send</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(hudContainer);
    
    // Cache UI elements
    ui.chatBox = document.getElementById('chat-box');
    ui.chatInput = document.getElementById('chat-input');
    ui.chatSendBtn = document.getElementById('chat-send-btn');
    ui.scoreDisplay = document.getElementById('score-value');
  }

  static createNotificationSystem() {
    const container = document.createElement('div');
    container.id = 'notification-container';
    container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 1000; pointer-events: none;';
    document.body.appendChild(container);
    ui.notificationContainer = container;
  }

  static showNotification(message, type = 'info', duration = 3000) {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 5px;">${this.getNotificationIcon(type)} ${this.getNotificationTitle(type)}</div>
      <div style="color: #b0b0b0;">${message}</div>
    `;
    
    ui.notificationContainer.appendChild(notification);
    
    setTimeout(() => {
      notification.style.animation = 'slideOutRight 0.5s ease';
      setTimeout(() => notification.remove(), 500);
    }, duration);
  }

  static getNotificationIcon(type) {
    const icons = {
      success: '✅',
      error: '❌',
      info: 'ℹ️',
      warning: '⚠️'
    };
    return icons[type] || icons.info;
  }

  static getNotificationTitle(type) {
    const titles = {
      success: 'Success',
      error: 'Error',
      info: 'Info',
      warning: 'Warning'
    };
    return titles[type] || titles.info;
  }

  static createMinimap() {
    ui.minimapCanvas = document.getElementById('minimap-canvas');
    if (ui.minimapCanvas) {
      ui.minimapCtx = ui.minimapCanvas.getContext('2d');
    }
  }

  static updateMinimap() {
    if (!ui.minimapCtx || !state.player) return;
    
    const ctx = ui.minimapCtx;
    const canvas = ui.minimapCanvas;
    const scale = 0.5;
    
    ctx.fillStyle = 'rgba(10, 15, 30, 0.9)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw maze bounds
    ctx.strokeStyle = 'rgba(100, 150, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
    
    // Draw player (center) - Green dot = you
    ctx.fillStyle = '#4CAF50';
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, 5, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw other entities - ALL LOOK THE SAME (yellow dots)
    // Mystery mode: You must figure out who's an NPC vs real player!
    state.entities.forEach((entity, id) => {
      if (!entity.node) return;
      
      const dx = entity.node.position.x - state.player.node.position.x;
      const dz = entity.node.position.z - state.player.node.position.z;
      
      const x = canvas.width / 2 + dx * scale;
      const z = canvas.height / 2 + dz * scale;
      
      if (x > 0 && x < canvas.width && z > 0 && z < canvas.height) {
        // Everyone looks the same - yellow dots (mystery!)
        ctx.fillStyle = '#FFC107';
        ctx.beginPath();
        ctx.arc(x, z, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  static createAchievementPanel() {
    const panel = document.createElement('div');
    panel.id = 'achievement-panel';
    panel.style.cssText = 'position: fixed; bottom: 100px; left: 20px; z-index: 200;';
    document.body.appendChild(panel);
    ui.achievementPanel = panel;
  }

  static createQuestPanel() {
    const panel = document.createElement('div');
    panel.id = 'quest-panel';
    panel.innerHTML = `
      <div class="hud-panel" style="max-width: 300px;">
        <h3 style="color: #90caf9; margin: 0 0 10px 0;">📋 Active Quests</h3>
        <div id="quest-list"></div>
      </div>
    `;
    panel.style.cssText = 'position: fixed; bottom: 350px; left: 20px; z-index: 200;';
    document.body.appendChild(panel);
    ui.questPanel = panel;
  }

  static setupContextMenu() {
    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.style.cssText = `
      position: absolute;
      background: rgba(10, 15, 30, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(100, 150, 255, 0.5);
      border-radius: 8px;
      padding: 8px 0;
      display: none;
      z-index: 1000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;
    
    menu.innerHTML = `
      <div class="menu-item" id="menu-chat">💬 Privé chat</div>
      <div class="menu-item" id="menu-report">⚠️ Rapporteer avatar</div>
      <div class="menu-item" id="menu-clear">🔓 Zet op Openbaar</div>
      <style>
        .menu-item {
          padding: 10px 20px;
          color: #e0e0e0;
          cursor: pointer;
          transition: background 0.2s;
        }
        .menu-item:hover {
          background: rgba(100, 150, 255, 0.2);
        }
      </style>
    `;
    
    document.body.appendChild(menu);
    ui.contextMenu = menu;
    ui.mChat = document.getElementById('menu-chat');
    ui.mReport = document.getElementById('menu-report');
    ui.mClear = document.getElementById('menu-clear');
  }

  static updateScore(score) {
    state.score = score;
    ui.scoreDisplay.textContent = score;
    ui.scoreDisplay.parentElement.className = score < 0 ? 'score-display score-negative' : 'score-display';
  }

  static addChatMessage(msg, isPrivate = false, isSystem = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isPrivate ? 'chat-private' : ''} ${isSystem ? 'chat-system' : ''}`;
    msgDiv.textContent = msg;
    ui.chatBox.appendChild(msgDiv);
    ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
    
    // Limit messages
    while (ui.chatBox.children.length > 50) {
      ui.chatBox.removeChild(ui.chatBox.firstChild);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE & WORLD GENERATION
// ═══════════════════════════════════════════════════════════════════════════

class WorldGenerator {
  static createEnhancedScene(engine, canvas) {
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.1, 0.15, 0.25, 1);
    scene.ambientColor = new BABYLON.Color3(0.3, 0.3, 0.4);
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.01;
    scene.fogColor = new BABYLON.Color3(0.1, 0.15, 0.25);
    
    return scene;
  }

  static setupLighting(scene) {
    // Hemispheric light
    const hemiLight = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
    hemiLight.intensity = 0.6;
    hemiLight.diffuse = new BABYLON.Color3(0.9, 0.95, 1);
    hemiLight.specular = new BABYLON.Color3(0.5, 0.5, 0.6);
    hemiLight.groundColor = new BABYLON.Color3(0.2, 0.25, 0.3);
    
    // Directional light (sun)
    const dirLight = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-1, -2, -1), scene);
    dirLight.intensity = 0.8;
    dirLight.diffuse = new BABYLON.Color3(1, 0.95, 0.8);
    dirLight.specular = new BABYLON.Color3(1, 1, 0.9);
    
    // Shadows
    const shadowGenerator = new BABYLON.ShadowGenerator(1024, dirLight);
    shadowGenerator.useBlurExponentialShadowMap = true;
    shadowGenerator.blurKernel = 32;
    
    return { hemiLight, dirLight, shadowGenerator };
  }

  static createGround(scene, shadowGenerator) {
    const ground = BABYLON.MeshBuilder.CreateGround("ground", {
      width: 600,
      height: 600,
      subdivisions: 50
    }, scene);
    
    const groundMat = new BABYLON.PBRMaterial("groundMat", scene);
    groundMat.albedoColor = new BABYLON.Color3(0.2, 0.3, 0.2);
    groundMat.metallic = 0;
    groundMat.roughness = 0.9;
    groundMat.bumpTexture = new BABYLON.Texture("https://assets.babylonjs.com/textures/grass.png", scene);
    groundMat.bumpTexture.uScale = 50;
    groundMat.bumpTexture.vScale = 50;
    
    ground.material = groundMat;
    ground.receiveShadows = true;
    ground.checkCollisions = false;
    
    return ground;
  }

  static async createMaze(scene, shadowGenerator) {
    const wallHeight = 3;
    const wallThickness = 0.5;
    const corridorWidth = 4;
    
    // Create PBR material for walls
    const wallMat = new BABYLON.PBRMaterial("wallMat", scene);
    wallMat.albedoColor = new BABYLON.Color3(0.7, 0.75, 0.8);
    wallMat.metallic = 0.2;
    wallMat.roughness = 0.7;
    wallMat.bumpTexture = new BABYLON.Texture("https://assets.babylonjs.com/textures/rock.png", scene);
    
    // Simple maze pattern
    const mazeLayout = [
      "##########",
      "#....#...#",
      "#.##.#.#.#",
      "#....#.#.#",
      "####.#.#.#",
      "#....#...#",
      "#.####.###",
      "#.......##",
      "#.#####..#",
      "##########"
    ];
    
    const cellSize = corridorWidth + wallThickness;
    const mazeWidth = mazeLayout[0].length * cellSize;
    const mazeHeight = mazeLayout.length * cellSize;
    const offsetX = -mazeWidth / 2;
    const offsetZ = -mazeHeight / 2;
    
    for (let row = 0; row < mazeLayout.length; row++) {
      for (let col = 0; col < mazeLayout[row].length; col++) {
        if (mazeLayout[row][col] === '#') {
          const wall = BABYLON.MeshBuilder.CreateBox(`wall_${row}_${col}`, {
            width: cellSize,
            height: wallHeight,
            depth: cellSize
          }, scene);
          
          wall.position = new BABYLON.Vector3(
            offsetX + col * cellSize + cellSize / 2,
            wallHeight / 2,
            offsetZ + row * cellSize + cellSize / 2
          );
          
          wall.material = wallMat;
          wall.checkCollisions = false;
          shadowGenerator.addShadowCaster(wall);
          
          // Add collider
          CollisionSystem.addWallCollider(wall);
        }
      }
    }
    
    // Recompute maze bounds
    CollisionSystem.recomputeMazeBounds();
    
    return { width: mazeWidth, height: mazeHeight };
  }

  static setupCamera(scene, canvas) {
    const camera = new BABYLON.ArcRotateCamera(
      "camera",
      Math.PI / 2,
      Math.PI / 3,
      10,
      BABYLON.Vector3.Zero(),
      scene
    );
    
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 3;
    camera.upperRadiusLimit = 20;
    camera.lowerBetaLimit = 0.1;
    camera.upperBetaLimit = Math.PI / 2.2;
    camera.panningSensibility = 50;
    camera.wheelDeltaPercentage = 0.01;
    camera.pinchDeltaPercentage = 0.01;
    
    return camera;
  }

  static setupPostProcessing(scene, camera) {
    const pipeline = new BABYLON.DefaultRenderingPipeline("default", true, scene, [camera]);
    
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.8;
    pipeline.bloomWeight = 0.3;
    pipeline.bloomKernel = 64;
    pipeline.bloomScale = 0.5;
    
    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.toneMappingEnabled = true;
    pipeline.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    pipeline.imageProcessing.exposure = 1.2;
    pipeline.imageProcessing.contrast = 1.1;
    
    // Depth of field
    pipeline.depthOfFieldEnabled = true;
    pipeline.depthOfFieldBlurLevel = BABYLON.DepthOfFieldEffectBlurLevel.Low;
    pipeline.depthOfField.focalLength = 150;
    pipeline.depthOfField.fStop = 1.4;
    pipeline.depthOfField.focusDistance = 2000;
    
    return pipeline;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTITY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

class EntityManager {
  // Initialize the entities Map immediately when class is defined
  static entities = state.entities;
  
  static async createAvatar(scene, shadowGenerator, isNPC = false) {
    const avatar = BABYLON.MeshBuilder.CreateCapsule("avatar", {
      radius: CONFIG.PLAYER_RADIUS,
      height: CONFIG.PLAYER_HEIGHT,
      subdivisions: 16
    }, scene);
    
    const mat = new BABYLON.PBRMaterial("avatarMat", scene);
    
    // ALL AVATARS LOOK THE SAME - mystery colors (slight variation but not obvious)
    // Everyone gets a random tint from a similar palette
    const hue = 0.55 + (Math.random() * 0.1 - 0.05); // Around cyan/blue
    const sat = 0.7 + (Math.random() * 0.2 - 0.1);
    const light = 0.6 + (Math.random() * 0.2 - 0.1);
    
    mat.albedoColor = BABYLON.Color3.FromHSV(hue * 360, sat, light);
    mat.metallic = 0.1;
    mat.roughness = 0.6;
    mat.emissiveColor = new BABYLON.Color3(0.1, 0.3, 0.5);
    avatar.material = mat;
    
    shadowGenerator.addShadowCaster(avatar);
    
    return avatar;
  }

  static createNameTag(name, scene) {
    const plane = BABYLON.MeshBuilder.CreatePlane("nametag", { width: 2, height: 0.5 }, scene);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.position.y = CONFIG.PLAYER_HEIGHT + 0.5;
    
    const texture = new BABYLON.DynamicTexture("nametagTex", { width: 512, height: 128 }, scene, false);
    const ctx = texture.getContext();
    
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, 512, 128);
    
    ctx.font = "bold 48px Arial";
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 256, 64);
    
    texture.update();
    
    const mat = new BABYLON.StandardMaterial("nametagMat", scene);
    mat.diffuseTexture = texture;
    mat.emissiveTexture = texture;
    mat.opacityTexture = texture;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    
    plane.material = mat;
    
    return plane;
  }

  static addEntity(id, name, x, z, isNPC, scene, shadowGenerator) {
    // Safety check: ensure state.entities exists
    if (!state.entities) {
      console.error('❌ Cannot add entity - state.entities not initialized!');
      return null;
    }
    
    if (state.entities.has(id)) {
      console.log('Entity already exists:', id);
      return state.entities.get(id);
    }
    
    // Safety check: ensure scene exists
    if (!scene) {
      console.error('❌ Cannot add entity - scene not initialized!');
      return null;
    }
    
    try {
      const node = this.createAvatar(scene, shadowGenerator, isNPC);
      node.position.set(x, CONFIG.PLAYER_HEIGHT / 2, z);
      
      const nametag = this.createNameTag(name, scene);
      nametag.parent = node;
      
      // Apply spawn collision check
      const safePos = CollisionSystem.solveCollisions(x, z);
      node.position.x = safePos.x;
      node.position.z = safePos.z;
      
      const entity = {
        id,
        name,
        node,
        nametag,
        target: node.position.clone(),
        isNPC,
        lastUpdate: Date.now()
      };
      
      state.entities.set(id, entity);
      console.log('✅ Entity added:', name, id);
      
      // Spawn effect
      VisualEffects.createTeleportEffect(node.position, scene);
      
      return entity;
    } catch (err) {
      console.error('❌ Error adding entity:', err);
      return null;
    }
  }

  static removeEntity(id) {
    const entity = state.entities.get(id);
    if (!entity) return;
    
    if (entity.nametag) entity.nametag.dispose();
    if (entity.node) entity.node.dispose();
    if (entity.trail) entity.trail.dispose();
    
    state.entities.delete(id);
  }

  static updateEntity(entity, dt) {
    if (!entity.node || !entity.target) return;
    
    const dist = BABYLON.Vector3.Distance(entity.node.position, entity.target);
    
    if (dist > 0.05) {
      const direction = entity.target.subtract(entity.node.position).normalize();
      const moveSpeed = entity.isNPC ? CONFIG.MOVE_SPEED * 0.7 : CONFIG.MOVE_SPEED;
      const step = direction.scale(moveSpeed * dt);
      
      const newX = entity.node.position.x + step.x;
      const newZ = entity.node.position.z + step.z;
      
      // Apply collision correction
      const solved = CollisionSystem.solveCollisions(newX, newZ);
      entity.node.position.x = solved.x;
      entity.node.position.z = solved.z;
      
      // Rotate towards movement direction
      if (step.length() > 0.01) {
        const angle = Math.atan2(step.x, step.z);
        entity.node.rotation.y = angle;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INPUT & MOVEMENT
// ═══════════════════════════════════════════════════════════════════════════

class InputManager {
  static setupInput(canvas) {
    // Keyboard
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'w' || key === 'arrowup') state.inputState.w = true;
      if (key === 'a' || key === 'arrowleft') state.inputState.a = true;
      if (key === 's' || key === 'arrowdown') state.inputState.s = true;
      if (key === 'd' || key === 'arrowright') state.inputState.d = true;
      if (key === 'shift') state.inputState.shift = true;
    });
    
    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'w' || key === 'arrowup') state.inputState.w = false;
      if (key === 'a' || key === 'arrowleft') state.inputState.a = false;
      if (key === 's' || key === 'arrowdown') state.inputState.s = false;
      if (key === 'd' || key === 'arrowright') state.inputState.d = false;
      if (key === 'shift') state.inputState.shift = false;
    });
    
    // Context menu
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.handleRightClick(e);
    });
    
    // Hide context menu on click away
    window.addEventListener('click', (e) => {
      if (!ui.contextMenu.contains(e.target)) {
        ui.contextMenu.style.display = 'none';
      }
    });
  }

  static handleRightClick(e) {
    const pickResult = state.scene.pick(e.clientX, e.clientY);
    
    if (pickResult.hit && pickResult.pickedMesh) {
      // Check if clicked on an entity
      for (const [id, entity] of state.entities) {
        if (entity.node === pickResult.pickedMesh || entity.node.getChildren().includes(pickResult.pickedMesh)) {
          ui.mChat.textContent = `💬 Privé chat met ${entity.name}`;
          ui.mReport.textContent = `⚠️ Rapporteer ${entity.name}`;
          
          ui.mChat.onclick = () => {
            state.chatTarget = id;
            UIManager.showNotification(`Nu privé chatten met ${entity.name}`, 'info');
            ui.contextMenu.style.display = 'none';
          };
          
          ui.mReport.onclick = () => {
            NetworkManager.sendReport(id);
            ui.contextMenu.style.display = 'none';
          };
          
          ui.contextMenu.style.left = `${e.clientX}px`;
          ui.contextMenu.style.top = `${e.clientY}px`;
          ui.contextMenu.style.display = 'block';
          return;
        }
      }
    }
    
    // Clicked on ground - show clear option
    ui.mChat.style.display = 'none';
    ui.mReport.style.display = 'none';
    ui.mClear.style.display = 'block';
    
    ui.mClear.onclick = () => {
      state.chatTarget = null;
      UIManager.showNotification('Terug naar openbare chat', 'info');
      ui.contextMenu.style.display = 'none';
    };
    
    ui.contextMenu.style.left = `${e.clientX}px`;
    ui.contextMenu.style.top = `${e.clientY}px`;
    ui.contextMenu.style.display = 'block';
  }

  static tickMovement(dt) {
    if (!state.player || !state.player.node) return;
    
    const input = state.inputState;
    if (!input.w && !input.a && !input.s && !input.d) return;
    
    const camera = state.camera;
    const forward = camera.getForwardRay().direction;
    forward.y = 0;
    forward.normalize();
    
    const right = BABYLON.Vector3.Cross(forward, BABYLON.Vector3.Up());
    
    let moveDir = BABYLON.Vector3.Zero();
    if (input.w) moveDir.addInPlace(forward);
    if (input.s) moveDir.subtractInPlace(forward);
    if (input.d) moveDir.addInPlace(right);
    if (input.a) moveDir.subtractInPlace(right);
    
    if (moveDir.length() > 0) {
      moveDir.normalize();
      const speed = input.shift ? CONFIG.SPRINT_SPEED : CONFIG.MOVE_SPEED;
      const delta = moveDir.scale(speed * dt);
      
      const newX = state.player.node.position.x + delta.x;
      const newZ = state.player.node.position.z + delta.z;
      
      // Apply collision
      const solved = CollisionSystem.solveCollisions(newX, newZ);
      state.player.node.position.x = solved.x;
      state.player.node.position.z = solved.z;
      
      // Update rotation
      const angle = Math.atan2(moveDir.x, moveDir.z);
      state.player.node.rotation.y = angle;
      
      // Send to server (throttled)
      const now = Date.now();
      if (now - state.lastMoveTime > 50) {
        NetworkManager.sendMove(solved.x, solved.z);
        state.lastMoveTime = now;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NETWORK MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

class NetworkManager {
  static messageQueue = [];
  static isReady = false;
  
  static connect() {
    state.ws = new WebSocket(CONFIG.SERVER_URL);
    
    state.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      UIManager.showNotification('Verbonden met server!', 'success');
      this.sendJoin();
    };
    
    state.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        
        // Queue messages until scene is ready
        if (!this.isReady) {
          console.log('📬 Queuing message:', msg.type);
          this.messageQueue.push(msg);
          return;
        }
        
        this.handleMessage(msg);
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };
    
    state.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      UIManager.showNotification('Verbindingsfout', 'error');
    };
    
    state.ws.onclose = () => {
      console.log('WebSocket closed');
      UIManager.showNotification('Verbinding verbroken', 'warning');
      setTimeout(() => this.connect(), 3000);
    };
  }
  
  static setReady() {
    console.log('✅ Game ready, processing queued messages:', this.messageQueue.length);
    this.isReady = true;
    
    // Process all queued messages
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      console.log('📨 Processing queued message:', msg.type);
      this.handleMessage(msg);
    }
  }

  static sendJoin() {
    const name = state.username || prompt('Voer je naam in:') || 'Player';
    state.username = name;
    
    this.send({
      type: 'join',
      name: name
    });
  }

  static sendMove(x, z) {
    this.send({
      type: 'move',
      x: Math.round(x * 100) / 100,
      z: Math.round(z * 100) / 100
    });
  }

  static sendChat(text) {
    if (!text.trim()) return;
    
    this.send({
      type: 'chat',
      text: text,
      target: state.chatTarget
    });
    
    state.lastChatTime = Date.now();
  }

  static sendReport(targetId) {
    this.send({
      type: 'report',
      targetId: targetId
    });
    
    UIManager.showNotification('Rapport ingediend', 'info');
  }

  static send(data) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(data));
    }
  }

  static handleMessage(msg) {
    if (!msg || !msg.type) {
      console.warn('Invalid message received:', msg);
      return;
    }
    
    switch (msg.type) {
      case 'init':
        this.handleInit(msg);
        break;
      case 'player_joined':
        this.handlePlayerJoined(msg);
        break;
      case 'player_left':
        this.handlePlayerLeft(msg);
        break;
      case 'player_move':
        this.handlePlayerMove(msg);
        break;
      case 'npc_update':
        this.handleNPCUpdate(msg);
        break;
      case 'chat_message':
        this.handleChatMessage(msg);
        break;
      case 'score_update':
        this.handleScoreUpdate(msg);
        break;
      case 'report_result':
        this.handleReportResult(msg);
        break;
      case 'stats':
        this.handleStats(msg);
        break;
      case 'weather_update':
        // Optional: handle weather updates if needed
        console.log('Weather update:', msg.weather, msg.time);
        break;
      default:
        console.warn('Unknown message type:', msg.type, msg);
        break;
    }
  }

  static handleInit(msg) {
    console.log('📥 Handling init message:', msg);
    
    if (!state.scene) {
      console.error('❌ Scene not ready for init!');
      return;
    }
    
    state.myId = msg.id;
    
    // Create local player
    state.player = EntityManager.addEntity(
      msg.id,
      msg.name,
      msg.x,
      msg.z,
      false,
      state.scene,
      state.shadowGenerator
    );
    
    if (!state.player) {
      console.error('❌ Failed to create player!');
      return;
    }
    
    // Add other players
    if (msg.players) {
      msg.players.forEach(p => {
        if (p.id !== state.myId) {
          EntityManager.addEntity(p.id, p.name, p.x, p.z, false, state.scene, state.shadowGenerator);
        }
      });
    }
    
    // Add NPCs
    if (msg.npcs) {
      msg.npcs.forEach(npc => {
        EntityManager.addEntity(npc.id, npc.name, npc.x, npc.z, true, state.scene, state.shadowGenerator);
      });
    }
    
    UIManager.updateScore(msg.score || 0);
    console.log('✅ Init complete - Player:', state.player.name);
  }

  static handlePlayerJoined(msg) {
    if (!msg.id || !msg.name || msg.x === undefined || msg.z === undefined) {
      console.error('Invalid player_joined message:', msg);
      return;
    }
    EntityManager.addEntity(msg.id, msg.name, msg.x, msg.z, false, state.scene, state.shadowGenerator);
    UIManager.addChatMessage(`${msg.name} heeft het spel betreden`, false, true);
    UIManager.showNotification(`${msg.name} heeft het spel betreden`, 'info');
  }

  static handlePlayerLeft(msg) {
    if (!msg.id) {
      console.error('Invalid player_left message:', msg);
      return;
    }
    const entity = state.entities.get(msg.id);
    if (entity) {
      UIManager.addChatMessage(`${entity.name} heeft het spel verlaten`, false, true);
    }
    EntityManager.removeEntity(msg.id);
  }

  static handlePlayerMove(msg) {
    if (!msg.id || msg.x === undefined || msg.z === undefined) {
      console.error('Invalid player_move message:', msg);
      return;
    }
    const entity = state.entities.get(msg.id);
    if (entity && entity.id !== state.myId && entity.target) {
      // Apply collision correction to remote position
      const fixed = CollisionSystem.solveCollisions(msg.x, msg.z);
      entity.target.set(fixed.x, CONFIG.PLAYER_HEIGHT / 2, fixed.z);
      entity.lastUpdate = Date.now();
    }
  }

  static handleNPCUpdate(msg) {
    if (!msg.id || msg.x === undefined || msg.z === undefined) {
      console.error('Invalid npc_update message:', msg);
      return;
    }
    const entity = state.entities.get(msg.id);
    if (entity && entity.target) {
      // Apply collision correction
      const fixed = CollisionSystem.solveCollisions(msg.x, msg.z);
      entity.target.set(fixed.x, CONFIG.PLAYER_HEIGHT / 2, fixed.z);
      entity.lastUpdate = Date.now();
    }
  }

  static handleChatMessage(msg) {
    const isPrivate = msg.private || false;
    const sender = state.entities.get(msg.from)?.name || 'Unknown';
    const text = `${sender}: ${msg.text}`;
    
    UIManager.addChatMessage(text, isPrivate, false);
  }

  static handleScoreUpdate(msg) {
    UIManager.updateScore(msg.score);
    
    if (msg.reason) {
      const isPositive = msg.delta > 0;
      UIManager.showNotification(
        `${isPositive ? '+' : ''}${msg.delta} punten: ${msg.reason}`,
        isPositive ? 'success' : 'error'
      );
    }
  }

  static handleReportResult(msg) {
    if (msg.correct) {
      state.stats.reportsCorrect++;
      UIManager.showNotification(`Correct! ${msg.target} is een ${msg.type}`, 'success');
    } else {
      state.stats.reportsWrong++;
      UIManager.showNotification(`Fout! ${msg.target} is een ${msg.type}`, 'error');
    }
    
    this.updateStatsDisplay();
  }

  static handleStats(msg) {
    state.stats.totalPlayers = msg.playerCount || 1;
    this.updateStatsDisplay();
  }

  static updateStatsDisplay() {
    document.getElementById('reports-correct').textContent = state.stats.reportsCorrect;
    document.getElementById('reports-wrong').textContent = state.stats.reportsWrong;
    
    const total = state.stats.reportsCorrect + state.stats.reportsWrong;
    const accuracy = total > 0 ? Math.round((state.stats.reportsCorrect / total) * 100) : 100;
    document.getElementById('accuracy').textContent = `${accuracy}%`;
    
    document.getElementById('player-count').textContent = state.stats.totalPlayers;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APPLICATION
// ═══════════════════════════════════════════════════════════════════════════

async function initGame() {
  console.log('🎮 Initializing Social Credit Game...');
  
  // Setup UI
  UIManager.initializeUI();
  
  // Get canvas
  const canvas = document.createElement('canvas');
  canvas.id = 'renderCanvas';
  canvas.style.cssText = 'width: 100%; height: 100%; position: fixed; top: 0; left: 0; z-index: 1;';
  document.body.insertBefore(canvas, document.body.firstChild);
  
  // Create engine
  state.engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    disableWebGL2Support: false
  });
  
  // Create scene
  state.scene = WorldGenerator.createEnhancedScene(state.engine, canvas);
  
  // Setup lighting
  const { hemiLight, dirLight, shadowGenerator } = WorldGenerator.setupLighting(state.scene);
  state.shadowGenerator = shadowGenerator;
  
  // Create ground
  WorldGenerator.createGround(state.scene, shadowGenerator);
  
  // Create maze
  await WorldGenerator.createMaze(state.scene, shadowGenerator);
  
  // Setup camera
  state.camera = WorldGenerator.setupCamera(state.scene, canvas);
  
  // Setup post-processing
  WorldGenerator.setupPostProcessing(state.scene, state.camera);
  
  // Create ambient particles
  VisualEffects.createAmbientParticles(state.scene);
  
  // Setup input
  InputManager.setupInput(canvas);
  
  // Chat input handler
  ui.chatSendBtn.onclick = () => {
    NetworkManager.sendChat(ui.chatInput.value);
    ui.chatInput.value = '';
  };
  
  ui.chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      NetworkManager.sendChat(ui.chatInput.value);
      ui.chatInput.value = '';
    }
  });
  
  // Connect to server
  NetworkManager.connect();
  
  // Mark as ready to process messages AFTER scene is set up
  NetworkManager.setReady();
  
  // Render loop
  let lastTime = Date.now();
  state.engine.runRenderLoop(() => {
    const now = Date.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    
    // Update movement
    InputManager.tickMovement(dt);
    
    // Update entities
    state.entities.forEach(entity => {
      if (entity.id !== state.myId) {
        EntityManager.updateEntity(entity, dt);
      }
    });
    
    // Update camera to follow player
    if (state.player && state.player.node) {
      state.camera.target = state.player.node.position;
    }
    
    // Update minimap
    UIManager.updateMinimap();
    
    // Render
    state.scene.render();
  });
  
  // Handle resize
  window.addEventListener('resize', () => {
    state.engine.resize();
  });
  
  console.log('✅ Game initialized successfully!');
  UIManager.showNotification('Welkom bij Social Credit Game!', 'success', 5000);
}

// Start game when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGame);
} else {
  initGame();
}
