// Orograph 2.0 integration: real browser audio, offline image library, channel
// mapping, saved views, expanded sound/modulation, favorites and large saves.
// PLAYWRIGHT_MODULE may point to a machine-local install. A separate runtime
// wrapper can adapt the historical Linux path without changing this test.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[2] || 'http://127.0.0.1:5190/';
const shots = process.env.SHOTS || process.argv[3] || '/tmp/orograph-shots/expansion';
fs.mkdirSync(shots, { recursive: true });
const args = ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const report = {};
function pass(label, result) { console.log('PASS ' + label + (result ? ' ' + JSON.stringify(result) : '')); }
function init() {
  if (!localStorage.getItem('orograph.settings')) localStorage.setItem('orograph.settings', JSON.stringify({ quality: 'low', autoRotate: 0, showTips: 0 }));
  // An isolated fake port exercises the actual Program Change handler.
  const input = { id: 'expansion-input', name: 'Expansion MIDI fixture', manufacturer: 'Test fixture', type: 'input', state: 'connected', connection: 'open', onmidimessage: null };
  const access = { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
  window.__expansionMidi = input;
  const Real = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    if (protocols === 'vite-hmr') return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {}, url: String(url), protocol: 'vite-hmr' });
    return new Real(url, protocols);
  };
}
async function boot(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.orograph?.store && window.orograph?.ui, null, { timeout: 90000 });
  const start = page.getByRole('button', { name: /^Start/ }).first();
  if (await start.isVisible().catch(() => false)) await start.click();
  await page.waitForSelector('.start-card', { state: 'hidden', timeout: 90000 });
  await page.evaluate(() => window.orograph.visuals?.debug.pause());
}

(async () => {
  const browser = await chromium.launch({ args });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(init);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await boot(page, target);
    const offline = target.startsWith('file:');
    await page.evaluate(() => { const o = window.orograph; o.store.set('ui.selectedPart', 0); o.store.set('ui.quality', 'low'); o.visuals?.setAutoRotate(false); });

    // Exercise the real picker and generate a source image rather than injecting an id.
    await page.getByRole('button', { name: 'Browse original image library for terrain A', exact: true }).click();
    assert.match(await page.getByRole('dialog', { name: 'Original terrain image library' }).innerText(), /320 original procedural images/);
    await page.getByRole('searchbox', { name: 'Search terrain library' }).fill('Prisms 13');
    await page.waitForFunction(() => document.querySelector('.picker-grid img')?.src.startsWith('data:image/png;base64,'));
    await page.getByRole('button', { name: /^Prisms 13:/ }).click();
    await page.waitForFunction(() => window.orograph.store.get('parts.0.userTerrain.A')?.libraryId === 'original-prisms-013', null, { timeout: 30000 });
    const imported = await page.evaluate(async () => { const o = window.orograph; await o.engine.whenTerrainsReady(); const t = o.store.get('parts.0.userTerrain.A'); return { width: t.w, height: t.h, channels: Object.keys(t.channels), terrainSize: o.engine.getTerrain(0, 'A').size }; });
    assert.deepEqual(imported, { width: 512, height: 512, channels: ['r', 'g', 'b', 'luma'], terrainSize: 512 });
    pass('offline-capable 320-image picker imports real 512 RGBA relief', imported);
    const channel = page.getByRole('slider', { name: 'Image channel', exact: true }).first();
    await channel.focus(); await channel.press('ArrowRight');
    assert((await page.evaluate(() => window.orograph.store.get('parts.0.params.imageChannelA'))) > 0);
    const timing = await page.evaluate(async () => {
      const o = window.orograph, t0 = performance.now();
      o.store.set('parts.0.params.imageChannelA', 1.5); o.store.set('parts.0.params.imageMappingA', 1);
      await o.engine.whenTerrainsReady();
      return { morphAndPolarMs: performance.now() - t0, channel: o.store.get('parts.0.params.imageChannelA'), mapping: o.store.get('parts.0.params.imageMappingA') };
    });
    report.imageTiming = timing; pass('live channel morph and polar regeneration', timing);
    assert.equal(timing.mapping, 1);
    await page.getByRole('button', { name: 'Choose path shape', exact: true }).click();
    const paths = page.getByRole('listbox', { name: 'Path shape', exact: true });
    assert.equal(await paths.getByRole('option').count(), 20);
    await paths.getByRole('option', { name: 'Raster', exact: true }).click();
    assert.equal(await page.evaluate(() => window.orograph.store.get('parts.0.params.pathShape')), 14);
    for (const label of ['Window', 'Mangle', 'Mirror']) assert(await page.getByRole('slider', { name: label, exact: true }).count() > 0);
    pass('twenty paths and Window/Mangle/Mirror controls are available');

    // Saved views are captured/restored through the public UI and survive reload.
    await page.evaluate(() => window.orograph.visuals.setView('side', false));
    const camera = await page.evaluate(() => window.orograph.visuals.captureCameraView());
    await page.getByRole('button', { name: 'Camera views and saved views', exact: true }).click();
    const cameraDialog = page.getByRole('dialog', { name: 'Camera views', exact: true });
    for (const name of ['Orbit', 'Top', 'Low', 'Front', 'Side', 'Diagonal']) assert.equal(await cameraDialog.getByRole('button', { name, exact: true }).count(), 1);
    await page.getByRole('textbox', { name: 'Saved camera view name' }).fill('Expansion angle');
    await page.getByRole('button', { name: 'Save current view', exact: true }).click();
    await page.evaluate(() => window.orograph.visuals.setView('top', false));
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    const cameraRestored = await page.evaluate(() => window.orograph.visuals.captureCameraView());
    for (const key of ['position', 'target', 'up']) assert(cameraRestored[key].every((v, i) => Math.abs(v - camera[key][i]) < 1e-9));
    assert.equal(cameraRestored.fov, camera.fov); assert.equal(cameraRestored.view, camera.view);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.orograph.ui.openSettings('general'));
    assert.equal(await page.locator('.palette-swatch').count(), 24);
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('radio', { name: 'Normals', exact: true }).click();
    assert.equal(await page.evaluate(() => window.orograph.store.get('ui.renderStyle')), 'normals');
    await page.getByRole('tab', { name: 'Updates', exact: true }).click();
    const updates = page.getByRole('tabpanel', { name: 'Updates', exact: true });
    assert.match(await updates.innerText(), /Desktop updates are available in the downloaded app/);
    const releases = updates.getByRole('link', { name: 'Download latest release', exact: true });
    assert.equal(await releases.getAttribute('href'), 'https://github.com/ChaseHendrick/synth/releases/latest');
    assert.equal(await updates.getByRole('button', { name: 'Check now', exact: true }).count(), 0);
    assert.equal(await updates.getByRole('button', { name: 'Restart and install', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    pass('six views, 24 palettes, true Normals, exact camera restore and browser Updates fallback');

    // Keyboard vector interaction and the real instrument effect selectors.
    await page.evaluate(() => window.orograph.store.set('ui.panel', 'mix'));
    const vector = page.getByRole('group', { name: /^Vector mixing pad/ });
    await vector.focus(); const xBefore = await page.evaluate(() => window.orograph.store.get('global.vectorX'));
    await vector.press('ArrowRight');
    assert((await page.evaluate(() => window.orograph.store.get('global.vectorX'))) > xBefore);
    const bankShrink = await page.evaluate(() => {
      const store = window.orograph.store, original = structuredClone(store.get('parts'));
      const parts = Array.from({ length: 16 }, (_, i) => ({ ...structuredClone(original[i % original.length]), id: 'vector-fixture-' + (i + 1), name: 'Vector fixture ' + (i + 1), userTerrain: { A: null, B: null } }));
      store.batch(() => { store.set('parts', parts); store.set('global.vectorBank', 3); });
      const last = Array.from(document.querySelectorAll('.vector-corner'), el => el.textContent);
      store.set('parts', parts.slice(0, 4));
      const result = { bank: store.get('global.vectorBank'), last, first: Array.from(document.querySelectorAll('.vector-corner'), el => el.textContent), uiBank: document.querySelector('[aria-label="Vector track bank"]').value };
      store.set('parts', original);
      return result;
    });
    assert.deepEqual(bankShrink.last, ['Vector fixture 13', 'Vector fixture 14', 'Vector fixture 15', 'Vector fixture 16']);
    assert.deepEqual(bankShrink.first, ['Vector fixture 1', 'Vector fixture 2', 'Vector fixture 3', 'Vector fixture 4']);
    assert.equal(bankShrink.bank, 0); assert.equal(bankShrink.uiBank, '0');
    const effects = page.getByRole('combobox', { name: 'Slot A effect', exact: true });
    assert.equal(await effects.count(), 1); await effects.selectOption('compressor');
    assert.equal(await page.evaluate(() => window.orograph.store.get('parts.0.trackFx.slots.0.type')), 'compressor');
    pass('vector keyboard control, bank clamp after 16-to-4 track shrink and per-instrument FX');

    // Rich oscillator output and editable modulation survive a patch export/import.
    const rich = await page.evaluate(async () => {
      const o = window.orograph;
      o.store.batch(() => {
        for (const [id, value] of Object.entries({ terrainA: 18, terrainB: 15, morph: 0.3, sub: 0.2, subWave: 2, sub2: 0.15, sub2Wave: 4, air: 0.15, airType: 2, phaseMod: 0.2, phaseRatio: 2, ringMod: 0.15, ringRatio: 3, inharmAmount: 0.2, pluck: 0.2, pluckDispersion: 0.3, pathWindow: 0.2, pathMangle: 0.2 })) o.store.set('parts.0.params.' + id, value);
        o.store.set('parts.0.mods.size', { ...o.store.get('parts.0.mods.size'), lfoShape: 6, steps: Array.from({ length: 32 }, (_, i) => Math.sin(i)), envOwn: 1, envHold: 0.12, ctrl1Source: 1, ctrl1Depth: 0.2, ctrl2Source: 3, ctrl2Depth: -0.2, ctrl3Source: 4, ctrl3Depth: 0.1, ctrl4Source: 7, ctrl4Depth: 0.15 });
      });
      await o.engine.whenTerrainsReady();
      o.engine.noteOn(0, 60, 0.9); await new Promise(r => setTimeout(r, 250));
      const samples = new Float32Array(o.engine.analyser.fftSize); o.engine.analyser.getFloatTimeDomainData(samples);
      const peak = Math.max(...samples.map(Math.abs)); o.engine.noteOff(0, 60);
      const id = o.presets.savePatch(0, 'Expansion roundtrip', { author: 'Browser fixture', folder: 'Expansion' });
      const saved = o.presets.getPatch(id), blob = o.presets.exportJSON('patch', id);
      await o.presets.importJSON(await blob.text());
      return { peak, finite: samples.every(Number.isFinite), patchId: id, author: saved.author, folder: saved.folder, subWave: saved.params.subWave, sub2Wave: saved.params.sub2Wave, mod: saved.mods.size };
    });
    assert(rich.peak > 0.001 && rich.peak <= 1.01 && rich.finite); assert.equal(rich.mod.steps.length, 32); assert.equal(rich.mod.envOwn, 1); assert.equal(rich.mod.ctrl4Depth, 0.15); assert.equal(rich.subWave, 2); assert.equal(rich.sub2Wave, 4); assert.equal(rich.author, 'Browser fixture'); assert.equal(rich.folder, 'Expansion');
    report.richPeak = rich.peak; pass('audible finite rich DSP and 32-step/controller/envelope patch roundtrip', { peak: rich.peak });
    await page.evaluate(async id => {
      const o = window.orograph; o.presets.setFavorite(7, id); await o.midi.connect(); o.midi.setSetting('programChange', true);
      o.presets.initPatch(0); window.__expansionMidi.onmidimessage({ data: new Uint8Array([0xc0, 7]), timeStamp: performance.now() });
    }, rich.patchId);
    assert.equal(await page.evaluate(() => window.orograph.store.get('parts.0.patchName')), 'Expansion roundtrip');
    pass('favorite slot is selected through an actual fake-port Program Change');

    if (!offline) {
      const persistence = await page.evaluate(async () => {
        const o = window.orograph, { terrainLibraryPng } = await import('/src/dsp/terrain-library.js'), { readTerrainFile, addUserTerrain } = await import('/src/audio/importers.js');
        const ids = ['original-strata-005', 'original-rings-021', 'original-woven-009'];
        for (let i = 0; i < ids.length; i++) { const ut = await readTerrainFile(new File([terrainLibraryPng(ids[i])], ids[i] + '.png', { type: 'image/png' })); await addUserTerrain(o.store, Math.floor(i / 2), i % 2 ? 'B' : 'A', { ...ut, libraryId: ids[i] }); }
        const { encodeWav24 } = await import('/src/audio/wav.js');
        const wave = Float32Array.from({ length: 12000 }, (_, i) => Math.sin(i * 0.027) * 0.5);
        await o.engine.importNoiseFile(0, new File([encodeWav24([wave], 48000)], 'custom-noise.wav', { type: 'audio/wav' }));
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(k, v) { if (k === 'orograph.session.v1' && String(v).length > 1000) throw new DOMException('Forced test quota', 'QuotaExceededError'); return original.call(this, k, v); };
        const { writeDurable, readDurable } = await import('/src/core/durable-storage.js');
        const raw = JSON.stringify(o.store.serialize()), result = writeDurable('orograph.session.v1', raw, localStorage);
        if (!await result.done) throw new Error('IndexedDB save failed');
        const read = await readDurable('orograph.session.v1', localStorage);
        return { bytes: raw.length, immediate: result.immediate, stored: read === raw, ids, noiseBytes: o.store.get('parts.0.noiseRecording').data.length };
      });
      assert(persistence.bytes > 8e6 && !persistence.immediate && persistence.stored);
      report.persistence = persistence; pass('three complete RGBA images plus custom noise survive forced-quota IndexedDB save', persistence);
      await boot(page, target);
      const restored = await page.evaluate(() => ({ ids: [window.orograph.store.get('parts.0.userTerrain.A').libraryId, window.orograph.store.get('parts.0.userTerrain.B').libraryId, window.orograph.store.get('parts.1.userTerrain.A').libraryId], noise: window.orograph.store.get('parts.0.noiseRecording').data.length, cameras: JSON.parse(localStorage.getItem('orograph.settings')).savedCameraViews.map(v => v.name) }));
      assert.deepEqual(restored.ids, persistence.ids); assert.equal(restored.noise, persistence.noiseBytes); assert(restored.cameras.includes('Expansion angle'));
      pass('large session and named camera persist through browser reload');
    }
    await page.evaluate(() => { const o = window.orograph; o.store.set('ui.panel', 'sound'); o.store.set('ui.renderStyle', 'relief'); o.visuals?.setView('orbit', false); o.visuals?.debug.advance(0.2); });
    await page.screenshot({ path: path.join(shots, offline ? 'offline-desktop.png' : 'desktop.png'), timeout: 90000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      window.orograph.visuals?.resize();
      window.orograph.visuals?.debug.advance(0.2);
    });
    await page.screenshot({ path: path.join(shots, offline ? 'offline-phone.png' : 'phone.png'), timeout: 90000 });
    report.mobile = await page.evaluate(() => {
      const a = document.querySelector('.vp-toolbar--left')?.getBoundingClientRect(), b = document.querySelector('.vp-toolbar--right')?.getBoundingClientRect();
      return { documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, toolbarOverlap: !!(a && b && a.right > b.left && a.top < b.bottom && b.top < a.bottom) };
    });
    assert.equal(report.mobile.documentWidth, report.mobile.viewportWidth, 'phone has no horizontal overflow');
    assert.equal(report.mobile.toolbarOverlap, false, 'phone camera and dot toolbars do not overlap');
    await page.evaluate(() => window.orograph.ui.openSettings('updates'));
    const mobileUpdates = page.getByRole('tabpanel', { name: 'Updates', exact: true });
    assert(await mobileUpdates.getByRole('link', { name: 'Download latest release', exact: true }).isVisible());
    const settingsPhone = await page.getByRole('dialog', { name: 'Settings', exact: true }).evaluate(el => {
      const nav = el.querySelector('.settings-tabs'), content = el.querySelector('.settings-content');
      const r = el.getBoundingClientRect(), c = content.getBoundingClientRect();
      return { tabs: nav.querySelectorAll('[role="tab"]').length, dialogLeft: r.left, dialogRight: r.right, contentWidth: c.width, contentOverflow: content.scrollWidth > content.clientWidth };
    });
    assert.equal(settingsPhone.tabs, 8); assert(settingsPhone.dialogLeft >= 0 && settingsPhone.dialogRight <= 390); assert.equal(settingsPhone.contentOverflow, false);
    report.mobileUpdates = settingsPhone;
    await page.screenshot({ path: path.join(shots, offline ? 'offline-phone-updates.png' : 'phone-updates.png'), timeout: 90000 });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(async () => {
      const o = window.orograph;
      o.store.batch(() => {
        for (const [id, value] of Object.entries({ terrainA: 0, terrainB: 3, morph: 0.3, detail: 0.35, warp: 0.1, fold: 0, lift: 1, pathShape: 2, pathOrder: 4, pathParam: 0.55, pathWindow: 0.1, pathMangle: 0.1, size: 0.18 })) o.store.set('parts.0.params.' + id, value);
        o.store.set('ui.palette', 1); o.store.set('ui.panel', 'mix');
      });
      await o.engine.whenTerrainsReady();
      await new Promise(resolve => requestAnimationFrame(resolve));
      o.visuals?.resize(); o.visuals?.debug.advance(0.5);
    });
    await page.screenshot({ path: path.join(shots, offline ? 'offline-features.png' : 'features.png'), timeout: 90000 });
    await page.getByRole('button', { name: 'Browse original image library for terrain A', exact: true }).click();
    await page.waitForFunction(() => { const images = Array.from(document.querySelectorAll('.picker-grid img')); return images.length === 16 && images.every(img => img.src.startsWith('data:image/png;base64,') && img.complete); });
    await page.screenshot({ path: path.join(shots, offline ? 'offline-library.png' : 'library.png'), timeout: 90000 });
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'no browser errors');
    fs.writeFileSync(path.join(shots, offline ? 'offline-report.json' : 'report.json'), JSON.stringify(report, null, 2));
    pass('desktop and phone screenshots, no overflow or console errors', report.mobile);
    await context.close();
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
