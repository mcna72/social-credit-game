// public/app.js — FIXED Enhanced client with better error handling
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
  shadow: null,

  entities: new Map(),
  player: null,

  avatarReady: false,
  avatarTemplate: null,
  pendingSpawns: [],

  weather: { type: 'clear', intensity: 1 },
  gameTime: 12.0,
  
  stats: {
    reportsTotal: 0,
    reportsCorrect: 0
  }
};

// ---------- Utility Functions ----------
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function addLine(user, text, isPrivate = false, isSystem = false) {
  const div = document.createElement('div');
  div.className = 'line' + (isPrivate ? ' private' : '') + (isSystem ? ' system' : '');
  div.innerHTML = `<span class="user">${escapeHtml(user)}</span> ${escapeHtml(text)}`;
  ui.chatlog.appendChild(div);
  ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  
  while (ui.chatlog.children.length > 200) {
    ui.chatlog.removeChild(ui.chatlog.firstChild);
  }
}

function sendMessage(text){
  if (!text || !text.trim()) return;
  
  const payload = { type:'chat', message: text.trim() };
  if (state.targetId) payload.targetId = state.targetId;
  
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function updateCredits(amount, reason) {
  state.credits += amount;
  ui.credit.textContent = state.credits;
  ui.credit.style.color = state.credits < 500 ? '#ff4444' : '#00ff88';
  
  if (reason) {
    addLine('SYSTEM:', reason, false, true);
  }
}

function updateStats() {
  ui.statReports.textContent = state.stats.reportsTotal;
  
  const accuracy = state.stats.reportsTotal > 0 ? 
    ((state.stats.reportsCorrect / state.stats.reportsTotal) * 100).toFixed(0) + '%' :
    '--';
  ui.statAccuracy.textContent = accuracy;
}

// ---------- Weather & Time ----------
function updateWeather(type, intensity) {
  state.weather = { type, intensity };
  
  const icons = {
    clear: '☀️',
    cloudy: '☁️',
    rain: '🌧️',
    fog: '🌫️'
  };
  
  ui.weatherIcon.textContent = icons[type] || '☀️';
  
  if (state.scene) {
    const fogDensities = {
      fog: 0.012,
      rain: 0.006,
      cloudy: 0.004,
      clear: 0.002
    };
    state.scene.fogDensity = (fogDensities[type] || 0.002) * intensity;
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
      const sunAngle = (gameTime / 24) * Math.PI * 2 - Math.PI / 2;
      sun.direction = new BABYLON.Vector3(
        Math.cos(sunAngle),
        -Math.sin(sunAngle),
        -0.2
      );
      
      if (gameTime < 6 || gameTime > 20) {
        sun.diffuse = new BABYLON.Color3(0.3, 0.4, 0.6);
        sun.intensity = 0.2;
        state.scene.lights.forEach(l => {
          if (l.name.startsWith('L')) l.intensity = 0.8;
        });
      } else if (gameTime < 8 || gameTime > 18) {
        sun.diffuse = new BABYLON.Color3(1, 0.7, 0.5);
        sun.intensity = 0.6;
        state.scene.lights.forEach(l => {
          if (l.name.startsWith('L')) l.intensity = 0.4;
        });
      } else {
        sun.diffuse = new BABYLON.Color3(1, 0.95, 0.9);
        sun.intensity = 1.25;
        state.scene.lights.forEach(l => {
          if (l.name.startsWith('L')) l.intensity = 0.1;
        });
      }
    }
  }
}

// ---------- Babylon Scene Setup ----------
const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas, true, { 
  preserveDrawingBuffer: true, 
  stencil: true,
  antialias: true 
}, true);
state.engine = engine;

const createScene = async () => {
  console.log('[Scene] Creating...');
  
  try {
    const scene = new BABYLON.Scene(engine);
    state.scene = scene;

    // Image processing
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.2;
    ip.contrast = 1.1;
    scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.10, 1);

    // 3rd-person camera
    const cam = new BABYLON.ArcRotateCamera('cam',
      BABYLON.Tools.ToRadians(-35),
      BABYLON.Tools.ToRadians(55),
      45, 
      new BABYLON.Vector3(0, 2, 0), 
      scene
    );
    cam.attachControl(canvas, true);
    cam.wheelPrecision = 20;
    cam.panningSensibility = 500;
    cam.lowerRadiusLimit = 10;
    cam.upperRadiusLimit = 120;
    cam.lowerBetaLimit = BABYLON.Tools.ToRadians(15);
    cam.upperBetaLimit = BABYLON.Tools.ToRadians(89);
    cam.keysUp = cam.keysDown = cam.keysLeft = cam.keysRight = [];
    state.camera = cam;

    console.log('[Scene] Camera created');

    // Lights
    const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.5;
    hemi.groundColor = new BABYLON.Color3(0.3, 0.3, 0.4);
    
    const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.3, -1, -0.2), scene);
    sun.position = new BABYLON.Vector3(60, 80, 60);
    sun.intensity = 1.25;
    
    const shadow = new BABYLON.ShadowGenerator(2048, sun);
    shadow.useExponentialShadowMap = true;
    shadow.darkness = 0.4;
    state.shadow = shadow;

    console.log('[Scene] Lights created');

    // Environment & fog
    try {
      scene.environmentTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(
        'https://assets.babylonjs.com/environments/environmentSpecular.env', 
        scene
      );
    } catch(e) {
      console.warn('[Scene] Environment texture failed, continuing...', e);
    }
    
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.002;
    scene.fogColor = new BABYLON.Color3(0.02, 0.04, 0.10);

    // Build city
    buildCity(scene);
    console.log('[Scene] City built');

    // Post-processing
    try {
      const pipeline = new BABYLON.DefaultRenderingPipeline("pipe", true, scene, [cam]);
      pipeline.fxaaEnabled = true;
      pipeline.bloomEnabled = true;
      pipeline.bloomWeight = 0.22;
      pipeline.bloomThreshold = 0.8;
      pipeline.samples = 4;
      console.log('[Scene] Pipeline created');
    } catch(e) {
      console.warn('[Scene] Pipeline failed, continuing without...', e);
    }

    // Avatar template
    loadAvatarTemplate(scene);

    // Setup minimap
    setupMinimap(scene);

    // Right-click menu
    setupContextMenu(scene);

    // Input controls
    setupControls();

    // Render loop
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
    
    console.log('[Scene] Complete!');
    return scene;
    
  } catch(e) {
    console.error('[Scene] CRITICAL ERROR:', e);
    alert('Failed to create 3D scene. Check console for details.');
  }
};

// ---------- City Building ----------
function pbr(scene, {albedo=[1,1,1], rough=0.9, metal=0} = {}) {
  const m = new BABYLON.PBRMaterial('m' + Math.random(), scene);
  m.albedoColor = new BABYLON.Color3(...albedo);
  m.roughness = rough;
  m.metallic = metal;
  return m;
}

function buildCity(scene) {
  console.log('[City] Building...');
  
  // Ground
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { 
    width: 600, 
    height: 600,
    subdivisions: 4
  }, scene);
  ground.material = pbr(scene, {albedo:[0.93, 0.95, 0.97], rough:0.95});
  ground.receiveShadows = true;

  // Materials
  const asphalt = pbr(scene, {albedo:[0.12, 0.12, 0.14], rough:0.6, metal:0.1});
  const sidewalk = pbr(scene, {albedo:[0.70, 0.71, 0.74], rough:0.85});
  const brick = pbr(scene, {albedo:[0.78, 0.66, 0.60], rough:0.9});
  const poleMat = pbr(scene, {albedo:[0.2, 0.2, 0.22], rough:0.7, metal:0.3});

  // Roads & sidewalks
  for (let row = -4; row <= 4; row++) {
    const y = 0.03;
    const road = BABYLON.MeshBuilder.CreateBox('road' + row, { 
      width: 600, height: 0.06, depth: 16 
    }, scene);
    road.position.set(0, y, row * 50);
    road.material = asphalt;
    road.receiveShadows = true;

    const sw1 = BABYLON.MeshBuilder.CreateBox('swA' + row, { 
      width: 600, height: 0.10, depth: 5 
    }, scene);
    sw1.position.set(0, 0.05, row * 50 + 11);
    sw1.material = sidewalk;
    
    const sw2 = sw1.clone('swB' + row);
    sw2.position.z = row * 50 - 11;
  }

  // Canals - with fallback
  try {
    if (typeof BABYLON.WaterMaterial !== 'undefined') {
      console.log('[City] Creating animated water...');
      const waterMat = new BABYLON.WaterMaterial('water', scene);
      waterMat.bumpTexture = new BABYLON.Texture(
        'https://assets.babylonjs.com/textures/waterbump.png', 
        scene
      );
      
      waterMat.windForce = -8;
      waterMat.waveHeight = 0.2;
      waterMat.bumpHeight = 0.08;
      waterMat.windDirection = new BABYLON.Vector2(1, 0.5);
      waterMat.waterColor = new BABYLON.Color3(0.12, 0.28, 0.38);
      waterMat.colorBlendFactor = 0.25;
      
      waterMat.addToRenderList(ground);
      
      for (let row = -4; row <= 4; row++) {
        if (row % 2 === 0) {
          const c1 = BABYLON.MeshBuilder.CreateGround(`canal1_${row}`, { 
            width: 600, height: 8, subdivisions: 32 
          }, scene);
          c1.position.set(0, 0.05, row * 50 + 23);
          c1.material = waterMat;
          
          const c2 = c1.clone(`canal2_${row}`);
          c2.position.z = row * 50 - 23;
          c2.material = waterMat;
        }
      }
    } else {
      throw new Error('WaterMaterial not available');
    }
  } catch(e) {
    console.warn('[City] Using fallback water:', e.message);
    // Fallback simple water
    const water = pbr(scene, {albedo:[0.15, 0.2, 0.3], rough:0.12, metal:1});
    for (let row = -4; row <= 4; row++) {
      if (row % 2 === 0) {
        const c1 = BABYLON.MeshBuilder.CreateBox('c1' + row, { 
          width: 600, height: 0.04, depth: 8 
        }, scene);
        c1.position.set(0, 0.02, row * 50 + 23);
        c1.material = water;
        
        const c2 = c1.clone('c2' + row);
        c2.position.z = row * 50 - 23;
      }
    }
  }

  // Buildings
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      if (Math.abs(x) % 2 === 1 && Math.abs(z) % 2 === 1) continue;
      
      const h = 8 + Math.random() * 18;
      const w = 16 + Math.random() * 8;
      const d = 16 + Math.random() * 8;
      
      const building = BABYLON.MeshBuilder.CreateBox(`b_${x}_${z}`, { 
        width: w, height: h, depth: d 
      }, scene);
      building.position.set(
        x * 45 + (Math.random() * 6 - 3), 
        h / 2, 
        z * 45 + (Math.random() * 6 - 3)
      );
      building.material = brick;
      building.receiveShadows = true;
      
      state.shadow.addShadowCaster(building);
    }
  }

  // Street lamps
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const lampNode = new BABYLON.TransformNode('lamp_' + i + '_' + j, scene);
      lampNode.position.set(i * 45, 0, j * 45 + 10);
      
      const pole = BABYLON.MeshBuilder.CreateCylinder('pole', { 
        diameter: 0.25, height: 4 
      }, scene);
      pole.material = poleMat;
      pole.position.y = 2;
      pole.parent = lampNode;
      
      const head = BABYLON.MeshBuilder.CreateBox('head', { 
        width: 0.6, height: 0.3, depth: 0.6 
      }, scene);
      head.material = poleMat;
      head.position.y = 4.1;
      head.parent = lampNode;
      
      const glow = new BABYLON.PointLight('L' + i + '_' + j, new BABYLON.Vector3(0, 4.3, 0), scene);
      glow.parent = lampNode;
      glow.intensity = 0.35;
      glow.range = 18;
      glow.diffuse = new BABYLON.Color3(1, 0.9, 0.7);
    }
  }

  // Add bikes
  addBikes(scene);
  
  console.log('[City] Complete!');
}

function addBikes(scene) {
  const bikeMat = pbr(scene, {albedo:[0.15, 0.15, 0.18], metal:0.7, rough:0.5});
  const wheelMat = pbr(scene, {albedo:[0.1, 0.1, 0.1], metal:0.2, rough:0.9});
  
  for (let i = -5; i <= 5; i++) {
    for (let j = -5; j <= 5; j++) {
      if (Math.random() > 0.35) continue;
      
      const bike = new BABYLON.TransformNode(`bike_${i}_${j}`, scene);
      
      const frame = BABYLON.MeshBuilder.CreateCylinder('frame', {
        height: 0.9, diameter: 0.04
      }, scene);
      frame.rotation.z = Math.PI / 4;
      frame.position.y = 0.45;
      frame.material = bikeMat;
      frame.parent = bike;
      
      const wheel1 = BABYLON.MeshBuilder.CreateTorus('wheel', {
        diameter: 0.5, thickness: 0.04
      }, scene);
      wheel1.rotation.x = Math.PI / 2;
      wheel1.material = wheelMat;
      wheel1.position.set(0, 0.25, 0);
      wheel1.parent = bike;
      
      const wheel2 = wheel1.clone('wheel2');
      wheel2.position.z = 0.7;
      wheel2.parent = bike;
      
      bike.position.set(
        i * 45 + (Math.random() * 6 - 3),
        0,
        j * 45 + 10 + (Math.random() * 2 - 1)
      );
      bike.rotation.y = Math.random() * Math.PI * 2;
      bike.scaling = new BABYLON.Vector3(1.2, 1.2, 1.2);
    }
  }
}

// ---------- Avatar System ----------
async function loadAvatarTemplate(scene) {
  const URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb";
  
  try {
    console.log('[Avatar] Loading template...');
    const cont = await BABYLON.SceneLoader.LoadAssetContainerAsync(URL, undefined, scene);
    const root = new BABYLON.TransformNode("avatarTemplate", scene);
    
    cont.meshes.forEach(m => {
      m.setEnabled(false);
      m.parent = root;
      m.alwaysSelectAsActiveMesh = true;
      m.receiveShadows = true;
      
      state.shadow.addShadowCaster(m);
    });
    
    state.avatarTemplate = root;
    state.avatarReady = true;
    console.log('[Avatar] Template loaded');
  } catch(e) {
    console.warn('[Avatar] Using fallback capsule', e);
    state.avatarTemplate = null;
    state.avatarReady = true;
  }
  
  // Process pending spawns
  state.pendingSpawns.splice(0).forEach(s => reallyAddEntity(s.id, s.x, s.z, s.name, s.avatar));
}

function buildAvatar(name, emoji) {
  const scene = state.scene;
  let root;
  
  if (state.avatarTemplate) {
    root = state.avatarTemplate.clone('a_' + name);
    root.getChildMeshes().forEach(m => m.setEnabled(true));
  } else {
    // Fallback capsule
    root = new BABYLON.TransformNode('a_' + name, scene);
    const body = BABYLON.MeshBuilder.CreateCapsule('cap_' + name, {
      radius: 0.45, height: 1.7
    }, scene);
    
    const mat = new BABYLON.PBRMaterial('bmat_' + name, scene);
    mat.albedoColor = new BABYLON.Color3(0.02, 0.95, 0.65);
    mat.roughness = 0.5;
    body.material = mat;
    body.parent = root;
    body.receiveShadows = true;
    
    state.shadow.addShadowCaster(body);
  }
  
  // Label
  const label = makeLabel(name, emoji);
  label.parent = root;
  
  return root;
}

function makeLabel(name, emoji) {
  const scene = state.scene;
  const plane = BABYLON.MeshBuilder.CreatePlane('lbl_' + name, {
    width: 1.8, height: 0.45
  }, scene);
  plane.position.y = 2.6;
  plane.isPickable = false;
  plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
  
  const tex = BABYLON.DynamicTexture.CreateForMesh(plane, {
    width: 512, height: 128
  }, false);
  
  const ctx = tex.getContext();
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
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

// ---------- Input & Movement ----------
const keys = {};

function setupControls() {
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
  });
  
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
  });

  ui.sendBtn.onclick = () => {
    const text = ui.msg.value.trim();
    if (!text) return;
    sendMessage(text);
    ui.msg.value = '';
  };

  ui.msg.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      ui.sendBtn.click();
    }
  });

  // Avatar selection
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
  
  pos.x = BABYLON.Scalar.Clamp(pos.x, -290, 290);
  pos.z = BABYLON.Scalar.Clamp(pos.z, -290, 290);
  
  me.node.position.copyFrom(pos);

  // Camera follow
  state.camera.target = BABYLON.Vector3.Lerp(
    state.camera.target,
    new BABYLON.Vector3(pos.x, 2, pos.z),
    0.08
  );

  // Send position (throttled)
  const now = performance.now();
  if (!tickMovement.last || now - tickMovement.last > 90) {
    tickMovement.last = now;
    
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ 
        type: 'move', 
        x: pos.x, 
        z: pos.z 
      }));
    }
  }
}

function interpolateRemotes() {
  state.entities.forEach((e, id) => {
    if (id === state.playerId) return;
    if (!e.target) return;
    
    e.node.position = BABYLON.Vector3.Lerp(
      e.node.position,
      e.target,
      0.15
    );
  });
}

// ---------- Context Menu ----------
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
          state.ws.send(JSON.stringify({
            type: 'report',
            reportedId: id
          }));
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

    const closeMenu = () => menu.style.display = 'none';
    setTimeout(() => {
      window.addEventListener('click', closeMenu, { once: true });
    }, 100);
  });
}

// ---------- Minimap ----------
function setupMinimap(scene) {
  const ctx = ui.minimapCanvas.getContext('2d');
  ui.minimapCanvas.width = 200;
  ui.minimapCanvas.height = 200;
}

function updateMinimap() {
  const canvas = ui.minimapCanvas;
  const ctx = canvas.getContext('2d');
  
  // Clear
  ctx.fillStyle = 'rgba(10, 15, 24, 0.95)';
  ctx.fillRect(0, 0, 200, 200);
  
  // Grid
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
  
  // Draw entities
  state.entities.forEach((ent, id) => {
    const x = ((ent.node.position.x + 100) / 200) * 200;
    const z = ((ent.node.position.z + 100) / 200) * 200;
    
    const isMe = id === state.playerId;
    
    ctx.fillStyle = isMe ? '#00ff88' : '#888';
    ctx.beginPath();
    ctx.arc(x, z, isMe ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    
    if (isMe) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, z, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

// ---------- WebSocket ----------
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
    
    addLine('SYSTEM:', 'Verbonden met server. Wereld laden...', false, true);
  });

  state.ws.addEventListener('message', (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch(err) {
      console.error('[WS] Parse error', err);
      return;
    }

    switch(data.type) {
      case 'init': {
        console.log('[WS] Init received -', data.players.length, 'players,', data.npcs.length, 'NPCs');
        
        // Create all players
        data.players.forEach(p => {
          addEntityBuffered(p.id, p.x, p.z, p.username, p.avatar);
        });
        
        // Create NPCs
        data.npcs.forEach(n => {
          addEntityBuffered(n.id, n.x, n.z, n.name);
        });
        
        // Set player reference
        state.player = state.entities.get(state.playerId);
        if (!state.player) {
          addEntityBuffered(state.playerId, 0, 0, state.username, state.avatarEmoji);
          state.player = state.entities.get(state.playerId);
        }
        
        if (state.player) {
          state.camera.target.copyFrom(state.player.node.position);
          console.log('[WS] Player spawned at', state.player.node.position);
        }
        
        // Weather & time
        if (data.weather) {
          updateWeather(data.weather.type, data.weather.intensity);
          updateTimeOfDay(data.weather.gameTime);
        }
        
        // Update stats
        ui.statPlayers.textContent = data.players.length;
        
        break;
      }

      case 'player_joined':
        if (data.player.id === state.playerId) break;
        
        addEntityBuffered(
          data.player.id,
          data.player.x,
          data.player.z,
          data.player.username,
          data.player.avatar
        );
        
        addLine('SYSTEM:', `${data.player.username} heeft zich aangesloten`, false, true);
        
        ui.statPlayers.textContent = parseInt(ui.statPlayers.textContent) + 1;
        break;

      case 'player_left':
        removeEntity(data.playerId);
        ui.statPlayers.textContent = Math.max(0, parseInt(ui.statPlayers.textContent) - 1);
        break;

      case 'player_move': {
        const ent = state.entities.get(data.playerId);
        if (ent) {
          ent.target = new BABYLON.Vector3(data.x, 0, data.z);
        }
        break;
      }

      case 'npc_update':
        data.npcs.forEach(npc => {
          const ent = state.entities.get(npc.id);
          if (ent) {
            ent.target = new BABYLON.Vector3(npc.x, 0, npc.z);
          }
        });
        break;

      case 'chat': {
        const isPrivate = data.private || false;
        const sender = data.username;
        const msg = data.message;
        
        if (isPrivate) {
          addLine(`${sender} (privé):`, msg, true);
        } else {
          addLine(`${sender}:`, msg);
        }
        break;
      }

      case 'penalty':
        updateCredits(data.amount, data.reason);
        break;

      case 'report_result':
        state.stats.reportsTotal++;
        if (data.correct) {
          state.stats.reportsCorrect++;
          updateCredits(50, `Correct! ${data.reportedName} is een echte speler`);
        } else {
          updateCredits(-30, `Onjuist rapport over ${data.reportedName}`);
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
    
    addLine('SYSTEM:', 'Verbinding verbroken. Opnieuw verbinden...', false, true);
    
    setTimeout(connectWS, 2000);
  });

  state.ws.addEventListener('error', (err) => {
    console.error('[WS] Error', err);
  });
}

// ---------- Initialize ----------
console.log('[Game] Starting...');
createScene().then(() => {
  console.log('[Game] Ready!');
}).catch(e => {
  console.error('[Game] Failed to start:', e);
  alert('Game failed to start. Check browser console (F12) for details.');
});
