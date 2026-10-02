'use strict';

// Security policy for the desktop shell, kept free of any `electron` import so
// the decisions can be unit-tested in plain Node (tests/packaging/).

const APP_SCHEME = 'app';
const APP_HOST = 'orograph';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const START_URL = `${APP_ORIGIN}/index.html`;

const REPO_URL = 'https://github.com/ChaseHendrick/synth';
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const ISSUES_URL = `${REPO_URL}/issues`;

// Permissions our own page may use. Everything else, and every permission for
// any other origin, is denied.
//   midi, midiSysex  Web MIDI. Current Chromium gates every requestMIDIAccess()
//               call, with or without { sysex: true }, behind the SysEx permission
//               (verified in Electron 44: granting only 'midi' makes a plain
//               requestMIDIAccess() fail with NotAllowedError). So SysEx must be
//               granted for MIDI to work at all. That is acceptable because only our
//               own bundled code runs on this origin (the CSP blocks foreign script),
//               and Orograph itself never sends SysEx.
//   fullscreen  the HTML Fullscreen API, in case the UI offers a full-screen view;
//               denying it would make such a button silently fail.
//   pointerLock lets knob drags keep going past the screen edge.
//   clipboard-sanitized-write  "copy" buttons (write only; reading stays denied).
const ALLOWED_PERMISSIONS = new Set([
  'midi',
  'midiSysex',
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
]);

// Answered only by the permission *check* handler (never by a request), so the page
// can list and pick audio outputs (Settings > Audio > Output device, via
// enumerateDevices and AudioContext.setSinkId) for an audio interface or an MPC.
// The microphone itself stays off: getUserMedia goes through the request handler,
// which still refuses 'media'.
const CHECK_ONLY_PERMISSIONS = new Set(['speaker-selection']);

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function parseUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try { return new URL(value); } catch { return null; }
}

/** Origin string for a URL or origin, or '' when it cannot be parsed. */
function originOf(value) {
  const url = parseUrl(value);
  if (!url) return '';
  // Node and Chromium both report "null" for non-special schemes, so build the
  // origin from its parts; that is exactly how Chromium serialises a standard scheme.
  if (url.protocol === `${APP_SCHEME}:`) return url.host ? `${APP_SCHEME}://${url.host}` : '';
  return url.origin;
}

/** True for URLs served by our own protocol handler. */
function isAppUrl(value) {
  return originOf(value) === APP_ORIGIN;
}

/** True for links we are willing to hand to the operating system (browser / mail app). */
function isExternalUrl(value) {
  const url = parseUrl(value);
  if (!url || !EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
  if (url.protocol === 'mailto:') return url.pathname.length > 0;
  return url.hostname.length > 0;
}

/**
 * Permission decision shared by the request and check handlers.
 * `source` is the requesting origin or URL as Electron reports it.
 */
function isPermissionAllowed(permission, source) {
  return ALLOWED_PERMISSIONS.has(permission) && originOf(source) === APP_ORIGIN;
}

/**
 * Decision for session.setPermissionCheckHandler: the request policy plus
 * audio-output device listing ('speaker-selection', and 'media' for audio only,
 * which Chromium also consults before it shows output device names).
 */
function isPermissionCheckAllowed(permission, source, details = {}) {
  if (isPermissionAllowed(permission, source)) return true;
  if (originOf(source) !== APP_ORIGIN) return false;
  if (CHECK_ONLY_PERMISSIONS.has(permission)) return true;
  return permission === 'media' && details != null && details.mediaType === 'audio';
}

/**
 * What to do with a renderer-initiated navigation or window.open():
 *   'allow'    stay in the app (same origin)
 *   'external' open in the system browser / mail client instead
 *   'deny'     ignore (file:, javascript:, data:, other schemes)
 */
function navigationAction(value) {
  if (isAppUrl(value)) return 'allow';
  if (isExternalUrl(value)) return 'external';
  return 'deny';
}

module.exports = {
  APP_SCHEME,
  APP_HOST,
  APP_ORIGIN,
  START_URL,
  REPO_URL,
  RELEASES_URL,
  ISSUES_URL,
  ALLOWED_PERMISSIONS,
  originOf,
  isAppUrl,
  isExternalUrl,
  isPermissionAllowed,
  isPermissionCheckAllowed,
  navigationAction,
};
