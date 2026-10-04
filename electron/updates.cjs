'use strict';

// Main-process update policy and state machine. Electron and disk/network access
// are injected so every automatic action and failure can be tested in Node.
const { RELEASES_URL, isAppUrl } = require('./policy.cjs');
const DEFAULT_PREFERENCES = Object.freeze({ checkOnLaunch: false, periodicChecks: false, autoDownload: false, autoInstall: false });
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAUNCH_DELAY_MS = 10000;

function preferences(value) {
  return Object.fromEntries(Object.keys(DEFAULT_PREFERENCES).map(key => [key, value?.[key] === true]));
}

function updateCapability({ platform, packaged, appImage = false, portable = false, nsisInstalled = false }) {
  // 2.11: the unsigned Mac app can opt in to replacing itself (electron/mac-update.cjs);
  // it never uses electron-updater's Squirrel path, which needs a Developer ID signature.
  if (packaged && platform === 'darwin') return { kind: 'manual', supportsCheck: true, supportsInstall: false, macAutoInstall: true,
    reason: 'This Mac build is not signed by Apple, so the built-in macOS updater cannot install it. Turn on Install updates automatically below, or download the new version and replace the app yourself.' };
  if (!packaged) return { kind: 'development', supportsCheck: false, supportsInstall: false, reason: 'This development build does not check for updates. Use a downloaded desktop release.' };
  if (platform === 'win32' && !portable && nsisInstalled) return { kind: 'nsis', supportsCheck: true, supportsInstall: true, reason: 'The Windows installer can download an update. Restart and install is always your choice.' };
  if (platform === 'linux' && appImage) return { kind: 'appimage', supportsCheck: true, supportsInstall: true, reason: 'This AppImage can download an update. Restart and install is always your choice.' };
  return { kind: 'manual', supportsCheck: true, supportsInstall: false,
    reason: platform === 'win32' ? 'Portable and unpacked Windows builds need a manual replacement. Check for release notices, then download the new version.'
        : 'This Linux archive needs a manual replacement. Check for release notices, then download the new version.' };
}

function versionParts(value) {
  const match = typeof value === 'string' && /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:\+[\w.-]+)?$/.exec(value);
  return match ? match.slice(1, 4).map(Number) : null;
}
function newerVersion(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function cleanVersion(value) { const parts = versionParts(value); return parts ? parts.join('.') : null; }
function errorText(error) { return String(error?.message || error || 'Update failed. Try again.').slice(0, 500); }
function trustedSender(event, contents) {
  return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && isAppUrl(event.senderFrame?.url);
}

function createUpdateController({ version, capability, updater, fetchRelease, macInstaller = null, quit = () => {}, readPreferences = () => null, writePreferences = () => {}, notify = () => {}, timers = globalThis, now = () => Date.now() }) {
  let prefs;
  try { prefs = preferences(readPreferences()); } catch { prefs = preferences(null); }
  const state = { currentVersion: version, capability, preferences: prefs, status: capability.supportsCheck ? 'idle' : 'disabled', availableVersion: null, lastChecked: null, progress: null, error: null, releaseUrl: RELEASES_URL };
  let disposed = false, started = false, checking = null, downloading = null, downloaded = false, installing = false, launchTimer = null, periodicTimer = null, notifiedVersion = null;
  const listeners = new Set(), updaterListeners = [];
  let latestRelease = null;
  // The opted-in Mac self-update (2.11); off unless the preference is on.
  const macAuto = () => !!(capability.macAutoInstall && macInstaller && prefs.autoInstall);
  const canInstallHere = () => capability.supportsInstall || macAuto();
  const installProblem = () => { if (!capability.macAutoInstall || !macInstaller) return null; try { return macInstaller.problem(); } catch (error) { return errorText(error); } };
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
  }
  const status = () => ({ ...state, capability: { ...capability }, preferences: { ...prefs }, progress: state.progress ? { ...state.progress } : null,
    installProblem: installProblem(),
    canDownload: canInstallHere() && !!state.availableVersion && !downloaded && !installing && state.status !== 'checking' && state.status !== 'downloading',
    canInstall: canInstallHere() && downloaded && !installing });
  function emit(change) {
    if (disposed) return;
    Object.assign(state, change);
    const snapshot = status();
    for (const listener of listeners) { try { listener(snapshot); } catch { /* renderer lifetime */ } }
  }
  const fail = error => { installing = false; emit({ status: 'error', error: errorText(error), progress: null }); return status(); };
  const listen = (name, fn) => { updater.on(name, fn); updaterListeners.push([name, fn]); };
  if (updater) {
    listen('error', fail);
    listen('update-available', info => {
      const next = cleanVersion(info?.version);
      if (!next) { fail('The release has an invalid version.'); return; }
      if (!newerVersion(next, version)) { emit({ status: 'current', availableVersion: null, error: null }); return; }
      downloaded = false;
      emit({ status: 'available', availableVersion: next, error: null, progress: null });
    });
    listen('update-not-available', () => emit({ status: 'current', availableVersion: null, error: null, progress: null }));
    listen('download-progress', progress => {
      const finite = (value, min = 0) => Number.isFinite(value) ? Math.max(min, value) : 0;
      emit({ status: 'downloading', progress: { percent: Math.min(100, finite(progress?.percent)), bytesPerSecond: finite(progress?.bytesPerSecond), total: finite(progress?.total), transferred: finite(progress?.transferred) } });
    });
    listen('update-downloaded', () => { downloaded = true; emit({ status: 'downloaded', progress: null, error: null }); });
    listen('update-cancelled', () => { downloaded = false; emit({ status: 'available', progress: null, error: null }); });
  }
  async function check({ automatic = false } = {}) {
    if (disposed || !capability.supportsCheck || installing) return status();
    if (checking) return checking;
    if (downloading || downloaded) return status();
    checking = (async () => {
      emit({ status: 'checking', error: null, progress: null });
      try {
        if (capability.supportsInstall) {
          const result = await updater.checkForUpdates();
          if (disposed) return status();
          // Production emits an event; consuming the result also handles an
          // implementation that returns valid metadata without emitting one.
          if (state.status === 'checking') {
            const next = cleanVersion(result?.updateInfo?.version);
            if (!next) throw new Error('The update server returned no valid release metadata.');
            emit({ status: newerVersion(next, version) ? 'available' : 'current', availableVersion: newerVersion(next, version) ? next : null });
          }
        } else {
          const release = await fetchRelease();
          if (disposed) return status();
          latestRelease = release;
          const next = !release?.draft && !release?.prerelease && cleanVersion(release?.tag_name);
          if (!next) throw new Error('The release server returned no valid stable release.');
          emit({ status: newerVersion(next, version) ? 'available' : 'current', availableVersion: newerVersion(next, version) ? next : null });
        }
        emit({ lastChecked: now() });
        if (automatic && state.status === 'available' && state.availableVersion !== notifiedVersion) {
          notifiedVersion = state.availableVersion;
          try { notify(status()); } catch { /* notifications are optional */ }
        }
        if (state.status === 'available' && ((prefs.autoDownload && capability.supportsInstall) || macAuto())) void download();
      } catch (error) { fail(error); }
      return status();
    })();
    try { return await checking; } finally { checking = null; }
  }
  async function download() {
    if (disposed || !canInstallHere() || !state.availableVersion || installing) return fail(capability.reason);
    if (downloading) return downloading;
    if (downloaded) return status();
    if (macAuto()) {
      downloading = (async () => {
        emit({ status: 'downloading', error: null, progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
        try {
          if (!latestRelease) throw new Error('Check for updates first.');
          await macInstaller.prepare(latestRelease, { onProgress: p => { if (!disposed) emit({ status: 'downloading', progress: { percent: Math.min(100, Math.max(0, p.percent || 0)), transferred: p.transferred || 0, total: p.total || 0, bytesPerSecond: 0 } }); } });
          if (!disposed) { downloaded = true; emit({ status: 'downloaded', progress: null, error: null }); }
        } catch (error) { downloaded = false; fail(error); }
        return status();
      })();
      try { return await downloading; } finally { downloading = null; }
    }
    downloading = (async () => {
      emit({ status: 'downloading', error: null, progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
      try {
        await updater.downloadUpdate();
        if (!disposed) { downloaded = true; emit({ status: 'downloaded', progress: null, error: null }); }
      } catch (error) { downloaded = false; fail(error); }
      return status();
    })();
    try { return await downloading; } finally { downloading = null; }
  }
  function install({ sessionSaved } = {}) {
    if (disposed || !canInstallHere() || !downloaded || sessionSaved !== true || installing) return fail('Save the session and download an update before choosing Restart and install.');
    installing = true;
    emit({ status: 'installing', error: null });
    if (macAuto()) {
      try { macInstaller.launch({ relaunch: true }); quit(); } catch (error) { installing = false; fail(error); }
      return status();
    }
    try { updater.quitAndInstall(false, true); } catch (error) { installing = false; fail(error); }
    return status();
  }
  function clearTimers() {
    if (launchTimer != null) timers.clearTimeout(launchTimer);
    if (periodicTimer != null) timers.clearInterval(periodicTimer);
    launchTimer = periodicTimer = null;
  }
  function schedule() {
    clearTimers();
    if (!started || disposed || !capability.supportsCheck) return;
    if (prefs.checkOnLaunch) launchTimer = timers.setTimeout(() => { launchTimer = null; void check({ automatic: true }); }, LAUNCH_DELAY_MS);
    if (prefs.periodicChecks) periodicTimer = timers.setInterval(() => { void check({ automatic: true }); }, CHECK_INTERVAL_MS);
  }
  function setPreferences(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !Object.hasOwn(DEFAULT_PREFERENCES, key) || typeof patch[key] !== 'boolean')) throw new Error('Invalid update preferences.');
    const next = preferences({ ...prefs, ...patch });
    try { writePreferences(next); } catch (error) { return fail(error); }
    prefs = next;
    emit({ preferences: prefs, error: null });
    schedule();
    return status();
  }
  /** Mac only: hand a staged update to the installer as Oro quits (no relaunch). */
  function installOnQuit() {
    if (disposed || installing || !downloaded || !macAuto()) return false;
    try { installing = macInstaller.launch({ relaunch: false }); return installing; } catch { return false; }
  }
  return { status, check, download, install, installOnQuit, setPreferences,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() { if (started) return; started = true; schedule(); },
    dispose() { disposed = true; clearTimers(); listeners.clear(); for (const [name, fn] of updaterListeners) updater.removeListener(name, fn); },
  };
}

module.exports = { DEFAULT_PREFERENCES, CHECK_INTERVAL_MS, LAUNCH_DELAY_MS, preferences, updateCapability, newerVersion, trustedSender, createUpdateController };
