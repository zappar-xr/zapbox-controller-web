import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ZapboxController, ZapboxControllerManager } from '../src/index.js';

// --- Three.js scene setup ---

const ASPECT = 16 / 9;
const container = document.getElementById('scene-container')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, ASPECT, 0.01, 100);
camera.position.set(0, 0.5, 1.2);

function resize() {
  const w = container.clientWidth;
  renderer.setSize(w, Math.round(w / ASPECT));
  camera.aspect = ASPECT;
  camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(container);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(1, 3, 2);
scene.add(dirLight);
scene.add(new THREE.AxesHelper(0.4));

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Controller model factory ---

function loadControllerModel(parent: THREE.Object3D): void {
  new GLTFLoader().load('./zapbox_controller_left.glb', (gltf) => {
    const model = gltf.scene;
    model.rotation.set(Math.PI / 2, 0, Math.PI);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(1 / Math.max(size.x, size.y, size.z));
    box.setFromObject(model).getCenter(model.position).negate();
    parent.add(model);
  });
}

// Controller roots — repositioned once we know how many controllers are paired
const roots: Map<'left' | 'right', THREE.Object3D> = new Map();

function addControllerRoot(side: 'left' | 'right', xOffset: number): THREE.Object3D {
  const root = new THREE.Object3D();
  root.position.x = xOffset;
  scene.add(root);
  loadControllerModel(root);
  roots.set(side, root);
  return root;
}

function attachController(controller: ZapboxController, side: 'left' | 'right') {
  const root = roots.get(side)!;
  controller.addEventListener('update', () => {
    if (!controller.isCalibrated) return;
    const q = controller.orientation;
    root.quaternion.set(q[0], q[1], q[2], q[3]);
  });
}

// --- UI wiring ---

const setupBtn = document.getElementById('setup-btn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const reconnectBtn = document.getElementById('reconnect-btn') as HTMLButtonElement;
const minSelect = document.getElementById('min-select') as HTMLSelectElement;
const maxSelect = document.getElementById('max-select') as HTMLSelectElement;
const recSelect = document.getElementById('rec-select') as HTMLSelectElement;
const optionSelects = [minSelect, maxSelect, recSelect];
const statusEl = document.getElementById('status')!;

setupBtn.addEventListener('click', async () => {
  setupBtn.disabled = true;
  for (const s of optionSelects) s.disabled = true;
  statusEl.textContent = 'Starting setup…';

  const min = parseInt(minSelect.value, 10);
  const max = parseInt(maxSelect.value, 10);
  const recommended = recSelect.value === '' ? undefined : parseInt(recSelect.value, 10);
  const manager = new ZapboxControllerManager({ min, max, recommended });

  // Remove any controller models from a previous setup
  for (const root of roots.values()) scene.remove(root);
  roots.clear();

  try {
    await manager.setup();
  } catch (err) {
    statusEl.textContent = `Setup failed: ${err instanceof Error ? err.message : String(err)}`;
    setupBtn.disabled = false;
    for (const s of optionSelects) s.disabled = false;
    return;
  }

  // The user can finish with no controllers (min 0) — just reset for another run.
  if (!manager.left && !manager.right) {
    statusEl.textContent = 'No controllers connected';
    setupBtn.disabled = false;
    for (const s of optionSelects) s.disabled = false;
    return;
  }

  // Build scene based on what was paired
  if (manager.left) {
    addControllerRoot('left', -0.5);
    attachController(manager.left, 'left');
  }
  if (manager.right) {
    addControllerRoot('right', 0.5);
    attachController(manager.right, 'right');
  }

  disconnectBtn.disabled = false;
  reconnectBtn.disabled = false;

  function updateStatus() {
    const entries = ([
      manager.left  ? { side: 'Left',  c: manager.left  } : null,
      manager.right ? { side: 'Right', c: manager.right } : null,
    ] as const).filter((x): x is { side: string; c: ZapboxController } => x !== null);

    const allConnected    = entries.every(({ c }) => c.connectionState === 'connected');
    const allDisconnected = entries.every(({ c }) => c.connectionState === 'disconnected');

    if (allConnected) {
      statusEl.textContent = entries.length === 2 ? 'Left + Right connected' : `${entries[0].side} connected`;
    } else if (allDisconnected) {
      statusEl.textContent = 'Disconnected';
      setupBtn.disabled = false;
      for (const s of optionSelects) s.disabled = false;
    } else {
      statusEl.textContent = entries
        .map(({ side, c }) => `${side}: ${c.connectionState === 'reconnecting' ? 'reconnecting…' : c.connectionState}`)
        .join(' · ');
    }
  }

  updateStatus();

  for (const c of [manager.left, manager.right]) {
    if (!c) continue;
    c.addEventListener('connected', updateStatus);
    c.addEventListener('reconnecting', updateStatus);
    c.addEventListener('disconnected', updateStatus);
  }

  disconnectBtn.addEventListener('click', () => { manager.disconnect(); });
  reconnectBtn.addEventListener('click', () => { manager.reconnect(); });
});
