import { vec3, quat } from 'gl-matrix';
import { SERVICE_UUID, STREAMING_DATA_UUID, CONNECTION_INTERVAL_UUID, INFO_UUID, ACCEL_SCALE, GYRO_SCALE } from './constants.js';
import { parseInputState, IMUSampleParser } from './parser.js';
import type { ControllerInfo, ConnectOptions, ConnectionState, InputState, ControllerUpdate, IMUSample, ProcessedIMUSample } from './types.js';
import { AttitudeEstimator } from './AttitudeEstimator.js';
import { IMUCalibrator } from './IMUCalibrator.js';
import { AutoCalibratedAnalogTrigger } from './AutoCalibratedAnalogTrigger.js';
import { yawAlign } from './yawAlign.js';

// Typed overloads for addEventListener/removeEventListener
export interface ZapboxController {
  addEventListener(type: 'update', listener: (ev: CustomEvent<ControllerUpdate>) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: 'connected', listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: 'reconnecting', listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: 'disconnected', listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: 'update', listener: (ev: CustomEvent<ControllerUpdate>) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: 'connected', listener: (ev: Event) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: 'reconnecting', listener: (ev: Event) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: 'disconnected', listener: (ev: Event) => void, options?: boolean | EventListenerOptions): void;
}

export class ZapboxController extends EventTarget {
  readonly info: ControllerInfo;
  readonly deviceName: string;
  readonly deviceId: string;

  private _latestInputState: InputState = {
    buttons: { trigger: false, a: false, b: false, menu: false, grip: false, thumbstickClick: false },
    trigger: 0,
    thumbstickX: 128,
    thumbstickY: 128,
  };

  private readonly device: BluetoothDevice;
  private streamingCharacteristic: BluetoothRemoteGATTCharacteristic;
  private infoCharacteristic: BluetoothRemoteGATTCharacteristic;
  private readonly sampleParser: IMUSampleParser;
  private readonly attitudeEstimator = new AttitudeEstimator();
  private readonly imuCalibrator = new IMUCalibrator();
  private readonly triggerProcessor = new AutoCalibratedAnalogTrigger();
  private triggerActive = false;
  private analogXCenter = 127;
  private analogYCenter = 127;
  private _yawOffset = quat.identity(quat.create());
  private readonly _orientation = quat.create();
  private _connectionState: ConnectionState = 'disconnected';
  private _reconnecting = false;
  private _activated = false;
  private _connectionInterval: number | undefined;
  private readonly boundHandleNotification: (event: Event) => void;
  private readonly _boundHandleVisibilityChange: () => void;

  private constructor(
    device: BluetoothDevice,
    streamingCharacteristic: BluetoothRemoteGATTCharacteristic,
    infoCharacteristic: BluetoothRemoteGATTCharacteristic,
    info: ControllerInfo,
  ) {
    super();
    this.device = device;
    this.streamingCharacteristic = streamingCharacteristic;
    this.infoCharacteristic = infoCharacteristic;
    this.info = info;
    this.deviceName = device.name ?? 'Unknown';
    this.deviceId = device.id;
    this.sampleParser = new IMUSampleParser(info.major, info.minor);
    this.boundHandleNotification = this.handleNotification.bind(this);
    this._boundHandleVisibilityChange = () => {
      if (document.hidden) {
        if (this._connectionState !== 'disconnected') {
          this._doDisconnect();
        }
      } else if (this._activated) {
        this.reconnect();
      }
    };

    streamingCharacteristic.addEventListener('characteristicvaluechanged', this.boundHandleNotification);
    device.addEventListener('gattserverdisconnected', () => {
      this.attitudeEstimator.markDisconnected();
      if (this._shouldConnect) {
        this.reconnect();
      }
    });
    document.addEventListener('visibilitychange', this._boundHandleVisibilityChange);
  }

  /**
   * Opens the browser's Bluetooth device picker filtered to Zapbox controllers,
   * connects, reads firmware info, and starts streaming notifications.
   */
  static async connect(options: ConnectOptions = {}): Promise<ZapboxController> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });

    if (!device.gatt) {
      throw new Error('Bluetooth device does not expose a GATT server');
    }

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);

    const infoChar = await service.getCharacteristic(INFO_UUID);
    const infoValue = await infoChar.readValue();
    const info: ControllerInfo = {
      major: infoValue.getUint8(0),
      minor: infoValue.getUint8(1),
      mtu: infoValue.getUint8(2),
      pdu: infoValue.getUint8(3),
      connectionInterval: infoValue.getUint8(4),
    };

    const streamingChar = await service.getCharacteristic(STREAMING_DATA_UUID);
    const controller = new ZapboxController(device, streamingChar, infoChar, info);

    if (!options.defer) {
      await controller.activate(options.connectionInterval);
    }

    return controller;
  }

  get connectionState(): ConnectionState { return this._connectionState; }

  private get _shouldConnect(): boolean { return this._activated && !document.hidden; }

  /** Most recent input state — safe to read in a requestAnimationFrame loop. */
  get latestInputState(): InputState {
    return this._latestInputState;
  }

  /** Raw gyro-integrated orientation. Drifts on all axes. */
  get gyroOrientation(): quat { return this.attitudeEstimator.gyroOrientation; }

  /** Primary orientation output: gravity-aligned, yaw-offset applied. Only valid after isCalibrated. */
  get orientation(): quat {
    quat.multiply(this._orientation, this._yawOffset, this.attitudeEstimator.orientation);
    return this._orientation;
  }

  /** Rolling average of acceleration in gyro space. */
  get gyroAccelAverage(): vec3 { return this.attitudeEstimator.gyroAccelAverage; }

  /** Weight applied to gravity correction on the last sample. 0 = not applied. */
  get gravityWeight(): number { return this.attitudeEstimator.gravityWeight; }
  /** Range of the accel average output over the last ~50 samples (m/s²). */
  get gyroAccelAvgHistoryMaxRange(): number { return this.attitudeEstimator.gyroAccelAvgHistoryMaxRange; }
  get gyroAccelAvgHistoryRange(): vec3 { return this.attitudeEstimator.gyroAccelAvgHistoryRange; }
  get gyroAccelAvgHistoryMin(): vec3 { return this.attitudeEstimator.gyroAccelAvgHistoryMin; }
  get gyroAccelAvgHistoryMax(): vec3 { return this.attitudeEstimator.gyroAccelAvgHistoryMax; }


  /** True once the 100-sample gyro bias calibration is complete. */
  get isCalibrated(): boolean {
    return this.imuCalibrator.isCalibrated;
  }

  /**
   * Resets the yaw offset so the controller's current -Z direction (projected onto the
   * horizontal plane) aligns with the given (targetX, targetZ) direction.
   * Pass (0, -1) to make the current controller forward become world -Z.
   * Pass the HMD's current XZ forward vector to align the controller with the headset.
   */
  resetForward(targetX: number, targetZ: number): void {
    const baseForward = vec3.transformQuat(vec3.create(), vec3.fromValues(0, 0, -1), this.attitudeEstimator.orientation);
    // Leave the existing offset untouched if either direction is near-vertical (no horizontal
    // component to align), rather than snapping to identity as yawAlign would.
    if (Math.hypot(baseForward[0], baseForward[2]) < 1e-6 || Math.hypot(targetX, targetZ) < 1e-6) return;
    yawAlign(this._yawOffset, baseForward[0], baseForward[2], targetX, targetZ);
  }

  /** Starts BLE streaming notifications and optionally requests a connection interval. Call this after connect({ defer: true }) once ready to begin receiving data. */
  async activate(connectionInterval?: number): Promise<void> {
    this._activated = true;
    if (connectionInterval !== undefined) {
      this._connectionInterval = connectionInterval;
      await this.requestConnectionInterval(connectionInterval);
    }
    await this.streamingCharacteristic.startNotifications();
    if (!this._shouldConnect) {
      this._doDisconnect();
      return;
    }
    if (this._connectionState !== 'connected') {
      this._connectionState = 'connected';
      this.dispatchEvent(new Event('connected'));
    }
  }

  /** Re-reads the info characteristic and returns the latest values. */
  async readInfo(): Promise<ControllerInfo> {
    const value = await this.infoCharacteristic.readValue();
    return {
      major: value.getUint8(0),
      minor: value.getUint8(1),
      mtu: value.getUint8(2),
      pdu: value.getUint8(3),
      connectionInterval: value.getUint8(4),
    };
  }

  /** Writes a new connection interval request to the controller (units of 1.25ms). */
  async requestConnectionInterval(interval: number): Promise<void> {
    const service = await this.device.gatt!.getPrimaryService(SERVICE_UUID);
    const intervalChar = await service.getCharacteristic(CONNECTION_INTERVAL_UUID);
    await intervalChar.writeValue(new Uint8Array([interval]));
  }

  async reconnect(): Promise<void> {
    this._activated = true;
    if (this._reconnecting) {
      if (this._connectionState !== 'reconnecting') {
        this._connectionState = 'reconnecting';
        this.dispatchEvent(new Event('reconnecting'));
      }
      return;
    }
    if (!this.device.gatt) throw new Error('Bluetooth device does not expose a GATT server');
    this._reconnecting = true;
    this._connectionState = 'reconnecting';
    this.dispatchEvent(new Event('reconnecting'));
    while (this._reconnecting) {
      try {
        const server = await this.device.gatt.connect();
        if (!this._shouldConnect) {
          this._reconnecting = false;
          this.device.gatt?.disconnect();
          return;
        }
        const service = await server.getPrimaryService(SERVICE_UUID);
        this.streamingCharacteristic.removeEventListener('characteristicvaluechanged', this.boundHandleNotification);
        this.infoCharacteristic = await service.getCharacteristic(INFO_UUID);
        this.streamingCharacteristic = await service.getCharacteristic(STREAMING_DATA_UUID);
        this.streamingCharacteristic.addEventListener('characteristicvaluechanged', this.boundHandleNotification);
        if (this._connectionInterval !== undefined) {
          await this.requestConnectionInterval(this._connectionInterval);
        }
        await this.streamingCharacteristic.startNotifications();
        if (!this._shouldConnect) {
          this._reconnecting = false;
          this.device.gatt?.disconnect();
          return;
        }
        this._reconnecting = false;
        this._connectionState = 'connected';
        this.dispatchEvent(new Event('connected'));
        return;
      } catch {
        if (!this._shouldConnect) {
          this._reconnecting = false;
          return;
        }
        await new Promise<void>(r => setTimeout(r, 5000));
      }
    }
  }

  private _doDisconnect(): void {
    this.streamingCharacteristic.removeEventListener('characteristicvaluechanged', this.boundHandleNotification);
    if (this._connectionState !== 'disconnected') {
      this._connectionState = 'disconnected';
      this.dispatchEvent(new Event('disconnected'));
    }
    this.device.gatt?.disconnect();
  }

  private thumbstickAxisToFloat(sample: number, center: number, deadzone: number, scale: number): number {
    const minDeadzone = center - deadzone;
    const maxDeadzone = center + deadzone;
    if (sample < minDeadzone) return -scale * (minDeadzone - sample);
    if (sample > maxDeadzone) return scale * (sample - maxDeadzone);
    return 0;
  }

  private processImuSample(sample: IMUSample): ProcessedIMUSample {
    let calibrated = this.imuCalibrator.isCalibrated;
    if (!calibrated) {
      this.imuCalibrator.supplySample(sample.gyro, sample.accel);
      if (this.imuCalibrator.isCalibrated) {
        calibrated = true;
        // Axis remap raw accel average to controller space: IMU Y->X, IMU Z->Y, IMU X->Z
        const rawGrav = this.imuCalibrator.accelAverage;
        this.attitudeEstimator.initializeWithGravity(
          vec3.fromValues(rawGrav[1], rawGrav[2], rawGrav[0]),
        );
      }
    }

    // Axis remapping: IMU X->controller Z, IMU Y->controller X, IMU Z->controller Y
    const acceleration = vec3.fromValues(
      sample.accel[1] * ACCEL_SCALE,
      sample.accel[2] * ACCEL_SCALE,
      sample.accel[0] * ACCEL_SCALE,
    );

    const rotationRate = vec3.fromValues(
      sample.gyro[1] * GYRO_SCALE,
      sample.gyro[2] * GYRO_SCALE,
      sample.gyro[0] * GYRO_SCALE,
    );

    if (calibrated) {
      const b = this.imuCalibrator.gyroBias;
      rotationRate[0] -= b[1] * GYRO_SCALE;
      rotationRate[1] -= b[2] * GYRO_SCALE;
      rotationRate[2] -= b[0] * GYRO_SCALE;
    }

    const processed: ProcessedIMUSample = { acceleration, rotationRate, gyroBiasCalibrated: calibrated, timestampUs: sample.timestampUs };
    if (calibrated) {
      this.attitudeEstimator.update(processed);
      processed.accelAvgHistoryMaxRange = this.attitudeEstimator.gyroAccelAvgHistoryMaxRange;
    }
    return processed;
  }

  disconnect(): void {
    this._activated = false;
    this._doDisconnect();
  }


  private handleNotification(event: Event): void {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    const data = characteristic.value;
    if (!data) return;

    this._latestInputState = parseInputState(data);
    const analogTrigger = this.triggerProcessor.processSample(data.getUint8(1));
    this._latestInputState.trigger = analogTrigger;
    this.triggerActive = analogTrigger > (this.triggerActive ? 0.45 : 0.55);
    this._latestInputState.buttons.trigger = this.triggerActive;

    const rawX = data.getUint8(2);
    const rawY = data.getUint8(3);
    const calibrated = this.imuCalibrator.isCalibrated;

    if (!calibrated) {
      // Update center estimate while stationary pre-calibration
      this.analogXCenter = rawX;
      this.analogYCenter = rawY;
      const scale = 1 / (55 - 25);
      this._latestInputState.thumbstickX = this.thumbstickAxisToFloat(rawX, 127, 25, -scale);
      this._latestInputState.thumbstickY = this.thumbstickAxisToFloat(rawY, 127, 25,  scale);
    } else {
      const scale = 1 / (68 - 10);
      this._latestInputState.thumbstickX = this.thumbstickAxisToFloat(rawX, this.analogXCenter, 10, -scale);
      this._latestInputState.thumbstickY = this.thumbstickAxisToFloat(rawY, this.analogYCenter, 10,  scale);
    }

    // Circular clamp: preserve direction, cap magnitude to 1
    const maxVal = Math.max(Math.abs(this._latestInputState.thumbstickX), Math.abs(this._latestInputState.thumbstickY));
    if (maxVal > 1) {
      this._latestInputState.thumbstickX /= maxVal;
      this._latestInputState.thumbstickY /= maxVal;
    }

    const rawSamples = this.sampleParser.parse(data);
    const imuSamples = rawSamples.map(s => this.processImuSample(s));
    this.dispatchEvent(new CustomEvent<ControllerUpdate>('update', {
      detail: { inputState: this._latestInputState, imuSamples },
    }));
  }
}
