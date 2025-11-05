// public/app.js — WORKING lightweight version with FIXED avatar positioning
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const ui = {
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('start'),
  nameInput: document.getElementById('name'),
  avatars: document.getElementById('avatars'),
  langSel: document.getElementById('lang'),
  credit: document.getElementById('credit'),
  conn: document.getElementById('conn'),
  chatlog: document.getElementById('chatlog'),
  msg: document.getElementById('msg'),
  sendBtn: document.getElementById('send'),
  targetName: document.getElementById('targetName'),
  rightMenu: document.getElementById('rightMenu'),
  mChat: document.getElementById('actChat'),
  mReport: document.getElementById('actReport'),
  mClear: document.getElementById('actClear'),
  weatherIcon: document.getElementById('weatherIcon'),
  timeDisplay: document.getElementById('timeDisplay'),
  minimapCanvas: document.getElementById('minimapCanvas'),
  statReports: document.getElementById('statReports'),
  statAccuracy: document.getElementById('statAccuracy'),
  statPlayers: document.getElementById('statPlayers'),
  loadingSpinner: document.getElementById('loadingSpinner')
};

const state = {
  ws: null,
  playerId: null,
  username: '',
  avatarEmoji: '🙂',
  lang: 'nl',
  targetId: null,
  credits: 1000,
  engine: null,
  scene: null,
  camera: null,
  entities: new Map(),
  player: null,
  avatarReady: false,
  avatarTemplate: null,
  pendingSpawns: [],
  weather: { type: 'clear', intensity: 1 },
  gameTime: 12.0,
  stats: { reportsTotal: 0, reportsCorrect: 0 }
};

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function addLine(user, text, isPrivate = false, isSystem = false) {
  const div = document.createElement('div');
  div.className = 'line' + (isPrivate ? ' private' : '') + (isSystem ? ' system' : '');
  div.innerHTML = `<span class="user">${escapeHtml(user)}</span> ${escapeHtml(text)}`;
  ui.chatlog.appendChild(div);
  ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  while (ui.chatlog.children.length > 200) ui.chatlog.removeChild(ui.chatlog.firstChild);
}

function sendMessage(text){
  if (!text || !text.trim()) return;
  const payload = { type:'chat', message: text.trim() };
  if (state.targetId) payload.targetId = state.targetId;
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function updateCredits(amount, reason) {
  state.credits += amount;
  ui.credit.textContent = state.credits;
  ui.credit.style.color = state.credits < 500 ? '#ff4444' : '#00ff88';
  if (reason) addLine('SYSTEM:', reason, false, true);
}

function updateStats() {
  ui.statReports.textContent = state.stats.reportsTotal;
  const accuracy = state.stats.reportsTotal > 0 ? 
    ((state.stats.reportsCorrect / state.stats.reportsTotal) * 100).toFixed(0) + '%' : '--';
  ui.statAccuracy.textContent = accuracy;
}

function updateWeather(type, intensity) {
  state.weather = { type, intensity };
  const icons = { clear: '☀️', cloudy: '☁️', rain: '🌧️', fog: '🌫️' };
  ui.weatherIcon.textContent = icons[type] || '☀️';
  if (state.scene) {
    const fogDensities = { fog: 0.015, rain: 0.008, cloudy: 0.005, clear: 0.003 };
    state.scene.fogDensity = (fogDensities[type] || 0.003) * intensity;
  }
}

function updateTimeOfDay(gameTime) {
  state.gameTime = gameTime;
  const hour = Math.floor(gameTime);
  const min = Math.floor((gameTime - hour) * 60);
  ui.timeDisplay.textContent = `${hour.toString().padStart(2,'0')}:${min.toString().padStart(2,'0')}`;
  
  if (state.scene) {
    const sun = state.scene.getLightByName('sun');
    if (sun) {
      if (gameTime < 6 || gameTime > 20) {
        sun.intensity = 0.4;
      } else if (gameTime < 8 || gameTime > 18) {
        sun.intensity = 0.8;
      } else {
        sun.intensity = 1.4;
      }
    }
  }
}

const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas, true, { 
  preserveDrawingBuffer: false,
  stencil: false,
  antialias: false
}, true);
state.engine = engine;

const createScene = async () => {
  console.log('[Scene] Creating...');
  
  const scene = new BABYLON.Scene(engine);
  state.scene = scene;
  scene.clearColor = new BABYLON.Color4(0.05, 0.08, 0.15, 1);

  // Camera - higher up to see avatars better
  const cam = new BABYLON.ArcRotateCamera('cam',
    BABYLON.Tools.ToRadians(-45),
    BABYLON.Tools.ToRadians(60),
    35, 
    new BABYLON.Vector3(0, 1, 0),  // Look at ground level
    scene
  );
  cam.attachControl(canvas, true);
  cam.wheelPrecision = 25;
  cam.lowerRadiusLimit = 8;
  cam.upperRadiusLimit = 80;
  cam.lowerBetaLimit = BABYLON.Tools.ToRadians(20);
  cam.upperBetaLimit = BABYLON.Tools.ToRadians(85);
  cam.keysUp = cam.keysDown = cam.keysLeft = cam.keysRight = [];
  state.camera = cam;

  // ONLY 3 lights - GPU friendly
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.7;
  hemi.diffuse = new BABYLON.Color3(0.9, 0.95, 1);
  hemi.groundColor = new BABYLON.Color3(0.3, 0.35, 0.4);
  
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.4, -1, -0.3), scene);
  sun.position = new BABYLON.Vector3(50, 80, 50);
  sun.intensity = 1.4;
  sun.diffuse = new BABYLON.Color3(1, 0.98, 0.95);
  
  const fill = new BABYLON.HemisphericLight('fill', new BABYLON.Vector3(0, -1, 0), scene);
  fill.intensity = 0.25;
  fill.diffuse = new BABYLON.Color3(0.5, 0.6, 0.7);

  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.003;
  scene.fogColor = new BABYLON.Color3(0.05, 0.08, 0.15);

  console.log('[Scene] Building city...');
  buildCity(scene);

  // IMPORTANT: Set avatar ready BEFORE connecting
  state.avatarReady = true;
  console.log('[Scene] Avatar system ready (using simple capsules)');

  setupMinimap(scene);
  setupContextMenu(scene);
  setupControls();

  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tickMovement(dt);
    interpolateRemotes();
    updateMinimap();
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());
  console.log('[Scene] Ready!');
  return scene;
};

function simpleMat(scene, {color=[1,1,1], emissive=[0,0,0]} = {}) {
  const m = new BABYLON.StandardMaterial('m' + Math.random(), scene);
  m.diffuseColor = new BABYLON.Color3(...color);
  m.emissiveColor = new BABYLON.Color3(...emissive);
  m.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
  return m;
}

function buildCity(scene) {
  // Ground - slightly raised so we can see it
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { 
    width: 300, height: 300, subdivisions: 1 
  }, scene);
  ground.position.y = -0.1;  // Slightly below zero
  ground.material = simpleMat(scene, {color:[0.80, 0.82, 0.85]});

  // Materials
  const asphalt = simpleMat(scene, {color:[0.18, 0.18, 0.20]});
  const sidewalkMat = simpleMat(scene, {color:[0.60, 0.61, 0.63]});
  const water = simpleMat(scene, {color:[0.25, 0.35, 0.45]});
  const brick = simpleMat(scene, {color:[0.70, 0.55, 0.50]});

  // Roads
  for (let row = -2; row <= 2; row++) {
    const road = BABYLON.MeshBuilder.CreateBox('road' + row, { 
      width: 300, height: 0.05, depth: 10 
    }, scene);
    road.position.set(0, 0, row * 35);
    road.material = asphalt;
  }

  // Sidewalks
  for (let row = -2; row <= 2; row++) {
    const sw1 = BABYLON.MeshBuilder.CreateBox('sw1' + row, { 
      width: 300, height: 0.08, depth: 3 
    }, scene);
    sw1.position.set(0, 0.04, row * 35 + 7);
    sw1.material = sidewalkMat;
    
    const sw2 = sw1.clone('sw2' + row);
    sw2.position.z = row * 35 - 7;
  }

  // Canals
  for (let row = -2; row <= 2; row++) {
    if (row % 2 === 0) {
      const c1 = BABYLON.MeshBuilder.CreateBox('c1' + row, { 
        width: 300, height: 0.03, depth: 5 
      }, scene);
      c1.position.set(0, 0, row * 35 + 15);
      c1.material = water;
      
      const c2 = c1.clone('c2' + row);
      c2.position.z = row * 35 - 15;
    }
  }

  // Buildings - SMALLER and SPREAD OUT so avatars have space
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      // Skip center area and some positions for open space
      if (x === 0 && z === 0) continue;
      if (Math.abs(x) === 1 && Math.abs(z) === 1) continue;
      
      const h = 8 + Math.random() * 10;
      const building = BABYLON.MeshBuilder.CreateBox(`b_${x}_${z}`, { 
        width: 12, height: h, depth: 12 
      }, scene);
      // Position buildings ABOVE ground
      building.position.set(x * 30, h / 2 + 0.1, z * 30);
      building.material = brick;
    }
  }

  // A few bikes
  const bikeMat = simpleMat(scene, {color:[0.25, 0.25, 0.25]});
  for (let i = -2; i <= 2; i++) {
    if (Math.random() > 0.5) continue;
    const bike = BABYLON.MeshBuilder.CreateCylinder(`bike${i}`, {
      height: 0.6, diameter: 0.08
    }, scene);
    bike.rotation.z = Math.PI / 2;
    bike.position.set(i * 25, 0.3, 5);
    bike.material = bikeMat;
  }

  console.log('[City] Complete');
}

function buildAvatar(name, emoji) {
  const scene = state.scene;
  const root = new BABYLON.TransformNode('a_' + name, scene);
  
  // Simple capsule - BRIGHT GREEN so it's visible
  const body = BABYLON.MeshBuilder.CreateCapsule('cap_' + name, {
    radius: 0.35, 
    height: 1.4
  }, scene);
  body.material = simpleMat(scene, {
    color:[0.1, 0.95, 0.7],
    emissive:[0.02, 0.2, 0.15]  // Slight glow
  });
  body.parent = root;
  body.position.y = 0.7;  // CRITICAL: Raise capsule above ground
  
  // Label
  const label = makeLabel(name, emoji);
  label.parent = root;
  
  return root;
}

function makeLabel(name, emoji) {
  const scene = state.scene;
  const plane = BABYLON.MeshBuilder.CreatePlane('lbl_' + name, {
    width: 2, height: 0.5
  }, scene);
  plane.position.y = 2.2;  // Above the capsule
  plane.isPickable = false;
  plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
  
  const tex = BABYLON.DynamicTexture.CreateForMesh(plane, {
    width: 512, height: 128
  }, false);
  
  const ctx = tex.getContext();
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#00ff88';
  ctx.font = 'bold 48px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const displayName = emoji ? `${emoji} ${name}` : name;
  ctx.fillText(displayName, 256, 64);
  tex.update();
  
  const mat = new BABYLON.StandardMaterial('lblm_' + name, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.emissiveColor = new BABYLON.Color3(0.3, 0.3, 0.3);
  mat.opacityTexture = tex;
  mat.backFaceCulling = false;
  plane.material = mat;
  return plane;
}

function tagPickableRecursive(mesh, entityId, name) {
  if (!mesh) return;
  mesh.metadata = { entityId, name };
  mesh.isPickable = true;
  if (mesh.getChildMeshes) {
    mesh.getChildMeshes().forEach(ch => {
      ch.metadata = { entityId, name };
      ch.isPickable = true;
    });
  }
}

function addEntityBuffered(id, x, z, name, avatar) {
  if (state.entities.has(id)) return;
  if (!state.avatarReady) {
    state.pendingSpawns.push({id, x, z, name, avatar});
    return;
  }
  reallyAddEntity(id, x, z, name, avatar);
}

function reallyAddEntity(id, x, z, name, avatar) {
  const node = buildAvatar(name || id, avatar);
  // IMPORTANT: Y = 0 is ground level, avatar is raised in buildAvatar
  node.position = new BABYLON.Vector3(x || 0, 0, z || 0);
  tagPickableRecursive(node, id, name || id);
  
  state.entities.set(id, {
    node,
    name: name || id,
    avatar: avatar || '🙂',
    target: node.position.clone()
  });
  
  console.log('[Entity] Added:', name, 'at', x, z);
}

function removeEntity(id) {
  const e = state.entities.get(id);
  if (!e) return;
  e.node.dispose();
  state.entities.delete(id);
}

const keys = {};

function setupControls() {
  window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
  window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

  ui.sendBtn.onclick = () => {
    const text = ui.msg.value.trim();
    if (!text) return;
    sendMessage(text);
    ui.msg.value = '';
  };

  ui.msg.addEventListener('keydown', e => {
    if (e.key === 'Enter') ui.sendBtn.click();
  });

  const avatarList = ['🙂','😀','🙃','😎','🧑','👩','👨','🧔','👱‍♀️','👱‍♂️','🧕','👳'];
  avatarList.forEach(emoji => {
    const d = document.createElement('div');
    d.className = 'av';
    d.textContent = emoji;
    d.onclick = () => {
      document.querySelectorAll('.av').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      state.avatarEmoji = emoji;
      ui.startBtn.disabled = !ui.nameInput.value.trim();
    };
    ui.avatars.appendChild(d);
  });

  ui.nameInput.oninput = () => {
    ui.startBtn.disabled = !ui.nameInput.value.trim();
  };

  ui.startBtn.addEventListener('click', () => {
    state.username = ui.nameInput.value.trim();
    state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    ui.overlay.style.display = 'none';
    connectWS();
  });
}

function tickMovement(dt) {
  if (!state.player) return;
  const me = state.player;
  const sprint = keys['shift'] ? 1.8 : 1.0;
  const speed = 5 * sprint;

  const vx = (keys['d'] || keys['arrowright'] ? 1 : 0) - 
             (keys['a'] || keys['arrowleft'] ? 1 : 0);
  const vz = (keys['s'] || keys['arrowdown'] ? 1 : 0) - 
             (keys['w'] || keys['arrowup'] ? 1 : 0);

  if (!vx && !vz) return;

  const delta = new BABYLON.Vector3(vx, 0, vz).normalize().scale(speed * dt);
  const pos = me.node.position.add(delta);
  pos.x = BABYLON.Scalar.Clamp(pos.x, -140, 140);
  pos.z = BABYLON.Scalar.Clamp(pos.z, -140, 140);
  me.node.position.copyFrom(pos);

  // Camera follow smoothly
  const targetPos = new BABYLON.Vector3(pos.x, 1, pos.z);
  state.camera.target = BABYLON.Vector3.Lerp(state.camera.target, targetPos, 0.12);

  const now = performance.now();
  if (!tickMovement.last || now - tickMovement.last > 90) {
    tickMovement.last = now;
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'move', x: pos.x, z: pos.z }));
    }
  }
}

function interpolateRemotes() {
  state.entities.forEach((e, id) => {
    if (id === state.playerId) return;
    if (!e.target) return;
    e.node.position = BABYLON.Vector3.Lerp(e.node.position, e.target, 0.15);
  });
}

function setupContextMenu(scene) {
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const pick = scene.pick(ev.clientX, ev.clientY, m => !!m.metadata?.entityId);
    const menu = ui.rightMenu;
    menu.style.left = ev.clientX + 'px';
    menu.style.top = ev.clientY + 'px';
    menu.style.display = 'block';

    if (pick && pick.hit && pick.pickedMesh?.metadata?.entityId) {
      const id = pick.pickedMesh.metadata.entityId;
      const ent = state.entities.get(id);
      ui.mChat.textContent = '💬 Chat met ' + (ent?.name || 'onbekend');
      ui.mReport.textContent = '⚠️ Rapporteer ' + (ent?.name || 'onbekend');
      ui.mChat.onclick = () => {
        state.targetId = id;
        ui.targetName.textContent = ent?.name || 'Openbaar';
        menu.style.display = 'none';
      };
      ui.mReport.onclick = () => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'report', reportedId: id }));
        }
        menu.style.display = 'none';
      };
    } else {
      ui.mChat.textContent = 'Geen avatar hier';
      ui.mReport.textContent = '—';
      ui.mChat.onclick = () => menu.style.display = 'none';
      ui.mReport.onclick = () => menu.style.display = 'none';
    }
    ui.mClear.onclick = () => {
      state.targetId = null;
      ui.targetName.textContent = 'Openbaar';
      menu.style.display = 'none';
    };

    setTimeout(() => {
      window.addEventListener('click', () => menu.style.display = 'none', { once: true });
    }, 100);
  });
}

function setupMinimap(scene) {
  const ctx = ui.minimapCanvas.getContext('2d');
  ui.minimapCanvas.width = 200;
  ui.minimapCanvas.height = 200;
}

function updateMinimap() {
  const canvas = ui.minimapCanvas;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(10, 15, 24, 0.95)';
  ctx.fillRect(0, 0, 200, 200);
  
  ctx.strokeStyle = '#1a2d3a';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const pos = i * 20;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, 200);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, pos);
    ctx.lineTo(200, pos);
    ctx.stroke();
  }
  
  state.entities.forEach((ent, id) => {
    const x = ((ent.node.position.x + 100) / 200) * 200;
    const z = ((ent.node.position.z + 100) / 200) * 200;
    const isMe = id === state.playerId;
    ctx.fillStyle = isMe ? '#00ff88' : '#ff8844';
    ctx.beginPath();
    ctx.arc(x, z, isMe ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
    if (isMe) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, z, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

function connectWS() {
  console.log('[WS] Connecting...');
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', () => {
    console.log('[WS] Connected');
    ui.conn.textContent = '● Connected';
    ui.conn.style.color = '#00ff88';
    state.ws.send(JSON.stringify({
      type: 'join', 
      playerId: state.playerId,
      username: state.username, 
      avatar: state.avatarEmoji, 
      x: 0, 
      z: 0
    }));
    addLine('SYSTEM:', 'Verbonden', false, true);
  });

  state.ws.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch(err) { return; }

    switch(data.type) {
      case 'init':
        console.log('[WS] Init:', data.players.length, 'players,', data.npcs.length, 'NPCs');
        
        // Add ALL players
        data.players.forEach(p => {
          console.log('[Init] Creating player:', p.username, 'at', p.x, p.z);
          addEntityBuffered(p.id, p.x, p.z, p.username, p.avatar);
        });
        
        // Add ALL NPCs
        data.npcs.forEach(n => {
          console.log('[Init] Creating NPC:', n.name, 'at', n.x, n.z);
          addEntityBuffered(n.id, n.x, n.z, n.name, '🤖');
        });
        
        // Make sure player exists
        state.player = state.entities.get(state.playerId);
        if (!state.player) {
          console.log('[Init] Player not found, creating...');
          addEntityBuffered(state.playerId, 0, 0, state.username, state.avatarEmoji);
          state.player = state.entities.get(state.playerId);
        }
        
        if (state.player) {
          state.camera.target.copyFrom(state.player.node.position);
          console.log('[Init] Player ready at', state.player.node.position);
        }
        
        if (data.weather) {
          updateWeather(data.weather.type, data.weather.intensity);
          updateTimeOfDay(data.weather.gameTime);
        }
        
        ui.statPlayers.textContent = data.players.length;
        console.log('[Init] Complete! Total entities:', state.entities.size);
        break;

      case 'player_joined':
        if (data.player.id === state.playerId) break;
        console.log('[Join]', data.player.username);
        addEntityBuffered(data.player.id, data.player.x, data.player.z, 
          data.player.username, data.player.avatar);
        addLine('SYSTEM:', `${data.player.username} joined`, false, true);
        ui.statPlayers.textContent = parseInt(ui.statPlayers.textContent) + 1;
        break;

      case 'player_left':
        removeEntity(data.playerId);
        ui.statPlayers.textContent = Math.max(0, parseInt(ui.statPlayers.textContent) - 1);
        break;

      case 'player_move':
        const ent = state.entities.get(data.playerId);
        if (ent) ent.target = new BABYLON.Vector3(data.x, 0, data.z);
        break;

      case 'npc_update':
        data.npcs.forEach(npc => {
          const ent = state.entities.get(npc.id);
          if (ent) {
            ent.target = new BABYLON.Vector3(npc.x, 0, npc.z);
          }
        });
        break;

      case 'chat':
        const isPrivate = data.private || false;
        if (isPrivate) {
          addLine(`${data.username} (privé):`, data.message, true);
        } else {
          addLine(`${data.username}:`, data.message);
        }
        break;

      case 'penalty':
        updateCredits(data.amount, data.reason);
        break;

      case 'report_result':
        state.stats.reportsTotal++;
        if (data.correct) {
          state.stats.reportsCorrect++;
          updateCredits(50, `Correct! ${data.reportedName}`);
        } else {
          updateCredits(-30, `Onjuist: ${data.reportedName}`);
        }
        updateStats();
        break;

      case 'weather_update':
        updateWeather(data.weather, data.intensity);
        break;

      case 'time_update':
        updateTimeOfDay(data.gameTime);
        break;

      case 'system':
        addLine('SYSTEM:', data.message, false, true);
        break;

      case 'position_correction':
        if (state.player) {
          state.player.node.position.x = data.x;
          state.player.node.position.z = data.z;
        }
        break;
    }
  });

  state.ws.addEventListener('close', () => {
    console.log('[WS] Disconnected');
    ui.conn.textContent = '● Reconnecting...';
    ui.conn.style.color = '#ff8800';
    addLine('SYSTEM:', 'Reconnecting...', false, true);
    setTimeout(connectWS, 2000);
  });
}

console.log('[Game] Starting...');
createScene().then(() => {
  console.log('[Game] Scene ready!');
}).catch(e => {
  console.error('[Game] ERROR:', e);
});
