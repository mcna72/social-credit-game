// public/app.js — Babylon client (Render-friendly, higher visual quality)
// Fixes: server-authoritative spawn (no duplicates), avatar-ready buffering,
// robust picking (children), nicer environment, and smooth movement.

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

const state = {
  ws: null,
  playerId: null,
  username: '',
  avatarEmoji: '🙂',
  lang: 'en',
  targetId: null,
  credits: 1000,

  // scene
  scene: null,
  camera: null,
  engine: null,

  // id -> { mesh, name, target: Vector3 }
  entities: new Map(),
  player: null,

  // avatar asset
  avatarReady: false,
  avatarTemplate: null,
  // spawn requests that arrived before the avatar model was ready
  pendingSpawns: [],
};

// ---------- small helpers ----------
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
  const suffix=state.targetId?` (to ${state.entities.get(state.targetId)?.name||''})`:`:`;
  addLine(state.username+suffix,text);
}

// ---------- Babylon setup ----------
const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer:true, stencil:true }, true);
state.engine = engine;

const createScene = async () => {
  const scene = new BABYLON.Scene(engine);
  state.scene = scene;

  // tone mapping (Babylon v6 API)
  scene.clearColor = new BABYLON.Color4(0.03,0.05,0.12,1);
  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.25;

  // Camera: ArcRotate (mouse wheel zoom, drag rotate, middle-drag pan)
  const camera = new BABYLON.ArcRotateCamera('cam',
    BABYLON.Tools.ToRadians(-45),
    BABYLON.Tools.ToRadians(60),
    42, new BABYLON.Vector3(0,2,0), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 20;
  camera.panningSensibility = 500;
  camera.lowerRadiusLimit = 12;
  camera.upperRadiusLimit = 140;
  state.camera = camera;

  // Lights
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0,1,0), scene);
  hemi.intensity = 0.6;
  const dir = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.25,-1,-0.25), scene);
  dir.intensity = 1.2;

  const shadowGen = new BABYLON.ShadowGenerator(4096, dir);
  shadowGen.useExponentialShadowMap = true;

  // Skybox + IBL
  const envTex = BABYLON.CubeTexture.CreateFromPrefilteredData(
    'https://assets.babylonjs.com/environments/environmentSpecular.env', scene);
  scene.environmentTexture = envTex;

  const skybox = BABYLON.MeshBuilder.CreateBox('sky', { size: 1000.0 }, scene);
  const skyMat = new BABYLON.StandardMaterial('skyMat', scene);
  skyMat.backFaceCulling = false;
  skyMat.disableLighting = true;
  skyMat.emissiveColor = new BABYLON.Color3(0.02,0.04,0.12);
  skybox.material = skyMat;
  skybox.infiniteDistance = true;

  // Ground + canal + quays (kept from your design, but cleaner colors)
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 260, height: 260 }, scene);
  const gmat = new BABYLON.PBRMaterial('gmat', scene);
  gmat.metallic = 0; gmat.roughness = 0.95; gmat.albedoColor = new BABYLON.Color3(0.9,0.92,0.96);
  ground.material = gmat; ground.receiveShadows = true;

  const canal = BABYLON.MeshBuilder.CreateBox('canal', { width: 140, height: 0.2, depth: 12 }, scene);
  canal.position.y = 0.01;
  const water = new BABYLON.PBRMaterial('water', scene);
  water.metallic = 1; water.roughness = 0.12; water.environmentIntensity = 1.6; water.reflectionTexture = envTex;
  canal.material = water;

  for (let i=-4;i<=4;i++){
    const quay = BABYLON.MeshBuilder.CreateBox('quay'+i,{width:4,height:0.7,depth:24},scene);
    quay.position.set(i*16,0.36,0);
    const qmat = new BABYLON.PBRMaterial('qmat'+i, scene);
    qmat.metallic = 0; qmat.roughness = 0.85; qmat.albedoColor = new BABYLON.Color3(0.32,0.28,0.26);
    quay.material = qmat; quay.receiveShadows = true; quay.castShadow = true;
    shadowGen.addShadowCaster(quay);
  }

  // Post-process pipeline (bloom + FXAA + a touch of motion blur)
  const pipeline = new BABYLON.DefaultRenderingPipeline("pipe", true, scene, [camera]);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomWeight = 0.35;
  pipeline.bloomKernel = 64;
  pipeline.imageProcessingEnabled = true;
  pipeline.samples = 4;

  // ----------- Load avatar asset -----------
  // Lightweight human(ish) GLB (public CDN). If it fails, we'll fallback to a capsule.
  const AVATAR_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb";

  try {
    const container = await BABYLON.SceneLoader.LoadAssetContainerAsync(AVATAR_URL, undefined, scene);
    const templateRoot = new BABYLON.TransformNode("avatarTemplate", scene);
    container.meshes.forEach(m => { m.setEnabled(false); m.parent = templateRoot; m.alwaysSelectAsActiveMesh = true; });
    state.avatarTemplate = templateRoot;
    state.avatarReady = true;

    // process pending spawns now that the model is ready
    state.pendingSpawns.splice(0).forEach(req => reallyAddEntity(req.id, req.x, req.z, req.name));
  } catch (e) {
    console.warn("Avatar model failed to load. Falling back to capsules.", e);
    state.avatarTemplate = null; // will use fallback in reallyAddEntity
    state.avatarReady = true;
    state.pendingSpawns.splice(0).forEach(req => reallyAddEntity(req.id, req.x, req.z, req.name));
  }

  // ---------- entity creation ----------
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
    const plane = BABYLON.MeshBuilder.CreatePlane('lbl_'+name,{ width:1.8, height:0.45 },scene);
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
    let root;
    if (state.avatarTemplate){
      root = state.avatarTemplate.clone('a_'+name);
      root.getChildMeshes().forEach(m=>{ m.setEnabled(true); });
    } else {
      // fallback: capsule + head cube (always available)
      root = new BABYLON.TransformNode('a_'+name, scene);
      const body = BABYLON.MeshBuilder.CreateCapsule('cap_'+name,{radius:0.45, height:1.7},scene);
      const bmat = new BABYLON.PBRMaterial('bmat_'+name, scene);
      bmat.albedoColor = new BABYLON.Color3(0.0,0.95,0.55); bmat.roughness = 0.5;
      body.material = bmat; body.parent = root;
      body.receiveShadows = true; body.castShadow = true;
    }
    const label = makeLabel(name); label.parent = root;
    return root;
  }

  // store or spawn depending on readiness
  function addEntityBuffered(id, x, z, name){
    if (state.entities.has(id)) return;
    if (!state.avatarReady){
      state.pendingSpawns.push({ id, x, z, name });
      return;
    }
    reallyAddEntity(id, x, z, name);
  }

  function reallyAddEntity(id, x, z, name){
    const mesh = buildAvatar(name || id);
    // place on scene
    mesh.position = new BABYLON.Vector3(x||0, 0, z||0);
    tagPickableRecursive(mesh, id, name || id);
    state.entities.set(id, { mesh, name: name || id, target: mesh.position.clone() });
  }

  function removeEntity(id){
    const ent = state.entities.get(id);
    if(!ent) return;
    ent.mesh.dispose();
    state.entities.delete(id);
  }

  // ---------- picking / context menu ----------
  canvas.addEventListener('contextmenu', (ev)=>{
    ev.preventDefault();
    const pick = scene.pick(ev.clientX, ev.clientY, m => !!m.metadata?.entityId);
    ui.rightMenu.style.left = ev.clientX+'px';
    ui.rightMenu.style.top = ev.clientY+'px';
    ui.rightMenu.style.display='block';

    if (pick && pick.hit && pick.pickedMesh?.metadata?.entityId){
      const id = pick.pickedMesh.metadata.entityId;
      const ent = state.entities.get(id);
      ui.mChat.textContent = 'Chat with ' + (ent?.name || 'Unknown');
      ui.mReport.textContent = 'Report ' + (ent?.name || 'Unknown');
      ui.mChat.onclick = ()=>{ state.targetId = id; ui.targetName.textContent = ent?.name || 'Public'; ui.rightMenu.style.display='none'; };
      ui.mReport.onclick = ()=>{ state.ws?.readyState===WebSocket.OPEN && state.ws.send(JSON.stringify({type:'report', reportedId:id})); ui.rightMenu.style.display='none'; };
    } else {
      ui.mChat.textContent = 'No avatar here';
      ui.mReport.textContent = '—';
      ui.mChat.onclick = ()=> ui.rightMenu.style.display='none';
      ui.mReport.onclick = ()=> ui.rightMenu.style.display='none';
    }
    ui.mClear.onclick = ()=>{ state.targetId = null; ui.targetName.textContent='Public'; ui.rightMenu.style.display='none'; };
    window.addEventListener('click', ()=> ui.rightMenu.style.display='none', { once:true });
  });

  // ---------- Movement ----------
  const keys = {};
  window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
  window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

  function moveLocal(dt){
    if(!state.player) return;
    const speed = 5.0;
    const vx = (keys['arrowright']?1:0) - (keys['arrowleft']?1:0);
    const vz = (keys['arrowdown']?1:0) - (keys['arrowup']?1:0);
    if(!vx && !vz) return;

    const step = new BABYLON.Vector3(vx,0,vz).normalize().scale(speed*dt);
    const pos = state.player.mesh.position.add(step);
    pos.x = BABYLON.Scalar.Clamp(pos.x, -120, 120);
    pos.z = BABYLON.Scalar.Clamp(pos.z, -120, 120);
    state.player.mesh.position.copyFrom(pos);

    // camera gently follows
    state.camera.target = BABYLON.Vector3.Lerp(state.camera.target, new BABYLON.Vector3(pos.x, 2, pos.z), 0.08);

    const now = performance.now();
    if (!moveLocal.last || now - moveLocal.last > 100){
      moveLocal.last = now;
      state.ws?.readyState===WebSocket.OPEN &&
        state.ws.send(JSON.stringify({ type:'move', x: pos.x, z: pos.z }));
    }
  }

  function smoothRemotes(){
    state.entities.forEach((ent,id)=>{
      if(id===state.playerId) return;
      if(!ent.target) return;
      ent.mesh.position = BABYLON.Vector3.Lerp(ent.mesh.position, ent.target, 0.15);
    });
  }

  // ---------- WebSocket ----------
  function connectWS(){
    state.ws = new WebSocket(WS_URL);

    state.ws.addEventListener('open', ()=>{
      ui.conn.textContent='Connected';
      // Do NOT spawn yet; wait for server 'init' to provide the world view
      state.ws.send(JSON.stringify({
        type:'join',
        playerId: state.playerId,
        username: state.username,
        avatar: state.avatarEmoji,
        x: 0, z: 0
      }));
      addLine('SYSTEM:', 'Connected. Loading world…');
    });

    state.ws.addEventListener('message', (e)=>{
      const data = JSON.parse(e.data);
      switch(data.type){
        case 'init': {
          // Spawn (buffered if model not loaded yet)
          data.players.forEach(p => addEntityBuffered(p.id, p.x, p.z, p.username));
          data.npcs.forEach(n => addEntityBuffered(n.id, n.x, n.z, n.name));
          // Ensure the local control is our entity (created above)
          const me = state.entities.get(state.playerId) || addEntityBuffered(state.playerId, 0, 0, state.username);
          state.player = state.entities.get(state.playerId);
          // focus camera on player
          state.camera.target.copyFrom(state.player.mesh.position);
          break;
        }
        case 'player_joined': {
          const p = data.player;
          if (p.id === state.playerId) break; // avoid duplicate spawn
          addEntityBuffered(p.id, p.x, p.z, p.username);
          addLine('SYSTEM:', `${p.username} joined the system`);
          break;
        }
        case 'player_left': {
          removeEntity(data.playerId);
          break;
        }
        case 'player_move': {
          const ent = state.entities.get(data.playerId);
          if (ent) ent.target = new BABYLON.Vector3(data.x,0,data.z);
          break;
        }
        case 'chat': {
          if (data.private){
            const meIsSender = data.playerId === state.playerId;
            const meIsRecipient = data.targetId === state.playerId;
            if (meIsSender || meIsRecipient) addLine(`${data.username} (private):`, data.message);
          } else {
            addLine(data.username+':', data.message);
          }
          break;
        }
        case 'penalty': {
          state.credits += data.amount;
          ui.credit.textContent = state.credits;
          addLine('SYSTEM:', `${data.reason} (${data.amount>0?'+':''}${data.amount})`);
          break;
        }
        case 'report_result': {
          if (data.correct) addLine('SYSTEM:', `+50 credits! Correctly identified ${data.reportedName}`);
          else addLine('SYSTEM:', `-30 credits. False report on ${data.reportedName}`);
          break;
        }
      }
    });

    state.ws.addEventListener('close', ()=>{
      ui.conn.textContent='Connecting…';
      setTimeout(connectWS, 2000);
    });
  }

  // ---------- Chat UI ----------
  ui.sendBtn.onclick = ()=>{
    const t = ui.msg.value.trim();
    if(!t) return;
    sendMessage(t);
    ui.msg.value='';
  };
  ui.msg.addEventListener('keydown', e=>{ if(e.key==='Enter') ui.sendBtn.click(); });

  // ---------- Start ----------
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
  function updateStart(){ ui.startBtn.disabled = !ui.nameInput.value.trim(); }
  ui.nameInput.oninput = updateStart;

  // ---------- Render loop ----------
  let last = performance.now();
  engine.runRenderLoop(()=>{
    const now = performance.now();
    const dt = Math.min(0.05,(now-last)/1000); last = now;
    moveLocal(dt);
    smoothRemotes();
    scene.render();
  });
  window.addEventListener('resize', ()=>engine.resize());

  return scene;
};

createScene();
