import { vec3 } from 'gl-matrix';

const GYRO_RANGE_THRESHOLD = 20;   // raw int16, matches C++
const ACCEL_RANGE_THRESHOLD = 200; // raw int16, ~0.1g
const SAMPLES_NEEDED = 100;

export class IMUCalibrator {
  private _isCalibrated = false;

  private _gyroBias = vec3.create();
  private gyroMin = vec3.create();
  private gyroMax = vec3.create();
  private gyroTotal = vec3.create();

  private _accelAverage = vec3.create();
  private accelMin = vec3.create();
  private accelMax = vec3.create();
  private accelTotal = vec3.create();

  private numSamples = 0;

  get isCalibrated(): boolean { return this._isCalibrated; }
  get gyroBias(): vec3 { return this._gyroBias; } // raw int16
  get accelAverage(): vec3 { return this._accelAverage; } // raw int16, IMU coords

  supplySample(gyro: vec3, accel: vec3): void {
    if (this._isCalibrated) return;

    if (this.numSamples === 0) {
      vec3.copy(this.gyroMin, gyro);
      vec3.copy(this.gyroMax, gyro);
      vec3.copy(this.gyroTotal, gyro);
      vec3.copy(this.accelMin, accel);
      vec3.copy(this.accelMax, accel);
      vec3.copy(this.accelTotal, accel);
      this.numSamples = 1;
      return;
    }

    // Mirror C++: add to totals first, then check ranges
    vec3.add(this.gyroTotal, this.gyroTotal, gyro);
    vec3.add(this.accelTotal, this.accelTotal, accel);

    for (let i = 0; i < 3; i++) {
      if (gyro[i] < this.gyroMin[i]) this.gyroMin[i] = gyro[i];
      if (gyro[i] > this.gyroMax[i]) this.gyroMax[i] = gyro[i];
      if (this.gyroMax[i] - this.gyroMin[i] > GYRO_RANGE_THRESHOLD) {
        this.numSamples = 0;
        return;
      }

      if (accel[i] < this.accelMin[i]) this.accelMin[i] = accel[i];
      if (accel[i] > this.accelMax[i]) this.accelMax[i] = accel[i];
      if (this.accelMax[i] - this.accelMin[i] > ACCEL_RANGE_THRESHOLD) {
        this.numSamples = 0;
        return;
      }
    }

    this.numSamples++;
    if (this.numSamples === SAMPLES_NEEDED) {
      vec3.scale(this._gyroBias, this.gyroTotal, 1 / SAMPLES_NEEDED);
      vec3.scale(this._accelAverage, this.accelTotal, 1 / SAMPLES_NEEDED);
      this._isCalibrated = true;
    }
  }

  reset(): void {
    this._isCalibrated = false;
    vec3.set(this._gyroBias, 0, 0, 0);
    vec3.set(this._accelAverage, 0, 0, 0);
    this.numSamples = 0;
  }
}
