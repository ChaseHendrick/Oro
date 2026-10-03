import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PALETTES, PALETTE_INFO } from '../../src/visual/palettes.js';
import { createCameraRig, VIEW_NAMES } from '../../src/visual/camera-rig.js';
import { sanitizeSavedCameraViews, sanitizeCameraView } from '../../src/visual/camera-view.js';
import { sanitizePrefs, savePrefs, loadPrefs } from '../../src/ui/prefs.js';
import { computeOrbit } from '../../src/visual/orbit-layer.js';
import { LiveParams, voiceLive, orbitDifference } from '../../src/visual/modstate.js';
import { defaultPart } from '../../src/core/params.js';

describe('expanded display', () => {
  it('offers 24 distinct ramps while preserving the first five ids', () => {
    expect(PALETTES).toHaveLength(24);
    expect(PALETTE_INFO.slice(0, 5).map(p => p.name)).toEqual(['Nocturne', 'Aurora', 'Ember', 'Glacier', 'Mono']);
    expect(new Set(PALETTE_INFO.map(p => p.dark.join(','))).size).toBe(24);
    for (const p of PALETTES) for (const ramp of [p.dark, p.light]) {
      expect(ramp).toHaveLength(6);
      expect(ramp.flat().every(x => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
    }
  });
  it('preserves three original views and offers six distinct camera presets', () => {
    expect(VIEW_NAMES.slice(0, 3)).toEqual(['orbit', 'top', 'low']); expect(VIEW_NAMES).toHaveLength(6);
    const camera = new THREE.PerspectiveCamera(38, 1.6); camera.position.set(12, 15, 12);
    const controls = { target: new THREE.Vector3(), addEventListener() {}, update() {} };
    const rig = createCameraRig(camera, controls), positions = [];
    for (const v of VIEW_NAMES) { rig.setView(v, false); positions.push(camera.position.toArray().map(x => x.toFixed(4)).join(',')); }
    expect(new Set(positions).size).toBe(6);
  });
  it('round-trips a named camera including position, target, up and field of view through preferences', () => {
    const camera = new THREE.PerspectiveCamera(42, 1.5); camera.position.set(9, 13, 17); camera.up.set(0, 1, 0);
    const controls = { target: new THREE.Vector3(2, 0.3, -1), addEventListener() {}, update() {} };
    const rig = createCameraRig(camera, controls), saved = { id: 'mine', name: 'My angle', ...rig.capture() };
    const storage = { value: '', setItem(k, v) { this.value = v; }, getItem() { return this.value; } };
    savePrefs({ savedCameraViews: [saved], view: 'side', renderStyle: 'normals', palette: 23 }, storage);
    const loaded = loadPrefs(storage); expect(loaded.savedCameraViews[0]).toEqual(saved); expect(loaded.view).toBe('side'); expect(loaded.renderStyle).toBe('normals');
    camera.position.set(0, 4, 10); controls.target.set(0, 0, 0); camera.fov = 38;
    expect(rig.restore(loaded.savedCameraViews[0])).toBe(true);
    expect(rig.capture()).toEqual({ position: saved.position, target: saved.target, up: saved.up, fov: saved.fov, view: saved.view });
    expect(sanitizeCameraView({ ...saved, position: [NaN, 0, 0] })).toBeNull();
    expect(sanitizeSavedCameraViews([saved, saved])).toHaveLength(1);
    expect(sanitizePrefs({ view: 'invalid', palette: 24 }).view).toBe('orbit');
  });
  it('shows the same Window/Mangle/Mirror coordinates as the shared path helper and retains voice shaping', () => {
    const p = defaultPart(0), live = new LiveParams();
    p.params.pathWindow = 1; p.params.pathMangle = 0.6; p.params.pathMirror = 3;
    live.setTargets(p.params, p.mods, null, []);
    const voice = voiceLive(live.cur, 60, 60, [], 0, {});
    expect(voice.pathWindow).toBe(1); expect(voice.pathMangle).toBe(0.6); expect(voice.pathMirror).toBe(3);
    const positions = new Float32Array(24), uv = new Float32Array(16), hf = { y: () => 0 };
    computeOrbit(hf, 0, 1, 0.5, { ...voice, centerX: 0.5, centerY: 0.5 }, 0, 8, positions, uv, {}, {});
    expect(uv[0]).toBeCloseTo(0.5); expect(uv[1]).toBeCloseTo(0.5);
    expect(orbitDifference(voice, { ...voice, pathWindow: 0 })).toBeGreaterThan(1);
  });
});
