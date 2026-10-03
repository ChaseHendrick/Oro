'use strict';

// Opt-in automatic updates for the unsigned Mac app (2.12).
//
// Squirrel.Mac (electron-updater's Mac path) only accepts a Developer ID
// signed app, so the Mac build cannot use it. This module replaces the app
// bundle itself: it downloads the release zip for this processor, checks its
// sha512 against latest-mac.yml, unpacks it with ditto, checks the bundle
// version, and on quit (or Restart now) hands over to a small detached shell
// script that swaps the bundles once Oro has exited, restoring the old one if
// any step fails. Everything that touches the disk, network or processes is
// injected so the pure parts are tested in Node; the swap itself can only be
// exercised on a real Mac.

const path = require('node:path');
const crypto = require('node:crypto');

const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/ChaseHendrick/synth/releases/download/';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * Parse the subset of YAML electron-builder writes to latest-mac.yml:
 * top-level scalars plus a `files:` list of { url, sha512, size } maps.
 */
function parseLatestMacYml(text) {
  if (typeof text !== 'string' || text.length > MAX_MANIFEST_BYTES) throw new Error('The update manifest is missing or too large.');
  const unquote = value => {
    const v = value.trim();
    if ((v.startsWith("'") && v.endsWith("'") && v.length >= 2)) return v.slice(1, -1).replace(/''/g, "'");
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)) return v.slice(1, -1);
    return v;
  };
  const out = { version: null, files: [] };
  let inFiles = false, current = null, block = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    // A block scalar (`key: >-` then a more indented line) as js-yaml writes long strings.
    if (block) {
      const indent = raw.length - raw.trimStart().length;
      if (indent > block.indent) { block.target[block.key] = block.target[block.key] ? `${block.target[block.key]}${block.fold ? ' ' : '\n'}${raw.trim()}` : raw.trim(); continue; }
      block = null;
    }
    const top = /^([A-Za-z][\w]*):\s*(.*)$/.exec(raw);
    if (top) {
      inFiles = top[1] === 'files' && top[2].trim() === '';
      current = null;
      if (top[1] === 'version') out.version = unquote(top[2]);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+([A-Za-z][\w]*):\s*(.*)$/.exec(raw);
    const field = /^\s+([A-Za-z][\w]*):\s*(.*)$/.exec(raw);
    const entry = item || field;
    if (item) { current = {}; out.files.push(current); }
    if (!entry || !current) continue;
    const blockMatch = /^([>|])[-+]?$/.exec(entry[2].trim());
    if (blockMatch) { current[entry[1]] = ''; block = { target: current, key: entry[1], fold: blockMatch[1] === '>', indent: raw.indexOf(entry[1] + ':') }; }
    else current[entry[1]] = unquote(entry[2]);
  }
  for (const file of out.files) if (file.size != null) file.size = /^\d+$/.test(file.size) ? Number(file.size) : null;
  if (!/^\d+\.\d+\.\d+$/.test(out.version || '')) throw new Error('The update manifest has no valid version.');
  return out;
}

/** The zip for this processor: Oro-mac-arm64.zip on Apple silicon, Oro-mac-x64.zip on Intel. */
function macZipName(arch) {
  if (arch === 'arm64') return 'Oro-mac-arm64.zip';
  if (arch === 'x64') return 'Oro-mac-x64.zip';
  throw new Error(`Automatic updates do not support this processor (${arch}).`);
}
function pickMacZip(manifest, arch) {
  const name = macZipName(arch);
  const file = manifest.files.find(f => f.url === name);
  if (!file || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512 || '')) throw new Error(`The release has no checksum for ${name}.`);
  return file;
}

/** The release asset download URL for `name`, accepted only from this repository. */
function assetUrl(release, name) {
  const asset = Array.isArray(release?.assets) ? release.assets.find(a => a && a.name === name) : null;
  const url = asset?.browser_download_url;
  if (typeof url !== 'string' || !url.startsWith(RELEASE_DOWNLOAD_PREFIX) || !url.endsWith('/' + name)) throw new Error(`The release has no ${name}.`);
  return url;
}

function sha512Base64(bytes) { return crypto.createHash('sha512').update(bytes).digest('base64'); }
/** Hash a file in chunks (the zip is about 100 MB) and compare with the manifest's base64 sha512. */
async function verifySha512(fs, file, expected) {
  const hash = crypto.createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const actual = hash.digest('base64');
  if (typeof expected !== 'string' || actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new Error('The downloaded update does not match the release checksum. It was not installed.');
  }
  return true;
}

/** CFBundleShortVersionString from an XML Info.plist. */
function bundleVersion(plistText) {
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/.exec(String(plistText || ''));
  return match ? match[1] : null;
}

/** /Applications/Oro.app from /Applications/Oro.app/Contents/MacOS/Oro, or null. */
function appBundlePath(exePath) {
  const parts = String(exePath || '').split('/');
  const index = parts.findIndex(part => part.endsWith('.app'));
  return index > 0 ? parts.slice(0, index + 1).join('/') : null;
}

/**
 * Why the running app cannot replace itself, or null when it can. `access`
 * throws when the path is not writable (fs.accessSync with W_OK).
 */
function installLocationProblem(appPath, { access }) {
  if (!appPath || !path.isAbsolute(appPath)) return 'Oro could not find its own app bundle, so it cannot update itself. Download the new version instead.';
  if (appPath.includes('/AppTranslocation/')) {
    return 'macOS is running Oro from a temporary read-only copy (App Translocation). Move Oro to your Applications folder, open it from there, then try again.';
  }
  if (appPath.startsWith('/Volumes/')) {
    try { access(path.dirname(appPath)); } catch {
      return 'Oro is running from a disk image or read-only volume. Drag Oro to your Applications folder, open it from there, then try again.';
    }
  }
  try { access(path.dirname(appPath)); access(appPath); } catch {
    return `Oro cannot write to ${path.dirname(appPath)}. Move Oro to your Applications folder (or ~/Applications), then try again.`;
  }
  return null;
}

/** Quote a string for /bin/sh: wrap in single quotes, escaping embedded ones. */
function shellQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('Invalid path.');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The detached script that swaps the bundles after Oro exits. It waits for
 * `pid`, moves the old app to a backup, moves the staged app into place,
 * clears quarantine only if present, optionally reopens Oro, and restores the
 * backup if any step fails. Everything is logged to `logFile`.
 */
function swapScript({ pid, appPath, stagedApp, backupPath, logFile, relaunch }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process id.');
  const q = shellQuote;
  return `#!/bin/sh
# Oro automatic update (generated). Replaces the app bundle after Oro exits.
PID=${pid}
APP=${q(appPath)}
NEW=${q(stagedApp)}
BACKUP=${q(backupPath)}
LOG=${q(logFile)}
RELAUNCH=${relaunch ? 1 : 0}
log() { printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null; }
restore() {
  log "restoring the previous version: $1"
  if [ -d "$BACKUP" ]; then
    rm -rf "$APP" >> "$LOG" 2>&1
    mv "$BACKUP" "$APP" >> "$LOG" 2>&1 || log "could not restore the backup at $BACKUP"
  fi
  if [ "$RELAUNCH" = 1 ]; then open "$APP" >> "$LOG" 2>&1; fi
  exit 1
}
log "waiting for Oro (pid $PID) to quit"
n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 600 ]; then log "Oro did not quit within 5 minutes; update skipped"; exit 1; fi
  sleep 0.5
done
[ -d "$NEW/Contents" ] || { log "the staged update is missing; nothing changed"; exit 1; }
rm -rf "$BACKUP" >> "$LOG" 2>&1
mv "$APP" "$BACKUP" >> "$LOG" 2>&1 || { log "could not move the current app aside; nothing changed"; if [ "$RELAUNCH" = 1 ]; then open "$APP"; fi; exit 1; }
mv "$NEW" "$APP" >> "$LOG" 2>&1 || restore "could not move the new app into place"
if xattr -lr "$APP" 2>/dev/null | grep -q com.apple.quarantine; then
  xattr -dr com.apple.quarantine "$APP" >> "$LOG" 2>&1 || restore "could not clear quarantine"
fi
if [ "$RELAUNCH" = 1 ]; then
  open "$APP" >> "$LOG" 2>&1 || restore "the new version did not open"
fi
rm -rf "$BACKUP" >> "$LOG" 2>&1
log "update installed"
exit 0
`;
}

/** GET over https, following up to MAX_REDIRECTS https redirects. Resolves with the final response. */
function httpsGet(https, url, { headers = {}, redirects = MAX_REDIRECTS, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//.test(url)) { reject(new Error('Updates are only downloaded over HTTPS.')); return; }
    const request = https.get(url, { headers: { 'User-Agent': 'Oro-desktop', ...headers } }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) { reject(new Error('The download redirected too many times.')); return; }
        const next = new URL(response.headers.location, url).toString();
        httpsGet(https, next, { headers, redirects: redirects - 1, timeoutMs }).then(resolve, reject);
        return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`The download server returned HTTP ${status}. Try again later.`)); return; }
      resolve(response);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('The download timed out. Try again later.')));
    request.on('error', reject);
  });
}

async function downloadText(https, url, max = MAX_MANIFEST_BYTES) {
  const response = await httpsGet(https, url);
  const chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > max) { response.destroy(); throw new Error('The update manifest is too large.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadFile(https, fs, url, file, { expectedSize, onProgress = () => {} } = {}) {
  const response = await httpsGet(https, url);
  const total = Number(response.headers['content-length']) || expectedSize || 0;
  if (total > MAX_ZIP_BYTES) { response.destroy(); throw new Error('The update is unexpectedly large.'); }
  let transferred = 0;
  const out = fs.createWriteStream(file, { mode: 0o600 });
  try {
    for await (const chunk of response) {
      transferred += chunk.length;
      if (transferred > MAX_ZIP_BYTES) throw new Error('The update is unexpectedly large.');
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      onProgress({ percent: total ? Math.min(100, (transferred / total) * 100) : 0, transferred, total });
    }
  } finally {
    await new Promise(resolve => out.end(resolve));
  }
  if (expectedSize && transferred !== expectedSize) throw new Error('The update download was incomplete. Try again.');
  return transferred;
}

/**
 * The Mac installer the update controller drives. `prepare` downloads, checks
 * and stages a release; `launch` hands over to the swap script (call it just
 * before quitting).
 */
function createMacInstaller({ fs, https, execFile, spawn, tmpdir, userData, exePath, arch, pid, currentVersion, newerVersion }) {
  let staged = null, launched = false;
  const updateDir = path.join(userData, 'mac-update');
  const logFile = path.join(userData, 'mac-update.log');
  const log = message => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch { /* logging is best effort */ } };
  const appPath = () => appBundlePath(exePath);
  const problem = () => installLocationProblem(appPath(), { access: file => fs.accessSync(file, fs.constants.W_OK) });
  const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 5 * 60 * 1000 }, error => error ? reject(error) : resolve()));

  async function prepare(release, { onProgress = () => {} } = {}) {
    const blocked = problem();
    if (blocked) throw new Error(blocked);
    const manifest = parseLatestMacYml(await downloadText(https, assetUrl(release, 'latest-mac.yml')));
    if (!newerVersion(manifest.version, currentVersion)) throw new Error(`The release (${manifest.version}) is not newer than this version.`);
    const tag = String(release?.tag_name || '').replace(/^v/, '');
    if (tag !== manifest.version) throw new Error('The release tag and its update manifest disagree. Nothing was installed.');
    const file = pickMacZip(manifest, arch);
    const work = fs.mkdtempSync(path.join(tmpdir, 'oro-update-'));
    const zip = path.join(work, file.url);
    log(`downloading ${file.url} for ${manifest.version}`);
    await downloadFile(https, fs, assetUrl(release, file.url), zip, { expectedSize: file.size || undefined, onProgress });
    await verifySha512(fs, zip, file.sha512);
    log('checksum verified');
    const staging = path.join(work, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    await run('/usr/bin/ditto', ['-x', '-k', zip, staging]);
    const app = path.join(staging, 'Oro.app');
    const version = bundleVersion(fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'));
    if (version !== manifest.version) throw new Error('The downloaded app has an unexpected version. Nothing was installed.');
    try { fs.rmSync(zip, { force: true }); } catch { /* temporary file */ }
    staged = { version, app, work };
    log(`staged ${version} at ${app}`);
    return { version };
  }
  /** Start the swap script; it waits for this process to exit. Returns false when nothing is staged. */
  function launch({ relaunch = false } = {}) {
    if (!staged || launched) return false;
    const blocked = problem();
    if (blocked) { log(`not installing: ${blocked}`); throw new Error(blocked); }
    const target = appPath();
    fs.mkdirSync(updateDir, { recursive: true });
    const script = path.join(updateDir, 'install-update.sh');
    fs.writeFileSync(script, swapScript({ pid, appPath: target, stagedApp: staged.app, backupPath: `${target.replace(/\.app$/, '')} (previous version).app`, logFile, relaunch }), { mode: 0o700 });
    const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
    child.unref();
    launched = true;
    log(`installer started for ${staged.version}${relaunch ? ' (restart now)' : ' (on quit)'}`);
    return true;
  }
  return { prepare, launch, problem, staged: () => staged ? { version: staged.version } : null, logFile };
}

module.exports = { RELEASE_DOWNLOAD_PREFIX, parseLatestMacYml, macZipName, pickMacZip, assetUrl, sha512Base64, verifySha512, bundleVersion,
  appBundlePath, installLocationProblem, shellQuote, swapScript, httpsGet, downloadText, downloadFile, createMacInstaller };
