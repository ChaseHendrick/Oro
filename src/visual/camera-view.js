// Pure validation of device-local saved camera views.
export const CAMERA_VIEWS = Object.freeze(['orbit', 'top', 'low', 'front', 'side', 'diagonal']);
function vector(v) { return Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(x) && Math.abs(x) <= 1000) ? v.slice() : null; }
export function sanitizeCameraView(src) {
  if (!src || typeof src !== 'object') return null;
  const position = vector(src.position), target = vector(src.target), up = vector(src.up || [0, 1, 0]);
  if (!position || !target || !up || Math.hypot(...up) < 1e-6 || Math.hypot(...position.map((x, i) => x - target[i])) < 1e-4) return null;
  return { position, target, up, fov: Number.isFinite(src.fov) ? Math.max(10, Math.min(100, src.fov)) : 38, view: CAMERA_VIEWS.includes(src.view) ? src.view : 'orbit' };
}
export function sanitizeSavedCameraViews(src) {
  if (!Array.isArray(src)) return [];
  const out = [], seen = new Set();
  for (const item of src.slice(0, 24)) {
    const camera = sanitizeCameraView(item), id = typeof item?.id === 'string' ? item.id.slice(0, 80) : '';
    if (!camera || !id || seen.has(id)) continue;
    seen.add(id); out.push({ id, name: String(item.name || 'Saved view').trim().slice(0, 60) || 'Saved view', ...camera });
  }
  return out;
}
