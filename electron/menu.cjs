'use strict';

// Application menu template. Pure data so it can be unit-tested; main.cjs
// passes it to Menu.buildFromTemplate().

const { REPO_URL, RELEASES_URL, ISSUES_URL } = require('./policy.cjs');

/**
 * @param {object} o
 * @param {boolean} o.isMac
 * @param {boolean} o.isPackaged   hides developer tools in shipped builds
 * @param {string}  o.appName
 * @param {(url: string) => void} o.openExternal
 */
function buildMenuTemplate({ isMac, isPackaged, appName = 'Oro', openExternal, checkUpdates }) {
  const link = (label, url) => ({ label, click: () => openExternal(url) });

  const appMenu = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  // On macOS Quit lives in the app menu, so File only closes the window there.
  const fileMenu = {
    label: 'File',
    submenu: isMac ? [{ role: 'close' }] : [{ role: 'quit' }],
  };

  // Without an Edit menu macOS gives text fields (preset names) no Cmd+C / Cmd+V.
  // The page sees key presses first, so its own shortcuts still win.
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  const viewMenu = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...(isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu = {
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  };

  const helpMenu = {
    role: 'help',
    submenu: [
      link('Oro on GitHub', REPO_URL),
      ...(checkUpdates ? [{ label: 'Check for Updates...', click: checkUpdates }] : []),
      link('Download the Latest Version', RELEASES_URL),
      link('Report a Problem', ISSUES_URL),
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'about' }]),
    ],
  };

  return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

module.exports = { buildMenuTemplate };
