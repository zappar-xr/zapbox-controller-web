import * as THREE from 'three';
import { quat } from 'gl-matrix';
import { ZapboxController } from '../src/index.js';
import type { ButtonState } from '../src/index.js';
import { scene, modelRoot } from './scene.js';

const accelArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 0),
  0.4,
  0xffaa00,
);
modelRoot.add(accelArrow);

// Group driven by the gyro->world transform; AxesHelper shows gyro-space basis in world coords
const gyroAxesRoot = new THREE.Object3D();
gyroAxesRoot.add(new THREE.AxesHelper(0.3));
scene.add(gyroAxesRoot);

const accelAvgArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 0),
  0.4,
  0x00ffff,
);
gyroAxesRoot.add(accelAvgArrow);

const rangeCube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true }),
);
rangeCube.scale.setScalar(0);
gyroAxesRoot.add(rangeCube);




const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;
const reconnectBtn = document.getElementById('reconnect') as HTMLButtonElement;
const resetForwardBtn = document.getElementById('reset-forward') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const calibrationEl = document.getElementById('calibration')!;
const metricsPlot = document.getElementById('metrics-plot') as HTMLCanvasElement;
const plotCtx = metricsPlot.getContext('2d')!;

const PLOT_SAMPLES = 600;
const avgHistoryBuffer = new Float32Array(PLOT_SAMPLES);
let plotHead = 0;
let plotCount = 0;

function pushPlotSample(avgHistoryRange: number) {
  avgHistoryBuffer[plotHead] = avgHistoryRange;
  plotHead = (plotHead + 1) % PLOT_SAMPLES;
  if (plotCount < PLOT_SAMPLES) plotCount++;

  const w = metricsPlot.width;
  const h = metricsPlot.height;
  plotCtx.fillStyle = '#1a1a1a';
  plotCtx.fillRect(0, 0, w, h);

  plotCtx.strokeStyle = '#2a2a2a';
  plotCtx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) {
    plotCtx.beginPath();
    plotCtx.moveTo(0, h * f);
    plotCtx.lineTo(w, h * f);
    plotCtx.stroke();
  }

  const histMax = 1.0;
  plotCtx.strokeStyle = '#ff8800';
  plotCtx.lineWidth = 1.5;
  plotCtx.beginPath();
  for (let i = 0; i < plotCount; i++) {
    const idx = (plotHead - plotCount + i + PLOT_SAMPLES) % PLOT_SAMPLES;
    const x = (i / (PLOT_SAMPLES - 1)) * w;
    const y = h - (avgHistoryBuffer[idx] / histMax) * (h - 4) - 2;
    if (i === 0) plotCtx.moveTo(x, y); else plotCtx.lineTo(x, y);
  }
  plotCtx.stroke();

  plotCtx.font = '10px monospace';
  plotCtx.fillStyle = '#ff8800';
  plotCtx.fillText(`avg hist (fixed max 1.0)`, 4, 12);
};
const controlsSection = document.getElementById('controls') as HTMLElement;
const debugSection = document.getElementById('debug') as HTMLElement;
const infoData = document.getElementById('info-data')!;
const inputData = document.getElementById('input-data')!;
const imuData = document.getElementById('imu-data')!;

const thumbstickDot = document.getElementById('thumbstick-dot')!;
const triggerFill = document.getElementById('trigger-fill')!;

function updateThumbstick(x: number, y: number) {
  // x: -1 (left) to +1 (right), y: -1 (down) to +1 (up)
  thumbstickDot.style.left = `${50 + x * 38}%`;
  thumbstickDot.style.top  = `${50 - y * 38}%`;
}

const btnEls: Partial<Record<keyof ButtonState, HTMLElement>> = {
  a: document.getElementById('btn-a')!,
  b: document.getElementById('btn-b')!,
  menu: document.getElementById('btn-menu')!,
  grip: document.getElementById('btn-grip')!,
};

function updateButtons(buttons: ButtonState) {
  for (const key of Object.keys(btnEls) as (keyof ButtonState)[]) {
    btnEls[key]!.classList.toggle('pressed', buttons[key]);
  }
  thumbstickDot.classList.toggle('pressed', buttons.thumbstickClick);
}

let controller: ZapboxController | null = null;
let calibrationComplete = false;
let infoInterval: ReturnType<typeof setInterval> | null = null;

function stopInfoPolling() {
  if (infoInterval !== null) {
    clearInterval(infoInterval);
    infoInterval = null;
  }
}

function onDisconnected() {
  stopInfoPolling();
  statusEl.textContent = 'Disconnected';
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  reconnectBtn.hidden = false;
  resetForwardBtn.hidden = true;
}

function onReconnecting() {
  stopInfoPolling();
  statusEl.textContent = 'Reconnecting…';
  reconnectBtn.hidden = true;
  resetForwardBtn.hidden = true;
}

function onConnected(c: ZapboxController) {
  reconnectBtn.hidden = true;
  resetForwardBtn.hidden = false;
  statusEl.textContent = `Connected: ${c.deviceName}`;
  calibrationEl.hidden = false;
  metricsPlot.hidden = false;
  plotHead = 0;
  plotCount = 0;
  calibrationComplete = c.isCalibrated;
  calibrationEl.textContent = calibrationComplete
    ? 'Gyro calibrated'
    : 'Place controller on a stationary surface to calibrate motion sensors';
  disconnectBtn.disabled = false;
  controlsSection.style.display = 'block';
  debugSection.style.display = 'block';

  infoData.textContent = JSON.stringify(c.info, null, 2);

  infoInterval = setInterval(async () => {
    try {
      const info = await c.readInfo();
      infoData.textContent = JSON.stringify(info, null, 2);
    } catch {
      stopInfoPolling();
    }
  }, 2000);
}

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  statusEl.textContent = 'Connecting…';
  try {
    controller = await ZapboxController.connect();
    onConnected(controller);
    controller.addEventListener('connected', () => onConnected(controller!));
    controller.addEventListener('reconnecting', onReconnecting);
    controller.addEventListener('update', (ev) => {
      const { inputState, imuSamples } = ev.detail;
      updateButtons(inputState.buttons);
      updateThumbstick(inputState.thumbstickX, inputState.thumbstickY);
      triggerFill.style.height = `${inputState.trigger * 100}%`;
      triggerFill.classList.toggle('pressed', inputState.buttons.trigger);
      inputData.textContent = JSON.stringify(inputState, null, 2);
      imuData.textContent = JSON.stringify(imuSamples, null, 2);

      if (controller!.isCalibrated) {
        if (!calibrationComplete) {
          calibrationEl.textContent = 'Gyro calibrated';
          calibrationComplete = true;
        }
        for (const s of imuSamples) {
          if (s.accelAvgHistoryMaxRange !== undefined) {
            pushPlotSample(s.accelAvgHistoryMaxRange);
          }
        }
        const q = controller!.orientation;
        modelRoot.quaternion.set(q[0], q[1], q[2], q[3]);

        // gyroAxesRoot: orientation * inv(gyroOrientation) = gyro->world transform
        const gyroQ = controller!.gyroOrientation;
        const invGyro = quat.conjugate(quat.create(), gyroQ);
        const gyroToWorld = quat.multiply(quat.create(), q, invGyro);
        gyroAxesRoot.quaternion.set(gyroToWorld[0], gyroToWorld[1], gyroToWorld[2], gyroToWorld[3]);
      }

      const lastSample = imuSamples[imuSamples.length - 1];
      if (lastSample) {
        const a = lastSample.acceleration;
        const vec = new THREE.Vector3(a[0], a[1], a[2]);
        const magnitude = vec.length();
        if (magnitude > 0) {
          accelArrow.setDirection(vec.divideScalar(magnitude));
          accelArrow.setLength(magnitude / 9.80665 * 0.5);
        }

        const avg = controller!.gyroAccelAverage;
        const avgVec = new THREE.Vector3(avg[0], avg[1], avg[2]);
        const avgMagnitude = avgVec.length();
        if (avgMagnitude > 0) {
          accelAvgArrow.setDirection(avgVec.divideScalar(avgMagnitude));
          accelAvgArrow.setLength(avgMagnitude / 9.80665 * 0.5);
          accelAvgArrow.setColor(
            controller!.gravityWeight === 0 ? 0x006666 :
            controller!.gravityWeight > 0.01 ? 0xffff00 : 0x00ffff
          );
        }

        const r = controller!.gyroAccelAvgHistoryRange;
        const rMin = controller!.gyroAccelAvgHistoryMin;
        const rMax = controller!.gyroAccelAvgHistoryMax;
        const s = 1 / 9.80665 * 0.5;
        rangeCube.scale.set(r[0] * s, r[1] * s, r[2] * s);
        rangeCube.position.set(
          (rMin[0] + rMax[0]) / 2 * s,
          (rMin[1] + rMax[1]) / 2 * s,
          (rMin[2] + rMax[2]) / 2 * s,
        );
      }


    });
    controller.addEventListener('disconnected', onDisconnected);
  } catch (err) {
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    connectBtn.disabled = false;
  }
});

reconnectBtn.addEventListener('click', () => {
  controller!.reconnect(); // fires 'reconnecting' then 'connected' events to drive UI
});

disconnectBtn.addEventListener('click', async () => {
  await controller?.disconnect();
});

resetForwardBtn.addEventListener('click', () => {
  controller?.resetForward(0, -1);
});
