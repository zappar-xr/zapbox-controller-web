# @zappar/zapbox-controller-web

Use [Zapbox](https://www.zappar.com/zapbox/) BLE controllers from the browser via Web Bluetooth — read
their buttons / trigger / thumbstick and get a gravity-corrected 3-DoF orientation from the onboard IMU,
with no native app required.

There are **two ways to use it**:

- **Bookmarklet (no coding).** On an Android phone, add Zapbox controller support to a WebXR page someone
  else built — save a bookmark once, open the page, and tap it. Good for trying existing `immersive-vr`
  experiences with Zapbox controllers. See [Add controllers to an existing WebXR page](#add-controllers-to-an-existing-webxr-page-bookmarklet).
- **Library (for developers).** Integrate Zapbox controllers into your own web project — either as a
  transparent **WebXR shim** (existing `immersive-vr` apps work unchanged) or through the direct
  controller API (buttons, trigger, thumbstick, orientation). See [Use it in your own project](#use-it-in-your-own-project).

> 3-DoF only — orientation, buttons, trigger and thumbstick. There is no camera tracking (6-DoF) in the
> browser.

## Add controllers to an existing WebXR page (bookmarklet)

Android Chrome already provides Google Cardboard-style 3-DoF headset tracking and Web Bluetooth, but it
has no extension support — so the shim is delivered as a **bookmarklet**: a bookmark whose address is a
small piece of code instead of a web page. Tapping it on a WebXR page loads the Zapbox shim into that
page, and when you enter VR you'll be guided through pairing your controllers.

### How to set up (one time, Android Chrome)

1. Bookmark any page (tap ⋮ followed by the ☆ icon).
2. Open your bookmarks, edit the one you just made, and replace its **URL** with the snippet below.
3. Give it a name with a short, distinctive prefix you can search for, like
   **`ZBC: Add Zapbox Controller Support`**. You'll find it by searching for `ZBC` rather than browsing
   (see below), so an unusual prefix that won't collide with your history is what matters.

```js
javascript:(function(){var s=document.createElement('script');
s.src='https://cdn.jsdelivr.net/npm/@zappar/zapbox-controller-web@0.9.6/dist/zapbox.global.js';
s.onload=function(){window.__zapboxWebXRInstalled||(window.__zapboxWebXRInstalled=Zapbox.installZapboxWebXR())};
document.head.appendChild(s)})();
```

> Viewing this on GitHub? Use the **copy button** in the snippet's top-right corner to grab the whole
> thing — handy for pasting straight into the bookmark's URL field on your phone.

### How to use it

Open a WebXR page in Chrome, then tap the address bar and type **`ZBC`** (your bookmark's prefix) — the
bookmark appears in the suggestions; tap it to run the shim on the current page. Then enter VR as usual —
you'll be prompted to pair your controllers first. If no controllers are connected the page is left
exactly as it was (headset-only), so it's always safe to run.

> Searching the address bar is the reliable way to reach the bookmark: Chrome on Android buries the
> bookmark list, and neither the address-bar suggestion chips nor the start-page shortcuts let you save a
> `javascript:` address — only a normal bookmark can hold one. That's why a distinctive, searchable name
> matters.

> The bookmarklet loads a script into the page, so it won't work on the small number of sites that block
> external scripts with a strict Content Security Policy. Most WebXR demos are fine.

## Use it in your own project

### Install

```sh
npm install @zappar/zapbox-controller-web
```

Web Bluetooth only works in a **secure context** (HTTPS or `localhost`), and `connect()` must be called
from a **user gesture** (e.g. a click).

### Quick start — a single controller

```ts
import { ZapboxController } from '@zappar/zapbox-controller-web';

const controller = await ZapboxController.connect(); // shows the browser's Bluetooth chooser

controller.addEventListener('update', (ev) => {
  const { inputState, imuSamples } = ev.detail;

  // buttons (boolean); trigger 0 to 1; thumbstickX / thumbstickY -1 to +1 (analog)
  const { buttons, trigger, thumbstickX, thumbstickY } = inputState;

  // Primary output — gravity-aligned orientation quaternion, valid once calibrated.
  if (controller.isCalibrated) {
    const q = controller.orientation; // gl-matrix quat [x, y, z, w]
  }
});

// Connection lifecycle (auto-reconnects on unexpected GATT drops / tab visibility changes):
controller.addEventListener('connected', () => {});
controller.addEventListener('reconnecting', () => {});
controller.addEventListener('disconnected', () => {});
// controller.connectionState is 'connected' | 'reconnecting' | 'disconnected'
```

On connect, place the controller on a stationary surface for a moment: the library collects ~100
stationary samples to calibrate gyro bias and align orientation to gravity. `isCalibrated` flips to
`true` when that completes.

#### Input state

```ts
inputState.buttons; // { trigger, a, b, menu, grip, thumbstickClick } — all boolean
inputState.trigger; // number, 0 (released) → 1 (fully pressed), auto-calibrated range
inputState.thumbstickX; // number, -1 (left) → +1 (right), 0 in deadzone
inputState.thumbstickY; // number, -1 (down) → +1 (up), 0 in deadzone
```

### Quick start — guided pairing (0–2 controllers)

`ZapboxControllerManager` drives a guided bottom-sheet pairing UI through connect → confirm → calibrate
for one or two controllers, then exposes them as `.left` / `.right`.

```ts
import { ZapboxControllerManager } from '@zappar/zapbox-controller-web';

const manager = new ZapboxControllerManager({ min: 0, max: 2 });
const count = await manager.setup(); // returns how many were actually connected

manager.left?.addEventListener('update', (ev) => { /* ... */ });
manager.right?.addEventListener('update', (ev) => { /* ... */ });
```

### WebXR shim

```ts
import { installZapboxWebXR } from '@zappar/zapbox-controller-web';

installZapboxWebXR(); // patches navigator.xr; no-ops on unsupported environments
```

`installZapboxWebXR(options?)` patches `navigator.xr` so existing `immersive-vr` WebXR apps see Zapbox
controllers as standard input sources with no app changes. It **no-ops unless the environment is
supported** (phone-class Android Chrome + Web Bluetooth), so it's safe to inject unconditionally. On the
first `requestSession` it runs guided pairing and a short calibration pre-roll. If zero controllers are
connected it returns the unmodified session (pure Cardboard passthrough — controllers are progressive
enhancement). Options: `{ min?, max?, recommended?, connectionInterval?, includeNativeInputSources? }`
(defaults `min: 0, max: 2`).

The controllers map to a standard `xr-standard` gamepad: `buttons[0]` trigger (analog on `.value`),
`buttons[1]` grip, `buttons[3]` thumbstick click, `buttons[4]` Menu, `buttons[5]` A, `buttons[6]` B;
thumbstick on `axes[2]` / `axes[3]`.

### Browser global (no bundler)

For `<script src>` use, the package ships a self-contained minified IIFE that exposes `window.Zapbox`
with the same API surface as the module entry point (bundles the library + `gl-matrix`). This is also
what the [bookmarklet](#add-controllers-to-an-existing-webxr-page-bookmarklet) loads:

```html
<script src="https://cdn.jsdelivr.net/npm/@zappar/zapbox-controller-web@0.9.6/dist/zapbox.global.js"></script>
<script>
  // window.Zapbox.{ ZapboxController, ZapboxControllerManager, installZapboxWebXR, ... }
  Zapbox.installZapboxWebXR();
</script>
```

## License

[MIT](./LICENSE) © Zappar Limited
