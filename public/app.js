// public/app.js — client: city scene, reliable spawns, WASD avatar movement,
// private chat/report, name-rule scoring (server), robust picking, smooth camera.

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

  entities: new Map(),   // id -> { node, name, target: Vector3 }
  player: null,

  avatarReady: false,
  avatarTemplate: null,
  pendingSpawns: [],
};

// ---------- Chat helpers ----------
function addLine(user, text) {
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<span class="user">${escapeHtml(user)}</span> ${escapeHtml(text)}`;
  ui.chatlog.appendChild(div);
  ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  while (ui.chatlog.children.length > 200) ui.chatlog.removeChild(ui.chatlog.firstChild);
}
function escapeHtml(s){return s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function sendMessage(text){
  const payload={type:'chat',message:text};
  if(state.targetId) payload.targetId=state.targetId;
  if(state.ws?.readyState===WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
  addLine(state.targetId ? `${state.username} (privé):` : `${state.username}:`, text);
}

// ---------- Babylon scene ----------
const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer:true, stencil:true }, true);
state.engine = engine;

const createScene = async () => {
  const scene = new BABYLON.Scene(engine);
  state.scene = scene;

  // Tone mapping
  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.2;
  scene.clearColor = new BABYLON.Color4(0.02,0.04,0.10,1);

  // 3rd-person camera (keyboard disabled; only mouse controls camera)
  const cam = new BABYLON.ArcRotateCamera('cam',
    BABYLON.Tools.ToRadians(-35),
    BABYLON.Tools.ToRadians(55),
    45, new BABYLON.Vector3(0,2,0), scene);
  cam.attachControl(canvas, true);
  cam.wheelPrecision = 20;
  cam.panningSensibility = 500;
  cam.lowerRadiusLimit = 10;
  cam.upperRadiusLimit = 120;
  cam.lowerBetaLimit = BABYLON.Tools.ToRadians(15);
  cam.upperBetaLimit = BABYLON.Tools.ToRadians(89);
  cam.keysUp = cam.keysDown = cam.keysLeft = cam.keysRight = []; // ⛔ camera won't consume arrows
  state.camera = cam;

  // Lights
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0,1,0), scene);
  hemi.intensity = 0.5;
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.3,-1,-0.2), scene);
  sun.position = new BABYLON.Vector3(60,80,60);
  sun.intensity = 1.25;
  const shadow = new BABYLON.ShadowGenerator(4096, sun);
  shadow.useExponentialShadowMap = true;
  state.shadow = shadow;

  // IBL, fog
  scene.environmentTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(
    'https://assets.babylonjs.com/environments/environmentSpecular.env', scene);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.002;
  scene.fogColor = new BABYLON.Color3(0.02,0.04,0.10);

  // City
  buildCity(scene);

  // Post FX
  const pipeline = new BABYLON.DefaultRenderingPipeline("pipe", true, scene, [cam]);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomWeight = 0.22;
  pipeline.samples = 4;

  // Avatar template (with spawn buffering)
  await loadAvatarTemplate(scene);

  // Right-click menu
  canvas.addEventListener('contextmenu', (ev)=>{
    ev.preventDefault();
    const pick = scene.pick(ev.clientX, ev.clientY, m => !!m.metadata?.entityId);
    const menu = ui.rightMenu;
    menu.style.left = ev.clientX+'px';
    menu.style.top = ev.clientY+'px';
    menu.style.display='block';

    if (pick && pick.hit && pick.pickedMesh?.metadata?.entityId){
      const id = pick.pickedMesh.metadata.entityId;
      const ent = state.entities.get(id);
      ui.mChat.textContent = 'Chat met ' + (ent?.name || 'onbekend');
      ui.mReport.textContent = 'Rapporteer ' + (ent?.name || 'onbekend');
      ui.mChat.onclick = ()=>{ state.targetId = id; ui.targetName.textContent = ent?.name || 'Openbaar'; menu.style.display='none'; };
      ui.mReport.onclick = ()=>{ state.ws?.readyState===WebSocket.OPEN && state.ws.send(JSON.stringify({type:'report', reportedId:id})); menu.style.display='none'; };
    } else {
      ui.mChat.textContent='Geen avatar hier';
      ui.mReport.textContent='—';
      ui.mChat.onclick = ()=> menu.style.display='none';
      ui.mReport.onclick = ()=> menu.style.display='none';
    }
    ui.mClear.onclick = ()=>{ state.targetId = null; ui.targetName.textContent='Openbaar'; menu.style.display='none'; };
    window.addEventListener('click', ()=> menu.style.display='none', { once:true });
  });

  // Input & chat
  setupControls();

  // Render loop
  let last = performance.now();
  engine.runRenderLoop(()=>{
    const now = performance.now();
    const dt = Math.min(0.05,(now-last)/1000); last = now;
    tickMovement(dt);
    interpolateRemotes();
    scene.render();
  });
  window.addEventListener('resize', ()=>engine.resize());
  return scene;
};

createScene();

// ---------- City helpers ----------
function pbr(scene,{albedo=[1,1,1], rough=.9, metal=0}={}) {
  const m = new BABYLON.PBRMaterial('m'+Math.random(), scene);
  m.albedoColor = new BABYLON.Color3(...albedo);
  m.roughness = rough; m.metallic = metal;
  return m;
}
function buildCity(scene){
  // ground
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 600, height: 600 }, scene);
  ground.material = pbr(scene,{albedo:[.93,.95,.97], rough:.95});

  // roads/sidewalks/canals
  const asphalt = pbr(scene,{albedo:[.12,.12,.14], rough:.6, metal:.1});
  const sidewalk = pbr(scene,{albedo:[.70,.71,.74], rough:.85});
  const water = pbr(scene,{albedo:[.15,.2,.3], rough:.12, metal:1});

  for (let row=-4; row<=4; row++){
    const y = .03;
    const r = BABYLON.MeshBuilder.CreateBox('road'+row,{ width: 600, height:.06, depth: 16 }, scene);
    r.position.set(0,y,row*50); r.material = asphalt; r.receiveShadows = true;

    const s1 = BABYLON.MeshBuilder.CreateBox('swA'+row,{ width: 600, height:.10, depth: 5 }, scene);
    s1.position.set(0,.05,row*50+11); s1.material = sidewalk;
    const s2 = s1.clone('swB'+row); s2.position.z = row*50-11;

    if (row%2===0){
      const c1 = BABYLON.MeshBuilder.CreateBox('c1'+row,{ width: 600, height:.04, depth: 8 }, scene);
      c1.position.set(0,.02,row*50+23); c1.material = water;
      const c2 = c1.clone('c2'+row); c2.position.z = row*50-23;
    }
  }

  // buildings
  const brick = pbr(scene,{albedo:[.78,.66,.60], rough:.9});
  for (let x=-5;x<=5;x++){
    for(let z=-5; z<=5; z++){
      if (Math.abs(x)%2===1 && Math.abs(z)%2===1) continue;
      const h = 8 + Math.random()*18;
      const b = BABYLON.MeshBuilder.CreateBox(`b_${x}_${z}`, { width: 16+Math.random()*8, height: h, depth: 16+Math.random()*8 }, scene);
      b.position.set(x*45 + (Math.random()*6-3), h/2, z*45 + (Math.random()*6-3));
      b.material = brick; b.receiveShadows = true; b.castShadow = true;
      state.shadow?.addShadowCaster(b);
    }
  }

  // streetlights
  const poleMat = pbr(scene,{albedo:[.2,.2,.22], rough:.7});
  for(let i=-6;i<=6;i++){
    for(let j=-6;j<=6;j++){
      const p = new BABYLON.TransformNode('lamp_'+i+'_'+j, scene);
      p.position.set(i*45,0,j*45+10);
      const pole = BABYLON.MeshBuilder.CreateCylinder('pole',{ diameter:.25, height:4 }, scene); pole.material=poleMat; pole.position.y=2; pole.parent=p;
      const head = BABYLON.MeshBuilder.CreateBox('head',{ width:.6,height:.3,depth:.6 }, scene); head.material=poleMat; head.position.y=4.1; head.parent=p;
      const glow = new BABYLON.PointLight('L'+i+'_'+j, new BABYLON.Vector3(0,4.3,0), scene);
      glow.parent = p; glow.intensity = 0.35; glow.range = 18;
    }
  }
}

// ---------- Avatar ----------
async function loadAvatarTemplate(scene){
  const URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb";
  try{
    const cont = await BABYLON.SceneLoader.LoadAssetContainerAsync(URL, undefined, scene);
    const root = new BABYLON.TransformNode("avatarTemplate", scene);
    cont.meshes.forEach(m=>{ m.setEnabled(false); m.parent = root; m.alwaysSelectAsActiveMesh = true; m.receiveShadows=true; m.castShadow=true; });
    state.avatarTemplate = root; state.avatarReady = true;
  }catch(e){
    console.warn('Avatar fallback gebruikt', e);
    state.avatarTemplate = null; state.avatarReady = true;
  }
  state.pendingSpawns.splice(0).forEach(s=>reallyAddEntity(s.id,s.x,s.z,s.name));
}

function tagPickableRecursive(mesh, entityId, name){
  if (!mesh) return;
  mesh.metadata = { entityId, name };
  mesh.isPickable = true;
  (mesh.getChildMeshes ? mesh.getChildMeshes() : []).forEach(ch => {
    ch.metadata = { entityId, name };
    ch.isPickable = true;
  });
}
function makeLabel(name){
  const scene = state.scene;
  const plane = BABYLON.MeshBuilder.CreatePlane('lbl_'+name,{ width:1.8, height:.45 },scene);
  plane.position.y = 2.6; plane.isPickable = false;
  const tex = BABYLON.DynamicTexture.CreateForMesh(plane, {width:512, height:128}, false);
  const ctx = tex.getContext();
  ctx.fillStyle='rgba(0,0,0,.65)'; ctx.fillRect(0,0,512,128);
  ctx.fillStyle='#00ff88'; ctx.font='bold 48px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(name, 256, 64); tex.update();
  const mat = new BABYLON.StandardMaterial('lblm_'+name,scene);
  mat.diffuseTexture = tex; mat.emissiveTexture = tex; mat.opacityTexture = tex; mat.backFaceCulling=false;
  plane.material = mat; return plane;
}
function buildAvatar(name){
  const scene = state.scene;
  let root;
  if (state.avatarTemplate){
    root = state.avatarTemplate.clone('a_'+name);
    root.getChildMeshes().forEach(m=>m.setEnabled(true));
  } else {
    root = new BABYLON.TransformNode('a_'+name, scene);
    const body = BABYLON.MeshBuilder.CreateCapsule('cap_'+name,{radius:.45, height:1.7},scene);
    const mat = new BABYLON.PBRMaterial('bmat_'+name, scene);
    mat.albedoColor = new BABYLON.Color3(0.02,0.95,0.65); mat.roughness = 0.5;
    body.material = mat; body.parent = root; body.receiveShadows=true; body.castShadow=true;
  }
  const label = makeLabel(name); label.parent = root;
  state.shadow?.addShadowCaster(root);
  return root;
}
function addEntityBuffered(id,x,z,name){
  if(state.entities.has(id)) return;
  if(!state.avatarReady){ state.pendingSpawns.push({id,x,z,name}); return; }
  reallyAddEntity(id,x,z,name);
}
function reallyAddEntity(id,x,z,name){
  const node = buildAvatar(name||id);
  node.position = new BABYLON.Vector3(x||0,0,z||0);
  tagPickableRecursive(node, id, name||id);
  state.entities.set(id, { node, name: name||id, target: node.position.clone() });
}
function removeEntity(id){
  const e = state.entities.get(id);
  if (!e) return; e.node.dispose(); state.entities.delete(id);
}

// ---------- Input / Movement ----------
const keys = {};
function setupControls(){
  window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
  window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
  ui.sendBtn.onclick = ()=>{ const t = ui.msg.value.trim(); if(!t) return; sendMessage(t); ui.msg.value=''; };
  ui.msg.addEventListener('keydown', e=>{ if(e.key==='Enter') ui.sendBtn.click(); });

  // Join – wait for WS open (no premature spawn)
  ui.startBtn.addEventListener('click', ()=>{
    state.username = ui.nameInput.value.trim();
    state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    ui.overlay.style.display='none';
    connectWS();
  });

  ['🙂','😀','🙃','😎','🧑','👩','👨','🧔'].forEach(e=>{
    const d=document.createElement('div'); d.className='av'; d.textContent=e;
    d.onclick=()=>{ document.querySelectorAll('.av').forEach(x=>x.classList.remove('sel')); d.classList.add('sel'); state.avatarEmoji=e; ui.startBtn.disabled = !ui.nameInput.value.trim(); };
    ui.avatars.appendChild(d);
  });
  ui.nameInput.oninput = ()=> ui.startBtn.disabled = !ui.nameInput.value.trim();
}

function tickMovement(dt){
  if (!state.player) return;
  const me = state.player;
  const sprint = keys['shift'] ? 1.8 : 1.0;
  const speed = 5 * sprint;

  const vx = (keys['d']||keys['arrowright']?1:0) - (keys['a']||keys['arrowleft']?1:0);
  const vz = (keys['s']||keys['arrowdown']?1:0) - (keys['w']||keys['arrowup']?1:0);
  if (!vx && !vz) return;

  const delta = new BABYLON.Vector3(vx,0,vz).normalize().scale(speed*dt);
  const pos = me.node.position.add(delta);
  pos.x = BABYLON.Scalar.Clamp(pos.x, -290, 290);
  pos.z = BABYLON.Scalar.Clamp(pos.z, -290, 290);
  me.node.position.copyFrom(pos);

  // camera follow
  state.camera.target = BABYLON.Vector3.Lerp(state.camera.target, new BABYLON.Vector3(pos.x,2,pos.z), .08);

  const now = performance.now();
  if (!tickMovement.last || now - tickMovement.last > 90){
    tickMovement.last = now;
    state.ws?.readyState===WebSocket.OPEN &&
      state.ws.send(JSON.stringify({ type:'move', x: pos.x, z: pos.z }));
  }
}
function interpolateRemotes(){
  state.entities.forEach((e,id)=>{
    if (id===state.playerId) return;
    if (!e.target) return;
    e.node.position = BABYLON.Vector3.Lerp(e.node.position, e.target, .15);
  });
}

// ---------- WebSocket ----------
function connectWS(){
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', ()=>{
    ui.conn.textContent = 'Connected';
    state.ws.send(JSON.stringify({
      type:'join',
      playerId: state.playerId,
      username: state.username,
      avatar: state.avatarEmoji,
      x: 0, z: 0
    }));
    addLine('SYSTEM:','Verbonden. Wereld laden…');
  });

  state.ws.addEventListener('message', (e)=>{
    const data = JSON.parse(e.data);
    switch(data.type){
      case 'init': {
        // everyone
        data.players.forEach(p => addEntityBuffered(p.id,p.x,p.z,p.username));
        data.npcs.forEach(n => addEntityBuffered(n.id,n.x,n.z,n.name));
        // my ref + camera
        state.player = state.entities.get(state.playerId);
        if (!state.player) { addEntityBuffered(state.playerId,0,0,state.username); state.player = state.entities.get(state.playerId); }
        state.camera.target.copyFrom(state.player.node.position);
        break;
      }
      case 'player_joined':
        if (data.player.id === state.playerId) break;
        addEntityBuffered(data.player.id,data.player.x,data.player.z,data.player.username);
        addLine('SYSTEM:', `${data.player.username} heeft zich aangesloten`);
        break;
      case 'player_left':
        removeEntity(data.playerId);
        break;
      case 'player_move':
        const ent = state.entities.get(data.playerId);
        if (ent) ent.target = new BABYLON.Vector3(data.x,0,data.z);
        break;
      case 'chat':
        if (data.private){
          const meSender = data.playerId===state.playerId;
          const meRecipient = data.targetId===state.playerId;
          if (meSender || meRecipient) addLine(`${data.username} (privé):`, data.message);
        } else addLine(data.username+':', data.message);
        break;
      case 'penalty':
        state.credits += data.amount;
        ui.credit.textContent = state.credits;
        addLine('SYSTEM:', `${data.reason} (${data.amount>0?'+':''}${data.amount})`);
        break;
      case 'report_result':
        addLine('SYSTEM:', data.correct ? `+50 credits! Correct: ${data.reportedName}` : `-30 credits. Onjuist rapport over ${data.reportedName}`);
        break;
    }
  });

  state.ws.addEventListener('close', ()=>{
    ui.conn.textContent = 'Connecting...';
    setTimeout(connectWS, 2000);
  });
}
