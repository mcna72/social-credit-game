// public/app.js — Three.js client with labels, collisions, proximity chat, right-click popup
// Loads Three.js as ES modules from CDN (no bundler required).

import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js';

// ------------------------------
// UI references (no avatar picker)
// ------------------------------
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const ui = {
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('start'),
  nameInput: document.getElementById('name'),
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
  loadingSpinner: document.getElementById('loadingSpinner'),
  threeRoot: document.getElementById('threeRoot'),
};

// ------------------------------
// Global state
// ------------------------------
const state = {
  ws: null,
  playerId: null,
  username: '',
  lang: 'nl',
  targetId: null,
  credits: 1000,

  // three.js
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  clock: new THREE.Clock(),

  // scene content
  maze: null,
  walls: [], // axis-aligned boxes
  entities: new Map(), // id -> { group, body, label, target, radius }
  player: null,

  // gameplay
  AVATAR_RADIUS: 0.4,
  AVATAR_HEIGHT: 1.1,
  PROXIMITY: 0, // set later = AVATAR_RADIUS*5
  MOVE_SPEED: 4.0,
  SPRINT_MULT: 1.6,
  keys: {},

  weather: { type: 'clear', intensity: 1 },
  gameTime: 12,
  stats: { reportsTotal: 0, reportsCorrect: 0 },
};

// derived
state.PROXIMITY = state.AVATAR_RADIUS * 5;

// ------------------------------
// Utilities
// ------------------------------
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
  const acc = state.stats.reportsTotal > 0 ?
    ((state.stats.reportsCorrect / state.stats.reportsTotal) * 100).toFixed(0) + '%' : '--';
  ui.statAccuracy.textContent = acc;
}

// ------------------------------
// Weather & Time indicators
// ------------------------------
function updateWeather(type, intensity) {
  state.weather = { type, intensity };
  const icons = { clear: '☀️', cloudy: '☁️', rain: '🌧️', fog: '🌫️' };
  ui.weatherIcon.textContent = icons[type] || '☀️';
}
function updateTimeOfDay(gameTime) {
  state.gameTime = gameTime;
  const hour = Math.floor(gameTime);
  const min = Math.floor((gameTime - hour) * 60);
  ui.timeDisplay.textContent = `${hour.toString().padStart(2,'0')}:${min.toString().padStart(2,'0')}`;
}

// ------------------------------
// Three.js scene
// ------------------------------
function bootThree(){
  const w = window.innerWidth, h = window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  ui.threeRoot.appendChild(renderer.domElement);
  state.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(60, w/h, 0.1, 1000);
  camera.position.set(6, 6, 10);
  state.camera = camera;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.5, 0);
  // keep camera above ground: don't allow flipping below horizon
  controls.minPolarAngle = 0.2;              // ~11°
  controls.maxPolarAngle = Math.PI/2.1;      // never below ground
  controls.minDistance = 3;
  controls.maxDistance = 45;
  state.controls = controls;

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.6);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(10, 20, 10);
  dir.castShadow = true;
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 100;
  dir.shadow.mapSize.set(2048, 2048);
  scene.add(dir);

  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x0f1b2d, roughness: 0.95, metalness: 0.0 })
  );
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Maze (low walls)
  buildMaze(scene);

  // Render loop
  window.addEventListener('resize', onResize);
  function onResize(){
    const W = window.innerWidth, H = window.innerHeight;
    renderer.setSize(W, H);
    camera.aspect = W/H;
    camera.updateProjectionMatrix();
  }

  state.clock.start();
  let last = performance.now();

  function animate(){
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    tickMovement(dt);
    interpolateRemotes(dt);
    updateMinimap();

    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
}

// Simple orthogonal maze: array of walls (axis-aligned boxes)
function buildMaze(scene){
  state.walls = [];

  // Parameters
  const cell = 2.5;
  const cols = 18, rows = 14; // visible in your screenshot
  const wallH = 1.2;
  const wallThick = 0.35;

  // Floor “maze platform” (slightly higher)
  const platform = new THREE.Mesh(
    new THREE.PlaneGeometry(cols*cell+4, rows*cell+4),
    new THREE.MeshStandardMaterial({ color: 0x202a36, roughness: 0.8 })
  );
  platform.rotation.x = -Math.PI/2;
  platform.position.y = 0.01;
  platform.receiveShadow = true;
  scene.add(platform);

  // Build outer border and inner walls using simple pattern (you can change pattern as you like)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6c7782, roughness: 0.6, metalness: 0.0 });

  function addWallBox(x, z, w, h){
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, wallH, h),
      wallMat
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(x, wallH/2, z);
    scene.add(mesh);
    // store AABB for collision
    const aabb = new THREE.Box3().setFromObject(mesh);
    state.walls.push({ mesh, aabb });
  }

  const W = cols*cell, H = rows*cell;
  // border
  addWallBox(0, -H/2, W, wallThick);
  addWallBox(0,  H/2, W, wallThick);
  addWallBox(-W/2, 0, wallThick, H);
  addWallBox( W/2, 0, wallThick, H);

  // a simple procedural maze (horizontal and vertical segments)
  for (let r=2; r<rows-1; r+=2){
    const segs = Math.floor(cols/3);
    for (let s=0; s<segs; s++){
      const x = -W/2 + (s*3+1.5)*cell;
      const z = -H/2 + r*cell;
      addWallBox(x, z, cell*1.6, wallThick);
    }
  }
  for (let c=3; c<cols-1; c+=3){
    const segs = Math.floor(rows/3);
    for (let s=0; s<segs; s++){
      const x = -W/2 + c*cell;
      const z = -H/2 + (s*3+1.5)*cell;
      addWallBox(x, z, wallThick, cell*1.6);
    }
  }

  // keep reference for bounds if needed
  state.maze = { width: W, height: H, cell, wallH };
}

// ------------------------------
// Avatar building + labels
// ------------------------------
function makeAvatarGroup(color = 0xf1a028){
  // stylized “robot” using primitives
  const group = new THREE.Group();

  // body
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(state.AVATAR_RADIUS, state.AVATAR_HEIGHT - state.AVATAR_RADIUS*2, 8, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.12 })
  );
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // simple “visor”
  const visor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.15, 16),
    new THREE.MeshStandardMaterial({ color: 0x222b33, roughness: 0.9 })
  );
  visor.rotation.z = Math.PI/2;
  visor.position.set(0, 0.55, 0.18);
  visor.castShadow = true;
  group.add(visor);

  // feet (small spheres)
  const footL = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x222b33 }));
  const footR = footL.clone();
  footL.position.set(-0.15, -state.AVATAR_HEIGHT/2 + 0.14, 0);
  footR.position.set( 0.15, -state.AVATAR_HEIGHT/2 + 0.14, 0);
  group.add(footL, footR);

  return { group, body };
}

function makeNameLabel(text){
  // draw text into canvas and make a sprite that always faces the camera
  const padX = 24, padY = 10, font = 24;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${font}px Arial`;
  const metrics = ctx.measureText(text);
  const w = Math.ceil(metrics.width) + padX*2;
  const h = font + padY*2;
  canvas.width = w;
  canvas.height = h;

  // redraw with correct size
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w-2, h-2);

  ctx.fillStyle = '#00ff88';
  ctx.font = `bold ${font}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w/2, h/2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;

  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const spr = new THREE.Sprite(mat);
  const scale = 0.008; // scale from pixels to world
  spr.scale.set(w*scale, h*scale, 1);
  // position above head
  spr.position.set(0, state.AVATAR_HEIGHT/2 + 0.8, 0);
  return spr;
}

function addEntity(id, x, z, name, color){
  if (state.entities.has(id)) return;
  const { group } = makeAvatarGroup(color);
  group.position.set(x, state.AVATAR_HEIGHT/2, z);
  group.userData.entityId = id;
  group.traverse(o => o.userData.entityId = id);

  // label
  const label = makeNameLabel(name || id);
  group.add(label);

  state.scene.add(group);

  state.entities.set(id, {
    id, name: name || id,
    group,
    label,
    target: group.position.clone(),
    radius: state.AVATAR_RADIUS
  });
}

function removeEntity(id){
  const e = state.entities.get(id);
  if (!e) return;
  state.scene.remove(e.group);
  e.group.traverse((o)=> {
    if (o.material && o.material.map && o.material.map.dispose) o.material.map.dispose();
    if (o.material && o.material.dispose) o.material.dispose();
    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
  });
  state.entities.delete(id);
}

// ------------------------------
// Input & movement (WASD)
// ------------------------------
window.addEventListener('keydown', e => { state.keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { state.keys[e.key.toLowerCase()] = false; });

function tickMovement(dt){
  if (!state.player) return;
  const me = state.player;

  const forward = (state.keys['w'] ? 1 : 0) - (state.keys['s'] ? 1 : 0);
  const right   = (state.keys['d'] ? 1 : 0) - (state.keys['a'] ? 1 : 0);
  if (!forward && !right) return;

  const speed = state.MOVE_SPEED * (state.keys['shift'] ? state.SPRINT_MULT : 1.0);
  const dirCam = new THREE.Vector3();
  state.camera.getWorldDirection(dirCam);
  dirCam.y = 0; dirCam.normalize();

  const rightVec = new THREE.Vector3().crossVectors(dirCam, new THREE.Vector3(0,1,0)).negate().normalize();

  const moveVec = new THREE.Vector3()
    .addScaledVector(dirCam, forward)
    .addScaledVector(rightVec, right)
    .normalize()
    .multiplyScalar(speed * dt);

  const next = me.group.position.clone().add(moveVec);

  // prevent leaving maze bounds
  const pad = 1.0;
  next.x = THREE.MathUtils.clamp(next.x, -state.maze.width/2 + pad, state.maze.width/2 - pad);
  next.z = THREE.MathUtils.clamp(next.z, -state.maze.height/2 + pad, state.maze.height/2 - pad);

  // collision with walls (AABB vs sphere/ capsule simplified)
  const rad = me.radius + 0.05;
  const pos = me.group.position;
  const candidate = next.clone();

  // resolve per axis to avoid snagging
  // X axis
  let test = new THREE.Vector3(candidate.x, pos.y, pos.z);
  if (!sphereCollides(test, rad)){
    pos.x = candidate.x;
  } else {
    // zero x movement
  }
  // Z axis
  test.set(pos.x, pos.y, candidate.z);
  if (!sphereCollides(test, rad)){
    pos.z = candidate.z;
  } else {
    // zero z movement
  }

  // keep camera target following player
  state.controls.target.lerp(new THREE.Vector3(pos.x, pos.y, pos.z), 0.12);

  // send throttled position
  const now = performance.now();
  if (!tickMovement.last || now - tickMovement.last > 90) {
    tickMovement.last = now;
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'move', x: pos.x, z: pos.z }));
    }
  }
}

function sphereCollides(center, radius){
  for (const w of state.walls){
    const aabb = w.aabb;
    // compute closest point on AABB to center
    const cx = THREE.MathUtils.clamp(center.x, aabb.min.x, aabb.max.x);
    const cy = THREE.MathUtils.clamp(center.y, aabb.min.y, aabb.max.y);
    const cz = THREE.MathUtils.clamp(center.z, aabb.min.z, aabb.max.z);
    const dx = center.x - cx, dy = center.y - cy, dz = center.z - cz;
    if ((dx*dx + dy*dy + dz*dz) < radius*radius) return true;
  }
  return false;
}

function interpolateRemotes(dt){
  state.entities.forEach((ent, id) => {
    if (id === state.playerId) return;
    if (!ent.target) return;
    ent.group.position.lerp(ent.target, 0.15);
  });
}

// ------------------------------
// Minimap
// ------------------------------
function setupMinimap(){
  const c = ui.minimapCanvas;
  c.width = 220; c.height = 220;
}
setupMinimap();

function updateMinimap(){
  const c = ui.minimapCanvas;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,15,24,0.95)';
  ctx.fillRect(0,0,c.width,c.height);

  // grid
  ctx.strokeStyle = '#1a2d3a';
  for(let i=0;i<=11;i++){
    const p = i*(c.width/11);
    ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,c.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(c.width,p); ctx.stroke();
  }

  // draw entities, map world [-W/2..W/2]x[-H/2..H/2] to [12..208]
  const W = state.maze?.width || 80, H = state.maze?.height || 80;
  const margin = 12;
  function toX(x){ return margin + (x + W/2) / W * (c.width - margin*2); }
  function toY(z){ return margin + (z + H/2) / H * (c.height - margin*2); }

  state.entities.forEach((ent, id)=>{
    const x = toX(ent.group.position.x);
    const y = toY(ent.group.position.z);
    const isMe = id === state.playerId;
    ctx.fillStyle = isMe ? '#00ff88' : '#8aa';
    ctx.beginPath(); ctx.arc(x, y, isMe ? 5 : 3, 0, Math.PI*2); ctx.fill();
    if (isMe){
      ctx.strokeStyle = '#00ff88';
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI*2); ctx.stroke();
    }
  });
}

// ------------------------------
// Context menu (right-click on avatar)
// ------------------------------
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

state.renderer?.domElement?.addEventListener?.('contextmenu', onContext); // if renderer exists later
window.addEventListener('contextmenu', onContext);
function onContext(ev){
  ev.preventDefault();
  if (!state.renderer || !state.scene || !state.camera) return;
  const rect = state.renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, state.camera);
  // Collect all avatar groups' children
  const meshes = [];
  state.entities.forEach(ent => ent.group.traverse(o => { if (o.isMesh) meshes.push(o); }));
  const hits = raycaster.intersectObjects(meshes, true);
  const first = hits.find(h=>h.object?.userData?.entityId);
  const menu = ui.rightMenu;

  menu.style.left = ev.clientX + 'px';
  menu.style.top = ev.clientY + 'px';
  menu.style.display = 'block';

  if (first){
    const id = first.object.userData.entityId;
    const ent = state.entities.get(id);

    ui.mChat.textContent = '💬 Privé chat met ' + (ent?.name || 'Onbekend');
    ui.mReport.textContent = '⚠️ Rapporteer ' + (ent?.name || 'Onbekend');

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
  setTimeout(()=>window.addEventListener('click', ()=>menu.style.display='none', { once:true }), 100);
}

// ------------------------------
// Chat send (with proximity check for private chat)
// ------------------------------
function sendMessage(text){
  if (!text || !text.trim()) return;
  const payload = { type:'chat', message: text.trim() };
  if (state.targetId) {
    // proximity requirement
    const me = state.entities.get(state.playerId);
    const other = state.entities.get(state.targetId);
    if (!me || !other){
      addLine('SYSTEM:', 'Doel niet beschikbaar.', false, true);
      return;
    }
    const dist = me.group.position.distanceTo(other.group.position);
    if (dist > state.PROXIMITY){
      addLine('SYSTEM:', 'Je staat te ver weg voor privé-chat.', false, true);
      return;
    }
    payload.targetId = state.targetId;
  }
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

// ------------------------------
// WebSocket protocol
// ------------------------------
function connectWS(){
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', ()=>{
    ui.conn.textContent = '● Connected';
    ui.conn.style.color = '#00ff88';

    state.ws.send(JSON.stringify({
      type: 'join',
      playerId: state.playerId,
      username: state.username,
      x: 0, z: 0
    }));

    addLine('SYSTEM:', 'Verbonden met server. Wereld laden...', false, true);
  });

  state.ws.addEventListener('message', (e)=>{
    let data; try{ data = JSON.parse(e.data); } catch { return; }
    switch (data.type){
      case 'init': {
        // build local player + others + NPCs
        (data.players || []).forEach(p => addEntity(p.id, p.x, p.z, p.username, 0xf1a028));
        (data.npcs || []).forEach(n => addEntity(n.id, n.x, n.z, n.name, 0xd9b16f));

        // ensure self exists
        if (!state.entities.get(state.playerId)) addEntity(state.playerId, 0, 0, state.username, 0x44eeaa);
        state.player = state.entities.get(state.playerId);

        // center camera
        state.controls.target.copy(state.player.group.position);

        // weather/time
        if (data.weather){
          updateWeather(data.weather.type, data.weather.intensity);
          updateTimeOfDay(data.weather.gameTime);
        }

        // “Players” counter is meant to be total avatars (NPCs + players)
        const totalAvatars = (data.players?.length || 0) + (data.npcs?.length || 0);
        ui.statPlayers.textContent = totalAvatars;

        // hide spinner
        ui.loadingSpinner.style.display = 'none';
        break;
      }
      case 'player_joined': {
        if (data.player.id === state.playerId) break;
        addEntity(data.player.id, data.player.x, data.player.z, data.player.username, 0xf1a028);
        addLine('SYSTEM:', `${data.player.username} heeft zich aangesloten`, false, true);
        // update total avatars counter (+1)
        ui.statPlayers.textContent = String(Number(ui.statPlayers.textContent) + 1);
        break;
      }
      case 'player_left': {
        // remove and update total avatars counter (-1)
        removeEntity(data.playerId);
        ui.statPlayers.textContent = String(Math.max(0, Number(ui.statPlayers.textContent) - 1));
        break;
      }
      case 'player_move': {
        const ent = state.entities.get(data.playerId);
        if (ent) ent.target = new THREE.Vector3(data.x, state.AVATAR_HEIGHT/2, data.z);
        break;
      }
      case 'npc_update': {
        (data.npcs || []).forEach(n=>{
          const ent = state.entities.get(n.id);
          if (ent) ent.target = new THREE.Vector3(n.x, state.AVATAR_HEIGHT/2, n.z);
        });
        break;
      }
      case 'chat': {
        const isPrivate = !!data.private;
        const who = data.username || 'Onbekend';
        addLine(isPrivate ? `${who} (privé):` : `${who}:`, data.message, isPrivate);
        break;
      }
      case 'penalty': {
        updateCredits(data.amount, data.reason);
        break;
      }
      case 'report_result': {
        state.stats.reportsTotal++;
        if (data.correct) {
          state.stats.reportsCorrect++;
          updateCredits(50, `Correct! ${data.reportedName} is een echte speler`);
        } else {
          updateCredits(-30, `Onjuist rapport over ${data.reportedName}`);
        }
        updateStats();
        break;
      }
      case 'weather_update': {
        updateWeather(data.weather, data.intensity);
        break;
      }
      case 'time_update': {
        updateTimeOfDay(data.gameTime);
        break;
      }
      case 'system': {
        addLine('SYSTEM:', data.message, false, true);
        break;
      }
      case 'position_correction': {
        if (state.player){
          state.player.group.position.set(data.x, state.AVATAR_HEIGHT/2, data.z);
        }
        break;
      }
    }
  });

  state.ws.addEventListener('close', ()=>{
    ui.conn.textContent = '● Reconnecting...';
    ui.conn.style.color = '#ff8800';
    addLine('SYSTEM:', 'Verbinding verbroken. Opnieuw verbinden...', false, true);
    setTimeout(connectWS, 1500);
  });

  state.ws.addEventListener('error', (err) => {
    console.error('[WS] Error', err);
  });
}

// ------------------------------
// UI wiring (join, chat input)
// ------------------------------
ui.nameInput.addEventListener('input', ()=>{
  ui.startBtn.disabled = ui.nameInput.value.trim().length < 1;
});
ui.nameInput.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter' && !ui.startBtn.disabled) ui.startBtn.click();
});

ui.startBtn.addEventListener('click', ()=>{
  state.username = ui.nameInput.value.trim();
  state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  ui.overlay.style.display = 'none';
  ui.loadingSpinner.style.display = 'block';
  connectWS();
  bootThree();
});

ui.sendBtn.onclick = () => {
  const text = ui.msg.value.trim();
  if (!text) return;
  sendMessage(text);
  ui.msg.value = '';
};
ui.msg.addEventListener('keydown', e=>{
  if (e.key === 'Enter') ui.sendBtn.click();
});

// ------------------------------
// Startup
// ------------------------------
addLine('SYSTEM:', 'Klaar om te verbinden — voer je naam in en klik “Systeem betreden”.', false, true);
