import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { installZapboxWebXR } from '../src/index.js';

// --- renderer / scene ------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101015);
scene.fog = new THREE.Fog(0x101015, 8, 30);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
// Mirror the teleportation sample: a floor-relative base, so the player stands on the grid.
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

function resize(): void {
  if (renderer.xr.isPresenting) return;
  const { clientWidth: w, clientHeight: h } = renderer.domElement;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
resize();
window.addEventListener('resize', resize);
renderer.xr.addEventListener('sessionend', resize);

// Always pair two controllers — locomotion needs both thumbsticks. No-ops (page stays a plain WebXR
// page) off supported environments; install before the VR button so it reads the proxied navigator.xr.
installZapboxWebXR({ min: 2, max: 2 }).then(() => {
  document.body.appendChild(VRButton.createButton(renderer));
});

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
const dir = new THREE.DirectionalLight(0xffffff, 1.5);
dir.position.set(1, 3, 2);
scene.add(dir);

// A large grid plus a field of pillars at varied positions/heights, so gliding and turning are
// obviously registering as movement through a fixed world.
scene.add(new THREE.GridHelper(60, 120, 0x444466, 0x222233));

// Axis markers resting on the grid so world-space forward is legible: red = +X, blue = +Z. Cylinders
// rather than LINEs, which alias badly on mobile VR displays.
function addAxis(axis: 'x' | 'z', color: number): void {
  const length = 2.5;
  const radius = 0.03;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 16),
    new THREE.MeshStandardMaterial({ color }),
  );
  // CylinderGeometry runs along +Y; lay it along the target axis, spanning origin → +length.
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

const pillarGeo = new THREE.BoxGeometry(0.4, 1, 0.4);
for (let i = 0; i < 60; i++) {
  const angle = i * 2.399963; // golden-angle scatter
  const radius = 2 + (i / 60) * 20;
  const h = 0.6 + (i % 5) * 0.5;
  const pillar = new THREE.Mesh(
    pillarGeo,
    new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL((i / 60) % 1, 0.55, 0.5) }),
  );
  pillar.scale.y = h;
  pillar.position.set(Math.cos(angle) * radius, h / 2, Math.sin(angle) * radius);
  scene.add(pillar);
}

// --- controllers -----------------------------------------------------------

interface Hand {
  obj: THREE.Object3D | null; // targetRay-space object (its world quaternion is the pointing pose)
  source: XRInputSource | null; // live input source; .gamepad.axes update in place
}
const hands: Record<'left' | 'right', Hand> = { left: { obj: null, source: null }, right: { obj: null, source: null } };

const modelFactory = new XRControllerModelFactory();

function addController(index: number): void {
  const controller = renderer.xr.getController(index);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff }),
  );
  line.scale.z = 5;
  line.visible = false;
  controller.add(line);
  controller.addEventListener('connected', (e) => {
    const source = e.data as XRInputSource;
    line.visible = source.targetRayMode === 'tracked-pointer';
    if (source.handedness === 'left' || source.handedness === 'right') {
      hands[source.handedness] = { obj: controller, source };
    }
  });
  controller.addEventListener('disconnected', (e) => {
    line.visible = false;
    const source = e.data as XRInputSource | undefined;
    if (source && (source.handedness === 'left' || source.handedness === 'right')) {
      hands[source.handedness] = { obj: null, source: null };
    }
  });
  scene.add(controller);

  const grip = renderer.xr.getControllerGrip(index);
  grip.add(modelFactory.createControllerModel(grip));
  scene.add(grip);
}
addController(0);
addController(1);

// --- locomotion ------------------------------------------------------------

const SPEED = 2.0; // metres / second at full stick
const MOVE_DEADZONE = 0.15;
const MIN_HORIZONTAL = 0.25; // horizontal length of the pointing dir below which we treat it as vertical (no motion)
const SNAP_ANGLE = Math.PI / 9; // 20°
const TURN_ON = 0.7; // stick magnitude that triggers a snap turn...
const TURN_OFF = 0.3; // ...and that it must fall back under before another can fire (hysteresis)

const UP = new THREE.Vector3(0, 1, 0);
const tmpQuat = new THREE.Quaternion();
const tmpYaw = new THREE.Quaternion();
const tmpDir = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpMove = new THREE.Vector3();

// Player pose in the (fixed) world the scene lives in. We express it as an offset reference space
// derived from the base each frame; the viewer's physical head rides on top.
const playerPos = new THREE.Vector3();
let playerYaw = 0;
let turnArmed = true;

let baseRefSpace: XRReferenceSpace | null = null;

renderer.xr.addEventListener('sessionstart', () => {
  // The reference space three.js just requested is our base (the shim tracks it as a recenter root).
  // Capture it once; we always derive the player's offset space from THIS, never from a moved one.
  baseRefSpace = renderer.xr.getReferenceSpace();
  playerPos.set(0, 0, 0);
  playerYaw = 0;
  turnArmed = true;
  // Render through an offset space from frame 1 (identity at spawn), like the teleportation sample —
  // so we exercise the shim's derived-offset-space path even before moving. Rebuilt only on change
  // (see updateLocomotion), matching how the sample reuses its offset space between teleports.
  applyPlayerPose();

  // The shim fires 'reset' on a recenter (the controller full-reset gesture), with event.transform =
  // the origin shift (recenter yaw delta). How we respond is a pre-XR choice (radios) — see resetMode:
  //  - origin:  return to spawn, forward = gaze.
  //  - ignore:  absorb the shift into our own yaw so the view doesn't move at all (fold in the delta).
  //  - heading: face the new forward (gaze), keep position (approx: head assumed near the base origin).
  // Applied here, before the frame renders (the shim dispatches pre-frame), so it takes effect this frame.
  baseRefSpace?.addEventListener('reset', (e) => {
    switch (resetMode()) {
      case 'origin':
        playerPos.set(0, 0, 0);
        playerYaw = 0;
        break;
      case 'ignore':
        playerYaw += yawOf(e.transform); // += delta keeps the rendered view exactly put
        break;
      case 'heading':
        playerYaw = 0;
        break;
    }
    turnArmed = true;
    applyPlayerPose();
  });
});

/** The pre-XR-selected recenter response. */
function resetMode(): string {
  return (document.querySelector('input[name="resetMode"]:checked') as HTMLInputElement | null)?.value ?? 'origin';
}

/** Yaw (about +Y) of a rigid transform's rotation, or 0 if absent. */
function yawOf(transform: XRRigidTransform | undefined): number {
  if (!transform) return 0;
  const o = transform.orientation;
  return new THREE.Euler().setFromQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w), 'YXZ').y;
}
renderer.xr.addEventListener('sessionend', () => {
  baseRefSpace = null;
});

function updateLocomotion(dt: number): void {
  let moved = false;

  // Glide: right thumbstick maps to a 2D direction in the ground plane, oriented to the right
  // controller — push the stick any way and the user slides that way (up = along where the controller
  // points, right = to its right). Held level it reads like a top-down joystick.
  const rightPad = hands.right.source?.gamepad;
  const rightObj = hands.right.obj;
  if (rightPad && rightObj) {
    const stickX = rightPad.axes[2] ?? 0; // right = +
    const stickY = -(rightPad.axes[3] ?? 0); // up = + (axes[3] is −up; the shim negates Y)
    if (Math.hypot(stickX, stickY) > MOVE_DEADZONE) {
      rightObj.getWorldQuaternion(tmpQuat);
      tmpDir.set(0, 0, -1).applyQuaternion(tmpQuat); // controller pointing (−Z) in world coords
      tmpDir.y = 0; // project the heading to the ground plane
      if (tmpDir.length() > MIN_HORIZONTAL) {
        // skip when the controller points near-vertical
        tmpDir.normalize();
        tmpRight.crossVectors(tmpDir, UP).normalize(); // ground-plane "right" of the heading
        // move = heading·stickY + right·stickX; the stick's own circular clamp caps |move| at 1
        tmpMove.copy(tmpDir).multiplyScalar(stickY).addScaledVector(tmpRight, stickX);
        playerPos.addScaledVector(tmpMove, SPEED * dt);
        moved = true;
      }
    }
  }

  // Snap turn: left thumbstick X, one 30° step per push (must recentre before the next fires).
  const turnX = hands.left.source?.gamepad?.axes[2] ?? 0;
  if (turnArmed && Math.abs(turnX) > TURN_ON) {
    playerYaw -= Math.sign(turnX) * SNAP_ANGLE; // stick right ⇒ turn right
    turnArmed = false;
    moved = true;
  } else if (Math.abs(turnX) < TURN_OFF) {
    turnArmed = true;
  }

  // Only rebuild the offset reference space when the pose actually changed; otherwise three.js keeps
  // using the last one we set (and, before the first move, the base — which the shim still recenters).
  if (moved) applyPlayerPose();
}

// Rebuild the offset reference space for the current player pose and hand it to three.js. Placing the
// origin at the inverse of the player pose makes the viewer appear at (playerPos, playerYaw) in the
// fixed world — the getOffsetReferenceSpace locomotion pattern the teleportation sample uses.
function applyPlayerPose(): void {
  if (!baseRefSpace) return;
  tmpYaw.setFromAxisAngle(UP, playerYaw);
  const pose = new XRRigidTransform(
    { x: playerPos.x, y: playerPos.y, z: playerPos.z },
    { x: tmpYaw.x, y: tmpYaw.y, z: tmpYaw.z, w: tmpYaw.w },
  );
  renderer.xr.setReferenceSpace(baseRefSpace.getOffsetReferenceSpace(pose.inverse));
}

let lastTime = 0;
renderer.setAnimationLoop((time, frame) => {
  const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0;
  lastTime = time;
  if (frame && baseRefSpace) updateLocomotion(dt);
  renderer.render(scene, camera);
});
