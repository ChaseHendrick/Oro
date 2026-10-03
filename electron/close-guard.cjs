'use strict';

// Bounce reminder in the desktop close flow (2.11). The renderer reports
// whether it has changes since the last bounce and the reminder is on; when
// the window closes with such changes, a gentle dialog offers to bounce first.
// It never blocks an update restart and asks once per close.
const { trustedSender } = require('./updates.cjs');

function createCloseGuard({ dialog, isInstalling = () => false, quit = () => {} }) {
  let unbounced = false, asking = false, allowed = false, quitting = false;
  function attach(win) {
    const onClose = event => {
      if (allowed || !unbounced || isInstalling() || win.isDestroyed()) return;
      event.preventDefault();
      if (asking) return;
      asking = true;
      const wasQuitting = quitting;
      Promise.resolve(dialog.showMessageBox(win, {
        type: 'question', buttons: ['Bounce now', 'Close'], defaultId: 0, cancelId: 1, noLink: true,
        message: 'Bounce before you close?',
        detail: 'You changed things since your last bounce. Your session is saved either way. A bounce renders the music to a WAV file offline, so it cannot glitch. Turn this off in Settings > Audio > Remind me to bounce.',
      })).then(({ response }) => {
        asking = false;
        if (win.isDestroyed()) return;
        if (response === 0) { quitting = false; win.webContents.send('orograph:session:open-bounce'); return; }
        allowed = true;
        if (wasQuitting) quit(); else win.close();
      }, () => { asking = false; allowed = true; if (!win.isDestroyed()) win.close(); });
    };
    win.on('close', onClose);
    return () => win.removeListener('close', onClose);
  }
  return {
    attach,
    beforeQuit() { quitting = true; },
    setUnbounced(value) { unbounced = value === true; },
    /** IPC: only the trusted app frame may report its state. */
    install({ ipcMain, getContents }) {
      const channel = 'orograph:session:unbounced';
      ipcMain.on(channel, (event, value) => { if (trustedSender(event, getContents())) unbounced = value === true; });
      return () => ipcMain.removeAllListeners(channel);
    },
  };
}
module.exports = { createCloseGuard };
