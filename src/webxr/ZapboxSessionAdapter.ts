import type { ZapboxController } from '../ZapboxController.js';
import type { ControllerUpdate } from '../types.js';
import { CONTROLLER_OFFSETS } from './constants.js';
import { ZapboxInputSource } from './ZapboxInputSource.js';
import { LongPressDetector } from './LongPressDetector.js';
import { controllerTransform, headingFromOrientation, recenterOffsetFromGaze } from './pose.js';

export interface ControllerBinding {
  controller: ZapboxController;
  handedness: 'left' | 'right';
}

export interface ZapboxSessionAdapterOptions {
  /** Also expose Chrome's native gaze / transient-pointer sources alongside the controllers.
   *  Default false — report only the controllers, so apps assuming a single input paradigm aren't
   *  confused by a simultaneous gaze source. */
  includeNativeInputSources?: boolean;
}

interface SpaceRecord {
  type: XRReferenceSpaceType;
  effective: XRReferenceSpace;
}

interface InputSourcesChangeEvent extends Event {
  added: XRInputSource[];
  removed: XRInputSource[];
  session: XRSession;
}

const RECENTERABLE: XRReferenceSpaceType[] = ['local', 'local-floor', 'bounded-floor'];

/**
 * Augments a real immersive-vr XRSession so the page sees Zapbox controllers as standard
 * XRInputSources. Real headset tracking passes through untouched; we only add synthetic input
 * sources, synthesise their per-frame poses, and apply a yaw-only recenter offset.
 *
 * We patch the genuine session instance (overriding requestAnimationFrame/requestReferenceSpace and
 * the inputSources getter) rather than returning a Proxy — a Proxy isn't a real platform object, so
 * `new XRWebGLLayer(session, gl)` would reject it when it unwraps the argument to the native session.
 *
 * The recenter is expressed two ways for the same yaw:
 *  - the viewer (and any real spaces) is recentered via an offset reference space substituted into
 *    native getViewerPose/getPose calls, so the page lives entirely in "effective" coordinates;
 *  - synthetic controllers are placed directly in that effective frame (orientation straight from
 *    the controller, which carries its own resetForward yaw datum).
 */
export class ZapboxSessionAdapter {
  private readonly inputSources: ZapboxInputSource[] = [];
  private readonly cleanups: Array<() => void> = [];
  private readonly spaceInfo = new Map<XRReferenceSpace, SpaceRecord>();
  private primaryBase: XRReferenceSpace | null = null;
  private offsetTransform: XRRigidTransform | null = null;
  // Controllers awaiting a forward-to-gaze reset (a Set so overlapping per-controller gestures don't
  // clobber each other), and whether a full recenter is queued.
  private readonly pendingControllerResets = new Set<ZapboxController>();
  private pendingFullReset = false;

  // inputsourceschange interception: we deliver these events to consumers ourselves, so our synthetic
  // controllers are reported first in a single combined initial event — regardless of when (or
  // whether) Chrome fires its own initial event for the gaze source.
  private readonly inputSourceListeners = new Set<EventListenerOrEventListenerObject>();
  private readonly deliveredSources = new Set<XRInputSource>();
  private combinedScheduled = false;
  private combinedEmitted = false;

  // Captured native originals, taken before patchSession() runs. The override bodies must call
  // these rather than this.session.* (which is the override itself, so would recurse).
  private readonly origRequestAnimationFrame: XRSession['requestAnimationFrame'];
  private readonly origRequestReferenceSpace: XRSession['requestReferenceSpace'];
  private readonly nativeInputSources: () => XRInputSourceArray | undefined;
  private readonly includeNativeInputSources: boolean;

  /** @param session the genuine session, patched in place and handed straight back to the page. */
  constructor(readonly session: XRSession, bindings: ControllerBinding[], options: ZapboxSessionAdapterOptions = {}) {
    this.includeNativeInputSources = options.includeNativeInputSources ?? false;
    for (const { controller, handedness } of bindings) {
      this.inputSources.push(new ZapboxInputSource(controller, handedness, session));

      // Menu long-press → align THIS controller to gaze; extra-long-press → full recenter.
      const detector = new LongPressDetector(
        () => { this.pendingControllerResets.add(controller); },
        () => { this.pendingFullReset = true; },
      );
      const onUpdate = (ev: CustomEvent<ControllerUpdate>) => detector.update(ev.detail.inputState.buttons.menu);
      controller.addEventListener('update', onUpdate);
      this.cleanups.push(() => controller.removeEventListener('update', onUpdate));
    }

    this.origRequestAnimationFrame = session.requestAnimationFrame.bind(session);
    this.origRequestReferenceSpace = session.requestReferenceSpace.bind(session);
    const nativeGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'inputSources')?.get;
    this.nativeInputSources = nativeGetter ? () => nativeGetter.call(session) as XRInputSourceArray : () => undefined;

    this.patchSession();
    this.scheduleInitialAnnounce();
  }

  /** Set the recenter computed during the calibration pre-roll, before the page gets the session. */
  setInitialOffset(offsetTransform: XRRigidTransform): void {
    this.offsetTransform = offsetTransform;
    this.rebuildEffectives();
  }

  dispose(): void {
    for (const s of this.inputSources) s.dispose();
    for (const cleanup of this.cleanups) cleanup();
    // Restore the genuine members in case the session object outlives us.
    const patched = this.session as unknown as Record<string, unknown>;
    delete patched.requestAnimationFrame;
    delete patched.requestReferenceSpace;
    delete patched.inputSources;
    delete patched.addEventListener;
    delete patched.removeEventListener;
  }

  // --- session patching ----------------------------------------------------

  private patchSession(): void {
    const session = this.session;
    Object.defineProperty(session, 'inputSources', {
      configurable: true,
      get: () => this.allInputSources(),
    });
    session.requestAnimationFrame = (cb: XRFrameRequestCallback) =>
      this.origRequestAnimationFrame((t, frame) => cb(t, this.wrapFrame(frame)));
    session.requestReferenceSpace = (type: XRReferenceSpaceType) => this.requestReferenceSpace(type);

    // Intercept inputsourceschange: consumer listeners are collected here rather than attached to the
    // real session, so we can deliver a reordered (controllers-first), de-duplicated stream. All
    // other event types (select/squeeze/end) pass straight through. Chrome's own initial event for
    // the gaze source is folded into our single combined event (see onNativeInputSourcesChange).
    const origAdd = session.addEventListener.bind(session) as XRSession['addEventListener'];
    const origRemove = session.removeEventListener.bind(session) as XRSession['removeEventListener'];

    session.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
      if (type === 'inputsourceschange') { if (listener) this.inputSourceListeners.add(listener); }
      else if (listener) origAdd(type as keyof XRSessionEventMap, listener as EventListener, opts);
    }) as XRSession['addEventListener'];

    session.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
      if (type === 'inputsourceschange') { if (listener) this.inputSourceListeners.delete(listener); }
      else if (listener) origRemove(type as keyof XRSessionEventMap, listener as EventListener, opts);
    }) as XRSession['removeEventListener'];

    // Our single subscription to the REAL inputsourceschange stream (Chrome's gaze, transient sources…).
    const onNative = (e: Event): void => this.onNativeInputSourcesChange(e as InputSourcesChangeEvent);
    origAdd('inputsourceschange', onNative as EventListener);
    this.cleanups.push(() => origRemove('inputsourceschange', onNative as EventListener));
  }

  // Controllers first, then (only if opted in) native sources (e.g. Chrome's gaze) — matches our
  // combined added order. By default native sources are hidden, so the page sees controllers only.
  private allInputSources(): XRInputSource[] {
    const controllers = this.inputSources.map(s => s.inputSource);
    if (!this.includeNativeInputSources) return controllers;
    const native = this.nativeInputSources();
    const nativeArr = native ? Array.from(native) : [];
    return [...controllers, ...nativeArr];
  }

  // --- inputsourceschange delivery -----------------------------------------

  private onNativeInputSourcesChange(ev: InputSourcesChangeEvent): void {
    // The initial set is delivered by our queued task (scheduleInitialAnnounce), which reads the
    // native input-source list directly — so ignore native events until then. Afterwards, forward
    // genuine later changes (transient sources etc.), skipping anything already delivered.
    if (!this.combinedEmitted) return;
    // Native sources are hidden by default — don't leak their later add/remove churn to the page.
    if (!this.includeNativeInputSources) return;
    const added = Array.from(ev.added).filter(s => !this.deliveredSources.has(s));
    const removed = Array.from(ev.removed).filter(s => this.deliveredSources.has(s));
    if (added.length || removed.length) this.deliverChange(added, removed);
  }

  /**
   * Queue the initial inputsourceschange exactly as the WebXR spec does: "queue a task" at the point
   * the session is handed to the app (here, adapter construction, after the pre-roll has released the
   * session). It runs after the app's requestSession().then microtask, so an app that subscribes
   * synchronously there receives it — and, per spec, one that subscribes any later misses it, just as
   * it would with the platform's own initial event. By then Chrome's own initial queued task has run
   * (during the pre-roll), so the native gaze source is already listed.
   */
  private scheduleInitialAnnounce(): void {
    if (this.combinedScheduled || this.combinedEmitted) return;
    this.combinedScheduled = true;
    setTimeout(() => this.emitCombined(), 0);
  }

  /** Emit the one combined initial event, controllers-first (allInputSources' own ordering). */
  private emitCombined(): void {
    if (this.combinedEmitted) return;
    this.combinedEmitted = true;
    this.deliverChange(this.allInputSources(), []);
  }

  private deliverChange(added: XRInputSource[], removed: XRInputSource[]): void {
    for (const s of added) this.deliveredSources.add(s);
    for (const s of removed) this.deliveredSources.delete(s);
    const ev = new Event('inputsourceschange') as InputSourcesChangeEvent;
    ev.added = added;
    ev.removed = removed;
    ev.session = this.session;
    for (const l of this.inputSourceListeners) {
      if (typeof l === 'function') l.call(this.session, ev);
      else l.handleEvent(ev);
    }
  }

  // --- reference spaces ----------------------------------------------------

  private isRecenterable(type: XRReferenceSpaceType): boolean {
    return RECENTERABLE.includes(type);
  }

  private async requestReferenceSpace(type: XRReferenceSpaceType): Promise<XRReferenceSpace> {
    const base = await this.origRequestReferenceSpace(type);
    this.spaceInfo.set(base, { type, effective: this.computeEffective(base, type) });
    if (this.primaryBase === null && this.isRecenterable(type)) this.primaryBase = base;
    return base; // page holds the real space; we substitute the effective one in frame queries
  }

  private computeEffective(base: XRReferenceSpace, type: XRReferenceSpaceType): XRReferenceSpace {
    if (this.offsetTransform && this.isRecenterable(type)) {
      return base.getOffsetReferenceSpace(this.offsetTransform);
    }
    return base;
  }

  private rebuildEffectives(): void {
    for (const [base, rec] of this.spaceInfo) {
      rec.effective = this.computeEffective(base, rec.type);
    }
  }

  private effectiveFor(base: XRSpace): XRSpace {
    return this.spaceInfo.get(base as XRReferenceSpace)?.effective ?? base;
  }

  // --- frame proxy ---------------------------------------------------------

  private wrapFrame(real: XRFrame): XRFrame {
    const wrapped = new Proxy(real, {
      get: (target, prop) => {
        if (prop === 'getViewerPose') {
          return (refSpace: XRReferenceSpace) => {
            this.applyPendingReset(target);
            return target.getViewerPose(this.effectiveFor(refSpace) as XRReferenceSpace);
          };
        }
        if (prop === 'getPose') {
          return (space: XRSpace, base: XRSpace) => this.getPose(target, space, base);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as XRFrame;

    // Flush queued select/squeeze events now that we hold a valid frame to attach. The combined
    // inputsourceschange has already been delivered by our queued task (scheduleCombinedEmit), so
    // the controllers are registered before any select reaches the framework.
    for (const s of this.inputSources) s.flushEvents(wrapped);
    return wrapped;
  }

  private synthSourceFor(space: XRSpace): ZapboxInputSource | undefined {
    return this.inputSources.find(
      s => (s.targetRaySpace as unknown as XRSpace) === space || (s.gripSpace as unknown as XRSpace) === space,
    );
  }

  private getPose(frame: XRFrame, space: XRSpace, base: XRSpace): XRPose | undefined {
    const eff = this.effectiveFor(base);
    const src = this.synthSourceFor(space);
    if (!src) return frame.getPose(space, eff);

    const viewerPose = frame.getViewerPose(eff as XRReferenceSpace);
    if (!viewerPose) return undefined;
    const offset = CONTROLLER_OFFSETS[src.handedness === 'left' ? 'left' : 'right'];
    const transform = controllerTransform(viewerPose.transform, src.controller.orientation, offset);
    return { transform, emulatedPosition: true } as unknown as XRPose;
  }

  // --- recenter ------------------------------------------------------------

  private applyPendingReset(frame: XRFrame): void {
    if (!this.primaryBase) return;

    if (this.pendingControllerResets.size > 0) {
      // Align ONLY the controllers whose menu was held to where the user is currently looking.
      const vp = frame.getViewerPose(this.effectiveFor(this.primaryBase) as XRReferenceSpace);
      if (vp) {
        const g = headingFromOrientation(vp.transform.orientation);
        for (const controller of this.pendingControllerResets) controller.resetForward(g.x, g.z);
        this.pendingControllerResets.clear();
      }
    }

    if (this.pendingFullReset) {
      // Full recenter: make the current (native) gaze become forward, then point all controllers there.
      this.pendingFullReset = false;
      const vp = frame.getViewerPose(this.primaryBase);
      if (vp) {
        const g = headingFromOrientation(vp.transform.orientation);
        this.offsetTransform = recenterOffsetFromGaze(g.x, g.z);
        this.rebuildEffectives();
        for (const s of this.inputSources) s.controller.resetForward(0, -1);
      }
    }
  }
}
