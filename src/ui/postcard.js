// v2.9 Postcards and sharing (see src/presets/postcard.js for the formats).
//
//   openPostcard(ctx, part)     the Postcard dialog: a 1080 x 1080 PNG of the
//                               track's terrain with its sound hidden inside,
//                               a share link, Share..., the social sites,
//                               Copy link and Download image
//   installPostcards(ctx, scope, dropTarget)
//                               share links (#p=...) opened at start or later
//                               ask before loading; postcard images dropped on
//                               the 3D view load their sound
//   offerPostcardFile(ctx, file, onTerrain)
//                               a PNG dropped on a terrain slot: if it is a
//                               postcard, ask whether to load the sound or use
//                               the picture as terrain
//   loadPostcardFile(ctx, file) a PNG opened from the patch browser

import { PART_COLORS } from '../core/params.js';
import { partCount } from '../core/tracks.js';
import { h, downloadBlob, has } from './dom.js';
import { openModal } from './modal.js';
import { icon } from './icons.js';
import { drawTerrain } from './terrain-art.js';
import { pathPoint, makeTransform, applyTransform, terrainHeight } from './dsp-bridge.js';
import { partPatch } from '../presets/presets.js';
import { isPng } from '../audio/png.js';
import {
  embedPatch, readPostcard, linkFor, caption, shareText, shareTargets, SITE_SHORT, decodeLinkData, linkDataFromHash, LinkError,
} from '../presets/postcard.js';
import { found } from '../core/fun.js';
// VERSION comes from settings.js, which loads lazily (2.11).
const appVersion = () => import('./settings.js').then(m => m.VERSION);

export const CARD = 1080;
const MAX_FILE = 25 * 1024 * 1024;
const trackName = (store, i) => store.get(`parts.${i}.name`) || `Track ${i + 1}`;
const selected = (store) => Math.max(0, Math.min(partCount(store) - 1, Math.round(Number(store.get('ui.selectedPart')) || 0)));
const fileSlug = (s) => String(s || 'sound').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sound';

/** Draw the postcard of track `part` into `canvas` (CARD x CARD). */
export function drawPostcard(canvas, { store, terrains, part, name }) {
  canvas.width = canvas.height = CARD;
  const g = canvas.getContext('2d');
  if (!g) return;
  const color = store.get(`parts.${part}.color`) || PART_COLORS[part % PART_COLORS.length];
  const P = store.get(`parts.${part}.params`) || {};
  const bg = g.createLinearGradient(0, 0, CARD, CARD);
  bg.addColorStop(0, '#111a2c');
  bg.addColorStop(1, '#05070d');
  g.fillStyle = bg;
  g.fillRect(0, 0, CARD, CARD);

  // the terrain, as the flat map draws it
  const RES = 300, X = 140, Y = 64, S = 800;
  const tc = document.createElement('canvas');
  tc.width = tc.height = RES;
  const A = terrains && terrains.get(part, 'A'), B = terrains && terrains.get(part, 'B');
  if (A) {
    const data = new Float32Array(RES * RES);
    const morph = Number(P.morph) || 0, warp = Number(P.warp) || 0;
    for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) data[y * RES + x] = terrainHeight(A.data, A.size, B ? B.data : null, B ? B.size : 0, morph, warp, x / RES, y / RES);
    drawTerrain(tc, { size: RES, data }, { color, theme: 'dark', contours: true });
  }
  g.save();
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(X, Y, S, S, 36); else g.rect(X, Y, S, S);
  g.fillStyle = '#1b2438';
  g.fill();
  g.clip();
  g.imageSmoothingEnabled = true;
  if (A) g.drawImage(tc, X, Y, S, S);
  // the path and the dot
  const xf = makeTransform(P.stretch ?? 0, P.size ?? 0.22, P.rotate ?? 0, 0, P.centerX ?? 0.5, P.centerY ?? 0.5);
  const pt = { x: 0, y: 0 }, uv = { u: 0, v: 0 };
  const trace = () => {
    g.beginPath();
    let px = null, py = null;
    for (let i = 0; i <= 320; i++) {
      pathPoint(P.pathShape ?? 0, (i % 320) / 320, P.pathOrder ?? 0, P.pathParam ?? 0.5, pt);
      applyTransform(xf, pt.x, pt.y, uv);
      const x = X + (uv.u - Math.floor(uv.u)) * S, y = Y + (uv.v - Math.floor(uv.v)) * S;
      if (px == null || Math.abs(x - px) > S / 2 || Math.abs(y - py) > S / 2) g.moveTo(x, y); else g.lineTo(x, y);
      px = x; py = y;
    }
  };
  g.lineJoin = 'round';
  trace(); g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 10; g.stroke();
  trace(); g.strokeStyle = 'rgba(255,255,255,0.92)'; g.lineWidth = 4; g.stroke();
  const cx = X + ((Number(P.centerX) || 0.5) % 1) * S, cy = Y + ((Number(P.centerY) || 0.5) % 1) * S;
  g.beginPath(); g.arc(cx, cy, 20, 0, Math.PI * 2);
  g.fillStyle = color; g.fill();
  g.lineWidth = 5; g.strokeStyle = '#ffffff'; g.stroke();
  g.restore();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(X, Y, S, S, 36); else g.rect(X, Y, S, S);
  g.stroke();

  // the words
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#f4f1ea';
  let size = 64;
  let title = String(name || 'Untitled');
  g.font = `700 ${size}px ${font}`;
  while (size > 36 && g.measureText(title).width > CARD - 120) { size -= 4; g.font = `700 ${size}px ${font}`; }
  while (title.length > 1 && g.measureText(title + '...').width > CARD - 120) title = title.slice(0, -1);
  if (title !== String(name || 'Untitled')) title += '...';
  g.fillText(title, CARD / 2, 948);
  g.font = `500 34px ${font}`;
  g.fillStyle = color;
  g.fillText('Made with Oro', CARD / 2, 1000);
  g.font = `400 28px ${font}`;
  g.fillStyle = 'rgba(244,241,234,0.72)';
  g.fillText(SITE_SHORT, CARD / 2, 1044);
}

/** The postcard PNG (with the patch inside) of track `part`: { blob, patch, name }. */
export async function makePostcard(ctx, part) {
  const { store } = ctx;
  const cur = store.get(`parts.${part}`);
  const name = (cur && cur.patchName) || 'Untitled';
  const patch = partPatch(cur, { name });
  const canvas = document.createElement('canvas');
  drawPostcard(canvas, { store, terrains: ctx.terrains, part, name });
  const plain = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The image could not be made'))), 'image/png'));
  const bytes = embedPatch(new Uint8Array(await plain.arrayBuffer()), patch, await appVersion());
  return { blob: new Blob([bytes], { type: 'image/png' }), patch, name };
}

function copyText(text, input) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try { input.select(); document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (err) { reject(err); }
  });
}

/** The Postcard dialog for track `part` (default: the selected track). */
export function openPostcard(ctx, part) {
  const { store } = ctx;
  const p = Number.isInteger(part) ? part : selected(store);
  const status = h('p', { class: 'postcard-status', role: 'status' }, 'Making the postcard...');
  const img = h('img', { class: 'postcard-img', alt: '', width: '540', height: '540' });
  const figure = h('figure', { class: 'postcard-figure' }, img);
  const linkInput = h('input', { class: 'field postcard-link', type: 'text', readonly: '', 'aria-label': 'Share link', value: '' });
  const shareBtn = h('button', { type: 'button', class: 'btn btn--sm btn--primary', html: icon('share') + '<span>Share...</span>', disabled: true });
  const copyBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('copy') + '<span>Copy link</span>', disabled: true });
  const downloadBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('export') + '<span>Download image</span>', disabled: true });
  const sites = h('div', { class: 'postcard-sites', role: 'group', 'aria-label': 'Post on a social site (opens a new tab)' });
  const trimmedNote = h('p', { class: 'postcard-note', hidden: true }, 'This sound uses an imported terrain, which is too large for a link: the link carries the rest of the sound, and the image carries all of it.');
  const content = h('div', { class: 'postcard' },
    figure, status,
    h('label', { class: 'mini-label postcard-label' }, 'Share link', linkInput),
    h('div', { class: 'postcard-actions' }, shareBtn, copyBtn, downloadBtn),
    h('p', { class: 'mini-label postcard-label' }, 'Post on'),
    sites,
    trimmedNote,
    h('p', { class: 'postcard-note' }, 'Instagram posts are made in the Instagram app: download the image (or use Share on a phone) and add the link to your caption or bio.'),
    h('p', { class: 'postcard-note' }, 'Social sites strip hidden data from images, so on those sites the link is what carries the sound. The downloaded image keeps it: drop it on Oro, or open it from the patch browser, to load the sound.'));
  let objectUrl = null;
  const modal = openModal(ctx.layers, ctx.root, {
    title: `Postcard: ${trackName(store, p)}`, content, className: 'modal--postcard',
    onClose: () => { if (objectUrl) URL.revokeObjectURL(objectUrl); },
  });
  const sent = () => found('badge', 'postcard-sent');

  (async () => {
    let card;
    try { card = await makePostcard(ctx, p); } catch (err) {
      console.warn('[ui] postcard failed', err);
      status.textContent = 'The postcard could not be made here. Try again, or save the patch from the patch browser instead.';
      return;
    }
    if (!modal.isOpen()) return;
    const { blob, patch, name } = card;
    objectUrl = URL.createObjectURL(blob);
    img.src = objectUrl;
    img.alt = `Postcard for "${name}": the terrain of ${trackName(store, p)} with its path, the words Made with Oro and ${SITE_SHORT}`;
    let link;
    try { link = await linkFor(patch, await appVersion()); } catch (err) {
      console.warn('[ui] share link failed', err);
      link = null;
    }
    if (!modal.isOpen()) return;
    const url = link ? link.url : '';
    linkInput.value = url;
    trimmedNote.hidden = !(link && link.trimmed);
    status.textContent = url ? `"${name}" is ready to share. Caption: ${caption(name, url)}` : 'The image is ready. A link could not be made in this browser.';
    const file = typeof File === 'function' ? new File([blob], `${fileSlug(name)}-oro-postcard.png`, { type: 'image/png' }) : null;
    const canShare = typeof navigator.share === 'function';
    shareBtn.disabled = !canShare || !url;
    shareBtn.hidden = !canShare;
    copyBtn.disabled = !url;
    downloadBtn.disabled = false;
    shareBtn.addEventListener('click', async () => {
      const text = `${shareText(name)} Open it:`;
      try {
        if (file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text, url });
        else await navigator.share({ text, url });
        sent();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        ctx.toast('Sharing did not work here', { kind: 'error', detail: 'Copy the link or download the image instead.' });
      }
    });
    copyBtn.addEventListener('click', () => {
      copyText(url, linkInput).then(() => { ctx.toast('Link copied', { kind: 'success' }); sent(); })
        .catch(() => { linkInput.select(); ctx.toast('Select the link and copy it', { kind: 'info' }); });
    });
    downloadBtn.addEventListener('click', () => { downloadBlob(blob, `${fileSlug(name)}-oro-postcard.png`); sent(); });
    linkInput.addEventListener('focus', () => linkInput.select());
    if (url) {
      for (const t of shareTargets(url, name)) {
        // In the desktop app the window-open policy sends these to the system browser.
        const a = h('a', { class: 'btn btn--sm postcard-site', href: t.href, target: '_blank', rel: 'noopener noreferrer', dataset: { site: t.id } }, t.label);
        a.addEventListener('click', sent);
        sites.append(a);
      }
    }
  })();
  return modal;
}

// ------------------------------------------------------------------ loading

/** Ask before loading `patch` (a share link or a postcard): pick the track, Load or Cancel. */
export function confirmSharedSound(ctx, patch, { from = 'link', onClose } = {}) {
  const { store, presets } = ctx;
  const name = patch.name || 'Untitled';
  const n = partCount(store);
  const pick = h('select', { class: 'select', 'aria-label': 'Track to load the sound onto' });
  for (let i = 0; i < n; i++) pick.append(h('option', { value: String(i) }, `${i + 1}: ${trackName(store, i)}`));
  pick.value = String(selected(store));
  const q = h('p', { class: 'postcard-question' });
  const setQ = () => { q.textContent = `Load the shared sound "${name}" onto track ${Number(pick.value) + 1}?`; };
  setQ();
  pick.addEventListener('change', setQ);
  const load = h('button', { type: 'button', class: 'btn btn--primary' }, 'Load sound');
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const content = h('div', { class: 'postcard-confirm' }, q,
    h('label', { class: 'mini-label postcard-label' }, 'Track', pick),
    h('p', { class: 'postcard-note' }, 'The sound replaces that track\'s sound. Its pattern and mix stay as they are, and Undo brings the old sound back.'),
    h('div', { class: 'postcard-actions' }, load, cancel));
  let done = false;
  const modal = openModal(ctx.layers, ctx.root, {
    title: from === 'link' ? 'Open a shared sound' : 'Open a postcard', content, initialFocus: load,
    onClose: () => { if (onClose) onClose(done); },
  });
  load.addEventListener('click', () => {
    const p = Number(pick.value);
    const ok = !!presets && has(presets, 'loadPatch') && presets.loadPatch(p, patch);
    done = !!ok;
    modal.close('load');
    if (ok) {
      ctx.toast(`Loaded "${name}" onto ${trackName(store, p)}`, { kind: 'success' });
      found('badge', 'postcard-opened');
    } else ctx.toast('The sound could not be loaded', { kind: 'error' });
  });
  cancel.addEventListener('click', () => modal.close('cancel'));
  return modal;
}

/** The postcard in an image file ({ patch, version }), null when it has none. Throws a readable Error when it is damaged. */
export async function readPostcardFile(file) {
  if (!file || typeof file.slice !== 'function' || !(file.size > 8) || file.size > MAX_FILE) return null;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!isPng(head)) return null;
  return readPostcard(new Uint8Array(await file.arrayBuffer()));
}

/**
 * A PNG dropped or chosen for a terrain slot: if it is a postcard, ask what to
 * do and resolve true (handled); otherwise false so the terrain import goes on.
 */
export async function offerPostcardFile(ctx, file, onTerrain) {
  let rec;
  try { rec = await readPostcardFile(file); } catch { return false; }
  if (!rec) return false;
  const name = rec.patch.name || 'Untitled';
  const loadBtn = h('button', { type: 'button', class: 'btn btn--primary' }, 'Load the sound');
  const terrainBtn = h('button', { type: 'button', class: 'btn' }, 'Use as terrain');
  const cancel = h('button', { type: 'button', class: 'btn btn--ghost' }, 'Cancel');
  const modal = openModal(ctx.layers, ctx.root, {
    title: 'This image is an Oro postcard',
    content: h('div', { class: 'postcard-confirm' },
      h('p', { class: 'postcard-question' }, `It carries the sound "${name}". Load the sound onto a track, or use the picture as terrain?`),
      h('div', { class: 'postcard-actions' }, loadBtn, terrainBtn, cancel)),
    initialFocus: loadBtn,
  });
  loadBtn.addEventListener('click', () => { modal.close('load'); confirmSharedSound(ctx, rec.patch, { from: 'postcard' }); });
  terrainBtn.addEventListener('click', () => { modal.close('terrain'); onTerrain(); });
  cancel.addEventListener('click', () => modal.close('cancel'));
  return true;
}

/** A PNG chosen in the patch browser: its sound goes onto the selected track. Resolves true when it was a postcard. */
export async function loadPostcardFile(ctx, file) {
  let rec;
  try { rec = await readPostcardFile(file); } catch (err) {
    ctx.toast('This postcard could not be opened', { kind: 'error', detail: err.message });
    return true;
  }
  if (!rec) return false;
  const p = selected(ctx.store);
  if (ctx.presets && ctx.presets.loadPatch(p, rec.patch)) {
    ctx.toast(`Loaded "${rec.patch.name}" from the postcard onto ${trackName(ctx.store, p)}`, { kind: 'success' });
    found('badge', 'postcard-opened');
  } else ctx.toast('The sound could not be loaded', { kind: 'error' });
  return true;
}

// ------------------------------------------------------------------ share links

function clearHash() {
  try {
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
  } catch { /* sandboxed */ }
}

/** Share links in the address, postcard drops on the 3D view, and ctx.openPostcard. */
export function installPostcards(ctx, scope, dropTarget) {
  ctx.openPostcard = (part) => openPostcard(ctx, part);
  let busy = false;
  async function check() {
    const data = linkDataFromHash(location.hash);
    if (!data || busy) return;
    busy = true;
    try {
      const rec = await decodeLinkData(data);
      confirmSharedSound(ctx, rec.patch, { from: 'link', onClose: () => { clearHash(); busy = false; } });
    } catch (err) {
      clearHash();
      busy = false;
      ctx.toast('This shared sound could not be opened', {
        kind: 'error', timeout: 9000,
        detail: err instanceof LinkError ? `${err.message}. Ask for the link again, or for the postcard image.` : 'The link may be cut short. Ask for the link again, or for the postcard image.',
      });
    }
  }
  scope.on(window, 'hashchange', check);
  const t = setTimeout(check, 0);
  scope.add(() => clearTimeout(t));
  if (dropTarget) {
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    scope.on(dropTarget, 'dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    scope.on(dropTarget, 'drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (!(await loadPostcardFile(ctx, file))) {
        ctx.toast('Only Oro postcards load here', { kind: 'info', detail: 'To use a picture or a sound file as terrain, drop it on Terrain A or B in the map panel.' });
      }
    });
  }
}
