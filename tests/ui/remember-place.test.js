// v2.1: the selected track and the camera are remembered between launches.
import { describe, it, expect } from 'vitest';
import { sanitizePrefs, PREF_DEFAULTS } from '../../src/ui/prefs.js';

describe('remembered track and camera', () => {
  it('defaults to nothing remembered', () => {
    expect(PREF_DEFAULTS.lastTrack).toBe('');
    expect(PREF_DEFAULTS.lastCamera).toBe(null);
  });
  it('keeps a valid camera and track id, drops broken ones', () => {
    const cam = { position: [10, 8, 12], target: [1, 0, -2], up: [0, 1, 0], fov: 40, view: 'orbit' };
    const ok = sanitizePrefs({ lastTrack: 't3', lastCamera: cam });
    expect(ok.lastTrack).toBe('t3');
    expect(ok.lastCamera.target).toEqual([1, 0, -2]);
    const bad = sanitizePrefs({ lastTrack: 42, lastCamera: { position: [0, 0, 0], target: [0, 0, 0] } });
    expect(bad.lastTrack).toBe('');
    expect(bad.lastCamera).toBe(null);
  });
});
