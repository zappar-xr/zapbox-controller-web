/** Body-relative offset (in metres) for each controller, from the neck pivot, yaw-aligned to facing.
 *  X = left/right, Y = down, Z = forward (−Z is forward). Tune on device. */
export interface ControllerOffset {
  x: number;
  y: number;
  z: number;
}

export const CONTROLLER_OFFSETS: Record<'left' | 'right', ControllerOffset> = {
  left: { x: -0.2, y: -0.5, z: -0.3 },
  right: { x: 0.2, y: -0.5, z: -0.3 },
};

/** Our own neck model: the eye's position relative to the neck pivot in head-local coords (eye is
 *  up and forward of the neck; forward is −Z). We derive a neck anchor as `eye − R_head·NECK_TO_EYE`
 *  from the reported viewer pose, so controller placement relative to the eye depends only on head
 *  orientation — robust to Chrome's (inverted) neck model and to any future 6-DoF. Tune on device. */
export const NECK_TO_EYE: ControllerOffset = { x: 0, y: 0.075, z: -0.08 };

/** Long-press threshold (ms). In the shim, a menu long-press aligns controller forward to gaze. */
export const LONG_PRESS_MS = 700;
/** Extra-long-press threshold (ms). In the shim, a menu extra-long-press does a full recenter. */
export const EXTRA_LONG_PRESS_MS = 2000;

/** WebXR input profile ids. Matches the native ZapboxBrowser runtime, which reports just the
 *  generic profile (there is no official "zapbox-controller" entry in the input-profiles registry). */
export const CONTROLLER_PROFILES = ['generic-trigger-squeeze-thumbstick'];
