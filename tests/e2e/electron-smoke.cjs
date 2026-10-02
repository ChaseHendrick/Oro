// Desktop shell smoke test: launches the real Electron main process
// (electron/main.cjs) with Playwright and checks the things that only exist in
// the desktop app: the app:// protocol, CSP, permissions, link handling,
// window-state persistence and the single-instance lock.
//
//   node tests/e2e/electron-smoke.cjs            stub build (dev/packaging/stub-dist + public/)
//   node tests/e2e/electron-smoke.cjs --real     the real dist/ (run `npm run build` first)
//
// On a Linux machine without a display it re-runs itself under xvfb-run.
// Screenshots land in /tmp/orograph-shots/packaging/. Exit code 1 on any failure.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.SHOTS || '/tmp/orograph-shots/packaging';
const REAL = process.argv.includes('--real');

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.OROGRAPH_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', process.execPath, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, OROGRAPH_XVFB: '1' },
  });
  if (r.error) {
    console.error('No display and xvfb-run is not available:', r.error.message);
    process.exit(1);
  }
  process.exit(r.status === null ? 1 : r.status);
}

const { _electron: electron } = require('/opt/node22/lib/node_modules/playwright');
const electronBinary = require(path.join(ROOT, 'node_modules', 'electron'));

fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const check = (ok, msg, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}${!ok && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chromium refuses to run as root without --no-sandbox; the renderer sandbox
// setting is still verified through webPreferences below.
const FLAGS = [
  ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
];

function makeStubDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orograph-stub-dist-'));
  fs.cpSync(path.join(ROOT, 'public'), dir, { recursive: true }); // what Vite copies from public/
  fs.cpSync(path.join(ROOT, 'dev', 'packaging', 'stub-dist'), dir, { recursive: true });
  return dir;
}

async function launch({ distDir, userData, extraFlags = [] }) {
  const env = { ...process.env, OROGRAPH_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '' };
  if (distDir) env.OROGRAPH_DIST = distDir;
  else delete env.OROGRAPH_DIST;
  const app = await electron.launch({ executablePath: electronBinary, args: [...FLAGS, ...extraFlags, ROOT], cwd: ROOT, env, timeout: 30000 });
  const mainLog = [];
  app.process().stdout.on('data', (d) => mainLog.push(...String(d).split('\n').filter((l) => l.includes('[orograph]'))));
  const page = await app.firstWindow({ timeout: 30000 });
  return { app, page, mainLog };
}

const windowInfo = (app) => app.evaluate(({ BrowserWindow, Menu }) => {
  const wins = BrowserWindow.getAllWindows();
  const w = wins[0];
  const prefs = w.webContents.getLastWebPreferences();
  return {
    count: wins.length,
    bounds: w.getBounds(),
    min: w.getMinimumSize(),
    visible: w.isVisible(),
    url: w.webContents.getURL(),
    prefs: { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration },
    backgroundThrottling: w.webContents.getBackgroundThrottling(),
    menu: Menu.getApplicationMenu().items.map((i) => i.label),
    viewMenu: Menu.getApplicationMenu().items.find((i) => i.label === 'View').submenu.items.map((i) => i.role || i.label),
  };
});

async function stubSuite() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orograph-userdata-'));
  const distDir = makeStubDist();

  // First launch: defaults, protocol, CSP, permissions, links. The net log
  // proves the shell itself never touches the network.
  const netLog = path.join(userData, 'netlog.json');
  let { app, page, mainLog } = await launch({ distDir, userData, extraFlags: [`--log-net-log=${netLog}`] });
  await page.waitForFunction(() => window.__stub && window.__stub.done, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.__stub.results);
  console.log('stub results:', JSON.stringify(r, null, 1));

  check(r.href === 'app://orograph/index.html', 'page is served from app://orograph/index.html', r.href);
  check(r.secureContext === true, 'app:// is a secure context');
  check(r.inlineScript === true, 'inline script allowed by its CSP hash');
  check(r.css === 'loaded', 'stylesheet served as text/css');
  check(r.wasm === 5, 'WebAssembly.instantiateStreaming works (application/wasm)', r.wasm);
  check(r.json === true, 'fetch() of JSON works');
  check(r.rangeRequest === '206 {"ok":', 'range requests return 206 partial content', r.rangeRequest);
  check(r.png === 512, 'PNG icon loads', r.png);
  check(typeof r.svg === 'number' && r.svg > 0, 'SVG favicon loads', r.svg);
  check(r.manifest === 'Orograph', 'web manifest served', r.manifest);
  check(r.worker === 42, 'blob: Worker allowed by CSP', r.worker);
  check(r.audioWorklet === 'running' || r.audioWorklet === 'suspended', 'blob: AudioWorklet module loads', r.audioWorklet);
  check(r.localStorage === 1, 'localStorage available on first launch', r.localStorage);
  check(r.midiPermission === 'granted', 'Web MIDI permission granted to app://orograph', r.midiPermission);
  check(r.sysexPermission === 'granted', 'MIDI SysEx permission granted (Chromium gates all MIDI behind it)', r.sysexPermission);
  // Without an ALSA sequencer (containers, CI) Chromium answers InvalidStateError after
  // the permission step; what must never happen is a permission refusal.
  const midiOk = (v) => /^granted/.test(v) || /InvalidStateError: Platform dependent initialization failed/.test(v);
  check(midiOk(r.midiAccess), 'navigator.requestMIDIAccess() passes the permission check', r.midiAccess);
  check(midiOk(r.sysexAccess), 'requestMIDIAccess({ sysex: true }) passes the permission check', r.sysexAccess);
  check(r.geolocationPermission === 'denied', 'unrelated permissions denied', r.geolocationPermission);
  check(/^error/.test(String(r.microphoneCapture)) && !/timed out/.test(r.microphoneCapture), 'microphone capture never starts (request handler denies media)', r.microphoneCapture);
  check(r.injectedScriptBlocked === true, 'CSP blocks injected inline scripts');
  check(r.remoteFetchBlocked === true, 'CSP blocks remote fetch');
  check(r.cspViolations.some((v) => v.startsWith('connect-src https://example.com')), 'remote fetch was a CSP violation (not a network error)', r.cspViolations);
  check(r.traversalStatus === 403, 'path traversal through the protocol is refused', r.traversalStatus);
  check(r.missingStatus === 404, 'missing files are 404', r.missingStatus);

  const info = await windowInfo(app);
  check(info.count === 1, 'one window');
  check(info.visible, 'window shown after ready-to-show');
  check(info.bounds.width === 1440 && info.bounds.height === 900, 'default size 1440x900', info.bounds);
  check(info.min[0] === 960 && info.min[1] === 640, 'minimum size 960x640', info.min);
  check(info.prefs.contextIsolation === true && info.prefs.sandbox === true && info.prefs.nodeIntegration === false, 'renderer isolated and sandboxed', info.prefs);
  check(info.backgroundThrottling === false, 'background throttling off');
  check(JSON.stringify(info.menu) === JSON.stringify(['File', 'Edit', 'View', 'Window', 'Help']), 'menu bar File/Edit/View/Window/Help', info.menu);
  check(info.viewMenu.includes('toggledevtools') || info.viewMenu.includes('toggleDevTools'), 'DevTools offered in the unpackaged app', info.viewMenu);
  check(await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'), 'no Node globals in the page');

  await page.screenshot({ path: path.join(SHOTS, 'electron-stub.png') });

  // External links: record instead of really launching a browser.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => { globalThis.__opened.push(url); };
  });
  // Clicks dispatched in the page: Playwright's own click would wait for a navigation
  // that the shell deliberately cancels.
  await page.evaluate(() => document.getElementById('ext').click());
  await sleep(300);
  await page.evaluate(() => document.getElementById('nav').click());
  await sleep(500);
  await page.evaluate(() => { location.href = 'file:///etc/passwd'; });
  await sleep(500);
  await page.evaluate(() => window.open('javascript:alert(1)'));
  await sleep(300);
  const opened = await app.evaluate(() => globalThis.__opened);
  check(JSON.stringify(opened) === JSON.stringify(['https://example.com/opened-in-browser', 'https://example.com/navigated']),
    'http(s) links go to the system browser, nothing else does', opened);
  const after = await windowInfo(app);
  check(after.url === 'app://orograph/index.html' && after.count === 1, 'window stayed on the app and no new window opened', after);

  // Single-instance lock: a second launch exits and leaves the first running.
  const second = spawn(electronBinary, [...FLAGS, ROOT], {
    cwd: ROOT, env: { ...process.env, OROGRAPH_USER_DATA: userData, OROGRAPH_DIST: distDir }, stdio: 'ignore',
  });
  const exitCode = await Promise.race([
    new Promise((res) => second.on('exit', (code) => res(code))),
    sleep(15000).then(() => 'still running'),
  ]);
  if (exitCode === 'still running') second.kill('SIGKILL');
  check(exitCode === 0, 'second instance exits immediately', exitCode);
  check((await windowInfo(app)).count === 1, 'first instance still has its window');

  // Move/resize, quit, and expect the next launch to come back the same way.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 120, y: 90, width: 1200, height: 760 }));
  await sleep(900);
  await app.close();
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'window-state.json'), 'utf8'));
  check(saved.x === 120 && saved.y === 90 && saved.width === 1200 && saved.height === 760, 'window state written to userData/window-state.json', saved);
  const urls = [...new Set((fs.readFileSync(netLog, 'utf8').match(/"url":"(https?:[^"]*)"/g) || []))];
  check(urls.length === 0, 'no network requests from the app (spellcheck dictionaries, links, fetch)', urls);

  ({ app, page, mainLog } = await launch({ distDir, userData }));
  await page.waitForFunction(() => window.__stub && window.__stub.done, null, { timeout: 30000 });
  const relaunch = await windowInfo(app);
  check(relaunch.bounds.x === 120 && relaunch.bounds.y === 90 && relaunch.bounds.width === 1200 && relaunch.bounds.height === 760,
    'saved bounds restored on next launch', relaunch.bounds);
  check(await page.evaluate(() => window.__stub.results.localStorage) === 2, 'localStorage persists across launches');
  await app.close();

  // A missing build folder shows instructions instead of a blank window.
  ({ app, page, mainLog } = await launch({ distDir: path.join(distDir, 'missing'), userData: fs.mkdtempSync(path.join(os.tmpdir(), 'orograph-userdata-')) }));
  // Playwright reads stdout during startup, so reload to see this load's log lines.
  await page.reload({ waitUntil: 'load' });
  await sleep(300);
  check((await page.textContent('h1')) === 'Orograph has not been built yet', 'helpful page when dist/ is missing');
  check(mainLog.some((l) => l.includes('loaded app://orograph/index.html')), 'main process logs each page load', mainLog);
  await app.close();

  fs.rmSync(distDir, { recursive: true, force: true });
}

async function realSuite() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.log('FAIL dist/index.html not found; run `npm run build` first');
    failures.push('no dist');
    return;
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orograph-userdata-'));
  const { app, page, mainLog } = await launch({ distDir: null, userData });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`console ${m.type()}: ${m.text()}`); });
  await page.waitForLoadState('load');
  // Reload so every console line and main-process log of a full boot is captured.
  await page.reload({ waitUntil: 'load' });
  const booted = await page.waitForFunction(() => window.orograph && window.orograph.store, null, { timeout: 30000 }).then(() => true, () => false);
  check(booted, 'real app boots inside Electron (window.orograph present)');
  await sleep(2500);
  // main.cjs forwards renderer warnings/errors to stdout in unpackaged runs, from the very first line.
  const csp = mainLog.filter((l) => /Content Security Policy|Refused to/i.test(l));
  check(csp.length === 0, 'no CSP violations while the real app runs', csp);
  check(problems.length === 0, 'no page errors or console errors', problems);
  const midi = await page.evaluate(async () => (await navigator.permissions.query({ name: 'midi' })).state);
  check(midi === 'granted', 'MIDI permission granted in the real app', midi);
  await page.screenshot({ path: path.join(SHOTS, 'electron-real.png') });
  console.log('main process log:\n  ' + mainLog.join('\n  '));
  await app.close();
}

(async () => {
  try {
    if (REAL) await realSuite();
    else await stubSuite();
  } catch (err) {
    console.error(err);
    failures.push(String(err && err.message));
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})();
