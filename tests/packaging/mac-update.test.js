import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const mac = require('../../electron/mac-update.cjs');
const { createUpdateController, updateCapability, newerVersion, DEFAULT_PREFERENCES } = require('../../electron/updates.cjs');
const { createCloseGuard } = require('../../electron/close-guard.cjs');
const yaml = require('js-yaml');

const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function directory(prefix = 'oro-mac-') { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temporary.push(root); return root; }
const sha = bytes => crypto.createHash('sha512').update(bytes).digest('base64');
const BASE = 'https://github.com/ChaseHendrick/Oro/releases/download/v2.12.0/';
const plist = version => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleName</key>\n<string>Oro</string>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>`;

/** A fake node:https serving `routes` (url -> { status, body, location }). */
function fakeHttps(routes) {
  const get = vi.fn((url, _options, callback) => {
    const route = routes[url] || { status: 404, body: '' };
    const request = new EventEmitter(); request.setTimeout = vi.fn(); request.destroy = vi.fn();
    queueMicrotask(() => {
      const response = Readable.from(route.body == null ? [] : [Buffer.from(route.body)]);
      response.statusCode = route.status || 200;
      response.headers = route.location ? { location: route.location } : { 'content-length': String(Buffer.byteLength(route.body || '')) };
      callback(response);
    });
    return request;
  });
  return { get };
}

describe('Mac automatic update: pure parts', () => {
  const manifest = { version: '2.12.0', files: [
    { url: 'Oro-mac-arm64.zip', sha512: sha('arm'), size: 3 }, { url: 'Oro-mac-x64.zip', sha512: sha('intel'), size: 5 },
    { url: 'Oro-mac-arm64.dmg', sha512: sha('dmg'), size: 3 }], path: 'Oro-mac-arm64.zip', sha512: sha('arm'), releaseDate: "'2026-10-01T00:00:00.000Z'" };

  it('parses latest-mac.yml as electron-builder writes it', () => {
    const parsed = mac.parseLatestMacYml(yaml.dump(manifest));
    expect(parsed.version).toBe('2.12.0');
    expect(parsed.files).toEqual(manifest.files);
    expect(mac.parseLatestMacYml("version: '2.12.0'\nfiles:\n  - url: Oro-mac-x64.zip\n    sha512: abc\n    size: 12\n").files[0]).toEqual({ url: 'Oro-mac-x64.zip', sha512: 'abc', size: 12 });
    for (const bad of ['', 'version: latest\nfiles: []\n', 'x'.repeat(70000), null]) expect(() => mac.parseLatestMacYml(bad)).toThrow();
  });
  it('picks the zip for this processor and requires its checksum', () => {
    const parsed = mac.parseLatestMacYml(yaml.dump(manifest));
    expect(mac.pickMacZip(parsed, 'arm64').url).toBe('Oro-mac-arm64.zip');
    expect(mac.pickMacZip(parsed, 'x64').url).toBe('Oro-mac-x64.zip');
    expect(() => mac.pickMacZip(parsed, 'ia32')).toThrow('processor');
    expect(() => mac.pickMacZip({ files: [{ url: 'Oro-mac-x64.zip', sha512: 'short' }] }, 'x64')).toThrow('checksum');
  });
  it('accepts release assets only from this repository', () => {
    const release = { assets: [{ name: 'latest-mac.yml', browser_download_url: BASE + 'latest-mac.yml' }, { name: 'Oro-mac-x64.zip', browser_download_url: 'https://evil.example/Oro-mac-x64.zip' }] };
    expect(mac.assetUrl(release, 'latest-mac.yml')).toBe(BASE + 'latest-mac.yml');
    expect(() => mac.assetUrl(release, 'Oro-mac-x64.zip')).toThrow();
    expect(() => mac.assetUrl({}, 'latest-mac.yml')).toThrow();
  });
  it('verifies the sha512 of a downloaded file and refuses a mismatch', async () => {
    const file = path.join(directory(), 'Oro-mac-arm64.zip'); fs.writeFileSync(file, 'arm');
    await expect(mac.verifySha512(fs, file, sha('arm'))).resolves.toBe(true);
    await expect(mac.verifySha512(fs, file, sha('tampered'))).rejects.toThrow('does not match');
    await expect(mac.verifySha512(fs, file, undefined)).rejects.toThrow('does not match');
  });
  it('compares versions numerically', () => {
    expect(newerVersion('2.10.0', '2.9.0')).toBe(true); expect(newerVersion('2.9.0', '2.10.0')).toBe(false); expect(newerVersion('2.10.0', '2.10.0')).toBe(false);
    expect(mac.bundleVersion(plist('2.12.0'))).toBe('2.12.0'); expect(mac.bundleVersion('<dict></dict>')).toBe(null);
  });
  it('finds the running bundle and refuses translocated, read-only or unwritable locations', () => {
    expect(mac.appBundlePath('/Applications/Oro.app/Contents/MacOS/Oro')).toBe('/Applications/Oro.app');
    expect(mac.appBundlePath('/Users/a b/Applications/Oro.app/Contents/MacOS/Oro')).toBe('/Users/a b/Applications/Oro.app');
    expect(mac.appBundlePath('/usr/bin/node')).toBe(null);
    const ok = () => {}, denied = () => { throw new Error('EACCES'); };
    expect(mac.installLocationProblem('/Applications/Oro.app', { access: ok })).toBe(null);
    expect(mac.installLocationProblem('/private/var/folders/xy/T/AppTranslocation/1234/d/Oro.app', { access: ok })).toMatch(/Applications folder/);
    expect(mac.installLocationProblem('/Volumes/Oro 2.12.0/Oro.app', { access: denied })).toMatch(/disk image/);
    expect(mac.installLocationProblem('/Applications/Oro.app', { access: denied })).toMatch(/cannot write/);
    expect(mac.installLocationProblem(null, { access: ok })).toMatch(/could not find/);
  });
  it('quotes paths with spaces and quotes for the shell', () => {
    expect(mac.shellQuote('/Users/Jo Smith/Oro.app')).toBe("'/Users/Jo Smith/Oro.app'");
    expect(mac.shellQuote("/Users/O'Neil/Oro.app")).toBe("'/Users/O'\\''Neil/Oro.app'");
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${mac.shellQuote("a b'c $(x) `y`")}`], { encoding: 'utf8' })).toBe("a b'c $(x) `y`");
    expect(() => mac.swapScript({ pid: 0, appPath: '/a', stagedApp: '/b', backupPath: '/c', logFile: '/d' })).toThrow();
  });

  // The script uses macOS tools (xattr, open); stubs stand in for them so the
  // swap and restore logic runs here. The real tools are only exercised on a Mac.
  function runSwap({ relaunch = true, openFails = false, quarantine = false } = {}) {
    const root = directory("oro swap '");
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const calls = path.join(root, 'calls.txt');
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "open $1" >> ${mac.shellQuote(calls)}\n${openFails ? 'exit 1' : 'exit 0'}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'xattr'), `#!/bin/sh\necho "xattr $*" >> ${mac.shellQuote(calls)}\n${quarantine ? 'case "$1" in -lr) echo "x: com.apple.quarantine: 0081";; esac\n' : ''}exit 0\n`, { mode: 0o755 });
    const app = path.join(root, 'My Apps', 'Oro.app'), staged = path.join(root, 'staging dir', 'Oro.app');
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(app, 'Contents', 'v'), 'old');
    fs.mkdirSync(path.join(staged, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(staged, 'Contents', 'v'), 'new');
    const finished = spawnSync('/bin/sh', ['-c', 'echo $$']); const pid = Number(String(finished.stdout).trim());
    const logFile = path.join(root, 'update log.txt');
    const script = path.join(root, 'install.sh');
    fs.writeFileSync(script, mac.swapScript({ pid, appPath: app, stagedApp: staged, backupPath: path.join(root, 'My Apps', 'Oro (previous version).app'), logFile, relaunch }));
    const result = spawnSync('/bin/sh', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    return { result, app, staged, root, log: fs.readFileSync(logFile, 'utf8'), calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
  }
  it('generated script swaps the bundle, clears quarantine only if present and relaunches', () => {
    const run = runSwap({ quarantine: true });
    expect(run.result.status).toBe(0);
    expect(fs.readFileSync(path.join(run.app, 'Contents', 'v'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(run.root, 'My Apps', 'Oro (previous version).app'))).toBe(false);
    expect(run.calls).toContain('xattr -dr com.apple.quarantine'); expect(run.calls).toContain(`open ${run.app}`);
    expect(run.log).toContain('update installed');
    const quiet = runSwap({ relaunch: false });
    expect(quiet.result.status).toBe(0); expect(quiet.calls).not.toContain('-dr'); expect(quiet.calls).not.toContain('open');
  });
  it('generated script restores the previous app when a step fails', () => {
    const run = runSwap({ openFails: true });
    expect(run.result.status).toBe(1);
    expect(fs.readFileSync(path.join(run.app, 'Contents', 'v'), 'utf8')).toBe('old');
    expect(run.log).toContain('restoring the previous version');
  });
});

describe('Mac automatic update: download, verify and stage', () => {
  function setup({ zipBody = 'zip bytes', yml, tag = 'v2.12.0', plistVersion = '2.12.0', arch = 'arm64', access } = {}) {
    const root = directory();
    const userData = path.join(root, 'user data'); fs.mkdirSync(userData);
    const manifest = yml ?? yaml.dump({ version: '2.12.0', files: [{ url: 'Oro-mac-arm64.zip', sha512: sha('zip bytes'), size: 9 }, { url: 'Oro-mac-x64.zip', sha512: sha('intel'), size: 5 }] });
    const https = fakeHttps({
      [BASE + 'latest-mac.yml']: { status: 302, location: 'https://objects.githubusercontent.com/latest-mac.yml' },
      'https://objects.githubusercontent.com/latest-mac.yml': { body: manifest },
      [BASE + 'Oro-mac-arm64.zip']: { status: 302, location: 'https://objects.githubusercontent.com/arm.zip' },
      'https://objects.githubusercontent.com/arm.zip': { body: zipBody },
    });
    const execFile = vi.fn((file, args, _options, done) => {
      const staging = args[3]; fs.mkdirSync(path.join(staging, 'Oro.app', 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'Oro.app', 'Contents', 'Info.plist'), plist(plistVersion)); done(null);
    });
    const child = { unref: vi.fn() }, spawn = vi.fn(() => child);
    const fsx = access ? { ...fs, accessSync: access, constants: fs.constants } : { ...fs, accessSync: () => {}, constants: fs.constants };
    const installer = mac.createMacInstaller({ fs: fsx, https, execFile, spawn, tmpdir: root, userData, exePath: '/Applications/Oro.app/Contents/MacOS/Oro', arch, pid: 4242, currentVersion: '2.10.0', newerVersion });
    const release = { tag_name: tag, assets: ['latest-mac.yml', 'Oro-mac-arm64.zip', 'Oro-mac-x64.zip'].map(name => ({ name, browser_download_url: BASE + name })) };
    return { installer, release, execFile, spawn, child, userData, https };
  }
  it('follows redirects, verifies, unpacks with ditto and stages the matching version', async () => {
    const { installer, release, execFile, spawn, child, userData } = setup();
    const progress = vi.fn();
    await expect(installer.prepare(release, { onProgress: progress })).resolves.toEqual({ version: '2.12.0' });
    expect(execFile.mock.calls[0][0]).toBe('/usr/bin/ditto'); expect(execFile.mock.calls[0][1].slice(0, 2)).toEqual(['-x', '-k']);
    expect(progress).toHaveBeenCalled(); expect(installer.staged()).toEqual({ version: '2.12.0' });
    expect(installer.launch({ relaunch: true })).toBe(true); expect(installer.launch()).toBe(false);
    expect(spawn).toHaveBeenCalledWith('/bin/sh', [path.join(userData, 'mac-update', 'install-update.sh')], { detached: true, stdio: 'ignore' }); expect(child.unref).toHaveBeenCalled();
    const script = fs.readFileSync(path.join(userData, 'mac-update', 'install-update.sh'), 'utf8');
    expect(script).toContain('PID=4242'); expect(script).toContain("APP='/Applications/Oro.app'"); expect(script).toContain('RELAUNCH=1');
    expect(fs.readFileSync(path.join(userData, 'mac-update.log'), 'utf8')).toContain('checksum verified');
  });
  it('refuses a checksum mismatch, a wrong bundle version, an older release or a mismatched tag', async () => {
    await expect(setup({ zipBody: 'tampered!' }).installer.prepare(setup().release)).rejects.toThrow('checksum');
    const wrong = setup({ plistVersion: '2.11.0' }); await expect(wrong.installer.prepare(wrong.release)).rejects.toThrow('unexpected version');
    const old = setup({ yml: yaml.dump({ version: '2.9.0', files: [] }), tag: 'v2.9.0' }); await expect(old.installer.prepare(old.release)).rejects.toThrow('not newer');
    const tag = setup({ tag: 'v2.13.0' }); await expect(tag.installer.prepare(tag.release)).rejects.toThrow('disagree');
    for (const s of [wrong, old, tag]) { expect(s.installer.staged()).toBe(null); expect(s.installer.launch()).toBe(false); expect(s.spawn).not.toHaveBeenCalled(); }
  });
  it('downloads nothing from a location it cannot replace', async () => {
    const blocked = setup({ access: () => { throw new Error('EROFS'); } });
    await expect(blocked.installer.prepare(blocked.release)).rejects.toThrow('cannot write');
    expect(blocked.https.get).not.toHaveBeenCalled();
  });
});

describe('Mac automatic update: controller', () => {
  function setup(prefs = {}) {
    const macInstaller = { prepare: vi.fn(async (_release, { onProgress }) => { onProgress({ percent: 50, transferred: 5, total: 10 }); return { version: '2.12.0' }; }), launch: vi.fn(() => true), problem: vi.fn(() => null) };
    const quit = vi.fn(), fetchRelease = vi.fn(async () => ({ tag_name: 'v2.12.0', draft: false, prerelease: false }));
    const controller = createUpdateController({ version: '2.10.0', capability: updateCapability({ platform: 'darwin', packaged: true }), macInstaller, quit, fetchRelease, readPreferences: () => prefs });
    return { controller, macInstaller, quit };
  }
  it('is off by default: release notices only, nothing downloaded or installed', async () => {
    expect(DEFAULT_PREFERENCES.autoInstall).toBe(false);
    const { controller, macInstaller, quit } = setup();
    expect(await controller.check()).toMatchObject({ status: 'available', canDownload: false, canInstall: false });
    expect(controller.installOnQuit()).toBe(false); controller.install({ sessionSaved: true });
    expect(macInstaller.prepare).not.toHaveBeenCalled(); expect(macInstaller.launch).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
    expect(updateCapability({ platform: 'win32', packaged: true, nsisInstalled: true }).macAutoInstall).toBeUndefined();
  });
  it('when opted in, stages after a check and installs on quit without relaunching', async () => {
    const { controller, macInstaller, quit } = setup({ autoInstall: true });
    await controller.check(); await vi.waitFor(() => expect(controller.status().status).toBe('downloaded'));
    expect(controller.status().canInstall).toBe(true); expect(macInstaller.prepare).toHaveBeenCalledOnce();
    expect(controller.installOnQuit()).toBe(true); expect(macInstaller.launch).toHaveBeenCalledWith({ relaunch: false }); expect(quit).not.toHaveBeenCalled();
  });
  it('Restart now relaunches only after the saved-session acknowledgement, and surfaces errors', async () => {
    const { controller, macInstaller, quit } = setup({ autoInstall: true });
    await controller.check(); await vi.waitFor(() => expect(controller.status().status).toBe('downloaded'));
    expect(controller.install({}).status).toBe('error'); expect(quit).not.toHaveBeenCalled();
    macInstaller.launch.mockImplementationOnce(() => { throw new Error('Move Oro to your Applications folder'); });
    expect(controller.install({ sessionSaved: true })).toMatchObject({ status: 'error', error: 'Move Oro to your Applications folder' });
    expect(controller.install({ sessionSaved: true }).status).toBe('installing'); expect(macInstaller.launch).toHaveBeenLastCalledWith({ relaunch: true }); expect(quit).toHaveBeenCalledOnce();
    expect(controller.installOnQuit()).toBe(false);
  });
  it('reports a failed verification and the install location problem', async () => {
    const { controller, macInstaller } = setup({ autoInstall: true });
    macInstaller.problem.mockReturnValue('Move Oro to your Applications folder first.');
    macInstaller.prepare.mockRejectedValueOnce(new Error('The downloaded update does not match the release checksum.'));
    await controller.check(); await vi.waitFor(() => expect(controller.status().status).toBe('error'));
    expect(controller.status()).toMatchObject({ error: expect.stringContaining('checksum'), canInstall: false, installProblem: 'Move Oro to your Applications folder first.' });
  });
});

describe('bounce reminder in the desktop close flow', () => {
  function win() {
    const w = new EventEmitter(); w.isDestroyed = () => false; w.close = vi.fn(); w.webContents = { send: vi.fn() }; return w;
  }
  it('asks only with unbounced changes, never during an update install, and can open Bounce', async () => {
    const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
    let installing = false;
    const guard = createCloseGuard({ dialog, isInstalling: () => installing }), w = win(); guard.attach(w);
    const close = () => { const event = { preventDefault: vi.fn() }; w.emit('close', event); return event; };
    expect(close().preventDefault).not.toHaveBeenCalled();
    guard.setUnbounced(true); installing = true; expect(close().preventDefault).not.toHaveBeenCalled(); installing = false;
    expect(close().preventDefault).toHaveBeenCalled(); await Promise.resolve(); await Promise.resolve();
    expect(w.webContents.send).toHaveBeenCalledWith('orograph:session:open-bounce'); expect(w.close).not.toHaveBeenCalled();
    dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    close(); await Promise.resolve(); await Promise.resolve(); expect(w.close).toHaveBeenCalledOnce();
    expect(close().preventDefault).not.toHaveBeenCalled();
  });
  it('continues a quit after Close', async () => {
    const quit = vi.fn(), guard = createCloseGuard({ dialog: { showMessageBox: async () => ({ response: 1 }) }, quit }), w = win(); guard.attach(w);
    guard.setUnbounced(true); guard.beforeQuit(); w.emit('close', { preventDefault() {} }); await Promise.resolve(); await Promise.resolve();
    expect(quit).toHaveBeenCalledOnce(); expect(w.close).not.toHaveBeenCalled();
  });
});
