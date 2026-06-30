import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { installZapboxWebXR } from '../src/index.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101015);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// CSS sizes the canvas (width/height: 100%); we just match the drawing buffer to its laid-out size.
// Reading the canvas's own clientWidth/Height — not window.innerWidth — can't be inflated by
// overflowing content. Skip while presenting (three.js owns the framebuffer); re-run on sessionend so
// the page returns to its pre-VR layout.
function resize(): void {
  if (renderer.xr.isPresenting) return;
  const { clientWidth: w, clientHeight: h } = renderer.domElement;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false); // false: leave the CSS size to the stylesheet
}
resize();
window.addEventListener('resize', resize);
renderer.xr.addEventListener('sessionend', resize);

// The one and only Zapbox-specific call. No-ops on unsupported environments (e.g. desktop),
// where this page just behaves as an ordinary WebXR page with no controllers. Install before
// creating the VR button so it reads the proxied navigator.xr.
installZapboxWebXR().then(() => {
  document.body.appendChild(VRButton.createButton(renderer));
});

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
const dir = new THREE.DirectionalLight(0xffffff, 1.5);
dir.position.set(1, 3, 2);
scene.add(dir);

scene.add(new THREE.GridHelper(10, 20, 0x444466, 0x222233));

// Axis markers resting on the grid: red = +X, blue = +Z. Cylinders rather than line-based arrows,
// since single-pixel LINEs alias badly on mobile VR displays.
function addAxis(axis: 'x' | 'z', color: number): void {
  const length = 1.5;
  const radius = 0.025;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 16),
    new THREE.MeshStandardMaterial({ color }),
  );
  // CylinderGeometry runs along +Y; rotate so it lies along the target axis, centred at radius
  // above the grid and spanning origin → +length.
  if (axis === 'x') {
    mesh.rotation.z = -Math.PI / 2;
    mesh.position.set(length / 2, radius, 0);
  } else {
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(0, radius, length / 2);
  }
  scene.add(mesh);
}
addAxis('x', 0xff0000); // +X red
addAxis('z', 0x0000ff); // +Z blue

// A few reference boxes so head tracking is visibly working.
for (let i = 0; i < 6; i++) {
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.3, 0.3),
    new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 6, 0.6, 0.5) }),
  );
  const angle = (i / 6) * Math.PI * 2;
  box.position.set(Math.sin(angle) * 2, 1.2, -Math.cos(angle) * 2);
  scene.add(box);
}

// --- Controllers: 100% standard WebXR, no Zapbox references ---

const modelFactory = new XRControllerModelFactory();

function addController(index: number): void {
  const controller = renderer.xr.getController(index);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff }),
  );
  line.scale.z = 5;
  line.visible = false; // shown only for tracked-pointer sources (see 'connected' below)
  controller.add(line);
  controller.addEventListener('selectstart', () => ((line.material as THREE.LineBasicMaterial).color.set(0x00ff88)));
  controller.addEventListener('selectend', () => ((line.material as THREE.LineBasicMaterial).color.set(0xffffff)));
  // Only draw the pointer ray for real controllers (targetRayMode 'tracked-pointer'). Chrome's
  // Cardboard gaze source (targetRayMode 'gaze') can also land in a controller slot, but a laser
  // out of the head reads as a stray line between the eyes — so suppress it there.
  controller.addEventListener('connected', (e) => {
    line.visible = e.data.targetRayMode === 'tracked-pointer';
  });
  controller.addEventListener('disconnected', () => {
    line.visible = false;
  });
  scene.add(controller);

  const grip = renderer.xr.getControllerGrip(index);
  grip.add(modelFactory.createControllerModel(grip));
  scene.add(grip);
}

addController(0);
addController(1);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
