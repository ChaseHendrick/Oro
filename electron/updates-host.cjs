'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { trustedSender } = require('./updates.cjs');
const RELEASE_API = 'https://api.github.com/repos/ChaseHendrick/synth/releases/latest';

function createUpdatePreferencesFile(file) {
  return {
    read() {
      try { if (fs.statSync(file).size > 8192) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file); }
      catch (error) { try { fs.unlinkSync(temporary); } catch { /* absent */ } throw error; }
    },
  };
}

async function fetchLatestRelease(fetch, timers = globalThis) {
  const abort = new AbortController();
  const timeout = timers.setTimeout(() => abort.abort(), 30000);
  try {
    const response = await fetch(RELEASE_API, { signal: abort.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Orograph-desktop' } });
    if (!response.ok) throw new Error(`The release server returned HTTP ${response.status}. Try again later.`);
    return await response.json();
  } finally { timers.clearTimeout(timeout); }
}

function installUpdateIpc({ ipcMain, getContents, controller }) {
  const methods = {
    status: () => controller.status(),
    check: () => controller.check(),
    preferences: value => controller.setPreferences(value),
    download: () => controller.download(),
    install: value => {
      if (!value || value.sessionSaved !== true || Object.keys(value).some(key => key !== 'sessionSaved')) throw new Error('Save the session before installing.');
      return controller.install(value);
    },
  };
  for (const [name, invoke] of Object.entries(methods)) {
    ipcMain.handle(`orograph:updates:${name}`, (event, value) => {
      if (!trustedSender(event, getContents())) throw new Error('Update request refused.');
      return invoke(value);
    });
  }
  const off = controller.subscribe(status => {
    const contents = getContents();
    if (contents && !contents.isDestroyed()) contents.send('orograph:updates:status-changed', status);
  });
  return () => { off(); for (const name of Object.keys(methods)) ipcMain.removeHandler(`orograph:updates:${name}`); };
}
module.exports = { RELEASE_API, createUpdatePreferencesFile, fetchLatestRelease, installUpdateIpc };
