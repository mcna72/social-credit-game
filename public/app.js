// public/app.js
// Babylon.js client with: ArcRotateCamera (zoom/rotate/pan), fixed picking,
// server-authoritative spawn (no duplicate), smoother movement & interpolation.

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
  lang: 'en',
  targetId: null, // private chat target
  credits: 1000,
  // scene entities: id -> { mesh, name, target: BABYLON.Vector3 }
  entities: new Map(),
  player: null,
};

// ---------- Helpers ----------
function addLine(user, text, opt = {}) {
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<span class="user">${escapeHtml(user)}</span> ${escapeHtml(text)}`;
  ui.chatlog.appendChild(div);
  ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  while (ui.chatlog.children.length > 200) ui.chatlog.removeChild(ui.chatlog.firstChild);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function sendMessage(text) {
  const payload = { type: 'chat', message: text };
  if (state.targetId) payload.targetId = state.targetId;
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
  const suffix = state.targetId ? ` (to ${state.entities.get(state.targetId)?.name || ''})` : ':';
  addLine(state.username + suffix, text);
}

// ---------- Babylon setup ----------
const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true }, true);

const createScene = async () => {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.03,0.05,0.12,1);
  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.2;

  // Camera: ArcRotate with zoom/pan/rotate
  const camera = new BABYLON.ArcRotateCamera('cam',
    BABYLON.Tools.ToRadians(-45),
    BABYLON.Tools.ToRadians(60),
    35, new BABYLON.Vector3(0, 2, 0), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 20;      // smoother wheel zoom
  camera.panningSensibility = 500; // middle-drag pan
  camera.lowerRadiusLimit = 10;
  camera.upperRadiusLimit = 120;

  // Lights
  const hemi = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0,1,0), scene);
  hemi.intensity = 0.6;
  const dir = new BABYLON.DirectionalLight('d', new BABYLON.Vector3(-0.3,-1,-0.2), scene);
  dir.intensity = 1.2;
  const shadowGen = new BABYLON.ShadowGenerator(4096, dir);
  shadowGen.useExponentialShadowMap = true;

  // Environment (HDRI & ground)
  const envTex = BABYLON.CubeTexture.CreateFromPrefilteredData(
    'https://assets.babylonjs.com/environments/environmentSpecular.env',
    scene
  );
  scene.environmentTexture = envTex;

  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 140, height: 140 }, scene);
  const groundMat = new BABYLON.PBRMaterial('gmat', scene);
  groundMat.metallic = 0.1; groundMat.roughness = 0.9;
  ground.material = groundMat; ground.receiveShadows = true;

  // Canal
  const canal = BABYLON.MeshBuilder.CreateBox('canal', { width: 100, height: 0.2, depth: 10 }, scene);
  canal.position.y = 0.01;
  const water = new BABYLON.PBRMaterial('water', scene);
  water.metallic = 1; water.roughness = 0.15; water.reflectionTexture = envTex; water.environmentIntensity = 1.3;
  canal.material = water;

  // Quays (simple)
  for (let i=-3;i<=3;i++) {
    const b = BABYLON.MeshBuilder.CreateBox('q'+i, { width:3, height:0.7, depth:16 }, scene);
    b.position.set(i*16, 0.36, 0);
    const m = new BABYLON.PBRMaterial('qm'+i, scene); m.metallic = 0; m.roughness = 0.85; m.albedoColor = new BABYLON.Color3(0.23,0.16,0.11);
    b.material = m; b.receiveShadows = true; b.castShadow = true; shadowGen.addShadowCaster(b);
  }

  // Asset: human-ish GLB (CesiumMan — lightweight)
  const AVATAR_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb";
  const avatarContainer = await BABYLON.SceneLoader.LoadAssetContainerAsync(AVATAR_URL, undefined, scene);
  const avatarTemplate = avatarContainer.createRootMesh();
  avatarContainer.addAllToScene();
  avatarTemplate.setEnabled(false);

  function makeLabel(name) {
    const plane = BABYLON.MeshBuilder.CreatePlane('label_'+name, { size: 1.8 }, scene);
    plane.position.y = 2.6; plane.isPickable = false;
    const tex = BABYLON.DynamicTexture.CreateForMesh(plane, { width: 512, height: 128 }, false);
    const ctx = tex.getContext();
    ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(0,0,512,128);
    ctx.fillStyle = "#00ff88"; ctx.font = "bold 48px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(name, 256, 64);
    tex.update();
    const mat = new BABYLON.StandardMaterial('lm_'+name, scene);
    mat.diffuseTexture = tex; mat.emissiveTexture = tex; mat.opacityTexture = tex; mat.backFaceCulling = false;
    plane.material = mat;
    return plane;
  }

  function buildAvatar(name) {
    // clone template
    const root = avatarTemplate.clone('a_'+name);
    root.setEnabled(true);
    root.scaling.scaleInPlace(1.2);
    root.position = new BABYLON.Vector3(0,0,0);
    root.alwaysSelectAsActiveMesh = true;
    shadowGen.addShadowCaster(root);
    const label = makeLabel(name); label.parent = root;
    return root;
  }

  function addEntity(id, x, z, displayName) {
    if (state.entities.has(id)) return state.entities.get(id);
    const mesh = buildAvatar(displayName || id);
    mesh.position.set(x||0, 0, z||0);
    mesh.metadata = { entityId: id, name: displayName || id }; // <-- used by picking
    const ent = { mesh, name: displayName || id, target: mesh.position.clone() };
    state.entities.set(id, ent);
    return ent;
  }

  function removeEntity(id) {
    const ent = state.entities.get(id);
    if (!ent) return;
    ent.mesh.dispose();
    state.entities.delete(id);
  }

  // ---------- Picking / context menu ----------
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const pick = scene.pick(ev.clientX, ev.clientY, m => !!m.metadata?.entityId);
    ui.rightMenu.style.left = ev.clientX+'px';
    ui.rightMenu.style.top = ev.clientY+'px';
    ui.rightMenu.style.display = 'block';

    let clickedId = null;
    if (pick && pick.hit && pick.pickedMesh?.metadata?.entityId) {
      clickedId = pick.pickedMesh.metadata.entityId;
      const ent = state.entities.get(clickedId);
      ui.mChat.textContent = 'Chat with ' + (ent?.name || 'Unknown');
      ui.mReport.textContent = 'Report ' + (ent?.name || 'Unknown');
      ui.mChat.onclick = () => { state.targetId = clickedId; ui.targetName.textContent = ent?.name || 'Public'; ui.rightMenu.style.display='none'; };
      ui.mReport.onclick = () => {
        if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type:'report', reportedId: clickedId }));
        ui.rightMenu.style.display = 'none';
      };
    } else {
      ui.mChat.textContent = 'No avatar here';
      ui.mReport.textContent = '—';
      ui.mChat.onclick = () => { ui.rightMenu.style.display='none'; };
      ui.mReport.onclick = () => { ui.rightMenu.style.display='none'; };
    }
    ui.mClear.onclick = () => { state.targetId = null; ui.targetName.textContent = 'Public'; ui.rightMenu.style.display='none'; };
    window.addEventListener('click', () => { ui.rightMenu.style.display='none'; }, { once:true });
  });

  // ---------- Movement (delta time, WS throttle) ----------
  const keys = {};
  window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
  window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

  function moveLocal(dt) {
    if (!state.player) return;
    const speed = 5.0; // m/s
    const vx = (keys['arrowright']?1:0) - (keys['arrowleft']?1:0);
    const vz = (keys['arrowdown']?1:0) - (keys['arrowup']?1:0);
    if (!vx && !vz) return;

    const step = new BABYLON.Vector3(vx,0,vz).normalize().scale(speed*dt);
    const pos = state.player.mesh.position.add(step);
    pos.x = BABYLON.Scalar.Clamp(pos.x, -60, 60);
    pos.z = BABYLON.Scalar.Clamp(pos.z, -60, 60);
    state.player.mesh.position.copyFrom(pos);

    // camera target follows player
    camera.target = BABYLON.Vector3.Lerp(camera.target, new BABYLON.Vector3(pos.x, 2, pos.z), 0.08);

    // send to server throttled
    const now = performance.now();
    if (!moveLocal.lastSend || now - moveLocal.lastSend > 100) {
      moveLocal.lastSend = now;
      state.ws?.readyState === WebSocket.OPEN &&
        state.ws.send(JSON.stringify({ type: 'move', x: pos.x, z: pos.z }));
    }
  }

  function smoothRemotes() {
    state.entities.forEach((ent, id) => {
      if (id === state.playerId) return;
      if (!ent.target) return;
      ent.mesh.position = BABYLON.Vector3.Lerp(ent.mesh.position, ent.target, 0.15);
    });
  }

  // ---------- WS + spawn (server authoritative) ----------
  function connectWS() {
    state.ws = new WebSocket(WS_URL);

    state.ws.addEventListener('open', () => {
      ui.conn.textContent = 'Connected';
      // DO NOT spawn local yet. Send join, wait for server messages, then create.
      state.ws.send(JSON.stringify({
        type: 'join',
        playerId: state.playerId,
        username: state.username,
        avatar: state.avatarEmoji,
        x: 0, z: 0
      }));
    });

    state.ws.addEventListener('message', (e) => {
      const data = JSON.parse(e.data);
      switch (data.type) {
        case 'init': {
          // Existing players
          data.players.forEach(p => {
            addEntity(p.id, p.x, p.z, p.username);
          });
          // NPCs
          data.npcs.forEach(n => {
            addEntity(n.id, n.x, n.z, n.name);
          });
          // Now create *local* control reference (one entity with our id already exists)
          const selfEnt = state.entities.get(state.playerId) || addEntity(state.playerId, 0, 0, state.username);
          state.player = selfEnt;
          // Focus camera to player
          camera.target.copyFrom(selfEnt.mesh.position);
          break;
        }
        case 'player_joined': {
          const p = data.player;
          if (p.id === state.playerId) break; // <- avoid duplicate local spawn
          addEntity(p.id, p.x, p.z, p.username);
          addLine('SYSTEM:', `${p.username} joined the system`);
          break;
        }
        case 'player_left': {
          removeEntity(data.playerId);
          break;
        }
        case 'player_move': {
          const ent = state.entities.get(data.playerId);
          if (ent) ent.target = new BABYLON.Vector3(data.x, 0, data.z);
          break;
        }
        case 'chat': {
          if (data.private) {
            const meIsSender = data.playerId === state.playerId;
            const meIsRecipient = data.targetId === state.playerId;
            if (meIsSender || meIsRecipient) addLine(`${data.username} (private):`, data.message);
          } else {
            addLine(data.username + ':', data.message);
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

    state.ws.addEventListener('close', () => {
      ui.conn.textContent = 'Connecting…';
      setTimeout(connectWS, 2000);
    });
  }

  // ---------- Start / Chat ----------
  ui.sendBtn.onclick = () => {
    const t = ui.msg.value.trim();
    if (!t) return;
    sendMessage(t);
    ui.msg.value = '';
  };
  ui.msg.addEventListener('keydown', e => { if (e.key === 'Enter') ui.sendBtn.click(); });

  ui.startBtn.addEventListener('click', () => {
    state.username = ui.nameInput.value.trim();
    state.playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    ui.overlay.style.display = 'none';
    connectWS();
  });

  // avatar emojis (for fun; model is the same)
  ['🙂','😀','🙃','😎','🧑','👩','👨','🧔'].forEach(e => {
    const d = document.createElement('div');
    d.className='av'; d.textContent=e;
    d.onclick = () => {
      document.querySelectorAll('.av').forEach(x=>x.classList.remove('sel'));
      d.classList.add('sel');
      state.avatarEmoji = e; updateStart();
    };
    ui.avatars.appendChild(d);
  });
  function updateStart(){ ui.startBtn.disabled = !ui.nameInput.value.trim(); }
  ui.nameInput.oninput = updateStart;

  // ---------- Render loop ----------
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now-last)/1000);
    last = now;
    moveLocal(dt);
    smoothRemotes();
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());

  return scene;
};

createScene();

// -------------- language small (UI only) --------------
ui.langSel.onchange = () => {
  const v = ui.langSel.value;
  state.lang = v;
  const map = {
    en: { title:'Social Credit — Amsterdam Edition', sub:'Join the network — Choose your identity', enter:'Enter System', public:'Public', connecting:'Connecting…' },
    nl: { title:'Sociale Krediet — Amsterdam Editie', sub:'Sluit je aan — Kies je identiteit', enter:'Systeem Betreden', public:'Openbaar', connecting:'Verbinding maken…' },
    de: { title:'Sozialkredit — Amsterdam Edition', sub:'Netzwerk beitreten — Identität wählen', enter:'System Betreten', public:'Öffentlich', connecting:'Verbindung wird hergestellt…' }
  }[v] || map.en;
  document.getElementById('title').textContent = map.title;
  document.getElementById('subtitle').textContent = map.sub;
  ui.startBtn.textContent = map.enter;
  ui.targetName.textContent = map.public;
  ui.conn.textContent = map.connecting;
};
