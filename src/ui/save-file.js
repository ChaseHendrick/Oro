// v2.12 Save an export: the desktop app asks where to save (a native save
// dialog through the preload bridge, electron/files-host.cjs); the web
// downloads the file.

import { downloadBlob } from './dom.js';

/** The desktop bridge's save function, or null in a browser. */
export function desktopSave(root = globalThis) {
  const fn = root && root.orographDesktop && root.orographDesktop.files && root.orographDesktop.files.save;
  return typeof fn === 'function' ? fn : null;
}

/**
 * Save `blob` as `name`. Resolves to 'saved' (desktop, written), 'cancelled'
 * (desktop dialog dismissed) or 'downloaded' (browser).
 */
export async function saveBlob(blob, name, { root = globalThis, download = downloadBlob } = {}) {
  const save = desktopSave(root);
  if (!save) { download(blob, name); return 'downloaded'; }
  const res = await save(name, await blob.arrayBuffer());
  return res && res.saved ? 'saved' : 'cancelled';
}
