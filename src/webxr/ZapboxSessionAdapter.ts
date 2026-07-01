import type { ZapboxController } from '../ZapboxController.js';
import type { ControllerUpdate } from '../types.js';
import { CONTROLLER_OFFSETS } from './constants.js';
import { ZapboxInputSource } from './ZapboxInputSource.js';
import { LongPressDetector } from './LongPressDetector.js';
import { composeRigid, controllerTransform, headingFromOrientation, recenterOffsetFromGaze } from './pose.js';

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
 * The recenter is a yaw-only offset computed by the calibration pre-roll (rebuildable on a full-reset
 * gesture). We hand the page the RAW reference space and recenter by substituting an "effective"
 * space into its frame queries — but rather than keying that substitution on the exact object we
 * returned (which a page defeats the moment it derives its own offset space for locomotion, as the
 * webxr-samples teleportation demo does), we MEASURE where whatever space the page passes sits
 * relative to our raw base and rebuild the recenter on top of it:
 *
 *     effective(X) = internalRecentered.getOffsetReferenceSpace( pose(X relative to internalRaw) )
 *
 * That keeps the recenter innermost (at the base origin) with the page's own locomotion layered on
 * top, works for any space the page derives, stays dynamic (rebuild `internalRecentered` → next frame
 * picks it up), and lets the platform compute the eyes/projection (we substitute a real reference
 * space, not hand-rolled matrices). We patch getOffsetReferenceSpace on each recenterable base to tag
 * its descendants (see trackDescendants), so we only substitute for spaces that genuinely descend from
 * one of our roots — spaces rooted elsewhere (viewer, an anchor) pass through untouched. That makes
 * the relative pose a same-root static rigid offset (a base `reset` shifts both together, leaving it
 * invariant), so it's safe to cache per space until the recenter itself changes.
 *
 * Synthetic controllers are built in `internalRecentered` (gravity-aligned, where the neck/shoulder
 * offset maths holds) and composed into whatever space the page renders through by the frame delta
 * between them (see getPose / controllerPoseInRecenter), so they ride along with the page's world —
 * turn, teleport, even tilt — while staying correctly placed relative to the viewer.
 */
export class ZapboxSessionAdapter {
  private readonly inputSources: ZapboxInputSource[] = [];
  private readonly cleanups: Array<() => void> = [];
  // Recenter reference frames. `roots` holds every recenterable base we hand the page (local /
  // local-floor / bounded-floor — they share orientation, so one recenter yaw serves all). `internalRaw`
  // is the first of them, the canonical frame for gaze reads; `internalRecentered` is it with the
  // recenter applied — the frame our controller orientations live in (orientation is translation-
  // invariant, so it's a valid heading reference for content descending from any root). Rebuilt when
  // the recenter changes; `recenterVersion` invalidates the per-space effective cache on that change.
  private readonly roots = new Set<XRReferenceSpace>();
  private internalRaw: XRReferenceSpace | null = null;
  private internalRecentered: XRReferenceSpace | null = null;
  private offsetTransform: XRRigidTransform | null = null;
  private recenterVersion = 0;
  // Effective (recentered) space per page-supplied space, valid while its `.version` matches
  // recenterVersion. WeakMap so spaces the page creates per-teleport are collected when it drops them.
  private readonly effectiveCache = new WeakMap<XRReferenceSpace, { version: number; space: XRReferenceSpace }>();
  // Every space the page derives (at any depth) from a root via getOffsetReferenceSpace, mapped to that
  // root. Lets us recenter iff a space genuinely descends from one of our recenter bases — spaces
  // rooted elsewhere (viewer, foreign) have no entry and pass through, closing the cross-root edge.
  private readonly rootOf = new WeakMap<XRReferenceSpace, XRReferenceSpace>();
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
    this.setRecenter(offsetTransform);
  }

  dispose(): void {
    for (const s of this.inputSources) s.dispose();
    for (const cleanup of this.cleanups) cleanup();
    // Un-shadow getOffsetReferenceSpace on our roots (session-scoped spaces, but restore for hygiene;
    // derived children are transient and collected with the page's references).
    for (const root of this.roots) delete (root as { getOffsetReferenceSpace?: unknown }).getOffsetReferenceSpace;
    this.roots.clear();
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
      this.origRequestAnimationFrame((t, frame) => {
        // Apply any queued recenter (and dispatch its 'reset') BEFORE the page's frame callback runs,
        // so the event fires prior to the frame that uses the new origin (per the XRReferenceSpace
        // contract) and the callback's getViewerPose/getPose already see the new recenter.
        this.applyPendingReset(frame);
        cb(t, this.wrapFrame(frame));
      });
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
    // Hand the page the RAW space; we recenter by substituting an effective space in frame queries
    // (effectiveFor). Each recenterable base is a root — patch its getOffsetReferenceSpace so we can
    // recognise the descendants the page derives from it for locomotion.
    if (this.isRecenterable(type) && !this.roots.has(base)) {
      this.roots.add(base);
      this.trackDescendants(base, base);
      if (this.internalRaw === null) {
        this.internalRaw = base;
        this.rebuildInternalRecentered();
      }
    }
    return base;
  }

  /** Patch getOffsetReferenceSpace on `space` so children are tagged with their recenter `root` and are
   *  themselves patched — propagating the root down arbitrarily long offset chains. */
  private trackDescendants(space: XRReferenceSpace, root: XRReferenceSpace): void {
    const origGetOffset = space.getOffsetReferenceSpace.bind(space);
    (space as { getOffsetReferenceSpace: XRReferenceSpace['getOffsetReferenceSpace'] }).getOffsetReferenceSpace =
      (transform: XRRigidTransform) => {
        const child = origGetOffset(transform);
        this.rootOf.set(child, root);
        this.trackDescendants(child, root);
        return child;
      };
  }

  private setRecenter(offsetTransform: XRRigidTransform): void {
    this.offsetTransform = offsetTransform;
    this.recenterVersion++; // invalidate the effective cache; next frame rebuilds against the new offset
    this.rebuildInternalRecentered();
  }

  /**
   * Fire 'reset' on each root so the page re-anchors after a recenter (its effective origin moved),
   * per the XRReferenceSpace contract. dispatchEvent fires the root's current listeners —
   * addEventListener and onreset alike, honouring any removals — so no listener bookkeeping is needed.
   * (Only listeners on the roots we return are reached, not ones the page attaches to an ephemeral
   * offset space it derived — apps listen on the stable base.) Called from applyPendingReset, i.e.
   * before the page's frame callback (see requestAnimationFrame), so it precedes the frame that uses
   * the new origin; a no-op before the page holds any spaces (the initial pre-roll offset).
   *
   * `transform` is the origin shift (recenter delta), so a listening page can absorb it into its own
   * offset (fold the yaw into a locomotion offset to keep its view put — see demo/webxr-locomotion);
   * only meaningful on the root, which is all we dispatch on.
   */
  private dispatchReset(transform?: XRRigidTransform): void {
    for (const root of this.roots) {
      root.dispatchEvent(new XRReferenceSpaceEvent('reset', { referenceSpace: root, transform }));
    }
  }

  private rebuildInternalRecentered(): void {
    this.internalRecentered = this.internalRaw && this.offsetTransform
      ? this.internalRaw.getOffsetReferenceSpace(this.offsetTransform)
      : this.internalRaw;
  }

  /**
   * The recentered space to substitute for a page-supplied space `x`. We rebuild the recenter on top
   * of where `x` sits relative to our raw base (a static rigid offset — same root), so the recenter
   * stays at the base origin with the page's locomotion layered above it. Cached per space until the
   * recenter changes. Falls back to `x` untouched when there's no recenter yet, `x` is a passthrough
   * (viewer) space, or the relative pose is momentarily unavailable (tracking loss).
   */
  private effectiveFor(frame: XRFrame, x: XRReferenceSpace): XRReferenceSpace {
    if (!this.internalRecentered || !this.offsetTransform) return x;
    // Recenter only spaces that descend from one of our recenter roots; anything else (viewer,
    // foreign) is rendered as the page intends. The root also gives us a same-root base to measure
    // against, so the relative pose below is static.
    const root = this.roots.has(x) ? x : this.rootOf.get(x);
    if (!root) return x;

    const cached = this.effectiveCache.get(x);
    if (cached && cached.version === this.recenterVersion) return cached.space;

    let space: XRReferenceSpace;
    if (x === root) {
      // A root itself → just the recenter offset. Reuse the prebuilt frame for the primary root.
      space = root === this.internalRaw ? this.internalRecentered : root.getOffsetReferenceSpace(this.offsetTransform);
    } else {
      const rel = frame.getPose(x, root);
      if (!rel) return x; // don't cache — tracking may resolve on a later frame
      space = this.effectiveFor(frame, root).getOffsetReferenceSpace(rel.transform);
    }
    this.effectiveCache.set(x, { version: this.recenterVersion, space });
    return space;
  }

  // --- frame proxy ---------------------------------------------------------

  private wrapFrame(real: XRFrame): XRFrame {
    const wrapped = new Proxy(real, {
      get: (target, prop) => {
        if (prop === 'getViewerPose') {
          return (refSpace: XRReferenceSpace) => target.getViewerPose(this.effectiveFor(target, refSpace));
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

  // Returns null (not undefined) when no pose is available, matching the platform's XRPose? contract.
  private getPose(frame: XRFrame, space: XRSpace, base: XRSpace): XRPose | null {
    // Our rich handling keys off the BASE (recenter, viewer pose). If only the TARGET is a reference
    // space, swap the query so the reference space lands in the base position, then invert the result.
    if (space instanceof XRReferenceSpace && !(base instanceof XRReferenceSpace)) {
      const swapped = this.getPose(frame, base, space);
      return swapped ? this.synthPose(swapped.transform.inverse, swapped.emulatedPosition) : null;
    }
    // A non-reference base (e.g. one controller relative to another) we can't recenter or take a viewer
    // pose against: express both endpoints in our recenter frame and take the delta (relativeToNonRefBase).
    if (!(base instanceof XRReferenceSpace)) return this.relativeToNonRefBase(frame, space, base);

    const effectiveBase = this.effectiveFor(frame, base);
    const src = this.synthSourceFor(space);
    if (!src) {
      // If the target is also one of our reference spaces, recenter it too, so a query between two of
      // them — e.g. local-floor relative to local, "what's the floor offset?" — stays consistent and
      // doesn't pick up a spurious recenter rotation. Non-reference / non-root targets (viewer, a
      // hit-test anchor) pass through effectiveFor untouched.
      const effectiveSpace = space instanceof XRReferenceSpace ? this.effectiveFor(frame, space) : space;
      return frame.getPose(effectiveSpace, effectiveBase) ?? null;
    }

    // Controllers anchor to our recenter frame (their orientation datum lives there). A page that
    // requested only non-recenterable spaces (viewer) gives us none — nothing to synthesise against.
    const recenter = this.internalRecentered;
    if (!recenter) return null;
    // Built in the recenter frame (controllerPoseInRecenter), then composed into the frame the page
    // renders through by the exact frame delta between them — both are reference spaces sharing the
    // recenter's orientation, so getPose gives it directly, no head-bridge. This is what carries the
    // controller along with the page's world (turn, teleport, even tilt) while keeping it correctly
    // placed relative to the viewer. Collapses to `clean` when the page renders straight through.
    const clean = this.controllerPoseInRecenter(frame, src);
    if (!clean) return null;
    if (effectiveBase === recenter) return this.synthPose(clean);
    const delta = frame.getPose(recenter, effectiveBase)?.transform;
    return delta ? this.synthPose(composeRigid(delta, clean)) : null;
  }

  private synthPose(transform: XRRigidTransform, emulatedPosition = true): XRPose {
    return { transform, emulatedPosition };
  }

  /** The controller's pose (body-relative offset + its own orientation) expressed in our recenter
   *  frame (internalRecentered) — the frame its orientation datum lives in, so it's self-consistent
   *  and callers can compose it wherever needed. Undefined if there's no recenter frame or its viewer
   *  pose is unavailable this frame. */
  private controllerPoseInRecenter(frame: XRFrame, src: ZapboxInputSource): XRRigidTransform | undefined {
    if (!this.internalRecentered) return undefined;
    const viewerRec = frame.getViewerPose(this.internalRecentered);
    if (!viewerRec) return undefined;
    const offset = CONTROLLER_OFFSETS[src.handedness === 'left' ? 'left' : 'right'];
    return controllerTransform(viewerRec.transform, src.controller.orientation, offset);
  }

  /**
   * getPose where the base isn't a reference space (e.g. one controller relative to another). If
   * neither endpoint is ours there's nothing to synthesise — defer to the platform. Otherwise express
   * both in our recenter frame and return `base⁻¹ ∘ space`; the shared frame cancels, so the result is
   * the true relative pose regardless of the recenter (or the page's world transform). The target is
   * never a reference space here — getPose swaps that case into the base-is-reference path.
   */
  private relativeToNonRefBase(frame: XRFrame, space: XRSpace, base: XRSpace): XRPose | null {
    const src = this.synthSourceFor(space);
    const srcBase = this.synthSourceFor(base);
    if (!src && !srcBase) return frame.getPose(space, base) ?? null;
    if (!this.internalRecentered) return null;

    const spaceInRec = src ? this.controllerPoseInRecenter(frame, src) : frame.getPose(space, this.internalRecentered)?.transform;
    const baseInRec = srcBase ? this.controllerPoseInRecenter(frame, srcBase) : frame.getPose(base, this.internalRecentered)?.transform;
    if (!spaceInRec || !baseInRec) return null;
    return this.synthPose(composeRigid(baseInRec.inverse, spaceInRec));
  }

  // --- recenter ------------------------------------------------------------

  private applyPendingReset(frame: XRFrame): void {
    if (!this.internalRaw || !this.internalRecentered) return;
    if (this.pendingControllerResets.size === 0 && !this.pendingFullReset) return;

    if (this.pendingControllerResets.size > 0) {
      // Align ONLY the controllers whose menu was held to the current gaze, read in the recenter frame
      // (where controller orientations live) so resetForward's datum matches how they're re-expressed.
      const vp = frame.getViewerPose(this.internalRecentered);
      if (vp) {
        const g = headingFromOrientation(vp.transform.orientation);
        for (const controller of this.pendingControllerResets) controller.resetForward(g.x, g.z);
        this.pendingControllerResets.clear();
      }
    }

    if (this.pendingFullReset) {
      // Full recenter: make the current physical gaze the new forward. Recenter the reference FIRST
      // (recomputed from gaze in the RAW/physical frame; effectiveFor picks it up so content rotates
      // too), THEN re-point the controllers, whose −Z datum is relative to that recentered frame.
      // Dispatch 'reset' last, once the offset and controller datums are both settled. The recenter is
      // a yaw about the base origin, but it only translates the viewer by rotating the PHYSICAL head
      // offset from that origin — the page's virtual position sits outside it (viewer =
      // playerOffset ∘ recenter⁻¹ ∘ head), so a seated user (head ~above the origin) just reorients;
      // only physically walking away from the start point would swing their position.
      const vpRaw = frame.getViewerPose(this.internalRaw);
      if (vpRaw) {
        this.pendingFullReset = false;
        const previousOffset = this.offsetTransform;
        const g = headingFromOrientation(vpRaw.transform.orientation);
        const newOffset = recenterOffsetFromGaze(g.x, g.z);
        this.setRecenter(newOffset);
        for (const s of this.inputSources) s.controller.resetForward(0, -1);
        // Origin shift from the old recenter to the new (R_old⁻¹ ∘ R_new, pure yaw) for the reset event.
        const delta = previousOffset ? composeRigid(previousOffset.inverse, newOffset) : undefined;
        this.dispatchReset(delta);
      }
    }
  }
}
