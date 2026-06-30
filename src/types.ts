export interface ControllerInfo {
  major: number;
  minor: number;
  mtu: number;
  pdu: number;
  /** Raw connection interval in units of 1.25ms */
  connectionInterval: number;
}

export interface ButtonState {
  trigger: boolean;
  a: boolean;
  b: boolean;
  menu: boolean;
  grip: boolean;
  thumbstickClick: boolean;
}

export interface InputState {
  buttons: ButtonState;
  /** Processed, 0 (released) to 1 (fully pressed). Auto-calibrates to the controller's range. */
  trigger: number;
  /** Processed, -1 (left) to +1 (right). Zero in deadzone. */
  thumbstickX: number;
  /** Processed, -1 (down) to +1 (up). Zero in deadzone. */
  thumbstickY: number;
}

import type { vec3 } from 'gl-matrix';

export interface IMUSample {
  /** Raw int16, full-scale +-32768 = +-16g */
  accel: vec3;
  /** Raw int16, full-scale +-32768 = +-2000 deg/s */
  gyro: vec3;
  /** Microseconds since controller boot */
  timestampUs: number;
}

export interface ProcessedIMUSample {
  /** Acceleration in m/s², controller axes applied */
  acceleration: vec3;
  /** Angular velocity in rad/s, controller axes applied, bias-corrected when calibrated */
  rotationRate: vec3;
  /** True once gyro bias calibration is complete */
  gyroBiasCalibrated: boolean;
  timestampUs: number;
  /** Range of the accel average output over the last ~50 samples (m/s²). Only set when gyroBiasCalibrated. */
  accelAvgHistoryMaxRange?: number;
}

export interface ControllerUpdate {
  inputState: InputState;
  imuSamples: ProcessedIMUSample[];
}

export interface ConnectOptions {
  /**
   * BLE connection interval to request after connecting, in units of 1.25ms.
   * e.g. 12 = 15ms (minimum accepted on iOS), 9 = 11.25ms (accepted on some Android).
   */
  connectionInterval?: number;
  /**
   * If true, skip startNotifications() and the connection interval request.
   * Call activate() manually when ready to begin streaming.
   */
  defer?: boolean;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export interface ControllerManagerOptions {
  /**
   * Minimum number of controllers the user must connect to proceed (0–2). Default 0, which lets the
   * user continue with no controllers — useful for progressive enhancement where the experience
   * works gaze-only and controllers are an optional upgrade.
   */
  min?: number;
  /** Maximum number of controllers the user may connect (0–2). Default 2. */
  max?: number;
  /**
   * Suggested count, highlighted as the default in the "how many?" step. Ignored unless it falls
   * within [min, max]. When omitted, no option is highlighted.
   */
  recommended?: number;
  /**
   * When set, the final "paired successfully" step shows a button with this label and waits for the
   * user to tap it instead of auto-advancing. The tap is a fresh user gesture, so the caller can
   * drive a gesture-gated API (e.g. XR requestSession) straight off the completed setup. When
   * omitted, the final step auto-advances after a short delay like the intermediate ones.
   */
  finishButtonLabel?: string;
  /**
   * BLE connection interval to request after each controller activates, in units of 1.25ms.
   * e.g. 12 = 15ms (minimum accepted on iOS), 9 = 11.25ms (accepted on some Android).
   */
  connectionInterval?: number;
}
