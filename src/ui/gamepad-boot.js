// Game controllers and haptics (2.11), at startup: a tiny check of this
// computer's settings. The controller code (src/ui/gamepad-host.js) is only
// loaded when controllers or phone pulses were turned on before, or when the
// Settings pane asks for it, so startup stays as light as before.

import { PAD_PREFS_KEY } from '../core/gamepad-key.js';

let loading = null;

/** Load (once) and start the controller host. Resolves to it, or null. */
export function loadPadHost(ctx) {
  if (!loading) {
    loading = import('./gamepad-host.js').then(m => m.startPadHost(ctx)).catch((err) => {
      console.warn('[ui] game controllers are unavailable', err);
      loading = null;
      return null;
    });
  }
  return loading;
}

export function initControllers(ctx) {
  let p = null;
  try { p = JSON.parse(globalThis.localStorage?.getItem(PAD_PREFS_KEY) || 'null'); } catch { p = null; }
  if (p && (p.on || p.beat)) loadPadHost(ctx);
}
