import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createUpdatesTab } from '../../src/ui/updates-tab.js';
import { SETTINGS_TABS } from '../../src/ui/settings.js';

let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { dom.restore(); });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function bridge(initial = {}) {
  let state = { currentVersion: '2.0.0', status: 'idle', capability: { kind: 'nsis', supportsCheck: true, supportsInstall: true, reason: 'Installed Windows app' }, preferences: { checkOnLaunch: false, periodicChecks: false, autoDownload: false }, canDownload: false, canInstall: false, error: null, ...initial };
  let listener;
  const off = vi.fn();
  const api = {
    status: vi.fn(async () => state), check: vi.fn(async () => state), download: vi.fn(async () => state), install: vi.fn(async () => ({ ...state, status: 'installing' })),
    setPreferences: vi.fn(async patch => { state = { ...state, preferences: { ...state.preferences, ...patch } }; return state; }),
    onStatus: vi.fn(fn => { listener = fn; return off; }),
  };
  return { api, off, emit(patch) { state = { ...state, ...patch }; listener(state); } };
}
const button = (panel, name) => panel.el.querySelectorAll('button').find(el => el.textContent === name);
const click = el => el.dispatchEvent({ type: 'click' });

describe('desktop Updates settings', () => {
  it('has an Updates tab and opens without checking, downloading or installing', async () => {
    expect(SETTINGS_TABS.some(tab => tab.id === 'updates')).toBe(true);
    const { api } = bridge(), panel = createUpdatesTab({}, { version: '2.0.0', api }); await settle();
    expect(api.status).toHaveBeenCalledOnce();
    for (const action of [api.check, api.download, api.install, api.setPreferences]) expect(action).not.toHaveBeenCalled();
    expect(panel.el.querySelector('[aria-label="Check on launch"]').checked).toBe(false);
    expect(panel.el.querySelector('[aria-label="Check periodically"]').checked).toBe(false);
    expect(panel.el.querySelector('[aria-label="Download updates automatically"]').checked).toBe(false);
    panel.dispose();
  });
  it('shows the fixed download link for browser/offline copies without creating a native request', () => {
    const panel = createUpdatesTab({}, { version: '2.0.0', api: null });
    expect(panel.el.textContent).toContain('downloaded app');
    expect(button(panel, 'Check now').getAttribute('hidden')).toBe('');
    expect(panel.el.querySelector('a').getAttribute('href')).toBe('https://github.com/ChaseHendrick/Oro/releases/latest'); panel.dispose();
  });
  it('uses a manual-release notice for ad hoc Mac and portable/archive builds', async () => {
    const { api } = bridge({ status: 'available', availableVersion: '2.0.1', capability: { kind: 'manual', supportsCheck: true, supportsInstall: false, reason: 'This Mac build is ad hoc signed.' } });
    const panel = createUpdatesTab({}, { api }); await settle();
    expect(panel.el.textContent).toContain('2.0.1 is available'); expect(panel.el.textContent).toContain('ad hoc signed');
    expect(button(panel, 'Download update').hidden).toBe(true); expect(button(panel, 'Restart and install').hidden).toBe(true);
    expect(panel.el.querySelector('[aria-label="Download updates automatically"]').disabled).toBe(true); panel.dispose();
  });
  it('persists only the chosen opt-in preference and exposes manual check/download actions', async () => {
    const { api, emit } = bridge(), panel = createUpdatesTab({}, { api }); await settle();
    const input = panel.el.querySelector('[aria-label="Check periodically"]'); input.checked = true; input.dispatchEvent({ type: 'change' }); await settle();
    expect(api.setPreferences).toHaveBeenCalledWith({ periodicChecks: true }); expect(api.check).not.toHaveBeenCalled();
    click(button(panel, 'Check now')); await settle(); expect(api.check).toHaveBeenCalledOnce();
    emit({ status: 'available', availableVersion: '2.0.1', canDownload: true }); click(button(panel, 'Download update')); await settle(); expect(api.download).toHaveBeenCalledOnce();
    expect(api.install).not.toHaveBeenCalled(); panel.dispose();
  });
  it('shows progress and retryable errors and removes its native status subscription', async () => {
    const { api, emit, off } = bridge(), panel = createUpdatesTab({}, { api }); await settle();
    emit({ status: 'downloading', progress: { percent: 42 } }); expect(panel.el.querySelector('progress').hidden).toBe(false); expect(Number(panel.el.querySelector('progress').value)).toBe(42); expect(panel.el.textContent).toContain('42%');
    emit({ status: 'error', error: 'Network offline', progress: null }); expect(panel.el.querySelector('[role="alert"]').textContent).toBe('Network offline'); expect(button(panel, 'Check now').disabled).toBe(false);
    panel.dispose(); expect(off).toHaveBeenCalledOnce(); const oldText = panel.el.textContent; emit({ status: 'current' }); expect(panel.el.textContent).toBe(oldText);
  });
  it('waits for the session/library save and then performs the explicit restart action', async () => {
    const { api } = bridge({ status: 'downloaded', availableVersion: '2.0.1', canInstall: true }); let resolve;
    const prepareUpdate = vi.fn(() => new Promise(done => { resolve = done; })), panel = createUpdatesTab({ prepareUpdate }, { api }); await settle();
    click(button(panel, 'Restart and install')); expect(prepareUpdate).toHaveBeenCalledOnce(); expect(api.install).not.toHaveBeenCalled(); expect(button(panel, 'Restart and install').disabled).toBe(true);
    resolve(true); await settle(); expect(api.install).toHaveBeenCalledOnce(); panel.dispose();
  });
  it('keeps the downloaded update and never restarts after a failed save', async () => {
    const { api } = bridge({ status: 'downloaded', canInstall: true }), panel = createUpdatesTab({ prepareUpdate: async () => false }, { api }); await settle();
    click(button(panel, 'Restart and install')); await settle(); expect(api.install).not.toHaveBeenCalled(); expect(panel.el.querySelector('[role="alert"]').textContent).toContain('could not be saved'); expect(button(panel, 'Restart and install').disabled).toBe(false); panel.dispose();
  });
});
