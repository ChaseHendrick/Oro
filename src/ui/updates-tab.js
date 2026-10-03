import { h, createScope, setText } from './dom.js';
import { SESSION_KEY } from '../core/session.js';
import { writeDurable } from '../core/durable-storage.js';

const RELEASES_URL = 'https://github.com/ChaseHendrick/synth/releases/latest';

/** Desktop updates use a narrow preload bridge. Browser/offline builds retain
 * the same fixed release link without requesting desktop permissions. */
export function createUpdatesTab(ctx, { version, api = globalThis.orographDesktop?.updates } = {}) {
  const scope = createScope();
  let disposed = false, busy = false, state = null, localError = '';
  const status = h('p', { class: 'setting-label', role: 'status', 'aria-live': 'polite' }, api ? 'Loading update settings...' : 'Desktop updates are available in the downloaded app.');
  const description = h('p', { class: 'setting-hint' }, api ? '' : 'To update this browser or offline copy, download the latest release.');
  const error = h('p', { class: 'setting-hint is-bad', role: 'alert' });
  const progress = h('progress', { max: 100, value: 0, hidden: true, 'aria-label': 'Update download progress', style: 'width:100%' });
  const checks = {};
  function option(key, label, hint) {
    const input = h('input', { type: 'checkbox', 'aria-label': label });
    checks[key] = input;
    scope.on(input, 'change', () => { const selected = !!input.checked; void run(() => api.setPreferences({ [key]: selected })); });
    return h('label', { class: 'setting-row' }, h('span', { class: 'setting-text' }, h('span', { class: 'setting-label' }, label), h('span', { class: 'setting-hint', style: 'display:block' }, hint)), input);
  }
  const preferences = h('section', { class: 'settings-group', hidden: !api }, h('h3', { class: 'group-title' }, 'Your choices'),
    option('checkOnLaunch', 'Check on launch', 'After launch, check for a newer release. Off by default.'),
    option('periodicChecks', 'Check periodically', 'Check every six hours while the app is open. Off by default.'),
    option('autoDownload', 'Download updates automatically', 'Windows installer and Linux AppImage only. Never restarts or installs automatically. Off by default.'));
  const check = h('button', { type: 'button', class: 'btn btn--primary btn--sm', hidden: !api }, 'Check now');
  const download = h('button', { type: 'button', class: 'btn btn--sm', hidden: true }, 'Download update');
  const install = h('button', { type: 'button', class: 'btn btn--primary btn--sm', hidden: true }, 'Restart and install');
  const release = h('a', { class: 'btn btn--ghost btn--sm', href: RELEASES_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Download latest release');
  async function run(action) {
    if (busy || disposed || !api) return;
    busy = true; localError = ''; render();
    try { const next = await action(); if (!disposed && next) state = next; }
    catch (err) { localError = String(err?.message || 'Update failed. Try again.'); }
    finally { busy = false; if (!disposed) render(); }
  }
  scope.on(check, 'click', () => run(() => api.check()));
  scope.on(download, 'click', () => run(() => api.download()));
  scope.on(install, 'click', () => run(async () => {
    // Wait for actual persistence before asking main to quit. A failed save
    // leaves the downloaded update ready for a later explicit attempt.
    const saved = ctx.prepareUpdate ? await ctx.prepareUpdate()
      : ctx.store?.serialize ? await writeDurable(SESSION_KEY, JSON.stringify(ctx.store.serialize())).done : false;
    if (saved !== true) throw new Error('Your session could not be saved. Export a scene or retry the save before restarting.');
    return api.install();
  }));
  function render() {
    if (disposed) return;
    const messages = {
      idle: 'No update check has been made.', checking: 'Checking for updates...', current: 'Oro is up to date.',
      available: `Oro ${state?.availableVersion || ''} is available.`, downloading: `Downloading update${state?.progress ? `: ${Math.round(state.progress.percent)}%` : '...'}`,
      downloaded: `Oro ${state?.availableVersion || ''} is downloaded. Save and restart when you are ready.`,
      installing: 'Restarting to install the update...', error: 'The update did not complete. You can try again.', disabled: 'Update checks are unavailable in this development build.',
    };
    if (state) {
      setText(status, messages[state.status] || 'Update status unavailable.');
      setText(description, state.capability.reason);
      for (const [key, input] of Object.entries(checks)) {
        input.checked = !!state.preferences[key];
        input.disabled = busy || !state.capability.supportsCheck || (key === 'autoDownload' && !state.capability.supportsInstall);
      }
    }
    check.disabled = busy || !state?.capability.supportsCheck || ['checking', 'downloading', 'installing', 'downloaded'].includes(state?.status);
    download.hidden = !state?.capability.supportsInstall;
    download.disabled = busy || !state?.canDownload;
    install.hidden = !state?.canInstall;
    install.disabled = busy;
    progress.hidden = state?.status !== 'downloading';
    progress.value = state?.progress?.percent || 0;
    const message = localError || state?.error || '';
    error.hidden = !message; setText(error, message);
  }
  if (api) {
    scope.add(api.onStatus(next => { if (!disposed) { state = next; render(); } }));
    void api.status().then(next => { if (!disposed) { state = next; render(); } }).catch(err => { localError = err?.message || 'Update settings could not be loaded.'; render(); });
  }
  const el = h('div', { class: 'settings-pane' },
    h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, 'Oro updates'),
      h('p', { class: 'setting-hint' }, `Installed version ${version || 'unknown'}. Earlier releases without this updater need one manual upgrade.`),
      status, description, error, progress, h('div', { class: 'btn-row' }, check, download, install, release)), preferences);
  render();
  return { el, dispose() { disposed = true; scope.dispose(); } };
}
