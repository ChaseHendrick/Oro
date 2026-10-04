'use strict';

// v2.11 Save dialog for exports (the stems zip): the renderer hands over a
// file name and the bytes, the main process asks where to save and writes
// the file. Only the app's own page may ask (trustedSender).

const path = require('node:path');
const { trustedSender } = require('./updates.cjs');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** A plain file name (no folders) every file system accepts, ending in `ext`. */
function safeFileName(name, ext = '.zip') {
  let base = String(name ?? '').split(/[\\/]/).pop().normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length).trim();
  base = base.slice(0, 120).trim() || 'oro-export';
  if (RESERVED.test(base)) base = `_${base}`;
  return base + ext;
}

function installFileIpc({ ipcMain, dialog, fs, getWindow, getContents, trusted = trustedSender }) {
  ipcMain.handle('orograph:files:save', async (event, value) => {
    if (!trusted(event, getContents())) throw new Error('Save request refused.');
    const data = value && value.data;
    const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!bytes || bytes.byteLength > MAX_BYTES) throw new Error('Nothing to save.');
    const defaultPath = safeFileName(value.name);
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      defaultPath, filters: [{ name: 'Zip archive', extensions: ['zip'] }], properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { saved: false };
    await fs.promises.writeFile(filePath, bytes);
    return { saved: true, name: path.basename(filePath) };
  });
  return () => ipcMain.removeHandler('orograph:files:save');
}

module.exports = { safeFileName, installFileIpc };
