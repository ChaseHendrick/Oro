'use strict';

// Orograph desktop shell (Electron main process).
//
// Loads the Vite build in dist/ through a privileged app://orograph/ scheme so
// the page gets a real, secure origin (localStorage, Web MIDI, AudioWorklet and
// ES modules behave exactly as on the web). The renderer is sandboxed with no
// Node access and no preload: the web app needs nothing from the main process.

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, nativeTheme, protocol, screen, session, shell } = require('electron');

const policy = require('./policy.cjs');
const { createAppHandler } = require('./serve.cjs');
const { buildMenuTemplate } = require('./menu.cjs');
const { MIN_SIZE, fitToDisplays, createWindowStateFile } = require('./window-state.cjs');

const isMac = process.platform === 'darwin';
// Same colours index.html paints before the app loads, so there is no flash.
const BACKGROUND = { dark: '#070a12', light: '#efe7d8' };

function log(...args) {
  console.log('[orograph]', ...args);
}

// Development overrides, ignored in packaged builds:
//   OROGRAPH_DIST       serve another build folder (used by the packaging tests)
//   OROGRAPH_USER_DATA  isolate settings, window state and the single-instance lock
const distDir = !app.isPackaged && process.env.OROGRAPH_DIST
  ? path.resolve(process.env.OROGRAPH_DIST)
  : path.join(__dirname, '..', 'dist');
if (!app.isPackaged && process.env.OROGRAPH_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.OROGRAPH_USER_DATA));
}

// Must happen before 'ready': privileges cannot be granted to a scheme later.
// standard: real origin + relative URL resolution; secure: secure context (Web MIDI,
// AudioWorklet); supportFetchAPI/corsEnabled: fetch() and module scripts; stream:
// media elements can seek with range requests.
protocol.registerSchemesAsPrivileged([{
  scheme: policy.APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

let mainWindow = null;

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openExternal(url) {
  if (!policy.isExternalUrl(url)) {
    log('refused to open', url);
    return;
  }
  shell.openExternal(url).catch((err) => log('could not open', url, err.message));
}

function installPermissionPolicy(ses) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const source = (details && details.requestingUrl) || (webContents && webContents.getURL()) || '';
    const granted = policy.isPermissionAllowed(permission, source);
    if (!granted) log(`denied permission "${permission}" for ${policy.originOf(source) || 'unknown origin'}`);
    callback(granted);
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const source = requestingOrigin || (details && details.requestingUrl) || '';
    return policy.isPermissionCheckAllowed(permission, source, details);
  });
  // WebHID / WebUSB / Web Serial are never needed.
  ses.setDevicePermissionHandler(() => false);
}

// Applies to every renderer, including DevTools and anything a page tries to open.
function guardWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (policy.navigationAction(url) === 'external') openExternal(url);
    else log('blocked window.open', url);
    return { action: 'deny' };
  });

  const guardNavigation = (event, legacyUrl) => {
    const url = (event && event.url) || legacyUrl;
    const action = policy.navigationAction(url);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'external') openExternal(url);
    else log('blocked navigation', url);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function showEditContextMenu(win, params) {
  if (!params.isEditable) return;
  const { editFlags } = params;
  Menu.buildFromTemplate([
    { role: 'cut', enabled: editFlags.canCut },
    { role: 'copy', enabled: editFlags.canCopy },
    { role: 'paste', enabled: editFlags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: editFlags.canSelectAll },
  ]).popup({ window: win });
}

// On macOS the window uses an inset title bar, so the traffic lights sit on top
// of the page. titleBarOverlay exposes their size to CSS as env(titlebar-area-*)
// (the UI uses those to pad its top bar and mark it draggable). This rule only
// guarantees a grab handle in the corner the traffic lights already cover.
const MAC_DRAG_CORNER_CSS = `html::before {
  content: ''; position: fixed; top: 0; left: 0; z-index: 2147483647;
  width: env(titlebar-area-x, 0px); height: env(titlebar-area-height, 0px);
  -webkit-app-region: drag; app-region: drag; pointer-events: none;
}`;

function createMainWindow() {
  const stateFile = createWindowStateFile(path.join(app.getPath('userData'), 'window-state.json'));
  const primary = screen.getPrimaryDisplay();
  const workAreas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  const bounds = fitToDisplays(stateFile.load(), workAreas);

  const iconPath = path.join(distDir, 'icon-512.png');
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : { center: true }),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Orograph',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    ...(isMac ? { titleBarStyle: 'hiddenInset', titleBarOverlay: true } : {}),
    // Linux shows this in the task switcher; macOS and Windows use the bundle icon.
    ...(process.platform === 'linux' && fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false, // no red squiggles under preset names
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // keep the sequencer and audio scheduling on time when hidden
    },
  });
  mainWindow = win;

  let shown = false;
  const showOnce = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    // maximize() also shows the window, so it waits until the first paint too.
    if (bounds.maximized) win.maximize();
    win.show();
  };
  win.once('ready-to-show', showOnce);
  // ready-to-show can be skipped if the GPU process struggles; never leave an invisible app.
  setTimeout(showOnce, 4000);

  let saveTimer = null;
  const saveState = () => {
    clearTimeout(saveTimer);
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    stateFile.save({ ...win.getNormalBounds(), maximized: win.isMaximized() });
  };
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('maximize', saveSoon);
  win.on('unmaximize', saveSoon);
  win.on('close', saveState);
  win.on('closed', () => {
    clearTimeout(saveTimer);
    if (mainWindow === win) mainWindow = null;
  });

  const wc = win.webContents;
  wc.on('did-finish-load', () => {
    log('loaded', wc.getURL());
    if (isMac) wc.insertCSS(MAC_DRAG_CORNER_CSS).catch(() => {});
  });
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log(`failed to load ${url}: ${description} (${code})`);
  });
  wc.on('context-menu', (_event, params) => showEditContextMenu(win, params));
  if (!app.isPackaged) {
    wc.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') log(`renderer ${event.level}: ${event.message}`);
    });
  }

  let crashPromptOpen = false;
  wc.on('render-process-gone', async (_event, details) => {
    log('renderer gone:', details.reason, details.exitCode);
    if (details.reason === 'clean-exit' || crashPromptOpen || win.isDestroyed()) return;
    crashPromptOpen = true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      message: 'Orograph stopped unexpectedly.',
      detail: 'Your last session is saved automatically. Reload to carry on playing.',
    });
    crashPromptOpen = false;
    if (win.isDestroyed()) return;
    if (response === 0) wc.reload();
    else app.quit();
  });

  win.loadURL(policy.START_URL).catch((err) => log('loadURL failed:', err.message));
  return win;
}

function start() {
  if (process.platform === 'win32') app.setAppUserModelId('com.hendrickresearch.orograph');

  app.on('second-instance', focusMainWindow);
  // Otherwise Chromium fetches Hunspell dictionaries from Google as soon as the
  // session exists (Windows and Linux); Orograph should make no network requests.
  // Disabling alone is not enough; clearing the language list stops the download.
  app.on('session-created', (ses) => {
    ses.setSpellCheckerEnabled(false);
    ses.setSpellCheckerLanguages([]);
  });
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));

  app.whenReady().then(() => {
    log(`Orograph ${app.getVersion()} on Electron ${process.versions.electron}; serving ${distDir}`);

    protocol.handle(policy.APP_SCHEME, createAppHandler({ root: distDir, host: policy.APP_HOST, log }));
    installPermissionPolicy(session.defaultSession);

    app.setAboutPanelOptions({
      applicationName: 'Orograph',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright (c) 2026 Chase. MIT License.',
      credits: 'A 3D wave terrain synthesizer. Built with three.js and Rapier.',
      website: policy.REPO_URL,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
      isMac,
      isPackaged: app.isPackaged,
      appName: 'Orograph',
      openExternal,
    })));

    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      else focusMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}

// A second launch just brings the existing window forward (and avoids two
// instances fighting over the same MIDI ports and saved session).
if (app.requestSingleInstanceLock()) {
  start();
} else {
  app.quit();
}
