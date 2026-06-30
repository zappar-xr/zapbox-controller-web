import { defineConfig } from 'tsup';

export default defineConfig([
  // Library build: ESM + CJS for npm consumers.
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  // Self-contained IIFE: bundles the full public API + BLE library + gl-matrix into one minified file
  // exposing `window.Zapbox` — the same surface as the ESM/CJS builds, for no-bundler `<script src>`
  // use, DevTools snippets, and the WebXR-shim bookmarklet (see CLAUDE.md). It does NOT auto-install
  // the WebXR shim — call `Zapbox.installZapboxWebXR(opts?)`. No `three` (demo-only), so it stays
  // small (the shim already pulls in nearly the whole library anyway).
  {
    entry: { zapbox: 'src/index.ts' },
    format: ['iife'],
    globalName: 'Zapbox',
    minify: true,
    sourcemap: false,
    dts: false,
    clean: false,
  },
]);
