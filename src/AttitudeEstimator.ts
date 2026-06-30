import { quat, vec3, mat3 } from 'gl-matrix';
import type { ProcessedIMUSample } from './types.js';
import { Vec3RollingAverage } from './Vec3RollingAverage.js';
import { Vec3RollingRange } from './Vec3RollingRange.js';

// Applied per sample. At 200 Hz with ~15ms notifications (~3 samples/notification),
// 0.003 is roughly equivalent to a per-notification alpha of 0.01.
const GRAVITY_ALPHA = 0.003;
const Y_UP: vec3 = vec3.fromValues(0, 1, 0);
const ACCEL_RANGE_THRESHOLD = 1.0;       // m/s² - gate for any correction
const ACCEL_RANGE_HIGH_CONFIDENCE = 0.25; // m/s² - apply 10x correction rate

export class AttitudeEstimator {
  private _gyroOrientation = quat.identity(quat.create());
  private _uprightOrientation = quat.identity(quat.create());
  private gravityCorrection = quat.identity(quat.create());
  private readonly accelAvg = new Vec3RollingAverage(50);
  private readonly accelAvgHistory = new Vec3RollingRange(50);
  private lastTimestampUs = -1;
  private warmupSamples = 0;
  private _gravityWeight = 0;

  // Scratch buffers reused every sample to avoid GC pressure
  private readonly _tmpDeltaRads = vec3.create();
  private readonly _tmpAxis = vec3.create();
  private readonly _tmpDelta = quat.create();
  private readonly _tmpAccelInGyroSpace = vec3.create();
  private readonly _tmpGravityInGyro = vec3.create();
  private readonly _tmpCurrentGravityInUpright = vec3.create();
  private readonly _tmpCross = vec3.create();
  private readonly _tmpFullRotation = quat.create();
  private readonly _tmpCorrectionDelta = quat.create();
  private readonly _tmpIdentityQuat = quat.identity(quat.create());

  get gyroOrientation(): quat { return this._gyroOrientation; }
  get orientation(): quat { return this._uprightOrientation; }
  get gyroAccelAverage(): vec3 { return this.accelAvg.current; }
  /** Weight applied to gravity correction on the last sample. 0 = not applied. */
  get gravityWeight(): number { return this._gravityWeight; }
  /** Range of the accel average output over the last 50 samples (m/s²). */
  get gyroAccelAvgHistoryMaxRange(): number { return this.accelAvgHistory.maxRange; }
  get gyroAccelAvgHistoryRange(): vec3 { return this.accelAvgHistory.range; }
  get gyroAccelAvgHistoryMin(): vec3 { return this.accelAvgHistory.currentMin; }
  get gyroAccelAvgHistoryMax(): vec3 { return this.accelAvgHistory.currentMax; }

  update(sample: ProcessedIMUSample): void {
    const { timestampUs, rotationRate, acceleration } = sample;

    if (this.lastTimestampUs < 0) {
      this.lastTimestampUs = timestampUs;
      return;
    }

    const diffUs = timestampUs - this.lastTimestampUs;
    this.lastTimestampUs = timestampUs;

    if (diffUs > 100_000) return; // gap > 100ms -- skip integration

    const dt = diffUs * 1e-6;
    vec3.set(this._tmpDeltaRads, rotationRate[0] * dt, rotationRate[1] * dt, rotationRate[2] * dt);
    const angle = vec3.length(this._tmpDeltaRads);
    if (angle > 0) {
      vec3.scale(this._tmpAxis, this._tmpDeltaRads, 1 / angle);
      quat.setAxisAngle(this._tmpDelta, this._tmpAxis, angle);
      quat.multiply(this._gyroOrientation, this._gyroOrientation, this._tmpDelta);
      quat.normalize(this._gyroOrientation, this._gyroOrientation);
    }

    vec3.transformQuat(this._tmpAccelInGyroSpace, acceleration, this._gyroOrientation);
    this.accelAvg.addSample(this._tmpAccelInGyroSpace);
    this.accelAvgHistory.addSample(this.accelAvg.current);
    if (this.warmupSamples < 100) this.warmupSamples++;

    // Incremental gravity correction (Mahony-style)
    const magnitude = vec3.length(this.accelAvg.current);
    this._gravityWeight = 0;
    if (this.warmupSamples >= 100 && Math.abs(magnitude - 9.80665) <= 1.5 && this.accelAvgHistory.maxRange < ACCEL_RANGE_THRESHOLD) {
      this._gravityWeight = this.accelAvgHistory.maxRange < ACCEL_RANGE_HIGH_CONFIDENCE
        ? GRAVITY_ALPHA * 10
        : GRAVITY_ALPHA;
      vec3.normalize(this._tmpGravityInGyro, this.accelAvg.current);
      vec3.transformQuat(this._tmpCurrentGravityInUpright, this._tmpGravityInGyro, this.gravityCorrection);

      vec3.cross(this._tmpCross, this._tmpCurrentGravityInUpright, Y_UP);
      const dotVal = vec3.dot(this._tmpCurrentGravityInUpright, Y_UP);
      if (1 + dotVal > 1e-6) {
        // Minimum-rotation quaternion from currentGravityInUpright to Y_UP, no acos needed
        quat.set(this._tmpFullRotation, this._tmpCross[0], this._tmpCross[1], this._tmpCross[2], 1 + dotVal);
        quat.normalize(this._tmpFullRotation, this._tmpFullRotation);
        quat.slerp(this._tmpCorrectionDelta, this._tmpIdentityQuat, this._tmpFullRotation, this._gravityWeight);
        quat.multiply(this.gravityCorrection, this._tmpCorrectionDelta, this.gravityCorrection);
        quat.normalize(this.gravityCorrection, this.gravityCorrection);
      }
    }

    quat.multiply(this._uprightOrientation, this.gravityCorrection, this._gyroOrientation);
  }

  initializeWithGravity(gravityInController: vec3): void {
    const yAxis = vec3.normalize(vec3.create(), gravityInController);

    // Gram-Schmidt: project controller Z onto the plane perpendicular to gravity
    const zProj = vec3.sub(
      vec3.create(), vec3.fromValues(0, 0, 1),
      vec3.scale(vec3.create(), yAxis, yAxis[2]),
    );

    let xAxis: vec3;
    let zAxis: vec3;
    if (vec3.length(zProj) > 0.3) {
      zAxis = vec3.normalize(vec3.create(), zProj);
      xAxis = vec3.cross(vec3.create(), yAxis, zAxis);
    } else {
      // Controller Z is nearly vertical; use X instead
      const xProj = vec3.sub(
        vec3.create(), vec3.fromValues(1, 0, 0),
        vec3.scale(vec3.create(), yAxis, yAxis[0]),
      );
      xAxis = vec3.normalize(vec3.create(), xProj);
      zAxis = vec3.cross(vec3.create(), xAxis, yAxis);
    }

    // Rotation matrix with xAxis/yAxis/zAxis as rows; column-major for gl-matrix
    const m = mat3.fromValues(
      xAxis[0], yAxis[0], zAxis[0],
      xAxis[1], yAxis[1], zAxis[1],
      xAxis[2], yAxis[2], zAxis[2],
    );
    quat.fromMat3(this.gravityCorrection, m);
    quat.normalize(this.gravityCorrection, this.gravityCorrection);
    quat.copy(this._uprightOrientation, this.gravityCorrection);
  }

  markDisconnected(): void {
    this.lastTimestampUs = -1;
    this.warmupSamples = 0;
    this.accelAvg.reset();
    this.accelAvgHistory.reset();
  }

  reset(): void {
    quat.identity(this._gyroOrientation);
    quat.identity(this._uprightOrientation);
    quat.identity(this.gravityCorrection);
    this.accelAvg.reset();
    this.accelAvgHistory.reset();
    this.lastTimestampUs = -1;
    this.warmupSamples = 0;
  }
}
