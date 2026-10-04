import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import { saveBlob, desktopSave } from '../../src/ui/save-file.js';
const require = createRequire(import.meta.url);
const { safeFileName, installFileIpc } = require('../../electron/files-host.cjs');

describe('desktop save dialog (2.12)', () => {
  it('sanitises the default file name', () => {
    expect(safeFileName('oro-stems-20261003-094100.zip')).toBe('oro-stems-20261003-094100.zip');
    expect(safeFileName('../../etc/passwd')).toBe('passwd.zip');
    expect(safeFileName('C:\\Users\\x\\a<b>:c?.zip')).toBe('a b c.zip');
    expect(safeFileName('  ...  ')).toBe('oro-export.zip');
    expect(safeFileName('con')).toBe('_con.zip');
    expect(safeFileName('x'.repeat(300)).length).toBe(124);
  });

  it('asks where to save, writes the bytes, and refuses untrusted senders', async () => {
    const handlers = {};
    const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: vi.fn() };
    const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/tmp/out/stems.zip' })) };
    const fsFake = { promises: { writeFile: vi.fn(async () => {}) } };
    let trusted = true;
    const off = installFileIpc({ ipcMain, dialog, fs: fsFake, getWindow: () => 'win', getContents: () => 'contents', trusted: () => trusted });
    const data = new Uint8Array([1, 2, 3]).buffer;
    await expect(handlers['orograph:files:save']({}, { name: 'a/b.zip', data })).resolves.toEqual({ saved: true, name: 'stems.zip' });
    expect(dialog.showSaveDialog.mock.calls[0][0]).toBe('win');
    expect(dialog.showSaveDialog.mock.calls[0][1]).toMatchObject({ defaultPath: 'b.zip', filters: [{ name: 'Zip archive', extensions: ['zip'] }] });
    expect(fsFake.promises.writeFile.mock.calls[0][0]).toBe('/tmp/out/stems.zip');
    expect([...fsFake.promises.writeFile.mock.calls[0][1]]).toEqual([1, 2, 3]);
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(handlers['orograph:files:save']({}, { name: 'x', data })).resolves.toEqual({ saved: false });
    await expect(handlers['orograph:files:save']({}, { name: 'x', data: 'nope' })).rejects.toThrow(/Nothing/);
    trusted = false;
    await expect(handlers['orograph:files:save']({}, { name: 'x', data })).rejects.toThrow(/refused/);
    off();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('orograph:files:save');
  });

  it('exposes files.save on the preload bridge', () => {
    let exposed; const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    vm.runInNewContext(fs.readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } }, ipcRenderer: ipc }) });
    expect(Object.keys(exposed.value.files)).toEqual(['save']);
    const buf = new ArrayBuffer(2);
    exposed.value.files.save('a.zip', buf);
    expect(ipc.invoke).toHaveBeenCalledWith('orograph:files:save', { name: 'a.zip', data: buf });
  });

  it('falls back to a download in a browser', async () => {
    const blob = new Blob([new Uint8Array([9, 8])]);
    const download = vi.fn();
    expect(desktopSave({})).toBe(null);
    await expect(saveBlob(blob, 'x.zip', { root: {}, download })).resolves.toBe('downloaded');
    expect(download).toHaveBeenCalledWith(blob, 'x.zip');
    const save = vi.fn(async (name, data) => ({ saved: data.byteLength === 2 && name === 'x.zip' }));
    await expect(saveBlob(blob, 'x.zip', { root: { orographDesktop: { files: { save } } }, download })).resolves.toBe('saved');
    save.mockResolvedValueOnce({ saved: false });
    await expect(saveBlob(blob, 'x.zip', { root: { orographDesktop: { files: { save } } }, download })).resolves.toBe('cancelled');
    expect(download).toHaveBeenCalledTimes(1);
  });
});
