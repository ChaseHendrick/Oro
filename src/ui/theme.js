// Theme system (see "Theme contract" in docs/ARCHITECTURE.md).
//   * ui.theme holds the preference: 'system' | 'dark' | 'light'
//   * document.documentElement.dataset.theme is always the resolved theme
//   * every change of the resolved theme dispatches `orograph:theme`
//   * the preference persists in localStorage['orograph.theme']
// index.html runs the same resolution inline before first paint so the page
// never flashes the wrong colours; this module takes over after boot.

export const THEME_KEY = 'orograph.theme';
export const THEME_PREFS = ['system', 'dark', 'light'];

export function normalizePref(v) {
  return THEME_PREFS.includes(v) ? v : 'system';
}

export function resolveTheme(pref, systemDark) {
  const p = normalizePref(pref);
  if (p === 'system') return systemDark ? 'dark' : 'light';
  return p;
}

export function nextPref(pref) {
  const i = THEME_PREFS.indexOf(normalizePref(pref));
  return THEME_PREFS[(i + 1) % THEME_PREFS.length];
}

export function readStoredPref(storage = globalThis.localStorage) {
  try { return normalizePref(storage?.getItem(THEME_KEY)); } catch { return 'system'; }
}

export function writeStoredPref(pref, storage = globalThis.localStorage) {
  try { storage?.setItem(THEME_KEY, normalizePref(pref)); } catch { /* private mode / blocked */ }
}

/**
 * Wire the theme to the store and the OS. Returns { resolved(), dispose() }.
 * `onResolved(theme)` runs after every effective change (used to recompute
 * part colour tones).
 */
export function createTheme({ store, onResolved } = {}) {
  const root = document.documentElement;
  let mq = null;
  try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch { mq = null; }
  const systemDark = () => (mq ? mq.matches : true);
  let animTimer = 0;

  const initialPref = readStoredPref();
  if (store && store.get('ui.theme') !== initialPref) store.set('ui.theme', initialPref, { source: 'theme' });

  function apply(animate) {
    const pref = normalizePref(store ? store.get('ui.theme') : readStoredPref());
    const theme = resolveTheme(pref, systemDark());
    const changed = root.dataset.theme !== theme;
    root.dataset.themePref = pref;
    if (changed) {
      if (animate) {
        // Colour transitions only while switching, so normal hovers stay instant.
        root.classList.add('theme-anim');
        clearTimeout(animTimer);
        animTimer = setTimeout(() => root.classList.remove('theme-anim'), 450);
      }
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      root.style.background = '';
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        meta.setAttribute('content', theme === 'light' ? '#f4eee2' : '#070a12');
      }
      window.dispatchEvent(new CustomEvent('orograph:theme', { detail: { theme } }));
    }
    if (onResolved) onResolved(theme, changed);
    return theme;
  }

  apply(false);
  // Always announce once at boot so late listeners (visuals) can sync even if
  // the inline bootstrap already set the attribute.
  window.dispatchEvent(new CustomEvent('orograph:theme', { detail: { theme: root.dataset.theme } }));

  const offStore = store ? store.subscribe('ui.theme', () => {
    writeStoredPref(store.get('ui.theme'));
    apply(true);
  }) : () => {};
  const onSystem = () => apply(true);
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  }

  return {
    resolved: () => root.dataset.theme,
    cycle() {
      const next = nextPref(store.get('ui.theme'));
      store.set('ui.theme', next, { source: 'ui' });
      return next;
    },
    dispose() {
      offStore();
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', onSystem);
        else if (mq.removeListener) mq.removeListener(onSystem);
      }
    },
  };
}
