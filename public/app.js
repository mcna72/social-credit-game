// public/app.js
// Three.js client for Social Credit — Amsterdam (Enhanced)
// - Flat maze world (no ugly boxes), city-like background
// - Third-person camera, A/D left-right, W forward, S backward
// - Avatar collision with maze walls (AABB) + sliding
// - Name tags via CSS2DRenderer
// - Context menu for public/private chat + report
// - Private chat only if within 5x avatar size distance
// - Minimap, HUD, WS networking, NPC updates, weather/time, scoring

import * as THREE from 'https://unpkg.com/three@0.159.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.159.0/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.159.0/examples/jsm/renderers/CSS2DRenderer.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// ---------- UI ----------
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
  // intentionally NOT filling statPlayers to keep number of real players hidden
  loadingSpinner: document.getElementById('loadingSpinner')
};

// ---------- State ----------
const state = {
  ws: null,
  playerId: null,
  username: '',
  avatarEmoji: '🙂',
  lang: 'nl',
  targetId: null,
  credits: 1000,

  // three
  renderer: null,
  labelRenderer: null,
  scene: null,
  camera: null,
  controls: null,
  clock: new THREE.Clock(),

  // world
  mazeWalls: [], // [{mesh,min,max}]
  ground: null,

  // player & entities
  entities: new Map(), // id -> { node, tag, name, avatar, target }
  player: null,

  // movement
  keys: {},
  AVATAR_SIZE: 1.0, // unit height basis
  AVATAR_RADIUS: 0.4,
  AVATAR_HEIGHT: 1.7,

  // misc
  weather: { type: 'clear', intensity: 1 },
  gameTime: 12.0,

  stats: { reportsTotal: 0, reportsCorrect: 0 },
};

const CHAT_DISTANCE = 5 * state.AVATAR_SIZE; // private chat only if within this

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
function addLine(user, text, isPrivate = false, isSystem = false) {
  const div = document.createElement('div');
  div.className = 'line' + (isPrivate ? ' private' : '') + (isSystem ? ' system' : '');
  div.innerHTML = `<span class="user">${escapeHtml(user)}</span> ${escapeHtml(text)}`;
  ui.chatlog.appendChild(div);
  ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  while (ui.chatlog.children.length > 200) ui.chatlog.removeChild(ui.chatlog.firstChild);
}
function updateCredits(amount, reason) {
  state.credits += amount;
  ui.credit.textContent = state.credits;
  ui.credit.style.color = state.credits < 500 ? '#ff4444' : '#00ff88';
  if (reason) addLine('SYSTEM:', reason, false, true);
}
function updateStats() {
  ui.statReports.textContent = state.stats.reportsTotal;
  ui.statAccuracy.textContent = state.stats.reportsTotal > 0
    ? `${((state.stats.reportsCorrect / state.stats.reportsTotal) * 100).toFixed(0)}%` : '--';
}
function clamp(v, min, max){ return Math.min(max, Math.max(min, v)); }

// ---------- Weather & Time ----------
function updateWeather(type, intensity) {
  state.weather = { type, intensity };
  const icons = { clear:'☀️', cloudy:'☁️', rain:'🌧️', fog:'🌫️' };
  ui.weatherIcon.textContent = icons[type] || '☀️';
}
function updateTimeOfDay(gameTime) {
  state.gameTime = gameTime;
  const hour = Math.floor(gameTime);
  const min = Math.floor((gameTime - hour) * 60);
  ui.timeDisplay.textContent = `${hour.toString().padStart(2,'0')}:${min.toString().padStart(2,'0')}`;
}

// ---------- Three setup ----------
const canvas = document.getElementById('renderCanvas'); // provided by index.html
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
state.renderer = renderer;

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'fixed';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);
state.labelRenderer = labelRenderer;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1324);
state.scene = scene;

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 2000);
camera.position.set(0, 8, 12);
state.camera = camera;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6;
controls.maxDistance = 60;
controls.minPolarAngle = THREE.MathUtils.degToRad(15);
controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
state.controls = controls;

// Lights (simple)
{
  const hemi = new THREE.HemisphereLight(0xffffff, 0x334466, 0.6);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(30, 50, 20);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024,1024);
  scene.add(dir);
}

// ---------- World (maze) ----------
const maze = {
  // simple generated corridors
  size: 500, // ground size
  wallHeight: 1.4,
  wallThickness: 2.5,
  cell: 24, // grid cell size
};

const mazeWalls = []; // {mesh,min,max}
state.mazeWalls = mazeWalls;

function addWall(x, z, w, d) {
  const h = maze.wallHeight;
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.MeshStandardMaterial({ color: 0x889199, metalness: 0.0, roughness: 0.9 });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, h/2, z);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData.isMazeWall = true;
  scene.add(mesh);
  // pre-bake AABB
  mesh.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(mesh);
  mazeWalls.push({ mesh, min: box.min.clone(), max: box.max.clone() });
  return mesh;
}

function buildMaze() {
  // ground
  const g = new THREE.PlaneGeometry(maze.size, maze.size);
  const m = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, metalness:0, roughness:1 });
  const ground = new THREE.Mesh(g, m);
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);
  state.ground = ground;

  // create border walls
  const half = maze.size / 2;
  addWall(0, -half + maze.wallThickness/2, maze.size, maze.wallThickness);
  addWall(0,  half - maze.wallThickness/2, maze.size, maze.wallThickness);
  addWall(-half + maze.wallThickness/2, 0, maze.wallThickness, maze.size);
  addWall( half - maze.wallThickness/2, 0, maze.wallThickness, maze.size);

  // procedural corridors: rectangular blocks
  const rows = 9, cols = 9;
  const gap = maze.cell;
  const startX = -half + 80;
  const startZ = -half + 80;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // random skip to create corridors
      if ((r+c)%2===0) continue;
      if (Math.random() < 0.35) continue;
      const x = startX + c * gap * 2;
      const z = startZ + r * gap * 2;
      const w = gap * (1.2 + Math.random()*0.8);
      const d = gap * (1.2 + Math.random()*0.8);
      addWall(x, z, w, d);
    }
  }

  // minimal city-like backplate (skyline silhouettes far away)
  const skyline = new THREE.Group();
  const skyMat = new THREE.MeshBasicMaterial({ color: 0x20263a, depthWrite:false });
  for (let i=0;i<30;i++){
    const w = 20 + Math.random()*60;
    const h = 20 + Math.random()*90;
    const d = 5 + Math.random()*10;
    const mx = (Math.random()<0.5?-1:1) * (half + 40 + Math.random()*80);
    const mz = -half + Math.random()*maze.size;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), skyMat);
    box.position.set(mx, h/2, mz);
    skyline.add(box);
  }
  skyline.renderOrder = -1;
  scene.add(skyline);
}

// ---------- Avatar ----------
function createAvatarMesh() {
  // simple robot-ish avatar (no going through walls)
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x18e2a5, metalness:0.2, roughness:0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222, metalness:0.5, roughness:0.8 });

  // body (capsule-like)
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.8, 8, 16), bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 16), dark);
  head.position.y = 0.95;
  head.castShadow = true;
  group.add(head);

  // visor
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.18, 0.05), new THREE.MeshStandardMaterial({color:0x111111, emissive:0x222222}));
  visor.position.set(0, 0.95, 0.31);
  group.add(visor);

  // legs
  const legMat = new THREE.MeshStandardMaterial({ color: 0x996633, metalness:0, roughness:0.9 });
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.09,0.60, 12), legMat);
  legL.position.set(-0.18, -0.5, 0);
  const legR = legL.clone();
  legR.position.x = 0.18;
  group.add(legL, legR);

  // scale to avatar size
  group.scale.setScalar(state.AVATAR_SIZE);
  return group;
}

function makeNameTag(displayName) {
  const div = document.createElement('div');
  div.className = 'nametag';
  div.textContent = displayName;
  const obj = new CSS2DObject(div);
  obj.position.set(0, 1.9, 0);
  return obj;
}

function addEntity(id, x, z, name, emoji) {
  if (state.entities.has(id)) return;

  const node = createAvatarMesh();
  node.position.set(x||0, 0, z||0);
  scene.add(node);

  const tag = makeNameTag((emoji? (emoji+' '):'') + (name||id));
  node.add(tag);

  state.entities.set(id, {
    node, tag,
    name: name || id,
    avatar: emoji || '🙂',
    target: node.position.clone(),
  });
}
function removeEntity(id) {
  const e = state.entities.get(id);
  if (!e) return;
  if (e.tag) e.tag.element?.remove();
  e.node?.removeFromParent();
  state.entities.delete(id);
}

// ---------- Movement & Collision ----------
function resolveCollisions(currentPos, desiredPos) {
  const pos = desiredPos.clone();
  for (const w of mazeWalls) {
    const min = new THREE.Vector3(w.min.x - state.AVATAR_RADIUS, w.min.y - 0.2, w.min.z - state.AVATAR_RADIUS);
    const max = new THREE.Vector3(w.max.x + state.AVATAR_RADIUS, w.max.y + state.AVATAR_HEIGHT, w.max.z + state.AVATAR_RADIUS);

    if (pos.x >= min.x && pos.x <= max.x &&
        currentPos.y >= min.y && currentPos.y <= max.y &&
        pos.z >= min.z && pos.z <= max.z) {

      const dx = Math.min(max.x - pos.x, pos.x - min.x);
      const dz = Math.min(max.z - pos.z, pos.z - min.z);

      if (dx < dz) {
        if ((pos.x - min.x) < (max.x - pos.x)) pos.x = min.x;
        else pos.x = max.x;
      } else {
        if ((pos.z - min.z) < (max.z - pos.z)) pos.z = min.z;
        else pos.z = max.z;
      }
    }
  }
  return pos;
}

function tickMovement(dt) {
  if (!state.player) return;
  const me = state.player;

  // camera-forward on XZ
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  camDir.y = 0; camDir.normalize();
  const right = new THREE.Vector3(camDir.z, 0, -camDir.x).normalize();

  const speed = 4.0;
  let move = new THREE.Vector3();

  // A=left, D=right, W=forward, S=back
  if (state.keys['a']) move.add(right.clone().multiplyScalar(-1));
  if (state.keys['d']) move.add(right);
  if (state.keys['w']) move.add(camDir);
  if (state.keys['s']) move.add(camDir.clone().multiplyScalar(-1));

  if (move.lengthSq() === 0) return;
  move.normalize().multiplyScalar(speed * dt);

  const desired = me.node.position.clone().add(move);
  const resolved = resolveCollisions(me.node.position, desired);

  // clamp world bounds
  const bound = (maze.size/2) - 5;
  resolved.x = clamp(resolved.x, -bound, bound);
  resolved.z = clamp(resolved.z, -bound, bound);

  me.node.position.copy(resolved);

  // look towards movement direction (smooth)
  const look = me.node.position.clone().add(move);
  me.node.lookAt(look.x, me.node.position.y, look.z);

  // camera follow target
  const target = new THREE.Vector3(resolved.x, 1.6, resolved.z);
  controls.target.lerp(target, 0.1);

  // send position throttled
  const now = performance.now();
  if (!tickMovement.last || now - tickMovement.last > 90) {
    tickMovement.last = now;
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type:'move', x: resolved.x, z: resolved.z }));
    }
  }
}

function interpolateRemotes() {
  state.entities.forEach((e, id) => {
    if (id === state.playerId) return;
    if (!e.target) return;
    e.node.position.lerp(e.target, 0.15);
  });
}

// ---------- Minimap ----------
function updateMinimap() {
  const c = ui.minimapCanvas;
  const ctx = c.getContext('2d');
  c.width = 220; c.height = 220;

  // bg
  ctx.fillStyle = 'rgba(10,15,24,0.95)';
  ctx.fillRect(0,0,c.width,c.height);

  // grid
  ctx.strokeStyle = '#1a2d3a';
  ctx.lineWidth = 1;
  for (let i=0;i<=11;i++){
    const p = (i*(c.width/11))|0;
    ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,c.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(c.width,p); ctx.stroke();
  }

  const half = maze.size/2;
  function mapXZ(x,z){
    const nx = (x + half) / maze.size;
    const nz = (z + half) / maze.size;
    return [ nx * c.width, nz * c.height ];
  }

  state.entities.forEach((ent, id)=>{
    const [x,z] = mapXZ(ent.node.position.x, ent.node.position.z);
    const isMe = (id === state.playerId);
    ctx.fillStyle = isMe ? '#00ff88' : '#9aa';
    ctx.beginPath();
    ctx.arc(x, z, isMe ? 4 : 3, 0, Math.PI*2);
    ctx.fill();
    if (isMe) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x,z,8,0,Math.PI*2); ctx.stroke();
    }
  });
}

// ---------- Context Menu ----------
function setupContextMenu() {
  const menu = ui.rightMenu;

  window.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();

    // pick nearest entity by projecting screen space & distance
    // simpler: loop entities and compute screen distance
    let pickedId = null;
    let best = 28; // px tolerance
    const rect = renderer.domElement.getBoundingClientRect();

    state.entities.forEach((ent, id) => {
      const v = ent.node.position.clone();
      v.y += 1.2;
      v.project(camera);
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = ( -v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - ev.clientX + rect.left, sy - ev.clientY + rect.top);
      if (d < best) { best = d; pickedId = id; }
    });

    menu.style.left = `${ev.clientX}px`;
    menu.style.top  = `${ev.clientY}px`;
    menu.style.display = 'block';

    const setPublic = () => {
      state.targetId = null;
      ui.targetName.textContent = 'Openbaar';
      menu.style.display = 'none';
    };

    ui.mClear.textContent = '🔓 Publieke chat';
    ui.mClear.onclick = setPublic;

    if (pickedId && pickedId !== state.playerId) {
      const ent = state.entities.get(pickedId);
      ui.mChat.textContent = `💬 Chat met ${ent?.name || 'onbekend'}`;
      ui.mReport.textContent = `⚠️ Rapporteer ${ent?.name || 'onbekend'}`;

      ui.mChat.onclick = () => {
        // distance gate
        const me = state.player?.node?.position;
        const other = ent?.node?.position;
        if (me && other) {
          const dist = me.distanceTo(other);
          if (dist > CHAT_DISTANCE) {
            addLine('SYSTEM:', `Je staat te ver weg om privé te praten (afstand ${dist.toFixed(1)}m; max ${CHAT_DISTANCE.toFixed(1)}m).`, false, true);
            menu.style.display = 'none';
            return;
          }
        }
        state.targetId = pickedId;
        ui.targetName.textContent = ent?.name || 'Openbaar';
        menu.style.display = 'none';
      };
      ui.mReport.onclick = () => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type:'report', reportedId: pickedId }));
        }
        menu.style.display = 'none';
      };
    } else {
      ui.mChat.textContent = '—';
      ui.mReport.textContent = '—';
      ui.mChat.onclick = () => menu.style.display = 'none';
      ui.mReport.onclick = () => menu.style.display = 'none';
    }

    setTimeout(()=> window.addEventListener('click', ()=> menu.style.display='none', {once:true}), 80);
  });
}

// ---------- Chat ----------
function sendMessage(text) {
  if (!text || !text.trim()) return;
  const payload = { type:'chat', message: text.trim() };

  // distance gate if private
  if (state.targetId && state.entities.has(state.targetId) && state.player) {
    const me = state.player.node.position;
    const other = state.entities.get(state.targetId).node.position;
    const dist = me.distanceTo(other);
    if (dist > CHAT_DISTANCE) {
      addLine('SYSTEM:', `Je staat te ver weg van ${state.entities.get(state.targetId).name} om privé te praten (${dist.toFixed(1)}m).`, false, true);
      return;
    }
    payload.targetId = state.targetId;
  }

  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

// ---------- Input & UI ----------
function setupUI() {
  // chat box
  ui.sendBtn.onclick = () => { const t = ui.msg.value.trim(); if (!t) return; sendMessage(t); ui.msg.value = ''; };
  ui.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.sendBtn.click(); });

  // avatar grid
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
  ui.nameInput.oninput = () => { ui.startBtn.disabled = !ui.nameInput.value.trim(); };

  // start
  ui.startBtn.addEventListener('click', () => {
    state.username = ui.nameInput.value.trim();
    state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    ui.overlay.style.display = 'none';
    ui.loadingSpinner.style.display = 'block';
    connectWS();
  });

  // key input
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    state.keys[k] = true;
    // prevent scrolling with arrows/space
    if (['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { state.keys[e.key.toLowerCase()] = false; });

  setupContextMenu();
}

function updateHUDConnection(statusText, color='#9fffdc') {
  ui.conn.textContent = statusText;
  ui.conn.style.color = color;
}

// ---------- WebSocket ----------
function connectWS() {
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', () => {
    updateHUDConnection('● Connected', '#00ff88');
    state.ws.send(JSON.stringify({
      type:'join',
      playerId: state.playerId,
      username: state.username,
      avatar: state.avatarEmoji,
      x: 0, z: 0
    }));
    addLine('SYSTEM:', 'Verbonden met server. Wereld laden...', false, true);
  });

  state.ws.addEventListener('message', (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }

    switch(data.type) {
      case 'init': {
        // world already built; create entities
        data.players.forEach(p => addEntity(p.id, p.x, p.z, p.username, p.avatar));
        data.npcs.forEach(n => addEntity(n.id, n.x, n.z, n.name, '🤖'));

        // ensure self exists
        if (!state.entities.has(state.playerId)) addEntity(state.playerId, 0,0, state.username, state.avatarEmoji);
        state.player = state.entities.get(state.playerId);

        // weather & time
        if (data.weather) {
          updateWeather(data.weather.type, data.weather.intensity);
          updateTimeOfDay(data.weather.gameTime);
        }

        // focus camera
        controls.target.copy(state.player.node.position);

        // hide spinner
        ui.loadingSpinner.style.display = 'none';
        break;
      }

      case 'player_joined': {
        const p = data.player;
        if (p.id !== state.playerId) addEntity(p.id, p.x, p.z, p.username, p.avatar);
        addLine('SYSTEM:', `${p.username} heeft zich aangesloten`, false, true);
        break;
      }

      case 'player_left':
        removeEntity(data.playerId);
        break;

      case 'player_move': {
        const ent = state.entities.get(data.playerId);
        if (ent) ent.target = new THREE.Vector3(data.x, 0, data.z);
        break;
      }

      case 'npc_update':
        data.npcs.forEach(n => {
          const e = state.entities.get(n.id);
          if (e) e.target = new THREE.Vector3(n.x, 0, n.z);
        });
        break;

      case 'chat': {
        const isPrivate = !!data.private;
        const sender = data.username;
        const msg = data.message;
        addLine(isPrivate ? `${sender} (privé):` : `${sender}:`, msg, isPrivate, false);
        break;
      }

      case 'penalty':
        updateCredits(data.amount, data.reason);
        break;

      case 'report_result':
        state.stats.reportsTotal++;
        if (data.correct) { state.stats.reportsCorrect++; updateCredits(50, `Correct! ${data.reportedName} is een echte speler`); }
        else { updateCredits(-30, `Onjuist rapport over ${data.reportedName}`); }
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
        // server anti-cheat
        if (state.player) {
          state.player.node.position.x = data.x;
          state.player.node.position.z = data.z;
        }
        break;
    }
  });

  state.ws.addEventListener('close', () => {
    updateHUDConnection('● Reconnecting...', '#ff8800');
    addLine('SYSTEM:', 'Verbinding verbroken. Opnieuw verbinden...', false, true);
    setTimeout(connectWS, 2000);
  });
  state.ws.addEventListener('error', (err) => console.error('[WS error]', err));
}

// ---------- Render loop ----------
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, state.clock.getDelta());

  tickMovement(dt);
  interpolateRemotes();
  updateMinimap();

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

// ---------- Boot ----------
function boot() {
  buildMaze();
  setupUI();

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();
  console.log('[Client] Ready');
}

boot();
