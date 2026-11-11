/* =====================================================================
   Aether3D Studio — static in-browser 3D model viewer & editor
   Pure client-side three.js (r170). No backend, no build step.
   Works from file://, any static host, or GitHub Pages.
   ===================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/* ------------------------------------------------------------------ */
/* Constants & tiny helpers                                            */
/* ------------------------------------------------------------------ */

const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/';
const GH_MODELS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/';
const SUPPORTED_EXT = ['obj', 'fbx', 'glb', 'gltf', 'stl', 'ply', 'dae', '3mf'];
const LOAD_PRIORITY = ['glb', 'gltf', 'fbx', 'obj', 'dae', '3mf', 'stl', 'ply'];

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(Math.round(n)));
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB');
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const baseNameOf = (name) => name.replace(/\.[^.]+$/, '');

const state = {
  modelRoot: null,     // Group that holds the loaded model
  meshes: [],          // [{mesh, baseMaterial, baseline, pct, editable, isPoints}]
  scope: null,         // null = whole model, else a mesh
  viewMode: 'pbr',
  tool: 'move',
  camType: 'persp',
  exportFormat: 'obj',
  lightPreset: -1,
  originalFile: null,
  baseName: 'model',
  format: '—',
  autoNormals: true,
  activePreset: null,
  history: [],
  hIndex: -1,
};

const sessionBlobURLs = [];

/* ------------------------------------------------------------------ */
/* Toasts / loading overlay                                            */
/* ------------------------------------------------------------------ */

function toast(msg, type = 'info', ms = 4200) {
  const wrap = $('toast-container');
  if (!wrap) return;
  const icons = { info: 'info', success: 'check_circle', error: 'error', warn: 'warning' };
  const colors = { info: 'text-secondary', success: 'text-emerald-400', error: 'text-red-400', warn: 'text-amber-400' };
  const t = document.createElement('div');
  t.className = 'toast pointer-events-auto flex items-start gap-2 px-3 py-2 rounded-xl bg-surface-container-high/95 ring-1 ring-white/10 shadow-2xl max-w-md font-body-sm text-body-sm text-on-surface';
  t.innerHTML = `<span class="material-symbols-outlined text-base ${colors[type] || 'text-secondary'}">${icons[type] || 'info'}</span><span class="flex-1 leading-snug">${msg}</span>`;
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
  while (wrap.children.length > 4) wrap.firstChild.remove();
}

function setLoading(on, label = '') {
  const ov = $('loading-overlay');
  if (!ov) return;
  ov.classList.toggle('hidden', !on);
  if (label) $('loading-label').textContent = label;
  if (on) { $('loading-bar').style.width = '12%'; $('loading-pct').textContent = 'working…'; }
}
function setLoadingProgress(loaded, total) {
  const pct = total > 0 ? clamp(Math.round((loaded / total) * 100), 2, 100) : null;
  if (pct != null) {
    $('loading-bar').style.width = pct + '%';
    $('loading-pct').textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)} (${pct}%)`;
  } else {
    $('loading-bar').style.width = '60%';
    $('loading-pct').textContent = fmtBytes(loaded);
  }
}

/* ------------------------------------------------------------------ */
/* Renderer / scene / cameras / controls                               */
/* ------------------------------------------------------------------ */

const container = $('viewport-canvas-container');
const canvas = $('c3d');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d0e13');
scene.fog = new THREE.Fog(0x0d0e13, 9, 28);

// Neutral studio environment for PBR reflections
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// Adaptive ground grid
let grid = makeGrid(10);
scene.add(grid);
function makeGrid(span) {
  const g = new THREE.GridHelper(span, 40, 0x4cd7f6, 0x35354e);
  g.material.transparent = true;
  g.material.opacity = 0.5;
  g.material.depthWrite = false;
  return g;
}

// Lights rig (tuned per preset)
const ambLight = new THREE.AmbientLight(0xffffff, 0.3);
const keyLight = new THREE.DirectionalLight(0xffffff, 2.0); keyLight.position.set(4, 6, 4);
const fillLight = new THREE.DirectionalLight(0xdfe8ff, 0.6); fillLight.position.set(-5, 2, 3);
const rimLight = new THREE.DirectionalLight(0xffffff, 1.1); rimLight.position.set(-2, 5, -6);
scene.add(ambLight, keyLight, fillLight, rimLight);

const LIGHT_PRESETS = [
  { name: 'Studio Softbox', key: [0xffffff, 2.0], fill: [0xdfe8ff, 0.6], rim: [0xffffff, 1.1], amb: 0.3, env: 1.0 },
  { name: 'Neon Cyberpunk', key: [0x4cd7f6, 2.2], fill: [0xa078ff, 1.1], rim: [0xd0bcff, 1.6], amb: 0.18, env: 0.45 },
  { name: 'Sunset Golden Hour', key: [0xffb46b, 2.1], fill: [0xff8fb0, 0.5], rim: [0xffd9a0, 1.3], amb: 0.25, env: 0.6 },
  { name: 'High-Contrast Rim Noir', key: [0xffffff, 0.25], fill: [0x8a90a8, 0.12], rim: [0xffffff, 3.0], amb: 0.06, env: 0.12 },
];

function setLightPreset(i) {
  const p = LIGHT_PRESETS[i];
  if (!p) return;
  state.lightPreset = i;
  keyLight.color.setHex(p.key[0]); keyLight.intensity = p.key[1];
  fillLight.color.setHex(p.fill[0]); fillLight.intensity = p.fill[1];
  rimLight.color.setHex(p.rim[0]); rimLight.intensity = p.rim[1];
  ambLight.intensity = p.amb;
  scene.environmentIntensity = p.env;
  document.querySelectorAll('.light-preset-btn').forEach((b) => {
    const on = Number(b.dataset.preset) === i;
    b.classList.toggle('text-secondary', on);
    b.classList.toggle('bg-surface-container-high', on);
    b.classList.toggle('text-on-surface', !on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
}

// Cameras
const persp = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
persp.position.set(4.5, 3.0, 6.5);
const ortho = new THREE.OrthographicCamera(-5, 5, 3.5, -3.5, 0.001, 1000);
ortho.position.copy(persp.position);
let activeCam = persp;

const controls = new OrbitControls(persp, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.5, 0);
controls.minDistance = 0.05;
controls.maxDistance = 100;

function syncOrthoFromPersp() {
  const dist = Math.max(persp.position.distanceTo(controls.target), 1e-4);
  const halfH = Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) * dist;
  const aspect = (container.clientWidth / Math.max(container.clientHeight, 1)) || 1;
  ortho.top = halfH; ortho.bottom = -halfH;
  ortho.left = -halfH * aspect; ortho.right = halfH * aspect;
  ortho.near = persp.near; ortho.far = persp.far;
  ortho.position.copy(persp.position);
  ortho.up.copy(persp.up);
  ortho.lookAt(controls.target);
  ortho.zoom = 1;
  ortho.updateProjectionMatrix();
}
function syncPerspFromOrtho() {
  const dir = new THREE.Vector3().subVectors(ortho.position, controls.target);
  const len = dir.length();
  dir.normalize();
  if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0.6, 0.45, 0.9).normalize();
  const halfH = (ortho.top - ortho.bottom) / 2 / Math.max(ortho.zoom, 1e-6);
  const dist = Math.max(halfH / Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2), 1e-3);
  persp.position.copy(controls.target).addScaledVector(dir, dist);
  persp.up.copy(ortho.up);
  persp.lookAt(controls.target);
  persp.updateProjectionMatrix();
}
function setCamType(type) {
  if (state.camType === type) { updateCamButtons(); return; }
  if (type === 'ortho') {
    syncOrthoFromPersp();
    activeCam = ortho;
    controls.object = ortho;
  } else {
    syncPerspFromOrtho();
    activeCam = persp;
    controls.object = persp;
  }
  tc.camera = activeCam;
  state.camType = type;
  controls.update();
  updateCamButtons();
}
function updateCamButtons() {
  const p = $('cam-perspective'), o = $('cam-ortho');
  const setActive = (btn, on) => {
    btn.classList.toggle('bg-surface-container-high', on);
    btn.classList.toggle('text-secondary', on);
    btn.classList.toggle('font-semibold', on);
    btn.classList.toggle('text-on-surface-variant', !on);
  };
  setActive(p, state.camType === 'persp');
  setActive(o, state.camType === 'ortho');
}

// Transform gizmo
const tc = new TransformControls(activeCam, canvas);
tc.setSize(0.9);
const tcHelper = typeof tc.getHelper === 'function' ? tc.getHelper() : tc;
scene.add(tcHelper);
tc.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (!e.value) { syncTransformInputs(); pushHistory(); }
});
tc.addEventListener('objectChange', () => syncTransformInputs());

// Selection bounding box helper
const selBox = new THREE.Box3();
const selHelper = new THREE.Box3Helper(selBox, new THREE.Color('#4cd7f6'));
selHelper.visible = false;
selHelper.material.transparent = true;
selHelper.material.opacity = 0.7;
scene.add(selHelper);

/* ------------------------------------------------------------------ */
/* Mini axis gizmo (top-right, synced to camera)                       */
/* ------------------------------------------------------------------ */

const gizmoCanvas = $('gizmo-canvas');
const gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, antialias: true, alpha: true });
gizmoRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
gizmoRenderer.setSize(88, 88, false);
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
(function buildGizmo() {
  const axes = [
    { dir: new THREE.Vector3(1, 0, 0), color: '#ff5555', label: 'X' },
    { dir: new THREE.Vector3(0, 1, 0), color: '#50fa7b', label: 'Y' },
    { dir: new THREE.Vector3(0, 0, 1), color: '#06b6d4', label: 'Z' },
  ];
  for (const ax of axes) {
    const geo = new THREE.BufferGeometry().setFromPoints([ax.dir.clone().multiplyScalar(0.28), ax.dir.clone().multiplyScalar(1.05)]);
    gizmoScene.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: ax.color, toneMapped: false })));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 12), new THREE.MeshBasicMaterial({ color: ax.color, toneMapped: false }));
    tip.position.copy(ax.dir).multiplyScalar(1.05);
    gizmoScene.add(tip);
    const neg = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshBasicMaterial({ color: '#4a4c58', toneMapped: false }));
    neg.position.copy(ax.dir).multiplyScalar(-1.05);
    gizmoScene.add(neg);
    // label sprite
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 42px "JetBrains Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = ax.color;
    ctx.fillText(ax.label, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, toneMapped: false }));
    spr.position.copy(ax.dir).multiplyScalar(1.5);
    spr.scale.setScalar(0.7);
    gizmoScene.add(spr);
  }
  const center = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), new THREE.MeshBasicMaterial({ color: '#e3e1e9', toneMapped: false }));
  gizmoScene.add(center);
})();
function renderGizmo() {
  const dir = new THREE.Vector3().subVectors(activeCam.position, controls.target);
  if (dir.lengthSq() < 1e-10) dir.set(1, 0.5, 1);
  gizmoCam.position.copy(dir.normalize().multiplyScalar(6));
  gizmoCam.up.copy(activeCam.up);
  gizmoCam.lookAt(0, 0, 0);
  gizmoRenderer.render(gizmoScene, gizmoCam);
}

/* ------------------------------------------------------------------ */
/* View modes (PBR / wireframe / matcap / x-ray)                       */
/* ------------------------------------------------------------------ */

function makeMatcap() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(96, 92, 12, 128, 128, 130);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.22, '#d4dbea');
  grad.addColorStop(0.55, '#5c6478');
  grad.addColorStop(1, '#101219');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const wireMat = new THREE.MeshBasicMaterial({ color: 0x4cd7f6, wireframe: true, toneMapped: false });
const matcapMat = new THREE.MeshMatcapMaterial({ matcap: makeMatcap() });
const xrayMat = new THREE.MeshBasicMaterial({
  color: 0x9fdcff, transparent: true, opacity: 0.14,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
});

function setViewMode(mode) {
  state.viewMode = mode;
  for (const rec of state.meshes) {
    if (rec.isPoints) continue;
    if (mode === 'pbr') rec.mesh.material = rec.baseMaterial;
    else if (mode === 'wireframe') rec.mesh.material = wireMat;
    else if (mode === 'matcap') rec.mesh.material = matcapMat;
    else if (mode === 'xray') rec.mesh.material = xrayMat;
  }
  document.querySelectorAll('.viewmode-btn').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('bg-primary-container', on);
    b.classList.toggle('text-on-primary-container', on);
    b.classList.toggle('shadow-md', on);
    b.classList.toggle('font-medium', on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
  updateHeaderMeta();
}

/* ------------------------------------------------------------------ */
/* Model loading pipeline                                              */
/* ------------------------------------------------------------------ */

function makeManager(map) {
  const m = new THREE.LoadingManager();
  m.setURLModifier((url) => {
    try {
      if (/^(data:|blob:)/i.test(url)) return url;
      let clean = url.split('?')[0].split('#')[0];
      clean = decodeURIComponent(clean.split(/[\\/]/).pop()).toLowerCase();
      const hit = map.get(clean);
      return hit ? hit.url : url;
    } catch (e) { return url; }
  });
  return m;
}

// Rewrite texture references in an MTL file to blob: URLs of dropped files
function rewriteMTLTextures(text, map) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*(?:map_Ka|map_Kd|map_Ks|map_Ns|map_d|map_Ke|map_bump|bump|disp|decal|refl|norm)\s+)(.*)$/i);
    if (!m) return line;
    const out = m[2].trim().split(/\s+/).map((tok) => {
      if (tok.startsWith('-')) return tok;
      try {
        const base = decodeURIComponent(tok.split(/[\\/]/).pop()).toLowerCase();
        const hit = map.get(base);
        return hit ? hit.url : tok;
      } catch (e) { return tok; }
    });
    return m[1] + out.join(' ');
  }).join('\n');
}

function defaultMaterial() {
  return new THREE.MeshPhysicalMaterial({ color: 0xb9c0d4, metalness: 0.15, roughness: 0.55, envMapIntensity: 1.0 });
}

async function parseModel(file, map) {
  const ext = extOf(file.name);
  if (ext === 'obj') {
    const text = await file.text();
    const objLoader = new OBJLoader();
    const mtlEntry = [...map.values()].find((v) => extOf(v.file.name) === 'mtl');
    if (mtlEntry) {
      try {
        const mtlText = rewriteMTLTextures(await mtlEntry.file.text(), map);
        const creator = new MTLLoader().parse(mtlText, '');
        creator.preload();
        objLoader.setMaterials(creator);
      } catch (e) { console.warn('[Aether3D] MTL parsing failed — loading OBJ without materials:', e); }
    }
    return objLoader.parse(text);
  }
  if (ext === 'fbx') {
    const buf = await file.arrayBuffer();
    return new FBXLoader(makeManager(map)).parse(buf, '');
  }
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader(makeManager(map));
    const draco = new DRACOLoader();
    draco.setDecoderPath(THREE_CDN + 'libs/draco/gltf/');
    loader.setDRACOLoader(draco);
    loader.setMeshoptDecoder(MeshoptDecoder);
    const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
    return await new Promise((resolve, reject) =>
      loader.parse(data, '', (gltf) => resolve(gltf.scene), reject));
  }
  if (ext === 'stl') {
    const geo = new STLLoader().parse(await file.arrayBuffer());
    const mesh = new THREE.Mesh(geo, defaultMaterial());
    mesh.name = baseNameOf(file.name);
    return mesh;
  }
  if (ext === 'ply') {
    const geo = new PLYLoader().parse(await file.arrayBuffer());
    if (geo.index || geo.getAttribute('normal')) {
      const mesh = new THREE.Mesh(geo, defaultMaterial());
      mesh.name = baseNameOf(file.name);
      return mesh;
    }
    // point cloud
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fdcff, size: 0.01, sizeAttenuation: true }));
    pts.name = baseNameOf(file.name);
    return pts;
  }
  if (ext === 'dae') {
    const collada = new ColladaLoader(makeManager(map)).parse(await file.text(), '');
    return collada.scene;
  }
  if (ext === '3mf') {
    return new ThreeMFLoader(makeManager(map)).parse(await file.arrayBuffer());
  }
  throw new Error('Unsupported format: .' + ext);
}

async function handleFiles(fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;

  const map = new Map();
  const freshURLs = [];
  for (const f of files) {
    const base = f.name.split(/[\\/]/).pop();
    const url = URL.createObjectURL(f);
    map.set(base.toLowerCase(), { file: f, url });
    freshURLs.push(url);
  }

  let primary = null;
  for (const p of LOAD_PRIORITY) {
    primary = files.find((f) => extOf(f.name) === p);
    if (primary) break;
  }

  if (!primary) {
    const blend = files.find((f) => extOf(f.name) === 'blend');
    state.originalFile = blend || files[0];
    updateDownloadOriginal();
    if (blend) {
      toast(`<b>.blend</b> is Blender's private binary format and can't be parsed in the browser. Two easy fixes: <b>1)</b> In Blender: <b>File → Export → glTF 2.0 (.glb)</b> or <b>Wavefront (.obj)</b>, then drop that file here. <b>2)</b> Batch-convert with the bundled <b>blend2glb.py</b> script (needs Blender installed). (Your original .blend is kept and can be re-downloaded below.)`, 'error', 12000);
    } else {
      toast(`Unsupported file type${files.length > 1 ? 's' : ''}: <b>${escapeHTML(files.map((f) => f.name).join(', '))}</b>.<br/>Supported: OBJ, FBX, GLB/GLTF, STL, PLY, DAE, 3MF.`, 'error', 7000);
    }
    return;
  }

  state.originalFile = primary;
  state.baseName = baseNameOf(primary.name);
  updateDownloadOriginal();
  // A .blend dropped next to a loadable model is silently useless — say so instead of ignoring it
  const strayBlend = files.find((f) => extOf(f.name) === 'blend');
  if (strayBlend) {
    toast(`<b>${escapeHTML(strayBlend.name)}</b> (.blend) can’t be opened in-browser — loaded <b>${escapeHTML(primary.name)}</b> instead. To open the .blend, export it as GLB/OBJ from Blender (or use the bundled <b>blend2glb.py</b> script) first.`, 'warn', 9000);
  }
  setLoading(true, `Loading ${primary.name}…`);
  setStatus('Loading…', true);

  try {
    const obj = await parseModel(primary, map);
    setModel(obj, extOf(primary.name).toUpperCase()); // clearModel inside revokes previous session's blob URLs
    sessionBlobURLs.push(...freshURLs);               // the new model now owns these
    const s = modelStats();
    toast(`Loaded <b>${escapeHTML(primary.name)}</b> — ${fmtInt(s.tris)} triangles, ${state.meshes.length} mesh${state.meshes.length !== 1 ? 'es' : ''}. Processed 100% locally; nothing was uploaded.`, 'success', 5000);
  } catch (err) {
    console.error('[Aether3D] Load failed:', err);
    for (const u of freshURLs) { try { URL.revokeObjectURL(u); } catch (e) {} }
    toast(`Failed to load <b>${escapeHTML(primary.name)}</b>: ${escapeHTML((err && err.message) || String(err))}`, 'error', 9000);
    setStatus('Error', false);
  } finally {
    setLoading(false);
  }
}

function setModel(object, format) {
  clearModel(false);

  // Imported lights/cameras would fight our rig — strip them
  const strip = [];
  object.traverse((o) => { if (o.isLight || o.isCamera) strip.push(o); });
  strip.forEach((o) => o.parent && o.parent.remove(o));

  const root = new THREE.Group();
  root.name = state.baseName || 'model';
  root.add(object);
  scene.add(root);
  state.modelRoot = root;
  state.format = format;
  state.scope = null;
  state.activePreset = null;

  let idx = 0;
  object.traverse((o) => {
    if ((o.isMesh || o.isPoints) && o.geometry && o.geometry.getAttribute('position')) {
      const isPoints = !!o.isPoints;
      if (!isPoints && !o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
      if (!o.name) o.name = (isPoints ? 'points_' : 'mesh_') + (++idx);
      const editable = !isPoints && !o.isSkinnedMesh &&
        !o.geometry.getAttribute('skinIndex') &&
        !(o.morphTargetInfluences && o.morphTargetInfluences.length);
      state.meshes.push({ mesh: o, baseMaterial: o.material, baseline: o.geometry, pct: 100, editable, isPoints });
    }
  });

  if (!state.meshes.length) {
    clearModel();
    throw new Error('No renderable geometry found in this file.');
  }

  fitWorldToModel();
  // Scale point-cloud dot size relative to the model so PLY scans stay visible
  for (const rec of state.meshes) {
    if (rec.isPoints && rec.mesh.material && rec.mesh.material.isPointsMaterial && state.modelRadius) {
      rec.mesh.material.size = state.modelRadius * 0.01;
      rec.mesh.material.sizeAttenuation = true;
    }
  }
  setViewMode(state.viewMode);
  setTool(state.tool, true);
  setScope(null);
  refreshStats();
  historyReset();
  updateEmptyState();
  setStatus('Ready', true);
}

function clearModel(updateUI = true) {
  tc.detach();
  selHelper.visible = false;
  if (state.modelRoot) {
    state.modelRoot.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) disposeMaterials(o.material);
    });
    scene.remove(state.modelRoot);
  }
  for (const u of sessionBlobURLs) { try { URL.revokeObjectURL(u); } catch (e) {} }
  sessionBlobURLs.length = 0;
  state.modelRoot = null;
  state.meshes = [];
  state.scope = null;
  state.history = [];
  state.hIndex = -1;
  state.activePreset = null;
  if (updateUI) {
    state.format = '—';
    refreshStats();
    buildOutliner();
    updateEmptyState();
    historyButtons();
    setStatus('Idle', false);
    syncMaterialSliders();
    syncPolySliderUI();
    syncTransformInputs();
  }
}

function disposeMaterials(m) {
  (Array.isArray(m) ? m : [m]).forEach((mm) => {
    if (!mm) return;
    for (const k in mm) {
      const v = mm[k];
      if (v && v.isTexture) v.dispose();
    }
    if (mm.dispose) mm.dispose();
  });
}

/* ------------------------------------------------------------------ */
/* Stats & UI sync                                                     */
/* ------------------------------------------------------------------ */

function trisOfGeometry(g) {
  if (!g) return 0;
  if (g.index) return g.index.count / 3;
  return (g.getAttribute('position') ? g.getAttribute('position').count : 0) / 3;
}
function meshTris(rec) { return rec.isPoints ? 0 : trisOfGeometry(rec.mesh.geometry); }
function meshVerts(rec) { return rec.mesh.geometry.getAttribute('position') ? rec.mesh.geometry.getAttribute('position').count : 0; }
function modelStats() {
  let tris = 0, verts = 0;
  for (const r of state.meshes) { tris += meshTris(r); verts += meshVerts(r); }
  return { tris, verts, meshes: state.meshes.length };
}

function setStatus(text, ok) {
  const chip = $('header-file-status');
  chip.textContent = text;
  chip.classList.toggle('text-secondary', ok);
  chip.classList.toggle('text-red-400', text === 'Error');
}

function updateHeaderMeta() {
  const nameEl = $('header-file-name');
  const metaEl = $('header-file-meta');
  if (!state.modelRoot) {
    nameEl.textContent = 'no_model_loaded';
    metaEl.textContent = 'Drop a 3D file — nothing is uploaded';
    return;
  }
  nameEl.textContent = (state.baseName || 'model') + '.' + state.format.toLowerCase();
  const s = modelStats();
  const sizeStr = state.originalFile ? fmtBytes(state.originalFile.size) + ' • ' : '';
  metaEl.textContent = `${sizeStr}${fmtK(s.tris)} Tris • ${state.meshes.length} Meshes • ${state.viewMode.toUpperCase()}`;
}

function refreshStats() {
  const s = modelStats();
  $('stat-tris-card').textContent = fmtInt(s.tris);
  $('stat-verts-card').textContent = fmtInt(s.verts);
  $('stat-meshes-card').textContent = String(s.meshes);
  $('insp-model-name').textContent = state.modelRoot ? (state.baseName || 'model') : 'no model loaded';
  $('insp-model-name').title = state.originalFile ? state.originalFile.name : '';
  $('insp-model-format').textContent = state.format;
  $('geom-label').textContent = fmtK(s.tris) + ' tris';
  $('geom-bar').style.width = Math.min(100, (s.tris / 400000) * 100) + '%';
  updateHeaderMeta();
  // poly slider hints
  const scopeTris = scopeStats().tris;
  $('poly-hint-low').textContent = fmtK(scopeTris * 0.1);
  $('poly-hint-mid').textContent = fmtK(scopeTris * 0.5);
}

function updateEmptyState() {
  $('empty-state').classList.toggle('hidden', !!state.modelRoot);
}

function updateDownloadOriginal() {
  const f = state.originalFile;
  $('btn-download-original-label').textContent = f
    ? `Download Original File (${f.name.length > 26 ? f.name.slice(0, 23) + '…' : f.name} • ${fmtBytes(f.size)})`
    : 'Download Original File (drop a file first)';
}

/* ------------------------------------------------------------------ */
/* Outliner & scope selection                                          */
/* ------------------------------------------------------------------ */

function buildOutliner() {
  const list = $('outliner-list');
  if (!list) return;
  list.innerHTML = '';
  const addRow = (label, icon, count, active, onclick, title) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `flex items-center gap-space-sm px-space-sm py-2 rounded transition-all text-left font-body-sm text-body-sm w-full ${active ? 'bg-primary-container text-on-primary-container font-medium' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`;
    row.innerHTML = `<span class="material-symbols-outlined text-lg shrink-0">${icon}</span><span class="flex-1 truncate">${escapeHTML(label)}</span>` +
      (count != null ? `<span class="font-label-sm text-label-sm ${active ? 'text-on-primary-container/70' : 'text-outline'} shrink-0">${count}</span>` : '');
    if (title) row.title = title;
    if (onclick) row.addEventListener('click', onclick);
    list.appendChild(row);
  };
  if (!state.modelRoot) {
    addRow('Empty scene — drop a model', 'hourglass_empty', null, false, null);
    return;
  }
  addRow('Whole Model', 'view_in_ar', fmtK(modelStats().tris), state.scope === null, () => setScope(null), 'Edit the whole model');
  state.meshes.slice(0, 120).forEach((rec) => {
    addRow(
      rec.mesh.name || 'mesh',
      rec.isPoints ? 'grain' : 'deployed_code',
      rec.isPoints ? fmtK(meshVerts(rec)) : fmtK(meshTris(rec)),
      state.scope === rec.mesh,
      () => setScope(rec.mesh),
      rec.editable ? 'Click to focus this part' : 'Display-only (skinned / points)'
    );
  });
  if (state.meshes.length > 120) addRow(`… ${state.meshes.length - 120} more parts`, 'more_horiz', null, false, null);
}

function setScope(mesh) {
  state.scope = mesh;
  $('insp-scope-label').textContent = mesh ? (mesh.name || 'part') : 'Whole Model';
  buildOutliner();
  updateSelBox();
  syncMaterialSliders();
  syncPolySliderUI();
  refreshStats();
}

function updateSelBox() {
  if (state.scope) {
    selBox.setFromObject(state.scope);
    selHelper.visible = !selBox.isEmpty();
  } else {
    selHelper.visible = false;
  }
}

// Click-to-select (Select tool)
const raycaster = new THREE.Raycaster();
let downPos = null;
canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5 || state.tool !== 'select' || !state.modelRoot) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, activeCam);
  const targets = state.meshes.filter((r) => !r.isPoints).map((r) => r.mesh);
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length) {
    setScope(hits[0].object);
    toast(`Selected <b>${escapeHTML(hits[0].object.name || 'part')}</b> — material & geometry edits now target this part.`, 'info', 2600);
  } else {
    setScope(null);
  }
});

/* ------------------------------------------------------------------ */
/* Tools & transform gizmo                                             */
/* ------------------------------------------------------------------ */

const TOOL_MODE = { select: null, move: 'translate', rotate: 'rotate', scale: 'scale' };
function setTool(tool, force) {
  if (!force && tool === state.tool) return;
  state.tool = tool;
  if (state.modelRoot && TOOL_MODE[tool]) {
    tc.attach(state.modelRoot);
    tc.setMode(TOOL_MODE[tool]);
  } else {
    tc.detach();
  }
  document.querySelectorAll('.transform-tool-btn').forEach((b) => {
    const on = b.dataset.tool === tool;
    b.classList.toggle('bg-primary-container', on);
    b.classList.toggle('text-on-primary-container', on);
    b.classList.toggle('shadow-md', on);
    b.classList.toggle('font-medium', on);
    b.classList.toggle('text-on-surface', !on);
  });
}

function syncTransformInputs() {
  if (!state.modelRoot) return;
  const r = state.modelRoot;
  $('pos-x').value = r.position.x.toFixed(2);
  $('pos-y').value = r.position.y.toFixed(2);
  $('pos-z').value = r.position.z.toFixed(2);
  $('rot-x').value = THREE.MathUtils.radToDeg(r.rotation.x).toFixed(1) + '°';
  $('rot-y').value = THREE.MathUtils.radToDeg(r.rotation.y).toFixed(1) + '°';
  $('rot-z').value = THREE.MathUtils.radToDeg(r.rotation.z).toFixed(1) + '°';
  const s = (Math.abs(r.scale.x) + Math.abs(r.scale.y) + Math.abs(r.scale.z)) / 3;
  $('scale-slider').value = Math.round(clamp(s, 0.1, 3) * 100);
  $('scale-display').textContent = s.toFixed(2) + 'x';
}

function commitTransformFromInputs() {
  if (!state.modelRoot) return;
  const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.eE+-]/g, '')); return isFinite(n) ? n : 0; };
  const r = state.modelRoot;
  r.position.set(num($('pos-x').value), num($('pos-y').value), num($('pos-z').value));
  r.rotation.set(
    THREE.MathUtils.degToRad(num($('rot-x').value)),
    THREE.MathUtils.degToRad(num($('rot-y').value)),
    THREE.MathUtils.degToRad(num($('rot-z').value))
  );
  syncTransformInputs();
  updateSelBox();
  pushHistory();
}

function centerPivot() {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  const box = new THREE.Box3().setFromObject(state.modelRoot);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  state.modelRoot.position.sub(c);
  syncTransformInputs(); updateSelBox(); pushHistory();
  toast('Pivot centered — model origin is now at its bounding-box center.', 'success', 2600);
}
function groundToFloor() {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  const box = new THREE.Box3().setFromObject(state.modelRoot);
  if (box.isEmpty()) return;
  state.modelRoot.position.y -= box.min.y;
  syncTransformInputs(); updateSelBox(); pushHistory();
  toast('Grounded — the model now sits on the grid (y = 0).', 'success', 2600);
}

/* ------------------------------------------------------------------ */
/* Material editing                                                    */
/* ------------------------------------------------------------------ */

function scopeRecs() { return state.scope ? state.meshes.filter((r) => r.mesh === state.scope) : state.meshes; }
function scopeEditableRecs() { return scopeRecs().filter((r) => r.editable && !r.isPoints); }
function scopeStats() {
  let tris = 0, verts = 0;
  for (const r of scopeRecs()) { tris += meshTris(r); verts += meshVerts(r); }
  return { tris, verts };
}
function scopeName() { return state.scope ? (state.scope.name || 'part') : 'whole model'; }

function eachScopePBRMaterial(fn) {
  let touched = 0;
  for (const rec of scopeRecs()) {
    const mats = Array.isArray(rec.baseMaterial) ? rec.baseMaterial : [rec.baseMaterial];
    for (const m of mats) {
      if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) { fn(m); touched++; }
    }
  }
  return touched;
}

let pbrHintShown = false;
function ensurePBRMaterials() {
  const touched = eachScopePBRMaterial(() => {});
  if (!touched && !pbrHintShown) {
    pbrHintShown = true;
    toast('This model’s materials aren’t PBR — pick one of the <b>material preset chips</b> first, then the sliders will drive it.', 'info', 6500);
  }
  return touched;
}

function applyMatParam(key, value) {
  if (!state.modelRoot) return;
  const touched = eachScopePBRMaterial((m) => {
    if (key === 'roughness') m.roughness = value;
    else if (key === 'metalness') m.metalness = value;
    else if (key === 'emission') {
      if (value > 0 && m.emissive && m.emissive.getHex() === 0x000000) m.emissive.set(0xffffff);
      m.emissiveIntensity = value * 2;
    }
    m.needsUpdate = true;
  });
  if (touched === 0) { ensurePBRMaterials(); return; }
  state.activePreset = null;
  updatePresetChips();
}

const PRESETS = {
  cyberpunk: { label: 'Cyberpunk Gloss', make: () => new THREE.MeshPhysicalMaterial({ color: 0x8b5cf6, metalness: 0.85, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.12, iridescence: 0.35, envMapIntensity: 1.25 }) },
  ceramic: { label: 'Matte Ceramic', make: () => new THREE.MeshPhysicalMaterial({ color: 0xe9e7e2, metalness: 0.0, roughness: 0.88, clearcoat: 0.08, envMapIntensity: 1.0 }) },
  chrome: { label: 'Liquid Chrome', make: () => new THREE.MeshPhysicalMaterial({ color: 0xf2f5ff, metalness: 1.0, roughness: 0.06, clearcoat: 1, envMapIntensity: 1.4 }) },
  gold: { label: 'Iridescent Gold', make: () => new THREE.MeshPhysicalMaterial({ color: 0xffc35c, metalness: 1.0, roughness: 0.26, iridescence: 0.55, iridescenceIOR: 1.8, envMapIntensity: 1.2 }) },
};

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p || !state.modelRoot) { if (!state.modelRoot) toast('Load a model first.', 'warn'); return; }
  const recs = scopeRecs().filter((r) => !r.isPoints);
  if (!recs.length) return toast('No polygon meshes in scope.', 'warn');
  for (const rec of recs) {
    // dispose only the materials we are replacing if nothing else references them (history does — so skip disposal)
    rec.baseMaterial = p.make();
  }
  state.activePreset = name;
  setViewMode('pbr');
  updatePresetChips();
  syncMaterialSliders();
  pushHistory();
  toast(`Applied <b>${p.label}</b> to ${scopeName()}.`, 'success', 2400);
}

function updatePresetChips() {
  document.querySelectorAll('.mat-preset-btn').forEach((b) => {
    const on = b.dataset.preset === state.activePreset;
    b.classList.toggle('bg-primary-container', on);
    b.classList.toggle('text-on-primary-container', on);
    b.classList.toggle('shadow-sm', on);
    b.classList.toggle('font-medium', on);
    b.classList.toggle('bg-surface-container', !on);
    b.classList.toggle('hover:bg-surface-container-high', !on);
    b.classList.toggle('text-on-surface', !on);
  });
}

function syncMaterialSliders() {
  let m = null;
  for (const rec of scopeRecs()) {
    const mats = Array.isArray(rec.baseMaterial) ? rec.baseMaterial : [rec.baseMaterial];
    m = mats.find((x) => x && (x.isMeshStandardMaterial || x.isMeshPhysicalMaterial)) || m;
    if (m) break;
  }
  if (!m) return;
  const set = (sliderId, valId, v) => {
    const s = $(sliderId); s.value = Math.round(clamp(v, 0, 1) * 100);
    $(valId).textContent = (s.value / 100).toFixed(2);
  };
  set('slider-rough', 'val-rough', m.roughness ?? 0.5);
  set('slider-metal', 'val-metal', m.metalness ?? 0);
  set('slider-emis', 'val-emis', (m.emissiveIntensity ?? 0) / 2);
}

/* ------------------------------------------------------------------ */
/* Geometry operations: subdivide / decimate / mirror / smooth         */
/* ------------------------------------------------------------------ */

function tolOf(g) {
  g.computeBoundingBox();
  const s = g.boundingBox.getSize(new THREE.Vector3()).length();
  return Math.max(s * 1e-6, 1e-9);
}

function toIndexed(g) {
  if (g.index) return g;
  return mergeVertices(g, tolOf(g));
}

// Midpoint subdivision: each triangle -> 4, interpolating all attributes.
function subdivideGeometry(src) {
  try {
    const g = toIndexed(src);
    const vc = g.getAttribute('position').count;
    const idx = g.getIndex().array;
    const triCount = Math.floor(idx.length / 3);
    const attrNames = Object.keys(g.attributes);

    const edgeMap = new Map();
    const newVerts = {}; // attrName -> flat array of midpoint values
    for (const n of attrNames) newVerts[n] = [];
    let nextVert = vc;

    const midIndex = (a, b) => {
      const key = a < b ? a * vc + b : b * vc + a;
      let m = edgeMap.get(key);
      if (m === undefined) {
        m = nextVert++;
        edgeMap.set(key, m);
        for (const n of attrNames) {
          const attr = g.attributes[n];
          const item = attr.itemSize;
          const arr = attr.array;
          for (let k = 0; k < item; k++) {
            newVerts[n].push((arr[a * item + k] + arr[b * item + k]) / 2);
          }
        }
      }
      return m;
    };

    const outIdx = new Uint32Array(triCount * 12);
    let w = 0;
    for (let t = 0; t < triCount; t++) {
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      const ab = midIndex(a, b), bc = midIndex(b, c), ca = midIndex(c, a);
      outIdx[w++] = a; outIdx[w++] = ab; outIdx[w++] = ca;
      outIdx[w++] = ab; outIdx[w++] = b; outIdx[w++] = bc;
      outIdx[w++] = ca; outIdx[w++] = bc; outIdx[w++] = c;
      outIdx[w++] = ab; outIdx[w++] = bc; outIdx[w++] = ca;
    }

    const geo = new THREE.BufferGeometry();
    for (const n of attrNames) {
      const attr = g.attributes[n];
      const item = attr.itemSize;
      const out = new attr.array.constructor((vc + newVerts[n].length / item) * item);
      out.set(attr.array);
      out.set(newVerts[n], attr.array.length);
      geo.setAttribute(n, new THREE.BufferAttribute(out, item));
    }
    geo.setIndex(new THREE.BufferAttribute(outIdx.subarray(0, w), 1));
    return geo;
  } catch (e) {
    console.warn('[Aether3D] subdivide failed:', e);
    return null;
  }
}

// Grid vertex-clustering decimation. O(n) per probe, binary-searched on grid size.
function decimateGeometry(src, targetTris) {
  try {
    const g = toIndexed(src);
    const posAttr = g.getAttribute('position');
    const vc = posAttr.count;
    const pos = posAttr.array;
    const idx = g.getIndex().array;
    const triCount = Math.floor(idx.length / 3);
    if (triCount <= targetTris) return g;

    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vc; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const sx = Math.max(maxX - minX, 1e-12), sy = Math.max(maxY - minY, 1e-12), sz = Math.max(maxZ - minZ, 1e-12);

    const cellCache = new Map(); // G -> {cx,cy,cz Int32Array}
    const cellsFor = (G) => {
      let cc = cellCache.get(G);
      if (cc) return cc;
      const cx = new Int32Array(vc), cy = new Int32Array(vc), cz = new Int32Array(vc);
      for (let i = 0; i < vc; i++) {
        cx[i] = Math.min(G - 1, Math.max(0, Math.floor((pos[3 * i] - minX) / sx * G)));
        cy[i] = Math.min(G - 1, Math.max(0, Math.floor((pos[3 * i + 1] - minY) / sy * G)));
        cz[i] = Math.min(G - 1, Math.max(0, Math.floor((pos[3 * i + 2] - minZ) / sz * G)));
      }
      cc = { cx, cy, cz };
      cellCache.set(G, cc);
      return cc;
    };
    const keyOf = (cc, i, G) => (cc.cx[i] * G + cc.cy[i]) * G + cc.cz[i];

    const facesAt = (G) => {
      const cc = cellsFor(G);
      const seen = new Set();
      let count = 0;
      for (let t = 0; t < triCount; t++) {
        const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
        const ka = keyOf(cc, a, G), kb = keyOf(cc, b, G), kc = keyOf(cc, c, G);
        if (ka === kb || kb === kc || ka === kc) continue;
        const lo = Math.min(ka, kb, kc), hi = Math.max(ka, kb, kc), mi = ka + kb + kc - lo - hi;
        const fk = lo + '_' + mi + '_' + hi; // string face key (numeric would overflow 2^53)
        if (!seen.has(fk)) { seen.add(fk); count++; }
      }
      return count;
    };

    // Smallest grid resolution that still yields >= target faces (don't over-reduce)
    let lo = 1, hi = 256;
    if (facesAt(256) < targetTris) return g;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (facesAt(mid) >= targetTris) hi = mid; else lo = mid + 1;
    }
    const G = Math.max(2, lo);
    const cc = cellsFor(G);

    // Build clustered geometry
    const cellRep = new Map(); // cellKey -> representative original vertex
    const vertNew = new Int32Array(vc).fill(-1);
    const usedOriginal = [];
    let nextNew = 0;
    const repOf = (key, vert) => {
      let rep = cellRep.get(key);
      if (rep === undefined) { rep = vert; cellRep.set(key, vert); }
      return rep;
    };
    const newIndexOf = (rep) => {
      if (vertNew[rep] < 0) { vertNew[rep] = nextNew++; usedOriginal.push(rep); }
      return vertNew[rep];
    };

    const faceSeen = new Set();
    const outIdx = [];
    for (let t = 0; t < triCount; t++) {
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      const ka = keyOf(cc, a, G), kb = keyOf(cc, b, G), kc = keyOf(cc, c, G);
      if (ka === kb || kb === kc || ka === kc) continue;
      const loK = Math.min(ka, kb, kc), hiK = Math.max(ka, kb, kc), miK = ka + kb + kc - loK - hiK;
      const fk = loK + '_' + miK + '_' + hiK;
      if (faceSeen.has(fk)) continue;
      faceSeen.add(fk);
      outIdx.push(newIndexOf(repOf(ka, a)), newIndexOf(repOf(kb, b)), newIndexOf(repOf(kc, c)));
    }
    if (outIdx.length < 3) return g;

    const geo = new THREE.BufferGeometry();
    for (const n of Object.keys(g.attributes)) {
      const attr = g.attributes[n];
      const item = attr.itemSize;
      const arr = attr.array;
      const out = new arr.constructor(usedOriginal.length * item);
      for (let ni = 0; ni < usedOriginal.length; ni++) {
        const old = usedOriginal[ni];
        for (let k = 0; k < item; k++) out[ni * item + k] = arr[old * item + k];
      }
      geo.setAttribute(n, new THREE.BufferAttribute(out, item));
    }
    geo.setIndex(outIdx);
    geo.computeVertexNormals();
    return geo;
  } catch (e) {
    console.warn('[Aether3D] decimate failed:', e);
    return null;
  }
}

function mirrorGeometry(src) {
  try {
    let g = src.clone();
    if (!g.index) g = mergeVertices(g, tolOf(src));
    g.scale(-1, 1, 1);
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    if (state.autoNormals) g.computeVertexNormals();
    return g;
  } catch (e) {
    console.warn('[Aether3D] mirror failed:', e);
    return null;
  }
}

function setRecGeometry(rec, g) {
  rec.mesh.geometry = g;
  rec.baseline = g;
  rec.pct = 100;
}

function afterGeometryOp(msg) {
  refreshStats();
  syncPolySliderUI();
  updateSelBox();
  pushHistory();
  if (msg) toast(msg, 'success', 3200);
}

function ensureEditableScope() {
  if (!state.modelRoot) { toast('Load a model first — try a sample from the tray.', 'warn'); return null; }
  const list = scopeEditableRecs();
  if (!list.length) {
    toast(state.scope
      ? 'This part can’t be edited (skinned / point geometry). Select another part or “Whole Model”.'
      : 'No editable polygon geometry in this model.', 'warn');
    return null;
  }
  return list;
}

function opSubdivide() {
  const list = ensureEditableScope();
  if (!list) return;
  const cur = list.reduce((a, r) => a + meshTris(r), 0);
  if (cur * 4 > 1500000) {
    toast(`Subdividing would create ~${fmtInt(cur * 4)} triangles (limit 1.5M for browser comfort). Decimate first.`, 'warn', 6000);
    return;
  }
  let done = 0;
  for (const rec of list) {
    const g = subdivideGeometry(rec.mesh.geometry);
    if (g) { setRecGeometry(rec, g); done++; }
  }
  if (done) afterGeometryOp(`Subdivided ${done} mesh${done > 1 ? 'es' : ''} — 4× the triangles, smoother silhouette.`);
}

function opDecimate() {
  const list = ensureEditableScope();
  if (!list) return;
  let done = 0;
  for (const rec of list) {
    const cur = meshTris(rec);
    if (cur < 16) continue;
    const g = decimateGeometry(rec.mesh.geometry, Math.max(Math.floor(cur * 0.5), 4));
    if (g && g !== rec.mesh.geometry) { setRecGeometry(rec, g); done++; }
  }
  if (done) afterGeometryOp(`Decimated ${done} mesh${done > 1 ? 'es' : ''} to ~50% of current polygons.`);
  else toast('Decimation produced no change (model may be too small or already minimal).', 'info');
}

function opMirror() {
  const list = ensureEditableScope();
  if (!list) return;
  let done = 0;
  for (const rec of list) {
    const g = mirrorGeometry(rec.mesh.geometry);
    if (g) { setRecGeometry(rec, g); done++; }
  }
  if (done) afterGeometryOp(`Mirrored ${done} mesh${done > 1 ? 'es' : ''} across the X axis (geometry baked, export-ready).`);
}

function opSmoothNormals() {
  const list = ensureEditableScope();
  if (!list) return;
  let done = 0;
  for (const rec of list) {
    let g = rec.mesh.geometry.clone();
    if (!g.index) g = mergeVertices(g, tolOf(rec.mesh.geometry));
    g.computeVertexNormals();
    setRecGeometry(rec, g);
    done++;
  }
  if (done) afterGeometryOp(`Recalculated smooth normals on ${done} mesh${done > 1 ? 'es' : ''}.`);
}

// Decimation slider — always relative to the current baseline (last committed state)
function applyPolyRatio(pct) {
  if (!state.modelRoot) return;
  const list = scopeEditableRecs();
  if (!list.length) return;
  let changed = 0;
  for (const rec of list) {
    if (pct >= 100) {
      if (rec.mesh.geometry !== rec.baseline) { rec.mesh.geometry = rec.baseline; rec.pct = 100; changed++; }
      else rec.pct = 100;
      continue;
    }
    const baseTris = trisOfGeometry(rec.baseline);
    if (baseTris < 16) continue;
    const target = Math.max(Math.floor(baseTris * pct / 100), 4);
    if (rec.pct === pct) continue;
    const g = decimateGeometry(rec.baseline, target);
    if (g) { rec.mesh.geometry = g; rec.pct = pct; changed++; }
  }
  if (changed) {
    refreshStats();
    updateSelBox();
    pushHistory();
  }
}

function syncPolySliderUI() {
  const list = scopeEditableRecs();
  const slider = $('poly-slider');
  const disp = $('poly-ratio-display');
  if (!state.modelRoot || !list.length) {
    slider.value = 100;
    disp.textContent = '100% (Original)';
    return;
  }
  const pcts = new Set(list.map((r) => r.pct));
  const pct = pcts.size === 1 ? [...pcts][0] : 100;
  slider.value = pct;
  const tris = scopeStats().tris;
  disp.textContent = `${pct}% (${fmtInt(tris)} Tris)`;
}

/* ------------------------------------------------------------------ */
/* Undo / redo                                                         */
/* ------------------------------------------------------------------ */

function historySnapshot() {
  return {
    pos: state.modelRoot.position.clone(),
    quat: state.modelRoot.quaternion.clone(),
    scale: state.modelRoot.scale.clone(),
    scope: state.scope,
    recs: state.meshes.map((r) => ({
      mesh: r.mesh,
      material: Array.isArray(r.baseMaterial) ? r.baseMaterial.map((m) => m && m.clone ? m.clone() : m) : (r.baseMaterial && r.baseMaterial.clone ? r.baseMaterial.clone() : r.baseMaterial),
      geometry: r.mesh.geometry,
      baseline: r.baseline,
      pct: r.pct,
    })),
  };
}

function pushHistory() {
  if (!state.modelRoot) return;
  state.history.length = state.hIndex + 1;
  state.history.push(historySnapshot());
  if (state.history.length > 30) state.history.shift();
  state.hIndex = state.history.length - 1;
  historyButtons();
}

function applySnapshot(s) {
  if (!s || !state.modelRoot) return;
  state.modelRoot.position.copy(s.pos);
  state.modelRoot.quaternion.copy(s.quat);
  state.modelRoot.scale.copy(s.scale);
  for (const r of s.recs) {
    const rec = state.meshes.find((x) => x.mesh === r.mesh);
    if (!rec) continue;
    rec.baseMaterial = r.material;
    rec.baseline = r.baseline;
    rec.pct = r.pct;
    rec.mesh.geometry = r.geometry;
  }
  state.scope = s.scope && state.meshes.some((x) => x.mesh === s.scope) ? s.scope : null;
  setViewMode(state.viewMode);
  syncTransformInputs();
  syncMaterialSliders();
  syncPolySliderUI();
  refreshStats();
  buildOutliner();
  updateSelBox();
}

function undo() {
  if (state.hIndex > 0) { state.hIndex--; applySnapshot(state.history[state.hIndex]); historyButtons(); }
}
function redo() {
  if (state.hIndex < state.history.length - 1) { state.hIndex++; applySnapshot(state.history[state.hIndex]); historyButtons(); }
}
function historyReset() {
  state.history = [];
  state.hIndex = -1;
  pushHistory();
}
function historyButtons() {
  $('btn-undo').disabled = state.hIndex <= 0;
  $('btn-redo').disabled = state.hIndex >= state.history.length - 1;
}

/* ------------------------------------------------------------------ */
/* Camera framing & world fitting                                      */
/* ------------------------------------------------------------------ */

function fitWorldToModel() {
  const box = new THREE.Box3().setFromObject(state.modelRoot);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-4);
  state.modelRadius = r;

  // Resize grid to something pleasant relative to the model
  const target = r * 2.6;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  let span = pow * 10;
  for (const m of [1, 2, 5, 10]) { if (pow * m >= target) { span = pow * m; break; } }
  scene.remove(grid);
  grid.geometry.dispose(); grid.material.dispose();
  grid = makeGrid(span);
  scene.add(grid);
  scene.fog.near = span * 0.9;
  scene.fog.far = span * 2.4;

  const dir = new THREE.Vector3(1, 0.5, 1.4).normalize();
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(persp.fov) / 2)) * 1.25;
  persp.position.copy(sphere.center).addScaledVector(dir, dist);
  controls.target.copy(sphere.center);
  persp.near = Math.max(r / 500, 0.001);
  persp.far = dist * 40 + r * 20;
  persp.updateProjectionMatrix();
  controls.minDistance = r * 0.02;
  controls.maxDistance = dist * 12;

  if (state.camType === 'ortho') {
    syncOrthoFromPersp();
    controls.object = ortho;
  }
  controls.update();
}

function frameCamera(forceDefaultDir = false) {
  if (!state.modelRoot) {
    controls.target.set(0, 0.5, 0);
    const d = new THREE.Vector3(4.5, 3.0, 6.5);
    persp.position.copy(d);
    if (state.camType === 'ortho') { syncOrthoFromPersp(); }
    controls.update();
    return;
  }
  const box = new THREE.Box3().setFromObject(state.modelRoot);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-4);
  let dir = new THREE.Vector3().subVectors(activeCam.position, controls.target);
  if (forceDefaultDir || dir.lengthSq() < 1e-10) dir.set(1, 0.5, 1.4);
  dir.normalize();
  if (state.camType === 'persp') {
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(persp.fov) / 2)) * 1.25;
    persp.position.copy(sphere.center).addScaledVector(dir, dist);
    persp.updateProjectionMatrix();
  } else {
    const halfH = (ortho.top - ortho.bottom) / 2;
    ortho.zoom = Math.max(halfH / (r * 1.3), 0.0001);
    ortho.updateProjectionMatrix();
    ortho.position.copy(sphere.center).addScaledVector(dir, Math.max(ortho.position.distanceTo(controls.target), r * 2));
  }
  controls.target.copy(sphere.center);
  controls.update();
}

/* ------------------------------------------------------------------ */
/* Export & download                                                   */
/* ------------------------------------------------------------------ */

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function doExport() {
  if (!state.modelRoot) { toast('Load a model first — drop a file or pick a sample.', 'warn'); return; }
  if (state.viewMode !== 'pbr') {
    setViewMode('pbr'); // export must carry the real materials, not the wire/matcap/xray display override
    toast('Switched back to PBR shading so the export carries the real materials.', 'info', 3200);
  }
  const fmt = state.exportFormat;
  const btn = $('btn-download');
  const label = $('btn-download-label');
  btn.disabled = true;
  label.textContent = 'Baking geometry…';
  await new Promise((r) => setTimeout(r, 40));
  try {
    let blob, name;
    if (fmt === 'obj') {
      const text = new OBJExporter().parse(state.modelRoot);
      blob = new Blob([text], { type: 'text/plain' });
      name = `${state.baseName}_aether.obj`;
    } else if (fmt === 'glb') {
      const result = await new Promise((resolve, reject) =>
        new GLTFExporter().parse(state.modelRoot, resolve, reject, { binary: true, onlyVisible: true }));
      blob = new Blob([result], { type: 'model/gltf-binary' });
      name = `${state.baseName}_aether.glb`;
    } else if (fmt === 'stl') {
      const dv = new STLExporter().parse(state.modelRoot, { binary: true });
      blob = new Blob([dv], { type: 'application/octet-stream' });
      name = `${state.baseName}_aether.stl`;
    } else {
      throw new Error('Unknown format');
    }
    if (blob) {
      saveBlob(blob, name);
      label.textContent = 'Export Ready!';
      toast(`Exported <b>${escapeHTML(name)}</b> (${fmtBytes(blob.size)}) — all edits baked in. Check your downloads.`, 'success', 5000);
    }
  } catch (err) {
    console.error('[Aether3D] export failed:', err);
    toast(`Export failed: ${escapeHTML((err && err.message) || String(err))}`, 'error', 7000);
  } finally {
    btn.disabled = false;
    setTimeout(() => { label.textContent = `Download Model (${state.exportFormat.toUpperCase()})`; }, 1200);
  }
}

function downloadOriginal() {
  const f = state.originalFile;
  if (!f) { toast('No file loaded yet — drop a model first. (Samples aren’t files on disk.)', 'warn'); return; }
  saveBlob(new Blob([f], { type: f.type || 'application/octet-stream' }), f.name);
  toast(`Downloading your original <b>${escapeHTML(f.name)}</b> (${fmtBytes(f.size)}) — byte-for-byte, untouched.`, 'success', 4500);
}

function setExportFormat(fmt) {
  if (fmt === 'fbx') {
    toast('FBX <b>export</b> isn’t possible in the browser (the format is proprietary and no JS writer exists). <b>GLB</b> is the universal choice — Blender, Unity, Unreal and Godot all open it natively.', 'info', 7000);
    return;
  }
  state.exportFormat = fmt;
  document.querySelectorAll('.export-format-btn').forEach((b) => {
    const on = b.dataset.fmt === fmt;
    b.classList.toggle('bg-primary-container', on);
    b.classList.toggle('text-on-primary-container', on);
    b.classList.toggle('font-semibold', on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
  $('btn-download-label').textContent = `Download Model (${fmt.toUpperCase()})`;
}

/* ------------------------------------------------------------------ */
/* Samples                                                             */
/* ------------------------------------------------------------------ */

function makeTorusKnot() {
  const geo = new THREE.TorusKnotGeometry(1, 0.34, 256, 40);
  const mat = PRESETS.cyberpunk.make();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'torus_knot';
  const grp = new THREE.Group();
  grp.add(mesh);
  return grp;
}

function fetchWithProgress(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = (e) => { if (e.lengthComputable || e.total) setLoadingProgress(e.loaded, e.total || 0); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response) : reject(new Error(`HTTP ${xhr.status} for sample asset`)));
    xhr.onerror = () => reject(new Error('Network error — CDN unreachable'));
    xhr.send();
  });
}

const SAMPLES = {
  torus: { label: 'Torus Knot', fmt: 'PROC', load: async () => makeTorusKnot() },
  helmet: {
    label: 'Damaged Helmet', fmt: 'GLTF',
    load: async () => {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath(THREE_CDN + 'libs/draco/gltf/');
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const buf = await fetchWithProgress(GH_MODELS + 'gltf/DamagedHelmet/glTF/DamagedHelmet.gltf');
      // load .gltf JSON — its external .bin/textures resolve relative to the jsdelivr folder
      const text = new TextDecoder().decode(buf);
      const gltf = await new Promise((resolve, reject) => loader.parse(text, GH_MODELS + 'gltf/DamagedHelmet/glTF/', resolve, reject));
      return gltf.scene;
    },
  },
  male02: {
    label: 'Retro Man', fmt: 'OBJ',
    load: async () => {
      const mtlUrl = GH_MODELS + 'obj/male02/male02.mtl';
      const objUrl = GH_MODELS + 'obj/male02/male02.obj';
      const creator = await new Promise((resolve, reject) => new MTLLoader().load(mtlUrl, resolve, undefined, reject));
      creator.preload();
      const objLoader = new OBJLoader();
      objLoader.setMaterials(creator);
      const objText = new TextDecoder().decode(await fetchWithProgress(objUrl));
      return objLoader.parse(objText);
    },
  },
  samba: {
    label: 'Samba Dancer', fmt: 'FBX',
    load: async () => {
      const buf = await fetchWithProgress(GH_MODELS + 'fbx/Samba%20Dancing.fbx');
      return new FBXLoader().parse(buf, '');
    },
  },
  lucy: {
    label: 'Lucy Scan', fmt: 'PLY',
    load: async () => {
      const buf = await fetchWithProgress(GH_MODELS + 'ply/binary/Lucy100k.ply');
      const geo = new PLYLoader().parse(buf);
      if (geo.index || geo.getAttribute('normal')) {
        return new THREE.Mesh(geo, defaultMaterial());
      }
      return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fdcff, size: 0.004 }));
    },
  },
};

async function loadSample(key) {
  const s = SAMPLES[key];
  if (!s) return;
  const pop = $('sample-popover');
  if (pop) pop.classList.add('hidden');
  setLoading(true, `Fetching sample: ${s.label}…`);
  try {
    const obj = await s.load();
    state.originalFile = null;
    state.baseName = key === 'torus' ? 'torus_knot' : key;
    updateDownloadOriginal();
    setModel(obj, s.fmt);
    toast(`Sample loaded: <b>${s.label}</b> (${s.fmt}). Drag to orbit, scroll to zoom, try the edit tools!`, 'success', 4200);
  } catch (err) {
    console.error('[Aether3D] sample failed:', err);
    toast(`Couldn’t load the <b>${s.label}</b> sample (${escapeHTML(err.message || err)}). CDN unreachable? The <b>Torus Knot</b> sample works fully offline.`, 'error', 8000);
  } finally {
    setLoading(false);
  }
}

/* ------------------------------------------------------------------ */
/* Render loop / resize / stats                                        */
/* ------------------------------------------------------------------ */

function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  persp.aspect = aspect;
  persp.updateProjectionMatrix();
  const halfH = ((ortho.top - ortho.bottom) / 2) / Math.max(ortho.zoom, 1e-6);
  ortho.left = -halfH * aspect; ortho.right = halfH * aspect;
  ortho.top = halfH; ortho.bottom = -halfH;
  ortho.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
resize();

let fpsEMA = 60, lastT = performance.now(), fpsFrames = 0, fpsAccum = 0;

function tick(t) {
  requestAnimationFrame(tick);
  const dt = t - lastT;
  lastT = t;
  if (dt > 0 && dt < 1000) { fpsAccum += dt; fpsFrames++; }
  controls.update();
  if (state.scope && selHelper.visible) selBox.setFromObject(state.scope);
  renderer.render(scene, activeCam);
  renderGizmo();
}
requestAnimationFrame(tick);

setInterval(() => {
  if (fpsFrames > 0) {
    fpsEMA = fpsAccum / fpsFrames;
    $('stat-fps').textContent = `FPS: ${fpsEMA.toFixed(0)}`;
    const info = renderer.info;
    $('stat-calls').textContent = `Draw calls: ${info.render.calls}`;
    $('stat-textures').textContent = `Tex: ${info.memory.textures}`;
    fpsFrames = 0; fpsAccum = 0;
  }
}, 500);

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

// File input & drag & drop
const fileInput = $('file-input');
$('dropzone').addEventListener('click', () => fileInput.click());
$('nav-import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFiles(fileInput.files); fileInput.value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  container.classList.add('drop-active');
});
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) { dragDepth = 0; container.classList.remove('drop-active'); }
  else if (dragDepth > 0) { dragDepth--; if (dragDepth === 0) container.classList.remove('drop-active'); }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  container.classList.remove('drop-active');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

// View modes
document.querySelectorAll('.viewmode-btn').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.mode)));

// Lighting presets
document.querySelectorAll('.light-preset-btn').forEach((b) => b.addEventListener('click', () => setLightPreset(Number(b.dataset.preset))));

// Camera type
$('cam-perspective').addEventListener('click', () => setCamType('persp'));
$('cam-ortho').addEventListener('click', () => setCamType('ortho'));

// Nav modes (mouse mapping)
document.querySelectorAll('.nav-mode-btn').forEach((b) => b.addEventListener('click', () => {
  const mode = b.dataset.nav;
  const map = { orbit: THREE.MOUSE.ROTATE, pan: THREE.MOUSE.PAN, zoom: THREE.MOUSE.DOLLY };
  if (map[mode] !== undefined) controls.mouseButtons.LEFT = map[mode];
  document.querySelectorAll('.nav-mode-btn').forEach((x) => {
    const on = x === b;
    x.classList.toggle('text-secondary', on);
    x.classList.toggle('bg-surface-container-high', on);
    x.classList.toggle('text-on-surface-variant', !on);
  });
}));
$('btn-frame').addEventListener('click', () => frameCamera(false));
$('btn-cam-reset').addEventListener('click', () => frameCamera(true));

// Transform tools
document.querySelectorAll('.transform-tool-btn').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

// Geometry ops
$('btn-subdivide').addEventListener('click', opSubdivide);
$('btn-decimate').addEventListener('click', opDecimate);
$('btn-mirror').addEventListener('click', opMirror);
$('btn-normals').addEventListener('click', opSmoothNormals);

// Transform inputs
[$('pos-x'), $('pos-y'), $('pos-z'), $('rot-x'), $('rot-y'), $('rot-z')].forEach((inp) => {
  inp.addEventListener('change', commitTransformFromInputs);
  // Enter just blurs — the native 'change' fired by blur does ONE commit (no duplicate history entry)
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
});
$('btn-transform-reset').addEventListener('click', () => {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  state.modelRoot.position.set(0, 0, 0);
  state.modelRoot.rotation.set(0, 0, 0);
  state.modelRoot.scale.set(1, 1, 1);
  syncTransformInputs(); updateSelBox(); pushHistory();
  toast('Transform reset to identity.', 'success', 2200);
});
$('btn-center-pivot').addEventListener('click', centerPivot);
$('btn-ground').addEventListener('click', groundToFloor);

// Scale slider
$('scale-slider').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  $('scale-display').textContent = v.toFixed(2) + 'x';
  if (state.modelRoot) state.modelRoot.scale.setScalar(v);
});
$('scale-slider').addEventListener('change', () => { if (state.modelRoot) pushHistory(); });

// Poly decimation slider
$('poly-slider').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  const baseTris = scopeEditableRecs().reduce((a, r) => a + trisOfGeometry(r.baseline), 0);
  $('poly-ratio-display').textContent = `${val}% (~${fmtInt(baseTris * val / 100)} Tris)`;
});
$('poly-slider').addEventListener('change', (e) => applyPolyRatio(Number(e.target.value)));

// Auto normals toggle
$('chk-autonormals').addEventListener('change', (e) => {
  state.autoNormals = e.target.checked;
  toast(state.autoNormals
    ? 'Auto-fix normals ON — normals are recomputed after geometry edits.'
    : 'Auto-fix normals OFF — original normals are preserved where possible.', 'info', 2800);
});

// Material sliders
function bindMatSlider(sliderId, valId, key) {
  const s = $(sliderId);
  s.addEventListener('input', () => {
    const v = s.value / 100;
    $(valId).textContent = v.toFixed(2);
    if (state.viewMode !== 'pbr' && state.modelRoot) setViewMode('pbr');
    applyMatParam(key, v);
  });
  s.addEventListener('change', () => { if (state.modelRoot) pushHistory(); });
}
bindMatSlider('slider-rough', 'val-rough', 'roughness');
bindMatSlider('slider-metal', 'val-metal', 'metalness');
bindMatSlider('slider-emis', 'val-emis', 'emission');

// Material presets
document.querySelectorAll('.mat-preset-btn').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));

// Export
document.querySelectorAll('.export-format-btn').forEach((b) => b.addEventListener('click', () => setExportFormat(b.dataset.fmt)));
$('btn-download').addEventListener('click', doExport);
$('btn-header-export').addEventListener('click', () => {
  doExport();
  $('right-dock').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('btn-download-original').addEventListener('click', downloadOriginal);

// Samples
const pop = $('sample-popover');
$('nav-samples').addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); });
document.addEventListener('click', (e) => { if (!pop.contains(e.target) && e.target !== $('nav-samples')) pop.classList.add('hidden'); });
document.querySelectorAll('.sample-item').forEach((b) => b.addEventListener('click', () => loadSample(b.dataset.sample)));
$('btn-sample-torus').addEventListener('click', () => loadSample('torus'));
$('btn-sample-helmet').addEventListener('click', () => loadSample('helmet'));
$('btn-sample-torus-2').addEventListener('click', () => loadSample('torus'));
$('btn-sample-helmet-2').addEventListener('click', () => loadSample('helmet'));

// Header actions
$('nav-new').addEventListener('click', () => {
  if (!state.modelRoot) return toast('Scene is already empty.', 'info', 2000);
  clearModel();
  state.originalFile = null;
  state.baseName = 'model';
  updateDownloadOriginal();
  frameCamera(true);
  toast('New scene — drop your next model anytime.', 'success', 2600);
});
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-toggle-grid').addEventListener('click', () => {
  grid.visible = !grid.visible;
  toast(`Grid ${grid.visible ? 'shown' : 'hidden'}.`, 'info', 1800);
});
$('btn-simple-edit').addEventListener('click', () => {
  const dock = $('right-dock');
  dock.classList.toggle('hidden');
  setTimeout(resize, 60);
});
$('btn-quick-preview').addEventListener('click', () => setPreview(true));
$('btn-exit-preview').addEventListener('click', () => setPreview(false));
function setPreview(on) {
  document.body.classList.toggle('preview-mode', on);
  setTimeout(resize, 60);
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case 'v': setTool('select'); break;
    case 'g': setTool('move'); break;
    case 'r': setTool('rotate'); break;
    case 's': setTool('scale'); break;
    case 'f': frameCamera(false); break;
    case 'escape':
      if (document.body.classList.contains('preview-mode')) setPreview(false);
      else setTool('select');
      break;
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

setLightPreset(0);
setViewMode('pbr');
setTool('move', true);
setCamType('persp');
updateCamButtons();
buildOutliner();
updateEmptyState();
updateDownloadOriginal();
historyButtons();
refreshStats();
syncMaterialSliders();
syncPolySliderUI();
updatePresetChips();

console.info('%cAether3D Studio ready — three.js r170, 100% client-side.', 'color:#4cd7f6;font-weight:bold;');

// Expose a small API (handy for power users & automated tests)
window.aether3d = {
  state,
  handleFiles,
  loadSample,
  doExport,
  downloadOriginal,
  setViewMode,
  setTool,
  version: '2.4.0',
  three: THREE.REVISION,
};
