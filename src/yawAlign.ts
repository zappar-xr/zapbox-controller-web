import { quat } from 'gl-matrix';

/**
 * Shortest-arc, yaw-only (about +Y) quaternion that rotates the horizontal direction
 * (fromX, fromZ) onto (toX, toZ). Writes into `out` and returns it; writes identity if either
 * direction has near-zero horizontal length.
 *
 * Shared by ZapboxController.resetForward and the WebXR shim's recenter, and mirrored by the
 * native iOS 3-DoF runtime — keep the three in agreement.
 */
export function yawAlign(out: quat, fromX: number, fromZ: number, toX: number, toZ: number): quat {
  const fl = Math.hypot(fromX, fromZ);
  const tl = Math.hypot(toX, toZ);
  if (fl < 1e-6 || tl < 1e-6) return quat.identity(out);

  const cx = fromX / fl;
  const cz = fromZ / fl;
  const tx = toX / tl;
  const tz = toZ / tl;

  // Shortest-arc rotation from (cx,0,cz) to (tx,0,tz), restricted to the Y axis.
  // cross(a,b).y = cz*tx − cx*tz, dot(a,b) = cx*tx + cz*tz. Unnormalised quat: (0, cross.y, 0, 1+dot).
  const dot = cx * tx + cz * tz;
  const crossY = cz * tx - cx * tz;
  if (1 + dot < 1e-6) return quat.set(out, 0, 1, 0, 0); // antiparallel — 180° about Y
  return quat.normalize(out, quat.fromValues(0, crossY, 0, 1 + dot));
}
