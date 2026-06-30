import { ZapboxControllerManager } from '../ZapboxControllerManager.js';
import { isSupportedEnvironment } from './isSupportedEnvironment.js';
import { ZapboxSessionAdapter, type ControllerBinding } from './ZapboxSessionAdapter.js';
import { runCalibrationPreroll } from './calibrationPreroll.js';

export interface InstallZapboxWebXROptions {
  /** Minimum controllers the user must connect to proceed (0–2). Default 0 — the page works
   *  gaze-only and treats controllers as an optional upgrade (progressive enhancement). */
  min?: number;
  /** Maximum controllers the user may connect (0–2). Default 2. */
  max?: number;
  /** Suggested count, highlighted in the "how many?" step. Ignored unless within [min, max]. */
  recommended?: number;
  /** BLE connection interval to request after each controller activates, in units of 1.25ms. */
  connectionInterval?: number;
  /**
   * Also expose Chrome's native gaze / transient-pointer input sources alongside the Zapbox
   * controllers. Default false — once controllers are connected we report only the controllers, since
   * exposing both confuses WebXR apps that assume a single input paradigm. Has no effect when zero
   * controllers connect (the shim returns the raw session, so native gaze passes through regardless).
   */
  includeNativeInputSources?: boolean;
}

let installed = false;

/**
 * Installs a transparent navigator.xr proxy that exposes paired Zapbox controllers as standard
 * WebXR input sources on immersive-vr sessions. Call once at startup, before any requestSession.
 * Safe to call from a Chrome extension on third-party pages: it no-ops (leaving navigator.xr
 * untouched) unless the environment is a supported phone-class Android Chrome with Web Bluetooth.
 */
export async function installZapboxWebXR(options: InstallZapboxWebXROptions = {}): Promise<void> {
  if (installed) return;
  if (!(await isSupportedEnvironment())) return;
  installed = true;

  const realXR = navigator.xr!;
  const realRequestSession = realXR.requestSession.bind(realXR);
  const manager = new ZapboxControllerManager({
    min: options.min ?? 0,
    max: options.max ?? 2,
    recommended: options.recommended,
    // The final setup step's "Enter VR" tap is the fresh user gesture we drive requestSession off,
    // so we don't need a separate overlay after pairing.
    finishButtonLabel: 'Enter VR',
    connectionInterval: options.connectionInterval,
  });
  let hasSetup = false;

  const requestSession = async (mode: XRSessionMode, init?: XRSessionInit): Promise<XRSession> => {
    if (mode !== 'immersive-vr') return realRequestSession(mode, init);

    if (!hasSetup) {
      // First session: run guided pairing. BLE pairing consumes the page's user gesture, but the
      // setup flow always ends on a fresh tap — the "Enter VR" finish button, the "Continue with N"
      // escape hatch, or the "Continue without controllers" count choice — so we can drive
      // requestSession straight off that without a separate overlay.
      await manager.setup();
      hasSetup = true;
    } else {
      // Subsequent sessions: the page's own gesture drives the request; just reconnect.
      void manager.reconnect();
    }

    const session = await realRequestSession(mode, init);
    const bindings = collectBindings(manager);
    if (bindings.length === 0) {
      // No controllers connected (e.g. min:0 and the user chose to continue without): leave the
      // session entirely untouched so the page behaves like a stock Cardboard WebXR page — gaze
      // and screen-tap select still work. Nothing to recenter, no synthetic input sources to add.
      return session;
    }
    // Pre-roll runs against the genuine, unpatched session (its own raw rAF loop + GL layer).
    const offset = await runCalibrationPreroll(session, bindings);
    // Constructing the adapter patches the session in place; do it only once the page is about to
    // take over, so the pre-roll's frames don't trip the inputSources announce early.
    const adapter = new ZapboxSessionAdapter(session, bindings, {
      includeNativeInputSources: options.includeNativeInputSources ?? false,
    });
    adapter.setInitialOffset(offset);
    session.addEventListener('end', () => {
      adapter.dispose();
      void manager.disconnect();
    });
    return adapter.session;
  };

  const xrProxy = new Proxy(realXR, {
    get: (target, prop) => {
      if (prop === 'requestSession') return requestSession;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  Object.defineProperty(navigator, 'xr', { value: xrProxy, configurable: true });
}

function collectBindings(manager: ZapboxControllerManager): ControllerBinding[] {
  const bindings: ControllerBinding[] = [];
  if (manager.left) bindings.push({ controller: manager.left, handedness: 'left' });
  if (manager.right) bindings.push({ controller: manager.right, handedness: 'right' });
  return bindings;
}
