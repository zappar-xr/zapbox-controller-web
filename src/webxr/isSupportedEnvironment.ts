// UA fragments for browsers that ship native WebXR controllers (standalone headsets).
// Best-effort fallback for when UA Client Hints `formFactors` is unavailable.
const STANDALONE_HEADSET_UA = /OculusBrowser|Quest|Pico|VivePort/i;

interface UADataLike {
  mobile?: boolean;
  getHighEntropyValues?(hints: string[]): Promise<{ formFactors?: string[] }>;
}

// navigator.userAgentData (UA Client Hints) isn't in lib.dom.d.ts yet.
type NavigatorWithUAData = Navigator & { userAgentData?: UADataLike };

/**
 * True when this is a phone-class Android Chrome with Web Bluetooth — i.e. the Google
 * Cardboard scenario the shim targets. Returns false (→ the shim no-ops, leaving navigator.xr
 * untouched) on standalone headsets, desktops, and our iOS WebView app.
 *
 * Layered detection: prefer UA Client Hints (`mobile` + `formFactors` excluding "XR"), fall back
 * to UA-string sniffing. `'bluetooth' in navigator` already excludes most headset browsers.
 * Async because the `formFactors` high-entropy hint resolves via a Promise.
 */
export async function isSupportedEnvironment(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  if (!('xr' in navigator) || !navigator.xr) return false;
  if (!('bluetooth' in navigator) || !navigator.bluetooth) return false;

  const ua = navigator.userAgent ?? '';
  if (!/Android/i.test(ua)) return false; // not Android (covers desktop + iOS WebView)

  const uaData = (navigator as NavigatorWithUAData).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const { formFactors } = await uaData.getHighEntropyValues(['formFactors']);
      if (formFactors?.some(f => f.toLowerCase() === 'xr')) return false; // headset
      if (uaData.mobile === false) return false; // not a phone/tablet
      return true;
    } catch {
      // fall through to UA sniffing
    }
  }

  return !STANDALONE_HEADSET_UA.test(ua);
}
