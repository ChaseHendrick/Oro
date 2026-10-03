import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createUpdateController, updateCapability, DEFAULT_PREFERENCES, CHECK_INTERVAL_MS, trustedSender, newerVersion } = require('../../electron/updates.cjs');
const { installUpdateIpc, createUpdatePreferencesFile, fetchLatestRelease, RELEASE_API } = require('../../electron/updates-host.cjs');
const { verifyUpdateArtifacts } = require('../../electron/update-artifacts.cjs');
const yaml = require('js-yaml');
const temporary = [];
afterEach(() => { vi.useRealTimers(); for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orograph-updates-')); temporary.push(root); return root; }
function setup(options = {}) {
  const updater = new EventEmitter();
  updater.autoDownload = updater.autoInstallOnAppQuit = true;
  updater.checkForUpdates = vi.fn(async () => { updater.emit('update-available', { version: '2.0.1' }); return { updateInfo: { version: '2.0.1' } }; });
  updater.downloadUpdate = vi.fn(async () => { updater.emit('download-progress', { percent: 45, total: 100, transferred: 45, bytesPerSecond: 2 }); updater.emit('update-downloaded', { version: '2.0.1' }); return ['/private/installer']; });
  updater.quitAndInstall = vi.fn();
  const writePreferences = vi.fn(), fetchRelease = vi.fn(async () => ({ tag_name: 'v2.0.1', draft: false, prerelease: false })), notify = vi.fn();
  const controller = createUpdateController({ version: '2.0.0', capability: updateCapability({ platform: 'win32', packaged: true, nsisInstalled: true }), updater, writePreferences, fetchRelease, notify, ...options });
  return { controller, updater, writePreferences, fetchRelease, notify };
}
describe('desktop update policy and state', () => {
  it('only enables installation for a packaged NSIS installation or AppImage', () => {
    expect(updateCapability({ platform: 'win32', packaged: true, nsisInstalled: true }).supportsInstall).toBe(true);
    expect(updateCapability({ platform: 'linux', packaged: true, appImage: true }).supportsInstall).toBe(true);
    for (const input of [{ platform: 'darwin', packaged: true }, { platform: 'win32', packaged: true, portable: true, nsisInstalled: true }, { platform: 'win32', packaged: true }, { platform: 'linux', packaged: true }]) expect(updateCapability(input)).toMatchObject({ kind: 'manual', supportsCheck: true, supportsInstall: false });
    expect(updateCapability({ platform: 'win32', packaged: false, nsisInstalled: true }).supportsCheck).toBe(false);
  });
  it('starts with no network, download, quit installer or scheduled checks', async () => {
    vi.useFakeTimers();
    const { controller, updater } = setup(); controller.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(controller.status().preferences).toEqual(DEFAULT_PREFERENCES);
    expect(updater.autoDownload).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled(); expect(updater.downloadUpdate).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('deduplicates simultaneous manual checks and never downloads by default', async () => {
    const { controller, updater } = setup(); let finish;
    updater.checkForUpdates.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const a = controller.check(), b = controller.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    finish({ updateInfo: { version: '2.0.1' } });
    await Promise.all([a, b]); expect(controller.status()).toMatchObject({ status: 'available', availableVersion: '2.0.1', canDownload: true, canInstall: false });
    expect(updater.downloadUpdate).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled(); controller.dispose();
  });
  it('reports clamped progress, deduplicates download, and installs only after explicit saved acknowledgement', async () => {
    const { controller, updater } = setup(); await controller.check(); let finish;
    updater.downloadUpdate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const a = controller.download(), b = controller.download();
    updater.emit('download-progress', { percent: 150, transferred: -1, total: Infinity, bytesPerSecond: NaN });
    expect(controller.status().progress).toEqual({ percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    finish(['/private/installer']); await Promise.all([a, b]);
    expect(controller.status()).toMatchObject({ status: 'downloaded', canInstall: true });
    expect(JSON.stringify(controller.status())).not.toContain('/private');
    controller.install(); expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.install({ sessionSaved: true }); expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    controller.dispose();
  });
  it('performs opted-in launch/periodic checks and notifies once per new version', async () => {
    vi.useFakeTimers(); const { controller, updater, notify } = setup({ readPreferences: () => ({ checkOnLaunch: true, periodicChecks: true }) });
    controller.start(); await vi.advanceTimersByTimeAsync(9999); expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(updater.checkForUpdates).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2); expect(notify).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    controller.setPreferences({ checkOnLaunch: false, periodicChecks: false });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2); controller.dispose();
  });
  it('only automatic-download opt-in changes downloads, never restarts', async () => {
    const { controller, updater } = setup(); controller.start(); controller.setPreferences({ autoDownload: true });
    expect(updater.checkForUpdates).not.toHaveBeenCalled(); expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await controller.check(); await Promise.resolve();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1); expect(controller.status().canInstall).toBe(true);
    expect(updater.autoDownload).toBe(false); expect(updater.autoInstallOnAppQuit).toBe(false); expect(updater.quitAndInstall).not.toHaveBeenCalled(); controller.dispose();
  });
  it('keeps preferences safe on disk errors and rejects arbitrary fields or coercions', () => {
    const write = vi.fn(() => { throw new Error('Disk full'); }); const { controller } = setup({ writePreferences: write });
    expect(controller.setPreferences({ autoDownload: true })).toMatchObject({ status: 'error', error: 'Disk full', preferences: { autoDownload: false } });
    for (const value of [{ autoDownload: 'yes' }, { url: 'https://evil.example' }, { toString: true }, { constructor: true }, ['autoDownload']]) expect(() => controller.setPreferences(value)).toThrow('Invalid');
    write.mockImplementation(() => {}); expect(controller.setPreferences({ autoDownload: true }).preferences.autoDownload).toBe(true); controller.dispose();
  });
  it('retries failed checks and signature/download errors without creating an installable update', async () => {
    const { controller, updater } = setup(); updater.checkForUpdates.mockRejectedValueOnce(new Error('Offline'));
    expect(await controller.check()).toMatchObject({ status: 'error', error: 'Offline' }); await controller.check();
    updater.downloadUpdate.mockRejectedValueOnce(new Error('Publisher signature mismatch'));
    expect(await controller.download()).toMatchObject({ status: 'error', canInstall: false, canDownload: true });
    controller.install({ sessionSaved: true }); expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await controller.download(); expect(controller.status().canInstall).toBe(true); controller.dispose();
  });
  it('permits an explicit install retry when the installer fails', async () => {
    const { controller, updater } = setup(); await controller.check(); await controller.download();
    updater.quitAndInstall.mockImplementationOnce(() => { updater.emit('error', new Error('Installer permission denied')); });
    expect(controller.install({ sessionSaved: true })).toMatchObject({ status: 'error', canInstall: true });
    controller.install({ sessionSaved: true }); expect(updater.quitAndInstall).toHaveBeenCalledTimes(2); controller.dispose();
  });
  it('uses fixed release notices for manual formats even with automatic download saved', async () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const { controller, updater, fetchRelease } = setup({ capability: updateCapability({ platform, packaged: true }), readPreferences: () => ({ autoDownload: true }) });
      expect(await controller.check()).toMatchObject({ status: 'available', availableVersion: '2.0.1', canDownload: false, canInstall: false });
      expect(fetchRelease).toHaveBeenCalledOnce(); await controller.download(); controller.install({ sessionSaved: true });
      expect(updater.checkForUpdates).not.toHaveBeenCalled(); expect(updater.downloadUpdate).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled(); controller.dispose();
    }
  });
  it('does not downgrade, offer prereleases, or accept malformed remote versions', async () => {
    expect(newerVersion('2.10.0', '2.9.0')).toBe(true); expect(newerVersion('1.9.9', '2.0.0')).toBe(false); expect(newerVersion('2.0.1-beta', '2.0.0')).toBe(false);
    const { controller, fetchRelease } = setup({ capability: updateCapability({ platform: 'darwin', packaged: true }) });
    fetchRelease.mockResolvedValueOnce({ tag_name: 'v1.5.1' }); expect((await controller.check()).status).toBe('current');
    fetchRelease.mockResolvedValueOnce({ tag_name: 'v3.0.0', prerelease: true }); expect((await controller.check()).status).toBe('error'); controller.dispose();
  });
  it('disposes timers/listeners and ignores a late check result', async () => {
    const { controller, updater, notify } = setup(); let finish;
    updater.checkForUpdates.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const checking = controller.check({ automatic: true }); controller.dispose(); finish({ updateInfo: { version: '3.0.0' } }); await checking;
    expect(controller.status().availableVersion).toBe(null); expect(updater.listenerCount('update-available')).toBe(0); expect(notify).not.toHaveBeenCalled();
  });
});
describe('updater IPC, persistence and metadata', () => {
  it('requires the owned main frame and trusted app origin before any action', async () => {
    const frame = { url: 'app://orograph/index.html' }, contents = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const trusted = { sender: contents, senderFrame: frame };
    expect(trustedSender(trusted, contents)).toBe(true);
    const handlers = new Map(), ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
    const { controller, updater } = setup(), remove = installUpdateIpc({ ipcMain, getContents: () => contents, controller });
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url: frame.url } }, { sender: contents, senderFrame: null }]) expect(() => handlers.get('orograph:updates:check')(event)).toThrow('refused');
    frame.url = 'https://example.com'; expect(() => handlers.get('orograph:updates:download')(trusted)).toThrow('refused'); frame.url = 'app://orograph/index.html';
    expect(() => handlers.get('orograph:updates:preferences')(trusted, { url: 'https://evil.example' })).toThrow('Invalid');
    await handlers.get('orograph:updates:check')(trusted); expect(updater.checkForUpdates).toHaveBeenCalledOnce(); expect(contents.send).toHaveBeenCalled();
    expect(() => handlers.get('orograph:updates:install')(trusted, { sessionSaved: true, path: '/tmp/bad' })).toThrow('Save');
    remove(); expect(handlers.size).toBe(0); controller.dispose();
  });
  it('exposes a narrow preload and removes only its own subscription', () => {
    let exposed; const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    vm.runInNewContext(fs.readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } }, ipcRenderer: ipc }) });
    expect(exposed.name).toBe('orographDesktop'); expect(Object.keys(exposed.value.updates)).toEqual(['status', 'check', 'setPreferences', 'download', 'install', 'onStatus']);
    exposed.value.updates.check(); expect(ipc.invoke).toHaveBeenCalledWith('orograph:updates:check');
    const callback = vi.fn(), off = exposed.value.updates.onStatus(callback), listener = ipc.on.mock.calls[0][1]; listener({ secret: true }, { status: 'available' });
    expect(callback).toHaveBeenCalledWith({ status: 'available' }); off(); expect(ipc.removeListener).toHaveBeenCalledWith('orograph:updates:status-changed', listener);
  });
  it('persists preferences across launch, handles corrupt files, and replaces atomically', () => {
    const file = path.join(directory(), 'updates.json'), disk = createUpdatePreferencesFile(file); expect(disk.read()).toBe(null);
    disk.write({ checkOnLaunch: true, periodicChecks: false, autoDownload: false }); expect(disk.read().checkOnLaunch).toBe(true);
    disk.write(DEFAULT_PREFERENCES); expect(disk.read()).toEqual(DEFAULT_PREFERENCES); expect(fs.existsSync(file + '.tmp')).toBe(false);
    fs.writeFileSync(file, '{invalid'); expect(disk.read()).toBe(null);
  });
  it('fetches only the fixed public release API, enforces a timeout and handles HTTP errors', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: 'v2.0.1' }) }));
    expect(await fetchLatestRelease(fetch)).toEqual({ tag_name: 'v2.0.1' }); expect(fetch.mock.calls[0][0]).toBe(RELEASE_API); expect(vi.getTimerCount()).toBe(0);
    fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Timed out')))));
    const waiting = fetchLatestRelease(fetch).catch(error => error.message); await vi.advanceTimersByTimeAsync(30000); expect(await waiting).toBe('Timed out');
    fetch.mockResolvedValue({ ok: false, status: 503 }); await expect(fetchLatestRelease(fetch)).rejects.toThrow('HTTP 503');
  });
  it('rejects manifest hashes/provider mismatches and copies an auditable packaged configuration', () => {
    const root = directory(), resource = path.join(root, 'win-unpacked', 'resources'); fs.mkdirSync(resource, { recursive: true });
    const bytes = Buffer.from('real installer fixture'), filename = 'Orograph-windows-setup.exe'; fs.writeFileSync(path.join(root, filename), bytes);
    const metadata = { version: '2.0.0', files: [{ url: filename, sha512: crypto.createHash('sha512').update(bytes).digest('base64'), size: bytes.length }] };
    fs.writeFileSync(path.join(root, 'latest.yml'), yaml.dump(metadata)); fs.writeFileSync(path.join(resource, 'app-update.yml'), yaml.dump({ provider: 'github', owner: 'ChaseHendrick', repo: 'synth' }));
    expect(verifyUpdateArtifacts(root, 'windows')).toEqual(metadata); expect(fs.existsSync(path.join(root, 'Orograph-app-update-windows.yml'))).toBe(true);
    fs.writeFileSync(path.join(root, filename), 'tampered'); expect(() => verifyUpdateArtifacts(root, 'windows')).toThrow('integrity'); fs.writeFileSync(path.join(root, filename), bytes);
    fs.writeFileSync(path.join(resource, 'app-update.yml'), yaml.dump({ provider: 'github', owner: 'someone', repo: 'synth' })); expect(() => verifyUpdateArtifacts(root, 'windows')).toThrow('provider');
  });
  it('keeps public metadata and all existing binary filenames in the release workflow without disabling signature checks', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies['electron-updater']).toBe('6.8.9'); expect(pkg.build.publish).toMatchObject({ provider: 'github', owner: 'ChaseHendrick', repo: 'synth', private: false }); expect(pkg.build.win.verifyUpdateCodeSignature).not.toBe(false);
    const workflow = yaml.load(fs.readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8'));
    const upload = workflow.jobs.desktop.steps.find(step => step.name === 'Upload packages').with.path;
    for (const pattern of ['release/Orograph-*.dmg','release/Orograph-*.zip','release/Orograph-*.exe','release/Orograph-*.AppImage','release/Orograph-*.tar.gz','release/latest*.yml','release/Orograph-*.blockmap']) expect(upload).toContain(pattern);
    expect(workflow.jobs.desktop.steps.find(step => step.name === 'Package with electron-builder').run).toContain('--publish never');
  });
});
