import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const ASPECT = 3 / 2;

const container = document.getElementById('scene-container')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(60, ASPECT, 0.01, 100);
camera.position.set(0, 1, 1);

function resize() {
  const w = container.clientWidth;
  renderer.setSize(w, Math.round(w / ASPECT));
  camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(container);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 1));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(0, 2, 0);
scene.add(dirLight);

export { scene };
export const modelRoot = new THREE.Object3D();
scene.add(modelRoot);

new GLTFLoader().load('./zapbox_controller_left.glb', (gltf) => {
  const model = gltf.scene;
  // Align to WebXR convention: aim = -Z, right = +X
  model.rotation.set(Math.PI / 2, 0, Math.PI);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.scale.setScalar(1 / Math.max(size.x, size.y, size.z));
  box.setFromObject(model).getCenter(model.position).negate();
  modelRoot.add(model);
});

scene.add(new THREE.AxesHelper(0.6));

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
