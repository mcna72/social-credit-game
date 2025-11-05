// app.js – Three.js client with city, avatars, WASD, chat, NPCs, weather/time

// ---------- Imports (ESM from UNPKG) ----------
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';

// ---------- Constants / UI ----------
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
  statPlayers: document.getElementById('statPlayers')
};

const state = {
  ws: null,
  playerId: null,
  username: '',
  avatarEmoji: '🙂',
  lang: 'nl',
  targetId: null,
  credits: 1000,

  scene: null,
  renderer: null,
  camera: null,
  controls: null,
  clock: new THREE.Clock(),

  entities: new Map(), // id -> { group, label, target: Vector3 }
  player: null,        // same object as entities.get(playerId)

  weather: { type:'clear', intensity: 1 },
  gameTime: 12.0,

  stats: { reportsTotal:0, reportsCorrect:0 }
};

// ---------- Small helpers ----------
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function addLine(user, text, priv=false, sys=false){
  const div = document.createElement('div');
  div.className = 'line' + (priv?' private':'') + (sys?' system':'');
  div.innerHTML = `<span class="user">${escapeHtml(user)}</span> ${escapeHtml(text)}`;
  ui.chatlog.appendChild(div);
  ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  while (ui.chatlog.children.length > 200) ui.chatlog.removeChild(ui.chatlog.firstChild);
}
function sendMessage(text){
  if (!text || !text.trim() || !state.ws) return;
  const payload = { type:'chat', message: text.trim() };
  if (state.targetId) payload.targetId = state.targetId;
  if (state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}
function updateCredits(amount, reason){
  state.credits += amount;
  ui.credit.textContent = state.credits;
  ui.credit.style.color = state.credits < 500 ? '#ff4444' : '#00ff88';
  if (reason) addLine('SYSTEM:', reason, false, true);
}
function updateStats(){
  ui.statReports.textContent = state.stats.reportsTotal;
  ui.statAccuracy.textContent = state.stats.reportsTotal ? Math.round(100*state.stats.reportsCorrect/state.stats.reportsTotal)+'%' : '--';
}

// ---------- Three.js scene ----------
const canvas = document.getElementById('renderCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
state.renderer = renderer;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);
state.scene = scene;

const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 1000);
camera.position.set(30, 24, 30);
state.camera = camera;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 2, 0);
controls.enablePan = true;
controls.maxPolarAngle = Math.PI * 0.49;
state.controls = controls;

// Lights
const hemi = new THREE.HemisphereLight(0xffffff, 0x212433, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(40, 60, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

// City (roads, sidewalks, buildings, canals)
buildCity(scene);

// ---------- City builder ----------
function buildCity(scene){
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600,600),
    new THREE.MeshStandardMaterial({ color: 0xf0f5f8, roughness: 0.95, metalness: 0.0 })
  );
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);

  const asphalt  = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.6, metalness: 0.1 });
  const sidewalk = new THREE.MeshStandardMaterial({ color: 0xb4bac0, roughness: 0.85 });
  const brick    = new THREE.MeshStandardMaterial({ color: 0xc8a699, roughness: 0.9 });

  for (let row=-4; row<=4; row++){
    const y=0.03;

    const road = new THREE.Mesh(new THREE.BoxGeometry(600,0.06,16), asphalt);
    road.position.set(0, y, row*50);
    road.receiveShadow = true;
    scene.add(road);

    const sw1 = new THREE.Mesh(new THREE.BoxGeometry(600,0.10,5), sidewalk);
    sw1.position.set(0, 0.05, row*50 + 11);
    scene.add(sw1);
    const sw2 = sw1.clone();
    sw2.position.set(0, 0.05, row*50 - 11);
    scene.add(sw2);

    // “Canal” strips
    if (row % 2 === 0) {
      const waterMat = new THREE.MeshStandardMaterial({ color: 0x244a62, roughness: 0.1, metalness: 0.9, transparent:true, opacity:0.9 });
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(600, 0.02, 8), waterMat);
      c1.position.set(0, 0.02, row*50 + 23);
      scene.add(c1);
      const c2 = c1.clone(); c2.position.z = row*50 - 23; scene.add(c2);
    }
  }

  // Simple buildings
  for (let x=-5; x<=5; x++){
    for (let z=-5; z<=5; z++){
      if ((Math.abs(x)%2===1) && (Math.abs(z)%2===1)) continue;
      const h = 8 + Math.random()*18;
      const w = 16 + Math.random()*8;
      const d = 16 + Math.random()*8;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), brick);
      mesh.position.set(x*45 + (Math.random()*6-3), h/2, z*45 + (Math.random()*6-3));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // Street lamps (point lights)
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x31343b, metalness:0.6, roughness:0.6 });
  for (let i=-6; i<=6; i++){
    for (let j=-6; j<=6; j++){
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.15,4,12), poleMat);
      pole.position.set(i*45, 2, j*45+10);
      scene.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.25,0.5), poleMat);
      head.position.set(i*45, 4.1, j*45+10);
      scene.add(head);
      const lamp = new THREE.PointLight(0xfff0cc, 0.4, 18);
      lamp.position.set(i*45, 4.3, j*45+10);
      scene.add(lamp);
    }
  }

  // Bikes (simple hints)
  addBikes(scene);
}

function addBikes(scene){
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x282a2d, metalness:0.7, roughness:0.5 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness:0.2, roughness:0.9 });

  for (let i=-5; i<=5; i++){
    for (let j=-5; j<=5; j++){
      if (Math.random() > 0.35) continue;
      const group = new THREE.Group();

      const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.02,0.9,8), frameMat);
      frame.rotation.z = Math.PI/4; frame.position.y = 0.45; group.add(frame);

      const wheel1 = new THREE.Mesh(new THREE.TorusGeometry(0.3,0.03,10,24), wheelMat);
      wheel1.rotation.x = Math.PI/2; wheel1.position.set(0,0.22,0); group.add(wheel1);
      const wheel2 = wheel1.clone(); wheel2.position.z = 0.6; group.add(wheel2);

      group.position.set(i*45 + (Math.random()*6-3), 0, j*45 + 10 + (Math.random()*2-1));
      group.rotation.y = Math.random()*Math.PI*2;
      scene.add(group);
    }
  }
}

// ---------- Avatars ----------
function makeLabel(text){
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.fillRect(0,0,512,128);
  ctx.fillStyle = '#00ff88'; ctx.font = 'bold 48px Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(3.2, 0.8, 1);
  spr.position.set(0, 2.4, 0);
  return spr;
}

function buildAvatar(name, emoji, color=0x00f2a2){
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.9, 8, 16), new THREE.MeshStandardMaterial({ color, roughness:0.5 }));
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);
  group.add(makeLabel((emoji ? `${emoji} ` : '') + name));
  group.userData.pickId = name;
  return group;
}

function addEntityBuffered(id, x, z, name, avatar){
  if (state.entities.has(id)) return;
  const isNPC = id.startsWith('npc_');
  const color = isNPC ? 0xf0a000 : 0x00f2a2;
  const node = buildAvatar(name||id, avatar, color);
  node.position.set(x||0, 1.0, z||0);
  state.scene.add(node);

  state.entities.set(id, {
    group: node,
    name: name || id,
    target: new THREE.Vector3(x||0, 1.0, z||0)
  });

  if (id === state.playerId) state.player = state.entities.get(id);
}

function removeEntity(id){
  const e = state.entities.get(id);
  if (!e) return;
  state.scene.remove(e.group);
  state.entities.delete(id);
}

// ---------- Input ----------
const keys = {};
addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
addEventListener('keyup',   e => { keys[e.key.toLowerCase()] = false; });

ui.sendBtn.onclick = () => { const t = ui.msg.value.trim(); if (!t) return; sendMessage(t); ui.msg.value = ''; };
ui.msg.addEventListener('keydown', e => { if (e.key === 'Enter') ui.sendBtn.click(); });

const avatarList = ['🙂','😀','🙃','😎','🧑','👩','👨','🧔','👱‍♀️','👱‍♂️','🧕','👳'];
avatarList.forEach(emoji=>{
  const d = document.createElement('div');
  d.className = 'av'; d.textContent = emoji;
  d.onclick = () => {
    document.querySelectorAll('.av').forEach(x=>x.classList.remove('sel'));
    d.classList.add('sel'); state.avatarEmoji = emoji;
    ui.startBtn.disabled = !ui.nameInput.value.trim();
  };
  ui.avatars.appendChild(d);
});

ui.nameInput.oninput = () => { ui.startBtn.disabled = !ui.nameInput.value.trim(); };
ui.startBtn.addEventListener('click', () => {
  state.username = ui.nameInput.value.trim();
  state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  ui.overlay.style.display = 'none';
  connectWS();
});

function tickMovement(dt){
  if (!state.player) return;
  const me = state.player;
  const sprint = keys['shift'] ? 1.7 : 1.0;
  const speed = 6 * sprint;
  const vx = (keys['d']||keys['arrowright']?1:0) - (keys['a']||keys['arrowleft']?1:0);
  const vz = (keys['s']||keys['arrowdown']?1:0) - (keys['w']||keys['arrowup']?1:0);
  if (!vx && !vz) return;
  const dir = new THREE.Vector3(vx,0,vz).normalize().multiplyScalar(speed*dt);
  const pos = me.group.position.clone().add(dir);
  pos.x = THREE.MathUtils.clamp(pos.x, -290, 290);
  pos.z = THREE.MathUtils.clamp(pos.z, -290, 290);
  me.group.position.copy(pos);

  // camera follow
  controls.target.lerp(new THREE.Vector3(pos.x, 1.6, pos.z), 0.15);

  // throttle network update
  const now = performance.now();
  if (!tickMovement.last || now - tickMovement.last > 90) {
    tickMovement.last = now;
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type:'move', x: pos.x, z: pos.z }));
    }
  }
}

function interpolateRemotes(){
  state.entities.forEach((e, id) => {
    if (id === state.playerId) return;
    e.group.position.lerp(e.target, 0.16);
  });
}

// ---------- Context menu (right click on avatar) ----------
renderer.domElement.addEventListener('contextmenu', ev=>{
  ev.preventDefault();
  // pick simple by distance to sprite; inexpensive raycast against all avatar meshes
  const mouse = new THREE.Vector2(
    (ev.clientX / renderer.domElement.clientWidth) * 2 - 1,
    -(ev.clientY / renderer.domElement.clientHeight) * 2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  const meshes = [];
  state.entities.forEach(e => e.group.children.forEach(ch => { if (ch.isMesh || ch.isSprite) meshes.push(ch); }));
  const hit = ray.intersectObjects(meshes, true)[0];

  const menu = ui.rightMenu;
  menu.style.left = ev.clientX + 'px';
  menu.style.top  = ev.clientY + 'px';
  menu.style.display = 'block';

  if (hit){
    // walk up to group root to get id
    let g = hit.object;
    while (g && !g.parent?.userData?.pickId && g.parent) g = g.parent;
    const ent = [...state.entities.values()].find(e => e.group === g.parent || e.group === g);
    if (ent){
      ui.mChat.textContent   = '💬 Chat met ' + ent.name;
      ui.mReport.textContent = '⚠️ Rapporteer ' + ent.name;
      ui.mChat.onclick = () => { state.targetId = [...state.entities.entries()].find(([id,obj])=>obj===ent)[0]; ui.targetName.textContent = ent.name; menu.style.display='none'; };
      ui.mReport.onclick = () => {
        const id = [...state.entities.entries()].find(([id,obj])=>obj===ent)[0];
        if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type:'report', reportedId: id }));
        menu.style.display='none';
      };
    }
  } else {
    ui.mChat.textContent = 'Geen avatar hier'; ui.mReport.textContent = '—';
    ui.mChat.onclick = ui.mReport.onclick = () => menu.style.display='none';
  }
  ui.mClear.onclick = () => { state.targetId = null; ui.targetName.textContent = 'Openbaar'; menu.style.display='none'; };
  setTimeout(()=> addEventListener('click', ()=> menu.style.display='none', { once:true }), 100);
});

// ---------- Minimap ----------
ui.minimapCanvas.width = 200; ui.minimapCanvas.height = 200;
function updateMinimap(){
  const ctx = ui.minimapCanvas.getContext('2d');
  ctx.fillStyle = 'rgba(10,15,24,.95)'; ctx.fillRect(0,0,200,200);
  ctx.strokeStyle = '#1a2d3a'; ctx.lineWidth = 1;
  for(let i=0;i<=10;i++){ const p=i*20; ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,200); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(200,p); ctx.stroke(); }
  state.entities.forEach((ent,id)=>{
    const x = ((ent.group.position.x + 100) / 200) * 200;
    const z = ((ent.group.position.z + 100) / 200) * 200;
    const me = id===state.playerId;
    ctx.fillStyle = me ? '#00ff88' : '#888';
    ctx.beginPath(); ctx.arc(x,z, me?5:3, 0, Math.PI*2); ctx.fill();
    if (me){ ctx.strokeStyle='#00ff88'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(x,z,10,0,Math.PI*2); ctx.stroke(); }
  });
}

// ---------- Weather & time ----------
function updateWeather(type, intensity){
  state.weather = { type, intensity };
  ui.weatherIcon.textContent = { clear:'☀️', cloudy:'☁️', rain:'🌧️', fog:'🌫️' }[type] || '☀️';
  // simple lighting mood
  if (type==='fog'){ renderer.setClearAlpha(1); scene.fog = new THREE.FogExp2(0x0b1020, 0.008*intensity); }
  else if (type==='rain'){ scene.fog = new THREE.FogExp2(0x0b1020, 0.004*intensity); }
  else if (type==='cloudy'){ scene.fog = new THREE.FogExp2(0x0b1020, 0.002*intensity); }
  else { scene.fog = null; }
}
function updateTimeOfDay(gameTime){
  state.gameTime = gameTime;
  const hour = Math.floor(gameTime), min = Math.floor((gameTime-hour)*60);
  ui.timeDisplay.textContent = `${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  // warm/cool sun
  const t = (Math.sin((gameTime/24)*Math.PI*2 - Math.PI/2)+1)/2; // 0..1
  sun.color.setHSL(0.1+0.07*(1-t), 0.8, 0.6+0.2*t);
  sun.intensity = 0.3 + 1.2*t;
}

// ---------- WebSocket ----------
function connectWS(){
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', ()=>{
    ui.conn.textContent = '● Connected'; ui.conn.style.color = '#00ff88';
    state.ws.send(JSON.stringify({ type:'join', playerId: state.playerId, username: state.username, avatar: state.avatarEmoji, x:0, z:0 }));
    addLine('SYSTEM:', 'Verbonden met server. Wereld laden...', false, true);
  });

  state.ws.addEventListener('message', e=>{
    let data; try { data = JSON.parse(e.data); } catch { return; }
    switch(data.type){
      case 'init': {
        data.players.forEach(p => addEntityBuffered(p.id, p.x, p.z, p.username, p.avatar));
        data.npcs.forEach(n => addEntityBuffered(n.id, n.x, n.z, n.name, '🤖'));
        if (!state.entities.has(state.playerId)) addEntityBuffered(state.playerId, 0, 0, state.username, state.avatarEmoji);
        state.player = state.entities.get(state.playerId);
        if (state.player) controls.target.copy(state.player.group.position);
        if (data.weather){ updateWeather(data.weather.type, data.weather.intensity); updateTimeOfDay(data.weather.gameTime); }
        ui.statPlayers.textContent = data.players.length;
        break;
      }
      case 'player_joined':
        if (data.player.id !== state.playerId)
          addEntityBuffered(data.player.id, data.player.x, data.player.z, data.player.username, data.player.avatar);
        addLine('SYSTEM:', `${data.player.username} has joined`, false, true);
        ui.statPlayers.textContent = String(parseInt(ui.statPlayers.textContent||'0') + 1);
        break;
      case 'player_left':
        removeEntity(data.playerId);
        ui.statPlayers.textContent = String(Math.max(0, parseInt(ui.statPlayers.textContent||'0') - 1));
        break;
      case 'player_move': {
        const ent = state.entities.get(data.playerId);
        if (ent) ent.target.set(data.x, 1.0, data.z);
        break;
      }
      case 'npc_update':
        data.npcs.forEach(npc => {
          const ent = state.entities.get(npc.id);
          if (ent) ent.target.set(npc.x, 1.0, npc.z);
        });
        break;
      case 'chat': {
        const sender = data.username; const msg = data.message;
        addLine(data.private ? `${sender} (privé):` : `${sender}:`, msg, !!data.private);
        break;
      }
      case 'penalty': updateCredits(data.amount, data.reason); break;
      case 'report_result':
        state.stats.reportsTotal++;
        if (data.correct){ state.stats.reportsCorrect++; updateCredits(50, `Correct! ${data.reportedName} is een echte speler`); }
        else updateCredits(-30, `Onjuist rapport over ${data.reportedName}`);
        updateStats();
        break;
      case 'weather_update': updateWeather(data.weather, data.intensity); break;
      case 'time_update': updateTimeOfDay(data.gameTime); break;
      case 'system': addLine('SYSTEM:', data.message, false, true); break;
      case 'position_correction':
        if (state.player){ state.player.group.position.set(data.x,1.0,data.z); }
        break;
    }
  });

  state.ws.addEventListener('close', ()=>{
    ui.conn.textContent = '● Reconnecting...'; ui.conn.style.color = '#ff8800';
    addLine('SYSTEM:', 'Verbinding verbroken. Opnieuw verbinden...', false, true);
    setTimeout(connectWS, 2000);
  });
}

// ---------- Main loop ----------
function loop(){
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, state.clock.getDelta());
  tickMovement(dt);
  interpolateRemotes();
  updateMinimap();
  controls.update();
  renderer.render(scene, camera);
}
loop();

addEventListener('resize', ()=>{
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
});
