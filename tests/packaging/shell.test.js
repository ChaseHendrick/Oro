import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const policy = require('../../electron/policy.cjs');
const { buildMenuTemplate } = require('../../electron/menu.cjs');
const { sanitizeState, fitToDisplays, createWindowStateFile, DEFAULT_SIZE, MIN_SIZE } = require('../../electron/window-state.cjs');

describe('policy', () => {
  it('recognises our own origin only', () => {
    expect(policy.START_URL).toBe('app://orograph/index.html');
    expect(policy.originOf('app://orograph/index.html')).toBe('app://orograph');
    expect(policy.originOf('app://orograph')).toBe('app://orograph');
    expect(policy.isAppUrl('app://orograph/assets/x.js')).toBe(true);
    expect(policy.isAppUrl('app://other/index.html')).toBe(false);
    expect(policy.isAppUrl('file:///etc/passwd')).toBe(false);
    expect(policy.isAppUrl('https://orograph/')).toBe(false);
    expect(policy.isAppUrl('')).toBe(false);
    expect(policy.isAppUrl(undefined)).toBe(false);
  });

  it('grants MIDI to the app origin and nothing else', () => {
    expect(policy.isPermissionAllowed('midi', 'app://orograph')).toBe(true);
    expect(policy.isPermissionAllowed('midi', 'app://orograph/')).toBe(true); // check-handler form
    expect(policy.isPermissionAllowed('midi', 'app://orograph/index.html')).toBe(true);
    expect(policy.isPermissionAllowed('midi', 'https://example.com')).toBe(false);
    expect(policy.isPermissionAllowed('midi', 'file:///tmp/x.html')).toBe(false);
    expect(policy.isPermissionAllowed('midi', '')).toBe(false);
    // Chromium gates every Web MIDI request behind the SysEx permission.
    expect(policy.isPermissionAllowed('midiSysex', 'app://orograph/')).toBe(true);
    expect(policy.isPermissionAllowed('midiSysex', 'https://example.com')).toBe(false);
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'hid', 'serial', 'usb', 'display-capture', 'unknown']) {
      expect(policy.isPermissionAllowed(p, 'app://orograph')).toBe(false);
    }
  });

  it('lets the page list audio outputs but never record from the microphone', () => {
    // Check handler: output device names and setSinkId work.
    expect(policy.isPermissionCheckAllowed('speaker-selection', 'app://orograph/', {})).toBe(true);
    expect(policy.isPermissionCheckAllowed('media', 'app://orograph/', { mediaType: 'audio' })).toBe(true);
    expect(policy.isPermissionCheckAllowed('media', 'app://orograph/', { mediaType: 'video' })).toBe(false);
    expect(policy.isPermissionCheckAllowed('media', 'app://orograph/', {})).toBe(false);
    expect(policy.isPermissionCheckAllowed('speaker-selection', 'https://example.com', {})).toBe(false);
    expect(policy.isPermissionCheckAllowed('midi', 'app://orograph/', {})).toBe(true);
    expect(policy.isPermissionCheckAllowed('geolocation', 'app://orograph/', {})).toBe(false);
    // Request handler (actual capture / prompts): still refused.
    expect(policy.isPermissionAllowed('media', 'app://orograph/index.html')).toBe(false);
    expect(policy.isPermissionAllowed('speaker-selection', 'app://orograph/index.html')).toBe(false);
  });

  it('allows audio-only capture for the app origin (v1.1 pedal return), never video', () => {
    expect(policy.isPermissionAllowed('media', 'app://orograph/index.html', { mediaTypes: ['audio'] })).toBe(true);
    expect(policy.isPermissionAllowed('media', 'app://orograph/index.html', { mediaTypes: ['video'] })).toBe(false);
    expect(policy.isPermissionAllowed('media', 'app://orograph/index.html', { mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(policy.isPermissionAllowed('media', 'app://orograph/index.html', { mediaTypes: [] })).toBe(false);
    expect(policy.isPermissionAllowed('media', 'app://orograph/index.html', {})).toBe(false);
    expect(policy.isPermissionAllowed('media', 'https://example.com', { mediaTypes: ['audio'] })).toBe(false);
    expect(policy.isPermissionAllowed('display-capture', 'app://orograph/', { mediaTypes: ['audio'] })).toBe(false);
    expect(policy.isAudioOnlyRequest({ mediaTypes: ['audio'] })).toBe(true);
    expect(policy.isAudioOnlyRequest(null)).toBe(false);
  });

  it('asks macOS for the microphone with a usage description', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const text = pkg.build.mac.extendInfo && pkg.build.mac.extendInfo.NSMicrophoneUsageDescription;
    expect(typeof text).toBe('string');
    expect(text).toMatch(/pedal/);
    expect(text).not.toMatch(/\u2014/);
  });

  it('sends web links to the browser and blocks dangerous schemes', () => {
    expect(policy.navigationAction('app://orograph/index.html')).toBe('allow');
    expect(policy.navigationAction('https://github.com/ChaseHendrick/synth')).toBe('external');
    expect(policy.navigationAction('http://example.com/x')).toBe('external');
    expect(policy.navigationAction('mailto:someone@example.com')).toBe('external');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'smb://host/share', 'app://evil/', 'mailto:', 'http://', 'garbage']) {
      expect(policy.navigationAction(url)).toBe('deny');
    }
  });
});

describe('menu', () => {
  const opened = [];
  const build = (o) => buildMenuTemplate({ appName: 'Orograph', openExternal: (u) => opened.push(u), ...o });
  const roles = (menu) => JSON.stringify(menu, (k, v) => (typeof v === 'function' ? undefined : v));

  it('has the expected top-level menus', () => {
    expect(build({ isMac: false, isPackaged: true }).map((m) => m.label || m.role)).toEqual(['File', 'Edit', 'View', 'Window', 'help']);
    expect(build({ isMac: true, isPackaged: true }).map((m) => m.label || m.role)).toEqual(['Orograph', 'File', 'Edit', 'View', 'Window', 'help']);
  });

  it('puts Quit in File on Windows/Linux and in the app menu on macOS', () => {
    expect(build({ isMac: false, isPackaged: true })[0].submenu).toEqual([{ role: 'quit' }]);
    const mac = build({ isMac: true, isPackaged: true });
    expect(mac[0].submenu.some((i) => i.role === 'quit')).toBe(true);
    expect(mac[1].submenu.some((i) => i.role === 'quit')).toBe(false);
  });

  it('only offers DevTools in development builds', () => {
    expect(roles(build({ isMac: false, isPackaged: true }))).not.toContain('toggleDevTools');
    expect(roles(build({ isMac: false, isPackaged: false }))).toContain('toggleDevTools');
    const view = build({ isMac: true, isPackaged: true }).find((m) => m.label === 'View');
    expect(view.submenu.map((i) => i.role).filter(Boolean)).toEqual(expect.arrayContaining(['reload', 'togglefullscreen']));
  });

  it('links Help to the GitHub repository', () => {
    const help = build({ isMac: false, isPackaged: true }).find((m) => m.role === 'help');
    for (const item of help.submenu) if (item.click) item.click();
    expect(opened).toContain('https://github.com/ChaseHendrick/synth');
    expect(opened).toContain('https://github.com/ChaseHendrick/synth/releases/latest');
    expect(opened.every((u) => policy.isExternalUrl(u))).toBe(true);
  });
});

describe('window state', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1050 };
  const right = { x: 1920, y: 0, width: 2560, height: 1400 };

  it('defaults to 1440x900, centred', () => {
    expect(sanitizeState(null)).toEqual({ width: 1440, height: 900, maximized: false });
    expect(fitToDisplays(null, [screen])).toEqual({ width: 1440, height: 900, maximized: false });
    expect(DEFAULT_SIZE).toEqual({ width: 1440, height: 900 });
    expect(MIN_SIZE).toEqual({ width: 960, height: 640 });
  });

  it('keeps a saved position that is still on screen', () => {
    expect(fitToDisplays({ x: 2000, y: 100, width: 1600, height: 1000, maximized: true }, [screen, right]))
      .toEqual({ x: 2000, y: 100, width: 1600, height: 1000, maximized: true });
  });

  it('recentres a window whose monitor has gone', () => {
    const r = fitToDisplays({ x: 2000, y: 100, width: 1600, height: 1000 }, [screen]);
    expect(r.x).toBeUndefined();
    expect(r).toMatchObject({ width: 1600, height: 1000 });
  });

  it('shrinks to fit a smaller display and nudges partly off-screen windows back', () => {
    const small = { x: 0, y: 25, width: 1280, height: 775 };
    expect(fitToDisplays({ width: 1440, height: 900 }, [small])).toEqual({ width: 1280, height: 775, maximized: false });
    const r = fitToDisplays({ x: 1000, y: 30, width: 1200, height: 700 }, [small]);
    expect(r).toEqual({ x: 80, y: 30, width: 1200, height: 700, maximized: false });
  });

  it('ignores garbage in the saved file', () => {
    expect(sanitizeState({ width: 'big', height: -3, x: NaN, y: 5, maximized: 'yes' })).toEqual({ width: 1440, height: 900, maximized: false });
  });

  it('round-trips through the JSON file and survives a corrupt one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orograph-ws-'));
    const file = path.join(dir, 'nested', 'window-state.json');
    const store = createWindowStateFile(file);
    expect(store.load()).toEqual({ width: 1440, height: 900, maximized: false });
    expect(store.save({ x: 10, y: 20, width: 1000, height: 700, maximized: true, junk: 1 })).toBe(true);
    expect(store.load()).toEqual({ x: 10, y: 20, width: 1000, height: 700, maximized: true });
    fs.writeFileSync(file, '{not json');
    expect(store.load()).toEqual({ width: 1440, height: 900, maximized: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
