// public/app.js — Babylon client met besturing, stad, correcte picking en spawns

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
  engine: null,
  scene: null,
  camera: null,
  shadow: null,

  // id -> { node, name, target: Vector3, speed }
  entities: new Map(),
  player: null,

  // assets
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
  const suffix=state.targetId?` (naar ${state.entities.get(state.targetId)?.name||''})`:`:`;
  addLine(state.username+suffix,text);
}

// ---------- Babylon setup ----------
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

  // Camera: 3rd person ArcRotate met limieten (niet onder grond)
  const camera = new BABYLON.ArcRotateCamera('cam',
    BABYLON.Tools.ToRadians(-35),
    BABYLON.Tools.ToRadians(55),
    45, new BABYLON.Vector3(0,2,0), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 20;
  camera.panningSensibility = 500;
  camera.lowerRadiusLimit = 10;
  camera.upperRadiusLimit = 120;
  camera.lowerBetaLimit = BABYLON.Tools.ToRadians(15);
  camera.upperBetaLimit = BABYLON.Tools.ToRadians(89);
  state.camera = camera;

  // Licht
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0,1,0), scene);
  hemi.intensity = 0.5;
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.3,-1,-0.2), scene);
  sun.position = new BABYLON.Vector3(60,80,60);
  sun.intensity = 1.3;

  const shadow = new BABYLON.ShadowGenerator(4096, sun);
  shadow.useExponentialShadowMap = true;
  state.shadow = shadow;

  // Omgevingslicht / IBL
  const envTex = BABYLON.CubeTexture.CreateFromPrefilteredData(
    'https://assets.babylonjs.com/environments/environmentSpecular.env', scene);
  scene.environmentTexture = envTex;

  // Stad bouwen (lichtgewicht maar geloofwaardig)
  buildCity(scene);

  // Render pipeline (FXAA + Bloom)
  const pipeline = new BABYLON.DefaultRenderingPipeline("pipe", true, scene, [camera]);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomWeight = 0.25;
  pipeline.samples = 4;

  // Avatar-asset
  const AVATAR_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb";
  try{
    const cont = await BABYLON.SceneLoader.LoadAssetContainerAsync(AVATAR_URL, undefined, scene);
    const root = new BABYLON.TransformNode("avatarTemplate", scene);
    cont.meshes.forEach(m=>{ m.setEnabled(false); m.parent = root; m.alwaysSelectAsActiveMesh = true; });
    state.avatarTemplate = root;
    state.avatarReady = true;
    state.pendingSpawns.splice(0).forEach(s=>reallyAddEntity(s.id,s.x,s.z,s.name));
  }catch(e){
    console.warn('Avatar heeft fallback nodig', e);
    state.avatarTemplate = null; state.avatarReady = true;
    state.pendingSpawns.splice(0).forEach(s=>reallyAddEntity(s.id,s.x,s.z,s.name));
  }

  // Picking / contextmenu
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
      ui.mChat.textContent = 'Chat met ' + (ent?.name || 'Onbekend');
      ui.mReport.textContent = 'Rapporteer ' + (ent?.name || 'Onbekend');
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

  // Besturing
  setupControls(scene);

  // Loop
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

// ---------- Stad (grid) ----------
function buildCity(scene){
  // grond
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 400, height: 400 }, scene);
  const gmat = new BABYLON.PBRMaterial('gmat', scene);
  gmat.metallic = 0; gmat.roughness = .95; gmat.albedoColor = new BABYLON.Color3(.93,.95,.97);
  ground.material = gmat; ground.receiveShadows = true;

  // straten (donker), stoepen (licht), kanalen (reflectie)
  const streetMat = new BABYLON.PBRMaterial('street', scene);
  streetMat.metallic = 0.1; streetMat.roughness = 0.6; streetMat.albedoColor = new BABYLON.Color3(.12,.12,.14);

  const sidewalkMat = new BABYLON.PBRMaterial('side', scene);
  sidewalkMat.metallic = 0; sidewalkMat.roughness = 0.85; sidewalkMat.albedoColor = new BABYLON.Color3(.72,.73,.75);

  const waterMat = new BABYLON.PBRMaterial('water', scene);
  waterMat.metallic = 1; waterMat.roughness = 0.15; waterMat.environmentIntensity = 1.6; waterMat.reflectionTexture = scene.environmentTexture;

  // raster
  for (let x=-3; x<=3; x++){
    // straat
    const s = BABYLON.MeshBuilder.CreateBox('st_'+x, { width: 400, height: .05, depth: 12 }, scene);
    s.position.z = x*40; s.position.y = .025; s.material = streetMat; s.receiveShadows = true;

    // "gracht" om de twee rijen
    if (x%2===0){
      const w = BABYLON.MeshBuilder.CreateBox('wa_'+x, { width: 400, height: .06, depth: 8 }, scene);
      w.position.z = x*40+18; w.position.y = .03; w.material = waterMat;

      const w2 = BABYLON.MeshBuilder.CreateBox('wb_'+x, { width: 400, height: .06, depth: 8 }, scene);
      w2.position.z = x*40-18; w2.position.y = .03; w2.material = waterMat;
    }

    // stoepen links/rechts
    const sl = BABYLON.MeshBuilder.CreateBox('sl'+x, { width: 400, height: .12, depth: 4 }, scene);
    sl.position.set(0,.06,x*40+8); sl.material = sidewalkMat; sl.receiveShadows = true;

    const sr = sl.clone('sr'+x); sr.position.z = x*40-8;
  }

  // gebouwblokken
  const buildMat = new BABYLON.PBRMaterial('b', scene);
  buildMat.metallic = 0; buildMat.roughness = .9; buildMat.albedoColor = new BABYLON.Color3(.75,.62,.55);

  for (let gx=-3; gx<=3; gx++){
    for (let gz=-3; gz<=3; gz++){
      const h = 6 + Math.random()*16;
      const b = BABYLON.MeshBuilder.CreateBox(`b_${gx}_${gz}`, { width: 14+Math.random()*10, height: h, depth: 14+Math.random()*10 }, scene);
      b.position.set(gx*40 + (Math.random()*10-5), h/2, gz*40 + (Math.random()*10-5));
      b.material = buildMat; b.receiveShadows = true; b.castShadow = true;
      state.shadow?.addShadowCaster(b);
    }
  }

  // lantaarns
  for (let i=-4; i<=4; i++){
    for (let j=-4; j<=4; j++){
      const p = new BABYLON.TransformNode('lamp_'+i+'_'+j, scene);
      p.position.set(i*20+ (j%2?10:-10), 0, j*20);
      const pole = BABYLON.MeshBuilder.CreateCylinder('pole',{ diameter: .25, height: 4 }, scene);
      pole.position.y = 2; pole.parent = p;
      const head = BABYLON.MeshBuilder.CreateBox('head',{ width:.6, height:.3, depth:.6 }, scene);
      head.position.set(0,4.1,0); head.parent = p;
    }
  }
}

// ---------- Avatar helpers ----------
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
    root.getChildMeshes().forEach(m=>{ m.setEnabled(true); m.receiveShadows = true; m.castShadow = true; });
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
  if (state.entities.has(id)) return;
  if (!state.avatarReady){
    state.pendingSpawns.push({id,x,z,name});
    return;
  }
  reallyAddEntity(id,x,z,name);
}

function reallyAddEntity(id,x,z,name){
  const node = buildAvatar(name||id);
  node.position = new BABYLON.Vector3(x||0,0,z||0);
  tagPickableRecursive(node, id, name||id);
  state.entities.set(id, { node, name: name||id, target: node.position.clone(), speed: 5 });
}

function removeEntity(id){
  const e = state.entities.get(id);
  if (!e) return;
  e.node.dispose();
  state.entities.delete(id);
}

// ---------- Besturing (lopen) ----------
const keys = {};
function setupControls(scene){
  window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
  window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

  ui.sendBtn.onclick = ()=>{
    const t = ui.msg.value.trim(); if(!t) return;
    sendMessage(t); ui.msg.value='';
  };
  ui.msg.addEventListener('keydown', e=>{ if(e.key==='Enter') ui.sendBtn.click(); });

  // Join
  ui.startBtn.addEventListener('click', ()=>{
    state.username = ui.nameInput.value.trim();
    state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    ui.overlay.style.display='none';
    connectWS();
  });

  ['🙂','😀','🙃','😎','🧑','👩','👨','🧔'].forEach(e=>{
    const d=document.createElement('div'); d.className='av'; d.textContent=e;
    d.onclick=()=>{ document.querySelectorAll('.av').forEach(x=>x.classList.remove('sel')); d.classList.add('sel'); state.avatarEmoji=e; updateStart(); };
    ui.avatars.appendChild(d);
  });
  ui.nameInput.oninput = updateStart;
  function updateStart(){ ui.startBtn.disabled = !ui.nameInput.value.trim(); }
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
  pos.x = BABYLON.Scalar.Clamp(pos.x, -195, 195);
  pos.z = BABYLON.Scalar.Clamp(pos.z, -195, 195);
  me.node.position.copyFrom(pos);

  // camera volgt
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
      case 'init':
        data.players.forEach(p => addEntityBuffered(p.id,p.x,p.z,p.username));
        data.npcs.forEach(n => addEntityBuffered(n.id,n.x,n.z,n.name));
        // maak lokale referentie
        const me = state.entities.get(state.playerId) || addEntityBuffered(state.playerId,0,0,state.username);
        state.player = state.entities.get(state.playerId);
        state.camera.target.copyFrom(state.player.node.position);
        break;

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
        if (data.correct) addLine('SYSTEM:', `+50 credits! Correct: ${data.reportedName}`);
        else addLine('SYSTEM:', `-30 credits. Onjuist rapport over ${data.reportedName}`);
        break;
    }
  });

  state.ws.addEventListener('close', ()=>{
    ui.conn.textContent = 'Connecting…';
    setTimeout(connectWS, 2000);
  });
}
