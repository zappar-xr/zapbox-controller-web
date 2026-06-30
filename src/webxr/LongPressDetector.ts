import { LONG_PRESS_MS, EXTRA_LONG_PRESS_MS } from './constants.js';

/**
 * Tracks a boolean "pressed" signal over time (fed via `update`) and fires *while still held*, as
 * each threshold is crossed:
 *  - `onLong`      once the hold reaches LONG_PRESS_MS
 *  - `onExtraLong` once the hold reaches EXTRA_LONG_PRESS_MS (if the user keeps holding)
 * Firing during the hold gives live feedback — you can see the long-press action happen, then keep
 * holding to escalate. Both fire in sequence on a long enough hold; each fires at most once per press.
 * Source-agnostic — feed it any bool (a controller button, a key, etc.).
 */
export class LongPressDetector {
  private pressed = false;
  private pressStart = 0;
  private firedLong = false;
  private firedExtraLong = false;

  constructor(
    private readonly onLong: () => void,
    private readonly onExtraLong: () => void,
  ) {}

  update(pressed: boolean): void {
    if (!pressed) {
      this.pressed = false;
      return;
    }

    const now = performance.now();
    if (!this.pressed) {
      this.pressed = true;
      this.pressStart = now;
      this.firedLong = false;
      this.firedExtraLong = false;
    }

    const held = now - this.pressStart;
    if (!this.firedLong && held >= LONG_PRESS_MS) {
      this.firedLong = true;
      this.onLong();
    }
    if (!this.firedExtraLong && held >= EXTRA_LONG_PRESS_MS) {
      this.firedExtraLong = true;
      this.onExtraLong();
    }
  }
}
