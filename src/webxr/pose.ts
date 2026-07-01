import { quat, vec3 } from 'gl-matrix';
import { NECK_TO_EYE, type ControllerOffset } from './constants.js';
import { yawAlign } from '../yawAlign.js';

const TMP_FWD = vec3.create();
const FORWARD = vec3.fromValues(0, 0, -1);
const NECK_TO_EYE_VEC = vec3.fromValues(NECK_TO_EYE.x, NECK_TO_EYE.y, NECK_TO_EYE.z);
const SCRATCH_YAW = quat.create();
const SCRATCH_HEAD = quat.create();
const SCRATCH_OFFSET = vec3.create();
const SCRATCH_NECKARM = vec3.create();

/**
 * Offset transform whose effective reference space reports the gaze direction (gazeX, gazeZ) as −Z.
 * getOffsetReferenceSpace's originOffset maps new→old, so its rotation is the inverse of the
 * gaze→−Z yaw. Shared by the calibration pre-roll (initial recenter) and the full-reset gesture.
 * NOTE: this inverse is the likely device-tuning point if recenter ends up mirrored.
 */
export function recenterOffsetFromGaze(gazeX: number, gazeZ: number): XRRigidTransform {
  const headingOffset = yawAlign(quat.create(), gazeX, gazeZ, 0, -1);
  const inverse = quat.invert(quat.create(), headingOffset);
  return new XRRigidTransform(undefined, quatToOrientation(inverse));
}

/** Horizontal forward (XZ) of an orientation, as a {x, z} heading. */
export function headingFromOrientation(o: DOMPointReadOnly): { x: number; z: number } {
  const q = quat.fromValues(o.x, o.y, o.z, o.w);
  vec3.transformQuat(TMP_FWD, FORWARD, q);
  return { x: TMP_FWD[0], z: TMP_FWD[2] };
}

const REBASE_Q = quat.create();
const REBASE_P = vec3.create();
const REBASE_TMP = quat.create();

/** Pre-compose the rigid transform `(tq, tp)` onto the running `(q, p)`: (tq,tp) ∘ (q,p) in place,
 *  i.e. p ← tq·p + tp and q ← tq·q. */
function preComposeRigid(q: quat, p: vec3, tq: DOMPointReadOnly, tp: DOMPointReadOnly): void {
  quat.set(REBASE_TMP, tq.x, tq.y, tq.z, tq.w);
  vec3.transformQuat(p, p, REBASE_TMP);
  p[0] += tp.x; p[1] += tp.y; p[2] += tp.z;
  quat.multiply(q, REBASE_TMP, q);
}

/** Compose two rigid transforms: `a ∘ b` (applies b, then a). Returns a fresh XRRigidTransform. */
export function composeRigid(a: XRRigidTransform, b: XRRigidTransform): XRRigidTransform {
  quat.set(REBASE_Q, b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w);
  vec3.set(REBASE_P, b.position.x, b.position.y, b.position.z);
  preComposeRigid(REBASE_Q, REBASE_P, a.orientation, a.position);
  return new XRRigidTransform({ x: REBASE_P[0], y: REBASE_P[1], z: REBASE_P[2] }, quatToOrientation(REBASE_Q));
}

/** gl-matrix quat → DOMPointInit for XRRigidTransform. */
export function quatToOrientation(q: quat): DOMPointInit {
  return { x: q[0], y: q[1], z: q[2], w: q[3] };
}

/**
 * Synthetic controller transform: a body-relative offset oriented straight from the controller's
 * own quaternion. No arm model — the controller is torch-shaped, so wrist rotation about a fixed
 * anchor reads fine.
 *
 * Anchored at a neck pivot derived from the REPORTED viewer pose via our own neck model
 * (`neck = eye − R_head·NECK_TO_EYE`), with the body offset rotated by the viewer's YAW so left/right
 * track the facing direction (face +Z → right controller moves to −X). Yaw-only on the offset — head
 * pitch/roll must not fling the controllers.
 *
 * Anchoring to a neck computed from the reported eye makes the controller's pose RELATIVE TO THE EYE
 * (`R_yaw·offset − R_head·NECK_TO_EYE`) depend only on head orientation — the eye position cancels.
 * So it stays sensible regardless of how Chrome moves the eye: its Cardboard neck model is actually
 * inverted (eye orbits behind the pivot, a legacy-path quirk), and a future build could add real
 * 6-DoF translation — neither leaks into how the controllers sit relative to the head. It also
 * compensates the eye's pitch movement, so there's no vertical bob. (Project note tracks a possible
 * future shim/upstream fix for Chrome's inverted neck model itself.)
 */
export function controllerTransform(
  viewerTransform: XRRigidTransform,
  controllerOrientation: quat,
  offset: ControllerOffset,
): XRRigidTransform {
  const o = viewerTransform.orientation;
  const p = viewerTransform.position;

  // Neck arm in world: R_head · NECK_TO_EYE (full orientation — pitch matters here).
  quat.set(SCRATCH_HEAD, o.x, o.y, o.z, o.w);
  vec3.transformQuat(SCRATCH_NECKARM, NECK_TO_EYE_VEC, SCRATCH_HEAD);

  // Body offset, rotated by yaw only (about Y, so offset.y is preserved).
  const heading = headingFromOrientation(o);
  const yaw = yawAlign(SCRATCH_YAW, 0, -1, heading.x, heading.z);
  vec3.set(SCRATCH_OFFSET, offset.x, offset.y, offset.z);
  vec3.transformQuat(SCRATCH_OFFSET, SCRATCH_OFFSET, yaw);

  // position = (eye − neckArm) + yawOffset  =  neckPivot + yawOffset
  const position: DOMPointInit = {
    x: p.x - SCRATCH_NECKARM[0] + SCRATCH_OFFSET[0],
    y: p.y - SCRATCH_NECKARM[1] + SCRATCH_OFFSET[1],
    z: p.z - SCRATCH_NECKARM[2] + SCRATCH_OFFSET[2],
  };
  return new XRRigidTransform(position, quatToOrientation(controllerOrientation));
}
