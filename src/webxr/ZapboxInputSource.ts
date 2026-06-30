import type { ZapboxController } from '../ZapboxController.js';
import type { ControllerUpdate, InputState } from '../types.js';
import { CONTROLLER_PROFILES } from './constants.js';

/** Marker XRSpace used as a stable identity for getPose() lookups in the frame proxy. */
export class SyntheticXRSpace extends EventTarget {}

/**
 * No-op haptic actuator. Zapbox controllers have no haptics, but some sites assume
 * `gamepad.vibrationActuator` exists and call `playEffect`/`reset` on it. Mirrors the native
 * ZapboxBrowser runtime, which added this to work around that assumption; the rejected promise
 * signals "no effect played" without throwing on access.
 */
class NoopHapticActuator implements GamepadHapticActuator {
  playEffect(): Promise<GamepadHapticsResult> {
    return Promise.reject();
  }
  reset(): Promise<GamepadHapticsResult> {
    return Promise.reject();
  }
  // Legacy method still required by lib.dom; rejected like the others.
  pulse(): Promise<boolean> {
    return Promise.reject();
  }
}

// Stateless, so a single shared instance is fine across all controllers.
const NOOP_HAPTICS = new NoopHapticActuator();

interface MutableGamepadButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}

// Button + axis layout mirrors the native ZapboxBrowser runtime so the same WebXR app reads
// controllers identically on both:
//   buttons: 0 trigger (analog on .value), 1 squeeze, 2 touchpad (unused), 3 thumbstick click,
//            4 menu (Bottom), 5 A (TopLeft), 6 B (TopRight)
//   axes:    0/1 touchpad (unused), 2/3 thumbstick — 4 axes total (even, per xr-standard)
function makeButtons(): MutableGamepadButton[] {
  return Array.from({ length: 7 }, () => ({ pressed: false, touched: false, value: 0 }));
}

function setButton(btn: MutableGamepadButton, pressed: boolean, value = pressed ? 1 : 0): void {
  btn.pressed = pressed;
  btn.touched = pressed;
  btn.value = value;
}

/**
 * Wraps one ZapboxController as a synthetic WebXR input source: builds the XRInputSource-like
 * object (target-ray + grip spaces, gamepad, profiles) and translates trigger/grip edges into
 * select/squeeze events dispatched on the underlying session.
 */
export class ZapboxInputSource {
  readonly targetRaySpace = new SyntheticXRSpace();
  readonly gripSpace = new SyntheticXRSpace();
  readonly inputSource: XRInputSource;

  private readonly buttons = makeButtons();
  private readonly axes = [0, 0, 0, 0];
  private readonly gamepad: Gamepad;

  private prevTrigger = false;
  private prevGrip = false;
  private pendingEvents: string[] = [];
  private readonly boundUpdate: (ev: CustomEvent<ControllerUpdate>) => void;

  constructor(
    readonly controller: ZapboxController,
    readonly handedness: XRHandedness,
    private readonly session: XRSession,
  ) {
    this.gamepad = {
      id: 'zapbox-controller',
      index: -1,
      connected: true,
      mapping: 'xr-standard',
      timestamp: 0,
      axes: this.axes,
      buttons: this.buttons,
      hapticActuators: [],
      vibrationActuator: NOOP_HAPTICS,
    } as unknown as Gamepad;

    this.inputSource = {
      handedness,
      targetRayMode: 'tracked-pointer',
      targetRaySpace: this.targetRaySpace as unknown as XRSpace,
      gripSpace: this.gripSpace as unknown as XRSpace,
      profiles: CONTROLLER_PROFILES,
      gamepad: this.gamepad,
      hand: null,
    } as unknown as XRInputSource;

    this.boundUpdate = (ev) => this.onUpdate(ev.detail.inputState);
    controller.addEventListener('update', this.boundUpdate);
  }

  dispose(): void {
    this.controller.removeEventListener('update', this.boundUpdate);
  }

  private onUpdate(state: InputState): void {
    const b = state.buttons;
    setButton(this.buttons[0], b.trigger, state.trigger); // analog value (xr-standard)
    setButton(this.buttons[1], b.grip);
    setButton(this.buttons[3], b.thumbstickClick);
    // Face buttons in the native runtime's index order (see makeButtons): 4=Menu, 5=A, 6=B.
    setButton(this.buttons[4], b.menu);
    setButton(this.buttons[5], b.a);
    setButton(this.buttons[6], b.b);
    // Thumbstick on axes 2/3 (Y negated so "up" reads as −1). The analog trigger lives on
    // buttons[0].value (the canonical xr-standard slot, set above) — we deliberately do NOT also
    // mirror it to axes[4]. An odd axis count is non-standard and breaks sites that assume axis
    // pairs (e.g. the immersive-web controller-state sample rebuilds its GL boxes every frame and
    // leaks the context). This diverges from the current native iOS runtime, which still reports the
    // trigger at axes[4]; favour standard-site compatibility. See the webxr-gamepad-quest-parity note.
    this.axes[2] = state.thumbstickX;
    this.axes[3] = -state.thumbstickY;

    if (b.trigger !== this.prevTrigger) {
      this.pendingEvents.push(b.trigger ? 'selectstart' : 'select');
      if (!b.trigger) this.pendingEvents.push('selectend');
      this.prevTrigger = b.trigger;
    }
    if (b.grip !== this.prevGrip) {
      this.pendingEvents.push(b.grip ? 'squeezestart' : 'squeeze');
      if (!b.grip) this.pendingEvents.push('squeezeend');
      this.prevGrip = b.grip;
    }
  }

  /**
   * Dispatch any queued select/squeeze events, attaching `frame`. Edges are detected from BLE
   * notifications (outside any rAF), but a WebXR XRInputSourceEvent must carry the current XRFrame —
   * frameworks (e.g. three's WebXRController.update) read `event.frame.session` — and an XRFrame is
   * only valid inside its rAF callback. So the adapter calls this from its frame loop.
   */
  flushEvents(frame: XRFrame): void {
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const type of events) {
      const ev = new Event(type) as Event & { inputSource?: XRInputSource; frame?: XRFrame };
      ev.inputSource = this.inputSource;
      ev.frame = frame;
      this.session.dispatchEvent(ev);
    }
  }
}
