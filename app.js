/* =====================================================================
   Online 3D Studio — static in-browser 3D model viewer & editor
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
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';

/* ------------------------------------------------------------------ */
/* Constants & tiny helpers                                            */
/* ------------------------------------------------------------------ */

// App version — shown in the header. Rules: +0.1 for a small feature update, +1 for a revamp or
// major feature update, and a letter suffix (b, c, d…) for bug-fix-only releases of the same version.
const APP_VERSION = 'v2.1';

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
  scope: null,         // null = whole scene, else a top-level object or a part (mesh)
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
  const ml = $('mobile-camtoggle-label');
  if (ml) ml.textContent = state.camType === 'persp' ? 'PERSP' : 'ORTHO';
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

/* ---------- Texture lookup for imports ----------
   Every import gets a context that records which texture files a model asked for but couldn't use,
   so we can tell the user instead of silently showing white. */

const BROWSER_CANT_SHOW = new Set(['tif', 'tiff', 'psd', 'dds', 'exr', 'hdr']);
const baseKey = (s) => { try { s = decodeURIComponent(s); } catch (e) {} return s.split('?')[0].split('#')[0].split(/[\\/]/).pop().trim().toLowerCase(); };

function newImportCtx(map) {
  const ctx = { map, missing: new Set(), unsupported: new Set(), failed: new Set(), urlName: new Map(), used: new Set(), started: false };
  for (const [k, v] of map) { ctx.urlName.set(v.url, v.file.name); if (v.rawUrl) ctx.urlName.set(v.rawUrl, v.file.name); }
  ctx.done = new Promise((res) => { ctx.finish = res; });
  return ctx;
}

// Find a referenced texture/file among the dropped files (by file name, ignoring folders and case)
function lookupFile(ctx, ref, opts = {}) {
  const key = baseKey(ref);
  const hit = ctx.map.get(key);
  if (hit) { ctx.used.add(key); return opts.raw && hit.rawUrl ? hit.rawUrl : hit.url; }
  if (key) (BROWSER_CANT_SHOW.has(extOf(key)) ? ctx.unsupported : ctx.missing).add(ref.split(/[\\/]/).pop());
  return null;
}

function makeManager(ctx, opts = {}) {
  const m = new THREE.LoadingManager();
  m.onStart = () => { ctx.started = true; };
  m.onLoad = () => ctx.finish();
  m.onError = (url) => { ctx.failed.add(ctx.urlName.get(url) || url.split(/[\\/]/).pop()); };
  m.setURLModifier((url) => {
    if (/^(data:|blob:)/i.test(url)) return url;
    return lookupFile(ctx, url, opts) || url;
  });
  // TGA (common in FBX packs) — decoded by us; works for both external and embedded textures
  m.addHandler(/\.tga$/i, new AnyImageTextureLoader(m));
  return m;
}

// Wait until a loader's textures have finished (or failed), with a time limit
async function waitForTextures(ctx, ms = 20000) {
  if (!ctx.started) await new Promise((r) => setTimeout(r, 300));
  if (!ctx.started) return;
  await Promise.race([ctx.done, new Promise((r) => setTimeout(r, ms))]);
}

// ---- image decoding that also understands TGA ----
function canvasFromRGBA(data, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, w * h * 4), w, h), 0, 0);
  return c;
}
async function decodeImageBytes(buf) {
  const u8 = new Uint8Array(buf);
  if (sniffImage(u8) || ascii(u8, 0, 3) === 'GIF' || ascii(u8, 0, 2) === 'BM') {
    return await createImageBitmap(new Blob([u8]));
  }
  const t = new TGALoader().parse(buf); // throws on data it can't read
  return canvasFromRGBA(t.data, t.width, t.height);
}
async function tgaFileToPNG(file) {
  const img = await decodeImageBytes(await file.arrayBuffer());
  const c = img instanceof HTMLCanvasElement ? img : (() => { const k = document.createElement('canvas'); k.width = img.width; k.height = img.height; k.getContext('2d').drawImage(img, 0, 0); return k; })();
  return await new Promise((r) => c.toBlob(r, 'image/png'));
}

// A texture loader for loaders that hand us .tga files (FBX): accepts TGA or any browser image format
class AnyImageTextureLoader extends THREE.Loader {
  load(url, onLoad, onProgress, onError) {
    const tex = new THREE.Texture();
    const full = this.manager.resolveURL((this.path || '') + url);
    this.manager.itemStart(full);
    fetch(full).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(decodeImageBytes)
      .then((img) => { tex.image = img; tex.needsUpdate = true; if (onLoad) onLoad(tex); this.manager.itemEnd(full); })
      .catch((e) => { if (onError) onError(e); this.manager.itemError(full); this.manager.itemEnd(full); });
    return tex;
  }
}

// MTL texture options and how many values each takes (everything after them is the file name)
const MTL_OPT_ARGS = { '-blendu': 1, '-blendv': 1, '-bm': 1, '-boost': 1, '-cc': 1, '-clamp': 1, '-imfchan': 1, '-mm': 2, '-o': 3, '-s': 3, '-t': 3, '-texres': 1, '-type': 1 };

// Point texture references in an MTL file at the dropped files. File names may contain spaces
// and Windows/Mac folder paths; unknown ones are recorded as missing.
function rewriteMTLTextures(text, ctx) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*(?:map_Ka|map_Kd|map_Ks|map_Ns|map_d|map_Ke|map_bump|map_Bump|bump|disp|decal|refl|norm|map_Pr|map_Pm)\s+)(.*)$/i);
    if (!m) return line;
    const toks = m[2].trim().split(/\s+/);
    const opts = [];
    let i = 0;
    while (i < toks.length && MTL_OPT_ARGS[toks[i].toLowerCase()] !== undefined) {
      let n = MTL_OPT_ARGS[toks[i].toLowerCase()];
      opts.push(toks[i++]);
      // -s / -o / -t take 1–3 numbers
      while (n-- > 0 && i < toks.length && (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(toks[i]) || /^(on|off)$/i.test(toks[i]) || /^[rgbmlz]$/i.test(toks[i]))) opts.push(toks[i++]);
    }
    const name = toks.slice(i).join(' ');
    if (!name) return line;
    // try the whole name (spaces allowed), then just its last word (stray trailing junk)
    const hit = lookupFile(ctx, name) || (toks.length - i > 1 ? (() => { const k = baseKey(toks[toks.length - 1]); const u = ctx.map.get(k); if (u) { ctx.missing.delete(name.split(/[\\/]/).pop()); ctx.used.add(k); return u.url; } return null; })() : null);
    return m[1] + (opts.length ? opts.join(' ') + ' ' : '') + (hit || name);
  }).join('\n');
}

// The .mtl file(s) an .obj names with "mtllib"; falls back sensibly when names don't match
function pickMTLFiles(objText, map, objName) {
  const mtls = [...map.values()].filter((v) => extOf(v.file.name) === 'mtl').map((v) => v.file);
  if (!mtls.length) return [];
  const byName = new Map(mtls.map((f) => [f.name.toLowerCase(), f]));
  const picked = [];
  for (const mm of objText.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)) {
    const whole = baseKey(mm[1]);
    if (byName.has(whole)) { picked.push(byName.get(whole)); continue; }
    for (const part of mm[1].split(/\s+/)) { const f = byName.get(baseKey(part)); if (f) picked.push(f); }
  }
  if (picked.length) return [...new Set(picked)];
  if (mtls.length === 1) return mtls;
  const same = mtls.find((f) => baseNameOf(f.name).toLowerCase() === baseNameOf(objName).toLowerCase());
  return same ? [same] : mtls; // several unnamed candidates: use them all (material names rarely clash)
}

let ktx2Loader = null;
function getKTX2Loader() {
  if (!ktx2Loader) ktx2Loader = new KTX2Loader().setTranscoderPath(THREE_CDN + 'libs/basis/').detectSupport(renderer);
  return ktx2Loader;
}

function defaultMaterial() {
  return new THREE.MeshPhysicalMaterial({ color: 0xb9c0d4, metalness: 0.15, roughness: 0.55, envMapIntensity: 1.0 });
}

async function parseModel(file, ctx) {
  const ext = extOf(file.name);
  if (ext === 'obj') {
    let text = await file.text();
    // Loose edges ("l") or points ("p") mixed into an object with faces make three's OBJLoader turn the
    // WHOLE object into lines — the surface disappears. They can't be shown as surfaces anyway, so drop them.
    if (/^\s*f\s/m.test(text)) {
      let dropped = 0;
      text = text.replace(/^[ \t]*[lp][ \t].*$/gm, () => { dropped++; return ''; });
      ctx.droppedLines = dropped;
    }
    const objLoader = new OBJLoader();
    const mtlFiles = pickMTLFiles(text, ctx.map, file.name);
    if (mtlFiles.length) {
      try {
        const mtlText = (await Promise.all(mtlFiles.map((f) => f.text()))).join('\n');
        const creator = new MTLLoader(makeManager(ctx)).parse(rewriteMTLTextures(mtlText, ctx), '');
        creator.preload();
        objLoader.setMaterials(creator);
      } catch (e) { console.warn('[Online3D] MTL parsing failed — loading OBJ without materials:', e); }
    }
    return objLoader.parse(text);
  }
  if (ext === 'fbx') {
    const buf = await file.arrayBuffer();
    return new FBXLoader(makeManager(ctx)).parse(buf, '');
  }
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader(makeManager(ctx));
    const draco = new DRACOLoader();
    draco.setDecoderPath(THREE_CDN + 'libs/draco/gltf/');
    loader.setDRACOLoader(draco);
    loader.setKTX2Loader(getKTX2Loader()); // compressed (Basis/KTX2) textures
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
    // ColladaLoader decodes .tga itself, so it gets the original TGA bytes
    const collada = new ColladaLoader(makeManager(ctx, { raw: true })).parse(await file.text(), '');
    return collada.scene;
  }
  if (ext === '3mf') {
    return new ThreeMFLoader(makeManager(ctx)).parse(await file.arrayBuffer());
  }
  throw new Error('Unsupported format: .' + ext);
}

// After loading: textures that ended up empty (unsupported formats some loaders skip quietly)
const MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap'];
function reportTextureProblems(ctx, recs, modelName) {
  // loaders that skip a texture quietly (e.g. FBX with a .tif) leave an empty texture behind
  if (!ctx.failed.size && !ctx.missing.size && !ctx.unsupported.size) for (const r of recs) for (const m of [].concat(r.baseMaterial)) for (const k of MAP_KEYS) {
    const t = m && m[k];
    if (t && t.isTexture && !t.isCompressedTexture && !t.isDataTexture && (!t.image || !(t.image.width || t.image.videoWidth))) {
      const n = t.name || (m.name ? `${m.name} (${k})` : k);
      if (![...ctx.missing, ...ctx.unsupported].some((x) => x.toLowerCase() === n.toLowerCase())) ctx.failed.add(n);
    }
  }
  for (const n of [...ctx.failed]) if ([...ctx.missing, ...ctx.unsupported].some((x) => x.toLowerCase() === n.toLowerCase())) ctx.failed.delete(n);
  const parts = [];
  const list = (set) => escapeHTML([...set].slice(0, 6).join(', ')) + (set.size > 6 ? ` and ${set.size - 6} more` : '');
  if (ctx.missing.size) parts.push(`<b>not included</b>: ${list(ctx.missing)}`);
  if (ctx.unsupported.size) parts.push(`<b>a format browsers can’t display</b> (convert to PNG/JPEG): ${list(ctx.unsupported)}`);
  if (ctx.failed.size) parts.push(`<b>couldn’t be read</b>: ${list(ctx.failed)}`);
  if (parts.length) {
    toast(`Some textures of <b>${escapeHTML(modelName)}</b> couldn’t be used, so those areas show plain color — ${parts.join('; ')}. Add the missing files to the zip (any folder is fine) and import again.`, 'warn', 14000);
  }
  return parts.length;
}

/* ---------- Checking files before anything is loaded ----------
   A model file must really be what its extension says (checked from its bytes), and a .zip is
   only accepted if it contains such a model. Nothing in the scene changes when a check fails. */

const ZIP_LIMITS = { maxEntries: 5000, maxTotalBytes: 1024 * 1048576, maxRatio: 1000 };
const ZIP_KEEP_EXT = new Set([...SUPPORTED_EXT, 'mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga', 'ktx2', 'dds']);

async function readHead(file, n = 4 * 1048576) {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}
const ascii = (u8, a = 0, b = u8.length) => { let s = ''; for (let i = a; i < Math.min(b, u8.length); i++) s += String.fromCharCode(u8[i]); return s; };

// Returns null if the file looks like a valid model of its type, otherwise a short reason
async function checkModelFile(file) {
  const ext = extOf(file.name);
  if (file.size === 0) return 'the file is empty';
  const head = await readHead(file);
  const txt = () => strFromU8(head.subarray(0, Math.min(head.length, 4 * 1048576)), true);
  switch (ext) {
    case 'glb': return ascii(head, 0, 4) === 'glTF' ? null : 'it doesn’t start with the GLB “glTF” signature';
    case 'gltf': {
      if (file.size > 300 * 1048576) return null; // too big to pre-parse; the loader will check it
      try { const j = JSON.parse(await file.text()); return j && j.asset ? null : 'it’s JSON but has no glTF “asset” block'; }
      catch (e) { return 'it isn’t valid glTF JSON'; }
    }
    case 'obj': return /^\s*v\s+[-+.\d]/m.test(txt()) ? null : 'no vertex (“v x y z”) lines were found';
    case 'stl': {
      if (head.length >= 84) {
        const n = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(80, true);
        if (n > 0 && 84 + n * 50 <= file.size && file.size - (84 + n * 50) < 4096) return null; // binary STL
      }
      const t = txt();
      return /^\s*solid/i.test(t) && /facet\s+normal/i.test(t) ? null : 'it’s neither a binary STL nor an ASCII STL with facets';
    }
    case 'ply': return /^ply\r?\n/.test(ascii(head, 0, 5)) ? null : 'it doesn’t start with the “ply” header';
    case 'fbx': {
      if (ascii(head, 0, 18) === 'Kaydara FBX Binary') return null;
      return /FBXHeaderExtension|;\s*FBX\s+\d/.test(txt()) ? null : 'it isn’t a binary or ASCII FBX file';
    }
    case 'dae': return /<COLLADA[\s>]/.test(txt()) ? null : 'no <COLLADA> element was found';
    case '3mf': return ascii(head, 0, 4) === 'PK\x03\x04' ? null : '3MF files are zip-based, but this one isn’t';
  }
  return 'unsupported type';
}

// Unpack a .zip into File objects — or throw an Error explaining why it was rejected
function expandZip(zipFile, bytes) {
  let entries = 0, total = 0;
  const ignored = [];
  let out;
  try {
    out = unzipSync(bytes, {
      filter: (f) => {
        entries++;
        if (entries > ZIP_LIMITS.maxEntries) throw new Error(`it has more than ${ZIP_LIMITS.maxEntries} entries`);
        const name = f.name;
        const base = name.split('/').pop();
        if (!base || name.endsWith('/') || name.startsWith('__MACOSX/') || base.startsWith('.')) return false;
        if (!ZIP_KEEP_EXT.has(extOf(base))) { ignored.push(base); return false; }
        total += f.originalSize;
        if (total > ZIP_LIMITS.maxTotalBytes) throw new Error('it would unpack to more than 1 GB');
        if (f.size > 0 && f.originalSize / f.size > ZIP_LIMITS.maxRatio) throw new Error(`“${base}” is suspiciously over-compressed (possible zip bomb)`);
        return true;
      },
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/^it |^“/.test(msg)) throw new Error(msg);
    throw new Error('it couldn’t be read — it may be damaged, password-protected, or not really a zip');
  }
  const files = Object.entries(out).map(([name, data]) => new File([data], name.split('/').pop()));
  return { files, ignored };
}

async function handleFiles(fileList) {
  let files = [...fileList].filter(Boolean);
  if (!files.length) return;

  // ---- 1) unpack and vet any .zip files ----
  // Several zips may be dropped together (e.g. "model.zip" + "textures.zip"). Each must be a real,
  // safe zip, and at least one file in the whole drop must be a 3D model.
  const zips = files.filter((f) => extOf(f.name) === 'zip');
  if (zips.length) {
    if (zips.length > 6) return toast('Please drop at most 6 .zip files at a time.', 'warn', 5000);
    const unpackedAll = [];
    const ignored = [];
    let modelZip = null;
    for (const zip of zips) {
      let unpacked;
      try {
        const bytes = new Uint8Array(await zip.arrayBuffer());
        if (ascii(bytes, 0, 2) !== 'PK') throw new Error('it isn’t a zip file (wrong signature)');
        unpacked = expandZip(zip, bytes);
      } catch (e) {
        return toast(`Rejected <b>${escapeHTML(zip.name)}</b>: ${escapeHTML(e.message)}. Nothing was loaded.`, 'error', 9000);
      }
      if (!modelZip && unpacked.files.some((f) => SUPPORTED_EXT.includes(extOf(f.name)))) modelZip = zip;
      unpackedAll.push(...unpacked.files);
      ignored.push(...unpacked.ignored);
    }
    const looseModels = files.some((f) => SUPPORTED_EXT.includes(extOf(f.name)));
    if (!modelZip && !looseModels) {
      const seen = unpackedAll.map((f) => f.name).concat(ignored);
      const what = zips.length > 1 ? 'these zips contain' : 'it contains';
      return toast(`Rejected <b>${escapeHTML(zips.map((z) => z.name).join(', '))}</b>: ${what} no 3D model. A zip must include one of ${SUPPORTED_EXT.map((e) => '.' + e).join(', ')}${seen.length ? ` (found: ${escapeHTML(seen.slice(0, 8).join(', '))}${seen.length > 8 ? '…' : ''})` : ' (it’s empty)'}. To add only pictures, use <b>Import Texture</b> in the Textures section. Nothing was loaded.`, 'error', 12000);
    }
    if (ignored.length) {
      toast(`Ignored ${ignored.length} unrelated file${ignored.length > 1 ? 's' : ''} in the zip${zips.length > 1 ? 's' : ''} (${escapeHTML(ignored.slice(0, 5).join(', '))}${ignored.length > 5 ? '…' : ''}).`, 'info', 6000);
    }
    // the same file name in two zips (e.g. a duplicate texture zip) — keep the first copy
    const seenNames = new Set(files.filter((f) => extOf(f.name) !== 'zip').map((f) => f.name.toLowerCase()));
    const merged = unpackedAll.filter((f) => { const k = f.name.toLowerCase(); if (seenNames.has(k)) return false; seenNames.add(k); return true; });
    files = files.filter((f) => extOf(f.name) !== 'zip').concat(merged);
    files.zipSource = modelZip || zips[0];
  }

  // ---- 2) pick the model and verify its contents match its extension ----
  const candidates = [];
  for (const p of LOAD_PRIORITY) files.filter((f) => extOf(f.name) === p).forEach((f) => candidates.push(f));

  // Only pictures dropped (no model)? They go into the texture library.
  const images = files.filter((f) => IMAGE_EXT.includes(extOf(f.name)));
  if (!candidates.length && !files.zipSource && images.length) {
    const others = files.filter((f) => !images.includes(f) && extOf(f.name) !== 'mtl');
    const { added, notes } = await importTextureFiles(images);
    if (added.length) {
      toast(`Added ${added.length} texture${added.length > 1 ? 's' : ''} to the library (Inspector → <b>Textures &amp; Images</b>)${notes.length ? ' — ' + notes.join(', ') : ''}. Select a part and click a thumbnail to apply it, or click <b>Place</b> to put it in the scene as a picture.`, 'success', 8000);
    }
    if (others.length) toast(`Not loaded (unsupported): <b>${escapeHTML(others.map((f) => f.name).join(', '))}</b>.`, 'warn', 6000);
    return;
  }
  const problems = [];
  const valid = [];
  for (const f of candidates.slice(0, 40)) {
    const why = await checkModelFile(f);
    if (!why) valid.push(f); else problems.push(`<b>${escapeHTML(f.name)}</b> — ${why}`);
  }
  if (candidates.length && !valid.length) {
    const src = files.zipSource ? `<b>${escapeHTML(files.zipSource.name)}</b> was rejected: ` : '';
    return toast(`${src}No valid 3D model found. ${problems.join('; ')}. Nothing was loaded.`, 'error', 11000);
  }
  if (problems.length) toast(`Skipped invalid file${problems.length > 1 ? 's' : ''}: ${problems.join('; ')}.`, 'warn', 8000);

  // One model per name: "chair.obj" + "chair.fbx" is the same model twice (keep the best format),
  // and "tree_LOD0 / tree_LOD1" are detail levels of one model (keep the most detailed).
  const groupKey = (f) => baseNameOf(f.name).toLowerCase().replace(/[_\-. ]?lod[_\-. ]?\d+$/i, '');
  const lodOf = (f) => { const m = baseNameOf(f.name).match(/lod[_\-. ]?(\d+)$/i); return m ? Number(m[1]) : -1; };
  const groups = new Map();
  for (const f of valid) {
    const k = groupKey(f);
    const cur = groups.get(k);
    const better = !cur || lodOf(f) < lodOf(cur) || (lodOf(f) === lodOf(cur) && LOAD_PRIORITY.indexOf(extOf(f.name)) < LOAD_PRIORITY.indexOf(extOf(cur.name)));
    if (better) groups.set(k, f);
  }
  const MAX_MODELS = 12;
  const models = [...groups.values()].slice(0, MAX_MODELS);
  if (groups.size > MAX_MODELS) toast(`This drop holds ${groups.size} models — loading the first ${MAX_MODELS}.`, 'warn', 7000);

  // glTF that points at separate .bin buffers can't work without them
  for (const g of models.filter((f) => extOf(f.name) === 'gltf' && f.size <= 300 * 1048576)) {
    try {
      const j = JSON.parse(await g.text());
      const names = new Set(files.map((f) => f.name.toLowerCase()));
      const missing = (j.buffers || []).map((b) => b.uri).filter((u) => u && !/^data:/i.test(u))
        .map((u) => decodeURIComponent(u.split(/[\\/]/).pop())).filter((u) => !names.has(u.toLowerCase()));
      if (missing.length) {
        return toast(`${files.zipSource ? `<b>${escapeHTML(files.zipSource.name)}</b> was rejected: ` : ''}<b>${escapeHTML(g.name)}</b> needs ${escapeHTML(missing.join(', '))}, which ${missing.length > 1 ? 'are' : 'is'} missing. Drop ${missing.length > 1 ? 'them' : 'it'} together with the .gltf (or zip them up together). Nothing was loaded.`, 'error', 11000);
      }
    } catch (e) { /* checked above */ }
  }

  if (!models.length) {
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

  // Map every dropped file by name. TGA images are converted to PNG up front (browsers can't show TGA);
  // the original bytes stay available for loaders that decode TGA themselves.
  const map = new Map();
  const freshURLs = [];
  for (const f of files) {
    const base = f.name.split(/[\\/]/).pop();
    const entry = { file: f, url: URL.createObjectURL(f) };
    freshURLs.push(entry.url);
    if (extOf(base) === 'tga') {
      try {
        const png = await tgaFileToPNG(f);
        entry.rawUrl = entry.url;
        entry.url = URL.createObjectURL(png);
        freshURLs.push(entry.url);
      } catch (e) { console.warn('[Online3D] could not decode TGA', base, e); }
    }
    map.set(base.toLowerCase(), entry);
  }

  const primary = models[0];
  state.originalFile = files.zipSource || primary;
  updateDownloadOriginal();
  // OBJ: warn (don't block) when its material file wasn't included
  for (const m of models.filter((f) => extOf(f.name) === 'obj')) {
    try {
      const head = strFromU8(await readHead(m, 1048576), true);
      const names = new Set(files.map((f) => f.name.toLowerCase()));
      const libs = [...head.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((x) => x[1].trim().split(/[\\/]/).pop());
      const anyMtl = files.some((f) => extOf(f.name) === 'mtl');
      const missingLibs = libs.filter((l) => !names.has(l.toLowerCase()));
      if (missingLibs.length && !anyMtl) toast(`<b>${escapeHTML(m.name)}</b> refers to <b>${escapeHTML(missingLibs.join(', '))}</b> (its colors/materials), which wasn’t included — it will load in plain grey. Drop the .mtl (and textures) together with the .obj to keep them.`, 'warn', 9000);
    } catch (e) {}
  }
  // A .blend dropped next to a loadable model is silently useless — say so instead of ignoring it
  const strayBlend = files.find((f) => extOf(f.name) === 'blend');
  if (strayBlend) {
    toast(`<b>${escapeHTML(strayBlend.name)}</b> (.blend) can’t be opened in-browser — loaded <b>${escapeHTML(primary.name)}</b> instead. To open the .blend, export it as GLB/OBJ from Blender (or use the bundled <b>blend2glb.py</b> script) first.`, 'warn', 9000);
  }
  if (isMobileLayout() && (files.zipSource || primary).size > 80 * 1048576 &&
      !window.confirm(`${(files.zipSource || primary).name} is ${fmtBytes((files.zipSource || primary).size)}. Very large models can make a phone's browser run out of memory and reload the page. Load it anyway?`)) return;
  setStatus('Loading…', true);

  let loaded = 0;
  const loadedInfo = [];
  try {
    for (const model of models) {
      setLoading(true, models.length > 1 ? `Loading ${model.name} (${loaded + 1} of ${models.length})…` : `Loading ${model.name}…`);
      const ctx = newImportCtx(map);
      try {
        const obj = await parseModel(model, ctx);
        const { wasEmpty, recs } = addToScene(obj, extOf(model.name).toUpperCase(), { name: baseNameOf(model.name), frame: 'always' });
        loaded++;
        const tris = recs.reduce((a, r) => a + meshTris(r), 0);
        if (models.length === 1) {
          toast(`${wasEmpty ? 'Loaded' : 'Added'} <b>${escapeHTML(model.name)}</b> — ${fmtInt(tris)} triangles, ${recs.length} part${recs.length !== 1 ? 's' : ''}.${wasEmpty ? '' : ' It was placed beside what’s already in the scene; use <b>New Scene</b> to start over.'}${ctx.droppedLines ? ` Ignored ${ctx.droppedLines} loose edge/point line${ctx.droppedLines > 1 ? 's' : ''} (not part of any surface).` : ''} Processed 100% locally; nothing was uploaded.`, 'success', 6000);
        }
        // textures load in the background — report any that couldn't be used once they're done
        const wait = waitForTextures(ctx).then(() => { reportTextureProblems(ctx, recs, model.name); collectModelTextures(); });
        loadedInfo.push({ name: model.name, recs, ctx, wait });
      } catch (err) {
        console.error('[Online3D] Load failed:', err);
        toast(`Failed to load <b>${escapeHTML(model.name)}</b>: ${escapeHTML((err && err.message) || String(err))}`, 'error', 9000);
      }
    }
    if (models.length > 1 && loaded) {
      toast(`Loaded <b>${loaded}</b> models from ${files.zipSource ? `<b>${escapeHTML(files.zipSource.name)}</b>` : 'your drop'}: ${escapeHTML(models.map((f) => f.name).join(', '))}. Each is a separate object in the Outliner.`, 'success', 7000);
    }
    if (loaded) sessionBlobURLs.push(...freshURLs); // the scene now owns these
    else { for (const u of freshURLs) { try { URL.revokeObjectURL(u); } catch (e) {} } setStatus('Error', false); }
  } finally {
    setLoading(false);
  }
  if (!loadedInfo.length) return;

  // Pictures in the drop that no material asked for (e.g. an OBJ without its .mtl): add them to the
  // texture library, then put them on the model by file name — or ask, when it isn't clear.
  await Promise.all(loadedInfo.map((i) => i.wait));
  const used = new Set(loadedInfo.flatMap((i) => [...i.ctx.used]));
  const spare = files.filter((f) => IMAGE_EXT.includes(extOf(f.name)) && !used.has(f.name.toLowerCase()));
  if (!spare.length) return;
  setLoading(true, `Preparing ${spare.length} texture${spare.length > 1 ? 's' : ''}…`);
  let added = [], notes = [];
  try { ({ added, notes } = await importTextureFiles(spare)); } finally { setLoading(false); }
  if (notes.length) toast(`Textures: ${notes.join('; ')}.`, 'info', 7000);
  if (!added.length) return;
  if (loadedInfo.length === 1) autoTextureModel(loadedInfo[0], added);
  else {
    // several models: each takes the sets whose name matches it
    for (const info of loadedInfo) {
      const mine = buildTextureSets(added).filter((st) => st.prefix && (materialSlots(info.recs).some((sl) => nameScore(st, sl) > 0) || alnum(info.name).includes(alnum(st.prefix))));
      if (mine.length) autoTextureModel(info, mine.flatMap((st) => [...Object.values(st.maps), ...st.unknown]));
    }
  }
}

/* Convert legacy (Phong / Lambert / Basic …) materials to PBR so the
   color, roughness, metallic and emission controls all work (OBJ/MTL, FBX, DAE). */
function toStandardMaterial(m, cache) {
  if (Array.isArray(m)) return m.map((x) => toStandardMaterial(x, cache));
  if (!m || m.isMeshStandardMaterial || m.isShaderMaterial || m.isPointsMaterial || m.isLineBasicMaterial) return m;
  if (cache && cache.has(m)) return cache.get(m);
  const p = {
    name: m.name,
    color: m.color ? m.color.clone() : new THREE.Color(0xb9c0d4),
    map: m.map || null,
    normalMap: m.normalMap || null,
    bumpMap: m.bumpMap || null,
    bumpScale: m.bumpScale ?? 1,
    alphaMap: m.alphaMap || null,
    aoMap: m.aoMap || null,
    emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0),
    emissiveMap: m.emissiveMap || null,
    emissiveIntensity: m.emissiveIntensity ?? 1,
    opacity: m.opacity ?? 1,
    transparent: !!m.transparent,
    alphaTest: m.alphaTest || 0,
    side: m.side ?? THREE.FrontSide,
    vertexColors: !!m.vertexColors,
    flatShading: !!m.flatShading,
    metalness: 0.05,
    roughness: m.isMeshPhongMaterial ? clamp(1 - Math.min((m.shininess ?? 30) / 100, 1) * 0.6, 0.25, 0.95) : 0.8,
  };
  if (m.normalScale) p.normalScale = m.normalScale.clone();
  const out = new THREE.MeshStandardMaterial(p);
  if (cache) cache.set(m, out);
  return out;
}

// Move a mesh's geometry so its local origin is at the geometry's bbox center, without moving it visually.
// Mutates geometry in place — only call on geometry that no history snapshot references.
function centerGeometryPivot(mesh) {
  const g = mesh.geometry;
  g.computeBoundingBox();
  if (!g.boundingBox || g.boundingBox.isEmpty()) return;
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  if (c.lengthSq() < 1e-14) return;
  g.translate(-c.x, -c.y, -c.z);
  mesh.position.add(c.multiply(mesh.scale).applyQuaternion(mesh.quaternion));
  mesh.updateMatrix();
}

const origTransforms = new WeakMap();
function rememberOrigTransform(o) {
  origTransforms.set(o, { pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.clone() });
}

// Shift an object by a world-space offset regardless of its parent's transform
function moveWorld(obj, delta) {
  const wp = obj.getWorldPosition(new THREE.Vector3()).add(delta);
  if (obj.parent) { obj.parent.updateWorldMatrix(true, false); obj.parent.worldToLocal(wp); }
  obj.position.copy(wp);
  obj.updateMatrixWorld(true);
}

// Copies also get their own texture *transform* (tiling / rotation / shift); the image itself stays shared.
function cloneMaterial(m) {
  if (Array.isArray(m)) return m.map(cloneMaterial);
  if (!m || !m.clone) return m;
  const c = m.clone();
  if (c.map && c.map.isTexture) c.map = c.map.clone();
  return c;
}

function recOf(mesh) { return state.meshes.find((r) => r.mesh === mesh) || null; }

// The object the gizmo & transform inputs act on: the selected part, or the whole model
function transformTarget() {
  if (!state.modelRoot) return null;
  if (!state.scope) return state.modelRoot;
  // moving a skinned (animated) mesh by itself does nothing — its skeleton drives it — so move its object
  if (state.scope.isSkinnedMesh) return topObjectOf(state.scope) || state.modelRoot;
  return state.scope;
}

// Is `node` the same as, or somewhere inside, `ancestor`?
function isInside(node, ancestor) {
  for (let o = node; o; o = o.parent) if (o === ancestor) return true;
  return false;
}
// The top-level object (direct child of the scene root) that contains `node`
function topObjectOf(node) {
  let o = node;
  while (o && o.parent && o.parent !== state.modelRoot) o = o.parent;
  return o && o.parent === state.modelRoot ? o : null;
}
function objectRecs(obj) { return state.meshes.filter((r) => isInside(r.mesh, obj)); }
function sceneNames() {
  const names = new Set(state.meshes.map((r) => r.mesh.name));
  if (state.modelRoot) state.modelRoot.children.forEach((c) => names.add(c.name));
  return names;
}
function uniqueName(base, taken = sceneNames()) {
  base = String(base || 'object').trim().slice(0, 80) || 'object';
  if (!taken.has(base)) return base;
  let k = 2;
  while (taken.has(`${base}_${k}`)) k++;
  return `${base}_${k}`;
}

// Move a group's origin to the center of its contents, without moving anything visually
function centerObjectPivot(obj) {
  if (obj.isMesh || obj.isPoints) return;
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const cl = obj.worldToLocal(box.getCenter(new THREE.Vector3()));
  if (cl.lengthSq() < 1e-14) return;
  for (const ch of obj.children) ch.position.sub(cl);
  obj.position.add(cl.multiply(obj.scale).applyQuaternion(obj.quaternion));
  obj.updateMatrixWorld(true);
}

// Prepare freshly-loaded content: strip lights/cameras, unique names, PBR materials, centered pivots.
function prepareObject(object, taken) {
  const strip = [];
  object.traverse((o) => { if (o.isLight || o.isCamera) strip.push(o); });
  strip.forEach((o) => o.parent && o.parent.remove(o));

  const found = [];
  object.traverse((o) => {
    if ((o.isMesh || o.isPoints) && o.geometry && o.geometry.getAttribute('position')) found.push(o);
  });
  const matCache = new Map();
  const centeredGeos = new Set();
  const recs = [];
  let idx = 0;
  for (const o of found) {
    const isPoints = !!o.isPoints;
    if (!isPoints && !o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
    if (o !== object) { // the object itself was already named by addToScene
      o.name = uniqueName(o.name || (isPoints ? 'points_' : 'mesh_') + (++idx), taken);
      taken.add(o.name);
    }
    // Instanced copies (GLB "GPU instancing") are display-only: re-centring their shared shape would
    // move every rotated/scaled copy to a different wrong place.
    const editable = !isPoints && !o.isSkinnedMesh && !o.isInstancedMesh && !o.isBatchedMesh &&
      !o.geometry.getAttribute('skinIndex') &&
      !(o.morphTargetInfluences && o.morphTargetInfluences.length);
    if (!isPoints) o.material = toStandardMaterial(o.material, matCache);
    // Give each editable part its own pivot at its center, so the gizmo sits ON the part
    // (OBJ parts all have their origin at the world origin otherwise).
    if (editable) {
      if (centeredGeos.has(o.geometry)) o.geometry = o.geometry.clone();
      centerGeometryPivot(o);
      centeredGeos.add(o.geometry);
    }
    recs.push({ mesh: o, baseMaterial: o.material, baseline: o.geometry, pct: 100, editable, isPoints });
  }
  return recs;
}

function ensureRoot() {
  if (state.modelRoot) return;
  clearModel(false);
  const root = new THREE.Group();
  root.name = 'Scene';
  scene.add(root);
  rememberOrigTransform(root);
  state.modelRoot = root;
  state.scope = null;
  state.activePreset = null;
}

/* Add loaded content or a shape to the scene. The first thing added starts a new scene;
   later additions are placed beside what's already there. */
function addToScene(object, format, opts = {}) {
  const wasEmpty = !state.modelRoot;
  const taken = wasEmpty ? new Set() : sceneNames();
  object.name = uniqueName(opts.name || object.name || 'object', taken);
  taken.add(object.name);
  const recs = prepareObject(object, taken);
  if (!recs.length) throw new Error('No renderable geometry found in this file.');
  centerObjectPivot(object);

  const sceneBox = wasEmpty ? null : new THREE.Box3().setFromObject(state.modelRoot);
  ensureRoot();
  if (wasEmpty) {
    state.baseName = opts.name || object.name;
    state.format = format;
  } else {
    state.format = 'SCENE';
  }
  state.modelRoot.add(object);
  state.modelRoot.updateMatrixWorld(true);

  // Placement
  const objBox = new THREE.Box3().setFromObject(object);
  if (!objBox.isEmpty()) {
    if (opts.place === 'floor') {
      // shapes: sit on the floor (y = 0) or on the scene's lowest point, beside existing content
      const floorY = sceneBox && !sceneBox.isEmpty() ? Math.min(sceneBox.min.y, 0) : 0;
      const d = new THREE.Vector3(0, floorY - objBox.min.y, 0);
      if (sceneBox && !sceneBox.isEmpty()) {
        const gap = objBox.getSize(new THREE.Vector3()).x * 0.4;
        d.x = sceneBox.max.x + gap - objBox.min.x;
        d.z = (sceneBox.min.z + sceneBox.max.z) / 2 - (objBox.min.z + objBox.max.z) / 2;
      } else {
        d.x = -(objBox.min.x + objBox.max.x) / 2;
        d.z = -(objBox.min.z + objBox.max.z) / 2;
      }
      moveWorld(object, d);
    } else if (sceneBox && !sceneBox.isEmpty()) {
      // imported models: put them to the right of what's already in the scene
      const gap = Math.max(sceneBox.getSize(new THREE.Vector3()).length(), objBox.getSize(new THREE.Vector3()).length()) * 0.08;
      moveWorld(object, new THREE.Vector3(
        sceneBox.max.x + gap - objBox.min.x,
        sceneBox.min.y - objBox.min.y,
        (sceneBox.min.z + sceneBox.max.z) / 2 - (objBox.min.z + objBox.max.z) / 2));
    }
  }
  object.traverse(rememberOrigTransform);
  state.meshes.push(...recs);

  // Scale point-cloud dot size relative to the object so PLY scans stay visible
  const radius = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere()).radius || 1;
  for (const rec of recs) {
    if (rec.isPoints && rec.mesh.material && rec.mesh.material.isPointsMaterial) {
      rec.mesh.material.size = radius * 0.01;
      rec.mesh.material.sizeAttenuation = true;
    }
  }

  if (wasEmpty || opts.frame === 'always') fitWorldToModel();
  else if (opts.frame === 'ifHidden' && !isInView(object)) fitWorldToModel();

  setViewMode(state.viewMode);
  setTool(state.tool, true);
  setScope(opts.select ? object : null);
  refreshStats();
  if (wasEmpty) historyReset(); else pushHistory();
  collectModelTextures();
  updateEmptyState();
  setStatus('Ready', true);
  // The drop box has done its job — get it out of the way (reopen from the left viewport toolbar)
  if (typeof setPanel === 'function' && ui.tray) setPanel('tray', false);
  return { wasEmpty, recs };
}

function isInView(obj) {
  activeCam.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(activeCam.projectionMatrix, activeCam.matrixWorldInverse));
  const box = new THREE.Box3().setFromObject(obj);
  return !box.isEmpty() && frustum.containsPoint(box.getCenter(new THREE.Vector3()));
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
  state.faceSel = null;
  if (typeof refreshFaceOverlay === 'function') { faceOverlay.visible = faceEdges.visible = false; }
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
    $('insp-scope-label').textContent = $('mat-scope-label').textContent = 'Whole Scene';
    updatePartButtons();
    dropModelTextures();
    syncTextureControls();
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
  const nObj = state.modelRoot.children.length;
  nameEl.textContent = nObj > 1 ? `${state.baseName || 'scene'} + ${nObj - 1} more` : (state.baseName || 'model') + (state.format && state.format !== 'SCENE' ? '.' + state.format.toLowerCase() : '');
  const s = modelStats();
  const sizeStr = nObj <= 1 && state.originalFile ? fmtBytes(state.originalFile.size) + ' • ' : '';
  metaEl.textContent = `${sizeStr}${nObj > 1 ? nObj + ' Objects • ' : ''}${fmtK(s.tris)} Tris • ${state.meshes.length} Meshes • ${state.viewMode.toUpperCase()}`;
}

function refreshStats() {
  if (typeof updateMobileInfo === 'function') updateMobileInfo();
  const s = modelStats();
  $('stat-tris-card').textContent = fmtInt(s.tris);
  $('stat-verts-card').textContent = fmtInt(s.verts);
  $('stat-meshes-card').textContent = String(s.meshes);
  const nObj = state.modelRoot ? state.modelRoot.children.length : 0;
  $('insp-model-name').textContent = state.modelRoot ? (nObj > 1 ? `Scene • ${nObj} objects` : (state.baseName || 'model')) : 'empty scene';
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

const outlinerOpen = new WeakMap(); // object -> expanded?

function buildOutliner() {
  const list = $('outliner-list');
  if (!list) return;
  list.innerHTML = '';
  const addRow = ({ label, icon, count, active, onclick, title, node, dim, depth = 0, chevron = null, onChevron = null, kind = 'part' }) => {
    const row = document.createElement('div');
    row.className = `group flex items-center rounded transition-all font-body-sm text-body-sm w-full ${active ? 'bg-primary-container text-on-primary-container font-medium' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'} ${dim ? 'opacity-50' : ''}`;
    if (depth) row.style.paddingLeft = depth * 14 + 'px';
    if (chevron != null) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'pl-1 py-2 shrink-0 text-outline hover:text-on-surface';
      c.title = chevron ? 'Collapse the list of parts' : 'Show the parts inside this object';
      c.innerHTML = `<span class="material-symbols-outlined text-base">${chevron ? 'expand_more' : 'chevron_right'}</span>`;
      c.addEventListener('click', (e) => { e.stopPropagation(); onChevron(); });
      row.appendChild(c);
    }
    const main = document.createElement('button');
    main.type = 'button';
    main.className = `flex-1 min-w-0 flex items-center gap-space-sm ${chevron != null ? 'pl-1' : 'pl-space-sm'} pr-space-sm py-2 text-left`;
    main.innerHTML = `<span class="material-symbols-outlined text-lg shrink-0">${icon}</span><span class="flex-1 truncate">${escapeHTML(label)}</span>` +
      (count != null ? `<span class="font-label-sm text-label-sm ${active ? 'text-on-primary-container/70' : 'text-outline'} shrink-0">${count}</span>` : '');
    if (title) main.title = title;
    if (onclick) main.addEventListener('click', onclick);
    row.appendChild(main);
    if (node) {
      main.addEventListener('dblclick', (e) => { e.preventDefault(); renamePart(node); });
      // touch: press and hold to rename
      let holdTimer = null, held = false;
      main.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        held = false;
        holdTimer = setTimeout(() => { held = true; renamePart(node); }, 550);
      });
      const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
      main.addEventListener('pointerup', cancelHold);
      main.addEventListener('pointerleave', cancelHold);
      main.addEventListener('pointercancel', cancelHold);
      main.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!held) { cancelHold(); renamePart(node); } });
      main.addEventListener('click', (e) => { if (held) { e.stopImmediatePropagation(); held = false; } }, true);
      const mk = (ic, tip, fn, extra = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `p-1 rounded shrink-0 hover:bg-black/20 ${extra}`;
        b.title = tip;
        b.innerHTML = `<span class="material-symbols-outlined text-base">${ic}</span>`;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        row.appendChild(b);
      };
      mk(node.visible ? 'visibility' : 'visibility_off', node.visible ? `Hide this ${kind}` : `Show this ${kind}`, () => toggleVisibility(node), node.visible ? 'opacity-60 group-hover:opacity-100' : '');
      mk('delete', `Delete this ${kind}`, () => { setScope(node); opDelete(); }, 'opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-300 mr-0.5');
    }
    list.appendChild(row);
    return row;
  };
  if (!state.modelRoot) {
    addRow({ label: 'Empty scene — add a shape or drop a model', icon: 'hourglass_empty' });
    return;
  }
  addRow({ label: 'Whole Scene', icon: 'view_in_ar', count: fmtK(modelStats().tris), active: state.scope === null, onclick: () => setScope(null), title: 'Select everything in the scene' });
  let activeRow = null;
  const partRow = (rec, depth) => {
    const row = addRow({
      label: rec.mesh.name || 'mesh',
      icon: rec.isPoints ? 'grain' : 'deployed_code',
      count: rec.isPoints ? fmtK(meshVerts(rec)) : fmtK(meshTris(rec)),
      active: state.scope === rec.mesh,
      onclick: () => setScope(rec.mesh),
      title: (rec.editable ? 'Click to select · double-click to rename' : 'Display-only geometry (skinned / points) · double-click to rename'),
      node: rec.mesh,
      dim: !rec.mesh.visible,
      depth,
    });
    if (state.scope === rec.mesh) activeRow = row;
  };
  for (const obj of state.modelRoot.children) {
    const recs = objectRecs(obj);
    const own = recOf(obj);
    if (own && recs.length === 1) { partRow(own, 0); continue; }   // a single shape / mesh
    if (!recs.length) continue;
    const scopeInside = state.scope && state.scope !== obj && isInside(state.scope, obj);
    let open = outlinerOpen.has(obj) ? outlinerOpen.get(obj) : recs.length <= 40;
    if (scopeInside && recs.length > 1) open = true;
    const multi = recs.length > 1;
    const row = addRow({
      label: obj.name || 'object',
      icon: 'category',
      count: fmtK(recs.reduce((a, r) => a + (r.isPoints ? 0 : meshTris(r)), 0)),
      active: state.scope === obj || (scopeInside && !multi),
      onclick: () => setScope(obj),
      title: `Object with ${recs.length} part${recs.length !== 1 ? 's' : ''} · click to select it all · double-click to rename`,
      node: obj,
      dim: !obj.visible,
      chevron: multi ? open : null,
      onChevron: () => { outlinerOpen.set(obj, !open); buildOutliner(); },
      kind: 'object',
    });
    if (state.scope === obj || (scopeInside && !multi)) activeRow = row;
    if (multi && open) recs.forEach((r) => partRow(r, 1));
  }
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
}

function scopeKind() {
  if (!state.scope) return 'scene';
  return recOf(state.scope) ? 'part' : 'object';
}

function setScope(node) {
  state.scope = node;
  const label = node ? (node.name || scopeKind()) : 'Whole Scene';
  $('insp-scope-label').textContent = label;
  $('mat-scope-label').textContent = label;
  $('insp-scope-label').title = $('mat-scope-label').title = label;
  if (state.faceSel && (!node || state.faceSel.rec.mesh !== node)) { state.faceSel = null; refreshFaceOverlay(); updateFacePanel(); }
  attachGizmo();
  buildOutliner();
  updateSelBox();
  syncTransformInputs();
  syncMaterialSliders();
  syncPolySliderUI();
  refreshStats();
  updatePartButtons();
  syncTextureControls();
  renderTexLibrary();
  updateMaterialScopeLabel();
}

function updatePartButtons() {
  const has = !!state.scope;
  ['btn-duplicate', 'btn-hide', 'btn-delete'].forEach((id) => {
    const b = $(id);
    b.classList.toggle('opacity-40', !has);
    b.title = b.title.replace(/ — select a part first$/, '') + (has ? '' : ' — select a part first');
  });
  const hideBtn = $('btn-hide');
  const hidden = has && !state.scope.visible;
  hideBtn.querySelector('.material-symbols-outlined').textContent = hidden ? 'visibility' : 'visibility_off';
  const lbl = hideBtn.querySelector('span:not(.material-symbols-outlined)');
  if (lbl) lbl.textContent = hidden ? 'Show' : 'Hide';
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
let selectHintShown = false;
let downPos = null;
let downOnGizmo = false;
canvas.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  downOnGizmo = !!(tc.object && tc.axis);
}, true);
canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5 || downOnGizmo || e.button !== 0 || !state.modelRoot) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, activeCam);
  const targets = state.meshes.filter((r) => !r.isPoints && r.mesh.visible).map((r) => r.mesh);
  const hits = raycaster.intersectObjects(targets, false);
  if (state.tool === 'faces') return onFaceClick(e, hits[0]);
  if (hits.length) {
    const hit = hits[0].object;
    const top = topObjectOf(hit) || hit;
    // First click picks the whole object; clicking it again drills down to the part you clicked.
    const next = (top === hit || (state.scope && isInside(state.scope, top))) ? hit : top;
    if (state.scope === next) return;
    setScope(next);
    if (!selectHintShown) {
      selectHintShown = true;
      const extra = state.meshes.length <= 1 ? ' This model is a single mesh — click <b>Split Parts</b> in the bottom toolbar to break it into separately editable pieces.' : '';
      const drill = next !== hit ? ' Click it again to pick just the part under the cursor.' : '';
      toast(`Selected <b>${escapeHTML(next.name || 'part')}</b>. Move / Rotate / Scale, color, Duplicate, Hide and Delete now act on it only.${drill} Esc steps back out; clicking empty space selects the whole scene.${extra}`, 'info', 8000);
    }
  } else if (state.scope) {
    setScope(null);
  }
});

/* ------------------------------------------------------------------ */
/* Tools & transform gizmo                                             */
/* ------------------------------------------------------------------ */

const TOOL_MODE = { select: null, move: 'translate', rotate: 'rotate', scale: 'scale', faces: null };
function setTool(tool, force) {
  if (!force && tool === state.tool) return;
  const was = state.tool;
  state.tool = tool;
  attachGizmo();
  if (tool === 'faces' || was === 'faces') {
    if (tool !== 'faces') state.faceSel = null;
    refreshFaceOverlay();
    updateFacePanel();
    updateMaterialScopeLabel();
    syncMaterialSliders();
    syncTextureControls();
    renderTexLibrary();
    if (tool === 'faces' && !faceHintShown && state.modelRoot) {
      faceHintShown = true;
      toast(isMobileLayout()
        ? '<b>Faces</b>: tap a face to select it — use <b>+ Add</b> / <b>− Remove</b> in the panel to build up a selection. <b>Flat area</b> picks a whole side at once. Then use the <b>Materials</b> tab — only those faces change.'
        : '<b>Faces</b>: click a face to select it (Shift adds, Alt removes). <b>Flat area</b> picks a whole side at once. Then change Color, Material presets or Textures in the Inspector — only those faces change.', 'info', 9000);
    }
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

function attachGizmo() {
  const target = transformTarget();
  if (target && TOOL_MODE[state.tool]) {
    if (tc.object !== target) tc.attach(target);
    tc.setMode(TOOL_MODE[state.tool]);
  } else {
    tc.detach();
  }
}

function syncTransformInputs() {
  if (typeof updateMobileInfo === 'function') updateMobileInfo();
  const r = transformTarget();
  if (!r) return;
  $('pos-x').value = r.position.x.toFixed(2);
  $('pos-y').value = r.position.y.toFixed(2);
  $('pos-z').value = r.position.z.toFixed(2);
  $('rot-x').value = THREE.MathUtils.radToDeg(r.rotation.x).toFixed(1) + '°';
  $('rot-y').value = THREE.MathUtils.radToDeg(r.rotation.y).toFixed(1) + '°';
  $('rot-z').value = THREE.MathUtils.radToDeg(r.rotation.z).toFixed(1) + '°';
  $('scl-x').value = r.scale.x.toFixed(2);
  $('scl-y').value = r.scale.y.toFixed(2);
  $('scl-z').value = r.scale.z.toFixed(2);
  const s = (Math.abs(r.scale.x) + Math.abs(r.scale.y) + Math.abs(r.scale.z)) / 3;
  $('scale-slider').value = Math.round(clamp(s, 0.1, 3) * 100);
  $('scale-display').textContent = s.toFixed(2) + 'x';
}

function commitTransformFromInputs() {
  const r = transformTarget();
  if (!r) return;
  const num = (v, d = 0) => { const n = parseFloat(String(v).replace(/[^0-9.eE+-]/g, '')); return isFinite(n) ? n : d; };
  const sc = (v) => { const n = num(v, 1); return Math.abs(n) < 1e-4 ? 1e-4 : n; };
  r.scale.set(sc($('scl-x').value), sc($('scl-y').value), sc($('scl-z').value));
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
  const target = transformTarget();
  if (target !== state.modelRoot) {
    const rec = recOf(target);
    if (!rec || rec.isPoints || !rec.editable) return toast('This part’s pivot can’t be changed (skinned / point geometry).', 'warn');
    const g = rec.mesh.geometry.clone(); // never mutate geometry that undo history references
    rec.mesh.geometry = g;
    centerGeometryPivot(rec.mesh);
    rec.baseline = g; rec.pct = 100;
    attachGizmo(); syncTransformInputs(); updateSelBox(); syncPolySliderUI(); pushHistory();
    return toast(`Pivot of <b>${escapeHTML(target.name)}</b> moved to its center — it now rotates & scales around itself.`, 'success', 3000);
  }
  const box = new THREE.Box3().setFromObject(state.modelRoot);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  state.modelRoot.position.sub(c);
  syncTransformInputs(); updateSelBox(); pushHistory();
  toast('Pivot centered — model origin is now at its bounding-box center.', 'success', 2600);
}
function groundToFloor() {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  const target = transformTarget();
  const box = new THREE.Box3().setFromObject(target);
  if (box.isEmpty()) return;
  moveWorld(target, new THREE.Vector3(0, -box.min.y, 0));
  syncTransformInputs(); updateSelBox(); pushHistory();
  toast(target === state.modelRoot ? 'Grounded — the model now sits on the grid (y = 0).' : `Grounded <b>${escapeHTML(target.name)}</b> onto the grid (y = 0).`, 'success', 2600);
}

/* ------------------------------------------------------------------ */
/* Material editing                                                    */
/* ------------------------------------------------------------------ */

function scopeRecs() { return state.scope ? state.meshes.filter((r) => isInside(r.mesh, state.scope)) : state.meshes; }
function scopeEditableRecs() { return scopeRecs().filter((r) => r.editable && !r.isPoints); }
function scopeStats() {
  let tris = 0, verts = 0;
  for (const r of scopeRecs()) { tris += meshTris(r); verts += meshVerts(r); }
  return { tris, verts };
}
function scopeName() { return state.scope ? (state.scope.name || scopeKind()) : 'the whole scene'; }

// Materials are often shared between parts (OBJ/MTL, glTF). Before editing a single part,
// give it its own copy so the change doesn't leak onto other parts.
function makeScopeMaterialsUnique() {
  if (!state.scope) return;
  const inside = scopeRecs().filter((r) => !r.isPoints);
  if (!inside.length) return;
  const insideSet = new Set(inside);
  const asList = (m) => (Array.isArray(m) ? m : [m]);
  const usedOutside = new Set();
  for (const r of state.meshes) if (!insideSet.has(r)) asList(r.baseMaterial).forEach((m) => usedOutside.add(m));
  const copies = new Map(); // keep sharing *within* the selection
  const swap = (m) => {
    if (!m || !usedOutside.has(m)) return m;
    if (!copies.has(m)) copies.set(m, m.clone());
    return copies.get(m);
  };
  for (const rec of inside) {
    const next = Array.isArray(rec.baseMaterial) ? rec.baseMaterial.map(swap) : swap(rec.baseMaterial);
    const changed = Array.isArray(next) ? next.some((m, i) => m !== rec.baseMaterial[i]) : next !== rec.baseMaterial;
    if (!changed) continue;
    rec.baseMaterial = next;
    if (state.viewMode === 'pbr') rec.mesh.material = rec.baseMaterial;
  }
}

function eachScopeMaterial(fn) {
  const fm = faceMaterials();
  if (fm) { fm.forEach((m) => m && fn(m)); return fm.length; }
  makeScopeMaterialsUnique();
  let touched = 0;
  for (const rec of scopeRecs()) {
    if (rec.isPoints) continue;
    const mats = Array.isArray(rec.baseMaterial) ? rec.baseMaterial : [rec.baseMaterial];
    for (const m of mats) { if (m) { fn(m); touched++; } }
  }
  return touched;
}

function applyColor(hex) {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  if (state.viewMode !== 'pbr') setViewMode('pbr');
  eachScopeMaterial((m) => { if (m.color) { m.color.set(hex); m.needsUpdate = true; } });
  state.activePreset = null;
  updatePresetChips();
  $('mat-color').value = hex;
  $('mat-color-hex').value = hex;
}

function applyOpacity(v) {
  if (!state.modelRoot) return;
  if (state.viewMode !== 'pbr') setViewMode('pbr');
  eachScopeMaterial((m) => {
    m.opacity = v;
    m.transparent = v < 1;
    m.depthWrite = v >= 1;
    m.needsUpdate = true;
  });
}

function removeTextures() {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  let n = 0;
  eachScopeMaterial((m) => { if (m.map) { m.map = null; m.needsUpdate = true; n++; } });
  if (n) { if (state.viewMode !== 'pbr') setViewMode('pbr'); syncTextureControls(); renderTexLibrary(); pushHistory(); toast(`Removed the color texture from ${scopeName()} — the plain color is now visible.`, 'success', 3000); }
  else toast(`${scopeName()} has no color texture.`, 'info', 2400);
}

function eachScopePBRMaterial(fn) {
  const fm = faceMaterials();
  if (fm) { let n = 0; fm.forEach((m) => { if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) { fn(m); n++; } }); return n; }
  makeScopeMaterialsUnique();
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
  const fm = faceMaterials();
  if (fm) {
    // swap only the selected faces' materials
    const rec = state.faceSel.rec;
    const mats = [].concat(rec.baseMaterial);
    state.faceSel.materials = fm.map((old) => {
      const nm = p.make();
      if (old && old.map) nm.map = old.map; // keep a texture already on these faces
      const i = mats.indexOf(old);
      if (i >= 0) mats[i] = nm;
      return nm;
    });
    rec.baseMaterial = mats.length > 1 ? mats : mats[0];
  } else {
    for (const rec of recs) rec.baseMaterial = p.make();
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
  let m = faceDisplayMaterial();
  if (!m) for (const rec of scopeRecs()) {
    const mats = Array.isArray(rec.baseMaterial) ? rec.baseMaterial : [rec.baseMaterial];
    m = mats.find((x) => x && (x.isMeshStandardMaterial || x.isMeshPhysicalMaterial)) || m;
    if (m) break;
  }
  if (!m) return;
  if (m.color) {
    const hex = '#' + m.color.getHexString();
    $('mat-color').value = hex;
    $('mat-color-hex').value = hex;
  }
  $('slider-opacity').value = Math.round(clamp(m.opacity ?? 1, 0.05, 1) * 100);
  $('val-opacity').textContent = (m.opacity ?? 1).toFixed(2);
  const set = (sliderId, valId, v) => {
    const s = $(sliderId); s.value = Math.round(clamp(v, 0, 1) * 100);
    $(valId).textContent = (s.value / 100).toFixed(2);
  };
  set('slider-rough', 'val-rough', m.roughness ?? 0.5);
  set('slider-metal', 'val-metal', m.metalness ?? 0);
  const glowing = m.emissive && m.emissive.getHex() !== 0;
  set('slider-emis', 'val-emis', glowing ? (m.emissiveIntensity ?? 0) / 2 : 0);
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
    for (const grp of g.groups) geo.addGroup(grp.start * 4, grp.count * 4, grp.materialIndex); // each triangle became 4, in order
    return geo;
  } catch (e) {
    console.warn('[Online3D] subdivide failed:', e);
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
    const srcMat = g.groups && g.groups.length ? triMaterials(g) : null;
    const outMat = [];
    for (let t = 0; t < triCount; t++) {
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      const ka = keyOf(cc, a, G), kb = keyOf(cc, b, G), kc = keyOf(cc, c, G);
      if (ka === kb || kb === kc || ka === kc) continue;
      const loK = Math.min(ka, kb, kc), hiK = Math.max(ka, kb, kc), miK = ka + kb + kc - loK - hiK;
      const fk = loK + '_' + miK + '_' + hiK;
      if (faceSeen.has(fk)) continue;
      faceSeen.add(fk);
      outIdx.push(newIndexOf(repOf(ka, a)), newIndexOf(repOf(kb, b)), newIndexOf(repOf(kc, c)));
      if (srcMat) outMat.push(srcMat[t]);
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
    if (srcMat) {
      // keep per-face materials: order the triangles by material and rebuild the groups
      const n = outMat.length, order = [...Array(n).keys()].sort((x, y) => outMat[x] - outMat[y] || x - y);
      const sorted = [];
      for (const i of order) sorted.push(outIdx[3 * i], outIdx[3 * i + 1], outIdx[3 * i + 2]);
      geo.setIndex(sorted);
      let start = 0;
      for (let i = 1; i <= n; i++) {
        if (i === n || outMat[order[i]] !== outMat[order[start]]) {
          if (outMat[order[start]] >= 0) geo.addGroup(start * 3, (i - start) * 3, outMat[order[start]]);
          start = i;
        }
      }
    } else {
      geo.setIndex(outIdx);
    }
    geo.computeVertexNormals();
    return geo;
  } catch (e) {
    console.warn('[Online3D] decimate failed:', e);
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
    console.warn('[Online3D] mirror failed:', e);
    return null;
  }
}

function setRecGeometry(rec, g) {
  rec.mesh.geometry = g;
  rec.baseline = g;
  rec.pct = 100;
}

function afterGeometryOp(msg) {
  if (state.faceSel && state.faceSel.set.size) clearFaceSelection(); // triangle numbering changed
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
      ? 'This part can’t be edited (skinned / point geometry). Select another part or “Whole Scene”.'
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
    if (state.faceSel && state.faceSel.set.size) clearFaceSelection();
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
/* Part operations: delete / duplicate / hide / rename / split         */
/* ------------------------------------------------------------------ */

function requirePart(action) {
  if (!state.modelRoot) { toast('The scene is empty — add a shape or drop a model first.', 'warn'); return null; }
  if (!state.scope) {
    toast(`Select something first to ${action} it — click it in the viewport or in the Outliner (left panel).` +
      (state.meshes.length <= 1 ? ' This model is one single mesh: use <b>Split Parts</b> to break it into pieces.' : ''), 'warn', 6000);
    return null;
  }
  return state.scope;
}

function uniquePartName(base) { return uniqueName(base); }

// Remove empty groups left behind after a delete (never the scene root itself)
function pruneEmpty(node) {
  while (node && node !== state.modelRoot && node.parent && !objectRecs(node).length) {
    const p = node.parent;
    p.remove(node);
    node = p;
  }
}

function opDelete() {
  const node = requirePart('delete');
  if (!node) return;
  const gone = scopeRecs();
  if (gone.length >= state.meshes.length) return toast('That would leave the scene empty — use <b>New Scene</b> in the header to clear everything.', 'warn', 5000);
  const name = node.name;
  const parent = node.parent;
  if (parent) parent.remove(node);
  const goneSet = new Set(gone);
  state.meshes = state.meshes.filter((r) => !goneSet.has(r));
  pruneEmpty(parent);
  setScope(null);
  refreshStats();
  pushHistory();
  toast(`Deleted <b>${escapeHTML(name)}</b>. Press <b>Ctrl+Z</b> to undo.`, 'success', 3500);
}

function opDuplicate() {
  const src = requirePart('duplicate');
  if (!src) return;
  const srcRecs = scopeRecs();
  let copy;
  if (recOf(src)) {
    if (src.isSkinnedMesh) return toast('Animated (skinned) parts can’t be duplicated on their own — select the whole object instead.', 'warn', 5000);
    copy = src.clone(false);
  } else {
    copy = SkeletonUtils.clone(src); // handles skinned meshes & skeletons
  }
  // pair up original and copied meshes (same tree shape) to build records with their own materials
  const a = [], b = [];
  src.traverse((o) => a.push(o));
  copy.traverse((o) => b.push(o));
  const taken = sceneNames();
  const newRecs = [];
  a.forEach((o, i) => {
    const rec = srcRecs.find((r) => r.mesh === o);
    if (!rec || !b[i]) return;
    const m = b[i];
    m.material = cloneMaterial(rec.baseMaterial);
    if (m !== copy) { m.name = uniqueName(o.name + '_copy', taken); taken.add(m.name); }
    newRecs.push({ mesh: m, baseMaterial: m.material, baseline: rec.baseline, pct: rec.pct, editable: rec.editable, isPoints: rec.isPoints });
  });
  copy.name = uniqueName(src.name + '_copy', taken);
  src.parent.add(copy);
  // offset the copy sideways by ~its own width so it doesn't overlap the original
  const size = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
  moveWorld(copy, new THREE.Vector3(Math.max(size.x * 1.1, (state.modelRadius || 1) * 0.05), 0, 0));
  copy.traverse(rememberOrigTransform);
  state.meshes.push(...newRecs);
  setViewMode(state.viewMode);
  setScope(copy);
  refreshStats();
  pushHistory();
  toast(`Duplicated as <b>${escapeHTML(copy.name)}</b> — it’s selected, drag the gizmo to place it.`, 'success', 3500);
}

function toggleVisibility(node) {
  if (!node) { node = requirePart('hide'); if (!node) return; }
  node.visible = !node.visible;
  buildOutliner();
  updatePartButtons();
  updateSelBox();
  pushHistory();
  toast(`${node.visible ? 'Showing' : 'Hid'} <b>${escapeHTML(node.name)}</b>${node.visible ? '' : ' — hidden things are left out of exports. Click the eye in the Outliner to show it again.'}`, 'info', 3200);
}

function renamePart(mesh) {
  const name = window.prompt('Rename:', mesh.name);
  if (name == null) return;
  const clean = name.trim().slice(0, 80);
  if (!clean || clean === mesh.name) return;
  mesh.name = uniquePartName(clean);
  setScope(state.scope);
  pushHistory();
}

/* Split a geometry by material group and by connected (touching) pieces.
   Returns [{ geometry, materialIndex }] — or null if it is already a single piece. */
const MAX_SPLIT_PARTS = 200;
function splitGeometry(src) {
  const pos = src.getAttribute('position');
  const vc = pos.count;
  const idx = src.index ? src.index.array : null;
  const n = idx ? idx.length : vc;
  const vAt = idx ? (i) => idx[i] : (i) => i;

  // weld vertices by (quantized) position so UV / normal seams don't split a piece
  const tol = tolOf(src) * 10;
  const keyIds = new Int32Array(vc);
  const keyMap = new Map();
  for (let i = 0; i < vc; i++) {
    const k = Math.round(pos.getX(i) / tol) + '_' + Math.round(pos.getY(i) / tol) + '_' + Math.round(pos.getZ(i) / tol);
    let id = keyMap.get(k);
    if (id === undefined) { id = keyMap.size; keyMap.set(k, id); }
    keyIds[i] = id;
  }
  const parent = new Int32Array(keyMap.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t + 2 < n; t += 3) {
    const a = find(keyIds[vAt(t)]), b = find(keyIds[vAt(t + 1)]), c = find(keyIds[vAt(t + 2)]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== find(c)) parent[find(c)] = a2;
  }

  const groups = src.groups && src.groups.length ? src.groups : [{ start: 0, count: n, materialIndex: 0 }];
  let buckets = []; // {materialIndex, tris: []}
  for (const grp of groups) {
    const byRoot = new Map();
    const end = Math.min(grp.start + grp.count, n);
    for (let t = grp.start; t + 2 < end; t += 3) {
      const r = find(keyIds[vAt(t)]);
      let b = byRoot.get(r);
      if (!b) { b = { materialIndex: grp.materialIndex || 0, tris: [] }; byRoot.set(r, b); }
      b.tris.push(t);
    }
    buckets.push(...byRoot.values());
  }
  if (buckets.length <= 1) return null;
  buckets.sort((a, b) => b.tris.length - a.tris.length);
  if (buckets.length > MAX_SPLIT_PARTS) {
    // keep the biggest pieces separate; lump the tiny leftovers together per material
    const rest = buckets.slice(MAX_SPLIT_PARTS - 1);
    buckets = buckets.slice(0, MAX_SPLIT_PARTS - 1);
    const lump = new Map();
    for (const b of rest) {
      let l = lump.get(b.materialIndex);
      if (!l) { l = { materialIndex: b.materialIndex, tris: [], lumped: true }; lump.set(b.materialIndex, l); }
      l.tris.push(...b.tris);
    }
    buckets.push(...lump.values());
  }

  const attrNames = Object.keys(src.attributes);
  const remap = new Int32Array(vc).fill(-1);
  return buckets.map((b) => {
    const used = [];
    const outIdx = new Uint32Array(b.tris.length * 3);
    let w = 0;
    for (const t of b.tris) {
      for (let k = 0; k < 3; k++) {
        const v = vAt(t + k);
        if (remap[v] < 0) { remap[v] = used.length; used.push(v); }
        outIdx[w++] = remap[v];
      }
    }
    const geo = new THREE.BufferGeometry();
    for (const name of attrNames) {
      const attr = src.attributes[name];
      const item = attr.itemSize;
      const out = new Float32Array(used.length * item);
      for (let i = 0; i < used.length; i++) {
        const v = used[i];
        out[i * item] = attr.getX(v);
        if (item > 1) out[i * item + 1] = attr.getY(v);
        if (item > 2) out[i * item + 2] = attr.getZ(v);
        if (item > 3) out[i * item + 3] = attr.getW(v);
      }
      geo.setAttribute(name, new THREE.BufferAttribute(out, item));
    }
    geo.setIndex(new THREE.BufferAttribute(outIdx, 1));
    for (const v of used) remap[v] = -1;
    return { geometry: geo, materialIndex: b.materialIndex, lumped: !!b.lumped };
  });
}

function opSplit() {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  const recs = scopeRecs().filter((r) => r.editable && !r.isPoints);
  if (!recs.length) return toast('Nothing to split here (skinned / point geometry can’t be split).', 'warn');
  setLoading(true, 'Splitting into parts…');
  setTimeout(() => {
    try {
      let created = 0, splitCount = 0, lumped = false, lastSplitObject = null;
      for (const rec of recs) {
        const parts = splitGeometry(rec.mesh.geometry);
        if (!parts) continue;
        const src = rec.mesh;
        let parent = src.parent;
        let wrapper = null;
        if (parent === state.modelRoot) {
          // a stand-alone shape: keep its pieces together as one object
          wrapper = new THREE.Group();
          wrapper.visible = src.visible;
          parent.add(wrapper);
          parent = wrapper;
        }
        const mats = Array.isArray(rec.baseMaterial) ? rec.baseMaterial : [rec.baseMaterial];
        const newRecs = parts.map((part, i) => {
          const mat = cloneMaterial(mats[part.materialIndex] || mats[0]);
          const m = new THREE.Mesh(part.geometry, mat);
          const matName = mat && mat.name ? mat.name : '';
          m.name = uniquePartName(`${src.name}_${part.lumped ? 'small_bits' : (matName && parts.length < 30 ? matName : 'part' + (i + 1))}`);
          m.position.copy(src.position); m.quaternion.copy(src.quaternion); m.scale.copy(src.scale);
          m.visible = wrapper ? true : src.visible;
          centerGeometryPivot(m);
          rememberOrigTransform(m);
          parent.add(m);
          if (part.lumped) lumped = true;
          return { mesh: m, baseMaterial: mat, baseline: part.geometry, pct: 100, editable: true, isPoints: false };
        });
        src.parent.remove(src);
        if (wrapper) {
          wrapper.name = uniqueName(src.name);
          centerObjectPivot(wrapper);
          rememberOrigTransform(wrapper);
        }
        lastSplitObject = topObjectOf(newRecs[0].mesh);
        const at = state.meshes.indexOf(rec);
        state.meshes.splice(at, 1, ...newRecs);
        created += newRecs.length;
        splitCount++;
      }
      if (!splitCount) {
        toast(`${state.scope ? '<b>' + escapeHTML(scopeName()) + '</b> is' : 'Every mesh is'} already a single connected piece with one material — nothing to split.`, 'info', 5000);
        return;
      }
      setViewMode(state.viewMode);
      setScope(splitCount === 1 ? lastSplitObject : null);
      refreshStats();
      pushHistory();
      toast(`Split into <b>${created}</b> separate parts${lumped ? ` (tiny fragments grouped as “small_bits”)` : ''}. Click any part to select it, then move, recolor, hide or delete it. Ctrl+Z to undo.`, 'success', 7000);
    } catch (e) {
      console.error('[Online3D] split failed:', e);
      toast('Split failed: ' + escapeHTML(e.message || String(e)), 'error');
    } finally {
      setLoading(false);
    }
  }, 30);
}

/* ------------------------------------------------------------------ */
/* Undo / redo                                                         */
/* ------------------------------------------------------------------ */

function historySnapshot() {
  const nodes = [];
  state.modelRoot.traverse((o) => {
    if (o === state.modelRoot) return;
    nodes.push({ node: o, parent: o.parent, name: o.name, visible: o.visible, pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.clone() });
  });
  return {
    pos: state.modelRoot.position.clone(),
    quat: state.modelRoot.quaternion.clone(),
    scale: state.modelRoot.scale.clone(),
    scope: state.scope,
    baseName: state.baseName,
    format: state.format,
    nodes,
    recs: state.meshes.map((r) => ({
      mesh: r.mesh,
      material: cloneMaterial(r.baseMaterial),
      geometry: r.mesh.geometry,
      baseline: r.baseline,
      pct: r.pct,
      editable: r.editable,
      isPoints: r.isPoints,
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
  const root = state.modelRoot;
  root.position.copy(s.pos);
  root.quaternion.copy(s.quat);
  root.scale.copy(s.scale);
  state.baseName = s.baseName;
  state.format = s.format;
  // 1) take out anything that didn't exist at that point (e.g. undoing an add / duplicate / split)
  const keep = new Set(s.nodes.map((n) => n.node));
  const current = [];
  root.traverse((o) => { if (o !== root) current.push(o); });
  for (const o of current) if (!keep.has(o) && o.parent) o.parent.remove(o);
  // 2) put everything back where it was (re-attaches deleted things), parents before children
  for (const n of s.nodes) {
    if (n.node.parent !== n.parent) n.parent.add(n.node);
    n.node.name = n.name;
    n.node.visible = n.visible;
    n.node.position.copy(n.pos);
    n.node.quaternion.copy(n.quat);
    n.node.scale.copy(n.scale);
  }
  state.meshes = s.recs.map((r) => {
    r.mesh.geometry = r.geometry;
    // clone again so later edits never mutate the stored snapshot
    return { mesh: r.mesh, baseMaterial: cloneMaterial(r.material), baseline: r.baseline, pct: r.pct, editable: r.editable, isPoints: r.isPoints };
  });
  state.scope = s.scope && keep.has(s.scope) ? s.scope : null;
  if (state.faceSel) { state.faceSel.set = new Set(); state.faceSel.materials = null; }
  setViewMode(state.viewMode);
  setScope(state.scope);
  afterFaceSelectionChange();
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

async function doExport(opts = {}) {
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
  // Hidden parts are left out of the export
  const hidden = [];
  state.modelRoot.traverse((o) => { if (o !== state.modelRoot && !o.visible && o.parent) hidden.push([o, o.parent]); });
  hidden.forEach(([m, p]) => p.remove(m));
  try {
    let blob, name;
    if (fmt === 'obj' && $('chk-obj-zip').checked) {
      label.textContent = 'Packing .zip…';
      const base = safeFileName(state.baseName) + '_edited';
      const res = await buildOBJZip(state.modelRoot, base);
      blob = new Blob([res.zipped], { type: 'application/zip' });
      name = `${base}.zip`;
      if (res.skipped.length) toast(`Some textures couldn’t be converted to PNG and were left out (${escapeHTML(res.skipped.slice(0, 4).join(', '))}). Use GLB to keep them.`, 'warn', 7000);
    } else if (fmt === 'obj') {
      const text = new OBJExporter().parse(state.modelRoot);
      blob = new Blob([text], { type: 'text/plain' });
      name = `${state.baseName}_edited.obj`;
    } else if (fmt === 'glb') {
      const result = await new Promise((resolve, reject) =>
        new GLTFExporter().parse(state.modelRoot, resolve, reject, { binary: true, onlyVisible: true }));
      blob = new Blob([result], { type: 'model/gltf-binary' });
      name = `${state.baseName}_edited.glb`;
    } else if (fmt === 'stl') {
      const dv = new STLExporter().parse(state.modelRoot, { binary: true });
      blob = new Blob([dv], { type: 'application/octet-stream' });
      name = `${state.baseName}_edited.stl`;
    } else {
      throw new Error('Unknown format');
    }
    if (blob && opts.share) {
      label.textContent = 'Sharing…';
      const shared = await shareBlob(blob, name);
      label.textContent = shared ? 'Shared!' : 'Export Ready!';
    } else if (blob) {
      saveBlob(blob, name);
      label.textContent = 'Export Ready!';
      toast(`Exported <b>${escapeHTML(name)}</b> (${fmtBytes(blob.size)}) — all edits baked in. Check your downloads.`, 'success', 5000);
    }
  } catch (err) {
    console.error('[Online3D] export failed:', err);
    toast(`Export failed: ${escapeHTML((err && err.message) || String(err))}`, 'error', 7000);
  } finally {
    hidden.reverse().forEach(([m, p]) => p.add(m));
    btn.disabled = false;
    setTimeout(updateDownloadLabel, 1200);
  }
}

// Send a file through the phone's share sheet; falls back to a normal download
async function shareBlob(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false; // user closed the share sheet
    console.warn('[Online3D] share failed, downloading instead:', e);
  }
  saveBlob(blob, name);
  toast(`Sharing isn’t available here — <b>${escapeHTML(name)}</b> was downloaded instead.`, 'info', 4500);
  return false;
}

/* ---------- OBJ + MTL + textures, zipped ----------
   three's OBJExporter writes shape only, so this writer adds usemtl / mtllib and the texture images. */

const safeFileName = (s) => String(s || 'item').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'item';

async function textureToPNG(tex) {
  const img = tex && tex.image;
  if (!img) return null;
  const w = img.width || img.videoWidth, h = img.height || img.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (img.data && !(img instanceof HTMLImageElement)) {
    // DataTexture (raw RGBA bytes)
    if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length !== w * h * 4) return null;
    g.putImageData(new ImageData(new Uint8ClampedArray(img.data), w, h), 0, 0);
  } else {
    try { g.drawImage(img, 0, 0, w, h); } catch (e) { return null; }
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

async function buildOBJZip(root, baseName) {
  const fmt = (n) => (Math.abs(n) < 1e-10 ? '0' : +n.toFixed(6) + '');
  const matName = new Map(), usedMat = new Set();
  const texName = new Map(), usedTex = new Set();
  const files = {};
  const skipped = [];
  let obj = `# Exported by Online 3D Studio\nmtllib ${baseName}.mtl\n`;
  let mtl = `# Exported by Online 3D Studio\n`;
  let vOff = 1, tOff = 1, nOff = 1;

  const nameMat = (m) => {
    if (matName.has(m)) return matName.get(m);
    let n = safeFileName(m && m.name ? m.name : 'material'); let k = 2, b = n;
    while (usedMat.has(n)) n = `${b}_${k++}`;
    usedMat.add(n); matName.set(m, n);
    return n;
  };
  const addTex = async (tex, hint) => {
    if (!tex || !tex.image) return null;
    if (texName.has(tex.image)) return texName.get(tex.image);
    const png = await textureToPNG(tex);
    if (!png) { skipped.push(hint); texName.set(tex.image, null); return null; }
    let n = safeFileName(tex.name || hint); let k = 2, b = n;
    while (usedTex.has(n)) n = `${b}_${k++}`;
    usedTex.add(n);
    const path = `textures/${n}.png`;
    files[path] = [png, { level: 0 }]; // PNGs are already compressed
    texName.set(tex.image, path);
    return path;
  };

  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.getAttribute('position')) meshes.push(o); });
  const v = new THREE.Vector3(), nrm = new THREE.Vector3(), col = new THREE.Color(), nm = new THREE.Matrix3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position'), normal = g.getAttribute('normal'), uv = g.getAttribute('uv'), color = g.getAttribute('color');
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const flipV = mats.some((m) => m && m.map && m.map.flipY === false); // glTF-style UVs
    nm.getNormalMatrix(mesh.matrixWorld);
    const mirrored = mesh.matrixWorld.determinant() < 0;
    obj += `o ${safeFileName(mesh.name)}\n`;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      obj += `v ${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)}`;
      if (color) { col.fromBufferAttribute(color, i).convertLinearToSRGB(); obj += ` ${fmt(col.r)} ${fmt(col.g)} ${fmt(col.b)}`; }
      obj += '\n';
    }
    if (uv) for (let i = 0; i < uv.count; i++) obj += `vt ${fmt(uv.getX(i))} ${fmt(flipV ? 1 - uv.getY(i) : uv.getY(i))}\n`;
    if (normal) for (let i = 0; i < normal.count; i++) { nrm.fromBufferAttribute(normal, i).applyMatrix3(nm).normalize(); obj += `vn ${fmt(nrm.x)} ${fmt(nrm.y)} ${fmt(nrm.z)}\n`; }
    const idx = g.index ? g.index.array : null;
    const count = idx ? idx.length : pos.count;
    const groups = g.groups && g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    const ref = (i) => {
      const a = (idx ? idx[i] : i);
      const pv = a + vOff, pt = a + tOff, pn = a + nOff;
      return uv && normal ? `${pv}/${pt}/${pn}` : normal ? `${pv}//${pn}` : uv ? `${pv}/${pt}` : `${pv}`;
    };
    let lastMat;
    for (const grp of groups) {
      const m = mats[grp.materialIndex || 0] || mats[0];
      if (m !== lastMat) { obj += `usemtl ${nameMat(m)}\n`; lastMat = m; }
      const end = Math.min(grp.start + grp.count, count);
      for (let t = grp.start; t + 2 < end; t += 3) {
        obj += mirrored ? `f ${ref(t)} ${ref(t + 2)} ${ref(t + 1)}\n` : `f ${ref(t)} ${ref(t + 1)} ${ref(t + 2)}\n`;
      }
    }
    vOff += pos.count; if (uv) tOff += uv.count; if (normal) nOff += normal.count;
  }

  for (const [m, n] of matName) {
    mtl += `\nnewmtl ${n}\n`;
    const c = m && m.color ? m.color.clone().convertLinearToSRGB() : new THREE.Color(0.8, 0.8, 0.8);
    mtl += `Ka 0 0 0\nKd ${fmt(c.r)} ${fmt(c.g)} ${fmt(c.b)}\n`;
    const rough = m && m.roughness != null ? m.roughness : 0.8;
    const metal = m && m.metalness != null ? m.metalness : 0;
    const spec = 0.04 + metal * 0.5 * (1 - rough);
    mtl += `Ks ${fmt(spec)} ${fmt(spec)} ${fmt(spec)}\nNs ${Math.round((1 - rough) * (1 - rough) * 900 + 4)}\n`;
    if (m && m.emissive && m.emissive.getHex() !== 0) {
      const e = m.emissive.clone().multiplyScalar(Math.min(m.emissiveIntensity ?? 1, 1)).convertLinearToSRGB();
      mtl += `Ke ${fmt(e.r)} ${fmt(e.g)} ${fmt(e.b)}\n`;
    }
    mtl += `d ${fmt(m && m.opacity != null ? m.opacity : 1)}\nillum 2\n`;
    mtl += `Pr ${fmt(rough)}\nPm ${fmt(metal)}\n`;
    if (m) {
      const kd = await addTex(m.map, n + '_color');
      if (kd) {
        const t = m.map;
        const opts = (t.repeat.x !== 1 || t.repeat.y !== 1 ? `-s ${fmt(t.repeat.x)} ${fmt(t.repeat.y)} 1 ` : '') +
          (t.offset.x || t.offset.y ? `-o ${fmt(t.offset.x)} ${fmt(t.offset.y)} 0 ` : '');
        mtl += `map_Kd ${opts}${kd}\n`;
      }
      const nmap = await addTex(m.normalMap, n + '_normal'); if (nmap) mtl += `norm ${nmap}\n`;
      const bump = await addTex(m.bumpMap, n + '_bump'); if (bump) mtl += `map_Bump ${bump}\n`;
      const em = await addTex(m.emissiveMap, n + '_emissive'); if (em) mtl += `map_Ke ${em}\n`;
      const al = await addTex(m.alphaMap, n + '_alpha'); if (al) mtl += `map_d ${al}\n`;
    }
  }
  files[`${baseName}.obj`] = strToU8(obj);
  files[`${baseName}.mtl`] = strToU8(mtl);
  const zipped = zipSync(files, { level: 6 });
  return { zipped, skipped, textures: usedTex.size, materials: usedMat.size };
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
  updateDownloadLabel();
}
function updateDownloadLabel() {
  const fmt = state.exportFormat;
  const zip = fmt === 'obj' && $('chk-obj-zip').checked;
  $('obj-zip-row').classList.toggle('hidden', fmt !== 'obj');
  $('btn-download-label').textContent = document.body.classList.contains('mobile')
    ? `Export ${zip ? 'OBJ .zip' : fmt.toUpperCase()}`
    : `Download Model (${zip ? 'OBJ .zip' : fmt.toUpperCase()})`;
}

/* ------------------------------------------------------------------ */
/* Simple shapes                                                       */
/* ------------------------------------------------------------------ */

const SHAPE_COLORS = [0x7aa2ff, 0xff8a65, 0x81c784, 0xffd54f, 0xba68c8, 0x4dd0e1, 0xf06292, 0xa1887f];
let shapeCount = 0;
const shapeObjects = new WeakSet();
const SHAPES = {
  cube: { label: 'Cube', make: (u) => new THREE.BoxGeometry(u, u, u) },
  sphere: { label: 'Sphere', make: (u) => new THREE.SphereGeometry(u / 2, 48, 32) },
  cylinder: { label: 'Cylinder', make: (u) => new THREE.CylinderGeometry(u / 2, u / 2, u, 48) },
  cone: { label: 'Cone', make: (u) => new THREE.ConeGeometry(u / 2, u, 48) },
  pyramid: { label: 'Pyramid', make: (u) => new THREE.ConeGeometry(u / Math.SQRT2, u, 4).rotateY(Math.PI / 4) },
  torus: { label: 'Torus', make: (u) => new THREE.TorusGeometry(u * 0.36, u * 0.14, 32, 64).rotateX(-Math.PI / 2) },
  plane: { label: 'Plane', make: (u) => new THREE.PlaneGeometry(u * 1.5, u * 1.5).rotateX(-Math.PI / 2), doubleSided: true },
  capsule: { label: 'Capsule', make: (u) => new THREE.CapsuleGeometry(u * 0.3, u * 0.5, 12, 32) },
};

function addShape(kind) {
  const def = SHAPES[kind];
  if (!def) return;
  const u = typicalSize();
  const color = SHAPE_COLORS[shapeCount++ % SHAPE_COLORS.length];
  const mat = new THREE.MeshStandardMaterial({
    name: def.label.toLowerCase() + '_material', color, roughness: 0.5, metalness: 0.05,
    side: def.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(def.make(u), mat);
  try {
    shapeObjects.add(mesh);
    addToScene(mesh, 'SHAPE', { name: def.label, place: 'floor', frame: 'ifHidden', select: true });
  } catch (e) {
    return toast('Couldn’t add the shape: ' + escapeHTML(e.message || String(e)), 'error');
  }
  $('shape-popover').classList.add('hidden');
  if (state.tool === 'select') setTool('move');
  toast(`Added a <b>${def.label}</b> — it’s selected: drag the arrows to move it, or use Rotate / Scale and the color controls in the Inspector.`, 'success', 4500);
}

// Size new things like a typical object already in the scene (1 unit in an empty scene):
// the median of the objects' largest dimensions — half that next to imported models.
function typicalSize() {
  let u = 1;
  if (state.modelRoot && state.modelRoot.children.length) {
    const dims = [];
    let anyShape = false;
    for (const o of state.modelRoot.children) {
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) continue;
      const sz = b.getSize(new THREE.Vector3());
      dims.push(Math.max(sz.x, sz.y, sz.z));
      if (shapeObjects.has(o)) anyShape = true;
    }
    if (dims.length) {
      dims.sort((a, b) => a - b);
      u = Math.max(dims[Math.floor(dims.length / 2)] * (anyShape ? 1 : 0.5), 1e-3);
    }
  }
  return u;
}

/* ------------------------------------------------------------------ */
/* Face selection: pick triangles, give them their own material        */
/* ------------------------------------------------------------------ */

// state.faceSel = { rec, set:Set<tri>, materials:[Material]|null }  (materials = the selection's own
// materials, created on the first edit; reset whenever the selection changes)
state.faceSel = null;
let faceMode = 'flat';
let faceClickMode = 'set'; // what a plain click does: set / add / remove (Shift / Alt override on a computer)
let faceAngle = 15;
let faceHintShown = false;
const adjCache = new WeakMap(); // geometry -> { start, list, normals, triCount }

const triCountOf = (g) => Math.floor((g.index ? g.index.count : g.getAttribute('position').count) / 3);
function triVerts(g) {
  const idx = g.index ? g.index.array : null;
  return idx ? (t, k) => idx[3 * t + k] : (t, k) => 3 * t + k;
}

// Triangle neighbours (sharing an edge, welded by position) + face normals, cached per geometry
function adjacencyOf(g) {
  let a = adjCache.get(g);
  if (a) return a;
  const pos = g.getAttribute('position');
  const vc = pos.count, tc = triCountOf(g), tv = triVerts(g);
  const tol = tolOf(g) * 10;
  const weld = new Int32Array(vc);
  const wmap = new Map();
  for (let i = 0; i < vc; i++) {
    const k = Math.round(pos.getX(i) / tol) + '_' + Math.round(pos.getY(i) / tol) + '_' + Math.round(pos.getZ(i) / tol);
    let id = wmap.get(k);
    if (id === undefined) { id = wmap.size; wmap.set(k, id); }
    weld[i] = id;
  }
  const W = wmap.size;
  const edges = new Map();
  const normals = new Float32Array(tc * 3);
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vcv = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < tc; t++) {
    const i0 = tv(t, 0), i1 = tv(t, 1), i2 = tv(t, 2);
    va.fromBufferAttribute(pos, i0); vb.fromBufferAttribute(pos, i1); vcv.fromBufferAttribute(pos, i2);
    n.subVectors(vcv, vb).cross(va.sub(vb)).normalize();
    normals[3 * t] = n.x; normals[3 * t + 1] = n.y; normals[3 * t + 2] = n.z;
    const w = [weld[i0], weld[i1], weld[i2]];
    for (let k = 0; k < 3; k++) {
      const p = w[k], q = w[(k + 1) % 3];
      if (p === q) continue;
      const key = p < q ? p * W + q : q * W + p;
      const l = edges.get(key);
      if (l) l.push(t); else edges.set(key, [t]);
    }
  }
  const deg = new Int32Array(tc + 1);
  for (const l of edges.values()) if (l.length > 1) for (const t of l) deg[t + 1] += l.length - 1;
  for (let t = 0; t < tc; t++) deg[t + 1] += deg[t];
  const list = new Int32Array(deg[tc]);
  const fill = deg.slice(0, tc);
  for (const l of edges.values()) {
    if (l.length < 2) continue;
    for (const t of l) for (const u of l) if (u !== t) list[fill[t]++] = u;
  }
  a = { start: deg, list, normals, triCount: tc };
  adjCache.set(g, a);
  return a;
}

function floodFaces(g, seed, mode) {
  const a = adjacencyOf(g);
  if (mode === 'tri') return [seed];
  const cosLim = Math.cos(THREE.MathUtils.degToRad(faceAngle));
  const nx = a.normals[3 * seed], ny = a.normals[3 * seed + 1], nz = a.normals[3 * seed + 2];
  const seen = new Uint8Array(a.triCount);
  const out = [seed];
  seen[seed] = 1;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    for (let j = a.start[t]; j < a.start[t + 1]; j++) {
      const u = a.list[j];
      if (seen[u]) continue;
      if (mode === 'flat' && a.normals[3 * u] * nx + a.normals[3 * u + 1] * ny + a.normals[3 * u + 2] * nz < cosLim) continue;
      seen[u] = 1;
      out.push(u);
    }
  }
  return out;
}

const faceActive = () => state.tool === 'faces' && state.faceSel && state.faceSel.set.size > 0 && state.meshes.includes(state.faceSel.rec);

// Highlight overlay — lives in the scene (not the model, so it's never exported), follows the mesh
const faceOverlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
  color: 0x4cd7f6, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false,
}));
faceOverlay.matrixAutoUpdate = false;
faceOverlay.visible = false;
faceOverlay.renderOrder = 5;
scene.add(faceOverlay);
const faceEdges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4cd7f6, transparent: true, opacity: 1, depthTest: true, toneMapped: false }));
faceEdges.matrixAutoUpdate = false;
faceEdges.visible = false;
faceEdges.renderOrder = 6;
scene.add(faceEdges);

function refreshFaceOverlay() {
  const fs = state.faceSel;
  const on = !!(fs && fs.set.size && state.tool === 'faces' && fs.rec.mesh.parent);
  faceOverlay.visible = faceEdges.visible = on;
  if (!on) return;
  const g = fs.rec.mesh.geometry, pos = g.getAttribute('position'), tv = triVerts(g);
  const tris = [...fs.set];
  const arr = new Float32Array(tris.length * 9);
  const lines = new Float32Array(tris.length * 18);
  let w = 0, l = 0;
  for (const t of tris) {
    const vs = [tv(t, 0), tv(t, 1), tv(t, 2)];
    for (const v of vs) { arr[w++] = pos.getX(v); arr[w++] = pos.getY(v); arr[w++] = pos.getZ(v); }
    for (let k = 0; k < 3; k++) for (const v of [vs[k], vs[(k + 1) % 3]]) { lines[l++] = pos.getX(v); lines[l++] = pos.getY(v); lines[l++] = pos.getZ(v); }
  }
  faceOverlay.geometry.dispose();
  faceOverlay.geometry = new THREE.BufferGeometry();
  faceOverlay.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  faceEdges.geometry.dispose();
  faceEdges.geometry = new THREE.BufferGeometry();
  faceEdges.geometry.setAttribute('position', new THREE.BufferAttribute(lines, 3));
}
function syncFaceOverlayMatrix() {
  if (!faceOverlay.visible) return;
  const m = state.faceSel.rec.mesh;
  m.updateWorldMatrix(true, false);
  faceOverlay.matrix.copy(m.matrixWorld);
  faceEdges.matrix.copy(m.matrixWorld);
  faceOverlay.matrixWorldNeedsUpdate = faceEdges.matrixWorldNeedsUpdate = true;
  faceOverlay.visible = faceEdges.visible = m.visible;
}

function setFaceSelection(rec, tris, how = 'set') {
  let fs = state.faceSel;
  if (!fs || fs.rec !== rec) fs = state.faceSel = { rec, set: new Set(), materials: null };
  if (how === 'set') fs.set = new Set(tris);
  else if (how === 'add') tris.forEach((t) => fs.set.add(t));
  else if (how === 'remove') tris.forEach((t) => fs.set.delete(t));
  fs.materials = null; // a new selection gets its own materials on the next edit
  afterFaceSelectionChange();
}
function clearFaceSelection() {
  if (state.faceSel) { state.faceSel.set = new Set(); state.faceSel.materials = null; }
  afterFaceSelectionChange();
}
function afterFaceSelectionChange() {
  refreshFaceOverlay();
  updateFacePanel();
  updateMaterialScopeLabel();
  syncMaterialSliders();
  syncTextureControls();
  renderTexLibrary();
}

function updateFacePanel() {
  const panel = $('face-panel');
  panel.classList.toggle('hidden', state.tool !== 'faces');
  document.querySelectorAll('.face-mode-btn').forEach((b) => {
    const on = b.dataset.fmode === faceMode;
    b.classList.toggle('bg-secondary-container/40', on);
    b.classList.toggle('text-secondary', on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
  $('face-angle-row').classList.toggle('opacity-40', faceMode !== 'flat');
  document.querySelectorAll('.face-click-btn').forEach((b) => {
    const on = b.dataset.fclick === faceClickMode;
    b.classList.toggle('bg-primary-container/40', on);
    b.classList.toggle('text-primary', on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
  const fs = state.faceSel;
  const n = fs && state.meshes.includes(fs.rec) ? fs.set.size : 0;
  $('face-count').textContent = n
    ? `${fmtInt(n)} triangle${n !== 1 ? 's' : ''} selected on ${fs.rec.mesh.name}`
    : 'Click a face on any part';
}

function updateMaterialScopeLabel() {
  const fs = state.faceSel;
  const label = faceActive() ? `${fmtInt(fs.set.size)} face${fs.set.size !== 1 ? 's' : ''} of ${fs.rec.mesh.name}` :
    (state.scope ? (state.scope.name || scopeKind()) : 'Whole Scene');
  $('mat-scope-label').textContent = label;
  $('mat-scope-label').title = label;
  $('mat-scope-label').classList.toggle('text-secondary', faceActive());
}

function onFaceClick(e, hit) {
  const rec = hit ? recOf(hit.object) : null;
  const how = e.shiftKey ? 'add' : e.altKey ? 'remove' : faceClickMode;
  if (!rec) { if (how === 'set') clearFaceSelection(); return; }
  if (!rec.editable) return toast('Faces of animated (skinned) parts can’t be selected.', 'warn', 4000);
  if (hit.faceIndex == null) return;
  if (state.scope !== rec.mesh) setScope(rec.mesh);
  const tris = floodFaces(rec.mesh.geometry, hit.faceIndex, faceMode);
  setFaceSelection(rec, tris, state.faceSel && state.faceSel.rec !== rec ? 'set' : how);
}

function faceGrow() {
  const fs = state.faceSel;
  if (!faceActive()) return toast('Select some faces first.', 'info', 2500);
  const a = adjacencyOf(fs.rec.mesh.geometry);
  const add = [];
  for (const t of fs.set) for (let j = a.start[t]; j < a.start[t + 1]; j++) add.push(a.list[j]);
  setFaceSelection(fs.rec, add, 'add');
}
function faceAll(invert) {
  const fs = state.faceSel;
  const rec = fs && state.meshes.includes(fs.rec) ? fs.rec : recOf(state.scope);
  if (!rec || !rec.editable) return toast('Click a face on a part first (or select a part in the Outliner).', 'info', 3500);
  const tc = triCountOf(rec.mesh.geometry);
  const cur = fs && fs.rec === rec ? fs.set : new Set();
  const out = [];
  for (let t = 0; t < tc; t++) if (!invert || !cur.has(t)) out.push(t);
  setFaceSelection(rec, out, 'set');
}

// Material index of every triangle (from geometry groups; 0 when there are none)
function triMaterials(g) {
  const tc = triCountOf(g);
  const out = new Int32Array(tc);
  if (g.groups && g.groups.length) {
    out.fill(-1);
    for (const grp of g.groups) {
      const a = Math.floor(grp.start / 3), b = Math.min(tc, Math.floor((grp.start + grp.count) / 3));
      for (let t = a; t < b; t++) out[t] = grp.materialIndex || 0;
    }
  }
  return out;
}

// Per-triangle material index for a part (a single material covers every triangle)
function recTriMaterials(rec) {
  const tm = triMaterials(rec.mesh.geometry);
  if (!Array.isArray(rec.baseMaterial)) tm.fill(0);
  return tm;
}

// Rebuild a mesh so triangles are grouped by material. Triangles with keep[t] === 0 are dropped.
// Unused materials are removed. Returns the old→new triangle map (-1 = dropped).
function rebuildByMaterial(rec, triMat, mats, keep) {
  const g = rec.mesh.geometry, tc = triCountOf(g), tv = triVerts(g);
  const used = [...new Set(Array.from(triMat).filter((m, t) => m >= 0 && (!keep || keep[t])))].sort((x, y) => x - y);
  const newOf = new Map(used.map((m, i) => [m, i]));
  const order = [];
  for (const m of used) for (let t = 0; t < tc; t++) if (triMat[t] === m && (!keep || keep[t])) order.push(t);
  const idx = new Uint32Array(order.length * 3);
  const remap = new Int32Array(tc).fill(-1);
  const groups = [];
  let w = 0;
  order.forEach((t, i) => {
    remap[t] = i;
    idx[w++] = tv(t, 0); idx[w++] = tv(t, 1); idx[w++] = tv(t, 2);
    const mi = newOf.get(triMat[t]);
    const last = groups[groups.length - 1];
    if (last && last.materialIndex === mi) last.count += 3;
    else groups.push({ start: i * 3, count: 3, materialIndex: mi });
  });
  const ng = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) ng.setAttribute(k, g.attributes[k]); // attributes are never edited in place
  for (const k of Object.keys(g.morphAttributes)) ng.morphAttributes[k] = g.morphAttributes[k];
  ng.setIndex(new THREE.BufferAttribute(idx, 1));
  const newMats = used.map((m) => mats[m]);
  if (newMats.length > 1) groups.forEach((gr) => ng.addGroup(gr.start, gr.count, gr.materialIndex));
  rec.mesh.geometry = ng;
  rec.baseline = ng;
  rec.pct = 100;
  rec.baseMaterial = newMats.length > 1 ? newMats : newMats[0];
  return remap;
}

// Give the selected faces their own material(s), once per selection, and return them
function faceMaterials() {
  if (!faceActive()) return null;
  const fs = state.faceSel;
  if (fs.materials) return fs.materials;
  const rec = fs.rec, g = rec.mesh.geometry;
  const mats = [].concat(rec.baseMaterial).slice();
  const triMat = recTriMaterials(rec);
  const total = new Map(), sel = new Map();
  triMat.forEach((m) => total.set(m, (total.get(m) || 0) + 1));
  for (const t of fs.set) sel.set(triMat[t], (sel.get(triMat[t]) || 0) + 1);
  const usedElsewhere = new Set();
  for (const r of state.meshes) if (r !== rec) [].concat(r.baseMaterial).forEach((m) => usedElsewhere.add(m));
  const targets = [];
  for (const [m, n] of sel) {
    const src = mats[m] || mats[0];
    if (n === total.get(m) && mats.indexOf(src) === m && !usedElsewhere.has(src) && mats.filter((x) => x === src).length === 1) {
      targets.push(src); // every face with this material is selected — edit it in place
    } else {
      const c = cloneMaterial(src);
      c.name = (src && src.name ? src.name : 'material') + '_faces';
      mats.push(c);
      const k = mats.length - 1;
      for (const t of fs.set) if (triMat[t] === m) triMat[t] = k;
      targets.push(c);
    }
  }
  const remap = rebuildByMaterial(rec, triMat, mats);
  fs.set = new Set([...fs.set].map((t) => remap[t]).filter((t) => t >= 0));
  fs.materials = targets;
  setViewMode(state.viewMode);
  refreshFaceOverlay();
  return targets;
}

// Material shown in the Color & Material controls while faces are selected
function faceDisplayMaterial() {
  if (!faceActive()) return null;
  const fs = state.faceSel;
  if (fs.materials) return fs.materials[0];
  const mats = [].concat(fs.rec.baseMaterial);
  const t = fs.set.values().next().value;
  return mats[recTriMaterials(fs.rec)[t]] || mats[0];
}

function deleteSelectedFaces() {
  const fs = state.faceSel;
  if (!faceActive()) return;
  const tc = triCountOf(fs.rec.mesh.geometry);
  if (fs.set.size >= tc) return toast('That’s every face of this part — switch to another tool and delete the part instead.', 'warn', 5000);
  const keep = new Uint8Array(tc).fill(1);
  for (const t of fs.set) keep[t] = 0;
  const n = fs.set.size;
  rebuildByMaterial(fs.rec, recTriMaterials(fs.rec), [].concat(fs.rec.baseMaterial), keep);
  setViewMode(state.viewMode);
  clearFaceSelection();
  refreshStats();
  updateSelBox();
  pushHistory();
  toast(`Deleted ${fmtInt(n)} face${n !== 1 ? 's' : ''}. Ctrl+Z to undo.`, 'success', 3000);
}

/* ------------------------------------------------------------------ */
/* Textures & images                                                   */
/* ------------------------------------------------------------------ */

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const texLib = [];          // { id, name, texture, w, h, hasAlpha, origin: 'imported'|'model', pngBlob, thumb, from }
let texActive = null;       // entry shown in the preview box
let texSeq = 0;

function sniffImage(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg';
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 12) === 'WEBP') return 'webp';
  return null;
}

function makeThumb(img, w, h) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  const k = Math.min(96 / w, 96 / h);
  try { g.drawImage(img, (96 - w * k) / 2, (96 - h * k) / 2, w * k, h * k); } catch (e) { return null; }
  return c.toDataURL('image/png');
}

/* Validate and decode an image file. JPEG and WebP are converted to PNG (lossless from here on);
   very large images are scaled down to what the graphics card can handle. */
// Largest texture side we keep: phones run out of memory with 4K/8K textures (an 8192² image needs
// ~256 MB once decoded), so they get 2048; computers 4096.
function textureLimit() {
  const dev = (typeof isMobileLayout === 'function' && isMobileLayout()) || matchMedia('(pointer: coarse)').matches ? 2048 : 4096;
  return Math.min(renderer.capabilities.maxTextureSize || 4096, dev);
}

// Width/height from a PNG / JPEG / WebP header, without decoding the image
function imageSizeFromHeader(u8, kind) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  try {
    if (kind === 'png') return { w: dv.getUint32(16), h: dv.getUint32(20) };
    if (kind === 'webp') {
      const fmt = ascii(u8, 12, 16);
      if (fmt === 'VP8X') return { w: 1 + (u8[24] | u8[25] << 8 | u8[26] << 16), h: 1 + (u8[27] | u8[28] << 8 | u8[29] << 16) };
      if (fmt === 'VP8L') { const b = dv.getUint32(21, true); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
      if (fmt === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    }
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < u8.length) {
        if (u8[i] !== 0xff) { i++; continue; }
        const mk = u8[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) };
        i += 2 + dv.getUint16(i + 2);
      }
    }
  } catch (e) {}
  return null;
}

async function loadImageFile(file) {
  const head = await readHead(file, 256 * 1024);
  const kind = sniffImage(head);
  if (!kind) throw new Error('it isn’t a PNG, JPEG or WebP image');
  const max = textureLimit();
  const size = imageSizeFromHeader(head, kind);
  let bmp;
  try {
    // decode straight to the reduced size where the browser supports it (much less memory)
    if (size && Math.max(size.w, size.h) > max) {
      const k0 = max / Math.max(size.w, size.h);
      try { bmp = await createImageBitmap(file, { resizeWidth: Math.round(size.w * k0), resizeHeight: Math.round(size.h * k0), resizeQuality: 'high' }); } catch (e) { bmp = null; }
    }
    if (!bmp) bmp = await createImageBitmap(file);
  } catch (e) { throw new Error('the image data is damaged, or too large for this device to decode'); }
  const origW = size ? size.w : bmp.width, origH = size ? size.h : bmp.height;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  // does it use transparency? (sampled on a small copy for speed)
  let hasAlpha = false;
  if (kind !== 'jpeg') {
    const sc = document.createElement('canvas');
    sc.width = Math.min(w, 256); sc.height = Math.min(h, 256);
    sc.getContext('2d').drawImage(c, 0, 0, sc.width, sc.height);
    const d = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }
  }
  const scaled = w < origW || h < origH;
  const pngBlob = kind === 'png' && !scaled ? file : await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!pngBlob) throw new Error('it couldn’t be converted to PNG');
  const url = URL.createObjectURL(pngBlob);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { img, url, w, h, origW, origH, hasAlpha, kind, scaled, pngBlob };
}

/* ---------- Texture sets: which picture is which, from the file name ----------
   e.g. Male_cargo_1001_BaseColor.png, wood_normal.jpg, BasicColor.png, Spec.png. Used when a model
   comes without a material file (.mtl) that says which texture goes where. */
const TEX_TYPES = [
  ['orm', ['occlusionroughnessmetallic', 'orm', 'arm']],
  ['color', ['basecolor', 'basecolour', 'basiccolor', 'basiccolour', 'albedo', 'diffuse', 'diff', 'color', 'colour', 'col', 'bc', 'd']],
  ['normal', ['normalopengl', 'normalgl', 'normaldirectx', 'normaldx', 'normalmap', 'normal', 'nrm', 'nor', 'norm', 'n']],
  ['roughness', ['roughness', 'rough', 'rgh']],
  ['metallic', ['metallic', 'metalness', 'metal']],
  ['ao', ['ambientocclusion', 'occlusion', 'ao']],
  ['emissive', ['emissive', 'emission', 'emit', 'glow', 'illumination']],
  ['opacity', ['opacity', 'alpha', 'transparency']],
  ['spec', ['specular', 'spec', 'spc']],
  ['gloss', ['glossiness', 'gloss']],
  ['height', ['height', 'displacement', 'disp', 'bump']],
];
const TEX_LABEL = { orm: 'AO/rough/metal', color: 'color', normal: 'normal', roughness: 'roughness', metallic: 'metallic', ao: 'AO', emissive: 'emissive', opacity: 'opacity', spec: 'specular→roughness', gloss: 'gloss→roughness', height: 'height (unused)' };

function classifyTexture(name) {
  const toks = String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
  for (let n = Math.min(3, toks.length); n >= 1; n--) {
    const tail = toks.slice(-n).join('');
    for (const [type, words] of TEX_TYPES) {
      if (!words.includes(tail)) continue;
      if (tail.length <= 2 && toks.length - n < 1) continue; // "d", "n", "bc"… only as an ending of a longer name
      return { type, prefix: toks.slice(0, -n).join('_'), directx: /directx|dx$/.test(tail) };
    }
  }
  return { type: null, prefix: toks.join('_') };
}

// Group library entries into sets that share a name prefix
function buildTextureSets(entries) {
  const sets = new Map();
  for (const e of entries) {
    const c = classifyTexture(e.name);
    let set = sets.get(c.prefix);
    if (!set) { set = { prefix: c.prefix, maps: {}, unknown: [], directx: false }; sets.set(c.prefix, set); }
    if (c.type && !set.maps[c.type]) { set.maps[c.type] = e; if (c.directx) set.directx = true; }
    else set.unknown.push(e);
  }
  const out = [...sets.values()];
  for (const st of out) if (!st.maps.color && st.unknown.length === 1) st.maps.color = st.unknown.shift(); // a lone picture is the colors
  // sets with nothing usable are dropped
  return out.filter((st) => Object.keys(st.maps).some((t) => t !== 'height'));
}
const setLabel = (st) => `${st.prefix || 'textures'} (${Object.keys(st.maps).map((t) => TEX_LABEL[t]).join(', ')})`;

// Specular / gloss maps → roughness (the app's materials use roughness): roughness = 1 − value
const invertedCache = new Map();
function invertedTexture(e) {
  if (invertedCache.has(e.id)) return invertedCache.get(e.id).clone();
  const img = e.texture.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = 255 - Math.round((d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3);
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  invertedCache.set(e.id, t);
  return t.clone();
}

function applySetToMaterial(m, st, flipNormal) {
  if (!m) return;
  const tex = (e, srgb) => { const t = e.texture.clone(); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true; return t; };
  const M = st.maps;
  if (M.color) { m.map = tex(M.color, true); if (m.color) m.color.set(0xffffff); if (M.color.hasAlpha && !M.opacity) { m.transparent = true; m.alphaTest = 0.02; } }
  if (M.orm) { const t = tex(M.orm, false); m.aoMap = t; m.roughnessMap = t; m.metalnessMap = t; m.roughness = 1; m.metalness = 1; }
  if (M.roughness) { m.roughnessMap = tex(M.roughness, false); m.roughness = 1; }
  else if (M.gloss) { m.roughnessMap = invertedTexture(M.gloss); m.roughness = 1; }
  else if (M.spec) { m.roughnessMap = invertedTexture(M.spec); m.roughness = 1; }
  if (M.metallic) { m.metalnessMap = tex(M.metallic, false); m.metalness = 1; }
  if (M.normal) { m.normalMap = tex(M.normal, false); m.normalScale = new THREE.Vector2(1, (flipNormal || st.directx) ? -1 : 1); }
  if (M.ao && !M.orm) m.aoMap = tex(M.ao, false);
  if (M.emissive) { m.emissiveMap = tex(M.emissive, true); if (m.emissive) m.emissive.set(0xffffff); m.emissiveIntensity = 1; }
  if (M.opacity) { m.alphaMap = tex(M.opacity, false); m.transparent = true; }
  m.needsUpdate = true;
}

// Material "slots" of a set of parts: each distinct material, with a readable name
function materialSlots(recs) {
  const slots = new Map();
  for (const r of recs) {
    if (r.isPoints) continue;
    for (const m of [].concat(r.baseMaterial)) {
      if (!m) continue;
      if (!slots.has(m)) slots.set(m, { mat: m, name: m.name || r.mesh.name || 'material', parts: new Set() });
      slots.get(m).parts.add(r.mesh.name);
    }
  }
  return [...slots.values()];
}

const alnum = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function nameScore(set, slot) {
  const p = alnum(set.prefix);
  if (!p) return 0;
  for (const n of [slot.name, ...slot.parts]) {
    const a = alnum(n);
    if (!a) continue;
    if (a === p) return 3;
    if (a.includes(p) || p.includes(a)) return 2;
  }
  return 0;
}

// Decide which set goes on which material. Returns { assign: Map(slot → set), unresolved }
function matchSetsToSlots(slots, sets) {
  const assign = new Map();
  const open = slots.filter((s) => !s.mat.map);
  const anyTextured = open.length < slots.length;
  if (!open.length || !sets.length) return { assign, unresolved: false };
  if (sets.length === 1 && !anyTextured) { open.forEach((s) => assign.set(s, sets[0])); return { assign, unresolved: false }; }
  for (const sl of open) {
    let best = null, bestScore = 0;
    for (const st of sets) { const sc = nameScore(st, sl); if (sc > bestScore) { best = st; bestScore = sc; } }
    if (best) assign.set(sl, best);
  }
  return { assign, unresolved: assign.size < open.length };
}

function finishTextureAssignment() {
  setViewMode(state.viewMode);
  syncMaterialSliders();
  syncTextureControls();
  renderTexLibrary();
}

// After a model loads: put textures no material asked for onto it (by file name), or ask the user
function autoTextureModel(info, entries) {
  const sets = buildTextureSets(entries);
  if (!sets.length) return;
  const slots = materialSlots(info.recs);
  const { assign, unresolved } = matchSetsToSlots(slots, sets);
  if (unresolved) return openMatchPanel(slots, sets, assign, info.name, { replaceSnapshot: true });
  if (!assign.size) return;
  for (const [sl, st] of assign) applySetToMaterial(sl.mat, st, false);
  finishTextureAssignment();
  if (state.hIndex >= 0) state.history[state.hIndex] = historySnapshot(); // part of the import, not a separate undo step
  const used = [...new Set(assign.values())];
  toast(`<b>${escapeHTML(info.name)}</b> came without a material file, so its textures were matched by file name: ${used.map((st) => escapeHTML(setLabel(st))).join('; ')}. Looks wrong? Use <b>Match textures…</b> in the Textures section. If bumps look inside-out, use <b>Flip normal map</b>.`, 'success', 11000);
}

// ---- Match Textures panel ----
let matchState = null;
function openMatchPanel(slots, sets, prefill, title, opts = {}) {
  if (!slots.length) return toast('Nothing selected that can take a texture.', 'warn', 3500);
  if (!sets.length) return toast('No textures to match — import some first (Import Texture accepts images or a .zip of images).', 'warn', 5000);
  matchState = { slots, sets, opts };
  $('match-title').textContent = title || 'your model';
  const rows = $('match-rows');
  rows.innerHTML = '';
  slots.forEach((sl, i) => {
    const row = document.createElement('label');
    row.className = 'flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 p-2 rounded-lg bg-surface-container-lowest';
    const pre = prefill && prefill.get(sl);
    const parts = [...sl.parts];
    row.innerHTML = `<span class="flex-1 min-w-0"><span class="block font-body-sm text-body-sm text-on-surface truncate">${escapeHTML(sl.name)}</span><span class="block font-label-sm text-[10px] text-outline truncate">${sl.mat.map ? 'already textured · ' : ''}${parts.length} part${parts.length !== 1 ? 's' : ''}: ${escapeHTML(parts.slice(0, 3).join(', '))}${parts.length > 3 ? '…' : ''}</span></span>` +
      `<select class="match-select w-full sm:w-64 bg-surface-container text-on-surface rounded-lg px-2 py-1.5 font-body-sm text-body-sm ring-1 ring-white/10" data-i="${i}"><option value="">— leave as is —</option>${sets.map((st, k) => `<option value="${k}" ${pre === st ? 'selected' : ''}>${escapeHTML(setLabel(st))}</option>`).join('')}</select>`;
    rows.appendChild(row);
  });
  $('match-flip').checked = false;
  $('match-modal').classList.remove('hidden');
}
function closeMatchPanel() { $('match-modal').classList.add('hidden'); matchState = null; }
function applyMatchPanel() {
  if (!matchState) return;
  let n = 0;
  document.querySelectorAll('.match-select').forEach((sel) => {
    if (sel.value === '') return;
    applySetToMaterial(matchState.slots[Number(sel.dataset.i)].mat, matchState.sets[Number(sel.value)], $('match-flip').checked);
    n++;
  });
  const { opts } = matchState;
  closeMatchPanel();
  if (!n) return;
  finishTextureAssignment();
  if (opts.replaceSnapshot && state.hIndex >= 0) state.history[state.hIndex] = historySnapshot(); else pushHistory();
  toast(`Textures applied to ${n} material${n !== 1 ? 's' : ''}.`, 'success', 3500);
}
function openMatchForSelection() {
  if (!state.modelRoot) return toast('The scene is empty — add a shape or load a model first.', 'warn');
  const recs = faceActive() ? [state.faceSel.rec] : scopeRecs();
  const slots = materialSlots(recs);
  const sets = buildTextureSets(texLib);
  // pre-fill with best guesses (by name, or the only set there is), even for already-textured materials
  const guess = new Map();
  for (const sl of slots) {
    let best = sets.length === 1 ? sets[0] : null, bestScore = 0;
    for (const st of sets) { const sc = nameScore(st, sl); if (sc > bestScore) { best = st; bestScore = sc; } }
    if (best) guess.set(sl, best);
  }
  openMatchPanel(slots, sets, guess, scopeName());
}

// DirectX-style normal maps have the green channel the other way round: flip it
function flipNormalMaps() {
  if (!state.modelRoot) return;
  let n = 0;
  eachScopeMaterial((m) => { if (m.normalMap) { m.normalScale = (m.normalScale || new THREE.Vector2(1, 1)).clone(); m.normalScale.y *= -1; n++; } });
  if (!n) return toast(`${escapeHTML(scopeName())} has no normal map to flip.`, 'info', 3000);
  pushHistory();
  toast('Normal map flipped — bumps and dents now face the other way.', 'success', 3000);
}

function newTexture(img, name) {
  const t = new THREE.Texture(img);
  t.name = name;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.needsUpdate = true;
  return t;
}

// Import image files into the library. Returns the new entries; problems are reported in one toast.
async function importTextureFiles(files) {
  const added = [], bad = [], notes = [];
  for (const f of files) {
    // the same file imported again re-uses its library entry
    const key = `${f.name.toLowerCase()}|${f.size}`; // files unpacked from a zip get a new date each time
    const dup = texLib.find((e) => e.key === key);
    if (dup) { added.push(dup); continue; }
    try {
      const r = await loadImageFile(f);
      const name = baseNameOf(f.name);
      const entry = {
        id: ++texSeq, key, name, texture: newTexture(r.img, name), w: r.w, h: r.h, hasAlpha: r.hasAlpha,
        origin: 'imported', pngBlob: r.pngBlob, url: r.url, thumb: makeThumb(r.img, r.w, r.h), from: r.kind,
      };
      texLib.push(entry);
      added.push(entry);
      if (r.kind !== 'png') notes.push(`${escapeHTML(f.name)} → PNG`);
      if (r.scaled) notes.push(`${escapeHTML(f.name)} reduced from ${r.origW}×${r.origH} to ${r.w}×${r.h} for this device`);
    } catch (e) {
      bad.push(`<b>${escapeHTML(f.name)}</b> — ${escapeHTML(e.message)}`);
    }
  }
  if (bad.length) toast(`Not imported: ${bad.join('; ')}.`, 'error', 9000);
  if (added.length) {
    texActive = added[added.length - 1];
    renderTexLibrary();
    revealTexturesPanel();
  }
  return { added, notes };
}

// Textures that came inside loaded models also appear in the library
function collectModelTextures() {
  const known = new Set(texLib.map((e) => e.texture.source));
  for (const rec of state.meshes) {
    for (const m of [].concat(rec.baseMaterial)) {
      const t = m && m.map;
      if (!t || !t.image || known.has(t.source)) continue;
      const w = t.image.width || 0, h = t.image.height || 0;
      if (!w || !h) continue;
      const thumb = makeThumb(t.image, w, h);
      if (!thumb) continue;
      known.add(t.source);
      texLib.push({ id: ++texSeq, name: t.name || (m.name ? m.name + '_texture' : 'model_texture'), texture: t, w, h,
        hasAlpha: !!m.transparent, origin: 'model', thumb, from: 'model' });
    }
  }
  renderTexLibrary();
}

function dropModelTextures() {
  for (let i = texLib.length - 1; i >= 0; i--) if (texLib[i].origin === 'model') texLib.splice(i, 1);
  if (texActive && !texLib.includes(texActive)) texActive = null;
  renderTexLibrary();
}

// Texture objects (by image) used by the current selection
function scopeMapSources() {
  const set = new Set();
  if (faceActive()) { scopeMaps().forEach((t) => set.add(t.source)); return set; }
  for (const r of scopeRecs()) for (const m of [].concat(r.baseMaterial)) if (m && m.map) set.add(m.map.source);
  return set;
}

function renderTexLibrary() {
  const grid = $('tex-grid');
  if (!grid) return;
  $('tex-count').textContent = String(texLib.length);
  grid.innerHTML = '';
  if (!texLib.length) {
    grid.innerHTML = '<div class="col-span-4 py-3 text-center font-label-sm text-[10px] text-outline rounded-lg border border-dashed border-white/10">No textures yet — import some, or drop image files anywhere on the page</div>';
  }
  const inUse = state.modelRoot ? scopeMapSources() : new Set();
  for (const e of texLib) {
    const b = document.createElement('button');
    b.type = 'button';
    const used = inUse.has(e.texture.source);
    b.className = `relative aspect-square rounded-lg overflow-hidden bg-[repeating-conic-gradient(#2a2b31_0_25%,#1a1b21_0_50%)] bg-[length:10px_10px] ring-2 transition-all ${e === texActive ? 'ring-primary' : used ? 'ring-secondary/80' : 'ring-transparent hover:ring-white/30'}`;
    b.title = `${e.name} — ${e.w}×${e.h}${e.origin === 'model' ? ' (from your model)' : ''}${used ? ' · used by the selection' : ''}\nClick: preview, and apply to the selected part / object`;
    b.innerHTML = `<img alt="" class="w-full h-full object-contain" src="${e.thumb}"/>` +
      (used ? '<span class="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-secondary shadow"></span>' : '') +
      (e.origin === 'model' ? '<span class="absolute bottom-0 left-0 right-0 text-[8px] leading-3 bg-black/60 text-white/80 text-center">model</span>' : '');
    b.addEventListener('click', () => onTextureClick(e));
    grid.appendChild(b);
  }
  renderTexPreview();
}

function renderTexPreview() {
  const box = $('tex-preview');
  const e = texActive && texLib.includes(texActive) ? texActive : null;
  box.classList.toggle('hidden', !e);
  if (!e) return;
  $('tex-preview-img').src = e.thumb;
  $('tex-preview-name').textContent = e.name;
  $('tex-preview-name').title = e.name;
  const src = e.origin === 'model' ? 'from your model' : e.from === 'png' ? 'PNG' : `${e.from.toUpperCase()} → converted to PNG`;
  $('tex-preview-meta').textContent = `${e.w}×${e.h} • ${src}${e.hasAlpha ? ' • has transparency' : ''}`;
}

function revealTexturesPanel() {
  if (isMobileLayout()) { openSheetTab('materials'); return; }
  if (typeof setPanel === 'function' && !ui.right) setPanel('right', true);
  if (typeof setSection === 'function' && ui.sections.textures) { setSection('textures', false); saveUI(); }
}

function onTextureClick(e) {
  texActive = e;
  if (faceActive()) return applyTexture(e);
  if (!state.modelRoot) {
    renderTexLibrary();
    return toast('Preview only — add a shape or load a model, then select it and click a texture to apply it. Or click <b>Place</b> to put this picture in the scene.', 'info', 5500);
  }
  if (!state.scope) {
    renderTexLibrary();
    return toast('Select a part or object first (click it in the viewport or Outliner), then click the texture. To cover <b>everything</b>, click <b>Apply</b> in the preview box.', 'info', 6000);
  }
  applyTexture(e);
}

// Give meshes that have no texture coordinates a simple box projection, so a texture can show
function boxProjectUVs(src) {
  const g = src.clone();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
  g.computeBoundingBox();
  const bb = g.boundingBox, size = bb.getSize(new THREE.Vector3());
  const sc = Math.max(size.x, size.y, size.z) || 1;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = (pos.getX(i) - bb.min.x) / sc, y = (pos.getY(i) - bb.min.y) / sc, z = (pos.getZ(i) - bb.min.z) / sc;
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    if (ax >= ay && ax >= az) { uv[2 * i] = z; uv[2 * i + 1] = y; }
    else if (ay >= az) { uv[2 * i] = x; uv[2 * i + 1] = z; }
    else { uv[2 * i] = x; uv[2 * i + 1] = y; }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function applyTexture(e) {
  if (!e) return;
  if (!state.modelRoot) return toast('The scene is empty — add a shape or load a model first.', 'warn');
  const recs = faceActive() ? [state.faceSel.rec] : scopeRecs().filter((r) => !r.isPoints);
  if (!recs.length) return toast('Nothing in the selection can show a texture (point clouds can’t).', 'warn');
  let projected = 0;
  for (const rec of recs) {
    if (rec.mesh.geometry.getAttribute('uv')) continue;
    const g = boxProjectUVs(rec.mesh.geometry); // same triangle order, so a face selection stays valid
    rec.mesh.geometry = g; rec.baseline = g; rec.pct = 100;
    projected++;
  }
  if (projected && faceActive()) refreshFaceOverlay();
  const tex = e.texture.clone(); // one shared layout for the whole selection
  tex.repeat.set(1, 1); tex.offset.set(0, 0); tex.rotation = 0; tex.center.set(0.5, 0.5);
  tex.needsUpdate = true;
  eachScopeMaterial((m) => {
    m.map = tex;
    if (m.color) m.color.set(0xffffff); // so the texture shows its true colors (re-tint with Color)
    if (e.hasAlpha) { m.transparent = true; m.alphaTest = 0.02; }
    m.needsUpdate = true;
  });
  setViewMode('pbr');
  state.activePreset = null;
  updatePresetChips();
  texActive = e;
  syncMaterialSliders();
  syncTextureControls();
  renderTexLibrary();
  pushHistory();
  toast(`Applied <b>${escapeHTML(e.name)}</b> to <b>${escapeHTML(faceActive() ? $('mat-scope-label').textContent : scopeName())}</b>.` +
    (projected ? ` ${projected} part${projected > 1 ? 's' : ''} had no texture coordinates, so a simple box projection was added (works best on boxy shapes).` : '') +
    ' Adjust Tiling / Rotation / Shift below; the Color picker tints it.', 'success', 6000);
}

// Place a picture in the scene as a flat, double-sided panel facing the camera
function addImageToScene(e) {
  if (!e) return;
  const u = typicalSize() * 1.5;
  const k = u / Math.max(e.w, e.h);
  const geo = new THREE.PlaneGeometry(e.w * k, e.h * k);
  const tex = e.texture.clone();
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({
    name: e.name + '_image', map: tex, side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
    transparent: e.hasAlpha, alphaTest: e.hasAlpha ? 0.02 : 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const toCam = new THREE.Vector3().subVectors(activeCam.position, controls.target);
  mesh.rotation.y = Math.atan2(toCam.x, toCam.z);
  try {
    shapeObjects.add(mesh);
    addToScene(mesh, 'IMAGE', { name: e.name, place: 'floor', frame: 'ifHidden', select: true });
  } catch (err) {
    return toast('Couldn’t add the image: ' + escapeHTML(err.message || String(err)), 'error');
  }
  if (state.tool === 'select') setTool('move');
  texActive = e;
  renderTexLibrary();
  toast(`Placed <b>${escapeHTML(e.name)}</b> in the scene as a flat picture (${e.w}×${e.h}). It’s selected — move, rotate or resize it like any shape.`, 'success', 5000);
}

// Make the selection's textures independent of identical texture objects used elsewhere (e.g. glTF shares them)
function makeScopeMapsUnique() {
  const fm = faceMaterials();
  if (fm) {
    // the selected faces' textures must not be shared with any other material
    const mine = new Set(fm);
    const others = new Set();
    for (const r of state.meshes) for (const m of [].concat(r.baseMaterial)) if (m && !mine.has(m) && m.map) others.add(m.map);
    for (const m of fm) if (m && m.map && others.has(m.map)) { m.map = m.map.clone(); m.needsUpdate = true; }
    return;
  }
  makeScopeMaterialsUnique();
  const inside = new Set(scopeRecs());
  const outside = new Set();
  for (const r of state.meshes) if (!inside.has(r)) for (const m of [].concat(r.baseMaterial)) if (m && m.map) outside.add(m.map);
  const copies = new Map();
  for (const r of inside) for (const m of [].concat(r.baseMaterial)) {
    if (!m || !m.map || !outside.has(m.map)) continue;
    if (!copies.has(m.map)) copies.set(m.map, m.map.clone());
    m.map = copies.get(m.map);
    m.needsUpdate = true;
  }
}

function scopeMaps() {
  const maps = new Set();
  if (faceActive()) {
    const ms = state.faceSel.materials || [faceDisplayMaterial()];
    ms.forEach((m) => m && m.map && maps.add(m.map));
    return [...maps];
  }
  for (const r of scopeRecs()) for (const m of [].concat(r.baseMaterial)) if (m && m.map) maps.add(m.map);
  return [...maps];
}

function setTexLayout(key, value) {
  if (!state.modelRoot) return;
  makeScopeMapsUnique();
  for (const t of scopeMaps()) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.center.set(0.5, 0.5);
    if (key === 'repeat') t.repeat.set(value, value);
    else if (key === 'rotation') t.rotation = THREE.MathUtils.degToRad(value);
    else if (key === 'offx') t.offset.x = value;
    else if (key === 'offy') t.offset.y = value;
    t.needsUpdate = true;
  }
}

function syncTextureControls() {
  const maps = state.modelRoot ? scopeMaps() : [];
  const t = maps[0];
  ['slider-tex-repeat', 'slider-tex-rot', 'slider-tex-offx', 'slider-tex-offy'].forEach((id) => { $(id).disabled = !t; });
  $('tex-controls').classList.toggle('opacity-50', !t);
  $('tex-controls-note').textContent = t
    ? `Adjusting the texture on ${scopeName()}${maps.length > 1 ? ` (${maps.length} textures)` : ''}. Rotation is kept in GLB exports only.`
    : 'Select something with a texture to adjust how it’s laid out.';
  if (!t) return;
  const rep = Math.round(t.repeat.x * 10);
  $('slider-tex-repeat').value = clamp(rep, 10, 200);
  $('val-tex-repeat').textContent = (rep / 10).toFixed(1) + '×';
  const deg = Math.round(THREE.MathUtils.radToDeg(t.rotation));
  $('slider-tex-rot').value = deg;
  $('val-tex-rot').textContent = deg + '°';
  $('slider-tex-offx').value = Math.round((((t.offset.x % 1) + 1) % 1) * 100);
  $('slider-tex-offy').value = Math.round((((t.offset.y % 1) + 1) % 1) * 100);
}

async function downloadTexturePNG(e) {
  if (!e) return;
  let blob = e.pngBlob;
  if (!blob) {
    const u8 = await textureToPNG(e.texture);
    if (!u8) return toast('This texture can’t be saved as PNG (compressed format).', 'warn');
    blob = new Blob([u8], { type: 'image/png' });
  }
  saveBlob(blob, safeFileName(e.name) + '.png');
}

function removeTextureEntry(e) {
  const i = texLib.indexOf(e);
  if (i < 0) return;
  texLib.splice(i, 1);
  if (texActive === e) texActive = null;
  renderTexLibrary();
  toast(`Removed <b>${escapeHTML(e.name)}</b> from the library. Parts already using it keep it (use <b>Remove Texture</b> to strip it).`, 'info', 4500);
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
    if (!state.modelRoot) { state.originalFile = null; updateDownloadOriginal(); }
    addToScene(obj, s.fmt, { name: key === 'torus' ? 'torus_knot' : key, frame: 'always' });
    toast(`Sample loaded: <b>${s.label}</b> (${s.fmt}). Drag to orbit, scroll to zoom, try the edit tools!`, 'success', 4200);
  } catch (err) {
    console.error('[Online3D] sample failed:', err);
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
  syncFaceOverlayMatrix();
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
$('btn-split').addEventListener('click', opSplit);
// Face selection panel
document.querySelectorAll('.face-mode-btn').forEach((b) => b.addEventListener('click', () => { faceMode = b.dataset.fmode; updateFacePanel(); }));
$('face-angle').addEventListener('input', (e) => { faceAngle = Number(e.target.value); $('face-angle-val').textContent = faceAngle + '°'; });
$('face-grow').addEventListener('click', faceGrow);
$('face-all').addEventListener('click', () => faceAll(false));
$('face-invert').addEventListener('click', () => faceAll(true));
$('face-clear').addEventListener('click', clearFaceSelection);
// Add Shape menu
const shapePop = $('shape-popover');
$('btn-add-shape').addEventListener('click', (e) => { e.stopPropagation(); shapePop.classList.toggle('hidden'); });
$('btn-empty-add-shape').addEventListener('click', (e) => { e.stopPropagation(); shapePop.classList.remove('hidden'); });
document.querySelectorAll('.add-shape-btn').forEach((b) => b.addEventListener('click', () => addShape(b.dataset.shape)));
document.addEventListener('click', (e) => {
  if (!shapePop.contains(e.target) && !e.target.closest('#btn-add-shape, #btn-empty-add-shape')) shapePop.classList.add('hidden');
});
$('btn-duplicate').addEventListener('click', opDuplicate);
$('btn-hide').addEventListener('click', () => toggleVisibility());
$('btn-delete').addEventListener('click', opDelete);

// Bottom toolbar: mouse wheel scrolls it sideways when it overflows
const barScroll = $('transform-bar-scroll');
barScroll.addEventListener('wheel', (e) => {
  if (barScroll.scrollWidth <= barScroll.clientWidth) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { barScroll.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });

// Transform inputs
[$('pos-x'), $('pos-y'), $('pos-z'), $('rot-x'), $('rot-y'), $('rot-z'), $('scl-x'), $('scl-y'), $('scl-z')].forEach((inp) => {
  inp.addEventListener('change', commitTransformFromInputs);
  // Enter just blurs — the native 'change' fired by blur does ONE commit (no duplicate history entry)
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
});
$('btn-transform-reset').addEventListener('click', () => {
  if (!state.modelRoot) return toast('Load a model first.', 'warn');
  const t = transformTarget();
  const o = origTransforms.get(t);
  if (o) { t.position.copy(o.pos); t.quaternion.copy(o.quat); t.scale.copy(o.scale); }
  else { t.position.set(0, 0, 0); t.rotation.set(0, 0, 0); t.scale.set(1, 1, 1); }
  syncTransformInputs(); updateSelBox(); pushHistory();
  toast(t === state.modelRoot ? 'Model transform reset.' : `<b>${escapeHTML(t.name)}</b> moved back to where it started.`, 'success', 2200);
});
$('btn-center-pivot').addEventListener('click', centerPivot);
$('btn-ground').addEventListener('click', groundToFloor);

// Scale slider
$('scale-slider').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  $('scale-display').textContent = v.toFixed(2) + 'x';
  const t = transformTarget();
  if (t) { t.scale.setScalar(v); syncTransformInputs(); updateSelBox(); }
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

// Color / opacity / texture
$('mat-color').addEventListener('input', (e) => applyColor(e.target.value));
$('mat-color').addEventListener('change', () => { if (state.modelRoot) pushHistory(); });
$('mat-color-hex').addEventListener('change', (e) => {
  let v = e.target.value.trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v.slice(1).split('').map((c) => c + c).join('');
  if (!/^#[0-9a-f]{6}$/i.test(v)) { toast('Enter a color like <b>#ff8800</b>.', 'warn', 2500); syncMaterialSliders(); return; }
  applyColor(v.toLowerCase());
  if (state.modelRoot) pushHistory();
});
$('mat-color-hex').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
document.querySelectorAll('.mat-swatch').forEach((b) => b.addEventListener('click', () => {
  applyColor(b.dataset.color);
  if (state.modelRoot) pushHistory();
}));
$('slider-opacity').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  $('val-opacity').textContent = v.toFixed(2);
  applyOpacity(v);
});
$('slider-opacity').addEventListener('change', () => { if (state.modelRoot) pushHistory(); });
$('btn-remove-texture').addEventListener('click', removeTextures);

// Textures & images
const texInput = $('texture-input'), imgInput = $('image-input');
$('btn-import-texture').addEventListener('click', () => texInput.click());
texInput.addEventListener('change', async () => {
  let files = [...texInput.files];
  texInput.value = '';
  if (!files.length) return;
  // a .zip of pictures: unpack it (same safety limits as model zips) and keep only the images
  for (const zip of files.filter((f) => extOf(f.name) === 'zip')) {
    try {
      const bytes = new Uint8Array(await zip.arrayBuffer());
      if (ascii(bytes, 0, 2) !== 'PK') throw new Error('it isn’t a zip file (wrong signature)');
      const imgs = expandZip(zip, bytes).files.filter((f) => IMAGE_EXT.includes(extOf(f.name)));
      if (!imgs.length) throw new Error('it contains no PNG, JPEG or WebP images');
      files = files.concat(imgs);
    } catch (e) {
      toast(`Rejected <b>${escapeHTML(zip.name)}</b>: ${escapeHTML(e.message)}.`, 'error', 7000);
    }
  }
  files = files.filter((f) => extOf(f.name) !== 'zip');
  if (!files.length) return;
  setLoading(true, `Importing ${files.length} texture${files.length > 1 ? 's' : ''}…`);
  let added = [], notes = [];
  try { ({ added, notes } = await importTextureFiles(files)); } finally { setLoading(false); }
  if (added.length) toast(`Imported ${added.length} texture${added.length > 1 ? 's' : ''}${notes.length ? ' (' + notes.join(', ') + ')' : ''}. Select a part and click a thumbnail to apply.`, 'success', 5000);
});
const pickImage = () => { $('shape-popover').classList.add('hidden'); imgInput.click(); };
$('btn-add-image').addEventListener('click', pickImage);
$('btn-menu-add-image').addEventListener('click', pickImage);
imgInput.addEventListener('change', async () => {
  const files = [...imgInput.files];
  imgInput.value = '';
  if (!files.length) return;
  const { added } = await importTextureFiles(files);
  if (added.length) addImageToScene(added[0]);
});
$('btn-tex-apply').addEventListener('click', () => applyTexture(texActive));
$('btn-match-textures').addEventListener('click', openMatchForSelection);
$('btn-flip-normal').addEventListener('click', flipNormalMaps);
$('match-apply').addEventListener('click', applyMatchPanel);
$('match-cancel').addEventListener('click', closeMatchPanel);
$('match-modal').addEventListener('click', (e) => { if (e.target.id === 'match-modal') closeMatchPanel(); });
$('btn-tex-place').addEventListener('click', () => addImageToScene(texActive));
$('btn-tex-download').addEventListener('click', () => downloadTexturePNG(texActive));
$('btn-tex-remove').addEventListener('click', () => removeTextureEntry(texActive));
const bindTexSlider = (id, key, toVal, show) => {
  const el = $(id);
  el.addEventListener('input', () => { const v = toVal(Number(el.value)); if (show) show(v); setTexLayout(key, v); });
  el.addEventListener('change', () => { if (state.modelRoot) pushHistory(); });
};
bindTexSlider('slider-tex-repeat', 'repeat', (v) => v / 10, (v) => { $('val-tex-repeat').textContent = v.toFixed(1) + '×'; });
bindTexSlider('slider-tex-rot', 'rotation', (v) => v, (v) => { $('val-tex-rot').textContent = v + '°'; });
bindTexSlider('slider-tex-offx', 'offx', (v) => v / 100);
bindTexSlider('slider-tex-offy', 'offy', (v) => v / 100);

// Material presets
document.querySelectorAll('.mat-preset-btn').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));

// Export
document.querySelectorAll('.export-format-btn').forEach((b) => b.addEventListener('click', () => setExportFormat(b.dataset.fmt)));
$('btn-download').addEventListener('click', doExport);
$('chk-obj-zip').addEventListener('change', updateDownloadLabel);
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
/* Collapsible panels & sections (remembered between visits) */
const UI_KEY = 'aether3d.ui.v1';
const ui = (() => {
  try { return Object.assign({ left: true, right: true, tray: true, sections: {} }, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); }
  catch (e) { return { left: true, right: true, tray: true, sections: {} }; }
})();
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {} }

function applyPanels() {
  document.body.classList.toggle('left-collapsed', !ui.left);
  document.body.classList.toggle('right-collapsed', !ui.right);
  document.body.classList.toggle('tray-closed', !ui.tray);
  document.querySelectorAll('.panel-toggle-btn').forEach((b) => {
    const on = !!ui[b.dataset.panel];
    b.classList.toggle('text-secondary', on);
    b.classList.toggle('bg-surface-container-high', on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
  const ins = $('btn-simple-edit');
  ins.classList.toggle('text-secondary', ui.right);
  setTimeout(resize, 30);
}
function setPanel(name, open) { ui[name] = open; saveUI(); applyPanels(); }

function setSection(id, collapsed) {
  ui.sections[id] = collapsed;
  document.querySelectorAll(`.panel-head[data-section="${id}"]`).forEach((h) => h.classList.toggle('collapsed', collapsed));
  document.querySelectorAll(`[data-section-body="${id}"]`).forEach((b) => b.classList.toggle('collapsed', collapsed));
}
document.querySelectorAll('.panel-head').forEach((h) => {
  const id = h.dataset.section;
  h.title = h.title || 'Click to collapse / expand this section';
  setSection(id, !!ui.sections[id]);
  h.addEventListener('click', () => { setSection(id, !ui.sections[id]); saveUI(); });
});
$('btn-collapse-all-sections').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('#right-dock .panel-head')].map((h) => h.dataset.section);
  const collapse = ids.some((id) => !ui.sections[id]);
  ids.forEach((id) => setSection(id, collapse));
  $('btn-collapse-all-sections').textContent = collapse ? 'Expand all' : 'Collapse all';
  saveUI();
});
document.querySelectorAll('.panel-toggle-btn').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.panel, !ui[b.dataset.panel])));
$('btn-collapse-left').addEventListener('click', () => setPanel('left', false));
$('btn-collapse-right').addEventListener('click', () => setPanel('right', false));
$('btn-close-tray').addEventListener('click', (e) => { e.stopPropagation(); setPanel('tray', false); });
$('btn-simple-edit').addEventListener('click', () => setPanel('right', !ui.right));
applyPanels();
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); opDuplicate(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case 'v': setTool('select'); break;
    case 'p': setTool('faces'); break;
    case 'g': setTool('move'); break;
    case 'r': setTool('rotate'); break;
    case 's': setTool('scale'); break;
    case 'f': frameCamera(false); break;
    case 'h': toggleVisibility(); break;
    case 'delete':
    case 'backspace': e.preventDefault(); if (state.tool === 'faces') deleteSelectedFaces(); else opDelete(); break;
    case 'escape':
      if (!$('match-modal').classList.contains('hidden')) closeMatchPanel();
      else if (!$('shape-popover').classList.contains('hidden')) $('shape-popover').classList.add('hidden');
      else if (state.tool === 'faces') { if (faceActive()) clearFaceSelection(); else setTool('select'); }
      else if (document.body.classList.contains('preview-mode')) setPreview(false);
      else if (state.scope) {
        const top = topObjectOf(state.scope);
        setScope(top && top !== state.scope ? top : null);
      }
      else setTool('select');
      break;
  }
});

/* ------------------------------------------------------------------ */
/* Mobile layout                                                       */
/* ------------------------------------------------------------------ */
// Phones (and small touch tablets) get a different layout: the 3D view on top and a bottom sheet with
// tabs. The desktop panels' sections are *moved* into the sheet (not copied), so every control keeps
// working the same way; switching back puts them where they were.

const isTouch = matchMedia('(pointer: coarse)').matches;
const autoMobileMQ = matchMedia('(max-width: 767px), (pointer: coarse) and (max-width: 1023px)');
function isMobileLayout() {
  const mode = (typeof ui !== 'undefined' && ui.layout) || 'auto';
  return mode === 'mobile' || (mode === 'auto' && autoMobileMQ.matches);
}

const MOVES = [ // [element, mobile destination]
  () => [$('transform-bar'), $('sheet-tools')],
  () => [$('sec-transform'), document.querySelector('[data-pane="transform"]')],
  () => [$('sec-material'), document.querySelector('[data-pane="materials"]')],
  () => [$('sec-textures'), document.querySelector('[data-pane="materials"]')],
  () => [$('sec-geometry'), document.querySelector('[data-pane="mesh"]')],
  () => [$('model-card'), document.querySelector('[data-pane="scene"]')],
  () => [$('outliner-list').previousElementSibling, document.querySelector('[data-pane="scene"]')],
  () => [$('outliner-list'), document.querySelector('[data-pane="scene"]')],
  () => [$('btn-download-original'), document.querySelector('[data-pane="scene"]')],
  () => [$('export-dock'), $('sheet-export')],
];
let movedHome = null; // [{el, parent, next}] while in the mobile layout
let sheetState = 'half';
let sheetTab = 'transform';

function applyLayout() {
  const mobile = isMobileLayout();
  if (mobile && !movedHome) {
    movedHome = [];
    for (const f of MOVES) {
      const [el, dest] = f();
      if (!el || !dest) continue;
      movedHome.push({ el, parent: el.parentNode, next: el.nextSibling });
      dest.appendChild(el);
    }
  } else if (!mobile && movedHome) {
    for (const m of movedHome.reverse()) m.parent.insertBefore(m.el, m.next && m.next.parentNode === m.parent ? m.next : null);
    movedHome = null;
  }
  document.body.classList.toggle('mobile', mobile);
  $('mobile-menu').classList.add('hidden');
  document.querySelectorAll('.mm-item[data-act="layout"]').forEach((b) => b.classList.toggle('active', b.dataset.layout === ((ui && ui.layout) || 'auto')));
  tc.setSize(isTouch || mobile ? 1.35 : 0.9);
  updateDownloadLabel();
  if (mobile) { setSheetTab(sheetTab, false); setSheet(sheetState); }
  setTimeout(resize, 30);
}

// ---- bottom sheet: three heights, drag the handle (or the tab bar) to resize ----
const sheet = $('mobile-sheet');
function sheetHeights() {
  const total = $('viewport-height').clientHeight || window.innerHeight;
  const peek = $('sheet-handle').offsetHeight + $('sheet-tools').offsetHeight + $('sheet-tabs').offsetHeight + 12;
  return { collapsed: peek, half: Math.max(peek, Math.round(total * 0.58)), full: Math.max(peek, Math.round(total * 0.86)) };
}
function setSheet(stateName) {
  sheetState = stateName;
  sheet.style.height = sheetHeights()[stateName] + 'px';
  $('sheet-content').classList.toggle('invisible', stateName === 'collapsed');
}
function setSheetTab(tab, open = true) {
  sheetTab = tab;
  document.querySelectorAll('.sheet-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.sheet-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (open && sheetState === 'collapsed') setSheet('half');
}
function openSheetTab(tab) { setSheetTab(tab); if (sheetState === 'collapsed') setSheet('half'); }

let sheetDrag = null;
function sheetPointerDown(e) {
  sheetDrag = { y: e.clientY, h: sheet.offsetHeight, moved: false, id: e.pointerId, target: e.currentTarget };
}
window.addEventListener('pointermove', (e) => {
  if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
  const dy = sheetDrag.y - e.clientY;
  if (!sheetDrag.moved && Math.abs(dy) < 8) return;
  if (!sheetDrag.moved) { sheetDrag.moved = true; sheet.classList.add('dragging'); $('sheet-content').classList.remove('invisible'); }
  const hs = sheetHeights();
  sheet.style.height = clamp(sheetDrag.h + dy, hs.collapsed, Math.round(($('viewport-height').clientHeight || innerHeight) * 0.9)) + 'px';
});
window.addEventListener('pointerup', (e) => {
  if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
  const d = sheetDrag;
  sheetDrag = null;
  if (!d.moved) return;
  sheet.classList.remove('dragging');
  const h = sheet.offsetHeight, hs = sheetHeights();
  const best = Object.entries(hs).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
  setSheet(best);
  // a drag that started on a tab mustn't also count as a tap on it
  const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
});
$('sheet-handle').addEventListener('pointerdown', sheetPointerDown);
$('sheet-tabs').addEventListener('pointerdown', sheetPointerDown);
$('sheet-handle').addEventListener('click', () => setSheet(sheetState === 'collapsed' ? 'half' : sheetState === 'half' ? 'full' : 'collapsed'));
document.querySelectorAll('.sheet-tab').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === sheetTab && sheetState !== 'collapsed') return setSheet('collapsed'); // tap the open tab again to fold
  setSheetTab(b.dataset.tab);
}));
window.addEventListener('resize', () => { if (document.body.classList.contains('mobile')) setSheet(sheetState); });

// ---- ☰ menu ----
const mMenu = $('mobile-menu');
$('btn-mobile-menu').addEventListener('click', (e) => { e.stopPropagation(); mMenu.classList.toggle('hidden'); });
document.addEventListener('click', (e) => { if (!mMenu.contains(e.target) && !e.target.closest('#btn-mobile-menu')) mMenu.classList.add('hidden'); });
mMenu.addEventListener('click', (e) => {
  const b = e.target.closest('.mm-item');
  if (!b) return;
  e.stopPropagation(); // don't let the page-wide "close popovers" handler undo what this item opens
  mMenu.classList.add('hidden');
  const act = b.dataset.act;
  if (act === 'import') fileInput.click();
  else if (act === 'add') { $('shape-popover').classList.remove('hidden'); }
  else if (act === 'new') $('nav-new').click();
  else if (act === 'sample') loadSample(b.dataset.sample);
  else if (act === 'preview') setPreview(true);
  else if (act === 'grid') $('btn-toggle-grid').click();
  else if (act === 'light') { setLightPreset((Math.max(state.lightPreset, 0) + 1) % LIGHT_PRESETS.length); toast(`Lighting: <b>${LIGHT_PRESETS[state.lightPreset].name}</b>`, 'info', 1800); }
  else if (act === 'layout') { ui.layout = b.dataset.layout; saveUI(); applyLayout(); toast(`Layout: <b>${b.textContent.trim()}</b>`, 'info', 2000); }
});
autoMobileMQ.addEventListener('change', applyLayout);

// ---- 3D-view overlays ----
$('mobile-camtoggle').addEventListener('click', () => setCamType(state.camType === 'persp' ? 'ortho' : 'persp'));
$('mobile-import').addEventListener('click', () => fileInput.click());
const fmtDim = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
function updateMobileInfo() {
  const dims = $('mobile-dims'), tris = $('mobile-tris');
  if (!dims) return;
  if (!state.modelRoot) { dims.textContent = '—'; tris.textContent = 'empty scene'; return; }
  const target = state.scope || state.modelRoot;
  const b = new THREE.Box3().setFromObject(target);
  const sz = b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3());
  dims.textContent = `${fmtDim(sz.x)} × ${fmtDim(sz.y)} × ${fmtDim(sz.z)} units`;
  const st = scopeStats();
  const parts = scopeRecs().length;
  tris.textContent = `${fmtK(st.tris)} tris • ${parts} part${parts !== 1 ? 's' : ''}${state.scope ? ' • ' + (state.scope.name || '') : ''}`;
}

// ---- +/− steppers for the number boxes (touch-friendly) ----
const STEPS = { pos: () => { const t = transformTarget(); const b = t && new THREE.Box3().setFromObject(t); return b && !b.isEmpty() ? Math.max(+(b.getSize(new THREE.Vector3()).length() * 0.05).toPrecision(1), 0.01) : 0.1; }, rot: () => 15, scl: () => 0.1 };
for (const id of ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scl-x', 'scl-y', 'scl-z']) {
  const inp = $(id), wrap = inp.parentElement, kind = id.slice(0, 3);
  const box = document.createElement('div');
  box.className = 'stepper-btn flex-col shrink-0 border-l border-white/5';
  box.innerHTML = '<button type="button" class="px-2 py-0.5 text-on-surface-variant active:bg-surface-container-high" data-d="1">+</button><button type="button" class="px-2 py-0.5 text-on-surface-variant active:bg-surface-container-high" data-d="-1">−</button>';
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !transformTarget()) return;
    const cur = parseFloat(String(inp.value).replace(/[^0-9.eE+-]/g, '')) || 0;
    inp.value = +(cur + Number(b.dataset.d) * STEPS[kind]()).toFixed(4);
    commitTransformFromInputs();
  });
  wrap.appendChild(box);
}

// ---- face-select click mode, share, touch file pickers ----
document.querySelectorAll('.face-click-btn').forEach((b) => b.addEventListener('click', () => { faceClickMode = b.dataset.fclick; updateFacePanel(); }));
const canShareFiles = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })); } catch (e) { return false; } })();
$('btn-share').classList.toggle('share-off', !canShareFiles);
$('btn-share').addEventListener('click', () => doExport({ share: true }));
// Phone file pickers can grey out unfamiliar types (.obj, .fbx, .glb…); our own checks reject wrong files anyway
if (isTouch) fileInput.removeAttribute('accept');

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

$('app-version').textContent = APP_VERSION;
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
updatePartButtons();
updateFacePanel();
applyLayout();
updateMobileInfo();
updateDownloadLabel();
renderTexLibrary();
syncTextureControls();

console.info(`%cOnline 3D Studio ${APP_VERSION} ready — three.js r170, 100% client-side.`, 'color:#4cd7f6;font-weight:bold;');

// Expose a small API (handy for power users & automated tests)
window.aether3d = {
  state,
  handleFiles,
  loadSample,
  doExport,
  downloadOriginal,
  setViewMode,
  setTool,
  camera: () => activeCam,
  version: APP_VERSION,
  three: THREE.REVISION,
};
