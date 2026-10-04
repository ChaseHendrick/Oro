// Live mode (2.12): keep the screen awake while on stage (Screen Wake Lock),
// and the full-screen request with its fallback. Both fail silently where the
// browser does not offer them; live mode then stays a full-window overlay.

/**
 * acquire() asks for a screen wake lock and asks again whenever the page
 * becomes visible (browsers drop the lock when it is hidden); release()
 * lets it go. Resolves to true when a lock is held.
 */
export function createWakeLock({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
  let sentinel = null;
  let wanted = false;
  const supported = !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');

  async function request() {
    if (!wanted || !supported || sentinel) return !!sentinel;
    if (doc && doc.visibilityState === 'hidden') return false;
    try {
      const s = await nav.wakeLock.request('screen');
      if (!wanted) { try { await s.release(); } catch { /* already gone */ } return false; }
      sentinel = s;
      if (s && typeof s.addEventListener === 'function') s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
      return true;
    } catch {
      sentinel = null;
      return false;
    }
  }
  const onVisible = () => { if (wanted && doc && doc.visibilityState === 'visible') request(); };

  return {
    supported,
    acquire() {
      if (!wanted && doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);
      wanted = true;
      return request();
    },
    release() {
      if (wanted && doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
      wanted = false;
      const s = sentinel;
      sentinel = null;
      if (s && typeof s.release === 'function') { try { Promise.resolve(s.release()).catch(() => {}); } catch { /* ignore */ } }
    },
    held: () => !!sentinel,
  };
}

/** Ask for `el` to fill the screen. Resolves to true when it did. */
export async function enterFullscreen(el, doc = globalThis.document) {
  if (!el || typeof el.requestFullscreen !== 'function' || (doc && doc.fullscreenEnabled === false)) return false;
  try {
    await el.requestFullscreen({ navigationUI: 'hide' });
    return !doc || doc.fullscreenElement === el;
  } catch {
    return false;
  }
}

/** Leave full screen if `el` (or anything) is showing full screen. */
export function leaveFullscreen(doc = globalThis.document) {
  try {
    if (doc && doc.fullscreenElement && typeof doc.exitFullscreen === 'function') return Promise.resolve(doc.exitFullscreen()).catch(() => {});
  } catch { /* ignore */ }
  return Promise.resolve();
}
