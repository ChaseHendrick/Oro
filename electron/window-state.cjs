'use strict';

// Remembers the main window's size, position and maximised state between runs
// in a small JSON file under app.getPath('userData'). Pure Node so it can be
// unit-tested; main.cjs feeds it display work areas from the `screen` module.

const fsDefault = require('node:fs');
const path = require('node:path');

const DEFAULT_SIZE = Object.freeze({ width: 1440, height: 900 });
const MIN_SIZE = Object.freeze({ width: 960, height: 640 });
// How much of the window's top strip (where the title bar lives) must land on a
// display before we trust a saved position: enough to grab it and drag it back.
const TITLE_STRIP = 40;
const MIN_VISIBLE = Object.freeze({ width: 120, height: 20 });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validate whatever came out of the JSON file; unknown or broken fields are dropped. */
function sanitizeState(raw) {
  const out = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, maximized: false };
  if (!raw || typeof raw !== 'object') return out;
  if (finite(raw.width) && raw.width > 0) out.width = Math.round(raw.width);
  if (finite(raw.height) && raw.height > 0) out.height = Math.round(raw.height);
  if (finite(raw.x) && finite(raw.y)) { out.x = Math.round(raw.x); out.y = Math.round(raw.y); }
  out.maximized = raw.maximized === true;
  return out;
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Turn a saved state into BrowserWindow bounds that are guaranteed to be usable
 * on the current displays (monitors get unplugged, resolutions change).
 *   workAreas: [{x, y, width, height}], primary first.
 * Returns { width, height, x?, y?, maximized }; x/y are omitted when
 * the window should be centred by Electron.
 */
function fitToDisplays(state, workAreas) {
  const s = sanitizeState(state);
  const areas = (Array.isArray(workAreas) ? workAreas : []).filter((a) => a && finite(a.width) && finite(a.height));
  const primary = areas[0] || { x: 0, y: 0, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };

  const clampSize = (area) => ({
    width: Math.max(Math.min(s.width, area.width), Math.min(MIN_SIZE.width, area.width)),
    height: Math.max(Math.min(s.height, area.height), Math.min(MIN_SIZE.height, area.height)),
  });

  if (finite(s.x) && finite(s.y)) {
    const titleStrip = { x: s.x, y: s.y, width: s.width, height: TITLE_STRIP };
    for (const area of areas) {
      const o = overlapArea(titleStrip, area);
      if (o && o.w >= MIN_VISIBLE.width && o.h >= MIN_VISIBLE.height) {
        const size = clampSize(area);
        // Nudge back inside the display that holds the title bar.
        const x = Math.min(Math.max(s.x, area.x), area.x + area.width - size.width);
        const y = Math.min(Math.max(s.y, area.y), area.y + area.height - size.height);
        return { ...size, x, y, maximized: s.maximized };
      }
    }
  }
  return { ...clampSize(primary), maximized: s.maximized };
}

/** Read / write the state file. Errors are swallowed: losing the window position is never fatal. */
function createWindowStateFile(file, { fs = fsDefault } = {}) {
  function load() {
    try {
      return sanitizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return sanitizeState(null);
    }
  }

  function save(state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      // Write-then-rename so a crash mid-write cannot leave a truncated file.
      fs.writeFileSync(tmp, JSON.stringify(sanitizeState(state)));
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  return { file, load, save };
}

module.exports = {
  DEFAULT_SIZE,
  MIN_SIZE,
  sanitizeState,
  fitToDisplays,
  createWindowStateFile,
};
