// public/app.js — Three.js client: flat maze city, skyline, humanoid avatars (animated),
// collisions, WASD movement (no wall clipping), private chat/report, weather, minimap, stats.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }   from 'three/addons/loaders/GLTFLoader.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// ---------- UI refs ----------
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
  loadingSpinner: document.getElementById('loadingSpinner'),
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

  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  clock: new THREE.Clock(),

  mixers: new Map(),           // id -> AnimationMixer
  entities: new Map(),         // id -> {node, name, avatar, target, speed}
  player: null,

  avatarReady: false,
  avatarTemplate: null,        // GLTF scene to clone
  avatarClips: [],             // [idleClip, walkClip?]
  pendingSpawns: [],

  weather: { type: 'clear', intensity: 1 },
  gameTime: 12.0,

  stats: { reportsTotal: 0, reportsCorrect: 0 },

  // Maze collision
  maze: {
    cellSize: 8,
    width: 30,   // cells
    height: 30,  // cells
    walls: [],   // array of {minX,maxX,minZ,maxZ}
    bounds: { minX: -120, maxX: 120, minZ: -120, maxZ: 120 }
  }
};

// ---------- Utils ----------
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function addLine(user, text, isPrivate=false, isSystem=false){
  const div = document.createElement('div');
  div.className = 'line' + (isPrivate?' private':'') + (isSystem?' system':'');
  div.innerHTML = `<span class="user">${escapeHtml(user)}</span> ${escapeHtml(text)}`;
  ui.chatlog.appendChild(div); ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  while (ui.chatlog.children.length > 200) ui.chatlog.removeChild(ui.chatlog.firstChild);
}
function sendMessage(text){
  if (!text || !text.trim()) return;
  const payload = { type:'chat', message: text.trim() };
  if (state.targetId) payload.targetId = state.targetId;
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}
function updateCredits(amount, reason){
  state.credits += amount;
  ui.credit.textContent = state.credits;
  ui.credit.style.color = state.credits < 500 ? '#ff4444' : '#00ff88';
  if (reason) addLine('SYSTEM:', reason, false, true);
}
function updateStats(){
  ui.statReports.textContent = state.stats.reportsTotal;
  ui.statAccuracy.textContent = state.stats.reportsTotal > 0
    ? ((state.stats.reportsCorrect / state.stats.reportsTotal) * 100).toFixed(0) + '%'
    : '--';
}

// ---------- Weather / Time ----------
function updateWeather(type, intensity){
  state.weather = { type, intensity };
  const icons = { clear:'☀️', cloudy:'☁️', rain:'🌧️', fog:'🌫️' };
  ui.weatherIcon.textContent = icons[type] || '☀️';
}
function updateTimeOfDay(gameTime){
  state.gameTime = gameTime;
  const hour = Math.floor(gameTime), min = Math.floor((gameTime - hour) * 60);
  ui.timeDisplay.textContent = `${hour.toString().padStart(2,'0')}:${min.toString().padStart(2,'0')}`;
}

// ---------- Three setup ----------
const canvas = document.getElementById('renderCanvas');

async function createScene(){
  const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  state.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 2000);
  camera.position.set(0, 14, 20);
  state.camera = camera;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = true;
  controls.enableDamping = true;
  controls.enableZoom = true;
  controls.target.set(0, 2, 0);
  controls.update();
  state.controls = controls;

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.75);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(30, 60, 20);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 1;
  dir.shadow.camera.far = 200;
  dir.shadow.camera.left = -80;
  dir.shadow.camera.right = 80;
  dir.shadow.camera.top = 80;
  dir.shadow.camera.bottom = -80;
  scene.add(dir);

  // Background: sky dome + far skyline ring
  makeSky();
  makeSkylineRing();

  // Flat ground + MAZE walls (no big buildings)
  buildMazeEnvironment();

  // Load humanoid avatar template (idle/walk)
  await loadHumanoidTemplate();

  setupContextMenu();
  setupControls();

  // Loop
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    const dt = state.clock.getDelta();
    tickMovement(dt);
    interpolateRemotes();
    tickMixers(dt);
    updateMinimap();
    controls.update();
    renderer.render(scene, camera);
  });
}

// ---------- Background helpers ----------
function makeSky(){
  const geo = new THREE.SphereGeometry(1000, 32, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms:{ top:{value:new THREE.Color(0x0a1c3a)}, bottom:{value:new THREE.Color(0x050a16)}, offset:{value:33}, exponent:{value:0.6} },
    vertexShader:`varying vec3 vWorldPosition; void main(){ vec4 worldPos= modelMatrix*vec4(position,1.0); vWorldPosition=worldPos.xyz; gl_Position = projectionMatrix*viewMatrix*worldPos; }`,
    fragmentShader:`varying vec3 vWorldPosition; uniform vec3 top; uniform vec3 bottom; uniform float offset; uniform float exponent;
      void main(){ float h = normalize(vWorldPosition + offset).y; gl_FragColor = vec4(mix(bottom, top, max(pow(max(h,0.0), exponent), 0.0)), 1.0); }`
  });
  const sky = new THREE.Mesh(geo, mat);
  state.scene.add(sky);
}
function makeSkylineRing(){
  // A distant ring with a stylized skyline texture (silhouette). Not collidable.
  const tex = new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/uv_grid_opengl.jpg'); // placeholder
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0x0f1428, opacity: 0.35, transparent: true, depthWrite:false });
  const geo = new THREE.CylinderGeometry(300, 300, 40, 64, 1, true);
  const skyline = new THREE.Mesh(geo, mat);
  skyline.position.y = 20;
  skyline.rotation.y = Math.PI/8;
  state.scene.add(skyline);
}

// ---------- Maze builder (flat city) ----------
function buildMazeEnvironment(){
  const s = state.scene;
  const cell = state.maze.cellSize;
  const W = state.maze.width, H = state.maze.height;

  // Ground plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(W*cell, H*cell),
    new THREE.MeshStandardMaterial({ color: 0xe8edf5, roughness: 0.95, metalness: 0 })
  );
  ground.receiveShadow = true;
  ground.rotation.x = -Math.PI/2;
  s.add(ground);

  // Road stripes to suggest avenues
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x1a2027, roughness: 0.7 });
  for (let i= -2; i<=2; i++){
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(W*cell, 0.1, 3), roadMat);
    stripe.position.set(0, 0.05, i*20);
    stripe.receiveShadow = true;
    s.add(stripe);
  }

  // Generate a simple maze grid (Prim's or DFS); here a light, open layout
  // We'll build low walls you cannot clip through.
  const rng = (a,b)=> a + Math.floor(Math.random()*(b-a+1));
  const grid = Array.from({length:H}, ()=>Array(W).fill(1)); // 1=wall, 0=space
  function carve(x,z){
    grid[z][x]=0;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]].sort(()=>Math.random()-0.5);
    for(const [dx,dz] of dirs){
      const nx=x+dx*2, nz=z+dz*2;
      if (nx>1 && nz>1 && nx<W-2 && nz<H-2 && grid[nz][nx]===1){
        grid[z+dz][x+dx]=0;
        carve(nx,nz);
      }
    }
  }
  carve(rng(2,W-3)|1, rng(2,H-3)|1); // start odd cell

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.85, metalness: 0.05 });
  const curbMat = new THREE.MeshStandardMaterial({ color: 0xcfd6de, roughness: 0.9 });

  // Curbs around playfield
  const curb = new THREE.Mesh(new THREE.BoxGeometry(W*cell+2, 0.6, H*cell+2), curbMat);
  curb.position.y = 0.3;
  s.add(curb);

  // Build walls + record AABBs for collision
  const walls = [];
  const wallHeight = 2.2;
  for (let z=0; z<H; z++){
    for (let x=0; x<W; x++){
      if (grid[z][x]===1){
        const wx = (x - W/2 + 0.5) * cell;
        const wz = (z - H/2 + 0.5) * cell;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(cell, wallHeight, cell), wallMat);
        wall.castShadow = true; wall.receiveShadow = true;
        wall.position.set(wx, wallHeight/2, wz);
        s.add(wall);
        walls.push(aabbFromMesh(wall, 0.02));
      }
    }
  }
  state.maze.walls = walls;

  // Bounds for minimap clamp
  state.maze.bounds = {
    minX: -(W*cell)/2+1,
    maxX:  (W*cell)/2-1,
    minZ:  -(H*cell)/2+1,
    maxZ:  (H*cell)/2-1
  };
}
function aabbFromMesh(mesh, pad=0){
  const b = new THREE.Box3().setFromObject(mesh);
  return {
    minX: b.min.x - pad, maxX: b.max.x + pad,
    minZ: b.min.z - pad, maxZ: b.max.z + pad,
    yTop: b.max.y, yBottom: b.min.y
  };
}
function collidePoint(next){
  // Simple AABB resolution against maze walls
  for (const w of state.maze.walls){
    if (next.x > w.minX && next.x < w.maxX && next.z > w.minZ && next.z < w.maxZ){
      return true;
    }
  }
  return false;
}

// ---------- Humanoid avatar (GLTF) ----------
async function loadHumanoidTemplate(){
  const loader = new GLTFLoader();
  // Humanoid sample model with idle/walk animations
  const url = 'https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb';
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  root.traverse(o => { if (o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });
  state.avatarTemplate = root;
  // Collect animations (RobotExpressive has multiple)
  state.avatarClips = gltf.animations || [];
  state.avatarReady = true;

  // Process any pending spawns
  state.pendingSpawns.splice(0).forEach(s => reallyAddEntity(s.id, s.x, s.z, s.name, s.avatar));
}
function buildAvatar(name, emoji){
  let node;
  if (state.avatarTemplate){
    node = state.avatarTemplate.clone(true);
    node.scale.set(0.9, 0.9, 0.9);
  } else {
    // fallback capsule if GLTF fails
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.5, 1.0, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0x00d0a0, metalness: 0.1, roughness: 0.5 })
    );
    node = new THREE.Group();
    body.castShadow = true; body.receiveShadow = true;
    node.add(body);
  }

  // Floating nameplate
  const label = makeLabelSprite(emoji ? `${emoji} ${name}` : name);
  label.position.set(0, 2.4, 0);
  node.add(label);
  return node;
}
function makeLabelSprite(text){
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0,0,512,128);
  ctx.fillStyle = '#00ff88';
  ctx.font = 'bold 56px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite:false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.2, 0.6, 1);
  return sp;
}

// ---------- Entities ----------
function addEntityBuffered(id, x, z, name, avatar){
  if (state.entities.has(id)) return;
  if (!state.avatarReady){
    state.pendingSpawns.push({id, x, z, name, avatar});
    return;
  }
  reallyAddEntity(id, x, z, name, avatar);
}
function reallyAddEntity(id, x, z, name, avatar){
  const node = buildAvatar(name||id, avatar);
  node.position.set(x||0, 0, z||0);
  state.scene.add(node);

  // Animate (idle default)
  const mixer = new THREE.AnimationMixer(node);
  let idle;
  // try find an idle-like clip
  idle = state.avatarClips.find(c=>/idle/i.test(c.name)) || state.avatarClips[0];
  if (idle) {
    const action = mixer.clipAction(idle);
    action.play();
  }
  state.mixers.set(id, mixer);

  state.entities.set(id, {
    node, name: name||id, avatar: avatar||'🙂', target: node.position.clone(), speed: 5,
    currentAction: 'idle'
  });
}
function removeEntity(id){
  const e = state.entities.get(id);
  if (!e) return;
  state.scene.remove(e.node);
  state.mixers.delete(id);
  state.entities.delete(id);
}
function setWalkState(id, walking){
  const mixer = state.mixers.get(id);
  if (!mixer || state.avatarClips.length===0) return;
  const ent = state.entities.get(id);
  if (!ent) return;

  const idle = state.avatarClips.find(c=>/idle/i.test(c.name)) || state.avatarClips[0];
  const walk = state.avatarClips.find(c=>/(walk|run)/i.test(c.name)) || null;

  if (walking && ent.currentAction!=='walk' && walk){
    mixer.stopAllAction();
    mixer.clipAction(walk).reset().fadeIn(0.15).play();
    ent.currentAction='walk';
  } else if (!walking && ent.currentAction!=='idle' && idle){
    mixer.stopAllAction();
    mixer.clipAction(idle).reset().fadeIn(0.15).play();
    ent.currentAction='idle';
  }
}
function tickMixers(dt){
  for (const m of state.mixers.values()) m.update(dt);
}

// ---------- Input & Movement with collisions ----------
const keys = {};
function setupControls(){
  window.addEventListener('keydown', (e)=>{ keys[e.key.toLowerCase()] = true; });
  window.addEventListener('keyup', (e)=>{ keys[e.key.toLowerCase()] = false; });

  ui.sendBtn.onclick = () => {
    const text = ui.msg.value.trim(); if (!text) return;
    sendMessage(text); ui.msg.value = '';
  };
  ui.msg.addEventListener('keydown', e => { if (e.key === 'Enter') ui.sendBtn.click(); });

  // Avatar picker
  const avatarList = ['🙂','😀','🙃','😎','🧑','👩','👨','🧔','👱‍♀️','👱‍♂️','🧕','👳'];
  avatarList.forEach(emoji => {
    const d = document.createElement('div');
    d.className = 'av'; d.textContent = emoji;
    d.onclick = () => {
      document.querySelectorAll('.av').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel'); state.avatarEmoji = emoji;
      ui.startBtn.disabled = !ui.nameInput.value.trim();
    };
    ui.avatars.appendChild(d);
  });
  ui.nameInput.oninput = () => { ui.startBtn.disabled = !ui.nameInput.value.trim(); };

  ui.startBtn.addEventListener('click', () => {
    state.username = ui.nameInput.value.trim();
    state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    ui.overlay.style.display = 'none';
    ui.loadingSpinner.style.display = 'block';
    connectWS();
  });
}
function tickMovement(dt){
  const me = state.player;
  if (!me) return;

  // WASD vector
  let vx = 0, vz = 0;
  if (keys['w'] || keys['arrowup']) vz -= 1;
  if (keys['s'] || keys['arrowdown']) vz += 1;
  if (keys['a'] || keys['arrowleft']) vx -= 1;
  if (keys['d'] || keys['arrowright']) vx += 1;

  if (vx===0 && vz===0) { setWalkState(state.playerId, false); return; }

  const sprint = keys['shift'] ? 1.7 : 1.0;
  const speed = 5 * sprint;
  const dir = new THREE.Vector3(vx, 0, vz).normalize().multiplyScalar(speed * dt);

  // Propose next position
  const next = me.node.position.clone().add(dir);

  // Prevent going out of bounds
  const b = state.maze.bounds;
  next.x = Math.min(Math.max(next.x, b.minX), b.maxX);
  next.z = Math.min(Math.max(next.z, b.minZ), b.maxZ);

  // Collision: try axis by axis (simple resolution)
  const tryX = me.node.position.clone(); tryX.x = next.x;
  if (!collidePoint(tryX)) me.node.position.x = next.x;

  const tryZ = me.node.position.clone(); tryZ.z = next.z;
  if (!collidePoint(tryZ)) me.node.position.z = next.z;

  // Face move direction
  if (dir.lengthSq() > 1e-4){
    const yaw = Math.atan2(-dir.z, dir.x) + Math.PI/2;
    me.node.rotation.y = yaw;
  }

  setWalkState(state.playerId, true);

  // Smooth follow camera target
  const camTarget = me.node.position.clone();
  camTarget.y = 2;
  state.controls.target.lerp(camTarget, 0.15);

  // Throttled network update
  const now = performance.now();
  if (!tickMovement.last || now - tickMovement.last > 90){
    tickMovement.last = now;
    if (state.ws?.readyState === WebSocket.OPEN){
      state.ws.send(JSON.stringify({ type:'move', x: me.node.position.x, z: me.node.position.z }));
    }
  }
}
function interpolateRemotes(){
  state.entities.forEach((e,id)=>{
    if (id===state.playerId) return;
    if (!e.target) return;
    e.node.position.lerp(e.target, 0.18);
  });
}

// ---------- Context menu ----------
function setupContextMenu(){
  canvas.addEventListener('contextmenu', ev=>{
    ev.preventDefault();
    // Raycast for entity (hit testing labels/meshes)
    const mouse = new THREE.Vector2(
      (ev.clientX / window.innerWidth) * 2 - 1,
      -(ev.clientY / window.innerHeight) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, state.camera);
    const meshes = [];
    state.entities.forEach(e=>e.node.traverse(o=>{ if (o.isMesh) meshes.push(o); }));
    const hit = ray.intersectObjects(meshes, true)[0];
    const menu = ui.rightMenu;
    menu.style.left = ev.clientX + 'px';
    menu.style.top = ev.clientY + 'px';
    menu.style.display = 'block';

    let targetId = null, targetName = 'onbekend';
    if (hit){
      // find owning entity
      state.entities.forEach((e,id)=>{
        if (e.node === hit.object && !targetId){ targetId = id; targetName = e.name; }
        else if (hit.object.parent && e.node.uuid === hit.object.parent.uuid && !targetId){ targetId = id; targetName = e.name; }
      });
    }
    if (targetId){
      ui.mChat.textContent = '💬 Chat met ' + targetName;
      ui.mReport.textContent = '⚠️ Rapporteer ' + targetName;
      ui.mChat.onclick = ()=>{ state.targetId = targetId; ui.targetName.textContent = targetName; menu.style.display='none'; };
      ui.mReport.onclick = ()=>{
        if (state.ws?.readyState === WebSocket.OPEN){
          state.ws.send(JSON.stringify({ type:'report', reportedId: targetId }));
        }
        menu.style.display='none';
      };
    } else {
      ui.mChat.textContent='Geen avatar hier'; ui.mReport.textContent='—';
      ui.mChat.onclick = ()=> menu.style.display='none';
      ui.mReport.onclick = ()=> menu.style.display='none';
    }
    ui.mClear.onclick = ()=>{ state.targetId=null; ui.targetName.textContent='Openbaar'; menu.style.display='none'; };
    setTimeout(()=> window.addEventListener('click', ()=> menu.style.display='none', {once:true}), 100);
  });
}

// ---------- Minimap ----------
function updateMinimap(){
  const ctx = ui.minimapCanvas.getContext('2d');
  ui.minimapCanvas.width = 200; ui.minimapCanvas.height = 200;
  ctx.fillStyle = 'rgba(10, 15, 24, 0.95)'; ctx.fillRect(0,0,200,200);

  // grid
  ctx.strokeStyle = '#1a2d3a'; ctx.lineWidth=1;
  for (let i=0;i<=10;i++){
    const p = i*20; ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,200); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(200,p); ctx.stroke();
  }

  // entities
  const b = state.maze.bounds;
  const sx = x => 200 * (x - b.minX) / (b.maxX - b.minX);
  const sz = z => 200 * (z - b.minZ) / (b.maxZ - b.minZ);

  state.entities.forEach((ent,id)=>{
    const x = sx(ent.node.position.x), z = sz(ent.node.position.z);
    const me = id===state.playerId;
    ctx.fillStyle = me ? '#00ff88' : '#888';
    ctx.beginPath(); ctx.arc(x,z, me?5:3, 0, Math.PI*2); ctx.fill();
    if (me){ ctx.strokeStyle='#00ff88'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(x,z,10,0,Math.PI*2); ctx.stroke(); }
  });
}

// ---------- WebSocket ----------
function connectWS(){
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', ()=>{
    ui.conn.textContent = '● Connected'; ui.conn.style.color = '#00ff88';
    state.ws.send(JSON.stringify({
      type:'join', playerId: state.playerId, username: state.username, avatar: state.avatarEmoji, x:0, z:0
    }));
    addLine('SYSTEM:', 'Verbonden met server. Wereld laden...', false, true);
  });

  state.ws.addEventListener('message', e=>{
    let data; try{ data = JSON.parse(e.data); } catch{ return; }
    switch(data.type){
      case 'init': {
        data.players.forEach(p=> addEntityBuffered(p.id, p.x, p.z, p.username, p.avatar));
        data.npcs.forEach(n=> addEntityBuffered(n.id, n.x, n.z, n.name, '🤖'));

        state.player = state.entities.get(state.playerId);
        if (!state.player){ addEntityBuffered(state.playerId, 0,0, state.username, state.avatarEmoji); state.player = state.entities.get(state.playerId); }

        if (state.player){
          state.controls.target.copyFrom(state.player.node.position); state.controls.target.y = 2;
        }

        if (data.weather){
          updateWeather(data.weather.type, data.weather.intensity);
          updateTimeOfDay(data.weather.gameTime);
        }
        ui.statPlayers.textContent = String(data.players.length);
        ui.loadingSpinner.style.display = 'none';
        break;
      }
      case 'player_joined':
        if (data.player.id !== state.playerId){
          addEntityBuffered(data.player.id, data.player.x, data.player.z, data.player.username, data.player.avatar);
          addLine('SYSTEM:', `${data.player.username} heeft zich aangesloten`, false, true);
          ui.statPlayers.textContent = String(parseInt(ui.statPlayers.textContent)+1);
        }
        break;
      case 'player_left':
        removeEntity(data.playerId);
        ui.statPlayers.textContent = String(Math.max(0, parseInt(ui.statPlayers.textContent)-1));
        break;
      case 'player_move': {
        const ent = state.entities.get(data.playerId);
        if (ent){ ent.target = new THREE.Vector3(data.x, 0, data.z); }
        break;
      }
      case 'npc_update':
        data.npcs.forEach(npc=>{
          const ent = state.entities.get(npc.id);
          if (ent){
            // Snap incoming NPC positions to navigable space if they hit a wall
            const v = new THREE.Vector3(npc.x, 0, npc.z);
            if (!collidePoint(v)) ent.target = v;
          }
        });
        break;
      case 'chat': {
        const isPrivate = data.private || false;
        addLine(isPrivate ? `${data.username} (privé):` : `${data.username}:`, data.message, isPrivate);
        break;
      }
      case 'penalty': updateCredits(data.amount, data.reason); break;
      case 'report_result':
        state.stats.reportsTotal++;
        if (data.correct){ state.stats.reportsCorrect++; updateCredits(50, `Correct! ${data.reportedName} is een echte speler`); }
        else { updateCredits(-30, `Onjuist rapport over ${data.reportedName}`); }
        updateStats(); break;
      case 'weather_update': updateWeather(data.weather, data.intensity); break;
      case 'time_update':    updateTimeOfDay(data.gameTime); break;
      case 'system': addLine('SYSTEM:', data.message, false, true); break;
      case 'position_correction':
        if (state.player){
          state.player.node.position.x = data.x; state.player.node.position.z = data.z;
        }
        break;
    }
  });

  state.ws.addEventListener('close', ()=>{
    ui.conn.textContent = '● Reconnecting...'; ui.conn.style.color = '#ff8800';
    addLine('SYSTEM:', 'Verbinding verbroken. Opnieuw verbinden...', false, true);
    setTimeout(connectWS, 2000);
  });
  state.ws.addEventListener('error', err => console.error('[WS] Error', err));
}

// ---------- Boot ----------
createScene().then(()=> console.log('[Game] Scene ready'));
