'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// The renderer receives no IPC object, paths or arbitrary URL/network methods.
contextBridge.exposeInMainWorld('orographDesktop', Object.freeze({
  // v2.11 save dialog for exports (electron/files-host.cjs)
  files: Object.freeze({ save: (name, data) => ipcRenderer.invoke('orograph:files:save', { name: String(name), data }) }),
  updates: Object.freeze({
  status: () => ipcRenderer.invoke('orograph:updates:status'),
  check: () => ipcRenderer.invoke('orograph:updates:check'),
  setPreferences: preferences => ipcRenderer.invoke('orograph:updates:preferences', preferences),
  download: () => ipcRenderer.invoke('orograph:updates:download'),
  install: () => ipcRenderer.invoke('orograph:updates:install', { sessionSaved: true }),
  onStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a status callback.');
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('orograph:updates:status-changed', listener);
    return () => ipcRenderer.removeListener('orograph:updates:status-changed', listener);
  },
}),
// 2.11 bounce reminder: report unbounced changes for the close prompt, and open Bounce when asked.
session: Object.freeze({
  setUnbounced: value => ipcRenderer.send('orograph:session:unbounced', value === true),
  onOpenBounce: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
    const listener = () => callback();
    ipcRenderer.on('orograph:session:open-bounce', listener);
    return () => ipcRenderer.removeListener('orograph:session:open-bounce', listener);
  },
}) }));
