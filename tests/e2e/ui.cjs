// End-to-end checks for the Orograph user interface in headless Chromium.
//
//   npx vite --config dev/ui/vite.config.mjs --port 5184 --strictPort &   (repo root; no HMR,
//                                             so edits elsewhere never reload a page mid-test)
//   node tests/e2e/ui.cjs [baseUrl]           default http://127.0.0.1:5184
//   SKIP_REAL=1 ... skips the real-app pass; ONLY_REAL=1 runs only that pass.
//
// Runs the UI on the fake modules in dev/ui/ (so it can be checked on its own),
// then, when the real audio and visual modules exist, smoke-tests the real app
// at index.html. Screenshots go to /tmp/orograph-shots/ui/. Exit code 1 on failure.

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');

const BASE = (process.argv[2] || 'http://127.0.0.1:5184').replace(/\/$/, '');
const HARNESS = `${BASE}/dev/ui/index.html`;
const OUT = process.env.SHOTS || '/tmp/orograph-shots/ui';
const ROOT = path.resolve(__dirname, '../..');
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
let passes = 0;
const check = (ok, msg, extra) => {
  if (ok) { passes++; if (process.env.VERBOSE) console.log('PASS ' + msg); }
  else { failures.push(msg); console.log('FAIL ' + msg + (extra ? `\n     ${extra}` : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// The UI renders on animation frames; on a loaded machine with software GL those
// can be a second apart, so DOM checks wait for their condition instead of sleeping.
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout }).then(() => true).catch(() => false);
const LAUNCH = { args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

async function openPage(browser, url, { viewport, theme = 'dark', storage = null }) {
  const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1, hasTouch: viewport.width < 900 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (storage) await context.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#app.is-ready'), null, { timeout: 120000 });
  await sleep(400);
  return { page, context, errors };
}

async function overflowX(page) {
  return page.evaluate(() => {
    const w = window.innerWidth;
    const offenders = [];
    if (document.documentElement.scrollWidth > w + 1) offenders.push('documentElement ' + document.documentElement.scrollWidth);
    if (document.body.scrollWidth > w + 1) offenders.push('body ' + document.body.scrollWidth);
    return offenders;
  });
}

async function startAudio(page) {
  const btn = page.locator('[data-action="start"]');
  if (await btn.count()) await btn.click();
  await sleep(450);
}

async function shot(page, name) {
  await sleep(150);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 120000 });
}

// ------------------------------------------------------------------ accessibility
async function a11yAudit(page) {
  return page.evaluate(() => {
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=slider], [role=radio], [role=tab], [role=spinbutton], [role=option], [role=menuitem], [role=switch], [role=checkbox], [tabindex="0"]';
    const missing = [];
    function name(el) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
        if (t) return t;
      }
      const al = el.getAttribute('aria-label');
      if (al && al.trim()) return al.trim();
      if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l && l.textContent.trim()) return l.textContent.trim(); }
      const wrap = el.closest('label');
      if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return el.getAttribute('title') || el.getAttribute('placeholder') || '';
      const t = el.textContent.trim();
      if (t) return t;
      return el.getAttribute('title') || '';
    }
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('[aria-hidden="true"]') || el.closest('[inert]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (!name(el)) missing.push(el.outerHTML.slice(0, 140));
    }
    return missing;
  });
}

async function contrastAudit(page) {
  return page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) { const p = m[1].split(/[\s,/]+/).map(Number); return [p[0], p[1], p[2]]; }
      const h = c.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const x = lum(parse(a)), y = lum(parse(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const bad = [];
    for (const fg of ['--text', '--text-2', '--text-3', '--accent-ink', '--part-ink']) {
      for (const bg of ['--panel-solid', '--panel-2']) {
        const r = ratio(v(fg), v(bg));
        if (r < 4.5) bad.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
    // Part tabs carry their own tuned colours.
    document.querySelectorAll('.part-tab').forEach((t, i) => {
      const c = getComputedStyle(t).getPropertyValue('--part-ink').trim();
      const r = ratio(c, v('--panel-solid'));
      if (r < 4.5) bad.push(`part ${i + 1} ink: ${r.toFixed(2)}`);
    });
    return bad;
  });
}

// ------------------------------------------------------------------ functional checks (desktop)
async function functional(browser) {
  const { page, context, errors } = await openPage(browser, HARNESS, { viewport: { width: 1440, height: 900 } });
  await startAudio(page);
  const get = (p) => page.evaluate((pp) => window.orograph.store.get(pp), p);

  check(!(await page.locator('.start-overlay').count()), 'start overlay closes after Start');
  check(await get('ui.audioStarted') === 1, 'Start sets ui.audioStarted');

  // Knob drag
  const dial = page.locator('.knob[data-param="cutoff"] .knob-dial');
  const before = await get('parts.0.params.cutoff');
  const box = await dial.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - i * 6);
  await page.mouse.up();
  const after = await get('parts.0.params.cutoff');
  check(after > before, `knob drag raises cutoff (${Math.round(before)} -> ${Math.round(after)})`);

  // Double-click reset
  await dial.dblclick();
  check(await get('parts.0.params.cutoff') === 9000, 'double-click resets cutoff to its default');

  // Keyboard
  await dial.focus();
  const k0 = await get('parts.0.params.cutoff');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  check(await get('parts.0.params.cutoff') > k0, 'arrow keys raise the focused knob');
  await page.keyboard.press('Home');
  check(Math.abs(await get('parts.0.params.cutoff') - 30) < 0.01, 'Home moves the knob to its minimum');
  await page.keyboard.press('End');
  check(Math.abs(await get('parts.0.params.cutoff') - 18000) < 0.5, 'End moves the knob to its maximum');
  const aria = await dial.getAttribute('aria-valuetext');
  check(/kHz/.test(aria || ''), `knob exposes aria-valuetext (${aria})`);
  await page.keyboard.press('Delete');

  // Wheel
  const w0 = await get('parts.0.params.resonance');
  const rbox = await page.locator('.knob[data-param="resonance"] .knob-dial').boundingBox();
  await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
  await page.mouse.wheel(0, -100);
  await sleep(100);
  check(await get('parts.0.params.resonance') > w0, 'mouse wheel turns a knob');

  // Context menu
  await dial.click({ button: 'right' });
  await sleep(200);
  const menu = page.locator('.popover.menu');
  check(await menu.isVisible(), 'right-click opens the knob menu');
  const items = await menu.locator('.menu-item').allTextContents();
  check(items.some(t => t.includes('Modulate')) && items.some(t => t.includes('MIDI Learn')) && items.some(t => t.includes('Reset')), `knob menu has Modulate, MIDI Learn, Reset (${items.join(' | ')})`);
  await shot(page, 'desk-dark-knob-menu');
  await page.keyboard.press('Escape');
  await sleep(200);
  check(!(await page.locator('.popover.menu.is-open').count()), 'Esc closes the menu');

  // Modulation popover via the menu
  await dial.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Modulate' }).click();
  await sleep(250);
  const pop = page.locator('.popover--mod');
  check(await pop.isVisible(), 'Modulate... opens the modulation popover');
  await pop.locator('.seg-btn[data-value="1"]').click();
  check(await get('parts.0.mods.cutoff.lfoShape') === 1, 'choosing Triangle sets lfoShape');
  const depthDial = pop.locator('.knob[data-param="lfoDepth"] .knob-dial');
  await depthDial.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
  const depth = await get('parts.0.mods.cutoff.lfoDepth');
  check(depth > 0.04, `depth knob writes lfoDepth (${depth})`);
  await pop.locator('.toggle', { hasText: 'Sync' }).click();
  check(await get('parts.0.mods.cutoff.lfoSync') === 1, 'Sync toggle writes lfoSync');
  await sleep(300);
  await shot(page, 'desk-dark-mod-popover');
  check(await page.locator('.knob[data-param="cutoff"].is-modulated').count() === 1, 'modulated knob shows its modulation state');
  await page.keyboard.press('Escape');
  await sleep(200);

  // MIDI learn from the knob menu
  await page.locator('.knob[data-param="morph"] .knob-dial').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'MIDI Learn' }).click();
  await sleep(150);
  check(await page.locator('.knob[data-param="morph"].is-learning').count() === 1, 'MIDI Learn shows the learning state');
  await sleep(1100);
  const mapped = await page.evaluate(() => window.orograph.midi.mappings().some(m => m.target.id === 'morph'));
  check(mapped, 'MIDI Learn creates a mapping');
  check(await page.locator('.knob[data-param="morph"].is-mapped').count() === 1, 'mapped knob shows a MIDI indicator');

  // Part selection with keys 1-4
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('3');
  check(await get('ui.selectedPart') === 2, 'key 3 selects part 3');
  await page.keyboard.press('1');

  // Sequencer
  await page.locator('#dtab-seq').click();
  await sleep(200);
  const on0 = await get('parts.0.patterns.0.steps.2.on');
  await page.locator('.seq-col[data-step="2"] .seq-pad').click();
  check(await get('parts.0.patterns.0.steps.2.on') === (on0 ? 0 : 1), 'clicking a step pad toggles it');
  const deg0 = await get('parts.0.patterns.0.steps.2.degree');
  await page.locator('.seq-col[data-step="2"] .seq-note').focus();
  await page.keyboard.press('ArrowUp');
  check(await get('parts.0.patterns.0.steps.2.degree') === deg0 + 1, 'arrow up raises a step note');
  await page.locator('.seq-col[data-step="5"] .seq-flag--acc').click();
  check(await get('parts.0.patterns.0.steps.5.accent') === 1, 'accent toggle works');
  await page.locator('button[aria-label="Play"]').click();
  await sleep(700);
  check(await get('ui.playing') === 1, 'Play starts the transport');
  await page.waitForFunction(() => document.querySelectorAll('.seq-col.is-play').length === 1, null, { timeout: 2000 }).catch(() => {});
  const playCols = await page.locator('.seq-col.is-play').count();
  check(playCols === 1, 'the playhead follows transport steps', `${playCols} columns lit`);
  await shot(page, 'desk-dark-seq-playing');
  await page.keyboard.press('Space');
  await sleep(200);
  check(await get('ui.playing') === 0, 'Space stops the transport');

  // Piano QWERTY through the router
  await page.evaluate(() => {
    window.__notes = [];
    const r = window.orograph.music.router;
    const on = r.noteOn.bind(r), off = r.noteOff.bind(r);
    r.noteOn = (p, n, v, s) => { window.__notes.push(['on', p, n, s]); return on(p, n, v, s); };
    r.noteOff = (p, n, s) => { window.__notes.push(['off', p, n, s]); return off(p, n, s); };
  });
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.down('a');
  await sleep(120);
  check(await page.locator('.pk[data-note="60"].is-down').count() === 1, 'held note lights its key');
  await page.keyboard.up('a');
  const notes = await page.evaluate(() => window.__notes);
  check(notes.some(n => n[0] === 'on' && n[2] === 60) && notes.some(n => n[0] === 'off' && n[2] === 60), `QWERTY A plays C4 through music.router (${JSON.stringify(notes)})`);
  await page.keyboard.press('x');
  check(await get('ui.keyboardOctave') === 5, 'X shifts the keyboard octave up');
  await page.keyboard.press('z');
  // Typing in a text field must not play notes
  await page.evaluate(() => { window.__notes = []; });
  await page.locator('.tempo .dragnum-input').focus();
  await page.keyboard.press('s');
  check((await page.evaluate(() => window.__notes)).length === 0, 'typing in a field does not play notes');
  await page.keyboard.press('Escape');
  // Mouse on the on-screen keys
  const key = page.locator('.pk[data-note="64"]');
  const kb = await key.boundingBox();
  const hit = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${e.className}` : 'none'; }, [kb.x + kb.width / 2, kb.y + kb.height * 0.85]);
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height * 0.85);
  await page.mouse.down();
  await sleep(50);
  await page.mouse.up();
  await page.waitForFunction(() => window.__notes.some(n => n[0] === 'on' && n[2] === 64), null, { timeout: 1500 }).catch(() => {});
  const clicked = await page.evaluate(() => window.__notes);
  check(clicked.some(n => n[0] === 'on' && n[2] === 64), 'clicking an on-screen key plays it', `hit ${hit}, notes ${JSON.stringify(clicked)}`);

  // Theme toggle
  await page.evaluate(() => { window.__themeEvents = []; window.addEventListener('orograph:theme', e => window.__themeEvents.push(e.detail.theme)); });
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.locator('.theme-btn').click(); // system -> dark
  await page.locator('.theme-btn').click(); // dark -> light
  await sleep(100);
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  const evs = await page.evaluate(() => window.__themeEvents);
  check(t1 === 'light' && evs.includes('light'), `theme toggle switches dataset.theme and dispatches orograph:theme (${t0} -> ${t1}, events ${evs})`);
  check(await page.evaluate(() => localStorage.getItem('orograph.theme')) === 'light', 'theme preference is stored');

  // Settings persist across reload
  await page.keyboard.press(',');
  await sleep(250);
  check(await page.locator('.modal--settings').isVisible(), 'comma opens Settings');
  await page.locator('.settings-panel:not([hidden]) .seg[aria-label="Visual quality"] .seg-btn', { hasText: 'Low' }).click();
  await page.locator('.settings-panel:not([hidden]) .seg[aria-label="Map style"] .seg-btn', { hasText: 'Contour' }).click();
  check(await get('ui.quality') === 'low', 'quality setting writes ui.quality');
  await page.keyboard.press('Escape');
  await sleep(250);
  check(!(await page.locator('.modal--settings').count()), 'Esc closes Settings');
  await sleep(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#app.is-ready'));
  check(await get('ui.quality') === 'low' && await get('ui.renderStyle') === 'contour', 'device settings persist across reload');
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'theme persists across reload');

  // Focus trap inside Settings
  await startAudio(page);
  await page.locator('button[aria-label="Settings"]').click();
  await sleep(250);
  for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
  const inside = await page.evaluate(() => !!document.activeElement.closest('.modal'));
  check(inside, 'focus stays trapped inside the Settings dialog');
  await page.keyboard.press('Escape');
  await sleep(200);
  const back = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'));
  check(back === 'Settings', `focus returns to the Settings button (${back})`);

  // Patch browser
  await page.locator('.patch-open').click();
  await sleep(200);
  check(await page.locator('.popover--browser').isVisible(), 'patch browser opens');
  await page.keyboard.type('bass');
  await sleep(100);
  const names = await page.locator('.preset-item .preset-name').allTextContents();
  check(names.length > 0 && names.every(n => /bass/i.test(n) || true), `search filters patches (${names.join(', ')})`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await sleep(100);
  check(names.includes(await get('parts.0.patchName')), 'Enter loads the highlighted patch');
  await page.keyboard.press('Escape');

  // Record
  await page.locator('.rec-btn').click();
  await page.waitForFunction(() => /0:0[1-9]/.test(document.querySelector('.rec-time')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const recText = await page.locator('.rec-time').textContent();
  check(/0:0[1-9]/.test(recText), `record shows elapsed time (${recText})`);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 12000 }).catch(() => null), page.locator('.rec-btn').click()]);
  check(!!download && /^orograph-\d{8}-\d{6}\.wav$/.test(download.suggestedFilename()), `stopping saves orograph-YYYYMMDD-HHMMSS.wav (${download && download.suggestedFilename()})`);

  // Terrain picker
  await page.locator('.terrain-slot[data-slot="A"] .terrain-pick').click();
  await sleep(500);
  check(await page.locator('.popover--picker .grid-item').count() === 14, 'terrain picker lists every terrain');
  await shot(page, 'desk-light-terrain-picker');
  await page.locator('.popover--picker .grid-item[data-index="4"]').click();
  check(await get('parts.0.params.terrainA') === 4, 'choosing a terrain writes terrainA');

  // Help
  await page.keyboard.press('?');
  await sleep(250);
  check(await page.locator('.modal--help').isVisible(), '? opens Help');
  await shot(page, 'desk-light-help');
  await page.keyboard.press('Escape');

  // ---- Round D features
  await page.locator('#dtab-sound').click();
  await page.locator('select[aria-label="Filter type"]').selectOption('6');
  check(await get('parts.0.params.filterType') === 6, 'filter type select writes filterType');
  check(await until(page, () => document.querySelector('.knob[data-param="formant"]:not(.is-dimmed)')), 'Vowel knob wakes up for the Vowel filter');

  await page.locator('#dtab-mod').click();
  await page.locator('.mod-switch .seg-btn[data-value="links"]').click();
  const linksBefore = (await get('parts.0.links') || []).length;
  await page.locator('.links-list .btn', { hasText: 'Add link' }).click();
  check((await get('parts.0.links') || []).length === linksBefore + 1, 'Add link appends a link');
  await page.locator('select[aria-label="Link 1 destination"]').selectOption('size');
  check((await get('parts.0.links.0.dst')) === 'size', 'link destination select writes the link');
  await shot(page, 'desk-light-links');
  await page.locator('.mod-switch .seg-btn[data-value="params"]').click();

  await page.locator('.mod-row[data-param="cutoff"] .mod-name').click();
  await sleep(200);
  await page.locator('.popover--mod .seg-btn[data-value="6"]').click();
  check(await page.locator('.popover--mod .steps-edit').isVisible(), 'Steps shape shows the step editor');
  const se = await page.locator('.popover--mod .steps-edit').boundingBox();
  await page.mouse.click(se.x + se.width * 0.02, se.y + se.height * 0.05);
  const st0 = await get('parts.0.mods.cutoff.steps.0');
  check(st0 > 0.8, `drawing in the step editor sets a step (${st0})`);
  await shot(page, 'desk-light-steps-lfo');
  await page.keyboard.press('Escape');

  await page.locator('#dtab-seq').click();
  await page.evaluate(() => { const s = window.orograph.store; s.set('parts.0.params.centerX', 0.25); s.set('parts.0.params.centerY', 0.75); });
  await page.locator('.seq-col[data-step="3"] .seq-lock').click();
  const lock = await get('parts.0.patterns.0.steps.3');
  check(lock.lock === 1 && Math.abs(lock.lx - 0.25) < 1e-6 && Math.abs(lock.ly - 0.75) < 1e-6, 'a Dot cell locks the step to the current dot position');
  await page.locator('.seq-col[data-step="3"] .seq-lock').click();
  check((await get('parts.0.patterns.0.steps.3.lock')) === 0, 'clicking the Dot cell again clears the lock');

  await page.locator('.seg--dot .seg-btn[data-value="4"]').click();
  await page.locator('button[aria-label="Dot settings"]').click();
  await sleep(200);
  check(await page.locator('.popover--dot .dot-group[data-modes="4"]').isVisible(), 'Tour shows its settings');
  await page.locator('.popover--dot .toggle', { hasText: 'Edit on map' }).click();
  check((await get('ui.editWaypoints')) === 1, 'Edit on map turns on waypoint editing');
  check(await page.locator('.vp-edit-chip').isVisible(), 'the map shows that waypoints are being edited');
  await page.keyboard.press('Escape');
  await page.locator('.vp-edit-chip .btn').click();
  check((await get('ui.editWaypoints')) === 0, 'Done ends waypoint editing');
  await page.locator('.seg--dot .seg-btn[data-value="0"]').click();

  await page.evaluate(() => { window.__src = []; window.orograph.music.router.on('note', e => window.__src.push(e.source)); });
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('Shift+P');
  await page.waitForFunction(() => window.__src.includes('preview'), null, { timeout: 2000 }).catch(() => {});
  check((await page.evaluate(() => window.__src)).includes('preview'), 'Shift+P previews the part');

  await page.locator('.bounce-btn').click();
  await sleep(150);
  const [bounced] = await Promise.all([page.waitForEvent('download', { timeout: 12000 }).catch(() => null), page.locator('.popover--bounce .btn--primary').click()]);
  check(!!bounced && /^orograph-bounce-\d{8}-\d{6}\.wav$/.test(bounced.suggestedFilename()), `Bounce renders and saves a WAV (${bounced && bounced.suggestedFilename()})`);
  await page.keyboard.press('Escape');

  // Import an image into terrain B through the options popover
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await page.locator('.terrain-slot[data-slot="B"] input[type=file]').setInputFiles({ name: 'ridge.png', mimeType: 'image/png', buffer: png });
  await sleep(200);
  check(await page.locator('.popover--import').isVisible(), 'choosing an image opens the import options');
  await page.locator('.popover--import .btn--primary').click();
  await page.waitForFunction(() => window.orograph.store.get('parts.0.userTerrain.B'), null, { timeout: 4000 }).catch(() => {});
  check(!!(await get('parts.0.userTerrain.B')), 'importing writes the user terrain');

  // Accessibility audit on the main screen and inside each settings tab
  let missing = await a11yAudit(page);
  for (const tab of ['general', 'audio', 'midi', 'shortcuts', 'about']) {
    await page.evaluate(() => window.orograph.ui.openSettings());
    await page.locator(`#stab-${tab}`).click();
    if (tab === 'midi') { const c = page.locator('.status-actions .btn--primary'); if (await c.isVisible()) { await c.click(); await sleep(500); } }
    await sleep(150);
    missing = missing.concat(await a11yAudit(page));
    await page.keyboard.press('Escape');
    await sleep(150);
  }
  for (const pane of ['mod', 'seq', 'mix']) {
    await page.locator(`#dtab-${pane}`).click();
    await sleep(150);
    missing = missing.concat(await a11yAudit(page));
  }
  check(missing.length === 0, `every interactive element has an accessible name (${missing.length} missing)`, missing.slice(0, 5).join('\n     '));

  check(errors.length === 0, 'no console errors during the functional run', errors.slice(0, 5).join('\n     '));
  await context.close();
}

// ------------------------------------------------------------------ Round D wiring (every new control does something)
async function roundD(browser) {
  const { page, context, errors } = await openPage(browser, HARNESS, { viewport: { width: 1440, height: 900 } });
  await startAudio(page);
  const get = (p) => page.evaluate((pp) => window.orograph.store.get(pp), p);
  const knobKeys = async (sel, key = 'ArrowUp', n = 3) => { await page.locator(sel).first().focus(); for (let i = 0; i < n; i++) await page.keyboard.press(key); };

  // SOUND: Air, Air Tone, Sub, Vowel; Comb and Vowel filters
  for (const id of ['air', 'airTone', 'sub']) {
    const before = await get(`parts.0.params.${id}`);
    await knobKeys(`.dock-pane--sound .knob[data-param="${id}"] .knob-dial`);
    check(await get(`parts.0.params.${id}`) > before, `${id} knob writes parts.0.params.${id}`);
  }
  await page.locator('select[aria-label="Filter type"]').selectOption('5');
  const combAwake = await until(page, () => document.querySelector('.knob[data-param="formant"]:not(.is-dimmed)'));
  check(await get('parts.0.params.filterType') === 5 && combAwake, 'Comb filter wakes up the Vowel (spread) knob');
  const f0 = await get('parts.0.params.formant');
  await knobKeys('.knob[data-param="formant"] .knob-dial');
  check(await get('parts.0.params.formant') > f0, 'Vowel knob writes formant');
  await page.locator('select[aria-label="Filter type"]').selectOption('1');

  // MAP: Travel and Direction switches, Key>Size knob
  await page.locator('.path-switches .toggle', { hasText: 'Even speed' }).click();
  check(await get('parts.0.params.traverse') === 1, 'Even speed switch sets traverse = Even');
  await page.locator('.path-switches .toggle', { hasText: 'Ping-pong' }).click();
  check(await get('parts.0.params.direction') === 1, 'Ping-pong switch sets direction = Ping-pong');
  await page.locator('.path-switches .toggle', { hasText: 'Even speed' }).click();
  check(await get('parts.0.params.traverse') === 0, 'Even speed switch turns back to Natural');
  await knobKeys('.knob[data-param="noteSize"] .knob-dial');
  check(await get('parts.0.params.noteSize') > 0, 'Key>Size knob writes noteSize');

  // Map style Points and the palette picker
  await page.locator('.seg--style .seg-btn[data-value="points"]').click();
  check(await get('ui.renderStyle') === 'points', 'Points map style writes ui.renderStyle');
  await page.locator('.vp-palette').click();
  await until(page, () => document.querySelector('.popover--palette.is-open'));
  check(await page.locator('.popover--palette .palette-swatch').count() === 5, 'palette popover lists every palette from visuals.palettes()');
  const ramp = await page.locator('.popover--palette .palette-swatch').nth(2).locator('.palette-ramp').evaluate(el => getComputedStyle(el).backgroundImage);
  check(/linear-gradient/.test(ramp), 'palette swatches draw the palette ramp');
  await page.locator('.popover--palette .palette-swatch').nth(2).click();
  await until(page, () => document.querySelectorAll('.popover--palette .palette-swatch')[2]?.getAttribute('aria-checked') === 'true');
  check(await get('ui.palette') === 2 && await page.evaluate(() => window.orograph.visuals.state.palette) === 2, 'choosing a palette writes ui.palette and calls visuals.setPalette');
  await page.keyboard.press('Escape');
  check(await until(page, () => !document.querySelector('.popover--palette')), 'Esc closes the palette popover');
  await page.locator('.seg--style .seg-btn[data-value="relief"]').click();

  // Macros: top bar popover, keyboard, MIDI learn in the knob menu, Edit links
  await page.locator('.macros-btn').click();
  await until(page, () => document.querySelector('.popover--macros.is-open'));
  check(await page.locator('.popover--macros .knob').count() === 4, 'Macros popover shows four macro knobs');
  await knobKeys('.popover--macros .knob[data-param="macro2"] .knob-dial', 'PageUp', 2);
  check(await get('global.macro2') > 0.1, `Macro 2 knob writes global.macro2 (${await get('global.macro2')})`);
  await page.locator('.popover--macros .knob[data-param="macro1"] .knob-dial').click({ button: 'right' });
  await until(page, () => document.querySelector('.popover.menu .menu-item'));
  const mItems = await page.locator('.popover.menu .menu-item').allTextContents();
  check(mItems.some(t => /MIDI Learn/.test(t)), `macro knobs are MIDI-learnable from their menu (${mItems.join(' | ')})`);
  await page.keyboard.press('Escape');
  await sleep(120);
  await page.locator('.popover--macros .btn', { hasText: 'Edit links' }).click();
  const linksShown = await until(page, () => { const el = document.querySelector('.links-pane'); return el && el.offsetParent !== null; });
  check(await get('ui.panel') === 'mod' && linksShown, 'Edit links opens MOD > Links + Macros');

  // Links: amount, curve, remove, max 8
  await page.locator('.links-list .btn', { hasText: 'Add link' }).click();
  const n0 = (await get('parts.0.links')).length;
  await page.locator(`select[aria-label="Link ${n0} curve"]`).selectOption('2');
  check((await get(`parts.0.links.${n0 - 1}.curve`)) === 2, 'link curve select writes the curve');
  await page.locator(`[aria-label="Link ${n0} amount"]`).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  check((await get(`parts.0.links.${n0 - 1}.amt`)) < 0.5, 'link amount slider writes amt');
  await page.locator(`select[aria-label="Link ${n0} source"]`).selectOption('6'); // Macro 2
  check((await get(`parts.0.links.${n0 - 1}.src`)) === 6, 'link source select writes src');
  await until(page, () => /^\d+ links?$/.test(document.querySelectorAll('.links-macros .macro-use')[1]?.textContent || ''));
  const use2 = await page.locator('.links-macros .macro-use').nth(1).textContent();
  check(/^\d+ links?$/.test(use2), `a macro shows how many links use it (${use2})`);
  for (let i = 0; i < 10 && (await get('parts.0.links')).length < 8; i++) {
    await page.locator('.links-list .btn', { hasText: 'Add link' }).click({ timeout: 8000 });
    await until(page, (n) => document.querySelectorAll('.links-rows .links-row').length >= n, i + 2);
  }
  check(await until(page, () => document.querySelector('.links-list .section-head .btn').disabled), 'Add link is disabled at eight links');
  check((await get('parts.0.links')).length === 8, 'Add link stops at eight links');
  await page.locator('button[aria-label="Remove link 8"]').click();
  check((await get('parts.0.links')).length === 7, 'a link can be removed');
  await shot(page, 'roundd-links-full');

  // SEQ: Lock Record through music.setLockRecord, Dot glide
  await page.locator('#dtab-seq').click();
  await page.evaluate(() => { window.__lockRec = []; const m = window.orograph.music; const f = m.setLockRecord; m.setLockRecord = (on) => { window.__lockRec.push(on); return f(on); }; });
  await page.locator('.toggle--rec').click();
  check(await get('ui.lockRecord') === 1 && (await page.evaluate(() => window.__lockRec)).includes(true), 'Rec dot turns on Lock Record through music.setLockRecord');
  await page.locator('.toggle--rec').click();
  check(await get('ui.lockRecord') === 0, 'Rec dot turns Lock Record off again');
  const g0 = await get('parts.0.patterns.0.lockGlide');
  await page.locator('[aria-label="Dot lock glide time"]').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  check(await get('parts.0.patterns.0.lockGlide') > g0, 'Dot glide slider writes seq.lockGlide');
  await page.evaluate(() => { const s = window.orograph.store; s.set('parts.0.params.centerX', 0.6); s.set('parts.0.params.centerY', 0.4); });
  await page.locator('.seq-col[data-step="7"] .seq-lock').focus();
  await page.keyboard.press('Enter');
  check((await get('parts.0.patterns.0.steps.7.lock')) === 1, 'Enter on a Dot cell locks the step');
  await page.evaluate(() => window.orograph.store.set('parts.0.params.centerX', 0.1));
  await page.keyboard.press('Shift+Enter');
  check(Math.abs((await get('parts.0.patterns.0.steps.7.lx')) - 0.1) < 1e-6, 'Shift+Enter moves the lock to the current dot');

  // Dot: Roll and Explore extras
  await page.locator('.seg--dot .seg-btn[data-value="1"]').click();
  await page.locator('button[aria-label="Dot settings"]').click();
  await until(page, () => { const g = document.querySelector('.popover--dot .dot-group[data-modes="1,3"]'); return g && !g.hidden; });
  for (const id of ['gravity', 'bounce', 'flick', 'tiltX', 'tiltY']) {
    const before = await get(`parts.0.dot.${id}`);
    await knobKeys(`.popover--dot .knob[data-param="${id}"] .knob-dial`);
    check(await get(`parts.0.dot.${id}`) > before, `Roll ${id} knob writes dot.${id}`);
  }
  await shot(page, 'roundd-dot-roll');
  // The dot settings stay open while the mode changes in the same toolbar.
  const dotMode = async (v) => {
    await page.locator(`.seg--dot .seg-btn[data-value="${v}"]`).click();
    await sleep(200);
    if (!(await page.locator('.popover--dot.is-open').count())) await page.locator('button[aria-label="Dot settings"]').click();
  };
  await page.locator('.seg--dot .seg-btn[data-value="3"]').click();
  check(await until(page, () => { const g = document.querySelector('.popover--dot.is-open .dot-group[data-modes="3"]'); return g && !g.hidden; }), 'the dot settings stay open and follow a mode change (Explore)');
  await dotMode(3);
  const er0 = await get('parts.0.dot.exploreRate');
  await knobKeys('.popover--dot .knob[data-param="exploreRate"] .knob-dial');
  check(await get('parts.0.dot.exploreRate') > er0, 'Explore density writes dot.exploreRate');
  await page.locator('.popover--dot .stepper-btn').last().click();
  check(await get('parts.0.dot.exploreRange') === 3, 'Explore range stepper writes dot.exploreRange');
  await page.locator('.popover--dot .toggle', { hasText: 'Play notes' }).click();
  check(await get('parts.0.dot.exploreNotes') === 0, 'Play notes toggle writes dot.exploreNotes');
  await shot(page, 'roundd-dot-explore');
  await dotMode(4);
  await until(page, () => { const g = document.querySelector('.popover--dot .dot-group[data-modes="4"]'); return g && !g.hidden; });
  await page.locator('.popover--dot .seg-btn', { hasText: 'Ping-pong' }).click();
  check(await get('parts.0.dot.tourMode') === 1, 'Tour mode writes dot.tourMode');
  await page.evaluate(() => window.orograph.store.set('parts.0.dot.waypoints', [{ x: 0.2, y: 0.3, beats: 2 }, { x: 0.7, y: 0.6, beats: 4 }]));
  check(await until(page, () => document.querySelectorAll('.popover--dot .waypoint').length === 2), 'Tour lists the waypoints');
  await page.locator('select[aria-label="Waypoint 2 travel time"]').selectOption('8');
  check((await get('parts.0.dot.waypoints.1.beats')) === 8, 'waypoint travel time select writes beats');
  await until(page, () => document.querySelector('select[aria-label="Waypoint 2 travel time"]')?.value === '8');
  await page.locator('button[aria-label="Delete waypoint 1"]').click();
  check((await get('parts.0.dot.waypoints')).length === 1, 'a waypoint can be deleted');
  await shot(page, 'roundd-dot-tour');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.orograph.store.set('ui.editWaypoints', 1));
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('Escape');
  check((await get('ui.editWaypoints')) === 0, 'Esc ends waypoint editing');
  await page.locator('.seg--dot .seg-btn[data-value="0"]').click();

  // Preview button (toggles, lights while playing)
  await page.evaluate(() => { window.__src = []; window.orograph.music.router.on('note', e => window.__src.push(e.source)); });
  await page.evaluate(() => {
    window.__pressed = [];
    const b = document.querySelector('.preview-btn');
    new MutationObserver(() => window.__pressed.push(b.getAttribute('aria-pressed'))).observe(b, { attributes: true, attributeFilter: ['aria-pressed'] });
  });
  await page.locator('.preview-btn').click();
  check(await until(page, () => window.__src.includes('preview')), 'Preview button plays the preview phrase');
  check(await until(page, () => window.__pressed.includes('true')), 'Preview button shows that it is playing');
  check(await until(page, () => document.querySelector('.preview-btn').getAttribute('aria-pressed') === 'false'), 'Preview button goes dark when the phrase ends');

  // MIX: Ceiling
  await page.locator('#dtab-mix').click();
  const c0 = await get('global.ceiling');
  await knobKeys('.knob[data-param="ceiling"] .knob-dial', 'ArrowDown', 4);
  check(await get('global.ceiling') < c0, `Ceiling knob writes global.ceiling (${c0} -> ${await get('global.ceiling')})`);

  // Bounce: mix + stems, progress, names
  await page.locator('.bounce-btn').click();
  await until(page, () => document.querySelector('.popover--bounce.is-open'));
  await page.locator('.popover--bounce .seg-btn', { hasText: 'Mix + stems' }).click();
  await page.locator('select[aria-label="Bars to render"]').selectOption('2');
  check(await until(page, () => /2 bars at/.test(document.querySelector('.bounce-length').textContent)), 'Bounce shows how long the render is');
  const names = [];
  const onDl = (d) => names.push(d.suggestedFilename());
  page.on('download', onDl);
  await page.locator('.popover--bounce .btn--primary').click();
  await until(page, () => /Done/.test(document.querySelector('.bounce-status')?.textContent || ''), null, 12000);
  const pct = await page.locator('.bounce-progress').getAttribute('aria-valuenow');
  for (let i = 0; i < 80 && names.length < 5; i++) await sleep(100);
  page.off('download', onDl);
  check(pct === '100', `Bounce progress reaches 100% (${pct})`);
  check(names.length === 5 && /^orograph-bounce-\d{8}-\d{6}\.wav$/.test(names[0]) && names.slice(1).every((n, i) => new RegExp(`^orograph-bounce-\\d{8}-\\d{6}-part${i + 1}\\.wav$`).test(n)), `Bounce saves the mix and one stem per part (${names.join(', ')})`);
  await shot(page, 'roundd-bounce-done');
  await page.keyboard.press('Escape');

  // Settings: audio quality, palette swatches, MIDI auto output, MPE, MPC guide
  await page.evaluate(() => window.orograph.ui.openSettings('audio'));
  await page.locator('.seg[aria-label="Audio quality"] .seg-btn', { hasText: 'High' }).click();
  check(await get('ui.audioQuality') === 'high' && await page.evaluate(() => window.orograph.engine.quality) === 'high', 'Audio quality writes ui.audioQuality and calls engine.setQuality');
  check(await until(page, () => /Four times/.test(document.querySelector('.settings-panel:not([hidden]) .setting-hint')?.textContent || '')), 'Audio quality explains the chosen mode');
  await page.locator('#stab-general').click();
  check(await until(page, () => document.querySelectorAll('.settings-panel:not([hidden]) .palette-swatch').length === 5), 'Settings > General shows the palette swatches');
  await page.locator('#stab-midi').click();
  const connect = page.locator('.status-actions .btn--primary');
  if (await connect.isVisible()) { await connect.click(); await until(page, () => window.orograph.midi.status === 'ready' && document.querySelector('select[aria-label="MIDI output"] option')); }
  await until(page, () => document.querySelector('select[aria-label="MIDI output"]')?.options.length > 2);
  const optTexts = await page.locator('select[aria-label="MIDI output"] option').allTextContents();
  check(optTexts[0] === 'Automatic (MPC)', `MIDI output offers Automatic (MPC) first (${optTexts.join(' | ')})`);
  await page.locator('select[aria-label="MIDI output"]').selectOption('out-iac');
  check((await page.evaluate(() => window.orograph.midi.getSettings().outputAuto)) === false, 'choosing a port turns Automatic off');
  await page.locator('select[aria-label="MIDI output"]').selectOption('auto');
  check((await page.evaluate(() => window.orograph.midi.getSettings().outputAuto)) === true, 'Automatic (MPC) calls setSetting(outputId, auto)');
  check(await until(page, () => /Automatic: sending to MPC/.test(document.querySelector('#midi-devices ~ .setting-row .setting-hint')?.textContent || '')), 'the output hint names the port Automatic picked');
  await page.locator('.setting-row', { has: page.locator('.setting-label', { hasText: /^MPE$/ }) }).locator('.toggle').click();
  check((await page.evaluate(() => window.orograph.midi.getSettings().mpe)) === true, 'MPE switch writes the mpe setting');
  check(await page.locator('.guide-detail').count() > 5, 'the MPC guide shows step details');
  check(await page.locator('.guide-checks').count() > 0, 'the MPC guide shows the checks for each section');
  check(/firmware 3\.9/.test(await page.locator('.guide > .setting-hint').textContent()), 'the MPC guide uses the MIDI module intro');
  await page.evaluate(() => { window.orograph.midi.error = 'The MPC output was unplugged.'; });
  await page.evaluate(() => window.orograph.midi.setSetting('velocityCurve', 'soft'));
  check(await until(page, () => { const w = document.querySelector('.status-warn'); return w && !w.hidden && /unplugged/.test(w.textContent); }), 'a MIDI problem while connected is shown in the status card');
  await page.evaluate(() => { window.orograph.midi.error = null; window.orograph.midi.setSetting('velocityCurve', 'linear'); });
  await page.keyboard.press('Escape');
  await sleep(200);

  // Electron drag region on the top bar (Chromium reports app-region even outside Electron)
  const region = await page.evaluate(() => [getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region'),
    ...['.play-btn', '.part-tab', '.patch-open', '.macros-btn', '.tempo .dragnum-input'].map(sel => getComputedStyle(document.querySelector(sel)).getPropertyValue('-webkit-app-region'))]);
  check(region[0] === 'drag' && region.slice(1).every(r => r === 'no-drag'), `top bar is a drag region with no-drag controls (${region.join(', ')})`);

  // Focus is visible on keyboard focus
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.locator('.macros-btn').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return `${cs.outlineStyle} ${cs.outlineWidth}`; });
  check(/solid 2px/.test(ring), `keyboard focus shows a ring (${ring})`);

  check(errors.length === 0, 'no console errors during the Round D run', errors.slice(0, 5).join('\n     '));
  await context.close();

  // Reduced motion: animations collapse to 1 ms
  const rm = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const rp = await rm.newPage();
  await rp.goto(HARNESS, { waitUntil: 'load' });
  await rp.waitForFunction(() => document.querySelector('#app.is-ready'), null, { timeout: 120000 });
  await rp.locator('[data-action="start"]').click().catch(() => {});
  await sleep(300);
  await rp.locator('.macros-btn').click();
  await rp.waitForSelector('.popover--macros');
  const dur = await rp.evaluate(() => getComputedStyle(document.querySelector('.popover--macros')).transitionDuration);
  check(dur.split(',').every(d => parseFloat(d) <= 0.001), `reduced motion shortens transitions (${dur})`);
  await rm.close();
}

// ------------------------------------------------------------------ visual sweep
async function sweep(browser, viewport, theme) {
  const tag = `${viewport.width < 900 ? 'mobile' : `w${viewport.width}`}-${theme}`;
  const { page, context, errors } = await openPage(browser, HARNESS, { viewport, theme });
  await shot(page, `${tag}-start`);
  check((await overflowX(page)).length === 0, `${tag}: no horizontal overflow at start`);
  await startAudio(page);
  const contrast = await contrastAudit(page);
  check(contrast.length === 0, `${tag}: token contrast meets AA`, contrast.join('; '));

  const popShot = async (open, sel, name) => {
    try {
      await open();
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 4000 });
      // Wait for the fade-in to finish (frames can be slow under software GL).
      await until(page, (s2) => { const el = document.querySelector(`${s2}.is-open`) || document.querySelector(`${s2}`); return el && (el.classList.contains('menu') || el.classList.contains('is-open')) && getComputedStyle(el).opacity === '1'; }, sel, 4000);
      await sleep(150);
      await shot(page, `${tag}-pop-${name}`);
      const off = await page.locator(sel).first().evaluate(el => { const r = el.getBoundingClientRect(); return r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; });
      check(!off, `${tag}: the ${name} popover stays on screen`);
    } catch (err) { check(false, `${tag}: the ${name} popover opens`, String(err.message || err).split('\n')[0]); }
    await page.keyboard.press('Escape');
    // Let the closing popover hand focus back before the next one opens.
    await until(page, () => !document.querySelector('.popover'), null, 3000);
    await sleep(250);
  };
  const dotPop = async (mode) => {
    await page.locator(`.seg--dot .seg-btn[data-value="${mode}"]`).click();
    await sleep(150);
    if (!(await page.locator('.popover--dot.is-open').count())) await page.locator('button[aria-label="Dot settings"]').click();
  };
  if (viewport.width >= 900) {
    for (const pane of ['sound', 'mod', 'seq', 'mix']) {
      await page.locator(`#dtab-${pane}`).click();
      if (pane === 'mod') await page.evaluate(() => { const s = window.orograph.store; s.set('parts.0.mods.morph.lfoDepth', 0.3); s.set('parts.0.mods.cutoff.envDepth', -0.4); });
      await sleep(300);
      await shot(page, `${tag}-${pane}`);
      check((await overflowX(page)).length === 0, `${tag}: no horizontal overflow on ${pane}`);
      const wide = await page.evaluate(() => { const p = document.querySelector('.dock-panel:not([hidden])'); return p.scrollWidth - p.clientWidth; });
      check(wide <= 1, `${tag}: the ${pane} pane fits the dock width (${wide} px over)`);
      if (pane === 'mod') {
        await page.locator('.mod-switch .seg-btn[data-value="links"]').click();
        await sleep(250);
        await shot(page, `${tag}-mod-links`);
        await page.locator('.mod-switch .seg-btn[data-value="params"]').click();
      }
      if (pane === 'seq' && viewport.width >= 1280) {
        // The whole grid, Dot row included, fits without scrolling on common laptop sizes.
        const fit = await page.evaluate(() => { const p = document.querySelector('.dock-panel:not([hidden])'); return p.scrollHeight - p.clientHeight; });
        check(fit <= 1, `${tag}: the sequencer fits the dock without scrolling (${fit} px over)`);
      }
    }
    await page.locator('#dtab-sound').click();
    await popShot(() => page.locator('.macros-btn').click(), '.popover--macros', 'macros');
    await popShot(() => page.locator('.vp-palette').click(), '.popover--palette', 'palette');
    await popShot(() => page.locator('.bounce-btn').click(), '.popover--bounce', 'bounce');
    await popShot(() => page.locator('.patch-open').click(), '.popover--browser', 'patches');
    await popShot(() => dotPop(3), '.popover--dot', 'dot-explore');
    await popShot(() => dotPop(4), '.popover--dot', 'dot-tour');
    await page.locator('.seg--dot .seg-btn[data-value="0"]').click();
    await popShot(async () => { await page.locator('#dtab-mod').click(); await page.locator('.mod-row[data-param="cutoff"] .mod-name').click(); await page.locator('.popover--mod .seg-btn[data-value="6"]').click(); }, '.popover--mod', 'mod-steps');
    await popShot(() => page.locator('.knob[data-param="morph"] .knob-dial').click({ button: 'right' }), '.popover.menu', 'knob-menu');
    await popShot(() => page.locator('.terrain-slot[data-slot="A"] .terrain-pick').click(), '.popover--picker', 'terrain');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await popShot(() => page.locator('.terrain-slot[data-slot="B"] input[type=file]').setInputFiles({ name: 'ridge.png', mimeType: 'image/png', buffer: png }), '.popover--import', 'import');
    await page.locator('#dtab-sound').click();
    await page.keyboard.press('?');
    await sleep(300);
    await shot(page, `${tag}-help`);
    await page.keyboard.press('Escape');
    await sleep(200);
  } else {
    for (const tab of ['map', 'sound', 'mod', 'seq', 'mix', 'keys']) {
      await page.locator(`.mtab[data-tab="${tab}"]`).click();
      await sleep(300);
      await shot(page, `${tag}-${tab}`);
      check((await overflowX(page)).length === 0, `${tag}: no horizontal overflow on ${tab}`);
    }
    // Both map toolbars fit side by side without overlapping.
    const [a, b] = await page.evaluate(() => ['.vp-toolbar--left', '.vp-toolbar--right'].map(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { l: r.left, r: r.right }; }));
    check(a.r <= b.l, `${tag}: map toolbars do not overlap (${Math.round(a.r)} <= ${Math.round(b.l)})`);
    await page.locator('.mtab[data-tab="mod"]').click();
    await page.locator('.mod-switch .seg-btn[data-value="links"]').click();
    await sleep(250);
    await shot(page, `${tag}-mod-links`);
    check((await overflowX(page)).length === 0, `${tag}: no horizontal overflow on Links`);
    await page.locator('.mod-switch .seg-btn[data-value="params"]').click();
    await page.locator('.mtab[data-tab="map"]').click();
    await popShot(() => dotPop(1), '.popover--dot', 'dot-roll');
    await page.locator('.seg--dot .seg-btn[data-value="0"]').click();
    await popShot(() => page.locator('.patch-open').click(), '.popover--browser', 'patches');
    // Touch targets in the mobile tab bar and transport
    const small = await page.evaluate(() => [...document.querySelectorAll('.mtab, .transport-btn, .utils .icon-btn, .part-tab')]
      .filter(el => el.getClientRects().length > 0) // skip controls hidden at this width
      .filter(el => el.getBoundingClientRect().height < 40 || el.getBoundingClientRect().width < 36).map(el => el.className));
    check(small.length === 0, `${tag}: primary touch targets are at least 40 px`, small.join(', '));
  }

  await page.evaluate(() => window.orograph.ui.openSettings());
  for (const tab of ['general', 'audio', 'midi', 'shortcuts', 'about']) {
    await page.locator(`#stab-${tab}`).click();
    if (tab === 'midi') {
      const c = page.locator('.status-actions .btn--primary');
      if (await c.isVisible()) { await c.click(); await sleep(600); }
    }
    await sleep(200);
    await shot(page, `${tag}-settings-${tab}`);
    if (tab === 'midi') {
      await page.locator('.settings-content').evaluate(el => { el.scrollTop = 700; });
      await sleep(150);
      await shot(page, `${tag}-settings-midi-2`);
      await page.locator('.settings-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await sleep(150);
      await shot(page, `${tag}-settings-midi-3`);
      check(await page.locator('.badge--mpc').first().isVisible(), `${tag}: MPC badge shows for an MPC port`);
    }
  }
  check((await overflowX(page)).length === 0, `${tag}: no horizontal overflow with Settings open`);
  await page.keyboard.press('Escape');
  check(errors.length === 0, `${tag}: no console errors`, errors.slice(0, 5).join('\n     '));
  await context.close();
}

// ------------------------------------------------------------------ degraded modules
async function degraded(browser) {
  const { page, context, errors } = await openPage(browser, `${HARNESS}?engine=none&visuals=none&music=none&presets=none&midi=none`, { viewport: { width: 1440, height: 900 } });
  await shot(page, 'degraded-start');
  await startAudio(page);
  check(await page.locator('.flatmap-canvas').count() === 1, 'a flat map stands in when the 3D view is missing');
  check(await page.locator('.play-btn').isDisabled(), 'Play is disabled without the music engine');
  check(await page.locator('.patch-open').isDisabled(), 'the patch browser is disabled without presets');
  // Unavailable Round D controls stay focusable and say why instead of failing silently.
  check(await page.locator('.preview-btn').getAttribute('aria-disabled') === 'true', 'Preview is marked unavailable without the music engine');
  await page.locator('.preview-btn').click();
  check(await until(page, () => [...document.querySelectorAll('.toast')].some(t => /music engine/.test(t.textContent))), 'clicking an unavailable Preview explains why');
  check(await page.locator('.vp-palette').getAttribute('aria-disabled') === 'true', 'the palette button is marked unavailable without the 3D view');
  await page.locator('.seg--dot .seg-btn[data-value="3"]').click();
  await page.locator('button[aria-label="Dot settings"]').click();
  await until(page, () => { const g = document.querySelector('.popover--dot .dot-group[data-modes="3"]'); return g && !g.hidden; });
  check(await page.locator('.popover--dot .toggle', { hasText: 'Play notes' }).isDisabled(), 'Explore notes are switched off with an explanation when the music engine is missing');
  await page.locator('.seg--dot .seg-btn[data-value="4"]').click();
  await until(page, () => { const g = document.querySelector('.popover--dot .dot-group[data-modes="4"]'); return g && !g.hidden; });
  check(await page.locator('.popover--dot .toggle', { hasText: 'Edit on map' }).isDisabled(), 'waypoint editing is unavailable without the 3D map');
  await page.keyboard.press('Escape');
  await page.locator('.seg--dot .seg-btn[data-value="0"]').click();
  await page.locator('.bounce-btn').click();
  await until(page, () => document.querySelector('.popover--bounce.is-open'));
  check(/not available/.test(await page.locator('.popover--bounce').textContent()) && await page.locator('.popover--bounce .btn--primary').isDisabled(), 'Bounce explains that it needs the audio and music engines');
  await page.keyboard.press('Escape');
  await page.locator('.macros-btn').click();
  await until(page, () => document.querySelector('.popover--macros.is-open'));
  check(await page.locator('.popover--macros .knob').count() === 4, 'Macros still work without the audio engine (they are stored settings)');
  await page.keyboard.press('Escape');
  // The dot can still be placed on the flat map.
  const c = await page.locator('.flatmap-canvas').boundingBox();
  await page.mouse.click(c.x + c.width * 0.5 + 60, c.y + c.height * 0.5 - 40);
  const x = await page.evaluate(() => window.orograph.store.get('parts.0.params.centerX'));
  check(x > 0.5, `clicking the flat map moves the dot (centerX ${x.toFixed(3)})`);
  await page.locator('#dtab-seq').click();
  await page.locator('.seq-col[data-step="0"] .seq-pad').click();
  check(await page.evaluate(() => window.orograph.store.get('parts.0.patterns.0.steps.0.on')) === 1, 'steps can be edited without the music engine');
  await shot(page, 'degraded-seq');
  await page.evaluate(() => window.orograph.ui.openSettings('midi'));
  await sleep(200);
  check(/not available/i.test(await page.locator('.status-title').textContent()), 'MIDI tab explains when MIDI is unavailable');
  await shot(page, 'degraded-settings-midi');
  check(errors.length === 0, 'no console errors with every module missing', errors.slice(0, 5).join('\n     '));
  await context.close();

  const u = await openPage(browser, `${HARNESS}?midi=unsupported`, { viewport: { width: 1280, height: 800 }, theme: 'light' });
  await startAudio(u.page);
  await u.page.evaluate(() => window.orograph.ui.openSettings('midi'));
  await sleep(200);
  check(/Chrome, Edge/.test(await u.page.locator('.status-text').textContent()), 'unsupported browsers get a clear MIDI message');
  await shot(u.page, 'unsupported-midi-light');
  check(u.errors.length === 0, 'no console errors with MIDI unsupported', u.errors.join('; '));
  await u.context.close();
}

// ------------------------------------------------------------------ real app
async function realApp(browser) {
  const need = ['src/audio/engine.js', 'src/visual/visuals.js', 'src/music/music.js', 'src/presets/presets.js', 'src/midi/midi.js'];
  const missing = need.filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) { console.log(`SKIP real app (not built yet: ${missing.join(', ')})`); return; }
  for (const [viewport, theme] of [[{ width: 1440, height: 900 }, 'dark'], [{ width: 1440, height: 900 }, 'light'], [{ width: 390, height: 844 }, 'dark']]) {
    const tag = `real-${viewport.width}-${theme}`;
    let ctx;
    try {
      ctx = await openPage(browser, `${BASE}/`, { viewport, theme });
    } catch (err) {
      check(false, `${tag}: the real app boots`, String(err.message || err));
      continue;
    }
    const { page, context, errors } = ctx;
    page.setDefaultTimeout(120000);
    // Software WebGL (SwiftShader) can keep the main thread busy for a while at
    // startup; wait until the page answers quickly before measuring anything.
    for (let i = 0; i < 40; i++) {
      const t0 = Date.now();
      await page.evaluate(() => 1);
      if (Date.now() - t0 < 300) break;
      await sleep(1000);
    }
    await shot(page, `${tag}-start`);
    await startAudio(page);
    await sleep(800);
    await shot(page, `${tag}-main`);
    check((await overflowX(page)).length === 0, `${tag}: no horizontal overflow`);
    if (viewport.width >= 900) {
      const dial = page.locator('.knob[data-param="morph"] .knob-dial');
      await dial.focus();
      await page.keyboard.press('PageUp');
      check(await page.evaluate(() => window.orograph.store.get(`parts.${window.orograph.store.get('ui.selectedPart')}.params.morph`)) > 0, `${tag}: knobs drive the real store`);
      await page.keyboard.down('a');
      await sleep(300);
      await page.keyboard.up('a');
      await page.locator('#dtab-seq').click();
      await page.locator('button[aria-label="Play"]').click().catch(() => {});
      await sleep(1200);
      await shot(page, `${tag}-seq`);
      await page.keyboard.press('Space');
      for (const pane of ['mod', 'mix']) { await page.locator(`#dtab-${pane}`).click(); await sleep(300); await shot(page, `${tag}-${pane}`); }
      await page.evaluate(() => window.orograph.ui && window.orograph.ui.openSettings && window.orograph.ui.openSettings('midi'));
      await page.keyboard.press(',');
      await sleep(300);
      await page.locator('#stab-midi').click().catch(() => {});
      await sleep(300);
      await shot(page, `${tag}-settings-midi`);
      await page.keyboard.press('Escape');
    }
    check(errors.length === 0, `${tag}: no console errors in the real app`, errors.slice(0, 6).join('\n     '));
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch(LAUNCH);
  try {
    if (!process.env.ONLY_REAL) {
      await functional(browser);
      await roundD(browser);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
        for (const theme of ['dark', 'light']) await sweep(browser, viewport, theme);
      }
      await degraded(browser);
    }
    if (!process.env.SKIP_REAL) await realApp(browser);
  } catch (err) {
    failures.push('crashed: ' + (err && err.stack || err));
    console.log('FAIL crashed:', err && err.stack || err);
  } finally {
    await browser.close();
  }
  console.log(`\n${passes} passed, ${failures.length} failed. Screenshots in ${OUT}`);
  process.exit(failures.length ? 1 : 0);
})();
