// public/app.js — Three.js client met maze, botsing, labels, klik-popup, afstandscheck, lokale moderatie

// ──────────────────────────────────────────────────────────────────────────────
// Imports (ESM) – vaste versies om Render/CDN issues te voorkomen
// ──────────────────────────────────────────────────────────────────────────────
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.160.0/examples/jsm/renderers/CSS2DRenderer.js';

// ──────────────────────────────────────────────────────────────────────────────
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
  weatherIcon: document.getElementById('weatherIcon'),
  timeDisplay: document.getElementById('timeDisplay'),
  minimapCanvas: document.getElementById('minimapCanvas'),
  statReports: document.getElementById('statReports'),
  statAccuracy: document.getElementById('statAccuracy'),
  statPlayers: document.getElementById('statPlayers'),
  loadingSpinner: document.getElementById('loadingSpinner'),
};

const state = {
  ws: null,
  playerId: null,
  username: '',
  avatarEmoji: '🙂',
  lang: 'nl',
  targetId: null,
  credits: 1000,

  // three
  scene: null,
  camera: null,
  controls: null,
  renderer: null,
  labelRenderer: null,

  // world
  ground: null,
  mazeWalls: [],   // array of THREE.Mesh (colliders) + bounds
  mazeRects: [],   // {x,z,w,h,minX,maxX,minZ,maxZ}

  // entities
  entities: new Map(), // id -> { group, bodyMesh, labelObj, height, radius, name, avatar, target, isNPC }
  player: null,

  // input
  keys: {},
  turnSpeed: THREE.MathUtils.degToRad(120), // deg/s
  moveSpeed: 6, // m/s (× sprint)

  // misc
  avatarReady: true,
  banned: false,

  weather: { type: 'clear', intensity: 1 },
  gameTime: 12.0,

  stats: { reportsTotal: 0, reportsCorrect: 0 }
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
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
function updateCredits(amount, reason) {
  state.credits += amount;
  ui.credit.textContent = state.credits;
  ui.credit.style.color = state.credits < 500 ? '#ff4444' : '#00ff88';
  if (reason) addLine('SYSTEM:', reason, false, true);
}
function updateStats() {
  ui.statReports.textContent = state.stats.reportsTotal;
  ui.statAccuracy.textContent = state.stats.reportsTotal > 0
    ? Math.round((state.stats.reportsCorrect / state.stats.reportsTotal) * 100) + '%'
    : '--';
}

// ──────────────────────────────────────────────────────────────────────────────
// Moderatie (client-side pre-check vóór versturen)
// ──────────────────────────────────────────────────────────────────────────────
// NB: server-side blijft leidend voor echte ban/credits; dit is extra bescherming.
// Eenvoudige heuristieken (bewust conservatief).
const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const RE_PHONE = /\b(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}\b/;
const RE_ADDRESS = /\b(?:straat|laan|weg|plein|dorp|dreef|gracht|kade|avenue|road|street|st\.|avenue|boulevard)\b/i;
const RE_SEXUAL = /\b(porn|porno|sex|seks|horny|nsfw|nude|naakt|erotic)\b/i;
const RE_CSAM = /\b(child\s*sex|kinderporno|kinder porn|child porn|cp\b|underage\s*sex|minor\s*sex|sex\s*with\s*children|pedofil|pedo)\b/i;

function moderateLocal(text) {
  const lower = text.toLowerCase();
  if (RE_CSAM.test(lower)) {
    return { block:true, ban:true, penalty: 0, message: 'Verboden inhoud (kindermisbruik). Je bent geblokkeerd.' };
  }
  if (RE_SEXUAL.test(lower)) {
    return { block:true, ban:false, penalty: -500, message: 'Seksueel getinte inhoud is niet toegestaan (-500).' };
  }
  if (RE_EMAIL.test(text) || RE_PHONE.test(text) || RE_ADDRESS.test(lower)) {
    return { block:true, ban:false, penalty: -50, message: 'Dat soort vragen/gegevens worden hier niet getolereerd (-50).' };
  }
  return { block:false };
}

// ──────────────────────────────────────────────────────────────────────────────
// Weer & Tijd
// ──────────────────────────────────────────────────────────────────────────────
function updateWeather(type, intensity) {
  state.weather = { type, intensity };
  const icons = { clear:'☀️', cloudy:'☁️', rain:'🌧️', fog:'🌫️' };
  ui.weatherIcon.textContent = icons[type] || '☀️';
}
function updateTimeOfDay(gameTime) {
  state.gameTime = gameTime;
  const h = Math.floor(gameTime), m = Math.floor((gameTime - h) * 60);
  ui.timeDisplay.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Three.js Scene
// ──────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('renderCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x0b1020, 1);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position = 'fixed';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
state.scene = scene;

// Camera + controls
const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 1000);
camera.position.set(0, 14, 22);
state.camera = camera;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.minDistance = 8;
controls.maxDistance = 50;
controls.minPolarAngle = 0.12; // niet onder de grond
controls.maxPolarAngle = Math.PI/2.05;
controls.target.set(0, 2, 0);
state.controls = controls;

// Licht
{
  const hemi = new THREE.HemisphereLight(0xb5eaff, 0x202428, 0.8);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(20, 40, 20);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048,2048);
  scene.add(dir);
}

// Ground
const groundMat = new THREE.MeshStandardMaterial({ color: 0x8797a3, metalness:0.0, roughness:0.95 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(120,120), groundMat);
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);
state.ground = ground;

// Maze (platte muren/richels)
buildMaze();

// ──────────────────────────────────────────────────────────────────────────────
// Entity helpers (avatars)
// ──────────────────────────────────────────────────────────────────────────────
const AVATAR_HEIGHT = 1.2;
const AVATAR_RADIUS = 0.45;

function makeNametag(name, emoji) {
  const el = document.createElement('div');
  el.className = 'nametag';
  el.textContent = (emoji ? `${emoji} ${name}` : name);
  return new CSS2DObject(el);
}

function buildAvatar(name, emoji='🙂') {
  const group = new THREE.Group();

  // Simple stylized bot (cilinder + hoofd)
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1be38d, metalness:0.2, roughness:0.6 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x14b56f, metalness:0.3, roughness:0.5 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(AVATAR_RADIUS, AVATAR_HEIGHT-AVATAR_RADIUS*2, 8, 16), bodyMat);
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 16), headMat);
  head.position.y = AVATAR_HEIGHT*0.55 + 0.25;
  head.castShadow = true; head.receiveShadow = true;
  group.add(head);

  // label
  const label = makeNametag(name, emoji);
  label.position.set(0, AVATAR_HEIGHT*0.55 + 0.62, 0);
  group.add(label);

  // voor raycast hitbox
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(AVATAR_RADIUS*0.9, AVATAR_RADIUS*0.9, AVATAR_HEIGHT, 6), new THREE.MeshBasicMaterial({color:0x000000, transparent:true, opacity:0}));
  hit.position.y = AVATAR_HEIGHT*0.55;
  hit.userData.isHit = true;
  group.add(hit);

  return { group, bodyMesh: body, labelObj: label, height: AVATAR_HEIGHT, radius: AVATAR_RADIUS };
}

function addEntity(id, x, z, name, emoji, isNPC=false) {
  if (state.entities.has(id)) return state.entities.get(id);

  const av = buildAvatar(name || id, emoji || '🙂');
  av.group.position.set(x || 0, 0, z || 0);
  scene.add(av.group);

  const ent = {
    ...av,
    id, name: name || id, avatar: emoji || '🙂',
    isNPC,
    target: new THREE.Vector3(x||0, 0, z||0),
  };
  state.entities.set(id, ent);
  return ent;
}

function removeEntity(id) {
  const e = state.entities.get(id);
  if (!e) return;
  scene.remove(e.group);
  e.group.traverse(o=>{ if (o.geometry) o.geometry.dispose(); if (o.material) Array.isArray(o.material)?o.material.forEach(m=>m.dispose()):o.material.dispose(); });
  state.entities.delete(id);
}

// ──────────────────────────────────────────────────────────────────────────────
// Maze opbouw + collision rects
// ──────────────────────────────────────────────────────────────────────────────
function buildMaze() {
  // eenvoudige “grid-based” layout: 12x12
  const rng = (seed => () => (seed = (seed * 9301 + 49297) % 233280) / 233280)(12345);
  const cols = 12, rows = 12;
  const cell = 8; // meter
  const wallThick = 1.2;
  const height = 1.4;
  const startX = - (cols*cell)/2;
  const startZ = - (rows*cell)/2;

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b7a86, metalness:0.0, roughness:0.9 });

  function addWall(x, z, w, h) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, height, h), wallMat);
    mesh.position.set(x, height/2, z);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    state.mazeWalls.push(mesh);
    const rect = { x, z, w, h, minX:x - w/2, maxX:x + w/2, minZ:z - h/2, maxZ:z + h/2 };
    state.mazeRects.push(rect);
  }

  // frame
  addWall(0, startZ, cols*cell, wallThick);
  addWall(0, -startZ, cols*cell, wallThick);
  addWall(startX, 0, wallThick, rows*cell);
  addWall(-startX, 0, wallThick, rows*cell);

  // binnenste gangen (random)
  for (let r = 1; r < rows-1; r++) {
    for (let c = 1; c < cols-1; c++) {
      // horizontale segmenten
      if (rng() < 0.5) {
        const cx = startX + c*cell;
        const cz = startZ + r*cell;
        addWall(cx, cz, cell * (0.65 + rng()*0.2), wallThick);
      }
      // verticale segmenten
      if (rng() < 0.5) {
        const cx = startX + c*cell;
        const cz = startZ + r*cell;
        addWall(cx, cz, wallThick, cell * (0.65 + rng()*0.2));
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
function clampCameraTarget() {
  // houd target (vloer) positief
  state.controls.target.y = Math.max(state.controls.target.y, 0.5);
}

// ──────────────────────────────────────────────────────────────────────────────
// Movement + Collision
// ──────────────────────────────────────────────────────────────────────────────
function collidePosition(pos, radius) {
  // per-as correctie tegen axis-aligned rects
  let px = pos.x, pz = pos.z;

  // X as
  for (const r of state.mazeRects) {
    if (pz + radius < r.minZ || pz - radius > r.maxZ) continue; // geen overlap in Z
    const nearestX = THREE.MathUtils.clamp(px, r.minX, r.maxX);
    const dx = px - nearestX;
    if (Math.abs(dx) < radius) {
      const push = (radius - Math.abs(dx)) * Math.sign(dx || 1);
      px = px + push;
    }
  }
  // Z as
  for (const r of state.mazeRects) {
    if (px + radius < r.minX || px - radius > r.maxX) continue; // geen overlap in X
    const nearestZ = THREE.MathUtils.clamp(pz, r.minZ, r.maxZ);
    const dz = pz - nearestZ;
    if (Math.abs(dz) < radius) {
      const push = (radius - Math.abs(dz)) * Math.sign(dz || 1);
      pz = pz + push;
    }
  }

  pos.x = px; pos.z = pz;
  return pos;
}

function tickMovement(dt) {
  if (!state.player || state.banned) return;

  const turn = state.turnSpeed * dt;
  const speed = (state.keys['shift'] ? 1.7 : 1.0) * state.moveSpeed;
  const forward = speed * dt;

  // Rotatie (A/D)
  if (state.keys['a']) state.player.group.rotation.y += turn;
  if (state.keys['d']) state.player.group.rotation.y -= turn;

  // Vooruit/Achteruit (W/S)
  const dir = new THREE.Vector3(0,0,-1).applyEuler(state.player.group.rotation).setY(0).normalize();
  let moved = false;
  let newPos = state.player.group.position.clone();

  if (state.keys['w']) { newPos.addScaledVector(dir, forward); moved = true; }
  if (state.keys['s']) { newPos.addScaledVector(dir, -forward); moved = true; }

  if (moved) {
    collidePosition(newPos, state.player.radius);
    state.player.group.position.copy(newPos);

    // camera volgt
    const tgt = new THREE.Vector3(newPos.x, 2, newPos.z);
    state.controls.target.lerp(tgt, 0.15);
    clampCameraTarget();

    // throttle send
    const now = performance.now();
    if (!tickMovement.last || now - tickMovement.last > 90) {
      tickMovement.last = now;
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type:'move', x:newPos.x, z:newPos.z }));
      }
    }
  }
}

function interpolateRemotes() {
  const tmp = new THREE.Vector3();
  state.entities.forEach((e, id) => {
    if (id === state.playerId) return;
    if (!e.target) return;
    tmp.copy(e.group.position).lerp(e.target, 0.18);
    collidePosition(tmp, e.radius);
    e.group.position.copy(tmp);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Minimap
// ──────────────────────────────────────────────────────────────────────────────
function updateMinimap() {
  const cvs = ui.minimapCanvas;
  const ctx = cvs.getContext('2d');
  cvs.width = cvs.clientWidth; cvs.height = cvs.clientHeight;

  ctx.fillStyle = 'rgba(10,15,24,0.95)';
  ctx.fillRect(0,0,cvs.width,cvs.height);

  // grid
  ctx.strokeStyle = '#1a2d3a'; ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const p = i * cvs.width/10;
    ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,cvs.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(cvs.width,p); ctx.stroke();
  }

  // world → minimap: -60..+60 → 0..w
  function mapX(x){ return (x + 60) / 120 * cvs.width; }
  function mapZ(z){ return (z + 60) / 120 * cvs.height; }

  // walls
  ctx.strokeStyle = '#3c5664';
  state.mazeRects.forEach(r=>{
    ctx.strokeRect(mapX(r.minX), mapZ(r.minZ), mapX(r.maxX)-mapX(r.minX), mapZ(r.maxZ)-mapZ(r.minZ));
  });

  // entities
  state.entities.forEach((ent, id) => {
    const x = mapX(ent.group.position.x);
    const z = mapZ(ent.group.position.z);
    ctx.fillStyle = (id === state.playerId) ? '#00ff88' : (ent.isNPC ? '#8aa' : '#9af');
    ctx.beginPath(); ctx.arc(x, z, (id===state.playerId? 5:3), 0, Math.PI*2); ctx.fill();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Input & UI
// ──────────────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => { state.keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup',   e => { state.keys[e.key.toLowerCase()] = false; });

ui.sendBtn.onclick = onSend;
ui.msg.addEventListener('keydown', e => { if (e.key === 'Enter') onSend(); });

function onSend(){
  if (state.banned) return;
  let text = ui.msg.value.trim();
  if (!text) return;

  // lokale pre-moderatie
  const verdict = moderateLocal(text);
  if (verdict.block) {
    if (verdict.penalty) updateCredits(verdict.penalty, verdict.message);
    addLine('SYSTEM:', verdict.message, false, true);
    ui.msg.value = '';
    if (verdict.ban) {
      // local “ban”
      state.banned = true;
      ui.conn.textContent = '● Geblokkeerd';
      ui.conn.style.color = '#ff4444';
      if (state.ws) try{ state.ws.close(); }catch{}
      ui.sendBtn.disabled = true; ui.msg.disabled = true;
    }
    return;
  }

  const payload = { type:'chat', message:text };
  if (state.targetId) payload.targetId = state.targetId;

  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
  ui.msg.value = '';
}

function setupOverlay() {
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
  ui.startBtn.addEventListener('click', () => {
    state.username = ui.nameInput.value.trim();
    state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    ui.overlay.style.display = 'none';
    ui.loadingSpinner.style.display = 'block';
    connectWS();
  });
}
setupOverlay();

// Klik-popup (links-klik)
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
canvas.addEventListener('click', (ev)=>{
  if (!state.scene) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left)/rect.width)*2 - 1;
  mouse.y = -((ev.clientY - rect.top)/rect.height)*2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const hits = raycaster.intersectObjects(Array.from(state.entities.values()).map(e => e.group), true)
    .filter(h => h.object?.userData?.isHit);
  const menu = ui.rightMenu;

  if (hits.length) {
    const e = Array.from(state.entities.values()).find(ent => hits[0].object.parent === ent.group || hits[0].object === ent.group || ent.group.children.includes(hits[0].object));
    if (!e) return;

    state.targetId = e.id;
    ui.targetName.textContent = e.name;

    menu.style.left = ev.clientX + 'px';
    menu.style.top  = ev.clientY + 'px';
    menu.style.display = 'block';

    ui.mChat.onclick = () => {
      // afstandscheck 5× avatarhoogte
      const dist = state.player ? state.player.group.position.distanceTo(e.group.position) : Infinity;
      const maxDist = e.height * 5;
      if (dist > maxDist) {
        addLine('SYSTEM:', `Je staat te ver weg om privé te praten (>${Math.round(maxDist)}m).`, false, true);
      } else {
        addLine('SYSTEM:', `Privé chat met ${e.name} actief.`, false, true);
      }
      menu.style.display = 'none';
    };
    ui.mReport.onclick = () => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type:'report', reportedId: e.id }));
      }
      menu.style.display = 'none';
    };

    setTimeout(()=>window.addEventListener('click', ()=> menu.style.display='none', {once:true}), 50);
  } else {
    menu.style.display = 'none';
    state.targetId = null;
    ui.targetName.textContent = 'Openbaar';
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket
// ──────────────────────────────────────────────────────────────────────────────
function connectWS() {
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', () => {
    ui.conn.textContent = '● Connected';
    ui.conn.style.color = '#00ff88';

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
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    switch (data.type) {
      case 'init': {
        // Maak bestaande entiteiten
        data.players.forEach(p => addEntity(p.id, p.x, p.z, p.username, p.avatar, false));
        data.npcs.forEach(n => addEntity(n.id, n.x, n.z, n.name, '🤖', true));

        state.player = addEntity(state.playerId, 0, 0, state.username, state.avatarEmoji, false);
        controls.target.copy(state.player.group.position).y = 2;

        // weer/tijd
        if (data.weather) {
          updateWeather(data.weather.type, data.weather.intensity);
          updateTimeOfDay(data.weather.gameTime);
        }

        // teller = spelers + npcs
        ui.statPlayers.textContent = (data.players.length + data.npcs.length).toString();

        ui.loadingSpinner.style.display = 'none';
        break;
      }

      case 'player_joined': {
        if (data.player.id === state.playerId) break;
        addEntity(data.player.id, data.player.x, data.player.z, data.player.username, data.player.avatar, false);
        ui.statPlayers.textContent = String(parseInt(ui.statPlayers.textContent,10)+1);
        addLine('SYSTEM:', `${data.player.username} heeft zich aangesloten`, false, true);
        break;
      }

      case 'player_left': {
        removeEntity(data.playerId);
        ui.statPlayers.textContent = String(Math.max(0, parseInt(ui.statPlayers.textContent,10)-1));
        break;
      }

      case 'player_move': {
        const ent = state.entities.get(data.playerId);
        if (ent) ent.target = new THREE.Vector3(data.x, 0, data.z);
        break;
      }

      case 'npc_update': {
        data.npcs.forEach(npc => {
          const ent = state.entities.get(npc.id);
          if (ent) ent.target = new THREE.Vector3(npc.x, 0, npc.z);
        });
        break;
      }

      case 'chat': {
        const isPrivate = data.private || false;
        const sender = data.username;
        const msg = data.message;
        addLine(isPrivate ? `${sender} (privé):` : `${sender}:`, msg, isPrivate);
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
          state.player.group.position.x = data.x;
          state.player.group.position.z = data.z;
        }
        break;
    }
  });

  state.ws.addEventListener('close', () => {
    if (state.banned) return; // zelf afgesloten door ban
    ui.conn.textContent = '● Reconnecting...';
    ui.conn.style.color = '#ff8800';
    addLine('SYSTEM:', 'Verbinding verbroken. Opnieuw verbinden...', false, true);
    setTimeout(connectWS, 1500);
  });

  state.ws.addEventListener('error', (err) => {
    console.error('[WS] Error', err);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Renderloop
// ──────────────────────────────────────────────────────────────────────────────
let last = performance.now();
function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last)/1000);
  last = now;

  tickMovement(dt);
  interpolateRemotes();
  updateMinimap();
  clampCameraTarget();

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();

window.addEventListener('resize', ()=>{
  const w = innerWidth, h = innerHeight;
  camera.aspect = w/h; camera.updateProjectionMatrix();
  renderer.setSize(w,h);
  labelRenderer.setSize(w,h);
});
